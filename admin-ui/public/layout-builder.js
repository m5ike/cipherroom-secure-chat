// M5cet operator console — Layout builder (4.0.5): a GUI designer for the
// app's layouts — the app bar, the chat window, incoming / outgoing / system
// messages, the composer and the recipients widget.
//
// A layout is a tree of elements from the PALETTE (panels, areas, rows,
// text, headings, buttons, inputs, icons, images, the logo, avatars, safe
// HTML, live parts of the app, reusable templates…). The app's own layouts
// are trees too (client/src/lib/layouts/*), so what the builder shows is
// exactly what users see; the preview on the right is the app itself
// (layout-preview.html: its components, CSS and templates with sample data).
//
//   GET  /admin/layout          config, defaults, the catalog (palette,
//                               attributes, CSS, classes, icons, every
//                               layout with its default tree and contract)
//   PUT  /admin/layout          save (validated by the server)
//
// Every field suggests while typing: tags, classes (the ones the app's
// stylesheet really has), attributes and their values, CSS properties and
// values, variables, actions, parts. Same rules as console.js: DOM nodes
// and textContent only, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  const Kit = window.M5Kit;
  if (!C || !Kit) return;
  const { h, clear, $, $$, api, toast } = C;

  const GROUPS = [["layout", "Layout"], ["content", "Text & media"], ["controls", "Controls"], ["logic", "Logic & parts"]];
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const BLOCK_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const EXPR_TOKEN = /\$?[A-Za-z0-9_.]*$/;
  const TEXT_TOKEN = /\{[$_]?[A-Za-z0-9_.']*$/;

  let config = null;
  let savedJson = "";
  let catalog = null;
  let file = "";
  let readOnly = true;
  /** A layout id, "block:<name>" or "settings". */
  let current = "chat";
  let selection = null;
  const view = { variant: "", theme: "ios", tone: "light", lang: "cs", mode: "select", device: "desktop" };
  let undoStack = [];
  let redoStack = [];
  let lastSnap = 0;
  let wired = false;
  let clipboard = null;
  /** What is being dragged: { id } (a node) or { make } (a new node). */
  let drag = null;
  let previewReady = false;
  let previewErrors = [];
  let paletteQuery = "";
  /** The app's own trees as JSON (compared on every change). */
  let defaultJson = {};

  const clone = (v) => JSON.parse(JSON.stringify(v));
  /** JSON with sorted keys: "the same" whatever order an edit left the keys in. */
  const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const comparable = (cfg) => stable(normalized(cfg));
  const dirty = () => Boolean(config) && comparable(config) !== savedJson;
  const layoutInfo = (id) => (catalog ? catalog.layouts.find((l) => l.id === id) : null);
  const isBlock = () => current.startsWith("block:");
  const blockName = () => current.slice(6);
  const elementDef = (el) => (catalog ? catalog.elements.find((d) => d.el === el) : null);

  /** A config without layouts that equal the app's own (so the app's updates reach them). */
  function normalized(cfg) {
    const out = { ...cfg, updatedAt: 0, layouts: {} };
    for (const [id, saved] of Object.entries(cfg.layouts || {})) {
      const info = layoutInfo(id);
      if (!info || stable(saved.tree) !== defaultJson[id]) out.layouts[id] = saved;
    }
    return out;
  }

  /* ============================================================== loading */

  async function load() {
    const r = await api("/admin/layout");
    catalog = r.catalog;
    catalog.defaults = r.defaults;
    defaultJson = Object.fromEntries(catalog.layouts.map((l) => [l.id, stable(l.tree)]));
    file = r.file || "";
    config = clone(r.layout);
    config.layouts = config.layouts || {};
    config.blocks = config.blocks || {};
    savedJson = comparable(config);
    undoStack = [];
    redoStack = [];
    readOnly = !C.can("operator");
    if (!(current === "settings" || isBlock() || layoutInfo(current))) current = "chat";
    if (isBlock() && !config.blocks[blockName()]) current = "chat";
    selection = null;
    if (!view.variant) view.variant = variantsOf(current)[0]?.id || "";
    wire();
    renderAll();
    sendPreview();
  }

  /* ================================================================ trees */

  /** The tree on screen (not copied). */
  function viewTree() {
    if (isBlock()) return config.blocks[blockName()]?.tree || null;
    if (current === "settings") return null;
    return config.layouts[current]?.tree || layoutInfo(current)?.tree || null;
  }
  /** The tree to change: a layout becomes the operator's own on its first edit. */
  function editTree() {
    if (isBlock()) return config.blocks[blockName()].tree;
    if (!config.layouts[current]) config.layouts[current] = { tree: clone(layoutInfo(current).tree), rev: layoutInfo(current).rev };
    return config.layouts[current].tree;
  }
  function walk(node, visit, parent = null, depth = 0) {
    visit(node, parent, depth);
    for (const c of node.children || []) walk(c, visit, node, depth + 1);
  }
  function find(id, tree = viewTree()) {
    let out = null;
    if (!tree) return null;
    walk(tree, (n, parent) => {
      if (out || n.id !== id) return;
      out = { node: n, parent, index: parent ? parent.children.indexOf(n) : -1 };
    });
    return out;
  }
  function allIds(tree = viewTree()) {
    const ids = new Set();
    if (tree) walk(tree, (n) => ids.add(n.id));
    return ids;
  }
  function uniqueId(base, taken = allIds()) {
    const stem = String(base).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "el";
    if (!taken.has(stem)) return stem;
    for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
  }
  /** Fresh ids for a copied subtree (none may clash with the tree it goes into). */
  function freshIds(node, taken) {
    node.id = uniqueId(node.id.replace(/-\d+$/, ""), taken);
    taken.add(node.id);
    for (const c of node.children || []) freshIds(c, taken);
    return node;
  }
  function isContainer(node) {
    const def = elementDef(node.el);
    return Boolean(def && def.container);
  }
  /** Whether `kind` may go into `parent`. */
  function accepts(parent, kind) {
    if (!parent || !isContainer(parent)) return false;
    if (parent.el === "select") return kind === "option" || kind === "group";
    return true;
  }
  function contains(ancestor, id) {
    let found = false;
    walk(ancestor, (n) => { if (n.id === id) found = true; });
    return found;
  }

  function newNode(make) {
    if (make.block) return { id: uniqueId(`tpl-${make.block}`), el: "block", block: make.block, name: config.blocks[make.block]?.label || make.block };
    if (make.slot) return { id: uniqueId(`part-${make.slot}`), el: "slot", slot: make.slot };
    if (make.copyOf) return freshIds(clone(make.copyOf), allIds());
    const def = elementDef(make.el);
    const node = { id: uniqueId(make.el), el: make.el };
    if (def.tag) node.tag = def.tag;
    Object.assign(node, clone(def.preset || {}));
    if (def.container && !node.children) node.children = [];
    return node;
  }
  const kindOf = (make) => (make.block ? "block" : make.slot ? "slot" : make.copyOf ? make.copyOf.el : make.el);

  /* ============================================================= history */

  function snapshot() {
    undoStack.push(JSON.stringify(config));
    if (undoStack.length > 150) undoStack.shift();
    redoStack = [];
  }
  /** Changes the draft; typing into one field is one undo step. */
  function commit(change, { coalesce = false, props = false, tree = true } = {}) {
    if (readOnly) return;
    const now = Date.now();
    if (!coalesce || now - lastSnap > 900) snapshot();
    lastSnap = coalesce ? now : 0;
    change();
    if (tree) renderTree();
    if (props) renderProps();
    renderChrome();
    sendPreview();
  }
  const edit = (change, opts = {}) => commit(change, { coalesce: true, ...opts });
  function jump(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(config));
    config = JSON.parse(from.pop());
    lastSnap = 0;
    if (isBlock() && !config.blocks[blockName()]) current = "chat";
    if (selection && !find(selection)) selection = null;
    renderAll();
    sendPreview();
  }
  const undo = () => jump(undoStack, redoStack);
  const redo = () => jump(redoStack, undoStack);

  /* ========================================================== operations */

  /** Adds a new element: into the selected container, else after the selection, else into the root. */
  function add(make) {
    const tree = viewTree();
    if (!tree) return;
    const kind = kindOf(make);
    let placed = null;
    commit(() => {
      const t = editTree();
      const node = newNode(make);
      const sel = selection ? find(selection, t) : null;
      if (sel && accepts(sel.node, kind)) { sel.node.children = sel.node.children || []; sel.node.children.push(node); }
      else if (sel && sel.parent && accepts(sel.parent, kind)) sel.parent.children.splice(sel.index + 1, 0, node);
      else if (accepts(t, kind)) { t.children = t.children || []; t.children.push(node); }
      else { toast("Nothing here takes this element.", "err"); return; }
      placed = node.id;
    });
    if (placed) select(placed);
  }
  function remove(id) {
    const f = find(id);
    if (!f || !f.parent) { toast("The outermost element stays — change or empty it instead.", "err"); return; }
    const inside = (f.node.children || []).length;
    if (inside && !confirm(`Remove this element and the ${inside} inside it?`)) return;
    const next = f.parent.children[f.index + 1]?.id || f.parent.children[f.index - 1]?.id || f.parent.id;
    commit(() => { const g = find(id, editTree()); g.parent.children.splice(g.index, 1); });
    select(next);
  }
  function duplicate(id) {
    const f = find(id);
    if (!f || !f.parent) return;
    let copyId = null;
    commit(() => {
      const g = find(id, editTree());
      const copy = freshIds(clone(g.node), allIds(editTree()));
      g.parent.children.splice(g.index + 1, 0, copy);
      copyId = copy.id;
    });
    select(copyId);
  }
  /** Moves a node (or a new one) to a parent at an index. */
  function place(target) {
    const parentId = target.parent;
    if (drag && drag.id) {
      const id = drag.id;
      commit(() => {
        const t = editTree();
        const f = find(id, t);
        const p = find(parentId, t).node;
        f.parent.children.splice(f.index, 1);
        let at = target.index;
        if (f.parent === p && f.index < at) at -= 1;
        p.children = p.children || [];
        p.children.splice(Math.max(0, Math.min(at, p.children.length)), 0, f.node);
      });
      select(id);
    } else if (drag && drag.make) {
      let made = null;
      commit(() => {
        const t = editTree();
        const p = find(parentId, t).node;
        const node = newNode(drag.make);
        p.children = p.children || [];
        p.children.splice(Math.max(0, Math.min(target.index, p.children.length)), 0, node);
        made = node.id;
      });
      if (made) select(made);
    }
  }
  function canDrop(parentNode) {
    if (!drag || !parentNode) return false;
    if (drag.id) {
      const f = find(drag.id);
      if (!f || !f.parent) return false;
      if (contains(f.node, parentNode.id)) return false;
      return accepts(parentNode, f.node.el);
    }
    return accepts(parentNode, kindOf(drag.make));
  }
  /** Up / down among its siblings; at an end, out into the parent's parent. */
  function step(id, dir) {
    const f = find(id);
    if (!f || !f.parent) return;
    const sibs = f.parent.children;
    const next = f.index + dir;
    if (next >= 0 && next < sibs.length) {
      commit(() => { const g = find(id, editTree()); const [n] = g.parent.children.splice(g.index, 1); g.parent.children.splice(next, 0, n); });
      return;
    }
    const pf = find(f.parent.id);
    if (pf && pf.parent && accepts(pf.parent, f.node.el)) {
      commit(() => {
        const t = editTree();
        const g = find(id, t);
        const [n] = g.parent.children.splice(g.index, 1);
        const pg = find(f.parent.id, t);
        pg.parent.children.splice(dir > 0 ? pg.index + 1 : pg.index, 0, n);
      });
    }
  }
  function wrap(id) {
    const f = find(id);
    if (!f || !f.parent) return;
    let panelId = null;
    commit(() => {
      const t = editTree();
      const g = find(id, t);
      const panel = { id: uniqueId("panel", allIds(t)), el: "panel", tag: "div", children: [g.node] };
      g.parent.children.splice(g.index, 1, panel);
      panelId = panel.id;
    });
    select(panelId);
  }
  function unwrap(id) {
    const f = find(id);
    if (!f || !f.parent || !(f.node.children || []).length) return;
    if (!f.node.children.every((c) => accepts(f.parent, c.el))) { toast("The parent does not take these elements.", "err"); return; }
    commit(() => { const g = find(id, editTree()); g.parent.children.splice(g.index, 1, ...g.node.children); });
    select(f.node.children[0].id);
  }
  function saveAsTemplate(id) {
    const f = find(id);
    if (!f) return;
    const name = (prompt("Name of the template (a–z, 0–9, -):", f.node.name ? f.node.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32) : f.node.id) || "").trim();
    if (!name) return;
    if (!BLOCK_RE.test(name)) { toast("A template name: a–z, 0–9 and -, up to 32.", "err"); return; }
    if (config.blocks[name] && !confirm(`Replace the template "${name}"?`)) return;
    commit(() => { config.blocks[name] = { tree: clone(f.node), label: f.node.name || name }; });
    renderPalette();
    toast(`Template "${name}" saved — drag it from the palette (My templates) into any layout.`, "ok");
  }
  function select(id) {
    selection = id;
    renderTree();
    renderProps();
    sendPreview();
    const row = id && $(`#lbTree .mbt-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }
  function switchTo(target) {
    current = target;
    selection = null;
    const variants = variantsOf(current);
    if (!variants.some((v) => v.id === view.variant)) view.variant = variants[0]?.id || "";
    renderAll();
    sendPreview();
  }

  /* ============================================================== labels */

  const icon = (name, cls) => Kit.iconSvg(catalog && catalog.icons, name, cls);
  function titleOf(n) {
    if (n.name) return n.name;
    const cls = n.attrs && n.attrs.class ? `.${n.attrs.class.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}` : "";
    switch (n.el) {
      case "text": return `“${(n.text || "").slice(0, 40)}”`;
      case "icon": return `icon ${n.props?.icon || ""}`;
      case "slot": return `part: ${n.slot}`;
      case "block": return `template: ${n.block}`;
      case "avatar": return "avatar";
      case "logo": return "logo";
      default: return `<${n.tag || n.el}>${cls}${n.text ? ` “${n.text.slice(0, 24)}”` : ""}`;
    }
  }
  function nodeIcon(n) {
    if (n.el === "icon" && n.props?.icon && !n.props.icon.includes("{") && catalog.icons[n.props.icon]) return n.props.icon;
    return elementDef(n.el)?.icon || "square";
  }

  /* ============================================================== tabs */

  function renderTabs() {
    const box = $("#lbTabs");
    clear(box);
    for (const l of catalog.layouts) {
      const own = Boolean(config.layouts[l.id]) && stable(config.layouts[l.id].tree) !== defaultJson[l.id];
      const stale = own && config.layouts[l.id].rev && config.layouts[l.id].rev !== l.rev;
      box.append(h("button", {
        type: "button", role: "tab", class: `lb-tab${current === l.id ? " is-on" : ""}`, "aria-selected": current === l.id ? "true" : "false", "data-layout": l.id, "data-read": "1",
        title: l.contract.description, onclick: () => switchTo(l.id),
      }, l.label, own ? h("span", { class: `lb-dot${stale ? " is-stale" : ""}`, title: stale ? "Yours — the app's own changed since" : "Yours" }) : null));
    }
    for (const name of Object.keys(config.blocks)) {
      box.append(h("button", { type: "button", role: "tab", class: `lb-tab lb-tab--block${current === `block:${name}` ? " is-on" : ""}`, "data-layout": `block:${name}`, "data-read": "1", onclick: () => switchTo(`block:${name}`) },
        icon("bookmark", "mb-ico"), config.blocks[name].label || name));
    }
    box.append(h("button", { type: "button", role: "tab", class: `lb-tab lb-tab--settings${current === "settings" ? " is-on" : ""}`, "data-layout": "settings", "data-read": "1", onclick: () => switchTo("settings") },
      icon("sliders-horizontal", "mb-ico"), "Texts & behaviour"));
  }

  /* ============================================================ palette */

  function renderPalette() {
    const box = $("#lbPalette");
    clear(box);
    if (current === "settings") return;
    const search = h("input", { class: "input lb-palette__search", type: "search", placeholder: "Find an element…", "aria-label": "Find an element", "data-read": "1" });
    search.value = paletteQuery;
    search.addEventListener("input", () => { paletteQuery = search.value; renderPaletteItems(items); });
    const items = h("div", { class: "lb-palette__items" });
    box.append(search, items);
    renderPaletteItems(items);
  }
  function paletteButton(make, label, iconName, hint, extra) {
    const btn = h("button", {
      type: "button", class: "lb-pal", draggable: readOnly ? undefined : "true", title: hint, "data-read": "1",
      "data-make": make.el || (make.slot ? `slot:${make.slot}` : `block:${make.block}`),
    }, icon(iconName, "mb-ico"), h("span", {}, label), extra || null);
    btn.addEventListener("click", () => { if (!readOnly) add(make); });
    btn.addEventListener("dragstart", (e) => {
      if (readOnly) return;
      drag = { make };
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", JSON.stringify(make));
      setTimeout(() => $("#lbTree")?.classList.add("is-dragging"), 0);
    });
    btn.addEventListener("dragend", () => { drag = null; $("#lbTree")?.classList.remove("is-dragging"); clearMarks(); });
    return btn;
  }
  function renderPaletteItems(box) {
    clear(box);
    const q = paletteQuery.trim().toLowerCase();
    const hit = (s) => !q || s.toLowerCase().includes(q);
    for (const [g, gLabel] of GROUPS) {
      const defs = catalog.elements.filter((d) => d.group === g && d.el !== "slot" && d.el !== "block" && (hit(d.label) || hit(d.el) || hit(d.hint)));
      const extra = [];
      if (g === "logic" && !isBlock()) {
        const info = layoutInfo(current);
        for (const s of info?.contract.slots || []) if (hit(s.name) || hit(s.description)) extra.push(paletteButton({ slot: s.name }, s.name, "puzzle", `App part — ${s.description}`));
      }
      if (!defs.length && !extra.length) continue;
      box.append(h("div", { class: "lb-palette__group" }, h("div", { class: "lb-palette__title" }, gLabel),
        h("div", { class: "lb-palette__grid" }, defs.map((d) => paletteButton({ el: d.el }, d.label, d.icon, d.hint)), extra)));
    }
    const blocks = Object.entries(config.blocks).filter(([name, b]) => hit(name) || hit(b.label || ""));
    box.append(h("div", { class: "lb-palette__group" }, h("div", { class: "lb-palette__title" }, "My templates"),
      blocks.length ? h("div", { class: "lb-palette__grid" }, blocks.map(([name, b]) => {
        const btn = paletteButton({ block: name }, b.label || name, "bookmark", "A template: stays linked — changing it changes it everywhere");
        return h("span", { class: "lb-pal-block" }, btn,
          h("button", { type: "button", class: "mbt-btn", title: "Insert a copy (not linked)", "aria-label": `Insert a copy of ${name}`, "data-read": "1", onclick: () => { if (!readOnly) add({ copyOf: b.tree }); } }, icon("layers", "mb-ico")),
          h("button", { type: "button", class: "mbt-btn", title: "Edit the template", "aria-label": `Edit ${name}`, "data-read": "1", onclick: () => switchTo(`block:${name}`) }, icon("pencil", "mb-ico")));
      })) : h("p", { class: "muted small" }, "Select an element and press “Save as template” (its bookmark button) to reuse it.")));
  }

  /* =============================================================== tree */

  function renderTree() {
    const box = $("#lbTree");
    if (!box) return;
    const scroll = box.scrollTop;
    clear(box);
    const tree = viewTree();
    if (!tree) return;
    box.append(nodeTools(), h("ul", { class: "mbt-list lb-root", role: "group" }, nodeRow(tree, null, 0)));
    box.scrollTop = scroll;
  }
  /** What can be done with the selected element (one toolbar instead of buttons on every row). */
  function nodeTools() {
    const f = selection ? find(selection) : null;
    const n = f ? f.node : null;
    const root = Boolean(f && !f.parent);
    const tool = (iconName, label, onClick, disabled, cls = "") => h("button", {
      type: "button", class: `mbt-btn lb-tool ${cls}`, title: label, "aria-label": label, "data-read": "1", "data-tool": label.split(" ")[0].toLowerCase(),
      disabled: disabled || readOnly || undefined, onclick: () => onClick(),
    }, icon(iconName));
    return h("div", { class: "lb-tools", role: "toolbar", "aria-label": "The selected element" },
      h("span", { class: "lb-tools__label muted small" }, n ? titleOf(n) : "Select an element"),
      tool(n && n.hidden ? "eye-off" : "eye", n && n.hidden ? "Show it" : "Hide it", () => commit(() => { const g = find(n.id, editTree()).node; if (g.hidden) delete g.hidden; else g.hidden = true; }, { props: true }), !n),
      tool("arrow-right", "Up (Alt+↑)", () => step(n.id, -1), !n || root, "mbt-up"),
      tool("arrow-right", "Down (Alt+↓)", () => step(n.id, 1), !n || root, "mbt-down"),
      tool("layers", "Duplicate", () => duplicate(n.id), !n || root),
      tool("square", "Wrap in a panel", () => wrap(n.id), !n || root),
      tool("minimize-2", "Unwrap (keep the children)", () => unwrap(n.id), !n || root || !(n.children || []).length),
      tool("bookmark", "Save as template", () => saveAsTemplate(n.id), !n),
      tool("trash", "Remove", () => remove(n.id), !n || root, "mbt-del"));
  }
  function badges(n) {
    const out = [];
    if (n.if) out.push(h("span", { class: "mbt-chip mbt-chip--when", title: `Only when ${n.if}` }, "if"));
    if (n.each) out.push(h("span", { class: "mbt-chip mbt-chip--when", title: `Repeats for ${n.each}` }, "each"));
    if (n.on) out.push(h("span", { class: "mbt-chip", title: Object.entries(n.on).map(([e, b]) => `${e} → ${b.action}`).join(", ") }, "on"));
    if (n.style || n.css) out.push(h("span", { class: "mbt-chip mbt-chip--style", title: "Has its own style" }, "style"));
    if (previewErrors.some((e) => e.id === n.id)) out.push(h("span", { class: "mbt-chip lb-chip--err", title: previewErrors.filter((e) => e.id === n.id).map((e) => e.message).join("\n") }, "!"));
    return out;
  }
  function nodeRow(n, parent, index) {
    const selected = selection === n.id;
    const root = !parent;
    const row = h("div", {
      class: `mbt-row mbt-row--${n.el}${selected ? " is-selected" : ""}${n.hidden ? " is-hidden" : ""}${isContainer(n) ? " is-container" : ""}`,
      draggable: readOnly || root ? undefined : "true",
      "data-id": n.id, "data-parent": parent ? parent.id : "", "data-index": String(index),
      tabindex: "0", role: "treeitem", "aria-selected": selected ? "true" : "false",
    },
      readOnly || root ? null : h("span", { class: "mbt-grip", "aria-hidden": "true", title: "Drag" }, "⠿"),
      icon(nodeIcon(n)),
      h("span", { class: "mbt-title" }, titleOf(n)),
      h("span", { class: `mbt-kind lb-kind--${elementDef(n.el)?.group || "logic"}` }, elementDef(n.el)?.label || n.el),
      badges(n));
    const li = h("li", { class: "mbt-node", "data-id": n.id }, row);
    if (isContainer(n)) {
      const kids = n.children || [];
      const ul = h("ul", { class: "mbt-list", role: "group", "data-container": n.id });
      kids.forEach((c, i) => ul.append(nodeRow(c, n, i)));
      ul.append(h("li", { class: `mbt-drop${kids.length ? "" : " is-empty"}`, "data-container": n.id, "data-index": String(kids.length) }, kids.length ? "" : "drop here"));
      li.append(ul);
    }
    return li;
  }
  function clearMarks() {
    for (const el of $$(".drop-before, .drop-after, .drop-inside", $("#lbTree"))) el.classList.remove("drop-before", "drop-after", "drop-inside");
  }
  function dropTarget(event) {
    const zone = event.target.closest(".mbt-drop");
    if (zone) {
      const p = find(zone.dataset.container);
      return p && canDrop(p.node) ? { el: zone, where: "inside", parent: p.node.id, index: Number(zone.dataset.index) } : null;
    }
    const row = event.target.closest(".mbt-row[data-id]");
    if (!row || (drag && drag.id === row.dataset.id)) return null;
    const f = find(row.dataset.id);
    if (!f) return null;
    const rect = row.getBoundingClientRect();
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    if (isContainer(f.node) && (y > 0.28 && y < 0.72 || !f.parent) && canDrop(f.node)) {
      return { el: row, where: "inside", parent: f.node.id, index: (f.node.children || []).length };
    }
    if (!f.parent || !canDrop(f.parent)) return null;
    const where = y < 0.5 ? "before" : "after";
    return { el: row, where, parent: f.parent.id, index: where === "before" ? f.index : f.index + 1 };
  }

  /* ========================================================= properties */

  const kit = Kit.create({
    edit: (change, opts) => edit(change, opts),
    readOnly: () => readOnly,
    catalog: () => catalog && catalog.style,
    icons: () => catalog && catalog.icons,
    previewColor: (v) => (catalog && catalog.style.colorTokens[v]) || v,
  });
  const { field, textField, suggestField, selectField, checkField, numberField, group, grid, styleEditor } = kit;

  /** Variables in scope at a node: the layout's, and the loop variables of its ancestors. */
  function scopeVars(id) {
    const info = layoutInfo(current);
    const vars = (info ? info.contract.vars : []).map((v) => ({ value: v.path, hint: `${v.type} — ${v.description}` }));
    const tree = viewTree();
    if (tree && id) {
      const chain = [];
      const up = (n, path) => { if (n.id === id) { chain.push(...path, n); return true; } return (n.children || []).some((c) => up(c, [...path, n])); };
      up(tree, []);
      for (const a of chain) if (a.each) vars.unshift({ value: `$${a.as || "item"}`, hint: `each item of ${a.each}` }, { value: "$iterator.counter", hint: "1, 2, 3… in the repeat" });
    }
    vars.push({ value: "$arg", hint: "a template's argument" });
    return vars;
  }
  const exprItems = (id) => () => scopeVars(id);
  const textItems = (id) => () => [
    ...scopeVars(id).map((v) => ({ value: `{${v.value}}`, hint: v.hint })),
    { value: "{_'", hint: "a translated text: {_'menu.room'}" },
    { value: "{if $", hint: "a condition … {/if}" },
  ];
  const attrValueItems = (id, tag, name) => () => {
    const base = (catalog.attrs.values[`${tag}.${name}`] || catalog.attrs.values[name] || (catalog.attrs.boolean.includes(name) ? ["=true", "=false"] : [])).map((v) => ({ value: v }));
    return [...base, ...scopeVars(id).map((v) => ({ value: `=${v.value}`, hint: v.hint })), ...scopeVars(id).map((v) => ({ value: `{${v.value}}`, hint: "as text" }))];
  };

  function renderProps() {
    const box = $("#lbProps");
    if (!box) return;
    clear(box);
    if (current === "settings") { box.append(...settingsForm()); lockIfReadOnly(box); return; }
    const f = selection ? find(selection) : null;
    if (!f) {
      box.append(overview());
    } else {
      box.append(...nodeProps(f.node, f));
    }
    lockIfReadOnly(box);
  }
  function lockIfReadOnly(box) {
    if (!readOnly) return;
    for (const el of $$("input, select, textarea, button", box)) if (!el.closest(".mb-tabs") && !el.dataset.read) el.disabled = true;
  }
  function overview() {
    if (isBlock()) {
      const b = config.blocks[blockName()];
      return h("div", { class: "mb-props" },
        head("bookmark", `Template “${b.label || blockName()}”`, "Used by Template elements in any layout; they draw it with the values of the place they stand in (and $arg)."),
        group("Template",
          textField("Label", b.label, (v) => { b.label = v; }, { max: 60, prop: "block-label" }),
          h("div", { class: "mb-field--wide lb-row" },
            h("button", { type: "button", class: "btn btn--sm btn--danger", onclick: () => deleteBlock(blockName()) }, "Delete the template"))));
    }
    const info = layoutInfo(current);
    const own = Boolean(config.layouts[current]);
    const stale = own && config.layouts[current].rev && config.layouts[current].rev !== info.rev;
    return h("div", { class: "mb-props" },
      head("layout-dashboard", info.label, info.contract.description),
      stale ? h("div", { class: "lb-notice" }, "The app's own layout changed since this one was designed (an update). Keep yours, or “Reset this layout” to start from the new one.") : null,
      group("What it offers",
        h("div", { class: "mb-field--wide lb-contract" },
          h("p", { class: "small" }, h("b", {}, "Values: "), info.contract.vars.map((v) => v.path).join(", ")),
          h("p", { class: "small" }, h("b", {}, "Actions: "), info.contract.actions.map((a) => a.name).join(", ") || "—"),
          h("p", { class: "small" }, h("b", {}, "Parts: "), info.contract.slots.map((s) => s.name).join(", ") || "—"),
          h("p", { class: "small" }, h("b", {}, "Refs: "), info.contract.refs.map((r) => r.name).join(", ") || "—"),
          h("p", { class: "muted small" }, "Pick an element in the tree or in the preview to edit it; drag from the palette to add; ? Help lists all of it with descriptions."))),
    );
  }
  function head(iconName, title, hint) {
    return h("div", { class: "mb-props__head" }, icon(iconName, "mb-ico mb-ico--lg"), h("div", {}, h("strong", {}, title), h("div", { class: "muted small" }, hint)));
  }
  /** Sets or clears a key of a node's map (attrs, css, props, on). */
  function putIn(node, mapName, key, value) {
    const m = { ...(node[mapName] || {}) };
    if (value === undefined || value === "") delete m[key]; else m[key] = value;
    if (Object.keys(m).length) node[mapName] = m; else delete node[mapName];
  }
  /** The node being edited, fetched fresh from the editable tree (edits make a layout the operator's own). */
  const live = (id) => find(id, editTree()).node;

  function nodeProps(n, f) {
    const def = elementDef(n.el) || { label: n.el, hint: "" };
    const id = n.id;
    const out = [head(nodeIcon(n), `${def.label}${n.name ? ` · ${n.name}` : ""}`, def.hint)];
    const errs = previewErrors.filter((e) => e.id === id);
    if (errs.length) out.push(h("div", { class: "lb-notice lb-notice--err" }, errs.map((e) => h("div", {}, e.message))));
    // Element
    const basics = [
      idField(n),
      textField("Name in the tree", n.name, (v) => { const g = live(id); if (v.trim()) g.name = v; else delete g.name; }, { max: 60, prop: "name" }),
    ];
    if (def.tags && def.tags.length > 1) basics.push(suggestField("Tag", n.tag, (v) => { if (def.tags.includes(v)) live(id).tag = v; }, { items: () => def.tags, prop: "tag", valid: (v) => def.tags.includes(v), hint: def.tags.join(", ") }));
    basics.push(checkField("Hidden (kept here, not drawn)", n.hidden, (v) => { const g = live(id); if (v) g.hidden = true; else delete g.hidden; }, { prop: "hidden" }));
    out.push(group("Element", ...basics));
    // Content
    if (def.text === "html") {
      out.push(group("HTML",
        suggestField("HTML", n.text, (v) => { live(id).text = v; }, { area: true, rows: 8, items: textItems(id), token: TEXT_TOKEN, prop: "text", wide: true, max: 8000, hint: "Safe HTML: no scripts, handlers or url(); {$variables}, {if}, {foreach}. data-action=\"fn:<action>\" makes anything clickable." }),
        helpButton()));
    } else if (def.text === "template" || (def.container && n.text !== undefined)) {
      out.push(group("Content",
        suggestField(n.el === "text" ? "Text" : "Text (before the children)", n.text, (v) => { const g = live(id); if (v === "" && n.el !== "text") delete g.text; else g.text = v; }, {
          area: (n.text || "").length > 60, rows: 3, items: textItems(id), token: TEXT_TOKEN, prop: "text", wide: true, max: 8000,
          hint: "A template: {$variable}, {_'translation.key'}, {if $x}…{else}…{/if}, {$x|upper}.",
        }),
        helpButton()));
    } else if (def.container && def.text === undefined && !["group", "select", "list", "form"].includes(n.el)) {
      out.push(group("Content", h("button", { type: "button", class: "btn btn--sm mb-field--wide", onclick: () => edit(() => { live(id).text = "Text"; }, { props: true }) }, "Add a text before the children")));
    }
    // Parameters
    if (def.props && def.props.length) {
      out.push(group("Parameters", ...def.props.map((p) => propField(n, p))));
    }
    // Part / template
    if (n.el === "slot") {
      const info = layoutInfo(current);
      out.push(group("App part",
        suggestField("Part", n.slot, (v) => { live(id).slot = v; }, { items: () => (info ? info.contract.slots.map((s) => ({ value: s.name, hint: s.description })) : []), prop: "slot" }),
        suggestField("Argument (expression)", n.arg, (v) => { const g = live(id); if (v.trim()) g.arg = v; else delete g.arg; }, { items: exprItems(id), token: EXPR_TOKEN, prop: "arg", hint: (info?.contract.slots.find((s) => s.name === n.slot) || {}).arg || "" })));
    }
    if (n.el === "block") {
      out.push(group("Template",
        suggestField("Template", n.block, (v) => { live(id).block = v; }, { items: () => Object.keys(config.blocks), prop: "block" }),
        suggestField("Argument ($arg inside)", n.arg, (v) => { const g = live(id); if (v.trim()) g.arg = v; else delete g.arg; }, { items: exprItems(id), token: EXPR_TOKEN, prop: "arg" }),
        h("div", { class: "mb-field--wide lb-row" },
          h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { if (config.blocks[n.block]) switchTo(`block:${n.block}`); } }, "Edit the template"),
          h("button", { type: "button", class: "btn btn--sm", onclick: () => unlinkBlock(id) }, "Replace with a copy (unlink)"))));
    }
    // Attributes
    if (n.tag || ["icon", "logo", "avatar", "html"].includes(n.el)) out.push(attrsEditor(n));
    // CSS
    if (n.tag || ["icon", "html"].includes(n.el)) out.push(cssEditor(n));
    // Logic
    out.push(logicEditor(n, f));
    // Designer style
    if (n.tag || ["icon", "html"].includes(n.el)) {
      out.push(styleEditor("Style and states", () => n.style, (v) => { const g = live(id); if (v) g.style = v; else delete g.style; }, { open: Boolean(n.style) }));
    }
    return out;
  }
  /** The ID: applied when the field is left (the other fields follow the node by it). */
  function idField(n) {
    const input = h("input", { class: "input mono", maxlength: "40", "data-prop": "id", spellcheck: "false" });
    input.value = n.id;
    input.addEventListener("input", () => input.classList.toggle("is-invalid", !(ID_RE.test(input.value.trim()) && (input.value.trim() === n.id || !allIds().has(input.value.trim())))));
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (v === n.id || !ID_RE.test(v) || allIds().has(v)) { input.value = n.id; input.classList.remove("is-invalid"); return; }
      const old = n.id;
      commit(() => { live(old).id = v; }, { props: true });
      select(v);
    });
    return field("ID", input, "a–z, 0–9, “-”; unique in this layout");
  }

  function helpButton() {
    return h("button", { type: "button", class: "btn btn--sm mb-field--wide lb-help-btn", "data-read": "1", onclick: (e) => openHelp(e.currentTarget.closest("fieldset")?.querySelector("textarea, input") || null) }, icon("circle-question-mark"), " Variables, filters & macros");
  }
  function propField(n, p) {
    const id = n.id;
    const value = (n.props || {})[p.key];
    const set = (v) => { const g = live(id); putIn(g, "props", p.key, v); };
    if (p.kind === "icon") {
      const box = kit.suggestField(p.label, value, set, { items: () => Object.keys(catalog.icons), prop: `prop-${p.key}`, hint: p.hint });
      const pick = h("button", { type: "button", class: "btn btn--sm mb-iconbtn", "data-read": "1", title: "Pick an icon", "aria-label": "Pick an icon" }, value && catalog.icons[value] ? icon(value) : icon("star"), "Pick");
      pick.addEventListener("click", () => Kit.openIconPicker({ icons: catalog.icons, current: value, onPick: (name) => edit(() => set(name), { props: true }) }));
      if (readOnly) pick.disabled = true;
      box.append(pick);
      return box;
    }
    if (p.kind === "bool") return selectField(p.label, value === "=true" ? "yes" : value === "=false" ? "no" : "", [["yes", "yes"], ["no", "no"]], (v) => set(v === undefined ? undefined : v === "yes" ? "=true" : "=false"), { prop: `prop-${p.key}` });
    if (p.kind === "select") return selectField(p.label, value, p.options.filter(Boolean).map((o) => [o, o]), set, { prop: `prop-${p.key}`, hint: p.hint });
    return suggestField(p.label, value, set, { items: textItems(id), token: TEXT_TOKEN, prop: `prop-${p.key}`, hint: p.hint });
  }

  function attrsEditor(n) {
    const id = n.id;
    const tag = n.tag || (n.el === "icon" || n.el === "logo" ? "svg" : "span");
    const attrs = n.attrs || {};
    const rows = h("div", { class: "lb-kv" });
    // The class: its own field, completing each class name.
    rows.append(h("div", { class: "lb-kv__row lb-kv__row--class" },
      h("span", { class: "lb-kv__key mono" }, "class"),
      Kit.suggestInput({
        value: attrs.class || "", items: () => catalog.classes, token: /[^\s]*$/, mono: true, prop: "attr-class", max: 2000, placeholder: "classes — type to find the app's classes",
        onInput: (v) => edit(() => putIn(live(id), "attrs", "class", v.replace(/\s{2,}/g, " ").trimStart())),
      })));
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") continue;
      rows.append(kvRow(k, v, {
        keyItems: () => [...catalog.attrs.global, ...(catalog.attrs.byTag[tag] || []), ...catalog.attrs.aria, "data-testid"],
        valueItems: attrValueItems(id, tag, k),
        rename: (nk) => edit(() => { const g = live(id); const next = {}; for (const [kk, vv] of Object.entries(g.attrs || {})) next[kk === k ? nk : kk] = vv; g.attrs = next; }),
        set: (nv) => edit(() => { const g = live(id); g.attrs = { ...(g.attrs || {}), [k]: nv }; }),
        remove: () => edit(() => putIn(live(id), "attrs", k, undefined), { props: true }),
        prop: `attr-${k}`,
      }));
    }
    const addKey = Kit.suggestInput({
      value: "", items: () => [...catalog.attrs.global, ...(catalog.attrs.byTag[tag] || []), ...catalog.attrs.aria, "data-testid"].filter((a) => a !== "class" && !(a in attrs)),
      mono: true, prop: "attr-new", placeholder: "add an attribute…",
      onPick: (name) => edit(() => { const g = live(id); g.attrs = { ...(g.attrs || {}), [name]: catalog.attrs.boolean.includes(name) ? "=true" : "" }; }, { props: true }),
    });
    addKey.input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const name = addKey.input.value.trim().toLowerCase();
      if (/^(aria|data)-[a-z0-9-]+$|^[a-z]+$/.test(name)) { e.preventDefault(); edit(() => { const g = live(id); g.attrs = { ...(g.attrs || {}), [name]: "" }; }, { props: true }); }
    });
    rows.append(h("div", { class: "lb-kv__row lb-kv__row--add" }, addKey));
    return h("fieldset", { class: "mb-fs" }, h("legend", {}, "Attributes"), rows,
      h("p", { class: "muted small" }, "A value is text with {$variables}, or an expression after “=” (=$openPeerCount == 0, =$x ? 'on' : null — null leaves the attribute out). Links: https:// or this site's paths."));
  }
  function cssEditor(n) {
    const id = n.id;
    const css = n.css || {};
    const rows = h("div", { class: "lb-kv" });
    for (const [k, v] of Object.entries(css)) {
      rows.append(kvRow(k, v, {
        keyItems: () => Object.keys(catalog.css),
        valueItems: () => [...(catalog.css[k] || []).map((x) => ({ value: x })), ...scopeVars(id).map((x) => ({ value: `{${x.value}}`, hint: x.hint }))],
        rename: (nk) => edit(() => { const g = live(id); const next = {}; for (const [kk, vv] of Object.entries(g.css || {})) next[kk === k ? nk : kk] = vv; g.css = next; }),
        set: (nv) => edit(() => { const g = live(id); g.css = { ...(g.css || {}), [k]: nv }; }),
        remove: () => edit(() => putIn(live(id), "css", k, undefined), { props: true }),
        prop: `css-${k}`,
      }));
    }
    const addKey = Kit.suggestInput({
      value: "", items: () => Object.keys(catalog.css).filter((p) => !(p in css)), mono: true, prop: "css-new", placeholder: "add a CSS property…",
      onPick: (name) => edit(() => { const g = live(id); g.css = { ...(g.css || {}), [name]: (catalog.css[name] || [""])[0] }; }, { props: true }),
    });
    rows.append(h("div", { class: "lb-kv__row lb-kv__row--add" }, addKey));
    return h("details", { class: "mb-style", open: Object.keys(css).length ? true : undefined },
      h("summary", {}, "CSS", Object.keys(css).length ? h("span", { class: "badge badge--accent" }, `${Object.keys(css).length} set`) : h("span", { class: "muted small" }, "properties and values, suggested while typing")),
      rows,
      h("p", { class: "muted small" }, "Values may use {$variables}. No url(), expressions or imports. For hover / click states use “Style and states” below."));
  }
  function kvRow(key, value, o) {
    const keyInput = Kit.suggestInput({ value: key, items: o.keyItems, mono: true, prop: `${o.prop}-key`, onPick: (nk) => { if (nk && nk !== key) o.rename(nk); } });
    keyInput.input.addEventListener("change", () => { const nk = keyInput.input.value.trim().toLowerCase(); if (nk && nk !== key) o.rename(nk); });
    const valueInput = Kit.suggestInput({ value, items: o.valueItems, mono: true, prop: o.prop, max: 2000, onInput: (v) => o.set(v) });
    const del = h("button", { type: "button", class: "mbt-btn", title: "Remove", "aria-label": `Remove ${key}`, onclick: () => o.remove() }, icon("x"));
    return h("div", { class: "lb-kv__row" }, keyInput, valueInput, del);
  }

  function logicEditor(n, f) {
    const id = n.id;
    const info = layoutInfo(current);
    const set = (k) => (v) => { const g = live(id); if (v && v.trim()) g[k] = v; else delete g[k]; };
    const events = Object.entries(n.on || {});
    const evRows = h("div", { class: "lb-kv" });
    for (const [ev, b] of events) {
      const actionInput = Kit.suggestInput({
        value: b.action, mono: true, prop: `on-${ev}`, items: () => (info ? info.contract.actions.map((a) => ({ value: a.name, hint: a.description })) : []),
        onInput: (v) => edit(() => { const g = live(id); g.on = { ...(g.on || {}), [ev]: { ...g.on[ev], action: v.trim() } }; }),
      });
      const argInput = Kit.suggestInput({
        value: b.arg || "", mono: true, prop: `on-${ev}-arg`, placeholder: "argument", items: exprItems(id), token: EXPR_TOKEN,
        onInput: (v) => edit(() => { const g = live(id); const nb = { ...g.on[ev] }; if (v.trim()) nb.arg = v; else delete nb.arg; g.on = { ...g.on, [ev]: nb }; }),
      });
      evRows.append(h("div", { class: "lb-kv__row lb-kv__row--3" }, h("span", { class: "lb-kv__key mono" }, ev), actionInput, argInput,
        h("button", { type: "button", class: "mbt-btn", title: "Remove", "aria-label": `Remove ${ev}`, onclick: () => edit(() => { const g = live(id); const on = { ...(g.on || {}) }; delete on[ev]; if (Object.keys(on).length) g.on = on; else delete g.on; }, { props: true }) }, icon("x"))));
    }
    if (n.tag || n.el === "html") {
      const addEv = Kit.suggestInput({
        value: "", mono: true, prop: "on-new", placeholder: "add an event (click, change, submit…)", items: () => catalog.events.filter((e) => !(n.on || {})[e]),
        onPick: (ev) => edit(() => { const g = live(id); g.on = { ...(g.on || {}), [ev]: { action: (info?.contract.actions[0] || { name: "" }).name } }; }, { props: true }),
      });
      evRows.append(h("div", { class: "lb-kv__row lb-kv__row--add" }, addEv));
    }
    return h("details", { class: "mb-style", open: n.if || n.each || n.on || n.ref || n.styleBind ? true : undefined },
      h("summary", {}, "Logic: when, repeat, events", n.if || n.each || n.on ? h("span", { class: "badge badge--accent" }, "set") : h("span", { class: "muted small" }, "conditions, lists, actions")),
      grid(
        suggestField("Show only when", n.if, set("if"), { items: exprItems(id), token: EXPR_TOKEN, prop: "if", placeholder: "e.g. $connected && !$empty", wide: true }),
        suggestField("Repeat for each item of", n.each, set("each"), { items: exprItems(id), token: EXPR_TOKEN, prop: "each", placeholder: "e.g. $peers", rerender: false }),
        textField("…as", n.as ? `$${n.as}` : "", (v) => { const g = live(id); const nv = v.replace(/^\$/, "").trim(); if (nv) g.as = nv; else delete g.as; }, { mono: true, max: 32, prop: "as", placeholder: "$item" }),
        suggestField("Key of an item", n.key, set("key"), { items: exprItems(id), token: EXPR_TOKEN, prop: "key", placeholder: "e.g. $p.id" }),
        n.tag || n.el === "icon" ? suggestField("CSS from data", n.styleBind, set("styleBind"), { items: () => scopeVars(id).filter((v) => /object/.test(v.hint)), token: EXPR_TOKEN, prop: "styleBind", hint: "an object of CSS the app computes (a bubble's colours, the widget's position)" }) : null,
        n.tag ? suggestField("Ref", n.ref, set("ref"), { items: () => (info ? info.contract.refs.map((r) => ({ value: r.name, hint: r.description })) : []), prop: "ref", hint: "a handle the app uses (scrolling, measuring)" }) : null),
      h("fieldset", { class: "mb-fs" }, h("legend", {}, "Events → actions"), evRows,
        h("p", { class: "muted small" }, info ? `This layout's actions: ${info.contract.actions.map((a) => a.name).join(", ")}.` : "")));
  }

  function unlinkBlock(id) {
    const f = find(id);
    const b = f && config.blocks[f.node.block];
    if (!b) return;
    let first = null;
    commit(() => {
      const t = editTree();
      const g = find(id, t);
      const copy = freshIds(clone(b.tree), allIds(t));
      g.parent ? g.parent.children.splice(g.index, 1, copy) : null;
      first = copy.id;
    });
    select(first);
  }
  function deleteBlock(name) {
    let uses = 0;
    for (const l of catalog.layouts) walk(config.layouts[l.id]?.tree || l.tree, (n) => { if (n.el === "block" && n.block === name) uses++; });
    if (!confirm(uses ? `The template "${name}" is used ${uses}× — those places will draw nothing. Delete it?` : `Delete the template "${name}"?`)) return;
    commit(() => { delete config.blocks[name]; });
    switchTo("chat");
  }

  /* ====================================================== texts & flags */

  const COMPONENTS = [["chat", "Main chat window"], ["in", "Incoming message"], ["sys", "System message"], ["out", "Outgoing message"], ["widget", "Recipients widget"], ["menu", "Menu"], ["composer", "Composer"]];
  const TEMPLATES = [
    ["systemHeader", "System message header", ["appName", "date", "time", "room"]],
    ["incomingMeta", "Incoming meta line", ["sender", "time", "date", "room"]],
    ["outgoingMeta", "Outgoing meta line", ["sender", "time", "date", "room"]],
    ["composerPlaceholder", "Composer placeholder", ["placeholder", "room", "peerCount"]],
    ["widgetTitle", "Recipients widget title", ["title", "peerCount", "room"]],
    ["chatEmptyTitle", "Empty chat title", ["title", "appName"]],
    ["chatEmptyBody", "Empty chat text", ["body", "appName"]],
  ];
  function settingsForm() {
    const out = [head("sliders-horizontal", "Texts & behaviour", "The short texts the layouts use ($headerText, $timeLabel, $placeholder, $title, $emptyTitle…), what messages show, and quick colours per component (CSS variables).")];
    out.push(group("Texts (placeholders in {{double braces}}, includes {{> name}})",
      ...TEMPLATES.map(([key, label, vars]) => textField(label, config.templates[key], (v) => { config.templates[key] = v; }, { max: 400, prop: `tpl-${key}`, hint: vars.map((v) => `{{${v}}}`).join(" ") }))));
    const partials = h("div", { class: "lb-kv" });
    for (const [name, body] of Object.entries(config.partials || {})) {
      partials.append(h("div", { class: "lb-kv__row" }, h("span", { class: "lb-kv__key mono" }, `{{> ${name}}}`),
        Kit.suggestInput({ value: body, mono: true, prop: `partial-${name}`, items: () => [], max: 400, onInput: (v) => edit(() => { config.partials[name] = v; }) }),
        h("button", { type: "button", class: "mbt-btn", "aria-label": `Remove ${name}`, onclick: () => edit(() => { delete config.partials[name]; }, { props: true }) }, icon("x"))));
    }
    const pname = h("input", { class: "input mono", placeholder: "name", maxlength: "32", "data-prop": "partial-new" });
    partials.append(h("div", { class: "lb-kv__row lb-kv__row--add" }, pname, h("button", {
      type: "button", class: "btn btn--sm", onclick: () => {
        const n = pname.value.trim();
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(n)) { toast("A name: letters, digits, _ or -.", "err"); return; }
        edit(() => { config.partials[n] = config.partials[n] || "{{sender}}"; }, { props: true });
      },
    }, "Add include")));
    out.push(h("fieldset", { class: "mb-fs" }, h("legend", {}, "Includes"), partials));
    const fl = config.flags;
    out.push(group("Messages",
      checkField("Avatars", fl.showAvatars, (v) => { fl.showAvatars = v; }, { prop: "flag-avatars" }),
      checkField("Time", fl.showTime, (v) => { fl.showTime = v; }, { prop: "flag-time" }),
      checkField("Lock icon (verified)", fl.showLockIcon, (v) => { fl.showLockIcon = v; }, { prop: "flag-lock" }),
      checkField("Reply / forward", fl.showActions, (v) => { fl.showActions = v; }, { prop: "flag-actions" }),
      checkField("Logo in system messages", fl.showSystemLogo, (v) => { fl.showSystemLogo = v; }, { prop: "flag-syslogo" }),
      checkField("Full date in system messages", fl.systemFullDate, (v) => { fl.systemFullDate = v; }, { prop: "flag-sysdate" }),
      numberField("Fold system messages after (s, 0 = never)", fl.systemCollapseAfterSec, 0, 3600, 5, (v) => { fl.systemCollapseAfterSec = v ?? 0; }, { prop: "flag-collapse" }),
      numberField("…unfolded for (s)", fl.systemExpandForSec, 3, 600, 1, (v) => { fl.systemExpandForSec = v ?? 20; }, { prop: "flag-expand" })));
    const comp = h("div", {});
    for (const [cid, label] of COMPONENTS) {
      const st = config.styles[cid] || {};
      const put = (k, v) => { const s = { ...(config.styles[cid] || {}) }; if (v === undefined || v === "") delete s[k]; else s[k] = v; if (Object.keys(s).length) config.styles[cid] = s; else delete config.styles[cid]; };
      const hex = (k, l) => {
        const pick = h("input", { type: "color", class: "mb-color", "data-prop": `cs-${cid}-${k}` });
        pick.value = /^#[0-9a-f]{6}$/i.test(st[k] || "") ? st[k] : "#3366ff";
        const on = h("input", { type: "checkbox", checked: st[k] ? true : undefined, title: "Use", "aria-label": `${l}: use` });
        const apply = () => edit(() => put(k, on.checked ? pick.value : undefined));
        pick.addEventListener("input", () => { on.checked = true; apply(); });
        on.addEventListener("change", apply);
        return field(l, h("span", { class: "mb-colorctl" }, on, pick));
      };
      comp.append(h("details", { class: "mb-style" }, h("summary", {}, label, Object.keys(st).length ? h("span", { class: "badge badge--accent" }, `${Object.keys(st).length} set`) : null),
        grid(
          hex("bg", "Background"), hex("fg", "Text"), hex("border", "Border"),
          selectField("Border style", st.bstyle, ["solid", "dashed", "dotted", "double", "none"].map((v) => [v, v]), (v) => put("bstyle", v)),
          numberField("Border (px)", st.bwidth, 0, 8, 1, (v) => put("bwidth", v)),
          numberField("Radius (px)", st.radius, 0, 48, 1, (v) => put("radius", v)),
          numberField("Font (px)", st.fs, 10, 28, 1, (v) => put("fs", v)),
          numberField("Opacity", st.opacity, 0.2, 1, 0.05, (v) => put("opacity", v)),
          numberField("Padding (px)", st.pad, 0, 40, 1, (v) => put("pad", v)),
          selectField("Shadow", st.shadow === undefined ? "" : st.shadow ? "on" : "off", [["on", "on"], ["off", "off"]], (v) => put("shadow", v === undefined ? undefined : v === "on")))));
    }
    out.push(h("fieldset", { class: "mb-fs" }, h("legend", {}, "Quick colours per component (CSS variables --c-<component>-…)"), comp));
    return out;
  }

  /* ============================================================== help */

  function openHelp(target) {
    const info = layoutInfo(current);
    Kit.openHelp({
      id: "layout", domId: "lbHelp", title: "Layout builder", subtitle: "click to insert", target, icons: catalog.icons,
      tabs: [
        { id: "vars", label: "Values", rows: () => (info ? info.contract.vars : []).map((v) => ({ code: `{${v.path}}`, text: v.description, type: v.type, insert: target && target.dataset.prop && /^(if|each|key|arg|styleBind)$|^on-/.test(target.dataset.prop) ? v.path : `{${v.path}}` })) },
        { id: "actions", label: "Actions", rows: () => (info ? info.contract.actions : []).map((a) => ({ code: a.name, text: `${a.description}${a.arg ? ` — argument: ${a.arg}` : ""}`, type: a.event || "click" })) },
        { id: "parts", label: "Parts & refs", rows: () => (info ? [...info.contract.slots.map((s) => ({ code: s.name, text: s.description, type: "part" })), ...info.contract.refs.map((r) => ({ code: r.name, text: r.description, type: "ref" }))] : []) },
        { id: "filters", label: "Filters", rows: () => catalog.template.filters.map((f) => ({ code: f.example, text: `${f.name}${f.args ? `:${f.args}` : ""} — ${f.description}` })) },
        { id: "macros", label: "Macros", rows: () => catalog.template.macros.map((m) => ({ code: m.syntax, text: m.description })) },
        {
          id: "expr", label: "Expressions", rows: () => [
            { code: "=$openPeerCount == 0", text: "An attribute that is an expression: its value keeps its type (true, false, a number)." },
            { code: "=$private ? '1' : null", text: "Condition ? then : otherwise — null leaves the attribute out." },
            { code: "$connected && !$empty", text: "“Show only when”: && (and), || (or), ! (not), == != < > <= >=." },
            { code: "$peers", text: "“Repeat for each”: a list; the item is $item (or what “…as” names), $iterator.counter counts." },
            { code: "{$p.name|upper}", text: "Values of the item in a repeat; filters after |." },
            { code: "{$state|t:'msginfo.state.'}", text: "A translated text whose key is built from a value." },
          ],
        },
        { id: "elements", label: "Elements", rows: () => catalog.elements.map((d) => ({ code: d.label, text: d.hint, type: d.group })) },
      ],
    });
  }

  /* ============================================================ preview */

  let previewTimer = 0;
  function variantsOf(id) {
    return (catalog && catalog.variants && catalog.variants[id]) || [{ id: "", label: "—" }];
  }
  function previewLayoutId() {
    if (!isBlock() && current !== "settings") return current;
    return view.lastLayout || "chat";
  }
  function sendPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const frame = $("#lbFrame");
      if (!frame || !previewReady || !frame.contentWindow) return;
      const layout = previewLayoutId();
      frame.contentWindow.postMessage({
        type: "m5-lb:render", config, layout, variant: view.variant, theme: view.theme, tone: view.tone, lang: view.lang,
        selected: isBlock() ? "" : selection || "", mode: view.mode,
      }, location.origin);
    }, 60);
  }
  function renderPreviewBar() {
    const sel = $("#lbVariant");
    if (!sel) return;
    clear(sel);
    const id = previewLayoutId();
    for (const v of variantsOf(id)) sel.append(h("option", { value: v.id, selected: v.id === view.variant || undefined }, v.label));
    const themeSel = $("#lbTheme");
    if (themeSel && !themeSel.options.length) for (const t of catalog.themes || []) themeSel.append(h("option", { value: t, selected: t === view.theme || undefined }, t));
  }
  function renderErrors() {
    const box = $("#lbErrors");
    if (!box) return;
    clear(box);
    for (const e of previewErrors.slice(0, 20)) {
      box.append(h("li", {}, h("button", { type: "button", class: "lb-err", "data-read": "1", onclick: () => { if (find(e.id)) select(e.id); } }, h("code", {}, e.id), " ", e.message)));
    }
    box.hidden = !previewErrors.length;
  }

  /* ============================================================= chrome */

  function renderChrome() {
    const badge = $("#lbDirty");
    if (badge) badge.hidden = !dirty();
    const u = $("#lbUndo");
    const r = $("#lbRedo");
    if (u) u.disabled = readOnly || !undoStack.length;
    if (r) r.disabled = readOnly || !redoStack.length;
    const paste = $("#lbPaste");
    if (paste) paste.disabled = readOnly || !clipboard;
    const reset = $("#lbReset");
    if (reset) reset.textContent = current === "settings" ? "Reset texts & behaviour" : isBlock() ? "Delete this template" : "Reset this layout";
    const info = $("#lbFile");
    if (info) {
      const own = Object.keys(normalized(config).layouts).length;
      info.textContent = `${own} of ${catalog.layouts.length} layouts yours · ${Object.keys(config.blocks).length} templates · ${file || "layout.json"}${config.updatedAt ? ` · saved ${new Date(config.updatedAt).toLocaleString()}` : ""}${readOnly ? " · read only (auditor)" : ""}`;
    }
    renderTabs();
  }
  function renderAll() {
    const section = $("[data-panel=layout]");
    if (section) {
      section.classList.toggle("mb--readonly", readOnly);
      section.classList.toggle("lb--settings", current === "settings");
    }
    if (!isBlock() && current !== "settings") view.lastLayout = current;
    renderPalette();
    renderTree();
    renderProps();
    renderPreviewBar();
    renderChrome();
    renderErrors();
  }

  async function save() {
    if (readOnly) return;
    try {
      const body = normalized(config);
      const r = await api("/admin/layout", { method: "PUT", body: { layout: body } });
      config = clone(r.layout);
      config.layouts = config.layouts || {};
      config.blocks = config.blocks || {};
      savedJson = comparable(config);
      if (selection && !find(selection)) selection = null;
      renderAll();
      sendPreview();
      toast("Layouts saved. Apps pick them up within five minutes (or on reload).", "ok");
    } catch (e) { toast(`Layouts: ${e.message}`, "err"); }
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify(normalized(config), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: "m5cet-layouts.json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importJson(fileObj) {
    try {
      const raw = JSON.parse(await fileObj.text());
      const next = raw.layout || raw;
      if (!next || typeof next !== "object") throw new Error("not a layout file");
      commit(() => {
        config = { ...config, ...next, layouts: next.layouts || {}, blocks: next.blocks || {} };
      });
      selection = null;
      renderAll();
      toast("Imported — check the preview, then Save (the server checks everything again).", "ok");
    } catch (e) { toast(`Import: ${e.message}`, "err"); }
  }

  function wire() {
    if (wired) return;
    wired = true;
    const tree = $("#lbTree");
    tree.addEventListener("click", (e) => {
      const row = e.target.closest(".mbt-row");
      if (!row || e.target.closest(".mbt-btn")) return;
      select(row.dataset.id);
    });
    tree.addEventListener("keydown", (e) => {
      const row = e.target.closest(".mbt-row");
      if (!row) return;
      const rows = $$(".mbt-row", tree);
      const i = rows.indexOf(row);
      const id = row.dataset.id;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(id); }
      else if (!readOnly && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        step(id, e.key === "ArrowUp" ? -1 : 1);
        $(`#lbTree .mbt-row[data-id="${CSS.escape(id)}"]`)?.focus();
      } else if (e.key === "ArrowDown" && rows[i + 1]) { e.preventDefault(); rows[i + 1].focus(); }
      else if (e.key === "ArrowUp" && rows[i - 1]) { e.preventDefault(); rows[i - 1].focus(); }
      else if (!readOnly && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); remove(id); }
    });
    tree.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".mbt-row[data-id]");
      if (!row || readOnly || !row.getAttribute("draggable")) return;
      drag = { id: row.dataset.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", drag.id);
      // Not now: Chrome cancels a drag whose source moves during dragstart.
      setTimeout(() => { if (drag) { tree.classList.add("is-dragging"); row.classList.add("is-drag-source"); } }, 0);
    });
    tree.addEventListener("dragend", () => {
      drag = null;
      tree.classList.remove("is-dragging");
      for (const el of $$(".is-drag-source", tree)) el.classList.remove("is-drag-source");
      clearMarks();
    });
    tree.addEventListener("dragover", (e) => {
      if (!drag) return;
      const target = dropTarget(e);
      clearMarks();
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = drag.id ? "move" : "copy";
      target.el.classList.add(`drop-${target.where}`);
    });
    tree.addEventListener("dragleave", (e) => { if (!tree.contains(e.relatedTarget)) clearMarks(); });
    tree.addEventListener("drop", (e) => {
      if (!drag) return;
      const target = dropTarget(e);
      clearMarks();
      if (!target) return;
      e.preventDefault();
      // The tree is redrawn: dragend then fires on a detached row, so end the drag here.
      const was = drag;
      tree.classList.remove("is-dragging");
      place(target);
      if (drag === was) drag = null;
    });

    $("#lbSave").addEventListener("click", () => void save());
    $("#lbUndo").addEventListener("click", undo);
    $("#lbRedo").addEventListener("click", redo);
    $("#lbHelpBtn").addEventListener("click", () => openHelp(null));
    $("#lbCopy").addEventListener("click", () => {
      const f = selection && find(selection);
      if (!f) { toast("Select an element first.", "err"); return; }
      clipboard = clone(f.node);
      renderChrome();
      toast("Copied — select where it goes (in any layout) and press Paste.", "ok");
    });
    $("#lbPaste").addEventListener("click", () => { if (clipboard) add({ copyOf: clipboard }); });
    $("#lbExport").addEventListener("click", exportJson);
    $("#lbImport").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) void importJson(f); });
    $("#lbRevert").addEventListener("click", () => { if (!dirty() || confirm("Discard the unsaved changes?")) load().catch((e) => toast(e.message, "err")); });
    $("#lbReset").addEventListener("click", () => {
      if (current === "settings") {
        if (!confirm("Texts, behaviour and quick colours back to the app's own?")) return;
        commit(() => { config.templates = clone(catalog.defaults?.templates || config.templates); config.partials = {}; config.flags = clone(catalog.defaults?.flags || config.flags); config.styles = {}; }, { props: true });
        return;
      }
      if (isBlock()) { deleteBlock(blockName()); return; }
      if (!confirm("Start this layout again from the app's own? (Nothing is saved until you press Save.)")) return;
      commit(() => { delete config.layouts[current]; });
      selection = null;
      renderAll();
    });
    const bindView = (sel, key) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener("change", () => { view[key] = el.type === "checkbox" ? el.checked : el.value; sendPreview(); if (key === "device") applyDevice(); });
    };
    bindView("#lbVariant", "variant");
    bindView("#lbTheme", "theme");
    bindView("#lbTone", "tone");
    bindView("#lbLang", "lang");
    bindView("#lbDevice", "device");
    bindView("#lbMode", "mode");
    window.addEventListener("message", (event) => {
      const frame = $("#lbFrame");
      if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
      const d = event.data || {};
      if (d.type === "m5-lb:ready") { previewReady = true; sendPreview(); }
      else if (d.type === "m5-lb:select" && typeof d.id === "string" && !isBlock() && current !== "settings") { if (find(d.id)) select(d.id); }
      else if (d.type === "m5-lb:errors" && Array.isArray(d.errors)) {
        const next = d.errors.filter((e) => e && typeof e.id === "string" && typeof e.message === "string").slice(0, 50);
        if (JSON.stringify(next) !== JSON.stringify(previewErrors)) { previewErrors = next; renderErrors(); renderTree(); }
      }
    });
    // The preview may have loaded before this listener: ask it.
    const frame = $("#lbFrame");
    const hello = () => { try { frame.contentWindow.postMessage({ type: "m5-lb:hello" }, location.origin); } catch { /* not loaded */ } };
    frame.addEventListener("load", hello);
    hello();
    document.addEventListener("keydown", (e) => {
      const section = $("[data-panel=layout]");
      if (!section || section.hidden || readOnly || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    });
    window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
    applyDevice();
  }
  function applyDevice() {
    const box = $("#lbFrameBox");
    if (box) box.dataset.device = view.device;
  }

  C.addRoute("layout", ["Layout builder", "A GUI designer for the app's layouts: the app bar, the chat window, messages, the composer, the recipients widget", load]);
})();
