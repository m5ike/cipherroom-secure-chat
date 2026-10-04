// The console's Telephony & SIP page (admin-ui/public/telephony-console.js,
// 6.9) on a stand-in for console.js and a fake admin service that answers
// per the contract (server/telephony/control/api-contract.ts): every tab
// draws from its answers, the rule editor refuses what is wrong before it
// asks the server, the log's drawer shows the parsed data and the raw
// payload, deep links open what they name — and the page builds DOM nodes,
// never markup.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OverviewAnswer, RulesAnswer, PermissionsAnswer, TsaListRow, LogAnswer, TestAnswer, SipAddressAnswer, RulesTestAnswer } from "../server/telephony/control/api-contract";
import type { InboundRule, OutboundRule, TelLogEntry, InrouteEntry } from "../server/telephony/control/types";
import { DEFAULT_PERMISSIONS } from "../server/telephony/control/types";

const PUBLIC = join(__dirname, "..", "admin-ui", "public");
const SOURCE = readFileSync(join(PUBLIC, "telephony-console.js"), "utf8");

/* ------------------------------------------------------------ fixtures */

const NOW = Date.now();
const trunk = { id: "prague1", label: "Prague office", host: "sip.example.net", port: 5060, username: "m5", authUser: "", register: true, didNumbers: ["+420212345678"], callerIdName: "M5", callerIdNumber: "+420212345678", hasPassword: true, updatedAt: NOW - 3600_000, source: "file" };
const snap = {
  ok: true, apiVersion: 2, enabled: true,
  defaults: { sms: "twilio", voice: "twilio" }, defaultsSource: { sms: "admin", voice: "env" },
  settings: { smsProvider: "twilio", voiceProvider: null },
  sms: [{ id: "twilio", kind: "sms", label: "Twilio SMS", configured: true, needs: [] }, { id: "vonage", kind: "sms", label: "Vonage SMS", configured: false, reason: "Set VONAGE_API_KEY", needs: ["VONAGE_API_KEY"] }],
  voice: [{ id: "twilio", kind: "voice", label: "Twilio Voice", configured: true, needs: [] }],
  sip: [trunk], envTrunks: { loaded: 0, errors: [] },
  persistence: { writable: true, file: "/data/telephony.json" },
  publicBaseUrl: "https://chat.example.org",
  webhooks: [
    { provider: "twilio", verification: { verify: "twilio-hmac", configured: true, needs: "TWILIO_AUTH_TOKEN" }, specs: [{ provider: "twilio", type: "voice", path: "/wh/twilio/voice", url: "https://chat.example.org/wh/twilio/voice", method: "POST", description: "Inbound calls", verify: "twilio-hmac" }] },
    { provider: "vonage", verification: { verify: "vonage-jwt", configured: false, needs: "VONAGE_SIGNATURE_SECRET" }, specs: [] },
  ],
};
const providers = [
  { id: "twilio", label: "Twilio", capabilities: ["call", "sms", "lookup"], configured: ["call", "sms"], needs: { call: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], sms: ["TWILIO_ACCOUNT_SID"], lookup: ["TWILIO_ACCOUNT_SID"] } },
  { id: "vonage", label: "Vonage", capabilities: ["call", "sms"], configured: [], needs: { call: ["VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY"], sms: ["VONAGE_API_KEY"] }, reason: "Set VONAGE_API_KEY" },
];
const overview: OverviewAnswer = {
  providers: [
    { id: "twilio", label: "Twilio", capabilities: ["call", "sms", "lookup"], configured: ["call", "sms"], services: { app: true, sip: true } },
    { id: "vonage", label: "Vonage", capabilities: ["call", "sms"], configured: [], reason: "Set VONAGE_API_KEY", services: { app: false, sip: false } },
  ],
  counts: { inboundRules: 2, outboundRules: 1, tsa: 3, tsaPublished: 2, liveCalls: 1, inroute: 4, eventsToday: 57, errorsToday: 2 },
  publicBaseUrl: "https://chat.example.org",
  warnings: ["Calls through Vonage are refused: its application is not configured."],
};
const inbound: InboundRule[] = [
  { id: "in-office", label: "Office hours", enabled: true, priority: 10, match: { numbers: ["+420212345678"], from: [], provider: "", service: "", hours: { timezone: "Europe/Prague", days: "mon-fri", from: "08:00", to: "17:00" } }, target: { kind: "tsa", tsa: "main-ivr" }, record: true, note: "The main line" },
  { id: "in-night", label: "Night", enabled: true, priority: 20, match: { numbers: ["+4202*"], from: ["-+4209*"], provider: "twilio", service: "app", hours: null }, target: { kind: "state", state: "busy" }, record: false, note: "" },
];
const outbound: OutboundRule[] = [
  { id: "out-cz", label: "Czech numbers via the trunk", enabled: true, priority: 10, match: { to: ["+420*"], groups: ["staff"], sources: ["function"], hours: null }, service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420212345678", name: "M5", presentation: "allowed" } }, target: { kind: "pass" }, note: "" },
];
let rules: RulesAnswer;
const tsaList: TsaListRow[] = [
  { id: "main-ivr", name: "Main IVR", description: "Press 1 for sales", version: 3, updatedAt: NOW - 86400_000, updatedBy: "owner", tags: ["ivr"], published: true, publishedVersion: 3, usedBy: ["in-office"], nodes: 14 },
  { id: "voicemail", name: "Voicemail", description: "", version: 0, updatedAt: NOW - 7200_000, updatedBy: "owner", tags: [], published: false, publishedVersion: 0, usedBy: [], nodes: 5 },
];
const perms: PermissionsAnswer = { permissions: structuredClone(DEFAULT_PERMISSIONS), access: [{ group: "mod-telephony", allow: ["*"], deny: [] }, { group: "staff", allow: ["call", "test"], deny: ["number:+1900*"] }] };
const inroute: InrouteEntry[] = [
  { code: "4821", type: "room", room: "r3.abcdef", user: "", label: "Support", ttlSec: 600, createdAt: NOW - 60_000, expiresAt: NOW + 540_000, createdBy: { kind: "model", id: "phone-bot" }, uses: 1, maxUses: 0 },
];
const logEntry: TelLogEntry = {
  id: "ev-1", at: NOW - 5000, kind: "webhook", level: "info", provider: "twilio", direction: "inbound",
  summary: "voice webhook: call ringing", callId: "call-77", tsaSession: "ts-9", rule: "in-office", verified: true,
  http: { method: "POST", path: "/wh/twilio/voice", status: 200, ms: 12 },
  parsed: { kind: "answer", callId: "call-77", from: "+420777123456", nested: { digits: "1#", list: [1, 2, 3] } },
  raw: { CallSid: "CA123", From: "+420777123456", CallStatus: "ringing" },
};
const logRows: LogAnswer = { entries: [(({ parsed: _p, raw: _r, ...rest }) => rest)(logEntry), { id: "ev-2", at: NOW - 9000, kind: "test", level: "error", provider: "vonage", direction: "", summary: "provider test failed", callId: "", tsaSession: "", rule: "", verified: null, http: null }], next: null };
const testOk: TestAnswer = { ok: true, at: NOW, log: ["GET /Accounts → 200"], checks: [{ id: "creds", label: "Credentials present", ok: true, detail: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN" }, { id: "api", label: "The API answers", ok: true, detail: "balance 12.40 USD", ms: 120 }, { id: "numbers", label: "Numbers owned", ok: null, detail: "skipped" }] };
const decision: RulesTestAnswer = { direction: "inbound", rule: "in-night", ruleLabel: "Night", service: null, target: { kind: "state", state: "busy" }, reasons: ["Office hours: outside mon-fri 08:00–17:00", "Night: matched +4202*"], rendered: { contentType: "text/xml", body: "<Response><Reject reason=\"busy\"/></Response>" } };
const sipAddress: SipAddressAnswer = { address: { provider: "twilio", uri: "sip:test-abc123@m5.sip.twilio.com", did: "+000100", setup: { resource: "SD123", at: NOW - 1000, by: "owner" }, username: "", enabled: true }, providers: [{ id: "twilio", can: true, how: "a SIP domain" }, { id: "vonage", can: false, how: "needs an application" }] };
const sdk = {
  ok: true, store: { file: "/data/tel.json", persistent: true }, pool: [{ provider: "twilio", number: "+420800100200" }], providers, publicBaseUrl: "https://chat.example.org",
  calls: [{ id: "call-77", provider: "twilio", providerCallId: "CA123", direction: "inbound", from: "+420777123456", to: "+420212345678", status: "in-progress", mode: "tsa", answered: true, final: false, durationSec: null, createdAt: NOW - 30_000, answeredAt: NOW - 25_000, endedAt: null, seq: 3, lastEvent: null, error: "" }],
  messages: [], bridges: [], log: [{ at: NOW - 1000, level: "info", kind: "call", provider: "twilio", summary: "answered" }],
};

/* --------------------------------------------------------- fake server */

type Reply = { __status: number; data: unknown };
const fail = (status: number, data: unknown = null): Reply => ({ __status: status, data });
const calls: Array<{ method: string; path: string; body?: any }> = [];
let overrides: Record<string, (body: any, path: string) => unknown> = {};

function handlers(): Record<string, (body: any, path: string) => unknown> {
  const answers: Record<string, (body: any, path: string) => unknown> = {
    "GET /admin/telephony/overview": () => ({ ok: true, ...overview }),
    "GET /admin/telephony/permissions": () => ({ ok: true, ...structuredClone(perms) }),
    "PUT /admin/telephony/permissions": (b) => ({ ok: true, permissions: b.permissions, access: perms.access }),
    "GET /admin/telephony/rules": () => ({ ok: true, ...structuredClone(rules) }),
    "PUT /admin/telephony/rules/inbound": (b) => { rules.inbound = b.rules; return { ok: true, rules: b.rules }; },
    "PUT /admin/telephony/rules/outbound": (b) => { rules.outbound = b.rules; return { ok: true, rules: b.rules }; },
    "POST /admin/telephony/rules/test": () => ({ ok: true, ...decision }),
    "POST /admin/telephony/tsa/import": (b) => ({ ok: true, tsa: { id: b.id, name: b.name } }),
    "GET /admin/telephony/tsa": () => ({ ok: true, tsa: structuredClone(tsaList) }),
    "POST /admin/telephony/tsa": (b) => ({ ok: true, tsa: { id: b.id, name: b.name } }),
    "POST /admin/telephony/tsa/:id/publish": () => ({ ok: true, version: 4 }),
    "POST /admin/telephony/tsa/:id/duplicate": () => ({ ok: true }),
    "DELETE /admin/telephony/tsa/:id": () => ({ ok: true }),
    "GET /admin/telephony/inroute": () => ({ ok: true, entries: structuredClone(inroute) }),
    "POST /admin/telephony/inroute": (b) => ({ ok: true, entry: { ...b, code: b.code || "5555", expiresAt: NOW + 600_000 } }),
    "DELETE /admin/telephony/inroute/:code": () => ({ ok: true }),
    "GET /admin/telephony/log": () => ({ ok: true, ...structuredClone(logRows) }),
    "GET /admin/telephony/log/:id": (_b, p) => (p.endsWith("/ev-1") ? { ok: true, entry: structuredClone(logEntry) } : fail(404, { ok: false, message: "not found" })),
    "DELETE /admin/telephony/log": () => ({ ok: true }),
    "POST /admin/telephony/tests/provider": () => ({ ...testOk }),
    "POST /admin/telephony/tests/webhook": () => ({ ...testOk }),
    "POST /admin/telephony/tests/route": () => ({ ok: true, ...decision }),
    "POST /admin/telephony/tests/call": () => ({ ...testOk, callId: "call-78" }),
    "POST /admin/telephony/tests/sms": () => ({ ...testOk }),
    "POST /admin/telephony/tests/room-voice": (b) => ({ ...testOk, code: "7310", number: "+420800100200", expiresAt: NOW + (b.ttl || 600) * 1000 }),
    "GET /admin/telephony/tests/sip-address": () => ({ ok: true, ...structuredClone(sipAddress) }),
    "POST /admin/telephony/tests/sip-address": () => ({ ok: true, ...structuredClone(sipAddress) }),
    "DELETE /admin/telephony/tests/sip-address": () => ({ ok: true }),
    "PUT /admin/telephony/settings": (b) => ({ ok: true, settings: b }),
    "POST /admin/telephony/webhooks/install": () => ({ ok: true, provider: "twilio", message: "3 URLs set", details: ["VoiceUrl", "StatusCallback"] }),
    "GET /admin/telephony/sip/trunks": () => ({ ok: true, trunks: [structuredClone(trunk)], persistent: true }),
    "PUT /admin/telephony/sip/trunks": (b) => ({ ok: true, trunk: b }),
    "DELETE /admin/telephony/sip/trunks": () => ({ ok: true }),
    "POST /admin/telephony/sip/route": (b) => ({ ok: true, did: b.did, routed: true, decision: { trunkId: "prague1", label: "Prague office", did: b.did, source: "file" } }),
    "GET /admin/telephony": () => structuredClone(snap),
    "GET /api/admin/telephony/sdk": () => structuredClone(sdk),
    "GET /api/admin/telephony/sdk/calls/:id": () => ({ ok: true, call: { ...sdk.calls[0], events: [{ kind: "answer" }], handlers: {} }, log: [] }),
  };
  return { ...answers, ...overrides };
}

function respond(method: string, path: string, body?: any): { status: number; data: unknown } {
  calls.push({ method, path, body });
  const clean = path.split("?")[0];
  for (const [pattern, fn] of Object.entries(handlers())) {
    const [m, p] = pattern.split(" ");
    if (m !== method) continue;
    if (!new RegExp(`^${p.replace(/:[a-z]+/g, "[^/]+")}$`).test(clean)) continue;
    const r = fn(body, path) as Reply | unknown;
    if (r && typeof r === "object" && "__status" in (r as Reply)) return { status: (r as Reply).__status, data: (r as Reply).data };
    return { status: 200, data: r };
  }
  return { status: 404, data: null };
}

/* ----------------------------------------------- console.js stand-in */

// The same helper console.js exports (window.M5Console.h).
function h(tag: string, attrs: Record<string, any> = {}, ...children: any[]) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

let route: [string, string, () => Promise<void>] | null = null;
let rights: string[] | null = ["*"];
let operator = true;
const toast = vi.fn();

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const byText = (sel: string, text: string | RegExp) => $$(sel).find((el) => (typeof text === "string" ? el.textContent?.includes(text) : text.test(el.textContent || ""))) as HTMLElement;
const last = (method: string, path: string) => calls.filter((c) => c.method === method && c.path.split("?")[0] === path).pop();
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); };
const press = (el: Element | Document, key: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

async function open(hash: string) {
  document.querySelectorAll(".drawer, .drawer-backdrop").forEach((el) => el.remove());
  history.replaceState(null, "", hash);
  await route![2]();
  await settle();
}
async function tab(id: string) {
  ($(`[data-testid="tel-tab-${id}"]`)).click();
  await settle();
}

beforeAll(() => {
  document.body.innerHTML = '<section data-panel="telephony"><div id="telRoot"></div></section>';
  window.confirm = () => true;
  (window as any).M5Icons = { svg: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"), has: () => true };
  (window as any).M5Console = {
    h, toast, applyRoleGates: () => undefined,
    clear: (el: Element) => { while (el.firstChild) el.firstChild.remove(); return el; },
    can: (role: string) => (role === "operator" ? operator : role !== "owner"),
    moduleAccess: () => ({ allowed: true, rights }),
    icon: () => document.createElement("span"),
    api: async (path: string, opts: { method?: string; body?: any } = {}) => {
      const r = respond(opts.method ?? "GET", path, opts.body);
      if (r.status >= 400) throw new Error((r.data as any)?.message || `HTTP ${r.status}`);
      return r.data;
    },
    raw: async (path: string, init: RequestInit = {}) => {
      const r = respond(init.method ?? "GET", path, init.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(r.data === null ? `Cannot ${init.method ?? "GET"} ${path}` : JSON.stringify(r.data), { status: r.status, headers: { "Content-Type": r.data === null ? "text/html" : "application/json" } });
    },
    addRoute: (name: string, entry: [string, string, () => Promise<void>]) => { if (name === "telephony") route = entry; },
  };
  new Function(SOURCE)();
});

beforeEach(() => {
  rules = structuredClone({ inbound, outbound });
  overrides = {};
  rights = ["*"];
  operator = true;
  calls.length = 0;
  toast.mockClear();
  (window as any).M5TsaEditor = { open: vi.fn() };
});

/* =============================================================== tests */

describe("Telephony & SIP — the page", () => {
  it("registers its route and draws the overview from the contract's answer", async () => {
    expect(route![0]).toBe("Telephony & SIP");
    await open("#/telephony");
    expect(location.hash).toBe("#/telephony/overview");
    const ov = $('[data-testid="tel-overview"]');
    expect(ov.textContent).toContain("Inbound rules2");
    expect(ov.textContent).toContain("2 published · 1 drafts");
    expect(ov.textContent).toContain("57");
    expect(ov.textContent).toContain("2 errors");
    expect($('[data-provider="twilio"]').textContent).toContain("✓ SIP trunk");
    expect($('[data-provider="vonage"]').textContent).toContain("not configured");
    const warnings = $('[data-testid="tel-warnings"]').textContent!;
    expect(warnings).toContain("its application is not configured");
    // What the page sees itself: an application a rule runs is not published, Vonage is unsigned only when configured (it is not).
    expect(warnings).not.toContain("Vonage's webhooks");
    expect($("#telRoot .tel-head__status").textContent).toContain("PUBLIC_BASE_URL https://chat.example.org");
  });

  it("puts the overview together itself when the admin service has no overview yet", async () => {
    overrides = { "GET /admin/telephony/overview": () => fail(404) };
    await open("#/telephony/overview");
    const ov = $('[data-testid="tel-overview"]');
    expect(ov.textContent).toContain("no overview endpoint yet");
    expect(ov.textContent).toContain("Inbound rules2");
    expect(ov.textContent).toContain("Live calls1");
    expect(ov.textContent).toContain("Route codes1");
    expect($('[data-provider="twilio"]').textContent).toContain("Voice calls");
  });

  it("renders every tab against the contract's answers without an error state", async () => {
    await open("#/telephony/overview");
    const expected: Record<string, string> = { overview: "tel-overview", providers: "tel-providers", permissions: "tel-permissions", outbound: "tel-rules-outbound", inbound: "tel-rules-inbound", apps: "tel-apps", codes: "tel-codes-view", trunks: "tel-trunks", tests: "tel-tests", calls: "tel-calls", log: "tel-log" };
    for (const [id, testid] of Object.entries(expected)) {
      await tab(id);
      expect(location.hash, id).toBe(`#/telephony/${id}`);
      expect($(`[data-testid="${testid}"]`), id).toBeTruthy();
      expect($("#telTab .tel-state--error"), id).toBeNull();
      expect($(`#telTab-${id}`).getAttribute("aria-selected")).toBe("true");
      // DOM append() would write a stray "null" / "undefined" for a missing part.
      const walker = document.createTreeWalker($("#telRoot"), NodeFilter.SHOW_TEXT);
      const stray: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/^\s*(null|undefined|NaN|\[object Object\])\s*$/.test(n.textContent || "")) stray.push(n.parentElement?.className || "?");
      expect(stray, id).toEqual([]);
    }
  });

  it("moves between tabs with the arrow keys", async () => {
    await open("#/telephony/overview");
    press($("#telTabs"), "ArrowRight");
    await settle();
    expect(location.hash).toBe("#/telephony/providers");
    press($("#telTabs"), "End");
    await settle();
    expect(location.hash).toBe("#/telephony/log");
  });
});

describe("providers", () => {
  it("shows what is missing by name, saves the defaults, installs webhooks and runs the test as a checklist", async () => {
    await open("#/telephony/providers");
    const vonage = $('[data-testid="tel-prov-vonage"]');
    expect(vonage.textContent).toContain("VONAGE_APPLICATION_ID");
    expect(vonage.textContent).toContain("missing");
    expect($('[data-testid="tel-prov-twilio"]').textContent).toContain("https://chat.example.org/wh/twilio/voice");

    (($('[data-testid="tel-def-voice"]')) as HTMLSelectElement).value = "twilio";
    $('[data-testid="tel-def-save"]').click();
    await settle();
    expect(last("PUT", "/admin/telephony/settings")!.body).toEqual({ smsProvider: "twilio", voiceProvider: "twilio" });

    $('[data-testid="tel-wh-install-twilio"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/webhooks/install")!.body).toEqual({ provider: "twilio" });
    expect($('[data-testid="tel-prov-twilio"]').textContent).toContain("3 URLs set");

    $('[data-testid="tel-prov-test-twilio"]').click();
    await settle();
    const result = $('[data-testid="tel-prov-twilio"] [data-testid="tel-test-result"]');
    expect(result.querySelectorAll(".tel-check.is-ok").length).toBe(2);
    expect(result.querySelectorAll(".tel-check.is-skip").length).toBe(1);
    expect(result.textContent).toContain("balance 12.40 USD");
  });
});

describe("permissions", () => {
  it("refuses an invalid value, then saves the form as TelPermissions", async () => {
    await open("#/telephony/permissions");
    expect(($('[data-testid="tel-perm-out-conc"]') as HTMLInputElement).value).toBe("5");
    expect($('[data-testid="tel-perm-blocked"]').textContent).toContain("+1900*");
    expect($('[data-testid="tel-access"]').textContent).toContain("number:+1900*");

    const countries = $('[data-testid="tel-perm-countries-input"]') as HTMLInputElement;
    countries.value = "cz, czech";
    press(countries, "Enter");
    expect($('[data-testid="tel-perm-countries"]').querySelectorAll(".tel-chip").length).toBe(2);
    expect($('[data-testid="tel-perm-countries"]').querySelectorAll(".tel-chip.is-invalid").length).toBe(1);
    $('[data-testid="tel-perm-save"]').click();
    await settle();
    expect(last("PUT", "/admin/telephony/permissions")).toBeUndefined();
    expect($('[data-testid="tel-perm-problems"]').textContent).toContain("CZECH");

    ($('[data-testid="tel-perm-countries"] .tel-chip.is-invalid .tel-chip__x') as HTMLElement).click();
    type($('[data-testid="tel-perm-out-conc"]') as HTMLInputElement, "8");
    ($('[data-testid="tel-perm-keep-raw"]') as HTMLInputElement).click();
    $('[data-testid="tel-perm-save"]').click();
    await settle();
    const body = last("PUT", "/admin/telephony/permissions")!.body;
    expect(body.permissions.outbound).toMatchObject({ countries: ["CZ"], maxConcurrentCalls: 8 });
    expect(body.permissions.log.keepRaw).toBe(false);
    expect(body.permissions.defaults).toEqual(DEFAULT_PERMISSIONS.defaults);
  });

  it("keeps a mirror of the server's defaults", () => {
    expect((window as any).M5TelConsole.DEFAULT_PERMISSIONS).toEqual(DEFAULT_PERMISSIONS);
  });
});

describe("routing rules", () => {
  it("lists the rules in priority order with what they match and do", async () => {
    await open("#/telephony/inbound");
    const rows = $$('[data-testid="tel-rules-inbound"] tr[data-rule]');
    expect(rows.map((r) => r.getAttribute("data-rule"))).toEqual(["in-office", "in-night"]);
    expect(rows[0].textContent).toContain("mon-fri 08:00–17:00 (Europe/Prague)");
    expect(rows[0].textContent).toContain("Main IVR");
    expect(rows[0].textContent).toContain("recorded");
    expect(rows[1].textContent).toContain("-+4209*");
    expect(rows[1].textContent).toContain("busy");
    await tab("outbound");
    expect($('[data-testid="tel-rules-outbound"]').textContent).toContain("SIP trunk Prague office via Twilio · caller ID +420212345678 “M5”");
  });

  it("validates the editor before it asks the server", async () => {
    await open("#/telephony/outbound");
    $('[data-testid="tel-rule-add-outbound"]').click();
    await settle();
    const editor = $('[data-testid="tel-rule-editor"]');
    const to = $('[data-testid="tel-rule-to-input"]') as HTMLInputElement;
    to.value = "777123456";
    press(to, "Enter");
    expect(editor.querySelector('[data-testid="tel-rule-to"] .tel-chip.is-invalid')).toBeTruthy();
    expect(editor.textContent).toContain("start with + and the country code");
    ($('[data-testid="tel-svc-sip"]') as HTMLInputElement).click();
    type($('[data-testid="tel-svc-cid-number"]') as HTMLInputElement, "12345");
    ($('[data-testid="tel-rule-target-tsa"]') as HTMLInputElement).click();
    $('[data-testid="tel-rule-save"]').click();
    await settle();
    const problems = $('[data-testid="tel-rule-problems"]').textContent!;
    expect(problems).toContain("Give the rule a name.");
    expect(problems).toContain("777123456");
    expect(problems).toContain("Choose the provider");
    expect(problems).toContain("Choose the SIP trunk.");
    expect(problems).toContain("Caller ID: E.164");
    expect(problems).toContain("Choose the application");
    expect(editor.querySelector('[data-field="label"]')!.classList.contains("is-invalid")).toBe(true);
    expect(editor.querySelector('[data-field="match.to"]')!.classList.contains("is-invalid")).toBe(true);
    expect(last("PUT", "/admin/telephony/rules/outbound")).toBeUndefined();

    // Fixed: the rule goes in at the end, priorities renumbered.
    type($('[data-testid="tel-rule-label"]') as HTMLInputElement, "Slovak numbers");
    ($('[data-testid="tel-rule-to"] .tel-chip__x') as HTMLElement).click();
    const to2 = $('[data-testid="tel-rule-to-input"]') as HTMLInputElement;
    to2.value = "+421*";
    press(to2, "Enter");
    ($('[data-testid="tel-svc-sip-provider"]') as HTMLSelectElement).value = "twilio";
    ($('[data-testid="tel-svc-trunk"]') as HTMLSelectElement).value = "prague1";
    type($('[data-testid="tel-svc-cid-number"]') as HTMLInputElement, "+420212345679");
    ($('[data-testid="tel-svc-cid-pres"]') as HTMLSelectElement).value = "restricted";
    ($('[data-testid="tel-rule-target-tsa-select"]') as HTMLSelectElement).value = "main-ivr";
    ($('[data-testid="tel-rule-src-console"]') as HTMLInputElement).click();
    $('[data-testid="tel-rule-save"]').click();
    await settle();
    const put = last("PUT", "/admin/telephony/rules/outbound")!.body.rules;
    expect(put.map((r: OutboundRule) => r.priority)).toEqual([10, 20]);
    expect(put[1]).toMatchObject({ label: "Slovak numbers", enabled: true, match: { to: ["+421*"], sources: ["console"], groups: [], hours: null }, service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420212345679", presentation: "restricted" } }, target: { kind: "tsa", tsa: "main-ivr" } });
    expect($('[data-testid="tel-rule-editor"]')).toBeNull();
    expect($$('[data-testid="tel-rules-outbound"] tr[data-rule]').length).toBe(2);
  });

  it("refuses a pass target inbound and checks the time window", () => {
    const { ruleProblems } = (window as any).M5TelConsole;
    const r = structuredClone(inbound[0]);
    r.target = { kind: "pass" };
    r.match.hours = { timezone: "Mars/Olympus", days: "weekdays", from: "8:00", to: "17:00" };
    const fields = ruleProblems(r, "inbound", {}).map((p: { field: string }) => p.field);
    expect(fields).toEqual(expect.arrayContaining(["target.kind", "match.hours.timezone", "match.hours.days", "match.hours.from"]));
  });

  it("reorders, switches, duplicates and deletes — each change saves the list", async () => {
    await open("#/telephony/inbound");
    ($('tr[data-rule="in-office"] [aria-label="Move down"]') as HTMLElement).click();
    await settle();
    expect(last("PUT", "/admin/telephony/rules/inbound")!.body.rules.map((r: InboundRule) => [r.id, r.priority])).toEqual([["in-night", 10], ["in-office", 20]]);
    expect($$('[data-testid="tel-rules-inbound"] tr[data-rule]').map((r) => r.getAttribute("data-rule"))).toEqual(["in-night", "in-office"]);

    // Alt+↑ on a focused row moves it back.
    press($('tr[data-rule="in-office"]'), "ArrowUp", { altKey: true });
    await settle();
    expect(last("PUT", "/admin/telephony/rules/inbound")!.body.rules.map((r: InboundRule) => r.id)).toEqual(["in-office", "in-night"]);

    ($('[data-testid="tel-rule-on-in-night"]') as HTMLInputElement).click();
    await settle();
    expect(last("PUT", "/admin/telephony/rules/inbound")!.body.rules.find((r: InboundRule) => r.id === "in-night").enabled).toBe(false);

    ($('tr[data-rule="in-office"] [aria-label="Duplicate"]') as HTMLElement).click();
    await settle();
    const dup = last("PUT", "/admin/telephony/rules/inbound")!.body.rules;
    expect(dup).toHaveLength(3);
    expect(dup[1]).toMatchObject({ label: "Office hours (copy)", enabled: false });

    ($('[data-testid="tel-rule-del-in-night"]') as HTMLElement).click();
    await settle();
    expect(last("PUT", "/admin/telephony/rules/inbound")!.body.rules.map((r: InboundRule) => r.id)).not.toContain("in-night");
  });

  it("shows the server's problems and keeps the list as it was", async () => {
    overrides = { "PUT /admin/telephony/rules/inbound": () => fail(400, { ok: false, message: "The rules were refused", problems: [{ rule: "in-night", message: "unknown provider" }] }) };
    await open("#/telephony/inbound");
    ($('tr[data-rule="in-office"] [aria-label="Move down"]') as HTMLElement).click();
    await settle();
    expect($$('[data-testid="tel-rules-inbound"] tr[data-rule]').map((r) => r.getAttribute("data-rule"))).toEqual(["in-office", "in-night"]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("unknown provider"), "err");
  });

  it("dry-runs a call: the rule, the reasons, the rendered logic — and marks the rule", async () => {
    await open("#/telephony/inbound");
    type($('[data-testid="tel-dryrun-to-inbound"]') as HTMLInputElement, "+420212999999");
    type($('[data-testid="tel-dryrun-from-inbound"]') as HTMLInputElement, "+420777123456");
    $('[data-testid="tel-dryrun-run-inbound"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/rules/test")!.body).toMatchObject({ direction: "inbound", to: "+420212999999", from: "+420777123456" });
    const out = $('[data-testid="tel-decision"]').textContent!;
    expect(out).toContain("Night");
    expect(out).toContain("outside mon-fri 08:00–17:00");
    expect($('[data-testid="tel-rendered"]').textContent).toContain("<Reject reason=\"busy\"/>");
    expect($('tr[data-rule="in-night"]').classList.contains("is-match")).toBe(true);
  });

  it("opens a rule from a deep link", async () => {
    await open("#/telephony/outbound/out-cz");
    await settle();
    expect(($('[data-testid="tel-rule-label"]') as HTMLInputElement).value).toBe("Czech numbers via the trunk");
    expect(($('[data-testid="tel-svc-trunk"]') as HTMLSelectElement).value).toBe("prague1");
  });

  it("is read-only without the routing right", async () => {
    rights = ["settings", "test"];
    await open("#/telephony/inbound");
    expect(($('[data-testid="tel-rule-add-inbound"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-testid="tel-rule-add-inbound"]').getAttribute("data-gated")).toBe("routing");
    expect(($('[data-testid="tel-rule-on-in-office"]') as HTMLInputElement).disabled).toBe(true);
    expect($('tr[data-rule="in-office"]').getAttribute("draggable")).toBeNull();
    // The dry run is reading: it stays.
    expect(($('[data-testid="tel-dryrun-run-inbound"]') as HTMLButtonElement).disabled).toBe(false);
    $('[data-testid="tel-rule-edit-in-office"]').click();
    await settle();
    expect(($('[data-testid="tel-rule-label"]') as HTMLInputElement).disabled).toBe(true);
    expect($('[data-testid="tel-rule-save"]')).toBeNull();
  });
});

describe("applications", () => {
  it("lists the TSAs with the rules that use them, and opens the editor", async () => {
    await open("#/telephony/apps");
    const row = $('tr[data-tsa="main-ivr"]');
    expect(row.textContent).toContain("published v3");
    expect(row.textContent).toContain("Office hours");
    expect(($('[data-testid="tel-tsa-del-main-ivr"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('tr[data-tsa="voicemail"]').textContent).toContain("draft only");
    $('[data-testid="tel-tsa-open-main-ivr"]').click();
    await settle();
    expect((window as any).M5TsaEditor.open).toHaveBeenCalledWith("main-ivr", expect.objectContaining({ onClose: expect.any(Function) }));
    $('[data-testid="tel-tsa-publish-voicemail"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/tsa/voicemail/publish")).toBeTruthy();
  });

  it("creates one from a template", async () => {
    await open("#/telephony/apps");
    $('[data-testid="tel-tsa-new"]').click();
    await settle();
    type($('[data-testid="tel-tsa-name"]') as HTMLInputElement, "Opening hours");
    ($('[data-testid="tel-tsa-tpl-opening-hours"]') as HTMLInputElement).click();
    $('[data-testid="tel-tsa-create"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/tsa")!.body).toEqual({ id: "opening-hours", name: "Opening hours", description: "", template: "opening-hours" });
    expect((window as any).M5TsaEditor.open).toHaveBeenCalledWith("opening-hours", expect.anything());
  });

  it("says when the editor is not loaded", async () => {
    delete (window as any).M5TsaEditor;
    const append = vi.spyOn(document.head, "append").mockImplementation((...nodes: Array<Node | string>) => {
      for (const n of nodes) if (n instanceof HTMLScriptElement) setTimeout(() => n.onerror?.(new Event("error")), 0);
    });
    try {
      await open("#/telephony/apps");
      expect($('[data-testid="tel-editor-missing"]').hidden).toBe(false);
      $('[data-testid="tel-tsa-open-main-ivr"]').click();
      await settle();
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("not loaded"), "err");
    } finally { append.mockRestore(); }
  });
});

describe("route codes, trunks, tests, calls", () => {
  it("counts route codes down and adds one", async () => {
    await open("#/telephony/codes");
    const left = $('tr[data-code="4821"] [data-tel-expires]');
    expect(left.textContent).toMatch(/^(8|9) min/);
    expect($('tr[data-code="4821"]').textContent).toContain("1 / ∞");
    type($('[data-testid="tel-code-room"]') as HTMLInputElement, "r3.room");
    type($('[data-testid="tel-code-code"]') as HTMLInputElement, "12");
    $('[data-testid="tel-code-add"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/inroute")).toBeUndefined();
    type($('[data-testid="tel-code-code"]') as HTMLInputElement, "1234");
    $('[data-testid="tel-code-add"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/inroute")!.body).toEqual({ type: "room", room: "r3.room", ttl: 600, code: "1234" });
  });

  it("edits a trunk keeping the stored password, and checks a DID", async () => {
    await open("#/telephony/trunks");
    expect($('tr[data-trunk="prague1"]').textContent).toContain("password set");
    expect($('tr[data-trunk="prague1"]').textContent).toContain("Czech numbers via the trunk");
    byText('tr[data-trunk="prague1"] button', "Edit").click();
    await settle();
    type($('[data-testid="tel-trunk-label"]') as HTMLInputElement, "Prague 1");
    $('[data-testid="tel-trunk-save"]').click();
    await settle();
    const body = last("PUT", "/admin/telephony/sip/trunks")!.body;
    expect(body).toMatchObject({ id: "prague1", label: "Prague 1", didNumbers: ["+420212345678"] });
    expect("password" in body).toBe(false);
    await settle();
    type($('[data-testid="tel-did-input"]') as HTMLInputElement, "+420212345678");
    $('[data-testid="tel-did-check"]').click();
    await settle();
    expect($('[data-testid="tel-did-out"]').textContent).toContain("Prague office");
    expect($('[data-testid="tel-did-out"]').textContent).toContain("Night");
  });

  it("runs the tests: room voice gives a code and the number; the SIP address can be copied", async () => {
    await open("#/telephony/tests");
    type($('[data-testid="tel-rv-room"]') as HTMLInputElement, "r3.abc");
    $('[data-testid="tel-rv-run"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/tests/room-voice")!.body).toEqual({ room: "r3.abc", type: "room", ttl: 600 });
    expect($('[data-testid="tel-rv-code"]').textContent).toBe("7310");
    expect($('[data-testid="tel-rv-out"]').textContent).toContain("Dial +420800100200");
    expect($('[data-testid="tel-sip-uri"]').textContent).toBe("sip:test-abc123@m5.sip.twilio.com");

    type($('[data-testid="tel-call-to"]') as HTMLInputElement, "+420777123456");
    $('[data-testid="tel-call-run"]').click();
    await settle();
    expect(last("POST", "/admin/telephony/tests/call")!.body).toEqual({ to: "+420777123456", say: "This is a test call from M5cet. Goodbye." });
  });

  it("shows the calls and opens one", async () => {
    await open("#/telephony/calls/call-77");
    await settle();
    expect($('[data-testid="tel-call-table"]').textContent).toContain("+420777123456 → +420212345678");
    expect($('[data-testid="tel-call-drawer"]').textContent).toContain("CA123");
  });
});

describe("the log", () => {
  it("filters, and a click opens the full entry: parsed data as a tree, the raw payload", async () => {
    await open("#/telephony/log");
    const rows = $$('[data-testid="tel-log-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("voice webhook: call ringing");
    expect(rows[0].textContent).toContain("POST 200 · 12 ms");

    ($('[data-testid="tel-log-kind"]') as HTMLSelectElement).value = "webhook";
    $('[data-testid="tel-log-kind"]').dispatchEvent(new Event("change"));
    await settle();
    expect(calls.filter((c) => c.path.startsWith("/admin/telephony/log?")).pop()!.path).toContain("kind=webhook");

    $('[data-testid="tel-log-table"] tbody tr[data-id="ev-1"]').click();
    await settle();
    expect(location.hash).toBe("#/telephony/log/ev-1");
    const d = $('[data-testid="tel-log-drawer"]');
    expect(d.textContent).toContain("signature verified");
    expect(d.textContent).toContain("POST /wh/twilio/voice → 200 · 12 ms");
    const parsed = $('[data-testid="tel-log-parsed"]');
    expect(parsed.querySelector(".tel-json")).toBeTruthy();
    expect(parsed.textContent).toContain("nested");
    expect(parsed.textContent).toContain("\"1#\"");
    expect([...parsed.querySelectorAll(".tel-json__key")].map((k) => k.textContent)).toEqual(expect.arrayContaining(["kind: ", "digits: ", "list: "]));
    expect($('[data-testid="tel-log-raw"]').textContent).toContain("CA123");
    byText('[data-testid="tel-log-parsed"] button', "Collapse all").click();
    expect([...parsed.querySelectorAll("details")].every((x) => !(x as HTMLDetailsElement).open)).toBe(true);
    // Escape closes it and the address forgets the entry.
    press(document, "Escape");
    expect($('[data-testid="tel-log-drawer"]')).toBeNull();
    expect(location.hash).toBe("#/telephony/log");
  });

  it("opens an entry from a deep link; without the log right it shows the summary", async () => {
    overrides = { "GET /admin/telephony/log/:id": () => fail(403, { ok: false, message: "no log right" }) };
    await open("#/telephony/log/ev-1");
    await settle();
    const d = $('[data-testid="tel-log-drawer"]');
    expect(d.textContent).toContain("the log right");
    expect(d.textContent).toContain("voice webhook: call ringing");
    expect($('[data-testid="tel-log-parsed"]')).toBeNull();
  });
});

describe("number patterns", () => {
  it("accepts the contract's forms and explains the rest", () => {
    const { patternProblem } = (window as any).M5TelConsole;
    for (const ok of ["+420123456789", "+4202*", "*", "sip:*@example.com", "-+1900*", "+*"]) expect(patternProblem(ok), ok).toBeNull();
    for (const bad of ["420123", "+42", "abc", "-", "sip:<x>@y"]) expect(patternProblem(bad), bad).not.toBeNull();
  });
});

describe("a restored session opening a deep link", () => {
  it("draws the page when the console routes to it while the script is still loading", async () => {
    // console.js's addRoute() runs the loader at once when the address already names the page.
    const errors: unknown[] = [];
    const prev = (window as any).M5Console;
    (window as any).M5Console = { ...prev, addRoute: (name: string, entry: [string, string, () => Promise<void>]) => { if (name === "telephony" && location.hash.startsWith("#/telephony")) entry[2]().catch((e) => errors.push(e)); } };
    history.replaceState(null, "", "#/telephony/codes");
    try {
      expect(() => new Function(SOURCE)()).not.toThrow();
      await settle();
      expect(errors).toEqual([]);
      expect($('[data-testid="tel-codes-view"]')).toBeTruthy();
    } finally { (window as any).M5Console = prev; }
  });
});

describe("markup safety and wiring", () => {
  it("builds DOM nodes only — no markup sinks, no inline handlers, nothing from elsewhere", () => {
    const code = SOURCE.replace(/\/\/.*$/gm, "");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) expect(code.includes(sink), sink).toBe(false);
    expect(code).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it("is wired into the console in place of the legacy section", () => {
    const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
    const section = /<section data-panel="telephony"[^>]*>[\s\S]*?<\/section>/.exec(html)![0];
    expect(section).toContain('id="telRoot"');
    expect(section).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('<script src="telephony-console.js"></script>');
    expect(html).toContain('href="telephony-console.css"');
    expect(html).not.toContain("legacy-tools.js");
    expect(html).not.toContain("telephony-sdk.js");
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });
});
