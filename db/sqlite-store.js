// SQLite-backed persistent store.
//
// PERSISTENCE WARNING: On Replit Autoscale deployments the filesystem resets
// between container cycles, which means a SQLite file at ./data/leadhunter.sqlite
// will NOT survive restarts. If history wipes again after this commit, swap the
// backend to Replit DB / Replit Postgres — every caller goes through the
// functions exported from this file, so the swap is contained.
//
// Override the default location via env: LEADHUNTER_DB_PATH=/path/to/db.sqlite

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'leadhunter.sqlite');
const DB_PATH = process.env.LEADHUNTER_DB_PATH || DEFAULT_PATH;

// Ensure the directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');     // safer concurrent writes
db.pragma('foreign_keys = ON');

// --- Schema ---
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
  CREATE INDEX IF NOT EXISTS idx_search_hash         ON search_history (search_params_hash);
  CREATE INDEX IF NOT EXISTS idx_search_created      ON search_history (created_at DESC);

  CREATE TABLE IF NOT EXISTS saved_leads (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL UNIQUE,
    lead_json TEXT NOT NULL,
    saved_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_saved_leads_saved_at ON saved_leads (saved_at DESC);

  -- Chain tier classification cache (90-day TTL — chain size doesn't change month-to-month).
  CREATE TABLE IF NOT EXISTS chain_tier_cache (
    root_name              TEXT PRIMARY KEY,
    tier                   TEXT,
    knowledge_graph_present INTEGER,
    total_results          INTEGER,
    classified_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- search_history queries ---

function recordSearch(row) {
  const stmt = db.prepare(`
    INSERT INTO search_history
      (search_params_hash, keyword, city, country,
       rating_min, rating_max, max_reviews, results_limit, segment_target, outreach_priority,
       total_leads, email_count, phone_count, instagram_count, serpapi_credits_used,
       results_json, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const info = stmt.run(
    row.hash, row.keyword, row.city, row.country,
    row.rating_min ?? null, row.rating_max ?? null, row.max_reviews ?? null,
    row.results_limit ?? null, row.segment_target ?? null, row.outreach_priority ?? null,
    row.total_leads ?? 0, row.email_count ?? 0, row.phone_count ?? 0, row.instagram_count ?? 0,
    row.serpapi_credits_used ?? 0,
    row.results_json
  );
  return info.lastInsertRowid;
}

const CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, hardcoded

function findCachedSearch(hash) {
  const row = db.prepare(`
    SELECT *, (julianday('now') - julianday(created_at)) AS age_days
    FROM search_history
    WHERE search_params_hash = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(hash);
  if (!row) return null;
  const ageMs = row.age_days * 86400 * 1000;
  if (ageMs > CACHE_WINDOW_MS) return null;
  return row;
}

function touchAccess(id) {
  db.prepare(`UPDATE search_history SET last_accessed = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

function getSearchById(id) {
  return db.prepare(`SELECT * FROM search_history WHERE id = ?`).get(id);
}

function deleteSearchById(id) {
  return db.prepare(`DELETE FROM search_history WHERE id = ?`).run(id);
}

// Invalidate every cached row for a given param hash — called when the user
// explicitly chooses "Refresh from source".
function invalidateHash(hash) {
  return db.prepare(`DELETE FROM search_history WHERE search_params_hash = ?`).run(hash);
}

// History page: filtered + sorted listing
function listSearches({ from, to, city, keyword, sort, dir, limit = 500 } = {}) {
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
}

// History stats: 4 cards on the history page header
function getStats() {
  const totalSearches = db.prepare(`SELECT COUNT(*) AS n FROM search_history`).get().n || 0;
  const totalLeads    = db.prepare(`SELECT COALESCE(SUM(total_leads), 0) AS n FROM search_history`).get().n || 0;
  // Credits used in the current calendar month
  const monthlyCredits = db.prepare(`
    SELECT COALESCE(SUM(serpapi_credits_used), 0) AS n
    FROM search_history
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get().n || 0;
  // Most-searched city this month (lowercased compare, but original casing returned)
  const topCity = db.prepare(`
    SELECT city, COUNT(*) AS n
    FROM search_history
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    GROUP BY LOWER(city)
    ORDER BY n DESC
    LIMIT 1
  `).get();
  return {
    totalSearches,
    totalLeads,
    monthlyCredits,
    topCity: topCity ? topCity.city : null,
    topCityCount: topCity ? topCity.n : 0,
  };
}

// Most recent N searches — used for the sidebar's "Recent searches" disclosure
function getRecentSearches(n = 5) {
  return db.prepare(`
    SELECT id, keyword, city, country AS state, total_leads AS resultCount, created_at AS date
    FROM search_history
    ORDER BY created_at DESC
    LIMIT ?
  `).all(n).map(r => ({ key: String(r.id), ...r }));
}

function getSidebarCounts() {
  return {
    historyCount: db.prepare(`SELECT COUNT(*) AS n FROM search_history`).get().n || 0,
    savedLeadsCount: db.prepare(`SELECT COUNT(*) AS n FROM saved_leads`).get().n || 0,
  };
}

// --- saved_leads queries ---

function listSavedLeads() {
  const rows = db.prepare(`SELECT id, lead_json, saved_at FROM saved_leads ORDER BY saved_at DESC`).all();
  return rows.map(r => ({ key: String(r.id), ...JSON.parse(r.lead_json), savedAt: r.saved_at }));
}

function listSavedLeadKeys() {
  return db.prepare(`SELECT id, title FROM saved_leads`).all().map(r => ({ key: String(r.id), title: r.title }));
}

function saveLead(lead) {
  if (!lead || !lead.title) throw new Error('lead.title required');
  const existing = db.prepare(`SELECT id FROM saved_leads WHERE title = ?`).get(lead.title);
  if (existing) return { status: 'exists', key: String(existing.id) };
  const info = db.prepare(`INSERT INTO saved_leads (title, lead_json) VALUES (?, ?)`)
                  .run(lead.title, JSON.stringify(lead));
  return { status: 'saved', key: String(info.lastInsertRowid) };
}

function deleteSavedLead(key) {
  return db.prepare(`DELETE FROM saved_leads WHERE id = ?`).run(parseInt(key, 10));
}

// --- Chain tier cache helpers (consumed by enrichment/chains.js) ---
function getChainTier(rootName) {
  return db.prepare(`SELECT root_name, tier, knowledge_graph_present, total_results, classified_at FROM chain_tier_cache WHERE root_name = ?`).get(String(rootName || '').toLowerCase().trim());
}
function setChainTier(rootName, row) {
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
    row.tier,
    row.knowledge_graph_present ? 1 : 0,
    row.total_results || 0
  );
}

// --- One-time migration from legacy data/local-db.json ---
// Brings any pre-SQLite searches + saved leads into the new store.
// Idempotent — runs at most once, leaves a marker file behind.
function migrateFromJSON(jsonPath) {
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
  const insertLead = db.prepare(`
    INSERT OR IGNORE INTO saved_leads (title, lead_json, saved_at) VALUES (?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      if (key.startsWith('search:')) {
        const f = value.filters || {};
        const results = Array.isArray(value.results) ? value.results : [];
        const params = {
          keyword: value.keyword, city: value.city, state: value.state,
          ratingMin: f.ratingMin, ratingMax: f.ratingMax, maxReviews: f.maxReviews,
          targetSegment: f.targetSegment, outreachPriority: value.outreachPriority,
          maxResults: results.length || null,
        };
        insertSearch.run(
          hashSearchParams(params),
          value.keyword || '', value.city || '', value.state || '',
          f.ratingMin ?? null, f.ratingMax ?? null, f.maxReviews ?? null,
          results.length || null, f.targetSegment ?? null, value.outreachPriority ?? null,
          results.length,
          results.filter(r => r && r.email).length,
          results.filter(r => r && r.phone).length,
          results.filter(r => r && r.instagram).length,
          0,
          JSON.stringify(results),
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
  return { migrated: importedSearches, leads: importedLeads, dbPath: DB_PATH };
}

module.exports = {
  DB_PATH,
  recordSearch, findCachedSearch, touchAccess, getSearchById, deleteSearchById, invalidateHash,
  listSearches, getStats, getRecentSearches, getSidebarCounts,
  listSavedLeads, listSavedLeadKeys, saveLead, deleteSavedLead,
  getChainTier, setChainTier,
  migrateFromJSON,
  CACHE_WINDOW_MS,
};
