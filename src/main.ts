import { type App, Notice, Platform, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { DebugLog } from "./debuglog";
import { type PdfView, getLoadedFile, isPdfView, pdfViews } from "./pdf";
import { ProgressStore } from "./progress";
import { PdfSession, type SessionHost } from "./session";
import { DEFAULT_SETTINGS, type PdfProgressSyncSettings, PdfProgressSyncSettingTab } from "./settings";

const DEVICE_ID_KEY = "pdf-progress-sync-device-id";
/**
 * After the app regains focus, wait this long before checking for newer
 * progress: the click that focused the window may also switch tabs, and only
 * the tab that ends up in front should move.
 */
const FOCUS_CHECK_DELAY_MS = 300;

export default class PdfProgressSyncPlugin extends Plugin implements SessionHost {
	settings: PdfProgressSyncSettings = { ...DEFAULT_SETTINGS };
	deviceId = "";
	store!: ProgressStore;
	debug: DebugLog | null = null;
	private pluginDir = "";
	private focusTimer: number | null = null;
	private readonly sessions = new Map<PdfView, PdfSession>();

	async onload() {
		await this.loadSettings();
		this.deviceId = getDeviceId(this.app);
		this.pluginDir = this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.store = new ProgressStore(this.app.vault.adapter, normalizePath(`${this.pluginDir}/progress`), this.deviceId);
		await this.store.load();
		this.updateDebugLog();

		this.addSettingTab(new PdfProgressSyncSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.scan("layout-ready");
			this.registerEvent(this.app.workspace.on("layout-change", () => this.scan("layout-change")));
			this.registerEvent(this.app.workspace.on("file-open", () => this.scan("file-open")));
			this.registerEvent(
				this.app.workspace.on("active-leaf-change", (leaf) => {
					this.debug?.log("leaf-change", { type: leaf?.view?.getViewType() ?? null, known: !!leaf && isPdfView(leaf.view) && this.sessions.has(leaf.view) });
					this.scan("active-leaf-change");
					if (leaf && isPdfView(leaf.view)) void this.sessions.get(leaf.view)?.followNewer("tab-activated");
				}),
			);
		});

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => void this.onRename(file, oldPath)),
		);

		// Coming back to the app: pick up progress made elsewhere. Leaving it: save now,
		// because a mobile app may be suspended before the save timer fires.
		this.registerDomEvent(window, "focus", () => this.checkFrontSoon("window-focus"));
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flushAll();
			else this.checkFrontSoon("app-visible");
		});
		this.registerInterval(window.setInterval(() => void this.debug?.flush(), 5000));

		this.addCommand({
			id: "show-progress",
			name: "Show reading progress for this PDF",
			checkCallback: (checking) => {
				const view = this.activePdfView();
				const file = view ? getLoadedFile(view) : null;
				if (!file) return false;
				if (!checking) void this.showProgress(file.path);
				return true;
			},
		});
	}

	async onunload() {
		if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
		await this.store.flush();
		this.debug?.log("plugin-unload");
		await this.debug?.flush();
	}

	notice(message: string): void {
		new Notice(`PDF Progress Sync: ${message}`);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.updateDebugLog();
	}

	async clearOwnRecords(): Promise<void> {
		for (const session of this.sessions.values()) session.flushPending();
		await this.store.clearOwn();
	}

	private async loadSettings(): Promise<void> {
		const data: unknown = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...(data && typeof data === "object" ? (data as Partial<PdfProgressSyncSettings>) : {}) };
	}

	private updateDebugLog(): void {
		if (this.settings.debugLog && !this.debug) {
			this.debug = new DebugLog(this.app, normalizePath(`${this.pluginDir}/debug-${this.deviceId}.jsonl`));
			this.debug.log("debug-start", {
				version: this.manifest.version,
				device: this.deviceId,
				mobile: Platform.isMobileApp,
				ios: Platform.isIosApp,
			});
		} else if (!this.settings.debugLog && this.debug) {
			void this.debug.flush();
			this.debug = null;
		}
	}

	private activePdfView(): PdfView | null {
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		return isPdfView(view) ? view : null;
	}

	private activeSession(): PdfSession | null {
		const view = this.activePdfView();
		return view ? (this.sessions.get(view) ?? null) : null;
	}

	private scan(reason: string): void {
		const views = pdfViews(this.app);
		for (const view of views) {
			let session = this.sessions.get(view);
			if (!session) {
				session = new PdfSession(view, this);
				this.sessions.set(view, session);
			}
			session.sync(reason);
		}
		for (const [view, session] of this.sessions) {
			if (!views.includes(view)) {
				session.dispose();
				this.sessions.delete(view);
			}
		}
	}

	private checkFrontSoon(reason: string): void {
		if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
		this.focusTimer = window.setTimeout(() => {
			this.focusTimer = null;
			void this.activeSession()?.followNewer(reason);
		}, FOCUS_CHECK_DELAY_MS);
	}

	private flushAll(): void {
		for (const session of this.sessions.values()) session.flushPending();
		void this.store.flush();
		void this.debug?.flush();
	}

	private async onRename(file: TFile | TFolder | unknown, oldPath: string): Promise<void> {
		if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
			await this.renameBook(oldPath, file.path);
		} else if (file instanceof TFolder) {
			for (const path of await this.store.pathsInFolder(oldPath)) {
				await this.renameBook(path, file.path + path.slice(oldPath.length));
			}
		}
	}

	private async renameBook(oldPath: string, newPath: string): Promise<void> {
		for (const session of this.sessions.values()) session.renamed(oldPath, newPath);
		await this.store.rename(oldPath, newPath);
		this.debug?.log("rename", { from: oldPath, to: newPath });
	}

	private async showProgress(path: string): Promise<void> {
		const files = await this.store.readAll();
		const lines = files
			.map((file) => ({ device: file.device, record: file.books[path] }))
			.filter((entry) => entry.record)
			.sort((a, b) => b.record.ts - a.record.ts)
			.map(({ device, record }) => {
				const own = device === this.deviceId ? " (this device)" : "";
				const total = record.pages ? ` of ${record.pages}` : "";
				return `${device}${own}: page ${record.page}${total}, ${new Date(record.ts).toLocaleString()}`;
			});
		new Notice(lines.length ? `Reading progress\n${lines.join("\n")}` : "PDF Progress Sync: no progress recorded for this PDF yet", 10000);
	}
}

function getDeviceId(app: App): string {
	const existing: unknown = app.loadLocalStorage(DEVICE_ID_KEY);
	if (typeof existing === "string" && /^[a-z]+-[a-z0-9]{6}$/.test(existing)) return existing;
	const prefix = Platform.isIosApp
		? "ios"
		: Platform.isAndroidApp
			? "android"
			: Platform.isMacOS
				? "mac"
				: Platform.isWin
					? "win"
					: Platform.isLinux
						? "linux"
						: "device";
	const id = `${prefix}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
	app.saveLocalStorage(DEVICE_ID_KEY, id);
	return id;
}
