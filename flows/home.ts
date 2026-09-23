import { formatLatency } from "../lib/checks-panel.ts";
import { loopEditor, loopSelect } from "../lib/loop-ui.ts";
import {
	getModelsPath,
	listProviderIds,
	readModelsFile,
	readModelsFileRaw,
	validateModelsText,
	writeModelsFileRaw,
} from "../lib/models-json.ts";
import { type MenuEntry, type MenuNote, type MenuRow, rowMenu } from "../lib/row-menu.ts";
import { formatAge, lastTest } from "../lib/test-history.ts";
import type { ModelsFile, ProviderConfig } from "../lib/types.ts";
import { addProvider } from "./add.ts";
import { providerScreen } from "./provider.ts";
import { proxyProvider } from "./proxy.ts";
import {
	type Env,
	errorText,
	inferProviderApi,
	isProxyOverride,
	jsoncNotes,
	type Notice,
	noticeNote,
	refreshRegistry,
	shortUrl,
	uniqueModelIds,
} from "./shared.ts";
import { testProvider } from "./test.ts";

const PROVIDER_PREFIX = "provider:";

function providerDetail(cfg: ProviderConfig): string {
	if (isProxyOverride(cfg)) return `proxy → ${shortUrl(cfg.baseUrl) || "(no base URL)"}`;
	const api = inferProviderApi(cfg);
	const count = uniqueModelIds(cfg.models).length;
	return [shortUrl(cfg.baseUrl) || "(no base URL)", api ?? "no protocol", `${count} model${count === 1 ? "" : "s"}`].join(" · ");
}

function testBadge(providerId: string): MenuRow["badge"] {
	const record = lastTest(providerId);
	if (!record) return undefined;
	const total = record.passed + record.failed;
	const age = formatAge(Date.now() - record.at);
	if (record.failed > 0) return { text: `✗ ${record.failed}/${total} failed · ${age}`, tone: "error" };
	const latency = record.medianMs !== undefined ? ` · ${formatLatency(record.medianMs)}` : "";
	return { text: `✓ ${record.passed}/${total}${latency} · ${age}`, tone: "success" };
}

export function providerRows(data: ModelsFile, filter?: (cfg: ProviderConfig) => boolean): MenuRow[] {
	return listProviderIds(data)
		.filter((id) => !filter || filter(data.providers![id]!))
		.map((id) => ({
			id: `${PROVIDER_PREFIX}${id}`,
			label: id,
			detail: providerDetail(data.providers![id]!),
			badge: testBadge(id),
		}));
}

/** Pick one provider (for subcommands like `/provider test` without an id). */
export async function pickProvider(
	env: Env,
	title: string,
	filter?: (cfg: ProviderConfig) => boolean,
): Promise<string | undefined> {
	const rows = providerRows(readModelsFile(), filter);
	if (rows.length === 0) {
		env.ctx.ui.notify("No matching providers in models.json — run /provider to add one", "info");
		return undefined;
	}
	const choice = await rowMenu(env.ctx, { title, subtitle: getModelsPath(), entries: rows, escLabel: "cancel" });
	return choice?.id.slice(PROVIDER_PREFIX.length);
}

/**
 * Raw models.json editor. Invalid JSON reopens the editor with the error and
 * the edited text, so a typo never throws the edit away.
 */
export async function editModelsJson(env: Env): Promise<Notice | undefined> {
	const { ctx } = env;
	const path = getModelsPath();
	const original = readModelsFileRaw() ?? '{\n  "providers": {}\n}\n';
	let text = original;
	let error = "";
	while (true) {
		const edited = await loopEditor(ctx, `models.json — ${path}${error ? `\n✗ Not valid: ${error}` : ""}`, text);
		if (edited === undefined || edited.trimEnd() === original.trimEnd()) return undefined;
		text = edited;
		const invalid = validateModelsText(edited);
		if (invalid) {
			error = invalid;
			continue;
		}
		const choice = await loopSelect(ctx, `Save models.json?\nWrite the edited content to ${path}`, ["Yes — save", "No — keep editing"]);
		if (choice === undefined || choice.startsWith("No")) {
			error = "";
			continue;
		}
		writeModelsFileRaw(edited);
		const warning = await refreshRegistry(ctx);
		return warning ? { text: `Saved models.json — ${warning}`, tone: "warning" } : { text: "Saved models.json", tone: "success" };
	}
}

/**
 * /provider home: the providers are the list, actions hang off each one
 * (Enter opens its page, `t` tests it), and adding lives at the bottom.
 */
export async function homeScreen(env: Env): Promise<void> {
	const { ctx } = env;
	let notice: Notice | undefined;
	let cursor: string | undefined;

	while (true) {
		let data: ModelsFile | undefined;
		let loadError: string | undefined;
		try {
			data = readModelsFile();
		} catch (err) {
			loadError = errorText(err);
		}

		const rows = data ? providerRows(data) : [];
		const notes: MenuNote[] = [...noticeNote(notice)];
		if (loadError) notes.push({ text: `✗ ${loadError}`, tone: "error" });
		else if (rows.length === 0) notes.push({ text: "No custom providers yet — add one below.", tone: "muted" });
		notes.push(...jsoncNotes());

		const entries: MenuEntry[] = [...rows];
		if (rows.length) entries.push({ separator: true });
		if (!loadError) {
			entries.push(
				{ id: "add", label: "+ Add provider", kind: "action" },
				{ id: "local", label: "+ Add local server (Ollama · LM Studio · vLLM)", kind: "action" },
				{ id: "proxy", label: "+ Route a built-in provider through a relay", kind: "action" },
			);
		}
		entries.push({ id: "json", label: "Edit models.json", kind: "action" });

		const choice = await rowMenu(ctx, {
			title: "Providers",
			subtitle: getModelsPath(),
			notes,
			entries,
			keys: [{ key: "t", label: "test", applies: (row) => row.id.startsWith(PROVIDER_PREFIX) }],
			initialId: cursor,
			enterLabel: "open",
			escLabel: "close",
		});
		notice = undefined;
		if (!choice) return;
		cursor = choice.id;

		if (choice.id.startsWith(PROVIDER_PREFIX)) {
			const id = choice.id.slice(PROVIDER_PREFIX.length);
			notice = choice.key === "t" ? await testProvider(env, id) : await providerScreen(env, id);
			continue;
		}
		switch (choice.id) {
			case "add":
			case "local": {
				const result = await addProvider(env, { local: choice.id === "local" });
				notice = result.notice;
				if (result.savedId) cursor = `${PROVIDER_PREFIX}${result.savedId}`;
				break;
			}
			case "proxy":
				notice = await proxyProvider(env);
				break;
			case "json":
				notice = await editModelsJson(env);
				break;
		}
	}
}
