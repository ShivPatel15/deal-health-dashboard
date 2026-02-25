#!/bin/bash
# ============================================================
# VALIDATE-BEFORE-PUSH.SH — Safety checks before any git push
#
# Run this before pushing, or add as a pre-push hook.
# Ensures data.js and quick-deploy/data.js are valid and complete.
#
# Usage:
#   bash validate-before-push.sh
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo "🔍 Validating deal health data before push..."
echo ""

# -------------------------------------------------------
# Check 1: quick-deploy has all 3 required files
# -------------------------------------------------------
for f in quick-deploy/index.html quick-deploy/data.js quick-deploy/coaching-engine.js; do
  if [ ! -f "$f" ]; then
    echo -e "${RED}❌ MISSING: $f${NC}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "${GREEN}✅ Found: $f${NC}"
  fi
done

# -------------------------------------------------------
# Check 2: data.js and quick-deploy/data.js match
# -------------------------------------------------------
if [ -f "data.js" ] && [ -f "quick-deploy/data.js" ]; then
  HASH1=$(md5sum data.js | awk '{print $1}')
  HASH2=$(md5sum quick-deploy/data.js | awk '{print $1}')
  if [ "$HASH1" = "$HASH2" ]; then
    echo -e "${GREEN}✅ data.js and quick-deploy/data.js match${NC}"
  else
    echo -e "${RED}❌ data.js and quick-deploy/data.js DO NOT MATCH${NC}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# -------------------------------------------------------
# Check 3: data.js has valid JS structure and opp count
# -------------------------------------------------------
OPP_INFO=$(python3 -c "
import re, json
with open('data.js') as f:
    content = f.read()
# Verify it starts with 'const DEAL_DATA ='
if not content.strip().startswith('const DEAL_DATA ='):
    print('ERROR: data.js does not start with const DEAL_DATA =')
    exit(1)
match = re.search(r'const DEAL_DATA = (\{.*\});', content, re.DOTALL)
if not match:
    print('ERROR: Could not parse DEAL_DATA from data.js')
    exit(1)
data = json.loads(match.group(1))
opps = data.get('opportunities', [])
count = len(opps)

# Check each opp has key fields
issues = []
for o in opps:
    name = o.get('accountName', 'UNKNOWN')
    if not o.get('meddpicc'):
        issues.append(f'{name}: missing meddpicc')
    ns = len(o.get('nextSteps', []))
    if ns < 3:
        issues.append(f'{name}: only {ns} nextSteps (expected 10+)')
    mi = len(o.get('mutualActionPlan', {}).get('items', []))
    if mi < 5:
        issues.append(f'{name}: only {mi} MAP items (expected 10+)')
    if not o.get('narrative'):
        issues.append(f'{name}: missing narrative')
    if not o.get('scores'):
        issues.append(f'{name}: missing scores')

print(f'COUNT:{count}')
for i in issues:
    print(f'ISSUE:{i}')
" 2>&1)

OPP_COUNT=$(echo "$OPP_INFO" | grep '^COUNT:' | cut -d: -f2)
ISSUES=$(echo "$OPP_INFO" | grep '^ISSUE:' || true)

if [ -z "$OPP_COUNT" ]; then
  echo -e "${RED}❌ data.js is malformed — could not parse${NC}"
  echo "$OPP_INFO"
  ERRORS=$((ERRORS + 1))
elif [ "$OPP_COUNT" -lt 10 ]; then
  echo -e "${RED}❌ data.js has only $OPP_COUNT opportunities (expected 10+) — POSSIBLE DATA LOSS${NC}"
  ERRORS=$((ERRORS + 1))
else
  echo -e "${GREEN}✅ data.js has $OPP_COUNT opportunities${NC}"
fi

if [ -n "$ISSUES" ]; then
  echo -e "${YELLOW}⚠️  Data quality issues:${NC}"
  echo "$ISSUES" | sed 's/^ISSUE:/  ⚠️  /'
fi

# -------------------------------------------------------
# Check 4: coaching-engine.js is valid JS
# -------------------------------------------------------
if [ -f "quick-deploy/coaching-engine.js" ]; then
  node -c quick-deploy/coaching-engine.js 2>/dev/null
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ coaching-engine.js is valid JS${NC}"
  else
    echo -e "${RED}❌ coaching-engine.js has syntax errors${NC}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}❌ VALIDATION FAILED — $ERRORS error(s). DO NOT PUSH.${NC}"
  exit 1
else
  echo -e "${GREEN}✅ All checks passed. Safe to push.${NC}"
fi
