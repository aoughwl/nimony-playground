// stdmount.js — mounts the nimony standard library as a read-only "std" project
// so you can click into system / syncio / os / … and read the real source (goal
// #5). The source ships as one JSON asset (assets/stdlib-src.json: path->text)
// and is fetched lazily (deferred after boot, or on demand when a go-to-def
// lands in std) so the initial page load isn't taxed with ~1.5 MB.
(function(){
  const ws = () => window.AowliWorkspace;
  let loading = null, mounted = false;

  function ensure(){
    if(mounted) return Promise.resolve(stdProject());
    if(loading) return loading;
    const inline = (typeof window !== "undefined" && window.__NIFI_INLINE);
    const src = (inline && inline.stdlibSrc)
      ? Promise.resolve(inline.stdlibSrc)
      : fetch("assets/stdlib-src.json").then(r=>{ if(!r.ok) throw new Error("stdlib-src HTTP "+r.status); return r.json(); });
    loading = src.then(files => {
      // Don't duplicate if a persisted std project somehow survived.
      if(!stdProject()){
        ws().addProject({ name:"std", kind:"std", readonly:true, open:true, files });
      }
      mounted = true;
      return stdProject();
    }).catch(e=>{ loading = null; throw e; });
    return loading;
  }
  function stdProject(){ return ws().projectByName("std"); }

  // Map a bare module name (e.g. "syncio", "std/os") to a std file path and open
  // it. Returns true if it landed. Used by the LSP go-to-definition glue when a
  // definition resolves to a stdlib module.
  async function openModule(name){
    await ensure();
    const proj = stdProject(); if(!proj) return false;
    const base = String(name).split("/").pop().replace(/\.(nim|aowl)$/,"");
    const files = ws().fileList(proj.id);
    // exact std/<base>.nim first, then any */<base>.nim
    let hit = files.find(p => p === "std/" + base + ".nim")
           || files.find(p => p.endsWith("/" + base + ".nim"))
           || files.find(p => p.endsWith(base + ".nim"));
    if(!hit) return false;
    ws().openFile(proj.id, hit, true);
    return true;
  }

  // Synchronous open — only works once std is mounted (returns true/false). Used
  // by go-to-definition, which needs to resolve the jump synchronously; std is
  // pre-warmed on boot so it is normally already mounted by first use.
  function openModuleSync(name){
    if(!mounted) return false;
    const proj = stdProject(); if(!proj) return false;
    const base = String(name).split("/").pop().replace(/\.(nim|aowl)$/,"");
    const files = ws().fileList(proj.id);
    const hit = files.find(p => p === "std/" + base + ".nim")
             || files.find(p => p.endsWith("/" + base + ".nim"))
             || files.find(p => p.endsWith(base + ".nim"));
    if(!hit) return false;
    ws().openFile(proj.id, hit, true);
    return true;
  }

  window.AowliStd = { ensure, openModule, openModuleSync, isMounted: ()=>mounted };

  // Defer the actual fetch until the app is idle so first paint / first parse win
  // the network. Browsing std is opt-in-ish; but pre-warming makes go-to-def and
  // the tree instant when the user does reach for it.
  function warm(){
    const go = ()=> ensure().catch(()=>{});
    if("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 4000 });
    else setTimeout(go, 2500);
  }
  window.AowliStdWarm = warm;
})();
