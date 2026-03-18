'use strict';

/**
 * Visual Element Picker — Bridge Server
 *
 * Runs on localhost:3333 (or VEP_PORT).
 * Serves the browser overlay script and CSS.
 * Receives element + prompt payloads from the browser and calls `claude -p`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const resolveSource = require('./source-resolver');
const buildPrompt = require('./prompt-builder');

const PORT = parseInt(process.env.VEP_PORT || '3333', 10);
const OVERLAY_DIR = path.join(__dirname, 'overlay');
const TEMP_DIRNAME = '.vep-temp';
const CONFIG_PATH = path.join(os.tmpdir(), 'vep-config.json');

// Accept --project-dir <path> when bridge is started manually
const _argIdx = process.argv.indexOf('--project-dir');
const CLI_PROJECT_DIR = _argIdx !== -1 ? process.argv[_argIdx + 1] : null;

// ── Queue: only one claude -p at a time ──────────────────────────────────────
let isProcessing = false;
const queue = []; // { payload, res, enqueuedAt }
let processingItem = null; // currently running item

// ── Fix #5 — Beautiful terminal logging ──────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  indigo: '\x1b[38;5;99m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', white: '\x1b[97m',
};

function vepLog(icon, color, label, msg, sub) {
  const tag = `${C.dim}[VEP]${C.reset}`;
  const ico = `${color}${icon}${C.reset}`;
  const lbl = `${C.bold}${color}${label}${C.reset}`;
  const detail = sub ? ` ${C.dim}← ${sub}${C.reset}` : '';
  console.log(`${tag} ${ico}  ${lbl}: "${msg}"${detail}`);
}

function writeActivity(projectDir) {
  try {
    const activity = {
      isProcessing,
      processing: processingItem ? {
        userPrompt: processingItem.payload.userPrompt,
        elementName: processingItem.payload.element?.friendlyName || 'Element',
        enqueuedAt: processingItem.enqueuedAt,
      } : null,
      queue: queue.map((item, i) => ({
        position: i + 1,
        userPrompt: item.payload.userPrompt,
        elementName: item.payload.element?.friendlyName || 'Element',
      })),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(projectDir, '.vep-activity.json'),
      JSON.stringify(activity, null, 2)
    );
  } catch { /* non-fatal */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    if (CLI_PROJECT_DIR) {
      return { projectDir: path.normalize(CLI_PROJECT_DIR), devServerUrl: 'http://localhost:3000' };
    }
    console.warn('[VEP] WARNING: No vep-config.json found and no --project-dir arg. Pass --project-dir to target the correct project.');
    return { projectDir: process.cwd(), devServerUrl: 'http://localhost:3000' };
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function saveScreenshot(base64DataUrl, projectDir) {
  if (!base64DataUrl || !base64DataUrl.startsWith('data:image/')) return null;
  try {
    const tempDir = path.join(projectDir, TEMP_DIRNAME);
    fs.mkdirSync(tempDir, { recursive: true });
    const base64 = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filePath = path.join(tempDir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    // Return relative path (what claude -p will see from --cwd)
    return path.relative(projectDir, filePath).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function cleanOldTempFiles(projectDir) {
  try {
    const tempDir = path.join(projectDir, TEMP_DIRNAME);
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const file of fs.readdirSync(tempDir)) {
      const fp = path.join(tempDir, file);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch { /* ignore */ }
}

// ── Core: call claude -p ──────────────────────────────────────────────────────

async function runClaudeEdit(payload) {
  const config = getConfig();
  const projectDir = config.projectDir;

  const screenshotPath = saveScreenshot(payload.screenshot, projectDir);
  const sourceInfo = await resolveSource(payload, projectDir);
  const prompt = buildPrompt(payload, sourceInfo, screenshotPath);

  return new Promise((resolve, reject) => {
    // Pass the prompt via stdin to avoid:
    //   1. Windows 8191-char command-line length limit
    //   2. Shell quoting/escaping issues on all platforms
    // claude --print reads from stdin when no prompt arg is given.
    const child = spawn('claude', [
      '--print',
      '--allowedTools', 'Read,Edit,Glob,Grep',
      '--output-format', 'json',
    ], {
      cwd: projectDir,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin writable, stdout/stderr readable
    });

    // Write prompt to stdin, then close it so claude knows input is done
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      cleanOldTempFiles(projectDir);

      if (code !== 0) {
        const errMsg = stderr.trim() || `claude -p exited with code ${code}`;
        return reject(new Error(errMsg));
      }

      try {
        const parsed = JSON.parse(stdout);
        // claude --output-format json returns { result: "...", ... }
        resolve(parsed.result || parsed.message || 'Done.');
      } catch {
        resolve(stdout.trim() || 'Done.');
      }
    });

    child.on('error', err => {
      reject(new Error(
        `Could not start 'claude'. Make sure Claude Code is installed and 'claude' is in your PATH.\n${err.message}`
      ));
    });
  });
}

// ── Queue processor ───────────────────────────────────────────────────────────

async function processNext() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const item = queue.shift();
  processingItem = item;
  const { payload, res } = item;

  const config = getConfig();
  const name = payload.element?.friendlyName || 'Element';
  const prompt = payload.userPrompt;

  // Fix #5 — terminal log + activity file
  vepLog('▶', C.indigo, `Processing`, prompt, name);
  if (queue.length > 0) {
    queue.forEach((q, i) => vepLog('⏳', C.yellow, `Queued (#${i + 2})`, q.payload.userPrompt, q.payload.element?.friendlyName));
  }
  writeActivity(config.projectDir);

  const startMs = Date.now();

  try {
    const message = await runClaudeEdit(payload);
    const secs = ((Date.now() - startMs) / 1000).toFixed(1);
    vepLog('✓', C.green, `Done in ${secs}s`, prompt);
    sendJSON(res, 200, { success: true, message });
  } catch (err) {
    vepLog('✗', C.red, 'Error', err.message);
    sendJSON(res, 500, { success: false, error: err.message });
  } finally {
    isProcessing = false;
  processingItem = null;
  const cfg = getConfig();
  writeActivity(cfg.projectDir);
  processNext();
  }
}

// ── Request handlers ──────────────────────────────────────────────────────────

async function handlePrompt(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJSON(res, 400, { success: false, error: 'Could not read request body' });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJSON(res, 400, { success: false, error: 'Invalid JSON' });
  }

  if (!payload.userPrompt || !payload.element) {
    return sendJSON(res, 400, { success: false, error: 'Missing required fields: userPrompt, element' });
  }

  const item = { payload, res, enqueuedAt: new Date().toISOString() };
  queue.push(item);

  // Fix #5 — log receipt immediately so user sees it in terminal
  const name = payload.element?.friendlyName || 'Element';
  const pos = queue.length + (isProcessing ? 0 : -1);
  if (isProcessing) {
    vepLog('⏳', C.yellow, `Queued (#${queue.length})`, payload.userPrompt, name);
  } else {
    vepLog('📥', C.cyan, 'Received', payload.userPrompt, name);
  }
  writeActivity(getConfig().projectDir);

  processNext();
  // Response is deferred — sent from processNext() when claude -p finishes
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  setCors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Static assets
  if (req.method === 'GET' && urlPath === '/overlay.js') {
    return serveFile(res, path.join(OVERLAY_DIR, 'overlay.js'), 'application/javascript; charset=utf-8');
  }

  if (req.method === 'GET' && urlPath === '/overlay.css') {
    return serveFile(res, path.join(OVERLAY_DIR, 'overlay.css'), 'text/css; charset=utf-8');
  }

  // Status / health check
  if (req.method === 'GET' && urlPath === '/status') {
    const config = getConfig();
    return sendJSON(res, 200, {
      ok: true,
      version: '1.0.0',
      projectDir: config.projectDir,
      devServerUrl: config.devServerUrl,
      queueLength: queue.length,
      isProcessing,
    });
  }

  // Fix #4 — queue state for overlay badge polling
  if (req.method === 'GET' && urlPath === '/queue') {
    return sendJSON(res, 200, {
      isProcessing,
      queueLength: queue.length,
      total: queue.length + (isProcessing ? 1 : 0),
      processing: processingItem ? {
        userPrompt: processingItem.payload.userPrompt,
        elementName: processingItem.payload.element?.friendlyName,
      } : null,
      items: queue.map((item, i) => ({
        position: i + 1,
        userPrompt: item.payload.userPrompt,
        elementName: item.payload.element?.friendlyName,
      })),
    });
  }

  // Main prompt endpoint
  if (req.method === 'POST' && urlPath === '/prompt') {
    return handlePrompt(req, res);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[VEP] Bridge server listening on http://localhost:${PORT}`);
  console.log(`[VEP] Overlay script: http://localhost:${PORT}/overlay.js`);

  // Write vep-config.json so inject-queue.js (Claude Code hook) can find
  // the activity file even when bridge was started manually with --project-dir
  const startupConfig = getConfig();
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      projectDir: startupConfig.projectDir,
      devServerUrl: startupConfig.devServerUrl,
      startedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[VEP] Project dir: ${startupConfig.projectDir}`);
  } catch { /* non-fatal */ }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[VEP] Port ${PORT} is already in use. Set VEP_PORT=<port> to use a different port.`);
  } else {
    console.error('[VEP] Server error:', err.message);
  }
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
