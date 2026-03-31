/**
 * Annotation side pane.
 *
 * A custom ItemView that opens on the right side of the workspace, showing
 * annotation cards for the currently active source document.  Each card
 * renders its markdown content via MarkdownRenderer and can be clicked to
 * switch into edit mode (a textarea).
 */

import {
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Component,
	TFile,
	setIcon,
} from "obsidian";
import type MarginNotesPlugin from "./main";
import { parseSidecar, serializeSidecar, getSidecarPath, isSidecarFile, sortAnnotationsBySource } from "./sidecar";
import type { SidecarData, Annotation } from "./sidecar";

export const VIEW_TYPE_ANNOTATIONS = "margin-notes-view";

export class AnnotationPaneView extends ItemView {
	private plugin: MarginNotesPlugin;
	private sidecar: SidecarData | null = null;
	private currentSourcePath: string | null = null;
	private scrollEl: HTMLElement = null!;
	private cardsEl: HTMLElement = null!;
	private editingId: string | null = null;
	private renderComponents: Map<string, Component> = new Map();
	/** Suppress sidecar-modify reloads while we are saving ourselves. */
	private suppressReload = false;

	constructor(leaf: WorkspaceLeaf, plugin: MarginNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_ANNOTATIONS;
	}
	getDisplayText(): string {
		return "Margin Notes";
	}
	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("margin-notes-pane");

		// ── Header ─────────────────────────────────────────────
		const header = root.createDiv("margin-notes-header");
		header.createSpan({ text: "Margin Notes", cls: "margin-notes-title" });

		const buttons = header.createDiv("margin-notes-header-buttons");

		const splitBtn = buttons.createEl("button", {
			cls: "margin-notes-header-btn clickable-icon",
			attr: { "aria-label": "Open side-by-side view" },
		});
		setIcon(splitBtn, "columns-2");
		splitBtn.addEventListener("click", () =>
			this.plugin.openSplitView()
		);

		const addBtn = buttons.createEl("button", {
			cls: "margin-notes-header-btn clickable-icon",
			attr: { "aria-label": "Add margin note" },
		});
		setIcon(addBtn, "plus");
		addBtn.addEventListener("click", () =>
			this.plugin.addAnnotationAtCursor()
		);

		// ── Scrollable card container ──────────────────────────
		this.scrollEl = root.createDiv("margin-notes-content");
		this.cardsEl = this.scrollEl;

		// Load for whatever file is currently open
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile && !isSidecarFile(activeFile.path)) {
			await this.loadForFile(activeFile.path);
		}
	}

	async onClose(): Promise<void> {
		this.cleanupComponents();
	}

	// ── Public API ─────────────────────────────────────────────

	getCurrentSourcePath(): string | null {
		return this.currentSourcePath;
	}

	getScrollContainer(): HTMLElement {
		return this.scrollEl;
	}

	getCardElement(anchorId: string): HTMLElement | null {
		return this.cardsEl.querySelector(`[data-ann-id="${anchorId}"]`);
	}

	getSuppressReload(): boolean {
		return this.suppressReload;
	}

	/**
	 * Load (or reload) annotations for a given source file.
	 * Skips if already showing that file and we are mid-edit.
	 */
	async loadForFile(sourcePath: string): Promise<void> {
		if (
			this.currentSourcePath === sourcePath &&
			this.editingId &&
			!this.suppressReload
		) {
			return; // don't clobber an in-progress edit
		}

		this.currentSourcePath = sourcePath;

		const sidecarPath = getSidecarPath(sourcePath);
		const file = this.app.vault.getAbstractFileByPath(sidecarPath);

		if (file instanceof TFile) {
			const raw = await this.app.vault.cachedRead(file);
			this.sidecar = parseSidecar(raw);
		} else {
			this.sidecar = { source: sourcePath, annotations: [] };
		}

		this.editingId = null;
		this.render();
	}

	/** Scroll to and open the editor for a specific annotation. */
	focusAnnotation(anchorId: string): void {
		// Small delay lets the DOM settle after render()
		setTimeout(() => {
			const card = this.getCardElement(anchorId);
			if (!card) return;
			card.scrollIntoView({ behavior: "smooth", block: "center" });
			this.startEditing(anchorId, card);
		}, 80);
	}

	// ── Rendering ──────────────────────────────────────────────

	private render(): void {
		this.cleanupComponents();
		this.cardsEl.empty();

		if (!this.sidecar || this.sidecar.annotations.length === 0) {
			this.cardsEl.createDiv({
				cls: "margin-notes-empty",
				text: "No annotations yet. Click + or use the command palette to add one.",
			});
			return;
		}

		for (const ann of this.sidecar.annotations) {
			this.renderCard(ann);
		}
	}

	private renderCard(ann: Annotation): void {
		const card = this.cardsEl.createDiv({
			cls: "margin-notes-card",
			attr: { "data-ann-id": ann.anchorId },
		});

		// ── Card toolbar (visible on hover) ────────────────────
		const toolbar = card.createDiv("margin-notes-card-toolbar");

		const editBtn = toolbar.createEl("button", {
			cls: "margin-notes-card-btn clickable-icon",
			attr: { "aria-label": "Edit" },
		});
		setIcon(editBtn, "pencil");
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.startEditing(ann.anchorId, card);
		});

		const deleteBtn = toolbar.createEl("button", {
			cls: "margin-notes-card-btn margin-notes-delete-btn clickable-icon",
			attr: { "aria-label": "Delete annotation" },
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.deleteAnnotation(ann.anchorId);
		});

		// ── Card content ───────────────────────────────────────
		const contentDiv = card.createDiv("margin-notes-card-content");

		if (ann.content.trim()) {
			const comp = new Component();
			comp.load();
			this.renderComponents.set(ann.anchorId, comp);
			MarkdownRenderer.render(
				this.app,
				ann.content,
				contentDiv,
				this.currentSourcePath || "",
				comp
			);
		} else {
			contentDiv.createDiv({
				cls: "margin-notes-placeholder",
				text: "Click the pencil to add content.",
			});
		}

		// ── Hover / click highlighting ─────────────────────────
		card.addEventListener("mouseenter", () =>
			this.plugin.highlightSource(ann.anchorId)
		);
		card.addEventListener("mouseleave", () =>
			this.plugin.unhighlightSource(ann.anchorId)
		);
		card.addEventListener("click", () =>
			this.plugin.scrollSourceToAnchor(ann.anchorId)
		);
	}

	// ── Editing ────────────────────────────────────────────────

	private startEditing(anchorId: string, card: HTMLElement): void {
		if (this.editingId === anchorId) return;
		// If editing something else, save it first
		if (this.editingId) {
			this.commitEditing();
		}
		this.editingId = anchorId;

		const ann = this.sidecar?.annotations.find(
			(a) => a.anchorId === anchorId
		);
		if (!ann) return;

		const contentDiv = card.querySelector(
			".margin-notes-card-content"
		) as HTMLElement;
		if (!contentDiv) return;
		contentDiv.empty();
		contentDiv.addClass("margin-notes-editing");

		const textarea = contentDiv.createEl("textarea", {
			cls: "margin-notes-editor",
		});
		textarea.value = ann.content;
		textarea.rows = Math.max(4, ann.content.split("\n").length + 1);
		textarea.focus();

		const buttons = contentDiv.createDiv("margin-notes-editor-buttons");

		const saveBtn = buttons.createEl("button", {
			text: "Save",
			cls: "margin-notes-save-btn",
		});
		const cancelBtn = buttons.createEl("button", {
			text: "Cancel",
			cls: "margin-notes-cancel-btn",
		});

		const save = async () => {
			ann.content = textarea.value;
			await this.saveSidecar();
			this.editingId = null;
			this.render();
		};

		const cancel = () => {
			this.editingId = null;
			this.render();
		};

		saveBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			save();
		});
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			cancel();
		});

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Escape") cancel();
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
		});
	}

	/** If a textarea is currently open, save its contents. */
	private commitEditing(): void {
		if (!this.editingId || !this.sidecar) return;
		const textarea = this.cardsEl.querySelector(
			".margin-notes-editor"
		) as HTMLTextAreaElement | null;
		const ann = this.sidecar.annotations.find(
			(a) => a.anchorId === this.editingId
		);
		if (textarea && ann) {
			ann.content = textarea.value;
			this.saveSidecar();
		}
		this.editingId = null;
	}

	// ── Deletion ───────────────────────────────────────────────

	private async deleteAnnotation(anchorId: string): Promise<void> {
		if (!this.sidecar || !this.currentSourcePath) return;

		// Remove from sidecar data
		this.sidecar.annotations = this.sidecar.annotations.filter(
			(a) => a.anchorId !== anchorId
		);
		await this.saveSidecar();

		// Remove anchor from source file
		const src = this.app.vault.getAbstractFileByPath(
			this.currentSourcePath
		);
		if (src instanceof TFile) {
			const { removeAnchor } = await import("./anchor");
			const text = await this.app.vault.read(src);
			const cleaned = removeAnchor(text, anchorId);
			if (cleaned !== text) {
				await this.app.vault.modify(src, cleaned);
			}
		}

		this.render();
	}

	// ── Persistence ────────────────────────────────────────────

	private async saveSidecar(): Promise<void> {
		if (!this.sidecar || !this.currentSourcePath) return;

		// Sort annotations to match source document order
		const sourceFile = this.app.vault.getAbstractFileByPath(
			this.currentSourcePath
		);
		if (sourceFile instanceof TFile) {
			const sourceText = await this.app.vault.cachedRead(sourceFile);
			sortAnnotationsBySource(this.sidecar, sourceText);
		}

		this.suppressReload = true;
		const path = getSidecarPath(this.currentSourcePath);
		const content = serializeSidecar(this.sidecar);

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}

		// Allow reloads again after a short window for the modify event to fire
		setTimeout(() => {
			this.suppressReload = false;
		}, 300);
	}

	// ── Cleanup ────────────────────────────────────────────────

	private cleanupComponents(): void {
		for (const comp of this.renderComponents.values()) {
			comp.unload();
		}
		this.renderComponents.clear();
	}
}
