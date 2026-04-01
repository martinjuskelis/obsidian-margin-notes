import { App, PluginSettingTab, Setting } from "obsidian";
import type MarginNotesPlugin from "./main";

export interface MarginNotesSettings {
	showSourceHighlight: boolean;
}

export const DEFAULT_SETTINGS: MarginNotesSettings = {
	showSourceHighlight: true,
};

export class MarginNotesSettingTab extends PluginSettingTab {
	plugin: MarginNotesPlugin;

	constructor(app: App, plugin: MarginNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Highlight source lines")
			.setDesc(
				"Show a blue right-side border on source lines that have annotations."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSourceHighlight)
					.onChange(async (value) => {
						this.plugin.settings.showSourceHighlight = value;
						await this.plugin.saveSettings();
						this.plugin.updateHighlightVisibility();
					})
			);
	}
}
