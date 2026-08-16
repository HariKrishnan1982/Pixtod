const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = {
  showDimensions: true,
  popupTheme: 'dark',
  overlayPosition: 'top-right',
  saveFormat: 'original',
  copyUrlButtonEnabled: false,
  reverseSearchEngine: 'google',
  masterKey: 'shift',
  shortcutView: 'v',
  shortcutSave: 's',
  shortcutCopy: 'c',
  shortcutSearch: 'f',
  shortcutFrame: 'g',
};

function storageGet(defaults) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const maybePromise = api.storage.sync.get(defaults, (res) => done(res || defaults));
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(done).catch(() => done(defaults));
      }
    } catch {
      done(defaults);
    }
  });
}

function storageSet(values) {
  try {
    const maybePromise = api.storage.sync.set(values);
    if (maybePromise && typeof maybePromise.then === 'function') maybePromise.catch(() => {});
  } catch {
    /* ignore — best effort */
  }
}

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

function getActiveTab() {
  return new Promise((resolve) => {
    try {
      const maybePromise = api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((tabs) => resolve(tabs && tabs[0] ? tabs[0] : null)).catch(() => resolve(null));
      }
    } catch {
      resolve(null);
    }
  });
}

function getActiveTabId() {
  return getActiveTab().then((tab) => (tab ? tab.id : null));
}

function safeHostname(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getBytesInUse(key) {
  return new Promise((resolve) => {
    try {
      if (!api.storage.local.getBytesInUse) { resolve(0); return; }
      const maybePromise = api.storage.local.getBytesInUse(key, (bytes) => resolve(bytes || 0));
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((bytes) => resolve(bytes || 0)).catch(() => resolve(0));
      }
    } catch {
      resolve(0);
    }
  });
}

// Popup context can decode/re-encode via canvas the same way the
// content script does for Copy, just without the DOM image element —
// createImageBitmap works directly off the fetched blob here.
async function ensurePngBlob(blob) {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('encode failed'))), 'image/png');
  });
}

function wireSwitch(id, initialValue, onChange) {
  const btn = document.getElementById(id);
  const setChecked = (checked) => btn.setAttribute('aria-checked', String(checked));
  setChecked(!!initialValue);
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    setChecked(next);
    onChange(next);
  });
}

function wirePositionGrid(initialValue) {
  const buttons = document.querySelectorAll('.pos-btn');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pos === initialValue);
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      storageSet({ overlayPosition: btn.dataset.pos });
    });
  });
}

function wireFormatGrid(initialValue) {
  const buttons = document.querySelectorAll('.format-btn');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.format === (initialValue || 'original'));
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      storageSet({ saveFormat: btn.dataset.format });
    });
  });
}

function wireEngineGrid(initialValue) {
  const buttons = document.querySelectorAll('.engine-btn:not(.modifier-btn)');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.engine === (initialValue || 'google'));
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      storageSet({ reverseSearchEngine: btn.dataset.engine });
    });
  });
}

function masterKeyLabel(masterKey) {
  switch (masterKey) {
    case 'ctrl': return 'Ctrl';
    case 'alt': return 'Alt';
    case 'shift':
    default: return 'Shift';
  }
}

function wireModifierGrid(settings) {
  const buttons = document.querySelectorAll('.modifier-btn');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.modifier === (settings.masterKey || 'shift'));
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      settings.masterKey = btn.dataset.modifier;
      storageSet({ masterKey: settings.masterKey });
      refreshShortcutDisplays(settings);
    });
  });
}

// ---------------------------------------------------------------
// Customizable keyboard shortcuts
// ---------------------------------------------------------------

const SHORTCUT_SETTING_KEYS = {
  view: 'shortcutView',
  save: 'shortcutSave',
  copy: 'shortcutCopy',
  search: 'shortcutSearch',
  frame: 'shortcutFrame',
};

// Ids of the small kbd hints in the always-visible help panel, kept
// in sync with whatever's actually bound so the printed cheat-sheet
// never goes stale after a rebind.
const HELP_KBD_IDS = {
  view: 'helpKeyView',
  save: 'helpKeySave',
  copy: 'helpKeyCopy',
  search: 'helpKeySearch',
  frame: 'helpKeyFrame',
};

function refreshShortcutDisplays(settings) {
  const modifierKbd = document.getElementById('helpModifierKbd');
  if (modifierKbd) modifierKbd.textContent = masterKeyLabel(settings.masterKey);

  for (const [action, settingKey] of Object.entries(SHORTCUT_SETTING_KEYS)) {
    const key = String(settings[settingKey] || '').toUpperCase();
    const btn = document.querySelector(`.shortcut-btn[data-shortcut="${action}"]`);
    if (btn) {
      const kbd = btn.querySelector('kbd');
      if (kbd) kbd.textContent = key;
    }
    const helpKbd = document.getElementById(HELP_KBD_IDS[action]);
    if (helpKbd) helpKbd.textContent = key;
  }
}

// A key is valid for rebinding if it's a single printable character —
// this deliberately excludes modifier-only presses (Shift itself,
// Control, etc.) and multi-character key names (Escape, ArrowLeft),
// since the shortcut is always triggered as Shift+<that character>.
function isBindableKey(e) {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

function wireShortcutGrid(settings) {
  const buttons = document.querySelectorAll('.shortcut-btn');
  let recordingBtn = null;

  function stopRecording() {
    if (recordingBtn) recordingBtn.classList.remove('recording');
    recordingBtn = null;
    document.removeEventListener('keydown', onKeydown, true);
  }

  function onKeydown(e) {
    if (!recordingBtn) return;
    if (e.key === 'Escape') { e.preventDefault(); stopRecording(); return; }
    if (!isBindableKey(e)) return; // wait for a real, bindable key instead of bailing out
    e.preventDefault();
    e.stopPropagation();
    const action = recordingBtn.dataset.shortcut;
    const settingKey = SHORTCUT_SETTING_KEYS[action];
    const key = e.key.toLowerCase();
    storageSet({ [settingKey]: key });
    settings[settingKey] = key;
    refreshShortcutDisplays(settings);
    stopRecording();
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (recordingBtn === btn) { stopRecording(); return; }
      stopRecording();
      recordingBtn = btn;
      btn.classList.add('recording');
      document.addEventListener('keydown', onKeydown, true);
    });
  });

  refreshShortcutDisplays(settings);
}

async function renderStats() {
  const tabId = await getActiveTabId();
  if (tabId == null) return;
  const stats = await callBackground({ action: 'getStats', tabId });
  if (!stats || !stats.count) return;

  const bar = document.getElementById('statsBar');
  const text = document.getElementById('statsText');
  text.textContent = `${stats.count} image${stats.count === 1 ? '' : 's'} found \u00B7 ${stats.fullRes} full-res \u00B7 ${stats.thumbnailOnly} thumbnail-only`;
  bar.hidden = false;
}

// ---------------------------------------------------------------
// Recent captures strip + "copy last saved again" quick action
// ---------------------------------------------------------------

let cachedHistory = null;

async function getHistoryCached() {
  if (cachedHistory) return cachedHistory;
  cachedHistory = (await callBackground({ action: 'getHistory' })) || [];
  return cachedHistory;
}

function invalidateHistoryCache() {
  cachedHistory = null;
}

async function renderRecent() {
  const section = document.getElementById('recentSection');
  const strip = document.getElementById('recentStrip');
  const copyBtn = document.getElementById('copyLastBtn');
  if (!section || !strip) return;

  const history = await getHistoryCached();
  if (!history.length) {
    section.hidden = true;
    if (copyBtn) copyBtn.disabled = true;
    return;
  }

  section.hidden = false;
  if (copyBtn) copyBtn.disabled = false;

  strip.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const record of history.slice(0, 6)) {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'recent-thumb';
    thumb.title = record.filename || '';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = record.url;
    img.alt = '';
    img.addEventListener('error', () => thumb.classList.add('broken'), { once: true });
    thumb.appendChild(img);
    thumb.addEventListener('click', () => {
      api.tabs.create({ url: record.url });
    });
    frag.appendChild(thumb);
  }
  strip.appendChild(frag);
}

function flashMiniBtn(btn, ok) {
  btn.classList.remove('copy-ok', 'copy-err');
  btn.classList.add(ok ? 'copy-ok' : 'copy-err');
  setTimeout(() => btn.classList.remove('copy-ok', 'copy-err'), 1200);
}

async function copyLastSaved() {
  const btn = document.getElementById('copyLastBtn');
  if (!btn || btn.disabled) return;
  const history = await getHistoryCached();
  const last = history[0];
  if (!last) return;

  btn.disabled = true;
  try {
    const result = await callBackground({ action: 'fetchImageBytes', url: last.url });
    if (!result || !result.ok) throw new Error((result && result.error) || 'fetch failed');
    const rawBlob = new Blob([result.buf], { type: result.mime || 'application/octet-stream' });
    const pngBlob = await ensurePngBlob(rawBlob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    flashMiniBtn(btn, true);
  } catch {
    flashMiniBtn(btn, false);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Per-site on/off toggle
// ---------------------------------------------------------------

async function initSiteToggle() {
  const row = document.getElementById('siteToggleRow');
  const label = document.getElementById('siteHostText');
  const toggle = document.getElementById('siteToggle');
  if (!row || !label || !toggle) return;

  const tab = await getActiveTab();
  const hostname = tab && tab.url ? safeHostname(tab.url) : null;
  if (!hostname) return; // leave hidden — extension pages, chrome://, etc.

  label.textContent = hostname;
  row.hidden = false;

  const stored = await storageGet({ disabledSites: [] });
  const disabledSites = Array.isArray(stored.disabledSites) ? stored.disabledSites : [];
  toggle.setAttribute('aria-checked', String(!disabledSites.includes(hostname)));

  toggle.addEventListener('click', async () => {
    const nowActive = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(nowActive));
    const current = await storageGet({ disabledSites: [] });
    const list = Array.isArray(current.disabledSites) ? current.disabledSites.slice() : [];
    const next = nowActive ? list.filter((h) => h !== hostname) : (list.includes(hostname) ? list : [...list, hostname]);
    storageSet({ disabledSites: next });
  });
}

// ---------------------------------------------------------------
// Storage usage meter
// ---------------------------------------------------------------

async function renderStorageMeter() {
  const fill = document.getElementById('storageMeterFill');
  const text = document.getElementById('storageMeterText');
  const clearBtn = document.getElementById('clearStorageBtn');
  if (!fill || !text) return;

  const [bytes, history] = await Promise.all([getBytesInUse('ivxHistory'), getHistoryCached()]);
  const quota = api.storage.local.QUOTA_BYTES || 10485760;
  const pct = Math.max(0, Math.min(100, (bytes / quota) * 100));
  fill.style.width = `${pct}%`;
  text.textContent = `${formatBytes(bytes)} of ${formatBytes(quota)} \u00B7 ${history.length} saved`;
  if (clearBtn) clearBtn.hidden = history.length === 0;
}

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await storageGet(DEFAULT_SETTINGS);

  document.documentElement.setAttribute('data-theme', settings.popupTheme === 'dark' ? 'dark' : 'light');

  wireSwitch('darkTheme', settings.popupTheme === 'dark', (checked) => {
    document.documentElement.setAttribute('data-theme', checked ? 'dark' : 'light');
    storageSet({ popupTheme: checked ? 'dark' : 'light' });
  });

  wireSwitch('showDimensions', settings.showDimensions, (checked) => {
    storageSet({ showDimensions: checked });
  });

  wireSwitch('copyUrlToggle', settings.copyUrlButtonEnabled, (checked) => {
    storageSet({ copyUrlButtonEnabled: checked });
  });

  wirePositionGrid(settings.overlayPosition);
  wireFormatGrid(settings.saveFormat);
  wireEngineGrid(settings.reverseSearchEngine);
  wireModifierGrid(settings);
  wireShortcutGrid(settings);

  renderStats();
  renderRecent();
  renderStorageMeter();
  initSiteToggle();

  const copyLastBtn = document.getElementById('copyLastBtn');
  if (copyLastBtn) copyLastBtn.addEventListener('click', copyLastSaved);

  const clearStorageBtn = document.getElementById('clearStorageBtn');
  if (clearStorageBtn) {
    clearStorageBtn.addEventListener('click', async () => {
      if (!confirm('Clear the entire saved history? This can\'t be undone.')) return;
      await callBackground({ action: 'clearHistory' });
      invalidateHistoryCache();
      renderRecent();
      renderStorageMeter();
    });
  }

  const historyLink = document.getElementById('historyLink');
  if (historyLink) {
    historyLink.addEventListener('click', (e) => {
      e.preventDefault();
      api.tabs.create({ url: api.runtime.getURL('history.html') });
    });
  }

  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsBack = document.getElementById('settingsBack');
  if (mainView && settingsView && settingsBtn && settingsBack) {
    settingsBtn.addEventListener('click', () => {
      // Toggle: hitting the gear again while already in settings just
      // takes you back to main, same as the back arrow — no reason to
      // force people through the explicit back button every time.
      const inSettings = !settingsView.hidden;
      settingsView.hidden = inSettings;
      mainView.hidden = !inSettings;
    });
    settingsBack.addEventListener('click', () => {
      settingsView.hidden = true;
      mainView.hidden = false;
    });
  }

  const helpToggle = document.getElementById('helpToggle');
  const helpPanel = document.getElementById('helpPanel');
  if (helpToggle && helpPanel) {
    helpToggle.addEventListener('click', () => {
      const expanded = helpToggle.getAttribute('aria-expanded') === 'true';
      helpToggle.setAttribute('aria-expanded', String(!expanded));
      helpPanel.hidden = expanded;
    });
  }
});
