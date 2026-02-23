#!/usr/bin/env node
// ============================================================
// SCHEDULED-REFRESH.JS — Resilient daily refresh orchestrator
//
// Replaces the monolithic swarm scheduled prompt with a Node.js
// script that generates a concise refresh plan the swarm can
// execute in a single, focused pass.
//
// KEY DESIGN PRINCIPLES:
// 1. Checkpoint after each opportunity — resume on failure
// 2. Generate a single BigQuery query for ALL accounts (not N queries)
// 3. Generate a concise action plan — minimal swarm context needed
// 4. Heartbeat logging — always know if the refresh ran
// 5. Graceful degradation — partial success > total failure
//
// USAGE (by the swarm scheduled prompt):
//   node scheduled-refresh.js --plan
//     → Reads opportunities.json
//     → Outputs a refresh plan with per-opp metadata
//     → Generates BigQuery SQL to check ALL accounts at once
//     → The swarm executes the plan step by step
//
//   node scheduled-refresh.js --checkpoint <oppId> <status> [details]
//     → Records that an opportunity has been processed
//     → Allows resumption if the swarm dies mid-run
//
//   node scheduled-refresh.js --status
//     → Shows what's been processed today, what's remaining
//
//   node scheduled-refresh.js --finalize
//     → Writes the refresh log, clears checkpoints
//     → Run after all opportunities are done
//
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OPP_FILE = path.join(DATA_DIR, 'opportunities.json');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'refresh-checkpoint.json');
const LOG_DIR = path.join(DATA_DIR, 'refresh-logs');

// ============================================================
// HELPERS
// ============================================================

function today() {
  return new Date().toISOString().split('T')[0];
}

function loadOpportunities() {
  return JSON.parse(fs.readFileSync(OPP_FILE, 'utf-8'));
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    if (cp.date === today()) return cp;
  }
  return { date: today(), started: new Date().toISOString(), results: {} };
}

function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// ============================================================
// PLAN — Generate the refresh plan
// ============================================================
function generatePlan() {
  const opps = loadOpportunities();
  const cp = loadCheckpoint();
  const alreadyDone = Object.keys(cp.results);

  console.log(`\n📋 DAILY REFRESH PLAN — ${today()}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`   Total opportunities: ${opps.length}`);
  console.log(`   Already processed today: ${alreadyDone.length}`);
  console.log(`   Remaining: ${opps.length - alreadyDone.length}`);

  if (alreadyDone.length > 0) {
    console.log(`\n   ⏩ RESUMING from checkpoint (${alreadyDone.length} already done)`);
    for (const id of alreadyDone) {
      const r = cp.results[id];
      console.log(`      ✅ ${r.accountName}: ${r.status}${r.details ? ' — ' + r.details : ''}`);
    }
  }

  // Build per-opportunity metadata
  const oppMeta = opps.map(o => {
    const lastCallDate = (o.calls && o.calls.length > 0)
      ? o.calls.reduce((latest, c) => c.date > latest ? c.date : latest, '1970-01-01')
      : '1970-01-01';

    return {
      id: o.id,
      accountName: o.accountName,
      accountId: o.accountId,
      lastAnalysisDate: o.lastAnalysisDate || 'never',
      lastCallDate,
      owner: o.owner,
      closeDate: o.closeDate,
      currentScore: o.scores?._total?.score || 'N/A',
      currentMax: o.scores?._total?.max || 'N/A',
      alreadyDone: alreadyDone.includes(o.id),
    };
  });

  const remaining = oppMeta.filter(o => !o.alreadyDone);

  // Build a SINGLE BigQuery query that checks ALL accounts for new calls at once
  // This avoids N separate queries and gets all data in one shot
  const accountConditions = remaining.map(o => {
    return `('${o.accountId}', '${o.lastCallDate}', '${o.id}')`;
  }).join(',\n    ');

  const batchCallCheckSQL = `-- BATCH CALL CHECK: One query for all ${remaining.length} accounts
-- Returns new calls (if any) since each account's last known call date
WITH account_cutoffs AS (
  SELECT account_id, cutoff_date, opp_id
  FROM UNNEST([
    ${remaining.map(o => `STRUCT('${o.accountId}' AS account_id, DATE('${o.lastCallDate}') AS cutoff_date, '${o.id}' AS opp_id)`).join(',\n    ')}
  ])
)
SELECT
  ac.opp_id,
  ac.account_id,
  sc.event_id,
  sc.call_title,
  sc.event_start,
  sc.platform,
  sc.call_duration_minutes,
  sc.has_transcript,
  ARRAY_LENGTH(sc.transcript_details) AS transcript_segments,
  sc.transcript_summary,
  sc.attendee_details
FROM account_cutoffs ac
JOIN \`shopify-dw.sales.sales_calls\` sc
  ON ac.account_id IN UNNEST(sc.salesforce_account_ids)
  AND DATE(sc.event_start) > ac.cutoff_date
  AND DATE(sc.event_start) >= DATE_SUB(CURRENT_DATE(), INTERVAL 730 DAY)
ORDER BY ac.opp_id, sc.event_start DESC`;

  // Build lightweight SF check fields
  const sfCheckFields = [
    'StageName', 'CloseDate', 'Probability', 'ForecastCategoryName',
    'Merchant_Intent__c', 'NextStep', 'SE_Next_Steps__c',
    'eComm_Amount__c', 'Projected_Billed_Revenue__c', 'Payments_GPV__c',
    'Total_Revenue__c', 'Competitor__c', 'Position_Against_Competitor__c',
    'Proposed_Launch_Date_Plus__c',
  ];

  // Build a single SOQL query for all opportunity IDs
  const oppIds = remaining.map(o => `'${o.id}'`).join(', ');
  const sfBatchQuery = `SELECT Id, ${sfCheckFields.join(', ')} FROM Opportunity WHERE Id IN (${oppIds})`;

  // Output the plan
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 OPPORTUNITIES TO CHECK (${remaining.length}):`);
  console.log(`${'─'.repeat(60)}`);

  for (const o of remaining) {
    console.log(`\n   ${o.accountName} (${o.id})`);
    console.log(`      Owner: ${o.owner} | Close: ${o.closeDate} | Score: ${o.currentScore}/${o.currentMax}`);
    console.log(`      Account ID: ${o.accountId}`);
    console.log(`      Last analysis: ${o.lastAnalysisDate} | Last call: ${o.lastCallDate}`);
  }

  // Output the queries the swarm should run
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 STEP 1: Salesforce Batch Check`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`\nRun this SOQL via WorkWithSalesforceReader:\n`);
  console.log(sfBatchQuery);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 STEP 2: BigQuery Batch Call Check`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`\nRun this BigQuery SQL:\n`);
  console.log(batchCallCheckSQL);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 STEP 3: Process Results`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`
For EACH opportunity, compare SF results vs stored values in opportunities.json.
For EACH opportunity, check if BigQuery returned any new calls.

Decision matrix:
┌─────────────┬────────────┬──────────────────────────────────────┐
│ SF Changed? │ New Calls? │ Action                               │
├─────────────┼────────────┼──────────────────────────────────────┤
│ No          │ No         │ SKIP — checkpoint as 'no-change'     │
│ Yes         │ No         │ Write diffs → run lite-refresh.js    │
│ Any         │ Yes        │ Pull transcripts → MEDDPICC Analyst  │
└─────────────┴────────────┴──────────────────────────────────────┘

After EACH opportunity, run:
  node scheduled-refresh.js --checkpoint <oppId> <status> "<details>"

Status values: no-change, sf-only, new-calls, error
`);

  console.log(`${'═'.repeat(60)}`);
  console.log(`🔍 STEP 4: Build & Push`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`
If ANY opportunity changed:
  bash publish.sh --skip-ingest "Daily refresh ${today()}: <summary>"

Then run:
  node scheduled-refresh.js --finalize
`);

  // Write the plan to a file for reference
  const planFile = path.join(DATA_DIR, 'refresh-plan.json');
  const plan = {
    date: today(),
    totalOpportunities: opps.length,
    remaining: remaining.length,
    alreadyDone: alreadyDone.length,
    opportunities: oppMeta,
    sfBatchQuery,
    bqBatchCallCheckSQL: batchCallCheckSQL,
    sfCheckFields,
  };
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  console.log(`\n📄 Plan saved to: ${planFile}`);

  return plan;
}

// ============================================================
// CHECKPOINT — Record per-opportunity progress
// ============================================================
function recordCheckpoint(oppId, status, details) {
  const opps = loadOpportunities();
  const opp = opps.find(o => o.id === oppId);
  const cp = loadCheckpoint();

  cp.results[oppId] = {
    accountName: opp ? opp.accountName : 'Unknown',
    status,
    details: details || '',
    timestamp: new Date().toISOString(),
  };

  saveCheckpoint(cp);

  const total = opps.length;
  const done = Object.keys(cp.results).length;
  const remaining = total - done;

  console.log(`\n✅ Checkpoint: ${opp ? opp.accountName : oppId} → ${status}`);
  if (details) console.log(`   Details: ${details}`);
  console.log(`   Progress: ${done}/${total} (${remaining} remaining)`);
}

// ============================================================
// STATUS — Show current progress
// ============================================================
function showStatus() {
  const opps = loadOpportunities();
  const cp = loadCheckpoint();
  const done = Object.keys(cp.results).length;

  console.log(`\n📊 REFRESH STATUS — ${today()}`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`   Started: ${cp.started || 'N/A'}`);
  console.log(`   Progress: ${done}/${opps.length}`);
  console.log('');

  // Count by status
  const statusCounts = {};
  for (const r of Object.values(cp.results)) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  for (const [status, count] of Object.entries(statusCounts)) {
    const emoji = status === 'no-change' ? '⏭️' : status === 'sf-only' ? '🔄' : status === 'new-calls' ? '📞' : status === 'error' ? '❌' : '❓';
    console.log(`   ${emoji} ${status}: ${count}`);
  }

  console.log('\n   Details:');
  for (const opp of opps) {
    const r = cp.results[opp.id];
    if (r) {
      const emoji = r.status === 'no-change' ? '⏭️' : r.status === 'sf-only' ? '🔄' : r.status === 'new-calls' ? '📞' : r.status === 'error' ? '❌' : '❓';
      console.log(`   ${emoji} ${opp.accountName}: ${r.status}${r.details ? ' — ' + r.details : ''}`);
    } else {
      console.log(`   ⏳ ${opp.accountName}: pending`);
    }
  }

  // Show remaining
  const remaining = opps.filter(o => !cp.results[o.id]);
  if (remaining.length > 0) {
    console.log(`\n   ⏳ Remaining (${remaining.length}):`);
    for (const o of remaining) {
      console.log(`      - ${o.accountName} (${o.id})`);
    }
  }
}

// ============================================================
// FINALIZE — Write refresh log, clear checkpoint
// ============================================================
function finalize() {
  const cp = loadCheckpoint();
  const opps = loadOpportunities();

  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const logFile = path.join(LOG_DIR, `refresh-${today()}.json`);
  const log = {
    date: today(),
    started: cp.started,
    finished: new Date().toISOString(),
    totalOpportunities: opps.length,
    processed: Object.keys(cp.results).length,
    results: cp.results,
    summary: {
      noChange: Object.values(cp.results).filter(r => r.status === 'no-change').length,
      sfOnly: Object.values(cp.results).filter(r => r.status === 'sf-only').length,
      newCalls: Object.values(cp.results).filter(r => r.status === 'new-calls').length,
      errors: Object.values(cp.results).filter(r => r.status === 'error').length,
      skipped: opps.length - Object.keys(cp.results).length,
    },
  };

  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));

  // Clear checkpoint (it's been saved to the log)
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
  }

  console.log(`\n✅ REFRESH FINALIZED — ${today()}`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`   Log saved: ${logFile}`);
  console.log(`   Processed: ${log.processed}/${log.totalOpportunities}`);
  console.log(`   No change: ${log.summary.noChange}`);
  console.log(`   SF only:   ${log.summary.sfOnly}`);
  console.log(`   New calls: ${log.summary.newCalls}`);
  console.log(`   Errors:    ${log.summary.errors}`);
  console.log(`   Skipped:   ${log.summary.skipped}`);
  console.log(`   Duration:  ${cp.started} → ${log.finished}`);

  return log;
}

// ============================================================
// MAIN
// ============================================================
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case '--plan':
    generatePlan();
    break;

  case '--checkpoint':
    if (!args[1] || !args[2]) {
      console.error('Usage: node scheduled-refresh.js --checkpoint <oppId> <status> [details]');
      console.error('  Status: no-change | sf-only | new-calls | error');
      process.exit(1);
    }
    recordCheckpoint(args[1], args[2], args.slice(3).join(' '));
    break;

  case '--status':
    showStatus();
    break;

  case '--finalize':
    finalize();
    break;

  default:
    console.log(`
Deal Health Scheduled Refresh — Resilient Orchestrator

Usage:
  node scheduled-refresh.js --plan          Generate refresh plan (start here)
  node scheduled-refresh.js --checkpoint    Record per-opp progress
  node scheduled-refresh.js --status        Show current progress
  node scheduled-refresh.js --finalize      Write log, clear checkpoints

The --plan command outputs:
  1. A batched SOQL query to check ALL opps in one Salesforce call
  2. A batched BigQuery query to check ALL accounts for new calls
  3. A decision matrix for what to do with each opportunity
  4. Checkpoint instructions for fault tolerance
`);
}
