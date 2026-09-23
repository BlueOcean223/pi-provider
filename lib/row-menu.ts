import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Row menu for object-first screens: the provider list, a provider's detail
 * page and review/confirm pages.
 *
 * Rows come in two shapes that can be mixed:
 * - settings rows (`value`): `Label      value`, value column aligned
 * - list rows (`detail`): `id  dim detail  badge`, detail column aligned; on
 *   a narrow terminal the detail shortens first so the badge stays readable
 *
 * Headings and separators structure the list and are skipped by the cursor.
 * Single-letter shortcut keys act on the focused row (e.g. `t` = test), and the
 * hint line only lists the keys that apply to it. Notes above the list carry
 * transient outcomes ("✓ Base URL updated") so flows never need ui.notify.
 */

export type Tone = "success" | "warning" | "error" | "muted" | "accent" | "dim";

export interface MenuRow {
	id: string;
	label: string;
	/** Settings-style value column. */
	value?: string;
	/** Dim text after the label for list-style rows. */
	detail?: string;
	/** Coloured status after the detail (e.g. the last test result). */
	badge?: { text: string; tone: Tone };
	/** "action" rows are commands (Save, Test…); "danger" renders in the error colour. */
	kind?: "field" | "action" | "danger";
	disabled?: boolean;
}

export type MenuEntry = MenuRow | { separator: true } | { heading: string };

export interface MenuNote {
	text: string;
	tone?: Tone;
}

export interface MenuKey {
	key: string;
	label: string;
	/** Rows the key acts on; defaults to every selectable row. */
	applies?: (row: MenuRow) => boolean;
}

export interface RowMenuOptions {
	title: string;
	subtitle?: string;
	notes?: MenuNote[];
	entries: MenuEntry[];
	keys?: MenuKey[];
	/** Row the cursor starts on (e.g. the row that was just edited). */
	initialId?: string;
	/** Hint label for Enter; defaults to "select". */
	enterLabel?: string;
	/** Hint label for Esc; defaults to "back". */
	escLabel?: string;
	/** Rows shown at once before the list scrolls. */
	maxVisible?: number;
}

export interface RowMenuChoice {
	id: string;
	/** Shortcut key pressed on the row; absent for Enter. */
	key?: string;
}

function isRow(entry: MenuEntry): entry is MenuRow {
	return "id" in entry;
}

function selectable(entry: MenuEntry): entry is MenuRow {
	return isRow(entry) && !entry.disabled;
}

const MAX_VALUE_LABEL = 18;
const MAX_DETAIL_LABEL = 24;
/** Below this many columns a shortened detail says nothing; drop it instead. */
const MIN_DETAIL_WIDTH = 12;

/** Exported for tests; use rowMenu() to show it. */
export class RowMenu extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: RowMenuOptions;
	private readonly onChoose: (choice: RowMenuChoice | undefined) => void;
	private readonly listContainer = new Container();
	private readonly hintText = new Text("", 1, 0);
	private cursor: number;

	constructor(
		tui: TUI,
		theme: Theme,
		options: RowMenuOptions,
		onChoose: (choice: RowMenuChoice | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.onChoose = onChoose;

		const initial = options.initialId
			? options.entries.findIndex((entry) => selectable(entry) && entry.id === options.initialId)
			: -1;
		this.cursor = initial >= 0 ? initial : options.entries.findIndex(selectable);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
		if (options.subtitle) this.addChild(new Text(theme.fg("muted", options.subtitle), 1, 0));
		if (options.notes?.length) {
			this.addChild(new Spacer(1));
			for (const note of options.notes) {
				this.addChild(new Text(theme.fg(note.tone ?? "muted", note.text), 1, 0));
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.refresh();
	}

	/** Focused row, if any row is selectable. */
	get focusedRow(): MenuRow | undefined {
		const entry = this.options.entries[this.cursor];
		return entry && selectable(entry) ? entry : undefined;
	}

	private refresh(): void {
		this.listContainer.clear();
		const { entries } = this.options;
		const valueWidth = Math.min(
			MAX_VALUE_LABEL,
			Math.max(0, ...entries.filter((e) => isRow(e) && e.value !== undefined).map((e) => visibleWidth((e as MenuRow).label))),
		);
		const detailWidth = Math.min(
			MAX_DETAIL_LABEL,
			Math.max(0, ...entries.filter((e) => isRow(e) && e.detail !== undefined).map((e) => visibleWidth((e as MenuRow).label))),
		);

		const maxVisible = this.options.maxVisible ?? 20;
		let start = 0;
		let end = entries.length;
		if (entries.length > maxVisible) {
			start = Math.max(0, Math.min(this.cursor - Math.floor(maxVisible / 2), entries.length - maxVisible));
			end = start + maxVisible;
		}

		for (let i = start; i < end; i++) {
			this.listContainer.addChild(new RowLine(this.renderEntry(entries[i]!, i === this.cursor, valueWidth, detailWidth)));
		}
		if (start > 0 || end < entries.length) {
			const position = entries.slice(0, this.cursor + 1).filter(selectable).length;
			const total = entries.filter(selectable).length;
			this.listContainer.addChild(new RowLine(this.theme.fg("dim", `  (${position}/${total})`)));
		}

		this.hintText.setText(this.renderHint());
		this.tui.requestRender();
	}

	private renderEntry(entry: MenuEntry, focused: boolean, valueWidth: number, detailWidth: number): string | RowParts {
		const t = this.theme;
		if ("separator" in entry) return "";
		if ("heading" in entry) return `  ${t.fg("muted", t.bold(entry.heading))}`;

		const prefix = focused ? t.fg("accent", "→ ") : "  ";
		const labelColor = entry.disabled
			? "dim"
			: focused
				? "accent"
				: entry.kind === "danger"
					? "error"
					: "text";

		if (entry.value !== undefined) {
			const label = t.fg(labelColor, pad(entry.label, valueWidth));
			const value = t.fg(entry.disabled ? "dim" : focused ? "text" : "muted", entry.value);
			return `${prefix}${label}  ${value}`;
		}
		if (entry.detail !== undefined || entry.badge) {
			const label = t.fg(labelColor, pad(entry.label, detailWidth));
			return {
				head: `${prefix}${label}`,
				detail: entry.detail ? `  ${t.fg("dim", entry.detail)}` : "",
				tail: entry.badge ? `  ${t.fg(entry.badge.tone, entry.badge.text)}` : "",
			};
		}
		return `${prefix}${t.fg(labelColor, entry.label)}`;
	}

	private renderHint(): string {
		const parts = [rawKeyHint("↑↓", "navigate")];
		const row = this.focusedRow;
		if (row) parts.push(keyHint("tui.select.confirm", this.options.enterLabel ?? "select"));
		for (const key of this.options.keys ?? []) {
			if (row && (key.applies?.(row) ?? true)) parts.push(rawKeyHint(key.key, key.label));
		}
		parts.push(keyHint("tui.select.cancel", this.options.escLabel ?? "back"));
		return parts.join("  ");
	}

	private move(direction: 1 | -1): void {
		const { entries } = this.options;
		if (!entries.some(selectable)) return;
		let next = this.cursor;
		for (let step = 0; step < entries.length; step++) {
			next = (next + direction + entries.length) % entries.length;
			if (selectable(entries[next]!)) break;
		}
		this.cursor = next;
		this.refresh();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onChoose(undefined);
			return;
		}
		const row = this.focusedRow;
		if (!row) return;
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onChoose({ id: row.id });
			return;
		}
		const shortcut = this.options.keys?.find((key) => key.key === keyData);
		if (shortcut && (shortcut.applies?.(row) ?? true)) {
			this.onChoose({ id: row.id, key: shortcut.key });
			return;
		}
		// vim-style navigation, unless the letter is bound as a shortcut above
		if (keyData === "k") this.move(-1);
		else if (keyData === "j") this.move(1);
	}
}

/** A list row split so the parts that matter survive a narrow terminal. */
interface RowParts {
	/** Cursor and label. */
	head: string;
	/** Dim detail: shortened first, dropped when too little is left. */
	detail: string;
	/** Badge (e.g. the last test result): kept whole while it fits. */
	tail: string;
}

/** One pre-rendered line, fitted to the terminal width. */
class RowLine {
	private readonly line: string | RowParts;

	constructor(line: string | RowParts) {
		this.line = line;
	}

	render(width: number): string[] {
		if (typeof this.line === "string") return [truncateToWidth(` ${this.line}`, width)];
		const { head, detail, tail } = this.line;
		const room = width - 1 - visibleWidth(head) - visibleWidth(tail);
		if (visibleWidth(detail) <= room) return [` ${head}${detail}${tail}`];
		const fitted = room >= MIN_DETAIL_WIDTH ? truncateToWidth(detail, room, "…") : "";
		return [truncateToWidth(` ${head}${fitted}${tail}`, width)];
	}

	invalidate(): void {}
}

function pad(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** Plain-text label for the non-TUI fallback (ui.select). */
function plainLabel(row: MenuRow): string {
	const extra = row.value ?? row.detail;
	const badge = row.badge ? ` [${row.badge.text}]` : "";
	return extra ? `${row.label} — ${extra}${badge}` : `${row.label}${badge}`;
}

/**
 * Show a row menu. Resolves the chosen row (plus the shortcut key, if one was
 * pressed), or undefined on Esc.
 *
 * Outside the TUI this degrades to ui.select over the selectable rows; notes
 * are folded into the title and shortcut keys are unavailable.
 */
export async function rowMenu(
	ctx: ExtensionCommandContext,
	options: RowMenuOptions,
): Promise<RowMenuChoice | undefined> {
	if (ctx.mode !== "tui") {
		const rows = options.entries.filter(selectable);
		if (rows.length === 0) return undefined;
		const labels = rows.map(plainLabel);
		const title = [options.title, options.subtitle, ...(options.notes ?? []).map((n) => n.text)]
			.filter(Boolean)
			.join("\n");
		const picked = await ctx.ui.select(title, labels);
		if (picked === undefined) return undefined;
		const row = rows[labels.indexOf(picked)];
		return row ? { id: row.id } : undefined;
	}
	return ctx.ui.custom<RowMenuChoice | undefined>((tui, theme, _kb, done) => new RowMenu(tui, theme, options, done));
}
