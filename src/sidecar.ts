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

import { parseYaml, stringifyYaml } from "obsidian";
import { ANCHOR_RE, anchorIdFromMatch } from "./anchor";

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
		try {
			const parsed = parseYaml(fmMatch[1]);
			if (parsed && typeof parsed.source === "string") {
				source = parsed.source;
			}
		} catch {
			// Fall back to raw text if YAML is malformed
			const srcMatch = fmMatch[1].match(/source:\s*"?([^"\n]+)"?/);
			if (srcMatch) source = srcMatch[1].trim();
		}
		body = fmMatch[2];
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
	for (let i = 0; i < lines.length; i++) {
		const m = ANCHOR_RE.exec(lines[i]);
		if (m) anchorOrder.set(anchorIdFromMatch(m), i);
	}
	data.annotations.sort((a, b) => {
		const ai = anchorOrder.get(a.anchorId) ?? Infinity;
		const bi = anchorOrder.get(b.anchorId) ?? Infinity;
		return ai - bi;
	});
}

export function serializeSidecar(data: SidecarData): string {
	const yaml = stringifyYaml({ source: data.source }).trim();
	let out = `---\n${yaml}\n---\n`;
	for (const ann of data.annotations) {
		out += `\n<!-- ann:${ann.anchorId} -->\n\n${ann.content}\n`;
	}
	return out;
}
