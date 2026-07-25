import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelsFile, ProviderConfig } from "./types.ts";

export function getModelsPath(): string {
	return join(homedir(), ".pi", "agent", "models.json");
}

export function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

export function readModelsFile(path = getModelsPath()): ModelsFile {
	if (!existsSync(path)) {
		return { providers: {} };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as ModelsFile;
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
	writeFileSync(path, body, "utf8");
	try {
		chmodSync(path, 0o600);
	} catch {
		// best-effort; Windows may not support chmod the same way
	}
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
