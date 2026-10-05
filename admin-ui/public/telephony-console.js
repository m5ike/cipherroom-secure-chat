// M5cet operator console — Telephony & SIP (6.9).
//
//   Overview        the providers, PUBLIC_BASE_URL and the webhooks' health,
//                   counts (rules, applications, live calls, route codes,
//                   events and errors today) and what to fix
//   Providers       per provider: what it can do, what is configured and the
//                   env variables still missing (names, never values); the
//                   default SMS / voice provider; webhook URLs with a one-click
//                   install; the provider test as a checklist
//   Permissions     the module's limits and defaults (TelPermissions) and, read
//                   only, which groups have which rights (Modules & groups)
//   Outbound /      the routing rules in priority order: drag (or ↑ ↓) to
//   Inbound         reorder, switch, duplicate, delete; an editor drawer for
//                   the match (patterns, provider, service, groups / sources,
//                   callers, the time window), the service (the provider's
//                   application, or a SIP trunk with its own caller ID) and
//                   the target (an application, a state, or "pass"); a dry
//                   run of a call against the saved rules
//   Applications    the TSAs (call flows): create (blank or a template), open
//                   in the visual editor (tsa-editor.js), duplicate, publish,
//                   export / import, delete
//   Route codes     the inroute table with live countdowns; add (tests), delete
//   SIP trunks      the trunks (add / edit with caller ID, delete) and the
//                   DID → trunk check
//   Tests           provider, webhook self-test, route dry run, a test call,
//                   a test SMS, voice into a room, the test inbound SIP address
//   Calls           m5.telephony's calls, the phone bridge's lent numbers and
//                   the messages functions sent
//   Log             every event of the module, filtered and paged; a click
//                   opens the full entry: the parsed data and the raw payload
//
// Deep links: #/telephony/<tab>[/<id>] (log/<entry>, calls/<call>,
// inbound/<rule>, outbound/<rule>). The API is the contract in
// server/telephony/control/api-contract.ts plus the older /admin/telephony
// endpoints (providers, defaults, webhooks, SIP trunks) and the main
// service's /api/admin/telephony/sdk (calls, bridges).
//
// Same rules as console.js: DOM nodes and textContent, never markup.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast, can } = C;

  /* ============================================================ constants */

  const VOICE_PROVIDERS = ["twilio", "telnyx", "vonage"];
  const PROVIDER_LABEL = { twilio: "Twilio", telnyx: "Telnyx", vonage: "Vonage", hlrlookups: "HLR Lookups", meta: "Meta" };
  const CAP_LABEL = { call: "Voice calls", sms: "SMS", hlr: "HLR", lookup: "Number lookup", whatsapp: "WhatsApp", viber: "Viber", messenger: "Messenger", numbers: "Numbers (buy / release)", media: "Media streams" };
  const STATES = ["busy", "congestion", "hangup", "rejected"];
  const STATE_HELP = {
    busy: "the caller hears a busy tone",
    congestion: "the network is congested (fast busy)",
    hangup: "the call is ended at once",
    rejected: "refused before it is answered",
  };
  const SOURCES = ["function", "tsa", "console", "api"];
  const SOURCE_LABEL = { function: "Functions (m5.telephony.call)", tsa: "Applications (Dial)", console: "The console (tests)", api: "The API" };
  const LOG_KINDS = ["webhook", "call", "sms", "tsa", "route", "inroute", "test", "config", "sip"];
  const LEVELS = ["debug", "info", "notice", "warn", "error"];
  const LEVEL_TONE = { debug: "", info: "info", notice: "accent", warn: "warn", error: "err" };
  const TEMPLATES = [
    { id: "", label: "Blank", help: "A Start and a Hangup — draw the rest." },
    { id: "ivr-menu", label: "IVR menu", help: "A greeting and a menu: press 1, 2, 3… each key goes its own way; a wrong key asks again." },
    { id: "route-code", label: "Route code", help: "Asks for a code (m5.telephony.inroute.add) and connects the caller's audio to a room or a member." },
    { id: "voicemail", label: "Voicemail", help: "A greeting, a beep, a recording; the recording goes to a room or a function." },
    { id: "opening-hours", label: "Opening hours", help: "Open: on to the next step; closed: a message and goodbye." },
  ];
  const TABS = [
    ["overview", "Overview", "gauge"],
    ["providers", "Providers", "boxes"],
    ["permissions", "Permissions", "shield-check"],
    ["outbound", "Outbound routing", "send"],
    ["inbound", "Inbound routing", "inbox"],
    ["apps", "Applications", "workflow"],
    ["codes", "Route codes", "key-round"],
    ["trunks", "SIP trunks", "link-2"],
    ["tests", "Tests", "zap"],
    ["calls", "Calls & sessions", "activity"],
    ["log", "Log", "list"],
  ];
  const TAB_IDS = TABS.map((t) => t[0]);

  /** Mirrors DEFAULT_PERMISSIONS of server/telephony/control/types.ts (a test keeps them equal). */
  const DEFAULT_PERMISSIONS = {
    outbound: { countries: [], blocked: ["+1900*", "+1976*", "+44870*", "+44871*", "+44872*", "+44873*", "+4290*", "+42097*", "+881*", "+882*", "+883*"], maxConcurrentCalls: 5, callsPerHour: 30, smsPerHour: 60, maxMinutes: 30 },
    inbound: { maxConcurrentCalls: 10, perCallerPerHour: 20 },
    inroute: { maxTtlSec: 86400, maxActivePerOwner: 50, maxAttemptsPerCall: 3, maxFailuresPerCallerPerHour: 10, maxFailuresPerDidPerHour: 30, maxFailuresPerMinute: 10, maxFailuresPerHour: 100 },
    tsa: { httpHosts: [], functions: true, recordingDays: 30 },
    log: { days: 14, keepRaw: false },
    defaults: { inbound: { kind: "state", state: "busy" }, outbound: { kind: "pass" } },
  };
  const INROUTE_CODE = /^\d{4,6}$/;
  const INROUTE_DEFAULT_TTL = 600;
  const TSA_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
  const TRUNK_ID = /^[a-z0-9_-]{1,64}$/;

  /* ============================================================ validation */

  const E164 = /^\+[1-9]\d{6,14}$/;
  const DAY = "(mon|tue|wed|thu|fri|sat|sun)";
  const DAYS = new RegExp(`^${DAY}(-${DAY})?(,${DAY}(-${DAY})?)*$`);
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  /** A number pattern: "+420123456789", "+4202*", "*", "sip:*@example.com", a leading "-" = not. */
  function patternProblem(raw) {
    let p = String(raw || "").trim();
    if (!p) return "empty";
    if (p.startsWith("-")) p = p.slice(1);
    if (!p) return "“-” needs a pattern after it";
    if (p === "*") return null;
    if (/^sips?:/i.test(p)) return /^sips?:[^\s]+$/i.test(p) && !/[<>"]/.test(p) ? null : "a SIP URI looks like sip:user@host (* and ? match anything)";
    if (/^\+\d{1,15}\*$/.test(p) || p === "+*") return null;
    if (/^\+\d+$/.test(p)) return E164.test(p) ? null : "an exact number is E.164: + country code and 7–15 digits";
    if (/^\d/.test(p)) return "numbers are E.164 — start with + and the country code (+420…)";
    return "use +420123456789 (exact), +4202* (a prefix), * (any), sip:*@host or a leading - (not)";
  }
  const e164Problem = (n) => (E164.test(String(n || "").trim()) ? null : "E.164: + country code and 7–15 digits (+420123456789)");
  const countryProblem = (c) => (/^([A-Z]{2}|\*)$/.test(String(c || "")) ? null : "two letters, ISO 3166 (CZ, SK, DE…), or * for any");
  const hostProblem = (v) => (/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i.test(String(v || "")) || /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v || "")) ? null : "a host name (api.example.com) or *.example.com");
  const groupProblem = (g) => (/^[\w.@:+-]{1,64}$/.test(String(g || "")) ? null : "a group id (letters, digits, - _ .)");
  function timezoneProblem(tz) {
    if (!tz) return "a time zone (Europe/Prague)";
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); return null; } catch { return `unknown time zone “${tz}”`; }
  }
  function hoursProblems(hw) {
    if (!hw) return [];
    const out = [];
    const tz = timezoneProblem(hw.timezone);
    if (tz) out.push({ field: "hours.timezone", message: tz });
    if (!DAYS.test(String(hw.days || ""))) out.push({ field: "hours.days", message: "days: mon-fri, sat,sun, mon,wed,fri…" });
    if (!HHMM.test(String(hw.from || ""))) out.push({ field: "hours.from", message: "from: HH:MM" });
    if (!HHMM.test(String(hw.to || ""))) out.push({ field: "hours.to", message: "to: HH:MM" });
    return out;
  }

  /** Everything the rule editor refuses before it asks the server (which checks again). */
  function ruleProblems(rule, dir, ctx = {}) {
    const out = [];
    if (!String(rule.label || "").trim()) out.push({ field: "label", message: "Give the rule a name." });
    const patterns = dir === "inbound" ? [["match.numbers", rule.match.numbers], ["match.from", rule.match.from]] : [["match.to", rule.match.to]];
    for (const [field, list] of patterns) for (const p of list || []) { const pr = patternProblem(p); if (pr) out.push({ field, message: `${p}: ${pr}` }); }
    if (dir === "outbound") for (const g of rule.match.groups || []) { const pr = groupProblem(g); if (pr) out.push({ field: "match.groups", message: `${g}: ${pr}` }); }
    out.push(...hoursProblems(rule.match.hours).map((p) => ({ ...p, field: `match.${p.field}` })));
    if (dir === "outbound") {
      const s = rule.service || {};
      if (!s.provider) out.push({ field: "service.provider", message: "Choose the provider that carries the call." });
      if (s.kind === "sip") {
        if (!s.trunk) out.push({ field: "service.trunk", message: "Choose the SIP trunk." });
        else if (ctx.trunks && !ctx.trunks.some((t) => t.id === s.trunk)) out.push({ field: "service.trunk", message: `There is no trunk “${s.trunk}”.` });
        const n = s.callerId && s.callerId.number;
        if (n && e164Problem(n)) out.push({ field: "service.callerId.number", message: `Caller ID: ${e164Problem(n)}` });
        if (s.callerId && String(s.callerId.name || "").length > 40) out.push({ field: "service.callerId.name", message: "Caller name: at most 40 characters." });
      }
    }
    const t = rule.target || {};
    if (t.kind === "tsa" && !t.tsa) out.push({ field: "target.tsa", message: "Choose the application the call runs." });
    if (t.kind === "tsa" && t.tsa && ctx.tsa && !ctx.tsa.some((a) => a.id === t.tsa)) out.push({ field: "target.tsa", message: `There is no application “${t.tsa}”.` });
    if (t.kind === "state" && !STATES.includes(t.state)) out.push({ field: "target.state", message: "Choose a state." });
    if (t.kind === "pass" && dir === "inbound") out.push({ field: "target.kind", message: "An inbound call cannot “pass”: run an application or answer with a state." });
    return out;
  }

  /* ============================================================== formats */

  const pad = (n) => String(n).padStart(2, "0");
  const when = (t) => { if (!t) return "—"; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const whenSec = (t) => { if (!t) return "—"; const d = new Date(t); return `${when(t)}:${pad(d.getSeconds())}`; };
  const clock = (t) => { if (!t) return "—"; const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`; };
  function span(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec} s`;
    if (sec < 3600) return `${Math.floor(sec / 60)} min ${pad(sec % 60)} s`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} h ${pad(Math.floor((sec % 3600) / 60))} min`;
    return `${Math.floor(sec / 86400)} d ${Math.floor((sec % 86400) / 3600)} h`;
  }
  const ago = (t) => (!t ? "never" : `${span((Date.now() - t) / 1000)} ago`);
  const plabel = (id) => PROVIDER_LABEL[id] || id || "any provider";
  const badge = (text, tone, attrs = {}) => h("span", { class: `badge${tone ? ` badge--${tone}` : ""}`, ...attrs }, text);
  /** An icon of the console's set; a fallback name when this one is not in it. */
  function ic(name, fallback = "circle-alert") {
    const I = window.M5Icons;
    if (!I) return null;
    return I.svg(I.has && !I.has(name) ? fallback : name, "ico tel-ico");
  }
  /** The first array among the answer's keys (the contract names some lists only by their item type). */
  function listOf(r, ...keys) {
    if (Array.isArray(r)) return r;
    if (!r || typeof r !== "object") return [];
    for (const k of keys) if (Array.isArray(r[k])) return r[k];
    for (const v of Object.values(r)) if (Array.isArray(v)) return v;
    return [];
  }
  const uid = (prefix) => `${prefix}-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;

  /* ============================================================ access */

  /** The module right a change needs (Modules & groups › Telephony & SIP), on top of the operator role. */
  function may(right) {
    if (!can("operator")) return false;
    const acc = C.moduleAccess ? C.moduleAccess("telephony") : null;
    if (!acc) return true;
    if (!acc.allowed) return false;
    if (!acc.rights) return true;
    return acc.rights.some((r) => r === "*" || r === right);
  }
  const denyText = (right) => (can("operator") ? `Your access to Telephony & SIP does not include “${right}” (Modules & groups).` : "Read only: an auditor cannot change anything.");
  /** Disables a control the administrator may not use, and says why. */
  function gate(el, right) {
    if (!may(right)) { el.disabled = true; el.title = denyText(right); el.setAttribute("data-gated", right); }
    return el;
  }

  /* ================================================================ api */

  /** Like the console's api(), but a refusal keeps its answer (problems) and status. */
  async function call(path, opts = {}) {
    if (!C.raw) return api(path, opts);
    const res = await C.raw(path, {
      method: opts.method || "GET",
      headers: { Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) return api(path, opts); // the console signs out
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && (data.message || data.reason)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data || {};
      throw err;
    }
    return data || {};
  }
  const isMissing = (err) => Boolean(err) && (err.status === 404 || /HTTP 404|not found|cannot (get|post|put|delete)/i.test(err.message || ""));

  const RESOURCES = {
    snap: "/admin/telephony",
    overview: "/admin/telephony/overview",
    sdk: "/api/admin/telephony/sdk",
    rules: "/admin/telephony/rules",
    perms: "/admin/telephony/permissions",
    tsa: "/admin/telephony/tsa",
    inroute: "/admin/telephony/inroute",
    trunks: "/admin/telephony/sip/trunks",
    sipAddr: "/admin/telephony/tests/sip-address",
  };
  const cache = new Map();

  /** A resource of the page: { data } or { error } (cached until a refresh). */
  function need(key, fresh = false) {
    if (!fresh && cache.has(key)) return cache.get(key);
    const p = call(RESOURCES[key]).then((data) => ({ data }), (error) => ({ error }));
    cache.set(key, p);
    return p;
  }
  const forget = (...keys) => { for (const k of keys) cache.delete(k); };

  // Shaped answers.
  const rulesOf = async () => { const r = await need("rules"); return r.data ? { inbound: listOf(r.data.inbound), outbound: listOf(r.data.outbound) } : null; };
  const tsaOf = async () => { const r = await need("tsa"); return r.data ? listOf(r.data, "tsas", "tsa", "items", "apps", "list") : null; };
  const trunksOf = async () => { const r = await need("trunks"); if (r.data) return listOf(r.data, "trunks"); const s = await need("snap"); return s.data ? listOf(s.data.sip) : null; };
  const inrouteOf = async () => { const r = await need("inroute"); return r.data ? listOf(r.data, "entries", "codes", "inroute", "items") : null; };

  /* ================================================================ state */

  const S = {
    tab: "overview",
    arg: "",
    gen: 0,
    log: { entries: [], next: null, filters: { kind: "", provider: "", level: "", callId: "", q: "", range: "" }, auto: false, loading: false, error: null },
    match: { inbound: null, outbound: null },
    lastTest: {},
  };
  const rootEl = () => document.getElementById("telRoot");
  const visible = () => { const r = rootEl(); const sec = r && r.closest("section"); return Boolean(r && r.isConnected && (!sec || !sec.hidden)); };

  /* ============================================================ helpers */

  /** Appends like h() does: nothing for null / undefined / false, arrays flattened (DOM append would write "null"). */
  function put(el, ...kids) {
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  function field(label, control, hint, attrs = {}) {
    const id = control.id || `tel-f-${Math.random().toString(36).slice(2, 9)}`;
    if (!control.id && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) control.id = id;
    return h("div", { class: "field tel-field", ...attrs },
      h("label", { for: control.id || undefined }, label),
      control,
      hint ? h("div", { class: "tel-hint" }, hint) : null);
  }
  function input(value, attrs = {}) {
    const el = h("input", { class: "input", ...attrs });
    el.value = value === undefined || value === null ? "" : String(value);
    return el;
  }
  function numberInput(value, min, max, attrs = {}) {
    const el = input(value, { type: "number", min: String(min), max: String(max), step: "1", ...attrs });
    el.addEventListener("change", () => { const n = Math.max(min, Math.min(max, Math.round(Number(el.value) || 0))); el.value = String(n); });
    return el;
  }
  const numberOf = (el, min, max) => Math.max(min, Math.min(max, Math.round(Number(el.value) || 0)));
  function select(options, value, attrs = {}) {
    const el = h("select", { class: "input", ...attrs });
    for (const o of options) el.append(h("option", { value: o.value, disabled: o.disabled || undefined }, o.label));
    el.value = value === undefined || value === null ? "" : String(value);
    return el;
  }
  function textarea(value, attrs = {}) {
    const el = h("textarea", { class: "input", ...attrs });
    el.value = value || "";
    return el;
  }
  function toggle(label, checked, attrs = {}) {
    const box = h("input", { type: "checkbox", ...attrs });
    box.checked = Boolean(checked);
    return { box, el: h("label", { class: "switch" }, box, label) };
  }
  function card(title, hint, actions, ...body) {
    return h("div", { class: "card tel-card" },
      title || hint || actions ? h("div", { class: "card__head" },
        h("div", { class: "tel-card__titles" }, title ? h("div", { class: "card__title" }, title) : null, hint ? h("div", { class: "card__hint" }, hint) : null),
        actions ? h("div", { class: "card__actions" }, actions) : null) : null,
      ...body);
  }
  const loading = (text = "Loading…") => h("div", { class: "tel-state tel-state--loading", role: "status" }, h("span", { class: "tel-spinner", "aria-hidden": "true" }), text);
  const empty = (text, ...actions) => h("div", { class: "tel-state tel-state--empty" }, h("div", {}, text), actions.length ? h("div", { class: "row tel-state__actions" }, ...actions) : null);
  function failed(err, retry, what = "") {
    const missing = isMissing(err);
    return h("div", { class: `tel-state tel-state--error${missing ? " is-missing" : ""}`, role: "alert" },
      ic(missing ? "hourglass" : "circle-x"),
      h("div", {},
        h("div", { class: "tel-state__title" }, missing ? `${what || "This"}: not available on this server yet` : `${what || "This"}: could not be loaded`),
        h("div", { class: "muted small" }, missing ? "The admin service does not answer this endpoint (an older build). Update and restart it." : err.message)),
      retry ? h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: retry }, ic("refresh-cw"), "Retry") : null);
  }
  async function copy(text, what = "Copied") {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(String(text));
      else {
        const ta = h("textarea", { class: "tel-offscreen", "aria-hidden": "true" });
        ta.value = String(text);
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast(what, "ok");
    } catch (err) { toast(`Copy failed: ${err.message}`, "err"); }
  }
  const copyBtn = (text, label = "Copy", what) => h("button", { type: "button", class: "btn btn--sm tel-copy", "data-read": "1", "aria-label": typeof text === "function" ? label || "Copy" : `Copy ${String(text).slice(0, 60)}`, title: "Copy", onclick: () => void copy(typeof text === "function" ? text() : text, what) }, ic("copy"), label || null);
  function kv(pairs) {
    const dl = h("dl", { class: "kv tel-kv" });
    for (const [k, v] of pairs) {
      if (v === undefined) continue;
      dl.append(h("dt", {}, k), h("dd", {}, v === null || v === "" ? "—" : v));
    }
    return dl;
  }
  async function busy(btn, fn) {
    if (!btn) return fn();
    const was = btn.disabled;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try { return await fn(); } finally { btn.disabled = was; btn.removeAttribute("aria-busy"); }
  }
  function problemsBox(problems) {
    const box = h("div", { class: "tel-problems", role: "alert" });
    if (!problems || !problems.length) { box.hidden = true; return box; }
    box.append(h("strong", {}, problems.length === 1 ? "One thing to fix" : `${problems.length} things to fix`),
      h("ul", {}, ...problems.map((p) => h("li", {}, typeof p === "string" ? p : `${p.rule ? `${p.rule}: ` : p.path ? `${p.path}: ` : ""}${p.message || p.text || JSON.stringify(p)}`))));
    return box;
  }

  /* =============================================================== drawer */

  let closeOpen = null;
  /** A side drawer (the console's .drawer): Escape closes it, Tab stays inside, focus goes back where it was. */
  function drawer(title, opts = {}) {
    if (closeOpen) closeOpen();
    const opener = document.activeElement;
    const body = h("div", { class: "drawer__body tel-drawer__body" });
    const foot = h("div", { class: "tel-drawer__foot" });
    const close = () => {
      if (closeOpen !== close) return;
      closeOpen = null;
      backdrop.remove();
      el.remove();
      document.removeEventListener("keydown", onKey, true);
      if (opts.onClose) opts.onClose();
      if (opener && opener.isConnected && opener.focus) opener.focus();
    };
    const backdrop = h("div", { class: "drawer-backdrop", onclick: close });
    const el = h("aside", { class: `drawer tel-drawer${opts.wide ? " tel-drawer--wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title, "data-testid": opts.testid },
      h("div", { class: "drawer__head" },
        h("div", { class: "tel-drawer__titles" }, h("div", { class: "drawer__title" }, title), opts.subtitle ? h("div", { class: "muted small" }, opts.subtitle) : null),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "aria-label": "Close", onclick: close }, ic("x"), "Close")),
      body, foot);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const f = [...el.querySelectorAll("button, [href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop, el);
    closeOpen = close;
    setTimeout(() => { const f = body.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled])") || el.querySelector("button"); if (f && el.isConnected) f.focus(); }, 0);
    return { body, foot, close, el };
  }

  /* ========================================================= json viewer */

  /** A collapsible tree of a value: objects and arrays fold, the first levels open. */
  function jsonTree(value, openDepth = 2) {
    const tree = h("div", { class: "tel-json", "data-testid": "tel-json" });
    const prim = (v) => {
      if (v === null || v === undefined) return h("span", { class: "tel-json__null" }, String(v));
      if (typeof v === "string") {
        if (v.length <= 400) return h("span", { class: "tel-json__str" }, JSON.stringify(v));
        const s = h("span", { class: "tel-json__str" }, `${JSON.stringify(v.slice(0, 400))}…`);
        const more = h("button", { type: "button", class: "btn btn--sm tel-json__more", "data-read": "1", onclick: () => { s.textContent = JSON.stringify(v); more.remove(); } }, `show all ${v.length} characters`);
        return h("span", {}, s, " ", more);
      }
      if (typeof v === "number") return h("span", { class: "tel-json__num" }, String(v));
      if (typeof v === "boolean") return h("span", { class: "tel-json__bool" }, String(v));
      return h("span", {}, String(v));
    };
    const keyEl = (key) => (key === null ? null : h("span", { class: "tel-json__key" }, `${key}: `));
    const node = (key, v, depth) => {
      if (v === null || typeof v !== "object") return h("div", { class: "tel-json__row" }, keyEl(key), prim(v));
      const arr = Array.isArray(v);
      const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
      if (!entries.length) return h("div", { class: "tel-json__row" }, keyEl(key), h("span", { class: "tel-json__punct" }, arr ? "[]" : "{}"));
      const det = h("details", { class: "tel-json__node" });
      if (depth < openDepth) det.open = true;
      const preview = arr ? `[${entries.length}]` : `{${entries.length}} ${entries.slice(0, 4).map(([k]) => k).join(", ")}${entries.length > 4 ? ", …" : ""}`;
      det.append(h("summary", {}, keyEl(key), h("span", { class: "tel-json__punct" }, preview)));
      const kids = h("div", { class: "tel-json__kids" });
      const LIMIT = 300;
      for (const [k, x] of entries.slice(0, LIMIT)) kids.append(node(k, x, depth + 1));
      if (entries.length > LIMIT) kids.append(h("div", { class: "muted small" }, `… ${entries.length - LIMIT} more (copy the JSON to see them)`));
      det.append(kids);
      return det;
    };
    tree.append(node(null, value, 0));
    return tree;
  }
  /** The tree with its tools: expand / collapse all, copy. */
  function jsonBlock(title, value, testid) {
    let parsed = value;
    if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { parsed = value; } }
    const isText = typeof parsed === "string";
    const view = isText ? h("pre", { class: "code tel-raw" }, parsed) : jsonTree(parsed);
    const text = () => (isText ? parsed : JSON.stringify(parsed, null, 2));
    const setAll = (open) => { for (const d of view.querySelectorAll("details")) d.open = open; };
    return h("section", { class: "tel-jsonblock", "data-testid": testid },
      h("div", { class: "tel-jsonblock__head" }, h("h3", {}, title), h("span", { class: "spacer" }),
        isText ? null : h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => setAll(true) }, "Expand all"),
        isText ? null : h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => setAll(false) }, "Collapse all"),
        copyBtn(text, isText ? "Copy" : "Copy JSON", `${title} copied`)),
      view);
  }

  /* ========================================================== chips input */

  /**
   * A list of short values as chips: Enter, a comma or leaving the field adds,
   * × or Backspace removes; invalid values are marked and named below.
   */
  function chips(initial, opts = {}) {
    const list = (initial || []).slice();
    const listEl = h("span", { class: "tel-chips__list" });
    const dl = opts.suggest && opts.suggest.length ? h("datalist", { id: `tel-dl-${Math.random().toString(36).slice(2, 9)}` }, ...opts.suggest.map((s) => h("option", { value: s }))) : null;
    const entry = h("input", { class: "tel-chips__input", placeholder: opts.placeholder || "", "aria-label": opts.label || "Add a value", disabled: opts.disabled || undefined, list: dl ? dl.id : undefined, "data-testid": opts.testid ? `${opts.testid}-input` : undefined });
    const wrap = h("div", { class: `tel-chips${opts.disabled ? " is-disabled" : ""}`, "data-testid": opts.testid }, listEl, entry, dl);
    const hint = h("div", { class: "tel-hint tel-hint--err", "aria-live": "polite" });
    const problems = () => (opts.validate ? list.map((v) => [v, opts.validate(v)]).filter(([, p]) => p) : []);
    function draw() {
      clear(listEl);
      list.forEach((v, i) => {
        const p = opts.validate ? opts.validate(v) : null;
        listEl.append(h("span", { class: `tel-chip${p ? " is-invalid" : ""}`, title: p || v },
          h("span", { class: "mono" }, v),
          opts.disabled ? null : h("button", { type: "button", class: "tel-chip__x", "aria-label": `Remove ${v}`, onclick: () => { list.splice(i, 1); changed(); entry.focus(); } }, "×")));
      });
      const bad = problems();
      hint.textContent = bad.map(([v, p]) => `${v}: ${p}`).join(" · ");
      wrap.classList.toggle("is-invalid", bad.length > 0);
    }
    function changed() { draw(); if (opts.onchange) opts.onchange(list.slice()); }
    function add(raw) {
      let added = false;
      for (const piece of String(raw).split(opts.split || /[,\s]+/)) {
        let v = piece.trim();
        if (!v) continue;
        if (opts.upper) v = v.toUpperCase();
        if (!list.includes(v)) { list.push(v); added = true; }
      }
      if (added) changed();
    }
    entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(entry.value); entry.value = ""; }
      else if (e.key === "Backspace" && !entry.value && list.length) { list.pop(); changed(); }
    });
    entry.addEventListener("blur", () => { if (entry.value.trim()) { add(entry.value); entry.value = ""; } });
    wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target === listEl) entry.focus(); });
    draw();
    const values = () => { if (entry.value.trim()) { add(entry.value); entry.value = ""; } return list.slice(); };
    return { el: h("div", { class: "tel-chipfield" }, wrap, hint), values, problems: () => { values(); return problems(); }, input: entry };
  }

  /* ================================================================ page */

  async function load() {
    const root = rootEl();
    if (!root) return;
    readHash();
    cache.clear();
    render();
  }

  function readHash() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] !== "telephony") return;
    const tab = parts[1] || "";
    if (TAB_IDS.includes(tab)) { S.tab = tab; S.arg = decodeURIComponent(parts.slice(2).join("/")); }
    else S.arg = "";
    writeHash();
  }
  function writeHash() {
    const hash = `#/telephony/${S.tab}${S.arg ? `/${encodeURIComponent(S.arg)}` : ""}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  /** Opens a tab (and, with an argument, the thing in it: a log entry, a call, a rule). */
  function go(tab, arg = "") {
    if (!TAB_IDS.includes(tab)) tab = "overview";
    S.tab = tab;
    S.arg = arg;
    writeHash();
    const bar = document.getElementById("telTabs");
    if (bar) for (const b of bar.querySelectorAll("[role=tab]")) {
      const on = b.getAttribute("data-tab") === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    renderTab();
  }

  function render() {
    const root = rootEl();
    if (!root) return;
    clear(root);
    root.append(headerCard(), tabBar(), h("div", { id: "telTab", class: "tel-body", role: "tabpanel", "aria-labelledby": `telTab-${S.tab}` }));
    renderTab();
  }

  function headerCard() {
    const status = h("div", { class: "tel-head__status", "aria-live": "polite" }, loading("Reading the module's state…"));
    const refresh = h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "data-testid": "tel-refresh", onclick: () => { cache.clear(); render(); } }, ic("refresh-cw"), "Refresh");
    const head = h("div", { class: "card tel-head" },
      h("div", { class: "tel-head__main" },
        h("div", { class: "tel-head__titles" },
          h("div", { class: "tel-head__title" }, "Telephony & SIP"),
          h("div", { class: "muted small" }, "Calls and SMS through Twilio, Telnyx and Vonage; SIP trunks; routing rules; call-flow applications (TSA); route codes into rooms.")),
        h("span", { class: "spacer" }), refresh),
      status);
    void need("snap").then((r) => {
      clear(status);
      if (r.error) { status.append(badge("state unknown", "warn"), h("span", { class: "muted small" }, r.error.message)); return; }
      const s = r.data;
      const conf = [...(s.sms || []), ...(s.voice || [])].filter((c) => c.configured).map((c) => c.id);
      const providers = [...new Set(conf)];
      const p = s.persistence || {};
      put(status,
        s.enabled ? badge("module on", "ok") : badge("module off — ENABLE_TELEPHONY", "warn"),
        providers.length ? badge(`${providers.length} provider${providers.length === 1 ? "" : "s"}: ${providers.map(plabel).join(", ")}`, "info") : badge("no provider configured", "warn"),
        s.publicBaseUrl ? badge(`PUBLIC_BASE_URL ${s.publicBaseUrl}`, "") : badge("PUBLIC_BASE_URL not set", "err"),
        p.writable === false ? badge("settings in memory only", "warn") : null,
        s.defaults ? h("span", { class: "muted small" }, `Default SMS: ${s.defaults.sms || "—"} · voice: ${s.defaults.voice || "—"}`) : null);
    });
    return head;
  }

  function tabBar() {
    const bar = h("div", { class: "tel-tabs", role: "tablist", id: "telTabs", "aria-label": "Telephony & SIP" });
    for (const [id, label, icon] of TABS) {
      const on = S.tab === id;
      bar.append(h("button", { type: "button", role: "tab", id: `telTab-${id}`, class: "tel-tab", "data-tab": id, "data-read": "1", "data-testid": `tel-tab-${id}`, "aria-selected": on ? "true" : "false", "aria-controls": "telTab", tabindex: on ? "0" : "-1", onclick: () => go(id) }, ic(icon), h("span", {}, label)));
    }
    bar.addEventListener("keydown", (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const i = TAB_IDS.indexOf(S.tab);
      const k = keys[e.key];
      const j = k === "first" ? 0 : k === "last" ? TAB_IDS.length - 1 : (i + k + TAB_IDS.length) % TAB_IDS.length;
      go(TAB_IDS[j]);
      const b = document.getElementById(`telTab-${TAB_IDS[j]}`);
      if (b) { b.focus(); b.scrollIntoView && b.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    });
    return bar;
  }

  const VIEWS = {};
  function renderTab() {
    const box = document.getElementById("telTab");
    if (!box) return;
    const gen = ++S.gen;
    stopTimers();
    clear(box);
    box.setAttribute("aria-labelledby", `telTab-${S.tab}`);
    box.append(loading());
    const view = VIEWS[S.tab] || VIEWS.overview;
    Promise.resolve(view(gen)).then((el) => {
      if (gen !== S.gen || !el) return;
      clear(box).append(el);
      C.applyRoleGates(box);
      startTimers();
    }, (err) => {
      if (gen !== S.gen) return;
      clear(box).append(failed(err, () => renderTab()));
    });
  }
  const stale = (gen) => gen !== S.gen;

  /* =============================================================== timers */

  let tickTimer = 0;
  let logTimer = 0;
  function stopTimers() { clearInterval(tickTimer); tickTimer = 0; clearInterval(logTimer); logTimer = 0; }
  function startTimers() {
    if (document.querySelector("[data-tel-expires]")) tickTimer = setInterval(tick, 1000);
    if (S.tab === "log" && S.log.auto) logTimer = setInterval(() => void pollLog(), 5000);
  }
  /** Live countdowns (route codes). */
  function tick() {
    if (!visible()) { stopTimers(); return; }
    const now = Date.now();
    for (const el of document.querySelectorAll("[data-tel-expires]")) {
      const left = (Number(el.getAttribute("data-tel-expires")) - now) / 1000;
      el.textContent = left > 0 ? span(left) : "expired";
      el.classList.toggle("is-expired", left <= 0);
      el.classList.toggle("is-soon", left > 0 && left < 60);
      const tr = el.closest("tr");
      if (tr) tr.classList.toggle("is-dim", left <= 0);
    }
  }

  /* ============================================================= overview */

  /** The overview: the server's answer, or (an older admin service) put together from the other answers. */
  async function overviewData() {
    const o = await need("overview");
    if (o.data && !isMissing(o.error)) return { data: o.data, computed: false };
    const [snap, sdk, rules, tsa, inroute, trunks] = await Promise.all([need("snap"), need("sdk"), rulesOf(), tsaOf(), inrouteOf(), trunksOf()]);
    const s = snap.data || {};
    const provs = sdk.data ? listOf(sdk.data.providers) : [];
    const byId = new Map();
    for (const p of provs) byId.set(p.id, { id: p.id, label: p.label || plabel(p.id), capabilities: p.capabilities || [], configured: p.configured || [], reason: p.reason, needs: p.needs || {} });
    for (const c of [...(s.sms || []), ...(s.voice || [])]) {
      const cur = byId.get(c.id) || { id: c.id, label: plabel(c.id), capabilities: [], configured: [], reason: "", needs: {} };
      const cap = c.kind === "voice" ? "call" : "sms";
      if (!cur.capabilities.includes(cap)) cur.capabilities.push(cap);
      if (c.configured && !cur.configured.includes(cap)) cur.configured.push(cap);
      if (!c.configured && !cur.reason) cur.reason = c.reason;
      byId.set(c.id, cur);
    }
    const trunkList = trunks || [];
    const providers = [...byId.values()].map((p) => ({ ...p, services: { app: p.configured.includes("call") || p.configured.includes("sms"), sip: VOICE_PROVIDERS.includes(p.id) && p.configured.includes("call") && trunkList.length > 0 } }));
    const now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sdkLog = sdk.data ? listOf(sdk.data.log) : [];
    const calls = sdk.data ? listOf(sdk.data.calls) : [];
    const data = {
      providers,
      counts: {
        inboundRules: rules ? rules.inbound.length : null,
        outboundRules: rules ? rules.outbound.length : null,
        tsa: tsa ? tsa.length : null,
        tsaPublished: tsa ? tsa.filter((t) => t.published).length : null,
        liveCalls: sdk.data ? calls.filter((c) => !c.final).length : null,
        inroute: inroute ? inroute.filter((e) => !e.expiresAt || e.expiresAt > now).length : null,
        eventsToday: sdk.data ? sdkLog.filter((e) => e.at >= today.getTime()).length : null,
        errorsToday: sdk.data ? sdkLog.filter((e) => e.at >= today.getTime() && e.level === "error").length : null,
      },
      publicBaseUrl: s.publicBaseUrl || "",
      warnings: [],
    };
    return { data, computed: true, error: o.error, snap: s, rules, tsa, trunks: trunkList, providers };
  }

  /** What to fix, with where: the server's warnings and what the page sees itself. */
  function computeWarnings(o, snap, rules, tsa, trunks) {
    const out = [];
    const seen = new Set();
    const add = (w) => { const key = w.text.toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(w); } };
    for (const w of o.warnings || []) add(typeof w === "string" ? { text: w } : { text: w.text || w.message || String(w), fix: w.fix, tab: w.tab });
    if (snap) {
      if (snap.enabled === false) add({ text: "The module is off.", fix: "Set ENABLE_TELEPHONY=1 in the server's .env and restart it.", tab: "providers" });
      if (!o.publicBaseUrl && !snap.publicBaseUrl) add({ text: "PUBLIC_BASE_URL is not set: the providers cannot reach the webhooks and Twilio's signatures cannot be checked.", fix: "Add PUBLIC_BASE_URL=https://your.domain to .env and restart, then install the webhooks (Providers).", tab: "providers" });
      for (const w of snap.webhooks || []) {
        const configured = (o.providers || []).find((p) => p.id === w.provider && (p.configured || []).length);
        if (configured && w.verification && !w.verification.configured) add({ text: `${plabel(w.provider)}'s webhooks are accepted without a signature check.`, fix: `Set ${w.verification.needs} in .env and restart.`, tab: "providers" });
      }
      if (snap.persistence && snap.persistence.writable === false) add({ text: "Settings and trunks are kept in memory only.", fix: snap.persistence.reason || "Mount a volume / set DATA_DIR.", tab: "trunks" });
    }
    if ((o.providers || []).length && !(o.providers || []).some((p) => (p.configured || []).length)) add({ text: "No provider is configured.", fix: "Set the variables of Twilio, Telnyx or Vonage in .env (Providers shows which) and restart.", tab: "providers" });
    if (rules) {
      if (!rules.inbound.filter((r) => r.enabled).length) add({ text: "No inbound rule is on: every inbound call gets the default.", fix: "Add an inbound rule, or check Permissions › Defaults.", tab: "inbound" });
      const tsaById = new Map((tsa || []).map((t) => [t.id, t]));
      for (const [dir, list] of [["inbound", rules.inbound], ["outbound", rules.outbound]]) {
        for (const r of list) {
          if (!r.enabled) continue;
          if (r.target && r.target.kind === "tsa" && tsa) {
            const t = tsaById.get(r.target.tsa);
            if (!t) add({ text: `The ${dir} rule “${r.label}” runs “${r.target.tsa}”, which does not exist.`, fix: "Choose another application in the rule.", tab: dir });
            else if (!t.published) add({ text: `The ${dir} rule “${r.label}” runs “${t.name}”, which is not published.`, fix: "Publish the application (Applications).", tab: "apps" });
          }
          if (r.service && r.service.kind === "sip" && trunks && !trunks.some((t) => t.id === r.service.trunk)) add({ text: `The outbound rule “${r.label}” uses the trunk “${r.service.trunk}”, which does not exist.`, fix: "Choose another trunk in the rule, or add it (SIP trunks).", tab: "outbound" });
        }
      }
    }
    return out;
  }

  VIEWS.overview = async (gen) => {
    const ov = await overviewData();
    if (stale(gen)) return null;
    const o = ov.data;
    const [snap, rules, tsa, trunks] = ov.computed ? [ov.snap, ov.rules, ov.tsa, ov.trunks] : await Promise.all([need("snap").then((r) => r.data || null), rulesOf(), tsaOf(), trunksOf()]);
    if (stale(gen)) return null;
    const c = o.counts || {};
    const n = (v) => (v === null || v === undefined ? "—" : String(v));
    const kpi = (label, value, sub, tone, tab) => h("button", { type: "button", class: `kpi tel-kpi${tone ? ` is-${tone}` : ""}`, "data-read": "1", onclick: tab ? () => go(tab) : undefined, "aria-label": `${label}: ${value}${sub ? `, ${sub}` : ""}` },
      h("div", { class: "kpi__label" }, label), h("div", { class: "kpi__value" }, value), sub ? h("div", { class: "kpi__sub" }, sub) : null);
    const warnings = computeWarnings(o, snap, rules, tsa, trunks);
    const box = h("div", { class: "stack", "data-testid": "tel-overview" },
      ov.computed ? h("div", { class: "tel-note" }, ic("circle-alert"), isMissing(ov.error) ? "The admin service has no overview endpoint yet — these numbers are put together from the other answers." : `The overview could not be loaded (${ov.error ? ov.error.message : "?"}) — these numbers are put together from the other answers.`) : null,
      h("div", { class: "grid grid--kpi tel-kpis" },
        kpi("Inbound rules", n(c.inboundRules), "in priority order", "", "inbound"),
        kpi("Outbound rules", n(c.outboundRules), "in priority order", "", "outbound"),
        kpi("Applications", n(c.tsa), c.tsa === null || c.tsa === undefined ? "" : `${n(c.tsaPublished)} published · ${Math.max(0, (c.tsa || 0) - (c.tsaPublished || 0))} drafts`, "", "apps"),
        kpi("Live calls", n(c.liveCalls), "right now", c.liveCalls ? "ok" : "", "calls"),
        kpi("Route codes", n(c.inroute), "live", "", "codes"),
        kpi("Events today", n(c.eventsToday), c.errorsToday ? `${c.errorsToday} errors` : "no errors", c.errorsToday ? "err" : "", "log")));

    const provCards = h("div", { class: "tel-provgrid" });
    for (const p of o.providers || []) provCards.append(providerSummary(p));
    if (!(o.providers || []).length) provCards.append(empty("No provider answered."));
    box.append(card("Providers", "What each provider is configured for, and which services carry calls through it: its application (API key and secret) or SIP trunks.", h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => go("providers") }, "Details"), provCards));

    const wh = h("div", { class: "stack" });
    wh.append(kv([
      ["PUBLIC_BASE_URL", o.publicBaseUrl ? h("span", { class: "row" }, h("code", {}, o.publicBaseUrl), copyBtn(o.publicBaseUrl)) : h("span", { class: "err" }, "not set — webhooks cannot reach this server")],
    ]));
    const hooks = (snap && snap.webhooks) || [];
    if (hooks.length) {
      const t = h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Provider"), h("th", {}, "Signature check"), h("th", {}, "Webhooks"))));
      const tb = h("tbody");
      for (const w of hooks) {
        const v = w.verification || {};
        tb.append(h("tr", {},
          h("td", {}, plabel(w.provider)),
          h("td", {}, v.configured ? badge(`${v.verify} · enforced`, "ok") : badge(`not checked — set ${v.needs}`, "warn")),
          h("td", { class: "mono small" }, `${(w.specs || []).length} URL${(w.specs || []).length === 1 ? "" : "s"}`)));
      }
      t.append(tb);
      wh.append(h("div", { class: "table-wrap table-wrap--short" }, t));
    }
    const warnBox = h("div", { class: "stack", "data-testid": "tel-warnings" });
    if (!warnings.length) warnBox.append(h("div", { class: "tel-ok" }, ic("circle-check"), "Nothing to fix."));
    for (const w of warnings) {
      warnBox.append(h("div", { class: "tel-alert" }, ic("circle-alert"),
        h("div", { class: "tel-alert__text" }, h("div", {}, w.text), w.fix ? h("div", { class: "muted small" }, w.fix) : null),
        w.tab ? h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => go(w.tab) }, `Open ${(TABS.find((t) => t[0] === w.tab) || [, w.tab])[1]}`) : null));
    }
    box.append(h("div", { class: "grid grid--2" },
      card("Public address & webhooks", "Providers call this server back at PUBLIC_BASE_URL/wh/…; signatures prove the calls come from them.", null, wh),
      card(`To fix${warnings.length ? ` (${warnings.length})` : ""}`, "Warnings and how to fix them.", null, warnBox)));
    return box;
  }

  function providerSummary(p) {
    const caps = p.capabilities || [];
    const conf = p.configured || [];
    const svc = p.services || {};
    return h("div", { class: `tel-prov${conf.length ? "" : " is-off"}`, "data-provider": p.id },
      h("div", { class: "tel-prov__head" }, h("strong", {}, p.label || plabel(p.id)), h("span", { class: "mono muted small" }, p.id), h("span", { class: "spacer" }),
        conf.length ? badge(`${conf.length} of ${caps.length}`, "ok") : badge("not configured", "warn")),
      h("div", { class: "tel-prov__caps" }, ...caps.map((cap) => badge(CAP_LABEL[cap] || cap, conf.includes(cap) ? "ok" : "", { title: conf.includes(cap) ? "configured" : "not configured" }))),
      VOICE_PROVIDERS.includes(p.id) ? h("div", { class: "tel-prov__svc small" },
        h("span", { class: svc.app ? "ok" : "muted" }, svc.app ? "✓ " : "✗ ", "Application"),
        h("span", { class: svc.sip ? "ok" : "muted" }, svc.sip ? "✓ " : "✗ ", "SIP trunk")) : null,
      p.reason && !conf.length ? h("div", { class: "muted small tel-prov__reason", title: p.reason }, p.reason) : null);
  }

  /* ============================================================ providers */

  VIEWS.providers = async (gen) => {
    const [snapR, sdkR, ov] = await Promise.all([need("snap"), need("sdk"), need("overview")]);
    if (stale(gen)) return null;
    if (snapR.error && sdkR.error) return failed(snapR.error, () => { forget("snap", "sdk"); renderTab(); }, "The providers");
    const snap = snapR.data || {};
    const box = h("div", { class: "stack", "data-testid": "tel-providers" });
    box.append(defaultsCard(snap));
    const fromSdk = sdkR.data ? listOf(sdkR.data.providers) : [];
    const fromOv = ov.data ? listOf(ov.data.providers) : [];
    const ids = [...new Set([...fromOv.map((p) => p.id), ...fromSdk.map((p) => p.id), ...(snap.webhooks || []).map((w) => w.provider)])];
    if (!ids.length) box.append(card("Providers", null, null, empty("No provider answered.")));
    for (const id of ids) {
      const st = fromSdk.find((p) => p.id === id) || {};
      const o = fromOv.find((p) => p.id === id) || {};
      box.append(providerCard({ id, label: st.label || o.label || plabel(id), capabilities: st.capabilities || o.capabilities || [], configured: st.configured || o.configured || [], needs: st.needs || {}, reason: st.reason || o.reason, services: o.services }, snap));
    }
    if (snap.persistence) {
      const p = snap.persistence;
      box.append(h("div", { class: "muted small" }, "Settings are stored in ", h("code", {}, p.file || "—"), p.writable === false ? ` — not writable: ${p.reason || "kept in memory only"}` : "", p.lastSaveError ? ` — last save failed: ${p.lastSaveError}` : ""));
    }
    return box;
  };

  function defaultsCard(snap) {
    const settings = snap.settings || {};
    const opts = (list) => [{ value: "", label: "(from .env / the first configured)" }, ...(list || []).map((c) => ({ value: c.id, label: `${c.label}${c.configured ? "" : " — not configured"}` }))];
    const sms = gate(select(opts(snap.sms), settings.smsProvider || "", { "data-testid": "tel-def-sms" }), "settings");
    const voice = gate(select(opts(snap.voice), settings.voiceProvider || "", { "data-testid": "tel-def-voice" }), "settings");
    const src = (k) => (snap.defaultsSource && snap.defaultsSource[k]) || "—";
    const now = h("div", { class: "muted small" }, `In use now — SMS: ${(snap.defaults && snap.defaults.sms) || "none"} (${src("sms")}) · voice: ${(snap.defaults && snap.defaults.voice) || "none"} (${src("voice")})`);
    const save = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-def-save", onclick: (e) => busy(e.currentTarget, async () => {
      try {
        await call("/admin/telephony/settings", { method: "PUT", body: { smsProvider: sms.value, voiceProvider: voice.value } });
        toast("Default providers saved", "ok");
        forget("snap", "overview");
        renderTab();
      } catch (err) { toast(err.message, "err"); }
    }) }, "Save defaults"), "settings");
    return card("Default providers", "Which provider sends SMS and places calls when nothing else decides: a request's own choice → this → SMS_PROVIDER / VOICE_PROVIDER in .env → the first configured. Outbound rules decide calls before any default.", null,
      h("div", { class: "form-grid" }, field("SMS", sms), field("Voice", voice)), h("div", { class: "row" }, now, h("span", { class: "spacer" }), save));
  }

  function providerCard(p, snap) {
    const caps = p.capabilities || [];
    const conf = p.configured || [];
    const needs = p.needs || {};
    const out = h("div", { class: "tel-testout", "aria-live": "polite" });
    const capRows = caps.map((cap) => h("tr", {},
      h("td", {}, CAP_LABEL[cap] || cap),
      h("td", {}, conf.includes(cap) ? badge("configured", "ok") : badge("missing", "warn")),
      h("td", { class: "mono small" }, (needs[cap] || []).length ? (needs[cap] || []).map((v, i) => [i ? ", " : "", h("code", { class: conf.includes(cap) ? "" : "tel-missing" }, v)]) : "—")));
    const w = (snap.webhooks || []).find((x) => x.provider === p.id);
    const hooks = w ? webhooksBlock(w, snap.publicBaseUrl) : null;
    const test = gate(h("button", { type: "button", class: "btn btn--sm", "data-testid": `tel-prov-test-${p.id}`, onclick: (e) => busy(e.currentTarget, () => runTest(out, "/admin/telephony/tests/provider", { provider: p.id }, `Provider test: ${p.label}`)) }, ic("play"), "Test the provider"), "test");
    const svc = p.services;
    return h("div", { class: `card tel-card tel-provcard${conf.length ? "" : " is-off"}`, "data-testid": `tel-prov-${p.id}` },
      h("div", { class: "card__head" },
        h("div", { class: "tel-card__titles" }, h("div", { class: "card__title" }, p.label, " ", h("span", { class: "mono muted small" }, p.id)),
          h("div", { class: "card__hint" }, conf.length ? `Configured for ${conf.map((c) => CAP_LABEL[c] || c).join(", ")}.` : p.reason || "Not configured.")),
        h("div", { class: "card__actions" },
          svc && VOICE_PROVIDERS.includes(p.id) ? [badge(svc.app ? "application ✓" : "application ✗", svc.app ? "ok" : ""), badge(svc.sip ? "SIP trunk ✓" : "SIP trunk ✗", svc.sip ? "ok" : "")] : null,
          test)),
      caps.length ? h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "t" },
        h("thead", {}, h("tr", {}, h("th", {}, "Capability"), h("th", {}, "State"), h("th", {}, "Environment variables (names)"))),
        h("tbody", {}, ...capRows))) : null,
      caps.some((cap) => !conf.includes(cap)) ? h("div", { class: "muted small" }, "Missing variables go into the server's .env (never into this console); restart the services afterwards.") : null,
      hooks, out);
  }

  function webhooksBlock(w, baseUrl) {
    const v = w.verification || {};
    const out = h("div", { class: "tel-testout", "aria-live": "polite" });
    const install = gate(h("button", { type: "button", class: "btn btn--sm", disabled: baseUrl ? undefined : true, title: baseUrl ? undefined : "Set PUBLIC_BASE_URL first", "data-testid": `tel-wh-install-${w.provider}`, onclick: (e) => busy(e.currentTarget, async () => {
      clear(out).append(loading(`Installing the webhooks in ${plabel(w.provider)}…`));
      try {
        const r = await call("/admin/telephony/webhooks/install", { method: "POST", body: { provider: w.provider } });
        clear(out).append(h("div", { class: "tel-result" }, badge("installed", "ok"), " ", r.message || "", (r.details || []).length ? h("ul", { class: "small" }, ...r.details.map((d) => h("li", {}, d))) : null));
        forget("snap", "overview");
      } catch (err) {
        clear(out).append(h("div", { class: "tel-result" }, badge("failed", "err"), " ", err.message, ((err.data && err.data.details) || []).length ? h("ul", { class: "small" }, ...err.data.details.map((d) => h("li", {}, d))) : null));
      }
    }) }, ic("download"), `Install in ${plabel(w.provider)}`), "settings");
    const rows = (w.specs || []).map((s) => h("tr", {},
      h("td", { class: "mono small" }, s.method),
      h("td", { class: "mono small tel-url" }, s.url || s.path),
      h("td", { class: "small" }, s.description || ""),
      h("td", {}, copyBtn(s.url || s.path, "Copy", "URL copied"))));
    return h("div", { class: "tel-sub" },
      h("div", { class: "row" }, h("strong", { class: "small" }, "Webhooks"),
        v.configured ? badge(`signature: ${v.verify} (enforced)`, "ok") : badge(`signature not checked — set ${v.needs}`, "warn"),
        h("span", { class: "spacer" }), install),
      rows.length ? h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "t" }, h("tbody", {}, ...rows))) : null,
      baseUrl ? null : h("div", { class: "muted small" }, "The URLs are relative until PUBLIC_BASE_URL is set."),
      out);
  }

  /** A test's answer (TelTestResult) as a checklist, with its log lines. */
  function testResult(r, title) {
    const checks = r.checks || [];
    const extra = Object.entries(r).filter(([k]) => !["ok", "checks", "log", "at", "message"].includes(k));
    return h("div", { class: "tel-result", "data-testid": "tel-test-result" },
      h("div", { class: "row" }, title ? h("strong", { class: "small" }, title) : null, r.ok ? badge("passed", "ok") : badge("failed", "err"), r.at ? h("span", { class: "muted small" }, whenSec(r.at)) : null),
      r.message ? h("div", { class: "small" }, r.message) : null,
      checks.length ? h("ul", { class: "tel-checklist" }, ...checks.map((c) => h("li", { class: `tel-check is-${c.ok === true ? "ok" : c.ok === false ? "err" : "skip"}` },
        h("span", { class: "tel-check__mark", "aria-label": c.ok === true ? "passed" : c.ok === false ? "failed" : "not run" }, c.ok === true ? "✓" : c.ok === false ? "✗" : "–"),
        h("div", { class: "tel-check__text" }, h("div", {}, c.label || c.id), c.detail ? h("div", { class: "muted small" }, c.detail) : null),
        c.ms !== undefined && c.ms !== null ? h("span", { class: "mono small muted" }, `${c.ms} ms`) : null))) : null,
      extra.length ? kv(extra.map(([k, v]) => [k, typeof v === "object" ? jsonTree(v, 1) : String(v)])) : null,
      (r.log || []).length ? h("details", { class: "tel-details" }, h("summary", {}, `Log (${r.log.length} lines)`), h("pre", { class: "code" }, r.log.join("\n"))) : null);
  }

  async function runTest(out, path, body, title) {
    clear(out).append(loading(`${title}…`));
    try {
      const r = await call(path, { method: "POST", body });
      S.lastTest[path] = r;
      clear(out).append(testResult(r, title));
      return r;
    } catch (err) {
      if (err.data && Array.isArray(err.data.checks)) clear(out).append(testResult({ ...err.data, ok: false }, title));
      else clear(out).append(isMissing(err) ? failed(err, null, "This test") : h("div", { class: "tel-result" }, badge("failed", "err"), " ", err.message));
      return null;
    }
  }

  /* ===================================================== target & hours */

  /** What a routed call does: run an application, answer with a state, or (outbound) pass. */
  function targetPicker(target, opts = {}) {
    const t = target || {};
    const name = `tel-target-${Math.random().toString(36).slice(2, 8)}`;
    const kinds = [["tsa", "Run an application"], ["state", "Answer with a state"]];
    if (opts.allowPass) kinds.push(["pass", "Pass — as the caller asked"]);
    let kind = kinds.some(([k]) => k === t.kind) ? t.kind : opts.allowPass ? "pass" : "state";
    const tsaList = opts.tsaList || [];
    const tsaSel = select([{ value: "", label: tsaList.length ? "— choose an application —" : "— no application yet —" }, ...tsaList.map((a) => ({ value: a.id, label: `${a.name || a.id}${a.published ? ` · v${a.publishedVersion || a.version}` : " · draft only — not published"}` }))], t.kind === "tsa" ? t.tsa : "", { disabled: opts.disabled || undefined, "data-testid": opts.testid ? `${opts.testid}-tsa-select` : undefined, "aria-label": "Application" });
    if (t.kind === "tsa" && t.tsa && !tsaList.some((a) => a.id === t.tsa)) { tsaSel.append(h("option", { value: t.tsa }, `${t.tsa} (missing)`)); tsaSel.value = t.tsa; }
    const stateSel = select(STATES.map((s) => ({ value: s, label: `${s} — ${STATE_HELP[s]}` })), t.kind === "state" ? t.state : "busy", { disabled: opts.disabled || undefined, "data-testid": opts.testid ? `${opts.testid}-state-select` : undefined, "aria-label": "State" });
    const tsaHint = h("div", { class: "tel-hint" });
    const syncHint = () => {
      const a = tsaList.find((x) => x.id === tsaSel.value);
      tsaHint.textContent = a ? (a.published ? `${a.description || ""}${a.description ? " · " : ""}published v${a.publishedVersion || a.version}` : "Not published: calls cannot run it until it is (Applications).") : "";
      tsaHint.classList.toggle("tel-hint--err", Boolean(a && !a.published));
    };
    tsaSel.addEventListener("change", syncHint);
    syncHint();
    const tsaBox = h("div", { class: "tel-target__sub" }, tsaSel, tsaHint);
    const stateBox = h("div", { class: "tel-target__sub" }, stateSel);
    const passBox = h("div", { class: "tel-target__sub tel-hint" }, "The call goes as its caller asked: m5.telephony.call's actions and handlers, or the console's test.");
    const radios = h("div", { class: "tel-radios", role: "radiogroup", "aria-label": opts.label || "Target" });
    const sync = () => { tsaBox.hidden = kind !== "tsa"; stateBox.hidden = kind !== "state"; passBox.hidden = kind !== "pass"; };
    for (const [k, label] of kinds) {
      const r = h("input", { type: "radio", name, value: k, disabled: opts.disabled || undefined, "data-testid": opts.testid ? `${opts.testid}-${k}` : undefined });
      r.checked = k === kind;
      r.addEventListener("change", () => { if (r.checked) { kind = k; sync(); if (opts.onchange) opts.onchange(); } });
      radios.append(h("label", { class: "tel-radio" }, r, h("span", {}, label)));
    }
    sync();
    const value = () => (kind === "tsa" ? { kind: "tsa", tsa: tsaSel.value } : kind === "state" ? { kind: "state", state: stateSel.value } : { kind: "pass" });
    return { el: h("div", { class: "tel-target" }, radios, tsaBox, stateBox, passBox), value };
  }

  const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Prague"; } catch { return "Europe/Prague"; } };

  /** A weekly window ("mon-fri 08:00–17:00" in a time zone), or always. */
  function hoursEditor(hours, disabled) {
    const on = toggle("Only at certain times", Boolean(hours), { disabled: disabled || undefined, "data-testid": "tel-hours-on" });
    const tz = input(hours ? hours.timezone : localTz(), { placeholder: "Europe/Prague", disabled: disabled || undefined, "data-testid": "tel-hours-tz" });
    const days = input(hours ? hours.days : "mon-fri", { placeholder: "mon-fri", disabled: disabled || undefined, "data-testid": "tel-hours-days" });
    const from = input(hours ? hours.from : "08:00", { type: "time", disabled: disabled || undefined, "data-testid": "tel-hours-from" });
    const to = input(hours ? hours.to : "17:00", { type: "time", disabled: disabled || undefined, "data-testid": "tel-hours-to" });
    const presets = h("div", { class: "row tel-presets" }, ...["mon-fri", "sat,sun", "mon-sun"].map((p) => h("button", { type: "button", class: "btn btn--sm", "data-read": "1", disabled: disabled || undefined, onclick: () => { days.value = p; } }, p)));
    const grid = h("div", { class: "form-grid tel-hours" },
      field("Time zone", tz, "IANA name: Europe/Prague, UTC…", { "data-field": "match.hours.timezone" }),
      field("Days", days, presets, { "data-field": "match.hours.days" }),
      field("From", from, null, { "data-field": "match.hours.from" }),
      field("To", to, "A window past midnight (22:00 → 06:00) is fine.", { "data-field": "match.hours.to" }));
    const sync = () => { grid.hidden = !on.box.checked; };
    on.box.addEventListener("change", sync);
    sync();
    const value = () => (on.box.checked ? { timezone: tz.value.trim(), days: days.value.trim().toLowerCase().replace(/\s+/g, ""), from: from.value.trim(), to: to.value.trim() } : null);
    return { el: h("div", { class: "stack" }, on.el, grid), value };
  }

  /* ========================================================== permissions */

  function withDefaults(p) {
    const out = structuredClone(DEFAULT_PERMISSIONS);
    for (const sec of Object.keys(out)) if (p && p[sec] && typeof p[sec] === "object") out[sec] = { ...out[sec], ...structuredClone(p[sec]) };
    return out;
  }

  VIEWS.permissions = async (gen) => {
    const [r, tsa] = await Promise.all([need("perms"), tsaOf()]);
    if (stale(gen)) return null;
    const missing = Boolean(r.error && isMissing(r.error));
    if (r.error && !missing) return failed(r.error, () => { forget("perms"); renderTab(); }, "The permissions");
    const perms = withDefaults(r.data ? r.data.permissions : null);
    const access = r.data ? listOf(r.data.access) : [];
    const ro = !may("settings") || missing;
    const dis = ro || undefined;
    const n = (v, min, max, testid) => numberInput(v, min, max, { disabled: dis, "data-testid": testid });

    const countries = chips(perms.outbound.countries, { validate: countryProblem, upper: true, placeholder: "CZ, SK, DE… or * (empty: see below)", label: "Countries", disabled: ro, testid: "tel-perm-countries" });
    const blocked = chips(perms.outbound.blocked, { validate: patternProblem, placeholder: "+1900*", label: "Blocked numbers", disabled: ro, testid: "tel-perm-blocked" });
    const outConc = n(perms.outbound.maxConcurrentCalls, 0, 1000, "tel-perm-out-conc");
    const outCalls = n(perms.outbound.callsPerHour, 0, 100000, "tel-perm-out-calls");
    const outSms = n(perms.outbound.smsPerHour, 0, 100000, "tel-perm-out-sms");
    const outMin = n(perms.outbound.maxMinutes, 1, 1440, "tel-perm-out-min");
    const inConc = n(perms.inbound.maxConcurrentCalls, 0, 1000, "tel-perm-in-conc");
    const inCaller = n(perms.inbound.perCallerPerHour, 0, 10000, "tel-perm-in-caller");
    const irTtl = n(perms.inroute.maxTtlSec, 60, 30 * 86400, "tel-perm-ir-ttl");
    const irActive = n(perms.inroute.maxActivePerOwner, 1, 10000, "tel-perm-ir-active");
    const irAttempts = n(perms.inroute.maxAttemptsPerCall, 1, 20, "tel-perm-ir-attempts");
    const irFail = n(perms.inroute.maxFailuresPerCallerPerHour, 1, 1000, "tel-perm-ir-fail");
    const irDid = n(perms.inroute.maxFailuresPerDidPerHour, 1, 10000, "tel-perm-ir-did");
    const irMin = n(perms.inroute.maxFailuresPerMinute, 1, 1000, "tel-perm-ir-min");
    const irHour = n(perms.inroute.maxFailuresPerHour, 1, 10000, "tel-perm-ir-hour");
    const hosts = chips(perms.tsa.httpHosts, { validate: hostProblem, placeholder: "api.example.com, *.example.org (empty = the http tool is off)", label: "HTTP hosts", disabled: ro, testid: "tel-perm-hosts" });
    const fns = toggle("Applications may run Functions models (the function tool)", perms.tsa.functions, { disabled: dis, "data-testid": "tel-perm-fns" });
    const recDays = n(perms.tsa.recordingDays, 0, 3650, "tel-perm-rec-days");
    const logDays = n(perms.log.days, 1, 3650, "tel-perm-log-days");
    const keepRaw = toggle("Keep the provider's raw payload (secrets removed) next to the parsed data", perms.log.keepRaw, { disabled: dis, "data-testid": "tel-perm-keep-raw" });
    const defIn = targetPicker(perms.defaults.inbound, { allowPass: false, tsaList: tsa || [], disabled: ro, testid: "tel-perm-def-in", label: "Unmatched inbound calls" });
    const defOut = targetPicker(perms.defaults.outbound, { allowPass: true, tsaList: tsa || [], disabled: ro, testid: "tel-perm-def-out", label: "Unmatched outbound calls" });
    let problemsEl = problemsBox([]);
    problemsEl.setAttribute("data-testid", "tel-perm-problems");
    const showProblems = (list) => { const fresh = problemsBox(list); fresh.setAttribute("data-testid", "tel-perm-problems"); problemsEl.replaceWith(fresh); problemsEl = fresh; };

    const collect = () => ({
      outbound: { countries: countries.values(), blocked: blocked.values(), maxConcurrentCalls: numberOf(outConc, 0, 1000), callsPerHour: numberOf(outCalls, 0, 100000), smsPerHour: numberOf(outSms, 0, 100000), maxMinutes: numberOf(outMin, 1, 1440) },
      inbound: { maxConcurrentCalls: numberOf(inConc, 0, 1000), perCallerPerHour: numberOf(inCaller, 0, 10000) },
      inroute: { maxTtlSec: numberOf(irTtl, 60, 30 * 86400), maxActivePerOwner: numberOf(irActive, 1, 10000), maxAttemptsPerCall: numberOf(irAttempts, 1, 20), maxFailuresPerCallerPerHour: numberOf(irFail, 1, 1000), maxFailuresPerDidPerHour: numberOf(irDid, 1, 10000), maxFailuresPerMinute: numberOf(irMin, 1, 1000), maxFailuresPerHour: numberOf(irHour, 1, 10000) },
      tsa: { httpHosts: hosts.values(), functions: fns.box.checked, recordingDays: numberOf(recDays, 0, 3650) },
      log: { days: numberOf(logDays, 1, 3650), keepRaw: keepRaw.box.checked },
      defaults: { inbound: defIn.value(), outbound: defOut.value() },
    });
    const check = (p) => {
      const out = [];
      for (const [v, pr] of countries.problems()) out.push(`Country ${v}: ${pr}`);
      for (const [v, pr] of blocked.problems()) out.push(`Blocked ${v}: ${pr}`);
      for (const [v, pr] of hosts.problems()) out.push(`Host ${v}: ${pr}`);
      for (const [k, t] of [["inbound", p.defaults.inbound], ["outbound", p.defaults.outbound]]) if (t.kind === "tsa" && !t.tsa) out.push(`Unmatched ${k} calls: choose the application.`);
      return out;
    };
    const save = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-perm-save", onclick: (e) => busy(e.currentTarget, async () => {
      const p = collect();
      const bad = check(p);
      showProblems(bad);
      if (bad.length) { toast("Fix the marked values first.", "err"); return; }
      try {
        await call("/admin/telephony/permissions", { method: "PUT", body: { permissions: p } });
        toast("Permissions saved", "ok");
        forget("perms", "overview");
        renderTab();
      } catch (err) {
        showProblems((err.data && err.data.problems) || [err.message]);
        toast(err.message, "err");
      }
    }) }, ic("save"), "Save permissions"), "settings");
    if (missing) save.disabled = true;
    const reset = gate(h("button", { type: "button", class: "btn", "data-read": "1", onclick: () => {
      if (!confirm("Put the defaults into the form? Nothing is saved until you press Save.")) return;
      cache.set("perms", Promise.resolve({ data: { permissions: structuredClone(DEFAULT_PERMISSIONS), access } }));
      renderTab();
      toast("The defaults are in the form — Save to keep them.", "ok");
    } }, ic("rotate-ccw"), "Defaults"), "settings");

    const sec = (title, hint, ...body) => card(title, hint, null, h("div", { class: "form-grid" }, ...body));
    const acc = C.moduleAccess ? C.moduleAccess("telephony") : null;
    const accessRows = access.map((a) => h("tr", {},
      h("td", { class: "mono" }, a.group),
      h("td", {}, (a.allow || []).length ? h("div", { class: "tel-badges" }, ...(a.allow || []).map((x) => badge(x, "ok"))) : h("span", { class: "muted" }, "—")),
      h("td", {}, (a.deny || []).length ? h("div", { class: "tel-badges" }, ...(a.deny || []).map((x) => badge(x, "err"))) : h("span", { class: "muted" }, "—"))));
    return h("div", { class: "stack", "data-testid": "tel-permissions" },
      missing ? h("div", { class: "tel-note tel-note--warn" }, ic("hourglass"), "The admin service does not offer the permissions yet — the form shows the defaults and cannot be saved.") : null,
      h("div", { class: "card tel-savebar" },
        h("div", {}, h("strong", {}, "The module's limits and defaults"), h("div", { class: "muted small" }, "They apply to everyone, on top of Modules & groups (who may call, text, use numbers…). The server checks and clamps every value.")),
        h("span", { class: "spacer" }), reset, save),
      problemsEl,
      h("div", { class: "grid grid--2" },
        sec("Outbound calls & SMS", "Where calls and messages may go, and how many.",
          h("div", { class: "tel-span2" }, field("Countries (ISO 3166)", countries.el, "Empty = any country for functions and the app, but an application (TSA) — which anyone who calls drives, with a caller ID that can be faked — only your own countries (those of your numbers and of the number called). * = any country, for a TSA too.")),
          h("div", { class: "tel-span2" }, field("Never dialled", blocked.el, "Premium-rate, satellite… patterns as in the rules; a rule cannot override them.")),
          field("Concurrent calls", outConc), field("Calls per caller and hour", outCalls), field("SMS per caller and hour", outSms), field("Longest call (minutes)", outMin)),
        h("div", { class: "stack" },
          sec("Inbound calls", "Flood and toll protection.",
            field("Concurrent calls", inConc), field("Calls from one number per hour", inCaller, "Then the caller gets busy.")),
          sec("Route codes", "m5.telephony.inroute.add and the Route audio tool.",
            field("Longest TTL (seconds)", irTtl, "Over 10 minutes a code has 6 digits."), field("Live codes per owner", irActive), field("Wrong codes per call", irAttempts, "The one that reaches it ends the call."), field("Wrong codes per caller and hour", irFail, "Then the caller is refused outright — but a caller ID can be faked, hence the limits below."),
            field("Wrong codes per number called and hour", irDid, "Then codes on that number pause: 1 min, doubling up to 1 h."), field("Wrong codes per minute (all numbers)", irMin, "Then codes pause for everyone, the same way."), field("Wrong codes per hour (all numbers)", irHour))),
        sec("Applications (TSA)", "What call flows may reach.",
          h("div", { class: "tel-span2" }, field("HTTP tool: hosts", hosts.el, "Exact host or *.example.com. Empty = the http tool is off.")),
          fns.el, field("Keep recordings (days)", recDays)),
        sec("Event log", "Telephony › Log.", field("Keep events (days)", logDays), keepRaw.el),
        card("Defaults", "What happens to a call no rule matched.", null,
          h("div", { class: "grid grid--2" },
            h("fieldset", { class: "tel-fieldset" }, h("legend", {}, "Unmatched inbound call"), defIn.el),
            h("fieldset", { class: "tel-fieldset" }, h("legend", {}, "Unmatched outbound call"), defOut.el))),
        card("Access (Modules & groups)", "Who has which rights in this module — edited in Modules & groups.", h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "data-go": "modules" }, ic("external-link"), "Modules & groups"),
          accessRows.length ? h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "t", "data-testid": "tel-access" }, h("thead", {}, h("tr", {}, h("th", {}, "Group"), h("th", {}, "Allows"), h("th", {}, "Denies"))), h("tbody", {}, ...accessRows))) : empty(missing ? "Not available yet." : "No group has rights of its own here: the module's default access applies."),
          h("div", { class: "muted small" }, "Your access: ", acc ? (acc.allowed ? (acc.rights ? acc.rights.join(", ") || "reading" : "everything") : "none") : "unknown", can("operator") ? "" : " (auditor: read only)"),
          h("div", { class: "muted small" }, "Rights of this console: settings (providers, permissions, route codes), routing (rules), tsa (applications), test (tests), log (full log entries)."))));
  };

  /* ============================================================== routing */

  function patternsText(list, any) { return list && list.length ? list.join(", ") : any; }
  function hoursText(hw) { return hw ? `${hw.days} ${hw.from}–${hw.to} (${hw.timezone})` : "always"; }
  function trunkName(id, trunks) { const t = (trunks || []).find((x) => x.id === id); return t ? (t.label || t.id) : `${id} (missing)`; }
  function serviceText(s, ctx = {}) {
    if (!s) return "—";
    if (s.kind === "app") return `Application · ${plabel(s.provider)}`;
    const cid = s.callerId || {};
    return `SIP trunk ${trunkName(s.trunk, ctx.trunks)} via ${plabel(s.provider)} · caller ID ${cid.number || "the trunk's"}${cid.name ? ` “${cid.name}”` : ""}${cid.presentation === "restricted" ? " (withheld)" : ""}`;
  }
  function targetEl(t, ctx = {}) {
    if (!t) return "—";
    if (t.kind === "tsa") {
      const a = (ctx.tsa || []).find((x) => x.id === t.tsa);
      return h("span", { class: "tel-badges" }, badge(`▶ ${a ? a.name : t.tsa}`, "accent"), a && !a.published ? badge("not published", "warn") : null, !a && ctx.tsa ? badge("missing", "err") : null);
    }
    if (t.kind === "state") return badge(t.state, t.state === "hangup" || t.state === "rejected" ? "err" : "warn", { title: STATE_HELP[t.state] || "" });
    return badge("pass", "info", { title: "as the caller asked" });
  }

  async function routingCtx() {
    const [tsa, trunks, snap, perms, sdk] = await Promise.all([tsaOf(), trunksOf(), need("snap"), need("perms"), need("sdk")]);
    return {
      tsa: tsa || [], trunks: trunks || [], snap: snap.data || {},
      groups: perms.data ? listOf(perms.data.access).map((a) => a.group) : [],
      providers: sdk.data ? listOf(sdk.data.providers) : [],
      defaults: perms.data && perms.data.permissions ? withDefaults(perms.data.permissions).defaults : DEFAULT_PERMISSIONS.defaults,
    };
  }

  async function saveRules(dir, next) {
    const rules = next.map((r, i) => ({ ...r, priority: (i + 1) * 10 }));
    try {
      const r = await call(`/admin/telephony/rules/${dir}`, { method: "PUT", body: { rules } });
      const cur = (await rulesOf()) || { inbound: [], outbound: [] };
      const data = Array.isArray(r.inbound) && Array.isArray(r.outbound) ? { inbound: r.inbound, outbound: r.outbound } : { ...cur, [dir]: Array.isArray(r.rules) ? r.rules : Array.isArray(r[dir]) ? r[dir] : rules };
      cache.set("rules", Promise.resolve({ data }));
      forget("overview", "tsa");
      return { ok: true, rules: data[dir] };
    } catch (err) {
      return { ok: false, message: err.message, problems: (err.data && err.data.problems) || [] };
    }
  }

  VIEWS.outbound = (gen) => routingView("outbound", gen);
  VIEWS.inbound = (gen) => routingView("inbound", gen);

  async function routingView(dir, gen) {
    const [rules, ctx] = await Promise.all([rulesOf(), routingCtx()]);
    if (stale(gen)) return null;
    if (!rules) { const r = await need("rules"); return failed(r.error, () => { forget("rules"); renderTab(); }, "The routing rules"); }
    let list = rules[dir].slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
    const ro = !may("routing");
    const tableBox = h("div", { class: "tel-rules", "data-testid": `tel-rules-${dir}` });

    const persist = async (next, okText) => {
      const prev = list;
      list = next;
      draw();
      const r = await saveRules(dir, next);
      if (r.ok) { list = r.rules.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0)); draw(); if (okText) toast(okText, "ok"); }
      else { list = prev; draw(); toast(r.problems.length ? `${r.message}: ${r.problems.map((p) => (typeof p === "string" ? p : p.message)).join("; ")}` : r.message, "err"); }
      return r;
    };
    const move = (from, to) => {
      if (to < 0 || to >= list.length || from === to) return;
      const next = list.slice();
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      void persist(next, "Order saved").then(() => { const row = [...tableBox.querySelectorAll("tr[data-rule]")].find((x) => x.getAttribute("data-rule") === it.id); if (row) row.focus(); });
    };
    const edit = (rule, isNew) => openRuleEditor(dir, rule, isNew, ctx, async (saved) => {
      const i = list.findIndex((r) => r.id === saved.id);
      const next = list.slice();
      if (i >= 0) next[i] = saved; else next.push(saved);
      return persist(next, isNew ? "Rule added" : "Rule saved");
    }, async () => persist(list.filter((r) => r.id !== rule.id), "Rule deleted"));

    let dragFrom = null;
    function draw() {
      clear(tableBox);
      if (!list.length) {
        tableBox.append(empty(dir === "inbound" ? "No inbound rule: every inbound call gets the default below." : "No outbound rule: calls go through the default below.",
          gate(h("button", { type: "button", class: "btn btn--primary", onclick: () => edit(newRule(dir, ctx), true) }, ic("plus"), "Add a rule"), "routing")));
        return;
      }
      const head = dir === "inbound" ? ["", "#", "On", "Rule", "Match", "Target", ""] : ["", "#", "On", "Rule", "Match", "Service", "Target", ""];
      const tbody = h("tbody");
      list.forEach((rule, i) => {
        const on = h("input", { type: "checkbox", "aria-label": `${rule.label} on`, "data-testid": `tel-rule-on-${rule.id}` });
        on.checked = rule.enabled;
        gate(on, "routing");
        on.addEventListener("change", () => { const next = list.slice(); next[i] = { ...rule, enabled: on.checked }; void persist(next, `${rule.label}: ${on.checked ? "on" : "off"}`); });
        const m = rule.match || {};
        const lines = dir === "inbound"
          ? [["called", patternsText(m.numbers, "any number")], ["caller", patternsText(m.from, "anyone")], ["via", `${m.provider ? plabel(m.provider) : "any provider"} · ${m.service === "app" ? "application" : m.service === "sip" ? "SIP trunk" : "any service"}`], ["when", hoursText(m.hours)]]
          : [["to", patternsText(m.to, "anywhere")], ["who", `${patternsText(m.groups, "any group")} · ${m.sources && m.sources.length ? m.sources.join(", ") : "any source"}`], ["when", hoursText(m.hours)]];
        const btn = (icon, label, fn, extra = {}) => h("button", { type: "button", class: "btn btn--sm btn--ghost tel-ibtn", "aria-label": label, title: label, onclick: (e) => { e.stopPropagation(); fn(); }, ...extra }, ic(icon));
        const actions = h("div", { class: "tel-rowactions" },
          gate(btn("chevron-up", "Move up", () => move(i, i - 1), { disabled: i === 0 || undefined }), "routing"),
          gate(btn("chevron-down", "Move down", () => move(i, i + 1), { disabled: i === list.length - 1 || undefined }), "routing"),
          btn("settings-2", ro ? "View" : "Edit", () => edit(rule, false), { "data-read": "1", "data-testid": `tel-rule-edit-${rule.id}` }),
          gate(btn("copy", "Duplicate", () => { const copyRule = { ...structuredClone(rule), id: uid(dir === "inbound" ? "in" : "out"), label: `${rule.label} (copy)`, enabled: false }; const next = list.slice(); next.splice(i + 1, 0, copyRule); void persist(next, "Rule duplicated (switched off)"); }), "routing"),
          gate(btn("trash-2", "Delete", () => { if (confirm(`Delete the rule “${rule.label}”?`)) void persist(list.filter((r) => r.id !== rule.id), "Rule deleted"); }, { class: "btn btn--sm btn--ghost tel-ibtn tel-ibtn--danger", "data-testid": `tel-rule-del-${rule.id}` }), "routing"));
        const tr = h("tr", { class: `is-clickable${rule.enabled ? "" : " is-off"}${S.match[dir] === rule.id ? " is-match" : ""}`, tabindex: "0", "data-rule": rule.id, draggable: ro ? undefined : "true", "aria-label": `Rule ${i + 1}: ${rule.label}` },
          h("td", { class: "tel-grip", "aria-hidden": "true", title: ro ? "" : "Drag to reorder (or Alt+↑ / Alt+↓)" }, ro ? null : ic("grip-vertical")),
          h("td", { class: "num" }, String(i + 1)),
          h("td", {}, h("label", { class: "switch" }, on)),
          h("td", {}, h("div", { class: "tel-rule__label" }, rule.label || h("span", { class: "muted" }, "(no name)")), rule.note ? h("div", { class: "muted small tel-clip" }, rule.note) : null, dir === "inbound" && rule.record ? badge("recorded", "violet") : null),
          h("td", { class: "small tel-match" }, ...lines.map(([k, v]) => h("div", {}, h("span", { class: "muted" }, `${k} `), h("span", { class: k === "when" ? "" : "mono" }, v)))),
          dir === "outbound" ? h("td", { class: "small" }, serviceText(rule.service, ctx)) : null,
          h("td", {}, targetEl(rule.target, ctx)),
          h("td", {}, actions));
        tr.addEventListener("click", (e) => { if (!e.target.closest("button, input, label, a")) edit(rule, false); });
        tr.addEventListener("keydown", (e) => {
          if (e.target !== tr) return;
          if (e.key === "Enter") { e.preventDefault(); edit(rule, false); }
          else if (e.altKey && e.key === "ArrowUp" && !ro) { e.preventDefault(); move(i, i - 1); }
          else if (e.altKey && e.key === "ArrowDown" && !ro) { e.preventDefault(); move(i, i + 1); }
        });
        if (!ro) {
          tr.addEventListener("dragstart", (e) => { dragFrom = i; tr.classList.add("is-dragging"); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", rule.id); } catch { /* old browsers */ } } });
          tr.addEventListener("dragend", () => { dragFrom = null; for (const r of tbody.querySelectorAll("tr")) r.classList.remove("is-dragging", "drop-before", "drop-after"); });
          tr.addEventListener("dragover", (e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            const box = tr.getBoundingClientRect();
            const after = e.clientY > box.top + box.height / 2;
            for (const r of tbody.querySelectorAll("tr")) r.classList.remove("drop-before", "drop-after");
            tr.classList.add(after ? "drop-after" : "drop-before");
          });
          tr.addEventListener("drop", (e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            const after = tr.classList.contains("drop-after");
            let to = i + (after ? 1 : 0);
            if (dragFrom < to) to -= 1;
            const from = dragFrom;
            dragFrom = null;
            move(from, to);
          });
        }
        tbody.append(tr);
      });
      tableBox.append(h("div", { class: "table-wrap" }, h("table", { class: "t tel-ruletable" }, h("thead", {}, h("tr", {}, ...head.map((x) => h("th", {}, x)))), tbody)));
    }
    draw();

    const add = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": `tel-rule-add-${dir}`, onclick: () => edit(newRule(dir, ctx), true) }, ic("plus"), "Add a rule"), "routing");
    const def = ctx.defaults[dir];
    const box = h("div", { class: "tel-split" },
      card(dir === "inbound" ? "Inbound rules" : "Outbound rules",
        dir === "inbound"
          ? "An inbound call (to a number of a provider's application, or through a SIP trunk) runs the first enabled rule that matches the number called, the caller, the provider, the service and the time."
          : "An outbound call (m5.telephony.call, an application's Dial, a console test) takes the first enabled rule that matches: it decides the provider and the service that carry the call, and what runs when it is answered.",
        add, tableBox,
        h("div", { class: "tel-default small" }, h("span", { class: "muted" }, "No rule matched → "), targetEl(def, ctx), " ", h("button", { type: "button", class: "btn btn--sm btn--ghost", "data-read": "1", onclick: () => go("permissions") }, "change the default")),
        ro ? h("div", { class: "muted small" }, denyText("routing")) : null),
      dryRunCard(dir, ctx, (d) => {
        S.match[dir] = d.rule;
        for (const row of tableBox.querySelectorAll("tr[data-rule]")) row.classList.toggle("is-match", row.getAttribute("data-rule") === d.rule);
      }));
    if (S.arg) {
      const rule = list.find((r) => r.id === S.arg);
      if (rule) setTimeout(() => edit(rule, false), 0);
      S.arg = "";
      writeHash();
    }
    return box;
  }

  function newRule(dir, ctx = {}) {
    if (dir === "inbound") return { id: uid("in"), label: "", enabled: true, priority: 0, match: { numbers: [], from: [], provider: "", service: "", hours: null }, target: { kind: "state", state: "busy" }, record: false, note: "" };
    const voice = (ctx.snap && ctx.snap.defaults && ctx.snap.defaults.voice) || "";
    return { id: uid("out"), label: "", enabled: true, priority: 0, match: { to: [], groups: [], sources: [], hours: null }, service: { kind: "app", provider: VOICE_PROVIDERS.includes(voice) ? voice : "" }, target: { kind: "pass" }, note: "" };
  }

  /** The provider's application or a SIP trunk (with its caller ID). */
  function serviceEditor(service, ctx, disabled) {
    const s = service || { kind: "app", provider: "" };
    let kind = s.kind === "sip" ? "sip" : "app";
    const name = `tel-svc-${Math.random().toString(36).slice(2, 8)}`;
    const provOpts = [{ value: "", label: "— choose —" }, ...VOICE_PROVIDERS.map((id) => {
      const st = ctx.providers.find((p) => p.id === id);
      return { value: id, label: `${plabel(id)}${st && !(st.configured || []).includes("call") ? " — calls not configured" : ""}` };
    })];
    const appProv = select(provOpts, kind === "app" ? s.provider : "", { disabled: disabled || undefined, "data-testid": "tel-svc-app-provider", "aria-label": "Provider" });
    const appInfo = h("div", { class: "tel-hint" });
    const syncApp = () => {
      clear(appInfo);
      const st = ctx.providers.find((p) => p.id === appProv.value);
      appInfo.append("Uses the provider's API key and secret from the server's environment — nothing secret is stored in the rule.");
      if (st) {
        const vars = (st.needs && st.needs.call) || [];
        const ok = (st.configured || []).includes("call");
        appInfo.append(h("div", {}, ok ? badge("configured for calls", "ok") : badge("calls not configured", "warn"), vars.length ? [" ", ...vars.map((v, i) => [i ? ", " : "", h("code", {}, v)])] : null));
      }
    };
    appProv.addEventListener("change", syncApp);
    syncApp();
    const sipProv = select(provOpts, kind === "sip" ? s.provider : "", { disabled: disabled || undefined, "data-testid": "tel-svc-sip-provider", "aria-label": "Provider that dials the trunk" });
    const trunks = ctx.trunks || [];
    const trunk = select([{ value: "", label: trunks.length ? "— choose a trunk —" : "— no trunk yet —" }, ...trunks.map((t) => ({ value: t.id, label: `${t.label || t.id} · ${t.host}:${t.port || 5060}` }))], kind === "sip" ? s.trunk : "", { disabled: disabled || undefined, "data-testid": "tel-svc-trunk", "aria-label": "SIP trunk" });
    if (kind === "sip" && s.trunk && !trunks.some((t) => t.id === s.trunk)) { trunk.append(h("option", { value: s.trunk }, `${s.trunk} (missing)`)); trunk.value = s.trunk; }
    const cid = s.callerId || { number: "", name: "", presentation: "allowed" };
    const cidNum = input(cid.number, { placeholder: "+420212345678", disabled: disabled || undefined, "data-testid": "tel-svc-cid-number" });
    const cidName = input(cid.name, { placeholder: "M5cet Support", maxlength: "40", disabled: disabled || undefined, "data-testid": "tel-svc-cid-name" });
    const pres = select([{ value: "allowed", label: "Shown" }, { value: "restricted", label: "Withheld (anonymous)" }], cid.presentation || "allowed", { disabled: disabled || undefined, "data-testid": "tel-svc-cid-pres" });
    const cidHint = h("div", { class: "tel-hint" });
    const syncTrunk = () => {
      const t = trunks.find((x) => x.id === trunk.value);
      cidNum.placeholder = t && t.callerIdNumber ? t.callerIdNumber : "+420212345678";
      cidName.placeholder = t && t.callerIdName ? t.callerIdName : "M5cet Support";
      cidHint.textContent = t ? `Empty = the trunk's own: ${t.callerIdNumber || "none"}${t.callerIdName ? ` “${t.callerIdName}”` : ""}. The number must be one the trunk lets you present.` : "The number must be one the trunk lets you present.";
    };
    trunk.addEventListener("change", syncTrunk);
    syncTrunk();
    const appBox = h("div", { class: "form-grid", "data-field": "service.provider" }, field("Provider", appProv, appInfo));
    const sipBox = h("div", { class: "form-grid" },
      h("div", { "data-field": "service.provider" }, field("Provider that dials the trunk", sipProv)),
      h("div", { "data-field": "service.trunk" }, field("SIP trunk", trunk, trunks.length ? null : h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { if (closeOpen) closeOpen(); go("trunks"); } }, "Add a trunk"))),
      h("div", { "data-field": "service.callerId.number" }, field("Caller ID number", cidNum, cidHint)),
      h("div", { "data-field": "service.callerId.name" }, field("Caller name", cidName, "Where the network carries one (SIP From display name, CNAM).")),
      field("Presentation", pres));
    const radios = h("div", { class: "tel-radios", role: "radiogroup", "aria-label": "Service" });
    const sync = () => { appBox.hidden = kind !== "app"; sipBox.hidden = kind !== "sip"; };
    for (const [k, label] of [["app", "The provider's application (API key and secret)"], ["sip", "A SIP trunk (own caller ID)"]]) {
      const r = h("input", { type: "radio", name, value: k, disabled: disabled || undefined, "data-testid": `tel-svc-${k}` });
      r.checked = kind === k;
      r.addEventListener("change", () => { if (r.checked) { kind = k; sync(); } });
      radios.append(h("label", { class: "tel-radio" }, r, h("span", {}, label)));
    }
    sync();
    const value = () => (kind === "app" ? { kind: "app", provider: appProv.value } : { kind: "sip", provider: sipProv.value, trunk: trunk.value, callerId: { number: cidNum.value.trim(), name: cidName.value.trim(), presentation: pres.value === "restricted" ? "restricted" : "allowed" } });
    return { el: h("div", { class: "stack" }, radios, appBox, sipBox), value };
  }

  /** The rule editor: match, service (outbound), target, record (inbound), note. */
  function openRuleEditor(dir, rule, isNew, ctx, onSave, onDelete) {
    const ro = !may("routing");
    const dis = ro || undefined;
    const d = structuredClone(rule);
    const dr = drawer(isNew ? `New ${dir} rule` : `${ro ? "" : "Edit "}${dir} rule`.replace(/^./, (c) => c.toUpperCase()), { subtitle: isNew ? "Saved into the list when you press Save" : d.id, wide: true, testid: "tel-rule-editor" });
    const label = input(d.label, { maxlength: "80", placeholder: dir === "inbound" ? "Support line — office hours" : "Czech numbers through the trunk", disabled: dis, "data-testid": "tel-rule-label" });
    const enabled = toggle("Rule on", d.enabled, { disabled: dis, "data-testid": "tel-rule-enabled" });
    const note = textarea(d.note, { rows: "2", maxlength: "500", disabled: dis, placeholder: "Why this rule exists (never runs)" });
    const m = d.match || {};
    const hours = hoursEditor(m.hours, ro);
    const target = targetPicker(d.target, { allowPass: dir === "outbound", tsaList: ctx.tsa, disabled: ro, testid: "tel-rule-target", label: "Target" });
    let numbers, from, provider, service, to, groups, sources, svc, record;
    const matchBox = h("div", { class: "stack" });
    if (dir === "inbound") {
      numbers = chips(m.numbers, { validate: patternProblem, placeholder: "+420212345678, +4202*, sip:*@pbx.example.com", label: "Numbers called", disabled: ro, testid: "tel-rule-numbers" });
      from = chips(m.from, { validate: patternProblem, placeholder: "+420*, -+4209*", label: "Callers", disabled: ro, testid: "tel-rule-from" });
      provider = select([{ value: "", label: "any provider" }, ...VOICE_PROVIDERS.map((id) => ({ value: id, label: plabel(id) }))], m.provider || "", { disabled: dis, "data-testid": "tel-rule-provider" });
      service = select([{ value: "", label: "any service" }, { value: "app", label: "the provider's application (a number on its webhook)" }, { value: "sip", label: "a SIP trunk" }], m.service || "", { disabled: dis, "data-testid": "tel-rule-service" });
      record = toggle("Record the whole call (the provider's recording, kept with the call)", d.record, { disabled: dis, "data-testid": "tel-rule-record" });
      matchBox.append(
        h("div", { "data-field": "match.numbers" }, field("Number called (DID) or SIP URI", numbers.el, "Empty = any. +420212345678 exactly · +4202* a prefix · * anything · sip:*@host a SIP URI · a leading - means NOT (denies win).")),
        h("div", { "data-field": "match.from" }, field("Caller", from.el, "Empty = anyone.")),
        h("div", { class: "form-grid" }, field("Provider", provider), field("Service", service)));
    } else {
      to = chips(m.to, { validate: patternProblem, placeholder: "+420*, +421*, -+4209*", label: "Destinations", disabled: ro, testid: "tel-rule-to" });
      groups = chips(m.groups, { validate: groupProblem, placeholder: "staff, mod-telephony", label: "Groups", suggest: ctx.groups, disabled: ro, testid: "tel-rule-groups" });
      sources = SOURCES.map((s) => { const t = toggle(SOURCE_LABEL[s], (m.sources || []).includes(s), { disabled: dis, "data-testid": `tel-rule-src-${s}` }); t.id = s; return t; });
      svc = serviceEditor(d.service, ctx, ro);
      matchBox.append(
        h("div", { "data-field": "match.to" }, field("Destination", to.el, "Empty = anywhere (within Permissions › countries; blocked numbers are never dialled). +420* a prefix · +420212345678 exactly · sip:*@host · a leading - means NOT.")),
        h("div", { "data-field": "match.groups" }, field("Caller's groups (Modules & groups)", groups.el, "Empty = anyone the permissions allow.")),
        h("fieldset", { class: "tel-fieldset" }, h("legend", {}, "What places the call (none ticked = any)"), h("div", { class: "tel-checks" }, ...sources.map((s) => s.el))));
    }
    const problemsEl = problemsBox([]);
    const sectionsEl = h("div", { class: "stack tel-editor" },
      problemsEl,
      h("div", { class: "form-grid" }, h("div", { "data-field": "label" }, field("Name", label)), h("div", { class: "tel-editor__on" }, enabled.el)),
      h("section", { class: "tel-section" }, h("h3", {}, "Match"), matchBox, h("div", {}, hours.el)),
      svc ? h("section", { class: "tel-section" }, h("h3", {}, "Service — how the call goes out"), svc.el) : null,
      h("section", { class: "tel-section", "data-field": "target" }, h("h3", {}, dir === "inbound" ? "Target — what the call runs" : "Target — what runs when it is answered"), target.el),
      record ? h("section", { class: "tel-section" }, h("h3", {}, "Recording"), record.el) : null,
      h("section", { class: "tel-section" }, h("h3", {}, "Note"), note));
    dr.body.append(sectionsEl);

    const collect = () => {
      const out = { ...d, label: label.value.trim(), enabled: enabled.box.checked, note: note.value.trim(), target: target.value() };
      if (dir === "inbound") out.match = { numbers: numbers.values(), from: from.values(), provider: provider.value, service: service.value, hours: hours.value() };
      else { out.match = { to: to.values(), groups: groups.values(), sources: sources.filter((s) => s.box.checked).map((s) => s.id), hours: hours.value() }; out.service = svc.value(); }
      if (dir === "inbound") out.record = record.box.checked;
      return out;
    };
    let current = problemsEl;
    /** Lists the problems on top and marks the fields they belong to. */
    const showProblems = (problems) => {
      const fresh = problemsBox(problems);
      fresh.setAttribute("data-testid", "tel-rule-problems");
      current.replaceWith(fresh);
      current = fresh;
      for (const el of sectionsEl.querySelectorAll("[data-field]")) {
        const f = el.getAttribute("data-field");
        el.classList.toggle("is-invalid", problems.some((p) => p.field && (p.field === f || p.field.startsWith(`${f}.`))));
      }
      if (problems.length && fresh.scrollIntoView) fresh.scrollIntoView({ block: "nearest" });
    };
    const save = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-rule-save", onclick: (e) => busy(e.currentTarget, async () => {
      const next = collect();
      const problems = ruleProblems(next, dir, ctx);
      showProblems(problems);
      if (problems.length) return;
      const r = await onSave(next);
      if (r && r.ok) dr.close();
      else if (r) showProblems([...(r.problems || []).map((p) => (typeof p === "string" ? { message: p } : p)), ...(r.problems && r.problems.length ? [] : [{ message: r.message }])]);
    }) }, ic("save"), isNew ? "Add the rule" : "Save the rule"), "routing");
    const del = isNew ? null : gate(h("button", { type: "button", class: "btn btn--danger", onclick: async () => { if (!confirm(`Delete the rule “${rule.label}”?`)) return; const r = await onDelete(); if (r && r.ok) dr.close(); } }, ic("trash-2"), "Delete"), "routing");
    put(dr.foot, del, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", "data-read": "1", onclick: () => dr.close() }, ro ? "Close" : "Cancel"), ro ? null : save);
    label.addEventListener("blur", () => label.classList.toggle("is-invalid", !label.value.trim()));
    return { collect, save, el: dr.el };
  }

  /** "Test a call": what the saved rules would do with it. */
  function dryRunCard(dir, ctx, onDecision, opts = {}) {
    const out = h("div", { class: "tel-testout", "aria-live": "polite", "data-testid": `tel-dryrun-out-${dir}` });
    const dirSel = opts.anyDirection ? select([{ value: "inbound", label: "Inbound" }, { value: "outbound", label: "Outbound" }], dir, { "data-read": "1", "data-testid": "tel-dryrun-dir" }) : null;
    const fromEl = input("", { placeholder: dir === "inbound" ? "+420777123456 (the caller)" : "+420212345678 (shown number, optional)", "data-read": "1", "data-testid": `tel-dryrun-from-${dir}` });
    const toEl = input("", { placeholder: dir === "inbound" ? "+420212345678 (the number called) or sip:…" : "+420777123456 (the destination)", "data-read": "1", "data-testid": `tel-dryrun-to-${dir}` });
    const prov = select([{ value: "", label: "any / the default" }, ...VOICE_PROVIDERS.map((id) => ({ value: id, label: plabel(id) }))], "", { "data-read": "1" });
    const svc = select([{ value: "", label: "any" }, { value: "app", label: "application" }, { value: "sip", label: "SIP trunk" }], "", { "data-read": "1" });
    const groupsEl = input("", { placeholder: "staff, sales (the caller's groups)", "data-read": "1" });
    const source = select([{ value: "", label: "any" }, ...SOURCES.map((s) => ({ value: s, label: s }))], "console", { "data-read": "1" });
    const at = input("", { type: "datetime-local", "data-read": "1", "aria-label": "At (default: now)" });
    const inboundOnly = h("div", { class: "form-grid" }, field("Service", svc));
    const outboundOnly = h("div", { class: "form-grid" }, field("Caller's groups", groupsEl), field("Placed by", source));
    const syncDir = () => { const d = dirSel ? dirSel.value : dir; inboundOnly.hidden = d !== "inbound"; outboundOnly.hidden = d !== "outbound"; };
    if (dirSel) dirSel.addEventListener("change", syncDir);
    syncDir();
    const path = opts.path || "/admin/telephony/rules/test";
    const run = (btn) => busy(btn, async () => {
      const d = dirSel ? dirSel.value : dir;
      const q = { direction: d, from: fromEl.value.trim(), to: toEl.value.trim() };
      if (!q.to) { toast("Enter the number called / the destination.", "err"); toEl.focus(); return; }
      if (prov.value) q.provider = prov.value;
      if (d === "inbound" && svc.value) q.service = svc.value;
      if (d === "outbound") { const g = groupsEl.value.split(/[,\s]+/).filter(Boolean); if (g.length) q.groups = g; if (source.value) q.source = source.value; }
      if (at.value) { const t = new Date(at.value).getTime(); if (Number.isFinite(t)) q.at = t; }
      clear(out).append(loading("Asking the rules…"));
      try {
        const r = await call(path, { method: "POST", body: q });
        const decision = r.decision || r;
        clear(out).append(decisionView(decision, ctx));
        if (onDecision) onDecision(decision);
      } catch (err) { clear(out).append(isMissing(err) ? failed(err, null, "The dry run") : h("div", { class: "tel-result" }, badge("failed", "err"), " ", err.message)); }
    });
    const btn = h("button", { type: "button", class: "btn btn--primary", "data-read": "1", "data-testid": `tel-dryrun-run-${dir}`, onclick: (e) => run(e.currentTarget) }, ic("play"), opts.button || "Test a call");
    for (const el of [fromEl, toEl]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(btn); } });
    return card(opts.title || "Test a call", opts.hint || "A dry run against the saved rules: nothing is dialled, nothing is charged.", null,
      h("div", { class: "form-grid" }, dirSel ? field("Direction", dirSel) : null, field(dir === "inbound" ? "Caller" : "From", fromEl), field(dir === "inbound" ? "Number called" : "Destination", toEl), field("Provider", prov), field("At (default: now)", at)),
      inboundOnly, outboundOnly,
      h("div", { class: "row" }, h("span", { class: "spacer" }), btn),
      out);
  }

  function decisionView(d, ctx = {}) {
    const reasons = d.reasons || [];
    return h("div", { class: "tel-decision", "data-testid": "tel-decision" },
      h("div", { class: "tel-decision__head" },
        d.rule ? badge("rule matched", "ok") : badge("no rule matched — the default", "warn"),
        h("strong", {}, d.ruleLabel || d.rule || "the module's default"),
        d.rule ? h("span", { class: "mono muted small" }, d.rule) : null),
      kv([["Direction", d.direction], ["Service", d.service ? serviceText(d.service, ctx) : "—"], ["Target", targetEl(d.target, ctx)]]),
      reasons.length ? h("div", {}, h("div", { class: "muted small" }, "Why"), h("ol", { class: "tel-reasons" }, ...reasons.map((r) => h("li", {}, r)))) : null,
      d.rendered && d.rendered.body ? h("div", { class: "tel-rendered" },
        h("div", { class: "row" }, h("span", { class: "muted small" }, `What the provider would be told (${d.rendered.contentType || "text"})`), h("span", { class: "spacer" }), copyBtn(d.rendered.body)),
        h("pre", { class: "code", "data-testid": "tel-rendered" }, d.rendered.body)) : null);
  }

  /* ===================================================== applications */

  let editorLoading = null;
  /** The visual editor (tsa-editor.js, window.M5TsaEditor): loaded on first use. */
  function ensureEditor() {
    const ready = () => (window.M5TsaEditor && typeof window.M5TsaEditor.open === "function" ? window.M5TsaEditor : null);
    if (ready()) return Promise.resolve(ready());
    if (!editorLoading) {
      editorLoading = new Promise((resolve) => {
        const existing = document.querySelector('script[src="tsa-editor.js"]');
        if (existing) { setTimeout(() => resolve(ready()), 400); return; }
        const s = document.createElement("script");
        s.src = "tsa-editor.js";
        s.async = true;
        s.onload = () => resolve(ready());
        s.onerror = () => { s.remove(); resolve(null); };
        document.head.append(s);
      }).then((ed) => { if (!ed) editorLoading = null; return ed; });
    }
    return editorLoading;
  }
  async function openEditor(id) {
    const ed = await ensureEditor();
    if (!ed) {
      const note = document.getElementById("telEditorMissing");
      if (note) note.hidden = false;
      toast("The application editor is not loaded (tsa-editor.js).", "err");
      return false;
    }
    try { ed.open(id, { onClose: () => { forget("tsa", "overview"); if (S.tab === "apps" && visible()) renderTab(); } }); return true; }
    catch (err) { toast(`The editor: ${err.message}`, "err"); return false; }
  }

  function download(name, text, type = "application/json") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h("a", { href: url, download: name, class: "tel-offscreen" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportTsa(t) {
    try {
      let text;
      if (C.raw) {
        const res = await C.raw(`/admin/telephony/tsa/${encodeURIComponent(t.id)}/export`, { headers: { Accept: "application/json" } });
        if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).message || m; } catch { /* not JSON */ } throw new Error(m); }
        text = await res.text();
      } else text = JSON.stringify(await call(`/admin/telephony/tsa/${encodeURIComponent(t.id)}/export`), null, 2);
      download(`${t.id}.tsa.json`, text);
      toast(`${t.name}: exported`, "ok");
    } catch (err) { toast(`Export: ${err.message}`, "err"); }
  }

  const problemText = (p) => (typeof p === "string" ? p : `${p.level === "warning" ? "warning: " : ""}${p.message || JSON.stringify(p)}${p.node ? ` (node ${p.node})` : ""}`);

  VIEWS.apps = async (gen) => {
    const [r, rules] = await Promise.all([need("tsa"), rulesOf()]);
    if (stale(gen)) return null;
    if (r.error) return failed(r.error, () => { forget("tsa"); renderTab(); }, "The applications");
    const list = listOf(r.data, "tsas", "tsa", "items", "apps", "list");
    const ruleById = new Map([...((rules && rules.inbound) || []).map((x) => [x.id, { ...x, dir: "inbound" }]), ...((rules && rules.outbound) || []).map((x) => [x.id, { ...x, dir: "outbound" }])]);
    const refresh = () => { forget("tsa", "overview"); renderTab(); };
    const act = async (btn, fn, ok) => busy(btn, async () => {
      try { const res = await fn(); if (ok) toast(typeof ok === "function" ? ok(res) : ok, "ok"); refresh(); }
      catch (err) { const pr = (err.data && err.data.problems) || []; toast(pr.length ? `${err.message}: ${pr.map(problemText).join("; ")}` : err.message, "err"); }
    });
    const file = h("input", { type: "file", accept: "application/json,.json", class: "tel-offscreen", "aria-hidden": "true", tabindex: "-1" });
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      file.value = "";
      if (!f) return;
      let body;
      try { body = JSON.parse(await f.text()); } catch { toast(`${f.name} is not JSON.`, "err"); return; }
      try {
        const res = await call("/admin/telephony/tsa/import", { method: "POST", body });
        const t = res.tsa || res;
        toast(`Imported ${t.name || t.id || f.name}${(res.problems || []).length ? ` — ${res.problems.length} warning(s)` : ""}`, "ok");
        refresh();
      } catch (err) { const pr = (err.data && err.data.problems) || []; toast(pr.length ? `${err.message}: ${pr.map(problemText).join("; ")}` : err.message, "err"); }
    });
    const search = input("", { type: "search", placeholder: "Filter by name, id, tag…", "data-read": "1", "aria-label": "Filter applications", class: "input tel-search" });
    const tbody = h("tbody");
    const draw = () => {
      clear(tbody);
      const q = search.value.trim().toLowerCase();
      const shown = list.filter((t) => !q || [t.id, t.name, t.description, ...(t.tags || [])].some((x) => String(x || "").toLowerCase().includes(q)));
      for (const t of shown) {
        const used = (t.usedBy || []).map((id) => ruleById.get(id) || { id, label: id, dir: "" });
        const btn = (icon, label, fn, extra = {}) => h("button", { type: "button", class: "btn btn--sm btn--ghost tel-ibtn", "aria-label": `${label} ${t.name}`, title: label, onclick: (e) => fn(e.currentTarget), ...extra }, ic(icon));
        const del = gate(btn("trash-2", "Delete", (b) => { if (!confirm(`Delete the application “${t.name}”? It cannot be undone.`)) return; void act(b, () => call(`/admin/telephony/tsa/${encodeURIComponent(t.id)}`, { method: "DELETE" }), `${t.name} deleted`); }, { class: "btn btn--sm btn--ghost tel-ibtn tel-ibtn--danger", "data-testid": `tel-tsa-del-${t.id}` }), "tsa");
        if (used.length) { del.disabled = true; del.title = `Used by ${used.map((u) => u.label).join(", ")} — change those rules first.`; }
        tbody.append(h("tr", { "data-tsa": t.id },
          h("td", {}, h("button", { type: "button", class: "tel-link", "data-read": "1", onclick: () => void openEditor(t.id) }, t.name || t.id), h("div", { class: "mono muted small" }, t.id), t.description ? h("div", { class: "small muted tel-clip" }, t.description) : null, (t.tags || []).length ? h("div", { class: "tel-badges" }, ...t.tags.map((x) => badge(x))) : null),
          h("td", {}, t.published ? badge(`published v${t.publishedVersion || t.version}`, "ok") : badge("draft only", "warn")),
          h("td", { class: "small" }, used.length ? h("div", { class: "tel-badges" }, ...used.map((u) => h("button", { type: "button", class: "tel-chiplink", "data-read": "1", onclick: () => go(u.dir || "inbound", u.id) }, `${u.dir === "outbound" ? "↑" : "↓"} ${u.label}`))) : h("span", { class: "muted" }, "no rule")),
          h("td", { class: "num" }, t.nodes === undefined ? "—" : String(t.nodes)),
          h("td", { class: "small" }, when(t.updatedAt), t.updatedBy ? h("div", { class: "muted" }, t.updatedBy) : null),
          h("td", {}, h("div", { class: "tel-rowactions" },
            h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "data-testid": `tel-tsa-open-${t.id}`, onclick: () => void openEditor(t.id) }, ic("workflow"), "Open"),
            gate(btn("upload", "Publish", (b) => act(b, () => call(`/admin/telephony/tsa/${encodeURIComponent(t.id)}/publish`, { method: "POST", body: {} }), (res) => `${t.name} published${res && (res.version || (res.tsa && res.tsa.version)) ? ` — v${res.version || res.tsa.version}` : ""}`), { "data-testid": `tel-tsa-publish-${t.id}` }), "tsa"),
            gate(btn("copy", "Duplicate", (b) => act(b, () => call(`/admin/telephony/tsa/${encodeURIComponent(t.id)}/duplicate`, { method: "POST", body: {} }), `${t.name} duplicated`)), "tsa"),
            btn("download", "Export", () => void exportTsa(t), { "data-read": "1" }),
            del))));
      }
      if (!shown.length) tbody.append(h("tr", {}, h("td", { colspan: "6" }, empty(list.length ? "Nothing matches the filter." : "No application yet. Start from a template — an IVR menu, a route code, voicemail or opening hours."))));
    };
    search.addEventListener("input", draw);
    draw();
    const add = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-tsa-new", onclick: () => newTsaDrawer(list) }, ic("plus"), "New application"), "tsa");
    const imp = gate(h("button", { type: "button", class: "btn", onclick: () => file.click() }, ic("upload"), "Import"), "tsa");
    const published = list.filter((t) => t.published).length;
    const editorNote = h("div", { id: "telEditorMissing", class: "tel-note tel-note--warn", hidden: true, "data-testid": "tel-editor-missing" }, ic("circle-alert"), "The editor is not loaded (tsa-editor.js): the list, publishing, export and import work without it; opening a flow needs it.");
    void ensureEditor().then((ed) => { if (!ed) editorNote.hidden = false; });
    return h("div", { class: "stack", "data-testid": "tel-apps" },
      editorNote,
      card("Telephony & SIP Applications (TSA)", `Call flows drawn in the visual editor: what the caller hears, what they type or say, where the call goes. Rules run the published version. ${list.length} application${list.length === 1 ? "" : "s"} · ${published} published.`,
        [search, imp, add, file],
        h("div", { class: "table-wrap" }, h("table", { class: "t tel-tsatable", "data-testid": "tel-tsa-table" },
          h("thead", {}, h("tr", {}, ...["Application", "Status", "Used by", "Nodes", "Updated", ""].map((x) => h("th", {}, x)))), tbody))),
      card("Templates", "A new application can start from one of these and be changed in the editor.", null,
        h("div", { class: "tel-templates" }, ...TEMPLATES.filter((t) => t.id).map((t) => h("div", { class: "tel-template" }, h("strong", {}, t.label), h("div", { class: "muted small" }, t.help))))));
  };

  function newTsaDrawer(list) {
    const dr = drawer("New application", { subtitle: "A call flow for the rules to run", testid: "tel-tsa-new-drawer" });
    const name = input("", { maxlength: "80", placeholder: "Support line", "data-testid": "tel-tsa-name" });
    const id = input("", { maxlength: "48", placeholder: "support-line (from the name)", class: "input mono", "data-testid": "tel-tsa-id" });
    const desc = textarea("", { rows: "2", maxlength: "500", placeholder: "What it does" });
    const slug = () => name.value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    name.addEventListener("input", () => { id.placeholder = slug() || "support-line"; });
    const group = `tel-tpl-${Math.random().toString(36).slice(2, 8)}`;
    let template = "";
    const tpls = h("div", { class: "tel-templates", role: "radiogroup", "aria-label": "Start from" }, ...TEMPLATES.map((t) => {
      const r = h("input", { type: "radio", name: group, value: t.id, "data-testid": `tel-tsa-tpl-${t.id || "blank"}` });
      r.checked = t.id === template;
      r.addEventListener("change", () => { if (r.checked) template = t.id; });
      return h("label", { class: "tel-template tel-template--pick" }, r, h("div", {}, h("strong", {}, t.label), h("div", { class: "muted small" }, t.help)));
    }));
    const problemsEl = h("div");
    const create = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-tsa-create", onclick: (e) => busy(e.currentTarget, async () => {
      const problems = [];
      const wantId = id.value.trim() || slug();
      if (!name.value.trim()) problems.push("Give it a name.");
      if (wantId && !TSA_ID.test(wantId)) problems.push("The id: lower-case letters, digits and -, 2–48 characters, starting with a letter or digit.");
      if (wantId && list.some((t) => t.id === wantId)) problems.push(`The id “${wantId}” is taken.`);
      clear(problemsEl).append(problemsBox(problems));
      if (problems.length) return;
      try {
        const res = await call("/admin/telephony/tsa", { method: "POST", body: { ...(wantId ? { id: wantId } : {}), name: name.value.trim(), description: desc.value.trim(), ...(template ? { template } : {}) } });
        const t = res.tsa || res;
        toast(`${t.name || name.value.trim()} created`, "ok");
        dr.close();
        forget("tsa", "overview");
        renderTab();
        if (t.id) void openEditor(t.id);
      } catch (err) { clear(problemsEl).append(problemsBox((err.data && err.data.problems) ? err.data.problems.map(problemText) : [err.message])); }
    }) }, ic("plus"), "Create"), "tsa");
    dr.body.append(problemsEl, field("Name", name), field("Id", id, "Used in rules and exports; cannot change later."), field("Description", desc), h("fieldset", { class: "tel-fieldset" }, h("legend", {}, "Start from"), tpls));
    dr.foot.append(h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", "data-read": "1", onclick: () => dr.close() }, "Cancel"), create);
  }

  /* ========================================================= route codes */

  VIEWS.codes = async (gen) => {
    const [r, perms] = await Promise.all([need("inroute"), need("perms")]);
    if (stale(gen)) return null;
    const p = withDefaults(perms.data ? perms.data.permissions : null);
    const listBox = h("div");
    const refresh = () => { forget("inroute", "overview"); renderTab(); };
    if (r.error) listBox.append(failed(r.error, refresh, "The route codes"));
    else {
      const entries = listOf(r.data, "entries", "codes", "inroute", "items").slice().sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
      const tbody = h("tbody");
      const now = Date.now();
      for (const e of entries) {
        const left = ((e.expiresAt || 0) - now) / 1000;
        const by = e.createdBy || {};
        tbody.append(h("tr", { "data-code": e.code, class: left <= 0 ? "is-dim" : "" },
          h("td", {}, h("span", { class: "tel-code mono" }, e.code), " ", copyBtn(e.code, "", `Code ${e.code} copied`)),
          h("td", {}, badge(e.type === "user" ? "member" : "room", e.type === "user" ? "violet" : "info")),
          h("td", { class: "mono small tel-clip", title: e.room }, e.room),
          h("td", { class: "small" }, e.type === "user" ? e.user || "—" : "—"),
          h("td", { class: "small" }, e.label || "—"),
          h("td", { class: "small" }, `${by.kind || "?"}${by.id ? `: ${by.id}` : ""}`, by.run ? h("div", { class: "mono muted" }, by.run) : null),
          h("td", { class: "mono" }, h("span", { class: "tel-countdown", "data-tel-expires": String(e.expiresAt || 0), title: whenSec(e.expiresAt) }, left > 0 ? span(left) : "expired")),
          h("td", { class: "num" }, `${e.uses || 0} / ${e.maxUses ? e.maxUses : "∞"}`),
          h("td", {}, gate(h("button", { type: "button", class: "btn btn--sm btn--ghost tel-ibtn tel-ibtn--danger", "aria-label": `Delete the code ${e.code}`, title: "Delete", "data-testid": `tel-code-del-${e.code}`, onclick: (ev) => busy(ev.currentTarget, async () => {
            if (!confirm(`Delete the route code ${e.code}? A caller can no longer use it.`)) return;
            try { await call(`/admin/telephony/inroute/${encodeURIComponent(e.code)}`, { method: "DELETE" }); toast(`Code ${e.code} deleted`, "ok"); refresh(); } catch (err) { toast(err.message, "err"); }
          }) }, ic("trash-2")), "settings"))));
      }
      listBox.append(entries.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "t", "data-testid": "tel-codes" }, h("thead", {}, h("tr", {}, ...["Code", "To", "Room (blind id)", "Member", "Label", "Made by", "Expires in", "Uses", ""].map((x) => h("th", {}, x)))), tbody))
        : empty("No live route code."));
    }
    return h("div", { class: "stack", "data-testid": "tel-codes-view" },
      h("div", { class: "tel-split" },
        card("Live route codes", "A caller who dials an inbound number whose rule runs an application with Route audio, and types one of these codes, is connected both ways: to the whole room or to one member. Codes expire on their own.", h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: refresh }, ic("refresh-cw"), "Refresh"), listBox),
        addCodeCard(p, refresh)),
      card("How codes are made: m5.telephony.inroute.add", "Functions (and an application's Add route code tool) create codes for the room they run in; the console adds them for tests.", null,
        h("pre", { class: "code" }, [
          "// a Functions model, e.g. on “/phone”",
          "const r = await m5.telephony.inroute.add({",
          "  type: \"room\",            // or \"user\" with user: \"@alice\" / a member's name",
          "  room: ctx.room.blindId,  // the room's blind id (r3.…), never its name",
          "  ttl: 600,                // seconds; at most Permissions › Route codes",
          "  label: \"Support\",",
          "  maxUses: 1,              // 0 = until it expires",
          "});",
          "m5.out.text(`Call ${r.number} and type ${r.code} #`);",
        ].join("\n")),
        h("ol", { class: "small tel-steps" },
          h("li", {}, "An inbound rule sends the number to an application with Route audio (the Route code template)."),
          h("li", {}, "The caller types the code; wrong codes count against Permissions › Route codes."),
          h("li", {}, "The caller's audio goes to the room (every member connected with audio) or to the member, and theirs back."))));
  };

  function addCodeCard(p, refresh) {
    const name = `tel-ir-${Math.random().toString(36).slice(2, 8)}`;
    let type = "room";
    const radios = h("div", { class: "tel-radios", role: "radiogroup", "aria-label": "Route to" }, ...[["room", "The whole room"], ["user", "One member"]].map(([k, label]) => {
      const r = h("input", { type: "radio", name, value: k, "data-testid": `tel-code-type-${k}` });
      r.checked = k === type;
      r.addEventListener("change", () => { if (r.checked) { type = k; userBox.hidden = type !== "user"; } });
      return h("label", { class: "tel-radio" }, r, h("span", {}, label));
    }));
    const room = input("", { placeholder: "r3.…", class: "input mono", "data-testid": "tel-code-room" });
    const user = input("", { placeholder: "@alice or the member's name", "data-testid": "tel-code-user" });
    const userBox = field("Member", user);
    userBox.hidden = true;
    const code = input("", { placeholder: "random", maxlength: "6", inputmode: "numeric", class: "input mono", "data-testid": "tel-code-code" });
    const ttl = numberInput(INROUTE_DEFAULT_TTL, 60, p.inroute.maxTtlSec, { "data-testid": "tel-code-ttl" });
    const label = input("", { maxlength: "60", placeholder: "Test" });
    const maxUses = numberInput(0, 0, 1000);
    const out = h("div", { "aria-live": "polite" });
    const add = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-code-add", onclick: (e) => busy(e.currentTarget, async () => {
      const problems = [];
      if (!room.value.trim()) problems.push("The room's blind id.");
      if (type === "user" && !user.value.trim()) problems.push("The member.");
      if (code.value.trim() && !INROUTE_CODE.test(code.value.trim())) problems.push("A code is 4–6 digits (or empty for a random one).");
      clear(out).append(problemsBox(problems));
      if (problems.length) return;
      const body = { type, room: room.value.trim(), ttl: numberOf(ttl, 60, p.inroute.maxTtlSec), ...(type === "user" ? { user: user.value.trim() } : {}), ...(code.value.trim() ? { code: code.value.trim() } : {}), ...(label.value.trim() ? { label: label.value.trim() } : {}), ...(numberOf(maxUses, 0, 1000) ? { maxUses: numberOf(maxUses, 0, 1000) } : {}) };
      try {
        const res = await call("/admin/telephony/inroute", { method: "POST", body });
        const entry = res.entry || res;
        clear(out).append(h("div", { class: "tel-result" }, badge("added", "ok"), " Code ", h("strong", { class: "tel-code mono" }, entry.code || "?"), entry.expiresAt ? ` — valid until ${whenSec(entry.expiresAt)}` : ""));
        toast(`Code ${entry.code || ""} added`, "ok");
        setTimeout(refresh, 900);
      } catch (err) { clear(out).append(problemsBox((err.data && err.data.problems) || [err.message])); }
    }) }, ic("plus"), "Add the code"), "settings");
    return card("Add a code (tests)", "For trying a route-code application; functions make their own.", null,
      radios, h("div", { class: "form-grid" }, field("Room (blind id)", room), userBox, field("Code", code, "4–6 digits; empty = random."), field("Valid for (seconds)", ttl, `At most ${p.inroute.maxTtlSec} s (Permissions).`), field("Label", label), field("Max uses", maxUses, "0 = until it expires.")),
      h("div", { class: "row" }, h("span", { class: "spacer" }), add), out);
  }

  /* ============================================================ trunks */

  const didProblem = (d) => (/^\+?\d{3,20}$/.test(String(d || "")) ? null : "a number: +420212345678");

  VIEWS.trunks = async (gen) => {
    const [r, rules, snap] = await Promise.all([need("trunks"), rulesOf(), need("snap")]);
    if (stale(gen)) return null;
    let trunks;
    let meta = {};
    if (r.data) { trunks = listOf(r.data, "trunks"); meta = r.data; }
    else if (snap.data) { trunks = listOf(snap.data.sip); meta = { persistent: snap.data.persistence ? snap.data.persistence.writable : undefined }; }
    else return failed(r.error, () => { forget("trunks"); renderTab(); }, "The SIP trunks");
    const refresh = () => { forget("trunks", "snap", "overview"); renderTab(); };
    const usedBy = (id) => ((rules && rules.outbound) || []).filter((x) => x.service && x.service.kind === "sip" && x.service.trunk === id);
    const envErrors = (snap.data && snap.data.envTrunks && snap.data.envTrunks.errors) || [];
    const tbody = h("tbody");
    for (const t of trunks) {
      const used = usedBy(t.id);
      const env = t.source === "env";
      tbody.append(h("tr", { "data-trunk": t.id },
        h("td", {}, h("strong", {}, t.label || t.id), h("div", { class: "mono muted small" }, t.id)),
        h("td", { class: "mono small" }, `${t.host}:${t.port || 5060}`),
        h("td", { class: "small" }, t.username || "—", t.authUser && t.authUser !== t.username ? h("div", { class: "muted" }, `auth ${t.authUser}`) : null, h("div", { class: "tel-badges" }, t.hasPassword ? badge("password set", "ok") : badge("no password"), t.register ? badge("registers", "info") : null)),
        h("td", { class: "small" }, (t.didNumbers || []).length ? h("div", { class: "tel-badges" }, ...(t.didNumbers || []).slice(0, 6).map((d) => badge(d)), (t.didNumbers || []).length > 6 ? badge(`+${t.didNumbers.length - 6}`) : null) : h("span", { class: "muted" }, "—")),
        h("td", { class: "small" }, t.callerIdNumber || "—", t.callerIdName ? h("div", { class: "muted" }, `“${t.callerIdName}”`) : null),
        h("td", { class: "small" }, used.length ? h("div", { class: "tel-badges" }, ...used.map((u) => h("button", { type: "button", class: "tel-chiplink", "data-read": "1", onclick: () => go("outbound", u.id) }, `↑ ${u.label}`))) : h("span", { class: "muted" }, "no rule")),
        h("td", {}, env ? badge(".env (read only)", "info") : badge("console", "")),
        h("td", {}, h("div", { class: "tel-rowactions" },
          h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => trunkDrawer(t, trunks, refresh) }, env || !may("settings") ? "View" : "Edit"),
          env ? null : gate(h("button", { type: "button", class: "btn btn--sm btn--ghost tel-ibtn tel-ibtn--danger", "aria-label": `Delete ${t.label || t.id}`, title: used.length ? `Used by ${used.map((u) => u.label).join(", ")}` : "Delete", "data-testid": `tel-trunk-del-${t.id}`, onclick: (e) => busy(e.currentTarget, async () => {
            if (!confirm(`Delete the trunk “${t.label || t.id}”?${used.length ? ` The rules ${used.map((u) => u.label).join(", ")} use it.` : ""}`)) return;
            try { await call(`/admin/telephony/sip/trunks?id=${encodeURIComponent(t.id)}`, { method: "DELETE", body: { id: t.id } }); toast("Trunk deleted", "ok"); refresh(); } catch (err) { toast(err.message, "err"); }
          }) }, ic("trash-2")), "settings")))));
    }
    const add = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-trunk-add", onclick: () => trunkDrawer(null, trunks, refresh) }, ic("plus"), "Add a trunk"), "settings");
    return h("div", { class: "stack", "data-testid": "tel-trunks" },
      card("SIP trunks", "The operator's trunks: where outbound rules with the SIP-trunk service dial, with their caller ID; inbound DIDs that arrive through them. Passwords are stored and never shown again.", add,
        trunks.length ? h("div", { class: "table-wrap" }, h("table", { class: "t", "data-testid": "tel-trunk-table" }, h("thead", {}, h("tr", {}, ...["Trunk", "Host", "Authentication", "DIDs", "Caller ID", "Used by", "Source", ""].map((x) => h("th", {}, x)))), tbody)) : empty("No trunk yet. Add the operator's trunk to dial out through it with its own caller ID."),
        meta.persistent === false ? h("div", { class: "tel-note tel-note--warn" }, ic("circle-alert"), `Kept in memory only${meta.lastSaveError ? ` — ${meta.lastSaveError}` : ""}.`) : null,
        envErrors.length ? h("div", { class: "tel-note tel-note--err" }, ic("circle-x"), `SIP_TRUNKS in .env: ${envErrors.join("; ")}`) : null),
      didCheckCard());
  };

  function trunkDrawer(t, trunks, refresh) {
    const isNew = !t;
    const ro = !may("settings") || (t && t.source === "env");
    const dis = ro || undefined;
    const dr = drawer(isNew ? "New SIP trunk" : t.label || t.id, { subtitle: isNew ? "" : `${t.id}${t.source === "env" ? " · from SIP_TRUNKS in .env (read only)" : ""}`, testid: "tel-trunk-drawer" });
    const v = t || { id: "", label: "", host: "", port: 5060, username: "", authUser: "", register: false, didNumbers: [], callerIdName: "", callerIdNumber: "", hasPassword: false };
    const id = input(v.id, { class: "input mono", placeholder: "prague1 (optional)", disabled: isNew ? undefined : true, maxlength: "64", "data-testid": "tel-trunk-id" });
    const label = input(v.label, { maxlength: "80", placeholder: "Prague office", disabled: dis, "data-testid": "tel-trunk-label" });
    const host = input(v.host, { class: "input mono", placeholder: "sip.example.net", disabled: dis, "data-testid": "tel-trunk-host" });
    const port = numberInput(v.port || 5060, 1, 65535, { disabled: dis });
    const user = input(v.username, { autocomplete: "off", disabled: dis });
    const auth = input(v.authUser, { autocomplete: "off", placeholder: "= username", disabled: dis });
    const pass = input("", { type: "password", autocomplete: "new-password", placeholder: v.hasPassword ? "set — type to replace" : "", disabled: dis });
    const reg = toggle("Register with the trunk (REGISTER)", v.register, { disabled: dis });
    const dids = chips(v.didNumbers, { validate: didProblem, placeholder: "+420212345678", label: "DIDs", disabled: ro, testid: "tel-trunk-dids" });
    const cidName = input(v.callerIdName, { maxlength: "40", disabled: dis });
    const cidNum = input(v.callerIdNumber, { placeholder: "+420212345678", disabled: dis });
    const out = h("div");
    dr.body.append(out,
      h("div", { class: "form-grid" }, field("Id", id, isNew ? "a-z 0-9 _ -; empty = generated" : null), field("Label", label), field("Host", host), field("Port", port), field("Username", user), field("Auth user", auth), field("Password", pass, "Stored on the server, never shown again."), h("div", {}, reg.el)),
      field("DIDs (numbers that arrive through this trunk)", dids.el),
      h("div", { class: "form-grid" }, field("Default caller ID number", cidNum, "Outbound rules may set their own."), field("Default caller name", cidName)));
    const save = ro ? null : gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-trunk-save", onclick: (e) => busy(e.currentTarget, async () => {
      const problems = [];
      if (!label.value.trim()) problems.push("A label.");
      if (!host.value.trim()) problems.push("The host.");
      if (isNew && id.value.trim() && !TRUNK_ID.test(id.value.trim())) problems.push("The id: a-z, 0-9, _ and -.");
      if (isNew && id.value.trim() && trunks.some((x) => x.id === id.value.trim())) problems.push("That id is taken.");
      for (const [d, p] of dids.problems()) problems.push(`DID ${d}: ${p}`);
      if (cidNum.value.trim() && e164Problem(cidNum.value)) problems.push(`Caller ID: ${e164Problem(cidNum.value)}`);
      clear(out).append(problemsBox(problems));
      if (problems.length) return;
      const body = { label: label.value.trim(), host: host.value.trim(), port: numberOf(port, 1, 65535), username: user.value.trim(), authUser: auth.value.trim(), register: reg.box.checked, didNumbers: dids.values(), callerIdName: cidName.value.trim(), callerIdNumber: cidNum.value.trim() };
      if (isNew ? id.value.trim() : true) body.id = isNew ? id.value.trim() : t.id;
      if (pass.value) body.password = pass.value;
      try {
        const res = await call("/admin/telephony/sip/trunks", { method: "PUT", body });
        toast(res.warning ? `Saved — ${res.warning}` : "Trunk saved", res.warning ? "err" : "ok");
        dr.close();
        refresh();
      } catch (err) { clear(out).append(problemsBox([err.message])); }
    }) }, ic("save"), "Save the trunk"), "settings");
    put(dr.foot, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", "data-read": "1", onclick: () => dr.close() }, ro ? "Close" : "Cancel"), save);
  }

  function didCheckCard() {
    const did = input("", { placeholder: "+420212345678", class: "input mono", "data-read": "1", "data-testid": "tel-did-input", "aria-label": "DID" });
    const out = h("div", { "aria-live": "polite", "data-testid": "tel-did-out" });
    const run = (btn) => busy(btn, async () => {
      const v = did.value.trim();
      if (!v) { did.focus(); return; }
      clear(out).append(loading());
      const [trunk, rule] = await Promise.all([
        call("/admin/telephony/sip/route", { method: "POST", body: { did: v } }).then((x) => ({ x }), (e) => ({ e })),
        call("/admin/telephony/rules/test", { method: "POST", body: { direction: "inbound", from: "", to: v, service: "sip" } }).then((x) => ({ x }), (e) => ({ e })),
      ]);
      clear(out);
      if (trunk.e) out.append(h("div", { class: "tel-result" }, badge("trunk check failed", "err"), " ", trunk.e.message));
      else {
        const d = trunk.x.decision;
        out.append(h("div", { class: "tel-result" }, trunk.x.routed && d ? [badge("arrives through", "ok"), " ", h("strong", {}, d.label || d.trunkId), " ", h("span", { class: "mono muted small" }, `${d.trunkId} · ${d.source}`)] : [badge("no trunk has this DID", "warn")]));
      }
      if (rule.x) out.append(h("div", { class: "muted small" }, "What runs (inbound rules, via a SIP trunk):"), decisionView(rule.x.decision || rule.x, {}));
    });
    const btn = h("button", { type: "button", class: "btn", "data-read": "1", "data-testid": "tel-did-check", onclick: (e) => run(e.currentTarget) }, ic("search"), "Check");
    did.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(btn); } });
    return card("DID → trunk", "Which trunk an inbound number arrives through, and which inbound rule would take the call.", null, h("div", { class: "row" }, did, btn), out);
  }

  /* ================================================================ tests */

  function providerOptions(snap, sdk, { any, voiceOnly } = {}) {
    const ids = new Set(VOICE_PROVIDERS);
    if (!voiceOnly) for (const p of (sdk && listOf(sdk.providers)) || []) ids.add(p.id);
    const conf = new Set([...((snap && snap.sms) || []), ...((snap && snap.voice) || [])].filter((c) => c.configured).map((c) => c.id));
    return [...(any ? [{ value: "", label: any }] : []), ...[...ids].map((id) => ({ value: id, label: `${plabel(id)}${conf.size && VOICE_PROVIDERS.includes(id) && !conf.has(id) ? " — not configured" : ""}` }))];
  }

  VIEWS.tests = async (gen) => {
    const [snapR, sdkR, ctx] = await Promise.all([need("snap"), need("sdk"), routingCtx()]);
    if (stale(gen)) return null;
    const snap = snapR.data || {};
    const sdk = sdkR.data || null;
    const firstConfigured = ([...(snap.voice || []), ...(snap.sms || [])].find((c) => c.configured) || {}).id || "twilio";

    // Provider test and webhook self-test.
    const provSel = select(providerOptions(snap, sdk), firstConfigured, { "data-read": "1", "aria-label": "Provider", "data-testid": "tel-test-provider" });
    const provOut = h("div", { class: "tel-testout", "aria-live": "polite" });
    const provRun = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-test-provider-run", onclick: (e) => busy(e.currentTarget, () => runTest(provOut, "/admin/telephony/tests/provider", { provider: provSel.value }, `Provider test: ${plabel(provSel.value)}`)) }, ic("play"), "Run the test"), "test");
    const whSel = select(providerOptions(snap, sdk, { voiceOnly: true }), VOICE_PROVIDERS.includes(firstConfigured) ? firstConfigured : "twilio", { "data-read": "1", "aria-label": "Provider" });
    const whOut = h("div", { class: "tel-testout", "aria-live": "polite" });
    const whRun = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-test-webhook-run", onclick: (e) => busy(e.currentTarget, () => runTest(whOut, "/admin/telephony/tests/webhook", { provider: whSel.value }, `Webhook self-test: ${plabel(whSel.value)}`)) }, ic("webhook"), "Send a signed test event"), "test");

    return h("div", { class: "stack", "data-testid": "tel-tests" },
      h("div", { class: "grid grid--2" },
        card("Provider", "Credentials present, the API answers (an account / balance read), the numbers owned, the webhook URLs installed. Free.", null, h("div", { class: "row" }, provSel, h("span", { class: "spacer" }), provRun), provOut),
        card("Webhook self-test", "A signed synthetic event delivered to the main service's /wh/… — proves PUBLIC_BASE_URL, the proxy and the signature check. Free.", null, h("div", { class: "row" }, whSel, h("span", { class: "spacer" }), whRun), whOut)),
      h("div", { class: "grid grid--2" },
        dryRunCard("inbound", ctx, null, { anyDirection: true, path: "/admin/telephony/tests/route", title: "Route dry run", hint: "Which rule takes the call, why, and what the provider would be told (TwiML / NCCO / commands). Nothing is dialled.", button: "Run" }),
        testCallCard(snap, sdk, ctx)),
      h("div", { class: "grid grid--2" }, testSmsCard(snap, sdk), roomVoiceCard()),
      await sipAddressCard());
  };

  function testCallCard(snap, sdk, ctx) {
    const to = input("", { placeholder: "+420777123456", class: "input mono", "data-read": "1", "data-testid": "tel-call-to", "aria-label": "Number to call" });
    const prov = select(providerOptions(snap, sdk, { any: "the outbound rules decide", voiceOnly: true }), "", { "data-read": "1", "aria-label": "Provider" });
    const name = `tel-call-${Math.random().toString(36).slice(2, 8)}`;
    let what = "say";
    const published = (ctx.tsa || []).filter((t) => t.published);
    const tsaSel = select([{ value: "", label: published.length ? "— choose —" : "— no published application —" }, ...published.map((t) => ({ value: t.id, label: t.name }))], "", { "data-read": "1", "aria-label": "Application" });
    const say = textarea("This is a test call from M5cet. Goodbye.", { rows: "2", maxlength: "500", "data-read": "1", "aria-label": "Text to say" });
    const tsaBox = h("div", {}, tsaSel);
    const sayBox = h("div", {}, say);
    const radios = h("div", { class: "tel-radios", role: "radiogroup", "aria-label": "When answered" }, ...[["say", "Say a text"], ["tsa", "Run an application"]].map(([k, label]) => {
      const r = h("input", { type: "radio", name, value: k, "data-read": "1" });
      r.checked = k === what;
      r.addEventListener("change", () => { if (r.checked) { what = k; tsaBox.hidden = what !== "tsa"; sayBox.hidden = what !== "say"; } });
      return h("label", { class: "tel-radio" }, r, h("span", {}, label));
    }));
    tsaBox.hidden = true;
    const out = h("div", { class: "tel-testout", "aria-live": "polite" });
    const run = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-call-run", onclick: (e) => busy(e.currentTarget, async () => {
      const n = to.value.trim();
      if (e164Problem(n)) { toast(`The number: ${e164Problem(n)}`, "err"); to.focus(); return; }
      if (what === "tsa" && !tsaSel.value) { toast("Choose the application.", "err"); return; }
      if (!confirm(`Call ${n}? This is a real call, charged by the provider.`)) return;
      const body = { to: n, ...(prov.value ? { provider: prov.value } : {}), ...(what === "tsa" ? { tsa: tsaSel.value } : { say: say.value.trim() || "Test." }) };
      const r = await runTest(out, "/admin/telephony/tests/call", body, `Test call to ${n}`);
      const callId = r && (r.callId || (r.call && r.call.id));
      if (callId) out.append(h("div", { class: "row" }, h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { S.log.filters = { ...S.log.filters, callId }; go("log"); } }, ic("list"), "Its events in the log"), h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => go("calls", callId) }, ic("activity"), "The call")));
      else if (r) out.append(h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { S.log.filters = { ...S.log.filters, kind: "" }; go("log"); } }, ic("list"), "Follow it in the log"));
    }) }, ic("send"), "Place the test call"), "test");
    return card("Test call", "A real outbound call through the outbound rules; its events appear in the log.", badge("billable", "warn"),
      h("div", { class: "form-grid" }, field("Number", to), field("Provider", prov)), radios, tsaBox, sayBox,
      h("div", { class: "row" }, h("span", { class: "spacer" }), run), out);
  }

  function testSmsCard(snap, sdk) {
    const to = input("", { placeholder: "+420777123456", class: "input mono", "data-read": "1", "aria-label": "Number", "data-testid": "tel-sms-to" });
    const prov = select(providerOptions(snap, sdk, { any: "the default SMS provider", voiceOnly: true }), "", { "data-read": "1", "aria-label": "Provider" });
    const text = textarea("Test from the M5cet console.", { rows: "2", maxlength: "480", "data-read": "1", "aria-label": "Text" });
    const count = h("span", { class: "muted small" });
    const sync = () => { const n = text.value.length; count.textContent = `${n} characters · ${n <= 160 ? 1 : Math.ceil(n / 153)} part${n <= 160 ? "" : "s"} (GSM-7)`; };
    text.addEventListener("input", sync);
    sync();
    const out = h("div", { class: "tel-testout", "aria-live": "polite" });
    const run = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-sms-run", onclick: (e) => busy(e.currentTarget, async () => {
      const n = to.value.trim();
      if (e164Problem(n)) { toast(`The number: ${e164Problem(n)}`, "err"); to.focus(); return; }
      if (!text.value.trim()) { toast("Write the text.", "err"); return; }
      await runTest(out, "/admin/telephony/tests/sms", { to: n, text: text.value, ...(prov.value ? { provider: prov.value } : {}) }, `Test SMS to ${n}`);
    }) }, ic("send"), "Send the test SMS"), "test");
    return card("Test SMS", "A real SMS through the provider.", badge("billable", "warn"),
      h("div", { class: "form-grid" }, field("Number", to), field("Provider", prov)), field("Text", text, count),
      h("div", { class: "row" }, h("span", { class: "spacer" }), run), out);
  }

  function roomVoiceCard() {
    const room = input("", { placeholder: "r3.…", class: "input mono", "data-read": "1", "data-testid": "tel-rv-room", "aria-label": "Room blind id" });
    const type = select([{ value: "room", label: "The whole room" }, { value: "user", label: "One member" }], "room", { "data-read": "1", "aria-label": "To" });
    const user = input("", { placeholder: "@alice or the member's name", "data-read": "1", "aria-label": "Member" });
    const userBox = field("Member", user);
    userBox.hidden = true;
    type.addEventListener("change", () => { userBox.hidden = type.value !== "user"; });
    const ttl = numberInput(600, 60, 86400, { "data-read": "1" });
    const out = h("div", { class: "tel-testout", "aria-live": "polite", "data-testid": "tel-rv-out" });
    const run = gate(h("button", { type: "button", class: "btn btn--primary", "data-testid": "tel-rv-run", onclick: (e) => busy(e.currentTarget, async () => {
      if (!room.value.trim()) { toast("The room's blind id.", "err"); room.focus(); return; }
      if (type.value === "user" && !user.value.trim()) { toast("The member.", "err"); user.focus(); return; }
      clear(out).append(loading("Making a code…"));
      try {
        const r = await call("/admin/telephony/tests/room-voice", { method: "POST", body: { room: room.value.trim(), type: type.value, ttl: numberOf(ttl, 60, 86400), ...(type.value === "user" ? { user: user.value.trim() } : {}) } });
        const entry = r.entry || {};
        const code = r.code || entry.code || "";
        const number = r.number || r.did || "";
        const expires = r.expiresAt || entry.expiresAt;
        clear(out).append(h("div", { class: "tel-voice" },
          h("div", { class: "tel-voice__big" },
            h("div", {}, h("div", { class: "muted small" }, "Call"), h("div", { class: "tel-code mono" }, number || "an inbound number (no number answered)"), number ? copyBtn(number) : null),
            h("div", {}, h("div", { class: "muted small" }, "Type"), h("div", { class: "tel-code mono", "data-testid": "tel-rv-code" }, code || "?"), code ? copyBtn(code) : null),
            expires ? h("div", {}, h("div", { class: "muted small" }, "Valid for"), h("div", { class: "tel-code mono tel-countdown", "data-tel-expires": String(expires) }, span((expires - Date.now()) / 1000))) : null),
          h("ol", { class: "tel-steps" },
            h("li", {}, `Dial ${number || "the inbound number"} from any phone.`),
            h("li", {}, `When the application asks for a code, type ${code || "the code"} and #.`),
            h("li", {}, type.value === "user" ? "Speak: the member hears you (when connected with audio), and you hear them." : "Speak: every member connected with audio hears you, and you hear the room."),
            h("li", {}, "Hang up to end it; the code stops working when it expires.")),
          (r.checks || []).length ? testResult(r, "") : null));
        clearInterval(tickTimer);
        tickTimer = setInterval(tick, 1000);
      } catch (err) { clear(out).append(isMissing(err) ? failed(err, null, "Voice into a room") : h("div", { class: "tel-result" }, badge("failed", "err"), " ", err.message)); }
    }) }, ic("key-round"), "Get a code"), "test");
    return card("Voice into a room", "A route code and the number to call: your voice goes to the room (or a member) and theirs to you.", null,
      h("div", { class: "form-grid" }, field("Room (blind id)", room), field("To", type), userBox, field("Valid for (seconds)", ttl)),
      h("div", { class: "row" }, h("span", { class: "spacer" }), run), out);
  }

  async function sipAddressCard() {
    const r = await need("sipAddr");
    const refresh = () => { forget("sipAddr"); renderTab(); };
    const title = "Test inbound SIP address";
    const hint = "A SIP URI you can call from any SIP phone or softphone to try the inbound rules and an application without buying a number: the provider's SIP domain hands the call to this server as if it came to a test DID.";
    if (r.error) return card(title, hint, null, failed(r.error, refresh, "The test SIP address"));
    const answer = r.data || {};
    const a = answer.address !== undefined ? answer.address : null;
    const providers = listOf(answer.providers);
    const capable = providers.filter((p) => p.can);
    const prov = select(providers.length ? providers.map((p) => ({ value: p.id, label: `${plabel(p.id)}${p.can ? "" : " — cannot"}`, disabled: !p.can })) : VOICE_PROVIDERS.map((id) => ({ value: id, label: plabel(id) })), a ? a.provider : (capable[0] || {}).id || "", { "data-read": "1", "aria-label": "Provider", "data-testid": "tel-sip-provider" });
    const did = input(a ? a.did : "", { placeholder: "+000100 (a test DID)", class: "input mono", "data-read": "1", "aria-label": "The DID it stands for", "data-testid": "tel-sip-did" });
    const out = h("div", { "aria-live": "polite" });
    const create = (label, confirmText) => gate(h("button", { type: "button", class: a ? "btn" : "btn btn--primary", "data-testid": a ? "tel-sip-rotate" : "tel-sip-create", onclick: (e) => busy(e.currentTarget, async () => {
      if (confirmText && !confirm(confirmText)) return;
      if (did.value.trim() && patternProblem(did.value.trim())) { toast(`The DID: ${patternProblem(did.value.trim())}`, "err"); return; }
      try {
        const res = await call("/admin/telephony/tests/sip-address", { method: "POST", body: { provider: prov.value, ...(did.value.trim() ? { did: did.value.trim() } : {}) } });
        const next = res.address !== undefined ? { address: res.address, providers: res.providers || providers } : { address: res, providers };
        cache.set("sipAddr", Promise.resolve({ data: next }));
        toast(a ? "A new address — the old one no longer answers." : "The test address is ready.", "ok");
        renderTab();
      } catch (err) { clear(out).append(problemsBox([err.message])); }
    }) }, ic(a ? "refresh-cw" : "plus"), label), "test");
    const howList = providers.length ? h("ul", { class: "small tel-hows" }, ...providers.map((p) => h("li", {}, h("strong", {}, plabel(p.id)), p.can ? " ✓ " : " ✗ ", p.how || ""))) : null;
    if (!a) {
      return card(title, hint, null,
        h("div", { class: "form-grid" }, field("Provider", prov, capable.length ? null : "No provider can set one up with the current configuration."), field("Stands for the DID", did, "Empty = the server picks a test number.")),
        h("div", { class: "row" }, h("span", { class: "spacer" }), create("Create the address")), out, howList);
    }
    const remove = gate(h("button", { type: "button", class: "btn btn--danger", "data-testid": "tel-sip-remove", onclick: (e) => busy(e.currentTarget, async () => {
      if (!confirm("Remove the test address at the provider?")) return;
      try { await call("/admin/telephony/tests/sip-address", { method: "DELETE" }); cache.set("sipAddr", Promise.resolve({ data: { address: null, providers } })); toast("Removed", "ok"); renderTab(); }
      catch (err) { clear(out).append(problemsBox([err.message])); }
    }) }, ic("trash-2"), "Remove"), "test");
    const setup = a.setup || {};
    const dry = h("div", { "aria-live": "polite" });
    const tryRules = h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: (e) => busy(e.currentTarget, async () => {
      clear(dry).append(loading());
      try { const d = await call("/admin/telephony/rules/test", { method: "POST", body: { direction: "inbound", from: "", to: a.did, provider: a.provider } }); clear(dry).append(decisionView(d.decision || d, {})); }
      catch (err) { clear(dry).append(h("div", { class: "err small" }, err.message)); }
    }) }, ic("play"), "What would a call run?");
    return card(title, hint, h("span", { class: "tel-badges" }, a.enabled === false ? badge("disabled", "warn") : badge("live", "ok")),
      h("div", { class: "tel-sipuri" }, h("code", { class: "tel-sipuri__uri", "data-testid": "tel-sip-uri" }, a.uri), copyBtn(a.uri, "Copy", "SIP URI copied")),
      kv([
        ["Stands for", h("span", { class: "mono" }, a.did)],
        ["Provider", plabel(a.provider)],
        ["Set up at the provider", `${setup.resource || "—"}${setup.at ? ` · ${when(setup.at)}` : ""}${setup.by ? ` · ${setup.by}` : ""}`],
        ["Credentials", a.username ? h("span", {}, h("span", { class: "mono" }, a.username), h("span", { class: "muted" }, " (digest; the password was shown once when it was made)")) : "none — anyone with the URI can call it; rotate it to change it"],
      ]),
      h("div", { class: "tel-sub" },
        h("strong", { class: "small" }, "From a softphone (Linphone, Zoiper, MicroSIP, a desk phone)"),
        h("ol", { class: "small tel-steps" },
          h("li", {}, "Use any SIP account you have (or the provider's own client) — the address does not need one of its own", a.username ? ", or add an account with the user name above and its password." : "."),
          h("li", {}, "Dial the URI above (most softphones take it as it is in the dial field)."),
          h("li", {}, `The call reaches the inbound rules as a call to ${a.did} through ${plabel(a.provider)}: add an inbound rule for ${a.did} to run the application you are testing.`),
          h("li", {}, "Follow it in the Log (kind “sip” and “call”).")),
        h("div", { class: "row" }, tryRules, h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => go("inbound") }, "Inbound rules"), h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { S.log.filters = { ...S.log.filters, kind: "sip" }; go("log"); } }, "Log")), dry),
      h("div", { class: "form-grid" }, field("Provider", prov), field("Stands for the DID", did)),
      h("div", { class: "row" }, remove, h("span", { class: "spacer" }), create("Rotate", "Make a new address? The current URI stops answering.")), out, howList);
  }

  /* ======================================================== calls & bridges */

  const callTone = (s) => (["completed", "delivered", "connected", "answered", "read", "in-progress"].includes(s) ? "ok" : ["failed", "busy", "no-answer", "canceled", "undelivered", "expired"].includes(s) ? "err" : "info");

  VIEWS.calls = async (gen) => {
    forget("sdk");
    const r = await need("sdk");
    if (stale(gen)) return null;
    if (r.error) return failed(r.error, () => renderTab(), "Calls & sessions");
    const d = r.data;
    const calls = listOf(d.calls);
    const bridges = listOf(d.bridges);
    const messages = listOf(d.messages);
    const sdkLog = listOf(d.log);
    const store = d.store || {};
    const row = (cells, attrs = {}) => h("tr", attrs, ...cells.map((c) => (c instanceof Node ? c : h("td", {}, c === null || c === undefined || c === "" ? "—" : String(c)))));
    const table = (cols, rows, testid, emptyText) => rows.length
      ? h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "t", "data-testid": testid }, h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", {}, c)))), h("tbody", {}, ...rows)))
      : empty(emptyText);
    const live = calls.filter((c) => !c.final);
    const callRows = calls.map((c) => {
      const tr = row([
        h("td", { class: "small" }, whenSec(c.createdAt)),
        h("td", {}, h("span", { class: c.direction === "inbound" ? "dir-in" : "dir-out" }, c.direction || "")),
        plabel(c.provider),
        h("td", { class: "mono small" }, `${c.from || "default"} → ${c.to || "?"}`),
        c.mode,
        h("td", {}, badge(c.status || "?", callTone(c.status))),
        c.durationSec === null || c.durationSec === undefined ? "" : `${c.durationSec} s`,
        h("td", { class: "small err tel-clip" }, c.error || ""),
      ], { class: "is-clickable", tabindex: "0", "data-call": c.id });
      tr.addEventListener("click", () => callDrawer(c.id));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") callDrawer(c.id); });
      return tr;
    });
    const bridgeRows = bridges.map((b) => row([
      h("td", { class: "mono small" }, b.number),
      h("td", { class: "small" }, `${b.roomHash || ""} · ${(b.member && (b.member.name || b.member.peerId || b.member.accountId)) || "—"}`),
      h("td", { class: "mono" }, b.code),
      h("td", {}, badge(b.status, callTone(b.status))),
      b.channel,
      h("td", { class: "small" }, (b.attempts || []).map((a) => `${a.ok ? "✓" : "✗"} ${a.from}`).join(", ") || "—"),
      h("td", { class: "small" }, b.stats ? `${b.stats.heardSegments} / ${b.stats.spokenReplies}` : "—"),
      h("td", { class: "small" }, whenSec(b.expiresAt)),
      h("td", {}, ["waiting", "ringing", "verifying", "connected"].includes(b.status) && can("operator") ? h("button", { type: "button", class: "btn btn--sm btn--danger", onclick: (e) => busy(e.currentTarget, async () => {
        if (!confirm(`Release ${b.number}? A call on it ends.`)) return;
        try { await call(`/api/admin/telephony/sdk/bridges/${encodeURIComponent(b.id)}/release`, { method: "POST", body: {} }); toast("Released", "ok"); renderTab(); } catch (err) { toast(err.message, "err"); }
      }) }, "Release") : ""),
    ]));
    const msgRows = messages.map((m) => row([h("td", { class: "small" }, whenSec(m.createdAt)), m.channel, plabel(m.provider), h("td", { class: "mono small" }, m.to), h("td", {}, badge(m.status || "?", callTone(m.status))), m.parts]));
    const box = h("div", { class: "stack", "data-testid": "tel-calls" },
      h("div", { class: "grid grid--kpi" },
        h("div", { class: `kpi${live.length ? " is-ok" : ""}` }, h("div", { class: "kpi__label" }, "Live calls"), h("div", { class: "kpi__value" }, String(live.length)), h("div", { class: "kpi__sub" }, `${calls.length} recent`)),
        h("div", { class: "kpi" }, h("div", { class: "kpi__label" }, "Lent numbers"), h("div", { class: "kpi__value" }, String(bridges.filter((b) => ["waiting", "ringing", "verifying", "connected"].includes(b.status)).length)), h("div", { class: "kpi__sub" }, `${listOf(d.pool).length} in the pool`)),
        h("div", { class: "kpi" }, h("div", { class: "kpi__label" }, "Messages"), h("div", { class: "kpi__value" }, String(messages.length)), h("div", { class: "kpi__sub" }, "recent"))),
      card("Calls", "m5.telephony.call, applications' calls and console tests — newest first. Click one for its events.", h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => renderTab() }, ic("refresh-cw"), "Refresh"),
        table(["When", "Dir", "Provider", "From → to", "Mode", "Status", "Duration", "Error"], callRows, "tel-call-table", "No call yet.")),
      card("Phone bridge — lent numbers", h("span", {}, "Numbers lent to a room member by m5.telephony.did. Pool (TELEPHONY_DID_POOL): ", listOf(d.pool).map((p) => `${p.provider ? `${p.provider}:` : ""}${p.number}`).join(", ") || "empty"), null,
        table(["Number", "Room · member", "Code", "Status", "Channel", "Attempts", "Heard / replies", "Until", ""], bridgeRows, "tel-bridge-table", "No number lent.")),
      card("Messages", "SMS and chat messages functions sent.", null, table(["When", "Channel", "Provider", "To", "Status", "Parts"], msgRows, "tel-msg-table", "No message yet.")),
      h("details", { class: "card tel-details" }, h("summary", {}, `Functions' telephony log (${sdkLog.length}) — the module's own log is under Log`),
        h("pre", { class: "code" }, sdkLog.map((e) => `${clock(e.at)}  ${String(e.level || "").padEnd(6)} ${String(e.kind || "").padEnd(8)} ${e.provider || "-"}  ${e.summary}`).join("\n") || "(nothing yet)")),
      h("div", { class: "muted small" }, "Records: ", h("code", {}, store.file || "—"), store.persistent === false ? ` — ${store.reason || "in memory only"}` : "", " · webhooks at ", h("code", {}, `${d.publicBaseUrl || "PUBLIC_BASE_URL (not set!)"}/wh/tel/…`)));
    if (S.arg) { const id = S.arg; setTimeout(() => callDrawer(id), 0); }
    return box;
  }

  async function callDrawer(id) {
    S.arg = id;
    if (S.tab === "calls") writeHash();
    const dr = drawer("Call", { subtitle: id, wide: true, testid: "tel-call-drawer", onClose: () => { if (S.tab === "calls") { S.arg = ""; writeHash(); } } });
    dr.body.append(loading());
    try {
      const r = await call(`/api/admin/telephony/sdk/calls/${encodeURIComponent(id)}`);
      const c = r.call || {};
      put(clear(dr.body),
        h("div", { class: "row" }, badge(c.status || "?", callTone(c.status)), h("span", { class: c.direction === "inbound" ? "dir-in" : "dir-out" }, c.direction || ""), h("strong", { class: "mono" }, `${c.from || "default"} → ${c.to || "?"}`)),
        kv([["Provider", plabel(c.provider)], ["Provider's call id", h("span", { class: "mono" }, c.providerCallId || "—")], ["Mode", c.mode], ["Created", whenSec(c.createdAt)], ["Answered", c.answeredAt ? whenSec(c.answeredAt) : "—"], ["Ended", c.endedAt ? whenSec(c.endedAt) : "—"], ["Duration", c.durationSec === null || c.durationSec === undefined ? "—" : `${c.durationSec} s`], ["Owner", c.owner ? `${c.owner.modelId || ""} · ${c.owner.caller || ""}` : "—"], ["Error", c.error || "—"]]),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { dr.close(); S.log.filters = { ...S.log.filters, callId: id }; go("log"); } }, ic("list"), "Its events in the log"), copyBtn(id, "Copy the id")),
        jsonBlock("Events", c.events || [], "tel-call-events"),
        c.handlers ? jsonBlock("Handlers", c.handlers, "tel-call-handlers") : null,
        h("h3", {}, "Log"),
        h("pre", { class: "code" }, listOf(r.log).map((e) => `${clock(e.at)}  ${String(e.level || "").padEnd(6)} ${e.summary}`).join("\n") || "(nothing)"));
    } catch (err) { clear(dr.body).append(failed(err, () => { dr.close(); callDrawer(id); }, "The call")); }
  }

  /* ================================================================== log */

  const RANGES = [["", "Any time"], ["900", "Last 15 min"], ["3600", "Last hour"], ["86400", "Last 24 h"], ["604800", "Last 7 days"]];
  const since = () => (S.log.filters.range ? Date.now() - Number(S.log.filters.range) * 1000 : 0);
  let logUi = null;

  function logPath(before) {
    const f = S.log.filters;
    const q = new URLSearchParams();
    for (const k of ["kind", "provider", "level", "callId", "q"]) if (f[k]) q.set(k, f[k]);
    if (before) q.set("before", String(before));
    q.set("limit", "100");
    return `/admin/telephony/log?${q}`;
  }

  async function fetchLog(append) {
    S.log.loading = true;
    try {
      const r = await call(logPath(append ? S.log.next : 0));
      const entries = listOf(r, "entries");
      S.log.entries = append ? S.log.entries.concat(entries) : entries;
      S.log.next = r.next === undefined ? null : r.next;
      S.log.error = null;
    } catch (err) {
      S.log.error = err;
      if (!append) { S.log.entries = []; S.log.next = null; }
    }
    S.log.loading = false;
  }

  async function pollLog() {
    if (!visible() || S.tab !== "log" || !S.log.auto) { clearInterval(logTimer); logTimer = 0; return; }
    if (S.log.loading) return;
    try {
      const r = await call(logPath(0));
      const known = new Set(S.log.entries.map((e) => e.id));
      const fresh = listOf(r, "entries").filter((e) => !known.has(e.id));
      if (!fresh.length) return;
      S.log.entries = fresh.concat(S.log.entries).slice(0, 2000);
      drawLog(new Set(fresh.map((e) => e.id)));
    } catch { /* the next tick tries again */ }
  }

  function logRow(e, isNew) {
    const http = e.http ? `${e.http.method || ""} ${e.http.status || ""}${e.http.ms !== undefined ? ` · ${e.http.ms} ms` : ""}` : "";
    const tr = h("tr", { class: `is-clickable${isNew ? " is-new" : ""}${e.level === "error" ? " is-err" : e.level === "warn" ? " is-warn" : ""}`, tabindex: "0", "data-id": e.id, "aria-label": `${e.level} ${e.kind}: ${e.summary}` },
      h("td", { class: "mono small", title: whenSec(e.at) }, clock(e.at)),
      h("td", {}, badge(e.level || "info", LEVEL_TONE[e.level] || "")),
      h("td", {}, badge(e.kind || "?", e.kind === "webhook" ? "violet" : e.kind === "test" ? "info" : "")),
      h("td", { class: "small" }, e.provider || "—"),
      h("td", { class: "small" }, e.direction ? h("span", { class: e.direction === "inbound" ? "dir-in" : "dir-out" }, e.direction === "inbound" ? "in" : "out") : "—"),
      h("td", { class: "tel-logsum" }, e.summary || ""),
      h("td", { class: "mono small" }, e.callId ? h("button", { type: "button", class: "tel-chiplink", "data-read": "1", title: `Only this call (${e.callId})`, onclick: (ev) => { ev.stopPropagation(); setLogFilter({ callId: e.callId }); } }, e.callId.length > 10 ? `${e.callId.slice(0, 10)}…` : e.callId) : "—"),
      h("td", { class: "mono small" }, http || "—"),
      h("td", { class: "small" }, e.verified === true ? h("span", { class: "ok", title: "signature verified" }, "✓") : e.verified === false ? h("span", { class: "err", title: "NOT verified" }, "✗") : h("span", { class: "muted" }, "—")));
    tr.addEventListener("click", () => openLogEntry(e.id, e));
    tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target === tr) { ev.preventDefault(); openLogEntry(e.id, e); } });
    return tr;
  }

  function drawLog(freshIds) {
    if (!logUi) return;
    const { tbody, more, status } = logUi;
    clear(tbody);
    const from = since();
    const shown = S.log.entries.filter((e) => !from || (e.at || 0) >= from);
    for (const e of shown) tbody.append(logRow(e, freshIds && freshIds.has(e.id)));
    const oldest = S.log.entries.length ? S.log.entries[S.log.entries.length - 1].at || 0 : 0;
    more.hidden = S.log.next === null || S.log.next === undefined || (from && oldest < from);
    clear(status);
    if (S.log.error) status.append(failed(S.log.error, () => void reloadLog(), "The log"));
    else if (!shown.length) status.append(empty(S.log.entries.length ? "No event in this time range." : Object.values(S.log.filters).some(Boolean) ? "No event matches the filters." : "No event yet. Tests, webhooks and calls write here."));
    status.hidden = !status.firstChild;
    logUi.count.textContent = `${shown.length} shown${S.log.next ? " · more older" : ""}`;
  }

  async function reloadLog() {
    if (!logUi) return;
    clear(logUi.status).append(loading());
    logUi.status.hidden = false;
    await fetchLog(false);
    drawLog();
  }

  function setLogFilter(patch) {
    S.log.filters = { ...S.log.filters, ...patch };
    if (S.tab !== "log") { go("log"); return; }
    renderTab();
  }

  VIEWS.log = async (gen) => {
    const f = S.log.filters;
    const snap = await need("snap");
    const kind = select([{ value: "", label: "Every kind" }, ...LOG_KINDS.map((k) => ({ value: k, label: k }))], f.kind, { "data-read": "1", "aria-label": "Kind", "data-testid": "tel-log-kind" });
    const provIds = [...new Set([...VOICE_PROVIDERS, "hlrlookups", "meta", ...((snap.data && snap.data.webhooks) || []).map((w) => w.provider)])];
    const prov = select([{ value: "", label: "Every provider" }, ...provIds.map((id) => ({ value: id, label: plabel(id) }))], f.provider, { "data-read": "1", "aria-label": "Provider", "data-testid": "tel-log-provider" });
    const level = select([{ value: "", label: "Every level" }, ...LEVELS.map((l) => ({ value: l, label: l }))], f.level, { "data-read": "1", "aria-label": "Level", "data-testid": "tel-log-level" });
    const callId = input(f.callId, { placeholder: "Call id", class: "input mono", "data-read": "1", "aria-label": "Call id", "data-testid": "tel-log-call" });
    const q = input(f.q, { type: "search", placeholder: "Search the text…", "data-read": "1", "aria-label": "Search", "data-testid": "tel-log-q" });
    const range = select(RANGES.map(([value, label]) => ({ value, label })), f.range, { "data-read": "1", "aria-label": "Time range", "data-testid": "tel-log-range" });
    const auto = toggle("Auto-refresh", S.log.auto, { "data-read": "1", "data-testid": "tel-log-auto" });
    const apply = () => { S.log.filters = { kind: kind.value, provider: prov.value, level: level.value, callId: callId.value.trim(), q: q.value.trim(), range: range.value }; void reloadLog(); };
    for (const el of [kind, prov, level]) el.addEventListener("change", apply);
    range.addEventListener("change", () => { S.log.filters.range = range.value; drawLog(); });
    let debounce = 0;
    for (const el of [callId, q]) {
      el.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(apply, 350); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(debounce); apply(); } });
    }
    auto.box.addEventListener("change", () => {
      S.log.auto = auto.box.checked;
      clearInterval(logTimer);
      logTimer = S.log.auto ? setInterval(() => void pollLog(), 5000) : 0;
      if (S.log.auto) void pollLog();
    });
    const reset = h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { S.log.filters = { kind: "", provider: "", level: "", callId: "", q: "", range: "" }; renderTab(); } }, "Clear filters");
    const clearLog = gate(h("button", { type: "button", class: "btn btn--sm btn--danger", "data-testid": "tel-log-clear", onclick: (e) => busy(e.currentTarget, async () => {
      if (!confirm("Delete every event of the log? (The deletion itself goes into the audit log.)")) return;
      try { await call("/admin/telephony/log", { method: "DELETE" }); toast("Log cleared", "ok"); void reloadLog(); } catch (err) { toast(err.message, "err"); }
    }) }, ic("trash-2"), "Clear the log"), "settings");
    const tbody = h("tbody");
    const more = h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "data-testid": "tel-log-more", onclick: (e) => busy(e.currentTarget, async () => { await fetchLog(true); drawLog(); }) }, "Load older");
    const status = h("div", { class: "tel-logstatus" });
    const count = h("span", { class: "muted small", "aria-live": "polite" });
    const box = h("div", { class: "stack", "data-testid": "tel-log" },
      h("div", { class: "card tel-logbar" },
        h("div", { class: "toolbar" }, kind, prov, level, callId, q, range, auto.el, h("span", { class: "spacer" }), reset, h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => void reloadLog() }, ic("refresh-cw"), "Refresh"), clearLog)),
      h("div", { class: "card tel-card" },
        h("div", { class: "card__head" }, h("div", { class: "tel-card__titles" }, h("div", { class: "card__title" }, "Events"), h("div", { class: "card__hint" }, "Webhooks (with their signature check), calls, SMS, applications, routing decisions, route codes, tests and changes. Click an event for everything it carried.")), h("div", { class: "card__actions" }, count)),
        h("div", { class: "table-wrap tel-logwrap" }, h("table", { class: "t tel-logtable", "data-testid": "tel-log-table" },
          h("thead", {}, h("tr", {}, ...["Time", "Level", "Kind", "Provider", "Dir", "Summary", "Call", "HTTP", "Sig."].map((x) => h("th", {}, x)))), tbody)),
        status, h("div", { class: "row" }, h("span", { class: "spacer" }), more)));
    logUi = { tbody, more, status, count };
    await fetchLog(false);
    if (stale(gen)) return null;
    drawLog();
    if (S.arg) { const id = S.arg; setTimeout(() => openLogEntry(id, S.log.entries.find((e) => e.id === id)), 0); }
    return box;
  };

  /** One event in full: the summary, HTTP, the signature check, links, the parsed data and the raw payload. */
  async function openLogEntry(id, row) {
    S.arg = id;
    if (S.tab === "log") writeHash();
    const dr = drawer(row ? row.summary || "Event" : "Event", { subtitle: id, wide: true, testid: "tel-log-drawer", onClose: () => { if (S.tab === "log") { S.arg = ""; writeHash(); } } });
    dr.body.append(loading());
    let entry = null;
    let error = null;
    try { const r = await call(`/admin/telephony/log/${encodeURIComponent(id)}`); entry = r.entry || r; } catch (err) { error = err; }
    if (!dr.el.isConnected) return;
    clear(dr.body);
    const e = entry || row;
    if (!e) { dr.body.append(failed(error, null, "The event")); return; }
    if (error) dr.body.append(h("div", { class: "tel-note tel-note--warn" }, ic("circle-alert"), error.status === 403 ? "Your access does not include full log entries (the log right): the summary only." : `The full entry could not be loaded (${error.message}): the summary only.`));
    const verified = e.verified === true ? badge("signature verified", "ok") : e.verified === false ? badge("signature NOT verified", "err") : badge("no signature check", "");
    const go2 = (fn) => () => { dr.close(); fn(); };
    const links = h("div", { class: "row" },
      e.callId ? h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: go2(() => go("calls", e.callId)) }, ic("activity"), "Open the call") : null,
      e.callId ? h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: go2(() => setLogFilter({ callId: e.callId })) }, ic("filter"), "Every event of this call") : null,
      e.tsaSession ? h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: go2(() => setLogFilter({ q: e.tsaSession })) }, ic("workflow"), "Every event of this application run") : null,
      e.rule ? h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: go2(() => go(e.direction === "outbound" ? "outbound" : "inbound", e.rule)) }, ic("settings-2"), "Open the rule") : null,
      h("span", { class: "spacer" }),
      copyBtn(() => JSON.stringify(e, null, 2), "Copy the event", "Event copied"),
      copyBtn(`${location.origin}${location.pathname}#/telephony/log/${encodeURIComponent(id)}`, "Copy a link", "Link copied"));
    put(dr.body,
      h("div", { class: "tel-loghead", "data-testid": "tel-log-head" },
        h("div", { class: "tel-badges" }, badge(e.level || "info", LEVEL_TONE[e.level] || ""), badge(e.kind || "?"), e.provider ? badge(plabel(e.provider), "accent") : null, e.direction ? badge(e.direction, e.direction === "inbound" ? "info" : "violet") : null, verified),
        h("div", { class: "tel-loghead__sum" }, e.summary || "")),
      kv([
        ["When", `${whenSec(e.at)} (${ago(e.at)})`],
        ["HTTP", e.http ? h("span", { class: "mono" }, `${e.http.method || ""} ${e.http.path || ""} → ${e.http.status || "?"}${e.http.ms !== undefined ? ` · ${e.http.ms} ms` : ""}`) : "—"],
        ["Call", e.callId ? h("span", { class: "mono" }, e.callId) : "—"],
        ["Application run", e.tsaSession ? h("span", { class: "mono" }, e.tsaSession) : "—"],
        ["Rule", e.rule ? h("span", { class: "mono" }, e.rule) : "—"],
        ["Id", h("span", { class: "mono" }, e.id || id)],
      ]),
      links,
      entry ? (entry.parsed === undefined || entry.parsed === null ? h("div", { class: "muted small" }, "Nothing was parsed from this event.") : jsonBlock("Parsed data", entry.parsed, "tel-log-parsed")) : null,
      entry ? (entry.raw === undefined || entry.raw === null ? h("div", { class: "muted small", "data-testid": "tel-log-noraw" }, entry.kind === "webhook" ? "The raw payload was not kept (Permissions › Event log › keep the raw payload)." : "No raw payload: only a provider's webhook carries one.") : jsonBlock("Raw payload (secrets removed)", entry.raw, "tel-log-raw")) : null);
  }

  // For the page's tests (and a curious operator): the pure parts.
  window.M5TelConsole = { DEFAULT_PERMISSIONS, patternProblem, e164Problem, hoursProblems, ruleProblems, listOf, jsonTree, go: (tab, arg) => go(tab, arg), state: S };

  // Last: with a restored session and a deep link the console opens the page
  // at once — everything above must exist by then.
  C.addRoute("telephony", ["Telephony & SIP", "Providers, permissions, routing, applications, route codes, trunks, tests and the event log", load]);
})();
