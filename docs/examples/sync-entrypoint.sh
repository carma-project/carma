#!/usr/bin/env sh
# Entrypoint for the carma-sync job image (see Dockerfile.sync). Clones your
# knowledge repo and runs both importers against a (private) CARMA. Intended to
# run as a Railway cron service in the SAME project as CARMA, reaching it over
# private networking — CARMA never needs public exposure.
#
# Environment:
#   REPO_URL      required  https://github.com/owner/name.git
#   CARMA_URL     required  e.g. http://carma.railway.internal:7100
#   TRUST_DOMAIN  required  e.g. cyberorbit
#   PRIVATE_KEY   the Ed25519 PKCS8 PEM (to mint a short-lived token per run)
#   GIT_TOKEN     optional  PAT / deploy token for private repo clones
#   GIT_SINCE     optional  incremental window, e.g. "14 days ago" (default: full history)
set -eu
: "${REPO_URL:?set REPO_URL}"
: "${CARMA_URL:?set CARMA_URL}"
: "${TRUST_DOMAIN:?set TRUST_DOMAIN}"

WORK=/work
url="$REPO_URL"
if [ -n "${GIT_TOKEN:-}" ]; then
  url=$(printf '%s' "$REPO_URL" | sed "s#https://#https://x-access-token:${GIT_TOKEN}@#")
fi
rm -rf "$WORK"
git clone "$url" "$WORK"

REPO_SLUG="${REPO_SLUG:-$(printf '%s' "$REPO_URL" | sed -E 's#.*[/:]([^/]+/[^/]+?)(\.git)?$#\1#')}"
export REPO_DIR="$WORK" REPO_SLUG
exec sh /carma/scripts/sync-repo.sh
