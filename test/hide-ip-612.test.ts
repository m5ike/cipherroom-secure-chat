// @vitest-environment node
//
// 6.12 (F-15 of the security analysis): peers saw each other's IP address —
// iceTransportPolicy "all" and Google's STUN. Now the server's own STUN / TURN
// come first (the public STUN only when the server offers none), and "Hide my
// IP address from other members" makes peer connections relay-only where the
// server offers TURN.

import { describe, it, expect, afterEach } from "vitest";
import { _resetRtcForTests, effectiveRtcConfig, freshRtcConfig, hasTurn, loadTurnConfig, setHideIp, turnAvailable } from "../client/src/lib/rtc";

afterEach(() => _resetRtcForTests());
const answer = (iceServers: unknown[]) => (async () => new Response(JSON.stringify({ ok: true, iceServers }), { status: 200 })) as unknown as typeof fetch;

describe("F-15: ICE servers and hiding the IP address", () => {
  it("the server's own STUN / TURN replace the public STUN; the public one is only the fallback", async () => {
    expect(effectiveRtcConfig().iceServers).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    await loadTurnConfig(answer([{ urls: ["stun:stun.example.org:3478"] }]));
    expect(effectiveRtcConfig().iceServers).toEqual([{ urls: ["stun:stun.example.org:3478"] }]);
    expect(turnAvailable()).toBe(false);
  });

  it("relay-only when asked and the server offers TURN; without TURN nothing changes", async () => {
    setHideIp(true);
    await loadTurnConfig(answer([{ urls: ["stun:s.example.org"] }]));
    expect(effectiveRtcConfig().iceTransportPolicy).toBe("all"); // no TURN: cannot hide, connections stay
    await loadTurnConfig(answer([{ urls: ["stun:s.example.org"] }, { urls: ["turns:turn.example.org:5349"], username: "u", credential: "c" }]));
    expect(turnAvailable()).toBe(true);
    expect((await freshRtcConfig()).iceTransportPolicy).toBe("relay");
    setHideIp(false);
    expect((await freshRtcConfig()).iceTransportPolicy).toBe("all");
    expect(hasTurn([{ urls: "turn:x" }])).toBe(true);
    expect(hasTurn([{ urls: ["stun:x"] }])).toBe(false);
  });
});
