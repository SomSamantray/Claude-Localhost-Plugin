'use strict';

/**
 * PostToolUse:Bash hook — detects when a dev server starts and launches the bridge.
 * Receives tool event as JSON on stdin, outputs optional context message to stdout.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const DEV_SERVER_COMMANDS = [
  'vite', 'next dev', 'npm run dev', 'npm run start', 'yarn dev', 'yarn start',
  'pnpm dev', 'pnpm start', 'webpack serve', 'webpack-dev-server',
  'react-scripts start', 'astro dev', 'nuxt dev', 'svelte-kit dev',
  'sveltekit dev', 'remix dev', 'gatsby develop', 'parcel', 'ng serve',
  'expo start', 'rsbuild dev', 'turbopack',
];

const DEV_SERVER_STDOUT_SIGNALS = [
  'localhost:', 'local:', 'ready on http://', 'running at http://',
  'started server on', 'dev server running', 'listening on port',
  'vite', 'compiled successfully', '➜', 'network:', 'local url',
];

function isDevServerEvent(toolInput, toolResponse) {
  const command = (toolInput?.command || '').toLowerCase();
  const stdout = (
    toolResponse?.stdout || toolResponse?.output || toolResponse?.content || ''
  ).toLowerCase();

  return (
    DEV_SERVER_COMMANDS.some(kw => command.includes(kw)) ||
    DEV_SERVER_STDOUT_SIGNALS.some(kw => stdout.includes(kw))
  );
}

function extractDevServerUrl(stdout) {
  const patterns = [
    /https?:\/\/localhost:\d+/i,
    /Local:\s+(https?:\/\/[^\s]+)/i,
    /➜\s+Local:\s+(https?:\/\/[^\s]+)/i,
    /ready on\s+(https?:\/\/[^\s]+)/i,
    /running at\s+(https?:\/\/[^\s]+)/i,
  ];
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) return m[1] || m[0];
  }
  return 'http://localhost:3000';
}

function extractPort(stdout, command) {
  const m = (stdout + ' ' + command).match(/localhost:(\d+)/i);
  if (m) return parseInt(m[1], 10);
  const pFlag = command.match(/--port[=\s]+(\d+)/);
  if (pFlag) return parseInt(pFlag[1], 10);
  return 3000;
}

function findHtmlEntryPoint(projectDir) {
  const candidates = [
    'index.html',
    path.join('public', 'index.html'),
    path.join('src', 'index.html'),
    path.join('app', 'index.html'),
  ];
  for (const rel of candidates) {
    const abs = path.join(projectDir, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const VEP_MARKER_START = '<!-- VEP:START -->';
const VEP_MARKER_END   = '<!-- VEP:END -->';

function injectOverlay(htmlPath, bridgePort) {
  if (!htmlPath) return false;
  try {
    let content = fs.readFileSync(htmlPath, 'utf8');
    if (content.includes(VEP_MARKER_START)) return false; // idempotent
    const block = `\n${VEP_MARKER_START}\n<script src="http://localhost:${bridgePort}/overlay.js"></script>\n${VEP_MARKER_END}`;
    const updated = content.replace(/(<\/body>)/i, block + '\n$1');
    fs.writeFileSync(htmlPath, updated === content ? content + '\n' + block + '\n' : updated, 'utf8');
    return true;
  } catch { return false; }
}

function isPortInUse(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout safety
    setTimeout(() => resolve(data), 3000);
  });
}

async function main() {
  const raw = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolInput = payload.tool_input || {};
  const toolResponse = payload.tool_response || {};

  if (!isDevServerEvent(toolInput, toolResponse)) {
    process.exit(0);
  }

  const stdout = toolResponse.stdout || toolResponse.output || toolResponse.content || '';
  const devServerUrl = extractDevServerUrl(stdout);

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  const bridgePort = parseInt(process.env.VEP_PORT || '3333', 10);

  const port = extractPort(stdout, toolInput?.command || '');
  const htmlEntryPoint = findHtmlEntryPoint(path.normalize(projectDir));
  const injected = injectOverlay(htmlEntryPoint, bridgePort);

  // Write handoff config for bridge server
  const configPath = path.join(os.tmpdir(), 'vep-config.json');
  const config = {
    projectDir: path.normalize(projectDir),
    devServerUrl,
    port,
    htmlEntryPoint,
    pluginRoot: path.normalize(pluginRoot),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Also update the multi-server registry so bridge CORS and inject-queue both see this server
  const registryPath = path.join(os.tmpdir(), 'vep-registry.json');
  try {
    const registry = (() => {
      try { return JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
      catch { return { servers: {} }; }
    })();
    registry.servers[String(port)] = {
      port,
      devServerUrl,
      projectDir: path.normalize(projectDir),
      htmlEntryPoint,
      source: 'hook',
      overlayInjected: injected,
      discoveredAt: registry.servers[String(port)]?.discoveredAt || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    registry.updatedAt = new Date().toISOString();
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  } catch { /* non-fatal */ }

  // Start bridge if not already running
  const portBusy = await isPortInUse(bridgePort);
  if (!portBusy) {
    const bridgeScript = path.join(pluginRoot, 'bridge', 'server.js');
    const logFile = path.join(path.normalize(projectDir), '.vep-bridge.log');
    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [bridgeScript, '--project-dir', path.normalize(projectDir), '--dev-server-url', devServerUrl], {
      detached: true,
      stdio: ['ignore', logFd, logFd],  // stdout+stderr → log file (not discarded)
      shell: false,   // never shell:true — Windows paths with spaces break spawn
      env: { ...process.env, VEP_PORT: String(bridgePort) },
    });
    child.unref();
  }

  // Build injection status line for context message
  let injectionLine;
  if (injected) {
    injectionLine = `Overlay auto-injected into: ${htmlEntryPoint}`;
  } else if (htmlEntryPoint) {
    injectionLine = `NOTE: Could not write to ${htmlEntryPoint} — add the script tag manually:\n  <script src="http://localhost:${bridgePort}/overlay.js"></script>`;
  } else {
    injectionLine = `NOTE: No index.html found — add the script tag manually:\n  <script src="http://localhost:${bridgePort}/overlay.js"></script>`;
  }

  // Output message into Claude's context
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        '',
        `🎯 Visual Element Picker active (bridge on http://localhost:${bridgePort})`,
        '',
        injectionLine,
        '',
        'Open your app → click [✦ Edit] in the bottom-right → hover any element → click → type your change.',
        'Press Alt+E to toggle pick mode. App behaves normally when pick mode is off.',
        '',
        `Watch bridge logs: Get-Content -Wait "${path.join(path.normalize(projectDir), '.vep-bridge.log')}"`,
        '',
      ].join('\n'),
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => process.exit(0));
