/**
 * Alignment engine for the notes view.
 *
 * Computes the Y position of each annotation slot so that its top
 * aligns with the top of its source anchor.  When a note is tall
 * enough to overflow past the next anchor's position, the next slot
 * is pushed down (no overlap). Alignment resumes as soon as there
 * is room.
 *
 * This is a pure function — it takes measured positions and returns
 * computed slot positions.  No DOM mutation happens here.
 */

export interface AnchorMeasurement {
	anchorId: string;
	/** Y offset of the anchor line in the source scroll container (px). */
	sourceY: number;
}

export interface SlotLayout {
	anchorId: string;
	/** Computed top position for the slot in the notes scroll container (px). */
	top: number;
}

/**
 * Given anchor positions from the source editor and the rendered
 * heights of existing note content, compute where each slot should
 * be placed.
 *
 * @param anchors  — source anchor positions, sorted top-to-bottom
 * @param heights  — map of anchorId → rendered content height (px)
 * @param gap      — minimum vertical gap between slots (px)
 */
export function computeSlotPositions(
	anchors: AnchorMeasurement[],
	heights: Map<string, number>,
	gap: number = 6
): SlotLayout[] {
	const slots: SlotLayout[] = [];
	let nextFreeY = 0;

	for (const anchor of anchors) {
		// The slot wants to be at sourceY, but can't overlap the previous slot
		const top = Math.max(anchor.sourceY, nextFreeY);
		slots.push({ anchorId: anchor.anchorId, top });

		const contentHeight = heights.get(anchor.anchorId) ?? 0;
		nextFreeY = top + contentHeight + gap;
	}

	return slots;
}

/**
 * Compute the total height needed by the notes container so that
 * both scroll containers have the same scrollable range.
 */
export function computeTotalHeight(
	slots: SlotLayout[],
	heights: Map<string, number>,
	sourceScrollHeight: number
): number {
	if (slots.length === 0) return sourceScrollHeight;

	const last = slots[slots.length - 1];
	const lastHeight = heights.get(last.anchorId) ?? 0;
	const notesBottom = last.top + lastHeight + 20; // 20px trailing padding

	return Math.max(notesBottom, sourceScrollHeight);
}
