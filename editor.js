// editor.js — Monaco editor with a nimony grammar, plus a graceful textarea
// fallback if the CDN is unavailable (keeps the playground working offline).
// Exposes window.AowliEditor: { setValue, getValue, setTheme, onReady, setDiagnostics }.
(function(){
  const CDN = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";
  const readyCbs = [];
  let editor = null, monacoRef = null, usingFallback = false;
  const fallbackEl = document.getElementById("fallback");
  const editorEl = document.getElementById("editor");

  // ---- editor font-size zoom: Ctrl+Wheel / Ctrl+= / Ctrl+- / Ctrl+0, with a
  // Chrome-style transient indicator. Size persists in localStorage and applies
  // to both Monaco and the textarea fallback. ----------------------------------
  const FONT_MIN = 8, FONT_MAX = 40, FONT_DEFAULT = 13;
  let fontSize = FONT_DEFAULT;
  try { const s = parseInt(localStorage.getItem("nifi.fontSize"), 10);
        if (s >= FONT_MIN && s <= FONT_MAX) fontSize = s; } catch(_){}

  let zoomEl = null, zoomTimer = null;
  function showZoomPopup(){
    if(!zoomEl){
      const host = editorEl.parentElement || document.body;
      if(getComputedStyle(host).position === "static") host.style.position = "relative";
      zoomEl = document.createElement("div");
      zoomEl.className = "nifi-zoom-indicator";
      host.appendChild(zoomEl);
    }
    zoomEl.textContent = fontSize + " px · " + Math.round(fontSize / FONT_DEFAULT * 100) + "%";
    zoomEl.classList.add("show");
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(()=>{ if(zoomEl) zoomEl.classList.remove("show"); }, 1300);
  }
  function applyFontSize(){
    if(usingFallback){ if(fallbackEl) fallbackEl.style.fontSize = fontSize + "px"; }
    else if(editor){ editor.updateOptions({ fontSize: fontSize }); }
    try { localStorage.setItem("nifi.fontSize", String(fontSize)); } catch(_){}
  }
  function setFontSize(n, showUi){
    const c = Math.max(FONT_MIN, Math.min(FONT_MAX, n|0));
    if(c !== fontSize){ fontSize = c; applyFontSize(); }
    if(showUi !== false) showZoomPopup();
  }
  function bumpFontSize(d){ setFontSize(fontSize + d, true); }

  let zoomWired = false;
  function wireZoom(){
    if(zoomWired) return; zoomWired = true;
    // Ctrl+Wheel over the editor/fallback → smooth resize (capture, non-passive
    // so we win the event before Monaco scrolls the viewport).
    const onWheel = (e)=>{ if(!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); bumpFontSize(e.deltaY < 0 ? +1 : -1); };
    editorEl.addEventListener("wheel", onWheel, { passive:false, capture:true });
    if(fallbackEl) fallbackEl.addEventListener("wheel", onWheel, { passive:false, capture:true });
    // Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0, but only while the editor is focused, so
    // we don't hijack the browser's page zoom elsewhere on the page.
    document.addEventListener("keydown", (e)=>{
      if(!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const a = document.activeElement;
      const inEditor = (editorEl && editorEl.contains(a)) || (usingFallback && a === fallbackEl);
      if(!inEditor) return;
      if(e.key === "+" || e.key === "="){ e.preventDefault(); bumpFontSize(+1); }
      else if(e.key === "-" || e.key === "_"){ e.preventDefault(); bumpFontSize(-1); }
      else if(e.key === "0"){ e.preventDefault(); setFontSize(FONT_DEFAULT, true); }
    }, true);
  }

  const NIMONY_KEYWORDS = [
    "addr","and","as","asm","bind","block","break","case","cast","concept","const",
    "continue","converter","defer","discard","distinct","div","do","elif","else","end",
    "enum","except","export","finally","for","from","func","if","import","in","include",
    "interface","is","isnot","iterator","let","macro","method","mixin","mod","nil","not",
    "notin","object","of","or","out","proc","ptr","raise","ref","return","shl","shr",
    "static","template","try","tuple","type","using","var","when","while","xor","yield",
    "echo","result","true","false"
  ];
  const NIMONY_TYPES = ["int","int8","int16","int32","int64","uint","uint8","uint16",
    "uint32","uint64","float","float32","float64","bool","char","string","cstring",
    "seq","array","openArray","set","void","auto","untyped","typed","pointer"];

  function defineLanguage(monaco){
    monaco.languages.register({ id:"nimony" });
    monaco.languages.setLanguageConfiguration("nimony", {
      comments:{ lineComment:"#", blockComment:["#[","]#"] },
      brackets:[["(",")"],["[","]"],["{","}"]],
      autoClosingPairs:[{open:"(",close:")"},{open:"[",close:"]"},{open:"{",close:"}"},
        {open:'"',close:'"'},{open:"'",close:"'"}],
      indentationRules:{ increaseIndentPattern:/[:=]\s*$|(\b(proc|func|method|iterator|template|macro|if|elif|else|for|while|case|of|try|except|finally|block|when|type|object|enum)\b.*[:=]\s*$)/, decreaseIndentPattern:/^\s*(else|elif|except|finally|of)\b/ }
    });
    monaco.languages.setMonarchTokensProvider("nimony", {
      keywords: NIMONY_KEYWORDS, types: NIMONY_TYPES,
      tokenizer:{
        root:[
          [/#\[/,"comment","@block"],
          [/#.*$/,"comment"],
          [/\b\d+\.\d+([eE][-+]?\d+)?\b/,"number.float"],
          [/\b0x[0-9a-fA-F]+\b/,"number.hex"],
          [/\b\d[\d_]*\b/,"number"],
          [/"""/,"string","@mstring"],
          [/"/,"string","@string"],
          [/'(\\.|[^'])'/,"string"],
          [/[a-zA-Z_][a-zA-Z0-9_]*/,{ cases:{ "@keywords":"keyword", "@types":"type", "@default":"identifier" } }],
          [/[=+\-*/<>@$~&%|!?^.:]+/,"operator"],
        ],
        block:[[/]#/,"comment","@pop"],[/./,"comment"]],
        string:[[/[^"]+/,"string"],[/"/,"string","@pop"]],
        mstring:[[/[^"]+/,"string"],[/"""/,"string","@pop"],[/"/,"string"]],
      }
    });
    monaco.editor.defineTheme("nimony-dark",{ base:"vs-dark", inherit:true, rules:[], colors:{ "editor.background":"#0f1115" } });
    monaco.editor.defineTheme("nimony-light",{ base:"vs", inherit:true, rules:[], colors:{ "editor.background":"#ffffff" } });
    // "true dark" — matches the aoughwl docs site's dark scheme (near-black).
    monaco.editor.defineTheme("nimony-black",{ base:"vs-dark", inherit:true, rules:[], colors:{ "editor.background":"#0a0a0b" } });
  }
  // map a data-theme value to the Monaco theme id
  function monacoTheme(t){ return t==="light" ? "nimony-light" : t==="black" ? "nimony-black" : "nimony-dark"; }

  // subtle underline for builtin std-module refs in import lines (lsp feature 2).
  // injected here so index.html's <style> stays untouched.
  (function injectCss(){
    const st = document.createElement("style");
    st.textContent = ".nifi-import-ref{ text-decoration: underline dotted;"
      + " text-decoration-color: var(--muted,#9aa3b2); text-underline-offset:3px; cursor:help; }"
      // Chrome-style zoom indicator: a small glass chip in the editor's top-right
      // that fades in on a size change and auto-hides. Reads fine on light/dark.
      + ".nifi-zoom-indicator{ position:absolute; top:10px; right:16px; z-index:50;"
      + " font:600 12px/1 'SF Mono',ui-monospace,Menlo,Consolas,monospace;"
      + " color:#e8eaed; background:rgba(20,22,28,0.92);"
      + " border:1px solid rgba(255,255,255,0.14); border-radius:8px;"
      + " padding:7px 11px; letter-spacing:.02em; white-space:nowrap;"
      + " box-shadow:0 6px 20px rgba(0,0,0,0.35); pointer-events:none; user-select:none;"
      + " opacity:0; transform:translateY(-5px); transition:opacity .14s ease, transform .14s ease; }"
      + ".nifi-zoom-indicator.show{ opacity:1; transform:translateY(0); }";
    document.head.appendChild(st);
  })();

  // recompute the import-underline decorations from the current model. Only std
  // modules are underlined: known bare names (via AowliLsp.stdModules) or any
  // explicit `std/…` path. Cheap enough to run debounced on every change.
  let importDecos = [];
  function computeImportDecos(){
    if(usingFallback || !editor || !monacoRef) return;
    const model = editor.getModel(); if(!model) return;
    const mods = (window.AowliLsp && window.AowliLsp.stdModules) || null;
    const lines = model.getValue().split("\n"), decos = [];
    for(let i=0;i<lines.length;i++){
      const m = /^(\s*)(import|from|include)\b(.*)$/.exec(lines[i]);
      if(!m) continue;
      let rest = m[3].split("#")[0];             // drop trailing comment
      // in `from X import Y` only the part before `import` names modules
      if(m[2]==="from"){ const im = rest.search(/\bimport\b/); if(im>=0) rest = rest.slice(0, im); }
      const base = m[1].length + m[2].length;    // 0-based col where `rest` begins
      const re = /(std\/)?([A-Za-z][A-Za-z0-9_]*)/g;
      let mm;
      while((mm = re.exec(rest))){
        const hasStd = !!mm[1];
        if(!hasStd){ if(!mods || mods.indexOf(mm[2])<0) continue; } // bare non-std → skip
        const startCol = base + mm.index + 1;    // 1-based
        const endCol = startCol + mm[0].length;
        decos.push({ range:new monacoRef.Range(i+1, startCol, i+1, endCol),
          options:{ inlineClassName:"nifi-import-ref" } });
      }
    }
    importDecos = editor.deltaDecorations(importDecos, decos);
  }
  let decoTimer = null;
  function scheduleImportDecos(){ clearTimeout(decoTimer); decoTimer = setTimeout(computeImportDecos, 150); }

  function fireReady(){ readyCbs.splice(0).forEach(f=>{ try{f();}catch(_){}}); }

  function startFallback(){
    usingFallback = true;
    editorEl.style.display = "none";
    fallbackEl.style.display = "block";
    applyFontSize();   // honor a persisted zoom on the textarea too
    wireZoom();
    fireReady();
  }

  function bootMonaco(){
    const s = document.createElement("script");
    s.src = CDN + "/loader.js";
    s.onerror = startFallback;
    s.onload = () => {
      try{
        require.config({ paths:{ vs: CDN } });
        require(["vs/editor/editor.main"], (monaco) => {
          monacoRef = monaco;
          defineLanguage(monaco);
          const initTheme = monacoTheme(document.documentElement.getAttribute("data-theme"));
          editor = monaco.editor.create(editorEl, {
            value:"", language:"nimony",
            theme: initTheme,
            fontFamily:'"SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace',
            fontSize: fontSize, minimap:{enabled:false}, automaticLayout:true,
            scrollBeyondLastLine:false, tabSize:2, insertSpaces:true, renderWhitespace:"none",
            // the playground supplies its OWN unified context menu (see index.html)
            // so the look matches the rest of the site — disable Monaco's built-in one.
            contextmenu:false,
            // wrap long lines on phones so code isn't cut off the right edge
            wordWrap: (window.matchMedia && window.matchMedia("(max-width: 600px)").matches) ? "on" : "off",
            // tight line-number gutter on phones — the default gutter wastes a lot
            // of horizontal room on a small screen
            glyphMargin: false,
            lineNumbersMinChars: (window.matchMedia && window.matchMedia("(max-width: 600px)").matches) ? 2 : 4,
            lineDecorationsWidth: (window.matchMedia && window.matchMedia("(max-width: 600px)").matches) ? 3 : 10,
            folding: !(window.matchMedia && window.matchMedia("(max-width: 600px)").matches),
          });
          // keep word-wrap + gutter width in sync with viewport width (phones only)
          try{
            const mq = window.matchMedia("(max-width: 600px)");
            const applyWrap = () => { if(editor) editor.updateOptions({
              wordWrap: mq.matches ? "on" : "off",
              lineNumbersMinChars: mq.matches ? 2 : 4,
              lineDecorationsWidth: mq.matches ? 3 : 10,
              folding: !mq.matches,
            }); };
            if(mq.addEventListener) mq.addEventListener("change", applyWrap);
            else if(mq.addListener) mq.addListener(applyWrap);
          }catch(_){}
          editor.onDidChangeModelContent(scheduleImportDecos);   // keep import underlines fresh
          computeImportDecos();
          wireZoom();
          fireReady();
        });
      }catch(_){ startFallback(); }
    };
    document.head.appendChild(s);
  }

  window.AowliEditor = {
    setValue(v){ if(usingFallback) fallbackEl.value=v; else if(editor) editor.setValue(v); },
    getValue(){ return usingFallback ? fallbackEl.value : (editor ? editor.getValue() : ""); },
    setTheme(t){ if(!usingFallback && monacoRef) monacoRef.editor.setTheme(monacoTheme(t)); },
    // Monaco renders 0-height while its container is display:none (the source pane
    // now hides the editor behind NIF tabs); call this when the Source tab is shown
    // again so it re-measures and repaints at the correct size.
    relayout(){ if(!usingFallback && editor){ try{ editor.layout(); editor.render&&editor.render(true); }catch(_){} } },
    onReady(cb){ if(usingFallback || editor) cb(); else readyCbs.push(cb); },
    // Accessors for the LSP glue (lsp.js): the monaco namespace, the editor
    // instance, and its model. Null under the textarea fallback.
    getMonaco(){ return monacoRef; },
    getEditor(){ return editor; },
    getModel(){ return editor ? editor.getModel() : null; },
    languageId: "nimony",
    // Editor font-size zoom (also driven by Ctrl+Wheel / Ctrl+± / Ctrl+0).
    getFontSize(){ return fontSize; },
    setFontSize(n){ setFontSize(n, true); },
    zoomIn(){ bumpFontSize(+1); },
    zoomOut(){ bumpFontSize(-1); },
    resetFontSize(){ setFontSize(FONT_DEFAULT, true); },
    // Repaint the std-module import underlines (lsp.js calls this once its
    // STD_MODULES list is available). Safe no-op under the textarea fallback.
    refreshImportDecorations(){ computeImportDecos(); },
    // Move the cursor to (line, col) and scroll it into view — used by the
    // Symbols/outline panel to jump to a definition.
    revealPosition(line, col){
      if(usingFallback || !editor) return;
      editor.setPosition({ lineNumber:line||1, column:col||1 });
      editor.revealLineInCenter(line||1);
      editor.focus();
    },
    // Fires on every content change (debouncing is the caller's job).
    onChange(cb){
      if(usingFallback){ fallbackEl.addEventListener("input", cb); return; }
      const attach = () => { if(editor) editor.onDidChangeModelContent(cb); else readyCbs.push(attach); };
      attach();
    },
    // Called by the LSP-in-worker glue (Tier 3). markers: [{line,col,endLine,endCol,message,severity}]
    setDiagnostics(markers){
      if(usingFallback || !monacoRef || !editor) return;
      const sev = s => ({error:8, warning:4, info:2, hint:1}[s] || 8);
      const model = editor.getModel();
      monacoRef.editor.setModelMarkers(model, "nimony", (markers||[]).map(m=>{
        const mk = {
          startLineNumber:m.line||1, startColumn:m.col||1,
          endLineNumber:m.endLine||m.line||1, endColumn:m.endCol||(m.col||1)+1,
          message:m.message||"", severity:sev(m.severity)
        };
        // aowlparser diagnostic slug (e.g. "assignment-in-condition") — lets the
        // quick-fix provider recognise which parser fix applies.
        if(m.code) mk.code = String(m.code);
        // a RELATED source location (the `(` an unclosed bracket was opened at):
        // Monaco renders it as a secondary underline with its own hover.
        if(m.related && m.related.line){
          mk.relatedInformation = [{
            resource: model.uri,
            message: m.related.message || "",
            startLineNumber: m.related.line, startColumn: (m.related.col|0)+1,
            endLineNumber: m.related.line, endColumn: (m.related.col|0)+2
          }];
        }
        return mk;
      }));
    }
  };

  bootMonaco();
})();
