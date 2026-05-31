#!/usr/bin/env bash
# Enforce "no direct pushes to main" via a GitHub branch ruleset: require a PR and
# the CI checks (verify, db), block force-pushes and deletions, applied to EVERYONE
# (empty bypass_actors — no admin escape). Idempotent: updates the existing
# 'protect-main' ruleset if present, else creates it.
#
# REQUIRES GitHub Pro (or Team/Enterprise) for PRIVATE repos. On the free plan this
# returns HTTP 403 "Upgrade to GitHub Pro". Until then,
# .github/workflows/guard-main.yml gives detect-only soft enforcement (it alerts on
# direct pushes but cannot block them).
#
# Requires: gh CLI authenticated as a repo admin (VedantS01).
# Run: bash scripts/release/protect-main.sh
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "==> Protecting main on: $REPO (active gh: $(gh api user -q .login))"

BODY=$(cat <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
      "required_approving_review_count": 0,
      "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": false,
      "require_last_push_approval": false,
      "required_review_thread_resolution": false,
      "allowed_merge_methods": ["merge", "squash", "rebase"]
    } },
    { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [ { "context": "verify" }, { "context": "db" } ]
    } }
  ],
  "bypass_actors": []
}
JSON
)

EXISTING=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="protect-main") | .id' 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "==> Updating existing ruleset $EXISTING"
  printf '%s' "$BODY" | gh api --method PUT "repos/$REPO/rulesets/$EXISTING" --input - >/dev/null
else
  echo "==> Creating ruleset"
  printf '%s' "$BODY" | gh api --method POST "repos/$REPO/rulesets" --input - >/dev/null
fi

echo "✅ 'protect-main' ruleset active: PR required, checks [verify, db] must pass,"
echo "   no direct/force push, no deletion, no bypass (applies to admins too)."
