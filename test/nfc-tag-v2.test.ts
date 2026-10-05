// 6.12 (F-12 of the security analysis): the NFC connection tag v2. A v1 tag
// held the room key under a 4–16 digit PIN (PBKDF2 200 000) — anyone who read
// the tag once could guess the PIN offline. v2 is an invitation reference with
// a 130-bit secret (the key stays sealed on the server) or the room under
// Argon2id of a 100-bit code that is not on the tag. Old tags still open, with
// a "weak" flag. The vectors (test/vectors/nfc-tag-v2.json) are what the
// Android port checks against (docs/protocol-v4.md § 16).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CROCKFORD, INVITE_SECRET_SYMBOLS, OFFLINE_CODE_SYMBOLS, TAG_V2_PREFIX, formatTagCode, generateTagCode, inviteKeys, normalizeBase32,
  openOfflineTag, parseTagV2, safeOrigin, sealOfflineTag, serializeTagV2, type OfflineTag,
} from "../client/src/lib/nfc/tag-v2";
import {
  CONN_MIME, buildInviteConnectionRecords, buildOfflineConnectionRecords, decodeConnectionRecords, inspectConnectionRecords, openConnectionTag, summarizeRecords,
} from "../client/src/lib/nfc/cards/connection-card";
import { mimeRecord, encodeNdefMessage } from "../client/src/lib/nfc/cards/ndef";
import { encryptForTag } from "../client/src/lib/nfc";
import { NfcError } from "../client/src/lib/nfc/errors";
import { fromBase64Url } from "../client/src/lib/share-link";

const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, "vectors", "nfc-tag-v2.json"), "utf8")) as {
  offline: Array<{ kdf: { memoryKiB: number; passes: number }; code: string; canonicalCode: string; plaintext: string; tag: OfflineTag; body: string; argon2idKeyHex: string }>;
  invite: { origin: string; id: string; k: string; body: string; linkKeyHex: string; code: string };
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const FAST = { memoryKiB: 64, passes: 1 };
const ROOM = { room: "brno-secure", passphrase: "tajný klíč 🔐 dlouhý a náhodný", name: "Michal" };

/** /api/share/* as server/share.ts answers it, in memory. */
function shareServer() {
  const links = new Map<string, { proof: string; serverKey: string; iv: string; ciphertext: string; usesLeft: number; revokeToken: string }>();
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string | number>;
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/api/share/create")) {
      links.set(String(body.id), { proof: String(body.proof), serverKey: String(body.serverKey), iv: String(body.iv), ciphertext: String(body.ciphertext), usesLeft: Number(body.maxUses), revokeToken: String(body.revokeToken) });
      return json(201, { ok: true, expiresAt: 1_900_000_000_000, maxUses: body.maxUses, maxAttempts: 5 });
    }
    if (url.endsWith("/api/share/redeem")) {
      const l = links.get(String(body.id));
      if (!l) return json(404, { ok: false, reason: "not-found" });
      if (l.proof !== body.proof) return json(403, { ok: false, reason: "wrong-code", attemptsLeft: 4 });
      if (l.usesLeft <= 0) return json(410, { ok: false, reason: "burned" });
      l.usesLeft--;
      return json(200, { ok: true, serverKey: l.serverKey, iv: l.iv, ciphertext: l.ciphertext, usesLeft: l.usesLeft });
    }
    if (url.endsWith("/api/share/revoke")) {
      const l = links.get(String(body.id));
      if (l && l.revokeToken === body.revokeToken) { links.delete(String(body.id)); return json(200, { ok: true }); }
      return json(404, { ok: false });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { fetcher, links };
}

describe("the format", () => {
  it("codes: Crockford base32 — I, L → 1, O → 0, any grouping; U and other signs refused", () => {
    expect(normalizeBase32("7k3qd-m9x2v ph4tw.8rz6n", 20)).toBe("7K3QDM9X2VPH4TW8RZ6N");
    expect(normalizeBase32("OIL" + "0".repeat(17), 20)).toBe("011" + "0".repeat(17));
    expect(normalizeBase32("U".repeat(20), 20)).toBeNull();
    expect(normalizeBase32("ABC", 20)).toBeNull();
    expect(formatTagCode("7K3QDM9X2VPH4TW8RZ6N")).toBe("7K3QD-M9X2V-PH4TW-8RZ6N");
  });

  it("a fresh offline code: 20 symbols of the alphabet (100 bits), never the same twice", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateTagCode()));
    expect(codes.size).toBe(50);
    for (const c of codes) {
      expect(c).toHaveLength(OFFLINE_CODE_SYMBOLS);
      for (const ch of c) expect(CROCKFORD).toContain(ch);
    }
    expect(OFFLINE_CODE_SYMBOLS * 5).toBeGreaterThanOrEqual(100);
    expect(INVITE_SECRET_SYMBOLS * 5).toBeGreaterThanOrEqual(100);
  });

  it("serialize ↔ parse; malformed bodies and out-of-bounds KDF parameters are refused", () => {
    for (const v of vectors.offline) expect(parseTagV2(v.body)).toEqual(v.tag);
    expect(serializeTagV2(parseTagV2(vectors.invite.body))).toBe(vectors.invite.body);
    expect(() => parseTagV2("m5cet:nfc:v1:AAAA")).toThrow(NfcError);
    expect(() => parseTagV2(`${TAG_V2_PREFIX}{"v":3,"t":"off"}`)).toThrow(/version/);
    const t = vectors.offline[0].tag;
    expect(() => parseTagV2(serializeTagV2({ ...t, m: 1024 * 1024 }))).toThrow(/out of bounds/);
    expect(() => parseTagV2(serializeTagV2({ ...t, i: 50 }))).toThrow(/out of bounds/);
    expect(() => parseTagV2(`${TAG_V2_PREFIX}{"v":2,"t":"inv","o":"http://evil.example","id":"${vectors.invite.id}","k":"${vectors.invite.k}"}`)).toThrow(/malformed/);
    expect(safeOrigin("https://chat.example.org/x?y")).toBe("https://chat.example.org");
    expect(safeOrigin("javascript:alert(1)")).toBeNull();
  });
});

describe("offline tags (Argon2id of a code that is not on the tag)", () => {
  it("the vectors open with their code — the fast one and the real 64 MiB / 3 passes one", async () => {
    for (const v of vectors.offline) {
      expect(v.tag.p).toBe(1);
      const room = await openOfflineTag(v.tag, v.code);
      expect(JSON.stringify(room)).toBe(v.plaintext);
      expect(v.argon2idKeyHex).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(vectors.offline[1].tag.m).toBe(65536);
    expect(vectors.offline[1].tag.i).toBe(3);
  }, 30_000);

  it("a wrong code, or a changed parameter (bound in the AAD), does not open it", async () => {
    const { tag, code } = await sealOfflineTag(ROOM, { kdf: FAST });
    await expect(openOfflineTag(tag, generateTagCode())).rejects.toMatchObject({ code: "auth-failed" });
    await expect(openOfflineTag({ ...tag, i: 2 }, code)).rejects.toMatchObject({ code: "auth-failed" });
    await expect(openOfflineTag(tag, "1234")).rejects.toMatchObject({ code: "invalid-argument" });
    expect(await openOfflineTag(tag, formatTagCode(code).toLowerCase())).toMatchObject({ room: ROOM.room, passphrase: ROOM.passphrase });
  });

  it("writers use the room KDF's cost by default (64 MiB, 3 passes)", async () => {
    const { tag } = await sealOfflineTag({ room: "r", passphrase: "p" });
    expect([tag.m, tag.i, tag.p]).toEqual([65536, 3, 1]);
  }, 30_000);

  it("NDEF records: one MIME record (+ the optional URI); the code is nowhere on the tag; no PIN anywhere", async () => {
    const { records, code } = await buildOfflineConnectionRecords(ROOM, { kdf: FAST, appVersion: "6.12.0", fallbackUrl: "https://m5.cet" });
    expect(records).toHaveLength(2);
    const bytes = new TextDecoder().decode(encodeNdefMessage(records));
    expect(bytes).toContain(CONN_MIME);
    expect(bytes).toContain(TAG_V2_PREFIX);
    expect(bytes).not.toContain(code);
    expect(bytes).not.toContain(ROOM.room);
    expect(inspectConnectionRecords(records)?.kind).toBe("offline");
    expect(summarizeRecords(records)).toMatch(/v2, code/);
    const back = await decodeConnectionRecords(records, code);
    expect(back).toMatchObject({ v: 2, kind: "offline", room: ROOM.room, passphrase: ROOM.passphrase, name: ROOM.name, app: "6.12.0" });
    expect(back.weak).toBeUndefined();
  });
});

describe("invitation tags (a reference and a secret; the key stays on the server)", () => {
  it("the vector: link key and the 12-digit code from HKDF of the secret", async () => {
    const { linkKey, code } = await inviteKeys(vectors.invite.id, vectors.invite.k);
    expect(hex(linkKey)).toBe(vectors.invite.linkKeyHex);
    expect(code).toBe(vectors.invite.code);
    expect(code).toMatch(/^\d{12}$/);
  });

  it("write → read: the tag holds origin, id and secret only; reading redeems the invite", async () => {
    const server = shareServer();
    const { records, tag, invite } = await buildInviteConnectionRecords({ room: ROOM.room, passphrase: ROOM.passphrase }, { origin: "https://chat.example.org", fetcher: server.fetcher, maxUses: 2 });
    const body = new TextDecoder().decode(records[0].payload);
    expect(body).toBe(serializeTagV2(tag));
    expect(body).not.toContain(ROOM.passphrase);
    expect(tag.k).toHaveLength(INVITE_SECRET_SYMBOLS);
    expect(invite.id).toBe(tag.id);
    // What the server stores is sealed: no room key, no code in it.
    const stored = JSON.stringify([...server.links.values()]);
    expect(stored).not.toContain(ROOM.passphrase);
    const info = inspectConnectionRecords(records)!;
    expect(info.kind).toBe("invite");
    const opened = await openConnectionTag(info, { origin: "https://chat.example.org", fetcher: server.fetcher });
    expect(opened).toMatchObject({ v: 2, kind: "invite", room: ROOM.room, passphrase: ROOM.passphrase });
    // The link key comes from the secret: the same invite through the share link API.
    expect(fromBase64Url(invite.url.split(".").pop()!)).toEqual((await inviteKeys(tag.id, tag.k)).linkKey);
  });

  it("runs out like the invite: uses, revocation; another server's invitation is not redeemed from here", async () => {
    const server = shareServer();
    const { records } = await buildInviteConnectionRecords({ room: "r", passphrase: "p" }, { origin: "https://chat.example.org", fetcher: server.fetcher, maxUses: 1 });
    const info = inspectConnectionRecords(records)!;
    await openConnectionTag(info, { origin: "https://chat.example.org", fetcher: server.fetcher });
    await expect(openConnectionTag(info, { origin: "https://chat.example.org", fetcher: server.fetcher })).rejects.toMatchObject({ detail: "burned" });
    await expect(openConnectionTag(info, { origin: "https://other.example", fetcher: server.fetcher })).rejects.toMatchObject({ detail: "https://chat.example.org" });
    // A tag whose secret was altered derives another link key and code: the server refuses it.
    const altered = { ...info, tag: { ...(info as { tag: { k: string } }).tag, k: "Z".repeat(26) } } as typeof info;
    await expect(openConnectionTag(altered, { origin: "https://chat.example.org", fetcher: server.fetcher })).rejects.toBeInstanceOf(NfcError);
  });
});

describe("old v1 tags", () => {
  it("still open with their PIN — flagged weak; the 6.1 Android fixture too", async () => {
    const blob = await encryptForTag("123456", { v: 1, room: "brno-secure", passphrase: "p", name: "Michal" });
    const records = [mimeRecord(CONN_MIME, new TextEncoder().encode(blob))];
    expect(inspectConnectionRecords(records)?.kind).toBe("legacy");
    expect(summarizeRecords(records)).toMatch(/v1 PIN — weak/);
    await expect(openConnectionTag(inspectConnectionRecords(records)!, {})).rejects.toMatchObject({ code: "invalid-argument" });
    expect(await decodeConnectionRecords(records, "123456")).toMatchObject({ v: 1, kind: "legacy", weak: true, room: "brno-secure" });
    await expect(decodeConnectionRecords(records, "654321")).rejects.toThrow();
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", "android-interop.json"), "utf8")) as { nfc: { pin: string; blob: string; card: { room: string } } };
    const old = [mimeRecord(CONN_MIME, new TextEncoder().encode(fixture.nfc.blob))];
    expect(await decodeConnectionRecords(old, fixture.nfc.pin)).toMatchObject({ room: fixture.nfc.card.room, weak: true });
  });
});
