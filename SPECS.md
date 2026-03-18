# Visual Element Picker — Project Specifications

> A Claude Code plugin that lets users point at any element on a localhost dev server,
> type a prompt, and have Claude automatically edit the source file — no screenshots,
> no copy-pasting, no context switching.

---

## 1. Problem Statement

When prototyping with Claude Code, the feedback loop for UI fixes is:

```
See issue in browser
  → Screenshot / copy error
    → Paste into Claude Code terminal
      → Describe the issue
        → Claude fixes it
          → Reload browser
            → Repeat
```

This is slow, lossy (context gets lost in translation), and requires the user to switch
between the browser and the terminal repeatedly.

---

## 2. Solution

A visual element picker embedded directly in the localhost browser preview, inspired by:
- **Lovable** — click-to-edit UI components
- **v0** — element inspection + prompt
- **Figma** — select tool with element targeting

The user activates "pick mode," clicks any DOM element, types a natural-language prompt,
and Claude makes the edit. The dev server's HMR reloads the browser automatically.

---

## 3. User Flow

### Normal Testing (Pick Mode OFF — default)
```
User opens localhost app in browser
  → App behaves 100% normally
  → Buttons, forms, links, navigation all work as expected
  → Only visible addition: small [✦ Edit] pill button in bottom-right corner
```

### UI Editing Flow (Pick Mode ON)
```
1. User clicks [✦ Edit] button  (or presses Alt+E)
   → Button glows indigo, pick mode activates

2. User hovers over any element
   → Dashed indigo border highlights the element
   → Small badge shows tag name and class: e.g., "button.btn-primary"

3. User clicks the element
   → Click is intercepted (app's handlers do NOT fire)
   → Prompt popup appears above/below the element

4. User types their request: "Make this button red and 20% larger"
   → Presses Enter or clicks "Send to Claude"

5. Popup shows: "Sending..." → "Claude is working..."

6. Bridge server receives the payload
   → Resolves the source file
   → Calls: claude -p "<rich context>" --allowedTools Read,Edit,Glob,Grep

7. Claude reads source files, finds the element, edits the code

8. Dev server HMR triggers → browser reloads

9. Popup shows "Done ✓" → auto-dismisses after 2 seconds

10. User sees change live in browser
    → Can immediately continue testing OR pick another element
```

### Deactivating Pick Mode
- Click `[✦ Edit]` button again
- Press `Esc`
- Submit a prompt (auto-exits after Done ✓)

---

## 4. Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Claude Code integration | Claude Code Plugin system | Native plugin hooks + skills |
| Hook trigger | Claude Code `PostToolUse:Bash` hook | Detects when user's dev server starts |
| Bridge server | Node.js (built-ins only: `http`, `fs`, `child_process`) | Zero install friction, widely available |
| Bridge ↔ Browser | HTTP REST (POST /prompt) | Simple, CORS-friendly |
| Browser overlay | Vanilla JS + CSS (no frameworks, no dependencies) | Works in any app regardless of framework |
| React source mapping | React Fiber internal (`__reactFiber*` key) | Gets component name + source file from DOM node |
| Screenshot capture | `html2canvas` (loaded from CDN, optional) | Captures visual context of selected element |
| Claude invocation | `claude -p "..." --allowedTools Read,Edit,Glob,Grep` | Non-interactive one-shot mode |
| Dev server detection | Regex on Bash tool's command + stdout | Detects vite, next, webpack, CRA, astro, etc. |

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────┐
│                   USER'S PROJECT                    │
│                                                     │
│  ┌──────────────┐    HMR     ┌──────────────────┐  │
│  │  Dev Server  │ ─────────► │  Browser (app)   │  │
│  │  (Vite/Next) │            │  + overlay.js    │  │
│  └──────────────┘            └────────┬─────────┘  │
│                                       │ POST /prompt│
│  ┌────────────────────────────────────▼──────────┐ │
│  │           Bridge Server (port 3333)           │ │
│  │  • Serves overlay.js                          │ │
│  │  • Receives browser prompts                   │ │
│  │  • Resolves source file from DOM context      │ │
│  │  • Calls: claude -p "..." (non-interactive)   │ │
│  └────────────────────────────────────┬──────────┘ │
│                                       │             │
│  ┌────────────────────────────────────▼──────────┐ │
│  │         Claude Code (claude -p mode)          │ │
│  │  Tools: Read, Edit, Glob, Grep                │ │
│  │  → Reads source files                         │ │
│  │  → Finds element definition                   │ │
│  │  → Edits file in place                        │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │      Claude Code Plugin (this project)        │ │
│  │  • hooks/hooks.json → auto-starts bridge      │ │
│  │  • skills/ → targeted edit skill              │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

---

## 6. File Structure

```
locahost/                              ← This repository
├── .claude-plugin/
│   └── plugin.json                   ← Claude Code plugin manifest
│
├── hooks/
│   └── hooks.json                    ← PostToolUse:Bash hook config
│
├── bridge/
│   ├── package.json                  ← Node.js project (zero external deps)
│   ├── server.js                     ← HTTP bridge server (port 3333)
│   ├── source-resolver.js            ← DOM → source file mapping logic
│   ├── prompt-builder.js             ← Builds the rich context prompt for claude -p
│   └── overlay/
│       ├── overlay.js                ← Browser element picker script
│       └── overlay.css               ← Overlay + popup styles
│
├── scripts/
│   └── start-bridge.sh              ← Idempotent bridge server starter
│
├── skills/
│   └── visual-picker/
│       └── SKILL.md                 ← Claude skill: targeted UI edit
│
├── SPECS.md                         ← This file
└── README.md                        ← Setup and usage instructions
```

---

## 7. Component Specifications

### 7.1 Plugin Manifest (`.claude-plugin/plugin.json`)
- Registers the plugin with Claude Code
- Points to hooks directory and skills directory
- Metadata: name `visual-element-picker`, version, description

---

### 7.2 Hook (`hooks/hooks.json`)

**Trigger**: `PostToolUse` on `Bash` tool

**Logic** (in the hook command script):
1. Read stdin JSON: `{ tool_input: { command }, tool_response: { stdout } }`
2. Check if command or stdout contains dev server keywords:
   - Commands: `vite`, `next dev`, `npm run dev`, `yarn dev`, `pnpm dev`, `webpack serve`, `react-scripts start`, `astro dev`, `nuxt dev`, `svelte-kit dev`
   - Stdout signals: `localhost:`, `Local:`, `ready on http://`, `running at http://`
3. If match:
   - Extract project CWD (from `CLAUDE_PROJECT_DIR` env var or `process.cwd()`)
   - Extract dev server URL from stdout (regex: `https?://localhost:\d+`)
   - Write `/tmp/vep-config.json`: `{ projectDir, devServerUrl, startedAt }`
   - Check if port 3333 is already in use; if not, start bridge server
   - Output message to Claude's context instructing user to add the script tag
4. `"async": true` — does not block Claude Code

---

### 7.3 Bridge Server (`bridge/server.js`)

**Runtime**: Node.js 18+ (uses built-in `http`, `fs`, `child_process`, `path`, `url`)

**Port**: 3333 (configurable via `VEP_PORT` env var)

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/overlay.js` | Serves the browser picker script |
| GET | `/overlay.css` | Serves overlay styles |
| GET | `/status` | Health check: `{ ok: true, projectDir, version }` |
| POST | `/prompt` | Receives element context + user prompt, triggers Claude |

**POST /prompt — Request body**:
```json
{
  "userPrompt": "Make this button red and larger",
  "element": {
    "outerHTML": "<button class='btn-primary'>Get Started</button>",
    "cssSelector": "main > .hero > button.btn-primary",
    "tagName": "BUTTON",
    "textContent": "Get Started",
    "attributes": { "class": "btn-primary", "id": "cta-btn" },
    "boundingBox": { "x": 400, "y": 300, "width": 140, "height": 48 },
    "computedStyles": {
      "color": "#ffffff",
      "backgroundColor": "#3B82F6",
      "fontSize": "16px",
      "padding": "12px 24px"
    }
  },
  "screenshot": "data:image/png;base64,...",
  "pageUrl": "http://localhost:5173/",
  "pageTitle": "My App — Home",
  "sourceInfo": {
    "componentName": "HeroSection",
    "componentFile": "src/components/HeroSection.jsx",
    "componentLine": 42
  }
}
```

**POST /prompt — Response**:
```json
{ "success": true, "message": "Done. Changed btn-primary background to red and increased font size." }
{ "success": false, "error": "Claude could not find the element in source files." }
```

**Bridge server process on receiving /prompt**:
1. Parse request body
2. Save screenshot (if present) to `{projectDir}/.vep-temp/screenshot-{timestamp}.png`
3. Call `source-resolver.js` to confirm or find source file
4. Call `prompt-builder.js` to generate the claude -p prompt string
5. Spawn: `claude -p "{prompt}" --allowedTools "Read,Edit,Glob,Grep" --cwd "{projectDir}" --output-format json`
6. Wait for process to exit, capture stdout/stderr
7. Parse result, return response to browser
8. Clean up temp files older than 10 minutes

**CORS**: All responses include `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET, POST, OPTIONS`

---

### 7.4 Source Resolver (`bridge/source-resolver.js`)

Maps a DOM element back to its source file. Tries strategies in order:

1. **React Fiber** (best): If `sourceInfo.componentFile` is provided by the overlay (extracted from React's internal `__reactFiber` key), use it directly. Provides file + line number.

2. **Source map** (good): Look for `.map` files in `{projectDir}/dist` or `{projectDir}/.next`. Parse to find original source. Requires source maps enabled (default in Vite dev mode).

3. **Class name grep** (fallback): Run `grep -r "{className}" {projectDir}/src` and rank results by specificity (most specific class first).

4. **Text content grep** (fallback): Run `grep -r "{textContent}" {projectDir}/src` for unique button/heading text.

5. **Pass-through** (last resort): Return null; let Claude search the codebase itself using Glob + Grep.

---

### 7.5 Prompt Builder (`bridge/prompt-builder.js`)

Generates the full context string passed to `claude -p`. Format:

```
You are making a targeted UI edit to a web app. Make ONLY the change the user requested.
Do not refactor, rename, or touch anything beyond the specific element.

USER REQUEST: "{userPrompt}"

SELECTED ELEMENT:
- Tag: {tagName}
- CSS Selector: {cssSelector}
- HTML: {outerHTML}
- Text: "{textContent}"
- Current styles: color: {color}, background: {backgroundColor}, font-size: {fontSize}

PAGE: {pageTitle} ({pageUrl})

SOURCE FILE: {componentFile} (approx. line {componentLine})
[If no source file: search using Grep for the class name "{className}" or text "{textContent}"]

A screenshot of the selected element has been saved to: .vep-temp/screenshot-{timestamp}.png
Read it to understand the visual context.

Instructions:
1. Read the source file to locate this element
2. Make exactly the change requested: "{userPrompt}"
3. Edit the file — CSS class, Tailwind class, inline style, or whatever is appropriate for this codebase
4. Do not touch surrounding elements or restructure code
5. Confirm what you changed in your final response
```

---

### 7.6 Browser Overlay (`bridge/overlay/overlay.js`)

**Injection**: User adds one `<script>` tag to their HTML entry point:
```html
<script src="http://localhost:3333/overlay.js"></script>
```

**State machine**:
```
INACTIVE (default)
  ↓ [✦ Edit] click OR Alt+E
PICK_MODE
  ↓ element click
ELEMENT_SELECTED (popup open)
  ↓ Esc / cancel
PICK_MODE
  ↓ prompt submit
WAITING (polling bridge)
  ↓ done/error
INACTIVE
```

**DOM structure injected** (all IDs prefixed `vep-` to avoid collisions):
```html
<div id="vep-toggle-btn">✦ Edit</div>        <!-- fixed bottom-right -->
<div id="vep-highlight"></div>                 <!-- follows hovered element -->
<div id="vep-badge">button.btn-primary</div>  <!-- shows element type -->
<div id="vep-popup">                           <!-- prompt popup -->
  <div id="vep-popup-header">Edit Element</div>
  <div id="vep-element-preview">...</div>      <!-- truncated outerHTML -->
  <textarea id="vep-prompt-input" placeholder="Describe the change..."></textarea>
  <div id="vep-popup-actions">
    <button id="vep-cancel-btn">Cancel</button>
    <button id="vep-send-btn">Send to Claude ✦</button>
  </div>
  <div id="vep-status"></div>                  <!-- "Working..." / "Done ✓" -->
</div>
```

**React Fiber source extraction**:
```js
function getReactSource(el) {
  const key = Object.keys(el).find(k =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
  );
  if (!key) return null;
  let fiber = el[key];
  while (fiber) {
    const src = fiber._debugSource || fiber._debugOwner?._debugSource;
    if (src) return { componentFile: src.fileName, componentLine: src.lineNumber };
    fiber = fiber.return;
  }
  return null;
}
```

**CSS Selector generation** (unique path from root):
```js
function getCssSelector(el) {
  const parts = [];
  while (el && el.nodeType === 1 && el !== document.body) {
    let selector = el.tagName.toLowerCase();
    if (el.id) { selector += `#${el.id}`; parts.unshift(selector); break; }
    if (el.className) selector += '.' + [...el.classList].slice(0,3).join('.');
    const siblings = [...el.parentElement.children].filter(s => s.tagName === el.tagName);
    if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
    parts.unshift(selector);
    el = el.parentElement;
  }
  return parts.join(' > ');
}
```

**Computed styles captured** (relevant subset):
`color`, `backgroundColor`, `fontSize`, `fontWeight`, `padding`, `margin`, `borderRadius`,
`display`, `flexDirection`, `width`, `height`, `opacity`, `border`

**Screenshot capture** (optional — loaded lazily from CDN):
```js
async function captureElement(el) {
  if (!window.html2canvas) {
    await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
  }
  const canvas = await html2canvas(el, { useCORS: true, scale: 2 });
  return canvas.toDataURL('image/png');
}
```

**Non-interference guarantee**: When pick mode is OFF, no `mousemove`, `click`, or `keydown` handlers are attached. The only attached handler is a `click` on `#vep-toggle-btn` and a `keydown` for `Alt+E`.

---

### 7.7 Overlay Styles (`bridge/overlay/overlay.css`)

Key design decisions:
- All styles scoped to `#vep-*` IDs — zero risk of collision with app styles
- `z-index: 2147483647` (max) for highlight, popup, toggle button
- `pointer-events: none` on highlight div — doesn't block hover detection
- Dark theme popup: `#1E1E2E` background, `#CDD6F4` text (Catppuccin Mocha)
- Indigo accent: `#6366F1` for active state, button, border highlight
- Smooth transitions: `150ms ease` on highlight position/size
- Popup: `box-shadow: 0 8px 32px rgba(0,0,0,0.4)` — clearly floats above app

---

### 7.8 Claude Skill (`skills/visual-picker/SKILL.md`)

Used when Claude Code calls `claude -p` from the bridge. Gives Claude targeted instructions:
- Read source files, locate the element, make ONLY the requested change
- Don't refactor surrounding code
- Prefer editing existing CSS classes over adding new ones
- Confirm the specific change made in the response

---

## 8. Installation

### For end users (once published)
```bash
# Clone the plugin
git clone https://github.com/user/vep-plugin locahost

# Install bridge dependencies (one time)
cd locahost/bridge && npm install

# Use in any project
cd my-project
claude --plugin-dir /path/to/locahost
```

### Add overlay to your app
Add before `</body>` in your HTML entry point:
```html
<script src="http://localhost:3333/overlay.js"></script>
```

**Vite projects** (`index.html`):
```html
<!-- Development only — remove before building for prod -->
<script src="http://localhost:3333/overlay.js"></script>
```

> Claude Code will output this instruction automatically when it detects your dev server starting.

---

## 9. Limitations & Known Constraints

| Constraint | Detail |
|-----------|--------|
| **No active session injection** | Claude Code doesn't expose an API to inject prompts into a running interactive session. Each browser prompt spawns a fresh `claude -p` invocation. |
| **Sequential edits only** | Bridge queues incoming prompts — only one `claude -p` process runs at a time. |
| **Source maps required for map resolution** | Without source maps, falls back to grep-based resolution. |
| **React Fiber only in development builds** | `_debugSource` is stripped in production builds. |
| **html2canvas limitations** | Cannot capture cross-origin iframes or WebGL canvases accurately. |
| **Windows path handling** | Bridge server normalizes paths with `path.normalize()` for Windows compatibility. |
| **Port 3333 conflict** | If another process uses port 3333, set `VEP_PORT=3334` env var. |

---

## 10. Future Enhancements

- **Auto-injection**: Hook patches `vite.config.js` / `next.config.js` to auto-inject overlay, eliminating the manual script tag step.
- **Multi-element selection**: Shift+click to select multiple elements and describe changes to all at once.
- **History panel**: Sidebar showing recent edits with undo capability.
- **CSS variable awareness**: Detect Tailwind / CSS custom properties and edit at the design-token level.
- **Vue/Svelte component resolution**: Extend fiber-style traversal to Vue's `__vue_app__` and Svelte's component internals.
- **Browser extension version**: Eliminate the script tag entirely — extension injects overlay into any localhost page.
- **WebSocket for streaming**: Stream Claude's response tokens to the popup in real time instead of waiting for completion.
