/**
 * Gate between `npm publish` and the registry.
 *
 * The tarball is an allowlist (`files` in package.json), which fails in two
 * opposite directions and neither one is visible at publish time:
 *
 * - Too much: tests, the test harness or local notes (.agent/) ride along.
 * - Too little: a new module that nobody added to `files` publishes fine and
 *   then throws ERR_MODULE_NOT_FOUND on the user's first /provider.
 *
 * So this asks npm what it would actually ship, and checks both directions
 * against the source rather than against a second hand-maintained list.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Paths that must never reach the registry, matched as path prefixes. */
const FORBIDDEN = [".agent/", "node_modules/", ".git/", "lib/testing/", "scripts/"];
/** A source-only package has no business shipping anything this big. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const report = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0];
const shipped = new Set(report.files.map((f) => f.path));
const failures = [];

for (const { path, size } of report.files) {
	if (FORBIDDEN.some((dir) => path.startsWith(dir))) failures.push(`ships a forbidden path: ${path}`);
	if (path.endsWith(".test.ts")) failures.push(`ships a test file: ${path}`);
	if (size > MAX_FILE_BYTES) failures.push(`${path} is ${(size / 1024).toFixed(0)}kB, over the ${MAX_FILE_BYTES / 1024}kB cap`);
}
if (report.unpackedSize > MAX_UNPACKED_BYTES) {
	failures.push(`unpacked size is ${(report.unpackedSize / 1024).toFixed(0)}kB, over the ${MAX_UNPACKED_BYTES / 1024}kB cap`);
}

// Walk the relative-import graph from the declared entry points. Reaching a
// module the tarball does not carry is the "forgot to add it to files" bug.
const entries = (pkg.pi?.extensions ?? []).map((p) => normalize(p));
if (entries.length === 0) failures.push("package.json has no pi.extensions entry point");

const seen = new Set();
const queue = [...entries];
while (queue.length > 0) {
	const file = queue.shift();
	if (seen.has(file)) continue;
	seen.add(file);
	if (!shipped.has(file)) {
		failures.push(`${file} is imported but missing from files[] in package.json`);
		continue;
	}
	for (const [, target] of readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+\.ts)"/g)) {
		queue.push(normalize(join(dirname(file), target)));
	}
}

// Anything pi bundles must be a peer dependency, never bundled or vendored.
const PI_PROVIDED = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];
for (const dep of PI_PROVIDED) {
	if (pkg.dependencies?.[dep]) failures.push(`${dep} is a dependency; pi provides it, so it belongs in peerDependencies`);
}

if (failures.length > 0) {
	console.error(`verify-pack: ${failures.length} problem(s) with the tarball\n`);
	for (const line of failures.slice(0, 15)) console.error(`  - ${line}`);
	if (failures.length > 15) console.error(`  ... and ${failures.length - 15} more`);
	process.exit(1);
}

console.log(
	`verify-pack: ${report.entryCount} files, ${(report.size / 1024).toFixed(1)}kB packed, ` +
		`${(report.unpackedSize / 1024).toFixed(1)}kB unpacked — reachable from ${entries.join(", ")}`,
);
