import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extension from "../index.ts";

describe("/provider models", () => {
	it("discovers and additively merges new models into an existing provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-models-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousFetch = globalThis.fetch;
		process.env.PI_CODING_AGENT_DIR = dir;

		try {
			const path = join(dir, "models.json");
			writeFileSync(
				path,
				JSON.stringify(
					{
						providers: {
							relay: {
								baseUrl: "https://relay.test/v1",
								models: [
									{
										id: "model-a",
										api: "openai-completions",
										contextWindow: 42,
										compat: { custom: true },
									},
								],
							},
						},
					},
					null,
					2,
				),
			);

			globalThis.fetch = async (url, init) => {
				assert.equal(String(url), "https://relay.test/v1/models");
				assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer resolved-key");
				assert.equal((init?.headers as Record<string, string>)["x-relay-scope"], "models");
				return new Response(
					JSON.stringify({
						data: [
							{ id: "model-a" },
							{ id: "model-b" },
							{ id: "model-b" },
							{ id: "model-c" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			};

			let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
			extension({
				registerCommand(
					_name: string,
					definition: { handler: (args: string, ctx: never) => Promise<void> },
				) {
					command = definition;
				},
			} as never);
			assert.ok(command);

			const selections = [
				"Discover and add new models",
				"Add all 1 new models",
				"Yes — add models",
			];
			const notifications: string[] = [];
			await command.handler("models relay", {
				hasUI: true,
				mode: "rpc",
				modelRegistry: {
					// model-c is already effective (for example inherited from a built-in
					// provider), so discovery must not write a custom replacement for it.
					refresh: async () => {},
					getAll: () => [{ provider: "relay", id: "model-c" }],
					getApiKeyAndHeaders: async () => ({
						ok: true,
						apiKey: "resolved-key",
						headers: { "x-relay-scope": "models" },
					}),
					getProviderAuth: async () => ({ auth: { apiKey: "resolved-key" } }),
				},
				ui: {
					select: async (_title: string, options: string[]) => {
						const next = selections.shift();
						assert.ok(next && options.includes(next));
						return next;
					},
					editor: async () => {
						throw new Error("manual editor should not open");
					},
					notify: (message: string) => notifications.push(message),
				},
			} as never);

			const saved = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(
				saved.providers.relay.models.map((model: { id: string }) => model.id),
				["model-a", "model-b"],
			);
			assert.deepEqual(saved.providers.relay.models[0], {
				id: "model-a",
				api: "openai-completions",
				contextWindow: 42,
				compat: { custom: true },
			});
			assert.equal(saved.providers.relay.models[1].api, "openai-completions");
			assert.ok(notifications.some((message) => message.includes("Added 1 model(s)")));
		} finally {
			globalThis.fetch = previousFetch;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes selected custom model entries without changing the others", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-models-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;

		try {
			const path = join(dir, "models.json");
			writeFileSync(
				path,
				JSON.stringify(
					{
						providers: {
							relay: {
								models: [
									{ id: "model-a", contextWindow: 42 },
									{ id: "model-b", compat: { custom: true } },
								],
							},
						},
					},
					null,
					2,
				),
			);

			let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
			extension({
				registerCommand(
					_name: string,
					definition: { handler: (args: string, ctx: never) => Promise<void> },
				) {
					command = definition;
				},
			} as never);
			assert.ok(command);

			const selections = ["Remove configured models", "Yes — remove models"];
			const notifications: string[] = [];
			await command.handler("models relay", {
				hasUI: true,
				mode: "rpc",
				modelRegistry: { getAll: () => [] },
				ui: {
					select: async (_title: string, options: string[]) => {
						const next = selections.shift();
						assert.ok(next && options.includes(next));
						return next;
					},
					editor: async () => "off model-a\non model-b",
					notify: (message: string) => notifications.push(message),
				},
			} as never);

			const saved = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(saved.providers.relay.models, [{ id: "model-a", contextWindow: 42 }]);
			assert.ok(notifications.some((message) => message.includes("Removed 1 model(s)")));
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves an inferred provider API when removing the last model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-models-"));
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
							models: [{ id: "model-a", api: "openai-completions" }],
						},
					},
				}),
			);

			let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
			extension({
				registerCommand(
					_name: string,
					definition: { handler: (args: string, ctx: never) => Promise<void> },
				) {
					command = definition;
				},
			} as never);
			assert.ok(command);

			const selections = ["Remove configured models", "Yes — remove models"];
			await command.handler("models relay", {
				hasUI: true,
				mode: "rpc",
				modelRegistry: { getAll: () => [] },
				ui: {
					select: async (_title: string, options: string[]) => {
						const next = selections.shift();
						assert.ok(next && options.includes(next));
						return next;
					},
					editor: async () => "on model-a",
					notify: () => {},
				},
			} as never);

			const saved = JSON.parse(readFileSync(path, "utf8"));
			assert.equal(saved.providers.relay.api, "openai-completions");
			assert.deepEqual(saved.providers.relay.models, []);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
