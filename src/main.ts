import {
	Plugin,
	MarkdownView,
	TFile,
	TAbstractFile,
	WorkspaceLeaf,
	Notice,
	setIcon,
	Platform,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { AnnotationPaneView, VIEW_TYPE_ANNOTATIONS } from "./pane";
import { annotationLinePlugin } from "./cm-extension";
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
	private splitLeaf: WorkspaceLeaf | null = null;
	private splitSourceLeaf: WorkspaceLeaf | null = null;
	private splitSyncEnabled = true;
	private splitLinkBtn: HTMLElement | null = null;
	/** Cached source lines for detecting line insertions/deletions. */
	private cachedSourceLines: string[] | null = null;
	/** Cached notes line count for detecting Enter presses. */
	private cachedNotesLineCount: number | null = null;
	/** Guard against recursive edits. */
	private applyingDiff = false;

	async onload(): Promise<void> {
		this.scrollSync = new ScrollSync(this);

		// ── Views & extensions ──────────────────────────────────
		this.registerView(
			VIEW_TYPE_ANNOTATIONS,
			(leaf) => new AnnotationPaneView(leaf, this)
		);
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
				if (ctx instanceof MarkdownView)
					this.addAnnotation(ctx);
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

		// ── Ribbon ─────────────────────────────────────────────
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
			this.app.vault.on("rename", (f, old) =>
				this.onFileRenamed(f, old)
			)
		);
		this.registerEvent(
			this.app.vault.on("modify", (f) =>
				this.onFileModified(f)
			)
		);
		// Track edits in both panes for auto-anchor + line sync
		this.registerEvent(
			// @ts-ignore — editor-change event typing
			this.app.workspace.on(
				"editor-change",
				(editor: any, info: any) =>
					this.onEditorChange(editor, info)
			)
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (this.getAnnotationPane())
					this.scrollSync.attach();
				if (this.splitLeaf && this.splitSyncEnabled)
					setTimeout(() => this.attachSplitSync(), 350);
			})
		);
	}

	onunload(): void {
		this.scrollSync.detach();
	}

	// ── Toggle (primary action) ────────────────────────────────

	async toggleMarginNotes(): Promise<void> {
		if (Platform.isMobile) {
			// Mobile: use the comments pane in the right sidebar
			await this.toggleCommentsPane();
		} else {
			// Desktop: use the split view
			if (this.splitLeaf) {
				this.closeSplitView();
			} else {
				await this.openSplitView();
			}
		}
	}

	// ── Split view (desktop) ───────────────────────────────────

	async openSplitView(): Promise<void> {
		const { leaf: sourceLeaf, file: sourceFile } =
			this.findSourceLeaf();
		if (!sourceLeaf || !sourceFile) {
			new Notice("Open a document first");
			return;
		}

		// Clean up
		for (const l of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_ANNOTATIONS
		))
			l.detach();
		this.closeSplitView();

		// Collapse right sidebar
		// @ts-ignore — rightSplit is stable but not in public typings
		const rs = this.app.workspace.rightSplit;
		if (rs && !rs.collapsed) rs.collapse();

		// Get or create the .ann.md notes file
		const notesPath = getSidecarPath(sourceFile.path);
		let notesFile =
			this.app.vault.getAbstractFileByPath(notesPath);

		const sourceText =
			await this.app.vault.cachedRead(sourceFile);
		const sourceLines = sourceText.split("\n");

		if (!(notesFile instanceof TFile)) {
			// Create padded file: N blank lines matching source
			const blank =
				sourceLines.length > 1
					? "\n".repeat(sourceLines.length - 1)
					: "";
			await this.app.vault.create(notesPath, blank);
			notesFile =
				this.app.vault.getAbstractFileByPath(notesPath);
		}
		if (!(notesFile instanceof TFile)) return;

		// Cache source lines for edit tracking
		this.cachedSourceLines = sourceLines;

		// Open in split
		this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
		this.splitLeaf = this.app.workspace.createLeafBySplit(
			sourceLeaf,
			"vertical"
		);
		this.splitSourceLeaf = sourceLeaf;
		await this.splitLeaf.openFile(notesFile);

		// Cache notes line count
		const nv = this.splitLeaf.view as MarkdownView;
		this.cachedNotesLineCount = nv.editor.lineCount();

		// Link toggle + sync
		this.splitSyncEnabled = true;
		this.addLinkToggle();
		setTimeout(() => this.attachSplitSync(), 300);
	}

	closeSplitView(): void {
		if (this.splitLinkBtn) {
			this.splitLinkBtn.remove();
			this.splitLinkBtn = null;
		}
		if (this.splitLeaf) {
			this.splitLeaf.detach();
			this.splitLeaf = null;
		}
		this.splitSourceLeaf = null;
		this.cachedSourceLines = null;
		this.cachedNotesLineCount = null;
		this.scrollSync.detach();
	}

	private attachSplitSync(): void {
		if (
			!this.splitLeaf ||
			!this.splitSourceLeaf ||
			!this.splitSyncEnabled
		)
			return;
		const s = this.getLeafScrollContainer(this.splitSourceLeaf);
		const n = this.getLeafScrollContainer(this.splitLeaf);
		if (s && n) this.scrollSync.attachToElements(s, n);
	}

	private findSourceLeaf(): {
		leaf: WorkspaceLeaf | null;
		file: TFile | null;
	} {
		const pane = this.getAnnotationPane();
		const target = pane?.getCurrentSourcePath();

		if (target) {
			for (const l of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = l.view as MarkdownView;
				if (v.file?.path === target)
					return { leaf: l, file: v.file };
			}
		}

		const active =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file && !isSidecarFile(active.file.path))
			return { leaf: active.leaf, file: active.file };

		for (const l of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const v = l.view as MarkdownView;
			if (v.file && !isSidecarFile(v.file.path))
				return { leaf: l, file: v.file };
		}
		return { leaf: null, file: null };
	}

	// ── Anchor-based spacer alignment ──────────────────────────

	// ── Edit tracking (auto-anchor + line sync) ───────────────

	private onEditorChange(editor: any, info: any): void {
		if (!this.splitLeaf || !this.splitSourceLeaf) return;
		if (this.applyingDiff) return;

		const changed = info?.file?.path;
		const srcFile = (this.splitSourceLeaf.view as MarkdownView)
			.file;
		const notFile = (this.splitLeaf.view as MarkdownView).file;

		if (changed === srcFile?.path) {
			this.onSourceEdit(editor);
		} else if (changed === notFile?.path) {
			this.onNotesEdit(editor);
		}
	}

	/** Source file edited — mirror line insertions/deletions to notes. */
	private onSourceEdit(editor: any): void {
		if (!this.cachedSourceLines) return;
		const newCount = editor.lineCount();
		if (newCount === this.cachedSourceLines.length) return;

		const newLines = (editor.getValue() as string).split("\n");
		const change = this.diffLines(
			this.cachedSourceLines,
			newLines
		);
		this.cachedSourceLines = newLines;
		if (!change) return;

		const nv = this.splitLeaf?.view;
		if (!(nv instanceof MarkdownView)) return;
		const ne = nv.editor;

		this.applyingDiff = true;
		try {
			const { position, removed, added } = change;
			if (added > removed) {
				const count = added - removed;
				const at = Math.min(
					position + removed,
					ne.lineCount()
				);
				ne.replaceRange("\n".repeat(count), {
					line: at,
					ch: 0,
				});
			} else if (removed > added) {
				const count = removed - added;
				const at = position + added;
				for (let i = count - 1; i >= 0; i--) {
					const idx = at + i;
					if (idx >= ne.lineCount()) continue;
					if (ne.getLine(idx).trim() !== "") continue;
					if (idx < ne.lineCount() - 1) {
						ne.replaceRange(
							"",
							{ line: idx, ch: 0 },
							{ line: idx + 1, ch: 0 }
						);
					} else if (idx > 0) {
						const prev = ne.getLine(idx - 1);
						ne.replaceRange(
							"",
							{ line: idx - 1, ch: prev.length },
							{ line: idx, ch: 0 }
						);
					}
				}
			}
			this.cachedNotesLineCount = ne.lineCount();
		} finally {
			this.applyingDiff = false;
		}
		this.attachSplitSync();
	}

	/**
	 * Notes file edited — auto-create anchors when the user types
	 * on a blank line, and absorb extra lines on Enter.
	 */
	private onNotesEdit(editor: any): void {
		if (this.cachedNotesLineCount == null) return;

		const cursor = editor.getCursor();
		const lineText: string = editor.getLine(cursor.line);
		const newCount: number = editor.lineCount();

		// ── Auto-anchor: user typed on a blank line ────────────
		if (
			lineText.trim() !== "" &&
			!ANCHOR_RE.test(lineText) &&
			this.isNoteGroupStart(editor, cursor.line)
		) {
			this.autoCreateAnchor(editor, cursor.line);
		}

		// ── Absorption: line count changed (Enter / delete) ───
		const delta = newCount - this.cachedNotesLineCount;
		this.cachedNotesLineCount = newCount;

		if (delta > 0) {
			// Lines added — absorb blank lines below
			this.applyingDiff = true;
			try {
				let removed = 0;
				let i = cursor.line + 1;
				while (
					i < editor.lineCount() &&
					removed < delta
				) {
					if (editor.getLine(i).trim() === "") {
						if (i < editor.lineCount() - 1) {
							editor.replaceRange(
								"",
								{ line: i, ch: 0 },
								{ line: i + 1, ch: 0 }
							);
						} else if (i > 0) {
							const p = editor.getLine(i - 1);
							editor.replaceRange(
								"",
								{
									line: i - 1,
									ch: p.length,
								},
								{ line: i, ch: 0 }
							);
						}
						removed++;
					} else {
						i++;
					}
				}
				this.cachedNotesLineCount =
					editor.lineCount();
			} finally {
				this.applyingDiff = false;
			}
		} else if (delta < 0 && this.cachedSourceLines) {
			// Lines deleted — pad at end if below source count
			const needed =
				this.cachedSourceLines.length -
				editor.lineCount();
			if (needed > 0) {
				this.applyingDiff = true;
				try {
					const last = editor.lineCount() - 1;
					editor.replaceRange(
						"\n".repeat(needed),
						{
							line: last,
							ch: editor.getLine(last).length,
						}
					);
					this.cachedNotesLineCount =
						editor.lineCount();
				} finally {
					this.applyingDiff = false;
				}
			}
		}

		this.attachSplitSync();
	}

	/** Check if lineNum is the first non-blank line in its group (needs a new anchor). */
	private isNoteGroupStart(
		editor: any,
		lineNum: number
	): boolean {
		for (let i = lineNum - 1; i >= 0; i--) {
			const t: string = editor.getLine(i);
			if (t.trim() === "") return true; // blank above = new group
			if (ANCHOR_RE.test(t)) return false; // anchor above = continuation
		}
		return true; // top of file
	}

	/** Create matching anchors in both source and notes files. */
	private autoCreateAnchor(
		editor: any,
		notesLineNum: number
	): void {
		if (!this.splitSourceLeaf) return;
		const sv = this.splitSourceLeaf.view;
		if (!(sv instanceof MarkdownView)) return;

		const id = generateId();

		// Determine which source line this corresponds to.
		// With padding, notes line N ≈ source line N (adjusted for
		// anchor marker lines that exist above the cursor).
		let anchorLinesAbove = 0;
		for (let i = 0; i < notesLineNum; i++) {
			if (ANCHOR_RE.test(editor.getLine(i)))
				anchorLinesAbove++;
		}
		const srcLineNum = Math.min(
			notesLineNum - anchorLinesAbove,
			sv.editor.lineCount() - 1
		);

		// Insert anchor in source file
		const srcLine = sv.editor.getLine(srcLineNum);
		if (!ANCHOR_RE.test(srcLine)) {
			this.applyingDiff = true;
			sv.editor.replaceRange(` <!-- ann:${id} -->`, {
				line: srcLineNum,
				ch: srcLine.length,
			});
			// Update cached source
			this.cachedSourceLines = (
				sv.editor.getValue() as string
			).split("\n");
			this.applyingDiff = false;
		}

		// Prepend anchor to the notes line (invisible in Live Preview)
		this.applyingDiff = true;
		editor.replaceRange(`<!-- ann:${id} -->`, {
			line: notesLineNum,
			ch: 0,
		});
		this.cachedNotesLineCount = editor.lineCount();
		this.applyingDiff = false;
	}

	private diffLines(
		oldL: string[],
		newL: string[]
	): {
		position: number;
		removed: number;
		added: number;
	} | null {
		let top = 0;
		const min = Math.min(oldL.length, newL.length);
		while (top < min && oldL[top] === newL[top]) top++;

		let ob = oldL.length - 1;
		let nb = newL.length - 1;
		while (
			ob > top &&
			nb > top &&
			oldL[ob] === newL[nb]
		) {
			ob--;
			nb--;
		}
		if (ob < top) ob = top - 1;
		if (nb < top) nb = top - 1;

		const removed = ob - top + 1;
		const added = nb - top + 1;
		if (removed === 0 && added === 0) return null;
		return { position: top, removed, added };
	}

	// ── Link toggle ────────────────────────────────────────────

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
				this.attachSplitSync();
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
			}
		});
	}

	// ── Annotation creation ────────────────────────────────────

	private async addAnnotation(
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

		if (this.splitLeaf) {
			// Split view: jump cursor to the new note
			setTimeout(() => this.focusNoteInSplit(id), 400);
		} else {
			// No split: open comments pane
			if (Platform.isMobile) {
				await this.ensureCommentsPaneOpen();
			}
			const pane = this.getAnnotationPane();
			if (pane) {
				await pane.loadForFile(file.path);
				pane.focusAnnotation(id);
			}
		}
	}

	/** Called from the comments pane "+" button. */
	async addAnnotationAtCursor(): Promise<void> {
		let view =
			this.app.workspace.getActiveViewOfType(MarkdownView);

		if (
			!view ||
			!view.file ||
			isSidecarFile(view.file.path)
		) {
			const pane = this.getAnnotationPane();
			const target = pane?.getCurrentSourcePath();
			for (const l of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = l.view as MarkdownView;
				if (!v.file || isSidecarFile(v.file.path)) continue;
				if (target && v.file.path === target) {
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

		await this.addAnnotation(view);
	}

	private async ensureAnnotationInSidecar(
		sourcePath: string,
		anchorId: string
	): Promise<void> {
		const sidecarPath = getSidecarPath(sourcePath);
		const sidecar = await this.loadSidecar(
			sidecarPath,
			sourcePath
		);
		sidecar.annotations.push({ anchorId, content: "" });

		const sf =
			this.app.vault.getAbstractFileByPath(sourcePath);
		if (sf instanceof TFile) {
			sortAnnotationsBySource(
				sidecar,
				await this.app.vault.cachedRead(sf)
			);
		}

		await this.saveSidecar(sidecarPath, sidecar);
	}

	/**
	 * After creating a note in the sidecar, jump the cursor to it
	 * in the split view so the user can start typing immediately.
	 */
	private focusNoteInSplit(anchorId: string): void {
		if (!this.splitLeaf) return;
		const nv = this.splitLeaf.view;
		if (!(nv instanceof MarkdownView)) return;

		const text = nv.editor.getValue();
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(`<!-- ann:${anchorId} -->`)) {
				// Cursor goes 2 lines below the marker
				// (marker line, blank line, then content line)
				const target = Math.min(
					i + 2,
					lines.length - 1
				);
				this.app.workspace.setActiveLeaf(
					this.splitLeaf!,
					{ focus: true }
				);
				nv.editor.setCursor({
					line: target,
					ch: 0,
				});
				break;
			}
		}

		this.attachSplitSync();
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
		if (f instanceof TFile) {
			await this.app.vault.modify(f, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	// ── Comments pane (mobile / secondary) ─────────────────────

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
		if (!leaf) leaf = this.app.workspace.getLeaf("split");
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
			el.scrollIntoView({
				behavior: "smooth",
				block: "center",
			});
			this.flashElement(el);
			return;
		}

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

		if (mdView.getMode() === "source") {
			const cv = this.getCmView(mdView.leaf);
			if (cv) {
				cv.dispatch({
					effects: EditorView.scrollIntoView(
						cv.state.doc.line(anchorLine + 1).from,
						{ y: "center" }
					),
				});
			}
		} else {
			const sc = mdView.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
			if (sc) {
				const frac =
					anchorLine / Math.max(lines.length, 1);
				sc.scrollTop =
					frac * (sc.scrollHeight - sc.clientHeight);
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
		this.flashElement(card);
	}

	private findSourceElement(
		anchorId: string
	): HTMLElement | null {
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

	private flashElement(el: HTMLElement): void {
		el.classList.add("margin-notes-flash");
		setTimeout(
			() => el.classList.remove("margin-notes-flash"),
			1500
		);
	}

	private getSourceMarkdownView(): MarkdownView | null {
		const pane = this.getAnnotationPane();
		const target = pane?.getCurrentSourcePath();
		if (target) {
			for (const l of this.app.workspace.getLeavesOfType(
				"markdown"
			)) {
				const v = l.view as MarkdownView;
				if (v.file?.path === target) return v;
			}
		}
		for (const l of this.app.workspace.getLeavesOfType(
			"markdown"
		)) {
			const v = l.view as MarkdownView;
			if (v.file && !isSidecarFile(v.file.path)) return v;
		}
		return null;
	}

	// ── Helpers ────────────────────────────────────────────────

	private getCmView(
		leaf: WorkspaceLeaf
	): EditorView | null {
		if (!(leaf.view instanceof MarkdownView)) return null;
		// @ts-ignore — accessing internal CM6 editor view
		return (leaf.view.editor as any).cm ?? null;
	}

	private getLeafScrollContainer(
		leaf: WorkspaceLeaf
	): HTMLElement | null {
		if (!(leaf.view instanceof MarkdownView)) return null;
		const mode = (leaf.view as MarkdownView).getMode();
		if (mode === "preview")
			return leaf.view.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
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
		const oldSc = getSidecarPath(oldPath);
		const sc =
			this.app.vault.getAbstractFileByPath(oldSc);
		if (!(sc instanceof TFile)) return;
		const newSc = getSidecarPath(file.path);
		await this.app.vault.rename(sc, newSc);
		const rf =
			this.app.vault.getAbstractFileByPath(newSc);
		if (rf instanceof TFile) {
			const data = parseSidecar(
				await this.app.vault.read(rf)
			);
			data.source = file.path;
			await this.app.vault.modify(
				rf,
				serializeSidecar(data)
			);
		}
	}

	private onFileModified(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;

		// Comments pane
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

		// Split view: recalculate spacers when either file changes
		if (this.splitLeaf && this.splitSyncEnabled)
			this.attachSplitSync();
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
			const html = await exportToHtml(
				this.app,
				sourcePath
			);
			const ep = sourcePath.replace(/\.md$/, ".html");
			const ef =
				this.app.vault.getAbstractFileByPath(ep);
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
