// gitclone.js — clone a remote git repository into a workspace project, entirely
// client-side. Uses the GitHub REST API (which sends permissive CORS headers) to
// list the tree, then fetches each blob from raw.githubusercontent.com (also
// CORS-open, and NOT counted against the 60/hr unauthenticated API budget — only
// the two metadata calls are). Non-GitHub hosts are not reachable from a static
// page without a proxy, so we surface a clear message for those.
(function(){
  const ws = () => window.AowliWorkspace;

  // File kinds we import as text (source + config + docs). Binary/huge blobs are
  // skipped so a clone stays a browsable, compilable source tree.
  const TEXT_EXT = /\.(nim|aowl|nims|nimble|cfg|nif|aif|md|markdown|txt|json|c|h|cpp|hpp|js|mjs|ts|py|toml|yml|yaml|rst|ini|sh)$/i;
  const MAX_FILES = 600;
  const MAX_BLOB = 512 * 1024;         // 512 KB per file
  const SKIP_DIR = /(^|\/)(\.git|node_modules|\.github\/workflows|dist|build|bin|nimcache)(\/|$)/i;

  // Parse many URL shapes: https://github.com/o/r(.git), git@github.com:o/r.git,
  // o/r, and .../tree/<branch>/<subpath>.
  function parse(url){
    let u = String(url||"").trim();
    u = u.replace(/^git@github\.com:/, "https://github.com/");
    u = u.replace(/\.git$/, "");
    let m = u.match(/github\.com[/:]([^/]+)\/([^/#?]+)(?:\/tree\/([^/#?]+)(?:\/(.*))?)?/i);
    if(!m){
      // bare "owner/repo[/tree/branch]"
      m = u.match(/^([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+)(?:\/(.*))?)?$/);
      if(!m) return null;
    }
    return { owner:m[1], repo:m[2], branch:m[3]||null, subpath:(m[4]||"").replace(/\/$/,"") };
  }

  async function ghJson(path){
    const r = await fetch("https://api.github.com/" + path, { headers:{ "Accept":"application/vnd.github+json" } });
    if(r.status === 403){ const b = await r.text().catch(()=> ""); throw new Error("GitHub API rate limit (60/hr unauthenticated). " + (b.includes("rate limit")?"Try again later.":"")); }
    if(r.status === 404) throw new Error("repository (or branch) not found — check the URL");
    if(!r.ok) throw new Error("GitHub API HTTP " + r.status);
    return r.json();
  }

  // Clone into a NEW project (or into an existing one when reproj is given).
  async function clone(url, onProgress, reproj){
    const info = parse(url);
    if(!info){
      if(/^https?:\/\//i.test(url) && !/github\.com/i.test(url))
        throw new Error("Only github.com repos can be cloned from a static page (other hosts need a git proxy). Paste a github.com URL.");
      throw new Error("could not parse that as a GitHub URL or owner/repo");
    }
    onProgress && onProgress("resolving " + info.owner + "/" + info.repo + "…");
    let branch = info.branch;
    if(!branch){ const meta = await ghJson(`repos/${info.owner}/${info.repo}`); branch = meta.default_branch || "main"; }

    onProgress && onProgress("listing files (" + branch + ")…");
    const tree = await ghJson(`repos/${info.owner}/${info.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if(!tree.tree) throw new Error("empty or unreadable tree");

    const sub = info.subpath ? info.subpath.replace(/\/$/,"") + "/" : "";
    let blobs = tree.tree.filter(e => e.type === "blob"
      && (!sub || e.path.startsWith(sub))
      && TEXT_EXT.test(e.path)
      && !SKIP_DIR.test(e.path)
      && (e.size == null || e.size <= MAX_BLOB));
    if(tree.truncated) onProgress && onProgress("⚠ tree truncated by GitHub — importing the first slice");
    if(blobs.length > MAX_FILES) blobs = blobs.slice(0, MAX_FILES);
    if(!blobs.length) throw new Error("no importable text/source files found in that repo/subpath");

    // Fetch blob contents from raw.githubusercontent (CORS-open, no rate limit).
    const files = {};
    let done = 0;
    const CONC = 8;
    async function worker(items){
      for(const e of items){
        const raw = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${encodeURIComponent(branch)}/${e.path.split("/").map(encodeURIComponent).join("/")}`;
        try{
          const r = await fetch(raw);
          if(r.ok){
            const txt = await r.text();
            const rel = sub ? e.path.slice(sub.length) : e.path;
            files[rel] = txt;
          }
        }catch(_){ /* skip a blob that won't fetch */ }
        done++;
        if(done % 10 === 0 || done === blobs.length) onProgress && onProgress("fetching " + done + "/" + blobs.length + " files…");
      }
    }
    const chunks = Array.from({length:CONC}, (_,i)=> blobs.filter((_,j)=> j % CONC === i));
    await Promise.all(chunks.map(worker));

    if(!Object.keys(files).length) throw new Error("could not fetch any file contents");

    const projName = (info.subpath ? info.subpath.split("/").pop() : info.repo);
    if(reproj){
      reproj.files.clear();
      for(const [k,v] of Object.entries(files)) reproj.files.set(k.replace(/^\/+/,""), { content:v });
      ws().saveNow(); ws()._listeners && null;
      // re-emit
      ws().addProject; // noop to keep linter calm
      forceEmit();
      onProgress && onProgress("re-cloned " + Object.keys(files).length + " files");
      return reproj;
    }
    const proj = ws().addProject({ name: projName, kind: "git", remote: url, files });
    onProgress && onProgress("cloned " + Object.keys(files).length + " files");
    // open a sensible entry file
    const entry = pickEntry(proj);
    if(entry) ws().openFile(proj.id, entry, true);
    return proj;
  }
  function forceEmit(){ /* workspace save() already emits on addProject; for reclone poke a write */
    const W = ws(); if(W && W.projects.length){ W.saveNow(); W.onChange && (function(){ /* trigger via a noop write */ })(); }
    // simplest: re-run explorer render
    if(window.AowliExplorer) window.AowliExplorer.render();
  }
  function pickEntry(proj){
    const files = ws().fileList(proj.id);
    const pref = [ /(^|\/)main\.nim$/i, new RegExp("(^|/)"+proj.name+"\\.nim$","i"),
                   /(^|\/)src\/[^/]+\.nim$/i, /\.nim$/i, /readme\.md$/i ];
    for(const re of pref){ const f = files.find(p=>re.test(p)); if(f) return f; }
    return files[0] || null;
  }

  // ---- dialog UI ------------------------------------------------------------
  let modal = null;
  function ensureModal(){
    if(modal) return modal;
    modal = document.createElement("div");
    modal.className = "fx-modal";
    modal.innerHTML =
      '<div class="fx-dlg">' +
        '<h3>Clone a git repository</h3>' +
        '<p>Paste a public GitHub URL (or <code>owner/repo</code>). Files are fetched client-side and added as a project you can import from. A <code>/tree/branch/subdir</code> suffix clones just that subtree.</p>' +
        '<div class="fx-field"><input type="text" id="gc-url" placeholder="https://github.com/aoughwl/aowllib" autocomplete="off" spellcheck="false"></div>' +
        '<div class="fx-dlgmsg" id="gc-msg"></div>' +
        '<div class="fx-dlgact"><button id="gc-cancel">Cancel</button><button id="gc-go" class="primary">Clone</button></div>' +
      '</div>';
    document.body.appendChild(modal);
    const urlEl = modal.querySelector("#gc-url");
    const msgEl = modal.querySelector("#gc-msg");
    const goBtn = modal.querySelector("#gc-go");
    const setMsg = (t,err)=>{ msgEl.textContent = t||""; msgEl.className = "fx-dlgmsg"+(err?" err":""); };
    async function go(){
      const url = urlEl.value.trim(); if(!url){ setMsg("enter a repository URL", true); return; }
      goBtn.disabled = true;
      try{ await clone(url, t=>setMsg(t,false)); setMsg("done ✓", false); setTimeout(close, 500); }
      catch(e){ setMsg(String(e && e.message || e), true); }
      finally{ goBtn.disabled = false; }
    }
    goBtn.addEventListener("click", go);
    urlEl.addEventListener("keydown", e=>{ if(e.key==="Enter") go(); if(e.key==="Escape") close(); });
    modal.querySelector("#gc-cancel").addEventListener("click", close);
    modal.addEventListener("mousedown", e=>{ if(e.target===modal) close(); });
    return modal;
  }
  function openDialog(){ ensureModal(); modal.classList.add("show"); const i=modal.querySelector("#gc-url"); i.value=""; modal.querySelector("#gc-msg").textContent=""; setTimeout(()=>i.focus(),40); }
  function close(){ if(modal) modal.classList.remove("show"); }

  // The canonical "owner/repo[/tree/branch/sub]" spec for a cloned project — used
  // for the shareable clone link.
  function specOf(proj){
    const info = parse((proj && proj.remote) || "");
    if(!info) return null;
    let s = info.owner + "/" + info.repo;
    if(info.branch) s += "/tree/" + info.branch + (info.subpath ? "/" + info.subpath : "");
    return s;
  }
  // A link that, when opened, clones this repo and spawns the recipient into it.
  function cloneLinkFor(proj){
    const s = specOf(proj); if(!s) return null;
    return location.origin + location.pathname + "#clone=" + encodeURIComponent(s);
  }

  window.AowliGit = { clone, openDialog, parse, specOf, cloneLinkFor,
    // clone straight from a spec/URL (used by the #clone= share link on boot)
    cloneSpec(spec, onProgress){ return clone(spec, onProgress); },
    recloneInto(proj){ if(proj && proj.remote){ openDialog(); const i=modal.querySelector("#gc-url"); i.value=proj.remote; } },
  };
})();
