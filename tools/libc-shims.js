// libc symbols the nimony stdlib binds when nimNativeIo is NOT defined, and that
// nimony-web's runtime.js does not provide. Concatenated right after runtime.js
// (it reads _u8 / mem from there).
//
// strtod: std/parseutils' parseBiggestFloat slow path. Without it a rebuilt
// aowlsem.js failed every playground check that parses a float literal with
// "strtod is not defined" (measured 2026-10-09).
function strtod(p, endp){
  p = Number(p);
  let s = "";
  for(let i = p; _u8[i] !== 0 && s.length < 400; i++) s += String.fromCharCode(_u8[i]);
  const m = /^\s*([+-]?)(inf(inity)?|nan|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/i.exec(s);
  let v = 0, n = 0;
  if(m){
    n = m[0].length;
    const b = m[2].toLowerCase();
    v = b.startsWith("inf") ? Infinity : (b === "nan" ? NaN : parseFloat(m[2]));
    if(m[1] === "-") v = -v;
  }
  if(endp && Number(endp) !== 0) mem.setU32(Number(endp), p + n);
  return v;
}

// environ: the libc-free stdlib's getEnv walks `environ` (a NULL-terminated
// char** array) instead of calling getenv(3). The browser has no process
// environment, so it is an EMPTY one: a pointer to a single NULL entry, carved
// from the runtime's own heap. Without it every check died with
// "environ is not defined" (2026-10-09).
var environ = (function(){ const p = allocFixed(16); _zero(p, 16); return p; })();

// getenv / setenv / unsetenv: the rest of the environment family, against the
// same empty environment. getenv answers NULL (variable absent), which is what
// every AOWLSEM_* kill switch and trace check expects off a real machine too.
function getenv(name){
  // In a browser there is no environment: NULL. Under node (webtest/run_as*.js)
  // the real one is readable, which is what lets AOWLSEM_DBG_* traces run inside
  // the JS build — the only way to see why it binds differently from native.
  const env = (typeof process !== "undefined" && process.env) ? process.env : null;
  if(!env) return 0;
  let k = ""; for(let i = Number(name); _u8[i] !== 0; i++) k += String.fromCharCode(_u8[i]);
  const v = env[k];
  if(v === undefined) return 0;
  const p = allocFixed(v.length + 1);
  for(let i = 0; i < v.length; i++) _u8[p + i] = v.charCodeAt(i) & 0xff;
  _u8[p + v.length] = 0;
  return p;
}
function setenv(name, value, overwrite){ return 0; }
function unsetenv(name){ return 0; }
