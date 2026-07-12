# nimony playground

A little **nimony playground that runs entirely in your browser**. There is no
backend: the nimony interpreter (`nifi`) is compiled to JavaScript by
[`aoughwl/nimony-web`](https://github.com/aoughwl/nimony-web) and executes your
program in the same tab. Your code never leaves the page.

## How it works

```
your source ──▶ [ nimony frontend: nifler + nimsem ]  ──▶  .s.nif (typed NIF)
                          (Tier 2, in-browser)                     │
                                                                   ▼
                                            [ nifi interpreter, compiled to JS ]
                                                                   │
                                                                   ▼
                                                          stdout in the tab
```

- **`nifi`** interprets *typed* NIF (`.s.nif`) — the form nimony emits after
  semantic analysis. It's ~4.6k LOC of pure, synchronous nimony, which
  `nimony-web`'s `nim_js` backend compiles to JavaScript. Its only host needs
  (file read, stdout) are behind clean seams: `.s.nif` bytes are fed in-memory
  via `nifreader.openFromBuffer`, and output is collected in the in-memory
  `OutSink` and handed back to JS.
- **stdlib** ships as pre-compiled `.s.nif` assets (`system` + common modules),
  loaded on demand — so programs using the standard library just work.

## Tiers

| Tier | What runs client-side | Status |
|------|-----------------------|--------|
| 1 | `nifi.js` runs **pre-compiled** example bytecode | build in progress |
| 2 | frontend (`nifler`+`nimsem`) ported to JS ⇒ **arbitrary typed source** compiles & runs live | planned |
| 3 | nimony **LSP** in a Web Worker + `monaco-languageclient` ⇒ **live diagnostics/hover** | planned |

Tiers 2 and 3 share the hard part — porting the compiler frontend to JS. A
faster [WASM backend](https://github.com/aoughwl/nimony-web) (`nim_wasm`) is a
performance follow-on once the JS path is proven.

## Files

```
index.html    page shell (theme-aware, responsive)
editor.js     Monaco editor + a nimony grammar (textarea fallback offline)
examples.js   starter programs
engine.js     the single seam to the compiled interpreter (window.NifiCore)
assets/snif/  pre-compiled .s.nif bytecode for examples + stdlib
nifi.js       the interpreter, compiled to JS  (produced by nimony-web)
```

## Local preview

Any static server works (no backend):

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

## Deploy

Fully static — publishes to GitHub Pages (the `aoughwl.github.io` pipeline) or
any static host. No server, no build step at request time.
