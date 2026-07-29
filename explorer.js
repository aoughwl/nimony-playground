// explorer.js — the VS Code-style file explorer, living in a movable WinKit
// window. Renders the workspace (workspace.js) as collapsible project roots with
// nested folders/files; drives open/new/rename/delete and the "Clone git repo"
// and "New project" flows. Also owns the file-tab strip above the editor.
(function(){
  const CSS = `
  .fx-tools{display:flex;align-items:center;gap:2px;padding:5px 7px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);z-index:2}
  .fx-tools .sp{flex:1}
  .fx-tbtn{width:26px;height:26px;border:0;background:transparent;color:var(--muted);border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  .fx-tbtn:hover{background:var(--panel2);color:var(--fg)}
  .fx-tbtn svg{width:15px;height:15px}
  .fx-tree{padding:4px 0 10px}
  .fx-row{display:flex;align-items:center;gap:5px;padding:2px 8px 2px 6px;cursor:pointer;white-space:nowrap;font-size:12.5px;color:var(--fg);border-radius:0;position:relative}
  .fx-row:hover{background:var(--panel2)}
  .fx-row.active{background:var(--brace-bg);color:var(--fg)}
  .fx-row.active::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent)}
  .fx-row.selected{background:color-mix(in srgb,var(--accent) 22%,transparent)}
  .fx-row.selected:hover{background:color-mix(in srgb,var(--accent) 30%,transparent)}
  .fx-row.drop-target{outline:1.5px dashed var(--accent);outline-offset:-2px;background:color-mix(in srgb,var(--accent) 14%,transparent)}
  .fx-tw{width:14px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--muted)}
  .fx-tw svg{width:10px;height:10px;transition:transform .12s}
  .fx-row.collapsed .fx-tw svg{transform:rotate(-90deg)}
  .fx-ic{width:15px;flex:none;display:inline-flex;align-items:center;justify-content:center;opacity:.85}
  .fx-ic svg{width:13px;height:13px}
  .fx-nm{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
  .fx-proj{font-weight:650;text-transform:none;font-size:12px;letter-spacing:.01em}
  .fx-proj .fx-nm{color:var(--fg)}
  .fx-badge{font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:999px;flex:none;
    background:var(--panel2);color:var(--muted);border:1px solid var(--border)}
  .fx-badge.git{color:var(--accent);border-color:var(--accent)}
  .fx-badge.std{color:var(--accent2);border-color:var(--accent2)}
  .fx-kebab{opacity:0;width:20px;height:20px;border:0;background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center}
  .fx-row:hover .fx-kebab{opacity:.8}
  .fx-kebab:hover{background:var(--border);opacity:1}
  .fx-kebab svg{width:13px;height:13px}
  .fx-empty{padding:18px 14px;color:var(--muted);font-size:12px;line-height:1.6}
  .fx-empty b{color:var(--fg);font-weight:600}
  /* file tabs above the editor: a scrollable tab region + a fixed action cluster
     (Explorer / Debugger toggles) pinned to the right of the row. */
  #fileTabs{display:flex;align-items:stretch;background:var(--panel);border-bottom:1px solid var(--border);min-height:32px}
  #fileTabs .ft-scroll{display:flex;align-items:stretch;overflow-x:auto;flex:1;min-width:0;scrollbar-width:thin}
  #fileTabs .ft-actions{display:flex;align-items:stretch;flex:none;border-left:1px solid var(--border)}
  #fileTabs .ft-actions button{width:34px;border:0;background:transparent;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  #fileTabs .ft-actions button:hover{background:var(--panel2);color:var(--fg)}
  #fileTabs .ft-actions button.on{color:var(--accent);background:var(--panel2)}
  #fileTabs .ft-actions button svg{width:15px;height:15px}
  .ft{display:inline-flex;align-items:center;gap:5px;padding:0 8px 0 12px;border-right:1px solid var(--border);
    background:transparent;color:var(--muted);cursor:pointer;white-space:nowrap;flex:none;max-width:240px}
  .ft:hover{background:var(--panel2)}
  .ft.active{background:var(--bg);color:var(--fg)}
  .ft .ft-lbl{display:inline-flex;align-items:baseline;gap:1px;min-width:0;overflow:hidden}
  .ft .ft-nm{overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:500}
  .ft .ft-ext{font-size:10.5px;opacity:.6;margin-right:2px}
  .ft.pv .ft-nm,.ft.pv .ft-ext{font-style:italic}   /* preview tab (VSCode-style) */
  .ft.ro .ft-nm::after{content:" ·ro";color:var(--muted);font-size:10px;opacity:.7}
  .ft .ft-x{align-self:center}
  .ft .ft-x{width:16px;height:16px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;opacity:.55}
  .ft .ft-x:hover{background:var(--border);opacity:1}
  .ft .ft-x svg{width:9px;height:9px}
  .ft .ft-dot{width:7px;height:7px;border-radius:50%;background:var(--accent2)}
  /* clone / new dialog */
  .fx-modal{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
  .fx-modal.show{display:flex}
  .fx-dlg{background:var(--panel);border:1px solid var(--border);border-radius:11px;width:min(460px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden}
  .fx-dlg h3{margin:0;padding:15px 18px 4px;font-size:14px}
  .fx-dlg p{margin:0;padding:0 18px 12px;color:var(--muted);font-size:12px;line-height:1.55}
  .fx-dlg .fx-field{padding:0 18px 12px}
  .fx-dlg input[type=text]{width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--fg);font:13px var(--mono)}
  .fx-dlg input:focus{outline:none;border-color:var(--accent)}
  .fx-dlg .fx-dlgact{display:flex;justify-content:flex-end;gap:8px;padding:10px 18px 16px}
  .fx-dlg button{padding:8px 15px;border-radius:7px;border:1px solid var(--border);background:var(--panel2);color:var(--fg);cursor:pointer;font:inherit;font-size:13px}
  .fx-dlg button.primary{background:var(--accent);border-color:var(--accent);color:#08131f;font-weight:600}
  .fx-dlg button.primary.danger{background:var(--err);border-color:var(--err);color:#fff}
  .fx-dlg button:disabled{opacity:.5;cursor:progress}
  .fx-dlgmsg{padding:0 18px;color:var(--muted);font-size:12px;min-height:16px}
  .fx-dlgmsg.err{color:var(--err)}
  .fx-choices{display:flex;flex-direction:column;gap:3px;padding:2px 12px 10px;max-height:46vh;overflow:auto}
  .fx-choice{text-align:left;padding:8px 11px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--fg);
    cursor:pointer;font:12.5px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fx-choice:hover{border-color:var(--accent);background:var(--panel2)}`;

  const ws = () => window.AowliWorkspace;
  const $ = s => document.querySelector(s);
  let winApi = null, treeEl = null, tabsEl = null;
  // VSCode-style PREVIEW tab: a single-click in the tree opens the file in one
  // reusable, italicised tab that the next preview replaces. Double-clicking (or
  // editing) promotes it to a permanent tab. `pendingPreview` tells tabState.touch
  // whether the in-flight openFile should land as a preview.
  let pendingPreview = false;
  function openFilePreview(projId, path, preview){ pendingPreview = !!preview; ws().openFile(projId, path, false); pendingPreview = false; }

  // ---- little SVG icons -----------------------------------------------------
  const ICON = {
    chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 4.4c0-.6.4-1 1-1h3l1.4 1.4h5c.6 0 1 .4 1 1v5.4c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2.2h5l3 3v8.6c0 .3-.2.5-.5.5H4c-.3 0-.5-.2-.5-.5V2.7c0-.3.2-.5.5-.5z"/><path d="M9 2.4V5.3h2.9"/></svg>',
    nim: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.3l5 9.4H3z" fill="currentColor" opacity=".85"/></svg>',
    kebab: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.4" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="12.6" r="1.3"/></svg>',
    newfile: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 2.2h4.5L12 5.7v8c0 .3-.2.5-.5.5H4c-.3 0-.5-.2-.5-.5V2.7c0-.3.2-.5.5-.5z"/><path d="M8.4 2.4V5.4h3"/><path d="M7 9v3M5.5 10.5h3"/></svg>',
    newproj: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M1.8 4.4c0-.6.4-1 1-1h3l1.4 1.4h5c.6 0 1 .4 1 1V8"/><path d="M12 10v4M10 12h4"/><path d="M1.8 6v6.2c0 .6.4 1 1 1H8"/></svg>',
    git: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="4" r="1.8"/><circle cx="4" cy="12" r="1.8"/><circle cx="12" cy="6.5" r="1.8"/><path d="M4 5.8v4.4"/><path d="M5.6 5.2C7 6 8 6.4 10.3 6.5"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2v3h-3"/></svg>',
    fx: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 4c0-.6.4-1 1-1h3l1.4 1.4h5c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"/></svg>',
  };
  function fileIcon(name){ return /\.(nim|aowl)$/.test(name) ? ICON.nim : ICON.file; }

  // ---- collapse state (project + folder) ------------------------------------
  const collapsed = new Set();
  const collapseTouched = new Set();   // projects whose default-collapse we've already applied once
  try{ (JSON.parse(localStorage.getItem("np-fx-collapsed")||"[]")).forEach(k=>collapsed.add(k)); }catch(_){}
  function saveCollapse(){ try{ localStorage.setItem("np-fx-collapsed", JSON.stringify([...collapsed])); }catch(_){} }
  function toggleCollapse(key){ collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); saveCollapse(); render(); }

  // ---- multi-selection (ctrl/cmd-click to add, shift-click to range) ---------
  // Selection can hold files, folders and projects. Keys use \0 separators so
  // they never collide with a path that contains a colon.
  const NUL = "\u0000";
  const selection = new Set();
  const fSel = (proj,path) => "F"+NUL+proj+NUL+path;
  const dSel = (proj,dir)  => "D"+NUL+proj+NUL+dir;
  const pSel = (proj)      => "P"+NUL+proj;
  let anchor = null;   // {projId, path} for shift-range file selection
  function toggleSel(key){ selection.has(key) ? selection.delete(key) : selection.add(key); }
  function clearSel(){ selection.clear(); anchor = null; }
  // Resolve the selection into concrete, mutable (non-readonly) items.
  function selectionItems(){
    const out = [];
    for(const k of selection){
      const [type, projId, rest] = k.split(NUL);
      const p = ws().project(projId); if(!p) continue;
      if(type === "P"){ out.push({ type:"P", projId }); continue; }
      if(p.readonly) continue;               // can't mutate std / read-only trees
      if(type === "D") out.push({ type:"D", projId, dir: rest });
      else if(p.files.has(rest)) out.push({ type:"F", projId, path: rest });
    }
    return out;
  }
  // Just the files implied by the selection (folders expand to their files).
  function selectedFiles(){
    const seen = new Set(), out = [];
    for(const it of selectionItems()){
      if(it.type === "F"){ const key=it.projId+NUL+it.path; if(!seen.has(key)){ seen.add(key); out.push({projId:it.projId, path:it.path}); } }
      else if(it.type === "D"){
        for(const path of ws().fileList(it.projId))
          if(path===it.dir || path.startsWith(it.dir+"/")){ const key=it.projId+NUL+path; if(!seen.has(key)){ seen.add(key); out.push({projId:it.projId, path}); } }
      }
    }
    return out;
  }
  // Plain / ctrl / shift click semantics for a FILE row. Returns true if the
  // gesture was a selection gesture (caller should NOT also open the file).
  function fileClickSelect(e, proj, path){
    const key = fSel(proj.id, path);
    if(e && (e.metaKey || e.ctrlKey)){ toggleSel(key); anchor = {projId:proj.id, path}; render(); return true; }
    if(e && e.shiftKey && anchor && anchor.projId === proj.id){
      const files = ws().fileList(proj.id);
      const a = files.indexOf(anchor.path), b = files.indexOf(path);
      if(a >= 0 && b >= 0){ const lo=Math.min(a,b), hi=Math.max(a,b);
        for(let i=lo;i<=hi;i++) selection.add(fSel(proj.id, files[i]));
        render(); return true; }
    }
    // plain click → single-select + open
    clearSel(); selection.add(key); anchor = {projId:proj.id, path};
    return false;
  }
  // ctrl/cmd-click on a project/folder row toggles its selection instead of
  // collapsing. Returns true if it consumed the click.
  function rowCtrlSelect(e, key){ if(e && (e.metaKey || e.ctrlKey)){ toggleSel(key); render(); return true; } return false; }

  // ---- build the folder tree for one project --------------------------------
  function buildTree(paths){
    const root = { dirs:new Map(), files:[] };
    for(const path of paths){
      const parts = path.split("/");
      let node = root;
      for(let i=0;i<parts.length-1;i++){
        const d = parts[i];
        if(!node.dirs.has(d)) node.dirs.set(d, { dirs:new Map(), files:[] });
        node = node.dirs.get(d);
      }
      node.files.push({ name: parts[parts.length-1], path });
    }
    return root;
  }

  // ---- render ---------------------------------------------------------------
  function render(){
    if(!treeEl) return;
    const W = ws();
    treeEl.innerHTML = "";
    if(!W.projects.length){
      treeEl.innerHTML = '<div class="fx-empty"><b>No files yet.</b><br>Use <b>+file</b> for a scratch file, ' +
        '<b>+project</b> for a folder, or <b>clone</b> a git repo. The std library appears here as a read-only project.</div>';
      renderTabs(); return;
    }
    for(const proj of W.projects){
      const pkey = "P:" + proj.id;
      // Big read-only trees (std, freshly-cloned repos) start COLLAPSED so mounting
      // them doesn't render hundreds of rows (a source of the add-project freeze).
      if(proj.kind === "std" && !collapseTouched.has(pkey)){ collapsed.add(pkey); collapseTouched.add(pkey); }
      const pcol = collapsed.has(pkey);
      const psel = pSel(proj.id);
      const prow = row({
        cls: "fx-proj" + (pcol ? " collapsed" : "") + (selection.has(psel) ? " selected" : ""),
        twist: true, indent: 0,
        icon: proj.kind==="git" ? ICON.git : ICON.folder,
        name: proj.name,
        badge: proj.kind==="git" ? {t:"git",c:"git"} : (proj.kind==="std" ? {t:"std",c:"std"} : null),
        onTwist: ()=>toggleCollapse(pkey),
        onClick: (e)=>{ if(rowCtrlSelect(e, psel)) return; toggleCollapse(pkey); },
        onContext: (e)=>rowContext(e, psel, ()=>projMenu(proj)),
        kebab: projMenu(proj),
        dropInto: proj.readonly ? null : { projId: proj.id, dir: "" },   // drop files at project root
      });
      treeEl.appendChild(prow);
      if(pcol) continue;
      const tree = buildTree(W.fileList(proj.id));
      renderNode(proj, tree, 1, "");
    }
    renderTabs();
  }

  function renderNode(proj, node, depth, prefix){
    // folders first (sorted), then files
    const dirNames = [...node.dirs.keys()].sort();
    for(const d of dirNames){
      const fpath = prefix + d;
      const fkey = "D:" + proj.id + ":" + fpath;
      const dsel = dSel(proj.id, fpath);
      const col = collapsed.has(fkey);
      treeEl.appendChild(row({
        cls: "fx-dir" + (col ? " collapsed" : "") + (selection.has(dsel) ? " selected" : ""), twist:true, indent:depth,
        icon: ICON.folder, name: d,
        onTwist: ()=>toggleCollapse(fkey),
        onClick: (e)=>{ if(rowCtrlSelect(e, dsel)) return; toggleCollapse(fkey); },
        onContext: proj.readonly ? null : (e)=>rowContext(e, dsel, ()=>folderMenu(proj, fpath)),
        dropInto: proj.readonly ? null : { projId: proj.id, dir: fpath },
      }));
      if(!col) renderNode(proj, node.dirs.get(d), depth+1, fpath + "/");
    }
    for(const f of node.files.sort((a,b)=>a.name.localeCompare(b.name))){
      const active = W_active(proj.id, f.path);
      const sel = selection.has(fSel(proj.id, f.path));
      treeEl.appendChild(row({
        cls: "fx-file" + (active ? " active" : "") + (sel ? " selected" : ""), twist:false, indent:depth,
        icon: fileIcon(f.name), name: f.name,
        onClick: (e)=>{ if(fileClickSelect(e, proj, f.path)) return; openFilePreview(proj.id, f.path, true); },
        onDbl: ()=>{ pendingPreview=false; ws().openFile(proj.id, f.path, true); },   // promote to permanent
        onContext: proj.readonly ? null : (e)=>rowContext(e, fSel(proj.id, f.path), ()=>fileMenu(proj, f.path)),
        kebab: proj.readonly ? null : fileMenu(proj, f.path),
        drag: proj.readonly ? null : { projId: proj.id, path: f.path },
      }));
    }
  }
  function W_active(pid, path){ const a = ws().activeRef; return a && a.projectId===pid && a.path===path; }

  function row(o){
    const el = document.createElement("div");
    el.className = "fx-row " + (o.cls||"");
    el.style.paddingLeft = (6 + (o.indent||0)*13) + "px";
    let html = '<span class="fx-tw">' + (o.twist ? ICON.chevron : "") + '</span>';
    html += '<span class="fx-ic">' + (o.icon||"") + '</span>';
    html += '<span class="fx-nm">' + esc(o.name) + '</span>';
    if(o.badge) html += '<span class="fx-badge '+o.badge.c+'">'+o.badge.t+'</span>';
    if(o.kebab) html += '<button class="fx-kebab">' + ICON.kebab + '</button>';
    el.innerHTML = html;
    const tw = el.querySelector(".fx-tw");
    if(o.onTwist) tw.addEventListener("click", e=>{ e.stopPropagation(); o.onTwist(); });
    if(o.onClick) el.addEventListener("click", o.onClick);
    if(o.onDbl) el.addEventListener("dblclick", o.onDbl);
    // Right-click menu is handled by ONE delegated listener on the tree (see boot),
    // so it can't be lost when a row is re-rendered mid-interaction. Store the row's
    // menu opener on the element for that delegate to find.
    if(o.onContext) el.__onContext = o.onContext;
    if(o.kebab){
      const kb = el.querySelector(".fx-kebab");
      kb.addEventListener("click", e=>{ e.stopPropagation(); openMenu(e.currentTarget, o.kebab); });
    }
    // ---- drag a file (or the whole selection) onto a folder/project to move it
    if(o.drag){
      el.draggable = true;
      el.addEventListener("dragstart", e=>{
        // if the dragged file isn't part of the current selection, make it the
        // sole selection so a plain drag moves just that file.
        if(!selection.has(fSel(o.drag.projId, o.drag.path))){ clearSel(); selection.add(fSel(o.drag.projId, o.drag.path)); render(); }
        dragging = selectedFiles();
        try{ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", o.drag.path); }catch(_){}
      });
      el.addEventListener("dragend", ()=>{ dragging = null; clearDropMarks(); });
    }
    if(o.dropInto){
      el.addEventListener("dragover", e=>{ if(!dragging) return; e.preventDefault(); try{ e.dataTransfer.dropEffect="move"; }catch(_){} el.classList.add("drop-target"); });
      el.addEventListener("dragleave", ()=>el.classList.remove("drop-target"));
      el.addEventListener("drop", e=>{ e.preventDefault(); el.classList.remove("drop-target");
        const files = dragging; dragging = null; if(files && files.length) moveFilesTo(files, o.dropInto); });
    }
    return el;
  }
  let dragging = null;
  function clearDropMarks(){ if(treeEl) treeEl.querySelectorAll(".drop-target").forEach(el=>el.classList.remove("drop-target")); }
  function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  // ---- context menu ---------------------------------------------------------
  let menuEl = null;
  function buildMenu(items){
    menuEl = document.createElement("div");
    menuEl.id = "fx-menu";
    Object.assign(menuEl.style, { position:"fixed", zIndex:300, minWidth:"160px",
      background:"var(--panel)", border:"1px solid var(--border)", borderRadius:"8px",
      boxShadow:"0 10px 30px rgba(0,0,0,.4)", padding:"5px", font:"12.5px sans-serif" });
    for(const it of items){
      if(it.sep){ const s=document.createElement("div"); s.style.cssText="height:1px;background:var(--border);margin:4px 2px"; menuEl.appendChild(s); continue; }
      const d = document.createElement("div");
      d.textContent = it.label;
      d.style.cssText = "padding:6px 10px;border-radius:5px;cursor:pointer;white-space:nowrap;color:"+(it.danger?"var(--err)":"var(--fg)");
      d.addEventListener("mouseenter", ()=>d.style.background="var(--panel2)");
      d.addEventListener("mouseleave", ()=>d.style.background="transparent");
      d.addEventListener("click", ()=>{ closeMenu(); try{ it.act(); }catch(_){} });
      menuEl.appendChild(d);
    }
    document.body.appendChild(menuEl);
  }
  function place(left, top){
    if(left + menuEl.offsetWidth > innerWidth) left = innerWidth - menuEl.offsetWidth - 6;
    if(top + menuEl.offsetHeight > innerHeight) top = innerHeight - menuEl.offsetHeight - 6;
    menuEl.style.left = Math.max(6,left) + "px"; menuEl.style.top = Math.max(6,top) + "px";
  }
  function openMenu(anchor, items){   // anchored under an element (the kebab button)
    closeMenu(); buildMenu(items);
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 3; if(top + menuEl.offsetHeight > innerHeight) top = r.top - menuEl.offsetHeight - 3;
    place(r.right - menuEl.offsetWidth, top);
  }
  function openMenuXY(x, y, items){   // at a cursor point (right-click)
    closeMenu(); buildMenu(items); place(x, y);
  }
  function closeMenu(){ if(menuEl){ menuEl.remove(); menuEl=null; } }
  document.addEventListener("mousedown", e=>{ if(menuEl && !e.target.closest("#fx-menu")) closeMenu(); }, true);
  window.addEventListener("resize", closeMenu);

  // Track whether the explorer tree is the "active zone" so the Delete key only
  // fires there (never while typing in the editor or a dialog). Clicking empty
  // space in the tree clears the selection.
  let fxFocused = false;
  document.addEventListener("mousedown", e=>{
    fxFocused = !!(e.target.closest && e.target.closest(".fx-tree"));
    if(fxFocused && e.target.closest && e.target.classList && e.target.classList.contains("fx-tree") && selection.size){ clearSel(); render(); }
  }, true);
  document.addEventListener("keydown", e=>{
    if(e.key!=="Delete" && e.key!=="Backspace") return;
    if(!fxFocused || !selection.size) return;
    const t = e.target;
    if(t && (t.tagName==="INPUT" || t.tagName==="TEXTAREA" || t.isContentEditable || (t.closest && t.closest(".monaco-editor")))) return;
    e.preventDefault(); bulkDelete();
  });

  // Right-click on a row: if the row is part of a multi-item selection show the
  // BULK menu; otherwise make it the sole selection and show its own menu.
  function rowContext(e, selfKey, ownMenu){
    // Update selection, then OPEN THE MENU FIRST — before any re-render — so a
    // render glitch can never swallow the menu.
    const wasSelected = selection.has(selfKey);
    if(!wasSelected){ clearSel(); selection.add(selfKey); }
    const items = selectionItems();
    const menu = items.length > 1 ? bulkMenu() : ownMenu();
    openMenuXY(e.clientX, e.clientY, menu);
    if(!wasSelected){ try{ render(); }catch(_){} }
  }
  // Menu shown when several items are selected.
  function bulkMenu(){
    const items = selectionItems(), files = selectedFiles();
    const out = [];
    if(files.length) out.push({ label:"Move "+files.length+" file"+(files.length>1?"s":"")+" to…", act:()=>movePicker(files) });
    if(out.length) out.push({ sep:true });
    out.push({ label:"Delete "+items.length+" selected item"+(items.length>1?"s":""), danger:true, act:bulkDelete });
    return out;
  }
  async function bulkDelete(){
    const items = selectionItems(); if(!items.length) return;
    if(!(await uiConfirm("Delete "+items.length+" selected item"+(items.length>1?"s":"")+"?",
        { note:"Selected files, folders and projects are removed. This can't be undone.", ok:"Delete", danger:true }))) return;
    for(const it of items){
      if(it.type === "P") ws().removeProject(it.projId);
      else if(it.type === "D"){ for(const path of ws().fileList(it.projId)) if(path===it.dir || path.startsWith(it.dir+"/")) ws().deleteFile(it.projId, path); }
      else ws().deleteFile(it.projId, it.path);
    }
    clearSel(); render();
  }
  // Move a set of {projId,path} files into a destination { projId, dir }.
  function moveFilesTo(files, dest){
    let moved=0, clash=0;
    for(const it of files){
      const base = it.path.split("/").pop();
      const np = dest.dir ? dest.dir + "/" + base : base;
      if(it.projId===dest.projId && it.path===np) continue;   // already there
      if(ws().moveFile(it.projId, it.path, dest.projId, np)) moved++; else clash++;
    }
    clearSel(); render();
    if(clash) uiConfirm(clash+" file"+(clash>1?"s":"")+" couldn't be moved", { note:"A file with the same name already exists at the destination.", ok:"OK" });
  }
  // A picker listing every folder (and project root) you can move files into.
  async function movePicker(files){
    const dests = [], labels = [];
    for(const p of ws().projects){
      if(p.readonly) continue;
      dests.push({ projId:p.id, dir:"" }); labels.push(p.name + "/");
      const seen = new Set();
      for(const path of ws().fileList(p.id)){
        const parts = path.split("/"); let cur = "";
        for(let i=0;i<parts.length-1;i++){ cur = cur ? cur+"/"+parts[i] : parts[i];
          if(!seen.has(cur)){ seen.add(cur); dests.push({ projId:p.id, dir:cur }); labels.push(p.name + "/" + cur + "/"); } }
      }
    }
    if(!dests.length){ return; }
    const i = await uiChoose("Move "+files.length+" file"+(files.length>1?"s":"")+" to…", labels);
    if(i==null) return;
    moveFilesTo(files, dests[i]);
  }

  function projMenu(proj){
    const items = [
      { label:"New file…", act:()=>promptNewFile(proj.id) },
    ];
    if(!proj.readonly){
      items.push({ label:"Rename project…", act:()=>promptRename("project", ()=>proj.name, n=>ws().renameProject(proj.id, n)) });
    }
    if(proj.remote) items.push({ label:"Re-clone (pull latest)", act:()=>window.AowliGit && window.AowliGit.recloneInto(proj) });
    if(proj.remote && window.AowliGit && window.AowliGit.cloneLinkFor){
      items.push({ label:"Copy clone link", act:async ()=>{ const url = window.AowliGit.cloneLinkFor(proj);
        if(!url){ return; }
        try{ if(navigator.clipboard) await navigator.clipboard.writeText(url); else await uiPrompt("Clone link", { value:url, ok:"Close" }); }catch(_){ await uiPrompt("Clone link", { value:url, ok:"Close" }); } } });
    }
    items.push({ sep:true });
    items.push({ label: proj.kind==="std" ? "Unmount std" : "Remove project", danger:true,
                 act:async ()=>{ if(await uiConfirm('Remove project "'+proj.name+'"?', {note:"Unsaved files in this project are lost.", ok:"Remove", danger:true})) ws().removeProject(proj.id); } });
    return items;
  }
  function fileMenu(proj, path){
    return [
      { label:"Open", act:()=>ws().openFile(proj.id, path, true) },
      { label:"Rename…", act:()=>promptRename("file", ()=>path, n=>ws().renameFile(proj.id, path, n)) },
      { label:"Move to…", act:()=>movePicker([{projId:proj.id, path}]) },
      { label:"Duplicate", act:()=>{ const base=path.replace(/(\.[^.]+)?$/, "-copy$1"); const np=ws().addFile(proj.id, base, ws().readFile(proj.id,path)); if(np) ws().openFile(proj.id, np, true); } },
      { sep:true },
      { label:"Delete", danger:true, act:async ()=>{ if(await uiConfirm('Delete "'+path+'"?', {ok:"Delete", danger:true})) ws().deleteFile(proj.id, path); } },
    ];
  }
  function folderMenu(proj, dir){
    const filesUnder = ()=> ws().fileList(proj.id).filter(p=>p===dir || p.startsWith(dir+"/"));
    return [
      { label:"New file here…", act:()=>promptNewFile(proj.id, dir) },
      { label:"Rename folder…", act:async ()=>{
          const nn = await uiPrompt("Rename folder", { value:dir, ok:"Rename" });
          if(!nn || nn===dir) return;
          for(const p of filesUnder()){ const rest = p.slice(dir.length); ws().renameFile(proj.id, p, nn + rest); }
        } },
      { label:"Move contents to…", act:()=>movePicker(filesUnder().map(p=>({projId:proj.id, path:p}))) },
      { sep:true },
      { label:"Delete folder", danger:true, act:async ()=>{
          const n = filesUnder().length;
          if(await uiConfirm('Delete folder "'+dir+'"?', { note:n+" file"+(n===1?"":"s")+" inside will be removed. This can't be undone.", ok:"Delete", danger:true }))
            for(const p of filesUnder()) ws().deleteFile(proj.id, p);
        } },
    ];
  }

  // ---- styled modal (replaces the browser prompt()/confirm() dialogs) --------
  let uiModal = null;
  function ensureUiModal(){
    if(uiModal) return uiModal;
    uiModal = document.createElement("div");
    uiModal.className = "fx-modal";
    document.body.appendChild(uiModal);
    uiModal.addEventListener("mousedown", e=>{ if(e.target===uiModal) closeUi(null); });
    return uiModal;
  }
  let uiResolve = null;
  function closeUi(val){ if(uiModal) uiModal.classList.remove("show"); const r=uiResolve; uiResolve=null; if(r) r(val); }
  function uiPrompt(title, opts){
    opts = opts || {};
    ensureUiModal();
    uiModal.innerHTML =
      '<div class="fx-dlg"><h3>'+esc(title)+'</h3>' +
      (opts.note ? '<p>'+esc(opts.note)+'</p>' : '') +
      '<div class="fx-field"><input type="text" id="ui-in" spellcheck="false" autocomplete="off"></div>' +
      '<div class="fx-dlgact"><button id="ui-cancel">Cancel</button><button id="ui-ok" class="primary">'+esc(opts.ok||"OK")+'</button></div></div>';
    const inp = uiModal.querySelector("#ui-in");
    inp.value = opts.value || ""; inp.placeholder = opts.placeholder || "";
    uiModal.classList.add("show");
    setTimeout(()=>{ inp.focus(); inp.select(); }, 40);
    const done = ()=>{ const v=inp.value.trim(); closeUi(v||null); };
    uiModal.querySelector("#ui-ok").onclick = done;
    uiModal.querySelector("#ui-cancel").onclick = ()=>closeUi(null);
    inp.onkeydown = e=>{ if(e.key==="Enter") done(); if(e.key==="Escape") closeUi(null); };
    return new Promise(res=>{ uiResolve = res; });
  }
  function uiConfirm(title, opts){
    opts = opts || {};
    ensureUiModal();
    uiModal.innerHTML =
      '<div class="fx-dlg"><h3>'+esc(title)+'</h3>' +
      (opts.note ? '<p>'+esc(opts.note)+'</p>' : '') +
      '<div class="fx-dlgact"><button id="ui-cancel">Cancel</button><button id="ui-ok" class="primary'+(opts.danger?" danger":"")+'">'+esc(opts.ok||"Confirm")+'</button></div></div>';
    uiModal.classList.add("show");
    setTimeout(()=>{ const b=uiModal.querySelector("#ui-ok"); if(b) b.focus(); }, 40);
    uiModal.querySelector("#ui-ok").onclick = ()=>closeUi(true);
    uiModal.querySelector("#ui-cancel").onclick = ()=>closeUi(false);
    return new Promise(res=>{ uiResolve = res; });
  }
  // A single-choice picker (styled list of options). Resolves the chosen index,
  // or null if dismissed. Used by "Move to…".
  function uiChoose(title, options){
    ensureUiModal();
    const rows = options.map((o,i)=>'<button class="fx-choice" data-i="'+i+'">'+esc(o)+'</button>').join("");
    uiModal.innerHTML =
      '<div class="fx-dlg"><h3>'+esc(title)+'</h3>' +
      '<div class="fx-choices">'+rows+'</div>' +
      '<div class="fx-dlgact"><button id="ui-cancel">Cancel</button></div></div>';
    uiModal.classList.add("show");
    uiModal.querySelectorAll(".fx-choice").forEach(b=> b.onclick = ()=>closeUi(+b.getAttribute("data-i")));
    uiModal.querySelector("#ui-cancel").onclick = ()=>closeUi(null);
    return new Promise(res=>{ uiResolve = res; });
  }
  window.AowliUi = { prompt: uiPrompt, confirm: uiConfirm, choose: uiChoose };

  // ---- prompts / dialogs ----------------------------------------------------
  async function promptNewFile(projectId, dir){
    const seed = dir ? dir + "/new.nim" : "new.nim";
    const path = await uiPrompt("New file", { value:seed, placeholder:"e.g. src/utils.nim", ok:"Create" });
    if(!path) return;
    const np = ws().addFile(projectId, path, defaultFileBody(path));
    if(np) ws().openFile(projectId, np, true);
  }
  function defaultFileBody(path){
    if(/\.(nim|aowl)$/.test(path)){
      const mod = path.split("/").pop().replace(/\.(nim|aowl)$/,"");
      return "## " + mod + "\n\n";
    }
    return "";
  }
  async function promptRename(kind, get, set){
    const cur = get();
    const n = await uiPrompt("Rename " + kind, { value:cur, ok:"Rename" });
    if(n && n !== cur) set(n);
  }
  window.AowliExplorer = { render, promptNewFile,
    async newProject(){ const name = await uiPrompt("New project", { value:"project", placeholder:"project name", ok:"Create" });
      if(name){ const p = ws().addProject({ name, kind:"user", files:{ "main.nim": 'echo "hello from ' + name + '"\n' } }); ws().openFile(p.id, "main.nim", true); } },
  };

  // ---- file tabs above the editor ------------------------------------------
  function renderTabs(){
    if(!tabsEl) return;
    const W = ws();
    // collect open files: just the active one plus a small MRU we track
    const tabs = tabState.list();
    tabsEl.innerHTML = "";
    for(const t of tabs){
      const proj = W.project(t.projectId); if(!proj || !proj.files.has(t.path)){ tabState.close(t); continue; }
      const active = W.activeRef && W.activeRef.projectId===t.projectId && W.activeRef.path===t.path;
      const el = document.createElement("div");
      el.className = "ft" + (active?" active":"") + (proj.readonly?" ro":"") + (t.preview?" pv":"");
      // filename in a larger font, its extension smaller alongside
      const base = t.path.split("/").pop();
      const dot = base.lastIndexOf(".");
      const nm = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      el.innerHTML = '<span class="ft-lbl"><span class="ft-nm">'+esc(nm)+'</span>' + (ext?'<span class="ft-ext">'+esc(ext)+'</span>':'') + '</span>' +
        '<span class="ft-x"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></span>';
      el.title = proj.name + "/" + t.path + (t.preview ? "  (preview — double-click to keep open)" : "");
      // drag a tab to an editor edge to split (see split.js)
      el.draggable = true;
      el.addEventListener("dragstart", e=>{ window.__npTabDrag = { projectId:t.projectId, path:t.path };
        try{ e.dataTransfer.effectAllowed="copy"; e.dataTransfer.setData("application/x-np-tab", t.path); }catch(_){} });
      el.addEventListener("dragend", ()=>{ window.__npTabDrag = null; });
      // single-click activates but PRESERVES the tab's preview status; double-click promotes.
      el.addEventListener("click", e=>{ if(e.target.closest(".ft-x")){ tabState.close(t); return; } pendingPreview = !!t.preview; W.openFile(t.projectId, t.path, false); pendingPreview = false; });
      el.addEventListener("dblclick", ()=>{ pendingPreview=false; W.openFile(t.projectId, t.path, true); });
      // middle-click anywhere on the tab closes it
      el.addEventListener("auxclick", e=>{ if(e.button===1){ e.preventDefault(); tabState.close(t); } });
      el.addEventListener("pointerdown", e=>{ if(e.button===1) e.preventDefault(); });  // suppress autoscroll
      tabsEl.appendChild(el);
    }
  }

  // small open-tab tracker (MRU of files the user has opened)
  const tabState = (function(){
    let list = [];
    try{ list = JSON.parse(localStorage.getItem("np-fx-tabs")||"[]"); }catch(_){}
    function save(){ try{ localStorage.setItem("np-fx-tabs", JSON.stringify(list)); }catch(_){} }
    return {
      list(){ return list.slice(); },
      // Add a newly-opened file to the END, but NEVER move an already-open tab —
      // clicking a tab must not re-order the strip. `pendingPreview` (module var)
      // decides whether a NEW tab lands as the single reusable preview tab.
      touch(ref){
        const existing = list.find(t=>t.projectId===ref.projectId&&t.path===ref.path);
        if(existing){ if(!pendingPreview && existing.preview){ delete existing.preview; save(); } return; }
        if(pendingPreview){
          // replace the current preview tab in place (reuse its slot / position)
          const i = list.findIndex(t=>t.preview);
          const entry = { projectId:ref.projectId, path:ref.path, preview:true };
          if(i>=0) list[i] = entry; else list.push(entry);
        } else {
          list.push({ projectId:ref.projectId, path:ref.path });
        }
        if(list.length>16) list=list.slice(-16); save();
      },
      // Promote the active file's preview tab to a permanent tab (called when the
      // buffer is edited — editing a preview keeps it open, like VSCode).
      promoteActive(){ const a=ws().activeRef; if(!a) return; const t=list.find(x=>x.projectId===a.projectId&&x.path===a.path);
        if(t && t.preview){ delete t.preview; save(); render(); } },
      close(ref){
        // Never close the LAST tab — the tab bar must never disappear (you'd be
        // left with a file in the editor and no way back to it). Closing the only
        // tab is simply a no-op.
        if(list.length<=1) return;
        list = list.filter(t=>!(t.projectId===ref.projectId&&t.path===ref.path)); save();
        // if we closed the active tab, open the last remaining one
        const a = ws().activeRef;
        if(a && a.projectId===ref.projectId && a.path===ref.path && list.length){ const l=list[list.length-1]; ws().openFile(l.projectId,l.path,true); }
        render(); },
    };
  })();
  window.AowliTabs = tabState;

  // ---- boot -----------------------------------------------------------------
  function injectCss(){ if(document.getElementById("fx-css")) return; const s=document.createElement("style"); s.id="fx-css"; s.textContent=CSS; document.head.appendChild(s); }

  // Toolbar for the docked panel header (#explorerTools).
  const TOOLS = [
    { icon: ICON.newfile, tip: "New file", fn: ()=>{ const a=ws().activeRef; promptNewFile(a?a.projectId:(ws().projects[0]&&ws().projects[0].id)); } },
    { icon: ICON.newproj, tip: "New project", fn: ()=>window.AowliExplorer.newProject() },
    { icon: ICON.git, tip: "Clone git repository", fn: ()=>window.AowliGit && window.AowliGit.openDialog() },
    { icon: ICON.refresh, tip: "Refresh", fn: render },
  ];

  // Icons for the two tab-row action buttons (Explorer + Debugger toggles).
  const TAB_BTN_ICON = {
    explorer: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4c0-.6.4-1 1-1h3l1.4 1.4h5c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"/></svg>',
    debug: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5.5" width="6" height="7" rx="3"/><path d="M8 3.2v2.3M4.6 7H2.6M4.6 10H2.4M11.4 7h2M11.4 10h2M6 4.4l-1-1M10 4.4l1-1"/></svg>',
    console: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M4.8 6.4L6.8 8l-2 1.6"/><line x1="8.2" y1="10" x2="11.2" y2="10"/></svg>',
    stages: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3" opacity=".6"/></svg>',
  };

  function boot(){
    injectCss();
    // The file-tab strip sits just above the editor. It holds a scrollable tab
    // region plus a fixed action cluster (File/Explorer + Debugger) on the right.
    let strip = document.getElementById("fileTabs");
    if(!strip){
      strip = document.createElement("div"); strip.id = "fileTabs";
      const stgEdit = document.getElementById("stgEdit");
      if(stgEdit && stgEdit.parentNode) stgEdit.parentNode.insertBefore(strip, stgEdit);
    }
    strip.innerHTML = "";
    tabsEl = document.createElement("div"); tabsEl.className = "ft-scroll";
    const actions = document.createElement("div"); actions.className = "ft-actions";
    const fxBtn = document.createElement("button");
    fxBtn.id = "fxTabBtn"; fxBtn.innerHTML = TAB_BTN_ICON.explorer;
    fxBtn.setAttribute("data-tip", "Toggle the file explorer"); fxBtn.title = "Toggle the file explorer";
    fxBtn.addEventListener("click", ()=>{ if(window.AowliExplorerToggle) window.AowliExplorerToggle(); });
    const dbgBtn = document.createElement("button");
    dbgBtn.id = "dbgTabBtn"; dbgBtn.innerHTML = TAB_BTN_ICON.debug;
    dbgBtn.setAttribute("data-tip", "Debug — run under the aowli debugger and step through execution");
    dbgBtn.title = "Debug — step through execution";
    dbgBtn.addEventListener("click", ()=>{ if(window.AowliDebugger) window.AowliDebugger.toggle(); });
    const conBtn = document.createElement("button");
    conBtn.id = "consoleTabBtn"; conBtn.innerHTML = TAB_BTN_ICON.console;
    conBtn.setAttribute("data-tip", "Toggle the console / output panel");
    conBtn.title = "Toggle the console / output panel";
    conBtn.addEventListener("click", ()=>{ if(window.AowliConsoleToggle) window.AowliConsoleToggle(); });
    const stgBtn = document.createElement("button");
    stgBtn.id = "stagesTabBtn"; stgBtn.innerHTML = TAB_BTN_ICON.stages;
    stgBtn.setAttribute("data-tip", "Toggle the compile-stages & translate-code bar");
    stgBtn.title = "Toggle the compile-stages & translate-code bar";
    stgBtn.addEventListener("click", ()=>{ if(window.AowliStagesToggle) window.AowliStagesToggle(); });
    actions.appendChild(fxBtn); actions.appendChild(dbgBtn); actions.appendChild(stgBtn); actions.appendChild(conBtn);
    strip.appendChild(tabsEl); strip.appendChild(actions);
    // reflect the explorer's current open state on its button
    if(window.AowliExplorerSyncBtn) window.AowliExplorerSyncBtn();
    else if(window.AowliExplorerVisible) fxBtn.classList.toggle("on", window.AowliExplorerVisible());
    if(window.AowliConsoleSyncBtn) window.AowliConsoleSyncBtn();
    if(window.AowliStagesSyncBtn) window.AowliStagesSyncBtn();
    // The explorer is a DOCKED panel (#explorerDock in index.html), not a floating
    // window — render the tree into its body and its tools into the header. Fall
    // back to a WinKit floating window only if the dock isn't present (old markup).
    const dockBody = document.getElementById("explorerBody");
    const dockTools = document.getElementById("explorerTools");
    treeEl = document.createElement("div"); treeEl.className = "fx-tree";
    // ONE delegated right-click handler for the whole tree — robust against rows
    // being re-rendered. Finds the row under the cursor and opens its menu.
    treeEl.addEventListener("contextmenu", e=>{
      const rowEl = e.target && e.target.closest && e.target.closest(".fx-row");
      if(rowEl && rowEl.__onContext){ e.preventDefault(); e.stopPropagation(); rowEl.__onContext(e); }
    });
    if(dockBody){
      dockBody.appendChild(treeEl);
      if(dockTools){
        for(const a of TOOLS){
          const b = document.createElement("button"); b.innerHTML = a.icon;
          b.setAttribute("data-tip", a.tip); b.title = a.tip;
          b.addEventListener("click", (e)=>{ e.stopPropagation(); a.fn(); });
          dockTools.appendChild(b);
        }
      }
      window.AowliExplorer.dock = document.getElementById("explorerDock");
    } else if(window.WinKit){
      winApi = window.WinKit.create({
        key:"explorer", title:"Explorer", icon:ICON.fx, startVisible:true, closable:true,
        default:{ x:14, y:92, w:258, h:440 }, actions: TOOLS,
      });
      winApi.body.appendChild(treeEl);
      window.AowliExplorer.win = winApi;
    }

    ws().onChange(render);
    ws().onActiveFileChange(()=>{ if(ws().activeRef) tabState.touch(ws().activeRef); render(); });
    render();
  }

  window.AowliExplorerBoot = boot;
})();
