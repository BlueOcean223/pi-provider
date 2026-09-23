import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkboxSelect } from "../lib/checkbox-select.ts";
import { type CheckResult, type PanelCheck, type PanelSummary, runChecksPanel } from "../lib/checks-panel.ts";
import { type CompatFix, compatAlreadyApplied, suggestCompatFix } from "../lib/compat-hints.ts";
import { chatPing, probeEndpoint } from "../lib/detect-api.ts";
import { readModelsFile } from "../lib/models-json.ts";
import { rowMenu } from "../lib/row-menu.ts";
import { median, recordTest } from "../lib/test-history.ts";
import type { ProviderApi, ProviderConfig } from "../lib/types.ts";
import { writeModelChanges } from "./models.ts";
import {
	credentialNote,
	type Env,
	errorText,
	formatCompat,
	idLines,
	inferProviderApi,
	jsoncNotes,
	modelMeta,
	type Notice,
	refreshRegistry,
	type ResolvedAuth,
	resolveProviderAuth,
	shortUrl,
	uniqueModelIds,
	updateProvider,
} from "./shared.ts";

/**
 * Chat requests fan out one per model. Relays answer a burst of dozens with
 * 429s, which would show up as fake failures, so the panel runs them in batches.
 */
const MAX_CONCURRENT_CHAT_TESTS = 4;
const CHAT_TIMEOUT_MS = 30_000;
const SYSTEM_PROMPT = "You are a connectivity check. Reply with one word.";

type Registry = Partial<ExtensionCommandContext["modelRegistry"]>;

function clip(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * SDK errors often carry the relay's JSON body (`400 {"error":{"message":…}}`);
 * show just the message.
 */
function readableError(text: string): string {
	const match = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (!match) return clip(text);
	try {
		return clip(JSON.parse(`"${match[1]}"`) as string);
	} catch {
		return clip(match[1]!);
	}
}

function statusFromMessage(message: string): number {
	const match = message.match(/^(\d{3})\b/) ?? message.match(/\bstatus(?: code)?:? (\d{3})\b/i);
	return match ? Number(match[1]) : 0;
}

function withCompatHint(
	env: Env,
	result: CheckResult,
	api: ProviderApi,
	status: number,
	message: string,
	cfg: ProviderConfig,
): CheckResult {
	const fix = suggestCompatFix(api, status, message);
	if (!fix || compatAlreadyApplied(cfg.compat, fix)) return result;
	// The `c` key only exists in the live panel; elsewhere point at the Compat row.
	const how = env.ctx.mode === "tui" ? "press c to set" : "set on the provider's Compat row:";
	return { ...result, hint: `${fix.reason} — ${how} ${formatCompat(fix.compat)}`, data: fix };
}

/**
 * Chat test through pi's own request path: the registry resolves auth and
 * headers, applies compat flags and builds the URL exactly as a real session
 * would. The system prompt makes reasoning models use the `developer` role and
 * reasoning is requested on OpenAI-style APIs, so a relay that rejects either
 * fails here instead of mid-session.
 */
async function chatTest(
	env: Env,
	providerId: string,
	cfg: ProviderConfig,
	api: ProviderApi,
	modelId: string,
	auth: ResolvedAuth,
	signal: AbortSignal,
): Promise<CheckResult> {
	const registry = env.ctx.modelRegistry as Registry;
	const model = typeof registry.find === "function" ? registry.find(providerId, modelId) : undefined;
	// AbortSignal.any needs Node 20.3+ / recent Bun; older runtimes only get Esc.
	const combined =
		typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]) : signal;

	if (model && typeof registry.streamSimple === "function") {
		let status = 0;
		try {
			const openaiStyle = api === "openai-completions" || api === "openai-responses";
			const stream = registry.streamSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{
					maxTokens: 16,
					signal: combined,
					...(openaiStyle && model.reasoning ? { reasoning: "low" as const } : {}),
					onResponse: (response) => {
						status = response.status;
					},
				},
			);
			const message = await stream.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const text = message.errorMessage ?? (message.stopReason === "aborted" ? "aborted" : "request failed");
				const timedOut = message.stopReason === "aborted" && !signal.aborted;
				const code = status >= 400 ? status : statusFromMessage(text);
				const detail = timedOut
					? `timeout after ${CHAT_TIMEOUT_MS / 1000}s`
					: code
						? `HTTP ${code}: ${readableError(text.replace(new RegExp(`^${code}\\b:?\\s*`), ""))}`
						: readableError(text);
				return withCompatHint(env, { ok: false, detail }, api, code, text, cfg);
			}
			const served = message.responseModel;
			const answeredAs = served && served !== modelId && !served.startsWith(modelId) ? ` · answered as ${served}` : "";
			return { ok: true, detail: `replied${answeredAs}` };
		} catch (err) {
			const text = errorText(err);
			const code = status >= 400 ? status : statusFromMessage(text);
			return withCompatHint(env, { ok: false, detail: readableError(text) }, api, code, text, cfg);
		}
	}

	// The registry doesn't know this model (not loaded yet, or an older pi):
	// fall back to a hand-built minimal request with the same credentials.
	const ping = await chatPing({
		baseUrl: cfg.baseUrl!,
		api,
		model: modelId,
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal: combined,
	});
	return {
		ok: ping.ok,
		detail: ping.ok ? "replied" : ping.detail,
		sub: ping.ok ? undefined : [ping.status ? `${ping.url} · HTTP ${ping.status}` : ping.url],
	};
}

function mergedFix(summary: PanelSummary): CompatFix | undefined {
	const compat: Record<string, unknown> = {};
	const reasons: string[] = [];
	for (const id of summary.failed) {
		const fix = summary.results.get(id)?.data as CompatFix | undefined;
		if (!fix?.compat) continue;
		Object.assign(compat, fix.compat);
		if (!reasons.includes(fix.reason)) reasons.push(fix.reason);
	}
	return reasons.length ? { compat, reason: reasons.join("; ") } : undefined;
}

async function confirmRemoveFailed(env: Env, providerId: string, ids: string[]): Promise<boolean> {
	const choice = await rowMenu(env.ctx, {
		title: `Remove ${ids.length} failing model(s) from "${providerId}"?`,
		notes: [
			...idLines("-", ids),
			{ text: "" },
			{ text: "Only the entries in models.json are removed; the relay is not touched.", tone: "dim" },
			...jsoncNotes(),
		],
		entries: [
			{ id: "remove", label: "Remove models", kind: "danger" },
			{ id: "back", label: "Back" },
		],
	});
	return choice?.id === "remove";
}

async function useModel(env: Env, providerId: string, modelId: string): Promise<Notice> {
	const registry = env.ctx.modelRegistry as Registry;
	const model = registry.find?.(providerId, modelId);
	if (!model) return { text: `pi can't find ${providerId}/${modelId} yet — pick it in /model`, tone: "warning" };
	const ok = await env.pi.setModel(model);
	return ok
		? { text: `Now using ${providerId}/${modelId}`, tone: "success" }
		: { text: `pi has no usable credentials for ${providerId} — check the API key`, tone: "error" };
}

export interface TestOptions {
	/** Models to chat-test (default: every configured model). */
	models?: string[];
}

/**
 * Test a provider in the live panel. After a run the user can pick a passing
 * model to switch to, apply a suggested compat fix (and re-run), remove the
 * failing models, or choose a different set of models to test.
 */
export async function testProvider(env: Env, providerId: string, opts: TestOptions = {}): Promise<Notice | undefined> {
	const { ctx } = env;
	let selection = opts.models;
	let notice: Notice | undefined;

	while (true) {
		const cfg = readModelsFile().providers?.[providerId];
		if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
		const baseUrl = cfg.baseUrl;
		if (!baseUrl) return { text: `${providerId} has no base URL to test`, tone: "warning" };

		const registryWarning = await refreshRegistry(ctx, providerId);
		const api = inferProviderApi(cfg);
		const configured = uniqueModelIds(cfg.models);
		const models = (selection ?? configured).filter((id) => configured.includes(id));
		const auth = await resolveProviderAuth(ctx, providerId, cfg);

		const notes: string[] = [];
		if (registryWarning) notes.push(registryWarning);
		if (auth.warning) notes.push(auth.warning);
		if (!auth.apiKey) notes.push("No API key resolved — requests go out without one");
		if (cfg.apiKey?.startsWith("!")) notes.push("apiKey is a !command — the catalog probe runs without it");
		const credential = credentialNote(ctx, providerId, cfg.apiKey, baseUrl);
		// The panel prefixes its own ⚠.
		if (credential) notes.push(credential.text.replace(/^⚠ /, ""));

		const checks: PanelCheck[] = [
			{
				label: "Catalog probe",
				runningDetail: "listing models",
				run: async (signal) => {
					const probe = await probeEndpoint({ baseUrl, apiKey: auth.apiKey, headers: auth.headers, signal });
					return {
						ok: probe.ok,
						detail: probe.detail,
						sub: [probe.status ? `${probe.url} · HTTP ${probe.status}` : probe.url],
					};
				},
			},
		];
		if (!api) {
			checks.push({ label: "Chat test", skipReason: "baseUrl-only proxy — chat goes through the built-in provider" });
		} else if (models.length === 0) {
			checks.push({ label: "Chat test", skipReason: "provider has no custom models" });
		} else {
			for (const modelId of models) {
				checks.push({
					id: modelId,
					label: `Chat test (${modelId})`,
					runningDetail: models.length === 1 ? `sending "hi" via ${api}` : 'sending "hi"',
					run: (signal) => chatTest(env, providerId, cfg, api, modelId, auth, signal),
				});
			}
		}

		const removableFailed = (s: PanelSummary) => s.failed.filter((id) => configured.includes(id));
		const canSwitch = Boolean(api && models.length > 0 && typeof env.pi?.setModel === "function");
		const outcome = await runChecksPanel(ctx, {
			title: `Test provider: ${providerId}`,
			subtitle: `${shortUrl(baseUrl)} · ${api ?? "built-in protocol"}${models.length > 1 ? ` · ${models.length} models` : ""}`,
			notes: notice ? [notice.text, ...notes] : notes,
			checks,
			concurrency: models.length > 1 ? MAX_CONCURRENT_CHAT_TESTS : undefined,
			pickLabel: canSwitch ? "use model" : undefined,
			actions: [
				{ key: "c", label: "apply compat fix", available: (s) => Boolean(mergedFix(s)) },
				{
					key: "x",
					label: (s) => `remove ${removableFailed(s).length} failing`,
					available: (s) => removableFailed(s).length > 0,
				},
				{ key: "s", label: "choose models", available: () => configured.length > 1 },
			],
		});
		notice = undefined;

		const { summary } = outcome;
		if (summary.finished) {
			const chatRuns = summary.passed.length + summary.failed.length;
			recordTest(providerId, {
				at: Date.now(),
				passed: chatRuns > 0 ? summary.passed.length : summary.passedCount,
				failed: chatRuns > 0 ? summary.failed.length : summary.failedCount,
				medianMs: median([...summary.latency.values()]),
			});
		}

		if (outcome.kind === "closed") return undefined;
		if (outcome.kind === "picked") return useModel(env, providerId, outcome.id);

		if (outcome.key === "c") {
			const fix = mergedFix(summary);
			if (!fix) continue;
			const result = await updateProvider(
				env,
				providerId,
				(current) => ({ ...current, compat: { ...(current.compat ?? {}), ...fix.compat } }),
				`Set ${formatCompat(fix.compat)} on ${providerId} — re-testing`,
			);
			if (result.tone === "error") return result;
			notice = result;
			// Re-test only the models that failed; the rest already passed.
			selection = summary.failed;
			continue;
		}
		if (outcome.key === "x") {
			const ids = removableFailed(summary);
			if (!(await confirmRemoveFailed(env, providerId, ids))) continue;
			const result = await writeModelChanges(env, providerId, [], ids);
			if ("text" in result) return result;
			return { text: `Removed ${result.removed.length} failing model(s) from ${providerId}`, tone: "success" };
		}
		if (outcome.key === "s") {
			const current = new Set(models);
			const byId = new Map((cfg.models ?? []).map((m) => [m.id, m]));
			const picked = await checkboxSelect(
				ctx,
				`Models to test on ${providerId}`,
				configured.map((id) => ({
					id,
					label: id,
					detail: byId.get(id) ? modelMeta(byId.get(id)!) : undefined,
					checked: current.has(id),
				})),
				{ validate: (sel) => (sel.length ? undefined : "Select at least one model (Space)") },
			);
			if (picked !== undefined) selection = picked;
			continue;
		}
		return undefined;
	}
}
