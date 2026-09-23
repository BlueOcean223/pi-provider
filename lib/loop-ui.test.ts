import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { loopEditor, loopInput, runWizard, type StepOutcome, type WizardStep } from "./loop-ui.ts";

// ExtensionEditorComponent reads pi's global theme when it is constructed.
initTheme("dark");

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

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ENTER = "\r";

/** Opens loopEditor in a stubbed TUI; returns a key sender and the submitted text. */
function openEditor(prefill: string) {
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	const tui = { requestRender() {}, stop() {}, start() {}, terminal: { rows: 40, columns: 80 } };
	// Only the app-level Ctrl+G binding goes through this manager.
	const kb = { matches: () => false };
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: (...args: unknown[]) => typeof component) =>
				new Promise((resolve) => {
					component = factory(tui, undefined, kb, resolve);
				}),
		},
	} as unknown as ExtensionCommandContext;
	const result = loopEditor(ctx, "title", prefill);
	component!.render(80);
	return {
		press: (...keys: string[]) => {
			for (const key of keys) component!.handleInput(key);
		},
		result,
	};
}

describe("loopEditor wrap-around", () => {
	it("↓ on the last line wraps to the first, ↑ on the first wraps to the last", async () => {
		const ed = openEditor("aaaa\nbb\ncccccc"); // cursor at the end of "cccccc"
		ed.press(DOWN, "Z", UP, "Y", ENTER);
		assert.equal(await ed.result, "aaaaZ\nbb\ncccccYc");
	});

	it("wrapping onto a paste marker lands on its start, keeping the pasted text", async () => {
		const pasted = Array.from({ length: 20 }, (_, i) => `model-${i}`).join("\n");
		const ed = openEditor("0123456789abcdef\nkeep ");
		ed.press(`\x1b[200~${pasted}\x1b[201~`); // collapses to "[paste #1 +20 lines]"
		// Line 0, column 12: past the marker's start column on line 1.
		ed.press(UP, LEFT, LEFT, LEFT, LEFT);
		ed.press(UP, "Z", ENTER);
		assert.equal(await ed.result, `0123456789abcdef\nkeep Z${pasted}`);
	});

	it("↓ inside a soft-wrapped last line moves down a row instead of wrapping", async () => {
		const long = "x".repeat(150); // two visual rows at width 80
		const ed = openEditor(`short\n${long}`); // cursor on the second row
		ed.press(UP, DOWN, "Z", ENTER);
		assert.equal(await ed.result, `short\n${long}Z`);
	});
});

/** Opens loopInput in a stubbed TUI. */
function openInput(opts: Parameters<typeof loopInput>[2]) {
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	const tui = { requestRender() {} };
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: (...args: unknown[]) => typeof component) =>
				new Promise((resolve) => {
					component = factory(tui, theme, undefined, resolve);
				}),
		},
	} as unknown as ExtensionCommandContext;
	const result = loopInput(ctx, "Base URL", opts);
	return {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
		text: () => component!.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, ""),
		press: (...keys: string[]) => {
			for (const key of keys) component!.handleInput(key);
		},
		result,
	};
}

describe("loopInput", () => {
	it("prefills the initial value and submits edits to it", async () => {
		const input = openInput({ initial: "https://a.test" });
		assert.ok(input.text().includes("https://a.test"));
		input.press("/", "v", "1", ENTER);
		assert.equal(await input.result, "https://a.test/v1");
	});

	it("shows the placeholder only while empty", () => {
		const input = openInput({ placeholder: "https://api.example.com/v1" });
		assert.ok(input.text().includes("https://api.example.com/v1"));
		input.press("x");
		assert.ok(!input.text().includes("api.example.com"));
	});

	it("keeps the dialog open with an inline error when validation fails", async () => {
		const input = openInput({ validate: (v) => (v ? undefined : "Base URL is required") });
		input.press(ENTER);
		assert.ok(input.text().includes("✗ Base URL is required"), input.text());
		input.press("h");
		assert.ok(!input.text().includes("✗"), "typing clears the error");
		input.press(ENTER);
		assert.equal(await input.result, "h");
	});

	it("outside the TUI, an empty answer keeps the initial value", async () => {
		const ctx = {
			mode: "rpc",
			ui: { input: async () => "", notify: () => {} },
		} as unknown as ExtensionCommandContext;
		assert.equal(await loopInput(ctx, "t", { initial: "keep-me" }), "keep-me");
	});
});
