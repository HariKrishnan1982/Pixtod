const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = {
  hoverAction: 'showButtons',
  showDimensions: true,
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

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await storageGet(DEFAULT_SETTINGS);

  const radios = document.querySelectorAll('input[name="hoverAction"]');
  radios.forEach((radio) => {
    radio.checked = radio.value === settings.hoverAction;
    radio.addEventListener('change', () => {
      if (radio.checked) storageSet({ hoverAction: radio.value });
    });
  });

  const dimensionsToggle = document.getElementById('showDimensions');
  dimensionsToggle.checked = settings.showDimensions;
  dimensionsToggle.addEventListener('change', () => {
    storageSet({ showDimensions: dimensionsToggle.checked });
  });
});
