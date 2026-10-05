import { App, Modal, Notice, Platform, Plugin, Setting, apiVersion, normalizePath } from "obsidian";
import { DebugLog } from "./debuglog";
import {
	type PdfEvent,
	type PdfEventBus,
	type PdfEventHandler,
	type PdfView,
	getCurrentPage,
	getEventBus,
	getLoadedFile,
	getObsidianViewer,
	getPageCount,
	getPdfJsViewer,
	getRequestedSubpath,
	isPdfView,
	pdfViews,
	setCurrentPage,
	whenViewerReady,
} from "./pdf";

// Stage 1 prototype: observe the built-in PDF viewer and log what happens, so
// the record/restore design can be checked against real event order.

const DEVICE_ID_KEY = "pdf-progress-sync-device-id";

const OBSERVED_EVENTS = [
	"documentinit",
	"documentloaded",
	"pagesinit",
	"pagesloaded",
	"pagechanging",
	"updateviewarea",
	"pagerendered",
] as const;

// updateviewarea and pagerendered fire constantly while scrolling; only log
// them this long after a file is opened, which covers the initial restore.
const EARLY_WINDOW_MS = 5000;

interface Tracker {
	file: string | null;
	openedAt: number;
	bus: PdfEventBus | null;
	handlers: Map<string, PdfEventHandler>;
	waiting: boolean;
	reportedNoBus: boolean;
}

export default class PdfProgressSyncPlugin extends Plugin {
	private debug!: DebugLog;
	private deviceId = "";
	private trackers = new Map<PdfView, Tracker>();

	async onload() {
		this.deviceId = getDeviceId(this.app);
		const dir = this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.debug = new DebugLog(this.app, normalizePath(`${dir}/debug-${this.deviceId}.jsonl`));
		this.debug.log("plugin-load", {
			version: this.manifest.version,
			apiVersion,
			device: this.deviceId,
			platform: {
				desktopApp: Platform.isDesktopApp,
				mobileApp: Platform.isMobileApp,
				ios: Platform.isIosApp,
				android: Platform.isAndroidApp,
				mac: Platform.isMacOS,
				win: Platform.isWin,
				linux: Platform.isLinux,
			},
		});

		this.registerInterval(window.setInterval(() => void this.debug.flush(), 3000));

		this.app.workspace.onLayoutReady(() => {
			this.scan("layout-ready");
			this.registerEvent(this.app.workspace.on("layout-change", () => this.scan("layout-change")));
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scan("active-leaf-change")));
			this.registerEvent(this.app.workspace.on("file-open", (file) => this.scan("file-open", file?.path ?? null)));
		});

		this.addCommand({
			id: "prototype-jump-to-page",
			name: "Prototype: jump to page…",
			checkCallback: (checking) => {
				const view = this.activePdfView();
				if (!view) return false;
				if (!checking) new PageModal(this.app, (page) => this.testJump(view, page)).open();
				return true;
			},
		});

		this.addCommand({
			id: "prototype-log-diagnostics",
			name: "Prototype: log viewer diagnostics",
			checkCallback: (checking) => {
				const view = this.activePdfView();
				if (!view) return false;
				if (!checking) {
					this.logDiagnostics(view);
					void this.debug.flush();
					new Notice("PDF Progress Sync: diagnostics logged");
				}
				return true;
			},
		});
	}

	async onunload() {
		for (const tracker of this.trackers.values()) detach(tracker);
		this.trackers.clear();
		this.debug.log("plugin-unload");
		await this.debug.flush();
	}

	private activePdfView(): PdfView | null {
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		return isPdfView(view) ? view : null;
	}

	private scan(reason: string, openedFile: string | null = null): void {
		const views = pdfViews(this.app);
		for (const view of views) {
			let tracker = this.trackers.get(view);
			if (!tracker) {
				tracker = { file: null, openedAt: Date.now(), bus: null, handlers: new Map(), waiting: false, reportedNoBus: false };
				this.trackers.set(view, tracker);
				this.debug.log("view-found", { reason, file: getLoadedFile(view)?.path ?? null, openedFile });
			}
			this.noteFile(view, tracker, reason);
			this.ensureAttached(view, tracker);
		}
		for (const [view, tracker] of this.trackers) {
			if (!views.includes(view)) {
				detach(tracker);
				this.trackers.delete(view);
				this.debug.log("view-closed", { reason, file: tracker.file });
			}
		}
	}

	private noteFile(view: PdfView, tracker: Tracker, reason: string): void {
		const file = getLoadedFile(view)?.path ?? null;
		if (file === tracker.file) return;
		this.debug.log("file-switch", { reason, from: tracker.file, to: file, page: getCurrentPage(view), subpath: getRequestedSubpath(view) });
		tracker.file = file;
		tracker.openedAt = Date.now();
	}

	private ensureAttached(view: PdfView, tracker: Tracker): void {
		const bus = getEventBus(view);
		if (bus && bus === tracker.bus) return;
		if (!bus) {
			if (tracker.waiting) return;
			if (view.viewer?.child) {
				// The viewer is up but exposes no event bus: nothing to hook. Retried on the next scan.
				if (!tracker.reportedNoBus) this.debug.log("no-event-bus", { file: getLoadedFile(view)?.path ?? null });
				tracker.reportedNoBus = true;
				return;
			}
			tracker.waiting = whenViewerReady(view, () => {
				tracker.waiting = false;
				this.debug.log("viewer-ready", { file: getLoadedFile(view)?.path ?? null });
				this.ensureAttached(view, tracker);
			});
			return;
		}
		detach(tracker);
		tracker.bus = bus;
		for (const name of OBSERVED_EVENTS) {
			const handler: PdfEventHandler = (event) => this.onPdfEvent(view, tracker, name, event);
			bus.on(name, handler);
			tracker.handlers.set(name, handler);
		}
		this.debug.log("attached", { file: getLoadedFile(view)?.path ?? null, pagesCount: getPageCount(view) });
	}

	private onPdfEvent(view: PdfView, tracker: Tracker, name: string, event: PdfEvent): void {
		this.noteFile(view, tracker, `event:${name}`);
		const sinceOpen = Date.now() - tracker.openedAt;
		if ((name === "updateviewarea" || name === "pagerendered") && sinceOpen > EARLY_WINDOW_MS) return;
		const record: Record<string, unknown> = {
			file: tracker.file,
			sinceOpen,
			page: getCurrentPage(view),
			pages: getPageCount(view),
			subpath: getRequestedSubpath(view),
		};
		if (name === "pagechanging") {
			record.pageNumber = event.pageNumber;
			record.previous = event.previous;
		} else if (name === "pagesloaded") {
			record.pagesCount = event.pagesCount;
		} else if (name === "pagerendered") {
			record.pageNumber = event.pageNumber;
		} else if (name === "updateviewarea") {
			const location = event.location as Record<string, unknown> | undefined;
			if (location) {
				record.location = { pageNumber: location.pageNumber, scale: location.scale, top: location.top, left: location.left };
			}
		}
		this.debug.log(`pdf:${name}`, record);
	}

	private testJump(view: PdfView, page: number): void {
		const before = getCurrentPage(view);
		const ok = setCurrentPage(view, page);
		this.debug.log("test-jump", { file: getLoadedFile(view)?.path ?? null, requested: page, before, ok, after: getCurrentPage(view) });
		window.setTimeout(() => {
			this.debug.log("test-jump-later", { file: getLoadedFile(view)?.path ?? null, page: getCurrentPage(view) });
			void this.debug.flush();
		}, 500);
	}

	private logDiagnostics(view: PdfView): void {
		const obsidianViewer = getObsidianViewer(view);
		const pdfJsViewer = getPdfJsViewer(view);
		const innerBus = (pdfJsViewer as unknown as { eventBus?: unknown } | null)?.eventBus;
		this.debug.log("diagnostics", {
			file: getLoadedFile(view)?.path ?? null,
			hasViewer: !!view.viewer,
			hasChild: !!view.viewer?.child,
			hasObsidianViewer: !!obsidianViewer,
			hasPdfJsViewer: !!pdfJsViewer,
			hasEventBus: !!getEventBus(view),
			sameBusAsPdfJsViewer: innerBus === undefined ? null : innerBus === obsidianViewer?.eventBus,
			page: getCurrentPage(view),
			pages: getPageCount(view),
			subpath: getRequestedSubpath(view),
			viewState: view.getState(),
		});
	}
}

function detach(tracker: Tracker): void {
	if (tracker.bus) {
		for (const [name, handler] of tracker.handlers) tracker.bus.off(name, handler);
	}
	tracker.handlers.clear();
	tracker.bus = null;
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

class PageModal extends Modal {
	private value = "";

	constructor(app: App, private readonly onSubmit: (page: number) => void) {
		super(app);
	}

	onOpen() {
		this.setTitle("Jump to page");
		new Setting(this.contentEl).setName("Page").addText((text) => {
			text.inputEl.type = "number";
			text.onChange((value) => (this.value = value));
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") this.submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((button) => button.setButtonText("Go").setCta().onClick(() => this.submit()));
	}

	private submit() {
		const page = Number.parseInt(this.value, 10);
		this.close();
		if (Number.isFinite(page) && page > 0) this.onSubmit(page);
	}

	onClose() {
		this.contentEl.empty();
	}
}
