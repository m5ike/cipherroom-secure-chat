// The start screen (6.7): what the chat window shows while there is no
// message — "Čistá ephemeral místnost" and Connect — as its own layout of the
// Layout builder ("start", client/src/lib/layouts/start.ts), drawn by
// components/StartScreen.tsx: the same texts and button as before, its actions
// reaching the handlers App.tsx gives it, every situation of the builder's
// preview drawn without an error, named and labelled — and listed by the
// builder. (That it draws the very DOM of before: layout-snapshots, "empty
// chat window".)

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StartScreen, type StartScreenProps } from "../client/src/components/StartScreen";
import { LayoutProvider } from "../client/src/components/LayoutProvider";
import { setLayoutPreviewMode } from "../client/src/components/LayoutView";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS, LAYOUT_GROUP, LAYOUT_IDS, LAYOUT_LABELS } from "../client/src/lib/layouts";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { sanitizeLayout } from "../client/src/lib/layout-config";
import { walkTree, type LNode } from "../client/src/lib/layout-tree";
import { checkDom, checkTree } from "../client/src/lib/layout-a11y";
import { startProps } from "../client/src/layout-samples";
import { t, type Lang } from "../client/src/lib/i18n";
import { layoutCatalog } from "../server/layout-catalog";

afterEach(() => { cleanup(); document.body.innerHTML = ""; setLayoutPreviewMode(null); });

const LANGS: Lang[] = ["cs", "en", "de"];

function props(over: Partial<StartScreenProps> = {}): StartScreenProps {
  return {
    ...startProps("start", "cs"),
    onOpenRoom: vi.fn(),
    onConnectProfile: vi.fn(),
    onSignIn: vi.fn(),
    ...over,
  };
}

function nodes(tree: LNode): LNode[] {
  const out: LNode[] = [];
  walkTree(tree, (n) => { out.push(n); });
  return out;
}

describe("the start screen's layout", () => {
  it("is a layout of the app's main screen, with a contract and situations to preview", () => {
    expect(LAYOUT_IDS).toContain("start");
    expect(LAYOUT_GROUP.start).toBe("app");
    expect(LAYOUT_LABELS.start).toMatch(/Start screen/);
    const c = LAYOUT_CONTRACTS.start;
    expect(c.vars.map((v) => v.path)).toEqual(expect.arrayContaining(["$title", "$body", "$status", "$connected", "$room", "$signedIn", "$username", "$serverMode", "$profiles"]));
    // 6.13: and the language picker ($lang, $langs, setLang).
    expect(c.vars.map((v) => v.path)).toEqual(expect.arrayContaining(["$lang", "$langs"]));
    expect(c.actions.map((a) => a.name)).toEqual(["openRoom", "connectProfile", "signIn", "setLang"]);
    expect(PREVIEW_VARIANTS.start.map((v) => v.id)).toEqual(["start", "connected", "signedin"]);
  });

  it("is drawn by the chat window in its start part, only while there is no message", () => {
    const chat = nodes(DEFAULT_LAYOUTS.chat);
    const part = chat.find((n) => n.el === "slot" && n.slot === "start");
    expect(part?.if).toBe("$empty");
    expect(LAYOUT_CONTRACTS.chat.slots.map((s) => s.name)).toContain("start");
    // The card itself is no longer the chat window's.
    expect(chat.some((n) => n.attrs?.["data-testid"] === "button-open-join")).toBe(false);
  });

  it("is what the chat window showed before: the lock, the title, the text and Connect (6.13: + the language)", () => {
    const all = nodes(DEFAULT_LAYOUTS.start);
    expect(all.filter((n) => n.el === "icon").map((n) => n.props?.icon)).toEqual(["lock", "radio", "languages"]);
    const picker = all.find((n) => n.el === "select")!;
    expect(picker.attrs).toMatchObject({ "data-testid": "start-language" });
    expect(picker.on).toEqual({ change: { action: "setLang" } });
    expect(all.find((n) => n.el === "heading")).toMatchObject({ tag: "h3", text: "{$title}" });
    expect(all.find((n) => n.el === "paragraph")).toMatchObject({ text: "{$body}" });
    const connect = all.find((n) => n.el === "button")!;
    expect(connect.attrs).toMatchObject({ type: "button", "data-testid": "button-open-join" });
    expect(connect.on).toEqual({ click: { action: "openRoom" } });
    expect(all.some((n) => n.el === "text" && n.text === "{_'join.connect'}")).toBe(true);
  });
});

describe("StartScreen", () => {
  for (const lang of LANGS) {
    it(`draws the title, the text and Connect (${lang})`, () => {
      render(<StartScreen {...props(startProps("start", lang))} />);
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(t(lang, "chat.empty.title"));
      expect(screen.getByText(t(lang, "chat.empty.body"))).toBeTruthy();
      const connect = screen.getByRole("button");
      expect(connect.textContent).toBe(t(lang, "join.connect"));
      expect(connect.getAttribute("data-testid")).toBe("button-open-join");
    });
  }

  it("is “Čistá ephemeral místnost” with Připojit in Czech", () => {
    render(<StartScreen {...props()} />);
    expect(screen.getByRole("heading", { name: "Čistá ephemeral místnost" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Připojit" })).toBeTruthy();
  });

  it("draws the operator's texts (Texts & behaviour) it is given", () => {
    render(<StartScreen {...props({ title: "Vítejte v M5cet", body: "Připojte se do místnosti." })} />);
    expect(screen.getByRole("heading").textContent).toBe("Vítejte v M5cet");
    expect(screen.getByText("Připojte se do místnosti.")).toBeTruthy();
  });

  it("Connect opens the Room window (and nothing else)", () => {
    const p = props();
    render(<StartScreen {...p} />);
    fireEvent.click(screen.getByTestId("button-open-join"));
    expect(p.onOpenRoom).toHaveBeenCalledTimes(1);
    expect(p.onConnectProfile).not.toHaveBeenCalled();
    expect(p.onSignIn).not.toHaveBeenCalled();
  });

  it("an operator's start screen reaches the rest: its values, a saved connection, signing in", () => {
    const tree: LNode = {
      id: "root", el: "panel", tag: "div", children: [
        { id: "state", el: "paragraph", tag: "p", attrs: { "data-testid": "state" }, text: "{$status}{if $connected} · {$room}{/if}{if $serverMode} · server{/if}{if $signedIn} · {$username}{/if}" },
        { id: "cx", el: "button", tag: "button", each: "$profiles", as: "p", key: "$p.id", attrs: { type: "button", "data-testid": "cx" }, text: "{$p.label}", on: { click: { action: "connectProfile", arg: "$p.id" } } },
        { id: "in", el: "button", tag: "button", if: "!$signedIn", attrs: { type: "button", "data-testid": "sign-in" }, text: "{_'acc.signIn'}", on: { click: { action: "signIn" } } },
      ],
    };
    const config = sanitizeLayout({ layouts: { start: { tree, rev: "x" } } });
    const draw = (p: StartScreenProps) => render(<LayoutProvider config={config} ctx={{}}><StartScreen {...p} /></LayoutProvider>);

    const signedIn = props(startProps("signedin", "en"));
    signedIn.onConnectProfile = vi.fn();
    draw(signedIn);
    expect(screen.getByTestId("state").textContent).toBe("idle · server · bystry-sokol-7k3q");
    expect(screen.getAllByTestId("cx").map((b) => b.textContent)).toEqual(["Tým Brno", "Rodina", "Provoz"]);
    fireEvent.click(screen.getAllByTestId("cx")[1]);
    expect(signedIn.onConnectProfile).toHaveBeenCalledWith("c-family");
    expect(screen.queryByTestId("sign-in")).toBeNull();
    cleanup();

    const connected = props({ ...startProps("connected", "en"), onSignIn: vi.fn() });
    draw(connected);
    expect(screen.getByTestId("state").textContent).toBe("joined · tym-brno");
    expect(screen.queryAllByTestId("cx")).toEqual([]);
    fireEvent.click(screen.getByTestId("sign-in"));
    expect(connected.onSignIn).toHaveBeenCalledTimes(1);
  });

  it("an operator's variant for a group is what that group gets", () => {
    const tree: LNode = { id: "root", el: "heading", tag: "h2", text: "Guests: {$title}" };
    const config = sanitizeLayout({ variants: { start: [{ id: "guests", label: "Guests", groups: ["guest"], tree }] } });
    render(<LayoutProvider config={config} ctx={{ groups: ["guest"] }}><StartScreen {...props()} /></LayoutProvider>);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Guests: Čistá ephemeral místnost");
    cleanup();
    render(<LayoutProvider config={config} ctx={{ groups: ["user"] }}><StartScreen {...props()} /></LayoutProvider>);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Čistá ephemeral místnost");
  });
});

describe("the start screen in the Layout builder", () => {
  it("finds nothing to fix in its design", () => {
    expect(checkTree(DEFAULT_LAYOUTS.start).filter((i) => i.severity !== "info")).toEqual([]);
  });

  for (const { id: variant } of PREVIEW_VARIANTS.start) {
    it(`${variant}: draws without an error, named and labelled, in every language`, () => {
      const own = new Set(nodes(DEFAULT_LAYOUTS.start).map((n) => n.id));
      for (const lang of LANGS) {
        const errors: string[] = [];
        setLayoutPreviewMode({ onError: (id, message) => errors.push(`${id}: ${message}`) });
        render(<StartScreen {...startProps(variant, lang)} />);
        expect(errors, `${variant} ${lang}`).toEqual([]);
        expect(document.body.querySelector("[data-lb-id=start-connect]"), `${variant} ${lang}: drawn`).not.toBeNull();
        const drawn = checkDom(document.body).filter((i) => own.has(i.id) && i.rule !== "contrast");
        expect(drawn.map((i) => `${i.id}: ${i.rule} ${i.message}`), `${variant} ${lang}`).toEqual([]);
        cleanup();
        document.body.innerHTML = "";
      }
    });
  }

  it("is listed in the App section with its contract, default tree and situations", () => {
    const catalog = layoutCatalog();
    const entry = catalog.layouts.find((l) => l.id === "start");
    expect(entry).toMatchObject({ section: "app", label: LAYOUT_LABELS.start, contract: LAYOUT_CONTRACTS.start, rev: DEFAULT_LAYOUT_REVS.start });
    expect(entry?.tree).toEqual(DEFAULT_LAYOUTS.start);
    expect(catalog.sections.map((s) => s.id)).toContain("app");
    expect(catalog.variants.start).toEqual(PREVIEW_VARIANTS.start);
  });
});
