const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = {
  showDimensions: true,
  popupTheme: 'dark',
  overlayPosition: 'top-right',
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

function getActiveTabId() {
  return new Promise((resolve) => {
    try {
      const maybePromise = api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0].id : null);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((tabs) => resolve(tabs && tabs[0] ? tabs[0].id : null)).catch(() => resolve(null));
      }
    } catch {
      resolve(null);
    }
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

  wirePositionGrid(settings.overlayPosition);

  renderStats();
});
