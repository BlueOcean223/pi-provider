/**
 * pi-provider
 *
 * Interactive /provider command to manage custom providers in ~/.pi/agent/models.json
 * (relays / 中转站 / local OpenAI-compatible servers).
 *
 * Usage in pi:  /provider
 *               /provider add
 *               /provider models [provider-id]
 *               /provider list
 *               /provider remove
 *               /provider proxy
 *               /provider test
 *
 * UX notes:
 * - all lists loop: ↑ on the first row jumps to the last and vice versa
 * - multi-step flows: Esc goes back one step (Esc on the first step exits)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkboxSelect } from "./lib/checkbox-select.ts";
import { type PanelCheck, runChecksPanel } from "./lib/checks-panel.ts";
import { chatPing, listOpenAIModels, probeEndpoint } from "./lib/detect-api.ts";
import {
	loopEditor,
	loopSelect,
	runWizard,
	type StepOutcome,
	type WizardStep,
	withSpinner,
} from "./lib/loop-ui.ts";
import {
	findNewRelayModels,
	mergeModelAdditions,
	removeModelEntries,
} from "./lib/model-management.ts";
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

function parseModelIds(raw: string): string[] {
	return Array.from(
		new Set(
			raw
				.split(/[\n,]+/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	);
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

interface ResolvedCatalogAuth {
	apiKey?: string;
	headers?: Record<string, string | null>;
}

async function resolveSavedProviderAuth(
	ctx: ExtensionCommandContext,
	providerId: string,
	configuredApiKey?: string,
): Promise<ResolvedCatalogAuth> {
	const fallbackApiKey = resolveProbeKey(configuredApiKey);
	try {
		const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === providerId);
		if (model) {
			const requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (requestAuth.ok) {
				return {
					apiKey: requestAuth.apiKey ?? fallbackApiKey,
					headers: requestAuth.headers,
				};
			}
		}

		const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
		return {
			apiKey: resolved?.auth.apiKey ?? fallbackApiKey,
			headers: resolved?.auth.headers,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Could not resolve saved auth for ${providerId}: ${message}`, "warning");
		return { apiKey: fallbackApiKey };
	}
}

async function refreshModelRegistry(ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.modelRegistry.refresh();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Could not refresh the model registry: ${message}`, "warning");
	}
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
	options?: { title?: string; checked?: boolean },
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
			checked: options?.checked ?? false,
		};
	});

	const selectedIds = await checkboxSelect(
		ctx,
		options?.title ?? `Select models to add (${listed.length} from relay)`,
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

async function enterModelsManually(
	ctx: ExtensionCommandContext,
	catalog: OfficialModelMeta[],
	api: ProviderApi,
): Promise<ModelEntry[] | null> {
	const { ui } = ctx;
	const raw = await loopEditor(
		ctx,
		"Model ids (one per line or comma-separated; Esc = back)",
		"gpt-4o\nclaude-sonnet-4",
	);
	if (raw === undefined) return null;
	const ids = parseModelIds(raw);
	if (ids.length === 0) {
		ui.notify("No model ids entered", "error");
		return null;
	}
	if (ids.length > 1) {
		return pickModelsFromList(
			ctx,
			catalog,
			ids.map((id) => ({ id })),
			api,
			{ title: `Review models to add (${ids.length} entered)`, checked: true },
		);
	}
	return buildEnrichedModels(
		catalog,
		ids.map((id) => ({ id })),
		api,
		ui,
	);
}

async function pickModelsToRemove(
	ctx: ExtensionCommandContext,
	models: ModelEntry[],
): Promise<string[] | null> {
	const { ui } = ctx;
	const seen = new Set<string>();
	const items = models.flatMap((model) => {
		if (seen.has(model.id)) return [];
		seen.add(model.id);
		const think = model.thinkingLevelMap
			? "think"
			: model.reasoning
				? "reasoning"
				: "—";
		const name = model.name && model.name !== model.id ? `${model.name} · ` : "";
		return [
			{
				id: model.id,
				label: model.id,
				description: `${name}${formatCtx(model.contextWindow)} ctx · ${think}`,
				checked: false,
			},
		];
	});

	const selected = await checkboxSelect(
		ctx,
		`Select models to remove (${items.length} configured)`,
		items,
	);
	if (selected === undefined) return null;
	if (selected.length === 0) {
		ui.notify("No models selected", "warning");
		return null;
	}
	return selected;
}

/* ------------------------------------------------------------------ */
/* Shared wizard steps                                                 */
/* ------------------------------------------------------------------ */

interface KeyState {
	keyChoice: string;
	apiKey: string | undefined;
}

const KEY_MODE_OPTIONS = [
	"Store literal key in models.json",
	"Reference environment variable ($VAR)",
	"Skip for now (use /login or --api-key later)",
];

function keyModeStep(
	ctx: ExtensionCommandContext,
	st: KeyState,
	skip?: () => boolean,
): WizardStep {
	return {
		skip,
		run: async () => {
			const mode = await loopSelect(ctx, "API key", KEY_MODE_OPTIONS, { escLabel: "back" });
			if (mode === undefined) return "back";
			st.keyChoice = mode;
			if (mode.startsWith("Skip")) st.apiKey = undefined;
			return "next";
		},
	};
}

function keyValueStep(
	ctx: ExtensionCommandContext,
	st: KeyState,
	skip?: () => boolean,
): WizardStep {
	return {
		skip: () => (skip?.() ?? false) || !st.keyChoice || st.keyChoice.startsWith("Skip"),
		run: async () => {
			const { ui } = ctx;
			if (st.keyChoice.startsWith("Reference")) {
				const name = await ui.input("Environment variable name (Esc = back)", "MY_RELAY_API_KEY");
				if (name === undefined) return "back";
				const cleaned = name.trim().replace(/^\$/, "");
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
					ui.notify("Invalid env var name", "error");
					return "stay";
				}
				st.apiKey = `$${cleaned}`;
				return "next";
			}
			const key = await ui.input("API key (saved to models.json with 0600 perms; Esc = back)", "sk-...");
			if (key === undefined) return "back";
			const trimmed = key.trim();
			if (!trimmed) {
				ui.notify("Empty key; skipping", "warning");
				st.apiKey = undefined;
				return "next";
			}
			st.apiKey = trimmed;
			return "next";
		},
	};
}

/** Models step for cmdAdd — internal loop so Esc in a sub-dialog returns to the mode select. */
async function collectModelsStep(
	ctx: ExtensionCommandContext,
	catalog: OfficialModelMeta[],
	st: { api: ProviderApi | undefined; baseUrl: string; apiKey: string | undefined; models: ModelEntry[] | null },
): Promise<StepOutcome> {
	const { ui } = ctx;
	const api = st.api ?? "openai-completions";

	while (true) {
		const mode = await loopSelect(
			ctx,
			"Models",
			[
				"Fetch from GET /v1/models then multi-select",
				"Enter model ids manually",
				"Minimal placeholder (edit models.json later)",
			],
			{ escLabel: "back" },
		);
		if (mode === undefined) return "back";

		if (mode.startsWith("Minimal")) {
			st.models = buildEnrichedModels(catalog, [{ id: "default-model" }], api, ui);
			return "next";
		}

		if (mode.startsWith("Fetch")) {
			const listed = await withSpinner(ctx, `Fetching model catalog from ${st.baseUrl}…`, (signal) =>
				listOpenAIModels({
					baseUrl: st.baseUrl,
					apiKey: resolveProbeKey(st.apiKey),
					signal,
				}),
			);
			if (listed === undefined) continue; // Esc — back to the Models menu
			if (listed.models.length === 0) {
				ui.notify(
					`No models listed (${listed.error ?? "empty"}). Tried: ${listed.tried.join(", ")}. Fall back to manual entry.`,
					"warning",
				);
				const models = await enterModelsManually(ctx, catalog, api);
				if (!models) continue;
				st.models = models;
				return "next";
			}
			ui.notify(
				`Fetched ${listed.models.length} models${listed.matchedUrl ? ` from ${listed.matchedUrl}` : ""}`,
				"info",
			);
			const picked = await pickModelsFromList(ctx, catalog, listed.models, api);
			if (!picked) continue;
			st.models = picked;
			return "next";
		}

		// Manual entry
		const models = await enterModelsManually(ctx, catalog, api);
		if (!models) continue;
		st.models = models;
		return "next";
	}
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdAdd(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const data = readModelsFile();

	// Exclude relay providers already defined in models.json so their copied
	// metadata can't match against itself; baseUrl-only proxy overrides keep
	// the official builtin models and stay in the catalog.
	const relayProviderIds = Object.entries(data.providers ?? {})
		.filter(([, cfg]) => cfg.models?.length)
		.map(([pid]) => pid);
	const catalog = catalogFromRegistry(ctx, relayProviderIds);

	const st = {
		id: "",
		baseUrl: "",
		api: undefined as ProviderApi | undefined,
		keyChoice: "",
		apiKey: undefined as string | undefined,
		models: null as ModelEntry[] | null,
		compat: undefined as Record<string, unknown> | undefined,
		displayName: "",
	};

	const steps: WizardStep[] = [
		{
			// 1. provider id
			run: async () => {
				const rawId = await ui.input("Provider id (e.g. my-relay)", st.id || "my-relay");
				if (rawId === undefined) return "back";
				const id = sanitizeProviderId(rawId);
				if (!id) {
					ui.notify("Invalid provider id", "error");
					return "stay";
				}
				st.id = id;
				return "next";
			},
		},
		{
			// 2. overwrite check (only when id already exists)
			skip: () => !readModelsFile().providers?.[st.id],
			run: async () => {
				const choice = await loopSelect(
					ctx,
					`Provider "${st.id}" already exists. Overwrite?`,
					["Yes — overwrite", "No — change id"],
					{ escLabel: "back" },
				);
				if (choice === undefined || choice.startsWith("No")) return "back";
				return "next";
			},
		},
		{
			// 3. baseUrl
			run: async () => {
				const raw = await ui.input("Base URL (Esc = back)", st.baseUrl || "https://api.example.com/v1");
				if (raw === undefined) return "back";
				if (!raw.trim()) {
					ui.notify("baseUrl is required", "error");
					return "stay";
				}
				st.baseUrl = raw.trim().replace(/\/+$/, "");
				return "next";
			},
		},
		{
			// 4. API protocol
			run: async () => {
				const labels = API_OPTIONS.map((k) => API_LABELS[k]);
				const picked = await loopSelect(ctx, "API protocol", labels, { escLabel: "back" });
				if (picked === undefined) return "back";
				st.api = LABEL_TO_API[picked];
				return "next";
			},
		},
		// 5+6. API key
		keyModeStep(ctx, st),
		keyValueStep(ctx, st),
		{
			// 7. models
			run: () => collectModelsStep(ctx, catalog, st),
		},
		{
			// 8. compat preset (openai-* only)
			skip: () => st.api !== "openai-completions" && st.api !== "openai-responses",
			run: async () => {
				const choice = await loopSelect(
					ctx,
					"OpenAI compatibility preset",
					[
						"None (defaults)",
						"Local / strict OpenAI-compat (no developer role, no reasoning_effort)",
						"Chinese relay safe defaults (no developer role)",
					],
					{ escLabel: "back" },
				);
				if (choice === undefined) return "back";
				st.compat = choice.startsWith("None")
					? undefined
					: choice.startsWith("Local")
						? { supportsDeveloperRole: false, supportsReasoningEffort: false }
						: { supportsDeveloperRole: false };
				return "next";
			},
		},
		{
			// 9. display name
			run: async () => {
				const name = await ui.input("Display name (optional; Esc = back)", st.displayName || st.id);
				if (name === undefined) return "back";
				st.displayName = name.trim();
				return "next";
			},
		},
		{
			// 10. preview + write
			run: async () => {
				const config: ProviderConfig = {
					...(st.displayName && st.displayName !== st.id ? { name: st.displayName } : {}),
					baseUrl: st.baseUrl,
					api: st.api,
					...(st.apiKey ? { apiKey: st.apiKey } : {}),
					...(st.compat ? { compat: st.compat } : {}),
					models: st.models ?? [],
				};
				const preview = JSON.stringify({ [st.id]: config }, null, 2);
				const jsoncNote = modelsFileHasJsonc()
					? "\n\nNote: // comments and trailing commas in models.json will be removed on save."
					: "";
				const choice = await loopSelect(
					ctx,
					`Write models.json?\nWill upsert provider "${st.id}" into ${getModelsPath()}${jsoncNote}\n\n${preview.slice(0, 1200)}${
						preview.length > 1200 ? "\n…" : ""
					}`,
					["Yes — write", "No — cancel"],
					{ escLabel: "back" },
				);
				if (choice === undefined) return "back";
				if (choice.startsWith("No")) {
					ui.notify("Cancelled", "info");
					return "abort";
				}
				writeModelsFile(upsertProvider(readModelsFile(), st.id, config));
				ui.notify(`Saved ${st.id}. Open /model to select, or /provider test to probe.`, "info");
				return "next";
			},
		},
	];

	await runWizard(steps);
}

function isProviderApi(value: unknown): value is ProviderApi {
	return typeof value === "string" && API_OPTIONS.includes(value as ProviderApi);
}

function inferProviderApi(cfg: ProviderConfig): ProviderApi | undefined {
	if (isProviderApi(cfg.api)) return cfg.api;
	const modelApis = new Set(
		(cfg.models ?? [])
			.map((model) => model.api)
			.filter((api): api is ProviderApi => isProviderApi(api)),
	);
	if (modelApis.size !== 1) return undefined;
	const first = modelApis.values().next();
	return first.done ? undefined : first.value;
}

function canManageProviderModels(cfg: ProviderConfig): boolean {
	return Boolean(cfg.models?.length || (cfg.baseUrl && inferProviderApi(cfg)));
}

function modelsKnownToProvider(
	ctx: ExtensionCommandContext,
	providerId: string,
	cfg: ProviderConfig,
): ModelEntry[] {
	const known = [...(cfg.models ?? [])];
	const ids = new Set(known.map((model) => model.id));
	for (const model of ctx.modelRegistry.getAll()) {
		if (model.provider !== providerId || ids.has(model.id)) continue;
		ids.add(model.id);
		known.push({ id: model.id });
	}
	return known;
}

function additionsWithRequiredApi(
	cfg: ProviderConfig,
	api: ProviderApi,
	additions: ModelEntry[],
): ModelEntry[] {
	if (cfg.api) return additions;
	return additions.map((model) => (model.api ? model : { ...model, api }));
}

async function saveModelAdditions(
	ctx: ExtensionCommandContext,
	providerId: string,
	api: ProviderApi,
	additions: ModelEntry[],
): Promise<boolean> {
	const { ui } = ctx;
	const before = readModelsFile();
	const cfg = before.providers?.[providerId];
	if (!cfg) {
		ui.notify(`Provider "${providerId}" no longer exists`, "error");
		return false;
	}

	const plannedAdditions = additionsWithRequiredApi(cfg, api, additions);
	const planned = mergeModelAdditions(cfg.models ?? [], plannedAdditions);
	if (planned.addedIds.length === 0) {
		ui.notify(`No new models to add to ${providerId}`, "info");
		return false;
	}

	const preview = planned.addedIds.map((id) => `+ ${id}`).join("\n");
	const jsoncNote = modelsFileHasJsonc()
		? "\n\nNote: // comments and trailing commas in models.json will be removed on save."
		: "";
	const choice = await loopSelect(
		ctx,
		`Update provider "${providerId}"?\n\n${preview.slice(0, 1200)}${
			preview.length > 1200 ? "\n…" : ""
		}\n\n${planned.addedIds.length} added · ${cfg.models?.length ?? 0} unchanged · 0 removed\nFile: ${getModelsPath()}${jsoncNote}`,
		["Yes — add models", "No — back"],
		{ escLabel: "back" },
	);
	if (choice === undefined || choice.startsWith("No")) return false;

	// Re-read immediately before writing so unrelated provider/config edits made
	// while the catalog and confirmation dialogs were open are preserved.
	const fresh = readModelsFile();
	const freshCfg = fresh.providers?.[providerId];
	if (!freshCfg) {
		ui.notify(`Provider "${providerId}" no longer exists`, "error");
		return false;
	}
	const freshAdditions = additionsWithRequiredApi(freshCfg, api, additions);
	const merged = mergeModelAdditions(freshCfg.models ?? [], freshAdditions);
	if (merged.addedIds.length === 0) {
		ui.notify(`${providerId} already contains the selected models`, "info");
		return true;
	}

	writeModelsFile(
		upsertProvider(fresh, providerId, {
			...freshCfg,
			models: merged.models,
		}),
	);
	ui.notify(
		`Added ${merged.addedIds.length} model(s) to ${providerId}. Open /model to select.`,
		"info",
	);
	return true;
}

async function saveModelRemovals(
	ctx: ExtensionCommandContext,
	providerId: string,
	selectedIds: string[],
): Promise<boolean> {
	const { ui } = ctx;
	const before = readModelsFile();
	const cfg = before.providers?.[providerId];
	if (!cfg) {
		ui.notify(`Provider "${providerId}" no longer exists`, "error");
		return false;
	}

	const planned = removeModelEntries(cfg.models ?? [], selectedIds);
	if (planned.removedIds.length === 0) {
		ui.notify(`The selected models are no longer configured on ${providerId}`, "info");
		return false;
	}

	const preview = planned.removedIds.map((id) => `- ${id}`).join("\n");
	const jsoncNote = modelsFileHasJsonc()
		? "\n\nNote: // comments and trailing commas in models.json will be removed on save."
		: "";
	const choice = await loopSelect(
		ctx,
		`Remove models from "${providerId}"?\n\n${preview.slice(0, 1200)}${
			preview.length > 1200 ? "\n…" : ""
		}\n\n${planned.removedIds.length} removed · ${planned.models.length} kept\nFile: ${getModelsPath()}${jsoncNote}`,
		["Yes — remove models", "No — back"],
		{ escLabel: "back" },
	);
	if (choice === undefined || choice.startsWith("No")) return false;

	// Apply the selected ids to the latest file contents so unrelated additions
	// or metadata edits made while the dialogs were open remain intact.
	const fresh = readModelsFile();
	const freshCfg = fresh.providers?.[providerId];
	if (!freshCfg) {
		ui.notify(`Provider "${providerId}" no longer exists`, "error");
		return false;
	}
	const removed = removeModelEntries(freshCfg.models ?? [], selectedIds);
	if (removed.removedIds.length === 0) {
		ui.notify(`${providerId} no longer contains the selected models`, "info");
		return true;
	}

	const preservedApi =
		removed.models.length === 0 && !freshCfg.api ? inferProviderApi(freshCfg) : undefined;
	writeModelsFile(
		upsertProvider(fresh, providerId, {
			...freshCfg,
			...(preservedApi ? { api: preservedApi } : {}),
			models: removed.models,
		}),
	);
	ui.notify(
		`Removed ${removed.removedIds.length} model(s) from ${providerId}. Open /model to refresh.`,
		"info",
	);
	return true;
}

async function manageProviderModels(
	ctx: ExtensionCommandContext,
	providerId: string,
): Promise<boolean> {
	const { ui } = ctx;

	while (true) {
		const data = readModelsFile();
		const cfg = data.providers?.[providerId];
		if (!cfg) {
			ui.notify(`Unknown provider "${providerId}"`, "error");
			return false;
		}
		const api = inferProviderApi(cfg);
		const actions: string[] = [];
		if (cfg.baseUrl && api) {
			actions.push("Discover and add new models", "Enter model ids manually");
		}
		if (cfg.models?.length) actions.push("Remove configured models");
		if (actions.length === 0) {
			ui.notify(
				`${providerId} has neither removable custom models nor enough configuration to add models`,
				"error",
			);
			return false;
		}

		const action = await loopSelect(
			ctx,
			`Manage models: ${providerId} (${cfg.models?.length ?? 0} configured)`,
			actions,
			{ escLabel: "back" },
		);
		if (action === undefined) return false;

		if (action.startsWith("Remove")) {
			const selected = await pickModelsToRemove(ctx, cfg.models ?? []);
			if (!selected) continue;
			if (await saveModelRemovals(ctx, providerId, selected)) return true;
			continue;
		}

		if (!cfg.baseUrl || !api) {
			ui.notify(`${providerId} needs both baseUrl and an API protocol to add models`, "error");
			continue;
		}

		const relayProviderIds = Object.entries(data.providers ?? {})
			.filter(([, provider]) => provider.models?.length)
			.map(([id]) => id);
		const catalog = catalogFromRegistry(ctx, relayProviderIds);
		let additions: ModelEntry[] | null = null;

		if (action.startsWith("Discover")) {
			// models.json may have changed since the registry was last loaded (for
			// example after an earlier add/remove in this session). Refresh before
			// using effective provider models to calculate the remote diff.
			await refreshModelRegistry(ctx);
			const listed = await withSpinner(
				ctx,
				`Fetching model catalog from ${cfg.baseUrl}…`,
				async (signal) => {
					const auth = await resolveSavedProviderAuth(ctx, providerId, cfg.apiKey);
					return listOpenAIModels({
						baseUrl: cfg.baseUrl!,
						apiKey: auth.apiKey,
						headers: auth.headers,
						signal,
					});
				},
			);
			if (listed === undefined) continue;
			if (listed.models.length === 0) {
				ui.notify(
					`No models listed (${listed.error ?? "empty"}). Tried: ${listed.tried.join(", ")}. You can enter ids manually instead.`,
					"warning",
				);
				continue;
			}

			// Include effective registry models as well as models.json entries. This
			// prevents a built-in provider override from re-adding its inherited
			// built-in models as custom entries (which would replace their metadata).
			const candidates = findNewRelayModels(
				modelsKnownToProvider(ctx, providerId, cfg),
				listed.models,
			);
			if (candidates.length === 0) {
				ui.notify(
					`${providerId} is up to date: ${listed.models.length} listed, 0 new`,
					"info",
				);
				continue;
			}

			const mode = await loopSelect(
				ctx,
				`Found ${listed.models.length} model(s)${listed.matchedUrl ? ` from ${listed.matchedUrl}` : ""}\n${cfg.models?.length ?? 0} configured · ${candidates.length} new`,
				[
					`Add all ${candidates.length} new models`,
					"Select new models to add",
					"Back",
				],
				{ escLabel: "back" },
			);
			if (mode === undefined || mode === "Back") continue;
			additions = mode.startsWith("Add all")
				? buildEnrichedModels(catalog, candidates, api, ui)
				: await pickModelsFromList(ctx, catalog, candidates, api, {
						title: `Select new models to add (${candidates.length} available)`,
					});
		} else {
			additions = await enterModelsManually(ctx, catalog, api);
		}

		if (!additions || additions.length === 0) continue;
		if (await saveModelAdditions(ctx, providerId, api, additions)) return true;
	}
}

async function cmdModels(
	ctx: ExtensionCommandContext,
	requestedProviderId?: string,
): Promise<void> {
	const { ui } = ctx;
	let direct = requestedProviderId?.trim();

	while (true) {
		const data = readModelsFile();
		const manageableIds = listProviderIds(data).filter((id) => {
			const cfg = data.providers?.[id];
			return Boolean(cfg && canManageProviderModels(cfg));
		});

		let providerId: string | undefined;
		if (direct) {
			providerId = data.providers?.[direct]
				? direct
				: listProviderIds(data).find((id) => id.toLowerCase() === direct!.toLowerCase());
			if (!providerId) {
				ui.notify(`Unknown provider "${direct}"`, "error");
				return;
			}
			if (!manageableIds.includes(providerId)) {
				ui.notify(`${providerId} has no custom models to remove and cannot add models`, "error");
				return;
			}
		} else {
			if (manageableIds.length === 0) {
				ui.notify("No providers with custom models or enough configuration to add them.", "info");
				return;
			}
			const lines = manageableIds.map((id) => summarizeProvider(id, data.providers![id]!));
			const picked = await loopSelect(ctx, "Provider whose models you want to manage", lines);
			if (!picked) return;
			providerId = manageableIds[lines.indexOf(picked)];
			if (!providerId) return;
		}

		const saved = await manageProviderModels(ctx, providerId);
		if (saved || direct) return;
		// Back from the action menu returns to the provider list.
		direct = undefined;
	}
}

async function cmdProxy(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const data = readModelsFile();
	const custom = "Other (type id)…";

	const st = {
		id: "",
		baseUrl: "",
		alsoKey: "",
		keyChoice: "",
		apiKey: undefined as string | undefined,
		keepModels: true,
	};

	const steps: WizardStep[] = [
		{
			// 1. target provider
			run: async () => {
				const picked = await loopSelect(
					ctx,
					"Built-in provider to route via baseUrl",
					[...BUILTIN_PROXY_TARGETS, custom],
					{ escLabel: "back" },
				);
				if (picked === undefined) return "back";
				if (picked !== custom) {
					st.id = picked;
					return "next";
				}
				const typed = await ui.input("Provider id (Esc = back)", st.id || "anthropic");
				if (typed === undefined) return "stay"; // re-run this step → shows the provider list again
				const id = sanitizeProviderId(typed);
				if (!id) {
					ui.notify("Invalid provider id", "error");
					return "stay";
				}
				st.id = id;
				return "next";
			},
		},
		{
			// 2. baseUrl
			run: async () => {
				const raw = await ui.input(
					`Proxy baseUrl for ${st.id} (Esc = back)`,
					st.baseUrl || "https://your-relay.example.com",
				);
				if (raw === undefined) return "back";
				if (!raw.trim()) {
					ui.notify("baseUrl is required", "error");
					return "stay";
				}
				st.baseUrl = raw.trim().replace(/\/+$/, "");
				return "next";
			},
		},
		{
			// 3. also set apiKey?
			run: async () => {
				const choice = await loopSelect(
					ctx,
					"Also set apiKey?",
					["No — keep existing /login or env auth", "Yes — store key / env ref"],
					{ escLabel: "back" },
				);
				if (choice === undefined) return "back";
				st.alsoKey = choice;
				if (choice.startsWith("No")) {
					st.keyChoice = "";
					st.apiKey = undefined;
				}
				return "next";
			},
		},
		// 4+5. key (only when "Yes")
		keyModeStep(ctx, st, () => !st.alsoKey.startsWith("Yes")),
		keyValueStep(ctx, st, () => !st.alsoKey.startsWith("Yes")),
		{
			// 6. keep existing custom models?
			skip: () => !data.providers?.[st.id]?.models?.length,
			run: async () => {
				const count = data.providers?.[st.id]?.models?.length ?? 0;
				const choice = await loopSelect(
					ctx,
					`"${st.id}" already has ${count} custom model(s). Keep them?`,
					["Yes — keep", "No — remove them"],
					{ escLabel: "back" },
				);
				if (choice === undefined) return "back";
				st.keepModels = choice.startsWith("Yes");
				return "next";
			},
		},
		{
			// 7. confirm + write
			run: async () => {
				const choice = await loopSelect(
					ctx,
					`Write models.json?\nRoute ${st.id} → ${st.baseUrl}\n(File: ${getModelsPath()})${
						modelsFileHasJsonc()
							? "\n\nNote: // comments and trailing commas in models.json will be removed on save."
							: ""
					}`,
					["Yes — write", "No — cancel"],
					{ escLabel: "back" },
				);
				if (choice === undefined) return "back";
				if (choice.startsWith("No")) {
					ui.notify("Cancelled", "info");
					return "abort";
				}
				const fresh = readModelsFile();
				const existing = fresh.providers?.[st.id] ?? {};
				const config: ProviderConfig = {
					...existing,
					baseUrl: st.baseUrl,
					...(st.alsoKey.startsWith("Yes") && st.apiKey !== undefined ? { apiKey: st.apiKey } : {}),
				};
				if (!st.keepModels) delete config.models;
				writeModelsFile(upsertProvider(fresh, st.id, config));
				ui.notify(`Proxy override saved for ${st.id}. Open /model to use.`, "info");
				return "next";
			},
		},
	];

	await runWizard(steps);
}

async function cmdList(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	while (true) {
		const data = readModelsFile();
		const ids = listProviderIds(data);
		if (ids.length === 0) {
			ui.notify(`No custom providers in ${getModelsPath()}`, "info");
			return;
		}

		const lines = ids.map((id) => summarizeProvider(id, data.providers![id]!));
		const picked = await loopSelect(
			ctx,
			`Custom providers (${ids.length}) — select to view JSON`,
			lines,
		);
		if (!picked) return;
		const id = ids[lines.indexOf(picked)];
		if (!id) return;
		const json = JSON.stringify(data.providers![id], null, 2);
		await loopEditor(ctx, `Provider: ${id} (read-only view; Esc = back to list)`, json);
	}
}

async function cmdRemove(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	while (true) {
		const data = readModelsFile();
		const ids = listProviderIds(data);
		if (ids.length === 0) {
			ui.notify("No custom providers to remove", "info");
			return;
		}
		const lines = ids.map((id) => summarizeProvider(id, data.providers![id]!));
		const picked = await loopSelect(ctx, "Remove provider", lines);
		if (!picked) return;
		const id = ids[lines.indexOf(picked)];
		if (!id) return;

		const confirm = await loopSelect(
			ctx,
			`Delete provider "${id}" from models.json?`,
			["Yes — delete", "No — back"],
			{ escLabel: "back" },
		);
		if (confirm === undefined || confirm.startsWith("No")) continue;

		writeModelsFile(removeProvider(data, id));
		ui.notify(`Removed ${id}`, "info");
		return;
	}
}

async function cmdTest(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	// Loop: closing a test panel returns to the provider list (Esc leaves).
	while (true) {
		const data = readModelsFile();
		const ids = listProviderIds(data);
		if (ids.length === 0) {
			ui.notify("No custom providers. Add one first.", "info");
			return;
		}

		const lines = ids.map((id) => summarizeProvider(id, data.providers![id]!));
		const picked = await loopSelect(ctx, "Test provider", lines);
		if (!picked) return;
		const id = ids[lines.indexOf(picked)];
		if (!id) return;
		const cfg = data.providers![id]!;

		const baseUrl = cfg.baseUrl;
		if (!baseUrl) {
			ui.notify(`${id} has no baseUrl`, "error");
			continue;
		}

		const probeKey = resolveProbeKey(cfg.apiKey);
		const notes: string[] = [];
		if (cfg.apiKey?.startsWith("$") && !probeKey) {
			notes.push(`Env ${cfg.apiKey.slice(1)} is not set — testing without a key`);
		} else if (cfg.apiKey?.startsWith("!")) {
			notes.push("apiKey is a !command (not run here) — testing without a key");
		}

		const api = cfg.api;
		const modelIds = (cfg.models ?? []).map((m) => m.id);
		let chatModel = modelIds[0];
		if (api && modelIds.length > 1) {
			const pickedModel = await loopSelect(
				ctx,
				`Model for the chat test (${modelIds.length} configured)`,
				modelIds,
				{ escLabel: "back" },
			);
			if (pickedModel === undefined) continue; // back to the provider list
			chatModel = pickedModel;
		}

		// Catalog probe only proves the gateway answers; the real chat request is
		// the authoritative test (relay panels like one-api test channels this
		// way), so it runs automatically — no "also send a chat request?" gate.
		const checks: PanelCheck[] = [
			{
				label: "Catalog probe",
				runningDetail: "listing models",
				run: async (signal) => {
					const probe = await probeEndpoint({ baseUrl, apiKey: probeKey, signal });
					return {
						ok: probe.ok,
						detail: probe.detail,
						sub: [probe.status ? `${probe.url} · HTTP ${probe.status}` : probe.url],
					};
				},
			},
		];
		if (!api) {
			checks.push({
				label: "Chat test",
				skipReason: "baseUrl-only proxy — chat goes through the builtin provider",
			});
		} else if (!chatModel) {
			checks.push({ label: "Chat test", skipReason: "provider has no custom models" });
		} else {
			const model = chatModel;
			checks.push({
				label: `Chat test (${model})`,
				runningDetail: `sending "hi" via ${api}`,
				run: async (signal) => {
					const ping = await chatPing({ baseUrl, api, model, apiKey: probeKey, signal });
					return {
						ok: ping.ok,
						detail: ping.ok ? 'sent "hi", got a reply' : ping.detail,
						sub: [ping.status ? `${ping.url} · HTTP ${ping.status}` : ping.url],
					};
				},
			});
		}

		await runChecksPanel(ctx, {
			title: `Test provider: ${id}`,
			subtitle: `${baseUrl} · ${api ?? "builtin protocol"}`,
			notes,
			checks,
		});
	}
}

async function cmdShowPath(ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;
	const path = getModelsPath();
	const original = readModelsFileRaw() ?? '{\n  "providers": {}\n}\n';

	const edited = await loopEditor(ctx, `models.json — ${path}`, original);
	if (edited === undefined || edited.trimEnd() === original.trimEnd()) return;

	const err = validateModelsText(edited);
	if (err) {
		ui.notify(`Not saved — invalid models.json: ${err}`, "error");
		return;
	}

	const choice = await loopSelect(ctx, `Save models.json?\nWrite edited content to ${path}?`, [
		"Yes — save",
		"No — discard",
	]);
	if (choice === undefined || choice.startsWith("No")) {
		ui.notify("Cancelled", "info");
		return;
	}
	writeModelsFileRaw(edited);
	ui.notify(`Saved ${path}`, "info");
}

async function mainMenu(ctx: ExtensionCommandContext): Promise<void> {
	// Loop so finishing (or backing out of) a sub-flow returns to this menu.
	while (true) {
		const action = await loopSelect(ctx, "Provider setup", [
			"Add custom provider (relay / 中转站)",
			"Manage models for existing provider",
			"Proxy built-in provider (baseUrl only)",
			"List / view providers",
			"Remove provider",
			"Test / probe provider",
			"Show models.json path",
		]);
		if (!action) return;

		if (action.startsWith("Add")) await cmdAdd(ctx);
		else if (action.startsWith("Manage models")) await cmdModels(ctx);
		else if (action.startsWith("Proxy")) await cmdProxy(ctx);
		else if (action.startsWith("List")) await cmdList(ctx);
		else if (action.startsWith("Remove")) await cmdRemove(ctx);
		else if (action.startsWith("Test")) await cmdTest(ctx);
		else if (action.startsWith("Show")) await cmdShowPath(ctx);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("provider", {
		description: "Manage custom providers / relays in models.json",
		getArgumentCompletions: (prefix: string) => {
			const modelsMatch = prefix.match(/^\s*(models|add-models)\s+(.*)$/i);
			if (modelsMatch) {
				const command = modelsMatch[1]!.toLowerCase();
				const query = modelsMatch[2]!.trim().toLowerCase();
				try {
					const data = readModelsFile();
					const items = listProviderIds(data)
						.filter((id) => {
							const cfg = data.providers?.[id];
							return Boolean(
								id.toLowerCase().startsWith(query) && cfg && canManageProviderModels(cfg),
							);
						})
						.map((id) => ({
							value: `${command} ${id}`,
							label: id,
							description: summarizeProvider(id, data.providers![id]!),
						}));
					return items.length > 0 ? items : null;
				} catch {
					return null;
				}
			}

			const sub = ["add", "models", "add-models", "proxy", "list", "remove", "test", "path"];
			const query = prefix.trim().toLowerCase();
			const items = sub
				.filter((s) => s.startsWith(query))
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

			const rawArgs = (args ?? "").trim();
			const parts = rawArgs ? rawArgs.split(/\s+/) : [];
			const sub = (parts[0] ?? "").toLowerCase();
			const requestedProviderId = parts[1];
			try {
				switch (sub) {
					case "add":
						await cmdAdd(ctx);
						break;
					case "models":
					case "add-models":
						await cmdModels(ctx, requestedProviderId);
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
							`Unknown subcommand "${sub}". Try: add | models | proxy | list | remove | test | path`,
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
