# Deal Health Dashboard — Workflow & Architecture

## Last Updated: 2026-02-18

---

## LIVE SITE
- **URL:** https://deal-health.quick.shopify.io/
- **Repo:** https://github.com/ShivPatel15/deal-health-dashboard
- **Deploy method:** `quick deploy . deal-health --force` (must be run from Shiv's local machine)

---

## CURRENT OPPORTUNITIES ON DASHBOARD (5)

| # | Account | Opp ID | Score | Owner | Close |
|---|---------|--------|-------|-------|-------|
| 1 | Whittard of Chelsea | 006OG00000EZIy6YAH | 38.5/54 (71%) | Adriana Colacicco | Feb 27 |
| 2 | Mulberry Company (Sales) Limited | 006OG00000CRabaYAD | 34.5/54 (64%) | Ben Rees | Feb 28 |
| 3 | Moda in Pelle | 0068V0000113rSIQAY | 32.5/54 (60%) | Adriana Colacicco | Feb 27 |
| 4 | Wacoal Europe | 006OG00000HnVs8YAF | 31.5/54 (58%) | Maissa Fatte | Feb 28 |
| 5 | The Dune Group | 006OG00000GJ5IvYAL | 30.5/54 (56%) | Adriana Colacicco | Feb 27 |

⚠️ **Simon Jersey (0068V00001DEMO02) is a DEMO record — do NOT include it. It was removed on 2026-02-18.**

---

## TWO TYPES OF WORK

### 1. Adding New Opportunities
When user provides a Salesforce Opportunity ID, run the full pipeline:
- Step 1: Salesforce → Step 2: Salesloft → Step 3: MEDDPICC → Step 4: Build & Push

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
  - Revenue: Amount/MCV, Total_Revenue__c, D2C GMV, B2B GMV, Retail GMV, Payments GPV, IPP
  - **Projection_of_Billed_Revenue__c** (critical)
  - Products (OpportunityLineItem — name, code, price)
  - Stakeholders (OpportunityContactRole — name, title, role, email)
  - Shopify team (OpportunityTeamMember — name, role, email)
  - Competitive notes, compelling event, AE next steps, SE next steps
  - Business problem, timeline, proposed launch dates
- Store the full response

### Step 2: Gather Call Transcripts
- Delegate to **WorkWithSalesloftAgent**
- Provide: Account name from Salesforce
- If account name returns wrong company, try:
  - Search by contact email addresses
  - Search by domain
  - Search by Salesforce Account ID
- Request: All call transcripts, meetings, attendees, dates, summaries
- If no transcripts available, note it and proceed — SE notes from Salesforce are often very detailed

### Step 3: MEDDPICC Analysis
- Delegate to **WorkWithMEDDPICCAnalyst**
- Provide: ALL Salesforce data + ALL call transcripts (or note if none available)
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

### Step 4: Assemble Payload & Publish
1. **Build the opportunity JSON** matching the data schema below
2. **Add to opportunities.json** at `/home/swarm/deal-health-app/data/opportunities.json`
3. **Run build:** `cd /home/swarm/deal-health-app && node build-data.js`
4. **Verify scores** in the output
5. **Copy data.js** to site dir and cloned repo:
   ```
   cp deal-health-app/quick-deploy/data.js deal-health-site/data.js
   cp deal-health-app/quick-deploy/data.js deal-health-dashboard/data.js
   ```
6. **Git commit & push:**
   ```
   cd /home/swarm/deal-health-dashboard
   git add -A && git commit -m "Add {Account Name}" && git push origin main
   ```

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

## FILE LOCATIONS

| File | Purpose |
|------|---------|
| `/home/swarm/deal-health-app/data/opportunities.json` | **Source of truth** — raw opportunity data with full MEDDPICC |
| `/home/swarm/deal-health-app/build-data.js` | Build script — reads opportunities.json, computes scores, outputs data.js |
| `/home/swarm/deal-health-app/quick-deploy/data.js` | Build output — generated data.js |
| `/home/swarm/deal-health-site/index.html` | **Dashboard HTML** — the single-file app |
| `/home/swarm/deal-health-site/data.js` | Local copy of data.js (keep in sync) |
| `/home/swarm/deal-health-dashboard/` | **GitHub repo clone** — what gets pushed |
| `/home/swarm/WORKFLOW.md` | This file — workflow documentation |

---

## PROJECTED BILLED REVENUE

- **Field:** `Projection_of_Billed_Revenue__c` from the Opportunity in Salesforce
- **DO NOT** calculate or fabricate revenue projections
- **DO NOT** use `revenueProjection` objects with monthly/annual/year1/year2/year3 calculations
- Just pull the single value from SF and display it as-is
- Home page summary shows **Total Proj Billed Rev** (NOT Total MCV)

---

## DASHBOARD FEATURES (current state)

### Portfolio View (Home)
- Summary cards: Opportunities, **Total Proj Billed Rev**, Avg Health, At Risk
- Owner filter buttons (if multiple owners)
- Table with per-owner grouping
- ❌ **DO NOT show Total MCV on the home page summary**

### Opportunity Detail View
- Header chips: Stage, Close Date, MCV, Proj Billed Rev, Forecast, Owner, Competitor
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

## SALESLOFT LOOKUP FLOW

**DO NOT search Salesloft by account name alone.** This often pulls wrong accounts (e.g., "Mulberry" NYC media company instead of Mulberry UK fashion brand).

**Correct flow:**
1. Search by account name first
2. If wrong company returned, try:
   - Search by specific contact email addresses from Salesforce
   - Search by domain (e.g., "mulberry.com")
   - Search by Salesforce Account ID
3. Once correct account found, pull all calls/meetings/transcripts
4. If Salesloft has no data or agent errors persist, proceed with MEDDPICC analysis using Salesforce data + SE notes only — flag the limitation

---

## SCHEDULED DAILY REFRESH

A daily schedule triggers this swarm to refresh all dashboard opps.

**How it works:**
1. Read `opportunities.json` to get all current opp IDs
2. For EACH opp, run Steps 1-3 (Salesforce → Salesloft → MEDDPICC)
3. **COMPARE** new data against existing — only update if something changed
4. **ONLY re-run MEDDPICC** if new SF data or new Salesloft calls appeared
5. Rebuild data.js and push (only if changes detected)

**⚠️ CRITICAL RULES FOR SCHEDULED REFRESH:**
- **DO NOT regenerate MEDDPICC if no new data.** Re-running on same inputs risks hallucinating different answers.
- **DO NOT overwrite existing analysis with empty/weaker data.** If a delegate fails, keep existing.
- **If NOTHING changed**, report "Dashboard is current" and do NOT push.

**Comparison checks per opportunity:**
- Salesforce: Did close date, stage, probability, forecast, intent, revenue, stakeholders, or next steps change?
- Salesloft: Are there new calls since last refresh?
- If neither changed → skip MEDDPICC re-analysis, keep existing

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
