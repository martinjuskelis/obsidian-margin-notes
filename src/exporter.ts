/**
 * HTML export.
 *
 * Produces a self-contained two-column HTML page (source on left, annotations
 * on right) using CSS Grid. Inspired by Molly White's "annotate" template.
 * Includes click-to-highlight JS with a graceful no-JS fallback.
 */

import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { parseAnchors, stripAnchors } from "./anchor";
import { getSidecarPath, parseSidecar } from "./sidecar";

interface Group {
	sourceMarkdown: string;
	annotationMarkdown: string | null;
	anchorId: string | null;
}

export async function exportToHtml(
	app: App,
	sourcePath: string
): Promise<string> {
	const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
	if (!(sourceFile instanceof TFile))
		throw new Error("Source file not found");

	const sourceText = await app.vault.cachedRead(sourceFile);
	const anchors = parseAnchors(sourceText);

	// Load annotations keyed by anchor ID
	const annotationMap = new Map<string, string>();
	const sidecarPath = getSidecarPath(sourcePath);
	const sidecarFile = app.vault.getAbstractFileByPath(sidecarPath);
	if (sidecarFile instanceof TFile) {
		const raw = await app.vault.cachedRead(sidecarFile);
		const data = parseSidecar(raw);
		for (const ann of data.annotations) {
			annotationMap.set(ann.anchorId, ann.content);
		}
	}

	// Split source into groups at anchor boundaries.
	// Each group accumulates paragraphs until an anchor line is reached.
	const lines = sourceText.split("\n");
	const groups: Group[] = [];
	let currentLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const anchor = anchors.find((a) => a.line === i);
		currentLines.push(lines[i]);

		if (anchor) {
			groups.push({
				sourceMarkdown: stripAnchors(currentLines.join("\n")).trim(),
				annotationMarkdown: annotationMap.get(anchor.id) || null,
				anchorId: anchor.id,
			});
			currentLines = [];
		}
	}

	// Trailing lines after the last anchor
	if (currentLines.length > 0) {
		const text = currentLines.join("\n").trim();
		if (text) {
			groups.push({
				sourceMarkdown: text,
				annotationMarkdown: null,
				anchorId: null,
			});
		}
	}

	// Render each group's markdown to HTML
	const comp = new Component();
	comp.load();

	const rendered: { sourceHtml: string; annotationHtml: string | null }[] =
		[];

	for (const g of groups) {
		const srcEl = document.createElement("div");
		await MarkdownRenderer.render(
			app,
			g.sourceMarkdown,
			srcEl,
			sourcePath,
			comp
		);

		let annHtml: string | null = null;
		if (g.annotationMarkdown) {
			const annEl = document.createElement("div");
			await MarkdownRenderer.render(
				app,
				g.annotationMarkdown,
				annEl,
				sourcePath,
				comp
			);
			annHtml = annEl.innerHTML;
		}

		rendered.push({ sourceHtml: srcEl.innerHTML, annotationHtml: annHtml });
	}

	comp.unload();

	return buildPage(sourceFile.basename, rendered);
}

// ── Template ───────────────────────────────────────────────────

function buildPage(
	title: string,
	groups: { sourceHtml: string; annotationHtml: string | null }[]
): string {
	let count = 0;
	let body = "";

	for (const g of groups) {
		const hasAnn = g.annotationHtml !== null;
		if (hasAnn) count++;

		body += `    <section class="group">\n`;
		body += `      <div class="content source">${g.sourceHtml}</div>\n`;
		body += `      <div class="content note">`;
		if (hasAnn) {
			body += `<div class="annotation" data-num="${count}">${g.annotationHtml}</div>`;
		}
		body += `</div>\n`;
		body += `    </section>\n`;
	}

	return `<!DOCTYPE html>
<html class="no-js" lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
  <h1 class="page-title">${esc(title)}</h1>
  <main class="maincontent">
    <article class="article">
${body}
    </article>
  </main>
<script>
${JS}
</script>
</body>
</html>`;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ── Inline CSS ─────────────────────────────────────────────────

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  line-height:1.7; color:#1a1a1a; background:#fff;
}
.page-title{max-width:900px;margin:2.5rem auto 1.5rem;padding:0 1.5rem;font-size:2rem}
.maincontent{max-width:1400px;margin:0 auto}
.article{display:block}
.group{margin-bottom:0}
.content.source{padding:.75rem 1.5rem}
.content.note{padding:.5rem 1.5rem}
.annotation{
  background:#f5f5f0;border-left:3px solid #6b7280;
  padding:.75rem 1rem;margin:.5rem 0;border-radius:0 4px 4px 0;
  position:relative;cursor:pointer;
}
.annotation[data-num]::before{
  content:attr(data-num);
  position:absolute;top:-8px;left:-12px;
  width:20px;height:20px;border-radius:50%;
  background:#6b7280;color:#fff;font-size:.7rem;
  display:flex;align-items:center;justify-content:center;font-weight:600;
}
.annotation p:last-child{margin-bottom:0}
.annotation.selected{background:#fef9c3;border-color:#ca8a04}
table{border-collapse:collapse;margin:1rem 0}
th,td{border:1px solid #d1d5db;padding:.5rem;text-align:left}
th{background:#f3f4f6}
code{background:#f3f4f6;padding:.1rem .3rem;border-radius:3px;font-size:.9em}
pre{background:#f3f4f6;padding:1rem;border-radius:4px;overflow-x:auto;margin:1rem 0}
pre code{background:none;padding:0}
img{max-width:100%}
blockquote{border-left:3px solid #d1d5db;padding-left:1rem;color:#4b5563;margin:1rem 0}
h1,h2,h3,h4,h5,h6{margin:1.2rem 0 .6rem}
p{margin:.6rem 0}
ul,ol{margin:.6rem 0;padding-left:1.5rem}

@media screen and (min-width:46rem){
  .article{display:grid;grid-template-columns:3fr 2fr}
  .group{grid-column:1/3;display:grid;grid-template-columns:3fr 2fr;align-items:start}
  .content.source{padding:1rem 2rem 1rem 1.5rem;border-right:1px solid #e5e7eb}
  .content.note{padding:.75rem 1.5rem;background:#fafaf8}
}
`;

// ── Inline JS ──────────────────────────────────────────────────

const JS = `
document.documentElement.classList.replace('no-js','js');
document.querySelectorAll('.annotation').forEach(function(a){
  a.addEventListener('click',function(e){
    var was=a.classList.contains('selected');
    document.querySelectorAll('.selected').forEach(function(el){el.classList.remove('selected')});
    if(!was) a.classList.add('selected');
    e.stopPropagation();
  });
});
document.addEventListener('click',function(){
  document.querySelectorAll('.selected').forEach(function(el){el.classList.remove('selected')});
});
`;
