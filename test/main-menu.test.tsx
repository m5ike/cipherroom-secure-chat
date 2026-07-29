import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen, act } from "@testing-library/react";
import { MainMenu, MENU_ENTRIES } from "../client/src/components/MainMenu";
import type { Lang } from "../client/src/lib/i18n";

const LANG: Lang = "en";

describe("MainMenu", () => {
  beforeEach(() => { cleanup(); });

  it("renders inline mode with icon + label buttons", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="inline" lang={LANG} onOpen={onOpen} />);
    for (const entry of MENU_ENTRIES) {
      const btn = screen.getByTestId(entry.testId);
      expect(btn).toBeTruthy();
      // Native title for desktop + ARIA label for screen readers.
      expect(btn.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("renders tooltip mode with icon-only buttons and uses the aria-label as the only label", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="tooltip" lang={LANG} onOpen={onOpen} />);
    const first = MENU_ENTRIES[0];
    const btn = screen.getByTestId(first.testId);
    expect(btn.getAttribute("title")).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBeTruthy();
  });

  it("renders speed-dial mode with a single toggle button", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    const toggle = screen.getByTestId("btn-menu-speeddial");
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("speeddial-menu")).toBeNull();
  });

  it("opens the speed-dial panel on click", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    expect(screen.getByTestId("speeddial-menu")).toBeTruthy();
    const toggle = screen.getByTestId("btn-menu-speeddial");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("calls onOpen with the panel key when an inline button is clicked", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="inline" lang={LANG} onOpen={onOpen} />);
    const btn = screen.getByTestId(MENU_ENTRIES[1].testId); // settings
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith("settings");
  });

  it("calls onOpen through the speed-dial panel and closes the panel", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    fireEvent.click(screen.getByTestId("speeddial-btn-templates"));
    expect(onOpen).toHaveBeenCalledWith("templates");
    expect(screen.queryByTestId("speeddial-menu")).toBeNull();
  });

  it("closes the speed-dial panel on Escape and refocuses the toggle", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    const toggle = screen.getByTestId("btn-menu-speeddial");
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("speeddial-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("speeddial-menu")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("marks aria-current for the active panel in inline mode", () => {
    const onOpen = vi.fn();
    render(
      <MainMenu
        mode="inline"
        lang={LANG}
        onOpen={onOpen}
        currentPanel="settings"
      />,
    );
    const settingsBtn = screen.getByTestId("btn-settings");
    expect(settingsBtn.getAttribute("aria-current")).toBe("page");
    expect(settingsBtn.getAttribute("data-current")).toBe("true");
    const templatesBtn = screen.getByTestId("btn-templates");
    expect(templatesBtn.getAttribute("aria-current")).toBeNull();
  });

  it("marks aria-current in the speed-dial floating panel", () => {
    const onOpen = vi.fn();
    render(
      <MainMenu
        mode="speeddial"
        lang={LANG}
        onOpen={onOpen}
        currentPanel="trust"
      />,
    );
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    const trustItem = screen.getByTestId("speeddial-btn-trust");
    expect(trustItem.getAttribute("aria-current")).toBe("page");
    const peersItem = screen.getByTestId("speeddial-btn-peers");
    expect(peersItem.getAttribute("aria-current")).toBeNull();
  });

  it("ArrowDown moves focus into the floating panel on first focus", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    const toggle = screen.getByTestId("btn-menu-speeddial");
    toggle.focus();
    fireEvent.click(toggle);
    // Document-level keydown is what the menu listens to.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    // After ArrowDown, an item inside the <ul role="menu"> should have
    // focus. Validate that the document.activeElement moved into the
    // menu list (we don't assert a specific item — order may vary).
    expect(document.activeElement).not.toBe(toggle);
    const list = screen.getByTestId("speeddial-menu").querySelector("ul");
    expect(list).toBeTruthy();
    expect(list?.contains(document.activeElement)).toBe(true);
  });

  it("closes the speed-dial panel on outside click", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    expect(screen.queryByTestId("speeddial-menu")).toBeTruthy();
    // Dispatch mousedown on the body — outside the wrapper ref.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("speeddial-menu")).toBeNull();
  });

  // ---- v2.4.1 portal-escape invariants ----

  it("speed-dial panel renders via createPortal into document.body", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    const panel = screen.getByTestId("speeddial-menu");
    expect(panel).toBeTruthy();
    // Portal target: panel must be a direct child of <body>,
    // NOT a descendant of the toggle's parent wrapper.
    expect(document.body.contains(panel)).toBe(true);
    const wrapper = screen.getByTestId("btn-menu-speeddial").parentElement;
    expect(wrapper?.contains(panel)).toBe(false);
  });

  it("panel has the CSS --z-menu stacking token resolved to a high z-index", () => {
    // Read index.css as raw text and assert --z-menu is defined
    // with a numeric value >= 9999.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cssPath = path.resolve(
      __dirname,
      "..",
      "client",
      "src",
      "index.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    const rootMatch = css.match(/:root[^{]*\{[^}]*--z-menu:\s*(\d+)/);
    expect(rootMatch).not.toBeNull();
    const zValue = Number(rootMatch![1]);
    expect(zValue).toBeGreaterThanOrEqual(9999);
  });

  it(".menu-panel CSS rule explicitly declares position: fixed", () => {
    // Static guard: the CSS rule must opt the panel into position:fixed.
    // Otherwise it would inherit from the relative wrapper and be clipped
    // by .toolbar.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cssPath = path.resolve(
      __dirname,
      "..",
      "client",
      "src",
      "index.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    // Find every ".menu-panel {" block and require position:fixed in AT LEAST one
    const menuPanelBlocks = css.match(/\.menu-panel\s*\{[^}]*\}/g) ?? [];
    expect(menuPanelBlocks.length).toBeGreaterThan(0);
    const hasFixed = menuPanelBlocks.some((b) => /position:\s*fixed/i.test(b));
    expect(hasFixed).toBe(true);
  });
});
