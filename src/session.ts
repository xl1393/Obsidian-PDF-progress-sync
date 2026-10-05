import type { DebugLog } from "./debuglog";
import type { ProgressStore } from "./progress";
import type { PdfProgressSyncSettings } from "./settings";
import {
	type PdfEvent,
	type PdfEventBus,
	type PdfEventHandler,
	type PdfView,
	getCurrentPage,
	getEventBus,
	getLoadedFile,
	getPageCount,
	getRequestedSubpath,
	setCurrentPage,
	subpathPage,
	whenViewerReady,
} from "./pdf";

/** Delay after `pagesloaded` before restoring, so the layout has settled. */
const SETTLE_DELAY_MS = 150;
/** How long page changes caused by our own jump are ignored. */
const JUMP_QUIET_MS = 400;
/** Restore anyway if `pagesloaded` never arrives. */
const FALLBACK_MS = 4000;
/** Page changes are saved this long after the last one. */
const SAVE_DELAY_MS = 2000;
/**
 * A PDF opened through a link is being looked up, not read: page changes are
 * only saved once the reader has moved more than this many pages forward from
 * where the link landed.
 */
export const PEEK_PAGES = 3;

export interface SessionHost {
	readonly store: ProgressStore;
	readonly settings: PdfProgressSyncSettings;
	readonly deviceId: string;
	readonly debug: DebugLog | null;
	notice(message: string): void;
}

type Phase = "idle" | "settling" | "quiet" | "tracking";

interface PendingSave {
	path: string;
	page: number;
	pages?: number;
	ts: number;
}

/**
 * Tracks one PDF view. After a file is opened the session is "settling": page
 * changes come from PDF.js's own restore and layout jitter, so none are saved.
 * Once our restore has run, a short "quiet" phase absorbs the jitter of our own
 * jump, and then the session is "tracking": every page change is saved, except
 * that a PDF opened through a link stays in lookup mode until the reader moves
 * more than PEEK_PAGES pages forward.
 */
export class PdfSession {
	file: string | null = null;
	private phase: Phase = "idle";
	private generation = 0;
	private bus: PdfEventBus | null = null;
	private readonly handlers = new Map<string, PdfEventHandler>();
	private waitingForViewer = false;
	private reportedNoBus = false;
	private pending: PendingSave | null = null;
	/** Page a link landed on while the session is in lookup mode, otherwise null. */
	private peekAnchor: number | null = null;
	/** Time of the latest page known to be current here: opening, our jumps, or the reader's own page turns. */
	private lastActivity = 0;
	private settleTimer: number | null = null;
	private restoreTimer: number | null = null;
	private quietTimer: number | null = null;
	private saveTimer: number | null = null;

	constructor(
		readonly view: PdfView,
		private readonly host: SessionHost,
	) {}

	/** Called whenever the workspace changes; picks up file switches and hooks the viewer. */
	sync(reason: string): void {
		this.noteFile(reason);
		this.ensureAttached();
	}

	/** The loaded file was renamed or moved; keep tracking it without restoring. */
	renamed(oldPath: string, newPath: string): void {
		if (this.file === oldPath) this.file = newPath;
		if (this.pending?.path === oldPath) this.pending.path = newPath;
	}

	/** Saves any unsaved page change now. */
	flushPending(): void {
		this.clearTimer("saveTimer");
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		this.host.store.record(pending.path, { page: pending.page, pages: pending.pages, ts: pending.ts });
		void this.host.store.flush();
		this.log("saved", { file: pending.path, page: pending.page });
	}

	/**
	 * Jumps to newer progress from another device, if any was recorded after the
	 * last page known here. Used when the reader comes back to an open PDF.
	 */
	async followNewer(reason: string): Promise<void> {
		this.log("check-newer", { reason, file: this.file, phase: this.phase });
		if (this.phase !== "tracking" || !this.file || !this.host.settings.followOtherDevices) return;
		const generation = this.generation;
		const path = this.file;
		const newest = await this.host.store.lookup(path);
		if (generation !== this.generation || this.phase !== "tracking" || this.file !== path) return;
		if (!newest || newest.device === this.host.deviceId || newest.ts <= this.lastActivity) return;
		this.lastActivity = newest.ts;
		const current = getCurrentPage(this.view);
		this.log("follow", { reason, file: path, current, target: newest.page, from: newest.device });
		if (current === newest.page) return;
		this.flushPending();
		this.peekAnchor = null;
		if (this.jump(newest.page, generation)) this.notify(`"${bookName(path)}" moved to page ${newest.page}, read on ${newest.device}`);
	}

	dispose(): void {
		this.log("view-closed", { file: this.file });
		this.flushPending();
		this.detach();
		for (const timer of ["settleTimer", "restoreTimer", "quietTimer", "saveTimer"] as const) this.clearTimer(timer);
		this.phase = "idle";
	}

	private noteFile(reason: string): void {
		const path = getLoadedFile(this.view)?.path ?? null;
		if (path === this.file) return;
		this.flushPending();
		this.log("file-open", { reason, from: this.file, to: path });
		this.file = path;
		this.startSettling();
	}

	private startSettling(): void {
		const generation = ++this.generation;
		for (const timer of ["settleTimer", "restoreTimer", "quietTimer"] as const) this.clearTimer(timer);
		this.lastActivity = Date.now();
		this.peekAnchor = null;
		if (!this.file) {
			this.phase = "idle";
			return;
		}
		this.phase = "settling";
		this.settleTimer = window.setTimeout(() => void this.restore(generation, "fallback"), FALLBACK_MS);
		// The plugin can attach after the document has loaded (for example at startup).
		if (getPageCount(this.view)) this.scheduleRestore(generation, "already-loaded");
	}

	private scheduleRestore(generation: number, reason: string): void {
		this.clearTimer("restoreTimer");
		this.restoreTimer = window.setTimeout(() => void this.restore(generation, reason), SETTLE_DELAY_MS);
	}

	private async restore(generation: number, reason: string): Promise<void> {
		if (generation !== this.generation || this.phase !== "settling" || !this.file) return;
		this.clearTimer("settleTimer");
		this.clearTimer("restoreTimer");
		this.phase = "quiet";
		const path = this.file;
		const subpath = getRequestedSubpath(this.view);
		const target = !subpath && this.host.settings.restoreOnOpen ? await this.host.store.lookup(path) : null;
		if (generation !== this.generation || this.file !== path) return;
		const current = getCurrentPage(this.view);
		if (subpath) this.peekAnchor = subpathPage(subpath) ?? current ?? 1;
		this.log("restore", { reason, file: path, subpath, current, target: target?.page ?? null, from: target?.device ?? null });
		if (target && current !== target.page) {
			if (this.jump(target.page, generation)) {
				const where = target.device === this.host.deviceId ? "" : `, read on ${target.device}`;
				this.notify(`"${bookName(path)}" resumed at page ${target.page}${where}`);
			}
		} else {
			this.endQuietLater(generation);
		}
	}

	/** Moves to `page`, ignoring the page changes this causes. Returns false if the viewer was not ready. */
	private jump(page: number, generation: number): boolean {
		this.phase = "quiet";
		const ok = setCurrentPage(this.view, page);
		this.lastActivity = Math.max(this.lastActivity, Date.now());
		this.endQuietLater(generation);
		this.log("jump", { file: this.file, page, ok });
		return ok;
	}

	private endQuietLater(generation: number): void {
		this.clearTimer("quietTimer");
		this.quietTimer = window.setTimeout(() => {
			if (generation === this.generation && this.phase === "quiet") this.phase = "tracking";
		}, JUMP_QUIET_MS);
	}

	private onEvent(name: string, event: PdfEvent): void {
		this.noteFile(`event:${name}`);
		if (name === "pagesloaded") {
			if (this.phase === "settling") this.scheduleRestore(this.generation, "pagesloaded");
		} else if (name === "pagechanging") {
			if (this.phase === "tracking") this.onPageChange(event.pageNumber);
		}
	}

	private onPageChange(page: unknown): void {
		if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || !this.file) return;
		const now = Date.now();
		this.lastActivity = now;
		if (this.peekAnchor !== null) {
			if (page - this.peekAnchor <= PEEK_PAGES) return;
			this.log("peek-ended", { file: this.file, anchor: this.peekAnchor, page });
			this.peekAnchor = null;
		}
		this.pending = { path: this.file, page, pages: getPageCount(this.view) ?? undefined, ts: now };
		this.clearTimer("saveTimer");
		this.saveTimer = window.setTimeout(() => this.flushPending(), SAVE_DELAY_MS);
	}

	private ensureAttached(): void {
		const bus = getEventBus(this.view);
		if (bus && bus === this.bus) return;
		if (!bus) {
			if (this.waitingForViewer) return;
			if (this.view.viewer?.child) {
				// The viewer is up but has no event bus; nothing to hook. Retried on the next workspace change.
				if (!this.reportedNoBus) this.log("no-event-bus", { file: this.file });
				this.reportedNoBus = true;
				return;
			}
			this.waitingForViewer = whenViewerReady(this.view, () => {
				this.waitingForViewer = false;
				this.sync("viewer-ready");
			});
			return;
		}
		this.detach();
		this.bus = bus;
		for (const name of ["pagesloaded", "pagechanging"]) {
			const handler: PdfEventHandler = (event) => this.onEvent(name, event);
			bus.on(name, handler);
			this.handlers.set(name, handler);
		}
		this.log("attached", { file: this.file, pages: getPageCount(this.view) });
	}

	private detach(): void {
		if (this.bus) for (const [name, handler] of this.handlers) this.bus.off(name, handler);
		this.handlers.clear();
		this.bus = null;
	}

	private clearTimer(name: "settleTimer" | "restoreTimer" | "quietTimer" | "saveTimer"): void {
		const timer = this[name];
		if (timer !== null) window.clearTimeout(timer);
		this[name] = null;
	}

	private notify(message: string): void {
		if (this.host.settings.showNotices) this.host.notice(message);
	}

	private log(event: string, data: Record<string, unknown>): void {
		this.host.debug?.log(event, data);
	}
}

function bookName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
}
