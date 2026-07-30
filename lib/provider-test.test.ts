import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extension from "../index.ts";

/**
 * /provider test in a non-TUI mode: loopSelect → ui.select, the model checklist
 * → ui.editor ("on <id>" lines), and the checks panel runs sequentially and
 * reports through a single notify.
 */

const RELAY_MODELS = ["model-a", "model-b", "model-c"];

function writeRelay(dir: string): string {
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				relay: {
					baseUrl: "https://relay.test/v1",
					api: "openai-completions",
					apiKey: "sk-test",
					models: RELAY_MODELS.map((id) => ({ id, api: "openai-completions" })),
				},
			},
		}),
	);
	return path;
}

interface Harness {
	chatModels: string[];
	notifications: string[];
	editorPrefills: Array<string | undefined>;
	run: (answers: string[], editorReply?: string) => Promise<void>;
}

function harness(): Harness {
	const chatModels: string[] = [];
	const notifications: string[] = [];
	const editorPrefills: Array<string | undefined> = [];

	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return Response.json({ data: RELAY_MODELS.map((id) => ({ id })) });
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
		chatModels.push(body.model ?? "?");
		// model-b is the broken channel — every other model answers.
		if (body.model === "model-b") {
			return new Response("no such model", { status: 404 });
		}
		return Response.json({ choices: [{ message: { role: "assistant", content: "hi" } }] });
	}) as typeof fetch;

	let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
	extension({
		registerCommand(_name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) {
			command = definition;
		},
	} as never);
	assert.ok(command);
	const handler = command.handler;

	return {
		chatModels,
		notifications,
		editorPrefills,
		run: async (answers: string[], editorReply?: string) => {
			try {
				await handler("test", {
					hasUI: true,
					mode: "rpc",
					modelRegistry: { getAll: () => [] },
					ui: {
						select: async (_title: string, options: string[]) => {
							const next = answers.shift();
							// Out of answers: Esc leaves the provider list, ending the flow.
							if (next === undefined) return undefined;
							const picked = options.find((option) => option.includes(next));
							assert.ok(picked, `no option matching "${next}" in: ${options.join(" | ")}`);
							return picked;
						},
						editor: async (_title: string, prefill?: string) => {
							editorPrefills.push(prefill);
							assert.ok(editorReply !== undefined, "unexpected checklist editor");
							return editorReply;
						},
						notify: (message: string) => notifications.push(message),
					},
				} as never);
			} finally {
				globalThis.fetch = previousFetch;
			}
		},
	};
}

describe("/provider test", () => {
	it("chat-tests every configured model in one run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			writeRelay(dir);
			const h = harness();
			await h.run(["relay", "Test all 3 models"]);

			assert.deepEqual(h.chatModels, RELAY_MODELS);
			const report = h.notifications.join("\n");
			assert.ok(report.includes("Catalog probe: OK"), report);
			assert.ok(report.includes("Chat test (model-a): OK"), report);
			assert.ok(report.includes("Chat test (model-b): FAILED"), report);
			assert.ok(report.includes("Chat test (model-c): OK"), report);
			assert.deepEqual(h.editorPrefills, []); // no checklist in the "all" path
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("chat-tests only the models picked in the checklist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			writeRelay(dir);
			const h = harness();
			await h.run(["relay", "Select models to test"], "on model-a\noff model-b\non model-c");

			assert.deepEqual(h.chatModels, ["model-a", "model-c"]);
			const report = h.notifications.join("\n");
			assert.ok(report.includes("Chat test (model-a): OK"), report);
			assert.ok(report.includes("Chat test (model-c): OK"), report);
			assert.ok(!report.includes("model-b"), report);
			// Nothing is pre-checked, so the prefill lists every configured model as off.
			assert.deepEqual(h.editorPrefills, ["off model-a\noff model-b\noff model-c"]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tests the only configured model without asking", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const path = join(dir, "models.json");
			writeFileSync(
				path,
				JSON.stringify({
					providers: {
						relay: {
							baseUrl: "https://relay.test/v1",
							api: "openai-completions",
							models: [{ id: "model-a" }],
						},
					},
				}),
			);
			const h = harness();
			await h.run(["relay"]);

			assert.deepEqual(h.chatModels, ["model-a"]);
			assert.ok(h.notifications.join("\n").includes("Chat test (model-a): OK"));
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
