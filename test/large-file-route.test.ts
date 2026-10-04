// @vitest-environment node
// 6.8 — a large file (over the inline limit) for chosen people went to the
// whole room: sendPickedFile called sendLargeFileToAll, which used every open
// channel, or the server's relay (which reaches the whole room). Now only the
// chosen peers' direct channels carry it, and never the relay.

import { describe, it, expect } from "vitest";
import { largeFileRoute } from "../client/src/lib/file-transfer";

type Ch = { readyState: string; name: string };
const ch = (name: string, readyState = "open"): Ch => ({ name, readyState });
const peers = (entries: Array<[string, Ch | null]>) => entries.map(([id, c]) => [id, { channel: c }] as [string, { channel: Ch | null }]);

describe("largeFileRoute", () => {
  it("to the whole room: every open channel", () => {
    const r = largeFileRoute(peers([["a", ch("a")], ["b", ch("b", "connecting")], ["c", ch("c")]]));
    expect(r.channels.map((c) => c.name)).toEqual(["a", "c"]);
    expect(r).toMatchObject({ relay: false, refused: false });
  });

  it("to the whole room without a direct channel: the server's relay", () => {
    expect(largeFileRoute(peers([["a", null], ["b", ch("b", "closed")]]))).toMatchObject({ channels: [], relay: true, refused: false });
  });

  it("to chosen people: only their channels", () => {
    const r = largeFileRoute(peers([["a", ch("a")], ["b", ch("b")], ["c", ch("c")]]), new Set(["b"]));
    expect(r.channels.map((c) => c.name)).toEqual(["b"]);
    expect(r).toMatchObject({ relay: false, refused: false });
  });

  it("to chosen people without a direct channel: refused, never the relay", () => {
    expect(largeFileRoute(peers([["a", ch("a")], ["b", null]]), new Set(["b"]))).toMatchObject({ channels: [], relay: false, refused: true });
    expect(largeFileRoute(peers([["a", ch("a")]]), new Set())).toMatchObject({ relay: false, refused: true });
  });
});
