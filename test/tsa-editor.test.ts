// The TSA editor (admin-ui/public/tsa-editor.js, 6.9) on a stand-in for
// console.js: it opens over the console with the palette the API answers
// (the real catalog.ts) and a TSA, adds and wires tools under the contract's
// port rules (types.ts), edits parameters with `when`, serializes exactly the
// contract's graph, undoes, shows /validate's problems, guards unsaved work
// and drives the simulator with SimTurns.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TSA_CATALOG, TSA_GROUPS } from "../server/telephony/tsa/catalog";
import { TSA_LIMITS, NODE_ID, type TsaProblem } from "../server/telephony/tsa/types";
import type { SimTurn } from "../server/telephony/control/api-contract";

type Call = { path: string; method: string; body?: any };
let calls: Call[] = [];
let tsa: any;
let problems: (graph: any) => TsaProblem[] = () => [];
let turns: SimTurn[] = [];
const toast = vi.fn();
const PUB = join(__dirname, "..", "admin-ui", "public");

const baseTsa = () => ({
  id: "main-ivr", name: "Main IVR", description: "The front door", version: 1, createdAt: 1, updatedAt: 1000, updatedBy: "admin", tags: ["ivr"], published: null,
  graph: {
    nodes: [
      { id: "start", type: "start", x: 0, y: 0, params: { answer: true, language: "cs-CZ", maxMinutes: 60 } },
      { id: "ask", type: "read_dtmf", x: 0, y: 300, params: { maxDigits: 4, finishOnKey: "#", timeout: 5, prompt: "", retries: 0 } },
      { id: "bye", type: "hangup", x: 0, y: 640, params: { as: "hangup" } },
    ],
    edges: [{ id: "e1", from: { node: "start", port: "next" }, to: { node: "ask", port: "in" }, kind: "flow" }],
  },
});

function h(tag: string, attrs: Record<string, any> = {}, ...children: any[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(path: string, opts: { method?: string; body?: any } = {}) {
  const method = opts.method ?? "GET";
  calls.push({ path, method, body: opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body)) });
  if (path === "/admin/telephony/tsa/catalog") return { ok: true, tools: structuredClone(TSA_CATALOG), groups: TSA_GROUPS, limits: TSA_LIMITS };
  if (path === "/admin/telephony/tsa/main-ivr" && method === "GET") return { ok: true, tsa: structuredClone(tsa) };
  if (path === "/admin/telephony/tsa/main-ivr" && method === "PUT") { tsa = { ...tsa, ...opts.body, updatedAt: 2000 }; return { ok: true, tsa: structuredClone(tsa), problems: [] }; }
  if (path === "/admin/telephony/tsa/main-ivr/validate") return { ok: true, problems: problems(opts.body.graph) };
  if (path === "/admin/telephony/tsa/main-ivr/publish") { const v = tsa.version + 1; tsa = { ...tsa, version: v, published: { version: v, graph: tsa.graph, at: 3000, by: "admin" } }; return { ok: true, tsa: structuredClone(tsa) }; }
  if (path === "/admin/telephony/sim" && method === "POST") return { ok: true, session: "sim1", turn: turns.shift() };
  if (path === "/admin/telephony/sim/sim1/event") return turns.shift();
  if (path === "/admin/telephony/sim/sim1") return { ok: true, session: { id: "sim1", trace: [{ at: 1, node: "start", type: "start", port: "next" }, { at: 2, node: "ask", type: "read_dtmf" }] } };
  if (path === "/admin/ai") return { ok: true, defaults: { voice: "nova" }, providers: [{ id: "openai", label: "OpenAI", models: [{ id: "tts-1", kind: "tts", voices: ["alloy", "nova"] }] }] };
  if (path === "/admin/telephony/sip/trunks") return { ok: true, trunks: [{ id: "prague1", label: "Prague", host: "sip.example.com", port: 5060 }] };
  if (path === "/admin/functions") return { ok: true, models: [{ id: "crm", name: "CRM lookup", enabled: true }] };
  if (path === "/admin/telephony/tsa") return { ok: true, tsa: [{ id: "main-ivr", name: "Main IVR" }, { id: "after-hours", name: "After hours" }] };
  throw new Error(`unexpected ${method} ${path}`);
}

const E = () => (window as any).M5TsaEditor;
const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const nodeEl = (id: string) => $(`.tsa-node[data-id="${id}"]`);
const portOf = (id: string, port: string) => [...nodeEl(id).querySelectorAll(".tsa-port")].find((p) => (p as HTMLElement).dataset.port === port) as HTMLElement;
const stage = () => $('[data-testid="tsa-stage"]');
const key = (k: string, extra: KeyboardEventInit = {}, target: Element = stage()) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
const ptr = (target: EventTarget, type: string, x = 0, y = 0, extra: PointerEventInit = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra }));
/** A click on a port (down and up without moving): picks it, or wires it to the picked one. */
const clickPort = (id: string, port: string) => { ptr(portOf(id, port).querySelector(".tsa-port__dot")!, "pointerdown", 5, 5); ptr(window, "pointerup", 5, 5); };
const change = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string, type = "input") => { el.value = value; el.dispatchEvent(new Event(type, { bubbles: true })); };
const graph = () => E().current().graph();
const cam = () => { const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(($(".tsa-world") as HTMLElement).style.transform)!; return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }; };

let closed: any[] = [];

beforeAll(() => {
  document.body.append(h("div", { class: "toasts", id: "toasts" }));
  (window as any).M5Console = {
    h, api, toast, can: () => true, applyRoleGates: () => undefined,
    clear: (el: Element) => { while (el.firstChild) el.firstChild.remove(); return el; },
    icon: () => document.createElement("span"),
  };
  new Function(readFileSync(join(PUB, "tsa-editor-icons.js"), "utf8"))();
  new Function(readFileSync(join(PUB, "tsa-editor.js"), "utf8"))();
  E().config.validateDelay = 0;
  E().config.autosaveDelay = 0;
});

beforeEach(async () => {
  calls = [];
  tsa = baseTsa();
  problems = () => [];
  turns = [];
  closed = [];
  toast.mockClear();
  localStorage.clear();
  await E().open("main-ivr", { onClose: (r: any) => closed.push(r) });
  await settle();
});

afterEach(async () => { await E().close(true); });

describe("opening", () => {
  it("draws the palette from the API and the TSA's graph", () => {
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining(["GET /admin/telephony/tsa/catalog", "GET /admin/telephony/tsa/main-ivr", "POST /admin/telephony/tsa/main-ivr/validate"]));
    expect($('[data-testid="tsa-editor"]')).toBeTruthy();
    expect($$(".tsa-pal__item").length).toBe(TSA_CATALOG.length);
    expect($$(".tsa-pal__group").length).toBe(TSA_GROUPS.length);
    expect($$(".tsa-node").map((n) => n.dataset.id)).toEqual(["start", "ask", "bye"]);
    expect(nodeEl("start").classList.contains("tsa-shape--pill")).toBe(true);
    expect(nodeEl("bye").classList.contains("tsa-shape--pill")).toBe(true);
    expect(($('[data-testid="tsa-name"]') as HTMLInputElement).value).toBe("Main IVR");
    expect($('path.tsa-wire--flow[data-edge="e1"]')).toBeTruthy();
    expect($('[data-testid="tsa-dirty"]').textContent).toContain("Draft saved");
    expect(document.documentElement.classList.contains("tsa-open")).toBe(true);
  });

  it("searches the palette and shows a tool's help", () => {
    change($('[data-testid="tsa-pal-search"]') as HTMLInputElement, "dtmf");
    const found = $$(".tsa-pal__item").map((i) => i.dataset.type);
    expect(found).toEqual(expect.arrayContaining(["read_dtmf", "send_dtmf"]));
    expect(found).not.toContain("tts");
    $('[data-testid="tsa-pal-read_dtmf"]').dispatchEvent(new Event("focus"));
    expect($(".tsa-pal__tip").textContent).toContain("termination key");
  });

  it("says why it cannot open", async () => {
    await E().close(true);
    await E().open("nope", { onClose: (r: any) => closed.push(r) });
    expect($(".tsa-fail").textContent).toContain("unexpected GET /admin/telephony/tsa/nope");
    ($(".tsa-fail button") as HTMLButtonElement).click();
    expect($('[data-testid="tsa-editor"]')).toBeNull();
    expect(closed.pop()).toMatchObject({ id: "nope", saved: false });
  });
});

describe("building", () => {
  it("adds a Condition — a long rectangle with IN1 … on the top edge and on_true / on_false at the bottom — and + / − change its inputs", async () => {
    key("Enter", {}, $('[data-testid="tsa-pal-condition"]'));
    const n = $('.tsa-node[data-type="condition"]');
    expect(n.classList.contains("tsa-shape--wide")).toBe(true);
    const ports = (el: Element, kind: string) => [...el.querySelectorAll(`.tsa-port--${kind}`)].map((p) => (p as HTMLElement).dataset.port);
    expect(ports(n, "din")).toEqual(["IN1", "IN2"]);
    expect(ports(n, "fout")).toEqual(["on_true", "on_false"]);
    expect(ports(n, "fin")).toEqual(["in"]);
    // top edge / bottom edge
    for (const p of n.querySelectorAll(".tsa-port--din")) expect((p as HTMLElement).style.top).toBe("0px");
    for (const p of n.querySelectorAll(".tsa-port--fout")) expect((p as HTMLElement).style.top).toBe(n.style.height);
    expect(parseInt(n.style.width, 10)).toBeGreaterThan(parseInt(nodeEl("ask").style.width, 10));
    ($('.tsa-node[data-type="condition"] [data-act="in-plus"]') as HTMLButtonElement).click();
    expect(ports($('.tsa-node[data-type="condition"]'), "din")).toEqual(["IN1", "IN2", "IN3"]);
    ($('.tsa-node[data-type="condition"] [data-act="in-minus"]') as HTMLButtonElement).click();
    expect(ports($('.tsa-node[data-type="condition"]'), "din")).toEqual(["IN1", "IN2"]);
    ($('[data-testid="tsa-insp-in-plus"]') as HTMLButtonElement).click();
    expect(ports($('.tsa-node[data-type="condition"]'), "din")).toEqual(["IN1", "IN2", "IN3"]);
    expect($('[data-testid="tsa-insp-in-count"]').textContent).toBe("3");
    expect(graph().nodes.find((x: any) => x.type === "condition").inputs).toBe(3);
  });

  it("keeps inputs within the catalog's bounds and drops the wire of a removed input", () => {
    const ed = E().current();
    const c = ed.addNode("condition", 300, 300);
    ed.setInputs(c.id, 500);
    expect(graph().nodes.find((x: any) => x.id === c.id).inputs).toBe(100);
    ed.setInputs(c.id, 3);
    ed.connect({ node: "ask", port: "digits" }, { node: c.id, port: "IN3" });
    expect(graph().edges.some((e: any) => e.to.port === "IN3")).toBe(true);
    ed.setInputs(c.id, 2);
    expect(graph().edges.some((e: any) => e.to.port === "IN3")).toBe(false);
    ed.setInputs(c.id, -4);
    expect(graph().nodes.find((x: any) => x.id === c.id).inputs).toBe(0);
  });

  it("drags a tool from the palette onto the canvas", () => {
    const item = $('[data-testid="tsa-pal-tts"]');
    ptr(item, "pointerdown", 100, 100);
    ptr(window, "pointermove", 40, 40);
    ptr(window, "pointermove", 0, 0);
    expect($(".tsa-ghost")).toBeTruthy();
    ptr(window, "pointerup", 0, 0);
    expect($(".tsa-ghost")).toBeNull();
    expect(graph().nodes.map((x: any) => x.type)).toContain("tts");
  });

  it("wires a data output into IN1 and a flow output into “in” — port, then port", () => {
    const c = E().current().addNode("condition", 400, 300);
    clickPort("ask", "digits");
    expect(portOf("ask", "digits").classList.contains("is-origin")).toBe(true);
    expect(portOf(c.id, "IN1").classList.contains("is-target")).toBe(true);
    expect(portOf(c.id, "in").classList.contains("is-target")).toBe(false);
    clickPort(c.id, "IN1");
    clickPort("ask", "next");
    key("Enter", {}, portOf(c.id, "in"));
    const edges = graph().edges;
    expect(edges).toContainEqual({ id: "e2", from: { node: "ask", port: "digits" }, to: { node: c.id, port: "IN1" }, kind: "data" });
    expect(edges).toContainEqual({ id: "e3", from: { node: "ask", port: "next" }, to: { node: c.id, port: "in" }, kind: "flow" });
    expect($('path.tsa-wire--data[data-edge="e2"]')).toBeTruthy();
    expect($('path.tsa-wire--flow[data-edge="e3"]')).toBeTruthy();
    expect(portOf(c.id, "IN1").classList.contains("is-wired")).toBe(true);
  });

  it("wires by dragging from a port to a port (and a dropped wire on the canvas offers a tool)", () => {
    const c = E().current().addNode("condition", 400, 300);
    const g = graph().nodes.find((x: any) => x.id === c.id);
    const v = cam();
    const width = parseInt(nodeEl(c.id).style.width, 10);
    // IN1 sits at a third of the width on the top edge
    const tx = (g.x + Math.round(width / 3)) * v.z + v.x, ty = g.y * v.z + v.y;
    ptr(portOf("ask", "digits").querySelector(".tsa-port__dot")!, "pointerdown", 10, 10);
    ptr(window, "pointermove", 40, 40);
    expect(stage().classList.contains("is-wiring")).toBe(true);
    ptr(window, "pointermove", tx, ty);
    ptr(window, "pointerup", tx, ty);
    expect(graph().edges).toContainEqual(expect.objectContaining({ from: { node: "ask", port: "digits" }, to: { node: c.id, port: "IN1" }, kind: "data" }));
    // drop on empty canvas → the quick search, then Enter adds a tool wired to the port
    ptr(portOf("bye", "in").querySelector(".tsa-port__dot")!, "pointerdown", 10, 10);
    ptr(window, "pointermove", 3000, 3000);
    ptr(window, "pointerup", 0, 0);
    const q = $(".tsa-quick input") as HTMLInputElement;
    expect(q).toBeTruthy();
    change(q, "pause");
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const pause = graph().nodes.find((x: any) => x.type === "pause");
    expect(graph().edges).toContainEqual(expect.objectContaining({ from: { node: pause.id, port: "next" }, to: { node: "bye", port: "in" }, kind: "flow" }));
  });

  it("refuses what the contract forbids — and says why", () => {
    const ed = E().current();
    const c = ed.addNode("condition", 400, 300);
    const f = ed.addNode("formula", 800, 300);
    const before = graph().edges.length;
    const r1 = ed.connect({ node: "ask", port: "next" }, { node: c.id, port: "IN2" });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain("flow output");
    expect(ed.connect({ node: "ask", port: "digits" }, { node: "bye", port: "in" }).ok).toBe(false);
    expect(ed.connect({ node: "start", port: "next" }, { node: "ask", port: "next" }).reason).toContain("Two outputs");
    expect(ed.connect({ node: "ask", port: "in" }, { node: c.id, port: "IN1" }).reason).toContain("Two inputs");
    expect(ed.connect({ node: f.id, port: "value" }, { node: f.id, port: "IN1" }).reason).toContain("its own input");
    expect(ed.connect({ node: "start", port: "next" }, { node: "ask", port: "in" }).reason).toContain("already wired");
    // by clicks: a flow output picked, then a data input
    clickPort("ask", "next");
    expect(portOf(c.id, "IN2").classList.contains("is-target")).toBe(false);
    clickPort(c.id, "IN2");
    expect(graph().edges.length).toBe(before);
    expect($(".tsa-hint").textContent).toContain("flow output");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("flow output"), "err");
  });

  it("keeps one wire per flow output and per data input — a new one swaps the old; “in” takes many", () => {
    const ed = E().current();
    const c = ed.addNode("condition", 400, 300);
    const t = ed.addNode("text", 800, 0);
    ed.connect({ node: "start", port: "next" }, { node: "bye", port: "in" });
    expect(graph().edges.filter((e: any) => e.from.node === "start" && e.from.port === "next")).toEqual([expect.objectContaining({ to: { node: "bye", port: "in" } })]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Swapped"), undefined);
    ed.connect({ node: "ask", port: "digits" }, { node: c.id, port: "IN1" });
    ed.connect({ node: c.id, port: "IN1" }, { node: t.id, port: "text" });
    expect(graph().edges.filter((e: any) => e.to.node === c.id && e.to.port === "IN1")).toEqual([expect.objectContaining({ from: { node: t.id, port: "text" }, kind: "data" })]);
    ed.connect({ node: "ask", port: "next" }, { node: "bye", port: "in" });
    ed.connect({ node: "ask", port: "on_timeout" }, { node: "bye", port: "in" });
    expect(graph().edges.filter((e: any) => e.to.node === "bye" && e.to.port === "in").length).toBe(3);
    // a data output feeds many inputs
    ed.connect({ node: "ask", port: "digits" }, { node: c.id, port: "IN2" });
    ed.connect({ node: "ask", port: "digits" }, { node: t.id, port: "IN1" });
    expect(graph().edges.filter((e: any) => e.from.node === "ask" && e.from.port === "digits").length).toBe(2);
  });

  it("copies, pastes, duplicates and deletes by keyboard", () => {
    const ed = E().current();
    ed.select(["ask", "bye"]);
    ed.connect({ node: "ask", port: "next" }, { node: "bye", port: "in" });
    ed.select(["ask", "bye"]);
    key("c");
    key("v");
    const g = graph();
    expect(g.nodes.map((n: any) => n.id)).toEqual(["start", "ask", "bye", "read_dtmf_1", "hangup_1"]);
    expect(g.edges).toContainEqual(expect.objectContaining({ from: { node: "read_dtmf_1", port: "next" }, to: { node: "hangup_1", port: "in" } }));
    expect(ed.selection().nodes).toEqual(["read_dtmf_1", "hangup_1"]);
    key("Delete");
    expect(graph().nodes.length).toBe(3);
    ed.select("ask");
    key("d");
    expect(graph().nodes.find((n: any) => n.id === "read_dtmf_1")).toMatchObject({ x: 40, y: 340, params: tsa.graph.nodes[1].params });
    // Start pasted twice is refused (exactly one)
    ed.select("start");
    key("d");
    expect(graph().nodes.filter((n: any) => n.type === "start").length).toBe(1);
    key("ArrowRight", { shiftKey: false }, stage());
    ed.select("ask");
    key("ArrowRight");
    key("ArrowDown", { shiftKey: true });
    expect(graph().nodes.find((n: any) => n.id === "ask")).toMatchObject({ x: 10, y: 350 });
  });

  it("follows a Switch's rows with its case outputs", () => {
    const ed = E().current();
    const sw = ed.addNode("switch", 400, 300);
    expect([...nodeEl(sw.id).querySelectorAll(".tsa-port--fout")].map((p) => (p as HTMLElement).dataset.port)).toEqual(["case_1", "case_2", "case_3", "default"]);
    ed.connect({ node: sw.id, port: "case_2" }, { node: "bye", port: "in" });
    ed.select(sw.id);
    // remove the first row: the second becomes case_1, its wire with it
    const rows = $$('[data-testid="tsa-param-cases"] .tsa-list__row');
    (rows[0].querySelector('[aria-label="Remove 1"]') as HTMLButtonElement).click();
    expect(graph().nodes.find((n: any) => n.id === sw.id).params.cases).toEqual(["2", "3"]);
    expect(graph().edges).toContainEqual(expect.objectContaining({ from: { node: sw.id, port: "case_1" }, to: { node: "bye", port: "in" } }));
    // retyping a case keeps its wire, even while the row is momentarily empty
    const first = $$('[data-testid="tsa-param-cases"] input')[0] as HTMLInputElement;
    change(first, "");
    expect(graph().nodes.find((n: any) => n.id === sw.id).params.cases).toEqual(["2", "3"]);
    change(first, "5");
    expect(graph().nodes.find((n: any) => n.id === sw.id).params.cases).toEqual(["5", "3"]);
    expect(graph().edges).toContainEqual(expect.objectContaining({ from: { node: sw.id, port: "case_1" }, to: { node: "bye", port: "in" } }));
    $('[data-testid="tsa-param-cases-add"]').click();
    const inputs = $$('[data-testid="tsa-param-cases"] input') as HTMLInputElement[];
    change(inputs[2], "9");
    expect(graph().nodes.find((n: any) => n.id === sw.id).params.cases).toEqual(["5", "3", "9"]);
    expect([...nodeEl(sw.id).querySelectorAll(".tsa-port--fout")].map((p) => (p as HTMLElement).dataset.port)).toEqual(["case_1", "case_2", "case_3", "default"]);
  });
});

describe("the inspector", () => {
  it("edits parameters by kind, with `when` visibility and live feedback", async () => {
    const ed = E().current();
    const t = ed.addNode("tts", 400, 0);
    expect($('[data-param="pitch"]')).toBeNull();
    expect($('[data-param="voice"]')).toBeTruthy();
    change($('[data-testid="tsa-param-provider"]') as HTMLSelectElement, "ai", "change");
    expect($('[data-param="pitch"]')).toBeTruthy();
    await settle();
    expect([...$$("#tsaP_voice_list option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["nova", "alloy"]);
    const text = $('[data-testid="tsa-param-text"]') as HTMLTextAreaElement;
    change(text, "Your code is {IN1}.");
    expect(graph().nodes.find((n: any) => n.id === t.id).params.text).toBe("Your code is {IN1}.");
    change(text, "Your code is {IN5}.");
    expect($('[data-param="text"] .tsa-fb--warning').textContent).toContain("IN5 is not an input");
    const rate = $('[data-testid="tsa-param-rate"]') as HTMLInputElement;
    change(rate, "5");
    expect(rate.classList.contains("is-invalid")).toBe(true);
    expect(graph().nodes.find((n: any) => n.id === t.id).params.rate).toBe(1);
    change(rate, "1.5");
    expect(graph().nodes.find((n: any) => n.id === t.id).params.rate).toBe(1.5);
    const bool = $('[data-testid="tsa-param-bargeIn"]') as HTMLInputElement;
    bool.checked = false;
    bool.dispatchEvent(new Event("change", { bubbles: true }));
    expect(graph().nodes.find((n: any) => n.id === t.id).params.bargeIn).toBe(false);

    const p = ed.addNode("play", 800, 0);
    expect($('[data-param="url"]')).toBeTruthy();
    expect($('[data-param="file"]')).toBeNull();
    change($('[data-testid="tsa-param-source"]') as HTMLSelectElement, "file", "change");
    expect($('[data-param="url"]')).toBeNull();
    expect($('[data-param="file"]')).toBeTruthy();
    expect($('[data-param="seconds"]')).toBeNull();
    change($('[data-testid="tsa-param-source"]') as HTMLSelectElement, "stream", "change");
    expect($('[data-param="seconds"]')).toBeTruthy();
    expect(graph().nodes.find((n: any) => n.id === p.id).params.source).toBe("stream");
  });

  it("checks a formula as it is typed and inserts inputs", () => {
    const ed = E().current();
    const c = ed.addNode("condition", 400, 300);
    const f = $('[data-testid="tsa-param-formula"]') as HTMLInputElement;
    change(f, "(IN1 == 0 and IN2 > 2");
    expect($('[data-param="formula"] .tsa-fb--error').textContent).toContain("not closed");
    expect(f.classList.contains("is-invalid")).toBe(true);
    change(f, "IN1 = IN2");
    expect($('[data-param="formula"] .tsa-fb--warning').textContent).toContain("==");
    change(f, "IN3 == 1");
    expect($('[data-param="formula"] .tsa-fb--warning').textContent).toContain("IN3 is not an input");
    change(f, "");
    ([...$$('[data-param="formula"] .tsa-ref')].find((b) => b.textContent === "IN2") as HTMLButtonElement).click();
    expect(f.value).toBe("IN2");
    expect(graph().nodes.find((n: any) => n.id === c.id).params.formula).toBe("IN2");
  });

  it("shows the server's word on a parameter", async () => {
    problems = (g) => (g.nodes.some((n: any) => n.type === "condition") ? [{ level: "error", node: "condition_1", port: "formula", message: "Unknown name foo." }] : []);
    const ed = E().current();
    ed.addNode("condition", 400, 300);
    change($('[data-testid="tsa-param-formula"]') as HTMLInputElement, "foo == 1");
    await settle();
    expect($('[data-param="formula"]').textContent).toContain("Unknown name foo.");
  });

  it("picks a trunk, a model and a TSA from the existing endpoints", async () => {
    const ed = E().current();
    const d = ed.addNode("dial", 400, 0);
    change($('[data-testid="tsa-param-via"]') as HTMLSelectElement, "trunk", "change");
    await settle();
    const trunk = $('[data-testid="tsa-param-trunk"]') as HTMLSelectElement;
    expect([...trunk.options].map((o) => o.value)).toEqual(["", "prague1"]);
    change(trunk, "prague1", "change");
    expect(graph().nodes.find((n: any) => n.id === d.id).params.trunk).toBe("prague1");
    ed.addNode("function", 800, 0);
    await settle();
    expect([...($('[data-testid="tsa-param-model"]') as HTMLSelectElement).options].map((o) => o.textContent)).toContain("CRM lookup");
  });

  it("renames a node and its wires follow; label and note show on the canvas", () => {
    const ed = E().current();
    ed.select("ask");
    const id = $("#tsaNodeId") as HTMLInputElement;
    change(id, "menu", "change");
    expect(graph().edges[0]).toEqual({ id: "e1", from: { node: "start", port: "next" }, to: { node: "menu", port: "in" }, kind: "flow" });
    change(id, "Bad Id", "change");
    expect(nodeEl("menu")).toBeTruthy();
    change($('[data-testid="tsa-node-label"]') as HTMLInputElement, "Main menu");
    expect(nodeEl("menu").querySelector(".tsa-node__title")!.textContent).toBe("Main menu");
    change($("#tsaNodeNote") as HTMLTextAreaElement, "1 = sales, 2 = support");
    expect(graph().nodes.find((n: any) => n.id === "menu")).toMatchObject({ label: "Main menu", note: "1 = sales, 2 = support" });
  });
});

describe("the graph", () => {
  it("serializes exactly the contract's shape", async () => {
    const ed = E().current();
    const c = ed.addNode("condition", 100, 400);
    ed.addNode("read_dtmf", 100, 800);
    ed.connect({ node: "ask", port: "digits" }, { node: c.id, port: "IN1" });
    ed.connect({ node: "ask", port: "next" }, { node: c.id, port: "in" });
    const g = graph();
    expect(Object.keys(g)).toEqual(["nodes", "edges"]);
    expect(g.nodes.slice(0, 3)).toEqual(baseTsa().graph.nodes);
    expect(g.nodes[3]).toEqual({ id: "condition_1", type: "condition", x: 100, y: 400, inputs: 2, params: {} });
    expect(g.nodes[4]).toEqual({ id: "read_dtmf_1", type: "read_dtmf", x: 100, y: 800, params: { maxDigits: 1, finishOnKey: "#", timeout: 5, prompt: "", retries: 0 } });
    expect(g.edges).toEqual([
      { id: "e1", from: { node: "start", port: "next" }, to: { node: "ask", port: "in" }, kind: "flow" },
      { id: "e2", from: { node: "ask", port: "digits" }, to: { node: "condition_1", port: "IN1" }, kind: "data" },
      { id: "e3", from: { node: "ask", port: "next" }, to: { node: "condition_1", port: "in" }, kind: "flow" },
    ]);
    const allowed = ["id", "type", "x", "y", "w", "label", "note", "inputs", "params"];
    for (const n of g.nodes) { for (const k of Object.keys(n)) expect(allowed).toContain(k); expect(n.id).toMatch(NODE_ID); }
    // Save sends { name, description, graph, tags } — the same graph
    $('[data-testid="tsa-save"]').click();
    await settle();
    const put = calls.filter((x) => x.method === "PUT").pop()!;
    expect(Object.keys(put.body).sort()).toEqual(["description", "graph", "name", "tags"]);
    expect(put.body.graph).toEqual(g);
    expect(put.body).toMatchObject({ name: "Main IVR", description: "The front door", tags: ["ivr"] });
    expect($('[data-testid="tsa-dirty"]').textContent).toContain("Draft saved");
  });

  it("keeps a wide node's width (w) when resized", () => {
    const ed = E().current();
    const c = ed.addNode("condition", 0, 0);
    const handle = nodeEl(c.id).querySelector(".tsa-node__resize")!;
    ptr(handle, "pointerdown", 100, 100);
    ptr(window, "pointermove", 300, 100);
    ptr(window, "pointerup", 300, 100);
    const w = graph().nodes.find((n: any) => n.id === c.id).w;
    expect(w).toBeGreaterThan(380);
    expect(nodeEl(c.id).style.width).toBe(`${w}px`);
  });

  it("undoes and redoes — buttons and keys", () => {
    const ed = E().current();
    ed.addNode("pause", 0, 0);
    expect(graph().nodes.length).toBe(4);
    $('[data-testid="tsa-undo"]').click();
    expect(graph().nodes.length).toBe(3);
    $('[data-testid="tsa-redo"]').click();
    expect(graph().nodes.length).toBe(4);
    key("z", { ctrlKey: true });
    expect(graph().nodes.length).toBe(3);
    key("y", { metaKey: true });
    expect(graph().nodes.length).toBe(4);
    const c = ed.addNode("condition", 0, 400);
    ed.setInputs(c.id, 5);
    key("z", { ctrlKey: true });
    expect(graph().nodes.find((n: any) => n.id === c.id).inputs).toBe(2);
    key("z", { ctrlKey: true, shiftKey: true });
    expect(graph().nodes.find((n: any) => n.id === c.id).inputs).toBe(5);
    // typing into one field is one step
    ed.select(c.id);
    const f = $('[data-testid="tsa-param-formula"]') as HTMLInputElement;
    change(f, "I"); change(f, "IN"); change(f, "IN1");
    key("z", { ctrlKey: true });
    expect(graph().nodes.find((n: any) => n.id === c.id).params.formula).toBeUndefined();
  });
});

describe("problems", () => {
  it("marks the nodes from /validate and selects them from the list", async () => {
    problems = () => [
      { level: "error", node: "ask", port: "maxDigits", message: "Max digits must be 1–32." },
      { level: "warning", node: "bye", message: "Nothing leads here — it never runs." },
      { level: "error", edge: "e1", message: "A broken wire." },
    ];
    await E().current().validate();
    expect(nodeEl("ask").classList.contains("is-err")).toBe(true);
    expect(nodeEl("ask").querySelector('[data-testid="tsa-node-badge"]')!.textContent).toBe("1");
    expect(nodeEl("bye").classList.contains("is-warn")).toBe(true);
    expect($('path.tsa-wire[data-edge="e1"]').getAttribute("class")).toContain("is-bad");
    expect($('[data-testid="tsa-errors"]').textContent).toBe("2 errors");
    expect($('[data-testid="tsa-warnings"]').textContent).toBe("1 warning");
    $('[data-testid="tsa-problems-head"]').click();
    const rows = $$('[data-testid="tsa-problem"]');
    expect(rows.map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Max digits must be 1–32.")]));
    rows[0].click();
    expect(E().current().selection().nodes).toEqual(["ask"]);
    expect($(".tsa-insp__head").textContent).toContain("Read DTMF");
    expect($('[data-param="maxDigits"]').textContent).toContain("Max digits must be 1–32.");
    rows[1].click();
    expect(E().current().selection().edge).toBe("e1");
  });

  it("checks in the browser when the server cannot answer", async () => {
    problems = () => { throw new Error("HTTP 404"); };
    const ed = E().current();
    ed.addNode("condition", 0, 400);
    await ed.validate();
    const list = ed.problems();
    expect(list).toContainEqual(expect.objectContaining({ level: "error", node: "condition_1", port: "formula" }));
    expect(list).toContainEqual(expect.objectContaining({ level: "warning", node: "bye", port: "in" }));
    expect($(".tsa-probs__src").textContent).toContain("checked in the browser");
  });

  it("publishes after a confirmation", async () => {
    const ed = E().current();
    const done = ed.publish();
    await settle();
    expect($('[data-testid="tsa-dialog"]').textContent).toContain("Publish version 2?");
    ($('[data-testid="tsa-dialog"] [data-value="true"]') as HTMLButtonElement).click();
    expect(await done).toBe(true);
    expect(calls.some((c) => c.path === "/admin/telephony/tsa/main-ivr/publish")).toBe(true);
    expect($('[data-testid="tsa-state"]').textContent).toContain("Published v2");
  });

  it("refuses to publish with errors", async () => {
    problems = () => [{ level: "error", node: "ask", message: "Broken." }];
    expect(await E().current().publish()).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("without errors"), "err");
  });
});

describe("unsaved work", () => {
  it("keeps a local copy, asks before closing and offers the copy again", async () => {
    const ed = E().current();
    ed.addNode("pause", 0, 900);
    await settle();
    expect(JSON.parse(localStorage.getItem("m5cet:tsa-draft:main-ivr")!).graph.nodes.length).toBe(4);
    expect($('[data-testid="tsa-dirty"]').textContent).toContain("Unsaved");
    $('[data-testid="tsa-close"]').click();
    await settle();
    expect($('[data-testid="tsa-dialog"]').textContent).toContain("Unsaved changes");
    ($('[data-testid="tsa-dialog"] [data-value="stay"]') as HTMLButtonElement).click();
    await settle();
    expect($('[data-testid="tsa-editor"]')).toBeTruthy();
    // close without the dialog's discard: the copy stays for the next time
    await E().close(true);
    expect(closed.pop()).toMatchObject({ id: "main-ivr", saved: false });
    await E().open("main-ivr");
    await settle();
    $('[data-testid="tsa-restore"]').click();
    expect(graph().nodes.map((n: any) => n.type)).toEqual(["start", "read_dtmf", "hangup", "pause"]);
    // discard in the dialog removes the copy
    const closing = E().close();
    await settle();
    ($('[data-testid="tsa-dialog"] [data-value="discard"]') as HTMLButtonElement).click();
    expect(await closing).toBe(true);
    expect(localStorage.getItem("m5cet:tsa-draft:main-ivr")).toBeNull();
    expect($('[data-testid="tsa-editor"]')).toBeNull();
    expect(document.documentElement.classList.contains("tsa-open")).toBe(false);
  });

  it("saves from the close dialog", async () => {
    E().current().addNode("pause", 0, 900);
    const closing = E().close();
    await settle();
    ($('[data-testid="tsa-dialog"] [data-value="save"]') as HTMLButtonElement).click();
    expect(await closing).toBe(true);
    expect(calls.filter((c) => c.method === "PUT").length).toBe(1);
    expect(closed.pop()).toMatchObject({ saved: true });
  });
});

describe("the simulator", () => {
  const waitDigits: SimTurn = {
    session: "sim1", status: "waiting", at: "ask",
    play: [{ kind: "say", text: "Zadejte kód", language: "cs-CZ" }],
    waiting: { for: "digits", node: "ask", maxDigits: 4, finishOnKey: "#", timeoutSec: 5 },
    steps: ["start → next", "ask: waiting for digits"], ended: null,
  };
  const bye: SimTurn = { session: "sim1", status: "ended", at: null, play: [{ kind: "say", text: "Na shledanou" }], waiting: null, steps: ["ask → next", "bye: hangup"], ended: { how: "hangup" } };

  it("plays a SimTurn, sends the keypad's digits and marks the running node", async () => {
    const spoken: string[] = [];
    (window as any).SpeechSynthesisUtterance = class { text: string; lang = ""; onend: null | (() => void) = null; constructor(t: string) { this.text = t; } };
    (window as any).speechSynthesis = { speak: (u: any) => { spoken.push(u.text); setTimeout(() => u.onend && u.onend()); }, cancel: () => undefined };
    turns = [waitDigits, bye];
    $('[data-testid="tsa-simulate"]').click();
    $('[data-testid="tsa-sim-start"]').click();
    await settle();
    expect(calls.find((c) => c.path === "/admin/telephony/sim")!.body).toEqual({ tsa: "main-ivr", draft: true, from: "+420600000001", to: "+420200000000" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect($('[data-testid="tsa-sim-hears"]').textContent).toContain("Zadejte kód");
    expect(spoken).toEqual(["Zadejte kód"]);
    expect($('[data-testid="tsa-sim-status"]').textContent).toContain("Waiting for up to 4 digits");
    expect(nodeEl("ask").classList.contains("is-sim-run")).toBe(true);
    expect(nodeEl("start").classList.contains("is-sim-visited")).toBe(true);
    expect($('path.tsa-wire[data-edge="e1"]').getAttribute("class")).toContain("is-sim");
    expect($('[data-testid="tsa-sim-trace"]').textContent).toContain("ask: waiting for digits");
    $('[data-testid="tsa-key-1"]').click();
    $('[data-testid="tsa-key-2"]').click();
    key("3");
    expect($('[data-testid="tsa-sim-digits"]').textContent).toBe("123");
    $('[data-testid="tsa-key-hash"]').click();
    await settle();
    expect(calls.find((c) => c.path === "/admin/telephony/sim/sim1/event")!.body).toEqual({ kind: "digits", digits: "123", finishedBy: "#" });
    expect($('[data-testid="tsa-sim-status"]').textContent).toContain("Ended — hangup");
    expect($$(".tsa-node.is-sim-run").length).toBe(0);
    expect($('[data-testid="tsa-sim-trace"]').textContent).toContain("bye: hangup");
    expect(spoken).toEqual(["Zadejte kód", "Na shledanou"]);
    delete (window as any).speechSynthesis;
    delete (window as any).SpeechSynthesisUtterance;
  });

  it("saves a changed draft first, then speaks, times out and hangs up", async () => {
    turns = [
      { session: "sim1", status: "waiting", at: "ask", play: [], waiting: { for: "speech", node: "ask", maxSeconds: 10 }, steps: [], ended: null },
      { session: "sim1", status: "waiting", at: "ask", play: [{ kind: "beep" }], waiting: { for: "digits", node: "ask", maxDigits: 1, finishOnKey: "none" }, steps: [], ended: null },
      { session: "sim1", status: "waiting", at: "ask", play: [], waiting: { for: "dial", node: "ask" }, steps: [], ended: null },
      { session: "sim1", status: "ended", at: null, play: [], waiting: null, steps: [], ended: { how: "hangup", cause: "caller" } },
    ];
    E().current().addNode("pause", 0, 900);
    await E().current().simulate();
    await settle();
    const order = calls.map((c) => `${c.method} ${c.path}`).filter((c) => c.startsWith("PUT") || c.endsWith("/sim"));
    expect(order).toEqual(["PUT /admin/telephony/tsa/main-ivr", "POST /admin/telephony/sim"]);
    const say = $('[data-testid="tsa-sim-say"]') as HTMLInputElement;
    change(say, "ano");
    say.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(calls.filter((c) => c.path.endsWith("/event")).pop()!.body).toEqual({ kind: "speech", text: "ano", confidence: 1 });
    ([...$$(".tsa-phone__acts button")].find((b) => b.textContent!.includes("Timeout")) as HTMLButtonElement).click();
    await settle();
    expect(calls.filter((c) => c.path.endsWith("/event")).pop()!.body).toEqual({ kind: "digits", digits: "", timedOut: true });
    expect([...$$(".tsa-phone__acts button")].map((b) => b.textContent)).toEqual(["answered", "busy", "no-answer", "failed"]);
    $('[data-testid="tsa-sim-hangup"]').click();
    await settle();
    expect(calls.filter((c) => c.path.endsWith("/event")).pop()!.body).toEqual({ kind: "hangup", cause: "caller" });
    expect(E().current().sim().ended).toEqual({ how: "hangup", cause: "caller" });
  });
});

describe("markup", () => {
  it("builds every element in code — no markup strings", () => {
    for (const f of ["tsa-editor.js", "tsa-editor-icons.js"]) {
      const src = readFileSync(join(PUB, f), "utf8");
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|on[a-z]+="/);
    }
    const html = readFileSync(join(PUB, "index.html"), "utf8");
    expect(html).toContain('<script src="tsa-editor.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="tsa-editor.css" />');
  });
});
