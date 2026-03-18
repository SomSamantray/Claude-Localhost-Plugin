'use strict';

/**
 * Maps a selected DOM element back to its source file.
 * Tries strategies in order of reliability and returns on first hit.
 *
 * Returns: { file, line, method } or null
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_EXTENSIONS = ['jsx', 'tsx', 'js', 'ts', 'vue', 'svelte', 'html'];

async function resolveSource(payload, projectDir) {
  const { element = {}, sourceInfo = {} } = payload;

  // ── Strategy 1: React Fiber source (provided by overlay._debugSource) ──────
  if (sourceInfo?.componentFile) {
    // The overlay extracts this from React's __reactFiber internal
    const abs = path.resolve(projectDir, sourceInfo.componentFile);
    if (fs.existsSync(abs)) {
      return {
        file: sourceInfo.componentFile,
        line: sourceInfo.componentLine || null,
        method: 'react-fiber',
      };
    }
  }

  // Determine search root
  const srcDir = path.join(projectDir, 'src');
  const searchDir = fs.existsSync(srcDir) ? srcDir : projectDir;

  // ── Strategy 2: Most specific CSS class grep ─────────────────────────────
  const classes = (element.attributes?.class || '').trim();
  if (classes) {
    // Try classes from most specific (longest) to least
    const sorted = classes.split(/\s+/)
      .filter(c => c.length > 2 && !c.startsWith('vep-'))
      .sort((a, b) => b.length - a.length);

    for (const cls of sorted) {
      const hit = grep(cls, searchDir);
      if (hit) return { ...hit, method: 'class-grep' };
    }
  }

  // ── Strategy 3: Element ID grep ───────────────────────────────────────────
  const elId = element.attributes?.id;
  if (elId && !elId.startsWith('vep-')) {
    const hit = grep(elId, searchDir);
    if (hit) return { ...hit, method: 'id-grep' };
  }

  // ── Strategy 4: Unique text content grep ─────────────────────────────────
  const text = (element.textContent || '').trim();
  if (text.length >= 4 && text.length <= 80) {
    const hit = grep(text, searchDir);
    if (hit) return { ...hit, method: 'text-grep' };
  }

  // ── Strategy 5: Pass-through — Claude will search itself ─────────────────
  return null;
}

/**
 * Grep for `term` under `dir`, returning { file, line } of the first match.
 * Works on Windows (findstr) and Unix (grep).
 */
function grep(term, dir) {
  // Sanitize: remove characters unsafe in shell quotes
  const safe = term.replace(/[`$"\\]/g, ' ').trim();
  if (!safe) return null;

  try {
    let output;
    const extGlob = SOURCE_EXTENSIONS.join(',');

    if (process.platform === 'win32') {
      // findstr: recursive, case-insensitive, with line numbers
      // Limited glob support — search common extensions individually
      const exts = SOURCE_EXTENSIONS.map(e => `"${dir}\\*.${e}"`).join(' ');
      const cmd = `findstr /s /n /i /c:"${safe}" ${exts} 2>nul`;
      output = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
    } else {
      const cmd = `grep -rn --include="*.{${extGlob}}" "${safe}" "${dir}" 2>/dev/null`;
      output = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
    }

    const lines = output.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;

    // Format: /path/to/file.jsx:42:  <button className="btn-primary">
    const match = lines[0].match(/^(.+?):(\d+):/);
    if (!match) return null;

    return {
      file: path.relative(dir, match[1]).replace(/\\/g, '/'),
      line: parseInt(match[2], 10),
    };
  } catch {
    return null;
  }
}

module.exports = resolveSource;
