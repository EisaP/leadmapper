// Stable hashing for search parameters.
// The hash is the cache key — two searches with semantically identical params
// (after normalising whitespace, case, and order of comma-separated keywords)
// must produce the same hash so cached results can be reused.

const crypto = require('crypto');

// Normalise a single keyword: lowercase + trim
function normKw(s) { return String(s || '').trim().toLowerCase(); }

// Normalise the whole keyword field — order-independent (so "cafes, coffee" matches "coffee, cafes")
function normKeyword(raw) {
  return String(raw || '')
    .split(',')
    .map(normKw)
    .filter(Boolean)
    .sort()
    .join(',');
}

// Convert any "blank-ish" value to null for stable hashing.
function nullable(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return null;
  return s;
}

// Bool helper — turns 'on' / 'off' / undefined / true / false into a stable 0/1.
const onBit = (v, def) => {
  if (v === 'on'  || v === true)  return 1;
  if (v === 'off' || v === false) return 0;
  return def ? 1 : 0;
};

// Compose the canonical object that goes into the hash.
// Includes EVERY input that affects what the search actually fetches — so a
// "names-only" cache is never reused for a "full-enrichment" search and vice versa.
// UI-only flags (column visibility, display filters) stay excluded.
function canonicalParams(p) {
  return {
    keyword:           normKeyword(p.keyword),
    city:              normKw(p.city),
    country:           normKw(p.state || p.country),
    rating_min:        nullable(p.ratingMin),
    rating_max:        nullable(p.ratingMax),
    max_reviews:       nullable(p.maxReviews),
    results_limit:     nullable(p.maxResults),
    segment_target:    nullable(p.targetSegment),
    outreach_priority: nullable(p.outreachPriority) || 'phone-first',
    // Enrichment-depth toggles — different combinations yield different result data
    extract_phones:    onBit(p.extractPhones, true),
    extract_emails:    onBit(p.extractEmails, true),
    extract_instagram: onBit(p.extractInstagram, true),
    use_layer3:        onBit(p.useLayer3, true),
    use_ig_fallback:   onBit(p.useIgFallback, false),
    extract_followers: onBit(p.extractFollowers, false),
  };
}

function hashSearchParams(params) {
  const c = canonicalParams(params);
  // Sort keys for a stable JSON encoding regardless of property insertion order.
  const sorted = Object.keys(c).sort().reduce((acc, k) => { acc[k] = c[k]; return acc; }, {});
  const json = JSON.stringify(sorted);
  return crypto.createHash('sha256').update(json).digest('hex');
}

module.exports = { hashSearchParams, canonicalParams, normKeyword, normKw, nullable };
