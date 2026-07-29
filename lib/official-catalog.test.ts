import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichModelEntry, matchOfficialModel } from "./official-catalog.ts";
import type { OfficialModelMeta } from "./official-catalog.ts";

const opus46: OfficialModelMeta = {
	id: "claude-opus-4-6",
	provider: "anthropic",
	name: "Claude Opus 4.6",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinkingLevelMap: { max: "max" },
	compat: {
		forceAdaptiveThinking: true,
		supportsStrictTools: true,
		// gateway/session-routing flags must NOT be forwarded to relay entries
		sendSessionAffinityHeaders: true,
	},
};

describe("enrichModelEntry compat forwarding", () => {
	it("copies model-level anthropic compat flags onto relay entries", () => {
		const r = enrichModelEntry([opus46], "claude-opus-4-6", "anthropic-messages");
		assert.equal(r.status, "matched");
		assert.deepEqual(r.entry.compat, {
			forceAdaptiveThinking: true,
			supportsStrictTools: true,
		});
		assert.deepEqual(r.entry.thinkingLevelMap, { max: "max" });
	});

	it("excludes gateway/session-routing compat flags", () => {
		const r = enrichModelEntry([opus46], "claude-opus-4-6", "anthropic-messages");
		assert.ok(!("sendSessionAffinityHeaders" in (r.entry.compat ?? {})));
	});

	it("does not forward transport flags that default to true in pi-ai", () => {
		// A gateway-specific deficiency (e.g. copilot's lack of eager tool
		// streaming) must not leak onto an unrelated relay that supports it;
		// pi-ai's defaults (true) are the safe choice for conformant relays.
		const copilotStyle: OfficialModelMeta = {
			...opus46,
			compat: {
				forceAdaptiveThinking: true,
				supportsEagerToolInputStreaming: false,
				supportsLongCacheRetention: false,
				supportsCacheControlOnTools: false,
				supportsToolReferences: true,
			},
		};
		const r = enrichModelEntry([copilotStyle], "claude-opus-4-6", "anthropic-messages");
		assert.deepEqual(r.entry.compat, { forceAdaptiveThinking: true });
	});

	it("marks adaptive-thinking models in the detail hint", () => {
		const r = enrichModelEntry([opus46], "claude-opus-4-6", "anthropic-messages");
		assert.match(r.detail, /\(adaptive\)/);
	});

	it("does not copy compat for non-anthropic APIs", () => {
		const gpt: OfficialModelMeta = {
			id: "gpt-5",
			provider: "openai",
			api: "openai-responses",
			reasoning: true,
			compat: { supportsDeveloperRole: true },
		};
		const r = enrichModelEntry([gpt], "gpt-5", "openai-responses");
		assert.equal(r.status, "matched");
		assert.equal(r.entry.compat, undefined);
	});

	it("omits compat when the official entry has none", () => {
		const plain: OfficialModelMeta = {
			id: "claude-haiku-4-5",
			provider: "anthropic",
			api: "anthropic-messages",
			reasoning: true,
		};
		const r = enrichModelEntry([plain], "claude-haiku-4-5", "anthropic-messages");
		assert.equal(r.status, "matched");
		assert.equal(r.entry.compat, undefined);
	});

	it("omits compat when only routing flags are present", () => {
		const routingOnly: OfficialModelMeta = {
			id: "claude-opus-4-6",
			provider: "anthropic",
			api: "anthropic-messages",
			reasoning: true,
			compat: { sendSessionAffinityHeaders: true, openRouterRouting: { order: ["x"] } },
		};
		const r = enrichModelEntry([routingOnly], "claude-opus-4-6", "anthropic-messages");
		assert.equal(r.status, "matched");
		assert.equal(r.entry.compat, undefined);
	});
});

describe("matchOfficialModel", () => {
	const opus45: OfficialModelMeta = {
		id: "claude-opus-4-5",
		provider: "anthropic",
		api: "anthropic-messages",
	};

	it("does not let a base id absorb a newer version suffix", () => {
		const sonnet4: OfficialModelMeta = {
			id: "claude-sonnet-4",
			provider: "anthropic",
			api: "anthropic-messages",
		};
		assert.equal(matchOfficialModel([sonnet4], "claude-sonnet-4-6"), undefined);
	});

	it("matches dot-version ids (claude-opus-4.6) to dashed official ids", () => {
		assert.equal(matchOfficialModel([opus46], "claude-opus-4.6")?.id, "claude-opus-4-6");
		assert.equal(
			matchOfficialModel([opus46], "anthropic/claude-opus-4.6")?.id,
			"claude-opus-4-6",
		);
	});

	it("matches bedrock-style dotted ids with region prefixes and version suffixes", () => {
		assert.equal(
			matchOfficialModel([opus46], "anthropic.claude-opus-4-6")?.id,
			"claude-opus-4-6",
		);
		assert.equal(
			matchOfficialModel([opus46], "us.anthropic.claude-opus-4-6-v1:0")?.id,
			"claude-opus-4-6",
		);
		assert.equal(
			matchOfficialModel([opus46], "global.anthropic.claude-opus-4-6")?.id,
			"claude-opus-4-6",
		);
		assert.equal(
			matchOfficialModel([opus46], "anthropic.claude-opus-4-6-v1")?.id,
			"claude-opus-4-6",
		);
	});

	it("matches dated snapshot suffixes to their base model", () => {
		assert.equal(
			matchOfficialModel([opus46], "claude-opus-4-6-20260101")?.id,
			"claude-opus-4-6",
		);
		assert.equal(
			matchOfficialModel([opus45, opus46], "claude-opus-4-5-20251101")?.id,
			"claude-opus-4-5",
		);
		assert.equal(
			matchOfficialModel([opus45, opus46], "us.anthropic.claude-opus-4-5-20251101-v1:0")?.id,
			"claude-opus-4-5",
		);
	});
});
