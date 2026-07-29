#!/usr/bin/env bash
# obf-web-build.sh — build an aoughwl component's browser bundle with its APP
# modules obfuscated at the typed-IR (.s.nif) level, mirroring build-release.sh's
# layer C but for the nim_js web pipeline.
#
# Seam: `nimony c` in the web recipe produces BOTH the typed .s.nif AND the
# .c.nif in --nimcache. We build once, rewrite each APP module's .s.nif in place
# with the NIF obfuscator (behaviour-preserving control-flow + strip-info,
# --no-rename so no cross-module link hazard), then rebuild — nifmake sees the
# .s.nif is newer and resumes hexer -> .c.nif from the obfuscated IR (the
# untouched .p.nif means sem is NOT re-run, so obfuscation survives). Then nim_js
# each .c.nif and bundle exactly as the component's own build.sh does.
#
# An APP module is one whose .p.nif source-path is a project-relative path (not a
# stdlib/nimony/nimsem-web path) — std/system stay untouched (obfuscating them
# would bloat every bundle and risk nim_js-unsupported injected nodes).
#
# Usage: obf-web-build.sh <nimcache-dir> [obf-flags...]
#   Run AFTER the component build produced <nimcache-dir>/*.s.nif once; this
#   obfuscates + must be followed by the component's rebuild step.
set -u
OBF="${OBFUSCATE:-$HOME/obfuscate/obfuscate}"
NC="${1:?nimcache dir}"; shift || true
# NOTE: --dead-guard / heavy statement-wrapping can produce IR the hexer's
# init-analysis rejects ("cannot prove that `x has been initialized") when the
# wrapped statement is what first-initializes a var. We keep the SAFE, still-JS-
# changing set: junk-discard + opaque predicates + redundant nesting + strip-info
# (provenance annihilation). A module whose rebuild still fails degrades to its
# prior correct .c.nif — the build stays green. (obfuscate bug tracked in memory.)
FLAGS=("$@"); [ ${#FLAGS[@]} -eq 0 ] && FLAGS=(--typed --junk-discard --opaque-pred --nest --strip-info --no-rename --wrap-rate:4)

[ -x "$OBF" ] || { echo "obfuscate not built at $OBF — skipping obfuscation"; exit 0; }

is_app() {  # $1 = suffix; true if its .p.nif came from a project-relative source
  local p="$NC/$1.p.nif"; [ -f "$p" ] || return 1
  # 3rd token on the (stmts@,1,<path> line is the source path.
  local path; path=$(sed -n '4p;5p;6p' "$p" | grep -oE '[^ ]*\.nim' | head -1)
  [ -z "$path" ] && path=$(grep -m1 -oE '[A-Za-z0-9_./-]+\.nim' "$p")
  case "$path" in
    /home/savant/nimony/*|/home/savant/nimsem-web/*|*/lib/std/*|*/lib/system/*|/usr/*) return 1;;
    "" ) return 1;;
    * ) return 0;;   # project-relative (src/...) or component src root
  esac
}

KEEP="$(mktemp)"; : > "$KEEP"   # empty keep-list (irrelevant under --no-rename)
trap 'rm -f "$KEEP"' EXIT
count=0
for s in "$NC"/*.s.nif; do
  [ -f "$s" ] || continue
  suf=$(basename "$s" .s.nif)
  if is_app "$suf"; then
    "$OBF" "${FLAGS[@]}" "$KEEP" "$s" >/dev/null 2>&1 && { touch "$s"; count=$((count+1)); echo "  obf app module: $suf"; }
  fi
done
echo "obfuscated $count app module(s) in $NC"
