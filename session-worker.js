// session-worker.js — the worker that holds a LIVE aowli session.
//
// The playground's existing `worker.js` is one-shot by design: it boots a
// bundle, runs a program to completion, collects stdout and is done. That model
// cannot hot-swap, because a swap needs an interpreter that is still standing
// between edits.
//
// This worker holds one. It owns `aowli_session.js` (the `__sess_*` seam — see
// tools/session/webmain_session.nim) and exposes its verbs over postMessage:
//
//   start   boot a session from a .s.nif, with or without running the top level
//   swap    republish new bytes over the LIVE module, keeping every global
//   append  republish and run ONLY the top-level statements that were added
//   call    run one proc by name and marshal its return value back
//   stop    drop the session
//
// WHY A SECOND WORKER rather than teaching `worker.js` these verbs: that file is
// 723 lines of a proven compile pipeline with a warm-nimsem cache whose
// invalidation rules are subtle and hard-won. A live session wants the opposite
// lifetime from a one-shot run — it must survive between requests, and it must
// NOT be terminated when a run is stopped. Sharing one worker would couple those
// two lifetimes together. Compiling still happens over there; only the living
// interpreter is here.
"use strict";

let ready = false;

// --- node-globals + libc shims ----------------------------------------------
// aowli's browser build reaches std/os's fileExists / dirExists /
// getLastModificationTime on a couple of guard paths, and those compile down to
// a libc `stat` a JS environment has no answer for. Every artifact this worker
// loads comes out of aowli's in-memory VFS, never a filesystem, so the truthful
// answer is the one `stat` gives for a file that is not there.
self.stat = self.lstat = self.fstat = () => -1;
if (!self.global) self.global = self;
// The seam marshals a nil ARGUMENT by interning this global (jsffi has no null
// constructor).
self.__sess_null = null;

function loadText(name) {
  return fetch(name).then(r => {
    if (!r.ok) throw new Error(name + " HTTP " + r.status);
    return r.text();
  });
}

async function boot() {
  const txt = await loadText("aowli_session.js");
  (new Function(txt + "\nmain(0, []);"))();
  if (!self.__sess_ready) throw new Error("the session seam did not register");
  ready = true;
}

// --- the seam, as a promise-free local API -----------------------------------
// Every verb parks its outcome on globals; this collects them into one object so
// the message layer never reads a global twice and never reads a stale one.
function outcome(extra) {
  const r = Object.assign({
    ok: !!self.__sess_ok,
    err: String(self.__sess_err || ""),
    out: String(self.__sess_out || ""),
    gen: self.__sess_gen | 0,
    live: !!self.__sess_live,
    drift: String(self.__sess_drift || ""),
    newGlobals: self.__sess_newglobals | 0,
    bases: String(self.__sess_bases || ""),
    // The interpreter's own stderr for this verb. A HALT is not a raise, so this
    // is the ONLY place the reason for one ever appears.
    stderr: String(self.__sess_stderr || ""),
    // THE BUMP POINTER, in bytes. aowli's browser heap is a 1 GiB linear buffer
    // and a RETIRED interpreter is never freed, so every mod loaded into one
    // worker costs it permanently. The caller watches this to know when to hand
    // the session a fresh worker instead of a fourth mod and an OOM.
    heap: (typeof self.__leng_brk === "function" ? self.__leng_brk() : 0),
  }, extra || {});
  // Consume the deltas so the next verb reports only what IT produced.
  self.__sess_out = "";
  self.__sess_stderr = "";
  return r;
}

function start(msg) {
  self.__sess_src = msg.snif;
  self.__sess_mods = msg.mods || "";
  self.__sess_in = msg.stdin || "";
  if (msg.runInit === false) self.__sess_load(); else self.__sess_boot();
  return outcome();
}

function swap(msg) {
  self.__sess_src = msg.snif;
  self.__sess_swap();
  return outcome();
}

function append(msg) {
  self.__sess_src = msg.snif;
  self.__sess_append(typeof msg.from === "number" ? msg.from : -1);
  return outcome({ ranTo: self.__sess_ranto | 0 });
}

function callProc(name) {
  self.__sess_call(name);
  const ret = self.__sess_ret || { k: "n" };
  return outcome({ ret });
}

function has(name) {
  self.__sess_has(name);
  return !!self.__sess_bool;
}

// The program's module-level variables and their values, read out of the
// interpreter's global frame. A PURE READ — it runs no code and consumes no
// output delta, so asking never changes the answer to anything else. A bundle
// built before `__sess_globals` existed says so rather than answering "none",
// because an empty list would read as a program with no state.
function globals() {
  if (typeof self.__sess_globals !== "function")
    return { ok: false, err: "this interpreter build cannot list variables — rebuild aowli_session.js", globals: null };
  self.__sess_globals();
  try { return { ok: true, globals: JSON.parse(String(self.__sess_globs || "[]")) }; }
  catch (e) { return { ok: false, err: "the variable list did not parse: " + (e && e.message || e), globals: null }; }
}

function stop() {
  if (self.__sess_stop) self.__sess_stop();
  return outcome();
}

// --- message loop ------------------------------------------------------------
self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    if (msg.type === "init") {
      await boot();
      self.postMessage({ type: "ready" });
      return;
    }
    if (!ready) { self.postMessage({ id, ok: false, err: "the session engine is still loading" }); return; }

    switch (msg.type) {
      case "start":   self.postMessage(Object.assign({ id }, start(msg))); return;
      case "swap":    self.postMessage(Object.assign({ id }, swap(msg))); return;
      case "append":  self.postMessage(Object.assign({ id }, append(msg))); return;
      case "call":    self.postMessage(Object.assign({ id }, callProc(msg.name))); return;
      case "has":     self.postMessage({ id, ok: true, bool: has(msg.name) }); return;
      case "stop":    self.postMessage(Object.assign({ id }, stop())); return;
      case "globals": self.postMessage(Object.assign({ id }, globals())); return;

    }
    self.postMessage({ id, ok: false, err: "unknown request: " + msg.type });
  } catch (e) {
    self.postMessage({ id, ok: false, err: String(e && e.message || e) });
  }
};
