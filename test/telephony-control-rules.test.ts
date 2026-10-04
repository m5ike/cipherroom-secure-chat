// @vitest-environment node
//
// The routing rules engine (6.9, server/telephony/control/rules.ts +
// match.ts): number patterns (exact, prefix, "*", SIP URI globs, "-"
// exclusions that always win), weekly time windows in IANA zones (lists,
// ranges that wrap, overnight), the order of the rules, the defaults from
// the permissions, the module's own outbound limits (blocked numbers,
// countries) — and the human reasons the console's dry run shows.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5rules-"));
process.env.TELEPHONY_DATA_FILE = join(dir, "telephony.json");

const { patternMatches, patternProblem, listMatches, parseDays, parseTime, inWindow, windowProblem, numberDigits } = await import("../server/telephony/control/match");
const { decideWith, permissionRefusal, targetText } = await import("../server/telephony/control/rules");
const { DEFAULT_PERMISSIONS } = await import("../server/telephony/control/types");
type InboundRule = import("../server/telephony/control/types").InboundRule;
type OutboundRule = import("../server/telephony/control/types").OutboundRule;
type TelPermissions = import("../server/telephony/control/types").TelPermissions;

const inbound = (id: string, priority: number, match: Partial<InboundRule["match"]>, target: InboundRule["target"], extra: Partial<InboundRule> = {}): InboundRule => ({
  id, label: id, enabled: true, priority, match: { numbers: [], from: [], provider: "", service: "", hours: null, ...match }, target, record: false, note: "", ...extra,
});
const outbound = (id: string, priority: number, match: Partial<OutboundRule["match"]>, service: OutboundRule["service"], target: OutboundRule["target"], extra: Partial<OutboundRule> = {}): OutboundRule => ({
  id, label: id, enabled: true, priority, match: { to: [], groups: [], sources: [], hours: null, ...match }, service, target, note: "", ...extra,
});
const perms = (patch: Partial<TelPermissions["outbound"]> = {}, defaults?: Partial<TelPermissions["defaults"]>): TelPermissions => ({
  ...DEFAULT_PERMISSIONS, outbound: { ...DEFAULT_PERMISSIONS.outbound, ...patch }, defaults: { ...DEFAULT_PERMISSIONS.defaults, ...defaults },
});
/** 2026-10-05 (a Monday) at hh:mm UTC. */
const mondayUtc = (hh: number, mm = 0) => Date.UTC(2026, 9, 5, hh, mm);

describe("number patterns", () => {
  it("exact numbers, prefixes and * — tolerant of +, 00, spaces and dashes in the value", () => {
    expect(patternMatches("+420603123456", "+420 603-123 456")).toBe(true);
    expect(patternMatches("+420603123456", "00420603123456")).toBe(true);
    expect(patternMatches("+420603123456", "420603123456")).toBe(true); // Vonage sends digits only
    expect(patternMatches("+420603123456", "+420603123457")).toBe(false);
    expect(patternMatches("+4206*", "+420603123456")).toBe(true);
    expect(patternMatches("+4207*", "+420603123456")).toBe(false);
    expect(patternMatches("*", "")).toBe(true); // a withheld caller is "anything"
    expect(patternMatches("+420*", "")).toBe(false);
    expect(numberDigits("+1 (415) 555-0100")).toBe("14155550100");
  });

  it("SIP URI globs; a number pattern matches a SIP URI's user part", () => {
    expect(patternMatches("sip:*@pbx.example.com", "sip:alice@PBX.example.com")).toBe(true);
    expect(patternMatches("sip:*@pbx.example.com", "sip:alice@evil.example.com")).toBe(false);
    expect(patternMatches("sip:desk-??@pbx.example.com", "sip:desk-07@pbx.example.com")).toBe(true);
    expect(patternMatches("+4202*", "sip:+420222111000@trunk.example.com;transport=tls")).toBe(true);
    expect(patternMatches("+4202*", "sip:alice@trunk.example.com")).toBe(false);
  });

  it("a list: [] is anything, a '-' exclusion always wins, else one positive must match — with the reason", () => {
    expect(listMatches([], "+420603123456").ok).toBe(true);
    expect(listMatches(["-+1900*"], "+420603123456").ok).toBe(true);
    const deny = listMatches(["*", "-+1900*"], "+19005550100", "the destination");
    expect(deny).toEqual({ ok: false, why: "the destination +19005550100 is excluded by -+1900*" });
    const miss = listMatches(["+420*", "+421*"], "+4930123456", "the caller");
    expect(miss.ok).toBe(false);
    expect(miss.why).toBe("the caller +4930123456 is not in [+420*, +421*]");
    expect(listMatches([], "", "the caller").ok).toBe(true);
    expect(listMatches(["+420*"], "", "the caller").why).toContain("(withheld)");
  });

  it("refuses what is neither a number pattern nor a SIP URI", () => {
    expect(patternProblem("+420*")).toBeNull();
    expect(patternProblem("-+1900*")).toBeNull();
    expect(patternProblem("sip:*@example.com")).toBeNull();
    expect(patternProblem("*")).toBeNull();
    expect(patternProblem("")).toMatch(/empty/);
    expect(patternProblem("+42*0")).toMatch(/neither/);
    expect(patternProblem("http://example.com")).toMatch(/neither/);
    expect(patternProblem("sip:<script>@x")).toMatch(/neither/);
    expect(patternProblem(42)).toMatch(/text/);
  });
});

describe("time windows", () => {
  it("parses day lists, ranges that wrap, names and times", () => {
    expect([...parseDays("mon-fri")!]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseDays("fri-mon")!].sort()).toEqual([0, 1, 5, 6]);
    expect([...parseDays("sat, sun")!].sort()).toEqual([0, 6]);
    expect([...parseDays("Monday,wednesday")!].sort()).toEqual([1, 3]);
    expect(parseDays("*")!.size).toBe(7);
    expect(parseDays("weekend")!.has(6)).toBe(true);
    expect(parseDays("someday")).toBeNull();
    expect(parseTime("08:30")).toBe(510);
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("24:00", true)).toBe(1440);
    expect(parseTime("8:61")).toBeNull();
    expect(windowProblem({ timezone: "Mars/Olympus", days: "*", from: "08:00", to: "17:00" })).toMatch(/time zone/);
    expect(windowProblem({ timezone: "Europe/Prague", days: "*", from: "8", to: "17:00" })).toMatch(/from/);
  });

  it("an office window in Prague: inside / outside by the local time (DST: UTC+2 in October)", () => {
    const w = { timezone: "Europe/Prague", days: "mon-fri", from: "08:00", to: "17:00" };
    expect(inWindow(w, mondayUtc(6, 30))).toMatchObject({ ok: true }); // 08:30 in Prague
    const early = inWindow(w, mondayUtc(5, 59)); // 07:59
    expect(early.ok).toBe(false);
    expect(early.why).toBe("outside mon-fri 08:00-17:00 Europe/Prague (it is mon 07:59 there)");
    expect(inWindow(w, mondayUtc(15, 0)).ok).toBe(false); // 17:00 — the end is exclusive
    expect(inWindow(w, Date.UTC(2026, 9, 4, 10, 0)).ok).toBe(false); // Sunday
  });

  it("overnight windows belong to the day they start; from = to is the whole day", () => {
    const night = { timezone: "UTC", days: "fri", from: "22:00", to: "06:00" };
    expect(inWindow(night, Date.UTC(2026, 9, 9, 23, 0)).ok).toBe(true); // Friday 23:00
    expect(inWindow(night, Date.UTC(2026, 9, 10, 5, 0)).ok).toBe(true); // Saturday 05:00 (Friday's night)
    expect(inWindow(night, Date.UTC(2026, 9, 10, 23, 0)).ok).toBe(false); // Saturday 23:00
    expect(inWindow(night, Date.UTC(2026, 9, 9, 5, 0)).ok).toBe(false); // Friday 05:00 (Thursday's night)
    expect(inWindow({ timezone: "UTC", days: "mon", from: "00:00", to: "00:00" }, mondayUtc(13)).ok).toBe(true);
    expect(inWindow({ timezone: "America/New_York", days: "sun", from: "00:00", to: "24:00" }, mondayUtc(3)).ok).toBe(true); // Sunday 23:00 in New York
  });
});

describe("inbound decisions", () => {
  const rules = [
    inbound("closed", 30, { numbers: ["+420222111000"] }, { kind: "state", state: "busy" }),
    inbound("office", 20, { numbers: ["+420222111000"], hours: { timezone: "Europe/Prague", days: "mon-fri", from: "08:00", to: "17:00" } }, { kind: "tsa", tsa: "office-ivr" }, { record: true }),
    inbound("vip", 10, { numbers: ["+420222111000"], from: ["+420777*", "-+420777000000"] }, { kind: "tsa", tsa: "vip-line" }),
    inbound("off", 5, { numbers: ["*"] }, { kind: "state", state: "hangup" }, { enabled: false }),
    inbound("sip-only", 40, { numbers: ["*"], service: "sip", provider: "telnyx" }, { kind: "tsa", tsa: "sip-desk" }),
  ];
  const set = { inbound: rules, outbound: [], permissions: perms() };

  it("rules run by priority; each skipped one says why; the matched one says where", () => {
    const d = decideWith({ direction: "inbound", from: "+420777123456", to: "+420222111000", at: mondayUtc(20) }, set);
    expect(d).toMatchObject({ direction: "inbound", rule: "vip", target: { kind: "tsa", tsa: "vip-line" } });
    expect(d.reasons).toEqual(['#5 "off" — skipped: disabled', '#10 "vip" — matched → TSA vip-line']);
  });

  it("an excluded caller falls through; the window decides the office rule", () => {
    const night = decideWith({ direction: "inbound", from: "+420777000000", to: "+420222111000", at: mondayUtc(20) }, set);
    expect(night.rule).toBe("closed");
    expect(night.reasons[1]).toBe('#10 "vip" — skipped: the caller +420777000000 is excluded by -+420777000000');
    expect(night.reasons[2]).toMatch(/^#20 "office" — skipped: outside mon-fri 08:00-17:00 Europe\/Prague/);
    const day = decideWith({ direction: "inbound", from: "+420608000000", to: "+420222111000", at: mondayUtc(9) }, set);
    expect(day).toMatchObject({ rule: "office", target: { kind: "tsa", tsa: "office-ivr" } });
    expect(day.reasons.at(-1)).toContain("(recorded)");
  });

  it("provider and service must be the rule's; nothing matched → the default from the permissions", () => {
    const viaApp = decideWith({ direction: "inbound", from: "+15550000", to: "+15551111", provider: "telnyx", service: "app" }, set);
    expect(viaApp).toMatchObject({ rule: null, ruleLabel: "default", target: { kind: "state", state: "busy" } });
    expect(viaApp.reasons.at(-2)).toBe('#40 "sip-only" — skipped: the service is app, the rule wants a SIP trunk');
    expect(viaApp.reasons.at(-1)).toBe("no rule matched → the default: state busy");
    expect(decideWith({ direction: "inbound", from: "+15550000", to: "+15551111", provider: "telnyx", service: "sip" }, set).rule).toBe("sip-only");
    expect(decideWith({ direction: "inbound", from: "+15550000", to: "+15551111", provider: "twilio", service: "sip" }, set).reasons.at(-2)).toContain("the provider is twilio, the rule wants telnyx");
    const empty = decideWith({ direction: "inbound", from: "", to: "+1" }, { inbound: [], outbound: [], permissions: perms({}, { inbound: { kind: "tsa", tsa: "fallback" } }) });
    expect(empty).toMatchObject({ target: { kind: "tsa", tsa: "fallback" }, reasons: ["no inbound rules → the default: TSA fallback"] });
  });
});

describe("outbound decisions", () => {
  const sip: OutboundRule["service"] = { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420222111000", name: "M5cet", presentation: "allowed" } };
  const rules = [
    outbound("intl", 30, { to: ["*"] }, { kind: "app", provider: "telnyx" }, { kind: "pass" }),
    outbound("cz-trunk", 10, { to: ["+420*"], groups: ["sales"] }, sip, { kind: "pass" }),
    outbound("survey", 20, { to: ["+421*"], sources: ["tsa", "console"] }, { kind: "app", provider: "vonage" }, { kind: "tsa", tsa: "survey" }),
    outbound("no-premium", 5, { to: ["+420900*"] }, { kind: "app", provider: "twilio" }, { kind: "state", state: "rejected" }),
  ];
  const set = { inbound: [], outbound: rules, permissions: perms() };

  it("groups, sources and destinations select the service and the target", () => {
    const sales = decideWith({ direction: "outbound", from: "", to: "+420603123456", groups: ["user", "sales"], source: "function" }, set);
    expect(sales).toMatchObject({ rule: "cz-trunk", service: sip, target: { kind: "pass" } });
    expect(sales.reasons.at(-1)).toBe('#10 "cz-trunk" — matched → pass (the caller\'s own call logic) through SIP trunk prague1 via twilio, caller ID +420222111000 "M5cet"');
    const other = decideWith({ direction: "outbound", from: "", to: "+420603123456", groups: ["user"], source: "function" }, set);
    expect(other.rule).toBe("intl");
    expect(other.reasons[1]).toBe('#10 "cz-trunk" — skipped: the caller is not in sales (their groups: user)');
    const survey = decideWith({ direction: "outbound", from: "", to: "+421903123456", source: "tsa" }, set);
    expect(survey).toMatchObject({ rule: "survey", target: { kind: "tsa", tsa: "survey" }, service: { kind: "app", provider: "vonage" } });
    expect(decideWith({ direction: "outbound", from: "", to: "+421903123456", source: "api" }, set).reasons[2]).toBe('#20 "survey" — skipped: the call comes from api, the rule takes tsa, console');
  });

  it("a rule's state refuses; no rule → the default (pass, or a state)", () => {
    expect(decideWith({ direction: "outbound", from: "", to: "+420900123456" }, set)).toMatchObject({ rule: "no-premium", target: { kind: "state", state: "rejected" } });
    const none = decideWith({ direction: "outbound", from: "", to: "+4930123456" }, { inbound: [], outbound: [], permissions: perms() });
    expect(none).toMatchObject({ rule: null, ruleLabel: "default", service: null, target: { kind: "pass" } });
    expect(none.reasons).toEqual(["no outbound rules → the default: pass (the caller's own call logic) through the default provider"]);
    const closed = decideWith({ direction: "outbound", from: "", to: "+4930123456" }, { inbound: [], outbound: [], permissions: perms({}, { outbound: { kind: "state", state: "congestion" } }) });
    expect(closed.target).toEqual({ kind: "state", state: "congestion" });
  });

  it("the module's blocked numbers and countries come before any rule", () => {
    const blocked = decideWith({ direction: "outbound", from: "", to: "+19005550100" }, set);
    expect(blocked).toMatchObject({ rule: null, ruleLabel: "permissions", target: { kind: "state", state: "rejected" } });
    expect(blocked.reasons[0]).toContain("is blocked (Telephony › Permissions: +1900*)");
    const czOnly = perms({ countries: ["CZ", "SK"] });
    expect(permissionRefusal("+420603123456", czOnly)).toBeNull();
    expect(permissionRefusal("+421903123456", czOnly)).toBeNull();
    expect(permissionRefusal("+4930123456", czOnly)).toMatch(/only to CZ, SK — \+4930123456 is in DE/);
    expect(permissionRefusal("+881612345678", perms({ countries: ["CZ"], blocked: [] }))).toMatch(/only to CZ — \+881612345678 is in 001/);
    expect(targetText({ kind: "state", state: "busy" })).toBe("state busy");
  });

  it("6.10 (G-06): countries — empty = any, but for a TSA (own given) only your own; * = any for everyone", () => {
    const any = perms({ countries: [] });
    expect(permissionRefusal("+4930123456", any)).toBeNull();
    expect(permissionRefusal("+4930123456", any, ["CZ"])).toMatch(/an application \(TSA\) may call and text only your own countries \(CZ\).*\+4930123456 is in DE/);
    expect(permissionRefusal("+420603123456", any, ["CZ"])).toBeNull();
    // Nothing to derive them from: refused, with what to set.
    expect(permissionRefusal("+420603123456", any, [])).toMatch(/no number of yours tells which.*Countries \(\* = any\)/);
    const star = perms({ countries: ["*"] });
    expect(permissionRefusal("+4930123456", star, ["CZ"])).toBeNull();
    expect(permissionRefusal("+19005550100", star, ["CZ"])).toMatch(/is blocked/);
    // An explicit list is the list, for a TSA too.
    expect(permissionRefusal("+4930123456", perms({ countries: ["DE"] }), ["CZ"])).toBeNull();
    // A SIP URI has no country.
    expect(permissionRefusal("sip:alice@pbx.example.com", any, [])).toBeNull();
  });
});
