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

// Cross-browser wrapper: Chrome's callback-style downloads.download()
// and Firefox's Promise-style one both funnel through here, and —
// critically — we actually wait for the result instead of firing and
// forgetting, so a failed download (e.g. an inaccessible blob: URL)
// can be reported back to the caller instead of looking like a
// silent success.
function downloadPromise(options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (id) => { if (settled) return; settled = true; resolve(id); };
    const fail = (err) => { if (settled) return; settled = true; reject(err); };
    try {
      const maybePromise = api.downloads.download(options, (id) => {
        if (api.runtime.lastError) { fail(new Error(api.runtime.lastError.message)); return; }
        done(id);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(done).catch(fail);
      }
    } catch (err) {
      fail(err);
    }
  });
}

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    downloadPromise({
      url: request.url,
      filename: request.filename,
      saveAs: request.saveAs,
    })
      .then((downloadId) => sendResponse && sendResponse({ ok: true, downloadId }))
      .catch((err) => sendResponse && sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // keep the message channel open for the async response
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
});

api.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
});

api.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    api.tabs.create({ url: api.runtime.getURL('welcome.html') });
  }
});
