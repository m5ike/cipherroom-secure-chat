// M5cet operator console.
//
// Plain JavaScript, no framework, no build step: the console is served by
// the admin service under a CSP of script-src 'self' and must keep working
// from a locked-down host. Everything a server sends is put into the page
// with textContent / DOM nodes — never innerHTML — so a room member's
// display name cannot become markup here.
//
// The admin token lives in this tab's memory, optionally in its session
// storage; never in local storage (the previous page kept it there, for
// every later visitor of the browser profile — the old key is erased on
// load). Live data arrives as Server-Sent Events read with fetch(), so the
// token travels in a header, not in a URL.

(() => {
  "use strict";

  /* ================================================================ utils */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Builds an element. Children may be nodes, strings, numbers, arrays or null. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.firstChild.remove(); return el; }
  const svgNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  }

  const nf = new Intl.NumberFormat();
  const num = (n) => (n === undefined || n === null || Number.isNaN(n) ? "—" : nf.format(n));
  function bytes(n) {
    if (n === undefined || n === null || !Number.isFinite(Number(n))) return "—";
    n = Number(n);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }
  const pad = (n) => String(n).padStart(2, "0");
  function time(t) {
    if (!t) return "—";
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }
  function dateTime(t) {
    if (!t) return "—";
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function ago(t) {
    if (!t) return "—";
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 0) return "in " + duration(-sec);
    if (sec < 5) return "now";
    return duration(sec) + " ago";
  }
  function duration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  }
  const short = (v, n = 10) => (v ? (String(v).length > n ? String(v).slice(0, n) + "…" : String(v)) : "—");

  function badge(text, tone) {
    return h("span", { class: `badge${tone ? " badge--" + tone : ""}` }, text);
  }
  const LEVEL_TONE = { debug: "", info: "info", notice: "accent", warn: "warn", error: "err" };
  const CLASS_TONE = { signaling: "accent", presence: "violet", relay: "ok", storage: "info", "file-proxy": "violet", heartbeat: "", account: "ok", admin: "warn", push: "info", api: "", static: "", error: "err", other: "" };
  function statusBadge(status) {
    if (status === undefined || status === null || status === "") return "";
    if (typeof status === "number") return badge(String(status), status >= 500 ? "err" : status >= 400 ? "warn" : "ok");
    const s = String(status);
    if (/^(error|dropped|rejected|refused|failed)/i.test(s)) return badge(s, "err");
    if (/^(ok|stored|delivered|forwarded|completed|verified)/i.test(s)) return badge(s, "ok");
    return badge(s);
  }

  /* =============================================================== toasts */

  function toast(message, tone) {
    const el = h("div", { class: `toast${tone ? " toast--" + tone : ""}`, role: "status" }, message);
    $("#toasts").append(el);
    setTimeout(() => el.remove(), tone === "err" ? 8000 : 4000);
  }

  /* ================================================================= auth */

  const SESSION_KEY = "m5cet:console:v1";
  // The previous admin page kept the token in local storage: remove it.
  try { localStorage.removeItem("m5cet:admin:cfg"); } catch { /* storage blocked */ }

  const state = {
    base: "",
    token: "",
    route: "overview",
    paused: false,
    traffic: [],
    rates: [],
    audit: [],
    auditSource: "memory",
    overview: null,
    counts: null,
    system: [],
    liveAbort: null,
    liveUp: false,
    admin: null,
    renderQueued: new Set(),
  };

  async function api(path, opts = {}) {
    const res = await fetch(state.base + path, {
      method: opts.method || "GET",
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${state.token}`,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) {
      signOut("The token was refused. Sign in again.");
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const message = (data && (data.message || data.reason)) || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return data || {};
  }

  async function signIn(base, token, remember) {
    state.base = (base || location.origin).trim().replace(/\/+$/, "");
    state.token = token.trim();
    const overview = await api("/api/admin/overview");
    try {
      if (remember) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ base: state.base, token: state.token }));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* storage blocked: memory only */ }
    // The ported tools read these two fields.
    $("#base").value = state.base;
    $("#token").value = state.token;
    $("#login").hidden = true;
    $("#shell").hidden = false;
    state.overview = overview;
    state.counts = overview.counts;
    await loadWhoami();
    $("#brandVersion").textContent = `v${overview.version || "?"} · operator console`;
    $("#footBuild").textContent = overview.build ? `build ${overview.build}` : "";
    startLive();
    route(location.hash.replace(/^#\/?/, "") || "overview");
  }

  const RANK = { auditor: 1, operator: 2, owner: 3 };
  const can = (role) => Boolean(state.admin && RANK[state.admin.role] >= RANK[role]);

  async function loadWhoami() {
    try { state.admin = (await api("/api/admin/whoami")).admin || null; } catch { state.admin = null; }
    const who = $("#whoami");
    clear(who);
    if (state.admin) append(who, ["signed in as ", h("b", {}, state.admin.name), ` · ${state.admin.role}`, state.admin.via === "passkey" ? " · passkey" : ""]);
    for (const el of $$("[data-min-role]")) el.hidden = !can(el.dataset.minRole);
    $("#btnMyPasskey").hidden = !state.admin || state.admin.via === "env-token";
    applyRoleGates();
  }

  /** An auditor reads; buttons that act are disabled for them. */
  function applyRoleGates(root = document) {
    const readOnly = !can("operator");
    for (const el of $$("button, input, select, textarea", root)) {
      if (el.closest(".login, .topbar, .nav, .toolbar, #aSource, [data-panel=admins]") || el.dataset.read === "1") continue;
      const acting = el.closest("form") || el.classList.contains("btn--danger") || el.classList.contains("btn--primary") || /Disconnect|Revive|Sign out every|Delete|Sweep|Send|Test|Save|Reset|Install|Route|Add|Import/i.test(el.textContent || "");
      if (!acting) continue;
      if (readOnly) el.setAttribute("data-disabled-by-role", ""); else el.removeAttribute("data-disabled-by-role");
    }
  }

  function signOut(message) {
    if (state.admin && state.admin.via === "passkey") {
      fetch(`${state.base}/api/admin/auth/signout`, { method: "POST", headers: { Authorization: `Bearer ${state.token}` } }).catch(() => undefined);
    }
    state.admin = null;
    state.token = "";
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    stopLive();
    $("#base").value = "";
    $("#token").value = "";
    $("#shell").hidden = true;
    $("#login").hidden = false;
    $("#loginToken").value = "";
    const err = $("#loginError");
    if (message) { err.textContent = message; err.hidden = false; } else err.hidden = true;
  }

  $("#loginBase").value = location.origin;
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const err = $("#loginError");
    err.hidden = true;
    try {
      await signIn($("#loginBase").value, $("#loginToken").value, $("#loginRemember").checked);
    } catch (e) {
      if (e.message !== "unauthorized") { err.textContent = `Could not sign in: ${e.message}`; err.hidden = false; }
    }
  });
  $("#btnSignOut").addEventListener("click", () => signOut());

  /* ---------------------------------------------------- passkeys (WebAuthn) */

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  $("#loginPasskey").addEventListener("click", async () => {
    const err = $("#loginError");
    err.hidden = true;
    const base = ($("#loginBase").value || location.origin).trim().replace(/\/+$/, "");
    try {
      if (!window.PublicKeyCredential) throw new Error("this browser has no passkeys");
      const opts = await (await fetch(`${base}/api/admin/auth/passkey/options`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      const credential = await navigator.credentials.get({ publicKey: {
        challenge: fromB64url(opts.publicKey.challenge), rpId: opts.publicKey.rpId, userVerification: "required", timeout: 60000,
      } });
      if (!credential) throw new Error("cancelled");
      const r = credential.response;
      const res = await fetch(`${base}/api/admin/auth/passkey/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: {
        id: credential.id, rawId: b64url(credential.rawId), type: credential.type,
        response: { clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature), userHandle: r.userHandle ? b64url(r.userHandle) : null },
      } }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      await signIn(base, data.token, $("#loginRemember").checked);
    } catch (e) {
      err.textContent = `Passkey sign-in failed: ${e.message}`;
      err.hidden = false;
    }
  });

  $("#btnMyPasskey").addEventListener("click", async () => {
    try {
      const opts = (await api("/api/admin/me/passkeys/options", { method: "POST", body: {} })).publicKey;
      const credential = await navigator.credentials.create({ publicKey: {
        challenge: fromB64url(opts.challenge), rp: opts.rp,
        user: { id: fromB64url(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        pubKeyCredParams: opts.pubKeyCredParams, authenticatorSelection: opts.authenticatorSelection, attestation: "none", timeout: 60000,
        excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ type: "public-key", id: fromB64url(c.id) })),
      } });
      if (!credential) return;
      await api("/api/admin/me/passkeys/verify", { method: "POST", body: { label: navigator.platform || "passkey", credential: {
        id: credential.id, rawId: b64url(credential.rawId), type: credential.type,
        response: { clientDataJSON: b64url(credential.response.clientDataJSON), attestationObject: b64url(credential.response.attestationObject) },
      } } });
      toast("Passkey registered — next time, sign in with it.", "ok");
    } catch (e) { toast(`Passkey: ${e.message}`, "err"); }
  });

  /* ================================================================ theme */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("m5cet:console:theme", theme); } catch { /* ignore */ }
  }
  try { applyTheme(localStorage.getItem("m5cet:console:theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")); } catch { applyTheme("dark"); }
  $("#btnTheme").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

  /* =============================================================== router */

  const ROUTES = {
    overview: ["Overview", "Everything at a glance", loadOverview],
    traffic: ["Live traffic", "Every frame and request, as it happens — metadata only", loadTraffic],
    connections: ["Connections", "Open WebSockets", loadConnections],
    rooms: ["Rooms", "Who is where (room names are shown as hashes)", loadRooms],
    users: ["Users & passkeys", "Accounts, their databases, sessions and queues", loadUsers],
    queue: ["Message queue", "Offline delivery for signed-in users who are away", loadQueue],
    storage: ["Storage & databases", "The global database and the encrypted per-user databases", loadStorage],
    audit: ["Audit log", "Every security, account, storage, admin and system event", loadAudit],
    system: ["System & memory", "Process health over the last 30 minutes", loadSystem],
    retention: ["Retention", "What is kept, for how long, and the last sweep", loadRetention],
    commands: ["Commands & push", "Operator commands to devices, Web Push", loadCommands],
    admins: ["Administrators", "Who may use this console, and as what", loadAdmins],
    alerts: ["Alerts", "What the server watches for when nobody is looking", loadAlerts],
    client: ["Client & addons", "Saved connections and GUI templates for every user", loadClient],
    layout: ["Layout builder", "Styles and text templates for every client", null],
    telephony: ["Telephony & SIP", "Voice and SMS providers, webhooks, trunks", null],
    plugins: ["AI & speech", "Connectors and their live log", null],
  };

  function route(name) {
    if (!ROUTES[name]) name = "overview";
    state.route = name;
    if (location.hash !== `#/${name}`) history.replaceState(null, "", `#/${name}`);
    for (const section of $$("[data-panel]")) section.hidden = section.dataset.panel !== name;
    for (const item of $$(".nav__item")) item.setAttribute("aria-current", item.dataset.route === name ? "page" : "false");
    const [title, crumb, loader] = ROUTES[name];
    $("#pageTitle").textContent = title;
    $("#pageCrumb").textContent = crumb;
    if (loader && state.token) loader().then(() => applyRoleGates(), (e) => { if (e.message !== "unauthorized") toast(`${title}: ${e.message}`, "err"); });
  }

  $("#nav").addEventListener("click", (event) => {
    const item = event.target.closest(".nav__item");
    if (item) route(item.dataset.route);
  });
  document.addEventListener("click", (event) => {
    const go = event.target.closest("[data-go]");
    if (go) route(go.dataset.go);
    const refresh = event.target.closest("[data-refresh]");
    if (refresh) route(refresh.dataset.refresh);
  });
  window.addEventListener("hashchange", () => { if (state.token) route(location.hash.replace(/^#\/?/, "")); });

  /* ============================================================ live feed */

  async function startLive() {
    stopLive();
    const controller = new AbortController();
    state.liveAbort = controller;
    let backoff = 1000;
    while (!controller.signal.aborted && state.token) {
      try {
        const res = await fetch(`${state.base}/api/admin/live?streams=traffic,audit,tick`, {
          headers: { Authorization: `Bearer ${state.token}`, Accept: "text/event-stream" },
          signal: controller.signal,
          cache: "no-store",
        });
        if (res.status === 401) { signOut("The token was refused. Sign in again."); return; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setLive(true);
        backoff = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            let event = "message";
            const data = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            if (data.length) { try { onLive(event, JSON.parse(data.join("\n"))); } catch { /* malformed event */ } }
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return;
      }
      setLive(false);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15000);
    }
  }

  function stopLive() {
    if (state.liveAbort) state.liveAbort.abort();
    state.liveAbort = null;
    setLive(false);
  }

  function setLive(up) {
    state.liveUp = up;
    const el = $("#liveState");
    el.classList.toggle("is-on", up);
    $("#liveText").textContent = up ? "live" : state.token ? "reconnecting…" : "offline";
  }

  function onLive(event, data) {
    if (event === "traffic") {
      if (state.paused) return;
      state.traffic.unshift(data);
      if (state.traffic.length > 3000) state.traffic.length = 3000;
      schedule("traffic");
    } else if (event === "audit") {
      state.audit.unshift(data);
      if (state.audit.length > 2000) state.audit.length = 2000;
      if (data.level === "warn" || data.level === "error") schedule("problems");
      schedule("audit");
      const badgeEl = $("#navAudit");
      if (state.route !== "audit") badgeEl.textContent = String((Number(badgeEl.textContent) || 0) + 1);
    } else if (event === "tick") {
      state.counts = data.counts;
      if (data.rate) {
        state.rates.push(data.rate);
        if (state.rates.length > 180) state.rates.splice(0, state.rates.length - 180);
      }
      if (data.system && (!state.system.length || state.system[state.system.length - 1].t !== data.system.t)) {
        state.system.push(data.system);
        if (state.system.length > 360) state.system.shift();
      }
      updateBadges(data);
      schedule("tick");
    }
  }

  /** Coalesces renders to one per animation frame per kind. */
  function schedule(kind) {
    if (state.renderQueued.has(kind)) return;
    state.renderQueued.add(kind);
    requestAnimationFrame(() => {
      state.renderQueued.delete(kind);
      if (kind === "traffic" && state.route === "traffic") renderTraffic();
      if (kind === "audit" && state.route === "audit" && state.auditSource === "memory") renderAudit();
      if (kind === "problems" && state.route === "overview") renderProblems();
      if (kind === "tick") {
        if (state.route === "overview") { renderKpis(); renderTrafficChart($("#chartTraffic"), $("#trafficLegend"), 120); }
        if (state.route === "traffic") renderTrafficChart($("#chartTraffic2"), $("#trafficLegend2"), 180);
        if (state.route === "system") renderSystemCharts();
      }
    });
  }

  function updateBadges(tick) {
    const c = tick.counts || {};
    $("#navConn").textContent = c.connections ? String(c.connections) : "";
    $("#navRooms").textContent = c.rooms ? String(c.rooms) : "";
    $("#navUsers").textContent = c.accounts ? String(c.accounts) : "";
    const rate = tick.rate;
    $("#navRate").textContent = rate ? `${rate.framesIn + rate.framesOut + rate.http}/s` : "";
    if (tick.system) $("#footUptime").textContent = `heap ${bytes(tick.system.heapUsed)} · loop p99 ${tick.system.loopP99} ms`;
  }

  /* =============================================================== charts */

  const COLORS = { a: "var(--accent)", b: "var(--ok)", c: "var(--warn)", d: "var(--violet)", e: "var(--err)", f: "var(--info)" };

  /**
   * A line chart in an <svg>: series = [{ name, color, values: number[] }],
   * all the same length, x evenly spaced. Draws a light grid, areas and
   * lines, and the latest value of each series in the legend.
   */
  function lineChart(svg, legend, series, format) {
    if (!svg) return;
    const width = Math.max(200, Math.round(svg.getBoundingClientRect().width) || 600);
    const height = Math.max(120, Math.round(svg.getBoundingClientRect().height) || 180);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    while (svg.firstChild) svg.firstChild.remove();
    const n = Math.max(...series.map((x) => x.values.length), 2);
    const max = Math.max(1, ...series.flatMap((x) => x.values.filter(Number.isFinite)));
    // Room for the longest axis label ("512.4 MB").
    const padL = Math.max(34, Math.round(Math.max(...[0, 1, 2, 3, 4].map((g) => format((max * g) / 4).length)) * 6.4) + 12);
    const padR = 8, padT = 10, padB = 18;
    const x = (i) => padL + (i / (n - 1)) * (width - padL - padR);
    const y = (v) => padT + (1 - v / max) * (height - padT - padB);
    for (let g = 0; g <= 4; g += 1) {
      const v = (max * g) / 4;
      svg.append(s("line", { x1: padL, x2: width - padR, y1: y(v), y2: y(v), class: "grid-line" }));
      const label = s("text", { x: padL - 6, y: y(v) + 3, "text-anchor": "end", class: "axis" });
      label.textContent = format(v);
      svg.append(label);
    }
    for (const line of series) {
      if (!line.values.length) continue;
      const pts = line.values.map((v, i) => `${x(i + n - line.values.length).toFixed(1)},${y(Number.isFinite(v) ? v : 0).toFixed(1)}`);
      const first = x(n - line.values.length);
      svg.append(s("path", { d: `M${first},${y(0)} L${pts.join(" L")} L${x(n - 1)},${y(0)} Z`, fill: line.color, opacity: 0.08 }));
      svg.append(s("path", { d: `M${pts.join(" L")}`, fill: "none", stroke: line.color, "stroke-width": 1.6, "stroke-linejoin": "round" }));
    }
    if (legend) {
      clear(legend);
      for (const line of series) {
        const last = line.values.length ? line.values[line.values.length - 1] : 0;
        legend.append(h("span", { class: "legend__item" }, h("i", { class: "legend__sw", style: `background:${line.color}` }), `${line.name} `, h("b", {}, format(last))));
      }
    }
  }

  function renderTrafficChart(svg, legend, seconds) {
    const rates = state.rates.slice(-seconds);
    lineChart(svg, legend, [
      { name: "in /s", color: COLORS.a, values: rates.map((r) => r.framesIn) },
      { name: "out /s", color: COLORS.b, values: rates.map((r) => r.framesOut) },
      { name: "http /s", color: COLORS.c, values: rates.map((r) => r.http) },
      { name: "errors /s", color: COLORS.e, values: rates.map((r) => r.errors) },
    ], (v) => (v >= 10 ? num(Math.round(v)) : (Math.round(v * 10) / 10).toString()));
  }

  function bars(container, entries, format) {
    clear(container);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    if (!entries.length) container.append(h("div", { class: "empty" }, "Nothing yet."));
    for (const [label, value, tone] of entries) {
      container.append(h("div", { class: "bar" },
        h("span", { class: "bar__label" }, label),
        h("span", { class: "bar__track" }, h("span", { class: `bar__fill${tone ? " bar__fill--" + tone : ""}`, style: `width:${Math.max(2, (value / max) * 100).toFixed(1)}%` })),
        h("span", { class: "bar__val" }, format ? format(value) : num(value))));
    }
  }

  /* ================================================================ table */

  /** Fills a table body; `rows` are arrays of cells (nodes or text). */
  function fillTable(table, rows, emptyText, onRow) {
    const tbody = table.tBodies[0];
    clear(tbody);
    if (!rows.length) {
      const cols = table.tHead ? table.tHead.rows[0].cells.length : 1;
      tbody.append(h("tr", {}, h("td", { colspan: cols, class: "empty" }, emptyText || "Nothing to show.")));
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((cells, i) => {
      const tr = h("tr", onRow ? { class: "is-clickable", tabindex: 0 } : {});
      cells.forEach((cell, c) => {
        const numeric = table.tHead && table.tHead.rows[0].cells[c] && table.tHead.rows[0].cells[c].classList.contains("num");
        tr.append(h("td", numeric ? { class: "num" } : {}, cell));
      });
      if (onRow) {
        tr.addEventListener("click", (e) => { if (!e.target.closest("button, a")) onRow(i); });
        tr.addEventListener("keydown", (e) => { if (e.key === "Enter") onRow(i); });
      }
      frag.append(tr);
    });
    tbody.append(frag);
  }

  /* =============================================================== drawer */

  function openDrawer(title, build) {
    closeDrawer();
    const backdrop = h("div", { class: "drawer-backdrop", onclick: closeDrawer });
    const body = h("div", { class: "drawer__body" });
    const drawer = h("aside", { class: "drawer", role: "dialog", "aria-label": title },
      h("div", { class: "drawer__head" }, h("div", { class: "drawer__title" }, title), h("span", { class: "spacer" }), h("button", { class: "btn btn--sm", onclick: closeDrawer }, "Close")),
      body);
    document.body.append(backdrop, drawer);
    build(body);
    const onKey = (e) => { if (e.key === "Escape") closeDrawer(); };
    document.addEventListener("keydown", onKey, { once: true });
  }
  function closeDrawer() { $$(".drawer, .drawer-backdrop").forEach((el) => el.remove()); }

  function kv(dl, pairs) {
    clear(dl);
    for (const [k, v] of pairs) {
      if (v === undefined) continue;
      dl.append(h("dt", {}, k), h("dd", {}, v === null || v === "" ? "—" : v));
    }
    return dl;
  }
  const json = (value) => h("pre", { class: "code" }, JSON.stringify(value, null, 2));

  /* ============================================================= overview */

  async function loadOverview() {
    const [overview, rates, audit, sys] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/traffic/rates?seconds=120"),
      api("/api/admin/audit?minLevel=warn&limit=12"),
      api("/api/admin/system"),
    ]);
    state.overview = overview;
    state.counts = overview.counts;
    state.rates = rates.rates || [];
    state.system = sys.history || [];
    state.problems = audit.entries || [];
    renderKpis();
    renderTrafficChart($("#chartTraffic"), $("#trafficLegend"), 120);
    const hist = state.system;
    lineChart($("#chartMemory"), $("#memLegend"), [
      { name: "RSS", color: COLORS.a, values: hist.map((x) => x.rss) },
      { name: "heap used", color: COLORS.b, values: hist.map((x) => x.heapUsed) },
      { name: "external", color: COLORS.d, values: hist.map((x) => x.external) },
    ], bytes);
    const classes = Object.entries((overview.traffic && overview.traffic.classes) || {}).sort((a, b) => b[1].frames - a[1].frames);
    bars($("#classBars"), classes.map(([name, c]) => [name, c.frames, c.errors ? "err" : ""]), num);
    renderHealth(overview);
    renderProblems();
  }

  function kpi(label, value, sub, tone) {
    return h("div", { class: `kpi${tone ? " is-" + tone : ""}` },
      h("div", { class: "kpi__label" }, label),
      h("div", { class: "kpi__value" }, value),
      sub ? h("div", { class: "kpi__sub" }, sub) : null);
  }

  function renderKpis() {
    const o = state.overview || {};
    const c = state.counts || o.counts || {};
    const minute = (o.traffic && o.traffic.lastMinute) || {};
    const last = state.rates.length ? state.rates[state.rates.length - 1] : null;
    const latest = state.system.length ? state.system[state.system.length - 1] : (o.process && o.process.latest);
    const mem = (o.process && o.process.memory) || {};
    const q = o.queue || {};
    const container = $("#kpis");
    clear(container);
    container.append(
      kpi("Connections", num(c.connections), `${num(c.peers)} in ${num(c.rooms)} rooms`),
      kpi("Away members", num(c.away), "the server answers for them"),
      kpi("Accounts", num(c.accounts), `${num(c.activeSessions)} active sessions`),
      kpi("Frames / min", num(minute.framesIn + minute.framesOut), last ? `now ${last.framesIn + last.framesOut}/s` : "in + out"),
      kpi("Traffic / min", bytes((minute.bytesIn || 0) + (minute.bytesOut || 0)), `${bytes(minute.bytesIn)} in · ${bytes(minute.bytesOut)} out`),
      kpi("Errors / min", num(minute.errors), minute.errors ? "see live traffic" : "all clear", minute.errors ? "err" : ""),
      kpi("Heap", bytes(latest ? latest.heapUsed : mem.heapUsed), mem.heapLimit ? `of ${bytes(mem.heapLimit)}` : ""),
      kpi("Event loop p99", latest ? `${latest.loopP99} ms` : "—", latest ? `CPU ${latest.cpu}%` : "", latest && latest.loopP99 > 100 ? "warn" : ""),
      kpi("Queued messages", num((q.queued || 0) + (q.delivering || 0)), q.dead ? `${num(q.dead)} dead letters` : "no dead letters", q.dead ? "warn" : ""),
    );
    $("#navQueue").textContent = (q.queued || 0) + (q.delivering || 0) ? String((q.queued || 0) + (q.delivering || 0)) : "";
  }

  function renderHealth(o) {
    const checks = [];
    const storage = o.storage || {};
    const health = o.health || {};
    const latest = o.process && o.process.latest;
    const mem = (o.process && o.process.memory) || {};
    checks.push([storage.available ? "ok" : "warn", "Server-side storage", storage.available ? `${storage.engine}, ${num(storage.openDatabases)} open databases` : (storage.reason || "not available")]);
    checks.push([health.queuePersistent ? "ok" : "warn", "Offline queue", health.queuePersistent ? "persistent (SQLite)" : "in memory — lost on restart"]);
    checks.push(["ok", "Signaling protocol", `version ${health.protocol || "?"}`]);
    const cluster = (health.signaling && health.signaling.cluster) || null;
    if (cluster && cluster.kind !== "local") {
      const others = (cluster.instances || []).length;
      checks.push([cluster.connected ? (cluster.signed ? "ok" : "warn") : "err", "Cluster",
        `${cluster.kind}, ${cluster.connected ? "connected" : "DISCONNECTED"} · ${others} other instance${others === 1 ? "" : "s"} · ${cluster.signed ? "signed" : "UNSIGNED (set CLUSTER_SECRET)"}${cluster.dropped ? ` · ${num(cluster.dropped)} dropped` : ""}`]);
    } else if (cluster) {
      checks.push(["ok", "Cluster", "single instance"]);
    }
    if (latest) checks.push([latest.loopP99 > 200 ? "err" : latest.loopP99 > 50 ? "warn" : "ok", "Event loop", `p99 ${latest.loopP99 ?? 0} ms, mean ${latest.loopMean ?? 0} ms`]);
    if (mem.heapLimit) {
      const share = mem.heapUsed / mem.heapLimit;
      checks.push([share > 0.85 ? "err" : share > 0.6 ? "warn" : "ok", "Heap", `${share < 0.01 ? (share * 100).toFixed(2) : Math.round(share * 100)} % of the limit`]);
    }
    const auditStats = o.audit || {};
    checks.push([auditStats.communicationEnabled ? "warn" : "ok", "Communication audit", auditStats.communicationEnabled ? "ON — who reaches whom is being recorded" : "off (privacy default)"]);
    const container = $("#healthChecks");
    clear(container);
    for (const [tone, title, detail] of checks) {
      container.append(h("div", { class: "check" }, h("span", { class: `check__dot is-${tone}` }), h("b", {}, title), h("span", { class: "muted" }, detail)));
    }
  }

  function renderProblems() {
    const container = $("#recentProblems");
    if (!container) return;
    const fresh = state.audit.filter((e) => e.level === "warn" || e.level === "error");
    const list = [...fresh, ...(state.problems || [])].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i).slice(0, 8);
    clear(container);
    if (!list.length) { container.append(h("div", { class: "empty" }, "No warnings.")); return; }
    for (const e of list) {
      container.append(h("div", { class: "problem" }, badge(e.level, LEVEL_TONE[e.level]), " ", h("b", {}, e.event), " ", h("span", { class: "muted" }, `${ago(e.at)}${e.status ? " · " + e.status : ""}`)));
    }
  }

  /* ============================================================== traffic */

  async function loadTraffic() {
    const [data, rates] = await Promise.all([api("/api/admin/traffic?limit=1000"), api("/api/admin/traffic/rates?seconds=180")]);
    // Keep what the live feed already brought, add the history behind it.
    const seen = new Set(state.traffic.map((r) => r.id));
    state.traffic = [...state.traffic, ...(data.records || []).filter((r) => !seen.has(r.id))].sort((a, b) => b.id - a.id).slice(0, 3000);
    state.rates = rates.rates || state.rates;
    renderTraffic();
    renderTrafficChart($("#chartTraffic2"), $("#trafficLegend2"), 180);
  }

  function trafficMatches(r) {
    const cls = $("#fCls").value, ch = $("#fChannel").value, dir = $("#fDir").value, text = $("#fText").value.trim().toLowerCase();
    if (cls && r.cls !== cls) return false;
    if (ch && r.channel !== ch) return false;
    if (dir && r.direction !== dir) return false;
    if ($("#fErrors").checked && !(r.status === "error" || r.status === "dropped" || (typeof r.status === "number" && r.status >= 400))) return false;
    if (text) {
      const hay = [r.type, r.peerId, r.accountId, r.conn, r.ip, r.roomHash, r.target, r.note, r.status].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  }

  function renderTraffic() {
    const rows = state.traffic.filter(trafficMatches);
    const shown = rows.slice(0, 400);
    $("#trafficCount").textContent = `${num(shown.length)} of ${num(rows.length)} shown · ${num(state.traffic.length)} buffered${state.paused ? " · paused" : ""}`;
    fillTable($("#trafficTable"), shown.map((r) => [
      h("span", { class: "mono" }, time(r.at)),
      r.channel === "ws" ? badge("WS", "violet") : badge("HTTP", "info"),
      h("span", { class: r.direction === "in" ? "dir-in" : "dir-out" }, r.direction),
      badge(r.cls, CLASS_TONE[r.cls]),
      h("span", { class: "mono" }, r.type),
      bytes(r.bytes),
      h("span", { class: "mono small" }, [r.peerId ? short(r.peerId, 14) : "", r.accountId ? ` · ${short(r.accountId, 8)}` : ""]),
      h("span", { class: "mono small" }, r.roomHash ? short(r.roomHash, 8) : "—"),
      h("span", { class: "mono small" }, short(r.conn, 10)),
      [statusBadge(r.status), r.durationMs !== undefined ? h("span", { class: "muted small" }, ` ${r.durationMs} ms`) : null],
    ]), "No traffic matches.", (i) => openDrawer(`${shown[i].channel.toUpperCase()} ${shown[i].type}`, (body) => body.append(json(shown[i]))));
  }

  ["#fCls", "#fChannel", "#fDir", "#fErrors"].forEach((sel) => $(sel).addEventListener("change", renderTraffic));
  $("#fText").addEventListener("input", renderTraffic);
  $("#trafficPause").addEventListener("click", (e) => {
    state.paused = !state.paused;
    e.currentTarget.textContent = state.paused ? "Resume" : "Pause";
    renderTraffic();
  });
  $("#trafficClear").addEventListener("click", () => { state.traffic = []; renderTraffic(); });

  /* ========================================================== connections */

  async function loadConnections() {
    const data = await api("/api/admin/connections");
    const list = data.connections || [];
    fillTable($("#connTable"), list.map((c) => [
      h("span", { class: "mono small" }, c.id),
      c.name || "—",
      h("span", { class: "mono small" }, short(c.peerId, 14)),
      c.accountId ? h("span", { class: "mono small" }, short(c.accountId, 10)) : h("span", { class: "muted" }, "anonymous"),
      h("span", { class: "mono small" }, c.roomHash ? short(c.roomHash, 8) : "—"),
      [c.client, c.protocol ? h("span", { class: "muted small" }, ` · v${c.protocol}`) : null, c.away ? [" ", badge("away", "warn")] : null],
      h("span", { class: "mono small" }, c.ip),
      `${num(c.framesIn)} · ${bytes(c.bytesIn)}`,
      `${num(c.framesOut)} · ${bytes(c.bytesOut)}`,
      ago(c.openedAt),
      ago(c.lastSeenAt),
      h("button", { class: "btn btn--sm btn--danger", onclick: async () => {
        if (!confirm(`Disconnect ${c.name || c.id}? The client will reconnect unless it was abusive.`)) return;
        try { await api(`/api/admin/connections/${encodeURIComponent(c.id)}/close`, { method: "POST", body: {} }); toast("Disconnected.", "ok"); loadConnections(); } catch (e) { toast(e.message, "err"); }
      } }, "Disconnect"),
    ]), "No open connections.", (i) => openDrawer(`Connection ${list[i].id}`, (body) => {
      body.append(kv(h("dl", { class: "kv" }), Object.entries(list[i]).map(([k, v]) => [k, typeof v === "number" && /At$/.test(k) ? dateTime(v) : String(v)])));
      const recent = state.traffic.filter((r) => r.conn === list[i].id).slice(0, 50);
      body.append(h("h3", {}, "Recent frames"), recent.length ? json(recent) : h("div", { class: "empty" }, "None buffered."));
    }));
  }

  /* ================================================================ rooms */

  async function loadRooms() {
    const data = await api("/api/admin/rooms");
    const rooms = data.rooms || [];
    const peers = rooms.reduce((n, r) => n + r.peers.length, 0);
    const away = rooms.reduce((n, r) => n + r.away.length, 0);
    const container = $("#roomKpis");
    clear(container);
    container.append(kpi("Rooms", num(rooms.length)), kpi("Members online", num(peers)), kpi("Members away", num(away)),
      kpi("Largest room", num(Math.max(0, ...rooms.map((r) => r.peers.length + r.away.length)))));
    const cards = $("#roomCards");
    clear(cards);
    if (!rooms.length) cards.append(h("div", { class: "card empty" }, "No rooms are open."));
    for (const r of rooms.sort((a, b) => b.peers.length - a.peers.length)) {
      const list = h("div", { class: "stack small" });
      for (const p of r.peers) {
        list.append(h("div", { class: "row" }, h("b", {}, p.name), h("span", { class: "mono muted" }, short(p.peerId, 14)),
          p.accountId ? badge("account", "ok") : badge("guest"), p.away ? badge("page hidden", "warn") : null,
          p.protocol ? h("span", { class: "muted" }, `v${p.protocol}`) : null, h("span", { class: "spacer" }), h("span", { class: "muted" }, ago(p.joinedAt))));
      }
      for (const a of r.away) list.append(h("div", { class: "row" }, h("b", {}, a.name), badge("away · relayed", "warn"), h("span", { class: "spacer" }), h("span", { class: "muted" }, `since ${ago(a.since)}`)));
      cards.append(h("div", { class: "card" },
        h("div", { class: "card__head" }, h("div", { class: "card__title mono" }, `room ${r.roomHash}`), h("div", { class: "card__actions" }, badge(`${r.peers.length} online`, "accent"), r.away.length ? badge(`${r.away.length} away`, "warn") : null)),
        list));
    }
  }

  /* ================================================================ users */

  let users = [];
  async function loadUsers() {
    const data = await api("/api/admin/users");
    users = data.users || [];
    renderUsers();
  }
  function renderUsers() {
    const q = $("#userFilter").value.trim().toLowerCase();
    const list = users.filter((u) => !q || u.userName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q));
    fillTable($("#userTable"), list.map((u) => [
      h("b", {}, u.userName || "—"),
      h("span", { class: "mono small" }, u.id),
      dateTime(u.createdAt),
      ago(u.lastLoginAt),
      num(u.loginCount),
      h("span", { class: "small" }, [algName(u.alg), h("span", { class: "muted" }, ` · #${num(u.signCount)}`)]),
      u.database ? [badge(u.database.keyMode, "violet"), " ", u.database.open ? badge("open", "ok") : badge("locked")] : h("span", { class: "muted" }, "—"),
      bytes((u.vault && (u.vault.profileBytes + u.vault.chatBytes)) || 0),
      num(u.queue ? (u.queue.queued !== undefined ? u.queue.queued + u.queue.delivering : u.queue.pending) : 0),
      u.away && u.away.length ? badge(`${u.away.length} rooms`, "warn") : h("span", { class: "muted" }, "—"),
      num(u.sessions),
    ]), "No accounts yet.", (i) => openUser(list[i].id));
  }
  $("#userFilter").addEventListener("input", renderUsers);
  const algName = (alg) => ({ "-7": "ES256", "-8": "EdDSA", "-257": "RS256" })[String(alg)] || String(alg);

  async function openUser(id) {
    let detail;
    try { detail = await api(`/api/admin/users/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, "err"); return; }
    const u = detail.user || {};
    openDrawer(`${u.userName || "Account"} · ${id}`, (body) => {
      body.append(kv(h("dl", { class: "kv" }), [
        ["Account id", h("span", { class: "mono" }, id)],
        ["Created", dateTime(u.createdAt)],
        ["Last sign-in", `${dateTime(u.lastLoginAt)} (${ago(u.lastLoginAt)})`],
        ["Sign-ins", num(u.loginCount)],
        ["Open sessions", num(u.sessions)],
        ["Vault", `${bytes(u.vault && u.vault.profileBytes)} profile · ${bytes(u.vault && u.vault.chatBytes)} chat · ${num(u.vault && u.vault.messages)} messages`],
        ["Database", u.database ? `${u.database.id} · ${u.database.keyMode} · ${bytes(u.database.bytes)} · ${u.database.open ? "open" : "locked"}` : "none"],
        ["Push devices", num(u.pushDevices)],
        ["Away in", u.away && u.away.length ? u.away.map((a) => `${a.name} (${ago(a.since)})`).join(", ") : "—"],
      ]));
      body.append(h("div", { class: "row" },
        h("button", { class: "btn", onclick: async () => {
          if (!confirm("Sign this account out on every device? Open sockets lose the account at once.")) return;
          try { await api(`/api/admin/users/${encodeURIComponent(id)}/signout`, { method: "POST", body: {} }); toast("Signed out everywhere.", "ok"); openUser(id); } catch (e) { toast(e.message, "err"); }
        } }, "Sign out everywhere"),
        h("button", { class: "btn btn--danger", onclick: async () => {
          const typed = prompt(`Delete the account, its vault, database and queued messages — for good.\nType the account id to confirm:\n${id}`);
          if (typed !== id) { if (typed !== null) toast("The id did not match; nothing was deleted.", "err"); return; }
          try { await api(`/api/admin/users/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`, { method: "DELETE" }); toast("Account deleted.", "ok"); closeDrawer(); loadUsers(); } catch (e) { toast(e.message, "err"); }
        } }, "Delete account…")));
      const section = (title, content) => body.append(h("h3", {}, title), content);
      const t = (cols, rows, empty) => {
        const table = h("table", { class: "t" }, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c)))), h("tbody"));
        fillTable(table, rows, empty);
        return h("div", { class: "table-wrap table-wrap--short" }, table);
      };
      section("Passkeys", t(["Credential", "Algorithm", "Counter", "Created", "Last used"], (detail.passkeys || []).map((p) => [h("span", { class: "mono small" }, short(p.credentialId, 18)), algName(p.alg), num(p.signCount), dateTime(p.createdAt), ago(p.lastUsedAt)]), "Only in the account file (storage off)."));
      section("Queued for this account", t(["Room", "Seq", "Kind", "From", "State", "Tries", "Stored", "Size"], (detail.queue || []).map((q) => [h("span", { class: "mono small" }, short(q.room, 12)), num(q.seq), q.kind, q.from, statusBadge(q.state), num(q.attempts), ago(q.storedAt), bytes(q.bytes)]), "Nothing waiting."));
      section("Account audit (what the user sees)", t(["When", "Event", "Details"], (detail.audit || []).map((a) => [dateTime(a.at), a.kind, h("span", { class: "mono small" }, a.meta ? JSON.stringify(a.meta) : "")]), "No entries."));
      section("Journal", t(["When", "Level", "Event", "Status"], (detail.journal || []).map((e) => [time(e.at), badge(e.level, LEVEL_TONE[e.level]), e.event, statusBadge(e.status)]), "No journal entries in memory."));
      section("Traffic", t(["When", "Class", "Type", "Bytes", "Status"], (detail.traffic || []).map((r) => [time(r.at), badge(r.cls, CLASS_TONE[r.cls]), h("span", { class: "mono" }, r.type), bytes(r.bytes), statusBadge(r.status)]), "No buffered traffic."));
    });
  }

  /* ================================================================ queue */

  async function loadQueue() {
    const [data, dead] = await Promise.all([api("/api/admin/queue"), api("/api/admin/queue/dead?limit=200")]);
    const st = data.stats || {};
    const container = $("#queueKpis");
    clear(container);
    container.append(
      kpi("Queued", num(st.queued), "waiting for their recipient"),
      kpi("Being delivered", num(st.delivering), "handed over, not yet acknowledged"),
      kpi("Dead letters", num(st.dead), "expired or never acknowledged", st.dead ? "warn" : ""),
      kpi("Size", bytes(st.bytes), st.oldestAt ? `oldest ${ago(st.oldestAt)}` : "empty"),
      kpi("Store", data.available ? (data.persistent ? "SQLite" : "memory") : "—", data.persistent ? "survives restarts" : "lost on restart", data.persistent ? "" : "warn"),
    );
    fillTable($("#queueTable"), (data.accounts || []).map((a) => [
      [h("b", {}, a.userName || "—"), " ", h("span", { class: "mono muted small" }, short(a.accountId, 10))],
      num(a.queued), num(a.delivering), a.dead ? h("span", { class: "warn" }, num(a.dead)) : "0", bytes(a.bytes), num(a.rooms), ago(a.oldestAt),
    ]), "No mailbox has anything in it.");
    fillTable($("#deadTable"), (dead.items || []).map((d) => [
      dateTime(d.storedAt),
      h("span", { class: "mono small" }, short(d.accountId, 10)),
      h("span", { class: "mono small" }, short(d.room, 12)),
      d.from ? d.from.name : "—",
      d.kind, num(d.attempts),
      h("span", { class: "small" }, d.deadReason || "—"),
      h("button", { class: "btn btn--sm", onclick: async () => {
        try { await api(`/api/admin/queue/${encodeURIComponent(d.id)}/revive`, { method: "POST", body: {} }); toast("Back in the queue.", "ok"); loadQueue(); } catch (e) { toast(e.message, "err"); }
      } }, "Revive"),
    ]), "No dead letters.");
  }

  /* ============================================================== storage */

  async function loadStorage() {
    loadBackups().catch((e) => toast(`Backups: ${e.message}`, "err"));
    const data = await api("/api/admin/db");
    const container = $("#dbKpis");
    clear(container);
    if (!data.available) {
      container.append(kpi("Storage", "off", data.reason || "not available", "warn"));
      kv($("#dbGlobal"), [["Reason", data.reason || "—"]]);
      fillTable($("#dbTables"), [], "—");
      fillTable($("#dbIndex"), [], "Storage is not running.");
      return;
    }
    const st = data.status || {};
    const g = data.global || {};
    const dbs = data.databases || [];
    container.append(
      kpi("Engine", st.engine || "—", st.dir ? h("span", { class: "mono" }, st.dir) : ""),
      kpi("Global database", bytes(g.bytes), `WAL ${bytes(g.walBytes)}`),
      kpi("User databases", num(dbs.length), `${num(dbs.filter((d) => d.ownerKind === "account").length)} accounts · ${num(dbs.filter((d) => d.ownerKind === "session").length)} sessions`),
      kpi("Open now", num(st.openDatabases), `${num(st.heldKeys)} keys in memory`),
      kpi("On disk", bytes(dbs.reduce((n, d) => n + (d.bytes || 0), 0)), "encrypted user databases"),
    );
    kv($("#dbGlobal"), [
      ["File", h("span", { class: "mono" }, g.file || "—")],
      ["Size", `${bytes(g.bytes)} + WAL ${bytes(g.walBytes)}`],
      ["Pages", `${num(g.pageCount)} × ${bytes(g.pageSize)} · ${num(g.freelist)} free`],
      ["Journal", g.journalMode || "—"],
      ["Totals", st.stats ? Object.entries(st.stats).map(([k, v]) => `${k} ${num(v)}`).join(" · ") : "—"],
    ]);
    fillTable($("#dbTables"), (g.tables || []).map((t) => [h("span", { class: "mono" }, t.name), num(t.rows)]), "No tables.");
    fillTable($("#dbIndex"), dbs.map((d) => [
      h("span", { class: "mono small" }, short(d.id, 14)),
      h("span", { class: "mono small" }, short(d.ownerId, 12)),
      d.ownerKind === "account" ? badge("account", "ok") : badge("session", "info"),
      badge(d.keyMode, "violet"),
      bytes(d.bytes),
      dateTime(d.createdAt),
      ago(d.lastOpenedAt),
      d.expiresAt ? ago(d.expiresAt) : "never",
    ]), "No user databases.");
  }

  async function loadBackups() {
    const b = await api("/api/admin/backups");
    if (!b.available) {
      kv($("#dbBackupInfo"), [["Backups", "storage is not running"]]);
      fillTable($("#dbBackups"), [], "—");
      return;
    }
    const integrity = b.integrity;
    kv($("#dbBackupInfo"), [
      ["Directory", h("span", { class: "mono small" }, b.dir)],
      ["Schedule", b.scheduled ? `every ${b.intervalHours} h, keep ${b.keep}` : "manual only (set BACKUP_DIR to schedule)"],
      ["Last backup", b.last ? (b.last.ok ? `${b.last.name} · ${bytes(b.last.bytes)} · ${b.last.ms} ms` : h("span", { class: "err" }, b.last.error)) : "—"],
      ["Integrity", integrity ? h("span", { class: integrity.ok ? "ok" : "err" }, `${integrity.ok ? "ok" : "problems"} · global ${integrity.global} · ${integrity.databases.length} open checked · ${integrity.locked} locked · ${ago(integrity.at)}`) : "not checked yet"],
    ]);
    fillTable($("#dbBackups"), (b.backups || []).map((x) => [h("span", { class: "mono small" }, x.name), dateTime(x.at), num(x.files), bytes(x.bytes)]), "No backups yet.");
  }

  $("#dbBackup").addEventListener("click", async () => {
    toast("Backing up…");
    try { const r = await api("/api/admin/backups", { method: "POST", body: {} }); toast(`Backup ${r.name}: ${num(r.files)} files, ${bytes(r.bytes)}.`, "ok"); loadBackups(); } catch (e) { toast(`Backup failed: ${e.message}`, "err"); }
  });
  $("#dbIntegrity").addEventListener("click", async () => {
    try { const r = await api("/api/admin/db/integrity", { method: "POST", body: {} }); toast(r.integrity.ok ? "Integrity check: ok." : "Integrity check found problems.", r.integrity.ok ? "ok" : "err"); loadBackups(); } catch (e) { toast(e.message, "err"); }
  });
  $("#dbOptimize").addEventListener("click", async () => {
    try { const r = await api("/api/admin/db/optimize", { method: "POST", body: {} }); toast(`Optimized (${bytes(r.before)} → ${bytes(r.after)}).`, "ok"); } catch (e) { toast(e.message, "err"); }
  });
  $("#dbVacuum").addEventListener("click", async () => {
    if (!confirm("VACUUM rewrites the whole global database; writes wait until it finishes. Continue?")) return;
    try { const r = await api("/api/admin/db/optimize", { method: "POST", body: { vacuum: true } }); toast(`VACUUM done (${bytes(r.before)} → ${bytes(r.after)}).`, "ok"); loadStorage(); } catch (e) { toast(e.message, "err"); }
  });

  /* ================================================================ audit */

  function auditQuery() {
    const params = new URLSearchParams();
    if ($("#aCat").value) params.set("category", $("#aCat").value);
    if ($("#aLevel").value) params.set("minLevel", $("#aLevel").value);
    if ($("#aText").value.trim()) params.set("q", $("#aText").value.trim());
    return params;
  }

  async function loadAudit() {
    $("#navAudit").textContent = "";
    const params = auditQuery();
    params.set("limit", "1000");
    if (state.auditSource === "db") params.set("source", "db");
    const data = await api(`/api/admin/audit?${params}`);
    if (state.auditSource === "memory") {
      const seen = new Set(state.audit.map((e) => e.id));
      state.audit = [...state.audit, ...(data.entries || []).filter((e) => !seen.has(e.id))].sort((a, b) => b.id - a.id).slice(0, 2000);
    } else {
      state.dbAudit = data.entries || [];
    }
    $("#auditComm").checked = Boolean(data.stats && data.stats.communicationEnabled);
    renderAudit();
  }

  const LEVELS = ["debug", "info", "notice", "warn", "error"];
  function renderAudit() {
    const cat = $("#aCat").value, min = $("#aLevel").value, text = $("#aText").value.trim().toLowerCase();
    const source = state.auditSource === "db" ? state.dbAudit || [] : state.audit;
    const rows = source.filter((e) => (!cat || e.category === cat)
      && (!min || LEVELS.indexOf(e.level) >= LEVELS.indexOf(min))
      && (!text || JSON.stringify(e).toLowerCase().includes(text)));
    const shown = rows.slice(0, 500);
    $("#auditCount").textContent = `${num(shown.length)} of ${num(rows.length)}`;
    fillTable($("#auditTable"), shown.map((e) => [
      h("span", { class: "mono" }, `${dateTime(e.at).slice(5)}:${pad(new Date(e.at).getSeconds())}`),
      badge(e.level, LEVEL_TONE[e.level]),
      e.category,
      h("b", {}, e.event),
      h("span", { class: "mono small" }, short(e.actor || e.peerId || e.accountId, 14)),
      h("span", { class: "mono small" }, short(e.target, 14)),
      h("span", { class: "mono small" }, e.roomHash ? short(e.roomHash, 8) : "—"),
      e.bytes !== undefined ? bytes(e.bytes) : "",
      statusBadge(e.status),
    ]), "No entries match.", (i) => openDrawer(`${shown[i].category} · ${shown[i].event}`, (body) => body.append(json(shown[i]))));
  }
  ["#aCat", "#aLevel"].forEach((sel) => $(sel).addEventListener("change", () => (state.auditSource === "db" ? loadAudit() : renderAudit())));
  $("#aText").addEventListener("input", () => { if (state.auditSource === "memory") renderAudit(); });
  $("#aText").addEventListener("change", () => { if (state.auditSource === "db") loadAudit(); });
  $("#aSource").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-src]");
    if (!button) return;
    state.auditSource = button.dataset.src;
    $$("#aSource button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    loadAudit().catch((e) => toast(e.message, "err"));
  });
  $("#auditComm").addEventListener("change", async (event) => {
    const on = event.target.checked;
    if (on && !confirm("Record who reaches whom (metadata only, never content) in the audit journal? Only do this with a lawful reason; users are not told.")) { event.target.checked = false; return; }
    try { await api("/api/admin/audit/settings", { method: "PUT", body: { communication: on } }); toast(`Communication auditing ${on ? "on" : "off"}.`, "ok"); } catch (e) { event.target.checked = !on; toast(e.message, "err"); }
  });
  async function download(path, fallbackName) {
    try {
      const res = await fetch(state.base + path, { headers: { Authorization: `Bearer ${state.token}` }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = (/filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "") || [])[1] || fallbackName;
      const a = h("a", { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { toast(`Export failed: ${e.message}`, "err"); }
  }
  $("#auditVerify").addEventListener("click", async () => {
    try {
      const r = await api("/api/admin/audit/verify");
      if (!r.available) { toast("The journal is kept in memory only (no storage): nothing to verify.", "err"); return; }
      toast(r.intact ? `Journal intact: ${num(r.checked)} chained rows, ${num(r.signedCheckpoints)} signed checkpoints.` : `Journal NOT intact: ${r.problems.length} problems — see details.`, r.intact ? "ok" : "err");
      openDrawer("Journal integrity", (body) => {
        body.append(kv(h("dl", { class: "kv" }), [
          ["Result", r.intact ? h("span", { class: "ok" }, "intact") : h("span", { class: "err" }, "problems found")],
          ["Chained rows", num(r.checked)],
          ["Rows before the chain", num(r.unchained)],
          ["Checkpoints", `${num(r.signedCheckpoints)} of ${num(r.checkpoints)} signatures valid`],
          ["Last checkpoint", r.lastCheckpoint ? `row ${r.lastCheckpoint.lastId} · ${dateTime(r.lastCheckpoint.at)}` : "—"],
          ["Signing key (Ed25519)", h("span", { class: "mono small" }, r.publicKey)],
        ]));
        if (r.problems.length) body.append(json(r.problems));
      });
    } catch (e) { toast(e.message, "err"); }
  });
  $("#auditCsv").addEventListener("click", (e) => { e.preventDefault(); const p = auditQuery(); p.set("format", "csv"); download(`/api/admin/audit/export?${p}`, "m5cet-audit.csv"); });
  $("#auditJson").addEventListener("click", (e) => { e.preventDefault(); const p = auditQuery(); p.set("format", "json"); download(`/api/admin/audit/export?${p}`, "m5cet-audit.json"); });

  /* =============================================================== system */

  async function loadSystem() {
    const data = await api("/api/admin/system");
    state.system = data.history || [];
    const snap = data.snapshot || {};
    const mem = snap.memory || {};
    const host = snap.host || {};
    const latest = state.system[state.system.length - 1] || snap.latest || {};
    const container = $("#sysKpis");
    clear(container);
    container.append(
      kpi("RSS", bytes(mem.rss), `host free ${bytes(host.freeMem)} of ${bytes(host.totalMem)}`),
      kpi("Heap used", bytes(mem.heapUsed), `total ${bytes(mem.heapTotal)} · limit ${bytes(mem.heapLimit)}`, mem.heapLimit && mem.heapUsed / mem.heapLimit > 0.7 ? "warn" : ""),
      kpi("External + buffers", bytes(mem.external), `array buffers ${bytes(mem.arrayBuffers)}`),
      kpi("Event loop p99", `${latest.loopP99 ?? "—"} ms`, `mean ${latest.loopMean ?? 0} ms`, latest.loopP99 > 100 ? "warn" : ""),
      kpi("CPU", `${latest.cpu ?? "—"} %`, `load ${(host.load || []).join(" / ")} on ${num(host.cpus)} cores`),
      kpi("Uptime", duration(snap.uptimeSec || 0), `since ${dateTime(snap.startedAt)}`),
    );
    renderSystemCharts();
    kv($("#sysProcess"), [
      ["PID", String(snap.pid)], ["Node", snap.node], ["Platform", snap.platform],
      ["Malloced", bytes(mem.mallocedMemory)], ["Detached contexts", num(mem.detachedContexts)],
      ["Started", dateTime(snap.startedAt)],
    ]);
    bars($("#sysResources"), Object.entries(snap.resources || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]), num);
  }

  function renderSystemCharts() {
    const hist = state.system;
    lineChart($("#chartSysMem"), $("#sysMemLegend"), [
      { name: "RSS", color: COLORS.a, values: hist.map((x) => x.rss) },
      { name: "heap total", color: COLORS.f, values: hist.map((x) => x.heapTotal) },
      { name: "heap used", color: COLORS.b, values: hist.map((x) => x.heapUsed) },
    ], bytes);
    lineChart($("#chartSysLoop"), $("#sysLoopLegend"), [
      { name: "loop p99 ms", color: COLORS.c, values: hist.map((x) => x.loopP99) },
      { name: "loop mean ms", color: COLORS.d, values: hist.map((x) => x.loopMean) },
      { name: "CPU %", color: COLORS.e, values: hist.map((x) => x.cpu) },
    ], (v) => (Math.round(v * 10) / 10).toString());
  }

  /* ============================================================ retention */

  async function loadRetention() {
    const data = await api("/api/admin/retention");
    const policy = data.policy || {};
    kv($("#retentionPolicy"), [
      ...Object.entries(policy).map(([k, v]) => [k, typeof v === "number" ? `${v} days` : String(v)]),
      ["Sweep every", `${data.intervalMinutes} minutes${data.scheduled ? "" : " (not scheduled)"}`],
      ["Next sweep", data.nextSweepAt ? `${dateTime(data.nextSweepAt)} (${ago(data.nextSweepAt)})` : "—"],
    ]);
    $("#retentionLast").textContent = data.lastSweep ? JSON.stringify(data.lastSweep, null, 2) : "No sweep yet.";
  }
  $("#retentionRun").addEventListener("click", async () => {
    if (!confirm("Delete everything older than the retention policy now?")) return;
    try {
      const result = await api("/api/admin/retention/run", { method: "POST", body: {} });
      $("#retentionLast").textContent = JSON.stringify(result, null, 2);
      toast("Sweep finished.", "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  /* ============================================================= commands */

  async function loadCommands() {
    const [cmds, push] = await Promise.all([api("/api/admin/commands?limit=200"), api("/api/admin/push")]);
    const select = $("#cmdKindNew");
    if (!select.options.length) for (const kind of cmds.allowlist || []) select.append(h("option", { value: kind }, kind));
    fillTable($("#cmdPending"), (cmds.pending || []).flatMap((p) => p.commands.map((c) => [h("span", { class: "mono small" }, p.deviceId), c.kind, ago(c.createdAt), h("span", { class: "mono small" }, short(c.id, 16))])), "Nothing waiting.");
    fillTable($("#cmdAudit"), (cmds.audit || []).map((a) => [time(a.ts), badge(a.kind, a.kind === "ack" ? "ok" : a.kind === "deliver" ? "info" : ""), h("span", { class: "mono small" }, short(a.commandId, 16)), h("span", { class: "mono small" }, short(a.deviceId, 16)), h("span", { class: "mono small" }, short(a.peerId, 14)), a.result || ""]), "No commands yet.");
    kv($("#pushStatus"), [
      ["VAPID", push.ready ? h("span", { class: "ok" }, "configured") : h("span", { class: "err" }, "not configured (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)")],
      ["Anonymous subscribers", num((push.subscribers || []).length)],
      ["Account devices", num(push.accounts)],
    ]);
    fillTable($("#pushSubs"), (push.subscribers || []).map((sub) => [
      h("span", { class: "mono small" }, short(sub.id, 12)), sub.host, h("span", { class: "mono small" }, sub.deviceId || "—"), ago(sub.createdAt),
      sub.keys ? badge("ok", "ok") : badge("missing", "warn"),
      h("button", { class: "btn btn--sm", disabled: !push.ready || undefined, onclick: () => sendPush(sub.id) }, "Test"),
    ]), "No anonymous subscribers.");
  }

  async function sendPush(id) {
    try {
      const result = await api("/api/admin/push/test", { method: "POST", body: { ...(id ? { id } : {}), title: $("#pushTitleNew").value, body: $("#pushBodyNew").value } });
      const ok = (result.results || []).filter((r) => r.ok).length;
      $("#pushResult").textContent = `${ok} of ${(result.results || []).length} delivered`;
      toast(`Push: ${ok} of ${(result.results || []).length} delivered.`, ok ? "ok" : "err");
    } catch (e) { toast(e.message, "err"); }
  }
  $("#pushForm").addEventListener("submit", (e) => { e.preventDefault(); sendPush(null); });
  $("#cmdForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    let payload;
    const raw = $("#cmdPayloadNew").value.trim();
    if (raw) { try { payload = JSON.parse(raw); } catch (e) { toast(`Payload is not JSON: ${e.message}`, "err"); return; } }
    try {
      const result = await api("/api/admin/commands", { method: "POST", body: { kind: $("#cmdKindNew").value, deviceId: $("#cmdDevice").value.trim(), ...(payload ? { payload } : {}) } });
      $("#cmdResult").textContent = result.delivered ? "delivered now" : "queued until the device connects";
      toast(result.delivered ? "Delivered to the connected device." : "Queued for the device.", "ok");
      loadCommands();
    } catch (e) { toast(e.message, "err"); }
  });

  /* =============================================================== alerts */

  async function loadAlerts() {
    const r = await api("/api/admin/alerts");
    $("#navAlerts").textContent = r.active.length ? String(r.active.length) : "";
    $("#alertWebhook").textContent = r.webhook ? "Webhook: ALERT_WEBHOOK_URL is set." : "No webhook (set ALERT_WEBHOOK_URL to be told elsewhere).";
    const active = $("#alertActive");
    clear(active);
    if (!r.active.length) active.append(h("div", { class: "empty" }, "Nothing is firing."));
    for (const a of r.active) active.append(h("div", { class: "problem" }, badge("firing", "err"), " ", h("b", {}, a.message), " ", h("span", { class: "muted" }, `since ${ago(a.since)}`)));
    const states = new Map((r.states || []).map((st) => [st.rule, st]));
    fillTable($("#alertRules"), r.rules.map((rule) => {
      const st = states.get(rule.id);
      const input = h("input", { class: "input", type: "number", min: "0", step: "1", value: String(rule.threshold), style: "width:110px" });
      input.addEventListener("change", () => saveRule(rule.id, { threshold: Number(input.value) }));
      const toggle = h("input", { type: "checkbox", checked: rule.enabled || undefined });
      toggle.addEventListener("change", () => saveRule(rule.id, { enabled: toggle.checked }));
      return [h("b", {}, rule.label), st ? `${st.value}${rule.unit}` : "—", [input, ` ${rule.unit}`], h("label", { class: "switch" }, toggle)];
    }), "No rules.");
    fillTable($("#alertHistory"), (r.history || []).map((x) => [dateTime(x.at), x.rule, x.firing ? badge("fired", "err") : badge("resolved", "ok"), x.message]), "Nothing happened yet.");
  }

  async function saveRule(id, patch) {
    try { await api(`/api/admin/alerts/rules/${encodeURIComponent(id)}`, { method: "PUT", body: patch }); toast("Rule saved.", "ok"); } catch (e) { toast(e.message, "err"); }
  }

  /* ====================================================== client & addons */

  let clientCfg = null;
  let clientCatalog = { themes: [], icons: [] };

  async function loadClient() {
    const r = await api("/api/admin/client-config");
    clientCfg = r.config;
    clientCatalog = r.catalog || clientCatalog;
    renderClient(r);
  }

  function renderClient(r) {
    const c = r.config;
    $("#clientFile").textContent = r.file ? `Stored in ${r.file}` : "";
    const usage = $("#clientUsage");
    clear(usage);
    const u = r.usage || { accounts: 0, withConnections: 0, savedConnections: 0 };
    usage.append(
      kpi("Accounts", num(u.accounts), "passkey accounts"),
      kpi("With saved connections", num(u.withConnections), u.accounts ? `${Math.round((u.withConnections / u.accounts) * 100)} % of accounts` : ""),
      kpi("Saved connections", num(u.savedConnections), "sealed in the users' vaults"),
    );
    $("#cxEnabled").checked = c.connections.enabled;
    $("#cxStats").checked = c.connections.stats;
    $("#cxAutoConnect").checked = c.connections.autoConnectDefault;
    $("#cxCustom").checked = c.connections.allowCustomServers;
    $("#cxMax").value = String(c.connections.maxProfiles);
    $("#cxLog").value = String(c.connections.logLimit);
    renderServers(c.connections.servers);

    const picks = $("#cxThemes");
    clear(picks);
    const families = [["system", "System look"], ["classic", "Classic"], ["studio", "Studio"]];
    for (const [family, title] of families) {
      const list = clientCatalog.themes.filter((t) => t.family === family);
      if (!list.length) continue;
      picks.append(h("div", { class: "theme-picks__family" }, h("div", { class: "label" }, title),
        h("div", { class: "row" }, list.map((t) => h("label", { class: "switch" },
          h("input", { type: "checkbox", value: t.id, checked: c.appearance.themes.length === 0 || c.appearance.themes.includes(t.id) || undefined, "data-theme-pick": "1" }),
          `${t.label}${t.tones.length > 1 ? " (light + dark)" : ""}`)))));
    }
    const def = $("#cxDefaultTheme");
    clear(def);
    for (const t of clientCatalog.themes) def.append(h("option", { value: t.id, selected: t.id === c.appearance.defaultTheme || undefined }, t.label));
    $("#cxDefaultTone").value = c.appearance.defaultTone;
    const icons = $("#cxDefaultIcons");
    clear(icons);
    for (const v of ["theme", ...(clientCatalog.icons || [])]) icons.append(h("option", { value: v, selected: v === c.appearance.defaultIcons || undefined }, v === "theme" ? "as the template" : v));
    $("#cxLock").checked = c.appearance.lockTheme;
  }

  function renderServers(servers) {
    fillTable($("#cxServers"), servers.map((srv, i) => [
      h("input", { class: "input", value: srv.label, "data-srv-label": String(i), placeholder: "EU" }),
      h("input", { class: "input mono", value: srv.url, "data-srv-url": String(i), placeholder: "wss://chat.example.org", style: "min-width:260px" }),
      h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: () => { const list = collectServers(); list.splice(i, 1); renderServers(list); } }, "Remove"),
    ]), "Only this server.");
    applyRoleGates($("#clientConnections"));
  }

  function collectServers() {
    return $$("[data-srv-url]").map((input) => ({
      label: ($(`[data-srv-label="${input.dataset.srvUrl}"]`) || {}).value || "",
      url: input.value.trim(),
    })).filter((s) => s.url);
  }

  async function saveClient(patch) {
    if (!clientCfg) return;
    const next = { ...clientCfg, ...patch };
    try {
      const r = await api("/api/admin/client-config", { method: "PUT", body: { config: next } });
      clientCfg = r.config;
      renderClient({ ...r, file: $("#clientFile").textContent.replace(/^Stored in /, "") });
      toast("Saved. Clients pick it up within five minutes (or on reload).", "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  $("#cxAddServer").addEventListener("click", () => renderServers([...collectServers(), { label: "", url: "" }]));
  $("#clientConnections").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveClient({ connections: {
      enabled: $("#cxEnabled").checked,
      stats: $("#cxStats").checked,
      autoConnectDefault: $("#cxAutoConnect").checked,
      allowCustomServers: $("#cxCustom").checked,
      maxProfiles: Number($("#cxMax").value) || 30,
      logLimit: Number($("#cxLog").value) || 0,
      servers: collectServers(),
    } });
  });
  $("#clientAppearance").addEventListener("submit", (event) => {
    event.preventDefault();
    const picked = $$("[data-theme-pick]").filter((i) => i.checked).map((i) => i.value);
    const all = picked.length === clientCatalog.themes.length;
    void saveClient({ appearance: {
      themes: all ? [] : picked,
      defaultTheme: $("#cxDefaultTheme").value,
      defaultTone: $("#cxDefaultTone").value,
      defaultIcons: $("#cxDefaultIcons").value,
      lockTheme: $("#cxLock").checked,
    } });
  });
  $("#cxReset").addEventListener("click", async () => {
    if (!confirm("Reset the client configuration to the defaults?")) return;
    try {
      const r = await api("/api/admin/client-config");
      await saveClient({ connections: r.defaults.connections, appearance: r.defaults.appearance });
    } catch (e) { toast(e.message, "err"); }
  });

  /* ======================================================= administrators */

  async function loadAdmins() {
    if (!can("owner")) return;
    renderAdmins((await api("/api/admin/admins")).admins || []);
  }

  function renderAdmins(admins) {
    fillTable($("#adminTable"), admins.map((a) => {
      const role = h("select", { class: "input", "data-read": "1", onchange: (e) => patchAdmin(a.name, { role: e.target.value }) },
        ["auditor", "operator", "owner"].map((r) => h("option", { value: r, selected: r === a.role || undefined }, r)));
      const tokens = h("div", { class: "stack small" }, a.tokens.map((t) => h("div", { class: "row" },
        h("span", { class: "mono" }, t.label), h("span", { class: "muted" }, t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"),
        h("button", { class: "btn btn--sm btn--danger", "data-read": "1", onclick: async () => {
          if (!confirm(`Revoke the token "${t.label}" of ${a.name}?`)) return;
          renderAdmins((await api(`/api/admin/admins/${encodeURIComponent(a.name)}/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" })).admins || []);
        } }, "Revoke"))));
      return [
        h("b", {}, a.name),
        role,
        a.disabled ? badge("disabled", "err") : badge("active", "ok"),
        [tokens, h("button", { class: "btn btn--sm", "data-read": "1", onclick: () => issueToken(a.name) }, "Issue token")],
        num(a.passkeys.length),
        dateTime(a.createdAt),
        h("div", { class: "row" },
          h("button", { class: "btn btn--sm", "data-read": "1", onclick: () => patchAdmin(a.name, { disabled: !a.disabled }) }, a.disabled ? "Enable" : "Disable"),
          h("button", { class: "btn btn--sm btn--danger", "data-read": "1", onclick: async () => {
            if (!confirm(`Remove the administrator ${a.name}? Their tokens and passkeys stop working.`)) return;
            renderAdmins((await api(`/api/admin/admins/${encodeURIComponent(a.name)}`, { method: "DELETE" })).admins || []);
          } }, "Remove")),
      ];
    }), "No console-made administrators yet (the environment tokens still work).");
  }

  async function patchAdmin(name, patch) {
    try { renderAdmins((await api(`/api/admin/admins/${encodeURIComponent(name)}`, { method: "PATCH", body: patch })).admins || []); toast("Saved.", "ok"); } catch (e) { toast(e.message, "err"); }
  }

  async function issueToken(name) {
    const label = prompt(`A label for the new token of ${name} (e.g. "laptop"):`, "token");
    if (label === null) return;
    try {
      const r = await api(`/api/admin/admins/${encodeURIComponent(name)}/tokens`, { method: "POST", body: { label } });
      const box = $("#adminNewToken");
      clear(box);
      append(box, [`New token for ${name} — copy it now, it is not shown again:\n`, h("b", {}, r.token)]);
      box.hidden = false;
      renderAdmins(r.admins || []);
    } catch (e) { toast(e.message, "err"); }
  }

  $("#adminCreate").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const r = await api("/api/admin/admins", { method: "POST", body: { name: $("#adminName").value.trim().toLowerCase(), role: $("#adminRole").value } });
      $("#adminName").value = "";
      renderAdmins(r.admins || []);
      toast("Administrator added. Issue them a token.", "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  /* ================================================================ start */

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.token) schedule("tick"); }, 150);
  });
  // Relative times on screen go stale; refresh the cheap ones.
  setInterval(() => { if (state.token && state.route === "overview") renderProblems(); }, 15000);

  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (saved && saved.token) {
      $("#loginBase").value = saved.base || location.origin;
      $("#loginRemember").checked = true;
      signIn(saved.base, saved.token, true).catch(() => signOut("The saved token no longer works. Sign in again."));
    }
  } catch { /* nothing saved */ }

  // What the console's other scripts (modules.js, menu-builder.js) use: the
  // same DOM helpers, the API with the token, role gates and routes of their own.
  window.M5Console = {
    api: (path, opts) => api(path, opts),
    /** A request with the signed-in token, answered as a Response (streams, audio, downloads). */
    raw: (path, init = {}) => fetch(state.base + path, { ...init, cache: "no-store", headers: { ...(init.headers || {}), Authorization: `Bearer ${state.token}` } }),
    toast, h, clear, $, $$, can, applyRoleGates,
    base: () => state.base,
    addRoute(name, entry) {
      ROUTES[name] = entry;
      if (location.hash === `#/${name}` && state.token) route(name);
    },
  };
})();
