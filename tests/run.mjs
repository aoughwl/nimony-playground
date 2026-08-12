#!/usr/bin/env node
// run.mjs — the playground's differential test harness.
//
// Drives the REAL page in headless chromium (same worker, same bundles, same
// import gate) and runs every corpus program through `AowliCore.compileAndRun`,
// comparing stdout against the golden output the nimony/aowli corpora ship.
//
//   node tests/run.mjs                      # whole corpus, vm engine
//   node tests/run.mjs --engine=tree        # tree-walker instead
//   node tests/run.mjs --filter=exceptions  # id regex
//   node tests/run.mjs --pages=4            # parallel pages
//   node tests/run.mjs --update-baseline    # rewrite tests/baseline.json
//
// Exit code 0 iff every non-baselined case passes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { serve } from "./server.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const require = createRequire("/home/savant/webir/");
const { chromium } = require("playwright");

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? "1"] : [a, "1"];
}));
const ENGINE = argv.engine || "vm";
// --sem=aowl|nim — which semantic checker the page should use. The page persists
// the choice in localStorage ("np-sem"), so seeding it before navigation is what
// picks the checker; with no flag the corpus runs against the page DEFAULT
// (aowlsem). This exists so the two checkers can be diffed on one corpus —
// without it, "N failing" says nothing about whether the switch caused them.
const SEM = argv.sem || "";
const FILTER = argv.filter ? new RegExp(argv.filter) : null;
const PAGES = Math.max(1, parseInt(argv.pages || "4", 10));
const TIMEOUT = parseInt(argv.timeout || "25000", 10);
const HEADED = !!argv.headed;

const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"))
  .filter(c => !FILTER || FILTER.test(c.id));
// baseline.json: { "<id>": "<reason it cannot pass in the browser sandbox>" }
const BASELINE_PATH = join(HERE, "baseline.json");
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};

// stdout comparison: trailing-newline and trailing-space insensitive, since the
// golden files come from a native run through a different stdio path.
const norm = s => String(s == null ? "" : s).replace(/[ \t]+$/gm, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");

// ---- the in-page driver -----------------------------------------------------
// Runs inside the page: installs the workspace state a case needs, then calls
// the same entry point the Run button uses.
const DRIVER = `(async (c, engine, timeout) => {
  const W = window.AowliWorkspace;
  // fresh single-project workspace per case (buildMulti reads it)
  for (const p of [...W.projects]) W.removeProject(p.id);
  const pid = W.addProject({ name: "t", kind: "user" }).id;
  W.addFile(pid, "main.nim", c.source);
  for (const f of (c.multi || [])) W.addFile(pid, f.path, f.content);
  W.openFile(pid, "main.nim", true);
  const errs = [];
  const onErr = e => errs.push(String(e && e.message || e));
  window.addEventListener("error", onErr);
  let r, timedOut = false;
  try {
    r = await Promise.race([
      window.AowliCore.compileAndRun(c.source, c.stdin || "", engine),
      new Promise(res => setTimeout(() => { timedOut = true; res({ stdout:"", stderr:"TIMEOUT", exitCode:-1 }); }, timeout))
    ]);
  } catch (e) {
    r = { stdout:"", stderr:"THREW: " + (e && e.message || e), exitCode:-2 };
  }
  window.removeEventListener("error", onErr);
  if (timedOut) { try { window.AowliPipe.stop(); } catch(_){} }
  return { stdout:r.stdout||"", stderr:r.stderr||"", exitCode:r.exitCode|0,
           engine:r.engine||"", fellBack:!!r.fellBack, fallbackReason:r.fallbackReason||"",
           oom:!!r.oom, timedOut, pageErrors: errs };
})`;

function classify(res, expected) {
  if (res.exitCode === -4) return "wedged";
  if (res.exitCode === -3) return "harness";
  if (res.timedOut) return "timeout";
  if (res.exitCode === -2) return "threw";
  const err = res.stderr || "";
  if (/^unavailable import/.test(err)) return "import-gate";
  if (/^syntax error/.test(err)) return "parse";
  if (/^semantic error/.test(err)) return "sem";
  if (expected == null) return "no-oracle";
  return norm(res.stdout) === norm(expected) ? "pass" : "output";
}

async function runPage(browser, url, cases, results, progress) {
  const consoleErrors = [];
  let ctx = null, page = null;
  // A fresh context+page. Also the recovery path when a case wedges the page's
  // MAIN thread (the parser runs there, so a pathological parse can hang the
  // whole tab — the in-page setTimeout never fires and evaluate() never returns).
  async function fresh() {
    if (ctx) await ctx.close().catch(() => {});
    ctx = await browser.newContext();
    if (SEM) await ctx.addInitScript(`try{localStorage.setItem("np-sem", ${JSON.stringify(SEM)});}catch(_){}`);
    page = await ctx.newPage();
    page.on("pageerror", e => consoleErrors.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      "window.AowliParser && window.AowliParser.ready && window.AowliPipe && window.AowliPipe.ready",
      null, { timeout: 180000 });
  }
  await fresh();
  for (const c of cases) {
    consoleErrors.length = 0;
    let res, wedged = false;
    try {
      const HANG = TIMEOUT + 20000;
      res = await Promise.race([
        page.evaluate(`${DRIVER}(${JSON.stringify(c)}, ${JSON.stringify(ENGINE)}, ${TIMEOUT})`),
        new Promise(r => setTimeout(() => { wedged = true; r({ stdout: "", stderr: "PAGE WEDGED (main thread never returned)", exitCode: -4, timedOut: false, pageErrors: [] }); }, HANG)),
      ]);
    } catch (e) {
      res = { stdout: "", stderr: "HARNESS: " + e.message, exitCode: -3, timedOut: false, pageErrors: [] };
      wedged = true;
    }
    if (wedged) { await fresh().catch(() => {}); }
    // A killed worker (timeout path) needs a moment to respawn before the next case.
    if (res.timedOut) await page.waitForFunction("window.AowliPipe && window.AowliPipe.ready", null, { timeout: 120000 }).catch(() => {});
    const status = classify(res, c.expected);
    results.push({ id: c.id, cat: c.cat, status, ...res, consoleErrors: consoleErrors.slice(0, 3),
                   expected: c.expected, });
    progress(c.id, status);
  }
  await ctx.close();
}

(async () => {
  const { srv, port } = await serve(join(HERE, ".."));
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({ headless: !HEADED });
  const results = [];
  let done = 0;
  const progress = (id, status) => {
    done++;
    if (status !== "pass" || (done % 25 === 0))
      process.stdout.write(`[${done}/${corpus.length}] ${status.padEnd(11)} ${id}\n`);
  };
  // round-robin split so slow categories spread across pages
  const slices = Array.from({ length: PAGES }, (_, i) => corpus.filter((_, j) => j % PAGES === i));
  await Promise.all(slices.map(s => s.length ? runPage(browser, url, s, results, progress) : null));
  await browser.close();
  srv.close();

  results.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(HERE, `results-${ENGINE}.json`), JSON.stringify(results, null, 1));

  if (argv["update-baseline"]) {
    const b = {};
    for (const r of results) if (r.status !== "pass" && r.status !== "no-oracle") b[r.id] = r.status;
    writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 1));
    console.log(`baseline updated: ${Object.keys(b).length} entries`);
  }

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const regressions = results.filter(r => r.status !== "pass" && r.status !== "no-oracle" && !(r.id in baseline));
  const fixed = results.filter(r => r.status === "pass" && (r.id in baseline));
  console.log("\n=== summary (engine=" + ENGINE + ") ===");
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`  ${"baselined".padEnd(12)} ${Object.keys(baseline).length}`);
  if (fixed.length) console.log(`\nnewly passing (drop from baseline): ${fixed.map(r => r.id).join(", ")}`);
  if (regressions.length) {
    console.log(`\n=== ${regressions.length} FAILING (not baselined) ===`);
    for (const r of regressions) {
      console.log(`\n--- ${r.id}  [${r.status}]`);
      if (r.stderr) console.log("  stderr: " + r.stderr.split("\n").slice(0, 4).join("\n          "));
      if (r.status === "output") {
        const e = norm(r.expected).split("\n"), g = norm(r.stdout).split("\n");
        const i = e.findIndex((l, k) => l !== g[k]);
        console.log(`  first diff at line ${i + 1}:\n    want: ${JSON.stringify(e[i])}\n    got:  ${JSON.stringify(g[i])}`);
      }
      if (r.consoleErrors && r.consoleErrors.length) console.log("  console: " + r.consoleErrors[0]);
    }
  }
  process.exit(regressions.length ? 1 : 0);
})();
