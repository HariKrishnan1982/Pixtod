/**
 * content.js — Image Viewer
 *
 * Adds "View" and "Save" buttons to images on any page. Handles both:
 *  - simple pages with one or a few images
 *  - dynamic thumbnail grids (e.g. image search results) where new
 *    images keep appearing as the user scrolls
 */

(() => {
  'use strict';

  const PROCESSED_ATTR = 'data-ivx-processed';
  const MIN_DIMENSION = 60; // ignore icons/sprites/avatars

  /**
   * Find the element we should anchor the overlay to. We walk up a
   * couple of levels looking for a container that isn't itself the
   * whole page, so the overlay stays positioned to the thumbnail
   * rather than the top-level layout.
   */
  function getAnchorContainer(img) {
    let el = img.parentElement;
    if (!el) return null;

    // Some sites wrap the <img> tightly in an extra <div>/<span>; if the
    // immediate parent is essentially the same size as the image, try
    // going one level higher so the overlay has room to sit on top of
    // the whole tile rather than just the raw <img> box.
    const imgRect = img.getBoundingClientRect();
    const parentRect = el.getBoundingClientRect();
    const grandparent = el.parentElement;
    if (
      grandparent &&
      Math.abs(parentRect.width - imgRect.width) < 4 &&
      Math.abs(parentRect.height - imgRect.height) < 4
    ) {
      el = grandparent;
    }

    const computedPosition = window.getComputedStyle(el).position;
    if (computedPosition === 'static') {
      el.style.position = 'relative';
    }

    return el;
  }

  /**
   * Walk up from an element looking for the first ancestor with a
   * non-transparent background-color, so we can tell whether the
   * overlay is sitting on a light or dark part of the page. Falls
   * back to the page's own background if nothing more specific is set.
   */
  function detectSurroundingTheme(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = window.getComputedStyle(node).backgroundColor;
      const luminance = colorToLuminance(bg);
      if (luminance !== null) return luminance > 140 ? 'light' : 'dark';
      node = node.parentElement;
    }
    const pageBg = window.getComputedStyle(document.body || document.documentElement).backgroundColor;
    const pageLuminance = colorToLuminance(pageBg);
    if (pageLuminance !== null) return pageLuminance > 140 ? 'light' : 'dark';
    return 'light'; // sensible default — most pages are light-background
  }

  /**
   * Parses an rgb()/rgba() computed color string into a 0–255
   * perceptual luminance value. Returns null for transparent colors
   * (alpha 0) since those don't tell us anything about the background.
   */
  function colorToLuminance(colorStr) {
    const match = colorStr && colorStr.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(',').map((n) => parseFloat(n.trim()));
    const [r, g, b, a = 1] = parts;
    if (a === 0 || Number.isNaN(r)) return null;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function resolveImageSrc(img) {
    return (
      img.getAttribute('data-src') ||
      img.getAttribute('data-iurl') ||
      img.currentSrc ||
      img.src ||
      ''
    );
  }

  function suggestFilename(src, mimeType) {
    try {
      const url = new URL(src, window.location.href);
      const base = url.pathname.split('/').pop();
      if (base && base.includes('.')) return base;
    } catch {
      /* src may be a data: URL or malformed; fall through */
    }
    const ext = mimeType && mimeType.includes('/') ? mimeType.split('/')[1].split('+')[0] : 'jpg';
    return `image_${Date.now()}.${ext}`;
  }

  // Simple, thin-stroke line icons (currentColor) instead of emoji —
  // renders crisply at small sizes and matches the icon language most
  // sites already use for their own UI.
  const ICONS = {
    view:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    save:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19.5h16"/></svg>',
    loading:
      '<svg class="ivx-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  };

  function makeButton(iconKey, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ivx-btn';
    btn.innerHTML = ICONS[iconKey];
    btn.title = title;
    btn.setAttribute('aria-label', title);
    return btn;
  }

  function createOverlay(img) {
    const container = document.createElement('div');
    container.className = 'ivx-btn-container';

    const viewBtn = makeButton('view', 'View image');
    const saveBtn = makeButton('save', 'Save image');

    viewBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const src = resolveImageSrc(img);
      if (src) window.open(src, '_blank', 'noopener,noreferrer');
    });

    saveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const src = resolveImageSrc(img);
      if (!src) return;

      saveBtn.innerHTML = ICONS.loading;
      saveBtn.disabled = true;

      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);

        chrome.runtime.sendMessage(
          {
            action: 'download',
            url: blobUrl,
            filename: suggestFilename(src, blob.type),
            saveAs: true,
          },
          () => setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)
        );
      } catch (err) {
        // Fallback: let the browser attempt a direct download/navigation.
        const a = document.createElement('a');
        a.href = src;
        a.download = suggestFilename(src);
        a.click();
      } finally {
        saveBtn.innerHTML = ICONS.save;
        saveBtn.disabled = false;
      }
    });

    container.appendChild(viewBtn);
    container.appendChild(saveBtn);
    return container;
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
    const overlay = createOverlay(img);
    overlay.dataset.ivxTheme = detectSurroundingTheme(container);
    container.appendChild(overlay);
  }

  function scanForImages(root = document) {
    root.querySelectorAll('img').forEach(processImage);
  }

  // Initial pass.
  scanForImages();

  // Rescan when images finish loading (naturalWidth/Height, and thus
  // getBoundingClientRect sizing, may only be meaningful after load).
  window.addEventListener('load', () => scanForImages(), { once: true });

  // Watch for new images added dynamically (infinite scroll, SPA
  // navigation, lazy-loaded grids, etc). Debounced with
  // requestAnimationFrame so bursts of mutations during fast
  // scrolling don't trigger a full rescan per mutation record.
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

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
