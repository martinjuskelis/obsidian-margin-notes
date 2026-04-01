/**
 * Custom notes view with positioned annotation slots.
 *
 * Two modes:
 *   Linked   — slots are absolutely positioned to align with source
 *              anchors, scroll sync is active, clicking empty space
 *              creates/edits the note for the corresponding source line
 *   Unlinked — slots are stacked in a simple list (no positioning),
 *              no scroll sync, just a compact list of notes
 */

import {
	ItemView,
	WorkspaceLeaf,
	MarkdownView,
	MarkdownRenderer,
	Component,
	TFile,
	setIcon,
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
	private activeSlotId: string | null = null;
	private linked = true;
	private linkBtn: HTMLElement | null = null;

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

		// ── Header ─────────────────────────────────────────────
		const header = root.createDiv("mn-header");

		const left = header.createDiv("mn-header-left");
		left.createSpan({
			text: "Margin Notes",
			cls: "mn-header-title",
		});

		const right = header.createDiv("mn-header-right");

		// Link toggle
		this.linkBtn = right.createEl("button", {
			cls: "mn-header-btn clickable-icon",
			attr: { "aria-label": "Scroll sync (linked)" },
		});
		setIcon(this.linkBtn, "link");
		this.linkBtn.addClass("is-linked");
		this.linkBtn.addEventListener("click", () =>
			this.toggleLinked()
		);

		// Add note button
		const addBtn = right.createEl("button", {
			cls: "mn-header-btn clickable-icon",
			attr: { "aria-label": "Add note at cursor" },
		});
		setIcon(addBtn, "plus");
		addBtn.addEventListener("click", () =>
			this.plugin.addAnnotationFromPane()
		);

		// ── Scroll container ───────────────────────────────────
		this.scrollEl = root.createDiv("mn-scroller");
		this.slotsContainer = this.scrollEl.createDiv("mn-slots");
		this.heightSpacer = this.scrollEl.createDiv(
			"mn-height-spacer"
		);

		// Click on empty space → create or edit at that Y
		this.scrollEl.addEventListener("click", (e) => {
			if (
				e.target === this.slotsContainer ||
				e.target === this.scrollEl ||
				e.target === this.heightSpacer
			) {
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

	isLinked(): boolean {
		return this.linked;
	}

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
			this.sidecar = {
				source: sourcePath,
				annotations: [],
			};
		}

		if (this.linked) {
			this.scrollSync.attach(sourceScrollEl, this.scrollEl);
		}
		this.renderSlots();
	}

	/** Called when the active source leaf changes. */
	updateLinkState(isCorrectSource: boolean): void {
		if (isCorrectSource && this.linked) {
			const srcEl = this.getSourceScrollEl();
			if (srcEl) {
				this.scrollSync.attach(srcEl, this.scrollEl);
			}
			this.repositionSlots();
		} else {
			this.scrollSync.detach();
		}
	}

	repositionSlots(): void {
		if (!this.sidecar || !this.linked) return;

		const anchors = this.measureSourceAnchors();
		const heights = this.measureSlotHeights();
		const layout = computeSlotPositions(anchors, heights);

		for (const sl of layout) {
			const el = this.slots.get(sl.anchorId);
			if (el) el.style.top = `${sl.top}px`;
		}

		const srcScroller = this.getSourceScrollEl();
		const srcHeight = srcScroller?.scrollHeight ?? 0;
		const total = computeTotalHeight(
			layout,
			heights,
			srcHeight
		);
		this.heightSpacer.style.height = `${total}px`;
	}

	async onSourceModified(): Promise<void> {
		if (!this.sourcePath) return;
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

	focusSlot(anchorId: string): void {
		setTimeout(() => {
			if (this.linked) this.repositionSlots();
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

	isSuppressingReload(): boolean {
		return this.suppressSave;
	}

	getAnnotations(): Annotation[] {
		return this.sidecar?.annotations ?? [];
	}

	// ── Link toggle ────────────────────────────────────────────

	private toggleLinked(): void {
		this.linked = !this.linked;

		if (this.linkBtn) {
			if (this.linked) {
				setIcon(this.linkBtn, "link");
				this.linkBtn.addClass("is-linked");
				this.linkBtn.removeClass("is-unlinked");
				this.linkBtn.setAttribute(
					"aria-label",
					"Scroll sync (linked)"
				);
			} else {
				setIcon(this.linkBtn, "unlink");
				this.linkBtn.removeClass("is-linked");
				this.linkBtn.addClass("is-unlinked");
				this.linkBtn.setAttribute(
					"aria-label",
					"Scroll sync (unlinked)"
				);
			}
		}

		if (this.linked) {
			const srcEl = this.getSourceScrollEl();
			if (srcEl) {
				this.scrollSync.attach(srcEl, this.scrollEl);
			}
		} else {
			this.scrollSync.detach();
		}

		this.renderSlots();
	}

	// ── Rendering ──────────────────────────────────────────────

	private renderSlots(): void {
		for (const c of this.renderComponents.values()) c.unload();
		this.renderComponents.clear();
		this.slotsContainer.empty();
		this.slots.clear();

		if (!this.sidecar) return;

		if (this.linked) {
			this.slotsContainer.addClass("mn-slots-linked");
			this.slotsContainer.removeClass("mn-slots-list");
			this.heightSpacer.style.display = "";
		} else {
			this.slotsContainer.removeClass("mn-slots-linked");
			this.slotsContainer.addClass("mn-slots-list");
			this.heightSpacer.style.display = "none";
		}

		if (this.sidecar.annotations.length === 0) {
			this.slotsContainer.createDiv({
				cls: "mn-empty",
				text: "No notes yet. Click + or right-click in the source to add one.",
			});
			return;
		}

		for (const ann of this.sidecar.annotations) {
			this.createSlotElement(ann);
		}

		if (this.linked) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this.repositionSlots();
				});
			});
		}
	}

	private createSlotElement(ann: Annotation): void {
		const slot = this.slotsContainer.createDiv({
			cls: "mn-slot",
			attr: { "data-ann-id": ann.anchorId },
		});
		this.slots.set(ann.anchorId, slot);

		// Delete button
		const del = slot.createDiv({
			cls: "mn-slot-delete",
			attr: { "aria-label": "Delete note" },
		});
		del.textContent = "\u00d7";
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			this.deleteAnnotation(ann.anchorId);
		});

		// Rendered content
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

		// Click to edit
		display.addEventListener("click", (e) => {
			e.stopPropagation();
			this.startEditing(ann.anchorId);
		});

		// Hover highlighting
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

		const autoResize = () => {
			textarea.style.height = "auto";
			textarea.style.height = `${textarea.scrollHeight}px`;
			if (this.linked) this.repositionSlots();
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
			if (e.key === "Escape") textarea.blur();
		});
	}

	private stopEditing(anchorId: string): void {
		const slot = this.slots.get(anchorId);
		if (!slot) return;

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

		if (this.activeSlotId === anchorId)
			this.activeSlotId = null;

		this.flushSave(anchorId);
		this.rerenderSlotDisplay(anchorId);
		if (this.linked) this.repositionSlots();
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

	private scheduleSave(
		anchorId: string,
		content: string
	): void {
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
		for (const [, timer] of this.saveTimers)
			window.clearTimeout(timer);
		this.saveTimers.clear();
		if (this.sidecar) this.persistSidecar();
	}

	private async persistSidecar(): Promise<void> {
		if (!this.sidecar || !this.sourcePath) return;
		this.suppressSave = true;

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
		const existing =
			this.app.vault.getAbstractFileByPath(path);

		if (existing instanceof TFile)
			await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);

		setTimeout(() => {
			this.suppressSave = false;
		}, 300);
	}

	// ── Click to create/edit ───────────────────────────────────

	private onEmptyClick(e: MouseEvent): void {
		if (!this.sourcePath || !this.linked) return;

		const clickY =
			e.clientY -
			this.scrollEl.getBoundingClientRect().top +
			this.scrollEl.scrollTop;

		// Check if click is near an existing slot — if so, edit it
		const nearest = this.findNearestSlotAtY(clickY);
		if (nearest) {
			this.startEditing(nearest);
			return;
		}

		// Otherwise create a new note at the corresponding source line
		this.plugin.createAnnotationAtY(clickY);
	}

	/**
	 * If an existing slot is within 30px of click Y, return its ID.
	 * This makes it easy to click near an existing note to edit it.
	 */
	private findNearestSlotAtY(
		y: number
	): string | null {
		for (const [id, el] of this.slots) {
			const top = parseFloat(el.style.top) || 0;
			const bottom = top + el.offsetHeight;
			if (y >= top - 30 && y <= bottom + 30) return id;
		}
		return null;
	}

	// ── Deletion ───────────────────────────────────────────────

	private async deleteAnnotation(
		anchorId: string
	): Promise<void> {
		if (!this.sidecar || !this.sourcePath) return;

		this.sidecar.annotations =
			this.sidecar.annotations.filter(
				(a) => a.anchorId !== anchorId
			);
		await this.persistSidecar();

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
		const srcScroller = this.getSourceScrollEl();
		if (!srcScroller) return [];

		const anchors: AnchorMeasurement[] = [];
		const els =
			srcScroller.querySelectorAll<HTMLElement>(
				"[data-ann-id]"
			);

		for (const el of els) {
			const id = el.dataset.annId;
			if (!id) continue;
			const elRect = el.getBoundingClientRect();
			const cRect = srcScroller.getBoundingClientRect();
			anchors.push({
				anchorId: id,
				sourceY:
					elRect.top -
					cRect.top +
					srcScroller.scrollTop,
			});
		}

		return anchors.sort((a, b) => a.sourceY - b.sourceY);
	}

	private measureSlotHeights(): Map<string, number> {
		const heights = new Map<string, number>();
		for (const [id, el] of this.slots)
			heights.set(id, el.offsetHeight);
		return heights;
	}

	private getSourceScrollEl(): HTMLElement | null {
		if (!this.plugin.splitSourceLeaf) return null;
		const view = this.plugin.splitSourceLeaf.view;
		if (!(view instanceof MarkdownView)) return null;
		if (view.getMode() === "preview")
			return view.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
		return view.containerEl.querySelector(
			".cm-scroller"
		) as HTMLElement | null;
	}

	findSourceLineAtY(y: number): number | null {
		const view = this.plugin.splitSourceLeaf?.view;
		if (!(view instanceof MarkdownView)) return null;

		// @ts-ignore — accessing internal CM6 editor
		const cmView = (view.editor as any).cm;
		if (!cmView) return null;

		const block = cmView.lineBlockAtHeight(y);
		const line = cmView.state.doc.lineAt(block.from);
		if (ANCHOR_RE.test(line.text)) return null;

		return line.number;
	}
}
