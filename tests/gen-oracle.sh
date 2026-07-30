#!/usr/bin/env bash
# gen-oracle.sh — fill in the corpus cases that ship no golden `.output` by
# compiling+running them NATIVELY with the nimony fork (the reference impl).
# Results land in tests/oracle/<cat>__<base>.output and are picked up by
# gen-corpus.mjs on its next run.
#
#   bash tests/gen-oracle.sh            # only missing ones
#   FORCE=1 bash tests/gen-oracle.sh    # redo all
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIMONY=/home/savant/nimony/bin/nimony
OUT="$HERE/oracle"; mkdir -p "$OUT"
mkdir -p "$HERE/_oracle_work"

emit() {   # emit <id> <nim-file>
  local id="$1" f="$2" dest="$OUT/${1//\//__}.output"
  [ -s "$dest" ] && [ -z "${FORCE:-}" ] && return 0
  local cache; cache="$(mktemp -d "$HERE/_oracle_work/nc.XXXXXX")"
  local o; o="$( cd "$(dirname "$f")" && timeout 180 "$NIMONY" c -r --nimcache:"$cache" -f "$(basename "$f")" 2>/dev/null )"
  local rc=$?
  rm -rf "$cache"
  if [ $rc -ne 0 ]; then echo "SKIP  $id (native rc=$rc)"; return 0; fi
  # drop nimony's own compile chatter (FILE(l, c) Hint/Warning:)
  printf '%s\n' "$o" | grep -av -E '^[^ ]+\.nim\([0-9]+, [0-9]+\) (Hint|Warning):' > "$dest"
  echo "OK    $id"
}

for f in /home/savant/aowli/tests/realworld/*.nim;            do emit "realworld/$(basename "$f" .nim)"   "$f"; done
for f in /home/savant/aowli/tests/runtime_conformance/*.nim;  do emit "runtimeconf/$(basename "$f" .nim)" "$f"; done
# the shipped playground demo
node -e '
const fs=require("fs");
const js=fs.readFileSync("'"$HERE"'/../examples.js","utf8");
const m=/window\.PLAYGROUND_DEMO\s*=\s*`([\s\S]*?)`;/.exec(js);
fs.writeFileSync("'"$HERE"'/_oracle_work/demo.nim", m[1].replace(/\\`/g,"`").replace(/\\\$/g,"$"));'
emit "playground/demo" "$HERE/_oracle_work/demo.nim"
