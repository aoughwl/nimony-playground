// pipeline.js — main-thread client for worker.js.
//
// Owns the Web Worker that runs nimsem + nifi off the UI thread, and exposes a
// small async surface the rest of the playground drives:
//
//   NifiPipe.sem(pnif)          -> Promise<{ snif, diags, cached }>
//   NifiPipe.run(pnif, stdin)   -> Promise<{ stdout, stderr, exitCode, diags }>
//   NifiPipe.stop()             -> kill the current run (terminate + respawn)
//
// The Stop path is the whole reason execution lives in a worker: a runaway loop
// in user code can't be interrupted cooperatively, but the worker CAN be
// terminated. We then spin up a fresh one (bundles come from HTTP cache, so the
// respawn is cheap) so the next Run works immediately.
(function(){
  const pipe = { ready:false, sem:null, run:null, stop:null, alive:false };
  let worker = null, seq = 0, pending = new Map(), inflightRun = null;

  // The offline single-file build exposes window.__NIFI_INLINE with the worker
  // source + all bundle texts; use it to (a) build the Worker from a Blob URL
  // (a file:// page can't `new Worker("worker.js")` — origin 'null'), and (b)
  // hand the bundles to the worker via `init` since it can't fetch() them.
  const INLINE = (typeof window !== "undefined" && window.__NIFI_INLINE) || null;

  function spawn(){
    pipe.ready = false; pipe.alive = false;
    if(INLINE && INLINE.workerText){
      const blob = new Blob([INLINE.workerText], { type:"text/javascript" });
      worker = new Worker(URL.createObjectURL(blob));
    }else{
      worker = new Worker("worker.js?v=18");
    }
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if(m.type === "ready"){
        pipe.ready = true; pipe.alive = true;
        if(window.__nifiSemReady) window.__nifiSemReady(true);
        if(window.__nifiEngineReady) window.__nifiEngineReady(true);
        return;
      }
      if(m.type === "loaderr"){
        pipe.ready = false;
        if(window.__nifiSemReady) window.__nifiSemReady(false, m.message);
        if(window.__nifiEngineReady) window.__nifiEngineReady(false, m.message);
        return;
      }
      const p = pending.get(m.id);
      if(!p) return;
      pending.delete(m.id);
      if(m.id === inflightRun) inflightRun = null;
      if(m.ok) p.resolve(m); else p.reject(new Error(m.message || "pipeline error"));
    };
    // A hard worker crash (should be rare — the worker try/catches its stages):
    // reject everything in flight so no caller hangs, then respawn.
    worker.onerror = (e) => {
      const err = new Error("worker crashed: " + (e && e.message || e));
      for(const [,p] of pending) p.reject(err);
      pending.clear(); inflightRun = null;
      try{ worker.terminate(); }catch(_){}
      spawn();
    };
    // Kick off the worker's boot. Hosted: assets null (worker fetches). Offline:
    // hand over the inlined bundle texts + stdlib so it never touches the network.
    worker.postMessage({ type:"init",
      assets: INLINE ? { bundles: INLINE.bundles, stdlibB64: INLINE.stdlibB64 } : null });
  }

  function request(type, extra){
    return new Promise((resolve, reject) => {
      if(!worker){ reject(new Error("pipeline not started")); return; }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      if(type === "run") inflightRun = id;
      worker.postMessage(Object.assign({ id, type }, extra));
    });
  }

  pipe.sem = (pnif) => request("sem", { pnif:String(pnif) });
  // engine: "tree" | "vm" | "nifjs" (default "vm").
  pipe.run = (pnif, stdin, engine) => request("run", { pnif:String(pnif), stdin:String(stdin||""), engine: engine||"vm" });
  // run rung: execute on the tree-walker with the run emitter on, returning the
  // serialized execution NIF (see worker.js handleRunRung). Lazy-loads nifi_run.js.
  pipe.runrung = (pnif, stdin) => request("runrung", { pnif:String(pnif), stdin:String(stdin||"") });

  // Kill the in-flight run (if any) and hand back a fresh worker. Any pending
  // request is rejected with a `stopped` flag so callers can distinguish a user
  // Stop from a real failure.
  pipe.stop = () => {
    const hadRun = inflightRun != null;
    const err = new Error("stopped"); err.stopped = true;
    for(const [,p] of pending) p.reject(err);
    pending.clear(); inflightRun = null;
    try{ worker.terminate(); }catch(_){}
    spawn();
    return hadRun;
  };
  pipe.busy = () => inflightRun != null;

  window.NifiPipe = pipe;
  spawn();
})();
