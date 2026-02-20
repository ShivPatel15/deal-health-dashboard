# Swarm → Dashboard Integration

## Last Updated: 2026-02-20 (v2.3 — Single-directory architecture, data safety fixes)

## ⚠️ READ ARCHITECTURE.md FIRST
See `ARCHITECTURE.md` for the single-directory data flow, source of truth rules, safety checks, and emergency restore procedures. That file is the definitive reference for how data moves through the system.

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
- **Working Dir:** `/home/swarm/deal-health-app/` (this IS the git repo)
- **Files:** `index.html` + `data.js` at repo root

---

## Architecture (v2.3 — BigQuery-first, single directory)

```
Salesforce Reader → BigQuery sales_calls (transcripts) → MEDDPICC Analyst
                                                              │
                                                    Orchestrator writes payload
                                                              │
                                                              ▼
                                               data/incoming-payload.json
                                                              │
                                                       ingest-deal.js
                                                       (MERGES into existing)
                                                              │
                                                              ▼
                                               data/opportunities.json  ← SOURCE OF TRUTH
                                                              │
                                                        build-data.js
                                                              │
                                                    ┌─────────┴─────────┐
                                                    ▼                   ▼
                                               data.js       quick-deploy/data.js
                                                    │
                                              git push → GitHub → User clones → quick deploy
                                                                                     │
                                                                                     ▼
                                                            https://deal-health.quick.shopify.io/

⏸️ Salesloft API Agent — PAUSED (fallback only if BigQuery auth fails)
```

**CRITICAL: There is only ONE working directory: `/home/swarm/deal-health-app/`.**
Do NOT create or use `deal-health-site/` or `deal-health-dashboard/` directories.

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

## 🗂️ SALESFORCE OPPORTUNITY FIELD MAPPING (CRITICAL)

**Last verified: 2026-02-20 against live Salesforce org**

Many Opportunity fields have non-obvious API names. Using the wrong name returns null silently.
The Salesforce Reader agent MUST use these exact API names — do NOT guess or use intuitive names.

### ✅ THE CORRECT SOQL QUERY (use this every time)

```soql
SELECT Id, Name, Account.Name, Account.Id, StageName, CloseDate, Probability,
       ForecastCategoryName, Type, Merchant_Intent__c, CreatedDate,
       Amount, eComm_Amount__c, Total_Revenue__c, Projected_Billed_Revenue__c,
       Incremental_Product_Gross_Profit__c,
       Opp_Annual_Online_Revenue_Verified__c,
       Incremental_Annual_B2B__c,
       Opp_Annual_Offline_Revenue__c,
       Payments_GPV__c, Has_Payment_Product__c,
       Compelling_Event__c, SE_Next_Steps__c, NextStep,
       Position_Against_Competitor__c, Competitor__c, Other_Competitor__c,
       Owner.Name, Owner.Email,
       Proposed_Launch_Date_Plus__c, Proposed_Launch_Date_Retail__c,
       Proposed_Launch_Date_B2B__c, Proposed_Launch_Date_Enterprise__c,
       Proposed_Launch_Date_CCS__c,
       Region__c, Business_Problem__c, Partners_Engaged__c
FROM Opportunity
WHERE Id = '{OPPORTUNITY_ID}'
```

### 📋 FIELD MAPPING TABLE

| Dashboard Field | ✅ Correct API Name | ❌ WRONG Names (do NOT use) | Type | Notes |
|----------------|---------------------|---------------------------|------|-------|
| **MCV** | `eComm_Amount__c` | `MCV__c` | Currency | `Amount` (standard) often has same value but `eComm_Amount__c` is the dedicated MCV field |
| **Total Revenue 3yr** | `Total_Revenue__c` | — | Currency (Formula) | Read-only formula field |
| **Projected Billed Revenue** | `Projected_Billed_Revenue__c` | `Projection_of_Billed_Revenue__c` | Currency (Formula) | ⚠️ "Projected" NOT "Projection". **Most important metric.** |
| **D2C GMV** | `Opp_Annual_Online_Revenue_Verified__c` | `D2C_GMV__c` | Currency | Annual online revenue |
| **B2B GMV** | `Incremental_Annual_B2B__c` | `B2B_GMV__c` | Currency | Often null |
| **Retail GMV** | `Opp_Annual_Offline_Revenue__c` | `Retail_GMV__c` | Currency | Annual offline/in-store revenue |
| **Payments GPV** | `Payments_GPV__c` | — | Currency (Formula) | This name IS correct |
| **Payments Attached** | `Has_Payment_Product__c` | `Payments_Attached__c` | Boolean (Formula) | true/false |
| **IPP** | `Incremental_Product_Gross_Profit__c` | `IPP__c` | Currency (Formula) | Label: "Incremental Product Gross Profit". Verified via `describe_object` 2026-02-20 |
| **AE Next Steps** | `NextStep` | `AE_Next_Steps__c`, `Next_Steps__c` | String | Standard Salesforce field (no __c suffix) |
| **SE Next Steps** | `SE_Next_Steps__c` | — | Rich Text Area | Contains HTML — strip tags for display |
| **Compelling Event** | `Compelling_Event__c` | — | String | This name IS correct |
| **Merchant Intent** | `Merchant_Intent__c` | — | Picklist | This name IS correct |
| **Region** | `Region__c` | — | String (Formula) | This name IS correct |
| **Primary Competitor** | `Competitor__c` | `Primary_Competitor__c` | Picklist | e.g., "commercetools" |
| **Competitive Position** | `Position_Against_Competitor__c` | `Competitive_Position__c`, `Competitive_Notes__c` | String | e.g., "Strong - Shopify holds weight..." |
| **Other Competitor** | `Other_Competitor__c` | — | String | Secondary competitor |
| **Partner** | `Partners_Engaged__c` | `Partner__c` | String | SI partner name |
| **Business Problem** | `Business_Problem__c` | — | Long Text Area | MEDDPICC context — useful for analysis |
| **Proposed Launch (Plus)** | `Proposed_Launch_Date_Plus__c` | `Proposed_Launch_Date__c` | Date | There is NO single launch date field |
| **Proposed Launch (Retail)** | `Proposed_Launch_Date_Retail__c` | — | Date | |
| **Proposed Launch (B2B)** | `Proposed_Launch_Date_B2B__c` | — | Date | |
| **Proposed Launch (Enterprise)** | `Proposed_Launch_Date_Enterprise__c` | — | Date | |
| **Proposed Launch (CCS)** | `Proposed_Launch_Date_CCS__c` | — | Date | |

### 📊 ADDITIONAL REVENUE FIELDS (optional but available)

| Field | API Name | Type |
|-------|----------|------|
| D2C Payments GPV | `D2C_Payments_GPV__c` | Currency (Formula) |
| B2B Payments GPV | `B2B_Payments_GPV__c` | Currency (Formula) |
| Retail Payments GPV | `Retail_Payments_GPV__c` | Currency (Formula) |
| Installments iGMV | `Installments_iGMV__c` | Currency (Formula) |
| B2B Revenue | `B2B_Revenue__c` | Currency (Formula) |
| Retail Revenue | `Retail_Revenue__c` | Currency (Formula) |
| Retail Payments Revenue | `Retail_Payments_Revenue__c` | Currency (Formula) |
| Markets GMV | `Markets_GMV__c` | Currency (Formula) |

### 🔀 PAYLOAD MAPPING (SF Field → JSON key)

```
eComm_Amount__c                        → revenue.mcv
Total_Revenue__c                       → revenue.totalRev3yr
Projected_Billed_Revenue__c            → projectedBilledRevenue
Incremental_Product_Gross_Profit__c    → revenue.ipp
Opp_Annual_Online_Revenue_Verified__c  → revenue.d2cGmv
Incremental_Annual_B2B__c             → revenue.b2bGmv
Opp_Annual_Offline_Revenue__c         → revenue.retailGmv
Payments_GPV__c                       → revenue.paymentsGpv
Has_Payment_Product__c                → revenue.paymentsAttached
NextStep                              → aeNextStep
Competitor__c                         → competitive.primary
Position_Against_Competitor__c        → competitive.position
Partners_Engaged__c                   → competitive.partner
```

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

See `ARCHITECTURE.md` for the definitive payload schema with all nesting rules.

Key nesting gotchas (these cause 0/54 scores if wrong):
- Narratives: `meddpicc_analysis.narrative.{oppSummary, whyChange, ...}` (NOT `.narratives`)
- MEDDPICC sections: `meddpicc_analysis.meddpicc.{metrics, economicBuyer, ...}` (NOT `.sections`)
- Revenue: `salesforce.revenue.{mcv, totalRev3yr, d2cGmv, ...}` (camelCase, no underscores)
- `answer` values must be exactly `"Yes"`, `"No"`, or `"Partial"` (case-sensitive)

---

## Swarm Orchestrator Workflow

### Step 1: Salesforce Data → `salesforce_reader`

**USE THIS EXACT DELEGATION MESSAGE** (copy-paste, replace {OPP_ID}):

```
Pull the full opportunity details for ID {OPP_ID}. I need ALL of the following fields with these EXACT API names:

**Core fields:**
- Id, Name, AccountId, Account.Name, StageName, CloseDate, Probability, ForecastCategoryName, Type, CreatedDate
- OwnerId, Owner.Name, Owner.Email

**Revenue fields (exact API names verified via describe_object 2026-02-20):**
- Amount
- eComm_Amount__c (this is MCV)
- Total_Revenue__c
- Projected_Billed_Revenue__c (Projection of Billed Revenue)
- Incremental_Product_Gross_Profit__c (this is IPP)
- Opp_Annual_Online_Revenue_Verified__c (D2C GMV)
- Incremental_Annual_B2B__c (B2B GMV)
- Opp_Annual_Offline_Revenue__c (Retail GMV)
- Payments_GPV__c
- Has_Payment_Product__c (Payments Attached - boolean)

**Deal context fields:**
- NextStep (standard field - AE Next Steps)
- Competitor__c
- Other_Competitor__c
- Position_Against_Competitor__c
- Partners_Engaged__c
- Compelling_Event__c
- Merchant_Intent__c
- Region__c
- Business_Problem__c
- Proposed_Launch_Date_Plus__c
- Proposed_Launch_Date_Retail__c
- Proposed_Launch_Date_B2B__c
- Proposed_Launch_Date_Enterprise__c
- Proposed_Launch_Date_CCS__c

**Also pull:**
1. OpportunityContactRole records (Contact.Name, Contact.Title, Contact.Email, Role, IsPrimary)
2. OpportunityTeamMember records (User.Name, User.Email, TeamMemberRole)
3. OpportunityLineItem records (Product2.Name, Product2.Family, UnitPrice, TotalPrice)

Return all data structured clearly.
```

**Key gotchas (why we use this template):**
- MCV = `eComm_Amount__c` (NOT `MCV__c`)
- D2C GMV = `Opp_Annual_Online_Revenue_Verified__c` (NOT `D2C_GMV__c`)
- B2B GMV = `Incremental_Annual_B2B__c` (NOT `B2B_GMV__c`)
- Retail GMV = `Opp_Annual_Offline_Revenue__c` (NOT `Retail_GMV__c`)
- AE Next Steps = `NextStep` (standard field, NO `__c` suffix)
- Projected Billed Revenue = `Projected_Billed_Revenue__c` (NOT `Projection_of_Billed_Revenue__c`)
- IPP = `Incremental_Product_Gross_Profit__c` (NOT `IPP__c`)
- Payments Attached = `Has_Payment_Product__c` (NOT `Payments_Attached__c`)
- Proposed Launch Date = product-specific fields (NOT a single `Proposed_Launch_Date__c`)

### Step 2: Call Transcripts → BigQuery `sales_calls` ⭐
Query `shopify-dw.sales.sales_calls` by Salesforce Account ID.
Get all calls with metadata, AI summaries, attendees, and full transcript text.
**DO NOT use Salesloft API unless BigQuery auth fails.**

### Step 3: MEDDPICC Analysis → `meddpicc_analyst`
Provide all SF data + all transcripts + AI summaries from BigQuery.
Get narrative sections + per-question scoring for all 8 MEDDPICC sections.

### Step 4: Publish to Dashboard
1. Orchestrator writes payload to `deal-health-app/data/incoming-payload.json` using WorkspaceWrite
2. Orchestrator delegates to Site Publisher with a SHORT message (no JSON in the message):
   ```
   Process the payload at deal-health-app/data/incoming-payload.json
   Account: [Account Name]
   Commit message: "Update deal health: [Account Name] - [date]"
   ```
3. Site Publisher runs: `cd /home/swarm/deal-health-app && bash publish.sh "commit message"`
4. publish.sh runs: ingest → build → git push (single directory, no copies)

**NEVER pass large JSON payloads in the delegation message.** Write to file first.
**NEVER create additional directories.** Everything is in `/home/swarm/deal-health-app/`.

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

## Current Opportunities (12) — as of 2026-02-20

| # | Account | Opp ID | Score | Health | Owner |
|---|---------|--------|-------|--------|-------|
| 1 | **Wacoal Europe** | 006OG00000HnVs8YAF | 43/54 (80%) | 🟢 Good | Adriana Colacicco |
| 2 | **Hawes & Curtis Limited** | 006OG00000FYX8zYAH | 41.5/54 (77%) | 🟢 Good | Maissa Fatte |
| 3 | **Direct Wines Limited** | 006OG00000G28JdYAJ | 40/54 (74%) | 🟡 On-Track | Ben Rees |
| 4 | **The Dune Group** | 006OG00000GJ5IvYAL | 37/54 (69%) | 🟡 On-Track | Ben Rees |
| 5 | **Whittard of Chelsea** | 006OG00000EZIy6YAH | 36.5/54 (68%) | 🟡 On-Track | Ben Rees |
| 6 | **Mulberry Company** | 006OG00000CRabaYAD | 34.5/54 (64%) | 🟡 On-Track | Ben Rees |
| 7 | **Mint Velvet** | 006OG00000JUPVtYAP | 32/54 (59%) | 🟡 On-Track | Ben Rees |
| 8 | **Moda in Pelle** | 0068V0000113rSIQAY | 31.5/54 (58%) | 🟡 On-Track | Ben Rees |
| 9 | **ESSENTIEL Antwerp** | 0068V0000113peWQAQ | 31/54 (57%) | 🟡 On-Track | Adriana Colacicco |
| 10 | **Sofa.Com Ltd** | 006OG00000HtxKFYAZ | 29/54 (54%) | 🟡 On-Track | Ben Rees |
| 11 | **OLIVER BONAS LIMITED** | 006OG00000FHHAHYA5 | 28.5/54 (53%) | 🟡 On-Track | Ben Rees |
| 12 | **Cycle King & Hawk** | 006OG00000Fbj8nYAB | 22/54 (41%) | 🔴 At-Risk | Ben Rees |

---

## Changelog

### v2.3 — 2026-02-20
- **CRITICAL FIX: Single-directory architecture.** Eliminated `deal-health-site/` and `deal-health-dashboard/` directories that caused data loss by drifting out of sync with `deal-health-app/`. Everything now lives in ONE directory: `/home/swarm/deal-health-app/`.
- **build-data.js now writes BOTH** root `data.js` AND `quick-deploy/data.js` (previously only wrote to quick-deploy, causing stale root data.js).
- **publish.sh rewritten** to work from single directory with safety checks (refuses to run if opportunities.json missing or has < 2 opps).
- **Added ARCHITECTURE.md** — definitive reference for data flow, source of truth, safety checks, and emergency restore procedures.
- **Payload nesting documented** — narratives under `.narrative` not `.narratives`, sections under `.meddpicc` not `.sections`.

### v2.2 — 2026-02-20
- **IPP field found:** `Incremental_Product_Gross_Profit__c` exists and is a Currency (Formula) field. Previously documented as "DOES NOT EXIST" — corrected.
- **Full schema verified** via `describe_object('Opportunity')` against live Salesforce org. All 100+ custom fields inspected.
- **Step 1 delegation template added:** Copy-paste message for WorkWithSalesforceReader that lists every field by exact API name. Prevents field name guessing errors.
- **Partners_Engaged__c** added to SOQL query (was missing).
- **Hawes & Curtis** added to dashboard (41.5/54, 🟢 Good Health).
- **Payload mapping** updated to include `Incremental_Product_Gross_Profit__c → revenue.ipp`.

### v2.1 — 2026-02-20
- Fixed SF field mapping errors (MCV, D2C GMV, B2B GMV, Retail GMV, AE Next Steps, Projected Billed Revenue, Payments Attached)
- Added wrong-name columns to field mapping table
- Added payload mapping section

### v2.0 — 2026-02-19
- Replaced Salesloft API with BigQuery `sales_calls` as primary transcript source
- Added BigQuery reference queries
- Paused Salesloft API agent (fallback only)

### v1.0 — 2026-02-18
- Initial swarm integration with Salesloft API + Salesforce Reader
