// M5cet operator console — Notifications (6.7).
//
//   Channels    which ways the server may use, in what order (a user's own
//               order wins; a channel off here is never used), and whether
//               the server can use each (VAPID keys, FCM, the SMTP relay)
//   Templates   per kind (new message, mention, call, command result,
//               the operator's call-back, test): title and body in cs / en /
//               de with {variables} and [optional parts], the default and
//               the highest privacy level, icon, accent, grouping, sound,
//               vibration, "stays until opened", actions, the throttle —
//               and a live preview rendered by the server itself
//   E-mail      the SMTP relay (the password is sealed on the server and
//               never shown again) and a test mail
//   Test & log  a notification to an account through its channels; every
//               attempt with its outcome — no content (there is none)
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast, can } = C;

  const KINDS = ["message", "mention", "call", "function", "summon", "test"];
  const KIND_LABEL = { message: "New message", mention: "Mention", call: "Call", function: "Command result", summon: "Operator's call-back", test: "Test" };
  const CHANNEL_LABEL = { android: "Android app (FCM, sealed for the device)", webpush: "Web push (browsers)", email: "E-mail (SMTP)" };
  const PRIVACY = ["neutral", "sender", "room", "content"];
  const PRIVACY_LABEL = { neutral: "Neutral — nothing about who or where", sender: "Sender's name", room: "Sender and room (the device names the room)", content: "Content preview (only where the device decrypts)" };
  const LANGS = ["cs", "en", "de"];
  const VARS = "{app} {sender} {room} {count} {time} {preview} {channel} · {name|fallback} · [optional part]";

  let data = null;
  let draft = null;
  let tab = "channels";
  let kind = "message";
  let log = [];
  const sample = { lang: "en", privacy: "", sender: "Bob", room: "Team", preview: "Hi, got a minute?", count: "3" };
  const root = () => document.getElementById("notifyRoot");

  const pad = (n) => String(n).padStart(2, "0");
  const when = (t) => { if (!t) return "—"; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const badge = (text, tone) => h("span", { class: `badge${tone ? ` badge--${tone}` : ""}` }, text);
  const writable = () => can("operator");

  function select(options, value, attrs = {}) {
    const el = h("select", { class: "input", ...attrs });
    for (const o of options) el.append(h("option", { value: o.value, selected: o.value === value || undefined }, o.label));
    el.value = value; // the choice itself, not only the attribute
    return el;
  }
  function check(label, value, onchange, attrs = {}) {
    const input = h("input", { type: "checkbox", checked: value || undefined, disabled: !writable() || undefined, ...attrs });
    input.addEventListener("change", () => onchange(input.checked));
    return h("label", { class: "switch" }, input, label);
  }
  function field(label, control) { return h("div", { class: "field" }, h("label", {}, label), control); }

  /* ============================================================== loading */

  async function load() {
    try {
      data = await api("/api/admin/notify");
      draft = structuredClone(data.config);
      draft.email.pass = "";
      render();
      await loadLog();
    } catch (err) {
      toast(`Notifications: ${err.message}`, "err");
    }
  }
  async function loadLog() {
    try { log = (await api("/api/admin/notify/log?limit=200")).entries || []; } catch (err) { toast(err.message, "err"); }
    if (tab === "log") renderTab();
  }

  C.addRoute("notifications", ["Notifications", "Channels and their order, templates, privacy, e-mail, tests and the delivery log", load]);

  async function save() {
    try {
      const body = { ...draft, email: { ...draft.email } };
      if (!body.email.pass) delete body.email.pass; // "" keeps the stored password
      data = await api("/api/admin/notify", { method: "PUT", body });
      draft = structuredClone(data.config);
      draft.email.pass = "";
      render();
      toast("Notifications saved", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /* ================================================================ page */

  function render() {
    const box = root();
    if (!box || !data) return;
    clear(box);
    box.append(header(), tabs(), h("div", { id: "notifyTab", class: "stack" }));
    renderTab();
    C.applyRoleGates(box);
  }

  function kpi(label, value, sub, tone) {
    return h("div", { class: `kpi${tone ? ` is-${tone}` : ""}` }, h("div", { class: "kpi__label" }, label), h("div", { class: "kpi__value" }, String(value)), sub ? h("div", { class: "kpi__sub" }, sub) : null);
  }

  function header() {
    const s = data.stats || {};
    const st = data.store || {};
    return h("div", { class: "card" },
      h("div", { class: "row" },
        check("Send notifications", draft.enabled, (v) => { draft.enabled = v; }, { "data-testid": "notify-enabled" }),
        h("div", { class: "field" }, h("label", { for: "notifyAppName" }, "{app} — the name in notifications"),
          (() => { const i = h("input", { class: "input", id: "notifyAppName", value: draft.appName, maxlength: "40", disabled: !writable() || undefined }); i.addEventListener("input", () => { draft.appName = i.value; }); return i; })()),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn--primary", "data-min-role": "operator", "data-testid": "notify-save", onclick: () => void save() }, "Save"),
      ),
      h("div", { class: "grid grid--kpi" },
        kpi("Sent", s.sent ?? 0, "since the server started"),
        kpi("Failed", s.failed ?? 0, "every channel refused", (s.failed ?? 0) > 0 ? "warning" : ""),
        kpi("Not sent", s.skipped ?? 0, "present, off, quiet hours, throttled…"),
        kpi("Users who chose", st.accounts ?? 0, `${st.devices ?? 0} Android devices · ${st.confirmed ?? 0}/${st.emails ?? 0} e-mails confirmed`)),
      data.config.updatedAt ? h("div", { class: "muted small" }, `Last changed ${when(data.config.updatedAt)} by ${data.config.updatedBy || "—"}`) : null);
  }

  function tabs() {
    const bar = h("div", { class: "seg", role: "tablist" });
    for (const [id, label] of [["channels", "Channels"], ["templates", "Templates"], ["email", "E-mail"], ["limits", "Limits"], ["test", "Test & log"]]) {
      bar.append(h("button", { type: "button", role: "tab", "aria-pressed": tab === id ? "true" : "false", "data-read": "1", "data-testid": `notify-tab-${id}`, onclick: () => { tab = id; render(); if (id === "test") void loadLog(); } }, label));
    }
    return bar;
  }

  function renderTab() {
    const box = document.getElementById("notifyTab");
    if (!box) return;
    clear(box);
    if (tab === "channels") box.append(channelsCard());
    else if (tab === "templates") box.append(templatesCard());
    else if (tab === "email") box.append(emailCard());
    else if (tab === "limits") box.append(limitsCard());
    else box.append(testCard(), logCard());
    C.applyRoleGates(box);
  }

  /* ============================================================ channels */

  function channelsCard() {
    const list = h("div", { class: "stack" });
    draft.channels.forEach((c, i) => {
      const r = (data.channels || []).find((x) => x.id === c.id) || { ready: false, reason: "?" };
      const move = (by) => { const j = i + by; if (j < 0 || j >= draft.channels.length) return; const ch = draft.channels.slice(); [ch[i], ch[j]] = [ch[j], ch[i]]; draft.channels = ch; renderTab(); };
      list.append(h("div", { class: "row", "data-testid": `notify-ch-${c.id}` },
        h("span", { class: "mono" }, `${i + 1}.`),
        check(CHANNEL_LABEL[c.id] || c.id, c.on, (v) => { c.on = v; renderTab(); }, { "data-testid": `notify-ch-on-${c.id}` }),
        r.ready ? badge("ready", "ok") : badge(r.reason || "not set up", "warn"),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn--sm", disabled: i === 0 || !writable() || undefined, onclick: () => move(-1), "aria-label": "Up" }, "↑"),
        h("button", { type: "button", class: "btn btn--sm", disabled: i === draft.channels.length - 1 || !writable() || undefined, onclick: () => move(1), "aria-label": "Down" }, "↓")));
    });
    return h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Channels"),
        h("div", { class: "card__hint" }, "Tried in this order until one takes the notification (a user's own order wins, within what is on here). A failure — an HTTP error, a dead token, a timeout — moves on to the next; dead endpoints are dropped: a web push subscription answering 404/410 is removed, a refused e-mail address is cleared, an FCM token reported UNREGISTERED is cleared (the device stays registered until the app sends a new token), and a wiped or retired device is skipped.")),
      list,
      h("p", { class: "muted small" }, "Nothing the server sends carries a message's content: the server cannot read it. Android notifications are sealed for the one device (FCM sees ciphertext); web push is encrypted for the browser (RFC 8291); e-mail is plain — only what the user's privacy level allows."));
  }

  /* =========================================================== templates */

  function templatesCard() {
    const t = draft.templates[kind];
    const kinds = h("div", { class: "seg" });
    for (const k of KINDS) kinds.append(h("button", { type: "button", "aria-pressed": kind === k ? "true" : "false", "data-read": "1", "data-testid": `notify-kind-${k}`, onclick: () => { kind = k; renderTab(); } }, KIND_LABEL[k]));
    const texts = h("div", { class: "stack" });
    for (const lang of LANGS) {
      const title = h("input", { class: "input mono", value: t.title[lang] || "", maxlength: "300", disabled: !writable() || undefined, "data-testid": `notify-title-${lang}` });
      const body = h("input", { class: "input mono", value: t.body[lang] || "", maxlength: "300", disabled: !writable() || undefined, "data-testid": `notify-body-${lang}` });
      title.addEventListener("input", () => { t.title[lang] = title.value; schedulePreview(); });
      body.addEventListener("input", () => { t.body[lang] = body.value; schedulePreview(); });
      texts.append(h("div", { class: "form-grid" }, field(`Title (${lang})`, title), field(`Body (${lang})`, body)));
    }
    const priv = select(PRIVACY.map((p) => ({ value: p, label: PRIVACY_LABEL[p] })), t.privacy, { disabled: !writable() || undefined, "data-testid": "notify-privacy" });
    priv.addEventListener("change", () => { t.privacy = priv.value; schedulePreview(); });
    const max = select(PRIVACY.map((p) => ({ value: p, label: PRIVACY_LABEL[p] })), t.maxPrivacy, { disabled: !writable() || undefined, "data-testid": "notify-max-privacy" });
    max.addEventListener("change", () => { t.maxPrivacy = max.value; if (PRIVACY.indexOf(t.privacy) > PRIVACY.indexOf(t.maxPrivacy)) { t.privacy = t.maxPrivacy; priv.value = t.privacy; } schedulePreview(); });
    const icon = h("input", { class: "input mono", value: t.icon, maxlength: "40", placeholder: "lucide name, e.g. message-square", disabled: !writable() || undefined });
    icon.addEventListener("input", () => { t.icon = icon.value.trim(); schedulePreview(); });
    const accentOn = h("input", { type: "checkbox", checked: Boolean(t.accent) || undefined, disabled: !writable() || undefined });
    const accent = h("input", { class: "input input--color", type: "color", value: t.accent || "#2563eb", disabled: !writable() || !t.accent || undefined });
    accentOn.addEventListener("change", () => { t.accent = accentOn.checked ? accent.value : ""; accent.disabled = !accentOn.checked; schedulePreview(); });
    accent.addEventListener("input", () => { t.accent = accent.value; schedulePreview(); });
    const group = select([{ value: "room", label: "One per room (a newer replaces it)" }, { value: "kind", label: "One per kind" }, { value: "none", label: "Each on its own" }], t.group, { disabled: !writable() || undefined });
    group.addEventListener("change", () => { t.group = group.value; });
    const throttle = h("input", { class: "input", type: "number", min: "0", max: "3600", value: String(t.throttle), disabled: !writable() || undefined });
    throttle.addEventListener("change", () => { t.throttle = Math.max(0, Math.min(3600, Number(throttle.value) || 0)); });

    return h("div", { class: "grid grid--2" },
      h("div", { class: "card" },
        h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Templates"), h("div", { class: "card__hint" }, `Variables: ${VARS}. An optional part disappears when a variable in it is empty or not allowed by the privacy level.`)),
        kinds,
        check(`Offer “${KIND_LABEL[kind]}” notifications`, t.on, (v) => { t.on = v; }, { "data-testid": "notify-kind-on" }),
        texts,
        h("div", { class: "form-grid" },
          field("Privacy for users who did not choose", priv),
          field("The most a user may choose", max),
          field("Icon", icon),
          field("Accent", h("div", { class: "row" }, h("label", { class: "switch" }, accentOn, "own colour"), accent)),
          field("Grouping", group),
          field("Throttle (seconds per account and room)", throttle)),
        h("div", { class: "row" },
          check("Sound", t.sound, (v) => { t.sound = v; }),
          check("Vibration", t.vibrate, (v) => { t.vibrate = v; }),
          check("Stays until opened", t.sticky, (v) => { t.sticky = v; }),
          check("Reply / mark read (Android)", t.actions, (v) => { t.actions = v; }))),
      previewCard());
  }

  let previewTimer = 0;
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(() => void runPreview(), 180); }

  function previewCard() {
    const lang = select(LANGS.map((l) => ({ value: l, label: l })), sample.lang, { "data-read": "1" });
    lang.addEventListener("change", () => { sample.lang = lang.value; schedulePreview(); });
    const priv = select([{ value: "", label: "the default for this kind" }, ...PRIVACY.map((p) => ({ value: p, label: PRIVACY_LABEL[p] }))], sample.privacy, { "data-read": "1", "data-testid": "notify-preview-privacy" });
    priv.addEventListener("change", () => { sample.privacy = priv.value; schedulePreview(); });
    const inputs = ["sender", "room", "preview", "count"].map((k) => {
      const i = h("input", { class: "input", value: sample[k], "data-read": "1" });
      i.addEventListener("input", () => { sample[k] = i.value; schedulePreview(); });
      return field(k, i);
    });
    const card = h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Live preview"), h("div", { class: "card__hint" }, "Rendered by the server with the same rules every client uses. The room's name and a preview are filled in only by a device that knows them.")),
      h("div", { class: "form-grid" }, field("Language", lang), field("Privacy", priv), ...inputs),
      h("div", { id: "notifyPreview", class: "card", "data-testid": "notify-preview" }, h("div", { class: "muted small" }, "…")),
      h("div", { id: "notifyVisible", class: "muted small" }));
    setTimeout(() => void runPreview(), 0);
    return card;
  }

  async function runPreview() {
    const box = document.getElementById("notifyPreview");
    if (!box) return;
    const t = draft.templates[kind];
    try {
      const r = await api("/api/admin/notify/preview", { method: "POST", body: { kind, lang: sample.lang, privacy: sample.privacy || t.privacy, template: t, vars: { sender: sample.sender, room: sample.room, preview: sample.preview, count: sample.count, time: "10:42", channel: "android" } } });
      clear(box);
      box.style.borderLeft = `4px solid ${t.accent || "var(--accent, #2563eb)"}`;
      box.append(
        h("div", { class: "row" }, C.icon(t.icon || "bell"), h("strong", { "data-testid": "notify-preview-title" }, r.title), h("span", { class: "spacer" }), h("span", { class: "muted small" }, "10:42")),
        h("div", { "data-testid": "notify-preview-body" }, r.body || "—"));
      const vis = document.getElementById("notifyVisible");
      if (vis) vis.textContent = `Shown at “${r.privacy}”: ${r.visible.join(", ") || "nothing but the text"}.`;
    } catch (err) {
      clear(box);
      box.append(h("div", { class: "err small" }, err.message));
    }
  }

  /* ============================================================== e-mail */

  function emailCard() {
    const e = draft.email;
    const input = (key, attrs = {}) => { const i = h("input", { class: "input", value: e[key] ?? "", disabled: !writable() || undefined, ...attrs }); i.addEventListener("input", () => { e[key] = attrs.type === "number" ? Number(i.value) : i.value; }); return i; };
    const secure = select([{ value: "starttls", label: "STARTTLS (587)" }, { value: "tls", label: "TLS from the start (465)" }, { value: "none", label: "None (a relay on this machine only)" }], e.secure, { disabled: !writable() || undefined });
    secure.addEventListener("change", () => { e.secure = secure.value; });
    const to = h("input", { class: "input", type: "email", placeholder: "you@example.org", "data-testid": "notify-mail-to" });
    const hasPw = data.config.email && data.config.email.hasPassword;
    return h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "E-mail (SMTP relay)"),
        h("div", { class: "card__hint" }, "A user's address is used only after they confirmed it from the mail the server sends them. Switch the channel on under Channels.")),
      h("div", { class: "form-grid" },
        field("Host", input("host", { placeholder: "smtp.example.org", "data-testid": "notify-smtp-host" })),
        field("Port", input("port", { type: "number", min: "1", max: "65535" })),
        field("Security", secure),
        field("User", input("user", { autocomplete: "off" })),
        field(hasPw ? "Password (set — type to replace)" : "Password", input("pass", { type: "password", autocomplete: "new-password", placeholder: hasPw ? "••••••" : "" })),
        field("From", input("from", { placeholder: "M5cet <notify@example.org>" }))),
      h("div", { class: "row" },
        hasPw ? h("button", { type: "button", class: "btn btn--sm", "data-min-role": "operator", onclick: async () => { try { data = await api("/api/admin/notify", { method: "PUT", body: { email: { pass: null } } }); draft.email.pass = ""; render(); toast("SMTP password removed", "ok"); } catch (err) { toast(err.message, "err"); } } }, "Remove the password") : null,
        h("span", { class: "spacer" }), to,
        h("button", { type: "button", class: "btn", "data-min-role": "operator", onclick: async () => { try { await api("/api/admin/notify/email/test", { method: "POST", body: { to: to.value } }); toast("Test mail sent", "ok"); } catch (err) { toast(err.message, "err"); } } }, "Send a test mail (saved settings)")));
  }

  /* ============================================================== limits */

  function limitsCard() {
    const l = draft.limits;
    const num = (key, min, max) => { const i = h("input", { class: "input", type: "number", min: String(min), max: String(max), value: String(l[key]), disabled: !writable() || undefined }); i.addEventListener("change", () => { l[key] = Math.max(min, Math.min(max, Number(i.value) || min)); }); return i; };
    return h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Limits")),
      h("div", { class: "form-grid" },
        field("Notifications per account and hour", num("perHour", 1, 10000)),
        field("Tests per account and hour", num("testsPerHour", 1, 1000)),
        field("Time a channel may take (ms)", num("timeoutMs", 1000, 60000))),
      h("p", { class: "muted small" }, "Each kind also has its own throttle per account and room (Templates). The server never notifies the sender, nor a member who is present in the room."));
  }

  /* ======================================================== test and log */

  function testCard() {
    const user = h("input", { class: "input mono", placeholder: "username", "data-testid": "notify-test-user" });
    const k = select(KINDS.map((x) => ({ value: x, label: KIND_LABEL[x] })), "test");
    const ch = select([{ value: "", label: "every channel, in order" }, ...["android", "webpush", "email"].map((x) => ({ value: x, label: CHANNEL_LABEL[x] }))], "");
    const out = h("div", { class: "stack small", "data-testid": "notify-test-out" });
    const run = async () => {
      clear(out);
      try {
        const r = await api("/api/admin/notify/test", { method: "POST", body: { username: user.value.trim(), kind: k.value, ...(ch.value ? { channel: ch.value } : {}) } });
        out.append(outcome(r));
      } catch (err) {
        out.append(h("div", { class: "err" }, err.message));
      }
      void loadLog();
    };
    return h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Send a notification to an account"), h("div", { class: "card__hint" }, "Through the account's own channels, order and privacy — the same way the server notifies it.")),
      h("div", { class: "row" }, user, k, ch, h("button", { type: "button", class: "btn btn--primary", "data-min-role": "operator", onclick: () => void run() }, "Send")),
      out);
  }

  function outcome(r) {
    return h("div", { class: "stack" },
      h("div", {}, r.ok ? badge(`sent via ${r.channel}`, "ok") : badge(r.skipped ? `not sent: ${r.skipped}` : "every channel failed", r.skipped ? "warn" : "err")),
      ...(r.attempts || []).map((a) => h("div", { class: "mono" }, `${a.channel} → ${a.target}: ${a.ok ? "ok" : `${a.status ?? ""} ${a.error ?? ""}`}${a.gone ? " (forgotten)" : ""} · ${a.ms} ms`)));
  }

  function logCard() {
    const tbody = h("tbody");
    for (const e of log) {
      tbody.append(h("tr", {},
        h("td", { class: "mono" }, when(e.at)),
        h("td", {}, KIND_LABEL[e.kind] || e.kind),
        h("td", { class: "mono" }, e.account),
        h("td", { class: "mono" }, e.room || "—"),
        h("td", {}, badge(e.outcome, e.outcome === "sent" ? "ok" : e.outcome === "failed" ? "err" : "")),
        h("td", {}, e.channel || e.reason || "—"),
        h("td", { class: "mono small" }, (e.attempts || []).map((a) => `${a.channel}:${a.ok ? "ok" : a.status || "x"}${a.gone ? "†" : ""}`).join(" → ") || "—"),
        h("td", { class: "mono small" }, e.by || "")));
    }
    return h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Delivery log"),
        h("div", { class: "card__hint" }, "The last 1000 notifications since the server started: who, which kind, which room (a hash), each attempt. † = the endpoint was dead and is forgotten."),
        h("div", { class: "card__actions" }, h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => void loadLog() }, "Refresh"))),
      h("div", { class: "table-wrap" }, h("table", { class: "t", "data-testid": "notify-log" },
        h("thead", {}, h("tr", {}, ...["Time", "Kind", "Account", "Room", "Outcome", "Channel / why", "Attempts", "By"].map((x) => h("th", {}, x)))),
        tbody)),
      log.length ? null : h("div", { class: "empty muted small" }, "Nothing yet."));
  }
})();
