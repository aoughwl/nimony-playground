// sem.js — the client-side SEMANTIC-CHECK seam (now a thin worker client).
//
// nimsem (nimony's semantic checker, ~8.9 MB compiled to JS) turns an UNTYPED
// `.p.nif` into a TYPED `.s.nif`. It used to run inline on the main thread, which
// froze the editor for the duration of every live semcheck. It now runs in the
// Web Worker owned by pipeline.js (see worker.js) — the input-level incremental
// cache and the pre-semchecked stdlib closure live over there too. This file is
// only the promise-returning facade the rest of the playground still calls as
// `window.AowliSem.compile`.
(function(){
  const sem = { ready:false, compile:null };
  let hits = 0, misses = 0, warm = 0;

  // Which semantic checker to use: "nim" (nimsem, default) or "aowl" (aowlsem,
  // experimental). Callers may pass it explicitly; otherwise we follow the global
  // toggle the UI flips (window.AowliOpts.sem), mirroring how the parser follows
  // window.AowliOpts.curly.
  function semEngine(explicit){
    if(explicit === "nim" || explicit === "aowl") return explicit;
    const g = (window.AowliOpts && window.AowliOpts.sem);
    return g === "aowl" ? "aowl" : "nim";
  }

  // pnif: the `.p.nif` string. `eng` (optional) overrides the global sem toggle.
  // Returns Promise<{ snif, diags, cached }>.
  sem.compile = function(pnif, eng){
    if(!(window.AowliPipe && window.AowliPipe.ready))
      return Promise.reject(new Error("nimsem not loaded yet"));
    return window.AowliPipe.sem(pnif, semEngine(eng)).then(m => {
      if(m.cached) hits++; else { misses++; warm = Math.min(warm + 1, 8); }
      return { snif:m.snif, diags:m.diags || [], cached:!!m.cached };
    });
  };
  sem.stats = () => ({ hits, misses, warm });

  Object.defineProperty(sem, "ready", { get: () => !!(window.AowliPipe && window.AowliPipe.ready) });
  window.AowliSem = sem;
})();
