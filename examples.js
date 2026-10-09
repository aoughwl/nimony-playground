// examples.js — the default program the playground opens with.
//
// The preset picker was removed in favour of one decent-sized demo that shows
// procs, recursion, control flow and iteration — all of which compile and run
// in the browser sandbox (system + syncio). Edited freely from here.
window.PLAYGROUND_DEMO = `import std/syncio

# ── Welcome to the nimony playground ─────────────────
# The whole toolchain — parser, type-checker and interpreter — runs
# right here in your browser, no server. Edit anything and press Run
# (Ctrl+Enter). Errors show live as you type; the Symbols tab (top
# right) maps your procs and types — click one to jump to it.

proc fib(n: int): int =
  ## classic recursion
  if n < 2: return n
  return fib(n - 1) + fib(n - 2)

proc isPrime(n: int): bool =
  if n < 2: return false
  var d = 2
  while d * d <= n:
    if n mod d == 0: return false
    inc d
  return true

proc collatz(n0: int): int =
  ## steps to reach 1
  var n = n0
  result = 0
  while n != 1:
    if n mod 2 == 0: n = n div 2
    else: n = 3 * n + 1
    inc result

echo "Fibonacci:"
for i in 0 .. 10:
  echo "  fib(", i, ") = ", fib(i)

echo ""
echo "Primes under 40:"
for n in 2 .. 39:
  if isPrime(n): echo "  ", n

echo ""
echo "Collatz steps for 27: ", collatz(27)
`;

// The second file `scratch` opens with. The demo above shows the toolchain; this
// one shows the thing the toolchain is FOR — an interpreter that is still
// standing between your edits, so changing a program does not mean restarting
// it. Everything it describes happens in the existing UI: the Session button
// beside the Output tabs, the Run button, and the `gen` counter in the footer.
window.PLAYGROUND_LIVE_DEMO = `import std/syncio

# ── Change a program while it is running ─────────────────────────────
#
# Normally, changing code means restarting the program and losing
# everything it had in memory. Here it doesn't.
#
# 1. Press "Go live" (top right, beside Run). The Live tab opens under
#    the editor and runs this file once. STATE shows what the program
#    is holding:  hits = 2   seen = @[first, second]
#
# 2. Change "counted" to "noted" inside note() below. Don't press
#    anything. As soon as it type-checks, the new note() is swapped
#    into the running program: HISTORY says "edited note()", and STATE
#    has not moved. The code changed; the data survived.
#
# 3. In the prompt at the bottom of the Live tab, type
#        note "third"
#    and press Enter. Only that line runs (it is added to the end of
#    this file): hits becomes 3 and the message uses your new wording.
#
# 4. Under PROCS, press ▶ beside recap() to call it on its own.
#
# Stop throws the state away. Nothing else does.

var hits = 0
var seen: seq[string] = @[]

proc note(what: string) =
  inc hits
  seen.add what
  echo "  counted ", hits, ": ", what

proc recap() =
  echo "so far: ", hits, " item(s)"
  for s in seen: echo "  - ", s

echo "the program is running."
note "first"
note "second"
`;
