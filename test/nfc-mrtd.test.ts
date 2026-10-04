// @vitest-environment node
//
// The MRTD parsers (cards/mrtd.ts): the MRZ of DG1, the data-group list of
// EF.COM, and the face pulled out of DG2. The reader's BAC + secure messaging
// are pinned in nfc-bac.test.ts.

import { describe, it, expect } from "vitest";
import { concat, encodeTlv, u8 } from "../client/src/lib/nfc/cards/apdu";
import { dataGroupsFromCom, faceFromDg2, mrzFromDg1, parseMrz } from "../client/src/lib/nfc/cards/mrtd";

const ascii = (s: string) => new TextEncoder().encode(s);
const T = (tag: number, v: Uint8Array) => encodeTlv(tag, v);

describe("the MRZ", () => {
  it("parses a TD3 passport MRZ into fields", () => {
    const mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<L898902C<3UTO6908061F9406236ZE184226B<<<<<10";
    const m = parseMrz(mrz);
    expect(m.documentCode).toBe("P");
    expect(m.issuer).toBe("UTO");
    expect(m.surname).toBe("ERIKSSON");
    expect(m.givenNames).toBe("ANNA MARIA");
    expect(m.documentNumber).toBe("L898902C");
    expect(m.nationality).toBe("UTO");
    expect(m.dateOfBirth).toBe("1969-08-06");
    expect(m.sex).toBe("F");
    expect(m.dateOfExpiry).toBe("1994-06-23"); // the worked-example passport is an old one
  });

  it("reads the MRZ out of a DG1 (tag 61 / 5F1F)", () => {
    const mrzText = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<L898902C<3UTO6908061F9406236ZE184226B<<<<<10";
    const dg1 = T(0x61, T(0x5f1f, ascii(mrzText)));
    const m = mrzFromDg1(dg1);
    expect(m?.surname).toBe("ERIKSSON");
    expect(m?.documentNumber).toBe("L898902C");
  });
});

describe("EF.COM", () => {
  it("lists the data groups present", () => {
    // 60 { 5F01 (LDS version) 5F36 (unicode) 5C (tag list: 61 75 6C 6D) }
    const com = T(0x60, concat(T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x6c, 0x6d))));
    expect(dataGroupsFromCom(com)).toEqual(["DG1", "DG2", "DG12", "DG13"]);
  });
});

describe("DG2", () => {
  it("extracts an embedded JPEG face", () => {
    const header = u8(0x7f, 0x61, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // CBEFF-ish noise
    const jpeg = u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9);
    const dg2 = concat(header, jpeg);
    const face = faceFromDg2(dg2);
    expect(face?.mime).toBe("image/jpeg");
    expect(Array.from(face!.data.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  it("recognises a JPEG 2000 face", () => {
    const jp2 = u8(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a);
    const face = faceFromDg2(concat(u8(0x75, 0x05, 0, 0, 0, 0, 0), jp2));
    expect(face?.mime).toBe("image/jp2");
  });

  it("returns null when there is no image", () => {
    expect(faceFromDg2(u8(0x75, 0x03, 0x01, 0x02, 0x03))).toBeNull();
  });
});
