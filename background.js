// Cross-browser alias — Firefox exposes `browser` (promise-based),
// Chrome/Edge expose `chrome` (callback-based); both accept the
// listener pattern used below.
const api = typeof browser !== 'undefined' ? browser : chrome;

// URLs already saved this browsing session (for batch duplicate
// detection). Backed by storage.session where available so it
// survives service-worker eviction; falls back to an in-memory Set
// if storage.session isn't supported by the browser.
const savedUrls = new Set();
let savedUrlsLoaded = false;

async function ensureSavedUrlsLoaded() {
  if (savedUrlsLoaded) return;
  savedUrlsLoaded = true;
  try {
    if (api.storage.session) {
      const res = await api.storage.session.get('savedUrls');
      if (res && Array.isArray(res.savedUrls)) res.savedUrls.forEach((u) => savedUrls.add(u));
    }
  } catch {
    /* storage.session unavailable — in-memory Set only, resets per
       service-worker lifetime, which is an acceptable degrade. */
  }
}

function persistSavedUrls() {
  try {
    if (api.storage.session) api.storage.session.set({ savedUrls: Array.from(savedUrls) });
  } catch {
    /* best-effort */
  }
}

// Per-tab image stats reported by content.js, read back by the popup.
const tabStats = new Map();

// Saved-item history (gallery tab), backed by storage.local so it
// survives service-worker eviction and browser restarts. Capped so a
// heavy browsing session can't grow storage without bound.
const HISTORY_LIMIT = 500;

// Cross-browser wrapper: Chrome's callback-style downloads.download()
// and Firefox's Promise-style one both funnel through here, and —
// critically — we actually wait for the result instead of firing and
// forgetting, so a failed download (e.g. an inaccessible blob: URL)
// can be reported back to the caller instead of looking like a
// silent success.
//
// A saveAs Save-As dialog can legitimately stay open a long time (the
// user browsing folders), but there have historically been Firefox
// builds where canceling that dialog doesn't reject the promise at
// all — it just never settles. Without a ceiling, that leaves the
// caller (a content script awaiting this) stuck showing a spinner
// forever with no way to recover. A generous timeout means the UI can
// always recover even if the browser never tells us what happened;
// if the underlying call does still resolve after that, it's just
// ignored (the `settled` guard below).
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

function downloadPromise(options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (id) => { if (settled) return; settled = true; resolve(id); };
    const fail = (err) => { if (settled) return; settled = true; reject(err); };
    const timeoutId = setTimeout(() => fail(new Error('USER_CANCELED (timed out waiting for a response)')), DOWNLOAD_TIMEOUT_MS);
    const doneWrapped = (id) => { clearTimeout(timeoutId); done(id); };
    const failWrapped = (err) => { clearTimeout(timeoutId); fail(err); };
    try {
      const maybePromise = api.downloads.download(options, (id) => {
        if (api.runtime.lastError) { failWrapped(new Error(api.runtime.lastError.message)); return; }
        doneWrapped(id);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(doneWrapped).catch(failWrapped);
      }
    } catch (err) {
      failWrapped(err);
    }
  });
}

// Revokes a locally-minted object URL once its download has actually
// finished reading it (rather than a blind fixed delay) — waits on
// downloads.onChanged for that download's id, with a generous timeout
// as a safety net in case that event never arrives.
function revokeAfterDownload(objectUrl, downloadId) {
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    try { URL.revokeObjectURL(objectUrl); } catch { /* noop */ }
  };
  if (typeof downloadId === 'number' && api.downloads.onChanged) {
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        api.downloads.onChanged.removeListener(listener);
        revoke();
      }
    };
    api.downloads.onChanged.addListener(listener);
  }
  setTimeout(revoke, 30000);
}

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    // request.blob arrives here as an actual Blob on browsers whose
    // messaging supports structured clone (currently Firefox — see
    // sendBlobDownload in content.js) instead of a blob: URL string
    // minted in the content script's own document, which isn't always
    // resolvable from here. Minting the object URL in this context
    // instead means it's always resolved by the same context that
    // reads it.
    const objectUrl = request.blob ? URL.createObjectURL(request.blob) : null;
    downloadPromise({
      url: objectUrl || request.url,
      filename: request.filename,
      saveAs: request.saveAs,
      conflictAction: 'uniquify',
    })
      .then((downloadId) => {
        if (objectUrl) revokeAfterDownload(objectUrl, downloadId);
        sendResponse && sendResponse({ ok: true, downloadId });
      })
      .catch((err) => {
        if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch { /* noop */ } }
        sendResponse && sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
    return true; // keep the message channel open for the async response
  }

  if (request.action === 'captureVisibleTab') {
    // Screenshots the rendered tab (compositor output) rather than
    // reading the <video> element's pixel buffer, so it isn't subject
    // to the canvas-taint restriction that blocks drawImage() on
    // MSE/adaptive-streamed video (YouTube, Netflix, Twitch, etc.).
    // Used only as a fallback when the direct canvas capture throws.
    const windowId = sender.tab && typeof sender.tab.windowId === 'number' ? sender.tab.windowId : undefined;

    function tryCapture() {
      return new Promise((resolve, reject) => {
        const args = windowId === undefined ? [{ format: 'png' }] : [windowId, { format: 'png' }];
        try {
          const maybePromise = api.tabs.captureVisibleTab(...args, (dataUrl) => {
            if (api.runtime.lastError) { reject(new Error(api.runtime.lastError.message)); return; }
            resolve(dataUrl);
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(resolve).catch(reject);
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    // captureVisibleTab is rate-limited by Chrome to roughly 2 calls
    // per second per window (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).
    // A second capture fired shortly after the first — e.g. a stray
    // duplicate button, or the user clicking twice — trips that quota
    // and previously surfaced as a flat "Capture failed" with no
    // recovery. One short backoff-and-retry absorbs that instead of
    // failing outright.
    tryCapture()
      .then((dataUrl) => sendResponse && sendResponse({ ok: true, dataUrl }))
      .catch((err) => {
        const msg = String((err && err.message) || err || '');
        if (/quota|MAX_CAPTURE_VISIBLE_TAB/i.test(msg)) {
          setTimeout(() => {
            tryCapture()
              .then((dataUrl) => sendResponse && sendResponse({ ok: true, dataUrl }))
              .catch((err2) => sendResponse && sendResponse({ ok: false, error: (err2 && err2.message) || String(err2) }));
          }, 600);
          return;
        }
        sendResponse && sendResponse({ ok: false, error: msg });
      });
    return true; // async response
  }

  if (request.action === 'updateBadge') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      tabStats.set(tabId, {
        count: request.count || 0,
        fullRes: request.fullRes || 0,
        thumbnailOnly: request.thumbnailOnly || 0,
      });
      const text = request.count > 0 ? String(request.count) : '';
      api.action.setBadgeText({ text, tabId });
      api.action.setBadgeBackgroundColor({ color: '#00c853', tabId });
    }
    sendResponse && sendResponse();
    return;
  }

  if (request.action === 'getStats') {
    const stats = tabStats.get(request.tabId) || { count: 0, fullRes: 0, thumbnailOnly: 0 };
    sendResponse(stats);
    return;
  }

  // Fetches image bytes from the extension's own background context
  // instead of the page. A content-script fetch() is bound by the
  // same cross-origin rules as any page script — if the image's
  // server doesn't send CORS headers (most sites don't), that fetch
  // is blocked or restricted the same way canvas reads are. This
  // background fetch isn't: with the extension's own host
  // permissions it can read cross-origin bytes the same way
  // downloads.download() already could, which is why Save has always
  // worked reliably regardless of a site's CORS setup while a
  // content-script-only Copy path could not.
  if (request.action === 'fetchImageBytes') {
    (async () => {
      try {
        const resp = await fetch(request.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const mime = resp.headers.get('content-type') || '';
        sendResponse({ ok: true, buf, mime });
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      }
    })();
    return true; // async response
  }

  if (request.action === 'checkDuplicates') {
    ensureSavedUrlsLoaded().then(() => {
      const urls = Array.isArray(request.urls) ? request.urls : [];
      sendResponse({ duplicates: urls.filter((u) => savedUrls.has(u)) });
    });
    return true; // async response
  }

  if (request.action === 'markSaved') {
    ensureSavedUrlsLoaded().then(() => {
      (Array.isArray(request.urls) ? request.urls : []).forEach((u) => savedUrls.add(u));
      persistSavedUrls();
      sendResponse({ ok: true });
    });
    return true; // async response
  }

  if (request.action === 'addHistory') {
    const records = Array.isArray(request.records) ? request.records : [];
    if (records.length === 0) { sendResponse && sendResponse({ ok: true }); return; }
    api.storage.local.get('ivxHistory').then((res) => {
      const existing = (res && Array.isArray(res.ivxHistory)) ? res.ivxHistory : [];
      const merged = [...records, ...existing].slice(0, HISTORY_LIMIT);
      return api.storage.local.set({ ivxHistory: merged });
    }).then(() => sendResponse && sendResponse({ ok: true }))
      .catch((err) => sendResponse && sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // async response
  }

  if (request.action === 'getHistory') {
    api.storage.local.get('ivxHistory').then((res) => {
      sendResponse((res && res.ivxHistory) || []);
    }).catch(() => sendResponse([]));
    return true; // async response
  }

  if (request.action === 'clearHistory') {
    api.storage.local.remove('ivxHistory')
      .then(() => sendResponse && sendResponse({ ok: true }))
      .catch((err) => sendResponse && sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // async response
  }

  // Removes specific records (bulk delete from the history gallery)
  // rather than the all-or-nothing clearHistory above. Matched by the
  // per-record `id` stamped on creation in content.js's
  // makeHistoryRecord — older records saved before that field existed
  // won't have one and simply can't be targeted individually, which
  // is an acceptable degrade (they can still go via Clear all).
  if (request.action === 'deleteHistoryRecords') {
    const ids = new Set(Array.isArray(request.ids) ? request.ids : []);
    api.storage.local.get('ivxHistory').then((res) => {
      const existing = (res && Array.isArray(res.ivxHistory)) ? res.ivxHistory : [];
      const remaining = existing.filter((r) => !r.id || !ids.has(r.id));
      return api.storage.local.set({ ivxHistory: remaining });
    }).then(() => sendResponse && sendResponse({ ok: true }))
      .catch((err) => sendResponse && sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // async response
  }

  // Patches a single record in place (favorite toggle, tag edits) —
  // merges `patch` onto the existing record rather than replacing it,
  // so a favorite toggle can't accidentally clobber tags set by a
  // separate call and vice versa.
  if (request.action === 'updateHistoryRecord') {
    const { id, patch } = request;
    if (!id || !patch) { sendResponse && sendResponse({ ok: false, error: 'missing id/patch' }); return; }
    api.storage.local.get('ivxHistory').then((res) => {
      const existing = (res && Array.isArray(res.ivxHistory)) ? res.ivxHistory : [];
      const updated = existing.map((r) => (r.id === id ? { ...r, ...patch } : r));
      return api.storage.local.set({ ivxHistory: updated });
    }).then(() => sendResponse && sendResponse({ ok: true }))
      .catch((err) => sendResponse && sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // async response
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
});

api.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    api.tabs.create({ url: api.runtime.getURL('welcome.html') });
  }
});
