// winkit.js — a tiny floating-window kit shared by the file explorer and the
// debugger panels. Each window is draggable by its titlebar, resizable from its
// edges/corner, collapsible, closable, and remembers geometry in localStorage.
// Deliberately dependency-free and styled by one injected stylesheet so new
// panels don't require edits to index.html's big <style> block.
(function(){
  if(window.WinKit) return;

  const CSS = `
  .wk-win{position:fixed;z-index:60;display:flex;flex-direction:column;
    background:var(--panel);border:1px solid var(--border);border-radius:9px;
    box-shadow:0 12px 40px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3);
    min-width:180px;min-height:64px;overflow:hidden;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wk-win.wk-collapsed{height:auto!important;min-height:0;resize:none}
  .wk-win.wk-collapsed .wk-body{display:none}
  .wk-head{display:flex;align-items:center;gap:8px;height:34px;padding:0 6px 0 11px;
    background:var(--panel2);border-bottom:1px solid var(--border);cursor:grab;flex:none;user-select:none}
  .wk-head.wk-drag{cursor:grabbing}
  .wk-title{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--fg);
    display:flex;align-items:center;gap:7px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wk-title svg{width:14px;height:14px;flex:none;opacity:.8}
  .wk-actions{display:flex;align-items:center;gap:1px;flex:none}
  .wk-btn{width:24px;height:24px;border:0;background:transparent;color:var(--muted);
    border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
  .wk-btn:hover{background:var(--border);color:var(--fg)}
  .wk-btn svg{width:13px;height:13px}
  .wk-body{flex:1;overflow:auto;min-height:0}
  .wk-grip{position:absolute;width:15px;height:15px;right:0;bottom:0;cursor:nwse-resize;z-index:2}
  .wk-grip::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;
    border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);opacity:.5}
  .wk-edge{position:absolute;z-index:1}
  .wk-edge.r{right:-3px;top:8px;bottom:8px;width:7px;cursor:ew-resize}
  .wk-edge.l{left:-3px;top:8px;bottom:8px;width:7px;cursor:ew-resize}
  .wk-edge.b{left:8px;right:8px;bottom:-3px;height:7px;cursor:ns-resize}
  .wk-edge.t{left:8px;right:8px;top:-3px;height:7px;cursor:ns-resize}`;

  function injectCss(){
    if(document.getElementById("wk-css")) return;
    const s = document.createElement("style"); s.id = "wk-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  let zTop = 60;
  function bringFront(el){ el.style.zIndex = String(++zTop); }

  function create(opts){
    injectCss();
    const key = opts.key ? ("np-win-" + opts.key) : null;
    const win = document.createElement("div");
    win.className = "wk-win" + (opts.className ? " " + opts.className : "");
    win.innerHTML =
      '<div class="wk-head">' +
        '<div class="wk-title">' + (opts.icon || "") + '<span class="wk-titletext"></span></div>' +
        '<div class="wk-actions"></div>' +
      '</div>' +
      '<div class="wk-body"></div>' +
      '<div class="wk-edge l"></div><div class="wk-edge r"></div>' +
      '<div class="wk-edge t"></div><div class="wk-edge b"></div>' +
      '<div class="wk-grip"></div>';
    const head = win.querySelector(".wk-head");
    const titleText = win.querySelector(".wk-titletext");
    const actions = win.querySelector(".wk-actions");
    const body = win.querySelector(".wk-body");
    titleText.textContent = opts.title || "";

    // geometry
    const def = opts.default || { x: 16, y: 96, w: 260, h: 420 };
    let geo = Object.assign({}, def, { collapsed: false });
    try{ if(key){ const s = JSON.parse(localStorage.getItem(key)||"null"); if(s) geo = Object.assign(geo, s); } }catch(_){}
    function clampIntoView(){
      const vw = innerWidth, vh = innerHeight;
      geo.w = Math.max(opts.minW||180, Math.min(geo.w, vw-8));
      geo.h = Math.max(opts.minH||64, Math.min(geo.h, vh-8));
      geo.x = Math.max(4, Math.min(geo.x, vw - 60));
      geo.y = Math.max(4, Math.min(geo.y, vh - 40));
    }
    function applyGeo(){
      clampIntoView();
      win.style.left = geo.x + "px"; win.style.top = geo.y + "px";
      win.style.width = geo.w + "px";
      win.style.height = geo.collapsed ? "auto" : (geo.h + "px");
      win.classList.toggle("wk-collapsed", !!geo.collapsed);
    }
    function saveGeo(){ if(key) try{ localStorage.setItem(key, JSON.stringify(geo)); }catch(_){} }

    // action buttons
    function addBtn(html, tip, fn){
      const b = document.createElement("button"); b.className = "wk-btn"; b.innerHTML = html;
      if(tip){ b.setAttribute("data-tip", tip); b.title = tip; }
      b.addEventListener("click", (e)=>{ e.stopPropagation(); fn(); });
      actions.appendChild(b); return b;
    }
    (opts.actions || []).forEach(a => addBtn(a.icon, a.tip, a.fn));
    const collapseBtn = addBtn(
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg>',
      "Collapse", ()=>{ geo.collapsed = !geo.collapsed; applyGeo(); saveGeo(); });
    if(opts.closable !== false)
      addBtn('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
        "Hide", ()=>{ api.hide(); if(opts.onClose) opts.onClose(); });

    // drag
    let drag = null;
    head.addEventListener("pointerdown", (e)=>{
      if(e.target.closest(".wk-btn")) return;
      drag = { px:e.clientX, py:e.clientY, ox:geo.x, oy:geo.y };
      head.classList.add("wk-drag"); head.setPointerCapture(e.pointerId); bringFront(win);
    });
    head.addEventListener("pointermove", (e)=>{
      if(!drag) return;
      geo.x = drag.ox + (e.clientX - drag.px); geo.y = drag.oy + (e.clientY - drag.py);
      applyGeo();
    });
    const endDrag = ()=>{ if(drag){ drag=null; head.classList.remove("wk-drag"); saveGeo(); } };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

    // resize (grip + edges)
    function wireResize(el, dirs){
      let rs = null;
      el.addEventListener("pointerdown", (e)=>{
        e.stopPropagation();
        rs = { px:e.clientX, py:e.clientY, ow:geo.w, oh:geo.h, ox:geo.x, oy:geo.y };
        el.setPointerCapture(e.pointerId); bringFront(win);
      });
      el.addEventListener("pointermove", (e)=>{
        if(!rs) return;
        const dx = e.clientX - rs.px, dy = e.clientY - rs.py;
        if(dirs.includes("r")) geo.w = rs.ow + dx;
        if(dirs.includes("b")) geo.h = rs.oh + dy;
        if(dirs.includes("l")){ geo.w = rs.ow - dx; geo.x = rs.ox + dx; }
        if(dirs.includes("t")){ geo.h = rs.oh - dy; geo.y = rs.oy + dy; }
        applyGeo();
      });
      const end = ()=>{ if(rs){ rs=null; saveGeo(); } };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    }
    wireResize(win.querySelector(".wk-grip"), ["r","b"]);
    wireResize(win.querySelector(".wk-edge.r"), ["r"]);
    wireResize(win.querySelector(".wk-edge.l"), ["l"]);
    wireResize(win.querySelector(".wk-edge.b"), ["b"]);
    wireResize(win.querySelector(".wk-edge.t"), ["t"]);

    win.addEventListener("pointerdown", ()=> bringFront(win), true);
    window.addEventListener("resize", ()=>{ applyGeo(); });

    document.body.appendChild(win);
    applyGeo();

    const api = {
      el: win, body, head,
      setTitle(t){ titleText.textContent = t; },
      show(){ win.style.display = "flex"; if(key){ try{ localStorage.setItem(key+"-hidden","0"); }catch(_){} } bringFront(win); },
      hide(){ win.style.display = "none"; if(key){ try{ localStorage.setItem(key+"-hidden","1"); }catch(_){} } },
      toggle(){ (win.style.display === "none") ? api.show() : api.hide(); },
      isVisible(){ return win.style.display !== "none"; },
      addAction(a){ return addBtn(a.icon, a.tip, a.fn); },
      front(){ bringFront(win); },
    };
    // restore hidden state
    try{ if(key && localStorage.getItem(key+"-hidden")==="1" && !opts.startVisible) win.style.display="none"; }catch(_){}
    return api;
  }

  window.WinKit = { create };
})();
