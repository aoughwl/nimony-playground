// sem.js — the client-side SEMANTIC-CHECK seam (a thin worker client).
//
// A checker turns an UNTYPED `.p.nif` into a TYPED `.s.nif`. Two are shipped:
// aowlsem (aoughwl's, the DEFAULT) and nimsem (nimony's own, the reference and
// the multi-file-workspace path). Both run in the Web Worker owned by
// pipeline.js (see worker.js) — the input-level incremental cache and each
// checker's pre-semchecked stdlib live over there too; on the main thread a
// semcheck would freeze the editor for its whole duration. This file is only the
// promise-returning facade the rest of the playground calls as
// `window.AowliSem.compile`.
(function(){
  const sem = { ready:false, compile:null };
  let hits = 0, misses = 0, warm = 0;

  // Which semantic checker to use: "aowl" (aowlsem, the DEFAULT) or "nim"
  // (nimsem). Callers may pass it explicitly; otherwise we follow the global
  // toggle the UI flips (window.AowliOpts.sem), mirroring how the parser follows
  // window.AowliOpts.curly.
  function semEngine(explicit){
    if(explicit === "nim" || explicit === "aowl") return explicit;
    const g = (window.AowliOpts && window.AowliOpts.sem);
    return g === "nim" ? "nim" : "aowl";
  }

  // pnif: the `.p.nif` string. `eng` (optional) overrides the global sem toggle.
  // Returns Promise<{ snif, diags, cached }>. For a multi-file workspace the live
  // check also resolves cross-file imports (multi-module nimsem), so a definition
  // in another project file / cloned repo type-checks — `src` (the active buffer)
  // lets the payload use the live, unsaved text for the active module.
  sem.compile = function(pnif, eng, src){
    if(!(window.AowliPipe && window.AowliPipe.ready))
      return Promise.reject(new Error("nimsem not loaded yet"));
    let engine = semEngine(eng);
    // buildMulti returns null for a single-module session, so a non-null payload
    // IS a real workspace. aowlsem checks one module at a time and has no
    // cross-file import resolution, so a workspace falls back to nimsem rather
    // than reporting every sibling symbol as undeclared. Single-file sessions —
    // which is nearly all of them — keep the default checker.
    const multi = (window.__aowliBuildMulti && src != null) ? window.__aowliBuildMulti(src) : null;
    if(multi && multi.modules && engine !== "nim") engine = "nim";
    return window.AowliPipe.sem(pnif, engine, multi).then(m => {
      if(m.cached) hits++; else { misses++; warm = Math.min(warm + 1, 8); }
      return { snif:m.snif, diags:m.diags || [], cached:!!m.cached };
    });
  };
  sem.stats = () => ({ hits, misses, warm });

  Object.defineProperty(sem, "ready", { get: () => !!(window.AowliPipe && window.AowliPipe.ready) });
  window.AowliSem = sem;
})();
