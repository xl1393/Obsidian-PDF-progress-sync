import type { App } from "obsidian";

/**
 * Buffered JSON-lines log written to a per-device file in the plugin folder,
 * so devices never write the same file. Prototype-only.
 */
export class DebugLog {
	private lines: string[] = [];
	private flushing: Promise<void> = Promise.resolve();

	constructor(private readonly app: App, readonly path: string) {}

	log(event: string, data: Record<string, unknown> = {}): void {
		this.lines.push(JSON.stringify({ t: Date.now(), event, ...data }));
	}

	flush(): Promise<void> {
		this.flushing = this.flushing.then(() => this.write()).catch((err) => {
			console.error("pdf-progress-sync: failed to write debug log", err);
		});
		return this.flushing;
	}

	private async write(): Promise<void> {
		if (this.lines.length === 0) return;
		const chunk = this.lines.join("\n") + "\n";
		this.lines = [];
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(this.path)) await adapter.append(this.path, chunk);
		else await adapter.write(this.path, chunk);
	}
}
