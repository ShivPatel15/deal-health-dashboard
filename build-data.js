#!/usr/bin/env node
// ============================================================
// BUILD-DATA.JS
// Reads opportunities.json and generates the quick-deploy data.js
//
// CRITICAL: This script MUST pass through ALL analysis data.
// - narrative (oppSummary, whyChange, whyShopify, whyNow, supportNeeded)
// - meddpicc (all 8 sections with per-question scoring)
// - stakeholders, shopifyTeam, calls
// - scores (computed from meddpicc)
// - nextSteps (extracted from meddpicc actions)
// - history (version tracking)
// - projectedBilledRevenue
// - compellingEvent, aeNextStep
//
// DO NOT strip or "simplify" opportunity records.
// The dashboard depends on ALL of this data.
//
// Usage: node build-data.js
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_DIR = path.join(__dirname, 'quick-deploy');
const HISTORY_FILE = path.join(DATA_DIR, 'version-history.json');

// Load opportunities
const opps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'opportunities.json'), 'utf-8'));

// Load existing version history
let versionHistory = {};
if (fs.existsSync(HISTORY_FILE)) {
  versionHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

// Extract unique owners
const owners = [...new Set(opps.map(o => o.owner).filter(Boolean))];

// ============================================================
// COMPUTE SCORES from MEDDPICC data
// ============================================================
function computeScores(meddpicc) {
  if (!meddpicc) return null;

  const scores = {};
  let totalScore = 0;
  let totalMax = 0;

  for (const [sectionKey, section] of Object.entries(meddpicc)) {
    if (!section || !section.questions) continue;
    const questions = section.questions;
    const sectionScore = questions.reduce((sum, q) => sum + (q.score != null ? q.score : 0), 0);
    const sectionMax = questions.length;
    // Use section.label as key (e.g. "Metrics") so it matches the dashboard lookup: s[sec.label]
    const scoreKey = section.label || sectionKey;
    scores[scoreKey] = {
      score: sectionScore,
      max: sectionMax,
      pct: sectionMax > 0 ? Math.round((sectionScore / sectionMax) * 100) : 0,
    };
    totalScore += sectionScore;
    totalMax += sectionMax;
  }

  const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  let status;
  if (pct >= 75) status = 'good-health';
  else if (pct >= 50) status = 'on-track';
  else status = 'at-risk';

  scores._total = {
    score: totalScore,
    max: totalMax,
    pct,
    status,
  };

  return scores;
}

// ============================================================
// EXTRACT NEXT STEPS from MEDDPICC action items
// ============================================================
function extractNextSteps(meddpicc) {
  if (!meddpicc) return [];

  const steps = [];
  let priority = 1;

  for (const [sectionKey, section] of Object.entries(meddpicc)) {
    if (!section || !section.questions) continue;
    section.questions.forEach((q) => {
      if (q.action && q.action !== 'N/A' && q.action !== '') {
        steps.push({
          p: priority++,
          cat: section.label || sectionKey,
          issue: q.notes || '',
          rec: q.action,
          due: q.due || '',
        });
      }
    });
  }

  return steps;
}

// ============================================================
// BUILD VERSION HISTORY entry
// ============================================================
function buildHistoryEntry(opp, scores) {
  if (!scores || !scores._total) return null;

  const entry = {
    date: new Date().toISOString().split('T')[0],
    totalScore: scores._total.score,
    totalMax: scores._total.max,
    status: scores._total.status,
    sectionScores: {},
    changes: [],
  };

  for (const [key, val] of Object.entries(scores)) {
    if (key === '_total') continue;
    entry.sectionScores[key] = val.score;
  }

  // Check for changes vs previous history
  const oppHistory = versionHistory[opp.id] || [];
  if (oppHistory.length > 0) {
    const prev = oppHistory[oppHistory.length - 1];
    const scoreDiff = entry.totalScore - prev.totalScore;
    if (scoreDiff > 0) entry.changes.push(`Score improved by ${scoreDiff} points`);
    else if (scoreDiff < 0) entry.changes.push(`Score declined by ${Math.abs(scoreDiff)} points`);

    // Section-level changes
    for (const [key, val] of Object.entries(entry.sectionScores)) {
      const prevVal = prev.sectionScores?.[key];
      if (prevVal != null && val !== prevVal) {
        const diff = val - prevVal;
        const direction = diff > 0 ? 'improved' : 'declined';
        entry.changes.push(`${key}: ${direction} (${prevVal} → ${val})`);
      }
    }
  }

  return entry;
}

// ============================================================
// BUILD FULL OPPORTUNITY RECORDS
// Pass through ALL data. Do NOT simplify or strip fields.
// ============================================================
const fullOpps = opps.map(o => {
  // Compute scores from meddpicc
  const scores = computeScores(o.meddpicc);

  // Extract action items as nextSteps
  const nextSteps = extractNextSteps(o.meddpicc);

  // Build history entry
  const historyEntry = buildHistoryEntry(o, scores);
  const oppHistory = versionHistory[o.id] || [];

  // Only add new history entry if date changed or no history exists
  const today = new Date().toISOString().split('T')[0];
  const lastHistoryDate = oppHistory.length > 0 ? oppHistory[oppHistory.length - 1].date : null;
  if (historyEntry && lastHistoryDate !== today) {
    oppHistory.push(historyEntry);
  } else if (historyEntry && lastHistoryDate === today) {
    // Update today's entry
    oppHistory[oppHistory.length - 1] = historyEntry;
  }

  // Save updated history
  versionHistory[o.id] = oppHistory;

  return {
    // Core fields
    id: o.id,
    name: o.name,
    accountName: o.accountName,
    accountId: o.accountId || '',
    owner: o.owner || '',
    ownerEmail: o.ownerEmail || '',
    stage: o.stage || '',
    closeDate: o.closeDate || '',
    forecastCategory: o.forecastCategory || '',
    probability: o.probability || 0,
    merchantIntent: o.merchantIntent || '',
    type: o.type || 'New Business',
    created: o.timeline?.created || o.created || '',

    // Revenue — pass through as-is from SF, NO fabricated projections
    revenue: o.revenue || {},
    projectedBilledRevenue: o.projectedBilledRevenue || o.revenue?.projectedBilledRevenue || null,

    // Products
    products: o.products || [],

    // Competitive
    competitor: o.competitive?.primary || o.competitor || '',
    compellingEvent: o.compellingEvent || '',
    nextStep: o.aeNextStep || o.nextStep || '',

    // FULL ANALYSIS — NEVER strip these
    narrative: o.narrative || {},
    meddpicc: o.meddpicc || {},
    scores: scores || {},
    nextSteps: nextSteps,

    // People
    stakeholders: o.stakeholders || [],
    shopifyTeam: o.shopifyTeam || [],

    // Calls
    calls: o.calls || [],

    // History
    history: oppHistory,
  };
});

// Save version history
fs.writeFileSync(HISTORY_FILE, JSON.stringify(versionHistory, null, 2));

// Build final data.js payload
const data = {
  team: { name: 'Sales Large — EMEA' },
  generatedAt: new Date().toISOString(),
  owners,
  opportunities: fullOpps,
};

// Write data.js
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const content = `const DEAL_DATA = ${JSON.stringify(data, null, 2)};\n`;
fs.writeFileSync(path.join(OUT_DIR, 'data.js'), content);

console.log(`✅ Built quick-deploy/data.js`);
console.log(`   ${fullOpps.length} opportunities`);
console.log(`   ${owners.length} owners: ${owners.join(', ')}`);
fullOpps.forEach(o => {
  const s = o.scores?._total;
  const narrativeCount = Object.values(o.narrative || {}).filter(v => v).length;
  const callCount = (o.calls || []).length;
  const stakeCount = (o.stakeholders || []).length;
  const actionCount = (o.nextSteps || []).length;
  console.log(`   📊 ${o.accountName}: ${s ? s.score + '/' + s.max + ' (' + s.pct + '%) ' + s.status : 'no scores'} | ${narrativeCount}/5 narratives | ${callCount} calls | ${stakeCount} stakeholders | ${actionCount} actions`);
});
console.log(`   Generated: ${data.generatedAt}`);
