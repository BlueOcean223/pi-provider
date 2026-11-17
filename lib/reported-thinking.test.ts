import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as googleStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { enrichModelEntry } from "./official-catalog.ts";
import { reportedThinking } from "./reported-thinking.ts";
import type { ProviderApi } from "./types.ts";

describe("reportedThinking", () => {
	it("marks the standard levels a server doesn't list unsupported", () => {
		assert.deepEqual(reportedThinking(["low", "medium", "high"], "openai-completions"), {
			thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high" },
		});
	});

	it("sends a vendor's own words as the server spells them", () => {
		assert.deepEqual(reportedThinking(["light", "medium", "high", "extra_high"], "openai-responses"), {
			thinkingLevelMap: { minimal: null, low: "light", medium: "medium", high: "high", xhigh: "extra_high" },
		});
	});

	it("turns a listed none into off and leaves off alone otherwise", () => {
		assert.equal(reportedThinking(["none", "high"], "openai-completions").thinkingLevelMap?.off, "none");
		assert.equal(reportedThinking(["high"], "openai-completions").thinkingLevelMap?.off, undefined);
	});

	it("has Anthropic send the level as an effort", () => {
		assert.deepEqual(reportedThinking(["high", "max"], "anthropic-messages").compat, { forceAdaptiveThinking: true });
		assert.equal(reportedThinking(["high", "max"], "openai-completions").compat, undefined);
	});

	it("keeps Google to the levels its API takes, by their standard names", () => {
		assert.deepEqual(reportedThinking(["none", "light", "high", "xhigh", "max"], "google-generative-ai"), {
			thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high" },
		});
		assert.deepEqual(reportedThinking(["xhigh", "max"], "google-generative-ai"), {});
	});

	it("gives nothing when no listed level is one pi can send", () => {
		assert.deepEqual(reportedThinking(["none", "ultra"], "openai-completions"), {});
		assert.deepEqual(reportedThinking([], "anthropic-messages"), {});
		assert.deepEqual(reportedThinking(undefined, "openai-completions"), {});
	});
});

// What pi itself puts in the request for a saved entry: each API module's
// streamSimple, stopped at onPayload before anything is sent.
const realFetch = globalThis.fetch;

const STREAMS: Record<ProviderApi, (model: Model<Api>, options: SimpleStreamOptions) => AsyncIterable<unknown>> = {
	"openai-completions": (m, o) => completionsStream(m as Model<"openai-completions">, context(), o),
	"openai-responses": (m, o) => responsesStream(m as Model<"openai-responses">, context(), o),
	"anthropic-messages": (m, o) => anthropicStream(m as Model<"anthropic-messages">, context(), o),
	"google-generative-ai": (m, o) => googleStream(m as Model<"google-generative-ai">, context(), o),
};

function context() {
	return normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
}

/** The request body pi builds for a Magpie model saved for this API, at a thinking level (none = off). */
async function payload(
	api: ProviderApi,
	reasoning: SimpleStreamOptions["reasoning"] | undefined,
	levels = ["none", "low", "medium", "high", "max"],
): Promise<Record<string, unknown>> {
	const { entry } = enrichModelEntry([], "deepseek/deepseek-flash", api, undefined, {
		contextWindow: 262_144,
		maxTokens: 65_536,
		reasoning: true,
		reasoningLevels: levels,
	});
	const model = { ...entry, api, provider: "magpie", baseUrl: "http://localhost:3425/v1" } as unknown as Model<Api>;
	globalThis.fetch = (async () => new Response("stop", { status: 500 })) as unknown as typeof fetch;
	let body: Record<string, unknown> | undefined;
	for await (const _ of STREAMS[api](model, {
		apiKey: "magpie-pi",
		maxRetries: 0,
		...(reasoning ? { reasoning } : {}),
		onPayload: (p) => {
			body = p as Record<string, unknown>;
			throw new Error("payload captured");
		},
	})) {
		// drain until the error the throw above ends the stream with
	}
	assert.ok(body, `no payload for ${api}`);
	return body;
}

describe("requests pi sends for a model with reported levels", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("Chat Completions: off asks for none, levels are sent as efforts", async () => {
		assert.equal((await payload("openai-completions", undefined)).reasoning_effort, "none");
		assert.equal((await payload("openai-completions", "max")).reasoning_effort, "max");
		assert.equal((await payload("openai-completions", "high")).reasoning_effort, "high");
		// without a listed none, off leaves the model's default, as before
		assert.equal((await payload("openai-completions", undefined, ["high"])).reasoning_effort, undefined);
	});

	it("Responses: off asks for none, levels are sent as efforts", async () => {
		assert.deepEqual((await payload("openai-responses", undefined)).reasoning, { effort: "none" });
		assert.equal(((await payload("openai-responses", "max")).reasoning as { effort: string }).effort, "max");
	});

	it("Anthropic: high and max are told apart as efforts, off disables thinking", async () => {
		const high = await payload("anthropic-messages", "high");
		const max = await payload("anthropic-messages", "max");
		assert.deepEqual(high.output_config, { effort: "high" });
		assert.deepEqual(max.output_config, { effort: "max" });
		assert.equal((max.thinking as { type: string }).type, "adaptive");
		assert.equal((max.thinking as { budget_tokens?: number }).budget_tokens, undefined);
		assert.deepEqual((await payload("anthropic-messages", undefined)).thinking, { type: "disabled" });
	});

	it("Google: every offered level resolves, none throws", async () => {
		for (const level of ["low", "medium", "high"] as const) {
			const body = await payload("google-generative-ai", level);
			assert.ok(body.config, `${level}: ${JSON.stringify(body)}`);
		}
		await payload("google-generative-ai", undefined);
	});
});
