# Incremental Update Pattern

## Problem
Full MEDDPICC re-analysis takes 10+ minutes per deal and requires full transcript re-processing. When the daily refresh detects SF field changes or new calls, we need a faster way to update:
- **Deal Risks** — derived from SF diffs (close date slips, PBR drops, stage changes)
- **Mutual Action Plan** — update milestones, mark completed items, adjust dates
- **Action Items / Next Steps** — close completed items, flag overdue, add new based on changes
- **Coaching Recommendations** — re-prioritized based on current state

## Solution: Incremental Update Flow

### When to trigger
Any deal where today's refresh detected:
1. A MEDDPICC score change (any section)
2. A material SF field change (stage, closeDate, probability, forecastCategory, competitor, nextStep with substantive change)
3. A new call transcript

### Data inputs
For each deal with changes, extract:
1. **Current state**: action items, MAP, nextSteps, dealRisks from `data.js`
2. **Today's diffs**: from `data/diffs.json`
3. **New call summaries**: AI summaries from BigQuery (already captured in refresh)

### MEDDPICC Analyst prompt
Send a focused incremental prompt:
```
INCREMENTAL UPDATE — Do NOT re-analyze from scratch.
Here's the current state of [Deal]. Here's what changed today: [diffs + new call summary].
Update accordingly — close completed items, add new ones, flag new risks.
Return structured JSON with: dealRisks, updatedActionItems, updatedMAP, topNextSteps.
```

### Data patching
Apply the returned updates to `data.js`:
- `opp.dealRisks` = updated risks
- `opp.nextSteps` = updated coaching recommendations  
- `opp.mutualActionPlan.items` = updated MAP items
- `opp.mutualActionPlan.goLiveDate` = updated if close date changed

### Performance
- ~1-2 minutes per deal (vs 10+ for full re-analysis)
- Can process 4-5 deals in parallel
- No BigQuery transcript queries needed (uses existing data + diffs)

## Implementation Status

### ✅ Proven (2026-02-25)
- Manually ran incremental updates for 4 deals: Dune, Direct Wines, Bugaboo, Trinny
- Updated risks, MAP, and next steps based on SF diffs
- Published to dashboard

### 🔲 TODO: Wire into daily-refresh.js
1. After score changes are computed, extract context for changed deals
2. Send incremental prompt to MEDDPICC Analyst
3. Patch results back into data.js before final publish
4. Add `--skip-incremental` flag for when full re-analysis is preferred
