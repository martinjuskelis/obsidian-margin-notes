/**
 * Per-line height matching for split view.
 *
 * Sets min-height on each line in the notes editor so it matches the
 * height of the corresponding line in the source editor.  This keeps
 * the two panes visually aligned: line N on the left occupies the
 * same vertical space as line N on the right.
 */

import {
	StateField,
	StateEffect,
	RangeSetBuilder,
	Text,
} from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
} from "@codemirror/view";

/** Dispatch to the notes editor with an array of source line heights (index 0 = line 1). */
export const updateLineHeights = StateEffect.define<number[]>();

export const lineSyncField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},

	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(updateLineHeights)) {
				return buildLineDecos(tr.state.doc, e.value);
			}
		}
		return tr.docChanged ? value.map(tr.changes) : value;
	},

	provide: (f) => EditorView.decorations.from(f),
});

function buildLineDecos(doc: Text, heights: number[]): DecorationSet {
	if (heights.length === 0) return Decoration.none;

	const builder = new RangeSetBuilder<Decoration>();
	const n = Math.min(doc.lines, heights.length);

	for (let i = 0; i < n; i++) {
		const h = heights[i];
		if (h > 0) {
			const line = doc.line(i + 1);
			builder.add(
				line.from,
				line.from,
				Decoration.line({
					attributes: {
						style: `min-height: ${h}px; box-sizing: border-box;`,
					},
				})
			);
		}
	}

	return builder.finish();
}
