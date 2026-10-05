import { describe, expect, it } from "vitest";
import {
  b64, checkBundle, createBundle, Mailbox, mailboxSet, MAILBOX_KEEP_MS, MAILBOX_LIFETIME_MS, MAILBOX_RENEW_BEFORE_MS, MemoryBundleStore,
  sealMailboxItem, systemRng, unb64, type MailboxItem,
} from "../client/src/lib/p4";
import { ROOM, testDevice } from "./p4-support";

const T0 = Date.UTC(2026, 9, 1);
const payload = (id: string) => ({ id, kind: "text", text: `queued ${id}`, createdAt: T0 });

async function member() {
  const device = await testDevice();
  const store = new MemoryBundleStore();
  const mailbox = new Mailbox(store, device.signer);
  return { device, store, mailbox };
}

async function sealed() {
  const s = await member();
  const r = await member();
  const rb = await r.mailbox.current(T0);
  const item = await s.mailbox.seal({ roomId: ROOM, id: "m1", payload: payload("m1"), recipient: { pk: r.device.pk, bundle: rb.bundle }, senderPk: s.device.pk, now: T0 });
  return { s, r, rb, item };
}

const flip = (v: string, at = 4) => { const x = unb64(v); x[at] ^= 1; return b64(x); };

describe("p4 mailbox", () => {
  it("seals for one recipient device and opens it there", async () => {
    const { s, r, item } = await sealed();
    expect(item.kind).toBe("mb");
    const opened = await r.mailbox.open<ReturnType<typeof payload>>(item, ROOM, T0 + 1000);
    expect(opened?.payload).toEqual(payload("m1"));
    expect(opened?.spk).toBe(s.device.pk);
    expect(opened?.senderBundle).toEqual((await s.mailbox.current(T0)).bundle);
    expect(unb64(item.c).length).toBe(256 + 16); // padded
  });

  it("is not for another device", async () => {
    const { item } = await sealed();
    const other = await member();
    await other.mailbox.current(T0);
    expect(await other.mailbox.open(item, ROOM, T0)).toBeNull();
  });

  it("rejects every tampered field and another room", async () => {
    const { r, item } = await sealed();
    const other = await testDevice();
    const variants: Array<[string, MailboxItem]> = [
      ["id", { ...item, id: "m2" }],
      ["spk", { ...item, spk: other.pk }],
      ["sb.exp", { ...item, sb: { ...item.sb, exp: item.sb.exp + 1 } }],
      ["e", { ...item, e: other.dh }],
      ["kct", { ...item, kct: flip(item.kct) }],
      ["c", { ...item, c: flip(item.c) }],
    ];
    for (const [name, bad] of variants) {
      await expect(r.mailbox.open(bad, ROOM, T0), name).rejects.toBeTruthy();
    }
    await expect(r.mailbox.open(item, "r3.another-room", T0)).rejects.toMatchObject({ code: "aead" });
    expect((await r.mailbox.open(item, ROOM, T0))?.payload).toEqual(payload("m1"));
  });

  it("authenticates the sender: someone without the sender bundle's key cannot pass as them", async () => {
    const { s, r, rb } = await sealed();
    const mallory = await member();
    const mb = await mallory.mailbox.current(T0);
    const sb = (await s.mailbox.current(T0)).bundle;
    // Mallory claims Alice's (public, signed) bundle but only has her own private key.
    const forged = await sealMailboxItem({ roomId: ROOM, id: "f", payload: payload("f"), recipient: { pk: r.device.pk, bundle: rb.bundle }, senderPk: s.device.pk, now: T0 }, { ...mb, bundle: sb });
    await expect(r.mailbox.open(forged, ROOM, T0)).rejects.toMatchObject({ code: "aead" });
  });

  it("refuses to seal to a tampered or expired recipient bundle", async () => {
    const s = await member();
    const r = await member();
    const rb = (await r.mailbox.current(T0)).bundle;
    const base = { roomId: ROOM, id: "m", payload: payload("m"), senderPk: s.device.pk, now: T0 };
    await expect(s.mailbox.seal({ ...base, recipient: { pk: r.device.pk, bundle: { ...rb, exp: rb.exp + 1 } } })).rejects.toMatchObject({ code: "signature" });
    await expect(s.mailbox.seal({ ...base, recipient: { pk: s.device.pk, bundle: rb } })).rejects.toMatchObject({ code: "signature" });
    await expect(s.mailbox.seal({ ...base, now: rb.exp, recipient: { pk: r.device.pk, bundle: rb } })).rejects.toMatchObject({ code: "expired" });
    await expect(s.mailbox.seal({ ...base, payload: payload("other"), recipient: { pk: r.device.pk, bundle: rb } })).rejects.toMatchObject({ code: "id-mismatch" });
    expect(await checkBundle({ ...rb, kem: b64(new Uint8Array(5)) }, r.device.pk, T0)).toBe("malformed");
  });

  it("renews a day before expiry and keeps opening items to the old bundle until its keys are wiped", async () => {
    const { r, rb, item } = await sealed();
    const renewAt = rb.bundle.exp - MAILBOX_RENEW_BEFORE_MS;
    expect((await r.mailbox.maintain(renewAt - 1)).created).toBeNull();
    const renewed = await r.mailbox.maintain(renewAt);
    expect(renewed.created).not.toBeNull();
    expect((await r.mailbox.current(renewAt)).bundle.id).toBe(renewed.created!.id);
    // After expiry, still within the relay's retention: opens.
    expect((await r.mailbox.open(item, ROOM, rb.bundle.exp + MAILBOX_KEEP_MS - 1))?.payload).toEqual(payload("m1"));
    // Past it: refused even before maintain() ran, and maintain wipes the keys.
    await expect(r.mailbox.open(item, ROOM, rb.bundle.exp + MAILBOX_KEEP_MS)).rejects.toMatchObject({ code: "wiped" });
    const swept = await r.mailbox.maintain(rb.bundle.exp + MAILBOX_KEEP_MS);
    expect(swept.wiped).toContain(rb.bundle.id);
    expect(rb.kemDk.every((x) => x === 0)).toBe(true);
    expect(await r.mailbox.open(item, ROOM, rb.bundle.exp + MAILBOX_KEEP_MS)).toBeNull();
  });

  it("opens the item for this device out of an account's mb-set", async () => {
    const s = await member();
    const phone = await member();
    const laptop = await member();
    const items = [];
    for (const d of [phone, laptop]) {
      const b = (await d.mailbox.current(T0)).bundle;
      items.push(await s.mailbox.seal({ roomId: ROOM, id: "m9", payload: payload("m9"), recipient: { pk: d.device.pk, bundle: b }, senderPk: s.device.pk, now: T0 }));
    }
    const set = mailboxSet("m9", items);
    expect((await phone.mailbox.open(set, ROOM, T0))?.payload).toEqual(payload("m9"));
    expect((await laptop.mailbox.open(set, ROOM, T0))?.payload).toEqual(payload("m9"));
    expect(() => mailboxSet("other", items)).toThrow();
    await expect(phone.mailbox.open({ ...set, id: "x" }, ROOM, T0)).rejects.toMatchObject({ code: "malformed" });
  });

  it("makes bundles that expire after MAILBOX_LIFETIME_MS and verify with the device key", async () => {
    const d = await testDevice();
    const keys = await createBundle(d.signer, T0, systemRng);
    expect(keys.bundle.exp).toBe(T0 + MAILBOX_LIFETIME_MS);
    expect(unb64(keys.bundle.kem).length).toBe(1184);
    expect(await checkBundle(keys.bundle, d.pk, T0)).toBeNull();
    expect(await checkBundle(keys.bundle, d.pk, keys.bundle.exp)).toBe("expired");
    expect(await checkBundle({ ...keys.bundle, sig: flip(keys.bundle.sig) }, d.pk, T0)).toBe("bad-signature");
  });
});
