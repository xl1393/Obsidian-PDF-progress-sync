# Design

## Goals

1. Resume every PDF at the last page read, across devices.
2. Use Obsidian's built-in PDF viewer; coexist with PDF++.
3. Be safe with any file-sync tool, including ones that are not real-time and including several devices running Obsidian at the same time.
4. No network access; never modify notes or PDFs.
5. Run on desktop and mobile (no Node or Electron APIs).

## Reading and setting the page

Obsidian does not expose a public API for the PDF viewer. The plugin reaches PDF.js through the same object chain PDF++ uses:

```
leaf.view                 view type "pdf", view.file is the PDF
  .viewer.child.pdfViewer.pdfViewer   PDF.js PDFViewer
      .currentPageNumber              read, or assign to jump (1-based)
      .pagesCount                     0 until pages are laid out
      .eventBus "pagechanging"        fired on every page change
      .eventBus "pagesloaded"         fired once the document is laid out
```

All access to this chain lives in `src/pdf.ts`. If any link is missing (for example after an Obsidian update), the plugin does nothing and reading is unaffected.

- **Record:** listen to `pagechanging`, debounce about 2 s, then save. Also save immediately when the view switches file, the tab closes, or the plugin unloads.
- **Restore:** after `pagesloaded`, set `currentPageNumber`. The plugin must win against PDF.js's own per-device history, which also restores a page.
- **Links win:** if the view was opened with a subpath such as `#page=12`, do not restore.

## Storage: one file per device

```
.obsidian/plugins/pdf-progress-sync/progress/
    <device-id>.json      written only by this device
    <other-device>.json   arrives through sync; read-only here
```

```json
{
  "device": "desktop-1a2b",
  "updated": 1791158080930,
  "books": {
    "Books/Example.pdf": { "page": 57, "pages": 258, "ts": 1791158080930 }
  }
}
```

- **Device ID:** generated once and kept in `app.saveLocalStorage`, which is per device and not part of the vault.
- **Read:** on every PDF open, read all files in `progress/` and take the entry with the newest `ts` for that path. Reading from disk each time means progress synced from another device is picked up without restarting Obsidian.
- **Why no conflicts:** a file only ever has one writer, so sync tools never see concurrent edits.
- **Writes** go through `app.vault.adapter` (the plugin folder is not indexed by the vault) using write-to-temp-then-rename.
- **Renames:** on `vault.on("rename")`, the newest entry for the old path is copied to the new path in this device's file.
- **Clocks:** "newest wins" assumes device clocks are roughly right, which holds for personal devices.

## Settings

- Restore automatically (default on).
- Device display name.
- Clear this device's records.

## Stages

0. Skeleton, build, no-network check.
1. Prototype: log page changes and jump to a page; confirm the internal chain on desktop and iOS, and the order relative to PDF.js's own restore.
2. Storage module and unit tests.
3. Integration: automatic record and restore, link precedence, settings.
4. Cross-device testing on Windows, macOS, Linux, iOS.
5. Docs, release v1.0.0.
6. Optional: in-page scroll offset and zoom.
