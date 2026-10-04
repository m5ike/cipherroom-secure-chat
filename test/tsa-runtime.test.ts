// @vitest-environment node
//
// The TSA runtime (6.9) on a fake call: every tool, loops (for / while /
// break / a body path that ends), a Condition with N inputs, Switch cases,
// Read DTMF retries and timeout, Route audio (code error / failed / success
// through stub hooks), the limits (a runaway cycle), persistence across
// resume (the session is reloaded from telephony.db), the simulator and the
// store (publish refuses errors, versions).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5tsa-"));
Object.assign(process.env, { DATA_DIR: dir, TELEPHONY_DB_FILE: join(dir, "telephony.db"), PUBLIC_BASE_URL: "https://chat.test", TSA_SECRET_CRM: "s3cret" });

const { telHooks } = await import("../server/telephony/control/hooks");
const { DEFAULT_PERMISSIONS } = await import("../server/telephony/control/types");
const { tsaStore, TsaStoreError } = await import("../server/telephony/tsa/store");
const { startTsa, resumeTsa, isOpen, globMatch } = await import("../server/telephony/tsa/runtime");
const { tsaDb } = await import("../server/telephony/tsa/db");
const { setTsaDeps, resetTsaDeps } = await import("../server/telephony/tsa/deps");
const { defaultParams } = await import("../server/telephony/tsa/catalog");
const { simStart, simEvent, simGet } = await import("../server/telephony/tsa/simulator");
const { addAudioFile } = await import("../server/telephony/tsa/files");
const { hashRoom } = await import("../server/monitor/traffic");
const realInroute = await import("../server/telephony/control/inroute");
const { permissionRefusal } = await import("../server/telephony/control/rules");
const { wavEncode, tone } = await import("../server/telephony/audio");
import type { CallAction } from "../server/telephony/providers/types";
import type { TsaEdge, TsaGraph, TsaNode, TsaNodeType } from "../server/telephony/tsa/types";
import type { InrouteEntry, TelLogEntry, TelPermissions } from "../server/telephony/control/types";

/* ---------------------------------------------------------------- fakes */

const WAV = wavEncode(tone(440, 100, 16_000), 16_000);
const sent: Record<string, unknown[]> = { sms: [], notice: [], http: [], fn: [], steer: [], tts: [], stt: [], outbound: [] };
const logs: Array<Partial<TelLogEntry>> = [];
let clock = Date.UTC(2026, 9, 5, 7, 30); // Monday 09:30 in Prague
let permissions: TelPermissions = structuredClone(DEFAULT_PERMISSIONS);
const inroute = new Map<string, InrouteEntry>();
let routeResult: "ok" | "failed" | "code" = "ok";

function deps() {
  setTsaDeps({
    now: () => clock,
    random: () => 0.25,
    tts: async (i) => { sent.tts.push(i); return { audio: WAV, mime: "audio/wav" }; },
    stt: async (i) => { sent.stt.push(i); return "chci mluvit s podporou"; },
    fetchRecording: async (_p, url, o) => { if (url.startsWith("data:") && !o.allowData) throw new Error("no data"); return { bytes: WAV, mime: "audio/wav" }; },
    sendSms: async (i) => { sent.sms.push(i); return { id: "tm_1", status: "queued" }; },
    notice: (hash, n, target) => { sent.notice.push({ hash, n, target }); return 2; },
    http: async (spec) => { sent.http.push(spec); return { status: 200, text: "{\"customer\":{\"name\":\"Eva\"}}", json: { customer: { name: "Eva" } } }; },
    runFunction: async (model, inputs) => { sent.fn.push({ model, inputs }); return { answer: 42 }; },
    steer: async (callId, actions) => { sent.steer.push({ callId, actions }); },
    trunk: async (id, withSecret) => (id === "prague1" ? { id, host: "sip.example.com", username: "user", ...(withSecret ? { password: "pw-secret" } : {}) } : null),
    // 6.10 (G-06): planOutbound's part, over these permissions and the stub rules (control/enforce.ts has its own tests).
    outbound: async (ask) => {
      sent.outbound.push(ask);
      const own = permissions.outbound.countries.length ? undefined : ["CZ"];
      const why = permissionRefusal(ask.to, permissions, own);
      if (why) return { ok: false, code: "route-refused", message: why };
      const timeLimitSec = Math.min(permissions.outbound.maxMinutes * 60, ask.timeLimitSec ?? Infinity);
      if (ask.kind === "sms") return { ok: true, timeLimitSec, rule: "", ruleLabel: "", provider: "" };
      const dec = await telHooks.decide!({ direction: "outbound", from: "", to: ask.to, source: "tsa" });
      if (dec.target.kind === "state") return { ok: false, code: "route-refused", message: `the outbound rule "${dec.ruleLabel}" refuses it (${dec.target.state})` };
      const sip = dec.service?.kind === "sip" ? dec.service : null;
      return {
        ok: true, timeLimitSec, rule: dec.rule ?? "", ruleLabel: dec.ruleLabel, provider: dec.service?.provider ?? "",
        ...(sip ? { trunk: { id: "prague1", host: "sip.example.com", username: "user", password: "pw-secret" }, callerId: sip.callerId.number, callerName: sip.callerId.name, presentation: sip.callerId.presentation } : {}),
      };
    },
  });
}

function hooks() {
  telHooks.log = (e) => { logs.push(e); };
  telHooks.permissions = () => permissions;
  telHooks.inroute = {
    lookup: async (code) => inroute.get(code) ?? null,
    used: async (code) => { const e = inroute.get(code); if (e) e.uses += 1; },
    add: async (spec) => {
      const code = spec.code ?? "654321";
      const e: InrouteEntry = { code, type: spec.type, room: spec.room, user: spec.user ?? "", label: spec.label ?? "", ttlSec: spec.ttl ?? 600, createdAt: clock, expiresAt: clock + (spec.ttl ?? 600) * 1000, createdBy: spec.createdBy, uses: 0, maxUses: spec.maxUses ?? 0 };
      inroute.set(code, e);
      return e;
    },
  };
  telHooks.routeAudio = async (_call, entry, opts) => {
    if (routeResult === "ok") return { ok: true, detail: `to ${entry.room}`, actions: [...(opts.announce ? [{ say: { text: opts.announce } }] : []), { stream: { url: "wss://chat.test/media/tel/x" } }] as CallAction[] };
    return { ok: false, reason: routeResult, detail: routeResult === "code" ? "refused" : "nobody connected" };
  };
  telHooks.decide = async (q) => ({
    direction: "outbound", rule: "r1", ruleLabel: "Trunk to CZ", reasons: [],
    service: q.to.startsWith("+420") ? { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420222000111", name: "M5cet", presentation: "allowed" } } : { kind: "app", provider: "twilio" },
    target: q.to.startsWith("+1900") ? { kind: "state", state: "rejected" } : { kind: "pass" },
  });
}

/* -------------------------------------------------------------- builders */

class G {
  nodes: TsaNode[] = [];
  edges: TsaEdge[] = [];
  private n = 0;
  node(id: string, type: TsaNodeType, params: Record<string, unknown> = {}, extra: Partial<TsaNode> = {}) {
    this.nodes.push({ id, type, x: 0, y: 0, ...extra, params: { ...defaultParams(type), ...params } });
    return this;
  }
  flow(from: string, port: string, to: string) { this.edges.push({ id: `e${++this.n}`, from: { node: from, port }, to: { node: to, port: "in" }, kind: "flow" }); return this; }
  data(from: string, port: string, to: string, toPort: string) { this.edges.push({ id: `d${++this.n}`, from: { node: from, port }, to: { node: to, port: toPort }, kind: "data" }); return this; }
  graph(): TsaGraph { return { nodes: this.nodes, edges: this.edges }; }
}

let tsaSeq = 0;
function tsa(g: G, publish = false): string {
  const id = `t${++tsaSeq}-test`;
  tsaStore.create({ id, name: id }, "test");
  tsaStore.saveDraft(id, { graph: g.graph() }, "test");
  if (publish) tsaStore.publish(id, "test");
  return id;
}

let callSeq = 0;
const call = (over: Partial<Parameters<typeof startTsa>[0]> = {}) => ({ id: `tc_${++callSeq}`, token: `tok${"x".repeat(20)}${callSeq}`, provider: "twilio", direction: "inbound" as const, from: "+420603123456", to: "+420222333444", did: "+420222333444", ...over });
const run = (id: string, over: Partial<Parameters<typeof startTsa>[0]> = {}, opts: Parameters<typeof startTsa>[2] = { draft: true }) => startTsa(call(over), id, opts);
const kinds = (a: CallAction[]) => a.map((x) => Object.keys(x)[0]);

beforeAll(async () => { await tsaDb.ready(); });
beforeEach(() => {
  resetTsaDeps(); deps(); hooks();
  for (const k of Object.keys(sent)) sent[k] = [];
  logs.length = 0;
  permissions = structuredClone(DEFAULT_PERMISSIONS);
  inroute.clear();
  routeResult = "ok";
  clock = Date.UTC(2026, 9, 5, 7, 30);
});
afterAll(() => { tsaDb.reset(); rmSync(dir, { recursive: true, force: true }); });

/* ----------------------------------------------------------------- tests */

describe("TSA runtime: a menu", () => {
  const menu = () => new G()
    .node("start", "start", { language: "cs-CZ" })
    .node("hello", "tts", { text: "Stiskněte 1 nebo 2.", bargeIn: true }, { inputs: 0 })
    .node("menu", "read_dtmf", { maxDigits: 1, timeout: 4, retries: 2 })
    .node("choice", "switch", { cases: ["1", "2"] })
    .node("one", "tts", { text: "Jednička." }, { inputs: 0 })
    .node("two", "tts", { text: "Volba {IN1}, volající {call.from}." }, { inputs: 1 })
    .node("bye", "tts", { text: "Na shledanou." }, { inputs: 0 })
    .node("end", "hangup")
    .flow("start", "next", "hello").flow("hello", "next", "menu").flow("menu", "next", "choice").flow("menu", "on_timeout", "bye")
    .data("menu", "digits", "choice", "IN1").data("menu", "digits", "two", "IN1")
    .flow("choice", "case_1", "one").flow("choice", "case_2", "two").flow("choice", "default", "hello")
    .flow("one", "next", "end").flow("two", "next", "end").flow("bye", "next", "end");

  it("the greeting becomes the gather's prompt (a key stops it) and the call waits with a callback URL", async () => {
    const c = call();
    const t = await startTsa(c, tsa(menu()), { draft: true });
    expect(kinds(t.actions)).toEqual(["gather"]);
    const g = (t.actions[0] as Extract<CallAction, { gather: unknown }>).gather;
    expect(g).toMatchObject({ prompt: "Stiskněte 1 nebo 2.", language: "cs-CZ", digits: 1, timeout: 4, finishOnKey: "#", input: ["dtmf"] });
    expect(g.action).toBe(`https://chat.test/wh/tel/${c.token}/tsa?s=${t.session.id}&n=menu`);
    expect(t.session).toMatchObject({ status: "waiting", waiting: { node: "menu", for: "digits" }, at: "menu" });
    expect(t.session.values.start).toMatchObject({ from: "+420603123456", direction: "inbound" });
    expect(JSON.stringify(t.session)).not.toContain("tokxxx");
  });

  it("digits → the matching case; templates see the inputs and the call", async () => {
    const t = await run(tsa(menu()));
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "2#" });
    expect(r.actions).toEqual([{ say: { text: "Volba 2, volající +420603123456.", language: "cs-CZ" } }, { hangup: {} }]);
    expect(r.session.status).toBe("ended");
    expect(r.session.values.menu.digits).toBe("2");
  });

  it("no digit: asked again (retries), then on_timeout", async () => {
    const t = await run(tsa(menu()));
    const again1 = await resumeTsa(t.session.id, { kind: "digits", digits: "", timedOut: true });
    expect(again1.actions).toEqual(t.actions);
    const again2 = await resumeTsa(t.session.id, { kind: "digits", digits: "" });
    expect(kinds(again2.actions)).toEqual(["gather"]);
    const out = await resumeTsa(t.session.id, { kind: "digits", digits: "" });
    expect(out.actions).toEqual([{ say: { text: "Na shledanou.", language: "cs-CZ" } }, { hangup: {} }]);
  });

  it("an unknown choice repeats the menu (default → the greeting again)", async () => {
    const t = await run(tsa(menu()));
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "9" });
    expect(kinds(r.actions)).toEqual(["gather"]);
    expect(r.session.waiting).toMatchObject({ node: "menu", for: "digits" });
  });

  it("a repeated or stale callback gets the same answer; a hangup ends the session", async () => {
    const t = await run(tsa(menu()));
    const dup = await resumeTsa(t.session.id, { kind: "played" });
    expect(dup.actions).toEqual(t.actions);
    const started = await resumeTsa(t.session.id, { kind: "started" });
    expect(started.actions).toEqual(t.actions);
    const gone = await resumeTsa(t.session.id, { kind: "hangup", cause: "normal_clearing" });
    expect(gone.actions).toEqual([]);
    expect(gone.session.status).toBe("ended");
    const after = await resumeTsa(t.session.id, { kind: "digits", digits: "1" });
    expect(after.actions).toEqual([{ hangup: {} }]);
  });

  it("the session survives a reload from telephony.db (the other process resumes it)", async () => {
    const t = await run(tsa(menu()));
    tsaDb.reset();
    await tsaDb.ready();
    expect(tsaDb.status().persistent).toBe(true);
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "1" });
    expect(r.actions[0]).toEqual({ say: { text: "Jednička.", language: "cs-CZ" } });
    expect(r.session.trace.length).toBeGreaterThan(4);
  });

  it("a published TSA keeps running the graph it started with", async () => {
    const id = tsa(menu(), true);
    const t = await startTsa(call(), id);
    expect(t.session.tsaVersion).toBe(1);
    const g = menu(); g.nodes.find((n) => n.id === "one")!.params.text = "Changed.";
    tsaStore.saveDraft(id, { graph: g.graph() }, "test");
    tsaStore.publish(id, "test");
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "1" });
    expect(r.actions[0]).toEqual({ say: { text: "Jednička.", language: "cs-CZ" } });
  });
});

describe("TSA runtime: states and errors", () => {
  it("busy before the answer refuses the call; after the answer it hangs up", async () => {
    const g = () => new G().node("start", "start", { answer: false }).node("end", "hangup", { as: "busy" }).flow("start", "next", "end");
    expect((await run(tsa(g()))).actions).toEqual([{ reject: { reason: "busy" } }]);
    const g2 = new G().node("start", "start", { answer: true }).node("end", "hangup", { as: "congestion" }).flow("start", "next", "end");
    expect((await run(tsa(g2))).actions).toEqual([{ hangup: {} }]);
  });

  it("a dead end hangs up", async () => {
    const g = new G().node("start", "start").node("p", "pause", { seconds: 2 }).flow("start", "next", "p");
    const t = await run(tsa(g));
    expect(t.actions).toEqual([{ pause: { seconds: 2 } }, { hangup: {} }]);
    expect(t.session.status).toBe("ended");
  });

  it("no such TSA, or not published: refused politely and logged", async () => {
    const t = await startTsa(call(), "no-such-tsa");
    expect(t.actions).toEqual([{ reject: { reason: "congestion" } }]);
    expect(t.session.status).toBe("failed");
    const id = tsa(new G().node("start", "start").node("end", "hangup").flow("start", "next", "end"));
    const u = await startTsa(call({ direction: "outbound" }), id);
    expect(u.actions).toEqual([{ say: { text: "Omlouváme se, nastala chyba. Na shledanou.", language: "cs-CZ" } }, { hangup: {} }]);
    expect(logs.some((l) => l.kind === "tsa" && l.level === "error" && /not published/.test(String(l.summary)))).toBe(true);
  });

  it("a runaway cycle without anything for the caller ends the call with an apology", async () => {
    const g = new G().node("start", "start", { language: "en-US" })
      .node("inc", "set", { name: "n", value: "$n + 1" }, { inputs: 0 })
      .node("loop", "condition", { formula: "true" }, { inputs: 0 })
      .flow("start", "next", "inc").flow("inc", "next", "loop").flow("loop", "on_true", "inc");
    const t = await run(tsa(g));
    expect(t.actions).toEqual([{ say: { text: "We are sorry, something went wrong. Goodbye.", language: "en-US" } }, { hangup: {} }]);
    expect(t.session.status).toBe("failed");
    expect(t.session.trace.at(-1)?.note).toMatch(/without anything for the caller/);
    expect(t.session.vars.n).toBeGreaterThan(90);
  });

  it("a long talking loop is split into turns with a played redirect", async () => {
    const g = new G().node("start", "start")
      .node("loop", "for", { from: "1", to: "60" }, { inputs: 0 })
      .node("say", "tts", { text: "{IN1}" }, { inputs: 1 })
      .node("end", "hangup")
      .flow("start", "next", "loop").flow("loop", "body", "say").flow("loop", "done", "end").data("loop", "index", "say", "IN1");
    const t = await run(tsa(g));
    const last = t.actions.at(-1) as Extract<CallAction, { redirect: unknown }>;
    expect(last.redirect.url).toMatch(/\/tsa\?s=ts_[a-z0-9]+&n=[a-z]+&e=played$/);
    expect(t.actions.filter((a) => "say" in a).length).toBe(40);
    const r = await resumeTsa(t.session.id, { kind: "played" });
    expect(r.actions.filter((a) => "say" in a).length).toBe(20);
    expect((r.actions.at(-2) as Extract<CallAction, { say: unknown }>).say.text).toBe("60");
    expect(r.actions.at(-1)).toEqual({ hangup: {} });
  });

  it("the longest call time ends it", async () => {
    const g = new G().node("start", "start", { maxMinutes: 1 }).node("ask", "read_dtmf").node("end", "hangup")
      .flow("start", "next", "ask").flow("ask", "next", "ask").flow("ask", "on_timeout", "end");
    const t = await run(tsa(g));
    clock += 61_000;
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "5" });
    expect(r.actions).toEqual([{ hangup: {} }]);
    expect(r.session.status).toBe("ended");
  });
});

describe("TSA runtime: logic", () => {
  it("a Condition with N inputs", async () => {
    const g = new G().node("start", "start")
      .node("a", "formula", { formula: "2" }, { inputs: 0 })
      .node("b", "formula", { formula: "3" }, { inputs: 0 })
      .node("c", "condition", { formula: "IN1 + IN2 == IN3 and IN4 == \"+420603123456\"" }, { inputs: 4 })
      .node("yes", "log", { text: "yes {IN1}" }, { inputs: 1 })
      .node("no", "log", { text: "no" }, { inputs: 0 })
      .node("five", "formula", { formula: "5" }, { inputs: 0 })
      .flow("start", "next", "a").flow("a", "next", "b").flow("b", "next", "five").flow("five", "next", "c")
      .flow("c", "on_true", "yes").flow("c", "on_false", "no")
      .data("a", "value", "c", "IN1").data("b", "value", "c", "IN2").data("five", "value", "c", "IN3").data("start", "from", "c", "IN4").data("five", "value", "yes", "IN1");
    const t = await run(tsa(g));
    expect(t.session.trace.find((e) => e.node === "c")?.port).toBe("on_true");
    expect(logs.some((l) => l.summary?.endsWith("yes 5"))).toBe(true);
  });

  it("Switch: contains / prefix and folding of case and accents", async () => {
    const mk = (match: string, value: string) => new G().node("start", "start")
      .node("v", "text", { template: value }, { inputs: 0 })
      .node("sw", "switch", { cases: ["podpora", "obchod"], match })
      .node("a", "log", { text: "A" }, { inputs: 0 }).node("b", "log", { text: "B" }, { inputs: 0 }).node("d", "log", { text: "D" }, { inputs: 0 })
      .flow("start", "next", "v").flow("v", "next", "sw").data("v", "text", "sw", "IN1")
      .flow("sw", "case_1", "a").flow("sw", "case_2", "b").flow("sw", "default", "d");
    const port = async (match: string, value: string) => (await run(tsa(mk(match, value)))).session.trace.find((e) => e.node === "sw")?.port;
    expect(await port("contains", "Chci mluvit s PODPOROU prosím")).toBe("default"); // "podporou" contains "podpor…" but not "podpora"
    expect(await port("contains", "Spojte mě s podporá")).toBe("case_1"); // accents folded: podpora
    expect(await port("prefix", "obchodní oddělení")).toBe("case_2");
    expect(await port("equals", "Obchod")).toBe("case_2");
  });

  it("For with a body path that ends (back to the loop), and the index", async () => {
    const g = new G().node("start", "start")
      .node("sum0", "set", { name: "sum", value: "0" }, { inputs: 0 })
      .node("loop", "for", { from: "IN1", to: "IN1 + 3", step: "1" }, { inputs: 1 })
      .node("add", "set", { name: "sum", value: "$sum + IN1" }, { inputs: 1 })
      .node("one", "formula", { formula: "1" }, { inputs: 0 })
      .node("say", "tts", { text: "sum {$sum}" }, { inputs: 0 })
      .flow("start", "next", "one").flow("one", "next", "sum0").flow("sum0", "next", "loop").flow("loop", "body", "add").flow("loop", "done", "say")
      .data("one", "value", "loop", "IN1").data("loop", "index", "add", "IN1");
    const t = await run(tsa(g));
    expect(t.session.vars.sum).toBe(1 + 2 + 3 + 4);
    expect(t.actions[0]).toEqual({ say: { text: "sum 10", language: "cs-CZ" } });
  });

  it("For downwards; While with Break; nested loops", async () => {
    const g = new G().node("start", "start")
      .node("outer", "for", { from: "3", to: "1", step: "-1" }, { inputs: 0 })
      .node("inner", "while", { formula: "true", maxRounds: 10 }, { inputs: 0 })
      .node("cnt", "set", { name: "c", value: "$c + 1" }, { inputs: 0 })
      .node("stop", "condition", { formula: "IN1 >= 1" }, { inputs: 1 })
      .node("brk", "break")
      .node("say", "tts", { text: "{$c}" }, { inputs: 0 })
      .flow("start", "next", "outer").flow("outer", "body", "inner").flow("outer", "done", "say")
      .flow("inner", "body", "cnt").flow("cnt", "next", "stop").flow("stop", "on_true", "brk")
      .data("inner", "index", "stop", "IN1");
    const t = await run(tsa(g));
    // 3 outer rounds × 2 inner rounds (index 0, then 1 → break).
    expect(t.session.vars.c).toBe(6);
    expect(t.session.loops).toEqual([]);
    expect(t.actions[0]).toEqual({ say: { text: "6", language: "cs-CZ" } });
  });

  it("While: max rounds stop a loop that never ends; a wait inside a loop persists", async () => {
    const g = new G().node("start", "start")
      .node("w", "while", { formula: "$ok != 1", maxRounds: 2 }, { inputs: 0 })
      .node("ask", "read_dtmf", { maxDigits: 4 })
      .node("chk", "set", { name: "ok", value: "IN1 == \"1234\"" }, { inputs: 1 })
      .node("done", "tts", { text: "konec {$ok}" }, { inputs: 0 })
      .flow("start", "next", "w").flow("w", "body", "ask").flow("w", "done", "done").flow("ask", "next", "chk")
      .data("ask", "digits", "chk", "IN1");
    const t = await run(tsa(g));
    expect(t.session.loops).toEqual([{ node: "w", index: 0, until: 2 }]);
    const r1 = await resumeTsa(t.session.id, { kind: "digits", digits: "1111" });
    expect(kinds(r1.actions)).toEqual(["gather"]);
    expect(r1.session.loops[0].index).toBe(1);
    const r2 = await resumeTsa(t.session.id, { kind: "digits", digits: "2222" });
    expect(r2.actions[0]).toEqual({ say: { text: "konec false", language: "cs-CZ" } });
  });

  it("Text spells digits; Opening hours by day, time and closed dates", async () => {
    const g = new G().node("start", "start").node("t", "text", { template: "Kód {IN1}", spellDigits: true }, { inputs: 1 }).node("f", "formula", { formula: "\"4711\"" }, { inputs: 0 })
      .flow("start", "next", "f").flow("f", "next", "t").data("f", "value", "t", "IN1");
    expect((await run(tsa(g))).session.values.t.text).toBe("Kód 4 7 1 1");
    const node = (p: Record<string, unknown>) => ({ type: "time_condition" as const, params: { ...defaultParams("time_condition"), ...p } });
    const mon0930 = Date.UTC(2026, 9, 5, 7, 30);
    expect(isOpen(node({}), mon0930)).toBe(true);
    expect(isOpen(node({}), Date.UTC(2026, 9, 5, 16, 0))).toBe(false); // 18:00 Prague
    expect(isOpen(node({}), Date.UTC(2026, 9, 4, 8, 0))).toBe(false); // Sunday
    expect(isOpen(node({ closedOn: ["10-05"] }), mon0930)).toBe(false);
    expect(isOpen(node({ closedOn: ["2026-10-05"] }), mon0930)).toBe(false);
    expect(isOpen(node({ days: "sun", from: "22:00", to: "06:00" }), Date.UTC(2026, 9, 5, 2, 0))).toBe(true); // Monday 04:00, the night after Sunday
    expect(isOpen(node({ timezone: "UTC", from: "07:00", to: "08:00" }), mon0930)).toBe(true);
  });
});

describe("TSA runtime: audio and the caller", () => {
  it("TTS with AI & speech is served from a token URL; the provider's voice is a say", async () => {
    const g = new G().node("start", "start").node("ai", "tts", { text: "Ahoj", provider: "ai", voice: "nova", volume: -6 }, { inputs: 0 })
      .node("plain", "tts", { text: "Čau", voice: "Polly.Jan", loop: 2 }, { inputs: 0 }).flow("start", "next", "ai").flow("ai", "next", "plain");
    const t = await run(tsa(g));
    expect(kinds(t.actions)).toEqual(["play", "say", "hangup"]);
    const url = (t.actions[0] as Extract<CallAction, { play: unknown }>).play.url;
    expect(url).toMatch(/^https:\/\/chat\.test\/wh\/tsa\/audio\/[A-Za-z0-9_-]{24}$/);
    expect(t.actions[1]).toEqual({ say: { text: "Čau", voice: "Polly.Jan", language: "cs-CZ", loop: 2 } });
    expect(sent.tts[0]).toMatchObject({ text: "Ahoj", voice: "nova", console: false });
    const row = tsaDb.audio.get(url.split("/").pop()!);
    expect(row?.mime).toBe("audio/wav");
    expect(Buffer.from(row!.data, "base64").length).toBe(WAV.length);
  });

  it("TTS failure and empty text go to on_failed", async () => {
    setTsaDeps({ tts: async () => { throw new Error("no key"); } });
    const g = new G().node("start", "start").node("ai", "tts", { text: "Ahoj", provider: "ai" }, { inputs: 0 }).node("empty", "tts", { text: "{IN1}" }, { inputs: 1 })
      .node("end", "hangup").flow("start", "next", "ai").flow("ai", "on_failed", "empty").flow("empty", "on_failed", "end");
    const t = await run(tsa(g));
    expect(t.session.trace.map((e) => e.port).filter(Boolean)).toEqual(["next", "on_failed", "on_failed"]);
  });

  it("Play: a URL, an uploaded file, a stream that stops after N seconds", async () => {
    const f = addAudioFile({ name: "hold.wav", data: `data:audio/wav;base64,${Buffer.from(WAV).toString("base64")}` }, "test");
    const g = new G().node("start", "start")
      .node("u", "play", { source: "url", url: "https://cdn.example.com/a.mp3" }, { inputs: 0 })
      .node("f", "play", { source: "file", file: f.id, loop: 2 }, { inputs: 0 })
      .node("s", "play", { source: "stream", url: "https://radio.example.com/live", seconds: 1 }, { inputs: 0 })
      .node("bye", "tts", { text: "konec" }, { inputs: 0 })
      .flow("start", "next", "u").flow("u", "next", "f").flow("f", "next", "s").flow("s", "next", "bye");
    const t = await run(tsa(g));
    expect(t.actions.slice(0, 3)).toEqual([
      { play: { url: "https://cdn.example.com/a.mp3" } },
      { play: { url: `https://chat.test/wh/tsa/file/${f.id}`, loop: 2 } },
      { play: { url: "https://radio.example.com/live" } },
    ]);
    expect((t.actions[3] as Extract<CallAction, { redirect: unknown }>).redirect.url).toMatch(/n=s&e=played$/);
    await new Promise((r) => setTimeout(r, 1200));
    expect(sent.steer).toHaveLength(1);
    const r = await resumeTsa(t.session.id, { kind: "played" });
    expect(r.actions).toEqual([{ say: { text: "konec", language: "cs-CZ" } }, { hangup: {} }]);
    const bad = new G().node("start", "start").node("u", "play", { source: "url", url: "http://x.test/a.mp3" }, { inputs: 0 }).node("end", "hangup").flow("start", "next", "u").flow("u", "on_failed", "end");
    expect((await run(tsa(bad))).session.trace.find((e) => e.node === "u")?.port).toBe("on_failed");
  });

  it("Record with transcription → a message into the room; the caller hanging up first still delivers it", async () => {
    const g = new G().node("start", "start")
      .node("rec", "record", { maxSeconds: 30, transcribe: true, finishOnKey: "none" })
      .node("post", "room_message", { room: "r3.abcdefghijklmnopqrstuv", text: "Vzkaz od {call.from} ({IN2} s): {IN1}" }, { inputs: 2 })
      .node("thanks", "tts", { text: "Díky" }, { inputs: 0 })
      .flow("start", "next", "rec").flow("rec", "next", "post").flow("post", "next", "thanks")
      .data("rec", "transcript", "post", "IN1").data("rec", "duration", "post", "IN2");
    const id = tsa(g);
    const t = await run(id);
    expect(t.actions).toEqual([{ record: { action: expect.stringMatching(/n=rec$/), maxSeconds: 30, beep: true, finishOnKey: "", silenceSeconds: 5, trim: true, transcribe: false, language: "cs-CZ" } }]);
    const r = await resumeTsa(t.session.id, { kind: "recording", url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1", durationSec: 12 });
    expect(r.actions).toEqual([{ say: { text: "Díky", language: "cs-CZ" } }, { hangup: {} }]);
    expect(sent.notice[0]).toMatchObject({ n: { kind: "message", text: "Vzkaz od +420603123456 (12 s): chci mluvit s podporou", from: `☎ ${id}` } });
    expect((sent.notice[0] as { hash: string }).hash).toMatch(/^[0-9a-f]{16}$/);

    sent.notice = [];
    const t2 = await run(id);
    const h = await resumeTsa(t2.session.id, { kind: "hangup" });
    expect(h.actions).toEqual([]);
    expect(h.session.status).toBe("waiting");
    const r2 = await resumeTsa(t2.session.id, { kind: "recording", url: "https://api.twilio.com/x", durationSec: 3 });
    expect(r2.actions).toEqual([]);
    expect(r2.session.status).toBe("ended");
    expect(sent.notice).toHaveLength(1);
  });

  it("Record: nothing said → on_timeout; nobody in the room → on_failed", async () => {
    const g = new G().node("start", "start").node("rec", "record").node("post", "room_message", { room: "r3.x", text: "x" }, { inputs: 0 })
      .node("t", "log", { text: "timeout" }, { inputs: 0 }).node("f", "log", { text: "not posted" }, { inputs: 0 })
      .flow("start", "next", "rec").flow("rec", "next", "post").flow("rec", "on_timeout", "t").flow("post", "on_failed", "f");
    const id = tsa(g);
    const t = await run(id);
    expect((await resumeTsa(t.session.id, { kind: "recording", url: "", durationSec: 0 })).session.trace.some((e) => e.node === "rec" && e.port === "on_timeout")).toBe(true);
    setTsaDeps({ notice: () => 0 });
    const t2 = await run(id);
    const r = await resumeTsa(t2.session.id, { kind: "recording", url: "https://x.test/r", durationSec: 2 });
    expect(r.session.trace.some((e) => e.node === "post" && e.port === "on_failed")).toBe(true);
  });

  it("Speech to text: the provider's recognition, and AI & speech (a recording transcribed)", async () => {
    const mk = (provider: string) => new G().node("start", "start")
      .node("stt", "stt", { provider, hints: ["podpora", "obchod"] })
      .node("c", "condition", { formula: "contains(IN1, \"podpor\")" }, { inputs: 1 })
      .node("y", "tts", { text: "Podpora" }, { inputs: 0 }).node("n", "tts", { text: "Jinak" }, { inputs: 0 })
      .flow("start", "next", "stt").flow("stt", "next", "c").flow("c", "on_true", "y").flow("c", "on_false", "n").data("stt", "text", "c", "IN1");
    const t = await run(tsa(mk("telephony")));
    expect((t.actions[0] as Extract<CallAction, { gather: unknown }>).gather).toMatchObject({ input: ["speech"], speechTimeout: 1.5, hints: ["podpora", "obchod"], language: "cs-CZ" });
    const r = await resumeTsa(t.session.id, { kind: "speech", text: "Podporu prosím", confidence: 0.9 });
    expect(r.actions[0]).toEqual({ say: { text: "Jinak", language: "cs-CZ" } }); // contains is case-sensitive
    const t2 = await run(tsa(mk("ai")));
    expect(kinds(t2.actions)).toEqual(["record"]);
    const r2 = await resumeTsa(t2.session.id, { kind: "recording", url: "https://x.test/r", durationSec: 2 });
    expect(r2.actions[0]).toEqual({ say: { text: "Podpora", language: "cs-CZ" } });
    expect(sent.stt[0]).toMatchObject({ language: "cs-CZ", console: false });
  });

  it("Send DTMF and Pause", async () => {
    const g = new G().node("start", "start").node("f", "formula", { formula: "\"42\"" }, { inputs: 0 })
      .node("d", "send_dtmf", { digits: "1w{IN1}#", type: "inband", toneMs: 200 }, { inputs: 1 }).node("p", "pause", { seconds: 1.5 })
      .flow("start", "next", "f").flow("f", "next", "d").flow("d", "next", "p").data("f", "value", "d", "IN1");
    expect((await run(tsa(g))).actions).toEqual([{ sendDigits: { digits: "1w42#", mode: "inband", toneMs: 200 } }, { pause: { seconds: 1.5 } }, { hangup: {} }]);
  });
});

describe("TSA runtime: Dial", () => {
  const mk = (p: Record<string, unknown>) => new G().node("start", "start")
    .node("d", "dial", { to: "+420603000111", ...p })
    .node("a", "log", { text: "answered" }, { inputs: 0 }).node("b", "tts", { text: "obsazeno" }, { inputs: 0 }).node("f", "tts", { text: "nelze" }, { inputs: 0 })
    .flow("start", "next", "d").flow("d", "on_answered", "a").flow("d", "on_busy", "b").flow("d", "on_no_answer", "f").flow("d", "on_failed", "f");

  it("through the outbound rules (a SIP trunk with its caller ID); the password never stays in the session", async () => {
    const t = await run(tsa(mk({})));
    const d = (t.actions[0] as Extract<CallAction, { dial: unknown }>).dial;
    // 6.10 (G-06): the bridged call has a time limit (permissions.outbound.maxMinutes, here 30 min).
    expect(d).toMatchObject({ to: "+420603000111", kind: "number", callerId: "+420222000111", callerName: "M5cet", timeout: 30, timeLimit: 1800, trunk: { id: "prague1", host: "sip.example.com", password: "pw-secret" } });
    // …asked of the module's outbound checks as the TSA, with the number called as the call's own.
    expect(sent.outbound.at(-1)).toMatchObject({ kind: "call", to: "+420603000111", tsa: t.session.tsaId, provider: "twilio", own: ["+420222333444", "+420222333444"], dry: false });
    expect(d.action).toMatch(/n=d$/);
    expect(JSON.stringify(tsaDb.sessions.get(t.session.id))).not.toContain("pw-secret");
    // A repeated callback gets the dial again — with the password looked up again.
    const dup = await resumeTsa(t.session.id, { kind: "played" });
    expect((dup.actions[0] as Extract<CallAction, { dial: unknown }>).dial.trunk?.password).toBe("pw-secret");
    const r = await resumeTsa(t.session.id, { kind: "dial", status: "busy" });
    expect(r.actions[0]).toEqual({ say: { text: "obsazeno", language: "cs-CZ" } });
    expect(r.session.values.d.status).toBe("busy");
  });

  it("refused by the rules or the permissions → on_failed; a SIP URI; caller ID defaults to the DID", async () => {
    expect((await run(tsa(mk({ to: "+19005550100" })))).session.trace.find((e) => e.node === "d")?.port).toBe("on_failed");
    permissions.outbound.countries = ["SK"];
    expect((await run(tsa(mk({})))).session.trace.find((e) => e.node === "d")?.note).toMatch(/may go only to SK/);
    permissions = structuredClone(DEFAULT_PERMISSIONS);
    // 6.10 (G-06): no countries set — a TSA dials only your own countries (a transfer abroad is refused) …
    expect((await run(tsa(mk({ to: "+447700900123" })))).session.trace.find((e) => e.node === "d")?.note).toMatch(/only your own countries \(CZ\)/);
    // … and even "Route through: the provider's application" cannot skip a rule that refuses (6.9 did).
    expect((await run(tsa(mk({ to: "+19005550100", via: "app" })))).session.trace.find((e) => e.node === "d")?.port).toBe("on_failed");
    permissions.outbound.countries = ["*"];
    expect(kinds((await run(tsa(mk({ to: "+447700900123" })))).actions)).toEqual(["dial"]);
    permissions = structuredClone(DEFAULT_PERMISSIONS);
    const t = await run(tsa(mk({ kind: "sip", to: "alice@pbx.example.com", via: "app" })));
    expect((t.actions[0] as Extract<CallAction, { dial: unknown }>).dial).toMatchObject({ to: "sip:alice@pbx.example.com", kind: "sip", callerId: "+420222333444" });
    expect(globMatch("+1900*", "+19005550100")).toBe(true);
    expect(globMatch("sip:*@example.com", "sip:a@example.com")).toBe(true);
    expect(globMatch("+4202*", "+4206")).toBe(false);
  });

  it("6.10 (G-06): the time limit is the shorter of maxMinutes and what is left of the TSA's own longest call; dials per TSA and hour are limited", async () => {
    const g = new G().node("start", "start", { maxMinutes: 5 }).node("d", "dial", { to: "+420603000111" }).flow("start", "next", "d");
    const id = tsa(g);
    let t = await run(id);
    expect((t.actions[0] as Extract<CallAction, { dial: unknown }>).dial.timeLimit).toBe(300);
    permissions.outbound.callsPerHour = 2;
    t = await run(id);
    expect(kinds(t.actions)).toEqual(["dial"]);
    t = await run(id);
    expect(t.session.trace.find((e) => e.node === "d")).toMatchObject({ port: "on_failed", note: "the hourly call limit" });
    expect(logs.some((l) => /more than 2 calls an hour from this TSA/.test(String(l.summary)))).toBe(true);
  });

  it("an answered dial continues when that call ends", async () => {
    const t = await run(tsa(mk({ via: "trunk", trunk: "prague1" })));
    const r = await resumeTsa(t.session.id, { kind: "dial", status: "answered", durationSec: 61 });
    expect(r.session.values.d).toEqual({ status: "answered", duration: 61 });
    expect(r.actions).toEqual([{ hangup: {} }]);
  });
});

describe("TSA runtime: Route audio", () => {
  const mk = () => new G().node("start", "start")
    .node("ask", "read_dtmf", { maxDigits: 6 })
    .node("route", "route_audio", { announce: "Spojuji {call.from}." })
    .node("ok", "tts", { text: "Konec." }, { inputs: 0 })
    .node("bad", "tts", { text: "Špatný kód." }, { inputs: 0 })
    .node("fail", "tts", { text: "Nejde to." }, { inputs: 0 })
    .flow("start", "next", "ask").flow("ask", "next", "route").data("ask", "digits", "route", "KEY")
    .flow("route", "on_success", "ok").flow("route", "on_code_error", "bad").flow("bad", "next", "ask").flow("route", "on_failed", "fail");
  const entry = (code: string, over: Partial<InrouteEntry> = {}): InrouteEntry => ({ code, type: "room", room: "r3.room", user: "", label: "", ttlSec: 600, createdAt: clock, expiresAt: clock + 600_000, createdBy: { kind: "console", id: "admin" }, uses: 0, maxUses: 0, ...over });

  it("success: the media's actions, then on_success when the routed audio ends", async () => {
    inroute.set("123456", entry("123456"));
    const t = await run(tsa(mk()));
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "123456" });
    expect(kinds(r.actions)).toEqual(["say", "stream", "redirect"]);
    expect(r.actions[0]).toEqual({ say: { text: "Spojuji +420603123456." } });
    expect((r.actions[2] as Extract<CallAction, { redirect: unknown }>).redirect.url).toMatch(/n=route&e=played$/);
    expect(r.session.values.route).toEqual({ type: "room", target: "r3.room" });
    expect(inroute.get("123456")!.uses).toBe(1);
    const end = await resumeTsa(t.session.id, { kind: "route", ok: true });
    expect(end.actions[0]).toEqual({ say: { text: "Konec.", language: "cs-CZ" } });
    // 6.10 (G-03): the log names the room by its hash, never its blind id.
    expect(logs.some((l) => String(l.summary).includes(`audio routed to room ${hashRoom("r3.room")} by code ••••56`))).toBe(true);
    // (the fake media hook's own detail names the room; the real one gives its hash)
    expect(logs.map((l) => String(l.summary)).join("\n")).not.toContain("r3.room");
  });

  it("code errors: bad format, unknown, expired — counted; the wrong code that reaches the per-call limit ends the call (6.10 G-05)", async () => {
    inroute.set("111111", entry("111111", { expiresAt: clock - 1 }));
    const failures: unknown[] = [];
    telHooks.inroute!.failure = async (who, detail) => { failures.push({ who, detail }); };
    const t = await run(tsa(mk()));
    let r = await resumeTsa(t.session.id, { kind: "digits", digits: "12" });
    // The TTS (a key stops it) becomes the next Read DTMF's prompt.
    expect(r.actions[0]).toMatchObject({ gather: { prompt: "Špatný kód.", digits: 6 } });
    r = await resumeTsa(t.session.id, { kind: "digits", digits: "999999" });
    expect(r.session.trace.filter((e) => e.port === "on_code_error").map((e) => e.note)).toEqual(["not 4–6 digits", "no such code"]);
    // Every wrong code is counted by the table — with the number called, which a caller cannot fake.
    expect(failures).toEqual([
      { who: { caller: "+420603123456", did: "+420222333444" }, detail: { code: "", callId: t.session.callId, provider: "twilio" } },
      { who: { caller: "+420603123456", did: "+420222333444" }, detail: { code: "999999", callId: t.session.callId, provider: "twilio" } },
    ]);
    r = await resumeTsa(t.session.id, { kind: "digits", digits: "111111" });
    expect(r.actions).toEqual([{ say: { text: "Příliš mnoho chybných kódů. Na shledanou.", language: "cs-CZ" } }, { hangup: {} }]);
    expect(r.session.status).toBe("ended");
    expect(r.session.trace.at(-1)?.note).toMatch(/the code expired — 3 wrong route codes, hung up/);
    expect(logs.some((l) => l.level === "warn" && /3 in this call — the call is ended/.test(String(l.summary)))).toBe(true);
  });

  it("6.10 (G-05): a lockout or a caller over budget (the table's guard) refuses the code without looking it up and without counting it", async () => {
    inroute.set("123456", entry("123456"));
    const looked: string[] = [];
    const counted: unknown[] = [];
    const lookup = telHooks.inroute!.lookup;
    telHooks.inroute!.lookup = async (code) => { looked.push(code); return lookup(code); };
    telHooks.inroute!.guard = async (who) => (who.did === "+420222333444" ? "route codes are paused on this number for 42 s — too many wrong codes" : null);
    telHooks.inroute!.failure = async (who) => { counted.push(who); };
    const t = await run(tsa(mk()));
    const r = await resumeTsa(t.session.id, { kind: "digits", digits: "123456" });
    expect(r.session.trace.filter((e) => e.port === "on_code_error").at(-1)?.note).toMatch(/paused on this number for 42 s/);
    expect(looked).toEqual([]);
    expect(counted).toEqual([]);
    // Another number of the operator is not paused.
    const t2 = await run(tsa(mk()), { to: "+420222333999", did: "+420222333999" });
    expect(kinds((await resumeTsa(t2.session.id, { kind: "digits", digits: "123456" })).actions)).toEqual(["say", "stream", "redirect"]);
    expect(looked).toEqual(["123456"]);
  });

  it("failed: the media cannot route, or no media part at all", async () => {
    inroute.set("123456", entry("123456"));
    routeResult = "failed";
    const t = await run(tsa(mk()));
    let r = await resumeTsa(t.session.id, { kind: "digits", digits: "123456" });
    expect(r.actions[0]).toEqual({ say: { text: "Nejde to.", language: "cs-CZ" } });
    const saved = telHooks.routeAudio;
    telHooks.routeAudio = undefined;
    const t2 = await run(tsa(mk()));
    r = await resumeTsa(t2.session.id, { kind: "digits", digits: "123456" });
    expect(r.actions[0]).toEqual({ say: { text: "Nejde to.", language: "cs-CZ" } });
    expect(logs.some((l) => /nothing can route audio/.test(String(l.summary)))).toBe(true);
    telHooks.routeAudio = saved;
    // The media refuses the code (its own check) → on_code_error; a route event that fails → on_failed.
    routeResult = "code";
    const t3 = await run(tsa(mk()));
    r = await resumeTsa(t3.session.id, { kind: "digits", digits: "123456" });
    // The TTS (a key stops it) becomes the next Read DTMF's prompt.
    expect(r.actions[0]).toMatchObject({ gather: { prompt: "Špatný kód.", digits: 6 } });
    routeResult = "ok";
    const t4 = await run(tsa(mk()));
    await resumeTsa(t4.session.id, { kind: "digits", digits: "123456" });
    r = await resumeTsa(t4.session.id, { kind: "route", ok: false, reason: "failed", detail: "the member left" });
    expect(r.actions[0]).toEqual({ say: { text: "Nejde to.", language: "cs-CZ" } });
  });

  it("one-time codes and the per-caller hourly limit", async () => {
    inroute.set("123456", entry("123456"));
    const g = mk(); g.nodes.find((n) => n.id === "route")!.params.consume = true;
    const id = tsa(g);
    const t = await run(id);
    await resumeTsa(t.session.id, { kind: "digits", digits: "123456" });
    const t2 = await run(id);
    const r = await resumeTsa(t2.session.id, { kind: "digits", digits: "123456" });
    expect(r.session.trace.filter((e) => e.port === "on_code_error").at(-1)?.note).toMatch(/one-time code was used/);
    // The real table's counters (control/inroute.ts) behind the hook.
    await realInroute.resetInrouteFailures();
    telHooks.inroute!.guard = (who) => realInroute.inrouteGuard(who, clock);
    telHooks.inroute!.failure = async (who, detail) => { await realInroute.inrouteFailure(who, detail, clock); };
    permissions.inroute.maxFailuresPerCallerPerHour = 1;
    const t3 = await run(id, { from: "+420777000999" });
    await resumeTsa(t3.session.id, { kind: "digits", digits: "000000" });
    const t4 = await run(id, { from: "+420777000999" });
    const r4 = await resumeTsa(t4.session.id, { kind: "digits", digits: "123456" });
    expect(r4.session.trace.filter((e) => e.port === "on_code_error").at(-1)?.note).toMatch(/too many wrong codes from this caller/);
    // A guesser who fakes a new caller ID each call still hits the number's budget.
    permissions.inroute.maxFailuresPerCallerPerHour = 1000;
    permissions.inroute.maxFailuresPerDidPerHour = 3;
    for (let i = 1; i <= 2; i++) await resumeTsa((await run(id, { from: `+1555000000${i}` })).session.id, { kind: "digits", digits: "000000" });
    const r5 = await resumeTsa((await run(id, { from: "+15550000009" })).session.id, { kind: "digits", digits: "123456" });
    expect(r5.session.trace.filter((e) => e.port === "on_code_error").at(-1)?.note).toMatch(/paused on this number for 60 s/);
    await realInroute.resetInrouteFailures();
  });
});

describe("TSA runtime: integrations", () => {
  it("SMS, HTTP (allowlist, secrets, JSON), Function, Number info, Add route code, Log", async () => {
    permissions.tsa.httpHosts = ["api.crm.test"];
    const g = new G().node("start", "start")
      .node("sms", "sms", { text: "Díky za hovor z {call.from}" })
      .node("http", "http", { method: "POST", url: "https://api.crm.test/caller?n={call.from}", headers: ["Authorization: Bearer {secret:CRM}"], body: "{\"n\":\"{call.from}\"}" })
      .node("name", "formula", { formula: "get(IN1, \"customer.name\")" }, { inputs: 1 })
      .node("fn", "function", { model: "crm-model" }, { inputs: 2 })
      .node("look", "lookup")
      .node("add", "inroute_add", { room: "r3.room", ttl: 900 }, { inputs: 0 })
      .node("log", "log", { level: "notice", text: "{IN1} {IN2} {IN3} {IN4}" }, { inputs: 4 })
      .flow("start", "next", "sms").flow("sms", "next", "http").flow("http", "on_success", "name").flow("name", "next", "fn").flow("fn", "next", "look").flow("look", "next", "add").flow("add", "next", "log")
      .data("http", "json", "name", "IN1").data("name", "value", "fn", "IN1").data("start", "did", "fn", "IN2")
      .data("name", "value", "log", "IN1").data("look", "country", "log", "IN2").data("add", "code", "log", "IN3").data("fn", "result", "log", "IN4");
    const t = await run(tsa(g));
    expect(t.session.status).toBe("ended");
    // 6.10 (G-06): sent as the TSA (its budget), with the call's own number for the countries check.
    expect(sent.sms).toEqual([{ to: "+420603123456", text: "Díky za hovor z +420603123456", tsa: t.session.tsaId, own: ["+420222333444", "+420222333444"] }]);
    expect(sent.http[0]).toMatchObject({ method: "POST", url: "https://api.crm.test/caller?n=%2B420603123456", headers: { authorization: "Bearer s3cret", "content-type": "application/json" }, body: "{\"n\":\"+420603123456\"}" });
    expect(sent.fn[0]).toEqual({ model: "crm-model", inputs: { call: expect.objectContaining({ from: "+420603123456" }), in1: "Eva", in2: "+420222333444" } });
    expect(logs.some((l) => l.level === "notice" && /Eva CZ 654321 \{"answer":42\}/.test(String(l.summary)))).toBe(true);
  });

  it("HTTP refused when the tool is off or the host is not allowed; Function off", async () => {
    const g = new G().node("start", "start").node("http", "http", { url: "https://evil.test/" }).node("f", "log", { text: "refused" }, { inputs: 0 })
      .flow("start", "next", "http").flow("http", "on_failed", "f");
    expect((await run(tsa(g))).session.trace.find((e) => e.node === "http")?.note).toMatch(/HTTP tool is off/);
    permissions.tsa.httpHosts = ["*.crm.test"];
    expect((await run(tsa(g))).session.trace.find((e) => e.node === "http")?.note).toMatch(/not an allowed host/);
    expect(sent.http).toHaveLength(0);
    permissions.tsa.functions = false;
    const g2 = new G().node("start", "start").node("fn", "function", { model: "m" }).flow("start", "next", "fn");
    expect((await run(tsa(g2))).session.trace.find((e) => e.node === "fn")?.port).toBe("on_failed");
  });

  it("an SMS to a blocked number is refused", async () => {
    const g = new G().node("start", "start").node("sms", "sms", { to: "+19005550100", text: "x" }).flow("start", "next", "sms");
    const t = await run(tsa(g));
    expect(t.session.trace.find((e) => e.node === "sms")?.port).toBe("on_failed");
    expect(sent.sms).toHaveLength(0);
  });

  it("6.10 (G-06): SMS pumping — a faked caller number abroad gets no SMS while no countries are set (only your own); * opens it", async () => {
    const g = new G().node("start", "start").node("sms", "sms", { text: "Děkujeme za hovor" }).flow("start", "next", "sms");
    const id = tsa(g);
    const t = await run(id, { from: "+2348031234567" });
    expect(t.session.trace.find((e) => e.node === "sms")).toMatchObject({ port: "on_failed", note: expect.stringMatching(/only your own countries \(CZ\)/) });
    expect(sent.sms).toHaveLength(0);
    expect(logs.some((l) => /SMS to \+2348031234567 refused/.test(String(l.summary)))).toBe(true);
    permissions.outbound.countries = ["*"];
    await run(id, { from: "+2348031234567" });
    expect(sent.sms).toHaveLength(1);
    // The simulator asks without counting.
    expect(sent.outbound.every((a) => (a as { dry: boolean }).dry === true)).toBe(true);
  });
});

describe("the simulator", () => {
  it("runs a draft turn by turn: what the caller hears, what it waits for, AI audio as data:", async () => {
    const g = new G().node("start", "start")
      .node("hello", "tts", { text: "Vítejte", provider: "ai" }, { inputs: 0 })
      .node("ask", "read_dtmf", { maxDigits: 4, prompt: "Zadejte kód" })
      .node("d", "dial", { to: "+420603000111" })
      .node("bye", "tts", { text: "Na shledanou {IN1}" }, { inputs: 1 })
      .flow("start", "next", "hello").flow("hello", "next", "ask").flow("ask", "next", "d").flow("d", "on_busy", "bye").data("ask", "digits", "bye", "IN1");
    const id = tsa(g);
    const { session, turn } = await simStart({ tsa: id, from: "+420777111222" });
    expect(session.callId).toMatch(/^sim:/);
    expect(turn.play[0]).toMatchObject({ kind: "say", text: "Vítejte", audio: expect.stringMatching(/^data:audio\/wav;base64,/) });
    expect(turn.play[1]).toEqual({ kind: "say", text: "Zadejte kód", language: "cs-CZ" });
    expect(turn.waiting).toMatchObject({ for: "digits", node: "ask", maxDigits: 4, finishOnKey: "#", timeoutSec: 5 });
    expect(turn.steps.some((s) => s.startsWith("hello (tts) → next"))).toBe(true);
    expect(sent.tts[0]).toMatchObject({ console: true });
    const t2 = await simEvent(session.id, { kind: "digits", digits: "4711" });
    expect(t2.turn.waiting).toMatchObject({ for: "dial", node: "d" });
    expect(t2.turn.steps.join("\n")).toMatch(/would dial \+420603000111 over SIP trunk prague1/);
    const t3 = await simEvent(session.id, { kind: "dial", status: "busy" });
    expect(t3.turn.play).toEqual([{ kind: "say", text: "Na shledanou 4711", language: "cs-CZ" }]);
    expect(t3.turn.ended).toEqual({ how: "hangup" });
    expect((await simGet(session.id))?.status).toBe("ended");
  });

  it("never does what costs or reaches out: SMS, HTTP, functions, rooms, route codes", async () => {
    permissions.tsa.httpHosts = ["api.crm.test"];
    const g = new G().node("start", "start")
      .node("sms", "sms", { text: "x" }).node("http", "http", { url: "https://api.crm.test/" }).node("fn", "function", { model: "m" })
      .node("room", "room_message", { room: "r3.r", text: "hi" }, { inputs: 0 }).node("add", "inroute_add", { room: "r3.r" }, { inputs: 0 })
      .node("ask", "read_dtmf", { maxDigits: 6 }).node("route", "route_audio").node("ok", "tts", { text: "routed" }, { inputs: 0 })
      .flow("start", "next", "sms").flow("sms", "next", "http").flow("http", "on_success", "fn").flow("fn", "next", "room").flow("room", "next", "add").flow("add", "next", "ask")
      .flow("ask", "next", "route").data("ask", "digits", "route", "KEY").flow("route", "on_success", "ok");
    const { session, turn } = await simStart({ tsa: tsa(g) });
    const steps = turn.steps.join("\n");
    expect(steps).toMatch(/SMS to \+420600000001 \(simulated, not sent\)/);
    expect(steps).toMatch(/would call GET https:\/\/api\.crm\.test\//);
    expect(steps).toMatch(/would run the model m/);
    expect(steps).toMatch(/would post into the room/);
    expect(steps).toMatch(/route code 250000 → the room \(simulated/);
    expect(sent.sms.length + sent.http.length + sent.fn.length + sent.notice.length).toBe(0);
    // The code the simulation added routes in the simulation (and nothing is really routed).
    const t2 = await simEvent(session.id, { kind: "digits", digits: "250000" });
    expect(t2.turn.waiting).toMatchObject({ for: "route" });
    expect(t2.turn.steps.join("\n")).toContain(`WOULD be routed to room ${hashRoom("r3.r")}`);
    const t3 = await simEvent(session.id, { kind: "route", ok: true });
    expect(t3.turn.play[0]).toMatchObject({ kind: "say", text: "routed" });
  });

  it("speech as text or as a WAV to transcribe; a recording as a data: URL; refuses real sessions", async () => {
    const g = new G().node("start", "start").node("stt", "stt").node("rec", "record", { transcribe: true }).node("say", "tts", { text: "{IN1} / {IN2}" }, { inputs: 2 })
      .flow("start", "next", "stt").flow("stt", "next", "rec").flow("rec", "next", "say").data("stt", "text", "say", "IN1").data("rec", "transcript", "say", "IN2");
    const id = tsa(g);
    const { session, turn } = await simStart({ tsa: id });
    expect(turn.waiting).toMatchObject({ for: "speech" });
    const t2 = await simEvent(session.id, { kind: "speech", audio: `data:audio/wav;base64,${Buffer.from(WAV).toString("base64")}` });
    expect(t2.turn.waiting).toMatchObject({ for: "recording" });
    expect(t2.turn.play).toEqual([{ kind: "beep" }]);
    const t3 = await simEvent(session.id, { kind: "recording", audio: `data:audio/wav;base64,${Buffer.from(WAV).toString("base64")}` });
    expect(t3.turn.play[0]).toMatchObject({ text: "chci mluvit s podporou / chci mluvit s podporou" });
    const real = await run(id);
    await expect(simEvent(real.session.id, { kind: "speech", text: "x" })).rejects.toThrow(/No such simulation/);
    expect(await simGet(real.session.id)).toBeNull();
    await expect(simEvent(session.id, { kind: "teleport" })).rejects.toThrow(/No such simulation|Not an event/);
  });
});

describe("the TSA store", () => {
  it("publish refuses errors; versions; the published graph is frozen", () => {
    const id = "store-a";
    tsaStore.create({ id, name: "Store A" }, "eva");
    const g = new G().node("start", "start").node("say", "tts", { text: "" }, { inputs: 0 }).node("end", "hangup").flow("start", "next", "say").flow("say", "next", "end").flow("say", "on_failed", "end");
    const saved = tsaStore.saveDraft(id, { graph: g.graph() }, "eva");
    expect(saved.problems.some((p) => p.level === "error")).toBe(true); // saved anyway: only the shape must hold
    expect(() => tsaStore.publish(id, "eva")).toThrow(TsaStoreError);
    g.nodes[1].params.text = "Ahoj";
    tsaStore.saveDraft(id, { graph: g.graph() }, "eva");
    expect(tsaStore.publish(id, "eva").tsa.version).toBe(1);
    g.nodes[1].params.text = "Čau";
    tsaStore.saveDraft(id, { graph: g.graph() }, "eva");
    const t = tsaStore.get(id)!;
    expect(t.published?.graph.nodes[1].params.text).toBe("Ahoj");
    expect(tsaStore.publish(id, "eva").tsa.published?.version).toBe(2);
    expect(() => tsaStore.saveDraft(id, { graph: { nodes: [{ id: "x", type: "nope" }], edges: [] } }, "eva")).toThrow(/keep it from being saved/);
  });

  it("create from a template, ids, duplicate, export / import, used by a rule, delete", () => {
    const { tsa: t } = tsaStore.create({ name: "Hlavní linka", template: "ivr-menu" }, "eva");
    expect(t.id).toBe("hlavni-linka");
    expect(t.graph.nodes.some((n) => n.type === "switch")).toBe(true);
    expect(() => tsaStore.create({ id: "catalog", name: "x" }, "eva")).toThrow(/not valid|id/);
    expect(() => tsaStore.create({ id: "hlavni-linka", name: "x" }, "eva")).toThrow(/exists/);
    const copy = tsaStore.duplicate(t.id, {}, "eva");
    expect(copy).toMatchObject({ id: "hlavni-linka-copy", published: null, version: 0 });
    const file = tsaStore.exportOne(t.id);
    const imported = tsaStore.importOne(JSON.parse(JSON.stringify(file)), "eva");
    expect(imported.tsa.id).toBe("hlavni-linka-2");
    expect(imported.tsa.graph).toEqual(t.graph);
    expect(() => tsaStore.importOne({ tsa: { graph: { nodes: [], edges: [{}] } } }, "eva")).toThrow();
    writeFileSync(join(dir, "telephony-control.json"), JSON.stringify({ rules: { inbound: [{ id: "in1", label: "Main line", target: { kind: "tsa", tsa: t.id } }], outbound: [] } }));
    expect(tsaStore.usedBy(t.id)).toEqual(["inbound rule Main line"]);
    expect(() => tsaStore.remove(t.id)).toThrow(/used by inbound rule Main line/);
    tsaStore.remove(copy.id);
    expect(tsaStore.get(copy.id)).toBeNull();
  });

  it("another process sees a change (the file is reloaded by its content)", () => {
    tsaStore.create({ id: "store-b", name: "B" }, "eva");
    const other = new (tsaStore.constructor as new () => typeof tsaStore)();
    expect(other.get("store-b")?.name).toBe("B");
    tsaStore.saveDraft("store-b", { name: "B2" }, "eva");
    expect(other.get("store-b")?.name).toBe("B2");
  });
});

describe("the console API and the providers' audio (express)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerTsaRoutes } = await import("../server/telephony/tsa/routes");
    const { registerTsaMediaRoutes } = await import("../server/telephony/tsa/media");
    const app = express();
    app.use(express.json({ limit: "16mb" }));
    app.use((_req, res, next) => { res.locals.adminName = "eva"; next(); });
    registerTsaRoutes(app);
    registerTsaMediaRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); });

  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };

  it("catalog, create, save, validate, publish (refused with problems), simulate", async () => {
    const cat = await api("GET", "/admin/telephony/tsa/catalog");
    expect((cat.json.tools as unknown[]).length).toBe(27);
    expect(cat.json.templates).toHaveLength(4);
    const created = await api("POST", "/admin/telephony/tsa", { name: "API test", template: "voicemail" });
    expect(created.status).toBe(200);
    const id = (created.json.tsa as { id: string }).id;
    const list = await api("GET", "/admin/telephony/tsa");
    expect((list.json.tsas as Array<{ id: string; usedBy: string[] }>).find((r) => r.id === id)).toMatchObject({ published: false, usedBy: [] });
    const pub = await api("POST", `/admin/telephony/tsa/${id}/publish`);
    expect(pub.status).toBe(422);
    expect((pub.json.problems as Array<{ message: string }>).some((p) => /room/.test(p.message))).toBe(true);
    const got = await api("GET", `/admin/telephony/tsa/${id}`);
    const graph = (got.json.tsa as { graph: TsaGraph }).graph;
    graph.nodes.find((n) => n.id === "post")!.params.room = "r3.abcdefghijklmnop";
    const put = await api("PUT", `/admin/telephony/tsa/${id}`, { name: "API test", description: "", graph });
    expect(put.json.problems).toEqual([]);
    expect((await api("POST", `/admin/telephony/tsa/${id}/validate`, { graph: { nodes: [], edges: [] } })).json.problems).toEqual([expect.objectContaining({ message: expect.stringMatching(/needs a Start/) })]);
    expect((await api("POST", `/admin/telephony/tsa/${id}/publish`)).json.tsa).toMatchObject({ version: 1 });
    const sim = await api("POST", "/admin/telephony/sim", { tsa: id, draft: false });
    expect(sim.json.turn).toMatchObject({ waiting: { for: "recording" } });
    const ev = await api("POST", `/admin/telephony/sim/${(sim.json.session as { id: string }).id}/event`, { kind: "hangup" });
    expect(ev.json.turn).toMatchObject({ status: "waiting" }); // waits for the recording after a hangup
    expect((await api("GET", `/admin/telephony/sim/${(sim.json.session as { id: string }).id}`)).json.session).toMatchObject({ tsaId: id });
    const exp = await fetch(`${base}/admin/telephony/tsa/${id}/export`);
    expect(exp.headers.get("content-disposition")).toMatch(/tsa-api-test\.json/);
    const imp = await api("POST", "/admin/telephony/tsa/import", { file: await exp.text() });
    expect((imp.json.tsa as { id: string }).id).toBe("api-test-2");
    expect((await api("DELETE", `/admin/telephony/tsa/${id}`)).json).toEqual({ ok: true });
  });

  it("audio files: upload, list, served to the provider; synthesized speech by token", async () => {
    const up = await api("POST", "/admin/telephony/tsa/files", { name: "hold.wav", data: `data:audio/wav;base64,${Buffer.from(WAV).toString("base64")}` });
    const fid = (up.json.file as { id: string }).id;
    expect(fid).toMatch(/^af_[a-f0-9]{24}$/);
    expect(((await api("GET", "/admin/telephony/tsa/files")).json.files as Array<{ id: string }>).some((f) => f.id === fid)).toBe(true);
    const served = await fetch(`${base}/wh/tsa/file/${fid}`);
    expect(served.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await served.arrayBuffer()).length).toBe(WAV.length);
    expect((await api("POST", "/admin/telephony/tsa/files", { name: "x.txt", data: Buffer.from("hello").toString("base64") })).status).toBe(415);
    const g = new G().node("start", "start").node("ai", "tts", { text: "Ahoj", provider: "ai" }, { inputs: 0 }).flow("start", "next", "ai");
    const t = await run(tsa(g));
    const url = (t.actions[0] as Extract<CallAction, { play: unknown }>).play.url.replace("https://chat.test", base);
    const audio = await fetch(url);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect((await fetch(`${base}/wh/tsa/audio/${"A".repeat(24)}`)).status).toBe(404);
    expect((await api("DELETE", `/admin/telephony/tsa/files/${fid}`)).json).toEqual({ ok: true });
    expect((await fetch(`${base}/wh/tsa/file/${fid}`)).status).toBe(404);
  });
});
