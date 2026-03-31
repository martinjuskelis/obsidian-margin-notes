/**
 * Scroll synchronization between the source document and annotation pane.
 *
 * Uses anchor-based interpolation: when the source scrolls past anchor A
 * toward anchor B, the pane scrolls proportionally between annotation A
 * and annotation B. This keeps annotations aligned with their source
 * paragraphs even when content lengths differ between the two panes.
 */

import { MarkdownView } from "obsidian";
import type MarginNotesPlugin from "./main";

interface AnchorPair {
	anchorId: string;
	sourceTop: number;
	paneTop: number;
}

export class ScrollSync {
	private plugin: MarginNotesPlugin;
	private sourceEl: HTMLElement | null = null;
	private paneEl: HTMLElement | null = null;
	private ignoreSource = false;
	private ignorePane = false;
	private pendingSource = false;
	private pendingPane = false;

	constructor(plugin: MarginNotesPlugin) {
		this.plugin = plugin;
	}

	/** Attach scroll listeners to both the current source document and pane. */
	attach(): void {
		this.detach();

		const sourceEl = this.findSourceScrollContainer();
		const pane = this.plugin.getAnnotationPane();
		if (!sourceEl || !pane) return;

		this.sourceEl = sourceEl;
		this.paneEl = pane.getScrollContainer();

		this.sourceEl.addEventListener("scroll", this.onSourceScroll, {
			passive: true,
		});
		this.paneEl.addEventListener("scroll", this.onPaneScroll, {
			passive: true,
		});
	}

	/** Attach to two explicit scroll containers (for split view mode). */
	attachToElements(sourceEl: HTMLElement, paneEl: HTMLElement): void {
		this.detach();
		this.sourceEl = sourceEl;
		this.paneEl = paneEl;
		this.sourceEl.addEventListener("scroll", this.onSourceScroll, {
			passive: true,
		});
		this.paneEl.addEventListener("scroll", this.onPaneScroll, {
			passive: true,
		});
	}

	/** Remove all scroll listeners. */
	detach(): void {
		if (this.sourceEl) {
			this.sourceEl.removeEventListener("scroll", this.onSourceScroll);
		}
		if (this.paneEl) {
			this.paneEl.removeEventListener("scroll", this.onPaneScroll);
		}
		this.sourceEl = null;
		this.paneEl = null;
	}

	// ── Scroll handlers ────────────────────────────────────────────

	private onSourceScroll = (): void => {
		if (this.ignoreSource || this.pendingSource) return;
		this.pendingSource = true;
		requestAnimationFrame(() => {
			this.pendingSource = false;
			this.syncPaneToSource();
		});
	};

	private onPaneScroll = (): void => {
		if (this.ignorePane || this.pendingPane) return;
		this.pendingPane = true;
		requestAnimationFrame(() => {
			this.pendingPane = false;
			this.syncSourceToPane();
		});
	};

	private syncPaneToSource(): void {
		if (!this.sourceEl || !this.paneEl) return;
		const pairs = this.getAnchorPairs();
		if (pairs.length === 0) return;

		this.ignorePane = true;
		this.paneEl.scrollTop = this.interpolate(
			this.sourceEl.scrollTop,
			pairs,
			true
		);
		this.clearIgnoreAfterSettle("pane");
	}

	private syncSourceToPane(): void {
		if (!this.sourceEl || !this.paneEl) return;
		const pairs = this.getAnchorPairs();
		if (pairs.length === 0) return;

		this.ignoreSource = true;
		this.sourceEl.scrollTop = this.interpolate(
			this.paneEl.scrollTop,
			pairs,
			false
		);
		this.clearIgnoreAfterSettle("source");
	}

	/**
	 * After programmatically scrolling a pane, suppress its scroll handler
	 * for two animation frames so the programmatic scroll settles before
	 * we start listening again. This prevents feedback loops.
	 */
	private clearIgnoreAfterSettle(which: "source" | "pane"): void {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (which === "source") this.ignoreSource = false;
				else this.ignorePane = false;
			});
		});
	}

	// ── Position mapping ───────────────────────────────────────────

	/**
	 * Build a list of anchor positions in both scroll containers.
	 * Only includes anchors that have DOM elements in both containers.
	 */
	private getAnchorPairs(): AnchorPair[] {
		if (!this.sourceEl || !this.paneEl) return [];

		const pairs: AnchorPair[] = [];
		const sourceEls =
			this.sourceEl.querySelectorAll<HTMLElement>("[data-ann-id]");

		for (const el of sourceEls) {
			const id = el.dataset.annId;
			if (!id) continue;

			const paneCard =
				this.paneEl.querySelector<HTMLElement>(
					`[data-ann-id="${id}"]`
				);
			if (!paneCard) continue;

			pairs.push({
				anchorId: id,
				sourceTop: this.offsetIn(el, this.sourceEl),
				paneTop: this.offsetIn(paneCard, this.paneEl),
			});
		}

		return pairs.sort((a, b) => a.sourceTop - b.sourceTop);
	}

	/** Get an element's top offset relative to a scroll container. */
	private offsetIn(el: HTMLElement, container: HTMLElement): number {
		const elRect = el.getBoundingClientRect();
		const cRect = container.getBoundingClientRect();
		return elRect.top - cRect.top + container.scrollTop;
	}

	/**
	 * Given a scroll position in one container, compute the corresponding
	 * scroll position in the other via linear interpolation between anchors.
	 */
	private interpolate(
		scrollTop: number,
		pairs: AnchorPair[],
		fromSource: boolean
	): number {
		const fk = fromSource ? "sourceTop" : ("paneTop" as const);
		const tk = fromSource ? "paneTop" : ("sourceTop" as const);

		// Before first anchor — proportional scale
		if (scrollTop <= pairs[0][fk]) {
			const denom = pairs[0][fk];
			return denom === 0 ? pairs[0][tk] : (scrollTop / denom) * pairs[0][tk];
		}

		// Between adjacent anchors
		for (let i = 0; i < pairs.length - 1; i++) {
			const a = pairs[i];
			const b = pairs[i + 1];
			if (scrollTop >= a[fk] && scrollTop < b[fk]) {
				const range = b[fk] - a[fk];
				const t = range === 0 ? 0 : (scrollTop - a[fk]) / range;
				return a[tk] + t * (b[tk] - a[tk]);
			}
		}

		// After last anchor — offset by the excess
		const last = pairs[pairs.length - 1];
		return last[tk] + (scrollTop - last[fk]);
	}

	// ── Helpers ────────────────────────────────────────────────────

	private findSourceScrollContainer(): HTMLElement | null {
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;

		const mode = view.getMode();
		if (mode === "preview") {
			return view.containerEl.querySelector(
				".markdown-preview-view"
			) as HTMLElement | null;
		}
		return view.containerEl.querySelector(
			".cm-scroller"
		) as HTMLElement | null;
	}
}
