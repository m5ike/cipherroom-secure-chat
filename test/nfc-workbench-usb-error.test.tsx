// 6.13.1 — a USB reader the operating system holds: the workbench says why
// and what to use instead (the platform's own text), with the browser's words
// only after it — never the bare "Failed to execute 'claimInterface' … Unable
// to claim interface." the reporter saw.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { NfcWorkbench } from "../client/src/components/NfcWorkbench";
import { t } from "../client/src/lib/i18n";
import { osFamily } from "../client/src/lib/nfc/reader-guide";

vi.mock("../client/src/lib/nfc/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/lib/nfc/index")>();
  const { mapUsbOpenError } = await import("../client/src/lib/nfc/transports/webusb-ccid");
  const fake = {
    id: "webusb-ccid", label: "WebUSB CCID",
    capabilities: { apdu: true, raw: true, mifareAuth: true, ndefOnly: false, emulate: false, write: true },
    isSupported: () => true,
    connect: async () => { throw mapUsbOpenError(Object.assign(new Error("Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface."), { name: "NetworkError" })); },
    disconnect: async () => {}, isConnected: () => false, waitForCard: async () => { throw new Error("no"); }, transmit: async () => new Uint8Array(),
    onDisconnect: () => () => {},
  };
  return { ...real, listTransports: () => [{ id: "webusb-ccid", label: "WebUSB CCID", supported: true, create: () => fake }], createTransport: () => fake };
});

beforeEach(() => {
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ values: {}, updatedAt: 0 }), { headers: { "content-type": "application/json" } })));
});

describe("a USB reader the system holds", () => {
  it("is explained for this platform, the raw browser error only in brackets after it", async () => {
    const onSystem = vi.fn();
    render(<NfcWorkbench lang="en" session={null} appVersion="6.13.1" onConnect={vi.fn()} onSystem={onSystem} />);
    fireEvent.click(screen.getByText("Connect"));
    const os = osFamily();
    const key = os === "mac" ? "nfc.err.osOwned.mac" : os === "win" ? "nfc.err.osOwned.win" : os === "linux" ? "nfc.err.osOwned.linux" : "nfc.err.osOwned.other";
    await waitFor(() => expect(onSystem).toHaveBeenCalled());
    const msg = String(onSystem.mock.calls.at(-1)?.[0]);
    expect(msg.startsWith(`NFC: ${t("en", key)}`)).toBe(true);
    expect(msg).toContain("(NetworkError: Failed to execute 'claimInterface'");
    expect(msg).toContain("M5cet Desktop");
  });
});
