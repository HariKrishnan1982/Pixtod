// Cross-browser alias — Firefox exposes `browser` (promise-based),
// Chrome/Edge expose `chrome` (callback-based); both accept the
// listener pattern used below.
const api = typeof browser !== 'undefined' ? browser : chrome;

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
      const text = request.count > 0 ? String(request.count) : '';
      api.action.setBadgeText({ text, tabId });
      api.action.setBadgeBackgroundColor({ color: '#00c853', tabId });
    }
    sendResponse && sendResponse();
    return;
  }
});
