// assemble.js — the single source of truth for building the self-contained,
// offline single-file playground. Pure string transforms, so it runs unchanged
// in the browser (the "Offline copy" button, via window.NifiAssemble) AND in
// Node (build-standalone.sh, via module.exports).
//
// It takes the live index.html plus every asset and returns ONE HTML document
// that runs from a file:// URL with no server and no network:
//   * external <script src> files are inlined
//   * the five wasm-free JS bundles + worker.js are embedded as <script
//     type="text/plain"> blocks and re-exposed on window.__NIFI_INLINE, so the
//     worker (built from a Blob URL) and the main-thread parser read them
//     instead of fetch()ing (which a file:// page can't do)
//   * the nimsem stdlib blob, the aoughwl logo, and the favicon become data URIs
//
// Monaco still comes from its CDN when online; offline it falls back to the
// built-in textarea editor (editor.js handles that), so the file always works.
(function(global){
  "use strict";

  // Guard against a bundle/script that literally contains "</script" closing an
  // inline <script> early. `text/plain` blocks and real <script> bodies both
  // need it; "<\/script" is an equivalent escape inside JS and harmless as text.
  function guard(s){ return String(s == null ? "" : s).replace(/<\/script/gi, "<\\/script"); }

  function textBlock(id, text){
    return '<script type="text/plain" id="' + id + '">' + guard(text) + '</scr' + 'ipt>\n';
  }

  // Order of the external app scripts must match index.html. Bundles are the
  // heavy compiled artifacts that get embedded (worker.js included — it is
  // loaded via `new Worker`, not a <script src>, so it only lives in the blocks).
  var BUNDLE_IDS = {
    "worker.js":    "nifi-b-worker",
    "nifparser.js": "nifi-b-nifparser",
    "nimsem.js":    "nifi-b-nimsem",
    "nifi.js":      "nifi-b-nifi",
    "nifi_vm.js":   "nifi-b-nifi_vm",
    "nifi_run.js":  "nifi-b-nifi_run",
    "nifjs.js":     "nifi-b-nifjs",
    "aowlts.js":    "nifi-b-aowlts",
    "aowlpy.js":    "nifi-b-aowlpy",
    "aowlsem.js":   "nifi-b-aowlsem",     // experimental sem checker (worker reads it)
    "aowlsuggest.js":"nifi-b-aowlsuggest" // quick-fix engine (main thread, via suggest.js)
  };

  // assets = {
  //   scripts:   { "editor.js": "<source>", ... }   external <script src> files
  //   bundles:   { "worker.js": "<source>", "nifi.js": ... }  (see BUNDLE_IDS)
  //   stdlibB64: "<base64 of assets/nimsem-stdlib.bin>"
  //   logoB64:   "<base64 of aoughwl-logo-white.png>"
  //   faviconB64:"<base64 of favicon.ico>"  (optional)
  // }
  function assembleStandalone(indexHtml, assets){
    var html = String(indexHtml);
    var scripts = assets.scripts || {};
    var bundles = assets.bundles || {};

    // 1. Inline each external <script src="name?v=..."></script> in place.
    html = html.replace(/<script\s+src="([^"?]+)(?:\?[^"]*)?"\s*>\s*<\/script>/gi,
      function(m, name){
        if(scripts[name] == null) return m;      // unknown/CDN: leave as-is
        return '<script>\n/* inlined: ' + name + ' */\n' + guard(scripts[name]) + '\n</scr' + 'ipt>';
      });

    // 2. Images -> data URIs. The logo is a CSS mask (../assets/...png); the
    //    favicon is an absolute /favicon.ico. Both break on file://.
    //    NB: all replacements here use FUNCTION replacers, never string ones —
    //    the bundles/base64 contain "$&", "$'", "$`" sequences that
    //    String.replace would otherwise interpret (that "$'" = rest-of-string
    //    splice is what scrambled the block order and double-loaded Monaco).
    if(assets.logoB64){
      var logoURI = "data:image/png;base64," + assets.logoB64;
      html = html.replace(/\.\.\/assets\/aoughwl-logo-white\.png/g, function(){ return logoURI; });
    }
    if(assets.faviconB64){
      var favURI = "data:image/x-icon;base64," + assets.faviconB64;
      html = html.replace(/(?:\.\.)?\/favicon\.ico/g, function(){ return favURI; });
    }

    // 3. Embed the bundles + stdlib and expose them on window.__NIFI_INLINE,
    //    injected right after <head> so it runs before the inlined app scripts.
    var blocks = "\n<!-- offline single-file assets (generated) -->\n";
    Object.keys(BUNDLE_IDS).forEach(function(name){
      blocks += textBlock(BUNDLE_IDS[name], bundles[name]);
    });
    blocks += textBlock("nifi-b-stdlib", assets.stdlibB64 || "");
    var boot =
      '<script>window.__NIFI_INLINE=(function(){' +
      'function t(id){var e=document.getElementById(id);return e?e.textContent:null;}' +
      'return{workerText:t("nifi-b-worker"),bundles:{' +
        '"nifparser.js":t("nifi-b-nifparser"),"nimsem.js":t("nifi-b-nimsem"),' +
        '"nifi.js":t("nifi-b-nifi"),"nifi_vm.js":t("nifi-b-nifi_vm"),' +
        '"nifi_run.js":t("nifi-b-nifi_run"),"nifjs.js":t("nifi-b-nifjs"),' +
        '"aowlts.js":t("nifi-b-aowlts"),"aowlpy.js":t("nifi-b-aowlpy"),' +
        '"aowlsem.js":t("nifi-b-aowlsem"),"aowlsuggest.js":t("nifi-b-aowlsuggest")},' +
      'stdlibB64:t("nifi-b-stdlib")};})();</scr' + 'ipt>\n';

    var inject = "<head>" + blocks + boot;   // built once; function replacer avoids $-interpretation
    if(/<head>/i.test(html)) html = html.replace(/<head>/i, function(){ return inject; });
    else html = blocks + boot + html;
    return html;
  }

  var api = { assembleStandalone: assembleStandalone };
  if(typeof module !== "undefined" && module.exports) module.exports = api;
  if(global) global.NifiAssemble = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
