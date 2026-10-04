// @vitest-environment node
//
// DES/3DES, the retail MAC and BAC (cards/des.ts, cards/bac.ts) pinned to the
// ICAO 9303 Part 11 worked example — the canonical passport (MRZ L898902C<3,
// 690806, 940623). If every value here matches, the key derivation, 3DES-CBC
// and the MAC are correct.

import { describe, it, expect } from "vitest";
import { hex } from "../client/src/lib/nfc/cards/apdu";
import { pad, retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "../client/src/lib/nfc/cards/des";
import { bacKeys, checkDigit, mrzInformation, mutualAuthCommand, mrzKeyFromMrz, protectApdu, sessionFromAuth, unprotectResponse } from "../client/src/lib/nfc/cards/bac";

const b = (h: string) => Uint8Array.from((h.replace(/\s/g, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const H = (u: Uint8Array) => hex(u).toUpperCase();

const KEY = { documentNumber: "L898902C", dateOfBirth: "690806", dateOfExpiry: "940623" };
const RND_ICC = b("4608F91988702212");
const RND_IFD = b("781723860C06C226");
const K_IFD = b("0B795240CB7049B01C19B33E32804F0B");

describe("3DES + retail MAC (ICAO worked example)", () => {
  const KENC = b("AB94FDECF2674FDFB9B391F85D7F76F2");
  const KMAC = b("7962D9ECE03D1ACD4C76089DCE131543");
  const S = b("781723860C06C2264608F919887022120B795240CB7049B01C19B33E32804F0B");
  const EIFD = b("72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F2");

  it("3DES-CBC encrypts and decrypts S", () => {
    expect(H(tdesCbcEncrypt(KENC, S))).toBe(H(EIFD));
    expect(H(tdesCbcDecrypt(KENC, EIFD))).toBe(H(S));
  });

  it("the retail MAC of E.IFD is M.IFD", () => {
    expect(H(retailMac(KMAC, pad(EIFD)))).toBe("5F1448EEA8AD90A7");
  });
});

describe("the MRZ key", () => {
  it("builds the MRZ information with check digits", () => {
    expect(checkDigit("L898902C<")).toBe("3");
    expect(checkDigit("690806")).toBe("1");
    expect(checkDigit("940623")).toBe("6");
    expect(mrzInformation(KEY)).toBe("L898902C<369080619406236");
  });

  it("reads the key fields from a TD3 passport MRZ", () => {
    const mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
    expect(mrzKeyFromMrz(mrz)).toEqual({ documentNumber: "L898902C", dateOfBirth: "690806", dateOfExpiry: "940623" });
  });
});

describe("BAC", () => {
  it("derives Kenc and Kmac from the MRZ (seed = SHA1(MRZ info)[0:16])", async () => {
    const k = await bacKeys(KEY);
    expect(H(k.seed)).toBe("239AB9CB282DAF66231DC5A4DF6BFBAE");
    expect(H(k.kenc)).toBe("AB94FDECF2674FDFB9B391F85D7F76F2");
    expect(H(k.kmac)).toBe("7962D9ECE03D1ACD4C76089DCE131543");
  });

  it("builds the EXTERNAL AUTHENTICATE command data (E.IFD || M.IFD)", async () => {
    const { kenc, kmac } = await bacKeys(KEY);
    const cmd = mutualAuthCommand(kenc, kmac, RND_IFD, RND_ICC, K_IFD);
    expect(H(cmd)).toBe("72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F25F1448EEA8AD90A7");
  });

  it("derives the session keys and SSC from the chip's answer", async () => {
    const { kenc, kmac } = await bacKeys(KEY);
    const response = b("46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449");
    const s = await sessionFromAuth(kenc, kmac, RND_IFD, RND_ICC, K_IFD, response);
    expect(H(s.ksenc)).toBe("979EC13B1CBFE9DCD01AB0FED307EAE5");
    expect(H(s.ksmac)).toBe("F1CB1F1FB5ADF208806B89DC579DC1F8");
    expect(H(s.ssc)).toBe("887022120C06C226");
  });

  it("rejects a wrong MRZ (the chip MAC will not verify)", async () => {
    const { kenc, kmac } = await bacKeys({ ...KEY, dateOfBirth: "700101" });
    const response = b("46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449");
    await expect(sessionFromAuth(kenc, kmac, RND_IFD, RND_ICC, K_IFD, response)).rejects.toThrow();
  });
});

describe("secure messaging (ICAO worked example)", () => {
  // The session after BAC in the worked example.
  const session = () => ({ ksenc: b("979EC13B1CBFE9DCD01AB0FED307EAE5"), ksmac: b("F1CB1F1FB5ADF208806B89DC579DC1F8"), ssc: b("887022120C06C226") });

  it("protects SELECT EF.COM and reads back the status", () => {
    const s = session();
    expect(H(protectApdu(s, b("00A4020C02011E")))).toBe("0CA4020C158709016375432908C044F68E08BF8B92D635FF24F800");
    expect(H(s.ssc)).toBe("887022120C06C227");
    const r = unprotectResponse(s, b("990290008E08FA855A5D4C50A8ED9000"));
    expect(r.sw).toBe(0x9000);
    expect(r.data.length).toBe(0);
    expect(H(s.ssc)).toBe("887022120C06C228");
  });

  it("protects READ BINARY and decrypts the response data", () => {
    const s = { ksenc: b("979EC13B1CBFE9DCD01AB0FED307EAE5"), ksmac: b("F1CB1F1FB5ADF208806B89DC579DC1F8"), ssc: b("887022120C06C228") };
    expect(H(protectApdu(s, b("00B0000004")))).toBe("0CB000000D9701048E08ED6705417E96BA5500");
    const r = unprotectResponse(s, b("8709019FF0EC34F9922651990290008E08AD55CC17140B2DED4B9000"));
    expect(r.sw).toBe(0x9000);
    expect(H(r.data).startsWith("60145F01")).toBe(true); // EF.COM: tag 60, len 14, LDS version tag 5F01…
  });
});
