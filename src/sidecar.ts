/**
 * Sidecar file management.
 *
 * Annotations live in a companion file alongside the source:
 *   document.md  →  document.ann.md
 *
 * Format:
 *   ---
 *   source: "document.md"
 *   ---
 *
 *   <!-- ann:k7x2m9 -->
 *
 *   Annotation content in **markdown**.
 *
 *   <!-- ann:p3r8w2 -->
 *
 *   Another annotation.
 */

export interface Annotation {
	anchorId: string;
	content: string;
}

export interface SidecarData {
	source: string;
	annotations: Annotation[];
}

const SPLIT_RE = /<!-- ann:(\w+) -->/;

export function getSidecarPath(sourcePath: string): string {
	return sourcePath.replace(/\.md$/, ".ann.md");
}

export function isSidecarFile(path: string): boolean {
	return path.endsWith(".ann.md");
}

export function parseSidecar(content: string): SidecarData {
	let source = "";
	let body = content;

	// Extract YAML frontmatter
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (fmMatch) {
		const fm = fmMatch[1];
		body = fmMatch[2];
		const srcMatch = fm.match(/source:\s*"?([^"\n]+)"?/);
		if (srcMatch) source = srcMatch[1].trim();
	}

	const annotations: Annotation[] = [];
	// split() with a capturing group interleaves: [before, id1, text1, id2, text2, ...]
	const parts = body.split(SPLIT_RE);
	for (let i = 1; i < parts.length; i += 2) {
		annotations.push({
			anchorId: parts[i],
			content: (parts[i + 1] || "").trim(),
		});
	}

	return { source, annotations };
}

/**
 * Sort annotations to match the order their anchors appear in the source text.
 * Annotations whose anchors are not found in the source are placed at the end.
 */
export function sortAnnotationsBySource(
	data: SidecarData,
	sourceText: string
): void {
	const lines = sourceText.split("\n");
	const anchorOrder = new Map<string, number>();
	const re = /<!-- ann:(\w+) -->/;
	for (let i = 0; i < lines.length; i++) {
		const m = re.exec(lines[i]);
		if (m) anchorOrder.set(m[1], i);
	}
	data.annotations.sort((a, b) => {
		const ai = anchorOrder.get(a.anchorId) ?? Infinity;
		const bi = anchorOrder.get(b.anchorId) ?? Infinity;
		return ai - bi;
	});
}

export function serializeSidecar(data: SidecarData): string {
	let out = `---\nsource: "${data.source}"\n---\n`;
	for (const ann of data.annotations) {
		out += `\n<!-- ann:${ann.anchorId} -->\n\n${ann.content}\n`;
	}
	return out;
}
