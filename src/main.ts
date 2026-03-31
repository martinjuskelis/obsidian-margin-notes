import {
	Plugin,
	MarkdownView,
	TFile,
	TAbstractFile,
	WorkspaceLeaf,
	Notice,
} from "obsidian";
import { AnnotationPaneView, VIEW_TYPE_ANNOTATIONS } from "./pane";
import { annotationLinePlugin } from "./cm-extension";
import { generateId, ANCHOR_RE } from "./anchor";
import {
	getSidecarPath,
	isSidecarFile,
	parseSidecar,
	serializeSidecar,
} from "./sidecar";
import type { SidecarData } from "./sidecar";
import { ScrollSync } from "./sync";
import { exportToHtml } from "./exporter";

export default class MarginNotesPlugin extends Plugin {
	scrollSync: ScrollSync = null!;
	/** The leaf holding the sidecar file in split view mode. */
	private splitLeaf: WorkspaceLeaf | null = null;

	async onload(): Promise<void> {
		this.scrollSync = new ScrollSync(this);

		// ── View ───────────────────────────────────────────────
		this.registerView(
			VIEW_TYPE_ANNOTATIONS,
			(leaf) => new AnnotationPaneView(leaf, this)
		);

		// ── CM6 line decorations ───────────────────────────────
		this.registerEditorExtension(annotationLinePlugin);

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

		// If the active view isn't a markdown editor (e.g. the pane itself),
		// find the most recent one.
		if (!view || !view.file || isSidecarFile(view.file.path)) {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				if (
					leaf.view instanceof MarkdownView &&
					leaf.view.file &&
					!isSidecarFile(leaf.view.file.path)
				) {
					view = leaf.view as MarkdownView;
					break;
				}
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
		// Find the source file — try active view, fall back to any markdown leaf
		let sourceLeaf: WorkspaceLeaf | null = null;
		let sourceFile: TFile | null = null;

		const activeView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file && !isSidecarFile(activeView.file.path)) {
			sourceLeaf = activeView.leaf;
			sourceFile = activeView.file;
		} else {
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
		await this.splitLeaf.openFile(sidecarFile);

		// Set up scroll sync after the DOM settles
		const self = this;
		setTimeout(() => {
			if (!self.splitLeaf || !sourceLeaf) return;
			const srcEl = self.getLeafScrollContainer(sourceLeaf);
			const scEl = self.getLeafScrollContainer(self.splitLeaf);
			if (srcEl && scEl) {
				self.scrollSync.attachToElements(srcEl, scEl);
			}
		}, 250);
	}

	closeSplitView(): void {
		if (this.splitLeaf) {
			this.splitLeaf.detach();
			this.splitLeaf = null;
			this.scrollSync.detach();
		}
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
		const el = this.findSourceElement(anchorId);
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.classList.add("margin-notes-flash");
		setTimeout(() => el.classList.remove("margin-notes-flash"), 1500);
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

		const pane = this.getAnnotationPane();
		if (!pane) return;

		// If the sidecar for the current source was modified externally,
		// reload the pane (unless we triggered the modification ourselves).
		if (isSidecarFile(file.path) && !pane.getSuppressReload()) {
			const sourcePath = file.path.replace(/\.ann\.md$/, ".md");
			if (pane.getCurrentSourcePath() === sourcePath) {
				pane.loadForFile(sourcePath);
			}
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
