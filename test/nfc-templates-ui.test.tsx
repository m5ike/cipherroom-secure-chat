// The APDU templates in the NFC workbench (6.10): the menu grouped by card
// type (older entries marked, a broken one disabled with its problem), picking
// one runs every step with live progress, the output's four views, and the
// three actions — Share, Forward (a room, then everyone or one member), To
// myself (a note only I see). The reader is a simulated DESFire behind a
// mocked transport list, so the whole path runs: connect → menu → run → output.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, within, waitFor } from "@testing-library/react";
import { STANDARD_APDU_TEMPLATES } from "../client/src/lib/nfc/apdu-templates";
import { runTemplate, type TemplateRun } from "../client/src/lib/nfc/template-runner";
import { TemplateMenu, TemplateRunView, templateMenu, chatBody, type NfcChatBridge } from "../client/src/components/NfcTemplatePanel";
import { NfcWorkbench } from "../client/src/components/NfcWorkbench";
import { bacChip, desfireCard, emvCard, KEY, MRTD_FILES, MRZ } from "./helpers/nfc-sims";

vi.mock("../client/src/lib/nfc/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/lib/nfc/index")>();
  const { desfireCard: sim } = await import("./helpers/nfc-sims");
  const card = sim().t;
  const fake = {
    id: "webusb-ccid", label: "Simulated reader",
    capabilities: { apdu: true, raw: false, mifareAuth: false, ndefOnly: false, emulate: false, write: false },
    isSupported: () => true, connect: async () => {}, disconnect: async () => {}, isConnected: () => true,
    waitForCard: async () => ({ uid: Uint8Array.from([4, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6]), sak: 0x20, atqa: Uint8Array.from([0x44, 0x03]), tech: "iso14443a", isoDep: true, hints: [] }),
    // A test may put another card in the field (globalThis.__nfcSim).
    transmit: (a: Uint8Array) => ((globalThis as { __nfcSim?: { transmit: (x: Uint8Array) => Promise<Uint8Array> } }).__nfcSim ?? card).transmit(a),
    onDisconnect: () => () => {},
  };
  return {
    ...real,
    listTransports: () => [{ id: "webusb-ccid", label: "Simulated reader", supported: true, create: () => fake }],
    createTransport: () => fake,
  };
});

const DESFIRE = STANDARD_APDU_TEMPLATES.find((t) => t.card === "desfire")!;
const base = { appVersion: "6.10.0", onConnect: vi.fn(), onSystem: vi.fn() } as const;

function bridge(over: Partial<NfcChatBridge> = {}): NfcChatBridge & { forward: ReturnType<typeof vi.fn>; noteToSelf: ReturnType<typeof vi.fn> } {
  return {
    rooms: () => [
      { key: "local|brno", label: "brno", current: true, members: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }] },
      { key: "local|praha", label: "praha", current: false, members: [] },
    ],
    forward: vi.fn(async () => ({ ok: true })),
    noteRoom: () => "brno",
    noteToSelf: vi.fn(async () => ({ ok: true })),
    ...over,
  } as NfcChatBridge & { forward: ReturnType<typeof vi.fn>; noteToSelf: ReturnType<typeof vi.fn> };
}

let run: TemplateRun;
beforeEach(async () => {
  cleanup();
  run = await runTemplate(desfireCard().t, DESFIRE);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the template menu", () => {
  const list = [...STANDARD_APDU_TEMPLATES, { label: "PPSE + GPO (old)", apdu: "00A404000E325041592E5359532E444446303100\n80A8000002830000" }, { label: "Read EMV (old)", op: "emv-read", aid: "A0000000031010" }, { label: "Broken", steps: [{ op: "select-aid", aid: "XYZ" }] }];

  it("groups the templates by card type, marks the older entries, disables a broken one with its problem", () => {
    const onPick = vi.fn();
    render(<TemplateMenu lang="en" templates={list} onPick={onPick} />);
    for (const g of ["Payment cards (EMV)", "e-ID / e-passport", "MIFARE DESFire", "Smart cards (ISO 7816)", "Other templates"]) expect(screen.getByRole("group", { name: g })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Payment cards (EMV)" })).getAllByRole("menuitem")).toHaveLength(13); // 12 standard + the older op entry
    expect(screen.getByText("older entry · commands: 2")).toBeTruthy();
    expect(screen.getByText("older entry · whole read")).toBeTruthy();
    const broken = screen.getByRole("menuitem", { name: /Broken/ }) as HTMLButtonElement;
    expect(broken.disabled).toBe(true);
    expect(screen.getByText("Cannot run: bad AID XYZ")).toBeTruthy();
    expect(screen.getByText("6 steps")).toBeTruthy(); // the DESFire read
    fireEvent.click(screen.getByRole("menuitem", { name: /MIFARE DESFire — version/ }));
    expect(onPick).toHaveBeenCalledWith(DESFIRE);
  });

  it("is localized and says when there are no templates", () => {
    render(<TemplateMenu lang="cs" templates={[]} onPick={vi.fn()} />);
    expect(screen.getByText(/Žádné šablony/)).toBeTruthy();
    expect(templateMenu([{ label: "x", card: "desfire", steps: [{ apdu: "9060000000" }] }])[0].group).toBe("desfire");
  });
});

describe("a run's output", () => {
  it("shows live progress with a cancel", () => {
    const onCancel = vi.fn();
    render(<TemplateRunView lang="en" run={null} progress={{ step: 2, total: 6, label: "GetVersion — software", op: "", exchanges: 3, template: "DESFire" }} onCancel={onCancel} />);
    expect(screen.getByText("Step 2 / 6 — GetVersion — software")).toBeTruthy();
    expect(screen.getByText(/APDUs: 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("switches between raw in/out, raw, JSON and readable", () => {
    render(<TemplateRunView lang="en" run={run} chat={bridge()} />);
    expect(screen.getByRole("tab", { name: "Readable" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("NXP Semiconductors")).toBeTruthy();
    expect(screen.getByText(/Read completely · APDUs: 6/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Raw in/out" }));
    const pre = () => document.querySelector("pre.nfcwb__tplout")!.textContent!;
    expect(pre()).toContain("→ 9060000000\n← 04010101001A05 91AF (DESFire status af (ADDITIONAL_FRAME))");
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(pre().split("\n")[0]).toBe("04010101001A05 91AF");
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    expect(JSON.parse(pre())).toEqual(run.exchanges);
  });

  it("Share: the system share sheet — the text, or the JSON as a file", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, share, canShare: () => true });
    const notices: string[] = [];
    render(<TemplateRunView lang="en" run={run} chat={bridge()} onNotice={(s) => notices.push(s)} />);
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0][0]).toMatchObject({ title: DESFIRE.label, text: expect.stringContaining("04010101001A05 91AF") });
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    const files = (share.mock.calls[1][0] as unknown as { files: File[] }).files;
    expect(files[0].name).toMatch(/^nfc-mifare-desfire-.*\.json$/);
    expect(notices).toEqual(["Shared.", "Shared."]);
  });

  it("Share without the share sheet: copies and saves a file", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, share: undefined, clipboard: { writeText } });
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const notices: string[] = [];
    render(<TemplateRunView lang="en" run={run} chat={bridge()} onNotice={(s) => notices.push(s)} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toContain("NXP Semiconductors");
    expect(createObjectURL).toHaveBeenCalled();
    await waitFor(() => expect(notices[0]).toMatch(/^Copied to the clipboard and saved as nfc-mifare-desfire-.*\.txt\.$/));
  });

  it("Forward: a room, then one member — the readable text as a message", async () => {
    const chat = bridge();
    render(<TemplateRunView lang="en" run={run} chat={chat} />);
    fireEvent.click(screen.getByRole("button", { name: "Forward to a room" }));
    const dialog = screen.getByRole("dialog", { name: "Forward the output" });
    expect(within(dialog).getByText("Everyone in the room")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Alice"));
    fireEvent.click(within(dialog).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(chat.forward).toHaveBeenCalled());
    const [target, body] = chat.forward.mock.calls[0] as [unknown, { kind: string; text: string }];
    expect(target).toEqual({ roomKey: "local|brno", member: { id: "p1", name: "Alice" } });
    expect(body.kind).toBe("text");
    expect(body.text).toContain("NXP Semiconductors");
  });

  it("Forward: the JSON view goes as a file, to everyone in another room (which comes on screen)", async () => {
    const chat = bridge();
    render(<TemplateRunView lang="en" run={run} chat={chat} />);
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward to a room" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(/praha/));
    expect(within(dialog).getByText("Sending brings praha on screen.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(chat.forward).toHaveBeenCalled());
    const [target, body] = chat.forward.mock.calls[0] as [unknown, { kind: string; file: File; caption: string }];
    expect(target).toEqual({ roomKey: "local|praha" });
    expect(body.kind).toBe("file");
    expect(body.file.name).toMatch(/\.json$/);
    expect(JSON.parse(await body.file.text())).toEqual(run.exchanges);
  });

  it("To myself: a note in the room on screen", async () => {
    const chat = bridge();
    const notices: string[] = [];
    render(<TemplateRunView lang="en" run={run} chat={chat} onNotice={(s) => notices.push(s)} />);
    fireEvent.click(screen.getByRole("button", { name: "To myself (a note only I see)" }));
    await waitFor(() => expect(chat.noteToSelf).toHaveBeenCalled());
    expect((chat.noteToSelf.mock.calls[0] as [{ text: string }])[0].text).toContain("NXP Semiconductors");
    await waitFor(() => expect(notices[0]).toBe("Saved in brno as a note — only you see it, it was not sent."));
  });

  it("Forward and To myself are off without a room", () => {
    render(<TemplateRunView lang="en" run={run} chat={bridge({ rooms: () => [], noteRoom: () => null })} />);
    expect((screen.getByRole("button", { name: "Forward to a room" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "To myself (a note only I see)" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("G-19: card numbers are masked in every view and in what is sent — unless the holder asks", async () => {
    const emvRun = await runTemplate(emvCard().t, STANDARD_APDU_TEMPLATES.find((x) => x.label === "Mastercard (credit / debit)")!);
    const chat = bridge();
    render(<TemplateRunView lang="en" run={emvRun} chat={chat} />);
    expect(screen.getByTestId("nfc-tpl-masked").textContent).toMatch(/Card numbers and track data are masked/);
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    const pre = () => document.querySelector("pre.nfcwb__tplout")!.textContent!;
    expect(pre()).not.toContain("5413330089020011");
    fireEvent.click(screen.getByRole("button", { name: "To myself (a note only I see)" }));
    await waitFor(() => expect(chat.noteToSelf).toHaveBeenCalledTimes(1));
    const note = (chat.noteToSelf.mock.calls[0] as [{ text: string }])[0].text;
    expect(note).toContain("card numbers masked");
    expect(note).not.toContain("5413330089020011");
    fireEvent.click(screen.getByLabelText("Full card numbers"));
    expect(pre()).toContain("5413330089020011");
    expect(screen.getByTestId("nfc-tpl-masked").textContent).toMatch(/Full card numbers and track data are shown/);
  });

  it("a text too long for a message goes as a .txt file", () => {
    const big = { ...run, exchanges: Array.from({ length: 2000 }, (_, i) => ({ ...run.exchanges[0], step: i + 1 })) };
    const b = chatBody(big, "io", "en", false);
    expect(b.kind).toBe("file");
    if (b.kind === "file") expect(b.file.name).toMatch(/\.txt$/);
  });
});

describe("the workbench runs a picked template end to end", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ values: { apduTemplates: STANDARD_APDU_TEMPLATES }, updatedAt: 1 }), { headers: { "content-type": "application/json" } })));
  });

  it("connect → Templates → DESFire → every step runs → the output with its actions", async () => {
    const chat = bridge();
    render(<NfcWorkbench lang="en" session={null} {...base} chat={chat} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    await screen.findByRole("button", { name: /Disconnect/ });
    fireEvent.click(screen.getByRole("tab", { name: "Card data" }));
    fireEvent.click(screen.getByRole("button", { name: /Templates/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /MIFARE DESFire — version/ }));
    await screen.findByText("NXP Semiconductors", undefined, { timeout: 5000 });
    expect(document.querySelector(".nfcwb__tplrun .nfcwb__banner--ok")?.textContent).toMatch(/Read completely · APDUs: 6/);
    // The log says what ran, and how it went.
    expect(screen.getByText(/▶ MIFARE DESFire — version, applications, free memory/)).toBeTruthy();
    expect(screen.getByText(/^MIFARE DESFire — version, applications, free memory: Read completely/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "To myself (a note only I see)" }));
    await waitFor(() => expect(chat.noteToSelf).toHaveBeenCalled());
  });

  it("an e-ID template asks the document's key in the e-ID form, then goes on", async () => {
    (globalThis as { __nfcSim?: unknown }).__nfcSim = bacChip(KEY, MRTD_FILES()).transport;
    try {
      render(<NfcWorkbench lang="en" session={null} {...base} chat={bridge()} />);
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
      await screen.findByRole("button", { name: /Disconnect/ });
      fireEvent.click(screen.getByRole("tab", { name: "Card data" }));
      fireEvent.click(screen.getByRole("button", { name: /Templates/ }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /MRZ data only/ }));
      await screen.findByText(/needs the document's key/);
      expect(screen.getByText(/Step 1 \/ 1/)).toBeTruthy(); // still running, waiting for the key
      fireEvent.change(screen.getByPlaceholderText(/P<UTOERIKSSON/), { target: { value: MRZ } });
      fireEvent.click(screen.getByRole("button", { name: /Continue the template/ }));
      await waitFor(() => expect(document.querySelector(".nfcwb__tplrun .nfcwb__banner")).toBeTruthy(), { timeout: 5000 });
      expect(document.querySelector(".nfcwb__tplrun .nfcwb__banner")!.textContent).toMatch(/Read completely/);
      expect(document.querySelector(".nfcwb__tplout--readable")!.textContent).toMatch(/ERIKSSON/);
      fireEvent.click(screen.getByRole("tab", { name: "Raw in/out" }));
      // The protected APDUs are in the transcript (as sent: CLA 0C)…
      expect(document.querySelector("pre.nfcwb__tplout")!.textContent).toMatch(/→ 0CA4020C/);
      // …labelled with what they read (the JSON view's labels).
      fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
      const ex = JSON.parse(document.querySelector("pre.nfcwb__tplout")!.textContent!) as Array<{ label: string; command: string }>;
      expect(ex.some((e) => e.label.endsWith("· EF.COM") && e.command.startsWith("0CA4020C"))).toBe(true);
    } finally {
      delete (globalThis as { __nfcSim?: unknown }).__nfcSim;
    }
  });
});
