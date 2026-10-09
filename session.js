// session.js — main-thread client for the LIVE aowli session.
//
// The playground's Run has always been a verb that COMPLETES: spin up a worker,
// run the program top to bottom, print, exit. There is nothing left alive to
// edit into. This module adds the other shape — a session that stays standing
// between edits, so a change to the source can be republished over the running
// program WITHOUT losing what it had computed.
//
// THE MODEL, in three states the footer names out loud:
//
//   stopped   nothing alive. An edit is just an edit.
//   live      an interpreter holds your program's state; edits flow into it.
//   ended     the top level returned, but the interpreter is still standing and
//             still holds its globals. This is the state a REPL lives in, and
//             it is why `append` exists.
//
// THREE VERBS, and they are aowli's own rather than an invention of this page:
//
//   swap(snif)      republish the module, keep every global, initialize only the
//                   globals the new version INTRODUCED. "I edited a proc."
//   append(snif)    republish and run ONLY the top-level statements that were
//                   added. "I typed a new line at the bottom." Earlier side
//                   effects do not repeat.
//   start(runInit)  run the whole top level. This is what Run already meant, so
//                   nothing about Run changes.
//
// WHAT THE PAGE MUST SAY OUT LOUD, because each is a real failure a user hits:
//
//   * A SWAP LANDS AT A SAFE POINT. `swapHot` refuses — changing nothing — while
//     an interpreted frame is on the stack, because the previous generation's
//     buffers are freed there. So a swap offered while the program is inside a
//     call is QUEUED, not lost, and the footer says `pending` until it lands. A
//     swap that silently never lands is what a `while true:` would otherwise
//     look like.
//   * A SWAP IS AN INTERPRETER FEATURE. The Native-JS engine transpiles to real
//     JS and has no module to republish, so Live implies a faithful engine. The
//     footer names the engine that is actually running, which is the rule the
//     run footer already follows.
//   * DRIFT IS NOT A WARNING TO SWALLOW. When a swap moves a symbol's signature
//     under a live caller, aowli says which symbol, and arms the call side so a
//     call binding a wrong-typed value raises instead of answering plausibly and
//     wrongly. The editor draws that on the declaration. This is the difference
//     between a hot reload that mysteriously breaks and one that tells you why.
"use strict";
(function () {
  const S = {
    ready: false,
    state: "stopped",        // stopped | live | ended
    gen: 0,
    // LIVE IS ARMED BY DEFAULT.
    //
    // It was opt-in, behind a button, and that made the headline feature of the
    // whole project something you had to already know about to see: you would
    // start a program, edit it, watch nothing happen, and conclude it was
    // broken rather than that a toggle was off. Nothing here is destructive —
    // `offer` does nothing unless a session is standing AND the bytes actually
    // moved AND the program type-checked clean — so the default that teaches
    // what this is costs nothing when it is not wanted, and the button is still
    // there to turn it off.
    live: true,              // is Live mode armed
    pending: false,          // a swap is waiting for a safe point
    lastSnif: "",            // the bytes a queued swap will republish
    ranTo: -1,               // append bookkeeping: statements already run
    drift: [],
    heap: 0,                 // the interpreter's bump pointer, in bytes
  };


  let worker = null, seq = 0, pending = new Map(), bootWait = null;
  const listeners = { out: [], state: [], log: [], verb: [] };
  // A NAME THAT IS NOT IN THE MAP IS A BUG IN THIS FILE, NOT A SILENT NO-OP —
  // but it must not take the caller down either: an unknown name says so,
  // loudly, and keeps going.
  const emit = (k, v) => {
    const fs = listeners[k];
    if (!fs) { console.error("AowliSession: nobody can listen for '" + k + "' — it is not in `listeners`"); return; }
    fs.forEach((f) => { try { f(v); } catch (e) { console.error("AowliSession " + k + " listener threw:", e); } });
  };

  function spawn() {
    S.ready = false;
    worker = new Worker("session-worker.js?v=2");
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "ready") { S.ready = true; if (bootWait) bootWait(); emit("state", S); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      p(m);
    };
    worker.onerror = (e) => {
      const msg = "session worker crashed: " + (e && e.message || e);
      for (const [, p] of pending) p({ ok: false, err: msg });
      pending.clear();
      S.state = "stopped"; S.ready = false;
      emit("log", { text: msg, bad: true });
      emit("state", S);
    };
    worker.postMessage({ type: "init" });
  }

  function send(type, extra, transfer) {
    return new Promise((resolve) => {
      if (!worker) { resolve({ ok: false, err: "no session worker" }); return; }
      const id = ++seq;
      pending.set(id, resolve);
      worker.postMessage(Object.assign({ id, type }, extra), transfer || []);
    });
  }

  // Fold a verb's outcome into the visible state, and report everything it said.
  function absorb(r) {
    if (!r) return r;
    if (r.out) emit("out", { text: r.out });
    if (typeof r.gen === "number") S.gen = r.gen;
    if (typeof r.heap === "number" && r.heap > 0) S.heap = r.heap;
    if (typeof r.live === "boolean") S.state = r.live ? (S.state === "ended" ? "ended" : "live") : "stopped";
    S.drift = r.drift ? String(r.drift).split("\n").filter(Boolean) : [];
    if (S.drift.length) reportDrift(S.drift);
    // The interpreter's stderr is where a HALT says why. It is reported whether
    // or not the verb "succeeded", because a program can abort mid-call and
    // still leave the call returning normally.
    if (r.stderr) emit("log", { text: String(r.stderr).trim(), bad: true });
    if (!r.ok && r.err) emit("log", { text: r.err, bad: true });
    emit("state", S);
    return r;
  }

  // ---- drift, drawn where it happened ---------------------------------------
  // A drift line names a SYMBOL (`tick.0.webmod (): (i 64) -> ((i 64)): (i 64)`),
  // not a line, so the declaration has to be found in the buffer. If it cannot
  // be found the report still goes to the console — an unplaceable warning is
  // still a warning, and inventing a location would be worse than having none.
  let driftDecos = [];
  function reportDrift(lines) {
    const ed = window.AowliEditor;
    const monaco = ed && ed.getMonaco && ed.getMonaco();
    const editor = ed && ed.getEditor && ed.getEditor();
    for (const line of lines) emit("log", { text: "hot-swap drift: " + line, warn: true });
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const text = model.getValue();
    const decos = [];
    for (const line of lines) {
      const sym = String(line).split(/\s/)[0].split(".")[0];
      if (!sym) continue;
      const re = new RegExp("\\b(proc|func|template|macro|iterator|converter)\\s+(" +
        sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b");
      const at = text.search(re);
      if (at < 0) continue;
      const pos = model.getPositionAt(at + text.slice(at).search(new RegExp("\\b" + sym + "\\b")));
      decos.push({
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + sym.length),
        options: {
          inlineClassName: "sess-drift",
          hoverMessage: {
            value: "**Live state has the old shape of this.**\n\n`" + line + "`\n\n" +
              "A live caller compiled against the previous signature. aowli has armed " +
              "the call side: a call that binds a definitely-wrong-typed value will " +
              "raise rather than answer wrongly. Restart the session to clear it.",
          },
        },
      });
    }
    try { driftDecos = editor.deltaDecorations(driftDecos, decos); } catch (_) {}
  }
  function clearDrift() {
    const ed = window.AowliEditor;
    const editor = ed && ed.getEditor && ed.getEditor();
    if (!editor) { driftDecos = []; return; }
    try { driftDecos = editor.deltaDecorations(driftDecos, []); } catch (_) { driftDecos = []; }
  }

  // ---- every verb, reported once it has landed ----------------------------------
  // The Live drawer keeps a history of what happened to the running program —
  // each start, swap, append and call, what it printed and what it cost. That
  // history belongs to the page, not to this module, so this only announces a
  // verb AFTER its outcome is folded into the state: a listener reading `gen`
  // or `pending` sees the values this verb produced, never the previous ones.
  function report(kind, r, t0, extra) {
    emit("verb", Object.assign({
      kind, ok: !!(r && r.ok), err: (r && r.err) || "", out: (r && r.out) || "",
      stderr: (r && r.stderr) || "", gen: S.gen, pending: S.pending,
      newGlobals: (r && r.newGlobals) | 0, drift: S.drift.slice(),
      ms: performance.now() - t0, snif: S.lastSnif,
    }, extra || {}));
    return r;
  }

  // ---- the verbs -------------------------------------------------------------
  const api = {
    get state() { return S.state; },
    get gen() { return S.gen; },
    get liveMode() { return S.live; },
    get pending() { return S.pending; },
    get running() { return S.state !== "stopped"; },
    get heap() { return S.heap; },
    on(kind, fn) { if (listeners[kind]) listeners[kind].push(fn); },

    whenReady() {
      if (S.ready) return Promise.resolve();
      return new Promise((r) => { bootWait = r; });
    },

    // Begin a session. `runInit:false` publishes the module without running its
    // top level, which is what the REPL shape wants (append runs the tail).
    async start(snif, opts = {}) {
      await api.whenReady();
      const t0 = performance.now();
      clearDrift();
      S.lastSnif = snif;
      S.ranTo = -1;
      // DOES THE EDITOR OWN WHAT IS RUNNING? A session records whether it was
      // started FROM the buffer, and `offer` refuses to swap the editor's bytes
      // into one that was not.
      S.fromBuffer = !!opts.fromBuffer;
      const r = await send("start", {
        snif, mods: opts.mods || "", stdin: opts.stdin || "",
        runInit: opts.runInit !== false,
      });
      // `ended` if its top level ran and returned; `live` if it was published
      // without running, which is the REPL's shape and means it is standing
      // there waiting to be appended to.
      S.state = !r.ok ? "stopped"
        : opts.runInit === false ? "live"
        : "ended";
      return report("start", absorb(r), t0, { fromBuffer: S.fromBuffer, runInit: opts.runInit !== false });
    },

    // Republish over the LIVE module, keeping every global. This is the verb the
    // whole module exists for.
    async swap(snif) {
      if (S.state === "stopped") return { ok: false, err: "no session is running" };
      S.lastSnif = snif;
      const t0 = performance.now();
      const r = await send("swap", { snif });
      // `hotSafe` refused: the program is inside a call. Keep the bytes and land
      // the swap at the next safe point rather than dropping it.
      if (!r.ok && /inside a call/.test(r.err || "")) {
        S.pending = true;
        emit("state", S);
        return report("swap", r, t0);
      }
      S.pending = false;
      return report("swap", absorb(r), t0);
    },

    // Run ONLY the top-level statements that were appended since last time.
    async append(snif) {
      if (S.state === "stopped") return { ok: false, err: "no session is running" };
      S.lastSnif = snif;
      const t0 = performance.now();
      const before = S.ranTo < 0 ? 0 : S.ranTo;
      const r = await send("append", { snif, from: S.ranTo < 0 ? 0 : -1 });
      if (typeof r.ranTo === "number") S.ranTo = r.ranTo;
      return report("append", absorb(r), t0, { ran: Math.max(0, S.ranTo - before) });
    },

    async call(name) {
      const t0 = performance.now();
      const r = await send("call", { name });
      return report("call", absorb(r), t0, { name, ret: r.ret || null });
    },
    // The running program's module-level variables: [{ n, v }], or null with an
    // `err` when this interpreter build cannot answer. A pure read.
    async globals() {
      if (S.state === "stopped") return { ok: true, globals: [] };
      return send("globals", {});
    },
    async has(name) { const r = await send("has", { name }); return !!r.bool; },

    async stop() {
      const t0 = performance.now();
      const r = await send("stop", {});
      S.state = "stopped"; S.gen = 0; S.pending = false; S.ranTo = -1;
      clearDrift();
      emit("state", S);
      return report("stop", r, t0);
    },

    // Arm / disarm Live mode. Armed, a clean type-check republishes itself into
    // the running session.
    setLive(on) { S.live = !!on; emit("state", S); },

    // THE LIVE HOOK. `runSemCheck` calls this with every clean .s.nif it
    // produces. Nothing happens unless a session is standing and Live is armed —
    // so the cost when the feature is off is one comparison.
    offer(snif) {
      if (!snif || !S.live || S.state === "stopped") return;
      // See `fromBuffer` above: never republish the editor over something the
      // editor did not start.
      if (!S.fromBuffer) return;
      if (snif === S.lastSnif) return;          // the bytes did not actually move
      api.swap(snif);
    },

  };

  window.AowliSession = api;
  spawn();
})();
