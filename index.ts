/**
 * pi-provider
 *
 * Interactive /provider command to manage custom providers in ~/.pi/agent/models.json
 * (relays / 中转站 / local OpenAI-compatible servers).
 *
 * Usage in pi:  /provider                  provider list (Enter opens one, t tests it)
 *               /provider <id>             open a provider's page
 *               /provider add | local      add a relay / a local server
 *               /provider models [id]      add or remove models
 *               /provider proxy            route a built-in provider through a relay
 *               /provider test [id]        test connectivity and chat per model
 *               /provider remove [id]      delete a provider
 *               /provider path             edit models.json
 *
 * UX notes:
 * - screens are object-first: pick a provider, then act on it
 * - lists loop: ↑ on the first row jumps to the last and vice versa
 * - multi-step flows: Esc goes back one step (Esc on the first step exits)
 * - outcomes show as a note on the next screen; a subcommand that exits to the
 *   chat reports its outcome as a single notify line
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addProvider } from "./flows/add.ts";
import { editModelsJson, homeScreen, pickProvider } from "./flows/home.ts";
import { manageModels } from "./flows/models.ts";
import { confirmDelete, providerScreen } from "./flows/provider.ts";
import { proxyProvider } from "./flows/proxy.ts";
import {
	canManageModels,
	type Env,
	errorText,
	findProviderId,
	report,
	SUBCOMMAND_ALIASES as ALIASES,
	SUBCOMMANDS,
} from "./flows/shared.ts";
import { testProvider } from "./flows/test.ts";
import { getModelsPath, listProviderIds, readModelsFile, summarizeProvider } from "./lib/models-json.ts";

/** Subcommands whose second argument is a provider id. */
const TAKES_PROVIDER = new Set(["models", "add-models", "test", "probe", "remove", "rm"]);

/** Resolve a provider id typed as an argument, or ask for one. */
async function resolveProvider(
	env: Env,
	typed: string | undefined,
	title: string,
	filter?: Parameters<typeof pickProvider>[2],
): Promise<string | undefined> {
	if (!typed) return pickProvider(env, title, filter);
	const id = findProviderId(readModelsFile(), typed);
	if (!id) env.ctx.ui.notify(`Unknown provider "${typed}"`, "error");
	return id;
}

async function run(env: Env, sub: string, arg: string | undefined): Promise<void> {
	switch (ALIASES[sub] ?? sub) {
		case "":
		case "list":
			return homeScreen(env);
		case "add":
			return report(env, (await addProvider(env)).notice);
		case "local":
			return report(env, (await addProvider(env, { local: true })).notice);
		case "models": {
			const id = await resolveProvider(env, arg, "Manage models of", canManageModels);
			if (id) report(env, await manageModels(env, id));
			return;
		}
		case "proxy":
			return report(env, await proxyProvider(env));
		case "test": {
			const id = await resolveProvider(env, arg, "Test provider");
			if (id) report(env, await testProvider(env, id));
			return;
		}
		case "remove": {
			const id = await resolveProvider(env, arg, "Delete provider");
			const cfg = id ? readModelsFile().providers?.[id] : undefined;
			if (id && cfg) report(env, await confirmDelete(env, id, cfg));
			return;
		}
		case "path":
			return report(env, await editModelsJson(env));
		default: {
			// `/provider my-relay` opens that provider's page.
			const id = findProviderId(readModelsFile(), sub);
			if (id) return report(env, await providerScreen(env, id));
			env.ctx.ui.notify(`Unknown subcommand or provider "${sub}". Try: ${SUBCOMMANDS.join(" | ")}`, "error");
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("provider", {
		description: "Manage custom providers / relays in models.json",
		getArgumentCompletions: (prefix: string) => {
			let data: ReturnType<typeof readModelsFile>;
			try {
				data = readModelsFile();
			} catch {
				data = { providers: {} };
			}
			const ids = listProviderIds(data);
			const describe = (id: string) => summarizeProvider(id, data.providers![id]!);

			const withProvider = prefix.match(/^\s*(\S+)\s+(.*)$/);
			if (withProvider) {
				const command = withProvider[1]!.toLowerCase();
				if (!TAKES_PROVIDER.has(command)) return null;
				const query = withProvider[2]!.trim().toLowerCase();
				const needsModels = (ALIASES[command] ?? command) === "models";
				const items = ids
					.filter((id) => id.toLowerCase().startsWith(query))
					.filter((id) => !needsModels || canManageModels(data.providers![id]!))
					.map((id) => ({ value: `${command} ${id}`, label: id, description: describe(id) }));
				return items.length > 0 ? items : null;
			}

			const query = prefix.trim().toLowerCase();
			const items = [
				...SUBCOMMANDS.filter((s) => s.startsWith(query)).map((s) => ({ value: s, label: s })),
				...ids
					.filter((id) => id.toLowerCase().startsWith(query) && !(SUBCOMMANDS as readonly string[]).includes(id))
					.map((id) => ({ value: id, label: id, description: describe(id) })),
			];
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				console.error("[pi-provider] This command needs interactive UI (TUI). File:", getModelsPath());
				return;
			}
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const env: Env = { ctx, pi };
			try {
				await run(env, (parts[0] ?? "").toLowerCase(), parts[1]);
			} catch (err) {
				ctx.ui.notify(`provider setup failed: ${errorText(err)}`, "error");
			}
		},
	});
}
