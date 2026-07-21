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

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    api.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: request.saveAs,
    });
    sendResponse && sendResponse();
    return;
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
