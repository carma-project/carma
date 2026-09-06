#!/usr/bin/env sh
# Run both CARMA importers (markdown + git history) for one repo. Designed to
# run *inside your private network* — e.g. an internal cron/systemd timer, an
# in-VPC CI runner, or a Railway cron service in the same project — so CARMA
# never needs public exposure. The importers dial out to CARMA; this box just
# needs network access to CARMA_URL, plus `node` and `git`.
#
# Config via environment:
#   CARMA_URL     required  e.g. http://carma.railway.internal:7100 (private) or https://...
#   TRUST_DOMAIN  required  e.g. cyberorbit
#   REPO_DIR      repo checkout to ingest            (default: .)
#   REPO_SLUG     owner/name used in memory URIs     (default: git remote / dir name)
#   PRIVATE_KEY   Ed25519 PKCS8 PEM to mint a token  (or set CARMA_TOKEN instead)
#   CARMA_TOKEN   pre-minted token (valid <15m for writes)
#   GIT_SINCE     only ingest commits since this     (default: full history)
#   GIT_MAX       cap commits scanned                (default: 100000)
# Pass --dry-run to preview without writing (no credentials needed).
set -eu

: "${CARMA_URL:?set CARMA_URL}"
: "${TRUST_DOMAIN:?set TRUST_DOMAIN}"
REPO_DIR="${REPO_DIR:-.}"

# Locate the CARMA repo (this script lives in <carma>/scripts/).
HERE="$(cd "$(dirname "$0")/.." && pwd)"

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

COMMON="--dir $REPO_DIR --url $CARMA_URL --domain $TRUST_DOMAIN"
[ -n "${REPO_SLUG:-}" ] && COMMON="$COMMON --repo $REPO_SLUG"

echo ">> markdown (specs / decisions / company OS)"
# shellcheck disable=SC2086
node --import tsx "$HERE/scripts/ingest-repo.mjs" $COMMON $DRY

echo ">> git history (reasoning behind every change)"
GITARGS="--max ${GIT_MAX:-100000}"
[ -n "${GIT_SINCE:-}" ] && GITARGS="$GITARGS --since \"$GIT_SINCE\""
# shellcheck disable=SC2086
eval "node --import tsx \"$HERE/scripts/ingest-git.mjs\" $COMMON $GITARGS $DRY"
