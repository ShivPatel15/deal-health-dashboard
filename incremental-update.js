#!/usr/bin/env node
// ============================================================
// INCREMENTAL-UPDATE.JS
// Applies incremental updates to opportunities.json based on:
//   1. SF field diffs (from data/diffs.json)
//   2. MEDDPICC question updates (overdue dates, completed items)
//   3. Deal risks (new field)
//   4. MAP milestone updates (merge, don't replace)
//
// This modifies opportunities.json (the source of truth),
// then you run build-data.js to rebuild data.js.
//
// Usage:
//   node incremental-update.js --input data/incremental-updates.json
//
// Input format:
// {
//   "006OG00000GJ5IvYAL": {
//     "sfDiffs": [ { "field": "closeDate", "newValue": "2026-03-30" }, ... ],
//     "dealRisks": [ { "risk": "...", "severity": "high", "category": "timeline" } ],
//     "meddpiccUpdates": [
//       { "section": "economicBuyer", "questionIndex": 0, "updates": { "due": "03/04/2026" } },
//       { "section": "metrics", "questionIndex": 2, "updates": { "answer": "Yes", "action": "N/A" } }
//     ],
//     "newMAPItems": [
//       { "milestone": "...", "done": false, "ownerShopify": "...", "date": "2026-03-01" }
//     ],
//     "completedMAPMilestones": [ "Initial discovery & intro calls" ],
//     "mapGoLiveDate": "2026-03-30"
//   }
// }
//
// SAFETY RULES:
//   1. NEVER removes opportunities
//   2. NEVER removes meddpicc questions
//   3. NEVER removes existing nextSteps (those are rebuilt by build-data.js from meddpicc)
//   4. NEVER removes MAP items — only adds or marks done
//   5. Validates opp count before and after
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OPP_FILE = path.join(DATA_DIR, 'opportunities.json');

// ============================================================
// READ INPUT
// ============================================================
function readInput() {
  const inputIdx = process.argv.indexOf('--input');
  if (inputIdx !== -1 && process.argv[inputIdx + 1]) {
    const filePath = process.argv[inputIdx + 1];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  throw new Error('Usage: node incremental-update.js --input <file.json>');
}

// ============================================================
// APPLY SF DIFFS to an opportunity
// ============================================================
function applySFDiffs(opp, diffs) {
  if (!diffs || !diffs.length) return 0;
  let applied = 0;

  for (const diff of diffs) {
    const { field, newValue } = diff;

    // Direct top-level fields
    const topLevelFields = [
      'stage', 'closeDate', 'probability', 'forecastCategory',
      'nextStep', 'competitor', 'projectedBilledRevenue'
    ];

    if (topLevelFields.includes(field)) {
      opp[field] = newValue;
      applied++;
    }
    // Revenue sub-fields
    else if (field.startsWith('revenue.')) {
      const subField = field.split('.').slice(1).join('.');
      if (opp.revenue) {
        opp.revenue[subField] = newValue;
        applied++;
      }
    }
  }
  return applied;
}

// ============================================================
// APPLY MEDDPICC QUESTION UPDATES
// Updates specific questions (due dates, answer changes, etc.)
// ============================================================
function applyMEDDPICCUpdates(opp, updates) {
  if (!updates || !updates.length || !opp.meddpicc) return 0;
  let applied = 0;

  for (const update of updates) {
    const section = opp.meddpicc[update.section];
    if (!section || !section.questions) continue;

    const q = section.questions[update.questionIndex];
    if (!q) continue;

    // Apply each field update to the question
    for (const [key, value] of Object.entries(update.updates || {})) {
      if (['answer', 'score', 'notes', 'action', 'due', 'solution', 'highlight'].includes(key)) {
        q[key] = value;
        applied++;
      }
    }
  }
  return applied;
}

// ============================================================
// APPLY DEAL RISKS (additive — new field)
// ============================================================
function applyDealRisks(opp, risks) {
  if (!risks || !risks.length) return 0;
  opp.dealRisks = risks;
  return risks.length;
}

// ============================================================
// APPLY MAP UPDATES (merge, never replace)
// ============================================================
function applyMAPUpdates(opp, newItems, completedMilestones, goLiveDate) {
  // Initialize MAP if it doesn't exist and we have items to add
  if (!opp.mutualActionPlan && (newItems?.length || goLiveDate)) {
    opp.mutualActionPlan = { items: [], goLiveDate: '' };
  }
  if (!opp.mutualActionPlan) return 0;
  if (!opp.mutualActionPlan.items) opp.mutualActionPlan.items = [];
  let applied = 0;

  // Update go-live date
  if (goLiveDate) {
    opp.mutualActionPlan.goLiveDate = goLiveDate;
    applied++;
  }

  // Mark completed milestones
  if (completedMilestones && completedMilestones.length) {
    for (const milestoneName of completedMilestones) {
      const item = opp.mutualActionPlan.items.find(
        i => i.milestone.toLowerCase().includes(milestoneName.toLowerCase())
      );
      if (item && !item.done) {
        item.done = true;
        applied++;
      }
    }
  }

  // Add new MAP items (only if not already present)
  if (newItems && newItems.length) {
    const existingMilestones = new Set(
      opp.mutualActionPlan.items.map(i => i.milestone.toLowerCase().substring(0, 50))
    );

    // Find insertion point — before "Contract signed" or "Go-Live" milestones
    let insertIdx = opp.mutualActionPlan.items.length;
    for (let i = 0; i < opp.mutualActionPlan.items.length; i++) {
      const m = opp.mutualActionPlan.items[i].milestone.toLowerCase();
      if (m.includes('contract signed') || m.includes('go-live') || m.includes('introduction to shopify launch')) {
        insertIdx = i;
        break;
      }
    }

    for (const newItem of newItems) {
      const key = newItem.milestone.toLowerCase().substring(0, 50);
      if (!existingMilestones.has(key)) {
        opp.mutualActionPlan.items.splice(insertIdx, 0, {
          date: newItem.date || '',
          done: newItem.done || false,
          milestone: newItem.milestone,
          ownerMerchant: newItem.ownerMerchant || '',
          ownerShopify: newItem.ownerShopify || '',
          notes: newItem.notes || '',
          ...(newItem.due ? { due: newItem.due } : {}),
        });
        insertIdx++;
        applied++;
      }
    }
  }

  return applied;
}

// ============================================================
// MAIN
// ============================================================
function main() {
  console.log('🔄 Incremental Update');
  console.log('=====================');

  // Load current opportunities
  const opps = JSON.parse(fs.readFileSync(OPP_FILE, 'utf-8'));
  const beforeCount = opps.length;
  console.log(`📋 Loaded ${beforeCount} opportunities from ${OPP_FILE}`);

  // Load updates
  const updates = readInput();
  const oppIds = Object.keys(updates);
  console.log(`📥 Updates for ${oppIds.length} opportunities: ${oppIds.join(', ')}`);

  // Build lookup
  const oppMap = {};
  for (const opp of opps) {
    oppMap[opp.id] = opp;
  }

  // Apply updates
  let totalApplied = 0;
  for (const oppId of oppIds) {
    const opp = oppMap[oppId];
    if (!opp) {
      console.log(`  ⚠️  ${oppId}: not found in opportunities.json — skipping`);
      continue;
    }

    const update = updates[oppId];
    console.log(`\n  📝 ${opp.accountName} (${oppId}):`);

    // Track pre-update state for safety checks
    opp._hadMAP = opp.mutualActionPlan?.items?.length || 0;

    // 1. SF Diffs
    const sfApplied = applySFDiffs(opp, update.sfDiffs);
    if (sfApplied) console.log(`     ✅ ${sfApplied} SF field(s) updated`);

    // 2. Deal Risks
    const risksApplied = applyDealRisks(opp, update.dealRisks);
    if (risksApplied) console.log(`     ✅ ${risksApplied} deal risk(s) added`);

    // 3. MEDDPICC question updates
    const meddApplied = applyMEDDPICCUpdates(opp, update.meddpiccUpdates);
    if (meddApplied) console.log(`     ✅ ${meddApplied} MEDDPICC question field(s) updated`);

    // 4. MAP updates
    const mapApplied = applyMAPUpdates(
      opp,
      update.newMAPItems,
      update.completedMAPMilestones,
      update.mapGoLiveDate
    );
    if (mapApplied) console.log(`     ✅ ${mapApplied} MAP update(s) applied`);

    totalApplied += sfApplied + risksApplied + meddApplied + mapApplied;
  }

  // SAFETY CHECK: opp count unchanged
  const afterCount = opps.length;
  if (afterCount !== beforeCount) {
    console.error(`\n❌ FATAL: Opp count changed from ${beforeCount} to ${afterCount}. Aborting.`);
    process.exit(1);
  }

  // SAFETY CHECK: every opp still has meddpicc and MAP
  for (const opp of opps) {
    if (!opp.meddpicc || Object.keys(opp.meddpicc).length < 8) {
      console.error(`\n❌ FATAL: ${opp.accountName} lost meddpicc data. Aborting.`);
      process.exit(1);
    }
    // Only check MAP integrity for opps that HAD a MAP before the update
    const mapItems = opp.mutualActionPlan?.items?.length || 0;
    if (opp._hadMAP && mapItems < 5) {
      console.error(`\n❌ FATAL: ${opp.accountName} lost MAP data (was ${opp._hadMAP}, now ${mapItems}). Aborting.`);
      process.exit(1);
    }
  }

  // Clean up temp fields
  for (const opp of opps) {
    delete opp._hadMAP;
  }

  // Write back
  fs.writeFileSync(OPP_FILE, JSON.stringify(opps, null, 2));
  console.log(`\n✅ Applied ${totalApplied} total updates to ${OPP_FILE}`);
  console.log(`✅ Opp count preserved: ${afterCount}`);
  console.log(`\n📌 Next step: run 'node build-data.js' to rebuild data.js`);
}

main();
