/**
 * pi-provider
 *
 * Interactive /provider command to manage custom providers in ~/.pi/agent/models.json
 * (relays / 中转站 / local OpenAI-compatible servers).
 *
 * Usage in pi:  /provider
 *               /provider add
 *               /provider list
 *               /provider remove
 *               /provider proxy
 *               /provider test
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkboxSelect } from "./lib/checkbox-select.ts";
import { listOpenAIModels, probeEndpoint } from "./lib/detect-api.ts";
import {
	getModelsPath,
	listProviderIds,
	modelsFileHasJsonc,
	readModelsFile,
	readModelsFileRaw,
	removeProvider,
	sanitizeProviderId,
	summarizeProvider,
	upsertProvider,
	validateModelsText,
	writeModelsFile,
	writeModelsFileRaw,
} from "./lib/models-json.ts";
import {
	catalogFromRegistry,
	enrichModelEntry,
	formatCtx,
	type OfficialModelMeta,
} from "./lib/official-catalog.ts";
import {
	API_LABELS,
	API_OPTIONS,
	BUILTIN_PROXY_TARGETS,
	type ModelEntry,
	type ProviderApi,
	type ProviderConfig,
} from "./lib/types.ts";

type Ui = ExtensionCommandContext["ui"];

const LABEL_TO_API: Record<string, ProviderApi> = Object.fromEntries(
	API_OPTIONS.map((k) => [API_LABELS[k], k]),
) as Record<string, ProviderApi>;

async function pickApi(ui: Ui): Promise<ProviderApi | undefined> {
	const labels = API_OPTIONS.map((k) => API_LABELS[k]);
	const picked = await ui.select("API protocol", labels);
	if (!picked) return undefined;
	return LABEL_TO_API[picked];
}

async function pickApiKey(ui: Ui): Promise<string | undefined | null> {
	// null = cancelled, undefined = omit key
	const mode = await ui.select("API key", [
		"Store literal key in models.json",
		"Reference environment variable ($VAR)",
		"Skip for now (use /login or --api-key later)",
	]);
	if (!mode) return null;

	if (mode.startsWith("Skip")) return undefined;

	if (mode.startsWith("Reference")) {
		const name = await ui.input("Environment variable name", "MY_RELAY_API_KEY");
		if (!name) return null;
		const cleaned = name.trim().replace(/^\$/, "");
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
			ui.notify("Invalid env var name", "error");
			return null;
		}
		return `$${cleaned}`;
	}

	const key = await ui.input("API key (saved to models.json with 0600 perms)", "sk-...");
	if (key === undefined) return null;
	const trimmed = key.trim();
	if (!trimmed) {
		ui.notify("Empty key; skipping", "warning");
		return undefined;
	}
	return trimmed;
}

function parseModelIds(raw: string): string[] {
	return raw
		.split(/[\n,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function resolveProbeKey(apiKey?: string): string | undefined {
	if (!apiKey) return undefined;
	if (apiKey.startsWith("!")) return undefined;
	if (apiKey.startsWith("$")) {
		const envName = apiKey.slice(1).replace(/^{/, "").replace(/}$/, "");
		return process.env[envName];
	}
	return apiKey;
}

/** Enrich selected relay model ids with official pi catalog metadata. */
function buildEnrichedModels(
	catalog: OfficialModelMeta[],
	ids: Array<{ id: string; name?: string }>,
	api: ProviderApi,
	ui: Ui,
): ModelEntry[] {
	if (catalog.length === 0) {
		ui.notify("pi model catalog unavailable — using defaults (128k)", "warning");
	} else {
		ui.notify(`Using pi model catalog (${catalog.length} models)`, "info");
	}

	let matched = 0;
	const entries: ModelEntry[] = [];
	for (const m of ids) {
		const r = enrichModelEntry(catalog, m.id, api, m.name);
		if (r.status === "matched") matched++;
		entries.push(r.entry);
	}

	ui.notify(
		`Metadata: ${matched}/${ids.length} matched official · ${ids.length - matched} defaults`,
		matched === ids.length ? "info" : "warning",
	);
	return entries;
}

async function pickModelsFromList(
	ctx: ExtensionCommandContext,
	catalog: OfficialModelMeta[],
	listed: Array<{ id: string; name?: string }>,
	api: ProviderApi,
): Promise<ModelEntry[] | null> {
	const { ui } = ctx;
	// Pre-enrich for display descriptions (ctx / thinking / match)
	const checkboxItems = listed.map((m) => {
		const r = enrichModelEntry(catalog, m.id, api, m.name);
		const e = r.entry;
		const ctx = formatCtx(e.contextWindow);
		const think = e.thinkingLevelMap
			? "think"
			: e.reasoning
				? "reasoning"
				: "—";
		const badge = r.status === "matched" ? "matched" : "default";
		return {
			id: m.id,
			label: m.id,
			description: `${badge} · ${ctx} ctx · ${think}${r.matched ? ` · ${r.matched}` : ""}`,
			checked: false,
		};
	});

	const selectedIds = await checkboxSelect(
		ctx,
		`Select models to add (${listed.length} from relay)`,
		checkboxItems,
	);
	if (selectedIds === undefined) return null;
	if (selectedIds.length === 0) {
		ui.notify("No models selected", "warning");
		return null;
	}

	const selected = selectedIds.map((id) => {
		const found = listed.find((m) => m.id === id);
		return { id, name: found?.name };
	});
	return buildEnrichedModels(catalog, selected, api, ui);
}

async function collectModels(
	ctx: ExtensionCommandContext,
	catalog: OfficialModelMeta[],
	opts: {
		api: ProviderApi;
		baseUrl: string;
		apiKey?: string;
	},
): Promise<ModelEntry[] | null> {
	const { ui } = ctx;
	// Relay model catalogs are almost always OpenAI-style GET .../v1/models,
	// independent of chat protocol (completions / anthropic / responses / google).
	const choices = [
		"Fetch from GET /v1/models then multi-select",
		"Enter model ids manually",
		"Minimal placeholder (edit models.json later)",
	];

	const mode = await ui.select("Models", choices);
	if (!mode) return null;

	if (mode.startsWith("Fetch")) {
		ui.notify("Fetching model catalog…", "info");
		const listed = await listOpenAIModels({
			baseUrl: opts.baseUrl,
			apiKey: resolveProbeKey(opts.apiKey),
		});
		if (listed.models.length === 0) {
			ui.notify(
				`No models listed (${listed.error ?? "empty"}). Tried: ${listed.tried.join(", ")}. Fall back to manual entry.`,
				"warning",
			);
			const raw = await ui.editor(
				"Model ids (one per line or comma-separated)",
				"gpt-4o",
			);
			if (raw === undefined) return null;
			const ids = parseModelIds(raw);
			if (ids.length === 0) {
				ui.notify("No model ids entered", "error");
				return null;
			}
			return buildEnrichedModels(
				catalog,
				ids.map((id) => ({ id })),
				opts.api,
				ui,
			);
		}

		ui.notify(
			`Fetched ${listed.models.length} models${listed.matchedUrl ? ` from ${listed.matchedUrl}` : ""}`,
			"info",
		);
		return pickModelsFromList(ctx, catalog, listed.models, opts.api);
	}

	if (mode.startsWith("Minimal")) {
		return buildEnrichedModels(catalog, [{ id: "default-model" }], opts.api, ui);
	}

	const raw = await ui.editor(
		"Model ids (one per line or comma-separated)",
		"gpt-4o\nclaude-sonnet-4",
	);
	if (raw === undefined) return null;
	const ids = parseModelIds(raw);
	if (ids.length === 0) {
		ui.notify("No model ids entered", "error");
		return null;
	}

	// If many ids, still offer multi-select after enrich preview
	if (ids.length > 1) {
		return pickModelsFromList(
			ctx,
			catalog,
			ids.map((id) => ({ id })),
			opts.api,
		);
	}
	return buildEnrichedModels(
		catalog,
		ids.map((id) => ({ id })),
		opts.api,
		ui,
	);
}

async function maybeCompatPreset(
	ui: Ui,
	api: ProviderApi,
): Promise<Record<string, unknown> | undefined> {
	if (api !== "openai-completions" && api !== "openai-responses") return undefined;

	const choice = await ui.select("OpenAI compatibility preset", [
		"None (defaults)",
		"Local / strict OpenAI-compat (no developer role, no reasoning_effort)",
		"Chinese relay safe defaults (no developer role)",
	]);
	if (!choice || choice.startsWith("None")) return undefined;

	if (choice.startsWith("Local")) {
		return {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}
	return {
		supportsDeveloperRole: false,
	};
}

async function cmdAdd(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;

	const rawId = await ui.input("Provider id (e.g. my-relay)", "my-relay");
	if (!rawId) return;
	const id = sanitizeProviderId(rawId);
	if (!id) {
		ui.notify("Invalid provider id", "error");
		return;
	}

	const data = readModelsFile();
	if (data.providers?.[id]) {
		const ok = await ui.confirm("Exists", `Provider "${id}" already exists. Overwrite?`);
		if (!ok) return;
	}

	const baseUrlRaw = await ui.input("Base URL", "https://api.example.com/v1");
	if (!baseUrlRaw?.trim()) {
		ui.notify("baseUrl is required", "error");
		return;
	}
	const baseUrl = baseUrlRaw.trim().replace(/\/+$/, "");

	const api = await pickApi(ui);
	if (!api) return;

	const apiKeyResult = await pickApiKey(ui);
	if (apiKeyResult === null) return;

	// Exclude relay providers already defined in models.json so their copied
	// metadata can't match against itself; baseUrl-only proxy overrides keep
	// the official builtin models and stay in the catalog.
	const relayProviderIds = Object.entries(data.providers ?? {})
		.filter(([, cfg]) => cfg.models?.length)
		.map(([pid]) => pid);
	const catalog = catalogFromRegistry(ctx, relayProviderIds);

	const models = await collectModels(ctx, catalog, {
		api,
		baseUrl,
		apiKey: apiKeyResult,
	});
	if (!models) return;

	const compat = await maybeCompatPreset(ui, api);

	const displayName = await ui.input("Display name (optional)", id);
	if (displayName === undefined) return;

	const config: ProviderConfig = {
		...(displayName.trim() && displayName.trim() !== id
			? { name: displayName.trim() }
			: {}),
		baseUrl,
		api,
		...(apiKeyResult ? { apiKey: apiKeyResult } : {}),
		...(compat ? { compat } : {}),
		models,
	};

	const preview = JSON.stringify({ [id]: config }, null, 2);
	const jsoncNote = modelsFileHasJsonc()
		? "\n\nNote: // comments and trailing commas in models.json will be removed on save."
		: "";
	const ok = await ui.confirm(
		"Write models.json?",
		`Will upsert provider "${id}" into ${getModelsPath()}${jsoncNote}\n\n${preview.slice(0, 1200)}${
			preview.length > 1200 ? "\n…" : ""
		}`,
	);
	if (!ok) {
		ui.notify("Cancelled", "info");
		return;
	}

	writeModelsFile(upsertProvider(data, id, config));
	ui.notify(`Saved ${id}. Open /model to select, or /provider test to probe.`, "info");
}

async function cmdProxy(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;

	const custom = "Other (type id)…";
	const options = [...BUILTIN_PROXY_TARGETS, custom];
	const picked = await ui.select("Built-in provider to route via baseUrl", [...options]);
	if (!picked) return;

	let id = picked;
	if (picked === custom) {
		const typed = await ui.input("Provider id", "anthropic");
		if (!typed) return;
		id = sanitizeProviderId(typed);
		if (!id) {
			ui.notify("Invalid provider id", "error");
			return;
		}
	}

	const baseUrlRaw = await ui.input(
		`Proxy baseUrl for ${id}`,
		"https://your-relay.example.com",
	);
	if (!baseUrlRaw?.trim()) {
		ui.notify("baseUrl is required", "error");
		return;
	}
	const baseUrl = baseUrlRaw.trim().replace(/\/+$/, "");

	const alsoKey = await ui.select("Also set apiKey?", [
		"No — keep existing /login or env auth",
		"Yes — store key / env ref",
	]);
	if (!alsoKey) return;

	let apiKey: string | undefined;
	if (alsoKey.startsWith("Yes")) {
		const k = await pickApiKey(ui);
		if (k === null) return;
		apiKey = k;
	}

	const data = readModelsFile();
	const existing = data.providers?.[id] ?? {};
	const config: ProviderConfig = {
		...existing,
		baseUrl,
		...(apiKey !== undefined ? { apiKey } : {}),
	};
	if (existing.models?.length) {
		const keep = await ui.confirm(
			"Existing models",
			`"${id}" already has ${existing.models.length} custom model(s). Keep them?`,
		);
		if (!keep) {
			delete config.models;
		}
	}

	const ok = await ui.confirm(
		"Write models.json?",
		`Route ${id} → ${baseUrl}\n(File: ${getModelsPath()})${
			modelsFileHasJsonc()
				? "\n\nNote: // comments and trailing commas in models.json will be removed on save."
				: ""
		}`,
	);
	if (!ok) return;

	writeModelsFile(upsertProvider(data, id, config));
	ui.notify(`Proxy override saved for ${id}. Open /model to use.`, "info");
}

async function cmdList(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const data = readModelsFile();
	const ids = listProviderIds(data);
	if (ids.length === 0) {
		ui.notify(`No custom providers in ${getModelsPath()}`, "info");
		return;
	}

	const lines = ids.map((id) => summarizeProvider(id, data.providers![id]!));
	const picked = await ui.select(
		`Custom providers (${ids.length}) — select to view JSON`,
		lines,
	);
	if (!picked) return;
	const id = ids[lines.indexOf(picked)];
	if (!id) return;
	const json = JSON.stringify(data.providers![id], null, 2);
	await ui.editor(`Provider: ${id} (read-only view; edit via /provider add)`, json);
}

async function cmdRemove(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const data = readModelsFile();
	const ids = listProviderIds(data);
	if (ids.length === 0) {
		ui.notify("No custom providers to remove", "info");
		return;
	}
	const lines = ids.map((id) => summarizeProvider(id, data.providers![id]!));
	const picked = await ui.select("Remove provider", lines);
	if (!picked) return;
	const id = ids[lines.indexOf(picked)];
	if (!id) return;

	const ok = await ui.confirm("Confirm remove", `Delete provider "${id}" from models.json?`);
	if (!ok) return;

	writeModelsFile(removeProvider(data, id));
	ui.notify(`Removed ${id}`, "info");
}

async function cmdTest(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const data = readModelsFile();
	const ids = listProviderIds(data);
	if (ids.length === 0) {
		ui.notify("No custom providers. Add one first.", "info");
		return;
	}

	const lines = ids.map((id) => summarizeProvider(id, data.providers![id]!));
	const picked = await ui.select("Test provider", lines);
	if (!picked) return;
	const id = ids[lines.indexOf(picked)];
	if (!id) return;
	const cfg = data.providers![id]!;

	if (!cfg.baseUrl) {
		ui.notify(`${id} has no baseUrl`, "error");
		return;
	}

	const probeKey = resolveProbeKey(cfg.apiKey);
	if (cfg.apiKey?.startsWith("$") && !probeKey) {
		ui.notify(`Env ${cfg.apiKey.slice(1)} not set; probing without key`, "warning");
	} else if (cfg.apiKey?.startsWith("!")) {
		ui.notify("apiKey is a !command (not run here); probing without key", "warning");
	}

	ui.notify(`Probing ${cfg.baseUrl}…`, "info");
	const result = await probeEndpoint({
		baseUrl: cfg.baseUrl,
		apiKey: probeKey,
	});

	const msg = [
		`Provider: ${id}`,
		`Configured api: ${cfg.api ?? "(none)"}`,
		`Probe: ${result.detail}`,
		`URL: ${result.url}`,
		`HTTP: ${result.status || "n/a"}`,
	].join("\n");

	await ui.confirm("Probe result", msg);
}

async function cmdShowPath(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const path = getModelsPath();
	const original = readModelsFileRaw() ?? '{\n  "providers": {}\n}\n';

	const edited = await ui.editor(`models.json — ${path}`, original);
	if (edited === undefined || edited.trimEnd() === original.trimEnd()) return;

	const err = validateModelsText(edited);
	if (err) {
		ui.notify(`Not saved — invalid models.json: ${err}`, "error");
		return;
	}

	const ok = await ui.confirm("Save models.json?", `Write edited content to ${path}?`);
	if (!ok) {
		ui.notify("Cancelled", "info");
		return;
	}
	writeModelsFileRaw(edited);
	ui.notify(`Saved ${path}`, "info");
}

async function mainMenu(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const action = await ui.select("Provider setup", [
		"Add custom provider (relay / 中转站)",
		"Proxy built-in provider (baseUrl only)",
		"List / view providers",
		"Remove provider",
		"Test / probe provider",
		"Show models.json path",
	]);
	if (!action) return;

	if (action.startsWith("Add")) return cmdAdd(ctx);
	if (action.startsWith("Proxy")) return cmdProxy(ctx);
	if (action.startsWith("List")) return cmdList(ctx);
	if (action.startsWith("Remove")) return cmdRemove(ctx);
	if (action.startsWith("Test")) return cmdTest(ctx);
	if (action.startsWith("Show")) return cmdShowPath(ctx);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("provider", {
		description: "Manage custom providers / relays in models.json",
		getArgumentCompletions: (prefix: string) => {
			const sub = ["add", "proxy", "list", "remove", "test", "path"];
			const items = sub
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				console.error(
					"[pi-provider] This command needs interactive UI (TUI). File:",
					getModelsPath(),
				);
				return;
			}

			const sub = (args ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
			try {
				switch (sub) {
					case "add":
						await cmdAdd(ctx);
						break;
					case "proxy":
						await cmdProxy(ctx);
						break;
					case "list":
						await cmdList(ctx);
						break;
					case "remove":
					case "rm":
						await cmdRemove(ctx);
						break;
					case "test":
					case "probe":
						await cmdTest(ctx);
						break;
					case "path":
						await cmdShowPath(ctx);
						break;
					case "":
						await mainMenu(ctx);
						break;
					default:
						ctx.ui.notify(
							`Unknown subcommand "${sub}". Try: add | proxy | list | remove | test | path`,
							"error",
						);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`provider setup failed: ${msg}`, "error");
			}
		},
	});
}
