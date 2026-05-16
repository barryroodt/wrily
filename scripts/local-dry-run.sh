#!/usr/bin/env bash
# Local DRY_RUN smoke against a real PR fixture — runs INSIDE the image.
# Isolated from host claude/MCP/keychain config; deterministic.
#
# Requires:
#   - .env at repo root with CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) + GITHUB_TOKEN
#   - Docker daemon running
#   - wrily-mastra:dev image built (`docker build -t wrily-mastra:dev .`)
#     — script rebuilds on every run by default; set SKIP_BUILD=1 to skip.
#
# The workflow now clones the target PR internally (cloneRepoStep), so this
# script no longer pre-clones to a bind-mounted /workspace.
#
# Usage: ./scripts/local-dry-run.sh <owner/repo> <pr-number> [<base-branch>]
set -euo pipefail

REPO=${1:?owner/repo required}
PR=${2:?pr number required}
BASE=${3:-main}

if [ ! -f .env ]; then
  echo "ERROR: .env not found at $(pwd)" >&2
  exit 2
fi

# Pull tokens from .env without polluting host env any further than needed.
set -a
source .env
set +a

PR_JSON="$(gh pr view "$PR" --repo "$REPO" --json headRefOid,author)"
COMMIT_SHA="$(echo "$PR_JSON" | jq -r '.headRefOid')"
PR_AUTHOR_LOGIN="$(echo "$PR_JSON" | jq -r '.author.login // ""')"

# Persist agent raw-output dump to host for inspection.
DEBUG_DUMP=/tmp/wrily-agent-output.log
rm -f "$DEBUG_DUMP"
touch "$DEBUG_DUMP"

# Build image with current source unless SKIP_BUILD=1.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> building wrily-mastra:dev"
  docker build -t wrily-mastra:dev . >/dev/null
fi

echo "==> running container against $REPO#$PR ($COMMIT_SHA, base=$BASE)"

# Run the workflow inside the container. The container clones the PR target
# itself via cloneRepoStep; /tmp/wrily-agent-output.log is mounted so we can
# inspect raw model output.
docker run --rm \
  --env-file .env \
  -e GITHUB_REPOSITORY="$REPO" \
  -e PR_NUMBER="$PR" \
  -e BASE_BRANCH="$BASE" \
  -e COMMIT_SHA="$COMMIT_SHA" \
  -e DRY_RUN=true \
  -e WRILY_DEBUG_AGENT_OUTPUT=/tmp/wrily-agent-output.log \
  -e PR_AUTHOR_LOGIN="$PR_AUTHOR_LOGIN" \
  -e WRILY_TRIGGER_SOURCE="${WRILY_TRIGGER_SOURCE:-push}" \
  -e GITHUB_ACTOR="${GITHUB_ACTOR:-}" \
  -e MODE="${MODE:-}" \
  -e MODEL="${MODEL:-}" \
  -e MAX_BUDGET="${MAX_BUDGET:-}" \
  -e SCOPE_OVERRIDE="${SCOPE_OVERRIDE:-}" \
  -e WRILY_AGENT_TIMEOUT_MS="${WRILY_AGENT_TIMEOUT_MS:-}" \
  -v "$DEBUG_DUMP":/tmp/wrily-agent-output.log \
  wrily-mastra:dev
