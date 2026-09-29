// M5cet operator console — the visual builder (5.1).
//
// A canvas of nodes (inputs, SDK calls, logic, text, data, outputs) and the
// wires between their ports. The flow compiles (window.M5Flow, the same
// compiler the server uses) to an ordinary package file; running it traces
// every node, so each shows its value — or its error — right on the canvas.
//
//   palette     drag a node onto the canvas, or click to add it
//   canvas      drag a node to move it; drag from a port to wire it; drag
//               the background to pan; Ctrl/pinch + wheel to zoom;
//               double-click (or drop a wire on nothing) to add a node there
//   inspector   the selected node's settings and typed-in input values
//   code        the code the flow compiles to (live)
//   run         a form from the flow's inputs; results on the nodes
//
// Keys: Delete removes, Ctrl+Z / Ctrl+Shift+Z undo / redo, Ctrl+D duplicates,
// Ctrl+S saves, Ctrl+Enter runs, F fits the view.
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast } = C;
  const F = () => window.M5Flow;
  const SVG = "http://www.w3.org/2000/svg";
  const STORE = "m5cet:fb-work";
  const GRID = 10;

  let flow = null;          // the flow on the canvas
  let target = null;        // { id, name, language } — the package it saves to
  let selected = null;      // { kind: "node" | "edge", id }
  let cam = { x: 60, y: 40, z: 1 };
  let undoStack = [];
  let redoStack = [];
  let results = {};         // node id → { value?, error? } of the last run
  let sideTab = "inspect";
  let savedJson = "";
  let ctx = null;           // from the console: api helpers, liveRunInto, dialogs, …
  let els = null;           // this render's DOM
  let runValues = {};       // the run form's values
  let runBox = null;        // the last run's result (kept across renders)
  let compileError = null;  // { message, node }
  let full = false;         // full-screen canvas
  let fnName = "execute";   // 5.3: the function on the canvas (execute, or another entry point of the flow)

  /** The graph on the canvas: the flow's own (execute) or one of its other functions. */
  const G = () => {
    if (fnName === "execute" || !flow.functions || !flow.functions[fnName]) { if (fnName !== "execute" && (!flow.functions || !flow.functions[fnName])) fnName = "execute"; return flow; }
    return flow.functions[fnName];
  };

  const byId = (id) => G().nodes.find((n) => n.id === id);
  const defOf = (n) => F().NODE_BY_TYPE[n.type];
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const isTyping = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const dirty = () => JSON.stringify(flow) !== savedJson;

  /* ============================================================ persistence */

  function remember() {
    try { localStorage.setItem(STORE, JSON.stringify({ flow, target, savedJson, cam })); } catch { /* full or off */ }
  }
  function restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || "null");
      if (raw && raw.flow) { flow = F().parseFlow(raw.flow); target = raw.target || null; savedJson = raw.savedJson || ""; if (raw.cam) cam = raw.cam; return true; }
    } catch { /* ignore */ }
    return false;
  }

  function setFlow(next, tgt, saved) {
    fnName = "execute";
    flow = next; target = tgt || null; selected = null; results = {}; runBox = null; undoStack = []; redoStack = []; compileError = null;
    savedJson = saved ? JSON.stringify(flow) : "";
    cam = { x: 60, y: 40, z: 1 };
    remember();
  }

  /* ============================================================ public */

  const API = {
    view(c) {
      ctx = c;
      if (!flow && !restore()) setFlow(clone(F().FLOW_EXAMPLES[0].flow), null, false);
      return build();
    },
    newFlow(name, lang) { setFlow({ ...F().emptyFlow(lang || "js", name || ""), nodes: [], edges: [] }, null, false); },
    openFromPackage(pkg, raw) { setFlow(F().parseFlow(raw), { id: pkg.id, name: pkg.name, language: pkg.language }, true); setTimeout(fit, 30); },
    openExample(id) { const ex = F().FLOW_EXAMPLES.find((e) => e.id === id); if (ex) setFlow(clone(ex.flow), null, false); },
  };
  window.M5FnBuilder = API;

  /* ============================================================ history */

  function snapshot() { undoStack.push(JSON.stringify(flow)); if (undoStack.length > 150) undoStack.shift(); redoStack = []; }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(flow)); flow = JSON.parse(undoStack.pop()); afterStructure(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(flow)); flow = JSON.parse(redoStack.pop()); afterStructure(); }
  function afterStructure() { if (selected && selected.kind === "node" && !byId(selected.id)) selected = null; G(); drawFns(); drawNodes(); drawWires(); changed(); drawSide(); }

  /* ============================================================ build */

  function build() {
    const wrap = h("div", { class: `fb${full ? " fb--full" : ""}` });
    const bar = h("div", { class: "fb-bar" });
    const palette = h("div", { class: "fb-palette" });
    const stage = h("div", { class: "fb-stage", tabindex: "0", "aria-label": "Flow canvas" });
    const world = h("div", { class: "fb-world" });
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "fb-wires");
    const g = document.createElementNS(SVG, "g");
    g.setAttribute("transform", "translate(10000 10000)");
    svg.append(g);
    world.append(svg);
    stage.append(world);
    const zoomBox = h("div", { class: "fb-zoom" },
      h("button", { class: "btn btn--xs", title: "Zoom out", onclick: () => zoomAt(0.8) }, "−"),
      h("button", { class: "btn btn--xs fb-zoom__pct", title: "Reset zoom", onclick: () => { cam.z = 1; applyCam(); } }, "100%"),
      h("button", { class: "btn btn--xs", title: "Zoom in", onclick: () => zoomAt(1.25) }, "+"),
      h("button", { class: "btn btn--xs", title: "Fit (F)", onclick: fit }, "Fit"),
      h("button", { class: "btn btn--xs", title: "Tidy the layout", onclick: autoLayout }, "Tidy"));
    const empty = h("div", { class: "fb-empty" }, h("strong", {}, "An empty flow"), h("span", {}, "Drag a node from the left, or double-click here. Start with an ", h("em", {}, "Input"), " and end with a ", h("em", {}, "Send…"), " node."));
    const issues = h("div", { class: "fb-issues" });
    stage.append(zoomBox, empty, issues);
    const side = h("div", { class: "fb-side" });
    const fns = h("div", { class: "fb-fns", role: "tablist", "aria-label": "Functions of the flow" });
    stage.append(fns);
    // 6.1: the palette, the canvas and the inspector are panels the administrator arranges (the lock).
    const body = h("div", { class: "fb-body" });
    wrap.append(bar, body);
    if (window.M5Layout) {
      const handle = window.M5Layout.mount(body, [
        { id: "palette", title: "Nodes", el: palette, basis: 210, min: 160 },
        { id: "canvas", title: "Canvas", el: stage, basis: "fill", min: 360, fixed: true },
        { id: "inspector", title: "Inspector", el: side, basis: 340, min: 260 },
      ], { page: "fn:builder", title: "Builder", align: "stretch", height: "calc(100vh - 270px)", onChange: () => requestAnimationFrame(() => { if (els && els.stage && els.stage.isConnected) drawWires(); }) });
      if (ctx && ctx.onLayout) ctx.onLayout(handle);
    } else body.append(palette, stage, side);
    els = { wrap, bar, palette, stage, world, svg, g, side, issues, empty, fns, nodes: new Map(), zoomPct: zoomBox.querySelector(".fb-zoom__pct") };

    drawBar();
    drawFns();
    drawPalette();
    drawNodes();
    applyCam();
    wireStage();
    drawSide();
    changed(true);
    requestAnimationFrame(() => { drawWires(); if (!G().nodes.length) return; if (cam.x === 60 && cam.y === 40 && cam.z === 1) fit(); });
    return wrap;
  }

  /* ------------------------------------------------------------ toolbar */

  function drawBar() {
    const b = els.bar;
    clear(b);
    const name = h("input", { class: "input input--sm fb-name", value: flow.name || "", placeholder: "flow name", "aria-label": "Flow name", spellcheck: "false" });
    name.addEventListener("change", () => { snapshot(); flow.name = name.value.trim(); changed(); });
    const lang = h("select", { class: "input input--sm", "aria-label": "Language", title: "The language the flow compiles to" }, h("option", { value: "js", selected: flow.lang === "js" }, "JavaScript"), h("option", { value: "py", selected: flow.lang === "py" }, "Python"));
    lang.addEventListener("change", () => {
      const hasCode = G().nodes.some((n) => ["data.map", "data.filter", "code.expr", "code.block"].includes(n.type));
      if (hasCode && !confirm("Expression and Code nodes are written in the flow's language — check them after switching. Switch?")) { lang.value = flow.lang; return; }
      snapshot(); flow.lang = lang.value; changed(); drawSide();
    });
    const tgt = h("span", { class: "muted small fb-target", title: target ? `Saves to the package ${target.name}` : "Not saved to a package yet" }, target ? `→ ${target.name}` : "not saved");
    const saveBtn = h("button", { class: "btn btn--sm", id: "fbSave", "data-tip": "Save the flow and its code to a package (Ctrl/⌘+S)", onclick: save }, C.icon ? C.icon("save") : "", h("span", { class: "fb-save__label" }, dirty() ? "Save •" : "Save"));
    const I = (n) => (C.icon ? C.icon(n) : "");
    b.append(
      h("span", { class: "fb-logo", "aria-hidden": "true" }, I("workflow")), name, lang, tgt,
      h("span", { class: "fb-sep" }),
      h("button", { class: "btn btn--sm", onclick: newDialog, "data-tip": "New flow or an example" }, I("plus"), "New"),
      h("button", { class: "btn btn--sm", onclick: openDialog, "data-tip": "Open a flow saved in a package" }, I("file-code"), "Open"),
      h("button", { class: "btn btn--sm btn--icon", "data-tip": "Undo (Ctrl/⌘+Z)", "aria-label": "Undo", onclick: undo }, I("undo-2")),
      h("button", { class: "btn btn--sm btn--icon", "data-tip": "Redo (Ctrl/⌘+Shift+Z)", "aria-label": "Redo", onclick: redo }, I("redo-2")),
      h("span", { class: "fb-grow" }),
      h("span", { class: "fb-status", id: "fbStatus" }),
      h("button", { class: "btn btn--sm btn--icon", "data-tip": full ? "Leave the full screen (Esc)" : "The builder on the whole window (Esc to leave)", "aria-label": "Full screen", "aria-pressed": full ? "true" : "false", onclick: () => toggleFull() }, I(full ? "minimize-2" : "maximize-2")),
      h("button", { class: "btn btn--sm btn--primary", "data-tip": "Run the flow (Ctrl/⌘+Enter)", onclick: () => { sideTab = "run"; drawSide(); startRun(); } }, I("play"), "Run"),
      C.can("operator") ? saveBtn : "",
      C.can("operator") ? h("button", { class: "btn btn--sm", onclick: makeModel, "data-tip": "Publish the package and make a model: a chat command, webhook or API" }, I("boxes"), "Create model…") : "",
    );
  }

  function toggleFull(on = !full) {
    full = on;
    els.wrap.classList.toggle("fb--full", full);
    document.documentElement.classList.toggle("fb-noscroll", full);
    drawBar(); changed(true);
    requestAnimationFrame(() => { drawWires(); fit(); });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && full && els && els.wrap.isConnected && !document.querySelector(".mb-overlay, .fb-quick")) toggleFull(false); });

  /** 5.3: the flow's functions — execute and the model's other entry points — as tabs over the canvas. */
  const FN_HELP = { execute: "the start (chat, console, API)", response: "a reply to the model's message", button: "a click on its button", form: "a sent form", error: "another entry point failed", webhook: "an inbound HTTP call" };
  function drawFns() {
    const box = els.fns;
    clear(box);
    for (const name of F().flowFunctions(flow)) {
      const on = name === fnName;
      box.append(h("button", { class: `fb-fn${on ? " is-on" : ""}`, role: "tab", "aria-selected": on ? "true" : "false", title: FN_HELP[name] || "a function of the flow", onclick: () => switchFn(name) }, name,
        name !== "execute" && C.can("operator") ? h("span", { class: "fb-fn__x", title: `Remove the ${name} function`, onclick: async (e) => { e.stopPropagation(); if (!(await ctx.confirmDialog(`Remove the ${name} function (and its nodes)?`, true))) return; snapshot(); delete flow.functions[name]; if (!Object.keys(flow.functions).length) delete flow.functions; switchFn("execute"); } }, "×") : null));
    }
    if (C.can("operator")) {
      const free = F().FLOW_FUNCTIONS.filter((f) => !(flow.functions && flow.functions[f]));
      const sel = h("select", { class: "input input--sm fb-fn__add", title: "Add a function: another entry point of the model" }, h("option", { value: "" }, "+ function…"), ...free.map((f) => h("option", { value: f }, `${f} — ${FN_HELP[f]}`)), h("option", { value: "__custom" }, "another name…"));
      sel.addEventListener("change", () => {
        let name = sel.value;
        sel.value = "";
        if (!name) return;
        if (name === "__custom") { name = (window.prompt("Function name (letters, digits, _)", "helper") || "").trim(); if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name) || name === "execute") { if (name) toast("Not a function name.", "err"); return; } }
        snapshot();
        flow.functions = flow.functions || {};
        if (!flow.functions[name]) flow.functions[name] = { nodes: [], edges: [] };
        switchFn(name);
      });
      box.append(sel);
    }
  }
  function switchFn(name) {
    fnName = name;
    selected = null; results = {};
    drawFns(); drawNodes(); drawWires(); changed(); drawSide();
    requestAnimationFrame(() => { if (G().nodes.length) fit(); });
  }

  function markSaved() { const s = els && els.bar.querySelector("#fbSave .fb-save__label"); if (s) s.textContent = dirty() ? "Save •" : "Save"; }

  /* ------------------------------------------------------------ palette */

  function drawPalette() {
    const p = els.palette;
    clear(p);
    const search = h("input", { class: "input input--sm", type: "search", placeholder: "Find a node…", "aria-label": "Find a node" });
    const list = h("div", { class: "fb-pal" });
    const draw = () => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      for (const group of F().GROUPS) {
        const items = F().NODES.filter((d) => d.group === group && (!q || `${d.title} ${d.doc} ${d.type}`.toLowerCase().includes(q)));
        if (!items.length) continue;
        const sec = h("details", { class: "fb-pal__group", open: true }, h("summary", {}, h("span", { class: `fb-chip fb-g--${slug(group)}` }), group));
        for (const d of items) {
          const item = h("div", { class: `fb-pal__item fb-g--${slug(d.group)}`, title: d.doc, tabindex: "0", role: "button", "data-type": d.type }, h("span", { class: "fb-pal__dot" }), d.title);
          item.addEventListener("pointerdown", (e) => paletteDrag(e, d.type));
          item.addEventListener("keydown", (e) => { if (e.key === "Enter") addAtCenter(d.type); });
          sec.append(item);
        }
        list.append(sec);
      }
    };
    search.addEventListener("input", draw);
    draw();
    p.append(search, list);
  }

  function paletteDrag(e, type) {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let ghost = null;
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) { ghost = h("div", { class: "fb-ghost" }, F().NODE_BY_TYPE[type].title); document.body.append(ghost); }
      if (ghost) { ghost.style.left = `${ev.clientX + 8}px`; ghost.style.top = `${ev.clientY + 8}px`; }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (!ghost) { addAtCenter(type); return; }
      ghost.remove();
      const r = els.stage.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      const w = toWorld(ev.clientX, ev.clientY);
      addNode(type, w.x - 20, w.y - 14);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  function addAtCenter(type) {
    const r = els.stage.getBoundingClientRect();
    const w = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    // Do not stack new nodes exactly on top of each other.
    let x = w.x - 100, y = w.y - 40;
    while (G().nodes.some((n) => Math.abs(n.x - x) < 12 && Math.abs(n.y - y) < 12)) { x += 24; y += 24; }
    addNode(type, x, y);
  }

  function addNode(type, x, y, connectFrom) {
    snapshot();
    const n = F().newNode(G(), type, snap(x), snap(y));
    G().nodes.push(n);
    if (connectFrom) {
      const ports = F().inputsOf(n);
      const port = ports.find((p) => p.required) || ports[0];
      if (connectFrom.side === "out" && port) connect(connectFrom.node, connectFrom.port, n.id, port.name, false);
      if (connectFrom.side === "in") { const out = F().outputsOf(n)[0]; if (out) connect(n.id, out.name, connectFrom.node, connectFrom.port, false); }
    }
    selected = { kind: "node", id: n.id };
    drawNodes(); drawWires(); changed(); drawSide();
    return n;
  }

  /* ============================================================ canvas */

  const snap = (v) => Math.round(v / GRID) * GRID;
  function toWorld(clientX, clientY) {
    const r = els.stage.getBoundingClientRect();
    return { x: (clientX - r.left - cam.x) / cam.z, y: (clientY - r.top - cam.y) / cam.z };
  }
  function applyCam() {
    els.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    els.stage.style.backgroundSize = `${20 * cam.z}px ${20 * cam.z}px`;
    els.stage.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    if (els.zoomPct) els.zoomPct.textContent = `${Math.round(cam.z * 100)}%`;
  }
  function zoomAt(f, clientX, clientY) {
    const r = els.stage.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2;
    const w = toWorld(cx, cy);
    cam.z = Math.max(0.25, Math.min(2.2, cam.z * f));
    cam.x = cx - r.left - w.x * cam.z;
    cam.y = cy - r.top - w.y * cam.z;
    applyCam(); remember();
  }
  function fit() {
    if (!els || !G().nodes.length) return;
    const r = els.stage.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of G().nodes) {
      const el = els.nodes.get(n.id);
      const w = el ? el.offsetWidth : 200, hh = el ? el.offsetHeight : 80;
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + w); maxY = Math.max(maxY, n.y + hh);
    }
    const bw = maxX - minX + 80, bh = maxY - minY + 80;
    cam.z = Math.max(0.3, Math.min(1.2, Math.min(r.width / bw, (r.height - 40) / bh)));
    cam.x = (r.width - (maxX - minX) * cam.z) / 2 - minX * cam.z;
    cam.y = (r.height - 40 - (maxY - minY) * cam.z) / 2 - minY * cam.z;
    applyCam(); remember();
  }

  function autoLayout() {
    if (!G().nodes.length) return;
    snapshot();
    const depth = new Map(G().nodes.map((n) => [n.id, 0]));
    for (let i = 0; i < G().nodes.length; i++) {
      let moved = false;
      for (const e of G().edges) { const d = (depth.get(e.from.node) ?? 0) + 1; if (d > (depth.get(e.to.node) ?? 0)) { depth.set(e.to.node, d); moved = true; } }
      if (!moved) break;
    }
    const cols = new Map();
    for (const n of G().nodes) { const d = depth.get(n.id); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); }
    for (const [d, list] of cols) {
      list.sort((a, b) => a.y - b.y);
      let y = 40;
      for (const n of list) { n.x = 40 + d * 280; n.y = y; const el = els.nodes.get(n.id); y += (el ? el.offsetHeight : 90) + 40; }
    }
    drawNodes(); drawWires(); changed(); fit();
  }

  /* ------------------------------------------------------------ nodes */

  function drawNodes() {
    for (const el of els.nodes.values()) el.remove();
    els.nodes.clear();
    for (const n of G().nodes) { const el = nodeEl(n); els.nodes.set(n.id, el); els.world.append(el); }
    els.empty.hidden = G().nodes.length > 0;
  }

  function redrawNode(n) {
    const old = els.nodes.get(n.id);
    const el = nodeEl(n);
    els.nodes.set(n.id, el);
    if (old) old.replaceWith(el); else els.world.append(el);
  }

  function subtitle(n) {
    const p = F().paramsOf(n);
    switch (n.type) {
      case "flow.input": return `inputs.${p.name || "value"} · ${p.type}${p.required ? " *" : ""}`;
      case "flow.value": return String(p.value ?? "").slice(0, 40) || "(empty)";
      case "text.template": return String(p.template ?? "").replace(/\n/g, " ⏎ ").slice(0, 44);
      case "http.request": return String(p.method || "GET");
      case "data.get": return p.path ? `.${p.path}` : "";
      case "data.map": case "data.filter": case "code.expr": return String(p.expr ?? "").slice(0, 40);
      case "code.block": return `(${p.args}) ⇒ …`;
      case "out.button": { const b = p.button && typeof p.button === "object" ? p.button : {}; return `${b.icon ? b.icon + " " : ""}${b.title || "button"} → ${b.name || ""}`; }
      case "out.form": { const f = p.form && typeof p.form === "object" ? p.form : {}; return `${f.title || f.name || "form"}`; }
      case "out.js": return String(p.code ?? "").replace(/\n/g, " ").slice(0, 40);
      default: {
        const def = defOf(n);
        const first = (def.params || []).find((x) => x.type === "enum");
        return first ? String(p[first.name]) : "";
      }
    }
  }

  function preview(v) {
    if (v === undefined) return "";
    if (v === null) return "null";
    const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }

  function nodeEl(n) {
    const def = defOf(n);
    if (!def) return h("div", { class: "fb-node fb-node--err", "data-id": n.id, style: `left:${n.x}px;top:${n.y}px` }, h("div", { class: "fb-node__head" }, `Unknown: ${n.type}`));
    const wired = new Set(G().edges.filter((e) => e.to.node === n.id).map((e) => e.to.port));
    const on = selected && selected.kind === "node" && selected.id === n.id;
    const res = results[n.id];
    const el = h("div", { class: `fb-node fb-g--${slug(def.group)}${on ? " fb-node--on" : ""}${res && res.error ? " fb-node--fail" : ""}${compileError && compileError.node === n.id ? " fb-node--err" : ""}`, "data-id": n.id, style: `left:${n.x}px;top:${n.y}px` });
    el.append(h("div", { class: "fb-node__head" }, h("span", { class: "fb-node__title" }, n.label || def.title), h("span", { class: "fb-node__id" }, n.id)));
    const sub = subtitle(n);
    if (sub) el.append(h("div", { class: "fb-node__sub" }, sub));
    const ports = h("div", { class: "fb-ports" });
    for (const p of F().inputsOf(n)) {
      const lit = !wired.has(p.name) && n.values && n.values[p.name] !== undefined && n.values[p.name] !== "" ? n.values[p.name] : !wired.has(p.name) && p.default !== undefined ? p.default : undefined;
      ports.append(h("div", { class: `fb-port fb-port--in${wired.has(p.name) ? " is-wired" : ""}${p.required && !wired.has(p.name) && lit === undefined ? " is-missing" : ""}`, "data-port": p.name, title: `${p.name} · ${p.type}${p.required ? " (required)" : ""}` },
        h("span", { class: `fb-dot fb-t--${p.type}` }), h("span", { class: "fb-port__name" }, p.label || p.name),
        lit !== undefined ? h("span", { class: "fb-lit" }, `= ${preview(lit)}`) : null));
    }
    for (const p of F().outputsOf(n)) {
      ports.append(h("div", { class: `fb-port fb-port--out${p.branch ? " fb-port--" + p.branch : ""}`, "data-port": p.name, title: `${p.name} · ${p.type}` },
        h("span", { class: "fb-port__name" }, p.label || p.name), h("span", { class: `fb-dot fb-t--${p.type}` })));
    }
    el.append(ports);
    if (res) {
      el.append(h("div", { class: `fb-node__res${res.error ? " is-err" : ""}`, title: res.error ? res.error : typeof res.value === "string" ? res.value : JSON.stringify(res.value, null, 2) },
        res.error ? `✗ ${res.error}` : !F().outputsOf(n).length ? "✓ done" : `✓ ${preview(res.value) || "—"}`));
    }
    return el;
  }

  /* ------------------------------------------------------------ wires */

  function dotPos(nodeId, side, port) {
    const el = els.nodes.get(nodeId);
    const n = byId(nodeId);
    if (!el || !n) return null;
    const dot = el.querySelector(`.fb-port--${side}[data-port="${CSS.escape(port)}"] .fb-dot`);
    if (!dot) return null;
    const nr = el.getBoundingClientRect(), dr = dot.getBoundingClientRect();
    return { x: n.x + (dr.left + dr.width / 2 - nr.left) / cam.z, y: n.y + (dr.top + dr.height / 2 - nr.top) / cam.z };
  }
  const curve = (a, b) => { const d = Math.max(36, Math.abs(b.x - a.x) * 0.5); return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`; };

  let wiresQueued = false;
  function drawWiresSoon() { if (wiresQueued) return; wiresQueued = true; requestAnimationFrame(() => { wiresQueued = false; drawWires(); }); }
  function drawWires() {
    if (!els) return;
    const g = els.g;
    while (g.firstChild) g.firstChild.remove();
    for (const e of G().edges) {
      const a = dotPos(e.from.node, "out", e.from.port), b = dotPos(e.to.node, "in", e.to.port);
      if (!a || !b) continue;
      const src = byId(e.from.node);
      const out = src && F().outputsOf(src).find((p) => p.name === e.from.port);
      const d = curve(a, b);
      const on = selected && selected.kind === "edge" && selected.id === e.id;
      const hit = document.createElementNS(SVG, "path");
      hit.setAttribute("d", d); hit.setAttribute("class", "fb-wire-hit"); hit.dataset.edge = e.id;
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", `fb-wire fb-t--${out ? out.type : "any"}${on ? " is-on" : ""}${out && out.branch ? " fb-wire--" + out.branch : ""}${results[e.from.node] && !results[e.from.node].error ? " is-live" : ""}`);
      g.append(path, hit);
    }
  }

  function connect(fromNode, fromPort, toNode, toPort, withHistory = true) {
    if (fromNode === toNode) return false;
    if (withHistory) snapshot();
    G().edges = G().edges.filter((e) => !(e.to.node === toNode && e.to.port === toPort));
    G().edges.push({ id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } });
    return true;
  }

  /* ------------------------------------------------------------ pointer & keys */

  function wireStage() {
    const st = els.stage;
    st.addEventListener("pointerdown", onDown);
    st.addEventListener("dblclick", (e) => { if (e.target.closest(".fb-node") || e.target.closest(".fb-zoom") || e.target.closest(".fb-issues")) return; const w = toWorld(e.clientX, e.clientY); quickAdd(e.clientX, e.clientY, w, null); });
    st.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
      else { cam.x -= e.deltaX; cam.y -= e.deltaY; applyCam(); }
    }, { passive: false });
    st.addEventListener("keydown", onKey);
    if ("ResizeObserver" in window) new ResizeObserver(() => drawWiresSoon()).observe(st);
  }

  function onKey(e) {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); removeSelected(); }
    else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "d" && selected && selected.kind === "node") { e.preventDefault(); duplicate(selected.id); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if (mod && e.key === "Enter") { e.preventDefault(); sideTab = "run"; drawSide(); startRun(); }
    else if (!mod && e.key.toLowerCase() === "f") { e.preventDefault(); fit(); }
    else if (e.key === "Escape") { selected = null; drawNodes(); drawWires(); drawSide(); }
  }

  function onDown(e) {
    if (e.button !== 0 || e.target.closest(".fb-zoom") || e.target.closest(".fb-issues") || e.target.closest(".fb-quick")) return;
    els.stage.focus({ preventScroll: true });
    const dot = e.target.closest(".fb-dot");
    const nodeEl = e.target.closest(".fb-node");
    const hit = e.target.closest(".fb-wire-hit");
    if (dot && nodeEl) return startWire(e, dot, nodeEl);
    if (nodeEl) return startMove(e, nodeEl.dataset.id);
    if (hit) { selected = { kind: "edge", id: hit.dataset.edge }; drawNodes(); drawWires(); drawSide(); return; }
    startPan(e);
  }

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, cx = cam.x, cy = cam.y;
    let moved = false;
    els.stage.classList.add("is-panning");
    const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) moved = true; cam.x = cx + ev.clientX - sx; cam.y = cy + ev.clientY - sy; applyCam(); };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      els.stage.classList.remove("is-panning");
      if (!moved && selected) { selected = null; drawNodes(); drawWires(); drawSide(); }
      remember();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  function startMove(e, id) {
    const n = byId(id);
    if (!n) return;
    const el = els.nodes.get(id);
    const sx = e.clientX, sy = e.clientY, nx = n.x, ny = n.y;
    let moved = false;
    const was = selected && selected.kind === "node" && selected.id === id;
    if (!was) { selected = { kind: "node", id }; for (const [k, x] of els.nodes) x.classList.toggle("fb-node--on", k === id); drawWires(); drawSide(); }
    const move = (ev) => {
      const dx = (ev.clientX - sx) / cam.z, dy = (ev.clientY - sy) / cam.z;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      if (!moved) { snapshot(); moved = true; el.classList.add("is-drag"); }
      n.x = nx + dx; n.y = ny + dy;
      el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
      drawWiresSoon();
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (!moved) return;
      el.classList.remove("is-drag");
      n.x = snap(n.x); n.y = snap(n.y);
      el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
      drawWires(); changed();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  function startWire(e, dot, nodeEl) {
    e.preventDefault();
    e.stopPropagation();
    const portEl = dot.closest(".fb-port");
    let side = portEl.classList.contains("fb-port--out") ? "out" : "in";
    let node = nodeEl.dataset.id, port = portEl.dataset.port;
    // Grabbing a wired input picks the wire up from its source.
    if (side === "in") {
      const existing = G().edges.find((x) => x.to.node === node && x.to.port === port);
      if (existing) { snapshot(); G().edges = G().edges.filter((x) => x !== existing); side = "out"; node = existing.from.node; port = existing.from.port; redrawNode(byId(existing.to.node)); drawWires(); changed(); }
    }
    const anchor = dotPos(node, side, port);
    if (!anchor) return;
    const temp = document.createElementNS(SVG, "path");
    temp.setAttribute("class", "fb-wire fb-wire--temp");
    els.g.append(temp);
    const move = (ev) => {
      const w = toWorld(ev.clientX, ev.clientY);
      temp.setAttribute("d", side === "out" ? curve(anchor, w) : curve(w, anchor));
      for (const x of els.stage.querySelectorAll(".fb-port.is-target")) x.classList.remove("is-target");
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const tp = over && over.closest(`.fb-port--${side === "out" ? "in" : "out"}`);
      if (tp && tp.closest(".fb-node").dataset.id !== node) tp.classList.add("is-target");
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      temp.remove();
      for (const x of els.stage.querySelectorAll(".fb-port.is-target")) x.classList.remove("is-target");
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const tp = over && over.closest(`.fb-port--${side === "out" ? "in" : "out"}`);
      const tn = tp && tp.closest(".fb-node");
      if (tp && tn && tn.dataset.id !== node) {
        const ok = side === "out" ? connect(node, port, tn.dataset.id, tp.dataset.port) : connect(tn.dataset.id, tp.dataset.port, node, port);
        if (ok) { drawNodes(); drawWires(); changed(); drawSide(); }
        return;
      }
      const r = els.stage.getBoundingClientRect();
      if (!over || !els.stage.contains(over) || over.closest(".fb-node")) return;
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      // Dropped on nothing: offer a node to connect to.
      quickAdd(ev.clientX, ev.clientY, toWorld(ev.clientX, ev.clientY), { side, node, port });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    move(e);
  }

  /** A search box at a point of the canvas: pick a node to add there (and wire it). */
  function quickAdd(clientX, clientY, w, connectFrom) {
    for (const q of els.stage.querySelectorAll(".fb-quick")) q.remove();
    const r = els.stage.getBoundingClientRect();
    const box = h("div", { class: "fb-quick", style: `left:${Math.min(clientX - r.left, r.width - 250)}px;top:${Math.min(clientY - r.top, r.height - 260)}px` });
    const input = h("input", { class: "input input--sm", placeholder: connectFrom ? "Connect to…" : "Add a node…", "aria-label": "Find a node" });
    const list = h("div", { class: "fb-quick__list" });
    let items = [], idx = 0;
    const fits = (d) => {
      if (!connectFrom) return true;
      if (connectFrom.side === "out") { const probe = { id: "x", type: d.type, x: 0, y: 0, params: F().paramsOf({ id: "x", type: d.type, x: 0, y: 0 }) }; return F().inputsOf(probe).length > 0; }
      return d.outputs.length > 0;
    };
    const draw = () => {
      clear(list);
      const q = input.value.trim().toLowerCase();
      items = F().NODES.filter((d) => fits(d) && (!q || `${d.title} ${d.group} ${d.doc}`.toLowerCase().includes(q))).slice(0, 14);
      idx = Math.min(idx, Math.max(0, items.length - 1));
      items.forEach((d, i) => list.append(h("button", { class: `fb-quick__item fb-g--${slug(d.group)}${i === idx ? " is-on" : ""}`, onclick: () => pick(d.type), title: d.doc }, h("span", { class: "fb-pal__dot" }), d.title, h("span", { class: "muted small" }, d.group))));
    };
    const close = () => { box.remove(); document.removeEventListener("pointerdown", outside, true); };
    const outside = (ev) => { if (!box.contains(ev.target)) close(); };
    const pick = (type) => { close(); addNode(type, w.x, w.y - 16, connectFrom); };
    input.addEventListener("input", () => { idx = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[idx]) pick(items[idx].type); }
      else if (e.key === "Escape") { e.preventDefault(); close(); els.stage.focus(); }
    });
    box.append(input, list);
    els.stage.append(box);
    draw();
    setTimeout(() => { input.focus(); document.addEventListener("pointerdown", outside, true); }, 0);
  }

  function removeSelected() {
    if (!selected) return;
    snapshot();
    if (selected.kind === "node") {
      const id = selected.id;
      G().nodes = G().nodes.filter((n) => n.id !== id);
      G().edges = G().edges.filter((e) => e.from.node !== id && e.to.node !== id);
      delete results[id];
    } else G().edges = G().edges.filter((e) => e.id !== selected.id);
    selected = null;
    drawNodes(); drawWires(); changed(); drawSide();
  }

  function duplicate(id) {
    const n = byId(id);
    if (!n) return;
    snapshot();
    const copy = F().newNode(G(), n.type, n.x + 30, n.y + 30);
    copy.params = clone(n.params || {}); copy.values = clone(n.values || {}); if (n.label) copy.label = n.label;
    if (copy.type === "flow.input") copy.params.name = `${n.params.name || "value"}_2`;
    G().nodes.push(copy);
    selected = { kind: "node", id: copy.id };
    drawNodes(); drawWires(); changed(); drawSide();
  }

  /* ============================================================ changes */

  let codeTimer = null;
  function changed(initial) {
    let issues = [];
    try { issues = F().checkFlow(flow); } catch (e) { issues = [{ level: "error", message: e.message }]; }
    compileError = null;
    const errs = issues.filter((i) => i.level === "error");
    if (!errs.length) { try { F().compileFlow(flow); } catch (e) { compileError = { message: e.message, node: e.node, fn: e.fn }; } }
    drawIssues(issues);
    const st = els.bar.querySelector("#fbStatus");
    if (st) { clear(st); st.append(errs.length || compileError ? h("span", { class: "badge badge--err" }, `${errs.length || 1} error${errs.length > 1 ? "s" : ""}`) : h("span", { class: "badge badge--ok" }, "ready"), h("span", { class: "muted small" }, ` ${G().nodes.length} nodes · ${G().edges.length} wires`)); }
    const here = (i) => (i.fn || "execute") === fnName;
    for (const [id, el] of els.nodes) el.classList.toggle("fb-node--err", Boolean(errs.find((i) => i.node === id && here(i))) || Boolean(compileError && compileError.node === id && here(compileError)));
    markSaved();
    if (!initial) remember();
    if (sideTab === "code") { clearTimeout(codeTimer); codeTimer = setTimeout(drawSide, 250); }
  }

  function drawIssues(issues) {
    const box = els.issues;
    clear(box);
    const list = [...issues];
    if (compileError && !issues.some((i) => i.level === "error")) list.unshift({ level: "error", node: compileError.node, message: compileError.message });
    box.hidden = !list.length;
    for (const i of list.slice(0, 6)) {
      box.append(h("button", { class: `fb-issue fb-issue--${i.level}`, onclick: () => { if (i.fn && i.fn !== fnName) switchFn(i.fn); if (i.node && byId(i.node)) { selected = { kind: "node", id: i.node }; centerOn(i.node); drawNodes(); drawWires(); drawSide(); } } }, i.level === "error" ? "✗ " : "! ", i.node ? h("strong", {}, `${i.fn && i.fn !== "execute" ? `${i.fn}/` : ""}${i.node} `) : null, i.message));
    }
    if (list.length > 6) box.append(h("span", { class: "muted small" }, `…and ${list.length - 6} more`));
  }

  function centerOn(id) {
    const n = byId(id);
    if (!n) return;
    const r = els.stage.getBoundingClientRect();
    cam.x = r.width / 2 - (n.x + 100) * cam.z;
    cam.y = r.height / 2 - (n.y + 40) * cam.z;
    applyCam();
  }

  /* ============================================================ side panel */

  let sideEditors = [];
  function drawSide() {
    if (!els) return;
    for (const e of sideEditors.splice(0)) { try { e.destroy(); } catch { /* gone */ } }
    const s = els.side;
    clear(s);
    const tabs = h("div", { class: "fb-tabs" });
    for (const [id, label] of [["inspect", "Inspect"], ["code", "Code"], ["run", "Run"]]) tabs.append(h("button", { class: `fb-tab${sideTab === id ? " is-on" : ""}`, onclick: () => { sideTab = id; drawSide(); } }, label));
    s.append(tabs);
    const body = h("div", { class: "fb-side__body" });
    s.append(body);
    if (sideTab === "code") codePane(body);
    else if (sideTab === "run") runPane(body);
    else if (selected && selected.kind === "node" && byId(selected.id)) nodeInspector(body, byId(selected.id));
    else if (selected && selected.kind === "edge") edgeInspector(body);
    else flowInspector(body);
  }

  function section(title, ...children) { return h("div", { class: "fb-sec" }, h("div", { class: "fb-sec__h" }, title), ...children); }

  function flowInspector(body) {
    const nm = h("input", { class: "input input--sm", value: flow.name || "", placeholder: "my-flow" });
    nm.addEventListener("change", () => { snapshot(); flow.name = nm.value.trim(); changed(); drawBar(); });
    const sm = h("textarea", { class: "input input--sm", rows: 2, placeholder: "What it does (becomes the model's summary)" }, flow.summary || "");
    sm.value = flow.summary || "";
    sm.addEventListener("change", () => { snapshot(); flow.summary = sm.value.trim(); changed(); });
    body.append(section("Flow",
      h("label", { class: "field" }, h("span", { class: "label" }, "Name"), nm),
      h("label", { class: "field" }, h("span", { class: "label" }, "Summary"), sm),
      h("div", { class: "muted small" }, `${flow.lang === "py" ? "Python" : "JavaScript"} · ${G().nodes.length} nodes · ${G().edges.length} wires`, target ? ` · saves to ${target.name}` : " · not saved to a package yet")));
    const inputs = F().flowInputs(G());
    if (fnName !== "execute") body.append(section(`The ${fnName} function`, h("div", { class: "muted small" }, `${FN_HELP[fnName] ? `Runs on ${FN_HELP[fnName]}` : "Another function in the same file"}. “Entry point data” gives what it got (a reply's text, a button's name and data, a form's values, an error); “Model session” the calls so far. Create model… makes it the model's ${fnName} entry point.`)));
    body.append(section(fnName === "execute" ? "Inputs (the model's form)" : `Inputs of ${fnName}`, inputs.length ? h("ul", { class: "fb-list" }, ...inputs.map((i) => h("li", {}, h("code", {}, i.name), ` ${i.type}${i.required ? " *" : ""}${i.default !== undefined ? ` = ${JSON.stringify(i.default)}` : ""}`))) : h("div", { class: "muted small" }, "No Input nodes — the flow takes no inputs.")));
    body.append(section("How to",
      h("ul", { class: "fb-list fb-list--help" },
        h("li", {}, "Drag a node from the left, or double-click the canvas."),
        h("li", {}, "Drag from an output dot (right) to an input dot (left) to wire them; drop a wire on nothing to add a node there."),
        h("li", {}, "Grab a wired input dot to move or remove its wire."),
        h("li", {}, "Inputs without a wire take the value typed in the inspector."),
        h("li", {}, "An If node's then/else ports run only what hangs off them."),
        h("li", {}, "Keys: Delete, Ctrl+Z / Ctrl+Shift+Z, Ctrl+D, Ctrl+S, Ctrl+Enter, F (fit), Ctrl + wheel (zoom)."))));
  }

  function edgeInspector(body) {
    const e = G().edges.find((x) => x.id === selected.id);
    if (!e) { flowInspector(body); return; }
    const a = byId(e.from.node), b = byId(e.to.node);
    body.append(section("Wire",
      h("div", {}, h("code", {}, `${e.from.node}.${e.from.port}`), " → ", h("code", {}, `${e.to.node}.${e.to.port}`)),
      h("div", { class: "muted small" }, `${a ? (a.label || defOf(a).title) : "?"} → ${b ? (b.label || defOf(b).title) : "?"}`),
      C.can("operator") ? h("button", { class: "btn btn--sm btn--danger mt8", onclick: removeSelected }, "Remove wire") : null));
  }

  function nodeInspector(body, n) {
    const def = defOf(n);
    const params = F().paramsOf(n);
    const head = h("div", { class: `fb-insp__head fb-g--${slug(def.group)}` }, h("span", { class: "fb-chip" }), h("strong", {}, def.title), h("span", { class: "muted small" }, `${def.group} · ${n.id}`));
    const label = h("input", { class: "input input--sm", value: n.label || "", placeholder: def.title, "aria-label": "Label" });
    label.addEventListener("change", () => { snapshot(); n.label = label.value.trim() || undefined; if (!n.label) delete n.label; redrawNode(n); drawWiresSoon(); changed(); });
    body.append(head, h("p", { class: "muted small fb-doc" }, def.doc), h("label", { class: "field" }, h("span", { class: "label" }, "Label on the canvas"), label));

    const res = results[n.id];
    if (res) body.append(section("Last run", res.error ? h("pre", { class: "fn-err" }, res.error) : h("pre", { class: "fb-val" }, typeof res.value === "string" ? res.value : JSON.stringify(res.value, null, 2))));

    if ((def.params || []).length) {
      const box = section("Settings");
      for (const p of def.params) box.append(paramField(n, p, params[p.name]));
      body.append(box);
    }
    const ins = F().inputsOf(n);
    if (ins.length) {
      const box = section("Inputs");
      for (const p of ins) box.append(inputField(n, p));
      body.append(box);
    }
    const outs = F().outputsOf(n);
    if (outs.length) body.append(section("Outputs", h("ul", { class: "fb-list" }, ...outs.map((o) => h("li", {}, h("span", { class: `fb-dot fb-t--${o.type}` }), " ", h("code", {}, o.name), h("span", { class: "muted small" }, ` ${o.type}${o.branch ? ` — only when the condition is ${o.branch === "then" ? "true" : "false"}` : ""}`), " · ", h("span", { class: "muted small" }, `${G().edges.filter((e) => e.from.node === n.id && e.from.port === o.name).length} wire(s)`))))));
    if (C.can("operator")) body.append(h("div", { class: "fn-row mt8" }, h("button", { class: "btn btn--sm", onclick: () => duplicate(n.id) }, "Duplicate"), h("button", { class: "btn btn--sm btn--danger", onclick: removeSelected }, "Delete node")));
  }

  function setParam(n, name, value) {
    snapshot();
    const before = F().inputsOf(n).map((p) => p.name).join(",");
    n.params = n.params || {};
    n.params[name] = value;
    // Ports may follow the params (template placeholders, keys, args…): drop wires to ports that went away.
    const ports = F().inputsOf(n).map((p) => p.name);
    const names = new Set(ports);
    G().edges = G().edges.filter((e) => e.to.node !== n.id || names.has(e.to.port));
    redrawNode(n); drawWiresSoon(); changed();
    if (ports.join(",") !== before) drawSideKeepingFocus();
  }

  /** Re-draws the inspector (ports changed) without losing the field being typed in. */
  function drawSideKeepingFocus() {
    const active = document.activeElement;
    const inSide = active && els.side.contains(active) && active.closest(".field");
    const label = inSide ? inSide.querySelector(".label") : null;
    const key = label ? label.textContent : null;
    drawSide();
    if (!key) return;
    for (const f of els.side.querySelectorAll(".field")) { const l = f.querySelector(".label"); if (l && l.textContent === key) { const i = f.querySelector("input, textarea, select"); if (i) i.focus(); break; } }
  }

  function paramField(n, p, value) {
    const lbl = h("span", { class: "label" }, p.label);
    const help = p.help ? h("span", { class: "muted small" }, p.help) : null;
    let input;
    if (p.type === "enum") {
      input = h("select", { class: "input input--sm" });
      for (const v of p.values || []) input.append(h("option", { value: v, selected: String(value) === v }, v));
      input.addEventListener("change", () => setParam(n, p.name, input.value));
    } else if (p.type === "boolean") {
      input = h("input", { type: "checkbox", checked: value === true || value === "true" });
      input.addEventListener("change", () => setParam(n, p.name, input.checked));
      return h("label", { class: "field fn-check" }, input, lbl, help);
    } else if (p.type === "number") {
      input = h("input", { class: "input input--sm", type: "number", value: value ?? "" });
      input.addEventListener("change", () => setParam(n, p.name, input.value === "" ? p.default : Number(input.value)));
    } else if (p.type === "code" || p.type === "jscode") {
      // jscode (5.3): browser JavaScript — always JavaScript, whatever the flow's language.
      const host = h("div", { class: "fb-code" });
      const E = window.M5Editor;
      if (E) {
        let t = null;
        const ed = E.create(host, { doc: String(value ?? ""), lang: p.type === "jscode" ? "js" : flow.lang, sdk: p.type === "jscode" ? [] : (ctx && ctx.sdk && ctx.sdk.spec) || [], minHeight: "60px", maxHeight: "260px", lineNumbers: p.name === "code", onChange: (text) => { clearTimeout(t); t = setTimeout(() => setParam(n, p.name, text), 400); } });
        sideEditors.push(ed);
      }
      const tool = p.type === "jscode" && window.M5FnOut ? h("button", { class: "btn btn--xs mt8", type: "button", onclick: () => window.M5FnOut.browserJsTool({ lang: flow.lang, spec: { code: String(value ?? "") }, onApply: (spec) => { setParam(n, p.name, spec.code); drawSide(); } }) }, "Templates and a try-out…") : null;
      return h("div", { class: "field" }, lbl, host, tool, help);
    } else if (p.type === "form" || p.type === "button") {
      // 5.3: edited in the console's form / button builder; stored as an object.
      const X = window.M5FnOut;
      let v = value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = {}; } }
      v = v && typeof v === "object" ? v : {};
      const count = (v.fields || []).length + (v.panels || []).reduce((a, x) => a + ((x && x.fields) || []).length, 0);
      const summary = p.type === "form" ? `${v.title || v.name || "form"} · ${count} field${count === 1 ? "" : "s"}${(v.panels || []).length ? ` in ${v.panels.length} panel${v.panels.length === 1 ? "" : "s"}` : ""}` : `${v.icon ? v.icon + " " : ""}${v.title || "button"} · name “${v.name || ""}”`;
      const btn = h("button", { class: "btn btn--sm", type: "button", onclick: () => { if (!X) { toast("functions-outputs.js is missing.", "err"); return; } (p.type === "form" ? X.formBuilder : X.buttonBuilder)({ spec: v, lang: flow.lang, onApply: (spec) => { setParam(n, p.name, spec); drawSide(); } }); } }, p.type === "form" ? "▦ Edit the form…" : "▭ Edit the button…");
      return h("div", { class: "field" }, lbl, h("div", { class: "fn-row" }, btn, h("span", { class: "muted small" }, summary)), help);
    } else if (p.type === "text" || p.type === "json") {
      input = h("textarea", { class: `input input--sm${p.type === "json" ? " fn-mono" : ""}`, rows: p.type === "json" ? 3 : 3, placeholder: p.placeholder || "" });
      input.value = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
      input.addEventListener("change", () => {
        if (p.type === "json" && input.value.trim()) { try { JSON.parse(input.value); input.classList.remove("is-bad"); } catch { input.classList.add("is-bad"); toast("That is not valid JSON.", "err"); return; } }
        setParam(n, p.name, input.value);
      });
    } else {
      input = h("input", { class: "input input--sm", value: value ?? "", placeholder: p.placeholder || "", spellcheck: "false" });
      input.addEventListener("change", () => setParam(n, p.name, input.value));
    }
    return h("label", { class: "field" }, lbl, input, help);
  }

  function inputField(n, p) {
    const e = G().edges.find((x) => x.to.node === n.id && x.to.port === p.name);
    const lbl = h("span", { class: "label" }, h("span", { class: `fb-dot fb-t--${p.type}` }), ` ${p.label || p.name}`, p.required ? " *" : "", h("span", { class: "muted small" }, ` · ${p.type}`));
    if (e) {
      const src = byId(e.from.node);
      return h("div", { class: "field" }, lbl, h("div", { class: "fn-row" }, h("span", { class: "fb-wired" }, `← ${e.from.node} · ${src ? (src.label || defOf(src).title) : "?"} → ${e.from.port}`), C.can("operator") ? h("button", { class: "btn btn--xs", title: "Remove the wire", onclick: () => { snapshot(); G().edges = G().edges.filter((x) => x !== e); drawNodes(); drawWires(); changed(); drawSide(); } }, "×") : null));
    }
    if (!p.field) return h("div", { class: "field" }, lbl, h("span", { class: "muted small" }, "Connect a wire (bytes come from another node)."));
    const v = n.values ? n.values[p.name] : undefined;
    const set = (value) => { snapshot(); n.values = n.values || {}; if (value === "" || value === undefined) delete n.values[p.name]; else n.values[p.name] = value; redrawNode(n); drawWiresSoon(); changed(); };
    let input;
    if (p.field === "boolean") { input = h("input", { type: "checkbox", checked: v === true || (v === undefined && p.default === true) }); input.addEventListener("change", () => set(input.checked)); return h("label", { class: "field fn-check" }, input, lbl); }
    if (p.field === "number") { input = h("input", { class: "input input--sm", type: "number", value: v ?? "", placeholder: p.default !== undefined ? String(p.default) : "" }); input.addEventListener("change", () => set(input.value === "" ? "" : Number(input.value))); }
    else if (p.field === "json") { input = h("textarea", { class: "input input--sm fn-mono", rows: 2, placeholder: p.default !== undefined ? JSON.stringify(p.default) : "JSON: [1, 2] or {\"a\": 1}" }); input.value = v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v); input.addEventListener("change", () => { if (input.value.trim()) { try { JSON.parse(input.value); } catch { input.classList.add("is-bad"); toast("That is not valid JSON.", "err"); return; } } input.classList.remove("is-bad"); set(input.value); }); }
    else { input = h("input", { class: "input input--sm", value: v ?? "", placeholder: p.placeholder || (p.default !== undefined ? String(p.default) : "a value, or wire it") }); input.addEventListener("change", () => set(input.value)); }
    return h("label", { class: "field" }, lbl, input);
  }

  /* ------------------------------------------------------------ code */

  function codePane(body) {
    let compiled = null, err = null;
    try { compiled = F().compileFlow(flow); } catch (e) { err = e; }
    if (err) {
      body.append(h("div", { class: "fn-err" }, err.message), err.node ? h("button", { class: "btn btn--sm mt8", onclick: () => { selected = { kind: "node", id: err.node }; sideTab = "inspect"; centerOn(err.node); drawNodes(); drawWires(); drawSide(); } }, `Show ${err.node}`) : "");
      return;
    }
    body.append(h("div", { class: "fn-row" }, h("strong", { class: "small" }, compiled.file), h("span", { class: "fb-grow" }),
      h("button", { class: "btn btn--xs", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(compiled.code); toast("Copied.", "ok"); } }, "Copy"),
      C.can("operator") ? h("button", { class: "btn btn--xs", title: "Save the code as a normal package, without the flow — to go on in the code editor", onclick: () => eject(compiled) }, "Eject to code…") : null));
    const host = h("div", { class: "fb-codeview" });
    body.append(host);
    const E = window.M5Editor;
    if (E) sideEditors.push(E.show(host, compiled.code, flow.lang, { minHeight: "200px", maxHeight: "calc(100vh - 360px)", sdk: (ctx && ctx.sdk && ctx.sdk.spec) || [] }));
    else host.append(h("pre", { class: "fn-code" }, compiled.code));
    body.append(h("p", { class: "muted small" }, "This is what Save writes to the package (with the flow next to it as flow.m5flow.json). Runs from here add a trace line per node."));
  }

  async function eject(compiled) {
    const v = await ctx.formDialog({ title: "Eject to code", subtitle: "a new package without the flow", submit: "Create", fields: [{ name: "name", label: "Package name", value: slugName(flow.name || "flow") + "-code", required: true }] });
    if (!v) return;
    try {
      const r = await api("/admin/functions/packages", { method: "POST", body: { name: v.name.trim(), language: flow.lang, description: flow.summary || "" } });
      await api(`/admin/functions/packages/${encodeURIComponent(r.package.id)}/draft`, { method: "PUT", body: { files: { [compiled.file]: compiled.code.replace(/^(\/\/|#) Generated by[\s\S]*?\n\n/, "") } } });
      toast(`Created ${r.package.name}.`, "ok");
      ctx.openPackage(r.package.id);
    } catch (e) { toast(e.message, "err"); }
  }

  /* ------------------------------------------------------------ run */

  function runPane(body) {
    const inputs = F().flowInputs(G());
    if (fnName !== "execute") body.append(h("div", { class: "muted small" }, `Runs the ${fnName} function (give it what it would get — e.g. Input nodes named name and data for a button). A button or a form in a result of execute runs these functions too.`));
    const form = h("form", { class: "fb-runform" });
    for (const i of inputs) {
      if (runValues[i.name] === undefined && i.default !== undefined) runValues[i.name] = i.default;
      const v = runValues[i.name];
      let input;
      if (i.type === "enum") { input = h("select", { class: "input input--sm" }); for (const x of i.values || []) input.append(h("option", { value: x, selected: String(v) === x }, x)); input.addEventListener("change", () => { runValues[i.name] = input.value; }); }
      else if (i.type === "boolean") { input = h("input", { type: "checkbox", checked: v === true }); input.addEventListener("change", () => { runValues[i.name] = input.checked; }); }
      else if (i.type === "text" || i.type === "json") { input = h("textarea", { class: "input input--sm", rows: 2 }); input.value = v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); input.addEventListener("input", () => { runValues[i.name] = input.value; }); }
      else { input = h("input", { class: "input input--sm", type: i.type === "integer" || i.type === "number" ? "number" : "text", value: v === undefined ? "" : String(v) }); input.addEventListener("input", () => { runValues[i.name] = i.type === "integer" || i.type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value; }); }
      form.append(h("label", { class: "field" }, h("span", { class: "label" }, (i.label || i.name) + (i.required ? " *" : ""), h("span", { class: "muted small" }, ` · ${i.type}`)), input));
    }
    if (!inputs.length) form.append(h("div", { class: "muted small" }, "The flow has no Input nodes."));
    form.append(h("button", { class: "btn btn--primary btn--sm", type: "submit" }, "▶ Run"));
    form.addEventListener("submit", (e) => { e.preventDefault(); startRun(); });
    body.append(form);
    if (!runBox) runBox = h("div", { class: "fn-run__result" });
    body.append(runBox);
  }

  function startRun() {
    let compiled;
    try { compiled = F().compileFlow(flow, { trace: true }); }
    catch (e) { toast(e.message, "err"); if (e.node) { selected = { kind: "node", id: e.node }; centerOn(e.node); drawNodes(); drawWires(); } drawSide(); return; }
    if (!runBox) { sideTab = "run"; drawSide(); }
    const inputs = {};
    for (const i of F().flowInputs(G())) if (runValues[i.name] !== undefined && runValues[i.name] !== "") inputs[i.name] = runValues[i.name];
    results = {};
    drawNodes(); drawWires();
    ctx.liveRunInto(runBox, { adhoc: { lang: flow.lang, files: { [compiled.file]: compiled.code }, file: compiled.file, fn: fnName }, inputs, limits: { wallMs: 60000 } }, {
      onTrace: (l) => {
        const f = l.fields || {};
        if (!f.node) return;
        if (l.msg === "flow:node") results[f.node] = { value: f.value };
        else results[f.node] = { ...(results[f.node] || {}), error: String(f.error || "failed") };
        const n = byId(f.node);
        if (n) { redrawNode(n); drawWiresSoon(); }
      },
    });
  }

  /* ============================================================ saving */

  const slugName = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "flow";

  async function save() {
    if (!C.can("operator")) return false;
    let issues = [];
    try { issues = F().checkFlow(flow); F().compileFlow(flow); } catch (e) { toast(`Fix the flow first: ${e.message}`, "err"); return false; }
    let created = false;
    if (!target) {
      const same = (ctx.data.packages || []).filter((p) => p.language === flow.lang);
      const v = await ctx.formDialog({
        title: "Save the flow", subtitle: "to a package", submit: "Save",
        fields: [
          { name: "where", label: "Where", type: "select", value: "new", options: [{ value: "new", label: "A new package" }, ...same.map((p) => ({ value: p.id, label: `${p.name}${p.flow ? " (has a flow — replaced)" : " (its main file is replaced)"}` }))], onchange: (val, inp) => { const row = inp.name && inp.name.closest(".field"); if (row) row.hidden = val !== "new"; } },
          { name: "name", label: "Package name", value: slugName(flow.name), hint: "Lower-case letters, digits and hyphens." },
        ],
      });
      if (!v) return false;
      try {
        if (v.where === "new") {
          const r = await api("/admin/functions/packages", { method: "POST", body: { name: v.name.trim(), language: flow.lang, description: flow.summary || "" } });
          target = { id: r.package.id, name: r.package.name, language: r.package.language };
          created = true;
        } else {
          const p = same.find((x) => x.id === v.where);
          target = { id: p.id, name: p.name, language: p.language };
        }
      } catch (e) { toast(e.message, "err"); return false; }
    }
    try {
      await api(`/admin/functions/packages/${encodeURIComponent(target.id)}/flow`, { method: "PUT", body: { flow } });
      savedJson = JSON.stringify(flow);
      remember();
      toast(`Saved to ${target.name} (draft)${issues.some((i) => i.level === "warning") ? " — with warnings" : ""}.`, "ok");
      // The console's overview (packages, their flow flags) is stale now: reload it (re-renders the builder).
      if (created || !(ctx.data.packages || []).some((p) => p.id === target.id && p.flow)) await ctx.reload();
      else { drawBar(); changed(); drawSide(); }
      return true;
    } catch (e) { toast(e.message, "err"); return false; }
  }

  async function makeModel() {
    if (!(await save())) return;
    const inputs = F().flowInputs(flow);
    const fnsIn = F().compileFlow(flow).functions;
    const existing = (ctx.data.models || []).find((m) => (m.entry || "").startsWith(`${target.name}@`));
    const v = await ctx.formDialog({
      title: existing ? `Update the model “${existing.name}”` : "Create a model", subtitle: `publishes ${target.name} and points the model at it`, submit: existing ? "Publish & update" : "Publish & create",
      fields: [
        { name: "name", label: "Name", value: existing ? existing.name : flow.name || target.name, required: true },
        { name: "keyword", label: "Chat keyword (/keyword)", value: existing ? existing.keyword : slugName(flow.name || target.name).replace(/-/g, ""), hint: "Empty: not a chat command." },
        { name: "summary", label: "Summary", value: existing ? existing.summary : flow.summary || "" },
        { name: "visibility", label: "Output goes", type: "select", value: existing ? existing.executors.chat.visibility : "room", options: [{ value: "room", label: "to the room" }, { value: "caller", label: "only to the caller" }] },
        { name: "bump", label: "Version", type: "select", value: "patch", options: [{ value: "patch", label: "patch (x.y.Z)" }, { value: "minor", label: "minor (x.Y.0)" }, { value: "major", label: "major (X.0.0)" }] },
        { name: "enabled", label: "Switch it on", type: "checkbox", value: existing ? existing.enabled : true },
      ],
    });
    if (!v) return;
    try {
      const pub = await api(`/admin/functions/packages/${encodeURIComponent(target.id)}/publish`, { method: "POST", body: { bump: v.bump } });
      const file = flow.lang === "py" ? "index.py" : "index.js";
      const base = existing ? clone(existing) : { id: "", onEvent: "", runtime: "server", outputs: ["markdown"], limits: {}, groups: [], executors: { chat: { enabled: true, visibility: "room" }, console: { enabled: true } } };
      delete base.entryOk; delete base.webhookUrl;
      const model = { ...base, name: v.name.trim(), keyword: v.keyword.trim(), summary: v.summary.trim(), entry: `${target.name}@${pub.version.version}:${file}#execute`, inputs, enabled: Boolean(v.enabled) };
      // 5.3: the flow's functions become the model's entry points (a webhook is added switched off — turn it on in Models).
      const eps = (base.endpoints || []).map((e) => { const { url: _u, hidden: _h, hasSecret: _s, ...rest } = e; return rest; });
      const upsert = (type, fn, ins) => {
        const same = eps.find((e) => e.type === type && (type !== "webhook" || e.fn === fn));
        if (same) { same.fn = fn; same.inputs = ins; }
        else eps.push({ id: type === "webhook" ? "" : type, type, fn, inputs: ins, enabled: type !== "webhook", ...(type === "webhook" ? { name: "Webhook", mode: "sync", auth: "none", log: "full" } : {}) });
      };
      upsert("execute", `${file}#execute`, inputs);
      for (const f of fnsIn) if (f.name !== "execute" && F().FLOW_FUNCTIONS.includes(f.name)) upsert(f.name, `${file}#${f.name}`, f.inputs);
      model.endpoints = eps;
      model.executors = { ...model.executors, chat: { ...(model.executors.chat || {}), enabled: Boolean(v.keyword.trim()) || Boolean(model.executors.chat && model.executors.chat.enabled), visibility: v.visibility } };
      const r = await api("/admin/functions/models", { method: "POST", body: model });
      toast(`${existing ? "Updated" : "Created"} the model ${r.model.name} (${target.name}@${pub.version.version}).`, "ok");
      ctx.editModel(r.model.id);
    } catch (e) { toast(e.message, "err"); }
  }

  /* ============================================================ new / open */

  async function newDialog() {
    if (dirty() && G().nodes.length && !(await ctx.confirmDialog("The flow has unsaved changes. Start another one anyway? (Undo will not bring it back.)"))) return;
    const Kit = window.M5Kit;
    const grid = h("div", { class: "fb-gallery" });
    let dlg = null;
    const card = (title, doc, lang, onclick) => h("button", { class: "fb-gallery__card", onclick: () => { dlg.close(); onclick(); } }, h("strong", {}, title), h("span", { class: "muted small" }, doc), h("span", { class: `fn-lang fn-lang--${lang}` }, lang.toUpperCase()));
    grid.append(card("Empty flow", "A blank canvas (JavaScript).", "js", () => { API.newFlow("", "js"); rebuild(); }));
    grid.append(card("Empty flow", "A blank canvas (Python).", "py", () => { API.newFlow("", "py"); rebuild(); }));
    for (const ex of F().FLOW_EXAMPLES) grid.append(card(ex.title, ex.doc, ex.flow.lang, () => { API.openExample(ex.id); rebuild(); setTimeout(fit, 30); }));
    dlg = Kit.openDialog({ title: "New flow", subtitle: "start empty, or from an example", body: grid, wide: true });
  }

  async function openDialog() {
    const withFlow = (ctx.data.packages || []).filter((p) => p.flow);
    const Kit = window.M5Kit;
    const list = h("div", { class: "fb-gallery" });
    let dlg = null;
    if (!withFlow.length) list.append(h("p", { class: "muted" }, "No package has a flow yet — save one first."));
    for (const p of withFlow) {
      list.append(h("button", { class: "fb-gallery__card", onclick: async () => {
        dlg.close();
        try { const d = await api(`/admin/functions/packages/${encodeURIComponent(p.id)}`); API.openFromPackage(d.package, JSON.parse(d.draft.files["flow.m5flow.json"])); rebuild(); }
        catch (e) { toast(e.message, "err"); }
      } }, h("strong", {}, p.name), h("span", { class: "muted small" }, p.description || ""), h("span", { class: `fn-lang fn-lang--${p.language}` }, p.language.toUpperCase())));
    }
    dlg = Kit.openDialog({ title: "Open a flow", body: list, wide: true });
  }

  /** Replaces the builder on the page (after New / Open). */
  function rebuild() {
    const old = els && els.wrap;
    if (!old || !old.isConnected) return;
    const fresh = build(); // reassigns els
    old.replaceWith(fresh);
    requestAnimationFrame(drawWires);
  }
})();
