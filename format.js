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

  // Expand ONLY the leading run of tabs to `width` spaces each.
  function leadingTabsToSpaces(ln, width){
    let i = 0, pad = 0;
    while(i < ln.length && ln[i] === "\t"){ pad += width; i++; }
    if(i === 0) return ln;
    return " ".repeat(pad) + ln.slice(i);
  }

  function applyRules(src, opts){
    let lines = splitKeep(src);
    // per-line transforms
    for(let i=0;i<lines.length;i++){
      let ln = lines[i];
      if(opts.tabWidth > 0) ln = leadingTabsToSpaces(ln, opts.tabWidth);
      if(opts.trimTrailing) ln = rstripLine(ln);
      lines[i] = ln;
    }
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
