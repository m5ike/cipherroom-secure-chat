// M5cet operator console — Modules & groups (4.0, reworked in 5.2).
//
// Every part of the portal is a module: calls, files, AI & speech, telephony
// & SIP, and the console's tools (Functions, Layout and Menu builder). Per
// module: on/off (and the service itself where the server has a switch),
// default access and group access (allow / deny) with the access groups,
// the main group mod-<module> whose members get everything, grants that give
// or take away parts ("model:dns*", "-provider:openai", "number:+420*"), and
// what goes to the access log. Groups are "guest", "user", the console's
// "admin…" groups and the operator's own (members: usernames, or
// admin:<name>). Stored in the client configuration (server/client-config.ts);
// the server enforces it (server/access.ts), the app hides the rest.
// Same rules as console.js: DOM nodes and textContent only, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, $, $$, api, toast, can } = C;

  let config = null;
  let catalog = { modules: [], builtinGroups: [], consoleGroups: [] };
  let features = {};
  let state = { switches: {}, mainGroups: {} };
  let logTimer = null;
  const logFilter = { module: "", decision: "", subject: "", days: "2", auto: false };

  const DEFAULT_RULE = { enabled: true, groups: [], defaultAccess: "allow", groupAccess: "allow", grants: [], log: "all" };
  const ruleOf = (id) => ({ ...DEFAULT_RULE, ...(config.modules[id] || {}), groups: [...((config.modules[id] || {}).groups || [])], grants: [...((config.modules[id] || {}).grants || [])].map((g) => ({ group: g.group, rights: [...g.rights] })) });
  const isDefault = (r) => r.enabled && !r.groups.length && r.defaultAccess === "allow" && r.groupAccess === "allow" && !r.grants.length && r.log === "all";
  const REASON = { off: "module off", "main-group": "main group", "group-allow": "access group — allow", "group-deny": "access group — deny", "default-allow": "default — allow", "default-deny": "default — deny", grant: "grant", unlisted: "no rule — everyone", right: "not among the rights", owner: "console owner" };

  async function load() {
    // The state call creates the modules' main groups when they are missing — before the configuration is read.
    try { state = await api("/api/admin/modules/state"); } catch { state = { switches: {}, mainGroups: {} }; }
    const r = await api("/api/admin/client-config");
    config = r.config;
    catalog = r.catalog || catalog;
    features = r.features || {};
    render();
  }

  function allGroups() {
    return [...(catalog.builtinGroups || []), ...(catalog.consoleGroups || []), ...(config.groups || []).map((g) => ({ id: g.id, label: g.label, own: true }))];
  }
  const groupLabel = (id) => (allGroups().find((g) => g.id === id) || { label: id }).label;

  function render() {
    renderModules();
    renderGroups(config.groups || []);
    renderExtra();
    C.applyRoleGates($("[data-panel=modules]"));
  }

  /* ============================================================== modules */

  function summary(m, r) {
    if (!r.enabled) return h("span", { class: "badge badge--err" }, "off");
    const parts = [];
    const main = state.mainGroups && state.mainGroups[m.id];
    parts.push(h("span", { class: `badge badge--${r.defaultAccess === "allow" ? "ok" : "warn"}`, title: "Default access" }, `default ${r.defaultAccess}`));
    if (r.groups.length) parts.push(h("span", { class: "small" }, ` ${r.groupAccess === "allow" ? "allow" : "deny"}: ${r.groups.map(groupLabel).join(", ")}`));
    if (main) { const g = (config.groups || []).find((x) => x.id === main); parts.push(h("span", { class: "muted small", title: "Members of the main group get everything" }, ` · ${main} (${g ? g.members.length : 0})`)); }
    if (r.grants.length) parts.push(h("span", { class: "muted small" }, ` · ${r.grants.length} grant${r.grants.length > 1 ? "s" : ""}`));
    return h("span", {}, ...parts);
  }

  function renderModules() {
    const tbody = $("#modulesTable").tBodies[0];
    clear(tbody);
    for (const m of catalog.modules || []) {
      const r = ruleOf(m.id);
      const feature = m.feature ? features[m.feature] : m.switch ? features[m.switch] : null;
      let service;
      if (m.switch) {
        const sw = (state.switches || {})[m.switch] || { enabled: false, source: "default" };
        const input = h("input", { type: "checkbox", checked: sw.enabled || undefined, disabled: sw.source === "env" || !can("operator") || undefined, "data-switch": m.switch });
        input.addEventListener("change", () => setSwitch(m.switch, input.checked, input));
        service = h("div", {}, h("label", { class: "switch", title: sw.source === "env" ? `Fixed by ${sw.env} in the server's environment` : "The service itself (plugins.json)" }, input, sw.enabled ? "running" : "stopped"),
          sw.source === "env" ? h("div", { class: "muted small" }, sw.env) : null,
          feature && !feature.enabled && m.feature ? h("div", { class: "muted small", title: feature.reason || "" }, "not configured") : null);
      } else if (!m.feature) service = h("span", { class: "muted" }, m.console ? "console tool" : "in the browser");
      else service = feature && feature.enabled ? h("span", { class: "badge badge--ok" }, "configured") : h("span", { class: "badge badge--warn", title: (feature && feature.reason) || "" }, "not configured");
      const log = h("select", { class: "input input--sm", "data-module-log": m.id, title: "What goes to the access log" },
        ...[["all", "all"], ["deny", "refusals"], ["off", "off"]].map(([v, l]) => h("option", { value: v, selected: r.log === v || undefined }, l)));
      tbody.append(h("tr", { "data-module": m.id },
        h("td", {}, h("strong", {}, m.label), m.rights ? h("span", { class: "badge badge--accent", title: "Has parts: grants can give or take them" }, " parts") : null, h("div", { class: "muted small" }, m.description)),
        h("td", {}, service),
        h("td", {}, h("label", { class: "switch" }, h("input", { type: "checkbox", "data-module-on": m.id, checked: r.enabled || undefined }))),
        h("td", { "data-module-summary": m.id }, summary(m, r)),
        h("td", {}, log),
        h("td", {}, h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: () => settings(m) }, "Settings…")),
      ));
    }
  }

  async function setSwitch(which, on, input) {
    try {
      const r = await api("/api/admin/modules/switches", { method: "PUT", body: { [which]: on } });
      state.switches = r.switches;
      toast(`${which} ${on ? "started" : "stopped"}.`, "ok");
      renderModules();
    } catch (e) { toast(e.message, "err"); input.checked = !on; }
  }

  /** The table's on/off and log, over the rules the dialogs edited. */
  function collectModules() {
    const out = {};
    for (const m of catalog.modules || []) {
      const r = ruleOf(m.id);
      const on = $(`[data-module-on="${m.id}"]`);
      const log = $(`[data-module-log="${m.id}"]`);
      if (on) r.enabled = on.checked;
      if (log) r.log = log.value;
      // Only what differs from "on for everyone, all logged" is stored.
      if (!isDefault(r)) out[m.id] = r;
    }
    return out;
  }

  /* ------------------------------------------------------------ settings dialog */

  const membersOf = (id) => ((config.groups || []).find((g) => g.id === id) || { members: [] }).members;
  const setMembers = (id, members, label) => {
    const groups = config.groups || (config.groups = []);
    const g = groups.find((x) => x.id === id);
    if (g) g.members = members; else groups.push({ id, label: label || id, members });
  };
  const splitList = (text) => [...new Set(String(text).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];

  async function settings(m) {
    const Kit = window.M5Kit;
    if (!Kit) return;
    config.groups = collectGroups().filter((g) => g.id);
    const rule = ruleOf(m.id);
    const on = $(`[data-module-on="${m.id}"]`); if (on) rule.enabled = on.checked;
    const logSel = $(`[data-module-log="${m.id}"]`); if (logSel) rule.log = logSel.value;
    const main = m.rights ? `mod-${m.id}` : null;
    const body = h("div", { class: "stack md-dlg" });
    const suggestions = h("datalist", { id: `mdRights-${m.id}` });
    for (const r of m.rights || []) suggestions.append(h("option", { value: r.right }, r.label));
    void loadSuggestions(m, suggestions);

    const radio = (name, value, current, label, onpick) => {
      const input = h("input", { type: "radio", name, value, checked: current === value || undefined });
      input.addEventListener("change", () => { if (input.checked) onpick(value); });
      return h("label", { class: "md-radio" }, input, label);
    };
    const enabled = h("input", { type: "checkbox", checked: rule.enabled || undefined });
    enabled.addEventListener("change", () => { rule.enabled = enabled.checked; });
    body.append(h("label", { class: "switch" }, enabled, "Module on (off: nobody, whatever the rules)"));

    // default and group access
    body.append(h("div", { class: "md-grid" },
      h("fieldset", { class: "md-fs" }, h("legend", {}, "Default access"),
        h("p", { class: "muted small" }, "For everyone the rules below do not decide."),
        radio(`da-${m.id}`, "allow", rule.defaultAccess, "Allow", (v) => { rule.defaultAccess = v; }),
        radio(`da-${m.id}`, "deny", rule.defaultAccess, "Deny", (v) => { rule.defaultAccess = v; })),
      h("fieldset", { class: "md-fs" }, h("legend", {}, "Group access"),
        h("p", { class: "muted small" }, "What being in an access group means."),
        radio(`ga-${m.id}`, "allow", rule.groupAccess, "Allow the access groups", (v) => { rule.groupAccess = v; }),
        radio(`ga-${m.id}`, "deny", rule.groupAccess, "Deny the access groups", (v) => { rule.groupAccess = v; }))));

    // access groups + their members
    const accessBox = h("fieldset", { class: "md-fs" }, h("legend", {}, "Access groups"));
    const chips = h("div", { class: "chips" });
    const memberEditors = h("div", { class: "stack" });
    const drawAccess = () => {
      clear(chips); clear(memberEditors);
      for (const g of allGroups()) {
        if (g.id === main) continue;
        const cb = h("input", { type: "checkbox", value: g.id, checked: rule.groups.includes(g.id) || undefined });
        cb.addEventListener("change", () => { rule.groups = cb.checked ? [...rule.groups, g.id] : rule.groups.filter((x) => x !== g.id); drawAccess(); });
        chips.append(h("label", { class: "chip-check" }, cb, g.label || g.id));
      }
      for (const id of rule.groups) {
        const own = (config.groups || []).find((x) => x.id === id);
        if (!own) { memberEditors.append(h("div", { class: "muted small" }, `${groupLabel(id)} — a built-in group (members decided by sign-in / role)`)); continue; }
        const ta = h("textarea", { class: "input mono", rows: "2", placeholder: "bystry-sokol-7k3q\nadmin:alice" }, own.members.join("\n"));
        ta.addEventListener("change", () => setMembers(id, splitList(ta.value)));
        memberEditors.append(h("label", { class: "field" }, h("span", { class: "label" }, `Members of ${own.label} (${id})`), ta));
      }
    };
    const newId = h("input", { class: "input input--sm mono", placeholder: `${m.id}-users`, style: "max-width:180px" });
    const addGroup = h("button", { type: "button", class: "btn btn--sm", onclick: () => {
      const id = (newId.value.trim() || `${m.id}-users`).toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) { toast("A group id: a–z, 0–9 and “-”.", "err"); return; }
      if (!allGroups().some((g) => g.id === id)) setMembers(id, [], `${m.label} users`);
      if (!rule.groups.includes(id)) rule.groups.push(id);
      newId.value = ""; drawAccess();
    } }, "New access group");
    accessBox.append(h("p", { class: "muted small" }, `The users of these groups are ${rule.groupAccess === "deny" ? "denied" : "allowed"} (group access above).`), chips, h("div", { class: "row" }, newId, addGroup), memberEditors);
    drawAccess();
    body.append(accessBox);

    // main group
    if (main) {
      const ta = h("textarea", { class: "input mono", rows: "3", placeholder: "bystry-sokol-7k3q\nadmin:alice" }, membersOf(main).join("\n"));
      ta.addEventListener("change", () => setMembers(main, splitList(ta.value), `${m.label} — all rights`));
      body.append(h("fieldset", { class: "md-fs" }, h("legend", {}, `Main group — ${main}`),
        h("p", { class: "muted small" }, "Its members always get the whole module (every part), whatever the other rules — while the module is on."),
        ta));
    }

    // grants
    if (m.rights) {
      const grantsBox = h("fieldset", { class: "md-fs" }, h("legend", {}, "Grants — parts of the module"));
      const help = h("div", { class: "md-rights muted small" }, ...(m.rights || []).map((r) => h("div", {}, h("code", {}, r.right), ` ${r.label}${r.help ? " — " + r.help : ""}`)));
      const list = h("div", { class: "stack" });
      const drawGrants = () => {
        clear(list);
        rule.grants.forEach((g, i) => {
          const sel = h("select", { class: "input input--sm" }, ...allGroups().map((x) => h("option", { value: x.id, selected: x.id === g.group || undefined }, x.label || x.id)));
          sel.addEventListener("change", () => { g.group = sel.value; });
          const rights = h("input", { class: "input input--sm mono", value: g.rights.join(" "), list: `mdRights-${m.id}`, placeholder: "model:dns* package:netkit -model:admin*" });
          rights.addEventListener("change", () => { g.rights = splitList(rights.value); });
          list.append(h("div", { class: "md-grant" }, sel, rights, h("button", { type: "button", class: "btn btn--sm btn--danger", title: "Remove the grant", onclick: () => { rule.grants.splice(i, 1); drawGrants(); } }, "×")));
        });
        if (!rule.grants.length) list.append(h("div", { class: "muted small" }, "No grants: whoever has the module has all of it."));
      };
      drawGrants();
      grantsBox.append(h("p", { class: "muted small" }, "A grant gives its group parts of the module — also to people the access rules deny — or takes parts away with “-”. Wildcards: * and ? (dns*, *check). A pattern without “kind:” matches the name of anything: dns* = model:dns…, package:dns…. Actions (run, chat, sms, edit…) and items (model:, provider:, number:…) combine: “chat provider:local” is chat with the local provider only; a grant that names no action allows every action on its items."),
        list, h("button", { type: "button", class: "btn btn--sm", onclick: () => { rule.grants.push({ group: (config.groups[0] || { id: "user" }).id, rights: [] }); drawGrants(); } }, "+ Grant"), help, suggestions);
      body.append(grantsBox);
    }

    // log
    const log = h("select", { class: "input input--sm" }, ...[["all", "every decision — allowed and refused"], ["deny", "refusals only"], ["off", "nothing"]].map(([v, l]) => h("option", { value: v, selected: rule.log === v || undefined }, l)));
    log.addEventListener("change", () => { rule.log = log.value; });
    body.append(h("label", { class: "field" }, h("span", { class: "label" }, "Access log"), log));

    // test
    const who = h("input", { class: "input input--sm mono", placeholder: "username · admin:alice · guest" });
    const right = h("input", { class: "input input--sm mono", placeholder: "optional: run model:whois · chat provider:openai", list: `mdRights-${m.id}` });
    const out = h("div", { class: "md-test" });
    const test = h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: async () => {
      clear(out);
      try {
        const r = await api("/admin/access/explain", { method: "POST", body: { module: m.id, subject: who.value.trim() || "guest", right: right.value.trim() } });
        out.append(h("div", {}, h("span", { class: `badge badge--${(r.right ? r.rightAllowed : r.allowed) ? "ok" : "err"}` }, (r.right ? r.rightAllowed : r.allowed) ? "allowed" : "denied"), ` ${r.subject} — ${REASON[r.reason] || r.reason}`),
          h("div", { class: "muted small" }, `groups: ${r.groups.join(", ")}`),
          h("div", { class: "muted small" }, `rights: ${r.rights.length ? r.rights.join(" ") : "none"}`));
      } catch (e) { out.append(h("div", { class: "fn-err" }, e.message)); }
    } }, "Test");
    body.append(h("fieldset", { class: "md-fs" }, h("legend", {}, "Test access (the saved rules)"), h("div", { class: "row" }, who, right, test), out));

    const save = h("button", { type: "button", class: "btn btn--primary" }, "Save");
    body.append(h("div", { class: "row md-actions" }, save));
    const dlg = Kit.openDialog({ title: `${m.label} — access`, subtitle: m.description, body, wide: true });
    save.addEventListener("click", async () => {
      config.modules = { ...config.modules, [m.id]: rule };
      const modules = collectModules();
      modules[m.id] = rule; // the dialog's on/off and log win over the table's
      if (isDefault(rule)) delete modules[m.id];
      try {
        const r = await api("/api/admin/client-config", { method: "PUT", body: { config: { ...config, modules, groups: config.groups } } });
        config = r.config;
        dlg.close();
        render();
        toast(`${m.label}: access saved. The server applies it at once; clients within five minutes.`, "ok");
      } catch (e) { toast(e.message, "err"); }
    });
  }

  /** Names to pick from: the models, packages, providers the module has. */
  async function loadSuggestions(m, list) {
    const add = (v, l) => list.append(h("option", { value: v }, l || ""));
    try {
      if (m.id === "functions") {
        const d = await api("/admin/functions");
        for (const x of d.models || []) if (x.keyword) add(`model:${x.keyword}`, x.name);
        for (const p of d.packages || []) add(`package:${p.name}`, p.description || "");
      } else if (m.id === "ai" || m.id === "speech") {
        const d = await api("/admin/ai");
        for (const p of d.providers || []) {
          add(`provider:${p.id}`, p.label);
          for (const x of p.models || []) if ((m.id === "ai") === (x.kind === "chat")) add(`model:${p.id}/${x.id}`, `${p.label} · ${x.label || x.id}`);
        }
      }
    } catch { /* names are a help only */ }
  }

  /* =============================================================== groups */

  function renderGroups(groups) {
    const list = $("#groupsList");
    clear(list);
    const usedBy = (id) => (catalog.modules || []).filter((m) => { const r = config.modules[m.id]; return r && (r.groups.includes(id) || (r.grants || []).some((g) => g.group === id)); }).map((m) => m.label);
    for (const g of [...(catalog.builtinGroups || []), ...(catalog.consoleGroups || [])]) {
      list.append(h("div", { class: "group group--builtin" },
        h("div", { class: "group__head" }, h("code", {}, g.id), h("span", {}, g.label), h("span", { class: "badge" }, "built in"))));
    }
    groups.forEach((g, i) => {
      const used = usedBy(g.id);
      const isMain = /^mod-/.test(g.id);
      list.append(h("div", { class: "group", "data-group-row": String(i) },
        h("div", { class: "group__head" },
          h("input", { class: "input mono", value: g.id, "data-group-id": String(i), placeholder: "support", style: "max-width:180px", readonly: isMain || undefined }),
          h("input", { class: "input", value: g.label, "data-group-label": String(i), placeholder: "Support team" }),
          h("span", { class: "muted small" }, `${(g.members || []).length} members`),
          isMain ? h("span", { class: "badge badge--accent", title: "A module's main group: all rights" }, "main group") : null,
          used.length ? h("span", { class: "muted small", title: "Modules whose rules name it" }, `· ${used.join(", ")}`) : null,
          isMain ? null : h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: () => { const all = collectGroups(); all.splice(i, 1); renderGroups(all); } }, "Remove")),
        h("textarea", { class: "input mono", rows: "3", "data-group-members": String(i), placeholder: "bystry-sokol-7k3q\nadmin:alice" }, (g.members || []).join("\n"))));
    });
    C.applyRoleGates(list);
  }

  function collectGroups() {
    return $$("[data-group-id]").map((input) => {
      const i = input.dataset.groupId;
      return {
        id: input.value.trim().toLowerCase(),
        label: ($(`[data-group-label="${i}"]`) || {}).value || "",
        members: splitList((($(`[data-group-members="${i}"]`) || {}).value || "")),
      };
    });
  }

  async function save(patch, what) {
    try {
      const r = await api("/api/admin/client-config", { method: "PUT", body: { config: { ...config, ...patch } } });
      config = r.config;
      render();
      toast(`${what} saved. The server applies it at once; clients within five minutes (or on reload).`, "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  /* ============================================================ access log */

  function renderExtra() {
    const box = $("#modulesExtra");
    if (!box) return;
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
    clear(box);
    box.append(composerCard(), accessLogCard());
  }

  function accessLogCard() {
    const card = h("div", { class: "card" });
    const modSel = h("select", { class: "input input--sm", "data-read": "1" }, h("option", { value: "" }, "every module"), ...(catalog.modules || []).map((m) => h("option", { value: m.id, selected: logFilter.module === m.id || undefined }, m.label)));
    const decSel = h("select", { class: "input input--sm", "data-read": "1" }, ...[["", "allowed and refused"], ["allow", "allowed"], ["deny", "refused"]].map(([v, l]) => h("option", { value: v, selected: logFilter.decision === v || undefined }, l)));
    const subj = h("input", { class: "input input--sm mono", placeholder: "who (username, admin:…)", value: logFilter.subject, "data-read": "1" });
    const days = h("select", { class: "input input--sm", "data-read": "1" }, ...[["1", "today"], ["2", "2 days"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v, selected: logFilter.days === v || undefined }, l)));
    const auto = h("input", { type: "checkbox", checked: logFilter.auto || undefined, "data-read": "1" });
    const stats = h("div", { class: "md-stats" });
    const tbody = h("tbody");
    const table = h("table", { class: "t" }, h("thead", {}, h("tr", {}, ...["Time", "Module", "Who", "Decision", "Why", "Part / request", "Via"].map((t) => h("th", {}, t)))), tbody);
    const fill = async () => {
      logFilter.module = modSel.value; logFilter.decision = decSel.value; logFilter.subject = subj.value.trim(); logFilter.days = days.value;
      const q = new URLSearchParams({ days: logFilter.days, limit: "300" });
      if (logFilter.module) q.set("module", logFilter.module);
      if (logFilter.decision) q.set("decision", logFilter.decision);
      if (logFilter.subject) q.set("subject", logFilter.subject);
      try {
        const r = await api(`/admin/access/log?${q}`);
        clear(stats);
        for (const [mod, s] of Object.entries(r.stats || {})) stats.append(h("span", { class: "md-stat" }, h("strong", {}, mod), ` ${s.allow} ✓ `, h("span", { class: s.deny ? "md-deny" : "muted" }, `${s.deny} ✗`)));
        clear(tbody);
        if (!r.entries.length) tbody.append(h("tr", {}, h("td", { colspan: "7", class: "muted" }, "Nothing yet — decisions appear here as people use the modules.")));
        for (const e of r.entries) {
          tbody.append(h("tr", {},
            h("td", { class: "mono small" }, new Date(e.at).toLocaleString()),
            h("td", {}, e.module),
            h("td", { class: "mono small" }, e.subject, h("span", { class: "muted" }, ` ${e.kind}`)),
            h("td", {}, h("span", { class: `badge badge--${e.decision === "allow" ? "ok" : "err"}` }, e.decision)),
            h("td", { class: "small" }, REASON[e.reason] || e.reason),
            h("td", { class: "mono small" }, [e.right, e.path].filter(Boolean).join(" · ")),
            h("td", { class: "muted small" }, e.via, e.ip ? ` ${e.ip}` : "")));
        }
      } catch (err) { clear(tbody); tbody.append(h("tr", {}, h("td", { colspan: "7", class: "fn-err" }, err.message))); }
    };
    for (const el of [modSel, decSel, days]) el.addEventListener("change", fill);
    subj.addEventListener("change", fill);
    auto.addEventListener("change", () => { logFilter.auto = auto.checked; if (logTimer) { clearInterval(logTimer); logTimer = null; } if (auto.checked) logTimer = setInterval(() => { if (!card.isConnected) { clearInterval(logTimer); logTimer = null; return; } void fill(); }, 5000); });
    card.append(h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Access log"), h("div", { class: "card__hint" }, "Every module decision — for app users, the console's administrators, webhooks and the API — allowed and refused, as each module's Log setting says. Kept 30 days (ACCESS_LOG_DAYS) in $DATA_DIR/access."),
      h("div", { class: "card__actions" }, h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: fill }, "Refresh"))),
      h("div", { class: "row md-filters" }, modSel, decSel, subj, days, h("label", { class: "switch small" }, auto, "live")),
      stats, h("div", { class: "table-wrap" }, table));
    void fill();
    if (logFilter.auto) logTimer = setInterval(() => { if (!card.isConnected) { clearInterval(logTimer); logTimer = null; return; } void fill(); }, 5000);
    return card;
  }

  /* ============================================================ message input (composer) */

  const ACTIONS = [["functions", "Functions — “/keyword” commands"], ["mentions", "Mentions — people in the room"], ["tags", "Tags — #topics"]];

  function composerCard() {
    const comp = config.composer || { triggers: [{ char: "/", action: "functions" }, { char: "@", action: "mentions" }, { char: "#", action: "tags" }], tags: [] };
    const card = h("form", { class: "card" });
    const rows = h("div", { class: "stack" });
    const draw = () => {
      clear(rows);
      comp.triggers.forEach((t, i) => {
        const ch = h("input", { class: "input input--sm mono", value: t.char, maxlength: "1", style: "max-width:60px", "aria-label": "Character" });
        ch.addEventListener("change", () => { t.char = ch.value.trim().slice(0, 1); });
        const act = h("select", { class: "input input--sm" }, ...ACTIONS.map(([v, l]) => h("option", { value: v, selected: t.action === v || undefined }, l)));
        act.addEventListener("change", () => { t.action = act.value; });
        rows.append(h("div", { class: "row" }, ch, act, h("button", { type: "button", class: "btn btn--sm btn--danger", onclick: () => { comp.triggers.splice(i, 1); draw(); } }, "×")));
      });
    };
    draw();
    const tags = h("textarea", { class: "input mono", rows: "2", placeholder: "urgent\nmeeting\nbug" }, (comp.tags || []).join("\n"));
    card.append(h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Message input — activation characters"),
      h("div", { class: "card__hint" }, "What typing a character in the app's message box offers: “/” the Functions commands (at the start of a message), “@” the people in the room, “#” tags. Several characters may do the same (e.g. “/” and “!” for commands).")),
      rows,
      h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn btn--sm", onclick: () => { comp.triggers.push({ char: "!", action: "functions" }); draw(); } }, "+ Character")),
      h("label", { class: "field" }, h("span", { class: "label" }, "Suggested tags (one per line; tags used in a room are suggested too)"), tags),
      h("div", { class: "toolbar" }, h("button", { class: "btn btn--primary", type: "submit" }, "Save message input")));
    card.addEventListener("submit", (e) => {
      e.preventDefault();
      const triggers = comp.triggers.filter((t) => t.char && !/\s/.test(t.char));
      if (new Set(triggers.map((t) => t.char)).size !== triggers.length) { toast("Each character only once.", "err"); return; }
      void save({ composer: { triggers, tags: splitList(tags.value) } }, "Message input");
    });
    return card;
  }

  $("#modulesForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void save({ modules: collectModules() }, "Modules");
  });
  $("#groupsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const groups = collectGroups().filter((g) => g.id);
    const reserved = new Set([...(catalog.builtinGroups || []), ...(catalog.consoleGroups || [])].map((g) => g.id));
    const bad = groups.find((g) => !/^[a-z][a-z0-9-]{1,31}$/.test(g.id) || reserved.has(g.id));
    if (bad) { toast(`"${bad.id}" is not a group id (a–z, 0–9, "-"; not a built-in one).`, "err"); return; }
    void save({ groups }, "Groups");
  });
  $("#groupAdd").addEventListener("click", () => renderGroups([...collectGroups(), { id: "", label: "", members: [] }]));
  C.addRoute("modules", ["Modules & groups", "Every part of the portal: who may use it, which parts, and the access log", load]);
})();
