'use strict';

/**
 * UserPromptSubmit hook.
 * 1. Scans common dev-server ports on every prompt (multi-server registry).
 * 2. Injects overlay into newly-discovered servers when possible.
 * 3. Shows live registry summary in Claude's context when 2+ servers detected.
 * 4. Primes Claude's context when user asks to start a dev server.
 * 5. Shows current VEP queue activity when processing is in progress.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const net  = require('net');

// ── Port scanning ─────────────────────────────────────────────────────────────

const SCAN_PORTS = [
  3000, 3001, 3002, 4000, 4200, 5000, 5001,
  5173, 5174, 5175, 8000, 8080, 8081, 8888, 9000, 9090,
];
const BRIDGE_PORT = parseInt(process.env.VEP_PORT || '3333', 10);

function probePort(port) {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setTimeout(200);
    sock.on('connect',  () => { sock.destroy(); resolve(true); });
    sock.on('error',    () => resolve(false));
    sock.on('timeout',  () => { sock.destroy(); resolve(false); });
  });
}

async function scanDevPorts() {
  const ports = SCAN_PORTS.filter(p => p !== BRIDGE_PORT);
  const results = await Promise.all(ports.map(async p => ({ port: p, up: await probePort(p) })));
  return results.filter(r => r.up).map(r => r.port);
}

// ── Registry helpers ──────────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(os.tmpdir(), 'vep-registry.json');

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { return { servers: {} }; }
}

function writeRegistry(registry) {
  registry.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2)); } catch {}
}

// ── Overlay injection (mirrors detect-server.js logic) ───────────────────────

const VEP_MARKER_START = '<!-- VEP:START -->';
const VEP_MARKER_END   = '<!-- VEP:END -->';

function findHtmlEntryPoint(dir) {
  for (const rel of ['index.html', 'public/index.html', 'src/index.html', 'app/index.html']) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function injectOverlay(htmlPath, bridgePort) {
  if (!htmlPath) return false;
  try {
    const content = fs.readFileSync(htmlPath, 'utf8');
    if (content.includes(VEP_MARKER_START)) return false; // already injected — idempotent
    const block = `\n${VEP_MARKER_START}\n<script src="http://localhost:${bridgePort}/overlay.js"></script>\n${VEP_MARKER_END}`;
    const updated = content.replace(/(<\/body>)/i, block + '\n$1');
    fs.writeFileSync(htmlPath, updated === content ? content + '\n' + block + '\n' : updated, 'utf8');
    return true;
  } catch { return false; }
}

// ── Stdin ─────────────────────────────────────────────────────────────────────

async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

// ── Dev server phrase detection ───────────────────────────────────────────────

const DEV_SERVER_PHRASES = [
  /start\s+.*dev\s+server/i, /run\s+.*dev/i,
  /npm\s+run\s+dev/i, /yarn\s+dev/i, /pnpm\s+dev/i,
  /start\s+.*localhost/i, /run\s+.*localhost/i,
  /start\s+.*server/i, /\bvite\b/i, /next\s+dev/i,
  /serve\s+.*port/i, /run\s+it\s+on\s+localhost/i,
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // DEBUG: proof-of-invocation (remove after confirmed working)
  try { fs.appendFileSync(path.join(os.tmpdir(), 'vep-hook-debug.log'), `[${new Date().toISOString()}] hook fired\n`); } catch {}

  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const cwd = payload.cwd || process.cwd();

  // ── 1. Multi-server port scan (runs on every prompt) ─────────────────────
  const activePorts = await scanDevPorts();
  const registry    = readRegistry();
  let registryChanged = false;

  // Update lastSeen for known servers; discover and inject new stray ones
  for (const port of activePorts) {
    const key      = String(port);
    const existing = registry.servers[key];
    if (existing) {
      existing.lastSeen   = new Date().toISOString();
      // Re-attempt injection if it failed before (e.g. index.html didn't exist yet)
      if (!existing.overlayInjected && existing.htmlEntryPoint) {
        existing.overlayInjected = injectOverlay(existing.htmlEntryPoint, BRIDGE_PORT);
      }
      registryChanged = true;
    } else {
      // Newly discovered stray server — try to inject using Claude's current project dir
      const htmlEntryPoint = findHtmlEntryPoint(cwd);
      const injected       = injectOverlay(htmlEntryPoint, BRIDGE_PORT);
      registry.servers[key] = {
        port,
        devServerUrl:    `http://localhost:${port}`,
        projectDir:      cwd,
        htmlEntryPoint,
        source:          'scan',
        overlayInjected: injected,
        discoveredAt:    new Date().toISOString(),
        lastSeen:        new Date().toISOString(),
      };
      registryChanged = true;
    }
  }

  // Prune servers gone for >30 s (avoids flapping on transient connection failures)
  for (const [key, srv] of Object.entries(registry.servers)) {
    if (!activePorts.includes(srv.port)) {
      const ageSec = (Date.now() - new Date(srv.lastSeen).getTime()) / 1000;
      if (ageSec > 30) { delete registry.servers[key]; registryChanged = true; }
    }
  }

  if (registryChanged) writeRegistry(registry);

  // Show registry summary in Claude's context when 2+ servers are running
  const serverList = Object.values(registry.servers).sort((a, b) => a.port - b.port);
  if (serverList.length >= 2) {
    const lines = [`\n🌐 VEP Servers (${serverList.length} detected):`];
    for (const srv of serverList) {
      const name          = srv.projectDir ? path.basename(srv.projectDir) : 'unknown project';
      const overlayStatus = srv.overlayInjected ? '[overlay ✓]' : '[add script tag manually]';
      const badge         = srv.source === 'hook' ? '✦' : '·';
      lines.push(`  ${badge} localhost:${srv.port} — ${name}  ${overlayStatus}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }

  // ── 2. Prime Claude when user asks to start a dev server ─────────────────
  const promptText = payload.prompt || payload.userPrompt || '';
  if (DEV_SERVER_PHRASES.some(re => re.test(promptText))) {
    process.stdout.write(
      "\n[VEP] I'll auto-detect when the dev server starts and inject the overlay. No manual setup needed.\n"
    );
    process.exit(0);
  }

  // ── 3. VEP activity (queue state) ────────────────────────────────────────
  const projectDir   = cwd
    || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vep-config.json'), 'utf8')).projectDir; } catch { return null; } })();
  const activityPath = path.join(projectDir, '.vep-activity.json');

  let activity;
  try { activity = JSON.parse(fs.readFileSync(activityPath, 'utf8')); }
  catch { process.exit(0); }

  const ageMs = Date.now() - new Date(activity.updatedAt).getTime();
  if (ageMs > 5 * 60 * 1000) process.exit(0);

  const recentlyActive = ageMs < 60 * 1000;
  if (!activity.isProcessing && activity.queue.length === 0 && !recentlyActive) process.exit(0);

  const lines = ['\n🎯 VEP (Visual Element Picker) Activity:'];
  if (activity.processing) {
    lines.push(`  ▶  Processing: "${activity.processing.userPrompt}" ← ${activity.processing.elementName}`);
  }
  activity.queue.forEach(q => {
    lines.push(`  ⏳ Queued (#${q.position}): "${q.userPrompt}" ← ${q.elementName}`);
  });
  if (!activity.isProcessing && activity.queue.length === 0 && recentlyActive) {
    lines.push(`  ✓  All edits completed at ${new Date(activity.updatedAt).toLocaleTimeString()} — check your browser.`);
  }
  lines.push('  (These are being handled automatically by the VEP bridge — no action needed.)\n');

  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

main().catch(() => process.exit(0));
