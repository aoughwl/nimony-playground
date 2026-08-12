# nimony playground

**A [nimony](https://github.com/nim-lang/nimony) playground that runs entirely in
your browser.** You type nimony source; it is parsed, type-checked, and executed
in the same tab. There is no backend — your code never leaves the page.

### ▶ Try it live: **<https://aoughwl.github.io/playground/>**

That URL is the canonical deployment (part of the
[`aoughwl.github.io`](https://github.com/aoughwl/aoughwl.github.io) site, which
provides the shared theme, fonts, logo, and favicon). This repository holds the
playground's source, mirrored from that site.

## How it works

The whole nimony toolchain is compiled to JavaScript by
[`aoughwl/nimony-web`](https://github.com/aoughwl/nimony-web)'s `nim_js` backend
and runs client-side:

```
your source
   │
   ▼  aowlparser (aoughwl/aowlparser — a browser-capable Nim→NIF parser)
 .p.nif                                            [main thread, ~4 ms]
   │
   ▼  aowlsem    (aoughwl/aowlsem — the semantic checker; nimsem optional)
 .s.nif  (typed NIF)                               [Web Worker, cached]
   │
   ▼  aowli      (aoughwl/aowli — a typed-NIF interpreter)
   │             bytecode VM (fast path) ─┐
   │             tree-walker  (fallback) ─┴─▶ stdout / stderr / exit
   ▼
 output in the tab
```

- **aowlparser** replaces classic Nim's `nifler` (which is native-only and can't
  run in a browser). It parses your source to the untyped `.p.nif` on the main
  thread, which also feeds the live editor intelligence. The repo is
  `aoughwl/aowlparser`; the bundle here is still named `nifparser.js`, along with
  its cache keys, because renaming a shipped asset breaks every cached client —
  the FILE name is legacy, the TOOL is aowlparser.
- **aowlsem** turns the `.p.nif` into a typed `.s.nif`, resolving every symbol,
  overload, and type. It is the **default** checker. It runs in a Web Worker
  against a pre-semchecked std surface shipped as `assets/aowlsem-mods.bin`
  (system, syncio, math, strutils, tables, sets, sequtils, algorithm, options,
  times, random, hashes, bitops, deques, parseutils, unicode, …) — only the
  modules a program actually imports are loaded, closed over each module's own
  recorded dependencies.
- **nimsem**, nimony's own checker, is still shipped and selectable in
  ⚙ Config → Pipeline → Checker. It is the reference implementation, and a
  **multi-file workspace routes to it automatically**: aowlsem checks one module
  at a time and has no cross-file import resolution.
- **aowli** runs the typed `.s.nif`. It tries a **bytecode VM** first (faster on
  compute) and falls back to an always-correct **tree-walker** for programs the
  VM can't yet run self-contained. Both share one in-memory linear heap.
- **stdlib** ships as pre-compiled `.s.nif`/binary assets, so programs that
  `import std/…` a bundled module just work.

Running the checker + aowli in a Web Worker is what makes **Stop** work: a runaway loop
can't be interrupted cooperatively, but the worker can be terminated (and a fresh
one spun up from HTTP-cached bundles).

## Features

- **Live diagnostics** — syntax (aowlparser) and semantic (aowlsem) errors as
  you type, with editor squiggles and a problems list.
- **Editor intelligence** — hover types, `⌃Space` completion, `F12` go-to-def,
  an outline/Symbols panel — a nimony LSP running in a Web Worker.
- **Multi-level NIF inspector** — the source pane tabs between your **Source**
  and the compilation tower it becomes: **Parsed** (`.p.nif`), **Typed**
  (`.s.nif`), and the **Run** rung — the program's *execution* serialized as NIF
  (from aowli's run emitter). Rendered with structure-aware highlighting, still
  selectable/copyable as verbatim NIF.
- **stdin**, a curly-brace block mode toggle, three themes, word-wrap, a
  resizable / re-orientable split, and shareable links (the code travels in the
  URL hash — static host, no server).

## Files

```
index.html      page shell, UI, and all hand-written glue
editor.js       Monaco editor + nimony grammar (textarea fallback offline)
lsp.js          in-browser nimony LSP (hover / completion / definition / outline)
parser.js       nifparser seam (.p.nif on the main thread)
sem.js          semantic-check seam (facade over the worker)
engine.js       compile-and-run seam (window.AowliEngine)
pipeline.js     owns the Web Worker; sem / run / runrung / stop
worker.js       the worker: aowlsem / nimsem + aowli (VM, tree-walker, run rung)
curlyconvert.js colon ⇄ curly source rewriter
examples.js     the starter program
exporters.js    Export TypeScript / Python seam (drives aowlts.js / aowlpy.js)
exporters/      web entries for the exporters (compiled by build-exporters.sh)
assets/snif/    pre-compiled .s.nif for examples
assets/nimsem-stdlib.bin   pre-compiled stdlib closure for nimsem
assets/aowlsem-mods.bin    pre-semchecked std modules for aowlsem
                           (built by aowlsem-js/mods_build.sh)

# bundles produced by aoughwl/nimony-web's nim_js backend:
nifparser.js    the parser            (~0.9 MB)
aowlsem.js      the semantic checker, DEFAULT (~12 MB, obfuscated build)
nimsem.js       nimony's semantic checker, reference (~8.9 MB)
aowli.js         interpreter, tree-walker
aowli_vm.js      interpreter, bytecode VM (fast path)
aowli_run.js     interpreter, tree-walker + run-rung emitter (lazy-loaded)
aowlts.js       idiomatic-TypeScript exporter (aowlts) (~1.5 MB)
aowlpy.js       idiomatic-Python exporter   (aowlpy) (~1.5 MB)
```

## Export TypeScript / Python

The source pane's **TypeScript** and **Python** tabs transpile the current
program to idiomatic, hand-written-looking source — real TS/Python types and
control flow, not linear memory — entirely client-side. They run the buffer
through the same frontend the other tabs use (nifparser → aowlsem → the typed
`.s.nif`) and hand that `.s.nif` to [`aowlts`](https://github.com/aoughwl/aowlts)
/ [`aowlpy`](https://github.com/aoughwl/aowlpy), nimony programs compiled to
JavaScript by the very same `nim_js` backend that builds the parser/interpreter
bundles (see `build-exporters.sh`). The TypeScript tab has a **faithful** toggle
(`int64` → `BigInt`, exact-width arithmetic); each panel offers Copy / Download.
Output is byte-identical to the native `bin/aowlts` / `bin/aowlpy` CLIs.

## Local preview

Any static server works (no backend, no request-time build):

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

The page references a few site-relative assets (logo, favicon, `../` back to the
docs) that only resolve on the full site — for the complete experience use the
live URL above.

## Deploy

Fully static; publishes to GitHub Pages or any static host. The live copy is
served from the `aoughwl.github.io` repository at `/playground/`.
