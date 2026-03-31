/**
 * Simplified scroll sync for the notes view.
 *
 * Because the notes view's slot positions are computed from source
 * anchor positions, a 1:1 scroll offset keeps everything aligned.
 * No interpolation or anchor-pair lookup needed.
 */

const SETTLE_MS = 80;

export class ScrollSync {
	private sourceEl: HTMLElement | null = null;
	private notesEl: HTMLElement | null = null;
	private progAt = { source: 0, notes: 0 };

	attach(sourceEl: HTMLElement, notesEl: HTMLElement): void {
		this.detach();
		this.sourceEl = sourceEl;
		this.notesEl = notesEl;
		sourceEl.addEventListener("scroll", this.onSourceScroll, {
			passive: true,
		});
		notesEl.addEventListener("scroll", this.onNotesScroll, {
			passive: true,
		});
	}

	detach(): void {
		this.sourceEl?.removeEventListener(
			"scroll",
			this.onSourceScroll
		);
		this.notesEl?.removeEventListener(
			"scroll",
			this.onNotesScroll
		);
		this.sourceEl = null;
		this.notesEl = null;
	}

	private onSourceScroll = (): void => {
		if (Date.now() - this.progAt.source < SETTLE_MS) return;
		if (!this.sourceEl || !this.notesEl) return;

		this.progAt.notes = Date.now();
		this.notesEl.scrollTop = this.sourceEl.scrollTop;
	};

	private onNotesScroll = (): void => {
		if (Date.now() - this.progAt.notes < SETTLE_MS) return;
		if (!this.sourceEl || !this.notesEl) return;

		this.progAt.source = Date.now();
		this.sourceEl.scrollTop = this.notesEl.scrollTop;
	};
}
