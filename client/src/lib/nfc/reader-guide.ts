// Which reader fits which connection, and what a reader error means for the
// user (6.13.1). Pure: the workbench passes the OS and whether it runs in
// M5cet Desktop; the texts are i18n keys (i18n-extra.ts, nine languages).
//
//   USB smart-card reader (CCID: ACR122U, ACR1252U, ACR1281 …)
//       → M5cet Desktop: System reader (PC/SC). In a browser only over WebUSB,
//         and only where the OS does not use the reader itself.
//   PN532 on a USB-serial adapter or a Bluetooth SPP module (HC-05/06)
//       → Serial reader (Web Serial)
//   PN532 on a BLE module (Nordic UART, HM-10) → Bluetooth reader (Web Bluetooth)
//   A phone → This device (Chrome on Android) or the M5cet Android app

import { NfcError } from "./errors";
import { pcscCodeOf } from "./transports/desktop-pcsc";

export type OsFamily = "mac" | "win" | "linux" | "android" | "other";

type NavigatorLike = { userAgent?: string; platform?: string; userAgentData?: { platform?: string } };

/** The operating system the page runs on (only to word an explanation — never a security decision). */
export function osFamily(nav: NavigatorLike | undefined = typeof navigator !== "undefined" ? navigator : undefined): OsFamily {
  const p = `${nav?.userAgentData?.platform ?? ""} ${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/android/i.test(p)) return "android";
  if (/mac|iphone|ipad/i.test(p)) return "mac";
  if (/win/i.test(p)) return "win";
  if (/linux|x11|cros/i.test(p)) return "linux";
  return "other";
}

/** A text for an error: an i18n key, or null when the error's own message is the best there is. */
export type ReaderErrorText = { key: string; also?: string } | null;

/**
 * The i18n key that explains a reader error. `reader-owned-by-os` gets the
 * platform's own explanation (and, in M5cet Desktop, the pointer to the
 * system reader); the system reader's errors say what the app said.
 */
export function readerErrorText(err: unknown, ctx: { os: OsFamily; desktop: boolean }): ReaderErrorText {
  if (!NfcError.is(err)) return null;
  const pcsc = pcscCodeOf(err);
  if (pcsc) {
    const byPcsc: Partial<Record<string, string>> = {
      unavailable: "nfc.pcsc.unavailable", denied: "nfc.pcsc.denied", cancelled: "nfc.cancelled", "no-reader": "nfc.pcsc.noReader",
      "no-card": "nfc.scan.tap", removed: "nfc.pcsc.removed", reset: "nfc.pcsc.removed", busy: "nfc.pcsc.busy",
      locked: "nfc.pcsc.locked", "rate-limited": "nfc.pcsc.busy", timeout: "nfc.pcsc.timeout",
    };
    const key = byPcsc[pcsc];
    return key ? { key } : null;
  }
  switch (err.code) {
    case "reader-owned-by-os": {
      const key = ctx.os === "mac" ? "nfc.err.osOwned.mac" : ctx.os === "win" ? "nfc.err.osOwned.win" : ctx.os === "linux" ? "nfc.err.osOwned.linux" : "nfc.err.osOwned.other";
      return ctx.desktop ? { key, also: "nfc.err.osOwned.desktop" } : { key };
    }
    case "no-answer": return { key: "nfc.err.noAnswer" };
    case "unsupported": return { key: "nfc.apdu.unsupported" };
    case "permission-denied": return { key: "nfc.reader.unavailable" };
    case "not-connected": return { key: "nfc.connectFirst" };
    case "no-card": return { key: "nfc.scan.tap" };
    case "aborted": return { key: "nfc.cancelled" };
    case "busy": return err.message.includes("serial port") ? { key: "nfc.err.portBusy" } : null;
    default: return null;
  }
}
