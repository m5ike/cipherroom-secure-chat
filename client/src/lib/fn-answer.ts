// 6.11: a model's answer as the chat shows it, and the card system-messenger
// answers a call whose parameters cannot go to the server.
//
// An answer is an INCOMING message from "system-messenger" under the model's
// identity (its name as the nickname, its icon as the avatar), a reply to the
// call it answers. One shown only here has system-messenger as its sender; a
// room answer is still the caller's own end-to-end-encrypted message — every
// member shows it under the model's identity WITH "via <the member>"
// (validate.ts keeps "system-messenger" and "function:*" from any peer).

import type { ChatMessage } from "./chat-types";
import type { Command, CommandInput } from "./functions";
import type { FnOutput } from "./fn-outputs";
import { t, tf, type Lang } from "./i18n";
import { cleanModelIcon, commandUsage, isModelSender, modelIdentity, type InputProblem, type ModelIdentity } from "./system-messenger";

/** Who a model's answer was sent by, when it is not this app's own (a room answer). */
export type AnswerVia = { name: string; mine: boolean };
export type ModelAnswerView = { identity: ModelIdentity; via: AnswerVia | null };

/** A message shown as a model's answer — or null (an ordinary message, or a call's own bubble). */
export function modelAnswerView(m: Pick<ChatMessage, "senderId" | "senderName" | "mine" | "flags">): ModelAnswerView | null {
  const fn = m.flags?.fn;
  if (!fn || fn.query !== undefined || fn.pending || fn.status) return null;
  const identity = modelIdentity({ keyword: fn.keyword, name: fn.name, icon: cleanModelIcon(fn.icon) });
  if (isModelSender(m.senderId)) return { identity, via: null };
  return { identity, via: { name: m.senderName, mine: m.mine } };
}

type Input = CommandInput & { pattern?: string; min?: number; max?: number };

/** What an input expects, in the person's language ("one of: a, b", "a number 1–10"). */
export function expectationText(lang: Lang, i: Input): string {
  if (i.values && i.values.length) return tf(lang, "fnusage.expect.values", { values: i.values.join(", ") });
  if (i.type === "number" || i.type === "integer") {
    const what = t(lang, `fnusage.expect.${i.type}`);
    return i.min !== undefined || i.max !== undefined ? tf(lang, "fnusage.expect.range", { what, min: i.min ?? "…", max: i.max ?? "…" }) : what;
  }
  if (i.type === "phone" || i.type === "tel" || i.pattern === "^\\+[1-9]\\d{1,14}$") return t(lang, "fnusage.expect.phone");
  if (i.type === "boolean") return t(lang, "fnusage.expect.boolean");
  if (i.pattern) return tf(lang, "fnusage.expect.pattern", { pattern: i.pattern });
  if (i.type === "email" || i.type === "url") return t(lang, `fnusage.expect.${i.type}`);
  if (!i.type || i.type === "string" || i.type === "text") return t(lang, "fnusage.expect.text");
  return tf(lang, "fnusage.expect.type", { type: i.type });
}

/** A value that would do for an input — for the example call. */
export function exampleValue(i: Input): string {
  if (i.default !== undefined && i.default !== null && i.default !== "" && typeof i.default !== "object") return String(i.default);
  if (i.values && i.values.length) return i.values[0];
  const n = i.name.toLowerCase();
  switch (i.type) {
    case "phone": case "tel": return "+420603123456";
    case "number": return String(i.min ?? 1);
    case "integer": return String(Math.ceil(i.min ?? 1));
    case "boolean": return "true";
    case "email": return "jana@example.org";
    case "url": return "https://example.org";
    case "date": return "2026-10-05";
    case "time": return "12:00";
    case "domain": case "host": return "example.org";
    case "ip": return "192.0.2.1";
  }
  if (i.pattern === "^\\+[1-9]\\d{1,14}$" || /phone|msisdn|tel|number|cislo/.test(n)) return "+420603123456";
  if (/mail/.test(n)) return "jana@example.org";
  if (/url|web|link/.test(n)) return "https://example.org";
  if (/domain|host|server/.test(n)) return "example.org";
  if (/ip/.test(n)) return "192.0.2.1";
  return i.label ? i.label.toLowerCase().split(/\s+/)[0] : i.name;
}

const quoted = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
/** Text put into Markdown as it is (markdown.ts's escapes). */
const md = (s: string) => s.replace(/([\\`*_~[\]()#>!|-])/g, "\\$1");
/** Text put into inline code (no escapes there: only a backtick would end it). */
const code = (s: string) => s.replace(/`/g, "'");

/** "/hlr +420603123456" — the call with a value for every required input (and every input that was wrong). */
export function exampleCall(cmd: Pick<Command, "keyword" | "inputs">, problems: InputProblem[] = [], trigger = "/"): string {
  const wrong = new Set(problems.map((p) => p.input));
  const wanted = cmd.inputs.filter((i) => (i.required && i.default === undefined) || wrong.has(i.name));
  // Bare tokens fill the chat-typeable inputs in order (functions.ts › buildInputs): one that is not next in line is named.
  const positional = cmd.inputs.filter((i) => i.type !== "user" && i.type !== "file" && i.type !== "secret");
  let next = 0;
  const args = wanted.map((i) => {
    const v = quoted(exampleValue(i));
    if (positional[next] === i) { next++; return v; }
    return `${i.name}=${v}`;
  });
  return [`${trigger}${cmd.keyword}`, ...args].join(" ");
}

/**
 * The card system-messenger answers with when a call cannot run as typed: what
 * is wrong with which input, the usage line, every input (label, type, whether
 * it is required, its help and what it takes, an example), the model's own
 * guide, and an example call. `server`: the server refused the inputs (its
 * "bad-input" message, and its list of problems when it sends one).
 */
export function usageCardOutputs(lang: Lang, cmd: Pick<Command, "keyword" | "name" | "inputs"> & { usage?: string }, opts: { problems?: InputProblem[]; server?: { message: string; problems?: unknown; inputs?: unknown; usage?: unknown; command?: unknown }; trigger?: string } = {}): FnOutput[] {
  const trigger = opts.trigger ?? "/";
  // The server's bad-input answer carries the model's definition as `command` (a /commands entry: inputs, usage).
  const srv = opts.server?.command && typeof opts.server.command === "object" ? opts.server.command as { inputs?: unknown; usage?: unknown } : undefined;
  const inputs = serverInputs(opts.server?.inputs ?? srv?.inputs) ?? (cmd.inputs as Input[]);
  const problems = opts.problems ?? serverProblems(opts.server?.problems) ?? [];
  const byName = new Map(inputs.map((i) => [i.name, i]));
  const out: FnOutput[] = [{
    type: "flash", level: "error",
    text: opts.server ? tf(lang, "fnusage.server", { keyword: cmd.keyword, message: opts.server.message }) : tf(lang, "fnusage.title", { keyword: cmd.keyword }),
  }];
  if (problems.length) {
    out.push({
      type: "markdown",
      text: [`**${t(lang, "fnusage.problems")}**`, ...problems.map((p) => {
        const i = byName.get(p.input);
        const expected = i ? expectationText(lang, i) : p.expected;
        return `- **${md(p.label || p.input)}** (\`${code(p.input)}\`) ${t(lang, `fnusage.problem.${p.problem}`)} — ${tf(lang, "fnusage.expected", { what: md(expected) })}`;
      })].join("\n"),
    });
  }
  const shape = { keyword: cmd.keyword, inputs };
  out.push({ type: "markdown", text: `**${t(lang, "fnusage.usage")}:** \`${code(commandUsage(shape, trigger))}\`` });
  if (inputs.length) {
    out.push({
      type: "table",
      title: t(lang, "fnusage.inputs"),
      columns: ["input", "type", "required", "about", "example"].map((c) => t(lang, `fnusage.col.${c}`)),
      rows: inputs.map((i) => [
        i.label && i.label !== i.name ? `${i.label} (${i.name})` : i.name,
        i.type || "string",
        t(lang, i.required && i.default === undefined ? "fnusage.yes" : "fnusage.no"),
        [i.help, expectationText(lang, i)].filter(Boolean).join(" — "),
        exampleValue(i),
      ]),
    });
  }
  const srvUsage = opts.server?.usage ?? srv?.usage;
  const guide = typeof cmd.usage === "string" && cmd.usage.trim() ? cmd.usage.trim() : typeof srvUsage === "string" ? srvUsage.trim() : "";
  if (guide) out.push({ type: "markdown", text: `**${t(lang, "fnusage.guide")}**\n\n${guide.slice(0, 4000)}` });
  out.push({ type: "markdown", text: tf(lang, "fnusage.hint", { example: `\`${code(exampleCall(shape, problems, trigger))}\`` }) });
  return out;
}

/** The inputs a "bad-input" error may carry (the server's own definition). */
function serverInputs(v: unknown): Input[] | null {
  if (!Array.isArray(v)) return null;
  const list = v.filter((x): x is Input => Boolean(x) && typeof x === "object" && typeof (x as Input).name === "string")
    .map((x) => ({ ...x, type: typeof x.type === "string" ? x.type : "string", required: x.required === true, values: Array.isArray(x.values) ? x.values.map(String) : undefined }));
  return list.length ? list : null;
}

const PROBLEMS = new Set(["missing", "type", "pattern", "range", "values"]);
/** The problems a "bad-input" error may list. */
function serverProblems(v: unknown): InputProblem[] | null {
  if (!Array.isArray(v)) return null;
  const list = v.filter((x): x is InputProblem => Boolean(x) && typeof x === "object" && typeof (x as InputProblem).input === "string" && PROBLEMS.has((x as InputProblem).problem))
    .map((x) => ({ input: x.input, label: typeof x.label === "string" ? x.label : x.input, problem: x.problem, expected: typeof x.expected === "string" ? x.expected : "" }));
  return list.length ? list : null;
}
