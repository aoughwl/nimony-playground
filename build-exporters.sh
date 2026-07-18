#!/usr/bin/env bash
# build-exporters.sh — compile the aowlts (TypeScript) and aowlpy (Python)
# exporters to browser JavaScript through the nimony-web JS backend, producing
# aowlts.js and aowlpy.js in the playground root.
#
# Same mechanism as the vendored parser/interpreter bundles: nimony's frontend +
# hexer lower each web entry to per-module `.c.nif` (the Leng IR), `nim_js` emits
# one `.js` per module, and the module JS is concatenated behind nimony-web's
# runtime.js into a single self-contained bundle. The 32-bit C link step nimony
# runs at the end fails harmlessly — we only want the `.c.nif`.
#
# The web entries (exporters/aowlts_web.nim, exporters/aowlpy_web.nim) live HERE
# in the playground; they `import` the emitter modules from sibling checkouts of
# aoughwl/aowlts + aoughwl/aowlpy (their `src/`) and the shared aowlhl layer,
# exactly as the native CLIs do. No emitter-repo source is edited or vendored.
set -u
NIM=/home/savant/nimony
WEB=/home/savant/nimony-web
JSFFI="$WEB/tests/jsbackend"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AOWLHL=/home/savant/aowlhl/src

# nimony frontend include paths shared by both entries (its NIF/IR libs + aowlhl).
COMMON_P=(-p:"$NIM/src/lib" -p:"$NIM/src/nimony" -p:"$NIM/src/models"
          -p:"$NIM/src/gear2" -p:"$AOWLHL" -p:"$JSFFI")

# aowlts's emitts.nim has one `--bits:32`-only type error: `let width = if
# d.kind == IntLit: pool.integers[d.intId] else: 0` unifies an int64 (the pool
# accessor) with an int32 literal, which nimony rejects when `int` is 32-bit. We
# must NOT edit the aowlts repo, so the build copies its `src/` to a temp dir and
# annotates that one literal `0` -> `0'i64` there. The upstream repo is untouched;
# this shim lives only in the playground build. (aowlpy needs no such patch.)
patch_aowlts_src(){
  local dst="$1"
  rm -rf "$dst"; cp -r /home/savant/aowlts/src "$dst"
  sed -i "s/let width = if d.kind == IntLit: pool.integers\[d.intId\] else: 0\$/let width = if d.kind == IntLit: pool.integers[d.intId] else: 0'i64/" "$dst/emitts.nim"
  grep -q "else: 0'i64" "$dst/emitts.nim" || { echo "FATAL: aowlts bits:32 patch did not apply (emitts.nim changed upstream?)"; return 1; }
}

# aowljs's emitjs.nim has the SAME one `--bits:32`-only type error as aowlts:
# `let width = if d.kind == IntLit: pool.integers[d.intId] else: 0` unifies an
# int64 (pool accessor) with an int32 literal, rejected when `int` is 32-bit. We
# must NOT edit the aowljs repo, so we copy its `src/` to a temp dir and annotate
# that one literal `0` -> `0'i64`. Upstream untouched; shim lives only here.
patch_aowljs_src(){
  local dst="$1"
  rm -rf "$dst"; cp -r /home/savant/aifjs/src "$dst"
  sed -i "s/let width = if d.kind == IntLit: pool.integers\[d.intId\] else: 0\$/let width = if d.kind == IntLit: pool.integers[d.intId] else: 0'i64/" "$dst/emitjs.nim"
  grep -q "else: 0'i64" "$dst/emitjs.nim" || { echo "FATAL: aowljs bits:32 patch did not apply (emitjs.nim changed upstream?)"; return 1; }
}

# build_one <entry.nim> <emitter-src-dir> <out-bundle.js>
build_one(){
  local entry="$1" emitsrc="$2" bundle="$3"
  local nc; nc="$(mktemp -d)"
  echo "== $(basename "$bundle"): frontend + hexer -> .c.nif (--bits:32) =="
  "$NIM/bin/nimony" c --bits:32 --define:nimNativeAlloc \
    "${COMMON_P[@]}" -p:"$emitsrc" \
    --nimcache:"$nc" "$entry" 2>&1 | grep -viE '^$' | tail -15
  echo "   (32-bit C link failure above is expected/harmless)"

  mapfile -t cnifs < <(find "$nc" -name '*.c.nif')
  echo "   .c.nif modules: ${#cnifs[@]}"
  if [ "${#cnifs[@]}" -eq 0 ]; then echo "FATAL: no .c.nif — frontend failed"; rm -rf "$nc"; return 1; fi

  echo "== nim_js: each .c.nif -> .js =="
  local todo=0
  for c in "${cnifs[@]}"; do
    out="$("$WEB/bin/nim_js" "$c" "${c%.c.nif}.js" 2>&1)"
    echo "$out" | grep -E 'unsupported node' && \
      todo=$((todo + $(echo "$out" | grep -oE '[0-9]+ unsupported' | grep -oE '[0-9]+')))
  done
  echo "   TOTAL unsupported nodes: $todo"

  echo "== bundle -> $(basename "$bundle") =="
  local AF FF KF; AF="$nc/.alloc"; FF="$nc/.fill"; KF="$nc/.code"
  local jsfiles=(); for c in "${cnifs[@]}"; do jsfiles+=("${c%.c.nif}.js"); done
  awk -v AF="$AF" -v FF="$FF" -v KF="$KF" '
    /^\/\/__NIMJS_CONST_ALLOC_BEGIN__$/ { s=1; next }
    /^\/\/__NIMJS_CONST_ALLOC_END__$/   { s=0; next }
    /^\/\/__NIMJS_CONST_FILL_BEGIN__$/  { s=2; next }
    /^\/\/__NIMJS_CONST_FILL_END__$/    { s=0; next }
    /^"use strict";$/                   { next }
    { if (s==1) print > AF; else if (s==2) print > FF; else print > KF }
  ' "${jsfiles[@]}"
  cat "$JSFFI/runtime.js" > "$bundle"; echo >> "$bundle"
  cat "$AF" "$FF" "$KF" >> "$bundle"
  rm -rf "$nc"
  node --check "$bundle" && echo "   syntax OK — $(wc -c < "$bundle") bytes"
}

ATS_SRC="$(mktemp -d)/src"; patch_aowlts_src "$ATS_SRC" || exit 1
build_one "$HERE/exporters/aowlts_web.nim" "$ATS_SRC" "$HERE/aowlts.js"
build_one "$HERE/exporters/aowlpy_web.nim" /home/savant/aowlpy/src "$HERE/aowlpy.js"
# aowljs (idiomatic JavaScript) — src dir keeps the pre-rename name aifjs/src;
# emitModuleBody is byte-identical to `bin/aowljs`. Needs the same bits:32 shim.
AJS_SRC="$(mktemp -d)/src"; patch_aowljs_src "$AJS_SRC" || exit 1
build_one "$HERE/exporters/aowljs_web.nim" "$AJS_SRC" "$HERE/aowljs.js"

# refresh the offline single-file build so it embeds the new bundles.
if [ -x "$HERE/build-standalone.sh" ]; then
  "$HERE/build-standalone.sh" >/dev/null && echo "standalone rebuilt"
fi
echo "done."
