// Layer 1 — Compass Google Maps scraper (Apify). Sole data source.
// Normalised output matches the existing LeadHunter lead shape so every downstream
// layer (Layer 2/3, chain detection, segmentation, UI) works unchanged.

const { client, hasToken } = require('./apify-client');
const { isAggregatorDomain } = require('./utils/domain-utils');

const COMPASS_ACTOR_ID = 'compass/crawler-google-places';

// ——— Trigger presets (Phase 1) ———
// A "trigger" is the buying signal that makes a lead warm *now*. Phase 1 ships the two that
// need no data beyond what Compass already returns. Two more (low velocity, newly opened)
// arrive with Layer 5, which is why the resolver below takes an ARRAY of active triggers
// rather than a single key — Phase 2 needs "low rating + low velocity" to co-fire.
//
// TUNABLE TRIGGER THRESHOLDS — calibrate against real search results.
// Every number here is expected to move once we see what it actually surfaces. Phase 1
// (lowRating, lowVolume) needs no data beyond Compass; Phase 2 (lowVelocity, newlyOpened,
// sentiment) needs the review dates that Layer 5 fetches.
const TRIGGER_THRESHOLDS = {
  lowRating: { ratingMin: 3.3, ratingMax: 4.2 },  // below 3.3 = product problem, not a review-capture problem
  lowVolume: { reviewsMin: 5,  reviewsMax: 40 },  // min excludes near-empty new places; max flags under-capturing

  // --- Phase 2 ---
  lowVelocity: {
    windowDays: 60,
    // Tiered by review base so the signal doesn't misfire on quiet-but-normal small places.
    // Evaluated top-down; first tier whose minTotalReviews is met wins.
    tiers: [
      { minTotalReviews: 200, flagIfRecentBelow: 5 },   // 200+ total  → stalled if <5 in window
      { minTotalReviews: 50,  flagIfRecentBelow: 3 },   // 50–200      → stalled if <3 in window
    ],
    // Under this many total reviews the velocity signal is too noisy to mean anything —
    // those places belong to Low volume or Newly opened instead.
    appliesAboveTotalReviews: 50,
  },
  newlyOpened: {
    firstReviewWithinDays: 120,   // ~4 months
    maxTotalReviews: 20,
  },
  sentiment: {
    sampleSize: 5,   // "last 5 reviews"
    // Deadband around the overall rating. Google rounds the overall rating to one decimal and
    // a 5-review average is coarse, so without this the trend would flip on rounding noise.
    deadband: 0.3,
  },
  // Fetch shaping for Layer 5 — these bound cost, not signal quality.
  fetch: {
    // Safety cap per place on the date-windowed pull. Any place with 50+ reviews inside the
    // window is emphatically not "low velocity", so truncating there cannot change a verdict.
    maxReviewsPerPlace: 50,
    // Places with fewer than this get their FULL review history pulled instead of a windowed
    // one, because firstReviewDate needs the oldest review and the API has no oldest-first sort.
    fullHistoryBelowTotalReviews: 20,
    batchSize: 25,   // placeIds per Reviews Scraper run
    usdPerReview: 0.00034,   // measured 2026-07-20: $0.00405 for 12 reviews
  },
};

const TRIGGER_PRESETS = {
  'low-rating': {
    label: 'Low rating',
    tooltip: 'Good enough to save, bad enough to lose bookings. Below 3.3 is usually a product problem, not a review-capture problem.',
    ratingMin: TRIGGER_THRESHOLDS.lowRating.ratingMin,
    ratingMax: TRIGGER_THRESHOLDS.lowRating.ratingMax,
  },
  'low-volume': {
    label: 'Low volume',
    tooltip: 'Established but under-capturing reviews — the core Starise wedge.',
    reviewsMin: TRIGGER_THRESHOLDS.lowVolume.reviewsMin,
    reviewsMax: TRIGGER_THRESHOLDS.lowVolume.reviewsMax,
  },
  // --- Phase 2 --- these need review DATES, which Compass does not return in the cheap config,
  // so selecting one turns on the Layer 5 fetch and its extra cost. See needsReviewSignals().
  'low-velocity': {
    label: 'Low velocity',
    tooltip: 'Used to generate reviews, now stalled — something changed.',
    requiresReviewSignals: true,
  },
  'newly-opened': {
    label: 'Newly opened',
    tooltip: 'Recently opened — pitch getting ahead of reviews from day one.',
    requiresReviewSignals: true,
  },
};

// True when any active trigger depends on Layer 5 review-date signals. Drives BOTH the cost
// gate and whether the fetch runs at all — Layer 5 must never run by default.
function needsReviewSignals(triggers) {
  return parseTriggers(triggers).some(k => TRIGGER_PRESETS[k].requiresReviewSignals);
}

// Normalise whatever the form/query string sent into an array of valid trigger keys.
// Accepts a single string, a comma-joined string (cache replay), or an array (Express qs
// parses repeated `?trigger=a&trigger=b` into one). Unknown keys are dropped.
function parseTriggers(trigger) {
  const raw = Array.isArray(trigger)
    ? trigger
    : String(trigger || '').split(',');
  return [...new Set(raw.map(t => String(t).trim()).filter(k => TRIGGER_PRESETS[k]))];
}

// Fold the active triggers into concrete filter values.
//
// A rating-bearing trigger REPLACES the manual/vertical-preset rating range rather than
// intersecting with it. That matters because every vertical preset sets ratingMin 4.0 —
// intersecting would leave "Low rating + Casual dining" with a 4.0–4.2 sliver, which is the
// opposite of what the trigger means. Where several triggers each carry a rating range
// (Phase 2), those intersect with each other so combinations tighten rather than conflict.
function resolveTriggerFilters(triggers, { ratingMin, ratingMax } = {}) {
  const active = parseTriggers(triggers);
  const out = { ratingMin, ratingMax, reviewsMin: null, reviewsMax: null, activeTriggers: active };
  let ratingOwnedByTrigger = false;
  for (const key of active) {
    const p = TRIGGER_PRESETS[key];
    if (p.ratingMin != null || p.ratingMax != null) {
      if (!ratingOwnedByTrigger) {
        // First rating-bearing trigger wipes the manual range, then owns it.
        out.ratingMin = p.ratingMin ?? null;
        out.ratingMax = p.ratingMax ?? null;
        ratingOwnedByTrigger = true;
      } else {
        if (p.ratingMin != null) out.ratingMin = Math.max(out.ratingMin ?? 0, p.ratingMin);
        if (p.ratingMax != null) out.ratingMax = Math.min(out.ratingMax ?? 5, p.ratingMax);
      }
    }
    if (p.reviewsMin != null) out.reviewsMin = Math.max(out.reviewsMin ?? 0, p.reviewsMin);
    if (p.reviewsMax != null) out.reviewsMax = Math.min(out.reviewsMax ?? Infinity, p.reviewsMax);
  }
  return out;
}

// Map Compass output → existing lead schema. Field names match what server.js's mappedResults
// produces today; new fields (recentReviews, permanentlyClosed) are appended but never replace
// existing ones.
function normalizeCompassItem(item, city, state) {
  // Compass returns IG link if it scraped one off the place's site — but we don't trust it
  // here; let Layer 2 / Apify-IG do the actual enrichment.
  const website = item.website || '';
  return {
    title:           item.title || '',
    phone:           item.phone || '',
    website,
    email:           '',
    emailRole:       '',
    emailPriority:   0,
    emails:          [],
    email_source:    null,
    email_confidence: null,
    instagram:       '',
    instagramSource: null,
    instagram_followers: null,
    booking:         '',
    hours:           formatHours(item.openingHours),
    priceTier:       item.price || '',
    placeId:         item.placeId || '',
    isAggregator:    isAggregatorDomain(website),
    category:        item.categoryName || (Array.isArray(item.categories) ? item.categories[0] : '') || '',
    address:         item.address || '',
    city,
    state,
    rating:          item.totalScore != null ? item.totalScore : null,
    reviewCount:     item.reviewsCount != null ? item.reviewsCount : 0,
    url:             item.url || (item.placeId ? `https://www.google.com/maps/place/?q=place_id:${item.placeId}` : ''),
    imageUrl:        item.imageUrl || (Array.isArray(item.imageUrls) ? item.imageUrls[0] : '') || '',
    // New fields surfaced by Compass — keep alongside the existing shape
    permanentlyClosed: !!item.permanentlyClosed,
    recentReviews:   Array.isArray(item.reviews) ? item.reviews.slice(0, 5).map(r => ({
      rating:       r.stars != null ? r.stars : null,
      publishedAt:  r.publishedAtDate || r.publishAt || null,
      text:         r.text || '',
    })) : [],
  };
}

function formatHours(openingHours) {
  if (!openingHours) return '';
  if (typeof openingHours === 'string') return openingHours;
  if (Array.isArray(openingHours)) {
    return openingHours
      .slice(0, 3)
      .map(h => typeof h === 'string' ? h : (h && (h.hours || h.day || JSON.stringify(h))))
      .filter(Boolean)
      .join(' · ');
  }
  if (typeof openingHours === 'object') return openingHours.status || '';
  return '';
}

// Apply post-scrape filters that Compass doesn't natively support (rating range, max reviews,
// trigger review-count band).
//
// Note the two different review-count semantics, kept deliberately separate:
//   maxReviews             — the manual "Under N" dropdown. EXCLUSIVE (< N), pre-existing behaviour.
//   reviewsMin/reviewsMax  — the trigger band (e.g. Low volume 5–40). INCLUSIVE on both ends.
function applyFilters(items, { ratingMin, ratingMax, maxReviews, reviewsMin, reviewsMax } = {}) {
  const num = (v) => (v !== undefined && v !== '' && v !== null) ? Number(v) : null;
  const minVal = num(ratingMin);
  const maxVal = num(ratingMax);
  const maxR   = num(maxReviews);
  const revMin = num(reviewsMin);
  const revMax = num(reviewsMax);
  return items.filter(item => {
    if (minVal != null && (item.rating == null || item.rating < minVal)) return false;
    if (maxVal != null && (item.rating == null || item.rating > maxVal)) return false;
    if (maxR  != null && (item.reviewCount || 0) >= maxR) return false;
    if (revMin != null && (item.reviewCount || 0) < revMin) return false;
    if (revMax != null && (item.reviewCount || 0) > revMax) return false;
    return true;
  });
}

// Cost-cap helpers — both estimation (before the call) and enforcement (during).
//
// CALIBRATION (measured 2026-07-20, "cafes" in Bath UK, two live probes):
//   20 places, maxReviews 0  → $0.05505 settled over 13.6s  = $0.00275/place
//    5 places, maxReviews 5  → $0.03055 settled over 102.8s = $0.00611/place
//   Subtracting the places term from probe B leaves ~$0.00067 per review scraped.
//
// The old review coefficient was $0.005 — roughly 7.5× the measured rate — which made the
// $2 cap and the $0.50 confirm refuse searches that were actually cheap. The constants below
// are rounded UP from the measurements so the estimate still errs high (that's the safe
// direction for a spend gate) without over-blocking by an order of magnitude.
//
// Caveat: Apify bills compute time, not units of work, so cost is not strictly linear in
// review count — review scraping cost ~20s/place vs ~0.7s/place without. Treat this as a
// calibrated approximation, and re-measure if Compass changes its pricing model.
const COMPASS_USD_PER_PLACE  = 0.003;   // measured $0.00275
const COMPASS_USD_PER_REVIEW = 0.001;   // measured ~$0.00067
function estimateCompassCostUsd(placesLimit, reviewsPerPlace) {
  const places = Math.max(0, parseInt(placesLimit, 10) || 0);
  const reviews = Math.max(0, parseInt(reviewsPerPlace, 10) || 0);
  return (places * COMPASS_USD_PER_PLACE) + (places * reviews * COMPASS_USD_PER_REVIEW);
}

// `run.usageTotalUsd` on the object returned by `.call()` is NOT reliably the final figure.
// Apify settles billing asynchronously, and until it does the field holds a fixed placeholder
// of exactly $0.00005. That number is shown to the user after every search and persisted to
// search history, so publishing it means reporting a cost ~1000× under the truth.
//
// MEASURED 2026-07-20 (three runs):
//   run 7qJDHRn9...  inline $0.00005  → settled $0.05505   (unsettled at read time)
//   run BxE2YVlc...  inline $0.00005  → settled $0.01380   (still placeholder at +2s, settled by +60s)
//   run (bakery/5pl) inline $0.01380  → settled $0.01380 at +0.2s  (settled immediately)
//
// So the staleness is INTERMITTENT — sometimes the inline read is already correct. Detecting
// it by "value stopped changing" does not work, because the placeholder is itself stable for
// tens of seconds. Detect it by plausibility instead: the placeholder is far below what any
// real run costs (the cheapest observed real run, 5 places, was $0.0138).
const APIFY_UNSETTLED_PLACEHOLDER_USD = 0.0001;  // placeholder is exactly $0.00005; real runs are >= ~$0.0138

// Returns { costUsd, settled }. When it can't settle within the budget the caller should
// prefer its own estimate over `costUsd` — reporting an estimate is wrong by tens of percent,
// reporting the placeholder is wrong by three orders of magnitude.
async function fetchSettledCostUsd(runId, { timeoutMs = 12000, delayMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const r = await client.run(runId).get();
      last = (r && r.usageTotalUsd != null) ? r.usageTotalUsd : 0;
    } catch (err) {
      console.error(`[apify-compass] usage re-fetch failed: ${err.message}`);
      return { costUsd: last, settled: false };
    }
    if (last > APIFY_UNSETTLED_PLACEHOLDER_USD) return { costUsd: last, settled: true };
    await new Promise(res => setTimeout(res, delayMs));
  }
  return { costUsd: last, settled: false };
}
const APIFY_HARD_CAP_USD = 2.0;       // Refuse any search whose estimate exceeds this (without explicit override)
const APIFY_SOFT_WARN_USD = 0.5;      // Above this, the UI shows a confirm-or-cancel modal before submitting

// Main entry point. Returns { leads, costUsd, runId } — never throws; callers handle errors.
async function scrapeMapsViaCompass({ keyword, city, country, resultsLimit, ratingMin, ratingMax, maxReviews, reviewsMin, reviewsMax, excludeKeywords, allowExpensive }) {
  if (!hasToken) {
    return { leads: null, costUsd: 0, runId: null, error: 'APIFY_API_TOKEN not configured' };
  }

  const searchStringsArray = String(keyword || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (!searchStringsArray.length) {
    return { leads: null, costUsd: 0, runId: null, error: 'No keyword provided' };
  }

  // Default cap 20 unless user explicitly chose higher AND acknowledged the cost.
  // resultsLimit is whatever the form sent. We respect it but enforce the hard cap.
  const requestedPlaces = Math.min(Math.max(parseInt(resultsLimit, 10) || 20, 1), 500);
  // Cost gate — reviews now default to 0 (was 5, which inflated per-search cost ~10×).
  const REVIEWS_PER_PLACE = 0;
  const estCost = estimateCompassCostUsd(requestedPlaces, REVIEWS_PER_PLACE);
  if (estCost > APIFY_HARD_CAP_USD && !allowExpensive) {
    return {
      leads: null, costUsd: 0, runId: null,
      error: `Search estimated at $${estCost.toFixed(2)} exceeds the $${APIFY_HARD_CAP_USD.toFixed(2)} per-search cap. Reduce Results, or add &allowExpensive=1 to the URL to override.`,
    };
  }

  const input = {
    searchStringsArray,
    locationQuery: `${city}, ${country}`,
    maxCrawledPlacesPerSearch: requestedPlaces,
    language: 'en',
    skipClosedPlaces: true,
    scrapeReviewsPersonalData: false,
    maxReviews: REVIEWS_PER_PLACE,   // 0 = no reviews, big cost saving
    includeWebResults: false,
  };

  console.log(`[apify-compass] About to call ${COMPASS_ACTOR_ID} · est cost $${estCost.toFixed(4)} · ${requestedPlaces} places · ${searchStringsArray.length} keywords`);

  let run;
  try {
    run = await client.actor(COMPASS_ACTOR_ID).call(input, { timeout: 300, memory: 1024 });
  } catch (err) {
    console.error(`[apify-compass] Actor call failed: ${err.message}`);
    return { leads: null, costUsd: 0, runId: null, error: err.message };
  }

  // Cost reporting: prefer the settled figure; fall back to our own estimate if Apify hasn't
  // settled in time. Never report the placeholder — see fetchSettledCostUsd above.
  const inlineCost = run.usageTotalUsd != null ? run.usageTotalUsd : 0;
  const settledResult = await fetchSettledCostUsd(run.id);
  const costProvisional = !settledResult.settled;
  const actualCost = costProvisional ? estCost : settledResult.costUsd;
  console.log(
    costProvisional
      ? `[apify-compass] Run ${run.id} completed · cost UNSETTLED after 12s (Apify still reporting $${settledResult.costUsd.toFixed(5)}) · reporting estimate $${estCost.toFixed(5)} instead — reconcile later via runId`
      : `[apify-compass] Run ${run.id} completed · settled cost $${actualCost.toFixed(5)} (inline read was $${inlineCost.toFixed(5)})`
  );

  let datasetItems = [];
  try {
    const out = await client.dataset(run.defaultDatasetId).listItems();
    datasetItems = out.items || [];
  } catch (err) {
    console.error(`[apify-compass] Dataset fetch failed: ${err.message}`);
    return { leads: null, costUsd: actualCost, runId: run.id, error: err.message };
  }

  console.log(`[apify-compass] Dataset returned ${datasetItems.length} raw items`);
  // Log the keys of the first item — instantly reveals any field-name mismatch
  if (datasetItems.length > 0) {
    const sample = datasetItems[0];
    const keys = Object.keys(sample).slice(0, 30).join(', ');
    console.log(`[apify-compass] First item keys: ${keys}`);
    console.log(`[apify-compass] First item title="${sample.title}" rating=${sample.totalScore} reviews=${sample.reviewsCount}`);
  }

  const normalized = datasetItems.map(item => normalizeCompassItem(item, city, country));
  console.log(`[apify-compass] After normalize: ${normalized.length} items`);

  // Drop any items that lack a usable title — they'd be invisible in the UI anyway
  const titled = normalized.filter(r => r.title && r.title.trim());
  if (titled.length < normalized.length) {
    console.log(`[apify-compass] Dropped ${normalized.length - titled.length} items with no title (field-name mismatch?)`);
  }

  // Exclude-keyword filter
  const excludeTerms = String(excludeKeywords || '')
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
  const afterExclude = excludeTerms.length === 0 ? titled : titled.filter(item => {
    const hay = `${item.title || ''} ${item.category || ''}`.toLowerCase();
    return !excludeTerms.some(term => hay.includes(term));
  });
  if (afterExclude.length < titled.length) {
    console.log(`[apify-compass] After exclude-keywords filter: ${afterExclude.length} (dropped ${titled.length - afterExclude.length})`);
  }

  // Rating + max-reviews + trigger review-band filter
  const filtered = applyFilters(afterExclude, { ratingMin, ratingMax, maxReviews, reviewsMin, reviewsMax });
  if (filtered.length < afterExclude.length) {
    console.log(`[apify-compass] After rating/maxReviews/trigger filter: ${filtered.length} (dropped ${afterExclude.length - filtered.length}) · rating ${ratingMin ?? '–'}–${ratingMax ?? '–'} · reviews ${reviewsMin ?? '–'}–${reviewsMax ?? '–'}`);
  }

  console.log(`[apify-compass] Final: $${actualCost.toFixed(4)} · ${datasetItems.length} raw → ${filtered.length} after all filters`);

  // costProvisional=true means costUsd is our estimate, not Apify's settled figure. Callers
  // that display or persist the cost should mark it as approximate; the runId is kept so a
  // later reconciliation pass can replace it with the real number.
  //
  // `stages` exists so a zero-result search can explain itself. These counts were previously
  // console.log-only, which meant diagnosing an empty result set required shell access to the
  // deployment logs. Returning them lets the UI say WHICH filter emptied the list — and the
  // applied bands make a silently-overriding trigger visible (a stuck `low-volume` rewrites
  // reviews to 5–40, which alone can zero out a whole city).
  return {
    leads: filtered, costUsd: actualCost, costProvisional, runId: run.id, raw: datasetItems.length,
    stages: {
      raw:           datasetItems.length,
      normalized:    normalized.length,
      titled:        titled.length,
      afterExclude:  afterExclude.length,
      afterFilters:  filtered.length,
      appliedRating:     [ratingMin ?? null, ratingMax ?? null],
      appliedMaxReviews: maxReviews ?? null,
      appliedReviewBand: [reviewsMin ?? null, reviewsMax ?? null],
    },
  };
}

// --- Recovery: pull leads from an already-completed Apify run by run ID ---
// Used by the /recover-apify-run route to ingest data we already paid for after a crash.
// Cheap — only fetches the dataset, doesn't trigger a new actor run.
async function fetchCompassRunDataset(runId, { city, country } = {}) {
  if (!hasToken) return { leads: null, error: 'APIFY_API_TOKEN not configured' };
  if (!runId) return { leads: null, error: 'runId is required' };
  let run, datasetItems = [];
  try {
    run = await client.run(runId).get();
    if (!run) return { leads: null, error: `Run ${runId} not found` };
    const out = await client.dataset(run.defaultDatasetId).listItems();
    datasetItems = out.items || [];
  } catch (err) {
    return { leads: null, error: `Recovery failed: ${err.message}` };
  }
  const normalized = datasetItems
    .map(item => normalizeCompassItem(item, city || '', country || ''))
    .filter(r => r.title && r.title.trim());
  return {
    leads: normalized,
    runId,
    raw: datasetItems.length,
    costUsd: run.usageTotalUsd || 0,
  };
}

module.exports = {
  scrapeMapsViaCompass,
  normalizeCompassItem,
  applyFilters,
  estimateCompassCostUsd,
  fetchCompassRunDataset,
  APIFY_HARD_CAP_USD,
  APIFY_SOFT_WARN_USD,
  fetchSettledCostUsd,
  TRIGGER_THRESHOLDS,
  TRIGGER_PRESETS,
  parseTriggers,
  resolveTriggerFilters,
  needsReviewSignals,
};
