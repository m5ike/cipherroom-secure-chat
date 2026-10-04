// M5cet operator console — function outputs and the tools that make them (5.3).
//
//   render(o, ctx)      the 5.3 outputs in a console run: sound and video,
//                       buttons and forms that call the model's (or the
//                       draft's) entry points, browser code in a sandbox
//   formBuilder(opts)   the form builder: panels, rows or columns, labels
//                       above or beside, every field type, options with icons;
//                       a live preview and the code (JavaScript or Python)
//   buttonBuilder(opts) a button: title, name, data, classes, colours, icon
//   browserJsTool(opts) browser JavaScript for m5.out.js, from templates
//   codeFor(kind, spec, lang)  m5.out.form({…}) / m5.out.button({…}) as code
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast } = C;
  const Kit = () => window.M5Kit;

  const FIELD_TYPES = ["text", "textarea", "number", "range", "tel", "email", "url", "password", "date", "time", "datetime", "month", "color", "masked", "select", "multiselect", "radio", "checkbox", "switch", "hidden", "static", "separator"];
  const BUTTON_CLASSES = ["primary", "secondary", "success", "danger", "warning", "info", "ghost", "outline", "link", "small", "large", "block", "round"];
  const WITH_OPTIONS = new Set(["select", "multiselect", "radio"]);

  /* ================================================================ code */

  /** A value as a Python literal (JSON with True / False / None). */
  function pyLit(v, indent = 0) {
    const pad = " ".repeat(indent);
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad}    ${pyLit(x, indent + 4)}`).join(",\n")},\n${pad}]` : "[]";
    const keys = Object.keys(v);
    return keys.length ? `{\n${keys.map((k) => `${pad}    ${JSON.stringify(k)}: ${pyLit(v[k], indent + 4)}`).join(",\n")},\n${pad}}` : "{}";
  }
  /** A value as a JavaScript literal (keys unquoted where they can be). */
  function jsLit(v, indent = 0) {
    const pad = " ".repeat(indent);
    if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad}  ${jsLit(x, indent + 2)}`).join(",\n")},\n${pad}]` : "[]";
    const keys = Object.keys(v);
    return keys.length ? `{\n${keys.map((k) => `${pad}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${jsLit(v[k], indent + 2)}`).join(",\n")},\n${pad}}` : "{}";
  }
  /** The output as code, with the entry point that answers it. */
  function codeFor(kind, spec, lang = "js") {
    const py = lang === "py";
    if (kind === "form") {
      const call = py ? `m5.out.form(${pyLit(spec)})` : `m5.out.form(${jsLit(spec)})`;
      const handler = py
        ? `\n\n# The form entry point (Models › Entry points: form → index.py#form):\nasync def form(name, values, event=None, **inputs):\n    if name == ${JSON.stringify(spec.name || "form")}:\n        return m5.out.markdown("Thank you — " + ", ".join(f"{k}: {v}" for k, v in values.items()))`
        : `\n\n// The form entry point (Models › Entry points: form → index.js#form):\nexport async function form({ name, values, event }) {\n  if (name === ${JSON.stringify(spec.name || "form")}) {\n    return m5.out.markdown("Thank you — " + Object.entries(values).map(([k, v]) => \`\${k}: \${v}\`).join(", "));\n  }\n}`;
      return `return ${call}${py ? "" : ";"}${handler}`;
    }
    if (kind === "button") {
      const call = py ? `m5.out.button(${pyLit(spec)})` : `m5.out.button(${jsLit(spec)})`;
      const handler = py
        ? `\n\n# The button entry point (button → index.py#button):\nasync def button(name, data=None, event=None, **inputs):\n    if name == ${JSON.stringify(spec.name || "button")}:\n        return [m5.out.flash("Clicked", "success"), m5.out.json(data)]`
        : `\n\n// The button entry point (button → index.js#button):\nexport async function button({ name, data, event }) {\n  if (name === ${JSON.stringify(spec.name || "button")}) {\n    return [m5.out.flash("Clicked", "success"), m5.out.json(data)];\n  }\n}`;
      return `${call}${handler}`;
    }
    if (kind === "js") {
      const opts = {};
      if (spec.title) opts.title = spec.title;
      if (spec.height) opts.height = Number(spec.height);
      if (spec.hidden) opts.hidden = true;
      const args = spec.args === undefined ? null : spec.args;
      return py
        ? `m5.out.js(${JSON.stringify(spec.code || "")}, ${pyLit(args)}${Object.keys(opts).map((k) => `, ${k}=${pyLit(opts[k])}`).join("")})`
        : `m5.out.js(${JSON.stringify(spec.code || "")}, ${jsLit(args)}${Object.keys(opts).length ? `, ${jsLit(opts)}` : ""})`;
    }
    return "";
  }

  /* ================================================================ render */

  const b64ToBlobUrl = (data, mime) => {
    const bin = atob(data); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: mime }));
  };

  /**
   * ctx: { chain, call } of the run (filled in when it ends), and follow(runId)
   * — how the console shows the run a click / form starts. Returns a node, or
   * null for a type this module does not draw.
   */
  function render(o, ctx) {
    switch (o.type) {
      case "audio": case "video": {
        const el = h(o.type, { controls: true, class: `fn-${o.type}`, preload: "metadata" });
        el.src = b64ToBlobUrl(o.data, o.mime);
        if (o.loop) el.loop = true;
        return h("div", { class: "fn-media" }, o.title ? h("div", { class: "muted small" }, o.title) : null, el, o.autoplay ? h("span", { class: "badge" }, "autoplay") : null);
      }
      case "button": return buttonsRow([o], ctx);
      case "form": return consoleForm(o, ctx, false);
      case "js": return jsBlock(o, ctx);
      case "html": return htmlBlock(o);
      default: return null;
    }
  }

  /**
   * 6.6: formatted HTML (m5.out.html) — the chat's own sanitizer (window.M5Html,
   * fn-html.ts) gives a safe tree; it is built as DOM nodes, styles through the
   * CSSOM (never an attribute string or innerHTML), links open outside.
   */
  const HTML_VOID = new Set(["br", "hr", "img", "col", "wbr"]);
  function htmlNodes(list) {
    const out = [];
    for (const n of list) {
      if (typeof n === "string") { out.push(document.createTextNode(n)); continue; }
      const el = document.createElement(n.t);
      for (const [k, v] of Object.entries(n.a)) {
        if (k === "style") { for (const decl of v.split(";")) { const i = decl.indexOf(":"); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }
        else el.setAttribute(k, v);
      }
      if (n.t === "a") { el.target = "_blank"; el.rel = "noopener noreferrer nofollow"; }
      if (n.t === "img") el.loading = "lazy";
      if (!HTML_VOID.has(n.t)) el.append(...htmlNodes(n.c));
      out.push(el);
    }
    return out;
  }
  function htmlBlock(o) {
    const box = h("div", { class: "fn-html" });
    if (o.title) box.append(h("div", { class: "fn-html__title" }, o.title));
    const body = h("div", { class: "fn-html__body" });
    if (window.M5Html) body.append(...htmlNodes(window.M5Html.parse(String(o.html || ""))));
    else body.append(h("pre", { class: "fn-code" }, String(o.html || "")));
    box.append(body);
    return box;
  }

  const reachable = (ctx) => Boolean(ctx && ctx.chain);
  async function sendEvent(ctx, body) {
    if (!reachable(ctx)) { toast("The run has not finished yet — its processing session is not known.", "err"); return false; }
    try {
      const r = await api("/admin/functions/event", { method: "POST", body: { chain: ctx.chain, call: ctx.call, live: true, ...body } });
      if (r.runId && ctx.follow) ctx.follow(r.runId);
      else if (r.outputs && ctx.show) ctx.show(r.outputs);
      return true;
    } catch (e) { toast(e.message, "err"); return false; }
  }

  function buttonNode(o, ctx) {
    const cls = ["btn", "btn--sm", ...(o.css || "").split(" ").filter(Boolean).map((c) => (c === "primary" ? "btn--primary" : c === "danger" ? "btn--danger" : `fn-bcls-${c}`))].join(" ");
    const b = h("button", { class: cls, type: "button", title: o.confirm ? `Asks first: ${o.confirm}` : `button entry point · name "${o.name}"${o.data !== undefined ? ` · data ${JSON.stringify(o.data)}` : ""}` }, o.icon ? `${o.icon} ` : "", o.title);
    if (o.style) { if (o.style.color) b.style.color = o.style.color; if (o.style.background) b.style.background = o.style.background; if (o.style.border) b.style.borderColor = o.style.border; }
    if (o.disabled) b.disabled = true;
    b.addEventListener("click", async () => {
      if (o.confirm && !window.confirm(o.confirm)) return;
      b.disabled = true;
      const ok = await sendEvent(ctx, { type: "button", name: o.name, data: o.data === undefined ? null : o.data });
      b.disabled = Boolean(ok && o.once) || Boolean(o.disabled);
    });
    return b;
  }
  function buttonsRow(list, ctx) { return h("div", { class: "fn-row fn-brow" }, ...list.map((o) => buttonNode(o, ctx))); }

  /** A form as the console draws it (preview: no submitting). */
  function consoleForm(o, ctx, preview) {
    const form = h("form", { class: "fn-cform", novalidate: true });
    const getters = {};
    if (o.title) form.append(h("strong", {}, o.title));
    if (o.text) form.append(h("p", { class: "muted small" }, o.text));
    const fieldNode = (f, panel) => {
      const labels = f.labels || (panel && panel.labels) || o.labels || "top";
      if (f.type === "separator") return h("hr", { class: "fn-cform__sep" });
      if (f.type === "static") return h("div", { class: "fn-cform__static muted small", style: f.span ? `grid-column: span ${f.span}` : "" }, f.text || f.label || "");
      if (f.type === "hidden") { getters[f.name] = () => f.default ?? ""; return null; }
      let input;
      const opts = f.options || [];
      if (f.type === "select") { input = h("select", { class: "input input--sm" }); input.append(h("option", { value: "" }, f.placeholder || "—")); for (const op of opts) input.append(h("option", { value: op.value, selected: String(f.default) === op.value || null }, `${op.icon ? op.icon + " " : ""}${op.label}`)); getters[f.name] = () => input.value; }
      else if (f.type === "multiselect" || f.type === "radio") {
        input = h("div", { class: "fn-cform__opts" });
        const boxes = opts.map((op) => { const c = h("input", { type: f.type === "radio" ? "radio" : "checkbox", name: `${o.name}.${f.name}`, value: op.value, checked: (Array.isArray(f.default) ? f.default.map(String).includes(op.value) : String(f.default) === op.value) || null }); input.append(h("label", { class: "fn-cform__opt" }, c, ` ${op.icon ? op.icon + " " : ""}${op.label}`)); return c; });
        getters[f.name] = () => (f.type === "radio" ? (boxes.find((c) => c.checked) || {}).value || "" : boxes.filter((c) => c.checked).map((c) => c.value));
      } else if (f.type === "checkbox" || f.type === "switch") { input = h("input", { type: "checkbox", checked: f.default === true || null }); getters[f.name] = () => input.checked; }
      else if (f.type === "textarea") { input = h("textarea", { class: "input input--sm", rows: f.rows || 3, placeholder: f.placeholder || "" }, f.default == null ? "" : String(f.default)); getters[f.name] = () => input.value; }
      else {
        const type = { number: "number", range: "range", tel: "tel", email: "email", url: "url", password: "password", date: "date", time: "time", datetime: "datetime-local", month: "month", color: "color" }[f.type] || "text";
        input = h("input", { class: "input input--sm", type, placeholder: f.placeholder || (f.type === "masked" && f.mask ? f.mask : ""), value: f.default == null ? "" : String(f.default) });
        if (f.min !== undefined) input.min = f.min; if (f.max !== undefined) input.max = f.max; if (f.step !== undefined) input.step = f.step;
        getters[f.name] = () => (type === "number" || type === "range" ? (input.value === "" ? "" : Number(input.value)) : input.value);
      }
      if (preview || f.readonly) input.disabled = true;
      return h("label", { class: `fn-cform__field fn-cform__field--${labels}`, style: f.span ? `grid-column: span ${f.span}` : "" },
        h("span", { class: "small" }, (f.label || f.name) + (f.required ? " *" : ""), h("span", { class: "muted" }, ` · ${f.type}`)), input, f.help ? h("span", { class: "muted small" }, f.help) : null);
    };
    const grid = (fields, panel, cols) => { const g = h("div", { class: "fn-cform__grid", style: `grid-template-columns: repeat(${cols || 1}, minmax(0, 1fr))` }); for (const f of fields || []) { const n = fieldNode(f, panel); if (n) g.append(n); } return g; };
    if (o.fields && o.fields.length) form.append(grid(o.fields, null, o.columns || 1));
    for (const p of o.panels || []) {
      const fs = h("fieldset", { class: "fn-cform__panel" }, p.title ? h("legend", {}, p.title + (p.collapsed ? " (collapsed)" : "")) : null, p.text ? h("p", { class: "muted small" }, p.text) : null);
      fs.append(grid(p.fields, p, p.layout === "columns" ? p.columns || 2 : p.columns || 1));
      form.append(fs);
    }
    const submit = h("button", { class: "btn btn--primary btn--sm", type: "submit", disabled: preview || null }, o.submit || "Send");
    form.append(h("div", { class: "fn-row" }, submit, h("span", { class: "muted small" }, `form entry point · name "${o.name}"`)));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (preview) return;
      const values = {};
      for (const [k, g] of Object.entries(getters)) values[k] = g();
      submit.disabled = true;
      const ok = await sendEvent(ctx, { type: "form", name: o.name, values });
      submit.disabled = Boolean(ok && o.once);
    });
    return h("div", { class: "fn-out__form" }, form);
  }

  /** Browser code: shown as code; "Run in a sandbox" runs it here the way the app does. */
  function jsBlock(o, ctx) {
    const box = h("div", { class: "fn-jsbox" });
    box.append(h("div", { class: "fn-row" }, h("span", { class: "badge badge--accent" }, o.hidden ? "browser code (hidden)" : "browser code"), o.title ? h("strong", {}, o.title) : null, h("span", { class: "muted small" }, "runs in the viewer's browser, in a sandbox (no access to the app)")));
    box.append(h("pre", { class: "fn-code" }, h("code", {}, o.code)));
    if (o.args !== undefined) box.append(h("div", { class: "muted small" }, `args: ${JSON.stringify(o.args)}`));
    const runBtn = h("button", { class: "btn btn--xs", type: "button" }, "▶ Run in a sandbox");
    runBtn.addEventListener("click", () => { runBtn.remove(); box.append(sandboxFrame(o, ctx)); });
    box.append(runBtn);
    return box;
  }
  function sandboxFrame(o, ctx) {
    const frame = h("iframe", { class: "fn-jsframe", sandbox: "allow-scripts", src: "/fn-sandbox.html", title: o.title || "browser code" });
    frame.style.height = `${o.hidden ? 40 : o.height || 80}px`;
    const log = h("pre", { class: "fn-logs" });
    let started = false, budget = 200;
    const start = () => { if (started || !frame.contentWindow) return; started = true; frame.contentWindow.postMessage({ m5: "run", code: o.code, args: o.args ?? null, tone: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark", lang: "en" }, "*"); };
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data;
      if (!d || d.m5 !== true || --budget < 0) return;
      if (!document.body.contains(frame)) { window.removeEventListener("message", onMsg); return; }
      if (d.kind === "ready") start();
      else if (d.kind === "resize" && !o.height) frame.style.height = `${Math.max(20, Math.min(1200, Number(d.height) || 0))}px`;
      else if (d.kind === "flash") toast(String(d.text), d.level === "error" ? "err" : "ok");
      else if (d.kind === "send") void sendEvent(ctx, { type: "button", name: String(d.name), data: d.data ?? null, source: "js" });
      else if (d.kind === "submit") void sendEvent(ctx, { type: "form", name: String(d.name), values: d.values || {}, source: "js" });
      else if (d.kind === "log" || d.kind === "error") log.append(h("div", { class: `fn-log fn-log--${d.kind === "error" ? "error" : d.level || "info"}` }, h("span", { class: "fn-log__lvl" }, d.kind === "error" ? "error" : d.level || "info"), ` ${d.kind === "error" ? `${d.name || "Error"}: ${d.message}` : d.message}`));
    };
    window.addEventListener("message", onMsg);
    frame.addEventListener("load", () => setTimeout(start, 50));
    return h("div", { class: "stack" }, frame, log);
  }

  /* ============================================================ builders */

  const input = (value, attrs = {}) => h("input", { class: "input input--sm", value: value == null ? "" : String(value), ...attrs });
  const labelled = (label, node, hint) => h("label", { class: "field" }, h("span", { class: "label" }, label), node, hint ? h("span", { class: "muted small" }, hint) : null);
  const select = (value, values, onchange) => { const s = h("select", { class: "input input--sm" }); for (const v of values) { const [val, label] = Array.isArray(v) ? v : [v, v]; s.append(h("option", { value: val, selected: String(value ?? "") === String(val) || null }, label)); } s.addEventListener("change", () => onchange(s.value)); return s; };
  const clean = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length && k !== "fields")) out[k] = v; return out; };

  /** The form as spec: panels; one plain panel becomes `fields`. */
  function specOf(st) {
    const panels = st.panels.map((p) => clean({ title: p.title, text: p.text, layout: p.layout === "rows" ? undefined : p.layout, columns: p.columns > 1 ? Number(p.columns) : undefined, labels: p.labels || undefined, collapsed: p.collapsed || undefined, fields: p.fields.map(fieldSpec) }));
    const base = clean({ name: st.name || "form", title: st.title, text: st.text, submit: st.submit, labels: st.labels || undefined, once: st.once || undefined });
    if (panels.length === 1 && !panels[0].title && !panels[0].text && !panels[0].layout && !panels[0].labels && !panels[0].collapsed) return { ...base, ...(panels[0].columns ? { columns: panels[0].columns } : {}), fields: panels[0].fields };
    return { ...base, panels };
  }
  function fieldSpec(f) {
    const num = (v) => (v === "" || v === undefined || v === null || Number.isNaN(Number(v)) ? undefined : Number(v));
    let def = f.default;
    if (def !== undefined && def !== "") {
      if (f.type === "checkbox" || f.type === "switch") def = def === true || def === "true";
      else if (f.type === "number" || f.type === "range") def = num(def);
      else if (f.type === "multiselect") def = String(def).split(",").map((s) => s.trim()).filter(Boolean);
    } else def = undefined;
    return clean({
      name: f.type === "static" || f.type === "separator" ? f.name || undefined : f.name, type: f.type, label: f.label, placeholder: f.placeholder, default: def,
      required: f.required || undefined, help: f.help, min: num(f.min), max: num(f.max), step: num(f.step), pattern: f.pattern, mask: f.type === "masked" ? f.mask : undefined,
      rows: f.type === "textarea" ? num(f.rows) : undefined, span: num(f.span) > 1 ? num(f.span) : undefined, labels: f.labels || undefined, readonly: f.readonly || undefined,
      text: f.type === "static" ? f.text : undefined,
      options: WITH_OPTIONS.has(f.type) ? (f.options || []).filter((o) => o.value !== "").map((o) => clean({ value: o.value, label: o.label || o.value, icon: o.icon })) : undefined,
    });
  }
  /** The builder's state from a spec (a form's fields become one panel). */
  function stateOf(spec) {
    const s = spec || {};
    const field = (f) => ({ ...f, default: Array.isArray(f.default) ? f.default.join(", ") : f.default, options: (f.options || []).map((o) => (typeof o === "string" ? { value: o, label: o } : { ...o })) });
    const panels = s.panels && s.panels.length ? s.panels.map((p) => ({ layout: "rows", columns: 1, ...p, fields: (p.fields || []).map(field) })) : [{ layout: s.columns > 1 ? "columns" : "rows", columns: s.columns || 1, fields: (s.fields || []).map(field) }];
    return { name: s.name || "contact", title: s.title || "", text: s.text || "", submit: s.submit || "", labels: s.labels || "", once: Boolean(s.once), panels };
  }

  const FORM_EXAMPLE = {
    name: "contact", title: "Contact us", submit: "Send", labels: "top",
    panels: [
      { title: "You", layout: "columns", columns: 2, fields: [
        { name: "name", type: "text", label: "Name", required: true },
        { name: "email", type: "email", label: "E-mail", required: true },
        { name: "phone", type: "masked", label: "Phone", mask: "+{420} 000 000 000" },
        { name: "country", type: "select", label: "Country", options: [{ value: "cz", label: "Czechia", icon: "🇨🇿" }, { value: "sk", label: "Slovakia", icon: "🇸🇰" }, { value: "de", label: "Germany", icon: "🇩🇪" }], default: "cz" },
      ] },
      { title: "Message", fields: [
        { name: "topics", type: "multiselect", label: "Topics", options: [{ value: "sales", label: "Sales", icon: "💼" }, { value: "support", label: "Support", icon: "🛟" }] },
        { name: "text", type: "textarea", label: "Message", rows: 4 },
        { name: "news", type: "switch", label: "Send me news" },
      ] },
    ],
  };

  /**
   * The form builder. opts: { spec?, lang?: "js" | "py", onInsert?(code), onApply?(spec) }.
   * onInsert gets the code (m5.out.form + its entry point); onApply the spec itself (the visual builder).
   */
  function formBuilder(opts = {}) {
    const st = stateOf(opts.spec || FORM_EXAMPLE);
    let lang = opts.lang === "py" ? "py" : "js";
    let selected = { panel: 0, field: 0 };
    const left = h("div", { class: "fb-form__tree" });
    const props = h("div", { class: "fb-form__props" });
    const preview = h("div", { class: "fb-form__preview" });
    const codeBox = h("pre", { class: "fn-code fb-form__code" });
    const body = h("div", { class: "fb-form" },
      h("div", { class: "fb-form__col" }, h("div", { class: "muted small" }, "Form"), formProps(), h("div", { class: "muted small mt8" }, "Panels and fields"), left),
      h("div", { class: "fb-form__col" }, h("div", { class: "muted small" }, "Selected"), props),
      h("div", { class: "fb-form__col fb-form__col--wide" }, h("div", { class: "fn-row" }, h("span", { class: "muted small" }, "Preview"), h("span", { class: "fn-grow" }), select(lang, [["js", "JavaScript"], ["py", "Python"]], (v) => { lang = v; redraw(); })), preview, h("div", { class: "muted small mt8" }, "Code"), codeBox));
    const actions = h("div", { class: "fn-row mt8" },
      opts.onInsert ? h("button", { class: "btn btn--primary", type: "button", onclick: () => { opts.onInsert(codeFor("form", specOf(st), lang)); dlg.close(); } }, "Insert the code") : null,
      opts.onApply ? h("button", { class: "btn btn--primary", type: "button", onclick: () => { opts.onApply(specOf(st)); dlg.close(); } }, "Apply") : null,
      h("button", { class: "btn", type: "button", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(codeFor("form", specOf(st), lang)); toast("Code copied.", "ok"); } }, "Copy the code"),
      h("button", { class: "btn", type: "button", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(specOf(st), null, 2)); toast("JSON copied.", "ok"); } }, "Copy JSON"),
      h("span", { class: "fn-grow" }),
      h("span", { class: "muted small" }, "A submit calls the model's form entry point with { name, values }."));
    const dlg = Kit().openDialog({ title: "Form builder", subtitle: "m5.out.form — panels, rows or columns, labels above or beside, every field type", body: h("div", {}, body, actions), wide: true });

    function formProps() {
      const box = h("div", { class: "fb-form__formprops" });
      const bind = (key, node, get = (n) => n.value) => { node.addEventListener("input", () => { st[key] = get(node); redraw(false); }); node.addEventListener("change", () => { st[key] = get(node); redraw(false); }); return node; };
      box.append(
        labelled("Name (the entry point gets it)", bind("name", input(st.name, { placeholder: "contact" }))),
        labelled("Title", bind("title", input(st.title))),
        labelled("Text above", bind("text", input(st.text))),
        labelled("Submit button", bind("submit", input(st.submit, { placeholder: "Send" }))),
        labelled("Labels", select(st.labels, [["", "above (default)"], ["top", "above"], ["left", "beside"]], (v) => { st.labels = v; redraw(false); })),
        h("label", { class: "fn-switch" }, bind("once", h("input", { type: "checkbox", checked: st.once || null }), (n) => n.checked), " answered once (locks after sending)"));
      return box;
    }
    function drawTree() {
      clear(left);
      st.panels.forEach((p, pi) => {
        const card = h("div", { class: `fb-form__panel${selected.panel === pi && selected.field === -1 ? " is-on" : ""}` });
        card.append(h("div", { class: "fn-row" },
          h("button", { class: "btn btn--xs fn-grow", type: "button", onclick: () => { selected = { panel: pi, field: -1 }; redraw(); } }, `▣ ${p.title || `Panel ${pi + 1}`}`, h("span", { class: "muted small" }, ` · ${p.layout === "columns" ? `${p.columns || 2} columns` : "rows"}`)),
          h("button", { class: "btn btn--xs", type: "button", title: "Up", disabled: pi === 0 || null, onclick: () => { st.panels.splice(pi - 1, 0, st.panels.splice(pi, 1)[0]); selected = { panel: pi - 1, field: -1 }; redraw(); } }, "↑"),
          h("button", { class: "fn-file__x", type: "button", title: "Remove the panel", onclick: () => { if (st.panels.length > 1) { st.panels.splice(pi, 1); selected = { panel: 0, field: 0 }; redraw(); } } }, "×")));
        p.fields.forEach((f, fi) => {
          card.append(h("div", { class: `fb-form__field${selected.panel === pi && selected.field === fi ? " is-on" : ""}` },
            h("button", { class: "fb-form__fieldbtn", type: "button", onclick: () => { selected = { panel: pi, field: fi }; redraw(); } }, h("span", { class: "badge" }, f.type), ` ${f.label || f.name || "—"}`, f.required ? h("span", { class: "fb-form__req", title: "required" }, " *") : null),
            h("button", { class: "btn btn--xs", type: "button", title: "Up", disabled: fi === 0 || null, onclick: () => { p.fields.splice(fi - 1, 0, p.fields.splice(fi, 1)[0]); selected = { panel: pi, field: fi - 1 }; redraw(); } }, "↑"),
            h("button", { class: "btn btn--xs", type: "button", title: "Duplicate", onclick: () => { p.fields.splice(fi + 1, 0, { ...JSON.parse(JSON.stringify(f)), name: uniqueName(f.name || f.type) }); selected = { panel: pi, field: fi + 1 }; redraw(); } }, "⧉"),
            h("button", { class: "fn-file__x", type: "button", title: "Remove", onclick: () => { p.fields.splice(fi, 1); selected = { panel: pi, field: Math.min(fi, p.fields.length - 1) }; redraw(); } }, "×")));
        });
        const typeSel = select("text", FIELD_TYPES, () => undefined);
        card.append(h("div", { class: "fn-row mt8" }, typeSel, h("button", { class: "btn btn--xs", type: "button", onclick: () => { const t = typeSel.value; p.fields.push({ type: t, name: t === "separator" || t === "static" ? "" : uniqueName(t), label: t === "separator" ? "" : t[0].toUpperCase() + t.slice(1), options: WITH_OPTIONS.has(t) ? [{ value: "a", label: "Option A", icon: "" }, { value: "b", label: "Option B", icon: "" }] : [] }); selected = { panel: pi, field: p.fields.length - 1 }; redraw(); } }, "+ Field")));
        left.append(card);
      });
      left.append(h("button", { class: "btn btn--sm", type: "button", onclick: () => { st.panels.push({ title: `Panel ${st.panels.length + 1}`, layout: "rows", columns: 1, fields: [] }); selected = { panel: st.panels.length - 1, field: -1 }; redraw(); } }, "+ Panel"));
    }
    function uniqueName(base) {
      const used = new Set(st.panels.flatMap((p) => p.fields.map((f) => f.name)));
      const b = String(base).replace(/[^A-Za-z0-9_]/g, "_") || "field";
      let n = b, i = 2;
      while (used.has(n)) n = `${b}${i++}`;
      return n;
    }
    function drawProps() {
      clear(props);
      const p = st.panels[selected.panel];
      if (!p) return;
      if (selected.field === -1 || !p.fields[selected.field]) {
        const bindP = (key, node, get = (n) => n.value) => { node.addEventListener("input", () => { p[key] = get(node); redraw(false); }); node.addEventListener("change", () => { p[key] = get(node); redraw(); }); return node; };
        props.append(
          labelled("Panel title", bindP("title", input(p.title))),
          labelled("Text", bindP("text", input(p.text))),
          labelled("Layout", select(p.layout || "rows", [["rows", "rows — one field under another"], ["columns", "columns — side by side"]], (v) => { p.layout = v; if (v === "columns" && (p.columns || 1) < 2) p.columns = 2; redraw(); })),
          labelled("Columns", select(String(p.columns || 1), ["1", "2", "3", "4"], (v) => { p.columns = Number(v); redraw(); })),
          labelled("Labels", select(p.labels || "", [["", "as the form"], ["top", "above"], ["left", "beside"]], (v) => { p.labels = v; redraw(); })),
          h("label", { class: "fn-switch" }, bindP("collapsed", h("input", { type: "checkbox", checked: p.collapsed || null }), (n) => n.checked), " collapsed (opens on a click)"));
        return;
      }
      const f = p.fields[selected.field];
      const bindF = (key, node, get = (n) => n.value) => { node.addEventListener("input", () => { f[key] = get(node); redraw(false); }); node.addEventListener("change", () => { f[key] = get(node); redraw(false); }); return node; };
      // (append() would write a null as the text "null")
      props.append(...[
        labelled("Type", select(f.type, FIELD_TYPES, (v) => { f.type = v; if (WITH_OPTIONS.has(v) && !(f.options || []).length) f.options = [{ value: "a", label: "Option A" }]; redraw(); })),
        f.type === "separator" ? null : labelled("Name (key in values)", bindF("name", input(f.name, { placeholder: "email" }))),
        f.type === "separator" ? null : labelled(f.type === "static" ? "Label (optional)" : "Label", bindF("label", input(f.label))),
        f.type === "static" ? labelled("Text (Markdown)", bindF("text", h("textarea", { class: "input input--sm", rows: 4 }, f.text || ""))) : null].filter(Boolean));
      if (!["static", "separator", "hidden"].includes(f.type)) {
        props.append(
          labelled("Placeholder", bindF("placeholder", input(f.placeholder))),
          labelled("Default", bindF("default", input(f.default)), f.type === "multiselect" ? "values, comma-separated" : f.type === "checkbox" || f.type === "switch" ? "true / false" : ""),
          labelled("Help under the field", bindF("help", input(f.help))),
          h("div", { class: "fn-grid3" },
            h("label", { class: "fn-switch" }, bindF("required", h("input", { type: "checkbox", checked: f.required || null }), (n) => n.checked), " required"),
            h("label", { class: "fn-switch" }, bindF("readonly", h("input", { type: "checkbox", checked: f.readonly || null }), (n) => n.checked), " read-only"),
            labelled("Columns it takes", select(String(f.span || 1), ["1", "2", "3", "4"], (v) => { f.span = Number(v); redraw(false); }))),
          labelled("Label", select(f.labels || "", [["", "as the panel"], ["top", "above"], ["left", "beside"]], (v) => { f.labels = v; redraw(false); })));
      }
      if (f.type === "hidden") props.append(labelled("Value", bindF("default", input(f.default))));
      if (["number", "range"].includes(f.type)) props.append(h("div", { class: "fn-grid3" }, labelled("Min", bindF("min", input(f.min, { type: "number" }))), labelled("Max", bindF("max", input(f.max, { type: "number" }))), labelled("Step", bindF("step", input(f.step, { type: "number" })))));
      if (["text", "tel", "password", "url"].includes(f.type)) props.append(labelled("Pattern (regular expression)", bindF("pattern", input(f.pattern, { placeholder: "^[A-Z]{2}\\d+$" }))));
      if (f.type === "masked") props.append(labelled("Mask", bindF("mask", input(f.mask, { placeholder: "+{420} 000 000 000" })), "0 a digit · a a letter · * either · {fixed} or \\x as it is"));
      if (f.type === "textarea") props.append(labelled("Rows", bindF("rows", input(f.rows || 3, { type: "number", min: 1, max: 30 }))));
      if (WITH_OPTIONS.has(f.type)) {
        const list = h("div", { class: "fb-form__options" });
        const drawOpts = () => {
          clear(list);
          list.append(h("div", { class: "fb-form__optrow muted small" }, h("span", {}, "value"), h("span", {}, "label"), h("span", {}, "icon"), h("span", {})));
          (f.options || []).forEach((o, i) => {
            const set = (k) => (e) => { o[k] = e.target.value; redraw(false); };
            list.append(h("div", { class: "fb-form__optrow" },
              h("input", { class: "input input--sm fn-mono", value: o.value, oninput: set("value") }),
              h("input", { class: "input input--sm", value: o.label || "", oninput: set("label") }),
              h("input", { class: "input input--sm", value: o.icon || "", placeholder: "🙂", maxlength: 16, oninput: set("icon") }),
              h("button", { class: "fn-file__x", type: "button", onclick: () => { f.options.splice(i, 1); drawOpts(); redraw(false); } }, "×")));
          });
          list.append(h("button", { class: "btn btn--xs", type: "button", onclick: () => { f.options = [...(f.options || []), { value: `opt${(f.options || []).length + 1}`, label: `Option ${(f.options || []).length + 1}`, icon: "" }]; drawOpts(); redraw(false); } }, "+ Option"));
        };
        drawOpts();
        props.append(h("div", { class: "field" }, h("span", { class: "label" }, "Options (an icon: an emoji or a few characters)"), list));
      }
    }
    function redraw(all = true) {
      if (all) { drawTree(); drawProps(); }
      clear(preview);
      const spec = specOf(st);
      try { preview.append(consoleForm(spec, null, true)); } catch (e) { preview.append(h("div", { class: "fn-err" }, e.message)); }
      codeBox.textContent = codeFor("form", spec, lang);
    }
    redraw();
    return dlg;
  }

  /** A button. opts: { spec?, lang?, onInsert?(code), onApply?(spec) }. */
  function buttonBuilder(opts = {}) {
    const st = { name: "more", title: "Show more", icon: "➕", css: "primary", data: "{\n  \"page\": 2\n}", confirm: "", once: false, color: "", background: "", border: "", ...(opts.spec ? { ...opts.spec, data: opts.spec.data === undefined ? "" : JSON.stringify(opts.spec.data, null, 2), css: opts.spec.css || "", color: opts.spec.style?.color || "", background: opts.spec.style?.background || "", border: opts.spec.style?.border || "" } : {}) };
    let lang = opts.lang === "py" ? "py" : "js";
    const preview = h("div", { class: "fn-row" });
    const codeBox = h("pre", { class: "fn-code" });
    const problem = h("div", { class: "fn-err small" });
    const specOfB = () => {
      let data;
      if (String(st.data).trim()) { try { data = JSON.parse(st.data); problem.textContent = ""; } catch (e) { problem.textContent = `data is not JSON: ${e.message}`; } }
      const style = clean({ color: st.color, background: st.background, border: st.border });
      return clean({ name: st.name, title: st.title, icon: st.icon, css: st.css, data, confirm: st.confirm, once: st.once || undefined, style: Object.keys(style).length ? style : undefined });
    };
    const draw = () => { clear(preview); preview.append(buttonNode({ type: "button", ...specOfB(), disabled: true }, null)); codeBox.textContent = codeFor("button", specOfB(), lang); };
    const bind = (key, node, get = (n) => n.value) => { node.addEventListener("input", () => { st[key] = get(node); draw(); }); node.addEventListener("change", () => { st[key] = get(node); draw(); }); return node; };
    const chips = h("div", { class: "fn-groups" });
    for (const c of BUTTON_CLASSES) {
      const on = st.css.split(" ").includes(c);
      chips.append(h("label", { class: `fn-chip${on ? " fn-chip--on" : ""}` }, h("input", { type: "checkbox", checked: on || null, onchange: (e) => { const set = new Set(st.css.split(" ").filter(Boolean)); if (e.target.checked) set.add(c); else set.delete(c); st.css = [...set].join(" "); e.target.parentElement.classList.toggle("fn-chip--on", e.target.checked); draw(); } }), c));
    }
    const color = (key) => h("div", { class: "fn-row" }, bind(key, input(st[key], { placeholder: "#3563f0 or red" })), h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(st[key]) ? st[key] : "#3563f0", oninput: (e) => { st[key] = e.target.value; draw(); } }));
    const body = h("div", { class: "stack" },
      h("div", { class: "fn-grid3" }, labelled("Name (the entry point gets it)", bind("name", input(st.name))), labelled("Title", bind("title", input(st.title))), labelled("Icon (emoji)", bind("icon", input(st.icon, { maxlength: 16 })))),
      h("div", { class: "field" }, h("span", { class: "label" }, "Classes"), chips),
      h("div", { class: "fn-grid3" }, labelled("Text colour", color("color")), labelled("Background", color("background")), labelled("Border", color("border"))),
      labelled("Data (JSON — the entry point gets it as data)", bind("data", h("textarea", { class: "input input--sm fn-mono", rows: 4 }, st.data))),
      problem,
      h("div", { class: "fn-grid2" }, labelled("Ask first (confirm text)", bind("confirm", input(st.confirm, { placeholder: "Really delete?" }))), h("label", { class: "fn-switch" }, bind("once", h("input", { type: "checkbox", checked: st.once || null }), (n) => n.checked), " clickable once")),
      h("div", { class: "fn-row" }, h("span", { class: "muted small" }, "Preview"), h("span", { class: "fn-grow" }), select(lang, [["js", "JavaScript"], ["py", "Python"]], (v) => { lang = v; draw(); })), preview, codeBox,
      h("div", { class: "fn-row" },
        opts.onInsert ? h("button", { class: "btn btn--primary", type: "button", onclick: () => { opts.onInsert(codeFor("button", specOfB(), lang)); dlg.close(); } }, "Insert the code") : null,
        opts.onApply ? h("button", { class: "btn btn--primary", type: "button", onclick: () => { opts.onApply(specOfB()); dlg.close(); } }, "Apply") : null,
        h("button", { class: "btn", type: "button", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(codeFor("button", specOfB(), lang)); toast("Code copied.", "ok"); } }, "Copy the code")));
    const dlg = Kit().openDialog({ title: "Button", subtitle: "m5.out.button — a click calls the model's button entry point with { name, data, event }", body, wide: true });
    draw();
    return dlg;
  }

  const JS_TEMPLATES = [
    { id: "flash", title: "A notice", code: "m5.flash(\"Hello from the browser!\", \"success\");", args: null, hidden: true },
    { id: "sound", title: "A beep", code: "const ctx = new AudioContext();\nconst osc = ctx.createOscillator();\nosc.frequency.value = m5.args?.hz || 880;\nosc.connect(ctx.destination);\nosc.start();\nsetTimeout(() => osc.stop(), 300);", args: { hz: 880 }, hidden: true },
    { id: "widget", title: "A widget that calls the model", code: "const list = m5.args?.items || [];\nfor (const item of list) {\n  const b = document.createElement(\"button\");\n  b.textContent = item;\n  b.style.margin = \"2px\";\n  b.onclick = () => m5.send(\"pick\", { item });\n  m5.root.append(b);\n}", args: { items: ["one", "two", "three"] }, hidden: false },
    { id: "chart", title: "A small chart (canvas)", code: "const data = m5.args?.values || [3, 7, 2, 9, 4];\nconst c = document.createElement(\"canvas\");\nc.width = 320; c.height = 120;\nm5.root.append(c);\nconst g = c.getContext(\"2d\");\nconst max = Math.max(...data);\ndata.forEach((v, i) => { g.fillStyle = \"#4f7cff\"; g.fillRect(i * 60 + 10, 110 - v / max * 100, 40, v / max * 100); });", args: { values: [3, 7, 2, 9, 4] }, hidden: false },
    { id: "clock", title: "A live clock", code: "const el = document.createElement(\"div\");\nel.style.font = \"600 28px system-ui\";\nm5.root.append(el);\nconst tick = () => { el.textContent = new Date().toLocaleTimeString(m5.lang); };\ntick();\nsetInterval(tick, 1000);", args: null, hidden: false },
  ];

  /** Browser JavaScript for m5.out.js. opts: { lang?, onInsert?(code), onApply?(spec) }. */
  function browserJsTool(opts = {}) {
    const st = { code: JS_TEMPLATES[2].code, args: JSON.stringify(JS_TEMPLATES[2].args, null, 2), title: "", height: "", hidden: false, ...(opts.spec ? { ...opts.spec, args: opts.spec.args === undefined ? "" : JSON.stringify(opts.spec.args, null, 2) } : {}) };
    let lang = opts.lang === "py" ? "py" : "js";
    const code = h("textarea", { class: "input fn-mono", rows: 10, spellcheck: "false" }, st.code);
    const args = h("textarea", { class: "input input--sm fn-mono", rows: 3 }, st.args);
    const codeBox = h("pre", { class: "fn-code" });
    const problem = h("div", { class: "fn-err small" });
    const specOfJ = () => {
      let a;
      if (args.value.trim()) { try { a = JSON.parse(args.value); problem.textContent = ""; } catch (e) { problem.textContent = `args are not JSON: ${e.message}`; } }
      return clean({ code: code.value, args: a, title: st.title, height: st.height ? Number(st.height) : undefined, hidden: st.hidden || undefined });
    };
    const draw = () => { codeBox.textContent = `return ${codeFor("js", specOfJ(), lang)}${lang === "py" ? "" : ";"}`; };
    code.addEventListener("input", draw); args.addEventListener("input", draw);
    const tpl = h("div", { class: "fn-row" }, ...JS_TEMPLATES.map((t) => h("button", { class: "btn btn--xs", type: "button", onclick: () => { code.value = t.code; args.value = t.args === null ? "" : JSON.stringify(t.args, null, 2); st.hidden = t.hidden; hiddenBox.checked = t.hidden; draw(); } }, t.title)));
    const hiddenBox = h("input", { type: "checkbox", checked: st.hidden || null, onchange: (e) => { st.hidden = e.target.checked; draw(); } });
    const tryBox = h("div", {});
    const body = h("div", { class: "stack" },
      h("p", { class: "muted small" }, "The code runs in the viewer's browser inside a sandbox (an opaque-origin frame): it cannot reach the app, its storage or its keys. It has ", h("code", {}, "m5.args"), ", ", h("code", {}, "m5.root"), " (an element to draw in), ", h("code", {}, "m5.flash(text, level)"), ", ", h("code", {}, "m5.send(name, data)"), " → the button entry point, ", h("code", {}, "m5.submit(name, values)"), " → the form entry point, ", h("code", {}, "m5.log()"), ", ", h("code", {}, "m5.play(bytes | url)"), ", ", h("code", {}, "m5.resize()"), ". await works."),
      h("div", { class: "field" }, h("span", { class: "label" }, "Templates"), tpl),
      labelled("Code", code), labelled("args (JSON)", args), problem,
      h("div", { class: "fn-grid3" }, labelled("Title", (() => { const i = input(st.title); i.addEventListener("input", () => { st.title = i.value; draw(); }); return i; })()), labelled("Height (px; empty: fits)", (() => { const i = input(st.height, { type: "number" }); i.addEventListener("input", () => { st.height = i.value; draw(); }); return i; })()), h("label", { class: "fn-switch" }, hiddenBox, " hidden (an effect: runs once, when the message is new)")),
      h("div", { class: "fn-row" }, h("span", { class: "muted small" }, "Code"), h("span", { class: "fn-grow" }), select(lang, [["js", "JavaScript"], ["py", "Python"]], (v) => { lang = v; draw(); })), codeBox,
      h("div", { class: "fn-row" },
        opts.onInsert ? h("button", { class: "btn btn--primary", type: "button", onclick: () => { opts.onInsert(`return ${codeFor("js", specOfJ(), lang)}${lang === "py" ? "" : ";"}`); dlg.close(); } }, "Insert the code") : null,
        opts.onApply ? h("button", { class: "btn btn--primary", type: "button", onclick: () => { opts.onApply(specOfJ()); dlg.close(); } }, "Apply") : null,
        h("button", { class: "btn", type: "button", onclick: () => { clear(tryBox); tryBox.append(sandboxFrame({ type: "js", ...specOfJ() }, null)); } }, "▶ Try it here")),
      tryBox);
    const dlg = Kit().openDialog({ title: "Browser JavaScript", subtitle: "m5.out.js / m5.browser.run", body, wide: true });
    draw();
    return dlg;
  }

  /** Skeletons of the entry point functions (the code editor's Tools). */
  function entrySkeletons(lang) {
    if (lang === "py") return [
      { type: "response", code: "async def response(text, message=None, event=None, **inputs):\n    \"\"\"Someone replied to the model's message.\"\"\"\n    first = m5.model.first\n    return m5.out.markdown(f\"You wrote **{text}** (the first call was {first['type']}).\")\n" },
      { type: "button", code: "async def button(name, data=None, event=None, **inputs):\n    \"\"\"A button of the model's message was clicked.\"\"\"\n    return [m5.out.flash(f\"{name} clicked\", \"success\"), m5.out.json(data)]\n" },
      { type: "form", code: "async def form(name, values, event=None, **inputs):\n    \"\"\"A form of the model's message was sent.\"\"\"\n    return m5.out.table([\"field\", \"value\"], [[k, v] for k, v in values.items()], title=name)\n" },
      { type: "error", code: "async def error(error, failed=None, source=\"server\", **inputs):\n    \"\"\"Another entry point failed (or its result could not be shown).\"\"\"\n    m5.log.error(\"handled\", error=error, failed=failed, source=source)\n    return m5.out.flash(\"Sorry — \" + error.get(\"message\", \"something went wrong\"), \"error\")\n" },
      { type: "webhook", code: "async def webhook(**body):\n    \"\"\"An inbound HTTP call (the JSON body's fields are the inputs).\"\"\"\n    http = m5.model.current[\"http\"]\n    return {\"ok\": True, \"method\": http[\"method\"], \"got\": body}\n" },
    ];
    return [
      { type: "response", code: "// Someone replied to the model's message.\nexport async function response({ text, message, event }) {\n  const first = m5.model.first;\n  return m5.out.markdown(`You wrote **${text}** (the first call was ${first.type}).`);\n}\n" },
      { type: "button", code: "// A button of the model's message was clicked.\nexport async function button({ name, data, event }) {\n  return [m5.out.flash(`${name} clicked`, \"success\"), m5.out.json(data)];\n}\n" },
      { type: "form", code: "// A form of the model's message was sent.\nexport async function form({ name, values, event }) {\n  return m5.out.table([\"field\", \"value\"], Object.entries(values), { title: name });\n}\n" },
      { type: "error", code: "// Another entry point failed (or its result could not be shown in the browser).\nexport async function error({ error, failed, source }) {\n  m5.log.error(\"handled\", { error, failed, source });\n  return m5.out.flash(`Sorry — ${error.message}`, \"error\");\n}\n" },
      { type: "webhook", code: "// An inbound HTTP call: the JSON body's fields are the inputs.\nexport async function webhook(body) {\n  const http = m5.model.current.http;\n  return { ok: true, method: http.method, got: body };\n}\n" },
    ];
  }

  window.M5FnOut = { render, buttonsRow, consoleForm, formBuilder, buttonBuilder, browserJsTool, codeFor, entrySkeletons, FIELD_TYPES, BUTTON_CLASSES, FORM_EXAMPLE };
})();
