// M5cet operator console — Functions (4.15).
//
//   Packages   create a JS or Python package, edit its files in the editor,
//              save the draft, run it, publish an immutable version
//   Models     a runnable: name, chat keyword, entry (package@version:file#fn),
//              input schema, where it runs, who may use it, on/off
//   Runs       recent runs with their logs and outputs
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast, can } = C;

  const root = () => document.getElementById("fnRoot");
  let data = null;         // overview: packages, models, runtime, sdk
  let sdk = null;          // { spec, completions, dts }
  let tab = "packages";
  let sel = null;          // selected package detail { package, draft, versions }
  let files = {};          // draft files being edited
  let current = "";        // the open file
  let dirty = false;
  let modelDraft = null;   // the model being edited
  const OUT = outputRenderer();

  /* ============================================================== loading */

  async function load() {
    if (!sdk) { try { sdk = await api("/admin/functions/sdk"); } catch { sdk = { spec: [], completions: [], dts: "" }; } }
    data = await api("/admin/functions");
    render();
  }
  C.addRoute("functions", ["Functions", "Packages, models, the editor and test runs", load]);

  const writable = () => can("operator");

  /* =============================================================== render */

  function render() {
    const el = root();
    if (!el) return;
    clear(el);
    if (!data.runtime.persistent) el.append(h("div", { class: "card warn" }, h("strong", {}, "In-memory only. "), data.runtime.reason || "The SQLite driver is missing; packages and models will not survive a restart."));
    el.append(tabs());
    if (tab === "packages") el.append(packagesView());
    else if (tab === "models") el.append(modelsView());
    else el.append(runsView());
  }

  function tabs() {
    const bar = h("div", { class: "fn-tabs" });
    for (const [id, label] of [["packages", "Packages"], ["models", "Models"], ["runs", "Runs"]]) {
      bar.append(h("button", { class: `fn-tab${tab === id ? " fn-tab--on" : ""}`, onclick: () => { tab = id; render(); } }, label));
    }
    return bar;
  }

  /* ============================================================ packages */

  function packagesView() {
    const wrap = h("div", { class: "fn-cols" });
    const list = h("div", { class: "fn-side card" });
    list.append(h("div", { class: "fn-side__head" }, h("span", {}, "Packages"), writable() ? h("button", { class: "btn btn--sm", onclick: newPackage }, "+ New") : null));
    if (!data.packages.length) list.append(h("div", { class: "muted small p8" }, "No packages yet."));
    for (const p of data.packages) {
      const on = sel && sel.package.id === p.id;
      list.append(h("button", { class: `fn-pkg${on ? " fn-pkg--on" : ""}`, onclick: () => openPackage(p.id) },
        h("span", { class: "fn-pkg__name" }, p.name),
        h("span", { class: "badge" }, p.language.toUpperCase()),
        h("span", { class: "muted small" }, p.versions.length ? `v${p.versions[p.versions.length - 1]}` : "draft")));
    }
    wrap.append(list);
    wrap.append(sel ? editorPane() : h("div", { class: "card empty" }, "Pick a package, or create one."));
    return wrap;
  }

  async function newPackage() {
    const name = prompt("New package name (lower-case letters, digits, hyphens):", "");
    if (!name) return;
    const language = confirm("OK = JavaScript, Cancel = Python") ? "js" : "py";
    try { const r = await api("/admin/functions/packages", { method: "POST", body: { name, language } }); toast(`Package ${r.package.name} created.`, "ok"); await load(); await openPackage(r.package.id); }
    catch (e) { toast(e.message, "err"); }
  }

  async function openPackage(id) {
    try { sel = await api(`/admin/functions/packages/${encodeURIComponent(id)}`); }
    catch (e) { toast(e.message, "err"); return; }
    files = { ...(sel.draft ? sel.draft.files : {}) };
    current = files["index.js"] ? "index.js" : files["index.py"] ? "index.py" : Object.keys(files)[0] || "";
    dirty = false;
    tab = "packages";
    render();
  }

  function editorPane() {
    const pane = h("div", { class: "fn-editor-pane card" });
    // header
    const head = h("div", { class: "fn-editor__head" });
    head.append(h("strong", {}, sel.package.name), h("span", { class: "badge" }, sel.package.language.toUpperCase()));
    if (sel.versions.filter((v) => v.status === "published").length) head.append(h("span", { class: "muted small" }, `published: ${sel.versions.filter((v) => v.status === "published").map((v) => v.version).join(", ")}`));
    const actions = h("div", { class: "fn-editor__actions" });
    if (writable()) {
      actions.append(
        h("button", { class: "btn btn--sm", onclick: newFile }, "+ File"),
        h("button", { class: "btn btn--sm", id: "fnSave", onclick: saveDraft }, "Save draft"),
        h("button", { class: "btn btn--sm btn--primary", onclick: publish }, "Publish…"),
      );
    }
    head.append(actions);
    pane.append(head);

    // file tabs
    const ftabs = h("div", { class: "fn-files" });
    for (const name of Object.keys(files).sort()) {
      ftabs.append(h("button", { class: `fn-file${name === current ? " fn-file--on" : ""}`, onclick: () => { stash(); current = name; render(); } }, name,
        writable() && Object.keys(files).length > 1 ? h("span", { class: "fn-file__x", title: "Delete file", onclick: (ev) => { ev.stopPropagation(); if (confirm(`Delete ${name}?`)) { delete files[name]; if (current === name) current = Object.keys(files)[0] || ""; dirty = true; render(); } } }, "×") : null));
    }
    pane.append(ftabs);

    // the editor + helper
    const grid = h("div", { class: "fn-edit-grid" });
    const ta = h("textarea", { class: "fn-editor", spellcheck: "false", wrap: "off", readonly: writable() ? null : "readonly" }, files[current] || "");
    ta.value = files[current] || "";
    ta.addEventListener("input", () => { files[current] = ta.value; dirty = true; markDirty(); });
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Tab") { ev.preventDefault(); const s = ta.selectionStart, e = ta.selectionEnd; ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(e); ta.selectionStart = ta.selectionEnd = s + 2; files[current] = ta.value; dirty = true; }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") { ev.preventDefault(); saveDraft(); }
    });
    grid.append(ta);
    grid.append(sdkHelper(ta));
    pane.append(grid);

    // run panel
    pane.append(runPanel());
    return pane;
  }

  function stash() { const ta = root().querySelector(".fn-editor"); if (ta && current) files[current] = ta.value; }
  function markDirty() { const b = document.getElementById("fnSave"); if (b) b.textContent = dirty ? "Save draft •" : "Save draft"; }

  function newFile() {
    const name = prompt("New file name (e.g. util.js, lib/helpers.py):", "");
    if (!name) return;
    if (files[name] !== undefined) { toast("That file already exists.", "err"); return; }
    files[name] = "";
    current = name; dirty = true; render();
  }

  async function saveDraft() {
    stash();
    try { const r = await api(`/admin/functions/packages/${encodeURIComponent(sel.package.id)}/draft`, { method: "PUT", body: { files } }); sel.draft = r.draft; dirty = false; toast("Draft saved.", "ok"); markDirty(); }
    catch (e) { toast(e.message, "err"); }
  }

  async function publish() {
    await saveDraft();
    const bump = prompt("Publish as — patch / minor / major, or an exact version (1.2.3):", "patch");
    if (!bump) return;
    try { const r = await api(`/admin/functions/packages/${encodeURIComponent(sel.package.id)}/publish`, { method: "POST", body: { bump } }); toast(`Published ${sel.package.name}@${r.version.version}.`, "ok"); await load(); await openPackage(sel.package.id); }
    catch (e) { toast(e.message, "err"); }
  }

  function sdkHelper(ta) {
    const box = h("div", { class: "fn-sdk" });
    box.append(h("div", { class: "fn-sdk__head" }, "m5 SDK"));
    for (const obj of (sdk.spec || [])) {
      const det = h("details", { class: "fn-sdk__obj" });
      det.append(h("summary", {}, `m5.${obj.name}`));
      for (const meth of obj.methods) {
        const snippet = sel && sel.package.language === "py" ? meth.py : meth.js;
        det.append(h("button", { class: "fn-sdk__m", title: meth.doc, onclick: () => insertAt(ta, snippet) }, snippet));
      }
      box.append(det);
    }
    return box;
  }

  function insertAt(ta, text) {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus(); files[current] = ta.value; dirty = true; markDirty();
  }

  /* --------------------------------------------------------------- run it */

  function runPanel() {
    const box = h("div", { class: "fn-run" });
    const entryFile = h("input", { class: "input fn-run__file", value: current || sel.draft?.manifest.main || "index.js" });
    const entryFn = h("input", { class: "input fn-run__fn", value: "execute" });
    const inputs = h("textarea", { class: "fn-run__inputs", spellcheck: "false", placeholder: '{ "name": "world" }' }, "{}");
    const runBtn = h("button", { class: "btn btn--primary btn--sm", onclick: doRun }, "Run draft");
    box.append(h("div", { class: "fn-run__row" }, h("span", { class: "muted small" }, "Run"), entryFile, h("span", { class: "muted" }, "#"), entryFn, runBtn));
    box.append(h("div", { class: "fn-run__row" }, h("span", { class: "muted small" }, "Inputs"), inputs));
    const result = h("div", { class: "fn-run__result" });
    box.append(result);

    async function doRun() {
      stash();
      let parsed; try { parsed = JSON.parse(inputs.value || "{}"); } catch (e) { toast(`Inputs are not JSON: ${e.message}`, "err"); return; }
      await saveDraft();
      clear(result); result.append(h("div", { class: "muted small" }, "Running…"));
      try {
        const r = await api("/admin/functions/run", { method: "POST", body: { draft: { packageId: sel.package.id, file: entryFile.value.trim(), fn: entryFn.value.trim() || "execute" }, inputs: parsed } });
        renderRunResult(result, r.run, r.outputs);
      } catch (e) { clear(result); result.append(h("div", { class: "fn-err" }, e.message)); }
    }
    return box;
  }

  function renderRunResult(el, run, outputs) {
    clear(el);
    const ok = run.status === "done";
    el.append(h("div", { class: "fn-run__status" },
      h("span", { class: `badge badge--${ok ? "ok" : "err"}` }, run.status),
      h("span", { class: "muted small" }, `${run.ms} ms · ${run.memMb} MB · ${run.lang || ""}`)));
    if (run.error) el.append(h("pre", { class: "fn-err" }, `${run.error.type}: ${run.error.message}${run.error.stack ? "\n" + run.error.stack : ""}`));
    for (const o of outputs || []) el.append(OUT(o));
    const logs = C.api(`/admin/functions/runs/${encodeURIComponent(run.id)}`).then((d) => {
      if (!d.logs || !d.logs.length) return;
      const pre = h("pre", { class: "fn-logs" });
      for (const l of d.logs) pre.append(h("div", { class: `fn-log fn-log--${l.level}` }, `${l.level}  ${l.msg}${l.fields ? "  " + JSON.stringify(l.fields) : ""}`));
      el.append(h("div", { class: "muted small mt8" }, "Logs"), pre);
    }).catch(() => undefined);
    void logs;
  }

  /* ============================================================== models */

  function modelsView() {
    const wrap = h("div", { class: "fn-cols" });
    const list = h("div", { class: "fn-side card" });
    list.append(h("div", { class: "fn-side__head" }, h("span", {}, "Models"), writable() ? h("button", { class: "btn btn--sm", onclick: () => editModel(null) }, "+ New") : null));
    if (!data.models.length) list.append(h("div", { class: "muted small p8" }, "No models yet."));
    for (const m of data.models) {
      const on = modelDraft && modelDraft.id === m.id;
      list.append(h("button", { class: `fn-pkg${on ? " fn-pkg--on" : ""}`, onclick: () => editModel(m) },
        h("span", { class: "fn-pkg__name" }, m.name),
        m.keyword ? h("span", { class: "badge badge--accent" }, "/" + m.keyword) : null,
        h("span", { class: `badge badge--${m.enabled ? "ok" : ""}` }, m.enabled ? "on" : "off"),
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

  function modelForm() {
    const m = modelDraft;
    const form = h("div", { class: "fn-form card" });
    const ro = !writable();
    const text = (label, key, ph) => h("label", { class: "field" }, h("span", { class: "label" }, label), h("input", { class: "input", value: m[key] || "", placeholder: ph || "", disabled: ro, oninput: (e) => { m[key] = e.target.value; } }));

    form.append(h("div", { class: "fn-side__head" }, h("strong", {}, m.id ? `Model: ${m.name || m.id}` : "New model"),
      h("label", { class: "fn-switch" }, h("input", { type: "checkbox", checked: m.enabled, disabled: ro, onchange: (e) => { m.enabled = e.target.checked; } }), " enabled")));

    form.append(h("div", { class: "fn-grid2" }, text("Name", "name", "Weather"), text("Keyword (chat: /keyword)", "keyword", "pocasi")));
    form.append(text("Summary", "summary", "What it does, shown in the /command hint"));

    // entry picker
    const pkgs = data.packages.filter((p) => p.versions.length);
    const entryRow = h("div", { class: "fn-grid3" });
    const pkgSel = h("select", { class: "input", disabled: ro });
    pkgSel.append(h("option", { value: "" }, "— package —"));
    for (const p of pkgs) pkgSel.append(h("option", { value: p.name }, p.name));
    const verSel = h("select", { class: "input", disabled: ro });
    const fileIn = h("input", { class: "input", placeholder: "index.js#execute", disabled: ro });
    const parsed = /^([^@]+)@([^:]+):(.+)#(.+)$/.exec(m.entry || "");
    if (parsed) { pkgSel.value = parsed[1]; fileIn.value = `${parsed[3]}#${parsed[4]}`; }
    const fillVers = () => { clear(verSel); const p = pkgs.find((x) => x.name === pkgSel.value); for (const v of (p ? [...p.versions].reverse() : [])) verSel.append(h("option", { value: v }, v)); if (parsed && pkgSel.value === parsed[1]) verSel.value = parsed[2]; syncEntry(); };
    const syncEntry = () => { m.entry = pkgSel.value && verSel.value && fileIn.value.includes("#") ? `${pkgSel.value}@${verSel.value}:${fileIn.value}` : ""; };
    pkgSel.onchange = fillVers; verSel.onchange = syncEntry; fileIn.oninput = syncEntry; fillVers();
    entryRow.append(h("label", { class: "field" }, h("span", { class: "label" }, "Package"), pkgSel), h("label", { class: "field" }, h("span", { class: "label" }, "Version"), verSel), h("label", { class: "field" }, h("span", { class: "label" }, "File # function"), fileIn));
    form.append(h("fieldset", { class: "fn-fs" }, h("legend", {}, "Entry point"), entryRow));

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

    // inputs schema
    form.append(inputsEditor(m, ro));

    // actions + test
    const actions = h("div", { class: "fn-editor__actions mt8" });
    if (writable()) actions.append(h("button", { class: "btn btn--primary", onclick: saveModel }, "Save model"), m.id ? h("button", { class: "btn", onclick: testModel }, "Test run") : null, m.id ? h("button", { class: "btn btn--danger", onclick: deleteModel }, "Delete") : null);
    form.append(actions);
    const testResult = h("div", { class: "fn-run__result", id: "fnModelTest" });
    form.append(testResult);
    return form;

    async function saveModel() {
      syncEntry();
      try { const r = await api("/admin/functions/models", { method: "POST", body: m }); toast(`Model ${r.model.name} saved.`, "ok"); modelDraft = r.model; await load(); }
      catch (e) { toast(e.message, "err"); }
    }
    async function deleteModel() {
      if (!confirm(`Delete model "${m.name}"?`)) return;
      try { await api(`/admin/functions/models/${encodeURIComponent(m.id)}`, { method: "DELETE" }); toast("Model deleted.", "ok"); modelDraft = null; await load(); }
      catch (e) { toast(e.message, "err"); }
    }
    async function testModel() {
      const vals = {};
      for (const inp of m.inputs) { const f = document.getElementById(`fnti_${inp.name}`); if (f && f.value !== "") vals[inp.name] = f.value; }
      const el = document.getElementById("fnModelTest"); clear(el); el.append(h("div", { class: "muted small" }, "Running…"));
      try { const r = await api("/admin/functions/run", { method: "POST", body: { modelId: m.id, inputs: vals } }); renderRunResult(el, r.run, r.outputs); }
      catch (e) { clear(el); el.append(h("div", { class: "fn-err" }, e.message)); }
    }
  }

  function groupsField(m, ro) {
    const box = h("div", { class: "field" }, h("span", { class: "label" }, "Groups that may use it (none = everyone the module allows)"));
    const row = h("div", { class: "fn-groups" });
    for (const g of (data.groups || [])) {
      const on = m.groups.includes(g.id);
      row.append(h("label", { class: `fn-chip${on ? " fn-chip--on" : ""}` }, h("input", { type: "checkbox", checked: on, disabled: ro, onchange: (e) => { if (e.target.checked) m.groups.push(g.id); else m.groups = m.groups.filter((x) => x !== g.id); } }), g.label || g.id));
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
      m.inputs.forEach((inp, i) => {
        const typeSel = h("select", { class: "input input--sm", disabled: ro });
        for (const t of INPUT_TYPES) typeSel.append(h("option", { value: t, selected: inp.type === t }, t));
        typeSel.onchange = (e) => { inp.type = e.target.value; };
        const row = h("div", { class: "fn-input-row" },
          h("input", { class: "input input--sm", value: inp.name || "", placeholder: "name", disabled: ro, oninput: (e) => { inp.name = e.target.value; } }),
          typeSel,
          h("input", { class: "input input--sm", value: inp.label || "", placeholder: "label", disabled: ro, oninput: (e) => { inp.label = e.target.value; } }),
          h("input", { class: "input input--sm", value: inp.default === undefined ? "" : inp.default, placeholder: "default", disabled: ro, oninput: (e) => { inp.default = e.target.value || undefined; } }),
          h("label", { class: "fn-req" }, h("input", { type: "checkbox", checked: inp.required, disabled: ro, onchange: (e) => { inp.required = e.target.checked; } }), "req"),
          writable() ? h("button", { class: "fn-file__x", onclick: () => { m.inputs.splice(i, 1); redraw(); } }, "×") : null);
        list.append(row);
        if (inp.type === "enum") list.append(h("input", { class: "input input--sm fn-enum", value: (inp.values || []).join(", "), placeholder: "enum values, comma-separated", disabled: ro, oninput: (e) => { inp.values = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); } }));
      });
    };
    redraw();
    fs.append(list);
    if (writable()) fs.append(h("button", { class: "btn btn--sm", onclick: () => { m.inputs.push({ name: "", type: "string" }); redraw(); } }, "+ Input"));
    // a quick test form built from the schema
    if (m.inputs.length) {
      const tf = h("div", { class: "fn-testform" }, h("span", { class: "muted small" }, "Test values"));
      for (const inp of m.inputs) tf.append(h("label", { class: "fn-ti" }, h("span", { class: "muted small" }, (inp.label || inp.name) + (inp.required ? " *" : "")), h("input", { class: "input input--sm", id: `fnti_${inp.name}`, placeholder: inp.default !== undefined ? String(inp.default) : inp.type })));
      fs.append(tf);
    }
    return fs;
  }

  /* ================================================================ runs */

  async function runsView() {
    const wrap = h("div", { class: "stack" });
    const card = h("div", { class: "card" });
    card.append(h("div", { class: "fn-side__head" }, h("span", {}, "Recent runs"), h("button", { class: "btn btn--sm", onclick: () => render() }, "Refresh")));
    const body = h("div", {}, h("div", { class: "muted small p8" }, "Loading…"));
    card.append(body); wrap.append(card);
    try {
      const r = await api("/admin/functions/runs?limit=100");
      clear(body);
      if (!r.runs.length) { body.append(h("div", { class: "muted small p8" }, "No runs yet.")); return wrap; }
      const table = h("table", { class: "tbl" });
      table.append(h("thead", {}, h("tr", {}, ...["When", "Model", "Executor", "Status", "ms", "Caller"].map((t) => h("th", {}, t)))));
      const tb = h("tbody", {});
      for (const run of r.runs) {
        tb.append(h("tr", { class: "fn-run-row", onclick: () => showRun(run.id) },
          h("td", {}, new Date(run.queuedAt).toLocaleTimeString()),
          h("td", {}, run.modelId || "(draft)"),
          h("td", {}, run.executor),
          h("td", {}, h("span", { class: `badge badge--${run.status === "done" ? "ok" : run.status === "failed" || run.status === "timed-out" ? "err" : ""}` }, run.status)),
          h("td", {}, String(run.ms)),
          h("td", {}, run.caller ? run.caller.name : "")));
      }
      table.append(tb); body.append(table);
    } catch (e) { clear(body); body.append(h("div", { class: "fn-err" }, e.message)); }
    return wrap;
  }

  async function showRun(id) {
    try {
      const d = await api(`/admin/functions/runs/${encodeURIComponent(id)}`);
      const box = h("div", {});
      renderRunResult(box, d.run, d.run.outputs);
      const Kit = window.M5Kit;
      if (Kit && Kit.openDialog) Kit.openDialog({ title: `Run ${id}`, subtitle: d.run.entry, body: box, wide: true });
      else { const el = root(); clear(el); el.append(h("button", { class: "btn btn--sm", onclick: render }, "← Back"), box); }
    } catch (e) { toast(e.message, "err"); }
  }

  /* ============================================================= outputs */

  function outputRenderer() {
    return function renderOutput(o) {
      const box = h("div", { class: "fn-out" });
      if (o.title) box.append(h("div", { class: "muted small" }, o.title));
      switch (o.type) {
        case "text": box.append(h("div", {}, o.text)); break;
        case "markdown": box.append(mdBlock(o.text)); break;
        case "code": box.append(h("pre", { class: "fn-code" }, h("code", {}, o.text))); break;
        case "json": box.append(h("pre", { class: "fn-code" }, h("code", {}, JSON.stringify(o.value, null, 2)))); break;
        case "table": box.append(tableBlock(o)); break;
        case "image": { const img = h("img", { class: "fn-img", alt: o.alt || "" }); img.src = `data:${o.mime};base64,${o.data}`; box.append(img); break; }
        case "file": box.append(h("a", { class: "btn btn--sm", href: `data:${o.mime};base64,${o.data}`, download: o.name }, `⬇ ${o.name}`)); break;
        case "flash": box.append(h("div", { class: `fn-flash fn-flash--${o.level}` }, o.text)); break;
        case "window": box.append(h("div", { class: "muted small" }, `opens window: ${o.id}`)); break;
        default: box.append(h("pre", { class: "fn-code" }, JSON.stringify(o)));
      }
      return box;
    };
  }

  function tableBlock(o) {
    const t = h("table", { class: "tbl" });
    t.append(h("thead", {}, h("tr", {}, ...o.columns.map((c) => h("th", {}, String(c))))));
    const tb = h("tbody", {});
    for (const row of o.rows) tb.append(h("tr", {}, ...row.map((c) => h("td", {}, c === null || c === undefined ? "" : typeof c === "object" ? JSON.stringify(c) : String(c)))));
    t.append(tb);
    return t;
  }

  // A tiny, safe Markdown block: bold, italic, code, headings, lists, links.
  function mdBlock(text) {
    const box = h("div", { class: "fn-md" });
    for (const raw of String(text).split(/\n{2,}/)) {
      const line = raw.trim();
      if (!line) continue;
      const hm = /^(#{1,3})\s+(.*)$/.exec(line);
      if (hm) { box.append(h(`h${hm[1].length + 2}`, { class: "fn-md__h" }, inlineMd(hm[2]))); continue; }
      if (/^([-*]\s)/.test(line)) { const ul = h("ul", { class: "fn-md__ul" }); for (const li of line.split("\n")) ul.append(h("li", {}, inlineMd(li.replace(/^[-*]\s/, "")))); box.append(ul); continue; }
      const p = h("p", {}); for (const part of line.split("\n")) { p.append(...inlineMd(part), h("br", {})); } box.append(p);
    }
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
})();
