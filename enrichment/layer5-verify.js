// Layer 5 — Paid verification API (MillionVerifier / ZeroBounce / NeverBounce).
// Placeholder stub for Phase D. No network calls yet.
// Reads MILLIONVERIFIER_API_KEY from process.env.

async function layer5Verify(email /* string */) {
  if (!process.env.MILLIONVERIFIER_API_KEY) return { verified: null, confidence: null };
  // TODO(Phase D): call MillionVerifier /verifyemail endpoint, return verdict.
  return { verified: null, confidence: null, email };
}

module.exports = { layer5Verify };
