#!/usr/bin/env bash
# build-standalone.sh — assemble the offline single-file playground.
#
#   ./build-standalone.sh            -> writes ./playground-standalone.html
#   ./build-standalone.sh out.html   -> writes ./out.html
#
# Produces ONE self-contained HTML that runs from a file:// URL with no server
# and no network: every JS file, the five compiled bundles + worker.js, the
# nimsem stdlib blob, the aoughwl logo, and the favicon are inlined. (Monaco
# still loads from its CDN when online; offline it falls back to the built-in
# textarea editor — so the file always works.) The actual HTML assembly is
# shared with the in-page "Offline copy" button via assemble.js.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$DIR/playground-standalone.html}"

command -v node >/dev/null || { echo "FATAL: node is required" >&2; exit 1; }

OUT="$OUT" DIR="$DIR" node - <<'NODE'
const fs = require("fs"), path = require("path");
const dir = process.env.DIR, out = process.env.OUT;
const { assembleStandalone } = require(path.join(dir, "assemble.js"));

const APP = ["examples.js","pipeline.js","engine.js","parser.js","sem.js","suggest.js",
             "editor.js","lsp.js","curlyconvert.js","exporters.js","assemble.js","offline.js"];
const BUNDLES = ["worker.js","nifparser.js","nimsem.js","nifi.js","nifi_vm.js","nifi_run.js","nifjs.js","aowlts.js","aowlpy.js","aowlsem.js","aowlsuggest.js"];

const rd = f => fs.readFileSync(path.join(dir, f), "utf8");
// Resolve an asset that may live in ../assets (pages repo) or ./assets (flat
// standalone mirror). Returns base64, or null if genuinely absent.
function b64(cands){
  for(const c of cands){ const p = path.join(dir, c);
    if(fs.existsSync(p)) return fs.readFileSync(p).toString("base64"); }
  return null;
}
function must(cands, what){ const v = b64(cands); if(v==null) throw new Error("missing "+what+" (looked in: "+cands.join(", ")+")"); return v; }

const scripts = {}; for(const n of APP)     scripts[n] = rd(n);
const bundles = {}; for(const n of BUNDLES) bundles[n] = rd(n);

const assets = {
  scripts, bundles,
  stdlibB64:  must(["assets/nimsem-stdlib.bin"], "nimsem stdlib blob"),
  logoB64:    must(["../assets/aoughwl-logo-white.png","assets/aoughwl-logo-white.png"], "aoughwl logo"),
  faviconB64: b64(["../favicon.ico","favicon.ico"])   // optional
};

const html = assembleStandalone(rd("index.html"), assets);
fs.writeFileSync(out, html);
console.log("wrote " + out + "  (" + (Buffer.byteLength(html)/1048576).toFixed(1) + " MB)");
NODE
