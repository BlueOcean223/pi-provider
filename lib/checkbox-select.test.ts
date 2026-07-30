import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeybindingsManager, type SettingItem, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { MultiSelectList } from "./checkbox-select.ts";

const kb = new KeybindingsManager(TUI_KEYBINDINGS);

// getSettingsListTheme() needs pi's theme initialized; key handling never
// touches the theme (only render does), so a pass-through stub is enough.
const stubTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

function makeList(ids: string[], on: Set<string>) {
	const events: Array<{ type: "change" | "confirm" | "cancel"; id?: string; value?: string }> = [];
	const items: SettingItem[] = ids.map((id) => ({
		id,
		label: id,
		currentValue: on.has(id) ? "on" : "off",
		values: ["off", "on"],
	}));
	const list = new MultiSelectList(
		items,
		ids.length + 2,
		stubTheme,
		(id, newValue) => events.push({ type: "change", id, value: newValue }),
		() => events.push({ type: "cancel" }),
		() => events.push({ type: "confirm" }),
		kb,
	);
	return { list, items, events };
}

describe("MultiSelectList key semantics", () => {
	it("Space toggles the focused row, Enter does not", () => {
		const { list, items, events } = makeList(["a", "b"], new Set());
		list.handleInput(" ");
		assert.equal(items[0]!.currentValue, "on");
		list.handleInput("\r"); // Enter: confirm only, no toggle
		assert.equal(items[0]!.currentValue, "on");
		assert.deepEqual(events, [
			{ type: "change", id: "a", value: "on" },
			{ type: "confirm" },
		]);
	});

	it("Enter confirms (even with an active search query), Esc cancels", () => {
		const { list, events } = makeList(["gpt-4o", "gpt-4o-mini"], new Set());
		for (const ch of "gpt") list.handleInput(ch); // type a search query
		list.handleInput("\r");
		assert.deepEqual(events, [{ type: "confirm" }]);

		events.length = 0;
		list.handleInput("\x1b");
		assert.deepEqual(events, [{ type: "cancel" }]);
	});

	it("ctrl+c cancels like Esc", () => {
		const { list, events } = makeList(["a"], new Set());
		list.handleInput("\x03");
		assert.deepEqual(events, [{ type: "cancel" }]);
	});

	it("Space after a non-empty search query toggles the focused row (not the query)", () => {
		const { list, items, events } = makeList(["a"], new Set());
		list.handleInput("a"); // query is now "a"
		list.handleInput(" "); // toggles the match, does not become "aa"
		assert.equal(items[0]!.currentValue, "on");
		assert.deepEqual(events, [{ type: "change", id: "a", value: "on" }]);
	});

	it("Space on an empty query toggles the focused row", () => {
		const { list, items, events } = makeList(["a"], new Set(["a"]));
		list.handleInput(" ");
		assert.equal(items[0]!.currentValue, "off");
		assert.deepEqual(events, [{ type: "change", id: "a", value: "off" }]);
	});

	it("↑/↓ navigation still works", () => {
		const { list, items, events } = makeList(["a", "b"], new Set());
		list.handleInput("\x1b[B"); // down to "b"
		list.handleInput(" ");
		assert.equal(items[1]!.currentValue, "on");
		assert.deepEqual(events, [{ type: "change", id: "b", value: "on" }]);
	});
});

describe("MultiSelectList rendering", () => {
	it("renders [x]/[ ] checkboxes instead of on/off values", () => {
		const { list } = makeList(["gpt-4o", "gpt-4o-mini"], new Set(["gpt-4o"]));
		const out = list.render(60).join("\n");
		assert.match(out, /→ \[x\] gpt-4o/);
		assert.match(out, / {2}\[ \] gpt-4o-mini/);
		assert.ok(!out.includes("Enter/Space"));
		assert.ok(out.includes("Space toggle · Enter confirm · Esc cancel"));
	});

	it("shows the focused row's description", () => {
		const { list, items } = makeList(["a", "b"], new Set());
		items[0]!.description = "matched · 128k ctx";
		const out = list.render(60).join("\n");
		assert.ok(out.includes("matched · 128k ctx"));
	});

	it("filters rows when searching", () => {
		const { list } = makeList(["gpt-4o", "gpt-4o-mini"], new Set(["gpt-4o"]));
		for (const ch of "mini") list.handleInput(ch);
		const out = list.render(60).join("\n");
		assert.ok(out.includes("[ ] gpt-4o-mini"));
		assert.ok(!out.includes("[x]")); // the checked row is filtered out
	});
});
