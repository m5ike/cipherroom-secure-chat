// The message box's suggester, drawn (6.11, components/CommandSuggest.tsx):
// the keys (↑ ↓, PageUp / PageDown, Home / End, Enter / Tab, Esc,
// Ctrl+Space), the ARIA wiring between the field and the listbox, picking by
// key and by mouse, the empty state, the "n more" row, the selected command's
// detail, the argument hint and its value chips, and the usage memory.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import type { Command } from "../client/src/lib/functions";
import { DEFAULT_COMPOSER } from "../client/src/lib/client-config";
import { useComposerSuggest, ModelGlyph, SUGGEST_LIST_ID, SUGGEST_HINT_ID } from "../client/src/components/CommandSuggest";

const cmd = (keyword: string, over: Partial<Command> = {}): Command => ({ keyword, name: keyword, summary: "", runtime: "node", visibility: "caller", mine: false, inputs: [], ...over });
const COMMANDS: Command[] = [
  cmd("dns", {
    name: "DNS lookup", summary: "Looks up the DNS records of a domain", visibility: "room", usage: "/dns example.com MX",
    inputs: [{ name: "domain", type: "hostname", required: true, help: "The domain to look up" }, { name: "type", type: "enum", required: false, values: ["A", "AAAA", "MX", "TXT"], default: "A" }],
  }),
  cmd("dice", { name: "Dice", icon: "🎲", inputs: [{ name: "sides", type: "integer", required: false, min: 2, max: 100 }] }),
  cmd("hlr", { name: "HLR lookup", summary: "Checks a phone number", inputs: [{ name: "number", type: "phone", required: true }] }),
  cmd("help", { name: "Help", summary: "Lists the commands" }),
];
const PEOPLE = [{ name: "Anna" }, { name: "Jan", away: true }];
const TAGS = ["release", "urgent"];

function Harness({ initial = "", commands = COMMANDS, enabled = true as boolean | null, onSend = (_: string) => undefined as void }) {
  const [text, setText] = useState(initial);
  const s = useComposerSuggest({ lang: "en", text, setText, inputId: "msg", triggers: DEFAULT_COMPOSER.triggers, commands, commandsEnabled: enabled, people: PEOPLE, tags: TAGS, user: "tester" });
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <div className="composer-bar">
        <textarea
          id="msg"
          data-testid="field"
          value={text}
          onChange={(e) => { setText(e.target.value); s.onInput(); }}
          onKeyDown={(e) => {
            if (s.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); s.noteSent(text); onSend(text); setText(""); }
          }}
        />
      </div>
      {s.view}
    </form>
  );
}

const field = () => screen.getByTestId("field") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const key = (k: string, extra: Record<string, unknown> = {}) => fireEvent.keyDown(field(), { key: k, ...extra });
const options = () => screen.queryAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true");
/** Lets the pick's caret placement (a layout effect) settle. */
const settle = () => act(async () => { await Promise.resolve(); });

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => cleanup());

describe("the list and its ARIA", () => {
  it("opens on the trigger, with a listbox of options in labelled groups", () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/d");
    const box = screen.getByRole("listbox");
    expect(box.id).toBe(SUGGEST_LIST_ID);
    expect(options().map((o) => o.getAttribute("data-testid"))).toEqual(["sug-command:dns", "sug-command:dice"]);
    const group = screen.getByRole("group", { name: /Commands/ });
    expect(group).toBeTruthy();
    // the field points at the list and at the selected row
    expect(field().getAttribute("aria-autocomplete")).toBe("list");
    expect(field().getAttribute("aria-controls")).toBe(SUGGEST_LIST_ID);
    expect(field().getAttribute("aria-activedescendant")).toBe(selected()!.id);
    expect(selected()!.getAttribute("data-testid")).toBe("sug-command:dns");
  });

  it("highlights the matched letters", () => {
    render(<Harness />);
    type("/dn");
    expect(selected()!.querySelector(".sug-mark")?.textContent).toBe("dn");
  });

  it("closes, and lets the field go, when nothing is offered", () => {
    render(<Harness />);
    type("/d");
    type("hello");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().hasAttribute("aria-controls")).toBe(false);
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);
  });
});

describe("keys", () => {
  it("↑ ↓ wrap, Home / End jump, PageUp / PageDown page", () => {
    render(<Harness />);
    type("/");
    const ids = () => selected()!.getAttribute("data-testid");
    expect(ids()).toBe("sug-command:dns");
    key("ArrowDown");
    expect(ids()).toBe("sug-command:dice");
    expect(field().getAttribute("aria-activedescendant")).toBe(selected()!.id);
    key("ArrowUp");
    key("ArrowUp");
    expect(ids()).toBe("sug-command:help"); // wrapped to the last
    key("Home");
    expect(ids()).toBe("sug-command:dns");
    key("End");
    expect(ids()).toBe("sug-command:help");
    key("PageUp");
    expect(ids()).toBe("sug-command:dns");
    key("PageDown");
    expect(ids()).toBe("sug-command:help");
  });

  it("Enter completes “/keyword ” (it does not send), and the argument hint takes over", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type("/dn");
    key("Enter");
    await settle();
    expect(field().value).toBe("/dns ");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    const hint = screen.getByTestId("cmd-hint");
    expect(hint.id).toBe(SUGGEST_HINT_ID);
    expect(field().getAttribute("aria-describedby")).toContain(SUGGEST_HINT_ID);
    expect(hint.querySelector("[data-active]")?.textContent?.trim()).toBe("<domain>");
    expect(screen.getByTestId("cmd-hint-current").textContent).toContain("The domain to look up");
    expect(screen.getByTestId("cmd-hint-current").textContent).toContain("e.g. example.com");
  });

  it("Tab completes too", async () => {
    render(<Harness />);
    type("/hl");
    key("Tab");
    await settle();
    expect(field().value).toBe("/hlr ");
  });

  it("Esc closes the list; typing opens it again; Esc then hides the hint", async () => {
    render(<Harness />);
    type("/d");
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/dn");
    expect(screen.getByRole("listbox")).toBeTruthy();
    type("/dns x");
    expect(screen.getByTestId("cmd-hint")).toBeTruthy();
    key("Escape");
    expect(screen.queryByTestId("cmd-hint")).toBeNull();
  });

  it("Enter with nothing offered sends", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type("/dns example.com");
    key("Enter");
    expect(onSend).toHaveBeenCalledWith("/dns example.com");
  });

  it("Ctrl+Space opens it on an empty field: commands, people and tags", () => {
    render(<Harness />);
    key(" ", { code: "Space", ctrlKey: true });
    expect(screen.getByRole("group", { name: /Commands/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /People/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Tags/ })).toBeTruthy();
    expect(screen.getByTestId("sug-person:Anna")).toBeTruthy();
    expect(screen.getByTestId("sug-person:Jan").textContent).toContain("away");
  });
});

describe("mouse and touch", () => {
  it("hovering selects, a click picks, and the field keeps the focus", async () => {
    render(<Harness />);
    field().focus();
    type("@");
    const jan = screen.getByTestId("sug-person:Jan");
    fireEvent.mouseMove(jan);
    expect(jan.getAttribute("aria-selected")).toBe("true");
    const down = fireEvent.mouseDown(jan);
    expect(down).toBe(false); // default prevented: no blur
    fireEvent.click(jan);
    await settle();
    expect(field().value).toBe("@Jan ");
    expect(document.activeElement).toBe(field());
  });
});

describe("what it shows", () => {
  it("the empty state names /help", () => {
    render(<Harness />);
    type("/xyz");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("cmd-suggest-empty").textContent).toBe("No command matches “/xyz” — /help lists them all");
    expect(screen.getByTestId("cmd-suggest-empty").getAttribute("role")).toBe("status");
  });

  it("says the module is off", () => {
    render(<Harness enabled={false} />);
    type("/");
    expect(screen.getByTestId("cmd-suggest-empty").textContent).toContain("Commands are off");
  });

  it("a command row: its icon, name, summary, signature and who sees the answer; its detail beside", () => {
    render(<Harness />);
    type("/d");
    const row = screen.getByTestId("sug-command:dns");
    expect(row.querySelector(".sug-ico svg")).toBeTruthy(); // "globe" for dns
    expect(row.querySelector(".sug-row__name")?.textContent).toBe("DNS lookup");
    expect(row.querySelector(".sug-row__sum")?.textContent).toBe("Looks up the DNS records of a domain");
    expect([...row.querySelectorAll(".sug-arg")].map((a) => [a.textContent, a.className.includes("is-req")])).toEqual([["domain", true], ["type", false]]);
    expect(row.querySelector(".sug-badge.is-room")?.textContent).toBe("Room");
    const detail = screen.getByTestId("cmd-suggest-detail");
    expect(detail.querySelector(".sug-detail__usage")?.textContent).toBe("/dns <domain> [type]");
    expect(detail.textContent).toContain("Everyone in the room sees the answer");
    expect(detail.querySelector(".sug-detail__guide")?.textContent).toBe("/dns example.com MX");
    expect(detail.textContent).toContain("default: A");
    key("ArrowDown");
    const dice = screen.getByTestId("sug-command:dice");
    expect(dice.querySelector(".sug-emoji")?.textContent).toBe("🎲");
    expect(dice.querySelector(".sug-badge.is-caller")?.textContent).toBe("Only me");
    expect(screen.getByTestId("cmd-suggest-detail").textContent).toContain("2–100");
  });

  it("an “n more” row opens the rest", () => {
    const many = Array.from({ length: 12 }, (_, i) => cmd(`run${String(i).padStart(2, "0")}`));
    render(<Harness commands={many} />);
    type("/run");
    expect(options()).toHaveLength(9);
    const more = screen.getByTestId("sug-more:commands");
    expect(more.textContent).toBe("+ 4 more");
    key("End");
    key("Enter");
    expect(options()).toHaveLength(12);
    expect(selected()!.getAttribute("data-testid")).toBe("sug-command:run08"); // the first row it opened
  });
});

describe("arguments", () => {
  it("a typed part of a value lists the matching values; Enter fills it", async () => {
    render(<Harness />);
    type("/dns example.com m");
    expect(screen.getByRole("group", { name: /Values — type/ })).toBeTruthy();
    expect(options().map((o) => o.textContent)).toEqual(["MX"]);
    key("Enter");
    await settle();
    expect(field().value).toBe("/dns example.com MX ");
  });

  it("the hint's chips set the value; the default is marked", async () => {
    render(<Harness />);
    type("/dns example.com ");
    expect(screen.queryByRole("listbox")).toBeNull(); // nothing typed: Enter still sends
    const chips = [...screen.getByTestId("cmd-hint").querySelectorAll(".sug-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["A", "AAAA", "MX", "TXT"]);
    expect(chips[0].className).toContain("is-default");
    fireEvent.click(chips[3]);
    await settle();
    expect(field().value).toBe("/dns example.com TXT ");
  });

  it("Ctrl+Space lists the values of an empty argument without selecting one", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type("/dns example.com ");
    key(" ", { code: "Space", ctrlKey: true });
    expect(options().map((o) => o.textContent)).toEqual(["A" + "default", "AAAA", "MX", "TXT"]);
    expect(selected()).toBeUndefined();
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);
    key("ArrowDown");
    expect(selected()!.textContent).toContain("A");
  });

  it("says when the line is past every argument", () => {
    render(<Harness />);
    type("/dns example.com MX more");
    expect(screen.getByTestId("cmd-hint-extra").textContent).toBe("The command takes no more values");
  });
});

describe("the usage memory", () => {
  it("what was picked comes back first as “Recently used”", async () => {
    const { unmount } = render(<Harness />);
    type("/hl");
    key("Enter");
    await settle();
    unmount();
    render(<Harness />);
    type("/");
    const recent = screen.getByRole("group", { name: /Recently used/ });
    expect(recent.textContent).toContain("hlr");
    expect(selected()!.getAttribute("data-testid")).toBe("sug-command:hlr");
  });

  it("a message sent by hand counts too", () => {
    const { unmount } = render(<Harness />);
    type("/dice 6");
    key("Enter");
    unmount();
    render(<Harness />);
    type("/");
    expect(screen.getByRole("group", { name: /Recently used/ }).textContent).toContain("dice");
  });
});

describe("the model's icon", () => {
  it("a catalog icon, a default one outside the catalog, an emoji, or the robot", () => {
    const { container } = render(<div><ModelGlyph icon="globe" /><ModelGlyph icon="cloud-sun" /><ModelGlyph icon="🌦️" /><ModelGlyph icon="no-such-icon" /></div>);
    expect(container.querySelectorAll("svg")).toHaveLength(3);
    expect(container.querySelector(".sug-emoji")?.textContent).toBe("🌦️");
  });
});
