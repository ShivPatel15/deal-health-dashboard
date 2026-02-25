# Daily Refresh — Orchestrator Prompt (v3)
# Last Updated: 2026-02-25

## Changes from v2:
## - Added Step 3.5: Incremental risk/MAP/action item updates
## - MEDDPICC Analyst prompt now includes action item lifecycle instructions
## - incremental-update.js replaces direct data.js editing
## - validate-before-push.sh runs before every push
## - quick deploy uses ./quick-deploy (3 files only)

---

STEP 0: Generate refresh plan
Run: node deal-health-app/scheduled-refresh.js --plan

This reads data/opportunities.json (source of truth) and outputs:
- A list of ALL opportunities with metadata (id, accountName, accountId, lastCallDate, currentScore)
- A SINGLE batched SOQL query to check ALL opportunities in one Salesforce call
- A SINGLE batched BigQuery query to check ALL accounts for new calls in one query
- A decision matrix for what to do per opportunity
- A refresh-plan.json file saved to data/ for reference

If resuming from a failed run, --plan will detect existing checkpoints from today and skip already-processed opportunities. It shows which are done and which remain.

STEP 1: Salesforce batch check
Run the SOQL query output by --plan via WorkWithSalesforceReader.

This is a SINGLE query for ALL opportunity IDs:
  SELECT Id, StageName, CloseDate, Probability, ForecastCategoryName,
         Merchant_Intent__c, NextStep, SE_Next_Steps__c,
         eComm_Amount__c, Projected_Billed_Revenue__c, Payments_GPV__c,
         Total_Revenue__c, Competitor__c, Position_Against_Competitor__c,
         Proposed_Launch_Date_Plus__c
  FROM Opportunity WHERE Id IN ('006...', '006...', ...)

Compare returned values against currentSfFields in the refresh plan to build diffs per opportunity.

STEP 2: BigQuery batch call check
Run the BigQuery SQL output by --plan. This is a SINGLE query with a CTE that checks ALL accounts at once:

WITH account_cutoffs AS (
  SELECT account_id, cutoff_date, opp_id
  FROM UNNEST([
    STRUCT('001...' AS account_id, DATE('2026-02-15') AS cutoff_date, '006...' AS opp_id),
    ...
  ])
)
SELECT ac.opp_id, ac.account_id, sc.event_id, sc.call_title, sc.event_start,
  sc.platform, sc.call_duration_minutes, sc.has_transcript,
  ARRAY_LENGTH(sc.transcript_details) AS transcript_segments,
  sc.transcript_summary, sc.attendee_details
FROM account_cutoffs ac
JOIN `shopify-dw.sales.sales_calls` sc
  ON ac.account_id IN UNNEST(sc.salesforce_account_ids)
  AND DATE(sc.event_start) > ac.cutoff_date
  AND DATE(sc.event_start) >= DATE_SUB(CURRENT_DATE(), INTERVAL 730 DAY)
ORDER BY ac.opp_id, sc.event_start DESC

Each opp's cutoff_date is set to its most recent call date from the calls array.

Use BigQuery — NOT the Salesloft API. Salesloft API is PAUSED.
Only fall back to Salesloft if BigQuery returns persistent 401 after retry.

If new calls have transcript_segments > 0, pull full transcripts in a second query:

SELECT sc.event_id, sc.call_title, sc.event_start,
  sentence.speaker_name, sentence.speaker_text, sentence.sequence_number
FROM `shopify-dw.sales.sales_calls` sc,
UNNEST(sc.transcript_details) AS transcript,
UNNEST(transcript.full_transcript) AS sentence
WHERE sc.event_id IN ('evt1', 'evt2', ...)
  AND sc.has_transcript = TRUE
  AND ARRAY_LENGTH(sc.transcript_details) > 0
ORDER BY sc.event_start DESC, sentence.sequence_number ASC

ONLY pull transcripts for NEW calls — do NOT re-pull old ones.

STEP 3: Process each opportunity based on results

For EACH opportunity, apply the decision matrix:

┌─────────────┬────────────┬──────────────────────────────────────────────────┐
│ SF Changed? │ New Calls? │ Action                                           │
├─────────────┼────────────┼──────────────────────────────────────────────────┤
│ No          │ No         │ SKIP — checkpoint as 'no-change'                 │
│ Yes         │ No         │ Write diffs → run lite-refresh.js                │
│ No or Yes   │ Yes        │ Pull transcripts → incremental MEDDPICC Analyst  │
└─────────────┴────────────┴──────────────────────────────────────────────────┘

After EACH opportunity, record progress:
  node deal-health-app/scheduled-refresh.js --checkpoint <oppId> <status> "<details>"
  Status values: no-change | sf-only | new-calls | error

This provides fault tolerance — if the run fails mid-way, re-running --plan will skip already-processed opportunities.

SF-only changes (no new calls):
  Create diffs JSON matching this format:
  [{ "opportunityId": "006...", "accountName": "...", "changes": [
    { "field": "forecastCategory", "oldValue": "", "newValue": "Commit" }
  ]}]
  Run: node deal-health-app/lite-refresh.js --diffs diffs.json

  lite-refresh.js applies deterministic score rules from score-rules.json (18 rules).
  If any SF changes don't match a rule, it generates an escalation-prompt.txt for
  lightweight LLM review. Send that to the MEDDPICC Analyst if present.

New calls found (with or without SF changes):
  If SF also changed, run lite-refresh.js for the diffs FIRST.
  Then send incremental MEDDPICC prompt to WorkWithMEDDPICCAnalyst:

  The incremental MEDDPICC prompt must include:
  - Current MEDDPICC state (all 54 questions with answers, notes, AND action items)
  - Current narratives (oppSummary, whyChange, whyShopify, whyNow, supportNeeded)
  - ONLY the new call transcripts from BigQuery
  - SF field diffs if any
  - Instruction: Update ONLY questions affected by new evidence. Return delta JSON only.

  ACTION ITEM LIFECYCLE instructions:
    a. If evidence RESOLVES a gap (answer moves to Yes), clear the action item
    b. If evidence PARTIALLY addresses a gap, update the action to what is still needed
    c. If new calls reveal NEW gaps or risks, add NEW action items with due dates
    d. If an existing action due date has passed, flag as overdue and update the due date
    e. Update supportNeeded narrative if calls change what Shopify needs to do to land the deal

  Apply the result:
    node deal-health-app/daily-refresh.js --apply-incremental data/incremental-{oppId}.json

  daily-refresh.js merges the delta into opportunities.json:
  - Applies narrative updates (only non-null values)
  - Applies question updates (answer, notes, solution, action, due)
  - Auto-resolves actions when answer moves to Yes (logs [Resolved] in notes)
  - Adds new calls to the calls array (with dedup)
  - Tracks action item count changes
  - Updates lastAnalysisDate
  - Writes version history entry (type: 'incremental-meddpicc')

You can check progress at any time:
  node deal-health-app/scheduled-refresh.js --status

STEP 3.5: Incremental risk, MAP, and action item updates ← NEW

After Step 3 processing is complete for ALL opportunities, identify which deals had
MATERIAL changes (any of: score change, stage change, close date change, new call,
significant revenue change, competitor change, forecast category change).

For each deal with material changes, send a FOCUSED incremental prompt to
WorkWithMEDDPICCAnalyst. DO NOT re-analyze from scratch. The prompt should include:

  1. The deal's current state:
     - SF field values (stage, close date, probability, PBR, competitor, forecast)
     - Current action items from MEDDPICC questions (section, question, answer, action, due)
     - Current MAP items (milestone, done status, owners, dates)
  2. Today's changes:
     - SF diffs (what changed and from/to values)
     - New call AI summaries (if any)
  3. Request structured JSON output:
     - dealRisks: contextual risks based on the changes (severity: high/medium/low, category)
     - newMAPItems: new milestones to ADD (not replace) to the MAP
     - completedMAPMilestones: existing milestones to mark as done
     - mapGoLiveDate: updated go-live date if close date changed
     - meddpiccUpdates: specific question-level changes (updated due dates for overdue items)

Then write the output as `data/incremental-updates.json` and run:

  node deal-health-app/incremental-update.js --input data/incremental-updates.json

This script:
  - Applies SF diffs to opportunity records (stage, closeDate, PBR, revenue, etc.)
  - Adds dealRisks array (brand new field — shows on dashboard Overview tab)
  - MERGES new MAP items into existing MAP (inserts before "Contract signed" milestone)
  - Marks completed MAP milestones as done
  - Updates go-live date
  - Applies MEDDPICC question-level changes (due date updates, answer changes)
  - SAFETY: Validates opp count before/after, checks MEDDPICC integrity, never removes data

incremental-updates.json format:
  {
    "OPPORTUNITY_ID": {
      "sfDiffs": [
        { "field": "closeDate", "newValue": "2026-03-30" },
        { "field": "stage", "newValue": "Deal Craft" },
        { "field": "projectedBilledRevenue", "newValue": 3813618.5 },
        { "field": "revenue.mcv", "newValue": 0 }
      ],
      "dealRisks": [
        { "risk": "PBR dropped 43%...", "severity": "high", "category": "commercial" }
      ],
      "newMAPItems": [
        { "milestone": "Board meeting", "done": false, "ownerShopify": "Ben",
          "ownerMerchant": "Neil", "date": "2026-03-24", "notes": "Decision event" }
      ],
      "completedMAPMilestones": ["Initial discovery & intro calls"],
      "mapGoLiveDate": "2026-03-31",
      "meddpiccUpdates": [
        { "section": "economicBuyer", "questionIndex": 2,
          "updates": { "due": "03/04/2026" } }
      ]
    }
  }

IMPORTANT: This step uses incremental-update.js which modifies opportunities.json
(the source of truth), NOT data.js directly. data.js is rebuilt in Step 4.

STEP 4: Build and publish
If ANY opportunity changed:

  First rebuild data.js from the updated opportunities.json:
    node deal-health-app/build-data.js

  build-data.js:
  - Recomputes scores from MEDDPICC answers
  - Regenerates nextSteps/action items from all non-Yes MEDDPICC questions
  - Updates version history (preserves enriched changes from lite-refresh)
  - Appends a coaching snapshot for each opportunity
  - Auto-generates MAP for new opps that don't have one
  - Passes through existing MAPs and dealRisks unchanged
  - Writes data.js to BOTH root and quick-deploy/

  Then validate:
    bash deal-health-app/validate-before-push.sh

  validate-before-push.sh checks:
  - quick-deploy/ has all 3 required files (index.html, data.js, coaching-engine.js)
  - data.js and quick-deploy/data.js are identical
  - 10+ opportunities present
  - Every opp has meddpicc (8 sections), nextSteps, MAP, narrative, scores
  - coaching-engine.js is valid JS

  If validation passes, commit and push:
    git add -A
    git commit -m "Daily refresh YYYY-MM-DD: <summary>"
    git push origin main

  OR use publish.sh which does build + validate + commit + push:
    bash deal-health-app/publish.sh --skip-ingest "Daily refresh YYYY-MM-DD: <summary>"

Then finalize the refresh log:
  node deal-health-app/scheduled-refresh.js --finalize

STEP 5: Verify and report
After build, confirm from the build output log:
- Scores updated correctly for changed opportunities
- Action item counts changed appropriately (resolved → decreased, new → increased)
- Version history entries logged with score changes AND action item changes
- Coaching snapshots incremented
- MAP item counts present (new items added, no items removed)
- Deal risks populated for deals with material changes
- The coaching engine, deal risk signals, rep coaching drill-down trends, and MAP tab
  all auto-update client-side from the new scores in data.js

Report to user:
- Which opportunities changed and why (SF diffs, new calls, or both)
- Score deltas per opportunity
- Action items resolved/added
- Deal risks generated (count by severity)
- New MAP milestones added
- Which opportunities had no changes (skipped)
- Any errors encountered
- Reminder to deploy:
    cd ~/deal-health-dashboard
    git pull
    quick deploy ./quick-deploy deal-health --force

CRITICAL RULES:
- This is an INCREMENTAL daily refresh — NOT a full analysis
- Use scheduled-refresh.js for orchestration (--plan, --checkpoint, --status, --finalize)
- Use BATCHED queries — one SOQL for all opps, one BigQuery for all accounts
- Do NOT run per-opportunity SF or BigQuery queries — the plan generates batch SQL
- Do NOT re-run full MEDDPICC analysis on existing data
- Do NOT overwrite existing narratives unless new calls add genuinely new context
- Do NOT re-pull old call transcripts — only new ones since lastCallDate
- Do NOT use the Salesloft API unless BigQuery auth fails after retry
- If nothing changed for an opportunity, checkpoint as 'no-change' and move on
- If BigQuery lookup fails, keep existing call data — never delete
- Process ALL opportunities in the file — new ones may have been added
- NEVER edit data.js directly — always modify opportunities.json then rebuild with build-data.js
- NEVER replace arrays (nextSteps, MAP items) — always merge/append via incremental-update.js
- Always run validate-before-push.sh before pushing
- Always deploy from ./quick-deploy (3 files: index.html, data.js, coaching-engine.js)
- Do NOT overwrite mutualActionPlan on existing opportunities — incremental-update.js MERGES
- Coaching snapshots MUST be appended on every build
- Always checkpoint after each opportunity for fault tolerance
- Deal risks are additive — they replace the previous set for that opp, not append
