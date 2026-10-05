// 6.13.1 — the reader picker: the system reader first inside M5cet Desktop,
// what each choice is for, the "all serial ports" option, and a reader error
// in words (a USB reader the OS holds) instead of the bare DOMException.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { NfcWorkbench } from "../client/src/components/NfcWorkbench";
import { t } from "../client/src/lib/i18n";

const base = { appVersion: "6.13.1", onConnect: vi.fn(), onSystem: vi.fn() } as const;

/** The fake app bridge: one reader, no card. */
const pcsc = {
  listReaders: async () => ({ ok: true, readers: [{ name: "ACS ACR1281 1S Dual Reader(2)", slot: "contactless", card: false }] }),
  connect: async () => ({ ok: false, code: "no-card", message: "no card", reader: "ACS ACR1281 1S Dual Reader(2)" }),
  transmit: async () => ({ ok: false, code: "bad-handle", message: "" }),
  disconnect: async () => ({ ok: true }),
  onChange: () => () => undefined,
};

beforeEach(() => {
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ values: {}, updatedAt: 0 }), { headers: { "content-type": "application/json" } })));
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { m5desktop?: unknown }).m5desktop;
});

describe("the reader picker (6.13.1)", () => {
  it("in a browser: no system reader, each choice says what it is for, a guide explains which fits", () => {
    render(<NfcWorkbench lang="en" session={null} {...base} />);
    expect(screen.queryByText("System reader (PC/SC)")).toBeNull();
    expect(screen.getByText(t("en", "nfc.reader.help.usb"))).toBeTruthy();
    expect(screen.getByText(t("en", "nfc.reader.help.serial"))).toBeTruthy();
    expect(screen.getByText(t("en", "nfc.reader.help.bluetooth"))).toBeTruthy();
    expect(screen.getByText("Which choice fits my reader?")).toBeTruthy();
    expect(screen.getByText(/System reader \(PC\/SC\) in M5cet Desktop/)).toBeTruthy();
  });

  it("in M5cet Desktop the system reader comes first and is chosen by default", () => {
    (window as unknown as { m5desktop: unknown }).m5desktop = { isDesktop: true, pcsc };
    render(<NfcWorkbench lang="cs" session={null} {...base} />);
    const buttons = screen.getAllByRole("button").filter((b) => b.className.includes("nfcwb__transport"));
    expect(buttons[0].textContent).toContain("Systémová čtečka (PC/SC)");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].textContent).toContain("dostupná");
  });

  it("the serial reader offers \"all serial ports\"", () => {
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { serial: { requestPort: vi.fn(), getPorts: vi.fn() } }));
    render(<NfcWorkbench lang="en" session={null} {...base} />);
    fireEvent.click(screen.getByTestId("nfc-reader-serial"));
    expect(screen.getByText("Show all serial ports (other adapters)")).toBeTruthy();
    expect((screen.getByTestId("nfc-serial-all") as HTMLInputElement).checked).toBe(false);
  });

  it("connecting the system reader logs the reader and slot the user picked in the app", async () => {
    (window as unknown as { m5desktop: unknown }).m5desktop = { isDesktop: true, pcsc };
    const onSystem = vi.fn();
    render(<NfcWorkbench lang="en" session={null} {...base} onSystem={onSystem} />);
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(screen.getByText(/Connected: System reader \(PC\/SC\) — ACS ACR1281 1S Dual Reader\(2\) \(contactless\)/)).toBeTruthy());
  });
});
