// Public surface of the NFC / smart-card workbench library. The React
// component (components/NfcWorkbench.tsx) builds on this; nothing here
// touches the DOM so the whole module tree is unit-testable in node.

export * from "./errors";
export * from "./transport";
export { WebNfcTransport } from "./transports/webnfc";
export { WebUsbCcidTransport } from "./transports/webusb-ccid";
export { WebSerialPn532Transport } from "./transports/webserial-pn532";
export { WebBluetoothPn532Transport } from "./transports/webbluetooth-pn532";
export { DesktopPcscTransport } from "./transports/desktop-pcsc";

import type { CardTransport, TransportId } from "./transport";
import { WebNfcTransport } from "./transports/webnfc";
import { WebUsbCcidTransport } from "./transports/webusb-ccid";
import { WebSerialPn532Transport } from "./transports/webserial-pn532";
import { WebBluetoothPn532Transport } from "./transports/webbluetooth-pn532";
import { DesktopPcscTransport } from "./transports/desktop-pcsc";
import { desktopPcsc } from "../desktop-bridge";

export type TransportInfo = { id: TransportId; label: string; supported: boolean; create: () => CardTransport };
/** Per-connect choices the reader picker passes on (6.13.1). */
export type TransportOptions = { serialAllPorts?: boolean };

/**
 * All transports with a live support probe, in the order the UI shows them.
 * 6.13.1: the system reader (PC/SC) only inside M5cet Desktop, and first.
 */
export function listTransports(): TransportInfo[] {
  const factories: Array<() => CardTransport> = [
    ...(desktopPcsc() ? [() => new DesktopPcscTransport()] : []),
    () => new WebNfcTransport(),
    () => new WebUsbCcidTransport(),
    () => new WebSerialPn532Transport(),
    () => new WebBluetoothPn532Transport(),
  ];
  return factories.map((create) => {
    const probe = create();
    return { id: probe.id, label: probe.label, supported: probe.isSupported(), create };
  });
}

export function createTransport(id: TransportId, opts: TransportOptions = {}): CardTransport {
  switch (id) {
    case "webnfc": return new WebNfcTransport();
    case "webusb-ccid": return new WebUsbCcidTransport();
    case "webserial-pn532": return new WebSerialPn532Transport({ allPorts: opts.serialAllPorts === true });
    case "webbluetooth-pn532": return new WebBluetoothPn532Transport();
    case "desktop-pcsc": return new DesktopPcscTransport();
  }
}

export * from "./cards/apdu";
export * from "./cards/ndef";
export * from "./cards/detect";
export * as MifareClassic from "./cards/mifare-classic";
export * as TagIo from "./cards/tag-io";
export * from "./cards/connection-card";
export * from "./probes";
export * from "./catalog";
export * as M5CetCard from "./m5cet-card";
export { createWebExecutor, type WebExecutorDeps } from "./web-executor";
export { registerNfcExecutor, runNfcCommand, hasNfcExecutor, type NfcExecutor } from "./bridge";
