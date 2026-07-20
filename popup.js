const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = {
  showDimensions: true,
  popupTheme: 'light',
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
});
