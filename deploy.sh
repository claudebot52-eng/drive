#!/usr/bin/env bash
# Publish the drive screen to GitHub Pages: bump the offline-cache version, commit, push, enable Pages, wait for the build.
set -euo pipefail
cd "$(dirname "$0")"
REPO=drive
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }
v=$(date +%Y%m%d%H%M)
sed -i '' "s/const CACHE_VERSION = \".*\"/const CACHE_VERSION = \"v$v\"/" sw.js
git add -A
git commit -qm "deploy: $v" || true
if ! git remote get-url origin >/dev/null 2>&1; then
  if gh repo view "$REPO" >/dev/null 2>&1; then git remote add origin "$(gh repo view "$REPO" --json url -q .url).git"
  else gh repo create "$REPO" --public --source=. --remote=origin; fi
fi
git push -qu origin main
body=$(gh api -X POST "repos/{owner}/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' 2>&1) || printf '%s' "$body" | grep -qiE 'already|409' || { echo "$body"; exit 1; }
status=""
for _ in $(seq 1 24); do
  status=$(gh api "repos/{owner}/$REPO/pages" -q .status 2>/dev/null || true)
  [ "$status" = "built" ] && break
  sleep 5
done
echo "$(gh api "repos/{owner}/$REPO/pages" -q .html_url) ($status)"
