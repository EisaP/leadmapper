# LeadMapper — How The Scraper Works

## Overview

LeadMapper searches Google Maps for businesses and extracts their contact details. It uses a third-party scraping API to pull data from Google Maps, then filters and displays it in the app.

---

## Current Setup: Apify

**What it is:** Apify is a cloud scraping platform. We use their "Google Maps Scraper" actor (ID: `nwua9Gu5YrADL7ZDj`) via their API.

**How it works:**
1. User enters a keyword (e.g. "dentist"), city ("London"), and country ("United Kingdom")
2. Server formats the query as: `"dentist in London, United Kingdom"`
3. Server sends this to Apify's API with the user's API token
4. Apify spins up a scraper that searches Google Maps, scrolls through results, and extracts data
5. Results come back as JSON with: business name, phone, website, email, address, rating, review count, Google Maps URL
6. Server applies filters (rating range, max reviews) and displays results

**Cost:** $5/month free tier. We burned through it during development/testing.

---

## What We Need From Any Replacement API

The scraper API must return these fields per business:
- **Business name**
- **Phone number**
- **Website URL**
- **Email** (nice to have)
- **Category** (e.g. "Dentist", "Coffee Shop")
- **Full address**
- **Rating** (e.g. 4.5 out of 5)
- **Review count** (e.g. 127 reviews)
- **Google Maps URL**

And it must support:
- **Location-specific search** (search within a specific city/country)
- **Result limit** (e.g. return 20, 50, 100, 250, or 500 results)

---

## Alternative APIs to Research

### 1. SerpAPI — Google Maps API
- **Free tier:** 100 searches/month (no card required)
- **Paid:** Starts at $50/month for 5,000 searches
- **Endpoint:** `GET https://serpapi.com/search?engine=google_maps`
- **Key params:** `q` (query), `ll` (lat/lng), `type` (search)
- **Returns:** Business name, address, phone, website, rating, reviews, GPS coords, thumbnail
- **Docs:** https://serpapi.com/google-maps-api
- **Verdict:** Best free option. 100 searches/month is enough to get started.

### 2. Google Places API (Official)
- **Free tier:** $200/month credit (requires card on file, won't charge unless you exceed)
- **Paid:** $32 per 1,000 Text Search requests after free credit
- **Endpoint:** `POST https://places.googleapis.com/v1/places:searchText`
- **Key params:** `textQuery`, `locationBias`, `maxResultCount` (max 20 per request)
- **Returns:** Name, address, phone, website, rating, review count, types, Google Maps URI
- **Limitation:** Max 20 results per request (need pagination for more)
- **Docs:** https://developers.google.com/maps/documentation/places/web-service
- **Verdict:** Most generous free tier. Best for heavy usage. Requires credit card.

### 3. Outscraper — Google Maps API
- **Free tier:** ~100 results free, then pay-as-you-go
- **Paid:** $3 per 1,000 results
- **Endpoint:** REST API with async task model
- **Returns:** Full business data including emails (scraped from websites)
- **Docs:** https://outscraper.com/google-maps-scraper
- **Verdict:** Good for email extraction. Small free tier.

### 4. ValueSERP
- **Free tier:** 100 searches/month
- **Paid:** Starts at $25/month
- **Endpoint:** `GET https://api.valueserp.com/search?engine=google_maps`
- **Returns:** Similar to SerpAPI
- **Docs:** https://www.valueserp.com
- **Verdict:** Similar to SerpAPI but less popular.

### 5. Bright Data (formerly Luminati)
- **Free tier:** Limited trial
- **Paid:** Enterprise pricing
- **Verdict:** Overkill for this use case.

---

## Recommendation

| Priority | API | Why |
|----------|-----|-----|
| **1st** | SerpAPI | Free 100 searches/mo, no card, easy integration |
| **2nd** | Google Places API | $200/mo free credit, most reliable, needs card |
| **3rd** | Outscraper | Includes email scraping, small free tier |

---

## How The Server Code Would Change

The only file that needs updating is `server.js`. Specifically the `/search` route (lines 60-163). The views (search.ejs, history.ejs, leads.ejs) stay exactly the same since they just display the data.

**What changes:**
- Remove `apify-client` dependency
- Add new API's HTTP calls (simple `fetch` requests)
- Map the new API's response format to our existing format (title, phone, website, etc.)

**What stays the same:**
- All filtering logic (rating range, max reviews)
- All UI/views
- History, leads, CSV export
- File-backed database

Estimated rebuild time: ~15 minutes.
