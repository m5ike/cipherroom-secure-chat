// Which models a caller may see and run (5.2): the model's own switches and
// groups, and the Functions module's rights (model:<keyword|id|name>,
// package:<name>, run). Shared by the chat routes and m5.functions.list().

import { functionsStore } from "./store";
import type { Caller, Model } from "./types";
import { allows, decision, type Check } from "../access";
import { endpointTypes, endpointsOf } from "./endpoints";

/** A model's names for the Functions module's rights (one aspect: the item). */
export function modelRightNames(model: Model): string[] {
  const pkg = /^([^@]+)@/.exec(model.entry)?.[1] ?? "";
  return [`model:${model.keyword || model.id}`, `model:${model.id}`, `model:${model.name}`, ...(pkg ? [`package:${pkg}`] : [])];
}

/** Running a model: the action "run" and the model — both must be granted when named. */
export const runNeeds = (model: Model) => [["run"], modelRightNames(model)];

/** The caller's rights in the module, without a log line (for listing). */
export function callerAccess(caller: Caller): Check | null {
  if (caller.kind === "console") return null; // the console sees everything
  const d = decision("functions", caller.groups);
  return { allowed: d.allowed, reason: d.reason, rights: d.rights };
}

/** May this caller run this model from the chat? */
export function modelVisible(model: Model, caller: Caller, access: Check | null): boolean {
  if (!model.enabled || !model.executors.chat.enabled || !model.keyword) return false;
  if (access && !allows(access, ...runNeeds(model))) return false;
  if (caller.kind === "console" || model.groups.length === 0) return true;
  return model.groups.some((g) => caller.groups.includes(g));
}

/** What m5.functions.list() gives a function: the commands its caller may run (no secrets). */
export function commandsFor(caller: Caller) {
  const access = callerAccess(caller);
  if (access && !access.allowed) return [];
  return functionsStore.models()
    .filter((m) => modelVisible(m, caller, access))
    .sort((a, b) => a.keyword.localeCompare(b.keyword))
    .map((m) => ({
      keyword: m.keyword,
      name: m.name,
      summary: m.summary,
      package: /^([^@]+)@/.exec(m.entry)?.[1] ?? "",
      version: /@([^:]+):/.exec(m.entry)?.[1] ?? "",
      visibility: m.executors.chat.visibility,
      webhook: endpointsOf(m).some((e) => e.type === "webhook" && e.enabled !== false),
      // 5.3: what a reply, a click or a form of its messages reaches.
      events: endpointTypes(m).filter((t) => t !== "execute" && t !== "webhook"),
      api: Boolean(m.executors.api?.enabled),
      inputs: m.inputs.map((i) => ({ name: i.name, type: i.type, label: i.label ?? "", help: i.help ?? "", required: Boolean(i.required), default: i.default ?? null, values: i.values ?? [], pattern: i.pattern ?? "", min: i.min ?? null, max: i.max ?? null })),
      // 6.11: its avatar ("" — by its keyword) and its own guide.
      icon: m.icon ?? "",
      usage: m.usage ?? "",
    }));
}
