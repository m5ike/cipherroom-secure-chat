import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { NfcWorkbench } from "../client/src/components/NfcWorkbench";

describe("NfcWorkbench", () => {
  beforeEach(() => cleanup());

  it("renders all four transports and marks them unavailable in a headless env", () => {
    render(<NfcWorkbench lang="en" session={null} appVersion="2.7.0" onConnect={vi.fn()} onSystem={vi.fn()} />);
    expect(screen.getByText("Web NFC (Android Chrome)")).toBeTruthy();
    expect(screen.getByText("WebUSB CCID (ACR122U / PC-SC)")).toBeTruthy();
    expect(screen.getByText("Web Serial PN532")).toBeTruthy();
    expect(screen.getByText("Web Bluetooth PN532")).toBeTruthy();
    expect(screen.getAllByText("unavailable").length).toBe(4);
  });

  it("localizes the tab labels (cs / de)", () => {
    const cs = render(<NfcWorkbench lang="cs" session={null} appVersion="1" onConnect={vi.fn()} onSystem={vi.fn()} />);
    expect(cs.getByText("Připojit")).toBeTruthy();
    expect(cs.getByText("Načíst kartu")).toBeTruthy();
    cleanup();
    const de = render(<NfcWorkbench lang="de" session={null} appVersion="1" onConnect={vi.fn()} onSystem={vi.fn()} />);
    expect(de.getByText("Verbinden")).toBeTruthy();
  });

  it("warns on the connect-tag tab when there is no session", () => {
    render(<NfcWorkbench lang="en" session={null} appVersion="1" onConnect={vi.fn()} onSystem={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Connect tag" }));
    expect(screen.getByText(/not in a room/i)).toBeTruthy();
  });

  it("switches to the Mifare tab and shows the dictionary-attack section", () => {
    render(<NfcWorkbench lang="en" session={{ room: "r", passphrase: "p", name: "n" }} appVersion="1" onConnect={vi.fn()} onSystem={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Mifare" }));
    expect(screen.getByText(/Dictionary attack/i)).toBeTruthy();
  });
});
