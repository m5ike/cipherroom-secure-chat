// A secure-messaging channel (6.6) — what BAC and PACE both give the MRTD
// reader once the holder's document is open: send a plain APDU, get the plain
// answer back. BAC wraps with 3DES + retail MAC (bac.ts); PACE with AES + CMAC
// or 3DES (pace.ts). The reader (mrtd.ts) never cares which.

import type { CardTransport } from "../transport";
import { protectApdu, unprotectResponse, type BacSession } from "./bac";

export type SmReply = { data: Uint8Array; sw: number };

export type SmChannel = {
  /** How the document was opened. */
  kind: "bac" | "pace";
  /** One exchange: protect → transmit → unprotect. */
  send(cmd: Uint8Array): Promise<SmReply>;
};

/** The channel a BAC session gives (3DES secure messaging, ICAO 9303-11 §9.8). */
export function bacChannel(t: CardTransport, s: BacSession): SmChannel {
  return {
    kind: "bac",
    async send(cmd) { return unprotectResponse(s, await t.transmit(protectApdu(s, cmd))); },
  };
}
