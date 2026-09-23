import { formatLatency } from "../lib/checks-panel.ts";
import { loopEditor } from "../lib/loop-ui.ts";
import { readModelsFile, removeProvider, writeModelsFile } from "../lib/models-json.ts";
import { type MenuEntry, type MenuNote, rowMenu } from "../lib/row-menu.ts";
import { formatAge, forgetTest, lastTest } from "../lib/test-history.ts";
import { API_LABELS, type ProviderConfig } from "../lib/types.ts";
import { promptApiKey, promptBaseUrl, promptCompat, promptDisplayName, promptProtocol } from "./fields.ts";
import { addModelIdsManually, manageModels, syncMetadata } from "./models.ts";
import {
	canAddModels,
	credentialNote,
	describeKey,
	type Env,
	envVarName,
	errorText,
	formatCompat,
	inferProviderApi,
	isProxyOverride,
	jsoncNotes,
	type Notice,
	noticeNote,
	refreshRegistry,
	uniqueModelIds,
	updateProvider,
} from "./shared.ts";
import { testProvider } from "./test.ts";

export function lastTestNote(providerId: string): MenuNote | undefined {
	const record = lastTest(providerId);
	if (!record) return undefined;
	const total = record.passed + record.failed;
	const latency = record.medianMs !== undefined ? ` · median ${formatLatency(record.medianMs)}` : "";
	const age = formatAge(Date.now() - record.at);
	return record.failed > 0
		? { text: `Last test: ${record.failed} of ${total} failed · ${age}`, tone: "error" }
		: { text: `Last test: ${record.passed}/${total} passed${latency} · ${age}`, tone: "success" };
}

export async function confirmDelete(env: Env, providerId: string, cfg: ProviderConfig): Promise<Notice | undefined> {
	const proxy = isProxyOverride(cfg);
	const models = cfg.models?.length ?? 0;
	const choice = await rowMenu(env.ctx, {
		title: proxy ? `Remove the relay override for "${providerId}"?` : `Delete provider "${providerId}"?`,
		notes: [
			{
				text: proxy
					? `${providerId} goes back to its official endpoint.`
					: `Removes ${providerId} and its ${models} model(s) from models.json.`,
				tone: "muted",
			},
			...jsoncNotes(),
		],
		entries: [
			{ id: "delete", label: proxy ? "Remove override" : "Delete provider", kind: "danger" },
			{ id: "back", label: "Back" },
		],
		initialId: "back",
	});
	if (choice?.id !== "delete") return undefined;
	writeModelsFile(removeProvider(readModelsFile(), providerId));
	forgetTest(providerId);
	await refreshRegistry(env.ctx);
	return { text: proxy ? `Removed the ${providerId} override` : `Deleted ${providerId}`, tone: "success" };
}

function detailEntries(cfg: ProviderConfig): MenuEntry[] {
	const api = inferProviderApi(cfg);
	const proxy = isProxyOverride(cfg);
	const models = uniqueModelIds(cfg.models).length;
	const openaiStyle = api === "openai-completions" || api === "openai-responses";

	const entries: MenuEntry[] = [{ id: "baseUrl", label: "Base URL", value: cfg.baseUrl ?? "(not set)" }];
	if (!proxy) {
		entries.push({
			id: "api",
			label: "Protocol",
			value: api ? `${API_LABELS[api]}${cfg.api ? "" : " (from models)"}` : "(not set)",
		});
	}
	entries.push({ id: "key", label: "API key", value: describeKey(cfg.apiKey) });
	if (!proxy) entries.push({ id: "name", label: "Display name", value: cfg.name ?? "(none — shows the id)" });
	if (openaiStyle) entries.push({ id: "compat", label: "Compat", value: formatCompat(cfg.compat) ?? "none" });

	if (!proxy) {
		entries.push({ separator: true });
		entries.push({ id: "models", label: "Models", value: `${models} configured` });
		if (canAddModels(cfg)) entries.push({ id: "manual", label: "Add model ids manually", kind: "action" });
		if (models > 0) entries.push({ id: "sync", label: "Sync metadata from pi's catalog", kind: "action" });
	}

	entries.push({ separator: true });
	if (cfg.baseUrl) entries.push({ id: "test", label: "Test connection", kind: "action" });
	entries.push({ id: "json", label: "View JSON", kind: "action" });
	entries.push({ id: "delete", label: proxy ? "Remove override" : "Delete provider", kind: "danger" });
	return entries;
}

/**
 * A provider's detail page: every setting is a row, Enter edits it in place
 * and the change is written immediately (Esc in an editor changes nothing).
 * Resolves a notice for the provider list, e.g. after deleting.
 */
export async function providerScreen(env: Env, providerId: string, initial?: Notice): Promise<Notice | undefined> {
	const { ctx } = env;
	let notice = initial;
	let cursor: string | undefined;

	while (true) {
		let cfg: ProviderConfig | undefined;
		try {
			cfg = readModelsFile().providers?.[providerId];
		} catch (err) {
			return { text: errorText(err), tone: "error" };
		}
		if (!cfg) return { text: `Provider "${providerId}" no longer exists`, tone: "error" };
		const current = cfg;
		const proxy = isProxyOverride(current);
		const testNote = lastTestNote(providerId);
		const credential = credentialNote(ctx, providerId, current.apiKey, current.baseUrl);

		const choice = await rowMenu(ctx, {
			title: providerId,
			subtitle: proxy ? "Built-in provider routed through a relay" : current.name,
			notes: [...noticeNote(notice), ...(credential ? [credential] : []), ...(testNote ? [testNote] : []), ...jsoncNotes()],
			entries: detailEntries(current),
			keys: [{ key: "x", label: "remove key", applies: (row) => row.id === "key" && Boolean(current.apiKey) }],
			initialId: cursor,
			enterLabel: "edit / open",
		});
		notice = undefined;
		if (!choice) return undefined;
		cursor = choice.id;

		const update = (change: (c: ProviderConfig) => ProviderConfig, text: string) =>
			updateProvider(env, providerId, change, text);

		switch (choice.id) {
			case "baseUrl": {
				const url = await promptBaseUrl(ctx, current.baseUrl);
				if (url !== undefined && url !== current.baseUrl) notice = await update((c) => ({ ...c, baseUrl: url }), "Base URL updated");
				break;
			}
			case "api": {
				const api = await promptProtocol(ctx, inferProviderApi(current));
				if (api && api !== current.api) notice = await update((c) => ({ ...c, api }), `Protocol set to ${API_LABELS[api]}`);
				break;
			}
			case "key": {
				if (choice.key === "x") {
					// A literal key can't be recovered once it's gone from models.json;
					// a $VAR or !command reference is trivial to re-enter.
					const literal = current.apiKey && !envVarName(current.apiKey) && !current.apiKey.startsWith("!");
					if (literal) {
						const confirm = await rowMenu(ctx, {
							title: `Remove the stored API key from "${providerId}"?`,
							notes: [{ text: `${describeKey(current.apiKey)} — it can't be recovered afterwards.`, tone: "muted" }],
							entries: [
								{ id: "remove", label: "Remove key", kind: "danger" },
								{ id: "back", label: "Back" },
							],
							initialId: "back",
						});
						if (confirm?.id !== "remove") break;
					}
					notice = await update((c) => {
						const { apiKey: _removed, ...rest } = c;
						return rest;
					}, "API key removed — pi falls back to /login or environment auth");
					break;
				}
				const key = await promptApiKey(ctx, current.apiKey, "edit");
				if (key && key.value !== current.apiKey) {
					notice = await update(
						(c) => {
							const { apiKey: _old, ...rest } = c;
							return key.value ? { ...rest, apiKey: key.value } : rest;
						},
						key.value ? "API key updated" : "API key removed",
					);
				}
				break;
			}
			case "name": {
				const name = await promptDisplayName(ctx, current.name, providerId);
				if (name && name.value !== current.name) {
					notice = await update(
						(c) => {
							const { name: _old, ...rest } = c;
							return name.value ? { ...rest, name: name.value } : rest;
						},
						name.value ? "Display name updated" : "Display name removed",
					);
				}
				break;
			}
			case "compat": {
				const compat = await promptCompat(ctx, current.compat);
				if (compat && JSON.stringify(compat.value ?? {}) !== JSON.stringify(current.compat ?? {})) {
					notice = await update(
						(c) => {
							const { compat: _old, ...rest } = c;
							return compat.value ? { ...rest, compat: compat.value } : rest;
						},
						compat.value ? `Compat set: ${formatCompat(compat.value)}` : "Compat flags cleared",
					);
				}
				break;
			}
			case "models":
				notice = await manageModels(env, providerId);
				break;
			case "manual":
				notice = await addModelIdsManually(env, providerId);
				break;
			case "sync":
				notice = await syncMetadata(env, providerId);
				break;
			case "test":
				notice = await testProvider(env, providerId);
				break;
			case "json":
				await loopEditor(ctx, `${providerId} (read-only view; Esc = back)`, JSON.stringify(current, null, 2));
				break;
			case "delete": {
				const deleted = await confirmDelete(env, providerId, current);
				if (deleted) return deleted;
				break;
			}
		}
	}
}
