/**
 * Scroll synchronization between the source document and annotation pane.
 *
 * Uses anchor-based interpolation: when the source scrolls past anchor A
 * toward anchor B, the pane scrolls proportionally between annotation A
 * and annotation B. This keeps annotations aligned with their source
 * paragraphs even when content lengths differ between the two panes.
 *
 * Anti-loop protection uses timestamps instead of flags — programmatic
 * scrolls record when they happened, and scroll events within a short
 * window after a programmatic scroll are ignored.
 */

import { MarkdownView } from "obsidian";
import type MarginNotesPlugin from "./main";

interface AnchorPair {
	anchorId: string;
	sourceTop: number;
	paneTop: number;
}

/** How long (ms) to ignore scroll events after a programmatic scroll. */
const SETTLE_MS = 80;

export class ScrollSync {
	private plugin: MarginNotesPlugin;
	private sourceEl: HTMLElement | null = null;
	private paneEl: HTMLElement | null = null;
	private pendingSource = false;
	private pendingPane = false;
	/** Timestamps of the last programmatic scroll on each side. */
	private progScrollAt = { source: 0, pane: 0 };

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
		this.listen();
	}

	/** Attach to two explicit scroll containers (for split view mode). */
	attachToElements(sourceEl: HTMLElement, paneEl: HTMLElement): void {
		this.detach();
		this.sourceEl = sourceEl;
		this.paneEl = paneEl;
		this.listen();
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

	private listen(): void {
		if (!this.sourceEl || !this.paneEl) return;
		this.sourceEl.addEventListener("scroll", this.onSourceScroll, {
			passive: true,
		});
		this.paneEl.addEventListener("scroll", this.onPaneScroll, {
			passive: true,
		});
	}

	// ── Scroll handlers ────────────────────────────────────────────

	private onSourceScroll = (): void => {
		// Skip if this scroll was caused by our own programmatic set
		if (Date.now() - this.progScrollAt.source < SETTLE_MS) return;
		if (this.pendingSource) return;
		this.pendingSource = true;
		requestAnimationFrame(() => {
			this.pendingSource = false;
			this.syncPaneToSource();
		});
	};

	private onPaneScroll = (): void => {
		if (Date.now() - this.progScrollAt.pane < SETTLE_MS) return;
		if (this.pendingPane) return;
		this.pendingPane = true;
		requestAnimationFrame(() => {
			this.pendingPane = false;
			this.syncSourceToPane();
		});
	};

	private syncPaneToSource(): void {
		if (!this.sourceEl || !this.paneEl) return;

		// Edge snapping: top
		if (this.sourceEl.scrollTop <= 0) {
			this.progScrollAt.pane = Date.now();
			this.paneEl.scrollTop = 0;
			return;
		}

		// Edge snapping: bottom
		const srcMax =
			this.sourceEl.scrollHeight - this.sourceEl.clientHeight;
		if (this.sourceEl.scrollTop >= srcMax - 1) {
			this.progScrollAt.pane = Date.now();
			this.paneEl.scrollTop =
				this.paneEl.scrollHeight - this.paneEl.clientHeight;
			return;
		}

		// Anchor-based interpolation
		const pairs = this.getAnchorPairs();
		if (pairs.length === 0) {
			// Fallback: proportional scroll
			this.progScrollAt.pane = Date.now();
			const paneMax =
				this.paneEl.scrollHeight - this.paneEl.clientHeight;
			this.paneEl.scrollTop =
				srcMax > 0
					? (this.sourceEl.scrollTop / srcMax) * paneMax
					: 0;
			return;
		}

		this.progScrollAt.pane = Date.now();
		this.paneEl.scrollTop = this.interpolate(
			this.sourceEl.scrollTop,
			pairs,
			true
		);
	}

	private syncSourceToPane(): void {
		if (!this.sourceEl || !this.paneEl) return;

		// Edge snapping: top
		if (this.paneEl.scrollTop <= 0) {
			this.progScrollAt.source = Date.now();
			this.sourceEl.scrollTop = 0;
			return;
		}

		// Edge snapping: bottom
		const paneMax =
			this.paneEl.scrollHeight - this.paneEl.clientHeight;
		if (this.paneEl.scrollTop >= paneMax - 1) {
			this.progScrollAt.source = Date.now();
			this.sourceEl.scrollTop =
				this.sourceEl.scrollHeight - this.sourceEl.clientHeight;
			return;
		}

		// Anchor-based interpolation
		const pairs = this.getAnchorPairs();
		if (pairs.length === 0) {
			// Fallback: proportional scroll
			this.progScrollAt.source = Date.now();
			const srcMax =
				this.sourceEl.scrollHeight - this.sourceEl.clientHeight;
			this.sourceEl.scrollTop =
				paneMax > 0
					? (this.paneEl.scrollTop / paneMax) * srcMax
					: 0;
			return;
		}

		this.progScrollAt.source = Date.now();
		this.sourceEl.scrollTop = this.interpolate(
			this.paneEl.scrollTop,
			pairs,
			false
		);
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
			return denom === 0
				? pairs[0][tk]
				: (scrollTop / denom) * pairs[0][tk];
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
