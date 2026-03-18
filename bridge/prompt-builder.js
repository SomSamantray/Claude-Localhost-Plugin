'use strict';

/**
 * Assembles the full context string sent to `claude -p`.
 * Includes: user request, element HTML/selector/styles, source hint, screenshot path.
 */

function buildPrompt(payload, sourceInfo, screenshotPath) {
  const {
    userPrompt = '',
    element = {},
    pageUrl = '',
    pageTitle = '',
  } = payload;

  // ── Element info ──────────────────────────────────────────────────────────
  const tagName = element.tagName || 'UNKNOWN';
  const cssSelector = element.cssSelector || '(unknown)';
  const outerHTML = (element.outerHTML || '').slice(0, 600);
  const textContent = (element.textContent || '').trim().slice(0, 120);

  const attrStr = Object.entries(element.attributes || {})
    .filter(([k]) => k !== 'style')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ') || '(none)';

  const relevantStyleKeys = [
    'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
    'padding', 'margin', 'borderRadius', 'border', 'display',
    'width', 'height', 'opacity', 'boxShadow', 'textDecoration',
  ];
  const styleStr = relevantStyleKeys
    .filter(k => element.computedStyles?.[k])
    .map(k => `${camelToKebab(k)}: ${element.computedStyles[k]}`)
    .join(', ') || '(unavailable)';

  // ── Source hint ───────────────────────────────────────────────────────────
  let sourceSection;
  if (sourceInfo) {
    const lineHint = sourceInfo.line ? ` (approx. line ${sourceInfo.line})` : '';
    sourceSection = `SOURCE FILE: ${sourceInfo.file}${lineHint}
Resolution method: ${sourceInfo.method}`;
  } else {
    const cls = (element.attributes?.class || '').split(/\s+/).filter(c => !c.startsWith('vep-')).join(' ');
    const txt = textContent.slice(0, 40);
    sourceSection = `SOURCE FILE: Unknown — search the codebase:
- Grep for CSS class: "${cls}"
- Grep for text content: "${txt}"
- Use Glob to find component files, then Grep within them`;
  }

  // ── Screenshot hint ───────────────────────────────────────────────────────
  const screenshotSection = screenshotPath
    ? `\nSCREENSHOT: A screenshot of the selected element is saved at: ${screenshotPath}\nRead this image to understand the visual context before making your edit.`
    : '';

  // ── Assemble ──────────────────────────────────────────────────────────────
  return `You are making a targeted UI edit to a web app. Make ONLY the change the user requested. Do not refactor, restructure, rename, or touch anything beyond the specific element.

USER REQUEST: "${userPrompt}"

SELECTED ELEMENT:
- Tag: ${tagName}
- CSS Selector: ${cssSelector}
- Attributes: ${attrStr}
- Text content: "${textContent}"
- Computed styles: ${styleStr}

ELEMENT HTML:
${outerHTML}

PAGE: ${pageTitle || '(untitled)'} — ${pageUrl || '(unknown url)'}

${sourceSection}${screenshotSection}

INSTRUCTIONS:
1. Read the source file to locate this element's definition
2. Make exactly the change requested: "${userPrompt}"
3. Use the same styling pattern the codebase already uses (Tailwind classes, CSS modules, inline styles, plain CSS — whatever is already there)
4. Do NOT touch surrounding elements, do NOT refactor or rename anything else
5. Confirm in your response: which file you edited, which line(s), and what the change was`.trim();
}

function camelToKebab(str) {
  return str.replace(/([A-Z])/g, m => `-${m.toLowerCase()}`);
}

module.exports = buildPrompt;
