// Layer 4 — Paid email discovery API (Prospeo / Hunter / Snov.io etc.)
// Placeholder stub for Phase D. No network calls yet.
// Reads PROSPEO_API_KEY from process.env. Returns a no-op when the key is missing.

async function layer4PaidApi(/* lead */) {
  if (!process.env.PROSPEO_API_KEY) return { email: '', email_source: null, email_confidence: null, emails: [] };
  // TODO(Phase D): call Prospeo domain-search endpoint, return best-role email.
  return { email: '', email_source: null, email_confidence: null, emails: [] };
}

module.exports = { layer4PaidApi };
