import type { ModelEntry } from "./types.ts";

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function authHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey?.trim()) {
		headers.Authorization = `Bearer ${apiKey.trim()}`;
		headers["x-api-key"] = apiKey.trim();
	}
	return headers;
}

async function tryFetchJson(
	url: string,
	apiKey: string | undefined,
	timeoutMs = 8000,
): Promise<{ ok: boolean; status: number; json?: unknown; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: authHeaders(apiKey),
			signal: controller.signal,
		});
		const text = await res.text();
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		return { ok: res.ok, status: res.status, json, error: res.ok ? undefined : text.slice(0, 200) };
	} catch (err) {
		return {
			ok: false,
			status: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timer);
	}
}

function parseOpenAIModels(json: unknown): Array<{ id: string; name?: string }> {
	if (!json || typeof json !== "object") return [];
	const data = (json as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	const out: Array<{ id: string; name?: string }> = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const id = (item as { id?: unknown }).id;
		if (typeof id !== "string" || !id) continue;
		const name = (item as { name?: unknown }).name;
		out.push({ id, name: typeof name === "string" ? name : undefined });
	}
	return out;
}

/**
 * Build candidate catalog URLs for a relay baseUrl.
 *
 * Relays almost always expose OpenAI-style GET .../v1/models regardless of
 * whether chat goes through openai-completions, anthropic-messages, etc.
 *
 * Examples:
 *   https://relay.example.com/v1     → /v1/models
 *   https://relay.example.com        → /v1/models, /models
 *   https://relay.example.com/v1/    → /v1/models
 */
export function modelCatalogUrls(baseUrl: string): string[] {
	const base = stripTrailingSlash(baseUrl.trim());
	if (!base) return [];

	const urls: string[] = [];
	const push = (u: string) => {
		if (!urls.includes(u)) urls.push(u);
	};

	// If user already pointed at .../v1, prefer .../v1/models first
	if (/\/v1$/i.test(base)) {
		push(`${base}/models`);
	} else {
		push(`${base}/v1/models`);
		push(`${base}/models`);
		// some gateways nest under /api
		push(`${base}/api/v1/models`);
	}

	return urls;
}

/**
 * List models from a relay catalog endpoint (OpenAI-style { data: [{ id }] }).
 * Independent of the chat/completions protocol chosen for the provider.
 */
export async function listOpenAIModels(options: {
	baseUrl: string;
	apiKey?: string;
}): Promise<{
	models: Array<{ id: string; name?: string }>;
	tried: string[];
	matchedUrl?: string;
	error?: string;
}> {
	const tried: string[] = [];
	const urls = modelCatalogUrls(options.baseUrl);

	let lastError: string | undefined;
	for (const url of urls) {
		tried.push(url);
		const res = await tryFetchJson(url, options.apiKey);
		if (!res.ok || res.json === undefined) {
			lastError = res.error ?? `HTTP ${res.status}`;
			continue;
		}
		const models = parseOpenAIModels(res.json);
		if (models.length > 0) {
			return { models, tried, matchedUrl: url };
		}
		lastError = "response had no OpenAI-style data[].id models";
	}
	return { models: [], tried, error: lastError };
}

/** Lightweight connectivity check for /provider test. */
export async function probeEndpoint(options: {
	baseUrl: string;
	apiKey?: string;
}): Promise<{ ok: boolean; status: number; url: string; detail: string }> {
	const listed = await listOpenAIModels(options);
	if (listed.models.length > 0 && listed.matchedUrl) {
		return {
			ok: true,
			status: 200,
			url: listed.matchedUrl,
			detail: `OK — listed ${listed.models.length} model(s)`,
		};
	}

	// Fall back: hit first candidate or bare base for any HTTP response
	const candidates = modelCatalogUrls(options.baseUrl);
	const base = stripTrailingSlash(options.baseUrl.trim());
	const fallbacks = [...candidates, base];
	for (const url of fallbacks) {
		const res = await tryFetchJson(url, options.apiKey);
		if (res.status > 0) {
			return {
				ok: res.status < 500,
				status: res.status,
				url,
				detail: res.ok
					? `HTTP ${res.status} (no model list in body)`
					: `HTTP ${res.status}${res.error ? `: ${res.error}` : ""}`,
			};
		}
	}

	return {
		ok: false,
		status: 0,
		url: candidates[0] ?? base,
		detail: listed.error ?? "unreachable",
	};
}

export function toModelEntries(discovered: Array<{ id: string; name?: string }>): ModelEntry[] {
	return discovered.map((m) => ({
		id: m.id,
		...(m.name && m.name !== m.id ? { name: m.name } : {}),
	}));
}
