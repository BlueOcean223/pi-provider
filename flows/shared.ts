import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	listProviderIds,
	modelsFileHasJsonc,
	readModelsFile,
	upsertProvider,
	writeModelsFile,
} from "../lib/models-json.ts";
import {
	catalogFromRegistry,
	enrichModelEntry,
	formatCtx,
	type OfficialModelMeta,
} from "../lib/official-catalog.ts";
import type { MenuNote, Tone } from "../lib/row-menu.ts";
import { API_OPTIONS, type ModelEntry, type ModelsFile, type ProviderApi, type ProviderConfig } from "../lib/types.ts";

/** Everything a flow needs: the command context plus the extension API (for setModel). */
export interface Env {
	ctx: ExtensionCommandContext;
	pi: ExtensionAPI;
}

/**
 * What a flow reports when it returns. Screens show it as a note on the next
 * render; a flow started directly from a subcommand turns it into one notify.
 */
export interface Notice {
	text: string;
	tone: Extract<Tone, "success" | "warning" | "error" | "muted">;
}

export const JSONC_NOTE: MenuNote = {
	text: "⚠ models.json has // comments or trailing commas — saving from here removes them",
	tone: "warning",
};

export function jsoncNotes(): MenuNote[] {
	return modelsFileHasJsonc() ? [JSONC_NOTE] : [];
}

export function noticeNote(notice: Notice | undefined): MenuNote[] {
	if (!notice) return [];
	const icon = notice.tone === "success" ? "✓ " : notice.tone === "error" ? "✗ " : notice.tone === "warning" ? "⚠ " : "";
	return [{ text: `${icon}${notice.text}`, tone: notice.tone }];
}

/** Report a flow's final notice when it ran straight from a subcommand. */
export function report(env: Env, notice: Notice | undefined): void {
	if (!notice) return;
	env.ctx.ui.notify(notice.text, notice.tone === "error" ? "error" : notice.tone === "warning" ? "warning" : "info");
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* Provider config helpers                                             */
/* ------------------------------------------------------------------ */

export const SUBCOMMANDS = ["add", "local", "models", "proxy", "list", "test", "remove", "path"] as const;
export const SUBCOMMAND_ALIASES: Record<string, string> = {
	"add-models": "models",
	probe: "test",
	rm: "remove",
	edit: "path",
};

/**
 * `/provider <id>` opens a provider, so an id equal to a subcommand could only
 * be reached from the list. New providers don't get such ids.
 */
export function isReservedProviderId(id: string): boolean {
	return (SUBCOMMANDS as readonly string[]).includes(id) || id in SUBCOMMAND_ALIASES;
}

export function isProviderApi(value: unknown): value is ProviderApi {
	return typeof value === "string" && API_OPTIONS.includes(value as ProviderApi);
}

/** Provider-level api, or the single api every model entry agrees on. */
export function inferProviderApi(cfg: ProviderConfig): ProviderApi | undefined {
	if (isProviderApi(cfg.api)) return cfg.api;
	const modelApis = new Set(
		(cfg.models ?? []).map((model) => model.api).filter((api): api is ProviderApi => isProviderApi(api)),
	);
	if (modelApis.size !== 1) return undefined;
	const first = modelApis.values().next();
	return first.done ? undefined : first.value;
}

/** A baseUrl-only override of a built-in provider (no protocol, no custom models). */
export function isProxyOverride(cfg: ProviderConfig): boolean {
	return !cfg.api && !cfg.models?.length;
}

export function canAddModels(cfg: ProviderConfig): boolean {
	return Boolean(cfg.baseUrl && inferProviderApi(cfg));
}

export function canManageModels(cfg: ProviderConfig): boolean {
	return Boolean(cfg.models?.length || canAddModels(cfg));
}

export function uniqueModelIds(models: ModelEntry[] | undefined): string[] {
	return Array.from(new Set((models ?? []).map((model) => model.id)));
}

/** Case-insensitive lookup of a provider id typed on the command line. */
export function findProviderId(data: ModelsFile, typed: string): string | undefined {
	if (data.providers?.[typed]) return typed;
	const lower = typed.toLowerCase();
	return listProviderIds(data).find((id) => id.toLowerCase() === lower);
}

export function shortUrl(url: string | undefined): string {
	return (url ?? "").replace(/^https?:\/\//i, "");
}

/** `$NAME` / `${NAME}` → the variable name, else undefined. */
export function envVarName(value: string | undefined): string | undefined {
	const match = value?.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	return match?.[1];
}

/** Resolve a models.json config value the way pi does, minus `!command` (never run here). */
export function resolveConfigValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("!")) return undefined;
	const name = envVarName(value);
	if (name) return process.env[name];
	return value;
}

export function maskSecret(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 10) return "••••";
	return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

/** One-line description of an apiKey config value, never showing a literal key. */
export function describeKey(apiKey: string | undefined): string {
	if (!apiKey) return "none — uses /login or environment";
	const name = envVarName(apiKey);
	if (name) return `$${name} ${process.env[name] ? "(set)" : "(not set in this shell)"}`;
	if (apiKey.startsWith("!")) {
		const command = apiKey.slice(1).trim();
		return `command: ${command.length > 40 ? `${command.slice(0, 39)}…` : command}`;
	}
	return `stored in models.json · ${maskSecret(apiKey)}`;
}

export function formatCompat(compat: Record<string, unknown> | undefined): string | undefined {
	const entries = Object.entries(compat ?? {});
	if (entries.length === 0) return undefined;
	return entries.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(", ");
}

/* ------------------------------------------------------------------ */
/* Auth + registry                                                     */
/* ------------------------------------------------------------------ */

export interface ResolvedAuth {
	apiKey?: string;
	headers?: Record<string, string | null>;
	/** Why the saved auth could not be resolved (shown as a panel note). */
	warning?: string;
}

function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const resolved = resolveConfigValue(value);
		if (resolved !== undefined) out[name] = resolved;
	}
	return out;
}

type RegistryLike = Partial<ExtensionCommandContext["modelRegistry"]>;

/**
 * Credentials and headers exactly as pi would send them: the registry
 * resolves auth.json (/login), models.json apiKey, env vars and provider
 * headers. Falls back to the raw config when the registry doesn't know the
 * provider yet.
 */
export async function resolveProviderAuth(
	ctx: ExtensionCommandContext,
	providerId: string,
	cfg: ProviderConfig,
): Promise<ResolvedAuth> {
	const fallback: ResolvedAuth = { apiKey: resolveConfigValue(cfg.apiKey), headers: resolveHeaders(cfg.headers) };
	const registry = ctx.modelRegistry as RegistryLike;
	try {
		const model = registry.getAll?.().find((candidate) => candidate.provider === providerId);
		if (model && registry.getApiKeyAndHeaders) {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (auth.ok) {
				return { apiKey: auth.apiKey ?? fallback.apiKey, headers: auth.headers ?? fallback.headers };
			}
			return { ...fallback, warning: auth.error };
		}
		if (registry.getProviderAuth) {
			const resolved = await registry.getProviderAuth(providerId);
			return {
				apiKey: resolved?.auth.apiKey ?? fallback.apiKey,
				headers: resolved?.auth.headers ?? fallback.headers,
			};
		}
	} catch (err) {
		return { ...fallback, warning: `Could not resolve saved auth for ${providerId}: ${errorText(err)}` };
	}
	return fallback;
}

/**
 * A credential that outranks the apiKey in models.json. pi resolves keys in
 * this order: --api-key, auth.json (/login), models.json apiKey, environment
 * variables — so with either of the first two, the models.json key is never sent.
 */
export function overridingCredential(
	ctx: ExtensionCommandContext,
	providerId: string,
): { label: string; remedy: string } | undefined {
	const registry = ctx.modelRegistry as RegistryLike;
	try {
		const source = registry.getProviderAuthStatus?.(providerId)?.source;
		if (source === "stored") return { label: "your /login credential (auth.json)", remedy: "remove it with /logout" };
		if (source === "runtime") return { label: "the --api-key from the command line", remedy: "restart pi without --api-key" };
	} catch {
		// Unknown provider or an older pi: nothing outranks models.json then.
	}
	return undefined;
}

/**
 * Warn when the credential sent to `baseUrl` isn't the models.json key: a key
 * set there is ignored, and without one the /login credential goes to the relay.
 */
export function credentialNote(
	ctx: ExtensionCommandContext,
	providerId: string,
	apiKey: string | undefined,
	baseUrl: string | undefined,
): MenuNote | undefined {
	if (!baseUrl) return undefined;
	const credential = overridingCredential(ctx, providerId);
	if (!credential) return undefined;
	const host = shortUrl(baseUrl);
	return apiKey
		? {
				text: `⚠ pi sends ${credential.label} to ${host}, not the API key set here — ${credential.remedy} to use this key`,
				tone: "error",
			}
		: {
				text: `⚠ ${host} receives ${credential.label}. If the relay issues its own keys, ${credential.remedy} and set its key here`,
				tone: "warning",
			};
}

/**
 * Provider ids pi has without models.json: built-ins and extension providers.
 * A models.json entry under one of these ids doesn't create a new provider —
 * pi merges it into the existing one, and its baseUrl redirects that
 * provider's own models too. Recognized by registry models that don't come
 * from models.json.
 */
export function builtinProviderIds(ctx: ExtensionCommandContext, data: ModelsFile): Set<string> {
	const ids = new Set<string>();
	const registry = ctx.modelRegistry as RegistryLike;
	try {
		for (const model of registry.getAll?.() ?? []) {
			if (ids.has(model.provider)) continue;
			if (data.providers?.[model.provider]?.models?.some((entry) => entry.id === model.id)) continue;
			ids.add(model.provider);
		}
	} catch {
		// Registry unavailable: only models.json ids count as taken.
	}
	return ids;
}

/**
 * Reload models.json into pi's registry (no network) so /model, find() and
 * setModel() see the change. Returns a warning when this provider failed to load.
 */
export async function refreshRegistry(ctx: ExtensionCommandContext, providerId?: string): Promise<string | undefined> {
	const registry = ctx.modelRegistry as RegistryLike;
	if (typeof registry.refresh !== "function") return undefined;
	try {
		// Since pi 0.84, refresh() reports per-provider failures in its result
		// instead of throwing. Only this provider's failure is relevant here.
		const result = await registry.refresh({ allowNetwork: false });
		const error = providerId ? result?.errors?.get(providerId) : undefined;
		return error ? `pi could not load ${providerId}: ${error.message}` : undefined;
	} catch (err) {
		return `Could not reload the model registry: ${errorText(err)}`;
	}
}

/** Models pi already knows for a provider (custom entries plus inherited built-ins). */
export function modelsKnownToProvider(
	ctx: ExtensionCommandContext,
	providerId: string,
	cfg: ProviderConfig,
): ModelEntry[] {
	const known = [...(cfg.models ?? [])];
	const ids = new Set(known.map((model) => model.id));
	const registry = ctx.modelRegistry as RegistryLike;
	for (const model of registry.getAll?.() ?? []) {
		if (model.provider !== providerId || ids.has(model.id)) continue;
		ids.add(model.id);
		known.push({ id: model.id });
	}
	return known;
}

/* ------------------------------------------------------------------ */
/* Official catalog enrichment                                         */
/* ------------------------------------------------------------------ */

/**
 * pi's official catalog, minus every provider that has custom models in
 * models.json, so a relay's copied metadata can't match against itself.
 * baseUrl-only proxy overrides keep the official models and stay in.
 */
export function officialCatalog(ctx: ExtensionCommandContext, data: ModelsFile): OfficialModelMeta[] {
	const relayProviderIds = Object.entries(data.providers ?? {})
		.filter(([, cfg]) => cfg.models?.length)
		.map(([id]) => id);
	try {
		return catalogFromRegistry(ctx, relayProviderIds);
	} catch {
		return [];
	}
}

export interface EnrichedModels {
	entries: ModelEntry[];
	matched: number;
}

export function enrichModels(
	catalog: OfficialModelMeta[],
	ids: Array<{ id: string; name?: string }>,
	api: ProviderApi | undefined,
): EnrichedModels {
	let matched = 0;
	const entries = ids.map((model) => {
		const result = enrichModelEntry(catalog, model.id, api, model.name);
		if (result.status === "matched") matched++;
		return result.entry;
	});
	return { entries, matched };
}

/** `200k · think` — compact metadata for a checklist row. */
export function modelMeta(entry: ModelEntry): string {
	const think = entry.thinkingLevelMap ? "think" : entry.reasoning ? "reasoning" : undefined;
	return [`${formatCtx(entry.contextWindow)} ctx`, think].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Apply a change to one provider on the latest file contents, write, and
 * reload the registry. Re-reading right before the write keeps edits made to
 * other providers while a dialog was open.
 */
export async function updateProvider(
	env: Env,
	providerId: string,
	change: (cfg: ProviderConfig) => ProviderConfig,
	success: string,
): Promise<Notice> {
	const fresh = readModelsFile();
	const cfg = fresh.providers?.[providerId];
	if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
	writeModelsFile(upsertProvider(fresh, providerId, change(cfg)));
	const warning = await refreshRegistry(env.ctx, providerId);
	return warning ? { text: `${success} — ${warning}`, tone: "warning" } : { text: success, tone: "success" };
}

/** Summarize a list of ids as `- a`, `- b`, … capped for the confirm screen. */
export function idLines(prefix: string, ids: string[], max = 12): MenuNote[] {
	const lines = ids.slice(0, max).map((id) => ({ text: `${prefix} ${id}`, tone: "muted" as const }));
	if (ids.length > max) lines.push({ text: `  …and ${ids.length - max} more`, tone: "muted" });
	return lines;
}
