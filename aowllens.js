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


let strlit_0_I16254714811886502893_party5a2l1 = allocFixed(17);

let NoLineInfo_0_linxafkvx1;

let NoFile_0_linxafkvx1;

let strlit_0_I15885164768026998599_nif81dubp1 = allocFixed(24);

let strlit_0_I10315536999831874058_nif81dubp1 = allocFixed(20);

let strlit_0_I934207063279194918_nif81dubp1 = allocFixed(20);

let strlit_0_I15846002265446469276_nif81dubp1 = allocFixed(17);

let strlit_0_I7416088036152788789_nif81dubp1 = allocFixed(18);

let strlit_0_I15873059642980454073_nif81dubp1 = allocFixed(21);

let strlit_0_I7185474113853794403_nif81dubp1 = allocFixed(21);

let strlit_0_I2368852795644526164_nif81dubp1 = allocFixed(19);

let strlit_0_I17216697482861734393_nif81dubp1 = allocFixed(18);

let strlit_0_I16169252050837114447_nif81dubp1 = allocFixed(19);

let strlit_0_I2526583260401622044_nif81dubp1 = allocFixed(20);

let strlit_0_I3677393315539012384_nif81dubp1 = allocFixed(17);

let strlit_0_I2186592322655248559_nif81dubp1 = allocFixed(17);

let strlit_0_I7773138664102327703_nif81dubp1 = allocFixed(49);

let strlit_0_I10426215507333234367_nif81dubp1 = allocFixed(35);

let strlit_0_I397779028761265335_nif81dubp1 = allocFixed(20);

let strlit_0_I12979507887005580180_nif81dubp1 = allocFixed(23);

let ControlChars_0_nif81dubp1 = allocFixed(32);

let ControlCharsOrWhite_0_nif81dubp1 = allocFixed(32);

let HexChars_0_nif81dubp1 = allocFixed(32);

let Digits_0_nif81dubp1 = allocFixed(32);

let B62Digits_0_nif81dubp1 = allocFixed(32);

let strlit_0_I3807893400126689806_nifb6mq6y1 = allocFixed(26);

let strlit_0_I302546433272327396_nifb6mq6y1 = allocFixed(95);

let strlit_0_I13319536120588890513_nifb6mq6y1 = allocFixed(95);

let strlit_0_I8031254106179394417_dir38pj6l = allocFixed(36);

let strlit_0_I14872370265633446329_str7j0ifg = allocFixed(100);

let strlit_0_I14532204288076119502_envto7w6l1 = allocFixed(98);

let strlit_0_I14676000009897902695_assy765wm = allocFixed(32);

let strlit_0_I10295616015915542771_tagygirdh1 = allocFixed(24);

let strlit_0_I8939511674443647382_tagygirdh1 = allocFixed(17);

let strlit_0_I9557201018976274010_tagygirdh1 = allocFixed(16);

let strlit_0_I12905769428011359788_tagygirdh1 = allocFixed(18);

let strlit_0_I1477227973970526752_tagygirdh1 = allocFixed(21);

let strlit_0_I186799702831424311_tagygirdh1 = allocFixed(18);

let strlit_0_I14042222260391466396_tagygirdh1 = allocFixed(18);

let strlit_0_I6690414846038512979_tagygirdh1 = allocFixed(19);

let strlit_0_I16910581458008155537_tagygirdh1 = allocFixed(20);

let strlit_0_I7084116572891045059_tagygirdh1 = allocFixed(19);

let strlit_0_I17573272885368898989_tagygirdh1 = allocFixed(19);

let strlit_0_I14055597598996035090_tagygirdh1 = allocFixed(19);

let strlit_0_I10209608037894561257_tagygirdh1 = allocFixed(17);

let strlit_0_I14293528690183020870_tagygirdh1 = allocFixed(19);

let strlit_0_I12320098920117258102_tagygirdh1 = allocFixed(18);

let strlit_0_I8344472873800577395_tagygirdh1 = allocFixed(17);

let strlit_0_I1868900624481666580_tagygirdh1 = allocFixed(18);

let strlit_0_I6041839086284145320_tagygirdh1 = allocFixed(18);

let strlit_0_I13909093427330098489_tagygirdh1 = allocFixed(16);

let strlit_0_I2501487269769466366_tagygirdh1 = allocFixed(16);

let strlit_0_I1707222714195181991_tagygirdh1 = allocFixed(16);

let strlit_0_I16597999082088934835_tagygirdh1 = allocFixed(17);

let strlit_0_I10760563625686142994_tagygirdh1 = allocFixed(18);

let strlit_0_I1281801651151844468_tagygirdh1 = allocFixed(16);

let strlit_0_I13046452236886743244_tagygirdh1 = allocFixed(16);

let strlit_0_I9792473688321036479_tagygirdh1 = allocFixed(17);

let strlit_0_I12999086881046019782_tagygirdh1 = allocFixed(17);

let strlit_0_I2416437014800228590_tagygirdh1 = allocFixed(18);

let strlit_0_I5723805845286553140_tagygirdh1 = allocFixed(16);

let strlit_0_I7233319822780473912_tagygirdh1 = allocFixed(16);

let strlit_0_I17735862253056247523_tagygirdh1 = allocFixed(18);

let strlit_0_I3786558325628924612_tagygirdh1 = allocFixed(22);

let strlit_0_I3759916806223351059_tagygirdh1 = allocFixed(19);

let strlit_0_I15385401366416332649_tagygirdh1 = allocFixed(25);

let strlit_0_I2171368188661376471_tagygirdh1 = allocFixed(16);

let strlit_0_I17496857845421750549_tagygirdh1 = allocFixed(16);

let strlit_0_I5316556160589403975_tagygirdh1 = allocFixed(16);

let strlit_0_I9991102891510134496_tagygirdh1 = allocFixed(16);

let strlit_0_I9071657656589967445_tagygirdh1 = allocFixed(20);

let strlit_0_I6864681898360807206_tagygirdh1 = allocFixed(21);

let strlit_0_I6517805684605582485_tagygirdh1 = allocFixed(18);

let strlit_0_I3777428167486794959_tagygirdh1 = allocFixed(17);

let strlit_0_I17987658270787974407_tagygirdh1 = allocFixed(20);

let strlit_0_I13413619771642637377_tagygirdh1 = allocFixed(16);

let strlit_0_I9830314142150548690_tagygirdh1 = allocFixed(17);

let strlit_0_I6605162211648777506_tagygirdh1 = allocFixed(18);

let strlit_0_I7132977312474535290_tagygirdh1 = allocFixed(19);

let strlit_0_I7981495708050792894_tagygirdh1 = allocFixed(19);

let strlit_0_I1572551130627868563_tagygirdh1 = allocFixed(16);

let strlit_0_I2681092370707159476_tagygirdh1 = allocFixed(16);

let strlit_0_I5487391404206283781_tagygirdh1 = allocFixed(17);

let strlit_0_I6800807151669219983_tagygirdh1 = allocFixed(19);

let strlit_0_I110166545589372112_tagygirdh1 = allocFixed(17);

let strlit_0_I14781640258047403316_tagygirdh1 = allocFixed(16);

let strlit_0_I13424873862977158440_tagygirdh1 = allocFixed(16);

let strlit_0_I4167480082662538754_tagygirdh1 = allocFixed(16);

let strlit_0_I14656641239204103783_tagygirdh1 = allocFixed(20);

let strlit_0_I8380221545607033154_tagygirdh1 = allocFixed(17);

let strlit_0_I2210116261907819816_tagygirdh1 = allocFixed(20);

let strlit_0_I13200118161122656888_tagygirdh1 = allocFixed(17);

let strlit_0_I10030898066311664679_tagygirdh1 = allocFixed(19);

let strlit_0_I4956278306908871092_tagygirdh1 = allocFixed(16);

let strlit_0_I13752166055203769914_tagygirdh1 = allocFixed(17);

let strlit_0_I5367917178860180580_tagygirdh1 = allocFixed(18);

let strlit_0_I3302612697625453930_tagygirdh1 = allocFixed(17);

let strlit_0_I973692718279674627_tagygirdh1 = allocFixed(18);

let strlit_0_I10462096440466995513_tagygirdh1 = allocFixed(16);

let strlit_0_I1995551610468546737_tagygirdh1 = allocFixed(20);

let strlit_0_I6755942707126604175_tagygirdh1 = allocFixed(18);

let strlit_0_I2128687583820536666_tagygirdh1 = allocFixed(20);

let strlit_0_I1346366660018635533_tagygirdh1 = allocFixed(18);

let strlit_0_I11024699549390617459_tagygirdh1 = allocFixed(16);

let strlit_0_I11155032387348830029_tagygirdh1 = allocFixed(16);

let strlit_0_I1177603226064417776_tagygirdh1 = allocFixed(17);

let strlit_0_I13748185565082850274_tagygirdh1 = allocFixed(21);

let strlit_0_I6488225283415667707_tagygirdh1 = allocFixed(16);

let strlit_0_I16188676551779215531_tagygirdh1 = allocFixed(17);

let strlit_0_I18234099685676259387_tagygirdh1 = allocFixed(19);

let strlit_0_I4481474124438915992_tagygirdh1 = allocFixed(20);

let strlit_0_I2072093345082808027_tagygirdh1 = allocFixed(19);

let strlit_0_I3679389138985991790_tagygirdh1 = allocFixed(20);

let strlit_0_I17192084538477055045_tagygirdh1 = allocFixed(20);

let strlit_0_I13519359689973327992_tagygirdh1 = allocFixed(18);

let strlit_0_I11811080807945599045_tagygirdh1 = allocFixed(18);

let strlit_0_I13738511073829832276_tagygirdh1 = allocFixed(19);

let strlit_0_I11734088361827745870_tagygirdh1 = allocFixed(18);

let strlit_0_I9300717802679998862_tagygirdh1 = allocFixed(20);

let strlit_0_I16971225136864641703_tagygirdh1 = allocFixed(19);

let strlit_0_I8775499903415745325_tagygirdh1 = allocFixed(16);

let strlit_0_I14941751896671455891_tagygirdh1 = allocFixed(16);

let strlit_0_I14150474136931533575_tagygirdh1 = allocFixed(19);

let strlit_0_I2120471692824576765_tagygirdh1 = allocFixed(21);

let strlit_0_I7023501325319911082_tagygirdh1 = allocFixed(19);

let strlit_0_I17199005983847516849_tagygirdh1 = allocFixed(19);

let strlit_0_I3912769065629684841_tagygirdh1 = allocFixed(17);

let strlit_0_I4965478555169759111_tagygirdh1 = allocFixed(16);

let strlit_0_I772494771101702043_tagygirdh1 = allocFixed(18);

let strlit_0_I9354196862430236195_tagygirdh1 = allocFixed(18);

let strlit_0_I14732757010146030568_tagygirdh1 = allocFixed(16);

let strlit_0_I2784804726569183623_tagygirdh1 = allocFixed(16);

let strlit_0_I3312144845751804851_tagygirdh1 = allocFixed(19);

let strlit_0_I10578126245728228512_tagygirdh1 = allocFixed(18);

let strlit_0_I9191034391941917241_tagygirdh1 = allocFixed(20);

let strlit_0_I3199637833187763350_tagygirdh1 = allocFixed(22);

let strlit_0_I16948548629793503007_tagygirdh1 = allocFixed(24);

let strlit_0_I6313045265747232047_tagygirdh1 = allocFixed(18);

let strlit_0_I15468012182747796806_tagygirdh1 = allocFixed(22);

let strlit_0_I7395289177220351871_tagygirdh1 = allocFixed(24);

let strlit_0_I18257730313531980409_tagygirdh1 = allocFixed(19);

let strlit_0_I2956720964102846418_tagygirdh1 = allocFixed(19);

let strlit_0_I6137881024046402116_tagygirdh1 = allocFixed(17);

let strlit_0_I5809186183819720447_tagygirdh1 = allocFixed(17);

let strlit_0_I10609090264569208189_tagygirdh1 = allocFixed(18);

let strlit_0_I13128250356938898261_tagygirdh1 = allocFixed(16);

let strlit_0_I17569086427026686584_tagygirdh1 = allocFixed(18);

let strlit_0_I356330993363212426_tagygirdh1 = allocFixed(16);

let strlit_0_I5622496984824462814_tagygirdh1 = allocFixed(16);

let strlit_0_I11470268427441903014_tagygirdh1 = allocFixed(18);

let strlit_0_I9846635761469100055_tagygirdh1 = allocFixed(19);

let strlit_0_I7777630149462349779_tagygirdh1 = allocFixed(17);

let strlit_0_I1755384972092858986_tagygirdh1 = allocFixed(17);

let strlit_0_I5825594256536309212_tagygirdh1 = allocFixed(17);

let strlit_0_I18223875966347257259_tagygirdh1 = allocFixed(18);

let strlit_0_I7603755693199836480_tagygirdh1 = allocFixed(16);

let strlit_0_I6285446155132737146_tagygirdh1 = allocFixed(17);

let strlit_0_I16485414215621593826_tagygirdh1 = allocFixed(19);

let strlit_0_I10406234210653353301_tagygirdh1 = allocFixed(16);

let strlit_0_I13179338205702368459_tagygirdh1 = allocFixed(22);

let strlit_0_I1237672436915077942_tagygirdh1 = allocFixed(21);

let strlit_0_I11688738934238820917_tagygirdh1 = allocFixed(20);

let strlit_0_I2573631453468209738_tagygirdh1 = allocFixed(19);

let strlit_0_I7731358638274129439_tagygirdh1 = allocFixed(22);

let strlit_0_I16264910594287870354_tagygirdh1 = allocFixed(18);

let strlit_0_I18086024188298164462_tagygirdh1 = allocFixed(17);

let strlit_0_I3225181402180923291_tagygirdh1 = allocFixed(16);

let strlit_0_I12023767949489687491_tagygirdh1 = allocFixed(16);

let strlit_0_I6008424852838151324_tagygirdh1 = allocFixed(16);

let strlit_0_I5595596763809202512_tagygirdh1 = allocFixed(16);

let strlit_0_I14845240230376595005_tagygirdh1 = allocFixed(16);

let strlit_0_I2544717250931810611_tagygirdh1 = allocFixed(19);

let strlit_0_I3021806080610957510_tagygirdh1 = allocFixed(20);

let strlit_0_I15938251790995683266_tagygirdh1 = allocFixed(20);

let strlit_0_I16393544569146403439_tagygirdh1 = allocFixed(21);

let strlit_0_I2984705338531181753_tagygirdh1 = allocFixed(18);

let strlit_0_I2419004569819514924_tagygirdh1 = allocFixed(16);

let strlit_0_I8265071425581872233_tagygirdh1 = allocFixed(19);

let strlit_0_I567478400955764617_tagygirdh1 = allocFixed(20);

let strlit_0_I13460298547546882036_tagygirdh1 = allocFixed(20);

let strlit_0_I1016912281706840257_tagygirdh1 = allocFixed(19);

let strlit_0_I9456292052054236016_tagygirdh1 = allocFixed(17);

let strlit_0_I14727864736786204059_tagygirdh1 = allocFixed(19);

let strlit_0_I6300154543333844069_tagygirdh1 = allocFixed(19);

let strlit_0_I6616374312433163100_tagygirdh1 = allocFixed(19);

let strlit_0_I15788046494547023735_tagygirdh1 = allocFixed(17);

let strlit_0_I3957309170640276402_tagygirdh1 = allocFixed(19);

let strlit_0_I6761535509221812916_tagygirdh1 = allocFixed(21);

let strlit_0_I4382311971321061249_tagygirdh1 = allocFixed(18);

let strlit_0_I4862850237857511107_tagygirdh1 = allocFixed(19);

let strlit_0_I2341417231474813780_tagygirdh1 = allocFixed(18);

let strlit_0_I11401871840194716403_tagygirdh1 = allocFixed(21);

let strlit_0_I5696226971518331620_tagygirdh1 = allocFixed(18);

let strlit_0_I1655448968826648425_tagygirdh1 = allocFixed(23);

let strlit_0_I14428456701869004983_tagygirdh1 = allocFixed(20);

let strlit_0_I14004803080881083620_tagygirdh1 = allocFixed(18);

let strlit_0_I113550637689326195_tagygirdh1 = allocFixed(24);

let strlit_0_I8745041498576622223_tagygirdh1 = allocFixed(21);

let strlit_0_I757997984781066323_tagygirdh1 = allocFixed(18);

let strlit_0_I4859700805551129371_tagygirdh1 = allocFixed(18);

let strlit_0_I17285089853291426062_tagygirdh1 = allocFixed(17);

let strlit_0_I3179792478750962635_tagygirdh1 = allocFixed(18);

let strlit_0_I16730393376288644638_tagygirdh1 = allocFixed(20);

let strlit_0_I5451065444311437237_tagygirdh1 = allocFixed(19);

let strlit_0_I4604789051338433811_tagygirdh1 = allocFixed(18);

let strlit_0_I12559108835900458521_tagygirdh1 = allocFixed(18);

let strlit_0_I10833596585003541936_tagygirdh1 = allocFixed(17);

let strlit_0_I4207864124720532554_tagygirdh1 = allocFixed(19);

let strlit_0_I4511345809429878981_tagygirdh1 = allocFixed(18);

let strlit_0_I17993691144359452798_tagygirdh1 = allocFixed(16);

let strlit_0_I3557287941175077387_tagygirdh1 = allocFixed(28);

let strlit_0_I1290833423478922541_tagygirdh1 = allocFixed(18);

let strlit_0_I4196580491060784277_tagygirdh1 = allocFixed(18);

let strlit_0_I14457488926480995039_tagygirdh1 = allocFixed(16);

let strlit_0_I17469384850928897790_tagygirdh1 = allocFixed(17);

let strlit_0_I9268166327583521131_tagygirdh1 = allocFixed(18);

let strlit_0_I12337342044224817361_tagygirdh1 = allocFixed(18);

let strlit_0_I17716058327968275251_tagygirdh1 = allocFixed(21);

let strlit_0_I7358334719788826533_tagygirdh1 = allocFixed(21);

let strlit_0_I16361658452647583931_tagygirdh1 = allocFixed(21);

let strlit_0_I4333440046835585584_tagygirdh1 = allocFixed(16);

let strlit_0_I4543393450896359795_tagygirdh1 = allocFixed(19);

let strlit_0_I710932595938440230_tagygirdh1 = allocFixed(17);

let strlit_0_I9667346611828510523_tagygirdh1 = allocFixed(17);

let strlit_0_I9217337746930322866_tagygirdh1 = allocFixed(22);

let strlit_0_I8390060478375454995_tagygirdh1 = allocFixed(17);

let strlit_0_I8954722698363393223_tagygirdh1 = allocFixed(18);

let strlit_0_I12061648672903694946_tagygirdh1 = allocFixed(17);

let strlit_0_I15519800790444264650_tagygirdh1 = allocFixed(20);

let strlit_0_I11246488655541728238_tagygirdh1 = allocFixed(20);

let strlit_0_I15630474019274232734_tagygirdh1 = allocFixed(19);

let strlit_0_I8057664036378742595_tagygirdh1 = allocFixed(20);

let strlit_0_I3906464809106688102_tagygirdh1 = allocFixed(19);

let strlit_0_I7173319946579796093_tagygirdh1 = allocFixed(23);

let strlit_0_I4161172010043268705_tagygirdh1 = allocFixed(22);

let strlit_0_I3485566669610392440_tagygirdh1 = allocFixed(20);

let strlit_0_I8566804573867139999_tagygirdh1 = allocFixed(16);

let strlit_0_I15370501250081784507_tagygirdh1 = allocFixed(18);

let strlit_0_I17316263578118871722_tagygirdh1 = allocFixed(18);

let strlit_0_I11931178963942483173_tagygirdh1 = allocFixed(18);

let strlit_0_I5007098554778156607_tagygirdh1 = allocFixed(22);

let strlit_0_I6307085774546006824_tagygirdh1 = allocFixed(21);

let strlit_0_I15215329021599148827_tagygirdh1 = allocFixed(24);

let strlit_0_I2499004453702072445_tagygirdh1 = allocFixed(22);

let strlit_0_I10155087370267137835_tagygirdh1 = allocFixed(22);

let strlit_0_I5057369592842021125_tagygirdh1 = allocFixed(27);

let strlit_0_I358872489388858575_tagygirdh1 = allocFixed(17);

let strlit_0_I14418907618963914168_tagygirdh1 = allocFixed(18);

let strlit_0_I11512946405431690565_tagygirdh1 = allocFixed(19);

let strlit_0_I13798915436014509391_tagygirdh1 = allocFixed(16);

let strlit_0_I3001676635385606767_tagygirdh1 = allocFixed(17);

let strlit_0_I5323221927989235116_tagygirdh1 = allocFixed(17);

let strlit_0_I12557166611382145809_tagygirdh1 = allocFixed(19);

let strlit_0_I896709357113617264_tagygirdh1 = allocFixed(20);

let strlit_0_I6462229405280805082_tagygirdh1 = allocFixed(18);

let strlit_0_I11168045910199617169_tagygirdh1 = allocFixed(18);

let strlit_0_I17580784255599249694_tagygirdh1 = allocFixed(17);

let strlit_0_I7755216903854853291_tagygirdh1 = allocFixed(17);

let strlit_0_I6438757400198936067_tagygirdh1 = allocFixed(17);

let strlit_0_I17286088029172964552_tagygirdh1 = allocFixed(17);

let strlit_0_I655215872312446365_tagygirdh1 = allocFixed(16);

let strlit_0_I7330775407653057337_tagygirdh1 = allocFixed(17);

let strlit_0_I12823858650579995313_tagygirdh1 = allocFixed(19);

let strlit_0_I6996188409796059230_tagygirdh1 = allocFixed(16);

let strlit_0_I10163392937326623266_tagygirdh1 = allocFixed(20);

let strlit_0_I12773303473659224661_tagygirdh1 = allocFixed(17);

let strlit_0_I13264932728578201327_tagygirdh1 = allocFixed(17);

let strlit_0_I12050042172059571383_tagygirdh1 = allocFixed(16);

let strlit_0_I4843651051758684618_tagygirdh1 = allocFixed(22);

let strlit_0_I18337270522941735704_tagygirdh1 = allocFixed(16);

let strlit_0_I6669728318263290480_tagygirdh1 = allocFixed(17);

let strlit_0_I15803870852433253359_tagygirdh1 = allocFixed(17);

let strlit_0_I4167773820130397069_tagygirdh1 = allocFixed(17);

let strlit_0_I15907549540151602841_tagygirdh1 = allocFixed(17);

let strlit_0_I15673079640947746121_tagygirdh1 = allocFixed(18);

let strlit_0_I18017358057866442883_tagygirdh1 = allocFixed(18);

let strlit_0_I694217339896490792_tagygirdh1 = allocFixed(17);

let strlit_0_I15516388950515943933_tagygirdh1 = allocFixed(17);

let strlit_0_I15352605387219570985_tagygirdh1 = allocFixed(18);

let strlit_0_I57893748219682234_tagygirdh1 = allocFixed(16);

let strlit_0_I7770279929706659123_tagygirdh1 = allocFixed(22);

let strlit_0_I6214469262558903647_tagygirdh1 = allocFixed(22);

let strlit_0_I10356331269374273950_tagygirdh1 = allocFixed(28);

let strlit_0_I4798194433225830700_tagygirdh1 = allocFixed(21);

let strlit_0_I13657782612448101767_tagygirdh1 = allocFixed(23);

let strlit_0_I7138112740281612668_tagygirdh1 = allocFixed(16);

let strlit_0_I3788100829446300327_tagygirdh1 = allocFixed(16);

let strlit_0_I6579479052981869920_tagygirdh1 = allocFixed(17);

let strlit_0_I6244821402565232963_tagygirdh1 = allocFixed(19);

let strlit_0_I18424387959777996651_tagygirdh1 = allocFixed(18);

let strlit_0_I6548618541054097076_tagygirdh1 = allocFixed(28);

let strlit_0_I17367998397186134261_tagygirdh1 = allocFixed(30);

let strlit_0_I14845204679832807538_tagygirdh1 = allocFixed(18);

let strlit_0_I1529704942889178144_tagygirdh1 = allocFixed(16);

let strlit_0_I17844812131497141662_tagygirdh1 = allocFixed(18);

let strlit_0_I8800776328647009306_tagygirdh1 = allocFixed(19);

let strlit_0_I13747405705720498495_tagygirdh1 = allocFixed(16);

let strlit_0_I16441971418298468310_tagygirdh1 = allocFixed(20);

let strlit_0_I12645659207852971310_tagygirdh1 = allocFixed(17);

let strlit_0_I10542467331015004416_tagygirdh1 = allocFixed(17);

let strlit_0_I17913492178188134841_tagygirdh1 = allocFixed(19);

let strlit_0_I6332049561104653135_tagygirdh1 = allocFixed(16);

let strlit_0_I5677487675071849914_tagygirdh1 = allocFixed(27);

let strlit_0_I658303038766644256_tagygirdh1 = allocFixed(27);

let strlit_0_I16836303070383946558_tagygirdh1 = allocFixed(20);

let strlit_0_I17551943502627385610_tagygirdh1 = allocFixed(22);

let strlit_0_I17279576536099861747_tagygirdh1 = allocFixed(18);

let strlit_0_I14680152901758819216_tagygirdh1 = allocFixed(16);

let strlit_0_I8457648535047856405_tagygirdh1 = allocFixed(19);

let strlit_0_I6383115151635694985_tagygirdh1 = allocFixed(18);

let strlit_0_I10191413032959885349_tagygirdh1 = allocFixed(21);

let TagData_0_tagygirdh1 = allocFixed(4104);

let strlit_0_I17487054685970555778_nifh7u8pu1 = allocFixed(87);

let ErrT_0_nifh7u8pu1;

let strlit_0_I6105018409752412263_jsovezijp1 = allocFixed(28);

let strlit_0_I4645790987703279553_jsovezijp1 = allocFixed(16);

let strlit_0_I8572766038233537570_jsovezijp1 = allocFixed(16);

let strlit_0_I3372626016653902757_jsovezijp1 = allocFixed(17);

let strlit_0_I10470613477459003309_webzywwor1 = allocFixed(20);

let strlit_0_I18338797071087941219_webzywwor1 = allocFixed(20);

let strlit_0_I7115103054454119625_webzywwor1 = allocFixed(19);

let strlit_0_I5516792017268448510_webzywwor1 = allocFixed(19);

let strlit_0_I15258652501822522767_webzywwor1 = allocFixed(20);

let strlit_0_I6357233917619117690_webzywwor1 = allocFixed(20);

let strlit_0_I13311128126112205167_webzywwor1 = allocFixed(22);

let strlit_0_I11346633816202967245_webzywwor1 = allocFixed(22);

let strlit_0_I18397792016458084092_webzywwor1 = allocFixed(23);

let strlit_0_I1659971858173592857_webzywwor1 = allocFixed(16);

let strlit_0_I6882413722212972495_webzywwor1 = allocFixed(24);

let strlit_0_I6897676049549612864_webzywwor1 = allocFixed(23);

let strlit_0_I8657126274509049065_webzywwor1 = allocFixed(26);

let strlit_0_I15164540674592437306_webzywwor1 = allocFixed(21);

let strlit_0_I11516840874723150973_webzywwor1 = allocFixed(20);

let strlit_0_I14678923973705549773_webzywwor1 = allocFixed(20);

let strlit_0_I3797851616484695037_webzywwor1 = allocFixed(20);

let strlit_0_I10769702410228802904_webzywwor1 = allocFixed(17);

let strlit_0_I11377223362901306853_webzywwor1 = allocFixed(17);

let strlit_0_I18430562373120102550_webzywwor1 = allocFixed(32);

let strlit_0_I16664880105326712979_webzywwor1 = allocFixed(22);

let strlit_0_I10392742912375124130_webzywwor1 = allocFixed(20);

let strlit_0_I947128178696304755_webzywwor1 = allocFixed(20);

let strlit_0_I15750996627617194403_cmdqs323n1 = allocFixed(31);

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

let strlit_0_I14694606176902936784_has9tn57v = allocFixed(104);

mem.setI32(strlit_0_I16254714811886502893_party5a2l1, 5);

mem.setI32((strlit_0_I16254714811886502893_party5a2l1 + 4), 0);

mem.setI32((strlit_0_I16254714811886502893_party5a2l1 + 8), 0);

mem.writeStr((strlit_0_I16254714811886502893_party5a2l1 + 12), "e+000");

NoLineInfo_0_linxafkvx1 = 0;

NoFile_0_linxafkvx1 = 0;

mem.setI32(strlit_0_I15885164768026998599_nif81dubp1, 12);

mem.setI32((strlit_0_I15885164768026998599_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I15885164768026998599_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I15885164768026998599_nif81dubp1 + 12), "UnknownToken");

mem.setI32(strlit_0_I10315536999831874058_nif81dubp1, 8);

mem.setI32((strlit_0_I10315536999831874058_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I10315536999831874058_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I10315536999831874058_nif81dubp1 + 12), "EofToken");

mem.setI32(strlit_0_I934207063279194918_nif81dubp1, 8);

mem.setI32((strlit_0_I934207063279194918_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I934207063279194918_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I934207063279194918_nif81dubp1 + 12), "DotToken");

mem.setI32(strlit_0_I15846002265446469276_nif81dubp1, 5);

mem.setI32((strlit_0_I15846002265446469276_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I15846002265446469276_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I15846002265446469276_nif81dubp1 + 12), "Ident");

mem.setI32(strlit_0_I7416088036152788789_nif81dubp1, 6);

mem.setI32((strlit_0_I7416088036152788789_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I7416088036152788789_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I7416088036152788789_nif81dubp1 + 12), "Symbol");

mem.setI32(strlit_0_I15873059642980454073_nif81dubp1, 9);

mem.setI32((strlit_0_I15873059642980454073_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I15873059642980454073_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I15873059642980454073_nif81dubp1 + 12), "SymbolDef");

mem.setI32(strlit_0_I7185474113853794403_nif81dubp1, 9);

mem.setI32((strlit_0_I7185474113853794403_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I7185474113853794403_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I7185474113853794403_nif81dubp1 + 12), "StringLit");

mem.setI32(strlit_0_I2368852795644526164_nif81dubp1, 7);

mem.setI32((strlit_0_I2368852795644526164_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I2368852795644526164_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I2368852795644526164_nif81dubp1 + 12), "CharLit");

mem.setI32(strlit_0_I17216697482861734393_nif81dubp1, 6);

mem.setI32((strlit_0_I17216697482861734393_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I17216697482861734393_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I17216697482861734393_nif81dubp1 + 12), "IntLit");

mem.setI32(strlit_0_I16169252050837114447_nif81dubp1, 7);

mem.setI32((strlit_0_I16169252050837114447_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I16169252050837114447_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I16169252050837114447_nif81dubp1 + 12), "UIntLit");

mem.setI32(strlit_0_I2526583260401622044_nif81dubp1, 8);

mem.setI32((strlit_0_I2526583260401622044_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I2526583260401622044_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I2526583260401622044_nif81dubp1 + 12), "FloatLit");

mem.setI32(strlit_0_I3677393315539012384_nif81dubp1, 5);

mem.setI32((strlit_0_I3677393315539012384_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I3677393315539012384_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I3677393315539012384_nif81dubp1 + 12), "ParLe");

mem.setI32(strlit_0_I2186592322655248559_nif81dubp1, 5);

mem.setI32((strlit_0_I2186592322655248559_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I2186592322655248559_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I2186592322655248559_nif81dubp1 + 12), "ParRi");

mem.setI32(strlit_0_I7773138664102327703_nif81dubp1, 37);

mem.setI32((strlit_0_I7773138664102327703_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I7773138664102327703_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I7773138664102327703_nif81dubp1 + 12), "Parsed integer outside of valid range");

mem.setI32(strlit_0_I10426215507333234367_nif81dubp1, 23);

mem.setI32((strlit_0_I10426215507333234367_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I10426215507333234367_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I10426215507333234367_nif81dubp1 + 12), "keep it as UnknownToken");

mem.setI32(strlit_0_I397779028761265335_nif81dubp1, 8);

mem.setI32((strlit_0_I397779028761265335_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I397779028761265335_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I397779028761265335_nif81dubp1 + 12), ".indexat");

mem.setI32(strlit_0_I12979507887005580180_nif81dubp1, 11);

mem.setI32((strlit_0_I12979507887005580180_nif81dubp1 + 4), 0);

mem.setI32((strlit_0_I12979507887005580180_nif81dubp1 + 8), 0);

mem.writeStr((strlit_0_I12979507887005580180_nif81dubp1 + 12), ".unusedname");

mem.setU8(ControlChars_0_nif81dubp1, 0);

mem.setU8((ControlChars_0_nif81dubp1 + 1), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 2), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 3), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 4), 140);

mem.setU8((ControlChars_0_nif81dubp1 + 5), 3);

mem.setU8((ControlChars_0_nif81dubp1 + 6), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 7), 4);

mem.setU8((ControlChars_0_nif81dubp1 + 8), 1);

mem.setU8((ControlChars_0_nif81dubp1 + 9), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 10), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 11), 40);

mem.setU8((ControlChars_0_nif81dubp1 + 12), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 13), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 14), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 15), 104);

mem.setU8((ControlChars_0_nif81dubp1 + 16), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 17), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 18), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 19), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 20), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 21), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 22), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 23), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 24), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 25), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 26), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 27), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 28), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 29), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 30), 0);

mem.setU8((ControlChars_0_nif81dubp1 + 31), 0);

mem.setU8(ControlCharsOrWhite_0_nif81dubp1, 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 1), 38);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 2), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 3), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 4), 141);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 5), 3);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 6), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 7), 4);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 8), 1);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 9), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 10), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 11), 40);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 12), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 13), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 14), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 15), 104);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 16), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 17), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 18), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 19), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 20), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 21), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 22), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 23), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 24), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 25), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 26), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 27), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 28), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 29), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 30), 0);

mem.setU8((ControlCharsOrWhite_0_nif81dubp1 + 31), 0);

mem.setU8(HexChars_0_nif81dubp1, 0);

mem.setU8((HexChars_0_nif81dubp1 + 1), 0);

mem.setU8((HexChars_0_nif81dubp1 + 2), 0);

mem.setU8((HexChars_0_nif81dubp1 + 3), 0);

mem.setU8((HexChars_0_nif81dubp1 + 4), 0);

mem.setU8((HexChars_0_nif81dubp1 + 5), 0);

mem.setU8((HexChars_0_nif81dubp1 + 6), 255);

mem.setU8((HexChars_0_nif81dubp1 + 7), 3);

mem.setU8((HexChars_0_nif81dubp1 + 8), 126);

mem.setU8((HexChars_0_nif81dubp1 + 9), 0);

mem.setU8((HexChars_0_nif81dubp1 + 10), 0);

mem.setU8((HexChars_0_nif81dubp1 + 11), 0);

mem.setU8((HexChars_0_nif81dubp1 + 12), 0);

mem.setU8((HexChars_0_nif81dubp1 + 13), 0);

mem.setU8((HexChars_0_nif81dubp1 + 14), 0);

mem.setU8((HexChars_0_nif81dubp1 + 15), 0);

mem.setU8((HexChars_0_nif81dubp1 + 16), 0);

mem.setU8((HexChars_0_nif81dubp1 + 17), 0);

mem.setU8((HexChars_0_nif81dubp1 + 18), 0);

mem.setU8((HexChars_0_nif81dubp1 + 19), 0);

mem.setU8((HexChars_0_nif81dubp1 + 20), 0);

mem.setU8((HexChars_0_nif81dubp1 + 21), 0);

mem.setU8((HexChars_0_nif81dubp1 + 22), 0);

mem.setU8((HexChars_0_nif81dubp1 + 23), 0);

mem.setU8((HexChars_0_nif81dubp1 + 24), 0);

mem.setU8((HexChars_0_nif81dubp1 + 25), 0);

mem.setU8((HexChars_0_nif81dubp1 + 26), 0);

mem.setU8((HexChars_0_nif81dubp1 + 27), 0);

mem.setU8((HexChars_0_nif81dubp1 + 28), 0);

mem.setU8((HexChars_0_nif81dubp1 + 29), 0);

mem.setU8((HexChars_0_nif81dubp1 + 30), 0);

mem.setU8((HexChars_0_nif81dubp1 + 31), 0);

mem.setU8(Digits_0_nif81dubp1, 0);

mem.setU8((Digits_0_nif81dubp1 + 1), 0);

mem.setU8((Digits_0_nif81dubp1 + 2), 0);

mem.setU8((Digits_0_nif81dubp1 + 3), 0);

mem.setU8((Digits_0_nif81dubp1 + 4), 0);

mem.setU8((Digits_0_nif81dubp1 + 5), 0);

mem.setU8((Digits_0_nif81dubp1 + 6), 255);

mem.setU8((Digits_0_nif81dubp1 + 7), 3);

mem.setU8((Digits_0_nif81dubp1 + 8), 0);

mem.setU8((Digits_0_nif81dubp1 + 9), 0);

mem.setU8((Digits_0_nif81dubp1 + 10), 0);

mem.setU8((Digits_0_nif81dubp1 + 11), 0);

mem.setU8((Digits_0_nif81dubp1 + 12), 0);

mem.setU8((Digits_0_nif81dubp1 + 13), 0);

mem.setU8((Digits_0_nif81dubp1 + 14), 0);

mem.setU8((Digits_0_nif81dubp1 + 15), 0);

mem.setU8((Digits_0_nif81dubp1 + 16), 0);

mem.setU8((Digits_0_nif81dubp1 + 17), 0);

mem.setU8((Digits_0_nif81dubp1 + 18), 0);

mem.setU8((Digits_0_nif81dubp1 + 19), 0);

mem.setU8((Digits_0_nif81dubp1 + 20), 0);

mem.setU8((Digits_0_nif81dubp1 + 21), 0);

mem.setU8((Digits_0_nif81dubp1 + 22), 0);

mem.setU8((Digits_0_nif81dubp1 + 23), 0);

mem.setU8((Digits_0_nif81dubp1 + 24), 0);

mem.setU8((Digits_0_nif81dubp1 + 25), 0);

mem.setU8((Digits_0_nif81dubp1 + 26), 0);

mem.setU8((Digits_0_nif81dubp1 + 27), 0);

mem.setU8((Digits_0_nif81dubp1 + 28), 0);

mem.setU8((Digits_0_nif81dubp1 + 29), 0);

mem.setU8((Digits_0_nif81dubp1 + 30), 0);

mem.setU8((Digits_0_nif81dubp1 + 31), 0);

mem.setU8(B62Digits_0_nif81dubp1, 0);

mem.setU8((B62Digits_0_nif81dubp1 + 1), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 2), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 3), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 4), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 5), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 6), 255);

mem.setU8((B62Digits_0_nif81dubp1 + 7), 3);

mem.setU8((B62Digits_0_nif81dubp1 + 8), 254);

mem.setU8((B62Digits_0_nif81dubp1 + 9), 255);

mem.setU8((B62Digits_0_nif81dubp1 + 10), 255);

mem.setU8((B62Digits_0_nif81dubp1 + 11), 7);

mem.setU8((B62Digits_0_nif81dubp1 + 12), 254);

mem.setU8((B62Digits_0_nif81dubp1 + 13), 255);

mem.setU8((B62Digits_0_nif81dubp1 + 14), 255);

mem.setU8((B62Digits_0_nif81dubp1 + 15), 7);

mem.setU8((B62Digits_0_nif81dubp1 + 16), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 17), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 18), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 19), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 20), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 21), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 22), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 23), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 24), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 25), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 26), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 27), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 28), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 29), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 30), 0);

mem.setU8((B62Digits_0_nif81dubp1 + 31), 0);

mem.setI32(strlit_0_I3807893400126689806_nifb6mq6y1, 14);

mem.setI32((strlit_0_I3807893400126689806_nifb6mq6y1 + 4), 0);

mem.setI32((strlit_0_I3807893400126689806_nifb6mq6y1 + 8), 0);

mem.writeStr((strlit_0_I3807893400126689806_nifb6mq6y1 + 12), "cursor at end?");

mem.setI32(strlit_0_I302546433272327396_nifb6mq6y1, 83);

mem.setI32((strlit_0_I302546433272327396_nifb6mq6y1 + 4), 0);

mem.setI32((strlit_0_I302546433272327396_nifb6mq6y1 + 8), 0);

mem.writeStr((strlit_0_I302546433272327396_nifb6mq6y1 + 12), "../nimony/lib/std/system/seqimpl.nim(172, 42): i < uint32(s.len) [AssertionDefect]\n");

mem.setI32(strlit_0_I13319536120588890513_nifb6mq6y1, 83);

mem.setI32((strlit_0_I13319536120588890513_nifb6mq6y1 + 4), 0);

mem.setI32((strlit_0_I13319536120588890513_nifb6mq6y1 + 8), 0);

mem.writeStr((strlit_0_I13319536120588890513_nifb6mq6y1 + 12), "../nimony/lib/std/system/seqimpl.nim(174, 54): i < uint32(s.len) [AssertionDefect]\n");

mem.setI32(strlit_0_I8031254106179394417_dir38pj6l, 24);

mem.setI32((strlit_0_I8031254106179394417_dir38pj6l + 4), 0);

mem.setI32((strlit_0_I8031254106179394417_dir38pj6l + 8), 0);

mem.writeStr((strlit_0_I8031254106179394417_dir38pj6l + 12), "ignore runnable examples");

mem.setI32(strlit_0_I14872370265633446329_str7j0ifg, 88);

mem.setI32((strlit_0_I14872370265633446329_str7j0ifg + 4), 0);

mem.setI32((strlit_0_I14872370265633446329_str7j0ifg + 8), 0);

mem.writeStr((strlit_0_I14872370265633446329_str7j0ifg + 12), "../nimony/lib/std/system/openarrays.nim(12, 59): 0 <= i and i < x.len [AssertionDefect]\n");

mem.setI32(strlit_0_I14532204288076119502_envto7w6l1, 86);

mem.setI32((strlit_0_I14532204288076119502_envto7w6l1 + 4), 0);

mem.setI32((strlit_0_I14532204288076119502_envto7w6l1 + 8), 0);

mem.writeStr((strlit_0_I14532204288076119502_envto7w6l1 + 12), "../nimony/lib/std/system/seqimpl.nim(167, 41): i < s.len and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I14676000009897902695_assy765wm, 20);

mem.setI32((strlit_0_I14676000009897902695_assy765wm + 4), 0);

mem.setI32((strlit_0_I14676000009897902695_assy765wm + 8), 0);

mem.writeStr((strlit_0_I14676000009897902695_assy765wm + 12), "[Assertion Failure] ");

mem.setI32(strlit_0_I10295616015915542771_tagygirdh1, 12);

mem.setI32((strlit_0_I10295616015915542771_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10295616015915542771_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10295616015915542771_tagygirdh1 + 12), "InvalidTagId");

mem.setI32(strlit_0_I8939511674443647382_tagygirdh1, 5);

mem.setI32((strlit_0_I8939511674443647382_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8939511674443647382_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8939511674443647382_tagygirdh1 + 12), "deref");

mem.setI32(strlit_0_I9557201018976274010_tagygirdh1, 4);

mem.setI32((strlit_0_I9557201018976274010_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9557201018976274010_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9557201018976274010_tagygirdh1 + 12), "addr");

mem.setI32(strlit_0_I12905769428011359788_tagygirdh1, 6);

mem.setI32((strlit_0_I12905769428011359788_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12905769428011359788_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12905769428011359788_tagygirdh1 + 12), "notnil");

mem.setI32(strlit_0_I1477227973970526752_tagygirdh1, 9);

mem.setI32((strlit_0_I1477227973970526752_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1477227973970526752_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1477227973970526752_tagygirdh1 + 12), "unchecked");

mem.setI32(strlit_0_I186799702831424311_tagygirdh1, 6);

mem.setI32((strlit_0_I186799702831424311_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I186799702831424311_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I186799702831424311_tagygirdh1 + 12), "neginf");

mem.setI32(strlit_0_I14042222260391466396_tagygirdh1, 6);

mem.setI32((strlit_0_I14042222260391466396_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14042222260391466396_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14042222260391466396_tagygirdh1 + 12), "sizeof");

mem.setI32(strlit_0_I6690414846038512979_tagygirdh1, 7);

mem.setI32((strlit_0_I6690414846038512979_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6690414846038512979_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6690414846038512979_tagygirdh1 + 12), "alignof");

mem.setI32(strlit_0_I16910581458008155537_tagygirdh1, 8);

mem.setI32((strlit_0_I16910581458008155537_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16910581458008155537_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16910581458008155537_tagygirdh1 + 12), "offsetof");

mem.setI32(strlit_0_I7084116572891045059_tagygirdh1, 7);

mem.setI32((strlit_0_I7084116572891045059_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7084116572891045059_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7084116572891045059_tagygirdh1 + 12), "oconstr");

mem.setI32(strlit_0_I17573272885368898989_tagygirdh1, 7);

mem.setI32((strlit_0_I17573272885368898989_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17573272885368898989_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17573272885368898989_tagygirdh1 + 12), "aconstr");

mem.setI32(strlit_0_I14055597598996035090_tagygirdh1, 7);

mem.setI32((strlit_0_I14055597598996035090_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14055597598996035090_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14055597598996035090_tagygirdh1 + 12), "bracket");

mem.setI32(strlit_0_I10209608037894561257_tagygirdh1, 5);

mem.setI32((strlit_0_I10209608037894561257_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10209608037894561257_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10209608037894561257_tagygirdh1 + 12), "curly");

mem.setI32(strlit_0_I14293528690183020870_tagygirdh1, 7);

mem.setI32((strlit_0_I14293528690183020870_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14293528690183020870_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14293528690183020870_tagygirdh1 + 12), "curlyat");

mem.setI32(strlit_0_I12320098920117258102_tagygirdh1, 6);

mem.setI32((strlit_0_I12320098920117258102_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12320098920117258102_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12320098920117258102_tagygirdh1 + 12), "bitand");

mem.setI32(strlit_0_I8344472873800577395_tagygirdh1, 5);

mem.setI32((strlit_0_I8344472873800577395_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8344472873800577395_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8344472873800577395_tagygirdh1 + 12), "bitor");

mem.setI32(strlit_0_I1868900624481666580_tagygirdh1, 6);

mem.setI32((strlit_0_I1868900624481666580_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1868900624481666580_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1868900624481666580_tagygirdh1 + 12), "bitxor");

mem.setI32(strlit_0_I6041839086284145320_tagygirdh1, 6);

mem.setI32((strlit_0_I6041839086284145320_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6041839086284145320_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6041839086284145320_tagygirdh1 + 12), "bitnot");

mem.setI32(strlit_0_I13909093427330098489_tagygirdh1, 4);

mem.setI32((strlit_0_I13909093427330098489_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13909093427330098489_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13909093427330098489_tagygirdh1 + 12), "cast");

mem.setI32(strlit_0_I2501487269769466366_tagygirdh1, 4);

mem.setI32((strlit_0_I2501487269769466366_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2501487269769466366_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2501487269769466366_tagygirdh1 + 12), "conv");

mem.setI32(strlit_0_I1707222714195181991_tagygirdh1, 4);

mem.setI32((strlit_0_I1707222714195181991_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1707222714195181991_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1707222714195181991_tagygirdh1 + 12), "call");

mem.setI32(strlit_0_I16597999082088934835_tagygirdh1, 5);

mem.setI32((strlit_0_I16597999082088934835_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16597999082088934835_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16597999082088934835_tagygirdh1 + 12), "range");

mem.setI32(strlit_0_I10760563625686142994_tagygirdh1, 6);

mem.setI32((strlit_0_I10760563625686142994_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10760563625686142994_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10760563625686142994_tagygirdh1 + 12), "ranges");

mem.setI32(strlit_0_I1281801651151844468_tagygirdh1, 4);

mem.setI32((strlit_0_I1281801651151844468_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1281801651151844468_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1281801651151844468_tagygirdh1 + 12), "gvar");

mem.setI32(strlit_0_I13046452236886743244_tagygirdh1, 4);

mem.setI32((strlit_0_I13046452236886743244_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13046452236886743244_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13046452236886743244_tagygirdh1 + 12), "tvar");

mem.setI32(strlit_0_I9792473688321036479_tagygirdh1, 5);

mem.setI32((strlit_0_I9792473688321036479_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9792473688321036479_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9792473688321036479_tagygirdh1 + 12), "param");

mem.setI32(strlit_0_I12999086881046019782_tagygirdh1, 5);

mem.setI32((strlit_0_I12999086881046019782_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12999086881046019782_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12999086881046019782_tagygirdh1 + 12), "const");

mem.setI32(strlit_0_I2416437014800228590_tagygirdh1, 6);

mem.setI32((strlit_0_I2416437014800228590_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2416437014800228590_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2416437014800228590_tagygirdh1 + 12), "result");

mem.setI32(strlit_0_I5723805845286553140_tagygirdh1, 4);

mem.setI32((strlit_0_I5723805845286553140_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5723805845286553140_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5723805845286553140_tagygirdh1 + 12), "glet");

mem.setI32(strlit_0_I7233319822780473912_tagygirdh1, 4);

mem.setI32((strlit_0_I7233319822780473912_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7233319822780473912_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7233319822780473912_tagygirdh1 + 12), "tlet");

mem.setI32(strlit_0_I17735862253056247523_tagygirdh1, 6);

mem.setI32((strlit_0_I17735862253056247523_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17735862253056247523_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17735862253056247523_tagygirdh1 + 12), "cursor");

mem.setI32(strlit_0_I3786558325628924612_tagygirdh1, 10);

mem.setI32((strlit_0_I3786558325628924612_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3786558325628924612_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3786558325628924612_tagygirdh1 + 12), "patternvar");

mem.setI32(strlit_0_I3759916806223351059_tagygirdh1, 7);

mem.setI32((strlit_0_I3759916806223351059_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3759916806223351059_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3759916806223351059_tagygirdh1 + 12), "typevar");

mem.setI32(strlit_0_I15385401366416332649_tagygirdh1, 13);

mem.setI32((strlit_0_I15385401366416332649_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15385401366416332649_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15385401366416332649_tagygirdh1 + 12), "staticTypevar");

mem.setI32(strlit_0_I2171368188661376471_tagygirdh1, 4);

mem.setI32((strlit_0_I2171368188661376471_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2171368188661376471_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2171368188661376471_tagygirdh1 + 12), "efld");

mem.setI32(strlit_0_I17496857845421750549_tagygirdh1, 4);

mem.setI32((strlit_0_I17496857845421750549_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17496857845421750549_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17496857845421750549_tagygirdh1 + 12), "gfld");

mem.setI32(strlit_0_I5316556160589403975_tagygirdh1, 4);

mem.setI32((strlit_0_I5316556160589403975_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5316556160589403975_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5316556160589403975_tagygirdh1 + 12), "proc");

mem.setI32(strlit_0_I9991102891510134496_tagygirdh1, 4);

mem.setI32((strlit_0_I9991102891510134496_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9991102891510134496_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9991102891510134496_tagygirdh1 + 12), "func");

mem.setI32(strlit_0_I9071657656589967445_tagygirdh1, 8);

mem.setI32((strlit_0_I9071657656589967445_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9071657656589967445_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9071657656589967445_tagygirdh1 + 12), "iterator");

mem.setI32(strlit_0_I6864681898360807206_tagygirdh1, 9);

mem.setI32((strlit_0_I6864681898360807206_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6864681898360807206_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6864681898360807206_tagygirdh1 + 12), "converter");

mem.setI32(strlit_0_I6517805684605582485_tagygirdh1, 6);

mem.setI32((strlit_0_I6517805684605582485_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6517805684605582485_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6517805684605582485_tagygirdh1 + 12), "method");

mem.setI32(strlit_0_I3777428167486794959_tagygirdh1, 5);

mem.setI32((strlit_0_I3777428167486794959_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3777428167486794959_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3777428167486794959_tagygirdh1 + 12), "macro");

mem.setI32(strlit_0_I17987658270787974407_tagygirdh1, 8);

mem.setI32((strlit_0_I17987658270787974407_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17987658270787974407_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17987658270787974407_tagygirdh1 + 12), "template");

mem.setI32(strlit_0_I13413619771642637377_tagygirdh1, 4);

mem.setI32((strlit_0_I13413619771642637377_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13413619771642637377_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13413619771642637377_tagygirdh1 + 12), "type");

mem.setI32(strlit_0_I9830314142150548690_tagygirdh1, 5);

mem.setI32((strlit_0_I9830314142150548690_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9830314142150548690_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9830314142150548690_tagygirdh1 + 12), "block");

mem.setI32(strlit_0_I6605162211648777506_tagygirdh1, 6);

mem.setI32((strlit_0_I6605162211648777506_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6605162211648777506_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6605162211648777506_tagygirdh1 + 12), "module");

mem.setI32(strlit_0_I7132977312474535290_tagygirdh1, 7);

mem.setI32((strlit_0_I7132977312474535290_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7132977312474535290_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7132977312474535290_tagygirdh1 + 12), "cchoice");

mem.setI32(strlit_0_I7981495708050792894_tagygirdh1, 7);

mem.setI32((strlit_0_I7981495708050792894_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7981495708050792894_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7981495708050792894_tagygirdh1 + 12), "ochoice");

mem.setI32(strlit_0_I1572551130627868563_tagygirdh1, 4);

mem.setI32((strlit_0_I1572551130627868563_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1572551130627868563_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1572551130627868563_tagygirdh1 + 12), "emit");

mem.setI32(strlit_0_I2681092370707159476_tagygirdh1, 4);

mem.setI32((strlit_0_I2681092370707159476_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2681092370707159476_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2681092370707159476_tagygirdh1 + 12), "asgn");

mem.setI32(strlit_0_I5487391404206283781_tagygirdh1, 5);

mem.setI32((strlit_0_I5487391404206283781_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5487391404206283781_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5487391404206283781_tagygirdh1 + 12), "store");

mem.setI32(strlit_0_I6800807151669219983_tagygirdh1, 7);

mem.setI32((strlit_0_I6800807151669219983_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6800807151669219983_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6800807151669219983_tagygirdh1 + 12), "keepovf");

mem.setI32(strlit_0_I110166545589372112_tagygirdh1, 5);

mem.setI32((strlit_0_I110166545589372112_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I110166545589372112_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I110166545589372112_tagygirdh1 + 12), "scope");

mem.setI32(strlit_0_I14781640258047403316_tagygirdh1, 4);

mem.setI32((strlit_0_I14781640258047403316_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14781640258047403316_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14781640258047403316_tagygirdh1 + 12), "when");

mem.setI32(strlit_0_I13424873862977158440_tagygirdh1, 4);

mem.setI32((strlit_0_I13424873862977158440_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13424873862977158440_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13424873862977158440_tagygirdh1 + 12), "elif");

mem.setI32(strlit_0_I4167480082662538754_tagygirdh1, 4);

mem.setI32((strlit_0_I4167480082662538754_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4167480082662538754_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4167480082662538754_tagygirdh1 + 12), "else");

mem.setI32(strlit_0_I14656641239204103783_tagygirdh1, 8);

mem.setI32((strlit_0_I14656641239204103783_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14656641239204103783_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14656641239204103783_tagygirdh1 + 12), "typevars");

mem.setI32(strlit_0_I8380221545607033154_tagygirdh1, 5);

mem.setI32((strlit_0_I8380221545607033154_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8380221545607033154_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8380221545607033154_tagygirdh1 + 12), "break");

mem.setI32(strlit_0_I2210116261907819816_tagygirdh1, 8);

mem.setI32((strlit_0_I2210116261907819816_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2210116261907819816_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2210116261907819816_tagygirdh1 + 12), "continue");

mem.setI32(strlit_0_I13200118161122656888_tagygirdh1, 5);

mem.setI32((strlit_0_I13200118161122656888_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13200118161122656888_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13200118161122656888_tagygirdh1 + 12), "while");

mem.setI32(strlit_0_I10030898066311664679_tagygirdh1, 7);

mem.setI32((strlit_0_I10030898066311664679_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10030898066311664679_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10030898066311664679_tagygirdh1 + 12), "corofor");

mem.setI32(strlit_0_I4956278306908871092_tagygirdh1, 4);

mem.setI32((strlit_0_I4956278306908871092_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4956278306908871092_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4956278306908871092_tagygirdh1 + 12), "case");

mem.setI32(strlit_0_I13752166055203769914_tagygirdh1, 5);

mem.setI32((strlit_0_I13752166055203769914_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13752166055203769914_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13752166055203769914_tagygirdh1 + 12), "stmts");

mem.setI32(strlit_0_I5367917178860180580_tagygirdh1, 6);

mem.setI32((strlit_0_I5367917178860180580_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5367917178860180580_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5367917178860180580_tagygirdh1 + 12), "params");

mem.setI32(strlit_0_I3302612697625453930_tagygirdh1, 5);

mem.setI32((strlit_0_I3302612697625453930_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3302612697625453930_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3302612697625453930_tagygirdh1 + 12), "union");

mem.setI32(strlit_0_I973692718279674627_tagygirdh1, 6);

mem.setI32((strlit_0_I973692718279674627_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I973692718279674627_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I973692718279674627_tagygirdh1 + 12), "object");

mem.setI32(strlit_0_I10462096440466995513_tagygirdh1, 4);

mem.setI32((strlit_0_I10462096440466995513_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10462096440466995513_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10462096440466995513_tagygirdh1 + 12), "enum");

mem.setI32(strlit_0_I1995551610468546737_tagygirdh1, 8);

mem.setI32((strlit_0_I1995551610468546737_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1995551610468546737_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1995551610468546737_tagygirdh1 + 12), "proctype");

mem.setI32(strlit_0_I6755942707126604175_tagygirdh1, 6);

mem.setI32((strlit_0_I6755942707126604175_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6755942707126604175_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6755942707126604175_tagygirdh1 + 12), "atomic");

mem.setI32(strlit_0_I2128687583820536666_tagygirdh1, 8);

mem.setI32((strlit_0_I2128687583820536666_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2128687583820536666_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2128687583820536666_tagygirdh1 + 12), "restrict");

mem.setI32(strlit_0_I1346366660018635533_tagygirdh1, 6);

mem.setI32((strlit_0_I1346366660018635533_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1346366660018635533_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1346366660018635533_tagygirdh1 + 12), "cppref");

mem.setI32(strlit_0_I11024699549390617459_tagygirdh1, 4);

mem.setI32((strlit_0_I11024699549390617459_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11024699549390617459_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11024699549390617459_tagygirdh1 + 12), "bool");

mem.setI32(strlit_0_I11155032387348830029_tagygirdh1, 4);

mem.setI32((strlit_0_I11155032387348830029_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11155032387348830029_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11155032387348830029_tagygirdh1 + 12), "void");

mem.setI32(strlit_0_I1177603226064417776_tagygirdh1, 5);

mem.setI32((strlit_0_I1177603226064417776_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1177603226064417776_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1177603226064417776_tagygirdh1 + 12), "array");

mem.setI32(strlit_0_I13748185565082850274_tagygirdh1, 9);

mem.setI32((strlit_0_I13748185565082850274_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13748185565082850274_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13748185565082850274_tagygirdh1 + 12), "flexarray");

mem.setI32(strlit_0_I6488225283415667707_tagygirdh1, 4);

mem.setI32((strlit_0_I6488225283415667707_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6488225283415667707_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6488225283415667707_tagygirdh1 + 12), "aptr");

mem.setI32(strlit_0_I16188676551779215531_tagygirdh1, 5);

mem.setI32((strlit_0_I16188676551779215531_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16188676551779215531_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16188676551779215531_tagygirdh1 + 12), "cdecl");

mem.setI32(strlit_0_I18234099685676259387_tagygirdh1, 7);

mem.setI32((strlit_0_I18234099685676259387_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18234099685676259387_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18234099685676259387_tagygirdh1 + 12), "stdcall");

mem.setI32(strlit_0_I4481474124438915992_tagygirdh1, 8);

mem.setI32((strlit_0_I4481474124438915992_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4481474124438915992_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4481474124438915992_tagygirdh1 + 12), "safecall");

mem.setI32(strlit_0_I2072093345082808027_tagygirdh1, 7);

mem.setI32((strlit_0_I2072093345082808027_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2072093345082808027_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2072093345082808027_tagygirdh1 + 12), "syscall");

mem.setI32(strlit_0_I3679389138985991790_tagygirdh1, 8);

mem.setI32((strlit_0_I3679389138985991790_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3679389138985991790_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3679389138985991790_tagygirdh1 + 12), "fastcall");

mem.setI32(strlit_0_I17192084538477055045_tagygirdh1, 8);

mem.setI32((strlit_0_I17192084538477055045_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17192084538477055045_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17192084538477055045_tagygirdh1 + 12), "thiscall");

mem.setI32(strlit_0_I13519359689973327992_tagygirdh1, 6);

mem.setI32((strlit_0_I13519359689973327992_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13519359689973327992_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13519359689973327992_tagygirdh1 + 12), "noconv");

mem.setI32(strlit_0_I11811080807945599045_tagygirdh1, 6);

mem.setI32((strlit_0_I11811080807945599045_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11811080807945599045_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11811080807945599045_tagygirdh1 + 12), "member");

mem.setI32(strlit_0_I13738511073829832276_tagygirdh1, 7);

mem.setI32((strlit_0_I13738511073829832276_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13738511073829832276_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13738511073829832276_tagygirdh1 + 12), "nimcall");

mem.setI32(strlit_0_I11734088361827745870_tagygirdh1, 6);

mem.setI32((strlit_0_I11734088361827745870_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11734088361827745870_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11734088361827745870_tagygirdh1 + 12), "inline");

mem.setI32(strlit_0_I9300717802679998862_tagygirdh1, 8);

mem.setI32((strlit_0_I9300717802679998862_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9300717802679998862_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9300717802679998862_tagygirdh1 + 12), "noinline");

mem.setI32(strlit_0_I16971225136864641703_tagygirdh1, 7);

mem.setI32((strlit_0_I16971225136864641703_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16971225136864641703_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16971225136864641703_tagygirdh1 + 12), "closure");

mem.setI32(strlit_0_I8775499903415745325_tagygirdh1, 4);

mem.setI32((strlit_0_I8775499903415745325_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8775499903415745325_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8775499903415745325_tagygirdh1 + 12), "attr");

mem.setI32(strlit_0_I14941751896671455891_tagygirdh1, 4);

mem.setI32((strlit_0_I14941751896671455891_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14941751896671455891_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14941751896671455891_tagygirdh1 + 12), "smry");

mem.setI32(strlit_0_I14150474136931533575_tagygirdh1, 7);

mem.setI32((strlit_0_I14150474136931533575_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14150474136931533575_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14150474136931533575_tagygirdh1 + 12), "varargs");

mem.setI32(strlit_0_I2120471692824576765_tagygirdh1, 9);

mem.setI32((strlit_0_I2120471692824576765_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2120471692824576765_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2120471692824576765_tagygirdh1 + 12), "selectany");

mem.setI32(strlit_0_I7023501325319911082_tagygirdh1, 7);

mem.setI32((strlit_0_I7023501325319911082_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7023501325319911082_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7023501325319911082_tagygirdh1 + 12), "pragmas");

mem.setI32(strlit_0_I17199005983847516849_tagygirdh1, 7);

mem.setI32((strlit_0_I17199005983847516849_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17199005983847516849_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17199005983847516849_tagygirdh1 + 12), "pragmax");

mem.setI32(strlit_0_I3912769065629684841_tagygirdh1, 5);

mem.setI32((strlit_0_I3912769065629684841_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3912769065629684841_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3912769065629684841_tagygirdh1 + 12), "align");

mem.setI32(strlit_0_I4965478555169759111_tagygirdh1, 4);

mem.setI32((strlit_0_I4965478555169759111_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4965478555169759111_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4965478555169759111_tagygirdh1 + 12), "bits");

mem.setI32(strlit_0_I772494771101702043_tagygirdh1, 6);

mem.setI32((strlit_0_I772494771101702043_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I772494771101702043_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I772494771101702043_tagygirdh1 + 12), "vector");

mem.setI32(strlit_0_I9354196862430236195_tagygirdh1, 6);

mem.setI32((strlit_0_I9354196862430236195_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9354196862430236195_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9354196862430236195_tagygirdh1 + 12), "nodecl");

mem.setI32(strlit_0_I14732757010146030568_tagygirdh1, 4);

mem.setI32((strlit_0_I14732757010146030568_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14732757010146030568_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14732757010146030568_tagygirdh1 + 12), "incl");

mem.setI32(strlit_0_I2784804726569183623_tagygirdh1, 4);

mem.setI32((strlit_0_I2784804726569183623_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2784804726569183623_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2784804726569183623_tagygirdh1 + 12), "excl");

mem.setI32(strlit_0_I3312144845751804851_tagygirdh1, 7);

mem.setI32((strlit_0_I3312144845751804851_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3312144845751804851_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3312144845751804851_tagygirdh1 + 12), "include");

mem.setI32(strlit_0_I10578126245728228512_tagygirdh1, 6);

mem.setI32((strlit_0_I10578126245728228512_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10578126245728228512_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10578126245728228512_tagygirdh1 + 12), "import");

mem.setI32(strlit_0_I9191034391941917241_tagygirdh1, 8);

mem.setI32((strlit_0_I9191034391941917241_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9191034391941917241_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9191034391941917241_tagygirdh1 + 12), "importas");

mem.setI32(strlit_0_I3199637833187763350_tagygirdh1, 10);

mem.setI32((strlit_0_I3199637833187763350_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3199637833187763350_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3199637833187763350_tagygirdh1 + 12), "fromimport");

mem.setI32(strlit_0_I16948548629793503007_tagygirdh1, 12);

mem.setI32((strlit_0_I16948548629793503007_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16948548629793503007_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16948548629793503007_tagygirdh1 + 12), "importexcept");

mem.setI32(strlit_0_I6313045265747232047_tagygirdh1, 6);

mem.setI32((strlit_0_I6313045265747232047_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6313045265747232047_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6313045265747232047_tagygirdh1 + 12), "export");

mem.setI32(strlit_0_I15468012182747796806_tagygirdh1, 10);

mem.setI32((strlit_0_I15468012182747796806_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15468012182747796806_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15468012182747796806_tagygirdh1 + 12), "fromexport");

mem.setI32(strlit_0_I7395289177220351871_tagygirdh1, 12);

mem.setI32((strlit_0_I7395289177220351871_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7395289177220351871_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7395289177220351871_tagygirdh1 + 12), "exportexcept");

mem.setI32(strlit_0_I18257730313531980409_tagygirdh1, 7);

mem.setI32((strlit_0_I18257730313531980409_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18257730313531980409_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18257730313531980409_tagygirdh1 + 12), "comment");

mem.setI32(strlit_0_I2956720964102846418_tagygirdh1, 7);

mem.setI32((strlit_0_I2956720964102846418_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2956720964102846418_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2956720964102846418_tagygirdh1 + 12), "discard");

mem.setI32(strlit_0_I6137881024046402116_tagygirdh1, 5);

mem.setI32((strlit_0_I6137881024046402116_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6137881024046402116_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6137881024046402116_tagygirdh1 + 12), "raise");

mem.setI32(strlit_0_I5809186183819720447_tagygirdh1, 5);

mem.setI32((strlit_0_I5809186183819720447_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5809186183819720447_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5809186183819720447_tagygirdh1 + 12), "onerr");

mem.setI32(strlit_0_I10609090264569208189_tagygirdh1, 6);

mem.setI32((strlit_0_I10609090264569208189_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10609090264569208189_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10609090264569208189_tagygirdh1 + 12), "raises");

mem.setI32(strlit_0_I13128250356938898261_tagygirdh1, 4);

mem.setI32((strlit_0_I13128250356938898261_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13128250356938898261_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13128250356938898261_tagygirdh1 + 12), "errs");

mem.setI32(strlit_0_I17569086427026686584_tagygirdh1, 6);

mem.setI32((strlit_0_I17569086427026686584_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17569086427026686584_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17569086427026686584_tagygirdh1 + 12), "static");

mem.setI32(strlit_0_I356330993363212426_tagygirdh1, 4);

mem.setI32((strlit_0_I356330993363212426_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I356330993363212426_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I356330993363212426_tagygirdh1 + 12), "itec");

mem.setI32(strlit_0_I5622496984824462814_tagygirdh1, 4);

mem.setI32((strlit_0_I5622496984824462814_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5622496984824462814_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5622496984824462814_tagygirdh1 + 12), "loop");

mem.setI32(strlit_0_I11470268427441903014_tagygirdh1, 6);

mem.setI32((strlit_0_I11470268427441903014_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11470268427441903014_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11470268427441903014_tagygirdh1 + 12), "etupat");

mem.setI32(strlit_0_I9846635761469100055_tagygirdh1, 7);

mem.setI32((strlit_0_I9846635761469100055_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9846635761469100055_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9846635761469100055_tagygirdh1 + 12), "unknown");

mem.setI32(strlit_0_I7777630149462349779_tagygirdh1, 5);

mem.setI32((strlit_0_I7777630149462349779_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7777630149462349779_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7777630149462349779_tagygirdh1 + 12), "jtrue");

mem.setI32(strlit_0_I1755384972092858986_tagygirdh1, 5);

mem.setI32((strlit_0_I1755384972092858986_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1755384972092858986_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1755384972092858986_tagygirdh1 + 12), "mflag");

mem.setI32(strlit_0_I5825594256536309212_tagygirdh1, 5);

mem.setI32((strlit_0_I5825594256536309212_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5825594256536309212_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5825594256536309212_tagygirdh1 + 12), "vflag");

mem.setI32(strlit_0_I18223875966347257259_tagygirdh1, 6);

mem.setI32((strlit_0_I18223875966347257259_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18223875966347257259_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18223875966347257259_tagygirdh1 + 12), "either");

mem.setI32(strlit_0_I7603755693199836480_tagygirdh1, 4);

mem.setI32((strlit_0_I7603755693199836480_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7603755693199836480_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7603755693199836480_tagygirdh1 + 12), "join");

mem.setI32(strlit_0_I6285446155132737146_tagygirdh1, 5);

mem.setI32((strlit_0_I6285446155132737146_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6285446155132737146_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6285446155132737146_tagygirdh1 + 12), "graph");

mem.setI32(strlit_0_I16485414215621593826_tagygirdh1, 7);

mem.setI32((strlit_0_I16485414215621593826_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16485414215621593826_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16485414215621593826_tagygirdh1 + 12), "forbind");

mem.setI32(strlit_0_I10406234210653353301_tagygirdh1, 4);

mem.setI32((strlit_0_I10406234210653353301_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10406234210653353301_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10406234210653353301_tagygirdh1 + 12), "kill");

mem.setI32(strlit_0_I13179338205702368459_tagygirdh1, 10);

mem.setI32((strlit_0_I13179338205702368459_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13179338205702368459_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13179338205702368459_tagygirdh1 + 12), "unpackflat");

mem.setI32(strlit_0_I1237672436915077942_tagygirdh1, 9);

mem.setI32((strlit_0_I1237672436915077942_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1237672436915077942_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1237672436915077942_tagygirdh1 + 12), "unpacktup");

mem.setI32(strlit_0_I11688738934238820917_tagygirdh1, 8);

mem.setI32((strlit_0_I11688738934238820917_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11688738934238820917_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11688738934238820917_tagygirdh1 + 12), "callargs");

mem.setI32(strlit_0_I2573631453468209738_tagygirdh1, 7);

mem.setI32((strlit_0_I2573631453468209738_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2573631453468209738_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2573631453468209738_tagygirdh1 + 12), "forcall");

mem.setI32(strlit_0_I7731358638274129439_tagygirdh1, 10);

mem.setI32((strlit_0_I7731358638274129439_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7731358638274129439_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7731358638274129439_tagygirdh1 + 12), "unpackdecl");

mem.setI32(strlit_0_I16264910594287870354_tagygirdh1, 6);

mem.setI32((strlit_0_I16264910594287870354_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16264910594287870354_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16264910594287870354_tagygirdh1 + 12), "except");

mem.setI32(strlit_0_I18086024188298164462_tagygirdh1, 5);

mem.setI32((strlit_0_I18086024188298164462_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18086024188298164462_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18086024188298164462_tagygirdh1 + 12), "tuple");

mem.setI32(strlit_0_I3225181402180923291_tagygirdh1, 4);

mem.setI32((strlit_0_I3225181402180923291_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3225181402180923291_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3225181402180923291_tagygirdh1 + 12), "onum");

mem.setI32(strlit_0_I12023767949489687491_tagygirdh1, 4);

mem.setI32((strlit_0_I12023767949489687491_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12023767949489687491_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12023767949489687491_tagygirdh1 + 12), "anum");

mem.setI32(strlit_0_I6008424852838151324_tagygirdh1, 4);

mem.setI32((strlit_0_I6008424852838151324_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6008424852838151324_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6008424852838151324_tagygirdh1 + 12), "lent");

mem.setI32(strlit_0_I5595596763809202512_tagygirdh1, 4);

mem.setI32((strlit_0_I5595596763809202512_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5595596763809202512_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5595596763809202512_tagygirdh1 + 12), "sink");

mem.setI32(strlit_0_I14845240230376595005_tagygirdh1, 4);

mem.setI32((strlit_0_I14845240230376595005_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14845240230376595005_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14845240230376595005_tagygirdh1 + 12), "nilt");

mem.setI32(strlit_0_I2544717250931810611_tagygirdh1, 7);

mem.setI32((strlit_0_I2544717250931810611_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2544717250931810611_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2544717250931810611_tagygirdh1 + 12), "concept");

mem.setI32(strlit_0_I3021806080610957510_tagygirdh1, 8);

mem.setI32((strlit_0_I3021806080610957510_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3021806080610957510_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3021806080610957510_tagygirdh1 + 12), "distinct");

mem.setI32(strlit_0_I15938251790995683266_tagygirdh1, 8);

mem.setI32((strlit_0_I15938251790995683266_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15938251790995683266_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15938251790995683266_tagygirdh1 + 12), "itertype");

mem.setI32(strlit_0_I16393544569146403439_tagygirdh1, 9);

mem.setI32((strlit_0_I16393544569146403439_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16393544569146403439_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16393544569146403439_tagygirdh1 + 12), "rangetype");

mem.setI32(strlit_0_I2984705338531181753_tagygirdh1, 6);

mem.setI32((strlit_0_I2984705338531181753_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2984705338531181753_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2984705338531181753_tagygirdh1 + 12), "uarray");

mem.setI32(strlit_0_I2419004569819514924_tagygirdh1, 4);

mem.setI32((strlit_0_I2419004569819514924_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2419004569819514924_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2419004569819514924_tagygirdh1 + 12), "auto");

mem.setI32(strlit_0_I8265071425581872233_tagygirdh1, 7);

mem.setI32((strlit_0_I8265071425581872233_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8265071425581872233_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8265071425581872233_tagygirdh1 + 12), "symkind");

mem.setI32(strlit_0_I567478400955764617_tagygirdh1, 8);

mem.setI32((strlit_0_I567478400955764617_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I567478400955764617_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I567478400955764617_tagygirdh1 + 12), "typekind");

mem.setI32(strlit_0_I13460298547546882036_tagygirdh1, 8);

mem.setI32((strlit_0_I13460298547546882036_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13460298547546882036_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13460298547546882036_tagygirdh1 + 12), "typedesc");

mem.setI32(strlit_0_I1016912281706840257_tagygirdh1, 7);

mem.setI32((strlit_0_I1016912281706840257_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1016912281706840257_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1016912281706840257_tagygirdh1 + 12), "untyped");

mem.setI32(strlit_0_I9456292052054236016_tagygirdh1, 5);

mem.setI32((strlit_0_I9456292052054236016_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9456292052054236016_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9456292052054236016_tagygirdh1 + 12), "typed");

mem.setI32(strlit_0_I14727864736786204059_tagygirdh1, 7);

mem.setI32((strlit_0_I14727864736786204059_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14727864736786204059_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14727864736786204059_tagygirdh1 + 12), "cstring");

mem.setI32(strlit_0_I6300154543333844069_tagygirdh1, 7);

mem.setI32((strlit_0_I6300154543333844069_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6300154543333844069_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6300154543333844069_tagygirdh1 + 12), "pointer");

mem.setI32(strlit_0_I6616374312433163100_tagygirdh1, 7);

mem.setI32((strlit_0_I6616374312433163100_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6616374312433163100_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6616374312433163100_tagygirdh1 + 12), "ordinal");

mem.setI32(strlit_0_I15788046494547023735_tagygirdh1, 5);

mem.setI32((strlit_0_I15788046494547023735_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15788046494547023735_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15788046494547023735_tagygirdh1 + 12), "magic");

mem.setI32(strlit_0_I3957309170640276402_tagygirdh1, 7);

mem.setI32((strlit_0_I3957309170640276402_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3957309170640276402_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3957309170640276402_tagygirdh1 + 12), "importc");

mem.setI32(strlit_0_I6761535509221812916_tagygirdh1, 9);

mem.setI32((strlit_0_I6761535509221812916_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6761535509221812916_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6761535509221812916_tagygirdh1 + 12), "importcpp");

mem.setI32(strlit_0_I4382311971321061249_tagygirdh1, 6);

mem.setI32((strlit_0_I4382311971321061249_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4382311971321061249_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4382311971321061249_tagygirdh1 + 12), "dynlib");

mem.setI32(strlit_0_I4862850237857511107_tagygirdh1, 7);

mem.setI32((strlit_0_I4862850237857511107_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4862850237857511107_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4862850237857511107_tagygirdh1 + 12), "exportc");

mem.setI32(strlit_0_I2341417231474813780_tagygirdh1, 6);

mem.setI32((strlit_0_I2341417231474813780_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2341417231474813780_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2341417231474813780_tagygirdh1 + 12), "header");

mem.setI32(strlit_0_I11401871840194716403_tagygirdh1, 9);

mem.setI32((strlit_0_I11401871840194716403_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11401871840194716403_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11401871840194716403_tagygirdh1 + 12), "threadvar");

mem.setI32(strlit_0_I5696226971518331620_tagygirdh1, 6);

mem.setI32((strlit_0_I5696226971518331620_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5696226971518331620_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5696226971518331620_tagygirdh1 + 12), "global");

mem.setI32(strlit_0_I1655448968826648425_tagygirdh1, 11);

mem.setI32((strlit_0_I1655448968826648425_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1655448968826648425_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1655448968826648425_tagygirdh1 + 12), "discardable");

mem.setI32(strlit_0_I14428456701869004983_tagygirdh1, 8);

mem.setI32((strlit_0_I14428456701869004983_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14428456701869004983_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14428456701869004983_tagygirdh1 + 12), "noreturn");

mem.setI32(strlit_0_I14004803080881083620_tagygirdh1, 6);

mem.setI32((strlit_0_I14004803080881083620_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14004803080881083620_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14004803080881083620_tagygirdh1 + 12), "borrow");

mem.setI32(strlit_0_I113550637689326195_tagygirdh1, 12);

mem.setI32((strlit_0_I113550637689326195_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I113550637689326195_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I113550637689326195_tagygirdh1 + 12), "noSideEffect");

mem.setI32(strlit_0_I8745041498576622223_tagygirdh1, 9);

mem.setI32((strlit_0_I8745041498576622223_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8745041498576622223_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8745041498576622223_tagygirdh1 + 12), "nodestroy");

mem.setI32(strlit_0_I757997984781066323_tagygirdh1, 6);

mem.setI32((strlit_0_I757997984781066323_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I757997984781066323_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I757997984781066323_tagygirdh1 + 12), "plugin");

mem.setI32(strlit_0_I4859700805551129371_tagygirdh1, 6);

mem.setI32((strlit_0_I4859700805551129371_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4859700805551129371_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4859700805551129371_tagygirdh1 + 12), "bycopy");

mem.setI32(strlit_0_I17285089853291426062_tagygirdh1, 5);

mem.setI32((strlit_0_I17285089853291426062_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17285089853291426062_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17285089853291426062_tagygirdh1 + 12), "byref");

mem.setI32(strlit_0_I3179792478750962635_tagygirdh1, 6);

mem.setI32((strlit_0_I3179792478750962635_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3179792478750962635_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3179792478750962635_tagygirdh1 + 12), "noinit");

mem.setI32(strlit_0_I16730393376288644638_tagygirdh1, 8);

mem.setI32((strlit_0_I16730393376288644638_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16730393376288644638_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16730393376288644638_tagygirdh1 + 12), "requires");

mem.setI32(strlit_0_I5451065444311437237_tagygirdh1, 7);

mem.setI32((strlit_0_I5451065444311437237_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5451065444311437237_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5451065444311437237_tagygirdh1 + 12), "ensures");

mem.setI32(strlit_0_I4604789051338433811_tagygirdh1, 6);

mem.setI32((strlit_0_I4604789051338433811_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4604789051338433811_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4604789051338433811_tagygirdh1 + 12), "assume");

mem.setI32(strlit_0_I12559108835900458521_tagygirdh1, 6);

mem.setI32((strlit_0_I12559108835900458521_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12559108835900458521_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12559108835900458521_tagygirdh1 + 12), "assert");

mem.setI32(strlit_0_I10833596585003541936_tagygirdh1, 5);

mem.setI32((strlit_0_I10833596585003541936_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10833596585003541936_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10833596585003541936_tagygirdh1 + 12), "build");

mem.setI32(strlit_0_I4207864124720532554_tagygirdh1, 7);

mem.setI32((strlit_0_I4207864124720532554_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4207864124720532554_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4207864124720532554_tagygirdh1 + 12), "feature");

mem.setI32(strlit_0_I4511345809429878981_tagygirdh1, 6);

mem.setI32((strlit_0_I4511345809429878981_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4511345809429878981_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4511345809429878981_tagygirdh1 + 12), "string");

mem.setI32(strlit_0_I17993691144359452798_tagygirdh1, 4);

mem.setI32((strlit_0_I17993691144359452798_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17993691144359452798_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17993691144359452798_tagygirdh1 + 12), "view");

mem.setI32(strlit_0_I3557287941175077387_tagygirdh1, 16);

mem.setI32((strlit_0_I3557287941175077387_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3557287941175077387_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3557287941175077387_tagygirdh1 + 12), "incompleteStruct");

mem.setI32(strlit_0_I1290833423478922541_tagygirdh1, 6);

mem.setI32((strlit_0_I1290833423478922541_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1290833423478922541_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1290833423478922541_tagygirdh1 + 12), "quoted");

mem.setI32(strlit_0_I4196580491060784277_tagygirdh1, 6);

mem.setI32((strlit_0_I4196580491060784277_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4196580491060784277_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4196580491060784277_tagygirdh1 + 12), "hderef");

mem.setI32(strlit_0_I14457488926480995039_tagygirdh1, 4);

mem.setI32((strlit_0_I14457488926480995039_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14457488926480995039_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14457488926480995039_tagygirdh1 + 12), "ddot");

mem.setI32(strlit_0_I17469384850928897790_tagygirdh1, 5);

mem.setI32((strlit_0_I17469384850928897790_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17469384850928897790_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17469384850928897790_tagygirdh1 + 12), "haddr");

mem.setI32(strlit_0_I9268166327583521131_tagygirdh1, 6);

mem.setI32((strlit_0_I9268166327583521131_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9268166327583521131_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9268166327583521131_tagygirdh1 + 12), "newref");

mem.setI32(strlit_0_I12337342044224817361_tagygirdh1, 6);

mem.setI32((strlit_0_I12337342044224817361_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12337342044224817361_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12337342044224817361_tagygirdh1 + 12), "newobj");

mem.setI32(strlit_0_I17716058327968275251_tagygirdh1, 9);

mem.setI32((strlit_0_I17716058327968275251_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17716058327968275251_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17716058327968275251_tagygirdh1 + 12), "tupconstr");

mem.setI32(strlit_0_I7358334719788826533_tagygirdh1, 9);

mem.setI32((strlit_0_I7358334719788826533_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7358334719788826533_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7358334719788826533_tagygirdh1 + 12), "setconstr");

mem.setI32(strlit_0_I16361658452647583931_tagygirdh1, 9);

mem.setI32((strlit_0_I16361658452647583931_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16361658452647583931_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16361658452647583931_tagygirdh1 + 12), "tabconstr");

mem.setI32(strlit_0_I4333440046835585584_tagygirdh1, 4);

mem.setI32((strlit_0_I4333440046835585584_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4333440046835585584_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4333440046835585584_tagygirdh1 + 12), "ashr");

mem.setI32(strlit_0_I4543393450896359795_tagygirdh1, 7);

mem.setI32((strlit_0_I4543393450896359795_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4543393450896359795_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4543393450896359795_tagygirdh1 + 12), "baseobj");

mem.setI32(strlit_0_I710932595938440230_tagygirdh1, 5);

mem.setI32((strlit_0_I710932595938440230_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I710932595938440230_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I710932595938440230_tagygirdh1 + 12), "hconv");

mem.setI32(strlit_0_I9667346611828510523_tagygirdh1, 5);

mem.setI32((strlit_0_I9667346611828510523_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9667346611828510523_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9667346611828510523_tagygirdh1 + 12), "dconv");

mem.setI32(strlit_0_I9217337746930322866_tagygirdh1, 10);

mem.setI32((strlit_0_I9217337746930322866_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I9217337746930322866_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I9217337746930322866_tagygirdh1 + 12), "callstrlit");

mem.setI32(strlit_0_I8390060478375454995_tagygirdh1, 5);

mem.setI32((strlit_0_I8390060478375454995_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8390060478375454995_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8390060478375454995_tagygirdh1 + 12), "infix");

mem.setI32(strlit_0_I8954722698363393223_tagygirdh1, 6);

mem.setI32((strlit_0_I8954722698363393223_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8954722698363393223_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8954722698363393223_tagygirdh1 + 12), "prefix");

mem.setI32(strlit_0_I12061648672903694946_tagygirdh1, 5);

mem.setI32((strlit_0_I12061648672903694946_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12061648672903694946_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12061648672903694946_tagygirdh1 + 12), "hcall");

mem.setI32(strlit_0_I15519800790444264650_tagygirdh1, 8);

mem.setI32((strlit_0_I15519800790444264650_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15519800790444264650_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15519800790444264650_tagygirdh1 + 12), "compiles");

mem.setI32(strlit_0_I11246488655541728238_tagygirdh1, 8);

mem.setI32((strlit_0_I11246488655541728238_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11246488655541728238_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11246488655541728238_tagygirdh1 + 12), "declared");

mem.setI32(strlit_0_I15630474019274232734_tagygirdh1, 7);

mem.setI32((strlit_0_I15630474019274232734_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15630474019274232734_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15630474019274232734_tagygirdh1 + 12), "defined");

mem.setI32(strlit_0_I8057664036378742595_tagygirdh1, 8);

mem.setI32((strlit_0_I8057664036378742595_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8057664036378742595_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8057664036378742595_tagygirdh1 + 12), "astToStr");

mem.setI32(strlit_0_I3906464809106688102_tagygirdh1, 7);

mem.setI32((strlit_0_I3906464809106688102_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3906464809106688102_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3906464809106688102_tagygirdh1 + 12), "bindSym");

mem.setI32(strlit_0_I7173319946579796093_tagygirdh1, 11);

mem.setI32((strlit_0_I7173319946579796093_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7173319946579796093_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7173319946579796093_tagygirdh1 + 12), "bindSymName");

mem.setI32(strlit_0_I4161172010043268705_tagygirdh1, 10);

mem.setI32((strlit_0_I4161172010043268705_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4161172010043268705_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4161172010043268705_tagygirdh1 + 12), "instanceof");

mem.setI32(strlit_0_I3485566669610392440_tagygirdh1, 8);

mem.setI32((strlit_0_I3485566669610392440_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3485566669610392440_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3485566669610392440_tagygirdh1 + 12), "proccall");

mem.setI32(strlit_0_I8566804573867139999_tagygirdh1, 4);

mem.setI32((strlit_0_I8566804573867139999_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8566804573867139999_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8566804573867139999_tagygirdh1 + 12), "high");

mem.setI32(strlit_0_I15370501250081784507_tagygirdh1, 6);

mem.setI32((strlit_0_I15370501250081784507_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15370501250081784507_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15370501250081784507_tagygirdh1 + 12), "typeof");

mem.setI32(strlit_0_I17316263578118871722_tagygirdh1, 6);

mem.setI32((strlit_0_I17316263578118871722_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17316263578118871722_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17316263578118871722_tagygirdh1 + 12), "unpack");

mem.setI32(strlit_0_I11931178963942483173_tagygirdh1, 6);

mem.setI32((strlit_0_I11931178963942483173_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11931178963942483173_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11931178963942483173_tagygirdh1 + 12), "fields");

mem.setI32(strlit_0_I5007098554778156607_tagygirdh1, 10);

mem.setI32((strlit_0_I5007098554778156607_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5007098554778156607_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5007098554778156607_tagygirdh1 + 12), "fieldpairs");

mem.setI32(strlit_0_I6307085774546006824_tagygirdh1, 9);

mem.setI32((strlit_0_I6307085774546006824_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6307085774546006824_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6307085774546006824_tagygirdh1 + 12), "enumtostr");

mem.setI32(strlit_0_I15215329021599148827_tagygirdh1, 12);

mem.setI32((strlit_0_I15215329021599148827_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15215329021599148827_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15215329021599148827_tagygirdh1 + 12), "ismainmodule");

mem.setI32(strlit_0_I2499004453702072445_tagygirdh1, 10);

mem.setI32((strlit_0_I2499004453702072445_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I2499004453702072445_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I2499004453702072445_tagygirdh1 + 12), "defaultobj");

mem.setI32(strlit_0_I10155087370267137835_tagygirdh1, 10);

mem.setI32((strlit_0_I10155087370267137835_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10155087370267137835_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10155087370267137835_tagygirdh1 + 12), "defaulttup");

mem.setI32(strlit_0_I5057369592842021125_tagygirdh1, 15);

mem.setI32((strlit_0_I5057369592842021125_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5057369592842021125_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5057369592842021125_tagygirdh1 + 12), "defaultdistinct");

mem.setI32(strlit_0_I358872489388858575_tagygirdh1, 5);

mem.setI32((strlit_0_I358872489388858575_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I358872489388858575_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I358872489388858575_tagygirdh1 + 12), "delay");

mem.setI32(strlit_0_I14418907618963914168_tagygirdh1, 6);

mem.setI32((strlit_0_I14418907618963914168_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14418907618963914168_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14418907618963914168_tagygirdh1 + 12), "delay0");

mem.setI32(strlit_0_I11512946405431690565_tagygirdh1, 7);

mem.setI32((strlit_0_I11512946405431690565_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11512946405431690565_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11512946405431690565_tagygirdh1 + 12), "suspend");

mem.setI32(strlit_0_I13798915436014509391_tagygirdh1, 4);

mem.setI32((strlit_0_I13798915436014509391_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13798915436014509391_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13798915436014509391_tagygirdh1 + 12), "expr");

mem.setI32(strlit_0_I3001676635385606767_tagygirdh1, 5);

mem.setI32((strlit_0_I3001676635385606767_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3001676635385606767_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3001676635385606767_tagygirdh1 + 12), "arrat");

mem.setI32(strlit_0_I5323221927989235116_tagygirdh1, 5);

mem.setI32((strlit_0_I5323221927989235116_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5323221927989235116_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5323221927989235116_tagygirdh1 + 12), "tupat");

mem.setI32(strlit_0_I12557166611382145809_tagygirdh1, 7);

mem.setI32((strlit_0_I12557166611382145809_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12557166611382145809_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12557166611382145809_tagygirdh1 + 12), "plusset");

mem.setI32(strlit_0_I896709357113617264_tagygirdh1, 8);

mem.setI32((strlit_0_I896709357113617264_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I896709357113617264_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I896709357113617264_tagygirdh1 + 12), "minusset");

mem.setI32(strlit_0_I6462229405280805082_tagygirdh1, 6);

mem.setI32((strlit_0_I6462229405280805082_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6462229405280805082_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6462229405280805082_tagygirdh1 + 12), "mulset");

mem.setI32(strlit_0_I11168045910199617169_tagygirdh1, 6);

mem.setI32((strlit_0_I11168045910199617169_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I11168045910199617169_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I11168045910199617169_tagygirdh1 + 12), "xorset");

mem.setI32(strlit_0_I17580784255599249694_tagygirdh1, 5);

mem.setI32((strlit_0_I17580784255599249694_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17580784255599249694_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17580784255599249694_tagygirdh1 + 12), "eqset");

mem.setI32(strlit_0_I7755216903854853291_tagygirdh1, 5);

mem.setI32((strlit_0_I7755216903854853291_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7755216903854853291_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7755216903854853291_tagygirdh1 + 12), "leset");

mem.setI32(strlit_0_I6438757400198936067_tagygirdh1, 5);

mem.setI32((strlit_0_I6438757400198936067_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6438757400198936067_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6438757400198936067_tagygirdh1 + 12), "ltset");

mem.setI32(strlit_0_I17286088029172964552_tagygirdh1, 5);

mem.setI32((strlit_0_I17286088029172964552_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17286088029172964552_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17286088029172964552_tagygirdh1 + 12), "inset");

mem.setI32(strlit_0_I655215872312446365_tagygirdh1, 4);

mem.setI32((strlit_0_I655215872312446365_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I655215872312446365_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I655215872312446365_tagygirdh1 + 12), "card");

mem.setI32(strlit_0_I7330775407653057337_tagygirdh1, 5);

mem.setI32((strlit_0_I7330775407653057337_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7330775407653057337_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7330775407653057337_tagygirdh1 + 12), "emove");

mem.setI32(strlit_0_I12823858650579995313_tagygirdh1, 7);

mem.setI32((strlit_0_I12823858650579995313_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12823858650579995313_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12823858650579995313_tagygirdh1 + 12), "destroy");

mem.setI32(strlit_0_I6996188409796059230_tagygirdh1, 4);

mem.setI32((strlit_0_I6996188409796059230_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6996188409796059230_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6996188409796059230_tagygirdh1 + 12), "copy");

mem.setI32(strlit_0_I10163392937326623266_tagygirdh1, 8);

mem.setI32((strlit_0_I10163392937326623266_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10163392937326623266_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10163392937326623266_tagygirdh1 + 12), "wasmoved");

mem.setI32(strlit_0_I12773303473659224661_tagygirdh1, 5);

mem.setI32((strlit_0_I12773303473659224661_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12773303473659224661_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12773303473659224661_tagygirdh1 + 12), "sinkh");

mem.setI32(strlit_0_I13264932728578201327_tagygirdh1, 5);

mem.setI32((strlit_0_I13264932728578201327_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13264932728578201327_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13264932728578201327_tagygirdh1 + 12), "trace");

mem.setI32(strlit_0_I12050042172059571383_tagygirdh1, 4);

mem.setI32((strlit_0_I12050042172059571383_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12050042172059571383_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12050042172059571383_tagygirdh1 + 12), "errv");

mem.setI32(strlit_0_I4843651051758684618_tagygirdh1, 10);

mem.setI32((strlit_0_I4843651051758684618_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4843651051758684618_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4843651051758684618_tagygirdh1 + 12), "staticstmt");

mem.setI32(strlit_0_I18337270522941735704_tagygirdh1, 4);

mem.setI32((strlit_0_I18337270522941735704_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18337270522941735704_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18337270522941735704_tagygirdh1 + 12), "bind");

mem.setI32(strlit_0_I6669728318263290480_tagygirdh1, 5);

mem.setI32((strlit_0_I6669728318263290480_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6669728318263290480_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6669728318263290480_tagygirdh1 + 12), "mixin");

mem.setI32(strlit_0_I15803870852433253359_tagygirdh1, 5);

mem.setI32((strlit_0_I15803870852433253359_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15803870852433253359_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15803870852433253359_tagygirdh1 + 12), "using");

mem.setI32(strlit_0_I4167773820130397069_tagygirdh1, 5);

mem.setI32((strlit_0_I4167773820130397069_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4167773820130397069_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4167773820130397069_tagygirdh1 + 12), "defer");

mem.setI32(strlit_0_I15907549540151602841_tagygirdh1, 5);

mem.setI32((strlit_0_I15907549540151602841_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15907549540151602841_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15907549540151602841_tagygirdh1 + 12), "index");

mem.setI32(strlit_0_I15673079640947746121_tagygirdh1, 6);

mem.setI32((strlit_0_I15673079640947746121_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15673079640947746121_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15673079640947746121_tagygirdh1 + 12), "inject");

mem.setI32(strlit_0_I18017358057866442883_tagygirdh1, 6);

mem.setI32((strlit_0_I18017358057866442883_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18017358057866442883_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18017358057866442883_tagygirdh1 + 12), "gensym");

mem.setI32(strlit_0_I694217339896490792_tagygirdh1, 5);

mem.setI32((strlit_0_I694217339896490792_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I694217339896490792_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I694217339896490792_tagygirdh1 + 12), "dirty");

mem.setI32(strlit_0_I15516388950515943933_tagygirdh1, 5);

mem.setI32((strlit_0_I15516388950515943933_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15516388950515943933_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15516388950515943933_tagygirdh1 + 12), "error");

mem.setI32(strlit_0_I15352605387219570985_tagygirdh1, 6);

mem.setI32((strlit_0_I15352605387219570985_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I15352605387219570985_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I15352605387219570985_tagygirdh1 + 12), "report");

mem.setI32(strlit_0_I57893748219682234_tagygirdh1, 4);

mem.setI32((strlit_0_I57893748219682234_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I57893748219682234_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I57893748219682234_tagygirdh1 + 12), "tags");

mem.setI32(strlit_0_I7770279929706659123_tagygirdh1, 10);

mem.setI32((strlit_0_I7770279929706659123_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7770279929706659123_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7770279929706659123_tagygirdh1 + 12), "deprecated");

mem.setI32(strlit_0_I6214469262558903647_tagygirdh1, 10);

mem.setI32((strlit_0_I6214469262558903647_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6214469262558903647_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6214469262558903647_tagygirdh1 + 12), "sideEffect");

mem.setI32(strlit_0_I10356331269374273950_tagygirdh1, 16);

mem.setI32((strlit_0_I10356331269374273950_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10356331269374273950_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10356331269374273950_tagygirdh1 + 12), "keepOverflowFlag");

mem.setI32(strlit_0_I4798194433225830700_tagygirdh1, 9);

mem.setI32((strlit_0_I4798194433225830700_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I4798194433225830700_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I4798194433225830700_tagygirdh1 + 12), "semantics");

mem.setI32(strlit_0_I13657782612448101767_tagygirdh1, 11);

mem.setI32((strlit_0_I13657782612448101767_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13657782612448101767_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13657782612448101767_tagygirdh1 + 12), "inheritable");

mem.setI32(strlit_0_I7138112740281612668_tagygirdh1, 4);

mem.setI32((strlit_0_I7138112740281612668_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I7138112740281612668_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I7138112740281612668_tagygirdh1 + 12), "base");

mem.setI32(strlit_0_I3788100829446300327_tagygirdh1, 4);

mem.setI32((strlit_0_I3788100829446300327_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I3788100829446300327_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I3788100829446300327_tagygirdh1 + 12), "pure");

mem.setI32(strlit_0_I6579479052981869920_tagygirdh1, 5);

mem.setI32((strlit_0_I6579479052981869920_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6579479052981869920_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6579479052981869920_tagygirdh1 + 12), "final");

mem.setI32(strlit_0_I6244821402565232963_tagygirdh1, 7);

mem.setI32((strlit_0_I6244821402565232963_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6244821402565232963_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6244821402565232963_tagygirdh1 + 12), "acyclic");

mem.setI32(strlit_0_I18424387959777996651_tagygirdh1, 6);

mem.setI32((strlit_0_I18424387959777996651_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I18424387959777996651_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I18424387959777996651_tagygirdh1 + 12), "pragma");

mem.setI32(strlit_0_I6548618541054097076_tagygirdh1, 16);

mem.setI32((strlit_0_I6548618541054097076_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6548618541054097076_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6548618541054097076_tagygirdh1 + 12), "internalTypeName");

mem.setI32(strlit_0_I17367998397186134261_tagygirdh1, 18);

mem.setI32((strlit_0_I17367998397186134261_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17367998397186134261_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17367998397186134261_tagygirdh1 + 12), "internalFieldPairs");

mem.setI32(strlit_0_I14845204679832807538_tagygirdh1, 6);

mem.setI32((strlit_0_I14845204679832807538_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14845204679832807538_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14845204679832807538_tagygirdh1 + 12), "failed");

mem.setI32(strlit_0_I1529704942889178144_tagygirdh1, 4);

mem.setI32((strlit_0_I1529704942889178144_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I1529704942889178144_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I1529704942889178144_tagygirdh1 + 12), "envp");

mem.setI32(strlit_0_I17844812131497141662_tagygirdh1, 6);

mem.setI32((strlit_0_I17844812131497141662_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17844812131497141662_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17844812131497141662_tagygirdh1 + 12), "packed");

mem.setI32(strlit_0_I8800776328647009306_tagygirdh1, 7);

mem.setI32((strlit_0_I8800776328647009306_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8800776328647009306_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8800776328647009306_tagygirdh1 + 12), "passive");

mem.setI32(strlit_0_I13747405705720498495_tagygirdh1, 4);

mem.setI32((strlit_0_I13747405705720498495_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I13747405705720498495_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I13747405705720498495_tagygirdh1 + 12), "push");

mem.setI32(strlit_0_I16441971418298468310_tagygirdh1, 8);

mem.setI32((strlit_0_I16441971418298468310_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16441971418298468310_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16441971418298468310_tagygirdh1 + 12), "callConv");

mem.setI32(strlit_0_I12645659207852971310_tagygirdh1, 5);

mem.setI32((strlit_0_I12645659207852971310_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I12645659207852971310_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I12645659207852971310_tagygirdh1 + 12), "passL");

mem.setI32(strlit_0_I10542467331015004416_tagygirdh1, 5);

mem.setI32((strlit_0_I10542467331015004416_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10542467331015004416_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10542467331015004416_tagygirdh1 + 12), "passC");

mem.setI32(strlit_0_I17913492178188134841_tagygirdh1, 7);

mem.setI32((strlit_0_I17913492178188134841_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17913492178188134841_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17913492178188134841_tagygirdh1 + 12), "methods");

mem.setI32(strlit_0_I6332049561104653135_tagygirdh1, 4);

mem.setI32((strlit_0_I6332049561104653135_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6332049561104653135_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6332049561104653135_tagygirdh1 + 12), "size");

mem.setI32(strlit_0_I5677487675071849914_tagygirdh1, 15);

mem.setI32((strlit_0_I5677487675071849914_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I5677487675071849914_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I5677487675071849914_tagygirdh1 + 12), "uncheckedAccess");

mem.setI32(strlit_0_I658303038766644256_tagygirdh1, 15);

mem.setI32((strlit_0_I658303038766644256_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I658303038766644256_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I658303038766644256_tagygirdh1 + 12), "uncheckedAssign");

mem.setI32(strlit_0_I16836303070383946558_tagygirdh1, 8);

mem.setI32((strlit_0_I16836303070383946558_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I16836303070383946558_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I16836303070383946558_tagygirdh1 + 12), "profiler");

mem.setI32(strlit_0_I17551943502627385610_tagygirdh1, 10);

mem.setI32((strlit_0_I17551943502627385610_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17551943502627385610_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17551943502627385610_tagygirdh1 + 12), "stacktrace");

mem.setI32(strlit_0_I17279576536099861747_tagygirdh1, 6);

mem.setI32((strlit_0_I17279576536099861747_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I17279576536099861747_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I17279576536099861747_tagygirdh1 + 12), "gcsafe");

mem.setI32(strlit_0_I14680152901758819216_tagygirdh1, 4);

mem.setI32((strlit_0_I14680152901758819216_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I14680152901758819216_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I14680152901758819216_tagygirdh1 + 12), "used");

mem.setI32(strlit_0_I8457648535047856405_tagygirdh1, 7);

mem.setI32((strlit_0_I8457648535047856405_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I8457648535047856405_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I8457648535047856405_tagygirdh1 + 12), "compile");

mem.setI32(strlit_0_I6383115151635694985_tagygirdh1, 6);

mem.setI32((strlit_0_I6383115151635694985_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I6383115151635694985_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I6383115151635694985_tagygirdh1 + 12), "bundle");

mem.setI32(strlit_0_I10191413032959885349_tagygirdh1, 9);

mem.setI32((strlit_0_I10191413032959885349_tagygirdh1 + 4), 0);

mem.setI32((strlit_0_I10191413032959885349_tagygirdh1 + 8), 0);

mem.writeStr((strlit_0_I10191413032959885349_tagygirdh1 + 12), "toClosure");

mem.copy(TagData_0_tagygirdh1, (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1986939390);
    mem.setU32((_o + 4), strlit_0_I10295616015915542771_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 0);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 12), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920099587);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 1);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 24), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1718973187);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 2);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 36), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7627010);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 3);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 48), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919247614);
    mem.setU32((_o + 4), strlit_0_I8939511674443647382_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 4);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 60), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953457155);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 5);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 72), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952542723);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 6);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 84), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918988291);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 7);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 96), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684300286);
    mem.setU32((_o + 4), strlit_0_I9557201018976274010_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 8);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 108), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818848771);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 9);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 120), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953459966);
    mem.setU32((_o + 4), strlit_0_I12905769428011359788_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 10);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 132), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668183550);
    mem.setU32((_o + 4), strlit_0_I1477227973970526752_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 11);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 144), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1718511875);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 12);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 156), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1734700798);
    mem.setU32((_o + 4), strlit_0_I186799702831424311_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 13);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 168), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851878915);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 14);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 180), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818322686);
    mem.setU32((_o + 4), strlit_0_I3372626016653902757_jsovezijp1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 15);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 192), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970435326);
    mem.setU32((_o + 4), strlit_0_I8572766038233537570_jsovezijp1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 16);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 204), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684955395);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 17);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 216), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7499522);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 18);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 228), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919907843);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 19);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 240), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953459715);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 20);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 252), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1734700547);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 21);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 264), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2053731326);
    mem.setU32((_o + 4), strlit_0_I14042222260391466396_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 22);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 276), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768710654);
    mem.setU32((_o + 4), strlit_0_I6690414846038512979_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 23);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 288), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717989374);
    mem.setU32((_o + 4), strlit_0_I16910581458008155537_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 24);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 300), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1868787710);
    mem.setU32((_o + 4), strlit_0_I7084116572891045059_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 25);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 312), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1868784126);
    mem.setU32((_o + 4), strlit_0_I17573272885368898989_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 26);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 324), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634886398);
    mem.setU32((_o + 4), strlit_0_I14055597598996035090_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 27);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 336), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920295934);
    mem.setU32((_o + 4), strlit_0_I10209608037894561257_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 28);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 348), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920295934);
    mem.setU32((_o + 4), strlit_0_I14293528690183020870_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 29);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 360), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7760642);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 30);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 372), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7763458);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 31);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 384), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1719037699);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 32);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 396), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684300035);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 33);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 408), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1651864323);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 34);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 420), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1819634947);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 35);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 432), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1986618371);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 36);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 444), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1685024003);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 37);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 456), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919447811);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 38);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 468), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818784515);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 39);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 480), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953063678);
    mem.setU32((_o + 4), strlit_0_I12320098920117258102_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 40);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 492), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953063678);
    mem.setU32((_o + 4), strlit_0_I8344472873800577395_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 41);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 504), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953063678);
    mem.setU32((_o + 4), strlit_0_I1868900624481666580_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 42);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 516), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953063678);
    mem.setU32((_o + 4), strlit_0_I6041839086284145320_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 43);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 528), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7431426);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 44);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 540), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1902472707);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 45);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 552), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 6646786);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 46);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 564), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7629826);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 47);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 576), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935762430);
    mem.setU32((_o + 4), strlit_0_I13909093427330098489_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 48);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 588), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I2501487269769466366_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 49);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 600), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818321918);
    mem.setU32((_o + 4), strlit_0_I1707222714195181991_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 50);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 612), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684890371);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 51);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 624), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851880190);
    mem.setU32((_o + 4), strlit_0_I16597999082088934835_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 52);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 636), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851880190);
    mem.setU32((_o + 4), strlit_0_I10760563625686142994_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 53);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 648), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635149822);
    mem.setU32((_o + 4), strlit_0_I1281801651151844468_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 54);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 660), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635153150);
    mem.setU32((_o + 4), strlit_0_I13046452236886743244_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 55);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 672), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918989827);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 56);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 684), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918988542);
    mem.setU32((_o + 4), strlit_0_I9792473688321036479_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 57);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 696), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I12999086881046019782_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 58);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 708), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936028414);
    mem.setU32((_o + 4), strlit_0_I2416437014800228590_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 59);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 720), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701603326);
    mem.setU32((_o + 4), strlit_0_I5723805845286553140_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 60);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 732), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701606654);
    mem.setU32((_o + 4), strlit_0_I7233319822780473912_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 61);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 744), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952803843);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 62);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 756), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920295934);
    mem.setU32((_o + 4), strlit_0_I17735862253056247523_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 63);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 768), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952542974);
    mem.setU32((_o + 4), strlit_0_I3786558325628924612_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 64);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 780), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I3759916806223351059_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 65);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 792), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635021822);
    mem.setU32((_o + 4), strlit_0_I15385401366416332649_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 66);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 804), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818650110);
    mem.setU32((_o + 4), strlit_0_I2171368188661376471_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 67);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 816), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684825603);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 68);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 828), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818650622);
    mem.setU32((_o + 4), strlit_0_I17496857845421750549_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 69);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 840), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869771006);
    mem.setU32((_o + 4), strlit_0_I5316556160589403975_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 70);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 852), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1853187838);
    mem.setU32((_o + 4), strlit_0_I9991102891510134496_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 71);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 864), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702128126);
    mem.setU32((_o + 4), strlit_0_I9071657656589967445_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 72);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 876), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I6864681898360807206_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 73);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 888), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952804350);
    mem.setU32((_o + 4), strlit_0_I6517805684605582485_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 74);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 900), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667329534);
    mem.setU32((_o + 4), strlit_0_I3777428167486794959_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 75);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 912), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1835365630);
    mem.setU32((_o + 4), strlit_0_I17987658270787974407_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 76);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 924), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I13413619771642637377_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 77);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 936), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869374206);
    mem.setU32((_o + 4), strlit_0_I9830314142150548690_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 78);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 948), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1685024254);
    mem.setU32((_o + 4), strlit_0_I6605162211648777506_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 79);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 960), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1751344126);
    mem.setU32((_o + 4), strlit_0_I7132977312474535290_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 80);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 972), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1751347198);
    mem.setU32((_o + 4), strlit_0_I7981495708050792894_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 81);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 984), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768777214);
    mem.setU32((_o + 4), strlit_0_I1572551130627868563_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 82);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 996), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1735614974);
    mem.setU32((_o + 4), strlit_0_I2681092370707159476_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 83);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1008), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869902846);
    mem.setU32((_o + 4), strlit_0_I5487391404206283781_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 84);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1020), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701145598);
    mem.setU32((_o + 4), strlit_0_I6800807151669219983_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 85);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1032), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1868788734);
    mem.setU32((_o + 4), strlit_0_I110166545589372112_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 86);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1044), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 6711554);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 87);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1056), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701345278);
    mem.setU32((_o + 4), strlit_0_I14781640258047403316_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 88);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1068), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768711678);
    mem.setU32((_o + 4), strlit_0_I13424873862977158440_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 89);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1080), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936483838);
    mem.setU32((_o + 4), strlit_0_I4167480082662538754_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 90);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1092), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I14656641239204103783_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 91);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1104), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701995262);
    mem.setU32((_o + 4), strlit_0_I8380221545607033154_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 92);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1116), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I2210116261907819816_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 93);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1128), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919903235);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 94);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1140), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768454142);
    mem.setU32((_o + 4), strlit_0_I13200118161122656888_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 95);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1152), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919902718);
    mem.setU32((_o + 4), strlit_0_I10030898066311664679_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 96);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1164), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935762430);
    mem.setU32((_o + 4), strlit_0_I4956278306908871092_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 97);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1176), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 6713090);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 98);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1188), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1650551811);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 99);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1200), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886218755);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 100);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1212), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952805379);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 101);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1224), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684830467);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 102);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1236), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836348414);
    mem.setU32((_o + 4), strlit_0_I13752166055203769914_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 103);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1248), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918988542);
    mem.setU32((_o + 4), strlit_0_I5367917178860180580_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 104);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1260), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768846846);
    mem.setU32((_o + 4), strlit_0_I3302612697625453930_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 105);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1272), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1784836094);
    mem.setU32((_o + 4), strlit_0_I973692718279674627_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 106);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1284), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970169342);
    mem.setU32((_o + 4), strlit_0_I10462096440466995513_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 107);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1296), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869771006);
    mem.setU32((_o + 4), strlit_0_I1995551610468546737_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 108);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1308), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869898238);
    mem.setU32((_o + 4), strlit_0_I6755942707126604175_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 109);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1320), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7303682);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 110);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1332), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936028414);
    mem.setU32((_o + 4), strlit_0_I2128687583820536666_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 111);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1344), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886413822);
    mem.setU32((_o + 4), strlit_0_I1346366660018635533_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 112);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1356), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 26881);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 113);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1368), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 29953);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 114);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1380), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 26113);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 115);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1392), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 25345);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 116);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1404), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869570814);
    mem.setU32((_o + 4), strlit_0_I11024699549390617459_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 117);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1416), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768912638);
    mem.setU32((_o + 4), strlit_0_I11155032387348830029_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 118);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1428), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920233475);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 119);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1440), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920098814);
    mem.setU32((_o + 4), strlit_0_I1177603226064417776_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 120);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1452), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701603070);
    mem.setU32((_o + 4), strlit_0_I13748185565082850274_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 121);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1464), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953522174);
    mem.setU32((_o + 4), strlit_0_I6488225283415667707_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 122);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1476), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701078014);
    mem.setU32((_o + 4), strlit_0_I16188676551779215531_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 123);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1488), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1685353470);
    mem.setU32((_o + 4), strlit_0_I18234099685676259387_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 124);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1500), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717662718);
    mem.setU32((_o + 4), strlit_0_I4481474124438915992_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 125);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1512), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1937339390);
    mem.setU32((_o + 4), strlit_0_I2072093345082808027_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 126);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1524), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935763198);
    mem.setU32((_o + 4), strlit_0_I3679389138985991790_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 127);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1536), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768453374);
    mem.setU32((_o + 4), strlit_0_I17192084538477055045_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 128);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1548), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668247294);
    mem.setU32((_o + 4), strlit_0_I13519359689973327992_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 129);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1560), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1835363838);
    mem.setU32((_o + 4), strlit_0_I11811080807945599045_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 130);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1572), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1835626238);
    mem.setU32((_o + 4), strlit_0_I13738511073829832276_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 131);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1584), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1819175422);
    mem.setU32((_o + 4), strlit_0_I11734088361827745870_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 132);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1596), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768910590);
    mem.setU32((_o + 4), strlit_0_I9300717802679998862_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 133);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1608), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869374462);
    mem.setU32((_o + 4), strlit_0_I16971225136864641703_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 134);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1620), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953784318);
    mem.setU32((_o + 4), strlit_0_I8775499903415745325_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 135);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1632), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919775742);
    mem.setU32((_o + 4), strlit_0_I14941751896671455891_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 136);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1644), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918990078);
    mem.setU32((_o + 4), strlit_0_I14150474136931533575_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 137);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1656), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935767299);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 138);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1668), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818588158);
    mem.setU32((_o + 4), strlit_0_I2120471692824576765_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 139);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1680), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634889982);
    mem.setU32((_o + 4), strlit_0_I7023501325319911082_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 140);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1692), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634889982);
    mem.setU32((_o + 4), strlit_0_I17199005983847516849_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 141);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1704), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768710654);
    mem.setU32((_o + 4), strlit_0_I3912769065629684841_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 142);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1716), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953063678);
    mem.setU32((_o + 4), strlit_0_I4965478555169759111_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 143);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1728), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667593982);
    mem.setU32((_o + 4), strlit_0_I772494771101702043_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 144);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1740), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1685024510);
    mem.setU32((_o + 4), strlit_0_I9354196862430236195_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 145);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1752), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668180478);
    mem.setU32((_o + 4), strlit_0_I14732757010146030568_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 146);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1764), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668834814);
    mem.setU32((_o + 4), strlit_0_I2784804726569183623_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 147);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1776), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668180478);
    mem.setU32((_o + 4), strlit_0_I3312144845751804851_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 148);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1788), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886218750);
    mem.setU32((_o + 4), strlit_0_I10578126245728228512_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 149);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1800), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886218750);
    mem.setU32((_o + 4), strlit_0_I9191034391941917241_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 150);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1812), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869768446);
    mem.setU32((_o + 4), strlit_0_I3199637833187763350_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 151);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1824), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886218750);
    mem.setU32((_o + 4), strlit_0_I16948548629793503007_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 152);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1836), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886938622);
    mem.setU32((_o + 4), strlit_0_I6313045265747232047_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 153);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1848), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869768446);
    mem.setU32((_o + 4), strlit_0_I15468012182747796806_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 154);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1860), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886938622);
    mem.setU32((_o + 4), strlit_0_I7395289177220351871_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 155);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1872), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836016638);
    mem.setU32((_o + 4), strlit_0_I18257730313531980409_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 156);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1884), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936286974);
    mem.setU32((_o + 4), strlit_0_I2956720964102846418_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 157);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1896), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2037543939);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 158);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1908), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1767994110);
    mem.setU32((_o + 4), strlit_0_I6137881024046402116_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 159);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1920), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701736446);
    mem.setU32((_o + 4), strlit_0_I5809186183819720447_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 160);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1932), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1767994110);
    mem.setU32((_o + 4), strlit_0_I10609090264569208189_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 161);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1944), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920099838);
    mem.setU32((_o + 4), strlit_0_I13128250356938898261_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 162);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1956), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635021822);
    mem.setU32((_o + 4), strlit_0_I17569086427026686584_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 163);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1968), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702127875);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 164);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1980), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702128126);
    mem.setU32((_o + 4), strlit_0_I356330993363212426_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 165);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 1992), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869573374);
    mem.setU32((_o + 4), strlit_0_I5622496984824462814_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 166);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2004), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 30209);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 167);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2016), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970562558);
    mem.setU32((_o + 4), strlit_0_I11470268427441903014_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 168);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2028), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1802401278);
    mem.setU32((_o + 4), strlit_0_I9846635761469100055_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 169);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2040), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920232190);
    mem.setU32((_o + 4), strlit_0_I7777630149462349779_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 170);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2052), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818652158);
    mem.setU32((_o + 4), strlit_0_I1755384972092858986_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 171);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2064), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818654462);
    mem.setU32((_o + 4), strlit_0_I5825594256536309212_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 172);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2076), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953064446);
    mem.setU32((_o + 4), strlit_0_I18223875966347257259_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 173);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2088), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768909566);
    mem.setU32((_o + 4), strlit_0_I7603755693199836480_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 174);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2100), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634887678);
    mem.setU32((_o + 4), strlit_0_I6285446155132737146_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 175);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2112), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919903486);
    mem.setU32((_o + 4), strlit_0_I16485414215621593826_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 176);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2124), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818848254);
    mem.setU32((_o + 4), strlit_0_I10406234210653353301_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 177);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2136), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886287358);
    mem.setU32((_o + 4), strlit_0_I13179338205702368459_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 178);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2148), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886287358);
    mem.setU32((_o + 4), strlit_0_I1237672436915077942_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 179);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2160), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818321918);
    mem.setU32((_o + 4), strlit_0_I11688738934238820917_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 180);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2172), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919903486);
    mem.setU32((_o + 4), strlit_0_I2573631453468209738_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 181);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2184), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886287358);
    mem.setU32((_o + 4), strlit_0_I7731358638274129439_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 182);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2196), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668834814);
    mem.setU32((_o + 4), strlit_0_I16264910594287870354_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 183);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2208), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852401155);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 184);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2220), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886745854);
    mem.setU32((_o + 4), strlit_0_I18086024188298164462_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 185);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2232), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970171902);
    mem.setU32((_o + 4), strlit_0_I3225181402180923291_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 186);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2244), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970168318);
    mem.setU32((_o + 4), strlit_0_I12023767949489687491_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 187);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2256), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717924355);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 188);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2268), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953852675);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 189);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2280), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953853187);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 190);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2292), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852140798);
    mem.setU32((_o + 4), strlit_0_I6008424852838151324_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 191);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2304), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852404734);
    mem.setU32((_o + 4), strlit_0_I5595596763809202512_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 192);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2316), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818849022);
    mem.setU32((_o + 4), strlit_0_I14845240230376595005_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 193);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2328), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852793854);
    mem.setU32((_o + 4), strlit_0_I2544717250931810611_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 194);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2340), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936286974);
    mem.setU32((_o + 4), strlit_0_I3021806080610957510_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 195);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2352), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702128126);
    mem.setU32((_o + 4), strlit_0_I15938251790995683266_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 196);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2364), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851880190);
    mem.setU32((_o + 4), strlit_0_I16393544569146403439_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 197);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2376), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918989822);
    mem.setU32((_o + 4), strlit_0_I2984705338531181753_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 198);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2388), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952805635);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 199);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2400), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953849854);
    mem.setU32((_o + 4), strlit_0_I2419004569819514924_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 200);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2412), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836676094);
    mem.setU32((_o + 4), strlit_0_I8265071425581872233_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 201);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2424), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I567478400955764617_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 202);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2436), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I13460298547546882036_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 203);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2448), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953396222);
    mem.setU32((_o + 4), strlit_0_I1016912281706840257_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 204);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2460), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I9456292052054236016_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 205);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2472), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953719294);
    mem.setU32((_o + 4), strlit_0_I14727864736786204059_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 206);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2484), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768911102);
    mem.setU32((_o + 4), strlit_0_I6300154543333844069_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 207);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2496), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1685221374);
    mem.setU32((_o + 4), strlit_0_I6616374312433163100_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 208);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2508), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1734438398);
    mem.setU32((_o + 4), strlit_0_I15788046494547023735_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 209);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2520), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886218750);
    mem.setU32((_o + 4), strlit_0_I3957309170640276402_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 210);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2532), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886218750);
    mem.setU32((_o + 4), strlit_0_I6761535509221812916_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 211);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2544), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1853449470);
    mem.setU32((_o + 4), strlit_0_I4382311971321061249_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 212);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2556), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886938622);
    mem.setU32((_o + 4), strlit_0_I4862850237857511107_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 213);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2568), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634035966);
    mem.setU32((_o + 4), strlit_0_I2341417231474813780_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 214);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2580), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919448318);
    mem.setU32((_o + 4), strlit_0_I11401871840194716403_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 215);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2592), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869375486);
    mem.setU32((_o + 4), strlit_0_I5696226971518331620_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 216);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2604), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936286974);
    mem.setU32((_o + 4), strlit_0_I1655448968826648425_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 217);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2616), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919905534);
    mem.setU32((_o + 4), strlit_0_I14428456701869004983_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 218);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2628), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919902462);
    mem.setU32((_o + 4), strlit_0_I14004803080881083620_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 219);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2640), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1399811838);
    mem.setU32((_o + 4), strlit_0_I113550637689326195_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 220);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2652), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1685024510);
    mem.setU32((_o + 4), strlit_0_I8745041498576622223_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 221);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2664), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970041086);
    mem.setU32((_o + 4), strlit_0_I757997984781066323_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 222);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2676), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668899582);
    mem.setU32((_o + 4), strlit_0_I4859700805551129371_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 223);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2688), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920557822);
    mem.setU32((_o + 4), strlit_0_I17285089853291426062_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 224);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2700), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768910590);
    mem.setU32((_o + 4), strlit_0_I3179792478750962635_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 225);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2712), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1902473982);
    mem.setU32((_o + 4), strlit_0_I16730393376288644638_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 226);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2724), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936614910);
    mem.setU32((_o + 4), strlit_0_I5451065444311437237_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 227);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2736), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936941566);
    mem.setU32((_o + 4), strlit_0_I4604789051338433811_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 228);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2748), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936941566);
    mem.setU32((_o + 4), strlit_0_I12559108835900458521_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 229);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2760), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1769300734);
    mem.setU32((_o + 4), strlit_0_I10833596585003541936_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 230);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2772), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634035454);
    mem.setU32((_o + 4), strlit_0_I4207864124720532554_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 231);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2784), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920234494);
    mem.setU32((_o + 4), strlit_0_I4511345809429878981_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 232);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2796), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701410558);
    mem.setU32((_o + 4), strlit_0_I17993691144359452798_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 233);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2808), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668180478);
    mem.setU32((_o + 4), strlit_0_I3557287941175077387_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 234);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2820), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869967870);
    mem.setU32((_o + 4), strlit_0_I1290833423478922541_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 235);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2832), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701079294);
    mem.setU32((_o + 4), strlit_0_I4196580491060784277_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 236);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2844), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1868850430);
    mem.setU32((_o + 4), strlit_0_I14457488926480995039_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 237);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2856), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684105470);
    mem.setU32((_o + 4), strlit_0_I17469384850928897790_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 238);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2868), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2003136254);
    mem.setU32((_o + 4), strlit_0_I9268166327583521131_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 239);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2880), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2003136254);
    mem.setU32((_o + 4), strlit_0_I12337342044224817361_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 240);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2892), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886745603);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 241);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2904), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886745854);
    mem.setU32((_o + 4), strlit_0_I17716058327968275251_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 242);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2916), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952805886);
    mem.setU32((_o + 4), strlit_0_I7358334719788826533_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 243);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2928), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1650554110);
    mem.setU32((_o + 4), strlit_0_I16361658452647583931_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 244);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2940), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1752392190);
    mem.setU32((_o + 4), strlit_0_I4333440046835585584_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 245);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2952), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935762174);
    mem.setU32((_o + 4), strlit_0_I4543393450896359795_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 246);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2964), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1868785918);
    mem.setU32((_o + 4), strlit_0_I710932595938440230_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 247);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2976), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1868784894);
    mem.setU32((_o + 4), strlit_0_I9667346611828510523_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 248);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 2988), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818321918);
    mem.setU32((_o + 4), strlit_0_I9217337746930322866_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 249);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3000), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1718512126);
    mem.setU32((_o + 4), strlit_0_I8390060478375454995_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 250);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3012), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701998846);
    mem.setU32((_o + 4), strlit_0_I8954722698363393223_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 251);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3024), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633904894);
    mem.setU32((_o + 4), strlit_0_I12061648672903694946_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 252);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3036), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836016638);
    mem.setU32((_o + 4), strlit_0_I15519800790444264650_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 253);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3048), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667589374);
    mem.setU32((_o + 4), strlit_0_I11246488655541728238_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 254);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3060), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717921022);
    mem.setU32((_o + 4), strlit_0_I15630474019274232734_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 255);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3072), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953718782);
    mem.setU32((_o + 4), strlit_0_I8057664036378742595_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 256);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3084), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852400382);
    mem.setU32((_o + 4), strlit_0_I3906464809106688102_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 257);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3096), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852400382);
    mem.setU32((_o + 4), strlit_0_I7173319946579796093_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 258);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3108), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936615934);
    mem.setU32((_o + 4), strlit_0_I4161172010043268705_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 259);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3120), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869771006);
    mem.setU32((_o + 4), strlit_0_I3485566669610392440_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 260);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3132), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1734961406);
    mem.setU32((_o + 4), strlit_0_I8566804573867139999_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 261);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3144), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2003790851);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 262);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3156), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I15370501250081784507_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 263);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3168), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886287358);
    mem.setU32((_o + 4), strlit_0_I17316263578118871722_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 264);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3180), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701406462);
    mem.setU32((_o + 4), strlit_0_I11931178963942483173_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 265);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3192), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701406462);
    mem.setU32((_o + 4), strlit_0_I5007098554778156607_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 266);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3204), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970169342);
    mem.setU32((_o + 4), strlit_0_I6307085774546006824_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 267);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3216), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836280318);
    mem.setU32((_o + 4), strlit_0_I15215329021599148827_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 268);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3228), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717921022);
    mem.setU32((_o + 4), strlit_0_I2499004453702072445_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 269);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3240), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717921022);
    mem.setU32((_o + 4), strlit_0_I10155087370267137835_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 270);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3252), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717921022);
    mem.setU32((_o + 4), strlit_0_I5057369592842021125_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 271);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3264), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818584318);
    mem.setU32((_o + 4), strlit_0_I358872489388858575_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 272);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3276), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818584318);
    mem.setU32((_o + 4), strlit_0_I14418907618963914168_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 273);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3288), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1937077246);
    mem.setU32((_o + 4), strlit_0_I11512946405431690565_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 274);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3300), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886938622);
    mem.setU32((_o + 4), strlit_0_I13798915436014509391_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 275);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3312), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7300098);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 276);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3324), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920098814);
    mem.setU32((_o + 4), strlit_0_I3001676635385606767_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 277);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3336), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886745854);
    mem.setU32((_o + 4), strlit_0_I5323221927989235116_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 278);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3348), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970041086);
    mem.setU32((_o + 4), strlit_0_I12557166611382145809_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 279);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3360), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852403198);
    mem.setU32((_o + 4), strlit_0_I896709357113617264_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 280);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3372), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1819635198);
    mem.setU32((_o + 4), strlit_0_I6462229405280805082_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 281);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3384), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919908094);
    mem.setU32((_o + 4), strlit_0_I11168045910199617169_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 282);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3396), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936811518);
    mem.setU32((_o + 4), strlit_0_I17580784255599249694_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 283);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3408), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936026878);
    mem.setU32((_o + 4), strlit_0_I7755216903854853291_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 284);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3420), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1937009918);
    mem.setU32((_o + 4), strlit_0_I6438757400198936067_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 285);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3432), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936615934);
    mem.setU32((_o + 4), strlit_0_I17286088029172964552_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 286);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3444), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918985214);
    mem.setU32((_o + 4), strlit_0_I655215872312446365_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 287);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3456), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869440510);
    mem.setU32((_o + 4), strlit_0_I7330775407653057337_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 288);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3468), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1936024830);
    mem.setU32((_o + 4), strlit_0_I12823858650579995313_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 289);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3480), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886741507);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 290);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3492), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886348286);
    mem.setU32((_o + 4), strlit_0_I6996188409796059230_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 291);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3504), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935767550);
    mem.setU32((_o + 4), strlit_0_I10163392937326623266_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 292);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3516), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852404734);
    mem.setU32((_o + 4), strlit_0_I12773303473659224661_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 293);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3528), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634891006);
    mem.setU32((_o + 4), strlit_0_I13264932728578201327_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 294);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3540), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920099838);
    mem.setU32((_o + 4), strlit_0_I12050042172059571383_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 295);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3552), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635021822);
    mem.setU32((_o + 4), strlit_0_I4843651051758684618_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 296);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3564), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852400382);
    mem.setU32((_o + 4), strlit_0_I18337270522941735704_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 297);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3576), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2020175358);
    mem.setU32((_o + 4), strlit_0_I6669728318263290480_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 298);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3588), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1769174526);
    mem.setU32((_o + 4), strlit_0_I15803870852433253359_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 299);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3600), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836278019);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 300);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3612), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717921022);
    mem.setU32((_o + 4), strlit_0_I4167773820130397069_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 301);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3624), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684957694);
    mem.setU32((_o + 4), strlit_0_I15907549540151602841_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 302);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3636), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1785620990);
    mem.setU32((_o + 4), strlit_0_I15673079640947746121_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 303);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3648), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852139518);
    mem.setU32((_o + 4), strlit_0_I18017358057866442883_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 304);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3660), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1919509758);
    mem.setU32((_o + 4), strlit_0_I694217339896490792_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 305);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3672), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920099838);
    mem.setU32((_o + 4), strlit_0_I15516388950515943933_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 306);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3684), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1885696766);
    mem.setU32((_o + 4), strlit_0_I15352605387219570985_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 307);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3696), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1734440190);
    mem.setU32((_o + 4), strlit_0_I57893748219682234_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 308);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3708), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1885693182);
    mem.setU32((_o + 4), strlit_0_I7770279929706659123_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 309);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3720), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684632574);
    mem.setU32((_o + 4), strlit_0_I6214469262558903647_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 310);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3732), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1701145598);
    mem.setU32((_o + 4), strlit_0_I10356331269374273950_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 311);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3744), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1835365374);
    mem.setU32((_o + 4), strlit_0_I4798194433225830700_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 312);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3756), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1752066558);
    mem.setU32((_o + 4), strlit_0_I13657782612448101767_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 313);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3768), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935762174);
    mem.setU32((_o + 4), strlit_0_I7138112740281612668_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 314);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3780), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1920299262);
    mem.setU32((_o + 4), strlit_0_I3788100829446300327_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 315);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3792), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1852401406);
    mem.setU32((_o + 4), strlit_0_I6579479052981869920_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 316);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3804), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2036556286);
    mem.setU32((_o + 4), strlit_0_I6244821402565232963_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 317);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3816), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1634889982);
    mem.setU32((_o + 4), strlit_0_I18424387959777996651_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 318);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3828), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953393150);
    mem.setU32((_o + 4), strlit_0_I6548618541054097076_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 319);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3840), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1953393150);
    mem.setU32((_o + 4), strlit_0_I17367998397186134261_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 320);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3852), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1767991038);
    mem.setU32((_o + 4), strlit_0_I14845204679832807538_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 321);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3864), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 7563522);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 322);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3876), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1986946558);
    mem.setU32((_o + 4), strlit_0_I1529704942889178144_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 323);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3888), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667330302);
    mem.setU32((_o + 4), strlit_0_I17844812131497141662_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 324);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3900), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935765758);
    mem.setU32((_o + 4), strlit_0_I8800776328647009306_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 325);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3912), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1937076478);
    mem.setU32((_o + 4), strlit_0_I13747405705720498495_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 326);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3924), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1818321918);
    mem.setU32((_o + 4), strlit_0_I16441971418298468310_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 327);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3936), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1886351363);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 328);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3948), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935765758);
    mem.setU32((_o + 4), strlit_0_I12645659207852971310_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 329);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3960), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935765758);
    mem.setU32((_o + 4), strlit_0_I10542467331015004416_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 330);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3972), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1952804350);
    mem.setU32((_o + 4), strlit_0_I17913492178188134841_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 331);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3984), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2053731326);
    mem.setU32((_o + 4), strlit_0_I6332049561104653135_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 332);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 3996), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668183550);
    mem.setU32((_o + 4), strlit_0_I5677487675071849914_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 333);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4008), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1668183550);
    mem.setU32((_o + 4), strlit_0_I658303038766644256_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 334);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4020), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869771006);
    mem.setU32((_o + 4), strlit_0_I16836303070383946558_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 335);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4032), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635021822);
    mem.setU32((_o + 4), strlit_0_I17551943502627385610_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 336);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4044), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935894526);
    mem.setU32((_o + 4), strlit_0_I17279576536099861747_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 337);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4056), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1702065662);
    mem.setU32((_o + 4), strlit_0_I14680152901758819216_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 338);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4068), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1836016638);
    mem.setU32((_o + 4), strlit_0_I8457648535047856405_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 339);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4080), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1853186814);
    mem.setU32((_o + 4), strlit_0_I6383115151635694985_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 340);
  return _o;
})(), 12);

mem.copy((TagData_0_tagygirdh1 + 4092), (() => {
  let _o = allocFixed(12);
  mem.copy(_o, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1131377918);
    mem.setU32((_o + 4), strlit_0_I10191413032959885349_tagygirdh1);
    return _o;
  })(), 8);
  mem.setI32((_o + 8), 341);
  return _o;
})(), 12);

mem.setI32(strlit_0_I17487054685970555778_nifh7u8pu1, 75);

mem.setI32((strlit_0_I17487054685970555778_nifh7u8pu1 + 4), 0);

mem.setI32((strlit_0_I17487054685970555778_nifh7u8pu1 + 8), 0);

mem.writeStr((strlit_0_I17487054685970555778_nifh7u8pu1 + 12), "../nimony/lib/std/system/seqimpl.nim(256, 32): 0 < s.len [AssertionDefect]\n");

ErrT_0_nifh7u8pu1 = 1;

mem.setI32(strlit_0_I6105018409752412263_jsovezijp1, 16);

mem.setI32((strlit_0_I6105018409752412263_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I6105018409752412263_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I6105018409752412263_jsovezijp1 + 12), "0123456789abcdef");

mem.setI32(strlit_0_I4645790987703279553_jsovezijp1, 4);

mem.setI32((strlit_0_I4645790987703279553_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I4645790987703279553_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I4645790987703279553_jsovezijp1 + 12), "\\u00");

mem.setI32(strlit_0_I8572766038233537570_jsovezijp1, 4);

mem.setI32((strlit_0_I8572766038233537570_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I8572766038233537570_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I8572766038233537570_jsovezijp1 + 12), "true");

mem.setI32(strlit_0_I3372626016653902757_jsovezijp1, 5);

mem.setI32((strlit_0_I3372626016653902757_jsovezijp1 + 4), 0);

mem.setI32((strlit_0_I3372626016653902757_jsovezijp1 + 8), 0);

mem.writeStr((strlit_0_I3372626016653902757_jsovezijp1 + 12), "false");

mem.setI32(strlit_0_I10470613477459003309_webzywwor1, 8);

mem.setI32((strlit_0_I10470613477459003309_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10470613477459003309_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10470613477459003309_webzywwor1 + 12), ",\"file\":");

mem.setI32(strlit_0_I18338797071087941219_webzywwor1, 8);

mem.setI32((strlit_0_I18338797071087941219_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I18338797071087941219_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I18338797071087941219_webzywwor1 + 12), ",\"line\":");

mem.setI32(strlit_0_I7115103054454119625_webzywwor1, 7);

mem.setI32((strlit_0_I7115103054454119625_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I7115103054454119625_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I7115103054454119625_webzywwor1 + 12), ",\"col\":");

mem.setI32(strlit_0_I5516792017268448510_webzywwor1, 7);

mem.setI32((strlit_0_I5516792017268448510_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I5516792017268448510_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I5516792017268448510_webzywwor1 + 12), "{\"sym\":");

mem.setI32(strlit_0_I15258652501822522767_webzywwor1, 8);

mem.setI32((strlit_0_I15258652501822522767_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15258652501822522767_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15258652501822522767_webzywwor1 + 12), ",\"name\":");

mem.setI32(strlit_0_I6357233917619117690_webzywwor1, 8);

mem.setI32((strlit_0_I6357233917619117690_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6357233917619117690_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6357233917619117690_webzywwor1 + 12), ",\"kind\":");

mem.setI32(strlit_0_I13311128126112205167_webzywwor1, 10);

mem.setI32((strlit_0_I13311128126112205167_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I13311128126112205167_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I13311128126112205167_webzywwor1 + 12), "{\"caller\":");

mem.setI32(strlit_0_I11346633816202967245_webzywwor1, 10);

mem.setI32((strlit_0_I11346633816202967245_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11346633816202967245_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11346633816202967245_webzywwor1 + 12), ",\"callee\":");

mem.setI32(strlit_0_I18397792016458084092_webzywwor1, 11);

mem.setI32((strlit_0_I18397792016458084092_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I18397792016458084092_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I18397792016458084092_webzywwor1 + 12), "(checksum \"");

mem.setI32(strlit_0_I1659971858173592857_webzywwor1, 4);

mem.setI32((strlit_0_I1659971858173592857_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1659971858173592857_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1659971858173592857_webzywwor1 + 12), "null");

mem.setI32(strlit_0_I6882413722212972495_webzywwor1, 12);

mem.setI32((strlit_0_I6882413722212972495_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6882413722212972495_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6882413722212972495_webzywwor1 + 12), "{\"checksum\":");

mem.setI32(strlit_0_I6897676049549612864_webzywwor1, 11);

mem.setI32((strlit_0_I6897676049549612864_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6897676049549612864_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6897676049549612864_webzywwor1 + 12), ",\"exports\":");

mem.setI32(strlit_0_I8657126274509049065_webzywwor1, 14);

mem.setI32((strlit_0_I8657126274509049065_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I8657126274509049065_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I8657126274509049065_webzywwor1 + 12), ",\"converters\":");

mem.setI32(strlit_0_I15164540674592437306_webzywwor1, 9);

mem.setI32((strlit_0_I15164540674592437306_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I15164540674592437306_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I15164540674592437306_webzywwor1 + 12), "__al_snif");

mem.setI32(strlit_0_I11516840874723150973_webzywwor1, 8);

mem.setI32((strlit_0_I11516840874723150973_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11516840874723150973_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11516840874723150973_webzywwor1 + 12), "__al_cmd");

mem.setI32(strlit_0_I14678923973705549773_webzywwor1, 8);

mem.setI32((strlit_0_I14678923973705549773_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I14678923973705549773_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I14678923973705549773_webzywwor1 + 12), "__al_arg");

mem.setI32(strlit_0_I3797851616484695037_webzywwor1, 8);

mem.setI32((strlit_0_I3797851616484695037_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I3797851616484695037_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I3797851616484695037_webzywwor1 + 12), "__al_mod");

mem.setI32(strlit_0_I10769702410228802904_webzywwor1, 5);

mem.setI32((strlit_0_I10769702410228802904_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10769702410228802904_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10769702410228802904_webzywwor1 + 12), "decls");

mem.setI32(strlit_0_I11377223362901306853_webzywwor1, 5);

mem.setI32((strlit_0_I11377223362901306853_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I11377223362901306853_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I11377223362901306853_webzywwor1 + 12), "calls");

mem.setI32(strlit_0_I18430562373120102550_webzywwor1, 20);

mem.setI32((strlit_0_I18430562373120102550_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I18430562373120102550_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I18430562373120102550_webzywwor1 + 12), "unknown subcommand: ");

mem.setI32(strlit_0_I16664880105326712979_webzywwor1, 10);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16664880105326712979_webzywwor1 + 12), "globalThis");

mem.setI32(strlit_0_I10392742912375124130_webzywwor1, 8);

mem.setI32((strlit_0_I10392742912375124130_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I10392742912375124130_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I10392742912375124130_webzywwor1 + 12), "__al_out");

mem.setI32(strlit_0_I947128178696304755_webzywwor1, 8);

mem.setI32((strlit_0_I947128178696304755_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I947128178696304755_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I947128178696304755_webzywwor1 + 12), "__al_err");

mem.setI32(strlit_0_I15750996627617194403_cmdqs323n1, 19);

mem.setI32((strlit_0_I15750996627617194403_cmdqs323n1 + 4), 0);

mem.setI32((strlit_0_I15750996627617194403_cmdqs323n1 + 8), 0);

mem.writeStr((strlit_0_I15750996627617194403_cmdqs323n1 + 12), "leave uninitialized");

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

mem.setI32(strlit_0_I14694606176902936784_has9tn57v, 92);

mem.setI32((strlit_0_I14694606176902936784_has9tn57v + 4), 0);

mem.setI32((strlit_0_I14694606176902936784_has9tn57v + 8), 0);

mem.writeStr((strlit_0_I14694606176902936784_has9tn57v + 12), "../nimony/lib/std/system/openarrays.nim(10, 49): 0 <= idx and idx < x.len [AssertionDefect]\n");
// generated by lengc (js backend) from osalirkw71.c.nif

function len_6_Igv2wyu1_osalirkw71(a_3) {
  let result_9;
  result_9 = mem.i32((a_3 + 4));
  return result_9;
}

function getQ_10_Ik9hgkq1_osalirkw71(x_4, idx_1) {
  let X60Qx_11;
  if ((0 <= idx_1)) {
    X60Qx_11 = (idx_1 < mem.i32((x_4 + 4)));
  } else {
    X60Qx_11 = false;
  }
  if ((!X60Qx_11)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_10;
  result_10 = (mem.u32(x_4) + (idx_1 * 8));
  return result_10;
}

let X60QiniGuard_0_osalirkw71 = allocFixed(1);

function X60Qini_0_osalirkw71() {
  if (mem.u8At(X60QiniGuard_0_osalirkw71)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_osalirkw71, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_envto7w6l1();
  X60Qini_0_ospaexnw61();
  X60Qini_0_ossk30t39();
}
// generated by lengc (js backend) from err0o7h081.c.nif

let X60QiniGuard_0_err0o7h081 = allocFixed(1);

function X60Qini_0_err0o7h081() {
  if (mem.u8At(X60QiniGuard_0_err0o7h081)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_err0o7h081, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from party5a2l1.c.nif

function rawParseInt_0_party5a2l1(s_2, b_0) {
  var result_2;
  var sign_0 = -1n;
  var i_0 = allocFixed(4);
  mem.setI32(i_0, 0);
  var res_0 = 0n;
  var overflow_0 = false;
  var X60Qx_20 = len_6_Iroq7kd1_has9tn57v(s_2);
  if ((mem.i32(i_0) < X60Qx_20)) {
    var X60Qx_21 = getQ_10_I5nt6we_has9tn57v(s_2, mem.i32(i_0));
    if ((mem.u8At(X60Qx_21) === 43)) {
      inc_1_I6wjjge_cmdqs323n1(i_0);
    } else {
      var X60Qx_22 = getQ_10_I5nt6we_has9tn57v(s_2, mem.i32(i_0));
      if ((mem.u8At(X60Qx_22) === 45)) {
        inc_1_I6wjjge_cmdqs323n1(i_0);
        sign_0 = 1n;
      }
    }
  }
  var X60Qx_1;
  var X60Qx_23 = len_6_Iroq7kd1_has9tn57v(s_2);
  if ((mem.i32(i_0) < X60Qx_23)) {
    var X60Qdesugar_2 = allocFixed(32);
    mem.setU8(X60Qdesugar_2, 0);
    mem.setU8((X60Qdesugar_2 + 1), 0);
    mem.setU8((X60Qdesugar_2 + 2), 0);
    mem.setU8((X60Qdesugar_2 + 3), 0);
    mem.setU8((X60Qdesugar_2 + 4), 0);
    mem.setU8((X60Qdesugar_2 + 5), 0);
    mem.setU8((X60Qdesugar_2 + 6), 255);
    mem.setU8((X60Qdesugar_2 + 7), 3);
    mem.setU8((X60Qdesugar_2 + 8), 0);
    mem.setU8((X60Qdesugar_2 + 9), 0);
    mem.setU8((X60Qdesugar_2 + 10), 0);
    mem.setU8((X60Qdesugar_2 + 11), 0);
    mem.setU8((X60Qdesugar_2 + 12), 0);
    mem.setU8((X60Qdesugar_2 + 13), 0);
    mem.setU8((X60Qdesugar_2 + 14), 0);
    mem.setU8((X60Qdesugar_2 + 15), 0);
    mem.setU8((X60Qdesugar_2 + 16), 0);
    mem.setU8((X60Qdesugar_2 + 17), 0);
    mem.setU8((X60Qdesugar_2 + 18), 0);
    mem.setU8((X60Qdesugar_2 + 19), 0);
    mem.setU8((X60Qdesugar_2 + 20), 0);
    mem.setU8((X60Qdesugar_2 + 21), 0);
    mem.setU8((X60Qdesugar_2 + 22), 0);
    mem.setU8((X60Qdesugar_2 + 23), 0);
    mem.setU8((X60Qdesugar_2 + 24), 0);
    mem.setU8((X60Qdesugar_2 + 25), 0);
    mem.setU8((X60Qdesugar_2 + 26), 0);
    mem.setU8((X60Qdesugar_2 + 27), 0);
    mem.setU8((X60Qdesugar_2 + 28), 0);
    mem.setU8((X60Qdesugar_2 + 29), 0);
    mem.setU8((X60Qdesugar_2 + 30), 0);
    mem.setU8((X60Qdesugar_2 + 31), 0);
    var X60Qx_24 = getQ_10_I5nt6we_has9tn57v(s_2, mem.i32(i_0));
    var X60Qdesugar_3 = mem.u8At(X60Qx_24);
    X60Qx_1 = (((mem.u8At((X60Qdesugar_2 + (X60Qdesugar_3 >>> 3))) & ((1 << ((X60Qdesugar_3 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
  } else {
    X60Qx_1 = false;
  }
  if (X60Qx_1) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_2;
          var X60Qx_25 = len_6_Iroq7kd1_has9tn57v(s_2);
          if ((mem.i32(i_0) < X60Qx_25)) {
            var X60Qdesugar_4 = allocFixed(32);
            mem.setU8(X60Qdesugar_4, 0);
            mem.setU8((X60Qdesugar_4 + 1), 0);
            mem.setU8((X60Qdesugar_4 + 2), 0);
            mem.setU8((X60Qdesugar_4 + 3), 0);
            mem.setU8((X60Qdesugar_4 + 4), 0);
            mem.setU8((X60Qdesugar_4 + 5), 0);
            mem.setU8((X60Qdesugar_4 + 6), 255);
            mem.setU8((X60Qdesugar_4 + 7), 3);
            mem.setU8((X60Qdesugar_4 + 8), 0);
            mem.setU8((X60Qdesugar_4 + 9), 0);
            mem.setU8((X60Qdesugar_4 + 10), 0);
            mem.setU8((X60Qdesugar_4 + 11), 0);
            mem.setU8((X60Qdesugar_4 + 12), 0);
            mem.setU8((X60Qdesugar_4 + 13), 0);
            mem.setU8((X60Qdesugar_4 + 14), 0);
            mem.setU8((X60Qdesugar_4 + 15), 0);
            mem.setU8((X60Qdesugar_4 + 16), 0);
            mem.setU8((X60Qdesugar_4 + 17), 0);
            mem.setU8((X60Qdesugar_4 + 18), 0);
            mem.setU8((X60Qdesugar_4 + 19), 0);
            mem.setU8((X60Qdesugar_4 + 20), 0);
            mem.setU8((X60Qdesugar_4 + 21), 0);
            mem.setU8((X60Qdesugar_4 + 22), 0);
            mem.setU8((X60Qdesugar_4 + 23), 0);
            mem.setU8((X60Qdesugar_4 + 24), 0);
            mem.setU8((X60Qdesugar_4 + 25), 0);
            mem.setU8((X60Qdesugar_4 + 26), 0);
            mem.setU8((X60Qdesugar_4 + 27), 0);
            mem.setU8((X60Qdesugar_4 + 28), 0);
            mem.setU8((X60Qdesugar_4 + 29), 0);
            mem.setU8((X60Qdesugar_4 + 30), 0);
            mem.setU8((X60Qdesugar_4 + 31), 0);
            var X60Qx_26 = getQ_10_I5nt6we_has9tn57v(s_2, mem.i32(i_0));
            var X60Qdesugar_5 = mem.u8At(X60Qx_26);
            X60Qx_2 = (((mem.u8At((X60Qdesugar_4 + (X60Qdesugar_5 >>> 3))) & ((1 << ((X60Qdesugar_5 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
          } else {
            X60Qx_2 = false;
          }
          if (X60Qx_2) {
            whileStmtLabel_1: {
              var X60Qx_27 = getQ_10_I5nt6we_has9tn57v(s_2, mem.i32(i_0));
              var c_1 = ((mem.u8At(X60Qx_27) - 48) | 0);
              if ((!overflow_0)) {
                if (((BigInt.asIntN(64, (-9223372036854775808n + BigInt(c_1))) / 10n) <= res_0)) {
                  res_0 = BigInt.asIntN(64, (BigInt.asIntN(64, (res_0 * 10n)) - BigInt(c_1)));
                } else {
                  overflow_0 = true;
                }
              }
              inc_1_I6wjjge_cmdqs323n1(i_0);
              {
                while (true) {
                  var X60Qx_28;
                  var X60Qx_29 = len_6_Iroq7kd1_has9tn57v(s_2);
                  if ((mem.i32(i_0) < X60Qx_29)) {
                    var X60Qx_30 = getQ_10_I5nt6we_has9tn57v(s_2, mem.i32(i_0));
                    X60Qx_28 = (mem.u8At(X60Qx_30) === 95);
                  } else {
                    X60Qx_28 = false;
                  }
                  if (X60Qx_28) {
                    inc_1_I6wjjge_cmdqs323n1(i_0);
                  } else {
                    break;
                  }
                }
              }
            }
          } else {
            break;
          }
        }
      }
    }
    var X60Qx_31;
    if ((sign_0 === -1n)) {
      X60Qx_31 = (res_0 === -9223372036854775808n);
    } else {
      X60Qx_31 = false;
    }
    if (X60Qx_31) {
      overflow_0 = true;
    }
    if (overflow_0) {
      result_2 = (-mem.i32(i_0));
    } else {
      mem.setI64(b_0, BigInt.asIntN(64, (res_0 * sign_0)));
      result_2 = mem.i32(i_0);
    }
  } else {
    result_2 = 0;
  }
  return result_2;
}

function parseBiggestInt_0_party5a2l1(s_3, number_2) {
  let result_3;
  let X60Qx_32 = allocFixed(8);
  mem.setU32(X60Qx_32, 1852271102);
  mem.setU32((X60Qx_32 + 4), strlit_0_I8031254106179394417_dir38pj6l);
  let res_1 = allocFixed(8);
  mem.setI64(res_1, 0n);
  let X60Qx_33 = rawParseInt_0_party5a2l1(s_3, res_1);
  result_3 = X60Qx_33;
  if ((0 < result_3)) {
    mem.setI64(number_2, mem.i64b(res_1));
  }
  return result_3;
}

function rawParseUInt_0_party5a2l1(s_4, b_1) {
  var result_4;
  var res_2 = allocFixed(8);
  mem.setU64(res_2, 0n);
  var i_1 = allocFixed(4);
  mem.setI32(i_1, 0);
  var overflow_1 = false;
  var X60Qx_3;
  var X60Qx_34;
  var X60Qx_35 = len_6_Iroq7kd1_has9tn57v(s_4);
  if ((mem.i32(i_1) < ((X60Qx_35 - 1) | 0))) {
    var X60Qx_36 = getQ_10_I5nt6we_has9tn57v(s_4, mem.i32(i_1));
    X60Qx_34 = (mem.u8At(X60Qx_36) === 45);
  } else {
    X60Qx_34 = false;
  }
  if (X60Qx_34) {
    var X60Qdesugar_6 = allocFixed(32);
    mem.setU8(X60Qdesugar_6, 0);
    mem.setU8((X60Qdesugar_6 + 1), 0);
    mem.setU8((X60Qdesugar_6 + 2), 0);
    mem.setU8((X60Qdesugar_6 + 3), 0);
    mem.setU8((X60Qdesugar_6 + 4), 0);
    mem.setU8((X60Qdesugar_6 + 5), 0);
    mem.setU8((X60Qdesugar_6 + 6), 255);
    mem.setU8((X60Qdesugar_6 + 7), 3);
    mem.setU8((X60Qdesugar_6 + 8), 0);
    mem.setU8((X60Qdesugar_6 + 9), 0);
    mem.setU8((X60Qdesugar_6 + 10), 0);
    mem.setU8((X60Qdesugar_6 + 11), 0);
    mem.setU8((X60Qdesugar_6 + 12), 0);
    mem.setU8((X60Qdesugar_6 + 13), 0);
    mem.setU8((X60Qdesugar_6 + 14), 0);
    mem.setU8((X60Qdesugar_6 + 15), 0);
    mem.setU8((X60Qdesugar_6 + 16), 0);
    mem.setU8((X60Qdesugar_6 + 17), 0);
    mem.setU8((X60Qdesugar_6 + 18), 0);
    mem.setU8((X60Qdesugar_6 + 19), 0);
    mem.setU8((X60Qdesugar_6 + 20), 0);
    mem.setU8((X60Qdesugar_6 + 21), 0);
    mem.setU8((X60Qdesugar_6 + 22), 0);
    mem.setU8((X60Qdesugar_6 + 23), 0);
    mem.setU8((X60Qdesugar_6 + 24), 0);
    mem.setU8((X60Qdesugar_6 + 25), 0);
    mem.setU8((X60Qdesugar_6 + 26), 0);
    mem.setU8((X60Qdesugar_6 + 27), 0);
    mem.setU8((X60Qdesugar_6 + 28), 0);
    mem.setU8((X60Qdesugar_6 + 29), 0);
    mem.setU8((X60Qdesugar_6 + 30), 0);
    mem.setU8((X60Qdesugar_6 + 31), 0);
    var X60Qx_37 = getQ_10_I5nt6we_has9tn57v(s_4, ((mem.i32(i_1) + 1) | 0));
    var X60Qdesugar_7 = mem.u8At(X60Qx_37);
    X60Qx_3 = (((mem.u8At((X60Qdesugar_6 + (X60Qdesugar_7 >>> 3))) & ((1 << ((X60Qdesugar_7 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
  } else {
    X60Qx_3 = false;
  }
  if (X60Qx_3) {
    overflow_1 = true;
    inc_1_I6wjjge_cmdqs323n1(i_1);
  }
  var X60Qx_38;
  var X60Qx_39 = len_6_Iroq7kd1_has9tn57v(s_4);
  if ((mem.i32(i_1) < X60Qx_39)) {
    var X60Qx_40 = getQ_10_I5nt6we_has9tn57v(s_4, mem.i32(i_1));
    X60Qx_38 = (mem.u8At(X60Qx_40) === 43);
  } else {
    X60Qx_38 = false;
  }
  if (X60Qx_38) {
    inc_1_I6wjjge_cmdqs323n1(i_1);
  }
  var X60Qx_4;
  var X60Qx_41 = len_6_Iroq7kd1_has9tn57v(s_4);
  if ((mem.i32(i_1) < X60Qx_41)) {
    var X60Qdesugar_8 = allocFixed(32);
    mem.setU8(X60Qdesugar_8, 0);
    mem.setU8((X60Qdesugar_8 + 1), 0);
    mem.setU8((X60Qdesugar_8 + 2), 0);
    mem.setU8((X60Qdesugar_8 + 3), 0);
    mem.setU8((X60Qdesugar_8 + 4), 0);
    mem.setU8((X60Qdesugar_8 + 5), 0);
    mem.setU8((X60Qdesugar_8 + 6), 255);
    mem.setU8((X60Qdesugar_8 + 7), 3);
    mem.setU8((X60Qdesugar_8 + 8), 0);
    mem.setU8((X60Qdesugar_8 + 9), 0);
    mem.setU8((X60Qdesugar_8 + 10), 0);
    mem.setU8((X60Qdesugar_8 + 11), 0);
    mem.setU8((X60Qdesugar_8 + 12), 0);
    mem.setU8((X60Qdesugar_8 + 13), 0);
    mem.setU8((X60Qdesugar_8 + 14), 0);
    mem.setU8((X60Qdesugar_8 + 15), 0);
    mem.setU8((X60Qdesugar_8 + 16), 0);
    mem.setU8((X60Qdesugar_8 + 17), 0);
    mem.setU8((X60Qdesugar_8 + 18), 0);
    mem.setU8((X60Qdesugar_8 + 19), 0);
    mem.setU8((X60Qdesugar_8 + 20), 0);
    mem.setU8((X60Qdesugar_8 + 21), 0);
    mem.setU8((X60Qdesugar_8 + 22), 0);
    mem.setU8((X60Qdesugar_8 + 23), 0);
    mem.setU8((X60Qdesugar_8 + 24), 0);
    mem.setU8((X60Qdesugar_8 + 25), 0);
    mem.setU8((X60Qdesugar_8 + 26), 0);
    mem.setU8((X60Qdesugar_8 + 27), 0);
    mem.setU8((X60Qdesugar_8 + 28), 0);
    mem.setU8((X60Qdesugar_8 + 29), 0);
    mem.setU8((X60Qdesugar_8 + 30), 0);
    mem.setU8((X60Qdesugar_8 + 31), 0);
    var X60Qx_42 = getQ_10_I5nt6we_has9tn57v(s_4, mem.i32(i_1));
    var X60Qdesugar_9 = mem.u8At(X60Qx_42);
    X60Qx_4 = (((mem.u8At((X60Qdesugar_8 + (X60Qdesugar_9 >>> 3))) & ((1 << ((X60Qdesugar_9 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
  } else {
    X60Qx_4 = false;
  }
  if (X60Qx_4) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_5;
          var X60Qx_43 = len_6_Iroq7kd1_has9tn57v(s_4);
          if ((mem.i32(i_1) < X60Qx_43)) {
            var X60Qdesugar_10 = allocFixed(32);
            mem.setU8(X60Qdesugar_10, 0);
            mem.setU8((X60Qdesugar_10 + 1), 0);
            mem.setU8((X60Qdesugar_10 + 2), 0);
            mem.setU8((X60Qdesugar_10 + 3), 0);
            mem.setU8((X60Qdesugar_10 + 4), 0);
            mem.setU8((X60Qdesugar_10 + 5), 0);
            mem.setU8((X60Qdesugar_10 + 6), 255);
            mem.setU8((X60Qdesugar_10 + 7), 3);
            mem.setU8((X60Qdesugar_10 + 8), 0);
            mem.setU8((X60Qdesugar_10 + 9), 0);
            mem.setU8((X60Qdesugar_10 + 10), 0);
            mem.setU8((X60Qdesugar_10 + 11), 0);
            mem.setU8((X60Qdesugar_10 + 12), 0);
            mem.setU8((X60Qdesugar_10 + 13), 0);
            mem.setU8((X60Qdesugar_10 + 14), 0);
            mem.setU8((X60Qdesugar_10 + 15), 0);
            mem.setU8((X60Qdesugar_10 + 16), 0);
            mem.setU8((X60Qdesugar_10 + 17), 0);
            mem.setU8((X60Qdesugar_10 + 18), 0);
            mem.setU8((X60Qdesugar_10 + 19), 0);
            mem.setU8((X60Qdesugar_10 + 20), 0);
            mem.setU8((X60Qdesugar_10 + 21), 0);
            mem.setU8((X60Qdesugar_10 + 22), 0);
            mem.setU8((X60Qdesugar_10 + 23), 0);
            mem.setU8((X60Qdesugar_10 + 24), 0);
            mem.setU8((X60Qdesugar_10 + 25), 0);
            mem.setU8((X60Qdesugar_10 + 26), 0);
            mem.setU8((X60Qdesugar_10 + 27), 0);
            mem.setU8((X60Qdesugar_10 + 28), 0);
            mem.setU8((X60Qdesugar_10 + 29), 0);
            mem.setU8((X60Qdesugar_10 + 30), 0);
            mem.setU8((X60Qdesugar_10 + 31), 0);
            var X60Qx_44 = getQ_10_I5nt6we_has9tn57v(s_4, mem.i32(i_1));
            var X60Qdesugar_11 = mem.u8At(X60Qx_44);
            X60Qx_5 = (((mem.u8At((X60Qdesugar_10 + (X60Qdesugar_11 >>> 3))) & ((1 << ((X60Qdesugar_11 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
          } else {
            X60Qx_5 = false;
          }
          if (X60Qx_5) {
            whileStmtLabel_1: {
              if ((!overflow_1)) {
                if (((18446744073709551615n / 10n) < mem.u64b(res_2))) {
                  overflow_1 = true;
                } else {
                  mem.setU64(res_2, BigInt.asUintN(64, (mem.u64b(res_2) * 10n)));
                  var prev_0 = mem.u64b(res_2);
                  var X60Qx_45 = getQ_10_I5nt6we_has9tn57v(s_4, mem.i32(i_1));
                  inc_0_Ineawm41_party5a2l1(res_2, BigInt(((mem.u8At(X60Qx_45) - 48) | 0)));
                  if ((mem.u64b(res_2) < prev_0)) {
                    overflow_1 = true;
                  }
                }
              }
              inc_1_I6wjjge_cmdqs323n1(i_1);
              {
                while (true) {
                  var X60Qx_46;
                  var X60Qx_47 = len_6_Iroq7kd1_has9tn57v(s_4);
                  if ((mem.i32(i_1) < X60Qx_47)) {
                    var X60Qx_48 = getQ_10_I5nt6we_has9tn57v(s_4, mem.i32(i_1));
                    X60Qx_46 = (mem.u8At(X60Qx_48) === 95);
                  } else {
                    X60Qx_46 = false;
                  }
                  if (X60Qx_46) {
                    inc_1_I6wjjge_cmdqs323n1(i_1);
                  } else {
                    break;
                  }
                }
              }
            }
          } else {
            break;
          }
        }
      }
    }
    if (overflow_1) {
      result_4 = (-mem.i32(i_1));
    } else {
      mem.setU64(b_1, mem.u64b(res_2));
      result_4 = mem.i32(i_1);
    }
  } else {
    result_4 = 0;
  }
  return result_4;
}

function parseBiggestUInt_0_party5a2l1(s_5, number_3) {
  let result_5;
  let X60Qx_49 = allocFixed(8);
  mem.setU32(X60Qx_49, 1852271102);
  mem.setU32((X60Qx_49 + 4), strlit_0_I8031254106179394417_dir38pj6l);
  let res_3 = allocFixed(8);
  mem.setU64(res_3, 0n);
  let X60Qx_50 = rawParseUInt_0_party5a2l1(s_5, res_3);
  result_5 = X60Qx_50;
  if ((0 < result_5)) {
    mem.setU64(number_3, mem.u64b(res_3));
  }
  return result_5;
}

function parseBiggestFloat_0_party5a2l1(s_6, number_4) {
  whileStmtLabel_8: {
    whileStmtLabel_0: {
      var result_6;
      var IdentChars_0 = allocFixed(32);
      mem.setU8(IdentChars_0, 0);
      mem.setU8((IdentChars_0 + 1), 0);
      mem.setU8((IdentChars_0 + 2), 0);
      mem.setU8((IdentChars_0 + 3), 0);
      mem.setU8((IdentChars_0 + 4), 0);
      mem.setU8((IdentChars_0 + 5), 0);
      mem.setU8((IdentChars_0 + 6), 255);
      mem.setU8((IdentChars_0 + 7), 3);
      mem.setU8((IdentChars_0 + 8), 254);
      mem.setU8((IdentChars_0 + 9), 255);
      mem.setU8((IdentChars_0 + 10), 255);
      mem.setU8((IdentChars_0 + 11), 135);
      mem.setU8((IdentChars_0 + 12), 254);
      mem.setU8((IdentChars_0 + 13), 255);
      mem.setU8((IdentChars_0 + 14), 255);
      mem.setU8((IdentChars_0 + 15), 7);
      mem.setU8((IdentChars_0 + 16), 0);
      mem.setU8((IdentChars_0 + 17), 0);
      mem.setU8((IdentChars_0 + 18), 0);
      mem.setU8((IdentChars_0 + 19), 0);
      mem.setU8((IdentChars_0 + 20), 0);
      mem.setU8((IdentChars_0 + 21), 0);
      mem.setU8((IdentChars_0 + 22), 0);
      mem.setU8((IdentChars_0 + 23), 0);
      mem.setU8((IdentChars_0 + 24), 0);
      mem.setU8((IdentChars_0 + 25), 0);
      mem.setU8((IdentChars_0 + 26), 0);
      mem.setU8((IdentChars_0 + 27), 0);
      mem.setU8((IdentChars_0 + 28), 0);
      mem.setU8((IdentChars_0 + 29), 0);
      mem.setU8((IdentChars_0 + 30), 0);
      mem.setU8((IdentChars_0 + 31), 0);
      var powtens_0 = allocFixed(184);
      mem.setF64(powtens_0, 1.0);
      mem.setF64((powtens_0 + 8), 10.0);
      mem.setF64((powtens_0 + 16), 100.0);
      mem.setF64((powtens_0 + 24), 1000.0);
      mem.setF64((powtens_0 + 32), 10000.0);
      mem.setF64((powtens_0 + 40), 100000.0);
      mem.setF64((powtens_0 + 48), 1000000.0);
      mem.setF64((powtens_0 + 56), 10000000.0);
      mem.setF64((powtens_0 + 64), 100000000.0);
      mem.setF64((powtens_0 + 72), 1000000000.0);
      mem.setF64((powtens_0 + 80), 10000000000.0);
      mem.setF64((powtens_0 + 88), 100000000000.0);
      mem.setF64((powtens_0 + 96), 1000000000000.0);
      mem.setF64((powtens_0 + 104), 10000000000000.0);
      mem.setF64((powtens_0 + 112), 100000000000000.0);
      mem.setF64((powtens_0 + 120), 1000000000000000.0);
      mem.setF64((powtens_0 + 128), 10000000000000000.0);
      mem.setF64((powtens_0 + 136), 1e+17);
      mem.setF64((powtens_0 + 144), 1e+18);
      mem.setF64((powtens_0 + 152), 1e+19);
      mem.setF64((powtens_0 + 160), 1e+20);
      mem.setF64((powtens_0 + 168), 1e+21);
      mem.setF64((powtens_0 + 176), 1e+22);
      var i_2 = allocFixed(4);
      mem.setI32(i_2, 0);
      var sign_1 = 1.0;
      var kdigits_0 = allocFixed(4);
      mem.setI32(kdigits_0, 0);
      var fdigits_0 = allocFixed(4);
      mem.setI32(fdigits_0, 0);
      var exponent_0 = 0;
      var integer_0 = 0n;
      var fracExponent_0 = allocFixed(4);
      mem.setI32(fracExponent_0, 0);
      var expSign_0 = 1;
      var firstDigit_0 = -1;
      var hasSign_0 = false;
      var X60Qx_51;
      var X60Qx_52 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((mem.i32(i_2) < X60Qx_52)) {
        var X60Qx_53;
        var X60Qx_54 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_54) === 43)) {
          X60Qx_53 = true;
        } else {
          var X60Qx_55 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_53 = (mem.u8At(X60Qx_55) === 45);
        }
        X60Qx_51 = X60Qx_53;
      } else {
        X60Qx_51 = false;
      }
      if (X60Qx_51) {
        hasSign_0 = true;
        var X60Qx_56 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_56) === 45)) {
          sign_1 = -1.0;
        }
        inc_1_I6wjjge_cmdqs323n1(i_2);
      }
      var X60Qx_57;
      var X60Qx_58 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((((mem.i32(i_2) + 2) | 0) < X60Qx_58)) {
        var X60Qx_59;
        var X60Qx_60 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_60) === 78)) {
          X60Qx_59 = true;
        } else {
          var X60Qx_61 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_59 = (mem.u8At(X60Qx_61) === 110);
        }
        X60Qx_57 = X60Qx_59;
      } else {
        X60Qx_57 = false;
      }
      if (X60Qx_57) {
        var X60Qx_62;
        var X60Qx_63 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
        if ((mem.u8At(X60Qx_63) === 65)) {
          X60Qx_62 = true;
        } else {
          var X60Qx_64 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
          X60Qx_62 = (mem.u8At(X60Qx_64) === 97);
        }
        if (X60Qx_62) {
          var X60Qx_65;
          var X60Qx_66 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
          if ((mem.u8At(X60Qx_66) === 78)) {
            X60Qx_65 = true;
          } else {
            var X60Qx_67 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
            X60Qx_65 = (mem.u8At(X60Qx_67) === 110);
          }
          if (X60Qx_65) {
            var X60Qx_6;
            if ((mem.i32((s_6 + 4)) <= ((mem.i32(i_2) + 3) | 0))) {
              X60Qx_6 = true;
            } else {
              var X60Qdesugar_12 = allocFixed(32);
              mem.copy(X60Qdesugar_12, IdentChars_0, 32);
              var X60Qx_68 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 3) | 0));
              var X60Qdesugar_13 = mem.u8At(X60Qx_68);
              X60Qx_6 = (!(((mem.u8At((X60Qdesugar_12 + (X60Qdesugar_13 >>> 3))) & ((1 << ((X60Qdesugar_13 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            }
            if (X60Qx_6) {
              mem.setF64(number_4, NaN);
              result_6 = ((mem.i32(i_2) + 3) | 0);
              return result_6;
            }
          }
        }
        return 0;
      }
      var X60Qx_69;
      var X60Qx_70 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((((mem.i32(i_2) + 2) | 0) < X60Qx_70)) {
        var X60Qx_71;
        var X60Qx_72 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_72) === 73)) {
          X60Qx_71 = true;
        } else {
          var X60Qx_73 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_71 = (mem.u8At(X60Qx_73) === 105);
        }
        X60Qx_69 = X60Qx_71;
      } else {
        X60Qx_69 = false;
      }
      if (X60Qx_69) {
        var X60Qx_74;
        var X60Qx_75 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
        if ((mem.u8At(X60Qx_75) === 78)) {
          X60Qx_74 = true;
        } else {
          var X60Qx_76 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
          X60Qx_74 = (mem.u8At(X60Qx_76) === 110);
        }
        if (X60Qx_74) {
          var X60Qx_77;
          var X60Qx_78 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
          if ((mem.u8At(X60Qx_78) === 70)) {
            X60Qx_77 = true;
          } else {
            var X60Qx_79 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
            X60Qx_77 = (mem.u8At(X60Qx_79) === 102);
          }
          if (X60Qx_77) {
            var X60Qx_7;
            if ((mem.i32((s_6 + 4)) <= ((mem.i32(i_2) + 3) | 0))) {
              X60Qx_7 = true;
            } else {
              var X60Qdesugar_14 = allocFixed(32);
              mem.copy(X60Qdesugar_14, IdentChars_0, 32);
              var X60Qx_80 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 3) | 0));
              var X60Qdesugar_15 = mem.u8At(X60Qx_80);
              X60Qx_7 = (!(((mem.u8At((X60Qdesugar_14 + (X60Qdesugar_15 >>> 3))) & ((1 << ((X60Qdesugar_15 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            }
            if (X60Qx_7) {
              mem.setF64(number_4, (Infinity * sign_1));
              result_6 = ((mem.i32(i_2) + 3) | 0);
              return result_6;
            }
          }
        }
        return 0;
      }
      var X60Qx_8;
      var X60Qx_81 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((mem.i32(i_2) < X60Qx_81)) {
        var X60Qdesugar_16 = allocFixed(32);
        mem.setU8(X60Qdesugar_16, 0);
        mem.setU8((X60Qdesugar_16 + 1), 0);
        mem.setU8((X60Qdesugar_16 + 2), 0);
        mem.setU8((X60Qdesugar_16 + 3), 0);
        mem.setU8((X60Qdesugar_16 + 4), 0);
        mem.setU8((X60Qdesugar_16 + 5), 0);
        mem.setU8((X60Qdesugar_16 + 6), 255);
        mem.setU8((X60Qdesugar_16 + 7), 3);
        mem.setU8((X60Qdesugar_16 + 8), 0);
        mem.setU8((X60Qdesugar_16 + 9), 0);
        mem.setU8((X60Qdesugar_16 + 10), 0);
        mem.setU8((X60Qdesugar_16 + 11), 0);
        mem.setU8((X60Qdesugar_16 + 12), 0);
        mem.setU8((X60Qdesugar_16 + 13), 0);
        mem.setU8((X60Qdesugar_16 + 14), 0);
        mem.setU8((X60Qdesugar_16 + 15), 0);
        mem.setU8((X60Qdesugar_16 + 16), 0);
        mem.setU8((X60Qdesugar_16 + 17), 0);
        mem.setU8((X60Qdesugar_16 + 18), 0);
        mem.setU8((X60Qdesugar_16 + 19), 0);
        mem.setU8((X60Qdesugar_16 + 20), 0);
        mem.setU8((X60Qdesugar_16 + 21), 0);
        mem.setU8((X60Qdesugar_16 + 22), 0);
        mem.setU8((X60Qdesugar_16 + 23), 0);
        mem.setU8((X60Qdesugar_16 + 24), 0);
        mem.setU8((X60Qdesugar_16 + 25), 0);
        mem.setU8((X60Qdesugar_16 + 26), 0);
        mem.setU8((X60Qdesugar_16 + 27), 0);
        mem.setU8((X60Qdesugar_16 + 28), 0);
        mem.setU8((X60Qdesugar_16 + 29), 0);
        mem.setU8((X60Qdesugar_16 + 30), 0);
        mem.setU8((X60Qdesugar_16 + 31), 0);
        var X60Qx_82 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        var X60Qdesugar_17 = mem.u8At(X60Qx_82);
        X60Qx_8 = (((mem.u8At((X60Qdesugar_16 + (X60Qdesugar_17 >>> 3))) & ((1 << ((X60Qdesugar_17 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
      } else {
        X60Qx_8 = false;
      }
      if (X60Qx_8) {
        var X60Qx_83 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        firstDigit_0 = ((mem.u8At(X60Qx_83) - 48) | 0);
      }
      {
        while (true) {
          var X60Qx_9;
          var X60Qx_84 = len_6_Iroq7kd1_has9tn57v(s_6);
          if ((mem.i32(i_2) < X60Qx_84)) {
            var X60Qdesugar_18 = allocFixed(32);
            mem.setU8(X60Qdesugar_18, 0);
            mem.setU8((X60Qdesugar_18 + 1), 0);
            mem.setU8((X60Qdesugar_18 + 2), 0);
            mem.setU8((X60Qdesugar_18 + 3), 0);
            mem.setU8((X60Qdesugar_18 + 4), 0);
            mem.setU8((X60Qdesugar_18 + 5), 0);
            mem.setU8((X60Qdesugar_18 + 6), 255);
            mem.setU8((X60Qdesugar_18 + 7), 3);
            mem.setU8((X60Qdesugar_18 + 8), 0);
            mem.setU8((X60Qdesugar_18 + 9), 0);
            mem.setU8((X60Qdesugar_18 + 10), 0);
            mem.setU8((X60Qdesugar_18 + 11), 0);
            mem.setU8((X60Qdesugar_18 + 12), 0);
            mem.setU8((X60Qdesugar_18 + 13), 0);
            mem.setU8((X60Qdesugar_18 + 14), 0);
            mem.setU8((X60Qdesugar_18 + 15), 0);
            mem.setU8((X60Qdesugar_18 + 16), 0);
            mem.setU8((X60Qdesugar_18 + 17), 0);
            mem.setU8((X60Qdesugar_18 + 18), 0);
            mem.setU8((X60Qdesugar_18 + 19), 0);
            mem.setU8((X60Qdesugar_18 + 20), 0);
            mem.setU8((X60Qdesugar_18 + 21), 0);
            mem.setU8((X60Qdesugar_18 + 22), 0);
            mem.setU8((X60Qdesugar_18 + 23), 0);
            mem.setU8((X60Qdesugar_18 + 24), 0);
            mem.setU8((X60Qdesugar_18 + 25), 0);
            mem.setU8((X60Qdesugar_18 + 26), 0);
            mem.setU8((X60Qdesugar_18 + 27), 0);
            mem.setU8((X60Qdesugar_18 + 28), 0);
            mem.setU8((X60Qdesugar_18 + 29), 0);
            mem.setU8((X60Qdesugar_18 + 30), 0);
            mem.setU8((X60Qdesugar_18 + 31), 0);
            var X60Qx_85 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
            var X60Qdesugar_19 = mem.u8At(X60Qx_85);
            X60Qx_9 = (((mem.u8At((X60Qdesugar_18 + (X60Qdesugar_19 >>> 3))) & ((1 << ((X60Qdesugar_19 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
          } else {
            X60Qx_9 = false;
          }
          if (X60Qx_9) {
            whileStmtLabel_1: {
              inc_1_I6wjjge_cmdqs323n1(kdigits_0);
              var X60Qx_86 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              integer_0 = BigInt.asUintN(64, (BigInt.asUintN(64, (integer_0 * 10n)) + BigInt(((mem.u8At(X60Qx_86) - 48) | 0))));
              inc_1_I6wjjge_cmdqs323n1(i_2);
              {
                while (true) {
                  var X60Qx_87;
                  var X60Qx_88 = len_6_Iroq7kd1_has9tn57v(s_6);
                  if ((mem.i32(i_2) < X60Qx_88)) {
                    var X60Qx_89 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                    X60Qx_87 = (mem.u8At(X60Qx_89) === 95);
                  } else {
                    X60Qx_87 = false;
                  }
                  if (X60Qx_87) {
                    inc_1_I6wjjge_cmdqs323n1(i_2);
                  } else {
                    break;
                  }
                }
              }
            }
          } else {
            break;
          }
        }
      }
    }
    var X60Qx_90;
    var X60Qx_91 = len_6_Iroq7kd1_has9tn57v(s_6);
    if ((mem.i32(i_2) < X60Qx_91)) {
      var X60Qx_92 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
      X60Qx_90 = (mem.u8At(X60Qx_92) === 46);
    } else {
      X60Qx_90 = false;
    }
    if (X60Qx_90) {
      whileStmtLabel_4: {
        inc_1_I6wjjge_cmdqs323n1(i_2);
        if ((mem.i32(kdigits_0) <= 0)) {
          whileStmtLabel_2: {
            {
              while (true) {
                var X60Qx_93;
                var X60Qx_94 = len_6_Iroq7kd1_has9tn57v(s_6);
                if ((mem.i32(i_2) < X60Qx_94)) {
                  var X60Qx_95 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                  X60Qx_93 = (mem.u8At(X60Qx_95) === 48);
                } else {
                  X60Qx_93 = false;
                }
                if (X60Qx_93) {
                  whileStmtLabel_3: {
                    inc_1_I6wjjge_cmdqs323n1(fracExponent_0);
                    inc_1_I6wjjge_cmdqs323n1(i_2);
                    {
                      while (true) {
                        var X60Qx_96;
                        var X60Qx_97 = len_6_Iroq7kd1_has9tn57v(s_6);
                        if ((mem.i32(i_2) < X60Qx_97)) {
                          var X60Qx_98 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                          X60Qx_96 = (mem.u8At(X60Qx_98) === 95);
                        } else {
                          X60Qx_96 = false;
                        }
                        if (X60Qx_96) {
                          inc_1_I6wjjge_cmdqs323n1(i_2);
                        } else {
                          break;
                        }
                      }
                    }
                  }
                } else {
                  break;
                }
              }
            }
          }
        }
        var X60Qx_10;
        var X60Qx_99;
        if ((firstDigit_0 === -1)) {
          var X60Qx_100 = len_6_Iroq7kd1_has9tn57v(s_6);
          X60Qx_99 = (mem.i32(i_2) < X60Qx_100);
        } else {
          X60Qx_99 = false;
        }
        if (X60Qx_99) {
          var X60Qdesugar_20 = allocFixed(32);
          mem.setU8(X60Qdesugar_20, 0);
          mem.setU8((X60Qdesugar_20 + 1), 0);
          mem.setU8((X60Qdesugar_20 + 2), 0);
          mem.setU8((X60Qdesugar_20 + 3), 0);
          mem.setU8((X60Qdesugar_20 + 4), 0);
          mem.setU8((X60Qdesugar_20 + 5), 0);
          mem.setU8((X60Qdesugar_20 + 6), 255);
          mem.setU8((X60Qdesugar_20 + 7), 3);
          mem.setU8((X60Qdesugar_20 + 8), 0);
          mem.setU8((X60Qdesugar_20 + 9), 0);
          mem.setU8((X60Qdesugar_20 + 10), 0);
          mem.setU8((X60Qdesugar_20 + 11), 0);
          mem.setU8((X60Qdesugar_20 + 12), 0);
          mem.setU8((X60Qdesugar_20 + 13), 0);
          mem.setU8((X60Qdesugar_20 + 14), 0);
          mem.setU8((X60Qdesugar_20 + 15), 0);
          mem.setU8((X60Qdesugar_20 + 16), 0);
          mem.setU8((X60Qdesugar_20 + 17), 0);
          mem.setU8((X60Qdesugar_20 + 18), 0);
          mem.setU8((X60Qdesugar_20 + 19), 0);
          mem.setU8((X60Qdesugar_20 + 20), 0);
          mem.setU8((X60Qdesugar_20 + 21), 0);
          mem.setU8((X60Qdesugar_20 + 22), 0);
          mem.setU8((X60Qdesugar_20 + 23), 0);
          mem.setU8((X60Qdesugar_20 + 24), 0);
          mem.setU8((X60Qdesugar_20 + 25), 0);
          mem.setU8((X60Qdesugar_20 + 26), 0);
          mem.setU8((X60Qdesugar_20 + 27), 0);
          mem.setU8((X60Qdesugar_20 + 28), 0);
          mem.setU8((X60Qdesugar_20 + 29), 0);
          mem.setU8((X60Qdesugar_20 + 30), 0);
          mem.setU8((X60Qdesugar_20 + 31), 0);
          var X60Qx_101 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          var X60Qdesugar_21 = mem.u8At(X60Qx_101);
          X60Qx_10 = (((mem.u8At((X60Qdesugar_20 + (X60Qdesugar_21 >>> 3))) & ((1 << ((X60Qdesugar_21 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_10 = false;
        }
        if (X60Qx_10) {
          var X60Qx_102 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          firstDigit_0 = ((mem.u8At(X60Qx_102) - 48) | 0);
        }
        {
          while (true) {
            var X60Qx_11;
            var X60Qx_103 = len_6_Iroq7kd1_has9tn57v(s_6);
            if ((mem.i32(i_2) < X60Qx_103)) {
              var X60Qdesugar_22 = allocFixed(32);
              mem.setU8(X60Qdesugar_22, 0);
              mem.setU8((X60Qdesugar_22 + 1), 0);
              mem.setU8((X60Qdesugar_22 + 2), 0);
              mem.setU8((X60Qdesugar_22 + 3), 0);
              mem.setU8((X60Qdesugar_22 + 4), 0);
              mem.setU8((X60Qdesugar_22 + 5), 0);
              mem.setU8((X60Qdesugar_22 + 6), 255);
              mem.setU8((X60Qdesugar_22 + 7), 3);
              mem.setU8((X60Qdesugar_22 + 8), 0);
              mem.setU8((X60Qdesugar_22 + 9), 0);
              mem.setU8((X60Qdesugar_22 + 10), 0);
              mem.setU8((X60Qdesugar_22 + 11), 0);
              mem.setU8((X60Qdesugar_22 + 12), 0);
              mem.setU8((X60Qdesugar_22 + 13), 0);
              mem.setU8((X60Qdesugar_22 + 14), 0);
              mem.setU8((X60Qdesugar_22 + 15), 0);
              mem.setU8((X60Qdesugar_22 + 16), 0);
              mem.setU8((X60Qdesugar_22 + 17), 0);
              mem.setU8((X60Qdesugar_22 + 18), 0);
              mem.setU8((X60Qdesugar_22 + 19), 0);
              mem.setU8((X60Qdesugar_22 + 20), 0);
              mem.setU8((X60Qdesugar_22 + 21), 0);
              mem.setU8((X60Qdesugar_22 + 22), 0);
              mem.setU8((X60Qdesugar_22 + 23), 0);
              mem.setU8((X60Qdesugar_22 + 24), 0);
              mem.setU8((X60Qdesugar_22 + 25), 0);
              mem.setU8((X60Qdesugar_22 + 26), 0);
              mem.setU8((X60Qdesugar_22 + 27), 0);
              mem.setU8((X60Qdesugar_22 + 28), 0);
              mem.setU8((X60Qdesugar_22 + 29), 0);
              mem.setU8((X60Qdesugar_22 + 30), 0);
              mem.setU8((X60Qdesugar_22 + 31), 0);
              var X60Qx_104 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              var X60Qdesugar_23 = mem.u8At(X60Qx_104);
              X60Qx_11 = (((mem.u8At((X60Qdesugar_22 + (X60Qdesugar_23 >>> 3))) & ((1 << ((X60Qdesugar_23 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
            } else {
              X60Qx_11 = false;
            }
            if (X60Qx_11) {
              whileStmtLabel_5: {
                inc_1_I6wjjge_cmdqs323n1(fdigits_0);
                inc_1_I6wjjge_cmdqs323n1(fracExponent_0);
                var X60Qx_105 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                integer_0 = BigInt.asUintN(64, (BigInt.asUintN(64, (integer_0 * 10n)) + BigInt(((mem.u8At(X60Qx_105) - 48) | 0))));
                inc_1_I6wjjge_cmdqs323n1(i_2);
                {
                  while (true) {
                    var X60Qx_106;
                    var X60Qx_107 = len_6_Iroq7kd1_has9tn57v(s_6);
                    if ((mem.i32(i_2) < X60Qx_107)) {
                      var X60Qx_108 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                      X60Qx_106 = (mem.u8At(X60Qx_108) === 95);
                    } else {
                      X60Qx_106 = false;
                    }
                    if (X60Qx_106) {
                      inc_1_I6wjjge_cmdqs323n1(i_2);
                    } else {
                      break;
                    }
                  }
                }
              }
            } else {
              break;
            }
          }
        }
      }
    }
    var X60Qx_109;
    if ((((mem.i32(kdigits_0) + mem.i32(fdigits_0)) | 0) <= 0)) {
      var X60Qx_110;
      if ((mem.i32(i_2) === 0)) {
        X60Qx_110 = true;
      } else {
        var X60Qx_111;
        if ((mem.i32(i_2) === 1)) {
          X60Qx_111 = hasSign_0;
        } else {
          X60Qx_111 = false;
        }
        X60Qx_110 = X60Qx_111;
      }
      X60Qx_109 = X60Qx_110;
    } else {
      X60Qx_109 = false;
    }
    if (X60Qx_109) {
      return 0;
    }
    var X60Qx_12;
    var X60Qx_112 = len_6_Iroq7kd1_has9tn57v(s_6);
    if ((((mem.i32(i_2) + 1) | 0) < X60Qx_112)) {
      var X60Qdesugar_24 = allocFixed(32);
      mem.setU8(X60Qdesugar_24, 0);
      mem.setU8((X60Qdesugar_24 + 1), 0);
      mem.setU8((X60Qdesugar_24 + 2), 0);
      mem.setU8((X60Qdesugar_24 + 3), 0);
      mem.setU8((X60Qdesugar_24 + 4), 0);
      mem.setU8((X60Qdesugar_24 + 5), 0);
      mem.setU8((X60Qdesugar_24 + 6), 0);
      mem.setU8((X60Qdesugar_24 + 7), 0);
      mem.setU8((X60Qdesugar_24 + 8), 32);
      mem.setU8((X60Qdesugar_24 + 9), 0);
      mem.setU8((X60Qdesugar_24 + 10), 0);
      mem.setU8((X60Qdesugar_24 + 11), 0);
      mem.setU8((X60Qdesugar_24 + 12), 32);
      mem.setU8((X60Qdesugar_24 + 13), 0);
      mem.setU8((X60Qdesugar_24 + 14), 0);
      mem.setU8((X60Qdesugar_24 + 15), 0);
      mem.setU8((X60Qdesugar_24 + 16), 0);
      mem.setU8((X60Qdesugar_24 + 17), 0);
      mem.setU8((X60Qdesugar_24 + 18), 0);
      mem.setU8((X60Qdesugar_24 + 19), 0);
      mem.setU8((X60Qdesugar_24 + 20), 0);
      mem.setU8((X60Qdesugar_24 + 21), 0);
      mem.setU8((X60Qdesugar_24 + 22), 0);
      mem.setU8((X60Qdesugar_24 + 23), 0);
      mem.setU8((X60Qdesugar_24 + 24), 0);
      mem.setU8((X60Qdesugar_24 + 25), 0);
      mem.setU8((X60Qdesugar_24 + 26), 0);
      mem.setU8((X60Qdesugar_24 + 27), 0);
      mem.setU8((X60Qdesugar_24 + 28), 0);
      mem.setU8((X60Qdesugar_24 + 29), 0);
      mem.setU8((X60Qdesugar_24 + 30), 0);
      mem.setU8((X60Qdesugar_24 + 31), 0);
      var X60Qx_113 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
      var X60Qdesugar_25 = mem.u8At(X60Qx_113);
      X60Qx_12 = (((mem.u8At((X60Qdesugar_24 + (X60Qdesugar_25 >>> 3))) & ((1 << ((X60Qdesugar_25 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
    } else {
      X60Qx_12 = false;
    }
    if (X60Qx_12) {
      whileStmtLabel_6: {
        inc_1_I6wjjge_cmdqs323n1(i_2);
        var X60Qx_114;
        var X60Qx_115 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_115) === 43)) {
          X60Qx_114 = true;
        } else {
          var X60Qx_116 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_114 = (mem.u8At(X60Qx_116) === 45);
        }
        if (X60Qx_114) {
          var X60Qx_117 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          if ((mem.u8At(X60Qx_117) === 45)) {
            expSign_0 = -1;
          }
          inc_1_I6wjjge_cmdqs323n1(i_2);
        }
        var X60Qdesugar_26 = allocFixed(32);
        mem.setU8(X60Qdesugar_26, 0);
        mem.setU8((X60Qdesugar_26 + 1), 0);
        mem.setU8((X60Qdesugar_26 + 2), 0);
        mem.setU8((X60Qdesugar_26 + 3), 0);
        mem.setU8((X60Qdesugar_26 + 4), 0);
        mem.setU8((X60Qdesugar_26 + 5), 0);
        mem.setU8((X60Qdesugar_26 + 6), 255);
        mem.setU8((X60Qdesugar_26 + 7), 3);
        mem.setU8((X60Qdesugar_26 + 8), 0);
        mem.setU8((X60Qdesugar_26 + 9), 0);
        mem.setU8((X60Qdesugar_26 + 10), 0);
        mem.setU8((X60Qdesugar_26 + 11), 0);
        mem.setU8((X60Qdesugar_26 + 12), 0);
        mem.setU8((X60Qdesugar_26 + 13), 0);
        mem.setU8((X60Qdesugar_26 + 14), 0);
        mem.setU8((X60Qdesugar_26 + 15), 0);
        mem.setU8((X60Qdesugar_26 + 16), 0);
        mem.setU8((X60Qdesugar_26 + 17), 0);
        mem.setU8((X60Qdesugar_26 + 18), 0);
        mem.setU8((X60Qdesugar_26 + 19), 0);
        mem.setU8((X60Qdesugar_26 + 20), 0);
        mem.setU8((X60Qdesugar_26 + 21), 0);
        mem.setU8((X60Qdesugar_26 + 22), 0);
        mem.setU8((X60Qdesugar_26 + 23), 0);
        mem.setU8((X60Qdesugar_26 + 24), 0);
        mem.setU8((X60Qdesugar_26 + 25), 0);
        mem.setU8((X60Qdesugar_26 + 26), 0);
        mem.setU8((X60Qdesugar_26 + 27), 0);
        mem.setU8((X60Qdesugar_26 + 28), 0);
        mem.setU8((X60Qdesugar_26 + 29), 0);
        mem.setU8((X60Qdesugar_26 + 30), 0);
        mem.setU8((X60Qdesugar_26 + 31), 0);
        var X60Qx_118 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        var X60Qdesugar_27 = mem.u8At(X60Qx_118);
        if ((!(((mem.u8At((X60Qdesugar_26 + (X60Qdesugar_27 >>> 3))) & ((1 << ((X60Qdesugar_27 & 7) >>> 0)) >>> 0)) >>> 0) !== 0))) {
          return 0;
        }
        {
          while (true) {
            var X60Qx_13;
            var X60Qx_119 = len_6_Iroq7kd1_has9tn57v(s_6);
            if ((mem.i32(i_2) < X60Qx_119)) {
              var X60Qdesugar_28 = allocFixed(32);
              mem.setU8(X60Qdesugar_28, 0);
              mem.setU8((X60Qdesugar_28 + 1), 0);
              mem.setU8((X60Qdesugar_28 + 2), 0);
              mem.setU8((X60Qdesugar_28 + 3), 0);
              mem.setU8((X60Qdesugar_28 + 4), 0);
              mem.setU8((X60Qdesugar_28 + 5), 0);
              mem.setU8((X60Qdesugar_28 + 6), 255);
              mem.setU8((X60Qdesugar_28 + 7), 3);
              mem.setU8((X60Qdesugar_28 + 8), 0);
              mem.setU8((X60Qdesugar_28 + 9), 0);
              mem.setU8((X60Qdesugar_28 + 10), 0);
              mem.setU8((X60Qdesugar_28 + 11), 0);
              mem.setU8((X60Qdesugar_28 + 12), 0);
              mem.setU8((X60Qdesugar_28 + 13), 0);
              mem.setU8((X60Qdesugar_28 + 14), 0);
              mem.setU8((X60Qdesugar_28 + 15), 0);
              mem.setU8((X60Qdesugar_28 + 16), 0);
              mem.setU8((X60Qdesugar_28 + 17), 0);
              mem.setU8((X60Qdesugar_28 + 18), 0);
              mem.setU8((X60Qdesugar_28 + 19), 0);
              mem.setU8((X60Qdesugar_28 + 20), 0);
              mem.setU8((X60Qdesugar_28 + 21), 0);
              mem.setU8((X60Qdesugar_28 + 22), 0);
              mem.setU8((X60Qdesugar_28 + 23), 0);
              mem.setU8((X60Qdesugar_28 + 24), 0);
              mem.setU8((X60Qdesugar_28 + 25), 0);
              mem.setU8((X60Qdesugar_28 + 26), 0);
              mem.setU8((X60Qdesugar_28 + 27), 0);
              mem.setU8((X60Qdesugar_28 + 28), 0);
              mem.setU8((X60Qdesugar_28 + 29), 0);
              mem.setU8((X60Qdesugar_28 + 30), 0);
              mem.setU8((X60Qdesugar_28 + 31), 0);
              var X60Qx_120 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              var X60Qdesugar_29 = mem.u8At(X60Qx_120);
              X60Qx_13 = (((mem.u8At((X60Qdesugar_28 + (X60Qdesugar_29 >>> 3))) & ((1 << ((X60Qdesugar_29 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
            } else {
              X60Qx_13 = false;
            }
            if (X60Qx_13) {
              whileStmtLabel_7: {
                var X60Qx_121 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                exponent_0 = ((Math.imul(exponent_0, 10) + ((mem.u8At(X60Qx_121) - 48) | 0)) | 0);
                inc_1_I6wjjge_cmdqs323n1(i_2);
                {
                  while (true) {
                    var X60Qx_122;
                    var X60Qx_123 = len_6_Iroq7kd1_has9tn57v(s_6);
                    if ((mem.i32(i_2) < X60Qx_123)) {
                      var X60Qx_124 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                      X60Qx_122 = (mem.u8At(X60Qx_124) === 95);
                    } else {
                      X60Qx_122 = false;
                    }
                    if (X60Qx_122) {
                      inc_1_I6wjjge_cmdqs323n1(i_2);
                    } else {
                      break;
                    }
                  }
                }
              }
            } else {
              break;
            }
          }
        }
      }
    }
    var realExponent_0 = ((Math.imul(expSign_0, exponent_0) - mem.i32(fracExponent_0)) | 0);
    var expNegative_0 = (realExponent_0 < 0);
    var absExponent_0 = abs_0_Iycnqz_party5a2l1(realExponent_0);
    if ((999 < absExponent_0)) {
      if ((integer_0 === 0n)) {
        mem.setF64(number_4, 0.0);
      } else {
        if (expNegative_0) {
          mem.setF64(number_4, (0.0 * sign_1));
        } else {
          mem.setF64(number_4, (Infinity * sign_1));
        }
      }
      return mem.i32(i_2);
    }
    var digits_0 = ((mem.i32(kdigits_0) + mem.i32(fdigits_0)) | 0);
    var X60Qx_125;
    if ((digits_0 <= 15)) {
      X60Qx_125 = true;
    } else {
      var X60Qx_126;
      if ((digits_0 <= 16)) {
        X60Qx_126 = (firstDigit_0 <= 8);
      } else {
        X60Qx_126 = false;
      }
      X60Qx_125 = X60Qx_126;
    }
    if (X60Qx_125) {
      if ((absExponent_0 <= 22)) {
        if (expNegative_0) {
          var X60Qx_127 = nimIcheckB(absExponent_0, 22);
          mem.setF64(number_4, ((sign_1 * Number(integer_0)) / mem.f64((powtens_0 + (X60Qx_127 * 8)))));
        } else {
          var X60Qx_128 = nimIcheckB(absExponent_0, 22);
          mem.setF64(number_4, ((sign_1 * Number(integer_0)) * mem.f64((powtens_0 + (X60Qx_128 * 8)))));
        }
        return mem.i32(i_2);
      }
      var slop_0 = ((((15 - mem.i32(kdigits_0)) | 0) - mem.i32(fdigits_0)) | 0);
      var X60Qx_129;
      if ((absExponent_0 <= ((22 + slop_0) | 0))) {
        X60Qx_129 = (!expNegative_0);
      } else {
        X60Qx_129 = false;
      }
      if (X60Qx_129) {
        var X60Qx_130 = nimIcheckB(slop_0, 22);
        var X60Qx_131 = nimIcheckB(((absExponent_0 - slop_0) | 0), 22);
        mem.setF64(number_4, (((sign_1 * Number(integer_0)) * mem.f64((powtens_0 + (X60Qx_130 * 8)))) * mem.f64((powtens_0 + (X60Qx_131 * 8)))));
        return mem.i32(i_2);
      }
    }
    var t_0 = allocFixed(500);
    var ti_0 = allocFixed(4);
    mem.setI32(ti_0, 0);
    var X60Qx_132 = len_4_sysvq0asl((() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 808150526);
      mem.setU32((_o + 4), strlit_0_I16254714811886502893_party5a2l1);
      return _o;
    })());
    var maxlen_0 = (((((((499 | 0) + 1) | 0) - 1) | 0) - X60Qx_132) | 0);
    var endPos_0 = mem.i32(i_2);
    result_6 = endPos_0;
    mem.setI32(i_2, 0);
    var X60Qx_133;
    if ((mem.i32(i_2) < endPos_0)) {
      var X60Qx_134 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
      X60Qx_133 = (mem.u8At(X60Qx_134) === 46);
    } else {
      X60Qx_133 = false;
    }
    if (X60Qx_133) {
      inc_1_I6wjjge_cmdqs323n1(i_2);
    }
    {
      while (true) {
        var X60Qx_14;
        if ((mem.i32(i_2) < endPos_0)) {
          var X60Qdesugar_30 = allocFixed(32);
          mem.setU8(X60Qdesugar_30, 0);
          mem.setU8((X60Qdesugar_30 + 1), 0);
          mem.setU8((X60Qdesugar_30 + 2), 0);
          mem.setU8((X60Qdesugar_30 + 3), 0);
          mem.setU8((X60Qdesugar_30 + 4), 0);
          mem.setU8((X60Qdesugar_30 + 5), 40);
          mem.setU8((X60Qdesugar_30 + 6), 255);
          mem.setU8((X60Qdesugar_30 + 7), 3);
          mem.setU8((X60Qdesugar_30 + 8), 0);
          mem.setU8((X60Qdesugar_30 + 9), 0);
          mem.setU8((X60Qdesugar_30 + 10), 0);
          mem.setU8((X60Qdesugar_30 + 11), 0);
          mem.setU8((X60Qdesugar_30 + 12), 0);
          mem.setU8((X60Qdesugar_30 + 13), 0);
          mem.setU8((X60Qdesugar_30 + 14), 0);
          mem.setU8((X60Qdesugar_30 + 15), 0);
          mem.setU8((X60Qdesugar_30 + 16), 0);
          mem.setU8((X60Qdesugar_30 + 17), 0);
          mem.setU8((X60Qdesugar_30 + 18), 0);
          mem.setU8((X60Qdesugar_30 + 19), 0);
          mem.setU8((X60Qdesugar_30 + 20), 0);
          mem.setU8((X60Qdesugar_30 + 21), 0);
          mem.setU8((X60Qdesugar_30 + 22), 0);
          mem.setU8((X60Qdesugar_30 + 23), 0);
          mem.setU8((X60Qdesugar_30 + 24), 0);
          mem.setU8((X60Qdesugar_30 + 25), 0);
          mem.setU8((X60Qdesugar_30 + 26), 0);
          mem.setU8((X60Qdesugar_30 + 27), 0);
          mem.setU8((X60Qdesugar_30 + 28), 0);
          mem.setU8((X60Qdesugar_30 + 29), 0);
          mem.setU8((X60Qdesugar_30 + 30), 0);
          mem.setU8((X60Qdesugar_30 + 31), 0);
          var X60Qx_135 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          var X60Qdesugar_31 = mem.u8At(X60Qx_135);
          X60Qx_14 = (((mem.u8At((X60Qdesugar_30 + (X60Qdesugar_31 >>> 3))) & ((1 << ((X60Qdesugar_31 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_14 = false;
        }
        if (X60Qx_14) {
          whileStmtLabel_9: {
            if ((mem.i32(ti_0) < maxlen_0)) {
              var X60Qx_136 = nimIcheckB(mem.i32(ti_0), 499);
              var X60Qx_137 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              mem.setU8((t_0 + X60Qx_136), mem.u8At(X60Qx_137));
              inc_1_I6wjjge_cmdqs323n1(ti_0);
            }
            inc_1_I6wjjge_cmdqs323n1(i_2);
            {
              while (true) {
                var X60Qx_15;
                if ((mem.i32(i_2) < endPos_0)) {
                  var X60Qdesugar_32 = allocFixed(32);
                  mem.setU8(X60Qdesugar_32, 0);
                  mem.setU8((X60Qdesugar_32 + 1), 0);
                  mem.setU8((X60Qdesugar_32 + 2), 0);
                  mem.setU8((X60Qdesugar_32 + 3), 0);
                  mem.setU8((X60Qdesugar_32 + 4), 0);
                  mem.setU8((X60Qdesugar_32 + 5), 64);
                  mem.setU8((X60Qdesugar_32 + 6), 0);
                  mem.setU8((X60Qdesugar_32 + 7), 0);
                  mem.setU8((X60Qdesugar_32 + 8), 0);
                  mem.setU8((X60Qdesugar_32 + 9), 0);
                  mem.setU8((X60Qdesugar_32 + 10), 0);
                  mem.setU8((X60Qdesugar_32 + 11), 128);
                  mem.setU8((X60Qdesugar_32 + 12), 0);
                  mem.setU8((X60Qdesugar_32 + 13), 0);
                  mem.setU8((X60Qdesugar_32 + 14), 0);
                  mem.setU8((X60Qdesugar_32 + 15), 0);
                  mem.setU8((X60Qdesugar_32 + 16), 0);
                  mem.setU8((X60Qdesugar_32 + 17), 0);
                  mem.setU8((X60Qdesugar_32 + 18), 0);
                  mem.setU8((X60Qdesugar_32 + 19), 0);
                  mem.setU8((X60Qdesugar_32 + 20), 0);
                  mem.setU8((X60Qdesugar_32 + 21), 0);
                  mem.setU8((X60Qdesugar_32 + 22), 0);
                  mem.setU8((X60Qdesugar_32 + 23), 0);
                  mem.setU8((X60Qdesugar_32 + 24), 0);
                  mem.setU8((X60Qdesugar_32 + 25), 0);
                  mem.setU8((X60Qdesugar_32 + 26), 0);
                  mem.setU8((X60Qdesugar_32 + 27), 0);
                  mem.setU8((X60Qdesugar_32 + 28), 0);
                  mem.setU8((X60Qdesugar_32 + 29), 0);
                  mem.setU8((X60Qdesugar_32 + 30), 0);
                  mem.setU8((X60Qdesugar_32 + 31), 0);
                  var X60Qx_138 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                  var X60Qdesugar_33 = mem.u8At(X60Qx_138);
                  X60Qx_15 = (((mem.u8At((X60Qdesugar_32 + (X60Qdesugar_33 >>> 3))) & ((1 << ((X60Qdesugar_33 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
                } else {
                  X60Qx_15 = false;
                }
                if (X60Qx_15) {
                  inc_1_I6wjjge_cmdqs323n1(i_2);
                } else {
                  break;
                }
              }
            }
          }
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_139 = nimIcheckB(mem.i32(ti_0), 499);
  mem.setU8((t_0 + X60Qx_139), 69);
  inc_1_I6wjjge_cmdqs323n1(ti_0);
  var X60Qx_16;
  if (expNegative_0) {
    X60Qx_16 = 45;
  } else {
    X60Qx_16 = 43;
  }
  var X60Qx_140 = nimIcheckB(mem.i32(ti_0), 499);
  mem.setU8((t_0 + X60Qx_140), X60Qx_16);
  inc_0_Iloplki_party5a2l1(ti_0, 4);
  var X60Qx_141 = nimIcheckB(((mem.i32(ti_0) - 1) | 0), 499);
  mem.setU8((t_0 + X60Qx_141), (((48 + (absExponent_0 % 10)) | 0) & 255));
  absExponent_0 = Math.trunc((absExponent_0 / 10));
  var X60Qx_142 = nimIcheckB(((mem.i32(ti_0) - 2) | 0), 499);
  mem.setU8((t_0 + X60Qx_142), (((48 + (absExponent_0 % 10)) | 0) & 255));
  absExponent_0 = Math.trunc((absExponent_0 / 10));
  var X60Qx_143 = nimIcheckB(((mem.i32(ti_0) - 3) | 0), 499);
  mem.setU8((t_0 + X60Qx_143), (((48 + (absExponent_0 % 10)) | 0) & 255));
  var X60Qx_144 = nimIcheckB(mem.i32(ti_0), 499);
  mem.setU8((t_0 + X60Qx_144), 0);
  var X60Qx_145 = strtod(t_0, 0);
  mem.setF64(number_4, X60Qx_145);
  return result_6;
}

function inc_0_Ineawm41_party5a2l1(x_8, y_2) {
  mem.setU64(x_8, BigInt.asUintN(64, (mem.u64b(x_8) + y_2)));
}

function abs_0_Iycnqz_party5a2l1(x_9) {
  let result_14;
  let X60Qx_18;
  if ((x_9 < 0)) {
    X60Qx_18 = (-x_9);
  } else {
    X60Qx_18 = x_9;
  }
  result_14 = X60Qx_18;
  return result_14;
}

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
// generated by lengc (js backend) from linxafkvx1.c.nif

function eqQ_0_linxafkvx1(a_0, b_0) {
  let result_0;
  result_0 = (a_0 === b_0);
  return result_0;
}

function isValid_1_linxafkvx1(x_1) {
  let result_5;
  let X60Qx_5 = eqQ_0_linxafkvx1(x_1, NoFile_0_linxafkvx1);
  result_5 = (!X60Qx_5);
  return result_5;
}

function pack_0_linxafkvx1(m_0, file_0, line_0, col_0) {
  let result_6;
  let X60Qx_6;
  let X60Qx_7;
  if ((file_0 <= 1023)) {
    X60Qx_7 = (line_0 <= 16383);
  } else {
    X60Qx_7 = false;
  }
  if (X60Qx_7) {
    X60Qx_6 = (col_0 <= 127);
  } else {
    X60Qx_6 = false;
  }
  if (X60Qx_6) {
    let X60Qx_0;
    if ((col_0 < 0)) {
      X60Qx_0 = 0;
    } else {
      X60Qx_0 = col_0;
    }
    let col_2 = X60Qx_0;
    let X60Qx_1;
    if ((line_0 < 0)) {
      X60Qx_1 = 0;
    } else {
      X60Qx_1 = line_0;
    }
    let line_2 = X60Qx_1;
    result_6 = ((((((file_0 << 1) >>> 0) | ((line_2 << (11 | 0)) >>> 0)) >>> 0) | ((col_2 << (((11 | 0) + 14) | 0)) >>> 0)) >>> 0);
  } else {
    let X60Qx_8 = len_3_I3euf7n_linxafkvx1(m_0);
    result_6 = ((X60Qx_8 << 2) | 1);
    add_0_Ilc8zdk_linxafkvx1(m_0, (() => {
      let _o = allocFixed(16);
      mem.setU32(_o, file_0);
      mem.setI32((_o + 4), line_0);
      mem.setI32((_o + 8), col_0);
      mem.setU32((_o + 12), 0);
      return _o;
    })());
  }
  return result_6;
}

function packWithComment_0_linxafkvx1(m_1, file_1, line_1, col_1, comment_0) {
  let result_7;
  if ((comment_0 === 0)) {
    let X60Qx_9 = pack_0_linxafkvx1(m_1, file_1, line_1, col_1);
    result_7 = X60Qx_9;
  } else {
    let X60Qx_10 = len_3_I3euf7n_linxafkvx1(m_1);
    result_7 = ((X60Qx_10 << 2) | 1);
    add_0_Ilc8zdk_linxafkvx1(m_1, (() => {
      let _o = allocFixed(16);
      mem.setU32(_o, file_1);
      mem.setI32((_o + 4), line_1);
      mem.setI32((_o + 8), col_1);
      mem.setU32((_o + 12), comment_0);
      return _o;
    })());
  }
  return result_7;
}

function isPayload_0_linxafkvx1(i_0) {
  let result_8;
  result_8 = (((i_0 & 3) >>> 0) === 3);
  return result_8;
}

function unpack_0_linxafkvx1(m_2, info_0) {
  let result_9 = allocFixed(16);
  let i_3 = info_0;
  if ((((i_3 & 1) >>> 0) === 0)) {
    mem.copy(result_9, (() => {
      let _o = allocFixed(16);
      mem.setU32(_o, (((i_3 >>> 1) & 1023) >>> 0));
      mem.setI32((_o + 4), (((i_3 >>> (11 | 0)) & 16383) >>> 0));
      mem.setI32((_o + 8), (((i_3 >>> (((11 | 0) + 14) | 0)) & 127) >>> 0));
      mem.setU32((_o + 12), 0);
      return _o;
    })(), 16);
  } else {
    let X60Qx_11 = isPayload_0_linxafkvx1(info_0);
    if ((!X60Qx_11)) {
      let X60Qx_12 = getQ_7_I032w8c_linxafkvx1(m_2, (i_3 >>> 2));
      mem.copy(result_9, X60Qx_12, 16);
    } else {
      mem.copy(result_9, (() => {
        let _o = allocFixed(16);
        mem.setU32(_o, NoFile_0_linxafkvx1);
        mem.setI32((_o + 4), 0);
        mem.setI32((_o + 8), 0);
        mem.setU32((_o + 12), 0);
        return _o;
      })(), 16);
    }
  }
  return result_9;
}

function stripComment_0_linxafkvx1(m_3, info_1) {
  let result_10;
  let raw_0 = allocFixed(16);
  mem.copy(raw_0, unpack_0_linxafkvx1(m_3, info_1), 16);
  if ((mem.u32((raw_0 + 12)) === 0)) {
    result_10 = info_1;
  } else {
    let X60Qx_13 = pack_0_linxafkvx1(m_3, mem.u32(raw_0), mem.i32((raw_0 + 4)), mem.i32((raw_0 + 8)));
    result_10 = X60Qx_13;
  }
  return result_10;
}

function len_3_I3euf7n_linxafkvx1(s_3) {
  let result_15;
  result_15 = mem.i32(s_3);
  return result_15;
}

function add_0_Ilc8zdk_linxafkvx1(s_4, elem_1) {
  let L_0 = mem.i32(s_4);
  let X60Qx_17 = capInBytes_0_I88vprb_linxafkvx1(s_4);
  if ((X60Qx_17 < ((Math.imul(L_0, 16) + 16) | 0))) {
    let X60Qx_18 = resize_0_Igvhyxs1_linxafkvx1(s_4, 1);
    if ((!X60Qx_18)) {
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_4);
  mem.copy((mem.u32((s_4 + 4)) + (L_0 * 16)), elem_1, 16);
}

function getQ_7_I032w8c_linxafkvx1(s_6, i_5) {
  let X60Qx_19;
  if ((i_5 < mem.i32(s_6))) {
    X60Qx_19 = (0 <= i_5);
  } else {
    X60Qx_19 = false;
  }
  if ((!X60Qx_19)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_16;
  result_16 = (mem.u32((s_6 + 4)) + (i_5 * 16));
  return result_16;
}

function capInBytes_0_I88vprb_linxafkvx1(s_7) {
  let result_17;
  let X60Qx_2;
  if ((!(mem.u32((s_7 + 4)) === 0))) {
    let X60Qx_20 = allocatedSize_0_sysvq0asl(mem.u32((s_7 + 4)));
    X60Qx_2 = X60Qx_20;
  } else {
    X60Qx_2 = 0;
  }
  result_17 = X60Qx_2;
  return result_17;
}

function resize_0_Igvhyxs1_linxafkvx1(dest_1, addedElements_1) {
  let result_18;
  let X60Qx_21 = capInBytes_0_I88vprb_linxafkvx1(dest_1);
  let oldCap_0 = Math.trunc((X60Qx_21 / 16));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_1);
  let memSize_0 = memSizeInBytes_0_Imnzl86_linxafkvx1(newCap_0);
  let X60Qx_22 = realloc_1_sysvq0asl(mem.u32((dest_1 + 4)), memSize_0);
  mem.setU32((dest_1 + 4), X60Qx_22);
  if ((mem.u32((dest_1 + 4)) === 0)) {
    mem.setI32(dest_1, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    result_18 = false;
  } else {
    result_18 = true;
  }
  return result_18;
}

function memSizeInBytes_0_Imnzl86_linxafkvx1(size_1) {
  let result_19;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_1, 16);
  result_19 = X60QconstRefTemp_0;
  if (false) {
    result_19 = 2147483647;
  }
  return result_19;
}

function eQdestroy_1_Igp4hsc1_linxafkvx1(s_10) {
  if ((!(mem.u32((s_10 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_6 = allocFixed(4);
      mem.setI32(i_6, 0);
      {
        while ((mem.i32(i_6) < mem.i32(s_10))) {
          inc_1_I6wjjge_cmdqs323n1(i_6);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_10 + 4)));
  }
}

function eQwasMoved_1_Izqt68k1_linxafkvx1(s_11) {
  mem.setI32(s_11, 0);
  mem.setU32((s_11 + 4), 0);
}

function newSeqUninit_0_Izs0ei1_linxafkvx1(size_3) {
  let result_21 = allocFixed(8);
  if ((size_3 === 0)) {
    mem.copy(result_21, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_3);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_2 = memSizeInBytes_0_Imnzl86_linxafkvx1(size_3);
    let X60Qx_27 = alloc_1_sysvq0asl(memSize_2);
    mem.copy(result_21, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_3);
      mem.setU32((_o + 4), X60Qx_27);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_21 + 4)) === 0))) {
      let X60Qx_28 = allocFixed(8);
      mem.setU32(X60Qx_28, 1634036990);
      mem.setU32((X60Qx_28 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_21, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    }
  }
  return result_21;
}

function eQdestroyQ_SX4cineX49nfoX4danager0linxafkvx1_0_linxafkvx1(dest_0) {
  eQdestroy_1_Igp4hsc1_linxafkvx1(dest_0);
}

function eQwasmovedQ_SX4cineX49nfoX4danager0linxafkvx1_0_linxafkvx1(dest_0) {
  eQwasMoved_1_Izqt68k1_linxafkvx1(dest_0);
}

let X60QiniGuard_0_linxafkvx1 = allocFixed(1);

function X60Qini_0_linxafkvx1() {
  if (mem.u8At(X60QiniGuard_0_linxafkvx1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_linxafkvx1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_has9tn57v();
}
// generated by lengc (js backend) from pat4k2dls.c.nif

let X60QiniGuard_0_pat4k2dls = allocFixed(1);

function X60Qini_0_pat4k2dls() {
  if (mem.u8At(X60QiniGuard_0_pat4k2dls)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_pat4k2dls, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_ossk30t39();
  X60Qini_0_osalirkw71();
  X60Qini_0_patta6rli();
  X60Qini_0_has9tn57v();
  X60Qini_0_str7j0ifg();
  X60Qini_0_ospaexnw61();
}
// generated by lengc (js backend) from nifjp9lau1.c.nif

let X60QiniGuard_0_nifjp9lau1 = allocFixed(1);

function X60Qini_0_nifjp9lau1() {
  if (mem.u8At(X60QiniGuard_0_nifjp9lau1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_nifjp9lau1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_for2ybv4p1();
  X60Qini_0_mat7cnfv21();
  X60Qini_0_str7j0ifg();
  X60Qini_0_vfsc9jn7();
}
// generated by lengc (js backend) from timsagyye1.c.nif

let X60QiniGuard_0_timsagyye1 = allocFixed(1);

function X60Qini_0_timsagyye1() {
  if (mem.u8At(X60QiniGuard_0_timsagyye1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_timsagyye1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from nif81dubp1.c.nif

function dollarX60Q_NifKind_0_nif81dubp1(e_0) {
  let result_5 = allocFixed(8);
  nimStrWasMoved(result_5);
  switch (e_0) {
    case 0:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1802393086);
          mem.setU32((_o + 4), strlit_0_I15885164768026998599_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 1:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1718568446);
          mem.setU32((_o + 4), strlit_0_I10315536999831874058_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 2:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1953449214);
          mem.setU32((_o + 4), strlit_0_I934207063279194918_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 3:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1701071358);
          mem.setU32((_o + 4), strlit_0_I15846002265446469276_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 4:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1836667902);
          mem.setU32((_o + 4), strlit_0_I7416088036152788789_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 5:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1836667902);
          mem.setU32((_o + 4), strlit_0_I15873059642980454073_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 6:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1920226302);
          mem.setU32((_o + 4), strlit_0_I7185474113853794403_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 7:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1634223102);
          mem.setU32((_o + 4), strlit_0_I2368852795644526164_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 8:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1953384958);
          mem.setU32((_o + 4), strlit_0_I17216697482861734393_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 9:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1850299902);
          mem.setU32((_o + 4), strlit_0_I16169252050837114447_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 10:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1869367038);
          mem.setU32((_o + 4), strlit_0_I2526583260401622044_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 11:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1918980350);
          mem.setU32((_o + 4), strlit_0_I3677393315539012384_nif81dubp1);
          return _o;
        })();
      }
      break;
    case 12:
      {
        return (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1918980350);
          mem.setU32((_o + 4), strlit_0_I2186592322655248559_nif81dubp1);
          return _o;
        })();
      }
      break;
  }
  return result_5;
}

function close_0_nif81dubp1(r_0) {
  closeBlob_0_vfsc9jn7((r_0 + 8));
}

function skipWhitespace_0_nif81dubp1(r_1) {
  whileStmtLabel_0: {
    var p_5 = mem.u32(r_1);
    var eof_0 = mem.u32((r_1 + 4));
    {
      while ((p_5 < eof_0)) {
        switch (mem.u8At(p_5)) {
          case 32:
          case 9:
          case 13:
            {
              p_5 = ((p_5 + 1) | 0);
            }
            break;
          case 10:
            {
              p_5 = ((p_5 + 1) | 0);
              inc_1_I6wjjge_cmdqs323n1((r_1 + 56));
            }
            break;
          default:
            {
              break whileStmtLabel_0;
            }
            break;
        }
      }
    }
  }
  mem.setU32(r_1, p_5);
}

function captureComment_0_nif81dubp1(r_2, result_0) {
  whileStmtLabel_0: {
    mem.setU32((result_0 + 28), mem.u32(r_2));
    var p_6 = mem.u32(r_2);
    var eof_1 = mem.u32((r_2 + 4));
    var start_1 = p_6;
    {
      while ((p_6 < eof_1)) {
        if ((mem.u8At(p_6) === 35)) {
          mem.setI32(((result_0 + 28) + 4), ((p_6 - start_1) | 0));
          p_6 = ((p_6 + 1) | 0);
          break whileStmtLabel_0;
        } else {
          if ((mem.u8At(p_6) === 10)) {
            p_6 = ((p_6 + 1) | 0);
            inc_1_I6wjjge_cmdqs323n1((r_2 + 56));
          } else {
            if ((mem.u8At(p_6) === 92)) {
              var X60Qdesugar_3 = (result_0 + 1);
              var X60Qdesugar_4 = 3;
              mem.setU8(X60Qdesugar_3, ((mem.u8At(X60Qdesugar_3) | (((1 & 255) << ((X60Qdesugar_4 & 7) >>> 0)) >>> 0)) >>> 0));
            }
            p_6 = ((p_6 + 1) | 0);
          }
        }
      }
    }
  }
  mem.setU32(r_2, p_6);
}

function handleHex_0_nif81dubp1(p_3) {
  let result_8;
  let output_0 = 0;
  {
    let $csel0 = mem.u8At(p_3);
    if ((($csel0 >= 48) && ($csel0 <= 57))) {
      output_0 = ((output_0 << 4) | ((mem.u8At(p_3) - 48) | 0));
    } else if ((($csel0 >= 65) && ($csel0 <= 70))) {
      output_0 = ((output_0 << 4) | ((((mem.u8At(p_3) - 65) | 0) + 10) | 0));
    } else {
    }
  }
  {
    let $csel1 = mem.u8At((p_3 + 1));
    if ((($csel1 >= 48) && ($csel1 <= 57))) {
      output_0 = ((output_0 << 4) | ((mem.u8At((p_3 + 1)) - 48) | 0));
    } else if ((($csel1 >= 65) && ($csel1 <= 70))) {
      output_0 = ((output_0 << 4) | ((((mem.u8At((p_3 + 1)) - 65) | 0) + 10) | 0));
    } else {
    }
  }
  result_8 = (output_0 & 255);
  return result_8;
}

function decodeEscape_0_nif81dubp1(p_4) {
  let result_9;
  switch (mem.u8At(mem.u32(p_4))) {
    case 110:
      {
        result_9 = 10;
        mem.setU32(p_4, ((mem.u32(p_4) + 1) | 0));
      }
      break;
    case 116:
      {
        result_9 = 9;
        mem.setU32(p_4, ((mem.u32(p_4) + 1) | 0));
      }
      break;
    case 114:
      {
        result_9 = 13;
        mem.setU32(p_4, ((mem.u32(p_4) + 1) | 0));
      }
      break;
    case 124:
      {
        result_9 = 92;
        mem.setU32(p_4, ((mem.u32(p_4) + 1) | 0));
      }
      break;
    case 94:
      {
        result_9 = 34;
        mem.setU32(p_4, ((mem.u32(p_4) + 1) | 0));
      }
      break;
    default:
      {
        let X60Qx_15 = handleHex_0_nif81dubp1(mem.u32(p_4));
        result_9 = X60Qx_15;
        mem.setU32(p_4, ((mem.u32(p_4) + 2) | 0));
      }
      break;
  }
  return result_9;
}

function decodeChar_0_nif81dubp1(t_1) {
  let result_10;
  if ((!(mem.u8At(t_1) === 7))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  result_10 = mem.u8At(mem.u32((t_1 + 4)));
  if ((result_10 === 92)) {
    let p_7 = allocFixed(4);
    mem.setU32(p_7, mem.u32((t_1 + 4)));
    mem.setU32(p_7, ((mem.u32(p_7) + 1) | 0));
    let X60Qx_16 = decodeEscape_0_nif81dubp1(p_7);
    result_10 = X60Qx_16;
  }
  return result_10;
}

function decodeStr_0_nif81dubp1(r_3, t_2) {
  var result_11 = allocFixed(8);
  nimStrWasMoved(result_11);
  var X60Qdesugar_5 = mem.u8At((t_2 + 1));
  var X60Qdesugar_6 = 0;
  if ((((X60Qdesugar_5 & (((1 & 255) << ((X60Qdesugar_6 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
    whileStmtLabel_0: {
      nimStrDestroy(result_11);
      mem.copy(result_11, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
      var p_8 = allocFixed(4);
      mem.setU32(p_8, mem.u32((t_2 + 4)));
      var sentinel_0 = ((mem.u32(p_8) + mem.i32(((t_2 + 4) + 4))) | 0);
      {
        while ((mem.u32(p_8) < sentinel_0)) {
          if ((mem.u8At(mem.u32(p_8)) === 92)) {
            mem.setU32(p_8, ((mem.u32(p_8) + 1) | 0));
            var X60Qx_17 = decodeEscape_0_nif81dubp1(p_8);
            add_1_sysvq0asl(result_11, X60Qx_17);
          } else {
            add_1_sysvq0asl(result_11, mem.u8At(mem.u32(p_8)));
            mem.setU32(p_8, ((mem.u32(p_8) + 1) | 0));
          }
        }
      }
    }
    var X60Qdesugar_7 = mem.u8At((t_2 + 1));
    var X60Qdesugar_8 = 2;
    if ((((X60Qdesugar_7 & (((1 & 255) << ((X60Qdesugar_8 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
      var X60Qx_18 = len_4_sysvq0asl((r_3 + 48));
      if ((!(0 < X60Qx_18))) {
        write_0_syn1lfpjv(stdout, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1933663230);
          mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
          return _o;
        })());
        write_0_syn1lfpjv(stdout, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 0);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
        write_7_syn1lfpjv(stdout, 10);
        quit_0_syn1lfpjv(1);
      }
      add_2_sysvq0asl(result_11, (r_3 + 48));
    }
  } else {
    var X60Qdesugar_9 = mem.u8At((t_2 + 1));
    var X60Qdesugar_10 = 2;
    if ((((X60Qdesugar_9 & (((1 & 255) << ((X60Qdesugar_10 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
      var X60Qx_19 = len_4_sysvq0asl((r_3 + 48));
      if ((!(0 < X60Qx_19))) {
        write_0_syn1lfpjv(stdout, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1933663230);
          mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
          return _o;
        })());
        write_0_syn1lfpjv(stdout, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 0);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
        write_7_syn1lfpjv(stdout, 10);
        quit_0_syn1lfpjv(1);
      }
      nimStrDestroy(result_11);
      var X60Qx_20 = len_4_sysvq0asl((r_3 + 48));
      var X60Qx_21 = allocFixed(8);
      mem.copy(X60Qx_21, newString_0_sysvq0asl(((mem.i32(((t_2 + 4) + 4)) + X60Qx_20) | 0)), 8);
      mem.copy(result_11, X60Qx_21, 8);
      if ((0 < mem.i32(((t_2 + 4) + 4)))) {
        var X60Qx_22 = len_4_sysvq0asl(result_11);
        var X60Qx_23 = beginStore_0_sysvq0asl(result_11, X60Qx_22, 0);
        copyMem_0_sysvq0asl(X60Qx_23, mem.u32((t_2 + 4)), mem.i32(((t_2 + 4) + 4)));
        var X60Qx_24 = len_4_sysvq0asl(result_11);
        var X60Qx_25 = beginStore_0_sysvq0asl(result_11, X60Qx_24, mem.i32(((t_2 + 4) + 4)));
        var X60Qx_26 = readRawData_0_sysvq0asl((r_3 + 48), 0);
        var X60Qx_27 = len_4_sysvq0asl((r_3 + 48));
        copyMem_0_sysvq0asl(X60Qx_25, X60Qx_26, X60Qx_27);
        endStore_0_sysvq0asl(result_11);
      }
    } else {
      nimStrDestroy(result_11);
      var X60Qx_28 = allocFixed(8);
      mem.copy(X60Qx_28, newString_0_sysvq0asl(mem.i32(((t_2 + 4) + 4))), 8);
      mem.copy(result_11, X60Qx_28, 8);
      if ((0 < mem.i32(((t_2 + 4) + 4)))) {
        var X60Qx_29 = len_4_sysvq0asl(result_11);
        var X60Qx_30 = beginStore_0_sysvq0asl(result_11, X60Qx_29, 0);
        copyMem_0_sysvq0asl(X60Qx_30, mem.u32((t_2 + 4)), mem.i32(((t_2 + 4) + 4)));
        endStore_0_sysvq0asl(result_11);
      }
    }
  }
  return result_11;
}

function decodeComment_0_nif81dubp1(t_3) {
  whileStmtLabel_0: {
    var result_12 = allocFixed(8);
    nimStrWasMoved(result_12);
    if ((mem.i32(((t_3 + 28) + 4)) === 0)) {
      return (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })();
    }
    var X60Qdesugar_11 = mem.u8At((t_3 + 1));
    var X60Qdesugar_12 = 3;
    if ((!(((X60Qdesugar_11 & (((1 & 255) << ((X60Qdesugar_12 & 7) >>> 0)) >>> 0)) >>> 0) !== 0))) {
      nimStrDestroy(result_12);
      var X60Qx_31 = allocFixed(8);
      mem.copy(X60Qx_31, newString_0_sysvq0asl(mem.i32(((t_3 + 28) + 4))), 8);
      mem.copy(result_12, X60Qx_31, 8);
      var X60Qx_32 = len_4_sysvq0asl(result_12);
      var X60Qx_33 = beginStore_0_sysvq0asl(result_12, X60Qx_32, 0);
      copyMem_0_sysvq0asl(X60Qx_33, mem.u32((t_3 + 28)), mem.i32(((t_3 + 28) + 4)));
      endStore_0_sysvq0asl(result_12);
      return result_12;
    }
    nimStrDestroy(result_12);
    mem.copy(result_12, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    var p_9 = allocFixed(4);
    mem.setU32(p_9, mem.u32((t_3 + 28)));
    var sentinel_1 = ((mem.u32(p_9) + mem.i32(((t_3 + 28) + 4))) | 0);
    {
      while ((mem.u32(p_9) < sentinel_1)) {
        if ((mem.u8At(mem.u32(p_9)) === 92)) {
          mem.setU32(p_9, ((mem.u32(p_9) + 1) | 0));
          var X60Qx_34 = decodeEscape_0_nif81dubp1(p_9);
          add_1_sysvq0asl(result_12, X60Qx_34);
        } else {
          add_1_sysvq0asl(result_12, mem.u8At(mem.u32(p_9)));
          mem.setU32(p_9, ((mem.u32(p_9) + 1) | 0));
        }
      }
    }
  }
  return result_12;
}

function decodeFilename_0_nif81dubp1(t_4) {
  var result_13 = allocFixed(8);
  nimStrWasMoved(result_13);
  var X60Qdesugar_13 = mem.u8At((t_4 + 1));
  var X60Qdesugar_14 = 1;
  if ((((X60Qdesugar_13 & (((1 & 255) << ((X60Qdesugar_14 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
    whileStmtLabel_0: {
      nimStrDestroy(result_13);
      mem.copy(result_13, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
      var p_10 = allocFixed(4);
      mem.setU32(p_10, mem.u32((t_4 + 20)));
      var sentinel_2 = ((mem.u32(p_10) + mem.i32(((t_4 + 20) + 4))) | 0);
      {
        while ((mem.u32(p_10) < sentinel_2)) {
          if ((mem.u8At(mem.u32(p_10)) === 92)) {
            mem.setU32(p_10, ((mem.u32(p_10) + 1) | 0));
            var X60Qx_35 = decodeEscape_0_nif81dubp1(p_10);
            add_1_sysvq0asl(result_13, X60Qx_35);
          } else {
            add_1_sysvq0asl(result_13, mem.u8At(mem.u32(p_10)));
            mem.setU32(p_10, ((mem.u32(p_10) + 1) | 0));
          }
        }
      }
    }
  } else {
    nimStrDestroy(result_13);
    var X60Qx_36 = allocFixed(8);
    mem.copy(X60Qx_36, newString_0_sysvq0asl(mem.i32(((t_4 + 20) + 4))), 8);
    mem.copy(result_13, X60Qx_36, 8);
    var X60Qx_37 = len_4_sysvq0asl(result_13);
    var X60Qx_38 = beginStore_0_sysvq0asl(result_13, X60Qx_37, 0);
    copyMem_0_sysvq0asl(X60Qx_38, mem.u32((t_4 + 20)), mem.i32(((t_4 + 20) + 4)));
    endStore_0_sysvq0asl(result_13);
  }
  return result_13;
}

function decodeFloat_0_nif81dubp1(t_5) {
  let result_14 = allocFixed(8);
  mem.setF64(result_14, 0.0);
  if ((!(mem.u8At(t_5) === 10))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_39 = allocFixed(8);
  mem.copy(X60Qx_39, toOpenArray_3_Inpmq9h_nif81dubp1(mem.u32((t_5 + 4)), 0, ((mem.i32(((t_5 + 4) + 4)) - 1) | 0)), 8);
  let res_0 = parseBiggestFloat_0_party5a2l1(X60Qx_39, result_14);
  if ((!(res_0 === mem.i32(((t_5 + 4) + 4))))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  return mem.f64(result_14);
}

function decodeUInt_0_nif81dubp1(t_6) {
  let result_15 = allocFixed(8);
  mem.setU64(result_15, 0n);
  if ((!(mem.u8At(t_6) === 9))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_40 = allocFixed(8);
  mem.copy(X60Qx_40, toOpenArray_3_Inpmq9h_nif81dubp1(mem.u32((t_6 + 4)), 0, ((mem.i32(((t_6 + 4) + 4)) - 1) | 0)), 8);
  let res_1 = parseBiggestUInt_0_party5a2l1(X60Qx_40, result_15);
  if ((!(res_1 === mem.i32(((t_6 + 4) + 4))))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  return mem.u64b(result_15);
}

function decodeInt_0_nif81dubp1(t_7) {
  let result_16 = allocFixed(8);
  mem.setI64(result_16, 0n);
  if ((!(mem.u8At(t_7) === 8))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_41 = allocFixed(8);
  mem.copy(X60Qx_41, toOpenArray_3_Inpmq9h_nif81dubp1(mem.u32((t_7 + 4)), 0, ((mem.i32(((t_7 + 4) + 4)) - 1) | 0)), 8);
  let res_2 = parseBiggestInt_0_party5a2l1(X60Qx_41, result_16);
  if ((!(res_2 === mem.i32(((t_7 + 4) + 4))))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  return mem.i64b(result_16);
}

function handleNumber_0_nif81dubp1(r_4, result_1) {
  var p_11 = mem.u32(r_4);
  var eof_2 = mem.u32((r_4 + 4));
  var X60Qx_0;
  if ((p_11 < eof_2)) {
    var X60Qdesugar_15 = allocFixed(32);
    mem.copy(X60Qdesugar_15, Digits_0_nif81dubp1, 32);
    var X60Qdesugar_16 = mem.u8At(p_11);
    X60Qx_0 = (((mem.u8At((X60Qdesugar_15 + (X60Qdesugar_16 >>> 3))) & ((1 << ((X60Qdesugar_16 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
  } else {
    X60Qx_0 = false;
  }
  if (X60Qx_0) {
    whileStmtLabel_0: {
      mem.setU8(result_1, 8);
      {
        while (true) {
          var X60Qx_1;
          if ((p_11 < eof_2)) {
            var X60Qdesugar_17 = allocFixed(32);
            mem.copy(X60Qdesugar_17, Digits_0_nif81dubp1, 32);
            var X60Qdesugar_18 = mem.u8At(p_11);
            X60Qx_1 = (((mem.u8At((X60Qdesugar_17 + (X60Qdesugar_18 >>> 3))) & ((1 << ((X60Qdesugar_18 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
          } else {
            X60Qx_1 = false;
          }
          if (X60Qx_1) {
            p_11 = ((p_11 + 1) | 0);
            inc_1_I6wjjge_cmdqs323n1(((result_1 + 4) + 4));
          } else {
            break;
          }
        }
      }
    }
    var X60Qx_42;
    if ((p_11 < eof_2)) {
      X60Qx_42 = (mem.u8At(p_11) === 46);
    } else {
      X60Qx_42 = false;
    }
    if (X60Qx_42) {
      whileStmtLabel_1: {
        mem.setU8(result_1, 10);
        p_11 = ((p_11 + 1) | 0);
        inc_1_I6wjjge_cmdqs323n1(((result_1 + 4) + 4));
        {
          while (true) {
            var X60Qx_2;
            if ((p_11 < eof_2)) {
              var X60Qdesugar_19 = allocFixed(32);
              mem.copy(X60Qdesugar_19, Digits_0_nif81dubp1, 32);
              var X60Qdesugar_20 = mem.u8At(p_11);
              X60Qx_2 = (((mem.u8At((X60Qdesugar_19 + (X60Qdesugar_20 >>> 3))) & ((1 << ((X60Qdesugar_20 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
            } else {
              X60Qx_2 = false;
            }
            if (X60Qx_2) {
              p_11 = ((p_11 + 1) | 0);
              inc_1_I6wjjge_cmdqs323n1(((result_1 + 4) + 4));
            } else {
              break;
            }
          }
        }
      }
    }
    var X60Qx_43;
    if ((p_11 < eof_2)) {
      X60Qx_43 = (mem.u8At(p_11) === 69);
    } else {
      X60Qx_43 = false;
    }
    if (X60Qx_43) {
      whileStmtLabel_2: {
        mem.setU8(result_1, 10);
        p_11 = ((p_11 + 1) | 0);
        inc_1_I6wjjge_cmdqs323n1(((result_1 + 4) + 4));
        if ((p_11 < eof_2)) {
          var X60Qx_44;
          if ((mem.u8At(p_11) === 45)) {
            X60Qx_44 = true;
          } else {
            X60Qx_44 = (mem.u8At(p_11) === 43);
          }
          if (X60Qx_44) {
            p_11 = ((p_11 + 1) | 0);
            inc_1_I6wjjge_cmdqs323n1(((result_1 + 4) + 4));
          }
        }
        {
          while (true) {
            var X60Qx_3;
            if ((p_11 < eof_2)) {
              var X60Qdesugar_21 = allocFixed(32);
              mem.copy(X60Qdesugar_21, Digits_0_nif81dubp1, 32);
              var X60Qdesugar_22 = mem.u8At(p_11);
              X60Qx_3 = (((mem.u8At((X60Qdesugar_21 + (X60Qdesugar_22 >>> 3))) & ((1 << ((X60Qdesugar_22 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
            } else {
              X60Qx_3 = false;
            }
            if (X60Qx_3) {
              p_11 = ((p_11 + 1) | 0);
              inc_1_I6wjjge_cmdqs323n1(((result_1 + 4) + 4));
            } else {
              break;
            }
          }
        }
      }
    }
    var X60Qx_45;
    if ((p_11 < eof_2)) {
      X60Qx_45 = (mem.u8At(p_11) === 117);
    } else {
      X60Qx_45 = false;
    }
    if (X60Qx_45) {
      mem.setU8(result_1, 9);
      p_11 = ((p_11 + 1) | 0);
    }
  }
  mem.setU32(r_4, p_11);
}

function decodeB62_0_nif81dubp1(c_0) {
  let result_17;
  if ((c_0 <= 57)) {
    result_17 = ((c_0 - 48) | 0);
  } else {
    if ((c_0 <= 90)) {
      result_17 = ((((c_0 - 65) | 0) + 10) | 0);
    } else {
      result_17 = ((((c_0 - 97) | 0) + 36) | 0);
    }
  }
  return result_17;
}

function handleLineInfo_0_nif81dubp1(r_5, result_2) {
  whileStmtLabel_0: {
    var p_12 = mem.u32(r_5);
    var eof_3 = mem.u32((r_5 + 4));
    var col_1 = 0;
    var negative_1 = false;
    var X60Qx_46;
    if ((p_12 < eof_3)) {
      X60Qx_46 = (mem.u8At(p_12) === 126);
    } else {
      X60Qx_46 = false;
    }
    if (X60Qx_46) {
      p_12 = ((p_12 + 1) | 0);
      negative_1 = true;
    }
    {
      while (true) {
        var X60Qx_4;
        if ((p_12 < eof_3)) {
          var X60Qdesugar_23 = allocFixed(32);
          mem.copy(X60Qdesugar_23, B62Digits_0_nif81dubp1, 32);
          var X60Qdesugar_24 = mem.u8At(p_12);
          X60Qx_4 = (((mem.u8At((X60Qdesugar_23 + (X60Qdesugar_24 >>> 3))) & ((1 << ((X60Qdesugar_24 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_4 = false;
        }
        if (X60Qx_4) {
          var c_3 = decodeB62_0_nif81dubp1(mem.u8At(p_12));
          if ((Math.trunc((((-2147483648 + c_3) | 0) / 62)) <= col_1)) {
            col_1 = ((Math.imul(col_1, 62) - c_3) | 0);
          } else {
            integerOutOfRangeError_0_nif81dubp1();
          }
          p_12 = ((p_12 + 1) | 0);
        } else {
          break;
        }
      }
    }
  }
  if ((!negative_1)) {
    if ((col_1 === -2147483648)) {
      integerOutOfRangeError_0_nif81dubp1();
    }
    col_1 = (-col_1);
  }
  var line_1 = 0;
  negative_1 = false;
  var X60Qx_47;
  if ((p_12 < eof_3)) {
    X60Qx_47 = (mem.u8At(p_12) === 44);
  } else {
    X60Qx_47 = false;
  }
  if (X60Qx_47) {
    whileStmtLabel_1: {
      p_12 = ((p_12 + 1) | 0);
      var X60Qx_48;
      if ((p_12 < eof_3)) {
        X60Qx_48 = (mem.u8At(p_12) === 126);
      } else {
        X60Qx_48 = false;
      }
      if (X60Qx_48) {
        p_12 = ((p_12 + 1) | 0);
        negative_1 = true;
      }
      {
        while (true) {
          var X60Qx_5;
          if ((p_12 < eof_3)) {
            var X60Qdesugar_25 = allocFixed(32);
            mem.copy(X60Qdesugar_25, B62Digits_0_nif81dubp1, 32);
            var X60Qdesugar_26 = mem.u8At(p_12);
            X60Qx_5 = (((mem.u8At((X60Qdesugar_25 + (X60Qdesugar_26 >>> 3))) & ((1 << ((X60Qdesugar_26 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
          } else {
            X60Qx_5 = false;
          }
          if (X60Qx_5) {
            var c_4 = decodeB62_0_nif81dubp1(mem.u8At(p_12));
            if ((Math.trunc((((-2147483648 + c_4) | 0) / 62)) <= line_1)) {
              line_1 = ((Math.imul(line_1, 62) - c_4) | 0);
            } else {
              integerOutOfRangeError_0_nif81dubp1();
            }
            p_12 = ((p_12 + 1) | 0);
          } else {
            break;
          }
        }
      }
    }
    if ((!negative_1)) {
      if ((line_1 === -2147483648)) {
        integerOutOfRangeError_0_nif81dubp1();
      }
      line_1 = (-line_1);
    }
  }
  mem.copy((result_2 + 12), (() => {
    var _o = allocFixed(8);
    mem.setI32(_o, col_1);
    mem.setI32((_o + 4), line_1);
    return _o;
  })(), 8);
  var X60Qx_49;
  if ((p_12 < eof_3)) {
    X60Qx_49 = (mem.u8At(p_12) === 44);
  } else {
    X60Qx_49 = false;
  }
  if (X60Qx_49) {
    whileStmtLabel_2: {
      p_12 = ((p_12 + 1) | 0);
      mem.setU32((result_2 + 20), p_12);
      {
        while ((p_12 < eof_3)) {
          var ch_1 = mem.u8At(p_12);
          var X60Qdesugar_27 = allocFixed(32);
          mem.copy(X60Qdesugar_27, ControlCharsOrWhite_0_nif81dubp1, 32);
          var X60Qdesugar_28 = ch_1;
          if ((((mem.u8At((X60Qdesugar_27 + (X60Qdesugar_28 >>> 3))) & ((1 << ((X60Qdesugar_28 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
            break whileStmtLabel_2;
          } else {
            if ((ch_1 === 92)) {
              var X60Qdesugar_29 = (result_2 + 1);
              var X60Qdesugar_30 = 1;
              mem.setU8(X60Qdesugar_29, ((mem.u8At(X60Qdesugar_29) | (((1 & 255) << ((X60Qdesugar_30 & 7) >>> 0)) >>> 0)) >>> 0));
            } else {
              if ((ch_1 === 10)) {
                inc_1_I6wjjge_cmdqs323n1((r_5 + 56));
              }
            }
          }
          inc_1_I6wjjge_cmdqs323n1(((result_2 + 20) + 4));
          p_12 = ((p_12 + 1) | 0);
        }
      }
    }
  }
  mem.setU32(r_5, p_12);
}

function handleSuffix_0_nif81dubp1(r_6, result_3) {
  if ((mem.u32(r_6) < mem.u32((r_6 + 4)))) {
    let ch_2 = mem.u8At(mem.u32(r_6));
    if ((ch_2 === 64)) {
      mem.setU32(r_6, ((mem.u32(r_6) + 1) | 0));
      handleLineInfo_0_nif81dubp1(r_6, result_3);
    } else {
      if ((ch_2 === 126)) {
        handleLineInfo_0_nif81dubp1(r_6, result_3);
      }
    }
  }
  let X60Qx_50;
  if ((mem.u32(r_6) < mem.u32((r_6 + 4)))) {
    X60Qx_50 = (mem.u8At(mem.u32(r_6)) === 35);
  } else {
    X60Qx_50 = false;
  }
  if (X60Qx_50) {
    mem.setU32(r_6, ((mem.u32(r_6) + 1) | 0));
    captureComment_0_nif81dubp1(r_6, result_3);
  }
}

function next_0_nif81dubp1(r_7, result_4) {
  mem.copy(result_4, (() => {
    var _o = allocFixed(36);
    mem.setU8(_o, 0);
    mem.setU8((_o + 1), 0);
    mem.setU16((_o + 2), 0);
    mem.copy((_o + 4), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.copy((_o + 12), (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.copy((_o + 20), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.copy((_o + 28), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    return _o;
  })(), 36);
  skipWhitespace_0_nif81dubp1(r_7);
  if ((mem.u32((r_7 + 4)) <= mem.u32(r_7))) {
    mem.setU8(result_4, 1);
    return;
  }
  {
    var $csel2 = mem.u8At(mem.u32(r_7));
    if (($csel2 === 40)) {
      whileStmtLabel_0: {
        mem.setU8(result_4, 11);
        var p_13 = mem.u32(r_7);
        var eof_4 = mem.u32((r_7 + 4));
        p_13 = ((p_13 + 1) | 0);
        mem.setU32((result_4 + 4), p_13);
        mem.setI32(((result_4 + 4) + 4), 0);
        {
          while (true) {
            var X60Qx_6;
            if ((p_13 < eof_4)) {
              var X60Qdesugar_31 = allocFixed(32);
              mem.copy(X60Qdesugar_31, ControlCharsOrWhite_0_nif81dubp1, 32);
              var X60Qdesugar_32 = mem.u8At(p_13);
              X60Qx_6 = (!(((mem.u8At((X60Qdesugar_31 + (X60Qdesugar_32 >>> 3))) & ((1 << ((X60Qdesugar_32 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            } else {
              X60Qx_6 = false;
            }
            if (X60Qx_6) {
              inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
              p_13 = ((p_13 + 1) | 0);
            } else {
              break;
            }
          }
        }
      }
      mem.setU32(r_7, p_13);
      handleSuffix_0_nif81dubp1(r_7, result_4);
    } else if (($csel2 === 41)) {
      mem.setU8(result_4, 12);
      mem.setU32((result_4 + 4), mem.u32(r_7));
      inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
      mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
    } else if (($csel2 === 46)) {
      mem.setU8(result_4, 2);
      mem.setU32((result_4 + 4), mem.u32(r_7));
      inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
      mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
      handleSuffix_0_nif81dubp1(r_7, result_4);
    } else if (($csel2 === 34)) {
      whileStmtLabel_1: {
        var p_14 = mem.u32(r_7);
        var eof_5 = mem.u32((r_7 + 4));
        p_14 = ((p_14 + 1) | 0);
        mem.setU8(result_4, 6);
        mem.setU32((result_4 + 4), p_14);
        mem.setI32(((result_4 + 4) + 4), 0);
        {
          while ((p_14 < eof_5)) {
            var ch_4 = mem.u8At(p_14);
            if ((ch_4 === 34)) {
              p_14 = ((p_14 + 1) | 0);
              break whileStmtLabel_1;
            } else {
              if ((ch_4 === 92)) {
                var X60Qdesugar_33 = (result_4 + 1);
                var X60Qdesugar_34 = 0;
                mem.setU8(X60Qdesugar_33, ((mem.u8At(X60Qdesugar_33) | (((1 & 255) << ((X60Qdesugar_34 & 7) >>> 0)) >>> 0)) >>> 0));
              } else {
                if ((ch_4 === 10)) {
                  inc_1_I6wjjge_cmdqs323n1((r_7 + 56));
                }
              }
            }
            inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
            p_14 = ((p_14 + 1) | 0);
          }
        }
      }
      mem.setU32(r_7, p_14);
      handleSuffix_0_nif81dubp1(r_7, result_4);
    } else if (($csel2 === 39)) {
      mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
      mem.setU32((result_4 + 4), mem.u32(r_7));
      if ((mem.u8At(mem.u32(r_7)) === 92)) {
        var X60Qdesugar_35 = (result_4 + 1);
        var X60Qdesugar_36 = 0;
        mem.setU8(X60Qdesugar_35, ((mem.u8At(X60Qdesugar_35) | (((1 & 255) << ((X60Qdesugar_36 & 7) >>> 0)) >>> 0)) >>> 0));
        mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
        var X60Qx_7;
        var X60Qdesugar_37 = allocFixed(32);
        mem.copy(X60Qdesugar_37, HexChars_0_nif81dubp1, 32);
        var X60Qdesugar_38 = mem.u8At(mem.u32(r_7));
        if ((((mem.u8At((X60Qdesugar_37 + (X60Qdesugar_38 >>> 3))) & ((1 << ((X60Qdesugar_38 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
          var X60Qdesugar_39 = allocFixed(32);
          mem.copy(X60Qdesugar_39, HexChars_0_nif81dubp1, 32);
          var X60Qdesugar_40 = mem.u8At((mem.u32(r_7) + 1));
          X60Qx_7 = (((mem.u8At((X60Qdesugar_39 + (X60Qdesugar_40 >>> 3))) & ((1 << ((X60Qdesugar_40 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_7 = false;
        }
        if (X60Qx_7) {
          mem.setU32(r_7, ((mem.u32(r_7) + 2) | 0));
          if ((mem.u8At(mem.u32(r_7)) === 39)) {
            mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
            mem.setU8(result_4, 7);
          }
        }
      } else {
        var X60Qdesugar_41 = allocFixed(32);
        mem.copy(X60Qdesugar_41, ControlChars_0_nif81dubp1, 32);
        var X60Qdesugar_42 = mem.u8At(mem.u32(r_7));
        if ((((mem.u8At((X60Qdesugar_41 + (X60Qdesugar_42 >>> 3))) & ((1 << ((X60Qdesugar_42 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
          var X60Qx_51 = allocFixed(8);
          mem.setU32(X60Qx_51, 1701145598);
          mem.setU32((X60Qx_51 + 4), strlit_0_I10426215507333234367_nif81dubp1);
        } else {
          mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
          if ((mem.u8At(mem.u32(r_7)) === 39)) {
            mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
            mem.setU8(result_4, 7);
          }
        }
      }
      if ((mem.u8At(result_4) === 7)) {
        handleSuffix_0_nif81dubp1(r_7, result_4);
      }
    } else if (($csel2 === 58)) {
      whileStmtLabel_2: {
        var p_15 = mem.u32(r_7);
        var eof_6 = mem.u32((r_7 + 4));
        p_15 = ((p_15 + 1) | 0);
        mem.setU32((result_4 + 4), p_15);
        {
          while (true) {
            var X60Qx_8;
            if ((p_15 < eof_6)) {
              var X60Qdesugar_43 = allocFixed(32);
              mem.copy(X60Qdesugar_43, ControlCharsOrWhite_0_nif81dubp1, 32);
              var X60Qdesugar_44 = mem.u8At(p_15);
              X60Qx_8 = (!(((mem.u8At((X60Qdesugar_43 + (X60Qdesugar_44 >>> 3))) & ((1 << ((X60Qdesugar_44 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            } else {
              X60Qx_8 = false;
            }
            if (X60Qx_8) {
              if ((mem.u8At(p_15) === 92)) {
                var X60Qdesugar_45 = (result_4 + 1);
                var X60Qdesugar_46 = 0;
                mem.setU8(X60Qdesugar_45, ((mem.u8At(X60Qdesugar_45) | (((1 & 255) << ((X60Qdesugar_46 & 7) >>> 0)) >>> 0)) >>> 0));
              }
              inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
              p_15 = ((p_15 + 1) | 0);
            } else {
              break;
            }
          }
        }
      }
      mem.setU32(r_7, p_15);
      if ((0 < mem.i32(((result_4 + 4) + 4)))) {
        mem.setU8(result_4, 5);
        if ((mem.u8At((mem.u32((result_4 + 4)) + ((mem.i32(((result_4 + 4) + 4)) - 1) | 0))) === 46)) {
          var X60Qdesugar_47 = (result_4 + 1);
          var X60Qdesugar_48 = 2;
          mem.setU8(X60Qdesugar_47, ((mem.u8At(X60Qdesugar_47) | (((1 & 255) << ((X60Qdesugar_48 & 7) >>> 0)) >>> 0)) >>> 0));
        }
        handleSuffix_0_nif81dubp1(r_7, result_4);
      }
    } else if (($csel2 === 45)) {
      mem.setU32((result_4 + 4), mem.u32(r_7));
      mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
      inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
      handleNumber_0_nif81dubp1(r_7, result_4);
      handleSuffix_0_nif81dubp1(r_7, result_4);
    } else if ((($csel2 >= 48) && ($csel2 <= 57))) {
      var p_16 = mem.u32(r_7);
      var eof_7 = mem.u32((r_7 + 4));
      mem.setU32((result_4 + 4), p_16);
      mem.setI32(((result_4 + 4) + 4), 0);
      mem.setU32(r_7, p_16);
      handleNumber_0_nif81dubp1(r_7, result_4);
      handleSuffix_0_nif81dubp1(r_7, result_4);
    } else {
      whileStmtLabel_3: {
        var p_17 = mem.u32(r_7);
        var eof_8 = mem.u32((r_7 + 4));
        mem.setU32((result_4 + 4), p_17);
        var hasDot_1 = false;
        {
          while (true) {
            var X60Qx_9;
            if ((p_17 < eof_8)) {
              var X60Qdesugar_49 = allocFixed(32);
              mem.copy(X60Qdesugar_49, ControlCharsOrWhite_0_nif81dubp1, 32);
              var X60Qdesugar_50 = mem.u8At(p_17);
              X60Qx_9 = (!(((mem.u8At((X60Qdesugar_49 + (X60Qdesugar_50 >>> 3))) & ((1 << ((X60Qdesugar_50 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            } else {
              X60Qx_9 = false;
            }
            if (X60Qx_9) {
              if ((mem.u8At(p_17) === 92)) {
                var X60Qdesugar_51 = (result_4 + 1);
                var X60Qdesugar_52 = 0;
                mem.setU8(X60Qdesugar_51, ((mem.u8At(X60Qdesugar_51) | (((1 & 255) << ((X60Qdesugar_52 & 7) >>> 0)) >>> 0)) >>> 0));
              } else {
                if ((mem.u8At(p_17) === 46)) {
                  hasDot_1 = true;
                }
              }
              inc_1_I6wjjge_cmdqs323n1(((result_4 + 4) + 4));
              p_17 = ((p_17 + 1) | 0);
            } else {
              break;
            }
          }
        }
      }
      mem.setU32(r_7, p_17);
      if ((0 < mem.i32(((result_4 + 4) + 4)))) {
        if (hasDot_1) {
          mem.setU8(result_4, 4);
          if ((mem.u8At((mem.u32((result_4 + 4)) + ((mem.i32(((result_4 + 4) + 4)) - 1) | 0))) === 46)) {
            var X60Qdesugar_53 = (result_4 + 1);
            var X60Qdesugar_54 = 2;
            mem.setU8(X60Qdesugar_53, ((mem.u8At(X60Qdesugar_53) | (((1 & 255) << ((X60Qdesugar_54 & 7) >>> 0)) >>> 0)) >>> 0));
          }
        } else {
          mem.setU8(result_4, 3);
        }
        handleSuffix_0_nif81dubp1(r_7, result_4);
      } else {
        mem.setU32((result_4 + 4), mem.u32(r_7));
        mem.setI32(((result_4 + 4) + 4), 1);
        mem.setU32(r_7, ((mem.u32(r_7) + 1) | 0));
      }
    }
  }
}

function startsWith_0_nif81dubp1(r_9, prefix_0) {
  whileStmtLabel_0: {
    var result_20;
    var prefixLen_0 = len_4_sysvq0asl(prefix_0);
    var i_0 = allocFixed(4);
    mem.setI32(i_0, 0);
    var p_18 = mem.u32(r_9);
    {
      while (true) {
        if ((prefixLen_0 <= mem.i32(i_0))) {
          return true;
        }
        var X60Qx_52;
        if ((mem.u32((r_9 + 4)) <= p_18)) {
          X60Qx_52 = true;
        } else {
          var X60Qx_53 = getQ_9_sysvq0asl(prefix_0, mem.i32(i_0));
          X60Qx_52 = (!(mem.u8At(p_18) === X60Qx_53));
        }
        if (X60Qx_52) {
          return false;
        }
        p_18 = ((p_18 + 1) | 0);
        inc_1_I6wjjge_cmdqs323n1(i_0);
      }
    }
  }
  return false;
  return result_20;
}

function readDirectives_0_nif81dubp1(r_10) {
  whileStmtLabel_0: {
    var tok_0 = allocFixed(36);
    mem.setU8(tok_0, 0);
    mem.setU8((tok_0 + 1), 0);
    mem.setU16((tok_0 + 2), 0);
    mem.copy((tok_0 + 4), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.copy((tok_0 + 12), (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.copy((tok_0 + 20), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.copy((tok_0 + 28), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      while (true) {
        skipWhitespace_0_nif81dubp1(r_10);
        var X60Qx_54 = startsWith_0_nif81dubp1(r_10, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 3024898);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
        if (X60Qx_54) {
          whileStmtLabel_1: {
            next_0_nif81dubp1(r_10, tok_0);
            if ((!(mem.u8At(tok_0) === 11))) {
              write_0_syn1lfpjv(stdout, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1933663230);
                mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
                return _o;
              })());
              write_0_syn1lfpjv(stdout, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 0);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              write_7_syn1lfpjv(stdout, 10);
              quit_0_syn1lfpjv(1);
            }
            var X60Qx_55 = eqQ_1_strdllfw2((tok_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1852387070);
              mem.setU32((_o + 4), strlit_0_I397779028761265335_nif81dubp1);
              return _o;
            })());
            if (X60Qx_55) {
              next_0_nif81dubp1(r_10, tok_0);
              if ((mem.u8At(tok_0) === 8)) {
                var X60Qx_56 = decodeInt_0_nif81dubp1(tok_0);
                mem.setI32((r_10 + 60), Number(BigInt.asIntN(32, X60Qx_56)));
              }
            } else {
              var X60Qx_57 = eqQ_1_strdllfw2((tok_0 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1853173502);
                mem.setU32((_o + 4), strlit_0_I12979507887005580180_nif81dubp1);
                return _o;
              })());
              if (X60Qx_57) {
                next_0_nif81dubp1(r_10, tok_0);
                if ((mem.u8At(tok_0) === 4)) {
                  mem.copy((r_10 + 64), tok_0, 36);
                }
              }
            }
            var nested_0 = allocFixed(4);
            mem.setI32(nested_0, 0);
            {
              while (true) {
                next_0_nif81dubp1(r_10, tok_0);
                switch (mem.u8At(tok_0)) {
                  case 11:
                    {
                      inc_1_I6wjjge_cmdqs323n1(nested_0);
                    }
                    break;
                  case 12:
                    {
                      if ((mem.i32(nested_0) === 0)) {
                        break whileStmtLabel_1;
                      }
                      dec_1_I0nzoz91_envto7w6l1(nested_0);
                    }
                    break;
                  case 1:
                    {
                      break whileStmtLabel_1;
                    }
                    break;
                  default:
                    {
                    }
                    break;
                }
              }
            }
          }
        } else {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function openFromBuffer_0_nif81dubp1(buf_0, thisModule_0) {
  let result_23 = allocFixed(100);
  eQwasmovedQ_SX52eader0nif81dubp1_0_nif81dubp1(result_23);
  eQdestroyQ_SX52eader0nif81dubp1_0_nif81dubp1(result_23);
  let X60Qtmp_2 = allocFixed(8);
  mem.copy(X60Qtmp_2, buf_0, 8);
  nimStrWasMoved(buf_0);
  let X60Qtmp_3 = allocFixed(8);
  mem.copy(X60Qtmp_3, thisModule_0, 8);
  nimStrWasMoved(thisModule_0);
  mem.copy(result_23, (() => {
    let _o = allocFixed(100);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    mem.copy((_o + 8), (() => {
      let _o = allocFixed(32);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      mem.copy((_o + 8), (() => {
        let _o = allocFixed(16);
        mem.setU32(_o, 0);
        mem.setI32((_o + 4), 0);
        mem.setI32((_o + 8), 0);
        mem.setI32((_o + 12), 0);
        return _o;
      })(), 16);
      mem.setU32((_o + 24), 0);
      mem.setU32((_o + 28), 0);
      return _o;
    })(), 32);
    mem.copy((_o + 40), X60Qtmp_2, 8);
    mem.copy((_o + 48), X60Qtmp_3, 8);
    mem.setI32((_o + 56), 0);
    mem.setI32((_o + 60), 0);
    mem.copy((_o + 64), (() => {
      let _o = allocFixed(36);
      mem.setU8(_o, 0);
      mem.setU8((_o + 1), 0);
      mem.setU16((_o + 2), 0);
      mem.copy((_o + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setI32((_o + 4), 0);
        return _o;
      })(), 8);
      mem.copy((_o + 12), (() => {
        let _o = allocFixed(8);
        mem.setI32(_o, 0);
        mem.setI32((_o + 4), 0);
        return _o;
      })(), 8);
      mem.copy((_o + 20), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setI32((_o + 4), 0);
        return _o;
      })(), 8);
      mem.copy((_o + 28), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setI32((_o + 4), 0);
        return _o;
      })(), 8);
      return _o;
    })(), 36);
    return _o;
  })(), 100);
  let n_0 = len_4_sysvq0asl((result_23 + 40));
  let X60Qx_62 = readRawDataStable_0_sysvq0asl((result_23 + 40), 0);
  mem.setU32(result_23, X60Qx_62);
  mem.setU32((result_23 + 4), ((mem.u32(result_23) + n_0) | 0));
  let X60Qx_63 = allocFixed(32);
  mem.copy(X60Qx_63, initBlob_0_vfsc9jn7(mem.u32(result_23), n_0, 0, 0), 32);
  mem.copy((result_23 + 8), X60Qx_63, 32);
  readDirectives_0_nif81dubp1(result_23);
  nimStrDestroy(thisModule_0);
  nimStrDestroy(buf_0);
  return result_23;
  nimStrDestroy(thisModule_0);
  nimStrDestroy(buf_0);
  return result_23;
}

function processDirectives_0_nif81dubp1(r_11) {
  let result_24;
  result_24 = 2;
  return result_24;
}

function toOpenArray_3_Inpmq9h_nif81dubp1(x_4, first_1, last_1) {
  let result_29 = allocFixed(8);
  mem.copy(result_29, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((x_4 + Math.imul(first_1, 1)) >>> 0));
    mem.setI32((_o + 4), ((((last_1 - first_1) | 0) + 1) | 0));
    return _o;
  })(), 8);
  return result_29;
}

function eQdestroyQ_SX52eader0nif81dubp1_0_nif81dubp1(dest_0) {
  nimStrDestroy((dest_0 + 48));
  nimStrDestroy((dest_0 + 40));
}

function eQwasmovedQ_SX52eader0nif81dubp1_0_nif81dubp1(dest_0) {
  nimStrWasMoved((dest_0 + 40));
  nimStrWasMoved((dest_0 + 48));
}

function integerOutOfRangeError_0_nif81dubp1() {
  quit_1_syn1lfpjv((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918980350);
    mem.setU32((_o + 4), strlit_0_I7773138664102327703_nif81dubp1);
    return _o;
  })());
}

let X60QiniGuard_0_nif81dubp1 = allocFixed(1);

function X60Qini_0_nif81dubp1() {
  if (mem.u8At(X60QiniGuard_0_nif81dubp1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_nif81dubp1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_memlzdyby();
  X60Qini_0_party5a2l1();
  X60Qini_0_assy765wm();
  X60Qini_0_strdllfw2();
  X60Qini_0_vfsc9jn7();
  X60Qini_0_syn1lfpjv();
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

let X60QiniGuard_0_jsfc0lwq21 = allocFixed(1);

function X60Qini_0_jsfc0lwq21() {
  if (mem.u8At(X60QiniGuard_0_jsfc0lwq21)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_jsfc0lwq21, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from nifb6mq6y1.c.nif

let ErrToken_0_nifb6mq6y1 = allocFixed(16);

function eQwasMoved_1_nifb6mq6y1(dest_2) {
  mem.setU32(dest_2, 0);
  mem.setI32((dest_2 + 4), 0);
  mem.setI32((dest_2 + 8), 0);
  mem.setU32((dest_2 + 12), 0);
}

function eQdestroy_1_nifb6mq6y1(dest_3) {
  if ((!(mem.u32((dest_3 + 12)) === 0))) {
    dec_1_I0nzoz91_envto7w6l1(mem.u32((dest_3 + 12)));
    if ((mem.i32(mem.u32((dest_3 + 12))) === 0)) {
      if ((!(mem.u32((mem.u32((dest_3 + 12)) + 4)) === 0))) {
        dealloc_1_sysvq0asl(mem.u32((mem.u32((dest_3 + 12)) + 4)));
      }
      dealloc_1_sysvq0asl(mem.u32((dest_3 + 12)));
    }
  } else {
    if ((!(mem.u32(dest_3) === 0))) {
      dealloc_1_sysvq0asl(mem.u32(dest_3));
    }
  }
}

function createTokenBuf_0_nifb6mq6y1(cap_1) {
  let result_25 = allocFixed(16);
  eQwasMoved_1_nifb6mq6y1(result_25);
  eQdestroy_1_nifb6mq6y1(result_25);
  let X60Qx_59 = max_2_sysvq0asl(cap_1, 8);
  let X60Qx_60 = alloc_1_sysvq0asl(Math.imul(8, X60Qx_59));
  mem.copy(result_25, (() => {
    let _o = allocFixed(16);
    mem.setU32(_o, X60Qx_60);
    mem.setI32((_o + 4), 0);
    mem.setI32((_o + 8), cap_1);
    mem.setU32((_o + 12), 0);
    return _o;
  })(), 16);
  return result_25;
}

function prepareMutation_0_nifb6mq6y1(b_0) {
  if ((!(mem.u32((b_0 + 12)) === 0))) {
    if ((mem.i32(mem.u32((b_0 + 12))) === 1)) {
      dealloc_1_sysvq0asl(mem.u32((b_0 + 12)));
      mem.setU32((b_0 + 12), 0);
    } else {
      let X60Qx_61 = max_2_sysvq0asl(mem.i32((b_0 + 8)), 8);
      let X60Qx_62 = alloc_1_sysvq0asl(Math.imul(8, X60Qx_61));
      let newData_0 = X60Qx_62;
      copyMem_0_sysvq0asl(newData_0, mem.u32(b_0), Math.imul(8, mem.i32((b_0 + 4))));
      dec_1_I0nzoz91_envto7w6l1(mem.u32((b_0 + 12)));
      if ((mem.i32(mem.u32((b_0 + 12))) === 0)) {
        if ((!(mem.u32((mem.u32((b_0 + 12)) + 4)) === 0))) {
          dealloc_1_sysvq0asl(mem.u32((mem.u32((b_0 + 12)) + 4)));
        }
        dealloc_1_sysvq0asl(mem.u32((b_0 + 12)));
      }
      mem.setU32((b_0 + 12), 0);
      mem.setU32(b_0, newData_0);
    }
  }
}

function add_0_nifb6mq6y1(b_7, item_1) {
  if ((!(mem.u32((b_7 + 12)) === 0))) {
    prepareMutation_0_nifb6mq6y1(b_7);
  }
  if ((mem.i32((b_7 + 8)) <= mem.i32((b_7 + 4)))) {
    let X60Qx_66 = max_2_sysvq0asl(((Math.trunc((mem.i32((b_7 + 8)) / 2)) + mem.i32((b_7 + 8))) | 0), 8);
    mem.setI32((b_7 + 8), X60Qx_66);
    let X60Qx_67 = realloc_1_sysvq0asl(mem.u32(b_7), Math.imul(8, mem.i32((b_7 + 8))));
    mem.setU32(b_7, X60Qx_67);
  }
  mem.copy((mem.u32(b_7) + (mem.i32((b_7 + 4)) * 8)), item_1, 8);
  inc_1_I6wjjge_cmdqs323n1((b_7 + 4));
}

function len_0_nifb6mq6y1(b_8) {
  let result_27;
  result_27 = mem.i32((b_8 + 4));
  return result_27;
}

function getQ_0_nifb6mq6y1(b_9, i_0) {
  let result_28;
  let X60Qx_68;
  if ((0 <= i_0)) {
    X60Qx_68 = (i_0 < mem.i32((b_9 + 4)));
  } else {
    X60Qx_68 = false;
  }
  if ((!X60Qx_68)) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  result_28 = (mem.u32(b_9) + (i_0 * 8));
  return result_28;
}

function add_2_nifb6mq6y1(result_3, s_2) {
  var c_49 = allocFixed(8);
  mem.copy(c_49, next_0_nifh7u8pu1(s_2), 8);
  if ((!(!((((mem.u32(c_49) & 15) >>> 0) & 255) === 12)))) {
    write_0_syn1lfpjv(stdout, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1920295934);
      mem.setU32((_o + 4), strlit_0_I3807893400126689806_nifb6mq6y1);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  add_0_nifb6mq6y1(result_3, c_49);
  if (((((mem.u32(c_49) & 15) >>> 0) & 255) === 11)) {
    whileStmtLabel_0: {
      var nested_4 = allocFixed(4);
      mem.setI32(nested_4, 0);
      {
        while (true) {
          var item_3 = allocFixed(8);
          mem.copy(item_3, next_0_nifh7u8pu1(s_2), 8);
          add_0_nifb6mq6y1(result_3, item_3);
          if (((((mem.u32(item_3) & 15) >>> 0) & 255) === 12)) {
            if ((mem.i32(nested_4) === 0)) {
              break whileStmtLabel_0;
            }
            dec_1_I0nzoz91_envto7w6l1(nested_4);
          } else {
            if (((((mem.u32(item_3) & 15) >>> 0) & 255) === 11)) {
              inc_1_I6wjjge_cmdqs323n1(nested_4);
            }
          }
        }
      }
    }
  }
}

function fromStream_0_nifb6mq6y1(s_3) {
  let result_36 = allocFixed(16);
  eQwasMoved_1_nifb6mq6y1(result_36);
  eQdestroy_1_nifb6mq6y1(result_36);
  let X60Qx_83 = allocFixed(16);
  mem.copy(X60Qx_83, createTokenBuf_0_nifb6mq6y1(4), 16);
  mem.copy(result_36, X60Qx_83, 16);
  add_2_nifb6mq6y1(result_36, s_3);
  return result_36;
}

function getOrIncl_0_Ix6biej1_nifb6mq6y1(t_7, v_5) {
  var result_54;
  var origH_0 = hash_1_has9tn57v(v_5);
  var X60Qx_144 = high_3_Izxucdl_nifb6mq6y1((t_7 + 8));
  var h_0 = ((origH_0 & X60Qx_144) >>> 0);
  if ((!(mem.i32((t_7 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_145 = getQ_8_Ikc5fbr_nifb6mq6y1((t_7 + 8), h_0);
          var litId_0 = mem.u32(X60Qx_145);
          if ((!(0 < litId_0))) {
            break whileStmtLabel_0;
          }
          var X60Qx_146 = getQ_8_Ikc5fbr_nifb6mq6y1((t_7 + 8), h_0);
          var X60Qx_147 = getQ_7_Ir6d0tw_envto7w6l1(t_7, ((mem.u32(X60Qx_146) - 1) | 0));
          var X60Qx_148 = eqQ_20_sysvq0asl(v_5, X60Qx_147);
          if (X60Qx_148) {
            return litId_0;
          }
          var X60Qx_149 = high_3_Izxucdl_nifb6mq6y1((t_7 + 8));
          var X60Qx_150 = nextTry_0_bitekkhcx1(h_0, X60Qx_149);
          h_0 = X60Qx_150;
        }
      }
    }
    var X60Qx_151 = mustRehash_0_bitekkhcx1(mem.i32((t_7 + 8)), mem.i32(t_7));
    if (X60Qx_151) {
      whileStmtLabel_1: {
        enlarge_0_Ig89cp21_nifb6mq6y1(t_7);
        var X60Qx_152 = high_3_Izxucdl_nifb6mq6y1((t_7 + 8));
        h_0 = ((origH_0 & X60Qx_152) >>> 0);
        {
          while (true) {
            var X60Qx_153 = getQ_8_Ikc5fbr_nifb6mq6y1((t_7 + 8), h_0);
            var litId_1 = mem.u32(X60Qx_153);
            if ((!(0 < litId_1))) {
              break whileStmtLabel_1;
            }
            var X60Qx_154 = high_3_Izxucdl_nifb6mq6y1((t_7 + 8));
            var X60Qx_155 = nextTry_0_bitekkhcx1(h_0, X60Qx_154);
            h_0 = X60Qx_155;
          }
        }
      }
    }
  } else {
    setLen_0_Ibzv7hh_nifb6mq6y1((t_7 + 8), 16);
    var X60Qx_156 = high_3_Izxucdl_nifb6mq6y1((t_7 + 8));
    h_0 = ((origH_0 & X60Qx_156) >>> 0);
  }
  result_54 = ((mem.i32(t_7) + 1) | 0);
  putQ_8_Ioc8g62_nifb6mq6y1((t_7 + 8), h_0, result_54);
  var X60Qx_157 = allocFixed(8);
  mem.copy(X60Qx_157, nimStrDup(v_5), 8);
  add_0_Ig6072n_cmdqs323n1(t_7, X60Qx_157);
  return result_54;
}

function getOrIncl_0_I4rntkc_nifb6mq6y1(t_9, v_6) {
  var result_55;
  var origH_1 = hash_3_has9tn57v(v_6);
  var X60Qx_158 = high_3_Izsl4h11_nifb6mq6y1((t_9 + 8));
  var h_1 = ((origH_1 & X60Qx_158) >>> 0);
  if ((!(mem.i32((t_9 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_159 = getQ_8_Ipe8xs01_nifb6mq6y1((t_9 + 8), h_1);
          var litId_2 = mem.u32(X60Qx_159);
          if ((!(0 < litId_2))) {
            break whileStmtLabel_0;
          }
          var X60Qx_160 = getQ_8_Ipe8xs01_nifb6mq6y1((t_9 + 8), h_1);
          var X60Qx_161 = getQ_7_Ite3z0o_nifb6mq6y1(t_9, ((mem.u32(X60Qx_160) - 1) | 0));
          if ((v_6 === mem.i64b(X60Qx_161))) {
            return litId_2;
          }
          var X60Qx_162 = high_3_Izsl4h11_nifb6mq6y1((t_9 + 8));
          var X60Qx_163 = nextTry_0_bitekkhcx1(h_1, X60Qx_162);
          h_1 = X60Qx_163;
        }
      }
    }
    var X60Qx_164 = mustRehash_0_bitekkhcx1(mem.i32((t_9 + 8)), mem.i32(t_9));
    if (X60Qx_164) {
      whileStmtLabel_1: {
        enlarge_0_Ihigsb71_nifb6mq6y1(t_9);
        var X60Qx_165 = high_3_Izsl4h11_nifb6mq6y1((t_9 + 8));
        h_1 = ((origH_1 & X60Qx_165) >>> 0);
        {
          while (true) {
            var X60Qx_166 = getQ_8_Ipe8xs01_nifb6mq6y1((t_9 + 8), h_1);
            var litId_3 = mem.u32(X60Qx_166);
            if ((!(0 < litId_3))) {
              break whileStmtLabel_1;
            }
            var X60Qx_167 = high_3_Izsl4h11_nifb6mq6y1((t_9 + 8));
            var X60Qx_168 = nextTry_0_bitekkhcx1(h_1, X60Qx_167);
            h_1 = X60Qx_168;
          }
        }
      }
    }
  } else {
    setLen_0_Itea5o81_nifb6mq6y1((t_9 + 8), 16);
    var X60Qx_169 = high_3_Izsl4h11_nifb6mq6y1((t_9 + 8));
    h_1 = ((origH_1 & X60Qx_169) >>> 0);
  }
  result_55 = ((mem.i32(t_9) + 1) | 0);
  putQ_8_It4t9dr_nifb6mq6y1((t_9 + 8), h_1, result_55);
  add_0_I8fahwb_nifb6mq6y1(t_9, v_6);
  return result_55;
}

function getOrIncl_0_Icm7gb1_nifb6mq6y1(t_11, v_7) {
  var result_56;
  var origH_2 = hash_4_has9tn57v(v_7);
  var X60Qx_170 = high_3_Iscz9v3_nifb6mq6y1((t_11 + 8));
  var h_2 = ((origH_2 & X60Qx_170) >>> 0);
  if ((!(mem.i32((t_11 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_171 = getQ_8_Il3tzqv_nifb6mq6y1((t_11 + 8), h_2);
          var litId_4 = mem.u32(X60Qx_171);
          if ((!(0 < litId_4))) {
            break whileStmtLabel_0;
          }
          var X60Qx_172 = getQ_8_Il3tzqv_nifb6mq6y1((t_11 + 8), h_2);
          var X60Qx_173 = getQ_7_Ifaxado1_nifb6mq6y1(t_11, ((mem.u32(X60Qx_172) - 1) | 0));
          if ((v_7 === mem.u64b(X60Qx_173))) {
            return litId_4;
          }
          var X60Qx_174 = high_3_Iscz9v3_nifb6mq6y1((t_11 + 8));
          var X60Qx_175 = nextTry_0_bitekkhcx1(h_2, X60Qx_174);
          h_2 = X60Qx_175;
        }
      }
    }
    var X60Qx_176 = mustRehash_0_bitekkhcx1(mem.i32((t_11 + 8)), mem.i32(t_11));
    if (X60Qx_176) {
      whileStmtLabel_1: {
        enlarge_0_Isqiwlk1_nifb6mq6y1(t_11);
        var X60Qx_177 = high_3_Iscz9v3_nifb6mq6y1((t_11 + 8));
        h_2 = ((origH_2 & X60Qx_177) >>> 0);
        {
          while (true) {
            var X60Qx_178 = getQ_8_Il3tzqv_nifb6mq6y1((t_11 + 8), h_2);
            var litId_5 = mem.u32(X60Qx_178);
            if ((!(0 < litId_5))) {
              break whileStmtLabel_1;
            }
            var X60Qx_179 = high_3_Iscz9v3_nifb6mq6y1((t_11 + 8));
            var X60Qx_180 = nextTry_0_bitekkhcx1(h_2, X60Qx_179);
            h_2 = X60Qx_180;
          }
        }
      }
    }
  } else {
    setLen_0_Ig8m65q_nifb6mq6y1((t_11 + 8), 16);
    var X60Qx_181 = high_3_Iscz9v3_nifb6mq6y1((t_11 + 8));
    h_2 = ((origH_2 & X60Qx_181) >>> 0);
  }
  result_56 = ((mem.i32(t_11) + 1) | 0);
  putQ_8_Ivcm3wy_nifb6mq6y1((t_11 + 8), h_2, result_56);
  add_0_I388oob1_nifb6mq6y1(t_11, v_7);
  return result_56;
}

function getOrIncl_1_Ijmj1s_nifb6mq6y1(t_13, v_8) {
  let v_8_v = v_8;
  v_8 = allocFixed(8);
  mem.setF64(v_8, v_8_v);
  let result_57;
  let X60Qx_182 = allocFixed(8);
  copyMem_0_sysvq0asl(X60Qx_182, v_8, 8);
  let X60Qx_183 = getOrIncl_0_Ivbdpqo_nifb6mq6y1(t_13, mem.u64b(X60Qx_182));
  result_57 = X60Qx_183;
  return result_57;
}

function getOrIncl_0_Is83dq9_nifb6mq6y1(t_15, v_10) {
  var result_59;
  var origH_3 = hash_1_has9tn57v(v_10);
  var X60Qx_184 = high_3_Ib20i801_nifb6mq6y1((t_15 + 8));
  var h_3 = ((origH_3 & X60Qx_184) >>> 0);
  if ((!(mem.i32((t_15 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_185 = getQ_8_I1lkkvo_nifb6mq6y1((t_15 + 8), h_3);
          var litId_6 = mem.u32(X60Qx_185);
          if ((!(0 < litId_6))) {
            break whileStmtLabel_0;
          }
          var X60Qx_186 = getQ_8_I1lkkvo_nifb6mq6y1((t_15 + 8), h_3);
          var X60Qx_187 = getQ_7_Ir6d0tw_envto7w6l1(t_15, ((mem.u32(X60Qx_186) - 1) | 0));
          var X60Qx_188 = eqQ_20_sysvq0asl(v_10, X60Qx_187);
          if (X60Qx_188) {
            return litId_6;
          }
          var X60Qx_189 = high_3_Ib20i801_nifb6mq6y1((t_15 + 8));
          var X60Qx_190 = nextTry_0_bitekkhcx1(h_3, X60Qx_189);
          h_3 = X60Qx_190;
        }
      }
    }
    var X60Qx_191 = mustRehash_0_bitekkhcx1(mem.i32((t_15 + 8)), mem.i32(t_15));
    if (X60Qx_191) {
      whileStmtLabel_1: {
        enlarge_0_I4mrsk51_nifb6mq6y1(t_15);
        var X60Qx_192 = high_3_Ib20i801_nifb6mq6y1((t_15 + 8));
        h_3 = ((origH_3 & X60Qx_192) >>> 0);
        {
          while (true) {
            var X60Qx_193 = getQ_8_I1lkkvo_nifb6mq6y1((t_15 + 8), h_3);
            var litId_7 = mem.u32(X60Qx_193);
            if ((!(0 < litId_7))) {
              break whileStmtLabel_1;
            }
            var X60Qx_194 = high_3_Ib20i801_nifb6mq6y1((t_15 + 8));
            var X60Qx_195 = nextTry_0_bitekkhcx1(h_3, X60Qx_194);
            h_3 = X60Qx_195;
          }
        }
      }
    }
  } else {
    setLen_0_Isypn1s_nifb6mq6y1((t_15 + 8), 16);
    var X60Qx_196 = high_3_Ib20i801_nifb6mq6y1((t_15 + 8));
    h_3 = ((origH_3 & X60Qx_196) >>> 0);
  }
  result_59 = ((mem.i32(t_15) + 1) | 0);
  putQ_8_Iltefhx_nifb6mq6y1((t_15 + 8), h_3, result_59);
  var X60Qx_197 = allocFixed(8);
  mem.copy(X60Qx_197, nimStrDup(v_10), 8);
  add_0_Ig6072n_cmdqs323n1(t_15, X60Qx_197);
  return result_59;
}

function high_3_Izxucdl_nifb6mq6y1(s_34) {
  let result_63;
  result_63 = ((mem.i32(s_34) - 1) | 0);
  return result_63;
}

function getQ_8_Ikc5fbr_nifb6mq6y1(s_35, i_26) {
  if ((!(i_26 < mem.i32(s_35)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_64;
  result_64 = (mem.u32((s_35 + 4)) + (i_26 * 4));
  return result_64;
}

function enlarge_0_Ig89cp21_nifb6mq6y1(t_17) {
  forStmtLabel_0: {
    var n_11 = allocFixed(8);
    eQwasMoved_1_I94uyip1_nifb6mq6y1(n_11);
    var X60Qx_203 = len_3_Ijagz1k_nifb6mq6y1((t_17 + 8));
    newSeq_1_Ildm5l2_nifb6mq6y1(n_11, Math.imul(X60Qx_203, 2));
    swap_0_Ia4b84l_nifb6mq6y1((t_17 + 8), n_11);
    {
      whileStmtLabel_1: {
        var X60Qlf_17 = 0;
        var X60Qlf_18 = high_3_Izxucdl_nifb6mq6y1(n_11);
        var X60Qlf_19 = allocFixed(4);
        mem.setI32(X60Qlf_19, X60Qlf_17);
        {
          while ((mem.i32(X60Qlf_19) <= X60Qlf_18)) {
            {
              var X60Qx_204 = getQ_7_Idda6ys1_nifb6mq6y1(n_11, mem.i32(X60Qlf_19));
              var X60Qii_2 = mem.u32(X60Qx_204);
              if ((0 < X60Qii_2)) {
                var X60Qx_205 = getQ_7_Ir6d0tw_envto7w6l1(t_17, ((X60Qii_2 - 1) | 0));
                var X60Qx_206 = hash_1_has9tn57v(X60Qx_205);
                var X60Qx_207 = high_3_Izxucdl_nifb6mq6y1((t_17 + 8));
                var X60Qii_3 = ((X60Qx_206 & X60Qx_207) >>> 0);
                while (true) {
                  var X60Qx_208 = getQ_8_Ikc5fbr_nifb6mq6y1((t_17 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_208))) {
                    var X60Qx_209 = high_3_Izxucdl_nifb6mq6y1((t_17 + 8));
                    var X60Qx_210 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_209);
                    X60Qii_3 = X60Qx_210;
                  } else {
                    break;
                  }
                }
                var X60Qx_211 = getQ_7_Idda6ys1_nifb6mq6y1(n_11, mem.i32(X60Qlf_19));
                var X60Qx_212 = move_0_Ii1uxvw_nifb6mq6y1(X60Qx_211);
                putQ_8_Ioc8g62_nifb6mq6y1((t_17 + 8), X60Qii_3, X60Qx_212);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_19);
          }
        }
      }
    }
  }
  eQdestroy_1_In04crl1_nifb6mq6y1(n_11);
}

function setLen_0_Ibzv7hh_nifb6mq6y1(s_40, newLen_8) {
  if ((newLen_8 < mem.i32(s_40))) {
    shrink_0_Ieny4k81_nifb6mq6y1(s_40, newLen_8);
  } else {
    whileStmtLabel_0: {
      var i_30 = allocFixed(4);
      mem.setI32(i_30, mem.i32(s_40));
      growUnsafe_0_I21nsd8_nifb6mq6y1(s_40, newLen_8);
      if ((mem.u32((s_40 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_30) < newLen_8)) {
          mem.setU32((mem.u32((s_40 + 4)) + (mem.i32(i_30) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_30);
        }
      }
    }
  }
}

function putQ_8_Ioc8g62_nifb6mq6y1(s_43, i_31, elem_11) {
  if ((!(i_31 < mem.i32(s_43)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_43 + 4)) + (i_31 * 4)), elem_11);
}

function high_3_Izsl4h11_nifb6mq6y1(s_46) {
  let result_66;
  result_66 = ((mem.i32(s_46) - 1) | 0);
  return result_66;
}

function getQ_8_Ipe8xs01_nifb6mq6y1(s_47, i_32) {
  if ((!(i_32 < mem.i32(s_47)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_67;
  result_67 = (mem.u32((s_47 + 4)) + (i_32 * 4));
  return result_67;
}

function getQ_7_Ite3z0o_nifb6mq6y1(s_48, i_33) {
  let X60Qx_215;
  if ((i_33 < mem.i32(s_48))) {
    X60Qx_215 = (0 <= i_33);
  } else {
    X60Qx_215 = false;
  }
  if ((!X60Qx_215)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_68;
  result_68 = (mem.u32((s_48 + 4)) + (i_33 * 8));
  return result_68;
}

function enlarge_0_Ihigsb71_nifb6mq6y1(t_18) {
  forStmtLabel_0: {
    var n_12 = allocFixed(8);
    eQwasMoved_1_I5re2ul_nifb6mq6y1(n_12);
    var X60Qx_216 = len_3_Iuo2rc51_nifb6mq6y1((t_18 + 8));
    newSeq_1_I6ltqq61_nifb6mq6y1(n_12, Math.imul(X60Qx_216, 2));
    swap_0_I6eckbf1_nifb6mq6y1((t_18 + 8), n_12);
    {
      whileStmtLabel_1: {
        var X60Qlf_20 = 0;
        var X60Qlf_21 = high_3_Izsl4h11_nifb6mq6y1(n_12);
        var X60Qlf_22 = allocFixed(4);
        mem.setI32(X60Qlf_22, X60Qlf_20);
        {
          while ((mem.i32(X60Qlf_22) <= X60Qlf_21)) {
            {
              var X60Qx_217 = getQ_7_Ilsb84j1_nifb6mq6y1(n_12, mem.i32(X60Qlf_22));
              var X60Qii_2 = mem.u32(X60Qx_217);
              if ((0 < X60Qii_2)) {
                var X60Qx_218 = getQ_7_Ite3z0o_nifb6mq6y1(t_18, ((X60Qii_2 - 1) | 0));
                var X60Qx_219 = hash_3_has9tn57v(mem.i64b(X60Qx_218));
                var X60Qx_220 = high_3_Izsl4h11_nifb6mq6y1((t_18 + 8));
                var X60Qii_3 = ((X60Qx_219 & X60Qx_220) >>> 0);
                while (true) {
                  var X60Qx_221 = getQ_8_Ipe8xs01_nifb6mq6y1((t_18 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_221))) {
                    var X60Qx_222 = high_3_Izsl4h11_nifb6mq6y1((t_18 + 8));
                    var X60Qx_223 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_222);
                    X60Qii_3 = X60Qx_223;
                  } else {
                    break;
                  }
                }
                var X60Qx_224 = getQ_7_Ilsb84j1_nifb6mq6y1(n_12, mem.i32(X60Qlf_22));
                var X60Qx_225 = move_0_Ietsi66_nifb6mq6y1(X60Qx_224);
                putQ_8_It4t9dr_nifb6mq6y1((t_18 + 8), X60Qii_3, X60Qx_225);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_22);
          }
        }
      }
    }
  }
  eQdestroy_1_Inr6ycs1_nifb6mq6y1(n_12);
}

function setLen_0_Itea5o81_nifb6mq6y1(s_52, newLen_12) {
  if ((newLen_12 < mem.i32(s_52))) {
    shrink_0_It5i65g1_nifb6mq6y1(s_52, newLen_12);
  } else {
    whileStmtLabel_0: {
      var i_36 = allocFixed(4);
      mem.setI32(i_36, mem.i32(s_52));
      growUnsafe_0_In7jweg_nifb6mq6y1(s_52, newLen_12);
      if ((mem.u32((s_52 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_36) < newLen_12)) {
          mem.setU32((mem.u32((s_52 + 4)) + (mem.i32(i_36) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_36);
        }
      }
    }
  }
}

function putQ_8_It4t9dr_nifb6mq6y1(s_55, i_37, elem_13) {
  if ((!(i_37 < mem.i32(s_55)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_55 + 4)) + (i_37 * 4)), elem_13);
}

function add_0_I8fahwb_nifb6mq6y1(s_56, elem_14) {
  let L_3 = mem.i32(s_56);
  let X60Qx_226 = capInBytes_0_Ilkynur1_nifb6mq6y1(s_56);
  if ((X60Qx_226 < ((Math.imul(L_3, 8) + 8) | 0))) {
    let X60Qx_227 = resize_0_Itn1ieo1_nifb6mq6y1(s_56, 1);
    if ((!X60Qx_227)) {
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_56);
  mem.setI64((mem.u32((s_56 + 4)) + (L_3 * 8)), elem_14);
}

function high_3_Iscz9v3_nifb6mq6y1(s_58) {
  let result_69;
  result_69 = ((mem.i32(s_58) - 1) | 0);
  return result_69;
}

function getQ_8_Il3tzqv_nifb6mq6y1(s_59, i_38) {
  if ((!(i_38 < mem.i32(s_59)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_70;
  result_70 = (mem.u32((s_59 + 4)) + (i_38 * 4));
  return result_70;
}

function getQ_7_Ifaxado1_nifb6mq6y1(s_60, i_39) {
  let X60Qx_228;
  if ((i_39 < mem.i32(s_60))) {
    X60Qx_228 = (0 <= i_39);
  } else {
    X60Qx_228 = false;
  }
  if ((!X60Qx_228)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_71;
  result_71 = (mem.u32((s_60 + 4)) + (i_39 * 8));
  return result_71;
}

function enlarge_0_Isqiwlk1_nifb6mq6y1(t_19) {
  forStmtLabel_0: {
    var n_13 = allocFixed(8);
    eQwasMoved_1_I52bdqo1_nifb6mq6y1(n_13);
    var X60Qx_229 = len_3_Itda5g31_nifb6mq6y1((t_19 + 8));
    newSeq_1_I63l1ps_nifb6mq6y1(n_13, Math.imul(X60Qx_229, 2));
    swap_0_I6g32k11_nifb6mq6y1((t_19 + 8), n_13);
    {
      whileStmtLabel_1: {
        var X60Qlf_23 = 0;
        var X60Qlf_24 = high_3_Iscz9v3_nifb6mq6y1(n_13);
        var X60Qlf_25 = allocFixed(4);
        mem.setI32(X60Qlf_25, X60Qlf_23);
        {
          while ((mem.i32(X60Qlf_25) <= X60Qlf_24)) {
            {
              var X60Qx_230 = getQ_7_I19xg9l1_nifb6mq6y1(n_13, mem.i32(X60Qlf_25));
              var X60Qii_2 = mem.u32(X60Qx_230);
              if ((0 < X60Qii_2)) {
                var X60Qx_231 = getQ_7_Ifaxado1_nifb6mq6y1(t_19, ((X60Qii_2 - 1) | 0));
                var X60Qx_232 = hash_4_has9tn57v(mem.u64b(X60Qx_231));
                var X60Qx_233 = high_3_Iscz9v3_nifb6mq6y1((t_19 + 8));
                var X60Qii_3 = ((X60Qx_232 & X60Qx_233) >>> 0);
                while (true) {
                  var X60Qx_234 = getQ_8_Il3tzqv_nifb6mq6y1((t_19 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_234))) {
                    var X60Qx_235 = high_3_Iscz9v3_nifb6mq6y1((t_19 + 8));
                    var X60Qx_236 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_235);
                    X60Qii_3 = X60Qx_236;
                  } else {
                    break;
                  }
                }
                var X60Qx_237 = getQ_7_I19xg9l1_nifb6mq6y1(n_13, mem.i32(X60Qlf_25));
                var X60Qx_238 = move_0_I1bmgmc_nifb6mq6y1(X60Qx_237);
                putQ_8_Ivcm3wy_nifb6mq6y1((t_19 + 8), X60Qii_3, X60Qx_238);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_25);
          }
        }
      }
    }
  }
  eQdestroy_1_I7og8li_nifb6mq6y1(n_13);
}

function setLen_0_Ig8m65q_nifb6mq6y1(s_64, newLen_16) {
  if ((newLen_16 < mem.i32(s_64))) {
    shrink_0_Io5vz0b_nifb6mq6y1(s_64, newLen_16);
  } else {
    whileStmtLabel_0: {
      var i_42 = allocFixed(4);
      mem.setI32(i_42, mem.i32(s_64));
      growUnsafe_0_Iyoxsj_nifb6mq6y1(s_64, newLen_16);
      if ((mem.u32((s_64 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_42) < newLen_16)) {
          mem.setU32((mem.u32((s_64 + 4)) + (mem.i32(i_42) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_42);
        }
      }
    }
  }
}

function putQ_8_Ivcm3wy_nifb6mq6y1(s_67, i_43, elem_15) {
  if ((!(i_43 < mem.i32(s_67)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_67 + 4)) + (i_43 * 4)), elem_15);
}

function add_0_I388oob1_nifb6mq6y1(s_68, elem_16) {
  let L_4 = mem.i32(s_68);
  let X60Qx_239 = capInBytes_0_Iifs4oa_nifb6mq6y1(s_68);
  if ((X60Qx_239 < ((Math.imul(L_4, 8) + 8) | 0))) {
    let X60Qx_240 = resize_0_Ixmbspe1_nifb6mq6y1(s_68, 1);
    if ((!X60Qx_240)) {
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_68);
  mem.setU64((mem.u32((s_68 + 4)) + (L_4 * 8)), elem_16);
}

function getOrIncl_0_Ivbdpqo_nifb6mq6y1(t_20, v_11) {
  var result_72;
  var origH_4 = hash_4_has9tn57v(v_11);
  var X60Qx_241 = high_3_I8k93cc_nifb6mq6y1((t_20 + 8));
  var h_4 = ((origH_4 & X60Qx_241) >>> 0);
  if ((!(mem.i32((t_20 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_242 = getQ_8_Iboidd8_nifb6mq6y1((t_20 + 8), h_4);
          var litId_8 = mem.u32(X60Qx_242);
          if ((!(0 < litId_8))) {
            break whileStmtLabel_0;
          }
          var X60Qx_243 = getQ_8_Iboidd8_nifb6mq6y1((t_20 + 8), h_4);
          var X60Qx_244 = getQ_7_Ifaxado1_nifb6mq6y1(t_20, ((mem.u32(X60Qx_243) - 1) | 0));
          if ((v_11 === mem.u64b(X60Qx_244))) {
            return litId_8;
          }
          var X60Qx_245 = high_3_I8k93cc_nifb6mq6y1((t_20 + 8));
          var X60Qx_246 = nextTry_0_bitekkhcx1(h_4, X60Qx_245);
          h_4 = X60Qx_246;
        }
      }
    }
    var X60Qx_247 = mustRehash_0_bitekkhcx1(mem.i32((t_20 + 8)), mem.i32(t_20));
    if (X60Qx_247) {
      whileStmtLabel_1: {
        enlarge_0_Ib1jipm1_nifb6mq6y1(t_20);
        var X60Qx_248 = high_3_I8k93cc_nifb6mq6y1((t_20 + 8));
        h_4 = ((origH_4 & X60Qx_248) >>> 0);
        {
          while (true) {
            var X60Qx_249 = getQ_8_Iboidd8_nifb6mq6y1((t_20 + 8), h_4);
            var litId_9 = mem.u32(X60Qx_249);
            if ((!(0 < litId_9))) {
              break whileStmtLabel_1;
            }
            var X60Qx_250 = high_3_I8k93cc_nifb6mq6y1((t_20 + 8));
            var X60Qx_251 = nextTry_0_bitekkhcx1(h_4, X60Qx_250);
            h_4 = X60Qx_251;
          }
        }
      }
    }
  } else {
    setLen_0_Ixczj431_nifb6mq6y1((t_20 + 8), 16);
    var X60Qx_252 = high_3_I8k93cc_nifb6mq6y1((t_20 + 8));
    h_4 = ((origH_4 & X60Qx_252) >>> 0);
  }
  result_72 = ((mem.i32(t_20) + 1) | 0);
  putQ_8_Idqx2k6_nifb6mq6y1((t_20 + 8), h_4, result_72);
  add_0_I388oob1_nifb6mq6y1(t_20, v_11);
  return result_72;
}

function dec_0_Ig5i8xp_nifb6mq6y1(x_18, y_4) {
  mem.setI32(x_18, ((mem.i32(x_18) - y_4) | 0));
}

function high_3_Ib20i801_nifb6mq6y1(s_74) {
  let result_73;
  result_73 = ((mem.i32(s_74) - 1) | 0);
  return result_73;
}

function getQ_8_I1lkkvo_nifb6mq6y1(s_75, i_46) {
  if ((!(i_46 < mem.i32(s_75)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_74;
  result_74 = (mem.u32((s_75 + 4)) + (i_46 * 4));
  return result_74;
}

function enlarge_0_I4mrsk51_nifb6mq6y1(t_22) {
  forStmtLabel_0: {
    var n_14 = allocFixed(8);
    eQwasMoved_1_Iew8iz1_nifb6mq6y1(n_14);
    var X60Qx_253 = len_3_If16jqr1_nifb6mq6y1((t_22 + 8));
    newSeq_1_Iq8m0a91_nifb6mq6y1(n_14, Math.imul(X60Qx_253, 2));
    swap_0_Iy6v9ra1_nifb6mq6y1((t_22 + 8), n_14);
    {
      whileStmtLabel_1: {
        var X60Qlf_26 = 0;
        var X60Qlf_27 = high_3_Ib20i801_nifb6mq6y1(n_14);
        var X60Qlf_28 = allocFixed(4);
        mem.setI32(X60Qlf_28, X60Qlf_26);
        {
          while ((mem.i32(X60Qlf_28) <= X60Qlf_27)) {
            {
              var X60Qx_254 = getQ_7_Iy9op7o1_nifb6mq6y1(n_14, mem.i32(X60Qlf_28));
              var X60Qii_2 = mem.u32(X60Qx_254);
              if ((0 < X60Qii_2)) {
                var X60Qx_255 = getQ_7_Ir6d0tw_envto7w6l1(t_22, ((X60Qii_2 - 1) | 0));
                var X60Qx_256 = hash_1_has9tn57v(X60Qx_255);
                var X60Qx_257 = high_3_Ib20i801_nifb6mq6y1((t_22 + 8));
                var X60Qii_3 = ((X60Qx_256 & X60Qx_257) >>> 0);
                while (true) {
                  var X60Qx_258 = getQ_8_I1lkkvo_nifb6mq6y1((t_22 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_258))) {
                    var X60Qx_259 = high_3_Ib20i801_nifb6mq6y1((t_22 + 8));
                    var X60Qx_260 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_259);
                    X60Qii_3 = X60Qx_260;
                  } else {
                    break;
                  }
                }
                var X60Qx_261 = getQ_7_Iy9op7o1_nifb6mq6y1(n_14, mem.i32(X60Qlf_28));
                var X60Qx_262 = move_0_Ijeywfo_nifb6mq6y1(X60Qx_261);
                putQ_8_Iltefhx_nifb6mq6y1((t_22 + 8), X60Qii_3, X60Qx_262);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_28);
          }
        }
      }
    }
  }
  eQdestroy_1_I5fjqyi1_nifb6mq6y1(n_14);
}

function setLen_0_Isypn1s_nifb6mq6y1(s_79, newLen_21) {
  if ((newLen_21 < mem.i32(s_79))) {
    shrink_0_Idm4aal_nifb6mq6y1(s_79, newLen_21);
  } else {
    whileStmtLabel_0: {
      var i_49 = allocFixed(4);
      mem.setI32(i_49, mem.i32(s_79));
      growUnsafe_0_I70ktio1_nifb6mq6y1(s_79, newLen_21);
      if ((mem.u32((s_79 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_49) < newLen_21)) {
          mem.setU32((mem.u32((s_79 + 4)) + (mem.i32(i_49) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_49);
        }
      }
    }
  }
}

function putQ_8_Iltefhx_nifb6mq6y1(s_82, i_50, elem_18) {
  if ((!(i_50 < mem.i32(s_82)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_82 + 4)) + (i_50 * 4)), elem_18);
}

function len_3_Ijagz1k_nifb6mq6y1(s_83) {
  let result_76;
  result_76 = mem.i32(s_83);
  return result_76;
}

function newSeq_1_Ildm5l2_nifb6mq6y1(s_84, newLen_24) {
  let X60Qx_263 = allocFixed(8);
  mem.copy(X60Qx_263, newSeq_0_Iyso6231_nifb6mq6y1(newLen_24), 8);
  mem.copy(s_84, X60Qx_263, 8);
}

function swap_0_Ia4b84l_nifb6mq6y1(x_21, y_6) {
  let tmp_0 = allocFixed(8);
  mem.copy(tmp_0, x_21, 8);
  mem.copy(x_21, y_6, 8);
  mem.copy(y_6, tmp_0, 8);
}

function getQ_7_Idda6ys1_nifb6mq6y1(s_85, i_52) {
  let X60Qx_264;
  if ((i_52 < mem.i32(s_85))) {
    X60Qx_264 = (0 <= i_52);
  } else {
    X60Qx_264 = false;
  }
  if ((!X60Qx_264)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_77;
  result_77 = (mem.u32((s_85 + 4)) + (i_52 * 4));
  return result_77;
}

function move_0_Ii1uxvw_nifb6mq6y1(x_22) {
  let result_78;
  result_78 = mem.u32(x_22);
  return result_78;
}

function shrink_0_Ieny4k81_nifb6mq6y1(s_86, newLen_25) {
  whileStmtLabel_0: {
    var i_53 = allocFixed(4);
    mem.setI32(i_53, ((mem.i32(s_86) - 1) | 0));
    {
      while ((newLen_25 <= mem.i32(i_53))) {
        dec_1_I0nzoz91_envto7w6l1(i_53);
      }
    }
  }
  mem.setI32(s_86, newLen_25);
}

function growUnsafe_0_I21nsd8_nifb6mq6y1(s_87, newLen_26) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_26, 4);
  let newSize_0 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_265 = capInBytes_0_I2v1dsn1_nifb6mq6y1(s_87);
  if ((X60Qx_265 < newSize_0)) {
    let X60Qx_266 = resize_0_Itvf2zj1_nifb6mq6y1(s_87, ((newLen_26 - mem.i32(s_87)) | 0));
    if ((!X60Qx_266)) {
      return;
    }
  }
  mem.setI32(s_87, newLen_26);
}

function len_3_Iuo2rc51_nifb6mq6y1(s_90) {
  let result_81;
  result_81 = mem.i32(s_90);
  return result_81;
}

function newSeq_1_I6ltqq61_nifb6mq6y1(s_91, newLen_27) {
  let X60Qx_270 = allocFixed(8);
  mem.copy(X60Qx_270, newSeq_0_Ixuxdi21_nifb6mq6y1(newLen_27), 8);
  mem.copy(s_91, X60Qx_270, 8);
}

function swap_0_I6eckbf1_nifb6mq6y1(x_23, y_7) {
  let tmp_1 = allocFixed(8);
  mem.copy(tmp_1, x_23, 8);
  mem.copy(x_23, y_7, 8);
  mem.copy(y_7, tmp_1, 8);
}

function getQ_7_Ilsb84j1_nifb6mq6y1(s_92, i_54) {
  let X60Qx_271;
  if ((i_54 < mem.i32(s_92))) {
    X60Qx_271 = (0 <= i_54);
  } else {
    X60Qx_271 = false;
  }
  if ((!X60Qx_271)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_82;
  result_82 = (mem.u32((s_92 + 4)) + (i_54 * 4));
  return result_82;
}

function move_0_Ietsi66_nifb6mq6y1(x_24) {
  let result_83;
  result_83 = mem.u32(x_24);
  return result_83;
}

function shrink_0_It5i65g1_nifb6mq6y1(s_93, newLen_28) {
  whileStmtLabel_0: {
    var i_55 = allocFixed(4);
    mem.setI32(i_55, ((mem.i32(s_93) - 1) | 0));
    {
      while ((newLen_28 <= mem.i32(i_55))) {
        dec_1_I0nzoz91_envto7w6l1(i_55);
      }
    }
  }
  mem.setI32(s_93, newLen_28);
}

function growUnsafe_0_In7jweg_nifb6mq6y1(s_94, newLen_29) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_29, 4);
  let newSize_1 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_272 = capInBytes_0_Ittsk85_nifb6mq6y1(s_94);
  if ((X60Qx_272 < newSize_1)) {
    let X60Qx_273 = resize_0_Isps98o_nifb6mq6y1(s_94, ((newLen_29 - mem.i32(s_94)) | 0));
    if ((!X60Qx_273)) {
      return;
    }
  }
  mem.setI32(s_94, newLen_29);
}

function capInBytes_0_Ilkynur1_nifb6mq6y1(s_96) {
  let result_84;
  let X60Qx_7;
  if ((!(mem.u32((s_96 + 4)) === 0))) {
    let X60Qx_274 = allocatedSize_0_sysvq0asl(mem.u32((s_96 + 4)));
    X60Qx_7 = X60Qx_274;
  } else {
    X60Qx_7 = 0;
  }
  result_84 = X60Qx_7;
  return result_84;
}

function resize_0_Itn1ieo1_nifb6mq6y1(dest_37, addedElements_8) {
  let result_85;
  let X60Qx_275 = capInBytes_0_Ilkynur1_nifb6mq6y1(dest_37);
  let oldCap_2 = Math.trunc((X60Qx_275 / 8));
  let newCap_2 = recalcCap_0_sysvq0asl(oldCap_2, addedElements_8);
  let memSize_2 = memSizeInBytes_0_Iqj0wsf_nifb6mq6y1(newCap_2);
  let X60Qx_276 = realloc_1_sysvq0asl(mem.u32((dest_37 + 4)), memSize_2);
  mem.setU32((dest_37 + 4), X60Qx_276);
  if ((mem.u32((dest_37 + 4)) === 0)) {
    mem.setI32(dest_37, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    result_85 = false;
  } else {
    result_85 = true;
  }
  return result_85;
}

function len_3_Itda5g31_nifb6mq6y1(s_97) {
  let result_86;
  result_86 = mem.i32(s_97);
  return result_86;
}

function newSeq_1_I63l1ps_nifb6mq6y1(s_98, newLen_30) {
  let X60Qx_277 = allocFixed(8);
  mem.copy(X60Qx_277, newSeq_0_I4s8fn41_nifb6mq6y1(newLen_30), 8);
  mem.copy(s_98, X60Qx_277, 8);
}

function swap_0_I6g32k11_nifb6mq6y1(x_25, y_8) {
  let tmp_2 = allocFixed(8);
  mem.copy(tmp_2, x_25, 8);
  mem.copy(x_25, y_8, 8);
  mem.copy(y_8, tmp_2, 8);
}

function getQ_7_I19xg9l1_nifb6mq6y1(s_99, i_56) {
  let X60Qx_278;
  if ((i_56 < mem.i32(s_99))) {
    X60Qx_278 = (0 <= i_56);
  } else {
    X60Qx_278 = false;
  }
  if ((!X60Qx_278)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_87;
  result_87 = (mem.u32((s_99 + 4)) + (i_56 * 4));
  return result_87;
}

function move_0_I1bmgmc_nifb6mq6y1(x_26) {
  let result_88;
  result_88 = mem.u32(x_26);
  return result_88;
}

function shrink_0_Io5vz0b_nifb6mq6y1(s_100, newLen_31) {
  whileStmtLabel_0: {
    var i_57 = allocFixed(4);
    mem.setI32(i_57, ((mem.i32(s_100) - 1) | 0));
    {
      while ((newLen_31 <= mem.i32(i_57))) {
        dec_1_I0nzoz91_envto7w6l1(i_57);
      }
    }
  }
  mem.setI32(s_100, newLen_31);
}

function growUnsafe_0_Iyoxsj_nifb6mq6y1(s_101, newLen_32) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_32, 4);
  let newSize_2 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_279 = capInBytes_0_I4tsb7_nifb6mq6y1(s_101);
  if ((X60Qx_279 < newSize_2)) {
    let X60Qx_280 = resize_0_Indszvc_nifb6mq6y1(s_101, ((newLen_32 - mem.i32(s_101)) | 0));
    if ((!X60Qx_280)) {
      return;
    }
  }
  mem.setI32(s_101, newLen_32);
}

function capInBytes_0_Iifs4oa_nifb6mq6y1(s_103) {
  let result_89;
  let X60Qx_8;
  if ((!(mem.u32((s_103 + 4)) === 0))) {
    let X60Qx_281 = allocatedSize_0_sysvq0asl(mem.u32((s_103 + 4)));
    X60Qx_8 = X60Qx_281;
  } else {
    X60Qx_8 = 0;
  }
  result_89 = X60Qx_8;
  return result_89;
}

function resize_0_Ixmbspe1_nifb6mq6y1(dest_39, addedElements_10) {
  let result_90;
  let X60Qx_282 = capInBytes_0_Iifs4oa_nifb6mq6y1(dest_39);
  let oldCap_3 = Math.trunc((X60Qx_282 / 8));
  let newCap_3 = recalcCap_0_sysvq0asl(oldCap_3, addedElements_10);
  let memSize_3 = memSizeInBytes_0_Iom723i1_nifb6mq6y1(newCap_3);
  let X60Qx_283 = realloc_1_sysvq0asl(mem.u32((dest_39 + 4)), memSize_3);
  mem.setU32((dest_39 + 4), X60Qx_283);
  if ((mem.u32((dest_39 + 4)) === 0)) {
    mem.setI32(dest_39, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_3);
    result_90 = false;
  } else {
    result_90 = true;
  }
  return result_90;
}

function high_3_I8k93cc_nifb6mq6y1(s_104) {
  let result_91;
  result_91 = ((mem.i32(s_104) - 1) | 0);
  return result_91;
}

function getQ_8_Iboidd8_nifb6mq6y1(s_105, i_58) {
  if ((!(i_58 < mem.i32(s_105)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_92;
  result_92 = (mem.u32((s_105 + 4)) + (i_58 * 4));
  return result_92;
}

function enlarge_0_Ib1jipm1_nifb6mq6y1(t_23) {
  forStmtLabel_0: {
    var n_15 = allocFixed(8);
    eQwasMoved_1_I5y4iq9_nifb6mq6y1(n_15);
    var X60Qx_284 = len_3_Irzg08a_nifb6mq6y1((t_23 + 8));
    newSeq_1_Idmlkik1_nifb6mq6y1(n_15, Math.imul(X60Qx_284, 2));
    swap_0_Iqoh72v_nifb6mq6y1((t_23 + 8), n_15);
    {
      whileStmtLabel_1: {
        var X60Qlf_29 = 0;
        var X60Qlf_30 = high_3_I8k93cc_nifb6mq6y1(n_15);
        var X60Qlf_31 = allocFixed(4);
        mem.setI32(X60Qlf_31, X60Qlf_29);
        {
          while ((mem.i32(X60Qlf_31) <= X60Qlf_30)) {
            {
              var X60Qx_285 = getQ_7_Iqb93l2_nifb6mq6y1(n_15, mem.i32(X60Qlf_31));
              var X60Qii_2 = mem.u32(X60Qx_285);
              if ((0 < X60Qii_2)) {
                var X60Qx_286 = getQ_7_Ifaxado1_nifb6mq6y1(t_23, ((X60Qii_2 - 1) | 0));
                var X60Qx_287 = hash_4_has9tn57v(mem.u64b(X60Qx_286));
                var X60Qx_288 = high_3_I8k93cc_nifb6mq6y1((t_23 + 8));
                var X60Qii_3 = ((X60Qx_287 & X60Qx_288) >>> 0);
                while (true) {
                  var X60Qx_289 = getQ_8_Iboidd8_nifb6mq6y1((t_23 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_289))) {
                    var X60Qx_290 = high_3_I8k93cc_nifb6mq6y1((t_23 + 8));
                    var X60Qx_291 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_290);
                    X60Qii_3 = X60Qx_291;
                  } else {
                    break;
                  }
                }
                var X60Qx_292 = getQ_7_Iqb93l2_nifb6mq6y1(n_15, mem.i32(X60Qlf_31));
                var X60Qx_293 = move_0_Ipo4xyv_nifb6mq6y1(X60Qx_292);
                putQ_8_Idqx2k6_nifb6mq6y1((t_23 + 8), X60Qii_3, X60Qx_293);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_31);
          }
        }
      }
    }
  }
  eQdestroy_1_Iz0k69p1_nifb6mq6y1(n_15);
}

function setLen_0_Ixczj431_nifb6mq6y1(s_109, newLen_34) {
  if ((newLen_34 < mem.i32(s_109))) {
    shrink_0_I74bzl8_nifb6mq6y1(s_109, newLen_34);
  } else {
    whileStmtLabel_0: {
      var i_61 = allocFixed(4);
      mem.setI32(i_61, mem.i32(s_109));
      growUnsafe_0_I4lson61_nifb6mq6y1(s_109, newLen_34);
      if ((mem.u32((s_109 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_61) < newLen_34)) {
          mem.setU32((mem.u32((s_109 + 4)) + (mem.i32(i_61) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_61);
        }
      }
    }
  }
}

function putQ_8_Idqx2k6_nifb6mq6y1(s_112, i_62, elem_19) {
  if ((!(i_62 < mem.i32(s_112)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_112 + 4)) + (i_62 * 4)), elem_19);
}

function len_3_If16jqr1_nifb6mq6y1(s_113) {
  let result_93;
  result_93 = mem.i32(s_113);
  return result_93;
}

function newSeq_1_Iq8m0a91_nifb6mq6y1(s_114, newLen_37) {
  let X60Qx_294 = allocFixed(8);
  mem.copy(X60Qx_294, newSeq_0_Ilpxoqc1_nifb6mq6y1(newLen_37), 8);
  mem.copy(s_114, X60Qx_294, 8);
}

function swap_0_Iy6v9ra1_nifb6mq6y1(x_29, y_10) {
  let tmp_3 = allocFixed(8);
  mem.copy(tmp_3, x_29, 8);
  mem.copy(x_29, y_10, 8);
  mem.copy(y_10, tmp_3, 8);
}

function getQ_7_Iy9op7o1_nifb6mq6y1(s_115, i_63) {
  let X60Qx_295;
  if ((i_63 < mem.i32(s_115))) {
    X60Qx_295 = (0 <= i_63);
  } else {
    X60Qx_295 = false;
  }
  if ((!X60Qx_295)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_94;
  result_94 = (mem.u32((s_115 + 4)) + (i_63 * 4));
  return result_94;
}

function move_0_Ijeywfo_nifb6mq6y1(x_30) {
  let result_95;
  result_95 = mem.u32(x_30);
  return result_95;
}

function shrink_0_Idm4aal_nifb6mq6y1(s_116, newLen_38) {
  whileStmtLabel_0: {
    var i_64 = allocFixed(4);
    mem.setI32(i_64, ((mem.i32(s_116) - 1) | 0));
    {
      while ((newLen_38 <= mem.i32(i_64))) {
        dec_1_I0nzoz91_envto7w6l1(i_64);
      }
    }
  }
  mem.setI32(s_116, newLen_38);
}

function growUnsafe_0_I70ktio1_nifb6mq6y1(s_117, newLen_39) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_39, 4);
  let newSize_3 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_296 = capInBytes_0_Ipcgi0v1_nifb6mq6y1(s_117);
  if ((X60Qx_296 < newSize_3)) {
    let X60Qx_297 = resize_0_Iuxedyo1_nifb6mq6y1(s_117, ((newLen_39 - mem.i32(s_117)) | 0));
    if ((!X60Qx_297)) {
      return;
    }
  }
  mem.setI32(s_117, newLen_39);
}

function newSeq_0_Iyso6231_nifb6mq6y1(size_9) {
  var result_96 = allocFixed(8);
  if ((size_9 === 0)) {
    mem.copy(result_96, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_9);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_4 = memSizeInBytes_0_Iu5tdzt_nifb6mq6y1(size_9);
    var X60Qx_298 = alloc_1_sysvq0asl(memSize_4);
    mem.copy(result_96, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_9);
      mem.setU32((_o + 4), X60Qx_298);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_96 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_65 = allocFixed(4);
        mem.setI32(i_65, 0);
        {
          while ((mem.i32(i_65) < size_9)) {
            mem.setU32((mem.u32((result_96 + 4)) + (mem.i32(i_65) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_65);
          }
        }
      }
    } else {
      mem.setI32(result_96, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_4);
    }
  }
  return result_96;
}

function capInBytes_0_I2v1dsn1_nifb6mq6y1(s_119) {
  let result_97;
  let X60Qx_9;
  if ((!(mem.u32((s_119 + 4)) === 0))) {
    let X60Qx_299 = allocatedSize_0_sysvq0asl(mem.u32((s_119 + 4)));
    X60Qx_9 = X60Qx_299;
  } else {
    X60Qx_9 = 0;
  }
  result_97 = X60Qx_9;
  return result_97;
}

function resize_0_Itvf2zj1_nifb6mq6y1(dest_41, addedElements_12) {
  let result_98;
  let X60Qx_300 = capInBytes_0_I2v1dsn1_nifb6mq6y1(dest_41);
  let oldCap_4 = Math.trunc((X60Qx_300 / 4));
  let newCap_4 = recalcCap_0_sysvq0asl(oldCap_4, addedElements_12);
  let memSize_5 = memSizeInBytes_0_Iu5tdzt_nifb6mq6y1(newCap_4);
  let X60Qx_301 = realloc_1_sysvq0asl(mem.u32((dest_41 + 4)), memSize_5);
  mem.setU32((dest_41 + 4), X60Qx_301);
  if ((mem.u32((dest_41 + 4)) === 0)) {
    mem.setI32(dest_41, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_5);
    result_98 = false;
  } else {
    result_98 = true;
  }
  return result_98;
}

function newSeq_0_Ixuxdi21_nifb6mq6y1(size_12) {
  var result_100 = allocFixed(8);
  if ((size_12 === 0)) {
    mem.copy(result_100, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_12);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_6 = memSizeInBytes_0_I4sctiu_nifb6mq6y1(size_12);
    var X60Qx_302 = alloc_1_sysvq0asl(memSize_6);
    mem.copy(result_100, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_12);
      mem.setU32((_o + 4), X60Qx_302);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_100 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_66 = allocFixed(4);
        mem.setI32(i_66, 0);
        {
          while ((mem.i32(i_66) < size_12)) {
            mem.setU32((mem.u32((result_100 + 4)) + (mem.i32(i_66) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_66);
          }
        }
      }
    } else {
      mem.setI32(result_100, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_6);
    }
  }
  return result_100;
}

function capInBytes_0_Ittsk85_nifb6mq6y1(s_120) {
  let result_101;
  let X60Qx_10;
  if ((!(mem.u32((s_120 + 4)) === 0))) {
    let X60Qx_303 = allocatedSize_0_sysvq0asl(mem.u32((s_120 + 4)));
    X60Qx_10 = X60Qx_303;
  } else {
    X60Qx_10 = 0;
  }
  result_101 = X60Qx_10;
  return result_101;
}

function resize_0_Isps98o_nifb6mq6y1(dest_42, addedElements_13) {
  let result_102;
  let X60Qx_304 = capInBytes_0_Ittsk85_nifb6mq6y1(dest_42);
  let oldCap_5 = Math.trunc((X60Qx_304 / 4));
  let newCap_5 = recalcCap_0_sysvq0asl(oldCap_5, addedElements_13);
  let memSize_7 = memSizeInBytes_0_I4sctiu_nifb6mq6y1(newCap_5);
  let X60Qx_305 = realloc_1_sysvq0asl(mem.u32((dest_42 + 4)), memSize_7);
  mem.setU32((dest_42 + 4), X60Qx_305);
  if ((mem.u32((dest_42 + 4)) === 0)) {
    mem.setI32(dest_42, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_7);
    result_102 = false;
  } else {
    result_102 = true;
  }
  return result_102;
}

function memSizeInBytes_0_Iqj0wsf_nifb6mq6y1(size_14) {
  let result_103;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_14, 8);
  result_103 = X60QconstRefTemp_0;
  if (false) {
    result_103 = 2147483647;
  }
  return result_103;
}

function newSeq_0_I4s8fn41_nifb6mq6y1(size_15) {
  var result_104 = allocFixed(8);
  if ((size_15 === 0)) {
    mem.copy(result_104, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_15);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_8 = memSizeInBytes_0_Itq6t0c1_nifb6mq6y1(size_15);
    var X60Qx_306 = alloc_1_sysvq0asl(memSize_8);
    mem.copy(result_104, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_15);
      mem.setU32((_o + 4), X60Qx_306);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_104 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_67 = allocFixed(4);
        mem.setI32(i_67, 0);
        {
          while ((mem.i32(i_67) < size_15)) {
            mem.setU32((mem.u32((result_104 + 4)) + (mem.i32(i_67) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_67);
          }
        }
      }
    } else {
      mem.setI32(result_104, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_8);
    }
  }
  return result_104;
}

function capInBytes_0_I4tsb7_nifb6mq6y1(s_121) {
  let result_105;
  let X60Qx_11;
  if ((!(mem.u32((s_121 + 4)) === 0))) {
    let X60Qx_307 = allocatedSize_0_sysvq0asl(mem.u32((s_121 + 4)));
    X60Qx_11 = X60Qx_307;
  } else {
    X60Qx_11 = 0;
  }
  result_105 = X60Qx_11;
  return result_105;
}

function resize_0_Indszvc_nifb6mq6y1(dest_43, addedElements_14) {
  let result_106;
  let X60Qx_308 = capInBytes_0_I4tsb7_nifb6mq6y1(dest_43);
  let oldCap_6 = Math.trunc((X60Qx_308 / 4));
  let newCap_6 = recalcCap_0_sysvq0asl(oldCap_6, addedElements_14);
  let memSize_9 = memSizeInBytes_0_Itq6t0c1_nifb6mq6y1(newCap_6);
  let X60Qx_309 = realloc_1_sysvq0asl(mem.u32((dest_43 + 4)), memSize_9);
  mem.setU32((dest_43 + 4), X60Qx_309);
  if ((mem.u32((dest_43 + 4)) === 0)) {
    mem.setI32(dest_43, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_9);
    result_106 = false;
  } else {
    result_106 = true;
  }
  return result_106;
}

function memSizeInBytes_0_Iom723i1_nifb6mq6y1(size_17) {
  let result_107;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_17, 8);
  result_107 = X60QconstRefTemp_0;
  if (false) {
    result_107 = 2147483647;
  }
  return result_107;
}

function len_3_Irzg08a_nifb6mq6y1(s_122) {
  let result_108;
  result_108 = mem.i32(s_122);
  return result_108;
}

function newSeq_1_Idmlkik1_nifb6mq6y1(s_123, newLen_40) {
  let X60Qx_310 = allocFixed(8);
  mem.copy(X60Qx_310, newSeq_0_Ielwdyx_nifb6mq6y1(newLen_40), 8);
  mem.copy(s_123, X60Qx_310, 8);
}

function swap_0_Iqoh72v_nifb6mq6y1(x_31, y_11) {
  let tmp_4 = allocFixed(8);
  mem.copy(tmp_4, x_31, 8);
  mem.copy(x_31, y_11, 8);
  mem.copy(y_11, tmp_4, 8);
}

function getQ_7_Iqb93l2_nifb6mq6y1(s_124, i_68) {
  let X60Qx_311;
  if ((i_68 < mem.i32(s_124))) {
    X60Qx_311 = (0 <= i_68);
  } else {
    X60Qx_311 = false;
  }
  if ((!X60Qx_311)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_109;
  result_109 = (mem.u32((s_124 + 4)) + (i_68 * 4));
  return result_109;
}

function move_0_Ipo4xyv_nifb6mq6y1(x_32) {
  let result_110;
  result_110 = mem.u32(x_32);
  return result_110;
}

function shrink_0_I74bzl8_nifb6mq6y1(s_125, newLen_41) {
  whileStmtLabel_0: {
    var i_69 = allocFixed(4);
    mem.setI32(i_69, ((mem.i32(s_125) - 1) | 0));
    {
      while ((newLen_41 <= mem.i32(i_69))) {
        dec_1_I0nzoz91_envto7w6l1(i_69);
      }
    }
  }
  mem.setI32(s_125, newLen_41);
}

function growUnsafe_0_I4lson61_nifb6mq6y1(s_126, newLen_42) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_42, 4);
  let newSize_4 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_312 = capInBytes_0_Iktr4pk_nifb6mq6y1(s_126);
  if ((X60Qx_312 < newSize_4)) {
    let X60Qx_313 = resize_0_Iw4ackb_nifb6mq6y1(s_126, ((newLen_42 - mem.i32(s_126)) | 0));
    if ((!X60Qx_313)) {
      return;
    }
  }
  mem.setI32(s_126, newLen_42);
}

function newSeq_0_Ilpxoqc1_nifb6mq6y1(size_19) {
  var result_111 = allocFixed(8);
  if ((size_19 === 0)) {
    mem.copy(result_111, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_19);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_10 = memSizeInBytes_0_Igp775b_nifb6mq6y1(size_19);
    var X60Qx_314 = alloc_1_sysvq0asl(memSize_10);
    mem.copy(result_111, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_19);
      mem.setU32((_o + 4), X60Qx_314);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_111 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_70 = allocFixed(4);
        mem.setI32(i_70, 0);
        {
          while ((mem.i32(i_70) < size_19)) {
            mem.setU32((mem.u32((result_111 + 4)) + (mem.i32(i_70) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_70);
          }
        }
      }
    } else {
      mem.setI32(result_111, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_10);
    }
  }
  return result_111;
}

function capInBytes_0_Ipcgi0v1_nifb6mq6y1(s_128) {
  let result_112;
  let X60Qx_12;
  if ((!(mem.u32((s_128 + 4)) === 0))) {
    let X60Qx_315 = allocatedSize_0_sysvq0asl(mem.u32((s_128 + 4)));
    X60Qx_12 = X60Qx_315;
  } else {
    X60Qx_12 = 0;
  }
  result_112 = X60Qx_12;
  return result_112;
}

function resize_0_Iuxedyo1_nifb6mq6y1(dest_45, addedElements_16) {
  let result_113;
  let X60Qx_316 = capInBytes_0_Ipcgi0v1_nifb6mq6y1(dest_45);
  let oldCap_7 = Math.trunc((X60Qx_316 / 4));
  let newCap_7 = recalcCap_0_sysvq0asl(oldCap_7, addedElements_16);
  let memSize_11 = memSizeInBytes_0_Igp775b_nifb6mq6y1(newCap_7);
  let X60Qx_317 = realloc_1_sysvq0asl(mem.u32((dest_45 + 4)), memSize_11);
  mem.setU32((dest_45 + 4), X60Qx_317);
  if ((mem.u32((dest_45 + 4)) === 0)) {
    mem.setI32(dest_45, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_11);
    result_113 = false;
  } else {
    result_113 = true;
  }
  return result_113;
}

function memSizeInBytes_0_Iu5tdzt_nifb6mq6y1(size_21) {
  let result_114;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_21, 4);
  result_114 = X60QconstRefTemp_0;
  if (false) {
    result_114 = 2147483647;
  }
  return result_114;
}

function memSizeInBytes_0_I4sctiu_nifb6mq6y1(size_22) {
  let result_115;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_22, 4);
  result_115 = X60QconstRefTemp_0;
  if (false) {
    result_115 = 2147483647;
  }
  return result_115;
}

function memSizeInBytes_0_Itq6t0c1_nifb6mq6y1(size_23) {
  let result_116;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_23, 4);
  result_116 = X60QconstRefTemp_0;
  if (false) {
    result_116 = 2147483647;
  }
  return result_116;
}

function newSeq_0_Ielwdyx_nifb6mq6y1(size_24) {
  var result_117 = allocFixed(8);
  if ((size_24 === 0)) {
    mem.copy(result_117, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_24);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_12 = memSizeInBytes_0_Iidgqw2_nifb6mq6y1(size_24);
    var X60Qx_318 = alloc_1_sysvq0asl(memSize_12);
    mem.copy(result_117, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_24);
      mem.setU32((_o + 4), X60Qx_318);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_117 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_71 = allocFixed(4);
        mem.setI32(i_71, 0);
        {
          while ((mem.i32(i_71) < size_24)) {
            mem.setU32((mem.u32((result_117 + 4)) + (mem.i32(i_71) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_71);
          }
        }
      }
    } else {
      mem.setI32(result_117, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_12);
    }
  }
  return result_117;
}

function capInBytes_0_Iktr4pk_nifb6mq6y1(s_129) {
  let result_118;
  let X60Qx_13;
  if ((!(mem.u32((s_129 + 4)) === 0))) {
    let X60Qx_319 = allocatedSize_0_sysvq0asl(mem.u32((s_129 + 4)));
    X60Qx_13 = X60Qx_319;
  } else {
    X60Qx_13 = 0;
  }
  result_118 = X60Qx_13;
  return result_118;
}

function resize_0_Iw4ackb_nifb6mq6y1(dest_46, addedElements_17) {
  let result_119;
  let X60Qx_320 = capInBytes_0_Iktr4pk_nifb6mq6y1(dest_46);
  let oldCap_8 = Math.trunc((X60Qx_320 / 4));
  let newCap_8 = recalcCap_0_sysvq0asl(oldCap_8, addedElements_17);
  let memSize_13 = memSizeInBytes_0_Iidgqw2_nifb6mq6y1(newCap_8);
  let X60Qx_321 = realloc_1_sysvq0asl(mem.u32((dest_46 + 4)), memSize_13);
  mem.setU32((dest_46 + 4), X60Qx_321);
  if ((mem.u32((dest_46 + 4)) === 0)) {
    mem.setI32(dest_46, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_13);
    result_119 = false;
  } else {
    result_119 = true;
  }
  return result_119;
}

function memSizeInBytes_0_Igp775b_nifb6mq6y1(size_26) {
  let result_120;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_26, 4);
  result_120 = X60QconstRefTemp_0;
  if (false) {
    result_120 = 2147483647;
  }
  return result_120;
}

function memSizeInBytes_0_Iidgqw2_nifb6mq6y1(size_27) {
  let result_121;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_27, 4);
  result_121 = X60QconstRefTemp_0;
  if (false) {
    result_121 = 2147483647;
  }
  return result_121;
}

function eQdestroy_1_In04crl1_nifb6mq6y1(s_154) {
  if ((!(mem.u32((s_154 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_80 = allocFixed(4);
      mem.setI32(i_80, 0);
      {
        while ((mem.i32(i_80) < mem.i32(s_154))) {
          inc_1_I6wjjge_cmdqs323n1(i_80);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_154 + 4)));
  }
}

function eQwasMoved_1_I94uyip1_nifb6mq6y1(s_155) {
  mem.setI32(s_155, 0);
  mem.setU32((s_155 + 4), 0);
}

function eQdestroy_1_Iez2nr5_nifb6mq6y1(s_156) {
  if ((!(mem.u32((s_156 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_84 = allocFixed(4);
      mem.setI32(i_84, 0);
      {
        while ((mem.i32(i_84) < mem.i32(s_156))) {
          inc_1_I6wjjge_cmdqs323n1(i_84);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_156 + 4)));
  }
}

function eQwasMoved_1_Ia0kll01_nifb6mq6y1(s_157) {
  mem.setI32(s_157, 0);
  mem.setU32((s_157 + 4), 0);
}

function eQdestroy_1_Inr6ycs1_nifb6mq6y1(s_158) {
  if ((!(mem.u32((s_158 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_88 = allocFixed(4);
      mem.setI32(i_88, 0);
      {
        while ((mem.i32(i_88) < mem.i32(s_158))) {
          inc_1_I6wjjge_cmdqs323n1(i_88);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_158 + 4)));
  }
}

function eQwasMoved_1_I5re2ul_nifb6mq6y1(s_159) {
  mem.setI32(s_159, 0);
  mem.setU32((s_159 + 4), 0);
}

function eQdestroy_1_Ic8bbvt1_nifb6mq6y1(s_160) {
  if ((!(mem.u32((s_160 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_92 = allocFixed(4);
      mem.setI32(i_92, 0);
      {
        while ((mem.i32(i_92) < mem.i32(s_160))) {
          inc_1_I6wjjge_cmdqs323n1(i_92);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_160 + 4)));
  }
}

function eQwasMoved_1_I6m9e8j_nifb6mq6y1(s_161) {
  mem.setI32(s_161, 0);
  mem.setU32((s_161 + 4), 0);
}

function eQdestroy_1_I7og8li_nifb6mq6y1(s_162) {
  if ((!(mem.u32((s_162 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_96 = allocFixed(4);
      mem.setI32(i_96, 0);
      {
        while ((mem.i32(i_96) < mem.i32(s_162))) {
          inc_1_I6wjjge_cmdqs323n1(i_96);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_162 + 4)));
  }
}

function eQwasMoved_1_I52bdqo1_nifb6mq6y1(s_163) {
  mem.setI32(s_163, 0);
  mem.setU32((s_163 + 4), 0);
}

function eQdestroy_1_Iz0k69p1_nifb6mq6y1(s_164) {
  if ((!(mem.u32((s_164 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_100 = allocFixed(4);
      mem.setI32(i_100, 0);
      {
        while ((mem.i32(i_100) < mem.i32(s_164))) {
          inc_1_I6wjjge_cmdqs323n1(i_100);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_164 + 4)));
  }
}

function eQwasMoved_1_I5y4iq9_nifb6mq6y1(s_165) {
  mem.setI32(s_165, 0);
  mem.setU32((s_165 + 4), 0);
}

function eQdestroy_1_I5fjqyi1_nifb6mq6y1(s_166) {
  if ((!(mem.u32((s_166 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_104 = allocFixed(4);
      mem.setI32(i_104, 0);
      {
        while ((mem.i32(i_104) < mem.i32(s_166))) {
          inc_1_I6wjjge_cmdqs323n1(i_104);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_166 + 4)));
  }
}

function eQwasMoved_1_Iew8iz1_nifb6mq6y1(s_167) {
  mem.setI32(s_167, 0);
  mem.setU32((s_167 + 4), 0);
}

function eQdestroy_1_I35tn0j_nifb6mq6y1(s_168) {
  if ((!(mem.u32((s_168 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_108 = allocFixed(4);
      mem.setI32(i_108, 0);
      {
        while ((mem.i32(i_108) < mem.i32(s_168))) {
          inc_1_I6wjjge_cmdqs323n1(i_108);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_168 + 4)));
  }
}

function eQwasMoved_1_Igz5mgz_nifb6mq6y1(s_169) {
  mem.setI32(s_169, 0);
  mem.setU32((s_169 + 4), 0);
}

function newSeqUninit_0_In7hr9h_nifb6mq6y1(size_41) {
  let result_134 = allocFixed(8);
  if ((size_41 === 0)) {
    mem.copy(result_134, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_41);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_26 = memSizeInBytes_0_Iu5tdzt_nifb6mq6y1(size_41);
    let X60Qx_368 = alloc_1_sysvq0asl(memSize_26);
    mem.copy(result_134, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_41);
      mem.setU32((_o + 4), X60Qx_368);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_134 + 4)) === 0))) {
      let X60Qx_369 = allocFixed(8);
      mem.setU32(X60Qx_369, 1634036990);
      mem.setU32((X60Qx_369 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_134, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_26);
    }
  }
  return result_134;
}

function newSeqUninit_0_I7whkjh1_nifb6mq6y1(size_42) {
  let result_135 = allocFixed(8);
  if ((size_42 === 0)) {
    mem.copy(result_135, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_42);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_27 = memSizeInBytes_0_Iqj0wsf_nifb6mq6y1(size_42);
    let X60Qx_370 = alloc_1_sysvq0asl(memSize_27);
    mem.copy(result_135, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_42);
      mem.setU32((_o + 4), X60Qx_370);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_135 + 4)) === 0))) {
      let X60Qx_371 = allocFixed(8);
      mem.setU32(X60Qx_371, 1634036990);
      mem.setU32((X60Qx_371 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_135, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_27);
    }
  }
  return result_135;
}

function newSeqUninit_0_Isaraw1_nifb6mq6y1(size_43) {
  let result_136 = allocFixed(8);
  if ((size_43 === 0)) {
    mem.copy(result_136, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_43);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_28 = memSizeInBytes_0_I4sctiu_nifb6mq6y1(size_43);
    let X60Qx_372 = alloc_1_sysvq0asl(memSize_28);
    mem.copy(result_136, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_43);
      mem.setU32((_o + 4), X60Qx_372);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_136 + 4)) === 0))) {
      let X60Qx_373 = allocFixed(8);
      mem.setU32(X60Qx_373, 1634036990);
      mem.setU32((X60Qx_373 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_136, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_28);
    }
  }
  return result_136;
}

function newSeqUninit_0_Igtmzv6_nifb6mq6y1(size_44) {
  let result_137 = allocFixed(8);
  if ((size_44 === 0)) {
    mem.copy(result_137, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_44);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_29 = memSizeInBytes_0_Iom723i1_nifb6mq6y1(size_44);
    let X60Qx_374 = alloc_1_sysvq0asl(memSize_29);
    mem.copy(result_137, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_44);
      mem.setU32((_o + 4), X60Qx_374);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_137 + 4)) === 0))) {
      let X60Qx_375 = allocFixed(8);
      mem.setU32(X60Qx_375, 1634036990);
      mem.setU32((X60Qx_375 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_137, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_29);
    }
  }
  return result_137;
}

function newSeqUninit_0_I8tb1fi1_nifb6mq6y1(size_45) {
  let result_138 = allocFixed(8);
  if ((size_45 === 0)) {
    mem.copy(result_138, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_45);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_30 = memSizeInBytes_0_Itq6t0c1_nifb6mq6y1(size_45);
    let X60Qx_376 = alloc_1_sysvq0asl(memSize_30);
    mem.copy(result_138, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_45);
      mem.setU32((_o + 4), X60Qx_376);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_138 + 4)) === 0))) {
      let X60Qx_377 = allocFixed(8);
      mem.setU32(X60Qx_377, 1634036990);
      mem.setU32((X60Qx_377 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_138, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_30);
    }
  }
  return result_138;
}

function newSeqUninit_0_Ivz95ii_nifb6mq6y1(size_46) {
  let result_139 = allocFixed(8);
  if ((size_46 === 0)) {
    mem.copy(result_139, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_46);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_31 = memSizeInBytes_0_Iidgqw2_nifb6mq6y1(size_46);
    let X60Qx_378 = alloc_1_sysvq0asl(memSize_31);
    mem.copy(result_139, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_46);
      mem.setU32((_o + 4), X60Qx_378);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_139 + 4)) === 0))) {
      let X60Qx_379 = allocFixed(8);
      mem.setU32(X60Qx_379, 1634036990);
      mem.setU32((X60Qx_379 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_139, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_31);
    }
  }
  return result_139;
}

function newSeqUninit_0_Ikst8ta1_nifb6mq6y1(size_47) {
  let result_140 = allocFixed(8);
  if ((size_47 === 0)) {
    mem.copy(result_140, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_47);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_32 = memSizeInBytes_0_Igp775b_nifb6mq6y1(size_47);
    let X60Qx_380 = alloc_1_sysvq0asl(memSize_32);
    mem.copy(result_140, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_47);
      mem.setU32((_o + 4), X60Qx_380);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_140 + 4)) === 0))) {
      let X60Qx_381 = allocFixed(8);
      mem.setU32(X60Qx_381, 1634036990);
      mem.setU32((X60Qx_381 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_140, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_32);
    }
  }
  return result_140;
}

function newSeqUninit_0_Ijkckzz_nifb6mq6y1(size_48) {
  let result_141 = allocFixed(8);
  if ((size_48 === 0)) {
    mem.copy(result_141, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_48);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_33 = memSizeInBytes_0_Isupifd_nifb6mq6y1(size_48);
    let X60Qx_382 = alloc_1_sysvq0asl(memSize_33);
    mem.copy(result_141, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_48);
      mem.setU32((_o + 4), X60Qx_382);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_141 + 4)) === 0))) {
      let X60Qx_383 = allocFixed(8);
      mem.setU32(X60Qx_383, 1634036990);
      mem.setU32((X60Qx_383 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_141, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_33);
    }
  }
  return result_141;
}

function capInBytes_0_Id76iiw1_nifb6mq6y1(s_171) {
  let result_142;
  let X60Qx_14;
  if ((!(mem.u32((s_171 + 4)) === 0))) {
    let X60Qx_384 = allocatedSize_0_sysvq0asl(mem.u32((s_171 + 4)));
    X60Qx_14 = X60Qx_384;
  } else {
    X60Qx_14 = 0;
  }
  result_142 = X60Qx_14;
  return result_142;
}

function memSizeInBytes_0_Isupifd_nifb6mq6y1(size_49) {
  let result_143;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_49, 4);
  result_143 = X60QconstRefTemp_0;
  if (false) {
    result_143 = 2147483647;
  }
  return result_143;
}

let X60QiniGuard_0_nifb6mq6y1 = allocFixed(1);

function X60Qini_0_nifb6mq6y1() {
  if (mem.u8At(X60QiniGuard_0_nifb6mq6y1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_nifb6mq6y1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_nif81dubp1();
  X60Qini_0_nifh7u8pu1();
  X60Qini_0_bitekkhcx1();
  X60Qini_0_linxafkvx1();
  X60Qini_0_vfsc9jn7();
  let X60Qx_16 = allocFixed(8);
  mem.copy(X60Qx_16, parLeToken_0_nifh7u8pu1(ErrT_0_nifh7u8pu1, NoLineInfo_0_linxafkvx1), 8);
  let X60Qx_17 = allocFixed(8);
  mem.copy(X60Qx_17, parRiToken_0_nifh7u8pu1(NoLineInfo_0_linxafkvx1), 8);
  mem.copy(ErrToken_0_nifb6mq6y1, (() => {
    let _a = allocFixed(16);
    mem.copy(_a, X60Qx_16, 8);
    mem.copy((_a + 8), X60Qx_17, 8);
    return _a;
  })(), 16);
}
// generated by lengc (js backend) from dir38pj6l.c.nif

let X60QiniGuard_0_dir38pj6l = allocFixed(1);

function X60Qini_0_dir38pj6l() {
  if (mem.u8At(X60QiniGuard_0_dir38pj6l)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_dir38pj6l, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_osezuyu63();
  X60Qini_0_pat4k2dls();
  X60Qini_0_ossk30t39();
  X60Qini_0_osc4bsu0d1();
  X60Qini_0_pososrh1q1();
  X60Qini_0_err0o7h081();
}
// generated by lengc (js backend) from osezuyu63.c.nif

let X60QiniGuard_0_osezuyu63 = allocFixed(1);

function X60Qini_0_osezuyu63() {
  if (mem.u8At(X60QiniGuard_0_osezuyu63)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_osezuyu63, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_err0o7h081();
}
// generated by lengc (js backend) from str7j0ifg.c.nif

function startsWith_0_str7j0ifg(s_21, prefix_1) {
  let result_21;
  let X60Qx_106 = allocFixed(8);
  mem.setU32(X60Qx_106, 1852271102);
  mem.setU32((X60Qx_106 + 4), strlit_0_I8031254106179394417_dir38pj6l);
  let X60Qx_107 = startsWithImpl_0_sysvq0asl(s_21, prefix_1);
  result_21 = X60Qx_107;
  return result_21;
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
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_60);
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
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_66);
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
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_69);
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
                dec_1_I0nzoz91_envto7w6l1(i_17);
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
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_68;
  result_68 = (mem.u32(x_40) + (idx_9 * 4));
  return result_68;
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
// generated by lengc (js backend) from envto7w6l1.c.nif

let environment_0_envto7w6l1 = allocFixed(8);

function getQ_7_Ir6d0tw_envto7w6l1(s_7, i_9) {
  let X60Qx_27;
  if ((i_9 < mem.i32(s_7))) {
    X60Qx_27 = (0 <= i_9);
  } else {
    X60Qx_27 = false;
  }
  if ((!X60Qx_27)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_5;
  result_5 = (mem.u32((s_7 + 4)) + (i_9 * 8));
  return result_5;
}

function len_3_Ixq6taz_envto7w6l1(s_12) {
  let result_9;
  result_9 = mem.i32(s_12);
  return result_9;
}

function shrink_0_Iiotmvc_envto7w6l1(s_13, newLen_1) {
  whileStmtLabel_0: {
    var i_12 = allocFixed(4);
    mem.setI32(i_12, ((mem.i32(s_13) - 1) | 0));
    {
      while ((newLen_1 <= mem.i32(i_12))) {
        nimStrDestroy((mem.u32((s_13 + 4)) + (mem.i32(i_12) * 8)));
        dec_1_I0nzoz91_envto7w6l1(i_12);
      }
    }
  }
  mem.setI32(s_13, newLen_1);
}

function dec_1_I0nzoz91_envto7w6l1(x_8) {
  mem.setI32(x_8, ((mem.i32(x_8) - 1) | 0));
}

let X60QiniGuard_0_envto7w6l1 = allocFixed(1);

function X60Qini_0_envto7w6l1() {
  if (mem.u8At(X60QiniGuard_0_envto7w6l1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_envto7w6l1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_osezuyu63();
  eQwasMoved_1_I5vdnla_cmdqs323n1(environment_0_envto7w6l1);
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
// generated by lengc (js backend) from patta6rli.c.nif

let X60QiniGuard_0_patta6rli = allocFixed(1);

function X60Qini_0_patta6rli() {
  if (mem.u8At(X60QiniGuard_0_patta6rli)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_patta6rli, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_ossk30t39();
}
// generated by lengc (js backend) from tagygirdh1.c.nif

let X60QiniGuard_0_tagygirdh1 = allocFixed(1);

function X60Qini_0_tagygirdh1() {
  if (mem.u8At(X60QiniGuard_0_tagygirdh1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_tagygirdh1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from memlzdyby.c.nif

let X60QiniGuard_0_memlzdyby = allocFixed(1);

function X60Qini_0_memlzdyby() {
  if (mem.u8At(X60QiniGuard_0_memlzdyby)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_memlzdyby, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_osezuyu63();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from nifh7u8pu1.c.nif

function parRiToken_0_nifh7u8pu1(info_2) {
  let result_3 = allocFixed(8);
  mem.copy(result_3, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((12 | ((0 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_2);
    return _o;
  })(), 8);
  return result_3;
}

function createLiterals_0_nifh7u8pu1(data_0) {
  forStmtLabel_0: {
    var result_17 = allocFixed(120);
    eQwasmovedQ_SX4citerals0nifh7u8pu1_0_nifh7u8pu1(result_17);
    eQdestroyQ_SX4citerals0nifh7u8pu1_0_nifh7u8pu1(result_17);
    var X60Qx_26 = allocFixed(8);
    mem.copy(X60Qx_26, newSeqUninit_0_Izs0ei1_linxafkvx1(0), 8);
    var X60Qx_27 = allocFixed(8);
    mem.copy(X60Qx_27, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
    var X60Qx_28 = allocFixed(8);
    mem.copy(X60Qx_28, newSeqUninit_0_Ikst8ta1_nifb6mq6y1(0), 8);
    var X60Qx_29 = allocFixed(8);
    mem.copy(X60Qx_29, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
    var X60Qx_30 = allocFixed(8);
    mem.copy(X60Qx_30, newSeqUninit_0_Il1doiw_nifh7u8pu1(0), 8);
    var X60Qx_31 = allocFixed(8);
    mem.copy(X60Qx_31, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
    var X60Qx_32 = allocFixed(8);
    mem.copy(X60Qx_32, newSeqUninit_0_Ieodq4s1_nifh7u8pu1(0), 8);
    var X60Qx_33 = allocFixed(8);
    mem.copy(X60Qx_33, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
    var X60Qx_34 = allocFixed(8);
    mem.copy(X60Qx_34, newSeqUninit_0_In7hr9h_nifb6mq6y1(0), 8);
    var X60Qx_35 = allocFixed(8);
    mem.copy(X60Qx_35, newSeqUninit_0_I7whkjh1_nifb6mq6y1(0), 8);
    var X60Qx_36 = allocFixed(8);
    mem.copy(X60Qx_36, newSeqUninit_0_Isaraw1_nifb6mq6y1(0), 8);
    var X60Qx_37 = allocFixed(8);
    mem.copy(X60Qx_37, newSeqUninit_0_Igtmzv6_nifb6mq6y1(0), 8);
    var X60Qx_38 = allocFixed(8);
    mem.copy(X60Qx_38, newSeqUninit_0_I8tb1fi1_nifb6mq6y1(0), 8);
    var X60Qx_39 = allocFixed(8);
    mem.copy(X60Qx_39, newSeqUninit_0_Igtmzv6_nifb6mq6y1(0), 8);
    var X60Qx_40 = allocFixed(8);
    mem.copy(X60Qx_40, newSeqUninit_0_Ivz95ii_nifb6mq6y1(0), 8);
    mem.copy(result_17, (() => {
      var _o = allocFixed(120);
      mem.copy(_o, (() => {
        var _o = allocFixed(8);
        mem.copy(_o, X60Qx_26, 8);
        return _o;
      })(), 8);
      mem.copy((_o + 8), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_27, 8);
        mem.copy((_o + 8), X60Qx_28, 8);
        return _o;
      })(), 16);
      mem.copy((_o + 24), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_29, 8);
        mem.copy((_o + 8), X60Qx_30, 8);
        return _o;
      })(), 16);
      mem.copy((_o + 40), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_31, 8);
        mem.copy((_o + 8), X60Qx_32, 8);
        return _o;
      })(), 16);
      mem.copy((_o + 56), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_33, 8);
        mem.copy((_o + 8), X60Qx_34, 8);
        return _o;
      })(), 16);
      mem.copy((_o + 72), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_35, 8);
        mem.copy((_o + 8), X60Qx_36, 8);
        return _o;
      })(), 16);
      mem.copy((_o + 88), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_37, 8);
        mem.copy((_o + 8), X60Qx_38, 8);
        return _o;
      })(), 16);
      mem.copy((_o + 104), (() => {
        var _o = allocFixed(16);
        mem.copy(_o, X60Qx_39, 8);
        mem.copy((_o + 8), X60Qx_40, 8);
        return _o;
      })(), 16);
      return _o;
    })(), 120);
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = 1;
        var X60Qlf_1 = len_6_I5j2qim1_nifh7u8pu1(data_0);
        var X60Qlf_2 = allocFixed(4);
        mem.setI32(X60Qlf_2, X60Qlf_0);
        {
          while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
            {
              var X60Qx_41 = getQ_10_Ieolp4z_nifh7u8pu1(data_0, mem.i32(X60Qlf_2));
              var X60Qii_2 = getOrIncl_0_Is83dq9_nifb6mq6y1((result_17 + 8), X60Qx_41);
              var X60Qx_42 = getQ_10_Ieolp4z_nifh7u8pu1(data_0, mem.i32(X60Qlf_2));
              if ((!(X60Qii_2 === mem.i32((X60Qx_42 + 8))))) {
                write_0_syn1lfpjv(stdout, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1933663230);
                  mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
                  return _o;
                })());
                write_0_syn1lfpjv(stdout, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 0);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                write_7_syn1lfpjv(stdout, 10);
                quit_0_syn1lfpjv(1);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_2);
          }
        }
      }
    }
  }
  return result_17;
}

let pool_0_nifh7u8pu1 = allocFixed(120);

function parLeToken_0_nifh7u8pu1(t_0, info_9) {
  let result_22 = allocFixed(8);
  let X60Qx_48 = allocFixed(8);
  mem.copy(X60Qx_48, toToken_0_Iz0lv7d1_nifh7u8pu1(11, t_0, info_9), 8);
  mem.copy(result_22, X60Qx_48, 8);
  return result_22;
}

function openFromBuffer_0_nifh7u8pu1(buf_0, thisModule_0) {
  let result_32 = allocFixed(108);
  eQwasmovedQ_SX53tream0nifh7u8pu1_0_nifh7u8pu1(result_32);
  eQdestroyQ_SX53tream0nifh7u8pu1_0_nifh7u8pu1(result_32);
  let X60Qtmp_3 = allocFixed(8);
  mem.copy(X60Qtmp_3, buf_0, 8);
  nimStrWasMoved(buf_0);
  let X60Qtmp_4 = allocFixed(8);
  mem.copy(X60Qtmp_4, thisModule_0, 8);
  nimStrWasMoved(thisModule_0);
  let X60Qx_18 = allocFixed(100);
  mem.copy(X60Qx_18, openFromBuffer_0_nif81dubp1(X60Qtmp_3, X60Qtmp_4), 100);
  let X60Qx_19 = allocFixed(8);
  mem.copy(X60Qx_19, newSeqUninit_0_Ijkckzz_nifb6mq6y1(0), 8);
  mem.copy(result_32, (() => {
    let _o = allocFixed(108);
    mem.copy(_o, X60Qx_18, 100);
    mem.copy((_o + 100), X60Qx_19, 8);
    return _o;
  })(), 108);
  add_0_I6yw3841_nifh7u8pu1((result_32 + 100), NoLineInfo_0_linxafkvx1);
  nimStrDestroy(thisModule_0);
  nimStrDestroy(buf_0);
  return result_32;
  nimStrDestroy(thisModule_0);
  nimStrDestroy(buf_0);
  return result_32;
}

function close_0_nifh7u8pu1(s_3) {
  close_0_nif81dubp1(s_3);
}

function rawNext_0_nifh7u8pu1(s_4, t_3) {
  let result_33 = allocFixed(8);
  let currentInfo_0 = NoLineInfo_0_linxafkvx1;
  let X60Qx_0;
  if ((mem.i32(((t_3 + 28) + 4)) === 0)) {
    X60Qx_0 = 0;
  } else {
    let X60Qtmp_5 = allocFixed(8);
    mem.copy(X60Qtmp_5, decodeComment_0_nif81dubp1(t_3), 8);
    let X60Qx_59 = getOrIncl_0_Ix6biej1_nifb6mq6y1((pool_0_nifh7u8pu1 + 56), X60Qtmp_5);
    X60Qx_0 = X60Qx_59;
    nimStrDestroy(X60Qtmp_5);
  }
  let commentId_0 = X60Qx_0;
  if ((mem.i32(((t_3 + 20) + 4)) === 0)) {
    let X60Qx_60;
    let X60Qx_61;
    if ((!(mem.i32(((t_3 + 12) + 4)) === 0))) {
      X60Qx_61 = true;
    } else {
      X60Qx_61 = (!(mem.i32((t_3 + 12)) === 0));
    }
    if (X60Qx_61) {
      X60Qx_60 = true;
    } else {
      X60Qx_60 = (!(commentId_0 === 0));
    }
    if (X60Qx_60) {
      let X60Qx_62 = getQ_7_I4w3aqj1_nifh7u8pu1((s_4 + 100), ((mem.i32((s_4 + 100)) - 1) | 0));
      let rawInfo_0 = allocFixed(16);
      mem.copy(rawInfo_0, unpack_0_linxafkvx1(pool_0_nifh7u8pu1, mem.u32(X60Qx_62)), 16);
      let X60Qx_63 = packWithComment_0_linxafkvx1(pool_0_nifh7u8pu1, mem.u32(rawInfo_0), ((mem.i32((rawInfo_0 + 4)) + mem.i32(((t_3 + 12) + 4))) | 0), ((mem.i32((rawInfo_0 + 8)) + mem.i32((t_3 + 12))) | 0), commentId_0);
      currentInfo_0 = X60Qx_63;
    } else {
      let X60Qx_64 = getQ_7_I4w3aqj1_nifh7u8pu1((s_4 + 100), ((mem.i32((s_4 + 100)) - 1) | 0));
      currentInfo_0 = mem.u32(X60Qx_64);
    }
  } else {
    let X60Qtmp_6 = allocFixed(8);
    mem.copy(X60Qtmp_6, decodeFilename_0_nif81dubp1(t_3), 8);
    let fileId_0 = getOrIncl_0_Iaj0qm3_nifh7u8pu1((pool_0_nifh7u8pu1 + 24), X60Qtmp_6);
    let X60Qx_65 = packWithComment_0_linxafkvx1(pool_0_nifh7u8pu1, fileId_0, mem.i32(((t_3 + 12) + 4)), mem.i32((t_3 + 12)), commentId_0);
    currentInfo_0 = X60Qx_65;
    nimStrDestroy(X60Qtmp_6);
  }
  switch (mem.u8At(t_3)) {
    case 12:
      {
        let X60Qx_66 = allocFixed(8);
        mem.copy(X60Qx_66, toToken_0_Ie5j2hb_nifh7u8pu1(mem.u8At(t_3), 0, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_66, 8);
        if ((1 < mem.i32((s_4 + 100)))) {
          let X60Qx_67 = pop_0_I608lbn1_nifh7u8pu1((s_4 + 100));
        }
      }
      break;
    case 1:
    case 0:
    case 2:
      {
        let X60Qx_68 = allocFixed(8);
        mem.copy(X60Qx_68, toToken_0_Ie5j2hb_nifh7u8pu1(mem.u8At(t_3), 0, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_68, 8);
      }
      break;
    case 11:
      {
        let ka_0 = getOrInclFromView_0_Iledlgq1_nifh7u8pu1((pool_0_nifh7u8pu1 + 8), (t_3 + 4));
        let X60Qx_69 = allocFixed(8);
        mem.copy(X60Qx_69, toToken_0_Iz0lv7d1_nifh7u8pu1(11, ka_0, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_69, 8);
        let X60Qx_70 = stripComment_0_linxafkvx1(pool_0_nifh7u8pu1, currentInfo_0);
        add_0_I6yw3841_nifh7u8pu1((s_4 + 100), X60Qx_70);
      }
      break;
    case 3:
    case 6:
      {
        let X60Qtmp_7 = allocFixed(8);
        mem.copy(X60Qtmp_7, decodeStr_0_nif81dubp1(s_4, t_3), 8);
        let X60Qx_71 = getOrIncl_0_Ix6biej1_nifb6mq6y1((pool_0_nifh7u8pu1 + 56), X60Qtmp_7);
        let X60Qx_72 = allocFixed(8);
        mem.copy(X60Qx_72, toToken_0_Ika21pk_nifh7u8pu1(mem.u8At(t_3), X60Qx_71, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_72, 8);
        nimStrDestroy(X60Qtmp_7);
      }
      break;
    case 4:
    case 5:
      {
        let X60Qtmp_8 = allocFixed(8);
        mem.copy(X60Qtmp_8, decodeStr_0_nif81dubp1(s_4, t_3), 8);
        let X60Qx_73 = getOrIncl_0_Inyo00c_nifh7u8pu1((pool_0_nifh7u8pu1 + 40), X60Qtmp_8);
        let X60Qx_74 = allocFixed(8);
        mem.copy(X60Qx_74, toToken_0_Iip05tk1_nifh7u8pu1(mem.u8At(t_3), X60Qx_73, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_74, 8);
        nimStrDestroy(X60Qtmp_8);
      }
      break;
    case 7:
      {
        let X60Qx_75 = decodeChar_0_nif81dubp1(t_3);
        let X60Qx_76 = allocFixed(8);
        mem.copy(X60Qx_76, toToken_0_Ie5j2hb_nifh7u8pu1(7, X60Qx_75, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_76, 8);
      }
      break;
    case 8:
      {
        let X60Qx_77 = decodeInt_0_nif81dubp1(t_3);
        let X60Qx_78 = getOrIncl_0_I4rntkc_nifb6mq6y1((pool_0_nifh7u8pu1 + 72), X60Qx_77);
        let X60Qx_79 = allocFixed(8);
        mem.copy(X60Qx_79, toToken_0_Is7quwk1_nifh7u8pu1(8, X60Qx_78, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_79, 8);
      }
      break;
    case 9:
      {
        let X60Qx_80 = decodeUInt_0_nif81dubp1(t_3);
        let X60Qx_81 = getOrIncl_0_Icm7gb1_nifb6mq6y1((pool_0_nifh7u8pu1 + 88), X60Qx_80);
        let X60Qx_82 = allocFixed(8);
        mem.copy(X60Qx_82, toToken_0_Ikm2gt2_nifh7u8pu1(9, X60Qx_81, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_82, 8);
      }
      break;
    case 10:
      {
        let X60Qx_83 = decodeFloat_0_nif81dubp1(t_3);
        let X60Qx_84 = getOrIncl_1_Ijmj1s_nifb6mq6y1((pool_0_nifh7u8pu1 + 104), X60Qx_83);
        let X60Qx_85 = allocFixed(8);
        mem.copy(X60Qx_85, toToken_0_Ifgbqjw1_nifh7u8pu1(10, X60Qx_84, currentInfo_0), 8);
        mem.copy(result_33, X60Qx_85, 8);
      }
      break;
  }
  return result_33;
}

function next_0_nifh7u8pu1(s_5) {
  let result_34 = allocFixed(8);
  let t_13 = allocFixed(36);
  mem.setU8(t_13, 0);
  mem.setU8((t_13 + 1), 0);
  mem.setU16((t_13 + 2), 0);
  mem.copy((t_13 + 4), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setI32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.copy((t_13 + 12), (() => {
    let _o = allocFixed(8);
    mem.setI32(_o, 0);
    mem.setI32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.copy((t_13 + 20), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setI32((_o + 4), 0);
    return _o;
  })(), 8);
  mem.copy((t_13 + 28), (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setI32((_o + 4), 0);
    return _o;
  })(), 8);
  next_0_nif81dubp1(s_5, t_13);
  let X60Qx_86 = allocFixed(8);
  mem.copy(X60Qx_86, rawNext_0_nifh7u8pu1(s_5, t_13), 8);
  mem.copy(result_34, X60Qx_86, 8);
  return result_34;
}

function litId_0_nifh7u8pu1(n_9) {
  let result_36;
  let X60Qdesugar_0 = 72;
  let X60Qdesugar_1 = (((mem.u32(n_9) & 15) >>> 0) & 255);
  if ((!(((X60Qdesugar_0 & (((1 & 65535) << ((X60Qdesugar_1 & 15) >>> 0)) >>> 0)) >>> 0) !== 0))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  result_36 = (mem.u32(n_9) >>> 4);
  return result_36;
}

function symId_0_nifh7u8pu1(n_11) {
  let result_38;
  let X60Qdesugar_2 = 48;
  let X60Qdesugar_3 = (((mem.u32(n_11) & 15) >>> 0) & 255);
  if ((!(((X60Qdesugar_2 & (((1 & 65535) << ((X60Qdesugar_3 & 15) >>> 0)) >>> 0)) >>> 0) !== 0))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  result_38 = (mem.u32(n_11) >>> 4);
  return result_38;
}

function tagId_0_nifh7u8pu1(n_15) {
  let result_42;
  if ((!((((mem.u32(n_15) & 15) >>> 0) & 255) === 11))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    let X60Qtmp_9 = allocFixed(8);
    mem.copy(X60Qtmp_9, dollarX60Q_NifKind_0_nif81dubp1((((mem.u32(n_15) & 15) >>> 0) & 255)), 8);
    write_0_syn1lfpjv(stdout, X60Qtmp_9);
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
    nimStrDestroy(X60Qtmp_9);
  }
  result_42 = (mem.u32(n_15) >>> 4);
  return result_42;
}

function newSeqUninit_0_Il1doiw_nifh7u8pu1(size_18) {
  let result_50 = allocFixed(8);
  if ((size_18 === 0)) {
    mem.copy(result_50, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_18);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_3 = memSizeInBytes_0_Ib1bjtc_nifh7u8pu1(size_18);
    let X60Qx_186 = alloc_1_sysvq0asl(memSize_3);
    mem.copy(result_50, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_18);
      mem.setU32((_o + 4), X60Qx_186);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_50 + 4)) === 0))) {
      let X60Qx_187 = allocFixed(8);
      mem.setU32(X60Qx_187, 1634036990);
      mem.setU32((X60Qx_187 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_50, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_3);
    }
  }
  return result_50;
}

function newSeqUninit_0_Ieodq4s1_nifh7u8pu1(size_20) {
  let result_51 = allocFixed(8);
  if ((size_20 === 0)) {
    mem.copy(result_51, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_20);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_4 = memSizeInBytes_0_Ivqzo5x1_nifh7u8pu1(size_20);
    let X60Qx_188 = alloc_1_sysvq0asl(memSize_4);
    mem.copy(result_51, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_20);
      mem.setU32((_o + 4), X60Qx_188);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_51 + 4)) === 0))) {
      let X60Qx_189 = allocFixed(8);
      mem.setU32(X60Qx_189, 1634036990);
      mem.setU32((X60Qx_189 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_51, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_4);
    }
  }
  return result_51;
}

function len_6_I5j2qim1_nifh7u8pu1(a_9) {
  let result_58;
  result_58 = mem.i32((a_9 + 4));
  return result_58;
}

function getQ_10_Ieolp4z_nifh7u8pu1(x_11, idx_2) {
  let X60Qx_202;
  if ((0 <= idx_2)) {
    X60Qx_202 = (idx_2 < mem.i32((x_11 + 4)));
  } else {
    X60Qx_202 = false;
  }
  if ((!X60Qx_202)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_59;
  result_59 = (mem.u32(x_11) + (idx_2 * 12));
  return result_59;
}

function toOpenArray_0_Isa0kxh_nifh7u8pu1(x_12) {
  let result_61 = allocFixed(8);
  let X60Qx_4 = allocFixed(8);
  if (((((((341 & 65535) - (0 & 65535)) | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_4, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_4, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_12);
      mem.setI32((_o + 4), (((((341 & 65535) - (0 & 65535)) | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_61, X60Qx_4, 8);
  return result_61;
}

function toToken_0_Ika21pk_nifh7u8pu1(kind_9, id_13, info_28) {
  let result_62 = allocFixed(8);
  mem.copy(result_62, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_9 | ((id_13 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_28);
    return _o;
  })(), 8);
  return result_62;
}

function toToken_0_Iip05tk1_nifh7u8pu1(kind_10, id_14, info_29) {
  let result_63 = allocFixed(8);
  mem.copy(result_63, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_10 | ((id_14 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_29);
    return _o;
  })(), 8);
  return result_63;
}

function toToken_0_Ie5j2hb_nifh7u8pu1(kind_11, id_15, info_30) {
  let result_64 = allocFixed(8);
  mem.copy(result_64, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_11 | ((id_15 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_30);
    return _o;
  })(), 8);
  return result_64;
}

function toToken_0_Iz0lv7d1_nifh7u8pu1(kind_12, id_16, info_31) {
  let result_65 = allocFixed(8);
  mem.copy(result_65, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_12 | ((id_16 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_31);
    return _o;
  })(), 8);
  return result_65;
}

function toToken_0_Is7quwk1_nifh7u8pu1(kind_13, id_17, info_32) {
  let result_66 = allocFixed(8);
  mem.copy(result_66, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_13 | ((id_17 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_32);
    return _o;
  })(), 8);
  return result_66;
}

function toToken_0_Ikm2gt2_nifh7u8pu1(kind_14, id_18, info_33) {
  let result_67 = allocFixed(8);
  mem.copy(result_67, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_14 | ((id_18 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_33);
    return _o;
  })(), 8);
  return result_67;
}

function toToken_0_Ifgbqjw1_nifh7u8pu1(kind_15, id_19, info_34) {
  let result_68 = allocFixed(8);
  mem.copy(result_68, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, ((kind_15 | ((id_19 << 4) >>> 0)) >>> 0));
    mem.setU32((_o + 4), info_34);
    return _o;
  })(), 8);
  return result_68;
}

function add_0_I6yw3841_nifh7u8pu1(s_17, elem_3) {
  let L_0 = mem.i32(s_17);
  let X60Qx_219 = capInBytes_0_Id76iiw1_nifb6mq6y1(s_17);
  if ((X60Qx_219 < ((Math.imul(L_0, 4) + 4) | 0))) {
    let X60Qx_220 = resize_0_I9xvz9p1_nifh7u8pu1(s_17, 1);
    if ((!X60Qx_220)) {
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_17);
  mem.setU32((mem.u32((s_17 + 4)) + (L_0 * 4)), elem_3);
}

function getQ_7_I4w3aqj1_nifh7u8pu1(s_23, i_8) {
  let X60Qx_235;
  if ((i_8 < mem.i32(s_23))) {
    X60Qx_235 = (0 <= i_8);
  } else {
    X60Qx_235 = false;
  }
  if ((!X60Qx_235)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_71;
  result_71 = (mem.u32((s_23 + 4)) + (i_8 * 4));
  return result_71;
}

function getOrIncl_0_Iaj0qm3_nifh7u8pu1(t_26, v_10) {
  var result_72;
  var origH_2 = hash_1_has9tn57v(v_10);
  var X60Qx_236 = high_3_Izd57vi1_nifh7u8pu1((t_26 + 8));
  var h_2 = ((origH_2 & X60Qx_236) >>> 0);
  if ((!(mem.i32((t_26 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_237 = getQ_8_I1x0pam_nifh7u8pu1((t_26 + 8), h_2);
          var litId_11 = mem.u32(X60Qx_237);
          if ((!(0 < litId_11))) {
            break whileStmtLabel_0;
          }
          var X60Qx_238 = getQ_8_I1x0pam_nifh7u8pu1((t_26 + 8), h_2);
          var X60Qx_239 = getQ_7_Ir6d0tw_envto7w6l1(t_26, ((mem.u32(X60Qx_238) - 1) | 0));
          var X60Qx_240 = eqQ_20_sysvq0asl(v_10, X60Qx_239);
          if (X60Qx_240) {
            return litId_11;
          }
          var X60Qx_241 = high_3_Izd57vi1_nifh7u8pu1((t_26 + 8));
          var X60Qx_242 = nextTry_0_bitekkhcx1(h_2, X60Qx_241);
          h_2 = X60Qx_242;
        }
      }
    }
    var X60Qx_243 = mustRehash_0_bitekkhcx1(mem.i32((t_26 + 8)), mem.i32(t_26));
    if (X60Qx_243) {
      whileStmtLabel_1: {
        enlarge_0_Iffz5zw1_nifh7u8pu1(t_26);
        var X60Qx_244 = high_3_Izd57vi1_nifh7u8pu1((t_26 + 8));
        h_2 = ((origH_2 & X60Qx_244) >>> 0);
        {
          while (true) {
            var X60Qx_245 = getQ_8_I1x0pam_nifh7u8pu1((t_26 + 8), h_2);
            var litId_12 = mem.u32(X60Qx_245);
            if ((!(0 < litId_12))) {
              break whileStmtLabel_1;
            }
            var X60Qx_246 = high_3_Izd57vi1_nifh7u8pu1((t_26 + 8));
            var X60Qx_247 = nextTry_0_bitekkhcx1(h_2, X60Qx_246);
            h_2 = X60Qx_247;
          }
        }
      }
    }
  } else {
    setLen_0_Izwgy3z_nifh7u8pu1((t_26 + 8), 16);
    var X60Qx_248 = high_3_Izd57vi1_nifh7u8pu1((t_26 + 8));
    h_2 = ((origH_2 & X60Qx_248) >>> 0);
  }
  result_72 = ((mem.i32(t_26) + 1) | 0);
  putQ_8_Ird3zar1_nifh7u8pu1((t_26 + 8), h_2, result_72);
  var X60Qx_249 = allocFixed(8);
  mem.copy(X60Qx_249, nimStrDup(v_10), 8);
  add_0_Ig6072n_cmdqs323n1(t_26, X60Qx_249);
  return result_72;
}

function pop_0_I608lbn1_nifh7u8pu1(s_29) {
  if ((!(0 < mem.i32(s_29)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I17487054685970555778_nifh7u8pu1);
      return _o;
    })());
  }
  let result_74;
  let L_1 = ((mem.i32(s_29) - 1) | 0);
  let X60Qx_250 = getQ_7_I4w3aqj1_nifh7u8pu1(s_29, L_1);
  result_74 = mem.u32(X60Qx_250);
  mem.setI32(s_29, L_1);
  return result_74;
}

function getOrInclFromView_0_Iledlgq1_nifh7u8pu1(t_28, v_11) {
  var result_75;
  var origH_3 = hash_0_strdllfw2(v_11);
  var X60Qx_251 = high_3_Ib20i801_nifb6mq6y1((t_28 + 8));
  var h_3 = ((origH_3 & X60Qx_251) >>> 0);
  if ((!(mem.i32((t_28 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_252 = getQ_8_I1lkkvo_nifb6mq6y1((t_28 + 8), h_3);
          var litId_13 = mem.u32(X60Qx_252);
          if ((!(0 < litId_13))) {
            break whileStmtLabel_0;
          }
          var X60Qx_253 = getQ_8_I1lkkvo_nifb6mq6y1((t_28 + 8), h_3);
          var X60Qx_254 = getQ_7_Ir6d0tw_envto7w6l1(t_28, ((mem.u32(X60Qx_253) - 1) | 0));
          var X60Qx_255 = eqQ_1_strdllfw2(v_11, X60Qx_254);
          if (X60Qx_255) {
            return litId_13;
          }
          var X60Qx_256 = high_3_Ib20i801_nifb6mq6y1((t_28 + 8));
          var X60Qx_257 = nextTry_0_bitekkhcx1(h_3, X60Qx_256);
          h_3 = X60Qx_257;
        }
      }
    }
    var X60Qx_258 = mustRehash_0_bitekkhcx1(mem.i32((t_28 + 8)), mem.i32(t_28));
    if (X60Qx_258) {
      whileStmtLabel_1: {
        enlarge_0_I4mrsk51_nifb6mq6y1(t_28);
        var X60Qx_259 = high_3_Ib20i801_nifb6mq6y1((t_28 + 8));
        h_3 = ((origH_3 & X60Qx_259) >>> 0);
        {
          while (true) {
            var X60Qx_260 = getQ_8_I1lkkvo_nifb6mq6y1((t_28 + 8), h_3);
            var litId_14 = mem.u32(X60Qx_260);
            if ((!(0 < litId_14))) {
              break whileStmtLabel_1;
            }
            var X60Qx_261 = high_3_Ib20i801_nifb6mq6y1((t_28 + 8));
            var X60Qx_262 = nextTry_0_bitekkhcx1(h_3, X60Qx_261);
            h_3 = X60Qx_262;
          }
        }
      }
    }
  } else {
    setLen_0_Isypn1s_nifb6mq6y1((t_28 + 8), 16);
    var X60Qx_263 = high_3_Ib20i801_nifb6mq6y1((t_28 + 8));
    h_3 = ((origH_3 & X60Qx_263) >>> 0);
  }
  result_75 = ((mem.i32(t_28) + 1) | 0);
  putQ_8_Iltefhx_nifb6mq6y1((t_28 + 8), h_3, result_75);
  var X60Qx_264 = allocFixed(8);
  mem.copy(X60Qx_264, dollarQ_0_strdllfw2(v_11), 8);
  add_0_Ig6072n_cmdqs323n1(t_28, X60Qx_264);
  return result_75;
}

function getOrIncl_0_Inyo00c_nifh7u8pu1(t_29, v_12) {
  var result_76;
  var origH_4 = hash_1_has9tn57v(v_12);
  var X60Qx_265 = high_3_Ifgr4t11_nifh7u8pu1((t_29 + 8));
  var h_4 = ((origH_4 & X60Qx_265) >>> 0);
  if ((!(mem.i32((t_29 + 8)) === 0))) {
    whileStmtLabel_0: {
      {
        while (true) {
          var X60Qx_266 = getQ_8_Ii9prbm1_nifh7u8pu1((t_29 + 8), h_4);
          var litId_15 = mem.u32(X60Qx_266);
          if ((!(0 < litId_15))) {
            break whileStmtLabel_0;
          }
          var X60Qx_267 = getQ_8_Ii9prbm1_nifh7u8pu1((t_29 + 8), h_4);
          var X60Qx_268 = getQ_7_Ir6d0tw_envto7w6l1(t_29, ((mem.u32(X60Qx_267) - 1) | 0));
          var X60Qx_269 = eqQ_20_sysvq0asl(v_12, X60Qx_268);
          if (X60Qx_269) {
            return litId_15;
          }
          var X60Qx_270 = high_3_Ifgr4t11_nifh7u8pu1((t_29 + 8));
          var X60Qx_271 = nextTry_0_bitekkhcx1(h_4, X60Qx_270);
          h_4 = X60Qx_271;
        }
      }
    }
    var X60Qx_272 = mustRehash_0_bitekkhcx1(mem.i32((t_29 + 8)), mem.i32(t_29));
    if (X60Qx_272) {
      whileStmtLabel_1: {
        enlarge_0_Ix6p1u01_nifh7u8pu1(t_29);
        var X60Qx_273 = high_3_Ifgr4t11_nifh7u8pu1((t_29 + 8));
        h_4 = ((origH_4 & X60Qx_273) >>> 0);
        {
          while (true) {
            var X60Qx_274 = getQ_8_Ii9prbm1_nifh7u8pu1((t_29 + 8), h_4);
            var litId_16 = mem.u32(X60Qx_274);
            if ((!(0 < litId_16))) {
              break whileStmtLabel_1;
            }
            var X60Qx_275 = high_3_Ifgr4t11_nifh7u8pu1((t_29 + 8));
            var X60Qx_276 = nextTry_0_bitekkhcx1(h_4, X60Qx_275);
            h_4 = X60Qx_276;
          }
        }
      }
    }
  } else {
    setLen_0_Ihfm18w_nifh7u8pu1((t_29 + 8), 16);
    var X60Qx_277 = high_3_Ifgr4t11_nifh7u8pu1((t_29 + 8));
    h_4 = ((origH_4 & X60Qx_277) >>> 0);
  }
  result_76 = ((mem.i32(t_29) + 1) | 0);
  putQ_8_Ipsd6qc1_nifh7u8pu1((t_29 + 8), h_4, result_76);
  var X60Qx_278 = allocFixed(8);
  mem.copy(X60Qx_278, nimStrDup(v_12), 8);
  add_0_Ig6072n_cmdqs323n1(t_29, X60Qx_278);
  return result_76;
}

function getQ_0_Io78pjy1_nifh7u8pu1(t_38, litId_22) {
  let result_81;
  let idx_4 = ((litId_22 - 1) | 0);
  if ((!(idx_4 < mem.i32(t_38)))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_306 = getQ_7_Ir6d0tw_envto7w6l1(t_38, idx_4);
  result_81 = X60Qx_306;
  return result_81;
}

function getQ_0_Iplpzal1_nifh7u8pu1(t_39, litId_23) {
  let result_82;
  let idx_5 = ((litId_23 - 1) | 0);
  if ((!(idx_5 < mem.i32(t_39)))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_307 = getQ_7_Ir6d0tw_envto7w6l1(t_39, idx_5);
  result_82 = X60Qx_307;
  return result_82;
}

function getQ_0_In1k2p81_nifh7u8pu1(t_40, litId_24) {
  let result_85;
  let idx_7 = ((litId_24 - 1) | 0);
  if ((!(idx_7 < mem.i32(t_40)))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_309 = getQ_7_Ir6d0tw_envto7w6l1(t_40, idx_7);
  result_85 = X60Qx_309;
  return result_85;
}

function getQ_0_I93d71y_nifh7u8pu1(t_44, litId_28) {
  let result_88;
  let idx_9 = ((litId_28 - 1) | 0);
  if ((!(idx_9 < mem.i32(t_44)))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_314 = getQ_7_Ir6d0tw_envto7w6l1(t_44, idx_9);
  result_88 = X60Qx_314;
  return result_88;
}

function memSizeInBytes_0_Ib1bjtc_nifh7u8pu1(size_39) {
  let result_92;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_39, 4);
  result_92 = X60QconstRefTemp_0;
  if (false) {
    result_92 = 2147483647;
  }
  return result_92;
}

function memSizeInBytes_0_Ivqzo5x1_nifh7u8pu1(size_40) {
  let result_93;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_40, 4);
  result_93 = X60QconstRefTemp_0;
  if (false) {
    result_93 = 2147483647;
  }
  return result_93;
}

function resize_0_I9xvz9p1_nifh7u8pu1(dest_6, addedElements_2) {
  let result_105;
  let X60Qx_329 = capInBytes_0_Id76iiw1_nifb6mq6y1(dest_6);
  let oldCap_0 = Math.trunc((X60Qx_329 / 4));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_2);
  let memSize_12 = memSizeInBytes_0_Isupifd_nifb6mq6y1(newCap_0);
  let X60Qx_330 = realloc_1_sysvq0asl(mem.u32((dest_6 + 4)), memSize_12);
  mem.setU32((dest_6 + 4), X60Qx_330);
  if ((mem.u32((dest_6 + 4)) === 0)) {
    mem.setI32(dest_6, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_12);
    result_105 = false;
  } else {
    result_105 = true;
  }
  return result_105;
}

function high_3_Izd57vi1_nifh7u8pu1(s_68) {
  let result_108;
  result_108 = ((mem.i32(s_68) - 1) | 0);
  return result_108;
}

function getQ_8_I1x0pam_nifh7u8pu1(s_69, i_30) {
  if ((!(i_30 < mem.i32(s_69)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_109;
  result_109 = (mem.u32((s_69 + 4)) + (i_30 * 4));
  return result_109;
}

function enlarge_0_Iffz5zw1_nifh7u8pu1(t_47) {
  forStmtLabel_0: {
    var n_22 = allocFixed(8);
    eQwasMoved_1_Idi7njb_nifh7u8pu1(n_22);
    var X60Qx_341 = len_3_I2lzgei1_nifh7u8pu1((t_47 + 8));
    newSeq_1_Ijeltsd1_nifh7u8pu1(n_22, Math.imul(X60Qx_341, 2));
    swap_0_Iu9nbuo1_nifh7u8pu1((t_47 + 8), n_22);
    {
      whileStmtLabel_1: {
        var X60Qlf_15 = 0;
        var X60Qlf_16 = high_3_Izd57vi1_nifh7u8pu1(n_22);
        var X60Qlf_17 = allocFixed(4);
        mem.setI32(X60Qlf_17, X60Qlf_15);
        {
          while ((mem.i32(X60Qlf_17) <= X60Qlf_16)) {
            {
              var X60Qx_342 = getQ_7_Ic0x56f1_nifh7u8pu1(n_22, mem.i32(X60Qlf_17));
              var X60Qii_2 = mem.u32(X60Qx_342);
              if ((0 < X60Qii_2)) {
                var X60Qx_343 = getQ_7_Ir6d0tw_envto7w6l1(t_47, ((X60Qii_2 - 1) | 0));
                var X60Qx_344 = hash_1_has9tn57v(X60Qx_343);
                var X60Qx_345 = high_3_Izd57vi1_nifh7u8pu1((t_47 + 8));
                var X60Qii_3 = ((X60Qx_344 & X60Qx_345) >>> 0);
                while (true) {
                  var X60Qx_346 = getQ_8_I1x0pam_nifh7u8pu1((t_47 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_346))) {
                    var X60Qx_347 = high_3_Izd57vi1_nifh7u8pu1((t_47 + 8));
                    var X60Qx_348 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_347);
                    X60Qii_3 = X60Qx_348;
                  } else {
                    break;
                  }
                }
                var X60Qx_349 = getQ_7_Ic0x56f1_nifh7u8pu1(n_22, mem.i32(X60Qlf_17));
                var X60Qx_350 = move_0_I4g2vpk_nifh7u8pu1(X60Qx_349);
                putQ_8_Ird3zar1_nifh7u8pu1((t_47 + 8), X60Qii_3, X60Qx_350);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_17);
          }
        }
      }
    }
  }
  eQdestroy_1_Iv1ystk1_nifh7u8pu1(n_22);
}

function setLen_0_Izwgy3z_nifh7u8pu1(s_73, newLen_15) {
  if ((newLen_15 < mem.i32(s_73))) {
    shrink_0_Icn19hv_nifh7u8pu1(s_73, newLen_15);
  } else {
    whileStmtLabel_0: {
      var i_33 = allocFixed(4);
      mem.setI32(i_33, mem.i32(s_73));
      growUnsafe_0_Iugjmld1_nifh7u8pu1(s_73, newLen_15);
      if ((mem.u32((s_73 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_33) < newLen_15)) {
          mem.setU32((mem.u32((s_73 + 4)) + (mem.i32(i_33) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_33);
        }
      }
    }
  }
}

function putQ_8_Ird3zar1_nifh7u8pu1(s_76, i_34, elem_14) {
  if ((!(i_34 < mem.i32(s_76)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_76 + 4)) + (i_34 * 4)), elem_14);
}

function high_3_Ifgr4t11_nifh7u8pu1(s_77) {
  let result_110;
  result_110 = ((mem.i32(s_77) - 1) | 0);
  return result_110;
}

function getQ_8_Ii9prbm1_nifh7u8pu1(s_78, i_35) {
  if ((!(i_35 < mem.i32(s_78)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I302546433272327396_nifb6mq6y1);
      return _o;
    })());
  }
  let result_111;
  result_111 = (mem.u32((s_78 + 4)) + (i_35 * 4));
  return result_111;
}

function enlarge_0_Ix6p1u01_nifh7u8pu1(t_48) {
  forStmtLabel_0: {
    var n_23 = allocFixed(8);
    eQwasMoved_1_I2k4kel_nifh7u8pu1(n_23);
    var X60Qx_351 = len_3_I6y2imo_nifh7u8pu1((t_48 + 8));
    newSeq_1_I32yucz_nifh7u8pu1(n_23, Math.imul(X60Qx_351, 2));
    swap_0_Ir1sacn1_nifh7u8pu1((t_48 + 8), n_23);
    {
      whileStmtLabel_1: {
        var X60Qlf_18 = 0;
        var X60Qlf_19 = high_3_Ifgr4t11_nifh7u8pu1(n_23);
        var X60Qlf_20 = allocFixed(4);
        mem.setI32(X60Qlf_20, X60Qlf_18);
        {
          while ((mem.i32(X60Qlf_20) <= X60Qlf_19)) {
            {
              var X60Qx_352 = getQ_7_I2v00yv1_nifh7u8pu1(n_23, mem.i32(X60Qlf_20));
              var X60Qii_2 = mem.u32(X60Qx_352);
              if ((0 < X60Qii_2)) {
                var X60Qx_353 = getQ_7_Ir6d0tw_envto7w6l1(t_48, ((X60Qii_2 - 1) | 0));
                var X60Qx_354 = hash_1_has9tn57v(X60Qx_353);
                var X60Qx_355 = high_3_Ifgr4t11_nifh7u8pu1((t_48 + 8));
                var X60Qii_3 = ((X60Qx_354 & X60Qx_355) >>> 0);
                while (true) {
                  var X60Qx_356 = getQ_8_Ii9prbm1_nifh7u8pu1((t_48 + 8), X60Qii_3);
                  if ((0 < mem.u32(X60Qx_356))) {
                    var X60Qx_357 = high_3_Ifgr4t11_nifh7u8pu1((t_48 + 8));
                    var X60Qx_358 = nextTry_0_bitekkhcx1(X60Qii_3, X60Qx_357);
                    X60Qii_3 = X60Qx_358;
                  } else {
                    break;
                  }
                }
                var X60Qx_359 = getQ_7_I2v00yv1_nifh7u8pu1(n_23, mem.i32(X60Qlf_20));
                var X60Qx_360 = move_0_Izg2fga1_nifh7u8pu1(X60Qx_359);
                putQ_8_Ipsd6qc1_nifh7u8pu1((t_48 + 8), X60Qii_3, X60Qx_360);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_20);
          }
        }
      }
    }
  }
  eQdestroy_1_Iscb4i31_nifh7u8pu1(n_23);
}

function setLen_0_Ihfm18w_nifh7u8pu1(s_82, newLen_19) {
  if ((newLen_19 < mem.i32(s_82))) {
    shrink_0_Im65e8d_nifh7u8pu1(s_82, newLen_19);
  } else {
    whileStmtLabel_0: {
      var i_38 = allocFixed(4);
      mem.setI32(i_38, mem.i32(s_82));
      growUnsafe_0_Ikzmt9l1_nifh7u8pu1(s_82, newLen_19);
      if ((mem.u32((s_82 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_38) < newLen_19)) {
          mem.setU32((mem.u32((s_82 + 4)) + (mem.i32(i_38) * 4)), 0);
          inc_1_I6wjjge_cmdqs323n1(i_38);
        }
      }
    }
  }
}

function putQ_8_Ipsd6qc1_nifh7u8pu1(s_85, i_39, elem_15) {
  if ((!(i_39 < mem.i32(s_85)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I13319536120588890513_nifb6mq6y1);
      return _o;
    })());
  }
  mem.setU32((mem.u32((s_85 + 4)) + (i_39 * 4)), elem_15);
}

function len_3_I2lzgei1_nifh7u8pu1(s_127) {
  let result_128;
  result_128 = mem.i32(s_127);
  return result_128;
}

function newSeq_1_Ijeltsd1_nifh7u8pu1(s_128, newLen_37) {
  let X60Qx_411 = allocFixed(8);
  mem.copy(X60Qx_411, newSeq_0_Ix86g6u_nifh7u8pu1(newLen_37), 8);
  mem.copy(s_128, X60Qx_411, 8);
}

function swap_0_Iu9nbuo1_nifh7u8pu1(x_32, y_8) {
  let tmp_2 = allocFixed(8);
  mem.copy(tmp_2, x_32, 8);
  mem.copy(x_32, y_8, 8);
  mem.copy(y_8, tmp_2, 8);
}

function getQ_7_Ic0x56f1_nifh7u8pu1(s_129, i_59) {
  let X60Qx_412;
  if ((i_59 < mem.i32(s_129))) {
    X60Qx_412 = (0 <= i_59);
  } else {
    X60Qx_412 = false;
  }
  if ((!X60Qx_412)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_129;
  result_129 = (mem.u32((s_129 + 4)) + (i_59 * 4));
  return result_129;
}

function move_0_I4g2vpk_nifh7u8pu1(x_33) {
  let result_130;
  result_130 = mem.u32(x_33);
  return result_130;
}

function shrink_0_Icn19hv_nifh7u8pu1(s_130, newLen_38) {
  whileStmtLabel_0: {
    var i_60 = allocFixed(4);
    mem.setI32(i_60, ((mem.i32(s_130) - 1) | 0));
    {
      while ((newLen_38 <= mem.i32(i_60))) {
        dec_1_I0nzoz91_envto7w6l1(i_60);
      }
    }
  }
  mem.setI32(s_130, newLen_38);
}

function growUnsafe_0_Iugjmld1_nifh7u8pu1(s_131, newLen_39) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_39, 4);
  let newSize_2 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_413 = capInBytes_0_Iryrob_nifh7u8pu1(s_131);
  if ((X60Qx_413 < newSize_2)) {
    let X60Qx_414 = resize_0_Io7u6td1_nifh7u8pu1(s_131, ((newLen_39 - mem.i32(s_131)) | 0));
    if ((!X60Qx_414)) {
      return;
    }
  }
  mem.setI32(s_131, newLen_39);
}

function len_3_I6y2imo_nifh7u8pu1(s_133) {
  let result_131;
  result_131 = mem.i32(s_133);
  return result_131;
}

function newSeq_1_I32yucz_nifh7u8pu1(s_134, newLen_40) {
  let X60Qx_415 = allocFixed(8);
  mem.copy(X60Qx_415, newSeq_0_Ikhckyq1_nifh7u8pu1(newLen_40), 8);
  mem.copy(s_134, X60Qx_415, 8);
}

function swap_0_Ir1sacn1_nifh7u8pu1(x_34, y_9) {
  let tmp_3 = allocFixed(8);
  mem.copy(tmp_3, x_34, 8);
  mem.copy(x_34, y_9, 8);
  mem.copy(y_9, tmp_3, 8);
}

function getQ_7_I2v00yv1_nifh7u8pu1(s_135, i_61) {
  let X60Qx_416;
  if ((i_61 < mem.i32(s_135))) {
    X60Qx_416 = (0 <= i_61);
  } else {
    X60Qx_416 = false;
  }
  if ((!X60Qx_416)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_132;
  result_132 = (mem.u32((s_135 + 4)) + (i_61 * 4));
  return result_132;
}

function move_0_Izg2fga1_nifh7u8pu1(x_35) {
  let result_133;
  result_133 = mem.u32(x_35);
  return result_133;
}

function shrink_0_Im65e8d_nifh7u8pu1(s_136, newLen_41) {
  whileStmtLabel_0: {
    var i_62 = allocFixed(4);
    mem.setI32(i_62, ((mem.i32(s_136) - 1) | 0));
    {
      while ((newLen_41 <= mem.i32(i_62))) {
        dec_1_I0nzoz91_envto7w6l1(i_62);
      }
    }
  }
  mem.setI32(s_136, newLen_41);
}

function growUnsafe_0_Ikzmt9l1_nifh7u8pu1(s_137, newLen_42) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_42, 4);
  let newSize_3 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_417 = capInBytes_0_Iev6wua1_nifh7u8pu1(s_137);
  if ((X60Qx_417 < newSize_3)) {
    let X60Qx_418 = resize_0_I6ho9ve_nifh7u8pu1(s_137, ((newLen_42 - mem.i32(s_137)) | 0));
    if ((!X60Qx_418)) {
      return;
    }
  }
  mem.setI32(s_137, newLen_42);
}

function newSeq_0_Ix86g6u_nifh7u8pu1(size_56) {
  var result_152 = allocFixed(8);
  if ((size_56 === 0)) {
    mem.copy(result_152, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_56);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_20 = memSizeInBytes_0_Ib1bjtc_nifh7u8pu1(size_56);
    var X60Qx_451 = alloc_1_sysvq0asl(memSize_20);
    mem.copy(result_152, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_56);
      mem.setU32((_o + 4), X60Qx_451);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_152 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_74 = allocFixed(4);
        mem.setI32(i_74, 0);
        {
          while ((mem.i32(i_74) < size_56)) {
            mem.setU32((mem.u32((result_152 + 4)) + (mem.i32(i_74) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_74);
          }
        }
      }
    } else {
      mem.setI32(result_152, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_20);
    }
  }
  return result_152;
}

function capInBytes_0_Iryrob_nifh7u8pu1(s_164) {
  let result_153;
  let X60Qx_11;
  if ((!(mem.u32((s_164 + 4)) === 0))) {
    let X60Qx_452 = allocatedSize_0_sysvq0asl(mem.u32((s_164 + 4)));
    X60Qx_11 = X60Qx_452;
  } else {
    X60Qx_11 = 0;
  }
  result_153 = X60Qx_11;
  return result_153;
}

function resize_0_Io7u6td1_nifh7u8pu1(dest_20, addedElements_16) {
  let result_154;
  let X60Qx_453 = capInBytes_0_Iryrob_nifh7u8pu1(dest_20);
  let oldCap_6 = Math.trunc((X60Qx_453 / 4));
  let newCap_6 = recalcCap_0_sysvq0asl(oldCap_6, addedElements_16);
  let memSize_21 = memSizeInBytes_0_Ib1bjtc_nifh7u8pu1(newCap_6);
  let X60Qx_454 = realloc_1_sysvq0asl(mem.u32((dest_20 + 4)), memSize_21);
  mem.setU32((dest_20 + 4), X60Qx_454);
  if ((mem.u32((dest_20 + 4)) === 0)) {
    mem.setI32(dest_20, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_21);
    result_154 = false;
  } else {
    result_154 = true;
  }
  return result_154;
}

function newSeq_0_Ikhckyq1_nifh7u8pu1(size_57) {
  var result_155 = allocFixed(8);
  if ((size_57 === 0)) {
    mem.copy(result_155, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_57);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    var memSize_22 = memSizeInBytes_0_Ivqzo5x1_nifh7u8pu1(size_57);
    var X60Qx_455 = alloc_1_sysvq0asl(memSize_22);
    mem.copy(result_155, (() => {
      var _o = allocFixed(8);
      mem.setI32(_o, size_57);
      mem.setU32((_o + 4), X60Qx_455);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_155 + 4)) === 0))) {
      whileStmtLabel_0: {
        var i_75 = allocFixed(4);
        mem.setI32(i_75, 0);
        {
          while ((mem.i32(i_75) < size_57)) {
            mem.setU32((mem.u32((result_155 + 4)) + (mem.i32(i_75) * 4)), 0);
            inc_1_I6wjjge_cmdqs323n1(i_75);
          }
        }
      }
    } else {
      mem.setI32(result_155, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_22);
    }
  }
  return result_155;
}

function capInBytes_0_Iev6wua1_nifh7u8pu1(s_165) {
  let result_156;
  let X60Qx_12;
  if ((!(mem.u32((s_165 + 4)) === 0))) {
    let X60Qx_456 = allocatedSize_0_sysvq0asl(mem.u32((s_165 + 4)));
    X60Qx_12 = X60Qx_456;
  } else {
    X60Qx_12 = 0;
  }
  result_156 = X60Qx_12;
  return result_156;
}

function resize_0_I6ho9ve_nifh7u8pu1(dest_21, addedElements_17) {
  let result_157;
  let X60Qx_457 = capInBytes_0_Iev6wua1_nifh7u8pu1(dest_21);
  let oldCap_7 = Math.trunc((X60Qx_457 / 4));
  let newCap_7 = recalcCap_0_sysvq0asl(oldCap_7, addedElements_17);
  let memSize_23 = memSizeInBytes_0_Ivqzo5x1_nifh7u8pu1(newCap_7);
  let X60Qx_458 = realloc_1_sysvq0asl(mem.u32((dest_21 + 4)), memSize_23);
  mem.setU32((dest_21 + 4), X60Qx_458);
  if ((mem.u32((dest_21 + 4)) === 0)) {
    mem.setI32(dest_21, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_23);
    result_157 = false;
  } else {
    result_157 = true;
  }
  return result_157;
}

function eQdestroy_1_Iv1ystk1_nifh7u8pu1(s_208) {
  if ((!(mem.u32((s_208 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_93 = allocFixed(4);
      mem.setI32(i_93, 0);
      {
        while ((mem.i32(i_93) < mem.i32(s_208))) {
          inc_1_I6wjjge_cmdqs323n1(i_93);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_208 + 4)));
  }
}

function eQwasMoved_1_Idi7njb_nifh7u8pu1(s_209) {
  mem.setI32(s_209, 0);
  mem.setU32((s_209 + 4), 0);
}

function eQdestroy_1_Iscb4i31_nifh7u8pu1(s_210) {
  if ((!(mem.u32((s_210 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_97 = allocFixed(4);
      mem.setI32(i_97, 0);
      {
        while ((mem.i32(i_97) < mem.i32(s_210))) {
          inc_1_I6wjjge_cmdqs323n1(i_97);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_210 + 4)));
  }
}

function eQwasMoved_1_I2k4kel_nifh7u8pu1(s_211) {
  mem.setI32(s_211, 0);
  mem.setU32((s_211 + 4), 0);
}

function eQdestroyQ_SX4citerals0nifh7u8pu1_0_nifh7u8pu1(dest_0) {
  eQdestroyQ_SX42iX54ableX46loat0X49u8fssa_0_nifh7u8pu1((dest_0 + 104));
  eQdestroyQ_SX42iX54able0X49txao711_0_nifh7u8pu1((dest_0 + 88));
  eQdestroyQ_SX42iX54able0X49tvq7bk_0_nifh7u8pu1((dest_0 + 72));
  eQdestroyQ_SX42iX54able0X49pgo74p_0_nifh7u8pu1((dest_0 + 56));
  eQdestroyQ_SX42iX54able0X490ksat5_0_nifh7u8pu1((dest_0 + 40));
  eQdestroyQ_SX42iX54able0X49eutpr21_0_nifh7u8pu1((dest_0 + 24));
  eQdestroyQ_SX42iX54able0X49cvz6lt_0_nifh7u8pu1((dest_0 + 8));
  eQdestroyQ_SX4cineX49nfoX4danager0linxafkvx1_0_linxafkvx1(dest_0);
}

function eQwasmovedQ_SX4citerals0nifh7u8pu1_0_nifh7u8pu1(dest_0) {
  eQwasmovedQ_SX4cineX49nfoX4danager0linxafkvx1_0_linxafkvx1(dest_0);
  eQwasmovedQ_SX42iX54able0X49cvz6lt_0_nifh7u8pu1((dest_0 + 8));
  eQwasmovedQ_SX42iX54able0X49eutpr21_0_nifh7u8pu1((dest_0 + 24));
  eQwasmovedQ_SX42iX54able0X490ksat5_0_nifh7u8pu1((dest_0 + 40));
  eQwasmovedQ_SX42iX54able0X49pgo74p_0_nifh7u8pu1((dest_0 + 56));
  eQwasmovedQ_SX42iX54able0X49tvq7bk_0_nifh7u8pu1((dest_0 + 72));
  eQwasmovedQ_SX42iX54able0X49txao711_0_nifh7u8pu1((dest_0 + 88));
  eQwasmovedQ_SX42iX54ableX46loat0X49u8fssa_0_nifh7u8pu1((dest_0 + 104));
}

function eQdestroyQ_SX53tream0nifh7u8pu1_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_I35tn0j_nifb6mq6y1((dest_0 + 100));
  eQdestroyQ_SX52eader0nif81dubp1_0_nif81dubp1(dest_0);
}

function eQwasmovedQ_SX53tream0nifh7u8pu1_0_nifh7u8pu1(dest_0) {
  eQwasmovedQ_SX52eader0nif81dubp1_0_nif81dubp1(dest_0);
  eQwasMoved_1_Igz5mgz_nifb6mq6y1((dest_0 + 100));
}

function eQdestroyQ_SX42iX54able0X49cvz6lt_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_I5fjqyi1_nifb6mq6y1((dest_0 + 8));
  eQdestroy_1_Ivioh0a_cmdqs323n1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X49cvz6lt_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_I5vdnla_cmdqs323n1(dest_0);
  eQwasMoved_1_Iew8iz1_nifb6mq6y1((dest_0 + 8));
}

function eQdestroyQ_SX42iX54able0X49eutpr21_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_Iv1ystk1_nifh7u8pu1((dest_0 + 8));
  eQdestroy_1_Ivioh0a_cmdqs323n1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X49eutpr21_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_I5vdnla_cmdqs323n1(dest_0);
  eQwasMoved_1_Idi7njb_nifh7u8pu1((dest_0 + 8));
}

function eQdestroyQ_SX42iX54able0X490ksat5_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_Iscb4i31_nifh7u8pu1((dest_0 + 8));
  eQdestroy_1_Ivioh0a_cmdqs323n1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X490ksat5_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_I5vdnla_cmdqs323n1(dest_0);
  eQwasMoved_1_I2k4kel_nifh7u8pu1((dest_0 + 8));
}

function eQdestroyQ_SX42iX54able0X49pgo74p_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_In04crl1_nifb6mq6y1((dest_0 + 8));
  eQdestroy_1_Ivioh0a_cmdqs323n1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X49pgo74p_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_I5vdnla_cmdqs323n1(dest_0);
  eQwasMoved_1_I94uyip1_nifb6mq6y1((dest_0 + 8));
}

function eQdestroyQ_SX42iX54able0X49tvq7bk_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_Inr6ycs1_nifb6mq6y1((dest_0 + 8));
  eQdestroy_1_Iez2nr5_nifb6mq6y1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X49tvq7bk_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_Ia0kll01_nifb6mq6y1(dest_0);
  eQwasMoved_1_I5re2ul_nifb6mq6y1((dest_0 + 8));
}

function eQdestroyQ_SX42iX54able0X49txao711_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_I7og8li_nifb6mq6y1((dest_0 + 8));
  eQdestroy_1_Ic8bbvt1_nifb6mq6y1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X49txao711_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_I6m9e8j_nifb6mq6y1(dest_0);
  eQwasMoved_1_I52bdqo1_nifb6mq6y1((dest_0 + 8));
}

function eQdestroyQ_SX42iX54ableX46loat0X49u8fssa_0_nifh7u8pu1(dest_0) {
  eQdestroyQ_SX42iX54able0X49ojfwmy1_0_nifh7u8pu1(dest_0);
}

function eQwasmovedQ_SX42iX54ableX46loat0X49u8fssa_0_nifh7u8pu1(dest_0) {
  eQwasmovedQ_SX42iX54able0X49ojfwmy1_0_nifh7u8pu1(dest_0);
}

function eQdestroyQ_SX42iX54able0X49ojfwmy1_0_nifh7u8pu1(dest_0) {
  eQdestroy_1_Iz0k69p1_nifb6mq6y1((dest_0 + 8));
  eQdestroy_1_Ic8bbvt1_nifb6mq6y1(dest_0);
}

function eQwasmovedQ_SX42iX54able0X49ojfwmy1_0_nifh7u8pu1(dest_0) {
  eQwasMoved_1_I6m9e8j_nifb6mq6y1(dest_0);
  eQwasMoved_1_I5y4iq9_nifb6mq6y1((dest_0 + 8));
}

let X60QiniGuard_0_nifh7u8pu1 = allocFixed(1);

function X60Qini_0_nifh7u8pu1() {
  if (mem.u8At(X60QiniGuard_0_nifh7u8pu1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_nifh7u8pu1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_has9tn57v();
  X60Qini_0_bitekkhcx1();
  X60Qini_0_strdllfw2();
  X60Qini_0_linxafkvx1();
  X60Qini_0_nif81dubp1();
  X60Qini_0_nifjp9lau1();
  X60Qini_0_vfsc9jn7();
  X60Qini_0_tagygirdh1();
  let X60Qx_43 = allocFixed(8);
  mem.copy(X60Qx_43, toOpenArray_0_Isa0kxh_nifh7u8pu1(TagData_0_tagygirdh1), 8);
  mem.copy(pool_0_nifh7u8pu1, createLiterals_0_nifh7u8pu1(X60Qx_43), 120);
}
// generated by lengc (js backend) from pososrh1q1.c.nif

let X60QiniGuard_0_pososrh1q1 = allocFixed(1);

function X60Qini_0_pososrh1q1() {
  if (mem.u8At(X60QiniGuard_0_pososrh1q1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_pososrh1q1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from symkyk35i1.c.nif

function extractBasename_0_symkyk35i1(s_0, isGlobal_0) {
  whileStmtLabel_0: {
    var result_0 = allocFixed(8);
    nimStrWasMoved(result_0);
    var X60Qx_3 = len_4_sysvq0asl(s_0);
    var i_0 = allocFixed(4);
    mem.setI32(i_0, ((X60Qx_3 - 2) | 0));
    {
      while ((0 < mem.i32(i_0))) {
        var X60Qx_4 = getQ_9_sysvq0asl(s_0, mem.i32(i_0));
        if ((X60Qx_4 === 46)) {
          var X60Qdesugar_0 = allocFixed(32);
          mem.setU8(X60Qdesugar_0, 0);
          mem.setU8((X60Qdesugar_0 + 1), 0);
          mem.setU8((X60Qdesugar_0 + 2), 0);
          mem.setU8((X60Qdesugar_0 + 3), 0);
          mem.setU8((X60Qdesugar_0 + 4), 0);
          mem.setU8((X60Qdesugar_0 + 5), 0);
          mem.setU8((X60Qdesugar_0 + 6), 255);
          mem.setU8((X60Qdesugar_0 + 7), 3);
          mem.setU8((X60Qdesugar_0 + 8), 0);
          mem.setU8((X60Qdesugar_0 + 9), 0);
          mem.setU8((X60Qdesugar_0 + 10), 0);
          mem.setU8((X60Qdesugar_0 + 11), 0);
          mem.setU8((X60Qdesugar_0 + 12), 0);
          mem.setU8((X60Qdesugar_0 + 13), 0);
          mem.setU8((X60Qdesugar_0 + 14), 0);
          mem.setU8((X60Qdesugar_0 + 15), 0);
          mem.setU8((X60Qdesugar_0 + 16), 0);
          mem.setU8((X60Qdesugar_0 + 17), 0);
          mem.setU8((X60Qdesugar_0 + 18), 0);
          mem.setU8((X60Qdesugar_0 + 19), 0);
          mem.setU8((X60Qdesugar_0 + 20), 0);
          mem.setU8((X60Qdesugar_0 + 21), 0);
          mem.setU8((X60Qdesugar_0 + 22), 0);
          mem.setU8((X60Qdesugar_0 + 23), 0);
          mem.setU8((X60Qdesugar_0 + 24), 0);
          mem.setU8((X60Qdesugar_0 + 25), 0);
          mem.setU8((X60Qdesugar_0 + 26), 0);
          mem.setU8((X60Qdesugar_0 + 27), 0);
          mem.setU8((X60Qdesugar_0 + 28), 0);
          mem.setU8((X60Qdesugar_0 + 29), 0);
          mem.setU8((X60Qdesugar_0 + 30), 0);
          mem.setU8((X60Qdesugar_0 + 31), 0);
          var X60Qx_5 = getQ_9_sysvq0asl(s_0, ((mem.i32(i_0) + 1) | 0));
          var X60Qdesugar_1 = X60Qx_5;
          if ((((mem.u8At((X60Qdesugar_0 + (X60Qdesugar_1 >>> 3))) & ((1 << ((X60Qdesugar_1 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
            var X60Qx_6 = allocFixed(8);
            mem.copy(X60Qx_6, substr_0_sysvq0asl(s_0, 0, ((mem.i32(i_0) - 1) | 0)), 8);
            mem.copy(result_0, X60Qx_6, 8);
            return result_0;
          }
          mem.setU8(isGlobal_0, true);
        }
        dec_1_I0nzoz91_envto7w6l1(i_0);
      }
    }
  }
  return (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })();
  return result_0;
}

let X60QiniGuard_0_symkyk35i1 = allocFixed(1);

function X60Qini_0_symkyk35i1() {
  if (mem.u8At(X60QiniGuard_0_symkyk35i1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_symkyk35i1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from strdllfw2.c.nif

function eqQ_1_strdllfw2(a_1, b_1) {
  var result_1;
  var X60Qx_0 = len_4_sysvq0asl(b_1);
  if ((mem.i32((a_1 + 4)) === X60Qx_0)) {
    forStmtLabel_0: {
      {
        whileStmtLabel_1: {
          var X60Qlf_3 = 0;
          var X60Qlf_4 = mem.i32((a_1 + 4));
          var X60Qlf_5 = allocFixed(4);
          mem.setI32(X60Qlf_5, X60Qlf_3);
          {
            while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
              {
                var X60Qx_1 = getQ_9_sysvq0asl(b_1, mem.i32(X60Qlf_5));
                if ((!(mem.u8At((mem.u32(a_1) + mem.i32(X60Qlf_5))) === X60Qx_1))) {
                  return false;
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_5);
            }
          }
        }
      }
    }
    result_1 = true;
  } else {
    result_1 = false;
  }
  return result_1;
}

function dollarQ_0_strdllfw2(s_3) {
  let result_3 = allocFixed(8);
  nimStrWasMoved(result_3);
  nimStrDestroy(result_3);
  let X60Qx_4 = allocFixed(8);
  mem.copy(X60Qx_4, newString_0_sysvq0asl(mem.i32((s_3 + 4))), 8);
  mem.copy(result_3, X60Qx_4, 8);
  if ((0 < mem.i32((s_3 + 4)))) {
    let X60Qx_5 = beginStore_0_sysvq0asl(result_3, mem.i32((s_3 + 4)), 0);
    copyMem_0_sysvq0asl(X60Qx_5, mem.u32(s_3), mem.i32((s_3 + 4)));
    endStore_0_sysvq0asl(result_3);
  }
  return result_3;
}

function hash_0_strdllfw2(a_2) {
  let result_5;
  let X60Qtmp_0 = allocFixed(8);
  mem.copy(X60Qtmp_0, borrowCStringUnsafe_0_sysvq0asl(mem.u32(a_2), mem.i32((a_2 + 4))), 8);
  let X60Qx_9 = hash_1_has9tn57v(X60Qtmp_0);
  result_5 = X60Qx_9;
  nimStrDestroy(X60Qtmp_0);
  return result_5;
  nimStrDestroy(X60Qtmp_0);
  return result_5;
}

let X60QiniGuard_0_strdllfw2 = allocFixed(1);

function X60Qini_0_strdllfw2() {
  if (mem.u8At(X60QiniGuard_0_strdllfw2)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_strdllfw2, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_has9tn57v();
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
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_2);
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

let X60QiniGuard_0_jsovezijp1 = allocFixed(1);

function X60Qini_0_jsovezijp1() {
  if (mem.u8At(X60QiniGuard_0_jsovezijp1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_jsovezijp1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from oswd7dmm.c.nif

let X60QiniGuard_0_oswd7dmm = allocFixed(1);

function X60Qini_0_oswd7dmm() {
  if (mem.u8At(X60QiniGuard_0_oswd7dmm)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_oswd7dmm, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_pososrh1q1();
  X60Qini_0_cmdqs323n1();
  X60Qini_0_envto7w6l1();
  X60Qini_0_osezuyu63();
  X60Qini_0_ospaexnw61();
  X60Qini_0_ossk30t39();
  X60Qini_0_osalirkw71();
  X60Qini_0_osc4bsu0d1();
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
// generated by lengc (js backend) from osc4bsu0d1.c.nif

let X60QiniGuard_0_osc4bsu0d1 = allocFixed(1);

function X60Qini_0_osc4bsu0d1() {
  if (mem.u8At(X60QiniGuard_0_osc4bsu0d1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_osc4bsu0d1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_osezuyu63();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_assy765wm();
  X60Qini_0_wid623gv();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from fen2xhzfd.c.nif

let X60QiniGuard_0_fen2xhzfd = allocFixed(1);

function X60Qini_0_fen2xhzfd() {
  if (mem.u8At(X60QiniGuard_0_fen2xhzfd)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_fen2xhzfd, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from mat7cnfv21.c.nif

function plusQeQ_0_Iz7fdp7_mat7cnfv21(x_147, y_41) {
  mem.setI32(x_147, ((mem.i32(x_147) + y_41) | 0));
}

let X60QiniGuard_0_mat7cnfv21 = allocFixed(1);

function X60Qini_0_mat7cnfv21() {
  if (mem.u8At(X60QiniGuard_0_mat7cnfv21)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_mat7cnfv21, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_fen2xhzfd();
}
// generated by lengc (js backend) from ospaexnw61.c.nif

let X60QiniGuard_0_ospaexnw61 = allocFixed(1);

function X60Qini_0_ospaexnw61() {
  if (mem.u8At(X60QiniGuard_0_ospaexnw61)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_ospaexnw61, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_osezuyu63();
  X60Qini_0_osc4bsu0d1();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_assy765wm();
  X60Qini_0_wid623gv();
  X60Qini_0_patta6rli();
  X60Qini_0_ossk30t39();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from webzywwor1.c.nif

function tagName_0_webzywwor1(tok_0) {
  let result_0 = allocFixed(8);
  nimStrWasMoved(result_0);
  nimStrDestroy(result_0);
  let X60Qx_14 = tagId_0_nifh7u8pu1(tok_0);
  let X60Qx_15 = getQ_0_I93d71y_nifh7u8pu1((pool_0_nifh7u8pu1 + 8), X60Qx_14);
  let X60Qx_16 = allocFixed(8);
  mem.copy(X60Qx_16, nimStrDup(X60Qx_15), 8);
  mem.copy(result_0, X60Qx_16, 8);
  return result_0;
}

function symName_0_webzywwor1(tok_1) {
  let result_1 = allocFixed(8);
  nimStrWasMoved(result_1);
  nimStrDestroy(result_1);
  let X60Qx_17 = symId_0_nifh7u8pu1(tok_1);
  let X60Qx_18 = getQ_0_In1k2p81_nifh7u8pu1((pool_0_nifh7u8pu1 + 40), X60Qx_17);
  let X60Qx_19 = allocFixed(8);
  mem.copy(X60Qx_19, nimStrDup(X60Qx_18), 8);
  mem.copy(result_1, X60Qx_19, 8);
  return result_1;
}

function baseName_0_webzywwor1(sym_0) {
  let result_2 = allocFixed(8);
  nimStrWasMoved(result_2);
  let isGlobal_0 = allocFixed(1);
  mem.setU8(isGlobal_0, false);
  nimStrDestroy(result_2);
  let X60Qx_20 = allocFixed(8);
  mem.copy(X60Qx_20, extractBasename_0_symkyk35i1(sym_0, isGlobal_0), 8);
  mem.copy(result_2, X60Qx_20, 8);
  return result_2;
}

function posFragment_0_webzywwor1(tok_2) {
  let result_3 = allocFixed(8);
  nimStrWasMoved(result_3);
  let i_0 = allocFixed(16);
  mem.copy(i_0, unpack_0_linxafkvx1(pool_0_nifh7u8pu1, mem.u32((tok_2 + 4))), 16);
  let X60Qx_21 = isValid_1_linxafkvx1(mem.u32(i_0));
  if (X60Qx_21) {
    let X60Qx_22 = getQ_0_Io78pjy1_nifh7u8pu1((pool_0_nifh7u8pu1 + 24), mem.u32(i_0));
    let X60Qdesugar_0 = allocFixed(8);
    mem.copy(X60Qdesugar_0, jStr_0_jsovezijp1(X60Qx_22), 8);
    let X60Qdesugar_1 = allocFixed(8);
    mem.copy(X60Qdesugar_1, dollarQ_2_sysvq0asl(mem.i32((i_0 + 4))), 8);
    let X60Qdesugar_2 = allocFixed(8);
    mem.copy(X60Qdesugar_2, dollarQ_2_sysvq0asl(mem.i32((i_0 + 8))), 8);
    let X60Qx_23 = len_4_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1713515774);
      mem.setU32((_o + 4), strlit_0_I10470613477459003309_webzywwor1);
      return _o;
    })());
    let X60Qx_24 = len_4_sysvq0asl(X60Qdesugar_0);
    let X60Qx_25 = len_4_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1814179070);
      mem.setU32((_o + 4), strlit_0_I18338797071087941219_webzywwor1);
      return _o;
    })());
    let X60Qx_26 = len_4_sysvq0asl(X60Qdesugar_1);
    let X60Qx_27 = len_4_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1663184126);
      mem.setU32((_o + 4), strlit_0_I7115103054454119625_webzywwor1);
      return _o;
    })());
    let X60Qx_28 = len_4_sysvq0asl(X60Qdesugar_2);
    let X60Qdesugar_3 = allocFixed(8);
    mem.copy(X60Qdesugar_3, newStringOfCap_0_sysvq0asl(((((((((((X60Qx_23 + X60Qx_24) | 0) + X60Qx_25) | 0) + X60Qx_26) | 0) + X60Qx_27) | 0) + X60Qx_28) | 0)), 8);
    add_2_sysvq0asl(X60Qdesugar_3, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1713515774);
      mem.setU32((_o + 4), strlit_0_I10470613477459003309_webzywwor1);
      return _o;
    })());
    add_2_sysvq0asl(X60Qdesugar_3, X60Qdesugar_0);
    add_2_sysvq0asl(X60Qdesugar_3, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1814179070);
      mem.setU32((_o + 4), strlit_0_I18338797071087941219_webzywwor1);
      return _o;
    })());
    add_2_sysvq0asl(X60Qdesugar_3, X60Qdesugar_1);
    add_2_sysvq0asl(X60Qdesugar_3, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1663184126);
      mem.setU32((_o + 4), strlit_0_I7115103054454119625_webzywwor1);
      return _o;
    })());
    add_2_sysvq0asl(X60Qdesugar_3, X60Qdesugar_2);
    nimStrDestroy(result_3);
    mem.copy(result_3, X60Qdesugar_3, 8);
    nimStrWasMoved(X60Qdesugar_3);
    nimStrDestroy(X60Qdesugar_3);
    nimStrDestroy(X60Qdesugar_2);
    nimStrDestroy(X60Qdesugar_1);
    nimStrDestroy(X60Qdesugar_0);
  } else {
    nimStrDestroy(result_3);
    mem.copy(result_3, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  }
  return result_3;
}

let gModule_0_webzywwor1 = allocFixed(8);

mem.setU32(gModule_0_webzywwor1, 7235842);

mem.setU32((gModule_0_webzywwor1 + 4), 0);

function loadBufFromString_0_webzywwor1(buf_0) {
  let result_4 = allocFixed(16);
  eQwasMoved_1_nifb6mq6y1(result_4);
  let X60Qx_29 = allocFixed(8);
  mem.copy(X60Qx_29, nimStrDup(buf_0), 8);
  let X60Qx_30 = allocFixed(8);
  mem.copy(X60Qx_30, nimStrDup(gModule_0_webzywwor1), 8);
  let s_0 = allocFixed(108);
  mem.copy(s_0, openFromBuffer_0_nifh7u8pu1(X60Qx_29, X60Qx_30), 108);
  let X60Qx_31 = processDirectives_0_nif81dubp1(s_0);
  eQdestroy_1_nifb6mq6y1(result_4);
  let X60Qx_32 = allocFixed(16);
  mem.copy(X60Qx_32, fromStream_0_nifb6mq6y1(s_0), 16);
  mem.copy(result_4, X60Qx_32, 16);
  close_0_nifh7u8pu1(s_0);
  eQdestroyQ_SX53tream0nifh7u8pu1_0_nifh7u8pu1(s_0);
  return result_4;
  eQdestroyQ_SX53tream0nifh7u8pu1_0_nifh7u8pu1(s_0);
  return result_4;
}

function runDecls_0_webzywwor1(buf_1, wanted_0) {
  forStmtLabel_7: {
    forStmtLabel_0: {
      var result_5 = allocFixed(8);
      nimStrWasMoved(result_5);
      var tagStack_0 = allocFixed(8);
      mem.copy(tagStack_0, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
      var items_0 = allocFixed(8);
      mem.copy(items_0, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
      {
        whileStmtLabel_1: {
          var X60Qlf_0 = 0;
          var X60Qlf_1 = len_0_nifb6mq6y1(buf_1);
          var X60Qlf_2 = allocFixed(4);
          mem.setI32(X60Qlf_2, X60Qlf_0);
          {
            while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
              {
                continueLabel_2: {
                  {
                    var X60Qx_33 = getQ_0_nifb6mq6y1(buf_1, mem.i32(X60Qlf_2));
                    var X60Qii_3 = allocFixed(8);
                    mem.copy(X60Qii_3, X60Qx_33, 8);
                    switch ((((mem.u32(X60Qii_3) & 15) >>> 0) & 255)) {
                      case 11:
                        {
                          var X60Qx_34 = allocFixed(8);
                          mem.copy(X60Qx_34, tagName_0_webzywwor1(X60Qii_3), 8);
                          add_0_Ig6072n_cmdqs323n1(tagStack_0, X60Qx_34);
                        }
                        break;
                      case 12:
                        {
                          if ((0 < mem.i32(tagStack_0))) {
                            var X60Qx_35 = len_3_Ixq6taz_envto7w6l1(tagStack_0);
                            setLen_0_Iejjsiw_webzywwor1(tagStack_0, ((X60Qx_35 - 1) | 0));
                          }
                        }
                        break;
                      case 5:
                        {
                          var X60Qii_4 = allocFixed(8);
                          mem.copy(X60Qii_4, symName_0_webzywwor1(X60Qii_3), 8);
                          var X60Qii_5 = allocFixed(8);
                          mem.copy(X60Qii_5, baseName_0_webzywwor1(X60Qii_4), 8);
                          var X60Qx_36;
                          var X60Qx_37 = len_4_sysvq0asl(wanted_0);
                          if ((0 < X60Qx_37)) {
                            var X60Qx_38;
                            var X60Qx_39;
                            var X60Qx_40 = eqQ_20_sysvq0asl(X60Qii_4, wanted_0);
                            if (X60Qx_40) {
                              X60Qx_39 = true;
                            } else {
                              var X60Qx_41 = startsWith_0_str7j0ifg(X60Qii_4, wanted_0);
                              X60Qx_39 = X60Qx_41;
                            }
                            if (X60Qx_39) {
                              X60Qx_38 = true;
                            } else {
                              var X60Qx_42 = eqQ_20_sysvq0asl(X60Qii_5, wanted_0);
                              X60Qx_38 = X60Qx_42;
                            }
                            X60Qx_36 = (!X60Qx_38);
                          } else {
                            X60Qx_36 = false;
                          }
                          if (X60Qx_36) {
                            nimStrDestroy(X60Qii_5);
                            nimStrDestroy(X60Qii_4);
                            break continueLabel_2;
                          }
                          var X60Qx_0 = allocFixed(8);
                          nimStrWasMoved(X60Qx_0);
                          if ((0 < mem.i32(tagStack_0))) {
                            nimStrDestroy(X60Qx_0);
                            var X60Qx_43 = len_3_Ixq6taz_envto7w6l1(tagStack_0);
                            var X60Qx_44 = getQ_7_Ir6d0tw_envto7w6l1(tagStack_0, ((X60Qx_43 - 1) | 0));
                            var X60Qx_45 = allocFixed(8);
                            mem.copy(X60Qx_45, nimStrDup(X60Qx_44), 8);
                            mem.copy(X60Qx_0, X60Qx_45, 8);
                          } else {
                            nimStrDestroy(X60Qx_0);
                            mem.copy(X60Qx_0, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 0);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })(), 8);
                          }
                          var X60Qii_6 = allocFixed(8);
                          mem.copy(X60Qii_6, X60Qx_0, 8);
                          nimStrWasMoved(X60Qx_0);
                          var X60Qdesugar_4 = allocFixed(8);
                          mem.copy(X60Qdesugar_4, jStr_0_jsovezijp1(X60Qii_4), 8);
                          var X60Qdesugar_5 = allocFixed(8);
                          mem.copy(X60Qdesugar_5, jStr_0_jsovezijp1(X60Qii_5), 8);
                          var X60Qdesugar_6 = allocFixed(8);
                          mem.copy(X60Qdesugar_6, jStr_0_jsovezijp1(X60Qii_6), 8);
                          var X60Qdesugar_7 = allocFixed(8);
                          mem.copy(X60Qdesugar_7, posFragment_0_webzywwor1(X60Qii_3), 8);
                          var X60Qx_46 = len_4_sysvq0asl((() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1931639806);
                            mem.setU32((_o + 4), strlit_0_I5516792017268448510_webzywwor1);
                            return _o;
                          })());
                          var X60Qx_47 = len_4_sysvq0asl(X60Qdesugar_4);
                          var X60Qx_48 = len_4_sysvq0asl((() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1847733502);
                            mem.setU32((_o + 4), strlit_0_I15258652501822522767_webzywwor1);
                            return _o;
                          })());
                          var X60Qx_49 = len_4_sysvq0asl(X60Qdesugar_5);
                          var X60Qx_50 = len_4_sysvq0asl((() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1797401854);
                            mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                            return _o;
                          })());
                          var X60Qx_51 = len_4_sysvq0asl(X60Qdesugar_6);
                          var X60Qx_52 = len_4_sysvq0asl(X60Qdesugar_7);
                          var X60Qx_53 = len_4_sysvq0asl((() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 32001);
                            mem.setU32((_o + 4), 0);
                            return _o;
                          })());
                          var X60Qdesugar_8 = allocFixed(8);
                          mem.copy(X60Qdesugar_8, newStringOfCap_0_sysvq0asl(((((((((((((((X60Qx_46 + X60Qx_47) | 0) + X60Qx_48) | 0) + X60Qx_49) | 0) + X60Qx_50) | 0) + X60Qx_51) | 0) + X60Qx_52) | 0) + X60Qx_53) | 0)), 8);
                          add_2_sysvq0asl(X60Qdesugar_8, (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1931639806);
                            mem.setU32((_o + 4), strlit_0_I5516792017268448510_webzywwor1);
                            return _o;
                          })());
                          add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_4);
                          add_2_sysvq0asl(X60Qdesugar_8, (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1847733502);
                            mem.setU32((_o + 4), strlit_0_I15258652501822522767_webzywwor1);
                            return _o;
                          })());
                          add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_5);
                          add_2_sysvq0asl(X60Qdesugar_8, (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1797401854);
                            mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                            return _o;
                          })());
                          add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_6);
                          add_2_sysvq0asl(X60Qdesugar_8, X60Qdesugar_7);
                          add_2_sysvq0asl(X60Qdesugar_8, (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 32001);
                            mem.setU32((_o + 4), 0);
                            return _o;
                          })());
                          var X60Qtmp_0 = allocFixed(8);
                          mem.copy(X60Qtmp_0, X60Qdesugar_8, 8);
                          nimStrWasMoved(X60Qdesugar_8);
                          add_0_Ig6072n_cmdqs323n1(items_0, X60Qtmp_0);
                          nimStrDestroy(X60Qdesugar_8);
                          nimStrDestroy(X60Qdesugar_7);
                          nimStrDestroy(X60Qdesugar_6);
                          nimStrDestroy(X60Qdesugar_5);
                          nimStrDestroy(X60Qdesugar_4);
                          nimStrDestroy(X60Qii_6);
                          nimStrDestroy(X60Qx_0);
                          nimStrDestroy(X60Qii_5);
                          nimStrDestroy(X60Qii_4);
                        }
                        break;
                      default:
                        {
                        }
                        break;
                    }
                  }
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_2);
            }
          }
        }
      }
    }
    nimStrDestroy(result_5);
    mem.copy(result_5, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_8: {
        var X60Qlf_3 = 0;
        var X60Qlf_4 = len_3_Ixq6taz_envto7w6l1(items_0);
        var X60Qlf_5 = allocFixed(4);
        mem.setI32(X60Qlf_5, X60Qlf_3);
        {
          while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
            {
              if ((0 < mem.i32(X60Qlf_5))) {
                add_2_sysvq0asl(result_5, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_54 = getQ_7_Ir6d0tw_envto7w6l1(items_0, mem.i32(X60Qlf_5));
              add_2_sysvq0asl(result_5, X60Qx_54);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_5);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_5, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  eQdestroy_1_Ivioh0a_cmdqs323n1(items_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(tagStack_0);
  return result_5;
  eQdestroy_1_Ivioh0a_cmdqs323n1(items_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(tagStack_0);
  return result_5;
}

function isRoutineTag_0_webzywwor1(t_0) {
  X60Qsc_4: {
    X60Qsc_5: {
      X60Qsc_0: {
        var result_6;
        var X60Qx_1;
        var X60Qtc_1 = nimStrAtLe_0_sysvq0asl(t_0, 0, 105);
        if (X60Qtc_1) {
          var X60Qtc_2 = nimStrAtLe_0_sysvq0asl(t_0, 0, 102);
          if (X60Qtc_2) {
            if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1853187838);
              mem.setU32((_o + 4), strlit_0_I9991102891510134496_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            } else if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1852793854);
              mem.setU32((_o + 4), strlit_0_I6864681898360807206_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            }
          } else {
            if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1702128126);
              mem.setU32((_o + 4), strlit_0_I9071657656589967445_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            }
          }
        } else {
          var X60Qtc_3 = nimStrAtLe_0_sysvq0asl(t_0, 0, 109);
          if (X60Qtc_3) {
            if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1952804350);
              mem.setU32((_o + 4), strlit_0_I6517805684605582485_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            } else if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1667329534);
              mem.setU32((_o + 4), strlit_0_I3777428167486794959_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            }
          } else {
            if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1869771006);
              mem.setU32((_o + 4), strlit_0_I5316556160589403975_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            } else if (equalStrings_0_sysvq0asl(t_0, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1835365630);
              mem.setU32((_o + 4), strlit_0_I17987658270787974407_tagygirdh1);
              return _o;
            })())) {
              break X60Qsc_0;
            }
          }
        }
        break X60Qsc_5;
      }
      X60Qx_1 = true;
      break X60Qsc_4;
    }
    X60Qx_1 = false;
  }
  result_6 = X60Qx_1;
  return result_6;
}

function runCalls_0_webzywwor1(buf_2, wanted_1) {
  forStmtLabel_6: {
    forStmtLabel_0: {
      var result_7 = allocFixed(8);
      nimStrWasMoved(result_7);
      var tagStack_1 = allocFixed(8);
      mem.copy(tagStack_1, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
      var routines_0 = allocFixed(8);
      mem.copy(routines_0, newSeqUninit_0_I9y682m_webzywwor1(0), 8);
      var items_1 = allocFixed(8);
      mem.copy(items_1, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
      {
        whileStmtLabel_1: {
          var X60Qlf_6 = 0;
          var X60Qlf_7 = len_0_nifb6mq6y1(buf_2);
          var X60Qlf_8 = allocFixed(4);
          mem.setI32(X60Qlf_8, X60Qlf_6);
          {
            while ((mem.i32(X60Qlf_8) < X60Qlf_7)) {
              {
                var X60Qx_55 = getQ_0_nifb6mq6y1(buf_2, mem.i32(X60Qlf_8));
                var X60Qii_2 = allocFixed(8);
                mem.copy(X60Qii_2, X60Qx_55, 8);
                switch ((((mem.u32(X60Qii_2) & 15) >>> 0) & 255)) {
                  case 11:
                    {
                      var X60Qii_3 = allocFixed(8);
                      mem.copy(X60Qii_3, tagName_0_webzywwor1(X60Qii_2), 8);
                      var X60Qx_56 = allocFixed(8);
                      mem.copy(X60Qx_56, nimStrDup(X60Qii_3), 8);
                      add_0_Ig6072n_cmdqs323n1(tagStack_1, X60Qx_56);
                      var X60Qx_57 = isRoutineTag_0_webzywwor1(X60Qii_3);
                      if (X60Qx_57) {
                        var X60Qx_58 = len_3_Ixq6taz_envto7w6l1(tagStack_1);
                        add_0_Ix7vhkh1_webzywwor1(routines_0, (() => {
                          var _o = allocFixed(12);
                          mem.setI32(_o, X60Qx_58);
                          mem.copy((_o + 4), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 0);
                            mem.setU32((_o + 4), 0);
                            return _o;
                          })(), 8);
                          return _o;
                        })());
                      } else {
                        var X60Qx_59 = eqQ_20_sysvq0asl(X60Qii_3, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1818321918);
                          mem.setU32((_o + 4), strlit_0_I1707222714195181991_tagygirdh1);
                          return _o;
                        })());
                        if (X60Qx_59) {
                          var X60Qx_60;
                          var X60Qx_61;
                          var X60Qx_62 = len_0_nifb6mq6y1(buf_2);
                          if ((((mem.i32(X60Qlf_8) + 1) | 0) < X60Qx_62)) {
                            var X60Qx_63 = getQ_0_nifb6mq6y1(buf_2, ((mem.i32(X60Qlf_8) + 1) | 0));
                            X60Qx_61 = ((((mem.u32(X60Qx_63) & 15) >>> 0) & 255) === 4);
                          } else {
                            X60Qx_61 = false;
                          }
                          if (X60Qx_61) {
                            X60Qx_60 = (0 < mem.i32(routines_0));
                          } else {
                            X60Qx_60 = false;
                          }
                          if (X60Qx_60) {
                            var X60Qx_64 = len_3_I1agyno_webzywwor1(routines_0);
                            var X60Qx_65 = getQ_7_Imb0b9r1_webzywwor1(routines_0, ((X60Qx_64 - 1) | 0));
                            var X60Qii_4 = allocFixed(8);
                            mem.copy(X60Qii_4, nimStrDup((X60Qx_65 + 4)), 8);
                            var X60Qx_66 = getQ_0_nifb6mq6y1(buf_2, ((mem.i32(X60Qlf_8) + 1) | 0));
                            var X60Qii_5 = allocFixed(8);
                            mem.copy(X60Qii_5, symName_0_webzywwor1(X60Qx_66), 8);
                            var X60Qx_11;
                            var X60Qx_67 = len_4_sysvq0asl(X60Qii_4);
                            if ((0 < X60Qx_67)) {
                              var X60Qx_12;
                              var X60Qx_68;
                              var X60Qx_69;
                              var X60Qx_70 = len_4_sysvq0asl(wanted_1);
                              if ((X60Qx_70 === 0)) {
                                X60Qx_69 = true;
                              } else {
                                var X60Qx_71 = eqQ_20_sysvq0asl(X60Qii_4, wanted_1);
                                X60Qx_69 = X60Qx_71;
                              }
                              if (X60Qx_69) {
                                X60Qx_68 = true;
                              } else {
                                var X60Qx_72 = startsWith_0_str7j0ifg(X60Qii_4, wanted_1);
                                X60Qx_68 = X60Qx_72;
                              }
                              if (X60Qx_68) {
                                X60Qx_12 = true;
                              } else {
                                var X60Qtmp_1 = allocFixed(8);
                                mem.copy(X60Qtmp_1, baseName_0_webzywwor1(X60Qii_4), 8);
                                var X60Qx_73 = eqQ_20_sysvq0asl(X60Qtmp_1, wanted_1);
                                X60Qx_12 = X60Qx_73;
                                nimStrDestroy(X60Qtmp_1);
                              }
                              X60Qx_11 = X60Qx_12;
                            } else {
                              X60Qx_11 = false;
                            }
                            if (X60Qx_11) {
                              var X60Qdesugar_9 = allocFixed(8);
                              mem.copy(X60Qdesugar_9, jStr_0_jsovezijp1(X60Qii_4), 8);
                              var X60Qdesugar_10 = allocFixed(8);
                              mem.copy(X60Qdesugar_10, jStr_0_jsovezijp1(X60Qii_5), 8);
                              var X60Qx_74 = getQ_0_nifb6mq6y1(buf_2, ((mem.i32(X60Qlf_8) + 1) | 0));
                              var X60Qdesugar_11 = allocFixed(8);
                              mem.copy(X60Qdesugar_11, posFragment_0_webzywwor1(X60Qx_74), 8);
                              var X60Qx_75 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1663204350);
                                mem.setU32((_o + 4), strlit_0_I13311128126112205167_webzywwor1);
                                return _o;
                              })());
                              var X60Qx_76 = len_4_sysvq0asl(X60Qdesugar_9);
                              var X60Qx_77 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1663184126);
                                mem.setU32((_o + 4), strlit_0_I11346633816202967245_webzywwor1);
                                return _o;
                              })());
                              var X60Qx_78 = len_4_sysvq0asl(X60Qdesugar_10);
                              var X60Qx_79 = len_4_sysvq0asl(X60Qdesugar_11);
                              var X60Qx_80 = len_4_sysvq0asl((() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 32001);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })());
                              var X60Qdesugar_12 = allocFixed(8);
                              mem.copy(X60Qdesugar_12, newStringOfCap_0_sysvq0asl(((((((((((X60Qx_75 + X60Qx_76) | 0) + X60Qx_77) | 0) + X60Qx_78) | 0) + X60Qx_79) | 0) + X60Qx_80) | 0)), 8);
                              add_2_sysvq0asl(X60Qdesugar_12, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1663204350);
                                mem.setU32((_o + 4), strlit_0_I13311128126112205167_webzywwor1);
                                return _o;
                              })());
                              add_2_sysvq0asl(X60Qdesugar_12, X60Qdesugar_9);
                              add_2_sysvq0asl(X60Qdesugar_12, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1663184126);
                                mem.setU32((_o + 4), strlit_0_I11346633816202967245_webzywwor1);
                                return _o;
                              })());
                              add_2_sysvq0asl(X60Qdesugar_12, X60Qdesugar_10);
                              add_2_sysvq0asl(X60Qdesugar_12, X60Qdesugar_11);
                              add_2_sysvq0asl(X60Qdesugar_12, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 32001);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })());
                              var X60Qtmp_2 = allocFixed(8);
                              mem.copy(X60Qtmp_2, X60Qdesugar_12, 8);
                              nimStrWasMoved(X60Qdesugar_12);
                              add_0_Ig6072n_cmdqs323n1(items_1, X60Qtmp_2);
                              nimStrDestroy(X60Qdesugar_12);
                              nimStrDestroy(X60Qdesugar_11);
                              nimStrDestroy(X60Qdesugar_10);
                              nimStrDestroy(X60Qdesugar_9);
                            }
                            nimStrDestroy(X60Qii_5);
                            nimStrDestroy(X60Qii_4);
                          }
                        }
                      }
                      nimStrDestroy(X60Qii_3);
                    }
                    break;
                  case 12:
                    {
                      var X60Qx_81;
                      if ((0 < mem.i32(routines_0))) {
                        var X60Qx_82 = len_3_I1agyno_webzywwor1(routines_0);
                        var X60Qx_83 = getQ_7_Imb0b9r1_webzywwor1(routines_0, ((X60Qx_82 - 1) | 0));
                        var X60Qx_84 = len_3_Ixq6taz_envto7w6l1(tagStack_1);
                        X60Qx_81 = (mem.i32(X60Qx_83) === X60Qx_84);
                      } else {
                        X60Qx_81 = false;
                      }
                      if (X60Qx_81) {
                        var X60Qx_85 = len_3_I1agyno_webzywwor1(routines_0);
                        setLen_0_Ivb0eii_webzywwor1(routines_0, ((X60Qx_85 - 1) | 0));
                      }
                      if ((0 < mem.i32(tagStack_1))) {
                        var X60Qx_86 = len_3_Ixq6taz_envto7w6l1(tagStack_1);
                        setLen_0_Iejjsiw_webzywwor1(tagStack_1, ((X60Qx_86 - 1) | 0));
                      }
                    }
                    break;
                  case 5:
                    {
                      var X60Qx_87;
                      var X60Qx_88;
                      if ((0 < mem.i32(routines_0))) {
                        var X60Qx_89 = len_3_I1agyno_webzywwor1(routines_0);
                        var X60Qx_90 = getQ_7_Imb0b9r1_webzywwor1(routines_0, ((X60Qx_89 - 1) | 0));
                        var X60Qx_91 = len_4_sysvq0asl((X60Qx_90 + 4));
                        X60Qx_88 = (X60Qx_91 === 0);
                      } else {
                        X60Qx_88 = false;
                      }
                      if (X60Qx_88) {
                        var X60Qx_92 = len_3_I1agyno_webzywwor1(routines_0);
                        var X60Qx_93 = getQ_7_Imb0b9r1_webzywwor1(routines_0, ((X60Qx_92 - 1) | 0));
                        var X60Qx_94 = len_3_Ixq6taz_envto7w6l1(tagStack_1);
                        X60Qx_87 = (mem.i32(X60Qx_93) === X60Qx_94);
                      } else {
                        X60Qx_87 = false;
                      }
                      if (X60Qx_87) {
                        var X60Qx_95 = len_3_I1agyno_webzywwor1(routines_0);
                        var X60Qx_96 = getQ_7_Imb0b9r1_webzywwor1(routines_0, ((X60Qx_95 - 1) | 0));
                        var X60Qlhs_3 = (X60Qx_96 + 4);
                        var X60Qlhs_4 = allocFixed(8);
                        mem.copy(X60Qlhs_4, symName_0_webzywwor1(X60Qii_2), 8);
                        nimStrDestroy(X60Qlhs_3);
                        mem.copy(X60Qlhs_3, X60Qlhs_4, 8);
                      }
                    }
                    break;
                  default:
                    {
                    }
                    break;
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_8);
            }
          }
        }
      }
    }
    nimStrDestroy(result_7);
    mem.copy(result_7, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_7: {
        var X60Qlf_9 = 0;
        var X60Qlf_10 = len_3_Ixq6taz_envto7w6l1(items_1);
        var X60Qlf_11 = allocFixed(4);
        mem.setI32(X60Qlf_11, X60Qlf_9);
        {
          while ((mem.i32(X60Qlf_11) < X60Qlf_10)) {
            {
              if ((0 < mem.i32(X60Qlf_11))) {
                add_2_sysvq0asl(result_7, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_97 = getQ_7_Ir6d0tw_envto7w6l1(items_1, mem.i32(X60Qlf_11));
              add_2_sysvq0asl(result_7, X60Qx_97);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_11);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_7, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  eQdestroy_1_Ivioh0a_cmdqs323n1(items_1);
  eQdestroy_1_Iop3d8a1_webzywwor1(routines_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(tagStack_1);
  return result_7;
  eQdestroy_1_Ivioh0a_cmdqs323n1(items_1);
  eQdestroy_1_Iop3d8a1_webzywwor1(routines_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(tagStack_1);
  return result_7;
}

function findChecksum_0_webzywwor1(text_0) {
  let result_8 = allocFixed(8);
  nimStrWasMoved(result_8);
  let marker_0 = allocFixed(8);
  mem.setU32(marker_0, 1751329022);
  mem.setU32((marker_0 + 4), strlit_0_I18397792016458084092_webzywwor1);
  let start_0 = find_3_str7j0ifg(text_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1751329022);
    mem.setU32((_o + 4), strlit_0_I18397792016458084092_webzywwor1);
    return _o;
  })(), 0, -1);
  if ((start_0 < 0)) {
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1819635454);
      mem.setU32((_o + 4), strlit_0_I1659971858173592857_webzywwor1);
      return _o;
    })();
  }
  let X60Qx_98 = len_4_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1751329022);
    mem.setU32((_o + 4), strlit_0_I18397792016458084092_webzywwor1);
    return _o;
  })());
  let vstart_0 = ((start_0 + X60Qx_98) | 0);
  let vend_0 = find_0_str7j0ifg(text_0, 34, vstart_0, -1);
  if ((vend_0 < 0)) {
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1819635454);
      mem.setU32((_o + 4), strlit_0_I1659971858173592857_webzywwor1);
      return _o;
    })();
  }
  nimStrDestroy(result_8);
  let X60Qtmp_5 = allocFixed(8);
  mem.copy(X60Qtmp_5, substr_0_sysvq0asl(text_0, vstart_0, ((vend_0 - 1) | 0)), 8);
  let X60Qx_99 = allocFixed(8);
  mem.copy(X60Qx_99, jStr_0_jsovezijp1(X60Qtmp_5), 8);
  mem.copy(result_8, X60Qx_99, 8);
  nimStrDestroy(X60Qtmp_5);
  return result_8;
  nimStrDestroy(X60Qtmp_5);
  return result_8;
}

function runIndex_0_webzywwor1(idxText_0) {
  forStmtLabel_11: {
    forStmtLabel_9: {
      $exs0: {
        X60Qexlab_6: {
          var result_9 = allocFixed(8);
          nimStrWasMoved(result_9);
          var checksum_0 = allocFixed(8);
          mem.copy(checksum_0, findChecksum_0_webzywwor1(idxText_0), 8);
          var buf_3 = allocFixed(16);
          mem.setU32(buf_3, 0);
          mem.setI32((buf_3 + 4), 0);
          mem.setI32((buf_3 + 8), 0);
          mem.setU32((buf_3 + 12), 0);
          var loaded_0 = true;
          eQdestroy_1_nifb6mq6y1(buf_3);
          var X60Qx_100 = allocFixed(16);
          mem.copy(X60Qx_100, loadBufFromString_0_webzywwor1(idxText_0), 16);
          mem.copy(buf_3, X60Qx_100, 16);
          break $exs0;
        }
        loaded_0 = false;
      }
      var exportsItems_0 = allocFixed(8);
      mem.copy(exportsItems_0, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
      var convItems_0 = allocFixed(8);
      mem.copy(convItems_0, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
      if (loaded_0) {
        whileStmtLabel_0: {
          var i_7 = allocFixed(4);
          mem.setI32(i_7, 0);
          {
            while (true) {
              var X60Qx_101 = len_0_nifb6mq6y1(buf_3);
              if ((mem.i32(i_7) < X60Qx_101)) {
                var X60Qx_102 = getQ_0_nifb6mq6y1(buf_3, mem.i32(i_7));
                var tok_5 = allocFixed(8);
                mem.copy(tok_5, X60Qx_102, 8);
                if (((((mem.u32(tok_5) & 15) >>> 0) & 255) === 11)) {
                  var t_5 = allocFixed(8);
                  mem.copy(t_5, tagName_0_webzywwor1(tok_5), 8);
                  var X60Qx_103;
                  var X60Qx_104;
                  var X60Qx_105 = eqQ_20_sysvq0asl(t_5, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1886938622);
                    mem.setU32((_o + 4), strlit_0_I6313045265747232047_tagygirdh1);
                    return _o;
                  })());
                  if (X60Qx_105) {
                    X60Qx_104 = true;
                  } else {
                    var X60Qx_106 = eqQ_20_sysvq0asl(t_5, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1869768446);
                      mem.setU32((_o + 4), strlit_0_I15468012182747796806_tagygirdh1);
                      return _o;
                    })());
                    X60Qx_104 = X60Qx_106;
                  }
                  if (X60Qx_104) {
                    X60Qx_103 = true;
                  } else {
                    var X60Qx_107 = eqQ_20_sysvq0asl(t_5, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1886938622);
                      mem.setU32((_o + 4), strlit_0_I7395289177220351871_tagygirdh1);
                      return _o;
                    })());
                    X60Qx_103 = X60Qx_107;
                  }
                  if (X60Qx_103) {
                    whileStmtLabel_1: {
                      var j_0 = allocFixed(4);
                      mem.setI32(j_0, ((mem.i32(i_7) + 1) | 0));
                      var module_0 = allocFixed(8);
                      mem.setU32(module_0, 0);
                      mem.setU32((module_0 + 4), 0);
                      var X60Qx_108;
                      var X60Qx_109 = len_0_nifb6mq6y1(buf_3);
                      if ((mem.i32(j_0) < X60Qx_109)) {
                        var X60Qx_110 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                        X60Qx_108 = ((((mem.u32(X60Qx_110) & 15) >>> 0) & 255) === 6);
                      } else {
                        X60Qx_108 = false;
                      }
                      if (X60Qx_108) {
                        nimStrDestroy(module_0);
                        var X60Qx_111 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                        var X60Qx_112 = litId_0_nifh7u8pu1(X60Qx_111);
                        var X60Qx_113 = getQ_0_Iplpzal1_nifh7u8pu1((pool_0_nifh7u8pu1 + 56), X60Qx_112);
                        var X60Qx_114 = allocFixed(8);
                        mem.copy(X60Qx_114, nimStrDup(X60Qx_113), 8);
                        mem.copy(module_0, X60Qx_114, 8);
                        inc_1_I6wjjge_cmdqs323n1(j_0);
                      }
                      var names_0 = allocFixed(8);
                      mem.copy(names_0, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
                      {
                        while (true) {
                          var X60Qx_115;
                          var X60Qx_116 = len_0_nifb6mq6y1(buf_3);
                          if ((mem.i32(j_0) < X60Qx_116)) {
                            var X60Qx_117 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                            X60Qx_115 = (!((((mem.u32(X60Qx_117) & 15) >>> 0) & 255) === 12));
                          } else {
                            X60Qx_115 = false;
                          }
                          if (X60Qx_115) {
                            var X60Qx_118 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                            if (((((mem.u32(X60Qx_118) & 15) >>> 0) & 255) === 3)) {
                              var X60Qx_119 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                              var X60Qx_120 = litId_0_nifh7u8pu1(X60Qx_119);
                              var X60Qx_121 = getQ_0_Iplpzal1_nifh7u8pu1((pool_0_nifh7u8pu1 + 56), X60Qx_120);
                              var X60Qx_122 = allocFixed(8);
                              mem.copy(X60Qx_122, nimStrDup(X60Qx_121), 8);
                              add_0_Ig6072n_cmdqs323n1(names_0, X60Qx_122);
                            } else {
                              var X60Qx_123 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                              if (((((mem.u32(X60Qx_123) & 15) >>> 0) & 255) === 4)) {
                                var X60Qx_124 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_0));
                                var X60Qx_125 = allocFixed(8);
                                mem.copy(X60Qx_125, symName_0_webzywwor1(X60Qx_124), 8);
                                add_0_Ig6072n_cmdqs323n1(names_0, X60Qx_125);
                              }
                            }
                            inc_1_I6wjjge_cmdqs323n1(j_0);
                          } else {
                            break;
                          }
                        }
                      }
                    }
                    var X60Qx_126 = len_3_Ixq6taz_envto7w6l1(names_0);
                    if ((X60Qx_126 === 0)) {
                      var X60Qdesugar_13 = allocFixed(8);
                      mem.copy(X60Qdesugar_13, jStr_0_jsovezijp1(module_0), 8);
                      var X60Qdesugar_14 = allocFixed(8);
                      mem.copy(X60Qdesugar_14, jStr_0_jsovezijp1(module_0), 8);
                      var X60Qdesugar_15 = allocFixed(8);
                      mem.copy(X60Qdesugar_15, jStr_0_jsovezijp1(t_5), 8);
                      var X60Qx_127 = len_4_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1931639806);
                        mem.setU32((_o + 4), strlit_0_I5516792017268448510_webzywwor1);
                        return _o;
                      })());
                      var X60Qx_128 = len_4_sysvq0asl(X60Qdesugar_13);
                      var X60Qx_129 = len_4_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1847733502);
                        mem.setU32((_o + 4), strlit_0_I15258652501822522767_webzywwor1);
                        return _o;
                      })());
                      var X60Qx_130 = len_4_sysvq0asl(X60Qdesugar_14);
                      var X60Qx_131 = len_4_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1797401854);
                        mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                        return _o;
                      })());
                      var X60Qx_132 = len_4_sysvq0asl(X60Qdesugar_15);
                      var X60Qx_133 = len_4_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 32001);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                      var X60Qdesugar_16 = allocFixed(8);
                      mem.copy(X60Qdesugar_16, newStringOfCap_0_sysvq0asl(((((((((((((X60Qx_127 + X60Qx_128) | 0) + X60Qx_129) | 0) + X60Qx_130) | 0) + X60Qx_131) | 0) + X60Qx_132) | 0) + X60Qx_133) | 0)), 8);
                      add_2_sysvq0asl(X60Qdesugar_16, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1931639806);
                        mem.setU32((_o + 4), strlit_0_I5516792017268448510_webzywwor1);
                        return _o;
                      })());
                      add_2_sysvq0asl(X60Qdesugar_16, X60Qdesugar_13);
                      add_2_sysvq0asl(X60Qdesugar_16, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1847733502);
                        mem.setU32((_o + 4), strlit_0_I15258652501822522767_webzywwor1);
                        return _o;
                      })());
                      add_2_sysvq0asl(X60Qdesugar_16, X60Qdesugar_14);
                      add_2_sysvq0asl(X60Qdesugar_16, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1797401854);
                        mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                        return _o;
                      })());
                      add_2_sysvq0asl(X60Qdesugar_16, X60Qdesugar_15);
                      add_2_sysvq0asl(X60Qdesugar_16, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 32001);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                      var X60Qtmp_6 = allocFixed(8);
                      mem.copy(X60Qtmp_6, X60Qdesugar_16, 8);
                      nimStrWasMoved(X60Qdesugar_16);
                      add_0_Ig6072n_cmdqs323n1(exportsItems_0, X60Qtmp_6);
                      nimStrDestroy(X60Qdesugar_16);
                      nimStrDestroy(X60Qdesugar_15);
                      nimStrDestroy(X60Qdesugar_14);
                      nimStrDestroy(X60Qdesugar_13);
                    } else {
                      forStmtLabel_2: {
                        {
                          whileStmtLabel_3: {
                            var X60Qlf_12 = allocFixed(8);
                            mem.copy(X60Qlf_12, toOpenArray_1_I6b60gk1_webzywwor1(names_0), 8);
                            var X60Qlf_13 = allocFixed(4);
                            mem.setI32(X60Qlf_13, 0);
                            {
                              while (true) {
                                var X60Qx_134 = len_6_Igv2wyu1_osalirkw71(X60Qlf_12);
                                if ((mem.i32(X60Qlf_13) < X60Qx_134)) {
                                  {
                                    var X60Qii_4 = getQ_10_Ik9hgkq1_osalirkw71(X60Qlf_12, mem.i32(X60Qlf_13));
                                    var X60Qii_5 = allocFixed(8);
                                    mem.copy(X60Qii_5, baseName_0_webzywwor1(X60Qii_4), 8);
                                    var X60Qx_2 = allocFixed(8);
                                    nimStrWasMoved(X60Qx_2);
                                    var X60Qx_135 = len_4_sysvq0asl(X60Qii_5);
                                    if ((X60Qx_135 === 0)) {
                                      nimStrDestroy(X60Qx_2);
                                      var X60Qx_136 = allocFixed(8);
                                      mem.copy(X60Qx_136, nimStrDup(X60Qii_4), 8);
                                      mem.copy(X60Qx_2, X60Qx_136, 8);
                                    } else {
                                      nimStrDestroy(X60Qx_2);
                                      mem.copy(X60Qx_2, X60Qii_5, 8);
                                      nimStrWasMoved(X60Qii_5);
                                    }
                                    var X60Qii_6 = allocFixed(8);
                                    mem.copy(X60Qii_6, X60Qx_2, 8);
                                    nimStrWasMoved(X60Qx_2);
                                    var X60Qdesugar_17 = allocFixed(8);
                                    mem.copy(X60Qdesugar_17, jStr_0_jsovezijp1(X60Qii_4), 8);
                                    var X60Qdesugar_18 = allocFixed(8);
                                    mem.copy(X60Qdesugar_18, jStr_0_jsovezijp1(X60Qii_6), 8);
                                    var X60Qdesugar_19 = allocFixed(8);
                                    mem.copy(X60Qdesugar_19, jStr_0_jsovezijp1(t_5), 8);
                                    var X60Qx_137 = len_4_sysvq0asl((() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1931639806);
                                      mem.setU32((_o + 4), strlit_0_I5516792017268448510_webzywwor1);
                                      return _o;
                                    })());
                                    var X60Qx_138 = len_4_sysvq0asl(X60Qdesugar_17);
                                    var X60Qx_139 = len_4_sysvq0asl((() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1847733502);
                                      mem.setU32((_o + 4), strlit_0_I15258652501822522767_webzywwor1);
                                      return _o;
                                    })());
                                    var X60Qx_140 = len_4_sysvq0asl(X60Qdesugar_18);
                                    var X60Qx_141 = len_4_sysvq0asl((() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1797401854);
                                      mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                                      return _o;
                                    })());
                                    var X60Qx_142 = len_4_sysvq0asl(X60Qdesugar_19);
                                    var X60Qx_143 = len_4_sysvq0asl((() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 32001);
                                      mem.setU32((_o + 4), 0);
                                      return _o;
                                    })());
                                    var X60Qdesugar_20 = allocFixed(8);
                                    mem.copy(X60Qdesugar_20, newStringOfCap_0_sysvq0asl(((((((((((((X60Qx_137 + X60Qx_138) | 0) + X60Qx_139) | 0) + X60Qx_140) | 0) + X60Qx_141) | 0) + X60Qx_142) | 0) + X60Qx_143) | 0)), 8);
                                    add_2_sysvq0asl(X60Qdesugar_20, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1931639806);
                                      mem.setU32((_o + 4), strlit_0_I5516792017268448510_webzywwor1);
                                      return _o;
                                    })());
                                    add_2_sysvq0asl(X60Qdesugar_20, X60Qdesugar_17);
                                    add_2_sysvq0asl(X60Qdesugar_20, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1847733502);
                                      mem.setU32((_o + 4), strlit_0_I15258652501822522767_webzywwor1);
                                      return _o;
                                    })());
                                    add_2_sysvq0asl(X60Qdesugar_20, X60Qdesugar_18);
                                    add_2_sysvq0asl(X60Qdesugar_20, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 1797401854);
                                      mem.setU32((_o + 4), strlit_0_I6357233917619117690_webzywwor1);
                                      return _o;
                                    })());
                                    add_2_sysvq0asl(X60Qdesugar_20, X60Qdesugar_19);
                                    add_2_sysvq0asl(X60Qdesugar_20, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 32001);
                                      mem.setU32((_o + 4), 0);
                                      return _o;
                                    })());
                                    var X60Qtmp_7 = allocFixed(8);
                                    mem.copy(X60Qtmp_7, X60Qdesugar_20, 8);
                                    nimStrWasMoved(X60Qdesugar_20);
                                    add_0_Ig6072n_cmdqs323n1(exportsItems_0, X60Qtmp_7);
                                    nimStrDestroy(X60Qdesugar_20);
                                    nimStrDestroy(X60Qdesugar_19);
                                    nimStrDestroy(X60Qdesugar_18);
                                    nimStrDestroy(X60Qdesugar_17);
                                    nimStrDestroy(X60Qii_6);
                                    nimStrDestroy(X60Qx_2);
                                    nimStrDestroy(X60Qii_5);
                                  }
                                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_13);
                                } else {
                                  break;
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                    eQdestroy_1_Ivioh0a_cmdqs323n1(names_0);
                    nimStrDestroy(module_0);
                  } else {
                    var X60Qx_144 = eqQ_20_sysvq0asl(t_5, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1852793854);
                      mem.setU32((_o + 4), strlit_0_I6864681898360807206_tagygirdh1);
                      return _o;
                    })());
                    if (X60Qx_144) {
                      whileStmtLabel_7: {
                        var j_1 = allocFixed(4);
                        mem.setI32(j_1, ((mem.i32(i_7) + 1) | 0));
                        {
                          while (true) {
                            var X60Qx_145;
                            var X60Qx_146 = len_0_nifb6mq6y1(buf_3);
                            if ((mem.i32(j_1) < X60Qx_146)) {
                              var X60Qx_147 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_1));
                              X60Qx_145 = (!((((mem.u32(X60Qx_147) & 15) >>> 0) & 255) === 12));
                            } else {
                              X60Qx_145 = false;
                            }
                            if (X60Qx_145) {
                              var X60Qx_13;
                              var X60Qx_148 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_1));
                              if (((((mem.u32(X60Qx_148) & 15) >>> 0) & 255) === 11)) {
                                var X60Qx_149 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_1));
                                var X60Qtmp_8 = allocFixed(8);
                                mem.copy(X60Qtmp_8, tagName_0_webzywwor1(X60Qx_149), 8);
                                var X60Qx_150 = eqQ_20_sysvq0asl(X60Qtmp_8, (() => {
                                  var _o = allocFixed(8);
                                  mem.setU32(_o, 7760642);
                                  mem.setU32((_o + 4), 0);
                                  return _o;
                                })());
                                X60Qx_13 = X60Qx_150;
                                nimStrDestroy(X60Qtmp_8);
                              } else {
                                X60Qx_13 = false;
                              }
                              if (X60Qx_13) {
                                whileStmtLabel_8: {
                                  var k_0 = allocFixed(4);
                                  mem.setI32(k_0, ((mem.i32(j_1) + 1) | 0));
                                  var key_0 = allocFixed(8);
                                  mem.setU32(key_0, 0);
                                  mem.setU32((key_0 + 4), 0);
                                  var sym_2 = allocFixed(8);
                                  mem.setU32(sym_2, 0);
                                  mem.setU32((sym_2 + 4), 0);
                                  var X60Qx_151 = len_0_nifb6mq6y1(buf_3);
                                  if ((mem.i32(k_0) < X60Qx_151)) {
                                    var X60Qx_152 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                    if (((((mem.u32(X60Qx_152) & 15) >>> 0) & 255) === 4)) {
                                      nimStrDestroy(key_0);
                                      var X60Qx_153 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                      var X60Qx_154 = allocFixed(8);
                                      mem.copy(X60Qx_154, symName_0_webzywwor1(X60Qx_153), 8);
                                      mem.copy(key_0, X60Qx_154, 8);
                                    } else {
                                      var X60Qx_155 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                      if (((((mem.u32(X60Qx_155) & 15) >>> 0) & 255) === 3)) {
                                        nimStrDestroy(key_0);
                                        var X60Qx_156 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                        var X60Qx_157 = litId_0_nifh7u8pu1(X60Qx_156);
                                        var X60Qx_158 = getQ_0_Iplpzal1_nifh7u8pu1((pool_0_nifh7u8pu1 + 56), X60Qx_157);
                                        var X60Qx_159 = allocFixed(8);
                                        mem.copy(X60Qx_159, nimStrDup(X60Qx_158), 8);
                                        mem.copy(key_0, X60Qx_159, 8);
                                      } else {
                                        var X60Qx_160 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                        if (((((mem.u32(X60Qx_160) & 15) >>> 0) & 255) === 2)) {
                                          nimStrDestroy(key_0);
                                          mem.copy(key_0, (() => {
                                            var _o = allocFixed(8);
                                            mem.setU32(_o, 11777);
                                            mem.setU32((_o + 4), 0);
                                            return _o;
                                          })(), 8);
                                        }
                                      }
                                    }
                                    inc_1_I6wjjge_cmdqs323n1(k_0);
                                  }
                                  var X60Qx_161 = len_0_nifb6mq6y1(buf_3);
                                  if ((mem.i32(k_0) < X60Qx_161)) {
                                    var X60Qx_162 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                    if (((((mem.u32(X60Qx_162) & 15) >>> 0) & 255) === 4)) {
                                      nimStrDestroy(sym_2);
                                      var X60Qx_163 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                      var X60Qx_164 = allocFixed(8);
                                      mem.copy(X60Qx_164, symName_0_webzywwor1(X60Qx_163), 8);
                                      mem.copy(sym_2, X60Qx_164, 8);
                                    } else {
                                      var X60Qx_165 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                      if (((((mem.u32(X60Qx_165) & 15) >>> 0) & 255) === 3)) {
                                        nimStrDestroy(sym_2);
                                        var X60Qx_166 = getQ_0_nifb6mq6y1(buf_3, mem.i32(k_0));
                                        var X60Qx_167 = litId_0_nifh7u8pu1(X60Qx_166);
                                        var X60Qx_168 = getQ_0_Iplpzal1_nifh7u8pu1((pool_0_nifh7u8pu1 + 56), X60Qx_167);
                                        var X60Qx_169 = allocFixed(8);
                                        mem.copy(X60Qx_169, nimStrDup(X60Qx_168), 8);
                                        mem.copy(sym_2, X60Qx_169, 8);
                                      }
                                    }
                                    inc_1_I6wjjge_cmdqs323n1(k_0);
                                  }
                                  var X60Qx_3 = allocFixed(8);
                                  nimStrWasMoved(X60Qx_3);
                                  var X60Qx_170 = eqQ_20_sysvq0asl(key_0, (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 11777);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  if (X60Qx_170) {
                                    nimStrDestroy(X60Qx_3);
                                    mem.copy(X60Qx_3, (() => {
                                      var _o = allocFixed(8);
                                      mem.setU32(_o, 0);
                                      mem.setU32((_o + 4), 0);
                                      return _o;
                                    })(), 8);
                                  } else {
                                    nimStrDestroy(X60Qx_3);
                                    mem.copy(X60Qx_3, key_0, 8);
                                    nimStrWasMoved(key_0);
                                  }
                                  var kk_0 = allocFixed(8);
                                  mem.copy(kk_0, X60Qx_3, 8);
                                  nimStrWasMoved(X60Qx_3);
                                  var X60Qdesugar_21 = allocFixed(8);
                                  mem.copy(X60Qdesugar_21, jStr_0_jsovezijp1(kk_0), 8);
                                  var X60Qdesugar_22 = allocFixed(8);
                                  mem.copy(X60Qdesugar_22, jStr_0_jsovezijp1(sym_2), 8);
                                  var X60Qx_171 = len_4_sysvq0asl((() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 23297);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  var X60Qx_172 = len_4_sysvq0asl(X60Qdesugar_21);
                                  var X60Qx_173 = len_4_sysvq0asl((() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 11265);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  var X60Qx_174 = len_4_sysvq0asl(X60Qdesugar_22);
                                  var X60Qx_175 = len_4_sysvq0asl((() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 23809);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  var X60Qdesugar_23 = allocFixed(8);
                                  mem.copy(X60Qdesugar_23, newStringOfCap_0_sysvq0asl(((((((((X60Qx_171 + X60Qx_172) | 0) + X60Qx_173) | 0) + X60Qx_174) | 0) + X60Qx_175) | 0)), 8);
                                  add_2_sysvq0asl(X60Qdesugar_23, (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 23297);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  add_2_sysvq0asl(X60Qdesugar_23, X60Qdesugar_21);
                                  add_2_sysvq0asl(X60Qdesugar_23, (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 11265);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  add_2_sysvq0asl(X60Qdesugar_23, X60Qdesugar_22);
                                  add_2_sysvq0asl(X60Qdesugar_23, (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 23809);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  var X60Qtmp_9 = allocFixed(8);
                                  mem.copy(X60Qtmp_9, X60Qdesugar_23, 8);
                                  nimStrWasMoved(X60Qdesugar_23);
                                  add_0_Ig6072n_cmdqs323n1(convItems_0, X60Qtmp_9);
                                  var depth_0 = allocFixed(4);
                                  mem.setI32(depth_0, 1);
                                  plusQeQ_0_Iz7fdp7_mat7cnfv21(j_1, 1);
                                  {
                                    while (true) {
                                      var X60Qx_176;
                                      var X60Qx_177 = len_0_nifb6mq6y1(buf_3);
                                      if ((mem.i32(j_1) < X60Qx_177)) {
                                        X60Qx_176 = (0 < mem.i32(depth_0));
                                      } else {
                                        X60Qx_176 = false;
                                      }
                                      if (X60Qx_176) {
                                        var X60Qx_178 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_1));
                                        if (((((mem.u32(X60Qx_178) & 15) >>> 0) & 255) === 11)) {
                                          inc_1_I6wjjge_cmdqs323n1(depth_0);
                                        } else {
                                          var X60Qx_179 = getQ_0_nifb6mq6y1(buf_3, mem.i32(j_1));
                                          if (((((mem.u32(X60Qx_179) & 15) >>> 0) & 255) === 12)) {
                                            dec_1_I0nzoz91_envto7w6l1(depth_0);
                                          }
                                        }
                                        inc_1_I6wjjge_cmdqs323n1(j_1);
                                      } else {
                                        break;
                                      }
                                    }
                                  }
                                }
                                nimStrDestroy(X60Qdesugar_23);
                                nimStrDestroy(X60Qdesugar_22);
                                nimStrDestroy(X60Qdesugar_21);
                                nimStrDestroy(kk_0);
                                nimStrDestroy(X60Qx_3);
                                nimStrDestroy(sym_2);
                                nimStrDestroy(key_0);
                              } else {
                                inc_1_I6wjjge_cmdqs323n1(j_1);
                              }
                            } else {
                              break;
                            }
                          }
                        }
                      }
                    }
                  }
                  nimStrDestroy(t_5);
                }
                inc_1_I6wjjge_cmdqs323n1(i_7);
              } else {
                break;
              }
            }
          }
        }
      }
      var exp_0 = allocFixed(8);
      mem.setU32(exp_0, 23297);
      mem.setU32((exp_0 + 4), 0);
      {
        whileStmtLabel_10: {
          var X60Qlf_14 = 0;
          var X60Qlf_15 = len_3_Ixq6taz_envto7w6l1(exportsItems_0);
          var X60Qlf_16 = allocFixed(4);
          mem.setI32(X60Qlf_16, X60Qlf_14);
          {
            while ((mem.i32(X60Qlf_16) < X60Qlf_15)) {
              {
                if ((0 < mem.i32(X60Qlf_16))) {
                  add_2_sysvq0asl(exp_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 11265);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })());
                }
                var X60Qx_180 = getQ_7_Ir6d0tw_envto7w6l1(exportsItems_0, mem.i32(X60Qlf_16));
                add_2_sysvq0asl(exp_0, X60Qx_180);
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_16);
            }
          }
        }
      }
    }
    add_2_sysvq0asl(exp_0, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23809);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    var cnv_0 = allocFixed(8);
    mem.setU32(cnv_0, 23297);
    mem.setU32((cnv_0 + 4), 0);
    {
      whileStmtLabel_12: {
        var X60Qlf_17 = 0;
        var X60Qlf_18 = len_3_Ixq6taz_envto7w6l1(convItems_0);
        var X60Qlf_19 = allocFixed(4);
        mem.setI32(X60Qlf_19, X60Qlf_17);
        {
          while ((mem.i32(X60Qlf_19) < X60Qlf_18)) {
            {
              if ((0 < mem.i32(X60Qlf_19))) {
                add_2_sysvq0asl(cnv_0, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              var X60Qx_181 = getQ_7_Ir6d0tw_envto7w6l1(convItems_0, mem.i32(X60Qlf_19));
              add_2_sysvq0asl(cnv_0, X60Qx_181);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_19);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(cnv_0, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  var X60Qx_182 = len_4_sysvq0asl((() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1663204350);
    mem.setU32((_o + 4), strlit_0_I6882413722212972495_webzywwor1);
    return _o;
  })());
  var X60Qx_183 = len_4_sysvq0asl(checksum_0);
  var X60Qx_184 = len_4_sysvq0asl((() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I6897676049549612864_webzywwor1);
    return _o;
  })());
  var X60Qx_185 = len_4_sysvq0asl(exp_0);
  var X60Qx_186 = len_4_sysvq0asl((() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1663184126);
    mem.setU32((_o + 4), strlit_0_I8657126274509049065_webzywwor1);
    return _o;
  })());
  var X60Qx_187 = len_4_sysvq0asl(cnv_0);
  var X60Qx_188 = len_4_sysvq0asl((() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  var X60Qdesugar_24 = allocFixed(8);
  mem.copy(X60Qdesugar_24, newStringOfCap_0_sysvq0asl(((((((((((((X60Qx_182 + X60Qx_183) | 0) + X60Qx_184) | 0) + X60Qx_185) | 0) + X60Qx_186) | 0) + X60Qx_187) | 0) + X60Qx_188) | 0)), 8);
  add_2_sysvq0asl(X60Qdesugar_24, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1663204350);
    mem.setU32((_o + 4), strlit_0_I6882413722212972495_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_24, checksum_0);
  add_2_sysvq0asl(X60Qdesugar_24, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1696738558);
    mem.setU32((_o + 4), strlit_0_I6897676049549612864_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_24, exp_0);
  add_2_sysvq0asl(X60Qdesugar_24, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1663184126);
    mem.setU32((_o + 4), strlit_0_I8657126274509049065_webzywwor1);
    return _o;
  })());
  add_2_sysvq0asl(X60Qdesugar_24, cnv_0);
  add_2_sysvq0asl(X60Qdesugar_24, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 32001);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  nimStrDestroy(result_9);
  mem.copy(result_9, X60Qdesugar_24, 8);
  nimStrWasMoved(X60Qdesugar_24);
  nimStrDestroy(X60Qdesugar_24);
  nimStrDestroy(cnv_0);
  nimStrDestroy(exp_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(convItems_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(exportsItems_0);
  eQdestroy_1_nifb6mq6y1(buf_3);
  nimStrDestroy(checksum_0);
  return result_9;
  nimStrDestroy(X60Qdesugar_24);
  nimStrDestroy(cnv_0);
  nimStrDestroy(exp_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(convItems_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(exportsItems_0);
  eQdestroy_1_nifb6mq6y1(buf_3);
  nimStrDestroy(checksum_0);
  return result_9;
}

function rematerialize_0_webzywwor1(v_0) {
  forStmtLabel_0: {
    var result_10 = allocFixed(8);
    nimStrWasMoved(result_10);
    var s_10 = allocFixed(8);
    mem.copy(s_10, toStr_0_jsfc0lwq21(v_0), 8);
    nimStrDestroy(result_10);
    var X60Qx_189 = len_4_sysvq0asl(s_10);
    var X60Qx_190 = allocFixed(8);
    mem.copy(X60Qx_190, newString_0_sysvq0asl(X60Qx_189), 8);
    mem.copy(result_10, X60Qx_190, 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_20 = 0;
        var X60Qlf_21 = len_4_sysvq0asl(s_10);
        var X60Qlf_22 = allocFixed(4);
        mem.setI32(X60Qlf_22, X60Qlf_20);
        {
          while ((mem.i32(X60Qlf_22) < X60Qlf_21)) {
            {
              var X60Qx_191 = getQ_9_sysvq0asl(s_10, mem.i32(X60Qlf_22));
              putQ_9_sysvq0asl(result_10, mem.i32(X60Qlf_22), X60Qx_191);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_22);
          }
        }
      }
    }
  }
  nimStrDestroy(s_10);
  return result_10;
  nimStrDestroy(s_10);
  return result_10;
}

function alRun_0_webzywwor1() {
  let X60Qtmp_10 = allocFixed(4);
  mem.copy(X60Qtmp_10, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633640446);
    mem.setU32((_o + 4), strlit_0_I15164540674592437306_webzywwor1);
    return _o;
  })()), 4);
  let snif_0 = allocFixed(8);
  mem.copy(snif_0, toStr_0_jsfc0lwq21(X60Qtmp_10), 8);
  let X60Qtmp_11 = allocFixed(4);
  mem.copy(X60Qtmp_11, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633640446);
    mem.setU32((_o + 4), strlit_0_I11516840874723150973_webzywwor1);
    return _o;
  })()), 4);
  let cmd_0 = allocFixed(8);
  mem.copy(cmd_0, rematerialize_0_webzywwor1(X60Qtmp_11), 8);
  let X60Qtmp_12 = allocFixed(4);
  mem.copy(X60Qtmp_12, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633640446);
    mem.setU32((_o + 4), strlit_0_I14678923973705549773_webzywwor1);
    return _o;
  })()), 4);
  let arg_0 = allocFixed(8);
  mem.copy(arg_0, rematerialize_0_webzywwor1(X60Qtmp_12), 8);
  let X60Qtmp_13 = allocFixed(4);
  mem.copy(X60Qtmp_13, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633640446);
    mem.setU32((_o + 4), strlit_0_I3797851616484695037_webzywwor1);
    return _o;
  })()), 4);
  let modl_0 = allocFixed(8);
  mem.copy(modl_0, rematerialize_0_webzywwor1(X60Qtmp_13), 8);
  let X60Qx_4 = allocFixed(8);
  nimStrWasMoved(X60Qx_4);
  let X60Qx_192 = len_4_sysvq0asl(modl_0);
  if ((0 < X60Qx_192)) {
    nimStrDestroy(X60Qx_4);
    mem.copy(X60Qx_4, modl_0, 8);
    nimStrWasMoved(modl_0);
  } else {
    nimStrDestroy(X60Qx_4);
    mem.copy(X60Qx_4, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 7235842);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  }
  nimStrDestroy(gModule_0_webzywwor1);
  mem.copy(gModule_0_webzywwor1, X60Qx_4, 8);
  nimStrWasMoved(X60Qx_4);
  let outp_0 = allocFixed(8);
  mem.setU32(outp_0, 0);
  mem.setU32((outp_0 + 4), 0);
  let err_0 = allocFixed(8);
  mem.setU32(err_0, 0);
  mem.setU32((err_0 + 4), 0);
  let X60Qx_193 = eqQ_20_sysvq0asl(cmd_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1667589374);
    mem.setU32((_o + 4), strlit_0_I10769702410228802904_webzywwor1);
    return _o;
  })());
  if (X60Qx_193) {
    let buf_4 = allocFixed(16);
    mem.copy(buf_4, loadBufFromString_0_webzywwor1(snif_0), 16);
    nimStrDestroy(outp_0);
    let X60Qx_194 = allocFixed(8);
    mem.copy(X60Qx_194, runDecls_0_webzywwor1(buf_4, arg_0), 8);
    mem.copy(outp_0, X60Qx_194, 8);
    eQdestroy_1_nifb6mq6y1(buf_4);
  } else {
    let X60Qx_195 = eqQ_20_sysvq0asl(cmd_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1818321918);
      mem.setU32((_o + 4), strlit_0_I11377223362901306853_webzywwor1);
      return _o;
    })());
    if (X60Qx_195) {
      let buf_5 = allocFixed(16);
      mem.copy(buf_5, loadBufFromString_0_webzywwor1(snif_0), 16);
      nimStrDestroy(outp_0);
      let X60Qx_196 = allocFixed(8);
      mem.copy(X60Qx_196, runCalls_0_webzywwor1(buf_5, arg_0), 8);
      mem.copy(outp_0, X60Qx_196, 8);
      eQdestroy_1_nifb6mq6y1(buf_5);
    } else {
      let X60Qx_197 = eqQ_20_sysvq0asl(cmd_0, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1684957694);
        mem.setU32((_o + 4), strlit_0_I15907549540151602841_tagygirdh1);
        return _o;
      })());
      if (X60Qx_197) {
        nimStrDestroy(outp_0);
        let X60Qx_198 = allocFixed(8);
        mem.copy(X60Qx_198, runIndex_0_webzywwor1(snif_0), 8);
        mem.copy(outp_0, X60Qx_198, 8);
      } else {
        nimStrDestroy(err_0);
        let X60Qx_199 = allocFixed(8);
        mem.copy(X60Qx_199, ampQ_0_sysvq0asl((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1802401278);
          mem.setU32((_o + 4), strlit_0_I18430562373120102550_webzywwor1);
          return _o;
        })(), cmd_0), 8);
        mem.copy(err_0, X60Qx_199, 8);
      }
    }
  }
  let g_0 = allocFixed(4);
  mem.copy(g_0, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869375486);
    mem.setU32((_o + 4), strlit_0_I16664880105326712979_webzywwor1);
    return _o;
  })()), 4);
  let X60Qtmp_14 = allocFixed(4);
  mem.copy(X60Qtmp_14, toJs_3_jsfc0lwq21(outp_0), 4);
  set_0_jsfc0lwq21(g_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633640446);
    mem.setU32((_o + 4), strlit_0_I10392742912375124130_webzywwor1);
    return _o;
  })(), X60Qtmp_14);
  let X60Qtmp_15 = allocFixed(4);
  mem.copy(X60Qtmp_15, toJs_3_jsfc0lwq21(err_0), 4);
  set_0_jsfc0lwq21(g_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1633640446);
    mem.setU32((_o + 4), strlit_0_I947128178696304755_webzywwor1);
    return _o;
  })(), X60Qtmp_15);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_15);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_14);
  eQdestroy_0_jsfc0lwq21(g_0);
  nimStrDestroy(err_0);
  nimStrDestroy(outp_0);
  nimStrDestroy(X60Qx_4);
  nimStrDestroy(modl_0);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_13);
  nimStrDestroy(arg_0);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_12);
  nimStrDestroy(cmd_0);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_11);
  nimStrDestroy(snif_0);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_10);
}

function setLen_0_Iejjsiw_webzywwor1(s_14, newLen_2) {
  if ((newLen_2 < mem.i32(s_14))) {
    shrink_0_Iiotmvc_envto7w6l1(s_14, newLen_2);
  } else {
    whileStmtLabel_0: {
      var i_10 = allocFixed(4);
      mem.setI32(i_10, mem.i32(s_14));
      growUnsafe_0_Iejqx1p_webzywwor1(s_14, newLen_2);
      if ((mem.u32((s_14 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_10) < newLen_2)) {
          mem.copy((mem.u32((s_14 + 4)) + (mem.i32(i_10) * 8)), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 0);
            mem.setU32((_o + 4), 0);
            return _o;
          })(), 8);
          inc_1_I6wjjge_cmdqs323n1(i_10);
        }
      }
    }
  }
}

function newSeqUninit_0_I9y682m_webzywwor1(size_4) {
  let result_17 = allocFixed(8);
  if ((size_4 === 0)) {
    mem.copy(result_17, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_1 = memSizeInBytes_0_I5tamyv_webzywwor1(size_4);
    let X60Qx_208 = alloc_1_sysvq0asl(memSize_1);
    mem.copy(result_17, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), X60Qx_208);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_17 + 4)) === 0))) {
      let X60Qx_209 = allocFixed(8);
      mem.setU32(X60Qx_209, 1634036990);
      mem.setU32((X60Qx_209 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_17, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    }
  }
  return result_17;
}

function add_0_Ix7vhkh1_webzywwor1(s_18, elem_3) {
  let L_1 = mem.i32(s_18);
  let X60Qx_210 = capInBytes_0_Igonver1_webzywwor1(s_18);
  if ((X60Qx_210 < ((Math.imul(L_1, 12) + 12) | 0))) {
    let X60Qx_211 = resize_0_Il5xtfk1_webzywwor1(s_18, 1);
    if ((!X60Qx_211)) {
      eQdestroyQ_SX52outine0webzywwor1_0_webzywwor1(elem_3);
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_18);
  mem.copy((mem.u32((s_18 + 4)) + (L_1 * 12)), elem_3, 12);
}

function len_3_I1agyno_webzywwor1(s_20) {
  let result_18;
  result_18 = mem.i32(s_20);
  return result_18;
}

function getQ_7_Imb0b9r1_webzywwor1(s_21, i_12) {
  let X60Qx_212;
  if ((i_12 < mem.i32(s_21))) {
    X60Qx_212 = (0 <= i_12);
  } else {
    X60Qx_212 = false;
  }
  if ((!X60Qx_212)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_19;
  result_19 = (mem.u32((s_21 + 4)) + (i_12 * 12));
  return result_19;
}

function setLen_0_Ivb0eii_webzywwor1(s_22, newLen_5) {
  if ((newLen_5 < mem.i32(s_22))) {
    shrink_0_Ig04fun1_webzywwor1(s_22, newLen_5);
  } else {
    whileStmtLabel_0: {
      var i_13 = allocFixed(4);
      mem.setI32(i_13, mem.i32(s_22));
      growUnsafe_0_Itoe7gz_webzywwor1(s_22, newLen_5);
      if ((mem.u32((s_22 + 4)) === 0)) {
        return;
      }
      {
        while ((mem.i32(i_13) < newLen_5)) {
          mem.copy((mem.u32((s_22 + 4)) + (mem.i32(i_13) * 12)), (() => {
            var _o = allocFixed(12);
            mem.setI32(_o, 0);
            mem.copy((_o + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 0);
              mem.setU32((_o + 4), 0);
              return _o;
            })(), 8);
            return _o;
          })(), 12);
          inc_1_I6wjjge_cmdqs323n1(i_13);
        }
      }
    }
  }
}

function toOpenArray_1_I6b60gk1_webzywwor1(s_25) {
  let result_21 = allocFixed(8);
  let X60Qx_214 = rawData_0_I65w5sr_webzywwor1(s_25);
  mem.copy(result_21, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_214);
    mem.setI32((_o + 4), mem.i32(s_25));
    return _o;
  })(), 8);
  return result_21;
}

function growUnsafe_0_Iejqx1p_webzywwor1(s_29, newLen_9) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_9, 8);
  let newSize_0 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_218 = capInBytes_0_Ih2sbn01_cmdqs323n1(s_29);
  if ((X60Qx_218 < newSize_0)) {
    let X60Qx_219 = resize_0_I4buliy_cmdqs323n1(s_29, ((newLen_9 - mem.i32(s_29)) | 0));
    if ((!X60Qx_219)) {
      return;
    }
  }
  mem.setI32(s_29, newLen_9);
}

function memSizeInBytes_0_I5tamyv_webzywwor1(size_7) {
  let result_25;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_7, 12);
  result_25 = X60QconstRefTemp_0;
  if (false) {
    result_25 = 2147483647;
  }
  return result_25;
}

function capInBytes_0_Igonver1_webzywwor1(s_30) {
  let result_26;
  let X60Qx_6;
  if ((!(mem.u32((s_30 + 4)) === 0))) {
    let X60Qx_220 = allocatedSize_0_sysvq0asl(mem.u32((s_30 + 4)));
    X60Qx_6 = X60Qx_220;
  } else {
    X60Qx_6 = 0;
  }
  result_26 = X60Qx_6;
  return result_26;
}

function resize_0_Il5xtfk1_webzywwor1(dest_3, addedElements_3) {
  let result_27;
  let X60Qx_221 = capInBytes_0_Igonver1_webzywwor1(dest_3);
  let oldCap_1 = Math.trunc((X60Qx_221 / 12));
  let newCap_1 = recalcCap_0_sysvq0asl(oldCap_1, addedElements_3);
  let memSize_3 = memSizeInBytes_0_I5tamyv_webzywwor1(newCap_1);
  let X60Qx_222 = realloc_1_sysvq0asl(mem.u32((dest_3 + 4)), memSize_3);
  mem.setU32((dest_3 + 4), X60Qx_222);
  if ((mem.u32((dest_3 + 4)) === 0)) {
    mem.setI32(dest_3, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_3);
    result_27 = false;
  } else {
    result_27 = true;
  }
  return result_27;
}

function shrink_0_Ig04fun1_webzywwor1(s_31, newLen_10) {
  whileStmtLabel_0: {
    var i_16 = allocFixed(4);
    mem.setI32(i_16, ((mem.i32(s_31) - 1) | 0));
    {
      while ((newLen_10 <= mem.i32(i_16))) {
        eQdestroyQ_SX52outine0webzywwor1_0_webzywwor1((mem.u32((s_31 + 4)) + (mem.i32(i_16) * 12)));
        dec_1_I0nzoz91_envto7w6l1(i_16);
      }
    }
  }
  mem.setI32(s_31, newLen_10);
}

function growUnsafe_0_Itoe7gz_webzywwor1(s_32, newLen_11) {
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(newLen_11, 12);
  let newSize_1 = X60QconstRefTemp_0;
  if (false) {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](2147483647);
    return;
  }
  let X60Qx_223 = capInBytes_0_Igonver1_webzywwor1(s_32);
  if ((X60Qx_223 < newSize_1)) {
    let X60Qx_224 = resize_0_Il5xtfk1_webzywwor1(s_32, ((newLen_11 - mem.i32(s_32)) | 0));
    if ((!X60Qx_224)) {
      return;
    }
  }
  mem.setI32(s_32, newLen_11);
}

function rawData_0_I65w5sr_webzywwor1(s_33) {
  let result_28;
  result_28 = mem.u32((s_33 + 4));
  return result_28;
}

function eQdestroy_1_Iop3d8a1_webzywwor1(s_48) {
  if ((!(mem.u32((s_48 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_21 = allocFixed(4);
      mem.setI32(i_21, 0);
      {
        while ((mem.i32(i_21) < mem.i32(s_48))) {
          eQdestroyQ_SX52outine0webzywwor1_0_webzywwor1((mem.u32((s_48 + 4)) + (mem.i32(i_21) * 12)));
          inc_1_I6wjjge_cmdqs323n1(i_21);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_48 + 4)));
  }
}

function eQdestroyQ_SX52outine0webzywwor1_0_webzywwor1(dest_0) {
  nimStrDestroy((dest_0 + 4));
}

let X60QiniGuard_0_webzywwor1 = allocFixed(1);

function X60Qini_0_webzywwor1() {
  if (mem.u8At(X60QiniGuard_0_webzywwor1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_webzywwor1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_bitekkhcx1();
  X60Qini_0_nifb6mq6y1();
  X60Qini_0_vfsc9jn7();
  X60Qini_0_nifh7u8pu1();
  X60Qini_0_nif81dubp1();
  X60Qini_0_linxafkvx1();
  X60Qini_0_nifjp9lau1();
  X60Qini_0_symkyk35i1();
  X60Qini_0_jsovezijp1();
  X60Qini_0_jsfc0lwq21();
  alRun_0_webzywwor1();
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
// generated by lengc (js backend) from wid623gv.c.nif

let X60QiniGuard_0_wid623gv = allocFixed(1);

function X60Qini_0_wid623gv() {
  if (mem.u8At(X60QiniGuard_0_wid623gv)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_wid623gv, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from cmdqs323n1.c.nif

function newSeqUninit_0_Im3cqd9_cmdqs323n1(size_1) {
  let result_4 = allocFixed(8);
  if ((size_1 === 0)) {
    mem.copy(result_4, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_I7me00i_cmdqs323n1(size_1);
    let X60Qx_21 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_4, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), X60Qx_21);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_4 + 4)) === 0))) {
      let X60Qx_22 = allocFixed(8);
      mem.setU32(X60Qx_22, 1634036990);
      mem.setU32((X60Qx_22 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_4, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_4;
}

function inc_1_I6wjjge_cmdqs323n1(x_2) {
  mem.setI32(x_2, ((mem.i32(x_2) + 1) | 0));
}

function add_0_Ig6072n_cmdqs323n1(s_1, elem_1) {
  let L_0 = mem.i32(s_1);
  let X60Qx_23 = capInBytes_0_Ih2sbn01_cmdqs323n1(s_1);
  if ((X60Qx_23 < ((Math.imul(L_0, 8) + 8) | 0))) {
    let X60Qx_24 = resize_0_I4buliy_cmdqs323n1(s_1, 1);
    if ((!X60Qx_24)) {
      nimStrDestroy(elem_1);
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_1);
  mem.copy((mem.u32((s_1 + 4)) + (L_0 * 8)), elem_1, 8);
}

function memSizeInBytes_0_I7me00i_cmdqs323n1(size_3) {
  let result_6;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_3, 8);
  result_6 = X60QconstRefTemp_0;
  if (false) {
    result_6 = 2147483647;
  }
  return result_6;
}

function capInBytes_0_Ih2sbn01_cmdqs323n1(s_3) {
  let result_7;
  let X60Qx_1;
  if ((!(mem.u32((s_3 + 4)) === 0))) {
    let X60Qx_25 = allocatedSize_0_sysvq0asl(mem.u32((s_3 + 4)));
    X60Qx_1 = X60Qx_25;
  } else {
    X60Qx_1 = 0;
  }
  result_7 = X60Qx_1;
  return result_7;
}

function resize_0_I4buliy_cmdqs323n1(dest_1, addedElements_1) {
  let result_8;
  let X60Qx_26 = capInBytes_0_Ih2sbn01_cmdqs323n1(dest_1);
  let oldCap_0 = Math.trunc((X60Qx_26 / 8));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_1);
  let memSize_1 = memSizeInBytes_0_I7me00i_cmdqs323n1(newCap_0);
  let X60Qx_27 = realloc_1_sysvq0asl(mem.u32((dest_1 + 4)), memSize_1);
  mem.setU32((dest_1 + 4), X60Qx_27);
  if ((mem.u32((dest_1 + 4)) === 0)) {
    mem.setI32(dest_1, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    result_8 = false;
  } else {
    result_8 = true;
  }
  return result_8;
}

function eQdestroy_1_Ivioh0a_cmdqs323n1(s_6) {
  if ((!(mem.u32((s_6 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_4 = allocFixed(4);
      mem.setI32(i_4, 0);
      {
        while ((mem.i32(i_4) < mem.i32(s_6))) {
          nimStrDestroy((mem.u32((s_6 + 4)) + (mem.i32(i_4) * 8)));
          inc_1_I6wjjge_cmdqs323n1(i_4);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_6 + 4)));
  }
}

function eQwasMoved_1_I5vdnla_cmdqs323n1(s_7) {
  mem.setI32(s_7, 0);
  mem.setU32((s_7 + 4), 0);
}

let X60QiniGuard_0_cmdqs323n1 = allocFixed(1);

function X60Qini_0_cmdqs323n1() {
  if (mem.u8At(X60QiniGuard_0_cmdqs323n1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_cmdqs323n1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_wid623gv();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_pososrh1q1();
  X60Qini_0_str7j0ifg();
}
// generated by lengc (js backend) from ossk30t39.c.nif

let X60QiniGuard_0_ossk30t39 = allocFixed(1);

function X60Qini_0_ossk30t39() {
  if (mem.u8At(X60QiniGuard_0_ossk30t39)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_ossk30t39, true);
  X60Qini_0_sysvq0asl();
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
          inc_1_I6wjjge_cmdqs323n1(i_25);
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

function cExit_0_sysvq0asl(code_1) {
  _fns[mem.u32(gExitFlush_0_sysvq0asl)]();
  exit(code_1);
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
  dec_0_Ig5i8xp_nifb6mq6y1(fl_0, 6);
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
  dec_0_Ig5i8xp_nifb6mq6y1((a_11 + 5224), bytes_1);
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
  dec_0_Ig5i8xp_nifb6mq6y1(mem.u32((a_15 + 5220)), size_13);
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
    inc_1_I6wjjge_cmdqs323n1(it_0);
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
  dec_0_Ig5i8xp_nifb6mq6y1((a_26 + 5232), mem.i32(size_37));
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
  dec_0_Ig5i8xp_nifb6mq6y1((a_31 + 5236), mem.i32((c_10 + 4)));
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
  dec_0_Ig5i8xp_nifb6mq6y1((a_33 + 5236), mem.i32(total_0));
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
        dec_1_I0nzoz91_envto7w6l1(maxIters_0);
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
      dec_0_Ig5i8xp_nifb6mq6y1((a_37 + 5236), s_83);
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
    dec_0_Ig5i8xp_nifb6mq6y1(result_61, 20);
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

function readRawDataStable_0_sysvq0asl(s_45, start_1) {
  let result_107;
  let sl_11 = mem.u8At(s_45);
  let X60Qx_240;
  if ((0 < sl_11)) {
    X60Qx_240 = (sl_11 <= 6);
  } else {
    X60Qx_240 = false;
  }
  if (X60Qx_240) {
    transitionToLong_0_sysvq0asl(s_45, sl_11, sl_11);
  }
  let X60Qx_241 = rawData_1_sysvq0asl(s_45);
  result_107 = ((X60Qx_241 + start_1) >>> 0);
  return result_107;
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

function beginStore_0_sysvq0asl(s_47, newLen_7, start_2) {
  let result_108;
  let sl_13 = mem.u8At(s_47);
  let X60Qx_23;
  if ((6 < sl_13)) {
    X60Qx_23 = mem.i32(mem.u32((s_47 + 4)));
  } else {
    X60Qx_23 = sl_13;
  }
  let curLen_0 = X60Qx_23;
  let X60Qx_247;
  if ((newLen_7 <= 6)) {
    X60Qx_247 = (sl_13 <= 6);
  } else {
    X60Qx_247 = false;
  }
  if (X60Qx_247) {
    if ((!(newLen_7 === curLen_0))) {
      mem.setU8(s_47, (newLen_7 & 255));
    }
    result_108 = ((((s_47 + 1) >>> 0) + start_2) >>> 0);
  } else {
    if ((sl_13 <= 6)) {
      transitionToLong_0_sysvq0asl(s_47, curLen_0, newLen_7);
      result_108 = (((mem.u32((s_47 + 4)) + 12) + start_2) >>> 0);
    } else {
      ensureUniqueLong_0_sysvq0asl(s_47, curLen_0, newLen_7);
      result_108 = (((mem.u32((s_47 + 4)) + 12) + start_2) >>> 0);
    }
  }
  return result_108;
}

function endStore_0_sysvq0asl(s_48) {
  if ((6 < mem.u8At(s_48))) {
    copyMem_0_sysvq0asl(((s_48 + 1) >>> 0), (mem.u32((s_48 + 4)) + 12), 3);
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

function swarCharMask_0_sysvq0asl(n_2) {
  let result_119;
  result_119 = ((((((1 << Math.imul(n_2, 8)) >>> 0) - 1) >>> 0) << 8) >>> 0);
  return result_119;
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
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_5);
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

function startsWithImpl_0_sysvq0asl(s_59, prefix_0) {
  let result_131;
  let pbytes_0 = mem.u32(prefix_0);
  let pslen_0 = ssLenOf_0_sysvq0asl(pbytes_0);
  let sbytes_0 = mem.u32(s_59);
  let sslen_0 = ssLenOf_0_sysvq0asl(sbytes_0);
  let X60Qx_292 = min_2_sysvq0asl(pslen_0, 3);
  let charMask_0 = swarCharMask_0_sysvq0asl(X60Qx_292);
  if ((!(((sbytes_0 & charMask_0) >>> 0) === ((pbytes_0 & charMask_0) >>> 0)))) {
    return false;
  }
  let X60Qx_33;
  if ((6 < sslen_0)) {
    X60Qx_33 = mem.i32(mem.u32((s_59 + 4)));
  } else {
    X60Qx_33 = sslen_0;
  }
  let sLen_3 = X60Qx_33;
  let X60Qx_34;
  if ((6 < pslen_0)) {
    X60Qx_34 = mem.i32(mem.u32((prefix_0 + 4)));
  } else {
    X60Qx_34 = pslen_0;
  }
  let pLen_0 = X60Qx_34;
  if ((sLen_3 < pLen_0)) {
    return false;
  }
  if ((pLen_0 <= 3)) {
    return true;
  }
  let X60Qx_35;
  if ((6 < sslen_0)) {
    X60Qx_35 = (((mem.u32((s_59 + 4)) + 12) + 3) >>> 0);
  } else {
    X60Qx_35 = ((((s_59 + 1) >>> 0) + 3) >>> 0);
  }
  let sTail_0 = X60Qx_35;
  let X60Qx_36;
  if ((6 < pslen_0)) {
    X60Qx_36 = (((mem.u32((prefix_0 + 4)) + 12) + 3) >>> 0);
  } else {
    X60Qx_36 = ((((prefix_0 + 1) >>> 0) + 3) >>> 0);
  }
  let pTail_0 = X60Qx_36;
  let X60Qx_293 = cmpMem_0_sysvq0asl(sTail_0, pTail_0, ((pLen_0 - 3) | 0));
  result_131 = (X60Qx_293 === 0);
  return result_131;
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

function toOpenArray_2_sysvq0asl(s_67) {
  let result_146 = allocFixed(8);
  let X60Qx_316 = readRawData_0_sysvq0asl(s_67, 0);
  let X60Qx_317 = len_4_sysvq0asl(s_67);
  mem.copy(result_146, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_316);
    mem.setI32((_o + 4), X60Qx_317);
    return _o;
  })(), 8);
  return result_146;
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
// generated by lengc (js backend) from bitekkhcx1.c.nif

function nextTry_0_bitekkhcx1(h_0, maxHash_0) {
  let result_0;
  result_0 = ((((h_0 + 1) >>> 0) & maxHash_0) >>> 0);
  return result_0;
}

function mustRehash_0_bitekkhcx1(length_0, counter_0) {
  let result_1;
  if ((!(counter_0 < length_0))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  let X60Qx_0;
  if ((length_0 < ((Math.trunc((counter_0 / 2)) + counter_0) | 0))) {
    X60Qx_0 = true;
  } else {
    X60Qx_0 = (((length_0 - counter_0) | 0) < 4);
  }
  result_1 = X60Qx_0;
  return result_1;
}

let X60QiniGuard_0_bitekkhcx1 = allocFixed(1);

function X60Qini_0_bitekkhcx1() {
  if (mem.u8At(X60QiniGuard_0_bitekkhcx1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_bitekkhcx1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_has9tn57v();
  X60Qini_0_assy765wm();
}
// generated by lengc (js backend) from has9tn57v.c.nif

function emarkQampQ_0_has9tn57v(h_0, val_0) {
  let result_0;
  result_0 = ((h_0 + val_0) >>> 0);
  result_0 = ((result_0 + ((result_0 << 10) >>> 0)) >>> 0);
  result_0 = ((result_0 ^ (result_0 >>> 6)) >>> 0);
  return result_0;
}

function emarkQdollarQ_0_has9tn57v(h_1) {
  let result_1;
  result_1 = ((h_1 + ((h_1 << 3) >>> 0)) >>> 0);
  result_1 = ((result_1 ^ (result_1 >>> 11)) >>> 0);
  result_1 = ((result_1 + ((result_1 << 15) >>> 0)) >>> 0);
  return result_1;
}

function hash_1_has9tn57v(s_0) {
  forStmtLabel_0: {
    var result_2;
    result_2 = 0;
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = allocFixed(8);
        mem.copy(X60Qlf_0, toOpenArray_2_sysvq0asl(s_0), 8);
        var X60Qlf_1 = allocFixed(4);
        mem.setI32(X60Qlf_1, 0);
        {
          while (true) {
            var X60Qx_0 = len_6_Iroq7kd1_has9tn57v(X60Qlf_0);
            if ((mem.i32(X60Qlf_1) < X60Qx_0)) {
              {
                var X60Qii_2 = getQ_10_I5nt6we_has9tn57v(X60Qlf_0, mem.i32(X60Qlf_1));
                var X60Qx_1 = emarkQampQ_0_has9tn57v(result_2, mem.u8At(X60Qii_2));
                result_2 = X60Qx_1;
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_1);
            } else {
              break;
            }
          }
        }
      }
    }
  }
  var X60Qx_2 = emarkQdollarQ_0_has9tn57v(result_2);
  result_2 = X60Qx_2;
  return result_2;
}

function hash_3_has9tn57v(x_0) {
  let result_4;
  result_4 = Number(BigInt.asUintN(32, x_0));
  return result_4;
}

function hash_4_has9tn57v(x_1) {
  let result_5;
  result_5 = Number(BigInt.asUintN(32, x_1));
  return result_5;
}

function len_6_Iroq7kd1_has9tn57v(a_6) {
  let result_19;
  result_19 = mem.i32((a_6 + 4));
  return result_19;
}

function getQ_10_I5nt6we_has9tn57v(x_15, idx_1) {
  let X60Qx_19;
  if ((0 <= idx_1)) {
    X60Qx_19 = (idx_1 < mem.i32((x_15 + 4)));
  } else {
    X60Qx_19 = false;
  }
  if ((!X60Qx_19)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_20;
  result_20 = (mem.u32(x_15) + idx_1);
  return result_20;
}

let X60QiniGuard_0_has9tn57v = allocFixed(1);

function X60Qini_0_has9tn57v() {
  if (mem.u8At(X60QiniGuard_0_has9tn57v)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_has9tn57v, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from syn1lfpjv.c.nif

function write_0_syn1lfpjv(f_6, s_0) {
  let X60Qx_2 = readRawData_0_sysvq0asl(s_0, 0);
  let X60Qx_3 = len_4_sysvq0asl(s_0);
  let X60Qx_4 = fwrite(X60Qx_2, 1, X60Qx_3, f_6);
}

function write_7_syn1lfpjv(f_13, c_1) {
  let X60Qx_5 = fputc(c_1, f_13);
}

function quit_0_syn1lfpjv(value_0) {
  cExit_0_sysvq0asl(value_0);
}

function quit_1_syn1lfpjv(msg_0) {
  write_0_syn1lfpjv(stdout, msg_0);
  write_7_syn1lfpjv(stdout, 10);
  quit_0_syn1lfpjv(1);
}

let X60QiniGuard_0_syn1lfpjv = allocFixed(1);

function X60Qini_0_syn1lfpjv() {
  if (mem.u8At(X60QiniGuard_0_syn1lfpjv)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_syn1lfpjv, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_for2ybv4p1();
}
// generated by lengc (js backend) from vfsc9jn7.c.nif

function initBlob_0_vfsc9jn7(data_0, size_0, cookie_0, cleanup_0) {
  let result_6 = allocFixed(32);
  mem.copy(result_6, (() => {
    let _o = allocFixed(32);
    mem.setU32(_o, data_0);
    mem.setI32((_o + 4), size_0);
    mem.copy((_o + 8), (() => {
      let _o = allocFixed(16);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      mem.setI32((_o + 8), 0);
      mem.setI32((_o + 12), 0);
      return _o;
    })(), 16);
    mem.setU32((_o + 24), cookie_0);
    mem.setU32((_o + 28), cleanup_0);
    return _o;
  })(), 32);
  return result_6;
}

function closeBlob_0_vfsc9jn7(b_2) {
  if ((!(mem.u32((b_2 + 28)) === 0))) {
    _fns[mem.u32((b_2 + 28))](b_2);
  }
  mem.setU32(b_2, 0);
  mem.setI32((b_2 + 4), 0);
  mem.copy((b_2 + 8), (() => {
    let _o = allocFixed(16);
    mem.setU32(_o, 0);
    mem.setI32((_o + 4), 0);
    mem.setI32((_o + 8), 0);
    mem.setI32((_o + 12), 0);
    return _o;
  })(), 16);
  mem.setU32((b_2 + 24), 0);
  mem.setU32((b_2 + 28), 0);
}

let X60QiniGuard_0_vfsc9jn7 = allocFixed(1);

function X60Qini_0_vfsc9jn7() {
  if (mem.u8At(X60QiniGuard_0_vfsc9jn7)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_vfsc9jn7, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_memlzdyby();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_timsagyye1();
  X60Qini_0_oswd7dmm();
  X60Qini_0_cmdqs323n1();
  X60Qini_0_ospaexnw61();
  X60Qini_0_osalirkw71();
  X60Qini_0_osc4bsu0d1();
  X60Qini_0_ossk30t39();
  X60Qini_0_dir38pj6l();
  X60Qini_0_pat4k2dls();
}
