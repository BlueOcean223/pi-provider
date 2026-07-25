import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelsFile, ProviderConfig } from "./types.ts";

export function getModelsPath(): string {
	// getAgentDir honors PI_CODING_AGENT_DIR and rebranded config dirs.
	return join(getAgentDir(), "models.json");
}

/**
 * Strip `//` line comments and trailing commas, leaving string literals
 * untouched. Mirrors pi's own models.json parsing (utils/json.ts): pi accepts
 * JSONC, so we must accept it too.
 */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** True when models.json contains comments / trailing commas that a rewrite would drop. */
export function modelsFileHasJsonc(path = getModelsPath()): boolean {
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf8");
		return stripJsonComments(raw) !== raw;
	} catch {
		return false;
	}
}

export function readModelsFile(path = getModelsPath()): ModelsFile {
	if (!existsSync(path)) {
		return { providers: {} };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(stripJsonComments(raw)) as ModelsFile;
		if (!parsed.providers || typeof parsed.providers !== "object") {
			parsed.providers = {};
		}
		return parsed;
	} catch (err) {
		throw new Error(
			`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export function writeModelsFile(data: ModelsFile, path = getModelsPath()): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const body = `${JSON.stringify(data, null, 2)}\n`;
	// Write to a temp file and rename: pi rejects the whole models.json (all
	// providers) on a parse error, so a crash mid-write must not corrupt it.
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, body, "utf8");
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// best-effort; Windows may not support chmod the same way
	}
	renameSync(tmp, path);
}

export function listProviderIds(data: ModelsFile): string[] {
	return Object.keys(data.providers ?? {}).sort();
}

export function upsertProvider(
	data: ModelsFile,
	id: string,
	config: ProviderConfig,
): ModelsFile {
	const next: ModelsFile = {
		...data,
		providers: {
			...(data.providers ?? {}),
			[id]: config,
		},
	};
	return next;
}

export function removeProvider(data: ModelsFile, id: string): ModelsFile {
	const providers = { ...(data.providers ?? {}) };
	delete providers[id];
	return { ...data, providers };
}

export function summarizeProvider(id: string, cfg: ProviderConfig): string {
	const parts = [id];
	if (cfg.baseUrl) parts.push(cfg.baseUrl);
	if (cfg.api) parts.push(cfg.api);
	const n = cfg.models?.length ?? 0;
	if (n > 0) parts.push(`${n} model(s)`);
	else if (!cfg.models) parts.push("proxy override");
	return parts.join(" · ");
}

/** Sanitize provider id: lowercase, alnum + hyphen/underscore. */
export function sanitizeProviderId(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}
