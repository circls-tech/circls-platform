#!/usr/bin/env bash
# Claude Code PreToolUse hook. Reads the tool call as JSON on stdin; for Bash
# commands it blocks pushes to main/release, merges into them, PR merges, force
# pushes, and protected-branch deletes. Exit 2 = block (message on stderr).
set -euo pipefail
input="$(cat)"
cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
[ -z "$cmd" ] && exit 0

block() { echo "✋ Sandbox guard: $1 Open a pull request from your fork instead." >&2; exit 2; }

# normalize whitespace
norm="$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')"

case "$norm" in
  *"git push"*" main"*|*"git push"*" release"*|*"git push"*":main"*|*"git push"*":release"*)
    block "pushing to main/release is not allowed." ;;
  *"git push"*"--force"*|*"git push"*"-f "*|*"git push --force-with-lease"*)
    block "force-pushing is not allowed." ;;
  *"git merge "*"main"*|*"git merge "*"release"*|*"git rebase "*"main"*|*"git rebase "*"release"*)
    block "merging/rebasing onto main/release is not allowed." ;;
  *"gh pr merge"*|*"git push"*"--delete"*|*"git push"*" :main"*|*"git push"*" :release"*)
    block "merging PRs / deleting protected branches is not allowed." ;;
esac
exit 0
