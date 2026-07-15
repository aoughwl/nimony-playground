// nifjs — a typed-NIF (.s.nif) -> native JavaScript transpiler: the playground's
// "⚡ Fast run" backend. Unlike nifi (which interprets the .s.nif on a simulated
// linear memory), nifjs EMITS JavaScript that maps nimony values onto native JS
// values (int/float -> number, bool -> boolean, string -> string) and runs it
// via new Function, so the browser's JIT compiles the hot loops. That trades
// exact linear-memory fidelity (int64 wraparound, ptr/ARC semantics) for ~1000x
// speed — so it's the FAST path, with nifi as the faithful fallback.
//
// Coverage is a deliberate subset (procs, int/float arithmetic, comparisons,
// if/while/for-range, calls, echo, string concat). Anything outside it makes
// emit() throw `Unsupported(...)`, and the caller falls back to nifi.
(function(global){
"use strict";

function Unsupported(what){ const e = new Error("nifjs: unsupported " + what); e.__nifjsUnsupported = true; return e; }

// ---------------------------------------------------------------------------
// 1. NIF S-expression reader -> nested nodes.
//    List node:  { tag, kids: [...] }
//    Atom node:  { str } | { chr } | { atom, def }   (line-info already stripped)
// ---------------------------------------------------------------------------
function deEscape(s){ return s.replace(/\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }

// An atom carries an optional trailing line-info (starting at the first '@' or
// '~' that isn't part of the token). Symbols/ints never contain '@' or '~', so
// splitting there yields the bare token.
function splitInfo(tok){
  const m = /[@~]/.exec(tok);
  return m ? tok.slice(0, m.index) : tok;
}

function readNif(src){
  let i = 0; const n = src.length;
  function ws(){ while(i < n && /\s/.test(src[i])) i++; }
  function readAtom(){
    // string literal
    if(src[i] === '"'){
      i++; let s = "";
      while(i < n && src[i] !== '"'){ s += src[i++]; }
      i++;                                   // closing quote
      while(i < n && !/[\s()]/.test(src[i])) i++;   // drop trailing line-info
      return { str: deEscape(s) };
    }
    // char literal '...'
    if(src[i] === "'"){
      i++; let s = "";
      while(i < n && src[i] !== "'"){ s += src[i++]; }
      i++;
      while(i < n && !/[\s()]/.test(src[i])) i++;
      const dec = deEscape(s);
      return { chr: dec.length ? dec.charCodeAt(0) : 0 };
    }
    // bare atom (symbol / literal / tag), possibly def-prefixed ':'
    let t = "";
    while(i < n && !/[\s()]/.test(src[i])){ t += src[i++]; }
    let def = false;
    if(t[0] === ':'){ def = true; t = t.slice(1); }
    return { atom: splitInfo(t), def };
  }
  function readNode(){
    ws();
    if(src[i] === '('){
      i++; ws();
      // tag is the first atom's bare token
      const first = readAtom();
      const tag = first.atom !== undefined ? first.atom : "";
      const kids = [];
      ws();
      while(i < n && src[i] !== ')'){ kids.push(readNode()); ws(); }
      i++;                                   // ')'
      return { tag, kids };
    }
    return readAtom();
  }
  const nodes = [];
  ws();
  while(i < n){ nodes.push(readNode()); ws(); }
  return nodes;
}

// ---------------------------------------------------------------------------
// 2. helpers over nodes
// ---------------------------------------------------------------------------
const isList = x => x && x.kids !== undefined;
const isAtom = x => x && x.atom !== undefined;
const isStr  = x => x && x.str !== undefined;
const isChr  = x => x && x.chr !== undefined;

// A nimony symbol like "fib.1." / "total.0." -> a stable, valid JS identifier.
function mangle(sym){
  return "v_" + deEscape(sym).replace(/[^A-Za-z0-9_]/g, "_");
}
// The bare operator/callee name behind a symbol atom. NIF symbols are
// `name.<disamb-number>.<module>` and the NAME itself may contain dots (operators
// like `..<`, `..`), so the name is everything before the first `.<digit>`.
//   "\2E.<.0.Inpqkww1." -> "..<"   "write.2.syn1lfpjv" -> "write"   "n.0" -> "n"
function opName(sym){
  const d = deEscape(sym);                   // decode \HH
  const m = /^(.*?)\.\d/.exec(d);
  return m ? m[1] : d.replace(/\.+$/, "");
}
function isIntLit(a){ return /^-?\d+$/.test(a); }
function isFloatLit(a){ return /^-?\d+\.\d+([eE][-+]?\d+)?$/.test(a); }

// ---------------------------------------------------------------------------
// 3. emitter: node -> JS source string
// ---------------------------------------------------------------------------
function emitModule(nodes){
  // find the top-level (stmts ...) of the main module
  let root = null;
  for(const nd of nodes){ if(isList(nd) && nd.tag === "stmts"){ root = nd; break; } }
  if(!root) throw Unsupported("module shape (no top-level stmts)");

  const procs = [], top = [];
  for(const s of root.kids){
    if(!isList(s)) continue;
    switch(s.tag){
      case "proc": procs.push(emitProc(s)); break;
      case "import": case "comment": case "iterator": case "func":
      case "type": case "typevars": case "include":
        break;                               // system helpers / metadata: skip
      default: top.push(emitStmt(s));
    }
  }
  return (
    "'use strict';\n" +
    "let __out='';\n" +
    "function __w(x){ __out += (x===true?'true':x===false?'false':String(x)); }\n" +
    procs.join("\n") + "\n" +
    "function __main(){\n" + top.join("\n") + "\n}\n" +
    "__main();\n" +
    "return __out;\n"
  );
}

function emitProc(p){
  // (proc :name . . . (params (param :x . . TYPE .)...) RETTYPE PRAGMAS BODY)
  const k = p.kids;
  const nameNode = k[0];
  if(!isAtom(nameNode)) throw Unsupported("proc name");
  const name = mangle(nameNode.atom);
  // locate params list and the body (last stmts)
  const params = k.find(x => isList(x) && x.tag === "params");
  const args = params ? params.kids.filter(x => isList(x) && x.tag === "param")
                               .map(pp => mangle(pp.kids[0].atom)) : [];
  const body = [...k].reverse().find(x => isList(x) && x.tag === "stmts");
  if(!body) throw Unsupported("proc without body (forward decl / extern)");
  return "function " + name + "(" + args.join(",") + "){\n" + emitStmts(body) + "\n}";
}

function emitStmts(node){ return node.kids.map(emitStmt).join("\n"); }

function emitStmt(s){
  if(!isList(s)) throw Unsupported("statement atom");
  switch(s.tag){
    case "stmts": return emitStmts(s);
    case "result": {                          // (result :result.0 . . TYPE .)
      const nm = mangle(s.kids[0].atom);
      return "let " + nm + " = " + zeroOf(s.kids[3]) + ";";
    }
    case "var": case "gvar": case "let": case "glet": case "cursor": {
      // (var :x . . TYPE INIT?)   INIT is the last child if present & non-'.'
      const nm = mangle(s.kids[0].atom);
      const init = s.kids[s.kids.length - 1];
      const val = (init && (isList(init) || isStr(init) || isChr(init) ||
                   (isAtom(init) && init.atom !== "."))) ? emitExpr(init) : zeroOf(s.kids[3]);
      return "let " + nm + " = " + val + ";";
    }
    case "asgn": return emitExpr(s.kids[0]) + " = " + emitExpr(s.kids[1]) + ";";
    case "ret": {
      const v = s.kids[0];
      return v ? "return " + emitExpr(v) + ";" : "return;";
    }
    case "if":    return emitIf(s);
    case "while": return "while(" + emitExpr(s.kids[0]) + "){\n" + emitStmts(s.kids[1]) + "\n}";
    case "for":   return emitFor(s);
    case "cmd": case "call": {
      const c = emitCallLike(s);
      return c + ";";
    }
    case "discard": return s.kids[0] && !(isAtom(s.kids[0]) && s.kids[0].atom===".") ? emitExpr(s.kids[0]) + ";" : ";";
    case "break": return "break;";
    case "block": {                           // (block . BODY) or (block :lbl BODY)
      const b = [...s.kids].reverse().find(x => isList(x) && x.tag === "stmts");
      return "{\n" + (b ? emitStmts(b) : "") + "\n}";
    }
    default: throw Unsupported("statement '" + s.tag + "'");
  }
}

function emitIf(s){
  // (if (elif COND STMTS) (elif COND STMTS)... (else STMTS)?)
  const parts = [];
  for(const br of s.kids){
    if(!isList(br)) continue;
    if(br.tag === "elif") parts.push("if(" + emitExpr(br.kids[0]) + "){\n" + emitStmts(br.kids[1]) + "\n}");
    else if(br.tag === "else") parts.push("{\n" + emitStmts(br.kids[0]) + "\n}");
    else throw Unsupported("if-branch '" + br.tag + "'");
  }
  return parts.join(" else ");
}

function emitFor(s){
  // (for ITER (unpackflat (let :i . . TYPE .)) BODY)
  const iter = s.kids[0], varspec = s.kids[1], body = s.kids[2];
  // loop variable
  let vnode = varspec;
  if(isList(varspec) && varspec.tag === "unpackflat") vnode = varspec.kids[0];
  if(!isList(vnode) || !(vnode.tag === "let" || vnode.tag === "var")) throw Unsupported("for-var shape");
  const v = mangle(vnode.kids[0].atom);
  // iterable must be a range: (infix ..<|.. A B)  (nimony lowers a..b / a..<b)
  if(!(isList(iter) && (iter.tag === "infix" || iter.tag === "range" || iter.tag === "..") ))
    throw Unsupported("for over non-range iterator");
  const op = isAtom(iter.kids[0]) ? opName(iter.kids[0].atom) : "";
  let lo, hi, cmp;
  if(iter.tag === "infix"){
    if(op === "..<"){ lo = iter.kids[1]; hi = iter.kids[2]; cmp = "<"; }
    else if(op === ".."){ lo = iter.kids[1]; hi = iter.kids[2]; cmp = "<="; }
    else throw Unsupported("for range op '" + op + "'");
  } else { lo = iter.kids[0]; hi = iter.kids[1]; cmp = iter.tag === ".." ? "<=" : "<"; }
  return "for(let " + v + " = " + emitExpr(lo) + "; " + v + " " + cmp + " " + emitExpr(hi) + "; " + v + "++){\n" +
         emitStmts(body) + "\n}";
}

// arithmetic/relational tags whose FIRST kid is the result-type node (skip it).
const BINOP = { add:"+", sub:"-", mul:"*", lt:"<", le:"<=", gt:">", ge:">=", eq:"===", neq:"!==" };
const BINOP_NOTYPE = { and:"&&", or:"||" };

function emitCallLike(s){
  // (call CALLEE ARGS...) or (cmd CALLEE ARGS...)
  const callee = s.kids[0];
  const name = isAtom(callee) ? opName(callee.atom) : null;
  const rawArgs = s.kids.slice(1);
  // echo lowering: write.N.syncio(stdout, x) -> __w(x)
  if(name === "write" || name === "writeLine" || name === "echo"){
    // args: [stdout, value]  (or just [value] for echo)
    const val = rawArgs.length >= 2 ? rawArgs[1] : rawArgs[0];
    return "__w(" + emitExpr(val) + ")";
  }
  if(name === "&") return "(" + rawArgs.map(emitExpr).join(" + ") + ")";     // string concat
  if(name === "inc" || name === "dec") throw Unsupported("inplace " + name);
  if(!isAtom(callee)) throw Unsupported("indirect call");
  return mangle(callee.atom) + "(" + rawArgs.map(emitExpr).join(", ") + ")";
}

function emitExpr(e){
  if(isStr(e)) return JSON.stringify(e.str);
  if(isChr(e)) return JSON.stringify(String.fromCharCode(e.chr));
  if(isAtom(e)){
    const a = e.atom;
    if(a === "true") return "true";
    if(a === "false") return "false";
    if(a === "nil") return "null";
    if(isIntLit(a) || isFloatLit(a)) return a;
    return mangle(a);                         // symbol reference
  }
  if(!isList(e)) throw Unsupported("expr");
  const t = e.tag;
  if(BINOP[t]){                               // (op TYPE a b) -> (a op b)
    // JS numbers are exact to 2^53 — closer to nimony's int64 than a 32-bit
    // (|0) truncation would be, so we emit plain arithmetic. (Values past 2^53,
    // and exact int64 wraparound, are where you'd drop back to nifi.)
    const a = e.kids[e.kids.length - 2], b = e.kids[e.kids.length - 1];
    return "(" + emitExpr(a) + " " + BINOP[t] + " " + emitExpr(b) + ")";
  }
  if(BINOP_NOTYPE[t]) return "(" + emitExpr(e.kids[0]) + " " + BINOP_NOTYPE[t] + " " + emitExpr(e.kids[1]) + ")";
  switch(t){
    case "div": { const a = e.kids[e.kids.length-2], b = e.kids[e.kids.length-1];
      return "(Math.trunc(" + emitExpr(a) + " / " + emitExpr(b) + "))"; }
    case "mod": { const a = e.kids[e.kids.length-2], b = e.kids[e.kids.length-1];
      return "(" + emitExpr(a) + " % " + emitExpr(b) + ")"; }
    case "neg": return "(-" + emitExpr(e.kids[e.kids.length-1]) + ")";
    case "not": return "(!" + emitExpr(e.kids[0]) + ")";
    case "call": case "cmd": return emitCallLike(e);
    case "infix": {                           // generic infix as a call: (infix OP a b)
      const op = isAtom(e.kids[0]) ? opName(e.kids[0].atom) : "";
      if(op === "&") return "(" + emitExpr(e.kids[1]) + " + " + emitExpr(e.kids[2]) + ")";
      throw Unsupported("infix '" + op + "'");
    }
    case "paren": case "expr": return "(" + emitExpr(e.kids[e.kids.length-1]) + ")";
    case "conv": case "hconv": case "cast": return emitExpr(e.kids[e.kids.length-1]);  // numeric conv: identity in JS
    case "true": return "true";
    case "false": return "false";
    default: throw Unsupported("expr '" + t + "'");
  }
}

// zero value for a type node (used for `result`/uninitialised vars)
function zeroOf(typeNode){
  if(isList(typeNode)){
    if(typeNode.tag === "i" || typeNode.tag === "u") return "0";
    if(typeNode.tag === "f") return "0";
    if(typeNode.tag === "bool") return "false";
  }
  if(isAtom(typeNode)){
    const t = opName(typeNode.atom);
    if(/^(int|uint|float)/.test(t)) return "0";
    if(t === "bool") return "false";
    if(t === "string") return '""';
  }
  return "0";
}

// ---------------------------------------------------------------------------
// 4. public API: compile .s.nif text -> JS source; run -> output string
// ---------------------------------------------------------------------------
function compile(snifText){ return emitModule(readNif(snifText)); }
function run(snifText){
  const js = compile(snifText);
  return (new Function(js))();
}

const api = { compile, run, readNif, _emitModule: emitModule };
if(typeof module !== "undefined" && module.exports) module.exports = api;
if(global) global.NifiJs = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
