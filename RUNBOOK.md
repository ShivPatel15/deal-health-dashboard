# Deal Health Dashboard — Runbook

## Quick Reference

### Deploy to live site
```bash
cd ~/deal-health-dashboard
git pull
quick deploy ./quick-deploy deal-health --force
```

### Files that power the site (in `quick-deploy/`)
| File | Purpose |
|------|---------|
| `index.html` | Dashboard UI |
| `data.js` | All opportunity data (15 opps, MEDDPICC, MAP, risks, calls, etc.) |
| `coaching-engine.js` | Risk signals + coaching logic |

---

## Pipeline Architecture

```
data/opportunities.json  ← SINGLE SOURCE OF TRUTH (all opp data lives here)
        │
        ├── ingest-deal.js        ← Merges new/updated opp payloads
        ├── incremental-update.js ← Applies SF diffs, risks, MAP updates
        │
        ▼
    build-data.js  ← Rebuilds data.js from opportunities.json
        │           (computes scores, extracts nextSteps, builds history)
        ├── data.js              ← Root copy
        └── quick-deploy/data.js ← Deploy copy (must match root)
```

### Critical Rules
1. **NEVER edit `data.js` directly** — always modify `opportunities.json` then rebuild
2. **NEVER replace arrays** — always merge/append (MAP items, action items, etc.)
3. **Always run `validate-before-push.sh`** before pushing to GitHub
4. **Always use `quick deploy ./quick-deploy`** not `quick deploy .` (avoids deploying the whole repo)

---

## Daily Refresh Flow

The daily refresh runs in this order:

### Step 1: Gather Salesforce Changes
- Orchestrator delegates to Salesforce Reader for each opp
- SF Reader returns latest field values
- Diffs computed against current state → saved to `data/diffs.json`

### Step 2: Gather Call Transcripts (BigQuery)
- Orchestrator queries `shopify-dw.sales.sales_calls` directly
- Gets call metadata, AI summaries, and full transcripts
- For each account using the SF Account ID

### Step 3: Score Adjustments
- MEDDPICC scores adjusted based on SF field changes + new call evidence
- Version history updated with score changes and reasons

### Step 4: Incremental Risk/MAP/Action Updates ← NEW
For each deal with material changes (score change, stage change, close date move, new call):

1. **Prepare `data/incremental-updates.json`** with:
   - `sfDiffs` — SF field changes to apply to opp records
   - `dealRisks` — Analyst-derived contextual risks
   - `newMAPItems` — New milestones to add (merged, not replaced)
   - `completedMAPMilestones` — Milestones to mark as done
   - `mapGoLiveDate` — Updated go-live date if close date changed
   - `meddpiccUpdates` — Question-level changes (due dates, answer changes)

2. **Run incremental update:**
   ```bash
   node incremental-update.js --input data/incremental-updates.json
   ```
   This modifies `opportunities.json` safely with merge semantics.

3. **Rebuild:**
   ```bash
   node build-data.js
   ```
   This rebuilds `data.js` and `quick-deploy/data.js` from `opportunities.json`.

### Step 5: Validate & Push
```bash
bash validate-before-push.sh   # Checks opp count, file integrity, etc.
git add -A
git commit -m "Daily refresh YYYY-MM-DD: ..."
git push origin main
```

### Step 6: Deploy (manual, on local machine)
```bash
cd ~/deal-health-dashboard
git pull
quick deploy ./quick-deploy deal-health --force
```

---

## Adding a New Opportunity

### Full Analysis (first time)

1. **Salesforce Reader** — Provide the Opportunity ID, get all SF data
2. **BigQuery** — Query `shopify-dw.sales.sales_calls` for call transcripts using the Account ID
3. **MEDDPICC Analyst** — Full analysis with narratives, per-question scoring, actions, due dates
4. **Assemble payload** — Write to `data/incoming-payload.json`:
   ```json
   {
     "salesforce": { ... },
     "meddpicc_analysis": { ... },
     "calls": [ ... ]
   }
   ```
5. **Ingest:**
   ```bash
   node ingest-deal.js --input data/incoming-payload.json
   ```
6. **Incremental update** (optional, for risks + MAP):
   ```bash
   node incremental-update.js --input data/incremental-updates.json
   ```
7. **Build + validate + push:**
   ```bash
   node build-data.js
   bash validate-before-push.sh
   git add -A && git commit -m "Add new opp: [Account Name]" && git push origin main
   ```

### What the Orchestrator does automatically
- Steps 1-3 are delegated to specialist agents
- Step 4 (payload assembly) is done by the Orchestrator
- Steps 5-7 are delegated to the Site Publisher
- The Orchestrator also runs the incremental update for risks/MAP

---

## Incremental Update Format

### `data/incremental-updates.json` schema

```json
{
  "OPPORTUNITY_ID": {
    "sfDiffs": [
      { "field": "closeDate", "newValue": "2026-03-30" },
      { "field": "stage", "newValue": "Deal Craft" },
      { "field": "probability", "newValue": 80 },
      { "field": "revenue.mcv", "newValue": 0 }
    ],
    "dealRisks": [
      {
        "risk": "Description of the risk",
        "severity": "high|medium|low",
        "category": "timeline|execution|commercial|champion|competitive"
      }
    ],
    "meddpiccUpdates": [
      {
        "section": "economicBuyer",
        "questionIndex": 2,
        "updates": { "due": "03/04/2026", "answer": "Yes", "score": 1 }
      }
    ],
    "newMAPItems": [
      {
        "milestone": "Board meeting",
        "done": false,
        "ownerShopify": "Ben",
        "ownerMerchant": "Neil",
        "date": "2026-03-24",
        "notes": "Confirmed decision event"
      }
    ],
    "completedMAPMilestones": ["Initial discovery & intro calls"],
    "mapGoLiveDate": "2026-03-31"
  }
}
```

### Supported SF diff fields
| Field | Level |
|-------|-------|
| `stage` | Top-level |
| `closeDate` | Top-level |
| `probability` | Top-level |
| `forecastCategory` | Top-level |
| `nextStep` | Top-level |
| `competitor` | Top-level |
| `projectedBilledRevenue` | Top-level |
| `revenue.mcv` | Revenue sub-field |
| `revenue.totalRev3yr` | Revenue sub-field |
| `revenue.paymentsGpv` | Revenue sub-field |
| `revenue.d2cGmv` | Revenue sub-field |
| `revenue.b2bGmv` | Revenue sub-field |
| `revenue.retailGmv` | Revenue sub-field |

### Safety guarantees of `incremental-update.js`
- ✅ Never removes opportunities
- ✅ Never removes MEDDPICC questions
- ✅ Never removes existing MAP items (only adds or marks done)
- ✅ Validates opp count before and after
- ✅ Validates MEDDPICC integrity (8 sections) for all opps
- ✅ Validates MAP integrity for opps that had MAPs before

---

## Deal Risks

### Two sources of risks on the dashboard

1. **Analyst risks** (`opp.dealRisks` array) — Specific, contextual risks from MEDDPICC incremental updates. Examples: "PBR dropped 43%", "SP is make-or-break", "Close date slipped 1 month".

2. **Auto-generated risks** (`coaching-engine.js → getDealRisks()`) — Computed dynamically from scores, close dates, call recency, stakeholder coverage. Examples: "Paper Process at 3/7 with 14d to close", "No calls in 25 days".

Both appear together in:
- **Pipeline view** → "🚨 Deal Risks" section (collapsible, grouped by deal)
- **Deal detail → Overview tab** → "⚠️ Deal Risks" panel at the top

### When analyst risks are generated
- During incremental updates after daily refresh
- When material changes detected: score change, stage change, close date move, new call, revenue change
- Generated by MEDDPICC Analyst with context from SF diffs + call summaries
- Stored in `opportunities.json` → `opp.dealRisks[]`

---

## Troubleshooting

### Site is empty after deploy
- Check `quick-deploy/` has all 3 files: `index.html`, `data.js`, `coaching-engine.js`
- Hard refresh the browser: `Cmd + Shift + R`
- Check `data.js` starts with `const DEAL_DATA =` and has opportunities

### Data looks stale
- Run `git pull` before deploying
- Check `generatedAt` timestamp in data.js
- If needed, rebuild: `node build-data.js`

### Opp count dropped
- Run `bash validate-before-push.sh` — it will flag if count < 10
- Check `data/opportunities.json` directly
- Restore from git: `git checkout -- data/opportunities.json`

### Deploy picks up wrong files
- Always deploy from `./quick-deploy`, never from `.`
- `quick deploy ./quick-deploy deal-health --force`

### validation says data.js and quick-deploy/data.js don't match
- Rebuild: `node build-data.js` (it writes to both locations)
