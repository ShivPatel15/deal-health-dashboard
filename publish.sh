#!/bin/bash
# ============================================================
# PUBLISH.SH — Single-command deal health pipeline
#
# Everything runs from /home/swarm/deal-health-app which is
# BOTH the working directory AND the git repo.
#
# Pipeline: ingest → build → git commit → push
#
# Usage:
#   bash publish.sh "Update deal health: Account Name - 2026-02-20"
#   bash publish.sh --skip-ingest "Daily refresh - 2026-02-20"
#   bash publish.sh  (uses default commit message)
#
# Prerequisites:
#   - Payload written to data/incoming-payload.json (unless --skip-ingest)
#   - GitHub auth configured (GH_TOKEN or git credentials)
#
# ARCHITECTURE (single directory):
#   /home/swarm/deal-health-app/
#     ├── data/opportunities.json  ← source of truth for all opps
#     ├── data.js                  ← built output (serves the site)
#     ├── quick-deploy/data.js     ← copy of data.js
#     ├── index.html               ← dashboard UI
#     ├── ingest-deal.js           ← merges payload into opportunities.json
#     ├── build-data.js            ← builds data.js from opportunities.json
#     └── .git/                    ← git repo (pushes to GitHub)
#
# CRITICAL RULES:
#   1. data/opportunities.json is the SINGLE SOURCE OF TRUTH
#   2. ingest-deal.js MERGES into existing opps (never overwrites)
#   3. build-data.js writes BOTH root data.js AND quick-deploy/data.js
#   4. There is only ONE directory — no deal-health-site or deal-health-dashboard
# ============================================================

set -euo pipefail

APP_DIR="/home/swarm/deal-health-app"
PAYLOAD="$APP_DIR/data/incoming-payload.json"

cd "$APP_DIR"

# Parse flags
SKIP_INGEST=false
COMMIT_MSG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-ingest) SKIP_INGEST=true; shift ;;
    *) COMMIT_MSG="$1"; shift ;;
  esac
done
COMMIT_MSG="${COMMIT_MSG:-Update deal health dashboard - $(date +%Y-%m-%d)}"

echo "🔄 Deal Health Publish Pipeline"
echo "================================"
echo "   Working directory: $APP_DIR"

# -------------------------------------------------------
# SAFETY CHECK: Verify opportunities.json exists and has data
# -------------------------------------------------------
OPP_FILE="$APP_DIR/data/opportunities.json"
if [ ! -f "$OPP_FILE" ]; then
  echo "❌ FATAL: data/opportunities.json does not exist!"
  echo "   This file is the source of truth for all opportunities."
  echo "   Refusing to continue — this would create a blank dashboard."
  exit 1
fi

OPP_COUNT=$(python3 -c "import json; print(len(json.load(open('$OPP_FILE'))))" 2>/dev/null || echo "0")
echo "   Existing opportunities: $OPP_COUNT"

if [ "$OPP_COUNT" -lt 2 ]; then
  echo "⚠️  WARNING: Only $OPP_COUNT opportunities in data store!"
  echo "   Expected 10+ opportunities. This may indicate data loss."
  echo "   Continuing but review the output carefully."
fi

# -------------------------------------------------------
# Step 1: Ingest (unless --skip-ingest)
# -------------------------------------------------------
if [ "$SKIP_INGEST" = true ]; then
  echo ""
  echo "⏭️  Skipping ingest (--skip-ingest flag)"
else
  if [ ! -f "$PAYLOAD" ]; then
    echo "❌ No payload at $PAYLOAD"
    echo "   Write the payload before calling publish.sh"
    exit 1
  fi
  echo ""
  echo "📥 Ingesting payload ($(wc -c < "$PAYLOAD") bytes)..."
  node ingest-deal.js --input data/incoming-payload.json
fi

# -------------------------------------------------------
# Step 2: Build (writes BOTH data.js and quick-deploy/data.js)
# -------------------------------------------------------
echo ""
echo "🏗️  Building data.js..."
node build-data.js

# -------------------------------------------------------
# SAFETY CHECK: Verify build output has same opp count
# -------------------------------------------------------
BUILT_COUNT=$(python3 -c "
import json
with open('data.js') as f:
    c = f.read()
d = json.loads(c[c.index('{'):c.rindex('};')+1])
print(len(d.get('opportunities', [])))
" 2>/dev/null || echo "0")

if [ "$BUILT_COUNT" != "$OPP_COUNT" ] && [ "$SKIP_INGEST" = true ]; then
  echo "⚠️  WARNING: Built data.js has $BUILT_COUNT opps but opportunities.json had $OPP_COUNT"
fi
echo "   Built $BUILT_COUNT opportunities into data.js"

# -------------------------------------------------------
# Step 3: Git commit and push
# -------------------------------------------------------
echo ""
echo "🚀 Committing and pushing..."
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  No changes to commit — dashboard already up to date"
else
  git commit -m "$COMMIT_MSG"
  git push origin main
  COMMIT_HASH=$(git rev-parse --short HEAD)
  echo "✅ Pushed commit $COMMIT_HASH"
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo "================================"
echo "✨ Publish complete!"
echo "   Opportunities: $BUILT_COUNT"
echo "   Repo: https://github.com/ShivPatel15/deal-health-dashboard"
echo "   Site: https://deal-health.quick.shopify.io/"
echo ""
echo "⚠️  Deploy: Clone the repo locally and run 'quick deploy . deal-health --force'"
echo "================================"
