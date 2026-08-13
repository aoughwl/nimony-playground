// worker.js — the off-main-thread half of the playground pipeline.
//
// The two HEAVY stages live here: nimsem (the 8.9 MB semantic checker) and aowli
// (the interpreter). Both are driven by an already-parsed `.p.nif` handed in from
// the main thread (nifparser stays on the main thread — it's ~4 ms and feeds the
// synchronous Monaco/LSP index). Moving these two here is what keeps the editor
// from freezing during a live semcheck, and lets a runaway program be KILLED by
// terminating the worker (the main thread respawns a fresh one).
//
// Protocol (main → worker):
//   { id, type:"sem", pnif }            semcheck only (live diagnostics)
//   { id, type:"run", pnif, stdin }     semcheck (cached) + execute
// Protocol (worker → main):
//   { type:"ready" } | { type:"loaderr", message }
//   { id, ok:true,  ... }  a result           { id, ok:false, message }
//
// Every stage is wrapped so a bundle-level throw (e.g. a missing FFI shim, or a
// process.exit) comes back as a clean message instead of killing the worker.

// --- Node-globals shim (mirrors index.html's) --------------------------------
// The aowli/nimsem bundles were emitted for a Node-ish host and reach for
// `process`/`Buffer`/`global` on their libc-stdio and exit paths. The happy
// path (echo) uses the __aowli_ capture natives; stdlib code that writes via
// fwrite hits process.stdout instead. In a bare worker those are undefined.
(function(){
  var g = self;
  if(!g.global) g.global = g;
  function toStr(s){
    if(typeof s === "string") return s;
    if(s && typeof s.length === "number"){ var r=""; for(var i=0;i<s.length;i++) r+=String.fromCharCode(s[i]&0xff); return r; }
    return s==null ? "" : String(s);
  }
  if(typeof g.Buffer === "undefined")
    g.Buffer = { from:function(x){ return (x instanceof Uint8Array) ? x : Uint8Array.from(x||[]); } };
  if(typeof g.process === "undefined")
    g.process = {
      platform:"browser", argv:[], env:{}, cwd:function(){ return "/"; },
      stdout:{ write:function(s){ g.__aowli_out=(g.__aowli_out||"")+toStr(s); return true; } },
      stderr:{ write:function(s){ g.__aowli_err=(g.__aowli_err||"")+toStr(s); return true; } },
      exit:function(code){ var e=new Error("process.exit("+(code||0)+")"); e.__isExit=true; throw e; }
    };
  // See index.html's copy: `fpclassify` + the FP_* codes are missing from the
  // bundles' embedded libm shim, and std/math's `classify` (hence every float
  // literal) needs them. Glibc codes; matches the nimony-js runtime fix.
  if(typeof g.fpclassify === "undefined"){
    g.FP_NAN = 0; g.FP_INFINITE = 1; g.FP_ZERO = 2; g.FP_SUBNORMAL = 3; g.FP_NORMAL = 4;
    g.fpclassify = function(x){
      if(Number.isNaN(x)) return 0;
      if(x === Infinity || x === -Infinity) return 1;
      if(x === 0) return 2;                                   // covers -0
      return Math.abs(x) < 2.2250738585072014e-308 ? 3 : 4;
    };
    g.fpclassifyf = g.fpclassify;
  }
})();

// --- load + compile-once the bundles -----------------------------------------
// aowliMain  = tree-walker (interp.nim): lazy, runs any self-contained .s.nif.
// aowliVmMain= bytecode VM (compiler.nim + vm.nim): 1.7-2.9x faster on compute,
//   but its compiler resolves some symbols eagerly (firstParamContainer ->
//   tryLoadSym), which forces an on-demand module load the self-contained
//   browser host can't satisfy (seq/Table container ops -> vfs open fails).
//   So the VM is the FAST PATH and the tree-walker is the always-correct
//   fallback (see runSnif).
let semMain = null, aowliMain = null, aowliVmMain = null, stdlibBlob = null, nsCheckFn = null, semJsText = null;
// aowlsem (the AOWL semantic checker) bundle text. Unlike nimsem it
// has NO warm-closure model, so we keep only the source and evaluate a fresh
// `new Function` per check (exactly like the main-thread parser). Best-effort:
// null if the bundle isn't in this build, in which case the aowl path degrades to
// a clean "unavailable" diagnostic rather than throwing.
let asJsText = null, asJsPromise = null;
// aowlsem is the DEFAULT checker; boot prefetches it, and this is the guard that
// makes a check wait for the fetch rather than race it.
function ensureAowlsem(){
  if(asJsText) return Promise.resolve(asJsText);
  if(!asJsPromise) asJsPromise = loadText("aowlsem.js").catch(()=>null).then(t=>(asJsText=t, t));
  return asJsPromise;
}

// --- aowlsem's pre-semchecked stdlib -----------------------------------------
// aowlsem has no stdlib of its own and no warm closure: it is handed
// already-semchecked modules per check, exactly as the native harnesses hand
// them to the CLI with `--sys:`/`--imp:`. `assets/aowlsem-mods.bin` carries
// system + the std surface the playground offers, built by
// `aowlsem-js/mods_build.sh`, in LENGTH-framed records
//   <suffix>\t<modname>\t<dep-suffix,…>\t<bytelen>\n<bytes>
// ⚠️ A .s.nif is NOT text: system.s.nif contains a raw 0xFF, so `fetch().text()`
// would replace it with U+FFFD and hand aowlsem a corrupted module. We read the
// asset as BYTES and hold it LATIN1 (one char per byte), which keeps `bytelen`
// true for JS slicing; aowlsem's webmain decodes latin1 back to bytes on arrival,
// because a JS string crosses that boundary UTF-8-encoded (`_te.encode`,
// nimony-web runtime.js).
let asMods = null, asModsByName = null, asModsPromise = null;
function loadLatin1(name){
  // Offline single-file build: the asset rides in base64 (a file:// worker can't
  // fetch siblings), and atob already yields one char per byte — which IS latin1.
  if(__assets && __assets.modsB64 != null)
    return Promise.resolve(atob(__assets.modsB64));
  return fetch(name)
    .then(r=>{ if(!r.ok) throw new Error(name+" HTTP "+r.status); return r.arrayBuffer(); })
    .then(bytesToLatin1);
}
function parseModFrames(txt){
  const bySuffix = new Map(), byName = new Map();
  let i = 0;
  while(i < txt.length){
    const nl = txt.indexOf("\n", i);
    if(nl < 0) break;
    const h = txt.slice(i, nl).split("\t");
    if(h.length !== 4) break;
    const n = parseInt(h[3], 10);
    if(!(n > 0) || nl + 1 + n > txt.length) break;
    bySuffix.set(h[0], { name:h[1], deps: h[2] ? h[2].split(",") : [], body: txt.substr(nl + 1, n) });
    byName.set(h[1], h[0]);
    i = nl + 1 + n;
  }
  return { bySuffix, byName };
}
function ensureAowlsemMods(){
  if(asMods) return Promise.resolve();
  if(!asModsPromise)
    asModsPromise = loadLatin1("assets/aowlsem-mods.bin")
      .then(t=>{ const p = parseModFrames(t); asMods = p.bySuffix; asModsByName = p.byName; })
      // A missing asset degrades to system-less checking (honest "undeclared"
      // diagnostics), never to a throw.
      .catch(()=>{ asMods = new Map(); asModsByName = new Map(); });
  return asModsPromise;
}
// Which shipped modules does THIS program need? Loading all 20 would cost ~2.4 MB
// of NIF parsing on every keystroke-check, so scan the `.p.nif`'s import nodes
// (`(import (infix / std syncio))`) for identifiers naming a shipped module, then
// close over each module's own recorded dependencies — a re-exported symbol is
// only reachable if its module is loaded too.
function selectAowlModules(pnif){
  const sysSuffix = asModsByName.get("system") || "";
  const want = new Set();
  const re = /\((?:import|importexcept|from)\b/g;
  let m;
  while((m = re.exec(pnif))){
    let depth = 0, end = pnif.length;
    for(let i = m.index; i < pnif.length; i++){
      const c = pnif[i];
      if(c === "(") depth++;
      else if(c === ")" && --depth === 0){ end = i; break; }
    }
    for(const t of (pnif.slice(m.index, end).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])){
      const s = asModsByName.get(t);
      if(s) want.add(s);
    }
  }
  const out = new Set();
  const visit = s => {
    if(!s || out.has(s) || !asMods.has(s)) return;
    out.add(s);
    for(const d of asMods.get(s).deps) visit(d);
  };
  want.forEach(visit);
  out.delete(sysSuffix);            // system travels on __as_sys, not __as_imps
  return { sysSuffix, imps: Array.from(out) };
}
// The run-rung bundle (webmain_run.nim): the tree-walker with the run emitter ON,
// which also parks the serialized execution on globalThis.__aowli_runnif. It's an
// EXTRA ~1.7 MB, only needed when the user opens the "Run" NIF tab, so we fetch and
// compile it lazily on first use rather than at boot.
let aowliRunMain = null, aowliRunPromise = null;
function ensureRunBundle(){
  if(aowliRunMain) return Promise.resolve();
  if(!aowliRunPromise)
    aowliRunPromise = loadText("aowli_run.js")
      .then(txt=>{ aowliRunMain = new Function(txt + "\nmain(0, []);"); });
  return aowliRunPromise;
}

// The debugger bundle (webmain_dbg.nim): the tree-walker in dmStep mode, which
// records EVERY statement's frame locals + call depth and parks the ordered
// capture log on globalThis.__aowli_dbg as JSON. ~2 MB, loaded lazily on the
// first Debug run only.
let aowliDbgMain = null, aowliDbgPromise = null;
function ensureDbgBundle(){
  if(aowliDbgMain) return Promise.resolve();
  if(!aowliDbgPromise)
    aowliDbgPromise = loadText("aowli_dbg.js")
      .then(txt=>{ aowliDbgMain = new Function(txt + "\nmain(0, []);"); });
  return aowliDbgPromise;
}

function bytesToLatin1(buf){
  const u = new Uint8Array(buf); let s = "";
  for(let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return s;
}

// (Re)build the WARM nimsem instance from the already-fetched bundle text. Boot
// the 8.9 MB bundle — its module init installs memvfs and loads the whole stdlib
// closure — and capture the exported `nsCheck`, which closes over that warm
// scope. Every compile then just calls nsCheck() to swap in a new main module and
// re-run the semcheck, REUSING the already-loaded `system`/`syncio` module graph
// (nimony keeps them in `prog.mods` across calls): the first check pays ~750 ms to
// load `system`, every check after is ~15-25 ms. If the bundle predates nsCheck,
// fall back to a fresh scope per compile.
//
// We also call this to RECOVER from a poisoned instance: a compile that throws
// mid-check can leave that shared `prog.mods` graph half-mutated, which would make
// every subsequent nsCheck() throw too — the "it says unsupported and then never
// finds errors again until I refresh" lockout. Rebuilding hands back a clean warm
// scope (~750 ms once, off the UI thread) instead of a permanent dead worker.
// nsCheckMultiFn: the multi-module entry (nsCheckMulti export), captured from the
// warm boot alongside nsCheck. Null on an OLD nimsem bundle that predates it — in
// which case the worker degrades to single-module checking (the active file only).
let nsCheckMultiFn = null;
function buildWarmSem(){
  nsCheckFn = null; nsCheckMultiFn = null;
  globalThis.__ns_assets = stdlibBlob;
  try{
    (new Function(semJsText + "\n; globalThis.__nsCheckFn = nsCheck;" +
      "\n; try{ globalThis.__nsCheckMultiFn = nsCheckMulti; }catch(_e){ globalThis.__nsCheckMultiFn = null; }" +
      "\n main(0, []);"))();
    if(typeof globalThis.__nsCheckFn === "function") nsCheckFn = globalThis.__nsCheckFn;
    if(typeof globalThis.__nsCheckMultiFn === "function") nsCheckMultiFn = globalThis.__nsCheckMultiFn;
  }catch(e){ /* boot threw — fall through to the fresh-scope path */ }
  if(!nsCheckFn && !semMain) semMain = new Function(semJsText + "\nmain(0, []);");
}

// Offline single-file build: the main thread hands the worker its bundle texts
// and the stdlib bytes via the `init` message, because a file:// worker can't
// fetch() sibling assets (origin 'null'). `__assets` holds them when present;
// otherwise we fetch over HTTP as usual (the hosted site). Same worker.js works
// in both modes.
let __assets = null, __booted = false;
function loadText(name){
  if(__assets && __assets.bundles && __assets.bundles[name] != null)
    return Promise.resolve(__assets.bundles[name]);
  return fetch(name).then(r=>{ if(!r.ok) throw new Error(name+" HTTP "+r.status); return r.text(); });
}
function loadStdlibBytes(){
  if(__assets && __assets.stdlibB64 != null){
    const bin = atob(__assets.stdlibB64), u = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i);
    return Promise.resolve(u.buffer);
  }
  return fetch("assets/nimsem-stdlib.bin")
    .then(r=>{ if(!r.ok) throw new Error("stdlib asset HTTP "+r.status); return r.arrayBuffer(); });
}

async function boot(){
  // Fetch everything in PARALLEL, including the tiny nifjs source, so nothing is
  // serialized behind the ~1 s warm-sem step below (that step, not the fetches,
  // is what makes "engine ready" take a moment — it type-checks the whole stdlib
  // closure once so every later compile is ~15 ms).
  const [semJs, aowliJs, aowliVmJs, asset, njsText] = await Promise.all([
    loadText("nimsem.js"), loadText("aowli.js"), loadText("aowli_vm.js"), loadStdlibBytes(),
    loadText("nifjs.js").catch(()=>null)         // best-effort; fast path falls back if absent
  ]);
  // aowlsem is the DEFAULT checker, so its bundle and its pre-semchecked stdlib
  // are prefetched here — fire-and-forget, deliberately NOT awaited: readiness is
  // still nimsem's warm closure, and gating boot on another ~14 MB would make the
  // editor wait for bytes the first check will wait for anyway.
  ensureAowlsem(); ensureAowlsemMods();
  stdlibBlob = bytesToLatin1(asset);
  semJsText = semJs;
  // aowli: compile once; each run gets a fresh scope (fresh linear memory) — cheap
  // (~5 ms of init), and a clean interpreter state per run is what we want.
  aowliMain   = new Function(aowliJs   + "\nmain(0, []);");
  aowliVmMain = new Function(aowliVmJs + "\nmain(0, []);");
  // nifjs — the .s.nif -> native-JS transpiler (the Native JS engine). Small
  // hand-written JS; load it into this worker scope so it runs here (terminable
  // via Stop). Cheap to compile, so do it before the heavy warm-sem step.
  try{
    if(njsText){
      (new Function(njsText + "\n; globalThis.__AowliJs = (typeof AowliJs!=='undefined'?AowliJs:null);"))();
      nifjsApi = globalThis.__AowliJs || null;
    }
  }catch(_){ nifjsApi = null; }
  buildWarmSem();
}
let nifjsApi = null;

// --- nimsem: .p.nif -> .s.nif + diagnostics ----------------------------------
function parseDiags(raw){
  const out = [], seen = new Set();
  for(const ln of String(raw||"").split("\n")){
    const m = ln.match(/\((\d+),\s*(\d+)\)\s+(Error|Warning|Hint|Trace):?\s*(.*)$/);
    if(!m) continue;
    const kind = m[3].toLowerCase();
    if(kind === "trace" || kind === "hint") continue;
    if(/\(err\s/.test(m[4])) continue;               // drop cascade noise
    const key = m[1]+":"+m[2]+":"+m[4];
    if(seen.has(key)) continue; seen.add(key);
    out.push({ line:+m[1], col:+m[2], message:m[4].trim(),
               severity: kind==="warning" ? "warning" : "error" });
  }
  return out;
}

// input-level incremental gate: the compile input is the .p.nif, so a byte-equal
// pnif (whitespace/comment edits, or Run right after the live checker) returns
// the cached result. Small LRU keeps the last few distinct inputs warm.
const CACHE_MAX = 8;
const cache = new Map();
function cacheGet(k){ if(!cache.has(k)) return null; const v=cache.get(k); cache.delete(k); cache.set(k,v); return v; }
function cachePut(k,v){ cache.set(k,v); while(cache.size>CACHE_MAX) cache.delete(cache.keys().next().value); }

function semFresh(pnif, allowRetry){
  semUsed = true;
  globalThis.__ns_main   = String(pnif);
  globalThis.__ns_assets = stdlibBlob;
  globalThis.__ns_out    = "";
  globalThis.__ns_diag   = "";
  globalThis.__aowli_out  = "";   // nimsem's own stdout (assert/crash text) lands here via the process shim
  try{
    if(nsCheckFn) nsCheckFn();   // warm instance: reuse the loaded stdlib closure
    else semMain();              // fallback: fresh scope per compile
  }catch(e){
    const diags = parseDiags(globalThis.__ns_diag);
    // A throw from the WARM instance can leave its shared `prog.mods` graph
    // corrupted, poisoning every later check. Rebuild a clean instance so the
    // NEXT edit isn't locked out — and, if this throw produced no diagnostics,
    // retry the check ONCE on the clean instance so this edit still gets real
    // errors instead of the generic fallback.
    if(nsCheckFn){
      buildWarmSem(); semUsed = false;
      if(!diags.length && allowRetry !== false) return semFresh(pnif, false);
    }
    if(diags.length) return { snif:"", diags };
    // No located diagnostic. Either nimsem crashed internally (an assertion —
    // usually a malformed edit the parser let through, e.g. a `proc` header
    // missing its trailing `=`) or the program hits a genuinely unsupported
    // feature. Tell them apart from whatever nimsem printed, and use line:0 so we
    // do NOT pin a red marker to line 1 (the import) — we don't know the real
    // line (refreshMarkers lists line:0 in Problems without an editor squiggle).
    const crash = String(globalThis.__aowli_out || "").trim();
    const internal = /assert|fatal|unreachable|internal|illformed|segfault|sigsegv/i.test(crash);
    const message = internal
      ? "the checker couldn't process this program — this is usually a mistake in your most recent edit (for example a proc/if/for/type header missing its ':' or '='). Undo that edit and your errors come back."
      : "this program uses a module or feature not yet supported in the browser sandbox";
    return { snif:"", diags:[{ line:0, col:0, severity:"error", message }] };
  }
  return { snif: globalThis.__ns_out || "", diags: parseDiags(globalThis.__ns_diag) };
}

function semCompile(pnif){
  pnif = String(pnif);
  const hit = cacheGet(pnif);
  if(hit) return { snif:hit.snif, diags:hit.diags, cached:true };
  const res = semFresh(pnif);
  cachePut(pnif, { snif:res.snif, diags:res.diags });
  return { snif:res.snif, diags:res.diags, cached:false };
}

// --- aowlsem: the DEFAULT semantic checker ------------------------------------
// Contract (a JS mirror of aowlsem's webmain, parallel to the parser's): set
// globalThis.__as_pnif = the .p.nif, __as_sys/__as_syssuf = the pre-semchecked
// `system` module and its suffix, __as_imps = the framed imported modules, then
// invoke a FRESH `new Function` (aowlsem has no warm-closure model — every check
// re-runs module init) and read __as_snif (the typed .s.nif, "" on failure) and
// __as_diag (a JSON array). We normalize its diagnostics to the SAME shape
// nimsem's parseDiags returns ({line, col, severity, message}) so the UI treats
// both alike.
function normalizeAowlDiags(raw){
  let arr = [];
  try{ arr = JSON.parse(raw || "[]"); }catch(_){ return []; }
  if(!Array.isArray(arr)) return [];
  return arr.map(d => ({
    line: d.line | 0,
    // aowlsem reports col 0-based (like the parser); nimsem/Monaco want 1-based.
    col: (d.col | 0) + 1,
    severity: d.severity === "warning" ? "warning" : "error",
    message: String(d.message || "").trim()
  }));
}
// --- aowlsem's modules, framed for aowli's VFS -------------------------------
// aowlsem's .s.nif is NOT self-contained: it names its imports by suffix and
// leaves their bodies out (nimsem's warm-closure output inlines them, which is
// why the nimsem path never needed this). At RUN time aowli then resolves a
// symbol like `add.0.seqs…`, calls programs.load "<suffix>", and reads
// `/w/<suffix>.s.idx.nif` — a VFS miss returns "" and readIndex asserts
// (webvfs.nim: "readIndex demands the (index) tag and asserts on anything else,
// including on the empty string a VFS miss returns"). That surfaced as
// `[Assertion Failure] expected 'index' tag` on stdout for EVERY program that
// needed a routine body from another module: seq.add, tables, sets, strutils,
// sequtils, options, closures, object variants, method dispatch, try/except…
// Programs that only echo never load anything, which is why the sandbox looked
// healthy.
//
// We already hold exactly those module bodies (`asMods`), so frame them the way
// webvfs.loadWebModules wants: "<name>\t<len>\n<bytes>" repeated, where <name>
// is the bare filename programs.suffixToNif will ask for and <len> counts the
// body AS ESCAPED. Bytes >= 0x80 must travel as `\xHH` (a .s.nif is not text —
// system.s.nif carries a raw 0xFF — and the JS→nim boundary would UTF-8 re-encode
// it). The `.s.idx.nif` sidecar is read unconditionally by `load`, so each module
// gets the same empty-index shape webvfs synthesizes for the main module: the
// symbols come from the index EMBEDDED in the .s.nif, which is keyed by the same
// expanded suffix because we name the file after that suffix.
const EMPTY_IDX_NIF = "(.nif27)\n(index\n)\n";
function escapeTransport(body){
  // eslint-disable-next-line no-control-regex
  return body.replace(/[-ÿ]/g,
    c => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}
// EVERY shipped module, not just the ones the program imports. The import set is
// the right scope for the CHECKER (it decides what is visible), but the wrong one
// for the runtime: `import std/tables` pulls in bodies from hashes/strs/… that no
// import statement names, and one missing body is an assert, not a degraded run.
// Built once and reused — it is the same bytes for every program, so it is NOT
// kept in the per-program LRU.
let allModsFramed = null;
function frameAowlModsForAowli(){
  if(allModsFramed !== null) return allModsFramed;
  if(!asMods){ return ""; }              // not cached: asMods may still be loading
  let out = "";
  const add = (name, body) => { out += name + "\t" + body.length + "\n" + body; };
  for(const [suf, mod] of asMods){
    add(suf + ".s.nif", escapeTransport(mod.body));
    add(suf + ".s.idx.nif", EMPTY_IDX_NIF);
  }
  allModsFramed = out;
  return out;
}
// Its own LRU key namespace (prefixed) so an aowl result never collides with the
// nimsem cache keyed on the raw .p.nif.
function semCompileAowl(pnif){
  pnif = String(pnif);
  if(!asJsText)
    return { snif:"", cached:false,
             diags:[{ line:0, col:0, severity:"error",
                      message:"aowlsem is not available in this build" }] };
  const sel = (asMods && asModsByName) ? selectAowlModules(pnif) : { sysSuffix:"", imps:[] };
  const key = "aowl\0" + sel.imps.join(",") + "\0" + pnif;
  const hit = cacheGet(key);
  if(hit) return { snif:hit.snif, diags:hit.diags, mods: hit.snif ? frameAowlModsForAowli() : "", cached:true };
  globalThis.__as_pnif = pnif;
  // system + the imported modules, pre-semchecked. The SUFFIX matters as much as
  // the bytes: a .s.nif elides its own module suffix on every symbol it defines,
  // so the reader re-appends the name we pass here.
  globalThis.__as_sys = sel.sysSuffix ? asMods.get(sel.sysSuffix).body : "";
  globalThis.__as_syssuf = sel.sysSuffix;
  globalThis.__as_imps = sel.imps.map(s => {
    const mod = asMods.get(s);
    return s + "\t" + mod.name + "\t" + mod.body.length + "\n" + mod.body;   // latin1: 1 char == 1 byte
  }).join("");
  globalThis.__as_snif = "";
  globalThis.__as_diag = "[]";
  let snif = "", diags = [];
  try{
    (new Function(asJsText + "\nmain(0,[]);"))();   // fresh module-init per check
    snif  = globalThis.__as_snif || "";
    diags = normalizeAowlDiags(globalThis.__as_diag);
  }catch(e){
    // A throw still commonly leaves located diagnostics parked; surface those, and
    // otherwise a single honest "couldn't check" note (never crash the worker).
    diags = normalizeAowlDiags(globalThis.__as_diag);
    if(!diags.length) diags = [{ line:0, col:0, severity:"error",
      message:"aowlsem could not check this program: " + (e && e.message || e) }];
    snif = "";
  }
  // The same module set aowlsem checked against, framed for aowli's VFS so a run
  // can resolve a symbol whose body lives in one of them (see
  // frameAowlModsForAowli). Only worth building when there IS a program to run.
  const mods = snif ? frameAowlModsForAowli() : "";
  cachePut(key, { snif, diags });
  return { snif, diags, mods, cached:false };
}

// --- multi-module (workspace) semcheck: nimsem only ---------------------------
// `multi` = { mainpath, paths (\n-joined project roots), modules (framed
// "<path>\t<len>\n<pnif>" of ALL user modules) }. Resolves cross-file /
// cross-project imports against the preloaded user .p.nif set, with the stdlib
// still served from the pre-checked .s.nif closure. Falls back to single-module
// on an old bundle (no nsCheckMultiFn) or a poisoned instance.
function semFreshMulti(multi){
  freshenSem();                // never sem against a previous run's user modules
  globalThis.__ns_mainpath = String(multi.mainpath || "");
  globalThis.__ns_paths    = String(multi.paths || "");
  globalThis.__ns_modules  = String(multi.modules || "");
  globalThis.__ns_assets   = stdlibBlob;
  globalThis.__ns_out = ""; globalThis.__ns_diag = ""; globalThis.__aowli_out = "";
  globalThis.__aowli_err = ""; globalThis.__ns_mods = ""; globalThis.__ns_multifail = "";
  globalThis.__ns_trace = ""; globalThis.__ns_vfslog = "";
  try{
    nsCheckMultiFn();
  }catch(e){
    const diags = parseDiags(globalThis.__ns_diag);
    // nimsem's own stdout (assertion / "cannot open" text) — the ONLY clue when a
    // multi-module check dies without producing a located diagnostic. Keep it so
    // the caller can report something honest instead of the generic banner.
    const crash = (String(globalThis.__aowli_out || "") + "\n"
                 + String(globalThis.__aowli_err || "") + "\n"
                 + String(globalThis.__ns_vfslog || "") + "\n"
                 + String(e && e.message || e)).trim();
    buildWarmSem(); semUsed = false;   // recover a clean instance
    if(diags.length) return { snif:"", diags, crash };
    // No located diagnostic — the multi-module path failed internally (an
    // unsupported cross-module construct, not a real type error in the user's
    // code). Return EMPTY (no snif, no diags) so runSem falls back to the proven
    // single-module check of the active file rather than showing a spurious
    // "workspace semcheck failed" banner.
    return { snif:"", diags:[], crash };
  }
  // `mods` = the DEPENDENCY modules' .s.nif, framed for aowli's in-memory VFS
  // (see webvfs.loadWebModules). An old nimsem bundle leaves it undefined, in
  // which case cross-module runs behave exactly as before.
  semUsed = true;
  scheduleFreshenSem();
  const snif = globalThis.__ns_out || "";
  const diags = parseDiags(globalThis.__ns_diag);
  // Modules nimsem could not produce ANY output for. These are internal failures
  // (an unsupported construct or a module it cannot resolve), not type errors, so
  // they carry no location — but naming the FILE beats the old behaviour, which
  // silently degraded to a single-module check of the active file and reported
  // "this program uses a module or feature not yet supported in the browser
  // sandbox" with no hint about which file was at fault.
  const failed = String(globalThis.__ns_multifail || "").split("\n").filter(Boolean);
  if(!snif && !diags.length && failed.length)
    return { snif:"", mods:"", diags: failed.map(p => ({ line:0, col:0, severity:"error",
      message: "could not check module " + (p.split("/").pop() || p)
             + " — it uses something the browser sandbox does not support yet" })) };
  return { snif, diags, mods: globalThis.__ns_mods || "" };
}
// --- warm-instance hygiene for MULTI-module checks ---------------------------
// The warm nimsem instance exists so consecutive checks reuse the loaded stdlib
// graph. That reuse is safe for the stdlib (it never changes) but NOT for USER
// modules: `prog.mods` (and the symbol state hanging off it) keeps what a
// multi-module check loaded, so a SECOND multi check whose modules changed sems
// against the previous revision and dies with no located diagnostic — "works the
// first time, then every later edit says 'not supported in the browser sandbox'".
// Native `nimony c` never sees this: one module per process.
//
// So a multi-module check leaves the instance DIRTY, and the next check rebuilds
// before running. The rebuild (~1 s: re-boot the bundle, reload the stdlib
// closure) is also kicked off as a task right after the result is returned, so it
// normally happens while the user is still typing rather than in their next Run.
// `semUsed` = this instance has already compiled a user module. Consecutive
// SINGLE-module checks on a used instance are fine (that is the warm model, and
// it is what makes live checking ~20 ms); what is NOT safe is a MULTI-module
// check, which loads a user module as a DEPENDENCY and bakes its interface into
// state `forgetModule` alone does not reach.
let semUsed = false;
function freshenSem(){
  if(!semUsed) return;
  semUsed = false;
  buildWarmSem();
}
function scheduleFreshenSem(){
  // Pre-warm a clean instance while the user is still typing, so the NEXT
  // multi-module check usually finds one ready instead of paying the rebuild.
  setTimeout(freshenSem, 0);
}

// Last multi-module internal failure text (nimsem's stdout), surfaced on the run
// result so a workspace that silently degrades to single-module checking can say
// WHY instead of showing the generic "not supported in the browser sandbox".
let lastMultiCrash = "";
// The one line of nimsem's failure output that actually names the problem.
function firstUsefulLine(crash){
  const lines = String(crash || "").split("\n").map(l => l.trim()).filter(Boolean);
  const named = lines.find(l => /no such file|cannot open|cannot find|assertion/i.test(l));
  return (named || lines[0] || "").replace(/^memvfs: /, "").slice(0, 200);
}
function semCompileMulti(multi){
  const key = "multi\0" + (multi.mainpath||"") + "\0" + (multi.modules||"");
  const hit = cacheGet(key);
  if(hit) return { snif:hit.snif, diags:hit.diags, mods:hit.mods||"", crash:hit.crash||"", cached:true };
  const res = semFreshMulti(multi);
  cachePut(key, { snif:res.snif, diags:res.diags, mods:res.mods, crash:res.crash });
  return { snif:res.snif, diags:res.diags, mods:res.mods||"", crash:res.crash||"", cached:false };
}

// Route the semcheck stage to the selected engine: "nim" -> nimsem,
// anything else -> aowlsem (the default). A `multi` payload (workspace with >1 user
// module) uses the multi-module nimsem path when the bundle supports it. Both
// return { snif, diags, cached }.
async function runSem(pnif, semEngine, multi){
  if(semEngine !== "nim"){ await ensureAowlsem(); await ensureAowlsemMods(); return semCompileAowl(pnif); }
  if(multi && multi.modules && nsCheckMultiFn){
    const r = semCompileMulti(multi);
    // Keep WHY the workspace check failed: the single-module fallback below can
    // only ever produce a generic message, and "could not find module X" is the
    // difference between an actionable report and a dead end.
    lastMultiCrash = firstUsefulLine(r.crash);
    // Graceful degradation: the browser multi-module path can fail internally on
    // some projects (returning an empty .s.nif with no located diagnostic). Rather
    // than surface a spurious "did not type-check" for the whole project, fall back
    // to single-module checking of the ACTIVE file (msg.pnif) — the proven path —
    // so multi-file projects behave at least as well as before. Real type errors
    // (a non-empty diags list) are kept and shown.
    if(r.snif || (r.diags && r.diags.length)) return r;
    return semCompile(pnif);
  }
  return semCompile(pnif);
}

// --- aowli: run a typed .s.nif -----------------------------------------------
// Both engines read the same __aowli_* input globals and park their result on
// the same output globals; a run is a fresh scope, so state never carries over.
// All three aowli bundles (tree-walker, VM, run-rung) speak __aowli_*.
function resetAowliGlobals(snif, stdin, mods){
  globalThis.__aowli_in  = stdin || "";
  globalThis.__aowli_src = snif;
  // Dependency modules for a multi-file project, framed "<name>\t<len>\n<bytes>".
  // aowli preloads them into its in-memory VFS so `programs.load` can resolve a
  // cross-module symbol instead of reaching for posix `open` (absent in JS).
  globalThis.__aowli_mods = mods || "";
  globalThis.__aowli_out = "";
  globalThis.__aowli_err = "";
  globalThis.__aowli_exit = 0;
  globalThis.__aowli_runnif = "";  // run-rung parks the serialized run here
}
function collectAowli(engine){
  return { stdout: globalThis.__aowli_out || "",
           stderr: globalThis.__aowli_err || "",
           exitCode: (globalThis.__aowli_exit | 0),
           engine };
}
// Out-of-memory: the aowli runtime is a bump allocator over a FIXED linear-memory
// ArrayBuffer with no GC, so a program that allocates too much in total (big
// loops building strings/collections, huge output) overruns it and the DataView
// accessors throw a RangeError. Both engines share this memory model, so a retry
// on the other engine just OOMs again — detect it and DON'T fall back.
function isMemoryError(e){
  return !!e && (e.name === "RangeError" ||
    /bounds of the DataView|out of bounds|Array buffer allocation/i.test(String(e.message || e)));
}
function runSnif(snif, stdin, forceTree, mods){
  // Engine selection: "tree" runs ONLY the tree-walker (the reference engine);
  // otherwise run the bytecode VM and, if it can't run this program in the
  // browser host (on-demand symbol load -> vfs open throws, or a quit surfaces
  // via the exit shim), fall back to the always-correct tree-walker. Where the
  // VM succeeds its output is identical to the tree-walker's.
  resetAowliGlobals(snif, stdin, mods);
  if(forceTree){ aowliMain(); return collectAowli("tree"); }
  try{
    aowliVmMain();
    return collectAowli("vm");
  }catch(e){
    // Out of memory is a genuine runtime limit, not a "the VM can't compile this"
    // signal — the tree-walker shares the same fixed heap and would just OOM too.
    if(isMemoryError(e)){ e.__oom = true; throw e; }
    resetAowliGlobals(snif, stdin, mods);
    aowliMain();
    // SAY SO. This used to return a bare "tree" result: the user picked the VM,
    // got the tree-walker, and nothing recorded it — `fellBack` stayed false, so
    // tests/run.mjs --engine=vm was silently measuring the tree-walker on the
    // whole aowlsem path (where the VM threw on every program).
    const r = collectAowli("tree");
    r.fellBack = true;
    r.fallbackReason = "vm: " + String(e && e.message || e).slice(0, 160);
    return r;
  }
}

const OOM_TEXT = "out of memory: this program allocated more than the in-browser "
  + "interpreter's fixed heap. It runs with a bump allocator and no garbage collector, "
  + "so large loops that build strings or collections (or that print a lot) exhaust it "
  + "even if little is live at once. Try the Native-JS engine (no fixed heap), fewer "
  + "iterations, or less output.";

// Run a semchecked program on a aowli engine (tree or vm) and return a result
// object, translating an exit()/OOM/crash into stdout+stderr+exitCode.
function runAowliResult(snif, stdin, forceTree, mods){
  try{
    return runSnif(snif, stdin, forceTree, mods);
  }catch(e){
    const base = globalThis.__aowli_err || "";
    const eng = forceTree ? "tree" : "vm";
    if(e && e.__isExit)
      return { stdout: globalThis.__aowli_out||"", stderr: base, exitCode: parseInt(String(e.message).replace(/\D/g,""),10)||0, engine: eng };
    if(e && (e.__oom || isMemoryError(e)))
      return { stdout: globalThis.__aowli_out||"", oom:true, exitCode:137, stderr: base + OOM_TEXT, engine: eng };
    return { stdout: globalThis.__aowli_out||"", exitCode:1, stderr: base + "runtime error: " + (e && e.message||e), engine: eng };
  }
}

// A short human reason for why a nifjs Fast run fell back to aowli.
function nifjsFallbackReason(e){
  const m = String(e && e.message || e);
  return /nifjs: unsupported/.test(m) ? m.replace(/^nifjs:\s*/, "").trim() : "fast-path error";
}

// Dispatch a run to the requested engine: "tree" | "vm" | "nifjs". nifjs
// transpiles to native JS; on any unsupported node it falls back to the VM (then
// tree), annotating the result with why.
function runByEngine(snif, stdin, engine, mods){
  if(engine === "nifjs"){
    if(nifjsApi){
      try{ return { stdout: nifjsApi.run(snif), stderr:"", exitCode:0, engine:"nifjs" }; }
      catch(e){ const r = runAowliResult(snif, stdin, false, mods); r.fellBack = true; r.fallbackReason = nifjsFallbackReason(e); return r; }
    }
    const r = runAowliResult(snif, stdin, false, mods); r.fellBack = true; r.fallbackReason = "nifjs unavailable"; return r;
  }
  return runAowliResult(snif, stdin, engine === "tree", mods);
}

// --- run rung: semcheck (cached) + run the TREE-WALKER with the emitter on, and
//     hand back the serialized execution NIF. Kept separate from the fast run path
//     so normal runs stay on the VM; this only fires when the "Run" NIF tab is open.
async function handleRunRung(msg, id){
  try{
    const { snif, diags, mods } = await runSem(msg.pnif, msg.semEngine, msg.multi);
    if(!snif){ self.postMessage({ id, ok:true, ranSem:true, snif:"", runnif:"", diags }); return; }
    await ensureRunBundle();
    resetAowliGlobals(snif, msg.stdin, mods);
    let exitCode = 0, err = "";
    try{ aowliRunMain(); exitCode = globalThis.__aowli_exit | 0; }
    catch(e){
      if(e && e.__isExit) exitCode = parseInt(String(e.message).replace(/\D/g,""),10) || 0;
      else err = "runtime error: " + (e && e.message || e);
    }
    self.postMessage({ id, ok:true, snif, runnif: globalThis.__aowli_runnif || "",
                       exitCode, stderr: (globalThis.__aowli_err||"") + err, diags });
  }catch(e){
    self.postMessage({ id, ok:false, message: String(e && e.message || e) });
  }
}

// --- debug: semcheck (cached) + run the dmStep capture engine, returning the
//     ordered step log the browser debugger replays as a time-travel session.
async function handleDebug(msg, id){
  try{
    const { snif, diags, mods } = await runSem(msg.pnif, msg.semEngine, msg.multi);
    if(!snif){ self.postMessage({ id, ok:true, ranSem:true, snif:"", steps:[], diags }); return; }
    await ensureDbgBundle();
    globalThis.__aowli_in  = msg.stdin || "";
    globalThis.__aowli_src = snif;
    globalThis.__aowli_mods = mods || "";
    globalThis.__aowli_out = "";
    globalThis.__aowli_err = "";
    globalThis.__aowli_exit = 0;
    globalThis.__aowli_dbg = "";
    let parsed = { steps:[], out:"", err:"", exit:0, truncated:false };
    try{
      aowliDbgMain();
      parsed = JSON.parse(globalThis.__aowli_dbg || "{}");
    }catch(e){
      // A crash mid-run still leaves whatever was captured on __aowli_dbg; try to
      // surface it, else report the runtime error.
      try{ parsed = JSON.parse(globalThis.__aowli_dbg || "{}"); }catch(_){}
      parsed.err = (parsed.err||"") + "runtime error: " + (e && e.message || e);
    }
    self.postMessage({ id, ok:true, snif,
      steps: parsed.steps || [], truncated: !!parsed.truncated,
      stdout: parsed.out || globalThis.__aowli_out || "",
      stderr: parsed.err || globalThis.__aowli_err || "",
      exitCode: (parsed.exit|0), diags });
  }catch(e){
    self.postMessage({ id, ok:false, message: String(e && e.message || e) });
  }
}

// --- message loop ------------------------------------------------------------
self.onmessage = (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  // Boot handshake: the main thread posts `init` once, right after spawn. In the
  // hosted mode assets is null (worker fetches its own bundles); in the offline
  // single-file mode it carries the inlined bundle texts + stdlib.
  if(msg.type === "init"){
    if(__booted) return; __booted = true;
    __assets = msg.assets || null;
    boot().then(()=> self.postMessage({ type:"ready" }))
          .catch(e=> self.postMessage({ type:"loaderr", message: String(e && e.message || e) }));
    return;
  }
  try{
    if(msg.type === "runrung"){ handleRunRung(msg, id); return; }
    if(msg.type === "debug"){ handleDebug(msg, id); return; }
    if(msg.type === "sem"){
      // semEngine: "aowl" (aowlsem, the default) | "nim" (nimsem).
      runSem(msg.pnif, msg.semEngine, msg.multi).then(({ snif, diags, cached })=>{
        self.postMessage({ id, ok:true, snif, diags, cached });
      }).catch(e=> self.postMessage({ id, ok:false, error:String(e && e.message || e) }));
      return;
    }
    if(msg.type === "run" || msg.type === "fastrun"){
      // engine: "tree" | "vm" | "nifjs". ("fastrun" is a legacy alias for nifjs.)
      const engine = msg.engine || (msg.type === "fastrun" ? "nifjs" : "vm");
      // semEngine picks which checker produces the .s.nif that aowli then runs;
      // if aowlsem couldn't check it (empty snif), the ranSem path below reports
      // its diagnostics instead of trying to run nothing.
      runSem(msg.pnif, msg.semEngine, msg.multi).then(({ snif, diags, mods })=>{
        if(!snif){ self.postMessage({ id, ok:true, ranSem:true, snif:"", diags, multiCrash:lastMultiCrash||"" }); return; }
        const res = runByEngine(snif, msg.stdin, engine, mods);
        res.diags = diags;
        if(lastMultiCrash) res.multiCrash = lastMultiCrash;
        self.postMessage(Object.assign({ id, ok:true }, res));
      }).catch(e=> self.postMessage({ id, ok:false, error:String(e && e.message || e) }));
      return;
    }
    self.postMessage({ id, ok:false, message:"unknown request: "+msg.type });
  }catch(e){
    self.postMessage({ id, ok:false, message: String(e && e.message || e) });
  }
};

// Boot is now kicked off by the `init` message (see self.onmessage) so the
// offline build can hand over its inlined bundles before we try to fetch them.
