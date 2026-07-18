## aowljs_web.nim -- browser/Node entry for the aowljs idiomatic-JavaScript
## exporter, compiled through the nimony-web JS backend (`nim_js`). It replaces
## the CLI driver's file/stdout bridges (aowljs/src/aifjs_cli.nim) with in-memory
## equivalents so the emitter runs with NO file I/O:
##
##   * INPUT   -- the program's sem'd typed `.s.nif` bytes arrive as a JS string
##               in `globalThis.__ajs_src`. `globalThis.__ajs_faithful` is "1" to
##               request the faithful (BigInt int64) export, "" for the default
##               fast (Number) export -- mirroring `aowljs --faithful`.
##   * EMIT    -- identical to the CLI's per-module path: jsPrelude ->
##               emitModuleBody -> jsFlush. The browser `.s.nif` is
##               self-contained (nimsem inlines the closure), so there is no
##               user-module import graph to replay -- one module in, one JS
##               string out.
##   * OUTPUT  -- the produced JavaScript text goes back on `globalThis.__ajs_out`.
##               No filesystem, no stdout.
##
## Byte-parity target: `bin/aowljs main.s.nif` (fast) / `bin/aowljs --faithful
## main.s.nif` on a single self-contained module. Unlike aowlts, aowljs's
## emitModuleBody takes no module key, so the output is the same whatever the
## module is called.

when defined(nimony):
  {.feature: "lenientnils".}

import nifcursors, nifstreams, programs
import emitjs
import jsffi

proc emitJs(src: string; faithful: bool): string =
  setupProgramForTesting("", "main", ".s.nif")
  setFaithful(faithful)
  var buf = parseFromBuffer(src, "main")
  var root = beginRead(buf)
  result = jsPrelude()
  # match aifjs_cli's per-module banner so the browser output is byte-identical
  # to `bin/aowljs main.s.nif` (the browser `.s.nif` is a single self-contained
  # module, so there is exactly one -- the main one).
  result.add "\n// --- main module ---\n"
  result.add emitModuleBody(root)
  result.add jsFlush()
  endRead buf

proc ajsRun() =
  ## Runs as MODULE INIT (top-level) -- NOT an `{.exportc: "main".}` proc: the JS
  ## backend emits its own `main(argc, argv, envp)` that drives the module inits,
  ## so a second `main` would shadow it (same rule as aowlts/aowlpy webmain).
  let src = global("__ajs_src").toStr
  let faithful = global("__ajs_faithful").toStr.len != 0
  let outp = emitJs(src, faithful)
  let g = global("globalThis")
  g.set("__ajs_out", toJs(outp))

ajsRun()
