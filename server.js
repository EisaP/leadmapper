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

// --- Email/Phone enrichment ---
async function enrichLead(websiteUrl) {
  if (!websiteUrl) return { email: '', phone: '', instagram: '' };

  const emails = new Set();
  const phones = new Set();
  const instagrams = new Set();

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(?:\+?\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}/g;
  const ignoreEmails = /\.(png|jpg|jpeg|gif|svg|css|js|ico|webp|woff)$/i;
  const junkDomains = /(@example\.com|@domain\.com|@test\.com|@localhost|@email\.com|@yoursite\.com|@yourdomain\.com|@.*sentry\.io|@wixpress\.com|@mailinator\.com|@placeholder\.com|noreply@|no-reply@|donotreply@)/i;
  const igRegex = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/gi;
  const igIgnore = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'terms', 'privacy', 'directory', 'static', 'share']);

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

      // Extract emails
      const foundEmails = html.match(emailRegex) || [];
      foundEmails.forEach(e => {
        if (!ignoreEmails.test(e) && !junkDomains.test(e)) emails.add(e.toLowerCase());
      });

      // Extract phones from tel: links (more reliable than raw regex)
      const telLinks = html.match(/href=["']tel:([^"']+)["']/gi) || [];
      telLinks.forEach(t => {
        const num = t.replace(/href=["']tel:/i, '').replace(/["']/g, '').trim();
        if (num.length >= 7) phones.add(num);
      });

      // Extract Instagram handles from links
      let igMatch;
      while ((igMatch = igRegex.exec(html)) !== null) {
        const handle = igMatch[1].toLowerCase();
        if (!igIgnore.has(handle)) instagrams.add(handle);
      }

      // If we found an email, no need to check more pages
      if (emails.size > 0) break;
    } catch {
      // Timeout or network error — skip this page
      continue;
    }
  }

  return {
    email: [...emails][0] || '',
    phone: [...phones][0] || '',
    instagram: [...instagrams][0] || '',
  };
}

// --- ROUTES ---

// Search page
app.get('/', (req, res) => {
  res.render('search', { results: null, totalScraped: 0, query: null, error: null });
});

// Perform search
app.post('/search', async (req, res) => {
  const { keyword, city, state, maxResults, ratingMin, ratingMax, maxReviews, enrichContacts, outreachPriority } = req.body;

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
  const searchString = `${keyword} in ${city}, ${state}`;

  console.log(`[search] Query: "${searchString}", limit: ${limit}`);
  console.log(`[search] Filters — ratingMin: ${ratingMin}, ratingMax: ${ratingMax}, maxReviews: ${maxReviews}`);

  try {
    // SerpAPI returns ~20 results per page. Paginate to reach the limit.
    // Each page costs 1 search credit.
    let allResults = [];
    let start = 0;
    const perPage = 20;
    const maxPages = Math.ceil(limit / perPage);

    for (let page = 0; page < maxPages; page++) {
      const data = await serpApiSearch(searchString, start);
      const places = data.local_results || [];

      if (places.length === 0) break;

      allResults = allResults.concat(places);
      console.log(`[search] Page ${page + 1}: got ${places.length} results (total: ${allResults.length})`);

      if (allResults.length >= limit) break;
      if (!data.serpapi_pagination || !data.serpapi_pagination.next) break;

      start += perPage;
    }

    // Trim to exact limit
    allResults = allResults.slice(0, limit);
    console.log(`[search] Raw results from SerpAPI: ${allResults.length}`);

    // Map SerpAPI results to our clean format
    const mappedResults = allResults.map(item => {
      // Extract IG handle if website is an Instagram URL
      let ig = '';
      if (item.website) {
        const igMatch = item.website.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
        if (igMatch) ig = igMatch[1].toLowerCase();
      }
      return {
      title: item.title || '',
      phone: item.phone || '',
      website: item.website || '',
      email: '',
      instagram: ig,
      category: item.type || '',
      address: item.address || '',
      city: city,
      state: state,
      rating: item.rating != null ? item.rating : null,
      reviewCount: item.reviews != null ? item.reviews : 0,
      url: item.place_id ? `https://www.google.com/maps/place/?q=place_id:${item.place_id}` : (item.gps_coordinates ? `https://www.google.com/maps?q=${item.gps_coordinates.latitude},${item.gps_coordinates.longitude}` : ''),
      imageUrl: item.thumbnail || ''
    }}).filter(r => r.title);

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

    // Enrich contacts if requested
    if (enrichContacts === 'on') {
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
          if (enriched.phone && !filteredResults[idx].phone) {
            filteredResults[idx].phone = enriched.phone;
          }
          if (enriched.instagram && !filteredResults[idx].instagram) {
            filteredResults[idx].instagram = enriched.instagram;
          }
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
    });

    // Save to search history
    const timestamp = Date.now();
    const searchKey = `search:${timestamp}`;
    dbSet(searchKey, {
      query: searchString,
      keyword, city, state,
      resultCount: filteredResults.length,
      totalScraped: mappedResults.length,
      filters: { ratingMin: minVal, ratingMax: maxVal, maxReviews: maxReviewsVal },
      outreachPriority: outreachPriority || 'phone-first',
      results: filteredResults,
      date: new Date().toISOString()
    });

    res.render('search', {
      results: filteredResults,
      totalScraped: mappedResults.length,
      query: { keyword, city, state, maxResults: limit, ratingMin, ratingMax, maxReviews, enrichContacts, outreachPriority, searchString },
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
