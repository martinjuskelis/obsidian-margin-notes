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
import { noteSpacerField, updateNoteSpacers } from "./spacer";
import type { SpacerEntry } from "./spacer";
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
	private spacerTimer: number | null = null;

	async onload(): Promise<void> {
		this.scrollSync = new ScrollSync(this);

		// ── Views & extensions ──────────────────────────────────
		this.registerView(
			VIEW_TYPE_ANNOTATIONS,
			(leaf) => new AnnotationPaneView(leaf, this)
		);
		this.registerEditorExtension(annotationLinePlugin);
		this.registerEditorExtension(noteSpacerField);

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
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (this.getAnnotationPane())
					this.scrollSync.attach();
				if (this.splitLeaf && this.splitSyncEnabled) {
					this.scheduleSpacerRecalc();
					setTimeout(() => this.attachSplitSync(), 350);
				}
			})
		);
		this.registerEvent(
			this.app.workspace.on("resize", () => {
				if (this.splitLeaf && this.splitSyncEnabled)
					this.scheduleSpacerRecalc();
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

		// Get or create the .ann.md notes file (anchor format)
		const notesPath = getSidecarPath(sourceFile.path);
		let notesFile =
			this.app.vault.getAbstractFileByPath(notesPath);
		if (!(notesFile instanceof TFile)) {
			const content = serializeSidecar({
				source: sourceFile.path,
				annotations: [],
			});
			await this.app.vault.create(notesPath, content);
			notesFile =
				this.app.vault.getAbstractFileByPath(notesPath);
		}
		if (!(notesFile instanceof TFile)) return;

		// Open in split
		this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
		this.splitLeaf = this.app.workspace.createLeafBySplit(
			sourceLeaf,
			"vertical"
		);
		this.splitSourceLeaf = sourceLeaf;
		await this.splitLeaf.openFile(notesFile);

		// Link toggle + spacers + sync
		this.splitSyncEnabled = true;
		this.addLinkToggle();
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
		if (this.splitLeaf) {
			const cv = this.getCmView(this.splitLeaf);
			if (cv)
				cv.dispatch({
					effects: updateNoteSpacers.of([]),
				});
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

	private scheduleSpacerRecalc(): void {
		if (this.spacerTimer)
			window.clearTimeout(this.spacerTimer);
		this.spacerTimer = window.setTimeout(() => {
			this.spacerTimer = null;
			this.recalculateSpacers();
		}, 250);
	}

	/**
	 * Match anchors by ID between source and notes editors, then
	 * insert block spacer widgets so each note's top aligns with
	 * its source anchor. Overflow is handled gracefully — the next
	 * note starts right after with zero gap.
	 */
	private recalculateSpacers(): void {
		if (!this.splitLeaf || !this.splitSourceLeaf) return;
		if (!this.splitSyncEnabled) return;

		const srcV = this.getCmView(this.splitSourceLeaf);
		const notV = this.getCmView(this.splitLeaf);
		if (!srcV || !notV) return;

		// Clear spacers so measurements are "natural"
		notV.dispatch({ effects: updateNoteSpacers.of([]) });
		notV.dom.getBoundingClientRect(); // force reflow

		const srcAnchors = this.findAnchorsInDoc(srcV);
		const notAnchors = this.findAnchorsInDoc(notV);

		const entries: SpacerEntry[] = [];
		let accumulated = 0;

		for (const na of notAnchors) {
			const sa = srcAnchors.find((a) => a.id === na.id);
			if (!sa) continue;

			const targetY = sa.top;
			const currentY = na.top + accumulated;
			const spacer = Math.max(0, targetY - currentY);

			if (spacer > 0) {
				entries.push({ pos: na.pos, height: spacer });
				accumulated += spacer;
			}
		}

		notV.dispatch({ effects: updateNoteSpacers.of(entries) });
	}

	/** Find all <!-- ann:ID --> anchors in a CM6 editor and return their positions. */
	private findAnchorsInDoc(
		view: EditorView
	): { id: string; top: number; pos: number }[] {
		const re = /<!-- ann:(\w+) -->/;
		const doc = view.state.doc;
		const result: { id: string; top: number; pos: number }[] =
			[];

		for (let i = 1; i <= doc.lines; i++) {
			const line = doc.line(i);
			const m = re.exec(line.text);
			if (m) {
				result.push({
					id: m[1],
					top: view.lineBlockAt(line.from).top,
					pos: line.from,
				});
			}
		}
		return result;
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
				this.recalculateSpacers();
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
				if (cv)
					cv.dispatch({
						effects: updateNoteSpacers.of([]),
					});
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

		this.recalculateSpacers();
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
			this.scheduleSpacerRecalc();
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
