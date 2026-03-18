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

  // Write handoff config for bridge server
  const configPath = path.join(os.tmpdir(), 'vep-config.json');
  const config = {
    projectDir: path.normalize(projectDir),
    devServerUrl,
    pluginRoot: path.normalize(pluginRoot),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Start bridge if not already running
  const portBusy = await isPortInUse(bridgePort);
  if (!portBusy) {
    const bridgeScript = path.join(pluginRoot, 'bridge', 'server.js');
    const logFile = path.join(path.normalize(projectDir), '.vep-bridge.log');
    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [bridgeScript, '--project-dir', path.normalize(projectDir)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],  // stdout+stderr → log file (not discarded)
      shell: false,   // never shell:true — Windows paths with spaces break spawn
      env: { ...process.env, VEP_PORT: String(bridgePort) },
    });
    child.unref();
  }

  // Output message into Claude's context
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        '',
        `🎯 Visual Element Picker active (bridge on http://localhost:${bridgePort})`,
        '',
        'Add this to your HTML entry point to enable in-browser element editing:',
        '',
        `  <script src="http://localhost:${bridgePort}/overlay.js"></script>`,
        '',
        'Then open your app → click [✦ Edit] in the bottom-right → hover any element → click → type your change.',
        'Press Alt+E to toggle pick mode. App behaves normally when pick mode is off.',
        '',
        `Watch bridge logs in a terminal: Get-Content -Wait "${path.join(path.normalize(projectDir), '.vep-bridge.log')}"`,
        '',
      ].join('\n'),
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => process.exit(0));
