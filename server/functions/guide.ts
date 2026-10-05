// How a model presents itself to the chat (6.11): the command the app lists
// (its icon — the avatar of its answers from "system-messenger" — its usage
// guide, its inputs with their checks), the usage line ("/hlr [number]") and
// what a wrong call answers: what is wrong, the model's definition and its
// guide (client/src/lib/system-messenger.ts is the client's side of this).

import type { Caller, InputSpec, Model } from "./types";
import { endpointTypes } from "./endpoints";
import type { InputProblem } from "./inputs";

/** One input as the chat sees it (the schema, without anything secret). */
export function inputView(i: InputSpec) {
  return {
    name: i.name, type: i.type, label: i.label, help: i.help, required: Boolean(i.required), default: i.default, values: i.values,
    // 6.11: the checks, so the client can tell a wrong value before it sends it.
    pattern: i.pattern, min: i.min, max: i.max,
  };
}

/** "/hlr [number]" — the command's signature from its inputs (required in <>, optional in []), as commandUsage() on the client. */
export function usageLine(model: Pick<Model, "keyword" | "inputs">, trigger = "/"): string {
  const args = model.inputs.map((i) => (i.required && i.default === undefined ? `<${i.name}>` : `[${i.name}]`));
  return [`${trigger}${model.keyword}`, ...args].join(" ");
}

/** A "/keyword" command as GET /api/functions/commands lists it (client/src/lib/functions.ts Command). */
export function commandView(model: Model, caller: Caller) {
  return {
    keyword: model.keyword,
    name: model.name,
    summary: model.summary,
    runtime: model.runtime,
    visibility: model.executors.chat.visibility,
    mine: model.groups.length === 0 || model.groups.some((g) => caller.groups.includes(g)),
    inputs: model.inputs.map(inputView),
    // 5.3: the entry points a reply, a click or a form of this model's messages reach.
    events: endpointTypes(model).filter((t) => t !== "execute" && t !== "webhook"),
    model: model.id,
    // 6.11: its avatar ("" — the app picks one by the keyword) and its own guide.
    icon: model.icon ?? "",
    usage: model.usage ?? "",
  };
}
export type CommandView = ReturnType<typeof commandView>;

/**
 * 6.11: what a call with wrong parameters answers besides { code: "bad-input",
 * message }: every input that is wrong, the model as a command (its inputs
 * with their checks, its usage text) and the generated usage line — so the
 * chat can say what is wrong, show the definition and a guide.
 */
export function badInputDetails(model: Model, caller: Caller, problems: InputProblem[]): { problems: InputProblem[]; command: CommandView; usageLine: string } {
  return { problems, command: commandView(model, caller), usageLine: usageLine(model) };
}
