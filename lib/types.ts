/** API types supported by models.json custom providers. */
export type ProviderApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export interface ModelEntry {
	id: string;
	name?: string;
	api?: ProviderApi;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<
		Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
	>;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: unknown[];
	};
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	api?: ProviderApi;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	models?: ModelEntry[];
	modelOverrides?: Record<string, unknown>;
	oauth?: string;
	[key: string]: unknown;
}

export interface ModelsFile {
	providers?: Record<string, ProviderConfig>;
	[key: string]: unknown;
}

export const API_LABELS: Record<ProviderApi, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"anthropic-messages": "Anthropic Messages",
	"openai-responses": "OpenAI Responses",
	"google-generative-ai": "Google Generative AI",
};

export const API_OPTIONS: ProviderApi[] = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
	"google-generative-ai",
];

/** Built-in providers that are commonly baseUrl-overridden for relays. */
export const BUILTIN_PROXY_TARGETS = [
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"deepseek",
	"xai",
	"mistral",
	"groq",
	"minimax",
	"minimax-cn",
	"kimi-coding",
	"zai",
	"zai-coding-cn",
] as const;
