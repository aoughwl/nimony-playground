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
  }

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
          const dark = document.documentElement.getAttribute("data-theme") !== "light";
          editor = monaco.editor.create(editorEl, {
            value:"", language:"nimony",
            theme: dark ? "nimony-dark" : "nimony-light",
            fontFamily:'"SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace',
            fontSize:13, minimap:{enabled:false}, automaticLayout:true,
            scrollBeyondLastLine:false, tabSize:2, insertSpaces:true, renderWhitespace:"none",
          });
          fireReady();
        });
      }catch(_){ startFallback(); }
    };
    document.head.appendChild(s);
  }

  window.NifiEditor = {
    setValue(v){ if(usingFallback) fallbackEl.value=v; else if(editor) editor.setValue(v); },
    getValue(){ return usingFallback ? fallbackEl.value : (editor ? editor.getValue() : ""); },
    setTheme(t){ if(!usingFallback && monacoRef) monacoRef.editor.setTheme(t==="light"?"nimony-light":"nimony-dark"); },
    onReady(cb){ if(usingFallback || editor) cb(); else readyCbs.push(cb); },
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
