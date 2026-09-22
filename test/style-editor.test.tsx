// Edit Mode runtime in a DOM: persistence + the injected stylesheet, class
// patches (incl. removing a class the selector itself names — must not loop),
// the element picker (Ctrl + right button, long press, tap-to-pick), rule
// lookup and selector generation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyClassPatches, applyUserStyles, classRules, createPicker, matchedRules, selectorOptions, setPreviewOverrides,
  styleStore, stylesheetClasses, uniqueSelector,
} from "../client/src/lib/style-editor";
import { patchClass, upsertRule, STORAGE_KEY, EMPTY_OVERRIDES } from "../client/src/lib/style-overrides";

const userSheet = () => document.getElementById("m5-user-styles")?.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  styleStore._reset();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});
afterEach(() => {
  setPreviewOverrides(null);
  vi.useRealTimers();
});

describe("store + stylesheet", () => {
  it("commits to localStorage, injects the sheet last in <head>, undoes", () => {
    const o = upsertRule({ ...EMPTY_OVERRIDES, rules: [], classes: [] }, { selector: ".x", state: ":hover", scope: "all", declarations: "color: red", important: false, enabled: true });
    expect(styleStore.commit(o)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).rules[0].selector).toBe(".x");
    expect(userSheet()).toContain(".x:hover {\n  color: red;\n}");
    const late = document.createElement("style");
    document.head.appendChild(late);
    applyUserStyles();
    expect(document.head.lastElementChild?.id).toBe("m5-user-styles");
    expect(styleStore.undo()).toBe(true);
    expect(userSheet()).not.toContain(".x:hover");
  });

  it("a preview replaces the saved layer until cleared", () => {
    styleStore.commit(upsertRule(styleStore.get(), { selector: ".x", state: "", scope: "all", declarations: "color: red", important: false, enabled: true }));
    setPreviewOverrides(upsertRule(styleStore.get(), { selector: ".x", state: "", scope: "all", declarations: "color: blue", important: false, enabled: true }));
    expect(userSheet()).toContain("color: blue");
    expect(userSheet()).not.toContain("color: red");
    setPreviewOverrides(null);
    expect(userSheet()).toContain("color: red");
  });

  it("loads what an earlier session saved", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rules: [{ selector: ".saved", declarations: "margin: 0" }], classes: [] }));
    styleStore._reset();
    applyUserStyles();
    expect(userSheet()).toContain(".saved {");
  });
});

describe("class patches", () => {
  it("adds / removes classes, reverts when the patch goes away, keeps native classes", () => {
    document.body.innerHTML = `<div class="card native"></div><div class="card"></div>`;
    let o = patchClass(styleStore.get(), ".card", "hot", "add");
    o = patchClass(o, ".card", "native", "remove");
    styleStore.commit(o);
    const [a, b] = Array.from(document.querySelectorAll("div"));
    expect(a.className).toBe("card hot");
    expect(b.className).toBe("card hot");
    styleStore.commit({ ...o, classes: [] });
    expect(a.className).toBe("card native");
    expect(b.className).toBe("card");
  });

  it("removing the very class the selector names is stable (no remove/re-add loop)", () => {
    document.body.innerHTML = `<p class="note big"></p>`;
    styleStore.commit(patchClass(styleStore.get(), ".note", "note", "remove"));
    const p = document.querySelector("p")!;
    expect(p.className).toBe("big");
    applyClassPatches();
    applyClassPatches();
    expect(p.className).toBe("big");
    styleStore.commit({ ...styleStore.get(), classes: [] });
    expect(p.className).toBe("big note");
  });

  it("never touches the editor's own nodes", () => {
    document.body.innerHTML = `<div data-m5-editor><span class="card"></span></div>`;
    styleStore.commit(patchClass(styleStore.get(), ".card", "hot", "add"));
    expect(document.querySelector("span")!.className).toBe("card");
  });
});

describe("picker", () => {
  it("Ctrl + right button picks (and blocks the native menu); plain right click does not", () => {
    document.body.innerHTML = `<button id="b"><svg><path id="p"/></svg></button><div data-m5-editor><i id="ed"></i></div>`;
    const onPick = vi.fn();
    const picker = createPicker({ onPick });
    const plain = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.getElementById("b")!.dispatchEvent(plain);
    expect(onPick).not.toHaveBeenCalled();
    const ctrl = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ctrlKey: true });
    document.getElementById("p")!.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect((onPick.mock.calls[0][0] as Element).localName).toBe("svg"); // icon parts resolve to <svg>
    document.getElementById("ed")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(onPick).toHaveBeenCalledTimes(1); // the inspector itself is never picked
    picker.destroy();
  });

  it("a long touch press picks and swallows the click that follows", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<button id="b">x</button>`;
    const btn = document.getElementById("b")!;
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    const onPick = vi.fn();
    const picker = createPicker({ onPick });
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7, clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(600);
    expect(onPick).toHaveBeenCalledWith(btn);
    btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 7 }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1); // only the one click was eaten
    picker.destroy();
  });

  it("moving the finger (scrolling) cancels the long press; a short tap does nothing", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="d"></div>`;
    const d = document.getElementById("d")!;
    const onPick = vi.fn();
    const picker = createPicker({ onPick });
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "touch", pointerId: 1, clientX: 10, clientY: 60 }));
    vi.advanceTimersByTime(800);
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 2, clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(150);
    d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 2 }));
    vi.advanceTimersByTime(800);
    expect(onPick).not.toHaveBeenCalled();
    picker.destroy();
  });

  it("tap-to-pick picks the next click instead of performing it", () => {
    document.body.innerHTML = `<a id="a" href="#x">x</a>`;
    const a = document.getElementById("a")!;
    const onPick = vi.fn();
    const picker = createPicker({ onPick });
    picker.armTapPick(true);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith(a);
    expect(picker.isArmed()).toBe(false);
    picker.destroy();
  });
});

describe("selectors + rule lookup", () => {
  it("uniqueSelector matches exactly one element; options offer classes and tag", () => {
    document.body.innerHTML = `
      <main data-testid="list"><article class="msg-bubble msg-bubble--mine px-3"><p class="msg-bubble__text">a</p></article>
      <article class="msg-bubble msg-bubble--mine px-3"><p class="msg-bubble__text">b</p></article></main>`;
    const second = document.querySelectorAll("p")[1];
    const sel = uniqueSelector(second);
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    expect(document.querySelector(sel)).toBe(second);
    const opts = selectorOptions(second).map((o) => o.selector);
    expect(opts[0]).toBe(sel);
    expect(opts).toContain(".msg-bubble__text");
    expect(opts).toContain("p");
    // A bare tag is never accepted as "unique", even when it is unique right now.
    document.body.insertAdjacentHTML("beforeend", `<section data-testid="empty"><div><h3 class="text-lg">t</h3></div></section>`);
    const h3 = document.querySelector("h3")!;
    const h3Sel = uniqueSelector(h3);
    expect(h3Sel).not.toBe("h3");
    expect(h3Sel.startsWith('[data-testid="empty"]')).toBe(true);
    expect(document.querySelector(h3Sel)).toBe(h3);
    const bubble = document.querySelectorAll("article")[0];
    expect(selectorOptions(bubble).map((o) => o.selector)).not.toContain(".px-3"); // utilities are not offered as scopes
  });

  it("finds the stylesheet rules (incl. :hover variants) that style an element, and every class", () => {
    const style = document.createElement("style");
    style.textContent = `.btn { color: red; } .btn:hover { color: blue; } .other { margin: 0; } #x.btn { padding: 1px; }`;
    document.head.appendChild(style);
    document.body.innerHTML = `<button id="x" class="btn">x</button>`;
    const rules = matchedRules(document.getElementById("x")!);
    const sels = rules.map((r) => r.selector);
    expect(sels).toEqual(expect.arrayContaining([".btn", ".btn:hover", "#x.btn"]));
    expect(sels).not.toContain(".other");
    expect(sels[0]).toBe("#x.btn"); // most specific first
    expect(rules.find((r) => r.selector === ".btn:hover")?.state).toBe(":hover");
    expect(stylesheetClasses()).toEqual(expect.arrayContaining(["btn", "other"]));
    expect(classRules("btn").map((r) => r.selector)).toEqual([".btn", ".btn:hover"]);
  });
});
