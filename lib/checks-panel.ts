import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

/**
 * Live checklist panel for /provider test.
 *
 * All checks start concurrently; each row shows a spinner while in flight and
 * settles to ✓ / ✗ in place. Esc aborts the underlying requests. The panel is
 * a ui.custom component, so closing it leaves nothing behind in the chat log
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
}

type RowStatus = "running" | "ok" | "fail" | "skip";

interface Row {
	status: RowStatus;
	result?: CheckResult;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

class ChecksPanel extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly checks: PanelCheck[];
	private readonly finish: () => void;
	private readonly listContainer = new Container();
	private readonly statusText = new Text("", 1, 0);
	private rows: Row[] = [];
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private abort = new AbortController();
	private pending = 0;
	// Guards against results of an aborted run landing after "r" restarted it.
	private generation = 0;

	constructor(tui: TUI, theme: Theme, options: ChecksPanelOptions, finish: () => void) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.checks = options.checks;
		this.finish = finish;

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
		this.rows = this.checks.map((c): Row => ({ status: c.run ? "running" : "skip" }));
		this.pending = this.checks.filter((c) => c.run).length;

		for (let i = 0; i < this.checks.length; i++) {
			const run = this.checks[i]!.run;
			if (!run) continue;
			run(this.abort.signal).then(
				(result) => this.settle(gen, i, { status: result.ok ? "ok" : "fail", result }),
				(err: unknown) =>
					this.settle(gen, i, {
						status: "fail",
						result: { ok: false, detail: err instanceof Error ? err.message : String(err) },
					}),
			);
		}

		if (!this.finished && this.timer === null) {
			this.timer = setInterval(() => {
				this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
				this.refresh();
			}, SPINNER_INTERVAL_MS);
		}
		this.refresh();
	}

	private settle(gen: number, index: number, row: Row): void {
		if (gen !== this.generation) return;
		this.rows[index] = row;
		this.pending--;
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
			this.statusText.setText(keyHint("tui.select.cancel", "cancel"));
		}
		this.tui.requestRender();
	}

	private renderRow(check: PanelCheck, row: Row): string {
		const t = this.theme;
		switch (row.status) {
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

	private close(): void {
		// Bump generation so late rejections from the aborted requests can't
		// settle rows / request renders after the panel is gone.
		this.generation++;
		this.abort.abort();
		this.stopTimer();
		this.finish();
	}

	dispose(): void {
		this.stopTimer();
		this.abort.abort();
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
