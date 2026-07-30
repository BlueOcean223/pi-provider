import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ChecksPanel, type CheckResult, type PanelCheck } from "./checks-panel.ts";

// DynamicBorder and keyHint() read pi's global theme; the panel's own colouring
// goes through the injected theme, so a pass-through stub keeps the rendered
// output assertable.
initTheme();
const stubTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const stubTui = { requestRender() {} } as unknown as TUI;

interface Controllable {
	check: PanelCheck;
	settle: (result: CheckResult) => void;
}

/** A check that stays in flight until settle() is called. */
function controllable(label: string, started: string[]): Controllable {
	let settle!: (result: CheckResult) => void;
	const check: PanelCheck = {
		label,
		run: () => {
			started.push(label);
			return new Promise<CheckResult>((resolve) => {
				settle = resolve;
			});
		},
	};
	return { check, settle: (result) => settle(result) };
}

/** Let the panel's .then() callbacks (and the pump they trigger) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ChecksPanel concurrency", () => {
	it("runs every check at once by default", () => {
		const started: string[] = [];
		const checks = ["a", "b", "c"].map((label) => controllable(label, started));
		const panel = new ChecksPanel(
			stubTui,
			stubTheme,
			{ title: "t", checks: checks.map((c) => c.check) },
			() => {},
		);

		assert.deepEqual(started, ["a", "b", "c"]);
		panel.dispose();
	});

	it("holds checks in a queue until a slot frees up", async () => {
		const started: string[] = [];
		const checks = ["a", "b", "c", "d"].map((label) => controllable(label, started));
		const panel = new ChecksPanel(
			stubTui,
			stubTheme,
			{ title: "t", checks: checks.map((c) => c.check), concurrency: 2 },
			() => {},
		);

		assert.deepEqual(started, ["a", "b"]);
		const queued = panel.render(80).join("\n");
		assert.ok(queued.includes("c — queued"), queued);
		assert.ok(queued.includes("d — queued"), queued);
		assert.ok(queued.includes("0/4 done"), queued);

		checks[0]!.settle({ ok: true, detail: "fine" });
		await flush();
		assert.deepEqual(started, ["a", "b", "c"]);

		checks[1]!.settle({ ok: false, detail: "broken" });
		checks[2]!.settle({ ok: true, detail: "fine" });
		await flush();
		assert.deepEqual(started, ["a", "b", "c", "d"]);

		checks[3]!.settle({ ok: true, detail: "fine" });
		await flush();

		const out = panel.render(80).join("\n");
		assert.ok(out.includes("✓ a — fine"), out);
		assert.ok(out.includes("✗ b — broken"), out);
		assert.ok(out.includes("✗ 1 of 4 check(s) failed"), out);
		assert.ok(!out.includes("queued"), out);
		panel.dispose();
	});

	it("does not start queued checks after the panel is closed", async () => {
		const started: string[] = [];
		const checks = ["a", "b", "c"].map((label) => controllable(label, started));
		let finished = 0;
		const panel = new ChecksPanel(
			stubTui,
			stubTheme,
			{ title: "t", checks: checks.map((c) => c.check), concurrency: 1 },
			() => finished++,
		);

		assert.deepEqual(started, ["a"]);
		panel.handleInput("\x1b"); // Esc closes the panel and aborts the run
		assert.equal(finished, 1);

		// A request that was already in flight can still land afterwards; it must
		// not pull the rest of the queue in behind it.
		checks[0]!.settle({ ok: true, detail: "late" });
		await flush();
		assert.deepEqual(started, ["a"]);
		panel.dispose();
	});

	it("does not start queued checks after the panel is disposed", async () => {
		const started: string[] = [];
		const checks = ["a", "b", "c"].map((label) => controllable(label, started));
		const panel = new ChecksPanel(
			stubTui,
			stubTheme,
			{ title: "t", checks: checks.map((c) => c.check), concurrency: 1 },
			() => {},
		);

		assert.deepEqual(started, ["a"]);
		panel.dispose();

		// Disposing aborts an in-flight request. If that request settles after
		// teardown, it must not use its newly-freed slot to start queued work.
		checks[0]!.settle({ ok: true, detail: "late" });
		await flush();
		assert.deepEqual(started, ["a"]);
	});

	it("fails the row (and frees the slot) when a check throws", async () => {
		const started: string[] = [];
		const next = controllable("next", started);
		const panel = new ChecksPanel(
			stubTui,
			stubTheme,
			{
				title: "t",
				checks: [
					{
						label: "throws",
						run: () => {
							throw new Error("boom");
						},
					},
					next.check,
				],
				concurrency: 1,
			},
			() => {},
		);

		await flush();
		assert.deepEqual(started, ["next"]);
		assert.ok(panel.render(80).join("\n").includes("✗ throws — boom"));
		panel.dispose();
	});

	it("skipped checks never occupy a slot", () => {
		const started: string[] = [];
		const runnable = controllable("runs", started);
		const panel = new ChecksPanel(
			stubTui,
			stubTheme,
			{
				title: "t",
				checks: [{ label: "skipped", skipReason: "no api" }, runnable.check],
				concurrency: 1,
			},
			() => {},
		);

		assert.deepEqual(started, ["runs"]);
		const out = panel.render(80).join("\n");
		assert.ok(out.includes("− skipped — skipped: no api"), out);
		assert.ok(!out.includes("0/1 done"), out); // single check: no progress counter
		panel.dispose();
	});
});
