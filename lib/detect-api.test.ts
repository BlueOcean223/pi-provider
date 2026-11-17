import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatPing, listOpenAIModels } from "./detect-api.ts";

interface Call {
	url: string;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

type Responder = (call: Call) => { status: number; body?: unknown };

const realFetch = globalThis.fetch;
const calls: Call[] = [];

function mockFetch(respond: Responder): void {
	calls.length = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			headers: (init?.headers ?? {}) as Record<string, string>,
		};
		calls.push(call);
		const res = respond(call);
		return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
			status: res.status,
		});
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

const openaiReply = { choices: [{ message: { role: "assistant", content: "hi" } }] };

describe("listOpenAIModels", () => {
	it("applies resolved provider headers and allows case-insensitive removals", async () => {
		mockFetch(() => ({ status: 200, body: { data: [{ id: "model-a" }] } }));

		const result = await listOpenAIModels({
			baseUrl: "https://relay.test/v1",
			apiKey: "default-key",
			headers: {
				authorization: null,
				"x-api-key": "header-key",
				"x-relay-scope": "models",
			},
		});

		assert.deepEqual(result.models, [{ id: "model-a", name: undefined }]);
		assert.equal(calls[0]!.headers.Authorization, undefined);
		assert.equal(calls[0]!.headers["x-api-key"], "header-key");
		assert.equal(calls[0]!.headers["x-relay-scope"], "models");
	});

	// Entry shapes as the servers build them: vLLM's ModelCard
	// (vllm/entrypoints/serve/engine/protocol.py; SGLang's is the same),
	// llama.cpp's single-model and router lists (tools/server/server-context.cpp,
	// server-models.cpp), the Magpie gateway's (modelObject and toolsTold in
	// internal/gateway/gateway.go), OpenRouter's, Groq's and new-api's
	// OpenAIModels (relaykit/dto/pricing.go).
	it("reads the context window and image input local servers report", async () => {
		mockFetch(() => ({
			status: 200,
			body: {
				object: "list",
				data: [
					{
						id: "Qwen/Qwen3-8B", object: "model", created: 1, owned_by: "vllm",
						root: "Qwen/Qwen3-8B", parent: null, max_model_len: 32768, permission: [],
					},
					{
						id: "gemma-3-12b-it", aliases: [], tags: [], object: "model",
						architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
						created: 1, owned_by: "llamacpp",
						meta: { vocab_type: 1, n_vocab: 262144, n_ctx: 16384, n_ctx_train: 131072 },
					},
					{
						id: "qwen3-8b", aliases: [], tags: [], object: "model", owned_by: "llamacpp", created: 1,
						status: { value: "loaded", args: ["--ctx-size", "16384"] },
						architecture: { input_modalities: ["text"], output_modalities: ["text"] },
						source: "cache", can_remove: true, context_length: 40960,
					},
					{
						id: "deepseek/deepseek-flash", object: "model", type: "model", created: 0,
						created_at: "2025-01-01T00:00:00Z", owned_by: "deepseek", display_name: "DeepSeek Flash",
						reasoning: true, supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }, { effort: "max" }],
						reasoning_levels: ["none", "high", "max"],
						context_window: 1048576, context_length: 1048576, max_input_tokens: 1048576,
						max_output_tokens: 393216,
						modalities: { input: ["text", "image"], output: ["text"] },
						tool_call: true, supported_parameters: ["tools", "tool_choice", "reasoning"],
					},
					{
						id: "moonshot/kimi-k3", object: "model", type: "model", created: 0,
						created_at: "2025-01-01T00:00:00Z", owned_by: "moonshot", display_name: "Kimi K3",
						reasoning: false, supported_reasoning_levels: [], reasoning_levels: [],
						context_window: 262144, context_length: 262144, max_input_tokens: 262144,
						modalities: { input: ["text"], output: ["text"] },
						tool_call: true, supported_parameters: ["tools", "tool_choice"],
					},
					{
						id: "tencent/hy4-flash", canonical_slug: "tencent/hy4-flash-20261116", name: "Tencent: Hy4 flash",
						created: 1, context_length: 1048576,
						architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
						top_provider: { context_length: 1048576, max_completion_tokens: 65536, is_moderated: false },
						supported_parameters: ["include_reasoning", "max_tokens", "reasoning", "tools"],
						reasoning: { mandatory: false, default_enabled: true },
					},
					{
						id: "llama-3.3-70b-versatile", object: "model", created: 1, owned_by: "Meta", active: true,
						context_window: 131072, max_completion_tokens: 32768,
					},
					{
						id: "gpt-6-sol", object: "model", created: 1626777600, owned_by: "openai",
						supported_endpoint_types: ["openai"],
					},
				],
			},
		}));

		const result = await listOpenAIModels({ baseUrl: "http://localhost:8000/v1" });

		assert.deepEqual(result.models, [
			{ id: "Qwen/Qwen3-8B", name: undefined, contextWindow: 32768 },
			// The per-slot runtime context, not the training context.
			{ id: "gemma-3-12b-it", name: undefined, contextWindow: 16384, input: ["text", "image"] },
			{ id: "qwen3-8b", name: undefined, contextWindow: 40960 },
			{
				id: "deepseek/deepseek-flash",
				name: "DeepSeek Flash",
				contextWindow: 1048576,
				input: ["text", "image"],
				maxTokens: 393216,
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
			},
			{ id: "moonshot/kimi-k3", name: "Kimi K3", contextWindow: 262144 },
			// OpenRouter's reasoning is an object and its reply limit sits under top_provider: neither is read.
			{ id: "tencent/hy4-flash", name: "Tencent: Hy4 flash", contextWindow: 1048576, input: ["text", "image"] },
			{ id: "llama-3.3-70b-versatile", name: undefined, contextWindow: 131072 },
			{ id: "gpt-6-sol", name: undefined },
		]);
	});

	it("drops context windows that aren't positive whole numbers", async () => {
		mockFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "zero", max_model_len: 0 },
					{ id: "negative", meta: { n_ctx: -1 } },
					{ id: "string", context_length: "32768" },
					{ id: "fraction", context_length: 1.5 },
					{ id: "falls-through", max_model_len: null, meta: null, context_length: 8192 },
					{ id: "odd-shapes", meta: "n_ctx", architecture: { input_modalities: "image" } },
					{ id: "odd-magpie", context_window: "262144", modalities: ["text", "image"] },
				],
			},
		}));

		const result = await listOpenAIModels({ baseUrl: "http://localhost:8000/v1" });

		assert.deepEqual(result.models, [
			{ id: "zero", name: undefined },
			{ id: "negative", name: undefined },
			{ id: "string", name: undefined },
			{ id: "fraction", name: undefined },
			{ id: "falls-through", name: undefined, contextWindow: 8192 },
			{ id: "odd-shapes", name: undefined },
			{ id: "odd-magpie", name: undefined },
		]);
	});

	it("maps the reasoning levels a server lists onto pi's thinking levels", async () => {
		mockFetch(() => ({
			status: 200,
			body: {
				data: [
					// Magpie lists a vendor's own words (its catalog's EffortAliases) as they are
					{ id: "aliases", reasoning: true, reasoning_levels: ["light", "medium", "high", "extra_high"] },
					{ id: "all", reasoning: true, reasoning_levels: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
					// thinks, but no level of pi's to pick
					{ id: "no-levels", reasoning: true, reasoning_levels: [] },
					{ id: "none-and-ultra", reasoning: true, reasoning_levels: ["none", "ultra"] },
					// levels without reasoning: true don't count
					{ id: "not-thinking", reasoning: false, reasoning_levels: ["high"] },
					{ id: "string-flag", reasoning: "true", reasoning_levels: ["high"] },
					{ id: "odd-levels", reasoning: true, reasoning_levels: "high", max_output_tokens: "8192", display_name: "" },
					{ id: "mixed", reasoning: true, reasoning_levels: [null, 3, "", "HIGH"], max_output_tokens: 0 },
				],
			},
		}));

		const result = await listOpenAIModels({ baseUrl: "http://localhost:3425/v1" });

		assert.deepEqual(result.models, [
			{
				id: "aliases",
				name: undefined,
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: "light", medium: "medium", high: "high", xhigh: "extra_high" },
			},
			{
				id: "all",
				name: undefined,
				reasoning: true,
				thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			},
			{ id: "no-levels", name: undefined, reasoning: true },
			{ id: "none-and-ultra", name: undefined, reasoning: true },
			{ id: "not-thinking", name: undefined },
			{ id: "string-flag", name: undefined },
			{ id: "odd-levels", name: undefined, reasoning: true },
			{
				id: "mixed",
				name: undefined,
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "HIGH" },
			},
		]);
	});
});

describe("chatPing", () => {
	it("succeeds on a valid openai-completions reply", async () => {
		mockFetch(() => ({ status: 200, body: openaiReply }));
		const res = await chatPing({
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			model: "gpt-4o",
			apiKey: "sk-test",
		});
		assert.equal(res.ok, true);
		assert.equal(res.status, 200);
		assert.deepEqual(
			calls.map((c) => c.url),
			["https://relay.test/v1/chat/completions"],
		);
		assert.equal(calls[0]!.headers.Authorization, "Bearer sk-test");
		assert.equal(calls[0]!.body.model, "gpt-4o");
	});

	it("falls through to the /v1 candidate on 404, but only on 404/405", async () => {
		mockFetch((call) =>
			call.url.includes("/v1/") ? { status: 200, body: openaiReply } : { status: 404 },
		);
		const res = await chatPing({
			baseUrl: "https://relay.test",
			api: "openai-completions",
			model: "m",
		});
		assert.equal(res.ok, true);
		assert.deepEqual(
			calls.map((c) => c.url),
			["https://relay.test/chat/completions", "https://relay.test/v1/chat/completions"],
		);
	});

	it("does not try the next URL on auth errors (401)", async () => {
		mockFetch(() => ({ status: 401, body: { error: "bad key" } }));
		const res = await chatPing({
			baseUrl: "https://relay.test",
			api: "openai-completions",
			model: "m",
		});
		assert.equal(res.ok, false);
		assert.equal(res.status, 401);
		assert.equal(calls.length, 1);
	});

	it("retries with max_completion_tokens when max_tokens is rejected", async () => {
		mockFetch((call) =>
			"max_completion_tokens" in call.body
				? { status: 200, body: openaiReply }
				: { status: 400, body: { error: { message: "Use 'max_completion_tokens' instead of 'max_tokens'" } } },
		);
		const res = await chatPing({
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			model: "o1",
		});
		assert.equal(res.ok, true);
		assert.equal(calls.length, 2);
		assert.equal(calls[0]!.body.max_tokens, 16);
		assert.equal(calls[1]!.body.max_completion_tokens, 16);
	});

	it("fails when HTTP 200 but the body is not a chat reply for the protocol", async () => {
		mockFetch(() => ({ status: 200, body: { object: "list", data: [] } }));
		const res = await chatPing({
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			model: "m",
		});
		assert.equal(res.ok, false);
		assert.match(res.detail, /doesn't look like/);
	});

	it("sends anthropic-version and hits /v1/messages for anthropic-messages", async () => {
		mockFetch(() => ({ status: 200, body: { type: "message", content: [] } }));
		const res = await chatPing({
			baseUrl: "https://relay.test",
			api: "anthropic-messages",
			model: "claude-sonnet-4",
			apiKey: "sk-ant",
		});
		assert.equal(res.ok, true);
		assert.equal(calls[0]!.url, "https://relay.test/v1/messages");
		assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
	});

	it("uses only x-goog-api-key (no Bearer) for google-generative-ai", async () => {
		mockFetch(() => ({ status: 200, body: { candidates: [] } }));
		const res = await chatPing({
			baseUrl: "https://relay.test",
			api: "google-generative-ai",
			model: "gemini-2.0-flash",
			apiKey: "g-key",
		});
		assert.equal(res.ok, true);
		assert.equal(calls[0]!.url, "https://relay.test/v1beta/models/gemini-2.0-flash:generateContent");
		assert.equal(calls[0]!.headers["x-goog-api-key"], "g-key");
		assert.equal(calls[0]!.headers.Authorization, undefined);
	});

	it("stops before sending when the signal is already aborted", async () => {
		mockFetch(() => ({ status: 200, body: openaiReply }));
		const controller = new AbortController();
		controller.abort();
		const res = await chatPing({
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			model: "m",
			signal: controller.signal,
		});
		assert.equal(res.ok, false);
		assert.equal(calls.length, 0);
	});
});
