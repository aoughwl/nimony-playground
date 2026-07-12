// worker.js — Tier-2/3 execution harness (Web Worker).
// ---------------------------------------------------------------------------
// Moves the (currently main-thread-blocking) `main(0,[])` interpreter loop off
// the UI thread, and adds a type-check-only ("compile") path so the editor can
// surface diagnostics as you type without running anything.
//
// It loads two swappable modules:
//   compiler-stub.js  -> provides compileToSnif(src) (THE SEAM; replace it)
//   nifi.js           -> the nimony interpreter bundle (defines global main())
//
// MESSAGE PROTOCOL
//   main -> worker:
//     { type:"ready?" }                  handshake probe
//     { type:"run",     id, src }        compile then execute
//     { type:"compile", id, src }        type-check only (diagnostics)
//   worker -> main:
//     { type:"ready" }                                     (unsolicited on boot + reply to "ready?")
//     { type:"result",      id, stdout, stderr, exit, diagnostics }   (reply to "run")
//     { type:"diagnostics", id, diagnostics }                          (reply to "compile")
//
// Correlation is by `id`. The worker drops NOTHING: it always answers every
// id-bearing request. The MAIN thread is responsible for dropping stale replies
// (by id / version) — see engine.js and editor.js.
// ---------------------------------------------------------------------------
(function (global) {
  var IN_WORKER = (typeof importScripts === "function");

  if (IN_WORKER) {
    // Some browser bundles poke at `window`; the interpreter runs headless here.
    if (typeof global.window === "undefined") global.window = global;
    importScripts("compiler-stub.js"); // defines global.compileToSnif  (THE SEAM)
    importScripts("nifi.js");          // defines global.main / __nifi_* protocol
  }

  // Execute compiled .s.nif bytecode through the interpreter present in scope.
  //   IN : global.__nifi_src = bytes
  //   RUN: global.main(0, [])
  //   OUT: global.__nifi_out / __nifi_err / __nifi_exit
  function runSnif(bytes) {
    global.__nifi_src = bytes;
    global.__nifi_out = ""; global.__nifi_err = ""; global.__nifi_exit = 0;
    global.main(0, []);
    return {
      stdout: global.__nifi_out || "",
      stderr: global.__nifi_err || "",
      exit: global.__nifi_exit | 0
    };
  }

  // Core request handler. Pure w.r.t. `postMessage`: returns the reply object
  // (or null) so it can be driven directly by a Node test harness.
  async function handle(msg) {
    if (!msg || typeof msg !== "object") return null;

    if (msg.type === "ready?") return { type: "ready" };

    if (msg.type === "compile") {
      var c = await global.compileToSnif(msg.src);
      return { type: "diagnostics", id: msg.id, diagnostics: (c && c.diagnostics) || [] };
    }

    if (msg.type === "run") {
      var r = await global.compileToSnif(msg.src);
      var diags = (r && r.diagnostics) || [];
      if (!r || r.snif == null) {
        return {
          type: "result", id: msg.id,
          stdout: "", stderr: compileFailedMessage(diags),
          exit: 1, diagnostics: diags
        };
      }
      try {
        var out = runSnif(r.snif);
        return {
          type: "result", id: msg.id,
          stdout: out.stdout, stderr: out.stderr, exit: out.exit,
          diagnostics: diags
        };
      } catch (e) {
        return {
          type: "result", id: msg.id,
          stdout: "", stderr: String((e && e.message) || e), exit: 1,
          diagnostics: diags
        };
      }
    }

    return null;
  }

  function compileFailedMessage(diags) {
    var errs = (diags || []).filter(function (d) { return d.severity === "error"; });
    if (errs.length) {
      return errs.map(function (d) {
        return "compile error [" + (d.line || 1) + ":" + (d.col || 1) + "] " + (d.message || "");
      }).join("\n");
    }
    return "did not compile (no bytecode produced)";
  }

  if (IN_WORKER) {
    global.onmessage = async function (e) {
      var reply = await handle(e.data);
      if (reply) global.postMessage(reply);
    };
    // Announce readiness proactively (main may also send {type:"ready?"}).
    global.postMessage({ type: "ready" });
  }

  // Node/test-harness export (harmless inside a real worker).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { handle: handle, runSnif: runSnif };
  }
})(typeof self !== "undefined" ? self : globalThis);
