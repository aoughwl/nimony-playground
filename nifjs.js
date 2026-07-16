// nifjs — a typed-NIF (.s.nif) -> native JavaScript transpiler: the playground's
// "Fast run" backend. Unlike nifi (which interprets the .s.nif on a simulated
// linear memory), nifjs EMITS JavaScript that maps nimony values onto native JS
// values (int/float -> number, bool -> boolean, string -> string) and runs it
// via new Function, so the browser's JIT compiles the hot loops. That trades
// exact linear-memory fidelity (int64 wraparound, ptr/ARC semantics) for ~1000x
// speed — so it's the FAST path, with nifi as the faithful fallback.
//
// Coverage is broad — it runs essentially all of the language nimony can
// currently express: procs + recursion (mutual and NESTED / closures), GENERIC
// instances (monomorphised); int & float arithmetic (float `/` kept distinct
// from int `div`) + comparisons; logical and bitwise and/or/xor/not/shl/shr;
// if/elif/else + if-EXPRESSIONS; case (statement & expression, ranges, string
// selectors); while with break/continue; for over ranges, collections,
// `countdown`, and `for i, x in` pairs; inc/dec; const, enums (-> ordinals),
// `when`, discard; seq/array literals + indexing (get/set), len, add/pop (add is
// seq-push / string-append aware); objects (construct / field read+write, incl.
// through a seq), object VARIANTS, tuples (construct / access / unpack); strings
// (concat, add, $, len, index, ord/chr); echo (float-aware); bool; and a SHIM
// REGISTRY mapping stdlib / `importc` routines (math.*, strutils.*, parse*,
// abs/min/max) to native JS — the FFI path.
//
// SAFETY: a `var`/`out` parameter (whose mutation can't round-trip through JS's
// pass-by-value) drops the routine so its callers fall back — never silently
// wrong. Enum/const/array/etc. that were once crashes or fall-backs are handled.
//
// ROBUSTNESS: nifjs never emits a reference to a routine it didn't emit — a call
// to any proc/func it can't build (a complex stdlib routine, an unsupported
// node) throws `Unsupported(...)`, so the WHOLE program falls back to the
// faithful nifi engines instead of crashing on an undefined function. Emitting a
// routine is best-effort and isolated: one un-emittable routine only forces a
// fall back for programs that actually reach it.
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
// bit width of an integer type node like (i 64) / (u 32); default 64.
function intBits(ty){
  const w = ty.kids && ty.kids[ty.kids.length - 1];
  const n = isAtom(w) ? parseInt(w.atom, 10) : NaN;
  return Number.isFinite(n) ? n : 64;
}
function isFloatLit(a){ return /^-?\d+\.\d+([eE][-+]?\d+)?$/.test(a); }
// Best-effort "is this expression statically a float?" — used only to pick the
// float-preserving writer (7.0 vs 7). A float literal, or an arithmetic op whose
// result-type child is `(f …)`. A bare float VAR can't be told apart here (no
// type tracking), so those still print like an int — a documented divergence.
function isFloatExpr(n){
  if(isAtom(n)) return isFloatLit(n.atom);
  if(!isList(n)) return false;
  if(n.tag === "f" || n.tag === "fconv") return true;
  if((BINOP[n.tag] || n.tag === "div" || n.tag === "neg") && isList(n.kids[0]) && n.kids[0].tag === "f") return true;
  if(n.tag === "conv" || n.tag === "hconv" || n.tag === "paren" || n.tag === "expr")
    return isFloatExpr(n.kids[n.kids.length - 1]);
  if((n.tag === "call" || n.tag === "hcall") && isAtom(n.kids[0]) && FLOAT_RET.has(opName(n.kids[0].atom)))
    return true;                               // a math shim that returns a float
  return false;
}
const FLOAT_RET = new Set(["sqrt","cbrt","pow","hypot","ln","log10","log2","exp",
  "sin","cos","tan","arcsin","arccos","arctan","arctan2","sinh","cosh","tanh","parseFloat"]);
// address-of / deref wrappers carry no meaning once values are native JS.
function unwrapAddr(n){
  while(isList(n) && (n.tag==="haddr"||n.tag==="addr"||n.tag==="hderef"||n.tag==="deref"))
    n = n.kids[n.kids.length-1];
  return n;
}

// ---------------------------------------------------------------------------
// 3. emitter: node -> JS source string
// ---------------------------------------------------------------------------
// Routine resolution state (set per emitModule). `_defined` = every proc/func
// name in the module; `_available` = the ones that actually emitted (null while
// still emitting bodies). A call to a name not in the active set throws
// Unsupported → clean fall back to nifi, so the emitted JS NEVER references an
// undefined function (no runtime crash on an un-emittable stdlib routine).
let _defined = new Set(), _available = null;
// enum value (mangled symbol) -> its ordinal string, collected from `type` decls.
let _enumVals = new Map();
function scanEnums(root){
  _enumVals = new Map();
  for(const s of root.kids){
    if(!isList(s) || s.tag !== "type") continue;
    for(const c of s.kids){
      if(!isList(c) || c.tag !== "enum") continue;
      for(const ef of c.kids){
        if(isList(ef) && ef.tag === "efld" && isAtom(ef.kids[0])){
          const tup = ef.kids.find(x => isList(x) && x.tag === "tup");
          if(tup && tup.kids.length && isAtom(tup.kids[0]))
            _enumVals.set(mangle(ef.kids[0].atom), tup.kids[0].atom);
        }
      }
    }
  }
}

const SKIP_DECLS = new Set(["import","comment","iterator","type","typevars",
  "include","converter","template","macro","pragmas","emit","using"]);

// every proc/func name anywhere in the tree (nested/closures included).
function collectAllRoutines(node, out){
  if(!isList(node)) return;
  if((node.tag === "proc" || node.tag === "func") && isAtom(node.kids[0]))
    out.add(mangle(node.kids[0].atom));
  for(const c of node.kids) collectAllRoutines(c, out);
}

function emitModule(nodes){
  // find the top-level (stmts ...) of the main module
  let root = null;
  for(const nd of nodes){ if(isList(nd) && nd.tag === "stmts"){ root = nd; break; } }
  if(!root) throw Unsupported("module shape (no top-level stmts)");
  scanEnums(root);                              // enum value -> ordinal, before emit

  // 1. collect routine defs (proc AND func) + the top-level statements.
  const routines = [], topStmts = [];
  for(const s of root.kids){
    if(!isList(s)) continue;
    if((s.tag === "proc" || s.tag === "func") && isAtom(s.kids[0]))
      routines.push({ mn: mangle(s.kids[0].atom), node: s });
    else if(!SKIP_DECLS.has(s.tag))
      topStmts.push(s);
  }
  // _defined = EVERY proc/func name in the module, nested ones included, so a
  // call to a nested (closure) routine resolves. `routines` above stays
  // top-level — nested ones are emitted inline inside their parent's body.
  _defined = new Set(); collectAllRoutines(root, _defined);
  _available = null;

  // 2. emit each routine independently; one that hits an unsupported node just
  //    drops out (its callers fall back) instead of failing the whole module.
  const emitted = new Map();     // mn -> js
  const failed = new Set();
  for(const r of routines){
    if(emitted.has(r.mn)) continue;            // keep the first body that emits
    try { emitted.set(r.mn, emitProc(r.node)); failed.delete(r.mn); }
    catch(e){ if(e && e.__nifjsUnsupported){ if(!emitted.has(r.mn)) failed.add(r.mn); } else throw e; }
  }
  // 3. fixpoint: any emitted routine that references a failed one is itself
  //    unavailable (so we never emit a call to a dropped routine).
  let changed = true;
  while(changed){
    changed = false;
    for(const [mn, js] of emitted){
      for(const f of failed){
        if(mn !== f && new RegExp("\\b" + f + "\\b").test(js)){
          emitted.delete(mn); failed.add(mn); changed = true; break;
        }
      }
      if(changed) break;
    }
  }
  _available = new Set(emitted.keys());

  // 4. emit top-level with `_available` active — a call to a dropped/unknown
  //    routine throws here and the whole module falls back cleanly.
  const top = topStmts.map(emitStmt);

  return (
    "'use strict';\n" +
    "let __out='';\n" +
    "function __w(x){ __out += (x===true?'true':x===false?'false':String(x)); }\n" +
    // nimony prints a float with a decimal point (7.0, not 7); JS String drops it.
    "function __wf(x){ __out += (Number.isInteger(x) ? x + '.0' : String(x)); }\n" +
    // add: string append (immutable → return new) vs seq push (mutate + return).
    "function __add(c, v){ if(typeof c === 'string') return c + v; c.push(v); return c; }\n" +
    [...emitted.values()].join("\n") + "\n" +
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
  const paramNodes = params ? params.kids.filter(x => isList(x) && x.tag === "param") : [];
  for(const pp of paramNodes){
    // a `var`/`out` param has a `(mut …)`/`(out …)` type — mutation through it
    // can't round-trip in JS (native values, no by-reference), so this routine
    // isn't safe to transpile: drop it (callers fall back) rather than run wrong.
    const ty = pp.kids[3];
    if(isList(ty) && (ty.tag === "mut" || ty.tag === "out"))
      throw Unsupported("var/out parameter (no pass-by-reference in JS)");
  }
  const args = paramNodes.map(pp => mangle(pp.kids[0].atom));
  const body = [...k].reverse().find(x => isList(x) && x.tag === "stmts");
  if(!body) throw Unsupported("proc without body (forward decl / extern)");
  return "function " + name + "(" + args.join(",") + "){\n" + emitStmts(body) + "\n}";
}

function emitStmts(node){ return node.kids.map(emitStmt).join("\n"); }

function emitStmt(s){
  if(!isList(s)) throw Unsupported("statement atom");
  if(SKIP_DECLS.has(s.tag)) return "";         // nested type/template/pragma/… : no runtime effect
  switch(s.tag){
    case "stmts": return emitStmts(s);
    case "result": {                          // (result :result.0 . . TYPE .)
      const nm = mangle(s.kids[0].atom);
      return "let " + nm + " = " + zeroOf(s.kids[3]) + ";";
    }
    case "var": case "gvar": case "let": case "glet": case "cursor":
    case "const": case "gconst": {
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
    case "proc": case "func": return emitProc(s);   // nested proc -> nested JS function (closure)
    case "if":    return emitIf(s);
    case "case":  return emitCase(s, false);
    case "while": return "while(" + emitExpr(s.kids[0]) + "){\n" + emitStmts(s.kids[1]) + "\n}";
    case "for":   return emitFor(s);
    case "cmd": case "call": case "hcall": {
      const c = emitCallLike(s);
      return c + ";";
    }
    case "discard": return s.kids[0] && !(isAtom(s.kids[0]) && s.kids[0].atom===".") ? emitExpr(s.kids[0]) + ";" : ";";
    case "break": return "break;";
    case "continue": return "continue;";
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

// if-EXPRESSION: (if (elif COND (expr V)) … (else (expr V))) — an IIFE that
// returns the chosen branch's value.
function emitIfExpr(e){
  const parts = []; let elsePart = "";
  for(const br of e.kids){
    if(!isList(br)) continue;
    if(br.tag === "elif") parts.push("if(" + emitExpr(br.kids[0]) + "){ return " + emitExpr(br.kids[1]) + "; }");
    else if(br.tag === "else") elsePart = " else { return " + emitExpr(br.kids[0]) + "; }";
    else throw Unsupported("if-expr branch '" + br.tag + "'");
  }
  return "(function(){ " + parts.join(" else ") + elsePart + " })()";
}

// Dig a for-loop iterable down to the underlying collection: nimony lowers
// `for x in xs` to `items(toOpenArray(xs))` etc., wrapped in hderef.
function collOf(node){
  while(isList(node)){
    const t = node.tag;
    if(t === "hderef" || t === "deref"){ node = node.kids[node.kids.length-1]; continue; }
    if(t === "call" || t === "hcall"){
      const nm = isAtom(node.kids[0]) ? opName(node.kids[0].atom) : "";
      if(nm === "items" || nm === "mitems" || nm === "pairs" || nm === "toOpenArray"){
        node = node.kids[1]; continue;         // first argument is the collection
      }
    }
    break;
  }
  return node;
}

// case — both statement `(case SEL (of (ranges …) STMTS) … (else STMTS))` and
// expression `(case SEL (of (ranges …) (expr E)) … (else (expr E)))`. Emitted as
// an if-chain over the selector, bound once to a local.
function emitRanges(sel, rangesNode){
  return rangesNode.kids.map(k => {
    if(isList(k) && k.tag === "range")
      return "(" + sel + " >= " + emitExpr(k.kids[0]) + " && " + sel + " <= " + emitExpr(k.kids[1]) + ")";
    return "(" + sel + " === " + emitExpr(k) + ")";
  }).join(" || ");
}
function caseBody(b, asExpr){
  if(asExpr) return "return " + emitExpr(b) + ";";
  if(isList(b) && b.tag === "stmts") return emitStmts(b);
  return emitExpr(b) + ";";
}
function emitCase(node, asExpr){
  const sel = "_s", parts = []; let elsePart = "";
  for(const br of node.kids.slice(1)){
    if(!isList(br)) continue;
    if(br.tag === "of") parts.push("if(" + emitRanges(sel, br.kids[0]) + "){ " + caseBody(br.kids[1], asExpr) + " }");
    else if(br.tag === "else") elsePart = " else { " + caseBody(br.kids[0], asExpr) + " }";
    else throw Unsupported("case branch '" + br.tag + "'");
  }
  const chain = parts.join(" else ") + elsePart;
  const selExpr = emitExpr(node.kids[0]);
  return asExpr
    ? "(function(" + sel + "){ " + chain + " })(" + selExpr + ")"
    : "{ const " + sel + " = " + selExpr + "; " + chain + " }";
}

function emitFor(s){
  // (for ITER VARSPEC BODY). VARSPEC is (unpackflat (let :v …)…) — 1 var for a
  // plain `for x in`, 2 for `for i, x in` (index, value).
  const iter = s.kids[0], varspec = s.kids[1], body = s.kids[2];
  let vnodes = [];
  if(isList(varspec) && varspec.tag === "unpackflat")
    vnodes = varspec.kids.filter(x => isList(x) && (x.tag === "let" || x.tag === "var"));
  else if(isList(varspec) && (varspec.tag === "let" || varspec.tag === "var"))
    vnodes = [varspec];
  if(!vnodes.length) throw Unsupported("for-var shape");
  const vs = vnodes.map(v => mangle(v.kids[0].atom));

  // range loop: (infix ..<|.. A B)
  if(isList(iter) && iter.tag === "infix"){
    const op = isAtom(iter.kids[0]) ? opName(iter.kids[0].atom) : "";
    let cmp;
    if(op === "..<") cmp = "<";
    else if(op === "..") cmp = "<=";
    else throw Unsupported("for range op '" + op + "'");
    return "for(let " + vs[0] + " = " + emitExpr(iter.kids[1]) + "; " + vs[0] + " " + cmp + " " +
           emitExpr(iter.kids[2]) + "; " + vs[0] + "++){\n" + emitStmts(body) + "\n}";
  }
  // countdown(hi, lo, [step]) -> descending loop
  if(isList(iter) && (iter.tag === "call" || iter.tag === "hcall") &&
     isAtom(iter.kids[0]) && opName(iter.kids[0].atom) === "countdown"){
    const step = iter.kids[3] ? emitExpr(iter.kids[3]) : "1";
    return "for(let " + vs[0] + " = " + emitExpr(iter.kids[1]) + "; " + vs[0] + " >= " +
           emitExpr(iter.kids[2]) + "; " + vs[0] + " -= " + step + "){\n" + emitStmts(body) + "\n}";
  }
  // collection loop over a seq/array/string.
  const coll = emitExpr(collOf(iter));
  if(vs.length >= 2)   // for i, x in xs -> index + value
    return "{ const _c = " + coll + "; for(let " + vs[0] + " = 0; " + vs[0] + " < _c.length; " +
           vs[0] + "++){ const " + vs[1] + " = _c[" + vs[0] + "];\n" + emitStmts(body) + "\n} }";
  return "for(const " + vs[0] + " of " + coll + "){\n" + emitStmts(body) + "\n}";
}

// arithmetic/relational/bitwise tags whose FIRST kid is the result-type node
// (skipped). Bitwise ops are correct within JS's 32-bit bitwise envelope — a
// shift/mask past 2^31 diverges (see the fidelity note); that's the fast path.
const BINOP = { add:"+", sub:"-", mul:"*", lt:"<", le:"<=", gt:">", ge:">=", eq:"===", neq:"!==",
                bitand:"&", bitor:"|", bitxor:"^", shl:"<<", shr:">>", ashr:">>" };
const BINOP_NOTYPE = { and:"&&", or:"||" };   // logical only — bitwise are the bit* tags

// Shim registry — the native-JS equivalent of a stdlib / `importc` routine,
// keyed by the nimony proc's base name. This is how nifjs "allows importc" and
// covers math/strutils/parseutils without a body to transpile: when a called
// routine isn't one nifjs built itself, and a shim exists, emit the JS directly
// (native values, no marshaling). A user proc of the same name always wins (it's
// checked first). Each entry maps the emitted arg strings to a JS expression.
const SHIMS = {
  // --- math (operates on JS numbers) ---
  sqrt:a=>`Math.sqrt(${a[0]})`, cbrt:a=>`Math.cbrt(${a[0]})`,
  pow:a=>`Math.pow(${a[0]}, ${a[1]})`, hypot:a=>`Math.hypot(${a[0]}, ${a[1]})`,
  floor:a=>`Math.floor(${a[0]})`, ceil:a=>`Math.ceil(${a[0]})`,
  round:a=>`Math.round(${a[0]})`, trunc:a=>`Math.trunc(${a[0]})`,
  ln:a=>`Math.log(${a[0]})`, log10:a=>`Math.log10(${a[0]})`, log2:a=>`Math.log2(${a[0]})`,
  exp:a=>`Math.exp(${a[0]})`,
  sin:a=>`Math.sin(${a[0]})`, cos:a=>`Math.cos(${a[0]})`, tan:a=>`Math.tan(${a[0]})`,
  arcsin:a=>`Math.asin(${a[0]})`, arccos:a=>`Math.acos(${a[0]})`, arctan:a=>`Math.atan(${a[0]})`,
  arctan2:a=>`Math.atan2(${a[0]}, ${a[1]})`,
  sinh:a=>`Math.sinh(${a[0]})`, cosh:a=>`Math.cosh(${a[0]})`, tanh:a=>`Math.tanh(${a[0]})`,
  floorMod:a=>`(((${a[0]}) % (${a[1]})) + (${a[1]})) % (${a[1]})`,
  // --- strutils / string (JS string; several also work on JS arrays) ---
  toUpperAscii:a=>`(${a[0]}).toUpperCase()`, toLowerAscii:a=>`(${a[0]}).toLowerCase()`,
  toUpper:a=>`(${a[0]}).toUpperCase()`, toLower:a=>`(${a[0]}).toLowerCase()`,
  strip:a=>`(${a[0]}).trim()`,
  startsWith:a=>`(${a[0]}).startsWith(${a[1]})`, endsWith:a=>`(${a[0]}).endsWith(${a[1]})`,
  contains:a=>`(${a[0]}).includes(${a[1]})`,
  repeat:a=>`(${a[0]}).repeat(${a[1]})`,
  find:a=>`(${a[0]}).indexOf(${a[1]})`, rfind:a=>`(${a[0]}).lastIndexOf(${a[1]})`,
  replace:a=>`(${a[0]}).split(${a[1]}).join(${a[2]})`,
  join:a=>`(${a[0]}).join(${a.length>1?a[1]:'""'})`,
  split:a=>`(${a[0]}).split(${a[1]})`,
  parseInt:a=>`parseInt(${a[0]}, 10)`, parseFloat:a=>`parseFloat(${a[0]})`,
  intToStr:a=>`String(${a[0]})`,
};

function emitCallLike(s){
  // (call CALLEE ARGS...) or (cmd CALLEE ARGS...)
  const callee = s.kids[0];
  const name = isAtom(callee) ? opName(callee.atom) : null;
  const rawArgs = s.kids.slice(1);
  // echo lowering: write.N.syncio(stdout, x) -> __w(x). A statically-float value
  // is written with __wf so integer-valued floats keep their ".0".
  if(name === "write" || name === "writeLine" || name === "echo"){
    // args: [stdout, value]  (or just [value] for echo)
    const val = rawArgs.length >= 2 ? rawArgs[1] : rawArgs[0];
    return (isFloatExpr(val) ? "__wf(" : "__w(") + emitExpr(val) + ")";
  }
  if(name === "&") return "(" + rawArgs.map(emitExpr).join(" + ") + ")";     // string concat
  if(name === "inc" || name === "dec"){          // (cmd inc (haddr x) [k]) -> x += k
    const lval = emitExpr(unwrapAddr(rawArgs[0]));
    const by = rawArgs.length >= 2 ? emitExpr(rawArgs[1]) : "1";
    return "(" + lval + (name === "inc" ? " += " : " -= ") + by + ")";
  }
  // seq / array / string builtins — nimony values map onto native JS ones, so
  // these become the obvious JS. `[]` is the index operator, decoded from \5B\5D.
  if(name === "len") return "(" + emitExpr(unwrapAddr(rawArgs[0])) + ".length)";
  if(name === "[]" || name === "[]=") {          // index get/set
    const base = emitExpr(unwrapAddr(rawArgs[0])), idx = emitExpr(rawArgs[1]);
    if(name === "[]=") return "(" + base + "[" + idx + "] = " + emitExpr(rawArgs[2]) + ")";
    return "(" + base + "[" + idx + "])";
  }
  if(name === "add"){                            // seq.add -> push; string.add -> reassign (JS strings are immutable)
    const lv = emitExpr(unwrapAddr(rawArgs[0]));
    return "(" + lv + " = __add(" + lv + ", " + emitExpr(rawArgs[1]) + "))";
  }
  if(name === "$") return "String(" + emitExpr(rawArgs[0]) + ")";
  if(name === "high") return "(" + emitExpr(unwrapAddr(rawArgs[0])) + ".length - 1)";
  if(name === "low") return "0";
  if(name === "newSeq" || name === "newSeqUninit" || name === "newSeqOfCap"){
    if(name === "newSeqOfCap") return "[]";
    return "new Array(" + emitExpr(rawArgs[rawArgs.length-1]) + ").fill(0)";
  }
  // char <-> int. chars are 1-char JS strings (so string indexing / echo just
  // work); ord reads the code, chr builds the char.
  if(name === "chr" || name === "toChar") return "String.fromCharCode(" + emitExpr(rawArgs[0]) + ")";
  if(name === "ord") return "(" + emitExpr(rawArgs[0]) + ").charCodeAt(0)";
  if(name === "abs") return "Math.abs(" + emitExpr(rawArgs[0]) + ")";
  if(name === "min") return "Math.min(" + rawArgs.map(emitExpr).join(", ") + ")";
  if(name === "max") return "Math.max(" + rawArgs.map(emitExpr).join(", ") + ")";
  if(name === "pop") return "(" + emitExpr(unwrapAddr(rawArgs[0])) + ".pop())";
  if(!isAtom(callee)) throw Unsupported("indirect call");
  const base = opName(callee.atom), mn = mangle(callee.atom);
  // 1. a routine nifjs actually built (user proc, or a transpilable stdlib one)
  //    takes precedence — even over a same-named shim.
  if(_available ? _available.has(mn) : _defined.has(mn))
    return mn + "(" + rawArgs.map(emitExpr).join(", ") + ")";
  // 2. a native-JS shim for a stdlib / importc routine (the FFI path). Note this
  //    also fires for an importc proc: its body doesn't transpile, so it's not in
  //    the emitted set, and if a shim exists we emit the native equivalent.
  if(SHIMS[base]) return SHIMS[base](rawArgs.map(emitExpr));
  // 3. otherwise fall back — never emit a reference to a function we didn't build.
  throw Unsupported("call to '" + base + "'");
}

function emitExpr(e){
  if(isStr(e)) return JSON.stringify(e.str);
  if(isChr(e)) return JSON.stringify(String.fromCharCode(e.chr));
  if(isAtom(e)){
    const a = e.atom;
    const mn = mangle(a);
    if(_enumVals.has(mn)) return _enumVals.get(mn);   // enum value -> its ordinal
    if(a === "true") return "true";
    if(a === "false") return "false";
    if(a === "nil") return "null";
    if(isIntLit(a) || isFloatLit(a)) return a;
    return mangle(a);                         // symbol reference
  }
  if(!isList(e)) throw Unsupported("expr");
  const t = e.tag;
  if(BINOP[t]){                               // (op TYPE a b) -> (a op b)
    const a = e.kids[e.kids.length - 2], b = e.kids[e.kids.length - 1];
    const A = emitExpr(a), B = emitExpr(b);
    // Exact integer WRAPPING for sub-64-bit widths. JS numbers are float64
    // (exact to 2^53), which is right for the default 64-bit `int`; but 8/16/32-bit
    // arithmetic must wrap on overflow — this is what makes hashing correct
    // (`hash * prime` in 32-bit), the fidelity self-hosting the checker needs.
    if((t === "add" || t === "sub" || t === "mul") && isList(e.kids[0]) &&
       (e.kids[0].tag === "i" || e.kids[0].tag === "u")){
      const bits = intBits(e.kids[0]), uns = e.kids[0].tag === "u";
      if(bits && bits < 64){
        if(t === "mul" && bits === 32)
          return uns ? "((Math.imul(" + A + ", " + B + ")) >>> 0)" : "(Math.imul(" + A + ", " + B + "))";
        const raw = "(" + A + " " + BINOP[t] + " " + B + ")";
        if(bits === 32) return uns ? "((" + raw + ") >>> 0)" : "((" + raw + ") | 0)";
        const mask = (1 << bits) - 1;          // 8/16-bit
        return uns ? "((" + raw + ") & " + mask + ")"
                   : "(((" + raw + ") << " + (32 - bits) + ") >> " + (32 - bits) + ")";
      }
    }
    return "(" + A + " " + BINOP[t] + " " + B + ")";
  }
  if(BINOP_NOTYPE[t]) return "(" + emitExpr(e.kids[0]) + " " + BINOP_NOTYPE[t] + " " + emitExpr(e.kids[1]) + ")";
  switch(t){
    case "div": {                              // int `div` truncates; float `/` shares this tag
      const ty = e.kids[0], a = e.kids[e.kids.length-2], b = e.kids[e.kids.length-1];
      if(isList(ty) && ty.tag === "f") return "(" + emitExpr(a) + " / " + emitExpr(b) + ")";
      return "(Math.trunc(" + emitExpr(a) + " / " + emitExpr(b) + "))"; }
    case "mod": { const a = e.kids[e.kids.length-2], b = e.kids[e.kids.length-1];
      return "(" + emitExpr(a) + " % " + emitExpr(b) + ")"; }
    case "neg": return "(-" + emitExpr(e.kids[e.kids.length-1]) + ")";
    case "not": return "(!" + emitExpr(e.kids[0]) + ")";        // logical (bool)
    case "bitnot": return "(~" + emitExpr(e.kids[e.kids.length-1]) + ")";  // bitwise (int)
    case "call": case "cmd": case "hcall": return emitCallLike(e);
    case "case": return emitCase(e, true);     // case-expression
    case "if": return emitIfExpr(e);           // if-expression
    case "aconstr": {                          // array constructor: (aconstr TYPE e0 e1 …)
      return "[" + e.kids.slice(1).map(emitExpr).join(", ") + "]";
    }
    case "bracket": return "[" + e.kids.map(emitExpr).join(", ") + "]";   // [a, b, c]
    case "oconstr": {                          // object ctor: (oconstr TYPE (kv f v)…) -> {f: v}
      const fields = e.kids.slice(1).filter(k => isList(k) && k.tag === "kv")
        .map(kv => mangle(kv.kids[0].atom) + ": " + emitExpr(kv.kids[1]));
      return "({" + fields.join(", ") + "})";
    }
    case "dot": return emitExpr(e.kids[0]) + "." + mangle(e.kids[1].atom);   // field access p.f
    case "tupconstr":                          // tuple -> array (named `(kv f v)` or positional)
      return "[" + e.kids.slice(1).map(k =>
        (isList(k) && k.tag === "kv") ? emitExpr(k.kids[1]) : emitExpr(k)).join(", ") + "]";
    case "tupat": return emitExpr(e.kids[0]) + "[" + emitExpr(e.kids[1]) + "]";     // t[i]
    case "arrat": return emitExpr(e.kids[0]) + "[" + emitExpr(e.kids[1]) + "]";     // array a[i]
    case "suf": return emitExpr(e.kids[0]);    // typed literal suffix: (suf 5 "i64") -> 5
    case "prefix": {                           // (prefix OP X) — @seq / $tostring
      const op = isAtom(e.kids[0]) ? opName(e.kids[0].atom) : "";
      const x = e.kids[e.kids.length-1];
      if(op === "@") return emitExpr(x);       // @[…] : array literal -> JS array
      if(op === "$") return "String(" + emitExpr(x) + ")";
      throw Unsupported("prefix '" + op + "'");
    }
    case "infix": {                           // generic infix as a call: (infix OP a b)
      const op = isAtom(e.kids[0]) ? opName(e.kids[0].atom) : "";
      if(op === "&") return "(" + emitExpr(e.kids[1]) + " + " + emitExpr(e.kids[2]) + ")";
      throw Unsupported("infix '" + op + "'");
    }
    case "paren": case "expr": return "(" + emitExpr(e.kids[e.kids.length-1]) + ")";
    case "conv": case "hconv": case "cast": case "dconv": {   // numeric conv: identity in JS…
      const v = e.kids[e.kids.length-1], ty = e.kids[0];
      // …except ord('A') lowers to (conv (i N) 'A') — a char→int widening.
      if(isChr(v) && isList(ty) && (ty.tag === "i" || ty.tag === "u")) return String(v.chr);
      return emitExpr(v);
    }
    case "haddr": case "addr": case "hderef": case "deref": return emitExpr(e.kids[e.kids.length-1]);  // no pointers in JS
    case "true": return "true";
    case "false": return "false";
    case "nil": return "null";
    default: throw Unsupported("expr '" + t + "'");
  }
}

// zero value for a type node (used for `result`/uninitialised vars)
function zeroOf(typeNode){
  if(isList(typeNode)){
    if(typeNode.tag === "i" || typeNode.tag === "u") return "0";
    if(typeNode.tag === "f") return "0";
    if(typeNode.tag === "bool") return "false";
    if(typeNode.tag === "object") return "{}";
    if(typeNode.tag === "tuple") return "[]";
    if(typeNode.tag === "seq" || typeNode.tag === "array") return "[]";
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
