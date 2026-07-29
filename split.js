// split.js — split editors. Drag a file TAB to an edge of the editor to open a
// second file beside it (left/right → side-by-side, top/bottom → stacked). The
// PRIMARY editor (#editor) remains the single pipeline driver — parse / sem /
// run / debugger all keep reading it — so this is a purely additive companion
// pane and can never break the compile pipeline. The secondary pane is a real,
// editable Monaco instance whose edits flush straight back into the workspace.
(function(){
  const ws = () => window.AowliWorkspace;
  const monaco = () => window.AowliEditor && window.AowliEditor.getMonaco && window.AowliEditor.getMonaco();
  const stg = () => document.getElementById("stgEdit");
  const primaryEl = () => document.getElementById("editor");

  let overlay = null, group2 = null, splitter = null, ed2 = null, ref2 = null, orient = null, booted = false;

  const CSS = `
  #stgEdit{position:relative}
  #stgEdit.split.vert{flex-direction:row}
  #stgEdit.split.horz{flex-direction:column}
  #stgEdit.split #editor{flex:1 1 50%;min-width:0;min-height:0}
  #stgEdit .ed-group{flex:1 1 50%;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--bg)}
  #stgEdit.split.vert .ed-group{border-left:1px solid var(--border)}
  #stgEdit.split.horz .ed-group{border-top:1px solid var(--border)}
  #stgEdit.split.secfirst .ed-group{order:-1}
  #stgEdit.split.secfirst.vert .ed-group{border-left:0;border-right:1px solid var(--border)}
  #stgEdit.split.secfirst.horz .ed-group{border-top:0;border-bottom:1px solid var(--border)}
  .ed-ghead{display:flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;background:var(--panel);
    border-bottom:1px solid var(--border);font:12px var(--mono);color:var(--muted);flex:none;user-select:none}
  .ed-ghead .ed-gname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);font-weight:500}
  .ed-ghead .ed-gname .ed-gext{opacity:.55;font-size:10.5px}
  .ed-gclose{border:0;background:transparent;color:var(--muted);cursor:pointer;line-height:1;padding:3px;border-radius:5px;display:inline-flex}
  .ed-gclose:hover{background:var(--panel2);color:var(--fg)}
  .ed-gclose svg{width:12px;height:12px}
  .ed-host{flex:1;min-height:0}
  .ed-splitter{flex:none;background:var(--border);position:relative;z-index:6}
  #stgEdit.split.vert .ed-splitter{width:1px;cursor:col-resize}
  #stgEdit.split.horz .ed-splitter{height:1px;cursor:row-resize}
  .ed-splitter::after{content:"";position:absolute}
  #stgEdit.split.vert .ed-splitter::after{top:0;bottom:0;left:-4px;right:-4px;cursor:col-resize}
  #stgEdit.split.horz .ed-splitter::after{left:0;right:0;top:-4px;bottom:-4px;cursor:row-resize}
  /* drop-zone overlay shown only while a tab is being dragged */
  .ed-dropzones{position:absolute;inset:0;z-index:30;pointer-events:none;display:none}
  .ed-dropzones.show{display:block}
  .ed-dz{position:absolute;background:rgba(94,161,251,.16);border:1.5px dashed var(--accent);border-radius:8px;
    opacity:0;transition:opacity .09s}
  .ed-dz.hot{opacity:1}
  .ed-dz.left{left:0;top:0;bottom:0;width:38%}
  .ed-dz.right{right:0;top:0;bottom:0;width:38%}
  .ed-dz.top{left:0;right:0;top:0;height:38%}
  .ed-dz.bottom{left:0;right:0;bottom:0;height:38%}
  .ed-dz.center{inset:26%}`;

  function injectCss(){ if(document.getElementById("split-css")) return;
    const s=document.createElement("style"); s.id="split-css"; s.textContent=CSS; document.head.appendChild(s); }

  const CLOSE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function splitLabel(path){
    const base = path.split("/").pop(); const dot = base.lastIndexOf(".");
    const nm = dot>0 ? base.slice(0,dot) : base, ext = dot>0 ? base.slice(dot) : "";
    return esc(nm) + (ext ? '<span class="ed-gext">'+esc(ext)+'</span>' : '');
  }
  function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  function ensureGroup(){
    if(group2) return true;
    const s = stg(), m = monaco(); if(!s || !m) return false;
    splitter = document.createElement("div"); splitter.className = "ed-splitter";
    group2 = document.createElement("div"); group2.className = "ed-group"; group2.id = "edGroup2";
    group2.innerHTML = '<div class="ed-ghead"><span class="ed-gname"></span>'+
      '<button class="ed-gclose" title="Close split" aria-label="Close split">'+CLOSE_SVG+'</button></div>'+
      '<div class="ed-host" id="editor2"></div>';
    // keep the drop overlay LAST so it paints above both editors
    s.insertBefore(splitter, overlay); s.insertBefore(group2, overlay);
    ed2 = m.editor.create(group2.querySelector("#editor2"), {
      value:"", language:"nimony", automaticLayout:true, minimap:{enabled:false},
      fontSize: (window.AowliEditor.getFontSize && window.AowliEditor.getFontSize()) || 14,
      scrollBeyondLastLine:false, tabSize:2, insertSpaces:true, contextmenu:false, folding:true,
    });
    ed2.onDidChangeModelContent(()=>{ if(ref2){ const p=ws().project(ref2.projectId);
      if(p && !p.readonly) ws().writeFile(ref2.projectId, ref2.path, ed2.getValue()); } });
    group2.querySelector(".ed-gclose").addEventListener("click", close);
    wireSplitter();
    return true;
  }

  function open(ref, orientation, secFirst){
    injectCss(); ensureOverlay();
    if(!ensureGroup()) return;
    orient = orientation === "horz" ? "horz" : "vert";
    const s = stg();
    s.classList.add("split");
    s.classList.toggle("vert", orient==="vert");
    s.classList.toggle("horz", orient==="horz");
    s.classList.toggle("secfirst", !!secFirst);
    // reset any prior manual splitter sizing
    primaryEl().style.flex = ""; group2.style.flex = "";
    ref2 = { projectId: ref.projectId, path: ref.path };
    const p = ws().project(ref.projectId);
    const content = ws().readFile(ref.projectId, ref.path) || "";
    ed2.updateOptions({ readOnly: !!(p && p.readonly) });
    ed2.setValue(content);
    setLang(ref.path);
    group2.querySelector(".ed-gname").innerHTML = splitLabel(ref.path) + (p && p.readonly ? ' ·ro' : '');
    group2.querySelector(".ed-gname").title = (p?p.name+"/":"") + ref.path;
    setTimeout(()=>{ try{ window.AowliEditor.relayout && window.AowliEditor.relayout(); ed2 && ed2.layout(); }catch(_){} }, 30);
  }
  function close(){
    const s = stg();
    if(s) s.classList.remove("split","vert","horz","secfirst");
    if(ed2){ try{ ed2.dispose(); }catch(_){} ed2=null; }
    if(group2){ group2.remove(); group2=null; }
    if(splitter){ splitter.remove(); splitter=null; }
    ref2 = null;
    if(primaryEl()) primaryEl().style.flex = "";
    setTimeout(()=>{ try{ window.AowliEditor.relayout && window.AowliEditor.relayout(); }catch(_){} }, 30);
  }

  function setLang(path){
    const m = monaco(); if(!m || !ed2) return;
    const lang = /\.(nim|aowl)$/.test(path) ? "nimony"
      : /\.md$/.test(path) ? "markdown" : /\.json$/.test(path) ? "json"
      : /\.(js|mjs)$/.test(path) ? "javascript" : /\.c$/.test(path) ? "c"
      : /\.(nif|aif)$/.test(path) ? "nif" : "nimony";
    try{ m.editor.setModelLanguage(ed2.getModel(), lang); }catch(_){}
  }

  function wireSplitter(){
    let drag=false;
    splitter.addEventListener("pointerdown", e=>{ drag=true; try{ splitter.setPointerCapture(e.pointerId); }catch(_){} e.preventDefault(); });
    splitter.addEventListener("pointermove", e=>{ if(!drag) return; const s=stg(); const r=s.getBoundingClientRect();
      let f = orient==="vert" ? (e.clientX-r.left)/r.width : (e.clientY-r.top)/r.height;
      f = Math.max(.15, Math.min(.85, f));
      const first = stg().classList.contains("secfirst");
      const primaryFrac = first ? (1-f) : f;
      primaryEl().style.flex = "0 0 "+(primaryFrac*100)+"%";
      group2.style.flex = "1 1 auto";
    });
    const end=e=>{ drag=false; try{ splitter.releasePointerCapture(e.pointerId); }catch(_){} };
    splitter.addEventListener("pointerup", end); splitter.addEventListener("pointercancel", end);
  }

  // ---- drop-zone overlay ----------------------------------------------------
  function ensureOverlay(){
    if(overlay) return; const s = stg(); if(!s) return;
    overlay = document.createElement("div"); overlay.className = "ed-dropzones";
    overlay.innerHTML = ["left","right","top","bottom","center"].map(z=>'<div class="ed-dz '+z+'"></div>').join("");
    s.appendChild(overlay);
    // Capture phase + stopPropagation so the events are consumed BEFORE Monaco's
    // own drag-drop handling can fire (which would otherwise try to insert text).
    s.addEventListener("dragover", e=>{ if(!window.__npTabDrag) return; e.preventDefault(); e.stopPropagation();
      try{ e.dataTransfer.dropEffect="copy"; }catch(_){}
      overlay.classList.add("show"); hot(zoneAt(e,s)); }, true);
    s.addEventListener("dragleave", e=>{ if(!window.__npTabDrag) return;
      if(!s.contains(e.relatedTarget)){ overlay.classList.remove("show"); hot(null); } }, true);
    s.addEventListener("drop", e=>{ if(!window.__npTabDrag) return; e.preventDefault(); e.stopPropagation();
      const z = zoneAt(e,s), ref = window.__npTabDrag; window.__npTabDrag = null;
      overlay.classList.remove("show"); hot(null); handleDrop(ref, z); }, true);
  }
  function hot(z){ if(!overlay) return; overlay.querySelectorAll(".ed-dz").forEach(d=>d.classList.toggle("hot", !!z && d.classList.contains(z))); }
  function zoneAt(e, s){ const r=s.getBoundingClientRect();
    const x=(e.clientX-r.left)/r.width, y=(e.clientY-r.top)/r.height, m=.25;
    if(x<m) return "left"; if(x>1-m) return "right"; if(y<m) return "top"; if(y>1-m) return "bottom"; return "center"; }
  function handleDrop(ref, z){
    if(!ref) return;
    if(z==="center"){ ws().openFile(ref.projectId, ref.path, true); return; }
    const orientation = (z==="left"||z==="right") ? "vert" : "horz";
    open(ref, orientation, z==="left"||z==="top");
  }

  function boot(){
    if(booted) return; booted = true;
    injectCss(); ensureOverlay();
    // If the file shown in the split is deleted/renamed away, close the split.
    if(ws() && ws().onChange) ws().onChange(()=>{ if(ref2){ const p=ws().project(ref2.projectId);
      if(!p || !p.files.has(ref2.path)) close(); } });
  }

  window.AowliSplit = { open, close, boot, isOpen:()=>!!group2 };
  if(window.AowliEditor && window.AowliEditor.onReady) window.AowliEditor.onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
