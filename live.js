// live.js — the Live tab of the debugger drawer.
//
// aowli can keep a program RUNNING between edits: a swap republishes the code
// and keeps every variable, an append runs only the lines added since last
// time, and any proc can be called by name against the state that is already
// there. That used to reach the page as two buttons in the Output tab bar and a
// `gen 4` in the footer — every capability real, none of them visible. This is
// the control surface for it, in the same drawer and the same panes as the
// replay debugger, because it answers the same question about a different
// kind of run: what is my program doing, and what is it holding?
//
//   STATE    the program's module-level variables, read out of the running
//            interpreter after every change. A value that moved flashes and
//            says what it was. This is the pane that makes "the code changed
//            and the data survived" something you watch happen.
//   PROCS    the routines this file declares, which ones the last swaps
//            edited or added, and a ▶ to call any that takes no arguments.
//   HISTORY  every start, swap, run and call, in words, with what it changed
//            and what it cost. Signature drift is reported where it happened.
//   OUTPUT   what the running program printed, tagged with the version that
//            printed it.
//
// The prompt under the panes runs one statement against the running program.
// It is added to the END OF THE FILE and run as a new line: the file stays the
// whole truth about what the program has done, so restarting reproduces the
// same state instead of losing whatever was typed into a console.
//
// Everything here READS the session (session.js) and drives it through the
// page's own verbs (`__aowliSessionRun`), so there is one way to start, append
// and swap, not a second copy of it.
(function(){
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const S = () => window.AowliSession;
  const WS = () => window.AowliWorkspace;

  const CSS = `
  .dbg-livebar .lv-btn{width:auto!important;height:26px;padding:0 10px 0 8px;gap:6px;border:1px solid transparent!important;
    border-radius:6px;font-family:inherit;font-size:12px;font-weight:600;line-height:1;color:var(--fg);white-space:nowrap}
  .dbg-livebar .lv-btn[hidden]{display:none!important}
  .dbg-livebar .lv-btn svg{width:13px;height:13px}
  .dbg-livebar .lv-btn.primary{background:var(--accent);color:#fff}
  .dbg-livebar .lv-btn.primary:hover{background:var(--accent);filter:brightness(1.08)}
  .dbg-livebar .lv-btn.danger{color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,transparent)!important}
  .dbg-livebar .lv-btn.danger:hover{background:color-mix(in srgb,var(--err) 12%,transparent)}
  .dbg-livebar .lv-btn kbd{font:10px var(--mono);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:1px 4px;margin-left:2px}
  .lv-switch{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer;padding:0 6px;white-space:nowrap;user-select:none}
  .lv-switch:hover{color:var(--fg)}
  .lv-switch input{position:absolute;opacity:0;pointer-events:none}
  .lv-switch .trk{width:28px;height:16px;border-radius:99px;background:var(--border);position:relative;transition:background .15s;flex:none}
  .lv-switch .trk::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--fg);transition:transform .15s}
  .lv-switch input:checked + .trk{background:var(--accent2)}
  .lv-switch input:checked + .trk::after{transform:translateX(12px);background:#fff}
  .lv-switch input:focus-visible + .trk{outline:2px solid var(--accent);outline-offset:2px}
  /* a narrow drawer keeps every control, as icons with their tooltips */
  .dbg-body{container-type:inline-size}
  .lv-switch .short{display:none}
  @container (max-width: 900px){ .dbg-livebar [data-lv="runnew"] .opt{display:none} .lv-switch .long{display:none} .lv-switch .short{display:inline} }
  @container (max-width: 640px){ .dbg-livebar .opt,.lv-switch .short{display:none} .dbg-livebar .lv-btn{padding:0 8px} }
  @container (max-width: 520px){ .lv-meta{display:none} }
  .lv-meta{margin-left:auto;font:11px var(--mono);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:8px}

  /* the status strip: one sentence, always true, saying what is running */
  .lv-status{display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border);min-height:34px;font-size:12.5px;line-height:1.45}
  .lv-pill{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:10.5px;font-weight:650;line-height:1;letter-spacing:.06em;text-transform:uppercase;
    padding:4px 8px 4px 7px;border-radius:99px;border:1px solid var(--border);color:var(--muted)}
  .lv-pill i{width:7px;height:7px;border-radius:50%;background:currentColor}
  .lv-pill.live{color:var(--accent2);border-color:color-mix(in srgb,var(--accent2) 40%,transparent);background:color-mix(in srgb,var(--accent2) 10%,transparent)}
  .lv-pill.live i{animation:lvPulse 1.8s ease-out infinite}
  .lv-pill.busy{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)}
  .lv-pill.busy i{animation:lvBlink .8s ease-in-out infinite alternate}
  .lv-pill.warn{color:var(--lv-chg);border-color:color-mix(in srgb,var(--lv-chg) 45%,transparent);background:color-mix(in srgb,var(--lv-chg) 10%,transparent)}
  .lv-pill.err{color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,transparent);background:color-mix(in srgb,var(--err) 10%,transparent)}
  @keyframes lvPulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent2) 70%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
  @keyframes lvBlink{from{opacity:.35}to{opacity:1}}
  .lv-msg{color:var(--fg);min-width:0;overflow:hidden;text-overflow:ellipsis}
  .lv-msg b{font-weight:600}
  .lv-msg .m{color:var(--muted)}
  .lv-msg code{font:11.5px var(--mono);background:var(--panel2);border:1px solid var(--border);border-radius:4px;padding:0 4px}
  .lv-msg.err{color:var(--err)} .lv-msg.warn{color:var(--lv-chg)}

  /* the version timeline */
  .lv-tl{position:relative;height:46px;border-bottom:1px solid var(--border);background:var(--bg);overflow-x:auto;overflow-y:hidden;
    scrollbar-width:thin;scrollbar-color:var(--border) transparent}
  .lv-tl-in{position:relative;height:100%;display:flex;align-items:center;padding:0 16px;gap:0;min-width:100%}
  .lv-tl-rail{position:absolute;left:16px;right:16px;top:19px;height:2px;background:var(--border);border-radius:2px}
  .lv-tl-empty{font-size:11.5px;color:var(--muted);font-style:italic;position:relative}
  .lv-node{position:relative;flex:none;display:flex;flex-direction:column;align-items:center;gap:3px;padding:0 9px;cursor:pointer;border:0;background:none;color:var(--muted);font:inherit;height:100%;justify-content:flex-start;padding-top:12px}
  .lv-node .d{width:12px;height:12px;border-radius:50%;background:var(--panel);border:2px solid currentColor;box-sizing:border-box;transition:transform .12s}
  .lv-node .l{font:10px var(--mono);line-height:1;color:var(--muted);white-space:nowrap}
  .lv-node:hover .d{transform:scale(1.25)}
  .lv-node.start{color:var(--accent2)} .lv-node.swap{color:var(--accent)} .lv-node.append{color:var(--brace)}
  .lv-node.call{color:var(--muted);padding:0 5px;padding-top:14px} .lv-node.call .d{width:8px;height:8px;border-width:2px}
  .lv-node.stop{color:var(--muted)} .lv-node.bad{color:var(--err)} .lv-node.pend{color:var(--lv-chg)}
  .lv-node.drift .d{box-shadow:0 0 0 3px color-mix(in srgb,var(--lv-chg) 55%,transparent)}
  .lv-node.sel .d{background:currentColor;transform:scale(1.2)}
  .lv-node.sel .l{color:var(--fg);font-weight:700}
  .lv-node.fresh .d{animation:lvPop .5s ease-out}
  @keyframes lvPop{0%{transform:scale(.2)}60%{transform:scale(1.45)}100%{transform:scale(1)}}

  /* panes: reuse the replay debugger's columns, with live-specific rows */
  /* Four columns when the drawer is wide; a 2x2 grid when it is not, because
     four 150px columns hold nothing readable. Sized by the DRAWER, not the
     window — the editor pane beside the output can be any width. */
  .dbg-live{container-type:inline-size;--lv-chg:var(--warn)}
  /* the theme's --warn is a pale yellow tuned for dark backgrounds; on white a
     changed value needs a darker amber to be readable at all */
  :root[data-theme="light"] .dbg-live,:root[data-theme="light"] .dbg-livebar{--lv-chg:#a86a00}
  .lv-panes{flex:1;min-height:0;display:grid!important;grid-template-columns:1.1fr 1fr 1.35fr 1.2fr;grid-template-rows:minmax(0,1fr);overflow:hidden!important}
  .lv-panes > .dbg-sec{min-height:0;min-width:0;overflow:auto;border-right:1px solid var(--border);border-bottom:0}
  .lv-panes > .dbg-sec:last-child{border-right:0}
  .lv-panes > .dbg-sec.collapsed{overflow:hidden}
  @container (max-width: 980px){
    .lv-panes{grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}
    .lv-panes > .dbg-sec:nth-child(2n){border-right:0}
    .lv-panes > .dbg-sec:nth-child(-n+2){border-bottom:1px solid var(--border)}
  }
  @container (max-width: 520px){
    .lv-panes{grid-template-columns:1fr;grid-template-rows:repeat(4,minmax(120px,1fr));overflow:auto!important}
    .lv-panes > .dbg-sec{border-right:0;border-bottom:1px solid var(--border)}
  }
  .lv-empty{padding:10px 12px;color:var(--muted);font-size:12px;line-height:1.5}
  .lv-empty b{color:var(--fg);font-weight:600}
  .lv-var{display:grid;grid-template-columns:minmax(40px,max-content) auto 1fr;gap:0 8px;padding:3px 12px;font:12px/1.5 var(--mono);align-items:baseline;border-left:2px solid transparent}
  .lv-var .k{color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
  .lv-var .eq{color:var(--muted)}
  .lv-var .v{color:var(--fg);white-space:pre-wrap;word-break:break-word;min-width:0;max-height:4.5em;overflow:hidden;cursor:default}
  .lv-var .v.long{cursor:pointer;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}
  .lv-var .v.open{max-height:none;-webkit-mask-image:none;mask-image:none}
  .lv-var .was{grid-column:3;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lv-var.chg{border-left-color:var(--lv-chg);animation:lvFlash 1.8s ease-out}
  .lv-var.chg .v{color:var(--lv-chg)}
  .lv-var.new{border-left-color:var(--accent2)}
  @keyframes lvFlash{0%{background:color-mix(in srgb,var(--lv-chg) 22%,transparent)}100%{background:transparent}}
  .lv-tag{font-size:9.5px;font-weight:650;line-height:1;letter-spacing:.05em;flex:none;text-transform:uppercase;padding:2px 5px;border-radius:4px;white-space:nowrap}
  .lv-tag.new{color:var(--accent2);background:color-mix(in srgb,var(--accent2) 14%,transparent)}
  .lv-tag.edit{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
  .lv-tag.gone{color:var(--muted);background:var(--panel2);text-decoration:line-through}

  .lv-proc{display:flex;align-items:center;gap:7px;padding:3px 8px 3px 12px;font:12px/1.5 var(--mono);cursor:pointer;min-height:26px}
  .lv-proc:hover{background:var(--panel2)}
  .lv-proc .kw{color:var(--muted);font-size:10.5px;flex:none;width:30px}
  .lv-proc .nm{color:var(--brace)}
  .lv-proc .sig{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
  .lv-proc .ret{color:var(--accent2);flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lv-proc .call{flex:none;width:22px;height:22px;border:1px solid var(--border);border-radius:5px;background:var(--panel);color:var(--accent2);
    display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;opacity:.8}
  .lv-proc .call:hover{opacity:1;background:color-mix(in srgb,var(--accent2) 14%,var(--panel))}
  .lv-proc .call:disabled{opacity:.3;cursor:default;background:var(--panel)}
  .lv-proc .call svg{width:10px;height:10px}
  .lv-proc .call.nope{visibility:hidden}

  .lv-ev{padding:6px 12px 6px 10px;border-left:2px solid transparent;cursor:pointer;font-size:12px;line-height:1.45}
  .lv-ev:hover{background:var(--panel2)}
  .lv-ev.sel{background:var(--brace-bg);border-left-color:var(--brace)}
  .lv-ev .h{display:flex;align-items:baseline;gap:7px}
  .lv-ev .v{font:600 10.5px var(--mono);flex:none;min-width:22px}
  .lv-ev .t{color:var(--fg);font-weight:550;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lv-ev .when{margin-left:auto;color:var(--muted);font:10.5px var(--mono);white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
  .lv-ev .d{color:var(--muted);margin:2px 0 0 29px;font-size:11.5px}
  .lv-ev .d code{font:11px var(--mono);color:var(--fg)}
  .lv-ev .d.err{color:var(--err)} .lv-ev .d.warn{color:var(--lv-chg)}
  .lv-ev.start .v{color:var(--accent2)} .lv-ev.swap .v{color:var(--accent)} .lv-ev.append .v{color:var(--brace)}
  .lv-ev.call .v,.lv-ev.stop .v{color:var(--muted)} .lv-ev.bad .v{color:var(--err)} .lv-ev.pend .v{color:var(--lv-chg)}

  .lv-out{font:12px/1.5 var(--mono);padding:4px 0 8px}
  .lv-chunk{display:grid;grid-template-columns:30px 1fr;border-left:2px solid transparent}
  .lv-chunk.sel{background:var(--brace-bg);border-left-color:var(--brace)}
  .lv-chunk .g{color:var(--muted);font-size:10px;text-align:right;padding:2px 8px 0 0;user-select:none;opacity:.8}
  .lv-chunk pre{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--fg);font:inherit;padding-right:10px}
  .lv-chunk pre.e{color:var(--err)}

  /* the prompt */
  .lv-console{display:flex;align-items:center;gap:8px;padding:0 10px 0 12px;border-top:1px solid var(--border);height:36px;flex:none;background:var(--panel)}
  .lv-console .pr{color:var(--accent2);font:700 14px var(--mono);flex:none}
  .lv-console input{flex:1;min-width:0;height:26px;border:0;background:transparent;color:var(--fg);font:12.5px var(--mono);outline:none}
  .lv-console input::placeholder{color:var(--muted);opacity:.8}
  .lv-console input:disabled{cursor:not-allowed}
  .lv-console .hint{font-size:11px;color:var(--muted);white-space:nowrap;flex:none}
  .lv-console .hint kbd{font:10px var(--mono);border:1px solid var(--border);border-radius:4px;padding:1px 4px}
  .lv-console.busy .pr{animation:lvBlink .6s ease-in-out infinite alternate}
  .lv-console.bad input{color:var(--err)}
  @media (prefers-reduced-motion: reduce){ .lv-pill i,.lv-var.chg,.lv-node.fresh .d,.lv-console.busy .pr{animation:none!important} }
  @media (max-width:720px){ .lv-console .hint,.lv-meta{display:none} }`;

  const IC = {
    play:'<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3l8 5-8 5z"/></svg>',
    stop:'<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.3"/></svg>',
    restart:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.2v3h-3"/></svg>',
    runnew:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h7M3 8h5"/><path d="M9.5 10.5l2 2 2-2M11.5 7v5.5"/></svg>',
    twist:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
    clear:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };

  // ---- model -----------------------------------------------------------------
  let els = null, active = false, busy = false;
  let events = [];                 // the history, oldest first
  let evSeq = 0;
  let selectedId = null;           // the event the timeline / history / output highlight
  let lastErr = "";                // the last verb's refusal, until the next success
  let sessFile = null;             // { projectId, path } the running program came from
  let sessName = "";
  let globals = [], globalsErr = "", prevVals = new Map(), changedAt = new Map(), newNames = new Set();
  let routines = new Map();        // name -> normalized typed NIF, as last landed
  let procMarks = new Map();       // name -> { tag: "new"|"edit", ver }
  let rets = new Map();            // name -> last return, rendered
  let strayOut = [];               // output that arrived before the verb that printed it
  let pendingStart = null;         // a start that published without running; the append completes it
  let conHist = [], conPos = -1;

  // Versions count from the start of THIS run: v1 is the program as started,
  // and each change that lands adds one. The interpreter's own generation also
  // moves for the internal publish-then-run a start does, which would make a
  // fresh program read "v2".
  let baseGen = 0;
  const ver = (gen) => "v" + Math.max(1, (gen | 0) - baseGen + 1);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  const clock = (t) => { const d = new Date(t); return d.toTimeString().slice(0, 8); };
  const msTxt = (ms) => ms < 1 ? "<1 ms" : ms < 100 ? ms.toFixed(1) + " ms" : Math.round(ms) + " ms";
  const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));

  // ---- which routines a new version actually changed ---------------------------
  // Compared on the TYPED artifact, one top-level routine at a time, with line
  // information stripped — so moving a proc, editing a comment or adding a line
  // above it is not an edit, and changing a single literal inside it is. The
  // source text would say "edited" for every proc below a new blank line.
  const ROUTINE_TAGS = new Set(["proc", "func", "iterator", "converter", "method", "template", "macro"]);
  function topRoutines(snif){
    const out = new Map();
    if(!snif) return out;
    const n = snif.length;
    let i = snif.indexOf("(stmts");
    if(i < 0) return out;
    // step over the root's own tag
    i += 6; while(i < n && snif[i] !== " " && snif[i] !== "\n" && snif[i] !== "(" && snif[i] !== ")") i++;
    let depth = 1;
    while(i < n && depth > 0){
      const c = snif[i];
      if(c === '"' || c === "'"){ i = skipLit(snif, i); continue; }
      if(c === "("){
        if(depth === 1){
          const end = subtreeEnd(snif, i);
          const tag = snif.slice(i + 1, i + 1 + 12).split(/[\s()@~,]/)[0];
          if(ROUTINE_TAGS.has(tag)){
            const text = snif.slice(i, end);
            const m = /^\([^\s()]*\s+:([^\s()]+)/.exec(text);
            if(m){
              const name = m[1].replace(/[@~].*$/, "").split(".")[0].replace(/\\([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
              const prev = out.get(name);
              out.set(name, (prev ? prev + "\u0000" : "") + stripLineInfo(text));
            }
          }
          i = end; continue;
        }
        depth++; i++; continue;
      }
      if(c === ")"){ depth--; i++; continue; }
      i++;
    }
    return out;
  }
  function skipLit(s, i){
    const q = s[i]; i++;
    while(i < s.length && s[i] !== q){ if(s[i] === "\\") i++; i++; }
    return i + 1;
  }
  function subtreeEnd(s, i){
    let d = 0;
    while(i < s.length){
      const c = s[i];
      if(c === '"' || c === "'"){ i = skipLit(s, i); continue; }
      if(c === "(") d++;
      else if(c === ")"){ d--; if(d === 0) return i + 1; }
      i++;
    }
    return s.length;
  }
  function stripLineInfo(t){
    let o = "", i = 0;
    while(i < t.length){
      const c = t[i];
      if(c === '"' || c === "'"){ const e = skipLit(t, i); o += t.slice(i, e); i = e; continue; }
      if(c === "@" || c === "~"){ i++; while(i < t.length && !/[\s()"']/.test(t[i])) i++; continue; }
      o += c; i++;
    }
    return o.replace(/\s+/g, " ");
  }

  // The routines THIS FILE declares, from the editor's own index — so the
  // generic instances and stdlib iterators a typed artifact also carries at its
  // top level never show up as "your procs".
  function declaredRoutines(){
    const L = window.AowliLsp || window.AowliLSP;
    const syms = (L && L.index && L.index.symbols) || [];
    const out = [], seen = new Set();
    for(const s of syms){
      if(s.container || !ROUTINE_TAGS.has(s.kind)) continue;
      const key = s.name + "(" + (s.params || []).map(p => p.type || "").join(",") + ")";
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  function diffRoutines(snif, gen){
    const now = topRoutines(snif);
    const mine = new Set(declaredRoutines().map(s => s.name));
    const edited = [], added = [], removed = [];
    for(const n of mine) ownedOnce.add(n);
    if(routines.size){
      for(const [name, text] of now){
        if(!mine.has(name)) continue;
        if(!routines.has(name)){ added.push(name); procMarks.set(name, { tag: "new", ver: ver(gen) }); }
        else if(routines.get(name) !== text){ edited.push(name); procMarks.set(name, { tag: "edit", ver: ver(gen) }); }
      }
      // A routine that was the file's own and is no longer in the artifact.
      for(const name of routines.keys())
        if(!now.has(name) && ownedOnce.has(name)){ removed.push(name); procMarks.delete(name); }
    }
    routines = now;
    return { edited, added, removed };
  }
  const ownedOnce = new Set();
  function rememberMine(){ for(const s of declaredRoutines()) ownedOnce.add(s.name); }

  // ---- the session file ------------------------------------------------------
  function activeRef(){ const w = WS(); return w && w.activeRef ? { projectId: w.activeRef.projectId, path: w.activeRef.path } : null; }
  function sameRef(a, b){ return !!(a && b && a.projectId === b.projectId && a.path === b.path); }
  function refName(r){ return r ? String(r.path).split("/").pop() : ""; }
  function scriptSession(){ const s = S(); return !!(s && s.state !== "stopped"); }
  // Does an edit to the file on screen belong in the running program? Only when
  // it IS the program: a second open file typed into must never be swapped over
  // the first one's state.
  function ownsActiveFile(){
    const s = S();
    if(!s || s.state === "stopped") return false;
    return sameRef(sessFile, activeRef());
  }

  // ---- the verbs, as the drawer drives them -----------------------------------
  async function startLive(){
    const s = S(); if(!s || busy) return;
    if(window.AowliWorkspace && !window.AowliWorkspace.activeIsNim()){ lastErr = "Open a .nim file to run it live."; render(); return; }
    setBusy(true);
    try{
      if(s.state !== "stopped") await s.stop();
      resetModel();
      sessFile = activeRef(); sessName = refName(sessFile) || "this file";
      rememberMine();
      if(window.__aowliSessionRun) await window.__aowliSessionRun(true);
      else lastErr = "this page cannot start a live session";
    }finally{ setBusy(false); }
    await refreshGlobals();
    render();
  }
  async function stopLive(){
    const s = S(); if(!s || busy || s.state === "stopped") return;
    setBusy(true);
    try{ await s.stop(); }finally{ setBusy(false); }
    globals = []; prevVals = new Map(); render();
  }
  async function runNew(){
    if(!scriptSession() || busy) return;
    if(!ownsActiveFile()){ lastErr = "Switch back to " + sessName + " to run its new lines."; render(); return; }
    setBusy(true);
    try{ await window.__aowliSessionRun(false); }finally{ setBusy(false); }
    await refreshGlobals();
    render();
  }
  async function callProc(name){
    const s = S(); if(!s || s.state === "stopped" || busy) return;
    setBusy(true);
    try{ await s.call(name); }finally{ setBusy(false); }
    await refreshGlobals();
    render();
  }

  // The prompt: add the statement to the end of the file, then run new lines.
  async function submitConsole(){
    const inp = els.conInput; const text = inp.value.replace(/\s+$/, "");
    if(!text.trim()) return;
    if(!scriptSession()){ flashConsole(); return; }
    if(!ownsActiveFile()){ lastErr = "Switch back to " + sessName + " to run lines in it."; render(); return; }
    const ed = window.AowliEditor && window.AowliEditor.getEditor && window.AowliEditor.getEditor();
    const monaco = window.AowliEditor && window.AowliEditor.getMonaco && window.AowliEditor.getMonaco();
    const model = ed && ed.getModel();
    if(!model || !monaco){ flashConsole(); return; }
    const last = model.getLineCount(), lastLen = model.getLineMaxColumn(last);
    const tail = model.getValueInRange(new monaco.Range(last, 1, last, lastLen));
    const insert = (tail.length ? "\n" : "") + text + "\n";
    ed.pushUndoStop();
    ed.executeEdits("aowli-live", [{ range: new monaco.Range(last, lastLen, last, lastLen), text: insert, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    try{ ed.revealLine(model.getLineCount()); }catch(_){}
    conHist.push(text); conPos = conHist.length;
    inp.value = "";
    // The appended text must type-check before it can run; `sessionRun` checks
    // the buffer itself, so there is nothing to wait for but the edit landing.
    await runNew();
  }
  function flashConsole(){
    if(!els) return;
    els.console.classList.add("bad");
    setTimeout(() => els && els.console.classList.remove("bad"), 500);
  }

  function setBusy(on){ busy = on; if(els) els.console.classList.toggle("busy", on); renderBar(); }

  function resetModel(){
    events = []; selectedId = null; lastErr = ""; strayOut = []; pendingStart = null;
    globals = []; globalsErr = ""; prevVals = new Map(); changedAt = new Map(); newNames = new Set();
    routines = new Map(); procMarks = new Map(); rets = new Map();
  }

  // ---- state ---------------------------------------------------------------
  async function refreshGlobals(){
    const s = S();
    if(!s || s.state === "stopped"){ globals = []; return; }
    let r;
    try{ r = await s.globals(); }catch(e){ r = { ok: false, err: String(e && e.message || e) }; }
    if(!r || !r.ok){ globalsErr = (r && r.err) || "the variables could not be read"; globals = []; return; }
    globalsErr = "";
    const next = r.globals || [];
    const nextMap = new Map(next.map(g => [g.n, g.v]));
    const hadAny = prevVals.size > 0;
    for(const g of next){
      if(!prevVals.has(g.n)){ if(hadAny) newNames.add(g.n); }
      else if(prevVals.get(g.n) !== g.v){ changedAt.set(g.n, { was: prevVals.get(g.n), t: performance.now() }); }
    }
    globals = next;
    prevVals = nextMap;
  }

  // ---- listening to the session ------------------------------------------------
  function onVerb(v){
    // A session this drawer did not start (Run pressed in the header) is still
    // reported: the drawer is the place that says what is running.
    if(v.kind === "start" && !sessFile){ sessFile = activeRef(); sessName = refName(sessFile); }

    const ev = { id: ++evSeq, kind: v.kind, ok: v.ok, err: v.err, gen: v.gen, t: Date.now(), ms: v.ms,
                 out: "", stderr: v.stderr || "", newGlobals: v.newGlobals, drift: v.drift || [],
                 ran: v.ran | 0, name: v.name || "", ret: v.ret || null, pending: v.pending,
                 changes: { edited: [], added: [], removed: [] } };
    ev.out = strayOut.join(""); strayOut = [];

    if(v.ok && (v.kind === "start" || v.kind === "swap" || v.kind === "append")){
      if(v.kind === "start"){ routines = new Map(); procMarks = new Map(); }
      ev.changes = diffRoutines(v.snif, v.gen);
    }
    if(v.kind === "call" && v.ok) rets.set(v.name, renderRet(v.ret));
    if(v.kind === "stop"){ rets = new Map(); }

    // A start that only PUBLISHED (the REPL shape `sessionRun` uses) is
    // completed by the append that follows it: one event, "started, ran N".
    if(v.kind === "start" && v.ok && v.runInit === false){ pendingStart = ev; return; }
    if(v.kind === "start" && v.ok) baseGen = v.gen;
    if(v.kind === "append" && pendingStart){
      const st = pendingStart; pendingStart = null;
      baseGen = v.gen;
      st.ok = v.ok; st.err = v.err; st.ran = ev.ran; st.gen = v.gen; st.ms += v.ms;
      st.out = (st.out || "") + ev.out; st.stderr = (st.stderr || "") + ev.stderr; st.t = ev.t;
      push(st); return;
    }
    if(v.kind === "swap" && !v.ok && /inside a call/.test(v.err || "")){ ev.kind = "pend"; ev.ok = true; }
    push(ev);
  }
  function push(ev){
    ev.vl = ver(ev.gen);
    if(ev.ok) lastErr = ""; else lastErr = ev.err || "refused";
    events.push(ev);
    if(events.length > 400) events.splice(0, events.length - 400);
    selectedId = ev.id;
    freshId = ev.id;
    if(active) refreshGlobals().then(render); else render();
  }
  let freshId = 0;
  function onOut(e){
    // Output lands BEFORE the verb that produced it reports; hold it until then.
    if(!e || !e.text) return;
    strayOut.push(e.text);
  }
  function renderRet(r){
    if(!r) return "";
    switch(r.k){
      case "i": case "f": return String(r.v);
      case "b": return r.v ? "true" : "false";
      case "s": return JSON.stringify(String(r.v));
      default: return "";
    }
  }

  // ---- rendering ---------------------------------------------------------------
  function render(){
    if(!els) return;
    renderBar(); renderStatus(); renderTimeline(); renderState(); renderProcs(); renderHistory(); renderOutput(); renderConsole();
    syncHeader();
  }

  function renderBar(){
    if(!els) return;
    const s = S(); const on = !!(s && s.state !== "stopped");
    const b = els.bar;
    b.start.hidden = on; b.stop.hidden = !on;
    b.start.disabled = busy; b.stop.disabled = busy;
    b.restart.disabled = busy || !on;
    b.runnew.disabled = busy || !on;
    b.stop.setAttribute("data-tip", "Stop — end the program and throw its state away");
    b.instant.checked = !!(s && s.liveMode);
    const bits = [];
    if(on) bits.push(ver(s.gen));
    if(on && s.heap) bits.push((s.heap / 1048576).toFixed(1) + " MB");
    b.meta.textContent = bits.join(" · ");
  }

  function renderStatus(){
    const s = S(); const on = !!(s && s.state !== "stopped");
    const swaps = events.filter(e => e.kind === "swap" && e.ok).length;
    let pill = ["", "Stopped"], msg = "", cls = "";
    if(busy){ pill = ["busy", "Working"]; msg = '<span class="m">talking to the interpreter…</span>'; }
    else if(lastErr){ pill = ["err", "Refused"]; msg = esc(lastErr); cls = "err"; }
    else if(on && s.pending){ pill = ["warn", "Waiting"]; msg = "A change is waiting — the program is in the middle of a call. It lands at the next safe point."; cls = "warn"; }
    else if(on && !ownsActiveFile()){ pill = ["warn", "Live"]; msg = "The running program is <code>" + esc(sessName) + "</code> — edits to this file don't reach it."; cls = "warn"; }
    else if(on){
      pill = ["live", "Live"];
      msg = "<b>" + esc(sessName) + "</b> is running · " + ver(s.gen) + ' <span class="m">· ' +
        (swaps ? "its variables survived " + plural(swaps, "code change") : "edit the code and it swaps in without restarting") + "</span>";
    }
    else{
      msg = events.length
        ? 'Stopped. <span class="m">Press <b>Start</b> to run the file again from the top.</span>'
        : '<b>Start</b> runs this file once and <b>keeps it running</b>. <span class="m">Then edit it: each change swaps into the running program, and its variables keep their values.</span>';
    }
    els.status.innerHTML = '<span class="lv-pill ' + pill[0] + '"><i></i>' + pill[1] + '</span><span class="lv-msg ' + cls + '">' + msg + "</span>";
  }

  function nodeKind(e){ return !e.ok ? "bad" : e.kind; }
  function nodeLabel(e){
    if(!e.ok) return "✕";
    if(e.kind === "tick") return "";
    if(e.kind === "call") return "ƒ";
    if(e.kind === "stop") return "■";
    if(e.kind === "pend") return "…";
    return e.vl || ver(e.gen);
  }
  function renderTimeline(){
    const tl = els.tl;
    const shown = events.filter(e => e.kind !== "tick");
    if(!shown.length){
      tl.innerHTML = '<div class="lv-tl-in"><span class="lv-tl-empty">Versions of the running program appear here — one for every change that lands.</span></div>';
      return;
    }
    let h = '<div class="lv-tl-in"><div class="lv-tl-rail"></div>';
    for(const e of shown){
      const k = nodeKind(e);
      const cls = "lv-node " + k + (e.drift && e.drift.length ? " drift" : "") + (e.id === selectedId ? " sel" : "") + (e.id === freshId ? " fresh" : "");
      h += '<button class="' + cls + '" data-ev="' + e.id + '" data-tip="' + esc(eventTitle(e) + " · " + clock(e.t)) + '"><span class="d"></span><span class="l">' + esc(nodeLabel(e)) + "</span></button>";
    }
    h += "</div>";
    tl.innerHTML = h;
    freshId = 0;
    tl.scrollLeft = tl.scrollWidth;
  }

  function renderState(){
    const s = S(); const on = !!(s && s.state !== "stopped");
    setCount("state", on ? globals.length : 0);
    if(!on){ els.state.innerHTML = '<div class="lv-empty">Nothing is running. <b>Start</b> the program and its variables appear here — then watch them survive your edits.</div>'; return; }
    if(globalsErr){ els.state.innerHTML = '<div class="lv-empty">' + esc(globalsErr) + "</div>"; return; }
    if(!globals.length){ els.state.innerHTML = '<div class="lv-empty">This program has no module-level variables. Declare one with <b>var</b> at the top level and it shows up here.</div>'; return; }
    const now = performance.now();
    let h = "";
    for(const g of globals){
      const ch = changedAt.get(g.n);
      const recent = ch && now - ch.t < 2500;
      const isNew = newNames.has(g.n);
      const long = g.v.length > 120 || g.v.split("\n").length > 3;
      h += '<div class="lv-var' + (recent ? " chg" : "") + (isNew ? " new" : "") + '">' +
        '<span class="k" data-tip="' + esc(g.n) + '">' + esc(g.n) + '</span><span class="eq">=</span>' +
        '<span class="v' + (long ? " long" : "") + '"' + (long ? ' data-tip="Click to expand"' : "") + ">" + esc(g.v) + "</span>" +
        (recent ? '<span></span><span></span><span class="was">was ' + esc(ch.was.length > 60 ? ch.was.slice(0, 60) + "…" : ch.was) + "</span>" : "") +
        "</div>";
    }
    els.state.innerHTML = h;
    // Clear the "changed" marks once their flash has played, so the NEXT change
    // is the one that stands out.
    clearTimeout(renderState.t);
    renderState.t = setTimeout(() => { if(active) renderState(); }, 2600);
  }

  function renderProcs(){
    const list = declaredRoutines();
    setCount("procs", list.length);
    if(!list.length){ els.procs.innerHTML = '<div class="lv-empty">No procs in this file yet.</div>'; return; }
    const s = S(); const on = !!(s && s.state !== "stopped") && ownsActiveFile();
    let h = "";
    for(const p of list){
      const params = p.params || [];
      const sig = "(" + params.map(x => x.name + (x.type ? ": " + x.type : "")).join(", ") + ")" + (p.ret ? ": " + p.ret : "");
      const callable = params.length === 0 && (p.kind === "proc" || p.kind === "func");
      const mark = procMarks.get(p.name);
      const ret = rets.get(p.name);
      h += '<div class="lv-proc" data-proc="' + esc(p.name) + '">' +
        '<button class="call' + (callable ? "" : " nope") + '" data-call="' + esc(p.name) + '"' + (on && callable && !busy ? "" : " disabled") +
          ' data-tip="' + (callable ? "Call " + esc(p.name) + "() in the running program" : "") + '">' + IC.play + "</button>" +
        '<span class="sig"><span class="nm">' + esc(p.name) + "</span>" + esc(sig) + "</span>" +
        (ret ? '<span class="ret" data-tip="last returned">→ ' + esc(ret) + "</span>" : "") +
        (mark ? '<span class="lv-tag ' + (mark.tag === "new" ? "new" : "edit") + '">' + (mark.tag === "new" ? "new " : "edited ") + mark.ver + "</span>" : "") +
        "</div>";
    }
    els.procs.innerHTML = h;
  }

  function eventTitle(e){
    if(!e.ok) return (e.kind === "swap" ? "Swap refused" : e.kind === "append" ? "Run refused" : e.kind === "call" ? "Call failed" : e.kind === "start" ? "Start failed" : "Refused");
    switch(e.kind){
      case "start": return e.ran ? "Started · ran " + plural(e.ran, "statement") : "Started";
      case "swap": {
        const c = e.changes || {}; const n = (c.edited || []).length + (c.added || []).length + (c.removed || []).length;
        return n ? "Swapped in · state kept" : "Swapped in · no routine changed";
      }
      case "append": return e.ran ? "Ran " + plural(e.ran, "new line") : "No new lines to run";
      case "call": return "Called " + e.name + "()" + (renderRet(e.ret) ? " → " + renderRet(e.ret) : "");
      case "stop": return "Stopped · state discarded";
      case "pend": return "Change waiting for a safe point";
      case "tick": return "Output";
    }
    return e.kind;
  }
  function eventDetails(e){
    const d = [];
    if(!e.ok && e.err) d.push(["err", esc(e.err)]);
    const c = e.changes || {};
    const parts = [];
    if(c.edited && c.edited.length) parts.push("edited " + c.edited.map(n => "<code>" + esc(n) + "()</code>").join(", "));
    if(c.added && c.added.length) parts.push("added " + c.added.map(n => "<code>" + esc(n) + "()</code>").join(", "));
    if(c.removed && c.removed.length) parts.push("removed " + c.removed.map(n => "<code>" + esc(n) + "()</code>").join(", "));
    if(parts.length && e.kind !== "start") d.push(["", parts.join(" · ")]);
    if(e.newGlobals) d.push(["", plural(e.newGlobals, "new variable") + " initialized — the rest kept their values"]);
    for(const line of (e.drift || [])){
      const sym = String(line).split(/\s/)[0].split(".")[0];
      d.push(["warn", "<code>" + esc(sym) + "</code> changed its parameters while old code still calls it — a call with the wrong type now raises instead of answering wrongly. Restart to clear it."]);
    }
    if(e.stderr) d.push(["err", esc(String(e.stderr).trim().split("\n").slice(0, 3).join(" · "))]);
    return d;
  }
  function renderHistory(){
    const shown = events.filter(e => e.kind !== "tick");
    setCount("history", shown.length);
    if(!shown.length){ els.history.innerHTML = '<div class="lv-empty">Every start, code change, new line and call is recorded here, with what it changed.</div>'; return; }
    let h = "";
    for(let i = shown.length - 1; i >= 0; i--){
      const e = shown[i];
      const k = nodeKind(e);
      const label = nodeLabel(e) || "·";
      h += '<div class="lv-ev ' + k + (e.id === selectedId ? " sel" : "") + '" data-ev="' + e.id + '">' +
        '<div class="h"><span class="v">' + esc(label) + '</span><span class="t">' + esc(eventTitle(e)) + '</span><span class="when">' + clock(e.t) + " · " + msTxt(e.ms) + "</span></div>";
      for(const [cls, txt] of eventDetails(e)) h += '<div class="d ' + cls + '">' + txt + "</div>";
      h += "</div>";
    }
    els.history.innerHTML = h;
  }

  function renderOutput(){
    const withOut = events.filter(e => e.out || (e.stderr && e.kind !== "tick"));
    let lines = 0;
    let h = "";
    for(const e of withOut){
      if(e.out){
        lines += e.out.replace(/\n$/, "").split("\n").length;
        h += '<div class="lv-chunk' + (e.id === selectedId ? " sel" : "") + '" data-ev="' + e.id + '"><span class="g">' + esc(e.kind === "tick" ? "·" : (e.vl || ver(e.gen))) + "</span><pre>" + esc(e.out.replace(/\n$/, "")) + "</pre></div>";
      }
      if(e.stderr) h += '<div class="lv-chunk" data-ev="' + e.id + '"><span class="g">!</span><pre class="e">' + esc(String(e.stderr).trim()) + "</pre></div>";
    }
    setCount("output", lines);
    els.output.innerHTML = h ? '<div class="lv-out">' + h + "</div>" : '<div class="lv-empty">What the running program prints shows up here, marked with the version that printed it.</div>';
    const sel = els.output.querySelector(".lv-chunk.sel");
    const sec = els.output.closest(".dbg-sec");
    if(sel && sec) sel.scrollIntoView({ block: "nearest" });
    else if(sec) sec.scrollTop = sec.scrollHeight;
  }

  function renderConsole(){
    const s = S();
    const ok = scriptSession() && ownsActiveFile();
    const inp = els.conInput;
    inp.disabled = !ok;
    inp.placeholder = ok ? "Run a statement in the running program, e.g. echo hits"
      : scriptSession() ? "Switch back to " + sessName + " to run lines in it"
      : "Start the program to run statements against it";
  }

  function setCount(sec, n){ const el = els.counts[sec]; if(el) el.textContent = n; }

  // Keep the header's Live button and the Run button honest about what they do
  // right now.
  function syncHeader(){
    const s = S();
    const on = !!(s && s.state !== "stopped");
    const btn = document.getElementById("liveTopBtn");
    if(btn){
      btn.classList.toggle("on", on);
      const lbl = btn.querySelector(".lbl");
      if(lbl) lbl.textContent = on ? "Live · " + ver(s.gen) : "Go live";
      btn.setAttribute("data-tip", on
        ? "The program is running live — open its state, versions and prompt"
        : "Go live — run this file and keep it running, so edits swap in without losing its state");
    }
    const runLbl = document.getElementById("runLabel");
    if(runLbl){
      const appending = scriptSession() && ownsActiveFile();
      runLbl.textContent = appending ? "Run new lines" : "Run";
      const rb = document.getElementById("runBtn");
      if(rb) rb.classList.toggle("appendmode", appending);
    }
    const chip = document.getElementById("sessState");
    if(chip){
      chip.hidden = !on;
      if(on){
        chip.className = "sessstate " + (s.pending ? "pending" : "live");
        chip.textContent = "● " + (s.pending ? "waiting" : "live") + " · " + ver(s.gen);
        chip.setAttribute("data-tip", "The program is running live. Click to open the Live drawer.");
      }
    }
  }

  // ---- mount -------------------------------------------------------------------
  function section(key, label, extra){
    return '<div class="dbg-sec" data-sec="' + key + '"><div class="dbg-sec-h"><span class="tw">' + IC.twist + "</span>" + label +
      (extra || "") + '<span class="ct">0</span></div><div class="dbg-sec-b"></div></div>';
  }
  function mount(barHost, bodyHost){
    if(els || !barHost || !bodyHost) return;
    if(!document.getElementById("live-css")){ const st = document.createElement("style"); st.id = "live-css"; st.textContent = CSS; document.head.appendChild(st); }
    barHost.innerHTML =
      '<span class="sep"></span>' +
      '<button class="lv-btn primary" data-lv="start" data-tip="Start — run this file once and keep it running">' + IC.play + "<span>Start</span></button>" +
      '<button class="lv-btn danger" data-lv="stop" hidden>' + IC.stop + "<span>Stop</span></button>" +
      '<button class="lv-btn" data-lv="restart" data-tip="Restart — throw the state away and run the file again from the top">' + IC.restart + '<span class="opt">Restart</span></button>' +
      '<button class="lv-btn" data-lv="runnew" data-tip="Run new lines — run only the statements added to the end of the file since the last run (Ctrl+Enter)">' + IC.runnew + '<span class="opt">Run new lines</span><kbd class="opt">⌃⏎</kbd></button>' +
      '<span class="sep"></span>' +
      '<label class="lv-switch" data-tip="Apply edits as you type — every edit that type-checks is swapped into the running program immediately. Off: edits wait for Run new lines."><input type="checkbox" data-lv="instant"><span class="trk"></span><span class="long">Apply edits as you type</span><span class="short">Auto-apply</span></label>' +
      '<span class="lv-meta" data-lv="meta"></span>';
    bodyHost.innerHTML =
      '<div class="lv-status" data-lv="status"></div>' +
      '<div class="lv-tl" data-lv="tl"></div>' +
      '<div class="dbg-panes lv-panes">' +
        section("state", "State") + section("procs", "Procs") + section("history", "History") + section("output", "Output") +
      "</div>" +
      '<div class="lv-console" data-lv="console"><span class="pr">›</span><input type="text" spellcheck="false" autocomplete="off" aria-label="Run a statement in the running program" data-lv="con">' +
        '<span class="hint" data-tip="The statement is added to the end of the file and run as a new line, so the file always reproduces the program&#39;s state"><kbd>Enter</kbd> runs · appends to file</span></div>';
    const q = (k, r) => (r || bodyHost).querySelector('[data-lv="' + k + '"]');
    const qb = (k) => barHost.querySelector('[data-lv="' + k + '"]');
    els = {
      bar: { start: qb("start"), stop: qb("stop"), restart: qb("restart"), runnew: qb("runnew"), instant: qb("instant"), meta: qb("meta") },
      status: q("status"), tl: q("tl"), console: q("console"), conInput: q("con"),
      state: bodyHost.querySelector('[data-sec="state"] .dbg-sec-b'),
      procs: bodyHost.querySelector('[data-sec="procs"] .dbg-sec-b'),
      history: bodyHost.querySelector('[data-sec="history"] .dbg-sec-b'),
      output: bodyHost.querySelector('[data-sec="output"] .dbg-sec-b'),
      counts: {},
    };
    for(const k of ["state", "procs", "history", "output"]) els.counts[k] = bodyHost.querySelector('[data-sec="' + k + '"] .ct');
    els.bar.start.addEventListener("click", startLive);
    els.bar.stop.addEventListener("click", stopLive);
    els.bar.restart.addEventListener("click", startLive);
    els.bar.runnew.addEventListener("click", runNew);
    els.bar.instant.addEventListener("change", () => { const s = S(); if(s) s.setLive(els.bar.instant.checked); render(); });
    bodyHost.querySelectorAll(".dbg-sec-h").forEach(h => h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));
    // one delegated handler for every clickable row
    bodyHost.addEventListener("click", (e) => {
      const call = e.target.closest("[data-call]");
      if(call){ e.stopPropagation(); if(!call.disabled) callProc(call.dataset.call); return; }
      const ev = e.target.closest("[data-ev]");
      if(ev){ selectedId = +ev.dataset.ev; renderTimeline(); renderHistory(); renderOutput(); keepSelVisible(); return; }
      const v = e.target.closest(".lv-var .v.long");
      if(v){ v.classList.toggle("open"); return; }
      const pr = e.target.closest("[data-proc]");
      if(pr) revealProc(pr.dataset.proc);
    });
    els.conInput.addEventListener("keydown", (e) => {
      if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitConsole(); return; }
      if(e.key === "ArrowUp" && conHist.length){ e.preventDefault(); conPos = Math.max(0, conPos - 1); els.conInput.value = conHist[conPos] || ""; return; }
      if(e.key === "ArrowDown" && conHist.length){ e.preventDefault(); conPos = Math.min(conHist.length, conPos + 1); els.conInput.value = conHist[conPos] || ""; return; }
      if(e.key === "Escape"){ els.conInput.value = ""; }
    });
    render();
  }
  function keepSelVisible(){
    const h = els.history.querySelector(".lv-ev.sel"); if(h) h.scrollIntoView({ block: "nearest" });
    const n = els.tl.querySelector(".lv-node.sel"); if(n) n.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function revealProc(name){
    const L = window.AowliLsp || window.AowliLSP;
    let line = 0;
    try{
      const out = L && L.outline ? L.outline() : [];
      const hit = (out || []).find(o => (o.name || (o.sym && o.sym.name)) === name);
      if(hit) line = hit.line || (hit.range && hit.range.startLineNumber) || 0;
    }catch(_){}
    const ed = window.AowliEditor && window.AowliEditor.getEditor && window.AowliEditor.getEditor();
    if(ed && line){ ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: 1 }); ed.focus(); }
  }

  // The procs list follows the editor's index, which rebuilds on every parse.
  // Hooked on first activation rather than at load: the page assigns its own
  // `__nifiIndexChanged` during setup, after this file runs, and would replace
  // a hook installed any earlier.
  function hookIndex(){
    const cur = window.__nifiIndexChanged;
    if(cur && cur.__live) return;
    const hook = function(n){ try{ if(cur) cur(n); }catch(_){} if(els && active) renderProcs(); };
    hook.__live = true;
    window.__nifiIndexChanged = hook;
  }
  function activate(){
    active = true;
    hookIndex();
    // The live panes need room: a status line, a timeline, four panes and a
    // prompt do not fit the replay debugger's default 260px. Grow the drawer
    // once, never shrink one the user sized.
    const dock = document.getElementById("debuggerDock");
    if(dock){
      const h = dock.getBoundingClientRect().height;
      const room = dock.parentElement ? dock.parentElement.getBoundingClientRect().height * 0.62 : 400;
      if(h && h < 380) dock.style.setProperty("--dbg-h", Math.round(Math.min(400, Math.max(h, room))) + "px");
      if(window.AowliEditor && window.AowliEditor.relayout) window.AowliEditor.relayout();
    }
    // A program does not change between verbs, so its variables are read after
    // each one rather than polled.
    refreshGlobals().then(render);
  }
  function deactivate(){ active = false; }

  // ---- wiring --------------------------------------------------------------
  function wire(){
    const s = S();
    if(!s){ setTimeout(wire, 200); return; }
    s.on("verb", onVerb);
    s.on("out", onOut);
    s.on("state", () => { if(els){ renderBar(); renderStatus(); renderConsole(); } syncHeader(); });
    // The file on screen decides whether the prompt and "Run new lines" apply.
    const w = WS();
    if(w && w.onActiveFileChange) w.onActiveFileChange(() => { if(els) render(); else syncHeader(); });
    syncHeader();
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();

  window.AowliLive = {
    mount, activate, deactivate, render,
    start: startLive, stop: stopLive, restart: startLive, runNew, call: callProc,
    ownsActiveFile, syncHeader,
    get events(){ return events.slice(); },
    get globals(){ return globals.slice(); },
    // for the gates: the routine diff, callable without a session
    _topRoutines: topRoutines,
  };
})();
