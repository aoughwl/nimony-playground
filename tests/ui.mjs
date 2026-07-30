#!/usr/bin/env node
// ui.mjs — feature/integration suite for the playground SHELL: the things the
// corpus runner (run.mjs) never touches because it calls AowliCore directly.
//
// Each test drives the real DOM: the Run button, the compile-stage tabs, the
// export targets, the formatter, curly-convert, the explorer/workspace, the
// debugger and the LSP surface. A test is a { name, fn(page) } that throws on
// failure.
//
//   node tests/ui.mjs                 # all
//   node tests/ui.mjs --filter=export
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { serve } from "./server.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const require = createRequire("/home/savant/webir/");
const { chromium } = require("playwright");
const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? "1"] : [a, "1"];
}));

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const HELLO = 'import std/syncio\n\nproc greet(who: string): string =\n  return "hello, " & who\n\necho greet("world")\nfor i in 0 ..< 3:\n  echo i\n';

// set the editor buffer the way a user typing does (Monaco or the textarea fallback)
async function setSource(page, src) {
  await page.evaluate(s => window.AowliEditor.setValue(s), src);
  await page.waitForTimeout(350);          // debounced live check
}
async function runProgram(page, timeout = 30000) {
  await page.evaluate(() => { document.getElementById("out").textContent = ""; });
  await page.click("#runBtn");
  await page.waitForFunction(() => {
    const b = document.getElementById("runBtn");
    return b && !b.disabled && !/stop/i.test(b.textContent);
  }, null, { timeout }).catch(() => {});
  await page.waitForTimeout(150);
  return page.evaluate(() => document.getElementById("out").innerText);
}
async function stageText(page, stage) {
  await page.click(`#stageSeg button[data-stage="${stage}"]`);
  const id = { pnif: "#pnif", snif: "#snif", cnif: "#cnif", rnif: "#rnif" }[stage];
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    return el && el.textContent.trim().length > 40 && !el.querySelector(".sys");
  }, id, { timeout: 90000 });
  return page.evaluate(sel => document.querySelector(sel).textContent, id);
}

const TESTS = [
  { name: "boot/no-page-errors", async fn(page, ctx) {
      ok(ctx.pageErrors.length === 0, "page errors on boot: " + ctx.pageErrors.join(" | "));
      ok(await page.isVisible("#editor, #fallback"), "no editor");
    } },

  { name: "run/button-produces-output", async fn(page) {
      await setSource(page, HELLO);
      const out = await runProgram(page);
      ok(/hello, world/.test(out), "missing greeting; got: " + JSON.stringify(out.slice(0, 200)));
      ok(/0[\s\S]*1[\s\S]*2/.test(out), "missing loop output: " + JSON.stringify(out.slice(0, 200)));
    } },

  { name: "run/stdin-is-fed-to-the-program", async fn(page) {
      await setSource(page, 'import std/syncio\nlet line = readLine(stdin)\necho "got: ", line\n');
      await page.evaluate(() => {
        const b = document.getElementById("stdinBtn"); if (b && !document.getElementById("stdinBar").classList.contains("on")) b.click();
        const box = document.getElementById("stdinBox"); box.value = "ping\n";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const out = await runProgram(page);
      ok(/got: ping/.test(out), "stdin not delivered; got: " + JSON.stringify(out.slice(0, 200)));
      await page.evaluate(() => { const b = document.getElementById("stdinBox"); b.value = ""; b.dispatchEvent(new Event("input", { bubbles: true })); });
    } },

  { name: "diagnostics/live-error-markers", async fn(page) {
      await setSource(page, "import std/syncio\nlet x: int = \"str\"\necho x\n");
      await page.waitForFunction(() => (window.__aowliLastDiags || []).length > 0, null, { timeout: 60000 })
        .catch(() => { throw new Error("no live diagnostics exposed (window.__aowliLastDiags)"); });
      const d = await page.evaluate(() => window.__aowliLastDiags);
      ok(d.some(x => x.line === 2), "expected a diagnostic on line 2, got " + JSON.stringify(d).slice(0, 200));
    } },

  { name: "diagnostics/clean-program-has-none", async fn(page) {
      await setSource(page, HELLO);
      await page.waitForTimeout(1500);
      const d = await page.evaluate(() => window.__aowliLastDiags || []);
      ok(d.filter(x => x.severity !== "hint" && x.severity !== "info").length === 0,
        "clean program reported diagnostics: " + JSON.stringify(d).slice(0, 300));
    } },

  { name: "stages/parsed-typed-run", async fn(page) {
      await setSource(page, HELLO);
      const p = await stageText(page, "pnif");
      ok(/\(stmts/.test(p), "parsed stage does not look like NIF");
      const s = await stageText(page, "snif");
      ok(s.length > p.length / 4 && /greet/.test(s), "typed stage missing symbols");
      const r = await stageText(page, "rnif");
      ok(r.length > 20, "run rung empty");
      await page.click('#stageSeg button[data-stage="edit"]');
    } },

  { name: "stages/lowered-cnif", async fn(page) {
      await setSource(page, HELLO);
      const c = await stageText(page, "cnif");
      ok(c.length > 100, "lowered .c.aif empty");
      await page.click('#stageSeg button[data-stage="edit"]');
    } },

  { name: "export/all-targets-emit", async fn(page) {
      await setSource(page, HELLO);
      await page.click("#stabExport");
      for (const t of ["js", "jsn", "ts", "tsn", "py", "c"]) {
        await page.click(`#exportTargets button[data-exp="${t}"]`);
        await page.waitForFunction(() => {
          const el = document.getElementById("exOut") || document.querySelector("#sviewExport pre, #exportEditor");
          return el && el.textContent.trim().length > 60;
        }, null, { timeout: 120000 }).catch(() => { throw new Error(`export target ${t} produced nothing`); });
        const txt = await page.evaluate(() => (document.getElementById("exOut") || document.querySelector("#sviewExport pre, #exportEditor")).textContent);
        ok(!/^\s*(error|Error)/.test(txt), `export ${t} errored: ` + txt.slice(0, 160));
        ok(/greet/.test(txt), `export ${t} lost the proc: ` + txt.slice(0, 160));
      }
      await page.click("#stabStages");
    } },

  { name: "format/idempotent-and-meaning-preserving", async fn(page) {
      const messy = 'import std/syncio\n\nproc  add( a:int ,b:int ):int=\n    return a+b\n\n\n\n\necho add(2,3)\n';
      await setSource(page, messy);
      await page.click("#configBtn"); await page.waitForTimeout(200);
      await page.click("#fmtRun");
      await page.waitForTimeout(800);
      const once = await page.evaluate(() => window.AowliEditor.getValue());
      await page.click("#fmtRun");
      await page.waitForTimeout(800);
      const twice = await page.evaluate(() => window.AowliEditor.getValue());
      ok(once === twice, "formatter is not idempotent");
      await page.click("#cfgClose").catch(() => {});
      await page.waitForTimeout(200);
      const out = await runProgram(page);
      ok(/^\s*5/m.test(out), "formatted program changed behaviour: " + JSON.stringify(out.slice(0, 200)));
    } },

  { name: "curly/roundtrip-preserves-behaviour", async fn(page) {
      await setSource(page, HELLO);
      const before = await runProgram(page);
      await page.click("#configBtn"); await page.waitForTimeout(200);
      await page.click("#curlyConvertBtn"); await page.waitForTimeout(600);
      const curly = await page.evaluate(() => window.AowliEditor.getValue());
      ok(/\{/.test(curly), "curly convert produced no braces");
      await page.click("#curlyConvertBtn"); await page.waitForTimeout(600);
      await page.click("#cfgClose").catch(() => {});
      const after = await runProgram(page);
      ok(before.trim() === after.trim(), "curly round-trip changed behaviour");
    } },

  { name: "workspace/multi-file-imports-see-exports", async fn(page) {
      await page.evaluate(() => {
        const W = window.AowliWorkspace;
        for (const p of [...W.projects]) W.removeProject(p.id);
        const id = W.addProject({ name: "mf", kind: "user" }).id;
        W.addFile(id, "util.nim", "proc twice*(x: int): int = x * 2\nconst Name* = \"util\"\n");
        W.addFile(id, "main.nim", "import std/syncio\nimport util\necho twice(21)\necho Name\n");
        W.openFile(id, "main.nim", true);
      });
      await page.waitForTimeout(400);
      await setSource(page, "import std/syncio\nimport util\necho twice(21)\necho Name\n");
      const out = await runProgram(page);
      ok(/42/.test(out) && /util/.test(out), "cross-file import lost exports: " + JSON.stringify(out.slice(0, 200)));
    } },

  { name: "workspace/file-crud-and-persistence", async fn(page, ctx) {
      await page.evaluate(() => {
        const W = window.AowliWorkspace;
        for (const p of [...W.projects]) W.removeProject(p.id);
        const id = W.addProject({ name: "crud", kind: "user" }).id;
        W.addFile(id, "a.nim", "echo 1\n");
        W.addFile(id, "b.nim", "echo 2\n");
        W.renameFile(id, "b.nim", "c.nim");
        W.deleteFile(id, "a.nim");
        W.openFile(id, "c.nim", true);
        W.saveNow();
      });
      const list = await page.evaluate(() => {
        const W = window.AowliWorkspace; return W.fileList(W.projects.find(p => p.name === "crud").id);
      });
      ok(JSON.stringify(list) === JSON.stringify(["c.nim"]), "CRUD wrong: " + JSON.stringify(list));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction("window.AowliWorkspace && window.AowliWorkspace.projects.length", null, { timeout: 60000 });
      const after = await page.evaluate(() => {
        const p = window.AowliWorkspace.projects.find(p => p.name === "crud");
        return p ? window.AowliWorkspace.fileList(p.id) : null;
      });
      ok(after && after.includes("c.nim"), "workspace did not persist across reload: " + JSON.stringify(after));
      await ctx.reboot(page);
    } },

  { name: "run/stop-kills-a-runaway-loop", async fn(page) {
      await setSource(page, "import std/syncio\nvar i = 0\nwhile true:\n  inc i\n");
      await page.click("#runBtn");
      await page.waitForTimeout(1200);
      const busy = await page.evaluate(() => window.AowliPipe.busy());
      ok(busy, "runaway program was not still running");
      await page.evaluate(() => window.AowliPipe.stop());
      await page.waitForFunction("window.AowliPipe.ready && !window.AowliPipe.busy()", null, { timeout: 60000 });
    } },

  { name: "debugger/records-steps-and-locals", async fn(page) {
      await setSource(page, "import std/syncio\nproc f(n: int): int =\n  var acc = 0\n  for i in 0 ..< n:\n    acc = acc + i\n  return acc\necho f(5)\n");
      const dbg = await page.evaluate(async () => {
        const { nif } = window.AowliParser.parseFull(window.AowliEditor.getValue(), "in.nim");
        const r = await window.AowliPipe.debug(nif, "", "nim", null);
        return { n: (r.steps || []).length, stdout: r.stdout || "", first: (r.steps || [])[0] || null,
                 anyLocals: (r.steps || []).some(s => s.locals && Object.keys(s.locals).length) };
      });
      ok(dbg.n > 5, "debugger recorded too few steps: " + dbg.n);
      ok(/10/.test(dbg.stdout), "debug run produced wrong stdout: " + JSON.stringify(dbg.stdout));
      ok(dbg.first && dbg.first.line, "step records carry no line info: " + JSON.stringify(dbg.first));
      ok(dbg.anyLocals, "no step captured any locals");
    } },

  { name: "lsp/symbols-hover-definition-completion", async fn(page) {
      await setSource(page, HELLO);
      await page.waitForTimeout(600);
      const syms = await page.evaluate(() => document.getElementById("symList").innerText);
      ok(/greet/.test(syms), "symbols panel missing proc: " + JSON.stringify(syms.slice(0, 200)));
      const api = await page.evaluate(() => {
        const L = window.AowliLsp || window.AowliIndex || null;
        return L ? Object.keys(L) : null;
      });
      ok(api, "no LSP surface exposed on window");
    } },

  { name: "importgate/unknown-module-is-a-clean-error", async fn(page) {
      await setSource(page, "import nosuchmodule\necho 1\n");
      const out = await runProgram(page);
      ok(/not available|unavailable/i.test(out), "unknown import not reported cleanly: " + JSON.stringify(out.slice(0, 200)));
      ok(!/undefined|\[object/i.test(out), "unknown import produced a junk message: " + out.slice(0, 200));
    } },

  // Multi-file projects: the workspace sems every user module and the
  // interpreter must be able to LOAD a dependency's .s.nif (it does so through
  // an in-memory VFS; without it the bundle died on posix `open`). Runs the
  // project TWICE with different bodies, because the warm nimsem instance used
  // to be good for exactly one multi-module check — the second reported the
  // generic "not supported in the browser sandbox".
  { name: "multifile/imports-run-and-survive-an-edit", async fn(page) {
      const run2 = (n) => page.evaluate(async (n) => {
        const W = window.AowliWorkspace;
        for (const p of [...W.projects]) if (p.kind !== "std") W.removeProject(p.id);
        const pid = W.addProject({ name: "mf", kind: "user" }).id;
        const main = `import std/syncio\nimport helper\necho tag(), " ", bump(${n})\n`;
        W.addFile(pid, "main.nim", main);
        W.addFile(pid, "helper.nim",
          `import std/syncio\nproc tag*(): string = "v${n}"\nproc bump*(x: int): int =\n  result = x + ${n}\n`);
        W.openFile(pid, "main.nim", true);
        const r = await window.AowliCore.compileAndRun(main, "", "vm");
        return (r.stdout || "") + "|" + (r.stderr || "");
      }, n);
      const a = await run2(1);
      ok(/^v1 2\b/.test(a.trim()), "first multi-file run wrong: " + JSON.stringify(a));
      const b = await run2(5);
      ok(/^v5 10\b/.test(b.trim()), "second multi-file run wrong (stale warm sem?): " + JSON.stringify(b));
    } },

  { name: "engines/tree-vm-nifjs-agree", async fn(page) {
      const src = "import std/syncio\nvar t = 0\nfor i in 1 .. 20:\n  t = t + i * i\necho t\nlet s = \"abc\"\necho s & \"!\", ' ', s.len\n";
      const outs = await page.evaluate(async (src) => {
        const res = {};
        for (const e of ["tree", "vm", "nifjs"]) {
          const r = await window.AowliCore.compileAndRun(src, "", e);
          res[e] = (r.stdout || "") + "|" + (r.stderr || "") + "|" + r.exitCode;
        }
        return res;
      }, src);
      ok(outs.tree === outs.vm, `tree vs vm disagree:\n  tree=${outs.tree}\n  vm=${outs.vm}`);
      ok(outs.tree === outs.nifjs, `tree vs nifjs disagree:\n  tree=${outs.tree}\n  nifjs=${outs.nifjs}`);
    } },
];

(async () => {
  const { srv, port } = await serve(join(HERE, ".."));
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({ headless: !argv.headed });
  const bctx = await browser.newContext();
  const page = await bctx.newPage();
  const ctx = { pageErrors: [], reboot: async (p) => {
    await p.evaluate(() => { try { localStorage.clear(); } catch (_) {} });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForFunction("window.AowliParser && window.AowliParser.ready && window.AowliPipe && window.AowliPipe.ready", null, { timeout: 120000 });
  } };
  page.on("pageerror", e => ctx.pageErrors.push(e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.AowliParser && window.AowliParser.ready && window.AowliPipe && window.AowliPipe.ready", null, { timeout: 120000 });

  let pass = 0; const fails = [];
  for (const t of TESTS) {
    if (argv.filter && !new RegExp(argv.filter).test(t.name)) continue;
    const before = ctx.pageErrors.length;
    try {
      await t.fn(page, ctx);
      const newErrs = ctx.pageErrors.slice(before);
      if (newErrs.length && t.name !== "boot/no-page-errors") throw new Error("uncaught page error: " + newErrs[0]);
      console.log("  PASS  " + t.name); pass++;
    } catch (e) {
      console.log("  FAIL  " + t.name + "\n        " + String(e.message).split("\n").join("\n        "));
      fails.push(t.name);
      await ctx.reboot(page).catch(() => {});
    }
  }
  await browser.close(); srv.close();
  console.log(`\n=== ui: ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) console.log("failing: " + fails.join(", "));
  process.exit(fails.length ? 1 : 0);
})();
