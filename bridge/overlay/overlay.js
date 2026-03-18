(function () {
  'use strict';

  if (window.__VEP_LOADED__) return;
  window.__VEP_LOADED__ = true;

  // ── Config ────────────────────────────────────────────────────────────────
  const BRIDGE_PORT = parseInt(
    document.currentScript?.src?.match(/:(\d+)\//)?.[1] || '3333', 10
  );
  const BRIDGE = `http://localhost:${BRIDGE_PORT}`;

  const SKIP_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META']);

  const STYLE_KEYS = [
    'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
    'padding', 'margin', 'borderRadius', 'border', 'display',
    'flexDirection', 'width', 'height', 'opacity', 'boxShadow',
    'textDecoration', 'lineHeight', 'letterSpacing',
  ];

  const FRIENDLY_NAMES = {
    BUTTON: 'Button', A: 'Link', INPUT: 'Input', TEXTAREA: 'Textarea',
    SELECT: 'Dropdown', IMG: 'Image', VIDEO: 'Video', AUDIO: 'Audio',
    FORM: 'Form', NAV: 'Navbar', HEADER: 'Header', FOOTER: 'Footer',
    MAIN: 'Main', SECTION: 'Section', ARTICLE: 'Article', ASIDE: 'Sidebar',
    H1: 'Heading', H2: 'Heading', H3: 'Heading', H4: 'Heading',
    H5: 'Heading', H6: 'Heading', P: 'Paragraph', SPAN: 'Text',
    UL: 'List', OL: 'List', LI: 'List Item', TABLE: 'Table',
    LABEL: 'Label', DIALOG: 'Dialog', DETAILS: 'Accordion', DIV: 'Card',
    FIGURE: 'Figure', BLOCKQUOTE: 'Quote', CODE: 'Code', PRE: 'Code Block',
    SVG: 'Icon',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let state = 'INACTIVE';
  let hoveredEl = null;
  let selectedEl = null;
  let selectedData = null;

  // Status panel state
  let statusOpen = false;
  let completedHistory = [];    // max 10 {userPrompt, elementName, doneInMs, completedAt}
  let lastProcessing = null;    // currently tracked processing item
  let processingStartTime = null;
  let autoCloseTimer = null;
  let prevTotal = 0;

  // ── Load CSS ──────────────────────────────────────────────────────────────
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${BRIDGE}/overlay.css`;
  document.head.appendChild(link);

  // ── DOM Creation ──────────────────────────────────────────────────────────

  // Toggle button
  const toggleBtn = document.createElement('div');
  toggleBtn.id = 'vep-toggle-btn';
  toggleBtn.textContent = '✦ Edit';
  toggleBtn.title = 'Toggle Visual Element Picker (Alt+E)';

  // Status button
  const statusBtn = document.createElement('div');
  statusBtn.id = 'vep-status-btn';
  statusBtn.title = 'VEP Queue Status';
  statusBtn.innerHTML = `<span id="vep-status-label">⊡ Status</span><span id="vep-status-dot"></span>`;

  // Controls container — holds both buttons
  const controls = document.createElement('div');
  controls.id = 'vep-controls';
  controls.appendChild(toggleBtn);
  controls.appendChild(statusBtn);
  document.body.appendChild(controls);

  // Highlight box
  const highlight = document.createElement('div');
  highlight.id = 'vep-highlight';
  document.body.appendChild(highlight);

  // Badge — friendly element name
  const badge = document.createElement('div');
  badge.id = 'vep-badge';
  document.body.appendChild(badge);

  // Edit popup (chat bar)
  const popup = document.createElement('div');
  popup.id = 'vep-popup';
  popup.innerHTML = `
    <textarea id="vep-prompt-input" placeholder="Ask for changes" rows="1"></textarea>
    <button id="vep-send-btn" title="Send (Enter)">↑</button>
  `;
  document.body.appendChild(popup);

  // Status popup
  const statusPopup = document.createElement('div');
  statusPopup.id = 'vep-status-popup';
  statusPopup.innerHTML = `
    <div id="vep-status-header">
      <span>VEP Status</span>
      <span id="vep-status-close">✕</span>
    </div>
    <div id="vep-status-body"></div>
  `;
  document.body.appendChild(statusPopup);

  const promptInput = document.getElementById('vep-prompt-input');
  const sendBtn = document.getElementById('vep-send-btn');

  // ── Status panel open/close ───────────────────────────────────────────────
  function openStatus() {
    statusOpen = true;
    statusPopup.classList.add('vep-status-open');
    clearTimeout(autoCloseTimer);
    // Fetch immediately so popup shows current state on first frame — no "No edits yet" flash
    fetch(`${BRIDGE}/queue`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(data => renderStatusBody({
        isProcessing: data.isProcessing,
        processing: data.processing,
        items: data.items || [],
      }))
      .catch(() => renderStatusBody({ isProcessing: false, processing: null, items: [] }));
  }

  function closeStatus() {
    statusOpen = false;
    statusPopup.classList.remove('vep-status-open');
    clearTimeout(autoCloseTimer);
  }

  function toggleStatus() {
    statusOpen ? closeStatus() : openStatus();
  }

  statusBtn.addEventListener('click', toggleStatus);
  document.getElementById('vep-status-close').addEventListener('click', closeStatus);

  // ── State Machine ─────────────────────────────────────────────────────────
  function setState(newState) {
    state = newState;
    const isPickMode = state === 'PICK_MODE';
    const isSelected = state === 'ELEMENT_SELECTED';

    toggleBtn.classList.toggle('vep-active', isPickMode || isSelected);

    highlight.style.display = isPickMode ? 'block' : 'none';
    badge.style.display = isPickMode ? 'block' : 'none';
    popup.style.display = isSelected ? 'flex' : 'none';

    if (isPickMode) {
      attachPickListeners();
    } else {
      detachPickListeners();
      if (state === 'INACTIVE') {
        hoveredEl = null;
        moveHighlight(null);
      }
    }
  }

  // ── Pick listeners ────────────────────────────────────────────────────────
  const onMouseMove = e => {
    if (state !== 'PICK_MODE') return;
    const target = findTarget(e.target);
    if (target !== hoveredEl) {
      hoveredEl = target;
      moveHighlight(target);
    }
  };

  const onClick = e => {
    if (state !== 'PICK_MODE') return;
    if (e.target.closest('#vep-controls, #vep-popup, #vep-badge, #vep-status-popup')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!hoveredEl) return;
    selectElement(hoveredEl);
  };

  function attachPickListeners() {
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
  }

  function detachPickListeners() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
  }

  // ── Click outside — close edit popup ─────────────────────────────────────
  document.addEventListener('mousedown', e => {
    if (state === 'ELEMENT_SELECTED') {
      if (!popup.contains(e.target) && !controls.contains(e.target)) cancel();
    }
  }, true);

  // ── Click outside — close status popup ───────────────────────────────────
  document.addEventListener('mousedown', e => {
    if (!statusOpen) return;
    if (!statusPopup.contains(e.target) && !statusBtn.contains(e.target)) closeStatus();
  }, true);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.altKey && e.key === 'e') { e.preventDefault(); toggle(); }
    if (e.key === 'Escape') {
      if (state === 'PICK_MODE' || state === 'ELEMENT_SELECTED') cancel();
      if (statusOpen) closeStatus();
    }
    if (e.key === 'Enter' && !e.shiftKey && state === 'ELEMENT_SELECTED') {
      e.preventDefault();
      sendPrompt();
    }
  });

  function toggle() {
    if (state === 'INACTIVE') setState('PICK_MODE');
    else if (state === 'PICK_MODE') setState('INACTIVE');
    else if (state === 'ELEMENT_SELECTED') cancel();
  }

  function cancel() {
    selectedEl = null;
    selectedData = null;
    promptInput.value = '';
    setState('PICK_MODE');
  }

  toggleBtn.addEventListener('click', toggle);
  sendBtn.addEventListener('click', sendPrompt);

  // ── Element targeting ─────────────────────────────────────────────────────
  function findTarget(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (!SKIP_TAGS.has(cur.tagName) && !cur.id?.startsWith('vep-')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // ── Highlight + badge ─────────────────────────────────────────────────────
  function moveHighlight(target) {
    if (!target) {
      highlight.style.display = 'none';
      badge.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    const sx = window.scrollX, sy = window.scrollY;

    highlight.style.display = 'block';
    highlight.style.top    = `${rect.top  + sy}px`;
    highlight.style.left   = `${rect.left + sx}px`;
    highlight.style.width  = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;

    badge.style.display = 'block';
    badge.style.top  = `${rect.top + sy - 28}px`;
    badge.style.left = `${rect.left + sx}px`;
    badge.textContent = FRIENDLY_NAMES[target.tagName] || 'Element';
  }

  // ── Element selection ─────────────────────────────────────────────────────
  function selectElement(el) {
    selectedEl = el;
    selectedData = extractElementData(el);
    positionPopup(el);
    setState('ELEMENT_SELECTED');
    promptInput.focus();
  }

  function positionPopup(el) {
    const rect = el.getBoundingClientRect();
    const sy = window.scrollY, sx = window.scrollX;
    const popupW = 360;
    const margin = 10;

    const left = Math.min(rect.left + sx, window.innerWidth + sx - popupW - margin);
    popup.style.left = `${Math.max(margin + sx, left)}px`;

    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow >= 70 || rect.top < 70) {
      popup.style.top = `${rect.bottom + sy + margin}px`;
    } else {
      popup.style.top = `${rect.top + sy - 60 - margin}px`;
    }
  }

  // ── Send prompt — fire and forget ─────────────────────────────────────────
  async function sendPrompt() {
    const userPrompt = promptInput.value.trim();
    if (!userPrompt || !selectedData) return;

    const sourceInfo = selectedData._sourceInfo || null;
    const payload = {
      userPrompt,
      element: { ...selectedData, _sourceInfo: undefined },
      screenshot: null,
      pageUrl: window.location.href,
      pageTitle: document.title,
      sourceInfo,
    };

    // Disappear immediately
    const captureTarget = selectedEl;
    promptInput.value = '';
    selectedEl = null;
    selectedData = null;
    setState('PICK_MODE');

    // Capture screenshot in background
    captureElement(captureTarget).then(screenshot => {
      payload.screenshot = screenshot;
    }).catch(() => {});

    // Fire-and-forget POST
    fetch(`${BRIDGE}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  // ── Poll /queue every 2s ──────────────────────────────────────────────────
  function pollQueue() {
    fetch(`${BRIDGE}/queue`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(data => {
        const { total, isProcessing, processing, items } = data;

        // Track completed items: if lastProcessing disappeared, record it
        if (lastProcessing && (!isProcessing || (processing && processing.userPrompt !== lastProcessing.userPrompt))) {
          const doneInMs = processingStartTime ? Date.now() - processingStartTime : null;
          completedHistory.unshift({
            userPrompt: lastProcessing.userPrompt,
            elementName: lastProcessing.elementName,
            doneInMs,
            completedAt: new Date(),
          });
          if (completedHistory.length > 10) completedHistory.length = 10;
          lastProcessing = null;
          processingStartTime = null;
        }
        if (isProcessing && processing) {
          if (!lastProcessing || lastProcessing.userPrompt !== processing.userPrompt) {
            lastProcessing = { ...processing };
            processingStartTime = Date.now();
          }
        }

        // Auto-open status popup when new request arrives
        if (total > prevTotal && !statusOpen) openStatus();
        prevTotal = total;

        // Auto-close 4s after queue fully empties
        if (total === 0) {
          if (statusOpen && !autoCloseTimer) {
            autoCloseTimer = setTimeout(closeStatus, 4000);
          }
        } else {
          clearTimeout(autoCloseTimer);
          autoCloseTimer = null;
        }

        // Update status button dot
        const dot = document.getElementById('vep-status-dot');
        if (dot) {
          if (total > 0) dot.classList.add('vep-dot-active');
          else dot.classList.remove('vep-dot-active');
        }

        // Update Edit toggle button text
        toggleBtn.dataset.queue = total;
        if (state === 'INACTIVE') {
          toggleBtn.textContent = total > 0 ? `✦ Edit (${total})` : '✦ Edit';
          toggleBtn.classList.toggle('vep-active', total > 0);
        } else if (state === 'PICK_MODE') {
          toggleBtn.textContent = total > 0 ? `✕ Exit (${total})` : '✕ Exit';
        }

        // Render status popup body (always — so data is ready when user opens)
        renderStatusBody({ isProcessing, processing, items: items || [] });
      })
      .catch(() => {});
  }
  setInterval(pollQueue, 2000);

  // ── Render status popup body ──────────────────────────────────────────────
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderStatusBody({ isProcessing, processing, items }) {
    const body = document.getElementById('vep-status-body');
    if (!body) return;

    const totalActive = (isProcessing ? 1 : 0) + items.length;

    if (totalActive === 0 && completedHistory.length === 0) {
      body.innerHTML = `
        <div class="vep-status-empty">
          <span class="vep-status-empty-icon">✦</span>
          <span>No edits yet</span>
          <span class="vep-status-empty-sub">Pick an element and type a prompt</span>
        </div>`;
      return;
    }

    let html = '';

    // PROCESSING section
    if (isProcessing && processing) {
      html += `<div class="vep-status-section-label">Processing</div>`;
      html += `<div class="vep-status-item vep-status-processing">
        <div class="vep-status-item-icon">
          <div class="vep-spinner-wrap">
            <div class="vep-spinner"></div>
            <div class="vep-pulse-dot"></div>
          </div>
        </div>
        <div class="vep-status-item-text">
          <div class="vep-status-item-prompt">${esc(processing.userPrompt)}</div>
          <div class="vep-status-item-meta">${esc(processing.elementName)}</div>
        </div>
      </div>`;
    }

    // QUEUED section
    if (items.length > 0) {
      html += `<div class="vep-status-section-label">Queued</div>`;
      items.forEach(q => {
        html += `<div class="vep-status-item">
          <div class="vep-status-item-icon vep-icon-queue">⏳</div>
          <div class="vep-status-item-text">
            <div class="vep-status-item-prompt">${esc(q.userPrompt)}</div>
            <div class="vep-status-item-meta">${esc(q.elementName)}</div>
          </div>
        </div>`;
      });
    }

    // COMPLETED section
    if (completedHistory.length > 0) {
      html += `<div class="vep-status-section-label">Completed</div>`;
      completedHistory.forEach(c => {
        const doneStr = c.doneInMs != null ? `Done in ${Math.round(c.doneInMs / 1000)}s · ` : '';
        const timeStr = c.completedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += `<div class="vep-status-item vep-status-done">
          <div class="vep-status-item-icon vep-icon-done">✓</div>
          <div class="vep-status-item-text">
            <div class="vep-status-item-prompt">${esc(c.userPrompt)}</div>
            <div class="vep-status-item-meta">${esc(c.elementName)} · ${doneStr}${timeStr}</div>
          </div>
        </div>`;
      });
    }

    body.innerHTML = html;
  }

  // ── Element data extraction ───────────────────────────────────────────────
  function extractElementData(el) {
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    const attributes = {};
    for (const attr of el.attributes) attributes[attr.name] = attr.value;

    const computedStyles = {};
    for (const key of STYLE_KEYS) {
      const val = computed[key];
      if (val && val !== '' && val !== 'normal' && val !== 'auto' && val !== 'none') {
        computedStyles[key] = val;
      }
    }

    return {
      tagName: el.tagName,
      friendlyName: FRIENDLY_NAMES[el.tagName] || 'Element',
      outerHTML: el.outerHTML.slice(0, 800),
      cssSelector: getCssSelector(el),
      textContent: (el.textContent || '').trim().slice(0, 200),
      attributes,
      computedStyles,
      boundingBox: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top  + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      _sourceInfo: getReactSource(el),
    };
  }

  // ── React Fiber source ────────────────────────────────────────────────────
  function getReactSource(el) {
    try {
      const key = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (!key) return null;
      let fiber = el[key];
      while (fiber) {
        const src = fiber._debugSource || fiber._debugOwner?._debugSource;
        if (src?.fileName) return {
          componentName: fiber._debugOwner?.type?.displayName || fiber._debugOwner?.type?.name || null,
          componentFile: src.fileName,
          componentLine: src.lineNumber || null,
        };
        fiber = fiber.return;
      }
    } catch { /* non-React */ }
    return null;
  }

  // ── CSS Selector ──────────────────────────────────────────────────────────
  function getCssSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id && !cur.id.startsWith('vep-')) {
        seg += `#${cur.id}`; parts.unshift(seg); break;
      }
      const cls = [...cur.classList].filter(c => !c.startsWith('vep-')).slice(0, 3);
      if (cls.length) seg += '.' + cls.join('.');
      if (cur.parentElement) {
        const sibs = [...cur.parentElement.children].filter(s => s.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Screenshot (optional) ─────────────────────────────────────────────────
  const H2C = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';

  async function captureElement(el) {
    if (!el) return null;
    try {
      if (!window.html2canvas) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = H2C; s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const canvas = await window.html2canvas(el, { useCORS: true, scale: 2, logging: false });
      return canvas.toDataURL('image/png');
    } catch { return null; }
  }

  // ── Scroll/resize: keep highlight in sync ─────────────────────────────────
  window.addEventListener('scroll', () => {
    if (hoveredEl && state === 'PICK_MODE') moveHighlight(hoveredEl);
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (hoveredEl && state === 'PICK_MODE') moveHighlight(hoveredEl);
  }, { passive: true });

  console.log(`[VEP] Loaded. Bridge: ${BRIDGE}. Click [✦ Edit] or press Alt+E.`);
})();
