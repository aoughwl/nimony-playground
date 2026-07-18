"use strict";
var fopen = (typeof fopen !== "undefined") ? fopen : function(){ return 0; };
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


let strlit_0_I17671059047294035794_urim2dvcg1 = allocFixed(19);

let strlit_0_I14694606176902936784_jsfc0lwq21 = allocFixed(104);

let strlit_0_I1077588883665121262_pro4b75yb = allocFixed(20);

let strlit_0_I7469619828552402095_pro4b75yb = allocFixed(25);

let strlit_0_I2008506855214018045_pro4b75yb = allocFixed(21);

let strlit_0_I11321406078676887417_pro4b75yb = allocFixed(19);

let strlit_0_I12070759092612100815_pro4b75yb = allocFixed(19);

let strlit_0_I3311192284723978258_pro4b75yb = allocFixed(21);

let strlit_0_I1189048991431722821_pro4b75yb = allocFixed(21);

let strlit_0_I4223485871286820833_pro4b75yb = allocFixed(24);

let strlit_0_I6105018409752412263_jsovezijp1 = allocFixed(28);

let strlit_0_I4645790987703279553_jsovezijp1 = allocFixed(16);

let strlit_0_I14532204288076119502_jsovezijp1 = allocFixed(98);

let strlit_0_I15750996627617194403_jsovezijp1 = allocFixed(31);

let strlit_0_I16664880105326712979_webzywwor1 = allocFixed(22);

let strlit_0_I1643616165736515820_webzywwor1 = allocFixed(16);

let strlit_0_I407209193152762291_webzywwor1 = allocFixed(16);

let strlit_0_I18311672068392283896_webzywwor1 = allocFixed(16);

let strlit_0_I4541348101218926504_webzywwor1 = allocFixed(16);

let strlit_0_I11599078958678393897_webzywwor1 = allocFixed(18);

let strlit_0_I17555607389722195064_webzywwor1 = allocFixed(18);

let strlit_0_I5316556160589403975_webzywwor1 = allocFixed(16);

let strlit_0_I9991102891510134496_webzywwor1 = allocFixed(16);

let strlit_0_I6517805684605582485_webzywwor1 = allocFixed(18);

let strlit_0_I6864681898360807206_webzywwor1 = allocFixed(21);

let strlit_0_I3777428167486794959_webzywwor1 = allocFixed(17);

let strlit_0_I17987658270787974407_webzywwor1 = allocFixed(20);

let strlit_0_I9071657656589967445_webzywwor1 = allocFixed(20);

let strlit_0_I13413619771642637377_webzywwor1 = allocFixed(16);

let strlit_0_I12999086881046019782_webzywwor1 = allocFixed(17);

let strlit_0_I5723805845286553140_webzywwor1 = allocFixed(16);

let strlit_0_I1281801651151844468_webzywwor1 = allocFixed(16);

let strlit_0_I4040027577734042557_webzywwor1 = allocFixed(20);

let strlit_0_I6357233917619117690_webzywwor1 = allocFixed(20);

let strlit_0_I8882604075618536539_webzywwor1 = allocFixed(30);

let strlit_0_I973692718279674627_webzywwor1 = allocFixed(18);

let strlit_0_I10462096440466995513_webzywwor1 = allocFixed(16);

let strlit_0_I2416437014800228590_webzywwor1 = allocFixed(18);

let strlit_0_I9792473688321036479_webzywwor1 = allocFixed(17);

let strlit_0_I15316867318741875364_webzywwor1 = allocFixed(21);

let strlit_0_I15034346453199474510_webzywwor1 = allocFixed(22);

let strlit_0_I15550449855501200948_webzywwor1 = allocFixed(43);

let strlit_0_I760353633621926664_webzywwor1 = allocFixed(17);

let strlit_0_I3435182806541496947_webzywwor1 = allocFixed(19);

let strlit_0_I9917056758390513862_webzywwor1 = allocFixed(16);

let strlit_0_I4703750582038422824_webzywwor1 = allocFixed(17);

let strlit_0_I10048894405599300180_webzywwor1 = allocFixed(16);

let strlit_0_I10214127303718134010_webzywwor1 = allocFixed(20);

let strlit_0_I6506901919141277424_webzywwor1 = allocFixed(20);

let strlit_0_I13499277119623524076_webzywwor1 = allocFixed(41);

let strlit_0_I15476970270088161742_webzywwor1 = allocFixed(17);

let strlit_0_I11225201594490725231_webzywwor1 = allocFixed(18);

let strlit_0_I1659971858173592857_webzywwor1 = allocFixed(16);

let strlit_0_I3366673755822186275_webzywwor1 = allocFixed(19);

let strlit_0_I2639620712813615915_webzywwor1 = allocFixed(16);

let strlit_0_I9921765204933000296_webzywwor1 = allocFixed(51);

let strlit_0_I484636834144799291_webzywwor1 = allocFixed(22);

let strlit_0_I15596293004384550361_webzywwor1 = allocFixed(19);

let strlit_0_I17114304651798930877_webzywwor1 = allocFixed(20);

let strlit_0_I8650502675586490208_webzywwor1 = allocFixed(20);

let strlit_0_I10565791122227693825_webzywwor1 = allocFixed(20);

let strlit_0_I13597173998288957670_webzywwor1 = allocFixed(35);

let strlit_0_I4207864124720532554_webzywwor1 = allocFixed(19);

let strlit_0_I10436777097720170411_webzywwor1 = allocFixed(19);

let strlit_0_I2961009535513786441_webzywwor1 = allocFixed(22);

let strlit_0_I18034278047881734788_webzywwor1 = allocFixed(22);

let strlit_0_I2610569064113355705_webzywwor1 = allocFixed(22);

let strlit_0_I15244226513049159307_webzywwor1 = allocFixed(20);

let strlit_0_I16681520760414789874_webzywwor1 = allocFixed(17);

let strlit_0_I6506369825410052670_webzywwor1 = allocFixed(23);

let strlit_0_I14605782373830734321_webzywwor1 = allocFixed(22);

let strlit_0_I1804109583649340092_webzywwor1 = allocFixed(22);

let strlit_0_I8177294062090954445_webzywwor1 = allocFixed(22);

let strlit_0_I5902630995655632564_webzywwor1 = allocFixed(23);

let strlit_0_I135188311513184041_webzywwor1 = allocFixed(22);

let strlit_0_I5438928059933331131_webzywwor1 = allocFixed(29);

let strlit_0_I2607068176955078832_webzywwor1 = allocFixed(98);

let strlit_0_I14131790745264837101_sysvq0asl = allocFixed(102);

let strlit_0_I11927585966806674622_sysvq0asl = allocFixed(102);

let strlit_0_I15539159382304113184_sysvq0asl = allocFixed(39);

let strlit_0_I14281474217946372742_sysvq0asl = allocFixed(47);

let strlit_0_I16690852185662743073_sysvq0asl = allocFixed(28);

let strlit_0_I10604297744791418982_sysvq0asl = allocFixed(30);

let strlit_0_I7901555537561129428_sysvq0asl = allocFixed(28);

let strlit_0_I11614695157650328859_sysvq0asl = allocFixed(33);

let strlit_0_I16845119709590674135_sysvq0asl = allocFixed(19);

let NegTen_0_sysvq0asl = allocFixed(80);

let fsLookupTable_0_sysvq0asl = allocFixed(256);

mem.setI32(strlit_0_I17671059047294035794_urim2dvcg1, 7);

mem.setI32((strlit_0_I17671059047294035794_urim2dvcg1 + 4), 0);

mem.setI32((strlit_0_I17671059047294035794_urim2dvcg1 + 8), 0);

mem.writeStr((strlit_0_I17671059047294035794_urim2dvcg1 + 12), "file://");

mem.setI32(strlit_0_I14694606176902936784_jsfc0lwq21, 92);

mem.setI32((strlit_0_I14694606176902936784_jsfc0lwq21 + 4), 0);

mem.setI32((strlit_0_I14694606176902936784_jsfc0lwq21 + 8), 0);

mem.writeStr((strlit_0_I14694606176902936784_jsfc0lwq21 + 12), "../nimony/lib/std/system/openarrays.nim(10, 49): 0 <= idx and idx < x.len [AssertionDefect]\n");

mem.setI32(strlit_0_I1077588883665121262_pro4b75yb, 8);

mem.setI32((strlit_0_I1077588883665121262_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I1077588883665121262_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I1077588883665121262_pro4b75yb + 12), "{\"line\":");

mem.setI32(strlit_0_I7469619828552402095_pro4b75yb, 13);

mem.setI32((strlit_0_I7469619828552402095_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I7469619828552402095_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I7469619828552402095_pro4b75yb + 12), ",\"character\":");

mem.setI32(strlit_0_I2008506855214018045_pro4b75yb, 9);

mem.setI32((strlit_0_I2008506855214018045_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I2008506855214018045_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I2008506855214018045_pro4b75yb + 12), "{\"start\":");

mem.setI32(strlit_0_I11321406078676887417_pro4b75yb, 7);

mem.setI32((strlit_0_I11321406078676887417_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I11321406078676887417_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I11321406078676887417_pro4b75yb + 12), ",\"end\":");

mem.setI32(strlit_0_I12070759092612100815_pro4b75yb, 7);

mem.setI32((strlit_0_I12070759092612100815_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I12070759092612100815_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I12070759092612100815_pro4b75yb + 12), "{\"uri\":");

mem.setI32(strlit_0_I3311192284723978258_pro4b75yb, 9);

mem.setI32((strlit_0_I3311192284723978258_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I3311192284723978258_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I3311192284723978258_pro4b75yb + 12), ",\"range\":");

mem.setI32(strlit_0_I1189048991431722821_pro4b75yb, 9);

mem.setI32((strlit_0_I1189048991431722821_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I1189048991431722821_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I1189048991431722821_pro4b75yb + 12), "{\"range\":");

mem.setI32(strlit_0_I4223485871286820833_pro4b75yb, 12);

mem.setI32((strlit_0_I4223485871286820833_pro4b75yb + 4), 0);

mem.setI32((strlit_0_I4223485871286820833_pro4b75yb + 8), 0);

mem.writeStr((strlit_0_I4223485871286820833_pro4b75yb + 12), ",\"severity\":");

mem.setI32(strlit_0_I6105018409752412263_jsovezijp1, 16);

mem.setI32((strlit_0_I6105018409752412263_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I6105018409752412263_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I6105018409752412263_jsovezijp1 + 12), "0123456789abcdef");

mem.setI32(strlit_0_I4645790987703279553_jsovezijp1, 4);

mem.setI32((strlit_0_I4645790987703279553_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I4645790987703279553_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I4645790987703279553_jsovezijp1 + 12), "\\u00");

mem.setI32(strlit_0_I14532204288076119502_jsovezijp1, 86);

mem.setI32((strlit_0_I14532204288076119502_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I14532204288076119502_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I14532204288076119502_jsovezijp1 + 12), "../nimony/lib/std/system/seqimpl.nim(167, 41): i < s.len and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I15750996627617194403_jsovezijp1, 19);

mem.setI32((strlit_0_I15750996627617194403_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I15750996627617194403_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I15750996627617194403_jsovezijp1 + 12), "leave uninitialized");

mem.setI32(strlit_0_I16664880105326712979_webzywwor1, 10);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16664880105326712979_webzywwor1 + 12), "globalThis");

mem.setI32(strlit_0_I1643616165736515820_webzywwor1, 4);

mem.setI32((strlit_0_I1643616165736515820_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1643616165736515820_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1643616165736515820_webzywwor1 + 12), "line");

mem.setI32(strlit_0_I407209193152762291_webzywwor1, 4);

mem.setI32((strlit_0_I407209193152762291_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I407209193152762291_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I407209193152762291_webzywwor1 + 12), "name");

mem.setI32(strlit_0_I18311672068392283896_webzywwor1, 4);

mem.setI32((strlit_0_I18311672068392283896_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I18311672068392283896_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I18311672068392283896_webzywwor1 + 12), "kind");

mem.setI32(strlit_0_I4541348101218926504_webzywwor1, 4);

mem.setI32((strlit_0_I4541348101218926504_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4541348101218926504_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4541348101218926504_webzywwor1 + 12), "file");

mem.setI32(strlit_0_I11599078958678393897_webzywwor1, 6);

mem.setI32((strlit_0_I11599078958678393897_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11599078958678393897_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11599078958678393897_webzywwor1 + 12), "caller");

mem.setI32(strlit_0_I17555607389722195064_webzywwor1, 6);

mem.setI32((strlit_0_I17555607389722195064_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I17555607389722195064_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I17555607389722195064_webzywwor1 + 12), "callee");

mem.setI32(strlit_0_I5316556160589403975_webzywwor1, 4);

mem.setI32((strlit_0_I5316556160589403975_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5316556160589403975_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5316556160589403975_webzywwor1 + 12), "proc");

mem.setI32(strlit_0_I9991102891510134496_webzywwor1, 4);

mem.setI32((strlit_0_I9991102891510134496_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9991102891510134496_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9991102891510134496_webzywwor1 + 12), "func");

mem.setI32(strlit_0_I6517805684605582485_webzywwor1, 6);

mem.setI32((strlit_0_I6517805684605582485_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6517805684605582485_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6517805684605582485_webzywwor1 + 12), "method");

mem.setI32(strlit_0_I6864681898360807206_webzywwor1, 9);

mem.setI32((strlit_0_I6864681898360807206_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6864681898360807206_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6864681898360807206_webzywwor1 + 12), "converter");

mem.setI32(strlit_0_I3777428167486794959_webzywwor1, 5);

mem.setI32((strlit_0_I3777428167486794959_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I3777428167486794959_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I3777428167486794959_webzywwor1 + 12), "macro");

mem.setI32(strlit_0_I17987658270787974407_webzywwor1, 8);

mem.setI32((strlit_0_I17987658270787974407_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I17987658270787974407_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I17987658270787974407_webzywwor1 + 12), "template");

mem.setI32(strlit_0_I9071657656589967445_webzywwor1, 8);

mem.setI32((strlit_0_I9071657656589967445_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9071657656589967445_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9071657656589967445_webzywwor1 + 12), "iterator");

mem.setI32(strlit_0_I13413619771642637377_webzywwor1, 4);

mem.setI32((strlit_0_I13413619771642637377_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I13413619771642637377_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I13413619771642637377_webzywwor1 + 12), "type");

mem.setI32(strlit_0_I12999086881046019782_webzywwor1, 5);

mem.setI32((strlit_0_I12999086881046019782_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I12999086881046019782_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I12999086881046019782_webzywwor1 + 12), "const");

mem.setI32(strlit_0_I5723805845286553140_webzywwor1, 4);

mem.setI32((strlit_0_I5723805845286553140_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5723805845286553140_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5723805845286553140_webzywwor1 + 12), "glet");

mem.setI32(strlit_0_I1281801651151844468_webzywwor1, 4);

mem.setI32((strlit_0_I1281801651151844468_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1281801651151844468_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1281801651151844468_webzywwor1 + 12), "gvar");

mem.setI32(strlit_0_I4040027577734042557_webzywwor1, 8);

mem.setI32((strlit_0_I4040027577734042557_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4040027577734042557_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4040027577734042557_webzywwor1 + 12), "{\"name\":");

mem.setI32(strlit_0_I6357233917619117690_webzywwor1, 8);

mem.setI32((strlit_0_I6357233917619117690_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6357233917619117690_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6357233917619117690_webzywwor1 + 12), ",\"kind\":");

mem.setI32(strlit_0_I8882604075618536539_webzywwor1, 18);

mem.setI32((strlit_0_I8882604075618536539_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I8882604075618536539_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I8882604075618536539_webzywwor1 + 12), ",\"selectionRange\":");

mem.setI32(strlit_0_I973692718279674627_webzywwor1, 6);

mem.setI32((strlit_0_I973692718279674627_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I973692718279674627_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I973692718279674627_webzywwor1 + 12), "object");

mem.setI32(strlit_0_I10462096440466995513_webzywwor1, 4);

mem.setI32((strlit_0_I10462096440466995513_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10462096440466995513_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10462096440466995513_webzywwor1 + 12), "enum");

mem.setI32(strlit_0_I2416437014800228590_webzywwor1, 6);

mem.setI32((strlit_0_I2416437014800228590_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I2416437014800228590_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I2416437014800228590_webzywwor1 + 12), "result");

mem.setI32(strlit_0_I9792473688321036479_webzywwor1, 5);

mem.setI32((strlit_0_I9792473688321036479_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9792473688321036479_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9792473688321036479_webzywwor1 + 12), "param");

mem.setI32(strlit_0_I15316867318741875364_webzywwor1, 9);

mem.setI32((strlit_0_I15316867318741875364_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15316867318741875364_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15316867318741875364_webzywwor1 + 12), "{\"label\":");

mem.setI32(strlit_0_I15034346453199474510_webzywwor1, 10);

mem.setI32((strlit_0_I15034346453199474510_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15034346453199474510_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15034346453199474510_webzywwor1 + 12), ",\"detail\":");

mem.setI32(strlit_0_I15550449855501200948_webzywwor1, 31);

mem.setI32((strlit_0_I15550449855501200948_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15550449855501200948_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15550449855501200948_webzywwor1 + 12), "{\"isIncomplete\":false,\"items\":[");

mem.setI32(strlit_0_I760353633621926664_webzywwor1, 5);

mem.setI32((strlit_0_I760353633621926664_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I760353633621926664_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I760353633621926664_webzywwor1 + 12), "Error");

mem.setI32(strlit_0_I3435182806541496947_webzywwor1, 7);

mem.setI32((strlit_0_I3435182806541496947_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I3435182806541496947_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I3435182806541496947_webzywwor1 + 12), "Warning");

mem.setI32(strlit_0_I9917056758390513862_webzywwor1, 4);

mem.setI32((strlit_0_I9917056758390513862_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9917056758390513862_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9917056758390513862_webzywwor1 + 12), "Hint");

mem.setI32(strlit_0_I4703750582038422824_webzywwor1, 5);

mem.setI32((strlit_0_I4703750582038422824_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4703750582038422824_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4703750582038422824_webzywwor1 + 12), "Trace");

mem.setI32(strlit_0_I10048894405599300180_webzywwor1, 4);

mem.setI32((strlit_0_I10048894405599300180_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10048894405599300180_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10048894405599300180_webzywwor1 + 12), "Info");

mem.setI32(strlit_0_I10214127303718134010_webzywwor1, 8);

mem.setI32((strlit_0_I10214127303718134010_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10214127303718134010_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10214127303718134010_webzywwor1 + 12), "FAILURE:");

mem.setI32(strlit_0_I6506901919141277424_webzywwor1, 8);

mem.setI32((strlit_0_I6506901919141277424_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6506901919141277424_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6506901919141277424_webzywwor1 + 12), "SUCCESS:");

mem.setI32(strlit_0_I13499277119623524076_webzywwor1, 29);

mem.setI32((strlit_0_I13499277119623524076_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I13499277119623524076_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I13499277119623524076_webzywwor1 + 12), ",\"source\":\"nimony\",\"message\":");

mem.setI32(strlit_0_I15476970270088161742_webzywwor1, 5);

mem.setI32((strlit_0_I15476970270088161742_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15476970270088161742_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15476970270088161742_webzywwor1 + 12), "nodes");

mem.setI32(strlit_0_I11225201594490725231_webzywwor1, 6);

mem.setI32((strlit_0_I11225201594490725231_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11225201594490725231_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11225201594490725231_webzywwor1 + 12), "render");

mem.setI32(strlit_0_I1659971858173592857_webzywwor1, 4);

mem.setI32((strlit_0_I1659971858173592857_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1659971858173592857_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1659971858173592857_webzywwor1 + 12), "null");

mem.setI32(strlit_0_I3366673755822186275_webzywwor1, 7);

mem.setI32((strlit_0_I3366673755822186275_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I3366673755822186275_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I3366673755822186275_webzywwor1 + 12), "```nim\n");

mem.setI32(strlit_0_I2639620712813615915_webzywwor1, 4);

mem.setI32((strlit_0_I2639620712813615915_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I2639620712813615915_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I2639620712813615915_webzywwor1 + 12), "\n```");

mem.setI32(strlit_0_I9921765204933000296_webzywwor1, 39);

mem.setI32((strlit_0_I9921765204933000296_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9921765204933000296_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9921765204933000296_webzywwor1 + 12), "{\"contents\":{\"kind\":\"markdown\",\"value\":");

mem.setI32(strlit_0_I484636834144799291_webzywwor1, 10);

mem.setI32((strlit_0_I484636834144799291_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I484636834144799291_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I484636834144799291_webzywwor1 + 12), "},\"range\":");

mem.setI32(strlit_0_I15596293004384550361_webzywwor1, 7);

mem.setI32((strlit_0_I15596293004384550361_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15596293004384550361_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15596293004384550361_webzywwor1 + 12), "exports");

mem.setI32(strlit_0_I17114304651798930877_webzywwor1, 8);

mem.setI32((strlit_0_I17114304651798930877_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I17114304651798930877_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I17114304651798930877_webzywwor1 + 12), "__ls_req");

mem.setI32(strlit_0_I8650502675586490208_webzywwor1, 8);

mem.setI32((strlit_0_I8650502675586490208_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I8650502675586490208_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I8650502675586490208_webzywwor1 + 12), "__ls_res");

mem.setI32(strlit_0_I10565791122227693825_webzywwor1, 8);

mem.setI32((strlit_0_I10565791122227693825_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10565791122227693825_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10565791122227693825_webzywwor1 + 12), "__ls_err");

mem.setI32(strlit_0_I13597173998288957670_webzywwor1, 23);

mem.setI32((strlit_0_I13597173998288957670_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I13597173998288957670_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I13597173998288957670_webzywwor1 + 12), "bad or missing __ls_req");

mem.setI32(strlit_0_I4207864124720532554_webzywwor1, 7);

mem.setI32((strlit_0_I4207864124720532554_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4207864124720532554_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4207864124720532554_webzywwor1 + 12), "feature");

mem.setI32(strlit_0_I10436777097720170411_webzywwor1, 7);

mem.setI32((strlit_0_I10436777097720170411_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10436777097720170411_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10436777097720170411_webzywwor1 + 12), "symbols");

mem.setI32(strlit_0_I2961009535513786441_webzywwor1, 10);

mem.setI32((strlit_0_I2961009535513786441_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I2961009535513786441_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I2961009535513786441_webzywwor1 + 12), "__ls_decls");

mem.setI32(strlit_0_I18034278047881734788_webzywwor1, 10);

mem.setI32((strlit_0_I18034278047881734788_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I18034278047881734788_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I18034278047881734788_webzywwor1 + 12), "completion");

mem.setI32(strlit_0_I2610569064113355705_webzywwor1, 10);

mem.setI32((strlit_0_I2610569064113355705_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I2610569064113355705_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I2610569064113355705_webzywwor1 + 12), "__ls_index");

mem.setI32(strlit_0_I15244226513049159307_webzywwor1, 8);

mem.setI32((strlit_0_I15244226513049159307_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15244226513049159307_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15244226513049159307_webzywwor1 + 12), "__ls_src");

mem.setI32(strlit_0_I16681520760414789874_webzywwor1, 5);

mem.setI32((strlit_0_I16681520760414789874_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16681520760414789874_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16681520760414789874_webzywwor1 + 12), "hover");

mem.setI32(strlit_0_I6506369825410052670_webzywwor1, 11);

mem.setI32((strlit_0_I6506369825410052670_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6506369825410052670_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6506369825410052670_webzywwor1 + 12), "__ls_render");

mem.setI32(strlit_0_I14605782373830734321_webzywwor1, 10);

mem.setI32((strlit_0_I14605782373830734321_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I14605782373830734321_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I14605782373830734321_webzywwor1 + 12), "definition");

mem.setI32(strlit_0_I1804109583649340092_webzywwor1, 10);

mem.setI32((strlit_0_I1804109583649340092_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1804109583649340092_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1804109583649340092_webzywwor1 + 12), "__ls_calls");

mem.setI32(strlit_0_I8177294062090954445_webzywwor1, 10);

mem.setI32((strlit_0_I8177294062090954445_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I8177294062090954445_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I8177294062090954445_webzywwor1 + 12), "references");

mem.setI32(strlit_0_I5902630995655632564_webzywwor1, 11);

mem.setI32((strlit_0_I5902630995655632564_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5902630995655632564_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5902630995655632564_webzywwor1 + 12), "diagnostics");

mem.setI32(strlit_0_I135188311513184041_webzywwor1, 10);

mem.setI32((strlit_0_I135188311513184041_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I135188311513184041_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I135188311513184041_webzywwor1 + 12), "__ls_check");

mem.setI32(strlit_0_I5438928059933331131_webzywwor1, 17);

mem.setI32((strlit_0_I5438928059933331131_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5438928059933331131_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5438928059933331131_webzywwor1 + 12), "unknown feature: ");

mem.setI32(strlit_0_I2607068176955078832_webzywwor1, 86);

mem.setI32((strlit_0_I2607068176955078832_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I2607068176955078832_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I2607068176955078832_webzywwor1 + 12), "../nimony/lib/std/system/seqimpl.nim(169, 53): i < s.len and 0 <= i [AssertionDefect]\n");

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

mem.setI32(strlit_0_I7901555537561129428_sysvq0asl, 16);

mem.setI32((strlit_0_I7901555537561129428_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I7901555537561129428_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I7901555537561129428_sysvq0asl + 12), "0123456789ABCDEF");

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
// generated by lengc (js backend) from urim2dvcg1.c.nif

function percentEncodePath_0_urim2dvcg1(s_1) {
  forStmtLabel_0: {
    var result_3 = allocFixed(8);
    nimStrWasMoved(result_3);
    var hexd_0 = allocFixed(8);
    mem.setU32(hexd_0, 842084606);
    mem.setU32((hexd_0 + 4), strlit_0_I7901555537561129428_sysvq0asl);
    nimStrDestroy(result_3);
    mem.copy(result_3, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = 0;
        var X60Qlf_1 = len_4_sysvq0asl(s_1);
        var X60Qlf_2 = allocFixed(4);
        mem.setI32(X60Qlf_2, X60Qlf_0);
        {
          while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
            {
              var X60Qii_2 = getQ_9_sysvq0asl(s_1, mem.i32(X60Qlf_2));
              var X60Qx_18;
              var X60Qx_19;
              var X60Qx_20;
              var X60Qx_21;
              var X60Qx_22;
              var X60Qx_23;
              var X60Qx_24;
              var X60Qx_25;
              if ((97 <= X60Qii_2)) {
                X60Qx_25 = (X60Qii_2 <= 122);
              } else {
                X60Qx_25 = false;
              }
              if (X60Qx_25) {
                X60Qx_24 = true;
              } else {
                var X60Qx_26;
                if ((65 <= X60Qii_2)) {
                  X60Qx_26 = (X60Qii_2 <= 90);
                } else {
                  X60Qx_26 = false;
                }
                X60Qx_24 = X60Qx_26;
              }
              if (X60Qx_24) {
                X60Qx_23 = true;
              } else {
                var X60Qx_27;
                if ((48 <= X60Qii_2)) {
                  X60Qx_27 = (X60Qii_2 <= 57);
                } else {
                  X60Qx_27 = false;
                }
                X60Qx_23 = X60Qx_27;
              }
              if (X60Qx_23) {
                X60Qx_22 = true;
              } else {
                X60Qx_22 = (X60Qii_2 === 47);
              }
              if (X60Qx_22) {
                X60Qx_21 = true;
              } else {
                X60Qx_21 = (X60Qii_2 === 45);
              }
              if (X60Qx_21) {
                X60Qx_20 = true;
              } else {
                X60Qx_20 = (X60Qii_2 === 95);
              }
              if (X60Qx_20) {
                X60Qx_19 = true;
              } else {
                X60Qx_19 = (X60Qii_2 === 46);
              }
              if (X60Qx_19) {
                X60Qx_18 = true;
              } else {
                X60Qx_18 = (X60Qii_2 === 126);
              }
              if (X60Qx_18) {
                add_1_sysvq0asl(result_3, X60Qii_2);
              } else {
                add_1_sysvq0asl(result_3, 37);
                var X60Qx_28 = getQ_9_sysvq0asl((() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 842084606);
                  mem.setU32((_o + 4), strlit_0_I7901555537561129428_sysvq0asl);
                  return _o;
                })(), ((X60Qii_2 >> 4) & 15));
                add_1_sysvq0asl(result_3, X60Qx_28);
                var X60Qx_29 = getQ_9_sysvq0asl((() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 842084606);
                  mem.setU32((_o + 4), strlit_0_I7901555537561129428_sysvq0asl);
                  return _o;
                })(), (X60Qii_2 & 15));
                add_1_sysvq0asl(result_3, X60Qx_29);
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_2);
          }
        }
      }
    }
  }
  return result_3;
}

function pathToUri_0_urim2dvcg1(path_0) {
  let result_4 = allocFixed(8);
  nimStrWasMoved(result_4);
  let p_0 = allocFixed(8);
  mem.copy(p_0, nimStrDup(path_0), 8);
  let X60Qx_30;
  let X60Qx_31 = len_4_sysvq0asl(p_0);
  if ((X60Qx_31 === 0)) {
    X60Qx_30 = true;
  } else {
    let X60Qx_32 = getQ_9_sysvq0asl(p_0, 0);
    X60Qx_30 = (!(X60Qx_32 === 47));
  }
  if (X60Qx_30) {
    let X60Qlhs_2 = allocFixed(8);
    mem.copy(X60Qlhs_2, ampQ_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 12033);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), p_0), 8);
    nimStrDestroy(p_0);
    mem.copy(p_0, X60Qlhs_2, 8);
  }
  nimStrDestroy(result_4);
  let X60Qtmp_3 = allocFixed(8);
  mem.copy(X60Qtmp_3, percentEncodePath_0_urim2dvcg1(p_0), 8);
  let X60Qx_33 = allocFixed(8);
  mem.copy(X60Qx_33, ampQ_0_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818846974);
    mem.setU32((_o + 4), strlit_0_I17671059047294035794_urim2dvcg1);
    return _o;
  })(), X60Qtmp_3), 8);
  mem.copy(result_4, X60Qx_33, 8);
  nimStrDestroy(X60Qtmp_3);
  nimStrDestroy(p_0);
  return result_4;
  nimStrDestroy(X60Qtmp_3);
  nimStrDestroy(p_0);
  return result_4;
}

function plusQeQ_0_Iz7fdp7_urim2dvcg1(x_2, y_1) {
  mem.setI32(x_2, ((mem.i32(x_2) + y_1) | 0));
}

let X60QiniGuard_0_urim2dvcg1 = allocFixed(1);

function X60Qini_0_urim2dvcg1() {
  if (mem.u8At(X60QiniGuard_0_urim2dvcg1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_urim2dvcg1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from jsfc0lwq21.c.nif

function eQdestroy_0_jsfc0lwq21(x_2) {
  _jsRelease(mem.i32(x_2));
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

function set_0_jsfc0lwq21(obj_9, name_10, val_3) {
  let n_4 = allocFixed(4);
  mem.copy(n_4, toJs_3_jsfc0lwq21(name_10), 4);
  _jsSetProp(mem.i32(obj_9), mem.i32(n_4), mem.i32(val_3));
  eQdestroy_0_jsfc0lwq21(n_4);
}

function inc_1_I6wjjge_jsfc0lwq21(x_11) {
  mem.setI32(x_11, ((mem.i32(x_11) + 1) | 0));
}

let X60QiniGuard_0_jsfc0lwq21 = allocFixed(1);

function X60Qini_0_jsfc0lwq21() {
  if (mem.u8At(X60QiniGuard_0_jsfc0lwq21)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_jsfc0lwq21, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from pro4b75yb.c.nif

function pos_0_pro4b75yb(line_0, character_0) {
  let result_1 = allocFixed(8);
  mem.copy(result_1, (() => {
    let _o = allocFixed(8);
    mem.setI32(_o, line_0);
    mem.setI32((_o + 4), character_0);
    return _o;
  })(), 8);
  return result_1;
}

function mkRange_0_pro4b75yb(sl_0, sc_0, el_0, ec_0) {
  let result_2 = allocFixed(16);
  let X60Qx_2 = allocFixed(8);
  mem.copy(X60Qx_2, pos_0_pro4b75yb(sl_0, sc_0), 8);
  let X60Qx_3 = allocFixed(8);
  mem.copy(X60Qx_3, pos_0_pro4b75yb(el_0, ec_0), 8);
  mem.copy(result_2, (() => {
    let _o = allocFixed(16);
    mem.copy(_o, X60Qx_2, 8);
    mem.copy((_o + 8), X60Qx_3, 8);
    return _o;
  })(), 16);
  return result_2;
}

function posJson_0_pro4b75yb(p_0) {
  let result_3 = allocFixed(8);
  nimStrWasMoved(result_3);
  let X60Qdesugar_0 = allocFixed(8);
  mem.copy(X60Qdesugar_0, dollarQ_2_sysvq0asl(mem.i32(p_0)), 8);
  let X60Qdesugar_1 = allocFixed(8);
  mem.copy(X60Qdesugar_1, dollarQ_2_sysvq0asl(mem.i32((p_0 + 4))), 8);
  let X60Qx_4 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1814199294);
    mem.setU32((_o + 4), strlit_0_I1077588883665121262_pro4b75yb);
    return _o;
  })());
  let X60Qx_5 = len_4_sysvq0asl(X60Qdesugar_0);
  let X60Qx_6 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663184126);
    mem.setU32((_o + 4), strlit_0_I7469619828552402095_pro4b75yb);
    return _o;
  })());
  let X60Qx_7 = len_4_sysvq0asl(X60Qdesugar_1);
  let X60Qx_8 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_2 = allocFixed(8);
  mem.copy(X60Qdesugar_2, newStringOfCap_0_sysvq0asl(((((((((X60Qx_4 + X60Qx_5) | 0) + X60Qx_6) | 0) + X60Qx_7) | 0) + X60Qx_8) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_2, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1814199294);
    mem.setU32((_o + 4), strlit_0_I1077588883665121262_pro4b75yb);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_2, X60Qdesugar_0);
  add_2_sysvq0asl(X60Qdesugar_2, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663184126);
    mem.setU32((_o + 4), strlit_0_I7469619828552402095_pro4b75yb);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_2, X60Qdesugar_1);
  add_2_sysvq0asl(X60Qdesugar_2, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_3);
  mem.copy(result_3, X60Qdesugar_2, 8);
  nimStrWasMoved(X60Qdesugar_2);
  nimStrDestroy(X60Qdesugar_2);
  nimStrDestroy(X60Qdesugar_1);
  nimStrDestroy(X60Qdesugar_0);
  return result_3;
  nimStrDestroy(X60Qdesugar_2);
  nimStrDestroy(X60Qdesugar_1);
  nimStrDestroy(X60Qdesugar_0);
  return result_3;
}

function rangeJson_0_pro4b75yb(r_0) {
  let result_4 = allocFixed(8);
  nimStrWasMoved(result_4);
  let X60Qdesugar_3 = allocFixed(8);
  mem.copy(X60Qdesugar_3, posJson_0_pro4b75yb(r_0), 8);
  let X60Qdesugar_4 = allocFixed(8);
  mem.copy(X60Qdesugar_4, posJson_0_pro4b75yb((r_0 + 8)), 8);
  let X60Qx_9 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1931639806);
    mem.setU32((_o + 4), strlit_0_I2008506855214018045_pro4b75yb);
    return _o;
  })());
  let X60Qx_10 = len_4_sysvq0asl(X60Qdesugar_3);
  let X60Qx_11 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I11321406078676887417_pro4b75yb);
    return _o;
  })());
  let X60Qx_12 = len_4_sysvq0asl(X60Qdesugar_4);
  let X60Qx_13 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_5 = allocFixed(8);
  mem.copy(X60Qdesugar_5, newStringOfCap_0_sysvq0asl(((((((((X60Qx_9 + X60Qx_10) | 0) + X60Qx_11) | 0) + X60Qx_12) | 0) + X60Qx_13) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_5, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1931639806);
    mem.setU32((_o + 4), strlit_0_I2008506855214018045_pro4b75yb);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_5, X60Qdesugar_3);
  add_2_sysvq0asl(X60Qdesugar_5, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I11321406078676887417_pro4b75yb);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_5, X60Qdesugar_4);
  add_2_sysvq0asl(X60Qdesugar_5, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_4);
  mem.copy(result_4, X60Qdesugar_5, 8);
  nimStrWasMoved(X60Qdesugar_5);
  nimStrDestroy(X60Qdesugar_5);
  nimStrDestroy(X60Qdesugar_4);
  nimStrDestroy(X60Qdesugar_3);
  return result_4;
  nimStrDestroy(X60Qdesugar_5);
  nimStrDestroy(X60Qdesugar_4);
  nimStrDestroy(X60Qdesugar_3);
  return result_4;
}

function locationJson_0_pro4b75yb(l_0) {
  let result_5 = allocFixed(8);
  nimStrWasMoved(result_5);
  let X60Qdesugar_6 = allocFixed(8);
  mem.copy(X60Qdesugar_6, jStr_0_jsovezijp1(l_0), 8);
  let X60Qdesugar_7 = allocFixed(8);
  mem.copy(X60Qdesugar_7, rangeJson_0_pro4b75yb((l_0 + 8)), 8);
  let X60Qx_14 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1965194238);
    mem.setU32((_o + 4), strlit_0_I12070759092612100815_pro4b75yb);
    return _o;
  })());
  let X60Qx_15 = len_4_sysvq0asl(X60Qdesugar_6);
  let X60Qx_16 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1914842366);
    mem.setU32((_o + 4), strlit_0_I3311192284723978258_pro4b75yb);
    return _o;
  })());
  let X60Qx_17 = len_4_sysvq0asl(X60Qdesugar_7);
  let X60Qx_18 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_8 = allocFixed(8);
  mem.copy(X60Qdesugar_8, newStringOfCap_0_sysvq0asl(((((((((X60Qx_14 + X60Qx_15) | 0) + X60Qx_16) | 0) + X60Qx_17) | 0) + X60Qx_18) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_8, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1965194238);
    mem.setU32((_o + 4), strlit_0_I12070759092612100815_pro4b75yb);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_6);
  add_2_sysvq0asl(X60Qdesugar_8, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1914842366);
    mem.setU32((_o + 4), strlit_0_I3311192284723978258_pro4b75yb);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_7);
  add_2_sysvq0asl(X60Qdesugar_8, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_5);
  mem.copy(result_5, X60Qdesugar_8, 8);
  nimStrWasMoved(X60Qdesugar_8);
  nimStrDestroy(X60Qdesugar_8);
  nimStrDestroy(X60Qdesugar_7);
  nimStrDestroy(X60Qdesugar_6);
  return result_5;
  nimStrDestroy(X60Qdesugar_8);
  nimStrDestroy(X60Qdesugar_7);
  nimStrDestroy(X60Qdesugar_6);
  return result_5;
}

function eQdestroyQ_SX4cocation0pro4b75yb_0_pro4b75yb(dest_0) {
  nimStrDestroy(dest_0);
}

let X60QiniGuard_0_pro4b75yb = allocFixed(1);

function X60Qini_0_pro4b75yb() {
  if (mem.u8At(X60QiniGuard_0_pro4b75yb)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_pro4b75yb, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_jsovezijp1();
}
// generated by lengc (js backend) from jsovezijp1.c.nif

function jsonEscape_0_jsovezijp1(s_0) {
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
              var X60Qii_2 = getQ_9_sysvq0asl(s_0, mem.i32(X60Qlf_2));
              switch (X60Qii_2) {
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
                    if ((X60Qii_2 < 32)) {
                      var hexd_0 = allocFixed(8);
                      mem.setU32(hexd_0, 842084606);
                      mem.setU32((hexd_0 + 4), strlit_0_I6105018409752412263_jsovezijp1);
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 812997886);
                        mem.setU32((_o + 4), strlit_0_I4645790987703279553_jsovezijp1);
                        return _o;
                      })());
                      var X60Qx_2 = getQ_9_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 842084606);
                        mem.setU32((_o + 4), strlit_0_I6105018409752412263_jsovezijp1);
                        return _o;
                      })(), ((X60Qii_2 >> 4) & 15));
                      add_1_sysvq0asl(result_0, X60Qx_2);
                      var X60Qx_3 = getQ_9_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 842084606);
                        mem.setU32((_o + 4), strlit_0_I6105018409752412263_jsovezijp1);
                        return _o;
                      })(), (X60Qii_2 & 15));
                      add_1_sysvq0asl(result_0, X60Qx_3);
                    } else {
                      add_1_sysvq0asl(result_0, X60Qii_2);
                    }
                  }
                  break;
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_2);
          }
        }
      }
    }
  }
  return result_0;
}

function jStr_0_jsovezijp1(s_1) {
  let result_1 = allocFixed(8);
  nimStrWasMoved(result_1);
  let X60Qdesugar_0 = allocFixed(8);
  mem.copy(X60Qdesugar_0, jsonEscape_0_jsovezijp1(s_1), 8);
  let X60Qx_4 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 8705);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qx_5 = len_4_sysvq0asl(X60Qdesugar_0);
  let X60Qx_6 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 8705);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_1 = allocFixed(8);
  mem.copy(X60Qdesugar_1, newStringOfCap_0_sysvq0asl(((((X60Qx_4 + X60Qx_5) | 0) + X60Qx_6) | 0)), 8);
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

function len_3_Ixq6taz_jsovezijp1(s_4) {
  let result_4;
  result_4 = mem.i32(s_4);
  return result_4;
}

function getQ_7_Ir6d0tw_jsovezijp1(s_5, i_4) {
  let X60Qx_8;
  if ((i_4 < mem.i32(s_5))) {
    X60Qx_8 = (0 <= i_4);
  } else {
    X60Qx_8 = false;
  }
  if ((!X60Qx_8)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_jsovezijp1);
      return _o;
    })());
  }
  let result_5;
  result_5 = (mem.u32((s_5 + 4)) + (i_4 * 8));
  return result_5;
}

function eQdestroy_1_Ivioh0a_jsovezijp1(s_8) {
  if ((!(mem.u32((s_8 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_5 = allocFixed(4);
      mem.setI32(i_5, 0);
      {
        while ((mem.i32(i_5) < mem.i32(s_8))) {
          nimStrDestroy((mem.u32((s_8 + 4)) + (mem.i32(i_5) * 8)));
          inc_1_I6wjjge_jsfc0lwq21(i_5);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_8 + 4)));
  }
}

function newSeqUninit_0_Im3cqd9_jsovezijp1(size_2) {
  let result_7 = allocFixed(8);
  if ((size_2 === 0)) {
    mem.copy(result_7, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_2);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_1 = memSizeInBytes_0_I7me00i_jsovezijp1(size_2);
    let X60Qx_15 = alloc_1_sysvq0asl(memSize_1);
    mem.copy(result_7, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_2);
      mem.setU32((_o + 4), X60Qx_15);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_7 + 4)) === 0))) {
      let X60Qx_16 = allocFixed(8);
      mem.setU32(X60Qx_16, 1634036990);
      mem.setU32((X60Qx_16 + 4), strlit_0_I15750996627617194403_jsovezijp1);
    } else {
      mem.setI32(result_7, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    }
  }
  return result_7;
}

function capInBytes_0_Ih2sbn01_jsovezijp1(s_11) {
  let result_8;
  let X60Qx_1;
  if ((!(mem.u32((s_11 + 4)) === 0))) {
    let X60Qx_17 = allocatedSize_0_sysvq0asl(mem.u32((s_11 + 4)));
    X60Qx_1 = X60Qx_17;
  } else {
    X60Qx_1 = 0;
  }
  result_8 = X60Qx_1;
  return result_8;
}

function memSizeInBytes_0_I7me00i_jsovezijp1(size_3) {
  let result_9;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_3, 8);
  result_9 = X60QconstRefTemp_0;
  if (false) {
    result_9 = 2147483647;
  }
  return result_9;
}

let X60QiniGuard_0_jsovezijp1 = allocFixed(1);

function X60Qini_0_jsovezijp1() {
  if (mem.u8At(X60QiniGuard_0_jsovezijp1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_jsovezijp1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from webzywwor1.c.nif

function mkNode_0_webzywwor1(k_0) {
  let result_1 = allocFixed(4);
  eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(result_1);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_1));
  let X60Qx_28 = allocFixed_0_sysvq0asl(48);
  let X60Qtmp_0 = X60Qx_28;
  let X60Qx_29 = allocFixed(8);
  mem.copy(X60Qx_29, newSeqUninit_0_I5u8l6k_webzywwor1(0), 8);
  let X60Qx_30 = allocFixed(8);
  mem.copy(X60Qx_30, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
  let X60Qx_31 = allocFixed(8);
  mem.copy(X60Qx_31, newSeqUninit_0_I5u8l6k_webzywwor1(0), 8);
  mem.copy(X60Qtmp_0, (() => {
    let _o = allocFixed(48);
    mem.setI32(_o, 0);
    mem.copy((_o + 4), (() => {
      let _o = allocFixed(44);
      mem.setU8(_o, k_0);
      mem.copy((_o + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
      mem.setI32((_o + 12), 0);
      mem.setU8((_o + 16), false);
      mem.copy((_o + 20), X60Qx_29, 8);
      mem.copy((_o + 28), X60Qx_30, 8);
      mem.copy((_o + 36), X60Qx_31, 8);
      return _o;
    })(), 44);
    return _o;
  })(), 48);
  mem.setU32(result_1, X60Qtmp_0);
  return mem.u32(result_1);
}

function skipWs_0_webzywwor1(p_0) {
  whileStmtLabel_0: {
    {
      while (true) {
        var X60Qx_32 = len_4_sysvq0asl(p_0);
        if ((mem.i32((p_0 + 8)) < X60Qx_32)) {
          var c_4 = getQ_9_sysvq0asl(p_0, mem.i32((p_0 + 8)));
          var X60Qx_33;
          var X60Qx_34;
          var X60Qx_35;
          if ((c_4 === 32)) {
            X60Qx_35 = true;
          } else {
            X60Qx_35 = (c_4 === 9);
          }
          if (X60Qx_35) {
            X60Qx_34 = true;
          } else {
            X60Qx_34 = (c_4 === 10);
          }
          if (X60Qx_34) {
            X60Qx_33 = true;
          } else {
            X60Qx_33 = (c_4 === 13);
          }
          if (X60Qx_33) {
            inc_1_I6wjjge_jsfc0lwq21((p_0 + 8));
          } else {
            break whileStmtLabel_0;
          }
        } else {
          break;
        }
      }
    }
  }
}

function hexDigit_0_webzywwor1(c_0) {
  let result_2;
  let X60Qx_0;
  let X60Qx_36;
  if ((48 <= c_0)) {
    X60Qx_36 = (c_0 <= 57);
  } else {
    X60Qx_36 = false;
  }
  if (X60Qx_36) {
    X60Qx_0 = ((c_0 - 48) | 0);
  } else {
    let X60Qx_37;
    if ((97 <= c_0)) {
      X60Qx_37 = (c_0 <= 102);
    } else {
      X60Qx_37 = false;
    }
    if (X60Qx_37) {
      X60Qx_0 = ((((c_0 - 97) | 0) + 10) | 0);
    } else {
      let X60Qx_38;
      if ((65 <= c_0)) {
        X60Qx_38 = (c_0 <= 70);
      } else {
        X60Qx_38 = false;
      }
      if (X60Qx_38) {
        X60Qx_0 = ((((c_0 - 65) | 0) + 10) | 0);
      } else {
        X60Qx_0 = -1;
      }
    }
  }
  result_2 = X60Qx_0;
  return result_2;
}

function addRune_0_webzywwor1(dst_0, cp_0) {
  if ((cp_0 < 128)) {
    let X60Qx_39 = chr_0_sysvq0asl(cp_0);
    add_1_sysvq0asl(dst_0, X60Qx_39);
  } else {
    if ((cp_0 < 2048)) {
      let X60Qx_40 = chr_0_sysvq0asl((192 | (cp_0 >> 6)));
      add_1_sysvq0asl(dst_0, X60Qx_40);
      let X60Qx_41 = chr_0_sysvq0asl((128 | (cp_0 & 63)));
      add_1_sysvq0asl(dst_0, X60Qx_41);
    } else {
      let X60Qx_42 = chr_0_sysvq0asl((224 | (cp_0 >> 12)));
      add_1_sysvq0asl(dst_0, X60Qx_42);
      let X60Qx_43 = chr_0_sysvq0asl((128 | ((cp_0 >> 6) & 63)));
      add_1_sysvq0asl(dst_0, X60Qx_43);
      let X60Qx_44 = chr_0_sysvq0asl((128 | (cp_0 & 63)));
      add_1_sysvq0asl(dst_0, X60Qx_44);
    }
  }
}

function parseStr_0_webzywwor1(p_1) {
  whileStmtLabel_0: {
    var result_3 = allocFixed(8);
    nimStrWasMoved(result_3);
    nimStrDestroy(result_3);
    mem.copy(result_3, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    inc_1_I6wjjge_jsfc0lwq21((p_1 + 8));
    {
      while (true) {
        var X60Qx_45 = len_4_sysvq0asl(p_1);
        if ((mem.i32((p_1 + 8)) < X60Qx_45)) {
          var c_5 = getQ_9_sysvq0asl(p_1, mem.i32((p_1 + 8)));
          if ((c_5 === 34)) {
            inc_1_I6wjjge_jsfc0lwq21((p_1 + 8));
            return result_3;
          } else {
            var X60Qx_46;
            if ((c_5 === 92)) {
              var X60Qx_47 = len_4_sysvq0asl(p_1);
              X60Qx_46 = (((mem.i32((p_1 + 8)) + 1) | 0) < X60Qx_47);
            } else {
              X60Qx_46 = false;
            }
            if (X60Qx_46) {
              var e_1 = getQ_9_sysvq0asl(p_1, ((mem.i32((p_1 + 8)) + 1) | 0));
              switch (e_1) {
                case 34:
                  {
                    add_1_sysvq0asl(result_3, 34);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 92:
                  {
                    add_1_sysvq0asl(result_3, 92);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 47:
                  {
                    add_1_sysvq0asl(result_3, 47);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 110:
                  {
                    add_1_sysvq0asl(result_3, 10);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 116:
                  {
                    add_1_sysvq0asl(result_3, 9);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 114:
                  {
                    add_1_sysvq0asl(result_3, 13);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 98:
                  {
                    add_1_sysvq0asl(result_3, 8);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 102:
                  {
                    add_1_sysvq0asl(result_3, 12);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
                case 117:
                  {
                    var X60Qx_48 = len_4_sysvq0asl(p_1);
                    if ((((mem.i32((p_1 + 8)) + 5) | 0) < X60Qx_48)) {
                      var X60Qx_49 = getQ_9_sysvq0asl(p_1, ((mem.i32((p_1 + 8)) + 2) | 0));
                      var h0_0 = hexDigit_0_webzywwor1(X60Qx_49);
                      var X60Qx_50 = getQ_9_sysvq0asl(p_1, ((mem.i32((p_1 + 8)) + 3) | 0));
                      var h1_0 = hexDigit_0_webzywwor1(X60Qx_50);
                      var X60Qx_51 = getQ_9_sysvq0asl(p_1, ((mem.i32((p_1 + 8)) + 4) | 0));
                      var h2_0 = hexDigit_0_webzywwor1(X60Qx_51);
                      var X60Qx_52 = getQ_9_sysvq0asl(p_1, ((mem.i32((p_1 + 8)) + 5) | 0));
                      var h3_0 = hexDigit_0_webzywwor1(X60Qx_52);
                      var X60Qx_53;
                      var X60Qx_54;
                      var X60Qx_55;
                      if ((0 <= h0_0)) {
                        X60Qx_55 = (0 <= h1_0);
                      } else {
                        X60Qx_55 = false;
                      }
                      if (X60Qx_55) {
                        X60Qx_54 = (0 <= h2_0);
                      } else {
                        X60Qx_54 = false;
                      }
                      if (X60Qx_54) {
                        X60Qx_53 = (0 <= h3_0);
                      } else {
                        X60Qx_53 = false;
                      }
                      if (X60Qx_53) {
                        addRune_0_webzywwor1(result_3, ((((h0_0 << 12) | (h1_0 << 8)) | (h2_0 << 4)) | h3_0));
                      }
                      plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 6);
                    } else {
                      plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                    }
                  }
                  break;
                default:
                  {
                    add_1_sysvq0asl(result_3, e_1);
                    plusQeQ_0_Iz7fdp7_urim2dvcg1((p_1 + 8), 2);
                  }
                  break;
              }
            } else {
              add_1_sysvq0asl(result_3, c_5);
              inc_1_I6wjjge_jsfc0lwq21((p_1 + 8));
            }
          }
        } else {
          break;
        }
      }
    }
  }
  return result_3;
}

function parseArr_0_webzywwor1(p_3) {
  whileStmtLabel_0: {
    var result_4 = allocFixed(4);
    eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(result_4);
    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_4));
    var X60Qx_56 = mkNode_0_webzywwor1(4);
    mem.setU32(result_4, X60Qx_56);
    inc_1_I6wjjge_jsfc0lwq21((p_3 + 8));
    skipWs_0_webzywwor1(p_3);
    var X60Qx_57;
    var X60Qx_58 = len_4_sysvq0asl(p_3);
    if ((mem.i32((p_3 + 8)) < X60Qx_58)) {
      var X60Qx_59 = getQ_9_sysvq0asl(p_3, mem.i32((p_3 + 8)));
      X60Qx_57 = (X60Qx_59 === 93);
    } else {
      X60Qx_57 = false;
    }
    if (X60Qx_57) {
      inc_1_I6wjjge_jsfc0lwq21((p_3 + 8));
      return mem.u32(result_4);
    }
    {
      while (true) {
        var X60Qx_60 = len_4_sysvq0asl(p_3);
        if ((mem.i32((p_3 + 8)) < X60Qx_60)) {
          continueLabel_1: {
            {
              skipWs_0_webzywwor1(p_3);
              var X60Qx_61 = parseValue_1_webzywwor1(p_3);
              add_0_I4avu501_webzywwor1(((mem.u32(result_4) + 4) + 20), X60Qx_61);
              skipWs_0_webzywwor1(p_3);
              var X60Qx_62;
              var X60Qx_63 = len_4_sysvq0asl(p_3);
              if ((mem.i32((p_3 + 8)) < X60Qx_63)) {
                var X60Qx_64 = getQ_9_sysvq0asl(p_3, mem.i32((p_3 + 8)));
                X60Qx_62 = (X60Qx_64 === 44);
              } else {
                X60Qx_62 = false;
              }
              if (X60Qx_62) {
                inc_1_I6wjjge_jsfc0lwq21((p_3 + 8));
                break continueLabel_1;
              }
              var X60Qx_65;
              var X60Qx_66 = len_4_sysvq0asl(p_3);
              if ((mem.i32((p_3 + 8)) < X60Qx_66)) {
                var X60Qx_67 = getQ_9_sysvq0asl(p_3, mem.i32((p_3 + 8)));
                X60Qx_65 = (X60Qx_67 === 93);
              } else {
                X60Qx_65 = false;
              }
              if (X60Qx_65) {
                inc_1_I6wjjge_jsfc0lwq21((p_3 + 8));
              }
              break whileStmtLabel_0;
            }
          }
        } else {
          break;
        }
      }
    }
  }
  return mem.u32(result_4);
}

function parseObj_0_webzywwor1(p_4) {
  whileStmtLabel_0: {
    var result_5 = allocFixed(4);
    eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(result_5);
    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_5));
    var X60Qx_68 = mkNode_0_webzywwor1(5);
    mem.setU32(result_5, X60Qx_68);
    inc_1_I6wjjge_jsfc0lwq21((p_4 + 8));
    skipWs_0_webzywwor1(p_4);
    var X60Qx_69;
    var X60Qx_70 = len_4_sysvq0asl(p_4);
    if ((mem.i32((p_4 + 8)) < X60Qx_70)) {
      var X60Qx_71 = getQ_9_sysvq0asl(p_4, mem.i32((p_4 + 8)));
      X60Qx_69 = (X60Qx_71 === 125);
    } else {
      X60Qx_69 = false;
    }
    if (X60Qx_69) {
      inc_1_I6wjjge_jsfc0lwq21((p_4 + 8));
      return mem.u32(result_5);
    }
    {
      while (true) {
        var X60Qx_72 = len_4_sysvq0asl(p_4);
        if ((mem.i32((p_4 + 8)) < X60Qx_72)) {
          continueLabel_1: {
            {
              skipWs_0_webzywwor1(p_4);
              var X60Qx_73;
              var X60Qx_74 = len_4_sysvq0asl(p_4);
              if ((X60Qx_74 <= mem.i32((p_4 + 8)))) {
                X60Qx_73 = true;
              } else {
                var X60Qx_75 = getQ_9_sysvq0asl(p_4, mem.i32((p_4 + 8)));
                X60Qx_73 = (!(X60Qx_75 === 34));
              }
              if (X60Qx_73) {
                break whileStmtLabel_0;
              }
              var k_2 = allocFixed(8);
              mem.copy(k_2, parseStr_0_webzywwor1(p_4), 8);
              skipWs_0_webzywwor1(p_4);
              var X60Qx_76;
              var X60Qx_77 = len_4_sysvq0asl(p_4);
              if ((mem.i32((p_4 + 8)) < X60Qx_77)) {
                var X60Qx_78 = getQ_9_sysvq0asl(p_4, mem.i32((p_4 + 8)));
                X60Qx_76 = (X60Qx_78 === 58);
              } else {
                X60Qx_76 = false;
              }
              if (X60Qx_76) {
                inc_1_I6wjjge_jsfc0lwq21((p_4 + 8));
              }
              skipWs_0_webzywwor1(p_4);
              var v_1 = allocFixed(4);
              mem.setU32(v_1, parseValue_1_webzywwor1(p_4));
              var X60Qtmp_1 = allocFixed(8);
              mem.copy(X60Qtmp_1, k_2, 8);
              nimStrWasMoved(k_2);
              add_0_Ig6072n_webzywwor1(((mem.u32(result_5) + 4) + 28), X60Qtmp_1);
              var X60Qtmp_2 = mem.u32(v_1);
              eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(v_1);
              add_0_I4avu501_webzywwor1(((mem.u32(result_5) + 4) + 36), X60Qtmp_2);
              skipWs_0_webzywwor1(p_4);
              var X60Qx_79;
              var X60Qx_80 = len_4_sysvq0asl(p_4);
              if ((mem.i32((p_4 + 8)) < X60Qx_80)) {
                var X60Qx_81 = getQ_9_sysvq0asl(p_4, mem.i32((p_4 + 8)));
                X60Qx_79 = (X60Qx_81 === 44);
              } else {
                X60Qx_79 = false;
              }
              if (X60Qx_79) {
                inc_1_I6wjjge_jsfc0lwq21((p_4 + 8));
                eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(v_1));
                nimStrDestroy(k_2);
                break continueLabel_1;
              }
              var X60Qx_82;
              var X60Qx_83 = len_4_sysvq0asl(p_4);
              if ((mem.i32((p_4 + 8)) < X60Qx_83)) {
                var X60Qx_84 = getQ_9_sysvq0asl(p_4, mem.i32((p_4 + 8)));
                X60Qx_82 = (X60Qx_84 === 125);
              } else {
                X60Qx_82 = false;
              }
              if (X60Qx_82) {
                inc_1_I6wjjge_jsfc0lwq21((p_4 + 8));
              }
              eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(v_1));
              nimStrDestroy(k_2);
              break whileStmtLabel_0;
              eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(v_1));
              nimStrDestroy(k_2);
            }
          }
        } else {
          break;
        }
      }
    }
  }
  return mem.u32(result_5);
}

function parseValue_1_webzywwor1(p_5) {
  var result_6 = allocFixed(4);
  eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(result_6);
  skipWs_0_webzywwor1(p_5);
  var X60Qx_85 = len_4_sysvq0asl(p_5);
  if ((X60Qx_85 <= mem.i32((p_5 + 8)))) {
    var X60Qx_86 = mkNode_0_webzywwor1(0);
    mem.setU32(result_6, X60Qx_86);
    return mem.u32(result_6);
  }
  var c_6 = getQ_9_sysvq0asl(p_5, mem.i32((p_5 + 8)));
  if ((c_6 === 34)) {
    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
    var X60Qx_87 = mkNode_0_webzywwor1(3);
    mem.setU32(result_6, X60Qx_87);
    var X60Qlhs_3 = ((mem.u32(result_6) + 4) + 4);
    var X60Qlhs_4 = allocFixed(8);
    mem.copy(X60Qlhs_4, parseStr_0_webzywwor1(p_5), 8);
    nimStrDestroy(X60Qlhs_3);
    mem.copy(X60Qlhs_3, X60Qlhs_4, 8);
  } else {
    if ((c_6 === 123)) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
      var X60Qx_88 = parseObj_0_webzywwor1(p_5);
      mem.setU32(result_6, X60Qx_88);
    } else {
      if ((c_6 === 91)) {
        eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
        var X60Qx_89 = parseArr_0_webzywwor1(p_5);
        mem.setU32(result_6, X60Qx_89);
      } else {
        if ((c_6 === 116)) {
          eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
          var X60Qx_90 = mkNode_0_webzywwor1(1);
          mem.setU32(result_6, X60Qx_90);
          mem.setU8(((mem.u32(result_6) + 4) + 16), true);
          plusQeQ_0_Iz7fdp7_urim2dvcg1((p_5 + 8), 4);
        } else {
          if ((c_6 === 102)) {
            eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
            var X60Qx_91 = mkNode_0_webzywwor1(1);
            mem.setU32(result_6, X60Qx_91);
            mem.setU8(((mem.u32(result_6) + 4) + 16), false);
            plusQeQ_0_Iz7fdp7_urim2dvcg1((p_5 + 8), 5);
          } else {
            if ((c_6 === 110)) {
              eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
              var X60Qx_92 = mkNode_0_webzywwor1(0);
              mem.setU32(result_6, X60Qx_92);
              plusQeQ_0_Iz7fdp7_urim2dvcg1((p_5 + 8), 4);
            } else {
              whileStmtLabel_1: {
                whileStmtLabel_0: {
                  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_6));
                  var X60Qx_93 = mkNode_0_webzywwor1(2);
                  mem.setU32(result_6, X60Qx_93);
                  var neg_0 = false;
                  if ((c_6 === 45)) {
                    neg_0 = true;
                    inc_1_I6wjjge_jsfc0lwq21((p_5 + 8));
                  }
                  var v_2 = 0;
                  var any_0 = false;
                  {
                    while (true) {
                      var X60Qx_94;
                      var X60Qx_95;
                      var X60Qx_96 = len_4_sysvq0asl(p_5);
                      if ((mem.i32((p_5 + 8)) < X60Qx_96)) {
                        var X60Qx_97 = getQ_9_sysvq0asl(p_5, mem.i32((p_5 + 8)));
                        X60Qx_95 = (48 <= X60Qx_97);
                      } else {
                        X60Qx_95 = false;
                      }
                      if (X60Qx_95) {
                        var X60Qx_98 = getQ_9_sysvq0asl(p_5, mem.i32((p_5 + 8)));
                        X60Qx_94 = (X60Qx_98 <= 57);
                      } else {
                        X60Qx_94 = false;
                      }
                      if (X60Qx_94) {
                        var X60Qx_99 = getQ_9_sysvq0asl(p_5, mem.i32((p_5 + 8)));
                        v_2 = ((Math.imul(v_2, 10) + ((X60Qx_99 - 48) | 0)) | 0);
                        any_0 = true;
                        inc_1_I6wjjge_jsfc0lwq21((p_5 + 8));
                      } else {
                        break;
                      }
                    }
                  }
                }
                {
                  while (true) {
                    var X60Qx_100 = len_4_sysvq0asl(p_5);
                    if ((mem.i32((p_5 + 8)) < X60Qx_100)) {
                      var d_0 = getQ_9_sysvq0asl(p_5, mem.i32((p_5 + 8)));
                      var X60Qx_101;
                      var X60Qx_102;
                      var X60Qx_103;
                      var X60Qx_104;
                      var X60Qx_105;
                      var X60Qx_106;
                      if ((48 <= d_0)) {
                        X60Qx_106 = (d_0 <= 57);
                      } else {
                        X60Qx_106 = false;
                      }
                      if (X60Qx_106) {
                        X60Qx_105 = true;
                      } else {
                        X60Qx_105 = (d_0 === 46);
                      }
                      if (X60Qx_105) {
                        X60Qx_104 = true;
                      } else {
                        X60Qx_104 = (d_0 === 101);
                      }
                      if (X60Qx_104) {
                        X60Qx_103 = true;
                      } else {
                        X60Qx_103 = (d_0 === 69);
                      }
                      if (X60Qx_103) {
                        X60Qx_102 = true;
                      } else {
                        X60Qx_102 = (d_0 === 43);
                      }
                      if (X60Qx_102) {
                        X60Qx_101 = true;
                      } else {
                        X60Qx_101 = (d_0 === 45);
                      }
                      if (X60Qx_101) {
                        inc_1_I6wjjge_jsfc0lwq21((p_5 + 8));
                      } else {
                        break whileStmtLabel_1;
                      }
                    } else {
                      break;
                    }
                  }
                }
              }
              if ((!any_0)) {
              }
              var X60Qx_1;
              if (neg_0) {
                X60Qx_1 = (-v_2);
              } else {
                X60Qx_1 = v_2;
              }
              mem.setI32(((mem.u32(result_6) + 4) + 12), X60Qx_1);
            }
          }
        }
      }
    }
  }
  return mem.u32(result_6);
}

function parseJsonStr_0_webzywwor1(s_0) {
  let result_7 = allocFixed(4);
  eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(result_7);
  let X60Qx_107 = allocFixed(8);
  mem.copy(X60Qx_107, nimStrDup(s_0), 8);
  let p_7 = allocFixed(12);
  mem.copy(p_7, X60Qx_107, 8);
  mem.setI32((p_7 + 8), 0);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(result_7));
  let X60Qx_108 = parseValue_1_webzywwor1(p_7);
  mem.setU32(result_7, X60Qx_108);
  eQdestroyQ_SX4aX50arser0webzywwor1_0_webzywwor1(p_7);
  return mem.u32(result_7);
  eQdestroyQ_SX4aX50arser0webzywwor1_0_webzywwor1(p_7);
  return mem.u32(result_7);
}

function field_0_webzywwor1(o_0, key_0) {
  forStmtLabel_0: {
    var result_8 = allocFixed(4);
    eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(result_8);
    if ((!(mem.u8At((o_0 + 4)) === 5))) {
      return 0;
    }
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = 0;
        var X60Qlf_1 = len_3_Ixq6taz_jsovezijp1(((o_0 + 4) + 28));
        var X60Qlf_2 = allocFixed(4);
        mem.setI32(X60Qlf_2, X60Qlf_0);
        {
          while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
            {
              var X60Qx_109 = getQ_7_Ir6d0tw_jsovezijp1(((o_0 + 4) + 28), mem.i32(X60Qlf_2));
              var X60Qx_110 = eqQ_20_sysvq0asl(X60Qx_109, key_0);
              if (X60Qx_110) {
                var X60Qx_111 = getQ_7_Imk9l7s_webzywwor1(((o_0 + 4) + 36), mem.i32(X60Qlf_2));
                var X60Qx_112 = eQdupQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qx_111));
                mem.setU32(result_8, X60Qx_112);
                return mem.u32(result_8);
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_2);
          }
        }
      }
    }
  }
  return 0;
  return mem.u32(result_8);
}

function getStr_0_webzywwor1(o_1, key_1) {
  let result_9 = allocFixed(8);
  nimStrWasMoved(result_9);
  let v_3 = field_0_webzywwor1(o_1, key_1);
  let X60Qx_2 = allocFixed(8);
  nimStrWasMoved(X60Qx_2);
  let X60Qx_113;
  if ((!(v_3 === 0))) {
    X60Qx_113 = (mem.u8At((v_3 + 4)) === 3);
  } else {
    X60Qx_113 = false;
  }
  if (X60Qx_113) {
    nimStrDestroy(X60Qx_2);
    let X60Qx_114 = allocFixed(8);
    mem.copy(X60Qx_114, nimStrDup(((v_3 + 4) + 4)), 8);
    mem.copy(X60Qx_2, X60Qx_114, 8);
  } else {
    nimStrDestroy(X60Qx_2);
    mem.copy(X60Qx_2, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  }
  nimStrDestroy(result_9);
  mem.copy(result_9, X60Qx_2, 8);
  nimStrWasMoved(X60Qx_2);
  nimStrDestroy(X60Qx_2);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(v_3);
  return result_9;
  nimStrDestroy(X60Qx_2);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(v_3);
  return result_9;
}

function getInt_0_webzywwor1(o_2, key_2, sawIt_0) {
  let result_10;
  let v_4 = field_0_webzywwor1(o_2, key_2);
  let X60Qx_3;
  let X60Qx_115;
  if ((!(v_4 === 0))) {
    X60Qx_115 = (mem.u8At((v_4 + 4)) === 2);
  } else {
    X60Qx_115 = false;
  }
  if (X60Qx_115) {
    mem.setU8(sawIt_0, true);
    X60Qx_3 = mem.i32(((v_4 + 4) + 12));
  } else {
    mem.setU8(sawIt_0, false);
    X60Qx_3 = 0;
  }
  result_10 = X60Qx_3;
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(v_4);
  return result_10;
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(v_4);
  return result_10;
}

function rematerialize_0_webzywwor1(v_0) {
  forStmtLabel_0: {
    var result_11 = allocFixed(8);
    nimStrWasMoved(result_11);
    var raw_1 = allocFixed(8);
    mem.copy(raw_1, toStr_0_jsfc0lwq21(v_0), 8);
    nimStrDestroy(result_11);
    mem.copy(result_11, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_3 = 0;
        var X60Qlf_4 = len_4_sysvq0asl(raw_1);
        var X60Qlf_5 = allocFixed(4);
        mem.setI32(X60Qlf_5, X60Qlf_3);
        {
          while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
            {
              var X60Qx_116 = getQ_9_sysvq0asl(raw_1, mem.i32(X60Qlf_5));
              add_1_sysvq0asl(result_11, X60Qx_116);
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_5);
          }
        }
      }
    }
  }
  nimStrDestroy(raw_1);
  return result_11;
  nimStrDestroy(raw_1);
  return result_11;
}

function readGlobal_0_webzywwor1(name_0) {
  let result_12 = allocFixed(8);
  nimStrWasMoved(result_12);
  nimStrDestroy(result_12);
  let X60Qtmp_5 = allocFixed(4);
  mem.copy(X60Qtmp_5, global_0_jsfc0lwq21(name_0), 4);
  let X60Qx_117 = allocFixed(8);
  mem.copy(X60Qx_117, rematerialize_0_webzywwor1(X60Qtmp_5), 8);
  mem.copy(result_12, X60Qx_117, 8);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_5);
  return result_12;
  eQdestroy_0_jsfc0lwq21(X60Qtmp_5);
  return result_12;
}

function setGlobal_0_webzywwor1(name_1, value_0) {
  let g_0 = allocFixed(4);
  mem.copy(g_0, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869375486);
    mem.setU32((_o + 4), strlit_0_I16664880105326712979_webzywwor1);
    return _o;
  })()), 4);
  let X60Qtmp_6 = allocFixed(4);
  mem.copy(X60Qtmp_6, toJs_3_jsfc0lwq21(value_0), 4);
  set_0_jsfc0lwq21(g_0, name_1, X60Qtmp_6);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_6);
  eQdestroy_0_jsfc0lwq21(g_0);
}

function parseDecls_0_webzywwor1(js_0) {
  forStmtLabel_0: {
    var result_13 = allocFixed(8);
    eQwasMoved_1_Igrahnr1_webzywwor1(result_13);
    eQdestroy_1_Idvuhgk_webzywwor1(result_13);
    var X60Qx_118 = allocFixed(8);
    mem.copy(X60Qx_118, newSeqUninit_0_I3av7471_webzywwor1(0), 8);
    mem.copy(result_13, X60Qx_118, 8);
    var root_0 = parseJsonStr_0_webzywwor1(js_0);
    if ((!(mem.u8At((root_0 + 4)) === 4))) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_0);
      return result_13;
    }
    {
      whileStmtLabel_1: {
        var X60Qlf_6 = 0;
        var X60Qlf_7 = len_3_I1yvahf1_webzywwor1(((root_0 + 4) + 20));
        var X60Qlf_8 = allocFixed(4);
        mem.setI32(X60Qlf_8, X60Qlf_6);
        {
          while ((mem.i32(X60Qlf_8) < X60Qlf_7)) {
            {
              continueLabel_2: {
                {
                  var X60Qx_119 = getQ_7_Imk9l7s_webzywwor1(((root_0 + 4) + 20), mem.i32(X60Qlf_8));
                  var X60Qii_3 = allocFixed(4);
                  mem.setU32(X60Qii_3, eQdupQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qx_119)));
                  if ((!(mem.u8At((mem.u32(X60Qii_3) + 4)) === 5))) {
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                    break continueLabel_2;
                  }
                  var X60Qii_4 = allocFixed(1);
                  mem.setU8(X60Qii_4, false);
                  var X60Qii_5 = getInt_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852402942);
                    mem.setU32((_o + 4), strlit_0_I1643616165736515820_webzywwor1);
                    return _o;
                  })(), X60Qii_4);
                  var X60Qii_6 = allocFixed(1);
                  mem.setU8(X60Qii_6, false);
                  var X60Qii_7 = getInt_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1819239171);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })(), X60Qii_6);
                  var X60Qx_120 = allocFixed(8);
                  mem.copy(X60Qx_120, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1836675843);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })()), 8);
                  var X60Qx_121 = allocFixed(8);
                  mem.copy(X60Qx_121, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1835101950);
                    mem.setU32((_o + 4), strlit_0_I407209193152762291_webzywwor1);
                    return _o;
                  })()), 8);
                  var X60Qx_122 = allocFixed(8);
                  mem.copy(X60Qx_122, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852402686);
                    mem.setU32((_o + 4), strlit_0_I18311672068392283896_webzywwor1);
                    return _o;
                  })()), 8);
                  var X60Qx_123 = allocFixed(8);
                  mem.copy(X60Qx_123, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1818846974);
                    mem.setU32((_o + 4), strlit_0_I4541348101218926504_webzywwor1);
                    return _o;
                  })()), 8);
                  add_0_Ifd8wg71_webzywwor1(result_13, (() => {
                    var _o = allocFixed(44);
                    mem.copy(_o, X60Qx_120, 8);
                    mem.copy((_o + 8), X60Qx_121, 8);
                    mem.copy((_o + 16), X60Qx_122, 8);
                    mem.copy((_o + 24), X60Qx_123, 8);
                    mem.setI32((_o + 32), X60Qii_5);
                    mem.setI32((_o + 36), X60Qii_7);
                    mem.setU8((_o + 40), mem.u8At(X60Qii_4));
                    return _o;
                  })());
                  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                }
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_8);
          }
        }
      }
    }
  }
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_0);
  return result_13;
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_0);
  return result_13;
}

function parseCalls_0_webzywwor1(js_1) {
  forStmtLabel_0: {
    var result_14 = allocFixed(8);
    eQwasMoved_1_I9n3zs11_webzywwor1(result_14);
    eQdestroy_1_Idmsvvi_webzywwor1(result_14);
    var X60Qx_124 = allocFixed(8);
    mem.copy(X60Qx_124, newSeqUninit_0_Ixeb9vm_webzywwor1(0), 8);
    mem.copy(result_14, X60Qx_124, 8);
    var root_1 = parseJsonStr_0_webzywwor1(js_1);
    if ((!(mem.u8At((root_1 + 4)) === 4))) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_1);
      return result_14;
    }
    {
      whileStmtLabel_1: {
        var X60Qlf_9 = 0;
        var X60Qlf_10 = len_3_I1yvahf1_webzywwor1(((root_1 + 4) + 20));
        var X60Qlf_11 = allocFixed(4);
        mem.setI32(X60Qlf_11, X60Qlf_9);
        {
          while ((mem.i32(X60Qlf_11) < X60Qlf_10)) {
            {
              continueLabel_2: {
                {
                  var X60Qx_125 = getQ_7_Imk9l7s_webzywwor1(((root_1 + 4) + 20), mem.i32(X60Qlf_11));
                  var X60Qii_3 = allocFixed(4);
                  mem.setU32(X60Qii_3, eQdupQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qx_125)));
                  if ((!(mem.u8At((mem.u32(X60Qii_3) + 4)) === 5))) {
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                    break continueLabel_2;
                  }
                  var X60Qii_4 = allocFixed(1);
                  mem.setU8(X60Qii_4, false);
                  var X60Qii_5 = getInt_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852402942);
                    mem.setU32((_o + 4), strlit_0_I1643616165736515820_webzywwor1);
                    return _o;
                  })(), X60Qii_4);
                  var X60Qii_6 = allocFixed(1);
                  mem.setU8(X60Qii_6, false);
                  var X60Qii_7 = getInt_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1819239171);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })(), X60Qii_6);
                  var X60Qx_126 = allocFixed(8);
                  mem.copy(X60Qx_126, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1818321918);
                    mem.setU32((_o + 4), strlit_0_I11599078958678393897_webzywwor1);
                    return _o;
                  })()), 8);
                  var X60Qx_127 = allocFixed(8);
                  mem.copy(X60Qx_127, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1818321918);
                    mem.setU32((_o + 4), strlit_0_I17555607389722195064_webzywwor1);
                    return _o;
                  })()), 8);
                  var X60Qx_128 = allocFixed(8);
                  mem.copy(X60Qx_128, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1818846974);
                    mem.setU32((_o + 4), strlit_0_I4541348101218926504_webzywwor1);
                    return _o;
                  })()), 8);
                  add_0_In2qv0v_webzywwor1(result_14, (() => {
                    var _o = allocFixed(36);
                    mem.copy(_o, X60Qx_126, 8);
                    mem.copy((_o + 8), X60Qx_127, 8);
                    mem.copy((_o + 16), X60Qx_128, 8);
                    mem.setI32((_o + 24), X60Qii_5);
                    mem.setI32((_o + 28), X60Qii_7);
                    mem.setU8((_o + 32), mem.u8At(X60Qii_4));
                    return _o;
                  })());
                  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                }
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_11);
          }
        }
      }
    }
  }
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_1);
  return result_14;
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_1);
  return result_14;
}

function baseName_0_webzywwor1(p_6) {
  whileStmtLabel_0: {
    var result_15 = allocFixed(8);
    nimStrWasMoved(result_15);
    var X60Qx_129 = len_4_sysvq0asl(p_6);
    var i_6 = allocFixed(4);
    mem.setI32(i_6, ((X60Qx_129 - 1) | 0));
    {
      while (true) {
        var X60Qx_130;
        if ((0 <= mem.i32(i_6))) {
          var X60Qx_131 = getQ_9_sysvq0asl(p_6, mem.i32(i_6));
          X60Qx_130 = (!(X60Qx_131 === 47));
        } else {
          X60Qx_130 = false;
        }
        if (X60Qx_130) {
          dec_1_I0nzoz91_sysvq0asl(i_6);
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_4 = allocFixed(8);
  nimStrWasMoved(X60Qx_4);
  if ((mem.i32(i_6) < 0)) {
    nimStrDestroy(X60Qx_4);
    var X60Qx_132 = allocFixed(8);
    mem.copy(X60Qx_132, nimStrDup(p_6), 8);
    mem.copy(X60Qx_4, X60Qx_132, 8);
  } else {
    nimStrDestroy(X60Qx_4);
    var X60Qx_133 = len_4_sysvq0asl(p_6);
    var X60Qx_134 = allocFixed(8);
    mem.copy(X60Qx_134, substr_0_sysvq0asl(p_6, ((mem.i32(i_6) + 1) | 0), ((X60Qx_133 - 1) | 0)), 8);
    mem.copy(X60Qx_4, X60Qx_134, 8);
  }
  nimStrDestroy(result_15);
  mem.copy(result_15, X60Qx_4, 8);
  nimStrWasMoved(X60Qx_4);
  nimStrDestroy(X60Qx_4);
  return result_15;
  nimStrDestroy(X60Qx_4);
  return result_15;
}

function symBase_0_webzywwor1(sym_0) {
  whileStmtLabel_0: {
    var result_16 = allocFixed(8);
    nimStrWasMoved(result_16);
    var i_7 = allocFixed(4);
    mem.setI32(i_7, 0);
    {
      while (true) {
        var X60Qx_135;
        var X60Qx_136 = len_4_sysvq0asl(sym_0);
        if ((mem.i32(i_7) < X60Qx_136)) {
          var X60Qx_137 = getQ_9_sysvq0asl(sym_0, mem.i32(i_7));
          X60Qx_135 = (!(X60Qx_137 === 46));
        } else {
          X60Qx_135 = false;
        }
        if (X60Qx_135) {
          inc_1_I6wjjge_jsfc0lwq21(i_7);
        } else {
          break;
        }
      }
    }
  }
  nimStrDestroy(result_16);
  var X60Qx_138 = allocFixed(8);
  mem.copy(X60Qx_138, substr_0_sysvq0asl(sym_0, 0, ((mem.i32(i_7) - 1) | 0)), 8);
  mem.copy(result_16, X60Qx_138, 8);
  return result_16;
}

function among_0_webzywwor1(s_1, xs_0) {
  forStmtLabel_0: {
    var result_17;
    {
      whileStmtLabel_1: {
        var X60Qlf_12 = allocFixed(8);
        mem.copy(X60Qlf_12, xs_0, 8);
        var X60Qlf_13 = allocFixed(4);
        mem.setI32(X60Qlf_13, 0);
        {
          while (true) {
            var X60Qx_139 = len_6_Igv2wyu1_webzywwor1(X60Qlf_12);
            if ((mem.i32(X60Qlf_13) < X60Qx_139)) {
              {
                var X60Qii_2 = allocFixed(4);
                mem.setU32(X60Qii_2, getQ_10_Ik9hgkq1_webzywwor1(X60Qlf_12, mem.i32(X60Qlf_13)));
                var X60Qx_140 = eqQ_20_sysvq0asl(s_1, mem.u32(X60Qii_2));
                if (X60Qx_140) {
                  return true;
                }
              }
              inc_1_I6wjjge_jsfc0lwq21(X60Qlf_13);
            } else {
              break;
            }
          }
        }
      }
    }
  }
  result_17 = false;
  return result_17;
}

function isIdentChar_0_webzywwor1(c_1) {
  let result_18;
  let X60Qx_141;
  let X60Qx_142;
  let X60Qx_143;
  let X60Qx_144;
  if ((97 <= c_1)) {
    X60Qx_144 = (c_1 <= 122);
  } else {
    X60Qx_144 = false;
  }
  if (X60Qx_144) {
    X60Qx_143 = true;
  } else {
    let X60Qx_145;
    if ((65 <= c_1)) {
      X60Qx_145 = (c_1 <= 90);
    } else {
      X60Qx_145 = false;
    }
    X60Qx_143 = X60Qx_145;
  }
  if (X60Qx_143) {
    X60Qx_142 = true;
  } else {
    let X60Qx_146;
    if ((48 <= c_1)) {
      X60Qx_146 = (c_1 <= 57);
    } else {
      X60Qx_146 = false;
    }
    X60Qx_142 = X60Qx_146;
  }
  if (X60Qx_142) {
    X60Qx_141 = true;
  } else {
    X60Qx_141 = (c_1 === 95);
  }
  result_18 = X60Qx_141;
  return result_18;
}

function nthLine_0_webzywwor1(text_0, n_0) {
  whileStmtLabel_0: {
    var result_19 = allocFixed(8);
    nimStrWasMoved(result_19);
    var cur_0 = allocFixed(4);
    mem.setI32(cur_0, 0);
    var start_0 = 0;
    var i_8 = allocFixed(4);
    mem.setI32(i_8, 0);
    {
      while (true) {
        var X60Qx_147 = len_4_sysvq0asl(text_0);
        if ((mem.i32(i_8) <= X60Qx_147)) {
          var X60Qx_148;
          var X60Qx_149 = len_4_sysvq0asl(text_0);
          if ((mem.i32(i_8) === X60Qx_149)) {
            X60Qx_148 = true;
          } else {
            var X60Qx_150 = getQ_9_sysvq0asl(text_0, mem.i32(i_8));
            X60Qx_148 = (X60Qx_150 === 10);
          }
          if (X60Qx_148) {
            if ((mem.i32(cur_0) === n_0)) {
              var e_2 = allocFixed(4);
              mem.setI32(e_2, mem.i32(i_8));
              var X60Qx_151;
              if ((start_0 < mem.i32(e_2))) {
                var X60Qx_152 = getQ_9_sysvq0asl(text_0, ((mem.i32(e_2) - 1) | 0));
                X60Qx_151 = (X60Qx_152 === 13);
              } else {
                X60Qx_151 = false;
              }
              if (X60Qx_151) {
                dec_1_I0nzoz91_sysvq0asl(e_2);
              }
              var X60Qx_153 = allocFixed(8);
              mem.copy(X60Qx_153, substr_0_sysvq0asl(text_0, start_0, ((mem.i32(e_2) - 1) | 0)), 8);
              mem.copy(result_19, X60Qx_153, 8);
              return result_19;
            }
            inc_1_I6wjjge_jsfc0lwq21(cur_0);
            start_0 = ((mem.i32(i_8) + 1) | 0);
          }
          inc_1_I6wjjge_jsfc0lwq21(i_8);
        } else {
          break;
        }
      }
    }
  }
  return (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })();
  return result_19;
}

function kindToLspSymbol_0_webzywwor1(kind_0) {
  let result_20;
  let X60Qx_5;
  let X60QconstRefTemp_0 = allocFixed(56);
  mem.copy(X60QconstRefTemp_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869771006);
    mem.setU32((_o + 4), strlit_0_I5316556160589403975_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 8), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1853187838);
    mem.setU32((_o + 4), strlit_0_I9991102891510134496_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 16), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952804350);
    mem.setU32((_o + 4), strlit_0_I6517805684605582485_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 24), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I6864681898360807206_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 32), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667329534);
    mem.setU32((_o + 4), strlit_0_I3777428167486794959_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 40), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1835365630);
    mem.setU32((_o + 4), strlit_0_I17987658270787974407_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 48), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702128126);
    mem.setU32((_o + 4), strlit_0_I9071657656589967445_webzywwor1);
    return _o;
  })(), 8);
  let X60Qx_154 = allocFixed(8);
  mem.copy(X60Qx_154, toOpenArray_0_Ih6urrr1_webzywwor1(X60QconstRefTemp_0), 8);
  let X60Qx_155 = among_0_webzywwor1(kind_0, X60Qx_154);
  if (X60Qx_155) {
    X60Qx_5 = 12;
  } else {
    let X60Qx_156 = eqQ_20_sysvq0asl(kind_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1887007998);
      mem.setU32((_o + 4), strlit_0_I13413619771642637377_webzywwor1);
      return _o;
    })());
    if (X60Qx_156) {
      X60Qx_5 = 5;
    } else {
      let X60QconstRefTemp_1 = allocFixed(24);
      mem.copy(X60QconstRefTemp_1, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1952803843);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
      mem.copy((X60QconstRefTemp_1 + 8), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1852793854);
        mem.setU32((_o + 4), strlit_0_I12999086881046019782_webzywwor1);
        return _o;
      })(), 8);
      mem.copy((X60QconstRefTemp_1 + 16), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1701603326);
        mem.setU32((_o + 4), strlit_0_I5723805845286553140_webzywwor1);
        return _o;
      })(), 8);
      let X60Qx_157 = allocFixed(8);
      mem.copy(X60Qx_157, toOpenArray_0_I3urt0l_webzywwor1(X60QconstRefTemp_1), 8);
      let X60Qx_158 = among_0_webzywwor1(kind_0, X60Qx_157);
      if (X60Qx_158) {
        X60Qx_5 = 14;
      } else {
        let X60QconstRefTemp_2 = allocFixed(16);
        mem.copy(X60QconstRefTemp_2, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1918989827);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), 8);
        mem.copy((X60QconstRefTemp_2 + 8), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1635149822);
          mem.setU32((_o + 4), strlit_0_I1281801651151844468_webzywwor1);
          return _o;
        })(), 8);
        let X60Qx_159 = allocFixed(8);
        mem.copy(X60Qx_159, toOpenArray_0_Il5czcd1_webzywwor1(X60QconstRefTemp_2), 8);
        let X60Qx_160 = among_0_webzywwor1(kind_0, X60Qx_159);
        if (X60Qx_160) {
          X60Qx_5 = 13;
        } else {
          X60Qx_5 = 13;
        }
      }
    }
  }
  result_20 = X60Qx_5;
  return result_20;
}

function lineRange_0_webzywwor1(line_0, col_0) {
  let result_21 = allocFixed(16);
  let X60Qx_6;
  if ((0 < line_0)) {
    X60Qx_6 = ((line_0 - 1) | 0);
  } else {
    X60Qx_6 = 0;
  }
  let l_0 = X60Qx_6;
  let X60Qx_161 = allocFixed(16);
  mem.copy(X60Qx_161, mkRange_0_pro4b75yb(l_0, col_0, l_0, col_0), 16);
  mem.copy(result_21, X60Qx_161, 16);
  return result_21;
}

function featSymbols_0_webzywwor1(decls_0, wantFile_0) {
  forStmtLabel_5: {
    forStmtLabel_0: {
      var result_22 = allocFixed(8);
      nimStrWasMoved(result_22);
      var X60Qx_7 = allocFixed(8);
      nimStrWasMoved(X60Qx_7);
      var X60Qx_162 = len_4_sysvq0asl(wantFile_0);
      if ((0 < X60Qx_162)) {
        nimStrDestroy(X60Qx_7);
        var X60Qx_163 = allocFixed(8);
        mem.copy(X60Qx_163, baseName_0_webzywwor1(wantFile_0), 8);
        mem.copy(X60Qx_7, X60Qx_163, 8);
      } else {
        nimStrDestroy(X60Qx_7);
        mem.copy(X60Qx_7, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 0);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), 8);
      }
      var want_0 = allocFixed(8);
      mem.copy(want_0, X60Qx_7, 8);
      nimStrWasMoved(X60Qx_7);
      var parts_0 = allocFixed(8);
      mem.copy(parts_0, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
      {
        whileStmtLabel_1: {
          var X60Qlf_14 = 0;
          var X60Qlf_15 = len_3_I92u5c2_webzywwor1(decls_0);
          var X60Qlf_16 = allocFixed(4);
          mem.setI32(X60Qlf_16, X60Qlf_14);
          {
            while ((mem.i32(X60Qlf_16) < X60Qlf_15)) {
              {
                continueLabel_2: {
                  {
                    var X60Qx_164 = getQ_7_Ixinnyx1_webzywwor1(decls_0, mem.i32(X60Qlf_16));
                    var X60QconstRefTemp_0 = allocFixed(44);
                    mem.copy(X60QconstRefTemp_0, X60Qx_164, 44);
                    var X60Qii_3 = allocFixed(44);
                    mem.copy(X60Qii_3, eQdupQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60QconstRefTemp_0), 44);
                    var X60Qx_165;
                    if ((!mem.u8At((X60Qii_3 + 40)))) {
                      X60Qx_165 = true;
                    } else {
                      var X60Qx_166 = len_4_sysvq0asl((X60Qii_3 + 8));
                      X60Qx_165 = (X60Qx_166 === 0);
                    }
                    if (X60Qx_165) {
                      eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                      break continueLabel_2;
                    }
                    var X60Qx_27;
                    var X60Qx_167 = len_4_sysvq0asl(want_0);
                    if ((0 < X60Qx_167)) {
                      var X60Qtmp_7 = allocFixed(8);
                      mem.copy(X60Qtmp_7, baseName_0_webzywwor1((X60Qii_3 + 24)), 8);
                      var X60Qx_168 = eqQ_20_sysvq0asl(X60Qtmp_7, want_0);
                      X60Qx_27 = (!X60Qx_168);
                      nimStrDestroy(X60Qtmp_7);
                    } else {
                      X60Qx_27 = false;
                    }
                    if (X60Qx_27) {
                      eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                      break continueLabel_2;
                    }
                    var X60Qx_169 = allocFixed(16);
                    mem.copy(X60Qx_169, lineRange_0_webzywwor1(mem.i32((X60Qii_3 + 32)), mem.i32((X60Qii_3 + 36))), 16);
                    var X60Qii_4 = allocFixed(8);
                    mem.copy(X60Qii_4, rangeJson_0_pro4b75yb(X60Qx_169), 8);
                    var X60Qdesugar_0 = allocFixed(8);
                    mem.copy(X60Qdesugar_0, jStr_0_jsovezijp1((X60Qii_3 + 8)), 8);
                    var X60Qx_170 = kindToLspSymbol_0_webzywwor1((X60Qii_3 + 16));
                    var X60Qdesugar_1 = allocFixed(8);
                    mem.copy(X60Qdesugar_1, dollarQ_2_sysvq0asl(X60Qx_170), 8);
                    var X60Qx_171 = len_4_sysvq0asl((() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1847753726);
                      mem.setU32((_o + 4), strlit_0_I4040027577734042557_webzywwor1);
                      return _o;
                    })());
                    var X60Qx_172 = len_4_sysvq0asl(X60Qdesugar_0);
                    var X60Qx_173 = len_4_sysvq0asl((() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1797401854);
                      mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                      return _o;
                    })());
                    var X60Qx_174 = len_4_sysvq0asl(X60Qdesugar_1);
                    var X60Qx_175 = len_4_sysvq0asl((() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1914842366);
                      mem.setU32((_o + 4), strlit_0_I3311192284723978258_pro4b75yb);
                      return _o;
                    })());
                    var X60Qx_176 = len_4_sysvq0asl(X60Qii_4);
                    var X60Qx_177 = len_4_sysvq0asl((() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1931619582);
                      mem.setU32((_o + 4), strlit_0_I8882604075618536539_webzywwor1);
                      return _o;
                    })());
                    var X60Qx_178 = len_4_sysvq0asl(X60Qii_4);
                    var X60Qx_179 = len_4_sysvq0asl((() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 32001);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                    var X60Qdesugar_2 = allocFixed(8);
                    mem.copy(X60Qdesugar_2, newStringOfCap_0_sysvq0asl(((((((((((((((((X60Qx_171 + X60Qx_172) | 0) + X60Qx_173) | 0) + X60Qx_174) | 0) + X60Qx_175) | 0) + X60Qx_176) | 0) + X60Qx_177) | 0) + X60Qx_178) | 0) + X60Qx_179) | 0)), 8);
                    add_2_sysvq0asl(X60Qdesugar_2, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1847753726);
                      mem.setU32((_o + 4), strlit_0_I4040027577734042557_webzywwor1);
                      return _o;
                    })());
                    add_2_sysvq0asl(X60Qdesugar_2, X60Qdesugar_0);
                    add_2_sysvq0asl(X60Qdesugar_2, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1797401854);
                      mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                      return _o;
                    })());
                    add_2_sysvq0asl(X60Qdesugar_2, X60Qdesugar_1);
                    add_2_sysvq0asl(X60Qdesugar_2, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1914842366);
                      mem.setU32((_o + 4), strlit_0_I3311192284723978258_pro4b75yb);
                      return _o;
                    })());
                    add_2_sysvq0asl(X60Qdesugar_2, X60Qii_4);
                    add_2_sysvq0asl(X60Qdesugar_2, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1931619582);
                      mem.setU32((_o + 4), strlit_0_I8882604075618536539_webzywwor1);
                      return _o;
                    })());
                    add_2_sysvq0asl(X60Qdesugar_2, X60Qii_4);
                    add_2_sysvq0asl(X60Qdesugar_2, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 32001);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                    var X60Qtmp_8 = allocFixed(8);
                    mem.copy(X60Qtmp_8, X60Qdesugar_2, 8);
                    nimStrWasMoved(X60Qdesugar_2);
                    add_0_Ig6072n_webzywwor1(parts_0, X60Qtmp_8);
                    nimStrDestroy(X60Qdesugar_2);
                    nimStrDestroy(X60Qdesugar_1);
                    nimStrDestroy(X60Qdesugar_0);
                    nimStrDestroy(X60Qii_4);
                    eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                  }
                }
              }
              inc_1_I6wjjge_jsfc0lwq21(X60Qlf_16);
            }
          }
        }
      }
    }
    nimStrDestroy(result_22);
    mem.copy(result_22, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_6: {
        var X60Qlf_17 = 0;
        var X60Qlf_18 = len_3_Ixq6taz_jsovezijp1(parts_0);
        var X60Qlf_19 = allocFixed(4);
        mem.setI32(X60Qlf_19, X60Qlf_17);
        {
          while ((mem.i32(X60Qlf_19) < X60Qlf_18)) {
            {
              if ((0 < mem.i32(X60Qlf_19))) {
                add_2_sysvq0asl(result_22, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_180 = getQ_7_Ir6d0tw_jsovezijp1(parts_0, mem.i32(X60Qlf_19));
              add_2_sysvq0asl(result_22, X60Qx_180);
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_19);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_22, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  eQdestroy_1_Ivioh0a_jsovezijp1(parts_0);
  nimStrDestroy(want_0);
  nimStrDestroy(X60Qx_7);
  return result_22;
  eQdestroy_1_Ivioh0a_jsovezijp1(parts_0);
  nimStrDestroy(want_0);
  nimStrDestroy(X60Qx_7);
  return result_22;
}

function kindToLspCompletion_0_webzywwor1(kind_1) {
  let result_23;
  let X60Qx_8;
  let X60QconstRefTemp_0 = allocFixed(56);
  mem.copy(X60QconstRefTemp_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869771006);
    mem.setU32((_o + 4), strlit_0_I5316556160589403975_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 8), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1853187838);
    mem.setU32((_o + 4), strlit_0_I9991102891510134496_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 16), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952804350);
    mem.setU32((_o + 4), strlit_0_I6517805684605582485_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 24), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I6864681898360807206_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 32), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702128126);
    mem.setU32((_o + 4), strlit_0_I9071657656589967445_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 40), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1835365630);
    mem.setU32((_o + 4), strlit_0_I17987658270787974407_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 48), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667329534);
    mem.setU32((_o + 4), strlit_0_I3777428167486794959_webzywwor1);
    return _o;
  })(), 8);
  let X60Qx_181 = allocFixed(8);
  mem.copy(X60Qx_181, toOpenArray_0_Ih6urrr1_webzywwor1(X60QconstRefTemp_0), 8);
  let X60Qx_182 = among_0_webzywwor1(kind_1, X60Qx_181);
  if (X60Qx_182) {
    X60Qx_8 = 3;
  } else {
    let X60QconstRefTemp_1 = allocFixed(16);
    mem.copy(X60QconstRefTemp_1, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1887007998);
      mem.setU32((_o + 4), strlit_0_I13413619771642637377_webzywwor1);
      return _o;
    })(), 8);
    mem.copy((X60QconstRefTemp_1 + 8), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1784836094);
      mem.setU32((_o + 4), strlit_0_I973692718279674627_webzywwor1);
      return _o;
    })(), 8);
    let X60Qx_183 = allocFixed(8);
    mem.copy(X60Qx_183, toOpenArray_0_Il5czcd1_webzywwor1(X60QconstRefTemp_1), 8);
    let X60Qx_184 = among_0_webzywwor1(kind_1, X60Qx_183);
    if (X60Qx_184) {
      X60Qx_8 = 7;
    } else {
      let X60Qx_185 = eqQ_20_sysvq0asl(kind_1, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1970169342);
        mem.setU32((_o + 4), strlit_0_I10462096440466995513_webzywwor1);
        return _o;
      })());
      if (X60Qx_185) {
        X60Qx_8 = 13;
      } else {
        let X60QconstRefTemp_2 = allocFixed(24);
        mem.copy(X60QconstRefTemp_2, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1952803843);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), 8);
        mem.copy((X60QconstRefTemp_2 + 8), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1701603326);
          mem.setU32((_o + 4), strlit_0_I5723805845286553140_webzywwor1);
          return _o;
        })(), 8);
        mem.copy((X60QconstRefTemp_2 + 16), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1852793854);
          mem.setU32((_o + 4), strlit_0_I12999086881046019782_webzywwor1);
          return _o;
        })(), 8);
        let X60Qx_186 = allocFixed(8);
        mem.copy(X60Qx_186, toOpenArray_0_I3urt0l_webzywwor1(X60QconstRefTemp_2), 8);
        let X60Qx_187 = among_0_webzywwor1(kind_1, X60Qx_186);
        if (X60Qx_187) {
          X60Qx_8 = 21;
        } else {
          let X60QconstRefTemp_3 = allocFixed(16);
          mem.copy(X60QconstRefTemp_3, (() => {
            let _o = allocFixed(8);
            mem.setU32(_o, 1918989827);
            mem.setU32((_o + 4), 0);
            return _o;
          })(), 8);
          mem.copy((X60QconstRefTemp_3 + 8), (() => {
            let _o = allocFixed(8);
            mem.setU32(_o, 1635149822);
            mem.setU32((_o + 4), strlit_0_I1281801651151844468_webzywwor1);
            return _o;
          })(), 8);
          let X60Qx_188 = allocFixed(8);
          mem.copy(X60Qx_188, toOpenArray_0_Il5czcd1_webzywwor1(X60QconstRefTemp_3), 8);
          let X60Qx_189 = among_0_webzywwor1(kind_1, X60Qx_188);
          if (X60Qx_189) {
            X60Qx_8 = 6;
          } else {
            X60Qx_8 = 1;
          }
        }
      }
    }
  }
  result_23 = X60Qx_8;
  return result_23;
}

function reversed_0_webzywwor1(s_2) {
  whileStmtLabel_0: {
    var result_24 = allocFixed(8);
    nimStrWasMoved(result_24);
    nimStrDestroy(result_24);
    mem.copy(result_24, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    var X60Qx_190 = len_4_sysvq0asl(s_2);
    var i_12 = allocFixed(4);
    mem.setI32(i_12, ((X60Qx_190 - 1) | 0));
    {
      while ((0 <= mem.i32(i_12))) {
        var X60Qx_191 = getQ_9_sysvq0asl(s_2, mem.i32(i_12));
        add_1_sysvq0asl(result_24, X60Qx_191);
        dec_1_I0nzoz91_sysvq0asl(i_12);
      }
    }
  }
  return result_24;
}

function prefixAt_0_webzywwor1(src_0, line_1, col_1) {
  whileStmtLabel_0: {
    var result_25 = allocFixed(8);
    nimStrWasMoved(result_25);
    var ln_2 = allocFixed(8);
    mem.copy(ln_2, nthLine_0_webzywwor1(src_0, line_1), 8);
    var c_7 = col_1;
    var X60Qx_192 = len_4_sysvq0asl(ln_2);
    if ((X60Qx_192 < c_7)) {
      var X60Qx_193 = len_4_sysvq0asl(ln_2);
      c_7 = X60Qx_193;
    }
    if ((c_7 < 0)) {
      c_7 = 0;
    }
    var acc_0 = allocFixed(8);
    mem.setU32(acc_0, 0);
    mem.setU32((acc_0 + 4), 0);
    var i_13 = allocFixed(4);
    mem.setI32(i_13, ((c_7 - 1) | 0));
    {
      while (true) {
        var X60Qx_194;
        if ((0 <= mem.i32(i_13))) {
          var X60Qx_195 = getQ_9_sysvq0asl(ln_2, mem.i32(i_13));
          var X60Qx_196 = isIdentChar_0_webzywwor1(X60Qx_195);
          X60Qx_194 = X60Qx_196;
        } else {
          X60Qx_194 = false;
        }
        if (X60Qx_194) {
          var X60Qx_197 = getQ_9_sysvq0asl(ln_2, mem.i32(i_13));
          add_1_sysvq0asl(acc_0, X60Qx_197);
          dec_1_I0nzoz91_sysvq0asl(i_13);
        } else {
          break;
        }
      }
    }
  }
  nimStrDestroy(result_25);
  var X60Qx_198 = allocFixed(8);
  mem.copy(X60Qx_198, reversed_0_webzywwor1(acc_0), 8);
  mem.copy(result_25, X60Qx_198, 8);
  nimStrDestroy(acc_0);
  nimStrDestroy(ln_2);
  return result_25;
  nimStrDestroy(acc_0);
  nimStrDestroy(ln_2);
  return result_25;
}

function startsWithStr_0_webzywwor1(s_3, pre_0) {
  forStmtLabel_0: {
    var result_26;
    var X60Qx_199 = len_4_sysvq0asl(s_3);
    var X60Qx_200 = len_4_sysvq0asl(pre_0);
    if ((X60Qx_199 < X60Qx_200)) {
      return false;
    }
    {
      whileStmtLabel_1: {
        var X60Qlf_20 = 0;
        var X60Qlf_21 = len_4_sysvq0asl(pre_0);
        var X60Qlf_22 = allocFixed(4);
        mem.setI32(X60Qlf_22, X60Qlf_20);
        {
          while ((mem.i32(X60Qlf_22) < X60Qlf_21)) {
            {
              var X60Qx_201 = getQ_9_sysvq0asl(s_3, mem.i32(X60Qlf_22));
              var X60Qx_202 = getQ_9_sysvq0asl(pre_0, mem.i32(X60Qlf_22));
              if ((!(X60Qx_201 === X60Qx_202))) {
                return false;
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_22);
          }
        }
      }
    }
  }
  result_26 = true;
  return result_26;
}

function acceptCand_0_webzywwor1(name_2, kind_2, prefix_0, names_0, kindNames_0, seen_0) {
  let X60Qx_203 = len_4_sysvq0asl(name_2);
  if ((X60Qx_203 === 0)) {
    return;
  }
  let X60QconstRefTemp_0 = allocFixed(16);
  mem.copy(X60QconstRefTemp_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936028414);
    mem.setU32((_o + 4), strlit_0_I2416437014800228590_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 8), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918988542);
    mem.setU32((_o + 4), strlit_0_I9792473688321036479_webzywwor1);
    return _o;
  })(), 8);
  let X60Qx_204 = allocFixed(8);
  mem.copy(X60Qx_204, toOpenArray_0_Il5czcd1_webzywwor1(X60QconstRefTemp_0), 8);
  let X60Qx_205 = among_0_webzywwor1(kind_2, X60Qx_204);
  if (X60Qx_205) {
    return;
  }
  let X60Qx_206;
  let X60Qx_207 = len_4_sysvq0asl(prefix_0);
  if ((0 < X60Qx_207)) {
    let X60Qx_208 = startsWithStr_0_webzywwor1(name_2, prefix_0);
    X60Qx_206 = (!X60Qx_208);
  } else {
    X60Qx_206 = false;
  }
  if (X60Qx_206) {
    return;
  }
  let X60Qx_209 = allocFixed(8);
  mem.copy(X60Qx_209, toOpenArray_1_I6b60gk1_webzywwor1(seen_0), 8);
  let X60Qx_210 = among_0_webzywwor1(name_2, X60Qx_209);
  if (X60Qx_210) {
    return;
  }
  let X60Qx_211 = allocFixed(8);
  mem.copy(X60Qx_211, nimStrDup(name_2), 8);
  add_0_Ig6072n_webzywwor1(seen_0, X60Qx_211);
  let X60Qx_212 = allocFixed(8);
  mem.copy(X60Qx_212, nimStrDup(name_2), 8);
  add_0_Ig6072n_webzywwor1(names_0, X60Qx_212);
  let X60Qx_213 = allocFixed(8);
  mem.copy(X60Qx_213, nimStrDup(kind_2), 8);
  add_0_Ig6072n_webzywwor1(kindNames_0, X60Qx_213);
}

function featCompletion_0_webzywwor1(decls_1, exportsArr_0, src_1, line_2, col_2) {
  forStmtLabel_13: {
    forStmtLabel_4: {
      forStmtLabel_2: {
        forStmtLabel_0: {
          var result_27 = allocFixed(8);
          nimStrWasMoved(result_27);
          var cap_0 = 200;
          var prefix_1 = allocFixed(8);
          mem.copy(prefix_1, prefixAt_0_webzywwor1(src_1, line_2, col_2), 8);
          var names_1 = allocFixed(8);
          mem.copy(names_1, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
          var kindNames_1 = allocFixed(8);
          mem.copy(kindNames_1, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
          var seen_1 = allocFixed(8);
          mem.copy(seen_1, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
          {
            whileStmtLabel_1: {
              var X60Qlf_23 = 0;
              var X60Qlf_24 = len_3_I92u5c2_webzywwor1(decls_1);
              var X60Qlf_25 = allocFixed(4);
              mem.setI32(X60Qlf_25, X60Qlf_23);
              {
                while ((mem.i32(X60Qlf_25) < X60Qlf_24)) {
                  {
                    var X60Qx_214 = getQ_7_Ixinnyx1_webzywwor1(decls_1, mem.i32(X60Qlf_25));
                    var X60Qx_215 = getQ_7_Ixinnyx1_webzywwor1(decls_1, mem.i32(X60Qlf_25));
                    acceptCand_0_webzywwor1((X60Qx_214 + 8), (X60Qx_215 + 16), prefix_1, names_1, kindNames_1, seen_1);
                  }
                  inc_1_I6wjjge_jsfc0lwq21(X60Qlf_25);
                }
              }
            }
          }
        }
        {
          whileStmtLabel_3: {
            var X60Qlf_26 = 0;
            var X60Qlf_27 = len_3_I92u5c2_webzywwor1(exportsArr_0);
            var X60Qlf_28 = allocFixed(4);
            mem.setI32(X60Qlf_28, X60Qlf_26);
            {
              while ((mem.i32(X60Qlf_28) < X60Qlf_27)) {
                {
                  var X60Qx_216 = getQ_7_Ixinnyx1_webzywwor1(exportsArr_0, mem.i32(X60Qlf_28));
                  var X60Qx_217 = getQ_7_Ixinnyx1_webzywwor1(exportsArr_0, mem.i32(X60Qlf_28));
                  acceptCand_0_webzywwor1((X60Qx_216 + 8), (X60Qx_217 + 16), prefix_1, names_1, kindNames_1, seen_1);
                }
                inc_1_I6wjjge_jsfc0lwq21(X60Qlf_28);
              }
            }
          }
        }
      }
      {
        whileStmtLabel_5: {
          var X60Qlf_29 = 0;
          var X60Qlf_30 = len_3_Ixq6taz_jsovezijp1(names_1);
          var X60Qlf_31 = allocFixed(4);
          mem.setI32(X60Qlf_31, X60Qlf_29);
          {
            while ((mem.i32(X60Qlf_31) < X60Qlf_30)) {
              {
                forStmtLabel_7: {
                  var X60Qii_6 = allocFixed(4);
                  mem.setI32(X60Qii_6, mem.i32(X60Qlf_31));
                  {
                    whileStmtLabel_8: {
                      var X60Qlf_32 = ((mem.i32(X60Qlf_31) + 1) | 0);
                      var X60Qlf_33 = len_3_Ixq6taz_jsovezijp1(names_1);
                      var X60Qlf_34 = allocFixed(4);
                      mem.setI32(X60Qlf_34, X60Qlf_32);
                      {
                        while ((mem.i32(X60Qlf_34) < X60Qlf_33)) {
                          {
                            var X60Qx_218 = getQ_7_Ir6d0tw_jsovezijp1(names_1, mem.i32(X60Qlf_34));
                            var X60Qx_219 = getQ_7_Ir6d0tw_jsovezijp1(names_1, mem.i32(X60Qii_6));
                            var X60Qx_220 = ltQ_17_sysvq0asl(X60Qx_218, X60Qx_219);
                            if (X60Qx_220) {
                              mem.setI32(X60Qii_6, mem.i32(X60Qlf_34));
                            }
                          }
                          inc_1_I6wjjge_jsfc0lwq21(X60Qlf_34);
                        }
                      }
                    }
                  }
                }
                if ((!(mem.i32(X60Qii_6) === mem.i32(X60Qlf_31)))) {
                  var X60Qx_221 = getQ_7_Ir6d0tw_jsovezijp1(names_1, mem.i32(X60Qlf_31));
                  var X60Qii_9 = allocFixed(8);
                  mem.copy(X60Qii_9, nimStrDup(X60Qx_221), 8);
                  var X60Qx_222 = getQ_7_Ir6d0tw_jsovezijp1(names_1, mem.i32(X60Qii_6));
                  var X60Qii_10 = allocFixed(8);
                  mem.copy(X60Qii_10, nimStrDup(X60Qx_222), 8);
                  var X60Qtmp_9 = allocFixed(8);
                  mem.copy(X60Qtmp_9, X60Qii_10, 8);
                  nimStrWasMoved(X60Qii_10);
                  putQ_7_Ild9iim_webzywwor1(names_1, mem.i32(X60Qlf_31), X60Qtmp_9);
                  var X60Qtmp_10 = allocFixed(8);
                  mem.copy(X60Qtmp_10, X60Qii_9, 8);
                  nimStrWasMoved(X60Qii_9);
                  putQ_7_Ild9iim_webzywwor1(names_1, mem.i32(X60Qii_6), X60Qtmp_10);
                  var X60Qx_223 = getQ_7_Ir6d0tw_jsovezijp1(kindNames_1, mem.i32(X60Qlf_31));
                  var X60Qii_11 = allocFixed(8);
                  mem.copy(X60Qii_11, nimStrDup(X60Qx_223), 8);
                  var X60Qx_224 = getQ_7_Ir6d0tw_jsovezijp1(kindNames_1, mem.i32(X60Qii_6));
                  var X60Qii_12 = allocFixed(8);
                  mem.copy(X60Qii_12, nimStrDup(X60Qx_224), 8);
                  var X60Qtmp_11 = allocFixed(8);
                  mem.copy(X60Qtmp_11, X60Qii_12, 8);
                  nimStrWasMoved(X60Qii_12);
                  putQ_7_Ild9iim_webzywwor1(kindNames_1, mem.i32(X60Qlf_31), X60Qtmp_11);
                  var X60Qtmp_12 = allocFixed(8);
                  mem.copy(X60Qtmp_12, X60Qii_11, 8);
                  nimStrWasMoved(X60Qii_11);
                  putQ_7_Ild9iim_webzywwor1(kindNames_1, mem.i32(X60Qii_6), X60Qtmp_12);
                  nimStrDestroy(X60Qii_12);
                  nimStrDestroy(X60Qii_11);
                  nimStrDestroy(X60Qii_10);
                  nimStrDestroy(X60Qii_9);
                }
              }
              inc_1_I6wjjge_jsfc0lwq21(X60Qlf_31);
            }
          }
        }
      }
    }
    var count_0 = len_3_Ixq6taz_jsovezijp1(names_1);
    if ((200 < count_0)) {
      count_0 = 200;
    }
    var items_0 = allocFixed(8);
    mem.setU32(items_0, 0);
    mem.setU32((items_0 + 4), 0);
    {
      whileStmtLabel_14: {
        var X60Qlf_35 = 0;
        var X60Qlf_36 = count_0;
        var X60Qlf_37 = allocFixed(4);
        mem.setI32(X60Qlf_37, X60Qlf_35);
        {
          while ((mem.i32(X60Qlf_37) < X60Qlf_36)) {
            {
              var X60Qx_225 = len_4_sysvq0asl(items_0);
              if ((0 < X60Qx_225)) {
                add_2_sysvq0asl(items_0, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_226 = getQ_7_Ir6d0tw_jsovezijp1(kindNames_1, mem.i32(X60Qlf_37));
              var X60Qii_15 = allocFixed(8);
              mem.copy(X60Qii_15, nimStrDup(X60Qx_226), 8);
              var X60Qx_227 = getQ_7_Ir6d0tw_jsovezijp1(names_1, mem.i32(X60Qlf_37));
              var X60Qdesugar_3 = allocFixed(8);
              mem.copy(X60Qdesugar_3, jStr_0_jsovezijp1(X60Qx_227), 8);
              var X60Qx_228 = getQ_7_Ir6d0tw_jsovezijp1(kindNames_1, mem.i32(X60Qlf_37));
              var X60Qx_229 = kindToLspCompletion_0_webzywwor1(X60Qx_228);
              var X60Qdesugar_4 = allocFixed(8);
              mem.copy(X60Qdesugar_4, dollarQ_2_sysvq0asl(X60Qx_229), 8);
              var X60Qdesugar_5 = allocFixed(8);
              mem.copy(X60Qdesugar_5, jStr_0_jsovezijp1(X60Qii_15), 8);
              var X60Qx_230 = len_4_sysvq0asl((() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1814199294);
                mem.setU32((_o + 4), strlit_0_I15316867318741875364_webzywwor1);
                return _o;
              })());
              var X60Qx_231 = len_4_sysvq0asl(X60Qdesugar_3);
              var X60Qx_232 = len_4_sysvq0asl((() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1797401854);
                mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                return _o;
              })());
              var X60Qx_233 = len_4_sysvq0asl(X60Qdesugar_4);
              var X60Qx_234 = len_4_sysvq0asl((() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1679961342);
                mem.setU32((_o + 4), strlit_0_I15034346453199474510_webzywwor1);
                return _o;
              })());
              var X60Qx_235 = len_4_sysvq0asl(X60Qdesugar_5);
              var X60Qx_236 = len_4_sysvq0asl((() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 32001);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              var X60Qdesugar_6 = allocFixed(8);
              mem.copy(X60Qdesugar_6, newStringOfCap_0_sysvq0asl(((((((((((((X60Qx_230 + X60Qx_231) | 0) + X60Qx_232) | 0) + X60Qx_233) | 0) + X60Qx_234) | 0) + X60Qx_235) | 0) + X60Qx_236) | 0)), 8);
              add_2_sysvq0asl(X60Qdesugar_6, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1814199294);
                mem.setU32((_o + 4), strlit_0_I15316867318741875364_webzywwor1);
                return _o;
              })());
              add_2_sysvq0asl(X60Qdesugar_6, X60Qdesugar_3);
              add_2_sysvq0asl(X60Qdesugar_6, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1797401854);
                mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                return _o;
              })());
              add_2_sysvq0asl(X60Qdesugar_6, X60Qdesugar_4);
              add_2_sysvq0asl(X60Qdesugar_6, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1679961342);
                mem.setU32((_o + 4), strlit_0_I15034346453199474510_webzywwor1);
                return _o;
              })());
              add_2_sysvq0asl(X60Qdesugar_6, X60Qdesugar_5);
              add_2_sysvq0asl(X60Qdesugar_6, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 32001);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              add_2_sysvq0asl(items_0, X60Qdesugar_6);
              nimStrDestroy(X60Qdesugar_6);
              nimStrDestroy(X60Qdesugar_5);
              nimStrDestroy(X60Qdesugar_4);
              nimStrDestroy(X60Qdesugar_3);
              nimStrDestroy(X60Qii_15);
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_37);
          }
        }
      }
    }
  }
  var X60Qx_237 = len_4_sysvq0asl((() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1763867646);
    mem.setU32((_o + 4), strlit_0_I15550449855501200948_webzywwor1);
    return _o;
  })());
  var X60Qx_238 = len_4_sysvq0asl(items_0);
  var X60Qx_239 = len_4_sysvq0asl((() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 8215810);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  var X60Qdesugar_7 = allocFixed(8);
  mem.copy(X60Qdesugar_7, newStringOfCap_0_sysvq0asl(((((X60Qx_237 + X60Qx_238) | 0) + X60Qx_239) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_7, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1763867646);
    mem.setU32((_o + 4), strlit_0_I15550449855501200948_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_7, items_0);
  add_2_sysvq0asl(X60Qdesugar_7, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 8215810);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_27);
  mem.copy(result_27, X60Qdesugar_7, 8);
  nimStrWasMoved(X60Qdesugar_7);
  nimStrDestroy(X60Qdesugar_7);
  nimStrDestroy(items_0);
  eQdestroy_1_Ivioh0a_jsovezijp1(seen_1);
  eQdestroy_1_Ivioh0a_jsovezijp1(kindNames_1);
  eQdestroy_1_Ivioh0a_jsovezijp1(names_1);
  nimStrDestroy(prefix_1);
  return result_27;
  nimStrDestroy(X60Qdesugar_7);
  nimStrDestroy(items_0);
  eQdestroy_1_Ivioh0a_jsovezijp1(seen_1);
  eQdestroy_1_Ivioh0a_jsovezijp1(kindNames_1);
  eQdestroy_1_Ivioh0a_jsovezijp1(names_1);
  nimStrDestroy(prefix_1);
  return result_27;
}

function severityOf_0_webzywwor1(kind_3) {
  let result_28;
  let X60Qx_9;
  let X60Qx_240 = eqQ_20_sysvq0asl(kind_3, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920091646);
    mem.setU32((_o + 4), strlit_0_I760353633621926664_webzywwor1);
    return _o;
  })());
  if (X60Qx_240) {
    X60Qx_9 = 1;
  } else {
    let X60Qx_241 = eqQ_20_sysvq0asl(kind_3, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1918982142);
      mem.setU32((_o + 4), strlit_0_I3435182806541496947_webzywwor1);
      return _o;
    })());
    if (X60Qx_241) {
      X60Qx_9 = 2;
    } else {
      let X60Qx_242 = eqQ_20_sysvq0asl(kind_3, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1852393726);
        mem.setU32((_o + 4), strlit_0_I9917056758390513862_webzywwor1);
        return _o;
      })());
      if (X60Qx_242) {
        X60Qx_9 = 4;
      } else {
        X60Qx_9 = 3;
      }
    }
  }
  result_28 = X60Qx_9;
  return result_28;
}

function knownKind_0_webzywwor1(k_1) {
  let result_29;
  let X60QconstRefTemp_0 = allocFixed(40);
  mem.copy(X60QconstRefTemp_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920091646);
    mem.setU32((_o + 4), strlit_0_I760353633621926664_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 8), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918982142);
    mem.setU32((_o + 4), strlit_0_I3435182806541496947_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 16), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634882814);
    mem.setU32((_o + 4), strlit_0_I4703750582038422824_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 24), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852393726);
    mem.setU32((_o + 4), strlit_0_I9917056758390513862_webzywwor1);
    return _o;
  })(), 8);
  mem.copy((X60QconstRefTemp_0 + 32), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1718503934);
    mem.setU32((_o + 4), strlit_0_I10048894405599300180_webzywwor1);
    return _o;
  })(), 8);
  let X60Qx_243 = allocFixed(8);
  mem.copy(X60Qx_243, toOpenArray_0_Iy5qy0w_webzywwor1(X60QconstRefTemp_0), 8);
  let X60Qx_244 = among_0_webzywwor1(k_1, X60Qx_243);
  result_29 = X60Qx_244;
  return result_29;
}

function strip2_0_webzywwor1(s_4) {
  whileStmtLabel_1: {
    whileStmtLabel_0: {
      var result_30 = allocFixed(8);
      nimStrWasMoved(result_30);
      var a_3 = allocFixed(4);
      mem.setI32(a_3, 0);
      var X60Qx_245 = len_4_sysvq0asl(s_4);
      var b_2 = allocFixed(4);
      mem.setI32(b_2, ((X60Qx_245 - 1) | 0));
      {
        while (true) {
          var X60Qx_246;
          if ((mem.i32(a_3) <= mem.i32(b_2))) {
            var X60Qx_247;
            var X60Qx_248 = getQ_9_sysvq0asl(s_4, mem.i32(a_3));
            if ((X60Qx_248 === 32)) {
              X60Qx_247 = true;
            } else {
              var X60Qx_249 = getQ_9_sysvq0asl(s_4, mem.i32(a_3));
              X60Qx_247 = (X60Qx_249 === 9);
            }
            X60Qx_246 = X60Qx_247;
          } else {
            X60Qx_246 = false;
          }
          if (X60Qx_246) {
            inc_1_I6wjjge_jsfc0lwq21(a_3);
          } else {
            break;
          }
        }
      }
    }
    {
      while (true) {
        var X60Qx_250;
        if ((mem.i32(a_3) <= mem.i32(b_2))) {
          var X60Qx_251;
          var X60Qx_252 = getQ_9_sysvq0asl(s_4, mem.i32(b_2));
          if ((X60Qx_252 === 32)) {
            X60Qx_251 = true;
          } else {
            var X60Qx_253 = getQ_9_sysvq0asl(s_4, mem.i32(b_2));
            X60Qx_251 = (X60Qx_253 === 9);
          }
          X60Qx_250 = X60Qx_251;
        } else {
          X60Qx_250 = false;
        }
        if (X60Qx_250) {
          dec_1_I0nzoz91_sysvq0asl(b_2);
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_10 = allocFixed(8);
  nimStrWasMoved(X60Qx_10);
  if ((mem.i32(b_2) < mem.i32(a_3))) {
    nimStrDestroy(X60Qx_10);
    mem.copy(X60Qx_10, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    nimStrDestroy(X60Qx_10);
    var X60Qx_254 = allocFixed(8);
    mem.copy(X60Qx_254, substr_0_sysvq0asl(s_4, mem.i32(a_3), mem.i32(b_2)), 8);
    mem.copy(X60Qx_10, X60Qx_254, 8);
  }
  nimStrDestroy(result_30);
  mem.copy(result_30, X60Qx_10, 8);
  nimStrWasMoved(X60Qx_10);
  nimStrDestroy(X60Qx_10);
  return result_30;
  nimStrDestroy(X60Qx_10);
  return result_30;
}

function findCh_0_webzywwor1(s_5, c_2) {
  forStmtLabel_0: {
    var result_31;
    {
      whileStmtLabel_1: {
        var X60Qlf_38 = 0;
        var X60Qlf_39 = len_4_sysvq0asl(s_5);
        var X60Qlf_40 = allocFixed(4);
        mem.setI32(X60Qlf_40, X60Qlf_38);
        {
          while ((mem.i32(X60Qlf_40) < X60Qlf_39)) {
            {
              var X60Qx_255 = getQ_9_sysvq0asl(s_5, mem.i32(X60Qlf_40));
              if ((X60Qx_255 === c_2)) {
                return mem.i32(X60Qlf_40);
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_40);
          }
        }
      }
    }
  }
  result_31 = -1;
  return result_31;
}

function parseIntTrim_0_webzywwor1(s_6, ok_0) {
  whileStmtLabel_1: {
    whileStmtLabel_0: {
      var result_32;
      var v_5 = 0;
      var any_1 = false;
      var i_20 = allocFixed(4);
      mem.setI32(i_20, 0);
      {
        while (true) {
          var X60Qx_256;
          var X60Qx_257 = len_4_sysvq0asl(s_6);
          if ((mem.i32(i_20) < X60Qx_257)) {
            var X60Qx_258;
            var X60Qx_259 = getQ_9_sysvq0asl(s_6, mem.i32(i_20));
            if ((X60Qx_259 === 32)) {
              X60Qx_258 = true;
            } else {
              var X60Qx_260 = getQ_9_sysvq0asl(s_6, mem.i32(i_20));
              X60Qx_258 = (X60Qx_260 === 9);
            }
            X60Qx_256 = X60Qx_258;
          } else {
            X60Qx_256 = false;
          }
          if (X60Qx_256) {
            inc_1_I6wjjge_jsfc0lwq21(i_20);
          } else {
            break;
          }
        }
      }
    }
    {
      while (true) {
        var X60Qx_261;
        var X60Qx_262;
        var X60Qx_263 = len_4_sysvq0asl(s_6);
        if ((mem.i32(i_20) < X60Qx_263)) {
          var X60Qx_264 = getQ_9_sysvq0asl(s_6, mem.i32(i_20));
          X60Qx_262 = (48 <= X60Qx_264);
        } else {
          X60Qx_262 = false;
        }
        if (X60Qx_262) {
          var X60Qx_265 = getQ_9_sysvq0asl(s_6, mem.i32(i_20));
          X60Qx_261 = (X60Qx_265 <= 57);
        } else {
          X60Qx_261 = false;
        }
        if (X60Qx_261) {
          var X60Qx_266 = getQ_9_sysvq0asl(s_6, mem.i32(i_20));
          v_5 = ((Math.imul(v_5, 10) + ((X60Qx_266 - 48) | 0)) | 0);
          any_1 = true;
          inc_1_I6wjjge_jsfc0lwq21(i_20);
        } else {
          break;
        }
      }
    }
  }
  mem.setU8(ok_0, any_1);
  result_32 = v_5;
  return result_32;
}

function featDiagnostics_0_webzywwor1(raw_0) {
  forStmtLabel_3: {
    whileStmtLabel_0: {
      var result_33 = allocFixed(8);
      nimStrWasMoved(result_33);
      var parts_1 = allocFixed(8);
      mem.copy(parts_1, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
      var idx_0 = allocFixed(4);
      mem.setI32(idx_0, 0);
      {
        while (true) {
          var X60Qx_267 = len_4_sysvq0asl(raw_0);
          if ((mem.i32(idx_0) <= X60Qx_267)) {
            continueLabel_1: {
              {
                whileStmtLabel_2: {
                  var start_1 = mem.i32(idx_0);
                  {
                    while (true) {
                      var X60Qx_268;
                      var X60Qx_269 = len_4_sysvq0asl(raw_0);
                      if ((mem.i32(idx_0) < X60Qx_269)) {
                        var X60Qx_270 = getQ_9_sysvq0asl(raw_0, mem.i32(idx_0));
                        X60Qx_268 = (!(X60Qx_270 === 10));
                      } else {
                        X60Qx_268 = false;
                      }
                      if (X60Qx_268) {
                        inc_1_I6wjjge_jsfc0lwq21(idx_0);
                      } else {
                        break;
                      }
                    }
                  }
                }
                var e_3 = allocFixed(4);
                mem.setI32(e_3, mem.i32(idx_0));
                var X60Qx_271;
                if ((start_1 < mem.i32(e_3))) {
                  var X60Qx_272 = getQ_9_sysvq0asl(raw_0, ((mem.i32(e_3) - 1) | 0));
                  X60Qx_271 = (X60Qx_272 === 13);
                } else {
                  X60Qx_271 = false;
                }
                if (X60Qx_271) {
                  dec_1_I0nzoz91_sysvq0asl(e_3);
                }
                var X60Qtmp_13 = allocFixed(8);
                mem.copy(X60Qtmp_13, substr_0_sysvq0asl(raw_0, start_1, ((mem.i32(e_3) - 1) | 0)), 8);
                var line_8 = allocFixed(8);
                mem.copy(line_8, strip2_0_webzywwor1(X60Qtmp_13), 8);
                inc_1_I6wjjge_jsfc0lwq21(idx_0);
                var X60Qx_273 = len_4_sysvq0asl(line_8);
                if ((X60Qx_273 === 0)) {
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var X60Qx_274;
                var X60Qx_275 = startsWithStr_0_webzywwor1(line_8, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1229014782);
                  mem.setU32((_o + 4), strlit_0_I10214127303718134010_webzywwor1);
                  return _o;
                })());
                if (X60Qx_275) {
                  X60Qx_274 = true;
                } else {
                  var X60Qx_276 = startsWithStr_0_webzywwor1(line_8, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1129665534);
                    mem.setU32((_o + 4), strlit_0_I6506901919141277424_webzywwor1);
                    return _o;
                  })());
                  X60Qx_274 = X60Qx_276;
                }
                if (X60Qx_274) {
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var lp_0 = findCh_0_webzywwor1(line_8, 40);
                if ((lp_0 <= 0)) {
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var rp_0 = findCh_0_webzywwor1(line_8, 41);
                var X60Qx_277;
                if ((rp_0 < 0)) {
                  X60Qx_277 = true;
                } else {
                  X60Qx_277 = (rp_0 < lp_0);
                }
                if (X60Qx_277) {
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var inside_0 = allocFixed(8);
                mem.copy(inside_0, substr_0_sysvq0asl(line_8, ((lp_0 + 1) | 0), ((rp_0 - 1) | 0)), 8);
                var comma_0 = findCh_0_webzywwor1(inside_0, 44);
                if ((comma_0 < 0)) {
                  nimStrDestroy(inside_0);
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var ok1_0 = allocFixed(1);
                mem.setU8(ok1_0, false);
                var ok2_0 = allocFixed(1);
                mem.setU8(ok2_0, false);
                var X60Qtmp_14 = allocFixed(8);
                mem.copy(X60Qtmp_14, substr_0_sysvq0asl(inside_0, 0, ((comma_0 - 1) | 0)), 8);
                var lno_0 = parseIntTrim_0_webzywwor1(X60Qtmp_14, ok1_0);
                var X60Qx_278 = len_4_sysvq0asl(inside_0);
                var X60Qtmp_15 = allocFixed(8);
                mem.copy(X60Qtmp_15, substr_0_sysvq0asl(inside_0, ((comma_0 + 1) | 0), ((X60Qx_278 - 1) | 0)), 8);
                var cno_0 = parseIntTrim_0_webzywwor1(X60Qtmp_15, ok2_0);
                var X60Qx_279;
                if (mem.u8At(ok1_0)) {
                  X60Qx_279 = mem.u8At(ok2_0);
                } else {
                  X60Qx_279 = false;
                }
                if ((!X60Qx_279)) {
                  nimStrDestroy(X60Qtmp_15);
                  nimStrDestroy(X60Qtmp_14);
                  nimStrDestroy(inside_0);
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var X60Qx_280 = len_4_sysvq0asl(line_8);
                var X60Qtmp_16 = allocFixed(8);
                mem.copy(X60Qtmp_16, substr_0_sysvq0asl(line_8, ((rp_0 + 1) | 0), ((X60Qx_280 - 1) | 0)), 8);
                var rest_0 = allocFixed(8);
                mem.copy(rest_0, strip2_0_webzywwor1(X60Qtmp_16), 8);
                var colon_0 = findCh_0_webzywwor1(rest_0, 58);
                if ((colon_0 < 0)) {
                  nimStrDestroy(rest_0);
                  nimStrDestroy(X60Qtmp_16);
                  nimStrDestroy(X60Qtmp_15);
                  nimStrDestroy(X60Qtmp_14);
                  nimStrDestroy(inside_0);
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var X60Qtmp_17 = allocFixed(8);
                mem.copy(X60Qtmp_17, substr_0_sysvq0asl(rest_0, 0, ((colon_0 - 1) | 0)), 8);
                var kind_4 = allocFixed(8);
                mem.copy(kind_4, strip2_0_webzywwor1(X60Qtmp_17), 8);
                var X60Qx_281 = knownKind_0_webzywwor1(kind_4);
                if ((!X60Qx_281)) {
                  nimStrDestroy(kind_4);
                  nimStrDestroy(X60Qtmp_17);
                  nimStrDestroy(rest_0);
                  nimStrDestroy(X60Qtmp_16);
                  nimStrDestroy(X60Qtmp_15);
                  nimStrDestroy(X60Qtmp_14);
                  nimStrDestroy(inside_0);
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var X60Qx_282 = eqQ_20_sysvq0asl(kind_4, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1634882814);
                  mem.setU32((_o + 4), strlit_0_I4703750582038422824_webzywwor1);
                  return _o;
                })());
                if (X60Qx_282) {
                  nimStrDestroy(kind_4);
                  nimStrDestroy(X60Qtmp_17);
                  nimStrDestroy(rest_0);
                  nimStrDestroy(X60Qtmp_16);
                  nimStrDestroy(X60Qtmp_15);
                  nimStrDestroy(X60Qtmp_14);
                  nimStrDestroy(inside_0);
                  nimStrDestroy(line_8);
                  nimStrDestroy(X60Qtmp_13);
                  break continueLabel_1;
                }
                var X60Qx_283 = len_4_sysvq0asl(rest_0);
                var X60Qtmp_18 = allocFixed(8);
                mem.copy(X60Qtmp_18, substr_0_sysvq0asl(rest_0, ((colon_0 + 1) | 0), ((X60Qx_283 - 1) | 0)), 8);
                var msg_0 = allocFixed(8);
                mem.copy(msg_0, strip2_0_webzywwor1(X60Qtmp_18), 8);
                var X60Qx_11;
                if ((0 < ((lno_0 - 1) | 0))) {
                  X60Qx_11 = ((lno_0 - 1) | 0);
                } else {
                  X60Qx_11 = 0;
                }
                var l0_0 = X60Qx_11;
                var X60Qx_12;
                if ((0 < ((cno_0 - 1) | 0))) {
                  X60Qx_12 = ((cno_0 - 1) | 0);
                } else {
                  X60Qx_12 = 0;
                }
                var c0_0 = X60Qx_12;
                var rng_0 = allocFixed(16);
                mem.copy(rng_0, mkRange_0_pro4b75yb(l0_0, c0_0, l0_0, cno_0), 16);
                var X60Qdesugar_8 = allocFixed(8);
                mem.copy(X60Qdesugar_8, rangeJson_0_pro4b75yb(rng_0), 8);
                var X60Qx_284 = severityOf_0_webzywwor1(kind_4);
                var X60Qdesugar_9 = allocFixed(8);
                mem.copy(X60Qdesugar_9, dollarQ_2_sysvq0asl(X60Qx_284), 8);
                var X60Qdesugar_10 = allocFixed(8);
                mem.copy(X60Qdesugar_10, jStr_0_jsovezijp1(msg_0), 8);
                var X60Qx_285 = len_4_sysvq0asl((() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1914862590);
                  mem.setU32((_o + 4), strlit_0_I1189048991431722821_pro4b75yb);
                  return _o;
                })());
                var X60Qx_286 = len_4_sysvq0asl(X60Qdesugar_8);
                var X60Qx_287 = len_4_sysvq0asl((() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1931619582);
                  mem.setU32((_o + 4), strlit_0_I4223485871286820833_pro4b75yb);
                  return _o;
                })());
                var X60Qx_288 = len_4_sysvq0asl(X60Qdesugar_9);
                var X60Qx_289 = len_4_sysvq0asl((() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1931619582);
                  mem.setU32((_o + 4), strlit_0_I13499277119623524076_webzywwor1);
                  return _o;
                })());
                var X60Qx_290 = len_4_sysvq0asl(X60Qdesugar_10);
                var X60Qx_291 = len_4_sysvq0asl((() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 32001);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                var X60Qdesugar_11 = allocFixed(8);
                mem.copy(X60Qdesugar_11, newStringOfCap_0_sysvq0asl(((((((((((((X60Qx_285 + X60Qx_286) | 0) + X60Qx_287) | 0) + X60Qx_288) | 0) + X60Qx_289) | 0) + X60Qx_290) | 0) + X60Qx_291) | 0)), 8);
                add_2_sysvq0asl(X60Qdesugar_11, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1914862590);
                  mem.setU32((_o + 4), strlit_0_I1189048991431722821_pro4b75yb);
                  return _o;
                })());
                add_2_sysvq0asl(X60Qdesugar_11, X60Qdesugar_8);
                add_2_sysvq0asl(X60Qdesugar_11, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1931619582);
                  mem.setU32((_o + 4), strlit_0_I4223485871286820833_pro4b75yb);
                  return _o;
                })());
                add_2_sysvq0asl(X60Qdesugar_11, X60Qdesugar_9);
                add_2_sysvq0asl(X60Qdesugar_11, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1931619582);
                  mem.setU32((_o + 4), strlit_0_I13499277119623524076_webzywwor1);
                  return _o;
                })());
                add_2_sysvq0asl(X60Qdesugar_11, X60Qdesugar_10);
                add_2_sysvq0asl(X60Qdesugar_11, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 32001);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                var X60Qtmp_19 = allocFixed(8);
                mem.copy(X60Qtmp_19, X60Qdesugar_11, 8);
                nimStrWasMoved(X60Qdesugar_11);
                add_0_Ig6072n_webzywwor1(parts_1, X60Qtmp_19);
                nimStrDestroy(X60Qdesugar_11);
                nimStrDestroy(X60Qdesugar_10);
                nimStrDestroy(X60Qdesugar_9);
                nimStrDestroy(X60Qdesugar_8);
                nimStrDestroy(msg_0);
                nimStrDestroy(X60Qtmp_18);
                nimStrDestroy(kind_4);
                nimStrDestroy(X60Qtmp_17);
                nimStrDestroy(rest_0);
                nimStrDestroy(X60Qtmp_16);
                nimStrDestroy(X60Qtmp_15);
                nimStrDestroy(X60Qtmp_14);
                nimStrDestroy(inside_0);
                nimStrDestroy(line_8);
                nimStrDestroy(X60Qtmp_13);
              }
            }
          } else {
            break;
          }
        }
      }
    }
    nimStrDestroy(result_33);
    mem.copy(result_33, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_4: {
        var X60Qlf_41 = 0;
        var X60Qlf_42 = len_3_Ixq6taz_jsovezijp1(parts_1);
        var X60Qlf_43 = allocFixed(4);
        mem.setI32(X60Qlf_43, X60Qlf_41);
        {
          while ((mem.i32(X60Qlf_43) < X60Qlf_42)) {
            {
              if ((0 < mem.i32(X60Qlf_43))) {
                add_2_sysvq0asl(result_33, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_292 = getQ_7_Ir6d0tw_jsovezijp1(parts_1, mem.i32(X60Qlf_43));
              add_2_sysvq0asl(result_33, X60Qx_292);
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_43);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_33, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  eQdestroy_1_Ivioh0a_jsovezijp1(parts_1);
  return result_33;
  eQdestroy_1_Ivioh0a_jsovezijp1(parts_1);
  return result_33;
}

function declCoveringCursor_0_webzywwor1(decls_2, line_3, col_3) {
  forStmtLabel_0: {
    var result_34;
    {
      whileStmtLabel_1: {
        var X60Qlf_44 = 0;
        var X60Qlf_45 = len_3_I92u5c2_webzywwor1(decls_2);
        var X60Qlf_46 = allocFixed(4);
        mem.setI32(X60Qlf_46, X60Qlf_44);
        {
          while ((mem.i32(X60Qlf_46) < X60Qlf_45)) {
            {
              continueLabel_2: {
                {
                  var X60Qx_293 = getQ_7_Ixinnyx1_webzywwor1(decls_2, mem.i32(X60Qlf_46));
                  var X60QconstRefTemp_0 = allocFixed(44);
                  mem.copy(X60QconstRefTemp_0, X60Qx_293, 44);
                  var X60Qii_3 = allocFixed(44);
                  mem.copy(X60Qii_3, eQdupQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60QconstRefTemp_0), 44);
                  if ((!mem.u8At((X60Qii_3 + 40)))) {
                    eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                    break continueLabel_2;
                  }
                  var X60Qx_13;
                  if ((0 < mem.i32((X60Qii_3 + 32)))) {
                    X60Qx_13 = ((mem.i32((X60Qii_3 + 32)) - 1) | 0);
                  } else {
                    X60Qx_13 = 0;
                  }
                  var X60Qii_4 = allocFixed(4);
                  mem.setI32(X60Qii_4, X60Qx_13);
                  if ((!(mem.i32(X60Qii_4) === line_3))) {
                    eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                    break continueLabel_2;
                  }
                  var X60Qx_294;
                  if ((mem.i32((X60Qii_3 + 36)) <= col_3)) {
                    var X60Qx_295 = len_4_sysvq0asl((X60Qii_3 + 8));
                    X60Qx_294 = (col_3 <= ((mem.i32((X60Qii_3 + 36)) + X60Qx_295) | 0));
                  } else {
                    X60Qx_294 = false;
                  }
                  if (X60Qx_294) {
                    eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                    return mem.i32(X60Qlf_46);
                  }
                  eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                }
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_46);
          }
        }
      }
    }
  }
  result_34 = -1;
  return result_34;
}

function renderFor_0_webzywwor1(renderJs_0, name_3) {
  forStmtLabel_0: {
    var result_35 = allocFixed(8);
    nimStrWasMoved(result_35);
    var X60Qx_296 = len_4_sysvq0asl(renderJs_0);
    if ((X60Qx_296 === 0)) {
      return (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })();
    }
    var root_2 = parseJsonStr_0_webzywwor1(renderJs_0);
    if ((!(mem.u8At((root_2 + 4)) === 5))) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_2);
      return (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })();
    }
    var nodes_0 = field_0_webzywwor1(root_2, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1685024510);
      mem.setU32((_o + 4), strlit_0_I15476970270088161742_webzywwor1);
      return _o;
    })());
    var X60Qx_297;
    if ((nodes_0 === 0)) {
      X60Qx_297 = true;
    } else {
      X60Qx_297 = (!(mem.u8At((nodes_0 + 4)) === 4));
    }
    if (X60Qx_297) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(nodes_0);
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_2);
      return (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })();
    }
    {
      whileStmtLabel_1: {
        var X60Qlf_47 = 0;
        var X60Qlf_48 = len_3_I1yvahf1_webzywwor1(((nodes_0 + 4) + 20));
        var X60Qlf_49 = allocFixed(4);
        mem.setI32(X60Qlf_49, X60Qlf_47);
        {
          while ((mem.i32(X60Qlf_49) < X60Qlf_48)) {
            {
              continueLabel_2: {
                {
                  var X60Qx_298 = getQ_7_Imk9l7s_webzywwor1(((nodes_0 + 4) + 20), mem.i32(X60Qlf_49));
                  var X60Qii_3 = allocFixed(4);
                  mem.setU32(X60Qii_3, eQdupQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qx_298)));
                  if ((!(mem.u8At((mem.u32(X60Qii_3) + 4)) === 5))) {
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                    break continueLabel_2;
                  }
                  var X60Qtmp_20 = allocFixed(8);
                  mem.copy(X60Qtmp_20, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1835101950);
                    mem.setU32((_o + 4), strlit_0_I407209193152762291_webzywwor1);
                    return _o;
                  })()), 8);
                  var X60Qx_299 = eqQ_20_sysvq0asl(X60Qtmp_20, name_3);
                  if (X60Qx_299) {
                    var X60Qx_300 = allocFixed(8);
                    mem.copy(X60Qx_300, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1852142334);
                      mem.setU32((_o + 4), strlit_0_I11225201594490725231_webzywwor1);
                      return _o;
                    })()), 8);
                    mem.copy(result_35, X60Qx_300, 8);
                    nimStrDestroy(X60Qtmp_20);
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(nodes_0);
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_2);
                    return result_35;
                  }
                  nimStrDestroy(X60Qtmp_20);
                  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                }
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_49);
          }
        }
      }
    }
  }
  nimStrDestroy(result_35);
  mem.copy(result_35, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(nodes_0);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_2);
  return result_35;
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(nodes_0);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_2);
  return result_35;
}

function featHover_0_webzywwor1(decls_3, renderJs_1, line_4, col_4) {
  let result_36 = allocFixed(8);
  nimStrWasMoved(result_36);
  let di_0 = declCoveringCursor_0_webzywwor1(decls_3, line_4, col_4);
  if ((di_0 < 0)) {
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1819635454);
      mem.setU32((_o + 4), strlit_0_I1659971858173592857_webzywwor1);
      return _o;
    })();
  }
  let X60Qx_301 = getQ_7_Ixinnyx1_webzywwor1(decls_3, di_0);
  let X60QconstRefTemp_0 = allocFixed(44);
  mem.copy(X60QconstRefTemp_0, X60Qx_301, 44);
  let r_2 = allocFixed(44);
  mem.copy(r_2, eQdupQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60QconstRefTemp_0), 44);
  let body_0 = allocFixed(8);
  mem.copy(body_0, renderFor_0_webzywwor1(renderJs_1, (r_2 + 8)), 8);
  let X60Qx_302 = len_4_sysvq0asl(body_0);
  if ((X60Qx_302 === 0)) {
    let X60Qx_14 = allocFixed(8);
    nimStrWasMoved(X60Qx_14);
    let X60Qx_303 = len_4_sysvq0asl((r_2 + 16));
    if ((0 < X60Qx_303)) {
      nimStrDestroy(X60Qx_14);
      let X60Qx_304 = allocFixed(8);
      mem.copy(X60Qx_304, ampQ_0_sysvq0asl((r_2 + 16), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 8193);
        mem.setU32((_o + 4), 0);
        return _o;
      })()), 8);
      mem.copy(X60Qx_14, X60Qx_304, 8);
    } else {
      nimStrDestroy(X60Qx_14);
      mem.copy(X60Qx_14, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
    }
    nimStrDestroy(body_0);
    let X60Qx_305 = allocFixed(8);
    mem.copy(X60Qx_305, ampQ_0_sysvq0asl(X60Qx_14, (r_2 + 8)), 8);
    mem.copy(body_0, X60Qx_305, 8);
    nimStrDestroy(X60Qx_14);
  }
  let X60Qx_306 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1616929022);
    mem.setU32((_o + 4), strlit_0_I3366673755822186275_webzywwor1);
    return _o;
  })());
  let X60Qx_307 = len_4_sysvq0asl(body_0);
  let X60Qx_308 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1616907006);
    mem.setU32((_o + 4), strlit_0_I2639620712813615915_webzywwor1);
    return _o;
  })());
  let X60Qdesugar_12 = allocFixed(8);
  mem.copy(X60Qdesugar_12, newStringOfCap_0_sysvq0asl(((((X60Qx_306 + X60Qx_307) | 0) + X60Qx_308) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_12, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1616929022);
    mem.setU32((_o + 4), strlit_0_I3366673755822186275_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_12, body_0);
  add_2_sysvq0asl(X60Qdesugar_12, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1616907006);
    mem.setU32((_o + 4), strlit_0_I2639620712813615915_webzywwor1);
    return _o;
  })());
  let value_1 = allocFixed(8);
  mem.copy(value_1, X60Qdesugar_12, 8);
  nimStrWasMoved(X60Qdesugar_12);
  let X60Qx_15;
  if ((0 < mem.i32((r_2 + 32)))) {
    X60Qx_15 = ((mem.i32((r_2 + 32)) - 1) | 0);
  } else {
    X60Qx_15 = 0;
  }
  let dl_1 = X60Qx_15;
  let X60Qx_309 = len_4_sysvq0asl((r_2 + 8));
  let X60Qx_310 = allocFixed(16);
  mem.copy(X60Qx_310, mkRange_0_pro4b75yb(dl_1, mem.i32((r_2 + 36)), dl_1, ((mem.i32((r_2 + 36)) + X60Qx_309) | 0)), 16);
  let rng_1 = allocFixed(8);
  mem.copy(rng_1, rangeJson_0_pro4b75yb(X60Qx_310), 8);
  let X60Qdesugar_13 = allocFixed(8);
  mem.copy(X60Qdesugar_13, jStr_0_jsovezijp1(value_1), 8);
  let X60Qx_311 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663204350);
    mem.setU32((_o + 4), strlit_0_I9921765204933000296_webzywwor1);
    return _o;
  })());
  let X60Qx_312 = len_4_sysvq0asl(X60Qdesugar_13);
  let X60Qx_313 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 573341182);
    mem.setU32((_o + 4), strlit_0_I484636834144799291_webzywwor1);
    return _o;
  })());
  let X60Qx_314 = len_4_sysvq0asl(rng_1);
  let X60Qx_315 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_14 = allocFixed(8);
  mem.copy(X60Qdesugar_14, newStringOfCap_0_sysvq0asl(((((((((X60Qx_311 + X60Qx_312) | 0) + X60Qx_313) | 0) + X60Qx_314) | 0) + X60Qx_315) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_14, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1663204350);
    mem.setU32((_o + 4), strlit_0_I9921765204933000296_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_14, X60Qdesugar_13);
  add_2_sysvq0asl(X60Qdesugar_14, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 573341182);
    mem.setU32((_o + 4), strlit_0_I484636834144799291_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_14, rng_1);
  add_2_sysvq0asl(X60Qdesugar_14, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_36);
  mem.copy(result_36, X60Qdesugar_14, 8);
  nimStrWasMoved(X60Qdesugar_14);
  nimStrDestroy(X60Qdesugar_14);
  nimStrDestroy(X60Qdesugar_13);
  nimStrDestroy(rng_1);
  nimStrDestroy(value_1);
  nimStrDestroy(X60Qdesugar_12);
  nimStrDestroy(body_0);
  eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(r_2);
  return result_36;
  nimStrDestroy(X60Qdesugar_14);
  nimStrDestroy(X60Qdesugar_13);
  nimStrDestroy(rng_1);
  nimStrDestroy(value_1);
  nimStrDestroy(X60Qdesugar_12);
  nimStrDestroy(body_0);
  eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(r_2);
  return result_36;
}

function symAtCursor_0_webzywwor1(decls_4, calls_0, line_5, col_5, isDecl_0) {
  forStmtLabel_0: {
    var result_37 = allocFixed(8);
    nimStrWasMoved(result_37);
    {
      whileStmtLabel_1: {
        var X60Qlf_50 = 0;
        var X60Qlf_51 = len_3_I4blgsl1_webzywwor1(calls_0);
        var X60Qlf_52 = allocFixed(4);
        mem.setI32(X60Qlf_52, X60Qlf_50);
        {
          while ((mem.i32(X60Qlf_52) < X60Qlf_51)) {
            {
              continueLabel_2: {
                {
                  var X60Qx_316 = getQ_7_I7xfifm1_webzywwor1(calls_0, mem.i32(X60Qlf_52));
                  var X60QconstRefTemp_0 = allocFixed(36);
                  mem.copy(X60QconstRefTemp_0, X60Qx_316, 36);
                  var X60Qii_3 = allocFixed(36);
                  mem.copy(X60Qii_3, eQdupQ_SX43allX52ec0webzywwor1_0_webzywwor1(X60QconstRefTemp_0), 36);
                  if ((!mem.u8At((X60Qii_3 + 32)))) {
                    eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                    break continueLabel_2;
                  }
                  var X60Qx_16;
                  if ((0 < mem.i32((X60Qii_3 + 24)))) {
                    X60Qx_16 = ((mem.i32((X60Qii_3 + 24)) - 1) | 0);
                  } else {
                    X60Qx_16 = 0;
                  }
                  var X60Qii_4 = allocFixed(4);
                  mem.setI32(X60Qii_4, X60Qx_16);
                  if ((!(mem.i32(X60Qii_4) === line_5))) {
                    eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                    break continueLabel_2;
                  }
                  var X60Qii_5 = allocFixed(8);
                  mem.copy(X60Qii_5, symBase_0_webzywwor1((X60Qii_3 + 8)), 8);
                  var X60Qx_317;
                  if ((mem.i32((X60Qii_3 + 28)) <= col_5)) {
                    var X60Qx_318 = len_4_sysvq0asl(X60Qii_5);
                    X60Qx_317 = (col_5 <= ((mem.i32((X60Qii_3 + 28)) + X60Qx_318) | 0));
                  } else {
                    X60Qx_317 = false;
                  }
                  if (X60Qx_317) {
                    mem.setU8(isDecl_0, false);
                    var X60Qtmp_21 = allocFixed(8);
                    mem.copy(X60Qtmp_21, (X60Qii_3 + 8), 8);
                    nimStrWasMoved((X60Qii_3 + 8));
                    mem.copy(result_37, X60Qtmp_21, 8);
                    nimStrDestroy(X60Qii_5);
                    eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                    return result_37;
                  }
                  nimStrDestroy(X60Qii_5);
                  eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1(X60Qii_3);
                }
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_52);
          }
        }
      }
    }
  }
  var di_1 = declCoveringCursor_0_webzywwor1(decls_4, line_5, col_5);
  if ((0 <= di_1)) {
    mem.setU8(isDecl_0, true);
    var X60Qx_319 = getQ_7_Ixinnyx1_webzywwor1(decls_4, di_1);
    var X60Qx_320 = allocFixed(8);
    mem.copy(X60Qx_320, nimStrDup(X60Qx_319), 8);
    mem.copy(result_37, X60Qx_320, 8);
    return result_37;
  }
  mem.setU8(isDecl_0, false);
  nimStrDestroy(result_37);
  mem.copy(result_37, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  return result_37;
}

function declLocationOf_0_webzywwor1(decls_5, sym_1) {
  forStmtLabel_0: {
    var result_38 = allocFixed(8);
    nimStrWasMoved(result_38);
    {
      whileStmtLabel_1: {
        var X60Qlf_53 = 0;
        var X60Qlf_54 = len_3_I92u5c2_webzywwor1(decls_5);
        var X60Qlf_55 = allocFixed(4);
        mem.setI32(X60Qlf_55, X60Qlf_53);
        {
          while ((mem.i32(X60Qlf_55) < X60Qlf_54)) {
            {
              var X60Qx_321;
              var X60Qx_322 = getQ_7_Ixinnyx1_webzywwor1(decls_5, mem.i32(X60Qlf_55));
              var X60Qx_323 = eqQ_20_sysvq0asl(X60Qx_322, sym_1);
              if (X60Qx_323) {
                var X60Qx_324 = getQ_7_Ixinnyx1_webzywwor1(decls_5, mem.i32(X60Qlf_55));
                X60Qx_321 = mem.u8At((X60Qx_324 + 40));
              } else {
                X60Qx_321 = false;
              }
              if (X60Qx_321) {
                var X60Qx_325 = getQ_7_Ixinnyx1_webzywwor1(decls_5, mem.i32(X60Qlf_55));
                var X60QconstRefTemp_0 = allocFixed(44);
                mem.copy(X60QconstRefTemp_0, X60Qx_325, 44);
                var X60Qii_2 = allocFixed(44);
                mem.copy(X60Qii_2, eQdupQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60QconstRefTemp_0), 44);
                var X60Qx_17;
                if ((0 < mem.i32((X60Qii_2 + 32)))) {
                  X60Qx_17 = ((mem.i32((X60Qii_2 + 32)) - 1) | 0);
                } else {
                  X60Qx_17 = 0;
                }
                var X60Qii_3 = allocFixed(4);
                mem.setI32(X60Qii_3, X60Qx_17);
                var X60Qx_326 = allocFixed(8);
                mem.copy(X60Qx_326, pathToUri_0_urim2dvcg1((X60Qii_2 + 24)), 8);
                var X60Qx_327 = allocFixed(16);
                mem.copy(X60Qx_327, mkRange_0_pro4b75yb(mem.i32(X60Qii_3), mem.i32((X60Qii_2 + 36)), mem.i32(X60Qii_3), mem.i32((X60Qii_2 + 36))), 16);
                var X60Qii_4 = allocFixed(24);
                mem.copy(X60Qii_4, X60Qx_326, 8);
                mem.copy((X60Qii_4 + 8), X60Qx_327, 16);
                var X60Qx_328 = allocFixed(8);
                mem.copy(X60Qx_328, locationJson_0_pro4b75yb(X60Qii_4), 8);
                mem.copy(result_38, X60Qx_328, 8);
                eQdestroyQ_SX4cocation0pro4b75yb_0_pro4b75yb(X60Qii_4);
                eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_2);
                return result_38;
                eQdestroyQ_SX4cocation0pro4b75yb_0_pro4b75yb(X60Qii_4);
                eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(X60Qii_2);
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_55);
          }
        }
      }
    }
  }
  nimStrDestroy(result_38);
  mem.copy(result_38, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  return result_38;
}

function featDefinition_0_webzywwor1(decls_6, calls_1, line_6, col_6) {
  let result_39 = allocFixed(8);
  nimStrWasMoved(result_39);
  let isDecl_1 = allocFixed(1);
  mem.setU8(isDecl_1, false);
  let sym_2 = allocFixed(8);
  mem.copy(sym_2, symAtCursor_0_webzywwor1(decls_6, calls_1, line_6, col_6, isDecl_1), 8);
  let X60Qx_329 = len_4_sysvq0asl(sym_2);
  if ((X60Qx_329 === 0)) {
    nimStrDestroy(sym_2);
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 6118146);
      mem.setU32((_o + 4), 0);
      return _o;
    })();
  }
  let loc_1 = allocFixed(8);
  mem.copy(loc_1, declLocationOf_0_webzywwor1(decls_6, sym_2), 8);
  let X60Qx_330 = len_4_sysvq0asl(loc_1);
  if ((X60Qx_330 === 0)) {
    nimStrDestroy(loc_1);
    nimStrDestroy(sym_2);
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 6118146);
      mem.setU32((_o + 4), 0);
      return _o;
    })();
  }
  let X60Qx_331 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 23297);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qx_332 = len_4_sysvq0asl(loc_1);
  let X60Qx_333 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qdesugar_15 = allocFixed(8);
  mem.copy(X60Qdesugar_15, newStringOfCap_0_sysvq0asl(((((X60Qx_331 + X60Qx_332) | 0) + X60Qx_333) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_15, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 23297);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_15, loc_1);
  add_2_sysvq0asl(X60Qdesugar_15, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_39);
  mem.copy(result_39, X60Qdesugar_15, 8);
  nimStrWasMoved(X60Qdesugar_15);
  nimStrDestroy(X60Qdesugar_15);
  nimStrDestroy(loc_1);
  nimStrDestroy(sym_2);
  return result_39;
  nimStrDestroy(X60Qdesugar_15);
  nimStrDestroy(loc_1);
  nimStrDestroy(sym_2);
  return result_39;
}

function callSiteLocation_0_webzywwor1(c_3) {
  let result_40 = allocFixed(8);
  nimStrWasMoved(result_40);
  let X60Qx_18;
  if ((0 < mem.i32((c_3 + 24)))) {
    X60Qx_18 = ((mem.i32((c_3 + 24)) - 1) | 0);
  } else {
    X60Qx_18 = 0;
  }
  let cl_3 = X60Qx_18;
  let X60Qx_334 = allocFixed(8);
  mem.copy(X60Qx_334, pathToUri_0_urim2dvcg1((c_3 + 16)), 8);
  let X60Qx_335 = allocFixed(16);
  mem.copy(X60Qx_335, mkRange_0_pro4b75yb(cl_3, mem.i32((c_3 + 28)), cl_3, mem.i32((c_3 + 28))), 16);
  let loc_2 = allocFixed(24);
  mem.copy(loc_2, X60Qx_334, 8);
  mem.copy((loc_2 + 8), X60Qx_335, 16);
  nimStrDestroy(result_40);
  let X60Qx_336 = allocFixed(8);
  mem.copy(X60Qx_336, locationJson_0_pro4b75yb(loc_2), 8);
  mem.copy(result_40, X60Qx_336, 8);
  eQdestroyQ_SX4cocation0pro4b75yb_0_pro4b75yb(loc_2);
  return result_40;
  eQdestroyQ_SX4cocation0pro4b75yb_0_pro4b75yb(loc_2);
  return result_40;
}

function featReferences_0_webzywwor1(decls_7, calls_2, line_7, col_7) {
  forStmtLabel_4: {
    forStmtLabel_0: {
      var result_41 = allocFixed(8);
      nimStrWasMoved(result_41);
      var isDecl_2 = allocFixed(1);
      mem.setU8(isDecl_2, false);
      var sym_3 = allocFixed(8);
      mem.copy(sym_3, symAtCursor_0_webzywwor1(decls_7, calls_2, line_7, col_7, isDecl_2), 8);
      var X60Qx_337 = len_4_sysvq0asl(sym_3);
      if ((X60Qx_337 === 0)) {
        nimStrDestroy(sym_3);
        return (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 6118146);
          mem.setU32((_o + 4), 0);
          return _o;
        })();
      }
      var parts_2 = allocFixed(8);
      mem.copy(parts_2, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
      var seen_2 = allocFixed(8);
      mem.copy(seen_2, newSeqUninit_0_Im3cqd9_jsovezijp1(0), 8);
      var dloc_0 = allocFixed(8);
      mem.copy(dloc_0, declLocationOf_0_webzywwor1(decls_7, sym_3), 8);
      var X60Qx_338 = len_4_sysvq0asl(dloc_0);
      if ((0 < X60Qx_338)) {
        var X60Qx_339 = allocFixed(8);
        mem.copy(X60Qx_339, nimStrDup(dloc_0), 8);
        add_0_Ig6072n_webzywwor1(parts_2, X60Qx_339);
        var X60Qtmp_22 = allocFixed(8);
        mem.copy(X60Qtmp_22, dloc_0, 8);
        nimStrWasMoved(dloc_0);
        add_0_Ig6072n_webzywwor1(seen_2, X60Qtmp_22);
      }
      {
        whileStmtLabel_1: {
          var X60Qlf_56 = 0;
          var X60Qlf_57 = len_3_I4blgsl1_webzywwor1(calls_2);
          var X60Qlf_58 = allocFixed(4);
          mem.setI32(X60Qlf_58, X60Qlf_56);
          {
            while ((mem.i32(X60Qlf_58) < X60Qlf_57)) {
              {
                continueLabel_2: {
                  {
                    var X60Qx_340 = getQ_7_I7xfifm1_webzywwor1(calls_2, mem.i32(X60Qlf_58));
                    if ((!mem.u8At((X60Qx_340 + 32)))) {
                      break continueLabel_2;
                    }
                    var X60Qx_341 = getQ_7_I7xfifm1_webzywwor1(calls_2, mem.i32(X60Qlf_58));
                    var X60Qx_342 = eqQ_20_sysvq0asl((X60Qx_341 + 8), sym_3);
                    if ((!X60Qx_342)) {
                      break continueLabel_2;
                    }
                    var X60Qx_343 = getQ_7_I7xfifm1_webzywwor1(calls_2, mem.i32(X60Qlf_58));
                    var X60QconstRefTemp_0 = allocFixed(36);
                    mem.copy(X60QconstRefTemp_0, X60Qx_343, 36);
                    var X60Qii_3 = allocFixed(8);
                    mem.copy(X60Qii_3, callSiteLocation_0_webzywwor1(X60QconstRefTemp_0), 8);
                    var X60Qx_344 = allocFixed(8);
                    mem.copy(X60Qx_344, toOpenArray_1_I6b60gk1_webzywwor1(seen_2), 8);
                    var X60Qx_345 = among_0_webzywwor1(X60Qii_3, X60Qx_344);
                    if ((!X60Qx_345)) {
                      var X60Qx_346 = allocFixed(8);
                      mem.copy(X60Qx_346, nimStrDup(X60Qii_3), 8);
                      add_0_Ig6072n_webzywwor1(seen_2, X60Qx_346);
                      var X60Qtmp_23 = allocFixed(8);
                      mem.copy(X60Qtmp_23, X60Qii_3, 8);
                      nimStrWasMoved(X60Qii_3);
                      add_0_Ig6072n_webzywwor1(parts_2, X60Qtmp_23);
                    }
                    nimStrDestroy(X60Qii_3);
                  }
                }
              }
              inc_1_I6wjjge_jsfc0lwq21(X60Qlf_58);
            }
          }
        }
      }
    }
    nimStrDestroy(result_41);
    mem.copy(result_41, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_5: {
        var X60Qlf_59 = 0;
        var X60Qlf_60 = len_3_Ixq6taz_jsovezijp1(parts_2);
        var X60Qlf_61 = allocFixed(4);
        mem.setI32(X60Qlf_61, X60Qlf_59);
        {
          while ((mem.i32(X60Qlf_61) < X60Qlf_60)) {
            {
              if ((0 < mem.i32(X60Qlf_61))) {
                add_2_sysvq0asl(result_41, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_347 = getQ_7_Ir6d0tw_jsovezijp1(parts_2, mem.i32(X60Qlf_61));
              add_2_sysvq0asl(result_41, X60Qx_347);
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_61);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_41, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(dloc_0);
  eQdestroy_1_Ivioh0a_jsovezijp1(seen_2);
  eQdestroy_1_Ivioh0a_jsovezijp1(parts_2);
  nimStrDestroy(sym_3);
  return result_41;
  nimStrDestroy(dloc_0);
  eQdestroy_1_Ivioh0a_jsovezijp1(seen_2);
  eQdestroy_1_Ivioh0a_jsovezijp1(parts_2);
  nimStrDestroy(sym_3);
  return result_41;
}

function parseIndexExports_0_webzywwor1(js_2) {
  forStmtLabel_0: {
    var result_42 = allocFixed(8);
    eQwasMoved_1_Igrahnr1_webzywwor1(result_42);
    eQdestroy_1_Idvuhgk_webzywwor1(result_42);
    var X60Qx_348 = allocFixed(8);
    mem.copy(X60Qx_348, newSeqUninit_0_I3av7471_webzywwor1(0), 8);
    mem.copy(result_42, X60Qx_348, 8);
    var root_3 = parseJsonStr_0_webzywwor1(js_2);
    if ((!(mem.u8At((root_3 + 4)) === 5))) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_3);
      return result_42;
    }
    var exp_0 = field_0_webzywwor1(root_3, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1886938622);
      mem.setU32((_o + 4), strlit_0_I15596293004384550361_webzywwor1);
      return _o;
    })());
    var X60Qx_349;
    if ((exp_0 === 0)) {
      X60Qx_349 = true;
    } else {
      X60Qx_349 = (!(mem.u8At((exp_0 + 4)) === 4));
    }
    if (X60Qx_349) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(exp_0);
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_3);
      return result_42;
    }
    {
      whileStmtLabel_1: {
        var X60Qlf_62 = 0;
        var X60Qlf_63 = len_3_I1yvahf1_webzywwor1(((exp_0 + 4) + 20));
        var X60Qlf_64 = allocFixed(4);
        mem.setI32(X60Qlf_64, X60Qlf_62);
        {
          while ((mem.i32(X60Qlf_64) < X60Qlf_63)) {
            {
              continueLabel_2: {
                {
                  var X60Qx_350 = getQ_7_Imk9l7s_webzywwor1(((exp_0 + 4) + 20), mem.i32(X60Qlf_64));
                  var X60Qii_3 = allocFixed(4);
                  mem.setU32(X60Qii_3, eQdupQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qx_350)));
                  if ((!(mem.u8At((mem.u32(X60Qii_3) + 4)) === 5))) {
                    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                    break continueLabel_2;
                  }
                  var X60Qx_351 = allocFixed(8);
                  mem.copy(X60Qx_351, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1836675843);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })()), 8);
                  var X60Qx_352 = allocFixed(8);
                  mem.copy(X60Qx_352, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1835101950);
                    mem.setU32((_o + 4), strlit_0_I407209193152762291_webzywwor1);
                    return _o;
                  })()), 8);
                  var X60Qx_353 = allocFixed(8);
                  mem.copy(X60Qx_353, getStr_0_webzywwor1(mem.u32(X60Qii_3), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852402686);
                    mem.setU32((_o + 4), strlit_0_I18311672068392283896_webzywwor1);
                    return _o;
                  })()), 8);
                  add_0_Ifd8wg71_webzywwor1(result_42, (() => {
                    var _o = allocFixed(44);
                    mem.copy(_o, X60Qx_351, 8);
                    mem.copy((_o + 8), X60Qx_352, 8);
                    mem.copy((_o + 16), X60Qx_353, 8);
                    mem.copy((_o + 24), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 0);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })(), 8);
                    mem.setI32((_o + 32), 0);
                    mem.setI32((_o + 36), 0);
                    mem.setU8((_o + 40), false);
                    return _o;
                  })());
                  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32(X60Qii_3));
                }
              }
            }
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_64);
          }
        }
      }
    }
  }
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(exp_0);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_3);
  return result_42;
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(exp_0);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(root_3);
  return result_42;
}

function lsRun_0_webzywwor1() {
  let err_0 = allocFixed(8);
  mem.setU32(err_0, 0);
  mem.setU32((err_0 + 4), 0);
  let res_0 = allocFixed(8);
  mem.setU32(res_0, 1819635454);
  mem.setU32((res_0 + 4), strlit_0_I1659971858173592857_webzywwor1);
  let reqJs_0 = allocFixed(8);
  mem.copy(reqJs_0, readGlobal_0_webzywwor1((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818189822);
    mem.setU32((_o + 4), strlit_0_I17114304651798930877_webzywwor1);
    return _o;
  })()), 8);
  let req_0 = parseJsonStr_0_webzywwor1(reqJs_0);
  if ((!(mem.u8At((req_0 + 4)) === 5))) {
    setGlobal_0_webzywwor1((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1818189822);
      mem.setU32((_o + 4), strlit_0_I8650502675586490208_webzywwor1);
      return _o;
    })(), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1819635454);
      mem.setU32((_o + 4), strlit_0_I1659971858173592857_webzywwor1);
      return _o;
    })());
    setGlobal_0_webzywwor1((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1818189822);
      mem.setU32((_o + 4), strlit_0_I10565791122227693825_webzywwor1);
      return _o;
    })(), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1684103934);
      mem.setU32((_o + 4), strlit_0_I13597173998288957670_webzywwor1);
      return _o;
    })());
    eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(req_0);
    nimStrDestroy(reqJs_0);
    nimStrDestroy(res_0);
    nimStrDestroy(err_0);
    return;
  }
  let feature_0 = allocFixed(8);
  mem.copy(feature_0, getStr_0_webzywwor1(req_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634035454);
    mem.setU32((_o + 4), strlit_0_I4207864124720532554_webzywwor1);
    return _o;
  })()), 8);
  let okL_0 = allocFixed(1);
  mem.setU8(okL_0, false);
  let line_9 = getInt_0_webzywwor1(req_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852402942);
    mem.setU32((_o + 4), strlit_0_I1643616165736515820_webzywwor1);
    return _o;
  })(), okL_0);
  let okC_0 = allocFixed(1);
  mem.setU8(okC_0, false);
  let col_10 = getInt_0_webzywwor1(req_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1819239171);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), okC_0);
  let file_0 = allocFixed(8);
  mem.copy(file_0, getStr_0_webzywwor1(req_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818846974);
    mem.setU32((_o + 4), strlit_0_I4541348101218926504_webzywwor1);
    return _o;
  })()), 8);
  let X60Qx_354 = eqQ_20_sysvq0asl(feature_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836676094);
    mem.setU32((_o + 4), strlit_0_I10436777097720170411_webzywwor1);
    return _o;
  })());
  if (X60Qx_354) {
    let X60Qtmp_24 = allocFixed(8);
    mem.copy(X60Qtmp_24, readGlobal_0_webzywwor1((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1818189822);
      mem.setU32((_o + 4), strlit_0_I2961009535513786441_webzywwor1);
      return _o;
    })()), 8);
    let decls_8 = allocFixed(8);
    mem.copy(decls_8, parseDecls_0_webzywwor1(X60Qtmp_24), 8);
    nimStrDestroy(res_0);
    let X60Qx_355 = allocFixed(8);
    mem.copy(X60Qx_355, featSymbols_0_webzywwor1(decls_8, file_0), 8);
    mem.copy(res_0, X60Qx_355, 8);
    eQdestroy_1_Idvuhgk_webzywwor1(decls_8);
    nimStrDestroy(X60Qtmp_24);
  } else {
    let X60Qx_356 = eqQ_20_sysvq0asl(feature_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1836016638);
      mem.setU32((_o + 4), strlit_0_I18034278047881734788_webzywwor1);
      return _o;
    })());
    if (X60Qx_356) {
      let X60Qtmp_25 = allocFixed(8);
      mem.copy(X60Qtmp_25, readGlobal_0_webzywwor1((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1818189822);
        mem.setU32((_o + 4), strlit_0_I2961009535513786441_webzywwor1);
        return _o;
      })()), 8);
      let decls_9 = allocFixed(8);
      mem.copy(decls_9, parseDecls_0_webzywwor1(X60Qtmp_25), 8);
      let X60Qtmp_26 = allocFixed(8);
      mem.copy(X60Qtmp_26, readGlobal_0_webzywwor1((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1818189822);
        mem.setU32((_o + 4), strlit_0_I2610569064113355705_webzywwor1);
        return _o;
      })()), 8);
      let exps_0 = allocFixed(8);
      mem.copy(exps_0, parseIndexExports_0_webzywwor1(X60Qtmp_26), 8);
      let src_2 = allocFixed(8);
      mem.copy(src_2, readGlobal_0_webzywwor1((() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1818189822);
        mem.setU32((_o + 4), strlit_0_I15244226513049159307_webzywwor1);
        return _o;
      })()), 8);
      nimStrDestroy(res_0);
      let X60Qx_357 = allocFixed(8);
      mem.copy(X60Qx_357, featCompletion_0_webzywwor1(decls_9, exps_0, src_2, line_9, col_10), 8);
      mem.copy(res_0, X60Qx_357, 8);
      nimStrDestroy(src_2);
      eQdestroy_1_Idvuhgk_webzywwor1(exps_0);
      nimStrDestroy(X60Qtmp_26);
      eQdestroy_1_Idvuhgk_webzywwor1(decls_9);
      nimStrDestroy(X60Qtmp_25);
    } else {
      let X60Qx_358 = eqQ_20_sysvq0asl(feature_0, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1987012862);
        mem.setU32((_o + 4), strlit_0_I16681520760414789874_webzywwor1);
        return _o;
      })());
      if (X60Qx_358) {
        let X60Qtmp_27 = allocFixed(8);
        mem.copy(X60Qtmp_27, readGlobal_0_webzywwor1((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1818189822);
          mem.setU32((_o + 4), strlit_0_I2961009535513786441_webzywwor1);
          return _o;
        })()), 8);
        let decls_10 = allocFixed(8);
        mem.copy(decls_10, parseDecls_0_webzywwor1(X60Qtmp_27), 8);
        let renderJs_2 = allocFixed(8);
        mem.copy(renderJs_2, readGlobal_0_webzywwor1((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1818189822);
          mem.setU32((_o + 4), strlit_0_I6506369825410052670_webzywwor1);
          return _o;
        })()), 8);
        nimStrDestroy(res_0);
        let X60Qx_359 = allocFixed(8);
        mem.copy(X60Qx_359, featHover_0_webzywwor1(decls_10, renderJs_2, line_9, col_10), 8);
        mem.copy(res_0, X60Qx_359, 8);
        nimStrDestroy(renderJs_2);
        eQdestroy_1_Idvuhgk_webzywwor1(decls_10);
        nimStrDestroy(X60Qtmp_27);
      } else {
        let X60Qx_360 = eqQ_20_sysvq0asl(feature_0, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1717921022);
          mem.setU32((_o + 4), strlit_0_I14605782373830734321_webzywwor1);
          return _o;
        })());
        if (X60Qx_360) {
          let X60Qtmp_28 = allocFixed(8);
          mem.copy(X60Qtmp_28, readGlobal_0_webzywwor1((() => {
            let _o = allocFixed(8);
            mem.setU32(_o, 1818189822);
            mem.setU32((_o + 4), strlit_0_I2961009535513786441_webzywwor1);
            return _o;
          })()), 8);
          let decls_11 = allocFixed(8);
          mem.copy(decls_11, parseDecls_0_webzywwor1(X60Qtmp_28), 8);
          let X60Qtmp_29 = allocFixed(8);
          mem.copy(X60Qtmp_29, readGlobal_0_webzywwor1((() => {
            let _o = allocFixed(8);
            mem.setU32(_o, 1818189822);
            mem.setU32((_o + 4), strlit_0_I1804109583649340092_webzywwor1);
            return _o;
          })()), 8);
          let calls_3 = allocFixed(8);
          mem.copy(calls_3, parseCalls_0_webzywwor1(X60Qtmp_29), 8);
          nimStrDestroy(res_0);
          let X60Qx_361 = allocFixed(8);
          mem.copy(X60Qx_361, featDefinition_0_webzywwor1(decls_11, calls_3, line_9, col_10), 8);
          mem.copy(res_0, X60Qx_361, 8);
          eQdestroy_1_Idmsvvi_webzywwor1(calls_3);
          nimStrDestroy(X60Qtmp_29);
          eQdestroy_1_Idvuhgk_webzywwor1(decls_11);
          nimStrDestroy(X60Qtmp_28);
        } else {
          let X60Qx_362 = eqQ_20_sysvq0asl(feature_0, (() => {
            let _o = allocFixed(8);
            mem.setU32(_o, 1717924606);
            mem.setU32((_o + 4), strlit_0_I8177294062090954445_webzywwor1);
            return _o;
          })());
          if (X60Qx_362) {
            let X60Qtmp_30 = allocFixed(8);
            mem.copy(X60Qtmp_30, readGlobal_0_webzywwor1((() => {
              let _o = allocFixed(8);
              mem.setU32(_o, 1818189822);
              mem.setU32((_o + 4), strlit_0_I2961009535513786441_webzywwor1);
              return _o;
            })()), 8);
            let decls_12 = allocFixed(8);
            mem.copy(decls_12, parseDecls_0_webzywwor1(X60Qtmp_30), 8);
            let X60Qtmp_31 = allocFixed(8);
            mem.copy(X60Qtmp_31, readGlobal_0_webzywwor1((() => {
              let _o = allocFixed(8);
              mem.setU32(_o, 1818189822);
              mem.setU32((_o + 4), strlit_0_I1804109583649340092_webzywwor1);
              return _o;
            })()), 8);
            let calls_4 = allocFixed(8);
            mem.copy(calls_4, parseCalls_0_webzywwor1(X60Qtmp_31), 8);
            nimStrDestroy(res_0);
            let X60Qx_363 = allocFixed(8);
            mem.copy(X60Qx_363, featReferences_0_webzywwor1(decls_12, calls_4, line_9, col_10), 8);
            mem.copy(res_0, X60Qx_363, 8);
            eQdestroy_1_Idmsvvi_webzywwor1(calls_4);
            nimStrDestroy(X60Qtmp_31);
            eQdestroy_1_Idvuhgk_webzywwor1(decls_12);
            nimStrDestroy(X60Qtmp_30);
          } else {
            let X60Qx_364 = eqQ_20_sysvq0asl(feature_0, (() => {
              let _o = allocFixed(8);
              mem.setU32(_o, 1634297086);
              mem.setU32((_o + 4), strlit_0_I5902630995655632564_webzywwor1);
              return _o;
            })());
            if (X60Qx_364) {
              let raw_2 = allocFixed(8);
              mem.copy(raw_2, readGlobal_0_webzywwor1((() => {
                let _o = allocFixed(8);
                mem.setU32(_o, 1818189822);
                mem.setU32((_o + 4), strlit_0_I135188311513184041_webzywwor1);
                return _o;
              })()), 8);
              nimStrDestroy(res_0);
              let X60Qx_365 = allocFixed(8);
              mem.copy(X60Qx_365, featDiagnostics_0_webzywwor1(raw_2), 8);
              mem.copy(res_0, X60Qx_365, 8);
              nimStrDestroy(raw_2);
            } else {
              nimStrDestroy(err_0);
              let X60Qx_366 = allocFixed(8);
              mem.copy(X60Qx_366, ampQ_0_sysvq0asl((() => {
                let _o = allocFixed(8);
                mem.setU32(_o, 1802401278);
                mem.setU32((_o + 4), strlit_0_I5438928059933331131_webzywwor1);
                return _o;
              })(), feature_0), 8);
              mem.copy(err_0, X60Qx_366, 8);
              nimStrDestroy(res_0);
              mem.copy(res_0, (() => {
                let _o = allocFixed(8);
                mem.setU32(_o, 1819635454);
                mem.setU32((_o + 4), strlit_0_I1659971858173592857_webzywwor1);
                return _o;
              })(), 8);
            }
          }
        }
      }
    }
  }
  setGlobal_0_webzywwor1((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818189822);
    mem.setU32((_o + 4), strlit_0_I8650502675586490208_webzywwor1);
    return _o;
  })(), res_0);
  setGlobal_0_webzywwor1((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818189822);
    mem.setU32((_o + 4), strlit_0_I10565791122227693825_webzywwor1);
    return _o;
  })(), err_0);
  nimStrDestroy(file_0);
  nimStrDestroy(feature_0);
  eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(req_0);
  nimStrDestroy(reqJs_0);
  nimStrDestroy(res_0);
  nimStrDestroy(err_0);
}

function newSeqUninit_0_I5u8l6k_webzywwor1(size_4) {
  let result_43 = allocFixed(8);
  if ((size_4 === 0)) {
    mem.copy(result_43, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_Iwdk7th_webzywwor1(size_4);
    let X60Qx_367 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_43, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), X60Qx_367);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_43 + 4)) === 0))) {
      let X60Qx_368 = allocFixed(8);
      mem.setU32(X60Qx_368, 1634036990);
      mem.setU32((X60Qx_368 + 4), strlit_0_I15750996627617194403_jsovezijp1);
    } else {
      mem.setI32(result_43, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_43;
}

function add_0_I4avu501_webzywwor1(s_21, elem_5) {
  let L_0 = mem.i32(s_21);
  let X60Qx_371 = capInBytes_0_I7qc2bs1_webzywwor1(s_21);
  if ((X60Qx_371 < ((Math.imul(L_0, 4) + 4) | 0))) {
    let X60Qx_372 = resize_0_Iv9v4go1_webzywwor1(s_21, 1);
    if ((!X60Qx_372)) {
      eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(elem_5);
      return;
    }
  }
  inc_1_I6wjjge_jsfc0lwq21(s_21);
  mem.setU32((mem.u32((s_21 + 4)) + (L_0 * 4)), elem_5);
}

function add_0_Ig6072n_webzywwor1(s_23, elem_6) {
  let L_1 = mem.i32(s_23);
  let X60Qx_373 = capInBytes_0_Ih2sbn01_jsovezijp1(s_23);
  if ((X60Qx_373 < ((Math.imul(L_1, 8) + 8) | 0))) {
    let X60Qx_374 = resize_0_I4buliy_webzywwor1(s_23, 1);
    if ((!X60Qx_374)) {
      nimStrDestroy(elem_6);
      return;
    }
  }
  inc_1_I6wjjge_jsfc0lwq21(s_23);
  mem.copy((mem.u32((s_23 + 4)) + (L_1 * 8)), elem_6, 8);
}

function getQ_7_Imk9l7s_webzywwor1(s_27, i_32) {
  let X60Qx_376;
  if ((i_32 < mem.i32(s_27))) {
    X60Qx_376 = (0 <= i_32);
  } else {
    X60Qx_376 = false;
  }
  if ((!X60Qx_376)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_jsovezijp1);
      return _o;
    })());
  }
  let result_47;
  result_47 = (mem.u32((s_27 + 4)) + (i_32 * 4));
  return result_47;
}

function newSeqUninit_0_I3av7471_webzywwor1(size_8) {
  let result_48 = allocFixed(8);
  if ((size_8 === 0)) {
    mem.copy(result_48, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_8);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_2 = memSizeInBytes_0_Ibk3z82_webzywwor1(size_8);
    let X60Qx_377 = alloc_1_sysvq0asl(memSize_2);
    mem.copy(result_48, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_8);
      mem.setU32((_o + 4), X60Qx_377);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_48 + 4)) === 0))) {
      let X60Qx_378 = allocFixed(8);
      mem.setU32(X60Qx_378, 1634036990);
      mem.setU32((X60Qx_378 + 4), strlit_0_I15750996627617194403_jsovezijp1);
    } else {
      mem.setI32(result_48, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    }
  }
  return result_48;
}

function len_3_I1yvahf1_webzywwor1(s_28) {
  let result_49;
  result_49 = mem.i32(s_28);
  return result_49;
}

function add_0_Ifd8wg71_webzywwor1(s_29, elem_7) {
  let L_2 = mem.i32(s_29);
  let X60Qx_379 = capInBytes_0_Ivm839a_webzywwor1(s_29);
  if ((X60Qx_379 < ((Math.imul(L_2, 44) + 44) | 0))) {
    let X60Qx_380 = resize_0_I08i6y9_webzywwor1(s_29, 1);
    if ((!X60Qx_380)) {
      eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(elem_7);
      return;
    }
  }
  inc_1_I6wjjge_jsfc0lwq21(s_29);
  mem.copy((mem.u32((s_29 + 4)) + (L_2 * 44)), elem_7, 44);
}

function newSeqUninit_0_Ixeb9vm_webzywwor1(size_10) {
  let result_50 = allocFixed(8);
  if ((size_10 === 0)) {
    mem.copy(result_50, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_10);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_3 = memSizeInBytes_0_I203mky1_webzywwor1(size_10);
    let X60Qx_381 = alloc_1_sysvq0asl(memSize_3);
    mem.copy(result_50, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_10);
      mem.setU32((_o + 4), X60Qx_381);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_50 + 4)) === 0))) {
      let X60Qx_382 = allocFixed(8);
      mem.setU32(X60Qx_382, 1634036990);
      mem.setU32((X60Qx_382 + 4), strlit_0_I15750996627617194403_jsovezijp1);
    } else {
      mem.setI32(result_50, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_3);
    }
  }
  return result_50;
}

function add_0_In2qv0v_webzywwor1(s_31, elem_8) {
  let L_3 = mem.i32(s_31);
  let X60Qx_383 = capInBytes_0_Inj666w1_webzywwor1(s_31);
  if ((X60Qx_383 < ((Math.imul(L_3, 36) + 36) | 0))) {
    let X60Qx_384 = resize_0_Iwh577u_webzywwor1(s_31, 1);
    if ((!X60Qx_384)) {
      eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1(elem_8);
      return;
    }
  }
  inc_1_I6wjjge_jsfc0lwq21(s_31);
  mem.copy((mem.u32((s_31 + 4)) + (L_3 * 36)), elem_8, 36);
}

function toOpenArray_0_Ih6urrr1_webzywwor1(x_12) {
  let result_51 = allocFixed(8);
  let X60Qx_19 = allocFixed(8);
  if (((((6 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_19, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_19, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_12);
      mem.setI32((_o + 4), (((6 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_51, X60Qx_19, 8);
  return result_51;
}

function toOpenArray_0_I3urt0l_webzywwor1(x_13) {
  let result_52 = allocFixed(8);
  let X60Qx_20 = allocFixed(8);
  if (((((2 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_20, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_20, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_13);
      mem.setI32((_o + 4), (((2 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_52, X60Qx_20, 8);
  return result_52;
}

function toOpenArray_0_Il5czcd1_webzywwor1(x_14) {
  let result_53 = allocFixed(8);
  let X60Qx_21 = allocFixed(8);
  if (((((1 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_21, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_21, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_14);
      mem.setI32((_o + 4), (((1 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_53, X60Qx_21, 8);
  return result_53;
}

function len_3_I92u5c2_webzywwor1(s_33) {
  let result_54;
  result_54 = mem.i32(s_33);
  return result_54;
}

function getQ_7_Ixinnyx1_webzywwor1(s_34, i_34) {
  let X60Qx_385;
  if ((i_34 < mem.i32(s_34))) {
    X60Qx_385 = (0 <= i_34);
  } else {
    X60Qx_385 = false;
  }
  if ((!X60Qx_385)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_jsovezijp1);
      return _o;
    })());
  }
  let result_55;
  result_55 = (mem.u32((s_34 + 4)) + (i_34 * 44));
  return result_55;
}

function toOpenArray_1_I6b60gk1_webzywwor1(s_35) {
  let result_56 = allocFixed(8);
  let X60Qx_386 = rawData_0_I65w5sr_webzywwor1(s_35);
  mem.copy(result_56, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_386);
    mem.setI32((_o + 4), mem.i32(s_35));
    return _o;
  })(), 8);
  return result_56;
}

function putQ_7_Ild9iim_webzywwor1(s_37, i_35, elem_9) {
  let X60Qx_387;
  if ((i_35 < mem.i32(s_37))) {
    X60Qx_387 = (0 <= i_35);
  } else {
    X60Qx_387 = false;
  }
  if ((!X60Qx_387)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I2607068176955078832_webzywwor1);
      return _o;
    })());
  }
  let X60Qlhs_32 = (mem.u32((s_37 + 4)) + (i_35 * 8));
  let X60Qlhs_33 = allocFixed(8);
  mem.copy(X60Qlhs_33, elem_9, 8);
  nimStrWasMoved(elem_9);
  nimStrDestroy(X60Qlhs_32);
  mem.copy(X60Qlhs_32, X60Qlhs_33, 8);
  nimStrDestroy(elem_9);
}

function toOpenArray_0_Iy5qy0w_webzywwor1(x_15) {
  let result_57 = allocFixed(8);
  let X60Qx_22 = allocFixed(8);
  if (((((4 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_22, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_22, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_15);
      mem.setI32((_o + 4), (((4 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_57, X60Qx_22, 8);
  return result_57;
}

function len_3_I4blgsl1_webzywwor1(s_38) {
  let result_58;
  result_58 = mem.i32(s_38);
  return result_58;
}

function getQ_7_I7xfifm1_webzywwor1(s_39, i_36) {
  let X60Qx_388;
  if ((i_36 < mem.i32(s_39))) {
    X60Qx_388 = (0 <= i_36);
  } else {
    X60Qx_388 = false;
  }
  if ((!X60Qx_388)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_jsovezijp1);
      return _o;
    })());
  }
  let result_59;
  result_59 = (mem.u32((s_39 + 4)) + (i_36 * 36));
  return result_59;
}

function memSizeInBytes_0_Iwdk7th_webzywwor1(size_12) {
  let result_60;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_12, 4));
  result_60 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_60 = 2147483647;
  }
  return result_60;
}

function capInBytes_0_I7qc2bs1_webzywwor1(s_40) {
  let result_62;
  let X60Qx_23;
  if ((!(mem.u32((s_40 + 4)) === 0))) {
    let X60Qx_389 = allocatedSize_0_sysvq0asl(mem.u32((s_40 + 4)));
    X60Qx_23 = X60Qx_389;
  } else {
    X60Qx_23 = 0;
  }
  result_62 = X60Qx_23;
  return result_62;
}

function resize_0_Iv9v4go1_webzywwor1(dest_4, addedElements_4) {
  let result_63;
  let X60Qx_390 = capInBytes_0_I7qc2bs1_webzywwor1(dest_4);
  let oldCap_0 = Math.trunc((X60Qx_390 / 4));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_4);
  let memSize_4 = memSizeInBytes_0_Iwdk7th_webzywwor1(newCap_0);
  let X60Qx_391 = realloc_1_sysvq0asl(mem.u32((dest_4 + 4)), memSize_4);
  mem.setU32((dest_4 + 4), X60Qx_391);
  if ((mem.u32((dest_4 + 4)) === 0)) {
    mem.setI32(dest_4, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_4);
    result_63 = false;
  } else {
    result_63 = true;
  }
  return result_63;
}

function resize_0_I4buliy_webzywwor1(dest_5, addedElements_5) {
  let result_65;
  let X60Qx_393 = capInBytes_0_Ih2sbn01_jsovezijp1(dest_5);
  let oldCap_1 = Math.trunc((X60Qx_393 / 8));
  let newCap_1 = recalcCap_0_sysvq0asl(oldCap_1, addedElements_5);
  let memSize_5 = memSizeInBytes_0_I7me00i_jsovezijp1(newCap_1);
  let X60Qx_394 = realloc_1_sysvq0asl(mem.u32((dest_5 + 4)), memSize_5);
  mem.setU32((dest_5 + 4), X60Qx_394);
  if ((mem.u32((dest_5 + 4)) === 0)) {
    mem.setI32(dest_5, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_5);
    result_65 = false;
  } else {
    result_65 = true;
  }
  return result_65;
}

function memSizeInBytes_0_Ibk3z82_webzywwor1(size_14) {
  let result_66;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_14, 44));
  result_66 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_66 = 2147483647;
  }
  return result_66;
}

function capInBytes_0_Ivm839a_webzywwor1(s_42) {
  let result_67;
  let X60Qx_25;
  if ((!(mem.u32((s_42 + 4)) === 0))) {
    let X60Qx_395 = allocatedSize_0_sysvq0asl(mem.u32((s_42 + 4)));
    X60Qx_25 = X60Qx_395;
  } else {
    X60Qx_25 = 0;
  }
  result_67 = X60Qx_25;
  return result_67;
}

function resize_0_I08i6y9_webzywwor1(dest_6, addedElements_6) {
  let result_68;
  let X60Qx_396 = capInBytes_0_Ivm839a_webzywwor1(dest_6);
  let oldCap_2 = Math.trunc((X60Qx_396 / 44));
  let newCap_2 = recalcCap_0_sysvq0asl(oldCap_2, addedElements_6);
  let memSize_6 = memSizeInBytes_0_Ibk3z82_webzywwor1(newCap_2);
  let X60Qx_397 = realloc_1_sysvq0asl(mem.u32((dest_6 + 4)), memSize_6);
  mem.setU32((dest_6 + 4), X60Qx_397);
  if ((mem.u32((dest_6 + 4)) === 0)) {
    mem.setI32(dest_6, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_6);
    result_68 = false;
  } else {
    result_68 = true;
  }
  return result_68;
}

function memSizeInBytes_0_I203mky1_webzywwor1(size_15) {
  let result_69;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_15, 36));
  result_69 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_69 = 2147483647;
  }
  return result_69;
}

function capInBytes_0_Inj666w1_webzywwor1(s_43) {
  let result_70;
  let X60Qx_26;
  if ((!(mem.u32((s_43 + 4)) === 0))) {
    let X60Qx_398 = allocatedSize_0_sysvq0asl(mem.u32((s_43 + 4)));
    X60Qx_26 = X60Qx_398;
  } else {
    X60Qx_26 = 0;
  }
  result_70 = X60Qx_26;
  return result_70;
}

function resize_0_Iwh577u_webzywwor1(dest_7, addedElements_7) {
  let result_71;
  let X60Qx_399 = capInBytes_0_Inj666w1_webzywwor1(dest_7);
  let oldCap_3 = Math.trunc((X60Qx_399 / 36));
  let newCap_3 = recalcCap_0_sysvq0asl(oldCap_3, addedElements_7);
  let memSize_7 = memSizeInBytes_0_I203mky1_webzywwor1(newCap_3);
  let X60Qx_400 = realloc_1_sysvq0asl(mem.u32((dest_7 + 4)), memSize_7);
  mem.setU32((dest_7 + 4), X60Qx_400);
  if ((mem.u32((dest_7 + 4)) === 0)) {
    mem.setI32(dest_7, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_7);
    result_71 = false;
  } else {
    result_71 = true;
  }
  return result_71;
}

function len_6_Igv2wyu1_webzywwor1(a_7) {
  let result_72;
  result_72 = mem.i32((a_7 + 4));
  return result_72;
}

function getQ_10_Ik9hgkq1_webzywwor1(x_16, idx_2) {
  let X60Qx_401;
  if ((0 <= idx_2)) {
    X60Qx_401 = (idx_2 < mem.i32((x_16 + 4)));
  } else {
    X60Qx_401 = false;
  }
  if ((!X60Qx_401)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_jsfc0lwq21);
      return _o;
    })());
  }
  let result_73;
  result_73 = (mem.u32(x_16) + (idx_2 * 8));
  return result_73;
}

function rawData_0_I65w5sr_webzywwor1(s_44) {
  let result_74;
  result_74 = mem.u32((s_44 + 4));
  return result_74;
}

function eQdestroy_1_Iw14kzb1_webzywwor1(s_53) {
  if ((!(mem.u32((s_53 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_37 = allocFixed(4);
      mem.setI32(i_37, 0);
      {
        while ((mem.i32(i_37) < mem.i32(s_53))) {
          eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(mem.u32((mem.u32((s_53 + 4)) + (mem.i32(i_37) * 4))));
          inc_1_I6wjjge_jsfc0lwq21(i_37);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_53 + 4)));
  }
}

function eQdestroy_1_Idvuhgk_webzywwor1(s_57) {
  if ((!(mem.u32((s_57 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_45 = allocFixed(4);
      mem.setI32(i_45, 0);
      {
        while ((mem.i32(i_45) < mem.i32(s_57))) {
          eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1((mem.u32((s_57 + 4)) + (mem.i32(i_45) * 44)));
          inc_1_I6wjjge_jsfc0lwq21(i_45);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_57 + 4)));
  }
}

function eQwasMoved_1_Igrahnr1_webzywwor1(s_58) {
  mem.setI32(s_58, 0);
  mem.setU32((s_58 + 4), 0);
}

function eQdestroy_1_Idmsvvi_webzywwor1(s_59) {
  if ((!(mem.u32((s_59 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_49 = allocFixed(4);
      mem.setI32(i_49, 0);
      {
        while ((mem.i32(i_49) < mem.i32(s_59))) {
          eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1((mem.u32((s_59 + 4)) + (mem.i32(i_49) * 36)));
          inc_1_I6wjjge_jsfc0lwq21(i_49);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_59 + 4)));
  }
}

function eQwasMoved_1_I9n3zs11_webzywwor1(s_60) {
  mem.setI32(s_60, 0);
  mem.setU32((s_60 + 4), 0);
}

function eQdestroyQ_SX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(dest_0) {
  eQdestroy_1_Iw14kzb1_webzywwor1((dest_0 + 36));
  eQdestroy_1_Ivioh0a_jsovezijp1((dest_0 + 28));
  eQdestroy_1_Iw14kzb1_webzywwor1((dest_0 + 20));
  nimStrDestroy((dest_0 + 4));
}

function eQdestroyQ_SX4aX50arser0webzywwor1_0_webzywwor1(dest_0) {
  nimStrDestroy(dest_0);
}

function eQdestroyQ_SX44eclX52ec0webzywwor1_0_webzywwor1(dest_0) {
  nimStrDestroy((dest_0 + 24));
  nimStrDestroy((dest_0 + 16));
  nimStrDestroy((dest_0 + 8));
  nimStrDestroy(dest_0);
}

function eQdupQ_SX44eclX52ec0webzywwor1_0_webzywwor1(src_0) {
  let dest_0 = allocFixed(44);
  let X60Qx_432 = allocFixed(8);
  mem.copy(X60Qx_432, nimStrDup(src_0), 8);
  mem.copy(dest_0, X60Qx_432, 8);
  let X60Qx_433 = allocFixed(8);
  mem.copy(X60Qx_433, nimStrDup((src_0 + 8)), 8);
  mem.copy((dest_0 + 8), X60Qx_433, 8);
  let X60Qx_434 = allocFixed(8);
  mem.copy(X60Qx_434, nimStrDup((src_0 + 16)), 8);
  mem.copy((dest_0 + 16), X60Qx_434, 8);
  let X60Qx_435 = allocFixed(8);
  mem.copy(X60Qx_435, nimStrDup((src_0 + 24)), 8);
  mem.copy((dest_0 + 24), X60Qx_435, 8);
  mem.setI32((dest_0 + 32), mem.i32((src_0 + 32)));
  mem.setI32((dest_0 + 36), mem.i32((src_0 + 36)));
  mem.setU8((dest_0 + 40), mem.u8At((src_0 + 40)));
  return dest_0;
}

function eQdestroyQ_SX43allX52ec0webzywwor1_0_webzywwor1(dest_0) {
  nimStrDestroy((dest_0 + 16));
  nimStrDestroy((dest_0 + 8));
  nimStrDestroy(dest_0);
}

function eQdupQ_SX43allX52ec0webzywwor1_0_webzywwor1(src_0) {
  let dest_0 = allocFixed(36);
  let X60Qx_436 = allocFixed(8);
  mem.copy(X60Qx_436, nimStrDup(src_0), 8);
  mem.copy(dest_0, X60Qx_436, 8);
  let X60Qx_437 = allocFixed(8);
  mem.copy(X60Qx_437, nimStrDup((src_0 + 8)), 8);
  mem.copy((dest_0 + 8), X60Qx_437, 8);
  let X60Qx_438 = allocFixed(8);
  mem.copy(X60Qx_438, nimStrDup((src_0 + 16)), 8);
  mem.copy((dest_0 + 16), X60Qx_438, 8);
  mem.setI32((dest_0 + 24), mem.i32((src_0 + 24)));
  mem.setI32((dest_0 + 28), mem.i32((src_0 + 28)));
  mem.setU8((dest_0 + 32), mem.u8At((src_0 + 32)));
  return dest_0;
}

function eQdestroyQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(dest_0) {
  if (dest_0) {
    let X60Qx_439 = arcDec_0_sysvq0asl(dest_0);
    if (X60Qx_439) {
      eQdestroyQ_SX4aX4eodeX4fbj0webzywwor1_0_webzywwor1((dest_0 + 4));
      deallocFixed_0_sysvq0asl(dest_0);
    }
  }
}

function eQwasmovedQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(dest_0) {
  mem.setU32(dest_0, 0);
}

function eQdupQ_ArefSX4aX4eodeX4fbj0webzywwor1_0_webzywwor1(src_0) {
  let dest_0;
  if (src_0) {
    arcInc_0_sysvq0asl(src_0);
  }
  dest_0 = src_0;
  return dest_0;
}

let X60QiniGuard_0_webzywwor1 = allocFixed(1);

function X60Qini_0_webzywwor1() {
  if (mem.u8At(X60QiniGuard_0_webzywwor1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_webzywwor1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_pro4b75yb();
  X60Qini_0_urim2dvcg1();
  X60Qini_0_jsovezijp1();
  X60Qini_0_jsfc0lwq21();
  lsRun_0_webzywwor1();
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
          inc_1_I6wjjge_jsfc0lwq21(i_25);
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
  dec_0_Ig5i8xp_sysvq0asl(fl_0, 6);
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
  inc_0_Iloplki_sysvq0asl((a_10 + 5224), bytes_0);
}

function decCurrMem_0_sysvq0asl(a_11, bytes_1) {
  let X60Qx_121 = max_2_sysvq0asl(mem.i32((a_11 + 5228)), mem.i32((a_11 + 5224)));
  mem.setI32((a_11 + 5228), X60Qx_121);
  dec_0_Ig5i8xp_sysvq0asl((a_11 + 5224), bytes_1);
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
  dec_0_Ig5i8xp_sysvq0asl(mem.u32((a_15 + 5220)), size_13);
  inc_0_Iloplki_sysvq0asl((mem.u32((a_15 + 5220)) + 4), size_13);
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
    inc_1_I6wjjge_jsfc0lwq21(it_0);
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
  inc_0_Iloplki_sysvq0asl((a_20 + 5232), size_36);
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
  inc_0_Iloplki_sysvq0asl((a_25 + 5232), mem.i32((c_28 + 4)));
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
        inc_0_Iloplki_sysvq0asl((le_0 + 4), mem.i32((c_28 + 4)));
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
      inc_0_Iloplki_sysvq0asl((c_28 + 4), mem.i32((ri_1 + 4)));
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
  dec_0_Ig5i8xp_sysvq0asl((a_26 + 5232), mem.i32(size_37));
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
  dec_0_Ig5i8xp_sysvq0asl((a_31 + 5236), mem.i32((c_10 + 4)));
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
        inc_0_Iloplki_sysvq0asl(total_0, size_21);
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
  dec_0_Ig5i8xp_sysvq0asl((a_33 + 5236), mem.i32(total_0));
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
        dec_1_I0nzoz91_sysvq0asl(maxIters_0);
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
    inc_0_Iloplki_sysvq0asl((a_35 + 5236), size_39);
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
    inc_0_Iloplki_sysvq0asl((a_35 + 5236), mem.i32((c_32 + 4)));
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
      dec_0_Ig5i8xp_sysvq0asl((a_37 + 5236), s_83);
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
    dec_0_Ig5i8xp_sysvq0asl(result_61, 20);
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

function allocFixed_0_sysvq0asl(size_27) {
  let result_76;
  let X60Qx_218 = alloc_1_sysvq0asl(size_27);
  result_76 = X60Qx_218;
  return result_76;
}

function deallocFixed_0_sysvq0asl(p_22) {
  dealloc_1_sysvq0asl(p_22);
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
            inc_1_I6wjjge_jsfc0lwq21(X60Qlf_5);
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

function cmp_1_sysvq0asl(a_51, b_14) {
  let result_128;
  let abytes_5 = mem.u32(a_51);
  let bbytes_5 = mem.u32(b_14);
  let aslen_5 = ssLenOf_0_sysvq0asl(abytes_5);
  let bslen_5 = ssLenOf_0_sysvq0asl(bbytes_5);
  let X60Qx_287;
  if ((aslen_5 <= 3)) {
    X60Qx_287 = (bslen_5 <= 3);
  } else {
    X60Qx_287 = false;
  }
  if (X60Qx_287) {
    let X60Qx_288 = cmpShortInline_0_sysvq0asl(abytes_5, bbytes_5, aslen_5, bslen_5);
    result_128 = X60Qx_288;
    return result_128;
  }
  let X60Qx_289 = cmpStringPtrs_0_sysvq0asl(a_51, b_14);
  result_128 = X60Qx_289;
  return result_128;
}

function ltQ_17_sysvq0asl(a_53, b_16) {
  let result_130;
  let X60Qx_291 = cmp_1_sysvq0asl(a_53, b_16);
  result_130 = (X60Qx_291 < 0);
  return result_130;
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

function chr_0_sysvq0asl(u_0) {
  let result_168;
  result_168 = (u_0 & 255);
  return result_168;
}

let exc_0_sysvq0asl = allocFixed(4);

function inc_0_Iloplki_sysvq0asl(x_375, y_215) {
  mem.setI32(x_375, ((mem.i32(x_375) + y_215) | 0));
}

function dec_0_Ig5i8xp_sysvq0asl(x_377, y_217) {
  mem.setI32(x_377, ((mem.i32(x_377) - y_217) | 0));
}

function dec_1_I0nzoz91_sysvq0asl(x_378) {
  mem.setI32(x_378, ((mem.i32(x_378) - 1) | 0));
}

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
