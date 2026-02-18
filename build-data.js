#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read opportunities from the ingest pipeline output
const dataPath = path.join(__dirname, 'data', 'opportunities.json');
const opportunities = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Define sections and scoring
const sections = [
  { label: 'Metrics', sectionKey: 'metrics' },
  { label: 'Economic Buyer', sectionKey: 'economicBuyer' },
  { label: 'Decision Criteria', sectionKey: 'decisionCriteria' },
  { label: 'Decision Process', sectionKey: 'decisionProcess' },
  { label: 'Paper Process', sectionKey: 'paperProcess' },
  { label: 'Identify Pain', sectionKey: 'identifyPain' },
  { label: 'Champion', sectionKey: 'champion' },
  { label: 'Competition', sectionKey: 'competition' }
];

function computeScores(opportunity) {
  const scores = {};
  let totalActual = 0;
  let totalPossible = 0;

  sections.forEach(section => {
    const sectionData = opportunity.meddpicc?.[section.sectionKey];
    if (!sectionData) {
      scores[section.label] = { actual: 0, possible: 0 };
      return;
    }

    let sectionActual = 0;
    let sectionPossible = 0;

    Object.values(sectionData).forEach(item => {
      if (item && typeof item === 'object' && 'weight' in item) {
        const weight = item.weight || 0;
        sectionPossible += weight;
        
        if (item.status === 'green') {
          sectionActual += weight;
        } else if (item.status === 'amber') {
          sectionActual += weight * 0.5;
        }
        // red = 0
      }
    });

    // Use section.label as the key (e.g., "Metrics", "Economic Buyer")
    // This matches how the dashboard HTML looks up scores
    scores[section.label] = { 
      actual: sectionActual, 
      possible: sectionPossible 
    };
    
    totalActual += sectionActual;
    totalPossible += sectionPossible;
  });

  scores.total = { actual: totalActual, possible: totalPossible };
  return scores;
}

function computeNextSteps(opportunity) {
  const nextSteps = [];
  
  sections.forEach(section => {
    const sectionData = opportunity.meddpicc?.[section.sectionKey];
    if (!sectionData) return;

    Object.entries(sectionData).forEach(([key, item]) => {
      if (item && typeof item === 'object' && item.status === 'red') {
        nextSteps.push({
          category: section.label,
          field: key,
          description: item.rationale || item.evidence || 'No details provided',
          priority: 'high'
        });
      } else if (item && typeof item === 'object' && item.status === 'amber') {
        nextSteps.push({
          category: section.label,
          field: key,
          description: item.rationale || item.evidence || 'No details provided',
          priority: 'medium'
        });
      }
    });
  });

  return nextSteps;
}

// Build enriched opportunities
const enrichedOpportunities = opportunities.map(opp => {
  const scores = computeScores(opp);
  const nextSteps = computeNextSteps(opp);
  
  return {
    ...opp,
    scores,
    nextSteps
  };
});

// Generate data.js file
const outputPath = path.join(__dirname, 'quick-deploy', 'data.js');
const dataJs = `// Generated: ${new Date().toISOString()}
window.dealhealthData = ${JSON.stringify(enrichedOpportunities, null, 2)};
`;

fs.writeFileSync(outputPath, dataJs, 'utf8');
console.log(`✅ Generated ${outputPath} with ${enrichedOpportunities.length} opportunities`);
console.log(`   Scores computed using section.label keys for dashboard compatibility`);
