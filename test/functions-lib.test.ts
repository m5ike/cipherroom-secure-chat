// Chat command parsing and output rendering on the client (client/src/lib/functions.ts, 4.15).

import { describe, it, expect } from "vitest";
import { parseCommandLine, buildInputs, outputsToMarkdown, type Command, type FnOutput } from "../client/src/lib/functions";

const command = (inputs: Command["inputs"]): Command => ({ keyword: "check", name: "Check", summary: "", runtime: "server", visibility: "room", mine: true, inputs });

describe("parseCommandLine", () => {
  it("recognises a slash command and its arguments", () => {
    expect(parseCommandLine("/pocasi Brno")).toEqual({ keyword: "pocasi", argText: "Brno" });
    expect(parseCommandLine("  /ping  ")).toEqual({ keyword: "ping", argText: "" });
    expect(parseCommandLine("/check a=1 b=2")).toEqual({ keyword: "check", argText: "a=1 b=2" });
  });
  it("is not a command for plain text or a bare slash", () => {
    expect(parseCommandLine("hello")).toBeNull();
    expect(parseCommandLine("/")).toBeNull();
    expect(parseCommandLine("http://x/y")).toBeNull();
  });
});

describe("buildInputs", () => {
  it("maps key=value pairs and fills required inputs positionally", () => {
    const c = command([{ name: "domain", type: "hostname", required: true }, { name: "port", type: "integer", required: false, default: 443 }, { name: "depth", type: "enum", required: false, default: "fast", values: ["fast", "full"] }]);
    expect(buildInputs(c, "example.org depth=full")).toEqual({ domain: "example.org", depth: "full" });
    expect(buildInputs(c, "example.org 8443")).toEqual({ domain: "example.org", port: "8443" });
  });
  it("gives the rest of the line to a trailing text field", () => {
    const c = command([{ name: "to", type: "string", required: true }, { name: "message", type: "text", required: true }]);
    expect(buildInputs(c, 'alice "hello there" friend')).toEqual({ to: "alice", message: "hello there friend" });
  });
  it("honours quotes", () => {
    const c = command([{ name: "title", type: "string", required: true }]);
    expect(buildInputs(c, '"a b c"')).toEqual({ title: "a b c" });
  });
});

describe("outputsToMarkdown", () => {
  it("renders each output kind", () => {
    const outputs: FnOutput[] = [
      { type: "markdown", text: "# Hi" },
      { type: "code", text: "x=1", lang: "py" },
      { type: "table", columns: ["a", "b"], rows: [[1, 2], ["x|y", 4]], title: "T" },
      { type: "json", value: { ok: true } },
      { type: "flash", text: "done", level: "success" },
      { type: "image", mime: "image/png", data: "AA==", alt: "chart" },
    ];
    const md = outputsToMarkdown(outputs);
    expect(md).toContain("# Hi");
    expect(md).toContain("```py\nx=1\n```");
    expect(md).toContain("| a | b |");
    expect(md).toContain("x\\|y"); // pipes escaped in a cell
    expect(md).toContain("**T**");
    expect(md).toContain('"ok": true');
    expect(md).toContain("> done");
    expect(md).toContain("_(image: chart)_");
  });
  it("is empty for no outputs", () => {
    expect(outputsToMarkdown([])).toBe("");
  });
});
