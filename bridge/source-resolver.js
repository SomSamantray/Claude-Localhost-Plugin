'use strict';

/**
 * Maps a selected DOM element back to its source file.
 * Tries strategies in order of reliability and returns on first hit.
 *
 * Returns: { file, line, method } or null
 */

const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = new Set(['jsx', 'tsx', 'js', 'ts', 'vue', 'svelte', 'html']);

async function resolveSource(payload, projectDir) {
  const { element = {}, sourceInfo = {} } = payload;

  // ── Strategy 1: React Fiber source (provided by overlay._debugSource) ──────
  if (sourceInfo?.componentFile) {
    // The overlay extracts this from React's __reactFiber internal
    const abs = path.resolve(projectDir, sourceInfo.componentFile);
    // Security: ensure the resolved path stays within projectDir.
    // path.resolve() with an absolute componentFile ignores projectDir entirely,
    // allowing traversal to arbitrary files (e.g. "../../../../.env").
    const normalizedProject = path.normalize(projectDir);
    const rel = path.relative(normalizedProject, abs);
    const escapesProject = rel.startsWith('..') || path.isAbsolute(rel);
    if (!escapesProject && fs.existsSync(abs)) {
      return {
        file: sourceInfo.componentFile,
        line: sourceInfo.componentLine || null,
        method: 'react-fiber',
      };
    }
    // If path escapes projectDir, fall through silently to grep strategies
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
 * Search for `term` under `dir` using pure Node.js — no shell, no injection risk.
 * Returns { file, line } of the first match, or null.
 */
function grep(term, dir) {
  const needle = term.trim();
  if (!needle) return null;

  try {
    return walkAndSearch(dir, needle, dir);
  } catch {
    return null;
  }
}

/**
 * Recursively walk `dir`, searching each source file for `needle`.
 * Returns { file, line } on first match, null otherwise.
 */
function walkAndSearch(dir, needle, rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    // Skip hidden dirs and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const hit = walkAndSearch(fullPath, needle, rootDir);
      if (hit) return hit;
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      try {
        const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(needle)) {
            return {
              file: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
              line: i + 1,
            };
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return null;
}

module.exports = resolveSource;
