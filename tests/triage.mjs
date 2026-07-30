#!/usr/bin/env node
// triage.mjs — group a results-*.json by failure SIGNATURE so the fix order is
// "biggest blast radius first" instead of "whatever is alphabetically first".
//   node tests/triage.mjs [results-vm.json] [--ids]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const HERE = dirname(new URL(import.meta.url).pathname);
const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(HERE, "results-vm.json");
const showIds = process.argv.includes("--ids");
const rs = JSON.parse(readFileSync(file, "utf8"));

const sig = r => {
  if (r.status === "pass") return null;
  const first = (r.stderr || "").split("\n").filter(Boolean)[1] || (r.stderr || "").split("\n")[0] || "";
  const msg = first.replace(/^\s*\d+:\d+\s+/, "")            // strip line:col
    .replace(/'[^']*'/g, "'X'").replace(/"[^"]*"/g, '"X"')   // strip identifiers
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.\d+\b/g, "SYM")      // strip mangled syms
    .slice(0, 110);
  return `${r.status}: ${msg}`;
};
const groups = new Map();
for (const r of rs) {
  const s = sig(r); if (!s) continue;
  if (!groups.has(s)) groups.set(s, []);
  groups.get(s).push(r.id);
}
const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
let total = 0;
for (const [s, ids] of sorted) {
  total += ids.length;
  console.log(`${String(ids.length).padStart(3)}  ${s}`);
  console.log(`     e.g. ${ids.slice(0, showIds ? 99 : 4).join(", ")}`);
}
console.log(`\n${total} failing / ${rs.length} cases`);
