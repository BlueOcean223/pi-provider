import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compatAlreadyApplied, suggestCompatFix } from "./compat-hints.ts";

describe("suggestCompatFix", () => {
	it("maps a rejected developer role to supportsDeveloperRole=false", () => {
		const fix = suggestCompatFix("openai-completions", 400, "Invalid value: 'developer' is not a supported role");
		assert.deepEqual(fix?.compat, { supportsDeveloperRole: false });
	});

	it("maps a rejected reasoning_effort", () => {
		const fix = suggestCompatFix("openai-completions", 400, "Unrecognized request argument supplied: reasoning_effort");
		assert.deepEqual(fix?.compat, { supportsReasoningEffort: false });
	});

	it("picks the max-token field the relay asks for", () => {
		assert.deepEqual(
			suggestCompatFix(
				"openai-completions",
				400,
				"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
			)?.compat,
			{ maxTokensField: "max_completion_tokens" },
		);
		assert.deepEqual(
			suggestCompatFix("openai-completions", 400, "Unknown parameter: 'max_completion_tokens'.")?.compat,
			{ maxTokensField: "max_tokens" },
		);
	});

	it("uses the status parsed from the message when there is no HTTP status", () => {
		assert.ok(suggestCompatFix("openai-completions", 0, "developer role not supported"));
	});

	it("ignores server errors, successes and non-OpenAI protocols", () => {
		assert.equal(suggestCompatFix("openai-completions", 502, "developer role not supported"), undefined);
		assert.equal(suggestCompatFix("openai-completions", 200, "developer"), undefined);
		assert.equal(suggestCompatFix("anthropic-messages", 400, "developer role not supported"), undefined);
		assert.equal(suggestCompatFix("openai-completions", 401, "invalid api key"), undefined);
	});

	it("knows when a fix is already in place", () => {
		const fix = suggestCompatFix("openai-completions", 400, "developer role")!;
		assert.equal(compatAlreadyApplied({ supportsDeveloperRole: false }, fix), true);
		assert.equal(compatAlreadyApplied(undefined, fix), false);
	});
});
