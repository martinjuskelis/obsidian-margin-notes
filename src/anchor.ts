/**
 * Anchor management for margin notes.
 *
 * Two anchor formats are supported:
 *
 *   HTML comment (legacy):  <!-- ann:k7x2m9 -->
 *   Block ID (default):     ^mn-k7x2m9
 *
 * Block IDs are Obsidian-native — they integrate with backlinks,
 * block references ([[file#^mn-id]]), and the graph.  HTML comments
 * are invisible in all views but opaque to Obsidian's link system.
 *
 * The plugin always recognises BOTH formats when reading / scanning.
 * The `anchorFormat` setting only controls which format is used when
 * creating new anchors.
 */

export type AnchorFormat = "block-id" | "html-comment";

/** Matches a single HTML-comment anchor. */
export const COMMENT_ANCHOR_RE = /<!-- ann:(\w+) -->/;
/** Global variant. */
export const COMMENT_ANCHOR_RE_G = /<!-- ann:(\w+) -->/g;

/** Matches a single block-id anchor (must be at end of line). */
export const BLOCK_ANCHOR_RE = /\^mn-(\w+)$/;
/** Global / multiline variant (used when scanning full text). */
export const BLOCK_ANCHOR_RE_GM = /\^mn-(\w+)$/gm;

/**
 * Combined regex that matches EITHER format on a single line.
 * Capture group 1 = comment ID, group 2 = block-id ID.
 */
export const ANCHOR_RE = /(?:<!-- ann:(\w+) -->|\^mn-(\w+)$)/;
/** Global + multiline variant for scanning full text. */
export const ANCHOR_RE_GM = /(?:<!-- ann:(\w+) -->|\^mn-(\w+)$)/gm;

// Keep the old name as an alias so callers that only need "does this
// line have an anchor?" still work without changes.
export const ANCHOR_RE_G = ANCHOR_RE_GM;

export interface Anchor {
	id: string;
	line: number;
}

/** Extract the anchor ID from a regex match (either capture group). */
export function anchorIdFromMatch(m: RegExpMatchArray | RegExpExecArray): string {
	return m[1] ?? m[2];
}

/**
 * Generate a random 6-character alphanumeric ID.
 * If `existingIds` is provided, retries until the ID is unique.
 */
export function generateId(existingIds?: Set<string>): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id: string;
	do {
		id = "";
		for (let i = 0; i < 6; i++) {
			id += chars[Math.floor(Math.random() * chars.length)];
		}
	} while (existingIds?.has(id));
	return id;
}

/** Build the anchor string for the given format. */
export function formatAnchor(id: string, format: AnchorFormat): string {
	return format === "block-id" ? ` ^mn-${id}` : ` <!-- ann:${id} -->`;
}

/** Find all anchors (both formats) in a markdown string. */
export function parseAnchors(text: string): Anchor[] {
	const anchors: Anchor[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = ANCHOR_RE.exec(lines[i]);
		if (m) {
			anchors.push({ id: anchorIdFromMatch(m), line: i });
		}
	}
	return anchors;
}

/** Remove the anchor with the given ID from the text (either format). */
export function removeAnchor(text: string, anchorId: string): string {
	// Remove HTML-comment format
	text = text.replace(new RegExp(` ?<!-- ann:${anchorId} -->`, "g"), "");
	// Remove block-id format (with optional leading space, at end of line)
	text = text.replace(new RegExp(` ?\\^mn-${anchorId}$`, "gm"), "");
	return text;
}

/** Strip all anchors (both formats) from text (used for clean export). */
export function stripAnchors(text: string): string {
	text = text.replace(/ ?<!-- ann:\w+ -->/g, "");
	text = text.replace(/ ?\^mn-\w+$/gm, "");
	return text;
}

/**
 * Test whether a line contains any anchor (either format).
 * Convenience wrapper around ANCHOR_RE.test().
 */
export function lineHasAnchor(line: string): boolean {
	return ANCHOR_RE.test(line);
}

/**
 * Extract the anchor ID from a line, or null if none present.
 */
export function anchorIdFromLine(line: string): string | null {
	const m = ANCHOR_RE.exec(line);
	return m ? anchorIdFromMatch(m) : null;
}
