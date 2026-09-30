import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { NfcWorkbench } from "../client/src/components/NfcWorkbench";

const base = { appVersion: "2.7.0", onConnect: vi.fn(), onSystem: vi.fn() } as const;

describe("NfcWorkbench (6.3)", () => {
  beforeEach(() => {
    cleanup();
    // useDefine() fetches /api/define: answer it here instead of the network (jsdom → localhost:3000).
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ values: {}, updatedAt: 0 }), { headers: { "content-type": "application/json" } })));
  });

  it("lists the four readers and marks them unavailable in a headless env", () => {
    render(<NfcWorkbench lang="en" session={null} {...base} />);
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText("USB reader")).toBeTruthy();
    expect(screen.getByText("Bluetooth reader")).toBeTruthy();
    expect(screen.getByText("Serial reader")).toBeTruthy();
    // The underlying transport labels are still shown as a hint.
    expect(screen.getByText("Web NFC (Android Chrome)")).toBeTruthy();
    expect(screen.getAllByText("unavailable").length).toBe(4);
  });

  it("localizes core controls (cs / de)", () => {
    const cs = render(<NfcWorkbench lang="cs" session={null} {...base} />);
    expect(cs.getByText("Připojit")).toBeTruthy();
    expect(cs.getByText("Načíst kartu")).toBeTruthy();
    cleanup();
    const de = render(<NfcWorkbench lang="de" session={null} {...base} />);
    expect(de.getByText("Verbinden")).toBeTruthy();
    expect(de.getByText("Karte lesen")).toBeTruthy();
  });

  it("warns on the connect-tag tab when there is no session", () => {
    render(<NfcWorkbench lang="en" session={null} {...base} />);
    fireEvent.click(screen.getByRole("tab", { name: "Connect tag" }));
    expect(screen.getByText(/not in a room/i)).toBeTruthy();
  });

  it("shows the Mifare key dictionary", () => {
    render(<NfcWorkbench lang="en" session={{ room: "r", passphrase: "p", name: "n" }} {...base} />);
    fireEvent.click(screen.getByRole("tab", { name: "Mifare" }));
    expect(screen.getByText("Key list")).toBeTruthy();
    expect(screen.getByText(/MIFARE Classic Tool/i)).toBeTruthy();
  });

  it("opens the M5Cet builder and adds a record", () => {
    render(<NfcWorkbench lang="en" session={null} {...base} />);
    fireEvent.click(screen.getAllByRole("tab", { name: "M5Cet card" })[0]);
    fireEvent.click(screen.getByRole("tab", { name: "Build an M5Cet card" }));
    fireEvent.click(screen.getByText("Add record"));
    // The default "Encrypted message" record type is now in the picker and in the draft.
    expect(screen.getAllByText("Encrypted message").length).toBeGreaterThan(1);
    // The capacity gauge shows a byte size.
    expect(screen.getByText(/Size:/)).toBeTruthy();
  });
});
