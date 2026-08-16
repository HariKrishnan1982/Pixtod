/**
 * content.js — Pixtod
 *
 * Adds View / Save / Copy buttons to images on any page, a batch
 * selection mode (with zip export + duplicate detection), hover-
 * triggered keyboard shortcuts, an optional dimensions/filesize
 * tooltip, and reports counts/stats to the toolbar badge & popup.
 * Settings (dimensions tooltip, overlay corner) are stored in
 * chrome.storage.sync.
 */

(() => {
  'use strict';

  // Standalone image document (i.e. the tab opened by "View image"
  // itself, or a direct image:// navigation). content_scripts match
  // <all_urls>, so this file runs there too. Previously this bailed
  // out entirely, because forcing `position: relative` onto <body>
  // (the normal anchor-container path, below) can knock Firefox's
  // native image-centering out, making the image jump to the
  // top-left instead of staying centered. Handled properly now via
  // initStandaloneImagePage() further down, which never touches the
  // page's own layout — the overlay is a fixed-position element
  // tracked against the image's own rect instead of nested inside it.
  const STANDALONE_IMAGE_DOC = !!(document.contentType && document.contentType.startsWith('image/'));

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const PROCESSED_ATTR = 'data-ivx-processed';
  const MIN_DIMENSION = 60; // ignore icons/sprites/avatars

  const DEFAULT_SETTINGS = {
    showDimensions: true,
    overlayPosition: 'top-right', // 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
    saveFormat: 'original', // 'original' | 'png' | 'jpeg' | 'webp'
    disabledSites: [], // hostnames where Pixtod is switched off, set from the popup
    copyUrlButtonEnabled: false, // extra "Copy image URL" button, off by default
    reverseSearchEngine: 'google', // 'google' | 'bing' | 'yandex' | 'tineye'
    masterKey: 'shift', // 'shift' | 'ctrl' | 'alt' — the held-down trigger for every shortcut below
    shortcutView: 'v',
    shortcutSave: 's',
    shortcutCopy: 'c',
    shortcutSearch: 'f',
    shortcutFrame: 'g',
  };
  let settings = { ...DEFAULT_SETTINGS };

  function isSiteDisabled() {
    return Array.isArray(settings.disabledSites) && settings.disabledSites.includes(window.location.hostname);
  }

  // A CSS-level kill switch — cheap to apply/undo instantly (including
  // from a live storage.onChanged event, with no teardown of the
  // scanner/observer needed) and it also covers overlays on images
  // that get (re)registered after the toggle flips.
  function applyDisabledState() {
    document.documentElement.setAttribute('data-ivx-disabled', isSiteDisabled() ? 'true' : 'false');
  }

  // img -> { container, overlay, viewBtn, saveBtn, copyBtn, marker, tooltip, tooltipTimer, sizeCache, hasHighRes }
  const registry = new Map();
  let lastSentBadgeCount = -1;

  let hoveredImg = null;
  let hoveredVideo = null;
  let batchMode = false;
  const selectedImages = new Set();

  // A native browser dialog (e.g. the OS "Save As" picker triggered by
  // Chrome's own "ask where to save each file" setting) steals window
  // focus without the page ever getting a normal mouseleave — so
  // hoveredVideo/hoveredImg can be left pointing at whatever was under
  // the cursor when the dialog opened. On return, that stale hover
  // state can keep an overlay pinned visible (or, combined with a
  // second video entry, look like a stray duplicate icon) until the
  // mouse happens to cross it again. Clearing hover on any window blur
  // is a safe, cheap reset — it just means the button needs a fresh
  // mouseenter to reappear, same as normal hover behavior.
  window.addEventListener('blur', () => {
    hoveredImg = null;
    hoveredVideo = null;
  });

  // Pairs with the blur handler above. Some browsers don't recompute
  // :hover (or refire mouseenter/mouseleave) purely because a native
  // dialog closed and focus returned to the page — they wait for an
  // actual pointer *movement* afterward. If the cursor was already
  // resting on the image/video before the dialog opened, it can still
  // be sitting in that exact spot when the dialog closes, so no such
  // movement ever happens and a CSS-hover-driven overlay can stay
  // invisible indefinitely even though the mouse is right on it. Track
  // the last known pointer position, and on refocus, check what's
  // actually there and reassert the overlay directly instead of
  // waiting on a hover recomputation that may never come.
  let lastMouseX = 0;
  let lastMouseY = 0;
  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true, capture: true });

  window.addEventListener('focus', () => {
    requestAnimationFrame(() => {
      const el = document.elementFromPoint(lastMouseX, lastMouseY);
      if (!el) return;

      const anchor = el.closest('[data-ivx-anchor]');
      if (anchor && anchor._ivxImg) {
        const entry = registry.get(anchor._ivxImg);
        if (entry) {
          hoveredImg = entry.img;
          updateSearchAvailability(entry);
          reassertOverlay(entry);
          entry.overlay.classList.add('ivx-visible');
          showTooltip(entry);
          prepareCopyBlob(entry);
        }
      }

      const videoEl = el.closest('video');
      if (videoEl) {
        let entry = videoRegistry.get(videoEl);
        if (!entry) {
          for (const e of videoRegistry.values()) {
            if ((e.candidates || [e.video]).includes(videoEl)) { entry = e; break; }
          }
        }
        if (entry) hoveredVideo = entry.key;
      }
    });
  });

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
    applyOverlayPosition();
    applyDisabledState();
    applyImageButtonSettings();
    refreshAllShortcutHints();
  });

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) {
        if (key in DEFAULT_SETTINGS) settings[key] = changes[key].newValue;
      }
      applyOverlayPosition();
      applyDisabledState();
      applyImageButtonSettings();
      refreshAllShortcutHints();
    });
  } catch {
    /* storage.onChanged unavailable in some contexts — settings just
       won't live-update, initial load above still applies. */
  }

  function applyOverlayPosition() {
    document.documentElement.setAttribute('data-ivx-pos', settings.overlayPosition || 'top-right');
  }

  // CSS-level show/hide for the optional "Copy image URL" button —
  // same pattern as applyDisabledState: cheap to flip live and covers
  // buttons created both before and after the toggle changes.
  function applyImageButtonSettings() {
    document.documentElement.setAttribute('data-ivx-copyurl', settings.copyUrlButtonEnabled ? 'true' : 'false');
  }

  // ---------------------------------------------------------------
  // Background messaging helpers
  // ---------------------------------------------------------------

  function callBackground(payload) {
    return new Promise((resolve) => {
      try {
        const maybePromise = api.runtime.sendMessage(payload, (response) => resolve(response));
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(resolve).catch(() => resolve(undefined));
        }
      } catch {
        resolve(undefined);
      }
    });
  }

  function sendDownload(payload) {
    return callBackground({ action: 'download', ...payload });
  }

  // A blob: URL created here belongs to this document and is not
  // always resolvable from the background script when handed over as
  // a plain string (most reliably reproducible on Firefox, but not
  // exclusive to it) — that previously could fail a save silently.
  // Firefox's runtime.sendMessage uses the structured clone algorithm
  // and can carry an actual Blob across that boundary natively, so on
  // Firefox this sends the Blob itself and lets background.js mint
  // its own object URL in the context that actually reads it. Chrome
  // still JSON-serializes extension messages by default (a raw Blob
  // would arrive as `{}`), so this keeps the existing blob:-URL
  // approach there.
  function sendBlobDownload(blob, filename, saveAs) {
    if (typeof browser !== 'undefined') {
      return sendDownload({ blob, filename, saveAs });
    }
    const blobUrl = URL.createObjectURL(blob);
    return sendDownload({ url: blobUrl, filename, saveAs }).then((result) => {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
      return result;
    });
  }

  async function checkDuplicates(urls) {
    const res = await callBackground({ action: 'checkDuplicates', urls });
    return (res && res.duplicates) || [];
  }

  function markSaved(urls) {
    return callBackground({ action: 'markSaved', urls });
  }

  function recordHistory(records) {
    return callBackground({ action: 'addHistory', records });
  }

  function makeHistoryRecord(src, filename) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url: src,
      filename,
      site: window.location.hostname,
      pageUrl: window.location.href,
      savedAt: Date.now(),
      favorite: false,
      tags: [],
    };
  }

  function reportBadge(count, fullRes, thumbnailOnly) {
    try {
      api.runtime.sendMessage({ action: 'updateBadge', count, fullRes, thumbnailOnly });
    } catch {
      /* extension context may be reloading — ignore */
    }
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
    zip:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v3M12 8v2M12 12v2M12 16v2"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>',
    camera:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
    link:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15 15 9"/><path d="M10.5 6.5 12 5a4 4 0 1 1 5.5 5.5L16 12"/><path d="M13.5 17.5 12 19a4 4 0 1 1-5.5-5.5L8 12"/></svg>',
  };

  // Icon markup above is a fixed, hardcoded set of SVGs baked into
  // this file — never built from page or network data — but linters
  // (AMO's included) flag any dynamic innerHTML assignment regardless
  // of whether the source is trusted, since they can't verify that
  // statically. Parsing each icon once into a real SVG node and
  // cloning it on each use sidesteps that entirely: no innerHTML
  // anywhere, and it's cheaper than re-parsing the same markup string
  // repeatedly besides.
  const iconNodeCache = {};
  function getIconNode(key) {
    if (!iconNodeCache[key]) {
      const parsed = new DOMParser().parseFromString(ICONS[key], 'image/svg+xml');
      iconNodeCache[key] = parsed.documentElement;
    }
    return iconNodeCache[key].cloneNode(true);
  }
  function setIcon(el, key) {
    el.replaceChildren(getIconNode(key));
  }

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
      const sizeIsReasonable = widthRatio >= 0.85 && widthRatio <= 2.2 && heightRatio >= 0.85 && heightRatio <= 3.5;

      if (sizeIsReasonable) {
        fallback = node;
        if (window.getComputedStyle(node).position !== 'static') {
          return ensurePositioned(node);
        }
      } else if (widthRatio > 2.2) {
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

  function hasHighResHint(img) {
    return Boolean(img.getAttribute('data-src') || img.getAttribute('data-iurl') || img.getAttribute('srcset'));
  }

  const usedFilenames = new Set();
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|ico)$/i;
  function suggestFilename(src, mimeType, fallbackBase) {
    let base = null;
    try {
      const url = new URL(src, window.location.href);
      const candidate = url.pathname.split('/').pop();
      // Only trust the URL's own last path segment if it actually
      // ends in a real image extension. Previously any segment
      // containing *a* dot was accepted outright — which meant a
      // hostname-derived name like "frame-www.youtube.com" (used for
      // video-frame capture filenames) got treated as if ".com" were
      // its file extension, producing a file with no real extension
      // at all (no image association, "PREVIEW UNAVAILABLE", generic
      // OS icon).
      if (candidate && IMAGE_EXT_RE.test(candidate)) base = candidate;
    } catch {
      /* malformed or data: URL — fall through to generated name */
    }
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ext = mimeType && mimeType.includes('/') ? mimeType.split('/')[1].split('+')[0] : 'jpg';
    const prefix = fallbackBase ? `${String(fallbackBase).replace(/[^a-z0-9._-]/gi, '_')}-${suffix}` : `image_${suffix}`;
    let name = base || `${prefix}.${ext}`;
    // Guarantee uniqueness (matters most when bundling many into one zip).
    let n = 1;
    const dot = name.lastIndexOf('.');
    const stem = dot > -1 ? name.slice(0, dot) : name;
    const extPart = dot > -1 ? name.slice(dot) : '';
    while (usedFilenames.has(name)) {
      name = `${stem}-${n}${extPart}`;
      n++;
    }
    usedFilenames.add(name);
    return name;
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
      return blob;
    }
  }

  const FORMAT_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

  // Convert a fetched image blob to the user's preferred save format
  // (settings.saveFormat). 'original' (the default) is a no-op — this
  // only kicks in for an explicit png/jpeg/webp choice. JPEG has no
  // alpha channel, so it's painted onto a white backing canvas first
  // rather than silently going transparent-to-black.
  async function convertBlob(blob, format) {
    if (!format || format === 'original') return blob;
    const targetMime = FORMAT_MIME[format];
    if (!targetMime || blob.type === targetMime) return blob;
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (format === 'jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      const quality = format === 'png' ? undefined : 0.92;
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), targetMime, quality)
      );
    } catch {
      // Conversion isn't always possible (e.g. a tainted canvas from a
      // cross-origin image without CORS headers) — fall back to
      // whatever was actually fetched rather than failing the save.
      return blob;
    }
  }

  function formatBytes(bytes) {
    if (!bytes || Number.isNaN(bytes)) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------
  // Minimal ZIP writer (STORE method — no compression, no deps)
  // ---------------------------------------------------------------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildZip(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const centralOffset = offset;

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  // ---------------------------------------------------------------
  // Button UI helpers
  // ---------------------------------------------------------------

  function makeButton(iconKey, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ivx-btn';
    btn.dataset.icon = iconKey;
    setIcon(btn, iconKey);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    return btn;
  }

  function setButtonBusy(btn, busy) {
    btn.disabled = busy;
    setIcon(btn, busy ? 'loading' : btn.dataset.icon);
  }

  function flashButton(btn, kind) {
    setIcon(btn, kind);
    setTimeout(() => {
      setIcon(btn, btn.dataset.icon);
    }, 1100);
  }

  // ---------------------------------------------------------------
  // Actions (shared by button clicks and keyboard shortcuts)
  // ---------------------------------------------------------------

  function actionView(entry) {
    const src = resolveImageSrc(entry.img);
    if (src) window.open(src, '_blank', 'noopener,noreferrer');
  }

  // Each engine's own reverse-search-by-URL endpoint. All four need a
  // URL they can fetch themselves, so this only works for http(s)
  // sources — data: and blob: URLs (inline/generated images) have
  // nothing a remote search engine can reach, so the button is
  // skipped for those at overlay-build time regardless of which
  // engine is selected.
  const REVERSE_SEARCH_URL_BUILDERS = {
    google: (src) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(src)}`,
    bing: (src) => `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIIRP&sbisrc=UrlPaste&q=imgurl:${encodeURIComponent(src)}`,
    yandex: (src) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(src)}`,
    tineye: (src) => `https://tineye.com/search?url=${encodeURIComponent(src)}`,
  };

  // Reverse image search, using whichever engine is set in the popup
  // (defaults to Google Lens).
  function actionSearch(entry) {
    const src = resolveImageSrc(entry.img);
    if (!src) return;
    const build = REVERSE_SEARCH_URL_BUILDERS[settings.reverseSearchEngine] || REVERSE_SEARCH_URL_BUILDERS.google;
    window.open(build(src), '_blank', 'noopener,noreferrer');
  }

  // Copies just the resolved image URL as text — a separate, optional
  // action from Copy (which copies the actual decoded pixels). Off by
  // default; enabled from Settings → Image.
  async function actionCopyUrl(entry) {
    const src = resolveImageSrc(entry.img);
    if (!src) return;
    try {
      await navigator.clipboard.writeText(src);
      flashButton(entry.copyUrlBtn, 'check');
    } catch {
      flashButton(entry.copyUrlBtn, 'error');
    }
  }

  // Reads pixels straight out of the already-rendered <img> (or
  // <video>) element via canvas — zero network round trip — instead
  // of re-fetching bytes that the browser already decoded once to
  // paint the page. Throws (typically SecurityError) if the element
  // is a tainted cross-origin resource loaded without CORS headers,
  // in which case callers fall back to a real fetch.
  async function elementToBlob(el, mime, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth || el.videoWidth || el.width;
    canvas.height = el.naturalHeight || el.videoHeight || el.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    ctx.getImageData(0, 0, 1, 1); // force the taint check synchronously
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality)
    );
  }

  // Chrome phrases this "USER_CANCELED" (user, then cancel); Firefox
  // phrases its own rejection the other way round — "Download
  // canceled by the user" — so a regex anchored to "user" immediately
  // followed by "cancel" only ever matched Chrome's wording and quietly
  // let every Firefox cancellation fall through to the retry/fallback
  // chain below. Matching on "cancel" alone, order-independent, covers
  // both.
  function isCancelError(msg) {
    return /cancel/i.test(String(msg || ''));
  }

  async function actionSave(entry, { silent = false } = {}) {
    const src = resolveImageSrc(entry.img);
    if (!src) return;
    // Guards against the action firing twice for the same entry (e.g.
    // a click and the Shift+S shortcut landing back-to-back, or a
    // double-click before the button's disabled state has painted) —
    // without this, both calls run in parallel and each successfully
    // triggers its own real download, so the same image saves twice.
    if (entry._saving) return;
    entry._saving = true;
    if (!silent) setButtonBusy(entry.saveBtn, true);

    try {
      // Fast path: no format conversion requested (the common case —
      // 'original' is the default). Hand the URL straight to the
      // downloads API, which fetches it inside the browser's own
      // download manager rather than through this page's fetch() —
      // that sidesteps CORS entirely (fetch() often can't read
      // cross-origin image bytes even though the <img> tag displays
      // them fine) and skips a slow, redundant re-download of
      // something the browser already has.
      if (!settings.saveFormat || settings.saveFormat === 'original') {
        const filename = suggestFilename(src);
        const result = await sendDownload({ url: src, filename, saveAs: !silent });
        if (result && result.ok === false) throw new Error(result.error || 'download failed');
        markSaved([src]);
        recordHistory([makeHistoryRecord(src, filename)]);
        if (!silent) flashButton(entry.saveBtn, 'check');
        return;
      }

      // A specific format was requested, so the pixels need decoding
      // through a canvas anyway — try the already-loaded <img> first
      // (instant), and only reach for the network if that's tainted.
      let blob;
      try {
        blob = await convertBlob(await elementToBlob(entry.img, 'image/png'), settings.saveFormat);
      } catch {
        const resp = await fetch(src);
        const rawBlob = await resp.blob();
        blob = await convertBlob(rawBlob, settings.saveFormat);
      }
      const filename = suggestFilename(src, blob.type);
      const result = await sendBlobDownload(blob, filename, !silent);
      // background.js now reports success/failure explicitly instead of
      // firing-and-forgetting — this used to be more fragile before
      // the Blob itself was handed across the messaging boundary (see
      // sendBlobDownload above).
      if (result && result.ok === false) throw new Error(result.error || 'download failed');
      markSaved([src]);
      recordHistory([makeHistoryRecord(src, filename)]);
      if (!silent) flashButton(entry.saveBtn, 'check');
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      // The user dismissing the Save dialog reports back as a normal
      // error (Chrome delivers it as runtime.lastError: "USER_CANCELED"),
      // indistinguishable at this point from a real failure — but it
      // means "I chose not to save this", not "retry me". Treating it
      // like any other failure was what triggered another Save dialog
      // right after they'd just closed one, and if that got dismissed
      // too, fell all the way through to the <a> click fallback, which
      // for a cross-origin image just opens/displays it instead of
      // downloading — exactly the "views the image" symptom. Respect
      // the cancellation and stop here instead.
      if (isCancelError(msg)) {
        return; // finally below resets the button icon quietly
      }
      if (!silent) {
        console.warn('[Pixtod] save failed, falling back to direct download:', err);
        // Route the fallback through the downloads API too (server-side
        // fetch, no CORS) rather than an <a download> click, which
        // browsers silently ignore the `download` attribute for on
        // cross-origin URLs — that looked like "nothing happens" rather
        // than an actual error.
        try {
          const result = await sendDownload({ url: src, filename: suggestFilename(src), saveAs: true });
          if (result && result.ok !== false) { flashButton(entry.saveBtn, 'check'); return; }
          if (result && isCancelError(result.error)) return; // respect a cancel here too
        } catch {
          /* fall through to the last-resort <a> click below */
        }
        const a = document.createElement('a');
        a.href = src;
        a.download = suggestFilename(src);
        a.click();
        flashButton(entry.saveBtn, 'error');
      }
    } finally {
      entry._saving = false;
      if (!silent) setButtonBusy(entry.saveBtn, false);
    }
  }

  // The canvas draw itself is instant, but re-encoding the pixels as a
  // PNG (canvas.toBlob) is genuine CPU work that scales with image
  // size — for a large photo that's real, visible time between click
  // and the clipboard actually being populated, even though no
  // network is involved. Preparing that blob ahead of the click (see
  // the IntersectionObserver + hover triggers below) overlaps the
  // encode with time the user spends looking at / moving toward the
  // image, so by the time actionCopy runs the blob is already sitting
  // in cache and the actual clipboard write is the only remaining
  // step. Keyed on the resolved src so a lazy-loaded placeholder-to-
  // real-image swap invalidates the stale cached copy instead of
  // serving it. Returns the in-flight/settled promise so callers that
  // want to wait for it (the prefetch queue below) can.
  // Same background-context bypass Save already relies on (see
  // background.js's fetchImageBytes handler) — reads cross-origin
  // image bytes without hitting the page-level CORS wall that a
  // content-script fetch() is stuck behind.
  async function fetchViaBackground(src) {
    const result = await callBackground({ action: 'fetchImageBytes', url: src });
    if (!result || result.ok === false || !result.buf) {
      throw new Error((result && result.error) || 'background fetch failed');
    }
    return new Blob([result.buf], { type: result.mime || 'application/octet-stream' });
  }

  function prepareCopyBlob(entry) {
    const src = resolveImageSrc(entry.img);
    if (!src) return Promise.resolve(null);
    const cache = entry.copyCache;
    if (cache.src === src && cache.blob) return Promise.resolve(cache.blob);
    if (cache.src === src && cache.promise) return cache.promise;
    cache.src = src;
    cache.blob = null;
    cache.promise = (async () => {
      let blob = null;
      try {
        blob = await elementToBlob(entry.img, 'image/png');
      } catch {
        // Cross-origin image without CORS headers taints the canvas —
        // very common on the real web, since most sites don't set
        // crossorigin on their <img> tags. The background-context
        // fetch above isn't bound by that restriction (same reason
        // Save already worked reliably here), so try that first; a
        // page-level fetch is kept as a last-resort fallback in case
        // the background context is ever unreachable.
        try {
          const rawBlob = await fetchViaBackground(src);
          blob = await ensurePngBlob(rawBlob);
        } catch {
          try {
            const resp = await fetch(src);
            const rawBlob = await resp.blob();
            blob = await ensurePngBlob(rawBlob);
          } catch {
            blob = null;
          }
        }
      }
      if (cache.src === src) cache.blob = blob;
      return blob;
    })();
    cache.promise.finally(() => {
      if (cache.src === src) cache.promise = null;
    });
    return cache.promise;
  }

  // Preparing every image's copy blob the instant it's discovered
  // would burn CPU on images the user never touches (long feeds can
  // have hundreds). Preparing only on hover is cheap but leaves a real
  // gap on the very first click if the user moves from image to
  // button faster than the encode finishes. Splitting the difference:
  // as soon as a thumbnail actually scrolls into the viewport (so
  // it's something the user is plausibly about to interact with), its
  // copy blob is queued for background preparation — one at a time,
  // during browser idle time, so a screen full of images can't stall
  // the page by encoding them all simultaneously.
  const copyPrefetchQueue = [];
  let copyPrefetchRunning = false;
  const runIdle = typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 50);

  function runCopyPrefetchQueue() {
    if (copyPrefetchRunning) return;
    const step = () => {
      const entry = copyPrefetchQueue.shift();
      if (!entry) { copyPrefetchRunning = false; return; }
      copyPrefetchRunning = true;
      prepareCopyBlob(entry).finally(() => runIdle(step));
    };
    step();
  }

  function queueCopyPrefetch(entry) {
    if (entry.copyCache.blob || entry.copyCache.promise) return; // already warm/warming
    copyPrefetchQueue.push(entry);
    runCopyPrefetchQueue();
  }

  const copyViewportObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (observed) => {
          for (const obs of observed) {
            if (!obs.isIntersecting) continue;
            copyViewportObserver.unobserve(obs.target);
            const entry = registry.get(obs.target._ivxImg);
            if (entry) queueCopyPrefetch(entry);
          }
        },
        { rootMargin: '200px' } // start a little before it's actually on-screen
      )
    : null;

  // Removes any one-time browser-side setup cost (encoder init, color
  // management setup) from the user's very first real copy, by paying
  // it once up front on a throwaway 1x1 canvas instead of on their
  // first actual click.
  try {
    const warm = document.createElement('canvas');
    warm.width = 1;
    warm.height = 1;
    warm.getContext('2d').fillRect(0, 0, 1, 1);
    warm.toBlob(() => {}, 'image/png');
  } catch {
    /* best-effort — a failure here just means no warm-up, not a bug */
  }


  async function actionCopy(entry) {
    const src = resolveImageSrc(entry.img);
    if (!src) return;
    if (entry._copying) return;
    entry._copying = true;
    setButtonBusy(entry.copyBtn, true);
    try {
      // The Clipboard API only allows writing during a short window of
      // "user activation" tied to the click. Awaiting anything (even a
      // near-instant, already-cached promise) BEFORE calling
      // clipboard.write() can burn through that window on some
      // browsers (Firefox and Safari enforce this strictly; Chrome can
      // be inconsistent about it too) — the write then silently fails
      // or has to be retried, which is what intermittent "needs a
      // couple tries" behavior actually is, not just slowness. The fix
      // is to call clipboard.write() synchronously, right here in the
      // click handler's own call stack, and hand it a Promise<Blob>
      // instead of an already-awaited Blob — the browser accepts the
      // write immediately (activation check passes) and resolves the
      // image data whenever it's ready, cached or not.
      // Same synchronous-write requirement as before — prepareCopyBlob
      // now handles both the fast canvas path and the network
      // fallback internally (see above), so its promise is already
      // the complete thing to hand to ClipboardItem.
      const blobPromise = prepareCopyBlob(entry);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      flashButton(entry.copyBtn, 'check');
    } catch {
      flashButton(entry.copyBtn, 'error');
    } finally {
      entry._copying = false;
      setButtonBusy(entry.copyBtn, false);
    }
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
    toggle.append(getIconNode('select'));
    const toggleLabel = document.createElement('span');
    toggleLabel.textContent = 'Select images';
    toggle.append(toggleLabel);
    toggle.addEventListener('click', () => setBatchMode(!batchMode));
    document.documentElement.appendChild(toggle);

    const bar = document.createElement('div');
    bar.className = 'ivx-batch-bar';

    const countEl = document.createElement('span');
    countEl.className = 'ivx-batch-count';
    countEl.textContent = '0 selected';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ivx-batch-save';
    saveBtn.dataset.icon = 'zip';
    saveBtn.append(getIconNode('zip'));
    const saveLabel = document.createElement('span');
    saveLabel.textContent = 'Save as ZIP';
    saveBtn.append(saveLabel);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'ivx-batch-clear';
    const clearLabel = document.createElement('span');
    clearLabel.textContent = 'Clear';
    clearBtn.append(clearLabel);

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'ivx-batch-exit';
    exitBtn.setAttribute('aria-label', 'Exit batch mode');
    exitBtn.append(getIconNode('close'));

    bar.append(countEl, saveBtn, clearBtn, exitBtn);
    document.documentElement.appendChild(bar);

    saveBtn.addEventListener('click', (e) => saveSelectionAsZip(e.currentTarget));
    clearBtn.addEventListener('click', () => clearSelection());
    exitBtn.addEventListener('click', () => setBatchMode(false));

    return { toggle, bar, countEl };
  }

  const batchUI = buildBatchUI();
  // Batch select-multiple is meaningless on a standalone single-image
  // page (and its click delegation relies on a `data-ivx-anchor`
  // container this page doesn't have), so hide the entry point here.
  if (STANDALONE_IMAGE_DOC) batchUI.toggle.style.display = 'none';

  async function saveSelectionAsZip(btn) {
    if (selectedImages.size === 0) return;
    setButtonBusy(btn, true);
    const originalCount = batchUI.countEl.textContent;

    try {
      const targets = Array.from(selectedImages);
      const srcs = targets.map((img) => resolveImageSrc(img)).filter(Boolean);

      const duplicates = new Set(await checkDuplicates(srcs));
      const fresh = targets.filter((img) => !duplicates.has(resolveImageSrc(img)));
      const skipped = targets.length - fresh.length;

      if (fresh.length === 0) {
        batchUI.countEl.textContent = 'Already saved';
        flashButton(btn, 'error');
        setTimeout(() => { batchUI.countEl.textContent = originalCount; }, 1600);
        return;
      }

      const entries = [];
      const savedSrcs = [];
      const historyRecords = [];
      for (const img of fresh) {
        const src = resolveImageSrc(img);
        if (!src) continue;
        try {
          const resp = await fetch(src);
          const rawBlob = await resp.blob();
          const blob = await convertBlob(rawBlob, settings.saveFormat);
          const buf = new Uint8Array(await blob.arrayBuffer());
          const name = suggestFilename(src, blob.type);
          entries.push({ name, data: buf });
          savedSrcs.push(src);
          historyRecords.push(makeHistoryRecord(src, name));
        } catch {
          /* skip images that fail to fetch — continue with the rest */
        }
      }

      if (entries.length === 0) {
        flashButton(btn, 'error');
        return;
      }

      const zipBlob = buildZip(entries);
      const zipUrl = URL.createObjectURL(zipBlob);
      const result = await sendDownload({
        url: zipUrl,
        filename: `images-${Date.now()}.zip`,
        saveAs: true,
      });
      setTimeout(() => URL.revokeObjectURL(zipUrl), 15000);
      if (result && result.ok === false) throw new Error(result.error || 'zip download failed');
      markSaved(savedSrcs);
      recordHistory(historyRecords);

      batchUI.countEl.textContent = skipped > 0
        ? `Saved ${entries.length} \u00B7 skipped ${skipped} duplicate${skipped > 1 ? 's' : ''}`
        : `Saved ${entries.length}`;
      flashButton(btn, 'check');
      setTimeout(() => { if (batchMode) updateBatchCount(); }, 2200);
    } catch (err) {
      console.warn('[Pixtod] batch save failed:', err);
      flashButton(btn, 'error');
    } finally {
      setButtonBusy(btn, false);
    }
  }

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

  function setSelected(entry, selected) {
    const isSelected = selectedImages.has(entry.img);
    if (selected === isSelected) return;
    if (selected) {
      selectedImages.add(entry.img);
      entry.marker.classList.add('ivx-selected');
    } else {
      selectedImages.delete(entry.img);
      entry.marker.classList.remove('ivx-selected');
    }
  }

  function toggleSelection(entry) {
    setSelected(entry, !selectedImages.has(entry.img));
    updateBatchCount();
  }

  // A plain click toggles one thumbnail; this handles a click-and-drag
  // rectangle to select many at once, so curating a large batch
  // doesn't mean clicking every single tile individually.
  let dragState = null;
  let suppressNextClick = false;
  const DRAG_START_THRESHOLD = 4; // px of movement before a mousedown counts as a drag rather than a click

  function makeDragRectEl() {
    const el = document.createElement('div');
    el.className = 'ivx-drag-rect';
    document.documentElement.appendChild(el);
    return el;
  }

  // Anything currently overlapping the given viewport-space rectangle.
  // Reuses each entry's own anchor container rect (already computed
  // for overlay positioning elsewhere) rather than the <img> itself,
  // so the same "which tile is this" logic applies consistently.
  function collectIntersecting(x1, y1, x2, y2) {
    const hits = new Set();
    for (const entry of registry.values()) {
      const r = entry.container.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2) continue;
      hits.add(entry.img);
    }
    return hits;
  }

  // Live selection while dragging = whatever was already selected
  // before the drag started, plus whatever the rectangle currently
  // overlaps — so previously-selected tiles never get silently
  // dropped just because the rectangle swept past and off them again.
  function applyDragSelection(intersecting) {
    for (const entry of registry.values()) {
      setSelected(entry, dragState.base.has(entry.img) || intersecting.has(entry.img));
    }
    updateBatchCount();
  }

  document.addEventListener('mousedown', (e) => {
    if (!batchMode || e.button !== 0) return;
    if (e.target.closest('.ivx-batch-bar, .ivx-batch-toggle')) return;
    dragState = { startX: e.clientX, startY: e.clientY, moved: false, rectEl: null, base: new Set(selectedImages) };
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
    dragState.moved = true;
    if (!dragState.rectEl) dragState.rectEl = makeDragRectEl();

    const x1 = Math.min(dragState.startX, e.clientX);
    const y1 = Math.min(dragState.startY, e.clientY);
    const x2 = Math.max(dragState.startX, e.clientX);
    const y2 = Math.max(dragState.startY, e.clientY);
    Object.assign(dragState.rectEl.style, {
      left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px`,
    });
    applyDragSelection(collectIntersecting(x1, y1, x2, y2));
  }, { passive: true, capture: true });

  function endDrag() {
    if (!dragState) return;
    if (dragState.moved) suppressNextClick = true; // don't let the trailing click re-toggle whatever the drag just set
    if (dragState.rectEl) dragState.rectEl.remove();
    dragState = null;
  }
  document.addEventListener('mouseup', endDrag, true);
  // Mouse released outside the window entirely (e.g. dragged off the
  // viewport edge) never fires a document mouseup — clean up on blur
  // too, same as the existing hover-reset handler above.
  window.addEventListener('blur', endDrag);

  document.addEventListener(
    'click',
    (e) => {
      if (!batchMode) return;
      if (suppressNextClick) { suppressNextClick = false; return; }
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

  // Clicking a <button> gives it browser focus; some pages (Google
  // Images among them) have layout that makes the browser's default
  // "scroll the newly-focused element into view" behavior visibly
  // jump the page. Blur immediately and pin the scroll position
  // around the click so that reflex can't move anything.
  function runAction(btn, fn) {
    const x = window.scrollX;
    const y = window.scrollY;
    btn.blur();
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    fn();
  }

  function createOverlay(img) {
    const overlay = document.createElement('div');
    overlay.className = 'ivx-btn-container';

    const viewBtn = makeButton('view', 'View image');
    const saveBtn = makeButton('save', 'Save image');
    const copyBtn = makeButton('copy', 'Copy image');
    viewBtn.dataset.action = 'view';
    saveBtn.dataset.action = 'save';
    copyBtn.dataset.action = 'copy';

    viewBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(e.currentTarget, () => actionView(registry.get(img)));
    });
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(e.currentTarget, () => actionSave(registry.get(img)));
    });
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(e.currentTarget, () => actionCopy(registry.get(img)));
    });

    overlay.append(viewBtn, saveBtn, copyBtn);

    // Always create the search button — its enabled state gets
    // reassessed on every hover (see updateSearchAvailability), since
    // many sites (Google Images among them) swap a placeholder src for
    // the real URL after this overlay is first built. Deciding once
    // here would permanently miss that later swap.
    const searchBtn = makeButton('search', 'Search this image');
    searchBtn.dataset.action = 'search';
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(e.currentTarget, () => actionSearch(registry.get(img)));
    });
    overlay.append(searchBtn);

    // Optional extra action — hidden by default via CSS
    // ([data-ivx-copyurl] on <html>, see applyImageButtonSettings)
    // and toggled from Settings → Image. Always created (rather than
    // conditionally) so flipping the setting on doesn't require
    // rebuilding overlays that already exist on the page.
    const copyUrlBtn = makeButton('link', 'Copy image URL');
    copyUrlBtn.dataset.action = 'copyUrl';
    copyUrlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(e.currentTarget, () => actionCopyUrl(registry.get(img)));
    });
    overlay.append(copyUrlBtn);

    updateOverlayShortcutHints({ viewBtn, saveBtn, copyBtn, searchBtn });

    return { overlay, viewBtn, saveBtn, copyBtn, searchBtn, copyUrlBtn };
  }

  // ---------------------------------------------------------------
  // Shortcut hint labels (button titles reflect the user's current
  // custom shortcut keys, kept in sync live via storage.onChanged)
  // ---------------------------------------------------------------

  const SHORTCUT_ACTION_LABELS = {
    view: 'View image',
    save: 'Save image',
    copy: 'Copy image',
    search: 'Search this image',
    frame: 'Capture current frame',
  };

  function shortcutKeyFor(action) {
    switch (action) {
      case 'view': return settings.shortcutView;
      case 'save': return settings.shortcutSave;
      case 'copy': return settings.shortcutCopy;
      case 'search': return settings.shortcutSearch;
      case 'frame': return settings.shortcutFrame;
      default: return '';
    }
  }

  function masterKeyLabel() {
    switch (settings.masterKey) {
      case 'ctrl': return 'Ctrl';
      case 'alt': return 'Alt';
      case 'shift':
      default: return 'Shift';
    }
  }

  function applyShortcutHint(btn, action) {
    if (!btn) return;
    const key = String(shortcutKeyFor(action) || '').toUpperCase();
    const label = key ? `${SHORTCUT_ACTION_LABELS[action]} (${masterKeyLabel()}+${key})` : SHORTCUT_ACTION_LABELS[action];
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function updateOverlayShortcutHints({ viewBtn, saveBtn, copyBtn, searchBtn }) {
    applyShortcutHint(viewBtn, 'view');
    applyShortcutHint(saveBtn, 'save');
    applyShortcutHint(copyBtn, 'copy');
    applyShortcutHint(searchBtn, 'search');
  }

  // Walks every overlay currently on the page (thumbnails + the
  // standalone-image-page overlay, via the shared `registry`; videos
  // via `videoRegistry`) and refreshes their button titles. Called
  // once on initial settings load and again whenever a shortcut
  // setting changes, so an overlay built before the user rebinds a
  // key doesn't keep showing the stale one.
  function refreshAllShortcutHints() {
    for (const entry of registry.values()) {
      updateOverlayShortcutHints(entry);
    }
    for (const entry of videoRegistry.values()) {
      if (entry.captureBtn) applyShortcutHint(entry.captureBtn, 'frame');
    }
  }

  function createSelectMarker() {
    const marker = document.createElement('div');
    marker.className = 'ivx-select-marker';
    marker.append(getIconNode('checkSmall'));
    return marker;
  }

  function reassertOverlay(entry) {
    const { container, overlay, marker } = entry;
    // Re-append even when already connected — moving a node to the end
    // of its parent wins DOM-order paint ties against anything the
    // host page injects afterward (e.g. Pinterest's own hover overlay),
    // and re-attaches it if a host re-render detached it entirely.
    if (overlay.parentNode !== container || container.lastElementChild !== overlay) {
      container.appendChild(overlay);
    }
    if (marker.parentNode !== container) {
      container.appendChild(marker);
    }
  }

  // Reverse-search only works against a fetchable http(s) URL. Re-run
  // this on every hover rather than once at creation time, since sites
  // like Google Images start an <img> on a placeholder src and swap in
  // the real URL a moment later — a one-time check at process() would
  // permanently miss that swap.
  function updateSearchAvailability(entry) {
    const usable = /^https?:\/\//i.test(resolveImageSrc(entry.img));
    entry.searchBtn.disabled = !usable;
    entry.searchBtn.classList.toggle('ivx-btn-disabled', !usable);
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

    const { overlay, viewBtn, saveBtn, copyBtn, searchBtn, copyUrlBtn } = createOverlay(img);
    overlay.dataset.ivxTheme = detectSurroundingTheme(container);
    container.appendChild(overlay);

    const entry = {
      img, container, overlay, viewBtn, saveBtn, copyBtn, searchBtn, copyUrlBtn,
      tooltip: null, tooltipTimer: null, sizeCache: null,
      hasHighRes: hasHighResHint(img),
      copyCache: { src: null, blob: null, promise: null },
    };
    entry.marker = createSelectMarker();
    container.appendChild(entry.marker);

    container.setAttribute('data-ivx-anchor', 'true');
    container._ivxImg = img;

    registry.set(img, entry);
    updateSearchAvailability(entry);
    if (copyViewportObserver) copyViewportObserver.observe(container);

    container.addEventListener('mouseenter', () => {
      hoveredImg = img;
      updateSearchAvailability(entry);
      reassertOverlay(entry);
      showTooltip(entry);
      prepareCopyBlob(entry);
    });
    container.addEventListener('mouseleave', () => {
      if (hoveredImg === img) hoveredImg = null;
      // Only ever force-added by the refocus recovery above (normal
      // visibility here is pure CSS :hover) — strip it back off so a
      // one-time recovery nudge can't pin the overlay visible forever.
      overlay.classList.remove('ivx-visible');
      hideTooltip(entry);
    });

    scheduleBadgeUpdate();
  }

  function scanForImages(root = document) {
    root.querySelectorAll('img').forEach(processImage);
    root.querySelectorAll('video').forEach(processVideo);
  }

  // ---------------------------------------------------------------
  // Standalone image document ("View image" tab / direct image URL)
  // ---------------------------------------------------------------
  //
  // Same View/Save/Copy/Search buttons as a normal thumbnail overlay,
  // reusing createOverlay/registry/etc., but attached as a
  // fixed-position element on <body> and repositioned from the
  // image's own getBoundingClientRect() on resize/scroll — instead of
  // being nested inside an ancestor container with `position:
  // relative` forced on it, which is what broke Firefox's native
  // image centering before. The dimensions tooltip is skipped here
  // (it assumes a same-size positioned ancestor to anchor into, which
  // doesn't apply to a fixed-position overlay) since it's a minor
  // extra on a page that's already just the one image.
  function initStandaloneImagePage() {
    const img = document.images && document.images[0];
    if (!img) return;

    const attach = () => {
      if (img.hasAttribute(PROCESSED_ATTR)) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return;
      if (!resolveImageSrc(img)) return;

      img.setAttribute(PROCESSED_ATTR, 'true');

      const { overlay, viewBtn, saveBtn, copyBtn, searchBtn, copyUrlBtn } = createOverlay(img);
      overlay.style.position = 'fixed';
      overlay.dataset.ivxTheme = detectSurroundingTheme(document.documentElement);
      document.body.appendChild(overlay);

      const marker = createSelectMarker();
      marker.style.position = 'fixed';
      document.body.appendChild(marker);

      const entry = {
        img, container: document.body, overlay, viewBtn, saveBtn, copyBtn, searchBtn, copyUrlBtn, marker,
        tooltip: null, tooltipTimer: null, sizeCache: null, hasHighRes: hasHighResHint(img),
        copyCache: { src: null, blob: null, promise: null },
      };
      registry.set(img, entry);
      // Lets the shared window-focus recovery logic (see the top of
      // the file) find this entry the same way it finds a normal
      // thumbnail's anchor container.
      img.setAttribute('data-ivx-anchor', 'true');
      img._ivxImg = img;
      updateSearchAvailability(entry);

      const reposition = () => {
        const r = img.getBoundingClientRect();
        overlay.style.top = `${r.top + 6}px`;
        overlay.style.left = `${r.left + r.width - 6}px`;
        overlay.style.transform = 'translateX(-100%)';
        marker.style.top = `${r.top + 6}px`;
        marker.style.left = `${r.left + 6}px`;
      };
      reposition();
      window.addEventListener('resize', reposition, { passive: true });
      window.addEventListener('scroll', reposition, { passive: true });

      const show = () => { hoveredImg = img; updateSearchAvailability(entry); overlay.classList.add('ivx-visible'); prepareCopyBlob(entry); };
      const hide = (relatedTarget) => {
        if (relatedTarget === img || relatedTarget === overlay || overlay.contains(relatedTarget)) return;
        if (hoveredImg === img) hoveredImg = null;
        overlay.classList.remove('ivx-visible');
      };
      img.addEventListener('mouseenter', show);
      img.addEventListener('mouseleave', (e) => hide(e.relatedTarget));
      overlay.addEventListener('mouseenter', show);
      overlay.addEventListener('mouseleave', (e) => hide(e.relatedTarget));

      scheduleBadgeUpdate();
    };

    if (img.complete) attach();
    else img.addEventListener('load', attach, { once: true });
  }

  // ---------------------------------------------------------------
  // Video frame capture
  // ---------------------------------------------------------------

  // video -> { container, overlay, captureBtn }
  const videoRegistry = new Map();

  // The button is appended straight to <body> as position:fixed and
  // its screen position is tracked every frame from the video's own
  // getBoundingClientRect() while hovered. Earlier this appended into
  // whatever ancestor getAnchorContainer() picked, which works for
  // ordinary pages but drifts on sites like YouTube whose player DOM
  // reflows constantly (controls bar fading in/out, theater mode,
  // fullscreen, etc.) — the button would visibly slide as its actual
  // anchor element resized under it. Tracking the video's rect
  // directly sidesteps that regardless of how the host page's DOM
  // shifts around it.
  let videoTrackHandle = null;

  // YouTube (and several other players) keep more than one <video>
  // element in the DOM at the same on-screen spot at once — a
  // storyboard/scrub-preview clone, an ad-slot video, a quality-switch
  // clone during a resolution change — all stacked exactly on top of
  // the real player. Scanning every <video> naively gave each one its
  // own capture button, so two (or more) overlapping camera icons
  // could show up over what looks like a single player. Rather than
  // guessing which one is "real" up front, overlapping videos share a
  // single button, and the actual video to capture is resolved at
  // click time (see pickActiveVideo below).
  function rectsOverlapSubstantially(a, b) {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return false;
    const overlapArea = (right - left) * (bottom - top);
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    return smallerArea > 0 && overlapArea / smallerArea > 0.6;
  }

  function findOverlappingVideoEntry(rect) {
    for (const entry of videoRegistry.values()) {
      if (!document.body.contains(entry.video)) continue;
      const otherRect = entry.video.getBoundingClientRect();
      if (rectsOverlapSubstantially(rect, otherRect)) return entry;
    }
    return null;
  }

  // Among an entry's stacked candidate videos, resolve the one that's
  // actually showing a real frame right now — preferring whichever
  // has live pixel data, then whichever has a `src` attribute set
  // (sites like YouTube keep several <video> tags around at once —
  // main player, Shorts preview, ad slot — but only the one actually
  // playing the current stream tends to have `src` set on the
  // element itself), and breaking any remaining tie by hit-testing
  // the video's own center point (whichever element the browser would
  // actually paint on top there).
  function pickActiveVideo(entry) {
    const candidates = entry.candidates || [entry.video];
    if (candidates.length === 1) return candidates[0];
    const ready = candidates.filter((v) => v.videoWidth > 0 && v.readyState >= 2 && !v.ended);
    let pool = ready.length ? ready : candidates;
    if (pool.length === 1) return pool[0];
    const withSrc = pool.filter((v) => v.hasAttribute('src'));
    if (withSrc.length === 1) return withSrc[0];
    if (withSrc.length > 1) pool = withSrc;
    const rect = entry.video.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const prevPointerEvents = entry.overlay.style.pointerEvents;
    entry.overlay.style.pointerEvents = 'none';
    const topEl = document.elementFromPoint(cx, cy);
    entry.overlay.style.pointerEvents = prevPointerEvents;
    const hit = pool.find((v) => v === topEl || (v.contains && v.contains(topEl)));
    return hit || pool[0];
  }

  function positionVideoOverlay(video, overlay) {
    const rect = video.getBoundingClientRect();
    const onScreen = rect.width >= MIN_DIMENSION && rect.height >= MIN_DIMENSION
      && rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth;
    overlay.style.display = onScreen ? '' : 'none';
    if (!onScreen) return;
    overlay.style.top = `${rect.top + rect.height / 2}px`;
    overlay.style.left = `${rect.left + rect.width / 2}px`;
  }

  function mergeOverlappingVideoEntries() {
    // Belt-and-braces on top of the check in processVideo(): that one
    // only runs the instant a <video> is first discovered, when a
    // player that reflows into place (ads, quality switches, layout
    // not fully settled yet) can still have a different rect than its
    // eventual on-screen spot — so two entries can end up tracking the
    // same physical player without ever having been caught as
    // overlapping. Re-check every frame and fold them together
    // whenever that happens, so a stray second icon can't persist.
    const entries = Array.from(videoRegistry.values());
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      if (!videoRegistry.has(a.key) || !document.body.contains(a.video)) continue;
      const rectA = a.video.getBoundingClientRect();
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        if (!videoRegistry.has(b.key) || !document.body.contains(b.video)) continue;
        const rectB = b.video.getBoundingClientRect();
        if (!rectsOverlapSubstantially(rectA, rectB)) continue;
        (b.candidates || [b.video]).forEach((v) => {
          if (!a.candidates.includes(v)) a.candidates.push(v);
        });
        if (hoveredVideo === b.key) hoveredVideo = a.key;
        b.overlay.remove();
        videoRegistry.delete(b.key);
      }
    }
  }

  function trackVideoOverlays() {
    mergeOverlappingVideoEntries();
    videoRegistry.forEach((entry) => {
      // Drop any stacked candidate (ad slot, quality-switch clone,
      // etc.) that's been removed from the page, and if the one
      // currently used for positioning/capture was the one removed,
      // hand off to whichever candidate is still there rather than
      // tearing down the whole entry — the "real" video underneath
      // may well still be playing.
      if (entry.candidates) {
        entry.candidates = entry.candidates.filter((v) => document.body.contains(v));
        if (!document.body.contains(entry.video) && entry.candidates.length) {
          entry.video = entry.candidates[0];
        }
      }
      const stillPresent = entry.candidates ? entry.candidates.length > 0 : document.body.contains(entry.video);
      if (!stillPresent) {
        entry.overlay.remove();
        videoRegistry.delete(entry.key);
        if (hoveredVideo === entry.key) hoveredVideo = null;
        return;
      }
      const active = hoveredVideo === entry.key
        || entry.overlay.matches(':hover')
        || document.activeElement === entry.captureBtn;
      entry.overlay.classList.toggle('ivx-visible', active);
      if (active) positionVideoOverlay(entry.video, entry.overlay);
    });
    // Stop once no videos are left registered (e.g. all removed via
    // SPA navigation) rather than looping forever doing nothing;
    // processVideo() restarts it the next time one shows up.
    if (videoRegistry.size === 0) {
      videoTrackHandle = null;
      return;
    }
    videoTrackHandle = requestAnimationFrame(trackVideoOverlays);
  }

  function createVideoOverlay(video) {
    const overlay = document.createElement('div');
    overlay.className = 'ivx-btn-container ivx-btn-container-video';
    overlay.style.position = 'fixed';
    overlay.style.display = 'none';
    const captureBtn = makeButton('camera', 'Capture current frame');
    captureBtn.dataset.action = 'frame';
    applyShortcutHint(captureBtn, 'frame');
    captureBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(e.currentTarget, () => actionCaptureFrame(videoRegistry.get(video)));
    });
    overlay.append(captureBtn);

    // Keep the button visible while the cursor moves off the video
    // and onto the (now DOM-detached) button itself.
    overlay.addEventListener('mouseenter', () => { hoveredVideo = video; });
    overlay.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget !== video && hoveredVideo === video) hoveredVideo = null;
    });

    return { overlay, captureBtn };
  }

  function processVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.hasAttribute(PROCESSED_ATTR)) return;

    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return;

    const overlapping = findOverlappingVideoEntry(rect);
    if (overlapping) {
      // Same on-screen slot as an already-tracked video — fold this
      // one in as an alternate candidate instead of giving it its own
      // button, so hovering the player never shows duplicate icons.
      video.setAttribute(PROCESSED_ATTR, 'true');
      if (!overlapping.candidates) overlapping.candidates = [overlapping.video];
      if (!overlapping.candidates.includes(video)) overlapping.candidates.push(video);
      video.addEventListener('mouseenter', () => { hoveredVideo = overlapping.key; });
      video.addEventListener('mouseleave', (e) => {
        if (e.relatedTarget !== overlapping.overlay && !overlapping.overlay.contains(e.relatedTarget) && hoveredVideo === overlapping.key) {
          hoveredVideo = null;
        }
      });
      return;
    }

    const container = getAnchorContainer(video);
    if (!container) return;

    video.setAttribute(PROCESSED_ATTR, 'true');

    const { overlay, captureBtn } = createVideoOverlay(video);
    overlay.dataset.ivxTheme = detectSurroundingTheme(container);
    document.body.appendChild(overlay);

    // `key` stays fixed to the video that first created this entry —
    // used only to identify the entry (registry lookups, hover
    // tracking). `video`/`candidates` are what actually gets captured
    // from and can shift to a stacked sibling video over time (see
    // findOverlappingVideoEntry / pickActiveVideo above).
    const entry = { video, key: video, container, overlay, captureBtn, candidates: [video] };
    videoRegistry.set(video, entry);

    video.addEventListener('mouseenter', () => { hoveredVideo = entry.key; });
    video.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget !== overlay && !overlay.contains(e.relatedTarget) && hoveredVideo === entry.key) {
        hoveredVideo = null;
      }
    });

    if (videoTrackHandle == null) trackVideoOverlays();
  }

  // Draws the video's current frame to a canvas and saves it as an
  // image, converted to the user's preferred save format (defaulting
  // to PNG for frame grabs, since there's no "original" file to fall
  // back to). Cross-origin video without CORS headers taints the
  // canvas and makes toBlob throw — surfaced as the normal error flash
  // rather than a silent no-op.
  function showToast(container, text) {
    const toast = document.createElement('div');
    toast.className = 'ivx-toast';
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  // Fallback path for adaptive-streamed video (YouTube, Netflix,
  // Twitch, etc.) where drawImage(video, ...) taints the canvas per
  // spec, regardless of origin or permissions. Instead of reading the
  // <video> element's pixel buffer, this asks the background script
  // to screenshot the visible tab (the composited page, like a normal
  // screen capture) and crops that down to the video's on-screen
  // rect. That sidesteps the taint restriction entirely since no
  // canvas ever reads from the <video> element itself.
  async function captureViaTabScreenshot(video) {
    const res = await callBackground({ action: 'captureVisibleTab' });
    if (!res || !res.ok || !res.dataUrl) throw new Error((res && res.error) || 'tab screenshot failed');
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('screenshot decode failed'));
      im.src = res.dataUrl;
    });
    const rect = video.getBoundingClientRect();
    // Derive the scale from the screenshot itself rather than trusting
    // devicePixelRatio, so it still lines up under browser zoom.
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;
    const sx = Math.max(0, rect.left * scaleX);
    const sy = Math.max(0, rect.top * scaleY);
    const sw = Math.min(img.naturalWidth - sx, rect.width * scaleX);
    const sh = Math.min(img.naturalHeight - sy, rect.height * scaleY);
    if (sw <= 1 || sh <= 1) throw new Error('video not visible in viewport');
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  // Waits for the next real decoded frame before capturing, when the
  // browser can tell us about one (requestVideoFrameCallback), rather
  // than grabbing whatever happens to be sitting in the video's
  // buffer at the exact moment of the click — which can occasionally
  // be a half-composited or stale frame. Capped with a short timeout
  // so a stalled stream can't leave the button spinning forever.
  function waitForFreshFrame(video) {
    return new Promise((resolve) => {
      if (video.paused || typeof video.requestVideoFrameCallback !== 'function') {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 300);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function actionCaptureFrame(entry) {
    if (!entry) return;
    if (entry._capturing) return;
    entry._capturing = true;
    const video = pickActiveVideo(entry);
    const { container, captureBtn } = entry;
    if (!video.videoWidth || !video.videoHeight) { entry._capturing = false; flashButton(captureBtn, 'error'); return; }
    // EME/DRM-protected video (mediaKeys set) throws unconditionally
    // on any canvas read — detect it up front so the fallback path can
    // be reached directly instead of forcing a doomed draw attempt
    // first, and so a real failure can say why rather than just
    // "Capture failed".
    const isDrm = video.mediaKeys != null;
    setButtonBusy(captureBtn, true);
    let usedFallback = false;
    try {
      await waitForFreshFrame(video);
      let canvas;
      if (isDrm) {
        usedFallback = true;
        canvas = await captureViaTabScreenshot(video);
      } else {
        try {
          canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          // Force the taint check synchronously — toBlob() below fails
          // silently (empty/black image) in some browsers instead of
          // throwing, so read a single pixel back to surface a
          // SecurityError immediately if the canvas is tainted.
          canvas.getContext('2d').getImageData(0, 0, 1, 1);
        } catch (drawErr) {
          const msg = String((drawErr && drawErr.message) || drawErr || '');
          const blocked = (drawErr && drawErr.name === 'SecurityError') || /insecure|tainted|security/i.test(msg);
          if (!blocked) throw drawErr;
          usedFallback = true;
          canvas = await captureViaTabScreenshot(video);
        }
      }
      const format = settings.saveFormat === 'original' ? 'png' : settings.saveFormat;
      const mime = FORMAT_MIME[format] || 'image/png';
      const quality = format === 'png' ? undefined : 0.92;
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality)
      );
      const filename = suggestFilename(window.location.href, blob.type, `frame-${window.location.hostname}`);
      const result = await sendBlobDownload(blob, filename, false);
      if (result && result.ok === false) throw new Error(result.error || 'download failed');
      recordHistory([makeHistoryRecord(window.location.href, filename)]);
      flashButton(captureBtn, 'check');
      if (usedFallback) {
        showToast(container, isDrm ? 'Captured via screenshot (DRM-protected video)' : 'Captured via screenshot (protected video)');
      }
    } catch (err) {
      console.warn('[Pixtod] frame capture failed:', err);
      const msg = String((err && err.message) || err || '');
      // Same as actionSave: if Chrome's own "ask where to save each
      // file" setting is on, our saveAs:false here can still surface a
      // Save dialog, and canceling it reports back as an error. Treat
      // that as "chose not to save" rather than a capture failure.
      if (isCancelError(msg)) return;
      const outOfView = /viewport/i.test(msg);
      const failMsg = isDrm
        ? "Can't capture — this video is DRM-protected"
        : (outOfView ? "Can't capture — scroll the video into view first" : 'Capture failed');
      showToast(container, failMsg);
      flashButton(captureBtn, 'error');
    } finally {
      entry._capturing = false;
      setButtonBusy(captureBtn, false);
    }
  }

  // ---------------------------------------------------------------
  // Keyboard shortcuts (contextual — act on whichever image is hovered)
  // ---------------------------------------------------------------

  // Physical-key resolution for the action letter (v/s/c/f/g etc.) —
  // deliberately reads e.code rather than e.key. This matters once
  // Alt/Option can be the trigger modifier: on macOS, holding
  // Option remaps e.key to an accented/special character (e.g.
  // Option+V often reports e.key as '√'), which would silently break
  // every shortcut. e.code reports the physical key ("KeyV")
  // regardless of what modifiers are held or what the OS remaps it
  // to, so it stays reliable across Shift/Ctrl/Alt alike.
  function resolveActionKey(e) {
    const match = /^Key([A-Z])$/.exec(e.code || '');
    if (match) return match[1].toLowerCase();
    return (e.key || '').toLowerCase();
  }

  // Whether exactly the configured trigger modifier — and no other —
  // is held. Requiring an exact match (not just "at least") keeps us
  // out of the way of the host page's own Ctrl/Alt/Shift combos that
  // happen to share a letter.
  function isTriggerModifierHeld(e) {
    switch (settings.masterKey) {
      case 'ctrl': return e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey;
      case 'alt': return e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey;
      case 'shift':
      default: return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    }
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (isSiteDisabled() || batchMode || (!hoveredImg && !hoveredVideo)) return;
      const active = document.activeElement;
      const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      // Require the configured trigger modifier (Shift by default,
      // Ctrl or Alt if changed in Settings → Shortcuts) so a bare
      // 'v'/'s'/'c' keypress on the host page's own lightbox/search
      // hotkeys (Google Images, etc.) is left alone.
      if (typing || !isTriggerModifierHeld(e)) return;

      const key = resolveActionKey(e);

      // The save key (whatever it's currently bound to) is the
      // universal "save" action everywhere else in the extension, but
      // previously landed on a hovered video and did nothing, which
      // reads as a broken shortcut. Treat it the same as the frame-
      // capture key there.
      if (hoveredVideo && (key === String(settings.shortcutFrame).toLowerCase() || key === String(settings.shortcutSave).toLowerCase())) {
        e.preventDefault();
        actionCaptureFrame(videoRegistry.get(hoveredVideo));
        return;
      }

      if (!hoveredImg) return;
      const entry = registry.get(hoveredImg);
      if (!entry) return;

      if (key === String(settings.shortcutView).toLowerCase()) {
        e.preventDefault();
        actionView(entry);
      } else if (key === String(settings.shortcutSave).toLowerCase()) {
        e.preventDefault();
        actionSave(entry);
      } else if (key === String(settings.shortcutCopy).toLowerCase()) {
        e.preventDefault();
        actionCopy(entry);
      } else if (key === String(settings.shortcutSearch).toLowerCase() && entry.searchBtn && !entry.searchBtn.disabled) {
        e.preventDefault();
        actionSearch(entry);
      }
    },
    true // capture phase — run ahead of the host page's own bubble-phase
         // keydown handlers (e.g. Google Images' lightbox hotkeys), which
         // was the likely cause of shortcuts silently doing nothing.
  );

  // ---------------------------------------------------------------
  // Toolbar badge + stats
  // ---------------------------------------------------------------

  let badgeScheduled = false;
  function scheduleBadgeUpdate() {
    if (badgeScheduled) return;
    badgeScheduled = true;
    requestAnimationFrame(() => {
      badgeScheduled = false;
      const count = registry.size;
      if (count === lastSentBadgeCount) return;
      lastSentBadgeCount = count;
      let fullRes = 0;
      for (const entry of registry.values()) if (entry.hasHighRes) fullRes++;
      reportBadge(count, fullRes, count - fullRes);
    });
  }

  // ---------------------------------------------------------------
  // Scan scheduling / MutationObserver
  // ---------------------------------------------------------------

  if (STANDALONE_IMAGE_DOC) {
    // A standalone image document has exactly one image and no
    // dynamic content — no need for the general thumbnail scan or a
    // mutation observer, just the dedicated handler above.
    initStandaloneImagePage();
  } else {
    scanForImages();
    window.addEventListener('load', () => scanForImages(), { once: true });

    // Batches added nodes across a mutation tick and scans only those
    // subtrees, instead of re-querying the whole document on every
    // batch. On pages that keep mutating (infinite-scroll feeds, live
    // dashboards) a full-document querySelectorAll('img'/'video') on
    // every batch re-walks nodes that were already processed (and
    // skipped instantly via PROCESSED_ATTR) — harmless for
    // correctness, but wasted work that scales with total page size
    // rather than with what actually changed. Falls back to a full
    // scan if a mutation batch is large/ambiguous enough that walking
    // it node-by-node isn't worth it.
    let scanScheduled = false;
    let pendingNodes = new Set();
    const FULL_SCAN_THRESHOLD = 40;
    function scheduleScan(addedNodes) {
      for (const node of addedNodes) pendingNodes.add(node);
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        const nodes = pendingNodes;
        pendingNodes = new Set();
        if (nodes.size === 0 || nodes.size > FULL_SCAN_THRESHOLD) {
          scanForImages();
          return;
        }
        for (const node of nodes) {
          // Only elements, and only ones still actually in the page —
          // a node can be added and removed again within the same
          // batch (common with some frameworks' render churn), and
          // querySelectorAll on a detached node is wasted work.
          if (node.nodeType !== 1 || !node.isConnected) continue;
          if (node.tagName === 'IMG') processImage(node);
          else if (node.tagName === 'VIDEO') processVideo(node);
          else if (typeof node.querySelectorAll === 'function') scanForImages(node);
        }
      });
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          scheduleScan(mutation.addedNodes);
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
