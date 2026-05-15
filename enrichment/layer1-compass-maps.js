// Layer 1 — Compass Google Maps scraper (Apify) as an alternative to SerpAPI.
// Runs behind a feature flag (`dataSource=apify`) so we can compare outputs side-by-side
// before cutting over fully. Normalised output matches the existing LeadHunter lead shape so
// every downstream layer (Layer 2/3, chain detection, segmentation, UI) works unchanged.

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

// Main entry point. Returns { leads, costUsd, runId } — never throws; callers fall back to SerpAPI.
async function scrapeMapsViaCompass({ keyword, city, country, resultsLimit, ratingMin, ratingMax, maxReviews, excludeKeywords }) {
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

  const input = {
    searchStringsArray,
    locationQuery: `${city}, ${country}`,
    maxCrawledPlacesPerSearch: Math.min(Math.max(parseInt(resultsLimit, 10) || 100, 1), 500),
    language: 'en',
    skipClosedPlaces: true,
    scrapeReviewsPersonalData: false,
    maxReviews: 5,                 // Bundle the last 5 reviews per place — unlocks future Intent Score work
    includeWebResults: false,
  };

  let run;
  try {
    run = await client.actor(COMPASS_ACTOR_ID).call(input, { timeout: 300, memory: 1024 });
  } catch (err) {
    console.error(`[apify-compass] Actor call failed: ${err.message}`);
    return { leads: null, costUsd: 0, runId: null, error: err.message };
  }

  let datasetItems = [];
  try {
    const out = await client.dataset(run.defaultDatasetId).listItems();
    datasetItems = out.items || [];
  } catch (err) {
    console.error(`[apify-compass] Dataset fetch failed: ${err.message}`);
    return { leads: null, costUsd: run.usageTotalUsd || 0, runId: run.id, error: err.message };
  }

  const normalized = datasetItems.map(item => normalizeCompassItem(item, city, country));

  // Exclude-keyword filter — mirrors the SerpAPI path's behaviour
  const excludeTerms = String(excludeKeywords || '')
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
  const beforeExclude = normalized.length;
  const afterExclude = excludeTerms.length === 0 ? normalized : normalized.filter(item => {
    const hay = `${item.title || ''} ${item.category || ''}`.toLowerCase();
    return !excludeTerms.some(term => hay.includes(term));
  });

  // Rating + max-reviews filter
  const filtered = applyFilters(afterExclude, { ratingMin, ratingMax, maxReviews });

  const costUsd = run.usageTotalUsd != null ? run.usageTotalUsd : 0;
  console.log(`[apify-compass] Run ${run.id} · $${(costUsd || 0).toFixed(4)} · ${datasetItems.length} places → ${filtered.length} after filters (excluded ${beforeExclude - afterExclude.length})`);

  return { leads: filtered, costUsd, runId: run.id, raw: datasetItems.length };
}

module.exports = { scrapeMapsViaCompass, normalizeCompassItem, applyFilters };
