#!/usr/bin/env node
// gen-corpus.mjs — assemble the playground test corpus from the corpora we
// already maintain, into ONE self-contained JSON the browser harness can eat.
//
// Sources:
//   1. ~/nimony/tests/nimony/<cat>/<t>.nim + <t>.output   (206 golden pairs)
//   2. ~/aowli/tests/realworld/*.nim                       (bigger programs)
//   3. ~/aowli/tests/runtime_conformance/*.nim
//   4. ~/nimony-playground/examples.js                     (the shipped demo)
//
// Only SINGLE-FILE programs land in the single-module suite: a case whose
// imports name a sibling .nim in the same category needs the multi-module path
// and is emitted with `multi: [{path, content}, ...]` instead.
//
// Output: tests/corpus.json  [{ id, cat, source, expected, multi?, stdin }]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

const NIMONY = "/home/savant/nimony/tests/nimony";
const AOWLI = "/home/savant/aowli/tests";
const HERE = dirname(new URL(import.meta.url).pathname);

// Categories that can never run in the playground sandbox and are not about the
// playground at all: compile-error expectation tests, build-config tests, and
// the compiler's own plugin/valgrind scaffolding.
const SKIP_CATS = new Set(["errmsgs", "configtest", "configtest2", "pluginpaths",
  "plugins", "valgrind", "nimcache", "setup.hastur", "nifcore", "compat"]);

function importedBases(src) {
  const out = new Set();
  for (const line of src.split("\n")) {
    const m = /^\s*(?:import|from)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    let spec = m[1].split("#")[0].replace(/\bimport\b.*$/, "").replace(/\bexcept\b.*$/, "").replace(/\bas\b.*$/, "");
    const br = /^(.*?)\[([^\]]*)\]\s*$/.exec(spec);
    const items = br ? br[2].split(",").map(s => br[1].trim() + s.trim()) : spec.split(",");
    for (const raw of items) {
      const mod = raw.trim().replace(/\s*\/\s*/g, "/");
      if (mod) out.add(mod.split("/").pop());
    }
  }
  return [...out];
}

// Golden outputs we generated ourselves with the native compiler (gen-oracle.sh)
// for the corpora that ship none.
const ORACLE = join(HERE, "oracle");
const oracleOf = (id) => {
  const p = join(ORACLE, id.replace(/\//g, "__") + ".output");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

const cases = [];

// --- 1. the nimony golden corpus -------------------------------------------
for (const cat of readdirSync(NIMONY)) {
  const dir = join(NIMONY, cat);
  if (SKIP_CATS.has(cat) || !statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".output")) continue;
    const base = f.slice(0, -".output".length);
    const nim = join(dir, base + ".nim");
    if (!existsSync(nim)) continue;
    const source = readFileSync(nim, "utf8");
    const expected = readFileSync(join(dir, f), "utf8");
    // sibling modules this test pulls in
    const sibs = importedBases(source).filter(b => existsSync(join(dir, b + ".nim")));
    const multi = [];
    const seen = new Set();
    const walk = (b) => {
      if (seen.has(b)) return; seen.add(b);
      const p = join(dir, b + ".nim");
      if (!existsSync(p)) return;
      const s = readFileSync(p, "utf8");
      for (const d of importedBases(s)) if (existsSync(join(dir, d + ".nim"))) walk(d);
      multi.push({ path: b + ".nim", content: s });
    };
    for (const b of sibs) walk(b);
    cases.push({ id: cat + "/" + base, cat, source, expected, multi: multi.length ? multi : null, stdin: "" });
  }
}

// --- 2/3. aowli's own program corpora ---------------------------------------
for (const [sub, cat] of [["realworld", "realworld"], ["runtime_conformance", "runtimeconf"]]) {
  const dir = join(AOWLI, sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".nim")) continue;
    const base = f.slice(0, -4);
    const outFile = join(dir, base + ".output");
    const expected = existsSync(outFile) ? readFileSync(outFile, "utf8") : oracleOf(cat + "/" + base);
    // no golden output and the native compiler couldn't produce one ⇒ the case
    // has no oracle at all, so it cannot judge the playground. Drop it.
    if (expected == null) continue;
    cases.push({ id: cat + "/" + base, cat, source: readFileSync(join(dir, f), "utf8"), expected, multi: null, stdin: "" });
  }
}

// --- 4. the shipped demo ------------------------------------------------------
{
  const js = readFileSync(join(HERE, "..", "examples.js"), "utf8");
  const m = /window\.PLAYGROUND_DEMO\s*=\s*`([\s\S]*?)`;/.exec(js);
  if (m) cases.push({ id: "playground/demo", cat: "playground", source: m[1].replace(/\\`/g, "`").replace(/\\\$/g, "$"), expected: oracleOf("playground/demo"), multi: null, stdin: "" });
}

writeFileSync(join(HERE, "corpus.json"), JSON.stringify(cases, null, 0));
const byCat = {};
for (const c of cases) byCat[c.cat] = (byCat[c.cat] || 0) + 1;
console.log(`corpus: ${cases.length} cases`);
console.log(Object.entries(byCat).sort().map(([k, v]) => `  ${k}: ${v}`).join("\n"));
