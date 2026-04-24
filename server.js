require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Enrichment module — layered waterfall (Layer 2 scrape → Layer 3 pattern guess → Layer 4/5 stubs).
const { enrichLead } = require('./enrichment/orchestrator');
const { isAggregatorDomain, JUNK_IG_HANDLES, handleMatchesBusiness, normForMatch } = require('./enrichment/utils/domain-utils');

const app = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
// Phase D placeholders — reserved for paid APIs.
// process.env.PROSPEO_API_KEY, process.env.MILLIONVERIFIER_API_KEY
// Layer 3 SMTP verification uses this "from" address in the handshake.
// Not a real inbox — override via env if you want the outbound banner to match your own domain.
// process.env.LEADHUNTER_VERIFY_FROM

// --- Local file-backed database ---
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'local-db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = {};
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch { db = {}; }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function dbSet(key, value) { db[key] = value; saveDB(); }
function dbGet(key) { return db[key] || null; }
function dbDelete(key) { delete db[key]; saveDB(); }
function dbList(prefix) {
  return Object.keys(db)
    .filter(k => k.startsWith(prefix))
    .map(k => ({ key: k, value: db[k] }));
}
loadDB();

// --- Express setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setTimeout(300000);
  next();
});

// --- SerpAPI helper ---
async function serpApiSearch(query, start) {
  const params = new URLSearchParams({
    engine: 'google_maps',
    q: query,
    type: 'search',
    api_key: SERPAPI_KEY,
    start: start.toString(),
  });

  const url = `https://serpapi.com/search.json?${params}`;
  console.log(`[serpapi] Fetching start=${start}`);

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SerpAPI error ${response.status}: ${text}`);
  }
  return response.json();
}

// --- SerpAPI Google web search (for Instagram fallback) ---
async function serpApiGoogleSearch(query, num = 10) {
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: SERPAPI_KEY,
    num: String(num),
  });
  const url = `https://serpapi.com/search.json?${params}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`SerpAPI google ${response.status}`);
    return response.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// --- Google fallback Instagram discovery ---
// Used when primary enrichment couldn't find an IG handle AND the business's listed website
// was rejected (aggregator) or missing. Searches Google for "business" "city" instagram and validates candidates.
async function googleFallbackInstagram(businessName, city) {
  if (!businessName || !city) return null;
  const query = `"${businessName}" "${city}" instagram`;
  console.log(`[ig-fallback] Query: ${query}`);
  let data;
  try {
    data = await serpApiGoogleSearch(query, 10);
  } catch (e) {
    console.log(`[ig-fallback] SerpAPI error: ${e.message}`);
    return null;
  }
  // Collect IG URLs from organic_results + knowledge_graph + answer_box
  const urls = [];
  const pushFrom = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      const m = v.match(/https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[a-zA-Z0-9_.][a-zA-Z0-9_./?=&-]*/gi);
      if (m) m.forEach(u => urls.push(u));
    } else if (Array.isArray(v)) {
      v.forEach(pushFrom);
    } else if (typeof v === 'object') {
      Object.values(v).forEach(pushFrom);
    }
  };
  pushFrom(data.organic_results);
  pushFrom(data.knowledge_graph);
  pushFrom(data.answer_box);

  // Validate each: profile URL only, not junk, fuzzy-match business name
  const rejectedPathRe = /\/(p|reel|reels|stories|tv|explore|accounts|direct|about|developer|legal|terms|privacy)\b/i;
  const handleRe = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i;
  const candidates = [];
  for (const u of urls) {
    if (rejectedPathRe.test(u)) continue;
    const m = u.match(handleRe);
    if (!m) continue;
    const h = m[1].toLowerCase();
    if (JUNK_IG_HANDLES.has(h)) continue;
    if (h.length < 3) continue;
    if (!handleMatchesBusiness(h, businessName)) continue;
    // Score: prefer exact substring match, longer handles, and appearing earlier (earlier in urls[] = earlier in Google)
    let score = 0;
    const nName = normForMatch(businessName);
    const nH = normForMatch(h);
    if (nH === nName) score += 100;
    if (nH.startsWith(nName) || nName.startsWith(nH)) score += 30;
    score += Math.min(h.length, 25);
    score -= candidates.length; // rank-based prefer earlier results
    if (!candidates.find(c => c.handle === h)) candidates.push({ handle: h, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  console.log(`[ig-fallback] Picked "${candidates[0].handle}" from ${candidates.length} valid candidate(s)`);
  return candidates[0].handle;
}

// Aggregator blocklist + fuzzy name matching + junk IG handles now live in ./enrichment/utils/domain-utils.js
// (imported above). Keep this file focused on routing and the SerpAPI Maps flow.


// --- ROUTES ---

// Helper: pull the last N searches for the recent-searches sidebar
function getRecentSearches(n = 5) {
  return dbList('search:')
    .map(s => ({ key: s.key, ...s.value }))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, n)
    .map(s => ({ key: s.key, keyword: s.keyword, city: s.city, state: s.state, resultCount: s.resultCount, date: s.date }));
}

// Helper: sidebar badge counts (shown next to History + Saved leads nav items)
function getSidebarCounts() {
  return {
    historyCount: dbList('search:').length,
    savedLeadsCount: dbList('lead:').length
  };
}

// Search page (GET — empty form, optionally pre-populated from URL query for deep linking)
app.get('/', (req, res) => {
  // If URL has search params, render them into the form without running a search
  const hasParams = Object.keys(req.query).length > 0;
  const query = hasParams ? req.query : null;
  res.render('search', { results: null, totalScraped: 0, query, error: null, recentSearches: getRecentSearches(), ...getSidebarCounts() });
});

// GET /search — allows URL-shareable / refreshable searches by encoding params in the query string
app.get('/search', async (req, res) => handleSearch(req.query, res));

// POST /search — form submit
app.post('/search', async (req, res) => handleSearch(req.body, res));

async function handleSearch(src, res) {
  const { keyword, excludeKeywords, city, state, maxResults, ratingMin, ratingMax, maxReviews, enrichContacts, skipEnrichment, outreachPriority, targetSegment, useIgFallback } = src;
  // Enrichment is always-on by default; user can opt out via "Skip enrichment" advanced toggle.
  const enrich = skipEnrichment === 'on' ? false : true;
  // IG Google fallback is opt-in on by default (undefined → true); user disables via `useIgFallback === 'off'`.
  const igFallbackEnabled = useIgFallback !== 'off';

  if (!keyword || !city || !state) {
    return res.render('search', {
      results: null, totalScraped: 0,
      query: null,
      error: 'Please fill in keyword, city, and country/state.',
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });
  }
  if (!SERPAPI_KEY) {
    return res.render('search', {
      results: null, totalScraped: 0,
      query: null,
      error: 'SERPAPI_KEY not set. Add it to your .env or Secrets.',
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });
  }

  const limit = Math.min(parseInt(maxResults) || 20, 500);

  // Parse multi-keyword (comma-separated) — each becomes its own search, results merged & deduped
  const keywords = String(keyword).split(',').map(k => k.trim()).filter(Boolean);
  const excludeTerms = String(excludeKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  const perKeywordLimit = Math.max(20, Math.ceil(limit / keywords.length));

  console.log(`[search] Keywords: ${JSON.stringify(keywords)} in ${city}, ${state} · limit ${limit} (≈${perKeywordLimit}/keyword)`);
  console.log(`[search] Exclude: ${JSON.stringify(excludeTerms)} · rating ${ratingMin}–${ratingMax} · maxReviews ${maxReviews}`);

  try {
    // Run one pass per keyword, concat all raw results
    let allResults = [];
    const perPage = 20;
    for (const kw of keywords) {
      const searchString = `${kw} in ${city}, ${state}`;
      const maxPages = Math.ceil(perKeywordLimit / perPage);
      let start = 0;
      let kwCount = 0;
      for (let page = 0; page < maxPages; page++) {
        const data = await serpApiSearch(searchString, start);
        const places = data.local_results || [];
        if (places.length === 0) break;
        allResults = allResults.concat(places);
        kwCount += places.length;
        console.log(`[search] "${kw}" page ${page + 1}: +${places.length} (total ${allResults.length})`);
        if (kwCount >= perKeywordLimit) break;
        if (!data.serpapi_pagination || !data.serpapi_pagination.next) break;
        start += perPage;
      }
    }
    console.log(`[search] Raw combined results: ${allResults.length}`);

    // Dedupe by place_id (fallback to normalized title+address)
    const seen = new Set();
    allResults = allResults.filter(item => {
      const key = item.place_id || ((item.title || '') + '|' + (item.address || '')).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[search] After dedupe: ${allResults.length}`);

    // Trim to exact limit after dedupe
    allResults = allResults.slice(0, limit);

    // Apply exclude-keywords filter on title or type
    if (excludeTerms.length > 0) {
      const before = allResults.length;
      allResults = allResults.filter(item => {
        const hay = `${item.title || ''} ${item.type || ''}`.toLowerCase();
        return !excludeTerms.some(term => hay.includes(term));
      });
      console.log(`[search] After exclude filter: ${allResults.length} (removed ${before - allResults.length})`);
    }

    // Map SerpAPI results to our clean format
    const mappedResults = allResults.map(item => {
      let ig = '';
      if (item.website) {
        const igMatch = item.website.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
        if (igMatch) ig = igMatch[1].toLowerCase();
      }
      // SerpAPI exposes optional fields; capture them if present
      const priceTier = item.price || item.price_level || '';
      let hours = '';
      if (item.hours) {
        if (typeof item.hours === 'string') hours = item.hours;
        else if (Array.isArray(item.hours)) hours = item.hours.map(h => typeof h === 'string' ? h : JSON.stringify(h)).slice(0, 3).join(' · ');
        else if (item.hours.status) hours = item.hours.status;
      }
      if (!hours && item.open_state) hours = item.open_state;
      return {
        title: item.title || '',
        phone: item.phone || '',
        website: item.website || '',
        email: '',
        emailRole: '',
        emailPriority: 0,
        emails: [],
        email_source: null,
        email_confidence: null,
        instagram: ig,
        // Source of the Instagram handle: 'maps' (extracted from Google Maps "website" field that was an IG URL),
        // 'website' (scraped from business's own site), 'google_fallback' (resolved via Google search), or null.
        instagramSource: ig ? 'maps' : null,
        booking: '',
        hours: hours,
        priceTier: priceTier,
        placeId: item.place_id || '',
        isAggregator: isAggregatorDomain(item.website),
        category: item.type || '',
        address: item.address || '',
        city: city,
        state: state,
        rating: item.rating != null ? item.rating : null,
        reviewCount: item.reviews != null ? item.reviews : 0,
        url: item.place_id ? `https://www.google.com/maps/place/?q=place_id:${item.place_id}` : (item.gps_coordinates ? `https://www.google.com/maps?q=${item.gps_coordinates.latitude},${item.gps_coordinates.longitude}` : ''),
        imageUrl: item.thumbnail || ''
      };
    }).filter(r => r.title);

    console.log(`[search] Mapped results: ${mappedResults.length}`);

    // Apply filters (rating range + max reviews)
    const minVal = (ratingMin !== undefined && ratingMin !== '') ? parseFloat(ratingMin) : null;
    const maxVal = (ratingMax !== undefined && ratingMax !== '') ? parseFloat(ratingMax) : null;
    const maxReviewsVal = (maxReviews !== undefined && maxReviews !== '') ? parseInt(maxReviews, 10) : null;

    console.log(`[search] Parsed filters — minVal: ${minVal}, maxVal: ${maxVal}, maxReviewsVal: ${maxReviewsVal}`);

    const filteredResults = mappedResults.filter(r => {
      if (minVal !== null && (r.rating === null || r.rating < minVal)) return false;
      if (maxVal !== null && (r.rating === null || r.rating > maxVal)) return false;
      if (maxReviewsVal !== null && r.reviewCount >= maxReviewsVal) return false;
      return true;
    });

    console.log(`[search] After filtering: ${filteredResults.length}`);

    // Enrich contacts by default (disable only via skipEnrichment)
    // Layer 3 (pattern-guess + SMTP verify) is opt-in via `useLayer3` query param — default ON.
    const useLayer3 = String(src.useLayer3 || 'on') !== 'off';
    if (enrich) {
      console.log(`[enrich] Enriching ${filteredResults.length} leads (Layer 3 ${useLayer3 ? 'ON' : 'OFF'})...`);
      const BATCH_SIZE = 5;
      for (let i = 0; i < filteredResults.length; i += BATCH_SIZE) {
        const batch = filteredResults.slice(i, i + BATCH_SIZE);
        const enrichments = await Promise.all(
          batch.map(r => enrichLead(r.website, r.title, { useLayer3 }))
        );
        enrichments.forEach((enriched, j) => {
          const idx = i + j;
          if (enriched.isAggregator) filteredResults[idx].isAggregator = true;
          if (enriched.email) filteredResults[idx].email = enriched.email;
          if (enriched.emailRole) filteredResults[idx].emailRole = enriched.emailRole;
          if (enriched.emailPriority != null) filteredResults[idx].emailPriority = enriched.emailPriority;
          if (enriched.emails && enriched.emails.length) filteredResults[idx].emails = enriched.emails;
          if (enriched.email_source) filteredResults[idx].email_source = enriched.email_source;
          if (enriched.email_confidence) filteredResults[idx].email_confidence = enriched.email_confidence;
          if (enriched.phone && !filteredResults[idx].phone) filteredResults[idx].phone = enriched.phone;
          if (enriched.instagram && !filteredResults[idx].instagram) {
            filteredResults[idx].instagram = enriched.instagram;
            filteredResults[idx].instagramSource = 'website';
          }
          if (enriched.booking) filteredResults[idx].booking = enriched.booking;
        });
        console.log(`[enrich] Batch ${Math.floor(i / BATCH_SIZE) + 1} done (${Math.min(i + BATCH_SIZE, filteredResults.length)}/${filteredResults.length})`);
      }
      const emailCount = filteredResults.filter(r => r.email).length;
      const guessCount = filteredResults.filter(r => r.email_source === 'guessed').length;
      const siteCount = filteredResults.filter(r => r.email_source === 'website').length;
      console.log(`[enrich] Emails: ${emailCount}/${filteredResults.length} (site: ${siteCount}, guessed: ${guessCount})`);
    }

    // --- Instagram Google-search fallback phase ---
    // Targets leads that finished primary enrichment WITHOUT an IG handle AND either have an
    // aggregator-rejected website or no website at all. Other leads (with a normal website that
    // just didn't mention IG) are assumed to genuinely have no IG — we don't burn extra credits on them.
    if (enrich && igFallbackEnabled) {
      const candidates = filteredResults.filter(r => !r.instagram && (r.isAggregator || !r.website));
      // Cap: top 30 by rating (desc), so extra credit burn is bounded even on large searches
      const FALLBACK_CAP = 30;
      let fallbackQueue = candidates;
      if (candidates.length > FALLBACK_CAP) {
        fallbackQueue = candidates.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, FALLBACK_CAP);
        console.log(`[ig-fallback] ${candidates.length} leads need fallback — capping at top ${FALLBACK_CAP} by rating`);
      }
      if (fallbackQueue.length > 0) {
        console.log(`[ig-fallback] Running Google fallback for ${fallbackQueue.length} leads (extra ${fallbackQueue.length} SerpAPI credits)`);
        const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
        const CONCURRENCY = 2;
        let found = 0;
        for (let i = 0; i < fallbackQueue.length; i += CONCURRENCY) {
          const batch = fallbackQueue.slice(i, i + CONCURRENCY);
          const results = await Promise.all(batch.map(async lead => {
            // Server-side cache by placeId
            const cacheKey = lead.placeId ? `igcache:${lead.placeId}` : null;
            if (cacheKey) {
              const cached = dbGet(cacheKey);
              if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL_MS) {
                return { lead, handle: cached.handle || null, fromCache: true };
              }
            }
            let handle = null;
            try {
              handle = await googleFallbackInstagram(lead.title, lead.city);
            } catch (e) {
              console.log(`[ig-fallback] Failed for "${lead.title}": ${e.message}`);
            }
            if (cacheKey) dbSet(cacheKey, { handle: handle || '', ts: Date.now() });
            return { lead, handle, fromCache: false };
          }));
          results.forEach(({ lead, handle }) => {
            if (handle) {
              lead.instagram = handle;
              lead.instagramSource = 'google_fallback';
              found++;
            }
          });
        }
        console.log(`[ig-fallback] Resolved ${found}/${fallbackQueue.length} via Google fallback`);
      }
    }

    // Tag segments and contact method
    filteredResults.forEach(r => {
      // Segment tagging
      if (r.rating !== null && r.rating < 4.1 && r.reviewCount >= 80) {
        r.segment = 'Low Rating';
        r.segmentCode = 'C';
      } else if (r.rating !== null && r.rating >= 4.1 && r.rating <= 4.7 && r.reviewCount <= 300) {
        r.segment = 'Good Rating, Low Volume';
        r.segmentCode = 'B';
      } else {
        r.segment = 'Other';
        r.segmentCode = '-';
      }

      // Contact method — priority-aware
      // Collect channels, then pick the first available one based on user-selected priority
      const priority = outreachPriority || 'phone-first';
      let channels;
      if (priority === 'dm-first') {
        channels = [
          { val: r.instagram, tag: 'DM' },
          { val: r.phone, tag: 'Call' },
          { val: r.email, tag: 'Email' },
        ];
      } else if (priority === 'email-first') {
        channels = [
          { val: r.email, tag: 'Email' },
          { val: r.phone, tag: 'Call' },
          { val: r.instagram, tag: 'DM' },
        ];
      } else {
        // phone-first (default)
        channels = [
          { val: r.phone, tag: 'Call' },
          { val: r.email, tag: 'Email' },
          { val: r.instagram, tag: 'DM' },
        ];
      }
      const picked = channels.find(c => c.val);
      r.outreach = picked ? picked.tag : 'None';

      // Enrichment quality score (0–100) — blends role priority AND source confidence
      //   Base by role priority: named 100 → +25, owner/mgr/mkt 70+ → +20, general 50 → +15,
      //                          transactional 40 → +10, support/low-value ≤20 → +5
      //   Confidence modifier: website-sourced OR guessed+high → full value
      //                        guessed+medium (catch-all) → 60% of value
      //                        low/unverifiable → 20% of value
      //   Other channels: phone +25, instagram +25, website +15, ownerName +10
      let emailPts = 0;
      const ep = r.emailPriority || 0;
      if (ep >= 100) emailPts = 25;
      else if (ep >= 70) emailPts = 20;
      else if (ep >= 50) emailPts = 15;
      else if (ep >= 40) emailPts = 10;
      else if (ep >= 10) emailPts = 5;
      else if (r.email) emailPts = 15;
      const conf = r.email_confidence || (r.email_source === 'website' ? 'high' : null);
      if (r.email) {
        if (conf === 'medium') emailPts = Math.round(emailPts * 0.6);
        else if (conf === 'low') emailPts = Math.round(emailPts * 0.2);
      }
      let score = emailPts;
      if (r.phone) score += 25;
      if (r.instagram) score += 25;
      if (r.website) score += 15;
      if (r.ownerName) score += 10;
      r.qualityScore = Math.min(score, 100);
    });

    // Target segment filter (server-side; applied AFTER segment tagging)
    let segmentFiltered = filteredResults;
    const segFilter = (targetSegment || 'all').toUpperCase();
    if (segFilter === 'B') segmentFiltered = filteredResults.filter(r => r.segmentCode === 'B');
    else if (segFilter === 'C') segmentFiltered = filteredResults.filter(r => r.segmentCode === 'C');
    else if (segFilter === 'BC') segmentFiltered = filteredResults.filter(r => r.segmentCode === 'B' || r.segmentCode === 'C');
    console.log(`[search] After target-segment filter (${segFilter}): ${segmentFiltered.length}`);

    // Save to search history
    const timestamp = Date.now();
    const searchKey = `search:${timestamp}`;
    const searchLabel = `${keywords.join(', ')} in ${city}, ${state}`;
    dbSet(searchKey, {
      query: searchLabel,
      keyword, city, state,
      resultCount: segmentFiltered.length,
      totalScraped: mappedResults.length,
      filters: { ratingMin: minVal, ratingMax: maxVal, maxReviews: maxReviewsVal, targetSegment: segFilter.toLowerCase() },
      outreachPriority: outreachPriority || 'phone-first',
      results: segmentFiltered,
      date: new Date().toISOString()
    });

    res.render('search', {
      results: segmentFiltered,
      totalScraped: mappedResults.length,
      query: { keyword, excludeKeywords, city, state, maxResults: limit, ratingMin, ratingMax, maxReviews, skipEnrichment, useIgFallback, outreachPriority, targetSegment, searchString: keywords.join(', ') + ` in ${city}, ${state}` },
      error: null,
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });

  } catch (err) {
    console.error('[search] Error:', err.message);
    let errorMsg = 'Search failed: ' + (err.message || 'Unknown error');
    if (err.message.includes('401')) errorMsg = 'Invalid SerpAPI key. Check your SERPAPI_KEY.';
    if (err.message.includes('429')) errorMsg = 'SerpAPI rate limit reached. Try again in a moment.';
    res.render('search', { results: null, totalScraped: 0, query: null, error: errorMsg, recentSearches: getRecentSearches(), ...getSidebarCounts() });
  }
}

// --- History ---
app.get('/history', (req, res) => {
  const searches = dbList('search:')
    .map(s => ({ key: s.key, ...s.value }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.render('history', { searches, ...getSidebarCounts() });
});

app.get('/history/:key', (req, res) => {
  const data = dbGet(req.params.key);
  if (!data) return res.redirect('/history');
  res.render('search', {
    results: data.results,
    totalScraped: data.totalScraped || data.results.length,
    query: { keyword: data.keyword, city: data.city, state: data.state, outreachPriority: data.outreachPriority || 'phone-first', searchString: data.query },
    error: null,
    recentSearches: getRecentSearches(), ...getSidebarCounts()
  });
});

app.post('/history/delete/:key', (req, res) => {
  dbDelete(req.params.key);
  res.redirect('/history');
});

// --- Leads ---
app.get('/leads', (req, res) => {
  const leads = dbList('lead:')
    .map(l => ({ key: l.key, ...l.value }))
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  res.render('leads', { leads, ...getSidebarCounts() });
});

app.get('/leads/saved', (req, res) => {
  const leads = dbList('lead:').map(l => ({ key: l.key, title: l.value.title }));
  res.json(leads);
});

app.post('/leads/save', (req, res) => {
  const lead = req.body;
  if (!lead || !lead.title) return res.status(400).json({ error: 'Lead data required.' });

  const existing = dbList('lead:').find(l => l.value.title === lead.title);
  if (existing) return res.json({ status: 'exists', key: existing.key });

  const key = `lead:${Date.now()}`;
  dbSet(key, { ...lead, savedAt: new Date().toISOString() });
  res.json({ status: 'saved', key });
});

app.post('/leads/delete/:key', (req, res) => {
  dbDelete(req.params.key);
  if (req.headers['content-type']?.includes('json')) {
    return res.json({ status: 'deleted' });
  }
  res.redirect('/leads');
});

// --- Export CSV ---
app.post('/export', (req, res) => {
  const { results } = req.body;
  if (!results || !results.length) return res.status(400).json({ error: 'No results to export.' });

  const headers = ['Name', 'Phone', 'Email', 'Instagram', 'Website', 'Category', 'Address', 'Rating', 'Reviews', 'Google Maps URL'];
  const rows = results.map(r => [
    r.title, r.phone, r.email, r.instagram || '', r.website, r.category, r.address, r.rating, r.reviewCount, r.url
  ].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`LeadHunter running on http://localhost:${PORT}`);
});
