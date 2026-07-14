// parser.js — the client-side FRONTEND seam.
//
// nifparser (aoughwl/nifparser) is a pure-nimony Nim→NIF parser, compiled to
// JavaScript through the nimony-web JS backend into a single ~725 KB bundle
// (nifparser.js). It reproduces classic `nifler`'s `.p.nif` output byte-for-byte
// but — unlike nifler, which is classic-Nim only — it runs in the browser. This
// is the parser half of Tier 2 (live client-side compilation).
//
// Interface contract (a JS mirror of nifparser/src/webmain.nim):
//   IN : globalThis.__np_src   = the Nim source text (a string)
//        globalThis.__np_file  = relative path baked into NIF line-info suffixes
//        globalThis.__np_curly = "1" to also accept `{ … }` block bodies
//                                (experimental curly-brace mode), "" for classic
//                                indent-only parsing
//   RUN: (new Function(bundle + "main(0,[]);"))()   // fresh scope per parse
//   OUT: globalThis.__np_out   = the produced `.p.nif` bytes (a string)
//        globalThis.__np_diag  = JSON array of syntactic diagnostics:
//                                [{line:1-based, col:0-based, message}]
//
// A fresh `new Function` scope per parse is deliberate and required: nimony's
// generated `main` guards module-init so it runs exactly once — the parse lives
// in that init, so re-invoking a cached `main` would NOT re-parse. Re-evaluating
// the bundle is ~8 ms, which is why parsing is debounced off keystrokes below.
(function(){
  // Global curly toggle: callers that pass no `opts` follow whatever this is set
  // to (the UI flips window.NifiOpts.curly). Initialize defensively in case this
  // file loads before whoever else owns the object.
  window.NifiOpts = window.NifiOpts || { curly:false };

  const parser = { ready:false, parse:null };
  let bundleText = null, loadPromise = null;
  // Compile the bundle to a callable ONCE (see note above): re-parsing ~950 KB of
  // JS on every keystroke-debounced parse is pure waste. `new Function(text)`
  // parses+compiles the source; invoking the RESULT re-executes its top-level
  // decls (fresh linear memory, fresh module-init) each call — so we still get
  // the required clean scope per parse, but pay the 8 ms compile only once.
  // Verified byte-identical to the per-call form.
  let compiledMain = null;

  function loadBundle(){
    if(loadPromise) return loadPromise;
    loadPromise = fetch("nifparser.js").then(r=>{
      if(!r.ok) throw new Error("failed to load parser (nifparser.js): HTTP "+r.status);
      return r.text();
    }).then(t=>{ bundleText = t; compiledMain = new Function(t + "\nmain(0, []);"); return t; });
    return loadPromise;
  }

  // Memo of the last parse, keyed by (curly, file, source). The playground parses
  // the SAME buffer up to three times per edit cycle — the live NIF view, the
  // live semcheck, and Run — so a size-1 memo collapses that to a single actual
  // parse. `diags` is cloned out so callers can't mutate the cached array.
  let memo = { key:null, nif:"", diags:[] };
  function runParse(source, file, curly){
    const key = (curly?"1":"0") + "\0" + file + "\0" + source;
    if(memo.key === key) return memo;
    globalThis.__np_src  = source;
    globalThis.__np_file = file;
    globalThis.__np_curly = curly ? "1" : "";
    globalThis.__np_out  = "";
    globalThis.__np_diag = "[]";
    compiledMain();
    let diags = [];
    try{ diags = JSON.parse(globalThis.__np_diag || "[]"); }catch(_){ diags = []; }
    memo = { key, nif: globalThis.__np_out || "", diags };
    return memo;
  }

  // Synchronous once the bundle is loaded. Returns the `.p.nif` string, or throws.
  // `opts.curly` (optional) forces curly mode; omitting it follows window.NifiOpts.
  function parseSync(source, file, opts){
    if(!compiledMain) throw new Error("parser not loaded yet");
    // __np_curly: "1" enables experimental `{ … }` block bodies, "" = indent-only.
    const curly = opts && ("curly" in opts) ? !!opts.curly : !!(window.NifiOpts && window.NifiOpts.curly);
    return runParse(String(source), file || "in.nim", curly).nif;
  }

  // Full result: { nif, diags }. `diags` are the parser's own coordinates
  // (line 1-based, col 0-based); the caller shifts col to Monaco's 1-based.
  // `opts.curly` (optional) forces curly mode; omitting it follows window.NifiOpts.
  function parseFull(source, file, opts){
    if(!compiledMain) throw new Error("parser not loaded yet");
    // __np_curly: "1" enables experimental `{ … }` block bodies, "" = indent-only.
    const curly = opts && ("curly" in opts) ? !!opts.curly : !!(window.NifiOpts && window.NifiOpts.curly);
    const r = runParse(String(source), file || "in.nim", curly);
    return { nif: r.nif, diags: r.diags.slice() };
  }

  parser.parse = parseSync;
  parser.parseFull = parseFull;
  window.NifiParser = parser;

  loadBundle().then(()=>{
    parser.ready = true;
    if(window.__nifiParserReady) window.__nifiParserReady(true);
  }).catch(e=>{
    parser.ready = false;
    if(window.__nifiParserReady) window.__nifiParserReady(false, String(e && e.message || e));
  });
})();
