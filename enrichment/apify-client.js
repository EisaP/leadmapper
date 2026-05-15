// Shared Apify client. Reads APIFY_API_TOKEN from process.env.
// Token is NEVER logged or surfaced — only its presence is reported at boot.

const { ApifyClient } = require('apify-client');

const token = process.env.APIFY_API_TOKEN;
const hasToken = !!(token && token.trim());

if (!hasToken) {
  console.error('[Apify] APIFY_API_TOKEN not set in environment. Apify-based enrichment paths will fail until it is configured (Replit Secrets → APIFY_API_TOKEN).');
}

const client = new ApifyClient({ token: token || 'missing' });

module.exports = { client, hasToken };
