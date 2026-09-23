import type { ProviderApi } from "./types.ts";

/**
 * Map a failed chat test to the OpenAI compat flag that would fix it.
 *
 * pi's docs ask for compat flags to describe *verified* endpoint differences,
 * not guesses made up front, so the add flow no longer asks for a compat preset.
 * Instead the test sends a request shaped like pi's own (system prompt as the
 * `developer` role for reasoning models, reasoning_effort, pi's max-token
 * field) and, when the relay rejects one of those fields, the panel offers the
 * matching flag.
 */

export interface CompatFix {
	/** Provider-level compat fields to merge in. */
	compat: Record<string, unknown>;
	/** Short description of what the relay rejected. */
	reason: string;
}

interface Rule {
	test: RegExp;
	fix: CompatFix;
	apis: ProviderApi[];
}

const RULES: Rule[] = [
	{
		test: /developer/i,
		fix: { compat: { supportsDeveloperRole: false }, reason: 'relay rejects the "developer" role' },
		apis: ["openai-completions", "openai-responses"],
	},
	{
		test: /reasoning[\s._-]?effort/i,
		fix: { compat: { supportsReasoningEffort: false }, reason: "relay rejects reasoning_effort" },
		apis: ["openai-completions"],
	},
	{
		// "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead."
		test: /max_tokens[\s\S]*max_completion_tokens/i,
		fix: { compat: { maxTokensField: "max_completion_tokens" }, reason: "relay wants max_completion_tokens" },
		apis: ["openai-completions"],
	},
	{
		test: /max_completion_tokens/i,
		fix: { compat: { maxTokensField: "max_tokens" }, reason: "relay rejects max_completion_tokens" },
		apis: ["openai-completions"],
	},
	{
		test: /stream_options|include_usage/i,
		fix: { compat: { supportsUsageInStreaming: false }, reason: "relay rejects stream_options" },
		apis: ["openai-completions"],
	},
	{
		test: /["'`]store["'`]|\bstore\b.*(unsupported|not supported|unrecognized|unknown)/i,
		fix: { compat: { supportsStore: false }, reason: 'relay rejects the "store" field' },
		apis: ["openai-completions"],
	},
];

/**
 * Suggest a compat fix for a failed test request, or undefined when the error
 * doesn't point at a field pi can stop sending. Only client errors count: a
 * 5xx says nothing about the request shape. Status 0 means unknown (the SDK
 * error carried no status), so the message alone decides.
 */
export function suggestCompatFix(
	api: ProviderApi | undefined,
	status: number,
	message: string,
): CompatFix | undefined {
	if (!api || (status > 0 && (status < 400 || status >= 500))) return undefined;
	for (const rule of RULES) {
		if (rule.apis.includes(api) && rule.test.test(message)) return rule.fix;
	}
	return undefined;
}

/** True when every field of `fix` is already set to the same value. */
export function compatAlreadyApplied(
	current: Record<string, unknown> | undefined,
	fix: CompatFix,
): boolean {
	return Object.entries(fix.compat).every(([key, value]) => current?.[key] === value);
}
