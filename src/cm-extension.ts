/**
 * CodeMirror 6 ViewPlugin for Live Preview.
 *
 * Scans visible lines for anchor markers (both <!-- ann:ID --> and ^mn-ID)
 * and adds line decorations with data-ann-id attributes. This enables:
 *   - Scroll sync (finding anchor positions in the editor DOM)
 *   - Hover highlighting (CSS/JS can target [data-ann-id])
 */

import {
	ViewPlugin,
	ViewUpdate,
	DecorationSet,
	Decoration,
	EditorView,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { ANCHOR_RE, anchorIdFromMatch } from "./anchor";

class AnnotationDecoPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.build(update.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();

		for (const { from, to } of view.visibleRanges) {
			let pos = from;
			while (pos <= to) {
				const line = view.state.doc.lineAt(pos);
				const m = ANCHOR_RE.exec(line.text);
				if (m) {
					builder.add(
						line.from,
						line.from,
						Decoration.line({
							attributes: {
								"data-ann-id": anchorIdFromMatch(m),
								class: "margin-notes-anchored",
							},
						})
					);
				}
				pos = line.to + 1;
			}
		}

		return builder.finish();
	}
}

export const annotationLinePlugin = ViewPlugin.fromClass(
	AnnotationDecoPlugin,
	{ decorations: (v) => v.decorations }
);
