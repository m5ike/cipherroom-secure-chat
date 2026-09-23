// @vitest-environment node
//
// Untrusted payloads (client/src/lib/validate.ts): what a peer sends is
// checked, bounded and coerced before it reaches the conversation.

import { describe, it, expect } from "vitest";
import { safeFileName, safeMime, validateAttachment, validatePayload } from "../client/src/lib/validate";

const base = { id: "msg-1", text: "hi", createdAt: 1_000, senderId: "p-alice", senderName: "Alice" };

describe("payloads", () => {
  it("accepts a well-formed message", () => {
    expect(validatePayload(base, { transportSender: "p-alice", myId: "p-me", now: 2_000 })).toMatchObject(base);
  });

  it("refuses a sender id that is not the channel's, or is ours, or is the app's own", () => {
    expect(validatePayload(base, { transportSender: "p-bob" })).toBeNull();
    expect(validatePayload({ ...base, senderId: "p-me" }, { myId: "p-me" })).toBeNull();
    expect(validatePayload({ ...base, senderId: "system" })).toBeNull();
  });

  it("refuses fields of the wrong type instead of crashing the render", () => {
    expect(validatePayload({ ...base, text: { html: "<b>" } })).toBeNull();
    expect(validatePayload({ ...base, id: 42 })).toBeNull();
    expect(validatePayload(null)).toBeNull();
    expect(validatePayload({ ...base, text: "" })).toBeNull(); // nothing to show
  });

  it("clamps a timestamp from the future and strips control characters from names", () => {
    const p = validatePayload({ ...base, createdAt: 10 ** 15, senderName: "Al\u0000ice\u0007" }, { now: 5_000 });
    expect(p).toMatchObject({ createdAt: 5_000 + 5 * 60 * 1000, senderName: "Alice" });
  });

  it("keeps only known flags, in range", () => {
    const p = validatePayload({ ...base, flags: { tap: true, vanishSeconds: 10 ** 9, evil: "x", sealed: { salt: "c2FsdA==", iv: "aXY=", v: 2, it: 1 } } });
    expect(p && "flags" in p ? p.flags : null).toEqual({ tap: true, vanishSeconds: 7200, sealed: { salt: "c2FsdA==", iv: "aXY=", v: 2 } });
  });
});

describe("attachments", () => {
  it("only take data: URLs and relabel them with a safe type", () => {
    expect(validateAttachment({ kind: "file", name: "x", mime: "text/html", size: 3, dataUrl: "blob:https://evil/1" })).toBeUndefined();
    expect(validateAttachment({ kind: "file", name: "x", mime: "text/html", size: 3, dataUrl: "https://evil/x" })).toBeUndefined();
    const html = validateAttachment({ kind: "file", name: "x.html", mime: "text/html", size: 3, dataUrl: "data:text/html;base64,PGI+" });
    expect(html).toMatchObject({ kind: "file", mime: "application/octet-stream", dataUrl: "data:application/octet-stream;base64,PGI+" });
    const svg = validateAttachment({ kind: "image", name: "x.svg", mime: "image/svg+xml", size: 3, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" });
    expect(svg).toMatchObject({ kind: "file", mime: "application/octet-stream" });
    const png = validateAttachment({ kind: "image", name: "a.png", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,iVBO" });
    expect(png).toMatchObject({ kind: "image", mime: "image/png", dataUrl: "data:image/png;base64,iVBO" });
  });

  it("makes names harmless", () => {
    expect(safeFileName("../../etc/passwd")).toBe("__.._etc_passwd");
    expect(safeFileName("rechnung‮fdp.exe")).toBe("rechnung_fdp.exe");
    expect(safeFileName("")).toBe("file");
    expect(safeMime("IMAGE/PNG; charset=x")).toBe("image/png");
  });
});
