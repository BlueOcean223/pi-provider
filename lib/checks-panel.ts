import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

/**
 * Live checklist panel for provider tests.
 *
 * Checks start immediately or wait for a configured concurrency slot; each row
 * shows queued/running state and settles to ✓ / ✗ in place, with the latency
 * of passing rows. Esc aborts the underlying requests. The panel is a
 * ui.custom component, so closing it leaves nothing behind in the chat log.
 *
 * Once a run finishes the panel can hand control back with a decision:
 * - `pickLabel` puts a cursor on passing rows that carry an id; Enter picks one
 *   (e.g. "use model")
 * - `actions` are extra keys offered when their condition holds (e.g. remove
 *   the failed models, apply a suggested compat fix)
 */

export interface CheckResult {
	ok: boolean;
	/** One-line outcome shown after the label. */
	detail: string;
	/** Indented context lines (URL, HTTP status). */
	sub?: string[];
	/** Warning line under the row, e.g. a suggested fix for the failure. */
	hint?: string;
	/** Caller payload carried into the summary (not rendered). */
	data?: unknown;
}

export interface PanelCheck {
	/**
	 * Stable id (e.g. the model id). Checks with an id are reported in the
	 * summary and can be picked after passing.
	 */
	id?: string;
	label: string;
	/** Progress text shown while running, e.g. `sending "hi"`. */
	runningDetail?: string;
	/** Omit to render the check as skipped (with skipReason). */
	run?: (signal: AbortSignal) => Promise<CheckResult>;
	skipReason?: string;
}

export interface PanelSummary {
	/** False when the panel was closed mid-run. */
	finished: boolean;
	/** Ids of passing / failing checks (checks without an id are counted only). */
	passed: string[];
	failed: string[];
	/** Results of settled checks that have an id. */
	results: Map<string, CheckResult>;
	/** Wall-clock duration of passing checks that have an id, in ms. */
	latency: Map<string, number>;
	passedCount: number;
	failedCount: number;
}

export interface PanelAction {
	key: string;
	label: string | ((summary: PanelSummary) => string);
	/** Offered only when this returns true for the finished run. */
	available: (summary: PanelSummary) => boolean;
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
	/** Enables picking a passing row with Enter; the label names what Enter does. */
	pickLabel?: string;
	actions?: PanelAction[];
	/** Passing rows slower than this show their latency in the warning colour. */
	slowMs?: number;
}

export type ChecksPanelOutcome =
	| { kind: "closed"; summary: PanelSummary }
	| { kind: "picked"; id: string; summary: PanelSummary }
	| { kind: "action"; key: string; summary: PanelSummary };

type RowStatus = "queued" | "running" | "ok" | "fail" | "skip";

interface Row {
	status: RowStatus;
	result?: CheckResult;
	startedAt?: number;
	ms?: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
/** cc-switch treats a check slower than 6s as degraded; same threshold here. */
const DEFAULT_SLOW_MS = 6000;

export function formatLatency(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Exported for tests; use runChecksPanel() to show it. */
export class ChecksPanel extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: ChecksPanelOptions;
	private readonly checks: PanelCheck[];
	private readonly finish: (outcome: ChecksPanelOutcome) => void;
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
	/** Index of the picked row once the run finished (pick mode only). */
	private cursor = -1;

	constructor(
		tui: TUI,
		theme: Theme,
		options: ChecksPanelOptions,
		finish: (outcome: ChecksPanelOutcome) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.options = options;
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
		this.cursor = -1;
		this.pump(gen);

		if (!this.finished && this.timer === null) {
			this.timer = setInterval(() => {
				this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
				this.refresh();
			}, SPINNER_INTERVAL_MS);
		}
		if (this.finished) this.placeCursor();
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
			this.rows[index] = { status: "running", startedAt: Date.now() };
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
		const startedAt = this.rows[index]?.startedAt;
		this.rows[index] = { ...row, ms: startedAt === undefined ? undefined : Date.now() - startedAt };
		this.pending--;
		this.active--;
		this.pump(gen);
		if (this.finished) {
			this.stopTimer();
			this.placeCursor();
		}
		this.refresh();
	}

	private stopTimer(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private isPickable(index: number): boolean {
		return Boolean(this.options.pickLabel && this.checks[index]?.id && this.rows[index]?.status === "ok");
	}

	private placeCursor(): void {
		this.cursor = this.rows.findIndex((_row, i) => this.isPickable(i));
	}

	private moveCursor(direction: 1 | -1): void {
		if (this.cursor < 0) return;
		const count = this.rows.length;
		let next = this.cursor;
		for (let step = 0; step < count; step++) {
			next = (next + direction + count) % count;
			if (this.isPickable(next)) break;
		}
		this.cursor = next;
		this.refresh();
	}

	summary(): PanelSummary {
		const passed: string[] = [];
		const failed: string[] = [];
		const results = new Map<string, CheckResult>();
		const latency = new Map<string, number>();
		let passedCount = 0;
		let failedCount = 0;
		this.rows.forEach((row, i) => {
			const id = this.checks[i]?.id;
			if (row.status === "ok") passedCount++;
			if (row.status === "fail") failedCount++;
			if (!id) return;
			if (row.result) results.set(id, row.result);
			if (row.status === "ok") {
				passed.push(id);
				if (row.ms !== undefined) latency.set(id, row.ms);
			} else if (row.status === "fail") {
				failed.push(id);
			}
		});
		return { finished: this.finished, passed, failed, results, latency, passedCount, failedCount };
	}

	private availableActions(summary: PanelSummary): PanelAction[] {
		return (this.options.actions ?? []).filter((action) => action.available(summary));
	}

	private refresh(): void {
		const t = this.theme;
		const picking = Boolean(this.options.pickLabel);
		this.listContainer.clear();
		for (let i = 0; i < this.checks.length; i++) {
			const check = this.checks[i]!;
			const row = this.rows[i]!;
			const prefix = picking ? (i === this.cursor ? t.fg("accent", "→ ") : "  ") : "";
			this.listContainer.addChild(new Text(`${prefix}${this.renderRow(check, row)}`, 1, 0));
			const indent = picking ? "      " : "    ";
			for (const sub of row.result?.sub ?? []) {
				this.listContainer.addChild(new Text(t.fg("dim", `${indent}${sub}`), 1, 0));
			}
			if (row.result?.hint && row.status === "fail") {
				this.listContainer.addChild(new Text(t.fg("warning", `${indent}↳ ${row.result.hint}`), 1, 0));
			}
		}

		if (this.finished) {
			const summary = this.summary();
			const { failedCount: failed, passedCount: passed } = summary;
			const verdict =
				failed > 0
					? t.fg("error", `✗ ${failed} of ${passed + failed} check(s) failed`)
					: passed > 0
						? t.fg("success", "✓ All checks passed")
						: t.fg("dim", "Nothing to test");
			const hints: string[] = [];
			if (this.cursor >= 0) {
				hints.push(rawKeyHint("↑↓", "choose"), keyHint("tui.select.confirm", this.options.pickLabel!));
			}
			for (const action of this.availableActions(summary)) {
				hints.push(
					rawKeyHint(action.key, typeof action.label === "function" ? action.label(summary) : action.label),
				);
			}
			hints.push(rawKeyHint("r", "run again"));
			hints.push(this.cursor >= 0 ? keyHint("tui.select.cancel", "close") : rawKeyHint("enter/esc", "close"));
			this.statusText.setText(`${verdict}\n${hints.join("  ")}`);
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
			case "ok": {
				const slow = row.ms !== undefined && row.ms >= (this.options.slowMs ?? DEFAULT_SLOW_MS);
				const latency = row.ms === undefined ? "" : t.fg(slow ? "warning" : "muted", ` · ${formatLatency(row.ms)}`);
				return `${t.fg("success", "✓")} ${t.fg("text", check.label)}${
					row.result?.detail ? t.fg("muted", ` — ${row.result.detail}`) : ""
				}${latency}`;
			}
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
			this.close({ kind: "closed", summary: this.summary() });
			return;
		}
		if (!this.finished) return;
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveCursor(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.moveCursor(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			const id = this.cursor >= 0 ? this.checks[this.cursor]?.id : undefined;
			const summary = this.summary();
			this.close(id ? { kind: "picked", id, summary } : { kind: "closed", summary });
			return;
		}
		if (keyData === "r" || keyData === "R") {
			this.start();
			return;
		}
		const summary = this.summary();
		const action = this.availableActions(summary).find((a) => a.key === keyData);
		if (action) this.close({ kind: "action", key: action.key, summary });
	}

	private cancelRun(): void {
		// Invalidate callbacks before aborting: abort-triggered rejections settle
		// asynchronously and must not start queued work after teardown.
		this.generation++;
		this.queue = [];
		this.abort.abort();
		this.stopTimer();
	}

	private close(outcome: ChecksPanelOutcome): void {
		this.cancelRun();
		this.finish(outcome);
	}

	dispose(): void {
		this.cancelRun();
	}
}

/**
 * Run checks in a live panel (TUI) and resolve with how the user left it.
 * In non-TUI modes, checks run sequentially and report via a single notify.
 */
export async function runChecksPanel(
	ctx: ExtensionCommandContext,
	options: ChecksPanelOptions,
): Promise<ChecksPanelOutcome> {
	if (ctx.mode !== "tui") {
		const lines: string[] = [...(options.notes ?? [])];
		const summary: PanelSummary = {
			finished: true,
			passed: [],
			failed: [],
			results: new Map(),
			latency: new Map(),
			passedCount: 0,
			failedCount: 0,
		};
		for (const check of options.checks) {
			if (!check.run) {
				lines.push(`${check.label}: skipped${check.skipReason ? ` — ${check.skipReason}` : ""}`);
				continue;
			}
			const started = Date.now();
			const result = await check.run(new AbortController().signal).catch(
				(err: unknown): CheckResult => ({
					ok: false,
					detail: err instanceof Error ? err.message : String(err),
				}),
			);
			if (result.ok) summary.passedCount++;
			else summary.failedCount++;
			if (check.id) {
				summary.results.set(check.id, result);
				if (result.ok) {
					summary.passed.push(check.id);
					summary.latency.set(check.id, Date.now() - started);
				} else {
					summary.failed.push(check.id);
				}
			}
			lines.push(`${check.label}: ${result.ok ? "OK" : "FAILED"} — ${result.detail}`);
			for (const sub of result.sub ?? []) lines.push(`  ${sub}`);
			if (result.hint && !result.ok) lines.push(`  hint: ${result.hint}`);
		}
		ctx.ui.notify([options.title, ...lines].join("\n"), summary.failedCount > 0 ? "warning" : "info");
		return { kind: "closed", summary };
	}

	return ctx.ui.custom<ChecksPanelOutcome>(
		(tui, theme, _kb, done) => new ChecksPanel(tui, theme, options, done),
	);
}
