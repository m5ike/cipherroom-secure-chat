// Input validation and coercion (server/functions/inputs.ts, 4.15).

import { describe, it, expect } from "vitest";
import { validateInputs } from "../server/functions/inputs";
import { RunRefused } from "../server/functions/runner";
import type { InputSpec } from "../server/functions/types";

const run = (specs: InputSpec[], raw: Record<string, unknown>) => validateInputs(specs, raw);
const fails = (specs: InputSpec[], raw: Record<string, unknown>, message?: string) => {
  try { run(specs, raw); throw new Error("did not refuse"); }
  catch (e) { expect(e).toBeInstanceOf(RunRefused); if (message) expect((e as Error).message).toContain(message); }
};

describe("validateInputs", () => {
  it("coerces text to the declared type", () => {
    expect(run([{ name: "n", type: "integer" }, { name: "f", type: "number" }, { name: "b", type: "boolean" }], { n: "42", f: "3.5", b: "yes" })).toEqual({ n: 42, f: 3.5, b: true });
  });
  it("applies defaults and drops unknown fields", () => {
    expect(run([{ name: "port", type: "integer", default: 443 }], { port: "", extra: "x" })).toEqual({ port: 443 });
  });
  it("requires required fields, by their label", () => {
    fails([{ name: "city", type: "string", required: true, label: "City" }], {}, "City: is required");
  });
  it("enforces ranges, enums, and formats", () => {
    fails([{ name: "n", type: "integer", min: 1, max: 10 }], { n: "20" }, "at most 10");
    fails([{ name: "d", type: "enum", values: ["a", "b"] }], { d: "c" }, "one of: a, b");
    fails([{ name: "u", type: "url" }], { u: "ftp://x" }, "http(s)");
    fails([{ name: "h", type: "hostname" }], { h: "not a host" }, "hostname");
    fails([{ name: "e", type: "email" }], { e: "nope" }, "e-mail");
  });
  it("parses json inputs", () => {
    expect(run([{ name: "j", type: "json" }], { j: '{"a":1}' })).toEqual({ j: { a: 1 } });
    fails([{ name: "j", type: "json" }], { j: "{bad" }, "valid JSON");
  });
});
