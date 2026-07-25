import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

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
 * Multi-select model list, matching pi's SettingsList UX:
 * - cursor `→ `, values `on` / `off` (no emoji)
 * - type to search (fuzzy, like /model and settings)
 * - Enter/Space toggles
 * - Esc finishes and returns currently-on items (same pattern as /tools)
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
			`${title}\n(set line to "on <id>" to include, "off <id>" to skip)`,
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

	return ui.custom<string[] | undefined>((tui, theme, _kb, done) => {
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
				const count = selected.size;
				return [
					theme.fg("accent", theme.bold(title)),
					theme.fg(
						"dim",
						` ${count}/${items.length} on · type to search · Enter/Space toggle · Esc done`,
					),
					"",
				];
			},
			invalidate() {},
		};
		container.addChild(header);

		const maxVisible = Math.min(Math.max(items.length, 1) + 2, 16);

		const settingsList = new SettingsList(
			settingItems,
			maxVisible,
			getSettingsListTheme(),
			(id, newValue) => {
				if (newValue === "on") selected.add(id);
				else selected.delete(id);
				// refresh header count
				tui.requestRender();
			},
			() => {
				// Esc / ctrl+c — finish with current selection (pi /tools style)
				done(Array.from(selected));
			},
			{ enableSearch: true },
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
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}
