// M5cet operator console — Modules & groups (4.0).
//
// Which parts of the app are on, and for whom: every module (calls, files,
// AI, telephony, invitations, …) can be switched off or given to some groups
// only; groups are "guest", "user" and the operator's own, whose members are
// usernames. Stored in the client configuration (server/client-config.ts);
// the server enforces the modules it serves, the app hides the rest.
// Same rules as console.js: DOM nodes and textContent only, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, $, $$, api, toast } = C;

  let config = null;
  let catalog = { modules: [], builtinGroups: [] };
  let features = {};

  async function load() {
    const r = await api("/api/admin/client-config");
    config = r.config;
    catalog = r.catalog || catalog;
    features = r.features || {};
    render();
  }

  function allGroups() {
    return [...(catalog.builtinGroups || []), ...(config.groups || []).map((g) => ({ id: g.id, label: g.label }))];
  }

  function render() {
    renderModules();
    renderGroups(config.groups || []);
    C.applyRoleGates($("[data-panel=modules]"));
  }

  function renderModules() {
    const tbody = $("#modulesTable").tBodies[0];
    clear(tbody);
    const groups = allGroups();
    for (const m of catalog.modules || []) {
      const rule = config.modules[m.id] || { enabled: true, groups: [] };
      const feature = m.feature ? features[m.feature] : null;
      const server = !m.feature ? h("span", { class: "muted" }, "in the browser")
        : feature && feature.enabled ? h("span", { class: "badge badge--ok" }, "configured")
        : h("span", { class: "badge badge--warn", title: (feature && feature.reason) || "" }, "not configured");
      const chips = h("div", { class: "chips" }, groups.map((g) => h("label", { class: "chip-check" },
        h("input", { type: "checkbox", value: g.id, "data-module-group": m.id, checked: rule.groups.includes(g.id) || undefined }),
        g.label || g.id)));
      const all = h("span", { class: "muted small", "data-module-all": m.id }, rule.groups.length ? "" : "everyone");
      tbody.append(h("tr", { "data-module": m.id },
        h("td", {}, h("strong", {}, m.label), h("div", { class: "muted small" }, m.description)),
        h("td", {}, server),
        h("td", {}, h("label", { class: "switch" }, h("input", { type: "checkbox", "data-module-on": m.id, checked: rule.enabled || undefined }))),
        h("td", {}, chips, all),
      ));
    }
    for (const box of $$("[data-module-group]")) {
      box.addEventListener("change", () => {
        const id = box.dataset.moduleGroup;
        const any = $$(`[data-module-group="${id}"]`).some((b) => b.checked);
        const hint = $(`[data-module-all="${id}"]`);
        if (hint) hint.textContent = any ? "" : "everyone";
      });
    }
  }

  function collectModules() {
    const out = {};
    for (const m of catalog.modules || []) {
      const on = $(`[data-module-on="${m.id}"]`);
      const groups = $$(`[data-module-group="${m.id}"]`).filter((b) => b.checked).map((b) => b.value);
      // Only what differs from "on for everyone" is stored.
      if (on && (!on.checked || groups.length)) out[m.id] = { enabled: on.checked, groups };
    }
    return out;
  }

  function renderGroups(groups) {
    const list = $("#groupsList");
    clear(list);
    for (const g of catalog.builtinGroups || []) {
      list.append(h("div", { class: "group group--builtin" },
        h("div", { class: "group__head" }, h("code", {}, g.id), h("span", {}, g.label), h("span", { class: "badge" }, "built in"))));
    }
    groups.forEach((g, i) => {
      list.append(h("div", { class: "group", "data-group-row": String(i) },
        h("div", { class: "group__head" },
          h("input", { class: "input mono", value: g.id, "data-group-id": String(i), placeholder: "support", style: "max-width:180px" }),
          h("input", { class: "input", value: g.label, "data-group-label": String(i), placeholder: "Support team" }),
          h("span", { class: "muted small" }, `${(g.members || []).length} members`),
          h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: () => { const all = collectGroups(); all.splice(i, 1); renderGroups(all); } }, "Remove")),
        h("textarea", { class: "input mono", rows: "3", "data-group-members": String(i), placeholder: "bystry-sokol-7k3q\ntichy-rys-m2pz" }, (g.members || []).join("\n"))));
    });
    C.applyRoleGates(list);
  }

  function collectGroups() {
    return $$("[data-group-id]").map((input) => {
      const i = input.dataset.groupId;
      return {
        id: input.value.trim().toLowerCase(),
        label: ($(`[data-group-label="${i}"]`) || {}).value || "",
        members: (($(`[data-group-members="${i}"]`) || {}).value || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean),
      };
    });
  }

  async function save(patch, what) {
    try {
      const r = await api("/api/admin/client-config", { method: "PUT", body: { config: { ...config, ...patch } } });
      config = r.config;
      render();
      toast(`${what} saved. Clients pick it up within five minutes (or on reload).`, "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  $("#modulesForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void save({ modules: collectModules() }, "Modules");
  });
  $("#groupsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const groups = collectGroups().filter((g) => g.id);
    const bad = groups.find((g) => !/^[a-z][a-z0-9-]{1,31}$/.test(g.id) || g.id === "guest" || g.id === "user");
    if (bad) { toast(`"${bad.id}" is not a group id (a–z, 0–9, "-", not guest/user).`, "err"); return; }
    void save({ groups }, "Groups");
  });
  $("#groupAdd").addEventListener("click", () => renderGroups([...collectGroups(), { id: "", label: "", members: [] }]));
  C.addRoute("modules", ["Modules & groups", "Which parts of the app are on, and for whom", load]);
})();
