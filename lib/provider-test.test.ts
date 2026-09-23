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
	chatHeaders: Array<Record<string, string>>;
	notifications: string[];
	selectTitles: string[];
	run: (args: string, answers: string[], registry?: unknown) => Promise<void>;
}

function harness(): Harness {
	const chatModels: string[] = [];
	const chatHeaders: Array<Record<string, string>> = [];
	const notifications: string[] = [];
	const selectTitles: string[] = [];

	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return Response.json({ data: RELAY_MODELS.map((id) => ({ id })) });
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
		chatModels.push(body.model ?? "?");
		chatHeaders.push(init?.headers as Record<string, string>);
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
		chatHeaders,
		notifications,
		selectTitles,
		run: async (args: string, answers: string[], registry: unknown = { getAll: () => [] }) => {
			try {
				await handler(args, {
					hasUI: true,
					mode: "rpc",
					modelRegistry: registry,
					ui: {
						select: async (title: string, options: string[]) => {
							selectTitles.push(title);
							const next = answers.shift();
							// Out of answers: Esc.
							if (next === undefined) return undefined;
							const picked = options.find((option) => option.includes(next));
							assert.ok(picked, `no option matching "${next}" in: ${options.join(" | ")}`);
							return picked;
						},
						editor: async () => {
							throw new Error("unexpected editor");
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

function withAgentDir(fn: (dir: string) => Promise<void>) {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await fn(dir);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

describe("/provider test", () => {
	it(
		"picks the provider, then chat-tests every configured model in one run",
		withAgentDir(async (dir) => {
			writeRelay(dir);
			const h = harness();
			await h.run("test", ["relay"]);

			assert.deepEqual(h.chatModels, RELAY_MODELS);
			assert.equal(h.selectTitles.length, 1); // the provider picker, nothing else
			const report = h.notifications.join("\n");
			assert.ok(report.includes("Catalog probe: OK"), report);
			assert.ok(report.includes("Chat test (model-a): OK — replied"), report);
			assert.ok(report.includes("Chat test (model-b): FAILED"), report);
			assert.ok(report.includes("Chat test (model-c): OK"), report);
		}),
	);

	it(
		"tests the provider named on the command line without asking",
		withAgentDir(async (dir) => {
			writeRelay(dir);
			const h = harness();
			await h.run("test RELAY", []);

			assert.deepEqual(h.selectTitles, []);
			assert.deepEqual(h.chatModels, RELAY_MODELS);
		}),
	);

	it(
		"sends the key pi resolves (e.g. from /login) and the provider's headers",
		withAgentDir(async (dir) => {
			writeFileSync(
				join(dir, "models.json"),
				JSON.stringify({
					providers: {
						relay: {
							baseUrl: "https://relay.test/v1",
							api: "openai-completions",
							headers: { "x-team": "$PI_PROVIDER_TEST_TEAM" },
							models: [{ id: "model-a" }],
						},
					},
				}),
			);
			process.env.PI_PROVIDER_TEST_TEAM = "blue";
			try {
				const h = harness();
				await h.run("test relay", [], {
					getAll: () => [],
					getProviderAuth: async () => ({ auth: { apiKey: "from-login" } }),
				});
				assert.deepEqual(h.chatModels, ["model-a"]);
				assert.equal(h.chatHeaders[0]!.Authorization, "Bearer from-login");
				assert.equal(h.chatHeaders[0]!["x-team"], "blue");
				assert.ok(!h.notifications.join("\n").includes("No API key"), h.notifications.join("\n"));
			} finally {
				delete process.env.PI_PROVIDER_TEST_TEAM;
			}
		}),
	);
});
