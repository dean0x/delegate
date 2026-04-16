#!/bin/bash
set -euo pipefail

echo "=== Release Pre-flight Checks ==="

# Auth checks
echo "Checking npm auth..."
npm whoami || { echo "❌ Not authenticated to npm"; exit 1; }
echo "Checking gh auth..."
gh auth status 2>&1 || { echo "❌ Not authenticated to GitHub"; exit 1; }

# State checks
BRANCH=$(git branch --show-current)
[[ "$BRANCH" == "main" || "$BRANCH" == release/* ]] || { echo "❌ Not on main or release branch (on: $BRANCH)"; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "❌ Uncommitted changes"; exit 1; }

# Version checks
PUBLISHED=$(npm view autobeat version 2>/dev/null || echo "0.0.0")
PACKAGE=$(node -p "require('./package.json').version")
echo "Published: $PUBLISHED | Package: $PACKAGE"
[[ "$PUBLISHED" != "$PACKAGE" ]] || { echo "❌ Version not bumped (both are $PUBLISHED)"; exit 1; }

# Release notes check
NOTES="docs/releases/RELEASE_NOTES_v${PACKAGE}.md"
[[ -f "$NOTES" ]] || { echo "❌ Missing $NOTES"; exit 1; }

# Build + validate
echo "Running typecheck + lint + build..."
npm run typecheck && npm run check && npm run build

echo "✅ All pre-flight checks passed for v${PACKAGE}"
