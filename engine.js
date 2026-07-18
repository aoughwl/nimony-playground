// engine.js — the client-side execution seam (now a thin worker client).
//
// Live compile+run: source → nifparser (.p.nif, main thread) → nimsem (.s.nif)
// → aowli (run). The last two stages run in the Web Worker owned by pipeline.js,
// so a long or infinite run never blocks the UI and can be stopped by killing
// the worker. This file only orchestrates: it parses on the main thread (fast,
// and it feeds the synchronous LSP index anyway), gates imports, and hands the
// `.p.nif` to the worker.
(function(){
  const engine = { tier:2, run:null };

  // Modules pre-semchecked into the browser stdlib closure. Importing anything
  // NOT here is reported up front (a clean diagnostic) instead of letting nimsem
  // quit mid-compile trying to open a module it can't find.
  const BUNDLED = new Set(["algorithm","appdirs","assertions","atomics","base64",
    "bitops","cmdline","complex","cpuinfo","deques","dirs","editdistance","encodings",
    "envvars","fenv","formatfloat","hashes","heapqueue","intsets","ioring","json",
    "lexbase","locks","macros","math","md5","memfiles","monotimes","nativesocket",
    "nifply","opt","options","os","oserrors","osproc","parfor","parsejson","parseopt",
    "parseutils","pathnorm","paths","random","rawthreads","result","rlocks","sequtils",
    "sets","setutils","sha1","streams","strtabs","strutils","syncio","system","tables",
    "terminal","threadpool","ticketlocks","times","unicode","varints","widestrs",
    "wordwrap","writenif"]);

  // Expand a `from`/`import` spec into module paths, handling nimony's bracket
  // sugar `pkg/[a, b, c]` as well as a plain comma list `a, b, c`.
  function importedModules(spec){
    const mods = [];
    const br = /^(.*?)\[([^\]]*)\]\s*$/.exec(spec);
    if(br){
      const prefix = br[1].trim().replace(/\s*\/\s*/g,"/");
      for(const raw of br[2].split(",")){ const item = raw.trim().replace(/\s*\/\s*/g,"/"); if(item) mods.push(prefix + item); }
    } else {
      for(const raw of spec.split(",")){ const mod = raw.trim().replace(/\s*\/\s*/g,"/"); if(mod) mods.push(mod); }
    }
    return mods;
  }
  function checkImports(source){
    const out = [], lines = String(source).split("\n");
    for(let i=0;i<lines.length;i++){
      const m = /^\s*(?:import|from)\s+(.+?)\s*$/.exec(lines[i]);
      if(!m) continue;
      const spec = m[1].split("#")[0].replace(/\bimport\b.*$/,"").replace(/\bexcept\b.*$/,"").replace(/\bas\b.*$/,"");
      for(const mod of importedModules(spec)){
        const base = mod.split("/").pop();
        if(!BUNDLED.has(base)){
          const col = (lines[i].indexOf(base)+1) || 1;
          out.push({ line:i+1, col, severity:"error",
            message:'module "'+mod+'" is not in the browser stdlib closure yet (type-checkable: the nimony std library)' });
        }
      }
    }
    return out;
  }

  // Live compile the editor buffer and run it in the worker. Same
  // {stdout,stderr,exitCode,diags} shape as before. Returns a Promise.
  async function compileAndRun(source, stdin, engine){
    if(!(window.AowliParser && window.AowliParser.ready))
      return { stdout:"", stderr:"parser still loading…", exitCode:1 };
    if(!(window.AowliPipe && window.AowliPipe.ready))
      return { stdout:"", stderr:"semantic checker still loading…", exitCode:1 };
    const badImports = checkImports(source);
    if(badImports.length)
      return { stdout:"", stderr:"unavailable import:\n"+badImports.map(b=>"  "+b.line+":"+b.col+"  "+b.message).join("\n"),
               exitCode:1, diags:badImports };
    // 1. parse → .p.nif on the main thread (syntax diagnostics surfaced elsewhere)
    const { nif, diags: synDiags } = window.AowliParser.parseFull(source, "in.nim");
    if(synDiags && synDiags.length)
      return { stdout:"", stderr:"syntax error: "+synDiags[0].message+" (line "+synDiags[0].line+")", exitCode:1 };
    // 2+3. semcheck (worker, cached) + run (worker) on the chosen engine
    // ("tree" | "vm" | "nifjs"). nifjs falls back to aowli on unsupported nodes.
    // The semcheck stage uses whichever checker the sem toggle selects; if aowlsem
    // (experimental) is picked and can't produce a .s.nif, the ranSem branch below
    // reports its diagnostics rather than trying to run an empty program.
    const semEng = (window.AowliOpts && window.AowliOpts.sem === "aowl") ? "aowl" : "nim";
    const m = await window.AowliPipe.run(nif, stdin, engine, semEng);
    if(!m.snif && m.ranSem){
      const msg = (m.diags && m.diags.length)
        ? m.diags.map(d=>"  "+d.line+":"+d.col+"  "+d.message).join("\n")
        : "the program did not type-check.";
      return { stdout:"", stderr:"semantic error:\n"+msg, exitCode:1, diags:m.diags||[] };
    }
    return { stdout:m.stdout||"", stderr:m.stderr||"", exitCode:m.exitCode|0, diags:m.diags||[], engine:m.engine, oom:!!m.oom, fellBack:!!m.fellBack, fallbackReason:m.fallbackReason||"" };
  }

  window.AowliCore = { compileAndRun, checkImports };

  // req: { source, stdin }. Returns Promise<{stdout,stderr,exitCode}>.
  engine.run = (req) => compileAndRun(req.source, req.stdin, (req && req.engine) || "vm");
  Object.defineProperty(engine, "ready", { get: () => !!(window.AowliPipe && window.AowliPipe.ready) });
  window.AowliEngine = engine;
})();
