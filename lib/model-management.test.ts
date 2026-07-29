import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	findNewRelayModels,
	formatRefreshChange,
	mergeModelAdditions,
	refreshModelEntries,
	removeModelEntries,
} from "./model-management.ts";
import type { ModelEntry } from "./types.ts";

describe("findNewRelayModels", () => {
	it("returns only new relay ids and collapses relay duplicates", () => {
		const existing: ModelEntry[] = [{ id: "model-a" }];
		const listed = [
			{ id: "model-a" },
			{ id: "model-b", name: "Model B" },
			{ id: "model-b", name: "Duplicate B" },
			{ id: "model-c" },
		];

		assert.deepEqual(findNewRelayModels(existing, listed), [
			{ id: "model-b", name: "Model B" },
			{ id: "model-c" },
		]);
	});

	it("compares ids exactly", () => {
		assert.deepEqual(findNewRelayModels([{ id: "Model-A" }], [{ id: "model-a" }]), [
			{ id: "model-a" },
		]);
	});
});

describe("mergeModelAdditions", () => {
	it("preserves existing metadata and appends only new entries", () => {
		const existing: ModelEntry[] = [
			{
				id: "model-a",
				contextWindow: 42,
				compat: { custom: true },
			},
		];
		const additions: ModelEntry[] = [
			{ id: "model-a", contextWindow: 128_000 },
			{ id: "model-b", contextWindow: 200_000 },
			{ id: "model-b", contextWindow: 1 },
		];

		const result = mergeModelAdditions(existing, additions);
		assert.deepEqual(result.models, [existing[0], additions[1]]);
		assert.deepEqual(result.addedIds, ["model-b"]);
		assert.deepEqual(result.skippedIds, ["model-a", "model-b"]);
	});

	it("does not mutate either input array", () => {
		const existing: ModelEntry[] = [{ id: "model-a" }];
		const additions: ModelEntry[] = [{ id: "model-b" }];
		const existingSnapshot = structuredClone(existing);
		const additionsSnapshot = structuredClone(additions);

		mergeModelAdditions(existing, additions);

		assert.deepEqual(existing, existingSnapshot);
		assert.deepEqual(additions, additionsSnapshot);
	});
});

describe("removeModelEntries", () => {
	it("removes selected ids and preserves all other entries", () => {
		const existing: ModelEntry[] = [
			{ id: "model-a", contextWindow: 42 },
			{ id: "model-b", compat: { custom: true } },
			{ id: "model-c" },
		];

		const result = removeModelEntries(existing, ["model-b", "missing-model"]);

		assert.deepEqual(result.models, [existing[0], existing[2]]);
		assert.deepEqual(result.removedIds, ["model-b"]);
		assert.deepEqual(result.missingIds, ["missing-model"]);
	});

	it("removes duplicate entries with the selected id", () => {
		const result = removeModelEntries(
			[{ id: "model-a" }, { id: "model-a" }, { id: "model-b" }],
			["model-a"],
		);

		assert.deepEqual(result.models, [{ id: "model-b" }]);
		assert.deepEqual(result.removedIds, ["model-a"]);
	});
});

describe("refreshModelEntries", () => {
	const catalog: Record<string, ModelEntry> = {
		"claude-opus-4-6": {
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			thinkingLevelMap: { max: "max" },
			compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
		},
	};
	const enrich = (id: string, name?: string) =>
		catalog[id] ? { ...catalog[id], ...(name ? { name } : {}) } : undefined;

	it("adds missing compat and metadata to a stale entry", () => {
		const existing: ModelEntry[] = [
			{
				id: "claude-opus-4-6",
				name: "Claude Opus 4.6",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				thinkingLevelMap: { max: "max" },
			},
		];

		const result = refreshModelEntries(existing, enrich);

		assert.deepEqual(result.models[0].compat, {
			forceAdaptiveThinking: true,
			supportsStrictTools: true,
		});
		assert.deepEqual(
			result.changes.map((c) => c.field),
			["compat"],
		);
		assert.deepEqual(result.unmatchedIds, []);
	});

	it("preserves id, custom name, api and unknown keys", () => {
		const existing: ModelEntry[] = [
			{
				id: "claude-opus-4-6",
				name: "My Renamed Opus",
				api: "anthropic-messages",
				customFlag: { keep: true },
				contextWindow: 128_000,
			},
		];

		const result = refreshModelEntries(existing, enrich);
		const next = result.models[0];

		assert.equal(next.id, "claude-opus-4-6");
		assert.equal(next.name, "My Renamed Opus");
		assert.equal(next.api, "anthropic-messages");
		assert.deepEqual(next.customFlag, { keep: true });
		assert.equal(next.contextWindow, 1_000_000);
	});

	it("drops fields the enriched entry no longer carries", () => {
		const existing: ModelEntry[] = [
			{ id: "claude-opus-4-6", compat: { outdatedFlag: true } },
		];
		const noCompat = (id: string) =>
			id === "claude-opus-4-6" ? { id, reasoning: true } : undefined;

		const result = refreshModelEntries(existing, noCompat);

		assert.ok(!("compat" in result.models[0]));
		assert.deepEqual(
			result.changes.map((c) => `${c.field}:${c.from === undefined ? "add" : c.to === undefined ? "del" : "set"}`),
			["reasoning:add", "compat:del"],
		);
	});

	it("leaves unmatched models untouched and reports them", () => {
		const existing: ModelEntry[] = [
			{ id: "custom-local-model", contextWindow: 32_000 },
		];

		const result = refreshModelEntries(existing, () => undefined);

		assert.deepEqual(result.models, existing);
		assert.deepEqual(result.changes, []);
		assert.deepEqual(result.unmatchedIds, ["custom-local-model"]);
	});

	it("reports no changes when metadata already matches", () => {
		const existing: ModelEntry[] = [
			{
				id: "claude-opus-4-6",
				name: "Claude Opus 4.6",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				thinkingLevelMap: { max: "max" },
				compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
			},
		];

		const result = refreshModelEntries(existing, enrich);

		assert.deepEqual(result.changes, []);
		assert.deepEqual(result.models, existing);
	});

	it("does not mutate the input entries", () => {
		const existing: ModelEntry[] = [{ id: "claude-opus-4-6", contextWindow: 128_000 }];
		const snapshot = structuredClone(existing);

		refreshModelEntries(existing, enrich);

		assert.deepEqual(existing, snapshot);
	});
});

describe("formatRefreshChange", () => {
	it("renders field transitions with em-dash for absent values", () => {
		assert.equal(
			formatRefreshChange({ id: "m", field: "compat", from: undefined, to: { a: 1 } }),
			'm: compat — → {"a":1}',
		);
		assert.equal(
			formatRefreshChange({ id: "m", field: "maxTokens", from: 16384, to: 128000 }),
			"m: maxTokens 16384 → 128000",
		);
	});
});
