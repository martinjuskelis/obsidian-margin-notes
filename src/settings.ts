import { App, PluginSettingTab, Setting } from "obsidian";
import type MarginNotesPlugin from "./main";
import type { AnchorFormat } from "./anchor";

export type ExportLayout = "side-by-side" | "tufte" | "inline" | "footnotes";
export type ExportTheme = "light" | "dark" | "sepia" | "academic";
export type ExportFont = "system" | "serif" | "sans";
export type ExportRatio = "3:2" | "1:1" | "2:1";

export interface MarginNotesSettings {
	anchorFormat: AnchorFormat;
	showSourceHighlight: boolean;
	autoRelinkOnEditMode: boolean;
	// Export
	exportLayout: ExportLayout;
	exportTheme: ExportTheme;
	exportFont: ExportFont;
	exportColumnRatio: ExportRatio;
	exportShowNumbers: boolean;
	exportShowTitle: boolean;
}

export const DEFAULT_SETTINGS: MarginNotesSettings = {
	anchorFormat: "block-id",
	showSourceHighlight: true,
	autoRelinkOnEditMode: true,
	exportLayout: "side-by-side",
	exportTheme: "light",
	exportFont: "system",
	exportColumnRatio: "3:2",
	exportShowNumbers: true,
	exportShowTitle: true,
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

		// ── General ────────────────────────────────────────────
		containerEl.createEl("h3", { text: "General" });

		new Setting(containerEl)
			.setName("Anchor format")
			.setDesc(
				"How new annotation anchors are written into source files. " +
				"Block ID (^mn-…) integrates with Obsidian links and backlinks. " +
				"HTML comment (<!-- ann:… -->) is invisible but opaque to Obsidian. " +
				"Both formats are always recognised regardless of this setting."
			)
			.addDropdown((d) =>
				d
					.addOption("block-id", "Block ID (^mn-…) — recommended")
					.addOption("html-comment", "HTML comment (<!-- ann:… -->)")
					.setValue(this.plugin.settings.anchorFormat)
					.onChange(async (v) => {
						this.plugin.settings.anchorFormat = v as AnchorFormat;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Highlight source lines")
			.setDesc(
				"Show a blue right-side border on source lines that have annotations."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showSourceHighlight)
					.onChange(async (v) => {
						this.plugin.settings.showSourceHighlight = v;
						await this.plugin.saveSettings();
						this.plugin.updateHighlightVisibility();
					})
			);

		new Setting(containerEl)
			.setName("Auto-relink on edit mode")
			.setDesc(
				"Re-enable scroll sync when switching from reading view back to editing view."
			)
			.addToggle((t) =>
				t
					.setValue(
						this.plugin.settings.autoRelinkOnEditMode
					)
					.onChange(async (v) => {
						this.plugin.settings.autoRelinkOnEditMode = v;
						await this.plugin.saveSettings();
					})
			);

		// ── Export ──────────────────────────────────────────────
		containerEl.createEl("h3", { text: "HTML Export" });

		new Setting(containerEl)
			.setName("Layout")
			.setDesc("How annotations are positioned relative to the source text.")
			.addDropdown((d) =>
				d
					.addOption("side-by-side", "Side by side (two columns)")
					.addOption("tufte", "Tufte sidenotes (margin notes)")
					.addOption("inline", "Inline (annotations below each paragraph)")
					.addOption("footnotes", "Footnotes (annotations at the end)")
					.setValue(this.plugin.settings.exportLayout)
					.onChange(async (v) => {
						this.plugin.settings.exportLayout = v as ExportLayout;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Theme")
			.setDesc("Color scheme for the exported page.")
			.addDropdown((d) =>
				d
					.addOption("light", "Light")
					.addOption("dark", "Dark")
					.addOption("sepia", "Sepia (warm)")
					.addOption("academic", "Academic (serif, paper-like)")
					.setValue(this.plugin.settings.exportTheme)
					.onChange(async (v) => {
						this.plugin.settings.exportTheme = v as ExportTheme;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Font")
			.setDesc("Font family for the exported page.")
			.addDropdown((d) =>
				d
					.addOption("system", "System default")
					.addOption("serif", "Serif (Georgia, Times)")
					.addOption("sans", "Sans-serif (Helvetica, Arial)")
					.setValue(this.plugin.settings.exportFont)
					.onChange(async (v) => {
						this.plugin.settings.exportFont = v as ExportFont;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Column ratio")
			.setDesc("Width ratio between source text and annotations (side-by-side only).")
			.addDropdown((d) =>
				d
					.addOption("3:2", "60 / 40")
					.addOption("1:1", "50 / 50")
					.addOption("2:1", "67 / 33")
					.setValue(this.plugin.settings.exportColumnRatio)
					.onChange(async (v) => {
						this.plugin.settings.exportColumnRatio = v as ExportRatio;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show annotation numbers")
			.setDesc("Display numbered badges on each annotation.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.exportShowNumbers)
					.onChange(async (v) => {
						this.plugin.settings.exportShowNumbers = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show document title")
			.setDesc("Display the file name as a heading at the top.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.exportShowTitle)
					.onChange(async (v) => {
						this.plugin.settings.exportShowTitle = v;
						await this.plugin.saveSettings();
					})
			);
	}
}
