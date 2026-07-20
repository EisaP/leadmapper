// Layer 5 — review-date signals: velocity, recency, and star-based sentiment.
//
// Feeds the Phase 2 triggers (Low velocity, Newly opened). NEVER runs by default: the caller
// must have a review-signal trigger active or Layer 5 explicitly toggled on, because unlike
// Compass this actor is billed per review scraped.
//
// WHY TWO FETCH STRATEGIES
// The Reviews Scraper sorts newest-first and offers no oldest-first option (its reviewsSort
// enum is newest | mostRelevant | highestRanking | lowestRanking — "lowestRanking" is by stars,
// not date). So firstReviewDate cannot be fetched directly; the only route to the oldest review
// is pulling the whole history. That is unaffordable for a 1,700-review place and pointless
// anyway, since "newly opened" requires a small review count by definition. Hence:
//
//   reviewsCount >= fullHistoryBelowTotalReviews  → WINDOWED pull (last N days, capped).
//                                                   Gives reviewsLast60d + sentiment.
//                                                   firstReviewDate stays null, which is
//                                                   correct: a place this busy is not new.
//   reviewsCount <  fullHistoryBelowTotalReviews  → FULL pull (all reviews, tiny by definition).
//                                                   Gives firstReviewDate AND, by filtering on
//                                                   date locally, reviewsLast60d + sentiment.
//
// Every lead therefore costs exactly one fetch, and both variants are cheap.

const { client, hasToken } = require('./apify-client');
// layer1 does not require layer5, so this is not a cycle.
const { TRIGGER_THRESHOLDS, fetchSettledCostUsd } = require('./layer1-compass-maps');

const REVIEWS_ACTOR_ID = 'compass/google-maps-reviews-scraper';

const daysAgoIso = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Conservative pre-flight estimate. Assumes the per-place cap is hit, which it rarely is —
// erring high is the safe direction for a spend gate.
function estimateReviewSignalsCostUsd(leadCount) {
  const { maxReviewsPerPlace, usdPerReview } = TRIGGER_THRESHOLDS.fetch;
  return Math.max(0, leadCount) * maxReviewsPerPlace * usdPerReview;
}

// Split leads by which fetch strategy they need. Leads with no placeId can't be fetched at all.
function planFetches(leads) {
  const { fullHistoryBelowTotalReviews } = TRIGGER_THRESHOLDS.fetch;
  const windowed = [], full = [], skipped = [];
  for (const lead of leads) {
    if (!lead.placeId) { skipped.push(lead); continue; }
    if ((lead.reviewCount || 0) < fullHistoryBelowTotalReviews) full.push(lead);
    else windowed.push(lead);
  }
  return { windowed, full, skipped };
}

// One Reviews Scraper run over a batch of place IDs. Returns Map<placeId, review[]>.
async function fetchReviewBatch(placeIds, { startDate, maxReviews }) {
  const input = {
    placeIds,
    reviewsSort: 'newest',
    maxReviews,
    language: 'en',
    personalData: false,
  };
  if (startDate) input.reviewsStartDate = startDate;

  const run = await client.actor(REVIEWS_ACTOR_ID).call(input, { timeout: 300, memory: 1024 });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  const byPlace = new Map();
  for (const item of items) {
    // The actor emits one row per review; placeId identifies which place it belongs to.
    const pid = item.placeId || item.placeID || null;
    if (!pid || !item.publishedAtDate) continue;
    if (!byPlace.has(pid)) byPlace.set(pid, []);
    byPlace.get(pid).push({
      publishedAtDate: item.publishedAtDate,
      stars: typeof item.stars === 'number' ? item.stars : null,
    });
  }
  return { byPlace, runId: run.id };
}

// Derive every per-lead signal from that lead's reviews.
// `fullHistory` says whether the review list is the complete history (so the oldest entry is
// genuinely the first review) or just a date-windowed slice (where it is not).
function deriveSignals(lead, reviews, { fullHistory }) {
  const { windowDays } = TRIGGER_THRESHOLDS.lowVelocity;
  const { sampleSize, deadband } = TRIGGER_THRESHOLDS.sentiment;
  const { firstReviewWithinDays, maxTotalReviews } = TRIGGER_THRESHOLDS.newlyOpened;

  const sorted = (reviews || []).slice().sort((a, b) => (a.publishedAtDate < b.publishedAtDate ? 1 : -1)); // newest first
  const windowStart = daysAgoIso(windowDays);

  lead.reviewsLast60d = sorted.filter(r => r.publishedAtDate.slice(0, 10) >= windowStart).length;

  // firstReviewDate is only meaningful when we pulled the complete history. On a windowed pull
  // the oldest row is just the window edge, so leaving it null is the honest answer.
  lead.firstReviewDate = fullHistory && sorted.length
    ? sorted[sorted.length - 1].publishedAtDate
    : null;

  // Newly opened = first review is recent AND the place still has few reviews.
  // Both halves matter. Love Weston Café (Bath) has only 3 reviews but its first is from
  // August 2023 — nearly three years old. Few reviews does NOT imply new; without the date
  // check that place would be pitched as a fresh opening.
  const newCutoff = daysAgoIso(firstReviewWithinDays);
  lead.isNewlyOpened = !!(
    lead.firstReviewDate &&
    lead.firstReviewDate.slice(0, 10) >= newCutoff &&
    (lead.reviewCount || 0) < maxTotalReviews
  );

  // Star-based sentiment over the most recent reviews we actually have. Because the windowed
  // pull is date-capped, a quiet place may yield fewer than sampleSize — recentSentimentSampleSize
  // makes that visible instead of silently averaging one review against the lifetime rating.
  const sample = sorted.filter(r => r.stars != null).slice(0, sampleSize);
  lead.recentSentimentSampleSize = sample.length;
  lead.recentSentimentAvg = sample.length
    ? Number((sample.reduce((s, r) => s + r.stars, 0) / sample.length).toFixed(2))
    : null;

  if (lead.recentSentimentAvg == null || lead.rating == null) {
    lead.sentimentTrend = null;
  } else {
    const diff = lead.recentSentimentAvg - lead.rating;
    lead.sentimentTrend = diff > deadband ? 'improving' : (diff < -deadband ? 'declining' : 'stable');
  }
  return lead;
}

// Does this lead's recent volume qualify as stalled, given its review base?
function isLowVelocity(lead) {
  const { tiers, appliesAboveTotalReviews } = TRIGGER_THRESHOLDS.lowVelocity;
  const total = lead.reviewCount || 0;
  if (total < appliesAboveTotalReviews) return false;      // too noisy to judge
  if (lead.reviewsLast60d == null) return false;           // no signal fetched
  const tier = tiers.find(t => total >= t.minTotalReviews);
  return !!tier && lead.reviewsLast60d < tier.flagIfRecentBelow;
}

function isLowVolume(lead) {
  const { reviewsMin, reviewsMax } = TRIGGER_THRESHOLDS.lowVolume;
  const total = lead.reviewCount || 0;
  return total >= reviewsMin && total <= reviewsMax;
}

function isLowRating(lead) {
  const { ratingMin, ratingMax } = TRIGGER_THRESHOLDS.lowRating;
  return lead.rating != null && lead.rating >= ratingMin && lead.rating <= ratingMax;
}

// STEP 6 — overlap guard.
// A lead can satisfy several conditions at once; without an ordering it would show up under
// two contradictory pitches ("you're brand new" and "you've stalled"). Resolve to ONE primary
// bucket in this order, most-specific first:
//
//   1. Newly opened  — a recent first review is the strongest, least ambiguous signal
//   2. Low volume    — old first review but few reviews overall: established, under-capturing
//   3. Low velocity  — decent base that has recently gone quiet
//
// Low rating is deliberately NOT in that chain: it is an independent axis that can co-occur
// with any of the above (a low-rated, low-volume place is a strong lead, not a conflict).
function classifyTriggers(lead) {
  const primary = lead.isNewlyOpened ? 'newly-opened'
    : isLowVolume(lead) ? 'low-volume'
    : isLowVelocity(lead) ? 'low-velocity'
    : null;
  lead.primaryTrigger = primary;
  lead.hasLowRating = isLowRating(lead);
  // Flat list for filtering/export: the primary bucket plus the independent low-rating axis.
  lead.matchedTriggers = [primary, lead.hasLowRating ? 'low-rating' : null].filter(Boolean);
  return lead;
}

// Main entry point. Mutates and returns the leads with signals attached.
// Returns { leads, costUsd, costProvisional, runIds, error }.
async function enrichWithReviewSignals(leads, { onProgress } = {}) {
  if (!hasToken) return { leads, costUsd: 0, costProvisional: false, runIds: [], error: 'APIFY_API_TOKEN not configured' };
  if (!Array.isArray(leads) || !leads.length) return { leads: leads || [], costUsd: 0, costProvisional: false, runIds: [] };

  const { maxReviewsPerPlace, fullHistoryBelowTotalReviews, batchSize } = TRIGGER_THRESHOLDS.fetch;
  const { windowDays } = TRIGGER_THRESHOLDS.lowVelocity;

  const { windowed, full, skipped } = planFetches(leads);
  console.log(`[layer5] ${windowed.length} windowed · ${full.length} full-history · ${skipped.length} skipped (no placeId)`);

  const byPlace = new Map();
  const runIds = [];
  let costUsd = 0;
  let costProvisional = false;

  // A null startDate IS what makes a pull a full-history pull — that's how fullHistory is
  // derived below, so the two can't drift out of sync.
  const jobs = [
    { leads: windowed, startDate: daysAgoIso(windowDays), maxReviews: maxReviewsPerPlace },
    // Full pull for the small-review places. maxReviews is bounded by the gate itself: these
    // places have fewer than `fullHistoryBelowTotalReviews` reviews in total.
    { leads: full, startDate: null, maxReviews: fullHistoryBelowTotalReviews },
  ];

  for (const job of jobs) {
    if (!job.leads.length) continue;
    for (const batch of chunk(job.leads.map(l => l.placeId), batchSize)) {
      try {
        const { byPlace: got, runId } = await fetchReviewBatch(batch, { startDate: job.startDate, maxReviews: job.maxReviews });
        runIds.push(runId);
        for (const [pid, revs] of got) byPlace.set(pid, { revs, fullHistory: !job.startDate });
        // Reuse the settled-cost logic from Layer 1 rather than trusting the inline figure.
        const { fetchSettledCostUsd } = require('./layer1-compass-maps');
        const settled = await fetchSettledCostUsd(runId);
        if (settled.settled) costUsd += settled.costUsd;
        else { costProvisional = true; costUsd += batch.length * job.maxReviews * TRIGGER_THRESHOLDS.fetch.usdPerReview; }
        if (onProgress) onProgress({ done: byPlace.size, total: leads.length });
      } catch (err) {
        console.error(`[layer5] batch failed (${batch.length} places): ${err.message}`);
        // A failed batch leaves those leads without signals; they simply won't match the
        // Phase 2 triggers rather than failing the whole search.
      }
    }
  }

  for (const lead of leads) {
    const hit = lead.placeId ? byPlace.get(lead.placeId) : null;
    deriveSignals(lead, hit ? hit.revs : [], { fullHistory: hit ? hit.fullHistory : false });
    classifyTriggers(lead);
  }

  console.log(`[layer5] signals attached · cost $${costUsd.toFixed(5)}${costProvisional ? ' (partly estimated)' : ''} · ${runIds.length} runs`);
  return { leads, costUsd, costProvisional, runIds };
}

// Filter a lead set down to those matching an active review-signal trigger.
function filterByReviewTriggers(leads, activeTriggers) {
  const wanted = (activeTriggers || []).filter(t => t === 'low-velocity' || t === 'newly-opened');
  if (!wanted.length) return leads;
  return leads.filter(l => wanted.includes(l.primaryTrigger));
}

module.exports = {
  enrichWithReviewSignals,
  estimateReviewSignalsCostUsd,
  filterByReviewTriggers,
  classifyTriggers,
  deriveSignals,
  isLowVelocity,
  isLowVolume,
  isLowRating,
  planFetches,
  REVIEWS_ACTOR_ID,
};
