import { type CheckboxItem, checkboxSelect } from "../lib/checkbox-select.ts";
import { listOpenAIModels } from "../lib/detect-api.ts";
import { loopEditor, withSpinner } from "../lib/loop-ui.ts";
import {
	findNewRelayModels,
	formatRefreshChange,
	mergeModelAdditions,
	refreshModelEntries,
	removeModelEntries,
} from "../lib/model-management.ts";
import { getModelsPath, readModelsFile, upsertProvider, writeModelsFile } from "../lib/models-json.ts";
import { enrichModelEntry } from "../lib/official-catalog.ts";
import { type MenuNote, rowMenu } from "../lib/row-menu.ts";
import type { ModelEntry, ProviderApi, ProviderConfig } from "../lib/types.ts";
import {
	type Env,
	enrichModels,
	errorText,
	idLines,
	inferProviderApi,
	jsoncNotes,
	modelMeta,
	modelsKnownToProvider,
	type Notice,
	officialCatalog,
	refreshRegistry,
	resolveProviderAuth,
	shortUrl,
	uniqueModelIds,
} from "./shared.ts";

/** Split an editor answer into unique model ids (newline- or comma-separated). */
export function parseModelIds(raw: string): string[] {
	return Array.from(
		new Set(
			raw
				.split(/[\n,]+/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	);
}

function additionsWithRequiredApi(cfg: ProviderConfig, api: ProviderApi | undefined, additions: ModelEntry[]): ModelEntry[] {
	// Without a provider-level api every custom model must carry its own.
	if (cfg.api || !api) return additions;
	return additions.map((model) => (model.api ? model : { ...model, api }));
}

export interface ModelChanges {
	added: string[];
	removed: string[];
}

/**
 * Apply additions and removals to the latest file contents in one write, so
 * unrelated edits made while the dialogs were open survive.
 */
export async function writeModelChanges(
	env: Env,
	providerId: string,
	additions: ModelEntry[],
	removeIds: string[],
): Promise<ModelChanges | Notice> {
	const fresh = readModelsFile();
	const cfg = fresh.providers?.[providerId];
	if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };

	const api = inferProviderApi(cfg);
	const removed = removeModelEntries(cfg.models ?? [], removeIds);
	const merged = mergeModelAdditions(removed.models, additionsWithRequiredApi(cfg, api, additions));
	if (merged.addedIds.length === 0 && removed.removedIds.length === 0) {
		return { added: [], removed: [] };
	}
	// Removing the last model must not lose the protocol that only the model
	// entries carried.
	const preservedApi = merged.models.length === 0 && !cfg.api ? api : undefined;
	writeModelsFile(
		upsertProvider(fresh, providerId, {
			...cfg,
			...(preservedApi ? { api: preservedApi } : {}),
			models: merged.models,
		}),
	);
	await refreshRegistry(env.ctx, providerId);
	return { added: merged.addedIds, removed: removed.removedIds };
}

function changesNotice(providerId: string, result: ModelChanges | Notice): Notice | undefined {
	if ("text" in result) return result;
	const parts: string[] = [];
	if (result.added.length) parts.push(`added ${result.added.length}`);
	if (result.removed.length) parts.push(`removed ${result.removed.length}`);
	if (parts.length === 0) return { text: `${providerId} already matches the selection`, tone: "muted" };
	const text = parts.join(", ");
	return { text: `${text.charAt(0).toUpperCase()}${text.slice(1)} model(s) on ${providerId}`, tone: "success" };
}

/** Confirm page for a model diff. Resolves true to write, false to go back. */
async function confirmModelDiff(
	env: Env,
	providerId: string,
	added: string[],
	removed: string[],
	unchanged: number,
): Promise<boolean> {
	const notes: MenuNote[] = [
		...idLines("+", added),
		...idLines("-", removed),
		{ text: "" },
		{
			text: `${added.length} added · ${removed.length} removed · ${unchanged} unchanged · ${getModelsPath()}`,
			tone: "dim",
		},
		...jsoncNotes(),
	];
	const choice = await rowMenu(env.ctx, {
		title: `Update models for "${providerId}"?`,
		notes,
		entries: [
			{ id: "save", label: removed.length && !added.length ? "Remove models" : "Save changes", kind: removed.length && !added.length ? "danger" : "action" },
			{ id: "back", label: "Back to the list" },
		],
	});
	return choice?.id === "save";
}

/**
 * One list for a provider's models: configured ones start checked, models the
 * relay lists but the provider lacks start unchecked (`new`), and configured
 * models the relay no longer lists are marked. Toggling builds a diff that is
 * confirmed and written in one go.
 */
export async function manageModels(env: Env, providerId: string): Promise<Notice | undefined> {
	const { ctx } = env;
	const data = readModelsFile();
	const cfg = data.providers?.[providerId];
	if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
	const api = inferProviderApi(cfg);
	const configured = uniqueModelIds(cfg.models);
	const canDiscover = Boolean(cfg.baseUrl && api);
	if (!canDiscover && configured.length === 0) {
		return { text: `${providerId} needs a base URL and protocol before models can be added`, tone: "warning" };
	}

	const notes: string[] = [];
	let listed: Array<{ id: string; name?: string }> = [];
	let relayListed = false;
	if (canDiscover) {
		// models.json may have changed since the registry was last loaded; the
		// effective model list decides what counts as new.
		await refreshRegistry(ctx, providerId);
		const result = await withSpinner(ctx, `Listing models from ${shortUrl(cfg.baseUrl)}…`, async (signal) => {
			const auth = await resolveProviderAuth(ctx, providerId, cfg);
			return listOpenAIModels({ baseUrl: cfg.baseUrl!, apiKey: auth.apiKey, headers: auth.headers, signal });
		}).catch((err: unknown) => ({ models: [], tried: [], error: errorText(err) }));
		if (result === undefined) return undefined; // Esc on the spinner
		listed = result.models;
		relayListed = listed.length > 0;
		notes.push(
			relayListed
				? `${listed.length} model(s) listed by the relay`
				: `Couldn't list relay models (${result.error ?? "empty response"}) — showing configured models only`,
		);
	} else {
		notes.push("No protocol set — configured models can be removed, not discovered");
	}

	const catalog = officialCatalog(ctx, data);
	const relayIds = new Set(listed.map((m) => m.id));
	const candidates = findNewRelayModels(modelsKnownToProvider(ctx, providerId, cfg), listed);
	const byId = new Map((cfg.models ?? []).map((m) => [m.id, m]));

	const items: CheckboxItem[] = [
		...configured.map((id) => {
			const entry = byId.get(id)!;
			const name = entry.name && entry.name !== id ? `${entry.name} · ` : "";
			const gone = relayListed && !relayIds.has(id) ? " · not listed by relay" : "";
			return { id, label: id, detail: `${name}${modelMeta(entry)}${gone}`, checked: true };
		}),
		...candidates.map((m) => {
			const enriched = enrichModelEntry(catalog, m.id, api, m.name);
			const source = enriched.status === "matched" ? "" : " · no catalog match";
			return {
				id: m.id,
				label: m.id,
				detail: `new · ${modelMeta(enriched.entry)}${source}`,
				description: enriched.matched ? `metadata from ${enriched.matched}` : "metadata: defaults (128k context)",
				checked: false,
			};
		}),
	];
	while (true) {
		const picked = await checkboxSelect(ctx, `Models: ${providerId}`, items, {
			notes,
			status: (selected) => {
				const added = candidates.filter((m) => selected.has(m.id)).length;
				const removed = configured.filter((id) => !selected.has(id)).length;
				return `${selected.size} checked · +${added} new · −${removed} removed`;
			},
		});
		if (picked === undefined) return undefined;
		const pickedSet = new Set(picked);
		const added = candidates.filter((m) => pickedSet.has(m.id));
		const removed = configured.filter((id) => !pickedSet.has(id));
		if (added.length === 0 && removed.length === 0) return undefined;

		if (!(await confirmModelDiff(env, providerId, added.map((m) => m.id), removed, configured.length - removed.length))) {
			// Back to the list with the same selection.
			for (const item of items) item.checked = pickedSet.has(item.id);
			continue;
		}
		const { entries } = enrichModels(catalog, added, api);
		return changesNotice(providerId, await writeModelChanges(env, providerId, entries, removed));
	}
}

/** Type model ids the relay doesn't list (or when it has no catalog endpoint). */
export async function addModelIdsManually(env: Env, providerId: string): Promise<Notice | undefined> {
	const { ctx } = env;
	let text = "";
	let error = "";
	while (true) {
		const data = readModelsFile();
		const cfg = data.providers?.[providerId];
		if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
		const edited = await loopEditor(
			ctx,
			`Model ids to add to ${providerId} — one per line or comma-separated (Esc = back)${error ? `\n✗ ${error}` : ""}`,
			text,
		);
		if (edited === undefined) return undefined;
		text = edited;
		const configured = new Set(uniqueModelIds(cfg.models));
		const ids = parseModelIds(edited).filter((id) => !configured.has(id));
		if (ids.length === 0) {
			error = parseModelIds(edited).length ? "All of these are already configured" : "Enter at least one model id";
			continue;
		}
		if (!(await confirmModelDiff(env, providerId, ids, [], configured.size))) {
			error = "";
			continue;
		}
		const { entries } = enrichModels(
			officialCatalog(ctx, data),
			ids.map((id) => ({ id })),
			inferProviderApi(cfg),
		);
		return changesNotice(providerId, await writeModelChanges(env, providerId, entries, []));
	}
}

/**
 * Re-enrich configured models against pi's live catalog. Only catalog-managed
 * fields change; ids, custom names and unknown keys are preserved. Shows a
 * field-level diff before writing.
 */
export async function syncMetadata(env: Env, providerId: string): Promise<Notice | undefined> {
	const { ctx } = env;
	const data = readModelsFile();
	const cfg = data.providers?.[providerId];
	if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
	if (!cfg.models?.length) return { text: `${providerId} has no configured models to sync`, tone: "muted" };

	const catalog = officialCatalog(ctx, data);
	if (catalog.length === 0) return { text: "pi model catalog unavailable — nothing to sync from", tone: "warning" };

	const api = inferProviderApi(cfg);
	const enrich = (id: string, name?: string) => {
		const r = enrichModelEntry(catalog, id, api, name);
		return r.status === "matched" ? r.entry : undefined;
	};
	const planned = refreshModelEntries(cfg.models, enrich);
	if (planned.changes.length === 0) {
		const unmatched = planned.unmatchedIds.length;
		return {
			text: unmatched
				? `${providerId} is up to date (${unmatched} model(s) have no catalog match)`
				: `${providerId} is up to date with pi's catalog`,
			tone: "muted",
		};
	}

	const lines = planned.changes.map(formatRefreshChange);
	const notes: MenuNote[] = [
		...lines.slice(0, 14).map((text) => ({ text, tone: "muted" as const })),
		...(lines.length > 14 ? [{ text: `…and ${lines.length - 14} more`, tone: "muted" as const }] : []),
		{ text: "" },
		{
			text: `${planned.changes.length} change(s) across ${new Set(planned.changes.map((c) => c.id)).size} model(s) · ${planned.unmatchedIds.length} without a catalog match (kept as-is)`,
			tone: "dim",
		},
		...jsoncNotes(),
	];
	const choice = await rowMenu(ctx, {
		title: `Sync metadata for "${providerId}" from pi's catalog?`,
		notes,
		entries: [
			{ id: "apply", label: "Apply changes", kind: "action" },
			{ id: "back", label: "Back" },
		],
	});
	if (choice?.id !== "apply") return undefined;

	// Re-read so unrelated edits made while the dialog was open survive.
	const fresh = readModelsFile();
	const freshCfg = fresh.providers?.[providerId];
	if (!freshCfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
	const merged = refreshModelEntries(freshCfg.models ?? [], enrich);
	if (merged.changes.length === 0) return { text: `${providerId} is already up to date`, tone: "muted" };
	writeModelsFile(upsertProvider(fresh, providerId, { ...freshCfg, models: merged.models }));
	await refreshRegistry(ctx, providerId);
	return { text: `Synced ${merged.changes.length} field(s) on ${providerId}`, tone: "success" };
}
