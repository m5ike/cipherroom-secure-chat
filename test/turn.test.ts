// @vitest-environment node
//
// ICE servers (server/turn.ts + client/src/lib/rtc.ts): short-lived TURN
// credentials in coturn's REST API format, and a client that fetches new
// ones before they run out.

import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { ephemeralCredentials, turnAnswer } from "../server/turn";
import { freshRtcConfig, loadTurnConfig, _resetRtcForTests } from "../client/src/lib/rtc";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; _resetRtcForTests(); });

describe("server", () => {
  it("answers with STUN only when no TURN server is configured", () => {
    delete process.env.TURN_SERVER_URL;
    expect(turnAnswer()).toMatchObject({ ok: true, configured: false, mode: "none", iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
  });

  it("issues per-visitor credentials that coturn can verify and that expire", () => {
    process.env.TURN_SERVER_URL = "turn:turn.example.com:3478,turns:turn.example.com:5349";
    process.env.TURN_SECRET = "s3cret";
    process.env.TURN_TTL_SECONDS = "600";
    const now = 1_800_000_000_000;
    const a = turnAnswer(now);
    const b = turnAnswer(now);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a).toMatchObject({ mode: "ephemeral", ttlSeconds: 600, expiresAt: now + 600_000 });
    const turn = a.iceServers.find((s) => s.username)!;
    expect(turn.urls).toEqual(["turn:turn.example.com:3478", "turns:turn.example.com:5349"]);
    const [expiry] = turn.username!.split(":");
    expect(Number(expiry)).toBe(now / 1000 + 600);
    expect(turn.credential).toBe(createHmac("sha1", "s3cret").update(turn.username!).digest("base64"));
    // Every visitor gets different ones.
    expect(b.iceServers.find((s) => s.username)!.username).not.toBe(turn.username);
  });

  it("still serves static credentials, and refuses half a configuration", () => {
    process.env.TURN_SERVER_URL = "turn:t.example:3478";
    delete process.env.TURN_SECRET;
    process.env.TURN_USERNAME = "u";
    process.env.TURN_CREDENTIAL = "c";
    expect(turnAnswer()).toMatchObject({ ok: true, mode: "static" });
    delete process.env.TURN_CREDENTIAL;
    expect(turnAnswer()).toMatchObject({ ok: false, status: 503 });
  });

  it("clamps the lifetime", () => {
    expect(ephemeralCredentials("x", 0, 60).expiresAt).toBe(60_000);
  });
});

describe("client", () => {
  it("fetches new credentials shortly before the old ones expire", async () => {
    let calls = 0;
    const answer = (expiresAt: number) => ({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:x", username: `u${calls}`, credential: "c" }], expiresAt }) });
    const fetcher = (async () => { calls += 1; return answer(calls === 1 ? 1_000_000 : 9_000_000); }) as unknown as typeof fetch;
    await loadTurnConfig(fetcher);
    expect(calls).toBe(1);
    // Far from expiry: nothing to do.
    await freshRtcConfig(100_000, fetcher);
    expect(calls).toBe(1);
    // Within five minutes of it: fetched again.
    const config = await freshRtcConfig(1_000_000 - 60_000, fetcher);
    expect(calls).toBe(2);
    expect((config.iceServers![0] as RTCIceServer).username).toBe("u2");
  });
});
