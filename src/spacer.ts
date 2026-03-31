/**
 * Spacer decorations for the sidecar editor in split view.
 *
 * Inserts invisible block widgets before annotation markers to push
 * annotations down so they align vertically with their corresponding
 * source paragraphs.  Heights are calculated by the plugin and
 * dispatched as a StateEffect.
 */

import { StateField, StateEffect, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/** Dispatch this to the sidecar editor with a map of anchorId → pixel height. */
export const updateSpacers = StateEffect.define<Map<string, number>>();

class SpacerWidget extends WidgetType {
	constructor(readonly height: number) {
		super();
	}
	eq(other: SpacerWidget): boolean {
		return this.height === other.height;
	}
	toDOM(): HTMLElement {
		const el = document.createElement("div");
		el.className = "margin-notes-spacer";
		el.style.height = `${this.height}px`;
		return el;
	}
	get estimatedHeight(): number {
		return this.height;
	}
}

const ANCHOR_RE = /<!-- ann:(\w+) -->/;

export const spacerField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},

	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(updateSpacers)) {
				return buildDecorations(tr.state.doc, e.value);
			}
		}
		return tr.docChanged ? value.map(tr.changes) : value;
	},

	provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(
	doc: Text,
	heights: Map<string, number>
): DecorationSet {
	if (heights.size === 0) return Decoration.none;

	const builder = new RangeSetBuilder<Decoration>();
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		const m = ANCHOR_RE.exec(line.text);
		if (m) {
			const h = heights.get(m[1]);
			if (h && h > 0) {
				builder.add(
					line.from,
					line.from,
					Decoration.widget({
						widget: new SpacerWidget(h),
						block: true,
						side: -1, // insert before the line
					})
				);
			}
		}
	}
	return builder.finish();
}
