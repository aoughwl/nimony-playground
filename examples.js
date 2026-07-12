// examples.js — the starter programs shown in the playground.
// `snif` is the filename of a pre-compiled .s.nif asset (Tier 1: runnable without
// an in-browser compiler). When the frontend is ported (Tier 2), any edited
// source compiles + runs live and `snif` becomes just the default seed.
window.EXAMPLES = [
  {
    name: "Hello",
    snif: "hello.s.nif",
    source: `proc main =
  echo "hello from nimony — running in your browser"

main()
`
  },
  {
    name: "Fibonacci",
    snif: "fib.s.nif",
    source: `proc fib(n: int): int =
  if n < 2: n
  else: fib(n-1) + fib(n-2)

for i in 0..10:
  echo i, " -> ", fib(i)
`
  },
  {
    name: "FizzBuzz",
    snif: "fizzbuzz.s.nif",
    source: `for i in 1..20:
  if i mod 15 == 0: echo "FizzBuzz"
  elif i mod 3 == 0: echo "Fizz"
  elif i mod 5 == 0: echo "Buzz"
  else: echo i
`
  },
  {
    name: "Collatz",
    snif: "collatz.s.nif",
    source: `proc steps(n0: int): int =
  var n = n0
  while n != 1:
    if n mod 2 == 0: n = n div 2
    else: n = 3*n + 1
    inc result

for n in 1..12:
  echo n, ": ", steps(n), " steps"
`
  },
];
