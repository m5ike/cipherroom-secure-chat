// @vitest-environment node
//
// The account root on the client (client/src/lib/passkey.ts, recovery.ts,
// identity.ts): sealing the root for another passkey or a recovery code,
// the recovery code itself, and the account key that vouches for devices.

import { describe, it, expect } from "vitest";
import { deriveAccountKeys, openRoot, sealRoot, WRAP_INFO } from "../client/src/lib/passkey";
import { generateRecoveryCode, normalizeRecoveryCode, recoveryMaterial } from "../client/src/lib/recovery";
import { accountSigningKey, certifyDevice, loadIdentity, verifyDeviceCert, _resetIdentityForTests } from "../client/src/lib/identity";
import { deriveRoomKeys, openMessage, sealMessage } from "../client/src/lib/envelope";

const root = () => crypto.getRandomValues(new Uint8Array(32));

describe("sealed root", () => {
  it("opens with the right secret only, and yields the same keys", async () => {
    const r = root();
    const phone = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealRoot(r, phone, WRAP_INFO.passkey);
    const back = await openRoot(sealed, phone, WRAP_INFO.passkey);
    expect(back).toEqual(r);
    await expect(openRoot(sealed, crypto.getRandomValues(new Uint8Array(32)), WRAP_INFO.passkey)).rejects.toThrow();
    // A passkey-sealed root does not open as a recovery one.
    await expect(openRoot(sealed, phone, WRAP_INFO.recovery)).rejects.toThrow();
    const a = await deriveAccountKeys(r);
    const b = await deriveAccountKeys(back);
    expect(a.databaseKey).toBe(b.databaseKey);
    expect(a.databaseKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("recovery code", () => {
  it("is 26 Crockford characters in groups, and forgiving when typed", async () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}-[0-9A-HJKMNP-TV-Z]$/);
    const typed = code.toLowerCase().replace(/-/g, " ").replace(/1/g, "l").replace(/0/g, "o");
    expect(normalizeRecoveryCode(typed)).toBe(code.replace(/-/g, ""));
    expect(normalizeRecoveryCode("too-short")).toBeNull();
    const a = await recoveryMaterial(code);
    const b = await recoveryMaterial(typed);
    expect(a).toEqual(b);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a.verifier).toMatch(/^[0-9a-f]{64}$/);
    // The server only learns id and verifier; neither is the proof or the secret.
    expect(a.verifier).not.toContain(a.proof);
    expect((await recoveryMaterial(generateRecoveryCode())).id).not.toBe(a.id);
  });
});

describe("account key", () => {
  it("is the same on every device of the account and vouches for a device", async () => {
    const r = root();
    const one = await accountSigningKey(r);
    const two = await accountSigningKey(r);
    expect(one.publicKey).toBe(two.publicKey);
    expect((await accountSigningKey(root())).publicKey).not.toBe(one.publicKey);

    _resetIdentityForTests();
    const device = await loadIdentity();
    const attestation = await certifyDevice(two.privateKey, two.publicKey, device.publicKey);
    expect(await verifyDeviceCert(attestation, device.publicKey)).toBe(true);
    _resetIdentityForTests();
    const other = await loadIdentity();
    expect(await verifyDeviceCert(attestation, other.publicKey)).toBe(false);
  });

  it("travels inside the envelope and is checked by the reader", async () => {
    const keys = await deriveRoomKeys("alpha", "pw", { iterations: 1_000 });
    const account = await accountSigningKey(root());
    _resetIdentityForTests();
    const device = await loadIdentity();
    device.attestation = await certifyDevice(account.privateKey, account.publicKey, device.publicKey);
    const env = await sealMessage(keys, "m1", { id: "m1", text: "hi" }, device);
    const opened = await openMessage(keys, env);
    expect(opened.signer).toMatchObject({ valid: true, account: { publicKey: account.publicKey, valid: true } });

    // Someone else's device claiming that account: the certificate fails.
    _resetIdentityForTests();
    const impostor = await loadIdentity();
    impostor.attestation = device.attestation;
    const forged = await openMessage(keys, await sealMessage(keys, "m2", { id: "m2", text: "hi" }, impostor));
    expect(forged.signer?.account).toMatchObject({ valid: false });
  });
});
