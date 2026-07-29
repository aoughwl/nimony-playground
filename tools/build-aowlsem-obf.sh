#!/usr/bin/env bash
# Build aowlsem.js with app modules obfuscated. Wraps aowlsem-js/webtest_build.sh's
# stages, inserting an IR-obfuscation + rebuild pass between frontend and nim_js.
set -u
NIM=/home/savant/nimony
WEB=/home/savant/nimony-web
AS=/home/savant/aowlsem
NP=/home/savant/aowlsem-js
JSFFI="$WEB/tests/jsbackend"
HERE="$NP/webtest"
NC="$HERE/nc"
OBFTOOL="$HOME/nimony-playground/tools/obf-web-build.sh"

FE() {
  "$NIM/bin/nimony" c --bits:32 --define:nimNativeAlloc \
    -p:"$NIM/src/lib" -p:"$NIM/src/nimony" -p:"$NIM/src/models" \
    -p:"$NIM/src/gear2" -p:"$AS/src" -p:"$NP/src" -p:"$JSFFI" \
    --nimcache:"$NC" "$NP/src/webmain.nim" 2>&1 | grep -viE '^$' | tail -8
}

echo "== 1a. frontend build #1 (produce .s.nif + .c.nif) =="
rm -rf "$NC"; mkdir -p "$NC"; FE
mapfile -t cnifs < <(find "$NC" -name '*.c.nif')
echo "   .c.nif produced: ${#cnifs[@]}"
[ "${#cnifs[@]}" -eq 0 ] && { echo "FATAL: frontend failed"; exit 1; }

echo "== 1b. obfuscate app .s.nif in place =="
bash "$OBFTOOL" "$NC"

echo "== 1c. rebuild (resume hexer -> .c.nif from obfuscated .s.nif) =="
FE
mapfile -t cnifs < <(find "$NC" -name '*.c.nif')
echo "   .c.nif after rebuild: ${#cnifs[@]}"

echo "== 2. nim_js each .c.nif -> .js =="
total_todo=0
for c in "${cnifs[@]}"; do
  out="$("$WEB/bin/nim_js" "$c" "${c%.c.nif}.js" 2>&1)"
  echo "$out" | grep -E 'unsupported node' && \
    total_todo=$((total_todo + $(echo "$out" | grep -oE '[0-9]+ unsupported' | grep -oE '[0-9]+')))
done
echo "   TOTAL unsupported nodes: $total_todo"

echo "== 3. bundle =="
BUNDLE="$HERE/aowlsem.js"
AF="$HERE/.alloc.tmp"; FF="$HERE/.fill.tmp"; KF="$HERE/.code.tmp"
jsfiles=(); for c in "${cnifs[@]}"; do jsfiles+=("${c%.c.nif}.js"); done
awk -v AF="$AF" -v FF="$FF" -v KF="$KF" '
  /^\/\/__NIMJS_CONST_ALLOC_BEGIN__$/ { s=1; next }
  /^\/\/__NIMJS_CONST_ALLOC_END__$/   { s=0; next }
  /^\/\/__NIMJS_CONST_FILL_BEGIN__$/  { s=2; next }
  /^\/\/__NIMJS_CONST_FILL_END__$/    { s=0; next }
  /^"use strict";$/                   { next }
  { if (s==1) print > AF; else if (s==2) print > FF; else print > KF }
' "${jsfiles[@]}"
{
  echo '"use strict";'
  echo 'var fopen = (typeof fopen !== "undefined") ? fopen : function(){ return 0; };'
} > "$BUNDLE"
cat "$JSFFI/runtime.js" >> "$BUNDLE"; echo >> "$BUNDLE"
cat "$AF" "$FF" "$KF" >> "$BUNDLE"
rm -f "$AF" "$FF" "$KF"
echo "   bundle bytes: $(wc -c < "$BUNDLE")"
echo "DONE aowlsem-obf"
