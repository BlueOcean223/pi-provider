import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWizard, type StepOutcome, type WizardStep } from "./loop-ui.ts";

/** Step that replays scripted outcomes and records each visit in `visits`. */
function step(name: string, visits: string[], outcomes: StepOutcome[], skip?: () => boolean): WizardStep {
	let i = 0;
	return {
		skip,
		run: async () => {
			visits.push(name);
			return outcomes[Math.min(i++, outcomes.length - 1)]!;
		},
	};
}

describe("runWizard", () => {
	it("runs steps in order and returns true on completion", async () => {
		const visits: string[] = [];
		const done = await runWizard([step("a", visits, ["next"]), step("b", visits, ["next"])]);
		assert.equal(done, true);
		assert.deepEqual(visits, ["a", "b"]);
	});

	it("returns false when backing out of the first step", async () => {
		const visits: string[] = [];
		const done = await runWizard([step("a", visits, ["back"]), step("b", visits, ["next"])]);
		assert.equal(done, false);
		assert.deepEqual(visits, ["a"]);
	});

	it("returns false on abort", async () => {
		const visits: string[] = [];
		const done = await runWizard([step("a", visits, ["next"]), step("b", visits, ["abort"])]);
		assert.equal(done, false);
		assert.deepEqual(visits, ["a", "b"]);
	});

	it("back revisits the previous step", async () => {
		const visits: string[] = [];
		const done = await runWizard([
			step("a", visits, ["next", "next"]),
			step("b", visits, ["back", "next"]),
		]);
		assert.equal(done, true);
		assert.deepEqual(visits, ["a", "b", "a", "b"]);
	});

	it("stay re-runs the same step", async () => {
		const visits: string[] = [];
		const done = await runWizard([step("a", visits, ["stay", "stay", "next"])]);
		assert.equal(done, true);
		assert.deepEqual(visits, ["a", "a", "a"]);
	});

	it("skips skipped steps in both directions", async () => {
		const visits: string[] = [];
		const done = await runWizard([
			step("a", visits, ["next", "next"]),
			step("skipped", visits, ["next"], () => true),
			step("c", visits, ["back", "next"]),
		]);
		assert.equal(done, true);
		// back from c must land on a, not on the skipped step
		assert.deepEqual(visits, ["a", "c", "a", "c"]);
	});

	it("returns false when back skips through to before the first step", async () => {
		const visits: string[] = [];
		const done = await runWizard([
			step("skipped", visits, ["next"], () => true),
			step("b", visits, ["back"]),
		]);
		assert.equal(done, false);
		assert.deepEqual(visits, ["b"]);
	});

	it("re-evaluates skip() each pass (dynamic skips)", async () => {
		const visits: string[] = [];
		let skipB = true;
		const done = await runWizard([
			{
				run: async () => {
					visits.push("a");
					skipB = visits.filter((v) => v === "a").length === 1;
					return "next";
				},
			},
			step("b", visits, ["next"], () => skipB),
			step("c", visits, ["back", "next", "next"]),
		]);
		assert.equal(done, true);
		// pass 1: a, (b skipped), c → back → a; pass 2: a, b, c
		assert.deepEqual(visits, ["a", "c", "a", "b", "c"]);
	});
});
