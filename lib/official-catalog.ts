import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelEntry, ProviderApi } from "./types.ts";

/** Subset of pi official model fields we copy onto relay models. */
export interface OfficialModelMeta {
	id: string;
	provider: string;
	name?: string;
	api?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: unknown[];
	};
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Partial<
		Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
	>;
	compat?: Record<string, unknown>;
}

export interface EnrichResult {
	entry: ModelEntry;
	/** Matched official catalog id (provider/id), if any. */
	matched?: string;
	/** Short status for UI. */
	status: "matched" | "default";
	detail: string;
}

const LOW_PRIORITY_PROVIDERS = new Set([
	"openrouter",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"github-copilot",
	"opencode",
	"opencode-go",
	"vercel-ai-gateway",
	"amazon-bedrock",
	"huggingface",
	"azure-openai-responses",
	"google-vertex",
]);

function normalizeId(id: string): string {
	return id.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Snapshot pi's live model catalog as the enrichment source.
 *
 * ctx.modelRegistry.getAll() returns the composed catalog: bundled pi-ai
 * providers (remote-refreshed unless PI_OFFLINE) plus models.json and
 * extension-registered providers. Works in every install mode (npm, pi-node,
 * bun binary) — no filesystem guessing needed.
 *
 * Pass provider ids via excludeProviders to skip relay providers already
 * defined in models.json, so previously-added relay copies don't match
 * against themselves.
 */
export function catalogFromRegistry(
	ctx: ExtensionContext,
	excludeProviders: Iterable<string> = [],
): OfficialModelMeta[] {
	const skip = new Set(excludeProviders);
	const out: OfficialModelMeta[] = [];
	for (const m of ctx.modelRegistry.getAll()) {
		const obj = m as unknown as Record<string, unknown>;
		const id = typeof obj.id === "string" ? obj.id : undefined;
		const provider = typeof obj.provider === "string" ? obj.provider : undefined;
		if (!id || !provider || skip.has(provider)) continue;
		out.push({
			id,
			provider,
			name: typeof obj.name === "string" ? obj.name : undefined,
			api: typeof obj.api === "string" ? obj.api : undefined,
			reasoning: typeof obj.reasoning === "boolean" ? obj.reasoning : undefined,
			input: Array.isArray(obj.input) ? (obj.input as Array<"text" | "image">) : undefined,
			cost:
				obj.cost && typeof obj.cost === "object"
					? (obj.cost as OfficialModelMeta["cost"])
					: undefined,
			contextWindow:
				typeof obj.contextWindow === "number" ? obj.contextWindow : undefined,
			maxTokens: typeof obj.maxTokens === "number" ? obj.maxTokens : undefined,
			thinkingLevelMap:
				obj.thinkingLevelMap && typeof obj.thinkingLevelMap === "object"
					? (obj.thinkingLevelMap as OfficialModelMeta["thinkingLevelMap"])
					: undefined,
			compat:
				obj.compat && typeof obj.compat === "object"
					? (obj.compat as Record<string, unknown>)
					: undefined,
		});
	}
	return out;
}

/** Hint which first-party provider a model id belongs to. */
function guessFamily(relayId: string): string | undefined {
	const s = relayId.toLowerCase();
	if (s.includes("claude") || s.includes("anthropic")) return "anthropic";
	if (s.includes("gemini") || s.includes("gemma")) return "google";
	if (s.includes("gpt") || s.includes("o1") || s.includes("o3") || s.includes("o4")) return "openai";
	if (s.includes("deepseek")) return "deepseek";
	if (s.includes("grok")) return "xai";
	if (s.includes("mistral") || s.includes("codestral") || s.includes("pixtral")) return "mistral";
	if (s.includes("minimax")) return "minimax";
	if (s.includes("kimi") || s.includes("moonshot")) return "moonshotai";
	if (s.includes("qwen") || s.includes("qwq")) return "qwen-token-plan";
	if (s.includes("glm") || s.includes("zhipu") || s.includes("zai")) return "zai";
	return undefined;
}

/** Id similarity without over-matching version suffixes (sonnet-4 ≉ sonnet-4-6). */
function idSimilarity(relayNorm: string, officialNorm: string): number {
	if (!relayNorm || !officialNorm) return 0;
	if (relayNorm === officialNorm) return 100;

	// path tails already normalized by caller sometimes
	if (officialNorm.startsWith(relayNorm)) {
		const extra = officialNorm.slice(relayNorm.length);
		// pure version bump: sonnet4 + "6" / "20241022" → weak
		if (/^\d+$/.test(extra)) return 25;
		if (/^[-.]?\d/.test(extra)) return 30;
		return 50;
	}
	if (relayNorm.startsWith(officialNorm)) {
		const extra = relayNorm.slice(officialNorm.length);
		if (/^\d+$/.test(extra)) return 25;
		return 45;
	}
	if (officialNorm.includes(relayNorm)) return 35;
	if (relayNorm.includes(officialNorm) && officialNorm.length >= 8) return 30;
	return 0;
}

function scoreMatch(
	official: OfficialModelMeta,
	relayId: string,
	preferredApi?: ProviderApi,
): number {
	const r = normalizeId(relayId);
	const o = normalizeId(official.id);
	const oname = official.name ? normalizeId(official.name) : "";

	let score = idSimilarity(r, o);

	// last path segment (openrouter-style anthropic/claude-x)
	const relayTail = normalizeId(relayId.split(/[/:]/).pop() ?? relayId);
	const officialTail = normalizeId(official.id.split(/[/:]/).pop() ?? official.id);
	if (relayTail && officialTail) {
		const tailSim = idSimilarity(relayTail, officialTail);
		score = Math.max(score, tailSim);
		if (relayTail === officialTail) score = Math.max(score, 100);
	}

	if (oname) {
		const nameSim = idSimilarity(r, oname);
		if (nameSim >= 100) score = Math.max(score, 95);
		else if (nameSim >= 50) score = Math.max(score, score + 10);
	}

	// no useful id overlap → not a candidate
	if (score < 25) return 0;

	// Prefer first-party catalogs over aggregators (relays mirror official APIs).
	const low = LOW_PRIORITY_PROVIDERS.has(official.provider);
	if (low) score -= 55;
	else score += 30;

	const family = guessFamily(relayId);
	if (family) {
		if (official.provider === family || official.provider.startsWith(family)) score += 40;
		// regional siblings e.g. minimax-cn, moonshotai-cn, zai-coding-cn
		if (official.provider.startsWith(`${family}-`) || official.provider.includes(family)) {
			score += 20;
		}
	}

	// API match is secondary — only boost first-party; aggregators often claim openai-completions.
	if (preferredApi && official.api === preferredApi) {
		score += low ? 5 : 25;
	}

	// Prefer richer official metadata (thinking map, large context)
	if (official.thinkingLevelMap) score += 8;
	if (official.reasoning) score += 2;
	if ((official.contextWindow ?? 0) >= 200_000) score += 2;

	return score;
}

/**
 * Find best official catalog entry for a relay model id.
 * Relays usually mirror official model names/ids.
 */
export function matchOfficialModel(
	catalog: OfficialModelMeta[],
	relayId: string,
	preferredApi?: ProviderApi,
): OfficialModelMeta | undefined {
	if (catalog.length === 0) return undefined;

	const r = normalizeId(relayId);
	const relayTail = normalizeId(relayId.split(/[/:]/).pop() ?? relayId);

	let best: OfficialModelMeta | undefined;
	let bestScore = 0;

	for (const m of catalog) {
		const o = normalizeId(m.id);
		const officialTail = normalizeId(m.id.split(/[/:]/).pop() ?? m.id);
		const idScore = Math.max(
			idSimilarity(r, o),
			idSimilarity(relayTail, officialTail),
			m.name ? idSimilarity(r, normalizeId(m.name)) : 0,
		);
		// Require near-exact id match so claude-sonnet-4 does not absorb claude-sonnet-4-6.
		if (idScore < 90) continue;

		const s = scoreMatch(m, relayId, preferredApi);
		if (s > bestScore) {
			bestScore = s;
			best = m;
		}
	}

	if (bestScore < 40) return undefined;
	return best;
}

const DEFAULT_META = {
	reasoning: false as const,
	input: ["text"] as Array<"text" | "image">,
	contextWindow: 128_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * Build models.json entry: keep relay id, fill metadata from official catalog when possible.
 */
export function enrichModelEntry(
	catalog: OfficialModelMeta[],
	relayId: string,
	preferredApi?: ProviderApi,
	relayName?: string,
): EnrichResult {
	const official = matchOfficialModel(catalog, relayId, preferredApi);

	if (!official) {
		return {
			entry: {
				id: relayId,
				...(relayName && relayName !== relayId ? { name: relayName } : {}),
				...DEFAULT_META,
			},
			status: "default",
			detail: "no official match · defaults 128k",
		};
	}

	// Do not copy official compat onto relay models (see STRIP_COMPAT_KEYS).
	const entry: ModelEntry = {
		id: relayId, // always the id the relay expects
		name: official.name ?? relayName ?? relayId,
		reasoning: official.reasoning ?? false,
		input: official.input ?? ["text"],
		contextWindow: official.contextWindow ?? DEFAULT_META.contextWindow,
		maxTokens: official.maxTokens ?? DEFAULT_META.maxTokens,
		cost: official.cost
			? {
					input: official.cost.input ?? 0,
					output: official.cost.output ?? 0,
					cacheRead: official.cost.cacheRead ?? 0,
					cacheWrite: official.cost.cacheWrite ?? 0,
					...(official.cost.tiers ? { tiers: official.cost.tiers } : {}),
				}
			: { ...DEFAULT_META.cost },
		...(official.thinkingLevelMap ? { thinkingLevelMap: official.thinkingLevelMap } : {}),
	};

	const thinkHint = official.thinkingLevelMap
		? `think:${Object.entries(official.thinkingLevelMap)
				.filter(([, v]) => v !== null)
				.map(([k]) => k)
				.join(",") || "map"}`
		: official.reasoning
			? "reasoning"
			: "no-think";

	const ctxK = Math.round((entry.contextWindow ?? 0) / 1000);

	return {
		entry,
		matched: `${official.provider}/${official.id}`,
		status: "matched",
		detail: `${ctxK}k · ${thinkHint} ← ${official.provider}/${official.id}`,
	};
}

export function formatCtx(n?: number): string {
	if (!n) return "?";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}
