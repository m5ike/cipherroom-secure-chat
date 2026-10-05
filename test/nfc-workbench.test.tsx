import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { NfcWorkbench, EmvResultView, MrtdResultView } from "../client/src/components/NfcWorkbench";
import type { EmvData, MrtdData } from "../client/src/lib/nfc/command";

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

  it("6.12 (F-12): the connect-tag tab writes v2 — an invitation by default, or offline with a code; no PIN field", () => {
    render(<NfcWorkbench lang="en" session={{ room: "r", passphrase: "p", name: "n" }} {...base} />);
    fireEvent.click(screen.getByRole("tab", { name: "Connect tag" }));
    expect((screen.getByTestId("conn-mode-invite") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/room key stays sealed on the server/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId("conn-mode-offline"));
    expect(screen.getByText(/20-character code that is not on the tag/i)).toBeTruthy();
    expect(screen.queryByText(/4–16 digits/)).toBeNull();
    const secret = screen.getByTestId("conn-secret") as HTMLInputElement;
    expect(secret.inputMode).not.toBe("numeric");
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

  it("shows the Card data tab with the read-only stance and the EMV / e-ID read buttons", () => {
    render(<NfcWorkbench lang="en" session={null} {...base} />);
    fireEvent.click(screen.getByRole("tab", { name: "Card data" }));
    // The read-only stance is spelled out.
    expect(screen.getByText(/No PIN, no cryptogram, no cloning/i)).toBeTruthy();
    // Both reads are offered (disabled until a reader with an APDU channel is connected).
    const emv = screen.getByRole("button", { name: /Read card data/i }) as HTMLButtonElement;
    const eid = screen.getByRole("button", { name: /Read document \(PACE \/ BAC\)/i }) as HTMLButtonElement;
    expect(emv).toBeTruthy();
    expect(eid).toBeTruthy();
    expect(emv.disabled).toBe(true);
    expect(eid.disabled).toBe(true);
    // Nothing read yet.
    expect(screen.getByText(/No card read yet/i)).toBeTruthy();
  });
});

/* 6.5 — the EMV / MRTD result widgets render from fixed data. */

const EMV: EmvData = {
  scheme: "Visa",
  aids: ["A0000000031010"],
  tree: "6F ...",
  apps: [
    {
      aid: "A0000000031010",
      label: "VISA CREDIT",
      scheme: "Visa",
      pan: "4111111111111111",
      panMasked: "411111••••••1111",
      expiry: "2027-11",
      cardholder: "JOHN DOE",
      issuerCountry: "Czechia",
      effective: "2023-11",
      panSequence: "01",
      atc: 42,
      pinTryCounter: 3,
      tags: [
        { tag: "5A", name: "Application PAN", value: "4111111111111111", hex: "4111111111111111" },
        { tag: "5F24", name: "Application Expiration Date", value: "2027-11", hex: "271130" },
      ],
    },
  ],
};

const MRTD: MrtdData = {
  present: true,
  access: "bac",
  dataGroups: ["DG1", "DG2"],
  mrzInfo: {
    documentCode: "P",
    documentNumber: "L898902C3",
    issuer: "UTO",
    nationality: "UTO",
    surname: "ERIKSSON",
    givenNames: "ANNA MARIA",
    dateOfBirth: "1974-08-12",
    sex: "F",
    dateOfExpiry: "2012-04-15",
  },
  // A 1x1 transparent PNG, enough to assert the <img> renders.
  photo: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  photoMime: "image/png",
};

describe("NfcWorkbench EMV result widget (6.5)", () => {
  beforeEach(() => cleanup());

  it("shows the scheme, masked PAN, holder fields and reveals the full PAN", () => {
    render(<EmvResultView data={EMV} lang="en" />);
    expect(screen.getByText("Visa")).toBeTruthy();
    // Masked PAN is shown by default in the header + holder field.
    expect(screen.getAllByText("411111••••••1111").length).toBeGreaterThan(0);
    // Holder fields (not duplicated in the tag table fixture).
    expect(screen.getByText("JOHN DOE")).toBeTruthy();
    expect(screen.getByText("Czechia")).toBeTruthy();
    expect(screen.getAllByText("2027-11").length).toBeGreaterThan(0);
    // Toggling "show full PAN" reveals the PAN in at least one more place.
    const before = screen.queryAllByText("4111111111111111").length;
    fireEvent.click(screen.getByLabelText("Show full PAN"));
    expect(screen.queryAllByText("4111111111111111").length).toBeGreaterThan(before);
    // The toggle flips to "hide".
    expect(screen.getByLabelText("Hide PAN")).toBeTruthy();
  });

  it("renders the collapsible full tag table", () => {
    render(<EmvResultView data={EMV} lang="en" />);
    expect(screen.getByText(/All data elements/)).toBeTruthy();
    expect(screen.getByText("Application Expiration Date")).toBeTruthy();
  });
});

describe("NfcWorkbench MRTD result widget (6.5)", () => {
  beforeEach(() => cleanup());

  it("shows the MRZ fields, data groups and the face photo", () => {
    render(<MrtdResultView data={MRTD} lang="en" />);
    expect(screen.getByText("ANNA MARIA ERIKSSON")).toBeTruthy();
    expect(screen.getByText("L898902C3")).toBeTruthy();
    expect(screen.getByText("1974-08-12")).toBeTruthy();
    expect(screen.getByText("DG1")).toBeTruthy();
    expect(screen.getByText("DG2")).toBeTruthy();
    const img = screen.getByAltText("Document photo") as HTMLImageElement;
    expect(img.src).toContain("data:image/png;base64,");
  });

  it("warns (not errors) when the chip could not be opened", () => {
    const none: MrtdData = { present: true, access: "none", message: "Give the MRZ to open the chip with BAC." };
    render(<MrtdResultView data={none} lang="en" />);
    expect(screen.getByText(/Give the MRZ to open the chip/i)).toBeTruthy();
  });
});

describe("the full card report in the workbench (6.6)", () => {
  beforeEach(() => cleanup());

  it("renders the chat's report — history, escaped text — with exports and files", async () => {
    const { CardReportView } = await import("../client/src/components/NfcWorkbench");
    const emv: EmvData = { scheme: "Visa", aids: ["A0000000031010"], apps: [{ aid: "A0000000031010", label: "VISA", scheme: "Visa", pan: "4111111111111111", panMasked: "411111••••••1111", cardholder: "<b>X</b>", logSfi: 11, log: [{ date: "2025-09-14", amount: "12.30", currency: "CZK", merchant: "BILLA", raw: "00" }], tags: [], records: [{ sfi: 1, record: 1, hex: "70" }] }] };
    const view = render(<CardReportView data={{ status: "ok", emv }} lang="en" />);
    expect(view.getByText("Full report")).toBeTruthy();
    expect(view.getByText("HTML report")).toBeTruthy();
    expect(view.getAllByText("emv-history.csv").length).toBe(2); // the download button + the report's attachment list
    expect(view.getByText("BILLA")).toBeTruthy();
    expect(view.getByText("<b>X</b>")).toBeTruthy(); // card text stays text
    expect(view.container.querySelector(".fn-html b")).toBeNull();
    expect(view.container.querySelector("table.m5h-grid")).toBeTruthy();
  });

  it("shows an e-ID report with its photo in Czech", async () => {
    const { CardReportView } = await import("../client/src/components/NfcWorkbench");
    const mrtd: MrtdData = { present: true, access: "bac", mrzInfo: { documentCode: "P", surname: "NOVAK", givenNames: "JAN", documentNumber: "X1" }, images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: "/9j/4AAQ", name: "face.jpg" }] };
    const view = render(<CardReportView data={{ status: "ok", mrtd }} lang="cs" />);
    expect(view.getByText("Celý výpis")).toBeTruthy();
    expect(view.getByText("Cestovní pas · JAN NOVAK")).toBeTruthy();
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });
});
