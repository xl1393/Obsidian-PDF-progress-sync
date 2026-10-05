/*
 * Pure progress-store logic, independent of Obsidian so it can be unit tested.
 *
 * Every device keeps one file, progress/<device>.json, and is the only writer
 * of that file. To find where a book was left off, read every device's file
 * and take the newest record for that path.
 */

export const FORMAT_VERSION = 1;

export interface BookRecord {
	/** 1-based page number. */
	page: number;
	/** Page count when recorded, for display only. */
	pages?: number;
	/** When the page was recorded, in ms since the epoch. */
	ts: number;
}

export interface DeviceFile {
	version: number;
	device: string;
	updated: number;
	books: Record<string, BookRecord>;
}

export interface FoundRecord extends BookRecord {
	device: string;
}

export function emptyDeviceFile(device: string): DeviceFile {
	return { version: FORMAT_VERSION, device, updated: 0, books: {} };
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseRecord(value: unknown): BookRecord | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (!isPositiveInteger(raw.page)) return null;
	if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts) || raw.ts <= 0) return null;
	const record: BookRecord = { page: raw.page, ts: raw.ts };
	if (isPositiveInteger(raw.pages)) record.pages = raw.pages;
	return record;
}

/**
 * Parses a device file. Returns null for anything that is not a device file of
 * a version we understand; individual malformed records are dropped.
 */
export function parseDeviceFile(text: string): DeviceFile | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const raw = data as Record<string, unknown>;
	if (raw.version !== FORMAT_VERSION) return null;
	if (typeof raw.device !== "string" || raw.device.length === 0) return null;
	if (!raw.books || typeof raw.books !== "object" || Array.isArray(raw.books)) return null;
	const books: Record<string, BookRecord> = {};
	for (const [path, value] of Object.entries(raw.books as Record<string, unknown>)) {
		const record = parseRecord(value);
		if (record) books[path] = record;
	}
	const updated = typeof raw.updated === "number" && Number.isFinite(raw.updated) ? raw.updated : 0;
	return { version: FORMAT_VERSION, device: raw.device, updated, books };
}

export function serializeDeviceFile(file: DeviceFile): string {
	return JSON.stringify(file, null, "\t") + "\n";
}

/** The newest record for `path` across all device files, or null. */
export function newestRecord(files: readonly DeviceFile[], path: string): FoundRecord | null {
	let best: FoundRecord | null = null;
	for (const file of files) {
		const record = file.books[path];
		if (record && (!best || record.ts > best.ts)) best = { ...record, device: file.device };
	}
	return best;
}

/** A copy of `file` with `record` stored for `path`. */
export function withRecord(file: DeviceFile, path: string, record: BookRecord): DeviceFile {
	return {
		...file,
		updated: Math.max(file.updated, record.ts),
		books: { ...file.books, [path]: { ...record } },
	};
}

/** A copy of `file` without any record for `path`. */
export function withoutRecord(file: DeviceFile, path: string): DeviceFile {
	if (!(path in file.books)) return file;
	const books = { ...file.books };
	delete books[path];
	return { ...file, books };
}

/**
 * Handles a book being renamed or moved on this device: the newest record for
 * the old path, from any device, is stored in this device's file under the new
 * path, keeping its timestamp so it never beats genuinely newer progress. The
 * old path is dropped from this device's file; other devices' files are left
 * alone because only their owners write them.
 */
export function renameInOwnFile(
	own: DeviceFile,
	all: readonly DeviceFile[],
	oldPath: string,
	newPath: string,
): DeviceFile {
	const newest = newestRecord([own, ...all], oldPath);
	let next = withoutRecord(own, oldPath);
	const existing = next.books[newPath];
	if (newest && (!existing || newest.ts > existing.ts)) {
		const { device: _device, ...record } = newest;
		next = withRecord(next, newPath, record);
	}
	return next;
}

/**
 * Whether a file name in the progress folder is a device file worth reading.
 * Sync-conflict copies are read too: they only hold older records, which the
 * newest-wins rule ignores.
 */
export function isDeviceFileName(name: string): boolean {
	return name.endsWith(".json") && !name.startsWith(".") && !name.startsWith("~");
}

export function deviceFileName(device: string): string {
	return `${device}.json`;
}
