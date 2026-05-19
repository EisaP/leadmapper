require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Enrichment module — layered waterfall (Layer 2 scrape → Layer 3 pattern guess → Layer 4/5 stubs).
const { enrichLead } = require('./enrichment/orchestrator');
const { isAggregatorDomain, JUNK_IG_HANDLES, handleMatchesBusiness, normForMatch } = require('./enrichment/utils/domain-utils');

// Persistent storage — SQLite for searches + saved leads, JSON for short-lived caches
const store = require('./db/sqlite-store');
const { hashSearchParams } = require('./db/hash');
const { detectChains, classifyTier } = require('./enrichment/chains');

// Apify-based scrapers (Layer 1 Maps + IG enrichment)
const { scrapeMapsViaCompass, fetchCompassRunDataset, estimateCompassCostUsd, APIFY_HARD_CAP_USD, APIFY_SOFT_WARN_USD } = require('./enrichment/layer1-compass-maps');
const { enrichInstagramViaApify } = require('./enrichment/layer-instagram-apify');

const app = express();
const PORT = process.env.PORT || 3000;
// Phase D placeholders — reserved for paid APIs.
// process.env.PROSPEO_API_KEY, process.env.MILLIONVERIFIER_API_KEY
// process.env.LEADHUNTER_VERIFY_FROM   — Layer 3 SMTP HELO/MAIL FROM identity
// process.env.LEADHUNTER_DB_PATH       — override SQLite location (default: ./data/leadhunter.sqlite)

// --- Short-lived caches still live in a JSON file (TTL-bound; safe to lose on restart) ---
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
function dbList(prefix) {
  return Object.keys(db)
    .filter(k => k.startsWith(prefix))
    .map(k => ({ key: k, value: db[k] }));
}
loadDB();

// --- One-time migration: pull old search:/lead: rows out of the JSON DB ---
// store.migrateFromJSON works on whichever backend is active (SQLite or in-memory).
try {
  const out = store.migrateFromJSON(DB_FILE);
  if (out.migrated || out.leads) {
    console.log(`[migrate] Imported ${out.migrated || 0} searches + ${out.leads || 0} saved leads → ${out.dbPath || store.DB_PATH}`);
  }
  // The backend itself logs its own "ready" / "fallback" line at module load — no need to duplicate.
} catch (err) {
  console.error('[migrate] Failed:', err.message);
}

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

// Aggregator blocklist + fuzzy name matching + junk IG handles now live in ./enrichment/utils/domain-utils.js
// (imported above). Keep this file focused on routing and the Apify Compass Maps flow.


// --- ROUTES ---

// Helper: pull the last N searches for the recent-searches sidebar
const getRecentSearches = (n = 5) => store.getRecentSearches(n);

// Helper: sidebar badge counts (shown next to History + Saved leads nav items)
const getSidebarCounts = () => store.getSidebarCounts();

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

  // --- Enrichment toggles ---
  // Each one *gates real work* — it doesn't just hide results. Defaults match the form markup:
  //   phone / email / IG / Layer 3 = ON (free)
  //   IG Google fallback / follower counts = OFF (paid)
  // Reading helper: undefined-on-form-submit = OFF (browser doesn't send unchecked boxes).
  // For inputs the user might never have touched (deep-linked GET), we infer "intended default"
  // from whether ANY enrichment-related field came in: if NONE did, this is a deep-link with
  // no opinions, so apply the safe defaults from the form.
  const anyEnrichmentParam = ['extractPhones', 'extractEmails', 'extractInstagram', 'useLayer3', 'enrichInstagramApify'].some(k => src[k] !== undefined);
  const onByDefault = (val, def) => {
    if (val === 'on') return true;
    if (val === 'off') return false;
    return anyEnrichmentParam ? false : def;
  };
  const extractPhones    = onByDefault(src.extractPhones,    true);
  const extractEmails    = onByDefault(src.extractEmails,    true);
  const extractInstagram = onByDefault(src.extractInstagram, true);
  const useLayer3Enabled = onByDefault(src.useLayer3,        true);
  // Apify Instagram Profile Scraper — replaces the old useIgFallback + extractFollowers toggles.
  // Default ON: validates each IG handle + populates follower count via Apify.
  const enrichInstagramApifyEnabled = onByDefault(src.enrichInstagramApify, true);

  // Master enrich flag — only run the website-scrape pass if at least one of the things it produces is wanted.
  // (Phone is sourced from Google Maps listing, not website scraping, so it doesn't gate Layer 2.)
  const wantsLayer2 = extractEmails || extractInstagram;
  const wantsLayer3 = useLayer3Enabled && extractEmails; // Layer 3 only matters when we want emails
  const enrich = skipEnrichment === 'on' ? false : (wantsLayer2 || wantsLayer3);

  if (!keyword || !city || !state) {
    return res.render('search', {
      results: null, totalScraped: 0,
      query: null,
      error: 'Please fill in keyword, city, and country/state.',
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });
  }
  const limit = Math.min(parseInt(maxResults) || 20, 500);

  // --- Cache flow ---
  // Three modes (controlled by query string):
  //   default       → check cache; if hit, render the prompt banner asking which to do
  //   ?cacheReuse=1 → load cached row, render results immediately + "cached from N days ago" badge
  //   ?forceFresh=1 → skip cache lookup, run fresh Compass search (also used by "Refresh from source")
  const cacheParams = {
    keyword, city, state, ratingMin, ratingMax, maxReviews, maxResults: limit, targetSegment, outreachPriority,
    extractPhones, extractEmails, extractInstagram,
    useLayer3: useLayer3Enabled,
    enrichInstagramApify: enrichInstagramApifyEnabled,
  };
  const paramsHash = hashSearchParams(cacheParams);
  const forceFresh = String(src.forceFresh || '') === '1';
  const cacheReuse = String(src.cacheReuse || '') === '1';

  if (!forceFresh) {
    const cached = store.findCachedSearch(paramsHash);
    if (cached) {
      if (cacheReuse) {
        // User picked "Reuse" — render cached results
        store.touchAccess(cached.id);
        const results = JSON.parse(cached.results_json || '[]');
        return res.render('search', {
          results, totalScraped: results.length,
          query: { keyword, excludeKeywords, city, state, maxResults: limit, ratingMin, ratingMax, maxReviews, skipEnrichment, useLayer3: src.useLayer3 || 'on', outreachPriority, targetSegment, searchString: cached.keyword + ' in ' + cached.city + ', ' + cached.country },
          error: null,
          cachedFrom: { ageDays: Math.round(cached.age_days), createdAt: cached.created_at, hash: paramsHash },
          recentSearches: getRecentSearches(), ...getSidebarCounts()
        });
      }
      // Default mode — show the prompt banner, no Compass call yet
      return res.render('search', {
        results: null, totalScraped: 0,
        query: { keyword, excludeKeywords, city, state, maxResults: limit, ratingMin, ratingMax, maxReviews, skipEnrichment, useLayer3: src.useLayer3 || 'on', outreachPriority, targetSegment },
        error: null,
        cachePrompt: {
          ageDays: Math.round(cached.age_days),
          createdAt: cached.created_at,
          totalLeads: cached.total_leads,
          emailCount: cached.email_count,
          phoneCount: cached.phone_count,
          instagramCount: cached.instagram_count,
          hash: paramsHash
        },
        recentSearches: getRecentSearches(), ...getSidebarCounts()
      });
    }
  } else if (forceFresh) {
    // User chose "Refresh from source" — invalidate any cached rows for this exact param set
    store.invalidateHash(paramsHash);
  }

  // Parse multi-keyword (comma-separated) — each becomes its own search, results merged & deduped
  const keywords = String(keyword).split(',').map(k => k.trim()).filter(Boolean);
  const excludeTerms = String(excludeKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  const perKeywordLimit = Math.max(20, Math.ceil(limit / keywords.length));

  console.log(`[search] Keywords: ${JSON.stringify(keywords)} in ${city}, ${state} · limit ${limit} (≈${perKeywordLimit}/keyword)`);
  console.log(`[search] Exclude: ${JSON.stringify(excludeTerms)} · rating ${ratingMin}–${ratingMax} · maxReviews ${maxReviews}`);

  try {
    // --- Filter values, parsed once at function scope ---
    // Persisted on the search_history row. Compass applies them itself via
    // applyFilters in layer1-compass-maps.js.
    const minVal        = (ratingMin   !== undefined && ratingMin   !== '') ? parseFloat(ratingMin)   : null;
    const maxVal        = (ratingMax   !== undefined && ratingMax   !== '') ? parseFloat(ratingMax)   : null;
    const maxReviewsVal = (maxReviews  !== undefined && maxReviews  !== '') ? parseInt(maxReviews, 10) : null;
    console.log(`[search] Parsed filters — minVal: ${minVal}, maxVal: ${maxVal}, maxReviewsVal: ${maxReviewsVal}`);

    let mappedResults = null;
    let filteredResults = null;
    let apifyCostUsd = 0;       // Cumulative Apify spend for this request (history + UI)

    console.log('[search] Using Apify Compass for Maps · requested limit ' + limit);
    const allowExpensive = String(src.allowExpensive || '') === '1';
    const compass = await scrapeMapsViaCompass({
      keyword, city, country: state,
      resultsLimit: limit, ratingMin, ratingMax, maxReviews, excludeKeywords,
      allowExpensive,
    });
    if (compass.leads != null && !compass.error) {
      // Compass already returns leads in our normalised shape, with exclude + rating + max-reviews
      // filters applied. So mappedResults and filteredResults are the same value.
      mappedResults   = compass.leads;
      filteredResults = compass.leads;
      apifyCostUsd   += compass.costUsd || 0;
      console.log(`[search] Compass returned ${filteredResults.length} leads · $${apifyCostUsd.toFixed(4)}`);
    } else {
      // Most common cause: APIFY_API_TOKEN not set in Replit Secrets.
      const reason = compass.error || 'unknown error';
      console.error(`[search] Compass failed: ${reason}`);
      const isTokenIssue = /APIFY_API_TOKEN/i.test(reason) || /401|unauthorized|forbidden/i.test(reason);
      const friendly = isTokenIssue
        ? `Apify token missing or invalid. Set APIFY_API_TOKEN in Replit Secrets (Apify → Console → Integrations → API token).`
        : `Apify Compass failed: ${reason}`;
      return res.render('search', {
        results: null, totalScraped: 0, query: null,
        error: friendly,
        recentSearches: getRecentSearches(), ...getSidebarCounts()
      });
    }

    // Enrich contacts (skips the website scrape entirely if both email and IG toggles are OFF)
    if (enrich) {
      console.log(`[enrich] Enriching ${filteredResults.length} leads · L2-emails=${extractEmails} L2-IG=${extractInstagram} L3=${useLayer3Enabled}`);
      const BATCH_SIZE = 5;
      for (let i = 0; i < filteredResults.length; i += BATCH_SIZE) {
        const batch = filteredResults.slice(i, i + BATCH_SIZE);
        const enrichments = await Promise.all(
          batch.map(r => enrichLead(r.website, r.title, {
            useLayer3: wantsLayer3,
            extractEmails,
            extractInstagram,
          }))
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

    // --- Apify Instagram Profile Scraper ---
    // For every lead with an IG handle (typically from Layer 2's website scrape):
    //   1. Fetch the IG profile (followers + display name) via apify/instagram-profile-scraper
    //   2. Validate that the profile's display name overlaps with the business name.
    //      If not → strip the IG handle (Whitebird Coffee → trentsvineyard bug fix).
    //   3. Populate lead.instagram_followers from the real profile data.
    // Default ON; toggle off to keep the website-scraped handle without follower enrichment.
    // Gated on extractInstagram too — never run when the user opted out of IG entirely.
    if (enrich && enrichInstagramApifyEnabled && extractInstagram) {
      const candidates = filteredResults.filter(r => r.instagram);
      if (candidates.length > 0) {
        console.log(`[apify-ig] Validating + enriching ${candidates.length} IG handles via apify/instagram-profile-scraper`);
        try {
          const igOut = await enrichInstagramViaApify(candidates);
          apifyCostUsd += igOut.costUsd || 0;
          console.log(`[apify-ig] $${(igOut.costUsd || 0).toFixed(4)} · ${igOut.populated || 0} populated · ${igOut.rejected || 0} rejected · ${igOut.missing || 0} missing`);
        } catch (e) {
          console.error(`[apify-ig] Enrichment failed: ${e.message}`);
          // Don't crash the search — leads keep their website-scraped IG handles, just no follower data.
        }
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

      // Contact method — first available channel in the user-selected priority order.
      // Follower count does not influence routing; that's up to the user to decide.
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

    // --- Chain detection + tier classification ---
    // Runs AFTER enrichment so contact-based grouping (Signal A) can use scraped emails / phones.
    // Chain candidates are flagged in-place; tier classification is per unique root name and cached for 90 days.
    try {
      detectChains(filteredResults);
      const candidateRoots = [...new Set(filteredResults.filter(r => r.is_chain_candidate && r.chain_root_name).map(r => r.chain_root_name))];
      if (candidateRoots.length > 0) {
        console.log(`[chains] ${candidateRoots.length} unique candidate root(s): ${candidateRoots.slice(0, 8).join(', ')}${candidateRoots.length > 8 ? '…' : ''}`);
        const tierByRoot = new Map();
        for (const root of candidateRoots) {
          // Cache-only lookup — uncached chains default to 'local' until the next data
          // source (Leads Finder) lands with native company-size info.
          const out = await classifyTier(root, {
            cache: { get: store.getChainTier, set: store.setChainTier },
          });
          tierByRoot.set(root, out.tier);
          console.log(`[chains]   "${root}" → ${out.tier}${out.fromCache ? ' (cached)' : ''}`);
        }
        // Apply tier to every chain-candidate lead
        for (const r of filteredResults) {
          if (r.is_chain_candidate) r.chain_tier = tierByRoot.get(r.chain_root_name) || 'local';
          else r.chain_tier = 'independent';
        }
        const flagged = filteredResults.filter(r => r.is_chain_candidate).length;
        console.log(`[chains] Flagged ${flagged}/${filteredResults.length} leads as chain candidates`);
      } else {
        for (const r of filteredResults) r.chain_tier = 'independent';
      }
    } catch (e) {
      console.error('[chains] Detection failed:', e.message);
      for (const r of filteredResults) {
        r.is_chain_candidate = r.is_chain_candidate || false;
        r.chain_tier = r.chain_tier || 'independent';
        r.chain_signals_fired = r.chain_signals_fired || [];
      }
    }

    // Target segment filter (server-side; applied AFTER segment tagging)
    let segmentFiltered = filteredResults;
    const segFilter = (targetSegment || 'all').toUpperCase();
    if (segFilter === 'B') segmentFiltered = filteredResults.filter(r => r.segmentCode === 'B');
    else if (segFilter === 'C') segmentFiltered = filteredResults.filter(r => r.segmentCode === 'C');
    else if (segFilter === 'BC') segmentFiltered = filteredResults.filter(r => r.segmentCode === 'B' || r.segmentCode === 'C');
    console.log(`[search] After target-segment filter (${segFilter}): ${segmentFiltered.length}`);

    // Save to search history (SQLite — persistent across container restarts)
    store.recordSearch({
      hash: paramsHash,
      keyword: keywords.join(', '),
      city: String(city),
      country: String(state),
      rating_min: minVal,
      rating_max: maxVal,
      max_reviews: maxReviewsVal,
      results_limit: limit,
      segment_target: segFilter.toLowerCase(),
      outreach_priority: outreachPriority || 'phone-first',
      total_leads: segmentFiltered.length,
      email_count: segmentFiltered.filter(r => r.email).length,
      phone_count: segmentFiltered.filter(r => r.phone).length,
      instagram_count: segmentFiltered.filter(r => r.instagram).length,
      serpapi_credits_used: 0,
      results_json: JSON.stringify(segmentFiltered),
    });

    res.render('search', {
      results: segmentFiltered,
      totalScraped: mappedResults ? mappedResults.length : segmentFiltered.length,
      apifyCostUsd,
      dataSourceUsed: 'apify',
      query: { keyword, excludeKeywords, city, state, maxResults: limit, ratingMin, ratingMax, maxReviews, skipEnrichment, outreachPriority, targetSegment,
        extractPhones:    extractPhones    ? 'on' : 'off',
        extractEmails:    extractEmails    ? 'on' : 'off',
        extractInstagram: extractInstagram ? 'on' : 'off',
        useLayer3:        useLayer3Enabled ? 'on' : 'off',
        enrichInstagramApify: enrichInstagramApifyEnabled ? 'on' : 'off',
        searchString: keywords.join(', ') + ` in ${city}, ${state}` },
      error: null,
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });

  } catch (err) {
    console.error('[search] Error:', err.message);
    const errorMsg = 'Search failed: ' + (err.message || 'Unknown error');
    res.render('search', { results: null, totalScraped: 0, query: null, error: errorMsg, recentSearches: getRecentSearches(), ...getSidebarCounts() });
  }
}

// --- History ---
// --- Recovery route: ingest an already-paid-for Apify run by ID ---
// Pulls the dataset from Apify (no new actor call, no extra charges) and renders the leads
// like a normal search. Find run IDs in Apify Console → Runs.
// Usage: /recover-apify-run?runId=abcXYZ&city=Manchester&state=UK&keyword=cafes
app.get('/recover-apify-run', async (req, res) => {
  const runId = String(req.query.runId || '').trim();
  const city = String(req.query.city || '').trim();
  const state = String(req.query.state || '').trim();
  const keyword = String(req.query.keyword || '').trim();
  if (!runId) {
    return res.render('search', {
      results: null, totalScraped: 0, query: null,
      error: 'Pass ?runId=<apify-run-id>&city=<city>&state=<country> to recover an already-completed Apify run.',
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });
  }
  console.log(`[recover] Fetching Apify run ${runId} dataset`);
  const out = await fetchCompassRunDataset(runId, { city, country: state });
  if (out.error || !out.leads) {
    return res.render('search', {
      results: null, totalScraped: 0, query: null,
      error: out.error || 'Recovery returned no leads',
      recentSearches: getRecentSearches(), ...getSidebarCounts()
    });
  }
  console.log(`[recover] Recovered ${out.leads.length} leads from ${out.raw} raw places · run cost $${(out.costUsd || 0).toFixed(4)}`);
  // Tag every lead with a minimal segment + score so the UI doesn't blank out
  for (const r of out.leads) {
    if (r.rating !== null && r.rating < 4.1 && r.reviewCount >= 80) { r.segment = 'Low Rating'; r.segmentCode = 'C'; }
    else if (r.rating !== null && r.rating >= 4.1 && r.rating <= 4.7 && r.reviewCount <= 300) { r.segment = 'Good Rating, Low Volume'; r.segmentCode = 'B'; }
    else { r.segment = 'Other'; r.segmentCode = '-'; }
    r.outreach = r.phone ? 'Call' : (r.email ? 'Email' : (r.instagram ? 'DM' : 'None'));
    r.qualityScore = (r.phone ? 25 : 0) + (r.instagram ? 25 : 0) + (r.website ? 15 : 0);
    r.is_chain_candidate = false;
    r.chain_tier = 'independent';
    r.chain_signals_fired = [];
  }
  res.render('search', {
    results: out.leads,
    totalScraped: out.raw,
    apifyCostUsd: out.costUsd || 0,
    dataSourceUsed: 'apify-recovery',
    query: {
      keyword: keyword || `(recovered ${runId})`,
      city, state, maxResults: out.leads.length,
      searchString: `${keyword || 'recovered'} in ${city}, ${state} · run ${runId}`,
    },
    error: null,
    cachedFrom: { ageDays: 0, createdAt: new Date().toISOString(), hash: runId },
    recentSearches: getRecentSearches(), ...getSidebarCounts()
  });
});

app.get('/history', (req, res) => {
  const { from, to, city, keyword, sort, dir } = req.query;
  const searches = store.listSearches({ from, to, city, keyword, sort, dir });
  const stats = store.getStats();
  res.render('history', {
    searches,
    stats,
    filters: { from: from || '', to: to || '', city: city || '', keyword: keyword || '', sort: sort || 'created', dir: dir || 'desc' },
    ...getSidebarCounts()
  });
});

// View one historical search — loads the cached results from SQLite
app.get('/history/:id', (req, res) => {
  const row = store.getSearchById(parseInt(req.params.id, 10));
  if (!row) return res.redirect('/history');
  store.touchAccess(row.id);
  const results = JSON.parse(row.results_json || '[]');
  res.render('search', {
    results,
    totalScraped: results.length,
    query: { keyword: row.keyword, city: row.city, state: row.country, outreachPriority: row.outreach_priority || 'phone-first', searchString: `${row.keyword} in ${row.city}, ${row.country}` },
    error: null,
    cachedFrom: { ageDays: Math.max(0, Math.round((Date.now() - new Date(row.created_at).getTime()) / 86400000)), createdAt: row.created_at, hash: row.search_params_hash },
    recentSearches: getRecentSearches(), ...getSidebarCounts()
  });
});

// Delete one history row
app.post('/history/delete/:id', (req, res) => {
  store.deleteSearchById(parseInt(req.params.id, 10));
  res.redirect('/history');
});

// "Run again" — redirect to /search with the same params (forceFresh=1 to skip cache)
app.get('/history/run/:id', (req, res) => {
  const row = store.getSearchById(parseInt(req.params.id, 10));
  if (!row) return res.redirect('/history');
  const params = new URLSearchParams({
    keyword: row.keyword, city: row.city, state: row.country,
    ratingMin: row.rating_min ?? '', ratingMax: row.rating_max ?? '',
    maxReviews: row.max_reviews ?? '', maxResults: row.results_limit ?? 100,
    targetSegment: row.segment_target ?? 'all',
    outreachPriority: row.outreach_priority ?? 'phone-first',
    forceFresh: '1'
  });
  res.redirect('/search?' + params.toString());
});

// --- Leads (now SQLite-backed) ---
app.get('/leads', (req, res) => {
  res.render('leads', { leads: store.listSavedLeads(), ...getSidebarCounts() });
});

app.get('/leads/saved', (req, res) => {
  res.json(store.listSavedLeadKeys());
});

app.post('/leads/save', (req, res) => {
  const lead = req.body;
  if (!lead || !lead.title) return res.status(400).json({ error: 'Lead data required.' });
  res.json(store.saveLead(lead));
});

app.post('/leads/delete/:key', (req, res) => {
  store.deleteSavedLead(req.params.key);
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
