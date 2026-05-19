# LeadHunter — How The Scraper Works

## Overview

LeadHunter searches Google Maps for businesses and enriches each result with
contact details. Data flows through a layered waterfall:

1. **Layer 1 — Maps scrape (Apify Compass)** → name, phone, website, rating, reviews, address
2. **Layer 2 — Website scrape** → email + Instagram handle + booking platform from the business's own site
3. **Layer 3 — Pattern-guess emails** → SMTP-verified `firstname@domain.com` style guesses when Layer 2 returned nothing
4. **Apify Instagram Profile Scraper** → validates each IG handle + populates follower count
5. **Chain detection + tier classification** → flags chain candidates and bins by tier (cached only — see below)

---

## Layer 1: Apify Compass (Google Maps)

**Actor:** `apify/google-maps-scraper` (Compass)
**Client:** `enrichment/layer1-compass-maps.js`
**Cost:** ~$0.004–$0.007 per place. With `maxReviews: 0` and 20 results, a search costs <$0.20.
**Cost gates** (don't remove without reason):
- Default `maxResults` = 20
- `maxReviews` = 0 (was 5, which inflated cost ~10×)
- Client-side `> $0.50` estimate → confirm dialog before submit
- Client + server-side `> $2.00` estimate → blocked unless `?allowExpensive=1`

The Apify run ID is logged for every search. If a search returns leads but the UI
fails to render them, use `/recover-apify-run?runId=<id>&city=<>&state=<>&keyword=<>`
to ingest the already-paid dataset without re-running the actor.

## Required output shape per place

- Business name
- Phone, website, email (Layer 1 returns whatever Maps surfaces; Layer 2/3 fill gaps)
- Category, full address
- Rating + review count
- Google Maps URL

## Chain tier classification (cache-only as of 2026-05)

Chain *detection* still runs on every search (three signals: repeated contact data,
repeated name root, known-chains blocklist). Tier *classification* is currently
cache-only: previously-classified chains keep their stored tier (90-day TTL in
SQLite); uncached chains default to `'local'`. This is a deliberate stopgap —
SerpAPI was retired in May 2026 and tier classification will be replaced by
Layer 3 (Leads Finder) which returns native company-size data.

## Environment variables (Replit Secrets)

| Key | Required | Purpose |
|---|---|---|
| `APIFY_API_TOKEN` | yes | Compass Maps scraper + Instagram Profile scraper |
| `LEADHUNTER_DB_PATH` | optional | Override SQLite location |
| `LEADHUNTER_VERIFY_FROM` | optional | Layer 3 SMTP HELO/MAIL FROM identity |
