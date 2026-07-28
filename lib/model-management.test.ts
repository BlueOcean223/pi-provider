import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	findNewRelayModels,
	mergeModelAdditions,
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
