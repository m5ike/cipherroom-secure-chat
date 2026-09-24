// M5cet operator console — what the Menu builder and the Layout builder share
// (4.0.5): form fields that edit the draft as you type (one undo step per
// field), colour and icon pickers, the style editor with its states (hover,
// click, focus, current), a floating help window, and a type-ahead input
// that suggests values while typing (classes, attributes, CSS, variables…).
// Same rules as console.js: DOM nodes and textContent only, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, $, $$, toast } = C;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const STATE_LABELS = { hover: "Hover", active: "Click", focus: "Keyboard focus", current: "Current / on" };
  const SHADOW_CSS = {
    none: "none",
    sm: "0 1px 2px rgb(0 0 0 / 0.12)",
    md: "0 4px 12px rgb(0 0 0 / 0.16)",
    lg: "0 12px 32px rgb(0 0 0 / 0.22)",
    glow: "0 0 0 3px hsl(var(--primary) / 0.28)",
  };

  /** An icon of a catalog ({ name: [[tag, attrs], …] }) as an <svg>. */
  function iconSvg(icons, name, cls = "mb-ico") {
    const node = (icons && (icons[name] || icons["circle-alert"])) || [];
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

  /** Inserts text at a field's caret and tells the field it changed. */
  function insertAt(field, text) {
    if (!field || field.disabled) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    field.selectionStart = field.selectionEnd = start + text.length;
    field.focus();
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ------------------------------------------------------------ styles */

  function cssColor(v, tokens) {
    return (tokens && tokens[v]) || v;
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
  /** The CSS the app puts on an element for a style (client/src/lib/menu-style.ts). */
  function styleProps(style, catalog) {
    const tokens = (catalog && catalog.colorTokens) || {};
    const stacks = (catalog && catalog.fontStacks) || {};
    const css = {};
    const classes = [];
    if (!style) return { css, classes };
    const col = (v) => cssColor(v, tokens);
    if (style.color) css.color = col(style.color);
    if (style.background) css.background = col(style.background);
    if (style.iconColor) { css["--mb-icon"] = col(style.iconColor); classes.push("mb-ic"); }
    if (style.borderColor) css["border-color"] = col(style.borderColor);
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
    if (style.fontFamily && style.fontFamily !== "inherit") css["font-family"] = stacks[style.fontFamily] || "inherit";
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
    const props = [["color", "color", col], ["background", "bg", col], ["iconColor", "icon", col], ["borderColor", "border", col], ["fontWeight", "weight", (v) => v], ["underline", "underline", (v) => (v ? "underline" : "none")], ["opacity", "opacity", String], ["scale", "scale", String], ["shadow", "shadow", (v) => SHADOW_CSS[v] || "none"]];
    for (const state of Object.keys(STATE_LABELS)) {
      const st = style.states && style.states[state];
      if (!st) continue;
      for (const [key, slug, toCss] of props) {
        if (st[key] === undefined) continue;
        css[`--mb-${state}-${slug}`] = toCss(st[key]);
        classes.push(`mb-${state}-${slug}`);
      }
    }
    return { css, classes };
  }

  /* --------------------------------------------------------- icon picker */

  function openIconPicker({ icons, current, optional, onPick, noneLabel = "none" }) {
    const names = Object.keys(icons || {});
    const search = h("input", { class: "input", type: "search", placeholder: `Search ${names.length} icons…`, "aria-label": "Search icons", "data-read": "1" });
    const gridBox = h("div", { class: "mb-icongrid", role: "listbox", "aria-label": "Icons" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const pick = (name) => { close(); onPick(name); };
    const draw = () => {
      clear(gridBox);
      const q = search.value.trim().toLowerCase();
      if (optional) gridBox.append(h("button", { type: "button", class: `mb-iconpick${!current ? " is-on" : ""}`, "data-read": "1", onclick: () => pick(undefined) }, h("span", { class: "mb-iconpick__none" }, "∅"), h("span", {}, noneLabel)));
      for (const name of names) {
        if (q && !name.includes(q)) continue;
        gridBox.append(h("button", { type: "button", role: "option", "aria-selected": name === current ? "true" : "false", class: `mb-iconpick${name === current ? " is-on" : ""}`, title: name, "data-icon": name, "data-read": "1", onclick: () => pick(name) }, iconSvg(icons, name), h("span", {}, name)));
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

  /**
   * 4.13: a modal dialog (Esc or a click outside closes it). `body` is a node
   * or a list of nodes; returns { close, dialog, body }.
   */
  function openDialog({ title, subtitle = "", body, wide = false, label, onClose }) {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); if (onClose) onClose(); };
    const content = h("div", { class: "mb-dialog__body" }, body || null);
    const dialog = h("div", { class: `mb-dialog${wide ? " mb-dialog--wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": label || title },
      h("div", { class: "mb-dialog__head" }, h("strong", {}, title), subtitle ? h("span", { class: "muted small" }, subtitle) : null,
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => close() }, "Close")),
      content);
    const overlay = h("div", { class: "mb-overlay", onclick: (e) => { if (e.target === overlay) close(); } }, dialog);
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    return { close, dialog, body: content };
  }

  /* --------------------------------------------------------- help window */

  const helpWindows = new Map();
  /**
   * A floating, movable help window with tabs of entries; clicking an entry
   * inserts its code into the field it was opened for (or copies it).
   * tabs: [{ id, label, rows: () => [{ code, text, type?, block? }] }]
   */
  function openHelp({ id, domId, title, subtitle = "click to insert", tabs, target, icons }) {
    let state = helpWindows.get(id);
    if (state && document.body.contains(state.win)) {
      state.target = target || null;
      state.tabs = tabs;
      state.win.hidden = false;
      state.draw();
      state.updateTarget();
      $("input", state.win).focus();
      return;
    }
    state = { target: target || null, tabs, current: tabs[0] && tabs[0].id };
    helpWindows.set(id, state);
    const body = h("div", { class: "mb-help__body" });
    const filter = h("input", { class: "input", type: "search", placeholder: "Filter…", "aria-label": "Filter the help", "data-read": "1" });
    const tabBar = h("div", { class: "mb-tabs", role: "tablist" });
    const targetInfo = h("div", { class: "mb-help__target muted small" });
    const entry = (row) => {
      const btn = h("button", { type: "button", class: `mb-help__row${row.block ? " is-block" : ""}`, "data-read": "1", "data-search": `${row.code} ${row.text} ${row.type || ""}`.toLowerCase(), title: "Insert" },
        h("code", {}, row.code), h("span", { class: "mb-help__desc" }, row.text, row.type ? h("span", { class: "badge" }, row.type) : null));
      btn.addEventListener("click", () => {
        if (state.target && document.body.contains(state.target) && !state.target.disabled) insertAt(state.target, row.insert ?? row.code);
        else if (navigator.clipboard) navigator.clipboard.writeText(row.insert ?? row.code).then(() => toast("Copied.", "ok"), () => toast(row.code));
        else toast(row.code);
      });
      return btn;
    };
    state.draw = () => {
      clear(tabBar);
      for (const tab of state.tabs) {
        const b = h("button", { type: "button", role: "tab", class: `mb-tab${tab.id === state.current ? " is-on" : ""}`, "data-read": "1", "data-help-tab": tab.id }, tab.label);
        b.addEventListener("click", () => { state.current = tab.id; state.draw(); });
        tabBar.append(b);
      }
      clear(body);
      const q = filter.value.trim().toLowerCase();
      const tab = state.tabs.find((x) => x.id === state.current) || state.tabs[0];
      const rows = tab ? tab.rows().map(entry).filter((row) => !q || row.dataset.search.includes(q)) : [];
      body.append(...(rows.length ? rows : [h("p", { class: "muted small" }, "Nothing matches.")]));
    };
    state.updateTarget = () => {
      targetInfo.textContent = state.target && document.body.contains(state.target) ? "Inserts into the field you are editing." : "Copies to the clipboard (open the help from a field to insert).";
    };
    filter.addEventListener("input", () => state.draw());
    const win = h("div", { class: "mb-help", role: "dialog", "aria-label": title, "data-help": id, id: domId || undefined });
    const header = h("div", { class: "mb-help__head" },
      iconSvg(icons, "circle-question-mark"), h("strong", {}, title), h("span", { class: "muted small" }, subtitle),
      h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "aria-label": "Close the help", onclick: () => { win.hidden = true; } }, "×"));
    win.append(header, h("div", { class: "mb-help__tools" }, tabBar, filter), targetInfo, body);
    state.win = win;
    document.body.append(win);
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
    state.draw();
    state.updateTarget();
    filter.focus();
  }

  /* ------------------------------------------------------------ type-ahead */

  /**
   * An input (or textarea) that suggests while typing. `items()` gives the
   * suggestions: strings, or { value, label?, hint? }. With `token`, only the
   * part before the caret that matches it is completed (a class among
   * classes, a $variable inside an expression).
   */
  function suggestInput({ value = "", items, token, area, rows = 3, placeholder = "", mono = false, prop, max = 2000, onInput, onPick, className = "" }) {
    const input = h(area ? "textarea" : "input", {
      class: `input${mono ? " mono" : ""} ${className}`.trim(), type: area ? undefined : "text", rows: area ? String(rows) : undefined, placeholder,
      maxlength: String(max), spellcheck: "false", autocomplete: "off", "data-prop": prop || undefined, role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false",
    });
    input.value = value;
    const list = h("ul", { class: "sg-list", role: "listbox", hidden: true });
    const wrap = h("span", { class: `sg${area ? " sg--area" : ""}` }, input, list);
    let shown = [];
    let active = -1;
    let range = [0, 0];
    const current = () => {
      const caret = input.selectionStart ?? input.value.length;
      if (!token) { range = [0, input.value.length]; return input.value; }
      const before = input.value.slice(0, caret);
      const m = before.match(token);
      const word = m ? m[0] : "";
      range = [caret - word.length, caret];
      return word;
    };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); shown = []; active = -1; };
    const open = () => {
      const q = current().toLowerCase();
      const all = (items() || []).map((it) => (typeof it === "string" ? { value: it } : it));
      const starts = [];
      const contains = [];
      for (const it of all) {
        const v = String(it.value).toLowerCase();
        if (!q || v.startsWith(q)) starts.push(it);
        else if (v.includes(q) || (it.label && it.label.toLowerCase().includes(q))) contains.push(it);
        if (starts.length > 60) break;
      }
      shown = [...starts, ...contains].slice(0, 60);
      // Nothing to offer when the only suggestion is exactly what is typed.
      if (shown.length === 1 && String(shown[0].value).toLowerCase() === q && !onPick) shown = [];
      clear(list);
      if (!shown.length || input.disabled) { close(); return; }
      shown.forEach((it, i) => {
        const li = h("li", { role: "option", class: `sg-item${i === active ? " is-on" : ""}`, "data-value": String(it.value) },
          h("span", { class: "sg-value" }, String(it.value)), it.hint || it.label ? h("span", { class: "sg-hint" }, it.hint || it.label) : null);
        li.addEventListener("mousedown", (e) => { e.preventDefault(); accept(i); });
        list.append(li);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const accept = (i) => {
      const it = shown[i];
      if (!it) return;
      current();
      const v = String(it.value);
      input.value = input.value.slice(0, range[0]) + v + input.value.slice(range[1]);
      const caret = range[0] + v.length;
      input.selectionStart = input.selectionEnd = caret;
      close();
      onInput?.(input.value);
      onPick?.(v);
      input.focus();
    };
    const mark = () => { $$(".sg-item", list).forEach((li, i) => li.classList.toggle("is-on", i === active)); const on = $(".sg-item.is-on", list); if (on) on.scrollIntoView({ block: "nearest" }); };
    input.addEventListener("input", () => { active = -1; onInput?.(input.value); open(); });
    input.addEventListener("focus", () => { if (!token || !input.value) open(); });
    input.addEventListener("click", () => open());
    input.addEventListener("blur", () => window.setTimeout(close, 120));
    input.addEventListener("keydown", (e) => {
      if (list.hidden) { if (e.key === "ArrowDown" && !area) { open(); e.preventDefault(); } return; }
      if (e.key === "ArrowDown") { active = Math.min(shown.length - 1, active + 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
      else if ((e.key === "Enter" || e.key === "Tab") && active >= 0) { accept(active); e.preventDefault(); }
      else if (e.key === "Enter" && (shown.length === 1 || String(shown[0]?.value ?? "").toLowerCase() === current().toLowerCase())) { accept(0); e.preventDefault(); }
      else if (e.key === "Escape") { close(); e.stopPropagation(); }
    });
    wrap.input = input;
    return wrap;
  }

  /* ----------------------------------------------------------- fields kit */

  /**
   * Field builders bound to a builder: ctx.edit(change, opts) applies an
   * undoable edit, ctx.readOnly() says whether it can change anything,
   * ctx.catalog() gives the style lists (fonts, colours…), ctx.icons() the
   * icon catalog, ctx.previewColor(v) the swatch colour of a token.
   */
  function create(ctx) {
    const edit = (change, opts) => ctx.edit(change, opts);
    const cat = () => ctx.catalog() || {};
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
        if (ok) edit(() => onChange(input.value), { props: Boolean(opts.rerender) });
      });
      return field(label, input, opts.hint, opts.wide);
    }
    /** A text field that suggests while typing (see suggestInput). */
    function suggestField(label, value, onChange, opts = {}) {
      const box = suggestInput({
        value: value || "", items: opts.items, token: opts.token, area: opts.area, rows: opts.rows, placeholder: opts.placeholder, mono: opts.mono !== false, prop: opts.prop, max: opts.max,
        onInput: (v) => {
          const ok = opts.valid ? opts.valid(v) : true;
          box.input.classList.toggle("is-invalid", !ok);
          if (ok) edit(() => onChange(v), { props: Boolean(opts.rerender) });
        },
      });
      return field(label, box, opts.hint, opts.wide);
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
      const tokens = cat().colors || [];
      const hex = typeof value === "string" && value.startsWith("#");
      const sel = h("select", { class: "input", "data-prop": opts.prop || undefined },
        h("option", { value: "" }, "—"),
        h("optgroup", { label: "The template's colours" }, tokens.map((t) => h("option", { value: t, selected: value === t || undefined }, t))),
        h("option", { value: "#", selected: hex || undefined }, "Custom colour…"));
      const pick = h("input", { type: "color", class: "mb-color", title: "Pick a colour", "data-prop": opts.prop ? `${opts.prop}-pick` : undefined });
      pick.value = hex && /^#[0-9a-f]{6}$/i.test(value) ? value : "#3366ff";
      pick.hidden = !hex;
      const swatch = h("span", { class: "mb-swatch", "aria-hidden": "true" });
      const paint = (v) => { swatch.style.background = v ? (ctx.previewColor ? ctx.previewColor(v) : v) : "transparent"; swatch.classList.toggle("is-empty", !v); };
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
        value ? iconSvg(ctx.icons(), value) : null, h("span", {}, value || opts.none || "— none —"));
      btn.addEventListener("click", () => openIconPicker({ icons: ctx.icons(), current: value, optional: opts.optional, noneLabel: opts.none || "none", onPick: (name) => edit(() => onChange(name), { props: true }) }));
      if (ctx.readOnly()) btn.disabled = true;
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
      const c = cat();
      const count = Object.keys(s).filter((k) => k !== "states").length + Object.keys(s.states || {}).length;
      const opts2 = (list) => (list || []).map((v) => [v, v]);
      const details = h("details", { class: "mb-style", open: opts.open || undefined },
        h("summary", {}, title, count ? h("span", { class: "badge badge--accent" }, `${count} set`) : h("span", { class: "muted small" }, "the template's own look")));
      details.append(
        group("Text",
          selectField("Font", s.fontFamily, opts2(c.fonts), (v) => put("fontFamily", v), { prop: "style-fontFamily" }),
          numberField("Size (px)", s.fontSize, 8, 40, 1, (v) => put("fontSize", v), { prop: "style-fontSize" }),
          selectField("Weight", s.fontWeight, opts2(c.fontWeights), (v) => put("fontWeight", v), { prop: "style-fontWeight" }),
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
          selectField("Alignment", s.align, opts2(c.aligns), (v) => put("align", v), { prop: "style-align" }),
          selectField("Wrapping", s.wrap, [["wrap", "wrap"], ["nowrap", "one line"], ["ellipsis", "one line with …"]], (v) => put("wrap", v), { prop: "style-wrap" }),
          numberField("Padding ↔ (px)", s.paddingX, 0, 48, 1, (v) => put("paddingX", v), { prop: "style-paddingX" }),
          numberField("Padding ↕ (px)", s.paddingY, 0, 48, 1, (v) => put("paddingY", v), { prop: "style-paddingY" }),
          numberField("Gap (px)", s.gap, 0, 32, 1, (v) => put("gap", v), { prop: "style-gap" }),
          numberField("Min. height (px)", s.minHeight, 0, 120, 1, (v) => put("minHeight", v), { prop: "style-minHeight" }),
          numberField("Corner radius (px)", s.radius, 0, 64, 1, (v) => put("radius", v), { prop: "style-radius" })),
        group("Icon",
          numberField("Icon size (px)", s.iconSize, 8, 48, 1, (v) => put("iconSize", v), { prop: "style-iconSize" }),
          selectField("Icon position", s.iconPosition, opts2(c.iconPositions), (v) => put("iconPosition", v), { prop: "style-iconPosition" })),
        group("Border & effects",
          numberField("Border width (px)", s.borderWidth, 0, 8, 1, (v) => put("borderWidth", v), { prop: "style-borderWidth" }),
          selectField("Border style", s.borderStyle, opts2(c.borders), (v) => put("borderStyle", v), { prop: "style-borderStyle" }),
          numberField("Opacity (0–1)", s.opacity, 0, 1, 0.05, (v) => put("opacity", v), { prop: "style-opacity" }),
          numberField("Scale (0.8–1.2)", s.scale, 0.8, 1.2, 0.01, (v) => put("scale", v), { prop: "style-scale" }),
          selectField("Shadow", s.shadow, opts2(c.shadows), (v) => put("shadow", v), { prop: "style-shadow" })),
      );
      if (opts.states !== false) details.append(stateTabs(s, putState, opts.onStateTab ?? ctx.onStateTab));
      if (!ctx.readOnly()) {
        details.append(h("div", { class: "mb-style__foot" },
          h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => edit(() => set(undefined), { props: true }) }, "Clear this style")));
      }
      return details;
    }
    function stateTabs(s, putState, onStateTab) {
      const box = h("fieldset", { class: "mb-fs mb-states" }, h("legend", {}, "States"));
      const tabs = h("div", { class: "mb-tabs", role: "tablist" });
      const panes = h("div", {});
      const keys = cat().states || Object.keys(STATE_LABELS);
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
            selectField("Weight", one.fontWeight, (cat().fontWeights || []).map((v) => [v, v]), (v) => putState(state, "fontWeight", v), { prop: `state-${state}-fontWeight` }),
            triField("Underline", one.underline, (v) => putState(state, "underline", v), { prop: `state-${state}-underline` }),
            numberField("Opacity", one.opacity, 0, 1, 0.05, (v) => putState(state, "opacity", v), { prop: `state-${state}-opacity` }),
            numberField("Scale", one.scale, 0.8, 1.2, 0.01, (v) => putState(state, "scale", v), { prop: `state-${state}-scale` }),
            selectField("Shadow", one.shadow, (cat().shadows || []).map((v) => [v, v]), (v) => putState(state, "shadow", v), { prop: `state-${state}-shadow` })));
        tab.addEventListener("click", () => {
          for (const t of $$(".mb-tab", tabs)) { t.classList.toggle("is-on", t === tab); t.setAttribute("aria-selected", t === tab ? "true" : "false"); }
          for (const p of $$("[data-state-pane]", panes)) p.hidden = p !== pane;
          onStateTab?.(state);
        });
        tabs.append(tab);
        panes.append(pane);
      });
      box.append(h("p", { class: "muted small" }, "Hover and click apply as the pointer does it, keyboard focus when tabbing, current for the open panel or a switch that is on."), tabs, panes);
      return box;
    }

    return { field, textField, suggestField, selectField, checkField, triField, numberField, colorField, iconField, grid, group, styleEditor };
  }

  window.M5Kit = { create, iconSvg, insertAt, openIconPicker, openHelp, openDialog, suggestInput, styleProps, mergeStyles, cssColor, STATE_LABELS, SHADOW_CSS };
})();
