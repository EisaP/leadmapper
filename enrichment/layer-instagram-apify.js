// Apify Instagram Profile Scraper — replaces the old SerpAPI Google-snippet follower
// extraction. Inputs: a list of leads (some with `instagram` handles set by Layer 2's
// website scrape). Outputs: same array with `instagram_followers` populated for valid
// matches AND with `instagram` cleared for leads whose handle doesn't actually belong
// to that business (catches the Whitebird Coffee → trentsvineyard class of bug).

const { client, hasToken } = require('./apify-client');

const INSTAGRAM_ACTOR_ID = 'apify/instagram-profile-scraper';

// Strip @ prefix, full URL prefix, trailing slashes → bare username (lowercased).
function normalizeHandle(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^https?:\/\/(www\.)?instagr\.am\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '')
    .trim()
    .toLowerCase();
}

// Conservative handle-ownership check: at least one ≥3-char word from the business name
// must appear (substring either direction) in the IG profile's full name. Tunable.
function nameOverlaps(businessName, profileFullName) {
  if (!businessName || !profileFullName) return false;
  const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const skipWords = new Set(['the', 'and', 'cafe', 'coffee', 'shop', 'bar', 'restaurant', 'salon', 'studio', 'group', 'company', 'co', 'ltd', 'limited', 'plc']);
  const bizWords = norm(businessName).split(' ').filter(w => w.length >= 3 && !skipWords.has(w));
  const profileText = norm(profileFullName);
  if (!bizWords.length || !profileText) return false;
  return bizWords.some(bw => {
    // Look for direct substring (handles "Whitebird" matching "Whitebird Coffee" or "@whitebirdcafe")
    if (profileText.includes(bw)) return true;
    // Also: a profile word that is a near-prefix of the biz word (4+ char overlap)
    return profileText.split(' ').some(pw => pw.length >= 4 && (bw.includes(pw) || pw.includes(bw)));
  });
}

// Main entry. Mutates `leads` in place AND returns { costUsd, runId, ... } for cost surfacing.
// Never throws — on failure, leaves leads' instagram fields untouched.
async function enrichInstagramViaApify(leads) {
  if (!hasToken) {
    return { costUsd: 0, runId: null, populated: 0, rejected: 0, error: 'APIFY_API_TOKEN not configured' };
  }
  if (!Array.isArray(leads) || leads.length === 0) {
    return { costUsd: 0, runId: null, populated: 0, rejected: 0 };
  }

  // Build per-handle index of leads → so we know which lead(s) get each profile back
  const leadsByHandle = new Map(); // handle -> array of lead refs
  for (const lead of leads) {
    const h = normalizeHandle(lead && lead.instagram);
    if (!h) continue;
    if (!leadsByHandle.has(h)) leadsByHandle.set(h, []);
    leadsByHandle.get(h).push(lead);
  }
  const uniqueHandles = [...leadsByHandle.keys()];
  if (uniqueHandles.length === 0) {
    return { costUsd: 0, runId: null, populated: 0, rejected: 0 };
  }

  const input = {
    usernames: uniqueHandles,
    resultsLimit: 1,        // We want the profile, not the post feed
    addParentData: false,
  };

  let run;
  try {
    run = await client.actor(INSTAGRAM_ACTOR_ID).call(input, { timeout: 180, memory: 512 });
  } catch (err) {
    console.error(`[apify-ig] Actor call failed: ${err.message}`);
    return { costUsd: 0, runId: null, populated: 0, rejected: 0, error: err.message };
  }

  let datasetItems = [];
  try {
    const out = await client.dataset(run.defaultDatasetId).listItems();
    datasetItems = out.items || [];
  } catch (err) {
    console.error(`[apify-ig] Dataset fetch failed: ${err.message}`);
    return { costUsd: run.usageTotalUsd || 0, runId: run.id, populated: 0, rejected: 0, error: err.message };
  }

  // username -> { followers, fullName }
  const profileMap = new Map();
  for (const item of datasetItems) {
    const u = (item.username || '').toString().toLowerCase();
    if (!u) continue;
    profileMap.set(u, {
      followers: item.followersCount != null ? item.followersCount : null,
      fullName:  item.fullName || '',
      isPrivate: !!item.private,
    });
  }

  let populated = 0, rejected = 0, missing = 0;
  for (const [handle, leadArr] of leadsByHandle.entries()) {
    const profile = profileMap.get(handle);
    if (!profile) {
      // Profile didn't come back (404, private, rate-limited, etc.) — leave the handle in place,
      // just skip populating the follower count.
      missing++;
      continue;
    }
    for (const lead of leadArr) {
      const ok = nameOverlaps(lead.title, profile.fullName);
      if (!ok) {
        // Wrong account — strip the handle so it doesn't mislead outreach
        lead.instagramHandleRejected = true;
        lead.instagram = '';
        lead.instagramSource = null;
        lead.instagram_followers = null;
        rejected++;
      } else {
        lead.instagram_followers = profile.followers;
        populated++;
      }
    }
  }

  const costUsd = run.usageTotalUsd != null ? run.usageTotalUsd : 0;
  console.log(`[apify-ig] Run ${run.id} · $${(costUsd || 0).toFixed(4)} · ${uniqueHandles.length} handles · ${populated} populated · ${rejected} rejected (name mismatch) · ${missing} missing`);
  return { costUsd, runId: run.id, populated, rejected, missing, handles: uniqueHandles.length };
}

module.exports = { enrichInstagramViaApify, normalizeHandle, nameOverlaps };
