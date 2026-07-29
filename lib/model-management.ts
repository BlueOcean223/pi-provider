import type { ModelEntry } from "./types.ts";

export interface RelayModelInfo {
	id: string;
	name?: string;
}

/**
 * Return relay models that are not configured locally yet.
 *
 * Model ids are compared exactly because the id is sent back to the relay and
 * may be case-sensitive. Duplicate ids from the relay catalog are collapsed
 * while preserving the first occurrence and its display name.
 */
export function findNewRelayModels(
	existing: ModelEntry[],
	listed: RelayModelInfo[],
): RelayModelInfo[] {
	const seen = new Set(existing.map((model) => model.id));
	const additions: RelayModelInfo[] = [];
	for (const model of listed) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		additions.push(model);
	}
	return additions;
}

export interface MergeModelAdditionsResult {
	models: ModelEntry[];
	addedIds: string[];
	skippedIds: string[];
}

/**
 * Add model entries without modifying existing entries or their metadata.
 * Duplicate additions are skipped and the original model order is retained.
 */
export function mergeModelAdditions(
	existing: ModelEntry[],
	additions: ModelEntry[],
): MergeModelAdditionsResult {
	const seen = new Set(existing.map((model) => model.id));
	const models = [...existing];
	const addedIds: string[] = [];
	const skippedIds: string[] = [];

	for (const model of additions) {
		if (seen.has(model.id)) {
			skippedIds.push(model.id);
			continue;
		}
		seen.add(model.id);
		models.push(model);
		addedIds.push(model.id);
	}

	return { models, addedIds, skippedIds };
}

export interface RemoveModelEntriesResult {
	models: ModelEntry[];
	removedIds: string[];
	missingIds: string[];
}

/** Remove explicitly selected model ids while preserving all other entries and order. */
export function removeModelEntries(
	existing: ModelEntry[],
	selectedIds: Iterable<string>,
): RemoveModelEntriesResult {
	const targets = new Set(selectedIds);
	const removed = new Set<string>();
	const models = existing.filter((model) => {
		if (!targets.has(model.id)) return true;
		removed.add(model.id);
		return false;
	});

	return {
		models,
		removedIds: Array.from(removed),
		missingIds: Array.from(targets).filter((id) => !removed.has(id)),
	};
}

/** Fields refreshModelEntries may update; id/name/api and unknown keys are preserved. */
const REFRESHABLE_FIELDS = [
	"reasoning",
	"thinkingLevelMap",
	"input",
	"contextWindow",
	"maxTokens",
	"cost",
	"compat",
] as const;

export interface ModelRefreshChange {
	id: string;
	field: string;
	from: unknown;
	to: unknown;
}

export interface RefreshModelEntriesResult {
	models: ModelEntry[];
	changes: ModelRefreshChange[];
	/** Configured ids with no official-catalog match (left untouched). */
	unmatchedIds: string[];
}

function summarizeValue(value: unknown): string {
	if (value === undefined) return "—";
	const json = JSON.stringify(value);
	return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

/** One-line human description of a refresh change for confirmations. */
export function formatRefreshChange(change: ModelRefreshChange): string {
	return `${change.id}: ${change.field} ${summarizeValue(change.from)} → ${summarizeValue(change.to)}`;
}

/**
 * Re-enrich configured models against the official catalog, updating only
 * refreshable metadata fields (see REFRESHABLE_FIELDS). Id, name, api and any
 * unknown/custom keys are preserved, so hand-tuned fields the refresher does
 * not know about survive. Fields equal in both entries are left alone, and a
 * field the enriched entry no longer carries (e.g. compat disappeared
 * upstream) is removed from the configured entry so stale flags do not linger.
 */
export function refreshModelEntries(
	existing: ModelEntry[],
	enrich: (id: string, name?: string) => ModelEntry | undefined,
): RefreshModelEntriesResult {
	const models: ModelEntry[] = [];
	const changes: ModelRefreshChange[] = [];
	const unmatchedIds: string[] = [];

	for (const model of existing) {
		const enriched = enrich(model.id, typeof model.name === "string" ? model.name : undefined);
		if (!enriched) {
			unmatchedIds.push(model.id);
			models.push(model);
			continue;
		}

		const next: ModelEntry = { ...model };
		for (const field of REFRESHABLE_FIELDS) {
			const from = model[field];
			const to = enriched[field];
			if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;
			changes.push({ id: model.id, field, from, to });
			if (to === undefined) delete next[field];
			else next[field] = to;
		}
		models.push(next);
	}

	return { models, changes, unmatchedIds };
}
