#!/usr/bin/env node
// ============================================================
// FIX-PAYLOAD.JS
// Post-processes the incoming payload to:
//   1. Replace generic role refs (AE/SE) with actual owner names
//   2. Compute stakeholder call attendance from transcript speakers
//      (not calendar RSVPs which can be stale)
//
// Usage:
//   node lib/fix-payload.js --input data/incoming-payload.json
//   OR require and call: fixPayload(payload, transcriptSpeakers)
//
// transcriptSpeakers format (from BigQuery):
//   { "event_id_1": ["Speaker Name 1", "Speaker Name 2"], ... }
//
// If transcriptSpeakers is not provided, falls back to
// merchant_attendees (less accurate — calendar RSVP based).
// ============================================================

const fs = require('fs');
const path = require('path');

// ============================================================
// FIX 1: Replace generic role refs with actual names
// ============================================================
function resolveNames(payload) {
  const sf = payload.salesforce || {};
  const owner = sf.owner || '';           // e.g. "Adriana Colacicco"
  const ownerFirst = owner.split(' ')[0]; // e.g. "Adriana"
  const team = sf.shopify_team || sf.shopifyTeam || [];

  // Find SE by role
  const se = team.find(t =>
    t.role && (t.role.includes('Solutions') || t.role.includes('SE') || t.role.includes('Engineer'))
  );
  const seName = se ? se.name : '';
  const seFirst = seName ? seName.split(' ')[0] : '';

  // Build replacement pairs — order matters (longest match first)
  const replacements = [];
  if (ownerFirst && seFirst) {
    replacements.push([/\bAE\/SE to\b/g, `${ownerFirst} & ${seFirst} to`]);
    replacements.push([/\bAE & SE to\b/g, `${ownerFirst} & ${seFirst} to`]);
  }
  if (ownerFirst) {
    replacements.push([/\bAE to\b/g, `${ownerFirst} to`]);
  }
  if (seFirst) {
    replacements.push([/\bSE to\b/g, `${seFirst} to`]);
  }

  function applyReplacements(obj) {
    if (!obj) return obj;
    if (typeof obj === 'string') {
      let s = obj;
      for (const [regex, replacement] of replacements) {
        s = s.replace(regex, replacement);
      }
      return s;
    }
    if (Array.isArray(obj)) return obj.map(applyReplacements);
    if (typeof obj === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = applyReplacements(v);
      }
      return result;
    }
    return obj;
  }

  // Apply to MEDDPICC sections (action, solution, notes fields)
  if (payload.meddpicc_analysis && payload.meddpicc_analysis.sections) {
    payload.meddpicc_analysis.sections = applyReplacements(payload.meddpicc_analysis.sections);
  }

  return payload;
}

// ============================================================
// FIX 2: Compute stakeholder call attendance
//
// Strategy:
//   - calls_invited: stakeholder appeared in the call's attendee list
//     (calendar RSVP for Google Meet, or was the called person for dialer)
//   - calls_attended: stakeholder was ACTUALLY on the call
//     For transcribed calls: their name appears as a speaker in the transcript
//     For non-transcribed calls: disposition=Connected (dialer only)
//
// Why not just use calendar RSVP?
//   Calendar response_status can be stale. Someone may accept an
//   invite weeks before, then go on leave and not actually join.
//   Transcript speaker data is ground truth for meeting attendance.
//
// transcriptSpeakers: { event_id: [speaker_name, ...] }
//   This comes from BigQuery step 2b — the full_transcript data
//   grouped by event_id with distinct speaker_names.
//   If not provided, we fall back to merchant_attendees (RSVP-based).
// ============================================================
function computeCallAttendance(payload, transcriptSpeakers) {
  const calls = payload.calls || [];
  const stakeholders = payload.salesforce.stakeholders || [];

  for (const s of stakeholders) {
    let invited = 0;
    let attended = 0;
    const name = s.name || '';
    const firstName = name.split(' ')[0].toLowerCase();
    const lastName = name.split(' ').slice(1).join(' ').toLowerCase();

    for (const c of calls) {
      const merchantAttendees = c.merchant_attendees || [];

      // Check if invited (appeared in attendee list)
      const wasInvited = merchantAttendees.some(a => {
        const aLower = (a || '').toLowerCase();
        return aLower === name.toLowerCase() || aLower.startsWith(firstName);
      });

      if (!wasInvited) continue;
      invited++;

      // Check if actually attended
      const eventId = c.event_id;
      const hasTranscript = c.has_transcript === true;
      const platform = c.platform || '';
      const disposition = c.disposition || '';

      if (hasTranscript && transcriptSpeakers && transcriptSpeakers[eventId]) {
        // For transcribed calls: check if they spoke
        const speakers = transcriptSpeakers[eventId].map(sp => sp.toLowerCase());
        const spoke = speakers.some(sp => {
          // Match by first name, full name, or last name
          return sp === name.toLowerCase()
            || sp === firstName
            || sp.includes(firstName)
            || (lastName && sp.includes(lastName));
        });
        if (spoke) attended++;
      } else if (platform === 'salesloft_dialer' || platform === 'salesloft') {
        // For dialer calls without transcript: Connected = attended
        if (disposition === 'Connected') attended++;
      } else if (!hasTranscript) {
        // Non-transcribed Google Meet: fall back to RSVP (best we can do)
        // But flag this as uncertain
        if (disposition === 'Connected') attended++;
      } else {
        // Has transcript but no transcriptSpeakers map provided
        // Fall back to RSVP (less accurate)
        attended++;
      }
    }

    s.calls_attended = attended;
    s.calls_invited = invited;

    // Set engagement level
    if (attended >= 2) s.engagement = 'high';
    else if (attended >= 1) s.engagement = 'medium';
    else s.engagement = 'low';
  }

  return payload;
}

// ============================================================
// MAIN: Apply all fixes
// ============================================================
function fixPayload(payload, transcriptSpeakers) {
  payload = resolveNames(payload);
  payload = computeCallAttendance(payload, transcriptSpeakers);
  return payload;
}

// ============================================================
// CLI mode
// ============================================================
if (require.main === module) {
  const inputIdx = process.argv.indexOf('--input');
  if (inputIdx === -1 || !process.argv[inputIdx + 1]) {
    console.error('Usage: node lib/fix-payload.js --input <payload.json> [--speakers <speakers.json>]');
    process.exit(1);
  }

  const inputFile = process.argv[inputIdx + 1];
  const payload = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

  // Optional transcript speakers file
  let transcriptSpeakers = null;
  const speakersIdx = process.argv.indexOf('--speakers');
  if (speakersIdx !== -1 && process.argv[speakersIdx + 1]) {
    transcriptSpeakers = JSON.parse(fs.readFileSync(process.argv[speakersIdx + 1], 'utf-8'));
  }

  const fixed = fixPayload(payload, transcriptSpeakers);

  // Write back
  fs.writeFileSync(inputFile, JSON.stringify(fixed, null, 2));

  // Report
  console.log('✅ Payload fixes applied:');
  console.log('   → Generic role refs (AE/SE) replaced with actual names');
  console.log('   → Stakeholder call attendance computed');
  for (const s of fixed.salesforce.stakeholders || []) {
    console.log(`     ${s.name}: attended=${s.calls_attended}/${s.calls_invited} (${s.engagement})`);
  }
}

module.exports = { fixPayload, resolveNames, computeCallAttendance };
