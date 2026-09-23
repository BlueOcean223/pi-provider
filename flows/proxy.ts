import { loopInput, loopSelect, runWizard, type StepOutcome, type WizardStep } from "../lib/loop-ui.ts";
import { readModelsFile, sanitizeProviderId, upsertProvider, writeModelsFile } from "../lib/models-json.ts";
import { type MenuNote, rowMenu } from "../lib/row-menu.ts";
import { BUILTIN_PROXY_TARGETS, type ProviderConfig } from "../lib/types.ts";
import { promptApiKey, promptBaseUrl } from "./fields.ts";
import {
	credentialNote,
	describeKey,
	type Env,
	jsoncNotes,
	type Notice,
	overridingCredential,
	refreshRegistry,
} from "./shared.ts";
import { testProvider } from "./test.ts";

const OTHER = "Other (type an id)…";

interface ProxyDraft {
	id: string;
	baseUrl: string;
	/** undefined = leave the provider's auth as it is. */
	apiKey?: string;
	keepModels: boolean;
}

async function reviewStep(env: Env, draft: ProxyDraft): Promise<StepOutcome> {
	const { ctx } = env;
	let cursor: string | undefined;
	while (true) {
		const existing = readModelsFile().providers?.[draft.id];
		const customModels = existing?.models?.length ?? 0;
		const effectiveKey = draft.apiKey ?? existing?.apiKey;
		const override = overridingCredential(ctx, draft.id);
		let keyValue =
			draft.apiKey !== undefined
				? describeKey(draft.apiKey)
				: existing?.apiKey
					? `keep ${describeKey(existing.apiKey)}`
					: (override?.label ?? "keep /login or environment auth");
		if (override && effectiveKey) keyValue += " · not used";
		const credential = credentialNote(ctx, draft.id, effectiveKey, draft.baseUrl);
		const notes: MenuNote[] = [
			{ text: `pi keeps ${draft.id}'s own model list; only requests go to the new base URL.`, tone: "dim" },
			...(credential ? [credential] : []),
			...jsoncNotes(),
		];
		const choice = await rowMenu(ctx, {
			title: `Route ${draft.id} through a relay`,
			notes,
			entries: [
				{ id: "baseUrl", label: "Base URL", value: draft.baseUrl },
				{ id: "key", label: "API key", value: keyValue },
				...(customModels
					? [
							{
								id: "models",
								label: "Custom models",
								value: draft.keepModels ? `keep ${customModels}` : `remove ${customModels}`,
							},
						]
					: []),
				{ separator: true },
				{ id: "save", label: "Save and test", kind: override ? "danger" : "action" },
			],
			initialId: cursor ?? "save",
			enterLabel: "edit / select",
		});
		if (!choice) return "back";
		cursor = choice.id;

		if (choice.id === "baseUrl") {
			const url = await promptBaseUrl(ctx, draft.baseUrl);
			if (url !== undefined) draft.baseUrl = url;
		} else if (choice.id === "key") {
			const key = await promptApiKey(ctx, draft.apiKey, "proxy");
			if (key) draft.apiKey = key.value;
		} else if (choice.id === "models") {
			draft.keepModels = !draft.keepModels;
		} else if (choice.id === "save") {
			const fresh = readModelsFile();
			const config: ProviderConfig = {
				...(fresh.providers?.[draft.id] ?? {}),
				baseUrl: draft.baseUrl,
				...(draft.apiKey !== undefined ? { apiKey: draft.apiKey } : {}),
			};
			if (!draft.keepModels) delete config.models;
			writeModelsFile(upsertProvider(fresh, draft.id, config));
			await refreshRegistry(ctx, draft.id);
			return "next";
		}
	}
}

/**
 * Point a built-in provider at a relay by overriding only its baseUrl (and
 * optionally its key); pi keeps the provider's own model list.
 */
export async function proxyProvider(env: Env): Promise<Notice | undefined> {
	const { ctx } = env;
	const draft: ProxyDraft = { id: "", baseUrl: "", keepModels: true };

	const steps: WizardStep[] = [
		{
			run: async () => {
				const options = [...BUILTIN_PROXY_TARGETS, OTHER];
				const known = (BUILTIN_PROXY_TARGETS as readonly string[]).includes(draft.id);
				const picked = await loopSelect(ctx, "Built-in provider to route through a relay", options, {
					escLabel: "back",
					initial: draft.id ? (known ? draft.id : OTHER) : undefined,
				});
				if (picked === undefined) return "back";
				if (picked !== OTHER) {
					draft.id = picked;
				} else {
					const typed = await loopInput(ctx, "Provider id", {
						initial: known ? undefined : draft.id,
						placeholder: "anthropic",
						hint: ["The id pi uses for the built-in provider (see /model)."],
						validate: (value) => (sanitizeProviderId(value) ? undefined : "Use at least one letter or digit"),
					});
					if (typed === undefined) return "stay"; // back to the provider list
					draft.id = sanitizeProviderId(typed);
				}
				const existing = readModelsFile().providers?.[draft.id];
				if (!draft.baseUrl && existing?.baseUrl) draft.baseUrl = existing.baseUrl;
				return "next";
			},
		},
		{
			run: async () => {
				const url = await promptBaseUrl(ctx, draft.baseUrl || undefined, {
					title: `Relay base URL for ${draft.id}`,
					placeholder: "https://your-relay.example.com",
					hint: ["Requests for this provider's models go here instead of the official endpoint."],
				});
				if (url === undefined) return "back";
				draft.baseUrl = url;
				return "next";
			},
		},
		{
			run: async () => {
				const key = await promptApiKey(ctx, draft.apiKey, "proxy");
				if (key === undefined) return "back";
				draft.apiKey = key.value;
				return "next";
			},
		},
		{ run: () => reviewStep(env, draft) },
	];

	if (!(await runWizard(steps))) return undefined;
	const saved: Notice = { text: `Routed ${draft.id} through ${draft.baseUrl}`, tone: "success" };
	const tested = await testProvider(env, draft.id);
	return tested ? { ...tested, text: `${saved.text} · ${tested.text}` } : saved;
}
