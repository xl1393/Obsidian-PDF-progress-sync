import { type DataAdapter, normalizePath } from "obsidian";
import {
	type BookRecord,
	type DeviceFile,
	type FoundRecord,
	deviceFileName,
	emptyDeviceFile,
	isDeviceFileName,
	newestRecord,
	parseDeviceFile,
	renameInOwnFile,
	serializeDeviceFile,
	withRecord,
} from "./store";

/**
 * Reads every device's progress file and writes this device's own file.
 * Files live in the plugin folder, outside the vault index, so all access goes
 * through the vault adapter.
 */
export class ProgressStore {
	private own: DeviceFile;
	private dirty = false;
	private writing: Promise<void> = Promise.resolve();

	constructor(
		private readonly adapter: DataAdapter,
		private readonly dir: string,
		readonly device: string,
	) {
		this.own = emptyDeviceFile(device);
	}

	private get ownPath(): string {
		return normalizePath(`${this.dir}/${deviceFileName(this.device)}`);
	}

	/** Loads this device's own file; call once before anything else. */
	async load(): Promise<void> {
		const parsed = await this.readFile(this.ownPath);
		if (parsed && parsed.device === this.device) this.own = parsed;
	}

	/** This device's records plus every other device's file found on disk. */
	async readAll(): Promise<DeviceFile[]> {
		const files: DeviceFile[] = [this.own];
		if (!(await this.adapter.exists(this.dir))) return files;
		const listing = await this.adapter.list(this.dir);
		for (const path of listing.files) {
			const name = path.slice(path.lastIndexOf("/") + 1);
			if (!isDeviceFileName(name) || normalizePath(path) === this.ownPath) continue;
			const parsed = await this.readFile(path);
			// A conflict copy of our own file only holds older records.
			if (parsed && parsed.device !== this.device) files.push(parsed);
		}
		return files;
	}

	async lookup(path: string): Promise<FoundRecord | null> {
		return newestRecord(await this.readAll(), path);
	}

	record(path: string, record: BookRecord): void {
		this.own = withRecord(this.own, path, record);
		this.dirty = true;
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		this.own = renameInOwnFile(this.own, await this.readAll(), oldPath, newPath);
		this.dirty = true;
		await this.flush();
	}

	/** Every path with a record on any device that lies inside `folder`. */
	async pathsInFolder(folder: string): Promise<string[]> {
		const prefix = folder.endsWith("/") ? folder : `${folder}/`;
		const paths = new Set<string>();
		for (const file of await this.readAll()) {
			for (const path of Object.keys(file.books)) if (path.startsWith(prefix)) paths.add(path);
		}
		return [...paths];
	}

	async clearOwn(): Promise<void> {
		this.own = emptyDeviceFile(this.device);
		this.dirty = true;
		await this.flush();
	}

	/** Writes this device's file if it changed. Writes are serialized. */
	flush(): Promise<void> {
		this.writing = this.writing
			.then(async () => {
				if (!this.dirty) return;
				this.dirty = false;
				if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
				await this.adapter.write(this.ownPath, serializeDeviceFile(this.own));
			})
			.catch((err) => {
				this.dirty = true;
				console.error("PDF Progress Sync: could not save progress", err);
			});
		return this.writing;
	}

	private async readFile(path: string): Promise<DeviceFile | null> {
		try {
			if (!(await this.adapter.exists(path))) return null;
			return parseDeviceFile(await this.adapter.read(path));
		} catch {
			return null;
		}
	}
}
