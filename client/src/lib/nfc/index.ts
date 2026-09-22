// Public surface of the NFC / smart-card workbench library. The React
// component (components/NfcWorkbench.tsx) builds on this; nothing here
// touches the DOM so the whole module tree is unit-testable in node.

export * from "./errors";
export * from "./transport";
export { WebNfcTransport } from "./transports/webnfc";
export { WebUsbCcidTransport } from "./transports/webusb-ccid";
export { WebSerialPn532Transport } from "./transports/webserial-pn532";
export { WebBluetoothPn532Transport } from "./transports/webbluetooth-pn532";

import type { CardTransport, TransportId } from "./transport";
import { WebNfcTransport } from "./transports/webnfc";
import { WebUsbCcidTransport } from "./transports/webusb-ccid";
import { WebSerialPn532Transport } from "./transports/webserial-pn532";
import { WebBluetoothPn532Transport } from "./transports/webbluetooth-pn532";

export type TransportInfo = { id: TransportId; label: string; supported: boolean; create: () => CardTransport };

/** All transports with a live support probe, in the order the UI shows them. */
export function listTransports(): TransportInfo[] {
  const factories: Array<() => CardTransport> = [
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

export function createTransport(id: TransportId): CardTransport {
  switch (id) {
    case "webnfc": return new WebNfcTransport();
    case "webusb-ccid": return new WebUsbCcidTransport();
    case "webserial-pn532": return new WebSerialPn532Transport();
    case "webbluetooth-pn532": return new WebBluetoothPn532Transport();
  }
}

export * from "./cards/apdu";
export * from "./cards/ndef";
export * from "./cards/detect";
export * as MifareClassic from "./cards/mifare-classic";
export * from "./cards/connection-card";
export * from "./probes";
