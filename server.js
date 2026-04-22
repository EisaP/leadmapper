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

// --- Email / Phone / Instagram / LinkedIn / Booking platform enrichment ---
async function enrichLead(websiteUrl) {
  if (!websiteUrl) return { email: '', phone: '', instagram: '', linkedin: '', booking: '' };

  const emails = new Set();
  const phones = new Set();
  const instagrams = new Set();
  const linkedins = new Set();
  const bookings = new Set();

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const ignoreEmails = /\.(png|jpg|jpeg|gif|svg|css|js|ico|webp|woff)$/i;
  const junkDomains = /(@example\.com|@domain\.com|@test\.com|@localhost|@email\.com|@yoursite\.com|@yourdomain\.com|@.*sentry\.io|@wixpress\.com|@mailinator\.com|@placeholder\.com|noreply@|no-reply@|donotreply@)/i;
  const igRegex = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/gi;
  const igIgnore = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'terms', 'privacy', 'directory', 'static', 'share']);
  // LinkedIn company or school page
  const liRegex = /linkedin\.com\/(?:company|school|in)\/([a-zA-Z0-9_\-%.]{1,80})\/?/gi;
  // Booking / reservation platforms (case-insensitive substring check)
  const bookingPlatforms = [
    { name: 'OpenTable',  re: /opentable\.com/i },
    { name: 'Resy',       re: /resy\.com/i },
    { name: 'Tock',       re: /exploretock\.com|www\.tock\.com/i },
    { name: 'SevenRooms', re: /sevenrooms\.com/i },
    { name: 'Fresha',     re: /fresha\.com/i },
    { name: 'Booksy',     re: /booksy\.com/i },
    { name: 'Treatwell',  re: /treatwell\./i },
    { name: 'Mindbody',   re: /mindbodyonline\.com/i },
    { name: 'Square',     re: /squareup\.com\/appointments|book\.squareup\.com/i },
    { name: 'Calendly',   re: /calendly\.com/i },
    { name: 'Setmore',    re: /setmore\.com/i },
    { name: 'Acuity',     re: /acuityscheduling\.com/i },
  ];

  // If the listed website IS an Instagram URL, extract handle directly
  const igDirectMatch = websiteUrl.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
  if (igDirectMatch && !igIgnore.has(igDirectMatch[1].toLowerCase())) {
    instagrams.add(igDirectMatch[1].toLowerCase());
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LeadMapper/1.0)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!resp.ok) continue;

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;

      const html = await resp.text();

      // Emails
      const foundEmails = html.match(emailRegex) || [];
      foundEmails.forEach(e => { if (!ignoreEmails.test(e) && !junkDomains.test(e)) emails.add(e.toLowerCase()); });

      // Phones from tel: links (more reliable than raw regex)
      const telLinks = html.match(/href=["']tel:([^"']+)["']/gi) || [];
      telLinks.forEach(t => {
        const num = t.replace(/href=["']tel:/i, '').replace(/["']/g, '').trim();
        if (num.length >= 7) phones.add(num);
      });

      // Instagram handles
      let igMatch;
      while ((igMatch = igRegex.exec(html)) !== null) {
        const handle = igMatch[1].toLowerCase();
        if (!igIgnore.has(handle)) instagrams.add(handle);
      }

      // LinkedIn company / in slugs
      let liMatch;
      while ((liMatch = liRegex.exec(html)) !== null) {
        const slug = liMatch[1].toLowerCase();
        if (slug && slug.length > 1) linkedins.add(slug);
      }

      // Booking platforms
      bookingPlatforms.forEach(bp => { if (bp.re.test(html)) bookings.add(bp.name); });

      if (emails.size > 0 && linkedins.size > 0) break;
    } catch {
      continue;
    }
  }

  return {
    email:     [...emails][0] || '',
    phone:     [...phones][0] || '',
    instagram: [...instagrams][0] || '',
    linkedin:  [...linkedins][0] || '',
    booking:   [...bookings].join(', '),
  };
}

// --- ROUTES ---

// Search page
app.get('/', (req, res) => {
  res.render('search', { results: null, totalScraped: 0, query: null, error: null });
});

// Perform search
app.post('/search', async (req, res) => {
  const { keyword, excludeKeywords, city, state, maxResults, ratingMin, ratingMax, maxReviews, enrichContacts, skipEnrichment, outreachPriority, targetSegment } = req.body;
  // Enrichment is always-on by default; user can opt out via "Skip enrichment" advanced toggle.
  const enrich = skipEnrichment === 'on' ? false : true;

  if (!keyword || !city || !state) {
    return res.render('search', {
      results: null, totalScraped: 0,
      query: null,
      error: 'Please fill in keyword, city, and country/state.'
    });
  }
  if (!SERPAPI_KEY) {
    return res.render('search', {
      results: null, totalScraped: 0,
      query: null,
      error: 'SERPAPI_KEY not set. Add it to your .env or Secrets.'
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
        linkedin: '',
        booking: '',
        hours: hours,
        priceTier: priceTier,
        placeId: item.place_id || '',
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
          batch.map(r => enrichLead(r.website))
        );
        enrichments.forEach((enriched, j) => {
          const idx = i + j;
          if (enriched.email) filteredResults[idx].email = enriched.email;
          if (enriched.phone && !filteredResults[idx].phone) filteredResults[idx].phone = enriched.phone;
          if (enriched.instagram && !filteredResults[idx].instagram) filteredResults[idx].instagram = enriched.instagram;
          if (enriched.linkedin) filteredResults[idx].linkedin = enriched.linkedin;
          if (enriched.booking) filteredResults[idx].booking = enriched.booking;
        });
        console.log(`[enrich] Batch ${Math.floor(i / BATCH_SIZE) + 1} done (${Math.min(i + BATCH_SIZE, filteredResults.length)}/${filteredResults.length})`);
      }
      const emailCount = filteredResults.filter(r => r.email).length;
      console.log(`[enrich] Found emails for ${emailCount}/${filteredResults.length} leads`);
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
      // email 25 · phone 20 · instagram 20 · website 15 · linkedin 10 · hours 5 · price 5
      let score = 0;
      if (r.email) score += 25;
      if (r.phone) score += 20;
      if (r.instagram) score += 20;
      if (r.website) score += 15;
      if (r.linkedin) score += 10;
      if (r.hours) score += 5;
      if (r.priceTier) score += 5;
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
      query: { keyword, excludeKeywords, city, state, maxResults: limit, ratingMin, ratingMax, maxReviews, skipEnrichment, outreachPriority, targetSegment, searchString: keywords.join(', ') + ` in ${city}, ${state}` },
      error: null
    });

  } catch (err) {
    console.error('[search] Error:', err.message);
    let errorMsg = 'Search failed: ' + (err.message || 'Unknown error');
    if (err.message.includes('401')) errorMsg = 'Invalid SerpAPI key. Check your SERPAPI_KEY.';
    if (err.message.includes('429')) errorMsg = 'SerpAPI rate limit reached. Try again in a moment.';
    res.render('search', { results: null, totalScraped: 0, query: null, error: errorMsg });
  }
});

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
  console.log(`LeadMapper running on http://localhost:${PORT}`);
});
