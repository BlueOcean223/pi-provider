import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type RowMenuChoice, RowMenu, type RowMenuOptions } from "./row-menu.ts";

initTheme();
const stubTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
const stubTui = { requestRender() {} } as unknown as TUI;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const plain = (menu: RowMenu) => menu.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function open(options: Partial<RowMenuOptions>) {
	const chosen: Array<RowMenuChoice | undefined> = [];
	const menu = new RowMenu(
		stubTui,
		stubTheme,
		{
			title: "t",
			entries: [
				{ heading: "Section" },
				{ id: "a", label: "Alpha", value: "1" },
				{ separator: true },
				{ id: "off", label: "Disabled", disabled: true },
				{ id: "b", label: "Beta", value: "2" },
			],
			...options,
		},
		(choice) => chosen.push(choice),
	);
	return { menu, chosen };
}

describe("RowMenu", () => {
	it("starts on the first selectable row and skips headings, separators and disabled rows", () => {
		const { menu, chosen } = open({});
		assert.equal(menu.focusedRow?.id, "a");
		menu.handleInput(DOWN);
		assert.equal(menu.focusedRow?.id, "b");
		menu.handleInput(DOWN); // wraps
		assert.equal(menu.focusedRow?.id, "a");
		menu.handleInput(UP);
		menu.handleInput(ENTER);
		assert.deepEqual(chosen, [{ id: "b" }]);
	});

	it("honours initialId", () => {
		const { menu } = open({ initialId: "b" });
		assert.equal(menu.focusedRow?.id, "b");
	});

	it("offers a shortcut only on the rows it applies to", () => {
		const { menu, chosen } = open({ keys: [{ key: "t", label: "test", applies: (row) => row.id === "b" }] });
		assert.ok(!plain(menu).includes("t test"));
		menu.handleInput("t"); // not applicable on "a"
		assert.deepEqual(chosen, []);
		menu.handleInput(DOWN);
		assert.ok(plain(menu).includes("t test"));
		menu.handleInput("t");
		assert.deepEqual(chosen, [{ id: "b", key: "t" }]);
	});

	it("aligns the value column and shows notes", () => {
		const { menu } = open({
			notes: [{ text: "✓ Saved", tone: "success" }],
			entries: [
				{ id: "a", label: "Base URL", value: "https://x" },
				{ id: "b", label: "API key", value: "none" },
			],
		});
		const lines = plain(menu).split("\n");
		const url = lines.find((l) => l.includes("https://x"))!;
		const key = lines.find((l) => l.includes("none"))!;
		assert.equal(url.indexOf("https://x"), key.indexOf("none"));
		assert.ok(plain(menu).includes("✓ Saved"));
	});

	it("Esc resolves undefined", () => {
		const { menu, chosen } = open({});
		menu.handleInput("\x1b");
		assert.deepEqual(chosen, [undefined]);
	});
});
