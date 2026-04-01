import {
	Plugin,
	MarkdownView,
	TFile,
	TAbstractFile,
	WorkspaceLeaf,
	Notice,
	Platform,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { MarginNotesView, VIEW_TYPE_NOTES } from "./notes-view";
import { annotationLinePlugin } from "./cm-extension";
import { generateId, ANCHOR_RE, removeAnchor } from "./anchor";
import {
	getSidecarPath,
	isSidecarFile,
	parseSidecar,
	serializeSidecar,
	sortAnnotationsBySource,
} from "./sidecar";
import type { SidecarData } from "./sidecar";
import { exportToHtml } from "./exporter";
import {
	MarginNotesSettingTab,
	DEFAULT_SETTINGS,
} from "./settings";
import type { MarginNotesSettings } from "./settings";

// Keep the old pane for mobile card view
import { AnnotationPaneView, VIEW_TYPE_ANNOTATIONS } from "./pane";

export default class MarginNotesPlugin extends Plugin {
	settings: MarginNotesSettings = DEFAULT_SETTINGS;
	/** The leaf holding the custom notes view. */
	splitLeaf: WorkspaceLeaf | null = null;
	/** The source leaf the notes view is paired with. */
	splitSourceLeaf: WorkspaceLeaf | null = null;
	/** Debounce timer for repositioning. */
	private repositionTimer: number | null = null;
	/** Last known source editor mode ('source' or 'preview'). */
	private lastSourceMode: string | null = null;

	async onload(): Promise<void> {
		// ── Settings ───────────────────────────────────────────
		await this.loadSettings();
		this.addSettingTab(
			new MarginNotesSettingTab(this.app, this)
		);

		// ── Views ──────────────────────────────────────────────
		this.registerView(
			VIEW_TYPE_NOTES,
			(leaf) => new MarginNotesView(leaf, this)
		);
		// Keep old card view for mobile
		this.registerView(
			VIEW_TYPE_ANNOTATIONS,
			(leaf) => new AnnotationPaneView(leaf, this)
		);

		// ── CM6 anchor decorations (data-ann-id on source lines) ──
		this.registerEditorExtension(annotationLinePlugin);

		// ── Reading View post-processor ────────────────────────
		this.registerMarkdownPostProcessor((el, ctx) => {
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			const lines = info.text
				.split("\n")
				.slice(info.lineStart, info.lineEnd + 1);
			for (const line of lines) {
				const m = ANCHOR_RE.exec(line);
				if (m) {
					const t =
						el.querySelector(
							"p,h1,h2,h3,h4,h5,h6,li,blockquote"
						) || el;
					t.setAttribute("data-ann-id", m[1]);
					t.classList.add("margin-notes-anchored");
					break;
				}
			}
		});

		// ── Commands ───────────────────────────────────────────
		this.addCommand({
			id: "toggle-pane",
			name: "Toggle margin notes",
			callback: () => this.toggle(),
		});

		this.addCommand({
			id: "add-margin-note",
			name: "Add margin note at cursor",
			editorCallback: (_, ctx) => {
				if (ctx instanceof MarkdownView)
					this.addAnnotation(ctx);
			},
		});

		this.addCommand({
			id: "toggle-comments-pane",
			name: "Toggle comments pane (card view)",
			callback: () => this.toggleCardView(),
		});

		this.addCommand({
			id: "export-html",
			name: "Export as HTML with margin notes",
			callback: () => this.exportCurrentFile(),
		});

		// ── Right-click context menu ───────────────────────────
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if (view instanceof MarkdownView && view.file && !isSidecarFile(view.file.path)) {
					menu.addItem((item) => {
						item.setTitle("Add margin note")
							.setIcon("message-square")
							.onClick(() => this.addAnnotation(view));
					});
				}
			})
		);

		// ── Ribbon ─────────────────────────────────────────────
		this.addRibbonIcon("columns-2", "Toggle margin notes", () =>
			this.toggle()
		);

		// ── Events ─────────────────────────────────────────────
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.onActiveLeafChange()
			)
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, old) =>
				this.onFileRenamed(f, old)
			)
		);
		this.registerEvent(
			this.app.vault.on("modify", (f) =>
				this.onFileModified(f)
			)
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.handleModeChange();
				this.scheduleReposition();
			})
		);
		this.registerEvent(
			this.app.workspace.on("resize", () =>
				this.scheduleReposition()
			)
		);
	}

	onunload(): void {
		document.body.classList.remove("mn-no-highlights");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		this.updateHighlightVisibility();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ── Toggle ─────────────────────────────────────────────────

	async toggle(): Promise<void> {
		if (Platform.isMobile) {
			await this.toggleCardView();
			return;
		}

		// Check if any notes view is open (handles stale splitLeaf refs)
		const existingLeaves =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTES);
		if (existingLeaves.length > 0 || this.splitLeaf) {
			this.closeSplit();
		} else {
			await this.openSplit();
		}
	}

	// ── Split view (desktop) ───────────────────────────────────

	async openSplit(): Promise<void> {
		const { leaf: srcLeaf, file: srcFile } =
			this.findSourceLeaf();
		if (!srcLeaf || !srcFile) {
			new Notice("Open a document first");
			return;
		}

		// Clean up any existing views
		for (const l of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_NOTES
		))
			l.detach();
		for (const l of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_ANNOTATIONS
		))
			l.detach();
		this.closeSplit();

		// Collapse right sidebar
		// @ts-ignore
		const rs = this.app.workspace.rightSplit;
		if (rs && !rs.collapsed) rs.collapse();

		// Ensure sidecar file exists
		const scPath = getSidecarPath(srcFile.path);
		let scFile =
			this.app.vault.getAbstractFileByPath(scPath);
		if (!(scFile instanceof TFile)) {
			await this.app.vault.create(
				scPath,
				serializeSidecar({
					source: srcFile.path,
					annotations: [],
				})
			);
		}

		// Open the custom notes view in a split
		this.app.workspace.setActiveLeaf(srcLeaf, { focus: true });
		this.splitLeaf = this.app.workspace.createLeafBySplit(
			srcLeaf,
			"vertical"
		);
		this.splitSourceLeaf = srcLeaf;
		this.lastSourceMode = (srcLeaf.view as MarkdownView).getMode();

		await this.splitLeaf.setViewState({
			type: VIEW_TYPE_NOTES,
			active: true,
		});

		// After DOM settles, load annotations and wire scroll sync
		setTimeout(() => {
			const nv = this.getNotesView();
			const srcScrollEl = this.getSourceScrollEl();
			if (nv && srcScrollEl) {
				nv.loadForSource(srcFile.path, srcScrollEl);
			}
		}, 300);
	}

	closeSplit(): void {
		// Close all notes view leaves (handles stale references too)
		for (const l of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_NOTES
		))
			l.detach();
		this.splitLeaf = null;
		this.splitSourceLeaf = null;
	}

	/**
	 * Detect when the source editor switches between editing and
	 * reading mode. Unsync on any mode change; optionally auto-relink
	 * when returning to editing mode.
	 */
	private handleModeChange(): void {
		if (!this.splitSourceLeaf) return;
		const v = this.splitSourceLeaf.view;
		if (!(v instanceof MarkdownView)) return;

		const currentMode = v.getMode(); // 'source' or 'preview'
		if (this.lastSourceMode === null) {
			this.lastSourceMode = currentMode;
			return;
		}

		if (currentMode === this.lastSourceMode) return;

		const prevMode = this.lastSourceMode;
		this.lastSourceMode = currentMode;

		const nv = this.getNotesView();
		if (!nv) return;

		// Mode changed — unsync
		nv.setLinked(false);

		// Auto-relink when returning to editing mode
		if (
			currentMode === "source" &&
			prevMode === "preview" &&
			this.settings.autoRelinkOnEditMode
		) {
			// Small delay so the editor DOM settles
			setTimeout(() => nv.setLinked(true), 400);
		}
	}

	private findSourceLeaf(): {
		leaf: WorkspaceLeaf | null;
		file: TFile | null;
	} {
		// Active markdown view (non-sidecar)
		const active =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file && !isSidecarFile(active.file.path))
			return { leaf: active.leaf, file: active.file };

		// Any non-sidecar markdown leaf
		for (const l of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const v = l.view as MarkdownView;
			if (v.file && !isSidecarFile(v.file.path))
				return { leaf: l, file: v.file };
		}
		return { leaf: null, file: null };
	}

	// ── Annotation creation ────────────────────────────────────

	async addAnnotation(view: MarkdownView): Promise<void> {
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

		// Add to sidecar
		const scPath = getSidecarPath(file.path);
		const sc = await this.loadSidecar(scPath, file.path);
		sc.annotations.push({ anchorId: id, content: "" });
		const srcText = await this.app.vault.cachedRead(file);
		sortAnnotationsBySource(sc, srcText);
		await this.saveSidecar(scPath, sc);

		// Update the notes view and focus the new slot
		const nv = this.getNotesView();
		if (nv) {
			await nv.onSourceModified();
			nv.focusSlot(id);
		}
	}

	/**
	 * Create an annotation at a specific Y coordinate in the notes view.
	 * Called when the user clicks on empty space in the notes pane.
	 */
	async createAnnotationAtY(y: number): Promise<void> {
		const nv = this.getNotesView();
		if (!nv || !this.splitSourceLeaf) return;

		const lineNum = nv.findSourceLineAtY(y);
		if (lineNum == null) return;

		const sv = this.splitSourceLeaf.view;
		if (!(sv instanceof MarkdownView) || !sv.file) return;

		const editor = sv.editor;
		const line = editor.getLine(lineNum - 1); // lineNum is 1-based
		if (ANCHOR_RE.test(line)) return;

		const id = generateId();
		editor.replaceRange(` <!-- ann:${id} -->`, {
			line: lineNum - 1,
			ch: line.length,
		});

		const scPath = getSidecarPath(sv.file.path);
		const sc = await this.loadSidecar(scPath, sv.file.path);
		sc.annotations.push({ anchorId: id, content: "" });
		const srcText = await this.app.vault.cachedRead(sv.file);
		sortAnnotationsBySource(sc, srcText);
		await this.saveSidecar(scPath, sc);

		await nv.onSourceModified();
		nv.focusSlot(id);
	}

	// ── Sidecar I/O ────────────────────────────────────────────

	private async loadSidecar(
		path: string,
		sourcePath: string
	): Promise<SidecarData> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile)
			return parseSidecar(
				await this.app.vault.cachedRead(f)
			);
		return { source: sourcePath, annotations: [] };
	}

	private async saveSidecar(
		path: string,
		data: SidecarData
	): Promise<void> {
		const content = serializeSidecar(data);
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.vault.modify(f, content);
		else await this.app.vault.create(path, content);
	}

	// ── Source highlighting ────────────────────────────────────

	highlightSource(anchorId: string): void {
		// Hover highlight always works — the setting controls only
		// the static right-border on anchored lines
		const el = this.findSourceEl(anchorId);
		if (el) el.classList.add("margin-notes-highlight");
	}

	unhighlightSource(anchorId: string): void {
		const el = this.findSourceEl(anchorId);
		if (el) el.classList.remove("margin-notes-highlight");
	}

	/** Toggle CSS class on body to show/hide static anchor highlights. */
	updateHighlightVisibility(): void {
		if (this.settings.showSourceHighlight) {
			document.body.classList.remove("mn-no-highlights");
		} else {
			document.body.classList.add("mn-no-highlights");
		}
	}

	scrollSourceToAnchor(anchorId: string): void {
		const el = this.findSourceEl(anchorId);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.classList.add("margin-notes-flash");
			setTimeout(
				() => el.classList.remove("margin-notes-flash"),
				1500
			);
		}
	}

	private findSourceEl(anchorId: string): HTMLElement | null {
		for (const l of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const el = l.view.containerEl.querySelector(
				`[data-ann-id="${anchorId}"]`
			) as HTMLElement | null;
			if (el) return el;
		}
		return null;
	}

	/** Called from the "+" button in either the notes view or card pane. */
	async addAnnotationFromPane(): Promise<void> {
		// Find the source path from whichever view is active
		const nv = this.getNotesView();
		const pane = this.getAnnotationPane();
		const targetPath =
			nv?.getSourcePath() ??
			pane?.getCurrentSourcePath() ??
			// Fall back to the split source leaf's file
			(this.splitSourceLeaf?.view instanceof MarkdownView
				? this.splitSourceLeaf.view.file?.path
				: null);

		if (!targetPath) {
			new Notice("Open a document first");
			return;
		}

		for (const l of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const v = l.view as MarkdownView;
			if (v.file?.path === targetPath) {
				await this.addAnnotation(v);
				// Refresh whichever view is showing
				if (nv) await nv.onSourceModified();
				if (pane) {
					await pane.loadForFile(targetPath);
					const anns = pane.getAnnotations();
					if (anns.length > 0)
						pane.focusAnnotation(
							anns[anns.length - 1].anchorId
						);
				}
				return;
			}
		}

		new Notice(
			"Place your cursor in the source document first"
		);
	}

	// ── Helpers ────────────────────────────────────────────────

	getNotesView(): MarginNotesView | null {
		const leaves =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTES);
		return leaves.length
			? (leaves[0].view as MarginNotesView)
			: null;
	}

	private getSourceScrollEl(): HTMLElement | null {
		if (!this.splitSourceLeaf) return null;
		const v = this.splitSourceLeaf.view;
		if (!(v instanceof MarkdownView)) return null;
		if (v.getMode() === "preview")
			return v.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
		return v.containerEl.querySelector(
			".cm-scroller"
		) as HTMLElement | null;
	}

	private scheduleReposition(): void {
		if (this.repositionTimer)
			window.clearTimeout(this.repositionTimer);
		this.repositionTimer = window.setTimeout(() => {
			this.repositionTimer = null;
			const nv = this.getNotesView();
			if (nv) {
				// Re-attach scroll sync in case scroll containers changed
				const srcEl = this.getSourceScrollEl();
				if (srcEl) {
					nv.getScrollContainer(); // ensure it exists
					nv.repositionSlots();
				}
			}
		}, 200);
	}

	// ── Card view (mobile) ─────────────────────────────────────

	async toggleCardView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		if (existing.length) {
			existing[0].detach();
		} else {
			let leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) leaf = this.app.workspace.getLeaf("split");
			await leaf.setViewState({
				type: VIEW_TYPE_ANNOTATIONS,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
		}
	}

	// Expose for the card view pane
	getAnnotationPane(): AnnotationPaneView | null {
		const leaves =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		return leaves.length
			? (leaves[0].view as AnnotationPaneView)
			: null;
	}

	// ── Event handlers ─────────────────────────────────────────

	private onActiveLeafChange(): void {
		// Update card view if open
		const pane = this.getAnnotationPane();
		if (pane) {
			const file = this.app.workspace.getActiveFile();
			if (
				file &&
				!isSidecarFile(file.path) &&
				file.path.endsWith(".md")
			)
				pane.loadForFile(file.path);
		}

		// Update notes view link state — detach sync only when a
		// DIFFERENT markdown file is focused (not when the notes
		// pane itself gets focus)
		const nv = this.getNotesView();
		if (nv && this.splitSourceLeaf) {
			const activeMd =
				this.app.workspace.getActiveViewOfType(
					MarkdownView
				);
			if (activeMd) {
				// A markdown file is active — check if it's the right one
				const isCorrect =
					activeMd.leaf === this.splitSourceLeaf;
				nv.updateLinkState(isCorrect);
			}
			// If no markdown view is active (e.g. notes pane clicked),
			// don't change the link state
		}
	}

	private async onFileRenamed(
		file: TAbstractFile,
		oldPath: string
	): Promise<void> {
		if (!(file instanceof TFile)) return;
		if (isSidecarFile(file.path) || isSidecarFile(oldPath))
			return;
		const oldSc = getSidecarPath(oldPath);
		const sc = this.app.vault.getAbstractFileByPath(oldSc);
		if (!(sc instanceof TFile)) return;
		const newSc = getSidecarPath(file.path);
		await this.app.vault.rename(sc, newSc);
		const rf = this.app.vault.getAbstractFileByPath(newSc);
		if (rf instanceof TFile) {
			const data = parseSidecar(await this.app.vault.read(rf));
			data.source = file.path;
			await this.app.vault.modify(
				rf,
				serializeSidecar(data)
			);
		}
	}

	private onFileModified(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;

		// Card view
		const pane = this.getAnnotationPane();
		if (
			pane &&
			isSidecarFile(file.path) &&
			!pane.getSuppressReload()
		) {
			const src = file.path.replace(/\.ann\.md$/, ".md");
			if (pane.getCurrentSourcePath() === src)
				pane.loadForFile(src);
		}

		// Notes view: reposition when source changes
		const nv = this.getNotesView();
		if (nv && !nv.isSuppressingReload()) {
			const srcPath = nv.getSourcePath();
			if (srcPath === file.path) {
				// Source file changed
				nv.onSourceModified();
			} else if (
				srcPath &&
				file.path === getSidecarPath(srcPath)
			) {
				// Sidecar changed externally
				nv.onSourceModified();
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
		const src = isSidecarFile(active.path)
			? active.path.replace(/\.ann\.md$/, ".md")
			: active.path;
		try {
			const html = await exportToHtml(
					this.app,
					src,
					this.settings
				);
			const ep = src.replace(/\.md$/, ".html");
			const ef = this.app.vault.getAbstractFileByPath(ep);
			if (ef instanceof TFile)
				await this.app.vault.modify(ef, html);
			else await this.app.vault.create(ep, html);
			new Notice(`Exported to ${ep}`);
		} catch (e: unknown) {
			new Notice(
				`Export failed: ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}
}
