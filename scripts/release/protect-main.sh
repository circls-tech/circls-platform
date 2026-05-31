#!/usr/bin/env bash
# Turn on branch protection for `main`: require a PR and the CI checks (verify, db)
# before merge; block direct pushes, force-pushes, and deletions. Idempotent.
# Requires: gh CLI authenticated as a repo admin (VedantS01). Run: bash scripts/release/protect-main.sh
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "==> Protecting main on: $REPO"
echo "    (active gh account: $(gh api user -q .login))"

gh api --method PUT "repos/$REPO/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify", "db"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON

echo "✅ main is protected: PR required, checks [verify, db] must pass, no direct/force push."
echo "   Note: enforce_admins=false leaves you (admin) an emergency escape hatch."
echo "   required_approving_review_count=0 lets you merge your own PR once CI is green (solo-friendly)."
