# Daily Refresh Pipeline

## Two Modes — Never Mix Them

### Mode 1: NEW OPPORTUNITY (Full Pipeline)
When user provides a new Salesforce Opportunity ID → run the **full** pipeline:
```
SF Reader (all fields) → Salesloft (all calls) → Full MEDDPICC Analysis → ingest-deal.js → build-data.js → Push
```
No shortcuts. Every question scored. Every narrative written. All calls analyzed.

### Mode 2: DAILY REFRESH (Incremental Only)
For existing opportunities → check what changed since last analysis:
```
1. SF Reader (lightweight fields) → diff against stored values
2. Salesloft → "any NEW calls since {lastAnalysisDate}?"
3. Decision matrix:
   ┌─────────────┬────────────┬──────────────────────────────────────┐
   │ SF Changed? │ New Calls? │ Action                               │
   ├─────────────┼────────────┼──────────────────────────────────────┤
   │ No          │ No         │ SKIP — do nothing                    │
   │ Yes         │ No         │ lite-refresh.js (deterministic rules)│
   │ No          │ Yes        │ Incremental MEDDPICC (delta only)    │
   │ Yes         │ Yes        │ lite-refresh + incremental MEDDPICC  │
   └─────────────┴────────────┴──────────────────────────────────────┘
4. build-data.js → Push
```

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    DAILY REFRESH PIPELINE                       │
│                                                                │
│  daily-refresh.js --plan                                       │
│    ↓ Generates refresh plan with all opp metadata              │
│                                                                │
│  Orchestrator reads plan, delegates to agents:                 │
│    ├── WorkWithSalesforceReader (lightweight SF fields)         │
│    └── WorkWithSalesloftAgent ("new calls since {date}?")      │
│                                                                │
│  Orchestrator compares results → builds diffs.json             │
│                                                                │
│  SF diffs only:                                                │
│    └── lite-refresh.js --diffs diffs.json                      │
│        ├── Layer 1: score-rules.json (18 deterministic rules)  │
│        └── Layer 2: escalation-prompt.txt (for unmatched)      │
│                                                                │
│  New calls found:                                              │
│    └── WorkWithMEDDPICCAnalyst (incremental prompt)            │
│        Input: current state + NEW calls only + SF diffs        │
│        Output: delta JSON (changed questions + narratives)     │
│    └── daily-refresh.js --apply-incremental <result.json>      │
│                                                                │
│  build-data.js → data.js → git push                           │
└────────────────────────────────────────────────────────────────┘
```

---

## Files

| File | Purpose |
|------|---------|
| `daily-refresh.js` | Orchestration — plan generation + incremental apply |
| `lite-refresh.js` | Hybrid score engine — deterministic rules + LLM escalation |
| `score-rules.json` | 18 rules: SF field change → MEDDPICC question adjustment |
| `ingest-deal.js` | Full analysis ingestion (new opportunities only) |
| `build-data.js` | Score computation, action item filtering, history, data.js |
| `data/opportunities.json` | Source of truth for all opportunity data |
| `data/version-history.json` | Score change history with reasoning |

---

## Key Fields

### lastAnalysisDate
Every opportunity tracks `lastAnalysisDate` — the date of its last MEDDPICC analysis (full or incremental).

- Set by `ingest-deal.js` on full analysis
- Set by `daily-refresh.js --apply-incremental` on incremental
- Used by Salesloft check: "any calls after {lastAnalysisDate}?"

### Version History Types
- `type: "full"` — Initial full MEDDPICC analysis
- `type: "lite-refresh"` — Score rules applied from SF field changes
- `type: "incremental-meddpicc"` — Delta analysis from new calls

---

## Incremental MEDDPICC Prompt

When new calls are found, the orchestrator sends this to WorkWithMEDDPICCAnalyst:

```
INCREMENTAL MEDDPICC UPDATE — Do NOT re-analyze from scratch.

Account: {accountName}
Last full analysis: {lastAnalysisDate}

CURRENT STATE (preserve unless contradicted by new evidence):
{existing narratives — oppSummary, whyChange, whyShopify, whyNow, supportNeeded}
{existing MEDDPICC scores — all 54 questions with current answers and notes}

NEW INFORMATION:
{new call transcripts only — not old calls}
{SF field changes if any}

INSTRUCTIONS:
1. Review the new call transcripts and SF changes
2. Update ONLY the MEDDPICC questions directly affected by new evidence
3. Update narratives ONLY if new calls add meaningful new context
4. For each change, explain what new evidence triggered it
5. Keep all unchanged questions exactly as they are
6. Return ONLY the delta — questions that changed and updated narratives

Return JSON:
{
  "opportunityId": "006...",
  "narrativeUpdates": { "oppSummary": "updated or null", ... },
  "questionUpdates": [{
    "section": "economicBuyer",
    "questionIndex": 0,
    "oldAnswer": "Partial",
    "newAnswer": "Yes",
    "notes": "Updated notes...",
    "action": "",
    "due": "",
    "evidence": "Quote from new call..."
  }],
  "newCalls": [{ date, title, duration, shopifyAttendees, merchantAttendees, summary }],
  "newCallsSummary": "Brief summary of what was learned"
}
```

---

## Action Item Lifecycle

1. **Created**: Full MEDDPICC analysis generates actions for No/Partial questions
2. **Preserved**: Daily refresh keeps existing actions unless evidence changes them
3. **Auto-resolved**: When a question answer moves to Yes:
   - `lite-refresh.js` clears the action and logs `[Resolved {date}]` in notes
   - `daily-refresh.js --apply-incremental` does the same
4. **Filtered**: `build-data.js` skips questions answered Yes when generating nextSteps
5. **UI checkboxes**: Browser localStorage — per-user completion tracking (separate from server-side)

---

## Score Rules Summary (score-rules.json)

### Positive (bump up)
| SF Field | MEDDPICC Impact |
|----------|----------------|
| forecastCategory → Commit | Metrics Q5 → Yes, EB Q0 → Partial min, DP Q6 → Partial min |
| paymentsGpv 0 → >0 | DC Q3 → Yes, Metrics Q1 → Yes min |
| competitor → None | Competition Q0 → Yes, Q4 → Yes min, Q1 → Partial min |
| merchantIntent → Committed | Champion Q0 → Yes min, Metrics Q6 → Yes min |
| stage → Negotiate+ | PP Q0 → Partial min, DP Q0 → Partial min, PP Q4 → Partial min |

### Negative (cap down)
| SF Field | MEDDPICC Impact |
|----------|----------------|
| proposedLaunch pushed back | PP Q6 → Partial max, DP Q2 → Partial max, PP Q3 → Partial max |
| merchantIntent → Disengaged | Champion Q0 → No max |
