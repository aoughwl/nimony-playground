// engine.js — the client-side execution seam.
//
// This is the ONLY place that talks to the compiled nimony interpreter (`nifi`,
// built to JavaScript by aoughwl/nimony-web). It exposes window.NifiEngine.run,
// which the page calls with { source, example }.
//
// Wiring model (filled in as the pieces land):
//   Tier 1  — window.NifiCore.runSnif(bytes) : {stdout,stderr,exitCode}
//             runs a PRE-COMPILED .s.nif (shipped as an asset) fully in-tab.
//   Tier 2  — window.NifiCore.compileAndRun(source) : same shape
//             once nifler+nimsem are ported to JS, arbitrary source runs live.
//
// Until nifi.js is dropped in, this stub keeps the UI honest and functional.
(function(){
  const engine = { ready:false, tier:0, run:null };

  async function fetchSnif(name){
    const r = await fetch("assets/snif/" + name);
    if(!r.ok) throw new Error("could not load bytecode asset: " + name);
    return await r.text(); // .s.nif is a text NIF stream
  }

  async function run(req){
    const core = window.NifiCore;
    // Tier 2: live compile of whatever is in the editor.
    if(core && typeof core.compileAndRun === "function"){
      return core.compileAndRun(req.source);
    }
    // Tier 1: run the example's pre-compiled bytecode.
    if(core && typeof core.runSnif === "function"){
      if(!req.example || !req.example.snif)
        return { stdout:"", stderr:"This example has no pre-compiled bytecode yet.", exitCode:1 };
      const bytes = await fetchSnif(req.example.snif);
      return core.runSnif(bytes);
    }
    // No engine yet.
    return {
      stdout:"",
      stderr:"Interpreter (nifi.js) not loaded yet — the browser engine is still being built.\n"+
             "The UI, editor, and examples are live; execution wires in when nifi.js lands.",
      exitCode:1
    };
  }

  function detect(){
    const core = window.NifiCore;
    if(core && (core.compileAndRun || core.runSnif)){
      engine.ready = true;
      engine.tier = core.compileAndRun ? 2 : 1;
    } else {
      engine.ready = true; // UI is usable; run() reports the missing engine clearly
      engine.tier = 0;
    }
    engine.run = run;
    window.NifiEngine = engine;
    if(window.__nifiEngineReady) window.__nifiEngineReady(true);
    if(window.__nifiLspStatus) window.__nifiLspStatus("off");
  }

  // nifi.js (when present) should set window.NifiCore then dispatch this event,
  // or simply be loaded before engine.js.
  window.addEventListener("nificore-ready", detect);
  if(document.readyState !== "loading") detect();
  else document.addEventListener("DOMContentLoaded", detect);
})();
