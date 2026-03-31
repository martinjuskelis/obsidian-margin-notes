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
import { lineSyncField, updateLineHeights } from "./spacer";
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
	/** The leaf holding the notes file in split view. */
	private splitLeaf: WorkspaceLeaf | null = null;
	/** The source leaf that the split view was opened from. */
	private splitSourceLeaf: WorkspaceLeaf | null = null;
	/** Whether scroll sync is active in split mode. */
	private splitSyncEnabled = true;
	/** Link toggle button element. */
	private splitLinkBtn: HTMLElement | null = null;
	/** Debounce timer for line-height recalculation. */
	private lineHeightTimer: number | null = null;
	/** Cached source lines for detecting insertions/deletions. */
	private cachedSourceLines: string[] | null = null;
	/** Guard to prevent recursive notes edits. */
	private applyingLineDiff = false;

	async onload(): Promise<void> {
		this.scrollSync = new ScrollSync(this);

		// ── View (comments pane — secondary) ───────────────────
		this.registerView(
			VIEW_TYPE_ANNOTATIONS,
			(leaf) => new AnnotationPaneView(leaf, this)
		);

		// ── CM6 extensions ─────────────────────────────────────
		this.registerEditorExtension(annotationLinePlugin);
		this.registerEditorExtension(lineSyncField);

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
			name: "Toggle margin notes",
			callback: () => this.toggleMarginNotes(),
		});

		this.addCommand({
			id: "toggle-comments-pane",
			name: "Toggle comments pane (card view)",
			callback: () => this.toggleCommentsPane(),
		});

		this.addCommand({
			id: "export-html",
			name: "Export as HTML with margin notes",
			callback: () => this.exportCurrentFile(),
		});

		// ── Ribbon icon ────────────────────────────────────────
		this.addRibbonIcon(
			"columns-2",
			"Toggle margin notes",
			() => this.toggleMarginNotes()
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

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (this.getAnnotationPane()) {
					this.scrollSync.attach();
				}
				if (this.splitLeaf && this.splitSyncEnabled) {
					this.scheduleLineHeightRecalc();
					setTimeout(() => this.attachSplitSync(), 350);
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("resize", () => {
				if (this.splitLeaf && this.splitSyncEnabled) {
					this.scheduleLineHeightRecalc();
				}
			})
		);

		// Track source edits to mirror line insertions/deletions to notes
		this.registerEvent(
			// @ts-ignore — editor-change event typing
			this.app.workspace.on(
				"editor-change",
				(editor: any, info: any) => {
					this.onSourceEditorChange(editor, info);
				}
			)
		);
	}

	onunload(): void {
		this.scrollSync.detach();
	}

	// ── Toggle (primary action) ────────────────────────────────

	async toggleMarginNotes(): Promise<void> {
		if (this.splitLeaf) {
			this.closeSplitView();
		} else {
			await this.openSplitView();
		}
	}

	// ── Split view ─────────────────────────────────────────────

	async openSplitView(): Promise<void> {
		// 1. Find the source file
		const { leaf: sourceLeaf, file: sourceFile } =
			this.findSourceLeaf();
		if (!sourceLeaf || !sourceFile) {
			new Notice("Open a document first");
			return;
		}

		// 2. Clean up any existing state
		for (const l of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_ANNOTATIONS
		)) {
			l.detach();
		}
		this.closeSplitView();

		// 3. Collapse right sidebar
		// @ts-ignore — rightSplit is stable but not in public typings
		const rs = this.app.workspace.rightSplit;
		if (rs && !rs.collapsed) rs.collapse();

		// 4. Get or create the .ann.md notes file
		const notesPath = getSidecarPath(sourceFile.path);
		let notesFile =
			this.app.vault.getAbstractFileByPath(notesPath);

		const sourceText = await this.app.vault.cachedRead(sourceFile);
		const sourceLineCount = sourceText.split("\n").length;

		if (!(notesFile instanceof TFile)) {
			// Create a new file with matching line count (all blank)
			const blank =
				sourceLineCount > 1
					? "\n".repeat(sourceLineCount - 1)
					: "";
			await this.app.vault.create(notesPath, blank);
			notesFile =
				this.app.vault.getAbstractFileByPath(notesPath);
		}
		if (!(notesFile instanceof TFile)) return;

		// 5. Ensure notes file has at least as many lines as source
		await this.ensureNoteFileLineCount(notesFile, sourceLineCount);

		// 6. Open notes file in a split to the right
		this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
		this.splitLeaf = this.app.workspace.createLeafBySplit(
			sourceLeaf,
			"vertical"
		);
		this.splitSourceLeaf = sourceLeaf;
		await this.splitLeaf.openFile(notesFile);

		// 7. Cache source lines for edit tracking
		this.cachedSourceLines = sourceText.split("\n");

		// 8. Add link toggle button
		this.splitSyncEnabled = true;
		this.addLinkToggle();

		// 9. Line-height matching + scroll sync (after DOM settles)
		setTimeout(() => {
			this.recalculateLineHeights();
			setTimeout(() => this.attachSplitSync(), 100);
		}, 300);
	}

	closeSplitView(): void {
		if (this.splitLinkBtn) {
			this.splitLinkBtn.remove();
			this.splitLinkBtn = null;
		}
		if (this.splitLeaf) {
			// Clear line heights
			const cv = this.getCmView(this.splitLeaf);
			if (cv) {
				cv.dispatch({
					effects: updateLineHeights.of([]),
				});
			}
			this.splitLeaf.detach();
			this.splitLeaf = null;
		}
		this.splitSourceLeaf = null;
		this.cachedSourceLines = null;
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

	/**
	 * Find the source leaf — prioritize the pane's tracked file,
	 * then the active markdown view, then any non-sidecar leaf.
	 */
	private findSourceLeaf(): {
		leaf: WorkspaceLeaf | null;
		file: TFile | null;
	} {
		const pane = this.getAnnotationPane();
		const targetPath = pane?.getCurrentSourcePath();

		// 1. Pane's tracked file
		if (targetPath) {
			for (const leaf of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = leaf.view as MarkdownView;
				if (v.file?.path === targetPath)
					return { leaf, file: v.file };
			}
		}

		// 2. Active markdown view
		const active =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file && !isSidecarFile(active.file.path)) {
			return { leaf: active.leaf, file: active.file };
		}

		// 3. Any non-sidecar markdown leaf
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view as MarkdownView;
			if (v.file && !isSidecarFile(v.file.path))
				return { leaf, file: v.file };
		}

		return { leaf: null, file: null };
	}

	// ── Line count + height matching ───────────────────────────

	private async ensureNoteFileLineCount(
		notesFile: TFile,
		sourceLineCount: number
	): Promise<void> {
		const content = await this.app.vault.read(notesFile);
		const currentCount = content.split("\n").length;

		if (currentCount < sourceLineCount) {
			const padding = "\n".repeat(
				sourceLineCount - currentCount
			);
			await this.app.vault.modify(notesFile, content + padding);
		}
	}

	private scheduleLineHeightRecalc(): void {
		if (this.lineHeightTimer)
			window.clearTimeout(this.lineHeightTimer);
		this.lineHeightTimer = window.setTimeout(() => {
			this.lineHeightTimer = null;
			this.recalculateLineHeights();
		}, 250);
	}

	/**
	 * Measure each source line's height and set min-height on
	 * the corresponding notes line so they align visually.
	 */
	private recalculateLineHeights(): void {
		if (!this.splitLeaf || !this.splitSourceLeaf) return;
		if (!this.splitSyncEnabled) return;

		const sourceCV = this.getCmView(this.splitSourceLeaf);
		const notesCV = this.getCmView(this.splitLeaf);
		if (!sourceCV || !notesCV) return;

		const sourceDoc = sourceCV.state.doc;
		const heights: number[] = [];

		for (let i = 1; i <= sourceDoc.lines; i++) {
			const block = sourceCV.lineBlockAt(
				sourceDoc.line(i).from
			);
			heights.push(block.height);
		}

		notesCV.dispatch({
			effects: updateLineHeights.of(heights),
		});
	}

	// ── Source edit tracking (line sync) ───────────────────────

	/**
	 * Called on every keystroke in any editor. Checks if the source
	 * file's line count changed, and if so, mirrors the line
	 * insertion/deletion to the notes file.
	 */
	private onSourceEditorChange(editor: any, info: any): void {
		if (!this.splitLeaf || !this.splitSourceLeaf) return;
		if (!this.cachedSourceLines) return;
		if (this.applyingLineDiff) return;

		// Only process the tracked source file
		const sourceFile = (this.splitSourceLeaf.view as MarkdownView)
			.file;
		if (!sourceFile || info?.file?.path !== sourceFile.path) return;

		// O(1) check — skip if line count hasn't changed
		const newLineCount = editor.lineCount();
		if (newLineCount === this.cachedSourceLines.length) return;

		// Line count changed — diff and apply
		const newLines = (editor.getValue() as string).split("\n");
		this.applyLineDiff(this.cachedSourceLines, newLines);
		this.cachedSourceLines = newLines;
		this.scheduleLineHeightRecalc();
	}

	/**
	 * Diff old vs new source lines and apply matching changes
	 * to the notes editor. Insertions add blank lines; deletions
	 * remove only blank lines (content is never lost).
	 */
	private applyLineDiff(
		oldLines: string[],
		newLines: string[]
	): void {
		if (!this.splitLeaf) return;
		const notesView = this.splitLeaf.view;
		if (!(notesView instanceof MarkdownView)) return;
		const notesEditor = notesView.editor;

		const change = this.diffLines(oldLines, newLines);
		if (!change) return;

		const { position, removed, added } = change;
		this.applyingLineDiff = true;

		try {
			if (added > removed) {
				// Lines inserted in source → insert blank lines in notes
				const count = added - removed;
				const insertAt = Math.min(
					position + removed,
					notesEditor.lineCount()
				);
				notesEditor.replaceRange(
					"\n".repeat(count),
					{ line: insertAt, ch: 0 }
				);
			} else if (removed > added) {
				// Lines deleted from source → remove blank notes lines
				const count = removed - added;
				const deleteAt = position + added;

				// Delete from bottom up so indices stay valid
				for (let i = count - 1; i >= 0; i--) {
					const idx = deleteAt + i;
					if (idx >= notesEditor.lineCount()) continue;

					const text = notesEditor.getLine(idx);
					if (text.trim() !== "") continue; // never delete content

					if (idx < notesEditor.lineCount() - 1) {
						// Delete this line (including its newline)
						notesEditor.replaceRange(
							"",
							{ line: idx, ch: 0 },
							{ line: idx + 1, ch: 0 }
						);
					} else if (idx > 0) {
						// Last line — remove the newline before it
						const prev = notesEditor.getLine(idx - 1);
						notesEditor.replaceRange(
							"",
							{ line: idx - 1, ch: prev.length },
							{ line: idx, ch: text.length }
						);
					}
				}
			}
		} finally {
			this.applyingLineDiff = false;
		}
	}

	/**
	 * Find the single contiguous change between two line arrays.
	 * Returns the position and size of the changed region, or null
	 * if no structural change (only content edits within lines).
	 */
	private diffLines(
		oldLines: string[],
		newLines: string[]
	): { position: number; removed: number; added: number } | null {
		// Common prefix
		let top = 0;
		const minLen = Math.min(oldLines.length, newLines.length);
		while (
			top < minLen &&
			oldLines[top] === newLines[top]
		) {
			top++;
		}

		// Common suffix
		let oldBot = oldLines.length - 1;
		let newBot = newLines.length - 1;
		while (
			oldBot > top &&
			newBot > top &&
			oldLines[oldBot] === newLines[newBot]
		) {
			oldBot--;
			newBot--;
		}

		// Clamp
		if (oldBot < top) oldBot = top - 1;
		if (newBot < top) newBot = top - 1;

		const removed = oldBot - top + 1;
		const added = newBot - top + 1;
		if (removed === 0 && added === 0) return null;

		return { position: top, removed, added };
	}

	// ── Link toggle button ─────────────────────────────────────

	private addLinkToggle(): void {
		if (!this.splitLeaf) return;
		const actions =
			this.splitLeaf.view.containerEl.querySelector(
				".view-actions"
			);
		if (!actions) return;

		const btn = document.createElement("a");
		btn.className =
			"view-action margin-notes-link-toggle is-linked";
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
				btn.setAttribute(
					"aria-label",
					"Scroll sync (linked)"
				);
				this.recalculateLineHeights();
				setTimeout(() => this.attachSplitSync(), 100);
			} else {
				setIcon(btn, "unlink");
				btn.classList.remove("is-linked");
				btn.classList.add("is-unlinked");
				btn.setAttribute(
					"aria-label",
					"Scroll sync (unlinked)"
				);
				this.scrollSync.detach();
				const cv = this.splitLeaf
					? this.getCmView(this.splitLeaf)
					: null;
				if (cv) {
					cv.dispatch({
						effects: updateLineHeights.of([]),
					});
				}
			}
		});
	}

	// ── Annotation creation (anchor-based, for comments pane) ──

	private async addAnnotationFromEditor(
		view: MarkdownView
	): Promise<void> {
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
		await this.ensureCommentsPaneOpen();

		const pane = this.getAnnotationPane();
		if (pane) {
			await pane.loadForFile(file.path);
			pane.focusAnnotation(id);
		}
	}

	async addAnnotationAtCursor(): Promise<void> {
		let view =
			this.app.workspace.getActiveViewOfType(MarkdownView);

		if (
			!view ||
			!view.file ||
			isSidecarFile(view.file.path)
		) {
			const pane = this.getAnnotationPane();
			const targetPath = pane?.getCurrentSourcePath();

			for (const leaf of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = leaf.view as MarkdownView;
				if (!v.file || isSidecarFile(v.file.path)) continue;
				if (targetPath && v.file.path === targetPath) {
					view = v;
					break;
				}
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

		const sourceFile =
			this.app.vault.getAbstractFileByPath(sourcePath);
		if (sourceFile instanceof TFile) {
			const sourceText =
				await this.app.vault.cachedRead(sourceFile);
			sortAnnotationsBySource(sidecar, sourceText);
		}

		await this.saveSidecar(sidecarPath, sidecar);
	}

	// ── Sidecar I/O ────────────────────────────────────────────

	private async loadSidecar(
		sidecarPath: string,
		sourcePath: string
	): Promise<SidecarData> {
		const file =
			this.app.vault.getAbstractFileByPath(sidecarPath);
		if (file instanceof TFile) {
			return parseSidecar(
				await this.app.vault.cachedRead(file)
			);
		}
		return { source: sourcePath, annotations: [] };
	}

	private async saveSidecar(
		sidecarPath: string,
		data: SidecarData
	): Promise<void> {
		const content = serializeSidecar(data);
		const existing =
			this.app.vault.getAbstractFileByPath(sidecarPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(sidecarPath, content);
		}
	}

	// ── Comments pane (secondary) ──────────────────────────────

	async toggleCommentsPane(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		if (existing.length) {
			existing[0].detach();
			this.scrollSync.detach();
		} else {
			await this.ensureCommentsPaneOpen();
		}
	}

	async ensureCommentsPaneOpen(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

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
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			this.flashElement(el);
			return;
		}

		const mdView = this.getSourceMarkdownView();
		if (!mdView) return;

		const text = mdView.editor.getValue();
		const lines = text.split("\n");
		let anchorLine = -1;
		for (let i = 0; i < lines.length; i++) {
			if (
				lines[i].includes(`<!-- ann:${anchorId} -->`)
			) {
				anchorLine = i;
				break;
			}
		}
		if (anchorLine < 0) return;

		const mode = mdView.getMode();
		if (mode === "source") {
			const cmView = this.getCmView(mdView.leaf);
			if (cmView) {
				const pos = cmView.state.doc.line(
					anchorLine + 1
				).from;
				cmView.dispatch({
					effects: EditorView.scrollIntoView(pos, {
						y: "center",
					}),
				});
			}
		} else {
			const scrollEl =
				mdView.containerEl.querySelector(
					".markdown-preview-view"
				) as HTMLElement | null;
			if (scrollEl) {
				const frac =
					anchorLine / Math.max(lines.length, 1);
				scrollEl.scrollTop =
					frac *
					(scrollEl.scrollHeight -
						scrollEl.clientHeight);
			}
		}

		setTimeout(() => {
			const el2 = this.findSourceElement(anchorId);
			if (el2) {
				el2.scrollIntoView({
					behavior: "smooth",
					block: "nearest",
				});
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
		setTimeout(
			() => card.classList.remove("margin-notes-flash"),
			1500
		);
	}

	private findSourceElement(
		anchorId: string
	): HTMLElement | null {
		for (const leaf of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const el = leaf.view.containerEl.querySelector(
				`[data-ann-id="${anchorId}"]`
			) as HTMLElement | null;
			if (el) return el;
		}
		return null;
	}

	private flashElement(el: HTMLElement): void {
		el.classList.add("margin-notes-flash");
		setTimeout(
			() => el.classList.remove("margin-notes-flash"),
			1500
		);
	}

	private getSourceMarkdownView(): MarkdownView | null {
		const pane = this.getAnnotationPane();
		const targetPath = pane?.getCurrentSourcePath();

		if (targetPath) {
			for (const leaf of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = leaf.view as MarkdownView;
				if (v.file?.path === targetPath) return v;
			}
		}

		for (const leaf of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const v = leaf.view as MarkdownView;
			if (v.file && !isSidecarFile(v.file.path)) return v;
		}
		return null;
	}

	// ── Helpers ────────────────────────────────────────────────

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

	// ── Event handlers ─────────────────────────────────────────

	private onActiveLeafChange(): void {
		const pane = this.getAnnotationPane();
		if (!pane) return;

		const file = this.app.workspace.getActiveFile();
		if (
			file &&
			!isSidecarFile(file.path) &&
			file.path.endsWith(".md")
		) {
			pane.loadForFile(file.path);
			setTimeout(() => this.scrollSync.attach(), 150);
		}
	}

	private async onFileRenamed(
		file: TAbstractFile,
		oldPath: string
	): Promise<void> {
		if (!(file instanceof TFile)) return;
		if (isSidecarFile(file.path) || isSidecarFile(oldPath))
			return;

		const oldSidecarPath = getSidecarPath(oldPath);
		const sidecar =
			this.app.vault.getAbstractFileByPath(oldSidecarPath);
		if (!(sidecar instanceof TFile)) return;

		const newSidecarPath = getSidecarPath(file.path);
		await this.app.vault.rename(sidecar, newSidecarPath);

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
		if (
			pane &&
			isSidecarFile(file.path) &&
			!pane.getSuppressReload()
		) {
			const sourcePath = file.path.replace(
				/\.ann\.md$/,
				".md"
			);
			if (pane.getCurrentSourcePath() === sourcePath) {
				pane.loadForFile(sourcePath);
			}
		}

		// Split view: recalculate line heights when source changes
		if (this.splitLeaf && this.splitSyncEnabled) {
			this.scheduleLineHeightRecalc();
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
			const msg =
				e instanceof Error ? e.message : String(e);
			new Notice(`Export failed: ${msg}`);
		}
	}
}
