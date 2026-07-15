// offline.js — wires the header "⤓ Offline copy" button. On click it fetches
// every asset the playground needs, hands them to NifiAssemble.assembleStandalone
// (shared with build-standalone.sh), and downloads ONE self-contained .html that
// runs from a file:// URL with no server. Uses only assets already served from
// this origin, so it works on the live site (online). Inside an already-offline
// copy (window.__NIFI_INLINE set) the button hides — you're already in it.
(function(){
  "use strict";

  // External app scripts, in index.html order. Kept here (not derived from the
  // DOM) so the download is deterministic even after the page mutates.
  var APP_SCRIPTS = ["examples.js","pipeline.js","engine.js","parser.js","sem.js",
                     "editor.js","lsp.js","curlyconvert.js","assemble.js","offline.js"];
  var BUNDLES = ["worker.js","nifparser.js","nimsem.js","nifi.js","nifi_vm.js","nifi_run.js","nifjs.js"];

  // ArrayBuffer -> base64, chunked so String.fromCharCode doesn't blow the call
  // stack on the ~4.9 MB stdlib blob.
  function bufToB64(buf){
    var u = new Uint8Array(buf), s = "", CH = 0x8000;
    for(var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(s);
  }
  function txt(url){ return fetch(url).then(function(r){ if(!r.ok) throw new Error(url+" HTTP "+r.status); return r.text(); }); }
  function buf(url){ return fetch(url).then(function(r){ if(!r.ok) throw new Error(url+" HTTP "+r.status); return r.arrayBuffer(); }); }

  function gather(){
    return Promise.all([
      txt("index.html"),
      Promise.all(APP_SCRIPTS.map(txt)),
      Promise.all(BUNDLES.map(txt)),
      buf("assets/nimsem-stdlib.bin"),
      buf("../assets/aoughwl-logo-white.png"),
      buf("/favicon.ico").catch(function(){ return null; })
    ]).then(function(r){
      var indexHtml = r[0], scriptsArr = r[1], bundlesArr = r[2];
      var scripts = {}; APP_SCRIPTS.forEach(function(n,i){ scripts[n] = scriptsArr[i]; });
      var bundles = {}; BUNDLES.forEach(function(n,i){ bundles[n] = bundlesArr[i]; });
      return {
        indexHtml: indexHtml, scripts: scripts, bundles: bundles,
        stdlibB64: bufToB64(r[3]),
        logoB64: bufToB64(r[4]),
        faviconB64: r[5] ? bufToB64(r[5]) : null
      };
    });
  }

  function download(html){
    var blob = new Blob([html], { type:"text/html" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "playground-standalone.html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 8000);
  }

  function wire(){
    var btn = document.getElementById("offlineBtn");
    if(!btn) return;
    // Already inside the offline single-file copy: nothing to download.
    if(window.__NIFI_INLINE){ btn.style.display = "none"; return; }
    var orig = btn.innerHTML, busy = false;
    btn.addEventListener("click", function(){
      if(busy) return; busy = true;
      var restore = function(){ btn.innerHTML = orig; btn.disabled = false; busy = false; };
      btn.disabled = true; btn.innerHTML = "…";
      gather()
        .then(function(a){ return window.NifiAssemble.assembleStandalone(a.indexHtml, a); })
        .then(function(html){
          download(html);
          btn.innerHTML = "✓";
          setTimeout(restore, 1400);
        })
        .catch(function(e){
          btn.innerHTML = "✕";
          try{ if(window.NifiUI && window.NifiUI.toast) window.NifiUI.toast("Offline build failed: " + (e && e.message || e)); }catch(_){}
          setTimeout(restore, 1800);
        });
    });
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
