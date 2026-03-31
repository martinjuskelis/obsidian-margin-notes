import {
	Plugin,
	MarkdownView,
	TFile,
	TAbstractFile,
	WorkspaceLeaf,
	Notice,
	setIcon,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { AnnotationPaneView, VIEW_TYPE_ANNOTATIONS } from "./pane";
import { annotationLinePlugin } from "./cm-extension";
import { spacerField, updateSpacers } from "./spacer";
import { generateId, ANCHOR_RE } from "./anchor";
import {
	getSidecarPath,
	isSidecarFile,
	parseSidecar,
	serializeSidecar,
	sortAnnotationsBySource,
} from "./sidecar";
import type { SidecarData } from "./sidecar";
import { ScrollSync } from "./sync";
import { exportToHtml } from "./exporter";

export default class MarginNotesPlugin extends Plugin {
	scrollSync: ScrollSync = null!;
	/** The leaf holding the sidecar file in split view mode. */
	private splitLeaf: WorkspaceLeaf | null = null;
	/** The source leaf that the split view was opened from. */
	private splitSourceLeaf: WorkspaceLeaf | null = null;
	/** Whether scroll sync is active in split mode. */
	private splitSyncEnabled = true;
	/** Link toggle button element (cleaned up on close). */
	private splitLinkBtn: HTMLElement | null = null;
	/** Debounce timer for spacer recalculation. */
	private spacerTimer: number | null = null;

	async onload(): Promise<void> {
		this.scrollSync = new ScrollSync(this);

		// ── View ───────────────────────────────────────────────
		this.registerView(
			VIEW_TYPE_ANNOTATIONS,
			(leaf) => new AnnotationPaneView(leaf, this)
		);

		// ── CM6 extensions ─────────────────────────────────────
		this.registerEditorExtension(annotationLinePlugin);
		this.registerEditorExtension(spacerField);

		// ── Reading View post-processor ────────────────────────
		this.registerMarkdownPostProcessor((el, ctx) => {
			const info = ctx.getSectionInfo(el);
			if (!info) return;

			const sectionLines = info.text
				.split("\n")
				.slice(info.lineStart, info.lineEnd + 1);

			for (const line of sectionLines) {
				const m = ANCHOR_RE.exec(line);
				if (m) {
					const target =
						el.querySelector(
							"p, h1, h2, h3, h4, h5, h6, li, blockquote"
						) || el;
					target.setAttribute("data-ann-id", m[1]);
					target.classList.add("margin-notes-anchored");
					break;
				}
			}
		});

		// ── Commands ───────────────────────────────────────────
		this.addCommand({
			id: "add-margin-note",
			name: "Add margin note",
			editorCallback: (editor, ctx) => {
				if (ctx instanceof MarkdownView) {
					this.addAnnotationFromEditor(ctx);
				}
			},
		});

		this.addCommand({
			id: "toggle-pane",
			name: "Toggle margin notes pane",
			callback: () => this.togglePane(),
		});

		this.addCommand({
			id: "open-split-view",
			name: "Open side-by-side view",
			callback: () => this.openSplitView(),
		});

		this.addCommand({
			id: "export-html",
			name: "Export as HTML with margin notes",
			callback: () => this.exportCurrentFile(),
		});

		// ── Ribbon icon ────────────────────────────────────────
		this.addRibbonIcon("message-square", "Toggle margin notes", () =>
			this.togglePane()
		);

		// ── Events ─────────────────────────────────────────────
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.onActiveLeafChange()
			)
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.onFileRenamed(file, oldPath)
			)
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => this.onFileModified(file))
		);

		// Re-attach scroll sync whenever the editor mode changes
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (this.getAnnotationPane()) {
					this.scrollSync.attach();
				}
				if (this.splitLeaf && this.splitSyncEnabled) {
					// Scroll containers change on mode switch — reattach
					this.scheduleSpacerRecalc();
					setTimeout(() => this.attachSplitSync(), 350);
				}
			})
		);

		// Also recalculate spacers when the window resizes
		this.registerEvent(
			this.app.workspace.on("resize", () => {
				if (this.splitLeaf && this.splitSyncEnabled) {
					this.scheduleSpacerRecalc();
				}
			})
		);
	}

	onunload(): void {
		this.scrollSync.detach();
	}

	// ── Annotation creation ────────────────────────────────────

	/**
	 * Called from the editor command callback.
	 */
	private async addAnnotationFromEditor(view: MarkdownView): Promise<void> {
		const file = view.file;
		if (!file || isSidecarFile(file.path)) {
			new Notice("Cannot add annotations to a sidecar file");
			return;
		}

		const editor = view.editor;
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);

		if (ANCHOR_RE.test(line)) {
			new Notice("This line already has an annotation");
			return;
		}

		const id = generateId();
		editor.replaceRange(` <!-- ann:${id} -->`, {
			line: cursor.line,
			ch: line.length,
		});

		await this.ensureAnnotationInSidecar(file.path, id);
		await this.ensurePaneOpen();

		const pane = this.getAnnotationPane();
		if (pane) {
			await pane.loadForFile(file.path);
			pane.focusAnnotation(id);
		}
	}

	/**
	 * Called from the pane's "+" button. Finds the most recently active
	 * markdown editor (the cursor position survives focus loss in CM6).
	 */
	async addAnnotationAtCursor(): Promise<void> {
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);

		// If the active view isn't a markdown editor (e.g. the pane button
		// was clicked), find the leaf for the file the pane is tracking.
		if (!view || !view.file || isSidecarFile(view.file.path)) {
			const pane = this.getAnnotationPane();
			const targetPath = pane?.getCurrentSourcePath();

			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const v = leaf.view as MarkdownView;
				if (!v.file || isSidecarFile(v.file.path)) continue;
				// Prefer the pane's tracked file
				if (targetPath && v.file.path === targetPath) {
					view = v;
					break;
				}
				// Fall back to any non-sidecar file
				if (!view) view = v;
			}
		}

		if (!view || !view.file) {
			new Notice("Open a document to add annotations");
			return;
		}

		const editor = view.editor;
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);

		if (ANCHOR_RE.test(line)) {
			new Notice("This line already has an annotation");
			return;
		}

		const id = generateId();
		editor.replaceRange(` <!-- ann:${id} -->`, {
			line: cursor.line,
			ch: line.length,
		});

		await this.ensureAnnotationInSidecar(view.file.path, id);

		const pane = this.getAnnotationPane();
		if (pane) {
			await pane.loadForFile(view.file.path);
			pane.focusAnnotation(id);
		}
	}

	private async ensureAnnotationInSidecar(
		sourcePath: string,
		anchorId: string
	): Promise<void> {
		const sidecarPath = getSidecarPath(sourcePath);
		const sidecar = await this.loadSidecar(sidecarPath, sourcePath);
		sidecar.annotations.push({ anchorId, content: "" });

		// Sort annotations to match their order in the source document
		const sourceFile =
			this.app.vault.getAbstractFileByPath(sourcePath);
		if (sourceFile instanceof TFile) {
			const sourceText = await this.app.vault.cachedRead(sourceFile);
			sortAnnotationsBySource(sidecar, sourceText);
		}

		await this.saveSidecar(sidecarPath, sidecar);
	}

	// ── Sidecar I/O ────────────────────────────────────────────

	private async loadSidecar(
		sidecarPath: string,
		sourcePath: string
	): Promise<SidecarData> {
		const file = this.app.vault.getAbstractFileByPath(sidecarPath);
		if (file instanceof TFile) {
			return parseSidecar(await this.app.vault.cachedRead(file));
		}
		return { source: sourcePath, annotations: [] };
	}

	private async saveSidecar(
		sidecarPath: string,
		data: SidecarData
	): Promise<void> {
		const content = serializeSidecar(data);
		const existing = this.app.vault.getAbstractFileByPath(sidecarPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(sidecarPath, content);
		}
	}

	// ── Pane management ────────────────────────────────────────

	async togglePane(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		if (existing.length) {
			existing[0].detach();
			this.scrollSync.detach();
		} else {
			await this.ensurePaneOpen();
		}
	}

	async ensurePaneOpen(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		// Try the right sidebar first; fall back to a new tab
		let leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("split");
		}
		await leaf.setViewState({
			type: VIEW_TYPE_ANNOTATIONS,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);
	}

	getAnnotationPane(): AnnotationPaneView | null {
		const leaves =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		return leaves.length
			? (leaves[0].view as AnnotationPaneView)
			: null;
	}

	// ── Split view ─────────────────────────────────────────────

	async openSplitView(): Promise<void> {
		// Determine which source file to use:
		// 1. The file the annotation pane is currently tracking
		// 2. The active markdown view
		// 3. Any open non-sidecar markdown view
		let sourceLeaf: WorkspaceLeaf | null = null;
		let sourceFile: TFile | null = null;

		const pane = this.getAnnotationPane();
		const targetPath = pane?.getCurrentSourcePath();

		// If the pane is tracking a file, find its leaf
		if (targetPath) {
			for (const leaf of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = leaf.view as MarkdownView;
				if (v.file?.path === targetPath) {
					sourceLeaf = leaf;
					sourceFile = v.file;
					break;
				}
			}
		}

		// Fall back to the active markdown view
		if (!sourceLeaf) {
			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (
				activeView?.file &&
				!isSidecarFile(activeView.file.path)
			) {
				sourceLeaf = activeView.leaf;
				sourceFile = activeView.file;
			}
		}

		// Fall back to any non-sidecar markdown leaf
		if (!sourceLeaf) {
			for (const leaf of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = leaf.view as MarkdownView;
				if (v.file && !isSidecarFile(v.file.path)) {
					sourceLeaf = leaf;
					sourceFile = v.file;
					break;
				}
			}
		}

		if (!sourceLeaf || !sourceFile) {
			new Notice("Open a document first");
			return;
		}

		// Close comments pane if open
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_ANNOTATIONS
		)) {
			leaf.detach();
		}

		// Collapse right sidebar so it doesn't compete with the split
		// @ts-ignore — rightSplit is not in public typings but is stable
		const rightSplit = this.app.workspace.rightSplit;
		if (rightSplit && !rightSplit.collapsed) {
			rightSplit.collapse();
		}

		// Close existing split if any
		this.closeSplitView();

		// Get or create the sidecar file
		const sidecarPath = getSidecarPath(sourceFile.path);
		let sidecarFile =
			this.app.vault.getAbstractFileByPath(sidecarPath);
		if (!(sidecarFile instanceof TFile)) {
			await this.saveSidecar(sidecarPath, {
				source: sourceFile.path,
				annotations: [],
			});
			sidecarFile =
				this.app.vault.getAbstractFileByPath(sidecarPath);
		}
		if (!(sidecarFile instanceof TFile)) return;

		// Focus the source leaf first so the split appears beside it
		this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });

		// Open sidecar in a vertical split to the right
		this.splitLeaf = this.app.workspace.createLeafBySplit(
			sourceLeaf,
			"vertical"
		);
		this.splitSourceLeaf = sourceLeaf;
		await this.splitLeaf.openFile(sidecarFile);

		// Add link toggle button to the sidecar view header
		this.addLinkToggle();

		// After DOM settles: calculate spacers, then attach scroll sync
		this.splitSyncEnabled = true;
		setTimeout(() => {
			this.recalculateSpacers();
			setTimeout(() => this.attachSplitSync(), 100);
		}, 300);
	}

	closeSplitView(): void {
		if (this.splitLinkBtn) {
			this.splitLinkBtn.remove();
			this.splitLinkBtn = null;
		}
		// Clear spacers before closing
		if (this.splitLeaf) {
			const cv = this.getCmView(this.splitLeaf);
			if (cv) {
				cv.dispatch({
					effects: updateSpacers.of(new Map()),
				});
			}
			this.splitLeaf.detach();
			this.splitLeaf = null;
		}
		this.splitSourceLeaf = null;
		this.scrollSync.detach();
	}

	private attachSplitSync(): void {
		if (
			!this.splitLeaf ||
			!this.splitSourceLeaf ||
			!this.splitSyncEnabled
		)
			return;
		const srcEl = this.getLeafScrollContainer(this.splitSourceLeaf);
		const scEl = this.getLeafScrollContainer(this.splitLeaf);
		if (srcEl && scEl) {
			this.scrollSync.attachToElements(srcEl, scEl);
		}
	}

	// ── Link toggle button ─────────────────────────────────────

	private addLinkToggle(): void {
		if (!this.splitLeaf) return;
		const actions =
			this.splitLeaf.view.containerEl.querySelector(".view-actions");
		if (!actions) return;

		const btn = document.createElement("a");
		btn.className = "view-action margin-notes-link-toggle is-linked";
		btn.setAttribute("aria-label", "Scroll sync (linked)");
		setIcon(btn, "link");
		actions.prepend(btn);
		this.splitLinkBtn = btn;

		btn.addEventListener("click", () => {
			this.splitSyncEnabled = !this.splitSyncEnabled;
			if (this.splitSyncEnabled) {
				setIcon(btn, "link");
				btn.classList.add("is-linked");
				btn.classList.remove("is-unlinked");
				btn.setAttribute("aria-label", "Scroll sync (linked)");
				this.recalculateSpacers();
				setTimeout(() => this.attachSplitSync(), 100);
			} else {
				setIcon(btn, "unlink");
				btn.classList.remove("is-linked");
				btn.classList.add("is-unlinked");
				btn.setAttribute("aria-label", "Scroll sync (unlinked)");
				this.scrollSync.detach();
				// Remove spacers
				const cv = this.splitLeaf
					? this.getCmView(this.splitLeaf)
					: null;
				if (cv) {
					cv.dispatch({
						effects: updateSpacers.of(new Map()),
					});
				}
			}
		});
	}

	// ── Spacer calculation ─────────────────────────────────────

	private scheduleSpacerRecalc(): void {
		if (this.spacerTimer) window.clearTimeout(this.spacerTimer);
		this.spacerTimer = window.setTimeout(() => {
			this.spacerTimer = null;
			this.recalculateSpacers();
		}, 250);
	}

	/**
	 * Measure both editors and insert spacer widgets in the sidecar
	 * so that each annotation aligns vertically with its source paragraph.
	 */
	private recalculateSpacers(): void {
		if (!this.splitLeaf || !this.splitSourceLeaf) return;
		if (!this.splitSyncEnabled) return;

		const sourceCV = this.getCmView(this.splitSourceLeaf);
		const sidecarCV = this.getCmView(this.splitLeaf);
		if (!sourceCV || !sidecarCV) return;

		// 1. Clear existing spacers so measurements are "natural"
		sidecarCV.dispatch({
			effects: updateSpacers.of(new Map()),
		});
		// Force synchronous layout reflow
		sidecarCV.dom.getBoundingClientRect();

		// 2. Measure anchor positions in both editors
		const sourceAnchors = this.measureAnchors(sourceCV);
		const sidecarAnchors = this.measureAnchors(sidecarCV);

		// 3. Calculate spacer heights (top-down, accumulating)
		const spacers = new Map<string, number>();
		let accumulated = 0;

		for (const sc of sidecarAnchors) {
			const src = sourceAnchors.find((a) => a.id === sc.id);
			if (!src) continue;

			const targetY = src.top;
			const currentY = sc.top + accumulated;
			const spacer = Math.max(0, targetY - currentY);

			if (spacer > 0) {
				spacers.set(sc.id, spacer);
				accumulated += spacer;
			}
		}

		// 4. Apply spacers
		sidecarCV.dispatch({
			effects: updateSpacers.of(spacers),
		});
	}

	private measureAnchors(
		view: EditorView
	): { id: string; top: number }[] {
		const RE = /<!-- ann:(\w+) -->/;
		const result: { id: string; top: number }[] = [];
		const doc = view.state.doc;

		for (let i = 1; i <= doc.lines; i++) {
			const line = doc.line(i);
			const m = RE.exec(line.text);
			if (m) {
				const block = view.lineBlockAt(line.from);
				result.push({ id: m[1], top: block.top });
			}
		}
		return result;
	}

	// ── Helpers ────────────────────────────────────────────────

	/** Get the CM6 EditorView for a MarkdownView leaf. */
	private getCmView(leaf: WorkspaceLeaf): EditorView | null {
		if (!(leaf.view instanceof MarkdownView)) return null;
		// @ts-ignore — accessing internal CM6 editor view
		return (leaf.view.editor as any).cm ?? null;
	}

	private getLeafScrollContainer(
		leaf: WorkspaceLeaf
	): HTMLElement | null {
		if (!(leaf.view instanceof MarkdownView)) return null;
		const mode = (leaf.view as MarkdownView).getMode();
		if (mode === "preview") {
			return leaf.view.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
		}
		return leaf.view.containerEl.querySelector(
			".cm-scroller"
		) as HTMLElement | null;
	}

	// ── Source highlighting ────────────────────────────────────

	highlightSource(anchorId: string): void {
		const el = this.findSourceElement(anchorId);
		if (el) el.classList.add("margin-notes-highlight");
	}

	unhighlightSource(anchorId: string): void {
		const el = this.findSourceElement(anchorId);
		if (el) el.classList.remove("margin-notes-highlight");
	}

	scrollSourceToAnchor(anchorId: string): void {
		// 1. If the element is already rendered in the DOM, scroll directly
		const el = this.findSourceElement(anchorId);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			this.flashElement(el);
			return;
		}

		// 2. Element is off-screen — find the source view and scroll via editor API
		const mdView = this.getSourceMarkdownView();
		if (!mdView) return;

		const text = mdView.editor.getValue();
		const lines = text.split("\n");
		let anchorLine = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(`<!-- ann:${anchorId} -->`)) {
				anchorLine = i;
				break;
			}
		}
		if (anchorLine < 0) return;

		const mode = mdView.getMode();
		if (mode === "source") {
			// Live Preview / Source mode: use CM6 scrollIntoView
			const cmView = this.getCmView(mdView.leaf);
			if (cmView) {
				const pos = cmView.state.doc.line(anchorLine + 1).from;
				cmView.dispatch({
					effects: EditorView.scrollIntoView(pos, {
						y: "center",
					}),
				});
			}
		} else {
			// Reading View: approximate scroll by line fraction
			const scrollEl = mdView.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
			if (scrollEl) {
				const frac = anchorLine / Math.max(lines.length, 1);
				scrollEl.scrollTop =
					frac * (scrollEl.scrollHeight - scrollEl.clientHeight);
			}
		}

		// 3. After the viewport renders the target, highlight it.
		//    Use "nearest" so we don't fight the initial scroll for
		//    elements near the bottom that can't be centered.
		setTimeout(() => {
			const el2 = this.findSourceElement(anchorId);
			if (el2) {
				el2.scrollIntoView({ behavior: "smooth", block: "nearest" });
				this.flashElement(el2);
			}
		}, 250);
	}

	scrollPaneToAnchor(anchorId: string): void {
		const pane = this.getAnnotationPane();
		if (!pane) return;
		const card = pane.getCardElement(anchorId);
		if (!card) return;
		card.scrollIntoView({ behavior: "smooth", block: "center" });
		card.classList.add("margin-notes-flash");
		setTimeout(() => card.classList.remove("margin-notes-flash"), 1500);
	}

	private findSourceElement(anchorId: string): HTMLElement | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const el = leaf.view.containerEl.querySelector(
				`[data-ann-id="${anchorId}"]`
			) as HTMLElement | null;
			if (el) return el;
		}
		return null;
	}

	private flashElement(el: HTMLElement): void {
		el.classList.add("margin-notes-flash");
		setTimeout(() => el.classList.remove("margin-notes-flash"), 1500);
	}

	/** Find the MarkdownView for the source file (not a sidecar). */
	private getSourceMarkdownView(): MarkdownView | null {
		const pane = this.getAnnotationPane();
		const targetPath = pane?.getCurrentSourcePath();

		// Try to find the specific source file first
		if (targetPath) {
			for (const leaf of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = leaf.view as MarkdownView;
				if (v.file?.path === targetPath) return v;
			}
		}

		// Fall back to any non-sidecar markdown view
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view as MarkdownView;
			if (v.file && !isSidecarFile(v.file.path)) return v;
		}
		return null;
	}

	// ── Event handlers ─────────────────────────────────────────

	private onActiveLeafChange(): void {
		const pane = this.getAnnotationPane();
		if (!pane) return;

		const file = this.app.workspace.getActiveFile();
		if (file && !isSidecarFile(file.path) && file.path.endsWith(".md")) {
			pane.loadForFile(file.path);
			// Small delay so the new view's DOM settles before we attach
			setTimeout(() => this.scrollSync.attach(), 150);
		}
	}

	private async onFileRenamed(
		file: TAbstractFile,
		oldPath: string
	): Promise<void> {
		if (!(file instanceof TFile)) return;
		if (isSidecarFile(file.path) || isSidecarFile(oldPath)) return;

		const oldSidecarPath = getSidecarPath(oldPath);
		const sidecar =
			this.app.vault.getAbstractFileByPath(oldSidecarPath);
		if (!(sidecar instanceof TFile)) return;

		const newSidecarPath = getSidecarPath(file.path);
		await this.app.vault.rename(sidecar, newSidecarPath);

		// Update the source reference inside the renamed sidecar
		const renamedFile =
			this.app.vault.getAbstractFileByPath(newSidecarPath);
		if (renamedFile instanceof TFile) {
			const raw = await this.app.vault.read(renamedFile);
			const data = parseSidecar(raw);
			data.source = file.path;
			await this.app.vault.modify(
				renamedFile,
				serializeSidecar(data)
			);
		}
	}

	private onFileModified(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;

		// Comments pane: reload if sidecar changed externally
		const pane = this.getAnnotationPane();
		if (pane && isSidecarFile(file.path) && !pane.getSuppressReload()) {
			const sourcePath = file.path.replace(/\.ann\.md$/, ".md");
			if (pane.getCurrentSourcePath() === sourcePath) {
				pane.loadForFile(sourcePath);
			}
		}

		// Split view: recalculate spacers when either file changes
		if (this.splitLeaf && this.splitSyncEnabled) {
			this.scheduleSpacerRecalc();
		}
	}

	// ── Export ──────────────────────────────────────────────────

	private async exportCurrentFile(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		if (!active) {
			new Notice("No active file");
			return;
		}

		const sourcePath = isSidecarFile(active.path)
			? active.path.replace(/\.ann\.md$/, ".md")
			: active.path;

		try {
			const html = await exportToHtml(this.app, sourcePath);
			const exportPath = sourcePath.replace(/\.md$/, ".html");

			const existing =
				this.app.vault.getAbstractFileByPath(exportPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, html);
			} else {
				await this.app.vault.create(exportPath, html);
			}

			new Notice(`Exported to ${exportPath}`);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Export failed: ${msg}`);
		}
	}
}
