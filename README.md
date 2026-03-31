# Margin Notes

An Obsidian plugin for annotating documents in a side pane — like comments in Google Docs or Microsoft Word. Write your commentary alongside source material with full markdown formatting, scroll sync, and HTML export.

![Margin Notes concept](https://img.shields.io/badge/status-beta-orange)

## Features

- **Side pane annotations** — a dedicated pane on the right shows your annotations next to the source document
- **Full markdown** — annotations support bold, italic, tables, lists, code blocks, wikilinks, images — everything Obsidian renders
- **Scroll sync** — the annotation pane stays aligned with the source document as you scroll either one
- **Hover highlighting** — hover an annotation to highlight its source paragraph, and vice versa
- **HTML export** — export a self-contained two-column HTML page (source on left, annotations on right) for publishing to static sites
- **Cross-platform** — works on desktop (Windows, macOS, Linux) and mobile (Android, iOS)
- **Non-destructive** — annotations live in a separate sidecar file; source documents get only a tiny invisible anchor comment

## Installation

### Via BRAT (recommended for beta)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. In BRAT settings, click "Add Beta Plugin"
3. Enter `martinjuskelis/obsidian-margin-notes`
4. Enable the plugin in Settings → Community Plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/martinjuskelis/obsidian-margin-notes/releases)
2. Create a folder `your-vault/.obsidian/plugins/margin-notes/`
3. Copy the three files into it
4. Enable the plugin in Settings → Community Plugins

## Usage

### Adding annotations

1. Open the annotation pane by clicking the speech-bubble icon in the left ribbon, or run **Toggle margin notes pane** from the command palette
2. Place your cursor on a line you want to annotate
3. Run **Add margin note** from the command palette, or click the **+** button in the pane
4. Type your annotation in the textarea that appears — full markdown is supported
5. Press **Ctrl+Enter** (or **Cmd+Enter**) to save, **Escape** to cancel

### Editing and deleting

- Hover an annotation card to reveal the pencil and trash icons
- Click the pencil to edit, trash to delete
- Deleting removes both the annotation and the anchor from the source file

### Scroll sync

Scroll either pane and the other follows. The sync uses anchor-based interpolation — annotations stay aligned with their source paragraphs even when content lengths differ between the two panes.

### Highlighting

- **Hover** an annotation card → the source paragraph highlights
- **Click** an annotation card → the source scrolls to that paragraph with a brief flash

### HTML export

Run **Export as HTML with margin notes** from the command palette. This creates a `document.html` file in the same folder as the source — a self-contained two-column page with:

- Source text on the left, annotations on the right (CSS Grid layout)
- Responsive design — collapses to single column on mobile
- Click-to-highlight interaction (optional JavaScript, works without it)
- No external dependencies — suitable for deploying to Cloudflare Pages, Netlify, GitHub Pages, etc.

## How it works

### Anchors

When you annotate a line, the plugin inserts a small HTML comment at the end:

```markdown
This is my source paragraph about quantum computing. <!-- ann:k7x2m9 -->
```

This anchor is **invisible** in Reading View and Live Preview (when your cursor is elsewhere). It provides a stable, persistent link between the source paragraph and its annotation. The anchor survives edits to the surrounding text — you can rewrite the paragraph and the link holds.

### Sidecar files

Annotations are stored in a companion file alongside the source:

```
documents/
├── my-research.md          ← source document
└── my-research.ann.md      ← annotations (created automatically)
```

The sidecar file is valid markdown with a simple structure:

```markdown
---
source: "my-research.md"
---

<!-- ann:k7x2m9 -->

My commentary here with **bold**, tables, [[wikilinks]], etc.

<!-- ann:p3r8w2 -->

Another annotation.
```

You can open and edit the sidecar file directly if you want, but the annotation pane is the intended interface.

### File lifecycle

- **Rename** the source file → the sidecar is renamed to match, and its internal reference is updated
- **Delete** an annotation → both the sidecar entry and the source anchor are removed
- **Delete** the sidecar file → the anchors remain in the source (invisible, harmless); the pane shows "No annotations"

## Commands

| Command | Description |
|---------|-------------|
| **Add margin note** | Insert an anchor at the cursor and create an annotation (editor command) |
| **Toggle margin notes pane** | Show or hide the annotation side pane |
| **Export as HTML with margin notes** | Export a two-column HTML page |

## Building from source

```bash
npm install
npm run build
```

This produces `main.js` in the project root. Copy it along with `manifest.json` and `styles.css` to your vault's plugin folder.

For development with auto-rebuild on save:

```bash
npm run dev
```

## License

MIT
