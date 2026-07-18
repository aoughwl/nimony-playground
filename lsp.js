// lsp.js — in-tab "language intelligence" for the sandbox.
//
// This is the playground's answer to what the nimony VS Code extension gives
// you: an outline, hover types, go-to-definition and completions. It works the
// same way nimony-lsp does natively — by walking a NIF artifact in-process —
// except here the artifact is produced in the browser and we walk it in JS.
//
// SOURCE OF TRUTH: the `.p.nif` (parsed, UNTYPED — from nifparser). That is the
// right substrate on purpose: it carries source-faithful positions, every name
// exactly as written, and declared types in their *source* spelling (`int`, not
// the sem'd `(i 64)`). The typed `.s.nif` is deliberately NOT on the critical
// path: sem anchors line-info to definition sites, erases aliases and collapses
// imported types, so it is worse for navigation — and, crucially, depending on
// it would make all this intelligence vanish the moment the code stops
// type-checking. Everything below survives a broken semcheck, because the parse
// still succeeds. (sem is consulted only as optional garnish for INFERRED var
// types, matched by symbol basename — see NifiLsp.enrich.)
(function(){
  // `providers` holds the Monaco language-feature providers once registered — a
  // small introspection surface (the playground can drive a feature directly, and
  // it makes each provider unit-testable without poking Monaco's private
  // registries).
  const lsp = { ready:false, index:{ symbols:[], byName:new Map() }, providers:{} };

  // ---------------------------------------------------------------------------
  // 1. a tiny NIF S-expression reader (tokens -> nested nodes)
  // ---------------------------------------------------------------------------
  // A node is { tag, kids:[node|atom] }; an atom is { atom:true, v } where `v`
  // is the raw token text (line-info suffix still attached — stripped on demand
  // by nameOf). Strings/char-literals are kept as atoms with their quotes so we
  // never confuse their spaces/parens for structure.
  function tokenizeNif(s){
    const toks = []; let i = 0; const n = s.length;
    const BREAK = " \n\t\r()\"";
    while(i < n){
      const c = s[i];
      if(c===" "||c==="\n"||c==="\t"||c==="\r"){ i++; continue; }
      if(c==="("){ toks.push({t:"("}); i++; continue; }
      if(c===")"){ toks.push({t:")"}); i++; continue; }
      if(c==="\""){                              // string literal
        let j=i+1, buf="\"";
        while(j<n && s[j]!=="\""){ if(s[j]==="\\"){ buf+=s[j]+(s[j+1]||""); j+=2; } else { buf+=s[j]; j++; } }
        buf+="\""; j++;
        toks.push({t:"atom", v:buf}); i=j; continue;
      }
      if(c==="'"){                               // char literal
        let j=i+1, buf="'";
        while(j<n && s[j]!=="'"){ if(s[j]==="\\"){ buf+=s[j]+(s[j+1]||""); j+=2; } else { buf+=s[j]; j++; } }
        buf+="'"; j++;
        toks.push({t:"atom", v:buf}); i=j; continue;
      }
      let j=i, buf="";                            // bare atom
      while(j<n && BREAK.indexOf(s[j])<0){ buf+=s[j]; j++; }
      // In .p.nif a run of only dots is N adjacent EMPTY nodes ("." each) — the
      // `..` operator is escaped as \2E\2E, so a bare dot-run is never an atom.
      if(/^\.+$/.test(buf)){ for(let d=0; d<buf.length; d++) toks.push({t:"atom", v:"."}); }
      else toks.push({t:"atom", v:buf});
      i=j;
    }
    return toks;
  }

  function buildTrees(toks){
    let i = 0;
    function node(){
      i++;                                        // consume '('
      const tagTok = (toks[i] && toks[i].t==="atom") ? toks[i] : {v:""};
      if(toks[i] && toks[i].t==="atom") i++;
      const nd = { tag: nameOf(tagTok.v), kids:[] };
      while(i<toks.length && toks[i].t!==")"){
        if(toks[i].t==="("){ nd.kids.push(node()); }
        else { nd.kids.push({ atom:true, v:toks[i].v }); i++; }
      }
      i++;                                        // consume ')'
      return nd;
    }
    const roots = [];
    while(i < toks.length){
      if(toks[i].t==="(") roots.push(node());
      else i++;
    }
    return roots;
  }

  // strip a NIF line-info suffix ("fib@5" -> "fib", "n~2" -> "n") and a leading
  // ':' def-marker. Leaves operator escapes (\2B) and mangling intact.
  function nameOf(v){
    if(!v) return "";
    if(v[0]===":") v = v.slice(1);
    let at = v.indexOf("@");
    if(at>=0) v = v.slice(0, at);
    // a trailing "~<b62>" is an info back-reference, not part of the name
    let ti = v.indexOf("~");
    if(ti>=0) v = v.slice(0, ti);
    return v;
  }
  function atomName(k){ return k && k.atom ? nameOf(k.v) : ""; }
  function isEmpty(k){ return k && k.atom && nameOf(k.v)==="."; }

  // render a type node/atom back to a source-ish spelling for signatures
  function renderType(k){
    if(!k) return "";
    if(k.atom){
      const nm = nameOf(k.v);
      return nm==="." ? "" : nm;
    }
    // small structural types: (at seq int) -> seq[int]; else tag(kids)
    const parts = k.kids.filter(x=>!isEmpty(x)).map(renderType).filter(Boolean);
    if(k.tag==="at" && parts.length>=1)
      return parts[0] + "[" + parts.slice(1).join(", ") + "]";
    if(k.tag==="ptr") return "ptr " + parts.join(" ");
    if(k.tag==="ref") return "ref " + parts.join(" ");
    if(!k.tag && parts.length) return parts.join(" ");
    return parts.length ? (k.tag ? k.tag+"["+parts.join(", ")+"]" : parts.join(" ")) : (k.tag||"");
  }

  // ---------------------------------------------------------------------------
  // 2. extract a symbol table from the parsed .p.nif
  // ---------------------------------------------------------------------------
  const ROUTINES = new Set(["proc","func","method","iterator","template","macro","converter"]);
  const GLOBALS  = new Set(["let","var","const"]);

  function childByTag(nd, tag){ for(const k of nd.kids) if(!k.atom && k.tag===tag) return k; return null; }

  // params tree -> [{name, type}]
  function paramsOf(nd){
    const ps = childByTag(nd, "params");
    if(!ps) return [];
    const out = [];
    for(const k of ps.kids){
      if(k.atom || k.tag!=="param") continue;
      const name = atomName(k.kids[0]);
      // NIF param shape: NAME EXPORT PRAGMAS TYPE DEFAULT — the type is the
      // 4th slot (index 3); a non-empty later slot would be the DEFAULT value.
      const tk = k.kids[3];
      const type = (tk && !isEmpty(tk)) ? renderType(tk) : "";
      if(name) out.push({ name, type });
    }
    return out;
  }

  // return type = the kid right after the params child, if present & non-empty
  function returnOf(nd){
    const idx = nd.kids.findIndex(k=>!k.atom && k.tag==="params");
    if(idx<0) return "";
    const rt = nd.kids[idx+1];
    return (rt && !isEmpty(rt)) ? renderType(rt) : "";
  }

  function routineDetail(kind, name, params, ret){
    const ps = params.map(p=> p.type ? p.name+": "+p.type : p.name).join(", ");
    return kind+" "+name+"("+ps+")"+(ret?": "+ret:"");
  }

  // Walk the module `stmts`, collecting symbols in document order. Each symbol:
  //   { name, kind, detail, container, params?:[{name,type}], keyword }
  // `kind` is our own tag; `keyword` is the source keyword we search for.
  function collect(root){
    const symbols = [];
    // A let/var/const is a real declaration only when it sits DIRECTLY in a
    // `stmts` block (module top level, or a routine/branch body). The same tag
    // inside `unpackflat` is a for-loop variable — handled explicitly below so
    // it is a hover/completion target but never clutters the outline.
    function walk(nd, container){
      const declLevel = (nd.tag==="stmts");
      for(const k of nd.kids){
        if(k.atom) continue;
        if(ROUTINES.has(k.tag)){
          const name = atomName(k.kids[0]);
          if(name && name!=="."){
            const params = paramsOf(k);
            const ret = returnOf(k);
            symbols.push({ name, kind:k.tag, keyword:k.tag,
              detail: routineDetail(k.tag, name, params, ret),
              container, params, ret });
            for(const p of params)
              symbols.push({ name:p.name, kind:"param", keyword:null,
                detail:(p.type?p.name+": "+p.type:p.name), container:name, params:null });
          }
          const body = childByTag(k, "stmts");
          if(body) walk(body, name);              // nested routines/locals
          continue;
        }
        if(k.tag==="type"){
          const name = atomName(k.kids[0]);
          if(name && name!==".")
            symbols.push({ name, kind:"type", keyword:"type", detail:"type "+name, container });
          // enum / object members become hover + completion targets
          for(const body of k.kids){
            if(body.atom) continue;
            if(body.tag==="enum") for(const e of body.kids){
              if(e.atom || e.tag!=="efld") continue;
              const en = atomName(e.kids[0]);
              if(en && en!==".") symbols.push({ name:en, kind:"enumField", keyword:null,
                detail:en+": "+name, container:name });
            }
            if(body.tag==="object") for(const f of body.kids){
              if(f.atom || f.tag!=="fld") continue;
              const fn = atomName(f.kids[0]);
              const ft = (f.kids[3] && !isEmpty(f.kids[3])) ? renderType(f.kids[3]) : "";
              if(fn && fn!==".") symbols.push({ name:fn, kind:"field", keyword:null,
                detail:fn+(ft?": "+ft:"")+"  ("+name+")", container:name });
            }
          }
          continue;
        }
        if(GLOBALS.has(k.tag)){
          if(declLevel){
            const name = atomName(k.kids[0]);
            if(name && name!=="."){
              // shape: NAME EXPORT PRAGMAS TYPE VALUE — type is slot 3 (index 3).
              const tk = k.kids[3];
              const type = (tk && !isEmpty(tk)) ? renderType(tk) : "";
              symbols.push({ name, kind:container?"local":k.tag, keyword:container?null:k.tag,
                detail:(container?"":k.tag+" ")+name+(type?": "+type:""), container });
            }
          }
          continue;                               // never descend a decl
        }
        if(k.tag==="for"){
          const up = childByTag(k, "unpackflat");
          if(up) for(const lv of up.kids){
            if(lv.atom || lv.tag!=="let") continue;
            const nm = atomName(lv.kids[0]);
            if(nm && nm!==".") symbols.push({ name:nm, kind:"local", keyword:null, detail:nm, container });
          }
          const body = childByTag(k, "stmts");
          if(body) walk(body, container);
          continue;
        }
        walk(k, container);                        // if/while/case/blocks → nested stmts
      }
    }
    walk(root, null);
    return symbols;
  }

  // ---------------------------------------------------------------------------
  // 3. public: (re)build the index from source + .p.nif
  // ---------------------------------------------------------------------------
  lsp.update = function(source, pnif){
    try{
      const roots = buildTrees(tokenizeNif(String(pnif||"")));
      const stmts = roots.find(r=>r.tag==="stmts");
      const symbols = stmts ? collect(stmts) : [];
      const byName = new Map();
      for(const s of symbols){
        if(!byName.has(s.name)) byName.set(s.name, []);
        byName.get(s.name).push(s);
      }
      lsp.index = { symbols, byName, source:String(source||"") };
      if(window.__nifiIndexChanged){ try{ window.__nifiIndexChanged(symbols.length); }catch(_){} }
    }catch(_){ /* keep the previous index on a transient parse hiccup */ }
  };

  // Outline as plain data (for the playground's own Symbols panel — base Monaco
  // has no breadcrumb/outline chrome, so we render our own). Positions are
  // computed against the live model, same as the providers.
  function buildOutline(model){
    const text = model.getValue();
    const out = [];
    const top = lsp.index.symbols.filter(s=>!s.container && s.kind!=="param" && s.kind!=="local");
    for(const s of top){
      const r = locate(s, text, 0);
      if(!r) continue;
      const from = model.getOffsetAt({lineNumber:r.startLineNumber, column:r.startColumn});
      const kidKinds = new Set(["param","local","field","enumField"]);
      const children = [];
      for(const c of lsp.index.symbols){
        if(c.container!==s.name || !kidKinds.has(c.kind)) continue;
        const cr = locate(c, text, from);
        if(cr) children.push({ sym:c, range:cr });
      }
      out.push({ sym:s, range:r, children });
    }
    return out;
  }
  lsp.outline = function(){
    const m = window.NifiEditor.getModel();
    if(!m) return [];
    const flat = o => ({ name:o.sym.name, detail:o.sym.detail, kind:o.sym.kind,
      line:o.range.startLineNumber, col:o.range.startColumn });
    return buildOutline(m).map(o=>Object.assign(flat(o), { children:o.children.map(flat) }));
  };
  lsp.count = function(){ return lsp.index.symbols.length; };

  // Optional: enrich INFERRED locals with sem'd types, matched by basename only
  // (never by sem's unreliable line-info). Safe no-op if snif is absent.
  lsp.enrich = function(snif){
    if(!snif) return;
    try{
      const roots = buildTrees(tokenizeNif(String(snif)));
      const stmts = roots.find(r=>r.tag==="stmts"); if(!stmts) return;
      const typeByBase = new Map();
      (function scan(nd){
        for(const k of nd.kids){
          if(k.atom) continue;
          if(k.tag==="let"||k.tag==="var"||k.tag==="const"||k.tag==="param"||k.tag==="result"){
            const raw = k.kids[0] && k.kids[0].atom ? k.kids[0].v : "";
            const base = nameOf(raw).split(".")[0];
            for(let j=1;j<k.kids.length;j++){ if(!isEmpty(k.kids[j])){ const t=semType(k.kids[j]); if(t && base) typeByBase.set(base, t); break; } }
          }
          scan(k);
        }
      })(stmts);
      for(const s of lsp.index.symbols){
        if((s.kind==="local"||s.kind==="var"||s.kind==="let") && !/:/.test(s.detail)){
          const t = typeByBase.get(s.name);
          if(t) s.detail += ": " + t + "  ⟨inferred⟩";
        }
      }
    }catch(_){}
  };
  // map a sem'd type node to a friendly name
  function semType(k){
    if(!k) return "";
    if(k.atom) return "";
    if(k.tag==="i") return sizeName(k, "int");
    if(k.tag==="u") return sizeName(k, "uint");
    if(k.tag==="f") return sizeName(k, "float");
    if(k.tag==="bool") return "bool";
    if(k.tag==="c") return "char";
    return renderType(k);
  }
  function sizeName(k, base){
    const bitsK = k.kids.find(x=>x.atom && /^[0-9]+$/.test(nameOf(x.v)));
    const bits = bitsK ? parseInt(nameOf(bitsK.v),10) : 0;
    if(base==="int") return bits===64||bits===0 ? "int" : "int"+bits;
    if(base==="uint") return bits===64 ? "uint" : "uint"+bits;
    if(base==="float") return bits===64||bits===0 ? "float" : "float"+bits;
    return base;
  }

  // ---------------------------------------------------------------------------
  // 4. position helpers — computed against the LIVE model text so navigation
  //    always aligns with what the user currently sees (no index drift).
  // ---------------------------------------------------------------------------
  function offsetToPos(text, off){                // 1-based line, 1-based col
    let line=1, col=1;
    for(let i=0;i<off && i<text.length;i++){ if(text[i]==="\n"){ line++; col=1; } else col++; }
    return { line, col };
  }
  function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }

  // Find a symbol's declaration in `text`. Keyword-anchored when we know the
  // source keyword; otherwise the first whole-word occurrence at/after `from`.
  function locate(sym, text, from){
    const nm = esc(sym.name);
    let re, m;
    if(sym.keyword){
      re = new RegExp("\\b"+esc(sym.keyword)+"\\s+`?"+nm+"\\b");
      re.lastIndex = from||0;
      m = re.exec(text.slice(from||0));
      if(m){
        const kwAt = (from||0) + m.index;
        const nameAt = text.indexOf(sym.name, kwAt);
        return posRange(text, nameAt, sym.name.length);
      }
    }
    // fallback: whole-word search from `from`
    re = new RegExp("\\b"+nm+"\\b");
    const sliceAt = from||0;
    m = re.exec(text.slice(sliceAt));
    if(m) return posRange(text, sliceAt + m.index, sym.name.length);
    return null;
  }
  function posRange(text, off, len){
    if(off<0) return null;
    const a = offsetToPos(text, off), b = offsetToPos(text, off+len);
    return { startLineNumber:a.line, startColumn:a.col, endLineNumber:b.line, endColumn:b.col };
  }

  // ---------------------------------------------------------------------------
  // 5. Monaco providers
  // ---------------------------------------------------------------------------
  const KEYWORDS = ["addr","and","as","asm","block","break","case","cast","concept",
    "const","continue","converter","defer","discard","distinct","div","do","elif",
    "else","end","enum","except","export","finally","for","from","func","if","import",
    "include","in","is","isnot","iterator","let","macro","method","mixin","mod","nil",
    "not","notin","object","of","or","out","proc","ptr","raise","ref","return","shl",
    "shr","static","template","try","tuple","type","var","when","while","xor","yield",
    "echo","result","true","false"];
  const BUILTINS = ["int","int8","int16","int32","int64","uint","uint8","uint16",
    "uint32","uint64","float","float32","float64","bool","char","string","cstring",
    "seq","array","openArray","set","void","auto","Natural","Positive"];
  // a small curated stdlib surface so completions feel alive
  const STDLIB = [
    {label:"echo", detail:"proc echo(args: varargs)", doc:"write args + newline to stdout (std/syncio)"},
    {label:"len",  detail:"proc len(x): int", doc:"number of elements"},
    {label:"add",  detail:"proc add(s: var seq; x)", doc:"append to a seq/string"},
    {label:"inc",  detail:"proc inc(x: var int; n = 1)", doc:"increment in place"},
    {label:"dec",  detail:"proc dec(x: var int; n = 1)", doc:"decrement in place"},
    {label:"high", detail:"proc high(x): int", doc:"highest valid index / max value"},
    {label:"low",  detail:"proc low(x): int", doc:"lowest valid index / min value"},
    {label:"$",    detail:"proc `$`(x): string", doc:"stringify"},
    {label:"newSeq", detail:"proc newSeq[T](len = 0): seq[T]", doc:"a new seq"},
  ];
  // every nimony std module (lib/std/*.nim, dirs + private dropped), sorted.
  const STD_MODULES = ["algorithm","appdirs","assertions","atomics","base64","bitops",
    "cmdline","complex","cpuinfo","deques","dirs","editdistance","encodings","envvars",
    "fenv","formatfloat","hashes","heapqueue","intsets","ioring","json","lexbase","locks",
    "macros","math","md5","memfiles","monotimes","nativesocket","nifply","opt","options",
    "os","oserrors","osproc","parfor","parsejson","parseopt","parseutils","pathnorm","paths",
    "random","rawthreads","result","rlocks","sequtils","sets","setutils","sha1","streams",
    "strtabs","strutils","syncio","system","tables","terminal","threadpool","ticketlocks",
    "times","unicode","varints","widestrs","wordwrap","writenif"];
  // TYPECHECKS: the modules pre-semchecked into the browser stdlib closure
  // (assets/nimsem-stdlib.bin). Importing any of these type-checks and yields
  // completions/hover. Today that is the whole std library — every lib/std/*.nim
  // that semchecks — so it mirrors STD_MODULES; kept as its own set so the label
  // logic stays correct if the bundled closure is ever trimmed.
  const TYPECHECKS = new Set(STD_MODULES);
  // SANDBOX ⊂ TYPECHECKS: these also actually RUN in the nifi sandbox. The rest
  // parse + type-check (completions/hover) but may fail at RUN time (OS/FFI/threads).
  const SANDBOX = new Set(["syncio","system"]);
  lsp.stdModules = STD_MODULES;                 // shared with editor.js decorations

  const KIND_LABEL = { proc:"proc", func:"func", method:"method", iterator:"iterator",
    template:"template", macro:"macro", converter:"converter", type:"type",
    param:"param", local:"local", let:"let", var:"var", const:"const",
    enumField:"enum field", field:"field" };

  function symKind(monaco, s){
    const K = monaco.languages.SymbolKind;
    switch(s.kind){
      case "proc": case "func": return K.Function;
      case "method": return K.Method;
      case "iterator": case "template": case "macro": case "converter": return K.Function;
      case "type": return K.Class;
      case "const": return K.Constant;
      default: return K.Variable;
    }
  }
  function compKind(monaco, kind){
    const K = monaco.languages.CompletionItemKind;
    switch(kind){
      case "proc": case "func": case "method": case "iterator": case "converter": return K.Function;
      case "template": case "macro": return K.Snippet;
      case "type": return K.Class;
      case "const": return K.Constant;
      case "enumField": return K.EnumMember;
      case "field": return K.Field;
      case "param": case "local": return K.Variable;
      default: return K.Variable;
    }
  }

  // Decide whether the text on the line up to the cursor is naming a module
  // (import/from/include). Returns { partial, path, std } or null. `partial` is
  // the trailing identifier fragment being typed (what completion replaces);
  // `path` means we're after a "…/" segment; `std` means specifically "std/".
  function importContext(lineToCursor){
    if(!/^\s*(import|from|include)\b/.test(lineToCursor)) return null;
    // in `from X import Y` the part past `import` names symbols, not modules.
    const fm = /^\s*from\b([^]*)$/.exec(lineToCursor);
    if(fm && /\bimport\b/.test(fm[1])) return null;
    const partial = (/([A-Za-z0-9_]*)$/.exec(lineToCursor))[1];
    const before = lineToCursor.slice(0, lineToCursor.length - partial.length);
    return { partial, path: /\/$/.test(before), std: /std\/$/.test(before) };
  }

  // module completions for an import line (feature 1). After a literal "std/" we
  // insert the bare module name (the prefix is already typed); anywhere else
  // (fresh `import `, or a partial like `import std`) we offer the `std/` folder
  // AND modules whose insertText carries the `std/` prefix, so accepting one
  // always yields a VALID `import std/<mod>` (never a bare, unresolvable name).
  function moduleSuggestions(monaco, ctx, range){
    const K = monaco.languages.CompletionItemKind;
    const bare = ctx.std;                       // cursor sits right after "std/"
    const items = [];
    if(!bare){                                  // offer the std/ folder, sorted first
      items.push({ label:"std/", kind:K.Folder, detail:"std module namespace",
        insertText:"std/", range, sortText:"0",
        command:{ id:"editor.action.triggerSuggest", title:"" } });
    }
    for(const name of STD_MODULES){
      const runs = SANDBOX.has(name);
      const typed = TYPECHECKS.has(name);
      items.push({ label:name, kind:K.Module,
        insertText:(bare?name:"std/"+name), range,
        detail:"std module · "+(runs?"runs in sandbox":typed?"type-checks (bundled)":"parse only"),
        sortText:(bare?"":"1")+(runs?"0":"1")+name });
    }
    return { suggestions: items };
  }

  // Every whole-word occurrence of `name` in `text`, as position ranges. Used by
  // find-references and document-highlight. Text-based (no scope analysis) —
  // matches Monaco's built-in "highlight occurrences" feel.
  function allOccurrences(text, name){
    const out = [];
    const re = new RegExp("\\b"+esc(name)+"\\b", "g");
    let m;
    while((m = re.exec(text))) out.push(posRange(text, m.index, name.length));
    return out.filter(Boolean);
  }

  // Find the call that encloses `off` (a text offset): the identifier before the
  // innermost unmatched `(`, plus the 0-based index of the argument the cursor is
  // in (counting top-level commas). Scans backwards, skipping nested brackets and
  // string/char literals. Returns { name, argIndex } or null.
  function enclosingCall(text, off){
    let depth = 0, i = off - 1, argIndex = 0;
    while(i >= 0){
      const c = text[i];
      if(c === '"' || c === "'"){ i--; while(i >= 0 && text[i] !== c) i--; i--; continue; }
      if(c === ')' || c === ']' || c === '}'){ depth++; i--; continue; }
      if(c === '[' || c === '{'){ if(depth === 0) return null; depth--; i--; continue; }
      if(c === '('){
        if(depth === 0){
          let j = i - 1; while(j >= 0 && /\s/.test(text[j])) j--;
          const e = j + 1; while(j >= 0 && /[A-Za-z0-9_]/.test(text[j])) j--;
          const name = text.slice(j + 1, e);
          return name ? { name, argIndex } : null;
        }
        depth--; i--; continue;
      }
      if(c === ',' && depth === 0){ argIndex++; i--; continue; }
      i--;
    }
    return null;
  }

  // Build a Monaco SignatureInformation from a routine symbol, with per-parameter
  // label ranges so the active argument highlights correctly.
  function signatureOf(s){
    let label = s.kind + " " + s.name + "(";
    const parameters = [];
    (s.params || []).forEach((p, idx) => {
      const seg = p.type ? p.name + ": " + p.type : p.name;
      const start = label.length;
      label += seg;
      parameters.push({ label:[start, start + seg.length] });
      if(idx < s.params.length - 1) label += ", ";
    });
    label += ")";
    if(s.ret) label += ": " + s.ret;
    return { label, parameters };
  }

  // Curated "symbol needs this module" map for the add-import quick fix. Small on
  // purpose — only the everyday std symbols a beginner reaches for before they've
  // imported anything. The diagnostic gives us the undeclared name; we map it to
  // the import that resolves it.
  const IMPORT_FIXES = {
    echo:"std/syncio", write:"std/syncio", writeLine:"std/syncio",
    readLine:"std/syncio", stdout:"std/syncio", stdin:"std/syncio", stderr:"std/syncio",
  };

  function register(monaco){
    const LANG = "nimony";
    // register a provider and keep a handle on lsp.providers for introspection.
    const reg = (method, key, prov) => { lsp.providers[key] = prov; return monaco.languages[method](LANG, prov); };

    // --- outline / breadcrumbs ---
    monaco.languages.registerDocumentSymbolProvider(LANG, {
      provideDocumentSymbols(model){
        const text = model.getValue();
        const out = [];
        let cursor = 0;
        // top-level routines/types/globals, with routine params/locals nested
        const top = lsp.index.symbols.filter(s=>!s.container && s.kind!=="param" && s.kind!=="local");
        for(const s of top){
          const r = locate(s, text, 0);
          if(!r) continue;
          const kids = lsp.index.symbols.filter(c=>c.container===s.name && (c.kind==="param"||c.kind==="local"));
          const childSyms = [];
          for(const c of kids){
            const cr = locate(c, text, r.startLineNumber>0 ? model.getOffsetAt({lineNumber:r.startLineNumber,column:r.startColumn}) : 0);
            if(cr) childSyms.push({ name:c.name, detail:c.detail, kind:symKind(monaco,c),
              range:cr, selectionRange:cr, tags:[] });
          }
          out.push({ name:s.name, detail:s.detail, kind:symKind(monaco,s),
            range:r, selectionRange:r, tags:[], children:childSyms });
        }
        return out;
      }
    });

    // --- hover ---
    monaco.languages.registerHoverProvider(LANG, {
      provideHover(model, position){
        // builtin std module inside an import line: honest note, goto not wired
        // (feature 2). Detect the import context first so this never collides
        // with the identifier hover below — a module path isn't a real symbol.
        const line = model.getLineContent(position.lineNumber);
        if(/^\s*(import|from|include)\b/.test(line)){
          const wm = model.getWordAtPosition(position);
          if(wm && STD_MODULES.indexOf(wm.word)>=0){
            const nm = wm.word, runs = SANDBOX.has(nm), typed = TYPECHECKS.has(nm);
            const r = new monaco.Range(position.lineNumber, wm.startColumn, position.lineNumber, wm.endColumn);
            const note = "_builtin std module — “Go to definition” not implemented (browser sandbox) · "
              + (runs?"runs in the sandbox":typed?"type-checks (bundled)":"parse only") + "_";
            return { range:r, contents:[ {value:"```nimony\nimport std/"+nm+"\n```"}, {value:note} ] };
          }
        }
        const w = model.getWordAtPosition(position);
        if(!w) return null;
        const name = w.word;
        const range = new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
        const hits = lsp.index.byName.get(name);
        if(hits && hits.length){
          const s = pickBest(hits);
          const head = (KIND_LABEL[s.kind]||s.kind);
          const md = [ "```nimony\n"+s.detail+"\n```", "_"+head+(s.container?" · in `"+s.container+"`":" · top level")+"_" ];
          return { range, contents: md.map(v=>({value:v})) };
        }
        const std = STDLIB.find(x=>x.label===name);
        if(std) return { range, contents:[ {value:"```nimony\n"+std.detail+"\n```"}, {value:"_"+std.doc+"_"} ] };
        if(BUILTINS.indexOf(name)>=0) return { range, contents:[ {value:"```nimony\n"+name+"\n```"}, {value:"_builtin type_"} ] };
        if(KEYWORDS.indexOf(name)>=0) return { range, contents:[ {value:"_keyword_ `"+name+"`"} ] };
        return null;
      }
    });

    // --- go to definition ---
    monaco.languages.registerDefinitionProvider(LANG, {
      provideDefinition(model, position){
        const w = model.getWordAtPosition(position);
        if(!w) return null;
        const hits = lsp.index.byName.get(w.word);
        if(!hits || !hits.length) return null;
        const s = pickBest(hits);
        const text = model.getValue();
        const r = locate(s, text, 0);
        if(!r) return null;
        return { uri: model.uri, range: r };
      }
    });

    // --- completions ---
    monaco.languages.registerCompletionItemProvider(LANG, {
      triggerCharacters: [".", "/"],
      provideCompletionItems(model, position){
        // import context → module names instead of the normal symbol soup (feat 1)
        const lineToCursor = model.getValueInRange(
          new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));
        const ctx = importContext(lineToCursor);
        if(ctx){
          const mrange = new monaco.Range(position.lineNumber,
            position.column - ctx.partial.length, position.lineNumber, position.column);
          return moduleSuggestions(monaco, ctx, mrange);
        }
        const w = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
        const seen = new Set(), items = [];
        for(const s of lsp.index.symbols){
          if(seen.has(s.name+"#"+s.kind)) continue; seen.add(s.name+"#"+s.kind);
          items.push({ label:s.name, kind:compKind(monaco,s.kind), detail:s.detail,
            insertText:s.name, range });
        }
        for(const s of STDLIB)
          items.push({ label:s.label, kind:monaco.languages.CompletionItemKind.Function,
            detail:s.detail, documentation:s.doc, insertText:s.label, range });
        for(const t of BUILTINS)
          items.push({ label:t, kind:monaco.languages.CompletionItemKind.Class,
            detail:"builtin type", insertText:t, range });
        for(const k of KEYWORDS)
          items.push({ label:k, kind:monaco.languages.CompletionItemKind.Keyword,
            insertText:k, range });
        return { suggestions: items };
      }
    });

    // --- signature help (parameter hints inside a call) ---
    reg("registerSignatureHelpProvider", "signatureHelp", {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp(model, position){
        const text = model.getValue();
        const off = model.getOffsetAt(position);
        const call = enclosingCall(text, off);
        if(!call) return null;
        const hits = (lsp.index.byName.get(call.name) || []).filter(h=>ROUTINES.has(h.kind));
        let sig;
        if(hits.length){ sig = signatureOf(hits[0]); }
        else {
          const std = STDLIB.find(x=>x.label===call.name);
          if(!std) return null;
          sig = { label: std.detail, parameters: [] };
        }
        return { value:{ signatures:[sig], activeSignature:0,
          activeParameter: Math.min(call.argIndex, Math.max(0,(sig.parameters.length||1)-1)) },
          dispose(){} };
      }
    });

    // --- find all references + highlight occurrences ---
    reg("registerReferenceProvider", "references", {
      provideReferences(model, position){
        const w = model.getWordAtPosition(position); if(!w) return null;
        if(KEYWORDS.indexOf(w.word) >= 0) return null;
        return allOccurrences(model.getValue(), w.word).map(r => ({ uri:model.uri, range:r }));
      }
    });
    reg("registerDocumentHighlightProvider", "documentHighlight", {
      provideDocumentHighlights(model, position){
        const w = model.getWordAtPosition(position); if(!w) return null;
        if(KEYWORDS.indexOf(w.word) >= 0) return null;
        const K = monaco.languages.DocumentHighlightKind;
        return allOccurrences(model.getValue(), w.word).map(r => ({ range:r, kind:K.Text }));
      }
    });

    // --- code action: add a missing std import ---
    reg("registerCodeActionProvider", "codeAction", {
      provideCodeActions(model, range, context){
        const actions = [], added = new Set(), text = model.getValue();
        // aowlparser parse fixes: the classic `=`/`==` typo. The marker `code`
        // identifies it and its range is exactly the offending `=`, so replacing
        // that span with `==` is a deterministic, safe quick-fix.
        for(const d of (context.markers || [])){
          if(String(d.code||"") !== "assignment-in-condition") continue;
          actions.push({
            title: "Change `=` to `==`",
            kind: "quickfix",
            diagnostics: [d],
            isPreferred: true,
            edit: { edits: [ { resource: model.uri,
              textEdit: { range: new monaco.Range(d.startLineNumber, d.startColumn, d.endLineNumber, d.endColumn), text: "==" } } ] },
          });
        }
        for(const d of (context.markers || [])){
          const m = /undeclared identifier:\s*'?([A-Za-z_]\w*)'?/.exec(d.message || "");
          if(!m) continue;
          const mod = IMPORT_FIXES[m[1]];
          if(!mod || added.has(mod)) continue;
          if(new RegExp("^\\s*import\\s+.*\\b"+esc(mod.split("/").pop())+"\\b", "m").test(text)) continue;
          added.add(mod);
          actions.push({
            title: "Add `import " + mod + "`",
            kind: "quickfix",
            diagnostics: [d],
            isPreferred: true,
            edit: { edits: [ { resource: model.uri,
              textEdit: { range: new monaco.Range(1,1,1,1), text: "import " + mod + "\n" } } ] },
          });
        }
        // aowlsuggest quick-fixes: computed on the main thread from the parser's
        // diagnostics (see suggest.js + index.html runParse) and stashed on
        // window.__nifiSuggestFixes. Its coordinates are line 1-based, col 0-based
        // (endLine/endCol likewise) — shift cols +1 for Monaco. Only offer a fix
        // whose diagnostic line intersects the range Monaco is asking about; attach
        // it to the matching marker (same code + line) so it appears as that
        // diagnostic's quick-fix. `kind:"auto"` maps to a preferred quickfix.
        const sfixes = (typeof window !== "undefined" && window.__nifiSuggestFixes) || [];
        for(const f of sfixes){
          const sl = f.line | 0, el = (f.endLine != null ? f.endLine | 0 : sl);
          const sc = (f.col | 0) + 1, ec = (f.endCol != null ? (f.endCol | 0) + 1 : sc);
          if(el < range.startLineNumber || sl > range.endLineNumber) continue;
          const marker = (context.markers || []).find(d =>
                            String(d.code||"") === String(f.code||"") && d.startLineNumber === sl)
                      || (context.markers || []).find(d => d.startLineNumber === sl);
          const auto = f.kind === "auto";
          actions.push({
            title: f.title || f.message || "Apply fix",
            kind: "quickfix",
            diagnostics: marker ? [marker] : [],
            isPreferred: auto && !!f.isPreferred,
            edit: { edits: [ { resource: model.uri,
              textEdit: { range: new monaco.Range(sl, sc, el, ec), text: f.newText || "" } } ] },
          });
        }
        // Dedupe: the curated fixes above (e.g. `=`→`==`) may coincide with an
        // aowlsuggest fix for the same span — collapse identical (title + edit) ones.
        const seen = new Set();
        const deduped = actions.filter(a => {
          const e = a.edit && a.edit.edits && a.edit.edits[0];
          const k = (a.title||"") + "|" + (e ? JSON.stringify(e.textEdit.range) + "|" + e.textEdit.text : "");
          if(seen.has(k)) return false; seen.add(k); return true;
        });
        return { actions: deduped, dispose(){} };
      }
    });
  }

  // prefer a routine/type/global over a param/local when a name is ambiguous
  function pickBest(hits){
    const rank = s => (ROUTINES.has(s.kind)?0 : s.kind==="type"?1 : (s.kind==="const"||s.kind==="var"||s.kind==="let")?2 : 3);
    return hits.slice().sort((a,b)=>rank(a)-rank(b))[0];
  }

  // ---------------------------------------------------------------------------
  // 6. boot
  // ---------------------------------------------------------------------------
  window.NifiLsp = lsp;
  window.NifiEditor.onReady(()=>{
    const monaco = window.NifiEditor.getMonaco();
    if(!monaco){ // textarea fallback — no language services available
      if(window.__nifiLspStatus) window.__nifiLspStatus("off");
      return;
    }
    register(monaco);
    // now that STD_MODULES is exposed, (re)paint the import underlines (feat 2)
    if(window.NifiEditor.refreshImportDecorations) window.NifiEditor.refreshImportDecorations();
    lsp.ready = true;
    if(window.__nifiLspStatus) window.__nifiLspStatus("live");
  });
})();
