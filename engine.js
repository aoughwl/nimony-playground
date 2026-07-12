// engine.js — the client-side execution seam.
//
// The nimony interpreter `nifi` is compiled to JavaScript by aoughwl/nimony-web
// (bundle: nifi.js). We drive it exactly like the Node harness does, but in-tab:
//
//   IN : globalThis.__nifi_src  = the .s.nif bytes (byte-exact string)
//   RUN: (new Function(bundle + "main(0,[]);"))()      // fresh scope per run
//   OUT: globalThis.__nifi_out / __nifi_err / __nifi_exit
//
// A fresh `new Function` scope per run is deliberate: the bundle has top-level
// declarations that can't be redeclared in one global scope, and a fresh scope
// also gives each run clean interpreter state.
//
// Tier 1 (today): runs an example's PRE-COMPILED .s.nif — fully client-side,
// no backend. Tier 2 (frontend ported to JS) will compile whatever is in the
// editor; then window.NifiCore.compileAndRun takes over transparently.
(function(){
  const engine = { ready:false, tier:1, run:null };
  let bundleText = null;

  async function loadBundle(){
    if(bundleText) return bundleText;
    const r = await fetch("nifi.js");
    if(!r.ok) throw new Error("failed to load interpreter (nifi.js): HTTP " + r.status);
    bundleText = await r.text();
    return bundleText;
  }

  // Byte-exact fetch: .s.nif is a NIF byte stream; decode 1:1 (latin1), never UTF-8.
  async function fetchSnifBytes(name){
    const r = await fetch("assets/snif/" + name);
    if(!r.ok) throw new Error("missing bytecode asset: " + name + " (HTTP " + r.status + ")");
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = "";
    for(let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  function runSnif(bytes){
    globalThis.__nifi_src = bytes;
    globalThis.__nifi_out = ""; globalThis.__nifi_err = ""; globalThis.__nifi_exit = 0;
    (new Function(bundleText + "\nmain(0, []);"))();
    return {
      stdout: globalThis.__nifi_out || "",
      stderr: globalThis.__nifi_err || "",
      exitCode: globalThis.__nifi_exit | 0
    };
  }
  // Exposed so index.html / future glue can call the interpreter directly.
  window.NifiCore = { runSnif };

  // ── Tier 2/3: worker-backed compile+run ────────────────────────────────
  // GATED. The default live app stays Tier 1 (precompiled, no worker). Tier 2
  // turns on only with ?tier2 in the URL or window.__NIFI_TIER2 === true, so
  // this new path can never regress the shipped experience.
  const TIER2 = (typeof location !== "undefined" && /[?&]tier2\b/.test(location.search))
             || (window.__NIFI_TIER2 === true);

  let worker = null, seq = 0;
  const pending = new Map();           // id -> {resolve, reject}

  function ensureWorker(){
    if(worker) return worker;
    worker = new Worker("worker.js");
    worker.onmessage = (e) => {
      const m = e.data || {};
      if(m.type === "ready"){
        engine.tier = 2;
        if(window.__nifiLspStatus) window.__nifiLspStatus("live");
        return;
      }
      // Correlate by id; unknown/stale ids are dropped silently.
      const p = pending.get(m.id);
      if(!p) return;
      pending.delete(m.id);
      p.resolve(m);
    };
    worker.onerror = (e) => {
      const err = new Error("worker error: " + (e && e.message || "unknown"));
      pending.forEach(p => p.reject(err));
      pending.clear();
    };
    // Kick the handshake (worker also announces ready unsolicited).
    worker.postMessage({ type:"ready?" });
    return worker;
  }

  function post(type, src){
    const w = ensureWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ type, id, src });
    });
  }

  if(TIER2){
    // The single typeof-guard in run() below now routes through the worker.
    window.NifiCore.compileAndRun = async (src) => {
      const m = await post("run", src);
      return { stdout: m.stdout || "", stderr: m.stderr || "", exitCode: m.exit | 0 };
    };
    // Diagnostics channel used by editor.js's debounce.
    window.NifiCore.compile = async (src) => {
      const m = await post("compile", src);
      return m.diagnostics || [];
    };
    // Spawn eagerly so readiness (-> lsp: live) shows without a first Run.
    ensureWorker();
  }

  async function run(req){
    await loadBundle();
    // Tier 2 hook: when the frontend is ported, compile the editor buffer live.
    if(window.NifiCore && typeof window.NifiCore.compileAndRun === "function")
      return window.NifiCore.compileAndRun(req.source);
    const ex = req.example;
    if(!ex || !ex.snif)
      return { stdout:"", stderr:"This example has no pre-compiled bytecode yet.", exitCode:1 };
    return runSnif(await fetchSnifBytes(ex.snif));
  }

  engine.run = run;
  window.NifiEngine = engine;

  loadBundle().then(() => {
    engine.ready = true;
    if(window.__nifiEngineReady) window.__nifiEngineReady(true);
    // Tier 1: no live language service. Tier 2: the worker flips this to "live"
    // when it reports ready, so don't stomp it here.
    if(window.__nifiLspStatus && !TIER2) window.__nifiLspStatus("off");
  }).catch(e => {
    engine.ready = false;
    if(window.__nifiEngineReady) window.__nifiEngineReady(false, String(e && e.message || e));
  });
})();
