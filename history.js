const api = typeof browser !== 'undefined' ? browser : chrome;

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

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let allRecords = [];      // everything getHistory returned, newest first
let selectMode = false;
const selectedIds = new Set();

const searchInput = document.getElementById('searchInput');
const favoriteFilterBtn = document.getElementById('favoriteFilterBtn');
const tagFilterSelect = document.getElementById('tagFilterSelect');
const selectModeBtn = document.getElementById('selectModeBtn');
const bulkBar = document.getElementById('bulkBar');
const bulkCount = document.getElementById('bulkCount');
const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const noResultsState = document.getElementById('noResultsState');

let favoritesOnly = false;
let activeTag = '';

// ---------------------------------------------------------------
// Card building
// ---------------------------------------------------------------

const STAR_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 14.9 9.4 21.5 10.4 16.8 15 17.9 21.5 12 18.4 6.1 21.5 7.2 15 2.5 10.4 9.1 9.4 12 3.5Z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// Fixed, hardcoded SVG markup — never built from page/network data —
// but linters (AMO's included) flag any dynamic innerHTML assignment
// regardless of source. Parsing once into a real node and cloning on
// each use avoids innerHTML entirely.
const iconNodeCache = {};
function getIconNode(svgMarkup) {
  if (!iconNodeCache[svgMarkup]) {
    const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    iconNodeCache[svgMarkup] = parsed.documentElement;
  }
  return iconNodeCache[svgMarkup].cloneNode(true);
}

function buildCard(record) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = record.id || '';
  if (record.id && selectedIds.has(record.id)) card.classList.add('selected');

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  const selectBadge = document.createElement('span');
  selectBadge.className = 'select-badge';
  selectBadge.append(getIconNode(CHECK_ICON));
  thumbWrap.appendChild(selectBadge);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = record.url;
  img.alt = record.filename || '';
  img.addEventListener('error', () => {
    const broken = document.createElement('span');
    broken.className = 'broken';
    broken.textContent = 'Preview unavailable';
    img.replaceWith(broken);
  }, { once: true });
  thumbWrap.appendChild(img);

  const starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.className = 'star-btn';
  starBtn.append(getIconNode(STAR_ICON));
  starBtn.setAttribute('aria-pressed', record.favorite ? 'true' : 'false');
  starBtn.setAttribute('aria-label', record.favorite ? 'Unfavorite' : 'Favorite');
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(record);
  });
  thumbWrap.appendChild(starBtn);

  card.appendChild(thumbWrap);

  const meta = document.createElement('div');
  meta.className = 'meta';

  const filename = document.createElement('div');
  filename.className = 'filename';
  filename.textContent = record.filename || 'image';
  filename.title = record.filename || '';

  const siteTime = document.createElement('div');
  siteTime.className = 'site-time';
  const site = document.createElement('span');
  site.textContent = record.site || '';
  const time = document.createElement('span');
  time.textContent = relativeTime(record.savedAt || Date.now());
  siteTime.append(site, time);

  meta.append(filename, siteTime);
  meta.appendChild(buildTagRow(record));
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const openImg = document.createElement('a');
  openImg.href = record.url;
  openImg.target = '_blank';
  openImg.rel = 'noopener noreferrer';
  openImg.textContent = 'Open';
  actions.appendChild(openImg);
  if (record.pageUrl) {
    const openPage = document.createElement('a');
    openPage.href = record.pageUrl;
    openPage.target = '_blank';
    openPage.rel = 'noopener noreferrer';
    openPage.textContent = 'Page';
    actions.appendChild(openPage);
  }
  card.appendChild(actions);

  // In select mode, a click anywhere on the card body (outside the
  // star button / tag input / open links, which stop propagation
  // themselves) toggles that record's selection.
  card.addEventListener('click', () => {
    if (!selectMode || !record.id) return;
    toggleCardSelection(record.id);
  });

  return card;
}

function buildTagRow(record) {
  const row = document.createElement('div');
  row.className = 'tag-row';
  row.addEventListener('click', (e) => e.stopPropagation());

  const tags = Array.isArray(record.tags) ? record.tags : [];
  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const label = document.createElement('span');
    label.textContent = tag;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '\u00D7';
    remove.setAttribute('aria-label', `Remove tag ${tag}`);
    remove.addEventListener('click', () => removeTag(record, tag));
    chip.append(label, remove);
    row.appendChild(chip);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.placeholder = tags.length ? '+ tag' : 'add tag\u2026';
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = input.value.trim();
    if (value) addTag(record, value);
    input.value = '';
  });
  row.appendChild(input);

  return row;
}

// ---------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------

function allKnownTags() {
  const set = new Set();
  for (const r of allRecords) {
    for (const t of (r.tags || [])) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function refreshTagFilterOptions() {
  const tags = allKnownTags();
  const current = tagFilterSelect.value;
  tagFilterSelect.innerHTML = '<option value="">All tags</option>';
  for (const tag of tags) {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    tagFilterSelect.appendChild(opt);
  }
  // Keep the previous selection if it's still a valid tag; otherwise
  // fall back to "All tags" rather than silently pointing at a tag
  // that no longer exists on anything.
  if (tags.includes(current)) {
    tagFilterSelect.value = current;
  } else {
    tagFilterSelect.value = '';
    activeTag = '';
  }
}

function filteredRecords() {
  const query = searchInput.value.trim().toLowerCase();
  return allRecords.filter((r) => {
    if (favoritesOnly && !r.favorite) return false;
    if (activeTag && !(r.tags || []).includes(activeTag)) return false;
    if (query) {
      const haystack = `${r.filename || ''} ${r.site || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function render() {
  grid.innerHTML = '';
  grid.classList.toggle('select-mode', selectMode);

  if (allRecords.length === 0) {
    emptyState.hidden = false;
    noResultsState.hidden = true;
    updateBulkBar();
    return;
  }
  emptyState.hidden = true;

  const visible = filteredRecords();
  if (visible.length === 0) {
    noResultsState.hidden = false;
    updateBulkBar();
    return;
  }
  noResultsState.hidden = true;

  const frag = document.createDocumentFragment();
  for (const record of visible) frag.appendChild(buildCard(record));
  grid.appendChild(frag);
  updateBulkBar();
}

async function loadAndRender() {
  allRecords = (await callBackground({ action: 'getHistory' })) || [];
  // Selections can only refer to records that still exist (e.g. after
  // a delete elsewhere) — drop anything stale before rendering.
  const liveIds = new Set(allRecords.map((r) => r.id).filter(Boolean));
  for (const id of [...selectedIds]) if (!liveIds.has(id)) selectedIds.delete(id);
  refreshTagFilterOptions();
  render();
}

// ---------------------------------------------------------------
// Favorites / tags (persisted via background's updateHistoryRecord)
// ---------------------------------------------------------------

async function toggleFavorite(record) {
  if (!record.id) return;
  const next = !record.favorite;
  record.favorite = next; // optimistic local update
  render();
  await callBackground({ action: 'updateHistoryRecord', id: record.id, patch: { favorite: next } });
}

async function addTag(record, tag) {
  if (!record.id) return;
  const tags = Array.isArray(record.tags) ? record.tags : [];
  if (tags.includes(tag)) return;
  record.tags = [...tags, tag];
  refreshTagFilterOptions();
  render();
  await callBackground({ action: 'updateHistoryRecord', id: record.id, patch: { tags: record.tags } });
}

async function removeTag(record, tag) {
  if (!record.id) return;
  record.tags = (record.tags || []).filter((t) => t !== tag);
  refreshTagFilterOptions();
  render();
  await callBackground({ action: 'updateHistoryRecord', id: record.id, patch: { tags: record.tags } });
}

// ---------------------------------------------------------------
// Bulk select mode
// ---------------------------------------------------------------

function toggleCardSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  render();
}

function updateBulkBar() {
  bulkBar.hidden = !selectMode;
  bulkCount.textContent = `${selectedIds.size} selected`;
}

selectModeBtn.addEventListener('click', () => {
  selectMode = !selectMode;
  selectModeBtn.setAttribute('aria-pressed', selectMode ? 'true' : 'false');
  selectModeBtn.textContent = selectMode ? 'Done' : 'Select';
  if (!selectMode) selectedIds.clear();
  render();
});

document.getElementById('bulkClearBtn').addEventListener('click', () => {
  selectedIds.clear();
  render();
});

document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  if (!confirm(`Delete ${selectedIds.size} saved item${selectedIds.size > 1 ? 's' : ''}? This can't be undone.`)) return;
  const ids = [...selectedIds];
  await callBackground({ action: 'deleteHistoryRecords', ids });
  selectedIds.clear();
  await loadAndRender();
});

document.getElementById('bulkDownloadBtn').addEventListener('click', async (e) => {
  if (selectedIds.size === 0) return;
  const btn = e.currentTarget;
  const originalText = btn.textContent;
  btn.textContent = 'Downloading\u2026';
  btn.disabled = true;
  try {
    const targets = allRecords.filter((r) => r.id && selectedIds.has(r.id));
    for (const record of targets) {
      // eslint-disable-next-line no-await-in-loop -- deliberately
      // sequential so a burst of saveAs-less downloads doesn't get
      // silently rate-limited or reordered by the browser.
      await callBackground({ action: 'download', url: record.url, filename: record.filename, saveAs: false });
    }
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------
// Filter bar wiring
// ---------------------------------------------------------------

searchInput.addEventListener('input', render);

favoriteFilterBtn.addEventListener('click', () => {
  favoritesOnly = !favoritesOnly;
  favoriteFilterBtn.setAttribute('aria-pressed', favoritesOnly ? 'true' : 'false');
  render();
});

tagFilterSelect.addEventListener('change', () => {
  activeTag = tagFilterSelect.value;
  render();
});

// ---------------------------------------------------------------
// Clear all
// ---------------------------------------------------------------

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('Clear the entire saved history? This can\'t be undone.')) return;
  await callBackground({ action: 'clearHistory' });
  selectedIds.clear();
  await loadAndRender();
});

loadAndRender();
