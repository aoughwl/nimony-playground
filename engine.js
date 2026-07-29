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
  // Module basenames provided by the current workspace (project-local files and
  // cross-project imports). A module that maps to any workspace .nim/.aowl file
  // is resolvable, so it must NOT be flagged as "unavailable" — the multi-module
  // semcheck in the worker resolves it against the preloaded project sources.
  function workspaceModules(){
    const set = new Set();
    const W = window.AowliWorkspace;
    if(!W) return set;
    for(const p of W.projects){
      for(const path of W.fileList(p.id)){
        const m = /([^/]+)\.(nim|aowl)$/.exec(path);
        if(m) set.add(m[1]);
      }
    }
    return set;
  }
  function checkImports(source){
    const out = [], lines = String(source).split("\n");
    const local = workspaceModules();
    for(let i=0;i<lines.length;i++){
      const m = /^\s*(?:import|from)\s+(.+?)\s*$/.exec(lines[i]);
      if(!m) continue;
      const spec = m[1].split("#")[0].replace(/\bimport\b.*$/,"").replace(/\bexcept\b.*$/,"").replace(/\bas\b.*$/,"");
      for(const mod of importedModules(spec)){
        const base = mod.split("/").pop();
        // Resolvable if: a workspace file provides it (project-local / cross-
        // project / a mounted std source), OR it's in the pre-checked std
        // closure. Only genuinely-missing modules are reported.
        if(local.has(base) || BUNDLED.has(base)) continue;
        const col = (lines[i].indexOf(base)+1) || 1;
        out.push({ line:i+1, col, severity:"error",
          message:'module "'+mod+'" is not available — it is not in the browser stdlib closure and no open project provides it. Clone or create a project with '+base+'.nim to import it.' });
      }
    }
    return out;
  }

  // Build the multi-module (workspace) payload for the worker, or null when the
  // workspace has at most one user module (then single-module checking is used).
  // Parses every user .nim/.aowl in the open non-std projects to its .p.nif,
  // caching by content so unchanged files aren't re-parsed each run. `mainAbs` is
  // the active file's virtual absolute path (its buffer is the live `source`).
  const _pnifCache = new Map();   // content -> pnif
  function parseCached(src, file){
    const key = file + "\0" + src;
    const hit = _pnifCache.get(key);
    if(hit != null) return hit;
    let nif = "";
    try{ nif = window.AowliParser.parseFull(src, file).nif; }catch(_){ nif = ""; }
    if(_pnifCache.size > 200) _pnifCache.clear();
    _pnifCache.set(key, nif);
    return nif;
  }
  function buildMulti(liveSource){
    const W = window.AowliWorkspace;
    if(!W || !W.activeRef) return null;
    // ONLY user (non-std) project sources: the std library is served from the
    // pre-checked closure, so its 100+ files must NEVER be parsed here (parsing
    // them synchronously on every check is what froze the UI). Also skip a
    // std-mounted active file (nothing to cross-check).
    if(W.activeReadonly && W.activeReadonly()) return null;
    const userProjects = new Set(W.projects.filter(p=>p.kind!=="std" && p.open!==false).map(p=>p.id));
    const sources = [];
    for(const p of W.projects){
      if(!userProjects.has(p.id)) continue;
      for(const path of W.fileList(p.id))
        if(/\.(nim|aowl)$/.test(path)) sources.push({ absPath: W.absPath({projectId:p.id, path}), content: W.readFile(p.id, path) });
    }
    if(sources.length <= 1) return null;   // ≤1 user module ⇒ no cross-file resolution
    const mainAbs = W.activeAbsPath();
    // The multi-module driver sems modules IN DEPENDENCY ORDER (a leaf is checked
    // before anything that imports it), so topologically sort by their import
    // edges. Edges are read from each file's `import`/`from` lines mapped to a
    // sibling module by basename; unknown imports (stdlib) are simply ignored.
    const byBase = new Map();   // module basename -> absPath
    for(const s of sources){ const m=/([^/]+)\.(nim|aowl)$/.exec(s.absPath); if(m) byBase.set(m[1], s.absPath); }
    const contentOf = (abs)=> (abs===mainAbs) ? liveSource : (sources.find(x=>x.absPath===abs)||{}).content || "";
    function depsOf(abs){
      const out = new Set();
      for(const line of String(contentOf(abs)).split("\n")){
        const m = /^\s*(?:import|from)\s+(.+?)\s*$/.exec(line); if(!m) continue;
        const spec = m[1].split("#")[0].replace(/\bimport\b.*$/,"").replace(/\bexcept\b.*$/,"").replace(/\bas\b.*$/,"");
        for(const mod of importedModules(spec)){
          const base = mod.split("/").pop();
          if(byBase.has(base) && byBase.get(base)!==abs) out.add(byBase.get(base));
        }
      }
      return [...out];
    }
    const order = [], seen = new Set(), inStack = new Set();
    (function visit(abs){
      if(seen.has(abs) || inStack.has(abs)) return;   // inStack guard breaks import cycles
      inStack.add(abs);
      for(const d of depsOf(abs)) visit(d);
      inStack.delete(abs); seen.add(abs); order.push(abs);
    })(mainAbs);
    // Only the modules REACHABLE from the active file are checked — a 600-file
    // cloned repo must not parse all 600 on every keystroke. Unreferenced files are
    // simply not part of this compilation. (order already holds just the closure.)
    // Frame every source (dependency order) as "<path>\t<len>\n<pnif>"; the ACTIVE
    // file uses the live (unsaved) buffer so an in-flight edit is what gets checked.
    let modules = "";
    for(const abs of order){
      const pnif = parseCached(contentOf(abs), abs);
      if(!pnif) continue;
      modules += abs + "\t" + pnif.length + "\n" + pnif;
    }
    return { mainpath: mainAbs, paths: W.searchPaths().join("\n"), modules };
  }
  window.__aowliBuildMulti = buildMulti;

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
    const multi = (semEng === "nim") ? buildMulti(source) : null;
    const m = await window.AowliPipe.run(nif, stdin, engine, semEng, multi);
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
