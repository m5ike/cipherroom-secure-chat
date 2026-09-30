// The web executor (web-executor.ts, task 7): a catalogue op id → an
// operation on a fake transport → an NfcResult. Also checks the two hard
// rules: no key/PIN ever leaves in the result, and writes are denied unless
// the platform allows them.

import { describe, it, expect, vi } from "vitest";
import type { CardTransport, CardIdentity } from "../client/src/lib/nfc/transport";
import { hex, unhex } from "../client/src/lib/nfc/cards/apdu";
import { buildCard, cardKeys, type M5Record } from "../client/src/lib/nfc/m5card";
import { containerRecord } from "../client/src/lib/nfc/m5cet-card";
import { createWebExecutor } from "../client/src/lib/nfc/web-executor";
import type { NfcCommand } from "../client/src/lib/nfc/command";

const KEY_FF = "FFFFFFFFFFFF";
const PPSE_FCI = "6F1B840E325041592E5359532E4444463031A5094F07A00000000310109000";

function fakeTransport(identity: CardIdentity): CardTransport {
  const blocks = new Map<number, Uint8Array>();
  for (let b = 0; b < 64; b++) blocks.set(b, new Uint8Array(16).fill(b));
  return {
    id: "webusb-ccid",
    label: "mock",
    capabilities: { apdu: true, raw: true, mifareAuth: true, ndefOnly: false, emulate: false, write: true },
    isSupported: () => true,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    waitForCard: async () => identity,
    transmit: async () => unhex(PPSE_FCI),
    onDisconnect: () => () => {},
    async mifareAuth(_block, keyType, key) { return keyType === "A" && hex(key) === KEY_FF; },
    async transceiveRaw(frame) {
      if (frame[0] === 0x30) return blocks.get(frame[1]) ?? new Uint8Array(16);
      return Uint8Array.from([0x0a]);
    },
  };
}

const plainId: CardIdentity = { uid: Uint8Array.from([0x04, 0xa1, 0xb2, 0xc3]), sak: 0x08, tech: "iso14443a", isoDep: false, hints: [] };

async function m5Identity(): Promise<CardIdentity> {
  const rec: M5Record = { id: 0, type: "wifi", mode: "external", data: { ssid: "M5cet", password: "secret-pw" } };
  const bytes = await buildCard([rec], cardKeys("123456", null));
  return { uid: Uint8Array.from([9, 9, 9, 9]), tech: "iso14443a", isoDep: false, hints: [], ndef: [containerRecord(bytes)] };
}

describe("web executor: reads", () => {
  it("read-uid returns the card identity", async () => {
    const exec = createWebExecutor({ getTransport: () => fakeTransport(plainId) });
    const res = await exec({ op: "read-uid" });
    expect(res.status).toBe("ok");
    expect(res.card?.uid).toBe("04A1B2C3");
    expect(res.card?.tech).toBe("mifare-classic-1k");
  });

  it("scan reports the card and any M5Cet records (summaries only)", async () => {
    const t = fakeTransport(await m5Identity());
    const exec = createWebExecutor({ getTransport: () => t });
    const res = await exec({ op: "scan" });
    expect(res.status).toBe("ok");
    expect(res.records?.[0]).toMatchObject({ type: "wifi", oneTime: false });
    // The SSID / password never leave in a scan.
    expect(JSON.stringify(res)).not.toContain("secret-pw");
    expect(JSON.stringify(res)).not.toContain("M5cet");
  });

  it("m5-read lists the sealed records without opening them", async () => {
    const t = fakeTransport(await m5Identity());
    const exec = createWebExecutor({ getTransport: () => t });
    const res = await exec({ op: "m5-read" });
    expect(res.status).toBe("ok");
    expect(res.records).toHaveLength(1);
    expect(res.records![0].summary).toBe("wifi");
  });

  it("classic-dump returns block data but never the keys", async () => {
    const exec = createWebExecutor({ getTransport: () => fakeTransport(plainId), resolveKeys: () => [] });
    const res = await exec({ op: "classic-dump" });
    expect(res.status).toBe("ok");
    expect(res.data).toBeTruthy();
    expect(res.message).toMatch(/blocks read/i);
    // The key that opened the sectors must not appear anywhere in the result.
    expect(JSON.stringify(res)).not.toContain(KEY_FF);
  });

  it("emv-public reads the PPSE candidate list", async () => {
    const exec = createWebExecutor({ getTransport: () => fakeTransport({ ...plainId, sak: 0x20, isoDep: true }) });
    const res = await exec({ op: "emv-public", tech: "emv" });
    expect(res.status).toBe("ok");
    expect(res.message).toMatch(/AIDs|EMV/i);
  });

  it("raw-apdu transmits and reports the status word", async () => {
    const exec = createWebExecutor({ getTransport: () => fakeTransport({ ...plainId, sak: 0x20, isoDep: true }) });
    const res = await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "00A404000E325041592E5359532E444446303100" } });
    expect(res.status).toBe("ok");
    expect(res.message).toMatch(/OK|SW/);
  });
});

describe("web executor: guards", () => {
  it("is unsupported when no reader is connected", async () => {
    const exec = createWebExecutor({ getTransport: () => null });
    const res = await exec({ op: "scan" });
    expect(res.status).toBe("unsupported");
  });

  it("denies a write op unless the platform allows writes", async () => {
    const exec = createWebExecutor({ getTransport: () => fakeTransport(plainId) });
    const res = await exec({ op: "ndef-write", tech: "ndef" } as NfcCommand);
    expect(res.status).toBe("denied");
  });

  it("rejects an op the presented technology does not support", async () => {
    const exec = createWebExecutor({ getTransport: () => fakeTransport(plainId) });
    // A 1K classic card asked for a DESFire op.
    const res = await exec({ op: "desfire-apps", tech: "mifare-classic-1k" });
    expect(res.status).toBe("unsupported");
  });

  it("times out cleanly when no card arrives", async () => {
    const t = fakeTransport(plainId);
    t.waitForCard = vi.fn(async () => { const e = new Error("Timeout"); (e as { name: string }).name = "TimeoutError"; throw Object.assign(e, { code: "timeout" }); }) as CardTransport["waitForCard"];
    const exec = createWebExecutor({ getTransport: () => t });
    const res = await exec({ op: "scan" });
    expect(["timeout", "error"]).toContain(res.status);
  });
});
