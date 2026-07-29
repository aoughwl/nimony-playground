// nav.js — VSCode-style navigation history for the editor. Keeps a linear
// back/forward stack of {file, cursor} locations and drives it from the mouse
// back/forward buttons (buttons 3 & 4) and Alt+Left / Alt+Right. So after you
// Ctrl-click into a std module you can go back to the import — and forward back
// into it — exactly like an editor/browser.
(function(){
  const ws = () => window.AowliWorkspace;
  const ED = () => window.AowliEditor;

  let stack = [];        // [{projectId, path, line, col}]
  let idx = -1;          // pointer into stack (the current location)
  let navigating = false;

  function sameRef(a, b){ return a && b && a.projectId===b.projectId && a.path===b.path; }
  function curPos(){
    try{ const e = ED().getEditor && ED().getEditor(); if(e){ const p = e.getPosition(); if(p) return { line:p.lineNumber, col:p.column }; } }catch(_){}
    return { line:1, col:1 };
  }
  // keep the CURRENT entry's cursor fresh so Back returns to the exact spot
  function syncCursor(){
    if(navigating || idx < 0) return;
    const r = ws() && ws().activeRef; if(!r || !sameRef(stack[idx], r)) return;
    const p = curPos(); stack[idx].line = p.line; stack[idx].col = p.col;
  }
  // a new location became active (not via back/forward) → push it
  function onActive(){
    const r = ws() && ws().activeRef; if(!r) return;
    if(navigating) return;
    if(idx >= 0 && sameRef(stack[idx], r)) return;   // same file — nothing to record
    stack = stack.slice(0, idx+1);                   // truncate any forward history
    stack.push({ projectId:r.projectId, path:r.path, line:1, col:1 });
    idx = stack.length - 1;
    if(stack.length > 100){ stack = stack.slice(-100); idx = stack.length - 1; }
  }
  function restore(entry){
    if(!entry) return;
    navigating = true;
    try{ ws().openFile(entry.projectId, entry.path, true); }catch(_){}
    try{ ED().revealPosition && ED().revealPosition(entry.line, entry.col); }catch(_){}
    // release on the next tick, after the synchronous openFile→onActive fired
    setTimeout(()=>{ navigating = false; }, 0);
  }
  function back(){ if(idx > 0){ syncCursor(); idx--; restore(stack[idx]); } }
  function forward(){ if(idx < stack.length - 1){ syncCursor(); idx++; restore(stack[idx]); } }

  window.AowliNav = { back, forward, canBack:()=>idx>0, canForward:()=>idx<stack.length-1, _stack:()=>stack, _idx:()=>idx };

  // ---- inputs ---------------------------------------------------------------
  // Mouse buttons 3 (back) / 4 (forward). Prevent the browser's own history
  // navigation (which would leave the page) and drive our stack instead.
  window.addEventListener("mousedown", e=>{ if(e.button===3 || e.button===4) e.preventDefault(); }, true);
  window.addEventListener("auxclick", e=>{ if(e.button===3 || e.button===4) e.preventDefault(); }, true);
  window.addEventListener("mouseup", e=>{
    if(e.button===3){ e.preventDefault(); back(); }
    else if(e.button===4){ e.preventDefault(); forward(); }
  }, true);
  // Alt+Left / Alt+Right (VSCode default). Capture so it works from inside Monaco.
  window.addEventListener("keydown", e=>{
    if(!e.altKey || e.ctrlKey || e.metaKey) return;
    if(e.key==="ArrowLeft"){ e.preventDefault(); back(); }
    else if(e.key==="ArrowRight"){ e.preventDefault(); forward(); }
  }, true);

  // ---- boot -----------------------------------------------------------------
  function boot(){
    if(ws() && ws().onActiveFileChange) ws().onActiveFileChange(onActive);
    const e = ED() && ED().getEditor && ED().getEditor();
    if(e && e.onDidChangeCursorPosition) e.onDidChangeCursorPosition(syncCursor);
    onActive();   // seed with the initially-open file
  }
  if(ED() && ED().onReady) ED().onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
