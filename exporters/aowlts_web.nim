## aowlts_web.nim — browser/Node entry for the aowlts TypeScript exporter,
## compiled through the nimony-web JS backend (`nim_js`). It replaces the CLI
## driver's file/stdout bridges (aowlts/src/aowlts_cli.nim) with in-memory
## equivalents so the emitter runs with NO file I/O:
##
##   * INPUT   — the program's sem'd typed `.s.nif` bytes arrive as a JS string
##               in `globalThis.__ats_src` (the very bytes nimsem hands the
##               playground in-browser). `globalThis.__ats_faithful` is "1" to
##               request the faithful (BigInt int64) export, "" for the default
##               fast export.
##   * EMIT    — identical to the CLI's per-module path: parseFromBuffer ->
##               beginRead -> tsPrelude + emitModuleBody + tsFlush. The browser
##               `.s.nif` is self-contained (nimsem inlines the closure), so there
##               is no user-module import graph to replay — one module in, one TS
##               string out.
##   * OUTPUT  — the produced TypeScript text goes back on `globalThis.__ats_out`.
##               No filesystem, no stdout.
##
## The main module's symbols carry an EMPTY module suffix in the browser `.s.nif`
## (nimsem names it "main"); emitModuleBody appends the passed key for uniqueness,
## so we pass "main" to match `bin/aowlts main.s.nif` byte-for-byte.

when defined(nimony):
  {.feature: "lenientnils".}

import nifcursors, nifstreams, programs
import emitts
import jsffi

proc emitTs(src: string; faithful: bool): string =
  setupProgramForTesting("", "main", ".s.nif")
  setFaithful(faithful)
  var buf = parseFromBuffer(src, "main")
  var root = beginRead(buf)
  result = tsPrelude()
  # match aowlts_cli's per-module banner so the browser output is byte-identical
  # to `bin/aowlts main.s.nif` (the browser `.s.nif` is a single self-contained
  # module, so there is exactly one — the main one).
  result.add "\n// --- main module ---\n"
  result.add emitModuleBody(root, "main")
  result.add tsFlush()
  endRead buf

proc atsRun() =
  ## Runs as MODULE INIT (top-level) — NOT an `{.exportc: "main".}` proc: the JS
  ## backend emits its own `main(argc, argv, envp)` that drives the module inits,
  ## so a second `main` would shadow it (same rule as aowli/aowlparser webmain).
  let src = global("__ats_src").toStr
  let faithful = global("__ats_faithful").toStr.len != 0
  let outp = emitTs(src, faithful)
  let g = global("globalThis")
  g.set("__ats_out", toJs(outp))

atsRun()
