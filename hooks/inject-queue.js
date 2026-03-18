'use strict';

/**
 * UserPromptSubmit hook — Fix #5.
 * Reads .vep-activity.json from the project directory and injects
 * current VEP queue state into Claude Code's conversation context.
 * Only outputs context if VEP activity exists and is recent (<5 min).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

async function main() {
  // DEBUG: write proof-of-invocation immediately (remove after confirmed working)
  try { fs.appendFileSync(path.join(os.tmpdir(), 'vep-hook-debug.log'), `[${new Date().toISOString()}] hook fired\n`); } catch {}

  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  // Claude Code provides cwd in the stdin payload; fall back to shared config file
  const projectDir = payload.cwd
    || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vep-config.json'), 'utf8')).projectDir; } catch { return null; } })()
    || process.cwd();
  const activityPath = path.join(projectDir, '.vep-activity.json');

  let activity;
  try {
    activity = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
  } catch {
    process.exit(0); // no VEP activity — don't inject anything
  }

  // Only inject if activity is recent (last 5 minutes)
  const ageMs = Date.now() - new Date(activity.updatedAt).getTime();
  if (ageMs > 5 * 60 * 1000) process.exit(0);

  // Nothing happening — don't clutter Claude's context (but show "done" for 60s after last activity)
  const recentlyActive = (Date.now() - new Date(activity.updatedAt).getTime()) < 60 * 1000;
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
