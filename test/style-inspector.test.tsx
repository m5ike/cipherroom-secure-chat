// The Edit Mode inspector end to end in a DOM: it mounts in its own Shadow
// DOM, picks an element with Ctrl + right button, edits declarations with a
// live preview, saves to permanent storage, edits a :hover state and a class
// patch, and the End button leaves Edit Mode.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { StyleInspector } from "../client/src/components/StyleInspector";
import { styleStore } from "../client/src/lib/style-editor";
import { STORAGE_KEY } from "../client/src/lib/style-overrides";

const shadow = () => document.getElementById("m5-inspector-host")?.shadowRoot ?? null;
const $ = (sel: string) => shadow()!.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => Array.from(shadow()!.querySelectorAll(sel)) as HTMLElement[];
const userSheet = () => document.getElementById("m5-user-styles")?.textContent ?? "";

function pick(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ctrlKey: true })); });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  styleStore._reset();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function mount(onExit = vi.fn()) {
  const app = document.createElement("div");
  app.innerHTML = `<button class="composer-send primary" data-testid="button-send">Send</button><p class="hint">x</p>`;
  document.body.appendChild(app);
  const r = render(<StyleInspector active lang="en" onExit={onExit} allowGoogleFonts={false} />);
  return { ...r, send: app.querySelector("button")!, onExit };
}

describe("StyleInspector", () => {
  it("mounts in an isolated Shadow DOM and starts with pick instructions", () => {
    mount();
    const host = document.getElementById("m5-inspector-host")!;
    expect(host.hasAttribute("data-m5-editor")).toBe(true);
    expect(shadow()!.querySelector("style")).not.toBeNull(); // (CSS text itself is not processed under vitest)
    expect($('[data-testid="inspector"]')!.textContent).toContain("Pick the element you want to restyle");
    expect(document.documentElement.classList.contains("m5-edit-mode")).toBe(true);
  });

  it("picks, edits with live preview, saves permanently", () => {
    const { send } = mount();
    pick(send);
    expect($(".ins-chip")!.textContent).toBe("button.composer-send.primary");
    const selector = ($('[data-testid="ins-selector"]') as HTMLInputElement).value;
    expect(selector).toBe('[data-testid="button-send"]');

    fireEvent.click($('[data-testid="ins-add-prop"]')!);
    const rows = $$('[data-testid="ins-decl"]');
    const [prop, value] = Array.from(rows[rows.length - 1].querySelectorAll("input:not([type=checkbox])")) as HTMLInputElement[];
    fireEvent.change(prop, { target: { value: "background-color" } });
    fireEvent.change(value, { target: { value: "rebeccapurple" } });

    // Live preview before saving; nothing persisted yet.
    expect(userSheet()).toContain('[data-testid="button-send"] {\n  background-color: rebeccapurple !important;');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect($(".ins-status")!.textContent).toMatch(/Unsaved/);

    fireEvent.click($('[data-testid="ins-save"]')!);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.rules[0]).toMatchObject({ selector: '[data-testid="button-send"]', state: "", important: true });
    expect(saved.rules[0].declarations).toBe("background-color: rebeccapurple;");
    expect($(".ins-status")!.textContent).toMatch(/Saved/);
  });

  it("edits the :hover state separately and discards unsaved changes", () => {
    const { send } = mount();
    pick(send);
    fireEvent.click($('[data-testid="ins-state-:hover"]')!);
    fireEvent.click($('[data-testid="ins-raw-toggle"]')!);
    fireEvent.change($('[data-testid="ins-raw"]')!, { target: { value: "color: gold;\n/* opacity: .5; */" } });
    expect(userSheet()).toContain('[data-testid="button-send"]:hover {\n  color: gold !important;');
    expect(userSheet()).not.toContain("opacity");
    fireEvent.click($('[data-testid="ins-discard"]')!);
    expect(userSheet()).not.toContain(":hover");
  });

  it("class tab: removing a class previews and saves as a class patch", () => {
    const { send } = mount();
    pick(send);
    fireEvent.click($('[data-testid="ins-tab-classes"]')!);
    const chips = $('[data-testid="ins-class-chips"]')!;
    const primary = Array.from(chips.querySelectorAll(".ins-cls")).find((c) => c.textContent?.includes(".primary"))!;
    fireEvent.click(primary.querySelector(".ins-cls__x")!);
    expect(send.classList.contains("primary")).toBe(false);
    fireEvent.click($('[data-testid="ins-save"]')!);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).classes[0]).toMatchObject({ remove: ["primary"] });
  });

  it("End editing leaves Edit Mode and removes the inspector", () => {
    const onExit = vi.fn();
    const { rerender } = mount(onExit);
    fireEvent.click($('[data-testid="ins-exit"]')!);
    expect(onExit).toHaveBeenCalled();
    rerender(<StyleInspector active={false} lang="en" onExit={onExit} allowGoogleFonts={false} />);
    expect(document.getElementById("m5-inspector-host")).toBeNull();
    expect(document.documentElement.classList.contains("m5-edit-mode")).toBe(false);
  });
});
