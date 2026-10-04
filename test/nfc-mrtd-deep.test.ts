// @vitest-environment node
//
// The deep MRTD read (6.6) against a simulated chip that runs BAC and 3DES
// secure messaging the way ICAO 9303-11 specifies — the chip side here is
// written from the spec, independently of the reader: it checks every MAC,
// decrypts every command and answers only SELECT / READ BINARY. The reader
// opens it with the MRZ, reads EF.COM, EF.SOD and every group, checks the
// hashes against EF.SOD and pulls out the images. 6.10: the chip and the
// document live in test/helpers/nfc-sims.ts (the template runner reads them too).

import { describe, it, expect } from "vitest";
import { decodeTlv, hex, u8 } from "../client/src/lib/nfc/cards/apdu";
import { aaKeyText, parseDg11, parseDg12, parseSod, readMrtd } from "../client/src/lib/nfc/cards/mrtd";
import { parseSecurityInfos, choosePace } from "../client/src/lib/nfc/cards/pace";
import { bacChip, DG1, DG2, DG11, DG12, DG15, int, KEY, MRTD_FILES as FILES, MRZ, oid, sha256, sod, T } from "./helpers/nfc-sims";

/* ------------------------------------------------------------ tests */

describe("the deep MRTD read (BAC chip)", () => {
  it("opens the document with the MRZ and reads every group it may", async () => {
    const chip = bacChip(KEY, FILES());
    const d = await readMrtd(chip.transport, { mrz: MRZ });
    expect(d.access).toBe("bac");
    expect(d.pace).toEqual({ supported: false });
    expect(d.dataGroups).toEqual(["DG1", "DG2", "DG3", "DG7", "DG11", "DG12", "DG14", "DG15"]);
    expect(d.ldsVersion).toBe("1.7");
    expect(d.unicodeVersion).toBe("4.0.0");
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
    expect(d.mrzInfo?.documentNumber).toBe("L898902C");
    expect(d.personal?.fullName).toBe("ERIKSSON, ANNA MARIA");
    expect(d.personal?.fullDateOfBirth).toBe("1969-08-06");
    expect(d.personal?.placeOfBirth).toBe("ZENITH UTO");
    expect(d.personal?.address).toBe("123 MAPLE STREET, ZENITH");
    expect(d.personal?.personalNumber).toBe("ZE184226B");
    expect(d.document?.issuingAuthority).toBe("UTOPIA PASSPORT OFFICE");
    expect(d.document?.dateOfIssue).toBe("2024-01-15");
    expect(d.document?.personalizationTime).toBe("2024-01-10 09:30:00");
    // Fingerprints are EAC — never tried.
    expect(d.files?.find((f) => f.name === "DG3")?.status).toBe("protected");
    expect(chip.selects).not.toContain(0x0103); // never tried (the SM traffic is encrypted, so look at what the chip decrypted)
    expect(chip.selects).toContain(0x0101);
    // Images: the face and the signature, as JPEG.
    expect(d.images?.map((i) => [i.kind, i.group, i.mime, i.name])).toEqual([["face", "DG2", "image/jpeg", "face.jpg"], ["signature", "DG7", "image/jpeg", "signature.jpg"]]);
    expect(d.photoMime).toBe("image/jpeg");
    expect(Buffer.from(d.photo!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // Security: passive authentication, the signer, the protocols, the AA key.
    expect(d.security?.hashAlgorithm).toBe("SHA-256");
    expect(d.security?.passive).toBe("ok");
    expect(d.files?.filter((f) => f.hashOk === true).map((f) => f.name)).toEqual(["DG1", "DG2", "DG7", "DG11", "DG12", "DG14", "DG15"]);
    expect(d.security?.signer?.subject).toBe("C=UT, CN=DS Utopia 1");
    expect(d.security?.signer?.issuer).toBe("C=UT, CN=CSCA Utopia");
    expect(d.security?.signer?.notAfter).toBe("2034-01-01");
    expect(d.security?.protocols).toEqual(expect.arrayContaining(["Chip Authentication (ECDH, AES-128)", "Terminal Authentication", "Active Authentication"]));
    expect(d.security?.activeAuthKey).toBe("RSA 1024");
    // Downloads: the security objects and raw groups.
    expect(d.raw?.map((f) => f.name)).toEqual(expect.arrayContaining(["EF.COM.bin", "EF.SOD.bin", "document-signer.cer", "DG1.bin", "DG11.bin", "DG12.bin", "DG14.bin", "DG15.bin"]));
    expect(d.message).toBeUndefined();
  });

  it("flags a group whose hash does not match EF.SOD", async () => {
    const d = await readMrtd(bacChip(KEY, FILES(11)).transport, { mrz: MRZ });
    expect(d.security?.passive).toBe("mismatch");
    expect(d.files?.find((f) => f.name === "DG11")?.hashOk).toBe(false);
    expect(d.files?.find((f) => f.name === "DG1")?.hashOk).toBe(true);
  });

  it("reads only DG1 / DG2 when asked, and no images when images are off", async () => {
    const chip = bacChip(KEY, FILES());
    const d = await readMrtd(chip.transport, { key: KEY, all: false, readPhoto: false });
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
    expect(d.images).toBeUndefined();
    expect(d.personal).toBeUndefined();
    expect(d.files?.find((f) => f.name === "DG2")?.message).toBe("not read (images off)");
  });

  it("says what went wrong with a wrong MRZ, and reads nothing", async () => {
    const d = await readMrtd(bacChip(KEY, FILES()).transport, { key: { ...KEY, dateOfBirth: "690807" } });
    expect(d.access).toBe("none");
    expect(d.message).toMatch(/BAC/);
    expect(d.mrzInfo).toBeUndefined();
  });

  it("asks for the MRZ or the CAN when given neither", async () => {
    const d = await readMrtd(bacChip(KEY, FILES()).transport, {});
    expect(d.access).toBe("none");
    expect(d.message).toMatch(/MRZ.*CAN/);
  });

  it("sees PACE in EF.CardAccess and falls back to BAC when it cannot run it", async () => {
    const cardAccess = T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), int(2), int(13)));
    const d = await readMrtd(bacChip(KEY, FILES(), { cardAccess }).transport, { mrz: MRZ });
    expect(d.pace?.supported).toBe(true);
    expect(d.pace?.protocol).toBe("PACE ECDH-GM AES-128");
    expect(d.pace?.parameterId).toBe(13);
    expect(d.access).toBe("bac");
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
  });

  it("6.10: says what it reads next (the template runner's transcript labels)", async () => {
    const phases: string[] = [];
    await readMrtd(bacChip(KEY, FILES()).transport, { mrz: MRZ, all: false, readPhoto: false, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["EF.CardAccess", "BAC (MRZ)", "EF.COM", "DG1"]);
  });
});

describe("the security objects", () => {
  it("parses EF.CardAccess / SecurityInfos", () => {
    const s = parseSecurityInfos(T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.4"), int(2), int(13)), T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), int(2), int(0))));
    expect(s.pace.map((p) => [p.cipher, p.agreement, p.mapping, p.parameterId])).toEqual([["AES-256", "ECDH", "GM", 13], ["AES-128", "DH", "GM", 0]]);
    expect(choosePace(s.pace)?.cipher).toBe("AES-256");
  });

  it("reads EF.SOD", () => {
    const s = parseSod(sod({ 1: DG1, 2: DG2 }));
    expect(s.hashAlgorithm).toBe("SHA-256");
    expect(hex(s.hashes.get(1)!)).toBe(hex(sha256(DG1)));
    expect(s.signer?.serial).toBe("1234");
    expect(s.certificate?.[0]).toBe(0x30);
  });

  it("names the Active Authentication key", () => {
    expect(aaKeyText(decodeTlv(DG15, { recurse: false })[0].value)).toBe("RSA 1024");
    expect(aaKeyText(T(0x30, T(0x30, oid("1.2.840.10045.2.1"), oid("1.3.36.3.3.2.8.1.1.7")), T(0x03, u8(0, 4), new Uint8Array(64))))).toBe("EC brainpoolP256r1 (256 bit)");
  });

  it("parses DG11 and DG12 alone", () => {
    expect(parseDg11(DG11).fullName).toBe("ERIKSSON, ANNA MARIA");
    expect(parseDg12(DG12).issuingAuthority).toBe("UTOPIA PASSPORT OFFICE");
  });
});
