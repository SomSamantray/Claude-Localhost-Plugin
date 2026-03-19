# Visual Element Picker (VEP) — Claude Code Plugin

> Click any element on your localhost app → type a change → Claude edits the source file.
> No screenshots. No copy-pasting. No context switching.

---

## What It Does

VEP embeds a visual element picker directly in your browser dev preview. You activate "pick mode," click any DOM element, type a natural-language prompt, and Claude makes the targeted edit. Your dev server's HMR reloads the page automatically.

```
Browser overlay  →  POST /prompt  →  Bridge server  →  claude -p  →  Edit source file  →  HMR reload
```

---

## Features

- **Zero-friction activation** — the `[✦ Edit]` button sits in the bottom-right corner; your app behaves 100% normally when pick mode is off
- **Auto-detection** — the hook detects when Claude starts a dev server and injects the overlay automatically
- **Multi-server support** — scans common localhost ports on every prompt; tracks and injects all running servers simultaneously
- **React Fiber source mapping** — finds the exact component file and line from the DOM node's internal fiber
- **Fallback resolution** — CSS class grep → ID grep → text content grep → Claude searches itself
- **Sequential queue** — multiple browser prompts are queued; one `claude -p` runs at a time
- **Auto cleanup** — overlay `<script>` tag is removed from `index.html` when the bridge shuts down
- **Windows-compatible** — all paths use `path.normalize()`, no shell interpolation, no hardcoded `/tmp`

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (your app + overlay)                        │
│  [✦ Edit]  hover → highlight  click → prompt popup  │
└──────────────────┬──────────────────────────────────┘
                   │  POST /prompt
┌──────────────────▼──────────────────────────────────┐
│  Bridge Server  http://localhost:3333                │
│  • Serves overlay.js + overlay.css                  │
│  • Queues prompts (one claude -p at a time)         │
│  • Resolves source file from DOM element            │
│  • Spawns: claude --print --allowedTools Read,Edit  │
└──────────────────┬──────────────────────────────────┘
                   │  edits source file
┌──────────────────▼──────────────────────────────────┐
│  Your project source files                          │
│  Dev server HMR → browser reloads automatically    │
└─────────────────────────────────────────────────────┘
```

---

## Installation

### 1. Clone this plugin

```bash
git clone https://github.com/SomSamantray/Claude-Localhost-Plugin.git
```

### 2. Start Claude Code with this plugin

```bash
cd your-project
claude --plugin-dir /path/to/Claude-Localhost-Plugin
```

That's it. The hooks auto-register. No npm install needed — the bridge uses only Node.js built-ins.

---

## Usage

### Automatic (Recommended)

Ask Claude to start your dev server as normal:

```
"start the dev server"
"npm run dev"
"run it on localhost"
```

VEP will:
1. Detect the server start from the Bash hook
2. Auto-inject `<script src="http://localhost:3333/overlay.js"></script>` into your `index.html`
3. Start the bridge on port 3333

Open your app in the browser. The `[✦ Edit]` button appears in the bottom-right corner.

### Manual (if you started the server yourself)

```bash
node /path/to/Claude-Localhost-Plugin/bridge/server.js \
  --project-dir /path/to/your/project \
  --dev-server-url http://localhost:8000
```

Then add to your `index.html` before `</body>`:

```html
<!-- VEP:START -->
<script src="http://localhost:3333/overlay.js"></script>
<!-- VEP:END -->
```

---

## Using the Overlay

| Action | Result |
|--------|--------|
| Click `[✦ Edit]` or press `Alt+E` | Activate pick mode |
| Hover over any element | Dashed indigo border highlights it |
| Click an element | Prompt popup appears |
| Type your change + Enter | Claude makes the edit |
| Press `Esc` | Cancel / exit pick mode |

Claude is restricted to `Read, Edit, Glob, Grep` — it edits source files, nothing else.

---

## Multi-Server Support

VEP automatically detects **all running localhost servers** on every prompt, not just the one Claude started.

On each message you send Claude, the `UserPromptSubmit` hook:
- Scans ports: `3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000, 9090`
- Updates a registry at `%TEMP%/vep-registry.json`
- Injects the overlay into each detected server's `index.html`
- Shows a summary in Claude's context when 2+ servers are running:

```
🌐 VEP Servers (3 detected):
  ✦ localhost:3000 — myapp  [overlay ✓]
  · localhost:5173 — frontend  [overlay ✓]
  · localhost:8000 — api-docs  [add script tag manually]
```

`✦` = started via Claude hook (project dir known)
`·` = discovered by port scan

The bridge CORS allows all registered servers simultaneously, so the overlay on any of them can reach the bridge.

---

## File Structure

```
Claude-Localhost-Plugin/
├── CLAUDE.md                    ← Guidance for Claude Code sessions
├── SPECS.md                     ← Full project specifications
│
├── hooks/
│   ├── hooks.json               ← Registers PostToolUse:Bash + UserPromptSubmit hooks
│   ├── detect-server.js         ← Detects dev server start, injects overlay, starts bridge
│   └── inject-queue.js          ← Port scan, multi-server registry, queue activity display
│
├── bridge/
│   ├── server.js                ← HTTP bridge (port 3333): serves overlay, queues prompts
│   ├── source-resolver.js       ← Maps DOM element → source file
│   ├── prompt-builder.js        ← Assembles context string for claude --print
│   └── overlay/
│       ├── overlay.js           ← Browser element picker (vanilla JS, zero deps)
│       └── overlay.css          ← Overlay styles (all scoped to #vep-* IDs)
│
├── scripts/
│   └── start-bridge.js          ← Idempotent manual bridge starter
│
└── skills/
    └── visual-picker/
        └── SKILL.md             ← Claude skill: make only the requested UI change
```

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VEP_PORT` | `3333` | Bridge server port |

### Custom bridge port

```bash
VEP_PORT=3334 node bridge/server.js --project-dir /path/to/project
```

The overlay auto-detects the bridge port from its own script URL — no config needed in the browser.

---

## How Source Resolution Works

When you click an element, VEP tries to find its source file in this order:

1. **React Fiber** — reads `__reactFiber*` internals from the DOM node → gets exact file + line
2. **CSS class grep** — searches `src/` for the most specific class name
3. **Element ID grep** — searches for the element's ID
4. **Text content grep** — searches for unique visible text
5. **Pass-through** — returns null; Claude searches the codebase itself with Glob + Grep

---

## Security

- Bridge binds to `127.0.0.1` only — never exposed to the network
- CORS is scoped to registered dev server origins — no wildcard
- `sourceInfo.componentFile` is bounds-checked to stay within `projectDir` — no path traversal
- `userPrompt` is capped at 500 characters — limits prompt injection surface
- All `spawn()` calls use `shell: false` — no shell injection possible
- Claude is restricted to `Read, Edit, Glob, Grep` — cannot run shell commands or access the network

---

## Limitations

| Limitation | Detail |
|-----------|--------|
| Sequential edits | One `claude -p` at a time; subsequent browser prompts queue up |
| React Fiber only in dev | `_debugSource` is stripped in production builds |
| `html2canvas` limitations | Cannot capture cross-origin iframes or WebGL |
| No active session injection | Each browser prompt spawns a fresh `claude --print` |

---

## Troubleshooting

**Overlay not appearing**
→ Check bridge is running: `curl http://localhost:3333/status`
→ Check `index.html` has the `<!-- VEP:START -->` block
→ Check bridge logs: `Get-Content -Wait .vep-bridge.log`

**CORS errors in browser console**
→ Ensure `--dev-server-url` matches the actual port your dev server is on
→ Or let the hook auto-detect by asking Claude to start the server

**Wrong project being edited**
→ Check `%TEMP%\vep-config.json` for the active `projectDir`
→ Restart bridge with `--project-dir /correct/path`

---

## License

MIT
