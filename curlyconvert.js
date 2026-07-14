// curlyconvert.js — source-to-source converter between nimony INDENT/colon style
// and the experimental CURLY-BRACE block style accepted by nifparser's `--curly`
// mode. Exposes `window.NifiCurly = { toCurly(src), toColon(src) }`.
//
// WHAT CAN BECOME `{ … }` (verified against nifparser/src/parse_stmt.nim):
// nifparser only recognises a `{` block body via `findColon`, which fires when
// the `{` follows an OPERAND end (ident/lit/`)`/`]`/`}`) or one of the bodiless
// keywords `else`/`try`/`block`/`finally`/`defer`. That makes these STATEMENT /
// CONTROL-FLOW block bodies curly-convertible:
//     if · elif · else · while · for · of · try · except(TYPED) · finally ·
//     block · when · defer
// Deliberately NOT converted (they either break the parser or have no braceable
// body of their own):
//   * `case`  — the `case` node itself has no emitBody; only its `of`/`else`
//               branches take braces, so the `case <sel>` header stays bare and
//               each branch is braced individually.
//   * bare `except:` (no exception type) — `except {` is not recognised by
//               findColon (except is not a bodiless keyword and has no operand
//               before `{`), so a bare except keeps its `:`/indent body.
//   * `static:` — `static` is not a bodiless keyword, so `static {` yields an
//               empty body; kept as `:`/indent.
//   * types: type object enum tuple concept — bodies stay `:`/indent.
//   * import export include from var let const, and `{.pragmas.}` — no braces.
//
// ROUTINES (proc func method iterator converter template macro) — nifparser's
// `--curly` mode also accepts a `{ … }` block body in place of the `= …` body
// (see parse_type.nim parseRoutine), so toCurly braces multi-line routine
// bodies too: `proc f(): int =` → `proc f(): int {`. A one-liner
// (`proc f() = x`) stays `=`, and a set-literal expression body
// (`proc f(): set = {}`) is NEVER braced (the `=` guards it). Type bodies are
// left in indent form, but control-flow nested INSIDE any body is still
// converted.
//
// One-liners (`if c: a`) are left in colon form (they already parse in curly
// mode, and leaving them untouched guarantees identical NIF). Only multi-line
// indented block bodies are braced by toCurly.
//
// toColon inverts the canonical (fully line-separated) curly form produced by
// toCurly, and is a no-op on pure indent code. Inline one-liner curly blocks
// (`if c { a }` all on one line) are left as-is.
(function (global) {
  "use strict";

  // Keywords whose block body may be wrapped in `{ … }`.
  var CONVERTIBLE = {
    "if": 1, "elif": 1, "else": 1, "while": 1, "for": 1, "of": 1,
    "try": 1, "except": 1, "finally": 1, "block": 1, "when": 1, "defer": 1
  };

  // Routine keywords whose `= …` body nifparser's `--curly` mode also accepts as
  // `{ … }` (see parse_type.nim parseRoutine). The body `{` is a bare `{` (not a
  // `{.` pragma) with NO preceding `=`, so a set-literal expression body
  // (`proc f(): set = {}`) stays `=`-form and is never braced here.
  var ROUTINE = {
    "proc": 1, "func": 1, "method": 1, "iterator": 1,
    "converter": 1, "template": 1, "macro": 1
  };

  var OPCHARS = "=<>!+-*/%@$~&|^?.:";
  function isOpChar(c) { return c !== undefined && OPCHARS.indexOf(c) >= 0; }

  // Net ()[]{} nesting over a masked string (all bracket families).
  function allDelta(mask, upto) {
    var end = (upto === undefined) ? mask.length : upto;
    var d = 0;
    for (var k = 0; k < end; k++) {
      var c = mask[k];
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") { if (d > 0) d--; }
    }
    return d;
  }

  // If `tm` (trimmed masked line) ends with a STANDALONE depth-0 `=` — the body
  // introducer of a routine block (`proc f(): int =`) — return that `=`'s index,
  // else -1. Guards against compound operators (`==`, `+=`) and against `=`
  // nested in params/generics.
  function endsWithBodyEq(tm) {
    var pos = tm.length - 1;
    if (pos < 0 || tm.charAt(pos) !== "=") return -1;
    if (isOpChar(tm.charAt(pos - 1))) return -1;   // part of a 2-char operator
    if (allDelta(tm, pos) !== 0) return -1;         // inside ( ) / [ ] / { }
    return pos;
  }

  // Does `tm` contain a standalone depth-0 `=` with non-blank content after it
  // (a routine ONE-LINER body, `proc f() = echo 1`)? Returns its index or -1.
  function oneLinerBodyEq(tm) {
    var d = 0;
    for (var k = 0; k < tm.length; k++) {
      var c = tm[k];
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") { if (d > 0) d--; }
      else if (c === "=" && d === 0 &&
               !isOpChar(tm.charAt(k - 1)) && !isOpChar(tm.charAt(k + 1))) {
        if (tm.slice(k + 1).replace(/\s+/g, "") !== "") return k;
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Masking: produce a parallel string of identical length where every byte
  // inside a string/char literal, comment, or `{. .}` pragma is replaced by a
  // space, so structural scanning never sees `{`/`}`/`:`/`;`/keywords that live
  // inside those spans. Newlines are preserved so line splitting stays aligned.
  // ---------------------------------------------------------------------------
  function maskSource(src) {
    var n = src.length;
    var out = new Array(n);
    var i = 0;
    function isIdent(c) { return /[A-Za-z0-9_]/.test(c); }
    function put(a, b, ch) { for (var k = a; k < b; k++) out[k] = (src[k] === "\n") ? "\n" : ch; }
    while (i < n) {
      var c = src[i];
      if (c === "\n") { out[i] = "\n"; i++; continue; }
      // line comment / block comment
      if (c === "#") {
        if (src[i + 1] === "[") {
          // nested block comment #[ ... ]#
          var depth = 1, j = i + 2;
          while (j < n && depth > 0) {
            if (src[j] === "#" && src[j + 1] === "[") { depth++; j += 2; continue; }
            if (src[j] === "]" && src[j + 1] === "#") { depth--; j += 2; continue; }
            j++;
          }
          put(i, j, " "); i = j; continue;
        } else {
          var e = i; while (e < n && src[e] !== "\n") e++;
          put(i, e, " "); i = e; continue;
        }
      }
      // strings
      if (c === '"') {
        // triple?
        if (src[i + 1] === '"' && src[i + 2] === '"') {
          var t = i + 3;
          while (t < n && !(src[t] === '"' && src[t + 1] === '"' && src[t + 2] === '"')) t++;
          t = Math.min(n, t + 3);
          put(i, t, " "); i = t; continue;
        }
        // raw string? preceded by an identifier char that is a string prefix
        var raw = (i > 0 && /[A-Za-z]/.test(src[i - 1]) &&
                   !(i > 1 && isIdent(src[i - 2])));
        var s = i + 1;
        while (s < n && src[s] !== "\n") {
          if (raw) {
            if (src[s] === '"') { if (src[s + 1] === '"') { s += 2; continue; } break; }
          } else {
            if (src[s] === "\\") { s += 2; continue; }
            if (src[s] === '"') break;
          }
          s++;
        }
        s = Math.min(n, s + 1);
        put(i, s, " "); i = s; continue;
      }
      // char literal 'x' / '\n'  (avoid the type-suffix form 123'u8 by requiring
      // the prev non-space char not be a digit/ident)
      if (c === "'") {
        var prev = i > 0 ? src[i - 1] : "";
        if (!isIdent(prev)) {
          var p = i + 1;
          while (p < n && src[p] !== "\n") {
            if (src[p] === "\\") { p += 2; continue; }
            if (src[p] === "'") break;
            p++;
          }
          p = Math.min(n, p + 1);
          put(i, p, " "); i = p; continue;
        }
      }
      // pragma {. ... .}
      if (c === "{" && src[i + 1] === ".") {
        var q = i + 2;
        while (q < n && !(src[q] === "." && src[q + 1] === "}")) {
          if (src[q] === "\n") break; // pragmas rarely span lines; stop safe
          q++;
        }
        if (q < n && src[q] === "." && src[q + 1] === "}") q += 2;
        put(i, q, " "); i = q; continue;
      }
      out[i] = c; i++;
    }
    return out.join("");
  }

  // Split raw + masked into aligned per-line records.
  function toLines(src) {
    var masked = maskSource(src);
    var rawLines = src.split("\n");
    var mLines = masked.split("\n");
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var raw = rawLines[i];
      var m = mLines[i] !== undefined ? mLines[i] : "";
      var indent = raw.length - raw.replace(/^[ \t]+/, "").length;
      var trimmedMask = m.replace(/\s+$/, "");
      var neutral = trimmedMask.replace(/^\s+/, "") === ""; // blank or comment-only
      lines.push({ raw: raw, mask: m, indent: indent, neutral: neutral });
    }
    return lines;
  }

  // Leading identifier/keyword of a (masked) line, or "".
  function leadWord(mask) {
    var mm = mask.replace(/^\s+/, "");
    var w = mm.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    return w ? w[0] : "";
  }

  // Index of the first depth-0 `:` in a masked line, or -1. Depth tracks
  // () [] {} nesting so colons inside sets/tables/params are ignored.
  function depth0Colon(mask) {
    var d = 0;
    for (var k = 0; k < mask.length; k++) {
      var c = mask[k];
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") { if (d > 0) d--; }
      else if (c === ":" && d === 0) return k;
    }
    return -1;
  }

  // Net brace delta of a masked string (control/set braces; pragmas already
  // masked out).
  function braceDelta(mask, upto) {
    var end = (upto === undefined) ? mask.length : upto;
    var d = 0;
    for (var k = 0; k < end; k++) {
      if (mask[k] === "{") d++;
      else if (mask[k] === "}") d--;
    }
    return d;
  }

  // ---------------------------------------------------------------------------
  // toCurly
  // ---------------------------------------------------------------------------
  function toCurly(src) {
    var lines = toLines(src);
    var out = [];
    var stack = []; // { indent } of open inserted braces, in nesting order
    var inRoutineSig = false;   // inside a multi-line routine signature
    var routineIndent = 0;      // indent of the routine keyword line

    function closeTo(indent) {
      while (stack.length && indent <= stack[stack.length - 1].indent) {
        var rec = stack.pop();
        out.push(spaces(rec.indent) + "}");
      }
    }
    function spaces(n) { var s = ""; while (n-- > 0) s += " "; return s; }

    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (L.neutral) { out.push(L.raw); continue; }

      // Close any braces whose body ended at this (lower/equal) indentation.
      closeTo(L.indent);

      var word = leadWord(L.mask);

      // --- routine block body: `proc … =` → `proc … {` (+ a `}` at dedent) ---
      if (ROUTINE[word] || inRoutineSig) {
        if (ROUTINE[word]) routineIndent = L.indent;
        var trimmedR = L.mask.replace(/\s+$/, "");
        var eqPos = endsWithBodyEq(trimmedR);
        if (eqPos >= 0) {
          // block body opens here: swap the trailing `=` for `{`.
          out.push(L.raw.slice(0, eqPos) + "{" + L.raw.slice(eqPos + 1));
          stack.push({ indent: inRoutineSig ? routineIndent : L.indent });
          inRoutineSig = false;
          continue;
        }
        // one-liner (`proc f() = echo 1`) or forward decl: leave verbatim.
        if (ROUTINE[word] && oneLinerBodyEq(trimmedR) >= 0) {
          inRoutineSig = false; out.push(L.raw); continue;
        }
        // otherwise the signature continues iff a bracket is still open.
        inRoutineSig = allDelta(trimmedR) > 0;
        out.push(L.raw);
        continue;
      }

      var convertible = false;
      if (CONVERTIBLE[word]) {
        var colon = depth0Colon(L.mask);
        if (colon >= 0) {
          // multi-line only: nothing but whitespace after the colon (masked)
          var after = L.mask.slice(colon + 1);
          var oneLiner = after.replace(/\s+$/, "").replace(/^\s+/, "") !== "";
          if (!oneLiner) {
            // bare `except:` (no exception type) is NOT braceable
            var bareExcept = false;
            if (word === "except") {
              var between = L.mask.slice(L.mask.indexOf("except") + 6, colon);
              bareExcept = between.replace(/\s+/g, "") === "";
            }
            if (!bareExcept) convertible = true;
          }
        }
      }

      if (convertible) {
        var ci = depth0Colon(L.mask);
        var newLine = L.raw.slice(0, ci) + " {" + L.raw.slice(ci + 1);
        out.push(newLine);
        stack.push({ indent: L.indent });
      } else {
        out.push(L.raw);
      }
    }
    // close whatever remains open
    while (stack.length) {
      var rec = stack.pop();
      out.push(spaces(rec.indent) + "}");
    }
    return out.join("\n");
  }

  // ---------------------------------------------------------------------------
  // toColon — invert the canonical curly form; no-op on indent code.
  // ---------------------------------------------------------------------------
  function toColon(src) {
    var lines = toLines(src);
    var out = [];
    var depth = 0;        // running brace nesting (masked braces)
    var ctrl = [];        // stack of brace-levels opened by control/routine headers
    var inRoutineSig = false;   // inside a multi-line routine signature

    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      var mask = L.mask;
      var trimmedMask = mask.replace(/\s+$/, "");

      // A lone `}` line (only a closing brace, maybe trailing comment/space).
      if (trimmedMask.replace(/^\s+/, "") === "}") {
        var closedLevel = depth - 1;
        depth = closedLevel;
        if (ctrl.length && ctrl[ctrl.length - 1] === closedLevel) {
          ctrl.pop();
          continue; // drop the control/routine-close line entirely
        }
        out.push(L.raw); // a non-control brace on its own line: keep verbatim
        continue;
      }

      var word = leadWord(mask);

      // --- routine block open: `proc … {` → `proc … =` (drop matching `}`) ---
      if (ROUTINE[word] || inRoutineSig) {
        if (trimmedMask.charAt(trimmedMask.length - 1) === "{") {
          var rBracePos = L.raw.lastIndexOf("{");
          var rLevel = depth + braceDelta(mask, rBracePos);
          var rHead = L.raw.slice(0, rBracePos).replace(/\s+$/, "");
          out.push(rHead + " =" + L.raw.slice(rBracePos + 1));
          ctrl.push(rLevel);
          depth += braceDelta(mask);
          inRoutineSig = false;
          continue;
        }
        // one-liner / forward decl / signature continuation: keep verbatim.
        inRoutineSig = allDelta(trimmedMask) > 0;
        out.push(L.raw);
        depth += braceDelta(mask);
        continue;
      }

      // control-open line: a convertible keyword whose body-opening `{` is the
      // last significant char on the line.
      if (CONVERTIBLE[word] && trimmedMask.charAt(trimmedMask.length - 1) === "{") {
        var bracePos = L.raw.lastIndexOf("{", L.raw.length);
        // level this control brace opens at = depth + braces before it
        var before = braceDelta(mask, bracePos);
        var level = depth + before;
        var head = L.raw.slice(0, bracePos).replace(/\s+$/, "");
        out.push(head + ":" + L.raw.slice(bracePos + 1));
        ctrl.push(level);
        depth += braceDelta(mask); // whole-line net (should be +1)
        continue;
      }

      // ordinary line: keep verbatim, just track brace depth.
      out.push(L.raw);
      depth += braceDelta(mask);
    }
    return out.join("\n");
  }

  var api = { toCurly: toCurly, toColon: toColon };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.NifiCurly = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
