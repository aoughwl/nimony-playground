// workspace.js — the multi-file / multi-project virtual filesystem that turns the
// single-buffer playground into an IDE.
//
// The whole rest of the app reads ONE buffer (window.AowliEditor.getValue()).
// Rather than rewrite every consumer, the workspace interposes: it owns the set
// of open files, tracks which one is ACTIVE, and mediates editor <-> file. When
// the active file changes it flushes the editor's text back into the old file
// and loads the new file's text into the editor. Parser / sem / run / export /
// LSP keep reading AowliEditor.getValue() — that value is now "the active file".
//
// Model
//   project = { id, name, kind:'user'|'git'|'std', readonly, files:Map<path,{content}>,
//               open:bool, remote?:string }
//     `path` is project-relative, always '/'-separated, no leading slash
//       (e.g. "src/main.nim").
//   A file's VIRTUAL ABSOLUTE path (for module resolution) is
//       /ws/<project.name>/<path>
//   activeRef = { projectId, path } | null
//
// Persistence: the whole workspace (minus the std project, which is remounted
// from an asset each load) is serialized to localStorage under np-workspace so a
// cloned repo / scratch files survive a refresh.
(function(){
  const LS_KEY = "np-workspace";
  const ROOT = "/ws";

  const ws = {
    projects: [],
    activeRef: null,
    _listeners: new Set(),
    _fileListeners: new Set(),   // fired when the ACTIVE file's identity changes
  };

  // ---- ids / paths ----------------------------------------------------------
  let _seq = 1;
  function newId(){ return "p" + (_seq++) + "_" + Math.random().toString(36).slice(2,7); }
  function normPath(p){
    return String(p||"").replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/+/g,"/").replace(/\/+$/,"");
  }
  function absPathOf(project, path){ return ROOT + "/" + project.name + "/" + normPath(path); }
  ws.absPath = (ref) => { const p = ws.project(ref.projectId); return p ? absPathOf(p, ref.path) : null; };
  ws.ROOT = ROOT;

  // ---- events ---------------------------------------------------------------
  function emit(){ for(const cb of ws._listeners) try{ cb(); }catch(_){} }
  function emitFile(){ for(const cb of ws._fileListeners) try{ cb(); }catch(_){} }
  ws.onChange = (cb) => { ws._listeners.add(cb); return () => ws._listeners.delete(cb); };
  ws.onActiveFileChange = (cb) => { ws._fileListeners.add(cb); return () => ws._fileListeners.delete(cb); };

  // ---- projects -------------------------------------------------------------
  ws.project = (id) => ws.projects.find(p => p.id === id) || null;
  ws.projectByName = (name) => ws.projects.find(p => p.name === name) || null;

  function uniqueName(base){
    let name = base, n = 2;
    while(ws.projectByName(name)) name = base + "-" + (n++);
    return name;
  }

  ws.addProject = (opts) => {
    const proj = {
      id: newId(),
      name: uniqueName(normPath(opts.name || "project").split("/").pop() || "project"),
      kind: opts.kind || "user",
      readonly: !!opts.readonly,
      remote: opts.remote || null,
      open: opts.open !== false,
      files: new Map(),
    };
    for(const [path, content] of Object.entries(opts.files || {}))
      proj.files.set(normPath(path), { content: String(content) });
    ws.projects.push(proj);
    save(); emit();
    return proj;
  };

  ws.removeProject = (id) => {
    const i = ws.projects.findIndex(p => p.id === id);
    if(i < 0) return;
    const proj = ws.projects[i];
    ws.projects.splice(i, 1);
    if(ws.activeRef && ws.activeRef.projectId === id){
      ws.activeRef = null;
      // fall back to the first available file
      const first = firstFile();
      if(first) ws.openFile(first.projectId, first.path, true);
      else { flushSilently(); emitFile(); }
    }
    save(); emit();
  };

  ws.renameProject = (id, name) => {
    const p = ws.project(id); if(!p || p.readonly) return;
    p.name = uniqueName(normPath(name).split("/").pop() || p.name);
    save(); emit();
  };

  // ---- files ----------------------------------------------------------------
  ws.fileList = (id) => {
    const p = ws.project(id); if(!p) return [];
    return [...p.files.keys()].sort();
  };
  ws.readFile = (id, path) => {
    const p = ws.project(id); if(!p) return null;
    const f = p.files.get(normPath(path)); return f ? f.content : null;
  };
  ws.writeFile = (id, path, content) => {
    const p = ws.project(id); if(!p) return;
    p.files.set(normPath(path), { content: String(content) });
    save(); emit();
  };
  ws.addFile = (id, path, content) => {
    const p = ws.project(id); if(!p) return null;
    const np = normPath(path);
    if(!np) return null;
    if(!p.files.has(np)) p.files.set(np, { content: content!=null ? String(content) : "" });
    save(); emit();
    return np;
  };
  ws.deleteFile = (id, path) => {
    const p = ws.project(id); if(!p || p.readonly) return;
    const np = normPath(path);
    p.files.delete(np);
    if(ws.activeRef && ws.activeRef.projectId === id && ws.activeRef.path === np){
      ws.activeRef = null;
      const first = firstFile();
      if(first) ws.openFile(first.projectId, first.path, true);
      else emitFile();
    }
    save(); emit();
  };
  ws.renameFile = (id, oldPath, newPath) => {
    const p = ws.project(id); if(!p || p.readonly) return;
    const o = normPath(oldPath), n = normPath(newPath);
    if(!p.files.has(o) || !n) return;
    const f = p.files.get(o); p.files.delete(o); p.files.set(n, f);
    if(ws.activeRef && ws.activeRef.projectId === id && ws.activeRef.path === o)
      ws.activeRef.path = n;
    save(); emit(); emitFile();
  };

  // Move a file to another folder and/or project. `dstPath` is the full new
  // relative path within the destination project. Returns true on success, false
  // if the source is missing, either end is read-only, or the destination path is
  // already taken. Keeps the active-file pointer following the moved file.
  ws.moveFile = (srcId, srcPath, dstId, dstPath) => {
    const sp = ws.project(srcId), dp = ws.project(dstId);
    if(!sp || !dp || sp.readonly || dp.readonly) return false;
    const o = normPath(srcPath), n = normPath(dstPath);
    if(!sp.files.has(o) || !n) return false;
    if(!(srcId === dstId && o === n) && dp.files.has(n)) return false;   // don't clobber
    const f = sp.files.get(o);
    sp.files.delete(o);
    dp.files.set(n, { content: f.content });
    dp.open = true;
    if(ws.activeRef && ws.activeRef.projectId === srcId && ws.activeRef.path === o)
      ws.activeRef = { projectId: dstId, path: n };
    save(); emit(); emitFile();
    return true;
  };

  function firstFile(){
    for(const p of ws.projects){
      if(!p.open) continue;
      const ks = [...p.files.keys()].sort();
      if(ks.length) return { projectId: p.id, path: ks[0] };
    }
    // any file, even in a closed project
    for(const p of ws.projects){
      const ks = [...p.files.keys()].sort();
      if(ks.length) return { projectId: p.id, path: ks[0] };
    }
    return null;
  }
  ws.firstFile = firstFile;

  // ---- active file <-> editor ----------------------------------------------
  // True once the editor has actually LOADED a file's content. Until then the
  // editor is the empty initial buffer and does NOT represent activeRef — so we
  // must never flush it back (that would wipe a just-restored file on boot).
  let editorLoaded = false;
  // Flush the editor's current text back into the active file (unless readonly).
  ws.flush = () => {
    if(!editorLoaded) return;
    if(!ws.activeRef) return;
    const p = ws.project(ws.activeRef.projectId); if(!p || p.readonly) return;
    const f = p.files.get(ws.activeRef.path); if(!f) return;
    if(!window.AowliEditor) return;
    const v = window.AowliEditor.getValue();
    if(f.content !== v){ f.content = v; save(); }
  };
  function flushSilently(){ /* placeholder for callers that just cleared active */ }

  ws.activeContent = () => {
    if(!ws.activeRef) return "";
    return ws.readFile(ws.activeRef.projectId, ws.activeRef.path) || "";
  };
  ws.activeAbsPath = () => ws.activeRef ? ws.absPath(ws.activeRef) : null;
  ws.activeReadonly = () => {
    if(!ws.activeRef) return false;
    const p = ws.project(ws.activeRef.projectId); return !!(p && p.readonly);
  };
  ws.activeLang = () => {
    if(!ws.activeRef) return "nimony";
    const path = ws.activeRef.path.toLowerCase();
    if(/\.(md|markdown)$/.test(path)) return "markdown";
    if(/\.(json)$/.test(path)) return "json";
    if(/\.(js|mjs)$/.test(path)) return "javascript";
    if(/\.(c|h)$/.test(path)) return "c";
    if(/\.(nif|aif)$/.test(path)) return "nif";
    if(/\.(txt|cfg|nims|nimble|cfg)$/.test(path)) return "plaintext";
    return "nimony";
  };
  // Only .nim / .aowl files go through the nimony pipeline (parse / sem / run).
  // Everything else (json, js, c, nif, …) just gets native syntax highlighting.
  // No active file (the fresh scratch buffer) counts as nim.
  ws.activeIsNim = () => !ws.activeRef || /\.(nim|aowl)$/i.test(ws.activeRef.path);

  // ---- share an ENTIRE workspace ------------------------------------------
  // Serialize every non-std project (std is re-mountable, so we skip its 1.5 MB)
  // to a plain object for the share link. Git projects keep their remote so the
  // recipient could re-clone, but we also ship their current files.
  ws.exportWorkspace = () => {
    const projects = [];
    for(const p of ws.projects){
      if(p.kind === "std") continue;
      const files = {};
      for(const [path, f] of p.files) files[path] = f.content;
      projects.push({ name:p.name, kind:p.kind || "user", remote:p.remote || null, files });
    }
    let active = null;
    if(ws.activeRef){ const ap = ws.project(ws.activeRef.projectId);
      if(ap && ap.kind !== "std") active = { name: ap.name, path: ws.activeRef.path }; }
    return { v:1, projects, active };
  };
  // Import a shared workspace: MERGE the shared projects in (renaming on a name
  // clash so nothing you already have is lost), then open the shared active file.
  ws.importWorkspace = (data) => {
    if(!data || !Array.isArray(data.projects) || !data.projects.length) return false;
    const taken = new Set(ws.projects.map(p => p.name));
    let toOpen = null, firstOpen = null;
    for(const pd of data.projects){
      let name = pd.name || "project";
      if(taken.has(name)){ let i=2; while(taken.has(name+" ("+i+")")) i++; name = name+" ("+i+")"; }
      taken.add(name);
      const files = pd.files || {};
      const p = ws.addProject({ name, kind: pd.kind==="git" ? "git" : "user",
        remote: pd.remote || undefined, open:true, files });
      const ks = Object.keys(files).sort();
      if(pd.name === (data.active && data.active.name) && files[normPath(data.active.path)] != null)
        toOpen = { id:p.id, path:data.active.path };
      if(!firstOpen && ks.length) firstOpen = { id:p.id, path:ks[0] };
    }
    const open = toOpen || firstOpen;
    if(open) ws.openFile(open.id, open.path, true);
    save(); emit();
    return true;
  };

  // Open a file into the editor. Flushes the previously-active buffer first.
  ws.openFile = (projectId, path, force) => {
    const np = normPath(path);
    if(!force && ws.activeRef && ws.activeRef.projectId === projectId && ws.activeRef.path === np) return;
    ws.flush();
    const p = ws.project(projectId); if(!p) return;
    if(!p.files.has(np)) return;
    ws.activeRef = { projectId, path: np };
    // ensure its project is marked open (so the tree shows it)
    p.open = true;
    if(window.AowliEditor){
      const readonly = !!p.readonly;
      window.AowliEditor.setValue(p.files.get(np).content);
      editorLoaded = true;   // the editor now holds a real file → flushing is safe
      if(window.AowliEditor.setReadOnly) window.AowliEditor.setReadOnly(readonly);
      if(window.AowliEditor.setLanguage) window.AowliEditor.setLanguage(ws.activeLang());
    }
    save(); emit(); emitFile();
  };

  // Resolve a virtual absolute path (/ws/<proj>/<rel>) or a project/rel pair and
  // open it — used by go-to-definition landing in std or another project.
  ws.openAbs = (absPath) => {
    const m = String(absPath).replace(/^\/+/,"").split("/");
    if(m[0] !== "ws") return false;
    const projName = m[1], rel = m.slice(2).join("/");
    const p = ws.projectByName(projName); if(!p) return false;
    if(!p.files.has(normPath(rel))) return false;
    ws.openFile(p.id, rel, true);
    return true;
  };

  // ---- module resolution surface (for the worker sem stage) -----------------
  // Every project root becomes a search path so imports resolve across projects.
  ws.searchPaths = () => ws.projects.filter(p=>p.open!==false).map(p => ROOT + "/" + p.name);
  // All source files as { absPath, content } for preloading into the worker vfs.
  ws.allSources = () => {
    const out = [];
    for(const p of ws.projects){
      for(const [path, f] of p.files){
        if(/\.(nim|aowl)$/.test(path)) out.push({ absPath: absPathOf(p, path), content: f.content });
      }
    }
    return out;
  };

  // ---- persistence ----------------------------------------------------------
  let saveTimer = null;
  function save(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 250);
  }
  ws.saveNow = () => { clearTimeout(saveTimer); doSave(); };
  function doSave(){
    try{
      const data = {
        v: 1,
        active: ws.activeRef,
        projects: ws.projects
          .filter(p => p.kind !== "std")   // std is remounted from asset
          .map(p => ({
            id: p.id, name: p.name, kind: p.kind, readonly: p.readonly,
            remote: p.remote, open: p.open,
            files: Object.fromEntries([...p.files].map(([k,v]) => [k, v.content])),
          })),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    }catch(_){}
  }
  function load(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return false;
      const data = JSON.parse(raw);
      if(!data || !Array.isArray(data.projects)) return false;
      for(const pd of data.projects){
        const proj = {
          id: pd.id || newId(), name: pd.name || "project", kind: pd.kind || "user",
          readonly: !!pd.readonly, remote: pd.remote || null, open: pd.open !== false,
          files: new Map(),
        };
        for(const [k,v] of Object.entries(pd.files || {})) proj.files.set(normPath(k), { content: String(v) });
        ws.projects.push(proj);
      }
      if(data.active && ws.project(data.active.projectId)) ws.activeRef = data.active;
      return ws.projects.length > 0;
    }catch(_){ return false; }
  }
  ws.load = load;

  window.AowliWorkspace = ws;
})();
