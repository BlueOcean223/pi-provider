import type { ModelEntry, ProviderApi } from "./types.ts";

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

/** Timeout signal, optionally combined with an external abort (Esc in the UI). */
function requestSignal(timeoutMs: number, signal?: AbortSignal): { combined: AbortSignal; timeout: AbortSignal } {
	const timeout = AbortSignal.timeout(timeoutMs);
	// AbortSignal.any needs Node 20.3+ / recent Bun; on older runtimes fall
	// back to timeout-only (Esc then just stops caring about the result).
	const combined =
		signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
	return { combined, timeout };
}

async function tryFetchJson(
	url: string,
	apiKey: string | undefined,
	timeoutMs = 8000,
	signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json?: unknown; error?: string }> {
	const { combined, timeout } = requestSignal(timeoutMs, signal);
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: authHeaders(apiKey),
			signal: combined,
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
			error: timeout.aborted
				? `timeout after ${Math.round(timeoutMs / 1000)}s`
				: err instanceof Error
					? err.message
					: String(err),
		};
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
	signal?: AbortSignal;
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
		if (options.signal?.aborted) break;
		tried.push(url);
		const res = await tryFetchJson(url, options.apiKey, undefined, options.signal);
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
	signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; url: string; detail: string }> {
	const listed = await listOpenAIModels(options);
	if (listed.models.length > 0 && listed.matchedUrl) {
		return {
			ok: true,
			status: 200,
			url: listed.matchedUrl,
			detail: `listed ${listed.models.length} model(s)`,
		};
	}

	// Fall back: hit first candidate or bare base for any HTTP response
	const candidates = modelCatalogUrls(options.baseUrl);
	const base = stripTrailingSlash(options.baseUrl.trim());
	const fallbacks = [...candidates, base];
	for (const url of fallbacks) {
		if (options.signal?.aborted) break;
		const res = await tryFetchJson(url, options.apiKey, undefined, options.signal);
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

async function tryPostJson(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	timeoutMs = 20000,
	signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json?: unknown; error?: string }> {
	const { combined, timeout } = requestSignal(timeoutMs, signal);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: combined,
		});
		const text = await res.text();
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		return { ok: res.ok, status: res.status, json, error: res.ok ? undefined : text.slice(0, 300) };
	} catch (err) {
		return {
			ok: false,
			status: 0,
			error: timeout.aborted
				? `timeout after ${Math.round(timeoutMs / 1000)}s`
				: err instanceof Error
					? err.message
					: String(err),
		};
	}
}

function chatUrls(baseUrl: string, api: ProviderApi, model: string): string[] {
	const base = stripTrailingSlash(baseUrl.trim());
	const hasV1 = /\/v1$/i.test(base);
	switch (api) {
		case "openai-completions":
			// pi's openai SDK appends /chat/completions to baseUrl as-is
			return hasV1
				? [`${base}/chat/completions`]
				: [`${base}/chat/completions`, `${base}/v1/chat/completions`];
		case "openai-responses":
			return hasV1 ? [`${base}/responses`] : [`${base}/responses`, `${base}/v1/responses`];
		case "anthropic-messages":
			// anthropic SDK appends /v1/messages to baseUrl
			return hasV1 ? [`${base}/messages`] : [`${base}/v1/messages`, `${base}/messages`];
		case "google-generative-ai": {
			const path = `models/${encodeURIComponent(model)}:generateContent`;
			return /\/v1(beta)?$/i.test(base) ? [`${base}/${path}`] : [`${base}/v1beta/${path}`];
		}
	}
}

function chatBody(api: ProviderApi, model: string, tokenField: "max_tokens" | "max_completion_tokens" = "max_tokens"): unknown {
	// OpenAI rejects output budgets below 16 tokens; anthropic/google accept 1.
	switch (api) {
		case "openai-completions":
			return {
				model,
				messages: [{ role: "user", content: "hi" }],
				[tokenField]: 16,
				stream: false,
			};
		case "openai-responses":
			return { model, input: "hi", max_output_tokens: 16 };
		case "anthropic-messages":
			return { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
		case "google-generative-ai":
			return {
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
				generationConfig: { maxOutputTokens: 1 },
			};
	}
}

/** Best-effort check that the JSON looks like a real chat reply for the protocol. */
function looksLikeChatReply(api: ProviderApi, json: unknown): boolean {
	if (!json || typeof json !== "object") return false;
	const j = json as Record<string, unknown>;
	switch (api) {
		case "openai-completions":
			return Array.isArray(j.choices);
		case "openai-responses":
			return Array.isArray(j.output) || j.object === "response";
		case "anthropic-messages":
			return j.type === "message" || Array.isArray(j.content);
		case "google-generative-ai":
			return Array.isArray(j.candidates);
	}
}

/**
 * Minimal real chat request ("hi", smallest output budget the protocol allows)
 * using the provider's configured protocol — the same way relay panels
 * (one-api / new-api) test channels. GET /v1/models can 200 while chat is
 * broken (quota, disabled model, wrong protocol), so this is the
 * authoritative test.
 */
export async function chatPing(options: {
	baseUrl: string;
	api: ProviderApi;
	model: string;
	apiKey?: string;
	signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; url: string; detail: string }> {
	const { api, model } = options;
	// Google auth is x-goog-api-key only — strict gateways 401 on an
	// unexpected Authorization: Bearer header, so don't send both.
	const headers: Record<string, string> =
		api === "google-generative-ai"
			? options.apiKey?.trim()
				? { "x-goog-api-key": options.apiKey.trim() }
				: {}
			: authHeaders(options.apiKey);
	if (api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";

	const urls = chatUrls(options.baseUrl, api, model);
	let last: { status: number; url: string; detail: string } | undefined;

	for (const url of urls) {
		if (options.signal?.aborted) break;
		let res = await tryPostJson(url, chatBody(api, model), headers, undefined, options.signal);

		// Some strict OpenAI-compat servers want max_completion_tokens instead
		if (
			api === "openai-completions" &&
			!res.ok &&
			res.status === 400 &&
			/max_tokens/i.test(res.error ?? "")
		) {
			res = await tryPostJson(url, chatBody(api, model, "max_completion_tokens"), headers, undefined, options.signal);
		}

		if (res.ok && looksLikeChatReply(api, res.json)) {
			return { ok: true, status: res.status, url, detail: `chat OK — "${model}" replied` };
		}
		if (res.ok) {
			return {
				ok: false,
				status: res.status,
				url,
				detail: `HTTP ${res.status} but response doesn't look like a ${api} reply`,
			};
		}
		last = {
			status: res.status,
			url,
			detail: res.status === 0 ? (res.error ?? "unreachable") : `HTTP ${res.status}${res.error ? `: ${res.error}` : ""}`,
		};
		// Only fall through to the next candidate URL on 404/405 (wrong path)
		if (res.status !== 404 && res.status !== 405) break;
	}

	return { ok: false, status: last?.status ?? 0, url: last?.url ?? urls[0]!, detail: last?.detail ?? "unreachable" };
}

export function toModelEntries(discovered: Array<{ id: string; name?: string }>): ModelEntry[] {
	return discovered.map((m) => ({
		id: m.id,
		...(m.name && m.name !== m.id ? { name: m.name } : {}),
	}));
}
