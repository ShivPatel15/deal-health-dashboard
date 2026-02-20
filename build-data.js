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
      // Skip actions for questions already answered Yes (gap is closed)
      if (q.answer === 'Yes') return;
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
// BUILD DEFAULT MAP for new opportunities (from MEDDPICC gaps)
// ============================================================
function buildDefaultMAP(o) {
  const stk = o.stakeholders || [];
  const team = o.shopifyTeam || [];
  const champion = stk.find(s => s.engagement === 'high') || stk[0] || {};
  const ae = o.owner || 'Shopify';
  const aeShort = ae.split(' ')[0];
  const se = team.find(t => t.role && (t.role.includes('Solutions') || t.role.includes('SE')));
  const seShort = se ? se.name.split(' ')[0] : '';
  const hasCalls = (o.calls || []).length > 0;
  const hasChampion = stk.some(s => s.engagement === 'high');
  const merchantChamp = champion.name || o.accountName;

  // Helper to check MEDDPICC answers
  const hasYes = (secKey, keyword) => {
    const sec = o.meddpicc?.[secKey];
    if (!sec) return false;
    return sec.questions.some(q => q.answer === 'Yes' && q.q.toLowerCase().includes(keyword));
  };

  const items = [];
  items.push({ date: o.created || '', done: hasCalls, milestone: 'Initial discovery & intro calls', ownerMerchant: merchantChamp, ownerShopify: aeShort, notes: hasCalls ? (o.calls || []).length + ' calls completed' : '' });
  items.push({ date: '', done: hasChampion, milestone: 'Identify champion & project team', ownerMerchant: merchantChamp, ownerShopify: aeShort, notes: hasChampion ? 'Champion: ' + champion.name : '' });

  // Pull top MEDDPICC gap actions as MAP milestones
  const actions = [];
  for (const [k, sec] of Object.entries(o.meddpicc || {})) {
    for (const q of (sec.questions || [])) {
      if (q.answer === 'Yes') continue;
      if (q.action && q.action !== 'N/A' && q.action !== '') {
        actions.push({ section: sec.label, action: q.action, due: q.due || '', ownerShopify: aeShort });
      }
    }
  }
  // Add top 2 metrics actions
  actions.filter(a => a.section === 'Metrics').slice(0, 2).forEach(a => {
    items.push({ date: '', done: false, milestone: a.action.slice(0, 120), ownerMerchant: '', ownerShopify: a.ownerShopify, notes: a.section + (a.due ? ' · Due ' + a.due : ''), due: a.due });
  });

  items.push({ date: '', done: hasYes('metrics', 'validated'), milestone: 'Validate business case with economic buyer', ownerMerchant: '', ownerShopify: aeShort, notes: '' });
  items.push({ date: '', done: hasYes('economicBuyer', 'identified'), milestone: 'Confirm economic buyer & signing authority', ownerMerchant: '', ownerShopify: aeShort, notes: '' });

  // EB access action
  const ebAccess = actions.find(a => a.section === 'Economic Buyer' && (a.action.toLowerCase().includes('call') || a.action.toLowerCase().includes('intro')));
  if (ebAccess) items.push({ date: '', done: false, milestone: ebAccess.action.slice(0, 120), ownerMerchant: '', ownerShopify: ebAccess.ownerShopify, notes: ebAccess.due ? 'Due ' + ebAccess.due : '', due: ebAccess.due });

  items.push({ date: '', done: hasYes('decisionProcess', 'how they will'), milestone: 'Map complete decision & approval process', ownerMerchant: merchantChamp, ownerShopify: aeShort, notes: '' });

  const mapAction = actions.find(a => a.action.toLowerCase().includes('mutual') || a.action.toLowerCase().includes('map'));
  if (mapAction) items.push({ date: '', done: false, milestone: mapAction.action.slice(0, 120), ownerMerchant: '', ownerShopify: mapAction.ownerShopify, notes: mapAction.due ? 'Due ' + mapAction.due : '', due: mapAction.due });

  items.push({ date: '', done: !!(o.merchantIntent), milestone: 'Submit merchant intent', ownerMerchant: '', ownerShopify: aeShort, notes: o.merchantIntent ? 'Intent: ' + o.merchantIntent : '' });
  items.push({ date: '', done: hasYes('paperProcess', 'contract details'), milestone: 'Finalize commercial proposal', ownerMerchant: merchantChamp, ownerShopify: aeShort, notes: '' });
  items.push({ date: '', done: hasYes('paperProcess', 'procurement'), milestone: 'Confirm procurement process & legal steps', ownerMerchant: '', ownerShopify: aeShort, notes: '' });

  // Top 2 paper process actions
  actions.filter(a => a.section === 'Paper Process').slice(0, 2).forEach(a => {
    items.push({ date: '', done: false, milestone: a.action.slice(0, 120), ownerMerchant: '', ownerShopify: a.ownerShopify, notes: a.section + (a.due ? ' · Due ' + a.due : ''), due: a.due });
  });

  items.push({ date: '', done: hasYes('paperProcess', 'sent'), milestone: 'Contract sent for signature', ownerMerchant: '', ownerShopify: aeShort, notes: '' });
  items.push({ date: '', done: false, milestone: 'Contract signed ✍️', ownerMerchant: '', ownerShopify: '', notes: 'Target: ' + (o.closeDate || 'TBD') });
  items.push({ date: '', done: false, milestone: 'Introduction to Shopify Launch team', ownerMerchant: '', ownerShopify: aeShort, notes: '' });
  items.push({ date: '', done: false, milestone: 'Go-Live 🚀', ownerMerchant: '', ownerShopify: '', notes: '' });

  return {
    merchantName: o.accountName,
    kickoffDate: o.created || '',
    goLiveDate: o.closeDate || '',
    contactName: o.owner || '',
    contactEmail: o.ownerEmail || '',
    champion: champion.name || '',
    items,
  };
}

// ============================================================
// COACHING SNAPSHOTS — append today's scores for trend tracking
// ============================================================
function buildCoachingSnapshots(o, scores) {
  const existing = o.coachingSnapshots || [];
  const today = new Date().toISOString().split('T')[0];

  // Build today's snapshot from computed scores
  const snapshot = { date: today, sections: {} };
  if (scores) {
    for (const [key, val] of Object.entries(scores)) {
      if (key === '_total') continue;
      snapshot.sections[key] = { score: val.score, max: val.max, pct: val.pct };
    }
  }

  // Don't duplicate today's entry — replace if same date
  const lastDate = existing.length > 0 ? existing[existing.length - 1].date : null;
  if (lastDate === today) {
    existing[existing.length - 1] = snapshot;
  } else {
    existing.push(snapshot);
  }

  return existing;
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
  // IMPORTANT: If today's entry already exists with enriched changes (e.g. from lite-refresh),
  // preserve those changes — only update the scores/sectionScores to stay current.
  const today = new Date().toISOString().split('T')[0];
  const lastHistoryDate = oppHistory.length > 0 ? oppHistory[oppHistory.length - 1].date : null;
  if (historyEntry && lastHistoryDate !== today) {
    oppHistory.push(historyEntry);
  } else if (historyEntry && lastHistoryDate === today) {
    const existing = oppHistory[oppHistory.length - 1];
    // Preserve enriched changes and type from lite-refresh or other sources
    if (existing.changes && existing.changes.length > 0) {
      // Keep existing changes, just update scores to match current computed values
      existing.totalScore = historyEntry.totalScore;
      existing.totalMax = historyEntry.totalMax;
      existing.status = historyEntry.status;
      existing.sectionScores = historyEntry.sectionScores;
      // Don't overwrite changes or type
    } else {
      // No enriched data — safe to overwrite
      oppHistory[oppHistory.length - 1] = historyEntry;
    }
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

    // Analysis tracking
    lastAnalysisDate: o.lastAnalysisDate || '',

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

    // Mutual Action Plan — pass through as-is, auto-generate for new opps
    mutualActionPlan: o.mutualActionPlan || buildDefaultMAP(o),

    // Coaching snapshots — append today's section scores for trend tracking
    coachingSnapshots: buildCoachingSnapshots(o, scores),
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

// Write data.js to BOTH quick-deploy/ and root (site serves from root data.js)
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const content = `const DEAL_DATA = ${JSON.stringify(data, null, 2)};\n`;
fs.writeFileSync(path.join(OUT_DIR, 'data.js'), content);
fs.writeFileSync(path.join(__dirname, 'data.js'), content);

console.log(`✅ Built data.js (root + quick-deploy/)`);
console.log(`   ${fullOpps.length} opportunities`);
console.log(`   ${owners.length} owners: ${owners.join(', ')}`);
fullOpps.forEach(o => {
  const s = o.scores?._total;
  const narrativeCount = Object.values(o.narrative || {}).filter(v => v).length;
  const callCount = (o.calls || []).length;
  const stakeCount = (o.stakeholders || []).length;
  const actionCount = (o.nextSteps || []).length;
  const mapCount = (o.mutualActionPlan?.items || []).length;
  const mapDone = (o.mutualActionPlan?.items || []).filter(i => i.done).length;
  const snapCount = (o.coachingSnapshots || []).length;
  console.log(`   📊 ${o.accountName}: ${s ? s.score + '/' + s.max + ' (' + s.pct + '%) ' + s.status : 'no scores'} | ${narrativeCount}/5 narratives | ${callCount} calls | ${stakeCount} stakeholders | ${actionCount} actions | MAP ${mapDone}/${mapCount} | ${snapCount} snapshots`);
});
console.log(`   Generated: ${data.generatedAt}`);
