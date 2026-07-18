// suggest.js — the client-side QUICK-FIX seam.
//
// aowlsuggest (aoughwl/aowlsuggest) is a verified quick-fix / lint layer that sits
// ON TOP of the parser's JSON diagnostics: it consumes the parser's __np_diag (it
// does NOT re-parse) and emits code-action edits. It's tiny (~389 KB) and needs no
// worker, so it runs right here on the main thread next to parser.js — the same
// place the parse and its diagnostics are produced (see index.html runParse).
//
// Interface contract (a JS mirror of aowlsuggest's webmain):
//   IN : globalThis.__su_src   = the source text
//        globalThis.__su_diag  = the parser's __np_diag, as a JSON string
//   RUN: (new Function(bundle + "main(0,[]);"))()   // fresh module-init per call
//   OUT: globalThis.__su_fixes = JSON array of quick-fixes:
//        [{ code, title, message, line(1-based), col(0-based), endLine, endCol,
//           newText, kind:"auto"|"suggestion", isPreferred, severity }]
//        For kind:"auto", replace the range [line:col .. endLine:endCol] with newText.
//
// As with the parser, a FRESH `new Function` invocation is required per call:
// nimony's generated `main` guards module-init to run once, and the analysis lives
// in that init. We compile the bundle text to a callable ONCE (cheap ~8 ms) and
// re-invoke it per call to get a clean scope without re-paying the compile.
(function(){
  const suggest = { ready:false, compute:null };
  let compiledMain = null, loadPromise = null;

  function loadBundle(){
    if(loadPromise) return loadPromise;
    // Offline single-file build: the bundle is inlined on the page (a file:// page
    // can't fetch() it), so use that text directly when present — same as parser.js.
    const inline = (typeof window !== "undefined" && window.__NIFI_INLINE);
    if(inline && inline.bundles && inline.bundles["aowlsuggest.js"]){
      compiledMain = new Function(inline.bundles["aowlsuggest.js"] + "\nmain(0, []);");
      loadPromise = Promise.resolve(true);
      return loadPromise;
    }
    loadPromise = fetch("aowlsuggest.js").then(r=>{
      if(!r.ok) throw new Error("failed to load aowlsuggest.js: HTTP "+r.status);
      return r.text();
    }).then(t=>{ compiledMain = new Function(t + "\nmain(0, []);"); return true; });
    return loadPromise;
  }

  // Robust by contract: if the bundle isn't loaded or the analysis throws, return
  // [] so the editor's code-action path simply offers nothing (never breaks).
  // `diags` is the parser's raw diagnostics array (the __np_diag shape); we hand it
  // over as the JSON string aowlsuggest expects.
  suggest.compute = function(source, diags){
    if(!compiledMain) return [];
    try{
      globalThis.__su_src   = String(source || "");
      globalThis.__su_diag  = typeof diags === "string" ? diags : JSON.stringify(diags || []);
      globalThis.__su_fixes = "[]";
      compiledMain();
      const out = JSON.parse(globalThis.__su_fixes || "[]");
      return Array.isArray(out) ? out : [];
    }catch(e){
      // Don't let a quick-fix hiccup disturb the editor — log and no-op.
      if(typeof console !== "undefined") console.warn("aowlsuggest failed:", e && e.message || e);
      return [];
    }
  };

  window.AowliSuggest = suggest;

  loadBundle().then(()=>{ suggest.ready = true; })
    .catch(e=>{ suggest.ready = false;
      if(typeof console !== "undefined") console.warn("aowlsuggest unavailable:", e && e.message || e); });
})();
