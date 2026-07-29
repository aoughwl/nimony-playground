// format.js — aowlfmt, in the browser.
//
// A faithful port of aowlfmt's layout rules (aoughwl/aowlfmt, src/rules.nim):
// whitespace-only, line-oriented transforms that never touch the interior of a
// token, string or comment. And — critically — it reuses aowlfmt's correctness
// contract: a reformat is applied ONLY if the parser confirms it changed nothing
// but layout. That is the AIF-equivalence gate (src/aifgate.nim):
//
//     normalize(AIF(original)) == normalize(AIF(formatted))  =>  safe to apply
//
// We get the AIF from the SAME in-browser parser the rest of the playground uses
// (window.AowliParser → the aowlparser bundle). If either parse is unavailable or
// the normalized AIFs differ, the reformat is REFUSED and the buffer is left
// byte-for-byte unchanged — exactly like the native tool.
(function(){
  "use strict";
  const F = {};

  // ---- the layout rules (mirror rules.nim, defaults from defaultOpts) --------
  function defaultOpts(){
    return { maxBlankLines:1, finalNewline:true, trimTrailing:true, tabWidth:0,
             trimLeadingBlanks:true };
  }

  function endsWithNewline(src){ return src.length > 0 && src[src.length-1] === "\n"; }

  // Split into logical lines WITHOUT their '\n'; CRLF is normalised to LF by
  // dropping the CR (matches splitKeep in rules.nim).
  function splitKeep(src){
    const out = [];
    let cur = "";
    for(let i=0;i<src.length;i++){
      const c = src[i];
      if(c === "\n"){ out.push(cur); cur = ""; }
      else if(c === "\r"){ /* drop */ }
      else cur += c;
    }
    if(cur.length > 0) out.push(cur);
    return out;
  }

  function rstripLine(ln){
    let e = ln.length;
    while(e > 0 && (ln[e-1] === " " || ln[e-1] === "\t")) e--;
    return ln.slice(0, e);
  }

  // Re-indent to `width` spaces per nesting level. nimony/nim code is
  // space-indented, so the old "expand literal tabs" rule was a no-op on it —
  // this instead RESCALES indentation: each distinct deeper leading-indent is a
  // level (Python-tokenizer style), re-emitted as width*level spaces. A tab in
  // the leading run counts as one column. Blank / whitespace-only lines are left
  // empty. This can change indentation columns, but not nesting — and the caller
  // runs the AIF-equivalence gate afterwards, so any reindent that would alter
  // the program is refused and the buffer is left byte-for-byte unchanged.
  function reindentToWidth(lines, width){
    const out = new Array(lines.length);
    const stack = [0];                 // leading-indent columns for levels 0..n
    for(let i = 0; i < lines.length; i++){
      const ln = lines[i];
      let j = 0;
      while(j < ln.length && (ln[j] === " " || ln[j] === "\t")) j++;
      if(j === ln.length){ out[i] = ""; continue; }   // blank / ws-only
      const col = j, body = ln.slice(j);
      if(col > stack[stack.length - 1]){
        stack.push(col);
      } else {
        while(stack.length > 1 && col < stack[stack.length - 1]) stack.pop();
        if(col > stack[stack.length - 1]) stack.push(col);  // unaligned dedent
      }
      const level = stack.length - 1;
      out[i] = " ".repeat(width * level) + body;
    }
    return out;
  }

  function applyRules(src, opts){
    let lines = splitKeep(src);
    // trailing-whitespace trim first (per line), so indentation measurement below
    // isn't fooled by trailing spaces on otherwise-blank lines.
    for(let i=0;i<lines.length;i++){
      if(opts.trimTrailing) lines[i] = rstripLine(lines[i]);
    }
    // rescale indentation to width spaces per level (gate-protected, see above)
    if(opts.tabWidth > 0) lines = reindentToWidth(lines, opts.tabWidth);
    // collapse runs of blank lines (+ drop leading blanks)
    const kept = [];
    let blankRun = 0, seenContent = false;
    for(let i=0;i<lines.length;i++){
      const isBlank = lines[i].length === 0;
      if(isBlank){
        if(!seenContent && opts.trimLeadingBlanks) continue;
        blankRun++;
        if(opts.maxBlankLines >= 0 && blankRun > opts.maxBlankLines) continue;
        kept.push(lines[i]);
      } else {
        seenContent = true; blankRun = 0; kept.push(lines[i]);
      }
    }
    // drop trailing blank lines (final-newline rule re-adds exactly one)
    while(kept.length > 0 && kept[kept.length-1].length === 0) kept.pop();
    let res = kept.join("\n");
    if(opts.finalNewline){ if(res.length > 0) res += "\n"; }
    else if(endsWithNewline(src) && res.length > 0) res += "\n";
    return res;
  }

  // ---- the gate (mirror aifgate.nim normalizeAif) ----------------------------
  function isInfoChar(c){
    return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") ||
           (c >= "A" && c <= "F") || c === "," || c === "+" || c === "-";
  }
  // Strip position-info suffixes (`@…`/`~…`) outside string literals and collapse
  // all whitespace to single spaces — deterministic; over-stripping is harmless
  // because we only ever compare two AIFs produced the same way.
  function normalizeAif(aif){
    let s = "";
    let i = 0, inStr = false;
    while(i < aif.length){
      const c = aif[i];
      if(inStr){
        s += c;
        if(c === "\\" && i+1 < aif.length){ s += aif[i+1]; i += 2; continue; }
        if(c === '"') inStr = false;
        i++; continue;
      }
      if(c === '"'){ inStr = true; s += c; i++; continue; }
      if(c === "@" || c === "~"){
        i++;
        while(i < aif.length && isInfoChar(aif[i])) i++;
        continue;
      }
      s += c; i++;
    }
    // collapse whitespace
    let res = "";
    let pending = false;
    for(let j=0;j<s.length;j++){
      const c = s[j];
      if(c === " " || c === "\t" || c === "\n" || c === "\r") pending = true;
      else { if(pending && res.length > 0) res += " "; pending = false; res += c; }
    }
    return res;
  }

  // ---- the public surface ----------------------------------------------------
  // Returns { changed, text, safe, reason }. `safe:false` means the gate refused
  // (or the parser wasn't available) — the caller must keep the original text.
  F.format = function(src, opts){
    opts = Object.assign(defaultOpts(), opts || {});
    const out = applyRules(String(src), opts);
    if(out === src) return { changed:false, text:src, safe:true, reason:"already formatted" };
    const P = window.AowliParser;
    if(!P || !P.ready || typeof P.parse !== "function")
      return { changed:false, text:src, safe:false, reason:"parser not ready — cannot prove it's safe" };
    let a, b;
    try{
      // Same file field on both sides so the source-path token in the AIF cancels.
      a = P.parse(src, "fmt.nim");
      b = P.parse(out, "fmt.nim");
    }catch(e){
      return { changed:false, text:src, safe:false, reason:"parse failed" };
    }
    if(!a || !b || normalizeAif(a) !== normalizeAif(b))
      return { changed:false, text:src, safe:false, reason:"reformat would change the program — refused" };
    return { changed:true, text:out, safe:true, reason:"formatted" };
  };

  F.defaultOpts = defaultOpts;
  window.AowlFmt = F;
})();
