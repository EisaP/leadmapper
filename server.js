require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

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

// --- Aggregator / directory blocklist ---
// When a business's Google Maps "website" field points to one of these domains, we DO NOT scrape it.
// These sites expose their own platform contacts, not the business's, and scraping them yields junk.
const AGGREGATOR_DOMAINS = [
  // Food delivery
  'talabat.com', 'deliveroo.com', 'deliveroo.co.uk', 'ubereats.com', 'justeat.com', 'just-eat.com', 'just-eat.co.uk',
  'doordash.com', 'grubhub.com', 'zomato.com', 'swiggy.com', 'snackpass.co', 'mrd.com', 'menulog.com.au',
  // Reservations / booking
  'opentable.com', 'opentable.co.uk', 'resy.com', 'thefork.com', 'thefork.co.uk', 'exploretock.com', 'tock.com',
  'sevenrooms.com', 'fresha.com', 'booksy.com', 'treatwell.com', 'treatwell.co.uk', 'mindbodyonline.com',
  'squareup.com', 'book.squareup.com', 'calendly.com', 'setmore.com', 'acuityscheduling.com',
  // Directories / review sites
  'yelp.com', 'yelp.co.uk', 'tripadvisor.com', 'tripadvisor.co.uk', 'tripadvisor.co.in',
  // Link-in-bio tools
  'linktree.com', 'linktr.ee', 'beacons.ai', 'bio.site', 'taplink.at', 'flowpage.com', 'allmylinks.com',
  // Social + misc (never treat a social link as the business site for scraping)
  'facebook.com', 'fb.me', 'instagram.com', 'instagr.am', 'wa.me', 'api.whatsapp.com', 'tiktok.com',
  'google.com', 'maps.google.com', 'goo.gl', 'bit.ly', 'tinyurl.com'
];
function isAggregatorDomain(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return AGGREGATOR_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

// Known junk / platform Instagram handles — never attribute these to a business lead
const JUNK_IG_HANDLES = new Set([
  // Aggregator brands
  'talabat', 'talabatqatar', 'talabatksa', 'talabatuae', 'talabategypt', 'talabatbahrain', 'talabatkuwait', 'talabatoman',
  'deliveroo', 'deliveroo_uk', 'deliveroo_ae', 'deliveroo_fr', 'deliveroo_it', 'deliveroo_es', 'deliveroo_hk',
  'ubereats', 'ubereatsapp', 'uber', 'doordash', 'grubhub', 'justeat', 'justeatuk', 'menulog',
  'opentable', 'resy', 'fresha', 'booksy', 'treatwell', 'mindbody',
  'yelp', 'tripadvisor', 'zomato', 'swiggy', 'thefork', 'thefork_uk',
  // Platforms / tools
  'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'twitter', 'whatsapp',
  'shopify', 'shopifypartners', 'wix', 'wixmyway', 'squarespace', 'godaddy', 'mailchimp', 'wordpress',
  'linktree', 'beaconsai', 'biosite', 'stripe'
]);

// Normalize strings for fuzzy comparison (lowercase, strip non-alphanum)
function normForMatch(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function handleMatchesBusiness(handle, businessName) {
  const h = normForMatch(handle);
  const b = normForMatch(businessName);
  if (!h || !b || h.length < 3) return false;
  if (b.includes(h) && h.length >= 4) return true;
  if (h.includes(b) && b.length >= 4) return true;
  // First significant word of business
  const words = (businessName || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const firstMeaningful = words.find(w => w.length >= 4 && !['cafe','coffee','restaurant','salon','bar','hair','shop','the','and'].includes(w));
  if (firstMeaningful && h.includes(firstMeaningful)) return true;
  return false;
}

// --- Email / Phone / Instagram / Booking platform enrichment ---
async function enrichLead(websiteUrl, businessName) {
  const empty = { email: '', phone: '', instagram: '', booking: '', isAggregator: false };
  if (!websiteUrl) return empty;

  // If the website field is an aggregator/directory, DO NOT scrape it — it'll return the platform's contacts, not the business's.
  if (isAggregatorDomain(websiteUrl)) {
    // Still try to extract IG handle if the website URL IS literally an instagram.com/handle (reliable signal: business's own IG).
    const igDirect = websiteUrl.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
    const directHandle = igDirect ? igDirect[1].toLowerCase() : '';
    const igIgnore = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'terms', 'privacy', 'directory', 'static', 'share']);
    const goodDirect = directHandle && !igIgnore.has(directHandle) && !JUNK_IG_HANDLES.has(directHandle) ? directHandle : '';
    return { ...empty, instagram: goodDirect, isAggregator: true };
  }

  // Legitimate business website — scrape with care
  const emails = new Set();
  const phones = new Set();
  const bookings = new Set();
  const igCandidates = []; // {handle, score}

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const ignoreEmails = /\.(png|jpg|jpeg|gif|svg|css|js|ico|webp|woff)$/i;
  const junkDomains = /(@example\.com|@domain\.com|@test\.com|@localhost|@email\.com|@yoursite\.com|@yourdomain\.com|@.*sentry\.io|@wixpress\.com|@mailinator\.com|@placeholder\.com|noreply@|no-reply@|donotreply@)/i;
  const igRegex = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/gi;
  const igIgnore = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'terms', 'privacy', 'directory', 'static', 'share']);
  // Booking platforms
  const bookingPlatforms = [
    { name: 'OpenTable',  re: /opentable\.com/i }, { name: 'Resy', re: /resy\.com/i },
    { name: 'Tock',       re: /exploretock\.com|(?<![a-z])tock\.com/i }, { name: 'SevenRooms', re: /sevenrooms\.com/i },
    { name: 'Fresha',     re: /fresha\.com/i }, { name: 'Booksy', re: /booksy\.com/i },
    { name: 'Treatwell',  re: /treatwell\./i }, { name: 'Mindbody', re: /mindbodyonline\.com/i },
    { name: 'Square',     re: /squareup\.com\/appointments|book\.squareup\.com/i },
    { name: 'Calendly',   re: /calendly\.com/i }, { name: 'Setmore', re: /setmore\.com/i },
    { name: 'Acuity',     re: /acuityscheduling\.com/i },
  ];

  // Direct Instagram handle from website field (reliable)
  const igDirect = websiteUrl.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
  if (igDirect) {
    const h = igDirect[1].toLowerCase();
    if (!igIgnore.has(h) && !JUNK_IG_HANDLES.has(h)) igCandidates.push({ handle: h, score: 1000 }); // direct wins
  }

  const pagesToTry = [
    websiteUrl,
    websiteUrl.replace(/\/$/, '') + '/contact',
    websiteUrl.replace(/\/$/, '') + '/contact-us',
    websiteUrl.replace(/\/$/, '') + '/about',
  ];

  for (const pageUrl of pagesToTry) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(pageUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHunter/1.0)', 'Accept': 'text/html' },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      if (!resp.ok) continue;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;
      const html = await resp.text();

      // Emails
      (html.match(emailRegex) || []).forEach(e => {
        if (!ignoreEmails.test(e) && !junkDomains.test(e)) emails.add(e.toLowerCase());
      });

      // Phones from tel: links
      (html.match(/href=["']tel:([^"']+)["']/gi) || []).forEach(t => {
        const num = t.replace(/href=["']tel:/i, '').replace(/["']/g, '').trim();
        if (num.length >= 7) phones.add(num);
      });

      // Instagram handles — collect candidates with context scoring
      let igMatch;
      while ((igMatch = igRegex.exec(html)) !== null) {
        const handle = igMatch[1].toLowerCase();
        if (igIgnore.has(handle) || JUNK_IG_HANDLES.has(handle)) continue;
        // Context: 300 chars around the link
        const start = Math.max(0, igMatch.index - 300);
        const end = Math.min(html.length, igMatch.index + igMatch[0].length + 300);
        const ctx = html.slice(start, end).toLowerCase();
        let score = 0;
        if (/<footer|footer[>"\s]|class=["'][^"']*footer/.test(ctx)) score += 15;
        if (/social|follow us|our instagram|find us on|connect with us|follow me/.test(ctx)) score += 12;
        // If link text near it mentions "instagram"
        if (/>\s*instagram\s*</i.test(ctx)) score += 8;
        // Later in document = more likely footer
        if (igMatch.index > html.length * 0.6) score += 4;
        // Fuzzy match against business name
        if (handleMatchesBusiness(handle, businessName)) score += 40;
        // Penalize very short / numeric-only handles
        if (handle.length < 4) score -= 8;
        igCandidates.push({ handle, score });
      }

      // Booking platforms (only on the business's own site)
      bookingPlatforms.forEach(bp => { if (bp.re.test(html)) bookings.add(bp.name); });

      // Early exit once we have good coverage
      if (emails.size > 0 && igCandidates.length > 0) break;
    } catch {
      continue;
    }
  }

  // Pick best Instagram handle: highest score, with dedupe
  const byHandle = new Map();
  for (const c of igCandidates) {
    const prev = byHandle.get(c.handle);
    if (!prev || c.score > prev.score) byHandle.set(c.handle, c);
  }
  const bestIg = [...byHandle.values()].sort((a, b) => b.score - a.score)[0];
  // Only accept if score is positive (filters out weakly-linked random handles)
  const instagram = bestIg && bestIg.score > 0 ? bestIg.handle : '';

  return {
    email:     [...emails][0] || '',
    phone:     [...phones][0] || '',
    instagram,
    booking:   [...bookings].join(', '),
    isAggregator: false,
  };
}

// --- ROUTES ---

// Helper: pull the last N searches for the recent-searches sidebar
function getRecentSearches(n = 5) {
  return dbList('search:')
    .map(s => ({ key: s.key, ...s.value }))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, n)
    .map(s => ({ key: s.key, keyword: s.keyword, city: s.city, state: s.state, resultCount: s.resultCount, date: s.date }));
}

// Search page (GET — empty form, optionally pre-populated from URL query for deep linking)
app.get('/', (req, res) => {
  // If URL has search params, render them into the form without running a search
  const hasParams = Object.keys(req.query).length > 0;
  const query = hasParams ? req.query : null;
  res.render('search', { results: null, totalScraped: 0, query, error: null, recentSearches: getRecentSearches() });
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
      recentSearches: getRecentSearches()
    });
  }
  if (!SERPAPI_KEY) {
    return res.render('search', {
      results: null, totalScraped: 0,
      query: null,
      error: 'SERPAPI_KEY not set. Add it to your .env or Secrets.',
      recentSearches: getRecentSearches()
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
    if (enrich) {
      console.log(`[enrich] Enriching ${filteredResults.length} leads...`);
      const BATCH_SIZE = 5;
      for (let i = 0; i < filteredResults.length; i += BATCH_SIZE) {
        const batch = filteredResults.slice(i, i + BATCH_SIZE);
        const enrichments = await Promise.all(
          batch.map(r => enrichLead(r.website, r.title))
        );
        enrichments.forEach((enriched, j) => {
          const idx = i + j;
          // Propagate aggregator flag (either mapped-time detection or enrichLead's determination)
          if (enriched.isAggregator) filteredResults[idx].isAggregator = true;
          if (enriched.email) filteredResults[idx].email = enriched.email;
          if (enriched.phone && !filteredResults[idx].phone) filteredResults[idx].phone = enriched.phone;
          // Only overwrite IG if scraping returned a handle. For aggregator sites, enrichLead only returns IG if the website field IS instagram.com/handle directly.
          if (enriched.instagram && !filteredResults[idx].instagram) {
            filteredResults[idx].instagram = enriched.instagram;
            filteredResults[idx].instagramSource = 'website';
          }
          if (enriched.booking) filteredResults[idx].booking = enriched.booking;
        });
        console.log(`[enrich] Batch ${Math.floor(i / BATCH_SIZE) + 1} done (${Math.min(i + BATCH_SIZE, filteredResults.length)}/${filteredResults.length})`);
      }
      const emailCount = filteredResults.filter(r => r.email).length;
      console.log(`[enrich] Found emails for ${emailCount}/${filteredResults.length} leads`);
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

      // Enrichment quality score (0–100) — weighted by field value
      // email 25 · phone 25 · instagram 25 · website 15 · owner name 10 (when available)
      let score = 0;
      if (r.email) score += 25;
      if (r.phone) score += 25;
      if (r.instagram) score += 25;
      if (r.website) score += 15;
      if (r.ownerName) score += 10; // placeholder for future owner-name extraction
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
      recentSearches: getRecentSearches()
    });

  } catch (err) {
    console.error('[search] Error:', err.message);
    let errorMsg = 'Search failed: ' + (err.message || 'Unknown error');
    if (err.message.includes('401')) errorMsg = 'Invalid SerpAPI key. Check your SERPAPI_KEY.';
    if (err.message.includes('429')) errorMsg = 'SerpAPI rate limit reached. Try again in a moment.';
    res.render('search', { results: null, totalScraped: 0, query: null, error: errorMsg, recentSearches: getRecentSearches() });
  }
}

// --- History ---
app.get('/history', (req, res) => {
  const searches = dbList('search:')
    .map(s => ({ key: s.key, ...s.value }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.render('history', { searches });
});

app.get('/history/:key', (req, res) => {
  const data = dbGet(req.params.key);
  if (!data) return res.redirect('/history');
  res.render('search', {
    results: data.results,
    totalScraped: data.totalScraped || data.results.length,
    query: { keyword: data.keyword, city: data.city, state: data.state, outreachPriority: data.outreachPriority || 'phone-first', searchString: data.query },
    error: null
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
  res.render('leads', { leads });
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
