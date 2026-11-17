import type { ModelEntry, ProviderApi } from "./types.ts";

type ThinkingLevelMap = NonNullable<ModelEntry["thinkingLevelMap"]>;

/** pi's thinking levels above off, weakest first. */
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The levels pi's Google APIs can send (resolveGoogleThinkingLevel throws on any other). */
const GOOGLE_LEVELS = new Set(["minimal", "low", "medium", "high"]);

/** Vendor words Magpie lists as they are, each with the level it is (its catalog's EffortAliases). */
const EFFORT_ALIASES: Record<string, string> = { light: "low", extra_high: "xhigh" };

export interface ReportedThinking {
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
}

/**
 * The thinking settings for a model whose server lists the reasoning levels
 * it takes (Magpie's `reasoning_levels`), for the API pi will talk to it on.
 *
 * A standard level the server doesn't list is marked unsupported, so pi
 * offers only the ones the model takes; xhigh and max are off unless mapped.
 * Per API:
 *
 * - OpenAI Chat Completions / Responses: a listed level is sent as the
 *   server spells it (Magpie fits a vendor's word like `light` back to the
 *   model on the way out). A listed `none` becomes `off: "none"`, because
 *   Chat Completions sends no `reasoning_effort` at all for off otherwise,
 *   and Magpie turns thinking off only on an explicit `none`.
 * - Anthropic Messages: as above, plus `forceAdaptiveThinking`, so pi sends
 *   the level as `output_config.effort`. Without it pi sends a thinking
 *   budget, which is the same for high, xhigh and max (Magpie reads 16384
 *   as high). Off is already sent as `thinking: { type: "disabled" }`.
 * - Google: only minimal through high, by their standard names, which is
 *   all pi's Google APIs accept. Off is a thinking budget of 0.
 *
 * Empty when no listed level is one pi can send.
 */
export function reportedThinking(levels: readonly string[] | undefined, api: ProviderApi | undefined): ReportedThinking {
	if (!levels?.length) return {};
	const google = api === "google-generative-ai";
	const spelled = new Map<string, string>();
	for (const level of levels) {
		const lower = level.toLowerCase();
		const canonical = EFFORT_ALIASES[lower] ?? lower;
		if (!spelled.has(canonical)) spelled.set(canonical, google ? canonical : level);
	}
	const sendable = PI_LEVELS.filter((l) => spelled.has(l) && (!google || GOOGLE_LEVELS.has(l)));
	if (sendable.length === 0) return {};

	const map: ThinkingLevelMap = {};
	const none = spelled.get("none");
	if (none && !google) map.off = none;
	for (const level of PI_LEVELS) {
		if (sendable.includes(level)) map[level] = spelled.get(level)!;
		else if (level !== "xhigh" && level !== "max") map[level] = null;
	}
	return {
		thinkingLevelMap: map,
		...(api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: true } } : {}),
	};
}

/** The levels a thinking map offers above off, weakest first. */
export function offeredLevels(map: ModelEntry["thinkingLevelMap"]): string[] {
	return PI_LEVELS.filter((l) => typeof map?.[l] === "string");
}
