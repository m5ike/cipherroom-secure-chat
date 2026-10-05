// The PC/SC backend of the app: pcsc-mini (N-API bindings to PCSC.framework
// on macOS, winscard.dll on Windows, pcsclite on Linux) behind the narrow
// PcscBackend interface of pcsc.ts. Loaded lazily — the native module is
// required only when a page first uses a card reader, and a build or a system
// without it reports "unavailable" instead of failing to start.
//
// Packaging (scripts/builder-config.mjs, scripts/pcsc-prebuilds.mjs): the
// `.node` files are unpacked from app.asar; the universal macOS app carries
// @pcsc-mini/macos-aarch64 and macos-x86_64 (the x86_64 one made signable
// first — scripts/macho-signable.mjs), the Windows builds the
// windows-*-electron variants.

import type * as PcscMini from "pcsc-mini";
import type { PcscBackend, PcscCard, ReaderState } from "./pcsc";

export function createPcscMiniBackend(): PcscBackend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pcsc = require("pcsc-mini") as typeof PcscMini;
  const { ReaderStatus, CardMode, CardDisposition } = pcsc;
  let client: PcscMini.Client | null = null;

  return {
    start(events) {
      const c = new pcsc.Client();
      c.on("reader", (reader: PcscMini.Reader) => {
        const name = reader.name();
        reader.on("change", (status: PcscMini.ReaderStatusFlags, atr?: Uint8Array) => {
          const state: ReaderState = {
            present: status.has(ReaderStatus.PRESENT),
            mute: status.has(ReaderStatus.MUTE),
            exclusive: status.has(ReaderStatus.EXCLUSIVE),
            atr: atr ? new Uint8Array(atr) : new Uint8Array(0),
          };
          events.change(name, state);
        });
        reader.on("disconnect", () => events.gone(name));
      });
      c.on("error", (err: unknown) => events.error(err));
      c.start();
      client = c;
    },
    stop() {
      const c = client;
      client = null;
      try { c?.stop(); } catch { /* already stopped */ }
    },
    async connect(name: string): Promise<PcscCard> {
      const reader = client?.reader(name);
      if (!reader) throw Object.assign(new Error(`Unknown reader ${name}`), { code: "UnknownReader" });
      const card = await reader.connect(CardMode.SHARED);
      const state = await card.state();
      return {
        atr: new Uint8Array(state.atr),
        protocol: pcsc.protocolString(state.protocol),
        async transmit(apdu: Uint8Array, maxResponse: number): Promise<Uint8Array> {
          const out = await card.transmit(apdu, new ArrayBuffer(maxResponse));
          return new Uint8Array(out);
        },
        async disconnect(): Promise<void> {
          await card.disconnect(CardDisposition.LEAVE);
        },
      };
    },
  };
}
