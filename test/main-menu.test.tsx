import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen, act } from "@testing-library/react";
import { MainMenu, MENU_ENTRIES, MENU_GROUPS, avatarGlyph } from "../client/src/components/MainMenu";
import type { Lang } from "../client/src/lib/i18n";
import { DEFAULT_MENU_CONFIG, sanitizeMenuConfig, type MenuConfig } from "../client/src/lib/menu-config";

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
    // Look the entry up by panel key: the display order is free to change.
    const settings = MENU_ENTRIES.find((entry) => entry.panel === "settings")!;
    fireEvent.click(screen.getByTestId(settings.testId));
    expect(onOpen).toHaveBeenCalledWith("settings");
  });

  it("calls onOpen through the speed-dial panel and closes the panel", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    fireEvent.click(screen.getByTestId("speeddial-btn-appearance"));
    expect(onOpen).toHaveBeenCalledWith("appearance");
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
    const appearanceBtn = screen.getByTestId("btn-appearance");
    expect(appearanceBtn.getAttribute("aria-current")).toBeNull();
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

  // ---- grouping + user chip ----

  it("keeps every entry in exactly one known group, contiguously", () => {
    const known = MENU_GROUPS.map((g) => g.id);
    const seen: string[] = [];
    for (const entry of MENU_ENTRIES) {
      expect(known).toContain(entry.group);
      if (seen[seen.length - 1] !== entry.group) {
        // a group may start only once — otherwise dividers/headings would repeat
        expect(seen).not.toContain(entry.group);
        seen.push(entry.group);
      }
    }
    expect(seen).toEqual(known);
  });

  it("separates the toolbar clusters with dividers and renders profile as the user chip", () => {
    render(<MainMenu mode="icons" lang={LANG} onOpen={vi.fn()} user={{ name: "Alice", avatar: "🦊" }} />);
    const nav = screen.getByTestId("main-nav");
    // one divider between each pair of groups + one in front of the user chip
    expect(nav.querySelectorAll('[role="separator"]').length).toBe(MENU_GROUPS.length);
    const chip = screen.getByTestId("btn-profile");
    expect(chip.className).toContain("user-chip");
    expect(chip.textContent).toContain("Alice");
    expect(chip.textContent).toContain("🦊");
    expect(chip.getAttribute("aria-label")).toContain("Alice");
  });

  it("opens the profile panel from the user chip", () => {
    const onOpen = vi.fn();
    render(<MainMenu mode="icons" lang={LANG} onOpen={onOpen} user={{ name: "Alice" }} />);
    fireEvent.click(screen.getByTestId("btn-profile"));
    expect(onOpen).toHaveBeenCalledWith("profile");
  });

  it("shows the user and one heading per group inside the speed-dial panel", () => {
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={vi.fn()} user={{ name: "Alice" }} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    const panel = screen.getByTestId("speeddial-menu");
    expect(screen.getByTestId("speeddial-user").textContent).toContain("Alice");
    expect(panel.querySelectorAll(".menu-group-label").length).toBe(MENU_GROUPS.length);
    // headings must not become focus stops: every menuitem is still a button —
    // one per entry, plus the Appearance shortcut in the quick row on top.
    const items = Array.from(panel.querySelectorAll('[role="menuitem"]'));
    expect(items.length).toBe(MENU_ENTRIES.length + 1);
    expect(items.every((el) => el.tagName === "BUTTON")).toBe(true);
    expect(panel.querySelectorAll('[role="menuitem"][data-panel]').length).toBe(MENU_ENTRIES.length);
  });

  it("never turns an avatar URL into a glyph (no remote fetch, no spoofed text)", () => {
    expect(avatarGlyph({ name: "Alice", avatar: "🦊" })).toBe("🦊");
    expect(avatarGlyph({ name: "alice" })).toBe("A");
    expect(avatarGlyph({ name: "Alice", avatar: "https://evil.example/x.png" })).toBe("A");
    expect(avatarGlyph({ name: "Alice", avatar: "data:image/png;base64,AAAA" })).toBe("A");
    expect(avatarGlyph({ name: "Alice", avatar: "a-long-word" })).toBe("A");
    expect(avatarGlyph({ name: "" })).toBe("?");
    expect(avatarGlyph(undefined)).toBe("?");
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

describe("MainMenu — quick access (Appearance + Edit Mode) and build label", () => {
  beforeEach(() => { cleanup(); });

  it("the first row of the ☰ menu opens Appearance and toggles Edit Mode, no scrolling needed", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} editMode={false} onToggleEditMode={onToggle} buildLabel="M5cet 2.8.0 · build abc12345" />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    const menu = screen.getByTestId("speeddial-menu");
    const quick = screen.getByTestId("speeddial-quick");
    // Quick row comes before every group heading.
    const firstGroup = menu.querySelector(".menu-group-label")!;
    expect(quick.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const edit = screen.getByTestId("speeddial-quick-editmode");
    expect(edit.getAttribute("aria-checked")).toBe("false");
    expect(edit.textContent).toContain("OFF");
    expect(screen.getByTestId("menu-build").textContent).toBe("M5cet 2.8.0 · build abc12345");
    fireEvent.click(edit);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("speeddial-menu")).toBeNull(); // closes so picking can start
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    fireEvent.click(screen.getByTestId("speeddial-quick-appearance"));
    expect(onOpen).toHaveBeenCalledWith("appearance");
  });

  it("shows ON with a check when Edit Mode is active; inline toolbars get the switch too", () => {
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={vi.fn()} editMode onToggleEditMode={vi.fn()} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    const edit = screen.getByTestId("speeddial-quick-editmode");
    expect(edit.getAttribute("aria-checked")).toBe("true");
    expect(edit.className).toContain("is-on");
    cleanup();
    const onToggle = vi.fn();
    render(<MainMenu mode="icons-text" lang={LANG} onOpen={vi.fn()} editMode={false} onToggleEditMode={onToggle} />);
    fireEvent.click(screen.getByTestId("btn-edit-mode"));
    expect(onToggle).toHaveBeenCalled();
  });
});

describe("MainMenu — 4.0 menu built in the console (MenuConfig)", () => {
  beforeEach(() => { cleanup(); });

  const custom = (): MenuConfig => sanitizeMenuConfig({
    ...DEFAULT_MENU_CONFIG,
    trigger: { icon: "rocket", text: "Menu {$user.nickname}", showText: true, title: "Open", style: { color: "#ff0000", states: { hover: { background: "primary" } } } },
    panel: { ...DEFAULT_MENU_CONFIG.panel, width: 400, title: "Hi {$user.nickname|upper}", showClose: false },
    items: [
      { kind: "html", id: "hello", html: "<p class=\"x\">Room {$session.room} · {$room.peers} <button data-action=\"panel:settings\">go</button><button data-action=\"fn:setLang:de\">de</button></p>" },
      { kind: "separator", id: "sep1", variant: "dashed", color: "#00ff00", thickness: 2, spacing: 6 },
      { kind: "section", id: "main", label: "Main", icon: "star", children: [
        { kind: "item", id: "btn-a", icon: "globe", label: "Web", action: { type: "url", href: "https://example.org", newTab: true }, badge: "{$room.peers}" },
        { kind: "item", id: "btn-b", icon: "settings", label: "@menu.settings", action: { type: "panel", panel: "settings" }, style: { fontWeight: "700", states: { hover: { color: "#123456" } } } },
        { kind: "item", id: "btn-hidden", icon: "x", label: "Hidden", action: { type: "none" }, hidden: true },
        { kind: "item", id: "btn-rule", icon: "x", label: "Rule", action: { type: "none" }, module: "ai" },
      ] },
      { kind: "section", id: "empty", label: "Nothing shown", children: [{ kind: "item", id: "btn-gone", icon: "x", label: "Gone", action: { type: "none" }, hidden: true }] },
      { kind: "row", id: "switches", children: [
        { kind: "special", id: "tone", special: "toneToggle", showState: true },
        { kind: "special", id: "acc", special: "account" },
      ] },
    ],
    footer: [{ kind: "special", id: "build", special: "build" }],
  });
  const vars = { user: { nickname: "Alice" }, session: { room: "brno" }, room: { peers: 3 } };

  it("draws the trigger, the panel, HTML with live values, separators, sections and rows", () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={onOpen} onAction={onAction} config={custom()} vars={vars} buildLabel="b1"
      nodeVisible={(node) => node.module !== "ai"} states={{ tone: "dark", signedIn: true, username: "quick-fox-ab12" }} />);
    const trigger = screen.getByTestId("btn-menu-speeddial");
    expect(trigger.textContent).toBe("Menu Alice");
    expect(["#ff0000", "rgb(255, 0, 0)"]).toContain(trigger.style.color);
    expect(trigger.className).toContain("mb-hover-bg");
    expect(trigger.querySelector("svg")!.getAttribute("class")).toContain("lucide-rocket");
    fireEvent.click(trigger);
    const menu = screen.getByTestId("speeddial-menu");
    expect(menu.style.width).toBe(`${Math.min(400, window.innerWidth - 32)}px`);
    expect(menu.querySelector("header")!.textContent).toBe("Hi ALICE");
    expect(screen.queryByTestId("speeddial-close")).toBeNull();
    // HTML block: values filled in, markup kept, no raw template left.
    const html = menu.querySelector(".menu-html")!;
    expect(html.querySelector("p.x")!.textContent).toContain("Room brno · 3");
    // Separator with its own look.
    const sep = menu.querySelector(".menu-sep--dashed") as HTMLElement;
    expect(sep.style.borderTopStyle).toBe("dashed");
    expect(sep.style.borderTopWidth).toBe("2px");
    // Hidden nodes, rules and sections left empty are not drawn.
    expect(screen.queryByTestId("speeddial-btn-hidden")).toBeNull();
    expect(screen.queryByTestId("speeddial-btn-rule")).toBeNull();
    expect(menu.textContent).not.toContain("Nothing shown");
    expect(menu.textContent).toContain("Main");
    expect(screen.getByTestId("speeddial-btn-a").textContent).toContain("3"); // badge
    const b = screen.getByTestId("speeddial-btn-b");
    expect(b.style.fontWeight).toBe("700");
    expect(b.className).toContain("mb-hover-color");
    // Specials in a row: the tone switch shows its state, the account its username.
    expect(screen.getByTestId("speeddial-tone").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("speeddial-acc").textContent).toContain("quick-fox-ab12");
    expect(screen.getByTestId("menu-build").textContent).toBe("b1");
    // Actions: a URL goes to onAction, a panel to onOpen, HTML data-action too.
    fireEvent.click(screen.getByTestId("speeddial-btn-a"));
    expect(onAction).toHaveBeenCalledWith({ type: "url", href: "https://example.org", newTab: true });
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    fireEvent.click(screen.getByText("go"));
    expect(onOpen).toHaveBeenCalledWith("settings");
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    fireEvent.click(screen.getByText("de"));
    expect(onAction).toHaveBeenCalledWith({ type: "fn", fn: "setLang", param: "de" });
  });

  it("the toolbar draws the same items, the HTML inline, a divider for a separator", () => {
    const onAction = vi.fn();
    render(<MainMenu mode="icons-text" lang={LANG} onOpen={vi.fn()} onAction={onAction} config={custom()} vars={vars} nodeVisible={(node) => node.module !== "ai"} />);
    const nav = screen.getByTestId("main-nav");
    expect(screen.getByTestId("btn-b").getAttribute("aria-label")).toBe("Settings");
    expect(screen.queryByTestId("btn-hidden")).toBeNull();
    expect(screen.queryByTestId("btn-rule")).toBeNull();
    expect(nav.querySelector(".menu-html--inline")!.textContent).toContain("Room brno");
    fireEvent.click(screen.getByTestId("btn-a"));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: "url" }));
  });

  it("never lets an HTML block run script or reach javascript: URLs", () => {
    const config = sanitizeMenuConfig({ ...DEFAULT_MENU_CONFIG, items: [
      { kind: "html", id: "evil", html: "<img src=x onerror=\"alert(1)\"><a href=\"javascript:alert(1)\">x</a><script>alert(1)</script><b onclick=\"alert(1)\">b</b>" },
    ] });
    render(<MainMenu mode="speeddial" lang={LANG} onOpen={vi.fn()} config={config} />);
    fireEvent.click(screen.getByTestId("btn-menu-speeddial"));
    const html = screen.getByTestId("speeddial-menu").querySelector(".menu-html")!;
    expect(html.querySelector("script")).toBeNull();
    expect(html.innerHTML).not.toMatch(/onerror|onclick|javascript:/i);
  });
});
