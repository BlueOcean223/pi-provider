import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import extension from "../index.ts";
import { suggestProviderId } from "../flows/add.ts";
import { readModelsFile } from "./models-json.ts";
import { KEY, type Step, tuiHarness } from "./testing/tui-harness.ts";

/**
 * End-to-end flows in TUI mode: real components, scripted keys, a fake model
 * registry that mirrors models.json the way pi's does.
 */

interface StreamCall {
	provider: string;
	model: string;
	systemPrompt?: string;
	maxTokens?: number;
	reasoning?: string;
}

let dir: string;
let previousAgentDir: string | undefined;
let previousFetch: typeof fetch;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-provider-flows-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	previousFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = previousFetch;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

function writeModels(providers: Record<string, unknown>): void {
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }, null, 2));
}

function savedProviders(): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers;
}

/** Screen text with wrapped lines joined, for long notes. */
function flat(text: string): string {
	return text.replace(/\s+/g, " ");
}

function relayCatalog(ids: string[]): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith("/models")) return Response.json({ data: ids.map((id) => ({ id })) });
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

interface RegistryExtras {
	/** Built-in models pi has without models.json. */
	builtin?: Array<{ provider: string; id: string }>;
	/** getProviderAuthStatus() answers per provider. */
	authSources?: Record<string, "stored" | "runtime" | "environment">;
}

/**
 * Registry stub: models come from models.json (like pi's registry after a
 * refresh) plus any built-ins; `respond` decides each chat test's outcome.
 */
function fakeRegistry(
	respond: (call: StreamCall, compat: Record<string, unknown> | undefined) => { error?: string; status?: number },
	extras: RegistryExtras = {},
) {
	const calls: StreamCall[] = [];
	const models = () => {
		const providers = readModelsFile().providers ?? {};
		const custom = Object.entries(providers).flatMap(([provider, cfg]) =>
			(cfg.models ?? []).map((m) => ({
				provider,
				id: m.id,
				api: m.api ?? cfg.api,
				reasoning: Boolean(m.reasoning),
				compat: cfg.compat,
			})),
		);
		const builtin = (extras.builtin ?? [])
			.filter((m) => !custom.some((c) => c.provider === m.provider && c.id === m.id))
			.map((m) => ({ ...m, api: "openai-completions", reasoning: false, compat: providers[m.provider]?.compat }));
		return [...custom, ...builtin];
	};
	return {
		calls,
		registry: {
			getProviderAuthStatus: (provider: string) => {
				const source = extras.authSources?.[provider];
				return source ? { configured: true, source } : { configured: false };
			},
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getAll: models,
			find: (provider: string, id: string) => models().find((m) => m.provider === provider && m.id === id),
			getApiKeyAndHeaders: async (model: { provider: string }) => ({
				ok: true,
				apiKey: readModelsFile().providers?.[model.provider]?.apiKey,
				headers: {},
			}),
			streamSimple: (
				model: { provider: string; id: string; compat?: Record<string, unknown> },
				context: { systemPrompt?: string },
				options: { maxTokens?: number; reasoning?: string; onResponse?: (r: { status: number; headers: object }) => void },
			) => {
				const call: StreamCall = {
					provider: model.provider,
					model: model.id,
					systemPrompt: context.systemPrompt,
					maxTokens: options.maxTokens,
					reasoning: options.reasoning,
				};
				calls.push(call);
				const outcome = respond(call, model.compat);
				options.onResponse?.({ status: outcome.status ?? (outcome.error ? 400 : 200), headers: {} });
				return {
					result: async () =>
						outcome.error
							? { role: "assistant", stopReason: "error", errorMessage: outcome.error, content: [] }
							: { role: "assistant", stopReason: "stop", responseModel: model.id, content: [] },
				};
			},
		},
	};
}

async function runCommand(args: string, steps: Step[], registry: unknown) {
	const switched: string[] = [];
	let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
	extension({
		registerCommand(_name: string, def: { handler: typeof handler }) {
			handler = def.handler;
		},
		setModel: async (model: { provider: string; id: string }) => {
			switched.push(`${model.provider}/${model.id}`);
			return true;
		},
	} as never);
	const h = tuiHarness(steps);
	await handler!(args, { hasUI: true, mode: "tui", modelRegistry: registry, ui: h.ui } as never);
	assert.equal(h.remaining(), 0, `not every scripted screen was shown\n${h.notifications.join("\n")}`);
	return { ...h, switched };
}

describe("/provider add (TUI)", () => {
	it("keeps entered values when stepping back, then saves, tests and switches", async () => {
		relayCatalog(["gpt-4o", "claude-sonnet-4-6", "broken-model"]);
		const { calls, registry } = fakeRegistry(() => ({}));

		const { notifications, switched } = await runCommand(
			"add",
			[
				// Base URL: the placeholder is visible, the trailing slash is dropped.
				(s) => {
					assert.ok(s.text().includes("https://api.example.com/v1"), s.text());
					s.type("https://api.relay-one.com/v1/");
					s.press(KEY.enter);
				},
				(s) => {
					assert.ok(s.text().includes("API key"));
					s.type("sk-abcdef123456");
					s.press(KEY.enter);
				},
				// Protocol: go back once…
				(s) => {
					assert.ok(s.text().includes("OpenAI Chat Completions"));
					s.press(KEY.esc);
				},
				// …and the key is still there (pi's ui.input would show an empty field).
				(s) => {
					assert.ok(s.text().includes("sk-abcdef123456"), s.text());
					s.press(KEY.enter);
				},
				(s) => s.press(KEY.enter),
				// Checklist: Enter with nothing checked is rejected inline.
				(s) => {
					s.press(KEY.enter);
					assert.ok(s.text().includes("Select at least one model"), s.text());
					s.press(KEY.space, KEY.down, KEY.space, KEY.enter);
				},
				// Review: every field on one page, cursor on Save.
				(s) => {
					const text = s.text();
					assert.ok(text.includes("relay-one"), text);
					assert.ok(text.includes("2 selected"), text);
					assert.ok(text.includes("stored in models.json · sk-…3456"), text);
					assert.ok(!text.includes("sk-abcdef123456"), "review must not print the key");
					s.press(KEY.enter);
				},
				// Test panel: pick the first passing model.
				async (s) => {
					await s.waitFor("run again");
					assert.ok(s.text().includes("✓ Chat test (gpt-4o)"), s.text());
					assert.ok(s.text().includes("use model"), s.text());
					s.press(KEY.enter);
				},
			],
			registry,
		);

		const saved = savedProviders()["relay-one"]!;
		assert.equal(saved.baseUrl, "https://api.relay-one.com/v1");
		assert.equal(saved.api, "openai-completions");
		assert.equal(saved.apiKey, "sk-abcdef123456");
		assert.deepEqual(
			(saved.models as Array<{ id: string }>).map((m) => m.id),
			["gpt-4o", "claude-sonnet-4-6"],
		);
		assert.deepEqual(
			calls.map((c) => c.model),
			["gpt-4o", "claude-sonnet-4-6"],
		);
		assert.ok(calls.every((c) => c.systemPrompt && c.maxTokens === 16));
		assert.deepEqual(switched, ["relay-one/gpt-4o"]);
		assert.deepEqual(notifications, ["Saved relay-one with 2 model(s) · Now using relay-one/gpt-4o"]);
	});
});

describe("provider ids pi already has (TUI)", () => {
	it("skips built-in ids when suggesting and warns when one is typed", async () => {
		relayCatalog(["deepseek-chat"]);
		const { registry } = fakeRegistry(() => ({}), {
			builtin: [{ provider: "deepseek", id: "deepseek-reasoner" }],
			authSources: { deepseek: "stored" },
		});

		await runCommand(
			"add",
			[
				(s) => {
					s.type("https://api.deepseek.com/v1");
					s.press(KEY.enter);
				},
				(s) => {
					s.type("sk-relaykey1234");
					s.press(KEY.enter);
				},
				(s) => s.press(KEY.enter),
				(s) => s.press(KEY.space, KEY.enter),
				// The suggestion steps around the built-in id, without warnings.
				(s) => {
					const text = flat(s.text());
					assert.ok(text.includes("deepseek-2"), text);
					assert.ok(!text.includes("already has"), text);
					s.press(KEY.down, KEY.down, KEY.enter);
				},
				(s) => {
					s.press(KEY.backspace, KEY.backspace, KEY.enter);
				},
				// Typed on purpose: merging and the /login credential are spelled out.
				(s) => {
					const text = flat(s.text());
					assert.ok(text.includes('"deepseek" is a provider pi already has'), text);
					assert.ok(text.includes("its own models also send requests to api.deepseek.com/v1"), text);
					assert.ok(text.includes("pi sends your /login credential (auth.json) to api.deepseek.com/v1, not the API key set here"), text);
					s.press(KEY.up, KEY.up, KEY.enter);
				},
				async (s) => {
					await s.waitFor("run again");
					assert.ok(flat(s.text()).includes("not the API key set here"), s.text());
					s.press(KEY.esc);
				},
			],
			registry,
		);

		assert.deepEqual(Object.keys(savedProviders()), ["deepseek"]);
	});
});

describe("/provider proxy (TUI)", () => {
	it("says which credential the relay receives when /login outranks models.json", async () => {
		relayCatalog(["claude-sonnet-4-6"]);
		const { registry } = fakeRegistry(() => ({}), {
			builtin: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
			authSources: { anthropic: "stored" },
		});

		await runCommand(
			"proxy",
			[
				(s) => {
					assert.ok(s.text().includes("anthropic"), s.text());
					s.press(KEY.enter);
				},
				(s) => {
					s.type("https://relay.test");
					s.press(KEY.enter);
				},
				// No key: the relay would get the /login credential.
				(s) => s.press(KEY.enter),
				(s) => {
					const text = flat(s.text());
					assert.ok(text.includes("relay.test receives your /login credential (auth.json)"), text);
					assert.ok(text.includes("remove it with /logout"), text);
					s.press(KEY.up, KEY.enter);
				},
				(s) => {
					s.type("sk-relay-5678");
					s.press(KEY.enter);
				},
				// A key set here is never sent while /login wins.
				(s) => {
					const text = flat(s.text());
					assert.ok(text.includes("· not used"), text);
					assert.ok(text.includes("pi sends your /login credential (auth.json) to relay.test, not the API key set here"), text);
					s.press(KEY.down, KEY.enter);
				},
				async (s) => {
					await s.waitFor("run again");
					s.press(KEY.esc);
				},
			],
			registry,
		);

		assert.deepEqual(savedProviders().anthropic, { baseUrl: "https://relay.test", apiKey: "sk-relay-5678" });
	});
});

describe("/provider test (TUI)", () => {
	it("offers the compat flag a relay's error points at, applies it and re-tests", async () => {
		writeModels({
			relay: {
				baseUrl: "https://relay.test/v1",
				api: "openai-completions",
				apiKey: "sk-test",
				models: [
					{ id: "o-reasoner", reasoning: true },
					{ id: "plain", reasoning: false },
				],
			},
		});
		relayCatalog(["o-reasoner", "plain"]);
		const { calls, registry } = fakeRegistry((call, compat) =>
			call.model === "o-reasoner" && compat?.supportsDeveloperRole !== false
				? { error: "400 Invalid value: 'developer' is not a supported role" }
				: {},
		);

		await runCommand(
			"test relay",
			[
				async (s) => {
					await s.waitFor("run again");
					const text = s.text();
					assert.ok(text.includes('relay rejects the "developer" role'), text);
					assert.ok(text.includes("apply compat fix"), text);
					s.press("c");
				},
				async (s) => {
					await s.waitFor("run again");
					const text = s.text();
					assert.ok(text.includes("supportsDeveloperRole=false"), text);
					assert.ok(text.includes("✓ Chat test (o-reasoner)"), text);
					// Only the failed model is re-tested.
					assert.ok(!text.includes("Chat test (plain)"), text);
					s.press(KEY.esc);
				},
			],
			registry,
		);

		assert.deepEqual(savedProviders().relay!.compat, { supportsDeveloperRole: false });
		assert.deepEqual(
			calls.map((c) => c.model),
			["o-reasoner", "plain", "o-reasoner"],
		);
		// Reasoning models are tested with reasoning on, like a real session.
		assert.equal(calls[0]!.reasoning, "low");
		assert.equal(calls[1]!.reasoning, undefined);
	});

	it("removes failing models from the panel", async () => {
		writeModels({
			relay: {
				baseUrl: "https://relay.test/v1",
				api: "openai-completions",
				apiKey: "sk-test",
				models: [{ id: "good" }, { id: "gone" }],
			},
		});
		relayCatalog(["good"]);
		const { registry } = fakeRegistry((call) => (call.model === "gone" ? { error: "404 model not found", status: 404 } : {}));

		const { notifications } = await runCommand(
			"test relay",
			[
				async (s) => {
					await s.waitFor("run again");
					assert.ok(s.text().includes("remove 1 failing"), s.text());
					s.press("x");
				},
				(s) => {
					assert.ok(s.text().includes("- gone"), s.text());
					s.press(KEY.enter);
				},
			],
			registry,
		);

		assert.deepEqual(savedProviders().relay!.models, [{ id: "good" }]);
		assert.deepEqual(notifications, ["Removed 1 failing model(s) from relay"]);
	});
});

describe("/provider <id> detail page (TUI)", () => {
	it("replaces the API key without touching models or other fields", async () => {
		writeModels({
			relay: {
				baseUrl: "https://relay.test/v1",
				api: "openai-completions",
				apiKey: "sk-old-key-000000",
				headers: { "x-team": "a" },
				models: [{ id: "model-a", contextWindow: 42 }],
			},
		});
		const { registry } = fakeRegistry(() => ({}));

		await runCommand(
			"relay",
			[
				(s) => {
					assert.ok(s.text().includes("stored in models.json · sk-…0000"), s.text());
					s.press(KEY.down, KEY.down, KEY.enter); // Base URL → Protocol → API key
				},
				(s) => {
					assert.ok(s.text().includes("Leave empty to keep the stored key"), s.text());
					assert.ok(!s.text().includes("sk-old-key-000000"), "a literal key is never prefilled");
					s.type("sk-new-key-999999");
					s.press(KEY.enter);
				},
				(s) => {
					assert.ok(s.text().includes("✓ API key updated"), s.text());
					s.press(KEY.esc);
				},
			],
			registry,
		);

		assert.deepEqual(savedProviders().relay, {
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			headers: { "x-team": "a" },
			models: [{ id: "model-a", contextWindow: 42 }],
			apiKey: "sk-new-key-999999",
		});
	});
});

describe("/provider home (TUI)", () => {
	it("tests a provider with t and shows the result on its row", async () => {
		writeModels({
			relay: { baseUrl: "https://relay.test/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m" }] },
		});
		relayCatalog(["m"]);
		const { registry } = fakeRegistry(() => ({}));

		await runCommand(
			"",
			[
				(s) => {
					assert.ok(s.text().includes("relay.test/v1 · openai-completions · 1 model"), s.text());
					assert.ok(s.text().includes("t test"), s.text());
					s.press("t");
				},
				async (s) => {
					await s.waitFor("run again");
					s.press(KEY.esc);
				},
				(s) => {
					assert.ok(s.text().includes("✓ 1/1"), s.text());
					s.press(KEY.esc);
				},
			],
			registry,
		);
	});
});

describe("suggestProviderId", () => {
	it("derives an id from the host and keeps it unique", () => {
		assert.equal(suggestProviderId("https://api.deepseek.com/v1", []), "deepseek");
		assert.equal(suggestProviderId("https://relay.foo-ai.com.cn/v1", []), "foo-ai");
		assert.equal(suggestProviderId("https://api.openai.com/v1", []), "openai");
		assert.equal(suggestProviderId("http://localhost:11434/v1", []), "local-server");
		assert.equal(suggestProviderId("http://127.0.0.1:8080/v1", []), "local-server");
		// Subcommand names are never suggested: `/provider test` must stay a command.
		assert.equal(suggestProviderId("https://api.test.com/v1", []), "test-2");
		assert.equal(suggestProviderId("https://api.deepseek.com", ["deepseek", "deepseek-2"]), "deepseek-3");
		assert.equal(suggestProviderId("not a url", []), "my-relay");
	});
});
