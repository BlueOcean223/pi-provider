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
