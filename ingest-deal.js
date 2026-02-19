#!/usr/bin/env node
// ============================================================
// INGEST-DEAL.JS
// Takes Salesforce opportunity data + MEDDPICC analysis output
// and writes/updates an opportunity in the dashboard data store.
//
// This replaces the Excel generation step in the swarm workflow.
// Output: updates opportunities.json → dashboard serves it live.
//
// Usage:
//   node ingest-deal.js --input deal-payload.json
//   OR pipe JSON:
//   cat deal-payload.json | node ingest-deal.js
//
// The payload schema matches the swarm's combined output from:
//   - Salesforce Reader (opportunity + account data)
//   - MEDDPICC Analyst (narrative insights from call transcripts)
//   - SE Salesloft (call metadata)
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OPP_FILE = path.join(DATA_DIR, 'opportunities.json');
const SHARING_FILE = path.join(DATA_DIR, 'sharing.json');

// ============================================================
// READ INPUT
// ============================================================
async function readInput() {
  // Check for --input flag
  const inputIdx = process.argv.indexOf('--input');
  if (inputIdx !== -1 && process.argv[inputIdx + 1]) {
    const filePath = process.argv[inputIdx + 1];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  // Try reading from stdin
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON from stdin')); }
    });
    process.stdin.on('error', reject);
    // Timeout after 5s if no stdin
    setTimeout(() => {
      if (!data) reject(new Error('No input provided. Use --input <file> or pipe JSON to stdin.'));
    }, 5000);
  });
}

// ============================================================
// MEDDPICC QUESTION TEMPLATES
// Each section has a standard set of questions.
// The analyst's output fills in answers, notes, solutions, actions.
// ============================================================
const MEDDPICC_TEMPLATE = {
  metrics: {
    label: 'Metrics',
    questions: [
      'Do we know the business reasons as to why they are migrating?',
      'Do we have specific quantifiable goals aligned with the project?',
      'Do they need to make a platform change to achieve this goal?',
      'Do we understand the impact if this goal isn\'t achieved?',
      'Is there a compelling event in place driving action?',
      'Have I validated the metrics with the customer?',
      'Are the metrics compelling enough to justify change?',
    ]
  },
  economicBuyer: {
    label: 'Economic Buyer',
    questions: [
      'Have I identified the true economic buyer?',
      'Do we know who\'s signing the contract?',
      'Do we have access to this individual?',
      'Can we get access?',
      'Do we know what the economic buyer cares about most?',
      'Do you know how they make decisions and allocate budget?',
    ]
  },
  decisionProcess: {
    label: 'Decision Process',
    questions: [
      'Do we know how they will be making the decision?',
      'Do we know who\'s involved / buying committee?',
      'Do we know when they want to make a decision by?',
      'Do we know what is driving this timeline?',
      'Do we know if they have tried to solve this problem before?',
      'Do we know what will happen if they do nothing?',
      'Have you validated this process with the buyer?',
    ]
  },
  decisionCriteria: {
    label: 'Decision Criteria',
    questions: [
      'Do we know what criteria the customer is using to evaluate vendors?',
      'Have we discussed all D2C/B2B/POS Omnichannel capabilities?',
      'Have we surfaced technical complications (integrations)?',
      'Do we know how payments play into their decision?',
      'Do we have a mutual action plan in place?',
      'Did we help shape those criteria in our favour?',
      'Do we know who defined the decision criteria?',
    ]
  },
  paperProcess: {
    label: 'Paper Process',
    questions: [
      'Do we know what their procurement process is?',
      'Are there likely to be redlines?',
      'If redlines, how long does review take?',
      'Do we know how long it will take?',
      'Do we have contract details?',
      'Have we sent the contract?',
      'Do we know target date for signature?',
    ]
  },
  identifyPain: {
    label: 'Identify Pain',
    questions: [
      'Do we know their current issues and why they are reviewing their tech stack?',
      'Have they tried to resolve this issue in the past?',
      'Do we know how pains are affecting business operations?',
      'Do we know what teams are affected and to what extent?',
      'Do we know how urgent it is to solve this pain?',
      'Can they solve this pain using another option?',
      'Do we know why this problem is important to solve now?',
      'Is our solution uniquely positioned to solve this pain?',
    ]
  },
  champion: {
    label: 'Champion',
    questions: [
      'Have you identified a true champion (influence + motivation)?',
      'Does your champion have political capital and credibility?',
      'Have they given insights you wouldn\'t get otherwise?',
      'Are they connected with the key decision makers?',
      'Have you been introduced to the decision maker?',
      'Are they willing to bring you into the board/buying group?',
      'Why are they such a champion for you?',
    ]
  },
  competition: {
    label: 'Competition',
    questions: [
      'Do we know who else the customer is evaluating?',
      'Have we asked if doing nothing is an option?',
      'Are there internal alternatives to our solution?',
      'Do we know why alternatives are being evaluated?',
      'Do we know why we would win or lose?',
    ]
  }
};

// ============================================================
// TRANSFORM: Swarm payload → Dashboard opportunity schema
// ============================================================
function transformPayload(payload) {
  const sf = payload.salesforce || {};
  const analysis = payload.meddpicc_analysis || {};
  const calls = payload.calls || [];

  // Build MEDDPICC sections from analyst output
  const meddpicc = {};
  const analystMeddpicc = analysis.meddpicc || {};

  for (const [sectionKey, template] of Object.entries(MEDDPICC_TEMPLATE)) {
    const analystSection = analystMeddpicc[sectionKey] || {};
    const analystQuestions = analystSection.questions || [];

    meddpicc[sectionKey] = {
      label: template.label,
      questions: template.questions.map((q, i) => {
        // Try to match analyst output by index or fuzzy match
        const aq = analystQuestions[i] || {};
        const answer = aq.answer || 'No';
        return {
          q: q,
          answer: answer,
          score: answer === 'Yes' ? 1 : answer === 'Partial' ? 0.5 : 0,
          notes: aq.notes || '',
          solution: aq.solution || '',
          action: aq.action || '',
          due: aq.due || '',
          highlight: aq.highlight || false,
        };
      })
    };
  }

  // Build the opportunity record
  const opp = {
    id: sf.opportunityId || sf.id || `opp_${Date.now()}`,
    name: sf.name || sf.accountName || 'Unknown',
    accountName: sf.accountName || sf.name || 'Unknown',
    accountId: sf.accountId || '',
    stage: sf.stage || 'Unknown',
    closeDate: sf.closeDate || '',
    forecastCategory: sf.forecastCategory || '',
    probability: sf.probability || 0,
    type: sf.type || 'New Business',
    merchantIntent: sf.merchantIntent || '',
    owner: sf.owner || '',
    ownerEmail: sf.ownerEmail || '',
    revenue: {
      mcv: sf.revenue?.mcv || sf.mcv || 0,
      totalRev3yr: sf.revenue?.totalRev3yr || sf.totalRev3yr || 0,
      d2cGmv: sf.revenue?.d2cGmv || null,
      b2bGmv: sf.revenue?.b2bGmv || null,
      retailGmv: sf.revenue?.retailGmv || null,
      paymentsGpv: sf.revenue?.paymentsGpv || 0,
      paymentsAttached: sf.revenue?.paymentsAttached || false,
      ipp: sf.revenue?.ipp || 0,
    },
    products: sf.products || [],
    stakeholders: (sf.stakeholders || []).map(s => ({
      name: s.name || '',
      title: s.title || '',
      role: s.role || '',
      email: s.email || '',
      engagement: s.engagement || 'none',
      callsAttended: s.callsAttended || 0,
      callsInvited: s.callsInvited || 0,
    })),
    shopifyTeam: (sf.shopifyTeam || []).map(s => ({
      name: s.name || '',
      role: s.role || '',
      email: s.email || '',
    })),
    competitive: {
      primary: sf.competitive?.primary || sf.competitor || '',
      position: sf.competitive?.position || '',
      partner: sf.competitive?.partner || '',
    },
    timeline: {
      created: sf.timeline?.created || sf.created || new Date().toISOString().split('T')[0],
      proposedLaunch: sf.timeline?.proposedLaunch || '',
      region: sf.timeline?.region || 'EMEA',
    },
    projectedBilledRevenue: sf.projectedBilledRevenue || null,
    compellingEvent: analysis.compellingEvent || sf.compellingEvent || '',
    aeNextStep: sf.aeNextStep || sf.nextStep || '',
    narrative: {
      oppSummary: analysis.oppSummary || analysis.narrative?.oppSummary || '',
      whyChange: analysis.whyChange || analysis.narrative?.whyChange || '',
      whyShopify: analysis.whyShopify || analysis.narrative?.whyShopify || '',
      whyNow: analysis.whyNow || analysis.narrative?.whyNow || '',
      supportNeeded: analysis.supportNeeded || analysis.narrative?.supportNeeded || '',
    },
    meddpicc: meddpicc,
    calls: calls.map(c => ({
      date: c.date || '',
      title: c.title || '',
      duration: c.duration || '',
      shopifyAttendees: c.shopifyAttendees || [],
      merchantAttendees: c.merchantAttendees || [],
      summary: c.summary || '',
    })),
  };

  return opp;
}

// ============================================================
// UPSERT: Add or update opportunity in data store
// ============================================================
function upsertOpportunity(opp) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let opportunities = [];
  if (fs.existsSync(OPP_FILE)) {
    opportunities = JSON.parse(fs.readFileSync(OPP_FILE, 'utf-8'));
  }

  const existingIdx = opportunities.findIndex(o => o.id === opp.id);
  if (existingIdx >= 0) {
    // Merge: update fields but preserve any manual edits to MEDDPICC scores
    const existing = opportunities[existingIdx];

    // Smart merge: if existing has manual edits (detected by checking if notes differ),
    // keep the manually edited version. Otherwise overwrite.
    const merged = { ...existing, ...opp };

    // Preserve manually edited MEDDPICC data if it exists
    if (existing.meddpicc && opp.meddpicc) {
      for (const [key, section] of Object.entries(opp.meddpicc)) {
        if (existing.meddpicc[key]) {
          merged.meddpicc[key] = {
            ...section,
            questions: section.questions.map((q, i) => {
              const existingQ = existing.meddpicc[key]?.questions?.[i];
              // If existing has a manually edited note (non-empty), keep it unless new data is also non-empty
              if (existingQ && existingQ.notes && !q.notes) {
                return existingQ;
              }
              return q;
            })
          };
        }
      }
    }

    opportunities[existingIdx] = merged;
    console.log(`✅ Updated existing opportunity: ${opp.accountName} (${opp.id})`);
  } else {
    opportunities.push(opp);
    console.log(`✅ Added new opportunity: ${opp.accountName} (${opp.id})`);
  }

  fs.writeFileSync(OPP_FILE, JSON.stringify(opportunities, null, 2));

  // Update sharing if new
  let sharing = {};
  if (fs.existsSync(SHARING_FILE)) {
    sharing = JSON.parse(fs.readFileSync(SHARING_FILE, 'utf-8'));
  }
  if (!sharing[opp.id]) {
    sharing[opp.id] = {
      owner: opp.ownerEmail || 'shiv.patel@shopify.com',
      editors: opp.shopifyTeam?.map(t => t.email).filter(Boolean) || [],
      viewers: [],
    };
    fs.writeFileSync(SHARING_FILE, JSON.stringify(sharing, null, 2));
    console.log(`   → Sharing configured (owner: ${sharing[opp.id].owner})`);
  }

  return opp;
}

// ============================================================
// ALSO REBUILD QUICK-DEPLOY DATA
// ============================================================
function rebuildQuickDeploy() {
  try {
    require('./build-data');
    console.log('   → Quick-deploy data.js rebuilt');
  } catch (e) {
    console.log('   ⚠ Could not rebuild quick-deploy data:', e.message);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  try {
    console.log('\n🔄 Deal Health Dashboard — Ingesting opportunity data...\n');
    const payload = await readInput();
    const opp = transformPayload(payload);
    upsertOpportunity(opp);
    rebuildQuickDeploy();

    // Summary
    const sections = Object.values(opp.meddpicc);
    const totalScore = sections.reduce((s, sec) => s + sec.questions.reduce((a, q) => a + (q.score || 0), 0), 0);
    const totalMax = sections.reduce((s, sec) => s + sec.questions.length, 0);
    const pct = Math.round((totalScore / totalMax) * 100);
    const status = totalScore <= 25 ? '🔴 At Risk' : totalScore <= 40 ? '🟡 On Track' : '🟢 Good Health';

    console.log(`\n📊 Deal Health Summary:`);
    console.log(`   Account: ${opp.accountName}`);
    console.log(`   Stage: ${opp.stage} | Close: ${opp.closeDate}`);
    console.log(`   MCV: $${(opp.revenue.mcv || 0).toLocaleString()}`);
    console.log(`   Score: ${totalScore}/${totalMax} (${pct}%) ${status}`);
    console.log(`   Calls: ${opp.calls.length}`);
    console.log(`   Narrative sections: ${Object.values(opp.narrative).filter(v => v).length}/5`);
    console.log(`\n✨ Dashboard data updated. View at http://localhost:3000\n`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

// If run directly
if (require.main === module) {
  main();
}

// Export for programmatic use by the swarm
module.exports = { transformPayload, upsertOpportunity, MEDDPICC_TEMPLATE };
