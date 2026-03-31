/**
 * Block spacer widgets for the notes editor in split view.
 *
 * Inserts invisible block elements before the first line of each note
 * group (contiguous non-blank lines). The spacer height is calculated
 * so the top of the note aligns with the top of its corresponding
 * source line. If a note overflows past where the next note should
 * start, the next spacer is 0 and the note comes right after —
 * alignment resumes as soon as there's room.
 */

import {
	StateField,
	StateEffect,
	RangeSetBuilder,
} from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	WidgetType,
} from "@codemirror/view";

export interface SpacerEntry {
	/** Document character position (line start). */
	pos: number;
	/** Spacer height in pixels. */
	height: number;
}

/** Dispatch to the notes editor with calculated spacer entries. */
export const updateNoteSpacers =
	StateEffect.define<SpacerEntry[]>();

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

export const noteSpacerField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},

	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(updateNoteSpacers)) {
				return buildDecos(e.value);
			}
		}
		return tr.docChanged ? value.map(tr.changes) : value;
	},

	provide: (f) => EditorView.decorations.from(f),
});

function buildDecos(entries: SpacerEntry[]): DecorationSet {
	if (entries.length === 0) return Decoration.none;

	const builder = new RangeSetBuilder<Decoration>();
	const sorted = [...entries].sort((a, b) => a.pos - b.pos);

	for (const { pos, height } of sorted) {
		if (height > 0) {
			builder.add(
				pos,
				pos,
				Decoration.widget({
					widget: new SpacerWidget(height),
					block: true,
					side: -1, // before the line
				})
			);
		}
	}

	return builder.finish();
}
