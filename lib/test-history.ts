/**
 * Last test result per provider, kept for the lifetime of the pi process so
 * the provider list can show health next to each row (like the status dots in
 * Cherry Studio / cc-switch) without writing anything to models.json.
 */

export interface TestRecord {
	at: number;
	passed: number;
	failed: number;
	/** Median latency of the passing chat tests, when there were any. */
	medianMs?: number;
}

const records = new Map<string, TestRecord>();

export function recordTest(providerId: string, record: TestRecord): void {
	records.set(providerId, record);
}

export function lastTest(providerId: string): TestRecord | undefined {
	return records.get(providerId);
}

export function forgetTest(providerId: string): void {
	records.delete(providerId);
}

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return `${hours}h ago`;
}
