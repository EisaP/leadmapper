# LeadHunter — context for future Claude Code sessions

Internal lead-generation tool. Scrapes Google Maps via Apify Compass (SerpAPI
was removed in May 2026), enriches each lead with email / phone / Instagram /
follower count, classifies into segments and chain tiers, and displays them in
a CMS-grade UI. GitHub: `EisaP/leadmapper`. Live URL: `https://maps-lead-gen--eisap.replit.app`.

---

## ⚡ Where we left off (as of last session)

**Top of `git log` (after SerpAPI removal pending push):**
- (next) — Remove SerpAPI integration entirely. Apify Compass is sole data
  source. Strips out `serpApiSearch`/`serpApiGoogleSearch`, the `useApify`
  branching, the data-source toggle in search.ejs, the SerpAPI credits stat
  card + column in history.ejs, the Google fallback IG path, and SerpAPI
  comments project-wide. Chain tier classifier reduced to cache-only (uncached
  chains → `'local'`), to be replaced when Layer 3 (Leads Finder) lands.
- `5ccd793` — fix invisible-leads bug (channel checkboxes were hiding results)
- `10b2ab2` — cost protection: maxReviews 0, default 20 results, $2 hard cap,
  pre-flight confirm dialog, `/recover-apify-run` route for paid datasets

**Pending action (user-side):** push the SerpAPI-removal commit to GitHub →
drive Replit Agent to pull the changed files → click **Republish**.

**Notes:**
- `serpapi_credits_used` column is still in the SQLite schema and writes 0 going
  forward (kept to avoid a migration; rename later if useful).
- `SERPAPI_KEY` is no longer read by the app. The Replit Secret can stay in
  place for 7 days as a rollback safety net, then delete + cancel SerpAPI.
- Apify token rotation from the previous session still applies.

**First thing to do in a fresh session:**
1. `git log -5 --oneline` to confirm HEAD matches expected.
2. `curl -s https://maps-lead-gen--eisap.replit.app/ | grep -oE "dataSource|SerpAPI"`
   — if either still appears in the served HTML, the SerpAPI-removal Republish
   hasn't happened yet.
3. Ask the user what they want to work on next.

---

## Where the source lives

- **Local workspace:** `~/Claude/lead-gen-app/` (moved here May 2026 — was at
  `~/Claude Skills/Audience Profiling/lead-gen-app/`).
- **GitHub `main`:** authoritative. Every change goes through commit → push →
  Replit Agent pull → user Republish.
- **Replit workspace:** `https://replit.com/@eisap/maps-lead-gen` — pulled into
  via the Replit Agent. Don't trust workspace state to match GitHub without
  verifying.
- **Deployment:** Replit Autoscale. Build container has an unreliable native
  toolchain — see "Replit constraints" below.

## Current state (latest commits to look at)

- (pending push) — SerpAPI removed entirely; Apify Compass is sole data source.
- `5ccd793` — fix `passesChannels` so leads with no contact info don't get
  hidden by default-checked filters (was the "no leads showing" bug)
- `10b2ab2` — cost protection (`maxReviews 5→0`, default 20, $2 hard cap,
  pre-flight confirm) + `/recover-apify-run?runId=...&city=...&state=...&keyword=...`
  route to ingest already-paid Apify datasets without rerunning the actor
- `9a5c950` — `better-sqlite3` is now optional with an in-memory fallback
  (this is what finally let new code actually deploy on Replit)
- `3cede75` — Apify Compass became the default data source (SerpAPI later removed entirely)
- `a700e21` — `minVal`/`maxVal`/`maxReviewsVal` hoisted to function scope (the
  original ReferenceError that took weeks to surface because deploys were
  silently rolling back to stale builds)

`git log -20 --oneline` is the fastest way to see what changed recently.

## Architecture

```
server.js                       Express routes + handleSearch flow
enrichment/
  apify-client.js               Shared ApifyClient (reads APIFY_API_TOKEN)
  layer1-compass-maps.js        Apify Compass scrape + normalizer + filters + cost cap
  layer-instagram-apify.js      Apify Instagram Profile Scraper + handle ownership check
  layer2-scrape.js              Website scrape (email + IG + booking platforms)
  layer3-pattern.js             Pattern-guess emails + SMTP verify
  layer4-paid-api.js            stub (Phase D)
  layer5-verify.js              stub (Phase D)
  layer5-review-signals.js      Review-date signals: 60d velocity, firstReviewDate,
                                star sentiment. Feeds the Low velocity / Newly opened
                                triggers. PAID + gated — never runs by default.
  orchestrator.js               Layered enrichment waterfall
  chains.js                     Chain detection (3 signals) + tier classification
  utils/
    domain-utils.js             Aggregator blocklist, junk IG handles, fuzzy name match
    email-classifier.js         Role + priority scoring (named / owner / generic / etc.)
db/
  sqlite-store.js               Dual backend: better-sqlite3 OR in-memory shim
  hash.js                       SHA-256 of normalised search params (cache key)
views/
  search.ejs                    Main UI — form, filters, results table, stat cards
  history.ejs                   History page
  leads.ejs                     Saved leads
data/
  known-chains.json             Chain blocklist (Starbucks, Costa, etc.) — committed
  leadhunter.sqlite             SQLite DB if better-sqlite3 loads (gitignored)
  local-db.json                 Legacy JSON DB (gitignored, migrated to SQLite on boot)
```

## Replit constraints

These are the recurring footguns. Internalise them.

1. **Autoscale has no persistent disk + flaky native build toolchain.** The
   `better-sqlite3` install regularly fails to compile during Replit's build
   step. When it fails, Autoscale silently rolls back to the LAST successful
   build, which appears to "succeed" but is running stale code. That's how the
   `minVal` ReferenceError survived multiple rounds of "I shipped a fix"
   without actually reaching production.
   - Mitigation: `db/sqlite-store.js` now falls back to an in-memory store on
     `require('better-sqlite3')` failure. The app boots either way.
   - Trade-off: when the fallback is active, search history + chain-tier cache
     don't persist across container restarts.

2. **Replit's Agent has a `git reset --hard` block.** It cannot do clean
   git checkouts of new branches/commits. The proven workaround: ask Agent
   to raw-download each changed file from GitHub by its commit SHA. Pull
   instructions to Agent should always include the explicit list of changed
   files and a `grep -c` verification command.

3. **Republish does NOT auto-pull from GitHub.** Replit deploys from the
   *workspace state at the moment of clicking Republish*. Workflow is always:
   - Open the Replit project in Chrome and use the **Shell** tab
   - Write the changed files straight into `~/workspace/` (curl from GitHub raw
     if already committed, otherwise write/patch them in the Shell)
   - Verify in the workspace: `grep -c` for change markers, `node --check` the
     JS, then boot on a spare port and `curl` to confirm it renders
   - Stamp `version.json` so `/version` on the live URL proves the Republish
     landed (this is the guard against the silent-rollback failure mode)
   - Tell the user "click Republish" — never click it ourselves; the user has
     standing instructions to be the human in the deploy loop.

   Do NOT route deploys through `git push` + the Replit Agent. That was the old
   workflow; the operator dropped it on 2026-07-20 as unnecessary ceremony.
   Use the Shell, not the Replit code editor — `views/search.ejs` is ~2000
   lines and synthetic keystrokes at that size risk silent corruption.

4. **Replit Agent transcripts retain anything pasted in.** A previous turn
   leaked an Apify token via a curl command pasted to Agent. Always treat the
   Agent chat as a public log. Rotate any credentials that touch it.

## Environment variables (Replit Secrets)

| Key | Required | Purpose |
|---|---|---|
| `APIFY_API_TOKEN` | yes | Compass Maps scraper + Instagram Profile scraper |
| `LEADHUNTER_DB_PATH` | optional | Override SQLite location |
| `LEADHUNTER_VERIFY_FROM` | optional | Layer 3 SMTP HELO/MAIL FROM identity |

Apify is the sole data source. `SERPAPI_KEY` is no longer read; it can stay in
Replit Secrets as a rollback safety net for 7 days, then be deleted.

## Known ceiling — Layer 5 latency (recorded 2026-07-21, not for fixing now)

Layer 5 takes **~40s for 8 leads**. Batches (25 place IDs each) run **serially**, one
`await` per Apify actor call, and each call carries its own container start-up.

Today the **$2 cost cap binds first**: ~117 leads is the most Layer 5 will process before
being refused on cost, so nobody reaches the latency wall in normal use. **If the cap is ever
raised, latency becomes the binding limit before cost does** — a 250-lead search would be
~10 Apify calls end to end, several minutes, and long enough to hit Replit Autoscale's
request timeout.

The fix, when it's needed: run the batches concurrently (`Promise.all` over chunks, with a
small concurrency limit so Apify doesn't rate-limit). Deliberately not done yet — it adds
partial-failure complexity for a limit no current search can reach.

## Cost gates (don't remove without reason)

- Default `maxResults` = 20 (was 100 before the $5 bleed)
- Compass `maxReviews` = 0 (was 5, which inflated cost ~10×)
- Client-side `> $0.50` estimate → confirm dialog before submit
- Client + server-side `> $2.00` estimate → blocked unless `?allowExpensive=1`
- Apify cost shown above the stat cards after every search

## Recovery route (use after a crashed paid run)

```
/recover-apify-run?runId=<id>&city=<city>&state=<country>&keyword=<kw>
```

Pulls the dataset from a completed Apify run by run ID, no new actor call,
no extra charges. Run IDs in Apify Console → Runs.

## Diagnostic logging

Every Compass stage logs how many leads pass it. When leads disappear,
search Replit's Logs tab for `[apify-compass]` lines — they show:

```
[apify-compass] About to call ... · est cost $X.XXXX · N places
[apify-compass] Run <id> completed · actual cost $X.XXXX
[apify-compass] Dataset returned N raw items
[apify-compass] First item keys: title, ...                    ← field-name check
[apify-compass] First item title="..." rating=... reviews=...
[apify-compass] After normalize: N
[apify-compass] After exclude-keywords filter: N (dropped X)
[apify-compass] After rating/maxReviews filter: N (dropped X)
[apify-compass] Final: $X.XXXX · N raw → M after all filters
```

## Open threads (as of May 2026)

- SerpAPI removed entirely (this session). Needs verification on the live URL
  after the Republish click — the served HTML should no longer contain the
  `dataSource` radio or any "SerpAPI" string.
- Chain *tier* classification is now cache-only — uncached chains default to
  `'local'`. To be replaced when Layer 3 (Leads Finder) ships with native
  company-size data.
- `extractFollowers` and IG enrichment cost aren't separated from Compass —
  watch for an "IG enrichment cost: $X" line too.

## Standing rules from the operator (Eisa)

- **Apply changes directly in the Replit Shell.** Never assume Replit pulls
  from GitHub on Republish, and don't make a GitHub push a prerequisite for
  shipping — commit to git only when the user actually asks.
- **Stop at Republish.** The user is the human in the deploy loop — never
  click Republish from the browser automation.
- **Don't propose fixes without evidence.** When a bug recurs, capture the
  actual error/stack trace, grep the codebase, and report findings before
  changing code. The "minVal" episode was a textbook example of the cost of
  jumping to a fix without diagnosis.
- **Cost is real money.** $5 per accidentally-expensive search is meaningful.
  Default to the cheapest config and add explicit confirms before scaling up.
