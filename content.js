/**
 * content.js — Image Viewer
 *
 * Adds View / Save / Copy buttons to images on any page, a batch
 * selection mode, hover-triggered keyboard shortcuts, an optional
 * dimensions/filesize tooltip, and reports counts to the toolbar
 * badge. The dimensions/size tooltip is configurable from the popup
 * and stored in chrome.storage.sync.
 */

(() => {
  'use strict';

  // --- Cross-browser API alias (Chrome/Edge use `chrome`, Firefox
  // exposes the same surface as a promise-based `browser`). ---------
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const PROCESSED_ATTR = 'data-ivx-processed';
  const MIN_DIMENSION = 60; // ignore icons/sprites/avatars

  const DEFAULT_SETTINGS = {
    showDimensions: true,
  };
  let settings = { ...DEFAULT_SETTINGS };

  // img -> { container, overlay, viewBtn, saveBtn, copyBtn, marker, tooltip, tooltipTimer, sizeCache }
  const registry = new Map();
  const trackedImages = new Set();
  let lastSentBadgeCount = -1;

  let hoveredImg = null;
  let batchMode = false;
  const selectedImages = new Set();

  // ---------------------------------------------------------------
  // Settings (storage) helpers
  // ---------------------------------------------------------------

  function storageGet(defaults) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      try {
        const maybePromise = api.storage.sync.get(defaults, (res) => {
          if (api.runtime.lastError) { done(defaults); return; }
          done(res || defaults);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(done).catch(() => done(defaults));
        }
      } catch {
        done(defaults);
      }
    });
  }

  storageGet(DEFAULT_SETTINGS).then((stored) => {
    settings = { ...DEFAULT_SETTINGS, ...stored };
  });

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) {
        if (key in DEFAULT_SETTINGS) settings[key] = changes[key].newValue;
      }
    });
  } catch {
    /* storage.onChanged unavailable in some contexts — settings just
       won't live-update, initial load above still applies. */
  }

  // ---------------------------------------------------------------
  // Icons
  // ---------------------------------------------------------------

  const ICONS = {
    view:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    save:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19.5h16"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
    loading:
      '<svg class="ivx-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    checkSmall:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6"/></svg>',
    select:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 6-6"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  // ---------------------------------------------------------------
  // Positioning / theme helpers
  // ---------------------------------------------------------------

  // Walk up from the <img>, looking for the ancestor that best represents
  // "this one thumbnail/tile" rather than the whole grid/column. Sites
  // like Pinterest and Instagram already wrap each tile in a
  // position:relative element (so they can absolutely-position their
  // own hover UI inside it) — reusing that element gives the most
  // reliable anchor. We fall back to the nearest similarly-sized
  // ancestor if no positioned wrapper is found.
  function getAnchorContainer(img) {
    const imgRect = img.getBoundingClientRect();
    if (imgRect.width === 0 || imgRect.height === 0) return img.parentElement || null;

    const MAX_LEVELS = 6;
    let node = img.parentElement;
    let fallback = node;
    let levels = 0;

    while (node && node !== document.body && levels < MAX_LEVELS) {
      const rect = node.getBoundingClientRect();
      const widthRatio = rect.width / imgRect.width;
      const heightRatio = rect.height / imgRect.height;
      // Height is allowed to grow more than width — captions/titles often
      // sit below the image inside the same tile.
      const sizeIsReasonable = widthRatio >= 0.85 && widthRatio <= 2.2 && heightRatio >= 0.85 && heightRatio <= 3.5;

      if (sizeIsReasonable) {
        fallback = node;
        if (window.getComputedStyle(node).position !== 'static') {
          return ensurePositioned(node);
        }
      } else if (widthRatio > 2.2) {
        // Grown past a single tile — we've hit the grid/column wrapper.
        break;
      }

      node = node.parentElement;
      levels++;
    }

    return ensurePositioned(fallback || img.parentElement);
  }

  function ensurePositioned(el) {
    if (!el) return null;
    if (window.getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
    return el;
  }

  function detectSurroundingTheme(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const luminance = colorToLuminance(window.getComputedStyle(node).backgroundColor);
      if (luminance !== null) return luminance > 140 ? 'light' : 'dark';
      node = node.parentElement;
    }
    const pageLuminance = colorToLuminance(
      window.getComputedStyle(document.body || document.documentElement).backgroundColor
    );
    if (pageLuminance !== null) return pageLuminance > 140 ? 'light' : 'dark';
    return 'light';
  }

  function colorToLuminance(colorStr) {
    const match = colorStr && colorStr.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(',').map((n) => parseFloat(n.trim()));
    if (a === 0 || Number.isNaN(r)) return null;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // ---------------------------------------------------------------
  // Image source / filename / clipboard helpers
  // ---------------------------------------------------------------

  function resolveImageSrc(img) {
    const explicit = img.getAttribute('data-src') || img.getAttribute('data-iurl');
    if (explicit) return explicit;

    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const candidates = srcset
        .split(',')
        .map((entry) => entry.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (candidates.length) return candidates[candidates.length - 1];
    }

    return img.currentSrc || img.src || '';
  }

  function suggestFilename(src, mimeType) {
    let base = null;
    try {
      const url = new URL(src, window.location.href);
      const candidate = url.pathname.split('/').pop();
      if (candidate && candidate.includes('.')) base = candidate;
    } catch {
      /* malformed or data: URL — fall through to generated name */
    }
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (base) return base;
    const ext = mimeType && mimeType.includes('/') ? mimeType.split('/')[1].split('+')[0] : 'jpg';
    return `image_${suffix}.${ext}`;
  }

  async function ensurePngBlob(blob) {
    if (blob.type === 'image/png') return blob;
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
      );
    } catch {
      return blob; // best-effort — clipboard write may reject exotic formats
    }
  }

  function formatBytes(bytes) {
    if (!bytes || Number.isNaN(bytes)) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------
  // Button UI helpers
  // ---------------------------------------------------------------

  function makeButton(iconKey, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ivx-btn';
    btn.dataset.icon = iconKey;
    btn.innerHTML = ICONS[iconKey];
    btn.title = title;
    btn.setAttribute('aria-label', title);
    return btn;
  }

  function setButtonBusy(btn, busy) {
    btn.disabled = busy;
    btn.innerHTML = busy ? ICONS.loading : ICONS[btn.dataset.icon];
  }

  function flashButton(btn, kind) {
    btn.innerHTML = ICONS[kind];
    setTimeout(() => {
      btn.innerHTML = ICONS[btn.dataset.icon];
    }, 1100);
  }

  // ---------------------------------------------------------------
  // Actions (shared by button clicks and keyboard shortcuts)
  // ---------------------------------------------------------------

  function actionView(entry) {
    const src = resolveImageSrc(entry.img);
    if (src) window.open(src, '_blank', 'noopener,noreferrer');
  }

  async function actionSave(entry, { silent = false } = {}) {
    const src = resolveImageSrc(entry.img);
    if (!src) return;
    if (!silent) setButtonBusy(entry.saveBtn, true);

    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      await sendDownload({
        url: blobUrl,
        filename: suggestFilename(src, blob.type),
        saveAs: !silent,
      });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
      if (!silent) flashButton(entry.saveBtn, 'check');
    } catch {
      if (!silent) {
        const a = document.createElement('a');
        a.href = src;
        a.download = suggestFilename(src);
        a.click();
        flashButton(entry.saveBtn, 'error');
      }
    } finally {
      if (!silent) setButtonBusy(entry.saveBtn, false);
    }
  }

  async function actionCopy(entry) {
    const src = resolveImageSrc(entry.img);
    if (!src) return;
    setButtonBusy(entry.copyBtn, true);
    try {
      const resp = await fetch(src);
      const rawBlob = await resp.blob();
      const pngBlob = await ensurePngBlob(rawBlob);
      await navigator.clipboard.write([new ClipboardItem({ [pngBlob.type]: pngBlob })]);
      flashButton(entry.copyBtn, 'check');
    } catch {
      flashButton(entry.copyBtn, 'error');
    } finally {
      setButtonBusy(entry.copyBtn, false);
    }
  }

  function sendDownload(payload) {
    return new Promise((resolve) => {
      try {
        const maybePromise = api.runtime.sendMessage({ action: 'download', ...payload }, () => resolve());
        if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(resolve).catch(resolve);
      } catch {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------
  // Dimensions / filesize tooltip
  // ---------------------------------------------------------------

  function showTooltip(entry) {
    if (!settings.showDimensions) return;
    clearTimeout(entry.tooltipTimer);
    entry.tooltipTimer = setTimeout(async () => {
      const img = entry.img;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;

      const tooltip = document.createElement('div');
      tooltip.className = 'ivx-tooltip';
      tooltip.textContent = w && h ? `${w}\u00D7${h}` : '\u2026';
      entry.container.appendChild(tooltip);
      entry.tooltip = tooltip;

      if (entry.sizeCache) {
        tooltip.textContent += `  \u00B7  ${entry.sizeCache}`;
        return;
      }

      const src = resolveImageSrc(img);
      if (!src) return;
      try {
        let resp = await fetch(src, { method: 'HEAD' });
        let len = resp.headers.get('content-length');
        if (!len) {
          resp = await fetch(src);
          len = resp.headers.get('content-length');
          if (resp.body && resp.body.cancel) resp.body.cancel().catch(() => {});
        }
        const formatted = formatBytes(parseInt(len, 10));
        if (formatted) {
          entry.sizeCache = formatted;
          if (entry.tooltip === tooltip) tooltip.textContent += `  \u00B7  ${formatted}`;
        }
      } catch {
        /* CORS or network failure — dimensions alone still shown */
      }
    }, 350);
  }

  function hideTooltip(entry) {
    clearTimeout(entry.tooltipTimer);
    if (entry.tooltip) {
      entry.tooltip.remove();
      entry.tooltip = null;
    }
  }

  // ---------------------------------------------------------------
  // Batch selection mode
  // ---------------------------------------------------------------

  function buildBatchUI() {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ivx-batch-toggle';
    toggle.innerHTML = `${ICONS.select}<span>Select images</span>`;
    toggle.addEventListener('click', () => setBatchMode(!batchMode));
    document.documentElement.appendChild(toggle);

    const bar = document.createElement('div');
    bar.className = 'ivx-batch-bar';
    bar.innerHTML = `
      <span class="ivx-batch-count">0 selected</span>
      <button type="button" class="ivx-batch-save" data-icon="save">${ICONS.save}<span>Save all</span></button>
      <button type="button" class="ivx-batch-clear"><span>Clear</span></button>
      <button type="button" class="ivx-batch-exit" aria-label="Exit batch mode">${ICONS.close}</button>
    `;
    document.documentElement.appendChild(bar);

    bar.querySelector('.ivx-batch-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (selectedImages.size === 0) return;
      setButtonBusy(btn, true);
      const targets = Array.from(selectedImages);
      for (const img of targets) {
        const entry = registry.get(img);
        if (entry) await actionSave(entry, { silent: true });
      }
      setButtonBusy(btn, false);
      flashButton(btn, 'check');
    });

    bar.querySelector('.ivx-batch-clear').addEventListener('click', () => clearSelection());
    bar.querySelector('.ivx-batch-exit').addEventListener('click', () => setBatchMode(false));

    return { toggle, bar, countEl: bar.querySelector('.ivx-batch-count') };
  }

  const batchUI = buildBatchUI();

  function setBatchMode(on) {
    batchMode = on;
    document.documentElement.classList.toggle('ivx-batch-active', batchMode);
    if (!batchMode) clearSelection();
  }

  function clearSelection() {
    for (const img of selectedImages) {
      const entry = registry.get(img);
      if (entry) entry.marker.classList.remove('ivx-selected');
    }
    selectedImages.clear();
    updateBatchCount();
  }

  function updateBatchCount() {
    batchUI.countEl.textContent = `${selectedImages.size} selected`;
  }

  function toggleSelection(entry) {
    if (selectedImages.has(entry.img)) {
      selectedImages.delete(entry.img);
      entry.marker.classList.remove('ivx-selected');
    } else {
      selectedImages.add(entry.img);
      entry.marker.classList.add('ivx-selected');
    }
    updateBatchCount();
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!batchMode) return;
      const container = e.target.closest('[data-ivx-anchor]');
      if (!container) return;
      const img = container._ivxImg;
      const entry = img && registry.get(img);
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelection(entry);
    },
    true
  );

  // ---------------------------------------------------------------
  // Overlay creation
  // ---------------------------------------------------------------

  function createOverlay(img) {
    const overlay = document.createElement('div');
    overlay.className = 'ivx-btn-container';

    const viewBtn = makeButton('view', 'View image');
    const saveBtn = makeButton('save', 'Save image');
    const copyBtn = makeButton('copy', 'Copy image');

    viewBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      actionView(registry.get(img));
    });
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      actionSave(registry.get(img));
    });
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      actionCopy(registry.get(img));
    });

    overlay.append(viewBtn, saveBtn, copyBtn);
    return { overlay, viewBtn, saveBtn, copyBtn };
  }

  function createSelectMarker(entry) {
    const marker = document.createElement('div');
    marker.className = 'ivx-select-marker';
    marker.innerHTML = ICONS.checkSmall;
    return marker;
  }

  function processImage(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (img.hasAttribute(PROCESSED_ATTR)) return;

    const rect = img.getBoundingClientRect();
    if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return;
    if (!resolveImageSrc(img)) return;

    const container = getAnchorContainer(img);
    if (!container) return;

    img.setAttribute(PROCESSED_ATTR, 'true');

    const { overlay, viewBtn, saveBtn, copyBtn } = createOverlay(img);
    overlay.dataset.ivxTheme = detectSurroundingTheme(container);
    container.appendChild(overlay);

    const entry = { img, container, overlay, viewBtn, saveBtn, copyBtn, tooltip: null, tooltipTimer: null, sizeCache: null };
    entry.marker = createSelectMarker(entry);
    container.appendChild(entry.marker);

    container.setAttribute('data-ivx-anchor', 'true');
    container._ivxImg = img;

    registry.set(img, entry);
    trackedImages.add(img);

    container.addEventListener('mouseenter', () => {
      hoveredImg = img;
      showTooltip(entry);
    });
    container.addEventListener('mouseleave', () => {
      if (hoveredImg === img) hoveredImg = null;
      hideTooltip(entry);
    });

    scheduleBadgeUpdate();
  }

  function scanForImages(root = document) {
    root.querySelectorAll('img').forEach(processImage);
  }

  // ---------------------------------------------------------------
  // Keyboard shortcuts (contextual — act on whichever image is hovered)
  // ---------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (batchMode || !hoveredImg) return;
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    const entry = registry.get(hoveredImg);
    if (!entry) return;

    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      actionView(entry);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      actionSave(entry);
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      actionCopy(entry);
    }
  });

  // ---------------------------------------------------------------
  // Toolbar badge
  // ---------------------------------------------------------------

  let badgeScheduled = false;
  function scheduleBadgeUpdate() {
    if (badgeScheduled) return;
    badgeScheduled = true;
    requestAnimationFrame(() => {
      badgeScheduled = false;
      const count = trackedImages.size;
      if (count === lastSentBadgeCount) return;
      lastSentBadgeCount = count;
      try {
        api.runtime.sendMessage({ action: 'updateBadge', count });
      } catch {
        /* extension context may be reloading — ignore */
      }
    });
  }

  // ---------------------------------------------------------------
  // Scan scheduling / MutationObserver
  // ---------------------------------------------------------------

  scanForImages();
  window.addEventListener('load', () => scanForImages(), { once: true });

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanForImages();
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        scheduleScan();
        return;
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
