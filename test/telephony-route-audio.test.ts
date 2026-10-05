// @vitest-environment node
//
// Route audio (6.9): the conference mixer (sums, the soft limiter, members
// joining and leaving, silence for one alone), who a route code reaches
// (room / member / "@account", only by a blind room id), and routed calls end
// to end — the provider's media stream (as Twilio sends it), members' browsers
// over their own media sockets, the TSA resumed when the routed audio ends,
// the caller hanging up, nobody joining (fail / text mode).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const dir = mkdtempSync(join(tmpdir(), "m5route-"));
Object.assign(process.env, {
  DATA_DIR: dir, TELEPHONY_DB_FILE: join(dir, "telephony.db"), PUBLIC_BASE_URL: "https://chat.test",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001", TWILIO_AUTH_TOKEN: "twilio-test-token", TWILIO_FROM: "+15005550006",
});

vi.mock("../server/ai/service", async () => {
  const audio = await import("../server/telephony/audio");
  return {
    stt: vi.fn(async () => ({ text: "dobrý den, tady volající", ref: "test" })),
    tts: vi.fn(async () => ({ audio: audio.wavEncode(audio.tone(440, 200, 16_000), 16_000), mime: "audio/wav", ref: "test" })),
    chat: vi.fn(), modelsFor: vi.fn(() => []),
  };
});

const { JitterBuffer, Mixer, softLimit, hardClip, MIX_FRAME, LIMIT_KNEE } = await import("../server/telephony/mixer");
const routeMod = await import("../server/telephony/route-audio");
const { routeTargets, decideRoute, routeLimits, setRouteHub, isBlindRoomId, parseProviderFrame, providerMessage, closeRoutes, liveRoutes } = routeMod;
const { attachBridgeMedia, closeBridgeMedia } = await import("../server/telephony/bridge");
const { telHooks } = await import("../server/telephony/control/hooks");
const { telStore } = await import("../server/telephony/tel-store");
const audio = await import("../server/telephony/audio");
type InrouteEntry = import("../server/telephony/control/types").InrouteEntry;
type TsaEvent = import("../server/telephony/tsa/types").TsaEvent;

/* ------------------------------------------------------------ helpers */

const ROOM = "r3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "r3.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const entry = (over: Partial<InrouteEntry> = {}): InrouteEntry => ({
  code: "4321", type: "room", room: ROOM, user: "", label: "Recepce", ttlSec: 600, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
  createdBy: { kind: "console", id: "boss" }, uses: 0, maxUses: 0, ...over,
});

type Sent = { room: string; peerId: string; payload: Record<string, unknown> };
function fakeHub(rooms: Record<string, Array<{ peerId: string; name: string; accountId?: string }>>) {
  const sent: Sent[] = [];
  const hub = {
    members: (room: string) => rooms[room] ?? [],
    send: (room: string, peerId: string, payload: Record<string, unknown>) => { sent.push({ room, peerId, payload }); return true; },
    accountMembers: (acc: string) => Object.entries(rooms).flatMap(([room, ms]) => ms.filter((m) => m.accountId?.toLowerCase() === acc.toLowerCase()).map((m) => ({ room, peerId: m.peerId, name: m.name }))),
  };
  return { hub, sent, rooms };
}

const until = async <T>(fn: () => T | undefined | null | false, ms = 8_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const level = (pcm: Int16Array) => audio.rms(pcm);

/* ------------------------------------------------------------ the mixer */

describe("the mixer", () => {
  it("sums 16-bit PCM; the soft limiter leaves quiet audio alone and never passes full scale", () => {
    expect(softLimit(1000)).toBe(1000);
    expect(softLimit(-LIMIT_KNEE)).toBe(-LIMIT_KNEE);
    expect(softLimit(40_000)).toBeLessThanOrEqual(32_767);
    expect(softLimit(40_000)).toBeGreaterThan(LIMIT_KNEE);
    expect(softLimit(-200_000)).toBeGreaterThanOrEqual(-32_767);
    expect(softLimit(30_000)).toBeGreaterThan(softLimit(28_000)); // monotonic
    expect(hardClip(40_000)).toBe(32_767);
    expect(hardClip(-40_000)).toBe(-32_768);

    const m = new Mixer();
    for (const id of ["caller", "a", "b"]) m.add(id, { target: MIX_FRAME });
    m.push("caller", new Int16Array(MIX_FRAME).fill(1000));
    m.push("a", new Int16Array(MIX_FRAME).fill(2000));
    m.push("b", new Int16Array(MIX_FRAME).fill(-500));
    const r = m.tick(["caller", "a", "b"]);
    // Mix-minus: each hears the others, never itself.
    expect(r.out.get("caller")![0]).toBe(1500);
    expect(r.out.get("a")![0]).toBe(500);
    expect(r.out.get("b")![0]).toBe(3000);
    expect(r.active.sort()).toEqual(["a", "b", "caller"]);
  });

  it("loud members together are limited, not wrapped", () => {
    const m = new Mixer();
    for (const id of ["caller", "a", "b", "c"]) m.add(id, { target: MIX_FRAME });
    for (const id of ["a", "b", "c"]) m.push(id, new Int16Array(MIX_FRAME).fill(30_000));
    const heard = m.tick(["caller"]).out.get("caller")!;
    expect(Math.min(...heard)).toBeGreaterThan(LIMIT_KNEE);
    expect(Math.max(...heard)).toBeLessThanOrEqual(32_767);
  });

  it("one alone hears silence (not themselves); a member joining and leaving is heard only while in", () => {
    const m = new Mixer();
    m.add("caller", { target: MIX_FRAME });
    m.push("caller", audio.tone(300, 20, 16_000, 0.5));
    expect(level(m.tick(["caller"]).out.get("caller")!)).toBe(0);

    m.add("a", { target: MIX_FRAME });
    m.push("caller", audio.tone(300, 20, 16_000, 0.5));
    m.push("a", audio.tone(500, 20, 16_000, 0.5));
    const both = m.tick(["caller", "a"]);
    expect(level(both.out.get("caller")!)).toBeGreaterThan(0.3);
    expect(level(both.out.get("a")!)).toBeGreaterThan(0.3);

    m.remove("a");
    m.push("a", audio.tone(500, 20, 16_000, 0.5)); // gone: ignored
    m.push("caller", audio.tone(300, 20, 16_000, 0.5));
    expect(level(m.tick(["caller"]).out.get("caller")!)).toBe(0);
  });

  it("a source that is not a listener (a spoken reply) is heard by everyone", () => {
    const m = new Mixer();
    m.add("caller", { target: MIX_FRAME });
    m.add("a", { target: MIX_FRAME });
    m.add("speech", { target: MIX_FRAME });
    m.push("speech", new Int16Array(MIX_FRAME).fill(700));
    const r = m.tick(["caller", "a"]);
    expect(r.out.get("caller")![5]).toBe(700);
    expect(r.out.get("a")![5]).toBe(700);
  });

  it("the jitter buffer waits for its target, plays what is left on an underrun, cuts latency back when it runs ahead", () => {
    const b = new JitterBuffer({ frame: 320, target: 960, max: 3200 });
    b.push(new Int16Array(682).fill(1)); // a browser's chunk
    expect(b.pull()).toBeNull(); // still filling
    b.push(new Int16Array(682).fill(2));
    const f1 = b.pull()!;
    expect(f1.length).toBe(320);
    expect(b.playing).toBe(true);
    expect(b.pull()!.length).toBe(320);
    expect(b.pull()!.length).toBe(320);
    const last = b.pull()!; // 1364 - 960 = 404 → 320, then 84 left
    expect(last.length).toBe(320);
    const partial = b.pull()!; // 84 samples + silence, then it fills up again
    expect(partial[83]).toBe(2);
    expect(partial[84]).toBe(0);
    expect(b.stats.underruns).toBe(1);
    expect(b.pull()).toBeNull();
    // Runs ahead: dropped back to the target, never more than max.
    b.push(new Int16Array(5000));
    expect(b.buffered).toBeLessThanOrEqual(3200);
    expect(b.stats.dropped).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------ who it reaches */

describe("who a route code reaches", () => {
  const { hub } = fakeHub({
    [ROOM]: [{ peerId: "p-eva", name: "Eva", accountId: "eva01" }, { peerId: "p-karel", name: "Karel" }],
    [OTHER]: [{ peerId: "p-alice", name: "Alice", accountId: "Alice" }],
    "plain-room-name": [{ peerId: "p-bob", name: "Bob", accountId: "alice" }],
  });

  it("room: every member connected to that room — and only that room", () => {
    const t = routeTargets(entry(), hub);
    expect(t.problem).toBe("");
    expect(t.targets.map((x) => x.peerId)).toEqual(["p-eva", "p-karel"]);
    expect(t.targets.every((x) => x.room === ROOM && x.inRoom)).toBe(true);
  });

  it("user: a member by name in the room, or \"@account\" — in the room first, else wherever it is connected (blind rooms only)", () => {
    expect(routeTargets(entry({ type: "user", user: "karel" }), hub).targets.map((x) => x.peerId)).toEqual(["p-karel"]);
    expect(routeTargets(entry({ type: "user", user: "@EVA01" }), hub).targets).toEqual([{ room: ROOM, peerId: "p-eva", name: "Eva", inRoom: true, accountId: "eva01" }]);
    // Alice is not in the room: her connection in another (blind) room — never the room known by its name.
    expect(routeTargets(entry({ type: "user", user: "@alice" }), hub).targets).toEqual([{ room: OTHER, peerId: "p-alice", name: "Alice", inRoom: false, accountId: "alice" }]);
    expect(routeTargets(entry({ type: "user", user: "Nobody" }), hub).targets).toEqual([]);
  });

  it("never by a room's name: only a blind id (r3.…) is routed", () => {
    expect(isBlindRoomId(ROOM)).toBe(true);
    expect(isBlindRoomId("plain-room-name")).toBe(false);
    expect(routeTargets(entry({ room: "plain-room-name" }), hub)).toEqual({ targets: [], problem: expect.stringContaining("blind room id") });
    expect(decideRoute(entry({ room: "plain-room-name" }), "text", hub)).toMatchObject({ ok: false, reason: "failed" });
  });

  it("decisions: routed / nobody connected → failed or text mode / expired → code / no hub → failed", () => {
    expect(decideRoute(entry(), "fail", hub)).toMatchObject({ ok: true, textOnly: false, detail: expect.stringContaining("2 connections") });
    const empty = fakeHub({}).hub;
    expect(decideRoute(entry(), "fail", empty)).toMatchObject({ ok: false, reason: "failed", detail: expect.stringContaining("nobody is connected") });
    expect(decideRoute(entry(), "text", empty)).toMatchObject({ ok: true, textOnly: true, targets: [] });
    expect(decideRoute(entry({ type: "user", user: "Nobody" }), "fail", hub)).toMatchObject({ ok: false, reason: "failed" });
    expect(decideRoute(entry({ expiresAt: Date.now() - 1 }), "fail", hub)).toMatchObject({ ok: false, reason: "code" });
    expect(decideRoute(entry(), "fail", null)).toMatchObject({ ok: false, reason: "failed" });
    // What it says (the TSA's trace, the log) never carries the blind id.
    for (const mode of ["fail", "text"] as const) for (const h of [hub, empty, null]) expect(decideRoute(entry(), mode, h).detail).not.toContain(ROOM);
  });

  it("provider frames: Twilio JSON µ-law in and out, Vonage binary L16", () => {
    const tw = { transport: "json-mulaw", codec: "PCMU", rate: 8000 } as const;
    expect(parseProviderFrame(tw, Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ9" } })), false)).toEqual({ kind: "start", streamSid: "MZ9" });
    const media = parseProviderFrame(tw, Buffer.from(JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.from(audio.mulawEncode(audio.tone(400, 20, 8000))).toString("base64") } })), false);
    expect(media && media.kind === "media" && media.pcm.length).toBe(160);
    expect(parseProviderFrame(tw, Buffer.from(JSON.stringify({ event: "media", media: { track: "outbound", payload: "AA==" } })), false)).toBeNull();
    expect(parseProviderFrame(tw, Buffer.from(JSON.stringify({ event: "stop" })), false)).toEqual({ kind: "stop" });
    expect(JSON.parse(String(providerMessage(tw, "MZ9", new Int16Array(160))))).toMatchObject({ event: "media", streamSid: "MZ9" });
    const vo = { transport: "binary-l16", codec: "L16", rate: 16000 } as const;
    expect(parseProviderFrame(vo, Buffer.from(JSON.stringify({ event: "websocket:connected" })), false)).toEqual({ kind: "start", streamSid: "" });
    expect((providerMessage(vo, "", new Int16Array(320)) as Buffer).length).toBe(640);
  });
});

/* ------------------------------------------------------------ the real hub */

describe("on the signaling hub", () => {
  it("finds a room by the blind id members joined with, a signed-in account in another room, and reaches one member's socket", async () => {
    const { SignalingHub } = await import("../server/signaling/hub");
    const { AccountStore } = await import("../server/accounts/store");
    const { MemoryQueue } = await import("../server/accounts/memqueue");
    const { WsClient } = await import("./helpers/ws-client");
    const hubDir = mkdtempSync(join(tmpdir(), "m5route-hub-"));
    const store = new AccountStore(hubDir);
    const queue = new MemoryQueue();
    const sig = new SignalingHub({ accounts: store, queue: () => queue, storageFrame: () => undefined, newStorageState: () => ({ windowStart: Date.now(), count: 0 }) as never, trustProxy: false });
    const http = createServer();
    sig.attach(http);
    http.listen(0, "127.0.0.1");
    await new Promise((r) => http.once("listening", r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const clients: Array<InstanceType<typeof WsClient>> = [];
    const joinAs = async (room: string, name: string, extra: Record<string, unknown> = {}) => {
      const c = await WsClient.connect(base);
      clients.push(c);
      const hello = await c.next("hello");
      c.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId, ...extra });
      const joined = await c.next("joined");
      return { c, peerId: String(joined.peerId) };
    };
    try {
      const r = store.create({ credentialId: "cred-alice-000000000", publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 }, "Alice");
      if (!r.ok) throw new Error(r.reason);
      const eva = await joinAs(ROOM, "Eva");
      const karel = await joinAs(ROOM, "Karel");
      const alice = await joinAs(OTHER, "Alice", { auth: store.issueToken(r.account.id) });
      await joinAs("plain-room-name", "Bob");
      const h = { members: (room: string) => sig.roomMembers(room), send: (room: string, peerId: string, p: Record<string, unknown>) => sig.sendToPeer(room, peerId, p), accountMembers: (a: string) => sig.accountMembers(a) };
      expect(routeTargets(entry(), h).targets.map((t) => t.name).sort()).toEqual(["Eva", "Karel"]);
      expect(routeTargets(entry({ type: "user", user: `@${r.account.id.toUpperCase()}` }), h).targets).toEqual([{ room: OTHER, peerId: alice.peerId, name: "Alice", inRoom: false, accountId: r.account.id.toLowerCase() }]);
      // A room joined by its name is never a route's.
      expect(routeTargets(entry({ room: "plain-room-name" }), h).problem).toContain("blind room id");
      // One member's socket, nobody else's.
      expect(sig.sendToPeer(ROOM, karel.peerId, { type: "phone-bridge", event: "incoming", session: "tr_x" })).toBe(true);
      expect(await karel.c.next("phone-bridge")).toMatchObject({ event: "incoming", session: "tr_x" });
      expect(await eva.c.none("phone-bridge")).toBe(true);
      expect(sig.sendToPeer(ROOM, "p-nobody", { type: "phone-bridge" })).toBe(false);
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await sig.shutdown();
      http.closeAllConnections?.();
      await new Promise((r) => http.close(r));
      rmSync(hubDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------ routed calls */

const restCalls: Array<{ url: string; body: string }> = [];
const realFetch = globalThis.fetch;
let server: Server;
let wsBase = "";
const resumed: Array<{ session: string; ev: TsaEvent }> = [];
let nextActions: unknown[] = [{ say: { text: "Na shledanou." } }, { hangup: {} }];

beforeAll(async () => {
  await telStore.ready();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    restCalls.push({ url, body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "") });
    return new Response(JSON.stringify({ sid: "CA1", status: "in-progress" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  telHooks.tsa = {
    start: async () => { throw new Error("not in this test"); },
    resume: async (session: string, ev: TsaEvent) => {
      resumed.push({ session, ev });
      return { session: { status: "waiting" } as never, actions: nextActions as never };
    },
  };
  Object.assign(routeLimits, { joinSec: 0.6, leaveGraceSec: 0.25, pollMs: 100, streamSec: 3 });
  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachBridgeMedia(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => { await closeRoutes(); });

afterAll(async () => {
  closeBridgeMedia();
  delete telHooks.tsa;
  setRouteHub(null);
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
/** A live inbound call in the call records (the TSA's call). */
function liveCall(from = "+420777000111") {
  seq += 1;
  const now = Date.now();
  const id = `tc_route${seq}`;
  telStore.calls.put({
    id, token: `tok-route-call-${seq}-xxxxxxxxxxxx`, provider: "twilio", providerCallId: `CA${100 + seq}`, direction: "inbound", from, to: "+15005550006", status: "answered",
    mode: "sync", actions: [], handlers: {}, owner: null, pending: [], waitFor: null, gatherFn: "", events: [], seq: 0, timeoutSec: 0, timeLimitSec: 0,
    createdAt: now, updatedAt: now, answeredAt: now, endedAt: null, durationSec: null, bridge: "", error: "", steer: null,
  });
  return { id, token: `tok-route-call-${seq}-xxxxxxxxxxxx`, provider: "twilio", direction: "inbound" as const, from, to: "+15005550006", did: "+15005550006" };
}

const open = async (path: string) => {
  const ws = new WebSocket(`${wsBase}${path}`);
  const text: Array<Record<string, unknown>> = [];
  const bin: Buffer[] = [];
  ws.on("message", (d, isBinary) => { if (isBinary) bin.push(d as Buffer); else text.push(JSON.parse(String(d))); });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return { ws, text, bin };
};
const streamPath = (actions: unknown[]) => new URL((actions.find((a) => (a as { stream?: unknown }).stream) as { stream: { url: string } }).stream.url).pathname;
const twilioMedia = (pcm8k: Int16Array) => JSON.stringify({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: Buffer.from(audio.mulawEncode(pcm8k)).toString("base64") } });
const callerHeard = (msgs: Array<Record<string, unknown>>) => msgs.filter((m) => m.event === "media").map((m) => audio.mulawDecode(new Uint8Array(Buffer.from((m.media as { payload: string }).payload, "base64"))));
const incomingFor = (sent: Sent[], peerId: string) => sent.find((s) => s.peerId === peerId && s.payload.type === "phone-bridge" && s.payload.event === "incoming")?.payload;

describe("a call routed into a room", () => {
  it("every member who joins hears the caller and each other, the caller hears them mixed; when all leave the TSA goes on (on_success)", async () => {
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-eva", name: "Eva" }, { peerId: "p-karel", name: "Karel" }], [OTHER]: [{ peerId: "p-x", name: "X" }] });
    setRouteHub(hub);
    resumed.length = 0; restCalls.length = 0;
    nextActions = [{ say: { text: "Na shledanou." } }, { hangup: {} }];
    const call = liveCall();
    const r = await telHooks.routeAudio!(call, entry(), { announce: "Spojuji do místnosti.", mode: "fail", sessionId: "ts_1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions[0]).toEqual({ say: { text: "Spojuji do místnosti." } });
    expect(r.actions[1]).toMatchObject({ stream: { url: expect.stringMatching(/^wss:\/\/chat\.test\/media\/tel\/[A-Za-z0-9_-]+$/), codec: "PCMU", rate: 8000 } });

    // The provider's stream (as Twilio sends it).
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "connected" }));
    provider.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ1" } }));
    const eva = await until(() => incomingFor(sent, "p-eva"));
    const karel = await until(() => incomingFor(sent, "p-karel"));
    expect(eva).toMatchObject({ route: "room", from: "+420777000111", number: "+15005550006", label: "Recepce", members: 0 });
    expect(eva.token).not.toBe(karel.token);
    // Nobody outside the room was told.
    expect(sent.every((s) => s.room === ROOM)).toBe(true);
    // Waiting for the first member: the caller hears the ringing tone.
    await until(() => callerHeard(provider.text).some((f) => level(f) > 0.02));

    const a = await open(`/media/tel/client/${eva.token}`);
    const b = await open(`/media/tel/client/${karel.token}`);
    a.ws.send(JSON.stringify({ type: "audio" }));
    b.ws.send(JSON.stringify({ type: "audio" }));
    await until(() => liveRoutes()[0]?.members === 2);
    expect(sent.some((s) => s.payload.event === "status" && s.payload.members === 2)).toBe(true);
    await until(() => a.text.some((m) => m.type === "roster" && m.members === 2));

    // The caller speaks: both members hear it.
    for (let i = 0; i < 25; i++) { provider.ws.send(twilioMedia(audio.tone(400, 20, 8000, 0.4))); await sleep(5); }
    const heardBy = (x: { bin: Buffer[] }) => x.bin.map((buf) => audio.pcm16FromLE(new Uint8Array(buf))).some((f) => level(f) > 0.05);
    await until(() => heardBy(a) && heardBy(b));

    // Eva speaks (the caller silent): the caller and Karel hear her, Eva does not hear herself.
    a.bin.length = 0; b.bin.length = 0; provider.text.length = 0;
    await sleep(500); // what the caller said is played out
    a.bin.length = 0; b.bin.length = 0; provider.text.length = 0;
    for (let i = 0; i < 12; i++) { a.ws.send(audio.pcm16ToLE(audio.tone(600, 43, 16_000, 0.4))); await sleep(15); }
    await until(() => heardBy(b));
    await until(() => callerHeard(provider.text).some((f) => level(f) > 0.05));
    expect(heardBy(a)).toBe(false);

    // Both leave: after the grace the TSA continues at on_success, its actions replace the stream.
    a.ws.send(JSON.stringify({ type: "leave" }));
    b.ws.close();
    await until(() => resumed.length === 1);
    expect(resumed[0]).toEqual({ session: "ts_1", ev: { kind: "route", ok: true, detail: "everyone left the call's audio" } });
    const update = await until(() => restCalls.find((c) => c.url.includes(`/Calls/CA${100 + seq}.json`)));
    expect(new URLSearchParams(update.body).get("Twiml")).toContain("Na shledanou.");
    await until(() => sent.some((s) => s.payload.event === "ended"));
    expect(liveRoutes()).toEqual([]);
    for (const x of [provider, a, b]) x.ws.close();
  }, 30_000);

  it("the caller hanging up ends everything — no resume, the members' cards end", async () => {
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-eva", name: "Eva" }] });
    setRouteHub(hub);
    resumed.length = 0;
    const call = liveCall();
    const r = await telHooks.routeAudio!(call, entry(), { mode: "fail", sessionId: "ts_2" });
    if (!r.ok) throw new Error(r.detail);
    expect(r.actions).toHaveLength(1);
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ2" } }));
    const eva = await until(() => incomingFor(sent, "p-eva"));
    const a = await open(`/media/tel/client/${eva.token}`);
    a.ws.send(JSON.stringify({ type: "audio" }));
    await until(() => liveRoutes()[0]?.members === 1);
    // The provider reports the end, then stops the stream.
    const tc = telStore.calls.get(call.id)!;
    telStore.calls.put({ ...tc, status: "completed" });
    provider.ws.send(JSON.stringify({ event: "stop" }));
    await until(() => sent.some((s) => s.payload.event === "ended" && s.payload.reason === "the caller hung up"));
    await until(() => a.text.some((m) => m.type === "ended"));
    await sleep(100);
    expect(resumed).toEqual([]);
    provider.ws.close(); a.ws.close();
  }, 20_000);

  it("nobody joins in time: mode fail → on_failed", async () => {
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-eva", name: "Eva" }] });
    setRouteHub(hub);
    resumed.length = 0;
    const r = await telHooks.routeAudio!(liveCall(), entry(), { mode: "fail", sessionId: "ts_3" });
    if (!r.ok) throw new Error(r.detail);
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ3" } }));
    await until(() => incomingFor(sent, "p-eva"));
    await until(() => resumed.length === 1);
    expect(resumed[0].ev).toEqual({ kind: "route", ok: false, reason: "failed", detail: "nobody took the call's audio" });
    provider.ws.close();
  }, 20_000);

  it("nobody connected: mode fail is refused at once; mode text transcribes the caller to the room and speaks the replies", async () => {
    const empty = fakeHub({ [ROOM]: [] });
    setRouteHub(empty.hub);
    const refused = await telHooks.routeAudio!(liveCall(), entry(), { mode: "fail", sessionId: "ts_4" });
    expect(refused).toMatchObject({ ok: false, reason: "failed", detail: expect.stringContaining("nobody is connected") });

    // Text mode: Eva is connected but does not join; the caller's speech reaches the room as text.
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-eva", name: "Eva" }] });
    setRouteHub(hub);
    resumed.length = 0;
    const r = await telHooks.routeAudio!(liveCall("+420777000999"), entry(), { mode: "text", sessionId: "ts_5" });
    if (!r.ok) throw new Error(r.detail);
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ5" } }));
    const eva = await until(() => incomingFor(sent, "p-eva"));
    await until(() => sent.some((s) => s.payload.event === "status" && s.payload.channel === "text"));
    for (const part of [audio.silence(300, 8000), audio.tone(300, 600, 8000, 0.5), audio.silence(1200, 8000)]) {
      for (let i = 0; i < part.length; i += 160) provider.ws.send(twilioMedia(part.subarray(i, i + 160)));
    }
    const said = await until(() => sent.find((s) => s.payload.type === "server-notice" && s.payload.text === "dobrý den, tady volající"));
    expect(said).toMatchObject({ room: ROOM, peerId: "p-eva", payload: { from: "☎ +420777000999" } });
    // Eva answers in writing: spoken to the caller.
    const a = await open(`/media/tel/client/${eva.token}`);
    provider.text.length = 0;
    a.ws.send(JSON.stringify({ type: "say", text: "Hned to vyřídím." }));
    await until(() => callerHeard(provider.text).some((f) => level(f) > 0.05));
    // Eva ends it: the TSA goes on.
    a.ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => resumed.length === 1);
    expect(resumed[0].ev).toMatchObject({ kind: "route", ok: true, detail: "a member ended it" });
    provider.ws.close(); a.ws.close();
  }, 30_000);
});

describe("a call routed to one member", () => {
  it("\"@account\" in another room gets the card without the caller's number; a second device takes it over", async () => {
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-karel", name: "Karel" }], [OTHER]: [{ peerId: "p-alice", name: "Alice", accountId: "alice" }, { peerId: "p-alice2", name: "Alice", accountId: "alice" }] });
    setRouteHub(hub);
    resumed.length = 0;
    const r = await telHooks.routeAudio!(liveCall(), entry({ type: "user", user: "@alice" }), { mode: "fail", sessionId: "ts_6" });
    if (!r.ok) throw new Error(r.detail);
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ6" } }));
    const one = await until(() => incomingFor(sent, "p-alice"));
    const two = await until(() => incomingFor(sent, "p-alice2"));
    expect(one).toMatchObject({ route: "user", from: "" });
    expect(sent.some((s) => s.peerId === "p-karel")).toBe(false);
    const a = await open(`/media/tel/client/${one.token}`);
    a.ws.send(JSON.stringify({ type: "audio" }));
    await until(() => liveRoutes()[0]?.members === 1);
    const b = await open(`/media/tel/client/${two.token}`);
    b.ws.send(JSON.stringify({ type: "audio" }));
    await until(() => a.text.some((m) => m.type === "ended" || m.type === "roster") && a.ws.readyState !== WebSocket.OPEN);
    expect(liveRoutes()[0]?.members).toBe(1);
    // The member hangs up: the TSA goes on.
    b.ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => resumed.length === 1);
    expect(resumed[0].ev).toMatchObject({ kind: "route", ok: true });
    provider.ws.close(); b.ws.close();
  }, 20_000);

  it("on Vonage: 16 kHz binary L16 both ways", async () => {
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-karel", name: "Karel" }] });
    setRouteHub(hub);
    const call = { ...liveCall(), provider: "vonage" };
    const r = await telHooks.routeAudio!(call, entry({ type: "user", user: "Karel" }), { mode: "fail", sessionId: "ts_8" });
    if (!r.ok) throw new Error(r.detail);
    expect(r.actions[0]).toMatchObject({ stream: { codec: "L16", rate: 16000 } });
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "websocket:connected", "content-type": "audio/l16;rate=16000" }));
    const karel = await until(() => incomingFor(sent, "p-karel"));
    expect(karel).toMatchObject({ route: "user", from: "+420777000111" });
    const m = await open(`/media/tel/client/${karel.token}`);
    m.ws.send(JSON.stringify({ type: "audio" }));
    await until(() => liveRoutes()[0]?.members === 1);
    for (let i = 0; i < 10; i++) provider.ws.send(audio.pcm16ToLE(audio.tone(400, 20, 16_000, 0.4)));
    await until(() => m.bin.some((b) => level(audio.pcm16FromLE(new Uint8Array(b))) > 0.05));
    for (let i = 0; i < 10; i++) m.ws.send(audio.pcm16ToLE(audio.tone(600, 43, 16_000, 0.4)));
    await until(() => provider.bin.some((b) => b.length === 640 && level(audio.pcm16FromLE(new Uint8Array(b))) > 0.05));
    provider.ws.close(); m.ws.close();
  }, 20_000);

  it("a member by name; an unknown token is not ours (404 from the bridge)", async () => {
    const { hub } = fakeHub({ [ROOM]: [{ peerId: "p-karel", name: "Karel" }] });
    setRouteHub(hub);
    const r = await telHooks.routeAudio!(liveCall(), entry({ type: "user", user: "karel" }), { mode: "fail", sessionId: "ts_7" });
    expect(r).toMatchObject({ ok: true, detail: expect.stringContaining("1 connection") });
    await expect(open("/media/tel/client/AAAAAAAAAAAAAAAAAAAAAAAA")).rejects.toBeTruthy();
  });
});

describe("6.12 review S07/S08: a leg whose member may no longer be reached", () => {
  it("ends — out of the audio, its socket closed, its token forgotten, not offered again; the others keep the call", async () => {
    const { hub, sent } = fakeHub({ [ROOM]: [{ peerId: "p-eva", name: "Eva" }, { peerId: "p-karel", name: "Karel" }] });
    const unreachable = new Set<string>();
    setRouteHub({
      ...hub,
      // As the hub reports them: `reachable` is its verdict (proof), checked again for every leg.
      members: (room: string) => hub.members(room).map((m) => ({ ...m, reachable: !unreachable.has(m.peerId) })),
      reachable: (_room: string, peerId: string) => !unreachable.has(peerId),
    });
    const call = liveCall();
    const r = await telHooks.routeAudio!(call, entry(), { mode: "fail", sessionId: "ts_s08" });
    if (!r.ok) throw new Error(r.detail);
    const provider = await open(streamPath(r.actions));
    provider.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ8" } }));
    const eva = await until(() => incomingFor(sent, "p-eva"));
    const karel = await until(() => incomingFor(sent, "p-karel"));
    const a = await open(`/media/tel/client/${eva.token}`);
    const b = await open(`/media/tel/client/${karel.token}`);
    a.ws.send(JSON.stringify({ type: "audio" }));
    b.ws.send(JSON.stringify({ type: "audio" }));
    await until(() => liveRoutes()[0]?.members === 2);

    // Karel's peer id is now held by a connection that may not be reached (it did not prove in a room that proves).
    unreachable.add("p-karel");
    await until(() => b.text.some((m) => m.type === "ended" && m.reason === "no longer reachable"));
    await until(() => liveRoutes()[0]?.members === 1 && liveRoutes()[0]?.offered === 1);
    await expect(open(`/media/tel/client/${karel.token}`)).rejects.toBeTruthy();
    await sleep(300); // a few polls: not offered again
    expect(sent.filter((s) => s.peerId === "p-karel" && s.payload.event === "incoming")).toHaveLength(1);
    expect(liveRoutes()[0]).toMatchObject({ members: 1, offered: 1 });
    for (const x of [provider, a, b]) x.ws.close();
  }, 20_000);
});
