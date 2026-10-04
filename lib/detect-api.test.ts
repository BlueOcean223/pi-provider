import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatPing, listOpenAIModels, parseOpenAIModels } from "./detect-api.ts";

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
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

	it("uses advertised context, output and input modalities in priority order", () => {
		const [model] = parseOpenAIModels({ data: [{
			id: "vision-model",
			context_window: 262144,
			context_length: 131072,
			max_tokens: 64000,
			max_output_tokens: 65536,
			architecture: { input_modalities: ["text", "image", "audio", "image"] },
			model_info: { max_input_tokens: 32000, max_output_tokens: 8192, input_modalities: ["text"] },
		}] });
		assert.deepEqual(model, {
			id: "vision-model", name: undefined, contextWindow: 262144,
			maxTokens: 65536, input: ["text", "image"],
		});
	});

	it("falls through missing and invalid fields without guessing from model ids", () => {
		const models = parseOpenAIModels({ data: [
			{ id: "named-128k", context_window: 0, context_length: "262144", model_info: { max_output_tokens: 65536 } },
			{ id: "nested", model_info: { max_input_tokens: 131072, input_modalities: ["image"] } },
			{ id: "flat", max_tokens: 4096, max_output_tokens: -1, model_info: { max_output_tokens: 1024 } },
			{ id: "unknown", context_window: "oops", max_tokens: -42, max_output_tokens: 0 },
		] });
		assert.equal(models[0]?.contextWindow, 262144);
		assert.equal(models[0]?.maxTokens, 65536);
		assert.equal(models[1]?.contextWindow, 131072);
		assert.deepEqual(models[1]?.input, ["image"]);
		assert.equal(models[2]?.contextWindow, 4096);
		assert.equal(models[2]?.maxTokens, 1024);
		assert.deepEqual(models[3], { id: "unknown", name: undefined });
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
