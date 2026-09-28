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
    else el.append(runsView());
  }

  function header() {
    const s = data.stats || { runs24h: 0, failed24h: 0, avgMs: 0 };
    const on = data.models.filter((m) => m.enabled).length;
    const stat = (label, value, hint, cls) => h("div", { class: `fn-stat${cls ? " " + cls : ""}`, title: hint || "" }, h("div", { class: "fn-stat__v" }, String(value)), h("div", { class: "fn-stat__l" }, label));
    return h("div", { class: "fn-stats" },
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
    const items = [["packages", "Packages", data.packages.length], ["builder", "Builder", null], ["models", "Models", data.models.length], ["schedules", "Schedules", (data.schedules || []).length], ["runs", "Runs", null], ["tutorial", "Tutorial", null]];
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
    for (const [id, label] of [["sdk", "SDK"], ["snippets", "Templates"], ["examples", "Examples"]]) bar.append(h("button", { class: `fn-help__tab${helpTab === id ? " is-on" : ""}`, onclick: () => { helpTab = id; const n = helpPanel(); box.replaceWith(n); } }, label));
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
    el.append(statusRow, bar, asks, outs, logsBox);
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
      else if (ev.type === "output") outs.append(OUT(ev.output));
      else if (ev.type === "progress") { bar.hidden = false; bar.firstChild.style.width = `${Math.max(0, Math.min(1, ev.p)) * 100}%`; bar.title = ev.text || ""; }
      else if (ev.type === "status" && ev.status === "waiting") setBadge("waiting for you", "warn");
      else if (ev.type === "interaction") asks.append(interactionCard(runId, ev.interaction, () => setBadge("running")));
      else if (ev.type === "result") {
        clearInterval(timer);
        spin.remove();
        clear(asks);
        if (!ev.ok) { setBadge("refused", "err"); el.insertBefore(h("div", { class: "fn-err" }, ev.message || "The run was refused."), outs); if (hooks.onDone) hooks.onDone(ev); return; }
        const run = ev.run;
        setBadge(run.status, run.status === "done" ? "ok" : "err");
        info.textContent = `${run.ms} ms · ${run.memMb} MB · ${run.lang || ""} · ${run.id}`;
        if (run.error) el.insertBefore(h("pre", { class: "fn-err" }, `${run.error.type}: ${run.error.message}${run.error.stack ? "\n" + run.error.stack : ""}`), outs);
        // The returned value (last output) — the ones sent during the run are shown already.
        const shown = outs.childElementCount;
        for (const o of (ev.outputs || []).slice(shown)) outs.append(OUT(o));
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

    // entry picker
    const pkgs = data.packages.filter((p) => p.versions.length);
    const entryRow = h("div", { class: "fn-grid3" });
    const pkgSel = h("select", { class: "input", disabled: ro });
    pkgSel.append(h("option", { value: "" }, pkgs.length ? "— package —" : "— publish a package first —"));
    for (const p of pkgs) pkgSel.append(h("option", { value: p.name }, `${p.name} (${p.language})`));
    const verSel = h("select", { class: "input", disabled: ro });
    const fileIn = h("input", { class: "input", placeholder: "index.js#execute", disabled: ro });
    const parsed = /^([^@]+)@([^:]+):(.+)#(.+)$/.exec(m.entry || "");
    if (parsed) { pkgSel.value = parsed[1]; fileIn.value = `${parsed[3]}#${parsed[4]}`; }
    const fillVers = () => {
      clear(verSel);
      const p = pkgs.find((x) => x.name === pkgSel.value);
      for (const v of (p ? [...p.versions].reverse() : [])) verSel.append(h("option", { value: v }, v));
      if (parsed && pkgSel.value === parsed[1]) verSel.value = parsed[2];
      if (p && !fileIn.value) fileIn.value = `${p.language === "py" ? "index.py" : "index.js"}#execute`;
      syncEntry();
    };
    const syncEntry = () => { m.entry = pkgSel.value && verSel.value && fileIn.value.includes("#") ? `${pkgSel.value}@${verSel.value}:${fileIn.value}` : ""; };
    pkgSel.onchange = () => { fileIn.value = ""; fillVers(); }; verSel.onchange = syncEntry; fileIn.oninput = syncEntry; fillVers();
    entryRow.append(h("label", { class: "field" }, h("span", { class: "label" }, "Package"), pkgSel), h("label", { class: "field" }, h("span", { class: "label" }, "Version"), verSel), h("label", { class: "field" }, h("span", { class: "label" }, "File # function"), fileIn));
    const entryFs = h("fieldset", { class: "fn-fs" }, h("legend", {}, "Entry point"), entryRow);
    const pkgOf = () => data.packages.find((p) => p.name === pkgSel.value);
    entryFs.append(h("div", { class: "fn-row mt8" },
      h("button", { class: "btn btn--xs", onclick: () => { const p = pkgOf(); if (p) openPackage(p.id); } }, "Open the package"),
      h("button", { class: "btn btn--xs", onclick: () => { const p = pkgOf(); if (p && p.flow && window.M5FnBuilder) api(`/admin/functions/packages/${encodeURIComponent(p.id)}`).then((d) => { window.M5FnBuilder.openFromPackage(d.package, JSON.parse(d.draft.files["flow.m5flow.json"])); go("builder"); }).catch((e) => toast(e.message, "err")); else toast("That package was not made in the builder.", "err"); } }, "◇ Open its flow")));
    form.append(entryFs);

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

    // webhook + API executors (reachable by an inbound HTTP POST)
    if (!m.executors.webhook) m.executors.webhook = { enabled: false, auth: "none" };
    if (!m.executors.api) m.executors.api = { enabled: false };
    const hookOn = h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: m.executors.webhook.enabled, disabled: ro, onchange: (e) => { m.executors.webhook.enabled = e.target.checked; } }), " reachable as a webhook (POST)");
    const apiOn = h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: m.executors.api.enabled, disabled: ro, onchange: (e) => { m.executors.api.enabled = e.target.checked; } }), " API (bearer token)");
    const hookBox = h("fieldset", { class: "fn-fs" }, h("legend", {}, "Webhook & API"), h("div", { class: "fn-grid2" }, hookOn, apiOn));
    const copyField = (label, value, note) => h("label", { class: "field mt8" }, h("span", { class: "label" }, label), h("div", { class: "fn-row" }, h("input", { class: "input fn-mono", readonly: "readonly", value }), h("button", { class: "btn btn--sm", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(value); toast("Copied.", "ok"); } }, "Copy")), note ? h("span", { class: "muted small" }, note) : null);
    if (m.webhookUrl) hookBox.append(copyField("Webhook URL (keep it secret)", m.webhookUrl, m.webhookUrl.startsWith("http") ? "POST JSON here to run the model." : "Set PUBLIC_URL on the server for an absolute URL."));
    if (m.executors.api.enabled && m.executors.api.token) hookBox.append(copyField(`API — POST /api/functions/call/${m.id}`, `curl -X POST -H "Authorization: Bearer ${m.executors.api.token}" -H "Content-Type: application/json" -d '{}' ${location.origin.replace(/\/$/, "")}/api/functions/call/${m.id}`, "Replace the host with the chat's address if the console runs elsewhere."));
    form.append(hookBox);

    // inputs schema
    form.append(inputsEditor(m, ro));

    // actions + test
    const actions = h("div", { class: "fn-editor__actions mt8" });
    if (writable()) actions.append(h("button", { class: "btn btn--primary", onclick: saveModel }, "Save model"), m.id ? h("button", { class: "btn btn--danger", onclick: deleteModel }, "Delete") : null);
    form.append(actions);
    if (m.id) form.append(testForm(m));
    return form;

    async function saveModel() {
      syncEntry();
      try { const r = await api("/admin/functions/models", { method: "POST", body: m }); toast(`Model ${r.model.name} saved.`, "ok"); modelDraft = r.model; await load(); }
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

  const INPUT_TYPES = ["string", "text", "integer", "number", "boolean", "enum", "date", "time", "duration", "url", "hostname", "email", "ip", "json", "user", "file"];

  function inputsEditor(m, ro) {
    const fs = h("fieldset", { class: "fn-fs" }, h("legend", {}, "Inputs"));
    const list = h("div", { class: "fn-inputs" });
    const redraw = () => {
      clear(list);
      if (m.inputs.length) list.append(h("div", { class: "fn-input-row fn-input-row--head muted small" }, h("span", {}, "name"), h("span", {}, "type"), h("span", {}, "label"), h("span", {}, "default"), h("span", {}, "required"), h("span", {}, "")));
      m.inputs.forEach((inp, i) => {
        const typeSel = h("select", { class: "input input--sm", disabled: ro });
        for (const t of INPUT_TYPES) typeSel.append(h("option", { value: t, selected: inp.type === t }, t));
        typeSel.onchange = (e) => { inp.type = e.target.value; redraw(); };
        const row = h("div", { class: "fn-input-row" },
          h("input", { class: "input input--sm fn-mono", value: inp.name || "", placeholder: "name", disabled: ro, oninput: (e) => { inp.name = e.target.value; } }),
          typeSel,
          h("input", { class: "input input--sm", value: inp.label || "", placeholder: "label", disabled: ro, oninput: (e) => { inp.label = e.target.value; } }),
          h("input", { class: "input input--sm", value: inp.default === undefined ? "" : inp.default, placeholder: "default", disabled: ro, oninput: (e) => { inp.default = e.target.value || undefined; } }),
          h("label", { class: "fn-req" }, h("input", { type: "checkbox", checked: inp.required, disabled: ro, onchange: (e) => { inp.required = e.target.checked; } }), "req"),
          writable() ? h("span", { class: "fn-row" },
            h("button", { class: "btn btn--xs", title: "Move up", disabled: i === 0 ? true : null, onclick: () => { m.inputs.splice(i - 1, 0, m.inputs.splice(i, 1)[0]); redraw(); } }, "↑"),
            h("button", { class: "fn-file__x", title: "Remove", onclick: () => { m.inputs.splice(i, 1); redraw(); } }, "×")) : null);
        list.append(row);
        if (inp.type === "enum") list.append(h("input", { class: "input input--sm fn-enum", value: (inp.values || []).join(", "), placeholder: "enum values, comma-separated", disabled: ro, oninput: (e) => { inp.values = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); } }));
      });
    };
    redraw();
    fs.append(list);
    if (writable()) fs.append(h("button", { class: "btn btn--sm", onclick: () => { m.inputs.push({ name: "", type: "string" }); redraw(); } }, "+ Input"));
    return fs;
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
      for (const o of run.outputs || []) box.append(OUT(o));
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

  /* ============================================================= outputs */

  function outputRenderer() {
    return function renderOutput(o) {
      const box = h("div", { class: "fn-out" });
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
        case "window": box.append(h("div", { class: "muted small" }, `opens window: ${o.id}`)); break;
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
