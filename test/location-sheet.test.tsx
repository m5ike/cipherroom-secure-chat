// 6.7: the place of a message on the web — the bubble shows the Android
// app's pin (a position message: its place chip) instead of a map; a click
// opens the place window (map through this server, coordinates, navigation
// and ride apps); and beside a hold-to-read bubble the row holds it open.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { MessageBubble, type MessageBubbleProps } from "../client/src/components/MessageBubble";
import { LocationSheet } from "../client/src/components/LocationSheet";
import { DEFAULT_MAP_PREVIEW } from "../client/src/lib/client-config";
import { placeOf } from "../client/src/lib/map-preview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const base: MessageBubbleProps = {
  id: "m1", senderId: "p-a", senderName: "Jana", mine: false, isSystem: false, secure: true, createdAt: 0, timeLabel: "10:42", text: "Jsem tady",
  onVanish: () => undefined, badge: <b>Jana</b>, lang: "cs", renderText: (s) => s, formatSize: (n) => `${n} B`,
};
const LOC = { lat: 50.0875, lon: 14.4213, acc: 12 };
const POSITION_TEXT = "📍 50.08750, 14.42130 (±12 m) https://www.openstreetmap.org/?mlat=50.087500&mlon=14.421300#map=15/50.087500/14.421300";
const sheet = () => screen.queryByTestId("location-sheet");

describe("the bubble", () => {
  it("shows the pin instead of the map, and asks for nothing until it is clicked", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(<MessageBubble {...base} loc={LOC} mapPolicy={DEFAULT_MAP_PREVIEW} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("msg-loc").tagName).toBe("BUTTON");
    expect(screen.getByText("Jsem tady")).toBeTruthy();
    expect(sheet()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens the place window from the pin: the map through this server, the coordinates", () => {
    render(<MessageBubble {...base} loc={LOC} mapPolicy={{ ...DEFAULT_MAP_PREVIEW, grayscale: true }} />);
    fireEvent.click(screen.getByTestId("msg-loc"));
    const win = sheet()!;
    expect(win.getAttribute("aria-label")).toBe("Aktuální poloha: Jana");
    const map = screen.getByTestId("loc-map");
    expect(map.getAttribute("href")).toContain("openstreetmap.org");
    expect(map.getAttribute("rel")).toBe("noopener noreferrer");
    expect(map.className).toContain("is-gray");
    const tiles = [...map.querySelectorAll("img.msg-map__tile")].map((i) => i.getAttribute("src"));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((s) => s?.startsWith("/api/map/tile/16/"))).toBe(true);
    expect(map.querySelector(".msg-map__pin")).not.toBeNull();
    expect(map.querySelector(".msg-map__attr")?.textContent).toBe("© OpenStreetMap");
    expect(screen.getByTestId("loc-coords").textContent).toBe("50.08750, 14.42130 ± 12 m");
  });

  it("closes the window with Escape and with a click outside", () => {
    render(<MessageBubble {...base} loc={LOC} mapPolicy={DEFAULT_MAP_PREVIEW} />);
    fireEvent.click(screen.getByTestId("msg-loc"));
    expect(sheet()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet()).toBeNull();
    fireEvent.click(screen.getByTestId("msg-loc"));
    fireEvent.mouseDown(sheet()!);
    expect(sheet()).toBeNull();
  });

  it("draws a position message as its place chip (no text, no second pin); the chip opens the window", () => {
    render(<MessageBubble {...base} text={POSITION_TEXT} mapPolicy={DEFAULT_MAP_PREVIEW} />);
    const chip = screen.getByTestId("msg-place-m1");
    expect(chip.textContent).toContain("50.08750, 14.42130 ± 12 m");
    expect(screen.queryByText(/openstreetmap\.org/)).toBeNull();
    expect(screen.queryByTestId("msg-loc")).toBeNull();
    fireEvent.click(chip);
    expect(sheet()).not.toBeNull();
  });

  it("marks a live position", () => {
    render(<MessageBubble {...base} text="📍 live 50.08750, 14.42130 https://…" />);
    expect(screen.getByTestId("msg-place-m1").textContent).toContain("živě · 50.08750, 14.42130");
  });

  it("does not read a place out of a sealed message", () => {
    render(<MessageBubble {...base} text="📍 50.08750, 14.42130" flags={{ sealed: { iv: "x", salt: "y" } } as never} />);
    expect(screen.queryByTestId("msg-place-m1")).toBeNull();
  });

  it("offers navigation and rides without a map when the operator turned maps off", () => {
    render(<MessageBubble {...base} loc={LOC} mapPolicy={{ ...DEFAULT_MAP_PREVIEW, enabled: false }} />);
    fireEvent.click(screen.getByTestId("msg-loc"));
    expect(screen.queryByTestId("loc-map")).toBeNull();
    expect(screen.getByTestId("loc-nav")).toBeTruthy();
    expect(screen.getByTestId("loc-ride")).toBeTruthy();
  });
});

describe("the place window's actions", () => {
  const place = placeOf(undefined, LOC)!;

  it("lists the navigation apps in the shared order, each a link that opens apart", () => {
    render(<LocationSheet id="m1" place={place} senderName="Jana" mine={false} mapPolicy={DEFAULT_MAP_PREVIEW} lang="en" onClose={() => undefined} userAgent="Mozilla/5.0 (Macintosh)" />);
    expect(screen.queryByTestId("loc-nav-list")).toBeNull();
    fireEvent.click(screen.getByTestId("loc-nav"));
    expect(screen.getByTestId("loc-nav").getAttribute("aria-expanded")).toBe("true");
    const links = [...screen.getByTestId("loc-nav-list").querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["Google Maps", "Apple Maps", "Waze", "Mapy.com", "OpenStreetMap"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://www.google.com/maps/dir/?api=1&destination=50.087500,14.421300",
      "https://maps.apple.com/?daddr=50.087500,14.421300&dirflg=d",
      "https://waze.com/ul?ll=50.087500,14.421300&navigate=yes",
      "https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true",
      "https://www.openstreetmap.org/directions?to=50.087500,14.421300",
    ]);
    for (const a of links) { expect(a.getAttribute("target")).toBe("_blank"); expect(a.getAttribute("rel")).toBe("noopener noreferrer"); }
  });

  it("adds the phone's map app (geo:) on Android", () => {
    render(<LocationSheet id="m1" place={place} senderName="Jana" mine={false} lang="cs" onClose={() => undefined} userAgent="Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile" />);
    fireEvent.click(screen.getByTestId("loc-nav"));
    const geo = screen.getByTestId("loc-app-geo");
    expect(geo.getAttribute("href")).toBe("geo:50.087500,14.421300?q=50.087500,14.421300(Jana)");
    expect(geo.getAttribute("target")).toBeNull();
    expect(geo.textContent).toBe("Mapová aplikace v telefonu");
  });

  it("lists the rides: Uber gets the destination, the others get it on the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText }, userAgent: "Mozilla/5.0 (Macintosh)" });
    const onNotice = vi.fn();
    render(<LocationSheet id="m1" place={place} senderName="Jana" mine={false} lang="en" onClose={() => undefined} onNotice={onNotice} />);
    fireEvent.click(screen.getByTestId("loc-ride"));
    const ids = [...screen.getByTestId("loc-ride-list").querySelectorAll("a")].map((a) => a.getAttribute("data-testid"));
    expect(ids).toEqual(["loc-app-uber", "loc-app-bolt", "loc-app-liftago", "loc-app-freenow"]);
    expect(screen.getByTestId("loc-app-uber").getAttribute("href")).toBe("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300&dropoff[nickname]=Jana");
    fireEvent.click(screen.getByTestId("loc-app-uber"));
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId("loc-app-bolt")); });
    expect(writeText).toHaveBeenCalledWith("50.087500, 14.421300");
    expect(onNotice).toHaveBeenCalledWith("The destination is on the clipboard — paste it in the app.");
  });

  it("keeps my own name out of the links of my own position", () => {
    render(<LocationSheet id="m1" place={place} senderName="Mike" mine lang="en" onClose={() => undefined} userAgent="Android" />);
    expect(screen.getByTestId("location-sheet").getAttribute("aria-label")).toBe("Your position");
    fireEvent.click(screen.getByTestId("loc-nav"));
    expect(screen.getByTestId("loc-app-geo").getAttribute("href")).toBe("geo:50.087500,14.421300?q=50.087500,14.421300");
  });

  it("copies the coordinates", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<LocationSheet id="m1" place={place} senderName="Jana" mine={false} lang="en" onClose={() => undefined} />);
    await act(async () => { fireEvent.click(screen.getByTestId("loc-copy")); });
    expect(writeText).toHaveBeenCalledWith("50.087500, 14.421300");
    expect(screen.getByTestId("loc-copy").textContent).toBe("Copied");
  });
});

describe("beside a hold-to-read bubble", () => {
  it("holding the row reveals the message after a moment, letting go hides it", () => {
    vi.useFakeTimers();
    const onRevealed = vi.fn();
    render(<MessageBubble {...base} flags={{ tap: true }} onRevealed={onRevealed} />);
    const side = screen.getByTestId("msg-hold-side-m1");
    fireEvent.pointerDown(side);
    expect(screen.getByTestId("tap-m1")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId("tap-m1")).toBeNull();
    expect(screen.getByText("Jsem tady")).toBeTruthy();
    expect(onRevealed).toHaveBeenCalledWith("m1");
    fireEvent.pointerUp(side);
    expect(screen.getByTestId("tap-m1")).toBeTruthy();
  });

  it("a scroll that starts there reveals nothing", () => {
    vi.useFakeTimers();
    const onRevealed = vi.fn();
    render(<MessageBubble {...base} flags={{ tap: true }} onRevealed={onRevealed} />);
    const side = screen.getByTestId("msg-hold-side-m1");
    fireEvent.pointerDown(side);
    fireEvent.pointerCancel(side);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId("tap-m1")).toBeTruthy();
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it("is only beside a hold-to-read bubble", () => {
    render(<MessageBubble {...base} />);
    expect(screen.queryByTestId("msg-hold-side-m1")).toBeNull();
  });
});
