// Canonical JS runtime for the Leng JS backend: one ArrayBuffer as linear memory,
// plus the small set of C primitives the lowered code imports. The heap is Nim's
// OWN native allocator (`-d:nimNativeAlloc` — the ported `system/alloc.nim`),
// compiled to JS through lengjs like any other module; the runtime provides only
// `mmap`/`munmap` as the page primitives it sits on (Araq's boundary), so `alloc`/
// `dealloc`/`realloc` and their free-list reuse all run as real Nim code.
// Linear memory. The bump allocator has no GC, so large allocating loops / big
// output can exhaust a fixed arena. Rather than eagerly reserving a huge buffer
// on every page load, we start at 256 MiB and GROW ON DEMAND (in `mmap` below)
// up to a 1 GiB ceiling via a *resizable* ArrayBuffer — cheap startup, big
// headroom only when a program actually needs it. `_u8`/`_dv` are length-tracking
// views (no explicit length), so they follow the buffer across `.resize()`.
const _HEAP0 = 1 << 28;                          // 256 MiB initial
const _HEAPMAX = 1 << 30;                         // 1 GiB hard ceiling
function _mkHeap(){
  try {
    const b = new ArrayBuffer(_HEAP0, {maxByteLength: _HEAPMAX});
    if (b.resizable) return b;                    // modern engines: grow later
  } catch (e) { /* option bag unsupported */ }
  return new ArrayBuffer(_HEAPMAX);              // old engines: reserve max upfront
}
const _ab = (globalThis.__leng_ab || (globalThis.__leng_ab = _mkHeap()));
const _dv = (globalThis.__leng_dv || (globalThis.__leng_dv = new DataView(_ab)));
const _u8 = (globalThis.__leng_u8 || (globalThis.__leng_u8 = new Uint8Array(_ab)));
let _brk = 8;                                   // offset 0 reserved as nil

// `allocFixed(n)` is the codegen's own storage for value aggregates (a C-stack
// model: never freed), distinct from the Nim heap that sits on `mmap` below.
function allocFixed(n){ const p=(_brk+7)&~7; _brk=p+n; _u8.fill(0,p,p+n); return p; }

// Page primitives for `system/osalloc.nim`: `mmap` hands the Nim allocator a
// page-aligned, zero-filled region carved from the same buffer (MAP_FAILED = -1
// on exhaustion, which makes the allocator raise OutOfMem); `munmap` is a no-op
// (the bump arena does not reclaim whole pages — the Nim allocator still reuses
// cells within them). Signature matches posix `mmap(adr,len,prot,flags,fd,off)`.
const _PAGE = 4096;
function mmap(adr, len, prot, flags, fildes, off){
  len = Number(len);
  const p = (_brk + _PAGE - 1) & ~(_PAGE - 1);  // page-align
  const need = p + len;
  if (need > _ab.byteLength) {                   // grow the resizable heap on demand
    if (!_ab.resizable || need > _HEAPMAX) return -1;   // MAP_FAILED at the ceiling
    let want = _ab.byteLength;
    while (want < need) want *= 2;               // double until it fits
    if (want > _HEAPMAX) want = _HEAPMAX;
    _ab.resize(want);                            // views are length-tracking; they follow
  }
  _brk = need;
  _u8.fill(0, p, p + len);                       // MAP_ANONYMOUS: zero-filled
  return p;
}
function munmap(adr, len){ return 0; }

const mem = {
  setI8:(p,v)=>_dv.setInt8(p,v), i8:(p)=>_dv.getInt8(p),
  setU8:(p,v)=>_dv.setUint8(p,v), u8At:(p)=>_dv.getUint8(p),
  setI16:(p,v)=>_dv.setInt16(p,v,true), i16:(p)=>_dv.getInt16(p,true),
  setU16:(p,v)=>_dv.setUint16(p,v,true), u16:(p)=>_dv.getUint16(p,true),
  setI32:(p,v)=>_dv.setInt32(p,v,true), i32:(p)=>_dv.getInt32(p,true),
  setU32:(p,v)=>_dv.setUint32(p,v,true), u32:(p)=>_dv.getUint32(p,true),
  setI64:(p,v)=>_dv.setBigInt64(p,BigInt(v),true), i64n:(p)=>Number(_dv.getBigInt64(p,true)),
  setU64:(p,v)=>_dv.setBigUint64(p,BigInt(v),true), u64n:(p)=>Number(_dv.getBigUint64(p,true)),
  i64b:(p)=>_dv.getBigInt64(p,true), u64b:(p)=>_dv.getBigUint64(p,true),   // exact 64-bit reads (int64/uint64 -> BigInt)
  setF64:(p,v)=>_dv.setFloat64(p,v,true), f64:(p)=>_dv.getFloat64(p,true),
  copy:(d,s,n)=>_u8.copyWithin(d,s,s+n),
  bytes:(p,n)=>_u8.subarray(p,p+n),
  writeStr:(p,s)=>{ for(let i=0;i<s.length;i++) _u8[p+i]=s.charCodeAt(i); },
};

function memcpy(d,s,n){ _u8.copyWithin(Number(d),Number(s),Number(s)+Number(n)); return d; }
function memset(p,v,n){ _u8.fill(v&0xff,Number(p),Number(p)+Number(n)); return p; }
function strlen(p){ let n=0; while(_u8[Number(p)+n]!==0) n++; return n; }
function memcmp(a,b,n){ a=Number(a);b=Number(b);n=Number(n); for(let i=0;i<n;i++){ const d=_u8[a+i]-_u8[b+i]; if(d!==0) return d<0?-1:1; } return 0; }

// GCC/Clang 64-bit bit intrinsics `importc`'d by the stdlib's SWAR string
// comparison (system/stringimpl.nim: ctz/clz/bswap over a uint64 word). The
// codegen calls them by their C names on BigInt args; ctz/clz return an int.
// (C leaves ctz/clz of 0 undefined; the callers never pass 0, but returning 64
// is the well-defined choice.)
function __builtin_ctzll(x){ x=BigInt.asUintN(64,BigInt(x)); if(x===0n) return 64; let n=0; while((x&1n)===0n){ x>>=1n; n++; } return n; }
function __builtin_clzll(x){ x=BigInt.asUintN(64,BigInt(x)); if(x===0n) return 64; let n=0; for(let i=63n;i>=0n;i--){ if((x>>i)&1n) break; n++; } return n; }
function __builtin_bswap64(x){ x=BigInt.asUintN(64,BigInt(x)); let r=0n; for(let i=0;i<8;i++){ r=(r<<8n)|(x&0xffn); x>>=8n; } return BigInt.asUintN(64,r); }

// Function table: a proc pointer in linear memory is an integer index into
// `_fns` (WASM's model — JS can't call an integer). `_fnid(fn)` interns a proc to
// its stable index when it's taken as a value; the codegen emits `_fns[idx](args)`
// for an indirect call (a proc variable / closure field). Index 0 is nil.
const _fns = [null];
const _fnmap = new Map();
function _fnid(fn){ let i=_fnmap.get(fn); if(i===undefined){ i=_fns.length; _fns.push(fn); _fnmap.set(fn,i); } return i; }

// C11 memory-order constants (imported by the atomic ops; ignored by the shims).
const __ATOMIC_RELAXED = 0, __ATOMIC_CONSUME = 1, __ATOMIC_ACQUIRE = 2,
      __ATOMIC_RELEASE = 3, __ATOMIC_ACQ_REL = 4, __ATOMIC_SEQ_CST = 5;

// C11 `__atomic_*_n` are generic over the slot type; on this `--bits:32` target
// both ARC refcounts (`rc: int`) and pointers are 4-byte, so every atomic slot
// is 32-bit. JS is single-threaded, so each is a plain read/modify/write. Signed
// `i32` for the fetch ops (the refcount `subFetch < 0` last-ref test), unsigned
// `u32` for the load/store/exchange the allocator's free-lists use for pointers.
function __atomic_add_fetch(p,v,o){ const n=(mem.i32(p)+Number(v))|0; mem.setI32(p,n); return n; }
function __atomic_sub_fetch(p,v,o){ const n=(mem.i32(p)-Number(v))|0; mem.setI32(p,n); return n; }
function __atomic_load_n(p,o){ return mem.u32(p); }
function __atomic_store_n(p,v,o){ mem.setU32(p,Number(v)); }
function __atomic_exchange_n(p,v,o){ const old=mem.u32(p); mem.setU32(p,Number(v)); return old; }
function __atomic_compare_exchange_n(p,exp,des,weak,so,fo){
  // if *p == *exp: *p = des, return true; else *exp = *p, return false
  const cur=mem.u32(p);
  if(cur===mem.u32(exp)){ mem.setU32(p,Number(des)); return true; }
  mem.setU32(exp,cur); return false;
}

// libm functions `importc`'d by std/math. Most map straight onto JS `Math`; the
// few with libm-specific semantics are spelled out (`round` = half away from
// zero, unlike `Math.round`'s half-up; `fmod` = `%`; `copysign`/`signbit` honour
// the sign of -0). The float32 `…f` variants share the double routine (JS has
// only doubles; the extra precision is harmless). Uncommon libm entries not
// covered here (erf/gamma/frexp/fpclassify) are simply never referenced unless a
// program calls them.
const sqrt=Math.sqrt, cbrt=Math.cbrt, exp=Math.exp, sin=Math.sin, cos=Math.cos,
  tan=Math.tan, asin=Math.asin, acos=Math.acos, atan=Math.atan, atan2=Math.atan2,
  sinh=Math.sinh, cosh=Math.cosh, tanh=Math.tanh, asinh=Math.asinh,
  acosh=Math.acosh, atanh=Math.atanh, floor=Math.floor, ceil=Math.ceil,
  trunc=Math.trunc, hypot=Math.hypot, log=Math.log, log2=Math.log2,
  log10=Math.log10, pow=Math.pow;
function fmod(a,b){ return a % b; }
function round(x){ return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5); }
function copysign(x,y){ return (y < 0 || Object.is(y,-0)) ? -Math.abs(x) : Math.abs(x); }
function isnan(x){ return Number.isNaN(x); }
function signbit(x){ return x < 0 || Object.is(x,-0); }
const sqrtf=sqrt, cbrtf=cbrt, expf=exp, sinf=sin, cosf=cos, tanf=tan, asinf=asin,
  acosf=acos, atanf=atan, atan2f=atan2, sinhf=sinh, coshf=cosh, tanhf=tanh,
  asinhf=asinh, acoshf=acosh, atanhf=atanh, floorf=floor, ceilf=ceil,
  truncf=trunc, hypotf=hypot, logf=log, log2f=log2, log10f=log10, powf=pow,
  roundf=round, fmodf=fmod, copysignf=copysign;

// stdio — distinct stdout/stderr handles; the lowered code passes one as the
// `FILE*`, so route on identity (error/panic reporting goes to stderr).
const stdout = {}, stderr = {};
function _stream(f){ return f === stderr ? process.stderr : process.stdout; }
function fwrite(ptr,size,nmemb,f){ _stream(f).write(Buffer.from(_u8.subarray(ptr,ptr+size*nmemb))); return nmemb; }
function fprintf(f,fmt,...a){ let i=0; _stream(f).write(String(fmt).replace(/%ll[du]|%l[du]|%[dus]/g,()=>String(a[i++]))); }
function fputc(c,f){ _stream(f).write(Buffer.from([c&0xff])); return c; }
function nimFlushStdStreams(){}
function copyMem_0_sysvq0asl(d,s,n){ if(typeof d==='number'&&typeof s==='number') _u8.copyWithin(d,s,s+n); }
function exit(c){ process.exit(Number(c)||0); }

// ── JS-value interop bridge (std/jsffi) ──────────────────────────────────────
// Native Nim data lives in linear memory as byte offsets; a *JS* value (string,
// object, function, DOM node) can't. So Nim holds an integer HANDLE into this
// side table — the generalisation of the `_fns` proc-pointer table above. Slot 0
// is `undefined`/`null` (matches nil = offset 0), freed slots are recycled.
const _jsv = [undefined];
const _jsvFree = [];
function _jsNew(v){                                   // intern a JS value -> handle
  if (v === undefined || v === null) return 0;
  const i = _jsvFree.length ? _jsvFree.pop() : _jsv.length;
  _jsv[i] = v; return i;
}
function _jsRelease(h){ if (h > 0){ _jsv[h] = undefined; _jsvFree.push(h); } }
function _jsvDup(h){ return _jsNew(_jsv[h]); }        // a new slot to the same JS value
function _jsvLive(){ return _jsv.length - 1 - _jsvFree.length; }   // live slot count (leak tests)

// Strings cross the linear-memory boundary as UTF-8 bytes. `_strToJs` decodes a
// (ptr,len) slice of Nim string storage into a real JS string; the read-back is
// two calls (length, then copy) so no scratch region leaks — and since JS
// strings are immutable, both just encode the same handle (no cached state).
const _td = new TextDecoder(), _te = new TextEncoder();
// NB: `.slice` (a fresh non-resizable copy), not `.subarray` (a view) — since the
// heap is now a *resizable* ArrayBuffer, TextDecoder.decode() rejects views over
// it ("ArrayBuffer value must not be resizable").
function _strToJs(p, n){ return _jsNew(_td.decode(_u8.slice(Number(p), Number(p) + Number(n)))); }
function _jsStrLen(h){ return _te.encode(String(_jsv[h])).length; }
function _jsStrInto(h, dst){ _u8.set(_te.encode(String(_jsv[h])), Number(dst)); }

// JS `===` (value/identity), so two distinct handles to the same value compare
// equal — handle-integer equality would not.
function _jsStrictEq(aH, bH){ return _jsv[aH] === _jsv[bH] ? 1 : 0; }

// Number/bool bridges: on --bits:32 a Nim int is already a JS Number.
function _numToJs(x){ return _jsNew(Number(x)); }
function _jsToNum(h){ return _jsv[h]; }
function _boolToJs(x){ return _jsNew(!!x); }
function _jsToBool(h){ return _jsv[h] ? 1 : 0; }

// Global lookup + property/method access, all keyed by JS-string handles so the
// member name itself rides the same marshalling path (no C string constants).
function _jsGlobalH(nameH){ return _jsNew(globalThis[_jsv[nameH]]); }
function _jsGetProp(oH, nameH){ return _jsNew(_jsv[oH][_jsv[nameH]]); }
function _jsSetProp(oH, nameH, vH){ _jsv[oH][_jsv[nameH]] = _jsv[vH]; }
function _jsCall0(oH, nameH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]]()); }
function _jsCall1(oH, nameH, aH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]](_jsv[aH])); }
function _jsCall2(oH, nameH, aH, bH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]](_jsv[aH], _jsv[bH])); }
function _jsCall3(oH, nameH, aH, bH, cH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]](_jsv[aH], _jsv[bH], _jsv[cH])); }
function _jsNewObject(){ return _jsNew({}); }

// `new Ctor(...)` construction.
function _jsCtor0(ctorH){ return _jsNew(new (_jsv[ctorH])()); }
function _jsCtor1(ctorH, aH){ return _jsNew(new (_jsv[ctorH])(_jsv[aH])); }
// `new Ctor(...args)` for any arity: args is a JS array handle, spread via Reflect.
function _jsCtorN(ctorH, argsH){ return _jsNew(Reflect.construct(_jsv[ctorH], _jsv[argsH])); }

// JS arrays. An array is just another JS value in the table; `_jsArrGet` interns
// a *new* handle to the element (owned by the returned JsValue), and `push`/set
// hand the array a direct reference to the element value — so releasing the Nim
// handle slot afterwards never disturbs the array's own reference (JS GC keeps
// the value alive as long as the array does). Floats need no bridge of their
// own: on --bits:32 a Nim float is already a JS Number, so `toJs(float)` reuses
// `_numToJs` and `toFloat` reuses `_jsToNum`.
function _jsNewArray(){ return _jsNew([]); }
function _jsArrLen(h){ return _jsv[h].length; }
function _jsArrPush(h, vH){ _jsv[h].push(_jsv[vH]); }
function _jsArrGet(h, i){ return _jsNew(_jsv[h][Number(i)]); }
function _jsArrSet(h, i, vH){ _jsv[h][Number(i)] = _jsv[vH]; }

// Introspection: `typeof`, `in`, `instanceof`. A DOM binding branches on these
// constantly (a node's type, whether a property exists, an Array vs a NodeList).
function _jsTypeof(h){ return _jsNew(typeof _jsv[h]); }
function _jsHasProp(oH, nameH){ return (_jsv[nameH] in _jsv[oH]) ? 1 : 0; }
function _jsInstanceOf(vH, ctorH){ return (_jsv[vH] instanceof _jsv[ctorH]) ? 1 : 0; }

// `obj.name(...args)` for any argument count (beyond the fixed _jsCall0..3): the
// Nim side marshals the args into a JS array, we spread it via Function.apply.
function _jsApply(oH, nameH, argsH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]].apply(o, _jsv[argsH])); }

// Nim proc -> JS function (the reverse of the _fns call table): a Nim proc used
// as a value lowers to an integer _fns index, so wrap that in a JS closure. The
// closure marshals each incoming JS argument to a `JsValue` — which the backend
// represents as a one-field `{h: int32}` object, i.e. 4 bytes in linear memory
// with the handle at offset 0 — and passes that object's byte offset (the ABI a
// Nim `proc(ev: JsValue)` expects). The Nim callback borrows the argument, so we
// release the handle after it returns; an event object is only valid for the
// duration of dispatch, matching the DOM contract.
function _fnToJs0(idx){ return _jsNew(() => { _fns[idx](); }); }
function _fnToJs1(idx){
  return _jsNew((a) => {
    const h = _jsNew(a);
    const p = allocFixed(4); mem.setI32(p, h);   // a JsValue {h} object for the ABI
    _fns[idx](p);
    _jsRelease(h);
  });
}


let strlit_0_I6512003683063426779_exp6svnmi1 = allocFixed(35);

let strlit_0_I1932261347222220580_exp6svnmi1 = allocFixed(33);

let strlit_0_I566564739971293180_exp6svnmi1 = allocFixed(29);

let strlit_0_I2428626936449221430_exp6svnmi1 = allocFixed(27);

let strlit_0_I9343511476098221449_exp6svnmi1 = allocFixed(21);

let strlit_0_I5781759467107120979_exp6svnmi1 = allocFixed(29);

let strlit_0_I10295204845917104656_exp6svnmi1 = allocFixed(25);

let strlit_0_I230973632416858749_exp6svnmi1 = allocFixed(34);

let strlit_0_I12676927569015587920_exp6svnmi1 = allocFixed(29);

let strlit_0_I10537485768555316406_exp6svnmi1 = allocFixed(28);

let strlit_0_I2698326962503537505_exp6svnmi1 = allocFixed(31);

let strlit_0_I2536928392218801765_exp6svnmi1 = allocFixed(30);

let strlit_0_I1692953341429750685_exp6svnmi1 = allocFixed(27);

let strlit_0_I15286689157683959097_exp6svnmi1 = allocFixed(28);

let strlit_0_I2015790770678558173_exp6svnmi1 = allocFixed(26);

let strlit_0_I2266389890549986326_exp6svnmi1 = allocFixed(34);

let strlit_0_I13586503514632046678_exp6svnmi1 = allocFixed(24);

let strlit_0_I1598122192703047993_exp6svnmi1 = allocFixed(31);

let strlit_0_I3604264932930414489_exp6svnmi1 = allocFixed(31);

let strlit_0_I6007484234730703707_exp6svnmi1 = allocFixed(37);

let strlit_0_I10523454834011842863_exp6svnmi1 = allocFixed(29);

let strlit_0_I4192191418491144372_exp6svnmi1 = allocFixed(31);

let strlit_0_I6110464685516040961_exp6svnmi1 = allocFixed(32);

let strlit_0_I10788062515542880415_exp6svnmi1 = allocFixed(33);

let strlit_0_I1390819619547178243_exp6svnmi1 = allocFixed(35);

let strlit_0_I5067388147473329658_exp6svnmi1 = allocFixed(34);

let strlit_0_I3611050258457489801_exp6svnmi1 = allocFixed(31);

let strlit_0_I17283851935414668385_exp6svnmi1 = allocFixed(30);

let strlit_0_I7353961297463882775_exp6svnmi1 = allocFixed(31);

let strlit_0_I9338050989877851798_exp6svnmi1 = allocFixed(28);

let strlit_0_I9812626919684199076_exp6svnmi1 = allocFixed(24);

let strlit_0_I7239112280132897979_exp6svnmi1 = allocFixed(24);

let strlit_0_I1183140066353762900_exp6svnmi1 = allocFixed(30);

let strlit_0_I3814179386273276921_exp6svnmi1 = allocFixed(31);

let strlit_0_I1365890887990331020_exp6svnmi1 = allocFixed(23);

let strlit_0_I1664332866290125980_exp6svnmi1 = allocFixed(33);

let strlit_0_I16765148769446371680_exp6svnmi1 = allocFixed(24);

let strlit_0_I13164190227184651568_exp6svnmi1 = allocFixed(78);

let strlit_0_I2709910993141618740_exp6svnmi1 = allocFixed(46);

let strlit_0_I9398387956682808504_exp6svnmi1 = allocFixed(83);

let strlit_0_I11324978824816252305_exp6svnmi1 = allocFixed(84);

let strlit_0_I9963323525653825745_exp6svnmi1 = allocFixed(73);

let strlit_0_I3350641198213710095_exp6svnmi1 = allocFixed(72);

let strlit_0_I16892503660106187633_exp6svnmi1 = allocFixed(86);

let strlit_0_I11916983476094505958_exp6svnmi1 = allocFixed(64);

let strlit_0_I8335990275073537205_exp6svnmi1 = allocFixed(90);

let strlit_0_I2039210783325865199_exp6svnmi1 = allocFixed(70);

let strlit_0_I9801159583265365849_exp6svnmi1 = allocFixed(69);

let strlit_0_I6558478010088990510_exp6svnmi1 = allocFixed(84);

let strlit_0_I14532204288076119502_exp6svnmi1 = allocFixed(98);

let strlit_0_I15750996627617194403_exp6svnmi1 = allocFixed(31);

let strlit_0_I14694606176902936784_jsfc0lwq21 = allocFixed(104);

let strlit_0_I14872370265633446329_str7j0ifg = allocFixed(100);

let strlit_0_I6105018409752412263_webzywwor1 = allocFixed(28);

let strlit_0_I4645790987703279553_webzywwor1 = allocFixed(16);

let strlit_0_I15516388950515943933_webzywwor1 = allocFixed(17);

let strlit_0_I14478211161560354671_webzywwor1 = allocFixed(19);

let strlit_0_I5147724977109554671_webzywwor1 = allocFixed(16);

let strlit_0_I6373137695046429832_webzywwor1 = allocFixed(16);

let strlit_0_I13485403899737849153_webzywwor1 = allocFixed(17);

let strlit_0_I6336096988826643762_webzywwor1 = allocFixed(20);

let strlit_0_I10495286183715212852_webzywwor1 = allocFixed(16);

let strlit_0_I17194081841433683614_webzywwor1 = allocFixed(19);

let strlit_0_I1643616165736515820_webzywwor1 = allocFixed(16);

let strlit_0_I1594669814536249853_webzywwor1 = allocFixed(18);

let strlit_0_I10452665333506134667_webzywwor1 = allocFixed(19);

let strlit_0_I11472176434042843973_webzywwor1 = allocFixed(20);

let strlit_0_I6978980501808324049_webzywwor1 = allocFixed(21);

let strlit_0_I7204142019108744947_webzywwor1 = allocFixed(23);

let strlit_0_I18338797071087941219_webzywwor1 = allocFixed(20);

let strlit_0_I7115103054454119625_webzywwor1 = allocFixed(19);

let strlit_0_I5766285012476903774_webzywwor1 = allocFixed(23);

let strlit_0_I1123073466241064333_webzywwor1 = allocFixed(22);

let strlit_0_I16140219651591674227_webzywwor1 = allocFixed(23);

let strlit_0_I6357233917619117690_webzywwor1 = allocFixed(20);

let strlit_0_I7507345602561577771_webzywwor1 = allocFixed(27);

let strlit_0_I4223485871286820833_webzywwor1 = allocFixed(24);

let strlit_0_I2419004569819514924_webzywwor1 = allocFixed(16);

let strlit_0_I11240999720484037362_webzywwor1 = allocFixed(22);

let strlit_0_I17349635483251307736_webzywwor1 = allocFixed(20);

let strlit_0_I10077820878706880159_webzywwor1 = allocFixed(21);

let strlit_0_I16664880105326712979_webzywwor1 = allocFixed(22);

let strlit_0_I9990058196389500338_webzywwor1 = allocFixed(22);

let strlit_0_I2455841389866808686_fixeak1im1 = allocFixed(30);

let strlit_0_I16778981494557925217_fixeak1im1 = allocFixed(30);

let strlit_0_I9411494518201909963_fixeak1im1 = allocFixed(30);

let strlit_0_I11801016976563298038_fixeak1im1 = allocFixed(29);

let strlit_0_I18386017129978570811_fixeak1im1 = allocFixed(30);

let strlit_0_I10082110133848163204_fixeak1im1 = allocFixed(28);

let strlit_0_I9015225879227668123_fixeak1im1 = allocFixed(51);

let strlit_0_I14915461790222011400_fixeak1im1 = allocFixed(20);

let strlit_0_I10492289392165625619_fixeak1im1 = allocFixed(22);

let strlit_0_I2584438449918377368_fixeak1im1 = allocFixed(43);

let strlit_0_I1519414717112445373_fixeak1im1 = allocFixed(38);

let strlit_0_I15961986726969760528_fixeak1im1 = allocFixed(43);

let strlit_0_I2614181636077420746_fixeak1im1 = allocFixed(45);

let strlit_0_I14964485355411744523_fixeak1im1 = allocFixed(47);

let strlit_0_I10344845751395038586_fixeak1im1 = allocFixed(37);

let strlit_0_I10981268595210715146_fixeak1im1 = allocFixed(34);

let strlit_0_I10766215715090134889_fixeak1im1 = allocFixed(44);

let strlit_0_I7398711344762333748_fixeak1im1 = allocFixed(43);

let strlit_0_I13424873862977158440_fixeak1im1 = allocFixed(16);

let strlit_0_I11316302792861065249_fixeak1im1 = allocFixed(38);

let strlit_0_I14996553479182787230_fixeak1im1 = allocFixed(22);

let strlit_0_I16246072967864884300_fixeak1im1 = allocFixed(18);

let strlit_0_I13435722917833300375_fixeak1im1 = allocFixed(26);

let strlit_0_I2564216074254103176_fixeak1im1 = allocFixed(22);

let strlit_0_I8625455319723392933_fixeak1im1 = allocFixed(22);

let strlit_0_I14099350819119747234_fixeak1im1 = allocFixed(42);

let strlit_0_I11518128541944848614_fixeak1im1 = allocFixed(31);

let strlit_0_I4261256446345198406_fixeak1im1 = allocFixed(29);

let strlit_0_I10791520901386574205_fixeak1im1 = allocFixed(30);

let strlit_0_I12067509928535166814_fixeak1im1 = allocFixed(34);

let strlit_0_I8176046943660040380_fixeak1im1 = allocFixed(26);

let strlit_0_I1271536908756224135_fixeak1im1 = allocFixed(28);

let strlit_0_I953839753781071610_fixeak1im1 = allocFixed(36);

let strlit_0_I11923376507425688096_fixeak1im1 = allocFixed(40);

let strlit_0_I10131629090932128305_fixeak1im1 = allocFixed(30);

let strlit_0_I3118387172418653687_fixeak1im1 = allocFixed(29);

let strlit_0_I18331364155580600483_fixeak1im1 = allocFixed(27);

let strlit_0_I4711016545483820726_fixeak1im1 = allocFixed(20);

let strlit_0_I3390647262588430136_fixeak1im1 = allocFixed(28);

let strlit_0_I16524665832086204301_fixeak1im1 = allocFixed(45);

let strlit_0_I14997301237576242043_fixeak1im1 = allocFixed(31);

let strlit_0_I15917817268795199016_fixeak1im1 = allocFixed(38);

let strlit_0_I18179865674072288426_fixeak1im1 = allocFixed(42);

let strlit_0_I15830389122368428676_fixeak1im1 = allocFixed(31);

let strlit_0_I5348471251041807345_fixeak1im1 = allocFixed(39);

let strlit_0_I437387965556335341_fixeak1im1 = allocFixed(23);

let strlit_0_I4535891151395753622_fixeak1im1 = allocFixed(30);

let strlit_0_I1549749459204987071_fixeak1im1 = allocFixed(38);

let strlit_0_I8942659628978202412_fixeak1im1 = allocFixed(25);

let strlit_0_I16286580443920198575_fixeak1im1 = allocFixed(30);

let strlit_0_I9357512781724370368_fixeak1im1 = allocFixed(34);

let strlit_0_I7428794750700265195_fixeak1im1 = allocFixed(39);

let strlit_0_I18016193771835146099_fixeak1im1 = allocFixed(38);

let strlit_0_I9405065548570263465_fixeak1im1 = allocFixed(36);

let strlit_0_I18122894641777448348_fixeak1im1 = allocFixed(26);

let strlit_0_I2342421160380909407_fixeak1im1 = allocFixed(32);

let strlit_0_I5774869565030773885_fixeak1im1 = allocFixed(37);

let strlit_0_I14131790745264837101_sysvq0asl = allocFixed(102);

let strlit_0_I11927585966806674622_sysvq0asl = allocFixed(102);

let strlit_0_I15539159382304113184_sysvq0asl = allocFixed(39);

let strlit_0_I14281474217946372742_sysvq0asl = allocFixed(47);

let strlit_0_I16690852185662743073_sysvq0asl = allocFixed(28);

let strlit_0_I10604297744791418982_sysvq0asl = allocFixed(30);

let strlit_0_I11614695157650328859_sysvq0asl = allocFixed(33);

let strlit_0_I16845119709590674135_sysvq0asl = allocFixed(19);

let NegTen_0_sysvq0asl = allocFixed(80);

let fsLookupTable_0_sysvq0asl = allocFixed(256);

let strlit_0_I8572766038233537570_syn1lfpjv = allocFixed(16);

let strlit_0_I3372626016653902757_syn1lfpjv = allocFixed(17);

mem.setI32(strlit_0_I6512003683063426779_exp6svnmi1, 23);

mem.setI32((strlit_0_I6512003683063426779_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I6512003683063426779_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I6512003683063426779_exp6svnmi1 + 12), "assignment-in-condition");

mem.setI32(strlit_0_I1932261347222220580_exp6svnmi1, 21);

mem.setI32((strlit_0_I1932261347222220580_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1932261347222220580_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1932261347222220580_exp6svnmi1 + 12), "comparison-in-binding");

mem.setI32(strlit_0_I566564739971293180_exp6svnmi1, 17);

mem.setI32((strlit_0_I566564739971293180_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I566564739971293180_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I566564739971293180_exp6svnmi1 + 12), "walrus-in-binding");

mem.setI32(strlit_0_I2428626936449221430_exp6svnmi1, 15);

mem.setI32((strlit_0_I2428626936449221430_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2428626936449221430_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2428626936449221430_exp6svnmi1 + 12), "c-block-comment");

mem.setI32(strlit_0_I9343511476098221449_exp6svnmi1, 9);

mem.setI32((strlit_0_I9343511476098221449_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I9343511476098221449_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I9343511476098221449_exp6svnmi1 + 12), "stray-end");

mem.setI32(strlit_0_I5781759467107120979_exp6svnmi1, 17);

mem.setI32((strlit_0_I5781759467107120979_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I5781759467107120979_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I5781759467107120979_exp6svnmi1 + 12), "mut-not-a-keyword");

mem.setI32(strlit_0_I10295204845917104656_exp6svnmi1, 13);

mem.setI32((strlit_0_I10295204845917104656_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I10295204845917104656_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I10295204845917104656_exp6svnmi1 + 12), "go-var-notype");

mem.setI32(strlit_0_I230973632416858749_exp6svnmi1, 22);

mem.setI32((strlit_0_I230973632416858749_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I230973632416858749_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I230973632416858749_exp6svnmi1 + 12), "angle-bracket-generics");

mem.setI32(strlit_0_I12676927569015587920_exp6svnmi1, 17);

mem.setI32((strlit_0_I12676927569015587920_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I12676927569015587920_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I12676927569015587920_exp6svnmi1 + 12), "arrow-return-type");

mem.setI32(strlit_0_I10537485768555316406_exp6svnmi1, 16);

mem.setI32((strlit_0_I10537485768555316406_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I10537485768555316406_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I10537485768555316406_exp6svnmi1 + 12), "else-if-not-elif");

mem.setI32(strlit_0_I2698326962503537505_exp6svnmi1, 19);

mem.setI32((strlit_0_I2698326962503537505_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2698326962503537505_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2698326962503537505_exp6svnmi1 + 12), "redundant-semicolon");

mem.setI32(strlit_0_I2536928392218801765_exp6svnmi1, 18);

mem.setI32((strlit_0_I2536928392218801765_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2536928392218801765_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2536928392218801765_exp6svnmi1 + 12), "mismatched-bracket");

mem.setI32(strlit_0_I1692953341429750685_exp6svnmi1, 15);

mem.setI32((strlit_0_I1692953341429750685_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1692953341429750685_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1692953341429750685_exp6svnmi1 + 12), "unmatched-close");

mem.setI32(strlit_0_I15286689157683959097_exp6svnmi1, 16);

mem.setI32((strlit_0_I15286689157683959097_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I15286689157683959097_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I15286689157683959097_exp6svnmi1 + 12), "unclosed-bracket");

mem.setI32(strlit_0_I2015790770678558173_exp6svnmi1, 14);

mem.setI32((strlit_0_I2015790770678558173_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2015790770678558173_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2015790770678558173_exp6svnmi1 + 12), "expected-colon");

mem.setI32(strlit_0_I2266389890549986326_exp6svnmi1, 22);

mem.setI32((strlit_0_I2266389890549986326_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2266389890549986326_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2266389890549986326_exp6svnmi1 + 12), "missing-routine-equals");

mem.setI32(strlit_0_I13586503514632046678_exp6svnmi1, 12);

mem.setI32((strlit_0_I13586503514632046678_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I13586503514632046678_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I13586503514632046678_exp6svnmi1 + 12), "unknown-byte");

mem.setI32(strlit_0_I1598122192703047993_exp6svnmi1, 19);

mem.setI32((strlit_0_I1598122192703047993_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1598122192703047993_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1598122192703047993_exp6svnmi1 + 12), "expression-expected");

mem.setI32(strlit_0_I3604264932930414489_exp6svnmi1, 19);

mem.setI32((strlit_0_I3604264932930414489_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I3604264932930414489_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I3604264932930414489_exp6svnmi1 + 12), "identifier-expected");

mem.setI32(strlit_0_I6007484234730703707_exp6svnmi1, 25);

mem.setI32((strlit_0_I6007484234730703707_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I6007484234730703707_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I6007484234730703707_exp6svnmi1 + 12), "invalid-character-literal");

mem.setI32(strlit_0_I10523454834011842863_exp6svnmi1, 17);

mem.setI32((strlit_0_I10523454834011842863_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I10523454834011842863_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I10523454834011842863_exp6svnmi1 + 12), "unterminated-char");

mem.setI32(strlit_0_I4192191418491144372_exp6svnmi1, 19);

mem.setI32((strlit_0_I4192191418491144372_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I4192191418491144372_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I4192191418491144372_exp6svnmi1 + 12), "unterminated-string");

mem.setI32(strlit_0_I6110464685516040961_exp6svnmi1, 20);

mem.setI32((strlit_0_I6110464685516040961_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I6110464685516040961_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I6110464685516040961_exp6svnmi1 + 12), "unterminated-comment");

mem.setI32(strlit_0_I10788062515542880415_exp6svnmi1, 21);

mem.setI32((strlit_0_I10788062515542880415_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I10788062515542880415_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I10788062515542880415_exp6svnmi1 + 12), "unterminated-backtick");

mem.setI32(strlit_0_I1390819619547178243_exp6svnmi1, 23);

mem.setI32((strlit_0_I1390819619547178243_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1390819619547178243_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1390819619547178243_exp6svnmi1 + 12), "invalid-escape-sequence");

mem.setI32(strlit_0_I5067388147473329658_exp6svnmi1, 22);

mem.setI32((strlit_0_I5067388147473329658_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I5067388147473329658_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I5067388147473329658_exp6svnmi1 + 12), "invalid-unicode-escape");

mem.setI32(strlit_0_I3611050258457489801_exp6svnmi1, 19);

mem.setI32((strlit_0_I3611050258457489801_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I3611050258457489801_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I3611050258457489801_exp6svnmi1 + 12), "invalid-int-literal");

mem.setI32(strlit_0_I17283851935414668385_exp6svnmi1, 18);

mem.setI32((strlit_0_I17283851935414668385_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I17283851935414668385_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I17283851935414668385_exp6svnmi1 + 12), "invalid-identifier");

mem.setI32(strlit_0_I7353961297463882775_exp6svnmi1, 19);

mem.setI32((strlit_0_I7353961297463882775_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I7353961297463882775_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I7353961297463882775_exp6svnmi1 + 12), "number-out-of-range");

mem.setI32(strlit_0_I9338050989877851798_exp6svnmi1, 16);

mem.setI32((strlit_0_I9338050989877851798_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I9338050989877851798_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I9338050989877851798_exp6svnmi1 + 12), "tabs-not-allowed");

mem.setI32(strlit_0_I9812626919684199076_exp6svnmi1, 12);

mem.setI32((strlit_0_I9812626919684199076_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I9812626919684199076_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I9812626919684199076_exp6svnmi1 + 12), "mixed-indent");

mem.setI32(strlit_0_I7239112280132897979_exp6svnmi1, 12);

mem.setI32((strlit_0_I7239112280132897979_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I7239112280132897979_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I7239112280132897979_exp6svnmi1 + 12), "indent-width");

mem.setI32(strlit_0_I1183140066353762900_exp6svnmi1, 18);

mem.setI32((strlit_0_I1183140066353762900_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1183140066353762900_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1183140066353762900_exp6svnmi1 + 12), "indent-consistency");

mem.setI32(strlit_0_I3814179386273276921_exp6svnmi1, 19);

mem.setI32((strlit_0_I3814179386273276921_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I3814179386273276921_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I3814179386273276921_exp6svnmi1 + 12), "trailing-whitespace");

mem.setI32(strlit_0_I1365890887990331020_exp6svnmi1, 11);

mem.setI32((strlit_0_I1365890887990331020_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1365890887990331020_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1365890887990331020_exp6svnmi1 + 12), "line-ending");

mem.setI32(strlit_0_I1664332866290125980_exp6svnmi1, 21);

mem.setI32((strlit_0_I1664332866290125980_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I1664332866290125980_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I1664332866290125980_exp6svnmi1 + 12), "missing-final-newline");

mem.setI32(strlit_0_I16765148769446371680_exp6svnmi1, 12);

mem.setI32((strlit_0_I16765148769446371680_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I16765148769446371680_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I16765148769446371680_exp6svnmi1 + 12), "bom-rejected");

mem.setI32(strlit_0_I13164190227184651568_exp6svnmi1, 66);

mem.setI32((strlit_0_I13164190227184651568_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I13164190227184651568_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I13164190227184651568_exp6svnmi1 + 12), "add the closing backtick (`` ` ``) right after the identifier name");

mem.setI32(strlit_0_I2709910993141618740_exp6svnmi1, 34);

mem.setI32((strlit_0_I2709910993141618740_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2709910993141618740_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2709910993141618740_exp6svnmi1 + 12), "remove or replace the illegal byte");

mem.setI32(strlit_0_I9398387956682808504_exp6svnmi1, 71);

mem.setI32((strlit_0_I9398387956682808504_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I9398387956682808504_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I9398387956682808504_exp6svnmi1 + 12), "identifiers start with a letter or '_' and can't contain that character");

mem.setI32(strlit_0_I11324978824816252305_exp6svnmi1, 72);

mem.setI32((strlit_0_I11324978824816252305_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I11324978824816252305_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I11324978824816252305_exp6svnmi1 + 12), "use a valid escape, e.g. \\n \\t \\r \\\\ \\\" or \\xNN (or a raw string r\"...\")");

mem.setI32(strlit_0_I9963323525653825745_exp6svnmi1, 61);

mem.setI32((strlit_0_I9963323525653825745_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I9963323525653825745_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I9963323525653825745_exp6svnmi1 + 12), "write a unicode escape as \\uXXXX (four hex digits) or \\u{...}");

mem.setI32(strlit_0_I3350641198213710095_exp6svnmi1, 60);

mem.setI32((strlit_0_I3350641198213710095_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I3350641198213710095_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I3350641198213710095_exp6svnmi1 + 12), "a char literal holds exactly one character, e.g. 'a' or '\\n'");

mem.setI32(strlit_0_I16892503660106187633_exp6svnmi1, 74);

mem.setI32((strlit_0_I16892503660106187633_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I16892503660106187633_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I16892503660106187633_exp6svnmi1 + 12), "the literal exceeds its type's range - use a wider type or a smaller value");

mem.setI32(strlit_0_I11916983476094505958_exp6svnmi1, 52);

mem.setI32((strlit_0_I11916983476094505958_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I11916983476094505958_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I11916983476094505958_exp6svnmi1 + 12), "a name is required here - provide a valid identifier");

mem.setI32(strlit_0_I8335990275073537205_exp6svnmi1, 78);

mem.setI32((strlit_0_I8335990275073537205_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I8335990275073537205_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I8335990275073537205_exp6svnmi1 + 12), "a value is missing - supply an expression (or delete the stray operator/comma)");

mem.setI32(strlit_0_I2039210783325865199_exp6svnmi1, 58);

mem.setI32((strlit_0_I2039210783325865199_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I2039210783325865199_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I2039210783325865199_exp6svnmi1 + 12), "indent with only spaces or only tabs on a line, never both");

mem.setI32(strlit_0_I9801159583265365849_exp6svnmi1, 57);

mem.setI32((strlit_0_I9801159583265365849_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I9801159583265365849_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I9801159583265365849_exp6svnmi1 + 12), "indent by a consistent multiple (e.g. 2 spaces per level)");

mem.setI32(strlit_0_I6558478010088990510_exp6svnmi1, 72);

mem.setI32((strlit_0_I6558478010088990510_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I6558478010088990510_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I6558478010088990510_exp6svnmi1 + 12), "match the file's indent step - keep the same spaces-per-level throughout");

mem.setI32(strlit_0_I14532204288076119502_exp6svnmi1, 86);

mem.setI32((strlit_0_I14532204288076119502_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I14532204288076119502_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I14532204288076119502_exp6svnmi1 + 12), "../nimony/lib/std/system/seqimpl.nim(167, 41): i < s.len and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I15750996627617194403_exp6svnmi1, 19);

mem.setI32((strlit_0_I15750996627617194403_exp6svnmi1 + 4), 0);

mem.setI32((strlit_0_I15750996627617194403_exp6svnmi1 + 8), 0);

mem.writeStr((strlit_0_I15750996627617194403_exp6svnmi1 + 12), "leave uninitialized");

mem.setI32(strlit_0_I14694606176902936784_jsfc0lwq21, 92);

mem.setI32((strlit_0_I14694606176902936784_jsfc0lwq21 + 4), 0);

mem.setI32((strlit_0_I14694606176902936784_jsfc0lwq21 + 8), 0);

mem.writeStr((strlit_0_I14694606176902936784_jsfc0lwq21 + 12), "../nimony/lib/std/system/openarrays.nim(10, 49): 0 <= idx and idx < x.len [AssertionDefect]\n");

mem.setI32(strlit_0_I14872370265633446329_str7j0ifg, 88);

mem.setI32((strlit_0_I14872370265633446329_str7j0ifg + 4), 0);

mem.setI32((strlit_0_I14872370265633446329_str7j0ifg + 8), 0);

mem.writeStr((strlit_0_I14872370265633446329_str7j0ifg + 12), "../nimony/lib/std/system/openarrays.nim(12, 59): 0 <= i and i < x.len [AssertionDefect]\n");

mem.setI32(strlit_0_I6105018409752412263_webzywwor1, 16);

mem.setI32((strlit_0_I6105018409752412263_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6105018409752412263_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6105018409752412263_webzywwor1 + 12), "0123456789abcdef");

mem.setI32(strlit_0_I4645790987703279553_webzywwor1, 4);

mem.setI32((strlit_0_I4645790987703279553_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4645790987703279553_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4645790987703279553_webzywwor1 + 12), "\\u00");

mem.setI32(strlit_0_I15516388950515943933_webzywwor1, 5);

mem.setI32((strlit_0_I15516388950515943933_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15516388950515943933_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15516388950515943933_webzywwor1 + 12), "error");

mem.setI32(strlit_0_I14478211161560354671_webzywwor1, 7);

mem.setI32((strlit_0_I14478211161560354671_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I14478211161560354671_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I14478211161560354671_webzywwor1 + 12), "warning");

mem.setI32(strlit_0_I5147724977109554671_webzywwor1, 4);

mem.setI32((strlit_0_I5147724977109554671_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5147724977109554671_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5147724977109554671_webzywwor1 + 12), "hint");

mem.setI32(strlit_0_I6373137695046429832_webzywwor1, 4);

mem.setI32((strlit_0_I6373137695046429832_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6373137695046429832_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6373137695046429832_webzywwor1 + 12), "JSON");

mem.setI32(strlit_0_I13485403899737849153_webzywwor1, 5);

mem.setI32((strlit_0_I13485403899737849153_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I13485403899737849153_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I13485403899737849153_webzywwor1 + 12), "parse");

mem.setI32(strlit_0_I6336096988826643762_webzywwor1, 8);

mem.setI32((strlit_0_I6336096988826643762_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6336096988826643762_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6336096988826643762_webzywwor1 + 12), "severity");

mem.setI32(strlit_0_I10495286183715212852_webzywwor1, 4);

mem.setI32((strlit_0_I10495286183715212852_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10495286183715212852_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10495286183715212852_webzywwor1 + 12), "code");

mem.setI32(strlit_0_I17194081841433683614_webzywwor1, 7);

mem.setI32((strlit_0_I17194081841433683614_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I17194081841433683614_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I17194081841433683614_webzywwor1 + 12), "message");

mem.setI32(strlit_0_I1643616165736515820_webzywwor1, 4);

mem.setI32((strlit_0_I1643616165736515820_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1643616165736515820_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1643616165736515820_webzywwor1 + 12), "line");

mem.setI32(strlit_0_I1594669814536249853_webzywwor1, 6);

mem.setI32((strlit_0_I1594669814536249853_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1594669814536249853_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1594669814536249853_webzywwor1 + 12), "endCol");

mem.setI32(strlit_0_I10452665333506134667_webzywwor1, 7);

mem.setI32((strlit_0_I10452665333506134667_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10452665333506134667_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10452665333506134667_webzywwor1 + 12), "related");

mem.setI32(strlit_0_I11472176434042843973_webzywwor1, 8);

mem.setI32((strlit_0_I11472176434042843973_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11472176434042843973_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11472176434042843973_webzywwor1 + 12), "{\"code\":");

mem.setI32(strlit_0_I6978980501808324049_webzywwor1, 9);

mem.setI32((strlit_0_I6978980501808324049_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6978980501808324049_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6978980501808324049_webzywwor1 + 12), ",\"title\":");

mem.setI32(strlit_0_I7204142019108744947_webzywwor1, 11);

mem.setI32((strlit_0_I7204142019108744947_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I7204142019108744947_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I7204142019108744947_webzywwor1 + 12), ",\"message\":");

mem.setI32(strlit_0_I18338797071087941219_webzywwor1, 8);

mem.setI32((strlit_0_I18338797071087941219_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I18338797071087941219_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I18338797071087941219_webzywwor1 + 12), ",\"line\":");

mem.setI32(strlit_0_I7115103054454119625_webzywwor1, 7);

mem.setI32((strlit_0_I7115103054454119625_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I7115103054454119625_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I7115103054454119625_webzywwor1 + 12), ",\"col\":");

mem.setI32(strlit_0_I5766285012476903774_webzywwor1, 11);

mem.setI32((strlit_0_I5766285012476903774_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5766285012476903774_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5766285012476903774_webzywwor1 + 12), ",\"endLine\":");

mem.setI32(strlit_0_I1123073466241064333_webzywwor1, 10);

mem.setI32((strlit_0_I1123073466241064333_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1123073466241064333_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1123073466241064333_webzywwor1 + 12), ",\"endCol\":");

mem.setI32(strlit_0_I16140219651591674227_webzywwor1, 11);

mem.setI32((strlit_0_I16140219651591674227_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16140219651591674227_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16140219651591674227_webzywwor1 + 12), ",\"newText\":");

mem.setI32(strlit_0_I6357233917619117690_webzywwor1, 8);

mem.setI32((strlit_0_I6357233917619117690_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6357233917619117690_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6357233917619117690_webzywwor1 + 12), ",\"kind\":");

mem.setI32(strlit_0_I7507345602561577771_webzywwor1, 15);

mem.setI32((strlit_0_I7507345602561577771_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I7507345602561577771_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I7507345602561577771_webzywwor1 + 12), ",\"isPreferred\":");

mem.setI32(strlit_0_I4223485871286820833_webzywwor1, 12);

mem.setI32((strlit_0_I4223485871286820833_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4223485871286820833_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4223485871286820833_webzywwor1 + 12), ",\"severity\":");

mem.setI32(strlit_0_I2419004569819514924_webzywwor1, 4);

mem.setI32((strlit_0_I2419004569819514924_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I2419004569819514924_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I2419004569819514924_webzywwor1 + 12), "auto");

mem.setI32(strlit_0_I11240999720484037362_webzywwor1, 10);

mem.setI32((strlit_0_I11240999720484037362_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11240999720484037362_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11240999720484037362_webzywwor1 + 12), "suggestion");

mem.setI32(strlit_0_I17349635483251307736_webzywwor1, 8);

mem.setI32((strlit_0_I17349635483251307736_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I17349635483251307736_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I17349635483251307736_webzywwor1 + 12), "__su_src");

mem.setI32(strlit_0_I10077820878706880159_webzywwor1, 9);

mem.setI32((strlit_0_I10077820878706880159_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10077820878706880159_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10077820878706880159_webzywwor1 + 12), "__su_diag");

mem.setI32(strlit_0_I16664880105326712979_webzywwor1, 10);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16664880105326712979_webzywwor1 + 12), "globalThis");

mem.setI32(strlit_0_I9990058196389500338_webzywwor1, 10);

mem.setI32((strlit_0_I9990058196389500338_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9990058196389500338_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9990058196389500338_webzywwor1 + 12), "__su_fixes");

mem.setI32(strlit_0_I2455841389866808686_fixeak1im1, 18);

mem.setI32((strlit_0_I2455841389866808686_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I2455841389866808686_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I2455841389866808686_fixeak1im1 + 12), "change '=' to '=='");

mem.setI32(strlit_0_I16778981494557925217_fixeak1im1, 18);

mem.setI32((strlit_0_I16778981494557925217_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I16778981494557925217_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I16778981494557925217_fixeak1im1 + 12), "did you mean '=='?");

mem.setI32(strlit_0_I9411494518201909963_fixeak1im1, 18);

mem.setI32((strlit_0_I9411494518201909963_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I9411494518201909963_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I9411494518201909963_fixeak1im1 + 12), "change '==' to '='");

mem.setI32(strlit_0_I11801016976563298038_fixeak1im1, 17);

mem.setI32((strlit_0_I11801016976563298038_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I11801016976563298038_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I11801016976563298038_fixeak1im1 + 12), "did you mean '='?");

mem.setI32(strlit_0_I18386017129978570811_fixeak1im1, 18);

mem.setI32((strlit_0_I18386017129978570811_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I18386017129978570811_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I18386017129978570811_fixeak1im1 + 12), "change ':=' to '='");

mem.setI32(strlit_0_I10082110133848163204_fixeak1im1, 16);

mem.setI32((strlit_0_I10082110133848163204_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10082110133848163204_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10082110133848163204_fixeak1im1 + 12), "remove the 'end'");

mem.setI32(strlit_0_I9015225879227668123_fixeak1im1, 39);

mem.setI32((strlit_0_I9015225879227668123_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I9015225879227668123_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I9015225879227668123_fixeak1im1 + 12), "remove the 'end' (Nim uses indentation)");

mem.setI32(strlit_0_I14915461790222011400_fixeak1im1, 8);

mem.setI32((strlit_0_I14915461790222011400_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I14915461790222011400_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I14915461790222011400_fixeak1im1 + 12), "change '");

mem.setI32(strlit_0_I10492289392165625619_fixeak1im1, 10);

mem.setI32((strlit_0_I10492289392165625619_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10492289392165625619_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10492289392165625619_fixeak1im1 + 12), "' to 'var'");

mem.setI32(strlit_0_I2584438449918377368_fixeak1im1, 31);

mem.setI32((strlit_0_I2584438449918377368_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I2584438449918377368_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I2584438449918377368_fixeak1im1 + 12), "use 'var' for a mutable binding");

mem.setI32(strlit_0_I1519414717112445373_fixeak1im1, 26);

mem.setI32((strlit_0_I1519414717112445373_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I1519414717112445373_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I1519414717112445373_fixeak1im1 + 12), "insert ':' before the type");

mem.setI32(strlit_0_I15961986726969760528_fixeak1im1, 31);

mem.setI32((strlit_0_I15961986726969760528_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I15961986726969760528_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I15961986726969760528_fixeak1im1 + 12), "a typed binding is 'name: Type'");

mem.setI32(strlit_0_I2614181636077420746_fixeak1im1, 33);

mem.setI32((strlit_0_I2614181636077420746_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I2614181636077420746_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I2614181636077420746_fixeak1im1 + 12), "change '/* ... */' to '#[ ... ]#'");

mem.setI32(strlit_0_I14964485355411744523_fixeak1im1, 35);

mem.setI32((strlit_0_I14964485355411744523_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I14964485355411744523_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I14964485355411744523_fixeak1im1 + 12), "use '#[ ... ]#' for a block comment");

mem.setI32(strlit_0_I10344845751395038586_fixeak1im1, 25);

mem.setI32((strlit_0_I10344845751395038586_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10344845751395038586_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10344845751395038586_fixeak1im1 + 12), "change '<...>' to '[...]'");

mem.setI32(strlit_0_I10981268595210715146_fixeak1im1, 22);

mem.setI32((strlit_0_I10981268595210715146_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10981268595210715146_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10981268595210715146_fixeak1im1 + 12), "use '[T]' for generics");

mem.setI32(strlit_0_I10766215715090134889_fixeak1im1, 32);

mem.setI32((strlit_0_I10766215715090134889_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10766215715090134889_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10766215715090134889_fixeak1im1 + 12), "change '->' to a ':' return type");

mem.setI32(strlit_0_I7398711344762333748_fixeak1im1, 31);

mem.setI32((strlit_0_I7398711344762333748_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I7398711344762333748_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I7398711344762333748_fixeak1im1 + 12), "write the return type after ':'");

mem.setI32(strlit_0_I13424873862977158440_fixeak1im1, 4);

mem.setI32((strlit_0_I13424873862977158440_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I13424873862977158440_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I13424873862977158440_fixeak1im1 + 12), "elif");

mem.setI32(strlit_0_I11316302792861065249_fixeak1im1, 26);

mem.setI32((strlit_0_I11316302792861065249_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I11316302792861065249_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I11316302792861065249_fixeak1im1 + 12), "change 'else if' to 'elif'");

mem.setI32(strlit_0_I14996553479182787230_fixeak1im1, 10);

mem.setI32((strlit_0_I14996553479182787230_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I14996553479182787230_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I14996553479182787230_fixeak1im1 + 12), "use 'elif'");

mem.setI32(strlit_0_I16246072967864884300_fixeak1im1, 6);

mem.setI32((strlit_0_I16246072967864884300_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I16246072967864884300_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I16246072967864884300_fixeak1im1 + 12), "' to '");

mem.setI32(strlit_0_I13435722917833300375_fixeak1im1, 14);

mem.setI32((strlit_0_I13435722917833300375_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I13435722917833300375_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I13435722917833300375_fixeak1im1 + 12), "change it to '");

mem.setI32(strlit_0_I2564216074254103176_fixeak1im1, 10);

mem.setI32((strlit_0_I2564216074254103176_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I2564216074254103176_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I2564216074254103176_fixeak1im1 + 12), "insert ':'");

mem.setI32(strlit_0_I8625455319723392933_fixeak1im1, 10);

mem.setI32((strlit_0_I8625455319723392933_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I8625455319723392933_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I8625455319723392933_fixeak1im1 + 12), "insert '='");

mem.setI32(strlit_0_I14099350819119747234_fixeak1im1, 30);

mem.setI32((strlit_0_I14099350819119747234_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I14099350819119747234_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I14099350819119747234_fixeak1im1 + 12), "insert '=' after the signature");

mem.setI32(strlit_0_I11518128541944848614_fixeak1im1, 19);

mem.setI32((strlit_0_I11518128541944848614_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I11518128541944848614_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I11518128541944848614_fixeak1im1 + 12), "insert closing '\\''");

mem.setI32(strlit_0_I4261256446345198406_fixeak1im1, 17);

mem.setI32((strlit_0_I4261256446345198406_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I4261256446345198406_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I4261256446345198406_fixeak1im1 + 12), "add the closing '");

mem.setI32(strlit_0_I10791520901386574205_fixeak1im1, 18);

mem.setI32((strlit_0_I10791520901386574205_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10791520901386574205_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10791520901386574205_fixeak1im1 + 12), "remove unmatched '");

mem.setI32(strlit_0_I12067509928535166814_fixeak1im1, 22);

mem.setI32((strlit_0_I12067509928535166814_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I12067509928535166814_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I12067509928535166814_fixeak1im1 + 12), "remove the unmatched '");

mem.setI32(strlit_0_I8176046943660040380_fixeak1im1, 14);

mem.setI32((strlit_0_I8176046943660040380_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I8176046943660040380_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I8176046943660040380_fixeak1im1 + 12), "add matching '");

mem.setI32(strlit_0_I1271536908756224135_fixeak1im1, 16);

mem.setI32((strlit_0_I1271536908756224135_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I1271536908756224135_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I1271536908756224135_fixeak1im1 + 12), "add a matching '");

mem.setI32(strlit_0_I953839753781071610_fixeak1im1, 24);

mem.setI32((strlit_0_I953839753781071610_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I953839753781071610_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I953839753781071610_fixeak1im1 + 12), "replace tab with a space");

mem.setI32(strlit_0_I11923376507425688096_fixeak1im1, 28);

mem.setI32((strlit_0_I11923376507425688096_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I11923376507425688096_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I11923376507425688096_fixeak1im1 + 12), "use a space instead of a tab");

mem.setI32(strlit_0_I10131629090932128305_fixeak1im1, 18);

mem.setI32((strlit_0_I10131629090932128305_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I10131629090932128305_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I10131629090932128305_fixeak1im1 + 12), "insert closing '\"'");

mem.setI32(strlit_0_I3118387172418653687_fixeak1im1, 17);

mem.setI32((strlit_0_I3118387172418653687_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I3118387172418653687_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I3118387172418653687_fixeak1im1 + 12), "add the closing \"");

mem.setI32(strlit_0_I18331364155580600483_fixeak1im1, 15);

mem.setI32((strlit_0_I18331364155580600483_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I18331364155580600483_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I18331364155580600483_fixeak1im1 + 12), "lowercase the '");

mem.setI32(strlit_0_I4711016545483820726_fixeak1im1, 8);

mem.setI32((strlit_0_I4711016545483820726_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I4711016545483820726_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I4711016545483820726_fixeak1im1 + 12), "' prefix");

mem.setI32(strlit_0_I3390647262588430136_fixeak1im1, 16);

mem.setI32((strlit_0_I3390647262588430136_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I3390647262588430136_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I3390647262588430136_fixeak1im1 + 12), "use lowercase '0");

mem.setI32(strlit_0_I16524665832086204301_fixeak1im1, 33);

mem.setI32((strlit_0_I16524665832086204301_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I16524665832086204301_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I16524665832086204301_fixeak1im1 + 12), "close the block comment with ']#'");

mem.setI32(strlit_0_I14997301237576242043_fixeak1im1, 19);

mem.setI32((strlit_0_I14997301237576242043_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I14997301237576242043_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I14997301237576242043_fixeak1im1 + 12), "add a matching ']#'");

mem.setI32(strlit_0_I15917817268795199016_fixeak1im1, 26);

mem.setI32((strlit_0_I15917817268795199016_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I15917817268795199016_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I15917817268795199016_fixeak1im1 + 12), "remove trailing whitespace");

mem.setI32(strlit_0_I18179865674072288426_fixeak1im1, 30);

mem.setI32((strlit_0_I18179865674072288426_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I18179865674072288426_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I18179865674072288426_fixeak1im1 + 12), "delete the trailing whitespace");

mem.setI32(strlit_0_I15830389122368428676_fixeak1im1, 19);

mem.setI32((strlit_0_I15830389122368428676_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I15830389122368428676_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I15830389122368428676_fixeak1im1 + 12), "add a final newline");

mem.setI32(strlit_0_I5348471251041807345_fixeak1im1, 27);

mem.setI32((strlit_0_I5348471251041807345_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I5348471251041807345_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I5348471251041807345_fixeak1im1 + 12), "end the file with a newline");

mem.setI32(strlit_0_I437387965556335341_fixeak1im1, 11);

mem.setI32((strlit_0_I437387965556335341_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I437387965556335341_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I437387965556335341_fixeak1im1 + 12), "expected LF");

mem.setI32(strlit_0_I4535891151395753622_fixeak1im1, 18);

mem.setI32((strlit_0_I4535891151395753622_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I4535891151395753622_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I4535891151395753622_fixeak1im1 + 12), "convert CRLF to LF");

mem.setI32(strlit_0_I1549749459204987071_fixeak1im1, 26);

mem.setI32((strlit_0_I1549749459204987071_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I1549749459204987071_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I1549749459204987071_fixeak1im1 + 12), "use a plain LF line ending");

mem.setI32(strlit_0_I8942659628978202412_fixeak1im1, 13);

mem.setI32((strlit_0_I8942659628978202412_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I8942659628978202412_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I8942659628978202412_fixeak1im1 + 12), "expected CRLF");

mem.setI32(strlit_0_I16286580443920198575_fixeak1im1, 18);

mem.setI32((strlit_0_I16286580443920198575_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I16286580443920198575_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I16286580443920198575_fixeak1im1 + 12), "convert LF to CRLF");

mem.setI32(strlit_0_I9357512781724370368_fixeak1im1, 22);

mem.setI32((strlit_0_I9357512781724370368_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I9357512781724370368_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I9357512781724370368_fixeak1im1 + 12), "use a CRLF line ending");

mem.setI32(strlit_0_I7428794750700265195_fixeak1im1, 27);

mem.setI32((strlit_0_I7428794750700265195_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I7428794750700265195_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I7428794750700265195_fixeak1im1 + 12), "strip the leading UTF-8 BOM");

mem.setI32(strlit_0_I18016193771835146099_fixeak1im1, 26);

mem.setI32((strlit_0_I18016193771835146099_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I18016193771835146099_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I18016193771835146099_fixeak1im1 + 12), "remove the byte-order mark");

mem.setI32(strlit_0_I9405065548570263465_fixeak1im1, 24);

mem.setI32((strlit_0_I9405065548570263465_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I9405065548570263465_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I9405065548570263465_fixeak1im1 + 12), "remove the redundant ';'");

mem.setI32(strlit_0_I18122894641777448348_fixeak1im1, 14);

mem.setI32((strlit_0_I18122894641777448348_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I18122894641777448348_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I18122894641777448348_fixeak1im1 + 12), "remove the ';'");

mem.setI32(strlit_0_I2342421160380909407_fixeak1im1, 20);

mem.setI32((strlit_0_I2342421160380909407_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I2342421160380909407_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I2342421160380909407_fixeak1im1 + 12), "change the opening '");

mem.setI32(strlit_0_I5774869565030773885_fixeak1im1, 25);

mem.setI32((strlit_0_I5774869565030773885_fixeak1im1 + 4), 0);

mem.setI32((strlit_0_I5774869565030773885_fixeak1im1 + 8), 0);

mem.writeStr((strlit_0_I5774869565030773885_fixeak1im1 + 12), "or change the opener to '");

mem.setI32(strlit_0_I14131790745264837101_sysvq0asl, 90);

mem.setI32((strlit_0_I14131790745264837101_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I14131790745264837101_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I14131790745264837101_sysvq0asl + 12), "../nimony/lib/std/system/stringimpl.nim(403, 37): i < len(s) and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I11927585966806674622_sysvq0asl, 90);

mem.setI32((strlit_0_I11927585966806674622_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I11927585966806674622_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I11927585966806674622_sysvq0asl + 12), "../nimony/lib/std/system/stringimpl.nim(407, 45): i < len(s) and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I15539159382304113184_sysvq0asl, 27);

mem.setI32((strlit_0_I15539159382304113184_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I15539159382304113184_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I15539159382304113184_sysvq0asl + 12), "invalid object conversion: ");

mem.setI32(strlit_0_I14281474217946372742_sysvq0asl, 35);

mem.setI32((strlit_0_I14281474217946372742_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I14281474217946372742_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I14281474217946372742_sysvq0asl + 12), "cannot dispatch; dispatcher is nil\n");

mem.setI32(strlit_0_I16690852185662743073_sysvq0asl, 16);

mem.setI32((strlit_0_I16690852185662743073_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I16690852185662743073_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I16690852185662743073_sysvq0asl + 12), "could not load: ");

mem.setI32(strlit_0_I10604297744791418982_sysvq0asl, 18);

mem.setI32((strlit_0_I10604297744791418982_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I10604297744791418982_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I10604297744791418982_sysvq0asl + 12), "could not import: ");

mem.setI32(strlit_0_I11614695157650328859_sysvq0asl, 21);

mem.setI32((strlit_0_I11614695157650328859_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I11614695157650328859_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I11614695157650328859_sysvq0asl + 12), "index out of bounds: ");

mem.setI32(strlit_0_I16845119709590674135_sysvq0asl, 7);

mem.setI32((strlit_0_I16845119709590674135_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I16845119709590674135_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I16845119709590674135_sysvq0asl + 12), " notin ");

mem.copy(NegTen_0_sysvq0asl, (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3157250);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 8), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3222786);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 16), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3288322);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 24), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3353858);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 32), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3419394);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 40), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3484930);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 48), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3550466);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 56), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3616002);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 64), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3681538);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 72), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3747074);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.setI8(fsLookupTable_0_sysvq0asl, -1);

mem.setI8((fsLookupTable_0_sysvq0asl + 1), 0);

mem.setI8((fsLookupTable_0_sysvq0asl + 2), 1);

mem.setI8((fsLookupTable_0_sysvq0asl + 3), 1);

mem.setI8((fsLookupTable_0_sysvq0asl + 4), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 5), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 6), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 7), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 8), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 9), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 10), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 11), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 12), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 13), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 14), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 15), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 16), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 17), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 18), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 19), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 20), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 21), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 22), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 23), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 24), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 25), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 26), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 27), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 28), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 29), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 30), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 31), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 32), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 33), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 34), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 35), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 36), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 37), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 38), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 39), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 40), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 41), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 42), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 43), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 44), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 45), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 46), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 47), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 48), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 49), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 50), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 51), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 52), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 53), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 54), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 55), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 56), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 57), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 58), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 59), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 60), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 61), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 62), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 63), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 64), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 65), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 66), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 67), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 68), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 69), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 70), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 71), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 72), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 73), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 74), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 75), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 76), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 77), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 78), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 79), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 80), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 81), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 82), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 83), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 84), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 85), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 86), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 87), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 88), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 89), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 90), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 91), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 92), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 93), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 94), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 95), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 96), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 97), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 98), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 99), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 100), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 101), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 102), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 103), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 104), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 105), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 106), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 107), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 108), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 109), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 110), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 111), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 112), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 113), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 114), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 115), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 116), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 117), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 118), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 119), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 120), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 121), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 122), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 123), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 124), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 125), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 126), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 127), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 128), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 129), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 130), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 131), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 132), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 133), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 134), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 135), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 136), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 137), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 138), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 139), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 140), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 141), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 142), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 143), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 144), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 145), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 146), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 147), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 148), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 149), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 150), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 151), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 152), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 153), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 154), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 155), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 156), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 157), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 158), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 159), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 160), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 161), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 162), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 163), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 164), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 165), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 166), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 167), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 168), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 169), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 170), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 171), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 172), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 173), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 174), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 175), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 176), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 177), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 178), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 179), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 180), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 181), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 182), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 183), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 184), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 185), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 186), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 187), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 188), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 189), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 190), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 191), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 192), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 193), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 194), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 195), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 196), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 197), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 198), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 199), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 200), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 201), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 202), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 203), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 204), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 205), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 206), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 207), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 208), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 209), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 210), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 211), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 212), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 213), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 214), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 215), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 216), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 217), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 218), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 219), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 220), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 221), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 222), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 223), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 224), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 225), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 226), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 227), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 228), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 229), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 230), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 231), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 232), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 233), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 234), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 235), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 236), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 237), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 238), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 239), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 240), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 241), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 242), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 243), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 244), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 245), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 246), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 247), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 248), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 249), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 250), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 251), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 252), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 253), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 254), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 255), 7);

mem.setI32(strlit_0_I8572766038233537570_syn1lfpjv, 4);

mem.setI32((strlit_0_I8572766038233537570_syn1lfpjv + 4), 0);

mem.setI32((strlit_0_I8572766038233537570_syn1lfpjv + 8), 0);

mem.writeStr((strlit_0_I8572766038233537570_syn1lfpjv + 12), "true");

mem.setI32(strlit_0_I3372626016653902757_syn1lfpjv, 5);

mem.setI32((strlit_0_I3372626016653902757_syn1lfpjv + 4), 0);

mem.setI32((strlit_0_I3372626016653902757_syn1lfpjv + 8), 0);

mem.writeStr((strlit_0_I3372626016653902757_syn1lfpjv + 12), "false");
// generated by lengc (js backend) from party5a2l1.c.nif

function inc_0_Iloplki_party5a2l1(x_10, y_3) {
  mem.setI32(x_10, ((mem.i32(x_10) + y_3) | 0));
}

let X60QiniGuard_0_party5a2l1 = allocFixed(1);

function X60Qini_0_party5a2l1() {
  if (mem.u8At(X60QiniGuard_0_party5a2l1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_party5a2l1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_assy765wm();
}
// generated by lengc (js backend) from exp6svnmi1.c.nif

function suggestionFor_0_exp6svnmi1(code_4) {
  X60Qsc_19: {
    X60Qsc_20: {
      X60Qsc_11: {
        X60Qsc_10: {
          X60Qsc_9: {
            X60Qsc_8: {
              X60Qsc_7: {
                X60Qsc_6: {
                  X60Qsc_5: {
                    X60Qsc_4: {
                      X60Qsc_3: {
                        X60Qsc_2: {
                          X60Qsc_1: {
                            X60Qsc_0: {
                              var result_5 = allocFixed(8);
                              nimStrWasMoved(result_5);
                              var X60Qx_1 = allocFixed(8);
                              nimStrWasMoved(X60Qx_1);
                              var X60Qtc_12 = nimStrAtLe_0_sysvq0asl(code_4, 2, 112);
                              if (X60Qtc_12) {
                                var X60Qtc_13 = nimStrAtLe_0_sysvq0asl(code_4, 2, 101);
                                if (X60Qtc_13) {
                                  var X60Qtc_14 = nimStrAtLe_0_sysvq0asl(code_4, 1, 100);
                                  if (X60Qtc_14) {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1701079550);
                                      mem.setU32((_o + 4), strlit_0_I3604264932930414489_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_7;
                                    }
                                  } else {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1684957694);
                                      mem.setU32((_o + 4), strlit_0_I7239112280132897979_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_10;
                                    } else if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1684957694);
                                      mem.setU32((_o + 4), strlit_0_I1183140066353762900_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_11;
                                    }
                                  }
                                } else {
                                  var X60Qtc_15 = nimStrAtLe_0_sysvq0asl(code_4, 0, 110);
                                  if (X60Qtc_15) {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1836412670);
                                      mem.setU32((_o + 4), strlit_0_I7353961297463882775_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_6;
                                    } else if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1886938622);
                                      mem.setU32((_o + 4), strlit_0_I1598122192703047993_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_8;
                                    }
                                  } else {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1802401278);
                                      mem.setU32((_o + 4), strlit_0_I13586503514632046678_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_1;
                                    }
                                  }
                                }
                              } else {
                                var X60Qtc_16 = nimStrAtLe_0_sysvq0asl(code_4, 8, 100);
                                if (X60Qtc_16) {
                                  var X60Qtc_17 = nimStrAtLe_0_sysvq0asl(code_4, 0, 105);
                                  if (X60Qtc_17) {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1986947582);
                                      mem.setU32((_o + 4), strlit_0_I6007484234730703707_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_5;
                                    }
                                  } else {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1953396222);
                                      mem.setU32((_o + 4), strlit_0_I10788062515542880415_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_0;
                                    } else if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 2020175358);
                                      mem.setU32((_o + 4), strlit_0_I9812626919684199076_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_9;
                                    }
                                  }
                                } else {
                                  var X60Qtc_18 = nimStrAtLe_0_sysvq0asl(code_4, 8, 105);
                                  if (X60Qtc_18) {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1986947582);
                                      mem.setU32((_o + 4), strlit_0_I17283851935414668385_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_2;
                                    } else if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1986947582);
                                      mem.setU32((_o + 4), strlit_0_I1390819619547178243_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_3;
                                    }
                                  } else {
                                    if (equalStrings_0_sysvq0asl(code_4, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1986947582);
                                      mem.setU32((_o + 4), strlit_0_I5067388147473329658_exp6svnmi1);
                                      return _o;
                                    })())) {
                                      break X60Qsc_4;
                                    }
                                  }
                                }
                              }
                              break X60Qsc_20;
                            }
                            nimStrDestroy(X60Qx_1);
                            mem.copy(X60Qx_1, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1684300286);
                              mem.setU32((_o + 4), strlit_0_I13164190227184651568_exp6svnmi1);
                              return _o;
                            })(), 8);
                            break X60Qsc_19;
                          }
                          nimStrDestroy(X60Qx_1);
                          mem.copy(X60Qx_1, (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1835365118);
                            mem.setU32((_o + 4), strlit_0_I2709910993141618740_exp6svnmi1);
                            return _o;
                          })(), 8);
                          break X60Qsc_19;
                        }
                        nimStrDestroy(X60Qx_1);
                        mem.copy(X60Qx_1, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1701079550);
                          mem.setU32((_o + 4), strlit_0_I9398387956682808504_exp6svnmi1);
                          return _o;
                        })(), 8);
                        break X60Qsc_19;
                      }
                      nimStrDestroy(X60Qx_1);
                      mem.copy(X60Qx_1, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1702065662);
                        mem.setU32((_o + 4), strlit_0_I11324978824816252305_exp6svnmi1);
                        return _o;
                      })(), 8);
                      break X60Qsc_19;
                    }
                    nimStrDestroy(X60Qx_1);
                    mem.copy(X60Qx_1, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1769109502);
                      mem.setU32((_o + 4), strlit_0_I9963323525653825745_exp6svnmi1);
                      return _o;
                    })(), 8);
                    break X60Qsc_19;
                  }
                  nimStrDestroy(X60Qx_1);
                  mem.copy(X60Qx_1, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1663066622);
                    mem.setU32((_o + 4), strlit_0_I3350641198213710095_exp6svnmi1);
                    return _o;
                  })(), 8);
                  break X60Qsc_19;
                }
                nimStrDestroy(X60Qx_1);
                mem.copy(X60Qx_1, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1701344510);
                  mem.setU32((_o + 4), strlit_0_I16892503660106187633_exp6svnmi1);
                  return _o;
                })(), 8);
                break X60Qsc_19;
              }
              nimStrDestroy(X60Qx_1);
              mem.copy(X60Qx_1, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1847615998);
                mem.setU32((_o + 4), strlit_0_I11916983476094505958_exp6svnmi1);
                return _o;
              })(), 8);
              break X60Qsc_19;
            }
            nimStrDestroy(X60Qx_1);
            mem.copy(X60Qx_1, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1981833726);
              mem.setU32((_o + 4), strlit_0_I8335990275073537205_exp6svnmi1);
              return _o;
            })(), 8);
            break X60Qsc_19;
          }
          nimStrDestroy(X60Qx_1);
          mem.copy(X60Qx_1, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1684957694);
            mem.setU32((_o + 4), strlit_0_I2039210783325865199_exp6svnmi1);
            return _o;
          })(), 8);
          break X60Qsc_19;
        }
        nimStrDestroy(X60Qx_1);
        mem.copy(X60Qx_1, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1684957694);
          mem.setU32((_o + 4), strlit_0_I9801159583265365849_exp6svnmi1);
          return _o;
        })(), 8);
        break X60Qsc_19;
      }
      nimStrDestroy(X60Qx_1);
      mem.copy(X60Qx_1, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1952542206);
        mem.setU32((_o + 4), strlit_0_I6558478010088990510_exp6svnmi1);
        return _o;
      })(), 8);
      break X60Qsc_19;
    }
    nimStrDestroy(X60Qx_1);
    mem.copy(X60Qx_1, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  }
  nimStrDestroy(result_5);
  mem.copy(result_5, X60Qx_1, 8);
  nimStrWasMoved(X60Qx_1);
  nimStrDestroy(X60Qx_1);
  return result_5;
  nimStrDestroy(X60Qx_1);
  return result_5;
}

function inc_1_I6wjjge_exp6svnmi1(x_1) {
  mem.setI32(x_1, ((mem.i32(x_1) + 1) | 0));
}

let X60QiniGuard_0_exp6svnmi1 = allocFixed(1);

function X60Qini_0_exp6svnmi1() {
  if (mem.u8At(X60QiniGuard_0_exp6svnmi1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_exp6svnmi1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from jsfc0lwq21.c.nif

function eQdestroy_0_jsfc0lwq21(x_2) {
  _jsRelease(mem.i32(x_2));
}

function isNil_0_jsfc0lwq21(v_3) {
  let result_2;
  result_2 = (mem.i32(v_3) === 0);
  return result_2;
}

function toInt_0_jsfc0lwq21(v_4) {
  let result_5;
  let X60Qx_5 = _jsToNum(mem.i32(v_4));
  result_5 = X60Qx_5;
  return result_5;
}

function toJs_3_jsfc0lwq21(s_0) {
  let result_10 = allocFixed(4);
  let t_0 = allocFixed(8);
  mem.copy(t_0, nimStrDup(s_0), 8);
  eQdestroy_0_jsfc0lwq21(result_10);
  let X60Qx_10 = toCString_0_sysvq0asl(t_0);
  let X60Qx_11 = len_4_sysvq0asl(t_0);
  let X60Qx_12 = _strToJs(X60Qx_10, X60Qx_11);
  mem.copy(result_10, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_12);
    return _o;
  })(), 4);
  nimStrDestroy(t_0);
  return result_10;
  nimStrDestroy(t_0);
  return result_10;
}

function toStr_0_jsfc0lwq21(v_7) {
  let result_11 = allocFixed(8);
  nimStrWasMoved(result_11);
  let n_1 = _jsStrLen(mem.i32(v_7));
  if ((n_1 <= 0)) {
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })();
  }
  nimStrDestroy(result_11);
  let X60Qx_13 = allocFixed(8);
  mem.copy(X60Qx_13, newString_0_sysvq0asl(n_1), 8);
  mem.copy(result_11, X60Qx_13, 8);
  let X60Qx_14 = toCString_0_sysvq0asl(result_11);
  _jsStrInto(mem.i32(v_7), X60Qx_14);
  return result_11;
}

function len_0_jsfc0lwq21(arr_0) {
  let result_15;
  let X60Qx_18 = _jsArrLen(mem.i32(arr_0));
  result_15 = X60Qx_18;
  return result_15;
}

function getQ_0_jsfc0lwq21(arr_2, i_2) {
  let result_16 = allocFixed(4);
  eQdestroy_0_jsfc0lwq21(result_16);
  let X60Qx_19 = _jsArrGet(mem.i32(arr_2), i_2);
  mem.copy(result_16, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_19);
    return _o;
  })(), 4);
  return result_16;
}

function global_0_jsfc0lwq21(name_8) {
  let result_19 = allocFixed(4);
  let n_2 = allocFixed(4);
  mem.copy(n_2, toJs_3_jsfc0lwq21(name_8), 4);
  eQdestroy_0_jsfc0lwq21(result_19);
  let X60Qx_22 = _jsGlobalH(mem.i32(n_2));
  mem.copy(result_19, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_22);
    return _o;
  })(), 4);
  eQdestroy_0_jsfc0lwq21(n_2);
  return result_19;
  eQdestroy_0_jsfc0lwq21(n_2);
  return result_19;
}

function get_0_jsfc0lwq21(obj_8, name_9) {
  let result_20 = allocFixed(4);
  let n_3 = allocFixed(4);
  mem.copy(n_3, toJs_3_jsfc0lwq21(name_9), 4);
  eQdestroy_0_jsfc0lwq21(result_20);
  let X60Qx_23 = _jsGetProp(mem.i32(obj_8), mem.i32(n_3));
  mem.copy(result_20, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_23);
    return _o;
  })(), 4);
  eQdestroy_0_jsfc0lwq21(n_3);
  return result_20;
  eQdestroy_0_jsfc0lwq21(n_3);
  return result_20;
}

function set_0_jsfc0lwq21(obj_9, name_10, val_3) {
  let n_4 = allocFixed(4);
  mem.copy(n_4, toJs_3_jsfc0lwq21(name_10), 4);
  _jsSetProp(mem.i32(obj_9), mem.i32(n_4), mem.i32(val_3));
  eQdestroy_0_jsfc0lwq21(n_4);
}

function call_1_jsfc0lwq21(obj_11, name_12, a_6) {
  let result_22 = allocFixed(4);
  let n_6 = allocFixed(4);
  mem.copy(n_6, toJs_3_jsfc0lwq21(name_12), 4);
  eQdestroy_0_jsfc0lwq21(result_22);
  let X60Qx_25 = _jsCall1(mem.i32(obj_11), mem.i32(n_6), mem.i32(a_6));
  mem.copy(result_22, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_25);
    return _o;
  })(), 4);
  eQdestroy_0_jsfc0lwq21(n_6);
  return result_22;
  eQdestroy_0_jsfc0lwq21(n_6);
  return result_22;
}

function hasProp_0_jsfc0lwq21(obj_14, name_15) {
  let result_29;
  let n_9 = allocFixed(4);
  mem.copy(n_9, toJs_3_jsfc0lwq21(name_15), 4);
  let X60Qx_34 = _jsHasProp(mem.i32(obj_14), mem.i32(n_9));
  result_29 = X60Qx_34;
  eQdestroy_0_jsfc0lwq21(n_9);
  return result_29;
  eQdestroy_0_jsfc0lwq21(n_9);
  return result_29;
}

let X60QiniGuard_0_jsfc0lwq21 = allocFixed(1);

function X60Qini_0_jsfc0lwq21() {
  if (mem.u8At(X60QiniGuard_0_jsfc0lwq21)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_jsfc0lwq21, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from str7j0ifg.c.nif

function dollarQ_1_str7j0ifg(x_2) {
  let result_13 = allocFixed(8);
  nimStrWasMoved(result_13);
  nimStrDestroy(result_13);
  let X60Qx_53 = allocFixed(8);
  mem.copy(X60Qx_53, newString_0_sysvq0asl(1), 8);
  mem.copy(result_13, X60Qx_53, 8);
  putQ_9_sysvq0asl(result_13, 0, x_2);
  return result_13;
}

function find_0_str7j0ifg(s_27, sub_0, start_1, last_0) {
  forStmtLabel_0: {
    var result_31;
    result_31 = -1;
    var X60Qx_10;
    if ((last_0 < 0)) {
      var X60Qx_154 = high_4_sysvq0asl(s_27);
      X60Qx_10 = X60Qx_154;
    } else {
      X60Qx_10 = last_0;
    }
    var last_10 = X60Qx_10;
    {
      whileStmtLabel_1: {
        var X60Qlf_58 = start_1;
        var X60Qlf_59 = last_10;
        var X60Qlf_60 = allocFixed(4);
        mem.setI32(X60Qlf_60, X60Qlf_58);
        {
          while ((mem.i32(X60Qlf_60) <= X60Qlf_59)) {
            {
              var X60Qx_155 = getQ_9_sysvq0asl(s_27, mem.i32(X60Qlf_60));
              if ((X60Qx_155 === sub_0)) {
                return mem.i32(X60Qlf_60);
              }
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_60);
          }
        }
      }
    }
  }
  return result_31;
}

function initSkipTable_0_str7j0ifg(a_2, sub_1) {
  forStmtLabel_2: {
    forStmtLabel_0: {
      var m_0 = len_4_sysvq0asl(sub_1);
      {
        whileStmtLabel_1: {
          var X60Qlf_64 = (0 & 255);
          var X60Qlf_65 = (255 & 255);
          var X60Qlf_66 = allocFixed(4);
          mem.setI32(X60Qlf_66, X60Qlf_64);
          {
            while ((mem.i32(X60Qlf_66) <= X60Qlf_65)) {
              {
                var X60Qx_158 = allocFixed(8);
                mem.copy(X60Qx_158, toOpenArray_0_I4wbsml_str7j0ifg(a_2), 8);
                putQ_10_Izxzxmw_str7j0ifg(X60Qx_158, mem.i32(X60Qlf_66), m_0);
              }
              inc_1_I6wjjge_exp6svnmi1(X60Qlf_66);
            }
          }
        }
      }
    }
    {
      whileStmtLabel_3: {
        var X60Qlf_67 = 0;
        var X60Qlf_68 = ((m_0 - 1) | 0);
        var X60Qlf_69 = allocFixed(4);
        mem.setI32(X60Qlf_69, X60Qlf_67);
        {
          while ((mem.i32(X60Qlf_69) < X60Qlf_68)) {
            {
              var X60Qx_159 = getQ_9_sysvq0asl(sub_1, mem.i32(X60Qlf_69));
              var X60Qx_160 = nimUcheckB(X60Qx_159, 255);
              mem.setI32((a_2 + (X60Qx_160 * 4)), ((((m_0 - 1) | 0) - mem.i32(X60Qlf_69)) | 0));
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_69);
          }
        }
      }
    }
  }
}

function initSkipTable_1_str7j0ifg(sub_2) {
  let result_33 = allocFixed(1024);
  initSkipTable_0_str7j0ifg(result_33, sub_2);
  return result_33;
}

function find_2_str7j0ifg(a_3, s_29, sub_3, start_3, last_2) {
  whileStmtLabel_0: {
    var result_34;
    var X60Qx_12;
    if ((last_2 < 0)) {
      var X60Qx_161 = high_4_sysvq0asl(s_29);
      X60Qx_12 = X60Qx_161;
    } else {
      X60Qx_12 = last_2;
    }
    var last_12 = X60Qx_12;
    var X60Qx_162 = len_4_sysvq0asl(sub_3);
    var subLast_0 = ((X60Qx_162 - 1) | 0);
    if ((subLast_0 === -1)) {
      return start_3;
    }
    result_34 = -1;
    var skip_0 = allocFixed(4);
    mem.setI32(skip_0, start_3);
    {
      while ((subLast_0 <= ((last_12 - mem.i32(skip_0)) | 0))) {
        whileStmtLabel_1: {
          var i_17 = allocFixed(4);
          mem.setI32(i_17, subLast_0);
          {
            while (true) {
              var X60Qx_163 = getQ_9_sysvq0asl(s_29, ((mem.i32(skip_0) + mem.i32(i_17)) | 0));
              var X60Qx_164 = getQ_9_sysvq0asl(sub_3, mem.i32(i_17));
              if ((X60Qx_163 === X60Qx_164)) {
                if ((mem.i32(i_17) === 0)) {
                  return mem.i32(skip_0);
                }
                dec_1_I0nzoz91_fixeak1im1(i_17);
              } else {
                break;
              }
            }
          }
        }
        var X60Qx_165 = getQ_9_sysvq0asl(s_29, ((mem.i32(skip_0) + subLast_0) | 0));
        var X60Qx_166 = nimUcheckB(X60Qx_165, 255);
        inc_0_Iloplki_party5a2l1(skip_0, mem.i32((a_3 + (X60Qx_166 * 4))));
      }
    }
  }
  return result_34;
}

function find_3_str7j0ifg(s_30, sub_4, start_4, last_3) {
  let result_35;
  let X60Qx_167 = len_4_sysvq0asl(s_30);
  let X60Qx_168 = len_4_sysvq0asl(sub_4);
  if ((((X60Qx_167 - start_4) | 0) < X60Qx_168)) {
    return -1;
  }
  let X60Qx_169 = len_4_sysvq0asl(sub_4);
  if ((X60Qx_169 === 1)) {
    let X60Qx_170 = getQ_9_sysvq0asl(sub_4, 0);
    let X60Qx_171 = find_0_str7j0ifg(s_30, X60Qx_170, start_4, last_3);
    result_35 = X60Qx_171;
    return result_35;
  }
  let X60QconstRefTemp_0 = allocFixed(1024);
  mem.copy(X60QconstRefTemp_0, initSkipTable_1_str7j0ifg(sub_4), 1024);
  let X60Qx_172 = find_2_str7j0ifg(X60QconstRefTemp_0, s_30, sub_4, start_4, last_3);
  result_35 = X60Qx_172;
  return result_35;
}

function newSeqUninit_0_Im3cqd9_str7j0ifg(size_1) {
  let result_56 = allocFixed(8);
  if ((size_1 === 0)) {
    mem.copy(result_56, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_I7me00i_str7j0ifg(size_1);
    let X60Qx_298 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_56, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), X60Qx_298);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_56 + 4)) === 0))) {
      let X60Qx_299 = allocFixed(8);
      mem.setU32(X60Qx_299, 1634036990);
      mem.setU32((X60Qx_299 + 4), strlit_0_I15750996627617194403_exp6svnmi1);
    } else {
      mem.setI32(result_56, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_56;
}

function add_0_Ig6072n_str7j0ifg(s_45, elem_2) {
  let L_3 = mem.i32(s_45);
  let X60Qx_300 = capInBytes_0_Ih2sbn01_str7j0ifg(s_45);
  if ((X60Qx_300 < ((Math.imul(L_3, 8) + 8) | 0))) {
    let X60Qx_301 = resize_0_I4buliy_str7j0ifg(s_45, 1);
    if ((!X60Qx_301)) {
      nimStrDestroy(elem_2);
      return;
    }
  }
  inc_1_I6wjjge_exp6svnmi1(s_45);
  mem.copy((mem.u32((s_45 + 4)) + (L_3 * 8)), elem_2, 8);
}

function toOpenArray_0_I4wbsml_str7j0ifg(x_29) {
  let result_58 = allocFixed(8);
  let X60Qx_26 = allocFixed(8);
  if (((((((255 & 255) - (0 & 255)) | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_26, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_26, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_29);
      mem.setI32((_o + 4), (((((255 & 255) - (0 & 255)) | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_58, X60Qx_26, 8);
  return result_58;
}

function putQ_10_Izxzxmw_str7j0ifg(x_30, i_32, elem_3) {
  let X60Qx_302;
  if ((0 <= i_32)) {
    X60Qx_302 = (i_32 < mem.i32((x_30 + 4)));
  } else {
    X60Qx_302 = false;
  }
  if ((!X60Qx_302)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14872370265633446329_str7j0ifg);
      return _o;
    })());
  }
  let X60Qx_303 = getQ_10_I053icq_str7j0ifg(x_30, i_32);
  mem.setI32(X60Qx_303, elem_3);
}

function dec_0_Ig5i8xp_str7j0ifg(x_38, y_5) {
  mem.setI32(x_38, ((mem.i32(x_38) - y_5) | 0));
}

function memSizeInBytes_0_I7me00i_str7j0ifg(size_3) {
  let result_65;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_3, 8));
  result_65 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_65 = 2147483647;
  }
  return result_65;
}

function capInBytes_0_Ih2sbn01_str7j0ifg(s_49) {
  let result_66;
  let X60Qx_28;
  if ((!(mem.u32((s_49 + 4)) === 0))) {
    let X60Qx_311 = allocatedSize_0_sysvq0asl(mem.u32((s_49 + 4)));
    X60Qx_28 = X60Qx_311;
  } else {
    X60Qx_28 = 0;
  }
  result_66 = X60Qx_28;
  return result_66;
}

function resize_0_I4buliy_str7j0ifg(dest_1, addedElements_1) {
  let result_67;
  let X60Qx_312 = capInBytes_0_Ih2sbn01_str7j0ifg(dest_1);
  let oldCap_0 = Math.trunc((X60Qx_312 / 8));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_1);
  let memSize_1 = memSizeInBytes_0_I7me00i_str7j0ifg(newCap_0);
  let X60Qx_313 = realloc_1_sysvq0asl(mem.u32((dest_1 + 4)), memSize_1);
  mem.setU32((dest_1 + 4), X60Qx_313);
  if ((mem.u32((dest_1 + 4)) === 0)) {
    mem.setI32(dest_1, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    result_67 = false;
  } else {
    result_67 = true;
  }
  return result_67;
}

function getQ_10_I053icq_str7j0ifg(x_40, idx_9) {
  let X60Qx_314;
  if ((0 <= idx_9)) {
    X60Qx_314 = (idx_9 < mem.i32((x_40 + 4)));
  } else {
    X60Qx_314 = false;
  }
  if ((!X60Qx_314)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_jsfc0lwq21);
      return _o;
    })());
  }
  let result_68;
  result_68 = (mem.u32(x_40) + (idx_9 * 4));
  return result_68;
}

function eQdestroy_1_Ivioh0a_str7j0ifg(s_65) {
  if ((!(mem.u32((s_65 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_39 = allocFixed(4);
      mem.setI32(i_39, 0);
      {
        while ((mem.i32(i_39) < mem.i32(s_65))) {
          nimStrDestroy((mem.u32((s_65 + 4)) + (mem.i32(i_39) * 8)));
          inc_1_I6wjjge_exp6svnmi1(i_39);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_65 + 4)));
  }
}

let X60QiniGuard_0_str7j0ifg = allocFixed(1);

function X60Qini_0_str7j0ifg() {
  if (mem.u8At(X60QiniGuard_0_str7j0ifg)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_str7j0ifg, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_party5a2l1();
}
// generated by lengc (js backend) from assy765wm.c.nif

let X60QiniGuard_0_assy765wm = allocFixed(1);

function X60Qini_0_assy765wm() {
  if (mem.u8At(X60QiniGuard_0_assy765wm)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_assy765wm, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_syn1lfpjv();
}
// generated by lengc (js backend) from conujbkcv.c.nif

function eQdestroyQ_SX44iagnostic0conujbkcv_0_conujbkcv(dest_0) {
  nimStrDestroy((dest_0 + 44));
  nimStrDestroy((dest_0 + 32));
  nimStrDestroy((dest_0 + 12));
  nimStrDestroy((dest_0 + 4));
}

function eQwasmovedQ_SX44iagnostic0conujbkcv_0_conujbkcv(dest_0) {
  nimStrWasMoved((dest_0 + 4));
  nimStrWasMoved((dest_0 + 12));
  nimStrWasMoved((dest_0 + 32));
  nimStrWasMoved((dest_0 + 44));
}

function eQdupQ_SX44iagnostic0conujbkcv_0_conujbkcv(src_0) {
  let dest_0 = allocFixed(60);
  mem.setU8(dest_0, mem.u8At(src_0));
  let X60Qx_0 = allocFixed(8);
  mem.copy(X60Qx_0, nimStrDup((src_0 + 4)), 8);
  mem.copy((dest_0 + 4), X60Qx_0, 8);
  let X60Qx_1 = allocFixed(8);
  mem.copy(X60Qx_1, nimStrDup((src_0 + 12)), 8);
  mem.copy((dest_0 + 12), X60Qx_1, 8);
  mem.setI32((dest_0 + 20), mem.i32((src_0 + 20)));
  mem.setI32((dest_0 + 24), mem.i32((src_0 + 24)));
  mem.setI32((dest_0 + 28), mem.i32((src_0 + 28)));
  let X60Qx_2 = allocFixed(8);
  mem.copy(X60Qx_2, nimStrDup((src_0 + 32)), 8);
  mem.copy((dest_0 + 32), X60Qx_2, 8);
  mem.setU8((dest_0 + 40), mem.u8At((src_0 + 40)));
  let X60Qx_3 = allocFixed(8);
  mem.copy(X60Qx_3, nimStrDup((src_0 + 44)), 8);
  mem.copy((dest_0 + 44), X60Qx_3, 8);
  mem.setI32((dest_0 + 52), mem.i32((src_0 + 52)));
  mem.setI32((dest_0 + 56), mem.i32((src_0 + 56)));
  return dest_0;
}

let X60QiniGuard_0_conujbkcv = allocFixed(1);

function X60Qini_0_conujbkcv() {
  if (mem.u8At(X60QiniGuard_0_conujbkcv)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_conujbkcv, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from for2ybv4p1.c.nif

let X60QiniGuard_0_for2ybv4p1 = allocFixed(1);

function X60Qini_0_for2ybv4p1() {
  if (mem.u8At(X60QiniGuard_0_for2ybv4p1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_for2ybv4p1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from webzywwor1.c.nif

function jsonEscape_0_webzywwor1(s_0) {
  forStmtLabel_0: {
    var result_0 = allocFixed(8);
    nimStrWasMoved(result_0);
    nimStrDestroy(result_0);
    mem.copy(result_0, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = 0;
        var X60Qlf_1 = len_4_sysvq0asl(s_0);
        var X60Qlf_2 = allocFixed(4);
        mem.setI32(X60Qlf_2, X60Qlf_0);
        {
          while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
            {
              var X60Qii_2 = allocFixed(1);
              mem.setU8(X60Qii_2, getQ_9_sysvq0asl(s_0, mem.i32(X60Qlf_2)));
              switch (mem.u8At(X60Qii_2)) {
                case 34:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 2251778);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                case 92:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 6052866);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                case 10:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 7232514);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                case 9:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 7625730);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                case 13:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 7494658);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                case 8:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 6446082);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                case 12:
                  {
                    add_2_sysvq0asl(result_0, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 6708226);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                  }
                  break;
                default:
                  {
                    if ((mem.u8At(X60Qii_2) < 32)) {
                      var hexd_0 = allocFixed(8);
                      mem.setU32(hexd_0, 842084606);
                      mem.setU32((hexd_0 + 4), strlit_0_I6105018409752412263_webzywwor1);
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 812997886);
                        mem.setU32((_o + 4), strlit_0_I4645790987703279553_webzywwor1);
                        return _o;
                      })());
                      var X60Qx_7 = getQ_9_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 842084606);
                        mem.setU32((_o + 4), strlit_0_I6105018409752412263_webzywwor1);
                        return _o;
                      })(), ((mem.u8At(X60Qii_2) >> 4) & 15));
                      add_1_sysvq0asl(result_0, X60Qx_7);
                      var X60Qx_8 = getQ_9_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 842084606);
                        mem.setU32((_o + 4), strlit_0_I6105018409752412263_webzywwor1);
                        return _o;
                      })(), (mem.u8At(X60Qii_2) & 15));
                      add_1_sysvq0asl(result_0, X60Qx_8);
                    } else {
                      add_1_sysvq0asl(result_0, mem.u8At(X60Qii_2));
                    }
                  }
                  break;
              }
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_2);
          }
        }
      }
    }
  }
  return result_0;
}

function jStr_0_webzywwor1(s_1) {
  let result_1 = allocFixed(8);
  nimStrWasMoved(result_1);
  let X60Qdesugar_0 = allocFixed(8);
  mem.copy(X60Qdesugar_0, jsonEscape_0_webzywwor1(s_1), 8);
  let X60Qx_9 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 8705);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qx_10 = len_4_sysvq0asl(X60Qdesugar_0);
  let X60Qx_11 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 8705);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_1 = allocFixed(8);
  mem.copy(X60Qdesugar_1, newStringOfCap_0_sysvq0asl(((((X60Qx_9 + X60Qx_10) | 0) + X60Qx_11) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_1, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 8705);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_1, X60Qdesugar_0);
  add_2_sysvq0asl(X60Qdesugar_1, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 8705);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_1);
  mem.copy(result_1, X60Qdesugar_1, 8);
  nimStrWasMoved(X60Qdesugar_1);
  nimStrDestroy(X60Qdesugar_1);
  nimStrDestroy(X60Qdesugar_0);
  return result_1;
  nimStrDestroy(X60Qdesugar_1);
  nimStrDestroy(X60Qdesugar_0);
  return result_1;
}

function sevStr_0_webzywwor1(s_2) {
  let result_2 = allocFixed(8);
  nimStrWasMoved(result_2);
  let X60Qx_0 = allocFixed(8);
  nimStrWasMoved(X60Qx_0);
  switch (s_2) {
    case 2:
      {
        nimStrDestroy(X60Qx_0);
        mem.copy(X60Qx_0, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1920099838);
          mem.setU32((_o + 4), strlit_0_I15516388950515943933_webzywwor1);
          return _o;
        })(), 8);
      }
      break;
    case 1:
      {
        nimStrDestroy(X60Qx_0);
        mem.copy(X60Qx_0, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1918990334);
          mem.setU32((_o + 4), strlit_0_I14478211161560354671_webzywwor1);
          return _o;
        })(), 8);
      }
      break;
    case 0:
      {
        nimStrDestroy(X60Qx_0);
        mem.copy(X60Qx_0, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1852401918);
          mem.setU32((_o + 4), strlit_0_I5147724977109554671_webzywwor1);
          return _o;
        })(), 8);
      }
      break;
  }
  nimStrDestroy(result_2);
  mem.copy(result_2, X60Qx_0, 8);
  nimStrWasMoved(X60Qx_0);
  nimStrDestroy(X60Qx_0);
  return result_2;
  nimStrDestroy(X60Qx_0);
  return result_2;
}

function offsetToLineCol_0_webzywwor1(starts_0, off_0) {
  forStmtLabel_0: {
    var result_3 = allocFixed(8);
    var line_1 = 1;
    {
      whileStmtLabel_1: {
        var X60Qlf_3 = 0;
        var X60Qlf_4 = len_3_I0v1j8d_texdasn3y(starts_0);
        var X60Qlf_5 = allocFixed(4);
        mem.setI32(X60Qlf_5, X60Qlf_3);
        {
          while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
            {
              var X60Qx_12 = getQ_7_Ir8kccm_fixeak1im1(starts_0, mem.i32(X60Qlf_5));
              if ((mem.i32(X60Qx_12) <= off_0)) {
                line_1 = ((mem.i32(X60Qlf_5) + 1) | 0);
              } else {
                break forStmtLabel_0;
              }
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_5);
          }
        }
      }
    }
  }
  var X60Qx_13 = getQ_7_Ir8kccm_fixeak1im1(starts_0, ((line_1 - 1) | 0));
  var col_1 = ((off_0 - mem.i32(X60Qx_13)) | 0);
  mem.copy(result_3, (() => {
    var _o = allocFixed(8);
    mem.setI32(_o, line_1);
    mem.setI32((_o + 4), col_1);
    return _o;
  })(), 8);
  return result_3;
}

function severityFromStr_0_webzywwor1(s_3) {
  X60Qsc_4: {
    X60Qsc_5: {
      X60Qsc_2: {
        X60Qsc_1: {
          X60Qsc_0: {
            var result_4;
            var X60Qx_1;
            var X60Qtc_3 = nimStrAtLe_0_sysvq0asl(s_3, 0, 101);
            if (X60Qtc_3) {
              if (equalStrings_0_sysvq0asl(s_3, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1920099838);
                mem.setU32((_o + 4), strlit_0_I15516388950515943933_webzywwor1);
                return _o;
              })())) {
                break X60Qsc_0;
              }
            } else {
              if (equalStrings_0_sysvq0asl(s_3, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1918990334);
                mem.setU32((_o + 4), strlit_0_I14478211161560354671_webzywwor1);
                return _o;
              })())) {
                break X60Qsc_1;
              } else if (equalStrings_0_sysvq0asl(s_3, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1852401918);
                mem.setU32((_o + 4), strlit_0_I5147724977109554671_webzywwor1);
                return _o;
              })())) {
                break X60Qsc_2;
              }
            }
            break X60Qsc_5;
          }
          X60Qx_1 = 2;
          break X60Qsc_4;
        }
        X60Qx_1 = 1;
        break X60Qsc_4;
      }
      X60Qx_1 = 0;
      break X60Qsc_4;
    }
    X60Qx_1 = 2;
  }
  result_4 = X60Qx_1;
  return result_4;
}

function nativeCopy_0_webzywwor1(s_4) {
  forStmtLabel_0: {
    var result_5 = allocFixed(8);
    nimStrWasMoved(result_5);
    nimStrDestroy(result_5);
    mem.copy(result_5, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_6 = 0;
        var X60Qlf_7 = len_4_sysvq0asl(s_4);
        var X60Qlf_8 = allocFixed(4);
        mem.setI32(X60Qlf_8, X60Qlf_6);
        {
          while ((mem.i32(X60Qlf_8) < X60Qlf_7)) {
            {
              var X60Qx_14 = getQ_9_sysvq0asl(s_4, mem.i32(X60Qlf_8));
              add_1_sysvq0asl(result_5, X60Qx_14);
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_8);
          }
        }
      }
    }
  }
  return result_5;
}

function getStr_0_webzywwor1(el_0, name_0) {
  let result_6 = allocFixed(8);
  nimStrWasMoved(result_6);
  let X60Qx_15 = hasProp_0_jsfc0lwq21(el_0, name_0);
  if (X60Qx_15) {
    let v_0 = allocFixed(4);
    mem.copy(v_0, get_0_jsfc0lwq21(el_0, name_0), 4);
    let X60Qx_16 = isNil_0_jsfc0lwq21(v_0);
    if ((!X60Qx_16)) {
      let X60Qtmp_0 = allocFixed(8);
      mem.copy(X60Qtmp_0, toStr_0_jsfc0lwq21(v_0), 8);
      let X60Qx_17 = allocFixed(8);
      mem.copy(X60Qx_17, nativeCopy_0_webzywwor1(X60Qtmp_0), 8);
      mem.copy(result_6, X60Qx_17, 8);
      nimStrDestroy(X60Qtmp_0);
      eQdestroy_0_jsfc0lwq21(v_0);
      return result_6;
      nimStrDestroy(X60Qtmp_0);
    }
    eQdestroy_0_jsfc0lwq21(v_0);
  }
  nimStrDestroy(result_6);
  mem.copy(result_6, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  return result_6;
}

function getInt_0_webzywwor1(el_1, name_1, dflt_0) {
  let result_7;
  let X60Qx_18 = hasProp_0_jsfc0lwq21(el_1, name_1);
  if (X60Qx_18) {
    let v_1 = allocFixed(4);
    mem.copy(v_1, get_0_jsfc0lwq21(el_1, name_1), 4);
    let X60Qx_19 = isNil_0_jsfc0lwq21(v_1);
    if ((!X60Qx_19)) {
      let X60Qx_20 = toInt_0_jsfc0lwq21(v_1);
      result_7 = X60Qx_20;
      eQdestroy_0_jsfc0lwq21(v_1);
      return result_7;
    }
    eQdestroy_0_jsfc0lwq21(v_1);
  }
  result_7 = dflt_0;
  return result_7;
}

function decodeDiags_0_webzywwor1(diagJson_0) {
  forStmtLabel_2: {
    forStmtLabel_0: {
      var result_8 = allocFixed(8);
      eQwasMoved_1_I4zhxn8_webzywwor1(result_8);
      eQdestroy_1_Iwfstgd_webzywwor1(result_8);
      var X60Qx_21 = allocFixed(8);
      mem.copy(X60Qx_21, newSeqUninit_0_Iu8m9wc_webzywwor1(0), 8);
      mem.copy(result_8, X60Qx_21, 8);
      var s_7 = allocFixed(8);
      mem.copy(s_7, nimStrDup(diagJson_0), 8);
      var trimmed_0 = false;
      var nonWs_0 = false;
      {
        whileStmtLabel_1: {
          var X60Qlf_9 = 0;
          var X60Qlf_10 = len_4_sysvq0asl(s_7);
          var X60Qlf_11 = allocFixed(4);
          mem.setI32(X60Qlf_11, X60Qlf_9);
          {
            while ((mem.i32(X60Qlf_11) < X60Qlf_10)) {
              {
                var X60Qx_22;
                var X60Qx_23;
                var X60Qx_24;
                var X60Qx_25 = getQ_9_sysvq0asl(s_7, mem.i32(X60Qlf_11));
                if ((!(X60Qx_25 === 32))) {
                  var X60Qx_26 = getQ_9_sysvq0asl(s_7, mem.i32(X60Qlf_11));
                  X60Qx_24 = (!(X60Qx_26 === 9));
                } else {
                  X60Qx_24 = false;
                }
                if (X60Qx_24) {
                  var X60Qx_27 = getQ_9_sysvq0asl(s_7, mem.i32(X60Qlf_11));
                  X60Qx_23 = (!(X60Qx_27 === 10));
                } else {
                  X60Qx_23 = false;
                }
                if (X60Qx_23) {
                  var X60Qx_28 = getQ_9_sysvq0asl(s_7, mem.i32(X60Qlf_11));
                  X60Qx_22 = (!(X60Qx_28 === 13));
                } else {
                  X60Qx_22 = false;
                }
                if (X60Qx_22) {
                  nonWs_0 = true;
                  break forStmtLabel_0;
                }
              }
              inc_1_I6wjjge_exp6svnmi1(X60Qlf_11);
            }
          }
        }
      }
    }
    if ((!nonWs_0)) {
      nimStrDestroy(s_7);
      return result_8;
    }
    var jsonG_0 = allocFixed(4);
    mem.copy(jsonG_0, global_0_jsfc0lwq21((() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1330858750);
      mem.setU32((_o + 4), strlit_0_I6373137695046429832_webzywwor1);
      return _o;
    })()), 4);
    var X60Qtmp_1 = allocFixed(4);
    mem.copy(X60Qtmp_1, toJs_3_jsfc0lwq21(s_7), 4);
    var arr_0 = allocFixed(4);
    mem.copy(arr_0, call_1_jsfc0lwq21(jsonG_0, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1918988542);
      mem.setU32((_o + 4), strlit_0_I13485403899737849153_webzywwor1);
      return _o;
    })(), X60Qtmp_1), 4);
    var X60Qx_29 = isNil_0_jsfc0lwq21(arr_0);
    if (X60Qx_29) {
      eQdestroy_0_jsfc0lwq21(arr_0);
      eQdestroy_0_jsfc0lwq21(X60Qtmp_1);
      eQdestroy_0_jsfc0lwq21(jsonG_0);
      nimStrDestroy(s_7);
      return result_8;
    }
    var n_0 = len_0_jsfc0lwq21(arr_0);
    {
      whileStmtLabel_3: {
        var X60Qlf_12 = 0;
        var X60Qlf_13 = n_0;
        var X60Qlf_14 = allocFixed(4);
        mem.setI32(X60Qlf_14, X60Qlf_12);
        {
          while ((mem.i32(X60Qlf_14) < X60Qlf_13)) {
            {
              var X60Qii_4 = allocFixed(4);
              mem.copy(X60Qii_4, getQ_0_jsfc0lwq21(arr_0, mem.i32(X60Qlf_14)), 4);
              var X60Qii_5 = allocFixed(60);
              mem.setU8(X60Qii_5, 2);
              mem.copy((X60Qii_5 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 0);
                mem.setU32((_o + 4), 0);
                return _o;
              })(), 8);
              mem.copy((X60Qii_5 + 12), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 0);
                mem.setU32((_o + 4), 0);
                return _o;
              })(), 8);
              mem.setI32((X60Qii_5 + 20), 0);
              mem.setI32((X60Qii_5 + 24), 0);
              mem.setI32((X60Qii_5 + 28), 0);
              mem.copy((X60Qii_5 + 32), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 0);
                mem.setU32((_o + 4), 0);
                return _o;
              })(), 8);
              mem.setU8((X60Qii_5 + 40), false);
              mem.copy((X60Qii_5 + 44), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 0);
                mem.setU32((_o + 4), 0);
                return _o;
              })(), 8);
              mem.setI32((X60Qii_5 + 52), 0);
              mem.setI32((X60Qii_5 + 56), 0);
              var X60Qtmp_2 = allocFixed(8);
              mem.copy(X60Qtmp_2, getStr_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1986360318);
                mem.setU32((_o + 4), strlit_0_I6336096988826643762_webzywwor1);
                return _o;
              })()), 8);
              var X60Qx_30 = severityFromStr_0_webzywwor1(X60Qtmp_2);
              mem.setU8(X60Qii_5, X60Qx_30);
              var X60Qlhs_3 = (X60Qii_5 + 4);
              nimStrDestroy(X60Qlhs_3);
              var X60Qx_31 = allocFixed(8);
              mem.copy(X60Qx_31, getStr_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1685021694);
                mem.setU32((_o + 4), strlit_0_I10495286183715212852_webzywwor1);
                return _o;
              })()), 8);
              mem.copy(X60Qlhs_3, X60Qx_31, 8);
              var X60Qlhs_4 = (X60Qii_5 + 12);
              nimStrDestroy(X60Qlhs_4);
              var X60Qx_32 = allocFixed(8);
              mem.copy(X60Qx_32, getStr_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1936027134);
                mem.setU32((_o + 4), strlit_0_I17194081841433683614_webzywwor1);
                return _o;
              })()), 8);
              mem.copy(X60Qlhs_4, X60Qx_32, 8);
              var X60Qx_33 = getInt_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1852402942);
                mem.setU32((_o + 4), strlit_0_I1643616165736515820_webzywwor1);
                return _o;
              })(), 0);
              mem.setI32((X60Qii_5 + 20), X60Qx_33);
              var X60Qx_34 = getInt_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1819239171);
                mem.setU32((_o + 4), 0);
                return _o;
              })(), 0);
              mem.setI32((X60Qii_5 + 24), X60Qx_34);
              var X60Qx_35 = getInt_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1684956670);
                mem.setU32((_o + 4), strlit_0_I1594669814536249853_webzywwor1);
                return _o;
              })(), mem.i32((X60Qii_5 + 24)));
              mem.setI32((X60Qii_5 + 28), X60Qx_35);
              var X60Qlhs_5 = (X60Qii_5 + 32);
              nimStrDestroy(X60Qlhs_5);
              var X60Qx_36 = allocFixed(8);
              mem.copy(X60Qx_36, getStr_0_webzywwor1(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 2020173315);
                mem.setU32((_o + 4), 0);
                return _o;
              })()), 8);
              mem.copy(X60Qlhs_5, X60Qx_36, 8);
              var X60Qx_37 = hasProp_0_jsfc0lwq21(X60Qii_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1818587902);
                mem.setU32((_o + 4), strlit_0_I10452665333506134667_webzywwor1);
                return _o;
              })());
              if (X60Qx_37) {
                var X60Qii_6 = allocFixed(4);
                mem.copy(X60Qii_6, get_0_jsfc0lwq21(X60Qii_4, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1818587902);
                  mem.setU32((_o + 4), strlit_0_I10452665333506134667_webzywwor1);
                  return _o;
                })()), 4);
                var X60Qx_38 = isNil_0_jsfc0lwq21(X60Qii_6);
                if ((!X60Qx_38)) {
                  mem.setU8((X60Qii_5 + 40), true);
                  var X60Qlhs_6 = (X60Qii_5 + 44);
                  nimStrDestroy(X60Qlhs_6);
                  var X60Qx_39 = allocFixed(8);
                  mem.copy(X60Qx_39, getStr_0_webzywwor1(X60Qii_6, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1936027134);
                    mem.setU32((_o + 4), strlit_0_I17194081841433683614_webzywwor1);
                    return _o;
                  })()), 8);
                  mem.copy(X60Qlhs_6, X60Qx_39, 8);
                  var X60Qx_40 = getInt_0_webzywwor1(X60Qii_6, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852402942);
                    mem.setU32((_o + 4), strlit_0_I1643616165736515820_webzywwor1);
                    return _o;
                  })(), 0);
                  mem.setI32((X60Qii_5 + 52), X60Qx_40);
                  var X60Qx_41 = getInt_0_webzywwor1(X60Qii_6, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1819239171);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })(), 0);
                  mem.setI32((X60Qii_5 + 56), X60Qx_41);
                }
                eQdestroy_0_jsfc0lwq21(X60Qii_6);
              }
              var X60Qtmp_7 = allocFixed(60);
              mem.copy(X60Qtmp_7, X60Qii_5, 60);
              eQwasmovedQ_SX44iagnostic0conujbkcv_0_conujbkcv(X60Qii_5);
              add_0_Invh6cl1_webzywwor1(result_8, X60Qtmp_7);
              nimStrDestroy(X60Qtmp_2);
              eQdestroyQ_SX44iagnostic0conujbkcv_0_conujbkcv(X60Qii_5);
              eQdestroy_0_jsfc0lwq21(X60Qii_4);
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_14);
          }
        }
      }
    }
  }
  eQdestroy_0_jsfc0lwq21(arr_0);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_1);
  eQdestroy_0_jsfc0lwq21(jsonG_0);
  nimStrDestroy(s_7);
  return result_8;
  eQdestroy_0_jsfc0lwq21(arr_0);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_1);
  eQdestroy_0_jsfc0lwq21(jsonG_0);
  nimStrDestroy(s_7);
  return result_8;
}

function fixObj_0_webzywwor1(code_0, title_0, message_0, line_0, col_0, endLine_0, endCol_0, newText_0, kind_0, isPreferred_0, sev_0) {
  let result_9 = allocFixed(8);
  nimStrWasMoved(result_9);
  let X60Qdesugar_2 = allocFixed(8);
  mem.copy(X60Qdesugar_2, jStr_0_webzywwor1(code_0), 8);
  let X60Qdesugar_3 = allocFixed(8);
  mem.copy(X60Qdesugar_3, jStr_0_webzywwor1(title_0), 8);
  let X60Qdesugar_4 = allocFixed(8);
  mem.copy(X60Qdesugar_4, jStr_0_webzywwor1(message_0), 8);
  let X60Qdesugar_5 = allocFixed(8);
  mem.copy(X60Qdesugar_5, dollarQ_2_sysvq0asl(line_0), 8);
  let X60Qdesugar_6 = allocFixed(8);
  mem.copy(X60Qdesugar_6, dollarQ_2_sysvq0asl(col_0), 8);
  let X60Qdesugar_7 = allocFixed(8);
  mem.copy(X60Qdesugar_7, dollarQ_2_sysvq0asl(endLine_0), 8);
  let X60Qdesugar_8 = allocFixed(8);
  mem.copy(X60Qdesugar_8, dollarQ_2_sysvq0asl(endCol_0), 8);
  let X60Qdesugar_9 = allocFixed(8);
  mem.copy(X60Qdesugar_9, jStr_0_webzywwor1(newText_0), 8);
  let X60Qdesugar_10 = allocFixed(8);
  mem.copy(X60Qdesugar_10, jStr_0_webzywwor1(kind_0), 8);
  let X60Qx_2 = allocFixed(8);
  nimStrWasMoved(X60Qx_2);
  if (isPreferred_0) {
    nimStrDestroy(X60Qx_2);
    mem.copy(X60Qx_2, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1970435326);
      mem.setU32((_o + 4), strlit_0_I8572766038233537570_syn1lfpjv);
      return _o;
    })(), 8);
  } else {
    nimStrDestroy(X60Qx_2);
    mem.copy(X60Qx_2, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1818322686);
      mem.setU32((_o + 4), strlit_0_I3372626016653902757_syn1lfpjv);
      return _o;
    })(), 8);
  }
  let X60Qdesugar_11 = allocFixed(8);
  mem.copy(X60Qdesugar_11, X60Qx_2, 8);
  nimStrWasMoved(X60Qx_2);
  let X60Qdesugar_12 = allocFixed(8);
  mem.copy(X60Qdesugar_12, jStr_0_webzywwor1(sev_0), 8);
  let X60Qx_42 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663204350);
    mem.setU32((_o + 4), strlit_0_I11472176434042843973_webzywwor1);
    return _o;
  })());
  let X60Qx_43 = len_4_sysvq0asl(X60Qdesugar_2);
  let X60Qx_44 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1948396798);
    mem.setU32((_o + 4), strlit_0_I6978980501808324049_webzywwor1);
    return _o;
  })());
  let X60Qx_45 = len_4_sysvq0asl(X60Qdesugar_3);
  let X60Qx_46 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1830956286);
    mem.setU32((_o + 4), strlit_0_I7204142019108744947_webzywwor1);
    return _o;
  })());
  let X60Qx_47 = len_4_sysvq0asl(X60Qdesugar_4);
  let X60Qx_48 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1814179070);
    mem.setU32((_o + 4), strlit_0_I18338797071087941219_webzywwor1);
    return _o;
  })());
  let X60Qx_49 = len_4_sysvq0asl(X60Qdesugar_5);
  let X60Qx_50 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663184126);
    mem.setU32((_o + 4), strlit_0_I7115103054454119625_webzywwor1);
    return _o;
  })());
  let X60Qx_51 = len_4_sysvq0asl(X60Qdesugar_6);
  let X60Qx_52 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I5766285012476903774_webzywwor1);
    return _o;
  })());
  let X60Qx_53 = len_4_sysvq0asl(X60Qdesugar_7);
  let X60Qx_54 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I1123073466241064333_webzywwor1);
    return _o;
  })());
  let X60Qx_55 = len_4_sysvq0asl(X60Qdesugar_8);
  let X60Qx_56 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1847733502);
    mem.setU32((_o + 4), strlit_0_I16140219651591674227_webzywwor1);
    return _o;
  })());
  let X60Qx_57 = len_4_sysvq0asl(X60Qdesugar_9);
  let X60Qx_58 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1797401854);
    mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
    return _o;
  })());
  let X60Qx_59 = len_4_sysvq0asl(X60Qdesugar_10);
  let X60Qx_60 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1763847422);
    mem.setU32((_o + 4), strlit_0_I7507345602561577771_webzywwor1);
    return _o;
  })());
  let X60Qx_61 = len_4_sysvq0asl(X60Qdesugar_11);
  let X60Qx_62 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1931619582);
    mem.setU32((_o + 4), strlit_0_I4223485871286820833_webzywwor1);
    return _o;
  })());
  let X60Qx_63 = len_4_sysvq0asl(X60Qdesugar_12);
  let X60Qx_64 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_13 = allocFixed(8);
  mem.copy(X60Qdesugar_13, newStringOfCap_0_sysvq0asl(((((((((((((((((((((((((((((((((((((((((((((X60Qx_42 + X60Qx_43) | 0) + X60Qx_44) | 0) + X60Qx_45) | 0) + X60Qx_46) | 0) + X60Qx_47) | 0) + X60Qx_48) | 0) + X60Qx_49) | 0) + X60Qx_50) | 0) + X60Qx_51) | 0) + X60Qx_52) | 0) + X60Qx_53) | 0) + X60Qx_54) | 0) + X60Qx_55) | 0) + X60Qx_56) | 0) + X60Qx_57) | 0) + X60Qx_58) | 0) + X60Qx_59) | 0) + X60Qx_60) | 0) + X60Qx_61) | 0) + X60Qx_62) | 0) + X60Qx_63) | 0) + X60Qx_64) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663204350);
    mem.setU32((_o + 4), strlit_0_I11472176434042843973_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_2);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1948396798);
    mem.setU32((_o + 4), strlit_0_I6978980501808324049_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_3);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1830956286);
    mem.setU32((_o + 4), strlit_0_I7204142019108744947_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_4);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1814179070);
    mem.setU32((_o + 4), strlit_0_I18338797071087941219_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_5);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663184126);
    mem.setU32((_o + 4), strlit_0_I7115103054454119625_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_6);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I5766285012476903774_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_7);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I1123073466241064333_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_8);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1847733502);
    mem.setU32((_o + 4), strlit_0_I16140219651591674227_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_9);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1797401854);
    mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_10);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1763847422);
    mem.setU32((_o + 4), strlit_0_I7507345602561577771_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_11);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1931619582);
    mem.setU32((_o + 4), strlit_0_I4223485871286820833_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_13, X60Qdesugar_12);
  add_2_sysvq0asl(X60Qdesugar_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_9);
  mem.copy(result_9, X60Qdesugar_13, 8);
  nimStrWasMoved(X60Qdesugar_13);
  nimStrDestroy(X60Qdesugar_13);
  nimStrDestroy(X60Qdesugar_12);
  nimStrDestroy(X60Qdesugar_11);
  nimStrDestroy(X60Qx_2);
  nimStrDestroy(X60Qdesugar_10);
  nimStrDestroy(X60Qdesugar_9);
  nimStrDestroy(X60Qdesugar_8);
  nimStrDestroy(X60Qdesugar_7);
  nimStrDestroy(X60Qdesugar_6);
  nimStrDestroy(X60Qdesugar_5);
  nimStrDestroy(X60Qdesugar_4);
  nimStrDestroy(X60Qdesugar_3);
  nimStrDestroy(X60Qdesugar_2);
  return result_9;
  nimStrDestroy(X60Qdesugar_13);
  nimStrDestroy(X60Qdesugar_12);
  nimStrDestroy(X60Qdesugar_11);
  nimStrDestroy(X60Qx_2);
  nimStrDestroy(X60Qdesugar_10);
  nimStrDestroy(X60Qdesugar_9);
  nimStrDestroy(X60Qdesugar_8);
  nimStrDestroy(X60Qdesugar_7);
  nimStrDestroy(X60Qdesugar_6);
  nimStrDestroy(X60Qdesugar_5);
  nimStrDestroy(X60Qdesugar_4);
  nimStrDestroy(X60Qdesugar_3);
  nimStrDestroy(X60Qdesugar_2);
  return result_9;
}

function computeFixes_0_webzywwor1(src_0, diagJson_1) {
  forStmtLabel_14: {
    forStmtLabel_0: {
      var result_10 = allocFixed(8);
      nimStrWasMoved(result_10);
      var diags_0 = allocFixed(8);
      mem.copy(diags_0, decodeDiags_0_webzywwor1(diagJson_1), 8);
      var starts_1 = allocFixed(8);
      mem.copy(starts_1, lineStarts_0_texdasn3y(src_0), 8);
      var parts_0 = allocFixed(8);
      mem.copy(parts_0, newSeqUninit_0_Im3cqd9_str7j0ifg(0), 8);
      {
        whileStmtLabel_1: {
          var X60Qlf_15 = 0;
          var X60Qlf_16 = len_3_I1wljfb1_webzywwor1(diags_0);
          var X60Qlf_17 = allocFixed(4);
          mem.setI32(X60Qlf_17, X60Qlf_15);
          {
            while ((mem.i32(X60Qlf_17) < X60Qlf_16)) {
              {
                var X60Qx_65 = getQ_7_Ijfibgv_webzywwor1(diags_0, mem.i32(X60Qlf_17));
                var X60QconstRefTemp_0 = allocFixed(60);
                mem.copy(X60QconstRefTemp_0, X60Qx_65, 60);
                var X60Qii_2 = allocFixed(60);
                mem.copy(X60Qii_2, eQdupQ_SX44iagnostic0conujbkcv_0_conujbkcv(X60QconstRefTemp_0), 60);
                var X60Qii_3 = allocFixed(8);
                mem.copy(X60Qii_3, candidateFixes_0_fixeak1im1(X60Qii_2, src_0, starts_1), 8);
                if ((0 < mem.i32(X60Qii_3))) {
                  forStmtLabel_4: {
                    {
                      whileStmtLabel_5: {
                        var X60Qlf_18 = 0;
                        var X60Qlf_19 = len_3_I0hm3iv1_webzywwor1(X60Qii_3);
                        var X60Qlf_20 = allocFixed(4);
                        mem.setI32(X60Qlf_20, X60Qlf_18);
                        {
                          while ((mem.i32(X60Qlf_20) < X60Qlf_19)) {
                            {
                              var X60Qx_66 = getQ_7_Iqwn967_webzywwor1(X60Qii_3, mem.i32(X60Qlf_20));
                              var X60QconstRefTemp_1 = allocFixed(36);
                              mem.copy(X60QconstRefTemp_1, X60Qx_66, 36);
                              var X60Qii_6 = allocFixed(36);
                              mem.copy(X60Qii_6, eQdupQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(X60QconstRefTemp_1), 36);
                              var X60Qii_7 = allocFixed(8);
                              mem.copy(X60Qii_7, offsetToLineCol_0_webzywwor1(starts_1, mem.i32((X60Qii_6 + 4))), 8);
                              var X60Qii_8 = mem.i32(X60Qii_7);
                              var X60Qii_9 = mem.i32((X60Qii_7 + 4));
                              var X60Qii_10 = allocFixed(8);
                              mem.copy(X60Qii_10, offsetToLineCol_0_webzywwor1(starts_1, mem.i32(((X60Qii_6 + 4) + 4))), 8);
                              var X60Qii_11 = mem.i32(X60Qii_10);
                              var X60Qii_12 = mem.i32((X60Qii_10 + 4));
                              var X60Qtmp_8 = allocFixed(8);
                              mem.copy(X60Qtmp_8, sevStr_0_webzywwor1(mem.u8At(X60Qii_2)), 8);
                              var X60Qx_67 = allocFixed(8);
                              mem.copy(X60Qx_67, fixObj_0_webzywwor1((X60Qii_2 + 4), ((X60Qii_6 + 4) + 16), (X60Qii_6 + 28), X60Qii_8, X60Qii_9, X60Qii_11, X60Qii_12, ((X60Qii_6 + 4) + 8), (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1953849854);
                                mem.setU32((_o + 4), strlit_0_I2419004569819514924_webzywwor1);
                                return _o;
                              })(), (mem.i32(X60Qlf_20) === 0), X60Qtmp_8), 8);
                              add_0_Ig6072n_str7j0ifg(parts_0, X60Qx_67);
                              nimStrDestroy(X60Qtmp_8);
                              eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(X60Qii_6);
                            }
                            inc_1_I6wjjge_exp6svnmi1(X60Qlf_20);
                          }
                        }
                      }
                    }
                  }
                } else {
                  var X60Qii_13 = allocFixed(36);
                  mem.copy(X60Qii_13, planFix_0_fixeak1im1(X60Qii_2, src_0, starts_1), 36);
                  if ((mem.u8At(X60Qii_13) === 1)) {
                    var X60Qtmp_9 = allocFixed(8);
                    mem.copy(X60Qtmp_9, sevStr_0_webzywwor1(mem.u8At(X60Qii_2)), 8);
                    var X60Qx_68 = allocFixed(8);
                    mem.copy(X60Qx_68, fixObj_0_webzywwor1((X60Qii_2 + 4), (X60Qii_13 + 28), (X60Qii_2 + 12), mem.i32((X60Qii_2 + 20)), mem.i32((X60Qii_2 + 24)), mem.i32((X60Qii_2 + 20)), mem.i32((X60Qii_2 + 28)), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 0);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })(), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1735750654);
                      mem.setU32((_o + 4), strlit_0_I11240999720484037362_webzywwor1);
                      return _o;
                    })(), false, X60Qtmp_9), 8);
                    add_0_Ig6072n_str7j0ifg(parts_0, X60Qx_68);
                    nimStrDestroy(X60Qtmp_9);
                  }
                  eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(X60Qii_13);
                }
                eQdestroy_1_Ij6whwo1_fixeak1im1(X60Qii_3);
                eQdestroyQ_SX44iagnostic0conujbkcv_0_conujbkcv(X60Qii_2);
              }
              inc_1_I6wjjge_exp6svnmi1(X60Qlf_17);
            }
          }
        }
      }
    }
    nimStrDestroy(result_10);
    mem.copy(result_10, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_15: {
        var X60Qlf_21 = 0;
        var X60Qlf_22 = len_3_Ixq6taz_texdasn3y(parts_0);
        var X60Qlf_23 = allocFixed(4);
        mem.setI32(X60Qlf_23, X60Qlf_21);
        {
          while ((mem.i32(X60Qlf_23) < X60Qlf_22)) {
            {
              if ((0 < mem.i32(X60Qlf_23))) {
                add_2_sysvq0asl(result_10, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_69 = getQ_7_Ir6d0tw_texdasn3y(parts_0, mem.i32(X60Qlf_23));
              add_2_sysvq0asl(result_10, X60Qx_69);
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_23);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_10, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  eQdestroy_1_Ivioh0a_str7j0ifg(parts_0);
  eQdestroy_1_Iv9ij5i1_fixeak1im1(starts_1);
  eQdestroy_1_Iwfstgd_webzywwor1(diags_0);
  return result_10;
  eQdestroy_1_Ivioh0a_str7j0ifg(parts_0);
  eQdestroy_1_Iv9ij5i1_fixeak1im1(starts_1);
  eQdestroy_1_Iwfstgd_webzywwor1(diags_0);
  return result_10;
}

function suRun_0_webzywwor1() {
  let X60Qtmp_10 = allocFixed(4);
  mem.copy(X60Qtmp_10, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935630334);
    mem.setU32((_o + 4), strlit_0_I17349635483251307736_webzywwor1);
    return _o;
  })()), 4);
  let src_1 = allocFixed(8);
  mem.copy(src_1, toStr_0_jsfc0lwq21(X60Qtmp_10), 8);
  let X60Qtmp_11 = allocFixed(4);
  mem.copy(X60Qtmp_11, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935630334);
    mem.setU32((_o + 4), strlit_0_I10077820878706880159_webzywwor1);
    return _o;
  })()), 4);
  let diagJson_2 = allocFixed(8);
  mem.copy(diagJson_2, toStr_0_jsfc0lwq21(X60Qtmp_11), 8);
  let fixes_0 = allocFixed(8);
  mem.copy(fixes_0, computeFixes_0_webzywwor1(src_1, diagJson_2), 8);
  let g_0 = allocFixed(4);
  mem.copy(g_0, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869375486);
    mem.setU32((_o + 4), strlit_0_I16664880105326712979_webzywwor1);
    return _o;
  })()), 4);
  let X60Qtmp_12 = allocFixed(4);
  mem.copy(X60Qtmp_12, toJs_3_jsfc0lwq21(fixes_0), 4);
  set_0_jsfc0lwq21(g_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935630334);
    mem.setU32((_o + 4), strlit_0_I9990058196389500338_webzywwor1);
    return _o;
  })(), X60Qtmp_12);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_12);
  eQdestroy_0_jsfc0lwq21(g_0);
  nimStrDestroy(fixes_0);
  nimStrDestroy(diagJson_2);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_11);
  nimStrDestroy(src_1);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_10);
}

function newSeqUninit_0_Iu8m9wc_webzywwor1(size_2) {
  let result_13 = allocFixed(8);
  if ((size_2 === 0)) {
    mem.copy(result_13, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_2);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_I6lapre_webzywwor1(size_2);
    let X60Qx_71 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_13, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_2);
      mem.setU32((_o + 4), X60Qx_71);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_13 + 4)) === 0))) {
      let X60Qx_72 = allocFixed(8);
      mem.setU32(X60Qx_72, 1634036990);
      mem.setU32((X60Qx_72 + 4), strlit_0_I15750996627617194403_exp6svnmi1);
    } else {
      mem.setI32(result_13, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_13;
}

function add_0_Invh6cl1_webzywwor1(s_18, elem_2) {
  let L_0 = mem.i32(s_18);
  let X60Qx_73 = capInBytes_0_Igp7679_webzywwor1(s_18);
  if ((X60Qx_73 < ((Math.imul(L_0, 60) + 60) | 0))) {
    let X60Qx_74 = resize_0_Ifdsato_webzywwor1(s_18, 1);
    if ((!X60Qx_74)) {
      eQdestroyQ_SX44iagnostic0conujbkcv_0_conujbkcv(elem_2);
      return;
    }
  }
  inc_1_I6wjjge_exp6svnmi1(s_18);
  mem.copy((mem.u32((s_18 + 4)) + (L_0 * 60)), elem_2, 60);
}

function len_3_I1wljfb1_webzywwor1(s_20) {
  let result_15;
  result_15 = mem.i32(s_20);
  return result_15;
}

function getQ_7_Ijfibgv_webzywwor1(s_21, i_12) {
  let X60Qx_77;
  if ((i_12 < mem.i32(s_21))) {
    X60Qx_77 = (0 <= i_12);
  } else {
    X60Qx_77 = false;
  }
  if ((!X60Qx_77)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_exp6svnmi1);
      return _o;
    })());
  }
  let result_16;
  result_16 = (mem.u32((s_21 + 4)) + (i_12 * 60));
  return result_16;
}

function len_3_I0hm3iv1_webzywwor1(s_22) {
  let result_17;
  result_17 = mem.i32(s_22);
  return result_17;
}

function getQ_7_Iqwn967_webzywwor1(s_23, i_13) {
  let X60Qx_78;
  if ((i_13 < mem.i32(s_23))) {
    X60Qx_78 = (0 <= i_13);
  } else {
    X60Qx_78 = false;
  }
  if ((!X60Qx_78)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_exp6svnmi1);
      return _o;
    })());
  }
  let result_18;
  result_18 = (mem.u32((s_23 + 4)) + (i_13 * 36));
  return result_18;
}

function memSizeInBytes_0_I6lapre_webzywwor1(size_6) {
  let result_21;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_6, 60));
  result_21 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_21 = 2147483647;
  }
  return result_21;
}

function capInBytes_0_Igp7679_webzywwor1(s_28) {
  let result_22;
  let X60Qx_3;
  if ((!(mem.u32((s_28 + 4)) === 0))) {
    let X60Qx_82 = allocatedSize_0_sysvq0asl(mem.u32((s_28 + 4)));
    X60Qx_3 = X60Qx_82;
  } else {
    X60Qx_3 = 0;
  }
  result_22 = X60Qx_3;
  return result_22;
}

function resize_0_Ifdsato_webzywwor1(dest_2, addedElements_2) {
  let result_23;
  let X60Qx_83 = capInBytes_0_Igp7679_webzywwor1(dest_2);
  let oldCap_0 = Math.trunc((X60Qx_83 / 60));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_2);
  let memSize_2 = memSizeInBytes_0_I6lapre_webzywwor1(newCap_0);
  let X60Qx_84 = realloc_1_sysvq0asl(mem.u32((dest_2 + 4)), memSize_2);
  mem.setU32((dest_2 + 4), X60Qx_84);
  if ((mem.u32((dest_2 + 4)) === 0)) {
    mem.setI32(dest_2, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    result_23 = false;
  } else {
    result_23 = true;
  }
  return result_23;
}

function eQdestroy_1_Iwfstgd_webzywwor1(s_41) {
  if ((!(mem.u32((s_41 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_19 = allocFixed(4);
      mem.setI32(i_19, 0);
      {
        while ((mem.i32(i_19) < mem.i32(s_41))) {
          eQdestroyQ_SX44iagnostic0conujbkcv_0_conujbkcv((mem.u32((s_41 + 4)) + (mem.i32(i_19) * 60)));
          inc_1_I6wjjge_exp6svnmi1(i_19);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_41 + 4)));
  }
}

function eQwasMoved_1_I4zhxn8_webzywwor1(s_42) {
  mem.setI32(s_42, 0);
  mem.setU32((s_42 + 4), 0);
}

let X60QiniGuard_0_webzywwor1 = allocFixed(1);

function X60Qini_0_webzywwor1() {
  if (mem.u8At(X60QiniGuard_0_webzywwor1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_webzywwor1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_conujbkcv();
  X60Qini_0_texdasn3y();
  X60Qini_0_fixeak1im1();
  X60Qini_0_jsfc0lwq21();
  suRun_0_webzywwor1();
}

let cmdCount = allocFixed(4);

let cmdLine = allocFixed(4);

let nimEnviron = allocFixed(4);

function main(X60Qargc_0_webzywwor1, X60Qargv_0_webzywwor1, X60Qenvp_0_webzywwor1) {
  mem.setI32(cmdCount, X60Qargc_0_webzywwor1);
  mem.setU32(cmdLine, X60Qargv_0_webzywwor1);
  mem.setU32(nimEnviron, X60Qenvp_0_webzywwor1);
  X60Qini_0_webzywwor1();
  nimFlushStdStreams();
  return 0;
}
// generated by lengc (js backend) from fixeak1im1.c.nif

function closerFor_0_fixeak1im1(openCh_0) {
  let result_1;
  let X60Qx_0;
  switch (openCh_0) {
    case 40:
      {
        X60Qx_0 = 41;
      }
      break;
    case 91:
      {
        X60Qx_0 = 93;
      }
      break;
    case 123:
      {
        X60Qx_0 = 125;
      }
      break;
    default:
      {
        X60Qx_0 = 0;
      }
      break;
  }
  result_1 = X60Qx_0;
  return result_1;
}

function firstQQuotedChar_0_fixeak1im1(s_0, startAt_0) {
  whileStmtLabel_0: {
    var result_2 = allocFixed(8);
    var i_0 = allocFixed(4);
    mem.setI32(i_0, startAt_0);
    {
      while (true) {
        var X60Qx_13 = len_4_sysvq0asl(s_0);
        if ((((mem.i32(i_0) + 2) | 0) < X60Qx_13)) {
          var X60Qx_14;
          var X60Qx_15 = getQ_9_sysvq0asl(s_0, mem.i32(i_0));
          if ((X60Qx_15 === 39)) {
            var X60Qx_16 = getQ_9_sysvq0asl(s_0, ((mem.i32(i_0) + 2) | 0));
            X60Qx_14 = (X60Qx_16 === 39);
          } else {
            X60Qx_14 = false;
          }
          if (X60Qx_14) {
            var X60Qx_17 = getQ_9_sysvq0asl(s_0, ((mem.i32(i_0) + 1) | 0));
            mem.copy(result_2, (() => {
              var _o = allocFixed(8);
              mem.setU8(_o, X60Qx_17);
              mem.setI32((_o + 4), ((mem.i32(i_0) + 3) | 0));
              return _o;
            })(), 8);
            return result_2;
          }
          inc_1_I6wjjge_exp6svnmi1(i_0);
        } else {
          break;
        }
      }
    }
  }
  mem.copy(result_2, (() => {
    var _o = allocFixed(8);
    mem.setU8(_o, 0);
    mem.setI32((_o + 4), -1);
    return _o;
  })(), 8);
  return result_2;
}

function charAt_0_fixeak1im1(src_0, off_0) {
  let result_3;
  let X60Qx_1;
  let X60Qx_18;
  if ((0 <= off_0)) {
    let X60Qx_19 = len_4_sysvq0asl(src_0);
    X60Qx_18 = (off_0 < X60Qx_19);
  } else {
    X60Qx_18 = false;
  }
  if (X60Qx_18) {
    let X60Qx_20 = getQ_9_sysvq0asl(src_0, off_0);
    X60Qx_1 = X60Qx_20;
  } else {
    X60Qx_1 = 0;
  }
  result_3 = X60Qx_1;
  return result_3;
}

function openerFor_0_fixeak1im1(closeCh_0) {
  let result_4;
  let X60Qx_2;
  switch (closeCh_0) {
    case 41:
      {
        X60Qx_2 = 40;
      }
      break;
    case 93:
      {
        X60Qx_2 = 91;
      }
      break;
    case 125:
      {
        X60Qx_2 = 123;
      }
      break;
    default:
      {
        X60Qx_2 = 0;
      }
      break;
  }
  result_4 = X60Qx_2;
  return result_4;
}

function autoEdit_0_fixeak1im1(d_0, src_1, starts_0) {
  X60Qsc_41: {
    X60Qsc_42: {
      X60Qsc_25: {
        X60Qsc_24: {
          X60Qsc_23: {
            X60Qsc_22: {
              whileStmtLabel_4: {
                X60Qsc_21: {
                  X60Qsc_20: {
                    X60Qsc_19: {
                      X60Qsc_18: {
                        X60Qsc_17: {
                          X60Qsc_16: {
                            X60Qsc_15: {
                              X60Qsc_14: {
                                X60Qsc_13: {
                                  X60Qsc_12: {
                                    X60Qsc_11: {
                                      X60Qsc_10: {
                                        X60Qsc_9: {
                                          X60Qsc_8: {
                                            X60Qsc_7: {
                                              whileStmtLabel_0: {
                                                X60Qsc_6: {
                                                  X60Qsc_5: {
                                                    X60Qsc_4: {
                                                      X60Qsc_3: {
                                                        X60Qsc_2: {
                                                          X60Qsc_1: {
                                                            var result_5 = allocFixed(36);
                                                            eQwasmovedQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(result_5);
                                                            eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(result_5);
                                                            var X60Qx_21 = allocFixed(8);
                                                            mem.copy(X60Qx_21, nimStrDup((d_0 + 32)), 8);
                                                            mem.copy(result_5, (() => {
                                                              var _o = allocFixed(36);
                                                              mem.setU8(_o, 0);
                                                              mem.copy((_o + 4), (() => {
                                                                var _o = allocFixed(24);
                                                                mem.setI32(_o, 0);
                                                                mem.setI32((_o + 4), 0);
                                                                mem.copy((_o + 8), (() => {
                                                                  var _o = allocFixed(8);
                                                                  mem.setU32(_o, 0);
                                                                  mem.setU32((_o + 4), 0);
                                                                  return _o;
                                                                })(), 8);
                                                                mem.copy((_o + 16), (() => {
                                                                  var _o = allocFixed(8);
                                                                  mem.setU32(_o, 0);
                                                                  mem.setU32((_o + 4), 0);
                                                                  return _o;
                                                                })(), 8);
                                                                return _o;
                                                              })(), 24);
                                                              mem.copy((_o + 28), X60Qx_21, 8);
                                                              return _o;
                                                            })(), 36);
                                                            var X60Qtc_0 = allocFixed(8);
                                                            mem.copy(X60Qtc_0, (d_0 + 4), 8);
                                                            var X60Qtc_26 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 2, 112);
                                                            if (X60Qtc_26) {
                                                              var X60Qtc_27 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 103);
                                                              if (X60Qtc_27) {
                                                                var X60Qtc_28 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 2, 103);
                                                                if (X60Qtc_28) {
                                                                  var X60Qtc_29 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 99);
                                                                  if (X60Qtc_29) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1647141886);
                                                                      mem.setU32((_o + 4), strlit_0_I2428626936449221430_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_7;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1735287294);
                                                                      mem.setU32((_o + 4), strlit_0_I230973632416858749_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_8;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 762275838);
                                                                      mem.setU32((_o + 4), strlit_0_I10295204845917104656_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_6;
                                                                    }
                                                                  }
                                                                } else {
                                                                  var X60Qtc_30 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 99);
                                                                  if (X60Qtc_30) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1836016638);
                                                                      mem.setU32((_o + 4), strlit_0_I1932261347222220580_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_2;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1836016382);
                                                                      mem.setU32((_o + 4), strlit_0_I16765148769446371680_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_24;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1886938622);
                                                                      mem.setU32((_o + 4), strlit_0_I2015790770678558173_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_12;
                                                                    }
                                                                  }
                                                                }
                                                              } else {
                                                                var X60Qtc_31 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 116);
                                                                if (X60Qtc_31) {
                                                                  var X60Qtc_32 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 114);
                                                                  if (X60Qtc_32) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1852402942);
                                                                      mem.setU32((_o + 4), strlit_0_I1365890887990331020_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_23;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1684370174);
                                                                      mem.setU32((_o + 4), strlit_0_I2698326962503537505_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_25;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1650554110);
                                                                      mem.setU32((_o + 4), strlit_0_I9338050989877851798_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_17;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1634891006);
                                                                      mem.setU32((_o + 4), strlit_0_I3814179386273276921_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_21;
                                                                    }
                                                                  }
                                                                } else {
                                                                  var X60Qtc_33 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 117);
                                                                  if (X60Qtc_33) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1835955710);
                                                                      mem.setU32((_o + 4), strlit_0_I1692953341429750685_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_15;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1668183550);
                                                                      mem.setU32((_o + 4), strlit_0_I15286689157683959097_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_16;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1818327038);
                                                                      mem.setU32((_o + 4), strlit_0_I566564739971293180_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_3;
                                                                    }
                                                                  }
                                                                }
                                                              }
                                                            } else {
                                                              var X60Qtc_34 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 4, 108);
                                                              if (X60Qtc_34) {
                                                                var X60Qtc_35 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 105);
                                                                if (X60Qtc_35) {
                                                                  var X60Qtc_36 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 97);
                                                                  if (X60Qtc_36) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1936941566);
                                                                      mem.setU32((_o + 4), strlit_0_I6512003683063426779_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_1;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1936483838);
                                                                      mem.setU32((_o + 4), strlit_0_I10537485768555316406_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_10;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1986947582);
                                                                      mem.setU32((_o + 4), strlit_0_I3611050258457489801_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_19;
                                                                    }
                                                                  }
                                                                } else {
                                                                  var X60Qtc_37 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 3, 109);
                                                                  if (X60Qtc_37) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1936289278);
                                                                      mem.setU32((_o + 4), strlit_0_I2536928392218801765_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_11;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1936289278);
                                                                      mem.setU32((_o + 4), strlit_0_I2266389890549986326_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_13;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1936289278);
                                                                      mem.setU32((_o + 4), strlit_0_I1664332866290125980_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_22;
                                                                    }
                                                                  }
                                                                }
                                                              } else {
                                                                var X60Qtc_38 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 115);
                                                                if (X60Qtc_38) {
                                                                  var X60Qtc_39 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 109);
                                                                  if (X60Qtc_39) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1953852926);
                                                                      mem.setU32((_o + 4), strlit_0_I5781759467107120979_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_5;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1920098814);
                                                                      mem.setU32((_o + 4), strlit_0_I12676927569015587920_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_9;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1920234494);
                                                                      mem.setU32((_o + 4), strlit_0_I9343511476098221449_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_4;
                                                                    }
                                                                  }
                                                                } else {
                                                                  var X60Qtc_40 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 13, 99);
                                                                  if (X60Qtc_40) {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1953396222);
                                                                      mem.setU32((_o + 4), strlit_0_I10523454834011842863_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_14;
                                                                    } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1953396222);
                                                                      mem.setU32((_o + 4), strlit_0_I6110464685516040961_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_20;
                                                                    }
                                                                  } else {
                                                                    if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                                                                      var _o = allocFixed(8);
                                                                      mem.setU32(_o, 1953396222);
                                                                      mem.setU32((_o + 4), strlit_0_I4192191418491144372_exp6svnmi1);
                                                                      return _o;
                                                                    })())) {
                                                                      break X60Qsc_18;
                                                                    }
                                                                  }
                                                                }
                                                              }
                                                            }
                                                            break X60Qsc_42;
                                                          }
                                                          var a_0 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                                          var b_0 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                                          var X60Qx_22;
                                                          if ((b_0 === ((a_0 + 1) | 0))) {
                                                            var X60Qx_23 = charAt_0_fixeak1im1(src_1, a_0);
                                                            X60Qx_22 = (X60Qx_23 === 61);
                                                          } else {
                                                            X60Qx_22 = false;
                                                          }
                                                          if (X60Qx_22) {
                                                            mem.setU8(result_5, 2);
                                                            var X60Qlhs_0 = (result_5 + 4);
                                                            eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_0);
                                                            mem.copy(X60Qlhs_0, (() => {
                                                              var _o = allocFixed(24);
                                                              mem.setI32(_o, a_0);
                                                              mem.setI32((_o + 4), b_0);
                                                              mem.copy((_o + 8), (() => {
                                                                var _o = allocFixed(8);
                                                                mem.setU32(_o, 4013314);
                                                                mem.setU32((_o + 4), 0);
                                                                return _o;
                                                              })(), 8);
                                                              mem.copy((_o + 16), (() => {
                                                                var _o = allocFixed(8);
                                                                mem.setU32(_o, 1634231294);
                                                                mem.setU32((_o + 4), strlit_0_I2455841389866808686_fixeak1im1);
                                                                return _o;
                                                              })(), 8);
                                                              return _o;
                                                            })(), 24);
                                                            var X60Qlhs_1 = (result_5 + 28);
                                                            nimStrDestroy(X60Qlhs_1);
                                                            mem.copy(X60Qlhs_1, (() => {
                                                              var _o = allocFixed(8);
                                                              mem.setU32(_o, 1684628734);
                                                              mem.setU32((_o + 4), strlit_0_I16778981494557925217_fixeak1im1);
                                                              return _o;
                                                            })(), 8);
                                                          }
                                                          break X60Qsc_41;
                                                        }
                                                        var a_1 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                                        var b_1 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                                        var X60Qx_24;
                                                        var X60Qx_25;
                                                        if ((b_1 === ((a_1 + 2) | 0))) {
                                                          var X60Qx_26 = charAt_0_fixeak1im1(src_1, a_1);
                                                          X60Qx_25 = (X60Qx_26 === 61);
                                                        } else {
                                                          X60Qx_25 = false;
                                                        }
                                                        if (X60Qx_25) {
                                                          var X60Qx_27 = charAt_0_fixeak1im1(src_1, ((a_1 + 1) | 0));
                                                          X60Qx_24 = (X60Qx_27 === 61);
                                                        } else {
                                                          X60Qx_24 = false;
                                                        }
                                                        if (X60Qx_24) {
                                                          mem.setU8(result_5, 2);
                                                          var X60Qlhs_2 = (result_5 + 4);
                                                          eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_2);
                                                          mem.copy(X60Qlhs_2, (() => {
                                                            var _o = allocFixed(24);
                                                            mem.setI32(_o, a_1);
                                                            mem.setI32((_o + 4), b_1);
                                                            mem.copy((_o + 8), (() => {
                                                              var _o = allocFixed(8);
                                                              mem.setU32(_o, 15617);
                                                              mem.setU32((_o + 4), 0);
                                                              return _o;
                                                            })(), 8);
                                                            mem.copy((_o + 16), (() => {
                                                              var _o = allocFixed(8);
                                                              mem.setU32(_o, 1634231294);
                                                              mem.setU32((_o + 4), strlit_0_I9411494518201909963_fixeak1im1);
                                                              return _o;
                                                            })(), 8);
                                                            return _o;
                                                          })(), 24);
                                                          var X60Qlhs_3 = (result_5 + 28);
                                                          nimStrDestroy(X60Qlhs_3);
                                                          mem.copy(X60Qlhs_3, (() => {
                                                            var _o = allocFixed(8);
                                                            mem.setU32(_o, 1684628734);
                                                            mem.setU32((_o + 4), strlit_0_I11801016976563298038_fixeak1im1);
                                                            return _o;
                                                          })(), 8);
                                                        }
                                                        break X60Qsc_41;
                                                      }
                                                      var a_2 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                                      var b_2 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                                      var X60Qx_28;
                                                      var X60Qx_29;
                                                      if ((b_2 === ((a_2 + 2) | 0))) {
                                                        var X60Qx_30 = charAt_0_fixeak1im1(src_1, a_2);
                                                        X60Qx_29 = (X60Qx_30 === 58);
                                                      } else {
                                                        X60Qx_29 = false;
                                                      }
                                                      if (X60Qx_29) {
                                                        var X60Qx_31 = charAt_0_fixeak1im1(src_1, ((a_2 + 1) | 0));
                                                        X60Qx_28 = (X60Qx_31 === 61);
                                                      } else {
                                                        X60Qx_28 = false;
                                                      }
                                                      if (X60Qx_28) {
                                                        mem.setU8(result_5, 2);
                                                        var X60Qlhs_4 = (result_5 + 4);
                                                        eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_4);
                                                        mem.copy(X60Qlhs_4, (() => {
                                                          var _o = allocFixed(24);
                                                          mem.setI32(_o, a_2);
                                                          mem.setI32((_o + 4), b_2);
                                                          mem.copy((_o + 8), (() => {
                                                            var _o = allocFixed(8);
                                                            mem.setU32(_o, 15617);
                                                            mem.setU32((_o + 4), 0);
                                                            return _o;
                                                          })(), 8);
                                                          mem.copy((_o + 16), (() => {
                                                            var _o = allocFixed(8);
                                                            mem.setU32(_o, 1634231294);
                                                            mem.setU32((_o + 4), strlit_0_I18386017129978570811_fixeak1im1);
                                                            return _o;
                                                          })(), 8);
                                                          return _o;
                                                        })(), 24);
                                                        var X60Qlhs_5 = (result_5 + 28);
                                                        nimStrDestroy(X60Qlhs_5);
                                                        mem.copy(X60Qlhs_5, (() => {
                                                          var _o = allocFixed(8);
                                                          mem.setU32(_o, 1684628734);
                                                          mem.setU32((_o + 4), strlit_0_I11801016976563298038_fixeak1im1);
                                                          return _o;
                                                        })(), 8);
                                                      }
                                                      break X60Qsc_41;
                                                    }
                                                    var a_3 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                                    var b_3 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                                    var X60Qx_32;
                                                    var X60Qx_33;
                                                    var X60Qx_34;
                                                    if ((a_3 < b_3)) {
                                                      var X60Qx_35 = charAt_0_fixeak1im1(src_1, a_3);
                                                      X60Qx_34 = (X60Qx_35 === 101);
                                                    } else {
                                                      X60Qx_34 = false;
                                                    }
                                                    if (X60Qx_34) {
                                                      var X60Qx_36 = charAt_0_fixeak1im1(src_1, ((a_3 + 1) | 0));
                                                      X60Qx_33 = (X60Qx_36 === 110);
                                                    } else {
                                                      X60Qx_33 = false;
                                                    }
                                                    if (X60Qx_33) {
                                                      var X60Qx_37 = charAt_0_fixeak1im1(src_1, ((a_3 + 2) | 0));
                                                      X60Qx_32 = (X60Qx_37 === 100);
                                                    } else {
                                                      X60Qx_32 = false;
                                                    }
                                                    if (X60Qx_32) {
                                                      mem.setU8(result_5, 2);
                                                      var X60Qlhs_6 = (result_5 + 4);
                                                      eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_6);
                                                      mem.copy(X60Qlhs_6, (() => {
                                                        var _o = allocFixed(24);
                                                        mem.setI32(_o, a_3);
                                                        mem.setI32((_o + 4), b_3);
                                                        mem.copy((_o + 8), (() => {
                                                          var _o = allocFixed(8);
                                                          mem.setU32(_o, 0);
                                                          mem.setU32((_o + 4), 0);
                                                          return _o;
                                                        })(), 8);
                                                        mem.copy((_o + 16), (() => {
                                                          var _o = allocFixed(8);
                                                          mem.setU32(_o, 1835365118);
                                                          mem.setU32((_o + 4), strlit_0_I10082110133848163204_fixeak1im1);
                                                          return _o;
                                                        })(), 8);
                                                        return _o;
                                                      })(), 24);
                                                      var X60Qlhs_7 = (result_5 + 28);
                                                      nimStrDestroy(X60Qlhs_7);
                                                      mem.copy(X60Qlhs_7, (() => {
                                                        var _o = allocFixed(8);
                                                        mem.setU32(_o, 1835365118);
                                                        mem.setU32((_o + 4), strlit_0_I9015225879227668123_fixeak1im1);
                                                        return _o;
                                                      })(), 8);
                                                    }
                                                    break X60Qsc_41;
                                                  }
                                                  var a_4 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                                  var b_4 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                                  var X60Qx_38;
                                                  var X60Qx_39;
                                                  var X60Qx_40;
                                                  var X60Qx_41;
                                                  var X60Qx_42 = charAt_0_fixeak1im1(src_1, a_4);
                                                  if ((X60Qx_42 === 108)) {
                                                    var X60Qx_43 = charAt_0_fixeak1im1(src_1, ((a_4 + 1) | 0));
                                                    X60Qx_41 = (X60Qx_43 === 101);
                                                  } else {
                                                    X60Qx_41 = false;
                                                  }
                                                  if (X60Qx_41) {
                                                    var X60Qx_44 = charAt_0_fixeak1im1(src_1, ((a_4 + 2) | 0));
                                                    X60Qx_40 = (X60Qx_44 === 116);
                                                  } else {
                                                    X60Qx_40 = false;
                                                  }
                                                  if (X60Qx_40) {
                                                    X60Qx_39 = true;
                                                  } else {
                                                    var X60Qx_45;
                                                    var X60Qx_46;
                                                    var X60Qx_47 = charAt_0_fixeak1im1(src_1, a_4);
                                                    if ((X60Qx_47 === 118)) {
                                                      var X60Qx_48 = charAt_0_fixeak1im1(src_1, ((a_4 + 1) | 0));
                                                      X60Qx_46 = (X60Qx_48 === 97);
                                                    } else {
                                                      X60Qx_46 = false;
                                                    }
                                                    if (X60Qx_46) {
                                                      var X60Qx_49 = charAt_0_fixeak1im1(src_1, ((a_4 + 2) | 0));
                                                      X60Qx_45 = (X60Qx_49 === 114);
                                                    } else {
                                                      X60Qx_45 = false;
                                                    }
                                                    X60Qx_39 = X60Qx_45;
                                                  }
                                                  if (X60Qx_39) {
                                                    X60Qx_38 = true;
                                                  } else {
                                                    var X60Qx_50;
                                                    var X60Qx_51;
                                                    var X60Qx_52 = charAt_0_fixeak1im1(src_1, a_4);
                                                    if ((X60Qx_52 === 99)) {
                                                      var X60Qx_53 = charAt_0_fixeak1im1(src_1, ((a_4 + 1) | 0));
                                                      X60Qx_51 = (X60Qx_53 === 111);
                                                    } else {
                                                      X60Qx_51 = false;
                                                    }
                                                    if (X60Qx_51) {
                                                      var X60Qx_54 = charAt_0_fixeak1im1(src_1, ((a_4 + 2) | 0));
                                                      X60Qx_50 = (X60Qx_54 === 110);
                                                    } else {
                                                      X60Qx_50 = false;
                                                    }
                                                    X60Qx_38 = X60Qx_50;
                                                  }
                                                  var startsBinding_0 = X60Qx_38;
                                                  var X60Qx_55;
                                                  var X60Qx_56;
                                                  var X60Qx_57;
                                                  var X60Qx_58;
                                                  if ((((a_4 + 3) | 0) < b_4)) {
                                                    X60Qx_58 = startsBinding_0;
                                                  } else {
                                                    X60Qx_58 = false;
                                                  }
                                                  if (X60Qx_58) {
                                                    var X60Qx_59 = charAt_0_fixeak1im1(src_1, ((b_4 - 3) | 0));
                                                    X60Qx_57 = (X60Qx_59 === 109);
                                                  } else {
                                                    X60Qx_57 = false;
                                                  }
                                                  if (X60Qx_57) {
                                                    var X60Qx_60 = charAt_0_fixeak1im1(src_1, ((b_4 - 2) | 0));
                                                    X60Qx_56 = (X60Qx_60 === 117);
                                                  } else {
                                                    X60Qx_56 = false;
                                                  }
                                                  if (X60Qx_56) {
                                                    var X60Qx_61 = charAt_0_fixeak1im1(src_1, ((b_4 - 1) | 0));
                                                    X60Qx_55 = (X60Qx_61 === 116);
                                                  } else {
                                                    X60Qx_55 = false;
                                                  }
                                                  if (X60Qx_55) {
                                                    mem.setU8(result_5, 2);
                                                    var X60Qdesugar_0 = allocFixed(8);
                                                    mem.copy(X60Qdesugar_0, substr_0_sysvq0asl(src_1, a_4, ((b_4 - 1) | 0)), 8);
                                                    var X60Qx_62 = len_4_sysvq0asl((() => {
                                                      var _o = allocFixed(8);
                                                      mem.setU32(_o, 1634231294);
                                                      mem.setU32((_o + 4), strlit_0_I14915461790222011400_fixeak1im1);
                                                      return _o;
                                                    })());
                                                    var X60Qx_63 = len_4_sysvq0asl(X60Qdesugar_0);
                                                    var X60Qx_64 = len_4_sysvq0asl((() => {
                                                      var _o = allocFixed(8);
                                                      mem.setU32(_o, 1948264446);
                                                      mem.setU32((_o + 4), strlit_0_I10492289392165625619_fixeak1im1);
                                                      return _o;
                                                    })());
                                                    var X60Qdesugar_1 = allocFixed(8);
                                                    mem.copy(X60Qdesugar_1, newStringOfCap_0_sysvq0asl(((((X60Qx_62 + X60Qx_63) | 0) + X60Qx_64) | 0)), 8);
                                                    add_2_sysvq0asl(X60Qdesugar_1, (() => {
                                                      var _o = allocFixed(8);
                                                      mem.setU32(_o, 1634231294);
                                                      mem.setU32((_o + 4), strlit_0_I14915461790222011400_fixeak1im1);
                                                      return _o;
                                                    })());
                                                    add_2_sysvq0asl(X60Qdesugar_1, X60Qdesugar_0);
                                                    add_2_sysvq0asl(X60Qdesugar_1, (() => {
                                                      var _o = allocFixed(8);
                                                      mem.setU32(_o, 1948264446);
                                                      mem.setU32((_o + 4), strlit_0_I10492289392165625619_fixeak1im1);
                                                      return _o;
                                                    })());
                                                    var X60Qlhs_8 = (result_5 + 4);
                                                    eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_8);
                                                    var X60Qtmp_9 = allocFixed(8);
                                                    mem.copy(X60Qtmp_9, X60Qdesugar_1, 8);
                                                    nimStrWasMoved(X60Qdesugar_1);
                                                    mem.copy(X60Qlhs_8, (() => {
                                                      var _o = allocFixed(24);
                                                      mem.setI32(_o, a_4);
                                                      mem.setI32((_o + 4), b_4);
                                                      mem.copy((_o + 8), (() => {
                                                        var _o = allocFixed(8);
                                                        mem.setU32(_o, 1918989827);
                                                        mem.setU32((_o + 4), 0);
                                                        return _o;
                                                      })(), 8);
                                                      mem.copy((_o + 16), X60Qtmp_9, 8);
                                                      return _o;
                                                    })(), 24);
                                                    var X60Qlhs_10 = (result_5 + 28);
                                                    nimStrDestroy(X60Qlhs_10);
                                                    mem.copy(X60Qlhs_10, (() => {
                                                      var _o = allocFixed(8);
                                                      mem.setU32(_o, 1702065662);
                                                      mem.setU32((_o + 4), strlit_0_I2584438449918377368_fixeak1im1);
                                                      return _o;
                                                    })(), 8);
                                                    nimStrDestroy(X60Qdesugar_1);
                                                    nimStrDestroy(X60Qdesugar_0);
                                                  }
                                                  break X60Qsc_41;
                                                }
                                                var a_5 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                                var s_1 = allocFixed(4);
                                                mem.setI32(s_1, a_5);
                                                {
                                                  while (true) {
                                                    var X60Qx_65;
                                                    if ((0 < mem.i32(s_1))) {
                                                      var X60Qx_66;
                                                      var X60Qx_67 = charAt_0_fixeak1im1(src_1, ((mem.i32(s_1) - 1) | 0));
                                                      if ((X60Qx_67 === 32)) {
                                                        X60Qx_66 = true;
                                                      } else {
                                                        var X60Qx_68 = charAt_0_fixeak1im1(src_1, ((mem.i32(s_1) - 1) | 0));
                                                        X60Qx_66 = (X60Qx_68 === 9);
                                                      }
                                                      X60Qx_65 = X60Qx_66;
                                                    } else {
                                                      X60Qx_65 = false;
                                                    }
                                                    if (X60Qx_65) {
                                                      dec_1_I0nzoz91_fixeak1im1(s_1);
                                                    } else {
                                                      break;
                                                    }
                                                  }
                                                }
                                              }
                                              var X60Qx_69;
                                              var X60Qx_70;
                                              if ((mem.i32(s_1) < a_5)) {
                                                X60Qx_70 = (0 < mem.i32(s_1));
                                              } else {
                                                X60Qx_70 = false;
                                              }
                                              if (X60Qx_70) {
                                                var X60Qx_71 = charAt_0_fixeak1im1(src_1, ((mem.i32(s_1) - 1) | 0));
                                                X60Qx_69 = (!(X60Qx_71 === 58));
                                              } else {
                                                X60Qx_69 = false;
                                              }
                                              if (X60Qx_69) {
                                                mem.setU8(result_5, 2);
                                                var X60Qlhs_11 = (result_5 + 4);
                                                eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_11);
                                                mem.copy(X60Qlhs_11, (() => {
                                                  var _o = allocFixed(24);
                                                  mem.setI32(_o, mem.i32(s_1));
                                                  mem.setI32((_o + 4), a_5);
                                                  mem.copy((_o + 8), (() => {
                                                    var _o = allocFixed(8);
                                                    mem.setU32(_o, 2112002);
                                                    mem.setU32((_o + 4), 0);
                                                    return _o;
                                                  })(), 8);
                                                  mem.copy((_o + 16), (() => {
                                                    var _o = allocFixed(8);
                                                    mem.setU32(_o, 1936615934);
                                                    mem.setU32((_o + 4), strlit_0_I1519414717112445373_fixeak1im1);
                                                    return _o;
                                                  })(), 8);
                                                  return _o;
                                                })(), 24);
                                                var X60Qlhs_12 = (result_5 + 28);
                                                nimStrDestroy(X60Qlhs_12);
                                                mem.copy(X60Qlhs_12, (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 1948279294);
                                                  mem.setU32((_o + 4), strlit_0_I15961986726969760528_fixeak1im1);
                                                  return _o;
                                                })(), 8);
                                              }
                                              break X60Qsc_41;
                                            }
                                            var a_6 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                            var X60Qx_72;
                                            var X60Qx_73 = charAt_0_fixeak1im1(src_1, a_6);
                                            if ((X60Qx_73 === 47)) {
                                              var X60Qx_74 = charAt_0_fixeak1im1(src_1, ((a_6 + 1) | 0));
                                              X60Qx_72 = (X60Qx_74 === 42);
                                            } else {
                                              X60Qx_72 = false;
                                            }
                                            if (X60Qx_72) {
                                              whileStmtLabel_1: {
                                                var i_1 = allocFixed(4);
                                                mem.setI32(i_1, ((a_6 + 2) | 0));
                                                var close_0 = -1;
                                                {
                                                  while (true) {
                                                    var X60Qx_75 = len_4_sysvq0asl(src_1);
                                                    if ((((mem.i32(i_1) + 1) | 0) < X60Qx_75)) {
                                                      var X60Qx_76;
                                                      var X60Qx_77 = getQ_9_sysvq0asl(src_1, mem.i32(i_1));
                                                      if ((X60Qx_77 === 42)) {
                                                        var X60Qx_78 = getQ_9_sysvq0asl(src_1, ((mem.i32(i_1) + 1) | 0));
                                                        X60Qx_76 = (X60Qx_78 === 47);
                                                      } else {
                                                        X60Qx_76 = false;
                                                      }
                                                      if (X60Qx_76) {
                                                        close_0 = mem.i32(i_1);
                                                        break whileStmtLabel_1;
                                                      }
                                                      inc_1_I6wjjge_exp6svnmi1(i_1);
                                                    } else {
                                                      break;
                                                    }
                                                  }
                                                }
                                              }
                                              if ((a_6 < close_0)) {
                                                var inner_0 = allocFixed(8);
                                                mem.copy(inner_0, substr_0_sysvq0asl(src_1, ((a_6 + 2) | 0), ((close_0 - 1) | 0)), 8);
                                                mem.setU8(result_5, 2);
                                                var X60Qx_79 = len_4_sysvq0asl((() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 5972738);
                                                  mem.setU32((_o + 4), 0);
                                                  return _o;
                                                })());
                                                var X60Qx_80 = len_4_sysvq0asl(inner_0);
                                                var X60Qx_81 = len_4_sysvq0asl((() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 2317570);
                                                  mem.setU32((_o + 4), 0);
                                                  return _o;
                                                })());
                                                var X60Qdesugar_2 = allocFixed(8);
                                                mem.copy(X60Qdesugar_2, newStringOfCap_0_sysvq0asl(((((X60Qx_79 + X60Qx_80) | 0) + X60Qx_81) | 0)), 8);
                                                add_2_sysvq0asl(X60Qdesugar_2, (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 5972738);
                                                  mem.setU32((_o + 4), 0);
                                                  return _o;
                                                })());
                                                add_2_sysvq0asl(X60Qdesugar_2, inner_0);
                                                add_2_sysvq0asl(X60Qdesugar_2, (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 2317570);
                                                  mem.setU32((_o + 4), 0);
                                                  return _o;
                                                })());
                                                var X60Qlhs_13 = (result_5 + 4);
                                                eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_13);
                                                var X60Qtmp_14 = allocFixed(8);
                                                mem.copy(X60Qtmp_14, X60Qdesugar_2, 8);
                                                nimStrWasMoved(X60Qdesugar_2);
                                                mem.copy(X60Qlhs_13, (() => {
                                                  var _o = allocFixed(24);
                                                  mem.setI32(_o, a_6);
                                                  mem.setI32((_o + 4), ((close_0 + 2) | 0));
                                                  mem.copy((_o + 8), X60Qtmp_14, 8);
                                                  mem.copy((_o + 16), (() => {
                                                    var _o = allocFixed(8);
                                                    mem.setU32(_o, 1634231294);
                                                    mem.setU32((_o + 4), strlit_0_I2614181636077420746_fixeak1im1);
                                                    return _o;
                                                  })(), 8);
                                                  return _o;
                                                })(), 24);
                                                var X60Qlhs_15 = (result_5 + 28);
                                                nimStrDestroy(X60Qlhs_15);
                                                mem.copy(X60Qlhs_15, (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 1702065662);
                                                  mem.setU32((_o + 4), strlit_0_I14964485355411744523_fixeak1im1);
                                                  return _o;
                                                })(), 8);
                                                nimStrDestroy(X60Qdesugar_2);
                                                nimStrDestroy(inner_0);
                                              }
                                            }
                                            break X60Qsc_41;
                                          }
                                          var a_7 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                          var X60Qx_82 = charAt_0_fixeak1im1(src_1, a_7);
                                          if ((X60Qx_82 === 60)) {
                                            whileStmtLabel_2: {
                                              var depth_0 = allocFixed(4);
                                              mem.setI32(depth_0, 0);
                                              var i_2 = allocFixed(4);
                                              mem.setI32(i_2, a_7);
                                              var close_1 = -1;
                                              {
                                                while (true) {
                                                  var X60Qx_83 = len_4_sysvq0asl(src_1);
                                                  if ((mem.i32(i_2) < X60Qx_83)) {
                                                    var c_0 = getQ_9_sysvq0asl(src_1, mem.i32(i_2));
                                                    if ((c_0 === 60)) {
                                                      inc_1_I6wjjge_exp6svnmi1(depth_0);
                                                    } else {
                                                      if ((c_0 === 62)) {
                                                        dec_1_I0nzoz91_fixeak1im1(depth_0);
                                                        if ((mem.i32(depth_0) === 0)) {
                                                          close_1 = mem.i32(i_2);
                                                          break whileStmtLabel_2;
                                                        }
                                                      } else {
                                                        if ((c_0 === 10)) {
                                                          break whileStmtLabel_2;
                                                        }
                                                      }
                                                    }
                                                    inc_1_I6wjjge_exp6svnmi1(i_2);
                                                  } else {
                                                    break;
                                                  }
                                                }
                                              }
                                            }
                                            if ((a_7 < close_1)) {
                                              var inner_1 = allocFixed(8);
                                              mem.copy(inner_1, substr_0_sysvq0asl(src_1, ((a_7 + 1) | 0), ((close_1 - 1) | 0)), 8);
                                              mem.setU8(result_5, 2);
                                              var X60Qx_84 = len_4_sysvq0asl((() => {
                                                var _o = allocFixed(8);
                                                mem.setU32(_o, 23297);
                                                mem.setU32((_o + 4), 0);
                                                return _o;
                                              })());
                                              var X60Qx_85 = len_4_sysvq0asl(inner_1);
                                              var X60Qx_86 = len_4_sysvq0asl((() => {
                                                var _o = allocFixed(8);
                                                mem.setU32(_o, 23809);
                                                mem.setU32((_o + 4), 0);
                                                return _o;
                                              })());
                                              var X60Qdesugar_3 = allocFixed(8);
                                              mem.copy(X60Qdesugar_3, newStringOfCap_0_sysvq0asl(((((X60Qx_84 + X60Qx_85) | 0) + X60Qx_86) | 0)), 8);
                                              add_2_sysvq0asl(X60Qdesugar_3, (() => {
                                                var _o = allocFixed(8);
                                                mem.setU32(_o, 23297);
                                                mem.setU32((_o + 4), 0);
                                                return _o;
                                              })());
                                              add_2_sysvq0asl(X60Qdesugar_3, inner_1);
                                              add_2_sysvq0asl(X60Qdesugar_3, (() => {
                                                var _o = allocFixed(8);
                                                mem.setU32(_o, 23809);
                                                mem.setU32((_o + 4), 0);
                                                return _o;
                                              })());
                                              var X60Qlhs_16 = (result_5 + 4);
                                              eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_16);
                                              var X60Qtmp_17 = allocFixed(8);
                                              mem.copy(X60Qtmp_17, X60Qdesugar_3, 8);
                                              nimStrWasMoved(X60Qdesugar_3);
                                              mem.copy(X60Qlhs_16, (() => {
                                                var _o = allocFixed(24);
                                                mem.setI32(_o, a_7);
                                                mem.setI32((_o + 4), ((close_1 + 1) | 0));
                                                mem.copy((_o + 8), X60Qtmp_17, 8);
                                                mem.copy((_o + 16), (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 1634231294);
                                                  mem.setU32((_o + 4), strlit_0_I10344845751395038586_fixeak1im1);
                                                  return _o;
                                                })(), 8);
                                                return _o;
                                              })(), 24);
                                              var X60Qlhs_18 = (result_5 + 28);
                                              nimStrDestroy(X60Qlhs_18);
                                              mem.copy(X60Qlhs_18, (() => {
                                                var _o = allocFixed(8);
                                                mem.setU32(_o, 1702065662);
                                                mem.setU32((_o + 4), strlit_0_I10981268595210715146_fixeak1im1);
                                                return _o;
                                              })(), 8);
                                              nimStrDestroy(X60Qdesugar_3);
                                              nimStrDestroy(inner_1);
                                            }
                                          }
                                          break X60Qsc_41;
                                        }
                                        var a_8 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                        var b_5 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                        var X60Qx_87;
                                        var X60Qx_88;
                                        if ((b_5 === ((a_8 + 2) | 0))) {
                                          var X60Qx_89 = charAt_0_fixeak1im1(src_1, a_8);
                                          X60Qx_88 = (X60Qx_89 === 45);
                                        } else {
                                          X60Qx_88 = false;
                                        }
                                        if (X60Qx_88) {
                                          var X60Qx_90 = charAt_0_fixeak1im1(src_1, ((a_8 + 1) | 0));
                                          X60Qx_87 = (X60Qx_90 === 62);
                                        } else {
                                          X60Qx_87 = false;
                                        }
                                        if (X60Qx_87) {
                                          var s_2 = allocFixed(4);
                                          mem.setI32(s_2, a_8);
                                          var X60Qx_91;
                                          if ((0 < mem.i32(s_2))) {
                                            var X60Qx_92 = charAt_0_fixeak1im1(src_1, ((mem.i32(s_2) - 1) | 0));
                                            X60Qx_91 = (X60Qx_92 === 32);
                                          } else {
                                            X60Qx_91 = false;
                                          }
                                          if (X60Qx_91) {
                                            dec_1_I0nzoz91_fixeak1im1(s_2);
                                          }
                                          mem.setU8(result_5, 2);
                                          var X60Qlhs_19 = (result_5 + 4);
                                          eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_19);
                                          mem.copy(X60Qlhs_19, (() => {
                                            var _o = allocFixed(24);
                                            mem.setI32(_o, mem.i32(s_2));
                                            mem.setI32((_o + 4), b_5);
                                            mem.copy((_o + 8), (() => {
                                              var _o = allocFixed(8);
                                              mem.setU32(_o, 14849);
                                              mem.setU32((_o + 4), 0);
                                              return _o;
                                            })(), 8);
                                            mem.copy((_o + 16), (() => {
                                              var _o = allocFixed(8);
                                              mem.setU32(_o, 1634231294);
                                              mem.setU32((_o + 4), strlit_0_I10766215715090134889_fixeak1im1);
                                              return _o;
                                            })(), 8);
                                            return _o;
                                          })(), 24);
                                          var X60Qlhs_20 = (result_5 + 28);
                                          nimStrDestroy(X60Qlhs_20);
                                          mem.copy(X60Qlhs_20, (() => {
                                            var _o = allocFixed(8);
                                            mem.setU32(_o, 1769109502);
                                            mem.setU32((_o + 4), strlit_0_I7398711344762333748_fixeak1im1);
                                            return _o;
                                          })(), 8);
                                        }
                                        break X60Qsc_41;
                                      }
                                      var a_9 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                      var b_6 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                      var X60Qx_93;
                                      var X60Qx_94;
                                      var X60Qx_95;
                                      var X60Qx_96;
                                      var X60Qx_97;
                                      var X60Qx_98;
                                      if ((((a_9 + 6) | 0) <= b_6)) {
                                        var X60Qx_99 = charAt_0_fixeak1im1(src_1, a_9);
                                        X60Qx_98 = (X60Qx_99 === 101);
                                      } else {
                                        X60Qx_98 = false;
                                      }
                                      if (X60Qx_98) {
                                        var X60Qx_100 = charAt_0_fixeak1im1(src_1, ((a_9 + 1) | 0));
                                        X60Qx_97 = (X60Qx_100 === 108);
                                      } else {
                                        X60Qx_97 = false;
                                      }
                                      if (X60Qx_97) {
                                        var X60Qx_101 = charAt_0_fixeak1im1(src_1, ((a_9 + 2) | 0));
                                        X60Qx_96 = (X60Qx_101 === 115);
                                      } else {
                                        X60Qx_96 = false;
                                      }
                                      if (X60Qx_96) {
                                        var X60Qx_102 = charAt_0_fixeak1im1(src_1, ((a_9 + 3) | 0));
                                        X60Qx_95 = (X60Qx_102 === 101);
                                      } else {
                                        X60Qx_95 = false;
                                      }
                                      if (X60Qx_95) {
                                        var X60Qx_103 = charAt_0_fixeak1im1(src_1, ((b_6 - 2) | 0));
                                        X60Qx_94 = (X60Qx_103 === 105);
                                      } else {
                                        X60Qx_94 = false;
                                      }
                                      if (X60Qx_94) {
                                        var X60Qx_104 = charAt_0_fixeak1im1(src_1, ((b_6 - 1) | 0));
                                        X60Qx_93 = (X60Qx_104 === 102);
                                      } else {
                                        X60Qx_93 = false;
                                      }
                                      if (X60Qx_93) {
                                        mem.setU8(result_5, 2);
                                        var X60Qlhs_21 = (result_5 + 4);
                                        eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_21);
                                        mem.copy(X60Qlhs_21, (() => {
                                          var _o = allocFixed(24);
                                          mem.setI32(_o, a_9);
                                          mem.setI32((_o + 4), b_6);
                                          mem.copy((_o + 8), (() => {
                                            var _o = allocFixed(8);
                                            mem.setU32(_o, 1768711678);
                                            mem.setU32((_o + 4), strlit_0_I13424873862977158440_fixeak1im1);
                                            return _o;
                                          })(), 8);
                                          mem.copy((_o + 16), (() => {
                                            var _o = allocFixed(8);
                                            mem.setU32(_o, 1634231294);
                                            mem.setU32((_o + 4), strlit_0_I11316302792861065249_fixeak1im1);
                                            return _o;
                                          })(), 8);
                                          return _o;
                                        })(), 24);
                                        var X60Qlhs_22 = (result_5 + 28);
                                        nimStrDestroy(X60Qlhs_22);
                                        mem.copy(X60Qlhs_22, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1702065662);
                                          mem.setU32((_o + 4), strlit_0_I14996553479182787230_fixeak1im1);
                                          return _o;
                                        })(), 8);
                                      }
                                      break X60Qsc_41;
                                    }
                                    var a_10 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                                    var b_7 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                                    var cur_0 = charAt_0_fixeak1im1(src_1, a_10);
                                    var X60Qx_105;
                                    if ((b_7 === ((a_10 + 1) | 0))) {
                                      var X60Qx_106;
                                      var X60Qx_107;
                                      if ((cur_0 === 41)) {
                                        X60Qx_107 = true;
                                      } else {
                                        X60Qx_107 = (cur_0 === 93);
                                      }
                                      if (X60Qx_107) {
                                        X60Qx_106 = true;
                                      } else {
                                        X60Qx_106 = (cur_0 === 125);
                                      }
                                      X60Qx_105 = X60Qx_106;
                                    } else {
                                      X60Qx_105 = false;
                                    }
                                    if (X60Qx_105) {
                                      var X60Qtmptup_0 = allocFixed(8);
                                      mem.copy(X60Qtmptup_0, firstQQuotedChar_0_fixeak1im1((d_0 + 12), 0), 8);
                                      var Q__0 = mem.u8At(X60Qtmptup_0);
                                      var after1_0 = mem.i32((X60Qtmptup_0 + 4));
                                      var openerCh_0 = 0;
                                      if ((0 < after1_0)) {
                                        var X60Qtmptup_1 = allocFixed(8);
                                        mem.copy(X60Qtmptup_1, firstQQuotedChar_0_fixeak1im1((d_0 + 12), after1_0), 8);
                                        var o2_0 = mem.u8At(X60Qtmptup_1);
                                        var Q__1 = mem.i32((X60Qtmptup_1 + 4));
                                        openerCh_0 = o2_0;
                                      }
                                      var want_0 = closerFor_0_fixeak1im1(openerCh_0);
                                      var X60Qx_108;
                                      if ((!(want_0 === 0))) {
                                        X60Qx_108 = (!(want_0 === cur_0));
                                      } else {
                                        X60Qx_108 = false;
                                      }
                                      if (X60Qx_108) {
                                        mem.setU8(result_5, 2);
                                        var X60Qx_3 = allocFixed(8);
                                        mem.copy(X60Qx_3, dollarQ_1_str7j0ifg(want_0), 8);
                                        var X60Qdesugar_4 = allocFixed(8);
                                        mem.copy(X60Qdesugar_4, dollarQ_1_str7j0ifg(cur_0), 8);
                                        var X60Qdesugar_5 = allocFixed(8);
                                        mem.copy(X60Qdesugar_5, dollarQ_1_str7j0ifg(want_0), 8);
                                        var X60Qx_109 = len_4_sysvq0asl((() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1634231294);
                                          mem.setU32((_o + 4), strlit_0_I14915461790222011400_fixeak1im1);
                                          return _o;
                                        })());
                                        var X60Qx_110 = len_4_sysvq0asl(X60Qdesugar_4);
                                        var X60Qx_111 = len_4_sysvq0asl((() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1948264446);
                                          mem.setU32((_o + 4), strlit_0_I16246072967864884300_fixeak1im1);
                                          return _o;
                                        })());
                                        var X60Qx_112 = len_4_sysvq0asl(X60Qdesugar_5);
                                        var X60Qx_113 = len_4_sysvq0asl((() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 9985);
                                          mem.setU32((_o + 4), 0);
                                          return _o;
                                        })());
                                        var X60Qdesugar_6 = allocFixed(8);
                                        mem.copy(X60Qdesugar_6, newStringOfCap_0_sysvq0asl(((((((((X60Qx_109 + X60Qx_110) | 0) + X60Qx_111) | 0) + X60Qx_112) | 0) + X60Qx_113) | 0)), 8);
                                        add_2_sysvq0asl(X60Qdesugar_6, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1634231294);
                                          mem.setU32((_o + 4), strlit_0_I14915461790222011400_fixeak1im1);
                                          return _o;
                                        })());
                                        add_2_sysvq0asl(X60Qdesugar_6, X60Qdesugar_4);
                                        add_2_sysvq0asl(X60Qdesugar_6, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1948264446);
                                          mem.setU32((_o + 4), strlit_0_I16246072967864884300_fixeak1im1);
                                          return _o;
                                        })());
                                        add_2_sysvq0asl(X60Qdesugar_6, X60Qdesugar_5);
                                        add_2_sysvq0asl(X60Qdesugar_6, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 9985);
                                          mem.setU32((_o + 4), 0);
                                          return _o;
                                        })());
                                        var X60Qlhs_23 = (result_5 + 4);
                                        eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_23);
                                        var X60Qx_9 = allocFixed(8);
                                        mem.copy(X60Qx_9, nimStrDup(X60Qx_3), 8);
                                        var X60Qtmp_24 = allocFixed(8);
                                        mem.copy(X60Qtmp_24, X60Qdesugar_6, 8);
                                        nimStrWasMoved(X60Qdesugar_6);
                                        mem.copy(X60Qlhs_23, (() => {
                                          var _o = allocFixed(24);
                                          mem.setI32(_o, a_10);
                                          mem.setI32((_o + 4), b_7);
                                          mem.copy((_o + 8), X60Qx_9, 8);
                                          mem.copy((_o + 16), X60Qtmp_24, 8);
                                          return _o;
                                        })(), 24);
                                        var X60Qdesugar_7 = allocFixed(8);
                                        mem.copy(X60Qdesugar_7, dollarQ_1_str7j0ifg(want_0), 8);
                                        var X60Qx_114 = len_4_sysvq0asl((() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1634231294);
                                          mem.setU32((_o + 4), strlit_0_I13435722917833300375_fixeak1im1);
                                          return _o;
                                        })());
                                        var X60Qx_115 = len_4_sysvq0asl(X60Qdesugar_7);
                                        var X60Qx_116 = len_4_sysvq0asl((() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 9985);
                                          mem.setU32((_o + 4), 0);
                                          return _o;
                                        })());
                                        var X60Qdesugar_8 = allocFixed(8);
                                        mem.copy(X60Qdesugar_8, newStringOfCap_0_sysvq0asl(((((X60Qx_114 + X60Qx_115) | 0) + X60Qx_116) | 0)), 8);
                                        add_2_sysvq0asl(X60Qdesugar_8, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1634231294);
                                          mem.setU32((_o + 4), strlit_0_I13435722917833300375_fixeak1im1);
                                          return _o;
                                        })());
                                        add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_7);
                                        add_2_sysvq0asl(X60Qdesugar_8, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 9985);
                                          mem.setU32((_o + 4), 0);
                                          return _o;
                                        })());
                                        var X60Qlhs_25 = (result_5 + 28);
                                        nimStrDestroy(X60Qlhs_25);
                                        mem.copy(X60Qlhs_25, X60Qdesugar_8, 8);
                                        nimStrWasMoved(X60Qdesugar_8);
                                        nimStrDestroy(X60Qdesugar_8);
                                        nimStrDestroy(X60Qdesugar_7);
                                        nimStrDestroy(X60Qdesugar_6);
                                        nimStrDestroy(X60Qdesugar_5);
                                        nimStrDestroy(X60Qdesugar_4);
                                      }
                                    }
                                    break X60Qsc_41;
                                  }
                                  var e_1 = lineContentEndOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)));
                                  var X60Qx_117 = charAt_0_fixeak1im1(src_1, ((e_1 - 1) | 0));
                                  if ((!(X60Qx_117 === 58))) {
                                    mem.setU8(result_5, 2);
                                    var X60Qlhs_26 = (result_5 + 4);
                                    eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_26);
                                    mem.copy(X60Qlhs_26, (() => {
                                      var _o = allocFixed(24);
                                      mem.setI32(_o, e_1);
                                      mem.setI32((_o + 4), e_1);
                                      mem.copy((_o + 8), (() => {
                                        var _o = allocFixed(8);
                                        mem.setU32(_o, 14849);
                                        mem.setU32((_o + 4), 0);
                                        return _o;
                                      })(), 8);
                                      mem.copy((_o + 16), (() => {
                                        var _o = allocFixed(8);
                                        mem.setU32(_o, 1936615934);
                                        mem.setU32((_o + 4), strlit_0_I2564216074254103176_fixeak1im1);
                                        return _o;
                                      })(), 8);
                                      return _o;
                                    })(), 24);
                                    var X60Qlhs_27 = (result_5 + 28);
                                    nimStrDestroy(X60Qlhs_27);
                                    mem.copy(X60Qlhs_27, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1936615934);
                                      mem.setU32((_o + 4), strlit_0_I2564216074254103176_fixeak1im1);
                                      return _o;
                                    })(), 8);
                                  }
                                  break X60Qsc_41;
                                }
                                if (mem.u8At((d_0 + 40))) {
                                  var e_2 = lineContentEndOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 52)));
                                  var X60Qx_118 = charAt_0_fixeak1im1(src_1, ((e_2 - 1) | 0));
                                  if ((!(X60Qx_118 === 61))) {
                                    mem.setU8(result_5, 2);
                                    var X60Qlhs_28 = (result_5 + 4);
                                    eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_28);
                                    mem.copy(X60Qlhs_28, (() => {
                                      var _o = allocFixed(24);
                                      mem.setI32(_o, e_2);
                                      mem.setI32((_o + 4), e_2);
                                      mem.copy((_o + 8), (() => {
                                        var _o = allocFixed(8);
                                        mem.setU32(_o, 4005890);
                                        mem.setU32((_o + 4), 0);
                                        return _o;
                                      })(), 8);
                                      mem.copy((_o + 16), (() => {
                                        var _o = allocFixed(8);
                                        mem.setU32(_o, 1936615934);
                                        mem.setU32((_o + 4), strlit_0_I8625455319723392933_fixeak1im1);
                                        return _o;
                                      })(), 8);
                                      return _o;
                                    })(), 24);
                                    var X60Qlhs_29 = (result_5 + 28);
                                    nimStrDestroy(X60Qlhs_29);
                                    mem.copy(X60Qlhs_29, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1936615934);
                                      mem.setU32((_o + 4), strlit_0_I14099350819119747234_fixeak1im1);
                                      return _o;
                                    })(), 8);
                                  }
                                }
                                break X60Qsc_41;
                              }
                              var a_11 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                              var b_8 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                              var X60Qx_119;
                              var X60Qx_120 = charAt_0_fixeak1im1(src_1, a_11);
                              if ((X60Qx_120 === 39)) {
                                X60Qx_119 = (a_11 < b_8);
                              } else {
                                X60Qx_119 = false;
                              }
                              if (X60Qx_119) {
                                mem.setU8(result_5, 2);
                                var X60Qlhs_30 = (result_5 + 4);
                                eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_30);
                                mem.copy(X60Qlhs_30, (() => {
                                  var _o = allocFixed(24);
                                  mem.setI32(_o, b_8);
                                  mem.setI32((_o + 4), b_8);
                                  mem.copy((_o + 8), (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 9985);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })(), 8);
                                  mem.copy((_o + 16), (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 1936615934);
                                    mem.setU32((_o + 4), strlit_0_I11518128541944848614_fixeak1im1);
                                    return _o;
                                  })(), 8);
                                  return _o;
                                })(), 24);
                                var X60Qlhs_31 = (result_5 + 28);
                                nimStrDestroy(X60Qlhs_31);
                                mem.copy(X60Qlhs_31, (() => {
                                  var _o = allocFixed(8);
                                  mem.setU32(_o, 1684300286);
                                  mem.setU32((_o + 4), strlit_0_I4261256446345198406_fixeak1im1);
                                  return _o;
                                })(), 8);
                              }
                              break X60Qsc_41;
                            }
                            var a_12 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                            var b_9 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                            var cur_1 = charAt_0_fixeak1im1(src_1, a_12);
                            var X60Qx_121;
                            if ((b_9 === ((a_12 + 1) | 0))) {
                              var X60Qx_122;
                              var X60Qx_123;
                              if ((cur_1 === 41)) {
                                X60Qx_123 = true;
                              } else {
                                X60Qx_123 = (cur_1 === 93);
                              }
                              if (X60Qx_123) {
                                X60Qx_122 = true;
                              } else {
                                X60Qx_122 = (cur_1 === 125);
                              }
                              X60Qx_121 = X60Qx_122;
                            } else {
                              X60Qx_121 = false;
                            }
                            if (X60Qx_121) {
                              mem.setU8(result_5, 2);
                              var X60Qdesugar_9 = allocFixed(8);
                              mem.copy(X60Qdesugar_9, dollarQ_1_str7j0ifg(cur_1), 8);
                              var X60Qx_124 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1835365118);
                                mem.setU32((_o + 4), strlit_0_I10791520901386574205_fixeak1im1);
                                return _o;
                              })());
                              var X60Qx_125 = len_4_sysvq0asl(X60Qdesugar_9);
                              var X60Qx_126 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 9985);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })());
                              var X60Qdesugar_10 = allocFixed(8);
                              mem.copy(X60Qdesugar_10, newStringOfCap_0_sysvq0asl(((((X60Qx_124 + X60Qx_125) | 0) + X60Qx_126) | 0)), 8);
                              add_2_sysvq0asl(X60Qdesugar_10, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1835365118);
                                mem.setU32((_o + 4), strlit_0_I10791520901386574205_fixeak1im1);
                                return _o;
                              })());
                              add_2_sysvq0asl(X60Qdesugar_10, X60Qdesugar_9);
                              add_2_sysvq0asl(X60Qdesugar_10, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 9985);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })());
                              var X60Qlhs_32 = (result_5 + 4);
                              eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_32);
                              var X60Qtmp_33 = allocFixed(8);
                              mem.copy(X60Qtmp_33, X60Qdesugar_10, 8);
                              nimStrWasMoved(X60Qdesugar_10);
                              mem.copy(X60Qlhs_32, (() => {
                                var _o = allocFixed(24);
                                mem.setI32(_o, a_12);
                                mem.setI32((_o + 4), b_9);
                                mem.copy((_o + 8), (() => {
                                  var _o = allocFixed(8);
                                  mem.setU32(_o, 0);
                                  mem.setU32((_o + 4), 0);
                                  return _o;
                                })(), 8);
                                mem.copy((_o + 16), X60Qtmp_33, 8);
                                return _o;
                              })(), 24);
                              var X60Qdesugar_11 = allocFixed(8);
                              mem.copy(X60Qdesugar_11, dollarQ_1_str7j0ifg(cur_1), 8);
                              var X60Qx_127 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1835365118);
                                mem.setU32((_o + 4), strlit_0_I12067509928535166814_fixeak1im1);
                                return _o;
                              })());
                              var X60Qx_128 = len_4_sysvq0asl(X60Qdesugar_11);
                              var X60Qx_129 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 9985);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })());
                              var X60Qdesugar_12 = allocFixed(8);
                              mem.copy(X60Qdesugar_12, newStringOfCap_0_sysvq0asl(((((X60Qx_127 + X60Qx_128) | 0) + X60Qx_129) | 0)), 8);
                              add_2_sysvq0asl(X60Qdesugar_12, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1835365118);
                                mem.setU32((_o + 4), strlit_0_I12067509928535166814_fixeak1im1);
                                return _o;
                              })());
                              add_2_sysvq0asl(X60Qdesugar_12, X60Qdesugar_11);
                              add_2_sysvq0asl(X60Qdesugar_12, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 9985);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })());
                              var X60Qlhs_34 = (result_5 + 28);
                              nimStrDestroy(X60Qlhs_34);
                              mem.copy(X60Qlhs_34, X60Qdesugar_12, 8);
                              nimStrWasMoved(X60Qdesugar_12);
                              nimStrDestroy(X60Qdesugar_12);
                              nimStrDestroy(X60Qdesugar_11);
                              nimStrDestroy(X60Qdesugar_10);
                              nimStrDestroy(X60Qdesugar_9);
                            }
                            break X60Qsc_41;
                          }
                          var a_13 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                          var openCur_0 = charAt_0_fixeak1im1(src_1, a_13);
                          var want_1 = closerFor_0_fixeak1im1(openCur_0);
                          if ((!(want_1 === 0))) {
                            var e_3 = lineContentEndOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)));
                            mem.setU8(result_5, 2);
                            var X60Qx_4 = allocFixed(8);
                            mem.copy(X60Qx_4, dollarQ_1_str7j0ifg(want_1), 8);
                            var X60Qdesugar_13 = allocFixed(8);
                            mem.copy(X60Qdesugar_13, dollarQ_1_str7j0ifg(want_1), 8);
                            var X60Qx_130 = len_4_sysvq0asl((() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1684300286);
                              mem.setU32((_o + 4), strlit_0_I8176046943660040380_fixeak1im1);
                              return _o;
                            })());
                            var X60Qx_131 = len_4_sysvq0asl(X60Qdesugar_13);
                            var X60Qx_132 = len_4_sysvq0asl((() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 9985);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })());
                            var X60Qdesugar_14 = allocFixed(8);
                            mem.copy(X60Qdesugar_14, newStringOfCap_0_sysvq0asl(((((X60Qx_130 + X60Qx_131) | 0) + X60Qx_132) | 0)), 8);
                            add_2_sysvq0asl(X60Qdesugar_14, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1684300286);
                              mem.setU32((_o + 4), strlit_0_I8176046943660040380_fixeak1im1);
                              return _o;
                            })());
                            add_2_sysvq0asl(X60Qdesugar_14, X60Qdesugar_13);
                            add_2_sysvq0asl(X60Qdesugar_14, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 9985);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })());
                            var X60Qlhs_35 = (result_5 + 4);
                            eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_35);
                            var X60Qx_10 = allocFixed(8);
                            mem.copy(X60Qx_10, nimStrDup(X60Qx_4), 8);
                            var X60Qtmp_36 = allocFixed(8);
                            mem.copy(X60Qtmp_36, X60Qdesugar_14, 8);
                            nimStrWasMoved(X60Qdesugar_14);
                            mem.copy(X60Qlhs_35, (() => {
                              var _o = allocFixed(24);
                              mem.setI32(_o, e_3);
                              mem.setI32((_o + 4), e_3);
                              mem.copy((_o + 8), X60Qx_10, 8);
                              mem.copy((_o + 16), X60Qtmp_36, 8);
                              return _o;
                            })(), 24);
                            var X60Qdesugar_15 = allocFixed(8);
                            mem.copy(X60Qdesugar_15, dollarQ_1_str7j0ifg(want_1), 8);
                            var X60Qx_133 = len_4_sysvq0asl((() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1684300286);
                              mem.setU32((_o + 4), strlit_0_I1271536908756224135_fixeak1im1);
                              return _o;
                            })());
                            var X60Qx_134 = len_4_sysvq0asl(X60Qdesugar_15);
                            var X60Qx_135 = len_4_sysvq0asl((() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 9985);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })());
                            var X60Qdesugar_16 = allocFixed(8);
                            mem.copy(X60Qdesugar_16, newStringOfCap_0_sysvq0asl(((((X60Qx_133 + X60Qx_134) | 0) + X60Qx_135) | 0)), 8);
                            add_2_sysvq0asl(X60Qdesugar_16, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1684300286);
                              mem.setU32((_o + 4), strlit_0_I1271536908756224135_fixeak1im1);
                              return _o;
                            })());
                            add_2_sysvq0asl(X60Qdesugar_16, X60Qdesugar_15);
                            add_2_sysvq0asl(X60Qdesugar_16, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 9985);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })());
                            var X60Qlhs_37 = (result_5 + 28);
                            nimStrDestroy(X60Qlhs_37);
                            mem.copy(X60Qlhs_37, X60Qdesugar_16, 8);
                            nimStrWasMoved(X60Qdesugar_16);
                            nimStrDestroy(X60Qdesugar_16);
                            nimStrDestroy(X60Qdesugar_15);
                            nimStrDestroy(X60Qdesugar_14);
                            nimStrDestroy(X60Qdesugar_13);
                          }
                          break X60Qsc_41;
                        }
                        var a_14 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                        var X60Qx_136 = charAt_0_fixeak1im1(src_1, a_14);
                        if ((X60Qx_136 === 9)) {
                          whileStmtLabel_3: {
                            var X60Qx_137 = getQ_7_Ir8kccm_fixeak1im1(starts_0, ((mem.i32((d_0 + 20)) - 1) | 0));
                            var lineStart_0 = mem.i32(X60Qx_137);
                            var onlyWs_0 = true;
                            var i_4 = allocFixed(4);
                            mem.setI32(i_4, lineStart_0);
                            {
                              while ((mem.i32(i_4) < a_14)) {
                                var X60Qx_138;
                                var X60Qx_139 = getQ_9_sysvq0asl(src_1, mem.i32(i_4));
                                if ((!(X60Qx_139 === 32))) {
                                  var X60Qx_140 = getQ_9_sysvq0asl(src_1, mem.i32(i_4));
                                  X60Qx_138 = (!(X60Qx_140 === 9));
                                } else {
                                  X60Qx_138 = false;
                                }
                                if (X60Qx_138) {
                                  onlyWs_0 = false;
                                  break whileStmtLabel_3;
                                }
                                inc_1_I6wjjge_exp6svnmi1(i_4);
                              }
                            }
                          }
                          if ((!onlyWs_0)) {
                            mem.setU8(result_5, 2);
                            var X60Qlhs_38 = (result_5 + 4);
                            eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_38);
                            mem.copy(X60Qlhs_38, (() => {
                              var _o = allocFixed(24);
                              mem.setI32(_o, a_14);
                              mem.setI32((_o + 4), ((a_14 + 1) | 0));
                              mem.copy((_o + 8), (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 8193);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })(), 8);
                              mem.copy((_o + 16), (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1885696766);
                                mem.setU32((_o + 4), strlit_0_I953839753781071610_fixeak1im1);
                                return _o;
                              })(), 8);
                              return _o;
                            })(), 24);
                            var X60Qlhs_39 = (result_5 + 28);
                            nimStrDestroy(X60Qlhs_39);
                            mem.copy(X60Qlhs_39, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1702065662);
                              mem.setU32((_o + 4), strlit_0_I11923376507425688096_fixeak1im1);
                              return _o;
                            })(), 8);
                          }
                        }
                        break X60Qsc_41;
                      }
                      var e_4 = lineContentEndOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)));
                      var X60Qx_141 = charAt_0_fixeak1im1(src_1, ((e_4 - 1) | 0));
                      if ((!(X60Qx_141 === 34))) {
                        mem.setU8(result_5, 2);
                        var X60Qlhs_40 = (result_5 + 4);
                        eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_40);
                        mem.copy(X60Qlhs_40, (() => {
                          var _o = allocFixed(24);
                          mem.setI32(_o, e_4);
                          mem.setI32((_o + 4), e_4);
                          mem.copy((_o + 8), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 8705);
                            mem.setU32((_o + 4), 0);
                            return _o;
                          })(), 8);
                          mem.copy((_o + 16), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1936615934);
                            mem.setU32((_o + 4), strlit_0_I10131629090932128305_fixeak1im1);
                            return _o;
                          })(), 8);
                          return _o;
                        })(), 24);
                        var X60Qlhs_41 = (result_5 + 28);
                        nimStrDestroy(X60Qlhs_41);
                        mem.copy(X60Qlhs_41, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1684300286);
                          mem.setU32((_o + 4), strlit_0_I3118387172418653687_fixeak1im1);
                          return _o;
                        })(), 8);
                      }
                      break X60Qsc_41;
                    }
                    var a_15 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
                    var b_10 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
                    var X60Qx_142;
                    if ((b_10 === ((a_15 + 2) | 0))) {
                      var X60Qx_143 = charAt_0_fixeak1im1(src_1, a_15);
                      X60Qx_142 = (X60Qx_143 === 48);
                    } else {
                      X60Qx_142 = false;
                    }
                    if (X60Qx_142) {
                      var letter_0 = charAt_0_fixeak1im1(src_1, ((a_15 + 1) | 0));
                      var lower_0 = 0;
                      switch (letter_0) {
                        case 79:
                          {
                            lower_0 = 111;
                          }
                          break;
                        case 88:
                          {
                            lower_0 = 120;
                          }
                          break;
                        case 66:
                          {
                            lower_0 = 98;
                          }
                          break;
                        default:
                          {
                          }
                          break;
                      }
                      if ((!(lower_0 === 0))) {
                        mem.setU8(result_5, 2);
                        var X60Qx_5 = allocFixed(8);
                        mem.copy(X60Qx_5, dollarQ_1_str7j0ifg(lower_0), 8);
                        var X60Qdesugar_17 = allocFixed(8);
                        mem.copy(X60Qdesugar_17, dollarQ_1_str7j0ifg(letter_0), 8);
                        var X60Qx_144 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 2003791102);
                          mem.setU32((_o + 4), strlit_0_I18331364155580600483_fixeak1im1);
                          return _o;
                        })());
                        var X60Qx_145 = len_4_sysvq0asl(X60Qdesugar_17);
                        var X60Qx_146 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1881155582);
                          mem.setU32((_o + 4), strlit_0_I4711016545483820726_fixeak1im1);
                          return _o;
                        })());
                        var X60Qdesugar_18 = allocFixed(8);
                        mem.copy(X60Qdesugar_18, newStringOfCap_0_sysvq0asl(((((X60Qx_144 + X60Qx_145) | 0) + X60Qx_146) | 0)), 8);
                        add_2_sysvq0asl(X60Qdesugar_18, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 2003791102);
                          mem.setU32((_o + 4), strlit_0_I18331364155580600483_fixeak1im1);
                          return _o;
                        })());
                        add_2_sysvq0asl(X60Qdesugar_18, X60Qdesugar_17);
                        add_2_sysvq0asl(X60Qdesugar_18, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1881155582);
                          mem.setU32((_o + 4), strlit_0_I4711016545483820726_fixeak1im1);
                          return _o;
                        })());
                        var X60Qlhs_42 = (result_5 + 4);
                        eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_42);
                        var X60Qx_11 = allocFixed(8);
                        mem.copy(X60Qx_11, nimStrDup(X60Qx_5), 8);
                        var X60Qtmp_43 = allocFixed(8);
                        mem.copy(X60Qtmp_43, X60Qdesugar_18, 8);
                        nimStrWasMoved(X60Qdesugar_18);
                        mem.copy(X60Qlhs_42, (() => {
                          var _o = allocFixed(24);
                          mem.setI32(_o, ((a_15 + 1) | 0));
                          mem.setI32((_o + 4), ((a_15 + 2) | 0));
                          mem.copy((_o + 8), X60Qx_11, 8);
                          mem.copy((_o + 16), X60Qtmp_43, 8);
                          return _o;
                        })(), 24);
                        var X60Qdesugar_19 = allocFixed(8);
                        mem.copy(X60Qdesugar_19, dollarQ_1_str7j0ifg(lower_0), 8);
                        var X60Qx_147 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1702065662);
                          mem.setU32((_o + 4), strlit_0_I3390647262588430136_fixeak1im1);
                          return _o;
                        })());
                        var X60Qx_148 = len_4_sysvq0asl(X60Qdesugar_19);
                        var X60Qx_149 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 9985);
                          mem.setU32((_o + 4), 0);
                          return _o;
                        })());
                        var X60Qdesugar_20 = allocFixed(8);
                        mem.copy(X60Qdesugar_20, newStringOfCap_0_sysvq0asl(((((X60Qx_147 + X60Qx_148) | 0) + X60Qx_149) | 0)), 8);
                        add_2_sysvq0asl(X60Qdesugar_20, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1702065662);
                          mem.setU32((_o + 4), strlit_0_I3390647262588430136_fixeak1im1);
                          return _o;
                        })());
                        add_2_sysvq0asl(X60Qdesugar_20, X60Qdesugar_19);
                        add_2_sysvq0asl(X60Qdesugar_20, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 9985);
                          mem.setU32((_o + 4), 0);
                          return _o;
                        })());
                        var X60Qlhs_44 = (result_5 + 28);
                        nimStrDestroy(X60Qlhs_44);
                        mem.copy(X60Qlhs_44, X60Qdesugar_20, 8);
                        nimStrWasMoved(X60Qdesugar_20);
                        nimStrDestroy(X60Qdesugar_20);
                        nimStrDestroy(X60Qdesugar_19);
                        nimStrDestroy(X60Qdesugar_18);
                        nimStrDestroy(X60Qdesugar_17);
                      }
                    }
                    break X60Qsc_41;
                  }
                  var e_5 = len_4_sysvq0asl(src_1);
                  mem.setU8(result_5, 2);
                  var X60Qlhs_45 = (result_5 + 4);
                  eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_45);
                  mem.copy(X60Qlhs_45, (() => {
                    var _o = allocFixed(24);
                    mem.setI32(_o, e_5);
                    mem.setI32((_o + 4), e_5);
                    mem.copy((_o + 8), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 593305603);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })(), 8);
                    mem.copy((_o + 16), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1869374462);
                      mem.setU32((_o + 4), strlit_0_I16524665832086204301_fixeak1im1);
                      return _o;
                    })(), 8);
                    return _o;
                  })(), 24);
                  var X60Qlhs_46 = (result_5 + 28);
                  nimStrDestroy(X60Qlhs_46);
                  mem.copy(X60Qlhs_46, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1684300286);
                    mem.setU32((_o + 4), strlit_0_I14997301237576242043_fixeak1im1);
                    return _o;
                  })(), 8);
                  break X60Qsc_41;
                }
                var e_6 = lineEndOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)));
                var s_4 = allocFixed(4);
                mem.setI32(s_4, e_6);
                {
                  while (true) {
                    var X60Qx_150;
                    if ((0 < mem.i32(s_4))) {
                      var X60Qx_151;
                      var X60Qx_152 = getQ_9_sysvq0asl(src_1, ((mem.i32(s_4) - 1) | 0));
                      if ((X60Qx_152 === 32)) {
                        X60Qx_151 = true;
                      } else {
                        var X60Qx_153 = getQ_9_sysvq0asl(src_1, ((mem.i32(s_4) - 1) | 0));
                        X60Qx_151 = (X60Qx_153 === 9);
                      }
                      X60Qx_150 = X60Qx_151;
                    } else {
                      X60Qx_150 = false;
                    }
                    if (X60Qx_150) {
                      dec_1_I0nzoz91_fixeak1im1(s_4);
                    } else {
                      break;
                    }
                  }
                }
              }
              if ((mem.i32(s_4) < e_6)) {
                mem.setU8(result_5, 2);
                var X60Qlhs_47 = (result_5 + 4);
                eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_47);
                mem.copy(X60Qlhs_47, (() => {
                  var _o = allocFixed(24);
                  mem.setI32(_o, mem.i32(s_4));
                  mem.setI32((_o + 4), e_6);
                  mem.copy((_o + 8), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 0);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })(), 8);
                  mem.copy((_o + 16), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1835365118);
                    mem.setU32((_o + 4), strlit_0_I15917817268795199016_fixeak1im1);
                    return _o;
                  })(), 8);
                  return _o;
                })(), 24);
                var X60Qlhs_48 = (result_5 + 28);
                nimStrDestroy(X60Qlhs_48);
                mem.copy(X60Qlhs_48, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1818584318);
                  mem.setU32((_o + 4), strlit_0_I18179865674072288426_fixeak1im1);
                  return _o;
                })(), 8);
              }
              break X60Qsc_41;
            }
            var X60Qx_154;
            var X60Qx_155 = len_4_sysvq0asl(src_1);
            if ((0 < X60Qx_155)) {
              var X60Qx_156 = len_4_sysvq0asl(src_1);
              var X60Qx_157 = getQ_9_sysvq0asl(src_1, ((X60Qx_156 - 1) | 0));
              X60Qx_154 = (!(X60Qx_157 === 10));
            } else {
              X60Qx_154 = false;
            }
            if (X60Qx_154) {
              var e_7 = len_4_sysvq0asl(src_1);
              mem.setU8(result_5, 2);
              var X60Qlhs_49 = (result_5 + 4);
              eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_49);
              mem.copy(X60Qlhs_49, (() => {
                var _o = allocFixed(24);
                mem.setI32(_o, e_7);
                mem.setI32((_o + 4), e_7);
                mem.copy((_o + 8), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 2561);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })(), 8);
                mem.copy((_o + 16), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1684300286);
                  mem.setU32((_o + 4), strlit_0_I15830389122368428676_fixeak1im1);
                  return _o;
                })(), 8);
                return _o;
              })(), 24);
              var X60Qlhs_50 = (result_5 + 28);
              nimStrDestroy(X60Qlhs_50);
              mem.copy(X60Qlhs_50, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1684956670);
                mem.setU32((_o + 4), strlit_0_I5348471251041807345_fixeak1im1);
                return _o;
              })(), 8);
            }
            break X60Qsc_41;
          }
          var nl_0 = lineEndOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)));
          var X60Qx_158 = find_3_str7j0ifg((d_0 + 12), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1886938622);
            mem.setU32((_o + 4), strlit_0_I437387965556335341_fixeak1im1);
            return _o;
          })(), 0, -1);
          if ((0 <= X60Qx_158)) {
            var X60Qx_159;
            if ((0 < nl_0)) {
              var X60Qx_160 = charAt_0_fixeak1im1(src_1, ((nl_0 - 1) | 0));
              X60Qx_159 = (X60Qx_160 === 13);
            } else {
              X60Qx_159 = false;
            }
            if (X60Qx_159) {
              mem.setU8(result_5, 2);
              var X60Qlhs_51 = (result_5 + 4);
              eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_51);
              mem.copy(X60Qlhs_51, (() => {
                var _o = allocFixed(24);
                mem.setI32(_o, ((nl_0 - 1) | 0));
                mem.setI32((_o + 4), nl_0);
                mem.copy((_o + 8), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 0);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })(), 8);
                mem.copy((_o + 16), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1852793854);
                  mem.setU32((_o + 4), strlit_0_I4535891151395753622_fixeak1im1);
                  return _o;
                })(), 8);
                return _o;
              })(), 24);
              var X60Qlhs_52 = (result_5 + 28);
              nimStrDestroy(X60Qlhs_52);
              mem.copy(X60Qlhs_52, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1702065662);
                mem.setU32((_o + 4), strlit_0_I1549749459204987071_fixeak1im1);
                return _o;
              })(), 8);
            }
          } else {
            var X60Qx_161 = find_3_str7j0ifg((d_0 + 12), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1886938622);
              mem.setU32((_o + 4), strlit_0_I8942659628978202412_fixeak1im1);
              return _o;
            })(), 0, -1);
            if ((0 <= X60Qx_161)) {
              var X60Qx_162;
              var X60Qx_163;
              var X60Qx_164 = len_4_sysvq0asl(src_1);
              if ((nl_0 <= X60Qx_164)) {
                var X60Qx_165 = charAt_0_fixeak1im1(src_1, nl_0);
                X60Qx_163 = (X60Qx_165 === 10);
              } else {
                X60Qx_163 = false;
              }
              if (X60Qx_163) {
                var X60Qx_166 = charAt_0_fixeak1im1(src_1, ((nl_0 - 1) | 0));
                X60Qx_162 = (!(X60Qx_166 === 13));
              } else {
                X60Qx_162 = false;
              }
              if (X60Qx_162) {
                mem.setU8(result_5, 2);
                var X60Qlhs_53 = (result_5 + 4);
                eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_53);
                mem.copy(X60Qlhs_53, (() => {
                  var _o = allocFixed(24);
                  mem.setI32(_o, nl_0);
                  mem.setI32((_o + 4), nl_0);
                  mem.copy((_o + 8), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 3329);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })(), 8);
                  mem.copy((_o + 16), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852793854);
                    mem.setU32((_o + 4), strlit_0_I16286580443920198575_fixeak1im1);
                    return _o;
                  })(), 8);
                  return _o;
                })(), 24);
                var X60Qlhs_54 = (result_5 + 28);
                nimStrDestroy(X60Qlhs_54);
                mem.copy(X60Qlhs_54, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1702065662);
                  mem.setU32((_o + 4), strlit_0_I9357512781724370368_fixeak1im1);
                  return _o;
                })(), 8);
              }
            }
          }
          break X60Qsc_41;
        }
        var X60Qx_167;
        var X60Qx_168;
        var X60Qx_169;
        var X60Qx_170 = len_4_sysvq0asl(src_1);
        if ((3 <= X60Qx_170)) {
          var X60Qx_171 = getQ_9_sysvq0asl(src_1, 0);
          X60Qx_169 = (X60Qx_171 === 239);
        } else {
          X60Qx_169 = false;
        }
        if (X60Qx_169) {
          var X60Qx_172 = getQ_9_sysvq0asl(src_1, 1);
          X60Qx_168 = (X60Qx_172 === 187);
        } else {
          X60Qx_168 = false;
        }
        if (X60Qx_168) {
          var X60Qx_173 = getQ_9_sysvq0asl(src_1, 2);
          X60Qx_167 = (X60Qx_173 === 191);
        } else {
          X60Qx_167 = false;
        }
        if (X60Qx_167) {
          mem.setU8(result_5, 2);
          var X60Qlhs_55 = (result_5 + 4);
          eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_55);
          mem.copy(X60Qlhs_55, (() => {
            var _o = allocFixed(24);
            mem.setI32(_o, 0);
            mem.setI32((_o + 4), 3);
            mem.copy((_o + 8), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 0);
              mem.setU32((_o + 4), 0);
              return _o;
            })(), 8);
            mem.copy((_o + 16), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1920234494);
              mem.setU32((_o + 4), strlit_0_I7428794750700265195_fixeak1im1);
              return _o;
            })(), 8);
            return _o;
          })(), 24);
          var X60Qlhs_56 = (result_5 + 28);
          nimStrDestroy(X60Qlhs_56);
          mem.copy(X60Qlhs_56, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1835365118);
            mem.setU32((_o + 4), strlit_0_I18016193771835146099_fixeak1im1);
            return _o;
          })(), 8);
        }
        break X60Qsc_41;
      }
      var a_16 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 24)));
      var b_11 = lineColToOffset_0_texdasn3y(src_1, starts_0, mem.i32((d_0 + 20)), mem.i32((d_0 + 28)));
      var X60Qx_174;
      if ((b_11 === ((a_16 + 1) | 0))) {
        var X60Qx_175 = charAt_0_fixeak1im1(src_1, a_16);
        X60Qx_174 = (X60Qx_175 === 59);
      } else {
        X60Qx_174 = false;
      }
      if (X60Qx_174) {
        mem.setU8(result_5, 2);
        var X60Qlhs_57 = (result_5 + 4);
        eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(X60Qlhs_57);
        mem.copy(X60Qlhs_57, (() => {
          var _o = allocFixed(24);
          mem.setI32(_o, a_16);
          mem.setI32((_o + 4), b_11);
          mem.copy((_o + 8), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 0);
            mem.setU32((_o + 4), 0);
            return _o;
          })(), 8);
          mem.copy((_o + 16), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1835365118);
            mem.setU32((_o + 4), strlit_0_I9405065548570263465_fixeak1im1);
            return _o;
          })(), 8);
          return _o;
        })(), 24);
        var X60Qlhs_58 = (result_5 + 28);
        nimStrDestroy(X60Qlhs_58);
        mem.copy(X60Qlhs_58, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1835365118);
          mem.setU32((_o + 4), strlit_0_I18122894641777448348_fixeak1im1);
          return _o;
        })(), 8);
      }
      break X60Qsc_41;
    }
  }
  return result_5;
}

function planFix_0_fixeak1im1(d_1, src_2, starts_1) {
  let result_6 = allocFixed(36);
  eQwasmovedQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(result_6);
  eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(result_6);
  let X60Qx_176 = allocFixed(36);
  mem.copy(X60Qx_176, autoEdit_0_fixeak1im1(d_1, src_2, starts_1), 36);
  mem.copy(result_6, X60Qx_176, 36);
  if ((mem.u8At(result_6) === 0)) {
    let X60Qx_177 = len_4_sysvq0asl((d_1 + 32));
    if ((0 < X60Qx_177)) {
      mem.setU8(result_6, 1);
      let X60Qlhs_59 = (result_6 + 28);
      nimStrDestroy(X60Qlhs_59);
      let X60Qx_178 = allocFixed(8);
      mem.copy(X60Qx_178, nimStrDup((d_1 + 32)), 8);
      mem.copy(X60Qlhs_59, X60Qx_178, 8);
    } else {
      let kb_0 = allocFixed(8);
      mem.copy(kb_0, suggestionFor_0_exp6svnmi1((d_1 + 4)), 8);
      let X60Qx_179 = len_4_sysvq0asl(kb_0);
      if ((0 < X60Qx_179)) {
        mem.setU8(result_6, 1);
        let X60Qlhs_60 = (result_6 + 28);
        nimStrDestroy(X60Qlhs_60);
        mem.copy(X60Qlhs_60, kb_0, 8);
        nimStrWasMoved(kb_0);
      }
      nimStrDestroy(kb_0);
    }
  }
  return result_6;
}

function candidateFixes_0_fixeak1im1(d_2, src_3, starts_2) {
  let result_7 = allocFixed(8);
  eQwasMoved_1_I1chrd91_fixeak1im1(result_7);
  eQdestroy_1_Ij6whwo1_fixeak1im1(result_7);
  let X60Qx_180 = allocFixed(8);
  mem.copy(X60Qx_180, newSeqUninit_0_I8ijgpr1_fixeak1im1(0), 8);
  mem.copy(result_7, X60Qx_180, 8);
  let primary_0 = allocFixed(36);
  mem.copy(primary_0, autoEdit_0_fixeak1im1(d_2, src_3, starts_2), 36);
  if ((mem.u8At(primary_0) === 2)) {
    let X60Qtmp_61 = allocFixed(36);
    mem.copy(X60Qtmp_61, primary_0, 36);
    eQwasmovedQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(primary_0);
    add_0_Isjtmx6_fixeak1im1(result_7, X60Qtmp_61);
  }
  let X60Qx_181;
  let X60Qx_182 = eqQ_20_sysvq0asl((d_2 + 4), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936289278);
    mem.setU32((_o + 4), strlit_0_I2536928392218801765_exp6svnmi1);
    return _o;
  })());
  if (X60Qx_182) {
    X60Qx_181 = mem.u8At((d_2 + 40));
  } else {
    X60Qx_181 = false;
  }
  if (X60Qx_181) {
    let a_17 = lineColToOffset_0_texdasn3y(src_3, starts_2, mem.i32((d_2 + 20)), mem.i32((d_2 + 24)));
    let cur_2 = charAt_0_fixeak1im1(src_3, a_17);
    let oa_0 = lineColToOffset_0_texdasn3y(src_3, starts_2, mem.i32((d_2 + 52)), mem.i32((d_2 + 56)));
    let openCur_1 = charAt_0_fixeak1im1(src_3, oa_0);
    let wantOpen_0 = openerFor_0_fixeak1im1(cur_2);
    let X60Qx_183;
    let X60Qx_184;
    let X60Qx_185;
    let X60Qx_186;
    if ((openCur_1 === 40)) {
      X60Qx_186 = true;
    } else {
      X60Qx_186 = (openCur_1 === 91);
    }
    if (X60Qx_186) {
      X60Qx_185 = true;
    } else {
      X60Qx_185 = (openCur_1 === 123);
    }
    if (X60Qx_185) {
      X60Qx_184 = (!(wantOpen_0 === 0));
    } else {
      X60Qx_184 = false;
    }
    if (X60Qx_184) {
      X60Qx_183 = (!(wantOpen_0 === openCur_1));
    } else {
      X60Qx_183 = false;
    }
    if (X60Qx_183) {
      let X60Qx_6 = allocFixed(8);
      mem.copy(X60Qx_6, dollarQ_1_str7j0ifg(wantOpen_0), 8);
      let X60Qdesugar_21 = allocFixed(8);
      mem.copy(X60Qdesugar_21, dollarQ_1_str7j0ifg(openCur_1), 8);
      let X60Qdesugar_22 = allocFixed(8);
      mem.copy(X60Qdesugar_22, dollarQ_1_str7j0ifg(wantOpen_0), 8);
      let X60Qx_187 = len_4_sysvq0asl((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1634231294);
        mem.setU32((_o + 4), strlit_0_I2342421160380909407_fixeak1im1);
        return _o;
      })());
      let X60Qx_188 = len_4_sysvq0asl(X60Qdesugar_21);
      let X60Qx_189 = len_4_sysvq0asl((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1948264446);
        mem.setU32((_o + 4), strlit_0_I16246072967864884300_fixeak1im1);
        return _o;
      })());
      let X60Qx_190 = len_4_sysvq0asl(X60Qdesugar_22);
      let X60Qx_191 = len_4_sysvq0asl((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 9985);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      let X60Qdesugar_23 = allocFixed(8);
      mem.copy(X60Qdesugar_23, newStringOfCap_0_sysvq0asl(((((((((X60Qx_187 + X60Qx_188) | 0) + X60Qx_189) | 0) + X60Qx_190) | 0) + X60Qx_191) | 0)), 8);
      add_2_sysvq0asl(X60Qdesugar_23, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1634231294);
        mem.setU32((_o + 4), strlit_0_I2342421160380909407_fixeak1im1);
        return _o;
      })());
      add_2_sysvq0asl(X60Qdesugar_23, X60Qdesugar_21);
      add_2_sysvq0asl(X60Qdesugar_23, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1948264446);
        mem.setU32((_o + 4), strlit_0_I16246072967864884300_fixeak1im1);
        return _o;
      })());
      add_2_sysvq0asl(X60Qdesugar_23, X60Qdesugar_22);
      add_2_sysvq0asl(X60Qdesugar_23, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 9985);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      let X60Qdesugar_24 = allocFixed(8);
      mem.copy(X60Qdesugar_24, dollarQ_1_str7j0ifg(wantOpen_0), 8);
      let X60Qx_192 = len_4_sysvq0asl((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 544370686);
        mem.setU32((_o + 4), strlit_0_I5774869565030773885_fixeak1im1);
        return _o;
      })());
      let X60Qx_193 = len_4_sysvq0asl(X60Qdesugar_24);
      let X60Qx_194 = len_4_sysvq0asl((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 9985);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      let X60Qdesugar_25 = allocFixed(8);
      mem.copy(X60Qdesugar_25, newStringOfCap_0_sysvq0asl(((((X60Qx_192 + X60Qx_193) | 0) + X60Qx_194) | 0)), 8);
      add_2_sysvq0asl(X60Qdesugar_25, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 544370686);
        mem.setU32((_o + 4), strlit_0_I5774869565030773885_fixeak1im1);
        return _o;
      })());
      add_2_sysvq0asl(X60Qdesugar_25, X60Qdesugar_24);
      add_2_sysvq0asl(X60Qdesugar_25, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 9985);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      let X60Qx_12 = allocFixed(8);
      mem.copy(X60Qx_12, nimStrDup(X60Qx_6), 8);
      let X60Qtmp_62 = allocFixed(8);
      mem.copy(X60Qtmp_62, X60Qdesugar_23, 8);
      nimStrWasMoved(X60Qdesugar_23);
      let X60Qtmp_63 = allocFixed(8);
      mem.copy(X60Qtmp_63, X60Qdesugar_25, 8);
      nimStrWasMoved(X60Qdesugar_25);
      add_0_Isjtmx6_fixeak1im1(result_7, (() => {
        let _o = allocFixed(36);
        mem.setU8(_o, 2);
        mem.copy((_o + 4), (() => {
          let _o = allocFixed(24);
          mem.setI32(_o, oa_0);
          mem.setI32((_o + 4), ((oa_0 + 1) | 0));
          mem.copy((_o + 8), X60Qx_12, 8);
          mem.copy((_o + 16), X60Qtmp_62, 8);
          return _o;
        })(), 24);
        mem.copy((_o + 28), X60Qtmp_63, 8);
        return _o;
      })());
      nimStrDestroy(X60Qdesugar_25);
      nimStrDestroy(X60Qdesugar_24);
      nimStrDestroy(X60Qdesugar_23);
      nimStrDestroy(X60Qdesugar_22);
      nimStrDestroy(X60Qdesugar_21);
    }
  }
  eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(primary_0);
  return result_7;
  eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(primary_0);
  return result_7;
}

function dec_1_I0nzoz91_fixeak1im1(x_3) {
  mem.setI32(x_3, ((mem.i32(x_3) - 1) | 0));
}

function getQ_7_Ir8kccm_fixeak1im1(s_6, i_5) {
  let X60Qx_195;
  if ((i_5 < mem.i32(s_6))) {
    X60Qx_195 = (0 <= i_5);
  } else {
    X60Qx_195 = false;
  }
  if ((!X60Qx_195)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_exp6svnmi1);
      return _o;
    })());
  }
  let result_8;
  result_8 = (mem.u32((s_6 + 4)) + (i_5 * 4));
  return result_8;
}

function newSeqUninit_0_I8ijgpr1_fixeak1im1(size_1) {
  let result_9 = allocFixed(8);
  if ((size_1 === 0)) {
    mem.copy(result_9, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_I1etcmt1_fixeak1im1(size_1);
    let X60Qx_196 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_9, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), X60Qx_196);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_9 + 4)) === 0))) {
      let X60Qx_197 = allocFixed(8);
      mem.setU32(X60Qx_197, 1634036990);
      mem.setU32((X60Qx_197 + 4), strlit_0_I15750996627617194403_exp6svnmi1);
    } else {
      mem.setI32(result_9, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_9;
}

function add_0_Isjtmx6_fixeak1im1(s_7, elem_1) {
  let L_0 = mem.i32(s_7);
  let X60Qx_198 = capInBytes_0_If3ta1b_fixeak1im1(s_7);
  if ((X60Qx_198 < ((Math.imul(L_0, 36) + 36) | 0))) {
    let X60Qx_199 = resize_0_Il4lbfe1_fixeak1im1(s_7, 1);
    if ((!X60Qx_199)) {
      eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(elem_1);
      return;
    }
  }
  inc_1_I6wjjge_exp6svnmi1(s_7);
  mem.copy((mem.u32((s_7 + 4)) + (L_0 * 36)), elem_1, 36);
}

function memSizeInBytes_0_I1etcmt1_fixeak1im1(size_3) {
  let result_10;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_3, 36);
  result_10 = X60QconstRefTemp_0;
  if (false) {
    result_10 = 2147483647;
  }
  return result_10;
}

function capInBytes_0_If3ta1b_fixeak1im1(s_9) {
  let result_11;
  let X60Qx_7;
  if ((!(mem.u32((s_9 + 4)) === 0))) {
    let X60Qx_200 = allocatedSize_0_sysvq0asl(mem.u32((s_9 + 4)));
    X60Qx_7 = X60Qx_200;
  } else {
    X60Qx_7 = 0;
  }
  result_11 = X60Qx_7;
  return result_11;
}

function resize_0_Il4lbfe1_fixeak1im1(dest_1, addedElements_1) {
  let result_12;
  let X60Qx_201 = capInBytes_0_If3ta1b_fixeak1im1(dest_1);
  let oldCap_0 = Math.trunc((X60Qx_201 / 36));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_1);
  let memSize_1 = memSizeInBytes_0_I1etcmt1_fixeak1im1(newCap_0);
  let X60Qx_202 = realloc_1_sysvq0asl(mem.u32((dest_1 + 4)), memSize_1);
  mem.setU32((dest_1 + 4), X60Qx_202);
  if ((mem.u32((dest_1 + 4)) === 0)) {
    mem.setI32(dest_1, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    result_12 = false;
  } else {
    result_12 = true;
  }
  return result_12;
}

function eQdestroy_1_Iv9ij5i1_fixeak1im1(s_14) {
  if ((!(mem.u32((s_14 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_6 = allocFixed(4);
      mem.setI32(i_6, 0);
      {
        while ((mem.i32(i_6) < mem.i32(s_14))) {
          inc_1_I6wjjge_exp6svnmi1(i_6);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_14 + 4)));
  }
}

function eQwasMoved_1_Ix88qzs1_fixeak1im1(s_15) {
  mem.setI32(s_15, 0);
  mem.setU32((s_15 + 4), 0);
}

function eQdestroy_1_Ij6whwo1_fixeak1im1(s_17) {
  if ((!(mem.u32((s_17 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_10 = allocFixed(4);
      mem.setI32(i_10, 0);
      {
        while ((mem.i32(i_10) < mem.i32(s_17))) {
          eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1((mem.u32((s_17 + 4)) + (mem.i32(i_10) * 36)));
          inc_1_I6wjjge_exp6svnmi1(i_10);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_17 + 4)));
  }
}

function eQwasMoved_1_I1chrd91_fixeak1im1(s_18) {
  mem.setI32(s_18, 0);
  mem.setU32((s_18 + 4), 0);
}

function newSeqUninit_0_Iggfvwp_fixeak1im1(size_6) {
  let result_15 = allocFixed(8);
  if ((size_6 === 0)) {
    mem.copy(result_15, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_6);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_4 = memSizeInBytes_0_Inv7kg3_fixeak1im1(size_6);
    let X60Qx_213 = alloc_1_sysvq0asl(memSize_4);
    mem.copy(result_15, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_6);
      mem.setU32((_o + 4), X60Qx_213);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_15 + 4)) === 0))) {
      let X60Qx_214 = allocFixed(8);
      mem.setU32(X60Qx_214, 1634036990);
      mem.setU32((X60Qx_214 + 4), strlit_0_I15750996627617194403_exp6svnmi1);
    } else {
      mem.setI32(result_15, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_4);
    }
  }
  return result_15;
}

function capInBytes_0_Iet286n_fixeak1im1(s_19) {
  let result_16;
  let X60Qx_8;
  if ((!(mem.u32((s_19 + 4)) === 0))) {
    let X60Qx_215 = allocatedSize_0_sysvq0asl(mem.u32((s_19 + 4)));
    X60Qx_8 = X60Qx_215;
  } else {
    X60Qx_8 = 0;
  }
  result_16 = X60Qx_8;
  return result_16;
}

function memSizeInBytes_0_Inv7kg3_fixeak1im1(size_7) {
  let result_17;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_7, 4);
  result_17 = X60QconstRefTemp_0;
  if (false) {
    result_17 = 2147483647;
  }
  return result_17;
}

function eQdestroyQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(dest_0) {
  nimStrDestroy((dest_0 + 28));
  eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y((dest_0 + 4));
}

function eQwasmovedQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(dest_0) {
  eQwasmovedQ_SX54extX45dit0texdasn3y_0_texdasn3y((dest_0 + 4));
  nimStrWasMoved((dest_0 + 28));
}

function eQdupQ_SX50lannedX46ix0fixeak1im1_0_fixeak1im1(src_0) {
  let dest_0 = allocFixed(36);
  mem.setU8(dest_0, mem.u8At(src_0));
  let X60Qx_216 = allocFixed(24);
  mem.copy(X60Qx_216, eQdupQ_SX54extX45dit0texdasn3y_0_texdasn3y((src_0 + 4)), 24);
  mem.copy((dest_0 + 4), X60Qx_216, 24);
  let X60Qx_217 = allocFixed(8);
  mem.copy(X60Qx_217, nimStrDup((src_0 + 28)), 8);
  mem.copy((dest_0 + 28), X60Qx_217, 8);
  return dest_0;
}

let X60QiniGuard_0_fixeak1im1 = allocFixed(1);

function X60Qini_0_fixeak1im1() {
  if (mem.u8At(X60QiniGuard_0_fixeak1im1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_fixeak1im1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_conujbkcv();
  X60Qini_0_texdasn3y();
  X60Qini_0_exp6svnmi1();
}
// generated by lengc (js backend) from sysvq0asl.c.nif

function min_2_sysvq0asl(x_204, y_161) {
  let result_5;
  let X60Qx_2;
  if ((x_204 <= y_161)) {
    X60Qx_2 = x_204;
  } else {
    X60Qx_2 = y_161;
  }
  result_5 = X60Qx_2;
  return result_5;
}

function max_2_sysvq0asl(x_211, y_168) {
  let result_12;
  let X60Qx_8;
  if ((y_168 <= x_211)) {
    X60Qx_8 = x_211;
  } else {
    X60Qx_8 = y_168;
  }
  result_12 = X60Qx_8;
  return result_12;
}

function dollarQ_0_sysvq0asl(x_224) {
  var result_19 = allocFixed(8);
  nimStrWasMoved(result_19);
  nimStrDestroy(result_19);
  mem.copy(result_19, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((x_224 < 10n)) {
    nimStrDestroy(result_19);
    var X60Qx_57 = nimIcheckB(Number(BigInt.asIntN(32, x_224)), 9);
    var X60Qx_58 = allocFixed(8);
    mem.copy(X60Qx_58, substr_0_sysvq0asl((NegTen_0_sysvq0asl + (X60Qx_57 * 8)), 1, 1), 8);
    mem.copy(result_19, X60Qx_58, 8);
  } else {
    whileStmtLabel_1: {
      whileStmtLabel_0: {
        var y_208 = x_224;
        {
          while (true) {
            add_1_sysvq0asl(result_19, Number(BigInt.asUintN(8, BigInt.asUintN(64, ((y_208 % 10n) + 48n)))));
            y_208 = (y_208 / 10n);
            if ((y_208 === 0n)) {
              break whileStmtLabel_0;
            }
          }
        }
      }
      var X60Qx_59 = len_4_sysvq0asl(result_19);
      var last_3 = ((X60Qx_59 - 1) | 0);
      var i_25 = allocFixed(4);
      mem.setI32(i_25, 0);
      var X60Qx_60 = len_4_sysvq0asl(result_19);
      var b_29 = Math.trunc((X60Qx_60 / 2));
      {
        while ((mem.i32(i_25) < b_29)) {
          var ch_1 = getQ_9_sysvq0asl(result_19, mem.i32(i_25));
          var X60Qx_61 = getQ_9_sysvq0asl(result_19, ((last_3 - mem.i32(i_25)) | 0));
          putQ_9_sysvq0asl(result_19, mem.i32(i_25), X60Qx_61);
          putQ_9_sysvq0asl(result_19, ((last_3 - mem.i32(i_25)) | 0), ch_1);
          inc_1_I6wjjge_exp6svnmi1(i_25);
        }
      }
    }
  }
  return result_19;
}

function dollarQ_1_sysvq0asl(x_225) {
  let result_20 = allocFixed(8);
  nimStrWasMoved(result_20);
  if ((x_225 < 0n)) {
    if ((-10n < x_225)) {
      nimStrDestroy(result_20);
      let X60Qx_62 = nimIcheckB(Number(BigInt.asIntN(32, BigInt.asIntN(64, (-x_225)))), 9);
      let X60Qx_63 = allocFixed(8);
      mem.copy(X60Qx_63, nimStrDup((NegTen_0_sysvq0asl + (X60Qx_62 * 8))), 8);
      mem.copy(result_20, X60Qx_63, 8);
    } else {
      if ((x_225 === -9223372036854775808n)) {
        nimStrDestroy(result_20);
        let X60Qtmp_0 = allocFixed(8);
        mem.copy(X60Qtmp_0, dollarQ_0_sysvq0asl(BigInt.asUintN(64, x_225)), 8);
        let X60Qx_64 = allocFixed(8);
        mem.copy(X60Qx_64, ampQ_0_sysvq0asl((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 11521);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), X60Qtmp_0), 8);
        mem.copy(result_20, X60Qx_64, 8);
        nimStrDestroy(X60Qtmp_0);
      } else {
        nimStrDestroy(result_20);
        let X60Qtmp_1 = allocFixed(8);
        mem.copy(X60Qtmp_1, dollarQ_1_sysvq0asl(BigInt.asIntN(64, (0n - x_225))), 8);
        let X60Qx_65 = allocFixed(8);
        mem.copy(X60Qx_65, ampQ_0_sysvq0asl((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 11521);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), X60Qtmp_1), 8);
        mem.copy(result_20, X60Qx_65, 8);
        nimStrDestroy(X60Qtmp_1);
      }
    }
  } else {
    if ((x_225 < 10n)) {
      nimStrDestroy(result_20);
      mem.copy(result_20, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
      add_1_sysvq0asl(result_20, Number(BigInt.asUintN(8, BigInt.asIntN(64, (x_225 + 48n)))));
    } else {
      nimStrDestroy(result_20);
      let X60Qx_66 = allocFixed(8);
      mem.copy(X60Qx_66, dollarQ_0_sysvq0asl(BigInt.asUintN(64, x_225)), 8);
      mem.copy(result_20, X60Qx_66, 8);
    }
  }
  return result_20;
}

function dollarQ_2_sysvq0asl(x_226) {
  let result_21 = allocFixed(8);
  nimStrWasMoved(result_21);
  nimStrDestroy(result_21);
  let X60Qx_67 = allocFixed(8);
  mem.copy(X60Qx_67, dollarQ_1_sysvq0asl(BigInt(x_226)), 8);
  mem.copy(result_21, X60Qx_67, 8);
  return result_21;
}

function nimNoopFlush_0_sysvq0asl() {
}

let gExitFlush_0_sysvq0asl = allocFixed(4);

mem.setU32(gExitFlush_0_sysvq0asl, _fnid(nimNoopFlush_0_sysvq0asl));

function nimFlushStdStreams() {
  _fns[mem.u32(gExitFlush_0_sysvq0asl)]();
}

function cAbort_0_sysvq0asl() {
  _fns[mem.u32(gExitFlush_0_sysvq0asl)]();
  abort();
}

function copyMem_0_sysvq0asl(dest_4, src_3, size_3) {
  memcpy(dest_4, src_3, size_3);
}

function cmpMem_0_sysvq0asl(a_5, b_6, size_5) {
  let result_29;
  let X60Qx_77 = memcmp(a_5, b_6, size_5);
  result_29 = X60Qx_77;
  return result_29;
}

function zeroMem_0_sysvq0asl(dest_6, size_6) {
  memset(dest_6, 0, size_6);
}

function raiseOutOfMem_0_sysvq0asl() {
  cAbort_0_sysvq0asl();
}

function align_0_sysvq0asl(address_0, alignment_0) {
  let result_30;
  result_30 = (((address_0 + ((alignment_0 - 1) | 0)) | 0) & (~((alignment_0 - 1) | 0)));
  return result_30;
}

function roundup_0_sysvq0asl(x_297, v_0) {
  let result_31;
  result_31 = (((x_297 + ((v_0 - 1) | 0)) | 0) & (~((v_0 - 1) | 0)));
  return result_31;
}

function osAllocPages_0_sysvq0asl(size_7) {
  let result_32;
  let X60Qx_78 = mmap(0, size_7, (1 | 2), ((32 | 2) | 0), -1, 0);
  result_32 = X60Qx_78;
  let X60Qx_79;
  if ((result_32 === 0)) {
    X60Qx_79 = true;
  } else {
    X60Qx_79 = (result_32 === -1);
  }
  if (X60Qx_79) {
    raiseOutOfMem_0_sysvq0asl();
  }
  return result_32;
}

function osTryAllocPages_0_sysvq0asl(size_8) {
  let result_33;
  let X60Qx_80 = mmap(0, size_8, (1 | 2), ((32 | 2) | 0), -1, 0);
  result_33 = X60Qx_80;
  if ((result_33 === -1)) {
    result_33 = 0;
  }
  return result_33;
}

function osDeallocPages_0_sysvq0asl(p_9, size_9) {
}

function msbit_0_sysvq0asl(x_302) {
  let result_34;
  let X60Qx_13;
  if ((x_302 <= 65535)) {
    let X60Qx_14;
    if ((x_302 <= 255)) {
      X60Qx_14 = 0;
    } else {
      X60Qx_14 = 8;
    }
    X60Qx_13 = X60Qx_14;
  } else {
    let X60Qx_15;
    if ((x_302 <= 16777215)) {
      X60Qx_15 = 16;
    } else {
      X60Qx_15 = 24;
    }
    X60Qx_13 = X60Qx_15;
  }
  let a_74 = X60Qx_13;
  let X60Qx_81 = nimUcheckB(((x_302 >>> a_74) & 255), 255);
  result_34 = ((mem.i8((fsLookupTable_0_sysvq0asl + X60Qx_81)) + a_74) | 0);
  return result_34;
}

function lsbit_0_sysvq0asl(x_303) {
  let result_35;
  let X60Qx_82 = msbit_0_sysvq0asl(((x_303 & ((((~x_303) >>> 0) + 1) >>> 0)) >>> 0));
  result_35 = X60Qx_82;
  return result_35;
}

function setBit_0_sysvq0asl(nr_0, dest_7) {
  mem.setU32(dest_7, ((mem.u32(dest_7) | ((1 << (nr_0 & 31)) >>> 0)) >>> 0));
}

function clearBit_0_sysvq0asl(nr_1, dest_8) {
  mem.setU32(dest_8, ((mem.u32(dest_8) & ((~((1 << (nr_1 & 31)) >>> 0)) >>> 0)) >>> 0));
}

function mappingSearch_0_sysvq0asl(r_0, fl_0, sl_0) {
  let X60Qx_83 = msbit_0_sysvq0asl(mem.i32(r_0));
  let X60Qx_84 = roundup_0_sysvq0asl((1 << ((X60Qx_83 - 5) | 0)), 4096);
  let t_3 = ((X60Qx_84 - 1) | 0);
  mem.setI32(r_0, ((mem.i32(r_0) + t_3) | 0));
  mem.setI32(r_0, (mem.i32(r_0) & (~t_3)));
  let X60Qx_85 = min_2_sysvq0asl(mem.i32(r_0), 1056964608);
  mem.setI32(r_0, X60Qx_85);
  let X60Qx_86 = msbit_0_sysvq0asl(mem.i32(r_0));
  mem.setI32(fl_0, X60Qx_86);
  mem.setI32(sl_0, (((mem.i32(r_0) >> ((mem.i32(fl_0) - 5) | 0)) - 32) | 0));
  dec_0_Ig5i8xp_str7j0ifg(fl_0, 6);
}

function mappingInsert_0_sysvq0asl(r_1) {
  let result_36 = allocFixed(8);
  let fl_4 = msbit_0_sysvq0asl(r_1);
  let sl_5 = (((r_1 >> ((fl_4 - 5) | 0)) - 32) | 0);
  fl_4 = ((fl_4 - 6) | 0);
  mem.copy(result_36, (() => {
    let _o = allocFixed(8);
    mem.setI32(_o, fl_4);
    mem.setI32((_o + 4), sl_5);
    return _o;
  })(), 8);
  return result_36;
}

function findSuitableBlock_0_sysvq0asl(a_6, fl_1, sl_1) {
  let result_37;
  let X60Qx_87 = nimIcheckB(mem.i32(fl_1), 23);
  let tmp_2 = ((mem.u32(((a_6 + 2052) + (X60Qx_87 * 4))) & ((((~0) >>> 0) << mem.i32(sl_1)) >>> 0)) >>> 0);
  result_37 = 0;
  if ((!(tmp_2 === 0))) {
    let X60Qx_88 = lsbit_0_sysvq0asl(tmp_2);
    mem.setI32(sl_1, X60Qx_88);
    let X60Qx_89 = nimIcheckB(mem.i32(fl_1), 23);
    let X60Qx_90 = nimIcheckB(mem.i32(sl_1), 31);
    result_37 = mem.u32((((a_6 + 2148) + (X60Qx_89 * 128)) + (X60Qx_90 * 4)));
  } else {
    let X60Qx_91 = lsbit_0_sysvq0asl(((mem.u32((a_6 + 2048)) & ((((~0) >>> 0) << ((mem.i32(fl_1) + 1) | 0)) >>> 0)) >>> 0));
    mem.setI32(fl_1, X60Qx_91);
    if ((0 < mem.i32(fl_1))) {
      let X60Qx_92 = nimIcheckB(mem.i32(fl_1), 23);
      let X60Qx_93 = lsbit_0_sysvq0asl(mem.u32(((a_6 + 2052) + (X60Qx_92 * 4))));
      mem.setI32(sl_1, X60Qx_93);
      let X60Qx_94 = nimIcheckB(mem.i32(fl_1), 23);
      let X60Qx_95 = nimIcheckB(mem.i32(sl_1), 31);
      result_37 = mem.u32((((a_6 + 2148) + (X60Qx_94 * 128)) + (X60Qx_95 * 4)));
    }
  }
  return result_37;
}

function removeChunkFromMatrix_0_sysvq0asl(a_7, b_7) {
  let X60Qtmptup_0 = allocFixed(8);
  mem.copy(X60Qtmptup_0, mappingInsert_0_sysvq0asl(mem.i32((b_7 + 4))), 8);
  let fl_5 = mem.i32(X60Qtmptup_0);
  let sl_6 = mem.i32((X60Qtmptup_0 + 4));
  if ((!(mem.u32((b_7 + 12)) === 0))) {
    mem.setU32((mem.u32((b_7 + 12)) + 16), mem.u32((b_7 + 16)));
  }
  if ((!(mem.u32((b_7 + 16)) === 0))) {
    mem.setU32((mem.u32((b_7 + 16)) + 12), mem.u32((b_7 + 12)));
  }
  let X60Qx_96 = nimIcheckB(fl_5, 23);
  let X60Qx_97 = nimIcheckB(sl_6, 31);
  if ((mem.u32((((a_7 + 2148) + (X60Qx_96 * 128)) + (X60Qx_97 * 4))) === b_7)) {
    let X60Qx_98 = nimIcheckB(fl_5, 23);
    let X60Qx_99 = nimIcheckB(sl_6, 31);
    mem.setU32((((a_7 + 2148) + (X60Qx_98 * 128)) + (X60Qx_99 * 4)), mem.u32((b_7 + 12)));
    let X60Qx_100 = nimIcheckB(fl_5, 23);
    let X60Qx_101 = nimIcheckB(sl_6, 31);
    if ((mem.u32((((a_7 + 2148) + (X60Qx_100 * 128)) + (X60Qx_101 * 4))) === 0)) {
      let X60Qx_102 = nimIcheckB(fl_5, 23);
      clearBit_0_sysvq0asl(sl_6, ((a_7 + 2052) + (X60Qx_102 * 4)));
      let X60Qx_103 = nimIcheckB(fl_5, 23);
      if ((mem.u32(((a_7 + 2052) + (X60Qx_103 * 4))) === 0)) {
        clearBit_0_sysvq0asl(fl_5, (a_7 + 2048));
      }
    }
  }
  mem.setU32((b_7 + 16), 0);
  mem.setU32((b_7 + 12), 0);
}

function removeChunkFromMatrix2_0_sysvq0asl(a_8, b_8, fl_3, sl_3) {
  let X60Qx_104 = nimIcheckB(fl_3, 23);
  let X60Qx_105 = nimIcheckB(sl_3, 31);
  mem.setU32((((a_8 + 2148) + (X60Qx_104 * 128)) + (X60Qx_105 * 4)), mem.u32((b_8 + 12)));
  let X60Qx_106 = nimIcheckB(fl_3, 23);
  let X60Qx_107 = nimIcheckB(sl_3, 31);
  if ((!(mem.u32((((a_8 + 2148) + (X60Qx_106 * 128)) + (X60Qx_107 * 4))) === 0))) {
    let X60Qx_108 = nimIcheckB(fl_3, 23);
    let X60Qx_109 = nimIcheckB(sl_3, 31);
    mem.setU32((mem.u32((((a_8 + 2148) + (X60Qx_108 * 128)) + (X60Qx_109 * 4))) + 16), 0);
  } else {
    let X60Qx_110 = nimIcheckB(fl_3, 23);
    clearBit_0_sysvq0asl(sl_3, ((a_8 + 2052) + (X60Qx_110 * 4)));
    let X60Qx_111 = nimIcheckB(fl_3, 23);
    if ((mem.u32(((a_8 + 2052) + (X60Qx_111 * 4))) === 0)) {
      clearBit_0_sysvq0asl(fl_3, (a_8 + 2048));
    }
  }
  mem.setU32((b_8 + 16), 0);
  mem.setU32((b_8 + 12), 0);
}

function addChunkToMatrix_0_sysvq0asl(a_9, b_9) {
  let X60Qtmptup_1 = allocFixed(8);
  mem.copy(X60Qtmptup_1, mappingInsert_0_sysvq0asl(mem.i32((b_9 + 4))), 8);
  let fl_6 = mem.i32(X60Qtmptup_1);
  let sl_7 = mem.i32((X60Qtmptup_1 + 4));
  mem.setU32((b_9 + 16), 0);
  let X60Qx_112 = nimIcheckB(fl_6, 23);
  let X60Qx_113 = nimIcheckB(sl_7, 31);
  mem.setU32((b_9 + 12), mem.u32((((a_9 + 2148) + (X60Qx_112 * 128)) + (X60Qx_113 * 4))));
  let X60Qx_114 = nimIcheckB(fl_6, 23);
  let X60Qx_115 = nimIcheckB(sl_7, 31);
  if ((!(mem.u32((((a_9 + 2148) + (X60Qx_114 * 128)) + (X60Qx_115 * 4))) === 0))) {
    let X60Qx_116 = nimIcheckB(fl_6, 23);
    let X60Qx_117 = nimIcheckB(sl_7, 31);
    mem.setU32((mem.u32((((a_9 + 2148) + (X60Qx_116 * 128)) + (X60Qx_117 * 4))) + 16), b_9);
  }
  let X60Qx_118 = nimIcheckB(fl_6, 23);
  let X60Qx_119 = nimIcheckB(sl_7, 31);
  mem.setU32((((a_9 + 2148) + (X60Qx_118 * 128)) + (X60Qx_119 * 4)), b_9);
  let X60Qx_120 = nimIcheckB(fl_6, 23);
  setBit_0_sysvq0asl(sl_7, ((a_9 + 2052) + (X60Qx_120 * 4)));
  setBit_0_sysvq0asl(fl_6, (a_9 + 2048));
}

function incCurrMem_0_sysvq0asl(a_10, bytes_0) {
  inc_0_Iloplki_party5a2l1((a_10 + 5224), bytes_0);
}

function decCurrMem_0_sysvq0asl(a_11, bytes_1) {
  let X60Qx_121 = max_2_sysvq0asl(mem.i32((a_11 + 5228)), mem.i32((a_11 + 5224)));
  mem.setI32((a_11 + 5228), X60Qx_121);
  dec_0_Ig5i8xp_str7j0ifg((a_11 + 5224), bytes_1);
}

function allocPages_0_sysvq0asl(a_13, size_11) {
  let result_39;
  let X60Qx_123 = osAllocPages_0_sysvq0asl(size_11);
  result_39 = X60Qx_123;
  return result_39;
}

function tryAllocPages_0_sysvq0asl(a_14, size_12) {
  let result_40;
  let X60Qx_124 = osTryAllocPages_0_sysvq0asl(size_12);
  result_40 = X60Qx_124;
  return result_40;
}

function llAlloc_0_sysvq0asl(a_15, size_13) {
  let result_41;
  let X60Qx_125;
  if ((mem.u32((a_15 + 5220)) === 0)) {
    X60Qx_125 = true;
  } else {
    X60Qx_125 = (mem.i32(mem.u32((a_15 + 5220))) < size_13);
  }
  if (X60Qx_125) {
    let old_1 = mem.u32((a_15 + 5220));
    let X60Qx_126 = allocPages_0_sysvq0asl(a_15, 4096);
    mem.setU32((a_15 + 5220), X60Qx_126);
    incCurrMem_0_sysvq0asl(a_15, 4096);
    mem.setI32(mem.u32((a_15 + 5220)), (4084 | 0));
    mem.setI32((mem.u32((a_15 + 5220)) + 4), 12);
    mem.setU32((mem.u32((a_15 + 5220)) + 8), old_1);
  }
  result_41 = ((mem.u32((a_15 + 5220)) + mem.i32((mem.u32((a_15 + 5220)) + 4))) | 0);
  dec_0_Ig5i8xp_str7j0ifg(mem.u32((a_15 + 5220)), size_13);
  inc_0_Iloplki_party5a2l1((mem.u32((a_15 + 5220)) + 4), size_13);
  zeroMem_0_sysvq0asl(result_41, size_13);
  return result_41;
}

function addHeapLink_0_sysvq0asl(a_16, p_10, size_14) {
  whileStmtLabel_0: {
    var result_42;
    var it_0 = (a_16 + 6280);
    {
      while (true) {
        var X60Qx_127;
        if ((!(it_0 === 0))) {
          X60Qx_127 = ((((29 | 0) + 1) | 0) <= mem.i32(it_0));
        } else {
          X60Qx_127 = false;
        }
        if (X60Qx_127) {
          it_0 = mem.u32((it_0 + 244));
        } else {
          break;
        }
      }
    }
  }
  if ((it_0 === 0)) {
    var X60Qx_128 = llAlloc_0_sysvq0asl(a_16, 248);
    var n_7 = X60Qx_128;
    mem.setU32((n_7 + 244), mem.u32(((a_16 + 6280) + 244)));
    mem.setU32(((a_16 + 6280) + 244), n_7);
    var X60Qx_129 = nimIcheckB(0, 29);
    mem.copy(((n_7 + 4) + (X60Qx_129 * 8)), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, p_10);
      mem.setI32((_o + 4), size_14);
      return _o;
    })(), 8);
    mem.setI32(n_7, 1);
    result_42 = n_7;
  } else {
    var L_0 = mem.i32(it_0);
    var X60Qx_130 = nimIcheckB(L_0, 29);
    mem.copy(((it_0 + 4) + (X60Qx_130 * 8)), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, p_10);
      mem.setI32((_o + 4), size_14);
      return _o;
    })(), 8);
    inc_1_I6wjjge_exp6svnmi1(it_0);
    result_42 = it_0;
  }
  return result_42;
}

function intSetGet_0_sysvq0asl(t_0, key_0) {
  whileStmtLabel_0: {
    var result_43;
    var X60Qx_131 = nimIcheckB((key_0 & 255), 255);
    var it_2 = mem.u32((t_0 + (X60Qx_131 * 4)));
    {
      while ((!(it_2 === 0))) {
        if ((mem.i32((it_2 + 4)) === key_0)) {
          return it_2;
        }
        it_2 = mem.u32(it_2);
      }
    }
  }
  result_43 = 0;
  return result_43;
}

function intSetPut_0_sysvq0asl(a_18, key_1) {
  let result_44;
  let X60Qx_132 = intSetGet_0_sysvq0asl((a_18 + 5248), key_1);
  result_44 = X60Qx_132;
  if ((result_44 === 0)) {
    let X60Qx_133 = llAlloc_0_sysvq0asl(a_18, 72);
    result_44 = X60Qx_133;
    let X60Qx_134 = nimIcheckB((key_1 & 255), 255);
    mem.setU32(result_44, mem.u32(((a_18 + 5248) + (X60Qx_134 * 4))));
    let X60Qx_135 = nimIcheckB((key_1 & 255), 255);
    mem.setU32(((a_18 + 5248) + (X60Qx_135 * 4)), result_44);
    mem.setI32((result_44 + 4), key_1);
  }
  return result_44;
}

function contains_1_sysvq0asl(s_4, key_2) {
  let result_45;
  let t_4 = intSetGet_0_sysvq0asl(s_4, (key_2 >> 9));
  if ((!(t_4 === 0))) {
    let u_1 = (key_2 & 511);
    let X60Qx_136 = nimIcheckB((u_1 >> 5), 15);
    result_45 = (!(((mem.u32(((t_4 + 8) + (X60Qx_136 * 4))) & ((1 << (u_1 & 31)) >>> 0)) >>> 0) === 0));
  } else {
    result_45 = false;
  }
  return result_45;
}

function incl_2_sysvq0asl(a_19, key_3) {
  let t_5 = intSetPut_0_sysvq0asl(a_19, (key_3 >> 9));
  let u_2 = (key_3 & 511);
  let X60Qx_137 = nimIcheckB((u_2 >> 5), 15);
  let X60Qx_138 = nimIcheckB((u_2 >> 5), 15);
  mem.setU32(((t_5 + 8) + (X60Qx_137 * 4)), ((mem.u32(((t_5 + 8) + (X60Qx_138 * 4))) | ((1 << (u_2 & 31)) >>> 0)) >>> 0));
}

function excl_2_sysvq0asl(s_5, key_4) {
  let t_6 = intSetGet_0_sysvq0asl(s_5, (key_4 >> 9));
  if ((!(t_6 === 0))) {
    let u_3 = (key_4 & 511);
    let X60Qx_139 = nimIcheckB((u_3 >> 5), 15);
    let X60Qx_140 = nimIcheckB((u_3 >> 5), 15);
    mem.setU32(((t_6 + 8) + (X60Qx_139 * 4)), ((mem.u32(((t_6 + 8) + (X60Qx_140 * 4))) & ((~((1 << (u_3 & 31)) >>> 0)) >>> 0)) >>> 0));
  }
}

function isSmallChunk_0_sysvq0asl(c_0) {
  let result_46;
  result_46 = (mem.i32((c_0 + 4)) <= (4056 | 0));
  return result_46;
}

function chunkUnused_0_sysvq0asl(c_1) {
  let result_47;
  result_47 = ((mem.i32(c_1) & 1) === 0);
  return result_47;
}

function pageIndex_0_sysvq0asl(c_2) {
  let result_48;
  result_48 = (c_2 >> 12);
  return result_48;
}

function pageIndex_1_sysvq0asl(p_11) {
  let result_49;
  result_49 = (p_11 >> 12);
  return result_49;
}

function pageAddr_0_sysvq0asl(p_12) {
  let result_50;
  result_50 = (p_12 & (~4095));
  return result_50;
}

function requestOsChunks_0_sysvq0asl(a_20, size_15) {
  let result_51;
  if ((!mem.u8At((a_20 + 6274)))) {
    let usedMem_0 = mem.i32((a_20 + 5236));
    if ((usedMem_0 < Math.imul(64, 1024))) {
      mem.setI32((a_20 + 6276), Math.imul(4096, 4));
    } else {
      let X60Qx_141 = roundup_0_sysvq0asl((usedMem_0 >> 2), 4096);
      let X60Qx_142 = min_2_sysvq0asl(X60Qx_141, Math.imul(mem.i32((a_20 + 6276)), 2));
      mem.setI32((a_20 + 6276), X60Qx_142);
      let X60Qx_143 = min_2_sysvq0asl(mem.i32((a_20 + 6276)), 1056964608);
      mem.setI32((a_20 + 6276), X60Qx_143);
    }
  }
  let size_36 = size_15;
  if ((mem.i32((a_20 + 6276)) < size_36)) {
    let X60Qx_144 = allocPages_0_sysvq0asl(a_20, size_36);
    result_51 = X60Qx_144;
  } else {
    let X60Qx_145 = tryAllocPages_0_sysvq0asl(a_20, mem.i32((a_20 + 6276)));
    result_51 = X60Qx_145;
    if ((result_51 === 0)) {
      let X60Qx_146 = allocPages_0_sysvq0asl(a_20, size_36);
      result_51 = X60Qx_146;
      mem.setU8((a_20 + 6274), true);
    } else {
      size_36 = mem.i32((a_20 + 6276));
    }
  }
  incCurrMem_0_sysvq0asl(a_20, size_36);
  inc_0_Iloplki_party5a2l1((a_20 + 5232), size_36);
  let heapLink_0 = addHeapLink_0_sysvq0asl(a_20, result_51, size_36);
  mem.setU32((result_51 + 12), 0);
  mem.setU32((result_51 + 16), 0);
  mem.setI32((result_51 + 4), size_36);
  let nxt_0 = ((result_51 + size_36) >>> 0);
  let next_1 = nxt_0;
  let X60Qx_147 = pageIndex_0_sysvq0asl(next_1);
  let X60Qx_148 = contains_1_sysvq0asl((a_20 + 5248), X60Qx_147);
  if (X60Qx_148) {
    mem.setI32(next_1, (size_36 | (mem.i32(next_1) & 1)));
  }
  let X60Qx_16;
  if ((!(mem.i32((a_20 + 5240)) === 0))) {
    X60Qx_16 = mem.i32((a_20 + 5240));
  } else {
    X60Qx_16 = 4096;
  }
  let lastSize_0 = X60Qx_16;
  let prv_0 = ((result_51 - lastSize_0) >>> 0);
  let prev_1 = prv_0;
  let X60Qx_149;
  let X60Qx_150 = pageIndex_0_sysvq0asl(prev_1);
  let X60Qx_151 = contains_1_sysvq0asl((a_20 + 5248), X60Qx_150);
  if (X60Qx_151) {
    X60Qx_149 = (mem.i32((prev_1 + 4)) === lastSize_0);
  } else {
    X60Qx_149 = false;
  }
  if (X60Qx_149) {
    mem.setI32(result_51, (lastSize_0 | (mem.i32(result_51) & 1)));
  } else {
    mem.setI32(result_51, (0 | (mem.i32(result_51) & 1)));
  }
  mem.setI32((a_20 + 5240), size_36);
  return result_51;
}

function isAccessible_0_sysvq0asl(a_21, p_13) {
  let result_52;
  let X60Qx_152 = pageIndex_1_sysvq0asl(p_13);
  let X60Qx_153 = contains_1_sysvq0asl((a_21 + 5248), X60Qx_152);
  result_52 = X60Qx_153;
  return result_52;
}

function updatePrevSize_0_sysvq0asl(a_22, c_5, prevSize_0) {
  let ri_0 = ((c_5 + mem.i32((c_5 + 4))) >>> 0);
  let X60Qx_154 = isAccessible_0_sysvq0asl(a_22, ri_0);
  if (X60Qx_154) {
    mem.setI32(ri_0, (prevSize_0 | (mem.i32(ri_0) & 1)));
  }
}

function splitChunk2_0_sysvq0asl(a_23, c_6, size_16) {
  let result_53;
  result_53 = ((c_6 + size_16) >>> 0);
  mem.setI32((result_53 + 4), ((mem.i32((c_6 + 4)) - size_16) | 0));
  mem.setU32((result_53 + 12), 0);
  mem.setU32((result_53 + 16), 0);
  mem.setI32(result_53, size_16);
  mem.setU32((result_53 + 8), a_23);
  updatePrevSize_0_sysvq0asl(a_23, c_6, mem.i32((result_53 + 4)));
  mem.setI32((c_6 + 4), size_16);
  let X60Qx_155 = pageIndex_0_sysvq0asl(result_53);
  incl_2_sysvq0asl(a_23, X60Qx_155);
  return result_53;
}

function splitChunk_0_sysvq0asl(a_24, c_7, size_17) {
  let rest_0 = splitChunk2_0_sysvq0asl(a_24, c_7, size_17);
  addChunkToMatrix_0_sysvq0asl(a_24, rest_0);
}

function freeBigChunk_0_sysvq0asl(a_25, c_8) {
  let c_28 = c_8;
  inc_0_Iloplki_party5a2l1((a_25 + 5232), mem.i32((c_28 + 4)));
  mem.setI32(c_28, (mem.i32(c_28) & (~1)));
  let prevSize_1 = mem.i32(c_28);
  if ((!(prevSize_1 === 0))) {
    let le_0 = ((c_28 - prevSize_1) >>> 0);
    let X60Qx_156;
    let X60Qx_157 = isAccessible_0_sysvq0asl(a_25, le_0);
    if (X60Qx_157) {
      let X60Qx_158 = chunkUnused_0_sysvq0asl(le_0);
      X60Qx_156 = X60Qx_158;
    } else {
      X60Qx_156 = false;
    }
    if (X60Qx_156) {
      let X60Qx_159;
      let X60Qx_160 = isSmallChunk_0_sysvq0asl(le_0);
      if ((!X60Qx_160)) {
        X60Qx_159 = (mem.i32((le_0 + 4)) < 1056964608);
      } else {
        X60Qx_159 = false;
      }
      if (X60Qx_159) {
        removeChunkFromMatrix_0_sysvq0asl(a_25, le_0);
        inc_0_Iloplki_party5a2l1((le_0 + 4), mem.i32((c_28 + 4)));
        let X60Qx_161 = pageIndex_0_sysvq0asl(c_28);
        excl_2_sysvq0asl((a_25 + 5248), X60Qx_161);
        c_28 = le_0;
        if ((1056964608 < mem.i32((c_28 + 4)))) {
          let rest_1 = splitChunk2_0_sysvq0asl(a_25, c_28, 1056964608);
          addChunkToMatrix_0_sysvq0asl(a_25, c_28);
          c_28 = rest_1;
        }
      }
    }
  }
  let ri_1 = ((c_28 + mem.i32((c_28 + 4))) >>> 0);
  let X60Qx_162;
  let X60Qx_163 = isAccessible_0_sysvq0asl(a_25, ri_1);
  if (X60Qx_163) {
    let X60Qx_164 = chunkUnused_0_sysvq0asl(ri_1);
    X60Qx_162 = X60Qx_164;
  } else {
    X60Qx_162 = false;
  }
  if (X60Qx_162) {
    let X60Qx_165;
    let X60Qx_166 = isSmallChunk_0_sysvq0asl(ri_1);
    if ((!X60Qx_166)) {
      X60Qx_165 = (mem.i32((c_28 + 4)) < 1056964608);
    } else {
      X60Qx_165 = false;
    }
    if (X60Qx_165) {
      removeChunkFromMatrix_0_sysvq0asl(a_25, ri_1);
      inc_0_Iloplki_party5a2l1((c_28 + 4), mem.i32((ri_1 + 4)));
      let X60Qx_167 = pageIndex_0_sysvq0asl(ri_1);
      excl_2_sysvq0asl((a_25 + 5248), X60Qx_167);
      if ((1056964608 < mem.i32((c_28 + 4)))) {
        let rest_2 = splitChunk2_0_sysvq0asl(a_25, c_28, 1056964608);
        addChunkToMatrix_0_sysvq0asl(a_25, rest_2);
      }
    }
  }
  addChunkToMatrix_0_sysvq0asl(a_25, c_28);
}

function getBigChunk_0_sysvq0asl(a_26, size_18) {
  let result_54;
  let size_37 = allocFixed(4);
  mem.setI32(size_37, size_18);
  let fl_7 = allocFixed(4);
  mem.setI32(fl_7, 0);
  let sl_8 = allocFixed(4);
  mem.setI32(sl_8, 0);
  mappingSearch_0_sysvq0asl(size_37, fl_7, sl_8);
  let X60Qx_168 = findSuitableBlock_0_sysvq0asl(a_26, fl_7, sl_8);
  result_54 = X60Qx_168;
  if ((result_54 === 0)) {
    if ((mem.i32(size_37) < Math.imul(128, 4096))) {
      let X60Qx_169 = requestOsChunks_0_sysvq0asl(a_26, Math.imul(128, 4096));
      result_54 = X60Qx_169;
      splitChunk_0_sysvq0asl(a_26, result_54, mem.i32(size_37));
    } else {
      let X60Qx_170 = requestOsChunks_0_sysvq0asl(a_26, mem.i32(size_37));
      result_54 = X60Qx_170;
      if ((mem.i32(size_37) < mem.i32((result_54 + 4)))) {
        splitChunk_0_sysvq0asl(a_26, result_54, mem.i32(size_37));
      }
    }
    mem.setU32((result_54 + 8), a_26);
  } else {
    removeChunkFromMatrix2_0_sysvq0asl(a_26, result_54, mem.i32(fl_7), mem.i32(sl_8));
    if ((((mem.i32(size_37) + 4096) | 0) <= mem.i32((result_54 + 4)))) {
      splitChunk_0_sysvq0asl(a_26, result_54, mem.i32(size_37));
    }
  }
  mem.setI32(result_54, 1);
  let X60Qx_171 = pageIndex_0_sysvq0asl(result_54);
  incl_2_sysvq0asl(a_26, X60Qx_171);
  dec_0_Ig5i8xp_str7j0ifg((a_26 + 5232), mem.i32(size_37));
  return result_54;
}

function getHugeChunk_0_sysvq0asl(a_27, size_19) {
  let result_55;
  let X60Qx_172 = allocPages_0_sysvq0asl(a_27, size_19);
  result_55 = X60Qx_172;
  incCurrMem_0_sysvq0asl(a_27, size_19);
  mem.setU32((result_55 + 12), 0);
  mem.setU32((result_55 + 16), 0);
  mem.setI32((result_55 + 4), size_19);
  mem.setI32(result_55, 1);
  mem.setU32((result_55 + 8), a_27);
  let X60Qx_173 = pageIndex_0_sysvq0asl(result_55);
  incl_2_sysvq0asl(a_27, X60Qx_173);
  return result_55;
}

function freeHugeChunk_0_sysvq0asl(a_28, c_9) {
  let size_38 = mem.i32((c_9 + 4));
  let X60Qx_174 = pageIndex_0_sysvq0asl(c_9);
  excl_2_sysvq0asl((a_28 + 5248), X60Qx_174);
  decCurrMem_0_sysvq0asl(a_28, size_38);
  osDeallocPages_0_sysvq0asl(c_9, size_38);
}

function getSmallChunk_0_sysvq0asl(a_29) {
  let result_56;
  let res_1 = getBigChunk_0_sysvq0asl(a_29, 4096);
  result_56 = res_1;
  return result_56;
}

function deallocBigChunk_0_sysvq0asl(a_31, c_10) {
  dec_0_Ig5i8xp_str7j0ifg((a_31 + 5236), mem.i32((c_10 + 4)));
  mem.setU32((c_10 + 16), 0);
  if ((1056964609 <= mem.i32((c_10 + 4)))) {
    freeHugeChunk_0_sysvq0asl(a_31, c_10);
  } else {
    freeBigChunk_0_sysvq0asl(a_31, c_10);
  }
}

function addToSharedFreeListBigChunks_0_sysvq0asl(a_32, c_11) {
  whileStmtLabel_0: {
    {
      while (true) {
        var X60Qx_175 = __atomic_load_n((a_32 + 5244), __ATOMIC_RELAXED);
        __atomic_store_n((c_11 + 12), X60Qx_175, __ATOMIC_RELAXED);
        var X60Qx_176 = __atomic_compare_exchange_n((a_32 + 5244), (c_11 + 12), c_11, true, __ATOMIC_RELEASE, __ATOMIC_RELAXED);
        if (X60Qx_176) {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function addToSharedFreeList_0_sysvq0asl(c_12, f_0, size_20) {
  whileStmtLabel_0: {
    {
      while (true) {
        var X60Qx_177 = nimIcheckB(size_20, 255);
        var X60Qx_178 = __atomic_load_n(((mem.u32((c_12 + 8)) + 1024) + (X60Qx_177 * 4)), __ATOMIC_RELAXED);
        __atomic_store_n(f_0, X60Qx_178, __ATOMIC_RELAXED);
        var X60Qx_179 = nimIcheckB(size_20, 255);
        var X60Qx_180 = __atomic_compare_exchange_n(((mem.u32((c_12 + 8)) + 1024) + (X60Qx_179 * 4)), f_0, f_0, true, __ATOMIC_RELEASE, __ATOMIC_RELAXED);
        if (X60Qx_180) {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function compensateCounters_0_sysvq0asl(a_33, c_13, size_21) {
  whileStmtLabel_0: {
    var it_3 = mem.u32((c_13 + 20));
    var total_0 = allocFixed(4);
    mem.setI32(total_0, 0);
    {
      while ((!(it_3 === 0))) {
        inc_0_Iloplki_party5a2l1(total_0, size_21);
        var X60Qx_181 = pageAddr_0_sysvq0asl(it_3);
        var chunk_0 = X60Qx_181;
        if ((!(c_13 === chunk_0))) {
          mem.setI32((c_13 + 32), ((mem.i32((c_13 + 32)) + 1) | 0));
        }
        it_3 = mem.u32(it_3);
      }
    }
  }
  mem.setI32((c_13 + 24), ((mem.i32((c_13 + 24)) + mem.i32(total_0)) | 0));
  dec_0_Ig5i8xp_str7j0ifg((a_33 + 5236), mem.i32(total_0));
}

function freeDeferredObjects_0_sysvq0asl(a_34, root_0) {
  whileStmtLabel_0: {
    var it_4 = root_0;
    var maxIters_0 = allocFixed(4);
    mem.setI32(maxIters_0, 20);
    {
      while (true) {
        var rest_3 = __atomic_load_n((it_4 + 12), __ATOMIC_RELAXED);
        __atomic_store_n((it_4 + 12), 0, __ATOMIC_RELAXED);
        deallocBigChunk_0_sysvq0asl(a_34, it_4);
        if ((mem.i32(maxIters_0) === 0)) {
          if ((!(rest_3 === 0))) {
            addToSharedFreeListBigChunks_0_sysvq0asl(a_34, rest_3);
          }
          break whileStmtLabel_0;
        }
        it_4 = rest_3;
        dec_1_I0nzoz91_fixeak1im1(maxIters_0);
        if ((it_4 === 0)) {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function smallChunkAlignOffset_0_sysvq0asl(alignment_1) {
  let result_57;
  if ((alignment_1 <= 16)) {
    result_57 = 0;
  } else {
    let X60Qx_182 = align_0_sysvq0asl((48 | 0), alignment_1);
    result_57 = ((((X60Qx_182 - 40) | 0) - 8) | 0);
  }
  return result_57;
}

function bigChunkAlignOffset_0_sysvq0asl(alignment_2) {
  let result_58;
  if ((alignment_2 === 0)) {
    result_58 = 0;
  } else {
    let X60Qx_183 = align_0_sysvq0asl((28 | 0), alignment_2);
    result_58 = ((((X60Qx_183 - 20) | 0) - 8) | 0);
  }
  return result_58;
}

function rawAlloc_0_sysvq0asl(a_35, requestedSize_0, alignment_3) {
  let result_59;
  let X60Qx_184 = max_2_sysvq0asl(16, alignment_3);
  let size_39 = roundup_0_sysvq0asl(requestedSize_0, X60Qx_184);
  let alignOff_0 = smallChunkAlignOffset_0_sysvq0asl(alignment_3);
  if ((((size_39 + alignOff_0) | 0) <= (4056 | 0))) {
    let s_82 = Math.trunc((size_39 / 16));
    let X60Qx_185 = nimIcheckB(s_82, 255);
    let c_29 = mem.u32((a_35 + (X60Qx_185 * 4)));
    let X60Qx_186;
    if ((!(c_29 === 0))) {
      X60Qx_186 = (!(mem.i32((c_29 + 36)) === alignOff_0));
    } else {
      X60Qx_186 = false;
    }
    if (X60Qx_186) {
      c_29 = 0;
    }
    if ((c_29 === 0)) {
      let X60Qx_187 = getSmallChunk_0_sysvq0asl(a_35);
      c_29 = X60Qx_187;
      mem.setU32((c_29 + 20), 0);
      mem.setI32((c_29 + 32), 0);
      mem.setI32((c_29 + 36), alignOff_0);
      mem.setI32((c_29 + 4), size_39);
      mem.setU32((c_29 + 28), ((alignOff_0 + size_39) | 0));
      mem.setI32((c_29 + 24), (((((4056 | 0) - alignOff_0) | 0) - size_39) | 0));
      mem.setU32((c_29 + 12), 0);
      mem.setU32((c_29 + 16), 0);
      if ((mem.u32((c_29 + 20)) === 0)) {
        let X60Qx_188 = nimIcheckB(s_82, 255);
        let X60Qx_189 = __atomic_exchange_n(((a_35 + 1024) + (X60Qx_188 * 4)), 0, __ATOMIC_RELAXED);
        mem.setU32((c_29 + 20), X60Qx_189);
        compensateCounters_0_sysvq0asl(a_35, c_29, size_39);
      }
      if ((size_39 <= mem.i32((c_29 + 24)))) {
        let X60Qx_190 = nimIcheckB(s_82, 255);
        listAdd_0_Ik4wxhz_sysvq0asl((a_35 + (X60Qx_190 * 4)), c_29);
      }
      result_59 = (((c_29 + 40) + alignOff_0) | 0);
    } else {
      if ((mem.u32((c_29 + 20)) === 0)) {
        result_59 = (((c_29 + 40) + mem.u32((c_29 + 28))) >>> 0);
        mem.setU32((c_29 + 28), ((mem.u32((c_29 + 28)) + size_39) >>> 0));
      } else {
        result_59 = mem.u32((c_29 + 20));
        mem.setU32((c_29 + 20), mem.u32(mem.u32((c_29 + 20))));
        let X60Qx_191 = pageAddr_0_sysvq0asl(result_59);
        if ((!(X60Qx_191 === c_29))) {
          mem.setI32((c_29 + 32), ((mem.i32((c_29 + 32)) - 1) | 0));
        } else {
        }
      }
      mem.setI32((c_29 + 24), ((mem.i32((c_29 + 24)) - size_39) | 0));
      if ((mem.u32((c_29 + 20)) === 0)) {
        let X60Qx_192 = nimIcheckB(s_82, 255);
        let X60Qx_193 = __atomic_exchange_n(((a_35 + 1024) + (X60Qx_192 * 4)), 0, __ATOMIC_RELAXED);
        mem.setU32((c_29 + 20), X60Qx_193);
        compensateCounters_0_sysvq0asl(a_35, c_29, size_39);
      }
      if ((mem.i32((c_29 + 24)) < size_39)) {
        let X60Qx_194 = nimIcheckB(s_82, 255);
        listRemove_0_Ibzev091_sysvq0asl((a_35 + (X60Qx_194 * 4)), c_29);
      }
    }
    inc_0_Iloplki_party5a2l1((a_35 + 5236), size_39);
  } else {
    let deferredFrees_0 = __atomic_exchange_n((a_35 + 5244), 0, __ATOMIC_RELAXED);
    if ((!(deferredFrees_0 === 0))) {
      freeDeferredObjects_0_sysvq0asl(a_35, deferredFrees_0);
    }
    let alignPad_0 = bigChunkAlignOffset_0_sysvq0asl(alignment_3);
    size_39 = ((((requestedSize_0 + 20) | 0) + alignPad_0) | 0);
    let X60Qx_17;
    if ((1056964609 <= size_39)) {
      let X60Qx_195 = getHugeChunk_0_sysvq0asl(a_35, size_39);
      X60Qx_17 = X60Qx_195;
    } else {
      let X60Qx_196 = getBigChunk_0_sysvq0asl(a_35, size_39);
      X60Qx_17 = X60Qx_196;
    }
    let c_32 = X60Qx_17;
    result_59 = (((c_32 + 20) + alignPad_0) | 0);
    mem.setU32((c_32 + 16), result_59);
    inc_0_Iloplki_party5a2l1((a_35 + 5236), mem.i32((c_32 + 4)));
  }
  return result_59;
}

function rawDealloc_0_sysvq0asl(a_37, p_14) {
  let c_33 = pageAddr_0_sysvq0asl(p_14);
  let X60Qx_198 = isSmallChunk_0_sysvq0asl(c_33);
  if (X60Qx_198) {
    let c_34 = c_33;
    let s_83 = mem.i32((c_34 + 4));
    let f_3 = p_14;
    if ((mem.u32((c_34 + 8)) === a_37)) {
      dec_0_Ig5i8xp_str7j0ifg((a_37 + 5236), s_83);
      let X60Qx_199 = nimIcheckB(Math.trunc((s_83 / 16)), 255);
      let activeChunk_0 = mem.u32((a_37 + (X60Qx_199 * 4)));
      let X60Qx_200;
      let X60Qx_201;
      if ((!(activeChunk_0 === 0))) {
        X60Qx_201 = (!(c_34 === activeChunk_0));
      } else {
        X60Qx_201 = false;
      }
      if (X60Qx_201) {
        X60Qx_200 = (mem.i32((activeChunk_0 + 36)) === mem.i32((c_34 + 36)));
      } else {
        X60Qx_200 = false;
      }
      if (X60Qx_200) {
        mem.setU32(f_3, mem.u32((activeChunk_0 + 20)));
        mem.setU32((activeChunk_0 + 20), f_3);
        mem.setI32((activeChunk_0 + 24), ((mem.i32((activeChunk_0 + 24)) + s_83) | 0));
        mem.setI32((activeChunk_0 + 32), ((mem.i32((activeChunk_0 + 32)) + 1) | 0));
      } else {
        mem.setU32(f_3, mem.u32((c_34 + 20)));
        mem.setU32((c_34 + 20), f_3);
        if ((mem.i32((c_34 + 24)) < s_83)) {
          let X60Qx_202 = nimIcheckB(Math.trunc((s_83 / 16)), 255);
          listAdd_0_Ik4wxhz_sysvq0asl((a_37 + (X60Qx_202 * 4)), c_34);
          mem.setI32((c_34 + 24), ((mem.i32((c_34 + 24)) + s_83) | 0));
        } else {
          mem.setI32((c_34 + 24), ((mem.i32((c_34 + 24)) + s_83) | 0));
        }
      }
    } else {
      addToSharedFreeList_0_sysvq0asl(c_34, f_3, Math.trunc((s_83 / 16)));
    }
  } else {
    if ((mem.u32((c_33 + 8)) === a_37)) {
      deallocBigChunk_0_sysvq0asl(a_37, c_33);
    } else {
      addToSharedFreeListBigChunks_0_sysvq0asl(mem.u32((c_33 + 8)), c_33);
    }
  }
}

function ptrSize_0_sysvq0asl(p_15) {
  let result_61 = allocFixed(4);
  let c_35 = pageAddr_0_sysvq0asl(p_15);
  mem.setI32(result_61, mem.i32((c_35 + 4)));
  let X60Qx_203 = isSmallChunk_0_sysvq0asl(c_35);
  if ((!X60Qx_203)) {
    dec_0_Ig5i8xp_str7j0ifg(result_61, 20);
  }
  return mem.i32(result_61);
}

function alloc_0_sysvq0asl(allocator_0, size_22) {
  let result_62;
  let X60Qx_204 = rawAlloc_0_sysvq0asl(allocator_0, size_22, 0);
  result_62 = X60Qx_204;
  return result_62;
}

function dealloc_0_sysvq0asl(allocator_2, p_16) {
  rawDealloc_0_sysvq0asl(allocator_2, p_16);
}

function realloc_0_sysvq0asl(allocator_3, p_17, newsize_0) {
  let result_64;
  result_64 = 0;
  if ((0 < newsize_0)) {
    let X60Qx_206 = alloc_0_sysvq0asl(allocator_3, newsize_0);
    result_64 = X60Qx_206;
    if ((!(p_17 === 0))) {
      let X60Qx_207 = ptrSize_0_sysvq0asl(p_17);
      let X60Qx_208 = min_2_sysvq0asl(X60Qx_207, newsize_0);
      copyMem_0_sysvq0asl(result_64, p_17, X60Qx_208);
      dealloc_0_sysvq0asl(allocator_3, p_17);
    }
  } else {
    if ((!(p_17 === 0))) {
      dealloc_0_sysvq0asl(allocator_3, p_17);
    }
  }
  return result_64;
}

let allocator_0_sysvq0asl = allocFixed(6528);

function alloc_1_sysvq0asl(size_24) {
  let result_69;
  let X60Qx_211 = alloc_0_sysvq0asl(allocator_0_sysvq0asl, size_24);
  result_69 = X60Qx_211;
  return result_69;
}

function realloc_1_sysvq0asl(p_19, size_26) {
  let result_71;
  let X60Qx_213 = realloc_0_sysvq0asl(allocator_0_sysvq0asl, p_19, size_26);
  result_71 = X60Qx_213;
  return result_71;
}

function dealloc_1_sysvq0asl(p_20) {
  dealloc_0_sysvq0asl(allocator_0_sysvq0asl, p_20);
}

function allocatedSize_0_sysvq0asl(p_21) {
  let result_72;
  let X60Qx_214 = ptrSize_0_sysvq0asl(p_21);
  result_72 = X60Qx_214;
  return result_72;
}

let missingBytes_0_sysvq0asl = allocFixed(4);

function continueAfterOutOfMem_0_sysvq0asl(size_28) {
  if ((mem.i32(missingBytes_0_sysvq0asl) < ((2147483647 - size_28) | 0))) {
    mem.setI32(missingBytes_0_sysvq0asl, ((mem.i32(missingBytes_0_sysvq0asl) + size_28) | 0));
  } else {
    mem.setI32(missingBytes_0_sysvq0asl, 2147483647);
  }
}

let oomHandler_0_sysvq0asl = allocFixed(4);

mem.setU32(oomHandler_0_sysvq0asl, _fnid(continueAfterOutOfMem_0_sysvq0asl));

function recalcCap_0_sysvq0asl(oldCap_0, addedElements_0) {
  let result_85;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = ((oldCap_0 + addedElements_0) | 0);
  let requiredLen_0 = X60QconstRefTemp_0;
  if (false) {
    result_85 = 2147483647;
  } else {
    let X60QconstRefTemp_1;
    X60QconstRefTemp_1 = ((oldCap_0 + (oldCap_0 >> 1)) | 0);
    result_85 = X60QconstRefTemp_1;
    if (false) {
      result_85 = requiredLen_0;
    } else {
      let X60Qx_219 = max_2_sysvq0asl(result_85, requiredLen_0);
      result_85 = X60Qx_219;
    }
  }
  return result_85;
}

function ssLenOf_0_sysvq0asl(bytes_2) {
  let result_95;
  result_95 = ((bytes_2 & 255) >>> 0);
  return result_95;
}

function rawData_1_sysvq0asl(s_33) {
  let result_96;
  if ((6 < mem.u8At(s_33))) {
    result_96 = (mem.u32((s_33 + 4)) + 12);
  } else {
    result_96 = ((s_33 + 1) >>> 0);
  }
  return result_96;
}

function len_4_sysvq0asl(s_34) {
  let result_98;
  result_98 = mem.u8At(s_34);
  if ((6 < result_98)) {
    result_98 = mem.i32(mem.u32((s_34 + 4)));
  }
  return result_98;
}

function high_4_sysvq0asl(s_35) {
  let result_99;
  let X60Qx_220 = len_4_sysvq0asl(s_35);
  result_99 = ((X60Qx_220 - 1) | 0);
  return result_99;
}

function readRawData_0_sysvq0asl(s_39, start_0) {
  let result_103;
  if ((6 < mem.u8At(s_39))) {
    result_103 = (((mem.u32((s_39 + 4)) + 12) + start_0) >>> 0);
  } else {
    result_103 = ((((s_39 + 1) >>> 0) + start_0) >>> 0);
  }
  return result_103;
}

function nimStrWasMoved(s_40) {
  mem.setU32(s_40, 0);
}

function nimStrDestroy(s_41) {
  if ((mem.u8At(s_41) === 255)) {
    let X60Qx_221 = arcDec_0_sysvq0asl((mem.u32((s_41 + 4)) + 4));
    if (X60Qx_221) {
      dealloc_1_sysvq0asl(mem.u32((s_41 + 4)));
    }
  }
}

function nimStrCopy(dest_11, src_6) {
  let ssrc_0 = mem.u8At(src_6);
  if ((ssrc_0 <= 6)) {
    let sdest_0 = mem.u8At(dest_11);
    if ((sdest_0 === 255)) {
      let X60Qx_222 = arcDec_0_sysvq0asl((mem.u32((dest_11 + 4)) + 4));
      if (X60Qx_222) {
        dealloc_1_sysvq0asl(mem.u32((dest_11 + 4)));
      }
    }
    copyMem_0_sysvq0asl(dest_11, src_6, 8);
  } else {
    if ((dest_11 === src_6)) {
      return;
    }
    let sdest_1 = mem.u8At(dest_11);
    if ((sdest_1 === 255)) {
      let X60Qx_223 = arcDec_0_sysvq0asl((mem.u32((dest_11 + 4)) + 4));
      if (X60Qx_223) {
        dealloc_1_sysvq0asl(mem.u32((dest_11 + 4)));
      }
    }
    if ((ssrc_0 === 255)) {
      arcInc_0_sysvq0asl((mem.u32((src_6 + 4)) + 4));
    }
    copyMem_0_sysvq0asl(dest_11, src_6, 8);
  }
}

function nimStrDup(s_42) {
  let result_104 = allocFixed(8);
  let X60Qx_224 = ssLenOf_0_sysvq0asl(mem.u32(s_42));
  if ((X60Qx_224 === 255)) {
    arcInc_0_sysvq0asl((mem.u32((s_42 + 4)) + 4));
  }
  mem.copy(result_104, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, mem.u32(s_42));
    mem.setU32((_o + 4), mem.u32((s_42 + 4)));
    return _o;
  })(), 8);
  return result_104;
}

function len_5_sysvq0asl(a_46) {
  let result_105;
  let X60Qx_19;
  if ((a_46 === 0)) {
    X60Qx_19 = 0;
  } else {
    let X60Qx_225 = strlen(a_46);
    X60Qx_19 = X60Qx_225;
  }
  result_105 = X60Qx_19;
  return result_105;
}

function ssResize_0_sysvq0asl(old_0) {
  let result_106;
  let X60Qx_20;
  if ((old_0 <= 0)) {
    X60Qx_20 = 4;
  } else {
    if ((old_0 <= 32767)) {
      X60Qx_20 = Math.imul(old_0, 2);
    } else {
      X60Qx_20 = ((Math.trunc((old_0 / 2)) + old_0) | 0);
    }
  }
  result_106 = X60Qx_20;
  return result_106;
}

function ensureUniqueLong_0_sysvq0asl(s_43, oldLen_0, newLen_5) {
  let sl_10 = mem.u8At(s_43);
  let isHeap_0 = (sl_10 === 255);
  let X60Qx_21;
  if (isHeap_0) {
    X60Qx_21 = mem.i32((mem.u32((s_43 + 4)) + 8));
  } else {
    X60Qx_21 = 0;
  }
  let cap_1 = X60Qx_21;
  let X60Qx_226;
  let X60Qx_227;
  if (isHeap_0) {
    let X60Qx_228 = arcIsUnique_0_sysvq0asl((mem.u32((s_43 + 4)) + 4));
    X60Qx_227 = X60Qx_228;
  } else {
    X60Qx_227 = false;
  }
  if (X60Qx_227) {
    X60Qx_226 = (newLen_5 <= cap_1);
  } else {
    X60Qx_226 = false;
  }
  if (X60Qx_226) {
    mem.setI32(mem.u32((s_43 + 4)), newLen_5);
    let X60Qx_229 = min_2_sysvq0asl(oldLen_0, 3);
    copyMem_0_sysvq0asl(((s_43 + 1) >>> 0), (mem.u32((s_43 + 4)) + 12), X60Qx_229);
  } else {
    let X60Qx_22;
    if ((cap_1 < newLen_5)) {
      let X60Qx_230 = ssResize_0_sysvq0asl(cap_1);
      let X60Qx_231 = max_2_sysvq0asl(newLen_5, X60Qx_230);
      X60Qx_22 = X60Qx_231;
    } else {
      X60Qx_22 = cap_1;
    }
    let newCap_2 = X60Qx_22;
    let X60Qx_232 = alloc_1_sysvq0asl(((12 + newCap_2) | 0));
    let p_35 = X60Qx_232;
    if ((!(p_35 === 0))) {
      mem.setI32((p_35 + 4), 0);
      mem.setI32(p_35, newLen_5);
      mem.setI32((p_35 + 8), newCap_2);
      if (isHeap_0) {
        let old_2 = mem.u32((s_43 + 4));
        let X60Qx_233 = min_2_sysvq0asl(oldLen_0, newCap_2);
        copyMem_0_sysvq0asl((p_35 + 12), (old_2 + 12), X60Qx_233);
        let X60Qx_234 = arcDec_0_sysvq0asl((old_2 + 4));
        if (X60Qx_234) {
          dealloc_1_sysvq0asl(old_2);
        }
      } else {
        let X60Qx_235 = min_2_sysvq0asl(oldLen_0, newCap_2);
        copyMem_0_sysvq0asl((p_35 + 12), (mem.u32((s_43 + 4)) + 12), X60Qx_235);
      }
      mem.setU32((s_43 + 4), p_35);
      mem.setU8(s_43, (255 & 255));
      let X60Qx_236 = min_2_sysvq0asl(oldLen_0, 3);
      copyMem_0_sysvq0asl(((s_43 + 1) >>> 0), (p_35 + 12), X60Qx_236);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + newCap_2) | 0));
      mem.setU32(s_43, 21760775509248519n);
      mem.setU32((s_43 + 4), 0);
    }
  }
}

function transitionToLong_0_sysvq0asl(s_44, sl_4, newLen_6) {
  let X60Qx_237 = ssResize_0_sysvq0asl(newLen_6);
  let newCap_3 = max_2_sysvq0asl(newLen_6, X60Qx_237);
  let X60Qx_238 = alloc_1_sysvq0asl(((12 + newCap_3) | 0));
  let p_36 = X60Qx_238;
  if ((!(p_36 === 0))) {
    mem.setI32((p_36 + 4), 0);
    mem.setI32(p_36, newLen_6);
    mem.setI32((p_36 + 8), newCap_3);
    copyMem_0_sysvq0asl((p_36 + 12), ((s_44 + 1) >>> 0), sl_4);
    mem.setU32((s_44 + 4), p_36);
    mem.setU8(s_44, (255 & 255));
    let X60Qx_239 = min_2_sysvq0asl(sl_4, 3);
    copyMem_0_sysvq0asl(((s_44 + 1) >>> 0), (p_36 + 12), X60Qx_239);
  } else {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + newCap_3) | 0));
    mem.setU32(s_44, 21760775509248519n);
    mem.setU32((s_44 + 4), 0);
  }
}

function prepareMutation_0_sysvq0asl(s_46) {
  let sl_12 = mem.u8At(s_46);
  let X60Qx_242;
  if ((sl_12 === 254)) {
    X60Qx_242 = true;
  } else {
    let X60Qx_243;
    if ((sl_12 === 255)) {
      let X60Qx_244 = arcIsUnique_0_sysvq0asl((mem.u32((s_46 + 4)) + 4));
      X60Qx_243 = (!X60Qx_244);
    } else {
      X60Qx_243 = false;
    }
    X60Qx_242 = X60Qx_243;
  }
  if (X60Qx_242) {
    if ((sl_12 === 255)) {
      let X60Qx_245 = arcDec_0_sysvq0asl((mem.u32((s_46 + 4)) + 4));
    }
    let old_3 = mem.u32((s_46 + 4));
    let oldLen_1 = mem.i32(old_3);
    let X60Qx_246 = alloc_1_sysvq0asl(((12 + oldLen_1) | 0));
    let p_37 = X60Qx_246;
    if ((!(p_37 === 0))) {
      mem.setI32((p_37 + 4), 0);
      mem.setI32(p_37, oldLen_1);
      mem.setI32((p_37 + 8), oldLen_1);
      copyMem_0_sysvq0asl((p_37 + 12), (old_3 + 12), oldLen_1);
      mem.setU32((s_46 + 4), p_37);
      mem.setU8(s_46, (255 & 255));
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + oldLen_1) | 0));
      mem.setU32(s_46, 21760775509248519n);
      mem.setU32((s_46 + 4), 0);
    }
  }
}

function add_1_sysvq0asl(s_49, c_14) {
  let sl_14 = mem.u8At(s_49);
  if ((sl_14 < 6)) {
    let newLen_14 = ((sl_14 + 1) | 0);
    mem.setU8((((s_49 + 1) >>> 0) + sl_14), c_14);
    mem.setU8(s_49, (newLen_14 & 255));
  } else {
    if ((6 < sl_14)) {
      let l_1 = mem.i32(mem.u32((s_49 + 4)));
      let X60Qx_248;
      let X60Qx_249;
      if ((sl_14 === 255)) {
        let X60Qx_250 = arcIsUnique_0_sysvq0asl((mem.u32((s_49 + 4)) + 4));
        X60Qx_249 = X60Qx_250;
      } else {
        X60Qx_249 = false;
      }
      if (X60Qx_249) {
        X60Qx_248 = (l_1 < mem.i32((mem.u32((s_49 + 4)) + 8)));
      } else {
        X60Qx_248 = false;
      }
      if (X60Qx_248) {
        mem.setU8(((mem.u32((s_49 + 4)) + 12) + l_1), c_14);
        mem.setI32(mem.u32((s_49 + 4)), ((l_1 + 1) | 0));
        if ((l_1 < 3)) {
          mem.setU8((((s_49 + 1) >>> 0) + l_1), c_14);
        }
      } else {
        let oldLen_2 = mem.i32(mem.u32((s_49 + 4)));
        ensureUniqueLong_0_sysvq0asl(s_49, oldLen_2, ((oldLen_2 + 1) | 0));
        if ((mem.u8At(s_49) === 255)) {
          mem.setU8(((mem.u32((s_49 + 4)) + 12) + oldLen_2), c_14);
          if ((oldLen_2 < 3)) {
            mem.setU8((((s_49 + 1) >>> 0) + oldLen_2), c_14);
          }
        }
      }
    } else {
      transitionToLong_0_sysvq0asl(s_49, sl_14, ((sl_14 + 1) | 0));
      if ((mem.u8At(s_49) === 255)) {
        mem.setU8(((mem.u32((s_49 + 4)) + 12) + sl_14), c_14);
      }
    }
  }
}

function add_2_sysvq0asl(s_50, part_0) {
  let partLen_0 = len_4_sysvq0asl(part_0);
  if ((partLen_0 === 0)) {
    return;
  }
  let partData_0 = rawData_1_sysvq0asl(part_0);
  let sl_15 = mem.u8At(s_50);
  if ((sl_15 <= 6)) {
    let sLen_0 = sl_15;
    let newLen_15 = ((sLen_0 + partLen_0) | 0);
    if ((newLen_15 <= 6)) {
      copyMem_0_sysvq0asl(((((s_50 + 1) >>> 0) + sLen_0) >>> 0), partData_0, partLen_0);
      mem.setU8(s_50, (newLen_15 & 255));
    } else {
      transitionToLong_0_sysvq0asl(s_50, sLen_0, newLen_15);
      if ((mem.u8At(s_50) === 255)) {
        copyMem_0_sysvq0asl((((mem.u32((s_50 + 4)) + 12) + sLen_0) >>> 0), partData_0, partLen_0);
        copyMem_0_sysvq0asl(((s_50 + 1) >>> 0), (mem.u32((s_50 + 4)) + 12), 3);
      }
    }
  } else {
    let sLen_1 = mem.i32(mem.u32((s_50 + 4)));
    let newLen_16 = ((sLen_1 + partLen_0) | 0);
    ensureUniqueLong_0_sysvq0asl(s_50, sLen_1, newLen_16);
    if ((mem.u8At(s_50) === 255)) {
      copyMem_0_sysvq0asl((((mem.u32((s_50 + 4)) + 12) + sLen_1) >>> 0), partData_0, partLen_0);
      if ((sLen_1 < 3)) {
        copyMem_0_sysvq0asl(((s_50 + 1) >>> 0), (mem.u32((s_50 + 4)) + 12), 3);
      }
    }
  }
}

function zeroSwarPadImplLE_0_sysvq0asl(bytes_4, newLen_9) {
  let result_110;
  let keepBits_0 = Math.imul(((newLen_9 + 1) | 0), 8);
  let X60Qx_25;
  if ((Math.imul(4, 8) <= keepBits_0)) {
    X60Qx_25 = ((~0) >>> 0);
  } else {
    X60Qx_25 = ((((1 << keepBits_0) >>> 0) - 1) >>> 0);
  }
  let mask_0 = X60Qx_25;
  result_110 = ((((bytes_4 & ((mask_0 & ((~255) >>> 0)) >>> 0)) >>> 0) | newLen_9) >>> 0);
  return result_110;
}

function zeroSwarPadImpl_0_sysvq0asl(bytes_5, newLen_10) {
  let result_111;
  let X60Qx_251 = zeroSwarPadImplLE_0_sysvq0asl(bytes_5, newLen_10);
  result_111 = X60Qx_251;
  return result_111;
}

function shrink_1_sysvq0asl(s_52, newLen_12) {
  let X60Qx_252 = len_4_sysvq0asl(s_52);
  if ((newLen_12 <= X60Qx_252)) {
    let sl_16 = mem.u8At(s_52);
    if ((sl_16 <= 6)) {
      if ((newLen_12 <= 3)) {
        let X60Qx_253 = zeroSwarPadImpl_0_sysvq0asl(mem.u32(s_52), newLen_12);
        mem.setU32(s_52, X60Qx_253);
      } else {
        mem.setU8(s_52, (newLen_12 & 255));
      }
    } else {
      prepareMutation_0_sysvq0asl(s_52);
      mem.setI32(mem.u32((s_52 + 4)), newLen_12);
      let X60Qx_254 = min_2_sysvq0asl(newLen_12, 3);
      copyMem_0_sysvq0asl(((s_52 + 1) >>> 0), (mem.u32((s_52 + 4)) + 12), X60Qx_254);
    }
  }
}

function getQ_9_sysvq0asl(s_54, i_14) {
  let X60Qx_257;
  let X60Qx_258 = len_4_sysvq0asl(s_54);
  if ((i_14 < X60Qx_258)) {
    X60Qx_257 = (0 <= i_14);
  } else {
    X60Qx_257 = false;
  }
  if ((!X60Qx_257)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14131790745264837101_sysvq0asl);
      return _o;
    })());
  }
  let result_112;
  let X60Qx_26;
  if ((6 < mem.u8At(s_54))) {
    X60Qx_26 = mem.u8At(((mem.u32((s_54 + 4)) + 12) + i_14));
  } else {
    X60Qx_26 = mem.u8At((((s_54 + 1) >>> 0) + i_14));
  }
  result_112 = X60Qx_26;
  return result_112;
}

function putQ_9_sysvq0asl(s_55, i_15, c_15) {
  let X60Qx_259;
  let X60Qx_260 = len_4_sysvq0asl(s_55);
  if ((i_15 < X60Qx_260)) {
    X60Qx_259 = (0 <= i_15);
  } else {
    X60Qx_259 = false;
  }
  if ((!X60Qx_259)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I11927585966806674622_sysvq0asl);
      return _o;
    })());
  }
  prepareMutation_0_sysvq0asl(s_55);
  if ((6 < mem.u8At(s_55))) {
    mem.setU8(((mem.u32((s_55 + 4)) + 12) + i_15), c_15);
    if ((i_15 < 3)) {
      mem.setU8((((s_55 + 1) >>> 0) + i_15), c_15);
    }
  } else {
    mem.setU8((((s_55 + 1) >>> 0) + i_15), c_15);
  }
}

function substr_0_sysvq0asl(s_56, first_0, last_0) {
  let result_113 = allocFixed(8);
  nimStrWasMoved(result_113);
  nimStrDestroy(result_113);
  mem.copy(result_113, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  let sLen_2 = len_4_sysvq0asl(s_56);
  let f_4 = max_2_sysvq0asl(first_0, 0);
  let X60Qx_261 = min_2_sysvq0asl(last_0, ((sLen_2 - 1) | 0));
  let l_2 = ((X60Qx_261 + 1) | 0);
  if ((l_2 <= f_4)) {
    return result_113;
  }
  let newLen_17 = ((l_2 - f_4) | 0);
  let src_7 = rawData_1_sysvq0asl(s_56);
  if ((newLen_17 <= 6)) {
    mem.setU8(result_113, (newLen_17 & 255));
    copyMem_0_sysvq0asl(((result_113 + 1) >>> 0), ((src_7 + f_4) >>> 0), newLen_17);
  } else {
    let X60Qx_262 = alloc_1_sysvq0asl(((12 + newLen_17) | 0));
    let p_38 = X60Qx_262;
    if ((!(p_38 === 0))) {
      mem.setI32((p_38 + 4), 0);
      mem.setI32(p_38, newLen_17);
      mem.setI32((p_38 + 8), newLen_17);
      copyMem_0_sysvq0asl((p_38 + 12), ((src_7 + f_4) >>> 0), newLen_17);
      mem.setU32((result_113 + 4), p_38);
      mem.setU8(result_113, (255 & 255));
      copyMem_0_sysvq0asl(((result_113 + 1) >>> 0), (p_38 + 12), 3);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + newLen_17) | 0));
      mem.setU32(result_113, 21760775509248519n);
      mem.setU32((result_113 + 4), 0);
    }
  }
  return result_113;
}

function ctzImpl_0_sysvq0asl(x_313) {
  let result_116;
  let X60Qx_266 = __builtin_ctzll(BigInt(x_313));
  result_116 = X60Qx_266;
  return result_116;
}

function cmpInlineBytes_0_sysvq0asl(a_47, b_10, n_3) {
  forStmtLabel_0: {
    var result_120;
    result_120 = 0;
    {
      whileStmtLabel_1: {
        var X60Qlf_3 = 0;
        var X60Qlf_4 = n_3;
        var X60Qlf_5 = allocFixed(4);
        mem.setI32(X60Qlf_5, X60Qlf_3);
        {
          while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
            {
              var X60Qii_2 = mem.u8At((a_47 + mem.i32(X60Qlf_5)));
              var X60Qii_3 = mem.u8At((b_10 + mem.i32(X60Qlf_5)));
              if ((X60Qii_2 < X60Qii_3)) {
                return -1;
              }
              if ((X60Qii_3 < X60Qii_2)) {
                return 1;
              }
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_5);
          }
        }
      }
    }
  }
  return result_120;
}

function cmpShortInlineLE_0_sysvq0asl(abytes_1, bbytes_1, aslen_1, bslen_1) {
  let result_122;
  let minLen_1 = min_2_sysvq0asl(aslen_1, bslen_1);
  if ((0 < minLen_1)) {
    let diffMask_0 = ((((1 << Math.imul(minLen_1, 8)) >>> 0) - 1) >>> 0);
    let diff_3 = (((((abytes_1 ^ bbytes_1) >>> 0) >>> 8) & diffMask_0) >>> 0);
    if ((!(diff_3 === 0))) {
      let X60Qx_270 = ctzImpl_0_sysvq0asl(diff_3);
      let byteShift_0 = ((Math.imul((X60Qx_270 >> 3), 8) + 8) | 0);
      let ac_2 = (((abytes_1 >>> byteShift_0) & 255) >>> 0);
      let bc_2 = (((bbytes_1 >>> byteShift_0) & 255) >>> 0);
      if ((ac_2 < bc_2)) {
        return -1;
      }
      return 1;
    }
  }
  result_122 = ((aslen_1 - bslen_1) | 0);
  return result_122;
}

function cmpShortInline_0_sysvq0asl(abytes_2, bbytes_2, aslen_2, bslen_2) {
  let result_123;
  let X60Qx_271 = cmpShortInlineLE_0_sysvq0asl(abytes_2, bbytes_2, aslen_2, bslen_2);
  result_123 = X60Qx_271;
  return result_123;
}

function cmpStringPtrs_0_sysvq0asl(a_48, b_11) {
  let result_124;
  let abytes_3 = mem.u32(a_48);
  let bbytes_3 = mem.u32(b_11);
  let aslen_3 = ssLenOf_0_sysvq0asl(abytes_3);
  let bslen_3 = ssLenOf_0_sysvq0asl(bbytes_3);
  let X60Qx_272;
  if ((aslen_3 <= 3)) {
    X60Qx_272 = (bslen_3 <= 3);
  } else {
    X60Qx_272 = false;
  }
  if (X60Qx_272) {
    let X60Qx_273 = cmpShortInline_0_sysvq0asl(abytes_3, bbytes_3, aslen_3, bslen_3);
    result_124 = X60Qx_273;
    return result_124;
  }
  let X60Qx_274;
  if ((aslen_3 <= 6)) {
    X60Qx_274 = (bslen_3 <= 6);
  } else {
    X60Qx_274 = false;
  }
  if (X60Qx_274) {
    let minLen_2 = min_2_sysvq0asl(aslen_3, bslen_3);
    let pfxLen_0 = min_2_sysvq0asl(minLen_2, 3);
    let X60Qx_275 = cmpInlineBytes_0_sysvq0asl(((a_48 + 1) >>> 0), ((b_11 + 1) >>> 0), pfxLen_0);
    result_124 = X60Qx_275;
    if ((!(result_124 === 0))) {
      return result_124;
    }
    if ((3 < minLen_2)) {
      let X60Qx_276 = cmpInlineBytes_0_sysvq0asl(((((a_48 + 1) >>> 0) + 3) >>> 0), ((((b_11 + 1) >>> 0) + 3) >>> 0), ((minLen_2 - 3) | 0));
      result_124 = X60Qx_276;
    }
    if ((result_124 === 0)) {
      result_124 = ((aslen_3 - bslen_3) | 0);
    }
    return result_124;
  }
  let X60Qx_27;
  if ((6 < aslen_3)) {
    X60Qx_27 = mem.i32(mem.u32((a_48 + 4)));
  } else {
    X60Qx_27 = aslen_3;
  }
  let la_0 = X60Qx_27;
  let X60Qx_28;
  if ((6 < bslen_3)) {
    X60Qx_28 = mem.i32(mem.u32((b_11 + 4)));
  } else {
    X60Qx_28 = bslen_3;
  }
  let lb_0 = X60Qx_28;
  let minLen_3 = min_2_sysvq0asl(la_0, lb_0);
  let pfxLen_1 = min_2_sysvq0asl(minLen_3, 3);
  let X60Qx_277 = cmpInlineBytes_0_sysvq0asl(((a_48 + 1) >>> 0), ((b_11 + 1) >>> 0), pfxLen_1);
  result_124 = X60Qx_277;
  if ((!(result_124 === 0))) {
    return result_124;
  }
  if ((minLen_3 <= 3)) {
    result_124 = ((la_0 - lb_0) | 0);
    return result_124;
  }
  let X60Qx_29;
  if ((6 < aslen_3)) {
    X60Qx_29 = (((mem.u32((a_48 + 4)) + 12) + 3) >>> 0);
  } else {
    X60Qx_29 = ((((a_48 + 1) >>> 0) + 3) >>> 0);
  }
  let ap_0 = X60Qx_29;
  let X60Qx_30;
  if ((6 < bslen_3)) {
    X60Qx_30 = (((mem.u32((b_11 + 4)) + 12) + 3) >>> 0);
  } else {
    X60Qx_30 = ((((b_11 + 1) >>> 0) + 3) >>> 0);
  }
  let bp_0 = X60Qx_30;
  let X60Qx_278 = cmpMem_0_sysvq0asl(ap_0, bp_0, ((minLen_3 - 3) | 0));
  result_124 = X60Qx_278;
  if ((result_124 === 0)) {
    result_124 = ((la_0 - lb_0) | 0);
  }
  return result_124;
}

function equalStrings_0_sysvq0asl(a_49, b_12) {
  let result_125;
  let abytes_4 = mem.u32(a_49);
  let bbytes_4 = mem.u32(b_12);
  let aslen_4 = ssLenOf_0_sysvq0asl(abytes_4);
  let bslen_4 = ssLenOf_0_sysvq0asl(bbytes_4);
  let X60Qx_279;
  if ((aslen_4 <= 3)) {
    X60Qx_279 = (bslen_4 <= 3);
  } else {
    X60Qx_279 = false;
  }
  if (X60Qx_279) {
    result_125 = (abytes_4 === bbytes_4);
    return result_125;
  }
  let X60Qx_31;
  if ((6 < aslen_4)) {
    X60Qx_31 = mem.i32(mem.u32((a_49 + 4)));
  } else {
    X60Qx_31 = aslen_4;
  }
  let la_1 = X60Qx_31;
  let X60Qx_32;
  if ((6 < bslen_4)) {
    X60Qx_32 = mem.i32(mem.u32((b_12 + 4)));
  } else {
    X60Qx_32 = bslen_4;
  }
  let lb_1 = X60Qx_32;
  if ((!(la_1 === lb_1))) {
    return false;
  }
  if ((la_1 === 0)) {
    return true;
  }
  let X60Qx_280;
  if ((aslen_4 <= 6)) {
    X60Qx_280 = (bslen_4 <= 6);
  } else {
    X60Qx_280 = false;
  }
  if (X60Qx_280) {
    if ((!(abytes_4 === bbytes_4))) {
      return false;
    }
    let X60Qx_281 = cmpMem_0_sysvq0asl(((((a_49 + 1) >>> 0) + 3) >>> 0), ((((b_12 + 1) >>> 0) + 3) >>> 0), ((la_1 - 3) | 0));
    result_125 = (X60Qx_281 === 0);
    return result_125;
  }
  let X60Qx_282 = cmpStringPtrs_0_sysvq0asl(a_49, b_12);
  result_125 = (X60Qx_282 === 0);
  return result_125;
}

function eqQ_20_sysvq0asl(a_50, b_13) {
  let result_126;
  let X60Qx_283 = equalStrings_0_sysvq0asl(a_50, b_13);
  result_126 = X60Qx_283;
  return result_126;
}

function nimStrAtLe_0_sysvq0asl(s_58, idx_2, ch_0) {
  let result_127;
  let X60Qx_284;
  let X60Qx_285 = len_4_sysvq0asl(s_58);
  if ((idx_2 < X60Qx_285)) {
    let X60Qx_286 = getQ_9_sysvq0asl(s_58, idx_2);
    X60Qx_284 = (X60Qx_286 <= ch_0);
  } else {
    X60Qx_284 = false;
  }
  result_127 = X60Qx_284;
  return result_127;
}

function newString_0_sysvq0asl(len_4) {
  let result_132 = allocFixed(8);
  nimStrWasMoved(result_132);
  nimStrDestroy(result_132);
  mem.copy(result_132, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((len_4 <= 0)) {
    return result_132;
  }
  if ((len_4 <= 6)) {
    mem.setU8(result_132, (len_4 & 255));
    zeroMem_0_sysvq0asl(((result_132 + 1) >>> 0), len_4);
  } else {
    let X60Qx_294 = alloc_1_sysvq0asl(((12 + len_4) | 0));
    let p_39 = X60Qx_294;
    if ((!(p_39 === 0))) {
      zeroMem_0_sysvq0asl(p_39, ((12 + len_4) | 0));
      mem.setI32((p_39 + 4), 0);
      mem.setI32(p_39, len_4);
      mem.setI32((p_39 + 8), len_4);
      mem.setU32((result_132 + 4), p_39);
      mem.setU8(result_132, (255 & 255));
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + len_4) | 0));
      mem.setU32(result_132, 21760775509248519n);
      mem.setU32((result_132 + 4), 0);
    }
  }
  return result_132;
}

function newStringOfCap_0_sysvq0asl(len_5) {
  let result_133 = allocFixed(8);
  nimStrWasMoved(result_133);
  nimStrDestroy(result_133);
  mem.copy(result_133, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((len_5 <= 6)) {
    return result_133;
  }
  let X60Qx_295 = alloc_1_sysvq0asl(((12 + len_5) | 0));
  let p_40 = X60Qx_295;
  if ((!(p_40 === 0))) {
    zeroMem_0_sysvq0asl(p_40, ((12 + len_5) | 0));
    mem.setI32((p_40 + 4), 0);
    mem.setI32(p_40, 0);
    mem.setI32((p_40 + 8), len_5);
    mem.setU32((result_133 + 4), p_40);
    mem.setU8(result_133, (255 & 255));
  } else {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + len_5) | 0));
    mem.setU32(result_133, 21760775509248519n);
    mem.setU32((result_133 + 4), 0);
  }
  return result_133;
}

function ampQ_0_sysvq0asl(a_54, b_17) {
  let result_134 = allocFixed(8);
  nimStrWasMoved(result_134);
  nimStrDestroy(result_134);
  mem.copy(result_134, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  let X60Qx_296 = len_4_sysvq0asl(a_54);
  let X60Qx_297 = len_4_sysvq0asl(b_17);
  let rlen_0 = ((X60Qx_296 + X60Qx_297) | 0);
  if ((rlen_0 === 0)) {
    return result_134;
  }
  if ((rlen_0 <= 6)) {
    let al_0 = len_4_sysvq0asl(a_54);
    mem.setU8(result_134, (rlen_0 & 255));
    if ((0 < al_0)) {
      let X60Qx_298 = rawData_1_sysvq0asl(a_54);
      copyMem_0_sysvq0asl(((result_134 + 1) >>> 0), X60Qx_298, al_0);
    }
    let X60Qx_299 = len_4_sysvq0asl(b_17);
    if ((0 < X60Qx_299)) {
      let X60Qx_300 = rawData_1_sysvq0asl(b_17);
      let X60Qx_301 = len_4_sysvq0asl(b_17);
      copyMem_0_sysvq0asl(((((result_134 + 1) >>> 0) + al_0) >>> 0), X60Qx_300, X60Qx_301);
    }
  } else {
    let X60Qx_302 = alloc_1_sysvq0asl(((12 + rlen_0) | 0));
    let p_41 = X60Qx_302;
    if ((!(p_41 === 0))) {
      mem.setI32((p_41 + 4), 0);
      mem.setI32(p_41, rlen_0);
      mem.setI32((p_41 + 8), rlen_0);
      let al_1 = len_4_sysvq0asl(a_54);
      if ((0 < al_1)) {
        let X60Qx_303 = rawData_1_sysvq0asl(a_54);
        copyMem_0_sysvq0asl((p_41 + 12), X60Qx_303, al_1);
      }
      let X60Qx_304 = len_4_sysvq0asl(b_17);
      if ((0 < X60Qx_304)) {
        let X60Qx_305 = rawData_1_sysvq0asl(b_17);
        let X60Qx_306 = len_4_sysvq0asl(b_17);
        copyMem_0_sysvq0asl((((p_41 + 12) + al_1) >>> 0), X60Qx_305, X60Qx_306);
      }
      mem.setU32((result_134 + 4), p_41);
      mem.setU8(result_134, (255 & 255));
      copyMem_0_sysvq0asl(((result_134 + 1) >>> 0), (p_41 + 12), 3);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + rlen_0) | 0));
      mem.setU32(result_134, 21760775509248519n);
      mem.setU32((result_134 + 4), 0);
    }
  }
  return result_134;
}

function borrowCStringUnsafe_0_sysvq0asl(s_61, l_0) {
  let result_139 = allocFixed(8);
  nimStrWasMoved(result_139);
  nimStrDestroy(result_139);
  mem.copy(result_139, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((l_0 <= 0)) {
    return result_139;
  }
  if ((l_0 <= 6)) {
    mem.setU8(result_139, (l_0 & 255));
    copyMem_0_sysvq0asl(((result_139 + 1) >>> 0), s_61, l_0);
  } else {
    let X60Qx_311 = alloc_1_sysvq0asl(((12 + l_0) | 0));
    let p_42 = X60Qx_311;
    if ((!(p_42 === 0))) {
      mem.setI32((p_42 + 4), 0);
      mem.setI32(p_42, l_0);
      mem.setI32((p_42 + 8), l_0);
      copyMem_0_sysvq0asl((p_42 + 12), s_61, l_0);
      mem.setU32((result_139 + 4), p_42);
      mem.setU8(result_139, (255 & 255));
      copyMem_0_sysvq0asl(((result_139 + 1) >>> 0), (p_42 + 12), 3);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + l_0) | 0));
      mem.setU32(result_139, 21760775509248519n);
      mem.setU32((result_139 + 4), 0);
    }
  }
  return result_139;
}

function nimBorrowCStringUnsafe(s_62) {
  let result_140 = allocFixed(8);
  nimStrWasMoved(result_140);
  nimStrDestroy(result_140);
  let X60Qx_312 = len_5_sysvq0asl(s_62);
  let X60Qx_313 = allocFixed(8);
  mem.copy(X60Qx_313, borrowCStringUnsafe_0_sysvq0asl(s_62, X60Qx_312), 8);
  mem.copy(result_140, X60Qx_313, 8);
  return result_140;
}

function ensureTerminatingZero_0_sysvq0asl(s_63) {
  let oldLen_3 = len_4_sysvq0asl(s_63);
  add_1_sysvq0asl(s_63, 0);
  shrink_1_sysvq0asl(s_63, oldLen_3);
}

function toCString_0_sysvq0asl(s_64) {
  let result_141;
  ensureTerminatingZero_0_sysvq0asl(s_64);
  let X60Qx_314 = rawData_1_sysvq0asl(s_64);
  result_141 = X60Qx_314;
  return result_141;
}

function arcInc_0_sysvq0asl(memLoc_0) {
  let X60Qx_318 = __atomic_add_fetch(memLoc_0, 1, __ATOMIC_SEQ_CST);
}

function arcDec_0_sysvq0asl(memLoc_1) {
  let result_156;
  let X60Qx_319 = __atomic_sub_fetch(memLoc_1, 1, __ATOMIC_SEQ_CST);
  result_156 = (X60Qx_319 < 0);
  return result_156;
}

function arcIsUnique_0_sysvq0asl(memLoc_2) {
  let result_157;
  let X60Qx_320 = __atomic_load_n(memLoc_2, __ATOMIC_ACQUIRE);
  result_157 = (X60Qx_320 === 0);
  return result_157;
}

function writeErr_0_sysvq0asl(x_330) {
  fprintf(stderr, "%lld", x_330);
}

function writeErr_1_sysvq0asl(x_331) {
  fprintf(stderr, "%llu", x_331);
}

function writeErr_2_sysvq0asl(s_68) {
  let X60Qx_321 = readRawData_0_sysvq0asl(s_68, 0);
  let X60Qx_322 = len_4_sysvq0asl(s_68);
  let X60Qx_323 = fwrite(X60Qx_321, 1, X60Qx_322, stderr);
}

function writeErr_3_sysvq0asl(s_69) {
  let X60Qx_324 = len_5_sysvq0asl(s_69);
  let X60Qx_325 = fwrite(s_69, 1, X60Qx_324, stderr);
}

function panic_0_sysvq0asl(s_70) {
  writeErr_2_sysvq0asl(s_70);
  exit(1);
}

function nimIcheckAB(i_18, a_68, b_21) {
  let result_158;
  let X60Qx_326;
  if ((a_68 <= i_18)) {
    X60Qx_326 = (i_18 <= b_21);
  } else {
    X60Qx_326 = false;
  }
  if (X60Qx_326) {
    result_158 = ((i_18 - a_68) | 0);
  } else {
    result_158 = 0;
    raiseIndexError3_0_I113jpc1_sysvq0asl(i_18, a_68, b_21);
  }
  return result_158;
}

function nimIcheckB(i_19, b_22) {
  let result_159;
  let X60Qx_327;
  if ((0 <= i_19)) {
    X60Qx_327 = (i_19 <= b_22);
  } else {
    X60Qx_327 = false;
  }
  if (X60Qx_327) {
    result_159 = i_19;
  } else {
    result_159 = 0;
    raiseIndexError3_0_I113jpc1_sysvq0asl(i_19, 0, b_22);
  }
  return result_159;
}

function nimUcheckAB(i_20, a_69, b_23) {
  let result_160;
  result_160 = ((i_20 - a_69) >>> 0);
  if ((b_23 < result_160)) {
    raiseIndexError3_0_Ic5mmkg_sysvq0asl(i_20, a_69, b_23);
  }
  return result_160;
}

function nimUcheckB(i_21, b_24) {
  let result_161;
  result_161 = i_21;
  if ((b_24 < result_161)) {
    raiseIndexError3_0_Ic5mmkg_sysvq0asl(i_21, 0, b_24);
  }
  return result_161;
}

function nimInvalidObjConv(name_0) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1986947582);
    mem.setU32((_o + 4), strlit_0_I15539159382304113184_sysvq0asl);
    return _o;
  })());
  writeErr_2_sysvq0asl(name_0);
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function nimChckNilDisp(p_25) {
  if ((p_25 === 0)) {
    writeErr_2_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1851876350);
      mem.setU32((_o + 4), strlit_0_I14281474217946372742_sysvq0asl);
      return _o;
    })());
    exit(1);
  }
}

function procAddrError_0_sysvq0asl(name_1) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970234366);
    mem.setU32((_o + 4), strlit_0_I10604297744791418982_sysvq0asl);
    return _o;
  })());
  writeErr_3_sysvq0asl(name_1);
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function nimLoadLibrary(path_2) {
  let result_162;
  let flags_1 = 2;
  let X60Qx_328 = dlopen(path_2, flags_1);
  result_162 = X60Qx_328;
  return result_162;
}

function nimGetProcAddr(lib_3, name_3) {
  let result_163;
  let X60Qx_329 = dlsym(lib_3, name_3);
  result_163 = X60Qx_329;
  if ((result_163 === 0)) {
    procAddrError_0_sysvq0asl(name_3);
  }
  return result_163;
}

function nimDynlibLoadStep(prev_0, cand_0) {
  let result_164;
  if ((!(prev_0 === 0))) {
    result_164 = prev_0;
  } else {
    let X60Qx_330 = nimLoadLibrary(cand_0);
    result_164 = X60Qx_330;
  }
  return result_164;
}

function nimDynlibCheck(lib_4, path_3) {
  let result_165;
  if ((lib_4 === 0)) {
    writeErr_2_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1970234366);
      mem.setU32((_o + 4), strlit_0_I16690852185662743073_sysvq0asl);
      return _o;
    })());
    writeErr_3_sysvq0asl(path_3);
    writeErr_2_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 2561);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    exit(1);
  }
  result_165 = lib_4;
  return result_165;
}

let exc_0_sysvq0asl = allocFixed(4);

function listAdd_0_Ik4wxhz_sysvq0asl(head_5, c_38) {
  mem.setU32((c_38 + 12), mem.u32(head_5));
  if ((!(mem.u32(head_5) === 0))) {
    mem.setU32((mem.u32(head_5) + 16), c_38);
  }
  mem.setU32(head_5, c_38);
}

function listRemove_0_Ibzev091_sysvq0asl(head_6, c_39) {
  if ((c_39 === mem.u32(head_6))) {
    mem.setU32(head_6, mem.u32((c_39 + 12)));
    if ((!(mem.u32(head_6) === 0))) {
      mem.setU32((mem.u32(head_6) + 16), 0);
    }
  } else {
    mem.setU32((mem.u32((c_39 + 16)) + 12), mem.u32((c_39 + 12)));
    if ((!(mem.u32((c_39 + 12)) === 0))) {
      mem.setU32((mem.u32((c_39 + 12)) + 16), mem.u32((c_39 + 16)));
    }
  }
  mem.setU32((c_39 + 12), 0);
  mem.setU32((c_39 + 16), 0);
}

function raiseIndexError3_0_I113jpc1_sysvq0asl(i_68, a_83, b_38) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684957694);
    mem.setU32((_o + 4), strlit_0_I11614695157650328859_sysvq0asl);
    return _o;
  })());
  writeErr_0_sysvq0asl(BigInt(i_68));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869488382);
    mem.setU32((_o + 4), strlit_0_I16845119709590674135_sysvq0asl);
    return _o;
  })());
  writeErr_0_sysvq0asl(BigInt(a_83));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 3026434);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  writeErr_0_sysvq0asl(BigInt(b_38));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function raiseIndexError3_0_Ic5mmkg_sysvq0asl(i_69, a_84, b_39) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684957694);
    mem.setU32((_o + 4), strlit_0_I11614695157650328859_sysvq0asl);
    return _o;
  })());
  writeErr_1_sysvq0asl(BigInt(i_69));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869488382);
    mem.setU32((_o + 4), strlit_0_I16845119709590674135_sysvq0asl);
    return _o;
  })());
  writeErr_1_sysvq0asl(BigInt(a_84));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 3026434);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  writeErr_1_sysvq0asl(BigInt(b_39));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function eQwasmovedQ_ArefSX45xception0sysvq0asl_0_sysvq0asl(dest_0) {
  mem.setU32(dest_0, 0);
}

let X60QiniGuard_0_sysvq0asl = allocFixed(1);

function X60Qini_0_sysvq0asl() {
  if (mem.u8At(X60QiniGuard_0_sysvq0asl)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_sysvq0asl, true);
  eQwasmovedQ_ArefSX45xception0sysvq0asl_0_sysvq0asl(exc_0_sysvq0asl);
}
// generated by lengc (js backend) from syn1lfpjv.c.nif

let X60QiniGuard_0_syn1lfpjv = allocFixed(1);

function X60Qini_0_syn1lfpjv() {
  if (mem.u8At(X60QiniGuard_0_syn1lfpjv)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_syn1lfpjv, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_for2ybv4p1();
}
// generated by lengc (js backend) from texdasn3y.c.nif

function lineStarts_0_texdasn3y(src_0) {
  forStmtLabel_0: {
    var result_0 = allocFixed(8);
    eQwasMoved_1_Ix88qzs1_fixeak1im1(result_0);
    eQdestroy_1_Iv9ij5i1_fixeak1im1(result_0);
    var X60Qx_8 = allocFixed(8);
    mem.copy(X60Qx_8, atQ_0_Iy7v4si1_texdasn3y((() => {
      var _a = allocFixed(4);
      mem.setI32(_a, 0);
      return _a;
    })()), 8);
    mem.copy(result_0, X60Qx_8, 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = 0;
        var X60Qlf_1 = len_4_sysvq0asl(src_0);
        var X60Qlf_2 = allocFixed(4);
        mem.setI32(X60Qlf_2, X60Qlf_0);
        {
          while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
            {
              var X60Qx_9 = getQ_9_sysvq0asl(src_0, mem.i32(X60Qlf_2));
              if ((X60Qx_9 === 10)) {
                add_0_I8kd4i4_texdasn3y(result_0, ((mem.i32(X60Qlf_2) + 1) | 0));
              }
            }
            inc_1_I6wjjge_exp6svnmi1(X60Qlf_2);
          }
        }
      }
    }
  }
  return result_0;
}

function lineColToOffset_0_texdasn3y(src_1, starts_0, line_0, col_0) {
  let result_1;
  if ((line_0 < 1)) {
    return 0;
  }
  if ((mem.i32(starts_0) <= ((line_0 - 1) | 0))) {
    let X60Qx_10 = len_4_sysvq0asl(src_1);
    result_1 = X60Qx_10;
    return result_1;
  }
  let X60Qx_11 = getQ_7_Ir8kccm_fixeak1im1(starts_0, ((line_0 - 1) | 0));
  let off_0 = ((mem.i32(X60Qx_11) + col_0) | 0);
  if ((off_0 < 0)) {
    off_0 = 0;
  }
  let X60Qx_12 = len_4_sysvq0asl(src_1);
  if ((X60Qx_12 < off_0)) {
    let X60Qx_13 = len_4_sysvq0asl(src_1);
    off_0 = X60Qx_13;
  }
  result_1 = off_0;
  return result_1;
}

function lineEndOffset_0_texdasn3y(src_2, starts_1, line_1) {
  whileStmtLabel_0: {
    var result_2;
    var X60Qx_14;
    if ((line_1 < 1)) {
      X60Qx_14 = true;
    } else {
      X60Qx_14 = (mem.i32(starts_1) <= ((line_1 - 1) | 0));
    }
    if (X60Qx_14) {
      var X60Qx_15 = len_4_sysvq0asl(src_2);
      result_2 = X60Qx_15;
      return result_2;
    }
    var X60Qx_16 = getQ_7_Ir8kccm_fixeak1im1(starts_1, ((line_1 - 1) | 0));
    var i_2 = allocFixed(4);
    mem.setI32(i_2, mem.i32(X60Qx_16));
    {
      while (true) {
        var X60Qx_17;
        var X60Qx_18 = len_4_sysvq0asl(src_2);
        if ((mem.i32(i_2) < X60Qx_18)) {
          var X60Qx_19 = getQ_9_sysvq0asl(src_2, mem.i32(i_2));
          X60Qx_17 = (!(X60Qx_19 === 10));
        } else {
          X60Qx_17 = false;
        }
        if (X60Qx_17) {
          inc_1_I6wjjge_exp6svnmi1(i_2);
        } else {
          break;
        }
      }
    }
  }
  result_2 = mem.i32(i_2);
  return result_2;
}

function lineContentEndOffset_0_texdasn3y(src_3, starts_2, line_2) {
  whileStmtLabel_0: {
    var result_3;
    var e_2 = allocFixed(4);
    mem.setI32(e_2, lineEndOffset_0_texdasn3y(src_3, starts_2, line_2));
    {
      while (true) {
        var X60Qx_20;
        if ((0 < mem.i32(e_2))) {
          var X60Qx_21;
          var X60Qx_22;
          var X60Qx_23 = getQ_9_sysvq0asl(src_3, ((mem.i32(e_2) - 1) | 0));
          if ((X60Qx_23 === 32)) {
            X60Qx_22 = true;
          } else {
            var X60Qx_24 = getQ_9_sysvq0asl(src_3, ((mem.i32(e_2) - 1) | 0));
            X60Qx_22 = (X60Qx_24 === 9);
          }
          if (X60Qx_22) {
            X60Qx_21 = true;
          } else {
            var X60Qx_25 = getQ_9_sysvq0asl(src_3, ((mem.i32(e_2) - 1) | 0));
            X60Qx_21 = (X60Qx_25 === 13);
          }
          X60Qx_20 = X60Qx_21;
        } else {
          X60Qx_20 = false;
        }
        if (X60Qx_20) {
          dec_1_I0nzoz91_fixeak1im1(e_2);
        } else {
          break;
        }
      }
    }
  }
  result_3 = mem.i32(e_2);
  return result_3;
}

function atQ_0_Iy7v4si1_texdasn3y(a_8) {
  var result_9 = allocFixed(8);
  var X60Qx_127 = allocFixed(8);
  mem.copy(X60Qx_127, newSeqUninit_0_Iggfvwp_fixeak1im1((((0 | 0) + 1) | 0)), 8);
  mem.copy(result_9, X60Qx_127, 8);
  if ((!(mem.u32((result_9 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_16 = allocFixed(4);
      mem.setI32(i_16, 0);
      {
        while ((mem.i32(i_16) < mem.i32(result_9))) {
          var X60Qx_128 = nimIcheckB(mem.i32(i_16), 0);
          mem.setI32((mem.u32((result_9 + 4)) + (mem.i32(i_16) * 4)), mem.i32((a_8 + (X60Qx_128 * 4))));
          inc_1_I6wjjge_exp6svnmi1(i_16);
        }
      }
    }
  }
  return result_9;
}

function add_0_I8kd4i4_texdasn3y(s_16, elem_5) {
  let L_0 = mem.i32(s_16);
  let X60Qx_129 = capInBytes_0_Iet286n_fixeak1im1(s_16);
  if ((X60Qx_129 < ((Math.imul(L_0, 4) + 4) | 0))) {
    let X60Qx_130 = resize_0_I8l4tya_texdasn3y(s_16, 1);
    if ((!X60Qx_130)) {
      return;
    }
  }
  inc_1_I6wjjge_exp6svnmi1(s_16);
  mem.setI32((mem.u32((s_16 + 4)) + (L_0 * 4)), elem_5);
}

function len_3_I0v1j8d_texdasn3y(s_18) {
  let result_10;
  result_10 = mem.i32(s_18);
  return result_10;
}

function len_3_Ixq6taz_texdasn3y(s_23) {
  let result_15;
  result_15 = mem.i32(s_23);
  return result_15;
}

function getQ_7_Ir6d0tw_texdasn3y(s_26, i_22) {
  let X60Qx_140;
  if ((i_22 < mem.i32(s_26))) {
    X60Qx_140 = (0 <= i_22);
  } else {
    X60Qx_140 = false;
  }
  if ((!X60Qx_140)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_exp6svnmi1);
      return _o;
    })());
  }
  let result_17;
  result_17 = (mem.u32((s_26 + 4)) + (i_22 * 8));
  return result_17;
}

function resize_0_I8l4tya_texdasn3y(dest_4, addedElements_4) {
  let result_25;
  let X60Qx_153 = capInBytes_0_Iet286n_fixeak1im1(dest_4);
  let oldCap_0 = Math.trunc((X60Qx_153 / 4));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_4);
  let memSize_4 = memSizeInBytes_0_Inv7kg3_fixeak1im1(newCap_0);
  let X60Qx_154 = realloc_1_sysvq0asl(mem.u32((dest_4 + 4)), memSize_4);
  mem.setU32((dest_4 + 4), X60Qx_154);
  if ((mem.u32((dest_4 + 4)) === 0)) {
    mem.setI32(dest_4, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_4);
    result_25 = false;
  } else {
    result_25 = true;
  }
  return result_25;
}

function eQdestroyQ_SX54extX45dit0texdasn3y_0_texdasn3y(dest_0) {
  nimStrDestroy((dest_0 + 16));
  nimStrDestroy((dest_0 + 8));
}

function eQwasmovedQ_SX54extX45dit0texdasn3y_0_texdasn3y(dest_0) {
  nimStrWasMoved((dest_0 + 8));
  nimStrWasMoved((dest_0 + 16));
}

function eQdupQ_SX54extX45dit0texdasn3y_0_texdasn3y(src_0) {
  let dest_0 = allocFixed(24);
  mem.setI32(dest_0, mem.i32(src_0));
  mem.setI32((dest_0 + 4), mem.i32((src_0 + 4)));
  let X60Qx_202 = allocFixed(8);
  mem.copy(X60Qx_202, nimStrDup((src_0 + 8)), 8);
  mem.copy((dest_0 + 8), X60Qx_202, 8);
  let X60Qx_203 = allocFixed(8);
  mem.copy(X60Qx_203, nimStrDup((src_0 + 16)), 8);
  mem.copy((dest_0 + 16), X60Qx_203, 8);
  return dest_0;
}

let X60QiniGuard_0_texdasn3y = allocFixed(1);

function X60Qini_0_texdasn3y() {
  if (mem.u8At(X60QiniGuard_0_texdasn3y)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_texdasn3y, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
}
