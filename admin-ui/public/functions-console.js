// M5cet operator console — Functions (4.15, reworked in 5.1).
//
//   Packages   JS or Python packages: the code editor (CodeMirror, with the m5
//              SDK's completion, help and checks), files, drafts, versions
//   Builder    the visual builder (functions-builder.js): nodes and wires
//              that compile to a package — no code needed
//   Models     a runnable: name, chat keyword, entry, inputs, where it runs,
//              who may use it; a typed test form
//   Schedules  cron
//   Runs       recent runs, filtered, with their logs and outputs
//   Tutorial   lessons that run in place
//
// Runs started here are live: logs and outputs arrive as they happen and a
// question the code asks (m5.prompt / m5.form) is answered right in the page.
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast, can } = C;
  const ED = () => window.M5Editor || null;   // the editor bundle (vendor/m5-editor.js)

  const root = () => document.getElementById("fnRoot");
  let data = null;         // overview: packages, models, schedules, runtime, stats
  let sdk = null;          // { spec, completions, dts }
  let tab = "packages";
  let sel = null;          // the open package { package, draft, versions }
  let files = {};          // its draft files being edited
  let current = "";        // the open file
  let dirty = false;
  let editor = null;       // the CodeMirror handle of the open file
  let pkgFilter = "";
  let modelDraft = null;   // the model being edited
  let lessons = null;
  let lessonId = null;
  let runsFilter = { status: "", model: "" };
  let runsTimer = null;
  let runsAuto = false;
  let helpTab = "sdk";
  const mounted = [];      // editors made for the current view (destroyed on re-render)
  const mount = (handle) => { mounted.push(handle); return handle; };
  const OUT = outputRenderer();

  const tutDone = () => { try { return new Set(JSON.parse(localStorage.getItem("m5cet:fn-tut") || "[]")); } catch { return new Set(); } };
  const markLesson = (id) => { try { const s = tutDone(); s.add(id); localStorage.setItem("m5cet:fn-tut", JSON.stringify([...s])); } catch { /* none */ } };
  const writable = () => can("operator");
  const langName = (l) => (l === "py" ? "Python" : "JavaScript");

  /* ============================================================== loading */

  async function load() {
    if (!sdk) { try { sdk = await api("/admin/functions/sdk"); } catch { sdk = { spec: [], completions: [], dts: "" }; } }
    data = await api("/admin/functions");
    render();
  }
  C.addRoute("functions", ["Functions", "Packages, the visual builder, models, schedules and test runs", load]);

  // Leaving with unsaved code: ask first.
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  /* =============================================================== render */

  function render() {
    const el = root();
    if (!el || !data) return;
    if (runsTimer) { clearInterval(runsTimer); runsTimer = null; }
    if (hookTimer) { clearInterval(hookTimer); hookTimer = null; }
    stashEditor();
    for (const v of mounted.splice(0)) { try { v.destroy(); } catch { /* gone */ } }
    clear(el);
    if (!data.runtime.persistent) el.append(h("div", { class: "card warn" }, h("strong", {}, "In-memory only. "), data.runtime.reason || "The SQLite driver is missing; packages and models will not survive a restart."));
    el.append(header());
    el.append(tabs());
    if (tab === "packages") el.append(packagesView());
    else if (tab === "builder") el.append(builderView());
    else if (tab === "models") el.append(modelsView());
    else if (tab === "schedules") el.append(schedulesView());
    else if (tab === "tutorial") el.append(tutorialView());
    else if (tab === "webhooks") el.append(webhooksView());
    else el.append(runsView());
  }

  function header() {
    const s = data.stats || { runs24h: 0, failed24h: 0, avgMs: 0 };
    const on = data.models.filter((m) => m.enabled).length;
    const stat = (label, value, hint, cls) => h("div", { class: `fn-stat${cls ? " " + cls : ""}`, title: hint || "" }, h("div", { class: "fn-stat__v" }, String(value)), h("div", { class: "fn-stat__l" }, label));
    const svc = data.service || { enabled: true, source: "default" };
    const svcToggle = h("input", { type: "checkbox", checked: svc.enabled || undefined, disabled: svc.source === "env" || !writable() || undefined, title: svc.source === "env" ? `Fixed by ${svc.env}` : "The Functions service: chat commands, webhooks, the API, schedules" });
    svcToggle.addEventListener("change", async () => {
      try { await api("/api/admin/modules/switches", { method: "PUT", body: { functions: svcToggle.checked } }); toast(svcToggle.checked ? "Functions are running: /commands, webhooks and the API work." : "Functions stopped.", "ok"); await load(); }
      catch (e) { toast(e.message, "err"); svcToggle.checked = !svcToggle.checked; }
    });
    return h("div", { class: "fn-stats" },
      h("div", { class: `fn-stat${svc.enabled ? "" : " fn-stat--warn"}`, title: "Off: nothing runs from the chat, webhooks or the API (the console's tests still do)" },
        h("label", { class: "fn-switch" }, svcToggle, h("span", { class: "fn-stat__v" }, svc.enabled ? "on" : "off")), h("div", { class: "fn-stat__l" }, svc.source === "env" ? `service · ${svc.env}` : "service")),
      stat("packages", data.packages.length, "Code packages (JavaScript or Python)"),
      stat("models", `${on}/${data.models.length}`, "Models switched on / all"),
      stat("schedules", (data.schedules || []).length, "Cron schedules"),
      stat("runs · 24 h", s.runs24h, "Runs in the last 24 hours"),
      stat("failed · 24 h", s.failed24h, "Failed or timed-out runs in the last 24 hours", s.failed24h ? "fn-stat--err" : ""),
      stat("avg ms", s.avgMs || "—", "Average time of a successful run"),
      ED() ? null : h("div", { class: "fn-stat fn-stat--warn", title: "vendor/m5-editor.js did not load — run npm run build" }, h("div", { class: "fn-stat__v" }, "!"), h("div", { class: "fn-stat__l" }, "plain editor")));
  }

  function tabs() {
    const bar = h("div", { class: "fn-tabs", role: "tablist" });
    const items = [["packages", "Packages", data.packages.length], ["builder", "Builder", null], ["models", "Models", data.models.length], ["schedules", "Schedules", (data.schedules || []).length], ["webhooks", "Webhooks", data.models.filter((m) => m.executors && m.executors.webhook && m.executors.webhook.enabled).length], ["runs", "Runs", null], ["tutorial", "Tutorial", null]];
    for (const [id, label, n] of items) {
      bar.append(h("button", { class: `fn-tab${tab === id ? " fn-tab--on" : ""}`, role: "tab", "aria-selected": tab === id ? "true" : "false", onclick: () => go(id) }, label, n !== null ? h("span", { class: "fn-tab__n" }, String(n)) : null));
    }
    return bar;
  }

  function go(id) {
    if (tab === "packages" && id !== "packages" && dirty && !confirm("The open file has unsaved changes. Leave anyway? (They stay in the editor until you open another package.)")) return;
    tab = id; render();
  }

  /* ============================================================ dialogs */

  /** A form in a dialog; resolves with the values, or null when closed. */
  function formDialog({ title, subtitle, fields, submit = "OK", wide = false, extra }) {
    return new Promise((resolve) => {
      const Kit = window.M5Kit;
      const values = {};
      const form = h("form", { class: "fn-dform" });
      const inputs = {};
      for (const f of fields) {
        values[f.name] = f.value !== undefined ? f.value : f.type === "checkbox" ? false : "";
        let input;
        if (f.type === "select") { input = h("select", { class: "input" }); for (const o of f.options) input.append(h("option", { value: o.value, selected: String(values[f.name]) === String(o.value) }, o.label)); }
        else if (f.type === "radio-cards") {
          input = h("div", { class: "fn-cards" });
          for (const o of f.options) {
            const card = h("label", { class: `fn-cardopt${values[f.name] === o.value ? " fn-cardopt--on" : ""}` }, h("input", { type: "radio", name: f.name, value: o.value, checked: values[f.name] === o.value }), h("strong", {}, o.label), o.hint ? h("span", { class: "muted small" }, o.hint) : null);
            card.querySelector("input").addEventListener("change", () => { values[f.name] = o.value; for (const c of input.children) c.classList.toggle("fn-cardopt--on", c === card); if (f.onchange) f.onchange(o.value, inputs); });
            input.append(card);
          }
        }
        else if (f.type === "textarea") input = h("textarea", { class: "input fn-mono", rows: f.rows || 4, placeholder: f.placeholder || "" }, String(values[f.name]));
        else if (f.type === "checkbox") input = h("input", { type: "checkbox", checked: Boolean(values[f.name]) });
        else input = h("input", { class: "input", type: f.type || "text", value: String(values[f.name]), placeholder: f.placeholder || "", autocomplete: "off", spellcheck: "false" });
        if (f.type !== "radio-cards") input.addEventListener(f.type === "checkbox" || f.type === "select" ? "change" : "input", () => { values[f.name] = f.type === "checkbox" ? input.checked : input.value; if (f.onchange) f.onchange(values[f.name], inputs); });
        inputs[f.name] = input;
        const row = h("label", { class: `field${f.type === "checkbox" ? " fn-check" : ""}`, "data-field": f.name, hidden: f.hidden ? true : null }, h("span", { class: "label" }, f.label), input, f.hint ? h("span", { class: "muted small" }, f.hint) : null);
        form.append(row);
      }
      if (extra) form.append(extra);
      const err = h("div", { class: "fn-err", hidden: true });
      form.append(err, h("div", { class: "fn-dform__actions" }, h("button", { type: "submit", class: "btn btn--primary" }, submit)));
      let settled = false;
      const dlg = Kit && Kit.openDialog ? Kit.openDialog({ title, subtitle, body: form, wide, onClose: () => { if (!settled) { settled = true; resolve(null); } } }) : null;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        for (const f of fields) if (f.required && !String(values[f.name] ?? "").trim() && !form.querySelector(`[data-field="${f.name}"]`).hidden) { err.hidden = false; err.textContent = `${f.label} is required.`; return; }
        settled = true; if (dlg) dlg.close(); resolve(values);
      });
      setTimeout(() => { const first = form.querySelector("input:not([type=radio]):not([type=checkbox]), textarea, select"); if (first) first.focus(); }, 30);
      if (!dlg) { settled = true; resolve(null); }
    });
  }

  function confirmDialog(text, danger) {
    return new Promise((resolve) => {
      const Kit = window.M5Kit;
      if (!Kit || !Kit.openDialog) { resolve(confirm(text)); return; }
      let done = false;
      const yes = h("button", { class: `btn ${danger ? "btn--danger" : "btn--primary"}`, onclick: () => { done = true; dlg.close(); resolve(true); } }, danger ? "Delete" : "OK");
      const no = h("button", { class: "btn", onclick: () => { done = true; dlg.close(); resolve(false); } }, "Cancel");
      const dlg = Kit.openDialog({ title: danger ? "Are you sure?" : "Confirm", body: h("div", { class: "stack" }, h("p", {}, text), h("div", { class: "fn-dform__actions" }, no, yes)), onClose: () => { if (!done) resolve(false); } });
      setTimeout(() => yes.focus(), 30);
    });
  }

  /* ============================================================ packages */

  function packagesView() {
    const wrap = h("div", { class: "fn-cols" });
    const list = h("div", { class: "fn-side card" });
    list.append(h("div", { class: "fn-side__head" }, h("span", {}, "Packages"), writable() ? h("span", { class: "fn-row" }, h("button", { class: "btn btn--sm", onclick: importPackage, title: "Import a .m5pkg.json" }, "Import"), h("button", { class: "btn btn--sm btn--primary", onclick: newPackage }, "+ New")) : null));
    const search = h("input", { class: "input input--sm fn-search", type: "search", placeholder: "Filter…", value: pkgFilter, "aria-label": "Filter packages" });
    const items = h("div", { class: "fn-list" });
    const draw = () => {
      clear(items);
      const q = pkgFilter.toLowerCase();
      const shown = data.packages.filter((p) => !q || p.name.includes(q) || (p.description || "").toLowerCase().includes(q));
      if (!shown.length) items.append(h("div", { class: "muted small p8" }, data.packages.length ? "Nothing matches." : "No packages yet — create one, or build one visually in the Builder."));
      for (const p of shown) {
        const on = sel && sel.package.id === p.id;
        items.append(h("button", { class: `fn-pkg${on ? " fn-pkg--on" : ""}`, title: p.description || p.name, onclick: () => openPackage(p.id) },
          h("span", { class: `fn-lang fn-lang--${p.language}` }, p.language.toUpperCase()),
          h("span", { class: "fn-pkg__name" }, p.name),
          p.flow ? h("span", { class: "badge badge--accent", title: "Made in the visual builder" }, "flow") : null,
          h("span", { class: "muted small" }, p.versions.length ? `v${p.versions[p.versions.length - 1]}` : "draft")));
      }
    };
    search.addEventListener("input", () => { pkgFilter = search.value; draw(); });
    draw();
    list.append(search, items);
    wrap.append(list);
    wrap.append(sel ? editorPane() : packagesHome());
    return wrap;
  }

  function packagesHome() {
    const box = h("div", { class: "card fn-home" });
    box.append(h("h3", {}, "Write a function, or draw one"));
    box.append(h("p", { class: "muted" }, "A package holds the code (JavaScript or Python). A model makes it runnable: a chat command /keyword, a webhook, an API call or a schedule."));
    const cards = h("div", { class: "fn-home__cards" });
    if (writable()) {
      cards.append(
        homeCard("✎", "New package", "Start empty or from a template, then write code with completion and help.", newPackage),
        homeCard("◇", "Visual builder", "Connect inputs, SDK calls, logic and outputs — the code is written for you.", () => go("builder")),
        homeCard("▶", "Tutorial", "Short lessons that run right here.", () => go("tutorial")));
    }
    box.append(cards);
    const gallery = h("div", { class: "fn-builtins mt8" });
    box.append(gallery);
    void builtinGallery(gallery);
    return box;
  }
  const homeCard = (icon, title, text, onclick) => h("button", { class: "fn-home__card", onclick }, h("span", { class: "fn-home__icon" }, icon), h("strong", {}, title), h("span", { class: "muted small" }, text));

  async function newPackage() {
    const tpls = data.templates || [];
    const v = await formDialog({
      title: "New package", submit: "Create",
      fields: [
        { name: "name", label: "Name", placeholder: "tools-net", required: true, hint: "Lower-case letters, digits and hyphens." },
        { name: "description", label: "Description", placeholder: "What it does" },
        { name: "start", label: "Start from", type: "radio-cards", value: "empty-js", options: [
          { value: "empty-js", label: "Empty · JavaScript", hint: "export async function execute(inputs)" },
          { value: "empty-py", label: "Empty · Python", hint: "async def execute(**inputs)" },
          ...tpls.map((t) => ({ value: `tpl:${t.id}`, label: `${t.name}`, hint: `${t.description} (${t.language.toUpperCase()})` })),
          { value: "flow", label: "Visual flow", hint: "Opens the builder" },
        ] },
      ],
    });
    if (!v) return;
    if (v.start === "flow") { const B = window.M5FnBuilder; if (B) B.newFlow(v.name.trim(), "js"); go("builder"); return; }
    const template = v.start.startsWith("tpl:") ? v.start.slice(4) : undefined;
    const language = template ? undefined : v.start === "empty-py" ? "py" : "js";
    try { const r = await api("/admin/functions/packages", { method: "POST", body: { name: v.name.trim(), language, template, description: v.description } }); toast(`Package ${r.package.name} created.`, "ok"); await load(); await openPackage(r.package.id); }
    catch (e) { toast(e.message, "err"); }
  }

  function importPackage() {
    const input = h("input", { type: "file", accept: ".json,.m5pkg,application/json", style: "display:none" });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let bundle; try { bundle = JSON.parse(await file.text()); } catch { toast("That file is not JSON.", "err"); return; }
      try { const r = await api("/admin/functions/packages/import", { method: "POST", body: { bundle } }); toast(`Imported ${r.package.name}.`, "ok"); await load(); await openPackage(r.package.id); }
      catch (e) { toast(e.message, "err"); }
    });
    document.body.append(input); input.click(); setTimeout(() => input.remove(), 1000);
  }

  async function exportPackage(id, name) {
    try {
      const res = await C.raw(`/admin/functions/packages/${encodeURIComponent(id)}/export`);
      if (!res.ok) { toast("Export failed (publish a version first).", "err"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `${name}.m5pkg.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message, "err"); }
  }

  async function openPackage(id) {
    if (dirty && sel && sel.package.id !== id && !(await confirmDialog("The open file has unsaved changes. Discard them?"))) return;
    let next;
    try { next = await api(`/admin/functions/packages/${encodeURIComponent(id)}`); }
    catch (e) { toast(e.message, "err"); return; }
    // Drop the old editor first: render() would otherwise stash its text into the new package's files.
    if (editor) { editor.destroy(); editor = null; }
    sel = next;
    files = { ...(sel.draft ? sel.draft.files : {}) };
    current = files["index.js"] !== undefined ? "index.js" : files["index.py"] !== undefined ? "index.py" : Object.keys(files).sort()[0] || "";
    dirty = false;
    tab = "packages";
    render();
  }

  function stashEditor() { if (editor && current && files[current] !== undefined) files[current] = editor.getValue(); if (editor) { editor.destroy(); editor = null; } }

  function editorPane() {
    const pane = h("div", { class: "fn-editor-pane card" });
    const published = sel.versions.filter((v) => v.status === "published");
    const hasFlow = files["flow.m5flow.json"] !== undefined;
    // header
    const head = h("div", { class: "fn-editor__head" });
    head.append(h("span", { class: `fn-lang fn-lang--${sel.package.language}` }, sel.package.language.toUpperCase()), h("strong", { class: "fn-title" }, sel.package.name));
    if (sel.package.description) head.append(h("span", { class: "muted small" }, sel.package.description));
    if (published.length) head.append(h("span", { class: "badge", title: published.map((v) => v.version).join(", ") }, `v${published[published.length - 1].version}`));
    const actions = h("div", { class: "fn-editor__actions" });
    if (hasFlow && window.M5FnBuilder) actions.append(h("button", { class: "btn btn--sm", title: "Edit the flow this code was generated from", onclick: () => openFlowOf(sel) }, "◇ Open in builder"));
    if (writable()) {
      actions.append(
        h("button", { class: "btn btn--sm", id: "fnSave", title: "Save the draft (Ctrl/⌘+S)", onclick: saveDraft }, dirty ? "Save draft •" : "Save draft"),
        h("button", { class: "btn btn--sm btn--primary", onclick: publish, title: "Freeze the draft as a version models can use" }, "Publish…"),
      );
    }
    const more = h("details", { class: "fn-more" }, h("summary", { class: "btn btn--sm" }, "⋯"));
    const menu = h("div", { class: "fn-more__menu" });
    if (published.length) menu.append(h("button", { class: "fn-more__item", onclick: () => exportPackage(sel.package.id, sel.package.name) }, "Export .m5pkg.json"));
    if (writable()) menu.append(h("button", { class: "fn-more__item", onclick: () => newModelFor(sel) }, "New model from this package…"));
    if (writable()) menu.append(h("button", { class: "fn-more__item fn-more__item--danger", onclick: deletePackage }, "Delete package…"));
    more.append(menu);
    actions.append(more);
    head.append(actions);
    pane.append(head);

    // file tabs
    const ftabs = h("div", { class: "fn-files" });
    for (const name of Object.keys(files).sort()) {
      ftabs.append(h("button", { class: `fn-file${name === current ? " fn-file--on" : ""}`, title: name, onclick: () => { if (name === current) return; stashEditor(); current = name; render(); } }, name,
        writable() && Object.keys(files).length > 1 ? h("span", { class: "fn-file__x", title: "Delete file", onclick: async (ev) => { ev.stopPropagation(); if (!(await confirmDialog(`Delete ${name}?`, true))) return; stashEditor(); delete files[name]; if (current === name) current = Object.keys(files).sort()[0] || ""; dirty = true; render(); } }, "×") : null));
    }
    if (writable()) ftabs.append(h("button", { class: "fn-file fn-file--add", title: "New file", onclick: newFile }, "+"));
    pane.append(ftabs);

    // the editor + help
    const grid = h("div", { class: "fn-edit-grid" });
    const host = h("div", { class: "fn-cm" });
    const status = h("div", { class: "fn-statusbar" });
    const E = ED();
    const lang = E ? E.langOf(current) : "text";
    const setStatus = (info) => { clear(status); status.append(h("span", {}, `Ln ${info.line}, Col ${info.col}${info.selected ? ` (${info.selected} selected)` : ""}`), h("span", {}, lang === "py" ? "Python" : lang === "js" ? "JavaScript" : lang === "json" ? "JSON" : "Text"), h("span", {}, dirty ? "● unsaved" : "saved"), h("span", { class: "muted" }, "Ctrl+Space complete · Ctrl+S save · Ctrl+Enter run · Ctrl+F find · Shift+Alt+F format")); };
    if (E) {
      editor = E.create(host, {
        doc: files[current] || "", lang, readOnly: !writable(), sdk: sdk.spec || [],
        inputs: () => inputNamesFor(sel.package.name),
        onChange: (text) => { files[current] = text; if (!dirty) { dirty = true; markDirty(); } },
        onSave: saveDraft, onRun: () => { const b = document.getElementById("fnRunBtn"); if (b) b.click(); },
        onCursor: setStatus, minHeight: "380px", maxHeight: "70vh",
        placeholder: sel.package.language === "py" ? "async def execute(**inputs): …" : "export async function execute(inputs) { … }",
      });
      setStatus({ line: 1, col: 1, selected: 0 });
    } else {
      const ta = h("textarea", { class: "fn-editor", spellcheck: "false", wrap: "off", readonly: writable() ? null : "readonly" });
      ta.value = files[current] || "";
      ta.addEventListener("input", () => { files[current] = ta.value; dirty = true; markDirty(); });
      ta.addEventListener("keydown", (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") { ev.preventDefault(); saveDraft(); } });
      editor = { getValue: () => ta.value, insertSnippet: (t) => insertPlain(ta, t.replace(/\$\{([^}]*)\}/g, "$1")), insertText: (t) => insertPlain(ta, t), destroy: () => undefined, format: () => undefined, search: () => undefined, focus: () => ta.focus() };
      host.append(ta);
    }
    const toolbar = h("div", { class: "fn-edtools" },
      E ? h("button", { class: "btn btn--xs", title: "Find & replace (Ctrl+F)", onclick: () => editor.search() }, "Find") : null,
      E ? h("button", { class: "btn btn--xs", title: "Re-indent (Shift+Alt+F)", onclick: () => editor.format() }, "Format") : null,
      E ? h("button", { class: "btn btn--xs", title: "Undo", onclick: () => editor.undo() }, "↶") : null,
      E ? h("button", { class: "btn btn--xs", title: "Redo", onclick: () => editor.redo() }, "↷") : null);
    const left = h("div", { class: "fn-edit-main" }, toolbar, host, status);
    grid.append(left, helpPanel());
    pane.append(grid);

    pane.append(runPanel());
    return pane;
  }

  function insertPlain(ta, text) {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus(); files[current] = ta.value; dirty = true; markDirty();
  }

  /** The input names of the models that run this package (for `inputs.` completion). */
  function inputNamesFor(pkgName) {
    const names = new Set();
    for (const m of data.models) if ((m.entry || "").startsWith(pkgName + "@")) for (const i of m.inputs || []) if (i.name) names.add(i.name);
    return [...names];
  }

  function markDirty() { const b = document.getElementById("fnSave"); if (b) b.textContent = dirty ? "Save draft •" : "Save draft"; }

  async function newFile() {
    const ext = sel.package.language === "py" ? ".py" : ".js";
    const v = await formDialog({ title: "New file", submit: "Add", fields: [{ name: "name", label: "File name", placeholder: `util${ext}  ·  lib/helpers${ext}  ·  data.json  ·  README.md`, required: true }] });
    if (!v) return;
    const name = v.name.trim();
    if (files[name] !== undefined) { toast("That file already exists.", "err"); return; }
    stashEditor();
    files[name] = name.endsWith(".py") ? "# " + name + "\n" : name.endsWith(".js") ? "// " + name + "\n" : "";
    current = name; dirty = true; render();
  }

  async function saveDraft() {
    if (editor && current) files[current] = editor.getValue();
    try { const r = await api(`/admin/functions/packages/${encodeURIComponent(sel.package.id)}/draft`, { method: "PUT", body: { files } }); sel.draft = r.draft; dirty = false; toast("Draft saved.", "ok"); markDirty(); return true; }
    catch (e) { toast(e.message, "err"); return false; }
  }

  async function publish() {
    if (!(await saveDraft())) return;
    const last = sel.versions.filter((v) => v.status === "published").map((v) => v.version).pop() || "0.0.0";
    const [a, b, c] = last.split(".").map((x) => Number(x) || 0);
    const v = await formDialog({
      title: `Publish ${sel.package.name}`, subtitle: `last: ${last}`, submit: "Publish",
      fields: [{ name: "bump", label: "Version", type: "radio-cards", value: "patch", options: [
        { value: "patch", label: `${a}.${b}.${c + 1}`, hint: "patch — fixes" },
        { value: "minor", label: `${a}.${b + 1}.0`, hint: "minor — new things" },
        { value: "major", label: `${a + 1}.0.0`, hint: "major — breaking" },
        { value: "exact", label: "Exact…", hint: "type it below" },
      ], onchange: (val, inputs) => { const row = inputs.exact && inputs.exact.closest(".field"); if (row) row.hidden = val !== "exact"; } },
      { name: "exact", label: "Exact version", placeholder: "1.2.3", hidden: true }],
    });
    if (!v) return;
    const bump = v.bump === "exact" ? v.exact.trim() : v.bump;
    if (!bump) return;
    try { const r = await api(`/admin/functions/packages/${encodeURIComponent(sel.package.id)}/publish`, { method: "POST", body: { bump } }); toast(`Published ${sel.package.name}@${r.version.version}.`, "ok"); await load(); await openPackage(sel.package.id); }
    catch (e) { toast(e.message, "err"); }
  }

  async function deletePackage() {
    if (!(await confirmDialog(`Delete the package “${sel.package.name}” with all its versions? Models that use it stop working.`, true))) return;
    try { await api(`/admin/functions/packages/${encodeURIComponent(sel.package.id)}`, { method: "DELETE" }); toast("Package deleted.", "ok"); sel = null; dirty = false; await load(); }
    catch (e) { toast(e.message, "err"); }
  }

  function openFlowOf(pkg) {
    const B = window.M5FnBuilder;
    if (!B) return;
    try { B.openFromPackage(pkg.package, JSON.parse(files["flow.m5flow.json"] || pkg.draft.files["flow.m5flow.json"])); go("builder"); }
    catch (e) { toast(`The flow file is not valid: ${e.message}`, "err"); }
  }

  /* ------------------------------------------------------------ help */

  function helpPanel() {
    const box = h("div", { class: "fn-help" });
    const bar = h("div", { class: "fn-help__tabs" });
    for (const [id, label] of [["sdk", "SDK"], ["snippets", "Templates"], ["tools", "Tools"], ["examples", "Examples"]]) bar.append(h("button", { class: `fn-help__tab${helpTab === id ? " is-on" : ""}`, onclick: () => { helpTab = id; const n = helpPanel(); box.replaceWith(n); } }, label));
    const search = h("input", { class: "input input--sm", type: "search", placeholder: "Search…", "aria-label": "Search the help" });
    const body = h("div", { class: "fn-help__body" });
    box.append(bar, search, body);
    const lang = sel && sel.package.language === "py" ? "py" : "js";
    const insert = (tpl) => { if (!editor || !writable()) { navigator.clipboard && navigator.clipboard.writeText(tpl.replace(/\$\{([^}]*)\}/g, "$1")); toast("Copied.", "ok"); return; } editor.insertSnippet(tpl); };
    const draw = () => {
      clear(body);
      const q = search.value.trim().toLowerCase();
      if (helpTab === "sdk") {
        for (const obj of (sdk.spec || [])) {
          const meths = obj.methods.filter((m) => !q || `${obj.name}.${m.name} ${m.doc}`.toLowerCase().includes(q));
          if (!meths.length && !(obj.name.includes(q))) continue;
          const det = h("details", { class: "fn-sdk__obj", open: q ? true : null });
          det.append(h("summary", {}, h("span", { class: "fn-sdk__ns" }, `m5.${obj.name}`), h("span", { class: "muted small" }, obj.doc)));
          for (const m of (meths.length ? meths : obj.methods)) {
            const sig = lang === "py" ? m.py : m.js;
            det.append(h("button", { class: "fn-sdk__m", title: `${m.doc}\n\nClick to insert.`, onclick: () => insert(sdkSnippet(sig, lang, m)) },
              h("code", {}, sig.replace(/^await\s+/, "")), m.async ? h("span", { class: "fn-async" }, "async") : null, h("span", { class: "fn-sdk__doc" }, m.doc)));
          }
          body.append(det);
        }
      } else if (helpTab === "snippets") {
        const list = (ED() && ED().SNIPPETS[lang]) || [];
        for (const s of list.filter((x) => !q || `${x.label} ${x.detail} ${x.info}`.toLowerCase().includes(q))) {
          body.append(h("button", { class: "fn-snip", onclick: () => insert(s.template), title: "Click to insert — Tab moves between the fields" }, h("strong", {}, s.label), h("span", { class: "muted small" }, s.detail), h("pre", {}, s.template.replace(/\$\{([^}]*)\}/g, "$1"))));
        }
        body.append(h("p", { class: "muted small p8" }, "Tip: type a template's name in the editor (e.g. ", h("code", {}, "httpjson"), ") and pick it from the completion list."));
      } else if (helpTab === "tools") {
        // 5.3: builders that write the code — a form, a button, browser JavaScript — and the entry point functions.
        const X = window.M5FnOut;
        if (!X) { body.append(h("div", { class: "muted small p8" }, "functions-outputs.js is missing.")); return; }
        const plain = (code) => insert(code.replace(/\$/g, "\\$"));
        body.append(
          h("button", { class: "fn-snip", onclick: () => X.formBuilder({ lang, onInsert: plain }) }, h("strong", {}, "▦ Form builder…"), h("span", { class: "muted small" }, "m5.out.form — panels, rows or columns, labels above or beside, text, numbers, dates, masks, selects with icons, switches; the form entry point")),
          h("button", { class: "fn-snip", onclick: () => X.buttonBuilder({ lang, onInsert: plain }) }, h("strong", {}, "▭ Button…"), h("span", { class: "muted small" }, "m5.out.button — title, name, data, classes, colours, icon, confirm; the button entry point")),
          h("button", { class: "fn-snip", onclick: () => X.browserJsTool({ lang, onInsert: plain }) }, h("strong", {}, "⟨/⟩ Browser JavaScript…"), h("span", { class: "muted small" }, "m5.out.js — code for the viewer's browser in a sandbox: a notice, a sound, a widget that calls the model")),
          h("div", { class: "muted small p8" }, "Entry point functions (Models › Entry points — one function each):"));
        for (const sk of X.entrySkeletons(lang)) body.append(h("button", { class: "fn-snip", onclick: () => plain(sk.code) }, h("strong", {}, sk.type), h("pre", {}, sk.code.split("\n").slice(0, 4).join("\n") + "\n…")));
        body.append(h("button", { class: "fn-snip", onclick: () => plain(lang === "py"
          ? "async def execute(**inputs):\n    # A list: every item is shown, played or run — each on its own.\n    return [\n        m5.out.markdown(\"# Result\"),\n        m5.out.flash(\"Done\", \"success\"),\n        m5.out.button({\"name\": \"again\", \"title\": \"Again\", \"css\": \"primary\"}),\n    ]\n"
          : "export async function execute(inputs) {\n  // A list: every item is shown, played or run — each on its own.\n  return [\n    m5.out.markdown(\"# Result\"),\n    m5.out.flash(\"Done\", \"success\"),\n    m5.out.button({ name: \"again\", title: \"Again\", css: \"primary\" }),\n  ];\n}\n") }, h("strong", {}, "A result list"), h("span", { class: "muted small" }, "several outputs at once: text, a notice, a button…")));
      } else {
        if (!lessons) { api("/admin/functions/tutorial").then((d) => { lessons = d.lessons || []; draw(); }).catch(() => undefined); body.append(h("div", { class: "muted small p8" }, "Loading…")); return; }
        for (const l of lessons.filter((x) => x.lang === lang && (!q || `${x.title} ${x.body}`.toLowerCase().includes(q)))) {
          body.append(h("button", { class: "fn-snip", onclick: () => insert(l.sample.replace(/\$/g, "\\$")), title: "Insert this example" }, h("strong", {}, l.title), h("pre", {}, l.sample.split("\n").slice(0, 6).join("\n") + (l.sample.split("\n").length > 6 ? "\n…" : ""))));
        }
      }
    };
    search.addEventListener("input", draw);
    draw();
    return box;
  }

  /** The signature as a snippet: `await m5.x.y(${a}, ${b})`. */
  function sdkSnippet(sig, lang, m) {
    const E = ED();
    if (!E || !sig.includes("(")) return sig.replace(/\$/g, "\\$");
    const call = E.toSnippet(sig, lang);
    const prefix = sig.slice(0, sig.lastIndexOf(m.name + "(") >= 0 ? sig.lastIndexOf(m.name + "(") : sig.length).replace(/\$/g, "\\$");
    return prefix + call;
  }

  /* --------------------------------------------------------------- run it */

  function runPanel() {
    const box = h("div", { class: "fn-run" });
    const entryFile = h("input", { class: "input input--sm fn-run__file", value: current && /\.(js|py)$/.test(current) ? current : (sel.draft && sel.draft.manifest.main) || "index.js", "aria-label": "Entry file" });
    const entryFn = h("input", { class: "input input--sm fn-run__fn", value: "execute", "aria-label": "Entry function" });
    const inputsHost = h("div", { class: "fn-run__inputs" });
    const saved = (() => { try { return localStorage.getItem(`m5cet:fn-inputs:${sel.package.id}`) || "{}"; } catch { return "{}"; } })();
    let inputsEd = null;
    const E = ED();
    if (E) inputsEd = mount(E.create(inputsHost, { doc: saved, lang: "json", minHeight: "44px", maxHeight: "160px", lineNumbers: false, onRun: () => doRun() }));
    else { const ta = h("textarea", { class: "input fn-mono", rows: 2 }, saved); ta.value = saved; inputsHost.append(ta); inputsEd = { getValue: () => ta.value }; }
    const runBtn = h("button", { class: "btn btn--primary btn--sm", id: "fnRunBtn", title: "Save and run the draft (Ctrl/⌘+Enter)", onclick: () => doRun() }, "▶ Run draft");
    box.append(h("div", { class: "fn-run__row" }, h("strong", { class: "small" }, "Run"), entryFile, h("span", { class: "muted" }, "#"), entryFn, runBtn));
    box.append(h("div", { class: "fn-run__row fn-run__row--top" }, h("span", { class: "muted small" }, "Inputs (JSON)"), inputsHost));
    const result = h("div", { class: "fn-run__result" });
    box.append(result);

    async function doRun() {
      let parsed; try { parsed = JSON.parse(inputsEd.getValue() || "{}"); } catch (e) { toast(`Inputs are not JSON: ${e.message}`, "err"); return; }
      try { localStorage.setItem(`m5cet:fn-inputs:${sel.package.id}`, JSON.stringify(parsed)); } catch { /* none */ }
      if (writable() && !(await saveDraft())) return;
      liveRunInto(result, { draft: { packageId: sel.package.id, file: entryFile.value.trim(), fn: entryFn.value.trim() || "execute" }, inputs: parsed });
    }
    return box;
  }

  /* ============================================================ live runs */

  /**
   * Starts a live run and follows it: calls onEvent for every event
   * (status, log, output, progress, interaction, result). Resolves with the
   * result event.
   */
  async function liveRun(body, onEvent) {
    const start = await api("/admin/functions/run", { method: "POST", body: { ...body, live: true } });
    const runId = start.runId;
    onEvent({ type: "started", runId });
    const res = await C.raw(`/admin/functions/runs/${encodeURIComponent(runId)}/live`);
    if (!res.ok || !res.body) throw new Error("Could not follow the run.");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        onEvent(ev);
        if (ev.type === "result") result = ev;
      }
    }
    return result || { type: "result", ok: false, message: "The run ended without a result." };
  }

  /** A run view: progress, questions to answer, outputs and logs as they arrive, then the result. */
  function liveRunInto(el, body, hooks = {}) {
    clear(el);
    const spin = h("span", { class: "fn-spin", "aria-hidden": "true" });
    const badge = h("span", { class: "badge" }, "starting");
    const info = h("span", { class: "muted small" }, "");
    const statusRow = h("div", { class: "fn-run__status" }, spin, badge, info);
    const bar = h("div", { class: "fn-progress", hidden: true }, h("div", { class: "fn-progress__bar" }));
    const asks = h("div", { class: "fn-asks" });
    const outs = h("div", { class: "fn-outs" });
    const logsBox = h("details", { class: "fn-logbox", open: true }, h("summary", { class: "muted small" }, "Logs"));
    const logs = h("pre", { class: "fn-logs" });
    logsBox.append(logs);
    const after = h("div", { class: "fn-after" });
    el.append(statusRow, bar, asks, outs, logsBox, after);
    // 5.3: the run's processing session — a click or a form in its outputs runs the entry point in it.
    const ctx = { chain: null, call: null, follow: (id) => followRunInto(after, id) };
    const t0 = Date.now();
    const timer = setInterval(() => { info.textContent = `${((Date.now() - t0) / 1000).toFixed(1)} s`; }, 200);
    let runId = null;
    const setBadge = (text, cls) => { badge.textContent = text; badge.className = `badge${cls ? " badge--" + cls : ""}`; };
    const logLine = (l) => {
      if (l.msg === "flow:node" || l.msg === "flow:fail") { if (hooks.onTrace) hooks.onTrace(l); if (!hooks.showTrace) return; }
      logs.append(h("div", { class: `fn-log fn-log--${l.level}` }, h("span", { class: "fn-log__lvl" }, l.level), ` ${l.msg}${l.fields ? "  " + JSON.stringify(l.fields) : ""}`));
      logs.scrollTop = logs.scrollHeight;
    };
    liveRun(body, (ev) => {
      if (ev.type === "started") { runId = ev.runId; setBadge("running"); if (hooks.onStart) hooks.onStart(runId); }
      else if (ev.type === "log") logLine(ev);
      else if (ev.type === "output") outs.append(OUT(ev.output, ctx));
      else if (ev.type === "progress") { bar.hidden = false; bar.firstChild.style.width = `${Math.max(0, Math.min(1, ev.p)) * 100}%`; bar.title = ev.text || ""; }
      else if (ev.type === "status" && ev.status === "waiting") setBadge("waiting for you", "warn");
      else if (ev.type === "interaction") asks.append(interactionCard(runId, ev.interaction, () => setBadge("running")));
      else if (ev.type === "result") {
        clearInterval(timer);
        spin.remove();
        clear(asks);
        if (!ev.ok) { setBadge("refused", "err"); el.insertBefore(h("div", { class: "fn-err" }, ev.message || "The run was refused."), outs); if (hooks.onDone) hooks.onDone(ev); return; }
        const run = ev.run;
        ctx.chain = run.chainId || null; ctx.call = typeof run.callId === "number" ? run.callId : null;
        setBadge(run.status, run.status === "done" ? "ok" : "err");
        info.textContent = `${run.ms} ms · ${run.memMb} MB · ${run.lang || ""} · ${run.id}`;
        if (run.error) el.insertBefore(h("pre", { class: "fn-err" }, `${run.error.type}: ${run.error.message}${run.error.stack ? "\n" + run.error.stack : ""}`), outs);
        // The returned value (last output) — the ones sent during the run are shown already.
        const shown = outs.childElementCount;
        for (const o of (ev.outputs || []).slice(shown)) outs.append(OUT(o, ctx));
        if (run.chainId) { info.append(` · session ${run.chainId}, call ${run.callId}${run.endpoint && run.endpoint !== "execute" ? ` (${run.endpoint})` : ""}`); el.insertBefore(replyForm(ctx), after); }
        if (!logs.childElementCount) logsBox.hidden = true;
        if (hooks.onDone) hooks.onDone(ev);
      }
    }).catch((e) => { clearInterval(timer); spin.remove(); clear(el); el.append(h("div", { class: "fn-err" }, e.message)); if (hooks.onDone) hooks.onDone({ type: "result", ok: false, message: e.message }); });
  }

  /** m5.prompt / m5.form, asked of the console. */
  function interactionCard(runId, it, onAnswered) {
    const spec = it.spec || {};
    const card = h("div", { class: "fn-ask" });
    const send = async (value) => {
      try { await api(`/admin/functions/runs/${encodeURIComponent(runId)}/answer`, { method: "POST", body: { interaction: it.id, value } }); card.remove(); onAnswered(); }
      catch (e) { toast(e.message, "err"); }
    };
    if (it.kind === "form") {
      card.append(h("strong", {}, spec.title || "The function asks"));
      if (spec.text) card.append(h("p", { class: "muted small" }, spec.text));
      const vals = {};
      const form = h("form", { class: "fn-ask__form" });
      for (const f of spec.fields || []) {
        let input;
        if (f.values && f.values.length) { input = h("select", { class: "input input--sm" }); for (const v of f.values) input.append(h("option", { value: v }, v)); }
        else if (f.type === "boolean") input = h("input", { type: "checkbox" });
        else input = h("input", { class: "input input--sm", type: f.type === "number" || f.type === "integer" ? "number" : f.type === "date" ? "date" : "text", placeholder: f.placeholder || "" });
        form.append(h("label", { class: "fn-ti" }, h("span", { class: "small" }, (f.label || f.name) + (f.required ? " *" : "")), input));
        vals[f.name] = () => (input.type === "checkbox" ? input.checked : input.type === "number" && input.value !== "" ? Number(input.value) : input.value);
      }
      form.append(h("button", { class: "btn btn--primary btn--sm", type: "submit" }, spec.submit || "Send"));
      form.addEventListener("submit", (e) => { e.preventDefault(); const out = {}; for (const k of Object.keys(vals)) out[k] = vals[k](); send(out); });
      card.append(form);
    } else {
      card.append(h("strong", {}, spec.text || "The function asks"));
      if (spec.choices && spec.choices.length) card.append(h("div", { class: "fn-row" }, ...spec.choices.map((c) => h("button", { class: "btn btn--sm", onclick: () => send(c) }, c))));
      else {
        const input = h("input", { class: "input input--sm", placeholder: spec.placeholder || "Your answer" });
        const form = h("form", { class: "fn-row" }, input, h("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Send"));
        form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
        card.append(form);
        setTimeout(() => input.focus(), 30);
      }
    }
    return card;
  }

  /* ============================================================== builder */

  function builderView() {
    const B = window.M5FnBuilder;
    if (!B || !ED()) return h("div", { class: "card warn" }, "The visual builder needs vendor/m5-editor.js — run ", h("code", {}, "npm run build"), " on the server.");
    return B.view({ C, data, sdk, reload: load, openPackage: async (id) => { await load(); await openPackage(id); }, editModel: async (id) => { await load(); const m = data.models.find((x) => x.id === id); if (m) editModel(m); }, liveRunInto, renderOutput: OUT, formDialog, confirmDialog });
  }

  /* ============================================================== models */

  function modelsView() {
    const wrap = h("div", { class: "fn-cols" });
    const list = h("div", { class: "fn-side card" });
    list.append(h("div", { class: "fn-side__head" }, h("span", {}, "Models"), writable() ? h("button", { class: "btn btn--sm btn--primary", onclick: () => editModel(null) }, "+ New") : null));
    if (!data.models.length) list.append(h("div", { class: "muted small p8" }, "No models yet. A model makes a published package runnable — from the chat (/keyword), a webhook, the API or a schedule."));
    for (const m of data.models) {
      const on = modelDraft && modelDraft.id === m.id;
      list.append(h("button", { class: `fn-pkg${on ? " fn-pkg--on" : ""}`, title: m.summary || m.name, onclick: () => editModel(m) },
        h("span", { class: `fn-dot fn-dot--${m.enabled ? "on" : "off"}`, title: m.enabled ? "on" : "off" }),
        h("span", { class: "fn-pkg__name" }, m.name),
        m.keyword ? h("span", { class: "badge badge--accent" }, "/" + m.keyword) : null,
        m.entryOk ? null : h("span", { class: "badge badge--err", title: "The entry package/version is not published." }, "entry?")));
    }
    wrap.append(list);
    wrap.append(modelDraft ? modelForm() : h("div", { class: "card empty" }, "Pick a model, or create one."));
    return wrap;
  }

  function editModel(m) {
    modelDraft = m ? JSON.parse(JSON.stringify(m)) : { id: "", name: "", keyword: "", summary: "", entry: "", onEvent: "", runtime: "server", inputs: [], outputs: ["markdown"], limits: {}, executors: { chat: { enabled: true, visibility: "room" }, console: { enabled: true } }, groups: [], enabled: false };
    tab = "models"; render();
  }

  function newModelFor(pkg) {
    const published = pkg.versions.filter((v) => v.status === "published");
    if (!published.length) { toast("Publish a version first — a model runs a published version.", "err"); return; }
    const ver = published[published.length - 1].version;
    const main = (published[published.length - 1].manifest && published[published.length - 1].manifest.main) || (pkg.package.language === "py" ? "index.py" : "index.js");
    editModel(null);
    Object.assign(modelDraft, { name: pkg.package.name, keyword: pkg.package.name.replace(/[^a-z0-9]/g, ""), summary: pkg.package.description || "", entry: `${pkg.package.name}@${ver}:${main}#execute` });
    render();
  }

  function modelForm() {
    const m = modelDraft;
    const form = h("div", { class: "fn-form card" });
    const ro = !writable();
    const text = (label, key, ph, hint) => h("label", { class: "field" }, h("span", { class: "label" }, label), h("input", { class: "input", value: m[key] || "", placeholder: ph || "", disabled: ro, oninput: (e) => { m[key] = e.target.value; if (key === "keyword") hintEl.textContent = chatHint(); } }), hint ? h("span", { class: "muted small" }, hint) : null);
    const chatHint = () => m.keyword ? `In the chat: /${m.keyword}${(m.inputs || []).filter((i) => i.required).map((i) => ` <${i.name}>`).join("")}` : "Without a keyword it is not a chat command.";
    const hintEl = h("span", { class: "muted small" }, chatHint());

    form.append(h("div", { class: "fn-side__head" }, h("strong", {}, m.id ? `Model: ${m.name || m.id}` : "New model"),
      h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: m.enabled, disabled: ro, onchange: (e) => { m.enabled = e.target.checked; } }), " enabled")));

    form.append(h("div", { class: "fn-grid2" }, text("Name", "name", "Weather"), h("div", {}, text("Keyword (chat: /keyword)", "keyword", "pocasi"), hintEl)));
    form.append(text("Summary", "summary", "What it does, shown in the /command hint"));

    // 5.3: the package version the model runs, and its entry points in it.
    const pkgs = data.packages.filter((p) => p.versions.length);
    const anchorRow = h("div", { class: "fn-grid3" });
    const pkgSel = h("select", { class: "input", disabled: ro });
    pkgSel.append(h("option", { value: "" }, pkgs.length ? "— package —" : "— publish a package first —"));
    for (const p of pkgs) pkgSel.append(h("option", { value: p.name }, `${p.name} (${p.language})`));
    const verSel = h("select", { class: "input", disabled: ro });
    const parsed = /^([^@]+)@([^:]+):(.+)#(.+)$/.exec(m.entry || "");
    if (parsed) pkgSel.value = parsed[1];
    if (!Array.isArray(m.endpoints) || !m.endpoints.length) m.endpoints = [{ id: "execute", type: "execute", fn: parsed ? `${parsed[3]}#${parsed[4]}` : "", inputs: m.inputs || [], enabled: true }];
    const execEp = () => m.endpoints.find((e) => e.type === "execute");
    // The test form and the chat hint read the execute entry point's inputs.
    if (execEp()) { execEp().inputs = execEp().inputs || []; m.inputs = execEp().inputs; }
    let exportsInfo = null;
    const epBox = h("div", { class: "fn-eps" });
    const syncEntry = () => {
      const ex = execEp();
      m.entry = pkgSel.value && verSel.value && ex && ex.fn && ex.fn.includes("#") ? `${pkgSel.value}@${verSel.value}:${ex.fn}` : "";
    };
    const loadExports = async () => {
      exportsInfo = null;
      if (pkgSel.value && verSel.value) { try { exportsInfo = await api(`/admin/functions/exports?package=${encodeURIComponent(pkgSel.value)}&version=${encodeURIComponent(verSel.value)}`); } catch { exportsInfo = null; } }
      drawEndpoints();
    };
    const fillVers = () => {
      clear(verSel);
      const p = pkgs.find((x) => x.name === pkgSel.value);
      for (const v of (p ? [...p.versions].reverse() : [])) verSel.append(h("option", { value: v }, v));
      if (parsed && pkgSel.value === parsed[1]) verSel.value = parsed[2];
      const ex = execEp();
      if (p && ex && !ex.fn) ex.fn = `${p.language === "py" ? "index.py" : "index.js"}#execute`;
      syncEntry();
      void loadExports();
    };
    pkgSel.onchange = fillVers; verSel.onchange = () => { syncEntry(); void loadExports(); };
    anchorRow.append(h("label", { class: "field" }, h("span", { class: "label" }, "Package"), pkgSel), h("label", { class: "field" }, h("span", { class: "label" }, "Version"), verSel),
      h("div", { class: "field" }, h("span", { class: "label" }, " "), h("div", { class: "fn-row" },
        h("button", { class: "btn btn--xs", onclick: () => { const p = pkgOf(); if (p) openPackage(p.id); } }, "Open the package"),
        h("button", { class: "btn btn--xs", onclick: () => { const p = pkgOf(); if (p && p.flow && window.M5FnBuilder) api(`/admin/functions/packages/${encodeURIComponent(p.id)}`).then((d) => { window.M5FnBuilder.openFromPackage(d.package, JSON.parse(d.draft.files["flow.m5flow.json"])); go("builder"); }).catch((e) => toast(e.message, "err")); else toast("That package was not made in the builder.", "err"); } }, "◇ Open its flow"))));
    const pkgOf = () => data.packages.find((p) => p.name === pkgSel.value);
    const entryFs = h("fieldset", { class: "fn-fs" }, h("legend", {}, "Entry points"),
      h("p", { class: "muted small" }, "Which function answers which call: ", h("b", {}, "execute"), " (the chat command, the console, the API, a schedule), ", h("b", {}, "response"), " (a reply to the model's message), ", h("b", {}, "button"), " and ", h("b", {}, "form"), " (a click, a sent form), ", h("b", {}, "error"), " (another entry point failed, or the browser could not show a result) — one of each; ", h("b", {}, "webhook"), " — as many as you need, each with its own URL. Each has its inputs; the function also gets m5.model (the processing session: calls, current, last)."),
      anchorRow, epBox);
    form.append(entryFs);
    fillVers();

    const TYPE_HELP = { execute: "the start", response: "a reply to its message", button: "a click on its button", form: "a sent form", error: "another entry point failed", webhook: "an inbound HTTP call" };
    function fnOptions(ep) {
      const out = [];
      if (exportsInfo && exportsInfo.files) for (const [file, fns] of Object.entries(exportsInfo.files)) for (const fn of fns) out.push(`${file}#${fn}`);
      if (ep.fn && !out.includes(ep.fn)) out.unshift(ep.fn);
      return out;
    }
    function suggestFn(type) {
      const all = fnOptions({ fn: "" });
      const main = (exportsInfo && exportsInfo.main) || (pkgOf() && pkgOf().language === "py" ? "index.py" : "index.js");
      return all.find((x) => x.endsWith(`#${type}`)) || (all.length ? (type === "webhook" ? (execEp() ? execEp().fn : all[0]) : `${main}#${type}`) : `${main}#${type}`);
    }
    function drawEndpoints() {
      clear(epBox);
      for (const ep of m.endpoints) epBox.append(endpointRow(ep));
      if (ro) return;
      const present = new Set(m.endpoints.map((e) => e.type));
      const addSel = h("select", { class: "input input--sm" });
      for (const t of ["response", "button", "form", "error", "webhook"]) if (t === "webhook" || !present.has(t)) addSel.append(h("option", { value: t }, `${t} — ${TYPE_HELP[t]}`));
      epBox.append(h("div", { class: "fn-row mt8" }, addSel, h("button", { class: "btn btn--sm", onclick: () => {
        const t = addSel.value;
        if (!t) return;
        const ep = { id: t === "webhook" ? "" : t, type: t, fn: suggestFn(t), inputs: [], enabled: true };
        if (t === "webhook") Object.assign(ep, { name: `Webhook ${m.endpoints.filter((e) => e.type === "webhook").length + 1}`, mode: "sync", auth: "none", log: "full", callback: false });
        m.endpoints.push(ep);
        drawEndpoints();
      } }, "+ Entry point"), exportsInfo ? h("span", { class: "muted small" }, `functions in ${pkgSel.value}@${verSel.value}: ${Object.values(exportsInfo.files || {}).flat().join(", ") || "none found"}`) : null));
    }
    function endpointRow(ep) {
      const card = h("div", { class: `fn-ep fn-ep--${ep.type}${ep.enabled === false ? " fn-ep--off" : ""}` });
      const fnSel = h("select", { class: "input input--sm fn-mono", disabled: ro });
      for (const f of fnOptions(ep)) fnSel.append(h("option", { value: f, selected: f === ep.fn || null }, f));
      fnSel.append(h("option", { value: "__other" }, "other… (type file#function)"));
      fnSel.onchange = () => { if (fnSel.value === "__other") { const v = window.prompt("file#function", ep.fn || "index.js#execute"); if (v && /^[^#\s]+#[A-Za-z_$][\w$]*$/.test(v)) ep.fn = v; drawEndpoints(); return; } ep.fn = fnSel.value; if (ep.type === "execute") syncEntry(); };
      const missing = exportsInfo && ep.fn && !fnOptions({ fn: "" }).includes(ep.fn);
      const head = h("div", { class: "fn-ep__head" },
        h("span", { class: `badge fn-ep__type fn-ep__type--${ep.type}` }, ep.type),
        ep.type === "webhook" ? h("input", { class: "input input--sm fn-ep__name", value: ep.name || "", placeholder: "name", disabled: ro, oninput: (e) => { ep.name = e.target.value; } }) : h("span", { class: "muted small fn-ep__what" }, TYPE_HELP[ep.type]),
        fnSel,
        missing ? h("span", { class: "badge badge--err", title: "The version does not export this function." }, "not found") : null,
        h("span", { class: "fn-grow" }),
        ep.type === "execute" ? null : h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: ep.enabled !== false, disabled: ro, onchange: (e) => { ep.enabled = e.target.checked; card.classList.toggle("fn-ep--off", !e.target.checked); } }), " on"),
        ro || ep.type === "execute" ? null : h("button", { class: "fn-file__x", title: "Remove the entry point", onclick: () => { m.endpoints = m.endpoints.filter((x) => x !== ep); drawEndpoints(); } }, "×"));
      card.append(head);
      if (ep.type === "webhook") card.append(webhookSettings(ep));
      // Its inputs: what the type always brings, and what it declares.
      const fields = (exportsInfo && exportsInfo.fields && exportsInfo.fields[ep.type]) || [];
      const det = h("details", { class: "fn-ep__inputs", open: ep.type === "execute" || (ep.inputs || []).length ? true : null });
      det.append(h("summary", { class: "small" }, `Inputs${(ep.inputs || []).length ? ` (${ep.inputs.length})` : ""}`, ep.type === "webhook" ? h("span", { class: "muted" }, " — the JSON body (application/json), checked and typed; other fields pass as they are") : ep.type === "execute" ? h("span", { class: "muted" }, " — the command's arguments") : h("span", { class: "muted" }, ep.type === "response" ? " — read from the reply like a command's arguments" : ep.type === "button" ? " — read from the button's data" : ep.type === "form" ? " — read from the form's values" : "")));
      if (fields.length) det.append(h("div", { class: "fn-ep__sys" }, h("span", { class: "muted small" }, "Always: "), ...fields.map((f) => h("code", { class: "fn-ep__field", title: f.help }, `${f.name}: ${f.type}`))));
      ep.inputs = ep.inputs || [];
      det.append(inputsList(ep, ro, ep.type === "webhook" ? JSON_INPUT_TYPES : INPUT_TYPES, () => { if (ep.type === "execute") { m.inputs = ep.inputs; hintEl.textContent = chatHint(); } }));
      card.append(det);
      return card;
    }
    function webhookSettings(ep) {
      const box = h("div", { class: "fn-ep__hook" });
      if (ep.url) box.append(h("div", { class: "fn-row" }, h("input", { class: "input input--sm fn-mono fn-grow", readonly: "readonly", value: ep.url }), h("button", { class: "btn btn--xs", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(ep.url); toast("URL copied.", "ok"); } }, "Copy URL"),
        h("button", { class: "btn btn--xs", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(`curl -X POST -H 'Content-Type: application/json' -d '{}' ${shq(ep.url)}`); toast("curl copied.", "ok"); } }, "curl")));
      else if (ep.hidden) box.append(h("div", { class: "muted small" }, "The URL is hidden — only who may change this model's webhooks sees it."));
      else box.append(h("div", { class: "muted small" }, ep.enabled === false ? "Switched off — no URL." : "Save the model: the URL is made then."));
      const sel = (key, values, label) => { const s = h("select", { class: "input input--sm", disabled: ro }); for (const [v, l] of values) s.append(h("option", { value: v, selected: (ep[key] || values[0][0]) === v || null }, l)); s.onchange = () => { ep[key] = s.value; if (key === "auth") redrawSecret(); }; return h("label", { class: "field" }, h("span", { class: "label" }, label), s); };
      const secretBox = h("div", {});
      const redrawSecret = () => { clear(secretBox); if (ep.auth === "hmac") secretBox.append(h("label", { class: "field" }, h("span", { class: "label" }, "HMAC secret (X-Signature: sha256 of the body)"), h("input", { class: "input input--sm fn-mono", type: "password", placeholder: ep.hasSecret ? "(kept — type to change)" : "a shared secret", disabled: ro, oninput: (e) => { ep.secret = e.target.value; } }))); };
      box.append(h("div", { class: "fn-grid3" },
        sel("mode", [["sync", "sync — answers with the outputs"], ["async", "async — 202 and a status URL"], ["auto", "auto — sync if quick, else async"]], "Mode"),
        sel("auth", [["none", "the secret URL"], ["hmac", "the URL + an HMAC signature"]], "Checks"),
        sel("log", [["full", "full (headers, bodies)"], ["meta", "no bodies"], ["off", "off"]], "Log")));
      box.append(secretBox, h("div", { class: "fn-row" },
        h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: ep.callback || null, disabled: ro, onchange: (e) => { ep.callback = e.target.checked; } }), " callback (?callback= / X-Callback-URL)"),
        ro || !ep.url ? null : h("button", { class: "btn btn--xs btn--danger", onclick: () => { ep.token = "rotate"; toast("A new URL is made when you save; the old one stops working.", "ok"); } }, "New URL on save")));
      redrawSecret();
      return box;
    }

    // runtime + visibility + groups
    const rtSel = h("select", { class: "input", disabled: ro });
    for (const [v, l] of [["server", "server (has HTTP, cache, secrets)"], ["auto", "auto"], ["browser", "browser (not wired yet)"]]) rtSel.append(h("option", { value: v, selected: m.runtime === v }, l));
    rtSel.onchange = (e) => { m.runtime = e.target.value; };
    const visSel = h("select", { class: "input", disabled: ro });
    for (const [v, l] of [["room", "post to the room"], ["caller", "only the caller sees it"]]) visSel.append(h("option", { value: v, selected: m.executors.chat.visibility === v }, l));
    visSel.onchange = (e) => { m.executors.chat.visibility = e.target.value; };
    const chatOn = h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: m.executors.chat.enabled, disabled: ro, onchange: (e) => { m.executors.chat.enabled = e.target.checked; } }), " chat command");
    form.append(h("div", { class: "fn-grid3" }, h("label", { class: "field" }, h("span", { class: "label" }, "Runs"), rtSel), h("label", { class: "field" }, h("span", { class: "label" }, "Output goes"), visSel), h("label", { class: "field" }, h("span", { class: "label" }, "Executor"), chatOn)));
    form.append(groupsField(m, ro));
    form.append(grantsField(m, ro));

    // the API (webhooks are entry points above)
    if (!m.executors.api) m.executors.api = { enabled: false };
    const apiOn = h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: m.executors.api.enabled, disabled: ro, onchange: (e) => { m.executors.api.enabled = e.target.checked; } }), " API (bearer token) — runs the execute entry point");
    const hookBox = h("fieldset", { class: "fn-fs" }, h("legend", {}, "API"), apiOn);
    const copyField = (label, value, note) => h("label", { class: "field mt8" }, h("span", { class: "label" }, label), h("div", { class: "fn-row" }, h("input", { class: "input fn-mono", readonly: "readonly", value }), h("button", { class: "btn btn--sm", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(value); toast("Copied.", "ok"); } }, "Copy")), note ? h("span", { class: "muted small" }, note) : null);
    if (m.secretsHidden) hookBox.append(h("p", { class: "muted small" }, "The webhook URLs, their HMAC secrets and the API token are hidden: only who may change this model's webhooks sees them (Modules & groups › Functions)."));
    if (m.executors.api.enabled && m.executors.api.token) hookBox.append(copyField(`API — POST /api/functions/call/${m.id}`, `curl -X POST -H "Authorization: Bearer ${m.executors.api.token}" -H "Content-Type: application/json" -d '{}' ${location.origin.replace(/\/$/, "")}/api/functions/call/${m.id}`, "Replace the host with the chat's address if the console runs elsewhere."));
    form.append(hookBox);

    // actions + test
    const actions = h("div", { class: "fn-editor__actions mt8" });
    if (writable()) actions.append(h("button", { class: "btn btn--primary", onclick: saveModel }, "Save model"), m.id ? h("button", { class: "btn btn--danger", onclick: deleteModel }, "Delete") : "");
    form.append(actions);
    if (m.id) form.append(testForm(m));
    return form;

    async function saveModel() {
      syncEntry();
      const ex = execEp();
      if (ex) m.inputs = ex.inputs;
      // Tokens and secrets the console was not shown are kept by the server; "rotate" makes a new URL.
      const body = { ...m, endpoints: m.endpoints.map((e) => { const { url: _u, hidden: _h, hasSecret: _s, ...rest } = e; return rest; }) };
      try { const r = await api("/admin/functions/models", { method: "POST", body }); toast(`Model ${r.model.name} saved.`, "ok"); modelDraft = r.model; await load(); }
      catch (e) { toast(e.message, "err"); }
    }
    async function deleteModel() {
      if (!(await confirmDialog(`Delete model “${m.name}”? Its schedules stop too.`, true))) return;
      try { await api(`/admin/functions/models/${encodeURIComponent(m.id)}`, { method: "DELETE" }); toast("Model deleted.", "ok"); modelDraft = null; await load(); }
      catch (e) { toast(e.message, "err"); }
    }
  }

  /** A typed form for a test run of a saved model (inputs by their schema). */
  function testForm(m) {
    const fs = h("fieldset", { class: "fn-fs" }, h("legend", {}, "Test run"));
    const getters = {};
    const grid = h("div", { class: "fn-testform" });
    for (const inp of m.inputs || []) {
      if (!inp.name) continue;
      let input;
      if (inp.type === "enum") { input = h("select", { class: "input input--sm" }); input.append(h("option", { value: "" }, "—")); for (const v of inp.values || []) input.append(h("option", { value: v, selected: String(inp.default) === v }, v)); }
      else if (inp.type === "boolean") input = h("input", { type: "checkbox", checked: inp.default === true || inp.default === "true" });
      else if (inp.type === "text" || inp.type === "json") input = h("textarea", { class: "input input--sm fn-mono", rows: 2, placeholder: inp.default !== undefined ? String(inp.default) : inp.type });
      else input = h("input", { class: "input input--sm", type: inp.type === "integer" || inp.type === "number" ? "number" : inp.type === "date" ? "date" : inp.type === "time" ? "time" : inp.type === "email" ? "email" : inp.type === "url" ? "url" : "text", placeholder: inp.default !== undefined ? String(inp.default) : inp.type });
      getters[inp.name] = () => (input.type === "checkbox" ? input.checked : input.value);
      grid.append(h("label", { class: "fn-ti" }, h("span", { class: "small" }, (inp.label || inp.name) + (inp.required ? " *" : ""), h("span", { class: "muted" }, ` · ${inp.type}`)), input));
    }
    if (!Object.keys(getters).length) grid.append(h("span", { class: "muted small" }, "This model takes no inputs."));
    const result = h("div", { class: "fn-run__result" });
    const btn = h("button", { class: "btn btn--primary btn--sm", onclick: () => {
      const vals = {};
      for (const [k, g] of Object.entries(getters)) { const v = g(); if (v !== "" && v !== false) vals[k] = v; else if (v === false) vals[k] = false; }
      liveRunInto(result, { modelId: m.id, inputs: vals });
    } }, "▶ Test run");
    fs.append(grid, h("div", { class: "fn-row mt8" }, btn, h("span", { class: "muted small" }, "Runs the saved model as a test (inputs are checked by the schema).")), result);
    return fs;
  }

  function groupsField(m, ro) {
    const box = h("div", { class: "field" }, h("span", { class: "label" }, "Groups that may use it (none = everyone the module allows)"));
    const row = h("div", { class: "fn-groups" });
    for (const g of (data.groups || [])) {
      const on = m.groups.includes(g.id);
      row.append(h("label", { class: `fn-chip${on ? " fn-chip--on" : ""}` }, h("input", { type: "checkbox", checked: on, disabled: ro, onchange: (e) => { if (e.target.checked) m.groups.push(g.id); else m.groups = m.groups.filter((x) => x !== g.id); e.target.parentElement.classList.toggle("fn-chip--on", e.target.checked); } }), g.label || g.id));
    }
    box.append(row);
    return box;
  }

  // 6.0: what the model's code may do beyond its caller — m5adm (only an owner grants it, and a
  // model that has it is the owner's to change) and m5.telephony for runs nobody started.
  const ADM_AREAS = [["overview", "Overview"], ["rooms", "Rooms"], ["connections", "Connections"], ["traffic", "Live traffic"], ["modules", "Modules & groups"], ["users", "Users & passkeys"], ["queue", "Message queue"], ["audit", "Audit log"], ["commands", "Commands & push"], ["admins", "Administrators"]];
  const TEL_RIGHTS = [["call", "calls"], ["sms", "SMS"], ["lookup", "number lookup"], ["hlr", "HLR"], ["message", "WhatsApp · Viber · Messenger"], ["did", "temporary numbers (audio bridge)"]];
  function grantsField(m, ro) {
    m.grants = m.grants || {};
    const owner = C.can("owner");
    const adm = m.grants.admin || { enabled: false, role: "auditor", areas: [] };
    const tel = m.grants.telephony || { enabled: false, rights: [] };
    const box = h("fieldset", { class: "fn-fs" }, h("legend", {}, "Beyond the caller"));
    const admRo = ro || !owner;
    const setAdm = () => { m.grants.admin = { ...adm }; };
    const areaRow = h("div", { class: "fn-groups" });
    for (const [id, label] of ADM_AREAS) {
      const on = adm.areas.includes(id);
      areaRow.append(h("label", { class: `fn-chip${on ? " fn-chip--on" : ""}` }, h("input", { type: "checkbox", checked: on, disabled: admRo, "data-adm-area": id, onchange: (e) => { adm.areas = e.target.checked ? [...adm.areas, id] : adm.areas.filter((x) => x !== id); e.target.parentElement.classList.toggle("fn-chip--on", e.target.checked); setAdm(); } }), label));
    }
    const roleSel = h("select", { class: "input input--sm", disabled: admRo, "data-adm-role": "1", onchange: (e) => { adm.role = e.target.value; setAdm(); } });
    for (const [v, l] of [["auditor", "auditor — read"], ["operator", "operator — act"], ["owner", "owner — also administrators"]]) roleSel.append(h("option", { value: v, selected: adm.role === v }, l));
    box.append(
      h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: adm.enabled, disabled: admRo, "data-adm-on": "1", onchange: (e) => { adm.enabled = e.target.checked; setAdm(); } }), " m5adm — the administration (every call goes through the console's own routes and the audit journal, as fn:<model>)"),
      h("div", { class: "fn-row mt8" }, h("span", { class: "small" }, "Role"), roleSel),
      h("span", { class: "label mt8" }, "Areas"), areaRow,
      h("p", { class: "muted small" }, owner
        ? "Whoever runs this model acts with this role in these areas. Once given, only an owner may change the model (anyone may switch it off)."
        : "Only an owner gives a model access to the administration or changes a model that has it."),
    );
    const telRow = h("div", { class: "fn-groups" });
    const setTel = () => { m.grants.telephony = { enabled: tel.enabled, rights: [...tel.rights] }; };
    for (const [id, label] of TEL_RIGHTS) {
      const on = tel.rights.includes(id);
      telRow.append(h("label", { class: `fn-chip${on ? " fn-chip--on" : ""}` }, h("input", { type: "checkbox", checked: on, disabled: ro, onchange: (e) => { tel.rights = e.target.checked ? [...tel.rights, id] : tel.rights.filter((x) => x !== id); e.target.parentElement.classList.toggle("fn-chip--on", e.target.checked); setTel(); } }), label));
    }
    const numbers = h("input", { class: "input input--sm fn-mono", disabled: ro, placeholder: "number:+420* -number:+4209*", value: tel.rights.filter((r) => r.includes(":")).join(" "), onchange: (e) => { tel.rights = [...tel.rights.filter((r) => !r.includes(":")), ...e.target.value.split(/\s+/).filter(Boolean)]; setTel(); } });
    box.append(
      h("label", { class: "fn-switch mt8" }, h("input", { type: "checkbox", checked: tel.enabled, disabled: ro, onchange: (e) => { tel.enabled = e.target.checked; setTel(); } }), " m5.telephony when nobody started the run (a webhook, a schedule, the API, a provider's call event)"),
      telRow,
      h("label", { class: "field mt8" }, h("span", { class: "label" }, "Which numbers (patterns; empty = any)"), numbers),
      h("p", { class: "muted small" }, "A person's run also needs their own Telephony & SIP rights (Modules & groups)."),
    );
    return box;
  }

  const INPUT_TYPES = ["string", "text", "integer", "number", "boolean", "enum", "date", "time", "duration", "url", "hostname", "email", "ip", "json", "object", "array", "user", "file"];
  // 5.3: a webhook's inputs are the fields of a JSON body.
  const JSON_INPUT_TYPES = ["string", "number", "integer", "boolean", "object", "array", "json", "enum", "email", "url", "date", "time"];

  /** An editable list of input specs (target.inputs). */
  function inputsList(target, ro, types = INPUT_TYPES, onChange = () => undefined) {
    const list = h("div", { class: "fn-inputs" });
    const box = h("div", {}, list);
    const redraw = () => {
      clear(list);
      onChange();
      if (target.inputs.length) list.append(h("div", { class: "fn-input-row fn-input-row--head muted small" }, h("span", {}, "name"), h("span", {}, "type"), h("span", {}, "label"), h("span", {}, "default"), h("span", {}, "required"), h("span", {}, "")));
      target.inputs.forEach((inp, i) => {
        const typeSel = h("select", { class: "input input--sm", disabled: ro });
        for (const t of types) typeSel.append(h("option", { value: t, selected: inp.type === t }, t));
        if (!types.includes(inp.type)) typeSel.append(h("option", { value: inp.type, selected: true }, inp.type));
        typeSel.onchange = (e) => { inp.type = e.target.value; redraw(); };
        const row = h("div", { class: "fn-input-row" },
          h("input", { class: "input input--sm fn-mono", value: inp.name || "", placeholder: "name", disabled: ro, oninput: (e) => { inp.name = e.target.value; onChange(); } }),
          typeSel,
          h("input", { class: "input input--sm", value: inp.label || "", placeholder: "label", disabled: ro, oninput: (e) => { inp.label = e.target.value; } }),
          h("input", { class: "input input--sm", value: inp.default === undefined ? "" : typeof inp.default === "object" ? JSON.stringify(inp.default) : inp.default, placeholder: "default", disabled: ro, oninput: (e) => { inp.default = e.target.value || undefined; } }),
          h("label", { class: "fn-req" }, h("input", { type: "checkbox", checked: inp.required, disabled: ro, onchange: (e) => { inp.required = e.target.checked; onChange(); } }), "req"),
          writable() ? h("span", { class: "fn-row" },
            h("button", { class: "btn btn--xs", title: "Move up", disabled: i === 0 ? true : null, onclick: () => { target.inputs.splice(i - 1, 0, target.inputs.splice(i, 1)[0]); redraw(); } }, "↑"),
            h("button", { class: "fn-file__x", title: "Remove", onclick: () => { target.inputs.splice(i, 1); redraw(); } }, "×")) : null);
        list.append(row);
        if (inp.type === "enum") list.append(h("input", { class: "input input--sm fn-enum", value: (inp.values || []).join(", "), placeholder: "enum values, comma-separated", disabled: ro, oninput: (e) => { inp.values = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); } }));
      });
    };
    redraw();
    if (writable() && !ro) box.append(h("button", { class: "btn btn--xs", onclick: () => { target.inputs.push({ name: "", type: "string" }); redraw(); } }, "+ Input"));
    return box;
  }

  /* ============================================================ schedules */

  const CRON_PRESETS = [["*/5 * * * *", "every 5 minutes"], ["*/15 * * * *", "every 15 minutes"], ["0 * * * *", "every hour"], ["0 8 * * *", "daily at 8:00"], ["0 8 * * 1-5", "weekdays at 8:00"], ["0 0 * * 0", "Sundays at midnight"], ["@daily", "@daily"]];

  function schedulesView() {
    const wrap = h("div", { class: "stack" });
    const card = h("div", { class: "card" });
    card.append(h("div", { class: "fn-side__head" }, h("span", {}, "Schedules (cron)")));
    const list = h("div", {});
    if (!data.schedules || !data.schedules.length) list.append(h("div", { class: "muted small p8" }, "No schedules yet."));
    else {
      const table = h("table", { class: "tbl" });
      table.append(h("thead", {}, h("tr", {}, ...["Model", "Cron", "TZ", "State", "Last run", ""].map((t) => h("th", {}, t)))));
      const tb = h("tbody", {});
      for (const s of data.schedules) {
        const model = data.models.find((m) => m.id === s.modelId);
        const preset = CRON_PRESETS.find((p) => p[0] === s.cron);
        tb.append(h("tr", {},
          h("td", {}, model ? model.name : s.modelId),
          h("td", {}, h("code", {}, s.cron), preset ? h("span", { class: "muted small" }, `  ${preset[1]}`) : null),
          h("td", {}, s.tz),
          h("td", {}, h("span", { class: `badge badge--${s.enabled ? "ok" : ""}` }, s.enabled ? "on" : "off")),
          h("td", {}, s.lastRun ? new Date(s.lastRun).toLocaleString() : "—"),
          h("td", {}, writable() ? h("span", { class: "fn-row" },
            h("button", { class: "btn btn--sm", onclick: () => runSchedule(s.id) }, "Run now"),
            h("button", { class: "btn btn--sm btn--danger", onclick: () => delSchedule(s.id) }, "×")) : null)));
      }
      table.append(tb); list.append(table);
    }
    card.append(list);
    if (writable()) card.append(scheduleForm());
    wrap.append(card);
    return wrap;
  }

  function scheduleForm() {
    const box = h("fieldset", { class: "fn-fs mt8" }, h("legend", {}, "New schedule"));
    const modelSel = h("select", { class: "input" });
    modelSel.append(h("option", { value: "" }, "— model —"));
    for (const m of data.models) if (m.entryOk) modelSel.append(h("option", { value: m.id }, m.name));
    const cron = h("input", { class: "input fn-mono", placeholder: "*/15 * * * *  (or @daily)" });
    const presets = h("select", { class: "input input--sm", onchange: (e) => { if (e.target.value) cron.value = e.target.value; } });
    presets.append(h("option", { value: "" }, "presets…"));
    for (const [v, l] of CRON_PRESETS) presets.append(h("option", { value: v }, `${l}  (${v})`));
    const tz = h("input", { class: "input", value: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", placeholder: "UTC / Europe/Prague" });
    const inputs = h("textarea", { class: "input fn-mono", rows: 2, placeholder: "{ } inputs" }, "{}");
    const msg = h("span", { class: "muted small" });
    box.append(h("div", { class: "fn-grid3" },
      h("label", { class: "field" }, h("span", { class: "label" }, "Model"), modelSel),
      h("label", { class: "field" }, h("span", { class: "label" }, "Cron (min hour dom mon dow)"), cron, presets),
      h("label", { class: "field" }, h("span", { class: "label" }, "Time zone"), tz)));
    box.append(h("label", { class: "field" }, h("span", { class: "label" }, "Inputs (JSON)"), inputs));
    box.append(h("div", { class: "fn-row" }, h("button", { class: "btn btn--primary btn--sm", onclick: add }, "Add schedule"), msg));
    return box;

    async function add() {
      let parsed; try { parsed = JSON.parse(inputs.value || "{}"); } catch { msg.textContent = "Inputs are not JSON."; return; }
      try { await api("/admin/functions/schedules", { method: "POST", body: { modelId: modelSel.value, cron: cron.value.trim(), tz: tz.value.trim() || "UTC", inputs: parsed, enabled: true } }); toast("Schedule added.", "ok"); await load(); }
      catch (e) { msg.textContent = e.message; }
    }
  }

  async function runSchedule(id) {
    try { const r = await api(`/admin/functions/schedules/${encodeURIComponent(id)}/run`, { method: "POST", body: {} }); toast(`Ran: ${r.run.status}.`, r.run.status === "done" ? "ok" : "err"); }
    catch (e) { toast(e.message, "err"); }
  }
  async function delSchedule(id) {
    if (!(await confirmDialog("Delete this schedule?", true))) return;
    try { await api(`/admin/functions/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("Deleted.", "ok"); await load(); }
    catch (e) { toast(e.message, "err"); }
  }

  /* ============================================================= tutorial */

  function tutorialView() {
    if (!lessons) {
      api("/admin/functions/tutorial").then((d) => { lessons = d.lessons || []; lessonId = lessonId || (lessons[0] && lessons[0].id); render(); }).catch((e) => toast(e.message, "err"));
      return h("div", { class: "card empty" }, "Loading…");
    }
    const wrap = h("div", { class: "fn-cols" });
    const side = h("div", { class: "fn-side card" });
    const done = tutDone();
    side.append(h("div", { class: "fn-side__head" }, h("span", {}, "Tutorial"), h("span", { class: "muted small" }, `${lessons.filter((l) => done.has(l.id)).length}/${lessons.length}`)));
    lessons.forEach((l, i) => {
      side.append(h("button", { class: `fn-pkg${l.id === lessonId ? " fn-pkg--on" : ""}`, onclick: () => { lessonId = l.id; render(); } },
        h("span", { class: "muted small" }, `${i + 1}.`),
        h("span", { class: "fn-pkg__name" }, l.title),
        done.has(l.id) ? h("span", { class: "badge badge--ok" }, "✓") : h("span", { class: "badge" }, l.lang.toUpperCase())));
    });
    wrap.append(side);
    const lesson = lessons.find((l) => l.id === lessonId) || lessons[0];
    wrap.append(lesson ? lessonPane(lesson) : h("div", { class: "card empty" }, "Pick a lesson."));
    return wrap;
  }

  function lessonPane(lesson) {
    const pane = h("div", { class: "fn-editor-pane card" });
    pane.append(h("div", { class: "fn-editor__head" }, h("span", { class: `fn-lang fn-lang--${lesson.lang}` }, lesson.lang.toUpperCase()), h("strong", { class: "fn-title" }, lesson.title)));
    pane.append(h("div", { class: "fn-md" }, mdBlock(lesson.body)));
    const host = h("div", { class: "fn-cm" });
    let getCode;
    const E = ED();
    const result = h("div", { class: "fn-run__result" });
    if (E) { const ed = mount(E.create(host, { doc: lesson.sample, lang: lesson.lang, sdk: sdk.spec || [], minHeight: "160px", maxHeight: "50vh", onRun: () => run() })); getCode = () => ed.getValue(); }
    else { const ta = h("textarea", { class: "fn-editor", spellcheck: "false", wrap: "off", style: "min-height:180px" }); ta.value = lesson.sample; host.append(ta); getCode = () => ta.value; }
    pane.append(host);
    const runBtn = h("button", { class: "btn btn--primary btn--sm", onclick: () => run(), title: "Ctrl/⌘+Enter" }, "▶ Run");
    const idx = lessons.indexOf(lesson);
    const nextBtn = idx < lessons.length - 1 ? h("button", { class: "btn btn--sm", onclick: () => { lessonId = lessons[idx + 1].id; render(); } }, "Next lesson →") : null;
    pane.append(h("div", { class: "fn-run__row mt8" }, runBtn, lesson.inputs ? h("span", { class: "muted small" }, "inputs: " + JSON.stringify(lesson.inputs)) : null, h("span", { class: "fn-grow" }), nextBtn));
    pane.append(result);
    return pane;

    function run() {
      const file = lesson.lang === "py" ? "main.py" : "index.js";
      liveRunInto(result, { adhoc: { lang: lesson.lang, files: { [file]: getCode() }, file, fn: "execute" }, inputs: lesson.inputs || {} }, {
        onDone: (ev) => {
          if (!ev.ok) return;
          const text = (ev.outputs || []).map((o) => o.text || (o.value !== undefined ? JSON.stringify(o.value) : "")).join(" ");
          const ok = ev.run.status === "done" && (!lesson.expect || text.includes(lesson.expect));
          if (ok) { markLesson(lesson.id); result.prepend(h("div", { class: "fn-flash fn-flash--success" }, "✓ Lesson complete")); }
          else if (ev.run.status === "done" && lesson.expect) result.prepend(h("div", { class: "fn-flash fn-flash--warning" }, `Ran, but the output did not contain “${lesson.expect}”.`));
        },
      });
    }
  }

  /* ============================================================ webhooks (5.2) */

  let hookFilter = { model: "", kind: "", status: "" };
  let hookTimer = null;

  function webhooksView() {
    const wrap = h("div", { class: "stack" });
    const endpoints = h("div", { class: "card" }, h("div", { class: "muted small p8" }, "Loading…"));
    const log = h("div", { class: "card" });
    wrap.append(endpoints, log);
    const acc = C.moduleAccess ? C.moduleAccess("functions") : null;
    if (acc && acc.allowed && acc.rights && !acc.rights.some((r) => r === "*" || /^(webhooks|edit)$/.test(r))) {
      clear(endpoints); endpoints.append(h("div", { class: "empty" }, "Your access to Functions does not include webhooks (Modules & groups)."));
      return wrap;
    }
    void drawEndpoints(endpoints);
    drawLog(log);
    return wrap;
  }

  async function drawEndpoints(card) {
    let d;
    try { d = await api("/admin/functions/webhooks"); } catch (e) { clear(card); card.append(h("div", { class: "fn-err" }, e.message)); return; }
    clear(card);
    card.append(h("div", { class: "fn-side__head" }, h("span", {}, "Webhook endpoints"), h("span", { class: "muted small" }, `public address: ${d.publicUrl || "(PUBLIC_URL not set — relative)"} · auto waits ${Math.round(d.autoWaitMs / 1000)} s`)));
    card.append(h("p", { class: "muted small" }, "A model's webhooks are entry points (Models › Entry points): a model may have several, each with its own secret URL and function. JSON, a form or multipart become its inputs (the declared ones checked). sync answers with the outputs; async answers at once (202) with a status URL; auto answers with the outputs when the run ends in time, else like async. A caller may name ?callback= (or X-Callback-URL) to get the result POSTed; a run that asks (m5.prompt / m5.form) is answered at …/runs/<id>/answer. Every call is logged (headers, bodies, answer) and can be replayed."));
    const table = h("table", { class: "tbl fn-hooks" });
    table.append(h("thead", {}, h("tr", {}, ...["Model", "Webhook", "Function", "Mode", "Log", "Callback", "Calls", "URL", ""].map((t) => h("th", {}, t)))));
    const tb = h("tbody");
    for (const e of d.endpoints) {
      // A row is one webhook entry point (e.endpoint); a model without one gets a row that creates it.
      const put = async (body, note) => {
        try { await api(`/admin/functions/webhooks/${encodeURIComponent(e.modelId)}`, { method: "PUT", body: e.endpoint ? { endpoint: e.endpoint, ...body } : { create: true, ...body } }); toast(note || "Saved.", "ok"); void drawEndpoints(card); await loadQuiet(); }
        catch (err) { toast(err.message, "err"); }
      };
      const mode = h("select", { class: "input input--sm", disabled: !writable() || !e.enabled || undefined }, ...[["sync", "sync"], ["async", "async (202)"], ["auto", "auto"]].map(([v, l]) => h("option", { value: v, selected: e.mode === v || undefined }, l)));
      mode.addEventListener("change", () => put({ mode: mode.value }, `Mode: ${mode.value}.`));
      const logSel = h("select", { class: "input input--sm", disabled: !writable() || !e.enabled || undefined }, ...[["full", "full"], ["meta", "no bodies"], ["off", "off"]].map(([v, l]) => h("option", { value: v, selected: e.log === v || undefined }, l)));
      logSel.addEventListener("change", () => put({ log: logSel.value }, `Log: ${logSel.value}.`));
      const cb = h("input", { type: "checkbox", checked: e.callback || undefined, disabled: !writable() || !e.enabled || undefined });
      cb.addEventListener("change", () => put({ callback: cb.checked }, cb.checked ? "Callbacks allowed." : "Callbacks off."));
      const curl = e.url ? `curl -X POST -H 'Content-Type: application/json' -d ${shq(JSON.stringify(Object.fromEntries((e.inputs || []).slice(0, 3).map((i) => [i.name, i.default ?? (i.type === "number" || i.type === "integer" ? 1 : "value")]))))} ${shq(e.url)}` : "";
      tb.append(h("tr", { class: e.enabled ? "" : "fn-hooks__off" },
        h("td", {}, h("strong", {}, e.name), e.keyword ? h("span", { class: "muted small" }, ` /${e.keyword}`) : null, e.hookName ? h("div", { class: "muted small" }, `▸ ${e.hookName}`) : null, e.modelEnabled ? null : h("span", { class: "badge", title: "The model is switched off" }, "model off")),
        h("td", {}, writable() ? h("button", { class: `btn btn--xs${e.enabled ? "" : " btn--primary"}`, onclick: () => put(e.enabled ? { enabled: false } : { enabled: true, mode: e.mode === "sync" && !e.url ? "auto" : e.mode }, e.enabled ? "Webhook off." : "Webhook on — copy its URL.") }, e.enabled ? "on — turn off" : "Create / turn on") : h("span", { class: `badge badge--${e.enabled ? "ok" : ""}` }, e.enabled ? "on" : "off")),
        h("td", { class: "fn-mono small" }, e.fn || "—"),
        h("td", {}, mode), h("td", {}, logSel), h("td", {}, cb),
        h("td", { class: "fn-num" }, e.stats ? h("button", { class: "btn btn--xs", "data-read": "1", title: "Show its calls", onclick: () => { hookFilter.model = e.modelId; drawLog(card.nextElementSibling); } }, `${e.stats.calls}${e.stats.errors ? ` · ${e.stats.errors} ✗` : ""}`) : "—"),
        h("td", {}, e.url ? h("div", { class: "fn-row" }, h("button", { class: "btn btn--xs", "data-read": "1", onclick: () => copy(e.url, "URL copied.") }, "Copy URL"), h("button", { class: "btn btn--xs", "data-read": "1", onclick: () => copy(curl, "curl copied.") }, "curl")) : h("span", { class: "muted small", title: e.hidden ? "Only who may change this model's webhooks sees its URL (Modules & groups › Functions: webhooks or edit)." : "" }, e.hidden ? "hidden" : "—")),
        h("td", {}, h("div", { class: "fn-row" },
          writable() && e.enabled ? h("button", { class: "btn btn--xs btn--danger", title: "A new secret URL; the old one stops working", onclick: async () => { if (await confirmDialog(`Issue a new URL for “${e.name}”? The current one stops working at once.`, true)) void put({ rotate: true }, "New URL issued."); } }, "New URL") : null,
          writable() && e.endpoint ? h("button", { class: "btn btn--xs", title: "Another webhook for this model — its own URL (set its function in Models › Entry points)", onclick: async () => { try { await api(`/admin/functions/webhooks/${encodeURIComponent(e.modelId)}`, { method: "PUT", body: { create: true, enabled: true } }); toast("Webhook added.", "ok"); void drawEndpoints(card); await loadQuiet(); } catch (err) { toast(err.message, "err"); } } }, "+ Webhook") : null,
          writable() && e.endpoint ? h("button", { class: "fn-file__x", title: "Remove this webhook", onclick: async () => { if (!(await confirmDialog(`Remove the webhook “${e.hookName || e.endpoint}” of ${e.name}? Its URL stops working.`, true))) return; try { await api(`/admin/functions/webhooks/${encodeURIComponent(e.modelId)}/${encodeURIComponent(e.endpoint)}`, { method: "DELETE" }); toast("Webhook removed.", "ok"); void drawEndpoints(card); await loadQuiet(); } catch (err) { toast(err.message, "err"); } } }, "×") : null))));
    }
    table.append(tb);
    card.append(h("div", { class: "fn-tablewrap" }, table));
    if (d.durable.length) {
      card.append(h("div", { class: "fn-side__head mt8" }, h("span", {}, "Durable webhooks (m5.webhook.create — they run on_event later)")));
      const t2 = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["Token", "Model", "Runs", "Once", "Expires", "Made for"].map((x) => h("th", {}, x)))));
      const b2 = h("tbody");
      for (const w of d.durable) {
        const m = data.models.find((x) => x.id === w.modelId);
        b2.append(h("tr", {}, h("td", { class: "fn-mono" }, w.hook), h("td", {}, m ? m.name : w.modelId), h("td", { class: "fn-mono small" }, w.entry), h("td", {}, w.once ? "yes" : "no"), h("td", {}, w.expiresAt ? new Date(w.expiresAt).toLocaleString() : "never"), h("td", {}, w.caller)));
      }
      t2.append(b2); card.append(t2);
    }
  }

  function copy(text, note) { try { navigator.clipboard.writeText(text); toast(note, "ok"); } catch { toast("Copy failed.", "err"); } }
  /** A value for a POSIX shell, single-quoted: nothing inside is interpreted. */
  function shq(v) { return `'${String(v ?? "").replace(/'/g, "'\\''")}'`; }
  async function loadQuiet() { try { data = await api("/admin/functions"); } catch { /* keep */ } }

  function drawLog(card) {
    if (!card) return;
    if (hookTimer) { clearInterval(hookTimer); hookTimer = null; }
    clear(card);
    const modelSel = h("select", { class: "input input--sm" }, h("option", { value: "" }, "all models"), ...data.models.map((m) => h("option", { value: m.id, selected: hookFilter.model === m.id || undefined }, m.name)));
    const kindSel = h("select", { class: "input input--sm" }, ...[["", "all kinds"], ["model", "model webhooks"], ["run", "run (live wait)"], ["durable", "durable (on_event)"], ["replay", "replays"]].map(([v, l]) => h("option", { value: v, selected: hookFilter.kind === v || undefined }, l)));
    const statusSel = h("select", { class: "input input--sm" }, ...[["", "all answers"], ["ok", "2xx"], ["error", "errors"]].map(([v, l]) => h("option", { value: v, selected: hookFilter.status === v || undefined }, l)));
    const auto = h("input", { type: "checkbox" });
    const body = h("div", {}, h("div", { class: "muted small p8" }, "Loading…"));
    const fill = async () => {
      hookFilter = { model: modelSel.value, kind: kindSel.value, status: statusSel.value };
      const q = new URLSearchParams({ limit: "150" });
      if (hookFilter.model) q.set("model", hookFilter.model);
      if (hookFilter.kind) q.set("kind", hookFilter.kind);
      if (hookFilter.status) q.set("status", hookFilter.status);
      try {
        const r = await api(`/admin/functions/webhooks/calls?${q}`);
        clear(body);
        if (!r.calls.length) { body.append(h("div", { class: "muted small p8" }, "No calls yet.")); return; }
        const table = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["When", "Model", "Kind", "Request", "Body", "Answer", "ms", "Run"].map((t) => h("th", {}, t)))));
        const tb = h("tbody");
        for (const c of r.calls) {
          const m = data.models.find((x) => x.id === c.modelId);
          const st = c.status >= 200 && c.status < 300 ? "ok" : c.status === 0 ? "" : "err";
          tb.append(h("tr", { class: "fn-run-row", onclick: () => showCall(c.id) },
            h("td", { title: new Date(c.at).toLocaleString() }, when(c.at)),
            h("td", {}, m ? m.name : c.modelId || "—"),
            h("td", {}, c.kind, c.replayOf ? h("span", { class: "muted small" }, " ↻") : null),
            h("td", { class: "fn-mono small" }, `${c.method} ${c.path}`),
            h("td", { class: "small" }, c.parsed ? c.parsed.kind : "—", h("span", { class: "muted" }, ` ${c.bodySize} B`)),
            h("td", {}, h("span", { class: `badge badge--${st}` }, String(c.status || "…")), c.result ? h("span", { class: "muted small" }, ` → ${c.result.status}${c.result.callback ? ` · cb ${c.result.callback.status || "✗"}` : ""}`) : null),
            h("td", { class: "fn-num" }, String(c.ms)),
            h("td", { class: "fn-mono small" }, c.runId ? c.runId.slice(-8) : "")));
        }
        table.append(tb);
        body.append(h("div", { class: "fn-tablewrap" }, table));
      } catch (e) { clear(body); body.append(h("div", { class: "fn-err" }, e.message)); }
    };
    for (const el of [modelSel, kindSel, statusSel]) el.addEventListener("change", fill);
    auto.addEventListener("change", () => { if (hookTimer) { clearInterval(hookTimer); hookTimer = null; } if (auto.checked) hookTimer = setInterval(() => { if (!card.isConnected) { clearInterval(hookTimer); hookTimer = null; return; } void fill(); }, 5000); });
    card.append(h("div", { class: "fn-side__head" }, h("span", {}, "Webhook calls"), h("span", { class: "fn-row" }, modelSel, kindSel, statusSel, h("label", { class: "fn-switch small" }, auto, " live"), h("button", { class: "btn btn--sm", onclick: fill }, "Refresh"),
      writable() ? h("button", { class: "btn btn--sm btn--danger", onclick: async () => { if (!(await confirmDialog(hookFilter.model ? "Clear this model's webhook log?" : "Clear the whole webhook log?", true))) return; try { const r = await api(`/admin/functions/webhooks/calls${hookFilter.model ? `?model=${encodeURIComponent(hookFilter.model)}` : ""}`, { method: "DELETE" }); toast(`${r.deleted} calls removed.`, "ok"); void fill(); } catch (e) { toast(e.message, "err"); } } }, "Clear") : null)), body);
    void fill();
  }

  async function showCall(id) {
    let d;
    try { d = await api(`/admin/functions/webhooks/calls/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, "err"); return; }
    const c = d.call;
    const Kit = window.M5Kit;
    const box = h("div", { class: "stack fn-call" });
    const kv = (obj) => { const t = h("table", { class: "tbl fn-kv" }); const tb = h("tbody"); for (const [k, v] of Object.entries(obj || {})) tb.append(h("tr", {}, h("td", { class: "fn-mono small" }, k), h("td", { class: "fn-mono small" }, typeof v === "string" ? v : JSON.stringify(v)))); t.append(tb); return Object.keys(obj || {}).length ? t : h("span", { class: "muted small" }, "—"); };
    const pretty = (text, ct) => { if (!text) return h("span", { class: "muted small" }, "(empty)"); let t = text; let lang = "text"; if (/json/.test(ct || "") || /^\s*[[{]/.test(text)) { try { t = JSON.stringify(JSON.parse(text), null, 2); lang = "json"; } catch { /* as is */ } } return codeBlock(t, lang); };
    const st = c.status >= 200 && c.status < 300 ? "ok" : "err";
    box.append(h("div", { class: "fn-run__status" }, h("span", { class: `badge badge--${st}` }, String(c.status)), h("span", { class: "muted small" }, `${new Date(c.at).toLocaleString()} · ${c.kind} · ${c.ms} ms · ${c.ip}${c.replayOf ? ` · replay of ${c.replayOf}` : ""}`)));
    const tabs = h("div", { class: "fn-help__tabs" });
    const pane = h("div", { class: "stack" });
    const panes = {
      request: () => [h("div", { class: "fn-mono" }, `${c.method} ${c.path}`), h("div", { class: "muted small" }, "Query"), kv(c.query), h("div", { class: "muted small" }, `Headers (secrets masked)`), kv(c.headers), h("div", { class: "muted small" }, `Body — ${c.contentType || "no content type"} · ${c.bodySize} B · ${c.parsed ? c.parsed.kind : "—"}`), pretty(c.body, c.contentType)],
      variables: () => { const t = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "Variable"), h("th", {}, "Type"), h("th", {}, "Value")))); const tb = h("tbody"); for (const v of d.variables) tb.append(h("tr", {}, h("td", { class: "fn-mono small" }, v.path), h("td", { class: "muted small" }, v.type), h("td", { class: "fn-mono small" }, v.value))); t.append(tb); return [h("p", { class: "muted small" }, "What the model gets: the body's fields (and the query's) are its inputs; the whole request is in inputs._webhook."), t]; },
      response: () => [h("div", {}, h("span", { class: `badge badge--${st}` }, String(c.status))), kv(c.responseHeaders), pretty(c.responseBody, "application/json"), c.result ? h("div", { class: "stack" }, h("div", { class: "muted small" }, "The run's result (async / auto)"), pretty(JSON.stringify(c.result), "application/json")) : null],
      run: () => {
        if (!d.run) return [h("span", { class: "muted small" }, "No run.")];
        const out = h("div", {});
        renderRunDetail(out, d.run, d.logs);
        return [out];
      },
    };
    let current = "request";
    const draw = () => { clear(tabs); for (const [k, l] of [["request", "Request"], ["variables", "Variables"], ["response", "Response"], ["run", "Run & logs"]]) tabs.append(h("button", { class: `fn-help__tab${k === current ? " is-on" : ""}`, onclick: () => { current = k; draw(); } }, l)); clear(pane); pane.append(...panes[current]().filter(Boolean)); };
    draw();
    box.append(tabs, pane);
    const replayBox = h("div", { class: "fn-run__result" });
    const actions = h("div", { class: "fn-row mt8" });
    if (writable() && d.model) {
      const replay = (target) => async () => {
        try {
          clear(replayBox);
          const r = await api(`/admin/functions/webhooks/calls/${encodeURIComponent(c.id)}/replay`, { method: "POST", body: { target } });
          replayBox.append(h("div", { class: "muted small" }, `Replay on the ${target === "draft" ? "draft (debugging)" : "published version"} — run ${r.runId}`));
          followRunInto(replayBox, r.runId);
        } catch (e) { toast(e.message, "err"); }
      };
      actions.append(h("button", { class: "btn btn--sm btn--primary", onclick: replay("published") }, "↻ Replay"),
        h("button", { class: "btn btn--sm", title: "Run the same request on the package's draft — to debug the script", onclick: replay("draft") }, "↻ Replay on draft"));
    }
    if (d.model && d.model.packageId) {
      const inputs = c.parsed && c.parsed.value && typeof c.parsed.value === "object" && !Array.isArray(c.parsed.value) ? c.parsed.value : { body: c.parsed ? c.parsed.value : null };
      actions.append(h("button", { class: "btn btn--sm", title: "Open the package with this request as its test inputs", onclick: () => { try { localStorage.setItem(`m5cet:fn-inputs:${d.model.packageId}`, JSON.stringify({ ...inputs, _webhook: { method: c.method, headers: c.headers, query: c.query } })); } catch { /* none */ } if (dlg) dlg.close(); void openPackage(d.model.packageId); } }, "Debug in the editor"));
    }
    // Every value single-quoted for the shell — the logged request came from anyone who knew the URL.
    actions.append(h("button", { class: "btn btn--sm", "data-read": "1", onclick: () => copy(`curl -X ${/^[A-Z]{3,7}$/.test(c.method) ? c.method : "POST"} -H ${shq(`Content-Type: ${c.contentType || "application/json"}`)} --data-binary ${shq(c.body)} '<webhook URL>'`, "curl copied (put the URL in).") }, "Copy as curl"));
    box.append(actions, replayBox);
    const dlg = Kit && Kit.openDialog ? Kit.openDialog({ title: `Webhook call ${c.id}`, subtitle: d.model ? `${d.model.name} · ${d.model.entry}` : "", body: box, wide: true }) : null;
  }

  /** A finished run with its logs (for the call detail). */
  function renderRunDetail(el, run, logs) {
    clear(el);
    el.append(h("div", { class: "fn-run__status" }, h("span", { class: `badge badge--${run.status === "done" ? "ok" : "err"}` }, run.status), h("span", { class: "muted small" }, `${run.ms} ms · ${run.memMb} MB · ${run.id}`)));
    if (run.error) el.append(h("pre", { class: "fn-err" }, `${run.error.type}: ${run.error.message}${run.error.stack ? "\n" + run.error.stack : ""}`));
    for (const o of run.outputs || []) el.append(OUT(o));
    if (logs && logs.length) { const pre = h("pre", { class: "fn-logs" }); for (const l of logs) pre.append(h("div", { class: `fn-log fn-log--${l.level}` }, h("span", { class: "fn-log__lvl" }, l.level), ` ${l.msg}${l.fields ? "  " + JSON.stringify(l.fields) : ""}`)); el.append(pre); }
  }

  /** Follows a live run started elsewhere (a replay) into an element. */
  async function followRunInto(el, runId) {
    const out = h("div", { class: "fn-follow" });
    el.append(out);
    const after = h("div", { class: "fn-after" });
    const ctx = { chain: null, call: null, follow: (id) => followRunInto(after, id) };
    const logs = h("pre", { class: "fn-logs" });
    const status = h("div", { class: "fn-run__status" }, h("span", { class: "fn-spin" }), h("span", { class: "badge" }, "running"));
    out.append(status, logs);
    try {
      const res = await C.raw(`/admin/functions/runs/${encodeURIComponent(runId)}/live`);
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: ")); buf = buf.slice(i + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "log") logs.append(h("div", { class: `fn-log fn-log--${ev.level}` }, h("span", { class: "fn-log__lvl" }, ev.level), ` ${ev.msg}${ev.fields ? "  " + JSON.stringify(ev.fields) : ""}`));
          else if (ev.type === "output") out.append(OUT(ev.output, ctx));
          else if (ev.type === "result") {
            clear(status);
            if (ev.ok) {
              ctx.chain = ev.run.chainId || null; ctx.call = typeof ev.run.callId === "number" ? ev.run.callId : null;
              status.append(h("span", { class: `badge badge--${ev.run.status === "done" ? "ok" : "err"}` }, ev.run.status), h("span", { class: "muted small" }, ` ${ev.run.ms} ms${ev.run.endpoint ? ` · ${ev.run.endpoint}` : ""}${typeof ev.run.callId === "number" ? ` · call ${ev.run.callId}` : ""}`));
              if (ev.run.error) out.append(h("pre", { class: "fn-err" }, `${ev.run.error.type}: ${ev.run.error.message}${ev.run.error.stack ? "\n" + ev.run.error.stack : ""}`));
              // Outputs not streamed while it ran (the returned ones), and an error entry point's answer.
              const shown = out.querySelectorAll(":scope > .fn-out").length;
              for (const o of (ev.outputs || []).slice(shown)) out.append(OUT(o, ctx));
              if (ctx.chain) out.append(replyForm(ctx));
            } else status.append(h("span", { class: "fn-err" }, ev.message));
            out.append(after);
          }
        }
      }
    } catch (e) { out.append(h("div", { class: "fn-err" }, e.message)); }
  }

  /* ============================================================ built-in gallery (5.2) */

  async function builtinGallery(box) {
    let d;
    try { d = await api("/admin/functions/builtins"); } catch { return; }
    clear(box);
    box.append(h("div", { class: "fn-side__head" }, h("span", {}, "Built-in commands and demos"), h("span", { class: "muted small" }, "/help and ready-made network tools — installed once on the first start; install again, or update, here.")));
    const grid = h("div", { class: "fn-gallery" });
    for (const b of d.builtins) {
      const state = !b.installed ? "not installed" : b.current ? `v${b.version}` : `update to v${b.version}`;
      grid.append(h("div", { class: "fn-gallery__card" },
        h("div", { class: "fn-row" }, h("strong", {}, b.keyword ? `/${b.keyword}` : b.name), h("span", { class: `badge${b.kind === "system" ? " badge--accent" : ""}` }, b.kind), h("span", { class: "fn-grow" }), h("span", { class: `badge badge--${b.installed && b.current ? "ok" : "warn"}` }, state)),
        h("div", { class: "muted small" }, b.summary || b.description),
        h("div", { class: "fn-row" },
          writable() && (!b.installed || !b.current || (b.keyword && !b.model)) ? h("button", { class: "btn btn--xs btn--primary", onclick: async () => { try { const r = await api(`/admin/functions/builtins/${encodeURIComponent(b.name)}/install`, { method: "POST", body: {} }); const notes = r.results.filter((x) => x.message).map((x) => x.message); toast(notes.length ? notes.join(" ") : `${b.name} installed.`, notes.length ? "err" : "ok"); await load(); } catch (e) { toast(e.message, "err"); } } }, b.installed ? "Update / repair" : "Install") : null,
          b.installed ? h("button", { class: "btn btn--xs", onclick: () => { const p = data.packages.find((x) => x.name === b.name); if (p) void openPackage(p.id); } }, "Open") : null,
          b.model ? h("button", { class: "btn btn--xs", onclick: () => { const m = data.models.find((x) => x.id === b.model.id); if (m) editModel(m); } }, "Model") : null)));
    }
    box.append(grid);
  }

  /* ================================================================ runs */

  // Synchronous on purpose: render() appends what this returns, and the list
  // fills in when the request answers (an async function returned a Promise,
  // which the page showed as "[object Promise]").
  function runsView() {
    const wrap = h("div", { class: "stack" });
    const card = h("div", { class: "card" });
    const statusSel = h("select", { class: "input input--sm", "aria-label": "Status" });
    for (const [v, l] of [["", "all statuses"], ["done", "done"], ["failed", "failed"], ["timed-out", "timed out"], ["running", "running"], ["waiting", "waiting"], ["cancelled", "cancelled"]]) statusSel.append(h("option", { value: v, selected: runsFilter.status === v }, l));
    const modelSel = h("select", { class: "input input--sm", "aria-label": "Model" });
    modelSel.append(h("option", { value: "" }, "all models"));
    for (const m of data.models) modelSel.append(h("option", { value: m.id, selected: runsFilter.model === m.id }, m.name));
    const auto = h("input", { type: "checkbox", checked: runsAuto });
    const body = h("div", {}, h("div", { class: "muted small p8" }, "Loading…"));
    statusSel.onchange = () => { runsFilter.status = statusSel.value; fill(); };
    modelSel.onchange = () => { runsFilter.model = modelSel.value; fill(); };
    auto.onchange = () => { runsAuto = auto.checked; if (runsTimer) { clearInterval(runsTimer); runsTimer = null; } if (runsAuto) runsTimer = setInterval(fill, 5000); };
    card.append(h("div", { class: "fn-side__head" }, h("span", {}, "Recent runs"), h("span", { class: "fn-row" }, statusSel, modelSel, h("label", { class: "fn-switch small" }, auto, " auto-refresh"), h("button", { class: "btn btn--sm", onclick: () => fill() }, "Refresh"))));
    card.append(body); wrap.append(card);
    fill();
    if (runsAuto) runsTimer = setInterval(fill, 5000);
    return wrap;

    async function fill() {
      const q = new URLSearchParams({ limit: "150" });
      if (runsFilter.status) q.set("status", runsFilter.status);
      if (runsFilter.model) q.set("model", runsFilter.model);
      try {
        const r = await api(`/admin/functions/runs?${q}`);
        clear(body);
        if (!r.runs.length) { body.append(h("div", { class: "muted small p8" }, "No runs yet.")); return; }
        const table = h("table", { class: "tbl" });
        table.append(h("thead", {}, h("tr", {}, ...["When", "Model", "Executor", "Status", "ms", "MB", "Caller"].map((t) => h("th", {}, t)))));
        const tb = h("tbody", {});
        for (const run of r.runs) {
          const model = data.models.find((m) => m.id === run.modelId);
          tb.append(h("tr", { class: "fn-run-row", onclick: () => showRun(run.id), title: run.entry },
            h("td", { title: new Date(run.queuedAt).toLocaleString() }, when(run.queuedAt)),
            h("td", {}, model ? model.name : run.modelId || h("span", { class: "muted" }, "(draft)")),
            h("td", {}, run.executor, run.test ? h("span", { class: "muted small" }, " · test") : null),
            h("td", {}, h("span", { class: `badge badge--${run.status === "done" ? "ok" : run.status === "failed" || run.status === "timed-out" ? "err" : run.status === "running" || run.status === "waiting" ? "warn" : ""}` }, run.status)),
            h("td", { class: "fn-num" }, String(run.ms)),
            h("td", { class: "fn-num" }, String(run.memMb || "")),
            h("td", {}, run.caller ? run.caller.name : "")));
        }
        table.append(tb); body.append(table);
      } catch (e) { clear(body); body.append(h("div", { class: "fn-err" }, e.message)); }
    }
  }

  function when(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return `${Math.max(1, Math.round(s))} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return new Date(ts).toLocaleTimeString();
    return new Date(ts).toLocaleString();
  }

  async function showRun(id) {
    try {
      const d = await api(`/admin/functions/runs/${encodeURIComponent(id)}`);
      const run = d.run;
      const box = h("div", { class: "stack" });
      const ok = run.status === "done";
      box.append(h("div", { class: "fn-run__status" }, h("span", { class: `badge badge--${ok ? "ok" : "err"}` }, run.status), h("span", { class: "muted small" }, `${run.ms} ms · ${run.memMb} MB · ${run.lang || ""} · ${run.executor}${run.test ? " (test)" : ""} · ${new Date(run.queuedAt).toLocaleString()}`)));
      if (run.inputs && Object.keys(run.inputs).length) box.append(h("details", {}, h("summary", { class: "muted small" }, "Inputs"), h("pre", { class: "fn-code" }, JSON.stringify(run.inputs, null, 2))));
      if (run.error) box.append(h("pre", { class: "fn-err" }, `${run.error.type}: ${run.error.message}${run.error.stack ? "\n" + run.error.stack : ""}`));
      const after = h("div", { class: "fn-after" });
      const ctx = { chain: run.chainId || null, call: typeof run.callId === "number" ? run.callId : null, follow: (rid) => followRunInto(after, rid) };
      if (run.chainId) box.append(h("div", { class: "muted small" }, `Processing session ${run.chainId} · call ${run.callId}${run.endpoint ? ` · ${run.endpoint}` : ""} `, h("button", { class: "btn btn--xs", onclick: () => showChain(run.chainId) }, "m5.model.calls")));
      for (const o of run.outputs || []) box.append(OUT(o, ctx));
      box.append(after);
      const trace = (d.logs || []).filter((l) => l.msg === "flow:node" || l.msg === "flow:fail");
      if (trace.length) {
        const t = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "node"), h("th", {}, "value"))));
        const tb = h("tbody", {});
        for (const l of trace) tb.append(h("tr", {}, h("td", {}, l.fields.node), h("td", { class: l.msg === "flow:fail" ? "fn-err" : "" }, l.msg === "flow:fail" ? l.fields.error : JSON.stringify(l.fields.value))));
        t.append(tb);
        box.append(h("details", { open: true }, h("summary", { class: "muted small" }, "Node values (builder trace)"), t));
      }
      const logs = (d.logs || []).filter((l) => l.msg !== "flow:node" && l.msg !== "flow:fail");
      if (logs.length) {
        const pre = h("pre", { class: "fn-logs" });
        for (const l of logs) pre.append(h("div", { class: `fn-log fn-log--${l.level}` }, h("span", { class: "fn-log__lvl" }, l.level), ` ${l.msg}${l.fields ? "  " + JSON.stringify(l.fields) : ""}`));
        box.append(h("div", { class: "muted small" }, "Logs"), pre);
      }
      const Kit = window.M5Kit;
      if (Kit && Kit.openDialog) Kit.openDialog({ title: `Run ${id}`, subtitle: run.entry, body: box, wide: true });
      else { const el = root(); clear(el); el.append(h("button", { class: "btn btn--sm", onclick: render }, "← Back"), box); }
    } catch (e) { toast(e.message, "err"); }
  }

  /** 5.3: "reply to this result" — the response entry point, as a reply in the chat would run it. */
  function replyForm(ctx) {
    const inp = h("input", { class: "input input--sm fn-grow", placeholder: "Reply to this result… (the response entry point)" });
    const f = h("form", { class: "fn-row fn-reply" }, h("span", { class: "muted small" }, "↩"), inp, h("button", { class: "btn btn--xs", type: "submit" }, "Reply"));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inp.value.trim();
      if (!text || !ctx.chain) return;
      try {
        const r = await api("/admin/functions/event", { method: "POST", body: { chain: ctx.chain, call: ctx.call, type: "response", text, live: true } });
        inp.value = "";
        if (r.runId && ctx.follow) ctx.follow(r.runId);
      } catch (err) { toast(err.message, "err"); }
    });
    return f;
  }

  /** 5.3: a processing session — every call with its parms, result, status and error (what m5.model.calls holds). */
  async function showChain(id) {
    try {
      const d = await api(`/admin/functions/chains?id=${encodeURIComponent(id)}`);
      const c = d.chain;
      const box = h("div", { class: "stack" });
      box.append(h("div", { class: "muted small" }, `${c.calls.length} calls · ${new Date(c.createdAt).toLocaleString()} → ${new Date(c.updatedAt).toLocaleString()}${c.source && c.source.kind === "draft" ? " · a package draft" : ""}`));
      const t = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "type"), h("th", {}, "status"), h("th", {}, "parms"), h("th", {}, "result"), h("th", {}, "err_msg"), h("th", {}, "http"), h("th", {}, "run"))));
      const tb = h("tbody", {});
      const cut = (v) => { const s = JSON.stringify(v); return s && s.length > 160 ? s.slice(0, 160) + "…" : s; };
      for (const x of c.calls) tb.append(h("tr", {}, h("td", {}, String(x.id)), h("td", {}, h("span", { class: "badge" }, x.type)), h("td", {}, h("span", { class: `badge badge--${x.status === "done" ? "ok" : x.status === "running" ? "" : "err"}` }, x.status)), h("td", { class: "fn-mono small" }, cut(x.parms)), h("td", { class: "fn-mono small" }, cut(x.result)), h("td", { class: "fn-err small" }, x.err_msg || ""), h("td", { class: "fn-mono small" }, x.http ? `${x.http.method} ${x.http.url}` : ""), h("td", {}, x.run ? h("button", { class: "btn btn--xs", onclick: () => showRun(x.run) }, x.run.slice(-8)) : "")));
      t.append(tb);
      box.append(h("div", { class: "fn-tablewrap" }, t), h("details", {}, h("summary", { class: "muted small" }, "JSON (m5.model.calls)"), h("pre", { class: "fn-code" }, JSON.stringify(c.calls, null, 2))));
      const Kit = window.M5Kit;
      if (Kit && Kit.openDialog) Kit.openDialog({ title: `Processing session ${id}`, subtitle: "m5.model.calls — calls[0] is the first call (execute or a webhook)", body: box, wide: true });
    } catch (e) { toast(e.message, "err"); }
  }

  /* ============================================================= outputs */

  function outputRenderer() {
    return function renderOutput(o, ctx) {
      const box = h("div", { class: "fn-out" });
      // 5.3: sound, video, buttons, forms, browser code (functions-outputs.js); clicks and forms run the entry points.
      const X = window.M5FnOut;
      const special = X && ["audio", "video", "button", "form", "js"].includes(o.type) ? X.render(o, ctx || null) : null;
      if (special) { box.append(special); return box; }
      if (o.title) box.append(h("div", { class: "muted small" }, o.title));
      switch (o.type) {
        case "text": box.append(h("div", { class: "fn-out__text" }, o.text)); break;
        case "markdown": box.append(mdBlock(o.text)); break;
        case "code": box.append(codeBlock(o.text, o.lang)); break;
        case "json": box.append(codeBlock(JSON.stringify(o.value, null, 2), "json")); break;
        case "table": box.append(tableBlock(o)); break;
        case "image": { const img = h("img", { class: "fn-img", alt: o.alt || "" }); img.src = `data:${o.mime};base64,${o.data}`; box.append(img); break; }
        case "file": {
          const url = `data:${o.mime};base64,${o.data}`;
          if (/^audio\//.test(o.mime)) { const a = h("audio", { controls: true, class: "fn-audio" }); a.src = url; box.append(a); }
          else if (/^image\//.test(o.mime)) { const img = h("img", { class: "fn-img", alt: o.name }); img.src = url; box.append(img); }
          box.append(h("a", { class: "btn btn--sm", href: url, download: o.name }, `⬇ ${o.name}`));
          break;
        }
        case "flash": box.append(h("div", { class: `fn-flash fn-flash--${o.level}` }, o.text)); break;
        case "window": box.append(h("div", { class: "muted small" }, `opens the app's panel: ${o.id}`)); break;
        default: box.append(h("pre", { class: "fn-code" }, JSON.stringify(o)));
      }
      return box;
    };
  }

  function codeBlock(text, lang) {
    const E = ED();
    if (E && String(text).length < 20000) {
      const host = h("div", { class: "fn-cm fn-cm--ro" });
      mount(E.show(host, String(text), lang === "py" || lang === "python" ? "py" : lang === "json" ? "json" : lang === "js" || lang === "javascript" ? "js" : "text", { minHeight: "0", maxHeight: "360px", lineNumbers: false }));
      return host;
    }
    return h("pre", { class: "fn-code" }, h("code", {}, String(text)));
  }

  function tableBlock(o) {
    const t = h("table", { class: "tbl" });
    t.append(h("thead", {}, h("tr", {}, ...o.columns.map((c) => h("th", {}, String(c))))));
    const tb = h("tbody", {});
    for (const row of o.rows) tb.append(h("tr", {}, ...row.map((c) => h("td", {}, c === null || c === undefined ? "" : typeof c === "object" ? JSON.stringify(c) : String(c)))));
    t.append(tb);
    return h("div", { class: "fn-tablewrap" }, t);
  }

  // A tiny, safe Markdown block: bold, italic, code, headings, lists, links, fenced code.
  function mdBlock(text) {
    const box = h("div", { class: "fn-md" });
    const src = String(text);
    const fence = /```(\w*)\n([\s\S]*?)```/g;
    let last = 0, m;
    const prose = (chunk) => {
      for (const raw of chunk.split(/\n{2,}/)) {
        let lines = raw.trim().split("\n");
        while (lines.length) {
          const hm = /^(#{1,3})\s+(.*)$/.exec(lines[0].trim());
          if (hm) { box.append(h(`h${hm[1].length + 2}`, { class: "fn-md__h" }, inlineMd(hm[2]))); lines = lines.slice(1); continue; }
          if (/^[-*]\s/.test(lines[0].trim())) {
            const ul = h("ul", { class: "fn-md__ul" });
            while (lines.length && /^[-*]\s/.test(lines[0].trim())) { ul.append(h("li", {}, inlineMd(lines[0].trim().replace(/^[-*]\s/, "")))); lines = lines.slice(1); }
            box.append(ul); continue;
          }
          const para = [];
          while (lines.length && !/^(#{1,3})\s/.test(lines[0].trim()) && !/^[-*]\s/.test(lines[0].trim())) { para.push(lines[0]); lines = lines.slice(1); }
          if (para.join("").trim()) { const p = h("p", {}); para.forEach((part, i) => { p.append(...inlineMd(part)); if (i < para.length - 1) p.append(h("br", {})); }); box.append(p); }
        }
      }
    };
    while ((m = fence.exec(src))) { prose(src.slice(last, m.index)); box.append(codeBlock(m[2].replace(/\n$/, ""), m[1])); last = fence.lastIndex; }
    prose(src.slice(last));
    return box;
  }
  function inlineMd(text) {
    // Tokenize into text / code / bold / italic / link nodes (no HTML).
    const nodes = [];
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    let last = 0, mm;
    while ((mm = re.exec(text))) {
      if (mm.index > last) nodes.push(document.createTextNode(text.slice(last, mm.index)));
      if (mm[1] !== undefined) nodes.push(h("code", { class: "fn-md__code" }, mm[1]));
      else if (mm[2] !== undefined) nodes.push(h("strong", {}, mm[2]));
      else if (mm[3] !== undefined) nodes.push(h("em", {}, mm[3]));
      else nodes.push(h("a", { href: mm[5], target: "_blank", rel: "noopener noreferrer nofollow" }, mm[4]));
      last = re.lastIndex;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
  }

  // The builder (functions-builder.js) uses these.
  window.M5FnConsole = { liveRun, liveRunInto, renderOutput: OUT, formDialog, confirmDialog, go: (id) => go(id), reload: load };
})();
