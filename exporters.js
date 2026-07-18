// exporters.js — the client-side EXPORT seam: idiomatic TypeScript (aowlts) and
// Python (aowlpy) from the current program's typed `.s.nif`.
//
// aowlts and aowlpy are nimony programs (thin emitters over the shared aowlhl
// HL-IR layer). They're compiled to browser JavaScript by the SAME nimony-web
// nim_js backend that produces nifparser.js / nimsem.js / nifi.js — see
// build-exporters.sh and exporters/{aowlts,aowlpy}_web.nim. Each bundle takes the
// sem'd `.s.nif` the playground already has (from nimsem in the worker) on a
// global and returns the emitted source text on another:
//
//   aowlts.js:  IN  globalThis.__ats_src       = the `.s.nif` bytes (string)
//               IN  globalThis.__ats_faithful  = "1" faithful (BigInt int64), "" fast
//               OUT globalThis.__ats_out        = the TypeScript text
//   aowlpy.js:  IN  globalThis.__apy_src        = the `.s.nif` bytes (string)
//               OUT globalThis.__apy_out        = the Python text
//   aowljs-export.js: IN  globalThis.__ajs_src  = the `.s.nif` bytes (string)
//               IN  globalThis.__ajs_faithful  = "1" faithful (BigInt int64), "" fast
//               OUT globalThis.__ajs_out        = the JavaScript text
//   aowlc.js:   IN  globalThis.__c_src          = the `.s.nif` bytes (string)
//               OUT globalThis.__c_out          = the C text ("" on failure)
//               OUT globalThis.__c_err          = "" or an error message
//               (6 MB, self-contained — lazy-loaded on the first C export)
//
// Like parser.js, each bundle is compiled to a callable ONCE (new Function) and
// the RESULT is re-invoked per export — nimony's generated `main` guards module
// init, so a fresh invocation re-runs the emit with fresh linear memory. The
// bundles are ~1.5 MB each and only needed on demand, so they load lazily on the
// first export rather than at startup.
//
// One normalization: the nim_js backend mis-encodes a non-ASCII char in a
// COMPILE-TIME string literal (the em-dash `—` in each emitter's banner comment)
// to the low byte 0x14. Runtime string data from the user's program round-trips
// as correct UTF-8 (verified); only the fixed banner is affected. We map the lone
// 0x14 back to `—` so the output is byte-identical to the native CLI. 0x14 (DC4)
// never legitimately appears in TS/Python source, so this is safe.
(function(){
  "use strict";

  function makeLoader(bundleName){
    let compiled = null, loadPromise = null;
    function load(){
      if(loadPromise) return loadPromise;
      const inline = (typeof window !== "undefined" && window.__NIFI_INLINE);
      if(inline && inline.bundles && inline.bundles[bundleName]){
        compiled = new Function(inline.bundles[bundleName] + "\nmain(0, []);");
        loadPromise = Promise.resolve(true);
        return loadPromise;
      }
      loadPromise = fetch(bundleName).then(r=>{
        if(!r.ok) throw new Error("failed to load "+bundleName+": HTTP "+r.status);
        return r.text();
      }).then(t=>{ compiled = new Function(t + "\nmain(0, []);"); return true; });
      return loadPromise;
    }
    return { load, run(){ compiled(); } };
  }

  const tsBundle = makeLoader("aowlts.js");
  const pyBundle = makeLoader("aowlpy.js");
  const jsBundle = makeLoader("aowljs-export.js");
  const cBundle  = makeLoader("aowlc.js");

  // Repair the nim_js banner mis-encoding: the em-dash — (U+2014) in each
  // emitter's compile-time banner literal is emitted as the low byte 0x14, and
  // the 3-byte source char leaves 2 stray NUL bytes after the line. Drop the NULs
  // and map 0x14 back to —, making the output byte-identical to the native CLI.
  // Neither 0x00 nor 0x14 ever legitimately appears in TS/Python source (runtime
  // string data from the user's program round-trips as correct UTF-8), so this is
  // safe.
  function fixBanner(s){ return String(s).replace(/\u0000/g, "").replace(/\u0014/g, "—"); }

  const exporters = {
    // Emit idiomatic TypeScript. `faithful` picks the BigInt-int64 runtime
    // (aowlts --faithful); default (false) is the fast Number path. Returns a
    // Promise<string>.
    async toTypeScript(snif, faithful){
      if(!snif) throw new Error("no typed .s.nif to export (compile the program first)");
      await tsBundle.load();
      globalThis.__ats_src = String(snif);
      globalThis.__ats_faithful = faithful ? "1" : "";
      globalThis.__ats_out = "";
      tsBundle.run();
      return fixBanner(globalThis.__ats_out || "");
    },
    // Emit idiomatic Python 3. Returns a Promise<string>.
    async toPython(snif){
      if(!snif) throw new Error("no typed .s.nif to export (compile the program first)");
      await pyBundle.load();
      globalThis.__apy_src = String(snif);
      globalThis.__apy_out = "";
      pyBundle.run();
      return fixBanner(globalThis.__apy_out || "");
    },
    // Emit idiomatic JavaScript via aowljs (the aowljs-export.js bundle). `faithful`
    // picks the BigInt-int64 tier (aowljs --faithful); default is the fast Number
    // path. Same banner-repair as TS/Python. Returns a Promise<string>.
    async toJavaScript(snif, faithful){
      if(!snif) throw new Error("no typed .s.nif to export (compile the program first)");
      await jsBundle.load();
      globalThis.__ajs_src = String(snif);
      globalThis.__ajs_faithful = faithful ? "1" : "";
      globalThis.__ajs_out = "";
      jsBundle.run();
      return fixBanner(globalThis.__ajs_out || "");
    },
    // Emit C via aowlc (aowlc.js — the .s.nif → aowlhexer → .c.nif → C printer
    // path). The bundle is ~6 MB and self-contained (embeds the stdlib closure), so
    // it loads lazily on the first C export. Reports its own failure via __c_err.
    async toC(snif){
      if(!snif) throw new Error("no typed .s.nif to export (compile the program first)");
      await cBundle.load();
      globalThis.__c_src = String(snif);
      globalThis.__c_out = "";
      globalThis.__c_err = "";
      cBundle.run();
      const out = fixBanner(globalThis.__c_out || "");
      const err = String(globalThis.__c_err || "").trim();
      if(!out && err) throw new Error(err);
      return out;
    },
    // Warm the light bundles ahead of a click (optional; loaders are idempotent).
    // aowlc.js (6 MB) is intentionally NOT preloaded — it loads on first C export.
    preload(){ tsBundle.load().catch(()=>{}); pyBundle.load().catch(()=>{}); jsBundle.load().catch(()=>{}); }
  };

  window.NifiExport = exporters;
})();
