import { type CheckboxItem, checkboxSelect } from "../lib/checkbox-select.ts";
import { listOpenAIModels } from "../lib/detect-api.ts";
import { loopEditor, loopSelect, runWizard, type StepOutcome, type WizardStep, withSpinner } from "../lib/loop-ui.ts";
import { listProviderIds, readModelsFile, sanitizeProviderId, upsertProvider, writeModelsFile } from "../lib/models-json.ts";
import { enrichModelEntry } from "../lib/official-catalog.ts";
import { type MenuNote, rowMenu } from "../lib/row-menu.ts";
import { API_LABELS, type ProviderApi, type ProviderConfig } from "../lib/types.ts";
import { promptApiKey, promptBaseUrl, promptDisplayName, promptProtocol, promptProviderId } from "./fields.ts";
import { parseModelIds } from "./models.ts";
import {
	builtinProviderIds,
	credentialNote,
	describeKey,
	type Env,
	enrichModels,
	envVarName,
	errorText,
	isReservedProviderId,
	jsoncNotes,
	modelMeta,
	type Notice,
	officialCatalog,
	refreshRegistry,
	resolveConfigValue,
	shortUrl,
} from "./shared.ts";
import { testProvider } from "./test.ts";

export interface LocalPreset {
	id: string;
	label: string;
	baseUrl: string;
	/**
	 * pi only lists custom models whose provider has resolvable credentials, so
	 * local servers get a dummy key (pi's own docs use "ollama" for Ollama).
	 */
	apiKey: string;
}

export const LOCAL_PRESETS: LocalPreset[] = [
	{ id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", apiKey: "ollama" },
	{ id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio" },
	{ id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", apiKey: "vllm" },
];

/** Host labels that say nothing about which relay a host belongs to (incl. `.com.cn`-style suffixes). */
const GENERIC_HOST_LABELS = new Set([
	"api",
	"www",
	"relay",
	"proxy",
	"gateway",
	"gw",
	"openai",
	"v1",
	"llm",
	"ai",
	"com",
	"net",
	"org",
	"co",
	"edu",
	"gov",
	"ac",
]);

/**
 * Suggest a provider id from the base URL host (`api.deepseek.com` →
 * `deepseek`), suffixed to stay unique among existing providers.
 */
export function suggestProviderId(baseUrl: string, taken: Iterable<string>): string {
	let base = "my-relay";
	try {
		const host = new URL(baseUrl).hostname;
		const labels = host.split(".").filter(Boolean);
		const isIp = /^\d+(\.\d+){3}$/.test(host);
		if (host === "localhost" || isIp) base = "local-server";
		else {
			const meaningful = labels.slice(0, -1).filter((label) => !GENERIC_HOST_LABELS.has(label));
			base = sanitizeProviderId(meaningful.at(-1) ?? labels.at(-2) ?? labels[0] ?? "") || base;
		}
	} catch {
		// not a URL — keep the fallback
	}
	const used = new Set(taken);
	if (!used.has(base) && !isReservedProviderId(base)) return base;
	for (let n = 2; ; n++) {
		if (!used.has(`${base}-${n}`) && !isReservedProviderId(`${base}-${n}`)) return `${base}-${n}`;
	}
}

interface Listing {
	/** baseUrl + key the listing was fetched with; a change refetches. */
	forKey: string;
	models: Array<{ id: string; name?: string }>;
	error?: string;
}

interface Draft {
	preset?: LocalPreset;
	id: string;
	/** Set once the user edits the id, so it stops following the base URL. */
	idTouched: boolean;
	name?: string;
	baseUrl: string;
	apiKey?: string;
	api?: ProviderApi;
	selected: string[];
	listing?: Listing;
}

function listingKey(draft: Draft): string {
	return `${draft.baseUrl}\n${draft.apiKey ?? ""}`;
}

async function fetchListing(env: Env, draft: Draft): Promise<Listing | undefined> {
	const forKey = listingKey(draft);
	if (draft.listing?.forKey === forKey) return draft.listing;
	const result = await withSpinner(env.ctx, `Listing models from ${shortUrl(draft.baseUrl)}…`, (signal) =>
		listOpenAIModels({ baseUrl: draft.baseUrl, apiKey: resolveConfigValue(draft.apiKey), signal }),
	).catch((err: unknown) => ({ models: [], tried: [], error: errorText(err) }));
	if (result === undefined) return undefined;
	const listing: Listing = { forKey, models: result.models, error: result.models.length ? undefined : (result.error ?? "empty response") };
	// A local server lists exactly what is installed: start with all of it.
	if (draft.preset && !draft.listing && listing.models.length) draft.selected = listing.models.map((m) => m.id);
	draft.listing = listing;
	return listing;
}

/** Models step: pick from the relay's list, or type ids when it can't be listed. */
async function modelsStep(env: Env, draft: Draft): Promise<StepOutcome> {
	const { ctx } = env;
	const listing = await fetchListing(env, draft);
	if (!listing) return "back";

	if (listing.models.length === 0) {
		const hint = draft.preset ? ` — is ${draft.preset.label} running?` : "";
		let error = "";
		while (true) {
			const edited = await loopEditor(
				ctx,
				`Couldn't list models (${listing.error}${hint}).\nEnter model ids — one per line or comma-separated (Esc = back)${error ? `\n✗ ${error}` : ""}`,
				draft.selected.join("\n"),
			);
			if (edited === undefined) return "back";
			const ids = parseModelIds(edited);
			if (ids.length === 0) {
				error = "Enter at least one model id";
				continue;
			}
			draft.selected = ids;
			return "next";
		}
	}

	const data = readModelsFile();
	const catalog = officialCatalog(ctx, data);
	const listed = new Set(listing.models.map((m) => m.id));
	// Keep ids chosen earlier (e.g. typed before the base URL changed) visible.
	const extra = draft.selected.filter((id) => !listed.has(id)).map((id) => ({ id, name: undefined }));
	const selected = new Set(draft.selected);
	const items: CheckboxItem[] = [...listing.models, ...extra].map((m) => {
		const r = enrichModelEntry(catalog, m.id, draft.api, m.name);
		const origin = listed.has(m.id) ? "" : " · not listed by relay";
		return {
			id: m.id,
			label: m.id,
			detail: `${modelMeta(r.entry)}${r.status === "matched" ? "" : " · no catalog match"}${origin}`,
			description: r.matched ? `metadata from ${r.matched}` : "metadata: defaults (128k context)",
			checked: selected.has(m.id),
		};
	});
	const picked = await checkboxSelect(ctx, `Select models (${listing.models.length} listed by ${shortUrl(draft.baseUrl)})`, items, {
		validate: (ids) => (ids.length ? undefined : "Select at least one model (Space)"),
	});
	if (picked === undefined) return "back";
	draft.selected = picked;
	return "next";
}

function buildConfig(env: Env, draft: Draft): { config: ProviderConfig; matched: number } {
	const names = new Map((draft.listing?.models ?? []).map((m) => [m.id, m.name]));
	const { entries, matched } = enrichModels(
		officialCatalog(env.ctx, readModelsFile()),
		draft.selected.map((id) => ({ id, name: names.get(id) })),
		draft.api,
	);
	return {
		config: {
			...(draft.name ? { name: draft.name } : {}),
			baseUrl: draft.baseUrl,
			api: draft.api,
			...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
			models: entries,
		},
		matched,
	};
}

/**
 * Review page: every field on one screen, each editable in place, so fixing a
 * typo never means stepping back through the wizard. Save writes and hands
 * over to the test panel.
 */
async function reviewStep(env: Env, draft: Draft): Promise<StepOutcome> {
	const { ctx } = env;
	let cursor: string | undefined;
	while (true) {
		const data = readModelsFile();
		const builtins = builtinProviderIds(ctx, data);
		// Built-in ids count as taken: saving under one merges into pi's provider.
		const taken = [...listProviderIds(data), ...builtins];
		if (!draft.idTouched) draft.id = draft.preset && !taken.includes(draft.preset.id) ? draft.preset.id : suggestProviderId(draft.baseUrl, taken);
		const existing = data.providers?.[draft.id];
		const builtin = builtins.has(draft.id);
		const { matched } = buildConfig(env, draft);
		const unmatched = draft.selected.length - matched;

		const notes: MenuNote[] = [];
		if (existing) {
			notes.push({
				text: `⚠ "${draft.id}" already exists — saving replaces it, including its ${existing.models?.length ?? 0} model(s)`,
				tone: "warning",
			});
		}
		if (builtin) {
			notes.push({
				text: `⚠ "${draft.id}" is a provider pi already has — saving adds these models to it, and its own models also send requests to ${shortUrl(draft.baseUrl)}`,
				tone: "warning",
			});
			const credential = credentialNote(ctx, draft.id, draft.apiKey, draft.baseUrl);
			if (credential) notes.push(credential);
		}
		const varName = envVarName(draft.apiKey);
		if (varName && !process.env[varName]) {
			notes.push({ text: `⚠ $${varName} is not set in this shell — pi can't use the key until it is`, tone: "warning" });
		}
		notes.push(...jsoncNotes());

		const choice = await rowMenu(ctx, {
			title: "Review new provider",
			notes,
			entries: [
				{ id: "id", label: "Provider id", value: draft.id },
				{ id: "name", label: "Display name", value: draft.name ?? "(none — shows the id)" },
				{ id: "baseUrl", label: "Base URL", value: draft.baseUrl },
				{ id: "api", label: "Protocol", value: draft.api ? API_LABELS[draft.api] : "(not set)" },
				{ id: "key", label: "API key", value: describeKey(draft.apiKey) },
				{
					id: "models",
					label: "Models",
					value: `${draft.selected.length} selected · ${matched} matched pi's catalog${unmatched ? ` · ${unmatched} use defaults (128k)` : ""}`,
				},
				{ separator: true },
				{ id: "save", label: existing ? "Replace and test" : "Save and test", kind: existing || builtin ? "danger" : "action" },
				{ id: "json", label: "Preview JSON", kind: "action" },
			],
			initialId: cursor ?? "save",
			enterLabel: "edit / select",
		});
		if (!choice) return "back";
		cursor = choice.id;

		switch (choice.id) {
			case "id": {
				const id = await promptProviderId(ctx, draft.id);
				if (id !== undefined) {
					draft.id = id;
					draft.idTouched = true;
				}
				break;
			}
			case "name": {
				const name = await promptDisplayName(ctx, draft.name, draft.id);
				if (name) draft.name = name.value;
				break;
			}
			case "baseUrl": {
				const url = await promptBaseUrl(ctx, draft.baseUrl);
				if (url !== undefined) draft.baseUrl = url;
				break;
			}
			case "api": {
				const api = await promptProtocol(ctx, draft.api);
				if (api) draft.api = api;
				break;
			}
			case "key": {
				const key = await promptApiKey(ctx, draft.apiKey, "new");
				if (key) draft.apiKey = key.value;
				break;
			}
			case "models":
				// The models step re-lists when the base URL or key changed.
				return "back";
			case "json":
				await loopEditor(
					ctx,
					`Preview: ${draft.id} (read-only; Esc = back)`,
					JSON.stringify({ [draft.id]: buildConfig(env, draft).config }, null, 2),
				);
				break;
			case "save":
				writeModelsFile(upsertProvider(readModelsFile(), draft.id, buildConfig(env, draft).config));
				await refreshRegistry(ctx, draft.id);
				return "next";
		}
	}
}

export interface AddResult {
	savedId?: string;
	notice?: Notice;
}

/**
 * Add a provider: base URL → API key → protocol → models → review, then save
 * and run the test panel (where a passing model can be switched to directly).
 * With `local`, a preset (Ollama / LM Studio / vLLM) fills in the first three.
 */
export async function addProvider(env: Env, opts: { local?: boolean } = {}): Promise<AddResult> {
	const { ctx } = env;
	const draft: Draft = { id: "", idTouched: false, baseUrl: "", selected: [] };

	const steps: WizardStep[] = [
		{
			skip: () => !opts.local,
			run: async () => {
				const labels = LOCAL_PRESETS.map((p) => `${p.label}  ${p.baseUrl}`);
				const picked = await loopSelect(ctx, "Local server", labels, {
					escLabel: "back",
					initial: draft.preset ? labels[LOCAL_PRESETS.indexOf(draft.preset)] : undefined,
				});
				if (picked === undefined) return "back";
				const preset = LOCAL_PRESETS[labels.indexOf(picked)]!;
				if (draft.preset !== preset) {
					draft.preset = preset;
					draft.baseUrl = preset.baseUrl;
					draft.apiKey = preset.apiKey;
					draft.api = "openai-completions";
					draft.selected = [];
					draft.listing = undefined;
				}
				return "next";
			},
		},
		{
			skip: () => Boolean(opts.local),
			run: async () => {
				const url = await promptBaseUrl(ctx, draft.baseUrl || undefined);
				if (url === undefined) return "back";
				draft.baseUrl = url;
				return "next";
			},
		},
		{
			skip: () => Boolean(opts.local),
			run: async () => {
				const key = await promptApiKey(ctx, draft.apiKey, "new");
				if (key === undefined) return "back";
				draft.apiKey = key.value;
				return "next";
			},
		},
		{
			skip: () => Boolean(opts.local),
			run: async () => {
				const api = await promptProtocol(ctx, draft.api);
				if (api === undefined) return "back";
				draft.api = api;
				return "next";
			},
		},
		{ run: () => modelsStep(env, draft) },
		{ run: () => reviewStep(env, draft) },
	];

	if (!(await runWizard(steps))) return {};

	const count = draft.selected.length;
	const saved: Notice = { text: `Saved ${draft.id} with ${count} model(s)`, tone: "success" };
	const tested = await testProvider(env, draft.id, { models: draft.selected });
	return {
		savedId: draft.id,
		notice: tested ? { ...tested, text: `${saved.text} · ${tested.text}` } : saved,
	};
}
