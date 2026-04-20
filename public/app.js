/* =============================================
   STATE
   ============================================= */
let currentResults = [];
let bookmarks = [];
let timerInterval = null;

/* =============================================
   INIT
   ============================================= */
document.addEventListener('DOMContentLoaded', async () => {
  setupNav();
  setupSearch();
  setupExport();
  await loadBookmarks();
  await loadHistory();
});

/* =============================================
   NAVIGATION
   ============================================= */
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.panel;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${target}`).classList.add('active');
    });
  });
}

/* =============================================
   SEARCH
   ============================================= */
function setupSearch() {
  const form = document.getElementById('searchForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await runSearch({
      keyword: document.getElementById('keyword').value.trim(),
      city: document.getElementById('city').value.trim(),
      country: document.getElementById('country').value.trim(),
      maxResults: document.getElementById('maxResults').value,
      ratingMin: document.getElementById('ratingMin').value || '',
      ratingMax: document.getElementById('ratingMax').value || '',
      maxReviews: document.getElementById('maxReviews').value || ''
    });
  });
}

async function runSearch({ keyword, city, country, maxResults, ratingMin, ratingMax, maxReviews }) {
  // UI state: loading
  setLoading(true);
  hideResults();
  hideError();

  const elapsed = { s: 0 };
  const timerEl = document.getElementById('loadingTimer');
  timerInterval = setInterval(() => {
    elapsed.s++;
    timerEl.textContent = `${elapsed.s}s elapsed`;
  }, 1000);

  setApiStatus('loading', 'Scraping…');

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, city, country, maxResults, ratingMin, ratingMax, maxReviews })
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Search failed.');
      return;
    }

    currentResults = data.results || [];
    renderResults(keyword, city, country, currentResults);
    await loadHistory();
    setApiStatus('ok', 'Ready');
    showToast(`Found ${currentResults.length} results`, 'success');
  } catch (err) {
    showError('Network error — is the server running?');
    setApiStatus('error', 'Error');
  } finally {
    setLoading(false);
    clearInterval(timerInterval);
  }
}

/* =============================================
   RENDER RESULTS
   ============================================= */
function renderResults(keyword, city, country, results) {
  const section = document.getElementById('resultsSection');
  const emptyState = document.getElementById('emptyState');
  const body = document.getElementById('resultsBody');

  document.getElementById('resultsTitle').textContent = `${keyword} in ${city}, ${country}`;
  document.getElementById('resultsMeta').textContent = `${results.length} businesses found`;

  body.innerHTML = '';

  if (results.length === 0) {
    section.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  results.forEach((r, i) => {
    const isBookmarked = bookmarks.some(b => b.name === r.name && b.address === r.address);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <button class="btn--icon ${isBookmarked ? 'bookmarked' : ''}"
                title="${isBookmarked ? 'Remove bookmark' : 'Bookmark this lead'}"
                data-idx="${i}">
          <svg viewBox="0 0 24 24" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      </td>
      <td class="cell-name">
        ${r.placeUrl
          ? `<a href="${escHtml(r.placeUrl)}" target="_blank" rel="noopener">${escHtml(r.name)}</a>`
          : escHtml(r.name)
        }
      </td>
      <td>${r.rating ? `<span class="rating"><span class="rating-star">★</span>${r.rating.toFixed(1)}</span>` : '<span class="no-data">—</span>'}</td>
      <td>${r.reviewCount ? Number(r.reviewCount).toLocaleString() : '<span class="no-data">—</span>'}</td>
      <td class="cell-phone">${r.phone ? escHtml(r.phone) : '<span class="no-data">—</span>'}</td>
      <td class="cell-website">${r.website
          ? `<a href="${escHtml(r.website)}" target="_blank" rel="noopener">${shortenUrl(r.website)}</a>`
          : '<span class="no-data">—</span>'
        }</td>
      <td class="cell-address">${r.address ? escHtml(r.address) : '<span class="no-data">—</span>'}</td>
      <td>${r.category ? `<span class="pill">${escHtml(r.category)}</span>` : ''}</td>
    `;

    tr.querySelector('.btn--icon').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBookmark(i, tr.querySelector('.btn--icon'));
    });

    body.appendChild(tr);
  });

  section.classList.remove('hidden');
  emptyState.classList.add('hidden');
}

/* =============================================
   BOOKMARKS
   ============================================= */
async function loadBookmarks() {
  try {
    const res = await fetch('/api/bookmarks');
    bookmarks = await res.json();
    updateBookmarkBadge();
    renderBookmarks();
  } catch {}
}

async function toggleBookmark(idx, btnEl) {
  const lead = currentResults[idx];
  if (!lead) return;

  const existingIdx = bookmarks.findIndex(b => b.name === lead.name && b.address === lead.address);

  if (existingIdx >= 0) {
    // Remove bookmark
    const id = bookmarks[existingIdx].id;
    await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' });
    showToast('Bookmark removed');
  } else {
    // Add bookmark
    const res = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || 'Could not bookmark', 'error');
      return;
    }
    showToast('Lead bookmarked!', 'success');
  }

  await loadBookmarks();

  // Update button state
  const isNowBookmarked = bookmarks.some(b => b.name === lead.name && b.address === lead.address);
  btnEl.classList.toggle('bookmarked', isNowBookmarked);
  btnEl.title = isNowBookmarked ? 'Remove bookmark' : 'Bookmark this lead';
  const svg = btnEl.querySelector('svg');
  svg.setAttribute('fill', isNowBookmarked ? 'currentColor' : 'none');
}

async function bookmarkAll() {
  if (!currentResults.length) return;
  let added = 0;
  for (const lead of currentResults) {
    const res = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    if (res.ok) added++;
  }
  await loadBookmarks();
  // Refresh result rows bookmark icons
  if (currentResults.length) {
    const keyword = document.getElementById('keyword').value.trim();
    const city = document.getElementById('city').value.trim();
    const country = document.getElementById('country').value.trim();
    renderResults(keyword, city, country, currentResults);
  }
  showToast(`Bookmarked ${added} new leads`, 'success');
}

function renderBookmarks() {
  const body = document.getElementById('bookmarksBody');
  const emptyEl = document.getElementById('bookmarksEmpty');
  const wrapper = document.getElementById('bookmarksTableWrapper');

  body.innerHTML = '';

  if (!bookmarks.length) {
    wrapper.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  wrapper.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  bookmarks.forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-name">
        ${b.placeUrl
          ? `<a href="${escHtml(b.placeUrl)}" target="_blank" rel="noopener">${escHtml(b.name)}</a>`
          : escHtml(b.name)
        }
      </td>
      <td>${b.rating ? `<span class="rating"><span class="rating-star">★</span>${Number(b.rating).toFixed(1)}</span>` : '<span class="no-data">—</span>'}</td>
      <td>${b.reviewCount ? Number(b.reviewCount).toLocaleString() : '<span class="no-data">—</span>'}</td>
      <td class="cell-phone">${b.phone ? escHtml(b.phone) : '<span class="no-data">—</span>'}</td>
      <td class="cell-website">${b.website
          ? `<a href="${escHtml(b.website)}" target="_blank" rel="noopener">${shortenUrl(b.website)}</a>`
          : '<span class="no-data">—</span>'
        }</td>
      <td class="cell-address">${b.address ? escHtml(b.address) : '<span class="no-data">—</span>'}</td>
      <td>
        <button class="btn--icon btn--danger" title="Remove bookmark" data-id="${b.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>
      </td>
    `;

    tr.querySelector('.btn--icon').addEventListener('click', async () => {
      await fetch(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
      await loadBookmarks();
      showToast('Bookmark removed');
    });

    body.appendChild(tr);
  });
}

function updateBookmarkBadge() {
  const badge = document.getElementById('bookmarkBadge');
  badge.textContent = bookmarks.length || '';
}

document.getElementById('bookmarkAllBtn').addEventListener('click', bookmarkAll);

document.getElementById('clearBookmarksBtn').addEventListener('click', async () => {
  if (!bookmarks.length) return;
  if (!confirm('Clear all bookmarks?')) return;
  await fetch('/api/bookmarks', { method: 'DELETE' });
  await loadBookmarks();
  showToast('All bookmarks cleared');
});

/* =============================================
   HISTORY
   ============================================= */
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderHistory(history);
    document.getElementById('historyBadge').textContent = history.length || '';
  } catch {}
}

function renderHistory(history) {
  const list = document.getElementById('historyList');
  const emptyEl = document.getElementById('historyEmpty');

  list.innerHTML = '';

  if (!history.length) {
    list.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  list.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  history.forEach(h => {
    const card = document.createElement('div');
    card.className = 'history-card';
    const date = new Date(h.searchedAt).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    card.innerHTML = `
      <div class="history-card-info">
        <div class="history-card-title">${escHtml(h.keyword)} in ${escHtml(h.city)}, ${escHtml(h.country)}</div>
        <div class="history-card-meta">
          <span>${h.resultCount} results</span>
          <span>${date}</span>
        </div>
      </div>
      <div class="history-card-actions">
        <button class="re-run-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Re-run
        </button>
        <button class="btn--icon" title="Remove" data-id="${h.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `;

    card.querySelector('.re-run-btn').addEventListener('click', async () => {
      // Switch to search panel
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-panel="search"]').classList.add('active');
      document.getElementById('panel-search').classList.add('active');

      document.getElementById('keyword').value = h.keyword;
      document.getElementById('city').value = h.city;
      document.getElementById('country').value = h.country;
      document.getElementById('maxResults').value = h.maxResults || 20;

      await runSearch({ keyword: h.keyword, city: h.city, country: h.country, maxResults: h.maxResults || 20 });
    });

    card.querySelector('.btn--icon').addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/history/${h.id}`, { method: 'DELETE' });
      await loadHistory();
    });

    list.appendChild(card);
  });
}

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  const history = await (await fetch('/api/history')).json();
  if (!history.length) return;
  if (!confirm('Clear all search history?')) return;
  await fetch('/api/history', { method: 'DELETE' });
  await loadHistory();
  showToast('History cleared');
});

/* =============================================
   CSV EXPORT
   ============================================= */
function setupExport() {
  document.getElementById('exportBtn').addEventListener('click', () => {
    if (!currentResults.length) return;
    downloadCSV(currentResults, 'leads-export.csv');
  });

  document.getElementById('exportBookmarksBtn').addEventListener('click', () => {
    if (!bookmarks.length) { showToast('No bookmarks to export', 'error'); return; }
    downloadCSV(bookmarks, 'bookmarked-leads.csv');
  });
}

function downloadCSV(data, filename) {
  const headers = ['Name', 'Rating', 'Reviews', 'Phone', 'Website', 'Address', 'Category', 'Google Maps URL'];
  const rows = data.map(r => [
    r.name, r.rating || '', r.reviewCount || '', r.phone || '',
    r.website || '', r.address || '', r.category || '', r.placeUrl || ''
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`CSV downloaded: ${filename}`, 'success');
}

/* =============================================
   UI HELPERS
   ============================================= */
function setLoading(on) {
  document.getElementById('loading').classList.toggle('hidden', !on);
  const btn = document.getElementById('searchBtn');
  btn.disabled = on;
  btn.textContent = on ? 'Searching…' : '';
  if (!on) {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      Search Leads
    `;
  }
}

function hideResults() {
  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('emptyState').classList.add('hidden');
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  document.getElementById('errorText').textContent = msg;
  box.classList.remove('hidden');
  setApiStatus('error', 'Error');
}

function hideError() {
  document.getElementById('errorBox').classList.add('hidden');
}

function setApiStatus(state, text) {
  const dot = document.querySelector('.status-dot');
  dot.className = 'status-dot' + (state === 'loading' ? ' loading' : state === 'error' ? ' error' : '');
  document.getElementById('apiStatusText').textContent = text;
}

let toastTimer = null;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type ? ' ' + type : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
