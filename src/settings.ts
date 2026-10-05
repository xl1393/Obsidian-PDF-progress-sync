import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PdfProgressSyncPlugin from "./main";

export interface PdfProgressSyncSettings {
	/** Jump to the last page read when a PDF is opened. */
	restoreOnOpen: boolean;
	/** Jump to newer progress from another device when returning to an open PDF. */
	followOtherDevices: boolean;
	/** Show a notice whenever the plugin moves to another page. */
	showNotices: boolean;
	/** Write a per-device debug log in the plugin folder. */
	debugLog: boolean;
}

export const DEFAULT_SETTINGS: PdfProgressSyncSettings = {
	restoreOnOpen: true,
	followOtherDevices: true,
	showNotices: true,
	debugLog: false,
};

export class PdfProgressSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PdfProgressSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("Resume when opening a PDF")
			.setDesc("Jump to the last page read on any device. PDFs opened through a page link keep the link's page.")
			.addToggle((toggle) =>
				toggle.setValue(settings.restoreOnOpen).onChange(async (value) => {
					settings.restoreOnOpen = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Follow other devices")
			.setDesc("When you come back to a PDF that is already open, jump to newer progress made on another device in the meantime.")
			.addToggle((toggle) =>
				toggle.setValue(settings.followOtherDevices).onChange(async (value) => {
					settings.followOtherDevices = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show notices")
			.setDesc("Show a short message when the plugin moves you to another page.")
			.addToggle((toggle) =>
				toggle.setValue(settings.showNotices).onChange(async (value) => {
					settings.showNotices = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("This device")
			.setDesc(`Progress from this device is saved as ${this.plugin.deviceId}.json in the plugin's progress folder.`)
			.addButton((button) =>
				button
					.setButtonText("Clear this device's records")
					.setWarning()
					.onClick(async () => {
						await this.plugin.clearOwnRecords();
						new Notice("PDF Progress Sync: this device's records were cleared");
					}),
			);

		new Setting(containerEl)
			.setName("Debug log")
			.setDesc("Write a log of viewer events and decisions to the plugin folder, one file per device. For troubleshooting only.")
			.addToggle((toggle) =>
				toggle.setValue(settings.debugLog).onChange(async (value) => {
					settings.debugLog = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
