import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

/**
 * Drives the extension's ui.custom screens in tests: every ui.custom call takes
 * the next scripted step, which reads the rendered screen and presses keys.
 * Screens that close themselves (the spinner) need no step.
 */

// DynamicBorder and keyHint() read pi's global theme.
initTheme("dark");

export const KEY = {
	enter: "\r",
	esc: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	space: " ",
	ctrlA: "\x01",
	backspace: "\x7f",
} as const;

export interface Screen {
	/** Rendered screen text without ANSI colours. */
	text(): string;
	press(...keys: string[]): void;
	/** Type text one character at a time. */
	type(text: string): void;
	/** Wait until the screen contains `needle` (e.g. a live panel finishing). */
	waitFor(needle: string): Promise<void>;
}

export type Step = (screen: Screen) => void | Promise<void>;

interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	dispose?(): void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

/** Pass-through theme: colours vanish, so assertions see plain text. */
const theme = new Proxy(
	{},
	{
		get: (_target, prop) =>
			prop === "fg" || prop === "bg" ? (_color: string, text: string) => text : (text: string) => text,
	},
);

const tui = { requestRender() {}, stop() {}, start() {}, terminal: { rows: 40, columns: 120 } };

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export interface Harness {
	ui: Record<string, unknown>;
	notifications: string[];
	/** Every screen shown, as first rendered (for "was X ever shown" checks). */
	screens: string[];
	/** Steps not consumed yet — should be 0 when the flow ends. */
	remaining(): number;
}

export function tuiHarness(steps: Step[]): Harness {
	const kb = new KeybindingsManager(TUI_KEYBINDINGS);
	const notifications: string[] = [];
	const screens: string[] = [];

	const custom = async (factory: (...args: unknown[]) => Component | Promise<Component>) => {
		let finished = false;
		let resolveDone!: (value: unknown) => void;
		const done = new Promise((resolve) => {
			resolveDone = resolve;
		});
		const component = await factory(tui, theme, kb, (value: unknown) => {
			finished = true;
			resolveDone(value);
		});
		const text = () => component.render(120).join("\n").replace(ANSI, "");
		const screen: Screen = {
			text,
			press: (...keys) => {
				for (const key of keys) component.handleInput?.(key);
			},
			type: (value) => {
				for (const ch of value) component.handleInput?.(ch);
			},
			waitFor: async (needle) => {
				for (let i = 0; i < 500; i++) {
					if (text().includes(needle)) return;
					await new Promise((resolve) => setTimeout(resolve, 2));
				}
				throw new Error(`timed out waiting for "${needle}" on:\n${text()}`);
			},
		};

		// Let a self-closing screen (spinner) finish before claiming a step.
		await flush();
		if (!finished) {
			screens.push(text());
			const step = steps.shift();
			if (!step) throw new Error(`unexpected screen:\n${text()}`);
			await step(screen);
		}
		const timeout = setTimeout(() => {
			resolveDone(new Error(`screen did not close:\n${text()}`));
		}, 3000);
		const value = await done;
		clearTimeout(timeout);
		component.dispose?.();
		if (value instanceof Error) throw value;
		return value;
	};

	return {
		ui: {
			custom,
			notify: (message: string) => notifications.push(message),
			select: () => {
				throw new Error("ui.select must not be used in TUI mode");
			},
			input: () => {
				throw new Error("ui.input must not be used in TUI mode");
			},
		},
		notifications,
		screens,
		remaining: () => steps.length,
	};
}
