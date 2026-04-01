/**
 * HTML export with multiple layouts and themes.
 *
 * Layouts:
 *   side-by-side — CSS Grid two-column (source left, notes right)
 *   tufte        — Faithful Tufte-style sidenotes (from tufte-css)
 *   inline       — Annotations rendered below each paragraph
 *   footnotes    — Annotations collected at the end as endnotes
 *
 * Themes: light, dark, sepia, academic
 */

import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { parseAnchors, stripAnchors } from "./anchor";
import { getSidecarPath, parseSidecar } from "./sidecar";
import type { MarginNotesSettings } from "./settings";

interface RenderedGroup {
	sourceHtml: string;
	annotationHtml: string | null;
	anchorId: string | null;
}

export async function exportToHtml(
	app: App,
	sourcePath: string,
	settings: MarginNotesSettings
): Promise<string> {
	const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
	if (!(sourceFile instanceof TFile))
		throw new Error("Source file not found");

	const sourceText = await app.vault.cachedRead(sourceFile);
	const anchors = parseAnchors(sourceText);

	const annotationMap = new Map<string, string>();
	const sidecarPath = getSidecarPath(sourcePath);
	const sidecarFile = app.vault.getAbstractFileByPath(sidecarPath);
	if (sidecarFile instanceof TFile) {
		const data = parseSidecar(
			await app.vault.cachedRead(sidecarFile)
		);
		for (const ann of data.annotations)
			annotationMap.set(ann.anchorId, ann.content);
	}

	const lines = sourceText.split("\n");
	const groups: {
		src: string;
		ann: string | null;
		id: string | null;
	}[] = [];
	let cur: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const a = anchors.find((x) => x.line === i);
		cur.push(lines[i]);
		if (a) {
			groups.push({
				src: stripAnchors(cur.join("\n")).trim(),
				ann: annotationMap.get(a.id) || null,
				id: a.id,
			});
			cur = [];
		}
	}
	if (cur.length > 0) {
		const t = cur.join("\n").trim();
		if (t) groups.push({ src: t, ann: null, id: null });
	}

	const comp = new Component();
	comp.load();
	const rendered: RenderedGroup[] = [];

	for (const g of groups) {
		const srcEl = document.createElement("div");
		await MarkdownRenderer.render(
			app,
			g.src,
			srcEl,
			sourcePath,
			comp
		);
		let annHtml: string | null = null;
		if (g.ann) {
			const annEl = document.createElement("div");
			await MarkdownRenderer.render(
				app,
				g.ann,
				annEl,
				sourcePath,
				comp
			);
			annHtml = annEl.innerHTML;
		}
		rendered.push({
			sourceHtml: srcEl.innerHTML,
			annotationHtml: annHtml,
			anchorId: g.id,
		});
	}
	comp.unload();

	return settings.exportLayout === "tufte"
		? buildTuftePage(sourceFile.basename, rendered, settings)
		: buildStandardPage(
				sourceFile.basename,
				rendered,
				settings
			);
}

// ── Standard page (side-by-side, inline, footnotes) ────────────

function buildStandardPage(
	title: string,
	groups: RenderedGroup[],
	s: MarginNotesSettings
): string {
	const body =
		s.exportLayout === "inline"
			? buildInline(groups, s)
			: s.exportLayout === "footnotes"
				? buildFootnotes(groups, s)
				: buildSideBySide(groups, s);

	const titleHtml = s.exportShowTitle
		? `<h1 class="page-title">${esc(title)}</h1>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${standardCSS(s)}
</style>
</head>
<body>
${titleHtml}
<main class="content">
${body}
</main>
<script>
${JS}
</script>
</body>
</html>`;
}

// ── Tufte page (separate because body styling is different) ─────

function buildTuftePage(
	title: string,
	groups: RenderedGroup[],
	s: MarginNotesSettings
): string {
	const titleHtml = s.exportShowTitle
		? `<h1>${esc(title)}</h1>`
		: "";

	let n = 0;
	let body = "";

	for (const g of groups) {
		let srcHtml = g.sourceHtml;

		if (g.annotationHtml) {
			n++;
			const label = `sn-${n}`;

			// Build the sidenote inline elements
			const numLabel = s.exportShowNumbers
				? `<label for="${label}" class="margin-toggle sidenote-number"></label>`
				: `<label for="${label}" class="margin-toggle">&#8853;</label>`;
			const toggle = `<input type="checkbox" id="${label}" class="margin-toggle"/>`;
			// Strip <p> wrappers from annotation HTML since it goes
			// inside a <span> (block elements inside inline = broken DOM).
			// For multi-paragraph notes, use <br> between paragraphs.
			const cleanAnn = g.annotationHtml
				.replace(/<p>/g, "")
				.replace(/<\/p>/g, "<br>")
				.replace(/<br>\s*$/, "")  // remove trailing <br>
				.trim();

			const cls = s.exportShowNumbers
				? "sidenote"
				: "marginnote";
			const note = `<span class="${cls}">${cleanAnn}</span>`;
			const injection = numLabel + toggle + note;

			// Inject sidenote INSIDE the last <p> tag of the source HTML
			// This is how tufte-css works — notes are inline in paragraphs
			const lastP = srcHtml.lastIndexOf("</p>");
			if (lastP >= 0) {
				srcHtml =
					srcHtml.substring(0, lastP) +
					injection +
					srcHtml.substring(lastP);
			} else {
				// No <p> — wrap everything
				srcHtml = `<p>${srcHtml}${injection}</p>`;
			}
		}

		body += srcHtml + "\n";
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${tufteCSS(s)}
</style>
</head>
<body>
<article>
${titleHtml}
<section>
${body}
</section>
</article>
</body>
</html>`;
}

// ── Layout builders (non-Tufte) ────────────────────────────────

function buildSideBySide(
	groups: RenderedGroup[],
	s: MarginNotesSettings
): string {
	let n = 0;
	let out = '<article class="article">\n';
	for (const g of groups) {
		if (g.annotationHtml) n++;
		out += `<section class="group">\n`;
		out += `<div class="source">${g.sourceHtml}</div>\n`;
		out += `<div class="note">`;
		if (g.annotationHtml) {
			const num = s.exportShowNumbers
				? ` data-num="${n}"`
				: "";
			out += `<div class="annotation"${num}>${g.annotationHtml}</div>`;
		}
		out += `</div>\n</section>\n`;
	}
	out += "</article>";
	return out;
}

function buildInline(
	groups: RenderedGroup[],
	s: MarginNotesSettings
): string {
	let n = 0;
	let out = '<article class="inline-body">\n';
	for (const g of groups) {
		out += `<div class="inline-source">${g.sourceHtml}</div>\n`;
		if (g.annotationHtml) {
			n++;
			const num = s.exportShowNumbers
				? ` data-num="${n}"`
				: "";
			out += `<div class="inline-ann"${num}>${g.annotationHtml}</div>\n`;
		}
	}
	out += "</article>";
	return out;
}

function buildFootnotes(
	groups: RenderedGroup[],
	s: MarginNotesSettings
): string {
	let n = 0;
	const notes: { num: number; html: string }[] = [];
	let out = '<article class="fn-body">\n';
	for (const g of groups) {
		if (g.annotationHtml) {
			n++;
			if (s.exportShowNumbers) {
				out += `<div class="fn-source">${g.sourceHtml}<sup class="fn-ref"><a href="#fn-${n}">${n}</a></sup></div>\n`;
			} else {
				out += `<div class="fn-source">${g.sourceHtml}</div>\n`;
			}
			notes.push({ num: n, html: g.annotationHtml });
		} else {
			out += `<div class="fn-source">${g.sourceHtml}</div>\n`;
		}
	}
	out += "</article>\n";

	if (notes.length > 0) {
		out += '<section class="footnotes">\n<h2>Notes</h2>\n<ol>\n';
		for (const note of notes)
			out += `<li id="fn-${note.num}">${note.html}</li>\n`;
		out += "</ol>\n</section>";
	}
	return out;
}

// ── Tufte CSS (faithful to tufte-css by Edward Tufte) ──────────

function tufteCSS(s: MarginNotesSettings): string {
	const darkMode =
		s.exportTheme === "dark"
			? `body{background-color:#151515;color:#ddd}`
			: "";

	const bgColor =
		s.exportTheme === "sepia"
			? "#f8f1e3"
			: s.exportTheme === "dark"
				? "#151515"
				: "#fffff8";
	const fgColor =
		s.exportTheme === "dark" ? "#ddd" : "#111";

	return `
@charset "UTF-8";

html { font-size: 15px; }

body {
  width: 87.5%;
  margin-left: auto;
  margin-right: auto;
  padding-left: 12.5%;
  font-family: Palatino, "Palatino Linotype", "Palatino LT STD",
    "Book Antiqua", Georgia, serif;
  background-color: ${bgColor};
  color: ${fgColor};
  max-width: 1400px;
  counter-reset: sidenote-counter;
}

h1 {
  font-weight: 400;
  margin-top: 4rem;
  margin-bottom: 1.5rem;
  font-size: 3.2rem;
  line-height: 1;
}

h2 {
  font-style: italic;
  font-weight: 400;
  margin-top: 2.1rem;
  margin-bottom: 1.4rem;
  font-size: 2.2rem;
  line-height: 1;
}

h3 {
  font-style: italic;
  font-weight: 400;
  font-size: 1.7rem;
  margin-top: 2rem;
  margin-bottom: 1.4rem;
  line-height: 1;
}

hr {
  display: block;
  height: 1px;
  width: 55%;
  border: 0;
  border-top: 1px solid #ccc;
  margin: 1em 0;
  padding: 0;
}

article { padding: 5rem 0; }
section { padding-top: 1rem; padding-bottom: 1rem; }

p, dl, ol, ul {
  font-size: 1.4rem;
  line-height: 2rem;
}

p {
  margin-top: 1.4rem;
  margin-bottom: 1.4rem;
  padding-right: 0;
  vertical-align: baseline;
}

blockquote { font-size: 1.4rem; overflow: visible; }
blockquote p { width: 55%; margin-right: 40px; }
blockquote footer { width: 55%; font-size: 1.1rem; text-align: right; }

/* Sidenotes inside paragraphs need the paragraph to not clip */
p { overflow: visible; }

/* Content width — use descendant selectors since Obsidian's
   renderer may wrap content in extra divs */
section p,
section footer,
section table {
  width: 55%;
}

section dl,
section ol,
section ul {
  width: 50%;
  -webkit-padding-start: 5%;
}

/* Ensure floated sidenotes are not clipped */
section, article, p {
  overflow: visible;
}

figure {
  padding: 0; border: 0; font-size: 100%; font: inherit;
  vertical-align: baseline; max-width: 55%;
  -webkit-margin-start: 0; -webkit-margin-end: 0;
  margin: 0 0 3em 0;
}

a:link, a:visited {
  color: inherit;
  text-underline-offset: 0.1em;
  text-decoration-thickness: 0.05em;
}

img { max-width: 100%; }

/* ── Sidenotes ──────────────────────────────────────────── */

.sidenote, .marginnote {
  float: right;
  clear: right;
  margin-right: -60%;
  width: 50%;
  margin-top: 0.3rem;
  margin-bottom: 0;
  font-size: 1.1rem;
  line-height: 1.3;
  vertical-align: baseline;
  position: relative;
}

.sidenote-number {
  counter-increment: sidenote-counter;
}

.sidenote-number:after,
.sidenote:before {
  position: relative;
  vertical-align: baseline;
}

.sidenote-number:after {
  content: counter(sidenote-counter);
  font-size: 1rem;
  top: -0.5rem;
  left: 0.1rem;
}

.sidenote:before {
  content: counter(sidenote-counter) " ";
  font-size: 1rem;
  top: -0.5rem;
}

blockquote .sidenote,
blockquote .marginnote {
  margin-right: -82%;
  min-width: 59%;
  text-align: left;
}

input.margin-toggle { display: none; }

label.sidenote-number {
  display: inline-block;
  max-height: 2rem;
}

label.margin-toggle:not(.sidenote-number) {
  display: none;
}

/* Paragraphs inside sidenotes: full width, smaller text */
.sidenote p, .marginnote p {
  width: 100%;
  font-size: 1.1rem;
  line-height: 1.3;
  margin-top: 0.3rem;
  margin-bottom: 0.3rem;
}
.sidenote p:first-child, .marginnote p:first-child { margin-top: 0; }
.sidenote p:last-child, .marginnote p:last-child { margin-bottom: 0; }

/* Code */
code, pre > code {
  font-family: Consolas, "Liberation Mono", Menlo, Courier, monospace;
  font-size: 1.0rem;
  line-height: 1.42;
}

pre > code {
  font-size: 0.9rem;
  width: 52.5%;
  margin-left: 2.5%;
  overflow-x: auto;
  display: block;
}

table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #ccc; padding: .5rem; text-align: left; }
th { background: rgba(0,0,0,.03); }

span.newthought {
  font-variant: small-caps;
  font-size: 1.2em;
}

/* ── Responsive ─────────────────────────────────────────── */

@media (max-width: 760px) {
  body {
    width: 84%;
    padding-left: 8%;
    padding-right: 8%;
  }

  hr,
  section > p,
  section > footer,
  section > table { width: 100%; }

  pre > code { width: 97%; }

  section > dl,
  section > ol,
  section > ul { width: 90%; }

  figure { max-width: 90%; }

  blockquote { margin-left: 1.5em; margin-right: 0; }
  blockquote p, blockquote footer { width: 100%; }

  label.margin-toggle:not(.sidenote-number) { display: inline; }

  .sidenote, .marginnote { display: none; }

  .margin-toggle:checked + .sidenote,
  .margin-toggle:checked + .marginnote {
    display: block;
    float: left;
    left: 1rem;
    clear: both;
    width: 95%;
    margin: 1rem 2.5%;
    vertical-align: baseline;
    position: relative;
  }

  label { cursor: pointer; }

  img { width: 100%; }
}
`;
}

// ── Standard CSS (non-Tufte layouts) ───────────────────────────

function standardCSS(s: MarginNotesSettings): string {
	const font =
		s.exportFont === "serif"
			? "'Georgia','Times New Roman',serif"
			: s.exportFont === "sans"
				? "'Helvetica Neue',Helvetica,Arial,sans-serif"
				: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

	const ratio =
		s.exportColumnRatio === "1:1"
			? "1fr 1fr"
			: s.exportColumnRatio === "2:1"
				? "2fr 1fr"
				: "3fr 2fr";

	return `
*{margin:0;padding:0;box-sizing:border-box}
${themeColors(s.exportTheme)}

body{
  font-family:${font};
  line-height:1.7;
  color:var(--fg);
  background:var(--bg);
}

.page-title{
  max-width:900px;margin:2.5rem auto 1.5rem;padding:0 1.5rem;
  font-size:2rem;color:var(--fg);
}

.content{max-width:1400px;margin:0 auto;padding:0 1rem}
h1,h2,h3,h4,h5,h6{margin:1.2rem 0 .6rem;color:var(--fg)}
p{margin:.6rem 0}
ul,ol{margin:.6rem 0;padding-left:1.5rem}
table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid var(--border);padding:.5rem;text-align:left}
th{background:var(--surface)}
code{background:var(--surface);padding:.1rem .3rem;border-radius:3px;font-size:.9em}
pre{background:var(--surface);padding:1rem;border-radius:4px;overflow-x:auto;margin:1rem 0}
pre code{background:none;padding:0}
img{max-width:100%}
blockquote{border-left:3px solid var(--border);padding-left:1rem;color:var(--muted);margin:1rem 0}
a{color:var(--accent)}

.annotation,.inline-ann{
  background:var(--ann-bg);
  border-left:3px solid var(--ann-border);
  padding:.75rem 1rem;
  border-radius:0 4px 4px 0;
  position:relative;
  font-size:.92em;line-height:1.55;color:var(--fg);
}
.annotation p:last-child,.inline-ann p:last-child{margin-bottom:0}
.annotation p:first-child,.inline-ann p:first-child{margin-top:0}

${s.exportShowNumbers ? `
.annotation[data-num]::before,.inline-ann[data-num]::before{
  content:attr(data-num);
  position:absolute;top:-8px;left:-12px;
  width:20px;height:20px;border-radius:50%;
  background:var(--ann-border);color:#fff;font-size:.7rem;
  display:flex;align-items:center;justify-content:center;font-weight:600;
}` : ""}

.annotation.selected,.inline-ann.selected{
  background:var(--ann-selected);border-color:var(--accent);
}

${s.exportLayout === "side-by-side" ? `
@media screen and (min-width:46rem){
  .article{display:grid;grid-template-columns:${ratio}}
  .group{grid-column:1/3;display:grid;grid-template-columns:${ratio};align-items:start}
  .source{padding:1rem 2rem 1rem 1.5rem;border-right:1px solid var(--border)}
  .note{padding:.75rem 1.5rem;background:var(--surface)}
}
.source{padding:.75rem 1.5rem}
.note{padding:.5rem 1.5rem}
.annotation{margin:.5rem 0;cursor:pointer}
` : ""}

${s.exportLayout === "inline" ? `
.inline-body{max-width:750px;margin:0 auto;padding:0 1.5rem}
.inline-source{padding:.4rem 0}
.inline-ann{margin:.5rem 0 1.5rem;cursor:pointer}
` : ""}

${s.exportLayout === "footnotes" ? `
.fn-body{max-width:750px;margin:0 auto;padding:0 1.5rem}
.fn-source{padding:.4rem 0}
.fn-ref a{color:var(--accent);text-decoration:none;font-weight:600}
.fn-ref a:hover{text-decoration:underline}
.footnotes{max-width:750px;margin:3rem auto;padding:2rem 1.5rem 0;border-top:2px solid var(--border)}
.footnotes h2{font-size:1.3rem;margin-bottom:1rem}
.footnotes ol{padding-left:1.5rem}
.footnotes li{margin-bottom:1rem;font-size:.92em;line-height:1.55;color:var(--fg)}
` : ""}
`;
}

function themeColors(theme: string): string {
	switch (theme) {
		case "dark":
			return `:root{
  --fg:#e0e0e0;--bg:#1a1a2e;--surface:#252540;--border:#3a3a55;
  --muted:#888;--accent:#7c9dff;
  --ann-bg:rgba(124,157,255,.08);--ann-border:#5a7abf;--ann-selected:rgba(124,157,255,.18);
}`;
		case "sepia":
			return `:root{
  --fg:#433422;--bg:#f8f1e3;--surface:#f0e8d8;--border:#d4c5a9;
  --muted:#8a7560;--accent:#b07030;
  --ann-bg:rgba(176,112,48,.06);--ann-border:#c49a56;--ann-selected:rgba(176,112,48,.14);
}`;
		case "academic":
			return `:root{
  --fg:#222;--bg:#fffff8;--surface:#f8f8f2;--border:#ccc;
  --muted:#666;--accent:#8b0000;
  --ann-bg:rgba(139,0,0,.04);--ann-border:#8b0000;--ann-selected:rgba(139,0,0,.12);
}`;
		default:
			return `:root{
  --fg:#1a1a1a;--bg:#fff;--surface:#f8f8f6;--border:#e5e7eb;
  --muted:#6b7280;--accent:#4a6fa5;
  --ann-bg:#f5f5f0;--ann-border:#6b7280;--ann-selected:#fef9c3;
}`;
	}
}

const JS = `
document.querySelectorAll('.annotation,.inline-ann').forEach(function(a){
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

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
