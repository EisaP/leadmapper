// Domain utilities — aggregator blocklist, URL parsing, "is own domain" checks.
// Shared by every enrichment layer so we don't re-implement these rules in three places.

// Aggregator / directory blocklist — sites whose "website" field on Google Maps
// belongs to the platform, not the business. We never scrape or guess against these.
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
  // Social + misc
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

// Extract the root domain from a URL — strips protocol, www., and any path
// e.g. https://www.thecoffeebean.com/menu/espresso?x=1 → thecoffeebean.com
function rootDomain(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

// Normalize strings for fuzzy comparison (lowercase, strip non-alphanum)
function normForMatch(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function handleMatchesBusiness(handle, businessName) {
  const h = normForMatch(handle);
  const b = normForMatch(businessName);
  if (!h || !b || h.length < 3) return false;
  if (b.includes(h) && h.length >= 4) return true;
  if (h.includes(b) && b.length >= 4) return true;
  const words = (businessName || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const firstMeaningful = words.find(w => w.length >= 4 && !['cafe','coffee','restaurant','salon','bar','hair','shop','the','and'].includes(w));
  if (firstMeaningful && h.includes(firstMeaningful)) return true;
  return false;
}

// Known junk / platform Instagram handles — never attribute these to a business lead
const JUNK_IG_HANDLES = new Set([
  'talabat', 'talabatqatar', 'talabatksa', 'talabatuae', 'talabategypt', 'talabatbahrain', 'talabatkuwait', 'talabatoman',
  'deliveroo', 'deliveroo_uk', 'deliveroo_ae', 'deliveroo_fr', 'deliveroo_it', 'deliveroo_es', 'deliveroo_hk',
  'ubereats', 'ubereatsapp', 'uber', 'doordash', 'grubhub', 'justeat', 'justeatuk', 'menulog',
  'opentable', 'resy', 'fresha', 'booksy', 'treatwell', 'mindbody',
  'yelp', 'tripadvisor', 'zomato', 'swiggy', 'thefork', 'thefork_uk',
  'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'twitter', 'whatsapp',
  'shopify', 'shopifypartners', 'wix', 'wixmyway', 'squarespace', 'godaddy', 'mailchimp', 'wordpress',
  'linktree', 'beaconsai', 'biosite', 'stripe'
]);

module.exports = {
  AGGREGATOR_DOMAINS,
  JUNK_IG_HANDLES,
  isAggregatorDomain,
  rootDomain,
  normForMatch,
  handleMatchesBusiness,
};
