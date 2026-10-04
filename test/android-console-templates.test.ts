// @vitest-environment node
// The console keeps a TRANSCRIBED copy of the standard APDU templates
// (admin-ui/public/android-console.js — plain JS, it cannot import the app's
// TypeScript). This test evaluates the console's own functions and checks the
// copy equals STANDARD_APDU_TEMPLATES exactly, that what "Load standard APDU
// templates" saves materializes (through the server's sanitizer) to the same
// set, and that its templateProblems agrees with the app's — so they cannot drift.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { commandProblem, READ_ONLY_COMMANDS, STANDARD_APDU_TEMPLATES, templateProblems } from "../client/src/lib/nfc/apdu-templates";
import { defineValues, sanitizeDefineSet } from "../client/src/lib/define/schema";

const SRC = readFileSync(join(__dirname, "..", "admin-ui", "public", "android-console.js"), "utf8");

/** One of the console's top-level functions (two-space indent inside its IIFE), as source. */
function fn(name: string): string {
  const start = SRC.indexOf(`\n  function ${name}(`);
  if (start < 0) throw new Error(`android-console.js has no function ${name}`);
  const end = SRC.indexOf("\n  }\n", start + 1);
  return SRC.slice(start + 1, end + 4);
}

/** One of its top-level constants (`  const NAME = {` … `  };`). */
function decl(name: string): string {
  const start = SRC.indexOf(`\n  const ${name} = `);
  if (start < 0) throw new Error(`android-console.js has no const ${name}`);
  const end = SRC.indexOf("\n  };\n", start + 1);
  return SRC.slice(start + 1, end + 5);
}

type Console = {
  defStandardApduTemplates: () => unknown[];
  defApduTemplatesNode: () => unknown;
  defMaterialize: (node: unknown) => unknown;
  defTemplateProblems: (t: unknown) => string[];
  defTemplatesCheck: (v: unknown) => { ok: boolean; lines: string[] };
  defCommandProblem: (apdu: string) => string | null;
  DEF_READ_ONLY: unknown;
};
const consts = ["DEF_READ_ONLY", "DEF_INS_NAMES", "DEF_DESFIRE_NAMES"];
const names = ["defMaterialize", "defStandardApduTemplates", "defNodeOfValue", "defApduTemplatesNode", "defTemplateSteps", "defReadCommand", "defCommandProblem", "defTemplateProblems", "defTemplatesCheck"];
const C = runInNewContext(`${consts.map(decl).join("\n")}\n${names.map(fn).join("\n")}\n({ ${[...consts, ...names].join(", ")} })`) as Console;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("the console's standard APDU templates", () => {
  it("equal STANDARD_APDU_TEMPLATES exactly (keys in the same order too)", () => {
    const copy = plain(C.defStandardApduTemplates());
    expect(copy).toEqual(plain(STANDARD_APDU_TEMPLATES));
    expect(JSON.stringify(copy)).toBe(JSON.stringify(STANDARD_APDU_TEMPLATES));
  });

  it("load as a definition that materializes — through the server's sanitizer — to the same set", () => {
    const node = plain(C.defApduTemplatesNode());
    expect(plain(C.defMaterialize(node))).toEqual(plain(STANDARD_APDU_TEMPLATES));
    const set = sanitizeDefineSet({ defs: [{ name: "apduTemplates", kind: "constant", node, maxSize: 0, scope: "both" }] });
    expect(defineValues(set).apduTemplates).toEqual(plain(STANDARD_APDU_TEMPLATES));
  });

  it("say what is wrong with a template the same way the apps do", () => {
    const samples: unknown[] = [
      ...STANDARD_APDU_TEMPLATES, null, "x", {}, { label: "" }, { label: "old", apdu: "00A404000E325041592E5359532E444446303100\n80A8000002830000" },
      { label: "old op", op: "eid-read", args: { readPhoto: false } }, { label: "bad", steps: [{ apdu: "00A4" }, { op: "select-aid", aid: "XYZ" }, { op: "get-data", tags: ["9F3"] }] },
      { label: "deep", steps: [{ op: "for-each-aid", steps: [{ op: "for-each-aid", steps: [{ op: "for-each-aid", steps: [{ op: "for-each-aid", steps: [] }] }] }] }] },
    ];
    for (const s of samples) expect(plain(C.defTemplateProblems(s)), JSON.stringify(s)).toEqual(templateProblems(s));
  });

  it("G-18: keep the same read-only command list, and refuse the same commands", () => {
    expect(plain(C.DEF_READ_ONLY)).toEqual(plain(READ_ONLY_COMMANDS));
    const cmds = ["00A404000E325041592E5359532E444446303100", "00B2010C00", "80A8000002830000", "80CA9F3600", "80AE800000", "0020008008", "00D6000004DEADBEEF", "00DA9F4D02", "0084000008", "0088000008", "9060000000", "90AF000000", "900A000000", "90FC000000", "FFCA000000", "FFD6000004", "00C0000010", "80C0000010", "0CB0000000", "00B1000000", "84CA9F3600", "XYZ"];
    for (const c of cmds) expect(C.defCommandProblem(c), c).toBe(commandProblem(c));
    expect(C.defCommandProblem("0020008008")).toBe("not a read command: 00 20 (VERIFY)");
  });

  it("checks an apduTemplates value in the Define builder", () => {
    expect(plain(C.defTemplatesCheck(plain(STANDARD_APDU_TEMPLATES)))).toEqual({ ok: true, lines: [`${STANDARD_APDU_TEMPLATES.length} templates — each can run.`] });
    expect(plain(C.defTemplatesCheck([{ label: "A", steps: [{ op: "select-aid", aid: "1" }] }, { label: "B", apdu: "00A40400" }]))).toEqual({ ok: false, lines: ["#1 A: bad AID 1"] });
    expect(C.defTemplatesCheck({}).ok).toBe(false);
  });
});
