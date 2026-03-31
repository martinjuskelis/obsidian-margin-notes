/**
 * Anchor management for margin notes.
 *
 * Anchors are HTML comments embedded in the source markdown:
 *   <!-- ann:k7x2m9 -->
 *
 * They are invisible in Reading View and Live Preview (when the cursor is
 * elsewhere), providing a stable, persistent link between a source paragraph
 * and its annotation in the sidecar file.
 */

/** Matches a single anchor. No /g — safe for .test() and .exec(). */
export const ANCHOR_RE = /<!-- ann:(\w+) -->/;

/** Global variant for scanning / replacing across a string. */
export const ANCHOR_RE_G = /<!-- ann:(\w+) -->/g;

export interface Anchor {
	id: string;
	line: number;
}

/** Generate a random 6-character alphanumeric ID. */
export function generateId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 6; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

/** Find all anchors in a markdown string, returning their IDs and line numbers. */
export function parseAnchors(text: string): Anchor[] {
	const anchors: Anchor[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = ANCHOR_RE.exec(lines[i]);
		if (m) {
			anchors.push({ id: m[1], line: i });
		}
	}
	return anchors;
}

/** Remove the anchor with the given ID from the text. */
export function removeAnchor(text: string, anchorId: string): string {
	return text.replace(new RegExp(` ?<!-- ann:${anchorId} -->`, "g"), "");
}

/** Strip all anchors from text (used for clean export rendering). */
export function stripAnchors(text: string): string {
	return text.replace(/ ?<!-- ann:\w+ -->/g, "");
}
