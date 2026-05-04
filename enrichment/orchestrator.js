// Orchestrator — runs enrichment layers in waterfall order.
// Each layer can short-circuit the chain when it returns a confident email.
// Non-email fields (phone, instagram, booking) come from Layer 2 and are never overwritten.
//
// Current waterfall:
//   Layer 2 (scrape) → always run. Returns phone, IG, booking + any emails on the site.
//   Layer 3 (pattern) → run only if Layer 2 yielded no email AND website exists + is not aggregator.
//   Layer 4 (paid API) → stub, Phase D.
//   Layer 5 (verify) → stub, Phase D.

const { layer2Scrape } = require('./layer2-scrape');
const { layer3Pattern } = require('./layer3-pattern');
const { layer4PaidApi } = require('./layer4-paid-api');
const { layer5Verify } = require('./layer5-verify');

async function enrichLead(websiteUrl, businessName, opts = {}) {
  // Pass-through toggles: layer2 honours extractEmails / extractInstagram (skips the page fetch
  // entirely if both are off); the orchestrator gates Layer 3 on useLayer3 + extractEmails.
  const layer2Opts = {
    extractEmails:    opts.extractEmails    !== false,
    extractInstagram: opts.extractInstagram !== false,
  };
  const l2 = await layer2Scrape(websiteUrl, businessName, layer2Opts);

  // If Layer 2 found an email on the site, that's our answer — no further layers needed.
  if (l2.email) return l2;

  // Layer 3 — pattern-guess. Opt-in via opts.useLayer3 (default: true).
  // Also gated on extractEmails — no point pattern-guessing emails the user doesn't want.
  if (opts.useLayer3 !== false && layer2Opts.extractEmails && websiteUrl && !l2.isAggregator) {
    try {
      const l3 = await layer3Pattern({ website: websiteUrl, title: businessName });
      if (l3 && l3.email) {
        return {
          ...l2,
          email: l3.email,
          emailRole: l3.emailRole,
          emailPriority: l3.emailPriority,
          emails: l3.emails,
          email_source: 'guessed',
          email_confidence: l3.email_confidence,
        };
      }
    } catch (err) {
      console.log(`[enrich] Layer 3 error for "${businessName}": ${err.message}`);
    }
  }

  // Layer 4 — paid API (stub, Phase D).
  if (opts.useLayer4) {
    try {
      const l4 = await layer4PaidApi({ website: websiteUrl, title: businessName });
      if (l4 && l4.email) return { ...l2, ...l4 };
    } catch {}
  }

  // Layer 5 — paid verify (stub, Phase D). Not a discovery layer — runs against an already-known email.
  // Would be wired into Layers 3/4 for per-candidate verification upgrades in Phase D.

  return l2;
}

module.exports = { enrichLead };
