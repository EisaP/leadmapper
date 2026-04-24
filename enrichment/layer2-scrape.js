// Layer 2 — Website scraping enrichment.
// Fetches the business's homepage + /contact + /contact-us + /about,
// extracts emails, phones, Instagram handles, and booking-platform mentions.
// Emails run through the Tier 1 role classifier; the best (highest-priority) one
// is surfaced as the lead's primary email, while the full classified list is kept
// for the expanded-row detail view.

const { isAggregatorDomain, JUNK_IG_HANDLES, handleMatchesBusiness } = require('./utils/domain-utils');
const { classifyEmail } = require('./utils/email-classifier');

async function layer2Scrape(websiteUrl, businessName) {
  const empty = {
    email: '', emailRole: '', emailPriority: 0, emails: [],
    email_source: null, email_confidence: null,
    phone: '', instagram: '', booking: '', isAggregator: false,
  };
  if (!websiteUrl) return empty;

  // Aggregator websites never get scraped — they return platform contacts, not the business's.
  if (isAggregatorDomain(websiteUrl)) {
    const igDirect = websiteUrl.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
    const directHandle = igDirect ? igDirect[1].toLowerCase() : '';
    const igIgnore = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'terms', 'privacy', 'directory', 'static', 'share']);
    const goodDirect = directHandle && !igIgnore.has(directHandle) && !JUNK_IG_HANDLES.has(directHandle) ? directHandle : '';
    return { ...empty, instagram: goodDirect, isAggregator: true };
  }

  const emails = new Set();
  const phones = new Set();
  const bookings = new Set();
  const igCandidates = [];

  let siteDomain = '';
  try { siteDomain = new URL(websiteUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch {}

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const ignoreEmails = /\.(png|jpg|jpeg|gif|svg|css|js|ico|webp|woff)$/i;
  const igRegex = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/gi;
  const igIgnore = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'terms', 'privacy', 'directory', 'static', 'share']);
  const bookingPlatforms = [
    { name: 'OpenTable',  re: /opentable\.com/i }, { name: 'Resy', re: /resy\.com/i },
    { name: 'Tock',       re: /exploretock\.com|(?<![a-z])tock\.com/i }, { name: 'SevenRooms', re: /sevenrooms\.com/i },
    { name: 'Fresha',     re: /fresha\.com/i }, { name: 'Booksy', re: /booksy\.com/i },
    { name: 'Treatwell',  re: /treatwell\./i }, { name: 'Mindbody', re: /mindbodyonline\.com/i },
    { name: 'Square',     re: /squareup\.com\/appointments|book\.squareup\.com/i },
    { name: 'Calendly',   re: /calendly\.com/i }, { name: 'Setmore', re: /setmore\.com/i },
    { name: 'Acuity',     re: /acuityscheduling\.com/i },
  ];

  // Direct Instagram handle from the website field (most reliable)
  const igDirect = websiteUrl.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{1,30})\/?/i);
  if (igDirect) {
    const h = igDirect[1].toLowerCase();
    if (!igIgnore.has(h) && !JUNK_IG_HANDLES.has(h)) igCandidates.push({ handle: h, score: 1000 });
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

      (html.match(emailRegex) || []).forEach(e => {
        if (ignoreEmails.test(e)) return;
        emails.add(e.toLowerCase());
      });

      (html.match(/href=["']tel:([^"']+)["']/gi) || []).forEach(t => {
        const num = t.replace(/href=["']tel:/i, '').replace(/["']/g, '').trim();
        if (num.length >= 7) phones.add(num);
      });

      let igMatch;
      while ((igMatch = igRegex.exec(html)) !== null) {
        const handle = igMatch[1].toLowerCase();
        if (igIgnore.has(handle) || JUNK_IG_HANDLES.has(handle)) continue;
        const start = Math.max(0, igMatch.index - 300);
        const end = Math.min(html.length, igMatch.index + igMatch[0].length + 300);
        const ctx = html.slice(start, end).toLowerCase();
        let score = 0;
        if (/<footer|footer[>"\s]|class=["'][^"']*footer/.test(ctx)) score += 15;
        if (/social|follow us|our instagram|find us on|connect with us|follow me/.test(ctx)) score += 12;
        if (/>\s*instagram\s*</i.test(ctx)) score += 8;
        if (igMatch.index > html.length * 0.6) score += 4;
        if (handleMatchesBusiness(handle, businessName)) score += 40;
        if (handle.length < 4) score -= 8;
        igCandidates.push({ handle, score });
      }

      bookingPlatforms.forEach(bp => { if (bp.re.test(html)) bookings.add(bp.name); });

      if (emails.size > 0 && igCandidates.length > 0) break;
    } catch {
      continue;
    }
  }

  // Pick best Instagram handle
  const byHandle = new Map();
  for (const c of igCandidates) {
    const prev = byHandle.get(c.handle);
    if (!prev || c.score > prev.score) byHandle.set(c.handle, c);
  }
  const bestIg = [...byHandle.values()].sort((a, b) => b.score - a.score)[0];
  const instagram = bestIg && bestIg.score > 0 ? bestIg.handle : '';

  // Classify + sort all extracted emails
  const classifiedEmails = [];
  for (const e of emails) {
    const cls = classifyEmail(e, siteDomain);
    if (cls) classifiedEmails.push(cls);
  }
  const emailByAddr = new Map();
  for (const c of classifiedEmails) {
    if (!emailByAddr.has(c.email)) emailByAddr.set(c.email, c);
  }
  const sortedEmails = [...emailByAddr.values()].sort((a, b) => b.priority - a.priority);
  const primary = sortedEmails[0] || null;

  return {
    email:         primary ? primary.email : '',
    emailRole:     primary ? primary.role : '',
    emailPriority: primary ? primary.priority : 0,
    emails:        sortedEmails,
    email_source:  primary ? 'website' : null,
    email_confidence: primary ? 'high' : null,   // Scraped-from-site = high confidence
    phone:         [...phones][0] || '',
    instagram,
    booking:       [...bookings].join(', '),
    isAggregator:  false,
  };
}

module.exports = { layer2Scrape };
