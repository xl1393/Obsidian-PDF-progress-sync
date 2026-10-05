# PDF Progress Sync

An Obsidian plugin that remembers the last page you read in every PDF and takes you back there, on any device that syncs the vault.

It works with Obsidian's **built-in PDF viewer**. It does not replace the viewer, so it can be used alongside PDF++.

> **Status:** early development (stage 0, skeleton). Not ready for use yet.

## How it works

- While you read, the current page is saved a moment after you turn pages.
- When you open a PDF, it jumps to the most recent page recorded on **any** device.
- Opening a PDF through a page link such as `[[book.pdf#page=12]]` keeps the link's page.
- Each device writes only its own progress file under the plugin folder, and reads all of them. Two devices never write the same file, so file-sync tools (Syncthing, iCloud, Obsidian Sync, etc.) do not produce conflicts even when Obsidian is open on several devices at once.

See [docs/DESIGN.md](docs/DESIGN.md) for details.

## Privacy

- No network access. The build fails if the bundle contains `fetch`, `requestUrl`, `XMLHttpRequest`, `WebSocket`, URLs, `eval`, or Node `require` calls (see `scripts/check-no-network.mjs`).
- It never modifies notes or PDF files. It only writes small JSON files in its own plugin folder.
- No runtime dependencies.

## Platforms

Windows, macOS, Linux, iOS (Android should work but is untested).

## Development

```bash
npm install
npm run build   # type-check, bundle to main.js, run the no-network check
npm test        # unit tests for the storage logic
```

Install by copying `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/pdf-progress-sync/`.

## License

MIT

---

## 简介（中文）

在 Obsidian 自带的 PDF 查看器里自动记住每本 PDF 读到的页码，并在任何同步了同一仓库的设备上接着读。每台设备只写自己的进度文件、读取全部设备的文件取最新的一条，所以多台设备同时开着也不会产生同步冲突。完全不联网，不修改笔记和 PDF。
