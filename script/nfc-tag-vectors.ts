// Test vectors of the NFC connection tag v2 (docs/protocol-v4.md § 16) for the
// Android port: written by the web reference implementation
// (client/src/lib/nfc/tag-v2.ts), checked by test/nfc-tag-v2.test.ts.
//
//   npx tsx script/nfc-tag-vectors.ts      → test/vectors/nfc-tag-v2.json

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { inviteKeys, sealOfflineTag, serializeTagV2, b64url } from "../client/src/lib/nfc/tag-v2";
import { runKdfInline } from "../client/src/lib/kdf";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (n: number, start: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

async function main() {
  const room = { room: "brno-secure", passphrase: "Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e", name: "Alice" };
  const offline = [];
  for (const kdf of [{ memoryKiB: 64, passes: 1 }, { memoryKiB: 65536, passes: 3 }]) {
    const salt = bytes(16, 0x10);
    const iv = bytes(12, 0xa0);
    const code = "7K3QD-M9X2V-PH4TW-8RZ6N";
    const { tag, code: canonical } = await sealOfflineTag(room, { code, kdf, salt, iv });
    const key = await runKdfInline({ kdf: "argon2id", password: canonical, salt: tag.s, memoryKiB: tag.m, passes: tag.i });
    offline.push({
      kdf, code, canonicalCode: canonical, saltHex: hex(salt), ivHex: hex(iv), argon2idKeyHex: hex(key),
      aad: `m5cet/nfc-tag/2|off|argon2id|${tag.m}|${tag.i}|1|${tag.s}`,
      plaintext: JSON.stringify({ room: room.room, passphrase: room.passphrase, name: room.name }),
      tag, body: serializeTagV2(tag),
    });
  }
  const id = b64url(bytes(16, 0x40));
  const k = "0123456789ABCDEFGHJKMNPQRS";
  const keys = await inviteKeys(id, k);
  const invite = {
    origin: "https://chat.example.org", id, k,
    body: serializeTagV2({ v: 2, t: "inv", o: "https://chat.example.org", id, k }),
    linkKeyHex: hex(keys.linkKey), code: keys.code,
  };
  const out = { spec: "docs/protocol-v4.md § 16", generatedBy: "script/nfc-tag-vectors.ts", offline, invite };
  const dir = resolve(import.meta.dirname, "..", "test", "vectors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "nfc-tag-v2.json"), `${JSON.stringify(out, null, 1)}\n`);
  console.log("wrote test/vectors/nfc-tag-v2.json");
}
void main();
