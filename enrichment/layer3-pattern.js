// Layer 3 — Pattern-guessing + SMTP verification.
// Placeholder stub — full implementation lands in the next commit (Phase B / Section 1.2–1.4).
// For now, always returns "no email found" so the orchestrator waterfall falls through cleanly.

async function layer3Pattern(/* lead */) {
  return {
    email: '',
    emailRole: '',
    emailPriority: 0,
    emails: [],
    email_source: null,
    email_confidence: null,
  };
}

module.exports = { layer3Pattern };
