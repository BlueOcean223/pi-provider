import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loopEditor, loopInput, loopSelect } from "../lib/loop-ui.ts";
import { sanitizeProviderId } from "../lib/models-json.ts";
import { API_LABELS, API_OPTIONS, type ProviderApi } from "../lib/types.ts";
import { envVarName, formatCompat, isReservedProviderId, maskSecret } from "./shared.ts";

/**
 * One prompt per provider field. The add wizard, its review page and the
 * provider detail page all edit fields through these, so a value typed once is
 * always offered again (prefilled) when the user comes back to it.
 *
 * Each prompt resolves undefined on Esc; callers treat that as "unchanged".
 */

type Ctx = ExtensionCommandContext;

function validateUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return "Base URL is required";
	if (!/^https?:\/\/\S+$/i.test(trimmed)) return "Must start with http:// or https://";
	return undefined;
}

export async function promptBaseUrl(
	ctx: Ctx,
	current: string | undefined,
	opts: { title?: string; placeholder?: string; hint?: string[] } = {},
): Promise<string | undefined> {
	const raw = await loopInput(ctx, opts.title ?? "Base URL", {
		initial: current,
		placeholder: opts.placeholder ?? "https://api.example.com/v1",
		hint: opts.hint ?? ["The endpoint's API root — for most relays it ends in /v1."],
		validate: validateUrl,
	});
	return raw === undefined ? undefined : raw.trim().replace(/\/+$/, "");
}

export type KeyPromptMode = "new" | "edit" | "proxy";

/**
 * API key in a single field: a pasted key is stored, `$NAME` references an
 * environment variable, a leading `!` runs a command at request time (pi's own
 * models.json syntax). What an empty answer means depends on the mode:
 * - new:   no key (use /login or --api-key later)
 * - edit:  keep the stored key (clear a prefilled `$NAME` to remove it)
 * - proxy: keep using /login or environment auth
 *
 * Resolves `{ value }` (value undefined = no key), or undefined on Esc.
 */
export async function promptApiKey(
	ctx: Ctx,
	current: string | undefined,
	mode: KeyPromptMode,
): Promise<{ value: string | undefined } | undefined> {
	const isReference = Boolean(current && (envVarName(current) || current.startsWith("!")));
	const storedLiteral = mode === "edit" && current && !isReference ? current : undefined;
	const hint = [
		"Paste the key to store it in models.json (file mode 0600).",
		"$NAME reads an environment variable when pi sends a request.",
		mode === "new"
			? "Leave empty to skip — sign in later with /login or --api-key."
			: mode === "proxy"
				? "Leave empty to keep using /login or environment auth."
				: storedLiteral
					? `Leave empty to keep the stored key (${maskSecret(storedLiteral)}).`
					: "Clear the field to remove the key.",
	];
	const raw = await loopInput(ctx, "API key", {
		// Never prefill a literal key; references are safe to show and edit.
		initial: isReference || (mode === "new" && current) ? current : undefined,
		placeholder: "sk-…  or  $MY_RELAY_API_KEY",
		hint,
		validate: (value) => {
			const trimmed = value.trim();
			if (trimmed.startsWith("$") && !envVarName(trimmed)) {
				return "Environment variable names use letters, digits and _ (e.g. $MY_RELAY_API_KEY)";
			}
			return undefined;
		},
	});
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return { value: storedLiteral };
	return { value: trimmed };
}

export async function promptProtocol(ctx: Ctx, current: ProviderApi | undefined): Promise<ProviderApi | undefined> {
	const labels = API_OPTIONS.map((api) => API_LABELS[api]);
	const picked = await loopSelect(ctx, "API protocol — how pi talks to this endpoint", labels, {
		escLabel: "back",
		initial: current ? API_LABELS[current] : undefined,
	});
	if (picked === undefined) return undefined;
	return API_OPTIONS[labels.indexOf(picked)];
}

export async function promptDisplayName(
	ctx: Ctx,
	current: string | undefined,
	providerId: string,
): Promise<{ value: string | undefined } | undefined> {
	const raw = await loopInput(ctx, "Display name", {
		initial: current,
		placeholder: providerId,
		hint: ["Shown in /model. Leave empty to show the provider id."],
	});
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return { value: trimmed && trimmed !== providerId ? trimmed : undefined };
}

export async function promptProviderId(ctx: Ctx, current: string): Promise<string | undefined> {
	const raw = await loopInput(ctx, "Provider id", {
		initial: current,
		placeholder: "my-relay",
		hint: ["Used in /model as <id>/<model>. Lowercase letters, digits, - and _."],
		validate: (value) => {
			const id = sanitizeProviderId(value);
			if (!id) return "Use at least one letter or digit";
			if (isReservedProviderId(id)) return `"${id}" is a /provider subcommand — pick another id`;
			return undefined;
		},
	});
	return raw === undefined ? undefined : sanitizeProviderId(raw);
}

const COMPAT_PRESETS: Array<{ label: string; compat: Record<string, unknown> | undefined }> = [
	{ label: "None — pi defaults", compat: undefined },
	{ label: "Relay rejects the developer role", compat: { supportsDeveloperRole: false } },
	{
		label: "Strict OpenAI-compatible server (no developer role, no reasoning_effort)",
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	},
];
const EDIT_JSON = "Edit as JSON…";

function sameCompat(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * Provider-level OpenAI compat flags. Only offered on existing providers: the
 * test panel suggests the right flag when a relay rejects a request field, so
 * nobody has to guess these up front.
 */
export async function promptCompat(
	ctx: Ctx,
	current: Record<string, unknown> | undefined,
): Promise<{ value: Record<string, unknown> | undefined } | undefined> {
	const preset = COMPAT_PRESETS.find((p) => sameCompat(p.compat, current));
	const options = COMPAT_PRESETS.map((p) => p.label);
	const customLabel = preset ? undefined : `Keep current (${formatCompat(current)})`;
	if (customLabel) options.push(customLabel);
	options.push(EDIT_JSON);

	const picked = await loopSelect(ctx, "OpenAI compatibility flags", options, {
		escLabel: "back",
		initial: preset?.label ?? customLabel,
	});
	if (picked === undefined) return undefined;
	if (picked === customLabel) return { value: current };
	if (picked !== EDIT_JSON) return { value: COMPAT_PRESETS.find((p) => p.label === picked)?.compat };

	let text = JSON.stringify(current ?? {}, null, 2);
	let error = "";
	while (true) {
		const edited = await loopEditor(
			ctx,
			`compat (JSON object; Esc = back)${error ? `\n✗ ${error}` : ""}`,
			text,
		);
		if (edited === undefined) return undefined;
		text = edited;
		try {
			const parsed = JSON.parse(edited) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				error = "compat must be a JSON object";
				continue;
			}
			const value = parsed as Record<string, unknown>;
			return { value: Object.keys(value).length > 0 ? value : undefined };
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}
}
