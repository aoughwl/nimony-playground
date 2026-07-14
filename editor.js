// editor.js — Monaco editor with a nimony grammar, plus a graceful textarea
// fallback if the CDN is unavailable (keeps the playground working offline).
// Exposes window.NifiEditor: { setValue, getValue, setTheme, onReady, setDiagnostics }.
(function(){
  const CDN = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";
  const readyCbs = [];
  let editor = null, monacoRef = null, usingFallback = false;
  const fallbackEl = document.getElementById("fallback");
  const editorEl = document.getElementById("editor");

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
      + " text-decoration-color: var(--muted,#9aa3b2); text-underline-offset:3px; cursor:help; }";
    document.head.appendChild(st);
  })();

  // recompute the import-underline decorations from the current model. Only std
  // modules are underlined: known bare names (via NifiLsp.stdModules) or any
  // explicit `std/…` path. Cheap enough to run debounced on every change.
  let importDecos = [];
  function computeImportDecos(){
    if(usingFallback || !editor || !monacoRef) return;
    const model = editor.getModel(); if(!model) return;
    const mods = (window.NifiLsp && window.NifiLsp.stdModules) || null;
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
            fontSize:13, minimap:{enabled:false}, automaticLayout:true,
            scrollBeyondLastLine:false, tabSize:2, insertSpaces:true, renderWhitespace:"none",
            // the playground supplies its OWN unified context menu (see index.html)
            // so the look matches the rest of the site — disable Monaco's built-in one.
            contextmenu:false,
          });
          editor.onDidChangeModelContent(scheduleImportDecos);   // keep import underlines fresh
          computeImportDecos();
          fireReady();
        });
      }catch(_){ startFallback(); }
    };
    document.head.appendChild(s);
  }

  window.NifiEditor = {
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
      monacoRef.editor.setModelMarkers(editor.getModel(), "nimony", (markers||[]).map(m=>({
        startLineNumber:m.line||1, startColumn:m.col||1,
        endLineNumber:m.endLine||m.line||1, endColumn:m.endCol||(m.col||1)+1,
        message:m.message||"", severity:sev(m.severity)
      })));
    }
  };

  bootMonaco();
})();
