## aowlpy_web.nim — browser/Node entry for the aowlpy Python exporter, compiled
## through the nimony-web JS backend (`nim_js`). It replaces the CLI driver's
## file/stdout bridges (aowlpy/src/aowlpy_cli.nim) with in-memory equivalents so
## the emitter runs with NO file I/O:
##
##   * INPUT   — the program's sem'd typed `.s.nif` bytes arrive as a JS string in
##               `globalThis.__apy_src` (the bytes nimsem hands the playground
##               in-browser).
##   * EMIT    — identical to the CLI: setupProgramForTesting -> PyEmitter with
##               the preamble -> parseFromBuffer -> emitModule. The browser
##               `.s.nif` is self-contained, so there is no user-module import
##               graph to replay.
##   * OUTPUT  — the produced Python 3 text goes back on `globalThis.__apy_out`.
##
## aowlpy does not append a module key to symbols, so its output is the same
## whatever the module is called — `bin/aowlpy <any>.s.nif` matches byte-for-byte.

when defined(nimony):
  {.feature: "lenientnils".}

import nifcursors, nifstreams, programs
import emitpy
import jsffi

proc emitPy(src: string): string =
  setupProgramForTesting("", "main", ".s.nif")
  var e = PyEmitter(py: "", indent: 0)
  e.py.add preamble()
  var buf = parseFromBuffer(src, "main")
  var root = beginRead(buf)
  emitModule(e, root)
  endRead buf
  result = e.py

proc apyRun() =
  ## Runs as MODULE INIT (top-level) — see aowlts_web for why it must not be
  ## `{.exportc: "main".}`.
  let src = global("__apy_src").toStr
  let outp = emitPy(src)
  let g = global("globalThis")
  g.set("__apy_out", toJs(outp))

apyRun()
