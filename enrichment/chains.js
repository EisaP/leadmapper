// Chain detection + tier classification.
//
// Three independent signals decide whether a lead is a chain candidate:
//   A. Repeated contact data within the same search (3+ leads sharing email,
//      phone, IG handle, or website root domain).
//   B. Repeated business-name root within the same search (3+ leads whose
//      first 1–3 words match, e.g. "Starbucks Spinningfields" / "Starbucks
//      Northern Quarter" / "Starbucks Trafford").
//   C. Substring match against /data/known-chains.json (Starbucks, Costa, …).
//
// If ANY signal fires, lead.is_chain_candidate = true and lead.chain_signals_fired
// records which ones did.
//
// Tier classification then runs ONE SerpAPI Google search per unique root name
// (cached for 90 days in SQLite) and bins the chain into:
//   global > national > regional > local > independent

const fs = require('fs');
const path = require('path');

// --- Load blocklist once at module load ---
const KNOWN_CHAINS_PATH = path.join(__dirname, '..', 'data', 'known-chains.json');
let KNOWN_CHAINS_FLAT = [];
try {
  const raw = JSON.parse(fs.readFileSync(KNOWN_CHAINS_PATH, 'utf8'));
  KNOWN_CHAINS_FLAT = Object.values(raw).flat().map(s => String(s).toLowerCase().trim()).filter(Boolean);
} catch {
  KNOWN_CHAINS_FLAT = [];
}

// --- Helpers ---

// Tokenize a business name into lowercase Latin/digit words, dropping diacritics
// (so "Caffè Nero" → ["caffe", "nero"]).
function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[-–—·|@()]/g, ' ')                    // explicit separators → space
    .replace(/\s+#?\d+\s*$/g, ' ')                  // trailing "#234" / numbers
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')              // strip remaining punct, keep unicode letters/digits
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Normalize a phone number to digits only (so "+44 161 234 5678" matches "01612345678").
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// Extract root domain from a URL (or '' if not parseable / aggregator-y).
function rootDomain(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

// Lowercase + trim a value for grouping. Empty/whitespace returns null so the
// group never lights up on absence.
function groupKey(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

// --- Signal A: repeated contact data ---
// Group leads by email / normalized phone / IG handle / website root domain.
// Any group of 3+ flags every member.
function signalContact(leads) {
  const groups = { email: new Map(), phone: new Map(), instagram: new Map(), website: new Map() };
  const push = (mp, key, idx) => { if (key) (mp.get(key) || mp.set(key, []).get(key)).push(idx); };

  leads.forEach((lead, idx) => {
    push(groups.email,     groupKey(lead.email),    idx);
    push(groups.phone,     normalizePhone(lead.phone) || null, idx);
    push(groups.instagram, groupKey(lead.instagram), idx);
    push(groups.website,   rootDomain(lead.website), idx);
  });

  const flagged = new Set();
  for (const mp of Object.values(groups)) {
    for (const arr of mp.values()) {
      if (arr.length >= 3) arr.forEach(i => flagged.add(i));
    }
  }
  return flagged;
}

// --- Signal B: repeated name pattern ---
// For each lead, find the SHORTEST 1–3-word prefix that has 3+ DISTINCT
// full-name matches. That prefix becomes the lead's inferred root name.
function signalName(leads) {
  const tokensByIdx = leads.map(l => tokenize(l.title));
  const prefixGroups = new Map(); // prefix → Set of idx

  tokensByIdx.forEach((tokens, idx) => {
    const max = Math.min(3, tokens.length);
    for (let n = 1; n <= max; n++) {
      const prefix = tokens.slice(0, n).join(' ');
      if (!prefix) continue;
      if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, new Set());
      prefixGroups.get(prefix).add(idx);
    }
  });

  const flagged = new Set();
  const rootByIdx = new Array(leads.length).fill(null);

  tokensByIdx.forEach((tokens, idx) => {
    const max = Math.min(3, tokens.length);
    for (let n = 1; n <= max; n++) {
      const prefix = tokens.slice(0, n).join(' ');
      if (!prefix) continue;
      const group = prefixGroups.get(prefix);
      if (!group || group.size < 3) continue;
      // Require 3+ DISTINCT full names — three identical listings of the same place don't count
      const distinct = new Set([...group].map(i => leads[i].title.toLowerCase().trim()));
      if (distinct.size < 3) continue;
      flagged.add(idx);
      rootByIdx[idx] = prefix;
      break; // shortest qualifying prefix wins
    }
  });

  return { flagged, rootByIdx };
}

// --- Signal C: known-chain blocklist ---
// Case-insensitive substring match against any name in known-chains.json.
function signalBlocklist(leads) {
  const flagged = new Set();
  const matchedNameByIdx = new Array(leads.length).fill(null);
  if (!KNOWN_CHAINS_FLAT.length) return { flagged, matchedNameByIdx };
  leads.forEach((lead, idx) => {
    const haystack = String(lead.title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    for (const chain of KNOWN_CHAINS_FLAT) {
      const needle = chain.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      if (haystack.includes(needle)) {
        flagged.add(idx);
        matchedNameByIdx[idx] = chain;
        break;
      }
    }
  });
  return { flagged, matchedNameByIdx };
}

// --- Combined detector ---
// Returns the leads array mutated with:
//   is_chain_candidate, chain_signals_fired, chain_root_name
// Plus a Set of unique root names that need tier classification.
function detectChains(leads) {
  const aFlagged = signalContact(leads);
  const b = signalName(leads);
  const c = signalBlocklist(leads);

  const uniqueRoots = new Set();

  leads.forEach((lead, idx) => {
    const signals = [];
    if (aFlagged.has(idx)) signals.push('contact');
    if (b.flagged.has(idx)) signals.push('name');
    if (c.flagged.has(idx)) signals.push('blocklist');

    lead.chain_signals_fired = signals;
    lead.is_chain_candidate = signals.length > 0;

    // Pick the best root name for classification. Prefer the inferred one (Signal B);
    // fall back to the blocklist match; final fallback = the lead's first 1-2 tokens.
    if (lead.is_chain_candidate) {
      let root = b.rootByIdx[idx] || c.matchedNameByIdx[idx] || null;
      if (!root) {
        const toks = tokenize(lead.title).slice(0, 2);
        root = toks.join(' ');
      }
      lead.chain_root_name = root;
      if (root) uniqueRoots.add(root);
    } else {
      lead.chain_root_name = null;
      lead.chain_tier = 'independent';
    }
  });

  return { leads, uniqueRoots: [...uniqueRoots] };
}

// --- Tier classification via SerpAPI Google search ---
// Pure function over a SerpAPI response: returns one of
//   'global' | 'national' | 'regional' | 'local' | 'independent'
function classifyTierFromSerp(serpData, opts = {}) {
  const { signalNameFired = false } = opts;
  const kg = serpData?.knowledge_graph || null;
  const totalResults = Number(serpData?.search_information?.total_results) || 0;
  const desc = (kg?.description || kg?.snippet || '').toLowerCase();

  if (kg && totalResults > 100_000_000 && /\b(worldwide|global|international)\b/.test(desc)) {
    return 'global';
  }
  if (kg && totalResults > 10_000_000) return 'national';
  if (kg && totalResults >= 1_000_000) return 'regional';
  // Edge case: KG present but tiny result count — bias toward regional rather than local
  if (kg && totalResults < 1_000_000) return 'regional';
  if (signalNameFired) return 'local';
  // Default fallback (uncertain) — safer to mark as small chain than leave unclassified
  return 'local';
}

// --- Async wrapper that uses SerpAPI + a caller-provided cache layer ---
// `serpFn(query)` should call SerpAPI Google search and return the parsed JSON.
// `cache` is { get(rootName), set(rootName, row) } backed by SQLite.
// Returns { tier, fromCache, kgPresent, totalResults, classifiedAt }.
const TIER_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

async function classifyTier(rootName, { serpFn, cache, signalNameFired = false }) {
  const key = String(rootName || '').toLowerCase().trim();
  if (!key) return { tier: 'local', fromCache: false };

  // Cache lookup first
  if (cache?.get) {
    const cached = cache.get(key);
    if (cached && cached.classified_at) {
      const ageMs = Date.now() - new Date(cached.classified_at).getTime();
      if (ageMs < TIER_CACHE_TTL_MS) {
        return { tier: cached.tier, fromCache: true, kgPresent: !!cached.knowledge_graph_present, totalResults: cached.total_results };
      }
    }
  }

  // Fresh classification
  let serp;
  try { serp = await serpFn(key); } catch (e) {
    // Network failure — return a conservative default but DO NOT cache it
    return { tier: signalNameFired ? 'local' : 'local', fromCache: false, error: e.message };
  }
  const tier = classifyTierFromSerp(serp, { signalNameFired });
  const totalResults = Number(serp?.search_information?.total_results) || 0;
  const kgPresent = !!serp?.knowledge_graph;

  if (cache?.set) {
    cache.set(key, { tier, knowledge_graph_present: kgPresent, total_results: totalResults });
  }
  return { tier, fromCache: false, kgPresent, totalResults };
}

module.exports = {
  detectChains,
  classifyTier,
  classifyTierFromSerp,
  // Internal helpers exported for tests
  _internal: { tokenize, normalizePhone, rootDomain, signalContact, signalName, signalBlocklist, KNOWN_CHAINS_FLAT },
};
