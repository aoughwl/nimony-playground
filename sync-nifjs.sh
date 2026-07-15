#!/usr/bin/env bash
# sync-nifjs.sh — refresh the vendored nifjs.js from its canonical source.
#
# The single source of truth for nifjs is the repo **aoughwl/nifjs**. The
# nifjs.js in this playground is a *vendored copy* (the worker fetches it
# same-origin and the offline build embeds it), so don't hand-edit it here —
# edit it in the nifjs repo, then run this to pull it in and rebuild the offline
# bundle.
#
#   ./sync-nifjs.sh                      # fetch from aoughwl/nifjs @ main
#   NIFJS_SRC=~/nifjs/nifjs.js ./sync-nifjs.sh   # use a local checkout (dev)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$DIR/nifjs.js"
SRC="${NIFJS_SRC:-}"

if [ -n "$SRC" ] && [ -f "$SRC" ]; then
  echo "sync nifjs.js  ← local  $SRC"
  cp "$SRC" "$DEST"
else
  URL="https://raw.githubusercontent.com/aoughwl/nifjs/main/nifjs.js"
  echo "sync nifjs.js  ← remote $URL"
  command -v curl >/dev/null || { echo "FATAL: need curl (or set NIFJS_SRC)"; exit 1; }
  tmp="$(mktemp)"; curl -fsSL "$URL" -o "$tmp"
  # sanity: it must at least look like the nifjs module
  grep -q "global.NifiJs = api" "$tmp" || { echo "FATAL: fetched file isn't nifjs.js"; rm -f "$tmp"; exit 1; }
  mv "$tmp" "$DEST"
fi

# node syntax check, then rebuild the offline single-file bundle so it embeds the
# fresh nifjs.
node --check "$DEST" && echo "nifjs.js: syntax OK"
if [ -x "$DIR/build-standalone.sh" ]; then
  "$DIR/build-standalone.sh" >/dev/null && echo "standalone rebuilt"
fi
echo "done → $DEST"
