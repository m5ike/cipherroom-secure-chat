// M5cet operator console — Menu builder (4.0).
//
// The app's menu as data (client/src/lib/menu-config.ts): the ☰ button, the
// panel window and what it lists — sections, items, HTML blocks with live
// {$variables}, separators, rows and special buttons (Appearance, Edit Mode,
// light / dark, …). Every element has a style (alignment, wrapping, colours,
// icon, font, decoration, spacing, border) and the same for its states
// (hover, click, keyboard focus, current), and can be shown only for a module
// or a situation. Drag to reorder (or Alt+↑/↓), pick an element to edit it,
// see it on the right. The default configuration is the menu as it always
// was — the app draws it identically.
//
//   GET  /api/admin/menu-config          config, defaults, catalog
//   PUT  /api/admin/menu-config          save (validated by the server)
//   POST /api/admin/menu-config/render   the preview's labels and HTML blocks,
//                                        rendered with sample values
//
// Same rules as console.js: DOM nodes and textContent only, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, $, $$, api, toast } = C;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const KINDS = {
    section: { label: "Section", hint: "a heading and its items", icon: "layers" },
    item: { label: "Item", hint: "icon, text and an action", icon: "square-terminal" },
    html: { label: "HTML", hint: "HTML with live {$variables}", icon: "code" },
    separator: { label: "Separator", hint: "a line or a space", icon: "minus" },
    row: { label: "Row", hint: "buttons side by side", icon: "layout-grid" },
    special: { label: "Special", hint: "Appearance, Edit Mode, light / dark…", icon: "sparkles" },
  };
  /** What each container takes (the server enforces the same). */
  const CHILDREN = {
    items: ["section", "item", "html", "separator", "row", "special"],
    footer: ["item", "html", "separator", "special"],
    section: ["item", "html", "separator", "row", "special"],
    row: ["item", "special", "html", "separator"],
  };
  const STATE_LABELS = { hover: "Hover", active: "Click", focus: "Keyboard focus", current: "Current / on" };
  const SHADOW_CSS = {
    none: "none",
    sm: "0 1px 2px rgb(0 0 0 / 0.12)",
    md: "0 4px 12px rgb(0 0 0 / 0.16)",
    lg: "0 12px 32px rgb(0 0 0 / 0.22)",
    glow: "0 0 0 3px hsl(var(--primary) / 0.28)",
  };
  const STATE_PROPS = [
    ["color", "color", (v) => cssColor(v)],
    ["background", "bg", (v) => cssColor(v)],
    ["iconColor", "icon", (v) => cssColor(v)],
    ["borderColor", "border", (v) => cssColor(v)],
    ["fontWeight", "weight", (v) => v],
    ["underline", "underline", (v) => (v ? "underline" : "none")],
    ["opacity", "opacity", (v) => String(v)],
    ["scale", "scale", (v) => String(v)],
    ["shadow", "shadow", (v) => SHADOW_CSS[v] || "none"],
  ];
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const SAFE_TAGS = new Set([
    "div", "span", "p", "b", "strong", "i", "em", "u", "s", "small", "br", "hr", "code", "kbd", "mark", "sup", "sub",
    "ul", "ol", "li", "a", "img", "h4", "h5", "h6", "time", "abbr", "button", "section", "header", "footer", "figure", "figcaption",
  ]);

  let draft = null;
  let savedJson = "";
  let defaults = null;
  let catalog = null;
  let file = "";
  let readOnly = true;
  /** "trigger", "panel" or a node id. */
  let selection = "trigger";
  let preview = { labels: {}, html: {}, strings: {}, title: "", trigger: { text: "", title: "" }, vars: {} };
  const view = { mode: "panel", lang: "cs", tone: "light", state: "", signedIn: true, connected: true, phone: false };
  let undoStack = [];
  let redoStack = [];
  let lastSnap = 0;
  let wired = false;
  let dragId = null;
  let helpTarget = null;

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const comparable = (config) => JSON.stringify({ ...config, updatedAt: 0 });
  const dirty = () => Boolean(draft) && comparable(draft) !== savedJson;

  /* ============================================================== loading */

  async function load() {
    const r = await api("/api/admin/menu-config");
    catalog = r.catalog;
    defaults = r.defaults;
    file = r.file || "";
    draft = clone(r.config);
    savedJson = comparable(r.config);
    undoStack = [];
    redoStack = [];
    readOnly = !C.can("operator");
    if (selection !== "trigger" && selection !== "panel" && !find(selection)) selection = "trigger";
    wire();
    renderAll();
    requestPreview(true);
  }

  /* ================================================================ model */

  function walk(nodes, visit, parent = null) {
    for (const n of nodes) {
      visit(n, parent);
      if (n.children) walk(n.children, visit, n);
    }
  }
  function allIds() {
    const ids = new Set();
    walk(draft.items, (n) => ids.add(n.id));
    walk(draft.footer, (n) => ids.add(n.id));
    return ids;
  }
  function uniqueId(base) {
    const ids = allIds();
    const stem = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "node";
    if (!ids.has(stem)) return stem;
    for (let i = 2; ; i++) if (!ids.has(`${stem}-${i}`)) return `${stem}-${i}`;
  }
  /** A node with where it lives: its list, index, parent and area. */
  function find(id) {
    const search = (list, area, parent) => {
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        if (node.id === id) return { node, list, index: i, parent, area };
        if (node.children) {
          const found = search(node.children, area, node);
          if (found) return found;
        }
      }
      return null;
    };
    return search(draft.items, "items", null) || search(draft.footer, "footer", null);
  }
  function containerList(key) {
    if (key === "items") return draft.items;
    if (key === "footer") return draft.footer;
    const f = find(key);
    return f && f.node.children ? f.node.children : null;
  }
  function containerKind(key) {
    if (key === "items" || key === "footer") return key;
    const f = find(key);
    return f ? f.node.kind : null;
  }
  /** Whether a node may go into a container (never into itself). */
  function canPlace(id, containerKey) {
    const f = find(id);
    const kind = containerKind(containerKey);
    if (!f || !kind || !CHILDREN[kind] || !CHILDREN[kind].includes(f.node.kind)) return false;
    if (containerKey === id) return false;
    let inside = false;
    if (f.node.children) walk(f.node.children, (n) => { if (n.id === containerKey) inside = true; });
    return !inside;
  }

  function newNode(kind) {
    const id = uniqueId(kind === "item" ? "btn" : kind);
    switch (kind) {
      case "section": return { kind, id, label: "New section", children: [] };
      case "item": return { kind, id, icon: "star", label: "New item", action: { type: "panel", panel: "settings" } };
      case "html": return { kind, id, html: "<div style=\"padding:6px 12px\">{$user.nickname} · {$session.room|default:'—'}</div>" };
      case "separator": return { kind, id, variant: "line" };
      case "row": return { kind, id, children: [] };
      default: return { kind: "special", id, special: "toneToggle", showState: true };
    }
  }

  /* ============================================================ history */

  function snapshot() {
    undoStack.push(JSON.stringify(draft));
    if (undoStack.length > 120) undoStack.shift();
    redoStack = [];
  }
  /** Changes the draft; typing into one field is one undo step. */
  function commit(change, { coalesce = false, props = false } = {}) {
    const now = Date.now();
    if (!coalesce || now - lastSnap > 900) snapshot();
    lastSnap = coalesce ? now : 0;
    change();
    renderTree();
    if (props) renderProps();
    renderDirty();
    requestPreview();
  }
  const edit = (change, opts = {}) => commit(change, { coalesce: true, ...opts });
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(draft));
    draft = JSON.parse(undoStack.pop());
    afterJump();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(draft));
    draft = JSON.parse(redoStack.pop());
    afterJump();
  }
  function afterJump() {
    lastSnap = 0;
    if (selection !== "trigger" && selection !== "panel" && !find(selection)) selection = "trigger";
    renderAll();
    requestPreview();
  }

  /* ========================================================== operations */

  function addNode(kind) {
    const node = newNode(kind);
    commit(() => {
      const sel = find(selection);
      if (sel && sel.node.children && CHILDREN[sel.node.kind].includes(kind)) sel.node.children.push(node);
      else if (sel && CHILDREN[sel.parent ? sel.parent.kind : sel.area].includes(kind)) sel.list.splice(sel.index + 1, 0, node);
      else draft.items.push(node);
    });
    select(node.id);
  }
  function removeNode(id) {
    const f = find(id);
    if (!f) return;
    const inside = f.node.children ? f.node.children.length : 0;
    if (inside && !confirm(`Remove "${titleOf(f.node)}" and the ${inside} element(s) in it?`)) return;
    commit(() => { f.list.splice(f.index, 1); });
    select(f.list[f.index] ? f.list[f.index].id : f.list[f.index - 1] ? f.list[f.index - 1].id : f.parent ? f.parent.id : "panel");
  }
  function duplicateNode(id) {
    const f = find(id);
    if (!f) return;
    const copy = clone(f.node);
    commit(() => {
      const ids = allIds();
      const fresh = (n) => {
        let next = n.id.replace(/-copy(-\d+)?$/, "") + "-copy";
        for (let i = 2; ids.has(next); i++) next = `${n.id.replace(/-copy(-\d+)?$/, "")}-copy-${i}`;
        n.id = next.slice(0, 40);
        ids.add(n.id);
        if (n.children) n.children.forEach(fresh);
      };
      fresh(copy);
      f.list.splice(f.index + 1, 0, copy);
    });
    select(copy.id);
  }
  function moveNode(id, containerKey, index) {
    if (!canPlace(id, containerKey)) return false;
    commit(() => {
      const f = find(id);
      const target = containerList(containerKey);
      f.list.splice(f.index, 1);
      let at = index;
      if (f.list === target && f.index < index) at -= 1;
      target.splice(Math.max(0, Math.min(at, target.length)), 0, f.node);
    });
    return true;
  }
  /** Up / down within its list; at an end, out into the parent's list. */
  function step(id, dir) {
    const f = find(id);
    if (!f) return;
    const next = f.index + dir;
    if (next >= 0 && next < f.list.length) {
      moveNode(id, f.parent ? f.parent.id : f.area, dir > 0 ? next + 1 : next);
      return;
    }
    if (f.parent) {
      const p = find(f.parent.id);
      const key = p.parent ? p.parent.id : p.area;
      if (canPlace(id, key)) moveNode(id, key, dir > 0 ? p.index + 1 : p.index);
    }
  }
  function select(id) {
    selection = id;
    renderTree();
    renderProps();
    renderPreview();
  }

  /* ============================================================== icons */

  function iconSvg(name, cls = "mb-ico") {
    const node = (catalog && (catalog.icons[name] || catalog.icons["circle-alert"])) || [];
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", class: `lucide lucide-${name} ${cls}`, "aria-hidden": "true" };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, a] of node) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(a)) if (k !== "key") el.setAttribute(k, String(v));
      svg.append(el);
    }
    return svg;
  }
  const SPECIAL_ICONS = { user: "user", appearance: "palette", editMode: "pencil-ruler", toneToggle: "moon", notifications: "bell", account: "key-round", clearQuit: "log-out", build: "info" };
  function nodeIcon(n) {
    if (n.kind === "item") return n.icon;
    if (n.kind === "section" && n.icon) return n.icon;
    if (n.kind === "special") return n.icon || SPECIAL_ICONS[n.special] || "sparkles";
    return KINDS[n.kind].icon;
  }
  function specialLabel(id) {
    const s = (catalog.specials || []).find((x) => x.id === id);
    return s ? s.label : id;
  }
  /** What the tree shows for a node. */
  function titleOf(n) {
    const shown = preview.labels[n.id];
    switch (n.kind) {
      case "section":
      case "item": return shown || n.label || "(no text)";
      case "html": return n.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "(empty)";
      case "separator": return n.variant === "space" ? "space" : `${n.variant} line`;
      case "row": return n.children.length ? n.children.map((c) => (c.kind === "special" ? specialLabel(c.special) : titleOf(c))).join(" · ").slice(0, 60) : "(empty row)";
      case "special": return (n.label ? shown || n.label : "") || specialLabel(n.special);
      default: return n.id;
    }
  }

  /* =============================================================== tree */

  function renderTree() {
    const tree = $("#mbTree");
    if (!tree) return;
    const scroll = tree.scrollTop;
    clear(tree);
    tree.append(
      rootRow("trigger", draft.trigger.icon, "☰ Menu button", draft.trigger.showText && draft.trigger.text ? draft.trigger.text : "icon"),
      rootRow("panel", "layout-grid", "Panel window", `${draft.panel.width} px${draft.panel.showHeader ? "" : " · no header"}`),
      area("items", "Menu", draft.items),
      area("footer", "Footer", draft.footer),
    );
    tree.scrollTop = scroll;
  }
  function rootRow(id, icon, title, meta) {
    return h("div", { class: `mbt-row mbt-row--root${selection === id ? " is-selected" : ""}`, "data-root": id, tabindex: "0", role: "treeitem", "aria-selected": selection === id ? "true" : "false" },
      iconSvg(icon), h("span", { class: "mbt-title" }, title), h("span", { class: "mbt-meta" }, meta));
  }
  function area(key, title, nodes) {
    let count = 0;
    walk(nodes, () => { count++; });
    return h("div", { class: "mbt-area" },
      h("div", { class: "mbt-area__title" }, title, h("span", { class: "muted" }, ` · ${count}`)),
      list(key, nodes));
  }
  function list(containerKey, nodes) {
    const ul = h("ul", { class: "mbt-list", role: "group", "data-container": containerKey });
    nodes.forEach((n, i) => ul.append(nodeRow(n, containerKey, i)));
    ul.append(h("li", { class: `mbt-drop${nodes.length ? "" : " is-empty"}`, "data-container": containerKey, "data-index": String(nodes.length) }, nodes.length ? "" : "drop here"));
    return ul;
  }
  function nodeRow(n, containerKey, index) {
    const selected = selection === n.id;
    const actions = readOnly ? null : h("span", { class: "mbt-actions" },
      actionBtn(n.hidden ? "eye-off" : "eye", n.hidden ? "Show in the menu" : "Hide from the menu", () => commit(() => { if (n.hidden) delete n.hidden; else n.hidden = true; }, { props: selection === n.id })),
      actionBtn("arrow-right", "Move up (Alt+↑)", () => step(n.id, -1), "mbt-up"),
      actionBtn("arrow-right", "Move down (Alt+↓)", () => step(n.id, 1), "mbt-down"),
      actionBtn("layers", "Duplicate", () => duplicateNode(n.id)),
      actionBtn("trash", "Remove", () => removeNode(n.id), "mbt-del"));
    const row = h("div", {
      class: `mbt-row mbt-row--${n.kind}${selected ? " is-selected" : ""}${n.hidden ? " is-hidden" : ""}`,
      draggable: readOnly ? undefined : "true",
      "data-id": n.id, "data-container": containerKey, "data-index": String(index),
      tabindex: "0", role: "treeitem", "aria-selected": selected ? "true" : "false",
    },
      readOnly ? null : h("span", { class: "mbt-grip", "aria-hidden": "true", title: "Drag" }, "⠿"),
      iconSvg(nodeIcon(n)),
      h("span", { class: "mbt-title" }, titleOf(n)),
      h("span", { class: `mbt-kind mbt-kind--${n.kind}` }, n.kind === "special" ? n.special : KINDS[n.kind].label),
      n.module ? h("span", { class: "mbt-chip", title: "Only when this module is on for the user" }, n.module) : null,
      n.when ? h("span", { class: "mbt-chip mbt-chip--when", title: "Only in this situation" }, n.when) : null,
      n.style && Object.keys(n.style).length ? h("span", { class: "mbt-chip mbt-chip--style", title: "Has its own style" }, "style") : null,
      actions);
    const li = h("li", { class: "mbt-node", "data-id": n.id }, row);
    if (n.children) li.append(list(n.id, n.children));
    return li;
  }
  function actionBtn(icon, label, onClick, cls = "") {
    return h("button", { type: "button", class: `mbt-btn ${cls}`, title: label, "aria-label": label, "data-read": "1", onclick: (e) => { e.stopPropagation(); onClick(); } }, iconSvg(icon));
  }

  /* ========================================================= drag & drop */

  function clearMarks() {
    for (const el of $$(".drop-before, .drop-after, .drop-inside", $("#mbTree"))) el.classList.remove("drop-before", "drop-after", "drop-inside");
  }
  function dropTarget(event) {
    const drop = event.target.closest(".mbt-drop");
    if (drop) {
      const key = drop.dataset.container;
      return canPlace(dragId, key) ? { el: drop, where: "inside", container: key, index: Number(drop.dataset.index) } : null;
    }
    const row = event.target.closest(".mbt-row[data-id]");
    if (!row || row.dataset.id === dragId) return null;
    const rect = row.getBoundingClientRect();
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    const f = find(row.dataset.id);
    if (!f) return null;
    // The middle of a section or a row: into it, at its end.
    if (f.node.children && y > 0.28 && y < 0.72 && canPlace(dragId, f.node.id)) {
      return { el: row, where: "inside", container: f.node.id, index: f.node.children.length };
    }
    const key = row.dataset.container;
    const i = Number(row.dataset.index);
    const where = y < 0.5 ? "before" : "after";
    return canPlace(dragId, key) ? { el: row, where, container: key, index: where === "before" ? i : i + 1 } : null;
  }

  /* ========================================================== properties */

  function field(label, control, hint, wide) {
    return h("label", { class: `field mb-field${wide ? " mb-field--wide" : ""}` }, h("span", { class: "label" }, label), control, hint ? h("span", { class: "muted small" }, hint) : null);
  }
  function textField(label, value, onChange, opts = {}) {
    const input = h(opts.area ? "textarea" : "input", {
      class: `input${opts.mono ? " mono" : ""}`, type: opts.area ? undefined : "text", maxlength: String(opts.max || 80),
      placeholder: opts.placeholder || "", rows: opts.area ? String(opts.rows || 8) : undefined, spellcheck: opts.mono ? "false" : undefined,
      "data-prop": opts.prop || undefined,
    });
    input.value = value || "";
    input.addEventListener("input", () => {
      const ok = opts.valid ? opts.valid(input.value) : true;
      input.classList.toggle("is-invalid", !ok);
      if (ok) edit(() => onChange(input.value));
    });
    return field(label, input, opts.hint, opts.wide);
  }
  function selectField(label, value, options, onChange, opts = {}) {
    const sel = h("select", { class: "input", "data-prop": opts.prop || undefined },
      opts.empty !== false ? h("option", { value: "" }, opts.empty || "—") : null,
      options.map(([v, text]) => h("option", { value: v, selected: String(value ?? "") === v || undefined }, text)));
    sel.addEventListener("change", () => edit(() => onChange(sel.value === "" ? undefined : sel.value), { props: Boolean(opts.rerender) }));
    return field(label, sel, opts.hint, opts.wide);
  }
  function checkField(label, value, onChange, opts = {}) {
    const box = h("input", { type: "checkbox", checked: value || undefined, "data-prop": opts.prop || undefined });
    box.addEventListener("change", () => edit(() => onChange(box.checked), { props: Boolean(opts.rerender) }));
    return h("label", { class: "switch mb-switch" }, box, label);
  }
  /** yes / no / unset (unset keeps the template's own look). */
  function triField(label, value, onChange, opts = {}) {
    return selectField(label, value === undefined ? "" : value ? "yes" : "no", [["yes", "yes"], ["no", "no"]], (v) => onChange(v === undefined ? undefined : v === "yes"), opts);
  }
  function numberField(label, value, min, max, stepBy, onChange, opts = {}) {
    const input = h("input", { class: "input", type: "number", min: String(min), max: String(max), step: String(stepBy), placeholder: opts.placeholder || "—", "data-prop": opts.prop || undefined });
    if (value !== undefined && value !== null) input.value = String(value);
    input.addEventListener("input", () => {
      if (input.value === "") { edit(() => onChange(undefined)); return; }
      const n = Number(input.value);
      if (!Number.isFinite(n)) return;
      edit(() => onChange(Math.max(min, Math.min(max, n))));
    });
    return field(label, input, opts.hint);
  }
  function colorField(label, value, onChange, opts = {}) {
    const tokens = catalog.colors || [];
    const hex = typeof value === "string" && value.startsWith("#");
    const sel = h("select", { class: "input", "data-prop": opts.prop || undefined },
      h("option", { value: "" }, "—"),
      h("optgroup", { label: "The template's colours" }, tokens.map((t) => h("option", { value: t, selected: value === t || undefined }, t))),
      h("option", { value: "#", selected: hex || undefined }, "Custom colour…"));
    const pick = h("input", { type: "color", class: "mb-color", title: "Pick a colour", "data-prop": opts.prop ? `${opts.prop}-pick` : undefined });
    pick.value = hex && /^#[0-9a-f]{6}$/i.test(value) ? value : "#3366ff";
    pick.hidden = !hex;
    const swatch = h("span", { class: "mb-swatch", "aria-hidden": "true" });
    const paint = (v) => { swatch.style.background = v ? previewColor(v) : "transparent"; swatch.classList.toggle("is-empty", !v); };
    paint(value);
    sel.addEventListener("change", () => {
      if (sel.value === "#") { pick.hidden = false; paint(pick.value); edit(() => onChange(pick.value)); }
      else { pick.hidden = true; paint(sel.value); edit(() => onChange(sel.value || undefined)); }
    });
    pick.addEventListener("input", () => { paint(pick.value); edit(() => onChange(pick.value)); });
    return field(label, h("span", { class: "mb-colorctl" }, swatch, sel, pick));
  }
  function iconField(label, value, onChange, opts = {}) {
    const btn = h("button", { type: "button", class: "btn btn--sm mb-iconbtn", "data-prop": opts.prop || undefined, "data-read": "1" },
      value ? iconSvg(value) : null, h("span", {}, value || opts.none || "— none —"));
    btn.addEventListener("click", () => openIconPicker(value, opts.optional, (name) => edit(() => onChange(name), { props: true })));
    if (readOnly) btn.disabled = true;
    return field(label, btn, opts.hint);
  }
  const grid = (...children) => h("div", { class: "mb-grid" }, children);
  function group(title, ...children) {
    return h("fieldset", { class: "mb-fs" }, h("legend", {}, title), grid(...children));
  }

  /** A style and its states. get() → the style (or undefined), set(style or undefined). */
  function styleEditor(title, get, set, opts = {}) {
    const st = () => get() || {};
    const put = (key, value) => {
      const s = { ...st() };
      if (value === undefined || value === "") delete s[key]; else s[key] = value;
      set(Object.keys(s).length ? s : undefined);
    };
    const putState = (state, key, value) => {
      const s = { ...st() };
      const states = { ...(s.states || {}) };
      const one = { ...(states[state] || {}) };
      if (value === undefined || value === "") delete one[key]; else one[key] = value;
      if (Object.keys(one).length) states[state] = one; else delete states[state];
      if (Object.keys(states).length) s.states = states; else delete s.states;
      set(Object.keys(s).length ? s : undefined);
    };
    const s = st();
    const set_ = Object.keys(s).filter((k) => k !== "states").length + Object.keys(s.states || {}).length;
    const opts2 = (list) => (list || []).map((v) => [v, v]);
    const details = h("details", { class: "mb-style", open: opts.open || undefined },
      h("summary", {}, title, set_ ? h("span", { class: "badge badge--accent" }, `${set_} set`) : h("span", { class: "muted small" }, "the template's own look")));
    details.append(
      group("Text",
        selectField("Font", s.fontFamily, opts2(catalog.fonts), (v) => put("fontFamily", v), { prop: "style-fontFamily" }),
        numberField("Size (px)", s.fontSize, 8, 40, 1, (v) => put("fontSize", v), { prop: "style-fontSize" }),
        selectField("Weight", s.fontWeight, opts2(catalog.fontWeights), (v) => put("fontWeight", v), { prop: "style-fontWeight" }),
        triField("Italic", s.italic, (v) => put("italic", v), { prop: "style-italic" }),
        triField("Underline", s.underline, (v) => put("underline", v), { prop: "style-underline" }),
        triField("UPPER CASE", s.uppercase, (v) => put("uppercase", v), { prop: "style-uppercase" }),
        numberField("Letter spacing (px)", s.letterSpacing, -2, 10, 0.1, (v) => put("letterSpacing", v), { prop: "style-letterSpacing" })),
      group("Colours",
        colorField("Text", s.color, (v) => put("color", v), { prop: "style-color" }),
        colorField("Background", s.background, (v) => put("background", v), { prop: "style-background" }),
        colorField("Icon", s.iconColor, (v) => put("iconColor", v), { prop: "style-iconColor" }),
        colorField("Border", s.borderColor, (v) => put("borderColor", v), { prop: "style-borderColor" })),
      group("Layout",
        selectField("Alignment", s.align, opts2(catalog.aligns), (v) => put("align", v), { prop: "style-align" }),
        selectField("Wrapping", s.wrap, [["wrap", "wrap"], ["nowrap", "one line"], ["ellipsis", "one line with …"]], (v) => put("wrap", v), { prop: "style-wrap" }),
        numberField("Padding ↔ (px)", s.paddingX, 0, 48, 1, (v) => put("paddingX", v), { prop: "style-paddingX" }),
        numberField("Padding ↕ (px)", s.paddingY, 0, 48, 1, (v) => put("paddingY", v), { prop: "style-paddingY" }),
        numberField("Gap (px)", s.gap, 0, 32, 1, (v) => put("gap", v), { prop: "style-gap" }),
        numberField("Min. height (px)", s.minHeight, 0, 120, 1, (v) => put("minHeight", v), { prop: "style-minHeight" }),
        numberField("Corner radius (px)", s.radius, 0, 64, 1, (v) => put("radius", v), { prop: "style-radius" })),
      group("Icon",
        numberField("Icon size (px)", s.iconSize, 8, 48, 1, (v) => put("iconSize", v), { prop: "style-iconSize" }),
        selectField("Icon position", s.iconPosition, opts2(catalog.iconPositions), (v) => put("iconPosition", v), { prop: "style-iconPosition" })),
      group("Border & effects",
        numberField("Border width (px)", s.borderWidth, 0, 8, 1, (v) => put("borderWidth", v), { prop: "style-borderWidth" }),
        selectField("Border style", s.borderStyle, opts2(catalog.borders), (v) => put("borderStyle", v), { prop: "style-borderStyle" }),
        numberField("Opacity (0–1)", s.opacity, 0, 1, 0.05, (v) => put("opacity", v), { prop: "style-opacity" }),
        numberField("Scale (0.8–1.2)", s.scale, 0.8, 1.2, 0.01, (v) => put("scale", v), { prop: "style-scale" }),
        selectField("Shadow", s.shadow, opts2(catalog.shadows), (v) => put("shadow", v), { prop: "style-shadow" })),
    );
    if (opts.states !== false) details.append(stateTabs(s, putState));
    if (!readOnly) {
      details.append(h("div", { class: "mb-style__foot" },
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => edit(() => set(undefined), { props: true }) }, "Clear this style")));
    }
    return details;
  }
  function stateTabs(s, putState) {
    const box = h("fieldset", { class: "mb-fs mb-states" }, h("legend", {}, "States"));
    const tabs = h("div", { class: "mb-tabs", role: "tablist" });
    const panes = h("div", {});
    const keys = catalog.states || Object.keys(STATE_LABELS);
    keys.forEach((state, i) => {
      const one = (s.states && s.states[state]) || {};
      const count = Object.keys(one).length;
      const tab = h("button", { type: "button", role: "tab", class: `mb-tab${i === 0 ? " is-on" : ""}`, "aria-selected": i === 0 ? "true" : "false", "data-read": "1", "data-state-tab": state },
        STATE_LABELS[state] || state, count ? h("span", { class: "mb-tab__n" }, String(count)) : null);
      const pane = h("div", { role: "tabpanel", hidden: i === 0 ? undefined : true, "data-state-pane": state },
        grid(
          colorField("Text", one.color, (v) => putState(state, "color", v), { prop: `state-${state}-color` }),
          colorField("Background", one.background, (v) => putState(state, "background", v), { prop: `state-${state}-background` }),
          colorField("Icon", one.iconColor, (v) => putState(state, "iconColor", v), { prop: `state-${state}-iconColor` }),
          colorField("Border", one.borderColor, (v) => putState(state, "borderColor", v), { prop: `state-${state}-borderColor` }),
          selectField("Weight", one.fontWeight, (catalog.fontWeights || []).map((v) => [v, v]), (v) => putState(state, "fontWeight", v), { prop: `state-${state}-fontWeight` }),
          triField("Underline", one.underline, (v) => putState(state, "underline", v), { prop: `state-${state}-underline` }),
          numberField("Opacity", one.opacity, 0, 1, 0.05, (v) => putState(state, "opacity", v), { prop: `state-${state}-opacity` }),
          numberField("Scale", one.scale, 0.8, 1.2, 0.01, (v) => putState(state, "scale", v), { prop: `state-${state}-scale` }),
          selectField("Shadow", one.shadow, (catalog.shadows || []).map((v) => [v, v]), (v) => putState(state, "shadow", v), { prop: `state-${state}-shadow` })));
      tab.addEventListener("click", () => {
        for (const t of $$(".mb-tab", tabs)) { t.classList.toggle("is-on", t === tab); t.setAttribute("aria-selected", t === tab ? "true" : "false"); }
        for (const p of $$("[data-state-pane]", panes)) p.hidden = p !== pane;
        view.state = state;
        const pick = $("#mbState");
        if (pick) pick.value = state;
        renderPreview();
      });
      tabs.append(tab);
      panes.append(pane);
    });
    box.append(h("p", { class: "muted small" }, "Hover and click apply as the pointer does it, keyboard focus when tabbing, current for the open panel or a switch that is on. The preview shows a state for the selected element with “Show state”."), tabs, panes);
    return box;
  }

  function actionEditor(n) {
    const a = n.action || { type: "none" };
    const typeSel = selectField("Action", a.type, [["panel", "Open a panel"], ["fn", "Run a function"], ["url", "Open a link"], ["none", "Nothing"]], (v) => {
      n.action = v === "panel" ? { type: "panel", panel: "settings" } : v === "fn" ? { type: "fn", fn: "openRoom" } : v === "url" ? { type: "url", href: "https://" } : { type: "none" };
    }, { empty: false, rerender: true, prop: "action-type" });
    const rows = [typeSel];
    if (a.type === "panel") {
      rows.push(selectField("Panel", a.panel, (catalog.panels || []).map((p) => [p, p]), (v) => { n.action = { type: "panel", panel: v || "settings" }; }, { empty: false, prop: "action-panel", hint: "Its module rules follow automatically." }));
    } else if (a.type === "fn") {
      const fn = (catalog.fns || []).find((f) => f.id === a.fn);
      rows.push(selectField("Function", a.fn, (catalog.fns || []).map((f) => [f.id, `${f.id} — ${f.label}`]), (v) => { n.action = { type: "fn", fn: v || "openRoom" }; }, { empty: false, rerender: true, prop: "action-fn" }));
      if (fn && fn.param) rows.push(textField("Parameter", a.param, (v) => { if (v.trim()) n.action.param = v.trim(); else delete n.action.param; }, { mono: true, max: 40, placeholder: fn.param, prop: "action-param" }));
    } else if (a.type === "url") {
      rows.push(textField("Address", a.href, (v) => { n.action.href = v.trim(); }, {
        mono: true, max: 400, placeholder: "https://… or /path", prop: "action-href",
        valid: (v) => /^https:\/\/\S+$/i.test(v.trim()) || /^\/(?!\/)\S*$/.test(v.trim()),
        hint: "https:// or a path of this site; nothing else is kept.",
      }));
      rows.push(checkField("Open in a new tab", a.newTab, (v) => { if (v) n.action.newTab = true; else delete n.action.newTab; }));
    }
    return group("What it does", ...rows);
  }

  function commonFields(n) {
    return group("Visibility",
      selectField("Module", n.module, (catalog.modules || []).map((m) => [m.id, `${m.label} (${m.id})`]), (v) => { if (v) n.module = v; else delete n.module; },
        { empty: "— follows its panel —", prop: "module", hint: "Hidden when the module is off for the user's groups." }),
      selectField("Show", n.when, (catalog.when || []).filter((w) => w !== "always").map((w) => [w, w]), (v) => { if (v) n.when = v; else delete n.when; },
        { empty: "always", prop: "when" }),
      checkField("Hidden (kept here, not shown)", n.hidden, (v) => { if (v) n.hidden = true; else delete n.hidden; }, { prop: "hidden" }));
  }

  function renderProps() {
    const box = $("#mbProps");
    if (!box) return;
    clear(box);
    if (selection === "trigger") box.append(...triggerProps());
    else if (selection === "panel") box.append(...panelProps());
    else {
      const f = find(selection);
      if (f) box.append(...nodeProps(f.node));
      else box.append(h("p", { class: "muted" }, "Pick an element on the left or in the preview."));
    }
    if (readOnly) {
      for (const el of $$("input, select, textarea, button", box)) if (!el.closest(".mb-tabs") && !el.closest("summary")) el.disabled = true;
    }
  }
  function head(icon, title, hint) {
    return h("div", { class: "mb-props__head" }, iconSvg(icon, "mb-ico mb-ico--lg"), h("div", {}, h("strong", {}, title), h("div", { class: "muted small" }, hint)));
  }
  function triggerProps() {
    const t = draft.trigger;
    return [
      head(t.icon, "☰ Menu button", "The button that opens the menu (phones always, desktops in the ☰ display mode)."),
      group("Button",
        iconField("Icon", t.icon, (v) => { t.icon = v || "menu"; }, { prop: "trigger-icon" }),
        textField("Text", t.text, (v) => { t.text = v; }, { max: 40, prop: "trigger-text", hint: "Optional; {$variables} work." }),
        checkField("Show the text next to the icon", t.showText, (v) => { t.showText = v; }, { prop: "trigger-showtext" }),
        textField("Tooltip", t.title, (v) => { t.title = v; }, { prop: "trigger-title", hint: "@menu.open = the app's own translated text." })),
      styleEditor("Style of the button", () => t.style, (v) => { t.style = v || {}; }, { open: true }),
    ];
  }
  function panelProps() {
    const p = draft.panel;
    const lim = (catalog.limits && catalog.limits.width) || [220, 560];
    return [
      head("layout-grid", "Panel window", "The window the ☰ button opens: size, header, and the look every heading and item starts from."),
      group("Window",
        numberField("Width (px)", p.width, lim[0], lim[1], 10, (v) => { p.width = v === undefined ? 320 : v; }, { prop: "panel-width", hint: `${lim[0]}–${lim[1]}; never wider than the screen.` }),
        textField("Title", p.title, (v) => { p.title = v; }, { prop: "panel-title", hint: "@menu.title = the app's own text; {$variables} work." }),
        checkField("Show the header", p.showHeader, (v) => { p.showHeader = v; }, { prop: "panel-header", rerender: true }),
        checkField("Close button in the header", p.showClose, (v) => { p.showClose = v; }, { prop: "panel-close" })),
      styleEditor("The window", () => p.style, (v) => { p.style = v || {}; }, { states: false }),
      styleEditor("The header", () => p.header, (v) => { p.header = v || {}; }, { states: false }),
      styleEditor("Every section heading", () => p.headings, (v) => { p.headings = v || {}; }, { states: false }),
      styleEditor("Every item", () => p.items, (v) => { p.items = v || {}; }),
    ];
  }
  function nodeProps(n) {
    const out = [head(nodeIcon(n), `${KINDS[n.kind].label}${n.kind === "special" ? ` · ${specialLabel(n.special)}` : ""}`, KINDS[n.kind].hint)];
    const ids = [textField("ID", n.id, (v) => {
      const next = v.trim();
      const old = n.id;
      n.id = next;
      if (selection === old) selection = next;
    }, {
      mono: true, max: 40, prop: "id",
      valid: (v) => ID_RE.test(v.trim()) && (v.trim() === n.id || !allIds().has(v.trim())),
      hint: "a–z, 0–9, “-”; unique. The app's test id is speeddial-<id>.",
    })];
    switch (n.kind) {
      case "section":
        out.push(group("Section", ...ids,
          textField("Heading", n.label, (v) => { n.label = v; }, { prop: "label", hint: "@key = the app's translated text (e.g. @menu.group.room); {$variables} work." }),
          iconField("Icon", n.icon, (v) => { if (v) n.icon = v; else delete n.icon; }, { optional: true, prop: "icon" })));
        break;
      case "item":
        out.push(group("Item", ...ids,
          textField("Text", n.label, (v) => { n.label = v; }, { prop: "label", hint: "@key = translated (e.g. @menu.settings); {$user.nickname}… work." }),
          iconField("Icon", n.icon, (v) => { n.icon = v || "circle-alert"; }, { prop: "icon" }),
          textField("Badge", n.badge, (v) => { if (v) n.badge = v; else delete n.badge; }, { max: 40, prop: "badge", placeholder: "e.g. {$room.peers}" })));
        out.push(actionEditor(n));
        break;
      case "html": {
        const area = textField("HTML", n.html, (v) => { n.html = v; }, {
          area: true, mono: true, rows: 10, max: (catalog.limits && catalog.limits.html) || 8000, prop: "html", wide: true,
          hint: "Allowed: common text tags, links (https or this site), images, buttons; styles without url(). data-action=\"panel:…\" or \"fn:…\" makes anything clickable.",
        });
        const textarea = $("textarea", area);
        const examples = h("select", { class: "input mb-examples", "data-read": "1" }, h("option", { value: "" }, "Insert an example…"),
          ((catalog.template && catalog.template.examples) || []).map((ex, i) => h("option", { value: String(i) }, ex.title)));
        examples.addEventListener("change", () => {
          const ex = catalog.template.examples[Number(examples.value)];
          examples.value = "";
          if (ex) insertAt(textarea, ex.html);
        });
        const helpBtn = h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => openHelp(textarea) }, iconSvg("circle-question-mark"), " Variables, filters & macros");
        out.push(group("HTML block", ...ids), h("div", { class: "mb-htmltools" }, helpBtn, examples), area);
        break;
      }
      case "separator":
        out.push(group("Separator", ...ids,
          selectField("Kind", n.variant, [["line", "line"], ["dashed", "dashed"], ["dotted", "dotted"], ["double", "double"], ["space", "space only"]], (v) => { n.variant = v || "line"; }, { empty: false, prop: "variant" }),
          colorField("Colour", n.color, (v) => { if (v) n.color = v; else delete n.color; }),
          numberField("Thickness (px)", n.thickness, 1, 8, 1, (v) => { if (v === undefined) delete n.thickness; else n.thickness = v; }),
          numberField("Space around (px)", n.spacing, 0, 48, 1, (v) => { if (v === undefined) delete n.spacing; else n.spacing = v; })));
        break;
      case "row":
        out.push(group("Row", ...ids, h("p", { class: "muted small mb-field--wide" }, "Drag items, special buttons, HTML or separators into the row; they stand side by side, like Appearance and Edit Mode at the top of the classic menu.")));
        break;
      case "special": {
        const sp = (catalog.specials || []).find((x) => x.id === n.special);
        out.push(group("Special button", ...ids,
          selectField("Button", n.special, (catalog.specials || []).map((x) => [x.id, x.label]), (v) => { n.special = v || "toneToggle"; }, { empty: false, rerender: true, prop: "special" }),
          textField("Text", n.label, (v) => { if (v) n.label = v; else delete n.label; }, { prop: "label", placeholder: "the app's own", hint: "Empty = the app's own text." }),
          iconField("Icon", n.icon, (v) => { if (v) n.icon = v; else delete n.icon; }, { optional: true, none: "the app's own", prop: "icon" }),
          sp && sp.stateful ? checkField("Show the state (ON / OFF…)", n.showState !== false, (v) => { n.showState = v; }, { prop: "showstate" }) : null));
        break;
      }
      default: break;
    }
    out.push(commonFields(n));
    if (n.kind !== "separator") {
      out.push(styleEditor(n.kind === "section" ? "Style of the heading" : n.kind === "row" ? "Style of the row" : "Style", () => n.style, (v) => { if (v) n.style = v; else delete n.style; }, { open: Boolean(n.style) }));
    }
    return out;
  }
  function insertAt(textarea, text) {
    if (!textarea || textarea.disabled) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ========================================================= icon picker */

  function openIconPicker(current, optional, onPick) {
    const names = Object.keys(catalog.icons || {});
    const search = h("input", { class: "input", type: "search", placeholder: `Search ${names.length} icons…`, "aria-label": "Search icons", "data-read": "1" });
    const gridBox = h("div", { class: "mb-icongrid", role: "listbox", "aria-label": "Icons" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const pick = (name) => { close(); onPick(name); };
    const draw = () => {
      clear(gridBox);
      const q = search.value.trim().toLowerCase();
      if (optional) gridBox.append(h("button", { type: "button", class: `mb-iconpick${!current ? " is-on" : ""}`, "data-read": "1", onclick: () => pick(undefined) }, h("span", { class: "mb-iconpick__none" }, "∅"), h("span", {}, "none")));
      for (const name of names) {
        if (q && !name.includes(q)) continue;
        gridBox.append(h("button", { type: "button", role: "option", "aria-selected": name === current ? "true" : "false", class: `mb-iconpick${name === current ? " is-on" : ""}`, title: name, "data-icon": name, "data-read": "1", onclick: () => pick(name) }, iconSvg(name), h("span", {}, name)));
      }
    };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const dialog = h("div", { class: "mb-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Pick an icon" },
      h("div", { class: "mb-dialog__head" }, h("strong", {}, "Pick an icon"), h("span", { class: "muted small" }, "lucide · the same icons the app draws"),
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => close() }, "Close")),
      search, gridBox);
    const overlay = h("div", { class: "mb-overlay", onclick: (e) => { if (e.target === overlay) close(); } }, dialog);
    search.addEventListener("input", draw);
    draw();
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    search.focus();
  }

  /* ========================================================== help window */

  function openHelp(target) {
    helpTarget = target || null;
    let win = $("#mbHelp");
    if (win) { win.hidden = false; updateHelpTarget(); $("input", win).focus(); return; }
    const tpl = (catalog && catalog.template) || { variables: [], filters: [], macros: [], examples: [] };
    const body = h("div", { class: "mb-help__body" });
    const filter = h("input", { class: "input", type: "search", placeholder: "Filter…", "aria-label": "Filter the help", "data-read": "1" });
    const tabs = [
      ["variables", "Variables", () => tpl.variables.map((v) => entry(v.path.startsWith("$") ? `{${v.path}}` : v.path, v.description, v.type))],
      ["filters", "Filters", () => tpl.filters.map((f) => entry(f.example, `${f.name}${f.args ? `:${f.args}` : ""} — ${f.description}`))],
      ["macros", "Macros", () => tpl.macros.map((m) => entry(m.syntax, m.description))],
      ["examples", "Examples", () => tpl.examples.map((e) => entry(e.html, e.title, "", true))],
    ];
    const tabBar = h("div", { class: "mb-tabs", role: "tablist" });
    let current = "variables";
    const draw = () => {
      clear(body);
      const q = filter.value.trim().toLowerCase();
      const [, , make] = tabs.find(([id]) => id === current);
      const rows = make().filter((row) => !q || row.dataset.search.includes(q));
      body.append(...(rows.length ? rows : [h("p", { class: "muted small" }, "Nothing matches.")]));
    };
    for (const [id, label] of tabs) {
      const tab = h("button", { type: "button", role: "tab", class: `mb-tab${id === current ? " is-on" : ""}`, "data-read": "1", "data-help-tab": id }, label);
      tab.addEventListener("click", () => {
        current = id;
        for (const t of $$(".mb-tab", tabBar)) t.classList.toggle("is-on", t === tab);
        draw();
      });
      tabBar.append(tab);
    }
    filter.addEventListener("input", draw);
    const target_ = h("div", { class: "mb-help__target muted small", id: "mbHelpTarget" });
    const header = h("div", { class: "mb-help__head" },
      iconSvg("circle-question-mark"), h("strong", {}, "Template language"),
      h("span", { class: "muted small" }, "Latte-like · click to insert"),
      h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "aria-label": "Close the help", onclick: () => { win.hidden = true; } }, "×"));
    win = h("div", { id: "mbHelp", class: "mb-help", role: "dialog", "aria-label": "Template language help" }, header, h("div", { class: "mb-help__tools" }, tabBar, filter), target_, body);
    document.body.append(win);
    // Move it by its header.
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const rect = win.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      header.setPointerCapture(e.pointerId);
      const move = (ev) => {
        win.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx))}px`;
        win.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy))}px`;
        win.style.right = "auto";
      };
      const up = () => { header.removeEventListener("pointermove", move); header.removeEventListener("pointerup", up); };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", up);
    });
    updateHelpTarget();
    draw();
    filter.focus();
  }
  function updateHelpTarget() {
    const el = $("#mbHelpTarget");
    if (el) el.textContent = helpTarget && document.body.contains(helpTarget) ? "Inserts into the HTML block you are editing." : "Copies to the clipboard (open the help from an HTML block to insert).";
  }
  function entry(code, text, type, block) {
    const row = h("button", { type: "button", class: `mb-help__row${block ? " is-block" : ""}`, "data-read": "1", "data-search": `${code} ${text} ${type || ""}`.toLowerCase(), title: "Insert" },
      h("code", {}, code), h("span", { class: "mb-help__desc" }, text, type ? h("span", { class: "badge" }, type) : null));
    row.addEventListener("click", () => {
      if (helpTarget && document.body.contains(helpTarget) && !helpTarget.disabled) insertAt(helpTarget, code);
      else if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast("Copied.", "ok"), () => toast(code));
      else toast(code);
    });
    return row;
  }

  /* ============================================================= styles */

  function cssColor(v) {
    return (catalog && catalog.colorTokens && catalog.colorTokens[v]) || v;
  }
  /** A colour for a swatch: tokens resolve against the preview's palette. */
  function previewColor(v) {
    const host = $("#mbPreview");
    const css = cssColor(v);
    const m = /^hsl\(var\((--[a-z-]+)\)\)$/.exec(css);
    if (m && host) {
      const raw = getComputedStyle(host).getPropertyValue(m[1]).trim();
      return raw ? `hsl(${raw})` : "transparent";
    }
    return css;
  }
  function mergeStyles(...styles) {
    const out = {};
    for (const s of styles) {
      if (!s) continue;
      const { states, ...rest } = s;
      Object.assign(out, rest);
      if (states) {
        out.states = { ...(out.states || {}) };
        for (const k of Object.keys(states)) out.states[k] = { ...(out.states[k] || {}), ...states[k] };
      }
    }
    return out;
  }
  /** The same CSS the app puts on an element (client/src/lib/menu-style.ts). */
  function styleProps(style) {
    const css = {};
    const classes = [];
    if (!style) return { css, classes };
    if (style.color) css.color = cssColor(style.color);
    if (style.background) css.background = cssColor(style.background);
    if (style.iconColor) { css["--mb-icon"] = cssColor(style.iconColor); classes.push("mb-ic"); }
    if (style.borderColor) css["border-color"] = cssColor(style.borderColor);
    if (style.borderWidth !== undefined) { css["border-width"] = `${style.borderWidth}px`; css["border-style"] = style.borderStyle || "solid"; }
    else if (style.borderStyle) css["border-style"] = style.borderStyle;
    if (style.fontWeight) css["font-weight"] = style.fontWeight;
    if (style.underline !== undefined) css["text-decoration"] = style.underline ? "underline" : "none";
    if (style.opacity !== undefined) css.opacity = String(style.opacity);
    if (style.scale !== undefined) css.transform = `scale(${style.scale})`;
    if (style.shadow) css["box-shadow"] = SHADOW_CSS[style.shadow];
    if (style.align) {
      css["justify-content"] = style.align === "start" ? "flex-start" : style.align === "end" ? "flex-end" : style.align === "between" ? "space-between" : "center";
      css["text-align"] = style.align === "between" ? "start" : style.align;
    }
    if (style.wrap === "nowrap") css["white-space"] = "nowrap";
    if (style.wrap === "wrap") css["white-space"] = "normal";
    if (style.wrap === "ellipsis") classes.push("mb-ellipsis");
    if (style.fontSize) css["font-size"] = `${style.fontSize}px`;
    if (style.fontFamily && style.fontFamily !== "inherit") css["font-family"] = (catalog.fontStacks || {})[style.fontFamily] || "inherit";
    if (style.italic !== undefined) css["font-style"] = style.italic ? "italic" : "normal";
    if (style.uppercase !== undefined) css["text-transform"] = style.uppercase ? "uppercase" : "none";
    if (style.letterSpacing !== undefined) css["letter-spacing"] = `${style.letterSpacing}px`;
    if (style.iconSize) { css["--mb-icon-size"] = `${style.iconSize}px`; classes.push("mb-is"); }
    if (style.iconPosition && style.iconPosition !== "start") classes.push(`mb-icon-${style.iconPosition}`);
    if (style.paddingX !== undefined) css["padding-inline"] = `${style.paddingX}px`;
    if (style.paddingY !== undefined) css["padding-block"] = `${style.paddingY}px`;
    if (style.gap !== undefined) css.gap = `${style.gap}px`;
    if (style.minHeight !== undefined) css["min-height"] = `${style.minHeight}px`;
    if (style.radius !== undefined) css["border-radius"] = `${style.radius}px`;
    for (const state of Object.keys(STATE_LABELS)) {
      const st = style.states && style.states[state];
      if (!st) continue;
      for (const [key, slug, toCss] of STATE_PROPS) {
        if (st[key] === undefined) continue;
        css[`--mb-${state}-${slug}`] = toCss(st[key]);
        classes.push(`mb-${state}-${slug}`);
      }
    }
    return { css, classes };
  }
  function styled(el, ...styles) {
    const { css, classes } = styleProps(mergeStyles(...styles));
    for (const [k, v] of Object.entries(css)) el.style.setProperty(k, v);
    if (classes.length) el.classList.add(...classes);
    return el;
  }

  /* ============================================================ preview */

  let previewTimer = 0;
  let previewSeq = 0;
  function requestPreview(now) {
    clearTimeout(previewTimer);
    renderPreview();
    previewTimer = setTimeout(async () => {
      const seq = ++previewSeq;
      try {
        const r = await api("/api/admin/menu-config/render", { method: "POST", body: { config: draft, lang: view.lang } });
        if (seq !== previewSeq) return;
        preview = r;
      } catch {
        if (seq !== previewSeq) return;
        preview = { labels: {}, html: {}, strings: {}, title: draft.panel.title, trigger: { text: draft.trigger.text, title: draft.trigger.title }, vars: {} };
      }
      renderPreview();
      if (!dragId) renderTree();
    }, now ? 0 : 250);
  }
  const str = (key, fallback) => (preview.strings && preview.strings[key]) || fallback;
  const label = (n) => preview.labels[n.id] ?? (n.label || "");
  function visible(n) {
    if (n.hidden) return false;
    switch (n.when) {
      case "signedIn": return view.signedIn;
      case "signedOut": return !view.signedIn;
      case "connected": return view.connected;
      case "disconnected": return !view.connected;
      case "phone": return view.phone;
      case "desktop": return !view.phone;
      default: return true;
    }
  }
  function mark(el, id) {
    el.setAttribute("data-mb-id", id);
    if (selection === id) {
      el.classList.add("mbp-selected");
      if (view.state) {
        el.classList.add(`mbp-force-${view.state}`);
        if (view.state === "current") el.setAttribute("aria-current", "page");
      }
    }
    return el;
  }
  function buildSafe(nodes) {
    const out = [];
    for (const n of nodes || []) {
      if (typeof n === "string") { out.push(document.createTextNode(n)); continue; }
      if (!n || typeof n !== "object") continue;
      if (n.t === "i" && n.a && n.a["data-icon"]) { out.push(iconSvg(n.a["data-icon"], "mb-inline-icon")); continue; }
      if (!SAFE_TAGS.has(n.t)) continue;
      const el = document.createElement(n.t);
      for (const [k, v] of Object.entries(n.a || {})) {
        if (/^on/i.test(k)) continue;
        if (k === "style") el.style.cssText = v; else el.setAttribute(k === "class" ? "class" : k, v);
      }
      el.append(...buildSafe(n.c));
      out.push(el);
    }
    return out;
  }
  function htmlBlock(n, cls) {
    const r = preview.html[n.id];
    const st = styleProps(n.style);
    const box = h("div", { class: `menu-html${cls ? ` ${cls}` : ""}${r && r.error ? " is-error" : ""}` });
    for (const [k, v] of Object.entries(st.css)) box.style.setProperty(k, v);
    if (st.classes.length) box.classList.add(...st.classes);
    if (!r) box.append(h("span", { class: "muted" }, "…"));
    else if (r.error) box.textContent = r.error;
    else box.append(...buildSafe(r.nodes));
    return box;
  }
  const avatar = () => h("span", { class: "user-chip__avatar", "aria-hidden": "true" }, "A");
  const sample = (path, fallback) => {
    let v = preview.vars;
    for (const p of path.split(".")) v = v && typeof v === "object" ? v[p] : undefined;
    return v === undefined || v === null || v === "" ? fallback : String(v);
  };

  function renderPreview() {
    const host = $("#mbPreview");
    if (!host || !draft) return;
    clear(host);
    host.className = `mbp mbp--${view.tone}`;
    host.append(view.mode === "toolbar" ? previewToolbar() : previewPanel());
  }
  function previewPanel() {
    const t = draft.trigger;
    const trigger = styled(h("button", { type: "button", class: `mbp-trigger${t.showText && t.text ? " menu-trigger--text" : ""}`, title: preview.trigger.title || t.title }), t.style);
    trigger.append(iconSvg(t.icon, "h-5 w-5 rotate-90"));
    if (t.showText && t.text) trigger.append(h("span", { class: "menu-trigger__text" }, preview.trigger.text || t.text));
    mark(trigger, "trigger");
    const p = draft.panel;
    const panel = styled(h("div", { class: "menu-panel", role: "menu" }), p.style);
    panel.style.width = `${p.width}px`;
    mark(panel, "panel");
    if (p.showHeader) {
      const header = styled(h("header", { class: "mbp-header" }, h("span", {}, preview.title ?? p.title)), p.header);
      if (p.showClose) header.append(h("span", { class: "mbp-close", "aria-hidden": "true" }, iconSvg("x", "h-4 w-4")));
      panel.append(header);
    }
    const ul = h("ul", { class: "mbp-list", role: "none" });
    for (const n of draft.items) ul.append(...panelNode(n));
    panel.append(ul);
    const foot = draft.footer.filter(visible).map((n) => inline(n, true)).filter(Boolean);
    if (foot.length) panel.append(h("footer", { class: "menu-footer" }, foot));
    return h("div", { class: "mbp-stage" }, h("div", { class: "mbp-bar" }, h("span", { class: "mbp-brand" }, "M5cet"), trigger), panel);
  }
  function panelNode(n) {
    if (!visible(n)) return [];
    switch (n.kind) {
      case "section": {
        const kids = n.children.filter(visible);
        if (!kids.length) return [];
        const li = styled(h("li", { role: "presentation", class: "menu-group-label" }), draft.panel.headings, n.style);
        if (n.icon) li.append(iconSvg(n.icon, "menu-group-label__icon"));
        li.append(label(n));
        return [mark(li, n.id), ...kids.flatMap(panelNode)];
      }
      case "item": {
        const panelKey = n.action.type === "panel" ? n.action.panel : undefined;
        const btn = styled(h("button", { type: "button", role: "menuitem", class: "mbp-item", "data-panel": panelKey }), draft.panel.items, n.style);
        btn.append(h("span", { class: "menu-icon", "data-panel": panelKey, "aria-hidden": "true" }, iconSvg(n.icon, "h-4 w-4")), h("span", { class: "mbp-item__label" }, label(n)));
        if (n.badge) btn.append(h("span", { class: "menu-badge" }, renderBadge(n)));
        return [h("li", { role: "none" }, mark(btn, n.id))];
      }
      case "html":
        return [mark(h("li", { role: "none", class: "menu-html-row" }, htmlBlock(n)), n.id)];
      case "separator":
        return [mark(separator(n, "li"), n.id)];
      case "row": {
        const kids = n.children.filter(visible).map((c) => inline(c, false)).filter(Boolean);
        if (!kids.length) return [];
        return [mark(styled(h("li", { role: "none", class: "menu-quick" }, kids), n.style), n.id)];
      }
      case "special": {
        if (n.special === "user") {
          const li = styled(h("li", { role: "none", class: "menu-user" }, avatar(), h("span", { class: "mbp-user__name" }, n.label ? label(n) : sample("user.nickname", "Alice"))), n.style);
          return [mark(li, n.id)];
        }
        if (n.special === "build") return [mark(h("li", { role: "none", class: "menu-build-row" }, h("p", { class: "menu-build" }, buildText())), n.id)];
        const inner = inline(n, false);
        return inner ? [h("li", { role: "none", class: "menu-special" }, inner)] : [];
      }
      default: return [];
    }
  }
  function renderBadge(n) {
    // Badges are small templates; the preview shows the raw text when it has {…}.
    return /\{/.test(n.badge) ? n.badge.replace(/\{\$([a-z_.]+)[^}]*\}/gi, (_m, path) => sample(path, "…")) : n.badge;
  }
  const buildText = () => `M5cet ${sample("app.version", "4.0.0")} · build ${sample("app.build", "preview")}`;
  function separator(n, tag) {
    const el = h(tag, { role: "separator", class: `menu-sep menu-sep--${n.variant}` });
    if (n.variant !== "space") {
      el.style.borderTopStyle = n.variant === "line" ? "solid" : n.variant;
      if (n.thickness) el.style.borderTopWidth = `${n.variant === "double" ? Math.max(3, n.thickness) : n.thickness}px`;
      if (n.color) el.style.borderTopColor = previewColor(n.color);
    }
    if (n.spacing !== undefined) el.style.marginBlock = `${n.spacing}px`;
    return el;
  }
  /** A button in a row or the footer (the app's InlineNode). */
  function inline(n, footer) {
    if (!visible(n)) return null;
    const st = mergeStyles(n.kind === "item" ? draft.panel.items : undefined, n.style);
    const text = (key, fallback) => (n.label ? label(n) : str(key, fallback));
    let el = null;
    if (n.kind === "item") {
      el = h("button", { type: "button", class: "menu-quick__btn" }, iconSvg(n.icon, "h-4 w-4"), h("span", {}, label(n)));
    } else if (n.kind === "html") {
      el = htmlBlock(n, "menu-html--inline");
      return mark(el, n.id);
    } else if (n.kind === "separator") {
      el = footer ? separator(n, "hr") : h("span", { role: "separator", class: "menu-divider" });
      return mark(el, n.id);
    } else if (n.kind === "special") {
      switch (n.special) {
        case "appearance":
          el = h("button", { type: "button", class: "menu-quick__btn" }, iconSvg(n.icon || "palette", "h-4 w-4"), h("span", {}, text("menu.appearance", "Appearance")));
          break;
        case "editMode": {
          const show = n.showState !== false;
          el = h("button", { type: "button", role: "menuitemcheckbox", "aria-checked": "false", class: "menu-edit is-off " },
            h("span", { class: "menu-edit__icon", "aria-hidden": "true" }, iconSvg("x", "h-3.5 w-3.5")),
            h("span", { class: "menu-edit__label" }, n.label ? label(n) : "Edit Mode"),
            show ? h("span", { class: "menu-edit__state" }, "OFF") : null);
          break;
        }
        case "toneToggle":
        case "notifications": {
          const on = n.special === "toneToggle" ? view.tone === "dark" : true;
          el = h("button", { type: "button", role: "menuitemcheckbox", "aria-checked": on ? "true" : "false", class: `menu-edit ${on ? "is-on" : "is-off"}` },
            iconSvg(n.icon || (n.special === "toneToggle" ? (on ? "moon" : "sun") : "bell"), "h-4 w-4"),
            h("span", { class: "menu-edit__label" }, text(n.special === "toneToggle" ? "mb.tone" : "mb.notifications", n.special === "toneToggle" ? "Light / dark" : "Notifications")),
            n.showState !== false ? h("span", { class: "menu-edit__state" }, on ? "ON" : "OFF") : null);
          break;
        }
        case "account":
          el = h("button", { type: "button", class: `menu-quick__btn menu-account${view.signedIn ? " is-on" : ""}` },
            iconSvg(n.icon || (view.signedIn ? "badge-check" : "key-round"), "h-4 w-4"),
            h("span", { class: "mbp-trunc" }, view.signedIn ? (n.showState === false ? text("id.signedInAs", "Signed in as") : sample("user.username", "bystry-sokol-7k3q")) : text("id.signIn", "Sign in")));
          break;
        case "clearQuit":
          el = h("button", { type: "button", class: "menu-clear" }, iconSvg(n.icon || "log-out", "h-4 w-4"), h("span", {}, text("menu.clearQuit", "Clear & Quit")));
          break;
        case "build":
          return mark(h("p", { class: "menu-build" }, buildText()), n.id);
        case "user":
          el = h("span", { class: "menu-user menu-user--inline" }, avatar(), h("span", { class: "mbp-user__name" }, sample("user.nickname", "Alice")));
          break;
        default:
          return null;
      }
    }
    if (!el) return null;
    return mark(styled(el, st), n.id);
  }
  function previewToolbar() {
    const nav = h("nav", { class: "mbp-nav", role: "menubar" });
    const flat = [];
    let edit = null;
    let clearQuit = null;
    const take = (n, groupId) => {
      if (!visible(n)) return;
      if (n.kind === "section") { n.children.forEach((c) => take(c, n.id)); return; }
      if (n.kind === "row") { n.children.forEach((c) => take(c, groupId)); return; }
      if (n.kind === "special") {
        if (n.special === "editMode") edit = n;
        if (n.special === "clearQuit") clearQuit = n;
        return;
      }
      flat.push({ group: groupId, node: n });
    };
    draft.items.forEach((n) => take(n, `top:${n.id}`));
    draft.footer.forEach((n) => take(n, "footer"));
    flat.forEach(({ group: g, node: n }, i) => {
      const isProfile = n.kind === "item" && n.action.type === "panel" && n.action.panel === "profile";
      if ((i > 0 && flat[i - 1].group !== g) || isProfile || n.kind === "separator") nav.append(h("span", { role: "separator", class: "menu-divider" }));
      if (n.kind === "item") {
        if (isProfile) {
          nav.append(mark(styled(h("button", { type: "button", class: "user-chip" }, avatar(), h("span", { class: "user-chip__name" }, sample("user.nickname", "Alice"))), n.style), n.id));
        } else {
          const btn = styled(h("button", { type: "button", class: "mbp-tbtn", title: label(n) }, iconSvg(n.icon, "h-4 w-4"), h("span", {}, label(n))), draft.panel.items, n.style);
          nav.append(mark(btn, n.id));
        }
      } else if (n.kind === "html") nav.append(mark(htmlBlock(n, "menu-html--inline"), n.id));
    });
    if (edit) {
      nav.append(mark(h("button", { type: "button", class: "menu-edit is-off is-compact" },
        h("span", { class: "menu-edit__icon", "aria-hidden": "true" }, iconSvg("x", "h-3.5 w-3.5")), iconSvg(edit.icon || "pencil-ruler", "h-4 w-4")), edit.id));
    }
    if (clearQuit) {
      nav.append(h("span", { role: "separator", class: "menu-divider" }),
        mark(h("button", { type: "button", class: "mbp-tbtn mbp-tbtn--danger", title: str("menu.clearQuit", "Clear & Quit") }, iconSvg("log-out", "h-4 w-4")), clearQuit.id));
    }
    return h("div", { class: "mbp-stage mbp-stage--toolbar" }, h("div", { class: "mbp-bar mbp-bar--wide" }, h("span", { class: "mbp-brand" }, "M5cet"), nav),
      h("p", { class: "muted small" }, "Desktop toolbar (icons + text). Rows, headings and most special buttons belong to the ☰ panel; the toolbar keeps items, HTML, Edit Mode and Clear & Quit."));
  }

  /* ============================================================ chrome */

  function renderDirty() {
    const badge = $("#mbDirty");
    if (badge) badge.hidden = !dirty();
    const undoBtn = $("#mbUndo");
    const redoBtn = $("#mbRedo");
    if (undoBtn) undoBtn.disabled = readOnly || !undoStack.length;
    if (redoBtn) redoBtn.disabled = readOnly || !redoStack.length;
    const info = $("#mbFile");
    if (info) {
      let nodes = 0;
      walk(draft.items, () => { nodes++; });
      walk(draft.footer, () => { nodes++; });
      info.textContent = `${nodes} elements · ${file || "default menu"}${draft.updatedAt ? ` · saved ${new Date(draft.updatedAt).toLocaleString()}` : ""}${readOnly ? " · read only (auditor)" : ""}`;
    }
  }
  function renderAll() {
    const section = $("[data-panel=menu]");
    if (section) section.classList.toggle("mb--readonly", readOnly);
    renderTree();
    renderProps();
    renderPreview();
    renderDirty();
  }

  async function save() {
    if (readOnly) return;
    try {
      const r = await api("/api/admin/menu-config", { method: "PUT", body: { config: draft } });
      draft = clone(r.config);
      savedJson = comparable(r.config);
      if (selection !== "trigger" && selection !== "panel" && !find(selection)) selection = "trigger";
      renderAll();
      requestPreview(true);
      toast("Menu saved. Apps pick it up within five minutes (or on reload).", "ok");
    } catch (e) { toast(`Menu: ${e.message}`, "err"); }
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: "m5cet-menu.json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importJson(fileObj) {
    try {
      const raw = JSON.parse(await fileObj.text());
      const r = await api("/api/admin/menu-config/render", { method: "POST", body: { config: raw, lang: view.lang } });
      commit(() => { draft = clone(r.config); });
      selection = "trigger";
      renderAll();
      toast("Imported — check the preview, then Save.", "ok");
    } catch (e) { toast(`Import: ${e.message}`, "err"); }
  }

  function wire() {
    if (wired) return;
    wired = true;
    const tree = $("#mbTree");
    tree.addEventListener("click", (e) => {
      const row = e.target.closest(".mbt-row");
      if (!row || e.target.closest(".mbt-btn")) return;
      select(row.dataset.root || row.dataset.id);
    });
    tree.addEventListener("keydown", (e) => {
      const row = e.target.closest(".mbt-row");
      if (!row) return;
      const rows = $$(".mbt-row", tree);
      const i = rows.indexOf(row);
      const id = row.dataset.id;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(row.dataset.root || id); }
      else if (id && !readOnly && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        step(id, e.key === "ArrowUp" ? -1 : 1);
        const again = $(`.mbt-row[data-id="${CSS.escape(id)}"]`, tree);
        if (again) again.focus();
      } else if (e.key === "ArrowDown" && rows[i + 1]) { e.preventDefault(); rows[i + 1].focus(); }
      else if (e.key === "ArrowUp" && rows[i - 1]) { e.preventDefault(); rows[i - 1].focus(); }
      else if (id && !readOnly && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); removeNode(id); }
    });
    tree.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".mbt-row[data-id]");
      if (!row || readOnly) return;
      dragId = row.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
      // Not now: Chrome cancels a drag whose source moves during dragstart
      // (the drop zones grow as soon as the tree is "dragging").
      setTimeout(() => { if (dragId) { tree.classList.add("is-dragging"); row.classList.add("is-drag-source"); } }, 0);
    });
    tree.addEventListener("dragend", () => {
      dragId = null;
      tree.classList.remove("is-dragging");
      for (const el of $$(".is-drag-source", tree)) el.classList.remove("is-drag-source");
      clearMarks();
    });
    tree.addEventListener("dragover", (e) => {
      if (!dragId) return;
      const target = dropTarget(e);
      clearMarks();
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      target.el.classList.add(`drop-${target.where}`);
    });
    tree.addEventListener("dragleave", (e) => { if (!tree.contains(e.relatedTarget)) clearMarks(); });
    tree.addEventListener("drop", (e) => {
      if (!dragId) return;
      const target = dropTarget(e);
      clearMarks();
      if (!target) return;
      e.preventDefault();
      // The tree is redrawn: dragend then fires on a detached row, so end the drag here.
      const id = dragId;
      dragId = null;
      tree.classList.remove("is-dragging");
      if (moveNode(id, target.container, target.index)) select(id);
    });

    for (const btn of $$("[data-mb-add]")) btn.addEventListener("click", () => { if (!readOnly) addNode(btn.dataset.mbAdd); });
    $("#mbSave").addEventListener("click", () => void save());
    $("#mbUndo").addEventListener("click", undo);
    $("#mbRedo").addEventListener("click", redo);
    $("#mbHelpBtn").addEventListener("click", () => openHelp(null));
    $("#mbExport").addEventListener("click", exportJson);
    $("#mbImport").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) void importJson(f); });
    $("#mbRevert").addEventListener("click", () => {
      if (!dirty() || confirm("Discard the unsaved changes?")) load().catch((e) => toast(e.message, "err"));
    });
    $("#mbReset").addEventListener("click", () => {
      if (!confirm("Start from the classic menu? (Nothing is saved until you press Save.)")) return;
      commit(() => { draft = { ...clone(defaults), updatedAt: draft.updatedAt }; });
      selection = "trigger";
      renderAll();
    });
    const bindView = (id, key, parse = (v) => v) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
        view[key] = parse(el.type === "checkbox" ? el.checked : el.value);
        if (key === "lang") requestPreview(true); else renderPreview();
      });
    };
    bindView("#mbMode", "mode");
    bindView("#mbLang", "lang");
    bindView("#mbTone", "tone");
    bindView("#mbState", "state");
    bindView("#mbSignedIn", "signedIn");
    bindView("#mbConnected", "connected");
    bindView("#mbPhone", "phone");
    $("#mbPreview").addEventListener("click", (e) => {
      e.preventDefault();
      const hit = e.target.closest("[data-mb-id]");
      if (hit) select(hit.getAttribute("data-mb-id"));
    });
    document.addEventListener("keydown", (e) => {
      const section = $("[data-panel=menu]");
      if (!section || section.hidden || readOnly || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    });
    window.addEventListener("beforeunload", (e) => {
      if (dirty()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  C.addRoute("menu", ["Menu builder", "The app's navigation: sections, items, HTML with live values, separators, special buttons — each with its style and states", load]);
})();
