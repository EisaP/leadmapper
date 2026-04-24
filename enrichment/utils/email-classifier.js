// Email role classification (Tier 1 heuristic — no paid API).
// Maps an email local-part to a role + priority score. See Round 5 brief for the rubric.

const EMAIL_ROLE_RULES = [
  { role: 'REJECT', priority: -1, patterns: ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'root', 'abuse', 'mailer'] },
  { role: 'low-value', priority: 10, patterns: ['returns', 'complaints', 'refunds', 'billing', 'accounts', 'accounting', 'legal', 'privacy', 'gdpr', 'dpo', 'webmaster', 'admin', 'hr', 'jobs', 'careers', 'recruitment', 'recruiting', 'vacancies', 'compliance'] },
  { role: 'customer-service', priority: 20, patterns: ['support', 'help', 'customerservice', 'customer-service', 'customercare', 'customer-care', 'service', 'helpdesk'] },
  { role: 'transactional', priority: 40, patterns: ['bookings', 'booking', 'reservations', 'reservation', 'reserve', 'orders', 'order', 'sales', 'shop', 'store', 'delivery', 'takeaway', 'events'] },
  { role: 'marketing', priority: 70, patterns: ['marketing', 'partnerships', 'partners', 'partner', 'brands', 'brand', 'collabs', 'collab', 'collaboration', 'collaborations', 'pr', 'press', 'media'] },
  { role: 'manager', priority: 80, patterns: ['manager', 'managing', 'head', 'lead', 'operations', 'ops'] },
  { role: 'owner', priority: 90, patterns: ['owner', 'founder', 'ceo', 'director', 'gm', 'principal', 'proprietor', 'mdoffice', 'md'] },
  { role: 'general', priority: 50, patterns: ['info', 'hello', 'hi', 'contact', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'general', 'mail', 'email'] },
];

const REJECTED_EMAIL_DOMAINS = new Set([
  'mail.com', 'example.com', 'domain.com', 'test.com', 'localhost', 'email.com', 'yoursite.com', 'yourdomain.com', 'placeholder.com', 'mailinator.com',
  'sentry.io', 'wixpress.com', 'shopify.com', 'squarespace.com', 'mailchimp.com', 'hubspot.com'
]);

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'yandex.com', 'zoho.com'
]);

function classifyEmail(email, siteDomain) {
  const lower = String(email).toLowerCase().trim();
  const at = lower.lastIndexOf('@');
  if (at < 1) return null;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (!domain || REJECTED_EMAIL_DOMAINS.has(domain)) return null;
  for (const rule of EMAIL_ROLE_RULES) {
    for (const pat of rule.patterns) {
      const re = new RegExp(`^${pat}([._-]|\\d|$)`);
      if (re.test(local)) {
        if (rule.role === 'REJECT') return null;
        return { email: lower, local, domain, role: rule.role, priority: rule.priority, unverifiedDomain: !!(siteDomain && FREE_EMAIL_PROVIDERS.has(domain)) };
      }
    }
  }
  if (/^[a-z]+(\.[a-z]+)?$/.test(local) && local.length >= 2) {
    return { email: lower, local, domain, role: 'named', priority: 100, unverifiedDomain: !!(siteDomain && FREE_EMAIL_PROVIDERS.has(domain)) };
  }
  return { email: lower, local, domain, role: 'other', priority: 30, unverifiedDomain: !!(siteDomain && FREE_EMAIL_PROVIDERS.has(domain)) };
}

module.exports = { classifyEmail, EMAIL_ROLE_RULES, REJECTED_EMAIL_DOMAINS, FREE_EMAIL_PROVIDERS };
