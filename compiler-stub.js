// compiler-stub.js — THE TIER-2 COMPILER SEAM.  <<< REPLACE THIS WHOLE FILE >>>
// ---------------------------------------------------------------------------
// This is a STUB standing in for the real Tier-2 compiler. When the nimony
// frontend is ported to JS, the production module that runs
//     nifler (parse)  ->  nimsem (typecheck/sem)  ->  .s.nif (bytecode)
// drops in RIGHT HERE, replacing this file verbatim. Everything else in the
// playground (worker.js protocol, engine.js worker glue, editor.js debounce)
// is written against the CONTRACT below and does not change.
//
// CONTRACT (the one function the rest of the stack depends on):
//   compileToSnif(src: string) => Promise<{
//     snif: string | null,          // .s.nif bytecode as a latin1 byte-string, or null if it did not compile
//     diagnostics: Marker[]         // [] when clean
//   }>
//   Marker = { line, col, endLine?, endCol?, message, severity }
//            1-based line/col; severity in "error" | "warning" | "info" | "hint"
//
// STUB BEHAVIOUR (deliberately fake, source-insensitive except for two hooks):
//   1. If the source contains the word "FIXME", emit a fake ERROR on line 1
//      (so the diagnostics channel can be exercised end-to-end).
//   2. For a small set of KNOWN example sources, return their PRE-COMPILED
//      .s.nif bytes (fetched from assets/snif/) so Run still does something
//      real under Tier 2 without a real compiler.
//   3. Anything else: no bytecode (snif=null) + an informational diagnostic.
// ---------------------------------------------------------------------------
(function (global) {
  // Exact (trimmed) source text of each shipped example -> its precompiled asset.
  // The real compiler will not need this table; it compiles arbitrary source.
  var KNOWN = {
    'import std/syncio\n\necho "hello from nimony - running in your browser"':
      "hello.s.nif",
    'import std/syncio\n\nproc fib(n: int): int =\n  if n < 2: return n\n  return fib(n-1) + fib(n-2)\n\nfor i in 0..10:\n  echo i, " -> ", fib(i)':
      "fib.s.nif",
    'import std/syncio\n\nfor i in 1..20:\n  if i mod 15 == 0: echo "FizzBuzz"\n  elif i mod 3 == 0: echo "Fizz"\n  elif i mod 5 == 0: echo "Buzz"\n  else: echo i':
      "fizzbuzz.s.nif",
    'import std/syncio\n\nproc steps(n0: int): int =\n  var n = n0\n  result = 0\n  while n != 1:\n    if n mod 2 == 0: n = n div 2\n    else: n = 3*n + 1\n    inc result\n\nfor n in 1..12:\n  echo n, ": ", steps(n), " steps"':
      "collatz.s.nif",
    'import std/syncio\n\nvar xs = @[3, 1, 4, 1, 5, 9, 2, 6]\nvar total = 0\nfor x in xs:\n  total = total + x\necho "sum of ", xs.len, " numbers = ", total':
      "listsum.s.nif",
  };

  // Byte-exact fetch: .s.nif is a NIF byte stream; decode 1:1 (latin1), never UTF-8.
  async function fetchSnifBytes(name) {
    var r = await fetch("assets/snif/" + name);
    if (!r.ok) throw new Error("missing bytecode asset: " + name + " (HTTP " + r.status + ")");
    var buf = new Uint8Array(await r.arrayBuffer());
    var s = "";
    for (var i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  async function compileToSnif(src) {
    var diagnostics = [];
    src = src == null ? "" : String(src);

    // Hook 1: fake diagnostic so the marker channel is testable.
    var fixmeAt = src.indexOf("FIXME");
    if (fixmeAt !== -1) {
      // Compute a 1-based line/col for the first occurrence.
      var pre = src.slice(0, fixmeAt);
      var line = (pre.match(/\n/g) || []).length + 1;
      var col = fixmeAt - pre.lastIndexOf("\n"); // lastIndexOf==-1 -> col = fixmeAt+1
      diagnostics.push({
        line: line, col: col, endLine: line, endCol: col + 5,
        message: "stub: 'FIXME' marker found (fake diagnostic from compiler-stub.js)",
        severity: "error"
      });
    }

    var hasError = diagnostics.some(function (d) { return d.severity === "error"; });
    if (hasError) return { snif: null, diagnostics: diagnostics };

    // Hook 2: known example -> its precompiled bytecode, so Run works.
    var key = src.replace(/\s+$/, "").replace(/\r\n/g, "\n").trim();
    var snifName = KNOWN[key];
    if (snifName) {
      try {
        return { snif: await fetchSnifBytes(snifName), diagnostics: diagnostics };
      } catch (e) {
        return {
          snif: null,
          diagnostics: diagnostics.concat([{
            line: 1, col: 1, message: String((e && e.message) || e), severity: "error"
          }])
        };
      }
    }

    // Hook 3: everything else — the real compiler would compile it here.
    return {
      snif: null,
      diagnostics: diagnostics.concat([{
        line: 1, col: 1,
        message: "stub compiler: no precompiled bytecode for this source " +
                 "(the real Tier-2 nifler+nimsem compiler plugs in here)",
        severity: "info"
      }])
    };
  }

  global.compileToSnif = compileToSnif;
  // Node/test harness hook (harmless in a browser/worker).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { compileToSnif: compileToSnif, KNOWN: KNOWN };
  }
})(typeof self !== "undefined" ? self : globalThis);
