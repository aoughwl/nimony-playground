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
