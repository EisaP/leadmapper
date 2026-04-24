// Layer 3 — Pattern-guessing + SMTP verification.
// When Layer 2 returns no email and the business has a real website domain,
// generate candidate emails (info@, hello@, contact@, {businessname}@ ...) and
// probe them via MX lookup + SMTP handshake.
//
// Built out as a full module in Commit B; stub-only for Commit A (the refactor).

const dns = require('dns').promises;
const net = require('net');
const { isAggregatorDomain, rootDomain, normForMatch } = require('./utils/domain-utils');
const { classifyEmail } = require('./utils/email-classifier');

// Per-domain rate-limit cache. If a domain blocks us (4xx/5xx repeatedly, connection reset, etc.),
// we skip future SMTP probes on that domain for 24 hours.
const RATE_LIMITED = new Map(); // domain -> expiresAtMs
const RATE_LIMIT_TTL_MS = 24 * 60 * 60 * 1000;

function isRateLimited(domain) {
  const exp = RATE_LIMITED.get(domain);
  if (!exp) return false;
  if (Date.now() > exp) { RATE_LIMITED.delete(domain); return false; }
  return true;
}
function markRateLimited(domain) { RATE_LIMITED.set(domain, Date.now() + RATE_LIMIT_TTL_MS); }

// Generate candidate emails for a domain in priority tiers.
function generateCandidates(domain, businessName) {
  const nameSlug = normForMatch(businessName || '').slice(0, 20);
  const tierA = ['info', 'hello', 'contact', 'enquiries'];
  const tierB = nameSlug && nameSlug.length >= 3 ? [nameSlug, 'owner', 'manager'] : ['owner', 'manager'];
  const tierC = ['inquiry', 'office', 'reception'];
  return {
    A: tierA.map(l => `${l}@${domain}`),
    B: tierB.map(l => `${l}@${domain}`),
    C: tierC.map(l => `${l}@${domain}`),
  };
}

// MX lookup — returns the preferred MX host, or null if no MX records exist.
async function getPreferredMx(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || !records.length) return null;
    records.sort((a, b) => a.priority - b.priority);
    return records[0].exchange;
  } catch { return null; }
}

// SMTP probe — RCPT TO the candidate against the domain's MX server.
// Returns { ok: true|false, code: nnn, reason: string, blocked: bool }.
// `blocked` means we got a disconnect/timeout/temp-fail — caller should skip further probes on this domain.
function smtpProbe(mxHost, fromAddr, toAddr, timeoutMs = 8000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; try { socket.end(); } catch {} resolve(res); } };
    const socket = net.createConnection(25, mxHost);
    socket.setTimeout(timeoutMs);
    let stage = 'connect';
    let buf = '';

    const send = (line) => { try { socket.write(line + '\r\n'); } catch {} };

    socket.on('connect', () => {});
    socket.on('timeout', () => finish({ ok: false, code: 0, reason: 'timeout', blocked: true }));
    socket.on('error', (e) => finish({ ok: false, code: 0, reason: 'socket-error: ' + (e && e.code), blocked: true }));
    socket.on('close', () => finish({ ok: false, code: 0, reason: 'closed-before-reply', blocked: true }));
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      // Multi-line responses: last line starts with digits+space
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      const m = last.match(/^(\d{3})\s/);
      if (!m) return; // still reading
      const code = parseInt(m[1], 10);
      buf = '';

      if (stage === 'connect') {
        if (code !== 220) return finish({ ok: false, code, reason: 'banner-' + code, blocked: code >= 400 });
        stage = 'helo';
        send('HELO verify.leadhunter.local');
      } else if (stage === 'helo') {
        if (code !== 250) return finish({ ok: false, code, reason: 'helo-' + code, blocked: code >= 400 });
        stage = 'mail';
        send(`MAIL FROM:<${fromAddr}>`);
      } else if (stage === 'mail') {
        if (code !== 250) return finish({ ok: false, code, reason: 'mail-' + code, blocked: code >= 400 });
        stage = 'rcpt';
        send(`RCPT TO:<${toAddr}>`);
      } else if (stage === 'rcpt') {
        if (code >= 200 && code < 300) return finish({ ok: true, code, reason: 'rcpt-accepted', blocked: false });
        if (code === 450 || code === 451 || code === 421 || code === 552) return finish({ ok: false, code, reason: 'rcpt-tempfail-' + code, blocked: true });
        // 5xx = recipient rejected
        return finish({ ok: false, code, reason: 'rcpt-rejected-' + code, blocked: false });
      }
    });
  });
}

// Semaphore — caps concurrent SMTP probes at N.
class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise(res => this.queue.push(res));
    this.n--;
  }
  release() { this.n++; const next = this.queue.shift(); if (next) next(); }
}
const smtpSemaphore = new Semaphore(3);

// Per-domain 200ms delay cache
const LAST_HIT = new Map();
async function paceDomain(domain) {
  const last = LAST_HIT.get(domain) || 0;
  const wait = Math.max(0, 200 - (Date.now() - last));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  LAST_HIT.set(domain, Date.now());
}

// Probe one candidate with semaphore, pacing, and rate-limit cache.
async function verifyCandidate(mxHost, fromAddr, candidate, domain) {
  if (isRateLimited(domain)) return { ok: false, reason: 'rate-limited-cache', blocked: true };
  await smtpSemaphore.acquire();
  try {
    await paceDomain(domain);
    const res = await smtpProbe(mxHost, fromAddr, candidate);
    if (res.blocked) markRateLimited(domain);
    return res;
  } finally {
    smtpSemaphore.release();
  }
}

// Detect catch-all: probe a clearly-fake address. If it "verifies", the domain accepts everything.
async function detectCatchAll(mxHost, fromAddr, domain) {
  const fake = `zz9_leadhunter_catchall_${Date.now().toString(36)}@${domain}`;
  const res = await verifyCandidate(mxHost, fromAddr, fake, domain);
  return res.ok; // true = catch-all
}

// Main Layer 3 entry point.
async function layer3Pattern(lead) {
  const out = {
    email: '', emailRole: '', emailPriority: 0, emails: [],
    email_source: null, email_confidence: null,
  };
  if (!lead || !lead.website) return out;
  if (isAggregatorDomain(lead.website)) return out;

  const domain = rootDomain(lead.website);
  if (!domain) return out;
  if (isRateLimited(domain)) return out;

  // MX lookup — no MX = no mail server to probe, abort.
  const mxHost = await getPreferredMx(domain);
  if (!mxHost) return out;

  const fromAddr = process.env.LEADHUNTER_VERIFY_FROM || 'verify@leadhunter.local';

  // Catch-all detection up front — if true, mark any accepted address as medium confidence.
  let catchAll = false;
  try { catchAll = await detectCatchAll(mxHost, fromAddr, domain); } catch {}

  const tiers = generateCandidates(domain, lead.title);
  const results = [];

  for (const tierKey of ['A', 'B', 'C']) {
    const candidates = tiers[tierKey];
    for (const candidate of candidates) {
      if (isRateLimited(domain)) return out;
      const res = await verifyCandidate(mxHost, fromAddr, candidate, domain);
      if (res.ok) {
        const cls = classifyEmail(candidate, domain);
        if (cls) {
          const confidence = catchAll ? 'medium' : 'high';
          results.push({ ...cls, email_source: 'guessed', email_confidence: confidence });
        }
      }
    }
    if (results.length > 0) break; // short-circuit: stop at first tier that yielded a hit
  }

  if (!results.length) return out;
  results.sort((a, b) => b.priority - a.priority);
  const primary = results[0];
  return {
    email: primary.email,
    emailRole: primary.role,
    emailPriority: primary.priority,
    emails: results,
    email_source: 'guessed',
    email_confidence: primary.email_confidence,
  };
}

module.exports = { layer3Pattern, _internal: { generateCandidates, smtpProbe, isRateLimited, markRateLimited } };
