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
// aowlsem (the experimental AOWL semantic checker) bundle text. Unlike nimsem it
// has NO warm-closure model, so we keep only the source and evaluate a fresh
// `new Function` per check (exactly like the main-thread parser). Best-effort:
// null if the bundle isn't in this build, in which case the aowl path degrades to
// a clean "unavailable" diagnostic rather than throwing.
let asJsText = null, asJsPromise = null;
// aowlsem (experimental) loads on demand — first "aowl" semantics check only.
function ensureAowlsem(){
  if(asJsText) return Promise.resolve(asJsText);
  if(!asJsPromise) asJsPromise = loadText("aowlsem.js").catch(()=>null).then(t=>(asJsText=t, t));
  return asJsPromise;
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
function buildWarmSem(){
  nsCheckFn = null;
  globalThis.__ns_assets = stdlibBlob;
  try{
    (new Function(semJsText + "\n; globalThis.__nsCheckFn = nsCheck; main(0, []);"))();
    if(typeof globalThis.__nsCheckFn === "function") nsCheckFn = globalThis.__nsCheckFn;
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
  // NOTE: aowlsem.js (2.65 MB, experimental) is deliberately NOT fetched here — it
  // loads lazily on the first "aowl" semantics check (ensureAowlsem), so the
  // default nim boot doesn't pay for a bundle most sessions never touch.
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
      buildWarmSem();
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

// --- aowlsem: the EXPERIMENTAL alternative semantic checker -------------------
// Contract (a JS mirror of aowlsem's webmain, parallel to the parser's): set
// globalThis.__as_pnif = the .p.nif, invoke a FRESH `new Function` (aowlsem has no
// warm-closure model — every check re-runs module init), then read __as_snif (the
// typed .s.nif, "" on failure) and __as_diag (a JSON array). aowlsem is system-less
// in the browser: it type-checks builtin arithmetic/if/case/while but has NO
// `system` module, so string/seq/echo programs yield honest "undeclared" diags and
// an empty .s.nif. We normalize its diagnostics to the SAME shape nimsem's
// parseDiags returns ({line, col, severity, message}) so the UI treats both alike.
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
// Its own LRU key namespace (prefixed) so an aowl result never collides with the
// nimsem cache keyed on the raw .p.nif.
function semCompileAowl(pnif){
  pnif = String(pnif);
  if(!asJsText)
    return { snif:"", cached:false,
             diags:[{ line:0, col:0, severity:"error",
                      message:"aowlsem (experimental) is not available in this build" }] };
  const key = "aowl\0" + pnif;
  const hit = cacheGet(key);
  if(hit) return { snif:hit.snif, diags:hit.diags, cached:true };
  globalThis.__as_pnif = pnif;
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
      message:"aowlsem (experimental) could not check this program: " + (e && e.message || e) }];
    snif = "";
  }
  cachePut(key, { snif, diags });
  return { snif, diags, cached:false };
}

// Route the semcheck stage to the selected engine: "aowl" -> aowlsem (experimental),
// anything else -> nimsem (the default). Both return { snif, diags, cached }.
async function runSem(pnif, semEngine){
  if(semEngine === "aowl"){ await ensureAowlsem(); return semCompileAowl(pnif); }
  return semCompile(pnif);
}

// --- aowli: run a typed .s.nif -----------------------------------------------
// Both engines read the same __aowli_* input globals and park their result on
// the same output globals; a run is a fresh scope, so state never carries over.
// All three aowli bundles (tree-walker, VM, run-rung) speak __aowli_*.
function resetAowliGlobals(snif, stdin){
  globalThis.__aowli_in  = stdin || "";
  globalThis.__aowli_src = snif;
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
function runSnif(snif, stdin, forceTree){
  // Engine selection: "tree" runs ONLY the tree-walker (the reference engine);
  // otherwise run the bytecode VM and, if it can't run this program in the
  // browser host (on-demand symbol load -> vfs open throws, or a quit surfaces
  // via the exit shim), fall back to the always-correct tree-walker. Where the
  // VM succeeds its output is identical to the tree-walker's.
  resetAowliGlobals(snif, stdin);
  if(forceTree){ aowliMain(); return collectAowli("tree"); }
  try{
    aowliVmMain();
    return collectAowli("vm");
  }catch(e){
    // Out of memory is a genuine runtime limit, not a "the VM can't compile this"
    // signal — the tree-walker shares the same fixed heap and would just OOM too.
    if(isMemoryError(e)){ e.__oom = true; throw e; }
    resetAowliGlobals(snif, stdin);
    aowliMain();
    return collectAowli("tree");
  }
}

const OOM_TEXT = "out of memory: this program allocated more than the in-browser "
  + "interpreter's fixed heap. It runs with a bump allocator and no garbage collector, "
  + "so large loops that build strings or collections (or that print a lot) exhaust it "
  + "even if little is live at once. Try the Native-JS engine (no fixed heap), fewer "
  + "iterations, or less output.";

// Run a semchecked program on a aowli engine (tree or vm) and return a result
// object, translating an exit()/OOM/crash into stdout+stderr+exitCode.
function runAowliResult(snif, stdin, forceTree){
  try{
    return runSnif(snif, stdin, forceTree);
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
function runByEngine(snif, stdin, engine){
  if(engine === "nifjs"){
    if(nifjsApi){
      try{ return { stdout: nifjsApi.run(snif), stderr:"", exitCode:0, engine:"nifjs" }; }
      catch(e){ const r = runAowliResult(snif, stdin, false); r.fellBack = true; r.fallbackReason = nifjsFallbackReason(e); return r; }
    }
    const r = runAowliResult(snif, stdin, false); r.fellBack = true; r.fallbackReason = "nifjs unavailable"; return r;
  }
  return runAowliResult(snif, stdin, engine === "tree");
}

// --- run rung: semcheck (cached) + run the TREE-WALKER with the emitter on, and
//     hand back the serialized execution NIF. Kept separate from the fast run path
//     so normal runs stay on the VM; this only fires when the "Run" NIF tab is open.
async function handleRunRung(msg, id){
  try{
    const { snif, diags } = await runSem(msg.pnif, msg.semEngine);
    if(!snif){ self.postMessage({ id, ok:true, ranSem:true, snif:"", runnif:"", diags }); return; }
    await ensureRunBundle();
    resetAowliGlobals(snif, msg.stdin);
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
    if(msg.type === "sem"){
      // semEngine: "nim" (nimsem, default) | "aowl" (aowlsem, experimental, lazy).
      runSem(msg.pnif, msg.semEngine).then(({ snif, diags, cached })=>{
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
      runSem(msg.pnif, msg.semEngine).then(({ snif, diags })=>{
        if(!snif){ self.postMessage({ id, ok:true, ranSem:true, snif:"", diags }); return; }
        const res = runByEngine(snif, msg.stdin, engine);
        res.diags = diags;
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
