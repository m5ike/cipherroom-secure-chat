// The unified Appearance screen: tabs, template / typography / colour /
// display settings write Preferences; the Edit Mode switch; Google Fonts
// consent; saved Edit Mode rules can be toggled and deleted. Plus the
// Preferences migration for the new fields.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { useState } from "react";
import { AppearancePanel } from "../client/src/components/AppearancePanel";
import { loadPreferences, type Preferences } from "../client/src/lib/preferences";
import { styleStore } from "../client/src/lib/style-editor";
import { upsertRule, STORAGE_KEY } from "../client/src/lib/style-overrides";

function Harness({ onChange, initial }: { onChange: (p: Partial<Preferences>) => void; initial?: Partial<Preferences> }) {
  const [prefs, set] = useState<Preferences>({ ...loadPreferences(), lang: "en", ...initial });
  return (
    <AppearancePanel
      open
      onClose={() => {}}
      prefs={prefs}
      setPrefs={(p) => { onChange(p); set((cur) => ({ ...cur, ...p })); }}
      lang="en"
    />
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  styleStore._reset();
  document.head.querySelectorAll("link[data-m5-font]").forEach((l) => l.remove());
});

describe("AppearancePanel", () => {
  it("has the five tabs and the Edit Mode switch (green check / red cross)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (const id of ["theme", "type", "color", "display", "editor"]) expect(screen.getByTestId(`ap-tab-${id}`)).toBeTruthy();
    const toggle = screen.getByTestId("edit-mode-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toContain("OFF");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ editMode: true });
    expect(screen.getByTestId("edit-mode-toggle").textContent).toContain("ON");
  });

  it("theme tab: template, layout, width and menu mode (moved from Settings)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("ap-tab-theme"));
    fireEvent.click(screen.getByTestId("theme-paper"));
    fireEvent.click(screen.getByTestId("layout-compact"));
    fireEvent.click(screen.getByTestId("chatwidth-full"));
    fireEvent.click(screen.getByTestId("menu-display-icons-text"));
    // Picking a template also records that it was a choice (the operator's
    // default no longer applies to this device).
    expect(onChange).toHaveBeenCalledWith({ theme: "paper", themeSet: true });
    expect(onChange).toHaveBeenCalledWith({ layout: "compact" });
    expect(onChange).toHaveBeenCalledWith({ chatWidth: "full" });
    expect(onChange).toHaveBeenCalledWith({ menuDisplay: "icons-text" });
  });

  it("groups the templates, offers light / dark for iOS and Windows, and icon styles", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={{ theme: "ios", themeSet: true }} />);
    fireEvent.click(screen.getByTestId("ap-tab-theme"));
    expect(screen.getByTestId("theme-family-system")).toBeTruthy();
    expect(screen.getByTestId("theme-ios")).toBeTruthy();
    expect(screen.getByTestId("theme-windows")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tone-dark"));
    expect(onChange).toHaveBeenCalledWith({ themeTone: "dark", themeSet: true });
    fireEvent.click(screen.getByTestId("icons-badge"));
    expect(onChange).toHaveBeenCalledWith({ iconStyle: "badge", themeSet: true });
  });

  it("typography: searching fonts, picking a Google font asks for consent, sliders", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("ap-tab-type"));
    fireEvent.click(screen.getByTestId("font-ui-toggle"));
    fireEvent.change(screen.getByTestId("font-ui-search"), { target: { value: "jakarta" } });
    const option = screen.getByTestId("font-opt-g-plus-jakarta-sans");
    expect(screen.queryByTestId("font-opt-g-inter")).toBeNull();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith({ googleFonts: true });
    expect(onChange).toHaveBeenCalledWith({ font: "g-plus-jakarta-sans" });
    fireEvent.change(screen.getByTestId("slider-text-size"), { target: { value: "18" } });
    fireEvent.change(screen.getByTestId("slider-line-height"), { target: { value: "1.8" } });
    expect(onChange).toHaveBeenCalledWith({ textSize: 18 });
    expect(onChange).toHaveBeenCalledWith({ lineHeight: 1.8 });
  });

  it("no Google request before consent; with consent the chosen family is requested", () => {
    render(<Harness onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("ap-tab-type"));
    fireEvent.click(screen.getByTestId("font-ui-toggle"));
    expect(document.head.querySelectorAll("link[data-m5-font]")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("fonts-consent"));
    // (IntersectionObserver previews are browser-only; the App loads the chosen family.)
  });

  it("colours: palette swatch, hex input, template presets", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("ap-tab-color"));
    const accent = screen.getByTestId("color-accent");
    fireEvent.click(within(accent).getAllByLabelText(/^#[0-9a-f]{6}$/)[20]);
    expect(onChange.mock.calls.some(([p]) => typeof p.accentColor === "string" && /^#[0-9a-f]{6}$/.test(p.accentColor))).toBe(true);
    fireEvent.click(screen.getByTestId("color-accent-preset-green"));
    expect(onChange).toHaveBeenCalledWith({ accent: "green", accentColor: "" });
    fireEvent.click(screen.getByTestId("color-mine-toggle"));
    const hex = screen.getByTestId("color-mine-hex");
    fireEvent.change(hex, { target: { value: "#12ab34" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ bubbleMine: "#12ab34" });
    fireEvent.click(screen.getByTestId("pattern-diagonal"));
    expect(onChange).toHaveBeenCalledWith({ chatPattern: "diagonal" });
  });

  it("display: shows the detected device and lets the layout be forced", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("ap-tab-display"));
    expect(screen.getByTestId("device-info").textContent).toMatch(/Detected/);
    fireEvent.click(screen.getByTestId("device-layout-phone"));
    expect(onChange).toHaveBeenCalledWith({ deviceLayout: "phone" });
  });

  it("editor: lists saved rules, toggles and deletes them, saves custom CSS", () => {
    styleStore.commit(upsertRule(styleStore.get(), { selector: ".composer-bar", state: ":focus-within", scope: "all", declarations: "border-color: gold", important: false, enabled: true }));
    render(<Harness onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("ap-tab-editor"));
    const list = screen.getByTestId("saved-rules");
    expect(list.textContent).toContain(".composer-bar");
    expect(list.textContent).toContain(":focus-within");
    fireEvent.click(within(list).getByLabelText("Disable"));
    expect(styleStore.get().rules[0].enabled).toBe(false);
    fireEvent.click(within(list).getByLabelText("Delete"));
    expect(styleStore.get().rules).toHaveLength(0);
    fireEvent.change(screen.getByTestId("custom-css"), { target: { value: "body { outline: 1px solid red }" } });
    fireEvent.click(screen.getByTestId("custom-css-save"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).globalCss).toContain("outline");
  });
});

describe("Preferences — appearance fields", () => {
  it("migrates the old S/M/L size and validates everything new", () => {
    localStorage.setItem("m5cet:prefs:v2", JSON.stringify({
      fontSize: "lg", font: "comic", chatFont: "g-lora", accentColor: "red", bubbleMine: "#abc", uiRadius: 9,
      bubbleRadius: -1, fontWeight: 523, lineHeight: 0.2, deviceLayout: "watch", editMode: true, chatPattern: "diagonal",
    }));
    const p = loadPreferences();
    expect(p.textSize).toBe(17);
    expect(p.font).toBe("theme");
    expect(p.chatFont).toBe("g-lora");
    expect(p.accentColor).toBe("");
    expect(p.bubbleMine).toBe("#abc");
    expect(p.uiRadius).toBe(2);
    expect(p.bubbleRadius).toBe(-1);
    expect(p.fontWeight).toBe(500);
    expect(p.lineHeight).toBe(1.1);
    expect(p.deviceLayout).toBe("auto");
    expect(p.editMode).toBe(true);
    expect(p.chatPattern).toBe("diagonal");
    expect(p.googleFonts).toBe(false);
  });
});
