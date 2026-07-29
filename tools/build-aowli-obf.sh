#!/usr/bin/env bash
# Build aowli's four browser bundles with app modules obfuscated at the .s.nif
# level: aowli.js (tree), aowli_vm.js (VM), aowli_run.js (run-rung), aowli_dbg.js
# (the NEW debugger capture entry). Mirrors aowli/webtest/build.sh per entry,
# inserting the IR-obfuscation + rebuild pass between frontend and nim_js, and
# prepends the env host-shim the bundles need at startup.
set -u
NIM=/home/savant/nimony
WEB=/home/savant/nimony-web
NIFI=/home/savant/aowli
JSFFI="$WEB/tests/jsbackend"
AOWLHL=/home/savant/aowlhl/src
AOWLABI=/home/savant/aowlabi/src
HERE="$NIFI/webtest"
OBFTOOL="$HOME/nimony-playground/tools/obf-web-build.sh"

# entry-basename  ->  output bundle name
declare -A ENTRIES=(
  [webmain]=aowli.js
  [webmain_vm]=aowli_vm.js
  [webmain_run]=aowli_run.js
  [webmain_dbg]=aowli_dbg.js
)

build_entry() {
  local entry="$1" out="$2"
  local NC="$HERE/obfnc_$entry"
  echo "==== $entry -> $out ===="
  FE() {
    "$NIM/bin/nimony" c --bits:32 --define:nimNativeAlloc \
      -p:"$NIM/src/lib" -p:"$NIM/src/nimony" -p:"$NIM/src/models" \
      -p:"$NIM/src/gear2" -p:"$NIFI/src/aowli" -p:"$JSFFI" -p:"$AOWLHL" -p:"$AOWLABI" \
      --nimcache:"$NC" "$NIFI/src/aowli/$entry.nim" 2>&1 | grep -viE '^$' | tail -6
  }
  echo "  1a. frontend build #1"
  rm -rf "$NC"; mkdir -p "$NC"; FE
  mapfile -t cnifs < <(find "$NC" -name '*.c.nif')
  echo "     .c.nif: ${#cnifs[@]}"
  [ "${#cnifs[@]}" -eq 0 ] && { echo "     FATAL: $entry frontend failed"; return 1; }

  echo "  1b. obfuscate app .s.nif"
  bash "$OBFTOOL" "$NC"

  echo "  1c. rebuild from obfuscated IR"
  FE
  mapfile -t cnifs < <(find "$NC" -name '*.c.nif')

  echo "  2. nim_js each -> .js"
  local total=0
  for c in "${cnifs[@]}"; do
    o="$("$WEB/bin/nim_js" "$c" "${c%.c.nif}.js" 2>&1)"
    echo "$o" | grep -qE 'unsupported node' && total=$((total+$(echo "$o" | grep -oE '[0-9]+ unsupported' | grep -oE '[0-9]+' | head -1)))
  done
  echo "     unsupported nodes: $total"

  echo "  3. bundle -> $out"
  local BUNDLE="$HERE/$out"
  local AF="$HERE/.a.$entry" FF="$HERE/.f.$entry" KF="$HERE/.k.$entry"
  local jsfiles=(); for c in "${cnifs[@]}"; do jsfiles+=("${c%.c.nif}.js"); done
  awk -v AF="$AF" -v FF="$FF" -v KF="$KF" '
    /^\/\/__NIMJS_CONST_ALLOC_BEGIN__$/ { s=1; next }
    /^\/\/__NIMJS_CONST_ALLOC_END__$/   { s=0; next }
    /^\/\/__NIMJS_CONST_FILL_BEGIN__$/  { s=2; next }
    /^\/\/__NIMJS_CONST_FILL_END__$/    { s=0; next }
    /^"use strict";$/                   { next }
    { if (s==1) print > AF; else if (s==2) print > FF; else print > KF }
  ' "${jsfiles[@]}"
  # env host-shim: the interp reads the process env at startup (getEnvVarsC ->
  # environ / getenv externs) which jsffi/runtime.js does not provide. Prepend a
  # 3-line stub so the bundle boots. (This lives in the ARTIFACT — a plain
  # build.sh rebuild would drop it; that's why this driver re-adds it.)
  {
    echo '"use strict";'
    echo 'var environ = (typeof environ !== "undefined") ? environ : 0;'
    echo 'function getenv(_p){ return 0; }'
  } > "$BUNDLE"
  cat "$JSFFI/runtime.js" >> "$BUNDLE"; echo >> "$BUNDLE"
  cat "$AF" "$FF" "$KF" >> "$BUNDLE"
  rm -f "$AF" "$FF" "$KF"
  echo "     bytes: $(wc -c < "$BUNDLE")"
  return 0
}

FAIL=0
for e in webmain webmain_vm webmain_run webmain_dbg; do
  build_entry "$e" "${ENTRIES[$e]}" || FAIL=1
done
echo "DONE aowli-obf (fail=$FAIL)"
