import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface CheckboxItem {
	/** Stable id / value returned when selected. */
	id: string;
	/** Primary label (model id). */
	label: string;
	/** Secondary info (ctx, thinking, match status). */
	description?: string;
	/** Pre-checked. */
	checked?: boolean;
}

/**
 * pi-tui's SettingsList with private members exposed for the subclass below.
 * Same coupling caveat as elsewhere: if a pi-tui update renames these fields,
 * the checklist degrades (falls back to base rendering) rather than crashes.
 */
interface SettingsListInternals {
	items: SettingItem[];
	filteredItems: SettingItem[];
	selectedIndex: number;
	maxVisible: number;
	theme: SettingsListTheme;
	submenuComponent: {
		handleInput?: (data: string) => void;
		render: (width: number) => string[];
	} | null;
	searchEnabled: boolean;
	searchInput?: {
		handleInput: (data: string) => void;
		getValue: () => string;
		render: (width: number) => string[];
	};
}

/**
 * Multi-select checklist built on pi-tui's SettingsList.
 *
 * SettingsList is a *settings* component — it renders rows as
 * `label …… on/off` and hardcodes Enter AND Space to toggle. Both are the
 * wrong semantics for picking models, so this subclass keeps the base
 * class's state (search filter, scroll window, selection index) but
 * replaces interaction and presentation:
 *
 * - rows render as `[x]` / `[ ]` checkboxes, focused row highlighted
 * - Space toggles the focused row
 * - Enter finishes with the currently-checked items (confirm)
 * - Esc / ctrl+c cancels (undefined)
 * - Space and Enter are intercepted before the base class can see them, so
 *   neither falls through to the search input or the built-in toggle.
 */
export class MultiSelectList extends SettingsList {
	private readonly kb: { matches(data: string, action: string): boolean };
	private readonly onConfirm: () => void;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		onConfirm: () => void,
		kb: { matches(data: string, action: string): boolean },
	) {
		super(items, maxVisible, theme, onChange, onCancel, { enableSearch: true });
		this.kb = kb;
		this.onConfirm = onConfirm;
	}

	override handleInput(data: string): void {
		const internals = this.asInternals();
		// A submenu (not used by this list) owns all keys while it is open.
		if (internals.submenuComponent) {
			internals.submenuComponent.handleInput?.(data);
			return;
		}
		// Enter = confirm the current on-set, even mid-search.
		if (this.kb.matches(data, "tui.select.confirm")) {
			this.onConfirm();
			return;
		}
		super.handleInput(data);
	}

	/** Checklist rendering — replaces the base class's settings-style rows. */
	override render(width: number): string[] {
		const internals = this.asInternals();
		// A submenu (not used by this list) renders itself while open.
		if (internals.submenuComponent) {
			return internals.submenuComponent.render(width);
		}
		// pi-tui internals changed shape — fall back to base rendering
		// (settings-style on/off rows) instead of crashing.
		if (!Array.isArray(internals.items) || !internals.theme) {
			return super.render(width);
		}

		const { items, filteredItems, selectedIndex, maxVisible, theme, searchEnabled, searchInput } =
			internals;
		const lines: string[] = [];

		if (searchEnabled && searchInput) {
			lines.push(...searchInput.render(width));
			lines.push("");
		}

		if (items.length === 0) {
			lines.push(theme.hint("  No items available"));
			this.addChecklistHint(lines, width);
			return lines;
		}

		const displayItems = searchEnabled ? filteredItems : items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(theme.hint("  No matching items"), width));
			this.addChecklistHint(lines, width);
			return lines;
		}

		// Visible window, centered on the cursor (same math as the base class).
		const startIndex = Math.max(
			0,
			Math.min(selectedIndex - Math.floor(maxVisible / 2), displayItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, displayItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;
			const isSelected = i === selectedIndex;
			// theme.value is wired to render "[x]" checked/accent and "[ ]" dim.
			const box = theme.value(item.currentValue === "on" ? "[x]" : "[ ]", isSelected);
			const prefix = isSelected ? theme.cursor : "  ";
			lines.push(truncateToWidth(`${prefix}${box} ${theme.label(item.label, isSelected)}`, width));
		}

		if (startIndex > 0 || endIndex < displayItems.length) {
			lines.push(theme.hint(truncateToWidth(`  (${selectedIndex + 1}/${displayItems.length})`, width - 2, "")));
		}

		// Description follows the cursor, like the base list.
		const focused = displayItems[selectedIndex];
		if (focused?.description) {
			lines.push("");
			for (const line of wrapTextWithAnsi(focused.description, width - 4)) {
				lines.push(theme.description(`  ${line}`));
			}
		}

		this.addChecklistHint(lines, width);
		return lines;
	}

	private addChecklistHint(lines: string[], width: number): void {
		const { theme, searchEnabled } = this.asInternals();
		lines.push("");
		lines.push(
			truncateToWidth(
				theme.hint(
					searchEnabled
						? "  Type to search · Space toggle · Enter confirm · Esc cancel"
						: "  Space toggle · Enter confirm · Esc cancel",
				),
				width,
			),
		);
	}

	private asInternals(): SettingsListInternals {
		return this as unknown as SettingsListInternals;
	}
}

/**
 * Multi-select checklist for picking models:
 * - `[x]` / `[ ]` checkboxes, cursor `→ `, focused row highlighted
 * - type to search (fuzzy, like /model and settings)
 * - Space toggles, Enter confirms, Esc cancels
 */
export async function checkboxSelect(
	ctx: ExtensionCommandContext,
	title: string,
	items: CheckboxItem[],
): Promise<string[] | undefined> {
	const { ui } = ctx;
	if (items.length === 0) return [];

	// ui.custom is TUI-only: outside "tui" it exists but is a no-op stub that
	// resolves undefined without invoking the factory (e.g. RPC mode), so guard
	// on mode — not on the function's presence.
	if (ctx.mode !== "tui") {
		// Non-TUI fallback (ui.editor works over RPC)
		const prefill = items.map((i) => `${i.checked ? "on " : "off"} ${i.id}`).join("\n");
		const edited = await ui.editor(
			`${title}\n(set line to "on <id>" to include, "off <id>" to skip; submit to confirm)`,
			prefill,
		);
		if (edited === undefined) return undefined;
		const selected: string[] = [];
		for (const line of edited.split("\n")) {
			const m = line.match(/^\s*on\s+(\S+)/i);
			if (m) selected.push(m[1]!);
		}
		return selected;
	}

	return ui.custom<string[] | undefined>((tui, theme, kb, done) => {
		const selected = new Set(items.filter((i) => i.checked).map((i) => i.id));

		const settingItems: SettingItem[] = items.map((i) => ({
			id: i.id,
			label: i.label,
			description: i.description,
			currentValue: selected.has(i.id) ? "on" : "off",
			values: ["off", "on"],
		}));

		const container = new Container();

		const header = {
			render(_width: number) {
				return [
					theme.fg("accent", theme.bold(title)),
					theme.fg("dim", ` ${selected.size}/${items.length} selected`),
					"",
				];
			},
			invalidate() {},
		};
		container.addChild(header);

		const maxVisible = Math.min(Math.max(items.length, 1) + 2, 16);

		// Same palette as pi's getSettingsListTheme(), with the value slot
		// repurposed as the checkbox renderer: checked = accent, unchecked = dim.
		const listTheme: SettingsListTheme = {
			label: (text, isSelected) => (isSelected ? theme.fg("accent", text) : theme.fg("text", text)),
			value: (text) => (text === "[x]" ? theme.fg("accent", text) : theme.fg("dim", text)),
			description: (text) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text) => theme.fg("dim", text),
		};

		const settingsList = new MultiSelectList(
			settingItems,
			maxVisible,
			listTheme,
			(id, newValue) => {
				if (newValue === "on") selected.add(id);
				else selected.delete(id);
				// refresh header count
				tui.requestRender();
			},
			() => {
				// Esc / ctrl+c — cancel without applying the changes
				done(undefined);
			},
			() => {
				// Enter — confirm the current on-set
				done(Array.from(selected));
			},
			kb,
		);

		container.addChild(settingsList);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
