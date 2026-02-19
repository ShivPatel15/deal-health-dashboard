# Daily Refresh Pipeline

## Last Updated: 2026-02-19 (v2 — BigQuery-first)

## Two Modes — Never Mix Them

### Mode 1: NEW OPPORTUNITY (Full Pipeline)
When user provides a new Salesforce Opportunity ID → run the **full** pipeline:
```
SF Reader (all fields) → BigQuery sales_calls (all transcripts) → Full MEDDPICC Analysis → ingest-deal.js → build-data.js → Push
```
No shortcuts. Every question scored. Every narrative written. All calls analyzed.

### Mode 2: DAILY REFRESH (Incremental Only)
For existing opportunities → check what changed since last analysis:
```
1. SF Reader (lightweight fields) → diff against stored values
2. BigQuery sales_calls → "any NEW calls since {lastCallDate}?"
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

⏸️ **Salesloft API is PAUSED.** BigQuery `sales_calls` is the primary transcript source. Only fall back to Salesloft API if BigQuery returns persistent 401 auth errors after retry.

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
│    └── BigQuery sales_calls ("new calls since {date}?") ⭐     │
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
│        Output: delta JSON (changed questions + narratives +    │
│                action items)                                   │
│    └── daily-refresh.js --apply-incremental <result.json>      │
│                                                                │
│  build-data.js                                                 │
│    ├── Recomputes scores from MEDDPICC answers                 │
│    ├── Regenerates nextSteps from MEDDPICC actions             │
│    ├── Updates version history                                 │
│    └── Outputs data.js                                         │
│                                                                │
│  Dashboard loads data.js                                       │
│    ├── coaching-engine.js auto-computes deal risk signals      │
│    └── coaching-engine.js auto-computes rep coaching tips      │
│                                                                │
│  git push → user deploys with quick deploy                     │
└────────────────────────────────────────────────────────────────┘
```

---

## BigQuery Call Check Queries

### Check for new calls (Step 2):
```sql
SELECT event_id, call_title, event_start, platform,
  call_duration_minutes, has_transcript,
  ARRAY_LENGTH(transcript_details) AS transcript_segments,
  transcript_summary
FROM `shopify-dw.sales.sales_calls`
WHERE '{ACCOUNT_ID}' IN UNNEST(salesforce_account_ids)
  AND DATE(event_start) > '{LAST_CALL_DATE}'
ORDER BY event_start DESC
```

### Pull full transcript for new calls:
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

---

## Files

| File | Purpose |
|------|---------|
| `daily-refresh.js` | Orchestration — plan generation + incremental apply |
| `lite-refresh.js` | Hybrid score engine — deterministic rules + LLM escalation |
| `score-rules.json` | 18 rules: SF field change → MEDDPICC question adjustment |
| `ingest-deal.js` | Full analysis ingestion (new opportunities only) |
| `build-data.js` | Score computation, nextSteps generation, history, data.js |
| `coaching-engine.js` | Client-side risk signals + rep coaching (auto-updates from scores) |
| `data/opportunities.json` | Source of truth for all opportunity data |
| `data/version-history.json` | Score change history with reasoning |

---

## Key Fields

### lastAnalysisDate
Every opportunity tracks `lastAnalysisDate` — the date of its last MEDDPICC analysis (full or incremental).

- Set by `ingest-deal.js` on full analysis
- Set by `daily-refresh.js --apply-incremental` on incremental
- Used by BigQuery check: "any calls after {lastCallDate}?"

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
{existing MEDDPICC scores — all 54 questions with current answers, notes, and action items}

NEW INFORMATION:
{new call transcripts only — not old calls}
{SF field changes if any}

INSTRUCTIONS:
1. Review the new call transcripts and SF changes
2. Update ONLY the MEDDPICC questions directly affected by new evidence
3. Update narratives ONLY if new calls add meaningful new context
4. For each change, explain what new evidence triggered it
5. Keep all unchanged questions exactly as they are
6. IMPORTANT — ACTION ITEM LIFECYCLE:
   a. If new evidence RESOLVES an existing gap (answer moves to Yes), clear the action item
   b. If new evidence PARTIALLY addresses a gap, update the action to reflect what's still needed
   c. If new calls reveal NEW gaps or risks, add NEW action items with due dates
   d. If an existing action's due date has passed, flag it as overdue and update
7. For 'supportNeeded' narrative: update based on what the new calls reveal about
   what Shopify still needs to do to land the deal
8. Return ONLY the delta — questions that changed and updated narratives

Return JSON:
{
  "opportunityId": "006...",
  "narrativeUpdates": { "oppSummary": "updated or null", "supportNeeded": "updated or null", ... },
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

## Downstream Update Chain

When MEDDPICC scores or actions change, the following cascade automatically:

```
MEDDPICC actions updated (opportunities.json)
       ↓
build-data.js runs
       ↓ generates:
       ├── scores (recomputed from answers)
       ├── nextSteps (regenerated from non-Yes actions)
       ├── history (version entry with changes)
       └── data.js
       ↓
Dashboard loads data.js
       ↓ client-side auto-computes:
       ├── deal risk signals (coaching-engine.js)
       ├── rep coaching tips (coaching-engine.js)
       └── Next Steps tab display
```

**build-data.js nextSteps logic:**
- Scans ALL MEDDPICC questions
- Questions answered **Yes** → action excluded (gap closed)
- Questions with non-empty `action` → included as next step
- Prioritized in section order (Metrics → Competition)

**coaching-engine.js (client-side, auto-updates):**
- `getDealRisks(opp)` → risk signals from scores + close date + call recency
- `getRepCoaching(owner, deals)` → rep coaching from aggregate scores
- No build step needed — runs from data.js on page load

---

## Action Item Lifecycle

1. **Created**: Full MEDDPICC analysis generates actions for No/Partial questions
2. **Preserved**: Daily refresh keeps existing actions unless evidence changes them
3. **Updated**: Incremental MEDDPICC can update, add, or resolve actions based on new calls
4. **Auto-resolved**: When a question answer moves to Yes:
   - `lite-refresh.js` clears the action and logs `[Resolved {date}]` in notes
   - `daily-refresh.js --apply-incremental` does the same
5. **Tracked**: `daily-refresh.js` logs action count changes: "Action items: X → Y (N resolved, M new)"
6. **Filtered**: `build-data.js` skips questions answered Yes when generating nextSteps
7. **UI checkboxes**: Browser localStorage — per-user completion tracking (separate from server-side)

---

## Version History

Entries include:
- Score delta summary: "Score improved by 0.5 points (38.5 → 39)"
- Per-question changes: "Metrics Q5: Partial → Yes (+0.5) — reason"
- Action item changes: "Action items: 30 → 27 (3 resolved, 0 new)"
- SF triggers: "forecastCategory '' → 'Commit'"
- `type: "lite-refresh"` or `"incremental-meddpicc"` to distinguish

---

## Post-Build Verification Checklist

After every build, verify:
- [ ] Scores match expected values (check build output log)
- [ ] Action count changed appropriately (resolved → decreased, new → increased)
- [ ] nextSteps tab shows updated items on dashboard
- [ ] Risk signals reflect new scores
- [ ] Version history entry logged with changes description

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
