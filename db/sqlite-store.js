// Persistent store with two interchangeable backends.
//
// Primary backend: better-sqlite3 → ./data/leadhunter.sqlite
//   Used in every environment that can compile the native module
//   (needs python + make + gcc on the build host).
//
// Fallback backend: in-memory JS Maps
//   Activated when require('better-sqlite3') throws. Same public surface
//   so every caller in server.js works unchanged. Search history and
//   chain-tier cache live for the lifetime of the container — they reset
//   on restart, just like the pre-Phase-B JSON db did.
//
// Replit Autoscale's build container has been failing to compile
// better-sqlite3 (toolchain gaps), causing the deploy to silently
// roll back to a stale build. The fallback unblocks that — the app
// boots either way, and if/when the toolchain becomes available the
// SQLite backend takes over automatically with no code change.
//
// Override the default SQLite location via env: LEADHUNTER_DB_PATH=…

const path = require('path');
const fs = require('fs');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'leadhunter.sqlite');
const DB_PATH = process.env.LEADHUNTER_DB_PATH || DEFAULT_PATH;
const CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, hardcoded

// ============================================================================
// Backend selection
// ============================================================================

let backend;
let backendName = 'memory';

try {
  backend = createSqliteBackend(DB_PATH);
  backendName = 'sqlite';
  console.log(`[storage] SQLite ready at ${DB_PATH}`);
} catch (err) {
  backend = createMemoryBackend();
  backendName = 'memory';
  console.warn(`[storage] better-sqlite3 unavailable (${err.code || err.message}). Falling back to in-memory store. Search history will NOT persist across container restarts.`);
}

// ============================================================================
// SQLite backend (preferred)
// ============================================================================

function createSqliteBackend(dbPath) {
  const Database = require('better-sqlite3'); // may throw

  // Ensure the directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      search_params_hash     TEXT NOT NULL,
      keyword                TEXT NOT NULL,
      city                   TEXT NOT NULL,
      country                TEXT NOT NULL,
      rating_min             REAL,
      rating_max             REAL,
      max_reviews            INTEGER,
      results_limit          INTEGER,
      segment_target         TEXT,
      outreach_priority      TEXT,
      total_leads            INTEGER,
      email_count            INTEGER,
      phone_count            INTEGER,
      instagram_count        INTEGER,
      serpapi_credits_used   INTEGER,
      results_json           TEXT,
      created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed          DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_search_hash    ON search_history (search_params_hash);
    CREATE INDEX IF NOT EXISTS idx_search_created ON search_history (created_at DESC);

    CREATE TABLE IF NOT EXISTS saved_leads (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      title     TEXT NOT NULL UNIQUE,
      lead_json TEXT NOT NULL,
      saved_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_saved_leads_saved_at ON saved_leads (saved_at DESC);

    CREATE TABLE IF NOT EXISTS chain_tier_cache (
      root_name              TEXT PRIMARY KEY,
      tier                   TEXT,
      knowledge_graph_present INTEGER,
      total_results          INTEGER,
      classified_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    recordSearch(row) {
      const info = db.prepare(`
        INSERT INTO search_history
          (search_params_hash, keyword, city, country,
           rating_min, rating_max, max_reviews, results_limit, segment_target, outreach_priority,
           total_leads, email_count, phone_count, instagram_count, serpapi_credits_used,
           results_json, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        row.hash, row.keyword, row.city, row.country,
        row.rating_min ?? null, row.rating_max ?? null, row.max_reviews ?? null,
        row.results_limit ?? null, row.segment_target ?? null, row.outreach_priority ?? null,
        row.total_leads ?? 0, row.email_count ?? 0, row.phone_count ?? 0, row.instagram_count ?? 0,
        row.serpapi_credits_used ?? 0,
        row.results_json
      );
      return info.lastInsertRowid;
    },

    findCachedSearch(hash) {
      const row = db.prepare(`
        SELECT *, (julianday('now') - julianday(created_at)) AS age_days
        FROM search_history
        WHERE search_params_hash = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(hash);
      if (!row) return null;
      if ((row.age_days * 86400 * 1000) > CACHE_WINDOW_MS) return null;
      return row;
    },

    touchAccess(id) {
      db.prepare(`UPDATE search_history SET last_accessed = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    },

    getSearchById(id) {
      return db.prepare(`SELECT * FROM search_history WHERE id = ?`).get(id);
    },

    deleteSearchById(id) {
      return db.prepare(`DELETE FROM search_history WHERE id = ?`).run(id);
    },

    invalidateHash(hash) {
      return db.prepare(`DELETE FROM search_history WHERE search_params_hash = ?`).run(hash);
    },

    listSearches({ from, to, city, keyword, sort, dir, limit = 500 } = {}) {
      const where = [];
      const args = [];
      if (from) { where.push(`created_at >= ?`); args.push(from); }
      if (to)   { where.push(`created_at <= ?`); args.push(to); }
      if (city) {
        where.push(`(LOWER(city) LIKE ? OR LOWER(country) LIKE ?)`);
        const like = '%' + String(city).toLowerCase() + '%';
        args.push(like, like);
      }
      if (keyword) {
        where.push(`LOWER(keyword) LIKE ?`);
        args.push('%' + String(keyword).toLowerCase() + '%');
      }
      const sortCol = ({ created: 'created_at', leads: 'total_leads', credits: 'serpapi_credits_used' }[sort]) || 'created_at';
      const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
      const sql = `
        SELECT id, search_params_hash, keyword, city, country, rating_min, rating_max,
               max_reviews, results_limit, segment_target, outreach_priority,
               total_leads, email_count, phone_count, instagram_count, serpapi_credits_used,
               created_at, last_accessed
        FROM search_history
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ?
      `;
      return db.prepare(sql).all(...args, limit);
    },

    getStats() {
      const totalSearches = db.prepare(`SELECT COUNT(*) AS n FROM search_history`).get().n || 0;
      const totalLeads    = db.prepare(`SELECT COALESCE(SUM(total_leads), 0) AS n FROM search_history`).get().n || 0;
      const monthlyCredits = db.prepare(`
        SELECT COALESCE(SUM(serpapi_credits_used), 0) AS n FROM search_history
        WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
      `).get().n || 0;
      const topCity = db.prepare(`
        SELECT city, COUNT(*) AS n FROM search_history
        WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
        GROUP BY LOWER(city) ORDER BY n DESC LIMIT 1
      `).get();
      return {
        totalSearches, totalLeads, monthlyCredits,
        topCity: topCity ? topCity.city : null,
        topCityCount: topCity ? topCity.n : 0,
      };
    },

    getRecentSearches(n = 5) {
      return db.prepare(`
        SELECT id, keyword, city, country AS state, total_leads AS resultCount, created_at AS date
        FROM search_history ORDER BY created_at DESC LIMIT ?
      `).all(n).map(r => ({ key: String(r.id), ...r }));
    },

    getSidebarCounts() {
      return {
        historyCount:    db.prepare(`SELECT COUNT(*) AS n FROM search_history`).get().n || 0,
        savedLeadsCount: db.prepare(`SELECT COUNT(*) AS n FROM saved_leads`).get().n || 0,
      };
    },

    listSavedLeads() {
      const rows = db.prepare(`SELECT id, lead_json, saved_at FROM saved_leads ORDER BY saved_at DESC`).all();
      return rows.map(r => ({ key: String(r.id), ...JSON.parse(r.lead_json), savedAt: r.saved_at }));
    },

    listSavedLeadKeys() {
      return db.prepare(`SELECT id, title FROM saved_leads`).all().map(r => ({ key: String(r.id), title: r.title }));
    },

    saveLead(lead) {
      if (!lead || !lead.title) throw new Error('lead.title required');
      const existing = db.prepare(`SELECT id FROM saved_leads WHERE title = ?`).get(lead.title);
      if (existing) return { status: 'exists', key: String(existing.id) };
      const info = db.prepare(`INSERT INTO saved_leads (title, lead_json) VALUES (?, ?)`)
                      .run(lead.title, JSON.stringify(lead));
      return { status: 'saved', key: String(info.lastInsertRowid) };
    },

    deleteSavedLead(key) {
      return db.prepare(`DELETE FROM saved_leads WHERE id = ?`).run(parseInt(key, 10));
    },

    getChainTier(rootName) {
      return db.prepare(`SELECT root_name, tier, knowledge_graph_present, total_results, classified_at FROM chain_tier_cache WHERE root_name = ?`)
        .get(String(rootName || '').toLowerCase().trim());
    },

    setChainTier(rootName, row) {
      return db.prepare(`
        INSERT INTO chain_tier_cache (root_name, tier, knowledge_graph_present, total_results, classified_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(root_name) DO UPDATE SET
          tier = excluded.tier,
          knowledge_graph_present = excluded.knowledge_graph_present,
          total_results = excluded.total_results,
          classified_at = CURRENT_TIMESTAMP
      `).run(
        String(rootName || '').toLowerCase().trim(),
        row.tier, row.knowledge_graph_present ? 1 : 0, row.total_results || 0
      );
    },

    migrateFromJSON(jsonPath) {
      const markerPath = jsonPath + '.migrated';
      if (fs.existsSync(markerPath)) return { migrated: 0 };
      if (!fs.existsSync(jsonPath)) return { migrated: 0 };
      let raw;
      try { raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return { migrated: 0 }; }
      const { hashSearchParams } = require('./hash');
      let importedSearches = 0, importedLeads = 0;
      const insertSearch = db.prepare(`
        INSERT INTO search_history
          (search_params_hash, keyword, city, country,
           rating_min, rating_max, max_reviews, results_limit, segment_target, outreach_priority,
           total_leads, email_count, phone_count, instagram_count, serpapi_credits_used,
           results_json, created_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertLead = db.prepare(`INSERT OR IGNORE INTO saved_leads (title, lead_json, saved_at) VALUES (?, ?, ?)`);
      const tx = db.transaction(() => {
        for (const [key, value] of Object.entries(raw)) {
          if (!value || typeof value !== 'object') continue;
          if (key.startsWith('search:')) {
            const f = value.filters || {};
            const results = Array.isArray(value.results) ? value.results : [];
            const params = { keyword: value.keyword, city: value.city, state: value.state, ratingMin: f.ratingMin, ratingMax: f.ratingMax, maxReviews: f.maxReviews, targetSegment: f.targetSegment, outreachPriority: value.outreachPriority, maxResults: results.length || null };
            insertSearch.run(
              hashSearchParams(params),
              value.keyword || '', value.city || '', value.state || '',
              f.ratingMin ?? null, f.ratingMax ?? null, f.maxReviews ?? null,
              results.length || null, f.targetSegment ?? null, value.outreachPriority ?? null,
              results.length,
              results.filter(r => r && r.email).length,
              results.filter(r => r && r.phone).length,
              results.filter(r => r && r.instagram).length,
              0, JSON.stringify(results),
              value.date || null, value.date || null
            );
            importedSearches++;
          } else if (key.startsWith('lead:')) {
            if (!value.title) continue;
            insertLead.run(value.title, JSON.stringify(value), value.savedAt || null);
            importedLeads++;
          }
        }
      });
      tx();
      fs.writeFileSync(markerPath, new Date().toISOString());
      return { migrated: importedSearches, leads: importedLeads, dbPath };
    },
  };
}

// ============================================================================
// In-memory backend (fallback)
// ============================================================================
//
// Implements the SAME public surface as the SQLite backend. Data lives in
// JS Maps + Arrays for the lifetime of the process. The shim only needs to
// answer the specific queries this app makes — not arbitrary SQL.

function createMemoryBackend() {
  const state = {
    searches: [],                    // array of row objects
    leadsByTitle: new Map(),         // title → lead row
    leadsById: new Map(),            // id → lead row
    tiers: new Map(),                // root_name → tier row
    seqSearch: 0,
    seqLead: 0,
  };
  const nowIso = () => new Date().toISOString();
  const ageDaysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86_400_000;
  const ymOf = (iso) => iso.slice(0, 7);                  // 'YYYY-MM'
  const currentYm = () => new Date().toISOString().slice(0, 7);
  const lc = (s) => String(s || '').toLowerCase();

  return {
    recordSearch(row) {
      const id = ++state.seqSearch;
      const created_at = nowIso();
      state.searches.push({
        id,
        search_params_hash:    row.hash,
        keyword:               row.keyword,
        city:                  row.city,
        country:               row.country,
        rating_min:            row.rating_min ?? null,
        rating_max:            row.rating_max ?? null,
        max_reviews:           row.max_reviews ?? null,
        results_limit:         row.results_limit ?? null,
        segment_target:        row.segment_target ?? null,
        outreach_priority:     row.outreach_priority ?? null,
        total_leads:           row.total_leads ?? 0,
        email_count:           row.email_count ?? 0,
        phone_count:           row.phone_count ?? 0,
        instagram_count:       row.instagram_count ?? 0,
        serpapi_credits_used:  row.serpapi_credits_used ?? 0,
        results_json:          row.results_json,
        created_at,
        last_accessed:         created_at,
      });
      return id;
    },

    findCachedSearch(hash) {
      // Most recent matching row within the cache window
      const matches = state.searches
        .filter(r => r.search_params_hash === hash)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (matches.length === 0) return null;
      const row = matches[0];
      const ageDays = ageDaysSince(row.created_at);
      if ((ageDays * 86_400_000) > CACHE_WINDOW_MS) return null;
      return { ...row, age_days: ageDays };
    },

    touchAccess(id) {
      const r = state.searches.find(x => x.id === id);
      if (r) r.last_accessed = nowIso();
    },

    getSearchById(id) {
      return state.searches.find(r => r.id === id) || null;
    },

    deleteSearchById(id) {
      const before = state.searches.length;
      state.searches = state.searches.filter(r => r.id !== id);
      return { changes: before - state.searches.length };
    },

    invalidateHash(hash) {
      const before = state.searches.length;
      state.searches = state.searches.filter(r => r.search_params_hash !== hash);
      return { changes: before - state.searches.length };
    },

    listSearches({ from, to, city, keyword, sort, dir, limit = 500 } = {}) {
      let rows = state.searches.slice();
      if (from)    rows = rows.filter(r => r.created_at >= from);
      if (to)      rows = rows.filter(r => r.created_at <= to);
      if (city) {
        const needle = lc(city);
        rows = rows.filter(r => lc(r.city).includes(needle) || lc(r.country).includes(needle));
      }
      if (keyword) {
        const needle = lc(keyword);
        rows = rows.filter(r => lc(r.keyword).includes(needle));
      }
      const sortCol = ({ created: 'created_at', leads: 'total_leads', credits: 'serpapi_credits_used' }[sort]) || 'created_at';
      const sign = dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        if (typeof av === 'string') return sign * av.localeCompare(bv);
        return sign * ((av ?? 0) - (bv ?? 0));
      });
      return rows.slice(0, limit);
    },

    getStats() {
      const totalSearches = state.searches.length;
      const totalLeads = state.searches.reduce((s, r) => s + (r.total_leads || 0), 0);
      const ym = currentYm();
      const thisMonth = state.searches.filter(r => ymOf(r.created_at) === ym);
      const monthlyCredits = thisMonth.reduce((s, r) => s + (r.serpapi_credits_used || 0), 0);
      // Top city this month — group by lowercased city, keep original casing
      const cityCounts = new Map();
      for (const r of thisMonth) {
        const k = lc(r.city);
        if (!cityCounts.has(k)) cityCounts.set(k, { city: r.city, n: 0 });
        cityCounts.get(k).n++;
      }
      let top = null;
      for (const v of cityCounts.values()) if (!top || v.n > top.n) top = v;
      return {
        totalSearches, totalLeads, monthlyCredits,
        topCity: top ? top.city : null,
        topCityCount: top ? top.n : 0,
      };
    },

    getRecentSearches(n = 5) {
      return state.searches
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, n)
        .map(r => ({ key: String(r.id), id: r.id, keyword: r.keyword, city: r.city, state: r.country, resultCount: r.total_leads, date: r.created_at }));
    },

    getSidebarCounts() {
      return { historyCount: state.searches.length, savedLeadsCount: state.leadsByTitle.size };
    },

    listSavedLeads() {
      return [...state.leadsById.values()]
        .sort((a, b) => b.saved_at.localeCompare(a.saved_at))
        .map(r => ({ key: String(r.id), ...JSON.parse(r.lead_json), savedAt: r.saved_at }));
    },

    listSavedLeadKeys() {
      return [...state.leadsById.values()].map(r => ({ key: String(r.id), title: r.title }));
    },

    saveLead(lead) {
      if (!lead || !lead.title) throw new Error('lead.title required');
      const existing = state.leadsByTitle.get(lead.title);
      if (existing) return { status: 'exists', key: String(existing.id) };
      const id = ++state.seqLead;
      const row = { id, title: lead.title, lead_json: JSON.stringify(lead), saved_at: nowIso() };
      state.leadsByTitle.set(lead.title, row);
      state.leadsById.set(id, row);
      return { status: 'saved', key: String(id) };
    },

    deleteSavedLead(key) {
      const id = parseInt(key, 10);
      const row = state.leadsById.get(id);
      if (!row) return { changes: 0 };
      state.leadsByTitle.delete(row.title);
      state.leadsById.delete(id);
      return { changes: 1 };
    },

    getChainTier(rootName) {
      return state.tiers.get(lc(rootName).trim()) || null;
    },

    setChainTier(rootName, row) {
      const key = lc(rootName).trim();
      state.tiers.set(key, {
        root_name: key,
        tier: row.tier,
        knowledge_graph_present: row.knowledge_graph_present ? 1 : 0,
        total_results: row.total_results || 0,
        classified_at: nowIso(),
      });
      return { changes: 1 };
    },

    // No-op on the memory backend — there's no marker file to write since data
    // doesn't persist anyway, and a fresh container wouldn't even see the old JSON.
    // If/when better-sqlite3 comes back online the SQLite backend handles real migration.
    migrateFromJSON(jsonPath) {
      // Best-effort import: if a local-db.json exists, hydrate the in-memory store from it.
      if (!fs.existsSync(jsonPath)) return { migrated: 0 };
      let raw;
      try { raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return { migrated: 0 }; }
      const { hashSearchParams } = require('./hash');
      let migrated = 0, leads = 0;
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        if (key.startsWith('search:')) {
          const f = value.filters || {};
          const results = Array.isArray(value.results) ? value.results : [];
          const params = { keyword: value.keyword, city: value.city, state: value.state, ratingMin: f.ratingMin, ratingMax: f.ratingMax, maxReviews: f.maxReviews, targetSegment: f.targetSegment, outreachPriority: value.outreachPriority, maxResults: results.length || null };
          const id = ++state.seqSearch;
          state.searches.push({
            id,
            search_params_hash: hashSearchParams(params),
            keyword: value.keyword || '', city: value.city || '', country: value.state || '',
            rating_min: f.ratingMin ?? null, rating_max: f.ratingMax ?? null, max_reviews: f.maxReviews ?? null,
            results_limit: results.length || null, segment_target: f.targetSegment ?? null,
            outreach_priority: value.outreachPriority ?? null,
            total_leads: results.length,
            email_count: results.filter(r => r && r.email).length,
            phone_count: results.filter(r => r && r.phone).length,
            instagram_count: results.filter(r => r && r.instagram).length,
            serpapi_credits_used: 0,
            results_json: JSON.stringify(results),
            created_at: value.date || nowIso(),
            last_accessed: value.date || nowIso(),
          });
          migrated++;
        } else if (key.startsWith('lead:') && value.title) {
          if (state.leadsByTitle.has(value.title)) continue;
          const id = ++state.seqLead;
          const row = { id, title: value.title, lead_json: JSON.stringify(value), saved_at: value.savedAt || nowIso() };
          state.leadsByTitle.set(value.title, row);
          state.leadsById.set(id, row);
          leads++;
        }
      }
      return { migrated, leads, dbPath: '(in-memory)' };
    },
  };
}

// ============================================================================
// Public exports — same surface regardless of backend
// ============================================================================

module.exports = {
  DB_PATH,
  CACHE_WINDOW_MS,
  backendName: () => backendName,
  recordSearch:     (...a) => backend.recordSearch(...a),
  findCachedSearch: (...a) => backend.findCachedSearch(...a),
  touchAccess:      (...a) => backend.touchAccess(...a),
  getSearchById:    (...a) => backend.getSearchById(...a),
  deleteSearchById: (...a) => backend.deleteSearchById(...a),
  invalidateHash:   (...a) => backend.invalidateHash(...a),
  listSearches:     (...a) => backend.listSearches(...a),
  getStats:         (...a) => backend.getStats(...a),
  getRecentSearches:(...a) => backend.getRecentSearches(...a),
  getSidebarCounts: (...a) => backend.getSidebarCounts(...a),
  listSavedLeads:   (...a) => backend.listSavedLeads(...a),
  listSavedLeadKeys:(...a) => backend.listSavedLeadKeys(...a),
  saveLead:         (...a) => backend.saveLead(...a),
  deleteSavedLead:  (...a) => backend.deleteSavedLead(...a),
  getChainTier:     (...a) => backend.getChainTier(...a),
  setChainTier:     (...a) => backend.setChainTier(...a),
  migrateFromJSON:  (...a) => backend.migrateFromJSON(...a),
};
