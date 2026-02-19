#!/bin/bash
# ============================================================
# PUBLISH.SH — Single-command deal health pipeline
# 
# Runs ingest → build → git commit → push in one shot.
# Eliminates multiple sequential LLM tool calls.
#
# Usage:
#   bash publish.sh "Update deal health: Account Name - 2026-02-19"
#   bash publish.sh  (uses default commit message)
#
# Prerequisites:
#   - Payload already written to deal-health-app/data/incoming-payload.json
#   - GitHub auth configured (GH_TOKEN or git credentials)
# ============================================================

set -euo pipefail

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

APP_DIR="/home/swarm/deal-health-app"
SITE_DIR="/home/swarm/deal-health-site"
REPO_DIR="/home/swarm/deal-health-dashboard"
PAYLOAD="$APP_DIR/data/incoming-payload.json"

echo "🔄 Deal Health Publish Pipeline"
echo "================================"

# -------------------------------------------------------
# Step 0: Ensure symlink for deal-health-site/data
# -------------------------------------------------------
if [ ! -L "$SITE_DIR/data" ] && [ ! -d "$SITE_DIR/data" ]; then
  ln -sfn "$APP_DIR/data" "$SITE_DIR/data"
  echo "✅ Created symlink: deal-health-site/data → deal-health-app/data"
fi

# -------------------------------------------------------
# Step 1: Run ingest pipeline (unless --skip-ingest)
# -------------------------------------------------------
if [ "$SKIP_INGEST" = true ]; then
  echo "⏭️  Skipping ingest (--skip-ingest flag set, assuming already ingested)"
else
  if [ ! -f "$PAYLOAD" ]; then
    echo "❌ No payload found at $PAYLOAD"
    echo "   The orchestrator should write the payload before calling publish."
    exit 1
  fi
  echo "✅ Payload found: $(wc -c < "$PAYLOAD") bytes"
  echo ""
  echo "📥 Running ingest..."
  cd "$APP_DIR"
  node ingest-deal.js --input data/incoming-payload.json
  echo "✅ Ingest complete"
fi

# -------------------------------------------------------
# Step 3: Run build pipeline (uses newer build-data.js with MAP support)
# -------------------------------------------------------
echo ""
echo "🏗️  Running build..."
cd "$SITE_DIR"
node build-data.js
echo "✅ Build complete"

# -------------------------------------------------------
# Step 4: Ensure git repo is cloned and configured
# -------------------------------------------------------
echo ""
echo "📦 Preparing git repo..."
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "   Cloning repository..."
  cd /home/swarm
  git clone https://github.com/ShivPatel15/deal-health-dashboard.git
  cd "$REPO_DIR"
  git config user.email "shiv.patel@shopify.com"
  git config user.name "Shiv Patel"
else
  cd "$REPO_DIR"
  # Reset to remote to avoid conflicts from other clones pushing
  git fetch origin main 2>/dev/null || true
  git reset --hard origin/main 2>/dev/null || true
fi

# -------------------------------------------------------
# Step 5: Copy built files to git repo
# -------------------------------------------------------
echo "   Copying built files..."

# Copy the generated data.js (the main output)
cp "$SITE_DIR/quick-deploy/data.js" "$REPO_DIR/data.js"

# Copy to quick-deploy subdirectory if it exists
mkdir -p "$REPO_DIR/quick-deploy"
cp "$SITE_DIR/quick-deploy/data.js" "$REPO_DIR/quick-deploy/data.js"

# Copy index.html if it's newer than what's in the repo
if [ "$SITE_DIR/index.html" -nt "$REPO_DIR/index.html" ] 2>/dev/null; then
  cp "$SITE_DIR/index.html" "$REPO_DIR/index.html"
  echo "   → Updated index.html"
fi

# Copy version history
if [ -f "$SITE_DIR/data-version-history.json" ]; then
  cp "$SITE_DIR/data-version-history.json" "$REPO_DIR/data-version-history.json"
fi

# Sync source scripts (build-data.js, ingest-deal.js, etc.) so repo stays current
for f in build-data.js ingest-deal.js coaching-engine.js lite-refresh.js score-rules.json daily-refresh.js; do
  if [ -f "$SITE_DIR/$f" ]; then
    cp "$SITE_DIR/$f" "$REPO_DIR/$f"
  fi
done

echo "✅ Files copied to git repo"

# -------------------------------------------------------
# Step 6: Git commit and push
# -------------------------------------------------------
echo ""
echo "🚀 Committing and pushing..."
cd "$REPO_DIR"
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  No changes to commit — dashboard is already up to date"
else
  git commit -m "$COMMIT_MSG"
  git push origin main
  echo "✅ Pushed to GitHub"
fi

# -------------------------------------------------------
# Step 7: Summary
# -------------------------------------------------------
echo ""
echo "================================"
echo "✨ Publish complete!"
echo "   Repo: https://github.com/ShivPatel15/deal-health-dashboard"
echo "   Site: https://deal-health.quick.shopify.io/"
echo ""
echo "⚠️  Reminder: Run 'quick deploy . deal-health --force' from local machine to make changes live."
echo "================================"
