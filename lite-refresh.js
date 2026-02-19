#!/usr/bin/env node
// ============================================================
// LITE-REFRESH.JS
// Hybrid scoring engine for daily refreshes.
//
// Layer 1: Deterministic rules (score-rules.json)
//   - Maps SF field changes to specific MEDDPICC question adjustments
//   - Fast, no LLM calls needed
//
// Layer 2: LLM escalation (optional)
//   - For diffs that don't match any rule
//   - Outputs a lightweight prompt for the MEDDPICC Analyst
//   - Operator sends this prompt manually or via swarm
//
// Usage:
//   node lite-refresh.js --diffs diffs.json
//   node lite-refresh.js --diffs diffs.json --dry-run
//
// diffs.json format:
// [
//   {
//     "opportunityId": "006...",
//     "accountName": "Account",
//     "changes": [
//       { "field": "forecastCategory", "oldValue": "", "newValue": "Commit" },
//       { "field": "revenue.paymentsGpv", "oldValue": 0, "newValue": 8125000 }
//     ]
//   }
// ]
//
// Output: Updates opportunities.json, rebuilds data.js, logs all adjustments
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OPP_FILE = path.join(DATA_DIR, 'opportunities.json');
const RULES_FILE = path.join(__dirname, 'score-rules.json');
const HISTORY_FILE = path.join(DATA_DIR, 'version-history.json');

// ============================================================
// SCORE HELPERS
// ============================================================
function answerToScore(answer) {
  if (answer === 'Yes') return 1;
  if (answer === 'Partial') return 0.5;
  return 0;
}

function scoreToAnswer(score) {
  if (score >= 1) return 'Yes';
  if (score >= 0.5) return 'Partial';
  return 'No';
}

function answerRank(answer) {
  if (answer === 'Yes') return 2;
  if (answer === 'Partial') return 1;
  return 0;
}

// ============================================================
// RULE MATCHING
// ============================================================
function matchesRule(rule, change, oldOpp) {
  // Check if the rule's field matches the change's field
  if (rule.field !== change.field) return false;

  const trigger = rule.trigger;

  // Check newValueIn
  if (trigger.newValueIn) {
    const matched = trigger.newValueIn.some(v => {
      if (typeof v === 'string') return String(change.newValue).toLowerCase() === v.toLowerCase();
      return change.newValue === v;
    });
    if (!matched) return false;
  }

  // Check fromZeroOrNull
  if (trigger.fromZeroOrNull) {
    if (change.oldValue !== 0 && change.oldValue !== null && change.oldValue !== undefined && change.oldValue !== '') {
      return false;
    }
  }

  // Check newValueGt
  if (trigger.newValueGt !== undefined) {
    if (Number(change.newValue) <= trigger.newValueGt) return false;
  }

  // Check pushedBack (date comparison)
  if (trigger.pushedBack) {
    if (!change.oldValue || !change.newValue) return false;
    const oldDate = new Date(change.oldValue);
    const newDate = new Date(change.newValue);
    if (newDate <= oldDate) return false; // Not pushed back
  }

  return true;
}

// ============================================================
// APPLY ADJUSTMENT to a single question
// ============================================================
function applyAdjustment(question, adjustment, rule) {
  const currentAnswer = question.answer || 'No';
  const currentRank = answerRank(currentAnswer);
  let newAnswer = currentAnswer;
  let changed = false;

  if (adjustment.setTo) {
    // Force to specific value
    if (currentAnswer !== adjustment.setTo) {
      newAnswer = adjustment.setTo;
      changed = true;
    }
  } else if (adjustment.minBump) {
    // Bump UP to at least this level (never downgrade)
    const targetRank = answerRank(adjustment.minBump);
    if (currentRank < targetRank) {
      newAnswer = adjustment.minBump;
      changed = true;
    }
  } else if (adjustment.maxCap) {
    // Cap DOWN to at most this level (never upgrade)
    const capRank = answerRank(adjustment.maxCap);
    if (currentRank > capRank) {
      newAnswer = adjustment.maxCap;
      changed = true;
    }
  }

  if (changed) {
    return {
      changed: true,
      oldAnswer: currentAnswer,
      oldScore: answerToScore(currentAnswer),
      newAnswer: newAnswer,
      newScore: answerToScore(newAnswer),
      scoreDelta: answerToScore(newAnswer) - answerToScore(currentAnswer),
      reason: rule.reason,
      ruleId: rule.id,
    };
  }

  return { changed: false };
}

// ============================================================
// PROCESS ONE OPPORTUNITY
// ============================================================
function processOpportunity(opp, changes, rules) {
  const results = {
    opportunityId: opp.id,
    accountName: opp.accountName,
    ruleMatches: [],
    unmatchedChanges: [],
    scoreAdjustments: [],
    totalScoreDelta: 0,
  };

  const matchedChangeFields = new Set();

  // For each change, find matching rules
  for (const change of changes) {
    let hasMatch = false;

    for (const rule of rules) {
      if (matchesRule(rule, change, opp)) {
        hasMatch = true;
        matchedChangeFields.add(change.field);

        // Get the target question
        const section = opp.meddpicc?.[rule.section];
        if (!section || !section.questions || !section.questions[rule.questionIndex]) {
          results.ruleMatches.push({
            ruleId: rule.id,
            field: change.field,
            status: 'SKIPPED',
            reason: `Section ${rule.section}[${rule.questionIndex}] not found in opportunity data`,
          });
          continue;
        }

        const question = section.questions[rule.questionIndex];
        const result = applyAdjustment(question, rule.adjustment, rule);

        if (result.changed) {
          results.ruleMatches.push({
            ruleId: rule.id,
            field: change.field,
            section: rule.section,
            sectionLabel: section.label,
            questionIndex: rule.questionIndex,
            questionText: question.q,
            status: 'APPLIED',
            oldAnswer: result.oldAnswer,
            newAnswer: result.newAnswer,
            scoreDelta: result.scoreDelta,
            reason: result.reason,
          });

          results.scoreAdjustments.push({
            section: rule.section,
            sectionLabel: section.label,
            questionIndex: rule.questionIndex,
            delta: result.scoreDelta,
          });

          results.totalScoreDelta += result.scoreDelta;

          // Apply the change to the actual data
          question.answer = result.newAnswer;
          question.score = result.newScore;
          // Append rule reason to notes
          const ruleNote = `[Lite Refresh ${new Date().toISOString().split('T')[0]}] ${result.reason}`;
          question.notes = question.notes ? `${question.notes}\n${ruleNote}` : ruleNote;

          // Action item lifecycle: if answer is now Yes, mark action as resolved
          if (result.newAnswer === 'Yes' && question.action && question.action !== 'N/A' && question.action !== '') {
            const resolvedNote = `[Resolved ${new Date().toISOString().split('T')[0]}] ${question.action}`;
            question.notes = question.notes ? `${question.notes}\n${resolvedNote}` : resolvedNote;
            question.action = '';
            question.due = '';
          }

        } else {
          results.ruleMatches.push({
            ruleId: rule.id,
            field: change.field,
            section: rule.section,
            sectionLabel: section.label,
            questionIndex: rule.questionIndex,
            questionText: question.q,
            status: 'NO_CHANGE',
            reason: `Already at ${question.answer} — rule would not change it`,
          });
        }
      }
    }

    if (!hasMatch) {
      results.unmatchedChanges.push(change);
    }
  }

  return results;
}

// ============================================================
// GENERATE LLM ESCALATION PROMPT for unmatched changes
// ============================================================
function generateEscalationPrompt(oppResults) {
  const unmatched = oppResults.filter(r => r.unmatchedChanges.length > 0);
  if (unmatched.length === 0) return null;

  let prompt = `You are a MEDDPICC scoring analyst. The following Salesforce field changes were detected in a daily refresh but do NOT have deterministic scoring rules. Based ONLY on these changes (no transcript re-analysis needed), recommend specific MEDDPICC score adjustments.\n\nFor each recommendation, return JSON:\n{\n  "opportunityId": "...",\n  "adjustments": [\n    {\n      "section": "sectionKey",\n      "questionIndex": 0,\n      "currentAnswer": "Partial",\n      "recommendedAnswer": "Yes",\n      "reason": "Why this change justifies the adjustment"\n    }\n  ]\n}\n\n---\n\n`;

  for (const opp of unmatched) {
    prompt += `### ${opp.accountName} (${opp.opportunityId})\n`;
    prompt += `Unmatched changes:\n`;
    for (const change of opp.unmatchedChanges) {
      prompt += `- ${change.field}: "${change.oldValue}" → "${change.newValue}"\n`;
    }
    prompt += `\n`;
  }

  return prompt;
}

// ============================================================
// UPDATE VERSION HISTORY
// ============================================================
function updateVersionHistory(opp, results, diffs) {
  let versionHistory = {};
  if (fs.existsSync(HISTORY_FILE)) {
    versionHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  }

  const oppHistory = versionHistory[opp.id] || [];
  const today = new Date().toISOString().split('T')[0];

  // Recompute section scores from the updated meddpicc data
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

  // Build changes list — enriched format showing score impact + reasoning
  const changes = [];

  // Get previous score for delta display
  const prevEntry = oppHistory.length > 0 ? oppHistory[oppHistory.length - 1] : null;
  const prevScore = prevEntry ? prevEntry.totalScore : null;

  if (results.totalScoreDelta !== 0 && prevScore !== null) {
    const dir = results.totalScoreDelta > 0 ? 'improved' : 'declined';
    changes.push(`Score ${dir} by ${Math.abs(results.totalScoreDelta)} point${Math.abs(results.totalScoreDelta) !== 1 ? 's' : ''} (${prevScore} → ${totalScore}) — lite refresh`);
  }

  // Add each applied rule with section, question, old→new, delta, and reason
  for (const m of results.ruleMatches.filter(m => m.status === 'APPLIED')) {
    changes.push(`${m.sectionLabel} Q${m.questionIndex}: ${m.oldAnswer} → ${m.newAnswer} (${m.scoreDelta > 0 ? '+' : ''}${m.scoreDelta}) — ${m.reason}`);
  }

  // Add SF triggers for context
  for (const diff of (results.ruleMatches.filter(m => m.status === 'APPLIED').map(m => m.field).filter((v, i, a) => a.indexOf(v) === i))) {
    const change = results.ruleMatches.find(m => m.field === diff && m.status === 'APPLIED');
    // Find the original diff to get old/new values
    const originalDiff = diffs.find(d => d.opportunityId === opp.id);
    if (originalDiff) {
      const fieldChange = originalDiff.changes.find(c => c.field === diff);
      if (fieldChange) {
        changes.push(`SF trigger: ${diff} "${fieldChange.oldValue}" → "${fieldChange.newValue}"`);
      }
    }
  }

  const entry = {
    date: today,
    totalScore,
    totalMax,
    status,
    sectionScores,
    changes,
    type: 'lite-refresh',
  };

  // Update or append today's entry
  const lastIdx = oppHistory.length - 1;
  if (lastIdx >= 0 && oppHistory[lastIdx].date === today) {
    oppHistory[lastIdx] = entry;
  } else {
    oppHistory.push(entry);
  }

  versionHistory[opp.id] = oppHistory;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(versionHistory, null, 2));

  return { totalScore, totalMax, pct, status };
}

// ============================================================
// MAIN
// ============================================================
function main() {
  const args = process.argv.slice(2);
  const diffsIdx = args.indexOf('--diffs');
  const dryRun = args.includes('--dry-run');

  if (diffsIdx === -1 || !args[diffsIdx + 1]) {
    console.error('Usage: node lite-refresh.js --diffs <diffs.json> [--dry-run]');
    process.exit(1);
  }

  const diffsFile = args[diffsIdx + 1];
  const diffs = JSON.parse(fs.readFileSync(diffsFile, 'utf-8'));
  const { rules } = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
  let opportunities = JSON.parse(fs.readFileSync(OPP_FILE, 'utf-8'));

  console.log(`\n🔄 Lite Refresh — Hybrid Score Engine`);
  console.log(`   ${diffs.length} opportunities with changes`);
  console.log(`   ${rules.length} deterministic rules loaded`);
  console.log(`   Mode: ${dryRun ? 'DRY RUN (no changes written)' : 'LIVE'}\n`);

  const allResults = [];

  for (const diff of diffs) {
    const opp = opportunities.find(o => o.id === diff.opportunityId);
    if (!opp) {
      console.log(`⚠️  ${diff.accountName} (${diff.opportunityId}): NOT FOUND in opportunities.json — skipping`);
      continue;
    }

    const results = processOpportunity(opp, diff.changes, rules);
    allResults.push(results);

    // Print results
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 ${results.accountName} (${results.opportunityId})`);

    if (results.ruleMatches.length > 0) {
      console.log(`\n   Layer 1 — Deterministic Rules:`);
      for (const match of results.ruleMatches) {
        if (match.status === 'APPLIED') {
          const emoji = match.scoreDelta > 0 ? '⬆️' : '⬇️';
          console.log(`   ${emoji}  ${match.sectionLabel} Q[${match.questionIndex}]: ${match.oldAnswer} → ${match.newAnswer} (${match.scoreDelta > 0 ? '+' : ''}${match.scoreDelta})`);
          console.log(`       "${match.questionText}"`);
          console.log(`       Reason: ${match.reason}`);
        } else if (match.status === 'NO_CHANGE') {
          console.log(`   ⏸️  ${match.sectionLabel} Q[${match.questionIndex}]: ${match.reason}`);
        } else {
          console.log(`   ⚠️  ${match.ruleId}: ${match.reason}`);
        }
      }
    }

    if (results.unmatchedChanges.length > 0) {
      console.log(`\n   Layer 2 — Unmatched (needs LLM escalation):`);
      for (const uc of results.unmatchedChanges) {
        console.log(`   🔶 ${uc.field}: "${uc.oldValue}" → "${uc.newValue}"`);
      }
    }

    const delta = results.totalScoreDelta;
    if (delta !== 0) {
      console.log(`\n   📈 Net score delta: ${delta > 0 ? '+' : ''}${delta}`);
    } else {
      console.log(`\n   📊 No score changes from rules`);
    }

    // Update version history (even in dry-run we calculate, but don't write)
    if (!dryRun) {
      const updated = updateVersionHistory(opp, results, diffs);
      console.log(`   📊 New score: ${updated.totalScore}/${updated.totalMax} (${updated.pct}%) — ${updated.status}`);
    }

    console.log('');
  }

  // Check for LLM escalation needs
  const escalationPrompt = generateEscalationPrompt(allResults);
  if (escalationPrompt) {
    const escalationFile = path.join(DATA_DIR, 'escalation-prompt.txt');
    if (!dryRun) {
      fs.writeFileSync(escalationFile, escalationPrompt);
    }
    console.log(`\n🔶 Layer 2 Escalation Required`);
    console.log(`   ${allResults.reduce((sum, r) => sum + r.unmatchedChanges.length, 0)} unmatched changes need LLM review`);
    console.log(`   Prompt saved to: ${escalationFile}`);
    console.log(`   Send this prompt to the MEDDPICC Analyst for lightweight scoring adjustments.\n`);
  } else {
    console.log(`✅ All changes handled by deterministic rules — no LLM escalation needed.\n`);
  }

  // Write updated opportunities
  if (!dryRun) {
    fs.writeFileSync(OPP_FILE, JSON.stringify(opportunities, null, 2));
    console.log(`💾 opportunities.json updated`);

    // Rebuild data.js
    try {
      require('./build-data');
      console.log(`💾 quick-deploy/data.js rebuilt`);
    } catch (e) {
      console.log(`⚠️  Could not rebuild data.js: ${e.message}`);
    }
  } else {
    console.log(`🏃 DRY RUN — no files written`);
  }

  // Summary
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📋 SUMMARY`);
  for (const r of allResults) {
    const applied = r.ruleMatches.filter(m => m.status === 'APPLIED').length;
    const unmatched = r.unmatchedChanges.length;
    const emoji = r.totalScoreDelta > 0 ? '⬆️' : r.totalScoreDelta < 0 ? '⬇️' : '➡️';
    console.log(`   ${emoji} ${r.accountName}: ${applied} rules applied, delta ${r.totalScoreDelta > 0 ? '+' : ''}${r.totalScoreDelta}${unmatched > 0 ? `, ${unmatched} need LLM` : ''}`);
  }
  console.log('');

  // Return results for programmatic use
  return allResults;
}

// Run
if (require.main === module) {
  main();
}

module.exports = { processOpportunity, matchesRule, applyAdjustment, generateEscalationPrompt };
