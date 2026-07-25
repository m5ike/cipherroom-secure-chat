import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { MainMenu, MENU_ENTRIES } from "../client/src/components/MainMenu";
import type { Lang } from "../client/src/lib/i18n";

const LANG: Lang = "en";

describe("MainMenu", () => {
  beforeEach(() => { cleanup(); });

  it("renders inline mode with icon + label buttons", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="inline" lang={LANG} onOpen={onOpen} />);
    // Each menu entry should produce a testid-prefixed button.
    for (const entry of MENU_ENTRIES) {
      const btn = screen.getByTestId(entry.testId);
      expect(btn).toBeTruthy();
      expect(btn.getAttribute("title")).toBeTruthy();
    }
  });

  it("renders tooltip mode with icon-only buttons and uses the title attribute as the only label", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="tooltip" lang={LANG} onOpen={onOpen} />);
    const first = MENU_ENTRIES[0];
    const btn = screen.getByTestId(first.testId);
    // In tooltip mode, the label is not rendered inline (no .sm:inline span).
    // Verify the title attribute is set so the native tooltip is visible.
    expect(btn.getAttribute("title")).toBeTruthy();
  });

  it("renders speed-dial mode with a single toggle button", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    // The speed-dial toggle is a single button.
    const toggle = screen.getByTestId("btn-menu-speeddial");
    expect(toggle).toBeTruthy();
    // Panel is initially hidden.
    expect(screen.queryByTestId("speeddial-menu")).toBeNull();
    // Click it open.
    fireEvent.click(toggle);
    expect(screen.queryByTestId("speeddial-menu")).toBeTruthy();
    // Each entry ID should now appear inside the floating menu with the
    // speeddial- prefix.
    for (const entry of MENU_ENTRIES.slice(0, 3)) {
      expect(screen.getByTestId(`speeddial-${entry.testId}`)).toBeTruthy();
    }
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
    // After selecting an entry the panel should be closed.
    expect(screen.queryByTestId("speeddial-menu")).toBeNull();
  });
});
