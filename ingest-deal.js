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
const { fixPayload } = require('./lib/fix-payload');

const DATA_DIR = path.join(__dirname, 'data');
const OPP_FILE = path.join(DATA_DIR, 'opportunities.json');
const SHARING_FILE = path.join(DATA_DIR, 'sharing.json');
const SPEAKERS_FILE = path.join(DATA_DIR, 'transcript-speakers.json');

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
  // Support both 'meddpicc' and 'sections' keys from analyst output
  const analystMeddpicc = analysis.sections || analysis.meddpicc || {};

  // Map snake_case keys to camelCase for section lookup
  const sectionKeyMap = {
    metrics: 'metrics',
    economicBuyer: 'economic_buyer',
    decisionProcess: 'decision_process',
    decisionCriteria: 'decision_criteria',
    paperProcess: 'paper_process',
    identifyPain: 'identify_pain',
    champion: 'champion',
    competition: 'competition',
  };

  for (const [sectionKey, template] of Object.entries(MEDDPICC_TEMPLATE)) {
    // Try both camelCase and snake_case versions
    const snakeKey = sectionKeyMap[sectionKey] || sectionKey;
    const analystSection = analystMeddpicc[sectionKey] || analystMeddpicc[snakeKey] || {};
    const analystQuestions = analystSection.questions || {};

    meddpicc[sectionKey] = {
      label: template.label,
      questions: template.questions.map((q, i) => {
        // Analyst output uses Q1, Q2, etc. keys (object), not array
        const questionKeyUpper = `Q${i + 1}`;
        const questionKeyLower = `q${i + 1}`;
        const aq = Array.isArray(analystQuestions) ? analystQuestions[i] : (analystQuestions[questionKeyUpper] || analystQuestions[questionKeyLower] || {});
        // Support both 'answer' and 'score' field from analyst
        const answer = aq.answer || aq.score || 'No';
        return {
          q: q,
          answer: answer,
          score: answer === 'Yes' ? 1 : answer === 'Partial' ? 0.5 : 0,
          notes: aq.notes || '',
          solution: aq.solution || '',
          action: aq.action || '',
          due: aq.due_date || aq.due || '',
          highlight: aq.highlight || false,
        };
      })
    };
  }

  // Build the opportunity record
  // Support both snake_case (from Salesforce Reader) and camelCase field names
  const opp = {
    id: sf.opportunity_id || sf.opportunityId || sf.id || `opp_${Date.now()}`,
    name: sf.opportunity_name || sf.name || sf.account_name || sf.accountName || 'Unknown',
    accountName: sf.account_name || sf.accountName || sf.opportunity_name || sf.name || 'Unknown',
    accountId: sf.account_id || sf.accountId || '',
    stage: sf.stage || 'Unknown',
    closeDate: sf.close_date || sf.closeDate || '',
    forecastCategory: sf.forecast_category || sf.forecastCategory || '',
    probability: sf.probability || 0,
    type: sf.type || 'New Business',
    merchantIntent: sf.merchant_intent || sf.merchantIntent || '',
    owner: sf.owner || '',
    ownerEmail: sf.owner_email || sf.ownerEmail || '',
    revenue: {
      mcv: sf.revenue?.mcv || sf.revenue?.amount || sf.mcv || 0,
      totalRev3yr: sf.revenue?.totalRev3yr || sf.revenue?.total_revenue_3yr || sf.totalRev3yr || 0,
      d2cGmv: sf.revenue?.d2cGmv || sf.revenue?.d2c_gmv || null,
      b2bGmv: sf.revenue?.b2bGmv || sf.revenue?.b2b_gmv || null,
      retailGmv: sf.revenue?.retailGmv || sf.revenue?.retail_gmv || null,
      paymentsGpv: sf.revenue?.paymentsGpv || sf.revenue?.payments_gpv || 0,
      paymentsAttached: sf.revenue?.paymentsAttached || sf.revenue?.payments_attached || false,
      ipp: sf.revenue?.ipp || 0,
    },
    // Normalize products to strings (payload may send {name, amount} or plain strings)
    products: (sf.products || []).map(p => typeof p === 'string' ? p : (p.name || p.product_name || String(p))),
    stakeholders: (sf.stakeholders || []).map(s => ({
      name: s.name || '',
      title: s.title || '',
      role: s.role || '',
      email: s.email || '',
      engagement: s.engagement || 'none',
      callsAttended: s.calls_attended || s.callsAttended || 0,
      callsInvited: s.calls_invited || s.callsInvited || 0,
    })),
    shopifyTeam: (sf.shopify_team || sf.shopifyTeam || []).map(s => ({
      name: s.name || '',
      role: s.role || '',
      email: s.email || '',
    })),
    competitive: {
      primary: sf.competitive?.primary || sf.competitor || '',
      position: sf.competitive?.position || sf.position_vs_competitor || '',
      partner: sf.competitive?.partner || '',
    },
    timeline: {
      created: sf.timeline?.created || sf.created_date || sf.created || new Date().toISOString().split('T')[0],
      proposedLaunch: sf.timeline?.proposedLaunch || sf.proposed_launch_date_plus || sf.proposed_launch_date_enterprise || '',
      region: sf.timeline?.region || 'EMEA',
    },
    projectedBilledRevenue: sf.projected_billed_revenue || sf.projectedBilledRevenue || sf.revenue?.projected_billed_revenue || sf.revenue?.projectedBilledRevenue || null,
    compellingEvent: analysis.compellingEvent || sf.compelling_event || sf.compellingEvent || '',
    aeNextStep: sf.ae_next_steps || sf.aeNextStep || sf.nextStep || '',
    narrative: {
      oppSummary: analysis.opp_summary || analysis.oppSummary || analysis.narratives?.opp_summary || analysis.narratives?.oppSummary || analysis.narrative?.oppSummary || '',
      whyChange: analysis.why_change || analysis.whyChange || analysis.narratives?.why_change || analysis.narratives?.whyChange || analysis.narrative?.whyChange || '',
      whyShopify: analysis.why_shopify || analysis.whyShopify || analysis.narratives?.why_shopify || analysis.narratives?.whyShopify || analysis.narrative?.whyShopify || '',
      whyNow: analysis.why_now || analysis.whyNow || analysis.narratives?.why_now || analysis.narratives?.whyNow || analysis.narrative?.whyNow || '',
      supportNeeded: analysis.support_needed || analysis.supportNeeded || analysis.narratives?.support_needed || analysis.narratives?.supportNeeded || analysis.narrative?.supportNeeded || '',
    },
    meddpicc: meddpicc,
    lastAnalysisDate: new Date().toISOString().split('T')[0],
    calls: calls.map(c => ({
      date: c.date || '',
      title: c.title || '',
      duration: c.duration || (c.duration_minutes ? `${c.duration_minutes} min` : ''),
      shopifyAttendees: c.shopify_attendees || c.shopifyAttendees || [],
      merchantAttendees: c.merchant_attendees || c.merchantAttendees || [],
      summary: c.summary || c.ai_summary || '',
    })),

    // MAP and coaching snapshots are auto-generated by build-data.js
    // mutualActionPlan will be built from MEDDPICC gaps during build
    // coachingSnapshots will get first entry during build
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
    let payload = await readInput();

    // === AUTO-FIX: resolve AE/SE→names and compute transcript-verified attendance ===
    // Load transcript speakers map if it exists (written by orchestrator from BigQuery step 2b)
    let transcriptSpeakers = null;
    if (fs.existsSync(SPEAKERS_FILE)) {
      try {
        transcriptSpeakers = JSON.parse(fs.readFileSync(SPEAKERS_FILE, 'utf-8'));
        console.log(`   📋 Loaded transcript speakers for ${Object.keys(transcriptSpeakers).length} calls`);
      } catch (e) {
        console.log(`   ⚠ Could not load transcript speakers: ${e.message}`);
      }
    } else {
      console.log('   ℹ No transcript-speakers.json found — attendance will use RSVP fallback');
    }
    payload = fixPayload(payload, transcriptSpeakers);
    console.log('   ✅ Payload fixed (names resolved, attendance computed)');

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
    console.log(`   PBR: $${(opp.projectedBilledRevenue || 0).toLocaleString()} | MCV: $${(opp.revenue.mcv || 0).toLocaleString()}`);
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
