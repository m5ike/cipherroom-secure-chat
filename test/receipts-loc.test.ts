// 6.1: receipts between online peers and the position in a message's header
// (the Android app sends both; the web shows them).

import { describe, it, expect } from "vitest";
import { validatePayload, validateLoc } from "../client/src/lib/validate";

const base = { id: "rcpt-1", createdAt: 1_760_000_000_000, senderId: "peer-a", senderName: "Alice" };

describe("receipts", () => {
  it("are returned only to callers that ask for them", () => {
    const r = { ...base, kind: "receipt", state: "read", ids: ["msg-1", "msg-2"] };
    expect(validatePayload(r, { transportSender: "peer-a", now: base.createdAt })).toBeNull();
    expect(validatePayload(r, { transportSender: "peer-a", now: base.createdAt, receipts: true })).toMatchObject({ kind: "receipt", state: "read", ids: ["msg-1", "msg-2"] });
  });

  it("are bounded and checked", () => {
    const many = Array.from({ length: 80 }, (_, i) => `msg-${i}`);
    const r = validatePayload({ ...base, kind: "receipt", state: "delivered", ids: [...many, 7, "", "x".repeat(81)] }, { receipts: true, now: base.createdAt });
    expect(r && r.kind === "receipt" ? r.ids.length : 0).toBe(50);
    expect(validatePayload({ ...base, kind: "receipt", state: "seen", ids: ["m"] }, { receipts: true })).toBeNull();
    expect(validatePayload({ ...base, kind: "receipt", state: "read", ids: [] }, { receipts: true })).toBeNull();
    expect(validatePayload({ ...base, kind: "receipt", state: "read", ids: ["m"] }, { receipts: true, transportSender: "peer-b" })).toBeNull();
  });
});

describe("loc", () => {
  it("keeps a valid position, rounded to 5 decimals", () => {
    expect(validateLoc({ lat: 50.0874654321, lon: 14.4212349876, acc: 12.4, at: 1_760_000_000_000 })).toEqual({ lat: 50.08747, lon: 14.42123, acc: 12, at: 1_760_000_000_000 });
    const p = validatePayload({ ...base, id: "msg-1", text: "hi", loc: { lat: 1, lon: 2 } }, { now: base.createdAt });
    expect(p && "loc" in p ? p.loc : null).toEqual({ lat: 1, lon: 2 });
  });

  it("drops out-of-range or malformed positions", () => {
    for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: "1", lon: 2 }, { lat: Number.NaN, lon: 1 }, null, 5]) expect(validateLoc(bad)).toBeUndefined();
    expect(validateLoc({ lat: 1, lon: 1, acc: -3 })).toEqual({ lat: 1, lon: 1 });
  });
});
