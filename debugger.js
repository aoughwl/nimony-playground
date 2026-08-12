// debugger.js — the full in-browser aowli debugger UI.
//
// The aowli debugger's interactive session cannot run under nim_js (it blocks on
// an unbuffered fd-0 read and fork()s for snapshots — none of which exist in the
// JS backend). So instead of pausing a live co-process, the worker runs the
// program ONCE under the batch dmStep capture engine (webmain_dbg.nim) and hands
// back the whole ORDERED step log: each statement's source line, enclosing
// routine, call depth, frame locals, and how much stdout had been printed. This
// UI replays that log as a genuine step / next / finish / continue debugger —
// plus REVERSE-step and jump-anywhere, which a live debugger can't give you.
//
// It drives the Monaco editor for the current-line highlight + gutter
// breakpoints, and a WinKit panel for the transport controls, call stack,
// locals, and captured output. Breakpoints filter which captured steps
// continue/reverse-continue land on.
(function(){
  const $ = s => document.querySelector(s);
  const ws = () => window.AowliWorkspace;

  const CSS = `
  .dbg-body{display:flex;flex-direction:column;height:100%;min-height:0}
  .dbg-name{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.05em;
    text-transform:uppercase;color:var(--muted);padding:0 4px 0 4px;white-space:nowrap}
  .dbg-name svg{width:13px;height:13px;opacity:.85}
  .dbg-close{margin-left:6px}
  .dbg-close svg{width:12px;height:12px}
  /* in the wide bottom drawer, lay the four panes as columns so short height
     still shows stack / locals / watch / output side by side. */
  .dbg-panes{display:flex;flex-direction:row;align-items:stretch}
  .dbg-panes>.dbg-sec{flex:1 1 0;min-width:0;border-bottom:0;border-right:1px solid var(--border);overflow:auto}
  .dbg-panes>.dbg-sec:last-child{border-right:0}
  @media(max-width:720px){ .dbg-panes{flex-direction:column} .dbg-panes>.dbg-sec{border-right:0;border-bottom:1px solid var(--border)} }
  .dbg-bar{display:flex;align-items:center;gap:1px;padding:6px 8px;border-bottom:1px solid var(--border);flex-wrap:wrap}
  .dbg-bar button{width:30px;height:28px;border:0;background:transparent;color:var(--fg);border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  .dbg-bar button:hover{background:var(--panel2)}
  .dbg-bar button:disabled{opacity:.35;cursor:default}
  .dbg-bar button svg{width:15px;height:15px}
  .dbg-bar .sep{width:1px;height:20px;background:var(--border);margin:0 5px}
  .dbg-bar .dbg-pos{margin-left:auto;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:8px}
  /* flame / depth timeline — a ZOOMABLE slice plus a full-extent minimap */
  .dbg-tl{border-bottom:1px solid var(--border);background:var(--bg)}
  .dbg-flame{position:relative;height:66px;background:var(--bg);cursor:crosshair;user-select:none;touch-action:none;outline:none}
  .dbg-flame.pan{cursor:grab} .dbg-flame.panning{cursor:grabbing}
  .dbg-flame canvas{display:block;width:100%;height:100%}
  .dbg-flame .dbg-flame-tip{position:absolute;top:2px;pointer-events:none;transform:translateX(-50%);
    background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:2px 6px;font:11px var(--mono);
    color:var(--fg);white-space:nowrap;opacity:0;transition:opacity .1s;z-index:4;max-width:60%;overflow:hidden;text-overflow:ellipsis}
  .dbg-flame:hover .dbg-flame-tip{opacity:1}
  /* the zoom readout + buttons ride on top of the flame's top-right corner */
  .dbg-tlctl{position:absolute;top:3px;right:4px;display:flex;align-items:center;gap:2px;z-index:5;
    background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:1px 3px}
  @supports (background: color-mix(in srgb, red 50%, transparent)){
    .dbg-tlctl{background:color-mix(in srgb, var(--panel) 82%, transparent)}
  }
  .dbg-tlctl .rng{font:10.5px var(--mono);color:var(--muted);font-variant-numeric:tabular-nums;padding:0 4px;white-space:nowrap}
  .dbg-tlctl button{width:20px;height:18px;border:0;background:transparent;color:var(--fg);border-radius:4px;cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center;font:11px var(--mono);padding:0}
  .dbg-tlctl button:hover{background:var(--panel2)}
  .dbg-tlctl button svg{width:11px;height:11px}
  /* the minimap: the WHOLE run, with the visible slice framed */
  .dbg-mini{position:relative;height:16px;border-top:1px solid var(--border);cursor:pointer;user-select:none;touch-action:none}
  .dbg-mini canvas{display:block;width:100%;height:100%}
  .dbg-status{padding:6px 11px;font-size:11.5px;color:var(--muted);border-bottom:1px solid var(--border);min-height:28px;line-height:1.5}
  .dbg-status.run{color:var(--accent2)} .dbg-status.err{color:var(--err)} .dbg-status.busy{color:var(--warn)}
  .dbg-panes{flex:1;overflow:auto;min-height:0}
  .dbg-sec{border-bottom:1px solid var(--border)}
  .dbg-sec-h{padding:6px 11px;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
    display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--panel)}
  .dbg-sec-h .tw{transition:transform .12s;display:inline-flex}
  .dbg-sec.collapsed .tw{transform:rotate(-90deg)} .dbg-sec.collapsed .dbg-sec-b{display:none}
  .dbg-sec-h .ct{margin-left:auto;font-weight:600;color:var(--muted);opacity:.7}
  .dbg-sec-b{padding:2px 0 6px}
  .dbg-var{display:flex;gap:8px;padding:2px 12px;font:12px var(--mono);align-items:baseline}
  .dbg-var .k{color:var(--accent);flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dbg-var .eq{color:var(--muted);flex:none} .dbg-var .val{color:var(--fg);white-space:pre-wrap;word-break:break-word;flex:1;min-width:0}
  .dbg-var.changed .val{color:var(--warn)}
  .dbg-empty{padding:6px 12px;color:var(--muted);font-size:12px;font-style:italic}
  .dbg-frame{padding:3px 12px;font:12px var(--mono);cursor:pointer;display:flex;gap:7px;align-items:baseline}
  .dbg-frame:hover{background:var(--panel2)}
  .dbg-frame.cur{background:var(--brace-bg)}
  .dbg-frame .fn{color:var(--brace)} .dbg-frame .ln{color:var(--muted);margin-left:auto;font-size:11px}
  .dbg-out{padding:6px 12px;font:12px var(--mono);white-space:pre-wrap;word-break:break-word;color:var(--fg)}
  .dbg-out .cur{background:var(--brace-bg);outline:1px solid var(--brace);border-radius:2px}
  .dbg-watchrow{display:flex;gap:6px;padding:4px 10px}
  .dbg-watchrow input{flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:12px var(--mono)}
  /* editor decorations */
  .dbg-curline{background:rgba(199,146,234,.14)}
  .dbg-curglyph{background:var(--brace);width:4px!important;margin-left:3px}
  .dbg-bp-glyph{background:var(--err);border-radius:50%;width:10px!important;height:10px!important;margin:7px 0 0 6px}
  .monaco-editor .margin{cursor:pointer}`;

  const IC = {
    restart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.2v3h-3"/></svg>',
    rewind: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 8l5-3.5v7zM2.5 8l5-3.5v7z"/></svg>',
    stepback: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3.5L6 8l4.5 4.5"/><path d="M3.5 3.5v9"/></svg>',
    stepfwd: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5L10 8l-4.5 4.5"/><path d="M12.5 3.5v9"/></svg>',
    into: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v7"/><path d="M5 6.5l3 3 3-3"/><circle cx="8" cy="13" r="1.3" fill="currentColor" stroke="none"/></svg>',
    over: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 0 1 10 0"/><path d="M13 5v3h-3"/><circle cx="8" cy="13" r="1.3" fill="currentColor" stroke="none"/></svg>',
    out: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9.5v-7"/><path d="M5 5.5l3-3 3 3"/><circle cx="8" cy="13" r="1.3" fill="currentColor" stroke="none"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3l8 5-8 5z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.3"/></svg>',
    twist: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
    zoomin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14M5.2 7h3.6M7 5.2v3.6"/></svg>',
    zoomout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14M5.2 7h3.6"/></svg>',
    zoomfit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 5.5v-3h3M14 5.5v-3h-3M2 10.5v3h3M14 10.5v3h-3"/></svg>',
    bug: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5.5" width="6" height="7" rx="3"/><path d="M8 3.2v2.3M4.6 7H2.6M4.6 10H2.4M11.4 7h2M11.4 10h2M6 4.4l-1-1M10 4.4l1-1"/></svg>',
  };

  // ---- state ----------------------------------------------------------------
  let win = null, els = {}, running = false;
  let steps = [];          // captured step log
  let idx = -1;            // current step index (-1 = before start)
  let truncated = false, finalStdout = "", finalStderr = "", exitCode = 0;
  let dbgFile = null;      // the ref { projectId, path } being debugged
  const breakpoints = new Set();   // 1-based line numbers in the debugged file
  let prevVars = {};       // for change-highlighting
  // Steps captured INSIDE the stdlib — e.g. `echo` expands to `write(stdout,…)`
  // tagged with syncio.nim:472 — carry a line number that doesn't exist in the
  // debugged buffer, which used to yank the highlight to the last editor line.
  // A captured line belongs to the debugged file iff it's within the buffer's
  // line count (robust; doesn't depend on the module's recorded basename). We
  // hold the last in-file line for out-of-range steps instead of painting them.
  let srcLineCount = 1e9;   // set from the debugged buffer at capture time
  let lastInFileLine = 0;
  function stepInMainFile(s){ return s && s.l >= 1 && s.l <= srcLineCount; }
  // Monaco decorations
  let curDecos = [], bpDecos = [];

  // ---- editor integration ---------------------------------------------------
  function ed(){ return window.AowliEditor && window.AowliEditor.getEditor && window.AowliEditor.getEditor(); }
  function monaco(){ return window.AowliEditor && window.AowliEditor.getMonaco && window.AowliEditor.getMonaco(); }

  function paintCurLine(line){
    const e = ed(), m = monaco(); if(!e || !m){ return; }
    const decos = line ? [{
      range: new m.Range(line, 1, line, 1),
      options: { isWholeLine:true, className:"dbg-curline", glyphMarginClassName:"dbg-curglyph" }
    }] : [];
    curDecos = e.deltaDecorations(curDecos, decos);
    if(line){ try{ e.revealLineInCenterIfOutsideViewport(line); }catch(_){} }
  }
  function paintBreakpoints(){
    const e = ed(), m = monaco(); if(!e || !m) return;
    const decos = [...breakpoints].map(ln => ({
      range: new m.Range(ln, 1, ln, 1),
      options: { isWholeLine:false, glyphMarginClassName:"dbg-bp-glyph" }
    }));
    bpDecos = e.deltaDecorations(bpDecos, decos);
  }
  let gutterWired = false;
  function wireGutter(){
    const e = ed(), m = monaco(); if(!e || !m || gutterWired) return;
    gutterWired = true;
    e.updateOptions({ glyphMargin:true });
    e.onMouseDown(ev => {
      if(ev.target && ev.target.type === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN){
        const ln = ev.target.position && ev.target.position.lineNumber;
        if(ln){ breakpoints.has(ln) ? breakpoints.delete(ln) : breakpoints.add(ln); paintBreakpoints(); if(steps.length) renderFlame(); }
      }
    });
  }
  function clearEditor(){ paintCurLine(0); }

  // ---- the session ----------------------------------------------------------
  async function start(){
    ensureDock();
    showDock();
    if(running){ stop(); }
    // flush + snapshot which file we're debugging
    if(ws()){ ws().flush(); dbgFile = ws().activeRef; }
    wireGutter(); paintBreakpoints();
    setStatus("compiling & capturing execution…", "busy");
    setControlsEnabled(false);
    running = true;

    const src = window.AowliEditor.getValue();
    srcLineCount = (String(src).split("\n").length) || 1e9;   // in-file line range for the highlight guard
    if(!(window.AowliParser && window.AowliParser.ready)){ setStatus("parser still loading…","err"); running=false; return; }
    if(!(window.AowliPipe && window.AowliPipe.ready)){ setStatus("engine still loading…","err"); running=false; return; }
    // import gate (same as Run)
    const bad = (window.AowliCore && window.AowliCore.checkImports) ? window.AowliCore.checkImports(src) : [];
    if(bad.length){ setStatus("unavailable import: "+bad[0].message, "err"); running=false; setControlsEnabled(true); return; }
    let nif;
    try{ const r = window.AowliParser.parseFull(src, "in.nim"); nif = r.nif;
      if(r.diags && r.diags.length){ setStatus("syntax error: "+r.diags[0].message+" (line "+r.diags[0].line+")","err"); running=false; setControlsEnabled(true); return; }
    }catch(e){ setStatus("parse failed: "+(e&&e.message||e),"err"); running=false; return; }

    let semEng = (window.AowliOpts && window.AowliOpts.sem === "nim") ? "nim" : "aowl";
    try{
      const multi = window.__aowliBuildMulti ? window.__aowliBuildMulti(src) : null;
      if(multi && multi.modules) semEng = "nim";   // a workspace needs cross-file resolution (see sem.js)
      const res = await window.AowliPipe.debug(nif, currentStdin(), semEng, multi);
      if(res.ranSem && !res.snif){
        const msg = (res.diags&&res.diags.length) ? res.diags.map(d=>d.line+":"+d.col+" "+d.message).join("; ") : "did not type-check";
        setStatus("semantic error: "+msg, "err"); running=false; setControlsEnabled(true); return;
      }
      steps = res.steps || [];
      truncated = !!res.truncated;
      finalStdout = res.stdout || ""; finalStderr = res.stderr || ""; exitCode = res.exitCode|0;
      if(!steps.length){
        setStatus("no steps captured — the program produced no executable statements.", "err");
        renderOutputFinal(); running=false; setControlsEnabled(true); return;
      }
      idx = 0; prevVars = {};
      miniCache = null; fitView();      // a new capture starts fitted to the whole run
      setControlsEnabled(true);
      setStatus("captured " + steps.length + " step" + (steps.length===1?"":"s") + (truncated?" (truncated at cap)":"") + " · exit " + exitCode, "run");
      renderAll();
    }catch(e){
      setStatus("debug failed: " + (e && e.message || e), "err"); running=false; setControlsEnabled(true);
    }
  }

  function stop(){
    running = false; steps = []; idx = -1; clearEditor();
    view = { start: 0, span: 0 }; miniCache = null;
    setStatus("stopped", "");
    renderFlame(); renderPanes();
  }

  function currentStdin(){ const b=document.getElementById("stdinBox"); return b?b.value:""; }

  // ---- navigation -----------------------------------------------------------
  function stepAt(i){ return (i>=0 && i<steps.length) ? steps[i] : null; }
  function goto(i){ if(!steps.length) return; idx = Math.max(0, Math.min(i, steps.length-1)); renderAll(); }
  function forward(){ goto(idx+1); }
  function back(){ goto(idx-1); }
  function stepInto(){ forward(); }        // dmStep granularity: next statement anywhere
  function stepBackInto(){ back(); }
  function stepOver(){                       // stop at next step with depth <= current
    const cur = stepAt(idx); if(!cur){ forward(); return; }
    for(let i=idx+1;i<steps.length;i++){ if(steps[i].d <= cur.d){ goto(i); return; } }
    goto(steps.length-1);
  }
  function stepOut(){                         // stop at next step with depth < current
    const cur = stepAt(idx); if(!cur){ forward(); return; }
    for(let i=idx+1;i<steps.length;i++){ if(steps[i].d < cur.d){ goto(i); return; } }
    goto(steps.length-1);
  }
  function continueFwd(){                     // to next breakpoint line, else end
    if(!breakpoints.size){ goto(steps.length-1); return; }
    for(let i=idx+1;i<steps.length;i++){ if(breakpoints.has(steps[i].l)){ goto(i); return; } }
    goto(steps.length-1);
  }
  function continueBack(){                    // to previous breakpoint line, else start
    if(!breakpoints.size){ goto(0); return; }
    for(let i=idx-1;i>=0;i--){ if(breakpoints.has(steps[i].l)){ goto(i); return; } }
    goto(0);
  }

  // ---- rendering ------------------------------------------------------------
  function renderAll(){
    const s = stepAt(idx); if(!s) return;
    // ensure the debugged file is the visible buffer
    if(dbgFile && ws() && ws().activeRef && (ws().activeRef.projectId!==dbgFile.projectId || ws().activeRef.path!==dbgFile.path)){
      ws().openFile(dbgFile.projectId, dbgFile.path, true);
    }
    // Recompute the last in-file line up to `idx` so scrubbing backwards/jumping
    // lands on the right editor line (not whatever a later out-of-file step left).
    lastInFileLine = 0;
    for(let i=0;i<=idx;i++){ if(stepInMainFile(steps[i])) lastInFileLine = steps[i].l; }
    paintCurLine(lastInFileLine);
    els.pos.textContent = (idx+1) + " / " + steps.length;
    followPlayhead();
    renderFlame();
    renderPanes();
  }

  function renderPanes(){
    renderStack(); renderLocals(); renderOutput();
  }

  // ---- flame / depth timeline ------------------------------------------------
  // Two linked views over the captured step log:
  //
  //   * the FLAME (top) shows a SLICE — `view.start .. view.start+view.span` —
  //     so a 100k-step run is explorable instead of being squeezed into a pixel
  //     per thousand steps. Wheel zooms about the pointer, shift/middle/space
  //     drag pans, plain drag still scrubs the playhead.
  //   * the MINIMAP (bottom) always shows the WHOLE run with the visible slice
  //     framed; click or drag it to move the slice.
  //
  // Each step is a column whose vertical lane is its call depth (nested calls
  // sink down), coloured per enclosing routine. Lanes are computed over the FULL
  // log, not the slice, so a cell does not jump rows while panning.
  const MIN_SPAN = 6;          // never zoom in past this many steps
  const ZOOM_STEP = 1.35;      // per wheel notch / button press
  let view = { start: 0, span: 0 };   // span 0 = "not initialised yet"
  let flameGeom = null;   // { n, minD, lanes, laneH, W, H, topPad, botPad, cellW }
  let miniCache = null;   // offscreen canvas of the static minimap + its key
  function hue(str){ let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0; return h%360; }
  function colorFor(fn, dim){
    if(!fn) return dim ? "rgba(130,130,140,.35)" : "rgba(150,150,162,.62)";   // top level = neutral
    const h = hue(fn);
    return dim ? "hsla("+h+",55%,58%,.42)" : "hsla("+h+",62%,60%,.92)";
  }
  function depthRange(){
    let minD=1e9, maxD=-1e9;
    for(const s of steps){ const d=s.d|0; if(d<minD)minD=d; if(d>maxD)maxD=d; }
    if(minD>maxD){ minD=0; maxD=0; }
    return [minD, maxD];
  }

  // ---- the viewport ----------------------------------------------------------
  function clampView(){
    const n = steps.length;
    if(!n){ view.start=0; view.span=0; return; }
    view.span = Math.max(Math.min(MIN_SPAN, n), Math.min(Math.round(view.span)||n, n));
    view.start = Math.max(0, Math.min(Math.round(view.start), n - view.span));
  }
  function fitView(){ view.start = 0; view.span = steps.length; clampView(); }
  function viewCenter(){ return view.start + view.span/2; }
  function zoomBy(factor, anchorStep){
    const n = steps.length; if(!n) return;
    const a = Math.max(0, Math.min(anchorStep, n));
    const frac = view.span > 0 ? (a - view.start) / view.span : .5;
    view.span = view.span * factor;
    view.start = a - frac * view.span;
    clampView(); renderFlame();
  }
  function panBy(steps_){ view.start += steps_; clampView(); renderFlame(); }
  // Keep the playhead on screen as the user steps: recentre only once it leaves
  // the comfortable middle, so ordinary stepping does not make the view twitch.
  function followPlayhead(){
    const n = steps.length; if(!n) return;
    if(!view.span){ fitView(); return; }
    clampView();
    if(view.span >= n) return;
    const lo = view.start + view.span*0.12, hi = view.start + view.span*0.88;
    if(idx < lo || idx > hi){ view.start = idx - view.span/2; clampView(); }
  }

  // ---- the flame (the visible slice) ----------------------------------------
  function renderFlame(){
    const wrap = els.flame, cv = els.flameCanvas; if(!wrap || !cv) return;
    const W = wrap.clientWidth || 1, H = wrap.clientHeight || 66;
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    const n = steps.length;
    if(!n){ flameGeom=null; miniCache=null; renderMini(); setRangeLabel(); return; }
    if(!view.span) fitView(); else clampView();
    const [minD, maxD] = depthRange();
    const lanes = Math.max(1, maxD-minD+1);
    const topPad=6, botPad=8;                       // reserve strips for bp/output ticks
    const laneH = Math.max(3, (H-topPad-botPad)/lanes);
    const i0 = view.start, i1 = Math.min(n, view.start + view.span);
    const cellW = W/Math.max(1,(i1-i0));
    flameGeom = { n, minD, lanes, laneH, W, H, topPad, botPad, cellW, i0, i1 };
    const drawW = Math.max(1, Math.ceil(cellW)+0.5);
    // Zoomed OUT far enough that many steps share one pixel: aggregate per column
    // (min..max depth as one bar) instead of overdrawing thousands of rects.
    const perPixel = (i1-i0) / W;
    if(perPixel > 1.2){
      const cols = Math.ceil(W);
      for(let x=0;x<cols;x++){
        const a = i0 + Math.floor(x*perPixel), b = Math.min(i1, i0 + Math.floor((x+1)*perPixel));
        if(b<=a) continue;
        let lo=1e9, hi=-1e9, bp=false, outp=false, fn=steps[a].fn;
        for(let i=a;i<b;i++){
          const d = steps[i].d|0; if(d<lo)lo=d; if(d>hi)hi=d;
          if(breakpoints.has(steps[i].l)) bp=true;
          if(i>0 && (steps[i].o|0) > (steps[i-1].o|0)) outp=true;
        }
        const y0 = topPad + (lo-minD)*laneH, y1 = topPad + (hi-minD+1)*laneH;
        ctx.fillStyle = colorFor(fn, a>idx);
        ctx.fillRect(x, y0, 1.05, Math.max(2, y1-y0-1));
        if(outp){ ctx.fillStyle = "rgba(61,220,151,.9)"; ctx.fillRect(x, H-botPad+2, 1.05, 3); }
        if(bp){ ctx.fillStyle = "#ff6b6b"; ctx.fillRect(x, 0, 1.05, 4); }
      }
    }else{
      for(let i=i0;i<i1;i++){
        const s = steps[i];
        const x = (i-i0)*cellW;
        const y = topPad + ((s.d|0)-minD)*laneH;
        ctx.fillStyle = colorFor(s.fn, i>idx);        // steps ahead of the playhead are dimmed
        ctx.fillRect(x, y, drawW, Math.max(2, laneH-1));
        if(i>0 && (s.o|0) > (steps[i-1].o|0)){ ctx.fillStyle = "rgba(61,220,151,.9)"; ctx.fillRect(x, H-botPad+2, Math.max(1,drawW), 3); }
        if(breakpoints.has(s.l)){ ctx.fillStyle = "#ff6b6b"; ctx.fillRect(x, 0, Math.max(1,drawW), 4); }
      }
      // Zoomed in far enough for a label: name the routine (or the line) in-cell.
      if(cellW >= 26){
        ctx.font = "10px ui-monospace, monospace"; ctx.textBaseline = "middle";
        for(let i=i0;i<i1;i++){
          const s = steps[i];
          const label = cellW >= 62 ? ((s.fn||"(top)") + " :" + s.l) : (":" + s.l);
          const x = (i-i0)*cellW, y = topPad + ((s.d|0)-minD)*laneH;
          if(laneH < 9) break;
          ctx.save(); ctx.beginPath(); ctx.rect(x+1, y, cellW-2, laneH-1); ctx.clip();
          ctx.fillStyle = "rgba(12,12,16,.82)";
          ctx.fillText(label, x+3, y + laneH/2);
          ctx.restore();
        }
      }
    }
    // the playhead — or, when it is off-slice, an arrow on the edge it left by
    if(idx >= i0 && idx < i1){
      const px = (idx-i0)*cellW + Math.min(cellW,6)/2;
      ctx.strokeStyle = "#5ea1fb"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      const cs = steps[idx];
      if(cs){ const y = topPad + ((cs.d|0)-minD)*laneH;
        ctx.fillStyle = "#fff"; ctx.globalAlpha=.9; ctx.fillRect((idx-i0)*cellW, y, Math.max(2,drawW), Math.max(2,laneH-1)); ctx.globalAlpha=1;
        ctx.fillStyle = colorFor(cs.fn,false); ctx.fillRect((idx-i0)*cellW, y, Math.max(2,drawW), Math.max(2,laneH-1)); }
    }else if(idx >= 0){
      const right = idx >= i1;
      ctx.fillStyle = "#5ea1fb";
      ctx.beginPath();
      if(right){ ctx.moveTo(W-1, H/2-5); ctx.lineTo(W-1, H/2+5); ctx.lineTo(W-8, H/2); }
      else     { ctx.moveTo(1, H/2-5);   ctx.lineTo(1, H/2+5);   ctx.lineTo(8, H/2); }
      ctx.closePath(); ctx.fill();
    }
    renderMini();
    setRangeLabel();
  }
  function fmt(k){ return (k|0).toLocaleString(); }
  function setRangeLabel(){
    if(!els.tlRange) return;
    const n = steps.length;
    if(!n){ els.tlRange.textContent = "—"; return; }
    const i0 = view.start+1, i1 = Math.min(n, view.start+view.span);
    els.tlRange.textContent = (view.span>=n)
      ? ("all " + fmt(n))
      : (fmt(i0) + "–" + fmt(i1) + " of " + fmt(n));
  }

  // ---- the minimap (the whole run) ------------------------------------------
  function renderMini(){
    const wrap = els.mini, cv = els.miniCanvas; if(!wrap || !cv) return;
    const W = wrap.clientWidth || 1, H = wrap.clientHeight || 16;
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    if(cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){
      cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); miniCache = null;
    }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    const n = steps.length; if(!n) return;
    // The static layer (one bar per column, depth-shaded) only changes when the
    // log or the width does, so it is cached and blitted.
    const key = n + "x" + Math.round(W) + "x" + Math.round(H);
    if(!miniCache || miniCache.key !== key){
      const off = document.createElement("canvas");
      off.width = Math.round(W*dpr); off.height = Math.round(H*dpr);
      const oc = off.getContext("2d"); oc.setTransform(dpr,0,0,dpr,0,0);
      const [minD, maxD] = depthRange();
      const lanes = Math.max(1, maxD-minD+1);
      const per = n/W;
      for(let x=0;x<Math.ceil(W);x++){
        const a = Math.floor(x*per), b = Math.min(n, Math.floor((x+1)*per));
        if(b<=a) continue;
        let lo=1e9, hi=-1e9;
        for(let i=a;i<b;i++){ const d=steps[i].d|0; if(d<lo)lo=d; if(d>hi)hi=d; }
        const y0 = (lo-minD)/lanes*H, y1 = (hi-minD+1)/lanes*H;
        oc.fillStyle = colorFor(steps[a].fn, false);
        oc.globalAlpha = .55;
        oc.fillRect(x, y0, 1.05, Math.max(1.5, y1-y0));
      }
      miniCache = { key, canvas: off };
    }
    ctx.drawImage(miniCache.canvas, 0, 0, W, H);
    // the visible slice, framed
    const x0 = view.start/n*W, x1 = Math.min(n, view.start+view.span)/n*W;
    ctx.fillStyle = "rgba(0,0,0,.42)";
    ctx.fillRect(0,0,x0,H); ctx.fillRect(x1,0,W-x1,H);
    ctx.strokeStyle = "#5ea1fb"; ctx.lineWidth = 1;
    ctx.strokeRect(x0+.5, .5, Math.max(2,x1-x0-1), H-1);
    // the playhead's absolute position
    if(idx >= 0){ const px = idx/n*W; ctx.fillStyle="#5ea1fb"; ctx.fillRect(px-.5,0,1.5,H); }
  }

  // ---- pointer / wheel / key plumbing ---------------------------------------
  function flameIndexAt(clientX){
    const r = els.flame.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - r.left, r.width));
    const span = view.span || steps.length;
    const i = view.start + x / Math.max(1,r.width) * span;
    return Math.max(0, Math.min(steps.length-1, Math.floor(i)));
  }
  function miniIndexAt(clientX){
    const r = els.mini.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - r.left, r.width));
    return Math.max(0, Math.min(steps.length-1, Math.floor(x / Math.max(1,r.width) * steps.length)));
  }
  let flameDrag = false, flamePan = null, spaceHeld = false;
  function wireFlame(){
    const f = els.flame; if(!f) return;
    const jump = e=>{ if(!steps.length) return; goto(flameIndexAt(e.clientX)); };
    const wantsPan = e => e.shiftKey || e.altKey || e.button === 1 || spaceHeld;
    f.addEventListener("pointerdown", e=>{
      if(!steps.length) return;
      try{ f.setPointerCapture(e.pointerId); }catch(_){}
      if(wantsPan(e)){
        // PAN: remember where the grab started, in steps-per-pixel terms
        const r = f.getBoundingClientRect();
        flamePan = { x: e.clientX, start: view.start, perPx: (view.span||steps.length)/Math.max(1,r.width) };
        f.classList.add("panning");
        e.preventDefault();
      }else{
        flameDrag = true; jump(e);
      }
    });
    f.addEventListener("pointermove", e=>{
      if(flamePan){
        view.start = flamePan.start - (e.clientX - flamePan.x) * flamePan.perPx;
        clampView(); renderFlame();
        return;
      }
      if(flameDrag) jump(e);
      f.classList.toggle("pan", wantsPan(e) && !flameDrag);
      if(!steps.length){ return; }
      const i = flameIndexAt(e.clientX), s = steps[i]; if(!s) return;
      const r = f.getBoundingClientRect();
      els.flameTip.textContent = (s.fn||"(top level)") + " · line " + s.l + " · #" + (i+1);
      els.flameTip.style.left = Math.max(40, Math.min(e.clientX - r.left, r.width-40)) + "px";
    });
    const end=e=>{
      flameDrag=false; flamePan=null; f.classList.remove("panning");
      try{ f.releasePointerCapture(e.pointerId); }catch(_){}
    };
    f.addEventListener("pointerup", end); f.addEventListener("pointercancel", end);
    f.addEventListener("dblclick", ()=>{ if(steps.length){ fitView(); renderFlame(); } });
    // wheel: zoom about the cursor; shift (or a horizontal wheel) pans instead
    f.addEventListener("wheel", e=>{
      if(!steps.length) return;
      e.preventDefault();
      if(e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)){
        const d = (e.deltaX || e.deltaY);
        panBy(d/40 * Math.max(1, (view.span||steps.length)/12));
      }else{
        zoomBy(e.deltaY > 0 ? ZOOM_STEP : 1/ZOOM_STEP, flameIndexAt(e.clientX));
      }
    }, { passive:false });
    // keyboard, once the timeline has focus
    f.addEventListener("keydown", e=>{
      if(!steps.length) return;
      const page = Math.max(1, Math.round((view.span||steps.length)*0.25));
      if(e.key === "ArrowLeft"){ panBy(-page); }
      else if(e.key === "ArrowRight"){ panBy(page); }
      else if(e.key === "+" || e.key === "="){ zoomBy(1/ZOOM_STEP, viewCenter()); }
      else if(e.key === "-" || e.key === "_"){ zoomBy(ZOOM_STEP, viewCenter()); }
      else if(e.key === "0"){ fitView(); renderFlame(); }
      else if(e.key === "Home"){ goto(0); }
      else if(e.key === "End"){ goto(steps.length-1); }
      else if(e.key === " "){ spaceHeld = true; f.classList.add("pan"); e.preventDefault(); return; }
      else return;
      e.preventDefault();
    });
    f.addEventListener("keyup", e=>{ if(e.key === " "){ spaceHeld = false; f.classList.remove("pan"); } });
    f.addEventListener("blur", ()=>{ spaceHeld = false; f.classList.remove("pan"); });

    // the minimap moves the slice
    const m = els.mini;
    if(m){
      let miniDrag = false;
      const place = e=>{
        if(!steps.length) return;
        view.start = miniIndexAt(e.clientX) - (view.span||steps.length)/2;
        clampView(); renderFlame();
      };
      m.addEventListener("pointerdown", e=>{ if(!steps.length) return; miniDrag=true; try{ m.setPointerCapture(e.pointerId); }catch(_){} place(e); });
      m.addEventListener("pointermove", e=>{ if(miniDrag) place(e); });
      const mend = e=>{ miniDrag=false; try{ m.releasePointerCapture(e.pointerId); }catch(_){} };
      m.addEventListener("pointerup", mend); m.addEventListener("pointercancel", mend);
      if(window.ResizeObserver){ const ro=new ResizeObserver(()=>{ miniCache=null; if(steps.length) renderFlame(); }); ro.observe(m); }
    }
    // keep the canvas crisp on resize
    if(window.ResizeObserver){ const ro=new ResizeObserver(()=>{ if(steps.length) renderFlame(); }); ro.observe(f); }
  }

  function renderStack(){
    const s = stepAt(idx);
    const box = els.stack; box.innerHTML = "";
    if(!s){ box.innerHTML = '<div class="dbg-empty">—</div>'; setCount("stack",0); return; }
    // reconstruct the call stack from the depth history: walk backwards, the most
    // recent step first seen at each shallower depth names that frame.
    const frames = [];
    let need = s.d;
    frames.push({ fn: s.fn || "(top level)", ln: s.l });
    for(let i=idx-1;i>=0 && need>1;i--){
      if(steps[i].d === need-1){ frames.push({ fn: steps[i].fn || "(top level)", ln: steps[i].l }); need--; }
    }
    setCount("stack", frames.length);
    frames.forEach((f,k)=>{
      const el = document.createElement("div");
      el.className = "dbg-frame" + (k===0?" cur":"");
      el.innerHTML = '<span class="fn">'+esc(f.fn)+'</span><span class="ln">:'+f.ln+'</span>';
      el.addEventListener("click", ()=>{ window.AowliEditor.revealPosition(f.ln,1); });
      box.appendChild(el);
    });
  }

  function renderLocals(){
    const s = stepAt(idx);
    const box = els.locals; box.innerHTML = "";
    const vars = (s && s.v) || [];
    setCount("locals", vars.length);
    if(!vars.length){ box.innerHTML = '<div class="dbg-empty">no locals in scope</div>'; }
    const cur = {};
    for(const [name,val] of vars){
      cur[name] = val;
      const changed = prevVars[name] !== undefined && prevVars[name] !== val;
      const el = document.createElement("div");
      el.className = "dbg-var" + (changed?" changed":"");
      el.innerHTML = '<span class="k">'+esc(name)+'</span><span class="eq">=</span><span class="val">'+esc(val)+'</span>';
      box.appendChild(el);
    }
    prevVars = cur;
    // watches
    renderWatches();
  }

  const watches = [];
  function renderWatches(){
    const box = els.watches; if(!box) return;
    box.innerHTML = "";
    const s = stepAt(idx);
    const localsMap = {}; if(s&&s.v) for(const [n,v] of s.v) localsMap[n]=v;
    watches.forEach((w,k)=>{
      const val = evalWatch(w, localsMap);
      const el = document.createElement("div");
      el.className = "dbg-var";
      el.innerHTML = '<span class="k">'+esc(w)+'</span><span class="eq">=</span><span class="val">'+esc(val)+'</span>';
      el.addEventListener("dblclick", ()=>{ watches.splice(k,1); renderWatches(); });
      box.appendChild(el);
    });
    const row = document.createElement("div"); row.className="dbg-watchrow";
    row.innerHTML = '<input placeholder="watch a local name… (Enter)">';
    const inp = row.querySelector("input");
    inp.addEventListener("keydown", e=>{ if(e.key==="Enter" && inp.value.trim()){ watches.push(inp.value.trim()); inp.value=""; renderWatches(); } });
    box.appendChild(row);
    setCount("watches", watches.length);
  }
  function evalWatch(name, localsMap){
    // name may be a dotted head — we only have rendered locals, so match the head
    if(localsMap[name] !== undefined) return localsMap[name];
    const head = name.split(/[.\[]/)[0];
    if(localsMap[head] !== undefined) return localsMap[head] + "  (head only)";
    return "<not in scope>";
  }

  function renderOutput(){
    const s = stepAt(idx);
    const box = els.output;
    const upto = s ? (s.o|0) : finalStdout.length;
    const shown = finalStdout.slice(0, upto);
    const rest = finalStdout.slice(upto);
    box.innerHTML = esc(shown) + (rest ? '<span class="cur">'+esc(rest.slice(0,1))+'</span>'+esc(rest.slice(1)) : '');
    setCount("output", finalStdout.length);
  }
  function renderOutputFinal(){ els.output.textContent = finalStdout + (finalStderr?("\n"+finalStderr):""); }

  function esc(s){ return String(s==null?"":s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  // ---- UI scaffold ----------------------------------------------------------
  function setStatus(t, cls){ els.status.textContent = t; els.status.className = "dbg-status" + (cls?(" "+cls):""); }
  function setControlsEnabled(on){ els.bar.querySelectorAll("button[data-nav]").forEach(b=>b.disabled=!on); if(els.flame) els.flame.style.opacity = on?"1":".5"; }
  const counts = {};
  function setCount(sec, n){ const el = counts[sec]; if(el) el.textContent = n; }

  // The debugger is ATTACHED to the editor as a bottom drawer (#debuggerDock in
  // index.html) — not a floating window. ensureDock builds its UI into
  // #debuggerBody once; showDock/hideDock toggle the drawer.
  let built = false;
  function showDock(){
    const d = document.getElementById("debuggerDock"); if(d) d.hidden = false;
    const b = document.getElementById("dbgTabBtn"); if(b) b.classList.add("on");
    try{ localStorage.setItem("np-dbg-open","1"); }catch(_){}
    if(window.AowliEditor && window.AowliEditor.relayout) window.AowliEditor.relayout();
  }
  function hideDock(){
    const d = document.getElementById("debuggerDock"); if(d) d.hidden = true;
    const b = document.getElementById("dbgTabBtn"); if(b) b.classList.remove("on");
    try{ localStorage.setItem("np-dbg-open","0"); }catch(_){}
    clearEditor();
    if(window.AowliEditor && window.AowliEditor.relayout) window.AowliEditor.relayout();
  }
  function isVisible(){ const d = document.getElementById("debuggerDock"); return !!(d && !d.hidden); }
  function depsReady(){ return !!(window.AowliParser && window.AowliParser.ready && window.AowliPipe && window.AowliPipe.ready); }
  // Auto-capture once the debugger is visible: as soon as the engine is ready and
  // the active file is a .nim/.aowl, run the capture so the panel isn't empty.
  function autoRun(){
    let tries = 0;
    (function tick(){
      if(!isVisible()) return;                              // closed meanwhile
      const nim = !window.AowliWorkspace || window.AowliWorkspace.activeIsNim();
      if(!nim){ setStatus("Open a .nim / .aowl file, then press Restart ↻ to debug it.", ""); return; }
      if(depsReady()){ start(); return; }
      if(++tries < 40) setTimeout(tick, 300);               // wait up to ~12s for the engine
    })();
  }
  // The debug button TOGGLES the drawer (show ⇄ hide). Showing auto-runs a capture.
  function toggle(){ ensureDock(); if(isVisible()) hideDock(); else { showDock(); autoRun(); } }
  function ensureDock(){
    if(built) return;
    built = true;
    injectCss();
    const host = document.getElementById("debuggerBody");
    if(!host) return;   // dock markup absent (old page) — start() is a no-op then
    const body = document.createElement("div"); body.className = "dbg-body";
    body.innerHTML =
      '<div class="dbg-bar">' +
        '<span class="dbg-name">'+IC.bug+' Debugger</span>' +
        '<span class="sep"></span>' +
        btn("restart", IC.restart, "Restart (re-capture)") +
        '<span class="sep"></span>' +
        navbtn("cont-back", IC.rewind, "Reverse-continue (prev breakpoint / start)") +
        navbtn("back", IC.stepback, "Step back") +
        navbtn("fwd", IC.stepfwd, "Step forward") +
        navbtn("cont", IC.play, "Continue (next breakpoint / end)") +
        '<span class="sep"></span>' +
        navbtn("into", IC.into, "Step into") +
        navbtn("over", IC.over, "Step over") +
        navbtn("out", IC.out, "Step out") +
        '<span class="dbg-pos" id="dbgPos">—</span>' +
        '<button class="dbg-close" data-btn="close" title="Close the debugger" data-tip="Close the debugger"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>' +
      '</div>' +
      '<div class="dbg-tl">' +
        '<div class="dbg-flame" id="dbgFlame" tabindex="0"><canvas></canvas>' +
          '<div class="dbg-flame-tip" id="dbgFlameTip"></div>' +
          '<div class="dbg-tlctl">' +
            '<button data-btn="zoomout" title="Zoom out (wheel down)" data-tip="Zoom out">' + IC.zoomout + '</button>' +
            '<button data-btn="zoomin" title="Zoom in (wheel up)" data-tip="Zoom in">' + IC.zoomin + '</button>' +
            '<button data-btn="zoomfit" title="Fit the whole run (double-click)" data-tip="Fit whole run">' + IC.zoomfit + '</button>' +
            '<span class="rng" id="dbgTlRange">—</span>' +
          '</div>' +
        '</div>' +
        '<div class="dbg-mini" id="dbgMini"><canvas></canvas></div>' +
      '</div>' +
      '<div class="dbg-status" id="dbgStatus">Press Debug to capture an execution, then step through it.</div>' +
      '<div class="dbg-panes">' +
        section("stack","Call stack") +
        section("locals","Locals") +
        section("watches","Watch") +
        section("output","Output") +
      '</div>';
    host.appendChild(body);
    els.bar = body.querySelector(".dbg-bar");
    els.pos = body.querySelector("#dbgPos");
    els.status = body.querySelector("#dbgStatus");
    els.flame = body.querySelector("#dbgFlame");
    els.flameCanvas = els.flame.querySelector("canvas");
    els.flameTip = body.querySelector("#dbgFlameTip");
    els.mini = body.querySelector("#dbgMini");
    els.miniCanvas = els.mini.querySelector("canvas");
    els.tlRange = body.querySelector("#dbgTlRange");
    els.stack = body.querySelector('[data-sec="stack"] .dbg-sec-b');
    els.locals = body.querySelector('[data-sec="locals"] .dbg-sec-b');
    els.watches = body.querySelector('[data-sec="watches"] .dbg-sec-b');
    els.output = body.querySelector('[data-sec="output"] .dbg-sec-b');
    els.output.classList.add("dbg-out");
    counts.stack = body.querySelector('[data-sec="stack"] .ct');
    counts.locals = body.querySelector('[data-sec="locals"] .ct');
    counts.watches = body.querySelector('[data-sec="watches"] .ct');
    counts.output = body.querySelector('[data-sec="output"] .ct');

    // wire buttons
    const on = (id, fn) => { const b = body.querySelector('[data-btn="'+id+'"]'); if(b) b.addEventListener("click", fn); };
    on("restart", start);
    on("cont-back", continueBack); on("back", stepBackInto); on("fwd", stepInto); on("cont", continueFwd);
    on("into", stepInto); on("over", stepOver); on("out", stepOut);
    on("close", ()=>{ stop(); hideDock(); });
    on("zoomin", ()=> zoomBy(1/ZOOM_STEP, viewCenter()));
    on("zoomout", ()=> zoomBy(ZOOM_STEP, viewCenter()));
    on("zoomfit", ()=> { fitView(); renderFlame(); });
    wireFlame();
    // section collapse
    body.querySelectorAll(".dbg-sec-h").forEach(h=> h.addEventListener("click", ()=> h.parentElement.classList.toggle("collapsed")));
    setControlsEnabled(false);
  }
  function btn(id, icon, tip){ return '<button data-btn="'+id+'" title="'+tip+'" data-tip="'+tip+'">'+icon+'</button>'; }
  function navbtn(id, icon, tip){ return '<button data-btn="'+id+'" data-nav="1" title="'+tip+'" data-tip="'+tip+'">'+icon+'</button>'; }
  function section(key, label){
    return '<div class="dbg-sec" data-sec="'+key+'">' +
      '<div class="dbg-sec-h"><span class="tw">'+IC.twist+'</span>'+label+'<span class="ct">0</span></div>' +
      '<div class="dbg-sec-b"></div></div>';
  }
  function injectCss(){ if(document.getElementById("dbg-css")) return; const s=document.createElement("style"); s.id="dbg-css"; s.textContent=CSS; document.head.appendChild(s); }

  window.AowliDebugger = { start, stop, toggle, show:()=>{ ensureDock(); showDock(); autoRun(); }, hide:hideDock, isVisible };
  // The debugger drawer starts OPEN by default and AUTO-RUNS a capture (so it's
  // populated, not empty); it remembers if the user later closes it.
  window.AowliDebuggerBoot = function(){
    ensureDock();
    let open = true; try{ if(localStorage.getItem("np-dbg-open")==="0") open = false; }catch(_){}
    if(open){ showDock(); autoRun(); } else hideDock();
  };
})();
