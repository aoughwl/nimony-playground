// examples.js — starter programs. Each ships with a pre-compiled `.s.nif`
// (assets/snif/<snif>) that the in-browser interpreter runs today (Tier 1).
// The source shown matches what was compiled. When the frontend is ported to
// JS (Tier 2), edits recompile live and `snif` becomes just the seed.
//
// Note: nimony's `echo` lives in std/syncio (import it). Multi-argument `echo`
// (e.g. `echo i, " -> ", fib(i)`) works today, so the examples use it directly
// instead of building strings with `$`/`&`.
window.EXAMPLES = [
  {
    name: "Hello",
    snif: "hello.s.nif",
    source: `import std/syncio

echo "hello from nimony - running in your browser"
`
  },
  {
    name: "Fibonacci",
    snif: "fib.s.nif",
    source: `import std/syncio

proc fib(n: int): int =
  if n < 2: return n
  return fib(n-1) + fib(n-2)

for i in 0..10:
  echo i, " -> ", fib(i)
`
  },
  {
    name: "FizzBuzz",
    snif: "fizzbuzz.s.nif",
    source: `import std/syncio

for i in 1..20:
  if i mod 15 == 0: echo "FizzBuzz"
  elif i mod 3 == 0: echo "Fizz"
  elif i mod 5 == 0: echo "Buzz"
  else: echo i
`
  },
  {
    name: "Collatz",
    snif: "collatz.s.nif",
    source: `import std/syncio

proc steps(n0: int): int =
  var n = n0
  result = 0
  while n != 1:
    if n mod 2 == 0: n = n div 2
    else: n = 3*n + 1
    inc result

for n in 1..12:
  echo n, ": ", steps(n), " steps"
`
  },
  {
    name: "List sum",
    snif: "listsum.s.nif",
    source: `import std/syncio

var xs = @[3, 1, 4, 1, 5, 9, 2, 6]
var total = 0
for x in xs:
  total = total + x
echo "sum of ", xs.len, " numbers = ", total
`
  },
];
