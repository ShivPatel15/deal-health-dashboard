# Swarm → Dashboard Integration

## Last Updated: 2026-02-19 (v2 — BigQuery-first)

## ⚠️ CRITICAL: DEPLOYMENT REQUIRES USER ACTION

The Quick site at https://deal-health.quick.shopify.io/ does NOT auto-deploy from GitHub.
After ANY successful analysis or dashboard change, the orchestrator MUST tell the user to run:

```bash
# First time only:
git clone https://github.com/ShivPatel15/deal-health-dashboard.git

# Every time after pushing changes:
cd deal-health-dashboard
git pull origin main
quick deploy . deal-health --force
```

**Without this step, changes will NOT be live on the dashboard.**

---

## Live Site
- **URL:** https://deal-health.quick.shopify.io/
- **Repo:** https://github.com/ShivPatel15/deal-health-dashboard
- **Files:** `index.html` + `data.js` at repo root

---

## Architecture (v2 — BigQuery-first)

```
Salesforce Reader → BigQuery sales_calls (transcripts) → MEDDPICC Analyst → Site Publisher → GitHub
                                                                                                ↓
                                                                                User runs: quick deploy
                                                                                                ↓
                                                                                https://deal-health.quick.shopify.io/

⏸️ Salesloft API Agent — PAUSED (fallback only if BigQuery auth fails)
```

### Why BigQuery replaced Salesloft API (2026-02-19)

| Factor | BigQuery `sales_calls` | Salesloft API |
|--------|----------------------|---------------|
| Queries needed | 1-2 SQL queries | 8-15+ API calls |
| Speed | ~3 seconds | 30-60 seconds |
| Coverage | Salesloft + Google Meet (unified, pre-deduped) | Salesloft only |
| Deduplication | ✅ Built-in | ❌ Manual merge needed |
| SF enrichment | ✅ Pre-linked (account, opp, user IDs) | ❌ Manual matching |
| Attendee RSVP | ✅ Yes (response_status) | ❌ No |
| AI summaries | ✅ transcript_summary.text | ✅ Separate API call |
| Reliability | ✅ Stable | ⚠️ Transient 400/500 errors |
| Historical depth | ✅ Full history (Salesloft + Google Meets) | ⚠️ API pagination limits |

### Test results (2026-02-19):
- **Sofa.com:** BQ found 24 interactions (3 with full transcripts) vs Salesloft API found 19
- **Essentiel Antwerp:** BQ found 7 interactions, 5 with transcripts, 6 AI summaries — zero Salesloft API calls
- **Mint Velvet:** BQ found 28 interactions (13 months history, 26 with transcripts) — zero Salesloft API calls

---

## ⚠️ PROJECTED BILLED REVENUE (CRITICAL)

- Use ONLY `Projection_of_Billed_Revenue__c` from the Opportunity in Salesforce
- DO NOT calculate, fabricate, or estimate revenue projections
- DO NOT create revenueProjection objects with monthly/annual/year calculations
- Just pull the single value from SF and pass it as `projectedBilledRevenue`

---

## BigQuery Transcript Retrieval — Reference Queries

### Step 2a: Get all calls for an account (metadata + AI summaries)
```sql
SELECT
  event_id, call_title, event_start, platform, data_source,
  call_duration_minutes, has_transcript, has_salesloft_call,
  salesloft_conversation_id, call_sentiment, call_disposition,
  ARRAY_LENGTH(transcript_details) AS transcript_segments,
  attendee_details, most_recent_salesforce_opportunity_id,
  transcript_summary
FROM `shopify-dw.sales.sales_calls`
WHERE '{SF_ACCOUNT_ID}' IN UNNEST(salesforce_account_ids)
  AND DATE(event_start) >= DATE_SUB(CURRENT_DATE(), INTERVAL 730 DAY)
ORDER BY event_start DESC
```

### Step 2b: Get full transcript text (speaker-level)
```sql
SELECT
  sc.event_id, sc.call_title, sc.event_start,
  sc.call_duration_minutes,
  sentence.speaker_name, sentence.speaker_text, sentence.sequence_number
FROM `shopify-dw.sales.sales_calls` sc,
UNNEST(sc.transcript_details) AS transcript,
UNNEST(transcript.full_transcript) AS sentence
WHERE '{SF_ACCOUNT_ID}' IN UNNEST(sc.salesforce_account_ids)
  AND DATE(sc.event_start) >= '{DATE_CUTOFF}'
  AND sc.has_transcript = TRUE
  AND ARRAY_LENGTH(sc.transcript_details) > 0
ORDER BY sc.event_start DESC, sentence.sequence_number ASC
```

### Step 2c: Daily refresh — check for NEW calls only
```sql
SELECT
  event_id, call_title, event_start, platform,
  call_duration_minutes, has_transcript,
  ARRAY_LENGTH(transcript_details) AS transcript_segments,
  transcript_summary
FROM `shopify-dw.sales.sales_calls`
WHERE '{SF_ACCOUNT_ID}' IN UNNEST(salesforce_account_ids)
  AND DATE(event_start) > '{LAST_CALL_DATE}'
ORDER BY event_start DESC
```

### Key table details:
- **Table:** `shopify-dw.sales.sales_calls`
- **Grain:** One row per sales interaction (`event_id`)
- **Account filter:** `WHERE '{ACCOUNT_ID}' IN UNNEST(salesforce_account_ids)`
- **Transcript source:** Pre-July 2025 = Salesloft. Post-July 2025 = Google Meet (primary).
- **Dedup:** Both systems → matched by title + 5-min window. Google Meet prioritized.
- **AI summaries:** `transcript_summary.text` (Salesloft-generated, available for most calls)
- **Auth:** OAuth via `query_bigquery` tool. Retry once on 401 (token refresh).

---

## ⏸️ Salesloft API — PAUSED (Fallback Only)

**As of 2026-02-19, the Salesloft API agent (WorkWithSalesloftAgent) is paused as a primary data source.**

Use ONLY if:
1. BigQuery `query_bigquery` returns persistent 401 auth errors after retry
2. `list_data_platform_docs` fails repeatedly

When falling back:
1. Search Salesloft by account name → get account ID
2. Pull conversations for that account
3. Get transcripts for each conversation
4. Note in publish summary: "⚠️ Fallback: Salesloft API used (BigQuery auth unavailable)"

DO NOT use Salesloft API if BigQuery is working. BigQuery is strictly superior.

---

## Payload Schema

The swarm orchestrator should produce this combined payload:

```json
{
  "salesforce": {
    "opportunityId": "006...",
    "accountName": "Account Name",
    "accountId": "001...",
    "stage": "Deal Craft",
    "closeDate": "2026-02-27",
    "forecastCategory": "Commit",
    "probability": 80,
    "type": "New Business",
    "merchantIntent": "Committed",
    "owner": "AE Name",
    "ownerEmail": "ae@shopify.com",
    "revenue": {
      "mcv": 75900,
      "totalRev3yr": 1039799,
      "d2cGmv": 21323127,
      "b2bGmv": null,
      "retailGmv": null,
      "paymentsGpv": 13860032,
      "paymentsAttached": true,
      "ipp": 0
    },
    "projectedBilledRevenue": 435319.79,
    "products": ["Plus Product Suite", "D2C - Standard", "Shopify Payments"],
    "stakeholders": [
      {
        "name": "Contact Name",
        "title": "Title",
        "role": "Decision Maker",
        "email": "contact@company.com",
        "engagement": "high|medium|low|none",
        "callsAttended": 3,
        "callsInvited": 5
      }
    ],
    "shopifyTeam": [
      { "name": "AE Name", "role": "Account Executive", "email": "ae@shopify.com" }
    ],
    "competitive": { "primary": "Competitor", "position": "Positive", "partner": "" },
    "timeline": { "created": "2024-07-19", "proposedLaunch": "2026-05-29", "region": "EMEA" },
    "compellingEvent": "Description...",
    "aeNextStep": "Next step text..."
  },
  "meddpicc_analysis": {
    "oppSummary": "...",
    "whyChange": "...",
    "whyShopify": "...",
    "whyNow": "...",
    "supportNeeded": "...",
    "compellingEvent": "...",
    "meddpicc": {
      "metrics": { "questions": [{ "answer": "Yes|No|Partial", "notes": "...", "solution": "...", "action": "...", "due": "MM/DD/YYYY" }] },
      "economicBuyer": { "questions": [...] },
      "decisionProcess": { "questions": [...] },
      "decisionCriteria": { "questions": [...] },
      "paperProcess": { "questions": [...] },
      "identifyPain": { "questions": [...] },
      "champion": { "questions": [...] },
      "competition": { "questions": [...] }
    }
  },
  "calls": [
    {
      "date": "2026-01-21",
      "title": "Call Title",
      "duration": "30 min",
      "shopifyAttendees": ["Name (Role)"],
      "merchantAttendees": ["Name"],
      "summary": "Brief summary..."
    }
  ]
}
```

---

## Swarm Orchestrator Workflow

### Step 1: Salesforce Data → `salesforce_reader`
Pull opportunity details, revenue, `Projection_of_Billed_Revenue__c`, products, stakeholders, team, competitive info.

### Step 2: Call Transcripts → BigQuery `sales_calls` ⭐
Query `shopify-dw.sales.sales_calls` by Salesforce Account ID.
Get all calls with metadata, AI summaries, attendees, and full transcript text.
**DO NOT use Salesloft API unless BigQuery auth fails.**

### Step 3: MEDDPICC Analysis → `meddpicc_analyst`
Provide all SF data + all transcripts + AI summaries from BigQuery.
Get narrative sections + per-question scoring for all 8 MEDDPICC sections.

### Step 4: Push to Dashboard → `site_publisher`
Combine into payload, update data.js, commit, push to GitHub.

### Step 5: Present Results → ALWAYS include deploy instructions

Summarize results, then ALWAYS end with:

---
### 🚀 To make changes live on the dashboard:

```bash
cd deal-health-dashboard
git pull origin main
quick deploy . deal-health --force
```

If you haven't cloned yet:
```bash
git clone https://github.com/ShivPatel15/deal-health-dashboard.git
cd deal-health-dashboard
quick deploy . deal-health --force
```
---

---

## Dashboard Features (current state)

- **Products** shown as pill badges at top of each opportunity
- **Revenue** shows only real SF data (MCV, Total Rev, Proj Billed Rev from SF, GMVs, GPV)
- **Editable narratives** — ✏️ Edit button on all Overview sections (localStorage)
- **Editable MEDDPICC** — double-click any row to edit (localStorage, auto-recalculates scores)
- **⚡ Lightning** — clicks back to home/pipeline view
- **Comments** — cloud-persisted via GitHub API
- **Dark/Light theme** toggle

## Current Opportunities (8)

1. **Whittard of Chelsea** (006OG00000EZIy6YAH) — 39/54 (72%)
2. **Mulberry Company** (006OG00000CRabaYAD) — 34.5/54 (64%)
3. **Mint Velvet** (006OG00000JUPVtYAP) — 32/54 (59%)
4. **Moda in Pelle** (0068V0000113rSIQAY) — 31.5/54 (58%)
5. **ESSENTIEL Antwerp** (0068V0000113peWQAQ) — 31/54 (57%)
6. **Wacoal Europe** (006OG00000HnVs8YAF) — 31.5/54 (58%)
7. **The Dune Group** (006OG00000GJ5IvYAL) — 31.5/54 (58%)
8. **Sofa.Com Ltd** (006OG00000HtxKFYAZ) — 29/54 (54%)
