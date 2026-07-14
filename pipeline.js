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

  function spawn(){
    pipe.ready = false; pipe.alive = false;
    worker = new Worker("worker.js?v=14");
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
  pipe.run = (pnif, stdin) => request("run", { pnif:String(pnif), stdin:String(stdin||"") });
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
