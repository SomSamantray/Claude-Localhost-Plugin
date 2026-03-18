#!/usr/bin/env node
'use strict';

/**
 * Idempotent bridge server starter.
 * Checks if the bridge is already running before starting a new instance.
 * Usage: node scripts/start-bridge.js [port]
 */

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const port = parseInt(process.argv[2] || process.env.VEP_PORT || '3333', 10);
const bridgeScript = path.join(__dirname, '..', 'bridge', 'server.js');
const projectDirArgIdx = process.argv.indexOf('--project-dir');
const projectDirArg = projectDirArgIdx !== -1 ? process.argv[projectDirArgIdx + 1] : null;

function isPortInUse(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => { s.close(); resolve(false); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  const busy = await isPortInUse(port);
  if (busy) {
    console.log(`[VEP] Bridge already running on port ${port}.`);
    return;
  }

  console.log(`[VEP] Starting bridge server on port ${port}…`);

  // Never use shell:true — paths with spaces (e.g. C:\Program Files\nodejs\node.exe) break on Windows
  const args = [bridgeScript];
  if (projectDirArg) args.push('--project-dir', projectDirArg);
  const child = spawn(process.execPath, args, {
    detached: false,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, VEP_PORT: String(port) },
  });

  child.on('error', err => {
    console.error(`[VEP] Failed to start bridge: ${err.message}`);
    process.exit(1);
  });

  process.on('SIGINT', () => { child.kill(); process.exit(0); });
  process.on('SIGTERM', () => { child.kill(); process.exit(0); });
}

main();
