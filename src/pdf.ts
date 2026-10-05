import type { App, TFile, View } from "obsidian";

/*
 * Everything that touches Obsidian's private PDF viewer objects lives in this
 * file. The object chain (Obsidian 1.8+) is:
 *
 *   view.viewer              PDFViewerComponent
 *     .child                 PDFViewerChild (null until the viewer is ready)
 *       .pdfViewer           ObsidianViewer, built on PDF.js PDFViewerApplication
 *         .pdfViewer         PDF.js PDFViewer (null until a document is loaded)
 *
 * Every accessor returns null when a link is missing, so a change in Obsidian
 * makes the plugin do nothing rather than break the viewer.
 */

export type PdfEvent = Record<string, unknown>;
export type PdfEventHandler = (event: PdfEvent) => void;

export interface PdfEventBus {
	on(name: string, handler: PdfEventHandler): void;
	off(name: string, handler: PdfEventHandler): void;
}

export interface PdfJsViewer {
	currentPageNumber: number;
	pagesCount: number;
}

export interface ObsidianPdfViewer {
	eventBus?: PdfEventBus | null;
	pdfViewer?: PdfJsViewer | null;
	subpath?: string | null;
}

interface PdfViewerChild {
	file?: TFile | null;
	pdfViewer?: ObsidianPdfViewer | null;
	unloaded?: boolean;
}

interface PdfViewerComponent {
	child?: PdfViewerChild | null;
	then?: (callback: (child: PdfViewerChild) => void) => void;
}

export interface PdfView extends View {
	file: TFile | null;
	viewer?: PdfViewerComponent | null;
}

export function isPdfView(view: View | null | undefined): view is PdfView {
	return !!view && view.getViewType() === "pdf";
}

export function pdfViews(app: App): PdfView[] {
	return app.workspace
		.getLeavesOfType("pdf")
		.map((leaf) => leaf.view)
		.filter(isPdfView);
}

function getChild(view: PdfView): PdfViewerChild | null {
	const child = view.viewer?.child;
	return child && !child.unloaded ? child : null;
}

/**
 * Asks the viewer to run `callback` once its child exists. Returns false when
 * the viewer does not offer the hook, in which case the caller retries later.
 */
export function whenViewerReady(view: PdfView, callback: () => void): boolean {
	const viewer = view.viewer;
	if (!viewer || typeof viewer.then !== "function") return false;
	viewer.then(() => callback());
	return true;
}

export function getObsidianViewer(view: PdfView): ObsidianPdfViewer | null {
	return getChild(view)?.pdfViewer ?? null;
}

export function getEventBus(view: PdfView): PdfEventBus | null {
	const bus = getObsidianViewer(view)?.eventBus;
	return bus && typeof bus.on === "function" && typeof bus.off === "function" ? bus : null;
}

export function getPdfJsViewer(view: PdfView): PdfJsViewer | null {
	return getObsidianViewer(view)?.pdfViewer ?? null;
}

/** The file actually loaded in the viewer, falling back to the view's file. */
export function getLoadedFile(view: PdfView): TFile | null {
	return getChild(view)?.file ?? view.file ?? null;
}

export function getCurrentPage(view: PdfView): number | null {
	const page = getPdfJsViewer(view)?.currentPageNumber;
	return typeof page === "number" && page > 0 ? page : null;
}

export function getPageCount(view: PdfView): number | null {
	const count = getPdfJsViewer(view)?.pagesCount;
	return typeof count === "number" && count > 0 ? count : null;
}

/** Jumps to a 1-based page. Returns false if the viewer is not ready. */
export function setCurrentPage(view: PdfView, page: number): boolean {
	const viewer = getPdfJsViewer(view);
	if (!viewer || !(viewer.pagesCount > 0)) return false;
	viewer.currentPageNumber = Math.min(Math.max(1, Math.round(page)), viewer.pagesCount);
	return true;
}

/** The subpath (such as "#page=12") the view was asked to open, if any. */
export function getRequestedSubpath(view: PdfView): string | null {
	const subpath = getObsidianViewer(view)?.subpath;
	return typeof subpath === "string" && subpath.length > 0 ? subpath : null;
}

/**
 * The 1-based page a requested subpath points to. Obsidian keeps a link's
 * destination either as "#page=N…" or as a PDF.js destination array whose
 * first element is the 0-based page index, such as `[19,{"name":"FitBH"},null]`.
 */
export function subpathPage(subpath: string | null): number | null {
	if (!subpath) return null;
	const hash = /[#&]page=(\d+)/.exec(subpath);
	if (hash) return Number(hash[1]) || null;
	const dest = /^\[\s*(\d+)\s*,/.exec(subpath);
	if (dest) return Number(dest[1]) + 1;
	return null;
}

