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
	it("does not let a base id absorb a newer version suffix", () => {
		const sonnet4: OfficialModelMeta = {
			id: "claude-sonnet-4",
			provider: "anthropic",
			api: "anthropic-messages",
		};
		assert.equal(matchOfficialModel([sonnet4], "claude-sonnet-4-6"), undefined);
	});
});
