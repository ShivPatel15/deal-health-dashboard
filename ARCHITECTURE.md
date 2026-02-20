# Deal Health Dashboard — Architecture & Data Safety

## Last Updated: 2026-02-20

## ⚠️ CRITICAL RULES (read first)

### 1. Single Directory Architecture
Everything lives in `/home/swarm/deal-health-app/`. There is ONE directory. Not two, not three. ONE.

```
/home/swarm/deal-health-app/       ← THE ONLY DIRECTORY
  ├── .git/                        ← Git repo (pushes to GitHub)
  ├── data/
  │   ├── opportunities.json       ← 🔴 SINGLE SOURCE OF TRUTH for all opportunities
  │   ├── incoming-payload.json    ← Temporary: payload from orchestrator (overwritten each run)
  │   ├── version-history.json     ← Score change tracking
  │   └── sharing.json             ← Per-opp access control
  ├── data.js                      ← Built output served by the site (generated, never edit manually)
  ├── quick-deploy/data.js         ← Copy of data.js (generated, never edit manually)
  ├── index.html                   ← Dashboard UI
  ├── ingest-deal.js               ← Merges ONE payload into opportunities.json
  ├── build-data.js                ← Builds data.js from opportunities.json
  ├── publish.sh                   ← One-command pipeline: ingest → build → git push
  ├── coaching-engine.js           ← Generates coaching snapshots during build
  ├── score-rules.json             ← Scoring/health thresholds
  └── *.md                         ← Documentation
```

### 2. Source of Truth
`data/opportunities.json` is the **ONLY** source of truth. Everything else is derived from it:
- `data.js` = built from `opportunities.json` by `build-data.js`
- `quick-deploy/data.js` = copy of `data.js`
- The live site reads `data.js`

**Never** edit `data.js` directly. Always modify `opportunities.json` (via ingest-deal.js or manually) then rebuild.

### 3. Ingest MERGES, Never Overwrites
`ingest-deal.js` reads the EXISTING `data/opportunities.json`, finds the matching opportunity by ID, and updates ONLY that one record. All other opportunities are preserved.

**If `data/opportunities.json` does not exist or is empty, ingest will create a NEW file with ONLY the ingested opportunity. This is the primary cause of data loss.**

### 4. No Duplicate Directories
Previous bugs were caused by having 3 separate directories (`deal-health-app/`, `deal-health-site/`, `deal-health-dashboard/`) that drifted apart. These have been deleted. If they reappear, delete them immediately:
```bash
rm -rf /home/swarm/deal-health-site /home/swarm/deal-health-dashboard
```

---

## Data Flow

```
                  Orchestrator writes payload
                           │
                           ▼
              data/incoming-payload.json
                           │
                    ingest-deal.js
                    (MERGES into existing)
                           │
                           ▼
              data/opportunities.json     ← SOURCE OF TRUTH (12+ opps)
                           │
                     build-data.js
                     (reads opps, computes scores,
                      generates MAP, coaching)
                           │
                    ┌──────┴──────┐
                    ▼              ▼
               data.js    quick-deploy/data.js
                    │
              git add + commit + push
                    │
                    ▼
              GitHub repo
                    │
              User clones + quick deploy
                    │
                    ▼
         https://deal-health.quick.shopify.io/
```

---

## Pipeline Commands

### Full pipeline (ingest + build + push):
```bash
cd /home/swarm/deal-health-app
bash publish.sh "Update deal health: Account Name - 2026-02-20"
```

### Skip ingest (just rebuild and push):
```bash
bash publish.sh --skip-ingest "Rebuild and push"
```

### Manual steps (if publish.sh fails):
```bash
cd /home/swarm/deal-health-app

# 1. Ingest payload
node ingest-deal.js --input data/incoming-payload.json

# 2. Build data.js (writes BOTH root and quick-deploy/)
node build-data.js

# 3. Commit and push
git add -A
git commit -m "Update deal health"
git push origin main
```

---

## Safety Checks

### publish.sh includes:
1. **Refuses to run** if `data/opportunities.json` doesn't exist
2. **Warns** if fewer than 2 opportunities in the data store
3. **Verifies** built data.js has the same opportunity count as the source

### Before ANY ingest or publish, verify:
```bash
cd /home/swarm/deal-health-app
python3 -c "import json; d=json.load(open('data/opportunities.json')); print(f'{len(d)} opps')"
```
Expected: 12+ opportunities. If you see 0 or 1, STOP and restore from git history.

### Emergency restore:
```bash
cd /home/swarm/deal-health-app
# Find last good commit
git log --oneline -20
# Restore opportunities.json from a known good commit
git show <COMMIT>:data/opportunities.json > data/opportunities.json
# Or extract from data.js if opportunities.json wasn't committed:
python3 -c "
import json
with open('data.js') as f: c = f.read()
d = json.loads(c[c.index('{'):c.rindex('};')+1])
json.dump(d['opportunities'], open('data/opportunities.json','w'), indent=2)
print(f'Restored {len(d[\"opportunities\"])} opps')
"
# Then rebuild
node build-data.js
```

---

## Payload Schema for ingest-deal.js

The orchestrator writes this JSON to `data/incoming-payload.json`:

```json
{
  "salesforce": {
    "opportunityId": "006...",          ← REQUIRED: used as merge key
    "accountName": "Account Name",
    "accountId": "001...",
    "stage": "Demonstrate",
    "closeDate": "2026-03-31",
    "probability": 60,
    "forecastCategory": "Commit",
    "type": "New Business",
    "merchantIntent": "Committed - At Risk",
    "owner": "AE Name",
    "ownerEmail": "ae@shopify.com",
    "created": "2025-08-06",
    "revenue": {
      "mcv": 4582000,
      "totalRev3yr": 13756191,
      "d2cGmv": 162000000,
      "b2bGmv": null,
      "retailGmv": 8000000,
      "paymentsGpv": 210600000,
      "paymentsAttached": true,
      "ipp": 7943380
    },
    "projectedBilledRevenue": 6660618,
    "products": [
      {"name": "Product Name (SKU)", "amount": 4572000}
    ],
    "stakeholders": [
      {"name": "Name", "title": "Title", "role": "Economic Buyer", "email": "email@co.com"}
    ],
    "shopifyTeam": [
      {"name": "Name", "role": "Solutions Engineer", "email": "name@shopify.com"}
    ],
    "competitive": {
      "primary": "commercetools",
      "position": "Strong",
      "partner": "Fusefabric"
    },
    "timeline": {
      "created": "2025-08-06",
      "proposedLaunch": "2026-06-30",
      "region": "EMEA"
    },
    "compellingEvent": "Description...",
    "aeNextStep": "Next step text..."
  },
  "meddpicc_analysis": {
    "narrative": {
      "oppSummary": "...",
      "whyChange": "...",
      "whyShopify": "...",
      "whyNow": "...",
      "supportNeeded": "..."
    },
    "meddpicc": {
      "metrics": {
        "questions": [
          {"answer": "Yes", "notes": "...", "solution": "", "action": "", "due": ""},
          {"answer": "Partial", "notes": "...", "solution": "...", "action": "...", "due": "2026-03-07"}
        ]
      },
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
    {"title": "Call Title", "date": "2026-01-29", "duration": 45, "summary": "Brief summary..."}
  ]
}
```

### Key rules for the payload:
- `salesforce.opportunityId` is the **merge key** — ingest finds the existing opp by this ID
- MEDDPICC questions are matched **by array index** to the template in ingest-deal.js
- Each section must have the exact number of questions (metrics: 7, EB: 6, DP: 7, DC: 7, PP: 7, IP: 8, CH: 7, CO: 5)
- `answer` must be exactly `"Yes"`, `"No"`, or `"Partial"` (case-sensitive)
- Narratives go under `meddpicc_analysis.narrative` (NOT `meddpicc_analysis.narratives`)
- MEDDPICC sections go under `meddpicc_analysis.meddpicc` (NOT `meddpicc_analysis.sections`)

---

## Common Failures and Fixes

### "All my opportunities disappeared!"
**Cause:** `data/opportunities.json` was missing or contained only the new opp when ingest ran.
**Fix:** Restore from git history (see Emergency Restore above), then re-run ingest.

### "Score shows 0/54"
**Cause:** Payload used wrong nesting (e.g., `meddpicc_analysis.sections` instead of `meddpicc_analysis.meddpicc`).
**Fix:** Correct the payload nesting and re-ingest.

### "data.js has old scores but opportunities.json is correct"
**Cause:** `build-data.js` wasn't run after ingest, or wrote only to quick-deploy/.
**Fix:** Run `node build-data.js` — it now writes to BOTH root and quick-deploy/.

### "GitHub has different data than local"
**Cause:** Multiple directories pushing to same repo, or force-push from wrong state.
**Fix:** Verify local state, then `git push origin main --force` from the correct directory.
