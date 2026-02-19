#!/usr/bin/env node
// ============================================================
// DAILY-REFRESH.JS
// Orchestration script for the daily refresh pipeline.
//
// This script does NOT call external APIs directly.
// It prepares the inputs and instructions for the swarm orchestrator.
//
// Two modes of operation:
//
// 1. NEW OPPORTUNITY (full pipeline):
//    SF Reader → Salesloft (all calls) → Full MEDDPICC Analysis → Ingest → Build → Push
//    Triggered by: user provides a new Opportunity ID
//
// 2. DAILY REFRESH (incremental):
//    For each existing opportunity:
//    a) Pull latest SF fields → diff against stored data
//    b) Check Salesloft for new calls since lastAnalysisDate
//    c) If SF diffs only → lite-refresh.js (deterministic score rules)
//    d) If new calls found → incremental MEDDPICC (delta-only analysis)
//    e) Build → Push
//
// Usage:
//   node daily-refresh.js --plan              # Outputs the refresh plan (what to do)
//   node daily-refresh.js --apply-diffs <file> # Apply SF diffs via lite-refresh
//   node daily-refresh.js --apply-incremental <file> # Apply incremental MEDDPICC results
//
// The swarm orchestrator reads the plan and delegates to agents accordingly.
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OPP_FILE = path.join(DATA_DIR, 'opportunities.json');

// ============================================================
// PLAN: Generate refresh instructions for the orchestrator
// ============================================================
function generatePlan() {
  const opportunities = JSON.parse(fs.readFileSync(OPP_FILE, 'utf-8'));
  const today = new Date().toISOString().split('T')[0];

  const plan = {
    date: today,
    type: 'daily_refresh',
    opportunities: [],
    instructions: {},
  };

  for (const opp of opportunities) {
    const lastAnalysis = opp.lastAnalysisDate || '2026-01-01';
    const calls = opp.calls || [];
    const lastCallDate = calls.length > 0
      ? calls.reduce((latest, c) => c.date > latest ? c.date : latest, '1970-01-01')
      : null;

    plan.opportunities.push({
      id: opp.id,
      accountName: opp.accountName,
      accountId: opp.accountId || '',
      owner: opp.owner || '',
      lastAnalysisDate: lastAnalysis,
      lastCallDate: lastCallDate,
      currentScore: {
        total: getTotalScore(opp),
        max: 54,
      },
      // What to check
      checkSalesforce: true,
      checkSalesloft: true,
      salesloftLookup: opp.accountName,
      // SF fields to compare (current values)
      currentSfFields: {
        stage: opp.stage || '',
        closeDate: opp.closeDate || '',
        forecastCategory: opp.forecastCategory || '',
        probability: opp.probability || 0,
        merchantIntent: opp.merchantIntent || '',
        'revenue.mcv': opp.revenue?.mcv || 0,
        'revenue.paymentsGpv': opp.revenue?.paymentsGpv || 0,
        'revenue.totalRev3yr': opp.revenue?.totalRev3yr || 0,
        projectedBilledRevenue: opp.projectedBilledRevenue || null,
        'competitive.primary': opp.competitive?.primary || opp.competitor || '',
        'timeline.proposedLaunch': opp.timeline?.proposedLaunch || '',
        aeNextStep: opp.aeNextStep || opp.nextStep || '',
      },
    });
  }

  // Instructions for the orchestrator
  plan.instructions = {
    step1_salesforce: `For EACH opportunity, delegate to WorkWithSalesforceReader:
      "Pull the following fields for opportunity {id}:
       stage, closeDate, forecastCategory, probability, merchantIntent,
       revenue (MCV, Payments GPV, Total Rev 3yr), Projection_of_Billed_Revenue__c,
       competitive notes, proposed launch date, AE next steps"
      Compare returned values against currentSfFields. Build a diffs array.`,

    step2_salesloft: `For EACH opportunity, delegate to WorkWithSalesloftAgent:
      "For account '{accountName}', are there any calls or meetings AFTER {lastAnalysisDate}?
       If yes, return full transcripts, attendees, dates, and summaries for NEW calls only.
       Do NOT re-pull calls from before {lastAnalysisDate}."`,

    step3_decide: `For each opportunity, based on results:

      | SF Changed? | New Calls? | Action                                               |
      |-------------|------------|------------------------------------------------------|
      | No          | No         | SKIP — no changes needed                             |
      | Yes         | No         | Run lite-refresh.js with SF diffs (Layer 1 rules)    |
      | No          | Yes        | Run incremental MEDDPICC (delta analysis)            |
      | Yes         | Yes        | Run lite-refresh for SF diffs + incremental MEDDPICC |`,

    step4_lite_refresh: `If SF diffs exist, create diffs.json and run:
      node lite-refresh.js --diffs data/diffs-{date}.json
      This applies deterministic score rules. Check output for unmatched diffs.`,

    step5_incremental_meddpicc: `If new calls exist, delegate to WorkWithMEDDPICCAnalyst with this prompt:

      "INCREMENTAL MEDDPICC UPDATE — Do NOT re-analyze from scratch.

       Account: {accountName}
       Last full analysis: {lastAnalysisDate}

       CURRENT STATE (preserve unless contradicted by new evidence):
       {existing narratives}
       {existing MEDDPICC scores — all 54 questions with current answers}

       NEW INFORMATION:
       {new call transcripts only}
       {SF field changes if any}

       INSTRUCTIONS:
       1. Review the new call transcripts and SF changes
       2. Update ONLY the MEDDPICC questions directly affected by new evidence
       3. Update narratives ONLY if new calls add meaningful new context
       4. For each change, explain what new evidence triggered it
       5. Keep all unchanged questions exactly as they are
       6. Return ONLY the delta — questions that changed and updated narratives

       Return JSON format:
       {
         'narrativeUpdates': {
           'oppSummary': 'updated text or null if unchanged',
           'whyChange': null,
           ...
         },
         'questionUpdates': [
           {
             'section': 'metrics',
             'questionIndex': 2,
             'oldAnswer': 'Partial',
             'newAnswer': 'Yes',
             'notes': 'Updated notes with new evidence',
             'solution': 'updated or null',
             'action': 'updated or empty if resolved',
             'due': 'updated or empty',
             'evidence': 'Quote or reference from new call that triggered this change'
           }
         ],
         'newCallsSummary': 'Brief summary of what was learned from the new calls'
       }"`,

    step6_apply_incremental: `Apply the incremental results:
      node daily-refresh.js --apply-incremental data/incremental-{oppId}.json
      This merges the delta into opportunities.json and updates lastAnalysisDate.`,

    step7_build_push: `After all opportunities are processed:
      node build-data.js
      Copy data.js to dashboard repo
      Git commit & push`,
  };

  return plan;
}

// ============================================================
// APPLY INCREMENTAL: Merge MEDDPICC delta into opportunity
// ============================================================
function applyIncremental(incrementalFile) {
  const incremental = JSON.parse(fs.readFileSync(incrementalFile, 'utf-8'));
  const opportunities = JSON.parse(fs.readFileSync(OPP_FILE, 'utf-8'));

  const oppId = incremental.opportunityId;
  const opp = opportunities.find(o => o.id === oppId);
  if (!opp) {
    console.error(`❌ Opportunity ${oppId} not found`);
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0];
  const changes = [];

  console.log(`\n🔄 Applying incremental MEDDPICC update for ${opp.accountName}`);

  // 1. Apply narrative updates
  const narUpdates = incremental.narrativeUpdates || {};
  for (const [key, value] of Object.entries(narUpdates)) {
    if (value && value !== null) {
      const oldLen = (opp.narrative?.[key] || '').length;
      if (!opp.narrative) opp.narrative = {};
      opp.narrative[key] = value;
      changes.push(`Narrative ${key} updated (${oldLen} → ${value.length} chars)`);
      console.log(`   📝 ${key}: updated (${oldLen} → ${value.length} chars)`);
    }
  }

  // 2. Apply question updates
  const qUpdates = incremental.questionUpdates || [];
  for (const qu of qUpdates) {
    const section = opp.meddpicc?.[qu.section];
    if (!section || !section.questions || !section.questions[qu.questionIndex]) {
      console.log(`   ⚠️ Section ${qu.section}[${qu.questionIndex}] not found — skipping`);
      continue;
    }

    const q = section.questions[qu.questionIndex];
    const oldAnswer = q.answer;
    const oldScore = q.score;

    if (qu.newAnswer) q.answer = qu.newAnswer;
    q.score = q.answer === 'Yes' ? 1 : q.answer === 'Partial' ? 0.5 : 0;
    if (qu.notes) q.notes = qu.notes;
    if (qu.solution !== undefined) q.solution = qu.solution || '';
    if (qu.action !== undefined) q.action = qu.action || '';
    if (qu.due !== undefined) q.due = qu.due || '';

    // If answer moved to Yes, auto-resolve action
    if (q.answer === 'Yes' && oldAnswer !== 'Yes' && q.action) {
      const resolvedNote = `[Resolved ${today}] ${q.action}`;
      q.notes = q.notes ? `${q.notes}\n${resolvedNote}` : resolvedNote;
      q.action = '';
      q.due = '';
    }

    const delta = q.score - oldScore;
    const label = section.label || qu.section;
    changes.push(`${label} Q${qu.questionIndex}: ${oldAnswer} → ${q.answer} (${delta > 0 ? '+' : ''}${delta}) — ${qu.evidence || 'new call evidence'}`);
    console.log(`   ${delta > 0 ? '⬆️' : delta < 0 ? '⬇️' : '➡️'}  ${label} Q${qu.questionIndex}: ${oldAnswer} → ${q.answer} (${delta > 0 ? '+' : ''}${delta})`);
    if (qu.evidence) console.log(`      Evidence: "${qu.evidence.substring(0, 100)}..."`);
  }

  // 3. Add new calls
  const newCalls = incremental.newCalls || [];
  for (const call of newCalls) {
    opp.calls = opp.calls || [];
    // Avoid duplicates
    const exists = opp.calls.some(c => c.date === call.date && c.title === call.title);
    if (!exists) {
      opp.calls.push(call);
      changes.push(`New call added: "${call.title}" on ${call.date}`);
      console.log(`   📞 New call: "${call.title}" on ${call.date}`);
    }
  }

  // 4. Update lastAnalysisDate
  opp.lastAnalysisDate = today;

  // 5. Compute score delta
  const oldScore = getTotalScore(opp); // Already updated in-memory, so compute before for comparison
  // Actually we need old score before changes — it's in the plan. For now just note:
  const newScore = computeTotalScore(opp);

  if (incremental.newCallsSummary) {
    changes.unshift(`Incremental analysis: ${incremental.newCallsSummary}`);
  }

  // 6. Update version history
  updateVersionHistoryForIncremental(opp, changes);

  // 7. Save
  fs.writeFileSync(OPP_FILE, JSON.stringify(opportunities, null, 2));

  console.log(`\n   📊 Score: ${newScore}/54`);
  console.log(`   📅 lastAnalysisDate → ${today}`);
  console.log(`   💾 Saved to opportunities.json`);
  console.log(`   📝 ${changes.length} changes logged to version history`);

  return { oppId, accountName: opp.accountName, changes, newScore };
}

// ============================================================
// HELPERS
// ============================================================
function getTotalScore(opp) {
  let total = 0;
  for (const sec of Object.values(opp.meddpicc || {})) {
    for (const q of (sec.questions || [])) {
      total += (q.score || 0);
    }
  }
  return total;
}

function computeTotalScore(opp) {
  return getTotalScore(opp);
}

function updateVersionHistoryForIncremental(opp, changes) {
  const HISTORY_FILE = path.join(DATA_DIR, 'version-history.json');
  let versionHistory = {};
  if (fs.existsSync(HISTORY_FILE)) {
    versionHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  }

  const today = new Date().toISOString().split('T')[0];
  const oppHistory = versionHistory[opp.id] || [];

  // Compute section scores
  const sectionScores = {};
  let totalScore = 0;
  let totalMax = 0;
  for (const [key, section] of Object.entries(opp.meddpicc || {})) {
    if (!section || !section.questions) continue;
    const sScore = section.questions.reduce((sum, q) => sum + (q.score || 0), 0);
    const sMax = section.questions.length;
    sectionScores[section.label || key] = sScore;
    totalScore += sScore;
    totalMax += sMax;
  }
  const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  const status = pct >= 75 ? 'good-health' : pct >= 50 ? 'on-track' : 'at-risk';

  const entry = {
    date: today,
    totalScore,
    totalMax,
    status,
    sectionScores,
    changes,
    type: 'incremental-meddpicc',
  };

  // Update or append
  const lastIdx = oppHistory.length - 1;
  if (lastIdx >= 0 && oppHistory[lastIdx].date === today) {
    // Merge changes if there's already an entry for today (e.g., lite-refresh ran first)
    const existing = oppHistory[lastIdx];
    existing.totalScore = totalScore;
    existing.totalMax = totalMax;
    existing.status = status;
    existing.sectionScores = sectionScores;
    existing.changes = [...(existing.changes || []), ...changes];
    existing.type = 'incremental-meddpicc'; // Upgrade type
  } else {
    oppHistory.push(entry);
  }

  versionHistory[opp.id] = oppHistory;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(versionHistory, null, 2));
}

// ============================================================
// MAIN
// ============================================================
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--plan')) {
    const plan = generatePlan();
    const planFile = path.join(DATA_DIR, `refresh-plan-${plan.date}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    console.log(`\n📋 Daily Refresh Plan — ${plan.date}`);
    console.log(`   ${plan.opportunities.length} opportunities to check\n`);

    for (const opp of plan.opportunities) {
      console.log(`   📊 ${opp.accountName}`);
      console.log(`      Last analysis: ${opp.lastAnalysisDate}`);
      console.log(`      Last call: ${opp.lastCallDate || 'none'}`);
      console.log(`      Current score: ${opp.currentScore.total}/${opp.currentScore.max}`);
      console.log(`      SF fields to check: ${Object.keys(opp.currentSfFields).length}`);
      console.log('');
    }

    console.log(`   Plan saved to: ${planFile}`);
    console.log(`\n   Next steps for orchestrator:`);
    console.log(`   1. Pull SF fields for each opp → compare against currentSfFields`);
    console.log(`   2. Check Salesloft for new calls after lastAnalysisDate`);
    console.log(`   3. SF diffs only → node lite-refresh.js --diffs diffs.json`);
    console.log(`   4. New calls → send incremental MEDDPICC prompt`);
    console.log(`   5. Apply results → node daily-refresh.js --apply-incremental <file>`);
    console.log(`   6. Rebuild → node build-data.js`);
    console.log(`   7. Push to GitHub\n`);
    return;
  }

  const incrementalIdx = args.indexOf('--apply-incremental');
  if (incrementalIdx !== -1 && args[incrementalIdx + 1]) {
    const result = applyIncremental(args[incrementalIdx + 1]);
    console.log(`\n✅ Incremental update applied for ${result.accountName}`);
    console.log(`   Run 'node build-data.js' to rebuild data.js\n`);
    return;
  }

  console.log('Usage:');
  console.log('  node daily-refresh.js --plan                          Generate refresh plan');
  console.log('  node daily-refresh.js --apply-incremental <file.json> Apply incremental MEDDPICC results');
}

if (require.main === module) {
  main();
}

module.exports = { generatePlan, applyIncremental };
