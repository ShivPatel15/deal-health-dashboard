# Daily Refresh Pipeline

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DAILY REFRESH PIPELINE                    │
│                                                             │
│  1. SF Reader pulls latest fields for all opps              │
│  2. Diff engine compares old vs new SF data                 │
│  3. Lite Refresh applies deterministic score rules          │
│  4. (If unmatched diffs) LLM escalation for ambiguous ones  │
│  5. Fast MEDDPICC pass updates narratives + action items    │
│  6. build-data.js recomputes scores, history, data.js       │
│  7. Site Publisher pushes to GitHub → Quick site goes live   │
└─────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose | Location |
|------|---------|----------|
| `ingest-deal.js` | Full analysis ingestion (SF + MEDDPICC + calls) | deal-health-app/ |
| `lite-refresh.js` | Hybrid score engine (rules + LLM escalation) | deal-health-app/ |
| `score-rules.json` | Deterministic SF field → MEDDPICC score mappings | deal-health-app/ |
| `build-data.js` | Rebuilds data.js from opportunities.json + version history | deal-health-app/ |
| `index.html` | Dashboard UI (version history, action items, MEDDPICC) | deal-health-dashboard/ |
| `data/opportunities.json` | Source of truth for all opportunity data | deal-health-app/data/ |
| `data/version-history.json` | Score change history with reasoning | deal-health-app/data/ |

## Score Rules (score-rules.json)

18 deterministic rules mapping SF field changes to MEDDPICC question adjustments:

### Positive Rules (bump scores up)
- `forecastCategory → Commit/Closed` → Metrics Q5 (Yes), Economic Buyer Q0 (Partial min), Decision Process Q6 (Partial min)
- `paymentsGpv 0 → >0` → Decision Criteria Q3 (Yes), Metrics Q1 (Yes min)
- `competitor → None/cleared` → Competition Q0 (Yes), Q4 (Yes min), Q1 (Partial min)
- `merchantIntent → Committed` → Champion Q0 (Yes min), Metrics Q6 (Yes min)
- `stage → Negotiate+` → Paper Process Q0 (Partial min), Decision Process Q0 (Partial min), Paper Process Q4 (Partial min)
- `contractSent → true` → Paper Process Q5 (Yes)

### Negative Rules (cap scores down)
- `proposedLaunch pushed back` → Paper Process Q6 (Partial max), Decision Process Q2 (Partial max), Paper Process Q3 (Partial max)
- `merchantIntent → Not Interested/Disengaged` → Champion Q0 (No max)

### Adjustment Types
- `setTo`: Force to specific answer (Yes/Partial/No)
- `minBump`: Bump UP to at least this level (never downgrade)
- `maxCap`: Cap DOWN to at most this level (never upgrade)

## Version History Format

Each entry in version-history.json:
```json
{
  "date": "2026-02-19",
  "totalScore": 39,
  "totalMax": 54,
  "status": "on-track",
  "type": "lite-refresh",
  "sectionScores": { "Metrics": 7, "Competition": 3 },
  "changes": [
    "Score improved by 0.5 points (38.5 → 39) — lite refresh",
    "Metrics Q5: Partial → Yes (+0.5) — Commit forecast implies metrics validated",
    "SF trigger: forecastCategory \"\" → \"Commit\" (upgraded)"
  ]
}
```

build-data.js preserves enriched history entries (with changes/type) and only overwrites empty ones.

## Action Items Lifecycle

Action items come from MEDDPICC question `action` fields. On daily refresh:
1. If a question answer changes from No/Partial → Yes, its action is considered resolved
2. New actions appear when full MEDDPICC analysis runs
3. Completed checkbox state persists in browser localStorage (per-user)
4. Server-side completion tracking: when a question scores Yes, its action is cleared

## TODO: Fast MEDDPICC Analysis

Current problem: Full MEDDPICC analysis (SF → Salesloft → MEDDPICC Analyst → Publish) 
takes ~3-4 delegations per opportunity and times out for multiple deals.

### Proposed: Incremental MEDDPICC Update

Instead of re-analyzing all transcripts, send to MEDDPICC Analyst:
1. Current MEDDPICC scores + narratives (existing state)
2. Only NEW call transcripts since last analysis
3. SF field diffs
4. Ask: "Update only the sections affected by new information"

This reduces the analysis scope from "analyze everything" to "what changed?"

### Proposed: Parallel Processing
- Process multiple opportunities simultaneously where possible
- SF data for all opps can be pulled in one batch query
- Salesloft calls can be checked for "new calls since last run" before pulling full transcripts
