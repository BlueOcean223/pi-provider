import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

/**
 * Live checklist panel for /provider test.
 *
 * Checks start immediately or wait for a configured concurrency slot; each row
 * shows queued/running state and settles to ✓ / ✗ in place. Esc aborts the
 * underlying requests. The panel is a ui.custom component, so closing it leaves
 * nothing behind in the chat log
 * (unlike the old notify("Probing…") + confirm("Probe result") flow).
 */

export interface CheckResult {
	ok: boolean;
	/** One-line outcome shown after the label. */
	detail: string;
	/** Indented context lines (URL, HTTP status). */
	sub?: string[];
}

export interface PanelCheck {
	label: string;
	/** Progress text shown while running, e.g. `sending "hi"`. */
	runningDetail?: string;
	/** Omit to render the check as skipped (with skipReason). */
	run?: (signal: AbortSignal) => Promise<CheckResult>;
	skipReason?: string;
}

export interface ChecksPanelOptions {
	title: string;
	subtitle?: string;
	/** Warning lines shown under the title (e.g. "env key not set"). */
	notes?: string[];
	checks: PanelCheck[];
	/**
	 * Max checks in flight at once (default: all of them). Testing every model of
	 * a relay would otherwise fire dozens of chat requests simultaneously, which
	 * relays answer with 429s that look like real failures.
	 */
	concurrency?: number;
}

type RowStatus = "queued" | "running" | "ok" | "fail" | "skip";

interface Row {
	status: RowStatus;
	result?: CheckResult;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Exported for tests; use runChecksPanel() to show it. */
export class ChecksPanel extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly checks: PanelCheck[];
	private readonly finish: () => void;
	private readonly concurrency: number;
	private readonly listContainer = new Container();
	private readonly statusText = new Text("", 1, 0);
	private rows: Row[] = [];
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private abort = new AbortController();
	private pending = 0;
	/** Indexes of checks waiting for a concurrency slot. */
	private queue: number[] = [];
	private active = 0;
	// Guards against results of an aborted run landing after "r" restarted it.
	private generation = 0;

	constructor(tui: TUI, theme: Theme, options: ChecksPanelOptions, finish: () => void) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.checks = options.checks;
		this.finish = finish;
		this.concurrency = Math.max(1, options.concurrency ?? Number.POSITIVE_INFINITY);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
		if (options.subtitle) this.addChild(new Text(theme.fg("muted", options.subtitle), 1, 0));
		if (options.notes?.length) {
			this.addChild(new Spacer(1));
			for (const note of options.notes) {
				this.addChild(new Text(theme.fg("warning", `⚠ ${note}`), 1, 0));
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.statusText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.start();
	}

	private get finished(): boolean {
		return this.pending === 0;
	}

	private start(): void {
		this.generation++;
		const gen = this.generation;
		this.abort = new AbortController();
		this.rows = this.checks.map((c): Row => ({ status: c.run ? "queued" : "skip" }));
		this.queue = this.checks.flatMap((c, i) => (c.run ? [i] : []));
		this.pending = this.queue.length;
		this.active = 0;
		this.pump(gen);

		if (!this.finished && this.timer === null) {
			this.timer = setInterval(() => {
				this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
				this.refresh();
			}, SPINNER_INTERVAL_MS);
		}
		this.refresh();
	}

	/** Start queued checks while a concurrency slot is free (all of them by default). */
	private pump(gen: number): void {
		if (gen !== this.generation) return;
		while (this.active < this.concurrency) {
			const index = this.queue.shift();
			if (index === undefined) return;
			const run = this.checks[index]!.run;
			if (!run) continue;
			this.active++;
			this.rows[index] = { status: "running" };
			const fail = (err: unknown) =>
				this.settle(gen, index, {
					status: "fail",
					result: { ok: false, detail: err instanceof Error ? err.message : String(err) },
				});
			// try/catch as well as a rejection handler: a check that throws
			// synchronously must fail its own row (and free its slot) rather than
			// escape as an unhandled rejection from the settle that started it.
			try {
				run(this.abort.signal).then(
					(result) => this.settle(gen, index, { status: result.ok ? "ok" : "fail", result }),
					fail,
				);
			} catch (err) {
				fail(err);
			}
		}
	}

	private settle(gen: number, index: number, row: Row): void {
		if (gen !== this.generation) return;
		this.rows[index] = row;
		this.pending--;
		this.active--;
		this.pump(gen);
		if (this.finished) this.stopTimer();
		this.refresh();
	}

	private stopTimer(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private refresh(): void {
		const t = this.theme;
		this.listContainer.clear();
		for (let i = 0; i < this.checks.length; i++) {
			const check = this.checks[i]!;
			const row = this.rows[i]!;
			this.listContainer.addChild(new Text(this.renderRow(check, row), 1, 0));
			for (const sub of row.result?.sub ?? []) {
				this.listContainer.addChild(new Text(t.fg("dim", `    ${sub}`), 1, 0));
			}
		}

		if (this.finished) {
			const failed = this.rows.filter((r) => r.status === "fail").length;
			const passed = this.rows.filter((r) => r.status === "ok").length;
			const summary =
				failed > 0
					? t.fg("error", `✗ ${failed} of ${passed + failed} check(s) failed`)
					: passed > 0
						? t.fg("success", "✓ All checks passed")
						: t.fg("dim", "Nothing to test");
			this.statusText.setText(
				`${summary}\n${rawKeyHint("enter/esc", "close")}  ${rawKeyHint("r", "run again")}`,
			);
		} else {
			// Progress matters once a run covers more than a check or two (e.g.
			// every model of a relay), and the queue makes "done" ≠ "started".
			const total = this.rows.filter((r) => r.status !== "skip").length;
			const done = this.rows.filter((r) => r.status === "ok" || r.status === "fail").length;
			const progress = total > 1 ? `${t.fg("muted", `${done}/${total} done`)}  ` : "";
			this.statusText.setText(`${progress}${keyHint("tui.select.cancel", "cancel")}`);
		}
		this.tui.requestRender();
	}

	private renderRow(check: PanelCheck, row: Row): string {
		const t = this.theme;
		switch (row.status) {
			case "queued":
				return t.fg("dim", `○ ${check.label} — queued`);
			case "running": {
				const spin = t.fg("accent", SPINNER_FRAMES[this.frame]!);
				const doing = check.runningDetail ? ` — ${check.runningDetail}` : "";
				return `${spin} ${t.fg("text", check.label)}${t.fg("muted", `${doing}…`)}`;
			}
			case "ok":
				return `${t.fg("success", "✓")} ${t.fg("text", check.label)}${
					row.result?.detail ? t.fg("muted", ` — ${row.result.detail}`) : ""
				}`;
			case "fail":
				return `${t.fg("error", "✗")} ${t.fg("text", check.label)}${
					row.result?.detail ? ` — ${t.fg("error", row.result.detail)}` : ""
				}`;
			case "skip":
				return t.fg("dim", `− ${check.label} — skipped${check.skipReason ? `: ${check.skipReason}` : ""}`);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (!this.finished) return;
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.close();
		} else if (keyData === "r" || keyData === "R") {
			this.start();
		}
	}

	private cancelRun(): void {
		// Invalidate callbacks before aborting: abort-triggered rejections settle
		// asynchronously and must not start queued work after teardown.
		this.generation++;
		this.queue = [];
		this.abort.abort();
		this.stopTimer();
	}

	private close(): void {
		this.cancelRun();
		this.finish();
	}

	dispose(): void {
		this.cancelRun();
	}
}

/**
 * Run checks in a live panel (TUI) and return once the user closes it.
 * In non-TUI modes, checks run sequentially and report via a single notify.
 */
export async function runChecksPanel(
	ctx: ExtensionCommandContext,
	options: ChecksPanelOptions,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const lines: string[] = [...(options.notes ?? [])];
		let failed = 0;
		for (const check of options.checks) {
			if (!check.run) {
				lines.push(`${check.label}: skipped${check.skipReason ? ` — ${check.skipReason}` : ""}`);
				continue;
			}
			const result = await check.run(new AbortController().signal).catch(
				(err: unknown): CheckResult => ({
					ok: false,
					detail: err instanceof Error ? err.message : String(err),
				}),
			);
			if (!result.ok) failed++;
			lines.push(`${check.label}: ${result.ok ? "OK" : "FAILED"} — ${result.detail}`);
			for (const sub of result.sub ?? []) lines.push(`  ${sub}`);
		}
		ctx.ui.notify([options.title, ...lines].join("\n"), failed > 0 ? "warning" : "info");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => new ChecksPanel(tui, theme, options, () => done()));
}
