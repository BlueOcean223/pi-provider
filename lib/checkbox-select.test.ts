import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type SettingItem, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { checkboxSelect, MultiSelectList } from "./checkbox-select.ts";
import { HOST_ROWS } from "./fit.ts";

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

function makeList(ids: string[], on: Set<string>, extras?: ConstructorParameters<typeof MultiSelectList>[7]) {
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
		extras,
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

describe("MultiSelectList Ctrl+A", () => {
	it("checks every visible row, then unchecks them", () => {
		const { list, items, events } = makeList(["a", "b", "c"], new Set(["b"]));
		list.handleInput("\x01");
		assert.deepEqual(
			items.map((i) => i.currentValue),
			["on", "on", "on"],
		);
		assert.deepEqual(events, [
			{ type: "change", id: "a", value: "on" },
			{ type: "change", id: "c", value: "on" },
		]);
		list.handleInput("\x01");
		assert.deepEqual(
			items.map((i) => i.currentValue),
			["off", "off", "off"],
		);
	});

	it("only touches rows matching the search", () => {
		const { list, items } = makeList(["gpt-4o", "gpt-4o-mini", "claude"], new Set());
		for (const ch of "gpt") list.handleInput(ch);
		list.handleInput("\x01");
		assert.deepEqual(
			items.map((i) => i.currentValue),
			["on", "on", "off"],
		);
	});
});

describe("MultiSelectList rendering", () => {
	it("renders [x]/[ ] checkboxes instead of on/off values", () => {
		const { list } = makeList(["gpt-4o", "gpt-4o-mini"], new Set(["gpt-4o"]));
		const out = list.render(100).join("\n");
		assert.match(out, /→ \[x\] gpt-4o/);
		assert.match(out, / {2}\[ \] gpt-4o-mini/);
		assert.ok(!out.includes("Enter/Space"));
		assert.ok(out.includes("Space toggle · Ctrl+A all · Enter confirm · Esc cancel"), out);
	});

	it("shows each row's inline detail in an aligned column", () => {
		const details = new Map([
			["gpt-4o", "128k ctx"],
			["gpt-4o-mini", "new · 128k ctx"],
		]);
		const { list } = makeList(["gpt-4o", "gpt-4o-mini"], new Set(), { detailFor: (id) => details.get(id) });
		const lines = list.render(100);
		const first = lines.find((line) => line.includes("] gpt-4o ")) ?? "";
		const second = lines.find((line) => line.includes("gpt-4o-mini")) ?? "";
		assert.ok(first.includes("128k ctx"), first);
		assert.equal(first.indexOf("128k ctx"), second.indexOf("new · 128k ctx"));
	});

	it("renders an inline error until the next toggle", () => {
		const { list } = makeList(["a"], new Set());
		list.setError("Select at least one model");
		assert.ok(list.render(100).join("\n").includes("✗ Select at least one model"));
		list.handleInput(" ");
		assert.ok(!list.render(100).join("\n").includes("✗"));
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

describe("checkboxSelect palette", () => {
	it("leaves unfocused labels in the terminal's default colour, like pi's settings list", () => {
		let component: { render(width: number): string[] } | undefined;
		const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
		const theme = { fg: (color: string, text: string) => `<${color}>${text}`, bold: (text: string) => text };
		const ctx = {
			mode: "tui",
			ui: {
				custom: (factory: (...args: unknown[]) => typeof component) =>
					new Promise(() => {
						component = factory(tui, theme, kb, () => {});
					}),
			},
		} as unknown as ExtensionCommandContext;
		void checkboxSelect(ctx, "Models", [
			{ id: "alpha", label: "alpha", checked: true },
			{ id: "beta", label: "beta" },
		]);
		const out = component!.render(100).join("\n");
		assert.ok(out.includes("<accent>[x] <accent>alpha"), out);
		assert.ok(out.includes("<dim>[ ] beta"), out);
	});
});

describe("checkboxSelect header width", () => {
	// pi-tui throws when a rendered line is wider than the terminal, and pi exits
	// with it. The header is built from raw strings, so a relay that answers the
	// catalog request with an error body used to put a 164-column line into a
	// 120-column terminal ("Couldn't list relay models ({…})").
	const relayError = `Couldn't list relay models (${JSON.stringify({
		code: "INSUFFICIENT_BALANCE",
		message: "Insufficient account balance / 账户余额不足，请充值后重试",
	})}) — showing configured models only`;

	function renderHeader(notes: string[], width: number, title = "Models: relay"): string[] {
		let component: { render(width: number): string[] } | undefined;
		const tui = { requestRender() {}, terminal: { rows: 40, columns: width } };
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const ctx = {
			mode: "tui",
			ui: {
				custom: (factory: (...args: unknown[]) => typeof component) =>
					new Promise(() => {
						component = factory(tui, theme, kb, () => {});
					}),
			},
		} as unknown as ExtensionCommandContext;
		void checkboxSelect(ctx, title, [{ id: "model", label: "model", checked: true }], { notes });
		return component!.render(width);
	}

	function widest(lines: string[]): number {
		return Math.max(...lines.map((line) => visibleWidth(line)));
	}

	it("wraps a long relay error instead of overflowing the terminal", () => {
		const lines = renderHeader([relayError], 120);
		assert.ok(widest(lines) <= 120, `widest line is ${widest(lines)} of 120`);
		assert.ok(lines.length > 2, "the note should wrap onto its own lines");
		// Nothing is dropped: the wrapped lines still carry the relay's message.
		const text = lines.join("\n");
		assert.ok(text.includes("INSUFFICIENT_BALANCE"), text);
		assert.ok(text.includes("showing configured models only"), text);
	});

	it("keeps every line inside narrow terminals, long titles and unbreakable text", () => {
		const cases: Array<{ notes: string[]; width: number; title?: string }> = [
			{ notes: [relayError], width: 40 },
			{ notes: ["x".repeat(300)], width: 30 },
			{ notes: ["\tjson\t" + "a\u0007b".repeat(40)], width: 60 },
			{ notes: [relayError], width: 50, title: `Models: ${"z".repeat(200)}` },
		];
		for (const { notes, width, title } of cases) {
			const lines = renderHeader(notes, width, title);
			assert.ok(widest(lines) <= width, `widest ${widest(lines)} > ${width} for ${JSON.stringify(notes).slice(0, 40)}`);
		}
	});
});

describe("MultiSelectList room", () => {
	const ids = Array.from({ length: 30 }, (_, i) => `model-${i}`);

	it("shortens the list to the rows its host gives it", () => {
		const { list } = makeList(ids, new Set());
		list.setRoom(15);
		assert.ok(list.render(60).length <= 15);
	});

	it("shows every row when they fit", () => {
		const { list } = makeList(ids, new Set());
		list.setRoom(40 - HOST_ROWS);
		const rows = list.render(60).filter((line) => line.includes("model-"));
		assert.equal(rows.length, 30);
	});
});
