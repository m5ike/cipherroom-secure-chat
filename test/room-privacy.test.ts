// @vitest-environment node
//
// 6.7 (audit S21 / F-10): the room's name — the salt of its key derivation —
// never reaches the server. Only the blind id goes there: for the guest's
// server history, the opt-in analytics on join, and the room of a function
// call (which the server also uses to bind a shared session to its room).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRoomKeys } from "../client/src/lib/envelope";
import { historyRoomsToRead, serverRoomId } from "../client/src/lib/room-privacy";

describe("the room as the server sees it", () => {
  it("is the blind id of v3 keys — never the name", async () => {
    const keys = await deriveRoomKeys("rodina", "correct horse battery staple", { memoryKiB: 64, passes: 1 });
    expect(serverRoomId(keys)).toBe(keys.roomId);
    expect(serverRoomId(keys)).toMatch(/^r3\./);
    expect(serverRoomId(keys)).not.toContain("rodina");
    expect(historyRoomsToRead(keys)).toEqual([keys.roomId]); // not [blind, "rodina"] as 3.0-compatible reads did
  });

  it("v2 keys (whose id IS the plain name) and no keys give nothing to send", async () => {
    const v2 = await deriveRoomKeys("rodina", "pw", { iterations: 1_000 });
    expect(v2.roomId).toBe("rodina");
    expect(serverRoomId(v2)).toBeNull();
    expect(historyRoomsToRead(v2)).toEqual([]);
    expect(serverRoomId(null)).toBeNull();
    expect(serverRoomId({ version: 3, roomId: "rodina" })).toBeNull(); // a v3 key without a blind id is not trusted either
  });
});

describe("App.tsx sends no room name to the server", () => {
  const app = readFileSync(join(__dirname, "../client/src/App.tsx"), "utf8");

  it("the guest's server history is read by the blind id only (the 3.0 read under the plain name is gone)", () => {
    expect(app).not.toMatch(/readServerMessages\(\{\s*room:\s*nextRoom/);
    expect(app).toMatch(/historyRoomsToRead\(keyRef\.current\)/);
  });

  it("function runs, clicks and browser reports name the blind room", () => {
    expect(app).not.toMatch(/room:\s*room\s*\|\|\s*null/);
    expect(app.match(/room: serverRoomId\(keyRef\.current\), client: prefs\.deviceId/g)?.length).toBe(3);
  });

  it("the join analytics and the server-kept rows carry the blind id", () => {
    expect(app).not.toMatch(/kind: "client-join",\s*room: roomRef\.current/);
    expect(app).not.toMatch(/room: keyRef\.current\?\.roomId \?\? currentRoom/);
  });
});
