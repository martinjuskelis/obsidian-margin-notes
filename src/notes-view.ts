/**
 * Custom notes view with positioned annotation slots.
 *
 * Each annotation is rendered as an editable textarea absolutely
 * positioned to align with its source anchor.  The user clicks on
 * empty space to create a new note, types directly in the slot, and
 * the content auto-saves on idle.
 *
 * This replaces the old approach of opening the sidecar file in a
 * regular MarkdownView — which could never align properly because
 * two independent editors have different line heights and word wrap.
 */

import {
	ItemView,
	WorkspaceLeaf,
	MarkdownView,
	MarkdownRenderer,
	Component,
	TFile,
} from "obsidian";
import type MarginNotesPlugin from "./main";
import {
	parseSidecar,
	serializeSidecar,
	getSidecarPath,
	isSidecarFile,
	sortAnnotationsBySource,
} from "./sidecar";
import type { SidecarData, Annotation } from "./sidecar";
import {
	computeSlotPositions,
	computeTotalHeight,
} from "./alignment";
import type { AnchorMeasurement } from "./alignment";
import { ANCHOR_RE } from "./anchor";
import { ScrollSync } from "./scroll-sync";

export const VIEW_TYPE_NOTES = "margin-notes-aligned-view";

export class MarginNotesView extends ItemView {
	plugin: MarginNotesPlugin;
	private sourcePath: string | null = null;
	private sidecar: SidecarData | null = null;
	private scrollEl: HTMLElement = null!;
	private slotsContainer: HTMLElement = null!;
	private heightSpacer: HTMLElement = null!;
	private slots: Map<string, HTMLElement> = new Map();
	private saveTimers: Map<string, number> = new Map();
	private scrollSync: ScrollSync;
	private suppressSave = false;
	private renderComponents: Map<string, Component> = new Map();
	/** Track which slot is being edited. */
	private activeSlotId: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MarginNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.scrollSync = new ScrollSync();
	}

	getViewType(): string {
		return VIEW_TYPE_NOTES;
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
		root.addClass("mn-notes-view");

		this.scrollEl = root.createDiv("mn-scroller");
		this.slotsContainer = this.scrollEl.createDiv("mn-slots");
		this.heightSpacer = this.scrollEl.createDiv("mn-height-spacer");

		// Click on empty space → create a new note at that Y
		this.scrollEl.addEventListener("click", (e) => {
			if (e.target === this.slotsContainer || e.target === this.scrollEl) {
				this.onEmptyClick(e);
			}
		});
	}

	async onClose(): Promise<void> {
		this.scrollSync.detach();
		this.flushAllSaves();
		for (const c of this.renderComponents.values()) c.unload();
		this.renderComponents.clear();
	}

	// ── Public API ─────────────────────────────────────────────

	getScrollContainer(): HTMLElement {
		return this.scrollEl;
	}

	getSourcePath(): string | null {
		return this.sourcePath;
	}

	/**
	 * Load annotations for a source file and render slots.
	 * Called when the split view opens or the source file changes.
	 */
	async loadForSource(
		sourcePath: string,
		sourceScrollEl: HTMLElement
	): Promise<void> {
		this.flushAllSaves();
		this.sourcePath = sourcePath;

		const sidecarPath = getSidecarPath(sourcePath);
		const file =
			this.app.vault.getAbstractFileByPath(sidecarPath);

		if (file instanceof TFile) {
			this.sidecar = parseSidecar(
				await this.app.vault.cachedRead(file)
			);
		} else {
			this.sidecar = { source: sourcePath, annotations: [] };
		}

		// Attach scroll sync
		this.scrollSync.attach(sourceScrollEl, this.scrollEl);

		// Initial render
		this.renderSlots();
	}

	/** Re-measure source positions and reposition all slots. */
	repositionSlots(): void {
		if (!this.sidecar) return;

		const anchors = this.measureSourceAnchors();
		const heights = this.measureSlotHeights();
		const layout = computeSlotPositions(anchors, heights);

		for (const sl of layout) {
			const el = this.slots.get(sl.anchorId);
			if (el) el.style.top = `${sl.top}px`;
		}

		// Match total scrollable height to source
		const sourceScroller = this.getSourceScrollEl();
		const sourceHeight = sourceScroller?.scrollHeight ?? 0;
		const total = computeTotalHeight(layout, heights, sourceHeight);
		this.heightSpacer.style.height = `${total}px`;
	}

	/** Called when the source file is modified. */
	async onSourceModified(): Promise<void> {
		if (!this.sourcePath) return;
		// Re-read sidecar (anchors may have been added via command)
		const sidecarPath = getSidecarPath(this.sourcePath);
		const file =
			this.app.vault.getAbstractFileByPath(sidecarPath);
		if (file instanceof TFile) {
			this.sidecar = parseSidecar(
				await this.app.vault.cachedRead(file)
			);
		}
		this.renderSlots();
	}

	// ── Rendering ──────────────────────────────────────────────

	private renderSlots(): void {
		// Clean up
		for (const c of this.renderComponents.values()) c.unload();
		this.renderComponents.clear();
		this.slotsContainer.empty();
		this.slots.clear();

		if (!this.sidecar) return;

		// Create a slot element for each annotation
		for (const ann of this.sidecar.annotations) {
			this.createSlotElement(ann);
		}

		// Position after DOM settles
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				this.repositionSlots();
			});
		});
	}

	private createSlotElement(ann: Annotation): void {
		const slot = this.slotsContainer.createDiv({
			cls: "mn-slot",
			attr: { "data-ann-id": ann.anchorId },
		});
		this.slots.set(ann.anchorId, slot);

		// Rendered content (visible when not editing)
		const display = slot.createDiv("mn-slot-display");
		if (ann.content.trim()) {
			const comp = new Component();
			comp.load();
			this.renderComponents.set(ann.anchorId, comp);
			MarkdownRenderer.render(
				this.app,
				ann.content,
				display,
				this.sourcePath || "",
				comp
			);
		} else {
			display.createDiv({
				cls: "mn-slot-placeholder",
				text: "Click to edit...",
			});
		}

		// Delete button
		const del = slot.createDiv({
			cls: "mn-slot-delete",
			attr: { "aria-label": "Delete note" },
		});
		del.textContent = "×";
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			this.deleteAnnotation(ann.anchorId);
		});

		// Click to edit
		display.addEventListener("click", (e) => {
			e.stopPropagation();
			this.startEditing(ann.anchorId);
		});

		// Hover highlighting on source
		slot.addEventListener("mouseenter", () =>
			this.plugin.highlightSource(ann.anchorId)
		);
		slot.addEventListener("mouseleave", () =>
			this.plugin.unhighlightSource(ann.anchorId)
		);
	}

	// ── Editing ────────────────────────────────────────────────

	private startEditing(anchorId: string): void {
		if (this.activeSlotId === anchorId) return;
		if (this.activeSlotId) this.stopEditing(this.activeSlotId);

		this.activeSlotId = anchorId;
		const slot = this.slots.get(anchorId);
		const ann = this.sidecar?.annotations.find(
			(a) => a.anchorId === anchorId
		);
		if (!slot || !ann) return;

		slot.addClass("mn-slot-editing");
		const display = slot.querySelector(
			".mn-slot-display"
		) as HTMLElement;
		if (display) display.style.display = "none";

		const textarea = slot.createEl("textarea", {
			cls: "mn-slot-editor",
		});
		textarea.value = ann.content;
		textarea.placeholder = "Type your note...";
		textarea.focus();

		// Auto-resize textarea to fit content
		const autoResize = () => {
			textarea.style.height = "auto";
			textarea.style.height = `${textarea.scrollHeight}px`;
			this.repositionSlots();
		};
		autoResize();

		textarea.addEventListener("input", () => {
			autoResize();
			this.scheduleSave(anchorId, textarea.value);
		});

		textarea.addEventListener("blur", () => {
			this.stopEditing(anchorId);
		});

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				textarea.blur();
			}
		});
	}

	private stopEditing(anchorId: string): void {
		const slot = this.slots.get(anchorId);
		if (!slot) return;

		// Save immediately
		const textarea = slot.querySelector(
			".mn-slot-editor"
		) as HTMLTextAreaElement | null;
		if (textarea) {
			const ann = this.sidecar?.annotations.find(
				(a) => a.anchorId === anchorId
			);
			if (ann) ann.content = textarea.value;
			textarea.remove();
		}

		slot.removeClass("mn-slot-editing");
		const display = slot.querySelector(
			".mn-slot-display"
		) as HTMLElement;
		if (display) display.style.display = "";

		if (this.activeSlotId === anchorId) {
			this.activeSlotId = null;
		}

		// Re-render the display content and save
		this.flushSave(anchorId);
		this.rerenderSlotDisplay(anchorId);
		this.repositionSlots();
	}

	private rerenderSlotDisplay(anchorId: string): void {
		const slot = this.slots.get(anchorId);
		const ann = this.sidecar?.annotations.find(
			(a) => a.anchorId === anchorId
		);
		if (!slot || !ann) return;

		const display = slot.querySelector(
			".mn-slot-display"
		) as HTMLElement;
		if (!display) return;

		// Clean up old render component
		const oldComp = this.renderComponents.get(anchorId);
		if (oldComp) {
			oldComp.unload();
			this.renderComponents.delete(anchorId);
		}

		display.empty();
		if (ann.content.trim()) {
			const comp = new Component();
			comp.load();
			this.renderComponents.set(anchorId, comp);
			MarkdownRenderer.render(
				this.app,
				ann.content,
				display,
				this.sourcePath || "",
				comp
			);
		} else {
			display.createDiv({
				cls: "mn-slot-placeholder",
				text: "Click to edit...",
			});
		}
	}

	// ── Save ───────────────────────────────────────────────────

	private scheduleSave(anchorId: string, content: string): void {
		const existing = this.saveTimers.get(anchorId);
		if (existing) window.clearTimeout(existing);

		this.saveTimers.set(
			anchorId,
			window.setTimeout(() => {
				this.saveTimers.delete(anchorId);
				const ann = this.sidecar?.annotations.find(
					(a) => a.anchorId === anchorId
				);
				if (ann) {
					ann.content = content;
					this.persistSidecar();
				}
			}, 800)
		);
	}

	private flushSave(anchorId: string): void {
		const timer = this.saveTimers.get(anchorId);
		if (timer) {
			window.clearTimeout(timer);
			this.saveTimers.delete(anchorId);
		}
		this.persistSidecar();
	}

	private flushAllSaves(): void {
		for (const [id, timer] of this.saveTimers) {
			window.clearTimeout(timer);
		}
		this.saveTimers.clear();
		if (this.sidecar) this.persistSidecar();
	}

	private async persistSidecar(): Promise<void> {
		if (!this.sidecar || !this.sourcePath) return;
		this.suppressSave = true;

		// Sort annotations by source order before saving
		const srcFile = this.app.vault.getAbstractFileByPath(
			this.sourcePath
		);
		if (srcFile instanceof TFile) {
			const srcText =
				await this.app.vault.cachedRead(srcFile);
			sortAnnotationsBySource(this.sidecar, srcText);
		}

		const path = getSidecarPath(this.sourcePath);
		const content = serializeSidecar(this.sidecar);
		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}

		setTimeout(() => {
			this.suppressSave = false;
		}, 300);
	}

	isSuppressingReload(): boolean {
		return this.suppressSave;
	}

	// ── Click to create ────────────────────────────────────────

	private onEmptyClick(e: MouseEvent): void {
		if (!this.sourcePath) return;

		// Map click Y to the nearest source line
		const clickY = e.offsetY + this.scrollEl.scrollTop;
		this.plugin.createAnnotationAtY(clickY);
	}

	// ── Deletion ───────────────────────────────────────────────

	private async deleteAnnotation(anchorId: string): Promise<void> {
		if (!this.sidecar || !this.sourcePath) return;

		this.sidecar.annotations = this.sidecar.annotations.filter(
			(a) => a.anchorId !== anchorId
		);
		await this.persistSidecar();

		// Remove anchor from source
		const { removeAnchor } = await import("./anchor");
		const srcFile = this.app.vault.getAbstractFileByPath(
			this.sourcePath
		);
		if (srcFile instanceof TFile) {
			const text = await this.app.vault.read(srcFile);
			const cleaned = removeAnchor(text, anchorId);
			if (cleaned !== text)
				await this.app.vault.modify(srcFile, cleaned);
		}

		this.renderSlots();
	}

	// ── Measurement ────────────────────────────────────────────

	private measureSourceAnchors(): AnchorMeasurement[] {
		const sourceScroller = this.getSourceScrollEl();
		if (!sourceScroller) return [];

		const anchors: AnchorMeasurement[] = [];
		const els =
			sourceScroller.querySelectorAll<HTMLElement>(
				"[data-ann-id]"
			);

		for (const el of els) {
			const id = el.dataset.annId;
			if (!id) continue;
			const elRect = el.getBoundingClientRect();
			const cRect = sourceScroller.getBoundingClientRect();
			anchors.push({
				anchorId: id,
				sourceY:
					elRect.top - cRect.top + sourceScroller.scrollTop,
			});
		}

		return anchors.sort((a, b) => a.sourceY - b.sourceY);
	}

	private measureSlotHeights(): Map<string, number> {
		const heights = new Map<string, number>();
		for (const [id, el] of this.slots) {
			heights.set(id, el.offsetHeight);
		}
		return heights;
	}

	private getSourceScrollEl(): HTMLElement | null {
		if (!this.plugin.splitSourceLeaf) return null;
		const view = this.plugin.splitSourceLeaf.view;
		if (!(view instanceof MarkdownView)) return null;
		const mode = view.getMode();
		if (mode === "preview")
			return view.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
		return view.containerEl.querySelector(
			".cm-scroller"
		) as HTMLElement | null;
	}

	/**
	 * Map a Y coordinate (in notes scroll space) to the nearest
	 * source line number that doesn't already have an annotation.
	 */
	findSourceLineAtY(y: number): number | null {
		const sourceScroller = this.getSourceScrollEl();
		if (!sourceScroller) return null;

		const view = this.plugin.splitSourceLeaf?.view;
		if (!(view instanceof MarkdownView)) return null;

		// Use CM6 to find the line at this Y
		// @ts-ignore — accessing internal CM6 editor
		const cmView = (view.editor as any).cm;
		if (!cmView) return null;

		const block = cmView.lineBlockAtHeight(y);
		const line = cmView.state.doc.lineAt(block.from);

		// Check this line doesn't already have an anchor
		if (ANCHOR_RE.test(line.text)) return null;

		return line.number;
	}

	/** Focus a specific annotation slot for editing. */
	focusSlot(anchorId: string): void {
		setTimeout(() => {
			this.repositionSlots();
			const slot = this.slots.get(anchorId);
			if (slot) {
				slot.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				this.startEditing(anchorId);
			}
		}, 200);
	}
}
