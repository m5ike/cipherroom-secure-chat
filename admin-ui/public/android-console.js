// M5cet operator console — Android (6.0).
//
//   Overview   the fleet at a glance, the server's Android key, getting the app
//   Devices    enrolled phones: state, commands (ping, status, flash, push,
//              update, lock, wipe), history, events; block, retire, delete
//   Push       one control message to several devices; FCM settings and a test
//   Design     the app's look: a visual builder for the screens (element
//              trees: palette, layers, drag & drop, the phone preview with
//              direct editing, inspector, undo), theme, animations, texts,
//              menus, action libraries, assets
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
  let designSaved = null; // the design as last saved, a snapshot (snap())
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
    ensureStyles();
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

  // 6.1: the Design tab is a visual builder. Every change of the design goes
  // through changed(): one undo step per edit, typing into one field is one
  // step. Snapshots leave the assets out of the JSON (they are only ever
  // added or removed whole), so a long session stays small.
  const hist = { undo: [], redo: [], last: null, key: null };
  let designStatus = () => {};
  let builder = null; // the mounted screens editor: { alive, refresh, place, key }

  const snap = () => { const { assets, ...rest } = design; return { s: JSON.stringify(rest), a: { ...(assets || {}) } }; };
  const sameSnap = (a, b) => { if (a.s !== b.s) return false; const ka = Object.keys(a.a); return ka.length === Object.keys(b.a).length && ka.every((k) => a.a[k] === b.a[k]); };
  function resetHistory() { hist.undo = []; hist.redo = []; hist.last = snap(); hist.key = null; }

  /** Call after changing the design: an undo step, unless it goes on with the same key (typing into one field). */
  function changed(key = null) {
    const now = snap();
    now.scr = screenId; // where it happened, and what was selected: undo and redo go back there
    now.sel = selected;
    if (!hist.last) hist.last = now;
    else if (!sameSnap(now, hist.last)) {
      if (key === null || key !== hist.key) { hist.undo.push(hist.last); if (hist.undo.length > 200) hist.undo.shift(); }
      hist.redo = [];
      hist.last = now;
      hist.key = key;
    }
    designStatus();
  }
  /** Back to a snapshot; `via` is the step undone or redone (its screen is shown). */
  function restore(s, via) {
    design = JSON.parse(s.s);
    design.assets = { ...s.a };
    hist.last = s;
    hist.key = null;
    if (designTab === "screens" && builder && builder.alive()) builder.refresh(via.scr, via.sel); else render();
    designStatus();
  }
  function undo() { if (!hist.undo.length) return; const cur = hist.last; hist.redo.push(cur); restore(hist.undo.pop(), cur); }
  function redo() { if (!hist.redo.length) return; hist.undo.push(hist.last); const next = hist.redo.pop(); restore(next, next); }
  /** The field being typed into: the other editors' keystrokes in one field make one undo step. */
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") ? a : null; };
  const editable = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));

  // Keys work while the Design tab is shown and no field or dialog has them.
  document.addEventListener("keydown", (e) => {
    const el = root();
    const panel = el && el.closest("[data-panel]");
    if (!el || tab !== "design" || (panel && panel.hidden) || document.querySelector(".mb-overlay") || editable(e.target)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "z" || k === "y")) {
      if (!may("builds")) return;
      e.preventDefault();
      if (k === "y" || e.shiftKey) redo(); else undo();
      return;
    }
    if (designTab === "screens" && builder && builder.alive()) builder.key(e);
  });
  window.addEventListener("resize", () => { if (builder && builder.alive()) builder.place(); });

  /** The console's stylesheet for this page (android-console.css), added once. */
  function ensureStyles() {
    if (document.getElementById("androidConsoleCss")) return;
    document.head.append(h("link", { id: "androidConsoleCss", rel: "stylesheet", href: "android-console.css" }));
  }

  function iconBtn(icon, label, onclick, extra = {}) {
    const { text, ...attrs } = extra;
    return h("button", { class: "btn btn--sm and-ibtn", type: "button", title: label, "aria-label": label, onclick, ...attrs }, iconEl(icon, 15, "currentColor"), text ? h("span", {}, text) : null);
  }

  async function designView(body) {
    if (!design) {
      const r = await guarded(() => api("/api/admin/android/design"));
      if (!r) return;
      design = r.design;
      designSaved = snap();
      resetHistory();
    }
    if (!hist.last) resetHistory();
    if (!designSaved) designSaved = snap();
    const edit = may("builds");
    const dirty = () => !sameSnap(snap(), designSaved);
    const status = h("span", { class: "muted small", role: "status" });
    const undoBtn = edit ? iconBtn("undo-2", "Undo (Ctrl+Z)", undo) : null;
    const redoBtn = edit ? iconBtn("redo-2", "Redo (Ctrl+Shift+Z)", redo) : null;
    let queued = false;
    // Once a frame at most: comparing with the saved design costs a JSON of it.
    designStatus = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        status.textContent = dirty() ? "unsaved changes" : `saved · ${design.rev}`;
        if (undoBtn) undoBtn.disabled = !hist.undo.length;
        if (redoBtn) redoBtn.disabled = !hist.redo.length;
      });
    };
    const top = h("div", { class: "row" },
      ...["screens", "theme", "animations", "texts", "menus", "libraries", "assets"].map((id) => h("button", { class: `btn btn--sm${designTab === id ? " btn--primary" : ""}`, type: "button", "data-read": "1", "aria-pressed": designTab === id ? "true" : "false", onclick: () => { designTab = id; render(); } }, id[0].toUpperCase() + id.slice(1))),
      h("span", { class: "spacer" }), status, undoBtn, redoBtn,
      edit ? h("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => {
        try {
          const r = await api("/api/admin/android/design", { method: "PUT", body: { design } });
          design = r.design;
          designSaved = snap();
          hist.last = designSaved;
          hist.key = null;
          toast("Design saved. Build it (Builds) to send it to the devices.", "ok");
          render();
        } catch (err) { toast(err.message, "err"); }
      } }, "Save") : null,
      edit ? h("button", { class: "btn btn--sm", type: "button", onclick: () => { design = JSON.parse(designSaved.s); design.assets = { ...designSaved.a }; changed(null); render(); } }, "Revert") : null,
      edit ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (!confirm("Replace the design with the built-in default?")) return; const r = await guarded(() => api("/api/admin/android/design/reset", { method: "POST", body: {} }), "Reset to the default."); if (r) { design = r.design; designSaved = snap(); changed(null); render(); } } }, "Reset") : null);
    body.append(top);
    designStatus();
    const views = { screens: screensEditor, theme: themeEditor, animations: animationsEditor, texts: textsEditor, menus: menusEditor, libraries: librariesEditor, assets: assetsEditor };
    (views[designTab] || screensEditor)(body, () => changed(typing()));
  }

  /* ------------------------------------------------------- the preview */

  const t = (key) => { const table = design.strings[previewLang] || {}; return table[key] ?? (design.strings.en || {})[key] ?? key; };

  function colorOf(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    let v = String(value);
    if (v.startsWith("@")) { v = (design.theme[previewDark ? "dark" : "light"] || {})[v.slice(1)]; if (!v) return fallback; }
    // #aarrggbb (Android) → rgba (CSS reads eight digits as #rrggbbaa)
    if (/^#[0-9a-fA-F]{8}$/.test(v)) { const a = parseInt(v.slice(1, 3), 16) / 255; return `rgba(${parseInt(v.slice(3, 5), 16)},${parseInt(v.slice(5, 7), 16)},${parseInt(v.slice(7, 9), 16)},${a.toFixed(2)})`; }
    return v;
  }

  const box4 = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const p = String(v).trim().split(/\s+/).map(Number);
    const [a, b = a, c = a, d = b] = p;
    return `${a}px ${b}px ${c}px ${d}px`;
  };

  const iconCache = new Map();
  function iconEl(name, px, color) {
    const key = `${name || "circle"}/${px}`;
    let proto = iconCache.get(key);
    if (!proto) {
      proto = Kit.iconSvg(catalog.icons, name || "circle", "and-ico");
      proto.setAttribute("width", String(px));
      proto.setAttribute("height", String(px));
      if (iconCache.size < 600) iconCache.set(key, proto);
    }
    const svg = proto.cloneNode(true);
    svg.style.color = color;
    svg.style.flex = "none";
    return svg;
  }

  // The designer's own sample data per screen (preview only, never saved).
  const samples = {};
  const catalogSample = (id) => { const s = catalog.screens.find((x) => x.id === id); return s ? structuredClone(s.sample) : {}; };
  const sampleFor = (id) => (samples[id] !== undefined ? structuredClone(samples[id]) : catalogSample(id));
  const phoneScope = (id) => ({ ...sampleFor(id), app: { name: design.app.name, version: overview.app.version, code: overview.app.versionCode, bundle: "preview" } });
  const isPart = (id) => id.includes(".") || id === "users" || id === "flash" || id === "update";

  const elDef = (el) => catalog.elements.find((e) => e.el === el);
  const isContainer = (n) => Boolean(n && elDef(n.el)?.container);
  const FLEX = ["column", "row", "card", "scroll"];
  const DRAWN = new Set(["column", "row", "stack", "scroll", "card", "text", "badge", "chip", "button", "iconButton", "icon", "avatar", "image", "divider", "spacer", "progress", "input", "switch", "checkbox", "slot", "select", "slider", "segmented"]);

  /** "a|b|c", a list, or "=expression" giving either → the option labels. */
  function optionList(src, val) {
    if (src === undefined || src === null || src === "") return [];
    const v = typeof src === "string" ? val(src) : src;
    if (Array.isArray(v)) return v.map((o) => X.toText(o && typeof o === "object" ? (o.label ?? o.value) : o));
    return X.toText(v).split("|").map((s) => s.trim()).filter(Boolean);
  }
  /** The value a control shows: bind names a value of $form (or $settings, or a dotted path). */
  function bound(bind, scope) {
    const path = X.toText(bind).replace(/^\$/, "").split(".").filter(Boolean);
    if (!path.length) return null;
    for (const base of [scope.form, scope.settings, scope]) {
      const v = path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), base);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  }

  /**
   * Renders a tree as HTML, as close to the app's native renderer as CSS allows.
   * `live` marks the edited screen's elements (data-nid) for picking and dropping;
   * a node that cannot be drawn becomes a marked box instead of breaking the rest.
   */
  function preview(node, scope, parent, fgIn, live) {
    try { return drawNode(node, scope, parent, fgIn, live); }
    catch (err) { const bad = h("div", { class: "and-n and-bad", title: err.message }, `${node && node.el}: ${err.message}`); if (live && node) bad.dataset.nid = node.id; return bad; }
  }

  function drawNode(node, scope, parent, fgIn, live) {
    const val = (v) => X.value(v, scope, t);
    if (node.each) {
      const list = X.eval(node.each, scope, t);
      const frag = document.createDocumentFragment();
      const { each, ...rest } = node;
      (Array.isArray(list) ? list.slice(0, 50) : []).forEach((item, i, arr) => frag.append(preview(rest, { ...scope, [node.as || "item"]: item, index: i, first: i === 0, last: i === arr.length - 1 }, parent, fgIn, live)));
      return frag;
    }
    if (node.if) { try { if (!X.truthy(X.eval(node.if, scope, t))) return document.createComment(node.id); } catch { /* shown */ } }
    const def = elDef(node.el);
    const st = node.style || {};
    const pr = node.props || {};
    const sv = (k) => { const v = st[k]; return typeof v === "string" && v.startsWith("=") ? X.toText(X.eval(v.slice(1), scope, t)) : v; };
    let fg = sv("fg") !== undefined ? colorOf(sv("fg"), fgIn) : fgIn;
    // and-e-<el>: the element's own class, apart from the console's and-* ones (.and-row is a layer row)
    const el = h("div", { class: `and-n and-e-${node.el}` });
    if (live) el.dataset.nid = node.id;
    const css = el.style;
    const inRow = parent === "row";
    const primary = colorOf("@primary", "#e11d48");
    // layout (an element this console does not know yet but that holds children lays them out as a column)
    if (FLEX.includes(node.el) || (!DRAWN.has(node.el) && def?.container)) {
      css.display = "flex";
      css.flexDirection = node.el === "row" || (node.el === "scroll" && X.truthy(pr.horizontal)) ? "row" : "column";
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
      if (variant === "mono" || design.theme.font === "mono" || st.font === "mono") css.fontFamily = "ui-monospace, monospace";
      else if (design.theme.font === "serif" || st.font === "serif") css.fontFamily = "Georgia, serif";
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
        else { css.border = `1px solid ${colorOf(sel ? "@primary" : "@border", "#ccc")}`; if (sel) { bg = bg || "color-mix(in srgb, " + primary + " 16%, transparent)"; fg = colorOf("@primary", fg); } }
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
        const colors = { primary: [primary, colorOf("@onPrimary", "#fff")], danger: [colorOf("@danger", "#dc2626"), "#fff"], tonal: ["color-mix(in srgb, " + primary + " 14%, transparent)", primary], secondary: ["transparent", fg], text: ["transparent", primary] }[variant] || ["transparent", fg];
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
        if (variant === "primary") { bg = primary; radius = 22; }
        el.append(iconEl(X.toText(val(pr.icon)) || "circle", 22, variant === "primary" ? colorOf("@onPrimary", "#fff") : fg));
        const n = Number(val(pr.badge) || 0);
        if (n > 0) el.append(h("span", { class: "and-dot", style: `background:${primary}` }, n > 99 ? "99+" : String(n)));
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
        const img = h("img", { alt: "", draggable: "false", style: "width:100%;display:block;object-fit:" + ({ contain: "contain", center: "none" }[pr.fit] || "cover") });
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
        el.append(v === null ? h("div", { class: "and-spin", style: `border-color:${primary} transparent transparent transparent` }) : h("div", { class: "and-bar" }, h("div", { style: `width:${Math.round(v * 100)}%;background:${primary}` })));
        break;
      }
      case "input": {
        const v = X.toText(bound(pr.bind, scope));
        const inp = h("div", { class: "and-input" }, v || text(pr.hint || ""));
        inp.style.background = colorOf("@surfaceVariant", "#eee");
        inp.style.color = v ? fg : colorOf("@muted", "#888");
        el.append(inp);
        break;
      }
      case "switch": case "checkbox": {
        const on = X.truthy(val(pr.checked));
        const mark = node.el === "switch" ? h("span", { class: `and-switch${on ? " on" : ""}`, style: on ? `background:${primary}` : "" }) : h("span", { class: "and-check", style: `border-color:${primary};background:${on ? primary : "transparent"}` }, on ? "✓" : "");
        css.display = "flex"; css.alignItems = "center"; css.gap = "8px";
        el.append(mark);
        if (node.text) el.append(document.createTextNode(text(node.text)));
        break;
      }
      case "select": {
        const opts = optionList(pr.options, val);
        const cur = X.toText(bound(pr.bind, scope));
        const shown = cur || opts[0] || text(pr.hint || "");
        el.append(h("div", { class: "and-select", style: `background:${colorOf("@surfaceVariant", "#eee")};color:${cur || opts.length ? fg : colorOf("@muted", "#888")}` }, h("span", {}, shown || "—"), iconEl("chevron-down", 18, colorOf("@muted", "#888"))));
        break;
      }
      case "slider": {
        const num = (v, d) => { const x = Number(v === undefined || v === "" ? NaN : val(v)); return Number.isFinite(x) ? x : d; };
        const min = num(pr.min, 0);
        const max = Math.max(num(pr.max, 100), min + 1e-9);
        const b = Number(bound(pr.bind, scope));
        const cur = Math.min(max, Math.max(min, Number.isFinite(b) && bound(pr.bind, scope) !== null ? b : min));
        const pct = ((cur - min) / (max - min)) * 100;
        el.append(h("div", { class: "and-slider", title: String(cur) },
          h("div", { class: "and-slider__track", style: `background:${colorOf("@border", "#ccc")}` }, h("div", { class: "and-slider__fill", style: `width:${pct}%;background:${primary}` })),
          h("div", { class: "and-slider__thumb", style: `left:${pct}%;background:${primary}` })));
        break;
      }
      case "segmented": {
        const opts = optionList(pr.options, val);
        const cur = X.toText(bound(pr.bind, scope)) || opts[0];
        const seg = h("div", { class: "and-seg", style: `border-color:${colorOf("@border", "#ccc")}` });
        for (const o of opts.length ? opts : ["—"]) seg.append(h("span", { style: o === cur ? `background:${primary};color:${colorOf("@onPrimary", "#fff")}` : "" }, o));
        el.append(seg);
        break;
      }
      case "slot": el.append(slotPreview(pr.name, scope, fg, st)); break;
      default:
        // An element the app knows but this console does not (yet): a labelled box.
        if (!DRAWN.has(node.el) && !def?.container) el.append(h("div", { class: "and-unknown" }, iconEl(elIcon(node.el), 14, "currentColor"), def ? def.label : node.el));
        break;
    }
    if (bg) css.background = bg;
    if (radius !== null && radius !== undefined) { css.borderRadius = `${radius}px`; css.overflow = css.overflow || "hidden"; }
    css.color = fg;
    if (node.on && node.on.click) css.cursor = "pointer";
    const kids = node.children || [];
    for (const k of kids) el.append(preview(k, scope, node.el, fg, live));
    // An empty container stays big enough to drop into while designing.
    if (live && !kids.length && (def?.container)) { el.classList.add("and-empty"); el.append(h("span", { class: "and-empty__hint" }, "Drop elements here")); }
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
    const sub = (id, s) => (design.screens[id] ? preview(design.screens[id], s, "column", fg, false) : h("div", { class: "and-ph" }, id));
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
      case "roomList": for (const room of (scope.rooms || sampleFor("rooms").rooms || [])) wrap.append(sub("rooms.item", { room })); break;
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
        if (scope.users && scope.users.open === false) break;
        const u = sampleFor("users");
        const panel = sub("users", u);
        panel.style.width = "264px"; // UserPanel: 264 dp
        wrap.append(h("div", { class: "and-panel" }, panel), h("div", { class: "and-handle" }, sub("users.handle", sampleFor("users.handle"))));
        wrap.classList.add("and-overlay");
        break;
      }
      case "userList": for (const user of (scope.users || sampleFor("users").users || [])) wrap.append(sub("users.item", { user })); break;
      case "callControls": wrap.append(h("div", { class: "and-call" }, ...[["mic", "#ffffff33"], ["video", "#ffffff33"], ["phone-off", colorOf("@danger", "#dc2626")]].map(([i, c]) => h("span", { style: `background:${c}` }, iconEl(i, 24, "#fff"))))); break;
      default: wrap.append(h("div", { class: "and-ph" }, (catalog.slots.find((s) => s.name === name) || { label: name || "?" }).label));
    }
    return wrap;
  }

  /* ------------------------------------------------------- tree helpers */

  const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;
  const COLOR_RE = /^(@[A-Za-z]+|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/;
  // JSON with sorted keys: a saved screen equals the default whatever order its keys come in.
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
  const isModified = (id) => { const d = catalog.defaults && catalog.defaults.screens && catalog.defaults.screens[id]; return Boolean(d) && canon(design.screens[id]) !== canon(d); };

  function findNode(node, id, parent = null) {
    if (!node) return null;
    if (node.id === id) return { node, parent };
    for (const k of node.children || []) { const f = findNode(k, id, node); if (f) return f; }
    return null;
  }
  function pathTo(node, id) {
    if (!node) return null;
    if (node.id === id) return [node];
    for (const k of node.children || []) { const p = pathTo(k, id); if (p) return [node, ...p]; }
    return null;
  }
  function allIds(node, out = new Set()) { if (!node) return out; out.add(node.id); for (const k of node.children || []) allIds(k, out); return out; }
  const countNodes = (node) => (node ? 1 + (node.children || []).reduce((s, k) => s + countNodes(k), 0) : 0);
  const nextId = (f) => { const kids = f.parent ? f.parent.children : []; const i = kids.indexOf(f.node); return kids[i + 1] ? kids[i + 1].id : null; };

  /** An id the screen does not use yet, from a base (an element or an older id). */
  function freshId(base, ids) {
    const stem = String(base || "el").toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+/, "").replace(/-\d+$/, "").slice(0, 34) || "el";
    let i = 1;
    let id;
    do { id = `${stem}-${i++}`; } while (ids.has(id));
    ids.add(id);
    return id;
  }
  /** Gives a copied subtree ids the screen does not use (keeping those it can). */
  function renumber(node, ids) {
    node.id = typeof node.id === "string" && ID_RE.test(node.id) && !ids.has(node.id) ? node.id : freshId(typeof node.id === "string" && ID_RE.test(node.id) ? node.id : node.el, ids);
    ids.add(node.id);
    if (Array.isArray(node.children)) { node.children = node.children.filter((k) => k && typeof k === "object" && typeof k.el === "string"); node.children.forEach((k) => renumber(k, ids)); if (!node.children.length) delete node.children; }
    else delete node.children;
    return node;
  }
  /** Puts `node` into `parent` before the child `before` (null: at the end). */
  function insertInto(parent, node, before) {
    const kids = parent.children || (parent.children = []);
    const i = before ? kids.findIndex((k) => k.id === before) : -1;
    kids.splice(i < 0 ? kids.length : i, 0, node);
  }
  function detach(rootNode, id) {
    const f = findNode(rootNode, id);
    if (!f || !f.parent) return null;
    f.parent.children = f.parent.children.filter((k) => k !== f.node);
    if (!f.parent.children.length) delete f.parent.children;
    return f.node;
  }

  const EL_ICONS = { column: "rows-2", row: "columns-2", stack: "layers", scroll: "scroll-text", card: "square", text: "type", icon: "star", image: "image", avatar: "circle-user-round", badge: "tag", chip: "circle-dot", divider: "minus", spacer: "move", progress: "loader", button: "hand", iconButton: "circle-plus", input: "pencil-line", switch: "power", checkbox: "check", slot: "puzzle", select: "chevron-down", slider: "sliders-horizontal", segmented: "layout-template" };
  const elIcon = (el) => EL_ICONS[el] || "circle-dashed";

  /** A new element as the palette makes it: a fresh id and just enough to be seen. */
  function freshNode(el, ids, slot) {
    const def = elDef(el) || { props: [], text: false, container: false };
    const node = { id: freshId(el === "slot" && slot ? slot : el, ids), el };
    const has = (p) => def.props.some((x) => x.name === p);
    if (def.text) node.text = { button: "Button", chip: "Chip", badge: "1", switch: "Switch", checkbox: "Checkbox" }[el] || "Text";
    const props = {};
    if ((el === "icon" || el === "iconButton") && has("icon")) props.icon = "circle";
    if (el === "slot") props.name = slot || (catalog.slots.find((s) => (s.screens || []).includes(screenId)) || catalog.slots[0]).name;
    if (has("bind") && ["select", "slider", "segmented"].includes(el)) props.bind = el === "slider" ? "level" : "choice";
    if (has("options")) props.options = "One|Two|Three";
    if (el === "slider") { if (has("min")) props.min = 0; if (has("max")) props.max = 100; }
    if (Object.keys(props).length) node.props = props;
    const style = { row: { gap: 8, align: "center" }, column: { gap: 8 }, card: { padding: 16, gap: 8 } }[el];
    if (style) node.style = { ...style };
    return node;
  }

  /* ------------------------------------------------- inspector widgets */

  let uidSeq = 0;
  const uid = (p) => `and-${p}-${++uidSeq}`;
  const trunc = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const checkTpl = (v) => (v.startsWith("=") ? X.check(v.slice(1)) : X.checkTemplate(v));
  const checkCond = (v) => (v.trim() ? X.check(v) : null);
  const checkExprProp = (v) => (v.trim() ? X.check(v.trim().replace(/^=/, "")) : null);
  function peek(v) {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return `a list of ${v.length}`;
    if (typeof v === "object") return "an object";
    return trunc(typeof v === "string" ? JSON.stringify(v) : String(v));
  }
  const previewExpr = (scope) => (v) => { try { return `= ${peek(X.eval(v.trim().replace(/^=/, ""), scope, t))}`; } catch { return ""; } };
  const previewTpl = (scope) => (v) => {
    if (!v.includes("{") && !v.startsWith("=")) return "";
    try { return `→ ${v.startsWith("=") ? peek(X.eval(v.slice(1), scope, t)) : trunc(X.render(v, scope, t))}`; } catch { return ""; }
  };

  const fld = (label, control, hint, extra) => h("div", { class: "and-f" }, h("div", { class: "and-f__head" }, h("span", { class: "label" }, label), extra || null), control, hint ? h("div", { class: "muted small" }, hint) : null);

  /** A text field that checks what is typed (the error inline) and shows what it gives with the sample data. */
  function textField(o) {
    const i = h(o.area ? "textarea" : "input", { class: `input input--sm${o.mono ? " mono" : ""}`, rows: o.area ? "2" : undefined, placeholder: o.placeholder || "", "aria-label": o.label, disabled: o.ro || undefined, spellcheck: "false", autocomplete: "off" });
    i.value = o.value === undefined || o.value === null ? "" : String(o.value);
    const msg = h("div", { class: "and-msg", id: uid("msg"), "aria-live": "polite" });
    i.setAttribute("aria-describedby", msg.id);
    const show = () => {
      const err = o.check ? o.check(i.value) : null;
      i.classList.toggle("is-bad", Boolean(err));
      i.setAttribute("aria-invalid", err ? "true" : "false");
      msg.className = `and-msg${err ? " is-bad" : ""}`;
      msg.textContent = err || (o.preview && i.value ? o.preview(i.value) : "");
      return err;
    };
    i.addEventListener("input", () => { if (!show()) o.onValue(o.parse ? o.parse(i.value) : i.value); });
    show();
    return h("div", { class: "and-fx" }, i, msg);
  }

  /** A number with − / + (and ↑ ↓ in the field, Shift for 10 steps). */
  function numW(o) {
    const step = o.step || 1;
    const i = h("input", { class: "input input--sm", inputmode: "decimal", "aria-label": o.label, placeholder: o.placeholder || "—", disabled: o.ro || undefined, autocomplete: "off" });
    i.value = o.value === undefined || o.value === null ? "" : String(o.value);
    const msg = h("div", { class: "and-msg", id: uid("msg") });
    i.setAttribute("aria-describedby", msg.id);
    const apply = () => {
      const s = i.value.trim();
      const err = s === "" || /^-?\d+(\.\d+)?$/.test(s) ? null : "a number";
      i.classList.toggle("is-bad", Boolean(err));
      i.setAttribute("aria-invalid", err ? "true" : "false");
      msg.className = `and-msg${err ? " is-bad" : ""}`;
      msg.textContent = err || "";
      if (!err) o.onValue(s === "" ? undefined : Number(s));
    };
    const bump = (d) => {
      let v = Math.round(((Number(i.value) || 0) + d * step) * 1000) / 1000;
      if (o.min !== undefined) v = Math.max(o.min, v);
      if (o.max !== undefined) v = Math.min(o.max, v);
      i.value = String(v);
      apply();
    };
    i.addEventListener("input", apply);
    i.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); bump((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1)); } });
    const btn = (d, sign) => h("button", { type: "button", class: "btn btn--xs", tabindex: "-1", "aria-label": `${o.label} ${d > 0 ? "more" : "less"}`, disabled: o.ro || undefined, onclick: () => bump(d) }, sign);
    return h("div", { class: "and-fx" }, h("div", { class: "and-num" }, btn(-1, "−"), i, btn(1, "+")), msg);
  }

  function selectW(o) {
    const opts = (o.options || []).map((x) => (Array.isArray(x) ? x : [x, x]));
    const cur = o.value === undefined || o.value === null ? "" : String(o.value);
    const s = h("select", { class: "input input--sm", "aria-label": o.label, disabled: o.ro || undefined },
      h("option", { value: "" }, o.empty || "—"), ...opts.map(([v, l]) => h("option", { value: v }, l)));
    if (cur && !opts.some(([v]) => v === cur)) s.append(h("option", { value: cur }, `${cur} (other)`));
    s.value = cur;
    s.addEventListener("change", () => o.onValue(s.value === "" ? undefined : o.parse ? o.parse(s.value) : s.value));
    return s;
  }

  function boolW(o) {
    const cb = h("input", { type: "checkbox", "aria-label": o.label, disabled: o.ro || undefined });
    cb.checked = o.value === true || o.value === "true";
    cb.addEventListener("change", () => o.onValue(cb.checked ? true : undefined));
    return h("label", { class: "and-checkrow" }, cb, h("span", {}, o.text || "yes"));
  }

  /** match / wrap / a fixed size in dp. */
  function sizeW(o) {
    const mode = o.value === "match" || o.value === "wrap" ? o.value : o.value === undefined || o.value === "" ? "" : "dp";
    const num = numW({ ...o, label: `${o.label} in dp`, value: mode === "dp" ? o.value : "", min: 0, onValue: (v) => o.onValue(v) });
    num.hidden = mode !== "dp";
    const sel = selectW({ ...o, value: mode, options: [["match", "fill (match)"], ["wrap", "content (wrap)"], ["dp", "fixed (dp)"]], onValue: (v) => {
      num.hidden = v !== "dp";
      if (v !== "dp") { o.onValue(v); return; }
      const i = num.querySelector("input");
      if (!i.value) i.value = "100";
      o.onValue(Number(i.value) || 100);
      i.focus();
    } });
    return h("div", { class: "and-pair" }, sel, num);
  }

  /** Padding / margin: 12, "8 16" or "8 16 8 16" (dp). */
  const boxW = (o) => textField({ ...o, mono: true, placeholder: "8 · 8 16 · 8 16 8 16", check: (v) => (!v.trim() || /^-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){0,3}$/.test(v.trim()) ? null : "one to four numbers (dp)"), parse: (v) => (v.trim() === "" ? undefined : /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v.trim().replace(/\s+/g, " ")) });

  /** The hex colour a value shows as (for the colour picker). */
  function hex6(v) {
    let s = String(v || "");
    if (s.startsWith("@")) s = (design.theme[previewDark ? "dark" : "light"] || {})[s.slice(1)] || "";
    if (/^#[0-9a-f]{8}$/i.test(s)) return `#${s.slice(3)}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : "#000000";
  }

  /** A colour: a theme token, a custom colour (keeping the alpha of #aarrggbb), or an expression. */
  function colorW(o) {
    const v0 = o.value === undefined || o.value === null ? "" : String(o.value);
    const tok = h("select", { class: "input input--sm", "aria-label": `${o.label}: theme colour`, disabled: o.ro || undefined },
      h("option", { value: "" }, "—"), ...catalog.colors.map((c) => h("option", { value: `@${c}` }, `@${c}`)), h("option", { value: "#" }, "custom colour"), o.noExpr ? null : h("option", { value: "=" }, "expression"));
    const pick = h("input", { type: "color", class: "and-swatch", "aria-label": `${o.label}: custom colour`, disabled: o.ro || undefined });
    let input = null;
    const sync = (v, toText) => {
      tok.value = !v ? "" : v.startsWith("=") ? "=" : v.startsWith("@") && catalog.colors.includes(v.slice(1)) ? v : "#";
      pick.value = hex6(v);
      if (toText && input) { input.value = v; input.dispatchEvent(new Event("input")); }
    };
    const txt = textField({ ...o, value: v0, mono: true, placeholder: o.noExpr ? "@token · #rrggbb" : "@token · #rrggbb · =expression",
      check: (v) => (!v ? null : v.startsWith("=") && !o.noExpr ? X.check(v.slice(1)) : COLOR_RE.test(v) ? null : "@token, #rrggbb or #aarrggbb" + (o.noExpr ? "" : " or =expression")),
      onValue: (v) => { sync(v, false); o.onValue(v || undefined); } });
    input = txt.querySelector("input");
    tok.addEventListener("change", () => {
      if (tok.value === "=") { input.value = "="; input.focus(); return; }
      sync(tok.value === "#" ? pick.value : tok.value, true);
    });
    pick.addEventListener("input", () => { const cur = input.value; sync(/^#[0-9a-f]{8}$/i.test(cur) ? `#${cur.slice(1, 3)}${pick.value.slice(1)}` : pick.value, true); });
    sync(v0, false);
    return h("div", { class: "and-colorw" }, h("div", { class: "and-colorw__row" }, pick, tok), txt);
  }

  /** "1 @border": a width and a colour. */
  function borderW(o) {
    const parts = o.value === undefined || o.value === null ? [] : String(o.value).split(/\s+/);
    let w = parts[0] || "";
    let c = parts[1] || "";
    const emit = () => o.onValue(w === "" && !c ? undefined : `${w || 1} ${c || "@border"}`);
    return h("div", { class: "and-fx" },
      numW({ ...o, label: `${o.label} width`, value: w, min: 0, onValue: (v) => { w = v === undefined ? "" : String(v); emit(); } }),
      colorW({ ...o, label: `${o.label} colour`, value: c, noExpr: true, onValue: (v) => { c = v || ""; emit(); } }));
  }

  /** An icon from the catalog, chosen in the picker (with search). */
  function iconW(o) {
    const cur = typeof o.value === "string" ? o.value : "";
    const b = h("button", { type: "button", class: "btn btn--sm and-iconw", "aria-label": `${o.label}: ${cur || "none"}, choose an icon`, disabled: o.ro || undefined },
      cur ? iconEl(cur, 16, "currentColor") : null, h("span", {}, cur || "choose…"));
    b.addEventListener("click", () => Kit.openIconPicker({ icons: catalog.icons, current: cur, optional: true, noneLabel: "none", onPick: (name) => {
      o.onValue(name || undefined);
      const nb = iconW({ ...o, value: name });
      b.replaceWith(nb);
      nb.focus();
    } }));
    return b;
  }

  function imageW(o) {
    const list = h("datalist", { id: uid("assets") }, ...Object.keys(design.assets).map((a) => h("option", { value: `asset:${a}` })));
    const f = textField({ ...o, mono: true, placeholder: "asset:<name> or https://…", check: (v) => (!v ? null : v.startsWith("=") ? X.check(v.slice(1)) : /^(asset:[A-Za-z0-9._-]{1,60}|https:\/\/[^\s"'<>]{4,500})$/.test(v) ? null : "asset:<name> or an https URL") });
    f.querySelector("input").setAttribute("list", list.id);
    f.append(list);
    return f;
  }

  /** A widget — or, with ƒx, an expression "=…" in its place. Returns { box, btn }. */
  function exprable(o, widget) {
    const box = h("div", { class: "and-xw" });
    let on = typeof o.value === "string" && o.value.startsWith("=");
    const set = (v) => { o.value = v; o.onValue(v); };
    const btn = h("button", { type: "button", class: "and-xbtn", title: "Compute it with an expression (=…)", "aria-label": `${o.label}: use an expression`, "aria-pressed": "false", disabled: o.ro || undefined }, "ƒx");
    const draw = () => {
      btn.setAttribute("aria-pressed", String(on));
      clear(box).append(on
        ? textField({ ...o, value: typeof o.value === "string" && o.value.startsWith("=") ? o.value : "=", mono: true, placeholder: "=expression", check: (v) => (v.startsWith("=") ? X.check(v.slice(1)) : "start with ="), preview: previewExpr(o.scope), onValue: set })
        : widget({ ...o, onValue: set }));
    };
    btn.addEventListener("click", () => { on = !on; draw(); const f = box.querySelector("input, select, button"); if (f) f.focus(); });
    draw();
    return { box, btn };
  }

  // How each style property is edited (anything else: a checked text field).
  const STYLE_UI = {
    padding: { kind: "box" }, margin: { kind: "box" }, gap: { kind: "num", min: 0 }, width: { kind: "size" }, height: { kind: "size" },
    maxWidth: { kind: "num", min: 0 }, weight: { kind: "num", min: 0 },
    align: { kind: "sel", options: ["start", "center", "end", "stretch"] }, justify: { kind: "sel", options: ["start", "center", "end", "between", "around"] }, self: { kind: "sel", options: ["start", "center", "end", "stretch"] },
    bg: { kind: "color" }, fg: { kind: "color" }, radius: { kind: "num", min: 0 }, border: { kind: "border" }, elevation: { kind: "num", min: 0 },
    size: { kind: "num", min: 1 }, bold: { kind: "bool3" }, italic: { kind: "bool3" }, font: { kind: "sel", options: ["sans", "serif", "mono"] },
    lines: { kind: "num", min: 1 }, opacity: { kind: "num", min: 0, max: 1, step: 0.05 },
  };
  const LAYOUT_STYLE = new Set(["padding", "margin", "gap", "width", "height", "maxWidth", "weight", "align", "justify", "self"]);

  function styleField(s, n, ctx) {
    const ui = STYLE_UI[s.name] || { kind: "text" };
    const o = { label: s.label, value: n.style ? n.style[s.name] : undefined, ro: ctx.ro, scope: ctx.scope, onValue: (v) => ctx.edit(`style.${s.name}`, () => {
      n.style = n.style || {};
      if (v === undefined || v === "") delete n.style[s.name]; else n.style[s.name] = v;
      if (!Object.keys(n.style).length) delete n.style;
    }) };
    if (ui.kind === "color") return fld(s.label, colorW(o), s.help);
    const widget = {
      num: (x) => numW({ ...x, min: ui.min, max: ui.max, step: ui.step }),
      sel: (x) => selectW({ ...x, options: ui.options }),
      bool3: (x) => selectW({ ...x, value: x.value === undefined ? "" : String(x.value), options: [["true", "yes"], ["false", "no"]], parse: (v) => v === "true" }),
      size: sizeW, box: boxW, border: borderW,
      text: (x) => textField({ ...x, mono: true, placeholder: s.help, parse: (v) => (v === "" ? undefined : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "true" || v === "false" ? v === "true" : v) }),
    }[ui.kind];
    const x = exprable(o, widget);
    return fld(s.label, x.box, s.help, x.btn);
  }

  function slotW(o, here) {
    const cur = o.value === undefined ? "" : String(o.value);
    const mine = catalog.slots.filter((s) => (s.screens || []).includes(here));
    const other = catalog.slots.filter((s) => !(s.screens || []).includes(here));
    const opt = (s) => h("option", { value: s.name }, `${s.label} (${s.name})`);
    const sel = h("select", { class: "input input--sm", "aria-label": o.label, disabled: o.ro || undefined },
      mine.length ? h("optgroup", { label: "On this screen" }, ...mine.map(opt)) : null, other.length ? h("optgroup", { label: "Other screens" }, ...other.map(opt)) : null);
    if (cur && !catalog.slots.some((s) => s.name === cur)) sel.append(h("option", { value: cur }, `${cur} (unknown)`));
    sel.value = cur;
    sel.addEventListener("change", () => o.onValue(sel.value));
    return sel;
  }

  function propField(p, n, ctx) {
    const o = { label: p.label, value: n.props ? n.props[p.name] : undefined, ro: ctx.ro, scope: ctx.scope, onValue: (v) => ctx.edit(`props.${p.name}`, () => {
      n.props = n.props || {};
      if (v === undefined || v === "") delete n.props[p.name]; else n.props[p.name] = v;
      if (!Object.keys(n.props).length) delete n.props;
    }, p.kind === "slot") };
    const str = o.value === undefined || o.value === null ? "" : String(o.value);
    const ex = (widget) => { const x = exprable(o, widget); return fld(p.label, x.box, p.help, x.btn); };
    switch (p.kind) {
      case "bool": return fld(p.label, boolW(o), p.help);
      case "select": return ex((x) => selectW({ ...x, options: p.options || [] }));
      case "slot": return fld(p.label, slotW(o, screenId), p.help);
      case "icon": return ex(iconW);
      case "color": return fld(p.label, colorW(o), p.help);
      case "number": return ex(numW);
      case "image": return fld(p.label, imageW(o), p.help);
      case "expr": return fld(p.label, textField({ ...o, value: str, mono: true, placeholder: "an expression, e.g. $room.selected", check: checkExprProp, preview: previewExpr(ctx.scope) }), p.help);
      default: return fld(p.label, textField({ ...o, value: str, check: checkTpl, preview: previewTpl(ctx.scope), placeholder: "text, {$var}, {_'key'} or =expression" }), p.help);
    }
  }

  // Suggestions for an action's argument (typed freely all the same).
  const ARG_HINTS = {
    "screen.open": () => catalog.screens.filter((s) => s.group !== "parts").map((s) => s.id),
    "menu.open": () => Object.keys(design.menus), "lib.run": () => Object.keys(design.libraries), "lang.set": () => catalog.langs,
    "users.dock": () => ["none", "left", "right", "bottom"], "users.autoHide": () => ["true", "false"],
  };

  function eventField(ev, n, ctx) {
    const cur = n.on ? n.on[ev] : undefined;
    const groups = new Map();
    for (const a of catalog.actions) { const g = a.action.includes(".") ? a.action.split(".")[0] : "general"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
    const sel = h("select", { class: "input input--sm", "aria-label": `On ${ev}: action`, disabled: ctx.ro || undefined }, h("option", { value: "" }, "— nothing —"),
      ...[...groups].map(([g, list]) => h("optgroup", { label: g }, ...list.map((a) => h("option", { value: a.action, title: a.help }, a.action)))));
    sel.value = cur ? cur.action : "";
    if (cur && !sel.value) { sel.append(h("option", { value: cur.action }, `${cur.action} (unknown)`)); sel.value = cur.action; }
    const def = catalog.actions.find((a) => a.action === sel.value);
    sel.addEventListener("change", () => {
      ctx.edit(`on.${ev}`, () => {
        n.on = n.on || {};
        if (!sel.value) delete n.on[ev]; else n.on[ev] = { action: sel.value, ...(cur && cur.arg ? { arg: cur.arg } : {}) };
        if (!Object.keys(n.on).length) delete n.on;
      }, true);
      ctx.redraw();
    });
    let arg = null;
    if (cur && ((def && def.arg) || cur.arg)) {
      const hints = (ARG_HINTS[cur.action] || (() => (def && /room key/.test(def.arg) ? ["=$room.key"] : def && /message id/.test(def.arg) ? ["=$msg.id"] : [])))();
      arg = textField({ label: `On ${ev}: argument`, value: cur.arg || "", ro: ctx.ro, mono: true, placeholder: (def && def.arg) || "argument", check: checkTpl, preview: previewTpl(ctx.scope),
        onValue: (v) => ctx.edit(`on.${ev}.arg`, () => { if (v) cur.arg = v; else delete cur.arg; }) });
      if (hints.length) { const list = h("datalist", { id: uid("args") }, ...hints.map((x) => h("option", { value: x }))); arg.querySelector("input").setAttribute("list", list.id); arg.append(list); }
    }
    return fld(ev, h("div", { class: "and-fx" }, sel, arg), def ? `${def.help}${def.arg ? ` · argument: ${def.arg}` : ""}` : null);
  }

  // The enter animation, played in the preview on request (Web Animations, no CSS injected).
  const ANIM_FRAMES = {
    fade: [{ opacity: 0 }, { opacity: 1 }],
    "slide-up": [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }],
    "slide-down": [{ opacity: 0, transform: "translateY(-24px)" }, { opacity: 1, transform: "none" }],
    "slide-left": [{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }],
    "slide-right": [{ opacity: 0, transform: "translateX(-24px)" }, { opacity: 1, transform: "none" }],
    scale: [{ opacity: 0, transform: "scale(.85)" }, { opacity: 1, transform: "none" }],
    pop: [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1.08)", offset: 0.7 }, { opacity: 1, transform: "none" }],
  };
  const EASE = { standard: "cubic-bezier(.2,0,0,1)", decelerate: "cubic-bezier(0,0,.2,1)", accelerate: "cubic-bezier(.3,0,1,1)", linear: "linear", overshoot: "cubic-bezier(.34,1.56,.64,1)", bounce: "cubic-bezier(.68,-.55,.27,1.55)" };

  /** Quick sample states: flip a flag, empty a list, show an error. */
  function quickStates(base) {
    const out = [];
    const walk = (obj, path, depth) => {
      for (const [k, v] of Object.entries(obj || {})) {
        if (!path.length && k === "app") continue;
        const p = [...path, k];
        const name = p.join(".");
        if (typeof v === "boolean") out.push({ path: p, base: v, alt: !v, label: `${name}: ${!v}` });
        else if (Array.isArray(v) && v.length) out.push({ path: p, base: v, alt: [], label: `${name}: empty` });
        else if (/error/i.test(k) && typeof v === "string") out.push({ path: p, base: v, alt: v ? "" : "Something went wrong.", label: v ? `${name}: none` : `${name}: shown` });
        else if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) walk(v, p, depth + 1);
      }
    };
    walk(base, [], 0);
    return out.slice(0, 14);
  }
  const getPath = (o, p) => p.reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
  function setPath(o, p, v) { let x = o; for (const k of p.slice(0, -1)) { if (!x[k] || typeof x[k] !== "object") x[k] = {}; x = x[k]; } x[p[p.length - 1]] = structuredClone(v); }

  /* ----------------------------------------------------- screen editor */

  const DEVICES = [
    { id: "compact", label: "Compact 360 × 740", w: 360, h: 740 },
    { id: "tall", label: "Tall 412 × 915", w: 412, h: 915 },
    { id: "fold", label: "Foldable open 673 × 841", w: 673, h: 841 },
    { id: "tablet", label: "Tablet 800 × 1280", w: 800, h: 1280 },
  ];
  const view = { device: "compact", landscape: false, zoom: 0, overview: false };
  const collapsed = new Set(); // "screen/node" folded in the layers
  const inspOpen = { element: true, params: true, layout: true, style: false, anim: false, logic: false, events: true };
  let clip = null; // the copied element (JSON)
  let drag = null; // what is dragged: { add: el, slot? } from the palette or { move: id }

  function screensEditor(body) {
    const ro = !may("builds");
    if (!design.screens[screenId]) screenId = Object.keys(design.screens)[0];
    const tree = () => design.screens[screenId];
    const fkey = (id) => `${screenId}/${id}`;

    /* layout */
    const pick = h("select", { class: "input input--sm", "aria-label": "Screen", "data-read": "1" });
    const overBtn = iconBtn("layout-grid", "All screens", () => { view.overview = !view.overview; showMode(); }, { "data-read": "1", "aria-pressed": "false", text: "All screens" });
    const dfltBtn = ro ? null : iconBtn("rotate-ccw", "Put this screen back to the built-in one", () => resetScreen(), { text: "Default" });
    const info = h("div", { class: "and-scrbar__info muted small" });
    const grid = h("div", { class: "and-ed" });
    const over = h("div", { class: "and-over", hidden: true });
    body.append(h("div", { class: "and-scrbar" }, pick, overBtn, dfltBtn, info), grid, over);

    const palSearch = h("input", { class: "input input--sm", type: "search", placeholder: "Search elements…", "aria-label": "Search elements", "data-read": "1" });
    const palList = h("div", { class: "and-pal" });
    const outline = h("div", { class: "and-outline", role: "tree", "aria-label": "Layers of the screen" });
    const treeBox = h("div", { class: "and-layers__box" }, outline);
    const left = h("div", { class: "and-ed__left" },
      h("div", { class: "card stack" }, h("div", { class: "and-pal__head" }, "Elements"), ro ? h("div", { class: "muted small" }, "Your access does not include design changes.") : palSearch, ro ? null : palList),
      h("div", { class: "card and-layers" }, h("div", { class: "and-layers__head" }, "Layers"), treeBox));
    const mid = h("div", { class: "and-ed__phone" });
    const right = h("div", { class: "card and-ed__insp", role: "region", "aria-label": "Inspector" });
    grid.append(left, mid, right);

    // the phone: device bar, stage (phone + overlays + toolbar), note, sample data
    const devSel = h("select", { class: "input input--sm", "aria-label": "Device", "data-read": "1" }, ...DEVICES.map((d) => h("option", { value: d.id }, d.label)));
    const rotBtn = iconBtn("rotate-ccw", "Portrait / landscape", () => { view.landscape = !view.landscape; applyDevice(); }, { "data-read": "1", "aria-pressed": "false" });
    const zoomIn = h("input", { type: "range", min: "50", max: "150", step: "5", "aria-label": "Zoom", "data-read": "1" });
    const zoomOut = h("output", {});
    const fitBtn = iconBtn("maximize-2", "Fit the phone to the space", () => { view.zoom = fitZoom(); applyDevice(); }, { "data-read": "1" });
    const tone = h("select", { class: "input input--sm", "aria-label": "Light or dark", "data-read": "1" }, h("option", { value: "light" }, "light"), h("option", { value: "dark" }, "dark"));
    const lang = h("select", { class: "input input--sm", "aria-label": "Language", "data-read": "1" }, ...catalog.langs.map((l) => h("option", { value: l }, l)));
    const playBtn = iconBtn("play", "Play the enter animations", () => play(null), { "data-read": "1" });
    const note = h("div", { class: "and-note", role: "status" });
    const screenEl = h("div", { class: "and-screen" });
    const phone = h("div", { class: "and-phone" }, screenEl);
    const ov = h("div", { class: "and-ov" });
    const ovSel = h("div");
    const ovHov = h("div");
    const ovDrop = h("div");
    ov.append(ovSel, ovHov, ovDrop);
    const tb = h("div", { class: "and-tb", role: "toolbar", "aria-label": "Selected element", hidden: true });
    const stage = h("div", { class: "and-stage", role: "region", "aria-label": "Phone preview: click to select, double-click a text to edit it, drag to move" }, phone, ov, tb);
    const sampleTag = badge("edited", "info");
    const sampleBody = h("div", { class: "and-sample__body" });
    const sample = h("details", { class: "and-sample" }, h("summary", {}, "Sample data (preview states)", sampleTag), sampleBody);
    mid.append(h("div", { class: "and-devbar" }, devSel, rotBtn, h("label", { class: "and-zoom" }, zoomIn, zoomOut), fitBtn, tone, lang, playBtn), note, stage, sample);

    const alive = () => grid.isConnected;
    let hovEl = null;
    let tbFor = null;
    let inline = null;
    let soonTimer = 0;
    let soonTree = false;

    /* ------------------------------------------------ screens and modes */

    function drawPick() {
      clear(pick);
      for (const g of [...new Set(["system", "app", "room", "parts", ...catalog.screens.map((s) => s.group)])]) {
        const list = catalog.screens.filter((x) => x.group === g);
        if (list.length) pick.append(h("optgroup", { label: g }, ...list.map((s) => h("option", { value: s.id }, `${isModified(s.id) ? "● " : ""}${s.label} (${s.id})`))));
      }
      pick.value = screenId;
    }
    function drawInfo() {
      const s = catalog.screens.find((x) => x.id === screenId);
      clear(info).append(h("span", {}, s ? s.help : "", " · ", h("span", { class: "mono" }, (s ? s.vars : []).join(" ")), isModified(screenId) ? [" · ", badge("changed", "warn")] : null));
      if (dfltBtn) dfltBtn.disabled = !isModified(screenId);
      const opt = [...pick.options].find((x) => x.value === screenId);
      if (opt && s) opt.textContent = `${isModified(screenId) ? "● " : ""}${s.label} (${s.id})`;
    }
    pick.addEventListener("change", () => switchScreen(pick.value));
    function switchScreen(id) {
      closeInline();
      screenId = id;
      selected = "";
      hist.key = null;
      pick.value = id;
      if (view.overview) { view.overview = false; showMode(); }
      drawInfo(); drawPalette(); drawTree(); drawScreen(); drawInspector(); drawSample();
    }
    function resetScreen() {
      const d = catalog.defaults && catalog.defaults.screens && catalog.defaults.screens[screenId];
      if (!d || !confirm(`Put “${screenId}” back to the built-in screen? (Undo brings your version back.)`)) return;
      design.screens[screenId] = structuredClone(d);
      commit("");
    }
    function showMode() {
      grid.hidden = view.overview;
      over.hidden = !view.overview;
      overBtn.setAttribute("aria-pressed", String(view.overview));
      if (view.overview) drawOverview(); else { clear(over); place(); }
    }

    /** Every screen small, drawn a few at a time so the page stays responsive. */
    function drawOverview() {
      clear(over);
      const fg = colorOf("@onSurface", "#1c2330");
      const s = 0.3;
      const todo = [];
      for (const sc of catalog.screens) {
        const frame = h("div", { class: "and-thumb__frame", style: `width:${380 * s}px;height:${760 * s}px` });
        const card = h("div", { class: `and-thumb${sc.id === screenId ? " is-on" : ""}`, role: "button", tabindex: "0", "aria-label": `Open ${sc.label}${isModified(sc.id) ? " (changed)" : ""}`, "data-read": "1" },
          frame, h("span", { class: "and-thumb__name" }, sc.label), h("span", { class: "mono small muted" }, sc.id), isModified(sc.id) ? badge("changed", "warn") : badge("default", ""));
        card.addEventListener("click", () => { if (design.screens[sc.id]) switchScreen(sc.id); });
        card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchScreen(sc.id); } });
        over.append(card);
        todo.push(() => {
          const scr = h("div", { class: `and-screen${isPart(sc.id) ? " and-screen--part" : ""}` }, design.screens[sc.id] ? preview(design.screens[sc.id], phoneScope(sc.id), "column", fg, false) : h("div", { class: "and-ph" }, "not in this design"));
          frame.append(h("div", { class: "and-phone", style: `transform:scale(${s});background:${colorOf("@background", "#f5f6f8")}` }, scr));
        });
      }
      const next = () => { if (!view.overview || !over.isConnected) return; todo.splice(0, 3).forEach((f) => f()); if (todo.length) requestAnimationFrame(next); };
      requestAnimationFrame(next);
    }

    /* --------------------------------------------------------- palette */

    function drawPalette() {
      if (ro) return;
      clear(palList);
      const q = palSearch.value.trim().toLowerCase();
      const hit = (...s) => !q || s.some((x) => String(x || "").toLowerCase().includes(q));
      const group = (name, tiles, empty) => (tiles.length || (empty && !q) ? h("div", { class: "and-pal__grp", role: "group", "aria-label": name }, h("span", {}, name), tiles.length ? h("div", { class: "and-pal__grid" }, ...tiles) : h("div", { class: "muted small" }, empty)) : null);
      const tile = (what, label, icon, help) => {
        const b = h("button", { type: "button", class: "and-tile", draggable: "true", title: `${help || label} — drag it onto the phone or the layers, or click to add it`, "aria-label": `Add ${label}` }, iconEl(icon, 18, "currentColor"), h("span", {}, label));
        b.addEventListener("dragstart", (e) => startDrag(e, what));
        b.addEventListener("dragend", endDrag);
        b.addEventListener("click", () => addAt(what, spotNearSelection()));
        return b;
      };
      const groups = [];
      for (const g of [...new Set(["layout", "content", "controls", "logic", ...catalog.elements.map((e) => e.group)])]) {
        const items = catalog.elements.filter((e) => e.group === g && e.el !== "slot" && hit(e.el, e.label, e.help));
        groups.push(group(g, items.map((e) => tile({ add: e.el }, e.label, elIcon(e.el), e.help))));
      }
      if (elDef("slot")) {
        const parts = catalog.slots.filter((s) => (s.screens || []).includes(screenId) && hit(s.name, s.label, "part"));
        groups.push(group("App parts", parts.map((s) => tile({ add: "slot", slot: s.name }, s.label.replace(/\s*\(.*\)$/, ""), "puzzle", `App part “${s.name}”: ${s.label}`)), "No app part belongs to this screen."));
      }
      palList.append(...groups.filter(Boolean));
      if (!palList.childNodes.length) palList.append(h("div", { class: "muted small" }, "Nothing matches."));
    }
    let palTimer = 0;
    palSearch.addEventListener("input", () => { clearTimeout(palTimer); palTimer = setTimeout(drawPalette, 120); });

    /* ---------------------------------------------------------- layers */

    const nodeLabel = (n) => n.name || (n.el === "slot" ? `part: ${(n.props && n.props.name) || "?"}` : n.text ? String(n.text).slice(0, 40) : `#${n.id}`);

    function drawTree() {
      const keep = treeBox.scrollTop;
      clear(outline);
      const frag = document.createDocumentFragment();
      const walk = (n, depth, isRoot) => {
        const def = elDef(n.el);
        const kids = n.children || [];
        const fold = collapsed.has(fkey(n.id));
        frag.append(h("div", { class: `and-row${n.id === selected ? " on" : ""}`, role: "treeitem", "aria-level": String(depth + 1), "aria-selected": n.id === selected ? "true" : "false", "aria-expanded": kids.length ? String(!fold) : undefined, tabindex: n.id === selected || (!selected && isRoot) ? "0" : "-1", draggable: ro || isRoot ? undefined : "true", "data-nid": n.id, style: `--depth:${depth}` },
          kids.length ? h("button", { type: "button", class: "and-caret", tabindex: "-1", "aria-label": fold ? "Expand" : "Collapse", "data-read": "1", "data-fold": n.id }, iconEl(fold ? "chevron-right" : "chevron-down", 12, "currentColor")) : h("span", { class: "and-caret" }),
          iconEl(elIcon(n.el), 14, "currentColor"),
          h("span", { class: "and-row__type" }, def ? def.label : n.el),
          h("span", { class: "and-row__label" }, nodeLabel(n)),
          n.if ? badge("if", "") : null, n.each ? badge("each", "") : null, n.on ? badge("on", "info") : null));
        if (!fold) for (const k of kids) walk(k, depth + 1, false);
      };
      walk(tree(), 0, true);
      outline.append(frag);
      treeBox.scrollTop = keep;
    }
    const rowOf = (id) => outline.querySelector(`.and-row[data-nid="${CSS.escape(id)}"]`);
    function markRows() {
      for (const r of outline.querySelectorAll(".and-row.on")) { r.classList.remove("on"); r.setAttribute("aria-selected", "false"); r.tabIndex = -1; }
      const r = selected && rowOf(selected);
      if (r) { r.classList.add("on"); r.setAttribute("aria-selected", "true"); r.tabIndex = 0; }
    }
    /** Unfolds the layers down to an element; true when that changed the tree. */
    function expandTo(id) {
      let changedFold = false;
      for (const n of (pathTo(tree(), id) || []).slice(0, -1)) if (collapsed.delete(fkey(n.id))) changedFold = true;
      return changedFold;
    }
    outline.addEventListener("click", (e) => {
      const fold = e.target.closest("[data-fold]");
      if (fold) { const k = fkey(fold.dataset.fold); if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k); drawTree(); return; }
      const row = e.target.closest(".and-row");
      if (row) select(row.dataset.nid, { phone: true });
    });
    outline.addEventListener("dblclick", (e) => { const row = e.target.closest(".and-row"); if (row) { select(row.dataset.nid); editInline(); } });
    outline.addEventListener("mouseover", (e) => { const row = e.target.closest(".and-row"); if (row && !drag) hoverOn(firstEl(row.dataset.nid)); });
    outline.addEventListener("mouseleave", () => hoverOn(null));

    /* ----------------------------------------------------------- phone */

    function applyDevice() {
      const d = DEVICES.find((x) => x.id === view.device) || DEVICES[0];
      const [w, ht] = view.landscape ? [d.h, d.w] : [d.w, d.h];
      if (!view.zoom) view.zoom = fitZoom();
      const z = view.zoom / 100;
      devSel.value = d.id;
      rotBtn.setAttribute("aria-pressed", String(view.landscape));
      zoomIn.value = String(view.zoom);
      zoomOut.textContent = `${view.zoom} %`;
      phone.style.width = `${w}px`;
      phone.style.height = `${ht}px`;
      phone.style.transform = `scale(${z})`;
      stage.style.width = `${(w + 20) * z}px`;
      stage.style.height = `${(ht + 20) * z}px`;
      Object.assign(ov.style, { left: `${10 * z}px`, top: `${10 * z}px`, width: `${w * z}px`, height: `${ht * z}px`, borderRadius: `${24 * z}px` });
      place();
    }
    /** The zoom (50–150 %, in 5 % steps) at which the phone fits the column and the window. */
    function fitZoom() {
      const d = DEVICES.find((x) => x.id === view.device) || DEVICES[0];
      const [w, ht] = view.landscape ? [d.h, d.w] : [d.w, d.h];
      const aw = Math.max(200, (mid.clientWidth || 400) - 16);
      const ah = Math.max(300, window.innerHeight - Math.max(0, mid.getBoundingClientRect().top) - 120);
      return Math.max(50, Math.min(150, Math.floor((Math.min(aw / (w + 20), ah / (ht + 20)) * 100) / 5) * 5));
    }
    devSel.addEventListener("change", () => { view.device = devSel.value; applyDevice(); });
    zoomIn.addEventListener("input", () => { view.zoom = Number(zoomIn.value); applyDevice(); });
    tone.addEventListener("change", () => { previewDark = tone.value === "dark"; drawScreen(); });
    lang.addEventListener("change", () => { previewLang = lang.value; drawScreen(); });

    function drawScreen() {
      if (!alive()) return;
      closeInline();
      const keep = screenEl.scrollTop;
      tone.value = previewDark ? "dark" : "light";
      lang.value = previewLang;
      let node;
      try { node = preview(tree(), phoneScope(screenId), "column", colorOf("@onSurface", "#1c2330"), true); }
      catch (err) { node = h("div", { class: "err p8" }, `Cannot draw: ${err.message}`); }
      phone.style.background = colorOf("@background", "#f5f6f8");
      screenEl.className = `and-screen${isPart(screenId) ? " and-screen--part" : ""}`;
      clear(screenEl).append(node);
      screenEl.scrollTop = keep;
      hovEl = null;
      clear(ovHov);
      tbFor = null;
      place();
    }
    const firstEl = (id) => (id ? screenEl.querySelector(`[data-nid="${CSS.escape(id)}"]`) : null);
    const lastEl = (id) => { const all = screenEl.querySelectorAll(`[data-nid="${CSS.escape(id)}"]`); return all[all.length - 1] || null; };
    const boxAt = (r, base, cls) => h("div", { class: cls, style: `left:${r.left - base.left}px;top:${r.top - base.top}px;width:${r.width}px;height:${r.height}px` });

    /** The selection boxes and the toolbar, where the selected element is drawn now. */
    function place() {
      if (!alive() || view.overview) return;
      clear(ovSel);
      for (const el of screenEl.querySelectorAll(".and-n[draggable]")) el.removeAttribute("draggable");
      const f = selected ? findNode(tree(), selected) : null;
      const els = f ? [...screenEl.querySelectorAll(`[data-nid="${CSS.escape(selected)}"]`)] : [];
      if (f && !els.length) setNote(`#${selected} is not drawn with this sample data${f.node.if ? ` (if: ${f.node.if})` : ""}.`, true);
      else setNote(ro ? "" : "Drag elements from the palette · double-click a text to edit it");
      if (!els.length) { tb.hidden = true; return; }
      const base = ov.getBoundingClientRect();
      els.slice(0, 40).forEach((el, i) => ovSel.append(boxAt(el.getBoundingClientRect(), base, i ? "and-box and-box--sel2" : "and-box and-box--sel")));
      if (ro) return;
      if (f.parent) for (const el of els) el.setAttribute("draggable", "true");
      if (tbFor !== selected) drawToolbar(f);
      placeToolbar(els[0]);
    }
    screenEl.addEventListener("scroll", () => { hoverOn(null); place(); }, { passive: true });
    /** The line over the phone (a live region: only real changes are announced). */
    function setNote(text, warn) {
      if (note.textContent !== text) note.textContent = text;
      note.classList.toggle("is-warn", Boolean(warn));
    }

    function placeToolbar(el) {
      tb.hidden = false;
      const sr = stage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const tw = tb.offsetWidth;
      const th = tb.offsetHeight;
      // it may rise over the hint line above the phone rather than cover the top of the screen
      const fits = (y) => y >= -28 && y + th <= sr.height;
      const above = r.top - sr.top - th - 6;
      const below = r.bottom - sr.top + 6;
      const top = fits(above) ? above : fits(below) ? below : Math.max(0, Math.min(sr.height - th, r.top - sr.top + 6));
      const leftPx = Math.max(0, Math.min(r.left - sr.left, sr.width - tw));
      tb.style.top = `${top}px`;
      tb.style.left = `${leftPx}px`;
    }

    function drawToolbar(f) {
      tbFor = selected;
      clear(tb);
      const def = elDef(f.node.el) || {};
      const b = (icon, label, fn, cls) => h("button", { type: "button", class: cls || "", title: label, "aria-label": label, onclick: (e) => { e.stopPropagation(); fn(e); } }, iconEl(icon, 15, "currentColor"));
      tb.append(h("span", { class: "and-tb__name" }, `${def.label || f.node.el}`));
      if (f.parent) {
        const grip = h("span", { class: "and-tb__grip", draggable: "true", title: "Drag to move", "aria-hidden": "true" }, iconEl("grip-vertical", 15, "currentColor"));
        grip.addEventListener("dragstart", (e) => startDrag(e, { move: selected }));
        grip.addEventListener("dragend", endDrag);
        tb.append(grip, b("corner-up-left", "Select the parent (Esc)", () => select(f.parent.id, { reveal: true })), b("arrow-up", "Move up (Alt+↑)", () => step(-1)), b("arrow-down", "Move down (Alt+↓)", () => step(1)));
      }
      if (def.text) tb.append(b("pencil", "Edit the text (Enter)", () => editInline()));
      const wrapBtn = b("layers", "Wrap in a row, column or card", (e) => wrapMenu(e.currentTarget));
      wrapBtn.setAttribute("aria-haspopup", "menu");
      wrapBtn.setAttribute("aria-expanded", "false");
      tb.append(wrapBtn);
      if (f.parent) tb.append(h("span", { class: "and-tb__sep" }), b("copy", "Duplicate (Ctrl+D)", duplicate), b("trash", "Delete (Del)", remove, "is-danger"));
    }

    function wrapMenu(btn) {
      const open = tb.querySelector(".and-tb__menu");
      if (open) { open.remove(); btn.setAttribute("aria-expanded", "false"); return; }
      const menu = h("div", { class: "and-tb__menu", role: "menu" }, ...["row", "column", "card"].filter((x) => elDef(x)).map((x) => h("button", { type: "button", role: "menuitem", onclick: (e) => { e.stopPropagation(); wrap(x); } }, iconEl(elIcon(x), 15, "currentColor"), `Wrap in a ${elDef(x).label.toLowerCase()}`)));
      menu.addEventListener("keydown", (e) => {
        const items = [...menu.querySelectorAll("button")];
        const i = items.indexOf(document.activeElement);
        if (e.key === "Escape") { e.stopPropagation(); menu.remove(); btn.setAttribute("aria-expanded", "false"); btn.focus(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
      });
      tb.append(menu);
      btn.setAttribute("aria-expanded", "true");
      menu.querySelector("button").focus();
    }

    function hoverOn(el) {
      if (hovEl === el) return;
      hovEl = el;
      clear(ovHov);
      if (!el || drag || !alive()) return;
      const n = findNode(tree(), el.dataset.nid);
      const box = boxAt(el.getBoundingClientRect(), ov.getBoundingClientRect(), "and-box and-box--hov");
      box.append(h("span", {}, `${n ? (elDef(n.node.el) || { label: n.node.el }).label : "?"} #${el.dataset.nid}`));
      if (parseFloat(box.style.top) < 16) box.classList.add("is-in");
      ovHov.append(box);
    }
    screenEl.addEventListener("mouseover", (e) => { if (!drag) hoverOn(e.target.closest ? e.target.closest("[data-nid]") : null); });
    screenEl.addEventListener("mouseleave", () => hoverOn(null));
    screenEl.addEventListener("click", (e) => { const el = e.target.closest("[data-nid]"); select(el ? el.dataset.nid : tree().id, { tree: true }); });
    screenEl.addEventListener("dblclick", (e) => { const el = e.target.closest("[data-nid]"); if (!el) return; select(el.dataset.nid, { tree: true }); editInline(el); });
    screenEl.addEventListener("dragstart", (e) => {
      const el = e.target.closest ? e.target.closest("[data-nid]") : null;
      if (!el || ro || el.dataset.nid !== selected || el.dataset.nid === tree().id) { e.preventDefault(); return; }
      startDrag(e, { move: selected });
    });
    screenEl.addEventListener("dragend", endDrag);

    /** Scrolls a container just enough to show an element (the phone's scale taken into account). */
    function nearest(container, el, scale = 1) {
      if (!el) return;
      const c = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < c.top) container.scrollTop -= (c.top - r.top) / scale + 8;
      else if (r.bottom > c.bottom) container.scrollTop += (Math.min(r.bottom - c.bottom, r.top - c.top)) / scale + 8;
    }

    /** Plays enter animations: of the given elements, or of all that have one. */
    function play(ids) {
      const list = ids || [...allIds(tree())];
      for (const id of list) {
        const f = findNode(tree(), id);
        const a = f && f.node.anim && f.node.anim.enter;
        if (!a) continue;
        for (const el of screenEl.querySelectorAll(`[data-nid="${CSS.escape(id)}"]`)) {
          el.animate(ANIM_FRAMES[a.type] || ANIM_FRAMES.fade, { duration: a.ms ?? 300, delay: a.delay ?? 0, easing: EASE[a.easing] || EASE.standard, fill: "backwards" });
        }
      }
    }

    /* ------------------------------------------------ inline text edit */

    function closeInline() { if (inline) inline(false); }
    /** Edits a text element's template right over it in the phone: Enter keeps it, Esc drops it. */
    function editInline(target) {
      if (ro) return;
      const f = selected ? findNode(tree(), selected) : null;
      if (!f || !(elDef(f.node.el) || {}).text) return;
      // A redraw still due from the inspector would close the editor at once: draw now.
      if (soonTimer) { clearTimeout(soonTimer); flushSoon(); target = null; }
      const el = target || firstEl(selected);
      if (!el) return;
      closeInline();
      const sr = stage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const z = view.zoom / 100;
      const ta = h("textarea", { class: "and-inline", "aria-label": `Text of #${selected}: {$var}, {_'key'}, {=expression}`, spellcheck: "false" });
      ta.value = f.node.text || "";
      Object.assign(ta.style, { left: `${Math.max(0, r.left - sr.left - 4)}px`, top: `${Math.max(0, r.top - sr.top - 4)}px`, width: `${Math.max(r.width + 8, 160)}px`, height: `${Math.max(r.height + 8, 34)}px`, fontSize: `${Math.max(11, Math.min(18, parseFloat(getComputedStyle(el).fontSize) * z))}px` });
      const err = h("div", { class: "and-inline__err", hidden: true, style: `left:${ta.style.left};top:${Math.max(0, r.bottom - sr.top + 6)}px` });
      const check = () => { const m = checkTpl(ta.value); err.hidden = !m; err.textContent = m || ""; ta.classList.toggle("is-bad", Boolean(m)); return m; };
      const node = f.node;
      inline = (save) => {
        inline = null;
        ta.remove();
        err.remove();
        if (save && !checkTpl(ta.value) && ta.value !== (node.text || "")) { node.text = ta.value; changed(null); drawTree(); drawScreen(); drawInspector(); }
      };
      ta.addEventListener("input", check);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); inline(false); rowFocus(); }
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!check()) { inline(true); rowFocus(); } }
      });
      ta.addEventListener("blur", () => { if (inline) inline(true); });
      stage.append(ta, err);
      ta.focus();
      ta.select();
    }
    const rowFocus = () => { const r = selected && rowOf(selected); if (r) r.focus({ preventScroll: true }); };

    /* -------------------------------------------------------- selecting */

    function select(id, opts = {}) {
      if (!id) return;
      if (id !== selected) {
        closeInline();
        selected = id;
        hist.key = null; // another element: another undo step
        if (expandTo(id)) drawTree(); else markRows();
        drawInspector();
        place();
      }
      if (opts.reveal || opts.tree) nearest(treeBox, rowOf(id));
      if (opts.reveal || opts.phone) { nearest(screenEl, firstEl(id), view.zoom / 100); place(); }
    }

    /* ------------------------------------------------------------ edits */

    /** After a structural edit: one undo step, everything drawn again. */
    function commit(sel) {
      closeInline();
      clearTimeout(soonTimer);
      soonTimer = 0;
      soonTree = false;
      changed(null); // before the new selection: undoing this step selects what was selected
      if (sel !== undefined) selected = sel;
      expandTo(selected);
      drawInfo(); drawTree(); drawScreen(); drawInspector();
      if (selected) { nearest(treeBox, rowOf(selected)); nearest(screenEl, firstEl(selected), view.zoom / 100); place(); }
    }
    /** Typing in the inspector: the phone (and the layers when their labels change) follow a moment later. */
    function soon(treeToo) {
      soonTree = soonTree || treeToo;
      clearTimeout(soonTimer);
      soonTimer = setTimeout(flushSoon, 140);
    }
    function flushSoon() {
      soonTimer = 0;
      if (!alive()) return;
      if (soonTree) drawTree();
      soonTree = false;
      drawScreen();
      drawInfo();
    }

    function spotNearSelection() {
      const rootNode = tree();
      const f = selected ? findNode(rootNode, selected) : null;
      if (!f) return { parent: rootNode.id, before: null };
      if (isContainer(f.node)) return { parent: f.node.id, before: null };
      return f.parent ? { parent: f.parent.id, before: nextId(f) } : { parent: rootNode.id, before: null };
    }
    function roomFor(n) {
      if (countNodes(tree()) + countNodes(n) <= catalog.limits.nodes) return true;
      toast(`A screen holds at most ${catalog.limits.nodes} elements.`, "err");
      return false;
    }
    function addAt(what, spot) {
      if (ro) return;
      const parent = findNode(tree(), spot.parent);
      if (!parent || !isContainer(parent.node)) { toast("That element cannot hold others.", "err"); return; }
      const node = freshNode(what.add, allIds(tree()), what.slot);
      if (!roomFor(node)) return;
      insertInto(parent.node, node, spot.before);
      collapsed.delete(fkey(parent.node.id));
      commit(node.id);
    }
    function moveTo(id, spot) {
      const rootNode = tree();
      const m = findNode(rootNode, id);
      const target = findNode(rootNode, spot.parent);
      if (!m || !m.parent || !target || m.node === target.node || findNode(m.node, spot.parent)) return;
      detach(rootNode, id);
      insertInto(target.node, m.node, spot.before === id ? null : spot.before);
      collapsed.delete(fkey(target.node.id));
      commit(id);
    }
    function step(d) {
      const f = findNode(tree(), selected);
      if (!f || !f.parent) return;
      const kids = f.parent.children;
      const i = kids.indexOf(f.node);
      if (i + d < 0 || i + d >= kids.length) return;
      kids.splice(i + d, 0, kids.splice(i, 1)[0]);
      commit(selected);
    }
    function duplicate() {
      const f = selected ? findNode(tree(), selected) : null;
      if (!f || !f.parent) return;
      const copy = renumber(structuredClone(f.node), allIds(tree()));
      if (!roomFor(copy)) return;
      insertInto(f.parent, copy, nextId(f));
      commit(copy.id);
    }
    function remove() {
      const f = selected ? findNode(tree(), selected) : null;
      if (!f || !f.parent) return;
      const kids = f.parent.children;
      const i = kids.indexOf(f.node);
      const next = kids[i + 1] || kids[i - 1] || f.parent;
      detach(tree(), selected);
      commit(next.id);
    }
    function wrap(el) {
      const rootNode = tree();
      const f = selected ? findNode(rootNode, selected) : null;
      if (!f) return;
      const box = freshNode(el, allIds(rootNode));
      box.children = [f.node];
      if (f.parent) f.parent.children[f.parent.children.indexOf(f.node)] = box;
      else design.screens[screenId] = box;
      commit(box.id);
    }
    function copy(cut) {
      const f = selected ? findNode(tree(), selected) : null;
      if (!f) return;
      clip = JSON.stringify(f.node);
      try { if (navigator.clipboard) navigator.clipboard.writeText(clip).catch(() => undefined); } catch { /* the console's own clipboard is enough */ }
      toast(`${cut ? "Cut" : "Copied"} #${f.node.id} — Ctrl+V pastes it into the selected container.`, "ok");
      if (cut && f.parent) remove();
    }
    async function paste() {
      let text = clip;
      if (!text && navigator.clipboard && navigator.clipboard.readText) { try { text = await navigator.clipboard.readText(); } catch { return; } }
      let node;
      try { node = JSON.parse(text || ""); } catch { return; }
      if (!node || typeof node !== "object" || typeof node.el !== "string") return;
      renumber(node, allIds(tree()));
      if (!roomFor(node)) return;
      const spot = spotNearSelection();
      insertInto(findNode(tree(), spot.parent).node, node, spot.before);
      commit(node.id);
    }

    /* ------------------------------------------------------ drag & drop */

    function startDrag(e, what) {
      if (ro) { e.preventDefault(); return; }
      closeInline();
      drag = what;
      e.dataTransfer.effectAllowed = what.add ? "copy" : "move";
      e.dataTransfer.setData("text/plain", what.add ? `${what.add}${what.slot ? `:${what.slot}` : ""}` : what.move);
      hoverOn(null);
      // Not now: Chrome cancels a drag whose source changes during dragstart.
      setTimeout(() => { if (drag) grid.classList.add("is-dragging"); }, 0);
    }
    function endDrag() { drag = null; grid.classList.remove("is-dragging"); showDrop(null); }

    const axisOf = (n) => (n.el === "row" || (n.el === "scroll" && X.truthy(n.props && n.props.horizontal)) ? "x" : "y");
    /** Where a drop over the phone lands: next to the element under the pointer, or inside a container. */
    function phoneSpot(e) {
      const rootNode = tree();
      const el = e.target.closest ? e.target.closest("[data-nid]") : null;
      if (!el || !screenEl.contains(el)) return inside(rootNode, firstEl(rootNode.id), e);
      const f = findNode(rootNode, el.dataset.nid);
      if (!f) return null;
      const r = el.getBoundingClientRect();
      const ax = f.parent ? axisOf(f.parent) : "y";
      const pos = ax === "x" ? e.clientX - r.left : e.clientY - r.top;
      const len = ax === "x" ? r.width : r.height;
      const beside = (before) => ({ parent: f.parent.id, before: before ? f.node.id : nextId(f), ref: f.node.id, side: before ? "before" : "after", axis: ax });
      if (isContainer(f.node)) {
        const edge = Math.min(10, len / 4);
        if (f.parent && pos < edge) return beside(true);
        if (f.parent && pos > len - edge) return beside(false);
        return inside(f.node, el, e);
      }
      return f.parent ? beside(pos < len / 2) : null;
    }
    function inside(node, el, e) {
      if (!el) return { parent: node.id, before: null, side: "inside" };
      const ax = axisOf(node);
      const kids = [...el.children].filter((c) => c.dataset && c.dataset.nid);
      for (const c of kids) {
        const r = c.getBoundingClientRect();
        if ((ax === "x" ? e.clientX : e.clientY) < (ax === "x" ? r.left + r.width / 2 : r.top + r.height / 2)) return { parent: node.id, before: c.dataset.nid, ref: c.dataset.nid, side: "before", axis: ax };
      }
      const last = kids[kids.length - 1];
      return last ? { parent: node.id, before: null, ref: last.dataset.nid, side: "after", axis: ax } : { parent: node.id, before: null, side: "inside" };
    }
    /** Where a drop over the layers lands: above, below or into the row. */
    function treeSpot(e) {
      const row = e.target.closest ? e.target.closest(".and-row") : null;
      const rootNode = tree();
      if (!row) return { parent: rootNode.id, before: null, row: rowOf(rootNode.id), side: "inside" };
      const f = findNode(rootNode, row.dataset.nid);
      if (!f) return null;
      if (!f.parent) return { parent: f.node.id, before: null, row, side: "inside" };
      const r = row.getBoundingClientRect();
      const rel = (e.clientY - r.top) / r.height;
      const open = f.node.children && f.node.children.length && !collapsed.has(fkey(f.node.id));
      if (isContainer(f.node)) {
        if (rel < 0.25) return { parent: f.parent.id, before: f.node.id, row, side: "before" };
        if (rel > 0.75) return open ? { parent: f.node.id, before: f.node.children[0].id, row, side: "first" } : { parent: f.parent.id, before: nextId(f), row, side: "after" };
        return { parent: f.node.id, before: null, row, side: "inside" };
      }
      return rel < 0.5 ? { parent: f.parent.id, before: f.node.id, row, side: "before" } : { parent: f.parent.id, before: nextId(f), row, side: "after" };
    }
    /** A spot the dragged thing may go to (not into itself, not where it already is). */
    function allowed(spot) {
      if (!spot || !drag) return null;
      const rootNode = tree();
      const parent = findNode(rootNode, spot.parent);
      if (!parent || !isContainer(parent.node)) return null;
      if (drag.move) {
        const m = findNode(rootNode, drag.move);
        if (!m || !m.parent || m.node === parent.node || findNode(m.node, spot.parent)) return null;
        if (spot.before === m.node.id || (m.parent === parent.node && nextId(m) === spot.before)) return null;
      }
      return spot;
    }
    function showDrop(spot) {
      for (const r of outline.querySelectorAll(".drop-before, .drop-after, .drop-inside, .drop-first")) r.classList.remove("drop-before", "drop-after", "drop-inside", "drop-first");
      clear(ovDrop);
      if (!spot) return;
      if (spot.row) { spot.row.classList.add(`drop-${spot.side}`); return; }
      const base = ov.getBoundingClientRect();
      const pEl = firstEl(spot.parent);
      if (pEl) ovDrop.append(boxAt(pEl.getBoundingClientRect(), base, "and-box and-box--drop"));
      if (spot.side === "inside") return;
      const ref = spot.side === "before" ? firstEl(spot.ref) : lastEl(spot.ref);
      if (!ref) return;
      const r = ref.getBoundingClientRect();
      const line = h("div", { class: "and-dropline" });
      if (spot.axis === "x") Object.assign(line.style, { left: `${(spot.side === "before" ? r.left : r.right) - base.left - 1.5}px`, top: `${r.top - base.top}px`, width: "3px", height: `${r.height}px` });
      else Object.assign(line.style, { left: `${r.left - base.left}px`, top: `${(spot.side === "before" ? r.top : r.bottom) - base.top - 1.5}px`, width: `${r.width}px`, height: "3px" });
      ovDrop.append(line);
    }
    const dropZone = (el, where) => {
      el.addEventListener("dragover", (e) => {
        if (!drag) return;
        const spot = allowed(where(e));
        showDrop(spot);
        if (!spot) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = drag.add ? "copy" : "move";
      });
      el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) showDrop(null); });
      el.addEventListener("drop", (e) => {
        if (!drag) return;
        e.preventDefault();
        const spot = allowed(where(e));
        const what = drag;
        // The drop redraws the source: its dragend would fire on a detached node, so end here.
        endDrag();
        if (!spot) return;
        if (what.add) addAt(what, spot); else moveTo(what.move, spot);
      });
    };
    dropZone(screenEl, phoneSpot);
    dropZone(treeBox, treeSpot);
    outline.addEventListener("dragstart", (e) => {
      const row = e.target.closest ? e.target.closest(".and-row") : null;
      if (!row || ro || row.dataset.nid === tree().id) { e.preventDefault(); return; }
      startDrag(e, { move: row.dataset.nid });
    });
    outline.addEventListener("dragend", endDrag);

    /* --------------------------------------------------------- keyboard */

    function onKey(e) {
      if (view.overview) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      const f = selected ? findNode(tree(), selected) : null;
      if (mod && !e.altKey) {
        const l = k.toLowerCase();
        if (ro || !["c", "x", "v", "d"].includes(l)) return;
        if (l === "c" && String(window.getSelection() || "")) return; // copying text of the page
        e.preventDefault();
        if (l === "c") copy(false); else if (l === "x") copy(true); else if (l === "v") void paste(); else duplicate();
        return;
      }
      if (e.target.closest && e.target.closest("button, summary, a, [role=button], [role=menuitem]") && (k === "Enter" || k === " ")) return;
      const rows = [...outline.querySelectorAll(".and-row")];
      const inTree = outline.contains(document.activeElement);
      const go = (id) => { if (!id) return; select(id, { reveal: true }); if (inTree) rowFocus(); };
      if (k === "Delete" || k === "Backspace") { if (!ro && f) { e.preventDefault(); remove(); if (inTree) rowFocus(); } }
      else if (k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        if (e.altKey) { if (!ro) { step(k === "ArrowUp" ? -1 : 1); if (inTree) rowFocus(); } return; }
        const i = rows.findIndex((r) => r.dataset.nid === selected);
        const nextRow = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (k === "ArrowUp" ? -1 : 1)))];
        go(nextRow && nextRow.dataset.nid);
      } else if (k === "ArrowLeft" && f) {
        e.preventDefault();
        if (f.node.children && f.node.children.length && !collapsed.has(fkey(f.node.id))) { collapsed.add(fkey(f.node.id)); drawTree(); if (inTree) rowFocus(); }
        else if (f.parent) go(f.parent.id);
      } else if (k === "ArrowRight" && f) {
        e.preventDefault();
        if (collapsed.delete(fkey(f.node.id))) { drawTree(); if (inTree) rowFocus(); }
        else if (f.node.children && f.node.children.length) go(f.node.children[0].id);
      } else if (k === "Home" || k === "End") { e.preventDefault(); const r = k === "Home" ? rows[0] : rows[rows.length - 1]; go(r && r.dataset.nid); }
      else if (k === "Escape" && f && f.parent) { e.preventDefault(); go(f.parent.id); }
      else if ((k === "Enter" || k === "F2") && f && (elDef(f.node.el) || {}).text) { e.preventDefault(); editInline(); }
    }

    /* -------------------------------------------------------- inspector */

    /** The sample scope an element sees: each list above it gives its first item. */
    function scopeFor(id) {
      let scope = phoneScope(screenId);
      for (const n of pathTo(tree(), id) || []) {
        if (!n.each) continue;
        try { const list = X.eval(n.each, scope, t); if (Array.isArray(list) && list.length) scope = { ...scope, [n.as || "item"]: list[0], index: 0, first: true, last: list.length === 1 }; } catch { /* the field shows it */ }
      }
      return scope;
    }

    function group(id, title, count, ...content) {
      const d = h("details", { class: "and-grp", open: inspOpen[id] ? true : undefined },
        h("summary", {}, title, count ? h("span", { class: "and-grp__count" }, String(count)) : null), h("div", { class: "and-grp__body" }, ...content));
      d.addEventListener("toggle", () => { inspOpen[id] = d.open; });
      return d;
    }

    function drawInspector() {
      if (!alive()) return;
      const keep = right.scrollTop;
      clear(right);
      const f = selected ? findNode(tree(), selected) : null;
      if (!f) { right.append(emptyInspector()); return; }
      const n = f.node;
      const def = elDef(n.el) || { el: n.el, label: n.el, props: [], text: false, container: false, help: "An element this console does not know (yet): its values stay as they are." };
      const base = fkey(n.id);
      const ctx = {
        ro, scope: scopeFor(n.id),
        edit: (field, fn, treeToo) => { fn(); changed(`${base}/${field}`); soon(treeToo); },
        redraw: () => drawInspector(),
      };
      const set = (obj, key, v) => { if (v === "" || v === undefined || v === null) delete obj[key]; else obj[key] = v; };
      right.append(h("div", { class: "and-insp__head" }, iconEl(elIcon(n.el), 18, "currentColor"), h("strong", {}, def.label || n.el), h("span", { class: "mono small muted" }, `#${n.id}`), h("span", { class: "spacer" }),
        ro || !f.parent ? null : iconBtn("copy", "Duplicate (Ctrl+D)", duplicate),
        ro || !f.parent ? null : h("button", { class: "btn btn--sm btn--danger and-ibtn", type: "button", title: "Delete (Del)", "aria-label": "Delete the element", onclick: remove }, iconEl("trash", 15, "currentColor"))));
      right.append(h("div", { class: "muted small and-insp__help" }, def.help || ""));

      const ids = allIds(tree());
      right.append(group("element", "Element & text", 0,
        fld("Id", textField({ label: "Id", value: n.id, ro, mono: true, check: (v) => (!ID_RE.test(v) ? "letters, digits and dashes (up to 40)" : v !== n.id && ids.has(v) ? "another element has this id" : null),
          onValue: (v) => { if (v === n.id) return; ctx.edit("id", () => { ids.delete(n.id); ids.add(v); n.id = v; selected = v; tbFor = null; }, true); } })),
        fld("Name (for you)", textField({ label: "Name", value: n.name, ro, placeholder: "shown in the layers", onValue: (v) => ctx.edit("name", () => set(n, "name", v.trim()), true) })),
        def.text ? fld("Text", textField({ label: "Text", value: n.text, ro, area: true, check: checkTpl, preview: previewTpl(ctx.scope), onValue: (v) => ctx.edit("text", () => set(n, "text", v), true) }), "{$var} {_'key'} {=expression} · filters: |upper |truncate:40 |time |size…") : null));

      if (def.props.length) right.append(group("params", "Parameters", def.props.filter((p) => n.props && n.props[p.name] !== undefined).length, ...def.props.map((p) => propField(p, n, ctx))));
      const known = new Set(catalog.style.map((s) => s.name));
      const count = (list) => list.filter((s) => n.style && n.style[s.name] !== undefined).length;
      const layout = catalog.style.filter((s) => LAYOUT_STYLE.has(s.name));
      const look = catalog.style.filter((s) => !LAYOUT_STYLE.has(s.name));
      right.append(group("layout", "Layout", count(layout), ...layout.map((s) => styleField(s, n, ctx))));
      right.append(group("style", "Style", count(look), ...look.map((s) => styleField(s, n, ctx)),
        ...Object.keys(n.style || {}).filter((k) => !known.has(k)).map((k) => fld(k, h("span", { class: "mono small" }, JSON.stringify(n.style[k])), "not in the catalog; kept as it is"))));
      right.append(group("anim", "Animation", n.anim ? 1 : 0, animEditor(n, ctx)));
      right.append(group("logic", "Logic", ["if", "each"].filter((x) => n[x]).length,
        fld("Show when (if)", textField({ label: "Show when", value: n.if, ro, mono: true, check: checkCond, preview: previewExpr(ctx.scope), placeholder: "$room.unread > 0", onValue: (v) => ctx.edit("if", () => set(n, "if", v.trim()), true) }), "empty: always"),
        fld("Repeat for each (each)", textField({ label: "Repeat for each", value: n.each, ro, mono: true, check: checkCond, preview: previewExpr(ctx.scope), placeholder: "$rooms", onValue: (v) => ctx.edit("each", () => { set(n, "each", v.trim()); if (n.each && !n.as) n.as = "item"; if (!n.each) delete n.as; }, true) }), "a list: the element is drawn once per item"),
        fld("Each item as", textField({ label: "Each item as", value: n.as, ro, mono: true, placeholder: "item", check: (v) => (!v || /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(v) ? null : "a name: letters, digits, _"), onValue: (v) => ctx.edit("as", () => { if (n.each) n.as = v || "item"; }) }), "then $item (or your name), $index, $first, $last")));
      right.append(group("events", "Events", n.on ? Object.keys(n.on).length : 0, ...catalog.events.map((ev) => eventField(ev, n, ctx))));
      right.scrollTop = keep;
      C.applyRoleGates(right);
    }

    function animEditor(n, ctx) {
      const enter = (n.anim && n.anim.enter) || {};
      const upd = (patch) => ctx.edit("anim", () => {
        const cur = { ...((n.anim && n.anim.enter) || {}), ...patch };
        for (const k of Object.keys(cur)) if (cur[k] === undefined || cur[k] === "") delete cur[k];
        if (!cur.type) delete n.anim; else n.anim = { enter: cur };
      });
      const type = selectW({ label: "Enter animation", value: enter.type, ro: ctx.ro, empty: "none", options: catalog.anims.filter((a) => a !== "none"), onValue: (v) => upd({ type: v }) });
      return h("div", { class: "and-fx" },
        fld("Enter", type),
        h("div", { class: "and-anim" },
          fld("Duration (ms)", numW({ label: "Duration in ms", value: enter.ms, ro: ctx.ro, min: 0, max: 5000, step: 20, onValue: (v) => upd({ ms: v }) })),
          fld("Delay (ms)", numW({ label: "Delay in ms", value: enter.delay, ro: ctx.ro, min: 0, max: 5000, step: 20, onValue: (v) => upd({ delay: v }) }))),
        fld("Easing", selectW({ label: "Easing", value: enter.easing, ro: ctx.ro, options: catalog.easings, onValue: (v) => upd({ easing: v }) })),
        h("div", { class: "row" }, iconBtn("play", "Play it in the phone", () => { if (n.anim) play([n.id]); }, { "data-read": "1", text: "Play" })));
    }

    function emptyInspector() {
      const keys = [["Ctrl+Z · Ctrl+Shift+Z", "undo · redo"], ["Ctrl+C · X · V · D", "copy · cut · paste · duplicate"], ["Del", "delete"], ["↑ ↓ · ← →", "previous / next · parent / child"], ["Alt+↑ ↓", "move among siblings"], ["Enter · dbl-click", "edit a text in place"], ["Esc", "select the parent"]];
      return h("div", { class: "stack" },
        h("div", { class: "muted small" }, ro ? "Select an element in the layers or the phone to see its settings." : "Select an element in the layers or the phone. Drag elements from the palette onto the phone or into the layers — or click one to add it to the selected container."),
        h("dl", { class: "and-keys" }, ...keys.flatMap(([a, b]) => [h("dt", {}, a), h("dd", {}, b)])));
    }

    /* ------------------------------------------------------ sample data */

    function drawSample() {
      clear(sampleBody);
      const baseSample = catalogSample(screenId);
      sampleTag.hidden = samples[screenId] === undefined;
      const ta = h("textarea", { class: "input mono", rows: "10", spellcheck: "false", "aria-label": "Sample data of the screen (JSON)", "data-read": "1" });
      ta.value = JSON.stringify(sampleFor(screenId), null, 2);
      const msg = h("div", { class: "and-msg", "aria-live": "polite" });
      const chips = h("div", { class: "and-chips", role: "group", "aria-label": "Quick states" });
      const use = (v) => { samples[screenId] = v; sampleTag.hidden = false; drawChips(); drawScreen(); };
      const drawChips = () => {
        clear(chips);
        const cur = sampleFor(screenId);
        for (const q of quickStates(baseSample)) {
          const on = canon(getPath(cur, q.path)) === canon(q.alt);
          chips.append(h("button", { type: "button", class: "and-chip", "aria-pressed": String(on), "data-read": "1", onclick: () => { const s = sampleFor(screenId); setPath(s, q.path, on ? q.base : q.alt); ta.value = JSON.stringify(s, null, 2); msg.textContent = ""; use(s); } }, q.label));
        }
      };
      let timer = 0;
      ta.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            const v = JSON.parse(ta.value);
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The sample is an object: { … }.");
            msg.className = "and-msg"; msg.textContent = "";
            use(v);
          } catch (err) { msg.className = "and-msg is-bad"; msg.textContent = err.message; }
        }, 250);
      });
      drawChips();
      sampleBody.append(chips, ta, msg, h("div", { class: "row" },
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { delete samples[screenId]; drawSample(); drawScreen(); } }, "Back to the catalog's sample"),
        h("span", { class: "muted small" }, "Preview only — not part of the design.")));
    }

    /* ------------------------------------------------------------ start */

    /** After undo / redo: the screen of that step, the selection kept when it still exists. */
    function refresh(scr, sel) {
      closeInline();
      if (scr && scr !== screenId && design.screens[scr]) { screenId = scr; selected = ""; drawPalette(); drawSample(); }
      if (!selected || !findNode(tree(), selected)) selected = sel && findNode(tree(), sel) ? sel : "";
      tbFor = null;
      drawPick(); drawInfo(); drawTree(); drawScreen(); drawInspector();
      if (view.overview) drawOverview();
    }
    builder = { alive, refresh, place, key: onKey };
    drawPick();
    drawInfo();
    drawPalette();
    drawTree();
    applyDevice();
    drawScreen();
    drawInspector();
    drawSample();
    showMode();
    C.applyRoleGates(body);
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
