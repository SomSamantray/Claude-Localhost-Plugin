# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Visual Element Picker** — a Claude Code plugin that injects a DOM element picker overlay into any localhost dev server. Users hover over elements, click, type a prompt, and Claude edits the source file directly. The dev server's HMR reloads the page automatically.

Full specifications are in `SPECS.md`. Read it first if starting a new session.

## Commands

### Bridge Server
```bash
# Install dependencies (one time — zero external deps, only Node.js built-ins)
cd bridge && npm install

# Start bridge server manually (port 3333)
node bridge/server.js

# Start on a different port
VEP_PORT=3334 node bridge/server.js

# Test the bridge is running
curl http://localhost:3333/status

# Test a prompt end-to-end
curl -X POST http://localhost:3333/prompt \
  -H "Content-Type: application/json" \
  -d '{"userPrompt":"make the heading blue","element":{"cssSelector":"h1","outerHTML":"<h1>Hello</h1>","tagName":"H1","textContent":"Hello","attributes":{},"boundingBox":{},"computedStyles":{}}}'
```

### Plugin Usage (in a user's project)
```bash
# Load this plugin when starting Claude Code in the user's project
claude --plugin-dir /path/to/locahost

# Reload plugin after making changes to this repo
/reload-plugins
```

## Architecture

```
Browser overlay (overlay.js)
  → POST /prompt with element context + user prompt
    → Bridge server (bridge/server.js, port 3333)
      → source-resolver.js  (DOM → source file)
      → prompt-builder.js   (build claude -p context string)
        → claude -p "..." --allowedTools Read,Edit,Glob,Grep --cwd <projectDir>
          → Claude edits the source file
            → Dev server HMR → browser reloads
```

**Key constraint**: Claude Code does not expose an API to inject prompts into an active interactive session. Each browser-submitted prompt spawns a fresh `claude -p` one-shot invocation.

## Component Responsibilities

- **`hooks/hooks.json`** — `PostToolUse:Bash` hook. Detects when the user's dev server starts (matches keywords: `vite`, `next dev`, `npm run dev`, etc. in command or stdout). Writes `/tmp/vep-config.json` with `{ projectDir, devServerUrl }` and starts the bridge server asynchronously.

- **`bridge/server.js`** — HTTP server on port 3333. Serves `overlay.js` and `overlay.css` with CORS headers. Handles `POST /prompt`: saves screenshot, resolves source file, builds prompt, spawns `claude -p`, returns result. Queues prompts sequentially (one `claude -p` at a time).

- **`bridge/source-resolver.js`** — Maps a DOM element back to its source file. Strategy order: (1) React Fiber `_debugSource` from overlay, (2) source map parsing in `dist/` or `.next/`, (3) CSS class grep in `src/`, (4) text content grep, (5) return null and let Claude search itself.

- **`bridge/prompt-builder.js`** — Assembles the full context string for `claude -p` including user prompt, element HTML, CSS selector, computed styles, source file hint, and screenshot path.

- **`bridge/overlay/overlay.js`** — Browser script (vanilla JS, zero deps). State machine: `INACTIVE → PICK_MODE → ELEMENT_SELECTED → WAITING → INACTIVE`. Activated by `[✦ Edit]` button or `Alt+E`. When INACTIVE, adds zero event listeners — app works 100% normally. Extracts React Fiber source via `__reactFiber*` key, generates CSS selectors, captures screenshots via `html2canvas` (loaded lazily from CDN).

- **`bridge/overlay/overlay.css`** — All styles scoped to `#vep-*` IDs. `z-index: 2147483647` on all overlay elements. `pointer-events: none` on the highlight div.

- **`skills/visual-picker/SKILL.md`** — Claude skill invoked during `claude -p` edits. Instructs Claude to make only the requested change, prefer editing existing CSS classes, and confirm what was changed.

## Critical Behaviours to Preserve

- **Pick mode OFF = zero interference.** When the overlay is inactive, the only DOM change is the `#vep-toggle-btn` element. No `mousemove`, `click`, or `keydown` listeners are attached to the document.

- **All overlay DOM IDs are prefixed `vep-`** to avoid colliding with any app's own styles or IDs.

- **Bridge server is framework-agnostic.** It operates at the DOM level and works with React, Vue, Svelte, vanilla HTML, or anything else.

- **Windows path compatibility.** Bridge server uses `path.normalize()` on all file paths. The `claude -p` call uses `--cwd` with the normalized project directory.

- **`/tmp/vep-config.json`** is the handoff file between the hook (which knows the project dir) and the bridge server (which needs it to call `claude -p --cwd`).
