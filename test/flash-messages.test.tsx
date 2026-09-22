// The notice at the top of the screen (components/FlashMessages.tsx):
// what it shows, how it is dismissed, and that the settings drive it.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FlashMessages } from "../client/src/components/FlashMessages";
import { loadPreferences } from "../client/src/lib/preferences";
import type { FlashMessage } from "../client/src/lib/flash";

afterEach(() => cleanup());

const SETTINGS = loadPreferences().flash;
const MESSAGE: FlashMessage = { id: "f1", text: "Spojení obnoveno", kind: "success", at: Date.now() };

function show(over: Partial<Parameters<typeof FlashMessages>[0]> = {}) {
  const props = {
    message: MESSAGE,
    queued: 0,
    settings: SETTINGS,
    onDismiss: vi.fn(),
    label: "Zavřít",
    ...over,
  };
  render(<FlashMessages {...props} />);
  return props;
}

describe("what it shows", () => {
  it("shows the text, the kind and the icon", () => {
    show();
    const flash = screen.getByTestId("flash-message");
    expect(flash.textContent).toContain("Spojení obnoveno");
    expect(flash.getAttribute("data-kind")).toBe("success");
    expect(flash.querySelector(".flash__icon")).toBeTruthy();
  });

  it("adds the detail line and says how many are still waiting", () => {
    show({ message: { ...MESSAGE, detail: "místnost alpha" }, queued: 3 });
    expect(screen.getByTestId("flash-message").textContent).toContain("místnost alpha");
    expect(screen.getByTestId("flash-queued").textContent).toBe("+3");
  });

  it("shows nothing when there is no message, or when flashes are off", () => {
    show({ message: null });
    expect(screen.queryByTestId("flash-message")).toBeNull();
    cleanup();
    show({ settings: { ...SETTINGS, enabled: false } });
    expect(screen.queryByTestId("flash-message")).toBeNull();
  });
});

describe("dismissing", () => {
  it("hands the id back when clicked", () => {
    const props = show({ queued: 1 });
    fireEvent.click(screen.getByTestId("flash-message"));
    expect(props.onDismiss).toHaveBeenCalledWith("f1");
  });
});

describe("the settings", () => {
  it("drive position, size, radius, colours and the icon", () => {
    show({
      settings: { ...SETTINGS, position: "top-right", size: 18, radius: 4, background: "#102030", color: "#ffeecc", icon: false },
    });
    const layer = screen.getByTestId("flash-layer");
    const flash = screen.getByTestId("flash-message") as HTMLElement;
    expect(layer.className).toContain("flash-at-top-right");
    expect(flash.style.fontSize).toBe("18px");
    expect(flash.style.borderRadius).toBe("4px");
    expect(flash.style.background).toBe("#102030");
    expect(flash.style.color).toBe("#ffeecc");
    expect(flash.querySelector(".flash__icon")).toBeNull();
  });

  it("picks the animation class", () => {
    show({ settings: { ...SETTINGS, animation: "slide" } });
    expect(screen.getByTestId("flash-message").className).toContain("flash-anim-slide");
    cleanup();
    show({ settings: { ...SETTINGS, animation: "none" } });
    expect(screen.getByTestId("flash-message").className).toContain("flash-anim-none");
  });
});
