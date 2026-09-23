import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	DynamicBorder,
	ExtensionEditorComponent,
	keyHint,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Editor,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";

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
		initialIndex = 0,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.selectedIndex = Math.min(Math.max(initialIndex, 0), Math.max(options.length - 1, 0));
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
	opts?: {
		escLabel?: "cancel" | "back";
		/** Option the cursor starts on (e.g. the current value when editing). */
		initial?: string;
	},
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
			opts?.initial ? options.indexOf(opts.initial) : 0,
		);
	});
}

export interface LoopInputOptions {
	/** Editable starting value — e.g. what was entered before going back a step. */
	initial?: string;
	/** Dim example shown while the field is empty. */
	placeholder?: string;
	/** Muted lines under the title explaining the accepted formats. */
	hint?: string[];
	/** Return an error to keep the dialog open (shown inline), or undefined to accept. */
	validate?: (value: string) => string | undefined;
	escLabel?: "cancel" | "back";
}

/**
 * Single-line input with a real prefill and placeholder.
 *
 * pi's ui.input ignores its placeholder argument and has no public prefill
 * (ExtensionInputComponent never reads `_placeholder`, and showExtensionInput
 * forwards only `{ tui, timeout }`), so stepping back through a wizard used to
 * show an empty field. Validation errors render inline instead of as notify
 * lines, so nothing lands in the chat log.
 */
class LoopInputComponent extends Container implements Focusable {
	private readonly input: Input;
	private readonly errorText = new Text("", 1, 0);
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly validate?: (value: string) => string | undefined;
	private readonly onSubmit: (value: string) => void;
	private readonly onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		opts: LoopInputOptions,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.validate = opts.validate;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;

		this.input = new Input({
			placeholder: opts.placeholder,
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		if (opts.initial) {
			this.input.setValue(opts.initial);
			// setValue clamps the old cursor (0), so typing would land before the
			// prefilled text. Start at the end like any prefilled field. Private
			// pi-tui field: if it's renamed, the cursor just stays at the start.
			const internals = this.input as unknown as { cursor?: number };
			if (typeof internals.cursor === "number") internals.cursor = opts.initial.length;
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		for (const line of opts.hint ?? []) {
			this.addChild(new Text(theme.fg("muted", line), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(this.errorText);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", opts.escLabel ?? "back")}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const value = this.input.getValue();
			const error = this.validate?.(value);
			if (error) {
				this.errorText.setText(this.theme.fg("error", `✗ ${error}`));
				this.tui.requestRender();
				return;
			}
			this.onSubmit(value);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.input.handleInput(keyData);
		this.errorText.setText("");
		this.tui.requestRender();
	}
}

/**
 * Text input with prefill, placeholder and inline validation.
 * Resolves the entered text, or undefined on Esc.
 *
 * Outside the TUI, ui.input can't prefill, so the initial value is offered as
 * the placeholder and an empty answer keeps it.
 */
export async function loopInput(
	ctx: ExtensionCommandContext,
	title: string,
	opts: LoopInputOptions = {},
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const heading = opts.hint?.length ? `${title}\n${opts.hint.join("\n")}` : title;
		while (true) {
			const raw = await ctx.ui.input(heading, opts.initial || opts.placeholder);
			if (raw === undefined) return undefined;
			const value = raw === "" && opts.initial ? opts.initial : raw;
			const error = opts.validate?.(value);
			if (!error) return value;
			ctx.ui.notify(error, "error");
		}
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		return new LoopInputComponent(
			tui,
			theme,
			title,
			opts,
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
		// Wrap-around cursor: ↑ on the first visual row jumps to the last row,
		// ↓ on the last visual row jumps back to the first.
		const ed = (this as unknown as { editor?: Editor }).editor;
		if (ed && !ed.isShowingAutocomplete()) {
			const kb = getKeybindings();
			const up = kb.matches(keyData, "tui.editor.cursorUp");
			const down = !up && kb.matches(keyData, "tui.editor.cursorDown");
			if (up || down) {
				// Editor keeps its visual-line helpers private, so this reaches
				// into pi-tui internals. moveToVisualLine is what ↑/↓ use: it keeps
				// the sticky column and snaps onto a paste marker instead of
				// landing inside one. Coupled to the installed pi-tui version: if
				// a pi-tui update renames these, the guard below makes wrap-around
				// silently stop (falling back to clamped cursor movement) rather
				// than crash.
				const internals = ed as unknown as {
					lastWidth?: number;
					lastAction?: unknown;
					buildVisualLineMap?: (width: number) => unknown[];
					findCurrentVisualLine?: (visualLines: unknown[]) => number;
					moveToVisualLine?: (visualLines: unknown[], from: number, to: number) => void;
				};
				if (
					typeof internals.lastWidth === "number" &&
					typeof internals.buildVisualLineMap === "function" &&
					typeof internals.findCurrentVisualLine === "function" &&
					typeof internals.moveToVisualLine === "function"
				) {
					const visualLines = internals.buildVisualLineMap.call(ed, internals.lastWidth);
					const from = internals.findCurrentVisualLine.call(ed, visualLines);
					const last = visualLines.length - 1;
					const target = up && from === 0 ? last : down && from === last ? 0 : undefined;
					if (target !== undefined && last > 0) {
						internals.lastAction = null;
						internals.moveToVisualLine.call(ed, visualLines, from, target);
						this.wrapTui.requestRender();
						return;
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
