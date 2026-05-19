// Layer 1 — Compass Google Maps scraper (Apify). Sole data source.
// Normalised output matches the existing LeadHunter lead shape so every downstream
// layer (Layer 2/3, chain detection, segmentation, UI) works unchanged.

const { client, hasToken } = require('./apify-client');
const { isAggregatorDomain } = require('./utils/domain-utils');

const COMPASS_ACTOR_ID = 'compass/crawler-google-places';

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

// Apply post-scrape filters that Compass doesn't natively support (rating range, max reviews).
function applyFilters(items, { ratingMin, ratingMax, maxReviews } = {}) {
  const minVal = (ratingMin !== undefined && ratingMin !== '' && ratingMin !== null) ? parseFloat(ratingMin) : null;
  const maxVal = (ratingMax !== undefined && ratingMax !== '' && ratingMax !== null) ? parseFloat(ratingMax) : null;
  const maxR   = (maxReviews !== undefined && maxReviews !== '' && maxReviews !== null) ? parseInt(maxReviews, 10) : null;
  return items.filter(item => {
    if (minVal != null && (item.rating == null || item.rating < minVal)) return false;
    if (maxVal != null && (item.rating == null || item.rating > maxVal)) return false;
    if (maxR  != null && (item.reviewCount || 0) >= maxR) return false;
    return true;
  });
}

// Cost-cap helpers — both estimation (before the call) and enforcement (during).
// Compass pricing (rule of thumb): ~$0.0025 per place baseline + ~$0.005 per review scraped.
function estimateCompassCostUsd(placesLimit, reviewsPerPlace) {
  const places = Math.max(0, parseInt(placesLimit, 10) || 0);
  const reviews = Math.max(0, parseInt(reviewsPerPlace, 10) || 0);
  return (places * 0.0025) + (places * reviews * 0.005);
}
const APIFY_HARD_CAP_USD = 2.0;       // Refuse any search whose estimate exceeds this (without explicit override)
const APIFY_SOFT_WARN_USD = 0.5;      // Above this, the UI shows a confirm-or-cancel modal before submitting

// Main entry point. Returns { leads, costUsd, runId } — never throws; callers handle errors.
async function scrapeMapsViaCompass({ keyword, city, country, resultsLimit, ratingMin, ratingMax, maxReviews, excludeKeywords, allowExpensive }) {
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

  const actualCost = run.usageTotalUsd != null ? run.usageTotalUsd : 0;
  console.log(`[apify-compass] Run ${run.id} completed · actual cost $${actualCost.toFixed(4)}`);

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

  // Rating + max-reviews filter
  const filtered = applyFilters(afterExclude, { ratingMin, ratingMax, maxReviews });
  if (filtered.length < afterExclude.length) {
    console.log(`[apify-compass] After rating/maxReviews filter: ${filtered.length} (dropped ${afterExclude.length - filtered.length})`);
  }

  console.log(`[apify-compass] Final: $${actualCost.toFixed(4)} · ${datasetItems.length} raw → ${filtered.length} after all filters`);

  return { leads: filtered, costUsd: actualCost, runId: run.id, raw: datasetItems.length };
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
};
