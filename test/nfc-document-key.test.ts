// @vitest-environment node
//
// The document key asked on the device (6.6): an e-ID read without a key makes
// the caller's device ask the holder; what they type joins only that command.

import { describe, it, expect } from "vitest";
import { documentKeyValid, needsDocumentKey, withDocumentKey } from "../client/src/lib/nfc/document-key";

describe("the document key on the device", () => {
  it("is needed for an e-ID read without a CAN, an MRZ or the three fields", () => {
    expect(needsDocumentKey({ op: "mrtd-read", args: { readPhoto: true } })).toBe(true);
    expect(needsDocumentKey({ op: "eid-read" })).toBe(true);
    expect(needsDocumentKey({ op: "mrtd-read", args: { can: "123456" } })).toBe(false);
    expect(needsDocumentKey({ op: "mrtd-read", args: { mrz: "P<UTO..." } })).toBe(false);
    expect(needsDocumentKey({ op: "mrtd-read", args: { documentNumber: "X1", dateOfBirth: "690806" } })).toBe(true);
    expect(needsDocumentKey({ op: "mrtd-read", args: { documentNumber: "X1", dateOfBirth: "690806", dateOfExpiry: "940623" } })).toBe(false);
    expect(needsDocumentKey({ op: "emv-read" })).toBe(false);
  });

  it("checks what was typed and adds only the filled fields", () => {
    expect(documentKeyValid({ can: "12345" })).toBe(false);
    expect(documentKeyValid({ can: "123456" })).toBe(true);
    expect(documentKeyValid({ documentNumber: "l898902c", dateOfBirth: "690806", dateOfExpiry: "940623" })).toBe(true);
    expect(documentKeyValid({ mrz: "" })).toBe(false);
    const c = withDocumentKey({ op: "mrtd-read", args: { readPhoto: true } }, { can: " 123456 ", mrz: "", documentNumber: "l898902c" });
    expect(c).toEqual({ op: "mrtd-read", args: { readPhoto: true, can: "123456", documentNumber: "L898902C" } });
  });
});
