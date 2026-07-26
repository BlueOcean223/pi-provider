import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	DynamicBorder,
	ExtensionEditorComponent,
	keyHint,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, type Editor, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

/**
 * Wrap-around single select + editor, replacing pi's host dialogs which clamp
 * at the list edges (ExtensionSelectorComponent uses Math.max/Math.min).
 *
 * - ↑ on the first row jumps to the last, ↓ on the last row jumps to the first
 * - Esc returns undefined; multi-step flows treat that as "go back one step"
 */

class WrapSelectComponent extends Container {
	private selectedIndex = 0;
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: string[];
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		options: string[],
		escLabel: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate (loops)") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", escLabel),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? this.theme.fg("accent", "→ ") + this.theme.fg("accent", this.options[i]!)
				: `  ${this.theme.fg("text", this.options[i]!)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const count = this.options.length;
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + count) % count;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % count;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected !== undefined) this.onSelect(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}
}

/**
 * Single select with wrap-around ↑/↓ navigation.
 * Same contract as ui.select: resolves the chosen option, or undefined on Esc.
 */
export async function loopSelect(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
	opts?: { escLabel?: "cancel" | "back" },
): Promise<string | undefined> {
	if (options.length === 0) return undefined;
	if (ctx.mode !== "tui") {
		return ctx.ui.select(title, options);
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		return new WrapSelectComponent(
			tui,
			theme,
			title,
			options,
			opts?.escLabel ?? "cancel",
			(value) => done(value),
			() => done(undefined),
		);
	});
}

class WrapEditorComponent extends ExtensionEditorComponent {
	private readonly wrapTui: TUI;

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super(tui, keybindings, title, prefill, onSubmit, onCancel);
		this.wrapTui = tui;
	}

	handleInput(keyData: string): void {
		// Wrap-around cursor: ↑ on the first line jumps to the last line,
		// ↓ on the last line jumps back to the first.
		const ed = (this as unknown as { editor?: Editor }).editor;
		if (ed && !ed.isShowingAutocomplete()) {
			const lines = ed.getLines();
			if (lines.length > 1) {
				const kb = getKeybindings();
				const up = kb.matches(keyData, "tui.editor.cursorUp");
				const down = !up && kb.matches(keyData, "tui.editor.cursorDown");
				if (up || down) {
					const cursor = ed.getCursor();
					const target = up && cursor.line === 0 ? lines.length - 1 : down && cursor.line === lines.length - 1 ? 0 : undefined;
					if (target !== undefined) {
						// Editor keeps cursor state private, so this reaches into
						// pi-tui internals (state.cursorLine / preferredVisualCol).
						// Coupled to the installed pi-tui version: if a pi-tui
						// update renames these fields, the guard below makes
						// wrap-around silently stop (falling back to clamped
						// cursor movement) rather than crash.
						const internals = ed as unknown as {
							state?: { cursorLine: number; cursorCol: number };
							preferredVisualCol?: number | null;
						};
						if (internals.state) {
							internals.state.cursorLine = target;
							internals.state.cursorCol = Math.min(cursor.col, lines[target]!.length);
							internals.preferredVisualCol = null;
							this.wrapTui.requestRender();
							return;
						}
					}
				}
			}
		}
		super.handleInput(keyData);
	}
}

/**
 * Multi-line editor with wrap-around cursor navigation.
 * Same contract as ui.editor: resolves the edited text, or undefined on Esc.
 * Keeps Enter submit / Shift+Enter newline / Ctrl+G external editor.
 */
export async function loopEditor(
	ctx: ExtensionCommandContext,
	title: string,
	prefill?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		return ctx.ui.editor(title, prefill);
	}
	return ctx.ui.custom<string | undefined>((tui, _theme, kb, done) => {
		return new WrapEditorComponent(
			tui,
			kb,
			title,
			prefill,
			(value) => done(value),
			() => done(undefined),
		);
	});
}

/**
 * Run an async task behind a bordered spinner; Esc aborts via the passed
 * AbortSignal. Resolves the task result, or undefined when cancelled.
 * Unlike a notify("…ing") line, nothing is left in the chat log afterwards.
 */
export async function withSpinner<T>(
	ctx: ExtensionCommandContext,
	message: string,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	if (ctx.mode !== "tui") {
		return task(new AbortController().signal);
	}
	const outcome = await ctx.ui.custom<{ value?: T; error?: unknown; cancelled?: boolean }>(
		(tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, message);
			loader.onAbort = () => done({ cancelled: true });
			task(loader.signal).then(
				(value) => done({ value }),
				(error: unknown) => done({ error: error ?? new Error("task failed") }),
			);
			return loader;
		},
	);
	if (outcome.cancelled) return undefined;
	if (outcome.error !== undefined) throw outcome.error;
	return outcome.value;
}

/**
 * Wizard step machine for multi-step flows (/provider add, proxy …).
 *
 * Each step's run() reports where to go:
 * - "next"  — advance
 * - "back"  — previous non-skipped step (Esc in dialogs maps to this)
 * - "stay"  — re-run the same step (invalid input)
 * - "abort" — leave the whole flow
 *
 * Returns true when the wizard ran to completion, false when aborted or
 * backed out of the first step.
 */
export type StepOutcome = "next" | "back" | "stay" | "abort";

export interface WizardStep {
	/** Skip this step (both directions) when true. */
	skip?: () => boolean;
	run: () => Promise<StepOutcome>;
}

export async function runWizard(steps: WizardStep[]): Promise<boolean> {
	let index = 0;
	let direction: 1 | -1 = 1;
	while (index >= 0 && index < steps.length) {
		const step = steps[index]!;
		if (step.skip?.()) {
			index += direction;
			continue;
		}
		direction = 1;
		const outcome = await step.run();
		if (outcome === "abort") return false;
		if (outcome === "back") {
			direction = -1;
			index -= 1;
		} else if (outcome === "next") {
			index += 1;
		}
		// "stay" re-runs the current step
	}
	return index >= steps.length;
}
