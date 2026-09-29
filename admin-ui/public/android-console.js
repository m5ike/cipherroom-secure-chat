// M5cet operator console — Android (6.0).
//
//   Overview   the fleet at a glance, the server's Android key, getting the app
//   Devices    enrolled phones: state, commands (ping, status, flash, push,
//              update, lock, wipe), history, events; block, retire, delete
//   Push       one control message to several devices; FCM settings and a test
//   Design     the app's look: screens (element trees) with a live phone
//              preview, theme, animations, texts, menus, action libraries, assets
//   Builds     the design frozen, encrypted and signed; publish, withdraw,
//              restore, inspect, deploy files for chosen devices
//   Releases   APK versions: upload (package and certificate checked), publish
//   Security   lock policy (biometrics, PIN, attempts, wipe, wait, auto-lock),
//              polling, updates, rooms; enrolment mode and codes (QR)
//   Events     what devices reported (failed unlocks, wipes, updates, crashes)
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  const Kit = window.M5Kit;
  const X = window.M5AndroidExpr;
  if (!C || !Kit || !X) return;
  const { h, clear, api, toast, can } = C;

  const root = () => document.getElementById("androidRoot");
  let tab = "overview";
  let overview = null;
  let catalog = null;
  let design = null;
  let designSaved = "";
  let screenId = "room";
  let selected = "";
  let designTab = "screens";
  let previewDark = false;
  let previewLang = "cs";

  const may = (right) => {
    if (!can("operator")) return false;
    const acc = C.moduleAccess ? C.moduleAccess("android") : null;
    if (!acc) return true;
    if (!acc.allowed) return false;
    if (!acc.rights) return true;
    return acc.rights.some((r) => r === "*" || r === right);
  };

  const pad = (n) => String(n).padStart(2, "0");
  const when = (t) => { if (!t) return "—"; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const ago = (t) => { if (!t) return "never"; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const size = (n) => (!n ? "—" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);
  const badge = (text, tone) => h("span", { class: `badge${tone ? ` badge--${tone}` : ""}` }, text);
  const statusTone = (s) => ({ active: "ok", published: "ok", ready: "info", draft: "info", blocked: "warn", withdrawn: "warn", retired: "", wiped: "err", done: "ok", failed: "err", queued: "info", sent: "info", delivered: "accent", expired: "" }[s] ?? "");
  const levelTone = (l) => ({ error: "err", warn: "warn", notice: "info", info: "" }[l] ?? "");

  async function guarded(fn, okText) {
    try { const r = await fn(); if (okText) toast(okText, "ok"); return r; }
    catch (err) { toast(err.message, "err"); return null; }
  }

  /* =============================================================== load */

  async function load() {
    const el = root();
    if (!el) return;
    try {
      overview = await api("/api/admin/android");
      if (!catalog) catalog = (await api("/api/admin/android/catalog")).catalog;
    } catch (err) {
      clear(el).append(h("div", { class: "card empty" }, `Android is not available: ${err.message}`));
      return;
    }
    render();
  }

  function render() {
    const el = root();
    if (!el) return;
    clear(el);
    const bar = h("div", { class: "seg ai-tabs", role: "tablist" });
    for (const [id, label] of [["overview", "Overview"], ["devices", "Devices"], ["push", "Push"], ["design", "Design"], ["builds", "Builds"], ["releases", "Releases"], ["security", "Security"], ["events", "Events"]]) {
      bar.append(h("button", { type: "button", role: "tab", "aria-pressed": tab === id ? "true" : "false", "data-read": "1", onclick: () => { tab = id; render(); } }, label));
    }
    el.append(bar);
    const body = h("div", { class: "stack" });
    el.append(body);
    const views = { overview: overviewView, devices: devicesView, push: pushView, design: designView, builds: buildsView, releases: releasesView, security: securityView, events: eventsView };
    void (views[tab] || overviewView)(body);
    C.applyRoleGates();
  }

  /* =========================================================== overview */

  function kpi(label, value, sub, tone) {
    return h("div", { class: "card kpi" }, h("div", { class: "kpi__label" }, label), h("div", { class: `kpi__value${tone ? ` t-${tone}` : ""}` }, String(value)), sub ? h("div", { class: "kpi__sub" }, sub) : null);
  }

  function overviewView(body) {
    const o = overview;
    const c = o.counts;
    body.append(h("div", { class: "grid grid--kpi" },
      kpi("Devices", c.active, `${c.devices} enrolled · ${c.wiped} wiped`),
      kpi("Seen in 24 h", c.seen24h, "checked in or answered"),
      kpi("Builds", c.builds, "design bundles"),
      kpi("Releases", c.releases, "APK versions"),
      kpi("Events 24 h", c.events24h, "security, updates, crashes"),
      kpi("Push", o.fcm.ready ? "FCM" : "polling", o.fcm.ready ? "control messages go at once" : o.fcm.reason)));
    if (!o.store.persistent) body.append(h("div", { class: "card warn" }, h("strong", {}, "In memory only. "), o.store.reason));
    body.append(h("div", { class: "grid grid--2" },
      h("div", { class: "card" },
        h("div", { class: "card__head" }, h("div", { class: "card__title" }, "The server's Android key"), h("div", { class: "card__hint" }, "Signs every bundle, release and control message. Devices pin it when they enrol; compare the fingerprint with the one in the app (About).")),
        h("dl", { class: "kv" },
          h("dt", {}, "Key id"), h("dd", { class: "mono" }, o.signing.kid),
          h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, o.signing.fingerprint),
          h("dt", {}, "App version"), h("dd", {}, `${o.app.version} (${o.app.versionCode})`),
          h("dt", {}, "Bundles for apps from"), h("dd", {}, String(o.app.minAppCode)),
          h("dt", {}, "Design"), h("dd", {}, `${o.design.rev || "default"}${o.design.updatedAt ? ` · ${when(o.design.updatedAt)} · ${o.design.updatedBy}` : " (built-in)"}`),
          h("dt", {}, "Enrolment"), h("dd", {}, o.config.enrollment),
          h("dt", {}, "Storage"), h("dd", { class: "mono small" }, o.store.file))),
      getAppCard()));
  }

  /** Where the phones enrol: PUBLIC_BASE_URL when the server has one, else this console's origin. */
  const chatUrl = () => (overview && overview.publicUrl) || location.origin;

  function getAppCard() {
    const server = h("input", { class: "input", value: chatUrl(), placeholder: "https://chat.example.com", "data-read": "1" });
    const qr = h("div", { class: "and-qr" });
    const link = h("div", { class: "mono small muted" });
    const show = async () => {
      const res = await C.raw(`/api/admin/android/codes/qr?server=${encodeURIComponent(server.value.trim())}`);
      if (!res.ok) { toast("Enter the chat's address (https://…).", "err"); return; }
      const svg = await res.text();
      clear(qr).append(svgNode(svg));
      link.textContent = res.headers.get("X-M5-Link") || "";
    };
    return h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Getting the app"), h("div", { class: "card__hint" }, "Build it with npm run android:build (android/ in the repository), upload the APK in Releases. On the phone the app asks for the server — or scan this code with the camera.")),
      h("label", { class: "field" }, h("span", { class: "label" }, "The chat's address"), server),
      h("div", { class: "row" }, h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: show }, "Enrolment QR code"), overview.config.enrollment === "code" ? h("span", { class: "muted small" }, "Codes are required: make one in Security.") : null),
      qr, link);
  }

  /** An SVG from the server (the QR code), parsed — not injected as HTML. */
  function svgNode(text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (svg.nodeName.toLowerCase() !== "svg") return h("div", { class: "err" }, "Not an SVG.");
    for (const s of svg.querySelectorAll("script, foreignObject")) s.remove();
    svg.setAttribute("width", "220");
    svg.setAttribute("height", "220");
    return document.importNode(svg, true);
  }

  /* ============================================================ devices */

  async function devicesView(body) {
    const q = h("input", { class: "input input--sm", type: "search", placeholder: "Search name, model, id…", "data-read": "1" });
    const status = h("select", { class: "input input--sm", "data-read": "1" }, ...["", "active", "blocked", "retired", "wiped"].map((s) => h("option", { value: s }, s || "all")));
    const table = h("div", { class: "table-wrap" });
    const draw = async () => {
      const r = await guarded(() => api(`/api/admin/android/devices?q=${encodeURIComponent(q.value)}&status=${status.value}`));
      if (!r) return;
      clear(table);
      if (!r.devices.length) { table.append(h("div", { class: "empty" }, "No device has enrolled yet.")); return; }
      const tb = h("tbody");
      for (const d of r.devices) {
        const st = d.state || {};
        tb.append(h("tr", { style: "cursor:pointer", onclick: () => openDevice(d.id) },
          h("td", {}, h("strong", {}, d.name), h("div", { class: "muted small" }, `${d.manufacturer} ${d.model}`)),
          h("td", {}, badge(d.status, statusTone(d.status))),
          h("td", {}, `${d.appVersion}`, h("div", { class: "muted small" }, st.bundle ? `${st.bundle.version} · ${st.bundle.state}` : "built-in")),
          h("td", {}, d.os, h("div", { class: "muted small" }, `SDK ${d.sdk}`)),
          h("td", {}, ago(d.lastSeen), h("div", { class: "muted small" }, d.lastIp)),
          h("td", {}, st.battery >= 0 ? `${st.battery} %${st.charging ? " ⚡" : ""}` : "—", h("div", { class: "muted small" }, st.network || "")),
          h("td", {}, badge(d.push === "fcm" ? "FCM" : "poll", d.push === "fcm" ? "ok" : ""), st.locked ? badge("locked", "") : null),
          h("td", {}, String(st.rooms ?? 0))));
      }
      table.append(h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["Device", "Status", "App / bundle", "System", "Seen", "Battery", "Push", "Rooms"].map((x) => h("th", {}, x)))), tb));
    };
    q.addEventListener("input", () => { clearTimeout(q._t); q._t = setTimeout(draw, 300); });
    status.addEventListener("change", draw);
    body.append(h("div", { class: "card" }, h("div", { class: "toolbar row" }, q, status, h("span", { class: "spacer" }), h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: draw }, "Refresh")), table));
    await draw();
  }

  function commandForm(onSend, allowWipe) {
    const kind = h("select", { class: "input input--sm" }, ...["ping", "status", "flash", "push", "update", "lock", "config", ...(allowWipe ? ["wipe"] : [])].map((k) => h("option", { value: k }, k)));
    const text = h("input", { class: "input input--sm", placeholder: "Text" });
    const title = h("input", { class: "input input--sm", placeholder: "Title" });
    const level = h("select", { class: "input input--sm" }, ...["info", "success", "warn", "error"].map((k) => h("option", { value: k }, k)));
    const logs = h("input", { type: "checkbox" });
    const extra = h("div", { class: "row" });
    const hint = h("div", { class: "muted small" });
    const HINTS = {
      ping: "The device answers with its state (battery, network, bundle…).", status: "A detailed state; with logs, the last lines of its encrypted log (policy permitting).",
      flash: "A short notice in the app (or a heads-up notification when the app is closed).", push: "A notification with a title and text.",
      update: "Look for a new bundle and release now.", lock: "Lock the app at once (the data key is forgotten).", config: "Fetch the policy again.",
      wipe: "Erase every local datum of the device. It cannot be undone; the device reports the wipe.",
    };
    const drawExtra = () => {
      clear(extra);
      hint.textContent = HINTS[kind.value] || "";
      if (kind.value === "flash") extra.append(title, text, level);
      if (kind.value === "push") extra.append(title, text);
      if (kind.value === "status") extra.append(h("label", { class: "row small" }, logs, "with logs"));
      if (kind.value === "wipe") extra.append(text);
    };
    kind.addEventListener("change", drawExtra);
    drawExtra();
    const send = h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: async () => {
      const payload = kind.value === "flash" ? { text: text.value, title: title.value, level: level.value } : kind.value === "push" ? { title: title.value, body: text.value } : kind.value === "status" ? { logs: logs.checked } : kind.value === "wipe" ? { reason: text.value } : {};
      if (kind.value === "wipe" && !confirm("Erase all data on this device? This cannot be undone.")) return;
      await onSend(kind.value, payload);
    } }, "Send");
    return h("div", { class: "stack" }, h("div", { class: "row" }, kind, extra, send), hint);
  }

  async function openDevice(id) {
    const r = await guarded(() => api(`/api/admin/android/devices/${id}`));
    if (!r) return;
    const d = r.device;
    const backdrop = h("div", { class: "drawer-backdrop", onclick: () => close() });
    const close = () => { backdrop.remove(); drawer.remove(); };
    const st = d.state || {};
    const name = h("input", { class: "input input--sm", value: d.name });
    const notes = h("textarea", { class: "input", rows: "2" });
    notes.value = d.notes || "";
    const bodyEl = h("div", { class: "drawer__body" },
      h("dl", { class: "kv" },
        h("dt", {}, "Id"), h("dd", { class: "mono" }, d.id), h("dt", {}, "Key id"), h("dd", { class: "mono" }, d.kid),
        h("dt", {}, "Status"), h("dd", {}, badge(d.status, statusTone(d.status))),
        h("dt", {}, "Model"), h("dd", {}, `${d.manufacturer} ${d.model} · ${d.os} (SDK ${d.sdk})`),
        h("dt", {}, "App"), h("dd", {}, `${d.appVersion} (${d.appCode})`),
        h("dt", {}, "Bundle"), h("dd", {}, st.bundle ? `${st.bundle.version} · ${st.bundle.state}` : "built-in"),
        h("dt", {}, "Enrolled"), h("dd", {}, `${when(d.enrolledAt)} · ${d.enrolledWith}`),
        h("dt", {}, "Last seen"), h("dd", {}, `${when(d.lastSeen)} · ${d.lastIp}`),
        h("dt", {}, "Battery / network"), h("dd", {}, `${st.battery >= 0 ? `${st.battery} %` : "—"}${st.charging ? " charging" : ""} · ${st.network || "—"}`),
        h("dt", {}, "Lock"), h("dd", {}, `${st.lockMode || "—"} · ${st.locked ? "locked" : "open"} · failed attempts ${st.failedAttempts ?? 0}`),
        h("dt", {}, "Push"), h("dd", {}, `${d.push === "fcm" ? "FCM" : "polling"}`),
        h("dt", {}, "Storage"), h("dd", {}, size(st.storage)),
        h("dt", {}, "Permissions"), h("dd", {}, (st.permissions || []).join(", ") || "—")),
      h("h3", {}, "Control message"),
      may("push") && d.status === "active" ? commandForm(async (kind, payload) => {
        const res = await guarded(() => api(`/api/admin/android/devices/${d.id}/commands`, { method: "POST", body: { kind, payload } }));
        if (res) toast(`${kind}: ${res.via === "fcm" ? "sent over FCM" : "waits for the next check-in"}${res.error ? ` (${res.error})` : ""}`, res.error ? "err" : "ok");
        setTimeout(() => { close(); openDevice(id); }, 1200);
      }, may("wipe")) : h("div", { class: "muted small" }, d.status === "active" ? "Your access does not include control messages." : `The device is ${d.status}.`),
      h("h3", {}, "Commands"),
      commandsTable(r.commands),
      h("h3", {}, "Events"),
      eventsTable(r.events, false),
      may("devices") ? h("div", { class: "stack" },
        h("h3", {}, "Device"),
        h("label", { class: "field" }, h("span", { class: "label" }, "Name"), name),
        h("label", { class: "field" }, h("span", { class: "label" }, "Notes"), notes),
        h("div", { class: "row" },
          h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/devices/${d.id}`, { method: "PATCH", body: { name: name.value, notes: notes.value } }), "Saved.")) load(); } }, "Save"),
          d.status === "active" ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/devices/${d.id}`, { method: "PATCH", body: { status: "blocked" } }), "Blocked.")) { close(); load(); } } }, "Block") : null,
          d.status === "blocked" || d.status === "retired" ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/devices/${d.id}`, { method: "PATCH", body: { status: "active" } }), "Active again.")) { close(); load(); } } }, "Unblock") : null,
          d.status !== "retired" && d.status !== "wiped" ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/devices/${d.id}`, { method: "PATCH", body: { status: "retired" } }), "Retired.")) { close(); load(); } } }, "Retire") : null,
          h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (!confirm(`Delete ${d.name} from the server? It would have to enrol again.`)) return; if (await guarded(() => api(`/api/admin/android/devices/${d.id}`, { method: "DELETE" }), "Deleted.")) { close(); load(); } } }, "Delete"))) : null);
    const drawer = h("aside", { class: "drawer", role: "dialog", "aria-label": d.name },
      h("div", { class: "drawer__head" }, h("div", { class: "drawer__title" }, d.name), h("span", { class: "spacer" }), h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: () => close() }, "Close")), bodyEl);
    document.body.append(backdrop, drawer);
    C.applyRoleGates();
  }

  function commandsTable(list) {
    if (!list.length) return h("div", { class: "muted small" }, "None yet.");
    return h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, ...["When", "Kind", "Status", "Via", "Result"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...list.map((c) => h("tr", {},
        h("td", {}, when(c.createdAt), h("div", { class: "muted small" }, c.createdBy)),
        h("td", {}, c.kind), h("td", {}, badge(c.status, statusTone(c.status))), h("td", {}, c.via || "—"),
        h("td", { class: "mono small" }, c.error ? c.error : c.result ? JSON.stringify(c.result).slice(0, 300) : "—"))))));
  }

  function eventsTable(list, withDevice) {
    if (!list.length) return h("div", { class: "muted small" }, "None.");
    return h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, ...["When", ...(withDevice ? ["Device"] : []), "Type", "Level", "Detail"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...list.map((e) => h("tr", {},
        h("td", {}, when(e.at), e.receivedAt - e.at > 120_000 ? h("div", { class: "muted small" }, `received ${when(e.receivedAt)}`) : null),
        ...(withDevice ? [h("td", { class: "mono small" }, e.deviceId)] : []),
        h("td", {}, e.type), h("td", {}, badge(e.level, levelTone(e.level))),
        h("td", { class: "mono small" }, JSON.stringify(e.detail).slice(0, 400)))))));
  }

  /* =============================================================== push */

  async function pushView(body) {
    const cfg = overview.config;
    body.append(h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "A control message to every active device"), h("div", { class: "card__hint" }, "Encrypted for each device and signed by the server. Over FCM when it is set up (flash, push, lock at high priority, the rest at normal — Doze delivers it with other work), otherwise at the next check-in.")),
      may("push") ? commandForm(async (kind, payload) => {
        const r = await guarded(() => api("/api/admin/android/commands", { method: "POST", body: { kind, payload } }));
        if (r) toast(`${r.results.length} devices: ${r.results.filter((x) => x.via === "fcm").length} over FCM, the rest at check-in.`, "ok");
      }, false) : h("div", { class: "muted small" }, "Your access does not include control messages.")));

    const enabled = h("input", { type: "checkbox" });
    enabled.checked = cfg.fcm.enabled;
    const gs = h("textarea", { class: "input mono", rows: "5", placeholder: "Paste google-services.json (the Android app of your Firebase project) — or fill the fields below" });
    const f = {
      apiKey: h("input", { class: "input input--sm mono", value: cfg.fcm.client?.apiKey || "", placeholder: "AIza…" }),
      appId: h("input", { class: "input input--sm mono", value: cfg.fcm.client?.appId || "", placeholder: "1:123456789:android:abc…" }),
      senderId: h("input", { class: "input input--sm mono", value: cfg.fcm.client?.senderId || "", placeholder: "123456789" }),
      projectId: h("input", { class: "input input--sm mono", value: cfg.fcm.client?.projectId || "", placeholder: "my-project" }),
    };
    gs.addEventListener("input", () => {
      try {
        const g = JSON.parse(gs.value);
        const client = (g.client || []).find((c) => c.client_info?.android_client_info?.package_name === overview.config.packageName) || (g.client || [])[0];
        f.apiKey.value = client?.api_key?.[0]?.current_key || f.apiKey.value;
        f.appId.value = client?.client_info?.mobilesdk_app_id || f.appId.value;
        f.senderId.value = g.project_info?.project_number || f.senderId.value;
        f.projectId.value = g.project_info?.project_id || f.projectId.value;
      } catch { /* still typing */ }
    });
    const sa = h("textarea", { class: "input mono", rows: "4", placeholder: cfg.fcm.hasServiceAccount ? `A service account is stored (${cfg.fcm.serviceAccountEmail}). Paste a new one to replace it.` : "Paste the service account key (JSON) — Firebase › Project settings › Service accounts › Generate new private key" });
    const test = h("select", { class: "input input--sm" });
    const devs = await guarded(() => api("/api/admin/android/devices?status=active"));
    for (const d of devs?.devices || []) test.append(h("option", { value: d.id }, `${d.name} (${d.push})`));
    body.append(h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Firebase Cloud Messaging"), h("div", { class: "card__hint" }, `Status: ${overview.fcm.ready ? "ready" : overview.fcm.reason}. The APK carries no Firebase file: devices get these app settings from the server. The service account is sealed with the storage master key and never shown again.`)),
      h("label", { class: "row" }, enabled, "Send control messages over FCM"),
      gs,
      h("div", { class: "grid grid--2" }, ...Object.entries(f).map(([k, input]) => h("label", { class: "field" }, h("span", { class: "label" }, k), input))),
      h("label", { class: "field" }, h("span", { class: "label" }, "Service account"), sa),
      h("div", { class: "row" },
        may("settings") ? h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: async () => {
          const fcm = { enabled: enabled.checked, client: f.appId.value.trim() ? { apiKey: f.apiKey.value.trim(), appId: f.appId.value.trim(), senderId: f.senderId.value.trim(), projectId: f.projectId.value.trim() } : null };
          if (sa.value.trim()) fcm.serviceAccount = sa.value.trim();
          const r = await guarded(() => api("/api/admin/android/config", { method: "PUT", body: { fcm } }), "FCM settings saved.");
          if (r) { overview = await api("/api/admin/android"); render(); }
        } }, "Save") : null,
        cfg.fcm.hasServiceAccount && may("settings") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (await guarded(() => api("/api/admin/android/config", { method: "PUT", body: { fcm: { serviceAccount: "" } } }), "Service account removed.")) { overview = await api("/api/admin/android"); render(); } } }, "Remove the service account") : null,
        h("span", { class: "spacer" }), test,
        h("button", { class: "btn btn--sm", type: "button", onclick: async () => {
          if (!test.value) return;
          const r = await guarded(() => api(`/api/admin/android/devices/${test.value}/commands`, { method: "POST", body: { kind: "ping" } }));
          if (r) toast(r.via === "fcm" ? "Ping sent over FCM — watch the device's commands." : `Not over FCM: ${r.error || "the device has no FCM token yet"}.`, r.via === "fcm" ? "ok" : "err");
        } }, "Test ping"))));
  }

  /* ============================================================= builds */

  async function buildsView(body) {
    const r = await guarded(() => api("/api/admin/android/builds"));
    if (!r) return;
    const notes = h("input", { class: "input input--sm", placeholder: "What changed" });
    const channel = h("select", { class: "input input--sm" }, ...["stable", "beta", "dev"].map((c) => h("option", { value: c }, c)));
    body.append(h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "New build"), h("div", { class: "card__hint" }, "Freezes the current design (Design tab): compiled, compressed, encrypted with AES-256-GCM, signed. Published builds reach devices at their next check-in (and at once with FCM); a device installs one only after checking the signature, and falls back to the last good one when it fails.")),
      may("builds") ? h("div", { class: "row" }, notes, channel, h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: async () => {
        const res = await guarded(() => api("/api/admin/android/builds", { method: "POST", body: { notes: notes.value, channel: channel.value } }), "Built.");
        if (res) render();
      } }, "Build now")) : h("div", { class: "muted small" }, "Your access does not include builds.")));
    const devices = (await guarded(() => api("/api/admin/android/devices?status=active")))?.devices || [];
    const table = h("tbody");
    for (const b of r.builds) {
      const pick = h("select", { class: "input input--sm" }, h("option", { value: "all" }, `all active (${devices.length})`), ...devices.map((d) => h("option", { value: d.id }, d.name)));
      table.append(h("tr", {},
        h("td", {}, h("strong", {}, `#${b.number}`), h("div", { class: "muted small" }, b.version)),
        h("td", {}, badge(b.status, statusTone(b.status)), " ", badge(b.channel, "")),
        h("td", {}, when(b.createdAt), h("div", { class: "muted small" }, b.createdBy)),
        h("td", {}, size(b.fileSize), h("div", { class: "muted small" }, `${b.summary.screens.length} screens · ${b.summary.languages.join("/")}`)),
        h("td", { class: "small" }, b.notes || "—"),
        h("td", {}, h("div", { class: "row" },
          b.status !== "published" && may("publish") ? h("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => { const x = await guarded(() => api(`/api/admin/android/builds/${b.id}/publish`, { method: "POST", body: { notify: true } })); if (x) { toast(`Published; ${x.notified} devices told.`, "ok"); render(); } } }, "Publish") : null,
          b.status === "published" && may("publish") ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/builds/${b.id}/withdraw`, { method: "POST", body: {} }), "Withdrawn.")) render(); } }, "Withdraw") : null,
          h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: () => inspectBuild(b) }, "Inspect"),
          may("builds") ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (!confirm("Replace the current design with this build's?")) return; const x = await guarded(() => api(`/api/admin/android/builds/${b.id}/restore`, { method: "POST", body: {} }), "Design restored."); if (x) { design = null; } } }, "Restore design") : null,
          h("span", { class: "row" }, pick, h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: () => download(`/api/admin/android/builds/${b.id}/deploy?devices=${encodeURIComponent(pick.value)}`, `m5cet-${b.version}.m5ab`) }, "Deploy file")),
          may("builds") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (!confirm(`Delete build #${b.number}?`)) return; if (await guarded(() => api(`/api/admin/android/builds/${b.id}`, { method: "DELETE" }), "Deleted.")) render(); } }, "Delete") : null))));
    }
    body.append(h("div", { class: "card" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Builds")),
      r.builds.length ? h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["Build", "Status", "Created", "Size", "Notes", ""].map((x) => h("th", {}, x)))), table)) : h("div", { class: "empty" }, "No build yet — the devices use the built-in design.")));
  }

  async function download(path, filename) {
    const res = await C.raw(path);
    if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).message || m; } catch { /* binary */ } toast(m, "err"); return; }
    const blob = await res.blob();
    const a = h("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function inspectBuild(b) {
    const r = await guarded(() => api(`/api/admin/android/builds/${b.id}/content`));
    if (!r) return;
    const files = Object.entries(r.manifest.files).map(([path, f]) => h("tr", {}, h("td", { class: "mono small" }, path), h("td", {}, size(f.size)), h("td", { class: "mono small" }, f.sha256.slice(0, 16) + "…")));
    Kit.openDialog({ title: `Build #${b.number} · ${b.version}`, subtitle: "decrypted on the server to look inside", wide: true, body: h("div", { class: "stack" },
      h("dl", { class: "kv" }, h("dt", {}, "Id"), h("dd", { class: "mono" }, b.id), h("dt", {}, "Content SHA-256"), h("dd", { class: "mono small" }, b.sha256), h("dt", {}, "Signed by"), h("dd", { class: "mono" }, b.header.kid), h("dt", {}, "Design"), h("dd", { class: "mono" }, r.manifest.designRev), h("dt", {}, "For apps from"), h("dd", {}, String(b.minAppCode))),
      h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "File"), h("th", {}, "Size"), h("th", {}, "SHA-256"))), h("tbody", {}, ...files)))) });
  }

  /* =========================================================== releases */

  async function releasesView(body) {
    const r = await guarded(() => api("/api/admin/android/releases"));
    if (!r) return;
    const file = h("input", { type: "file", accept: ".apk,application/vnd.android.package-archive" });
    const channel = h("select", { class: "input input--sm" }, ...["stable", "beta", "dev"].map((c) => h("option", { value: c }, c)));
    const notes = h("input", { class: "input input--sm", placeholder: "Release notes" });
    const mandatory = h("input", { type: "checkbox" });
    const progress = h("span", { class: "muted small" });
    body.append(h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Upload an APK"), h("div", { class: "card__hint" }, `Package ${overview.config.packageName}. The server reads the version and the signing certificate from the APK; after the first release only APKs signed with the same certificate are accepted (devices check it too). Signed releases are offered to devices with an older version.`)),
      may("releases") ? h("div", { class: "row" }, file, channel, notes, h("label", { class: "row small" }, mandatory, "mandatory"),
        h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: async () => {
          const f = file.files && file.files[0];
          if (!f) { toast("Choose the APK first.", "err"); return; }
          progress.textContent = `Uploading ${size(f.size)}…`;
          const res = await C.raw(`/api/admin/android/releases/upload?channel=${channel.value}&notes=${encodeURIComponent(notes.value)}&mandatory=${mandatory.checked ? 1 : 0}`, { method: "POST", headers: { "Content-Type": "application/vnd.android.package-archive" }, body: f });
          const j = await res.json().catch(() => ({}));
          progress.textContent = "";
          if (!res.ok) { toast(j.message || `HTTP ${res.status}`, "err"); return; }
          toast(`${j.release.versionName} (${j.release.versionCode}) uploaded as a draft.`, "ok");
          render();
        } }, "Upload"), progress) : h("div", { class: "muted small" }, "Your access does not include releases."),
      h("div", { class: "muted small" }, "Build: ", h("code", {}, "npm run android:build -- --release"), " (with M5_KEYSTORE…, see docs/android-architecture.md), then upload app-release.apk.")));
    const tb = h("tbody");
    for (const x of r.releases) {
      tb.append(h("tr", {},
        h("td", {}, h("strong", {}, x.versionName), h("div", { class: "muted small" }, String(x.versionCode))),
        h("td", {}, badge(x.status, statusTone(x.status)), " ", badge(x.channel, ""), x.mandatory ? badge("mandatory", "warn") : null),
        h("td", {}, size(x.size), h("div", { class: "muted small" }, `min SDK ${x.minSdk}`)),
        h("td", { class: "mono small" }, x.certSha256.slice(0, 16) + "…", h("div", {}, x.apkSha256.slice(0, 16) + "…")),
        h("td", {}, when(x.createdAt), h("div", { class: "muted small" }, x.createdBy)),
        h("td", { class: "small" }, x.notes || "—"),
        h("td", {}, h("div", { class: "row" },
          x.status !== "published" && may("publish") ? h("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => { const y = await guarded(() => api(`/api/admin/android/releases/${x.id}/publish`, { method: "POST", body: { notify: true } })); if (y) { toast(`Published; ${y.notified} devices told.`, "ok"); render(); } } }, "Publish") : null,
          x.status === "published" && may("publish") ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/releases/${x.id}/withdraw`, { method: "POST", body: {} }), "Withdrawn.")) render(); } }, "Withdraw") : null,
          h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: () => download(`/api/admin/android/releases/${x.id}/apk`, `m5cet-${x.versionName}.apk`) }, "APK"),
          may("releases") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (!confirm(`Delete ${x.versionName}?`)) return; if (await guarded(() => api(`/api/admin/android/releases/${x.id}`, { method: "DELETE" }), "Deleted.")) render(); } }, "Delete") : null))));
    }
    body.append(h("div", { class: "card" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Releases")),
      r.releases.length ? h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["Version", "Status", "Size", "Certificate / APK", "Uploaded", "Notes", ""].map((t) => h("th", {}, t)))), tb)) : h("div", { class: "empty" }, "No release uploaded yet.")));
  }

  /* =========================================================== security */

  async function securityView(body) {
    const p = structuredClone(overview.config.policy);
    const cfg = overview.config;
    const num = (obj, key, min, max) => { const i = h("input", { class: "input input--sm", type: "number", min: String(min), max: String(max), value: String(obj[key]) }); i.addEventListener("input", () => { obj[key] = Number(i.value); }); return i; };
    const chk = (obj, key) => { const i = h("input", { type: "checkbox" }); i.checked = Boolean(obj[key]); i.addEventListener("change", () => { obj[key] = i.checked; }); return i; };
    const sel = (obj, key, options) => { const s = h("select", { class: "input input--sm" }, ...options.map((o) => h("option", { value: o }, o))); s.value = obj[key]; s.addEventListener("change", () => { obj[key] = s.value; }); return s; };
    const f = (label, control, hint) => h("label", { class: "field" }, h("span", { class: "label" }, label), control, hint ? h("span", { class: "muted small" }, hint) : null);
    const enrollment = h("select", { class: "input input--sm" }, ...["open", "code", "closed"].map((o) => h("option", { value: o }, o)));
    enrollment.value = cfg.enrollment;
    const pkg = h("input", { class: "input input--sm mono", value: cfg.packageName });
    body.append(h("div", { class: "grid grid--2" },
      h("div", { class: "card stack" },
        h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Opening the app"), h("div", { class: "card__hint" }, "Every failed unlock (a wrong PIN or a rejected finger) counts. After the last allowed one the device erases all its data and reports it (or locks for an hour when erasing is off).")),
        f("Biometrics", sel(p.lock, "biometric", ["optional", "required", "off"]), "required: biometrics to open, the PIN stays the fallback"),
        f("PIN length", num(p.lock, "pinLength", 4, 12)),
        f("Failed attempts allowed", num(p.lock, "maxAttempts", 3, 20)),
        h("label", { class: "row" }, chk(p.lock, "wipe"), "Erase all data after the last attempt"),
        h("label", { class: "row" }, chk(p.lock, "backoff"), "A growing wait from the third failure (30 s, 1 min, 2 min … 1 h)"),
        f("Lock again after (s in the background)", num(p.lock, "autolockSeconds", 0, 86400)),
        h("label", { class: "row" }, chk(p.lock, "screenshots"), "Allow screenshots and the recents preview")),
      h("div", { class: "card stack" },
        h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Updates, polling, rooms")),
        f("Channel", sel(p.update, "channel", ["stable", "beta", "dev"])),
        f("Check every (hours)", num(p.update, "checkHours", 1, 168)),
        h("label", { class: "row" }, chk(p.update, "autoDownload"), "Download bundles by themselves"),
        h("label", { class: "row" }, chk(p.update, "wifiOnly"), "Only on Wi-Fi (unmetered)"),
        f("Check-in without FCM (minutes, at least 15)", num(p, "pollMinutes", 15, 1440)),
        f("Rooms connected at once", num(p.rooms, "max", 1, 16)),
        f("Logs to the server", sel(p, "logs", ["errors", "all", "off"]), "only when a status request asks for them"),
        f("Enrolment", enrollment, "open: anyone with the address · code: an enrolment code · closed: nobody new"),
        f("Package name", pkg, "every release must be this application id"))));
    if (may("settings")) body.append(h("div", { class: "row" }, h("button", { class: "btn btn--primary", type: "button", onclick: async () => {
      const r = await guarded(() => api("/api/admin/android/config", { method: "PUT", body: { policy: p, enrollment: enrollment.value, packageName: pkg.value.trim() } }), "Policy saved — devices get it at their next check-in.");
      if (r) overview = await api("/api/admin/android");
    } }, "Save the policy"), h("button", { class: "btn", type: "button", onclick: async () => {
      if (may("push")) { const r = await guarded(() => api("/api/admin/android/commands", { method: "POST", body: { kind: "config" } })); if (r) toast(`${r.results.length} devices asked to fetch it now.`, "ok"); }
    } }, "Tell the devices now")));
    await codesCard(body);
  }

  async function codesCard(body) {
    const r = await guarded(() => api("/api/admin/android/codes"));
    if (!r) return;
    const label = h("input", { class: "input input--sm", placeholder: "For whom" });
    const uses = h("input", { class: "input input--sm", type: "number", min: "1", value: "1", style: "width:80px" });
    const days = h("input", { class: "input input--sm", type: "number", min: "1", value: "7", style: "width:80px" });
    const shown = h("div", { class: "stack" });
    const tb = h("tbody", {}, ...r.codes.map((c) => h("tr", {},
      h("td", {}, c.label || "—"), h("td", {}, `${c.used} used · ${c.usesLeft} left`), h("td", {}, when(c.expiresAt)), h("td", {}, c.createdBy),
      h("td", {}, may("settings") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (await guarded(() => api(`/api/admin/android/codes/${c.id}`, { method: "DELETE" }), "Removed.")) render(); } }, "Remove") : null))));
    body.append(h("div", { class: "card stack" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Enrolment codes"), h("div", { class: "card__hint" }, "With enrolment set to code, a device needs one. The code is shown once — with a QR code the phone's camera opens directly in the app.")),
      may("settings") ? h("div", { class: "row" }, label, h("span", { class: "muted small" }, "uses"), uses, h("span", { class: "muted small" }, "days"), days, h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: async () => {
        const res = await guarded(() => api("/api/admin/android/codes", { method: "POST", body: { label: label.value, uses: Number(uses.value), days: Number(days.value) } }));
        if (!res) return;
        const q = await C.raw(`/api/admin/android/codes/qr?server=${encodeURIComponent(chatUrl())}&code=${encodeURIComponent(res.code)}`);
        clear(shown).append(h("div", { class: "card" }, h("div", { class: "row" }, h("strong", { class: "mono", style: "font-size:20px" }, res.code), h("span", { class: "muted small" }, "shown only now")), q.ok ? svgNode(await q.text()) : null, h("div", { class: "mono small muted" }, q.headers.get("X-M5-Link") || "")));
      } }, "New code")) : null,
      shown,
      r.codes.length ? h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["For", "Uses", "Expires", "Made by", ""].map((x) => h("th", {}, x)))), tb)) : h("div", { class: "muted small" }, "No codes.")));
  }

  /* ============================================================= events */

  async function eventsView(body) {
    const type = h("select", { class: "input input--sm", "data-read": "1" }, h("option", { value: "" }, "all types"), ...["unlock-failed", "lockout", "wipe", "remote-wipe", "integrity", "key-invalidated", "unlock", "bundle-installed", "bundle-failed", "bundle-rollback", "update-available", "update-installed", "update-failed", "crash"].map((t) => h("option", { value: t }, t)));
    const level = h("select", { class: "input input--sm", "data-read": "1" }, ...["", "error", "warn", "notice", "info"].map((l) => h("option", { value: l }, l || "all levels")));
    const box = h("div");
    const draw = async () => { const r = await guarded(() => api(`/api/admin/android/events?type=${type.value}&level=${level.value}&limit=500`)); if (r) clear(box).append(eventsTable(r.events, true)); };
    type.addEventListener("change", draw);
    level.addEventListener("change", draw);
    body.append(h("div", { class: "card stack" }, h("div", { class: "row" }, type, level, h("span", { class: "spacer" }), h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: draw }, "Refresh")), box));
    await draw();
  }

  /* ============================================================= design */

  async function designView(body) {
    if (!design) {
      const r = await guarded(() => api("/api/admin/android/design"));
      if (!r) return;
      design = r.design;
      designSaved = JSON.stringify(design);
    }
    const dirty = () => JSON.stringify(design) !== designSaved;
    const status = h("span", { class: "muted small" }, dirty() ? "unsaved changes" : `saved · ${design.rev}`);
    const markDirty = () => { status.textContent = dirty() ? "unsaved changes" : `saved · ${design.rev}`; };
    const top = h("div", { class: "row" },
      ...["screens", "theme", "animations", "texts", "menus", "libraries", "assets"].map((id) => h("button", { class: `btn btn--sm${designTab === id ? " btn--primary" : ""}`, type: "button", "data-read": "1", onclick: () => { designTab = id; render(); } }, id[0].toUpperCase() + id.slice(1))),
      h("span", { class: "spacer" }), status,
      may("builds") ? h("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => {
        try {
          const r = await api("/api/admin/android/design", { method: "PUT", body: { design } });
          design = r.design;
          designSaved = JSON.stringify(design);
          toast("Design saved. Build it (Builds) to send it to the devices.", "ok");
          render();
        } catch (err) { toast(err.message, "err"); }
      } }, "Save") : null,
      may("builds") ? h("button", { class: "btn btn--sm", type: "button", onclick: () => { design = JSON.parse(designSaved); render(); } }, "Revert") : null,
      may("builds") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (!confirm("Replace the design with the built-in default?")) return; const r = await guarded(() => api("/api/admin/android/design/reset", { method: "POST", body: {} }), "Reset to the default."); if (r) { design = r.design; designSaved = JSON.stringify(design); render(); } } }, "Reset") : null);
    body.append(top);
    const views = { screens: screensEditor, theme: themeEditor, animations: animationsEditor, texts: textsEditor, menus: menusEditor, libraries: librariesEditor, assets: assetsEditor };
    (views[designTab] || screensEditor)(body, markDirty);
  }

  /* ------------------------------------------------------- the preview */

  const t = (key) => { const table = design.strings[previewLang] || {}; return table[key] ?? (design.strings.en || {})[key] ?? key; };

  function colorOf(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const v = String(value);
    if (v.startsWith("@")) return (design.theme[previewDark ? "dark" : "light"] || {})[v.slice(1)] || fallback;
    // #aarrggbb (Android) → rgba
    if (/^#[0-9a-fA-F]{8}$/.test(v)) { const a = parseInt(v.slice(1, 3), 16) / 255; return `rgba(${parseInt(v.slice(3, 5), 16)},${parseInt(v.slice(5, 7), 16)},${parseInt(v.slice(7, 9), 16)},${a.toFixed(2)})`; }
    return v;
  }

  const box4 = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const p = String(v).trim().split(/\s+/).map(Number);
    const [a, b = a, c = a, d = b] = p;
    return `${a}px ${b}px ${c}px ${d}px`;
  };

  function iconEl(name, px, color) {
    const svg = Kit.iconSvg(catalog.icons, name || "circle", "and-ico");
    svg.setAttribute("width", String(px));
    svg.setAttribute("height", String(px));
    svg.style.color = color;
    svg.style.flex = "none";
    return svg;
  }

  function sampleFor(id) {
    const s = catalog.screens.find((x) => x.id === id);
    return s ? structuredClone(s.sample) : {};
  }

  /** Renders a tree as HTML, as close to the app's native renderer as CSS allows. */
  function preview(node, scope, parent, fgIn, onPick) {
    const val = (v) => X.value(v, scope, t);
    if (node.each) {
      const list = X.eval(node.each, scope, t);
      const frag = document.createDocumentFragment();
      const { each, ...rest } = node;
      (Array.isArray(list) ? list.slice(0, 50) : []).forEach((item, i, arr) => frag.append(preview(rest, { ...scope, [node.as || "item"]: item, index: i, first: i === 0, last: i === arr.length - 1 }, parent, fgIn, onPick)));
      return frag;
    }
    if (node.if) { try { if (!X.truthy(X.eval(node.if, scope, t))) return document.createComment(node.id); } catch { /* shown */ } }
    const st = node.style || {};
    const pr = node.props || {};
    const sv = (k) => { const v = st[k]; return typeof v === "string" && v.startsWith("=") ? X.toText(X.eval(v.slice(1), scope, t)) : v; };
    let fg = sv("fg") !== undefined ? colorOf(sv("fg"), fgIn) : fgIn;
    const el = h("div", { class: `and-n and-${node.el}`, "data-id": node.id });
    const css = el.style;
    const inRow = parent === "row";
    // layout
    if (["column", "row", "card", "scroll"].includes(node.el)) {
      css.display = "flex";
      css.flexDirection = node.el === "row" ? "row" : "column";
      if (node.el === "row" && pr.wrap) css.flexWrap = "wrap";
      const align = st.align || (node.el === "row" ? "center" : "stretch");
      css.alignItems = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch" }[align] || "stretch";
      css.justifyContent = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around" }[st.justify || "start"];
      if (st.gap) css.gap = `${st.gap}px`;
      if (node.el === "scroll") css.overflow = "auto";
    }
    if (node.el === "stack") { css.display = "grid"; }
    if (parent === "stack") { css.gridArea = "1 / 1"; }
    if (box4(st.padding)) css.padding = box4(st.padding);
    if (box4(st.margin)) css.margin = box4(st.margin);
    const dim = (v) => (v === "match" ? "100%" : v === "wrap" ? "auto" : typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v)) ? `${v}px` : null);
    if (st.width !== undefined && dim(st.width)) css.width = dim(st.width);
    if (st.height !== undefined && dim(st.height)) css.height = st.height === "match" ? "100%" : dim(st.height);
    // Like LinearLayout: a row shares its width by weight; a column whose own
    // height comes from its content (a panel) gives a weighted child its content.
    if (st.weight) { css.flex = inRow ? `${st.weight} 1 0` : `${st.weight} 1 auto`; if (inRow) css.minWidth = "0"; else css.minHeight = "0"; }
    if (st.self) css.alignSelf = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch" }[st.self];
    if (st.maxWidth) css.maxWidth = `${st.maxWidth}px`;
    if (sv("opacity") !== undefined) css.opacity = String(sv("opacity"));
    let bg = sv("bg") !== undefined ? colorOf(sv("bg"), "transparent") : null;
    let radius = st.radius !== undefined ? st.radius : null;
    if (node.el === "card") { bg = bg || colorOf("@surface", "#fff"); radius = radius ?? (design.theme.radius + 4); css.boxShadow = "0 2px 8px rgba(0,0,0,.14)"; }
    if (st.elevation) css.boxShadow = `0 ${Math.min(12, st.elevation)}px ${st.elevation * 2.5}px rgba(0,0,0,.18)`;
    if (st.border) { const [w, c] = String(sv("border")).split(/\s+/); css.border = `${w}px solid ${colorOf(c || "@border", "#ccc")}`; }
    const text = (s) => X.render(s || "", scope, t);
    const typo = (variant) => {
      const sizes = { display: [30, 700], headline: [23, 700], title: [19, 700], label: [14, 600], caption: [12, 400], badge: [11, 700], mono: [13, 400], body: [15.5, 400] };
      const [fs, fw] = sizes[variant] || sizes.body;
      css.fontSize = `${st.size || fs}px`;
      css.fontWeight = st.bold === true ? "700" : st.bold === false ? "400" : String(fw);
      if (st.italic) css.fontStyle = "italic";
      if (variant === "mono" || design.theme.font === "mono") css.fontFamily = "ui-monospace, monospace";
      else if (design.theme.font === "serif") css.fontFamily = "Georgia, serif";
      if (st.lines) { css.display = "-webkit-box"; css.webkitLineClamp = String(st.lines); css.webkitBoxOrient = "vertical"; css.overflow = "hidden"; }
      if (pr.align) css.textAlign = pr.align === "end" ? "right" : pr.align;
    };
    switch (node.el) {
      case "text": typo(pr.variant || "body"); el.textContent = text(node.text); css.whiteSpace = "pre-wrap"; break;
      case "badge": case "chip": {
        typo(node.el === "badge" ? "badge" : "label");
        const c = val(pr.color);
        const sel = node.el === "chip" && X.truthy(val(pr.selected));
        if (node.el === "badge") { bg = bg || colorOf(c || "@primary", "#e11d48"); fg = sv("fg") !== undefined ? fg : "#fff"; }
        else { css.border = `1px solid ${colorOf(sel ? "@primary" : "@border", "#ccc")}`; if (sel) { bg = bg || "color-mix(in srgb, " + colorOf("@primary", "#e11d48") + " 16%, transparent)"; fg = colorOf("@primary", fg); } }
        radius = radius ?? 999;
        css.display = "inline-flex"; css.alignItems = "center"; css.gap = "3px";
        if (!st.padding) css.padding = node.el === "chip" ? "6px 12px" : "2px 7px";
        if (pr.icon) el.append(iconEl(X.toText(val(pr.icon)), node.el === "badge" ? 12 : 16, fg));
        el.append(document.createTextNode(text(node.text)));
        break;
      }
      case "button": {
        typo("label");
        const variant = X.toText(val(pr.variant)) || "primary";
        const colors = { primary: [colorOf("@primary", "#e11d48"), colorOf("@onPrimary", "#fff")], danger: [colorOf("@danger", "#dc2626"), "#fff"], tonal: ["color-mix(in srgb, " + colorOf("@primary", "#e11d48") + " 14%, transparent)", colorOf("@primary", "#e11d48")], secondary: ["transparent", fg], text: ["transparent", colorOf("@primary", "#e11d48")] }[variant] || ["transparent", fg];
        bg = bg || colors[0];
        if (sv("fg") === undefined) fg = colors[1];
        if (variant === "secondary") css.border = `1px solid ${colorOf("@border", "#ccc")}`;
        radius = radius ?? 999;
        css.display = "flex"; css.alignItems = "center"; css.justifyContent = "center"; css.gap = "8px"; css.minHeight = "44px";
        if (!st.padding) css.padding = "11px 20px";
        if (pr.icon) el.append(iconEl(X.toText(val(pr.icon)), 18, fg));
        el.append(document.createTextNode(text(node.text)));
        if (X.truthy(val(pr.disabled))) css.opacity = "0.5";
        break;
      }
      case "iconButton": {
        const variant = X.toText(val(pr.variant));
        css.width = "44px"; css.height = "44px"; css.display = "grid"; css.placeItems = "center"; css.position = "relative"; css.flex = "none";
        if (variant === "primary") { bg = colorOf("@primary", "#e11d48"); radius = 22; }
        el.append(iconEl(X.toText(val(pr.icon)) || "circle", 22, variant === "primary" ? colorOf("@onPrimary", "#fff") : fg));
        const n = Number(val(pr.badge) || 0);
        if (n > 0) el.append(h("span", { class: "and-dot", style: `background:${colorOf("@primary", "#e11d48")}` }, n > 99 ? "99+" : String(n)));
        el.title = text(pr.label || "");
        break;
      }
      case "icon": { const px = Number(val(pr.size)) || 20; el.append(iconEl(X.toText(val(pr.icon)) || "circle", px, pr.color ? colorOf(X.toText(val(pr.color)), fg) : fg)); css.display = "inline-flex"; css.flex = "none"; break; }
      case "avatar": {
        const name = text(pr.name || "");
        const px = Number(val(pr.size)) || 36;
        Object.assign(css, { width: `${px}px`, height: `${px}px`, borderRadius: "50%", display: "grid", placeItems: "center", color: "#fff", fontWeight: "700", fontSize: `${px * 0.4}px`, flex: "none" });
        bg = nameColor(name);
        el.textContent = initials(name);
        break;
      }
      case "image": {
        const src = X.toText(val(pr.src));
        const img = h("img", { alt: "", style: "width:100%;display:block;object-fit:" + ({ contain: "contain", center: "none" }[pr.fit] || "cover") });
        if (src.startsWith("asset:") && design.assets[src.slice(6)]) img.src = `data:${design.assets[src.slice(6)].mime};base64,${design.assets[src.slice(6)].data}`;
        else if (src.startsWith("https://")) img.src = src;
        if (pr.ratio) img.style.aspectRatio = String(pr.ratio);
        el.append(img);
        break;
      }
      case "divider": css.alignSelf = "stretch"; if (inRow) { css.width = "1px"; } else { css.height = "1px"; } bg = colorOf(st.bg || "@border", "#ddd"); break;
      case "spacer": if (pr.size) { css.width = inRow ? `${pr.size}px` : "auto"; css.height = inRow ? "auto" : `${pr.size}px`; } else css.flex = "1 1 0"; break;
      case "progress": {
        const v = pr.value !== undefined ? Number(val(pr.value)) : null;
        el.append(v === null ? h("div", { class: "and-spin", style: `border-color:${colorOf("@primary", "#e11d48")} transparent transparent transparent` }) : h("div", { class: "and-bar" }, h("div", { style: `width:${Math.round(v * 100)}%;background:${colorOf("@primary", "#e11d48")}` })));
        break;
      }
      case "input": {
        const inp = h("div", { class: "and-input" }, text(pr.hint || ""));
        inp.style.background = colorOf("@surfaceVariant", "#eee");
        inp.style.color = colorOf("@muted", "#888");
        el.append(inp);
        break;
      }
      case "switch": case "checkbox": {
        const on = X.truthy(val(pr.checked));
        const mark = node.el === "switch" ? h("span", { class: `and-switch${on ? " on" : ""}`, style: on ? `background:${colorOf("@primary", "#e11d48")}` : "" }) : h("span", { class: "and-check", style: `border-color:${colorOf("@primary", "#e11d48")};background:${on ? colorOf("@primary", "#e11d48") : "transparent"}` }, on ? "✓" : "");
        css.display = "flex"; css.alignItems = "center"; css.gap = "8px";
        el.append(mark);
        if (node.text) el.append(document.createTextNode(text(node.text)));
        break;
      }
      case "slot": el.append(slotPreview(pr.name, scope, fg, st)); break;
      default: break;
    }
    if (bg) css.background = bg;
    if (radius !== null && radius !== undefined) { css.borderRadius = `${radius}px`; css.overflow = css.overflow || "hidden"; }
    css.color = fg;
    if (node.on && node.on.click) css.cursor = "pointer";
    for (const k of node.children || []) el.append(preview(k, scope, node.el, fg, onPick));
    if (onPick) {
      el.addEventListener("click", (e) => { e.stopPropagation(); onPick(node.id); });
      if (node.id === selected) el.classList.add("and-sel");
    }
    return el;
  }

  function nameColor(name) {
    const palette = ["#e11d48", "#2563eb", "#059669", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4f46e5"];
    let hsh = 0;
    for (const ch of name || "") hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
    return palette[Math.abs(hsh % palette.length)];
  }
  function initials(name) { const p = String(name || "").trim().split(/[\s._-]+/).filter(Boolean); return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); }

  /** What a native part looks like in the preview (a sketch from the design's own trees where it uses them). */
  function slotPreview(name, scope, fg, st = {}) {
    const wrap = h("div", { class: "and-slot" });
    const sub = (id, s) => preview(design.screens[id], s, "column", fg, null);
    switch (name) {
      case "splashLogo": case "logo": {
        const px = Number(st.width) || Number(st.height) || (name === "logo" ? 56 : 120);
        wrap.append(h("div", { class: "and-mark", style: `width:${px}px;height:${px}px;background:${colorOf("@primary", "#e11d48")};color:${colorOf("@onPrimary", "#fff")};font-size:${px * 0.42}px` }, "M"));
        if (name === "splashLogo") wrap.classList.add("and-orbit");
        break;
      }
      case "lockPad": {
        const grid = h("div", { class: "and-pad" });
        for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"]) grid.append(h("span", { style: k ? `background:${colorOf("@surfaceVariant", "#eee")}` : "visibility:hidden" }, k));
        wrap.append(h("div", { class: "and-dots" }, ...Array.from({ length: overview.config.policy.lock.pinLength }, (_, i) => h("i", { style: `background:${colorOf(i < 2 ? "@primary" : "@border", "#ccc")}` }))), grid);
        break;
      }
      case "roomList": for (const room of (scope.rooms || sampleFor("rooms").rooms)) wrap.append(sub("rooms.item", { room })); break;
      case "roomTabs": wrap.append(h("div", { class: "and-tabs" }, ...(scope.rooms || []).map((r) => h("span", { style: `border-color:${colorOf(r.active ? "@primary" : "@border", "#ccc")};color:${r.active ? colorOf("@primary", "#e11d48") : fg}` }, r.name + (r.unread ? `  ${r.unread}` : ""))))); break;
      case "messages": {
        wrap.classList.add("and-fill");
        const m = [sampleFor("message.sys").msg, sampleFor("message.in").msg, sampleFor("message.out").msg];
        wrap.append(sub("message.sys", { msg: m[0] }), sub("message.in", { msg: m[1] }), sub("message.out", { msg: m[2] }));
        break;
      }
      case "composer":
        wrap.append(h("div", { class: "and-composer", style: `background:${colorOf("@surface", "#fff")}` },
          iconEl("image", 22, fg), h("div", { style: `background:${colorOf("@surfaceVariant", "#eee")};color:${colorOf("@muted", "#888")}` }, t("room.typeMessage")),
          h("span", { style: `background:${colorOf("@primary", "#e11d48")}` }, iconEl("send-horizontal", 20, colorOf("@onPrimary", "#fff")))));
        break;
      case "userPanel": {
        const u = sampleFor("users");
        const panel = sub("users", u);
        panel.style.width = "264px"; // UserPanel: 264 dp
        wrap.append(h("div", { class: "and-panel" }, panel), h("div", { class: "and-handle" }, sub("users.handle", sampleFor("users.handle"))));
        wrap.classList.add("and-overlay");
        break;
      }
      case "userList": for (const user of (scope.users || sampleFor("users").users)) wrap.append(sub("users.item", { user })); break;
      case "callControls": wrap.append(h("div", { class: "and-call" }, ...[["mic", "#ffffff33"], ["video", "#ffffff33"], ["phone-off", colorOf("@danger", "#dc2626")]].map(([i, c]) => h("span", { style: `background:${c}` }, iconEl(i, 24, "#fff"))))); break;
      default: wrap.append(h("div", { class: "and-ph" }, (catalog.slots.find((s) => s.name === name) || { label: name }).label));
    }
    return wrap;
  }

  /* ----------------------------------------------------- screen editor */

  function findNode(node, id, parent = null) {
    if (!node) return null;
    if (node.id === id) return { node, parent };
    for (const k of node.children || []) { const f = findNode(k, id, node); if (f) return f; }
    return null;
  }

  function allIds(node, out = new Set()) { if (!node) return out; out.add(node.id); for (const k of node.children || []) allIds(k, out); return out; }

  function screensEditor(body, markDirty) {
    const grid = h("div", { class: "and-ed" });
    const left = h("div", { class: "card and-ed__tree" });
    const mid = h("div", { class: "and-ed__phone" });
    const right = h("div", { class: "card and-ed__insp" });
    grid.append(left, mid, right);
    body.append(grid);
    const pick = h("select", { class: "input input--sm", "data-read": "1" });
    for (const g of ["system", "app", "room", "parts"]) {
      const og = h("optgroup", { label: g });
      for (const s of catalog.screens.filter((x) => x.group === g)) og.append(h("option", { value: s.id }, `${s.label} (${s.id})`));
      pick.append(og);
    }
    pick.value = screenId;
    pick.addEventListener("change", () => { screenId = pick.value; selected = ""; render(); });
    const tree = () => design.screens[screenId];
    const redraw = () => { drawTree(); drawPhone(); drawInspector(); markDirty(); };
    const outline = h("div", { class: "and-outline" });
    const info = catalog.screens.find((s) => s.id === screenId);
    left.append(h("div", { class: "stack" }, pick, h("div", { class: "muted small" }, info?.help || ""), h("div", { class: "muted small" }, "Variables: ", h("span", { class: "mono" }, (info?.vars || []).join(" "))), outline));

    function drawTree() {
      clear(outline);
      const walk = (n, depth, parent) => {
        const def = catalog.elements.find((e) => e.el === n.el);
        const label = n.name || (n.el === "slot" ? `part: ${n.props?.name}` : n.text ? `${n.el}: ${String(n.text).slice(0, 24)}` : n.el);
        const row = h("div", { class: `and-row${n.id === selected ? " on" : ""}`, style: `padding-left:${6 + depth * 14}px`, onclick: () => { selected = n.id; redraw(); } },
          h("span", { class: "mono small muted" }, def ? def.label : n.el), h("span", {}, ` ${label}`), n.if ? h("span", { class: "badge" }, "if") : null, n.each ? h("span", { class: "badge" }, "each") : null);
        outline.append(row);
        for (const k of n.children || []) walk(k, depth + 1, n);
      };
      walk(tree(), 0, null);
      if (!may("builds")) return;
      const add = h("select", { class: "input input--sm" }, h("option", { value: "" }, "+ Add an element…"), ...catalog.elements.map((e) => h("option", { value: e.el }, `${e.label} (${e.group})`)));
      add.addEventListener("change", () => {
        if (!add.value) return;
        const found = findNode(tree(), selected || tree().id);
        const def = catalog.elements.find((e) => e.el === add.value);
        const ids = allIds(tree());
        let i = 1; let id;
        do { id = `${add.value.toLowerCase()}-${i++}`; } while (ids.has(id));
        const fresh = { id, el: add.value, ...(def.text ? { text: def.el === "button" ? "Button" : "Text" } : {}), ...(add.value === "icon" || add.value === "iconButton" ? { props: { icon: "circle" } } : {}), ...(add.value === "slot" ? { props: { name: catalog.slots[0].name } } : {}) };
        const target = found && catalog.elements.find((e) => e.el === found.node.el)?.container ? found.node : found?.parent || tree();
        target.children = [...(target.children || []), fresh];
        selected = id;
        redraw();
      });
      outline.append(h("div", { class: "row mt8" }, add));
    }

    function drawPhone() {
      clear(mid);
      const scope = { ...sampleFor(screenId), app: { name: design.app.name, version: overview.app.version, code: overview.app.versionCode, bundle: "preview" } };
      const bgc = colorOf("@background", "#f5f6f8");
      const phone = h("div", { class: "and-phone", style: `background:${bgc}` });
      let node;
      try { node = preview(tree(), scope, "column", colorOf("@onSurface", "#1c2330"), (id) => { selected = id; drawTree(); drawInspector(); drawPhone(); }); }
      catch (err) { node = h("div", { class: "err p8" }, `Cannot draw: ${err.message}`); }
      const partScreen = screenId.includes(".") || screenId === "users" || screenId === "flash" || screenId === "update";
      phone.append(h("div", { class: `and-screen${partScreen ? " and-screen--part" : ""}` }, node));
      const tone = h("select", { class: "input input--sm", "data-read": "1" }, h("option", { value: "light" }, "light"), h("option", { value: "dark" }, "dark"));
      tone.value = previewDark ? "dark" : "light";
      tone.addEventListener("change", () => { previewDark = tone.value === "dark"; drawPhone(); });
      const lang = h("select", { class: "input input--sm", "data-read": "1" }, ...catalog.langs.map((l) => h("option", { value: l }, l)));
      lang.value = previewLang;
      lang.addEventListener("change", () => { previewLang = lang.value; drawPhone(); });
      mid.append(h("div", { class: "row" }, tone, lang, h("span", { class: "muted small" }, "click an element to select it")), phone);
    }

    function drawInspector() {
      clear(right);
      const found = selected ? findNode(tree(), selected) : null;
      if (!found) { right.append(h("div", { class: "muted small" }, "Select an element in the tree or the phone.")); return; }
      const n = found.node;
      const def = catalog.elements.find((e) => e.el === n.el) || { props: [], text: false, container: false };
      const ro = !may("builds");
      const change = () => { drawTree(); drawPhone(); markDirty(); };
      const input = (value, onInput, opts = {}) => {
        const i = h(opts.area ? "textarea" : "input", { class: `input input--sm${opts.mono ? " mono" : ""}`, rows: opts.area ? "2" : undefined, placeholder: opts.placeholder || "", disabled: ro || undefined });
        i.value = value ?? "";
        const problem = h("div", { class: "err small", hidden: true });
        i.addEventListener("input", () => {
          const msg = opts.check ? opts.check(i.value) : null;
          problem.hidden = !msg;
          problem.textContent = msg || "";
          if (!msg) { onInput(i.value); change(); }
        });
        return h("div", { class: "stack" }, i, problem);
      };
      const checkTpl = (v) => (v.startsWith("=") ? X.check(v.slice(1)) : X.checkTemplate(v));
      const checkExpr = (v) => (v.trim() ? X.check(v) : null);
      const set = (obj, key, v) => { if (v === "" || v === undefined || v === null) delete obj[key]; else obj[key] = v; };
      const f = (label, control, hint) => h("label", { class: "field" }, h("span", { class: "label" }, label), control, hint ? h("span", { class: "muted small" }, hint) : null);
      right.append(h("div", { class: "row" }, h("strong", {}, def.label || n.el), h("span", { class: "mono small muted" }, `#${n.id}`), h("span", { class: "spacer" }),
        found.parent && !ro ? h("button", { class: "btn btn--xs", type: "button", title: "Up", onclick: () => { const kids = found.parent.children; const i = kids.indexOf(n); if (i > 0) { kids.splice(i - 1, 0, kids.splice(i, 1)[0]); change(); } } }, "↑") : null,
        found.parent && !ro ? h("button", { class: "btn btn--xs", type: "button", title: "Down", onclick: () => { const kids = found.parent.children; const i = kids.indexOf(n); if (i < kids.length - 1) { kids.splice(i + 1, 0, kids.splice(i, 1)[0]); change(); } } }, "↓") : null,
        found.parent && !ro ? h("button", { class: "btn btn--xs", type: "button", title: "Duplicate", onclick: () => { const ids = allIds(tree()); const copy = structuredClone(n); const rename = (x) => { let i = 2; let id = x.id; while (ids.has(id)) id = `${x.id}-${i++}`; ids.add(id); x.id = id; for (const k of x.children || []) rename(k); }; rename(copy); found.parent.children.splice(found.parent.children.indexOf(n) + 1, 0, copy); selected = copy.id; redraw(); } }, "⧉") : null,
        found.parent && !ro ? h("button", { class: "btn btn--xs btn--danger", type: "button", title: "Remove", onclick: () => { found.parent.children = found.parent.children.filter((k) => k !== n); if (!found.parent.children.length) delete found.parent.children; selected = found.parent.id; redraw(); } }, "×") : null));
      right.append(h("div", { class: "muted small" }, def.help || ""));
      right.append(f("Name (for you)", input(n.name, (v) => set(n, "name", v))));
      if (def.text) right.append(f("Text", input(n.text, (v) => set(n, "text", v), { area: true, check: checkTpl }), "{$var} {_'key'} {=expression} · filters: |upper |truncate:40 |time |size…"));
      if (def.props.length) right.append(h("h4", {}, "Parameters"));
      n.props = n.props || {};
      for (const p of def.props) {
        let control;
        if (p.kind === "bool") {
          control = h("input", { type: "checkbox", disabled: ro || undefined });
          control.checked = n.props[p.name] === true || n.props[p.name] === "true";
          control.addEventListener("change", () => { set(n.props, p.name, control.checked ? true : undefined); change(); });
        } else if (p.kind === "select" || p.kind === "slot") {
          const opts = p.kind === "slot" ? catalog.slots.map((s) => s.name) : p.options;
          control = h("select", { class: "input input--sm", disabled: ro || undefined }, h("option", { value: "" }, "—"), ...opts.map((o) => h("option", { value: o }, o)));
          control.value = n.props[p.name] ?? "";
          control.addEventListener("change", () => { set(n.props, p.name, control.value); change(); });
        } else if (p.kind === "icon") {
          const cur = String(n.props[p.name] || "");
          const btn = h("button", { class: "btn btn--sm", type: "button", disabled: ro || undefined, onclick: () => Kit.openIconPicker({ icons: catalog.icons, current: cur, onPick: (name) => { set(n.props, p.name, name); change(); drawInspector(); } }) }, cur && !cur.startsWith("=") ? iconEl(cur, 18, "currentColor") : null, cur || "choose…");
          control = h("div", { class: "row" }, btn, input(cur.startsWith("=") ? cur : "", (v) => set(n.props, p.name, v || undefined), { placeholder: "or =expression", check: (v) => (v && !v.startsWith("=") ? "start with =" : v ? X.check(v.slice(1)) : null) }));
        } else if (p.kind === "color") {
          control = input(n.props[p.name], (v) => set(n.props, p.name, v), { placeholder: "@primary or #rrggbb", mono: true });
        } else if (p.kind === "number") {
          control = input(n.props[p.name], (v) => set(n.props, p.name, v === "" ? undefined : Number(v)), { placeholder: "number" });
        } else {
          control = input(n.props[p.name] === undefined ? "" : String(n.props[p.name]), (v) => set(n.props, p.name, v), { mono: p.kind === "expr", check: p.kind === "expr" ? (v) => (v ? X.check(v.replace(/^=/, "")) : null) : checkTpl });
        }
        right.append(f(p.label, control, p.help));
      }
      if (!Object.keys(n.props).length) delete n.props;
      right.append(h("h4", {}, "Style"));
      n.style = n.style || {};
      for (const s of catalog.style) {
        const v = n.style[s.name];
        right.append(f(s.label, input(v === undefined ? "" : String(v), (x) => {
          if (x === "") delete n.style[s.name];
          else if (/^-?\d+(\.\d+)?$/.test(x)) n.style[s.name] = Number(x);
          else if (x === "true" || x === "false") n.style[s.name] = x === "true";
          else n.style[s.name] = x;
        }, { placeholder: s.help, mono: true, check: (x) => (x.startsWith("=") ? X.check(x.slice(1)) : null) })));
      }
      if (!Object.keys(n.style).length) delete n.style;
      right.append(h("h4", {}, "Animation (enter)"));
      const enter = (n.anim && n.anim.enter) || {};
      const type = h("select", { class: "input input--sm", disabled: ro || undefined }, h("option", { value: "" }, "none"), ...catalog.anims.filter((a) => a !== "none").map((a) => h("option", { value: a }, a)));
      type.value = enter.type || "";
      const ms = h("input", { class: "input input--sm", type: "number", value: enter.ms ?? "", placeholder: "ms", disabled: ro || undefined });
      const delay = h("input", { class: "input input--sm", type: "number", value: enter.delay ?? "", placeholder: "delay", disabled: ro || undefined });
      const easing = h("select", { class: "input input--sm", disabled: ro || undefined }, ...catalog.easings.map((a) => h("option", { value: a }, a)));
      easing.value = enter.easing || "standard";
      const setAnim = () => { if (!type.value) delete n.anim; else n.anim = { enter: { type: type.value, ...(ms.value ? { ms: Number(ms.value) } : {}), ...(delay.value ? { delay: Number(delay.value) } : {}), easing: easing.value } }; change(); };
      for (const c of [type, ms, delay, easing]) c.addEventListener("change", setAnim);
      right.append(h("div", { class: "row" }, type, ms, delay, easing));
      right.append(h("h4", {}, "Logic"));
      right.append(f("Show when (if)", input(n.if, (v) => set(n, "if", v), { mono: true, check: checkExpr, placeholder: "$room.unread > 0" })));
      right.append(f("Repeat for (each)", input(n.each, (v) => { set(n, "each", v); if (v && !n.as) n.as = "item"; if (!v) delete n.as; }, { mono: true, check: checkExpr, placeholder: "$rooms" })));
      if (n.each) right.append(f("Each item as", input(n.as, (v) => set(n, "as", v || "item"), { mono: true })));
      right.append(h("h4", {}, "Events"));
      n.on = n.on || {};
      for (const ev of catalog.events) {
        const a = h("select", { class: "input input--sm", disabled: ro || undefined }, h("option", { value: "" }, "—"), ...catalog.actions.map((x) => h("option", { value: x.action, title: x.help }, x.action)));
        a.value = n.on[ev]?.action || "";
        const arg = input(n.on[ev]?.arg || "", (v) => { if (n.on[ev]) set(n.on[ev], "arg", v); }, { placeholder: "argument ({$var} or =expression)", mono: true, check: checkTpl });
        a.addEventListener("change", () => { if (!a.value) delete n.on[ev]; else n.on[ev] = { action: a.value, ...(n.on[ev]?.arg ? { arg: n.on[ev].arg } : {}) }; change(); });
        right.append(f(ev, h("div", { class: "stack" }, a, arg), catalog.actions.find((x) => x.action === a.value)?.help));
      }
      if (!Object.keys(n.on).length) delete n.on;
      C.applyRoleGates();
    }

    redraw();
  }

  /* ---------------------------------------------------- other editors */

  function themeEditor(body, markDirty) {
    const card = h("div", { class: "card stack" });
    const grid = h("div", { class: "and-theme" });
    grid.append(h("span"), h("strong", {}, "light"), h("strong", {}, "dark"));
    for (const token of catalog.colors) {
      const cells = ["light", "dark"].map((tone) => {
        const v = design.theme[tone][token] || "#000000";
        const color = h("input", { type: "color", value: v.length === 9 ? `#${v.slice(3)}` : v, disabled: !may("builds") || undefined });
        const text = h("input", { class: "input input--sm mono", value: v, disabled: !may("builds") || undefined });
        color.addEventListener("input", () => { design.theme[tone][token] = text.value.length === 9 ? `#${text.value.slice(1, 3)}${color.value.slice(1)}` : color.value; text.value = design.theme[tone][token]; markDirty(); });
        text.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text.value)) { design.theme[tone][token] = text.value.toLowerCase(); markDirty(); } });
        return h("div", { class: "row" }, color, text);
      });
      grid.append(h("span", { class: "mono small" }, `@${token}`), ...cells);
    }
    const radius = h("input", { class: "input input--sm", type: "number", min: "0", max: "40", value: String(design.theme.radius) });
    radius.addEventListener("input", () => { design.theme.radius = Number(radius.value); markDirty(); });
    const font = h("select", { class: "input input--sm" }, ...["sans", "serif", "mono"].map((x) => h("option", { value: x }, x)));
    font.value = design.theme.font;
    font.addEventListener("change", () => { design.theme.font = font.value; markDirty(); });
    const name = h("input", { class: "input input--sm", value: design.app.name });
    name.addEventListener("input", () => { design.app.name = name.value; markDirty(); });
    card.append(h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Theme"), h("div", { class: "card__hint" }, "The colour tokens the screens use (@primary…), for light and dark. Colours with transparency are #aarrggbb.")),
      h("div", { class: "row" }, h("label", { class: "field" }, h("span", { class: "label" }, "App name"), name), h("label", { class: "field" }, h("span", { class: "label" }, "Corner radius"), radius), h("label", { class: "field" }, h("span", { class: "label" }, "Font"), font)), grid);
    body.append(card);
  }

  function animationsEditor(body, markDirty) {
    const card = h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Animations"), h("div", { class: "card__hint" }, "How screens change, dialogs open, messages and list items come in, flash messages drop, the user panel slides, the splash moves. Reduced motion in the phone's settings turns them off.")));
    for (const key of ["screen", "dialog", "message", "list", "flash", "users"]) {
      const a = design.animations[key];
      const type = h("select", { class: "input input--sm" }, ...catalog.anims.map((x) => h("option", { value: x }, x)));
      type.value = a.type;
      const ms = h("input", { class: "input input--sm", type: "number", value: String(a.ms) });
      const easing = h("select", { class: "input input--sm" }, ...catalog.easings.map((x) => h("option", { value: x }, x)));
      easing.value = a.easing;
      const upd = () => { a.type = type.value; a.ms = Number(ms.value); a.easing = easing.value; markDirty(); };
      for (const c of [type, ms, easing]) c.addEventListener("change", upd);
      const extra = key === "flash" ? (() => { const stay = h("input", { class: "input input--sm", type: "number", value: String(a.stay) }); stay.addEventListener("change", () => { a.stay = Number(stay.value); markDirty(); }); return h("label", { class: "row small" }, "stays", stay, "ms"); })() : null;
      card.append(h("div", { class: "row" }, h("strong", { style: "width:90px" }, key), type, ms, h("span", { class: "muted small" }, "ms"), easing, extra));
    }
    const s = design.animations.splash;
    const style = h("select", { class: "input input--sm" }, ...["orbit", "pulse", "reveal", "none"].map((x) => h("option", { value: x }, x)));
    style.value = s.style;
    const sms = h("input", { class: "input input--sm", type: "number", value: String(s.ms) });
    const min = h("input", { class: "input input--sm", type: "number", value: String(s.minMs) });
    const upd = () => { s.style = style.value; s.ms = Number(sms.value); s.minMs = Number(min.value); markDirty(); };
    for (const c of [style, sms, min]) c.addEventListener("change", upd);
    card.append(h("div", { class: "row" }, h("strong", { style: "width:90px" }, "splash"), style, sms, h("span", { class: "muted small" }, "ms a turn · shown at least"), min, h("span", { class: "muted small" }, "ms")));
    body.append(card);
  }

  function textsEditor(body, markDirty) {
    const lang = h("select", { class: "input input--sm", "data-read": "1" }, ...catalog.langs.map((l) => h("option", { value: l }, l)));
    lang.value = previewLang;
    const filter = h("input", { class: "input input--sm", type: "search", placeholder: "Filter keys or texts…", "data-read": "1" });
    const list = h("div", { class: "and-texts" });
    const draw = () => {
      clear(list);
      const table = design.strings[lang.value];
      const q = filter.value.toLowerCase();
      for (const key of Object.keys(design.strings.en).sort()) {
        if (q && !key.includes(q) && !String(table[key] || "").toLowerCase().includes(q)) continue;
        const i = h("input", { class: "input input--sm", value: table[key] ?? "", placeholder: design.strings.en[key], disabled: !may("builds") || undefined });
        i.addEventListener("input", () => { table[key] = i.value; markDirty(); });
        list.append(h("span", { class: "mono small" }, key), i);
      }
    };
    lang.addEventListener("change", draw);
    filter.addEventListener("input", draw);
    const nk = h("input", { class: "input input--sm mono", placeholder: "new.key" });
    body.append(h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Texts"), h("div", { class: "card__hint" }, "Every text of the app in Czech, English and German; screens use them as {_'key'}. New keys can be added for your own screens.")),
      h("div", { class: "row" }, lang, filter, h("span", { class: "spacer" }), nk, may("builds") ? h("button", { class: "btn btn--sm", type: "button", onclick: () => { const k = nk.value.trim(); if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(k)) { toast("letters, digits, . _ -", "err"); return; } for (const l of catalog.langs) design.strings[l][k] = design.strings[l][k] ?? ""; nk.value = ""; draw(); markDirty(); } }, "Add key") : null), list));
    draw();
  }

  function menusEditor(body, markDirty) {
    for (const [id, items] of Object.entries(design.menus)) {
      const card = h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, `Menu “${id}”`), h("div", { class: "card__hint" }, id === "main" ? "The rooms screen's ⋮ menu." : id === "room" ? "The room's ⋮ menu." : id === "dock" ? "Where the user panel sits." : "Opened with menu.open")));
      const draw = () => {
        while (card.childNodes.length > 1) card.lastChild.remove();
        items.forEach((it, i) => {
          const label = h("input", { class: "input input--sm", value: it.label });
          label.addEventListener("input", () => { it.label = label.value; markDirty(); });
          const action = h("select", { class: "input input--sm" }, ...catalog.actions.map((x) => h("option", { value: x.action }, x.action)));
          action.value = it.action;
          action.addEventListener("change", () => { it.action = action.value; markDirty(); });
          const arg = h("input", { class: "input input--sm mono", value: it.arg || "", placeholder: "argument" });
          arg.addEventListener("input", () => { if (arg.value) it.arg = arg.value; else delete it.arg; markDirty(); });
          const cond = h("input", { class: "input input--sm mono", value: it.if || "", placeholder: "show when" });
          cond.addEventListener("input", () => { if (cond.value && !X.check(cond.value)) it.if = cond.value; else delete it.if; markDirty(); });
          const icon = h("button", { class: "btn btn--sm", type: "button", onclick: () => Kit.openIconPicker({ icons: catalog.icons, current: it.icon, onPick: (n) => { it.icon = n; markDirty(); draw(); } }) }, iconEl(it.icon, 16, "currentColor"));
          card.append(h("div", { class: "row" }, icon, label, action, arg, cond,
            h("button", { class: "btn btn--xs", type: "button", onclick: () => { if (i > 0) { items.splice(i - 1, 0, items.splice(i, 1)[0]); markDirty(); draw(); } } }, "↑"),
            h("button", { class: "btn btn--xs btn--danger", type: "button", onclick: () => { items.splice(i, 1); markDirty(); draw(); } }, "×")));
        });
        card.append(h("button", { class: "btn btn--sm", type: "button", onclick: () => { items.push({ id: `item-${items.length + 1}`, icon: "circle", label: "Item", action: "flash", arg: "Hello" }); markDirty(); draw(); } }, "+ Item"));
      };
      draw();
      body.append(card);
    }
  }

  function librariesEditor(body, markDirty) {
    const card = h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Action libraries"), h("div", { class: "card__hint" }, "Named sequences of the app's actions, each step with an optional condition; screens and menus run them with lib.run. They are data, not code: nothing is executed on the device but the app's own actions.")));
    const draw = () => {
      while (card.childNodes.length > 1) card.lastChild.remove();
      for (const [name, lib] of Object.entries(design.libraries)) {
        const desc = h("input", { class: "input input--sm", value: lib.description, placeholder: "What it does" });
        desc.addEventListener("input", () => { lib.description = desc.value; markDirty(); });
        const steps = h("div", { class: "stack" });
        const drawSteps = () => {
          clear(steps);
          lib.steps.forEach((s, i) => {
            const act = h("select", { class: "input input--sm" }, ...catalog.actions.filter((a) => a.action !== "lib.run").map((a) => h("option", { value: a.action }, a.action)));
            act.value = s.do;
            act.addEventListener("change", () => { s.do = act.value; markDirty(); });
            const arg = h("input", { class: "input input--sm mono", value: s.arg || "", placeholder: "argument" });
            arg.addEventListener("input", () => { if (arg.value) s.arg = arg.value; else delete s.arg; markDirty(); });
            const cond = h("input", { class: "input input--sm mono", value: s.if || "", placeholder: "only if" });
            cond.addEventListener("input", () => { if (cond.value && !X.check(cond.value)) s.if = cond.value; else delete s.if; markDirty(); });
            steps.append(h("div", { class: "row" }, h("span", { class: "muted small" }, `${i + 1}.`), act, arg, cond, h("button", { class: "btn btn--xs btn--danger", type: "button", onclick: () => { lib.steps.splice(i, 1); markDirty(); drawSteps(); } }, "×")));
          });
          steps.append(h("button", { class: "btn btn--sm", type: "button", onclick: () => { lib.steps.push({ do: "flash", arg: "Hello" }); markDirty(); drawSteps(); } }, "+ Step"));
        };
        drawSteps();
        card.append(h("div", { class: "card" }, h("div", { class: "row" }, h("strong", { class: "mono" }, name), desc, h("span", { class: "spacer" }), h("button", { class: "btn btn--xs btn--danger", type: "button", onclick: () => { delete design.libraries[name]; markDirty(); draw(); } }, "Remove")), steps));
      }
      const nn = h("input", { class: "input input--sm mono", placeholder: "library-name" });
      card.append(h("div", { class: "row" }, nn, h("button", { class: "btn btn--sm", type: "button", onclick: () => { const n = nn.value.trim(); if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(n) || design.libraries[n]) { toast("a-z, 0-9, dashes; a new name", "err"); return; } design.libraries[n] = { description: "", steps: [] }; markDirty(); draw(); } }, "+ Library")));
    };
    draw();
    body.append(card);
  }

  function assetsEditor(body, markDirty) {
    const card = h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Assets"), h("div", { class: "card__hint" }, "Pictures (PNG, WebP, JPEG, GIF) and fonts (TTF, OTF) the screens use as asset:<name>; at most 512 kB each, 2 MB together. They travel inside the encrypted bundle.")));
    const list = h("div", { class: "and-assets" });
    const draw = () => {
      clear(list);
      for (const [name, a] of Object.entries(design.assets)) {
        list.append(h("div", { class: "card" }, a.mime.startsWith("image/") ? h("img", { alt: name, src: `data:${a.mime};base64,${a.data}`, style: "max-width:100%;max-height:90px" }) : h("div", { class: "muted" }, a.mime),
          h("div", { class: "mono small" }, `asset:${name}`), h("div", { class: "muted small" }, size(Math.floor(a.data.length * 3 / 4))),
          may("builds") ? h("button", { class: "btn btn--xs btn--danger", type: "button", onclick: () => { delete design.assets[name]; markDirty(); draw(); } }, "Remove") : null));
      }
    };
    const file = h("input", { type: "file", accept: "image/png,image/webp,image/jpeg,image/gif,.ttf,.otf" });
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 512 * 1024) { toast("Larger than 512 kB.", "err"); return; }
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const name = f.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
      const mime = f.type || (/\.otf$/i.test(f.name) ? "font/otf" : "font/ttf");
      design.assets[name] = { mime, data: btoa(bin) };
      markDirty();
      draw();
    });
    if (may("builds")) card.append(file);
    card.append(list);
    draw();
    body.append(card);
  }

  C.addRoute("android", ["Android", "Devices, builds, releases, design and security of the Android app", load]);
})();
