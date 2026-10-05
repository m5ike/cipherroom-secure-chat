// 6.11: a call whose parameters cannot go to the server as typed never does —
// system-messenger answers with a card: what is wrong with which input, the
// usage line, every input (type, required, help, allowed values, example),
// the model's own guide and an example call. An EMPTY call to a model whose
// inputs are all optional still goes (the model answers with its own form).
// And a running command's questions keep their field types.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { checkCommandInputs } from "../client/src/lib/system-messenger";
import { buildInputs, type Command, type Interaction } from "../client/src/lib/functions";
import { exampleCall, expectationText, usageCardOutputs } from "../client/src/lib/fn-answer";
import { FnOutputs } from "../client/src/components/fn/FnOutputs";
import { FnAskDialog, askFieldKind } from "../client/src/components/fn/FnAskDialog";

afterEach(() => cleanup());

const hlr: Command & { usage?: string } = {
  keyword: "hlr", name: "HLR lookup", summary: "", runtime: "js", visibility: "caller", mine: true,
  inputs: [
    { name: "number", type: "phone", label: "Číslo", help: "v mezinárodním tvaru", required: true },
    { name: "format", type: "string", label: "Formát", required: false, values: ["short", "full"] },
    { name: "days", type: "integer", required: false, min: 1, max: 30 },
  ],
  usage: "Zjistí operátora a stav čísla. Např. `/hlr +420603123456 full`",
};
const mail: Command = { keyword: "mail", name: "E-mail analysis", summary: "", runtime: "js", visibility: "caller", mine: true, inputs: [{ name: "domain", type: "string", label: "Domain", help: "example.com", required: false }] };

const textOf = (outputs: ReturnType<typeof usageCardOutputs>) => JSON.stringify(outputs);

describe("the pre-check", () => {
  it("an empty call to a model whose inputs are all optional goes to the server (its own form answers)", () => {
    expect(checkCommandInputs(mail, buildInputs(mail, ""))).toEqual([]);
  });

  it("a missing required input, a value not allowed, a number out of range, a malformed phone number", () => {
    expect(checkCommandInputs(hlr, buildInputs(hlr, "")).map((p) => [p.input, p.problem])).toEqual([["number", "missing"]]);
    expect(checkCommandInputs(hlr, buildInputs(hlr, "+420603123456 medium days=99")).map((p) => [p.input, p.problem])).toEqual([["format", "values"], ["days", "range"]]);
    expect(checkCommandInputs(hlr, buildInputs(hlr, "603123456")).map((p) => [p.input, p.problem])).toEqual([["number", "pattern"]]);
    expect(checkCommandInputs(hlr, buildInputs(hlr, "+420603123456 full days=7"))).toEqual([]);
    const pat: Command = { ...mail, keyword: "ico", inputs: [{ name: "ico", type: "string", required: true, pattern: "^\\d{8}$" }] };
    expect(checkCommandInputs(pat, buildInputs(pat, "123")).map((p) => p.problem)).toEqual(["pattern"]);
  });
});

describe("the usage card", () => {
  it("says what is wrong, how to call it, every input, the model's guide and an example", () => {
    const problems = checkCommandInputs(hlr, buildInputs(hlr, ""));
    const out = usageCardOutputs("cs", hlr, { problems });
    expect(out[0]).toEqual({ type: "flash", level: "error", text: "/hlr se nespustil — parametry chybí nebo nesedí." });
    const all = textOf(out);
    expect(all).toContain("**Číslo** (`number`) chybí — čekám telefonní číslo v mezinárodním tvaru \\\\(+420…\\\\)");
    expect(all).toContain("`/hlr <number> [format] [days]`");
    const table = out.find((o) => o.type === "table") as { columns: string[]; rows: unknown[][] };
    expect(table.columns).toEqual(["Parametr", "Typ", "Povinný", "Popis", "Příklad"]);
    expect(table.rows[0]).toEqual(["Číslo (number)", "phone", "ano", "v mezinárodním tvaru — telefonní číslo v mezinárodním tvaru (+420…)", "+420603123456"]);
    expect(table.rows[1]).toEqual(["Formát (format)", "string", "ne", "jednu z hodnot: short, full", "short"]);
    expect(table.rows[2][3]).toBe("celé číslo od 1 do 30");
    expect(all).toContain("Návod modelu");
    expect(all).toContain("Zjistí operátora");
    expect(all).toContain("Zkuste například: `/hlr +420603123456`");
  });

  it("an input that is wrong but optional is in the example too (named when it is not next in line)", () => {
    const problems = checkCommandInputs(hlr, buildInputs(hlr, "+420603123456 days=99"));
    expect(exampleCall(hlr, problems)).toBe("/hlr +420603123456 days=1");
    expect(exampleCall({ keyword: "x", inputs: [{ name: "a", type: "string", required: false }, { name: "b", type: "domain", required: true }] })).toBe("/x b=example.org");
  });

  it("the server's refusal (bad-input) with its message — and its own list of problems when it sends one", () => {
    const out = usageCardOutputs("en", hlr, { server: { message: "Číslo: is required", problems: [{ input: "number", label: "Number", problem: "missing", expected: "" }] } });
    expect(out[0]).toEqual({ type: "flash", level: "error", text: "/hlr refused the parameters: Číslo: is required" });
    expect(textOf(out)).toContain("**Number** (`number`) is missing — expected a phone number in international form \\\\(+420…\\\\)");
    // Without a command known here: the server's inputs, or just the message and the usage.
    const bare = usageCardOutputs("en", { keyword: "zzz", name: "Z", inputs: [] }, { server: { message: "bad", inputs: [{ name: "q", type: "string", required: true }] } });
    expect(textOf(bare)).toContain("`/zzz <q>`");
  });

  it("is drawn by the outputs renderer (a flash, Markdown, a table)", () => {
    const out = usageCardOutputs("de", hlr, { problems: checkCommandInputs(hlr, {}) });
    const r = render(<FnOutputs outputs={out} meta={{ keyword: "hlr", name: "HLR lookup" }} />);
    expect(r.container.querySelector(".fn-flash--error")?.textContent).toContain("/hlr wurde nicht ausgeführt");
    expect(r.container.querySelector("table")).not.toBeNull();
    expect(r.container.textContent).toContain("Versuchen Sie zum Beispiel:");
  });

  it("expectations in each language", () => {
    expect(expectationText("en", { name: "n", type: "number", required: true, min: 2 })).toBe("a number from 2 to …");
    expect(expectationText("de", { name: "b", type: "boolean", required: true })).toBe("ja / nein (true / false)");
    expect(expectationText("cs", { name: "e", type: "email", required: true })).toBe("e-mailovou adresu");
  });
});

describe("a running command's question keeps its field types", () => {
  const form: Interaction = {
    runId: "run_1", id: "int_1", kind: "form",
    spec: {
      title: "E-mail analysis", submit: "Check",
      fields: [
        { name: "domain", label: "Domain", type: "text", required: true, placeholder: "example.com" },
        { name: "count", label: "Count", type: "number" },
        { name: "mail", label: "E-mail", type: "email" },
        { name: "phone", label: "Phone", type: "phone" },
        { name: "mode", label: "Mode", values: ["quick", "deep"], required: true },
        { name: "dkim", label: "DKIM", type: "boolean" },
        { name: "note", label: "Note", type: "textarea" },
      ],
    } as Interaction["spec"],
  };

  it("each field is asked with its own control; required ones are required", () => {
    const r = render(<FnAskDialog interaction={form} lang="en" onAnswer={() => undefined} />);
    const el = (n: string) => r.container.querySelector(`#fnfield_${n}`) as HTMLInputElement;
    expect(el("domain").type).toBe("text");
    expect(el("domain").required).toBe(true);
    expect(el("count").type).toBe("number");
    expect(el("mail").type).toBe("email");
    expect(el("phone").type).toBe("tel");
    expect(el("mode").tagName).toBe("SELECT");
    expect(el("mode").required).toBe(true);
    expect(Array.from((el("mode") as unknown as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "quick", "deep"]);
    expect(el("dkim").type).toBe("checkbox");
    expect(el("note").tagName).toBe("TEXTAREA");
    expect(askFieldKind({ name: "x", type: "select" })).toBe("text"); // a select without values: free text
  });

  it("answers with typed values (a number, true / false)", () => {
    const onAnswer = vi.fn();
    const r = render(<FnAskDialog interaction={form} lang="en" onAnswer={onAnswer} />);
    const el = (n: string) => r.container.querySelector(`#fnfield_${n}`) as HTMLInputElement;
    fireEvent.change(el("domain"), { target: { value: "example.org" } });
    fireEvent.change(el("count"), { target: { value: "3" } });
    fireEvent.change(el("mode"), { target: { value: "deep" } });
    fireEvent.click(el("dkim"));
    fireEvent.change(el("note"), { target: { value: "two\nlines" } });
    fireEvent.submit(r.container.querySelector("form.fn-ask__form")!);
    expect(onAnswer).toHaveBeenCalledWith({ domain: "example.org", count: 3, mail: "", phone: "", mode: "deep", dkim: true, note: "two\nlines" });
  });

  it("a prompt with choices, a free prompt, and cancel", () => {
    const onAnswer = vi.fn();
    const r = render(<FnAskDialog interaction={{ runId: "r", id: "i", kind: "prompt", spec: { text: "Sure?", choices: ["yes", "no"] } as Interaction["spec"] }} lang="cs" onAnswer={onAnswer} />);
    fireEvent.click(r.getByText("yes"));
    fireEvent.click(r.getByText("Zrušit"));
    expect(onAnswer.mock.calls).toEqual([["yes"], [null]]);
    cleanup();
    const free = vi.fn();
    const p = render(<FnAskDialog interaction={{ runId: "r", id: "i", kind: "prompt", spec: { text: "Name?" } as Interaction["spec"] }} lang="cs" onAnswer={free} />);
    fireEvent.change(p.container.querySelector("#fnprompt")!, { target: { value: "Jana" } });
    fireEvent.submit(p.container.querySelector("form")!);
    expect(free).toHaveBeenCalledWith("Jana");
  });
});
