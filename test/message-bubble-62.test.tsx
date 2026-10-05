// 6.2: the bubble's new parts, drawn from the default layouts — the map of a
// position, files shown and listed with save / share / forward, a hidden
// message — and the detail window's hide / delete (with a confirmation),
// receipts and every state with its time.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { MessageBubble, type MessageBubbleProps } from "../client/src/components/MessageBubble";
import { MessageInfoView, type MessageInfo } from "../client/src/components/MessageInfoModal";
import { DEFAULT_MAP_PREVIEW } from "../client/src/lib/client-config";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const base: MessageBubbleProps = {
  id: "m1", senderId: "p-a", senderName: "Jana", mine: false, isSystem: false, secure: true, createdAt: 0, timeLabel: "10:42", text: "Jsem tady",
  onVanish: () => undefined, badge: <b>Jana</b>, lang: "cs", renderText: (s) => s, formatSize: (n) => `${n} B`,
};
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// 6.7: the map left the bubble — the pin opens it in the place window
// (test/location-sheet.test.tsx draws its tiles, links and lists).
describe("the map of a position", () => {
  it("is not drawn in the bubble: the pin is, as in the Android app", () => {
    const { container } = render(<MessageBubble {...base} loc={{ lat: 50.0875, lon: 14.4213, acc: 12 }} mapPolicy={{ ...DEFAULT_MAP_PREVIEW, grayscale: true, accent: "#ffee00" }} />);
    expect(screen.queryByTestId("msg-map-m1")).toBeNull();
    expect(container.querySelector("img.msg-map__tile")).toBeNull();
    expect(container.querySelector("[data-testid=msg-loc]")?.tagName).toBe("BUTTON");
  });

  it("keeps the pin when the operator turned the map off", () => {
    const { container } = render(<MessageBubble {...base} loc={{ lat: 50.0875, lon: 14.4213 }} mapPolicy={{ ...DEFAULT_MAP_PREVIEW, enabled: false }} />);
    expect(screen.queryByTestId("msg-map-m1")).toBeNull();
    expect(container.querySelector("[data-testid=msg-loc]")).not.toBeNull();
  });
});

describe("files", () => {
  it("are listed in the footer with save, share and forward", () => {
    render(<MessageBubble {...base} onForward={() => undefined} attachment={{ kind: "file", name: "zprava.pdf", mime: "application/pdf", size: 2048, dataUrl: "data:application/pdf;base64,JVBERg==" }} />);
    const row = screen.getByTestId("msg-file-m1");
    expect(row.querySelector(".msg-file__name")?.textContent).toBe("zprava.pdf");
    expect(row.querySelector(".msg-file__size")?.textContent).toBe("2048 B");
    expect(screen.getByTestId("file-save-m1")).toBeTruthy();
    expect(screen.getByTestId("file-share-m1")).toBeTruthy();
    expect(screen.getByTestId("file-forward-m1")).toBeTruthy();
    // A PDF is a card (no inline viewer: that would need frame-src blob: in the CSP).
    expect(screen.getByTestId("msg-pdf-m1").textContent).toContain("Dokument PDF");
    expect(document.querySelector("iframe, object, embed")).toBeNull();
  });

  it("offer a menu that gives nothing away when the browser cannot share files", async () => {
    vi.stubGlobal("navigator", { ...navigator, share: undefined, canShare: undefined });
    render(<MessageBubble {...base} attachment={{ kind: "file", name: "a.bin", mime: "application/octet-stream", size: 3, dataUrl: "data:application/octet-stream;base64,AAAA" }} />);
    await act(async () => { fireEvent.click(screen.getByTestId("file-share-m1")); });
    const menu = screen.getByTestId("msg-share-menu-m1");
    expect(menu.textContent).toContain("Kopírovat název");
    expect(menu.textContent).toContain("Uložit");
  });

  it("show a video and the first lines of a text", () => {
    render(<MessageBubble {...base} id="v" attachment={{ kind: "file", name: "clip.mp4", mime: "video/mp4", size: 3, dataUrl: `data:video/mp4;base64,${b64("abc")}` }} />);
    const video = screen.getByTestId("msg-video-v") as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.hasAttribute("controls")).toBe(true);
    // An inline file plays from a blob: URL (media-src has no data:).
    expect(video.getAttribute("src")).toMatch(/^blob:/);
    render(<MessageBubble {...base} id="t" attachment={{ kind: "file", name: "plan.md", mime: "text/markdown", size: 30, dataUrl: `data:text/markdown;base64,${b64("# Plan\n- 9:00\n- 10:30\n")}` }} />);
    expect(screen.getByTestId("msg-textprev-t").textContent).toBe("# Plan\n- 9:00\n- 10:30");
  });

  it("left out of the history show their name, without buttons", () => {
    render(<MessageBubble {...base} attachment={{ kind: "file", name: "big.zip", mime: "application/octet-stream", size: 9_000_000, dataUrl: "", dropped: true }} />);
    expect(screen.getByTestId("msg-file-m1").className).toContain("is-dropped");
    expect(screen.queryByTestId("file-save-m1")).toBeNull();
  });
});

describe("the timeline from the bubble", () => {
  it("reports a reveal of a hold-to-read message", () => {
    const onRevealed = vi.fn();
    render(<MessageBubble {...base} flags={{ tap: true }} onRevealed={onRevealed} />);
    fireEvent.pointerDown(screen.getByTestId("tap-m1"));
    expect(onRevealed).toHaveBeenCalledWith("m1");
  });

  it("marks a hidden message while hidden ones are shown", () => {
    render(<MessageBubble {...base} hidden />);
    expect(screen.getByTestId("message-m1").querySelector(".msg-bubble")?.className).toContain("msg-bubble--hidden");
    expect(screen.getByTestId("msg-hidden-m1").textContent).toContain("Skryto");
  });
});

describe("the detail window", () => {
  const NOW = Date.now();
  const info: MessageInfo = {
    id: "m1", mine: true, sender: "Alice", senderId: "p-a", recipients: ["Bob", "Dan"], route: "P2P", createdAt: NOW, secure: true, flags: [],
    kinds: ["text", "soubor"], size: { text: 42, file: 2048 },
    audit: [{ state: "created", at: NOW }, { state: "stored", at: NOW + 5, meta: "Dan" }, { state: "hidden", at: NOW + 9, meta: "0" }],
    receipts: [{ name: "Bob", delivered: NOW + 7, read: NOW + 8 }, { name: "Dan", stored: NOW + 5 }],
  };

  it("lists every state with its time, the size, the kinds and receipts by recipient", () => {
    render(<MessageInfoView info={info} lang="cs" onForward={() => undefined} />);
    const audit = screen.getByTestId("msg-audit").textContent ?? "";
    expect(audit).toContain("uloženo na serveru (šifrovaně)");
    expect(audit).toContain("Skryto");
    expect(audit).toContain("do příštího přihlášení");
    expect(document.body.textContent).toContain("text 42 B · soubor 2,0 kB"); // 6.13: Czech notation
    expect(document.body.textContent).toContain("text · soubor");
    const receipts = screen.getByTestId("msg-receipts");
    expect(receipts.querySelectorAll("li")).toHaveLength(2);
    expect(receipts.textContent).toContain("Bob");
    expect(receipts.textContent).toContain("přečteno");
    // Nothing to hide or delete with: no buttons for it.
    expect(screen.queryByTestId("msginfo-manage")).toBeNull();
  });

  it("hides for a chosen time, and deletes only after a confirmation", () => {
    const onHide = vi.fn();
    const onDelete = vi.fn();
    render(<MessageInfoView info={info} lang="en" onForward={() => undefined} actions={{ onHide, onDelete, onUnhide: () => undefined }} />);
    for (const id of ["15m", "1h", "8h", "1d", "signin"]) expect(screen.getByTestId(`msginfo-hide-${id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("msginfo-hide-8h"));
    expect(onHide).toHaveBeenCalledWith("8h");
    fireEvent.click(screen.getByTestId("msginfo-delete"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("msginfo-delete-no"));
    expect(screen.queryByTestId("msginfo-delete-yes")).toBeNull();
    fireEvent.click(screen.getByTestId("msginfo-delete"));
    fireEvent.click(screen.getByTestId("msginfo-delete-yes"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("offers to show a hidden message again", () => {
    const onUnhide = vi.fn();
    render(<MessageInfoView info={{ ...info, hiddenUntil: 0 }} lang="en" onForward={() => undefined} actions={{ onHide: () => undefined, onDelete: () => undefined, onUnhide }} />);
    expect(document.body.textContent).toContain("Hidden until the next sign-in");
    expect(screen.queryByTestId("msginfo-hide-15m")).toBeNull();
    fireEvent.click(screen.getByTestId("msginfo-unhide"));
    expect(onUnhide).toHaveBeenCalledTimes(1);
  });
});
