# Deal Health Dashboard — Workflow & Architecture

## Last Updated: 2026-02-20

---

## LIVE SITE
- **URL:** https://deal-health.quick.shopify.io/
- **Repo:** https://github.com/ShivPatel15/deal-health-dashboard
- **Deploy method:** `quick deploy . deal-health --force` (must be run from Shiv's local machine)

---

## CURRENT OPPORTUNITIES ON DASHBOARD (8)

| # | Account | Opp ID | Score | Owner | Close |
|---|---------|--------|-------|-------|-------|
| 1 | Whittard of Chelsea | 006OG00000EZIy6YAH | 39/54 (72%) | Adriana Colacicco | Feb 27 |
| 2 | Mulberry Company (Sales) Limited | 006OG00000CRabaYAD | 34.5/54 (64%) | Ben Rees | Feb 28 |
| 3 | Mint Velvet | 006OG00000JUPVtYAP | 32/54 (59%) | Ben Rees | Mar 27 |
| 4 | Moda in Pelle | 0068V0000113rSIQAY | 31.5/54 (58%) | Adriana Colacicco | Feb 27 |
| 5 | ESSENTIEL Antwerp | 0068V0000113peWQAQ | 31/54 (57%) | Ben Rees | Mar 16 |
| 6 | Wacoal Europe | 006OG00000HnVs8YAF | 31.5/54 (58%) | Maissa Fatte | Feb 28 |
| 7 | The Dune Group | 006OG00000GJ5IvYAL | 37/54 (69%) | Adriana Colacicco | Feb 27 |
| 8 | Sofa.Com Ltd | 006OG00000HtxKFYAZ | 29/54 (54%) | Maissa Fatte | Mar 26 |

⚠️ **Simon Jersey (0068V00001DEMO02) is a DEMO record — do NOT include it. It was removed on 2026-02-18.**

---

## SWARM ARCHITECTURE

```
Deal Health Live (v3 — Optimized pipeline, 2026-02-19)
├── 🎯 Deal Health Orchestrator (lead)
│   ├── Step 1: Salesforce Reader — CRM data
│   ├── Step 2: BigQuery sales_calls — transcripts + attendees ⭐ PRIMARY
│   │   └── Table: shopify-dw.sales.sales_calls
│   │   └── Combines: Salesloft calls + Google Meet transcripts (pre-deduped)
│   │   └── Includes: attendee details, SF enrichment, AI summaries
│   ├── Step 3: MEDDPICC Analyst — analysis on full corpus
│   ├── Step 4a: Orchestrator writes payload to incoming-payload.json (WorkspaceWrite)
│   └── Step 4b: Site Publisher — runs publish.sh (ONE command: ingest → build → push)
│
│   ⏸️ PAUSED: SE Salesloft Agent (WorkWithSalesloftAgent)
│   └── Only use as FALLBACK if BigQuery auth fails
│   └── Previously: primary transcript source (replaced 2026-02-19)
```

### ⚡ Pipeline Optimizations (v3, 2026-02-19)
1. **Payload written to file by orchestrator** — no large JSON passed through delegation messages (eliminates JSON truncation errors)
2. **publish.sh single-command pipeline** — ingest + build + git push in ONE bash call (eliminates 5-7 sequential LLM turns)
3. **Symlink fix** — `deal-health-site/data/` → `deal-health-app/data/` so build-data.js works from both directories
4. **Site Publisher simplified** — just runs `bash publish.sh "commit message"`, no manual file handling

---

## TWO TYPES OF WORK

### 1. Adding New Opportunities
When user provides a Salesforce Opportunity ID, run the full pipeline:
- Step 1: Salesforce → Step 2: BigQuery sales_calls → Step 3: MEDDPICC → Step 4: Build & Push

### 2. UX/Dashboard Changes
When user requests visual or functional changes to the dashboard:
- Edit `deal-health-site/index.html` directly
- Copy to `deal-health-dashboard/index.html`
- Git commit & push

**Both types always end with cloning the repo and pushing to GitHub.**

---

## ADDING A NEW OPPORTUNITY — FULL PIPELINE

### Step 1: Gather Salesforce Data
- Delegate to **WorkWithSalesforceReader**
- Request ALL fields:
  - Account name, Account ID, close date, stage, probability, forecast category
  - Opportunity type, merchant intent, owner name/email
  - Revenue: Amount, eComm_Amount__c (MCV), Total_Revenue__c, Opp_Annual_Online_Revenue_Verified__c (D2C GMV), Incremental_Annual_B2B__c (B2B GMV), Opp_Annual_Offline_Revenue__c (Retail GMV), Payments_GPV__c, Incremental_Product_Gross_Profit__c (IPP), Has_Payment_Product__c (Payments Attached)
  - **Projected_Billed_Revenue__c** (critical — note: "Projected" not "Projection")
  - Products (OpportunityLineItem — name, code, price)
  - Stakeholders (OpportunityContactRole — name, title, role, email)
  - Shopify team (OpportunityTeamMember — name, role, email)
  - Competitive: Competitor__c, Position_Against_Competitor__c, Other_Competitor__c
  - Compelling_Event__c, NextStep (standard — no __c!), SE_Next_Steps__c
  - Business_Problem__c, proposed launch dates: Proposed_Launch_Date_Plus__c, Proposed_Launch_Date_Retail__c, Proposed_Launch_Date_B2B__c, Proposed_Launch_Date_Enterprise__c
- Store the full response

### Step 2: Gather Call Transcripts via BigQuery ⭐ (PRIMARY)

**Use BigQuery `shopify-dw.sales.sales_calls` as the primary and default transcript source.**

This table is a **unified, pre-deduped model** combining:
- Salesloft phone calls (dialer activity)
- Salesloft conversation transcripts
- Google Meet transcripts (post-July 2025 primary source)
- Attendee details with RSVP status and `is_shopify_employee` flag
- Salesforce enrichment (account IDs, opportunity IDs, user IDs)
- AI-generated summaries (via `transcript_summary.text`)

#### Step 2a: Get call metadata + AI summaries
```sql
SELECT
  event_id, call_title, event_start, platform, data_source,
  call_duration_minutes, has_transcript, has_salesloft_call,
  salesloft_conversation_id, call_sentiment, call_disposition,
  ARRAY_LENGTH(transcript_details) AS transcript_segments,
  attendee_details, most_recent_salesforce_opportunity_id,
  transcript_summary
FROM `shopify-dw.sales.sales_calls`
WHERE '{SALESFORCE_ACCOUNT_ID}' IN UNNEST(salesforce_account_ids)
  AND DATE(event_start) >= DATE_SUB(CURRENT_DATE(), INTERVAL 730 DAY)
ORDER BY event_start DESC
```

#### Step 2b: Get full transcript text (for calls with transcript_segments > 0)
```sql
SELECT
  sc.event_id, sc.call_title, sc.event_start,
  sc.call_duration_minutes,
  sentence.speaker_name, sentence.speaker_text, sentence.sequence_number
FROM `shopify-dw.sales.sales_calls` sc,
UNNEST(sc.transcript_details) AS transcript,
UNNEST(transcript.full_transcript) AS sentence
WHERE '{SALESFORCE_ACCOUNT_ID}' IN UNNEST(sc.salesforce_account_ids)
  AND DATE(sc.event_start) >= '{DATE_CUTOFF}'
  AND sc.has_transcript = TRUE
  AND ARRAY_LENGTH(sc.transcript_details) > 0
ORDER BY sc.event_start DESC, sentence.sequence_number ASC
```

#### Why BigQuery over Salesloft API:

#### Step 2c: Extract transcript speakers → write to file (REQUIRED)
After processing Step 2b results, extract distinct speakers per call and write to file:
```
deal-health-app/data/transcript-speakers.json
```
Format: `{ "event_id": ["Speaker Name 1", "Speaker Name 2"], ... }`

This file is **auto-loaded by `ingest-deal.js`** to compute transcript-verified attendance.
Calendar RSVP ≠ actual attendance — a stakeholder may accept a calendar invite then not join.
Transcript speaker data is ground truth.

If this file is missing, ingest falls back to RSVP-based attendance (less accurate but not broken).
Names are still resolved regardless.
| Factor | BigQuery sales_calls | Salesloft API |
|--------|---------------------|---------------|
| Queries needed | 1-2 | 8-15+ |
| Speed | ~3 seconds | 30-60 seconds |
| Coverage | Salesloft + Google Meet (unified) | Salesloft only |
| Deduplication | Pre-deduped | Manual merge needed |
| SF enrichment | Pre-linked (account, opp, user IDs) | Manual matching |
| Attendee RSVP | ✅ Yes | ❌ No |
| AI summaries | ✅ Included | Separate API call |
| Reliability | ✅ Stable | ⚠️ Transient 400/500 errors |

#### Fallback: Salesloft API (WorkWithSalesloftAgent)
⏸️ **PAUSED as primary source. Use ONLY if BigQuery auth fails.**

If `list_data_platform_docs` or `query_bigquery` returns a 401 auth error:
1. Retry once (often transient OAuth token refresh)
2. If still failing, fall back to Salesloft API via WorkWithSalesloftAgent
3. Note the fallback in the publish summary

### Step 3: MEDDPICC Analysis
- Delegate to **WorkWithMEDDPICCAnalyst**
- Provide: ALL Salesforce data + ALL call transcripts + AI summaries from BigQuery
- Request:
  - **5 Narrative sections:** Opp Summary, Why Change, Why Shopify, Why Now, Support Needed
  - **8 MEDDPICC sections** with per-question scoring (Yes=1 / Partial=0.5 / No=0):
    - Metrics (7 questions)
    - Economic Buyer (6 questions)
    - Decision Process (7 questions)
    - Decision Criteria (7 questions)
    - Paper Process (7 questions)
    - Identify Pain (8 questions)
    - Champion (7 questions)
    - Competition (5 questions)
  - Each question needs: answer, notes, solution, action, due date

### Step 4: Assemble Payload & Publish ⚡ OPTIMIZED

### Step 3.5: Fix Payload (AUTOMATED in ingest-deal.js)
`ingest-deal.js` now **auto-runs `lib/fix-payload.js`** during ingest. You do NOT call it manually.
It does two things:
1. **Resolves generic role refs → actual names**: "AE to" → "{owner first name} to", "SE to" → "{SE first name} to"
   - Uses `salesforce.owner` and `shopify_team` SE role from the payload
2. **Computes transcript-verified call attendance** from `data/transcript-speakers.json` (Step 2c)
   - `calls_invited` = appeared in call's attendee list (calendar RSVP)
   - `calls_attended` = spoke in transcript (transcribed calls) OR disposition=Connected (dialer calls)
   - Engagement: attended ≥ 2 → high, ≥ 1 → medium, 0 → low

1. **Build the opportunity JSON** matching the data schema below
2. **Write the payload directly** to `deal-health-app/data/incoming-payload.json` using WorkspaceWrite
3. **Delegate to WorkWithSitePublisher** with ONLY: account name + commit message (NO JSON in the message)
4. Site Publisher runs `bash publish.sh "commit message"` — handles ingest, build, git commit, push in ONE command

⚠️ **NEVER pass the JSON payload in the delegation message.** Always write to file first, then delegate with a file reference.

### Step 5: Present Results
- Show the score breakdown, key risks, and dashboard link
- Link: `https://deal-health.quick.shopify.io/#{opportunity_id}`

---

## GIT SETUP (REQUIRED EACH SESSION)

The cloned repo at `/home/swarm/deal-health-dashboard` may not persist between sessions. At the start of any session that needs to push:

```bash
cd /home/swarm
git clone https://github.com/ShivPatel15/deal-health-dashboard.git
cd deal-health-dashboard
git config user.email "shiv.patel@shopify.com"
git config user.name "Shiv Patel"
```

Always verify the repo is cloned and configured before trying to push.

---

## PUBLISH SCRIPT (publish.sh)

Location: `/home/swarm/deal-health-app/publish.sh` (also symlinked at `/home/swarm/publish.sh`)

### Single opportunity:
```bash
bash /home/swarm/deal-health-app/publish.sh "Update deal health: Account Name - 2026-02-19"
```
Runs: validate payload → ingest → build → git fetch/reset → copy → commit → push

### Batch (opportunities already ingested by orchestrator):
```bash
bash /home/swarm/deal-health-app/publish.sh --skip-ingest "Daily refresh: 8 opportunities - 2026-02-19"
```
Runs: build → git fetch/reset → copy → commit → push (skips ingest)

### What it does:
1. Validates incoming-payload.json exists
2. Ensures symlink (deal-health-site/data → deal-health-app/data)
3. Runs ingest-deal.js (unless --skip-ingest)
4. Runs build-data.js from deal-health-site/ (newer version with MAP + coaching)
5. Fetches + resets git repo to origin/main (avoids conflicts)
6. Copies data.js, index.html, and source scripts to repo
7. Commits and pushes

---

## FILE LOCATIONS

| File | Purpose |
|------|---------|
| `/home/swarm/deal-health-app/data/opportunities.json` | **Source of truth** — raw opportunity data with full MEDDPICC |
| `/home/swarm/deal-health-app/build-data.js` | Build script — reads opportunities.json, computes scores, outputs data.js |
| `/home/swarm/deal-health-app/lib/fix-payload.js` | **Payload fixer** — auto-run by ingest: resolves AE/SE→names, computes transcript-verified attendance |
| `/home/swarm/deal-health-app/quick-deploy/data.js` | Build output — generated data.js |
| `/home/swarm/deal-health-site/index.html` | **Dashboard HTML** — the single-file app |
| `/home/swarm/deal-health-site/data.js` | Local copy of data.js (keep in sync) |
| `/home/swarm/deal-health-dashboard/` | **GitHub repo clone** — what gets pushed |
| `/home/swarm/WORKFLOW.md` | This file — workflow documentation |

---

## SALESFORCE FIELD REFERENCE — VERIFIED API NAMES

⚠️ **Last verified: 2026-02-19 via `describe_object('Opportunity')`**
⚠️ **DO NOT guess field names. Use this table. If a field isn't here, run `describe_object` to verify.**

### Revenue & GMV Fields

| Common Name | Exact SF API Name | Type | Label in SF |
|---|---|---|---|
| **Projected Billed Revenue** | `Projected_Billed_Revenue__c` | Currency | "Projection of Billed Revenue" |
| **MCV** | `eComm_Amount__c` | Currency (formula) | "Monthly Contract Value (MCV)" |
| **Total Revenue (3yr)** | `Total_Revenue__c` | Currency (formula) | "Total Revenue" |
| **D2C GMV** | `Opp_Annual_Online_Revenue_Verified__c` | Currency | "Opp D2C Revenue Verified" |
| **B2B GMV** | `Incremental_Annual_B2B__c` | Currency | "Opp B2B Revenue Verified" |
| **Retail GMV** | `Opp_Annual_Offline_Revenue__c` | Currency | "Opp Retail Revenue Verified" |
| **Payments GPV** | `Payments_GPV__c` | Currency (formula) | "Payments GPV (USD)" |
| **Payments Attached** | `Has_Payment_Product__c` | Boolean (formula) | "Has Payments Product" |
| **IPP** | `Incremental_Product_Gross_Profit__c` | Currency (formula) | "Incremental Product Gross Profit" |
| **Amount** | `Amount` | Currency | Standard "Amount" field |
| **Total ACV** | `Total_ACV_Amount__c` | Currency (formula) | "Total ACV Amount" |
| **Subscription Solutions Rev** | `Subscription_Solutions_Revenue__c` | Currency (formula) | "Subscription Solutions Revenue" |
| **Services Revenue** | `Services_Revenue__c` | Currency (formula) | "Services Revenue" |
| **Opp Annual Total Rev (local)** | `Opp_Annual_Total_Revenue__c` | Currency (formula) | Sum of D2C + B2B + Retail in local currency |
| **Opp Annual Total Rev (USD)** | `Opp_Annual_Total_Revenue_Verified__c` | Currency | "Opp Annual Total Revenue Verified" (USD) |
| **D2C Payments GPV** | `D2C_Payments_GPV__c` | Currency (formula) | "D2C Payments GPV" |
| **B2B Payments GPV** | `B2B_Payments_GPV__c` | Currency (formula) | "B2B Payments GPV" |
| **Retail Payments GPV** | `Retail_Payments_GPV__c` | Currency (formula) | "Retail Payments GPV" |
| **Installments iGMV** | `Installments_iGMV__c` | Currency (formula) | "Installments iGMV (USD)" |

### Key Deal Fields

| Common Name | Exact SF API Name | Type | Label in SF |
|---|---|---|---|
| **Next Steps (AE)** | `NextStep` | String (standard) | "Next Step" — ⚠️ NO `__c` suffix! |
| **SE Next Steps** | `SE_Next_Steps__c` | Rich Text | "SE Next Steps" |
| **Competitor** | `Competitor__c` | Picklist (dependent) | "Competitor" |
| **Other Competitor** | `Other_Competitor__c` | String | "Other Competitor" |
| **Position vs Competitor** | `Position_Against_Competitor__c` | String | "Position Against Competitor" |
| **Compelling Event** | `Compelling_Event__c` | String | "Compelling Event" |
| **Merchant Intent** | `Merchant_Intent__c` | Picklist | "Merchant Intent" |
| **Business Problem** | `Business_Problem__c` | Long Text | "Business Problem" |

### Proposed Launch Dates

| Product | Exact SF API Name | Type |
|---|---|---|
| **Plus** | `Proposed_Launch_Date_Plus__c` | Date |
| **Retail** | `Proposed_Launch_Date_Retail__c` | Date |
| **B2B** | `Proposed_Launch_Date_B2B__c` | Date |
| **Enterprise** | `Proposed_Launch_Date_Enterprise__c` | Date |
| **CCS (Commerce Components)** | `Proposed_Launch_Date_CCS__c` | Date |

### Product Boolean Flags (all formula fields)

| Flag | Exact SF API Name |
|---|---|
| Has Plus | `Has_Plus_Products__c` |
| Has Payments | `Has_Payment_Product__c` |
| Has POS | `Has_POS_Product__c` |
| Has B2B | `Has_B2B_Product__c` |
| Has Commerce Components | `Has_Commerce_Components__c` |
| Has Enterprise | `Has_Enterprise_Product__c` |
| Has Installments | `Has_Installments_Product__c` |
| Has Capital | `Has_Capital_Product__c` |
| Has Retail Products | `Has_Retail_Products__c` |
| Has Commerce Catalysts | `Has_Commerce_Catalysts__c` |
| Has Professional Services | `Has_Professional_Services_Product__c` |
| Has Shopify Credit | `Has_Credit_Product__c` |
| Has Retail Hardware | `Has_Retail_Hardware_Product__c` |

### Products List & Features

| Common Name | Exact SF API Name | Type |
|---|---|---|
| Products on Opp | `Products_On_Opportunity_List__c` | Multi-select Picklist (formula) |
| Product Family Features | `Product_Family_Features_On_Opportunity__c` | Multi-select Picklist |
| Primary Product Interest | `Primary_Product_Interest__c` | Picklist |
| Secondary Product Interest | `Secondary_Product_Interest__c` | Multi-select Picklist |

### Other Key Fields

| Common Name | Exact SF API Name | Type |
|---|---|---|
| **Stage** | `StageName` | Picklist (standard) |
| **Close Date** | `CloseDate` | Date (standard) |
| **Probability** | `Probability` | Percent (standard) |
| **Forecast Category** | `ForecastCategoryName` | Picklist (standard) |
| **Opportunity Type** | `Type` | Picklist (standard) |
| **Region** | `Region__c` | String (formula) |
| **Territory Segment** | `Territory_Segment__c` | Picklist |
| **Term Length** | `Term_Length__c` | Picklist ("1" or "3") |
| **Total Retail Locations** | `Total_Retail_Locations__c` | Number |
| **Partners Engaged** | `Partners_Engaged__c` | String |
| **Agreement Type** | `Agreement_Type__c` | Picklist |
| **Contract Type** | `Contract_Type__c` | Picklist |
| **Complexity Score** | `Complexity_Score__c` | Picklist |

### ⚠️ COMMON FIELD NAME TRAPS

These are the field names that DON'T match what you'd expect:

| ❌ Wrong / Guessed Name | ✅ Correct API Name | Why It's Tricky |
|---|---|---|
| `Projection_of_Billed_Revenue__c` | `Projected_Billed_Revenue__c` | "Projected" not "Projection" |
| `D2C_GMV__c` | `Opp_Annual_Online_Revenue_Verified__c` | Named as "D2C Revenue Verified" |
| `B2B_GMV__c` | `Incremental_Annual_B2B__c` | Named as "Incremental Annual B2B" |
| `Retail_GMV__c` | `Opp_Annual_Offline_Revenue__c` | Named as "Retail Revenue Verified" |
| `Payments_Attached__c` | `Has_Payment_Product__c` | It's a boolean formula flag |
| `IPP__c` | `Incremental_Product_Gross_Profit__c` | Full name, not abbreviation |
| `Next_Steps__c` | `NextStep` | Standard field — no `__c`! |
| `Competitive_Notes__c` | `Competitor__c` + `Position_Against_Competitor__c` | Split across 2-3 fields |
| `Proposed_Launch_Date__c` | `Proposed_Launch_Date_Plus__c` | Multiple launch dates by product |

---

## PROJECTED BILLED REVENUE

- **Field:** `Projected_Billed_Revenue__c` from the Opportunity in Salesforce
- **DO NOT** calculate or fabricate revenue projections
- **DO NOT** use `revenueProjection` objects with monthly/annual/year1/year2/year3 calculations
- Just pull the single value from SF and display it as-is
- Home page summary shows **Total Proj Billed Rev** (NOT Total MCV)

---

## BIGQUERY DATA PLATFORM — KEY TABLES

### Primary: `shopify-dw.sales.sales_calls`
- **Purpose:** Unified sales interactions (calls + meetings + transcripts)
- **Grain:** One row per sales interaction (`event_id`)
- **Sources:** Salesloft calls, Salesloft conversations, Google Meet transcripts/events
- **Key fields:** `salesforce_account_ids` (ARRAY), `transcript_details` (ARRAY<STRUCT>), `attendee_details`, `transcript_summary`, `has_transcript`
- **Dedup:** Post-July 2025, meetings in both systems matched by title + 5-min window. Google Meets prioritized.
- **Transcript transition:** Pre-July 2025 = Salesloft transcripts. Post-July 2025 = Google Meet transcripts.

### Bonus tables (for future enrichment):
| Table | What it provides |
|-------|-----------------|
| `shopify-dw.sales.sales_emails` | 18M unified sales emails (Salesloft + Mozart) |
| `shopify-dw.sales.sales_transcript_extracted_merchant_pain_points` | LLM-extracted pain points from transcripts |
| `shopify-dw.sales.sales_transcript_extracted_merchant_goals` | LLM-extracted merchant goals from transcripts |
| `shopify-dw.sales.sales_transcripts_account_attributes` | Account attributes extracted from transcripts |
| `shopify-dw.sales.sales_accounts` | Full Salesforce account records |
| `shopify-dw.sales.sales_opportunities` | Full Salesforce opportunity records |

### Auth notes:
- BigQuery access via `list_data_platform_docs` + `query_bigquery` tools
- Auth is OAuth-based — occasionally returns transient 401 on first call
- **Always retry once if 401** — token refresh usually fixes it
- If persistent auth failure, fall back to Salesloft API

---

## DASHBOARD FEATURES (current state)

### Portfolio View (Home)
- Summary cards: Opportunities, **Total Proj Billed Rev**, Avg Health, At Risk
- **Filter bar** with 4 filter dimensions:
  - **Close Quarter** — filter by Q1/Q2/Q3/Q4 of any year. When a quarter is selected, opportunities group by close month within that quarter
  - **Owner** — filter by AE (shows first name + count)
  - **Stage** — filter by pipeline stage (Deal Craft, Demonstrate, Solution, etc.)
  - **Health** — filter by health status (At Risk, On Track, Good)
  - Active filter count badge + "Clear All" button
- **Month grouping** — when a quarter is selected, deals are grouped under month headers (e.g., "📅 Feb 2026", "📅 Mar 2026") instead of by owner, with per-month stats
- Default view (no quarter selected) groups by owner
- ❌ **DO NOT show Total MCV on the home page summary**
- Table column header is **PBR** (Projection of Billed Revenue), NOT MCV
- Table cells show `projectedBilledRevenue` with fallback to `revenue.mcv`

### Opportunity Detail View
- Header chips: Stage, Close Date, **PBR**, Forecast, Owner, Competitor
- Products strip (pill badges)
- Big score display + 8 MEDDPICC category tiles
- Revenue card
- Tabs: Overview, MEDDPICC, Next Steps, Stakeholders, Calls, History, Comments

### Editable Sections
- Overview narratives: each section has ✏️ Edit → textarea → Save/Cancel (localStorage)
- MEDDPICC rows: double-click to edit answer/notes/solution/action/due (localStorage)

### Theme
- Dark/Light mode toggle (localStorage)

---

## DATA SCHEMA (data.js)

```javascript
const DEAL_DATA = {
  team: { name: "Sales Large — EMEA" },
  generatedAt: "ISO date",
  owners: ["Owner Name"],
  opportunities: [{
    // Core
    id, name, accountName, accountId, owner, ownerEmail,
    stage, closeDate, forecastCategory, probability,
    merchantIntent, type, created,
    
    // Revenue
    revenue: { mcv, totalRev3yr, d2cGmv, b2bGmv, retailGmv, paymentsGpv, ipp, paymentsAttached },
    projectedBilledRevenue: <number>,
    
    // Products, Competitive, Events
    products: ["string array"],
    competitor, compellingEvent, nextStep,
    
    // Analysis (NEVER strip these)
    narrative: { oppSummary, whyChange, whyShopify, whyNow, supportNeeded },
    meddpicc: {
      metrics:         { label: "Metrics",          questions: [{ q, answer, score, notes, solution, action, due, highlight }] },
      economicBuyer:   { label: "Economic Buyer",   questions: [...] },
      decisionProcess: { label: "Decision Process",  questions: [...] },
      decisionCriteria:{ label: "Decision Criteria", questions: [...] },
      paperProcess:    { label: "Paper Process",     questions: [...] },
      identifyPain:    { label: "Identify Pain",     questions: [...] },
      champion:        { label: "Champion",          questions: [...] },
      competition:     { label: "Competition",       questions: [...] }
    },
    
    // Scores (computed by build-data.js, keyed by section.label)
    scores: {
      "Metrics": { score, max, pct },
      "Economic Buyer": { score, max, pct },
      // ... all 8 sections ...
      _total: { score, max, pct, status }
    },
    
    // People
    stakeholders: [{ name, title, role, email, engagement, callsAttended, callsInvited }],
    shopifyTeam: [{ name, role, email }],
    
    // Activity
    calls: [{ date, title, duration, shopifyAttendees, merchantAttendees, summary }],
    nextSteps: [{ p, cat, issue, rec, due }],
    history: [{ date, totalScore, totalMax, status, sectionScores, changes }]
  }]
};
```

---

## CRITICAL: build-data.js SCORING

The `computeScores()` function MUST key scores by `section.label` (e.g., `"Metrics"`, `"Economic Buyer"`), NOT by the camelCase sectionKey (e.g., `"metrics"`, `"economicBuyer"`).

The dashboard HTML looks up scores via `s[sec.label]`. If keyed by sectionKey, all category tiles show 0/0.

The output format MUST be:
```javascript
const DEAL_DATA = { team, generatedAt, owners, opportunities };
```

NOT `window.dealhealthData = [...]` or any other format.

Status thresholds: `pct >= 75` → good-health, `pct >= 50` → on-track, else → at-risk

---

## CRITICAL: build-data.js MUST PRESERVE ALL DATA

⚠️ **NEVER "simplify" or strip opportunity records in build-data.js.**

The build script MUST pass through ALL fields:
- `narrative` — all 5 sections
- `meddpicc` — all 8 sections with per-question scoring
- `scores` — computed from meddpicc
- `stakeholders`, `shopifyTeam`, `calls` — full arrays
- `nextSteps` — extracted from meddpicc actions
- `history` — version tracking
- `projectedBilledRevenue`, `compellingEvent`, `competitor`

If build-data.js is ever rewritten, verify the output data.js contains ALL analysis.

---

## LITE REFRESH — HYBRID SCORING ENGINE

Added 2026-02-19. When the daily refresh detects SF field changes, the lite refresh engine adjusts MEDDPICC scores without re-running full analysis.

### How It Works

```
SF diffs detected
       ↓
Layer 1: score-rules.json (18 deterministic rules)
       ↓ matched                    ↓ unmatched
Apply score deltas              Generate LLM prompt
automatically                   (escalation-prompt.txt)
       ↓                              ↓
Update opportunities.json     Send to MEDDPICC Analyst
       ↓                       (lightweight — no transcripts)
Rebuild data.js → Push
```

### Files
- `lite-refresh.js` — The engine. Run: `node lite-refresh.js --diffs diffs.json [--dry-run]`
- `score-rules.json` — 18 rules mapping SF fields → MEDDPICC questions
- `data/escalation-prompt.txt` — Auto-generated prompt for unmatched changes

### Diffs Format (input)
```json
[{
  "opportunityId": "006...",
  "accountName": "Account",
  "changes": [
    { "field": "forecastCategory", "oldValue": "", "newValue": "Commit" }
  ]
}]
```

### Action Item Lifecycle
- When a MEDDPICC question answer moves to **Yes**, its action item is auto-resolved
- `build-data.js` skips questions answered **Yes** when generating nextSteps
- Resolved actions are logged in question notes with timestamp
- Browser localStorage checkboxes are separate (per-user completion tracking)

---

## DOWNSTREAM UPDATE CHAIN — WHAT MUST HAPPEN ON EVERY CHANGE

⚠️ **When MEDDPICC scores or actions change (from new calls, lite-refresh, or full re-analysis), the following MUST all cascade:**

```
MEDDPICC actions updated (opportunities.json)
       ↓
build-data.js runs
       ↓ generates these automatically:
       ├── scores (recomputed from MEDDPICC answers)
       ├── nextSteps (regenerated from non-Yes MEDDPICC actions)
       ├── history (version entry with score + changes)
       └── data.js output
       ↓
Dashboard loads data.js
       ↓ client-side auto-computes:
       ├── coaching-engine.js → deal risk signals (from scores + close date + call recency)
       ├── coaching-engine.js → rep coaching tips (from scores across owner's deals)
       └── Next Steps tab (from nextSteps array in data.js)
```

### What `build-data.js` does on every run:
1. **Scores** — Recomputes from MEDDPICC question answers (Yes=1, Partial=0.5, No=0)
2. **nextSteps** — Regenerates by scanning ALL MEDDPICC questions:
   - Questions answered **Yes** → action excluded (gap closed)
   - Questions with non-empty `action` field → included as a next step
   - Prioritized in section order (Metrics → Competition)
3. **history** — Adds version entry with today's scores and section breakdown
4. **Output** — Writes `quick-deploy/data.js` with all of the above

### What `coaching-engine.js` does client-side (no build needed):
1. **`getDealRisks(opp)`** — Computes per-deal risk signals based on:
   - Close date proximity vs Paper Process / Decision Process / EB scores
   - Champion strong but EB weak pattern
   - Call recency (no calls in 30+ days = going cold)
   - Missing competitor data
2. **`getRepCoaching(owner, deals)`** — Computes per-rep coaching based on:
   - Aggregate section scores across all owner's deals
   - Identifies weakest MEDDPICC section for that rep
   - Generates coaching tip with deal-level examples
3. **Both auto-update** whenever data.js changes — no manual step needed

### On incremental refresh (new calls found), the MEDDPICC Analyst MUST:
1. Update **answers** for questions where new evidence changes the gap status
2. Update **action items** for questions where:
   - A gap is now RESOLVED (answer → Yes) → clear the action
   - A gap is PARTIALLY resolved → update action to what's still needed
   - A NEW gap or risk emerged from the call → add new action + due date
   - An existing action's due date has PASSED → flag as overdue, update due
3. Update **supportNeeded narrative** if calls reveal new or changed support requirements
4. Update **notes** with evidence from the new call transcript

### Verification checklist (after every build):
- [ ] Scores match expected values (check build output log)
- [ ] Action count changed appropriately (resolved actions decreased count, new actions increased it)
- [ ] nextSteps tab shows updated items on dashboard
- [ ] Risk signals reflect new scores (check for close-date + score mismatches)
- [ ] Version history entry logged with changes description

### Version History
Lite refresh entries include:
- Score delta summary: "Score improved by 0.5 points (38.5 → 39)"
- Per-question changes: "Metrics Q5: Partial → Yes (+0.5) — reason"
- SF triggers: "forecastCategory '' → 'Commit'"
- `type: "lite-refresh"` to distinguish from full analysis

`build-data.js` preserves enriched history entries — it won't overwrite entries that already have changes logged.

---

## SCHEDULED DAILY REFRESH (8 AM UK)

⚠️⚠️⚠️ **THIS IS THE MOST IMPORTANT SECTION. READ EVERY WORD.** ⚠️⚠️⚠️

The scheduled refresh runs automatically. Its ONLY job is to detect what changed since the last run, update ONLY those parts, and leave everything else untouched.

### THE GOLDEN RULE
**If nothing changed for an opportunity, DO NOT TOUCH IT. Do not re-analyze. Do not rewrite. Do not re-score. Leave it exactly as it is.**

### STEP-BY-STEP SCHEDULED REFRESH FLOW

**Step 0: Load existing data**
```
Read /home/swarm/deal-health-app/data/opportunities.json
For each opportunity, note its ID and the date of its last call (from the calls array)
```

**Step 1: For EACH opportunity, check Salesforce for changes**
- Delegate to WorkWithSalesforceReader — pull ONLY these lightweight fields:
  - Stage, close date, probability, forecast category, merchant intent
  - AE next steps, SE next steps
  - Revenue fields (eComm_Amount__c for MCV, Projected_Billed_Revenue__c)
- **COMPARE** each field against what's stored in opportunities.json
- Track what changed (e.g., "stage changed from Demonstrate to Deal Craft", "close date moved from Feb 28 to Mar 15")

**Step 2: For EACH opportunity, check BigQuery for NEW calls only** ⭐ UPDATED

⚠️ **Use BigQuery `sales_calls` — NOT the Salesloft API.**

```sql
SELECT
  event_id, call_title, event_start, platform,
  call_duration_minutes, has_transcript,
  ARRAY_LENGTH(transcript_details) AS transcript_segments,
  transcript_summary
FROM `shopify-dw.sales.sales_calls`
WHERE '{ACCOUNT_ID}' IN UNNEST(salesforce_account_ids)
  AND DATE(event_start) > '{LAST_CALL_DATE}'
ORDER BY event_start DESC
```

- If new calls with transcripts are found, pull the full transcript text:
```sql
SELECT sc.event_id, sc.call_title, sc.event_start,
  sentence.speaker_name, sentence.speaker_text, sentence.sequence_number
FROM `shopify-dw.sales.sales_calls` sc,
UNNEST(sc.transcript_details) AS transcript,
UNNEST(transcript.full_transcript) AS sentence
WHERE '{ACCOUNT_ID}' IN UNNEST(sc.salesforce_account_ids)
  AND DATE(sc.event_start) > '{LAST_CALL_DATE}'
  AND sc.has_transcript = TRUE AND ARRAY_LENGTH(sc.transcript_details) > 0
ORDER BY sc.event_start DESC, sentence.sequence_number ASC
```

- **ONLY retrieve transcripts for NEW calls** — do not re-pull old ones
- If BigQuery auth fails (401), retry once, then fall back to Salesloft API

**Step 3: Decide what to do for each opportunity**

| SF Changed? | New Calls? | Action |
|-------------|------------|--------|
| No | No | **DO NOTHING.** Skip entirely. Add version history note: "No changes detected" |
| Yes | No | Update ONLY the changed SF fields in opportunities.json. Do NOT re-run MEDDPICC. Add version history note listing what SF fields changed. |
| No | Yes | Add new calls to the calls array. Re-run MEDDPICC analysis ONLY if the new calls contain substantive information that would change scoring. Add version history note listing new calls found. |
| Yes | Yes | Update SF fields AND add new calls. Re-run MEDDPICC only if new calls warrant it. Add version history notes for both. |

**Step 4: If ANY opportunity was updated**
1. Save updated opportunities.json
2. Run `node build-data.js`
3. Copy data.js to deal-health-dashboard repo
4. Git commit with descriptive message listing what changed per opp
5. Git push

**Step 5: If NOTHING changed across ALL opportunities**
- Report: "✅ Dashboard is current — no changes detected across all 8 opportunities"
- Do NOT rebuild, do NOT push, do NOT touch any files

### VERSION HISTORY NOTES

For every opportunity, regardless of whether it changed, add a version history entry for today with:
- The current score (unchanged or updated)
- A `changes` array describing what happened:
  - `"No changes detected"` if nothing changed
  - `"SF: Stage changed from X to Y"` for Salesforce field changes
  - `"SF: Close date moved from X to Y"`
  - `"SF: AE next steps updated"`
  - `"New call: {title} on {date}"` for new calls found (via BigQuery)
  - `"MEDDPICC re-scored based on new call data"` if analysis was re-run
  - `"Score changed from X to Y"` if total score changed
  - `"Action items: X → Y (N resolved, M new/updated)"` if action count changed
  - `"Resolved: {section} Q{n} — {former action text}"` for each resolved action

### ⚠️ THINGS THE SCHEDULED REFRESH MUST NEVER DO

1. **NEVER re-run MEDDPICC analysis on the same data.** LLM analysis is non-deterministic — re-running on identical inputs will produce different scores and corrupt the existing good analysis.
2. **NEVER overwrite existing narrative sections** (oppSummary, whyChange, whyShopify, whyNow, supportNeeded) unless new call transcripts provide genuinely new information.
3. **NEVER overwrite existing MEDDPICC question scores/notes** unless there's new evidence from calls or SF changes that directly affect that specific question.
4. **NEVER delete or reduce data.** If a BigQuery lookup fails, keep existing call data. If Salesforce returns less info, keep what we had.
5. **NEVER re-pull full Salesforce opportunity details.** Only check the lightweight change-detection fields listed in Step 1.
6. **NEVER re-pull old call transcripts.** Only look for NEW calls after the last known call date.
7. **NEVER use the Salesloft API for transcript retrieval** unless BigQuery auth has failed after retry.

### WHAT COUNTS AS A "CHANGE" WORTH RE-ANALYZING

**YES, re-run MEDDPICC if:**
- A new call with a substantive transcript was found (not a 5-second no-answer)
- Stage changed (e.g., Demonstrate → Deal Craft)
- Merchant intent changed (e.g., Committed → Committed - At Risk)

**NO, do NOT re-run MEDDPICC if:**
- Only the close date moved
- Only the AE next steps text updated
- Only revenue numbers changed slightly
- A BigQuery/Salesloft lookup failed or returned no new data
- The same calls exist as before with no new ones

For these "minor SF changes," just update the raw field in opportunities.json and let build-data.js recompute the same scores.

---

## MAKING CHANGES LIVE

⚠️ **THIS STEP IS MANDATORY. NEVER SKIP IT.**

After ANY push to GitHub, remind user:

```bash
cd deal-health-dashboard
git pull origin main
quick deploy . deal-health --force
```

Changes are NOT live on https://deal-health.quick.shopify.io/ until deployed from user's local machine.
