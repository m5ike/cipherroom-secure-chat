// Modules, user groups and access (4.0, reworked in 5.2). PURE module (no
// DOM, no Node): the server validates and enforces it, the console edits it,
// the client hides what a user may not use.
//
// A module is an optional part of the portal — calls, files, AI & speech,
// telephony & SIP, and (5.2) the console's tools: Functions, the Layout and
// Menu builders. The operator switches each one on or off and decides who
// may use it:
//
//   default access   allow | deny — everyone the rules below do not decide
//   group access     allow | deny — what being in an access group means
//   access groups    the groups (lists of users) the group access applies to
//   main group       mod-<module>: its members always get the whole module
//   grants           per group, parts of a module: "model:dns*", "-provider:openai",
//                    "number:+420*" … ("-" takes away); wildcards * and ?
//
// Groups:
//
//   guest            not signed in (Light · P2P only)
//   user             signed in with a passkey
//   admin, admin-owner, admin-operator, admin-auditor
//                    the console's administrators (by role)
//   <own>            groups the operator makes; members are usernames, or
//                    admin:<name> for a console administrator
//
// A user is in "guest" or "user", and in every own group that lists their
// username. Members never leave the server: the public configuration lists
// the groups without them, and an account learns its own groups from
// /api/account/me.

export type RightDef = { right: string; label: string; help?: string };

export type ModuleDef = {
  id: string;
  label: string;
  description: string;
  /** Menu panels (App.tsx › PanelKey) that belong to the module. */
  panels: readonly string[];
  /** A server feature it also needs (/api/modules › features). */
  feature?: string;
  /** 5.2: the server switch (plugins.json / ENABLE_*) that turns the service on. */
  switch?: "ai" | "speech" | "functions";
  /** 5.2: the console page of the tool (console.js route). */
  console?: string;
  /** 5.2: the parts of the module a grant can give or take away. */
  rights?: readonly RightDef[];
};

const FN_RIGHTS: RightDef[] = [
  { right: "model:*", label: "Models", help: "A model by keyword, id or name: model:whois, model:dns*, model:*check" },
  { right: "package:*", label: "Packages", help: "Every model of a package: package:netkit, package:demo-*" },
  { right: "run", label: "Run from the chat", help: "The “/keyword” commands" },
  { right: "edit", label: "Console: edit", help: "Create and change packages, models, schedules" },
  { right: "publish", label: "Console: publish", help: "Publish package versions" },
  { right: "webhooks", label: "Console: webhooks", help: "The webhook log, replay and debugging" },
];
const AI_RIGHTS: RightDef[] = [
  { right: "provider:*", label: "Providers", help: "A provider by id: provider:openai, provider:local" },
  { right: "model:*", label: "Models", help: "provider/model: model:openai/gpt-5*, model:*/whisper*" },
  { right: "chat", label: "Chat", help: "The assistant" },
  { right: "playground", label: "Console: playground & tests" },
  { right: "settings", label: "Console: providers, keys, limits" },
];
const SPEECH_RIGHTS: RightDef[] = [
  { right: "provider:*", label: "Providers", help: "provider:local (offline), provider:openai…" },
  { right: "model:*", label: "Models", help: "model:local/piper-cs*, model:*/whisper*" },
  { right: "tts", label: "Text to speech" },
  { right: "stt", label: "Speech to text" },
];
const TEL_RIGHTS: RightDef[] = [
  { right: "call", label: "Place calls" },
  { right: "sms", label: "Send SMS" },
  // 6.0: m5.telephony in functions.
  { right: "message", label: "WhatsApp · Viber · Messenger", help: "Functions: m5.telephony.whatsapp / viber / messenger" },
  { right: "lookup", label: "Number lookup", help: "Functions: m5.telephony.lookup (the providers' paid data)" },
  { right: "hlr", label: "HLR", help: "Functions: m5.telephony.hlr — reachability, roaming" },
  { right: "did", label: "Temporary numbers", help: "Functions: m5.telephony.did — a phone number and code that connect a caller to a room member" },
  { right: "number:*", label: "Numbers", help: "Where to: number:+420*, -number:+1900*" },
  { right: "settings", label: "Console: providers, SIP trunks, webhooks" },
  { right: "test", label: "Console: test calls and SMS" },
];
const ANDROID_RIGHTS: RightDef[] = [
  { right: "devices", label: "Devices", help: "Rename, block, retire, delete enrolled devices" },
  { right: "push", label: "Control messages", help: "Ping, status, flash, push, update, lock" },
  { right: "wipe", label: "Remote wipe", help: "Erase a device's data" },
  { right: "builds", label: "Design and builds", help: "Edit the Android design, create builds" },
  { right: "releases", label: "APK releases", help: "Upload and edit releases" },
  { right: "publish", label: "Publish", help: "Publish builds and releases to devices" },
  { right: "settings", label: "Settings", help: "Enrolment, codes, lock policy, FCM" },
];
const BUILDER_RIGHTS: RightDef[] = [
  { right: "edit", label: "Edit" },
  { right: "publish", label: "Publish / save for everyone" },
  { right: "history", label: "History and restore" },
];

/** The rights that name an action (no "kind:"): run, edit, chat, sms… — the rest name items. */
export const ACTION_RIGHTS: ReadonlySet<string> = new Set([...FN_RIGHTS, ...AI_RIGHTS, ...SPEECH_RIGHTS, ...TEL_RIGHTS, ...BUILDER_RIGHTS, ...ANDROID_RIGHTS].map((r) => r.right).filter((r) => !r.includes(":")));

export const MODULE_CATALOG: readonly ModuleDef[] = [
  { id: "audio", label: "Audio calls", description: "Voice over WebRTC between the people in a room.", panels: ["audio"] },
  { id: "video", label: "Video calls", description: "Camera over WebRTC.", panels: ["video"] },
  { id: "files", label: "Files", description: "Encrypted file transfer (P2P, relay as a fallback).", panels: ["files"] },
  { id: "location", label: "Location", description: "Sharing the device's position.", panels: ["location"] },
  { id: "speech", label: "Speech", description: "Text to speech, speech to text, revoice; the server's voices and transcription.", panels: ["speech"], switch: "speech", rights: SPEECH_RIGHTS },
  { id: "ai", label: "AI & speech", description: "The assistant and the server's AI providers (console: AI & speech).", panels: ["ai"], feature: "ai", switch: "ai", console: "plugins", rights: AI_RIGHTS },
  { id: "functions", label: "Functions", description: "“/keyword” commands, webhooks, the API; the console's packages, models, builder.", panels: [], switch: "functions", console: "functions", rights: FN_RIGHTS },
  { id: "telephony", label: "Telephony & SIP", description: "Calls and SMS through the operator's provider; SIP trunks (console).", panels: ["phone"], feature: "telephony", console: "telephony", rights: TEL_RIGHTS },
  { id: "layout", label: "Layout builder", description: "The console's GUI designer (the app keeps what is published).", panels: [], console: "layout", rights: BUILDER_RIGHTS },
  { id: "android", label: "Android", description: "The Android app: enrolled devices, control messages, the design, builds, APK releases, the lock policy (console: Android).", panels: [], console: "android", rights: ANDROID_RIGHTS },
  { id: "menu", label: "Menu builder", description: "The console's menu designer (the app keeps what is published).", panels: [], console: "menu", rights: BUILDER_RIGHTS },
  { id: "nfc", label: "NFC", description: "Encrypted configurations on NFC tags (Android Chrome).", panels: ["nfc"] },
  { id: "rooms", label: "Several rooms", description: "Keep several rooms connected at once: the room bar (unread and people counts, switching) and the Room window's checkboxes.", panels: [] },
  { id: "invites", label: "Invitations", description: "Share a room or a saved connection with a link and a code.", panels: [] },
  { id: "connections", label: "Saved connections", description: "Rooms saved in the account (Server-enhanced).", panels: ["connections"] },
  { id: "notifications", label: "Notifications", description: "Local notifications and web push.", panels: ["notifications"] },
  { id: "analytics", label: "Analytics", description: "The analytics consent screen.", panels: ["analytics"] },
  { id: "appearance", label: "Appearance", description: "Templates, fonts, colours.", panels: ["appearance"] },
  { id: "editMode", label: "Edit Mode", description: "The in-page style editor.", panels: [] },
];

export const MODULE_IDS: readonly string[] = MODULE_CATALOG.map((m) => m.id);
export const MODULE_BY_ID: Readonly<Record<string, ModuleDef>> = Object.fromEntries(MODULE_CATALOG.map((m) => [m.id, m]));

/** The modules that are tools with parts (rights): each has a main group, mod-<id>. */
export const TOOL_MODULES: readonly string[] = MODULE_CATALOG.filter((m) => m.rights).map((m) => m.id);
export const mainGroupOf = (moduleId: string) => `mod-${moduleId.toLowerCase()}`;

export const BUILTIN_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "guest", label: "Guests (not signed in)" },
  { id: "user", label: "Signed-in users" },
];
/** 5.2: the console's administrators, by role. */
export const CONSOLE_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "admin", label: "Console administrators" },
  { id: "admin-owner", label: "Console owners" },
  { id: "admin-operator", label: "Console operators" },
  { id: "admin-auditor", label: "Console auditors" },
];

export type Access = "allow" | "deny";
export type Grant = { group: string; rights: string[] };
export type ModuleRule = {
  enabled: boolean;
  /** The access groups (4.0: "the groups that may use it"). */
  groups: string[];
  defaultAccess: Access;
  groupAccess: Access;
  grants: Grant[];
  /** What is written to the access log: every decision, refusals only, nothing. */
  log: "all" | "deny" | "off";
};
export type ModulesPolicy = Record<string, ModuleRule>;
export type GroupDef = { id: string; label: string; members: string[] };

export const GROUP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const MEMBER_RE = /^(admin:[a-z0-9][a-z0-9._-]{1,31}|[A-Za-z0-9_-]{3,64})$/;
export const RIGHT_RE = /^-?[A-Za-z0-9*?._:@/+#=-]{1,120}$/;
export const MODULE_LIMITS = { groups: 80, members: 5000, grants: 50, rights: 60 } as const;

// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

const RESERVED = new Set([...BUILTIN_GROUPS, ...CONSOLE_GROUPS].map((g) => g.id));

export function sanitizeGroups(raw: unknown): GroupDef[] {
  const out: GroupDef[] = [];
  const seen = new Set(RESERVED);
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MODULE_LIMITS.groups) break;
    const g = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = text(g.id, 32).toLowerCase();
    if (!GROUP_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const members = Array.isArray(g.members) ? [...new Set(g.members.map((m) => text(m, 70)).filter((m) => MEMBER_RE.test(m)))].slice(0, MODULE_LIMITS.members) : [];
    out.push({ id, label: text(g.label, 60) || id, members });
  }
  return out;
}

const access = (v: unknown, dflt: Access): Access => (v === "allow" || v === "deny" ? v : dflt);

export function sanitizeModules(raw: unknown, groups: GroupDef[]): ModulesPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const known = new Set([...RESERVED, ...groups.map((g) => g.id)]);
  const out: ModulesPolicy = {};
  for (const id of MODULE_IDS) {
    const rule = (r[id] && typeof r[id] === "object" ? r[id] : null) as Record<string, unknown> | null;
    if (!rule) continue;
    const allowed = Array.isArray(rule.groups) ? [...new Set(rule.groups.filter((g): g is string => typeof g === "string" && known.has(g)))] : [];
    const grants: Grant[] = [];
    for (const g of Array.isArray(rule.grants) ? rule.grants : []) {
      if (grants.length >= MODULE_LIMITS.grants) break;
      const e = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
      const group = text(e.group, 32);
      if (!known.has(group)) continue;
      const rights = Array.isArray(e.rights) ? [...new Set(e.rights.map((x) => text(x, 120)).filter((x) => RIGHT_RE.test(x)))].slice(0, MODULE_LIMITS.rights) : [];
      grants.push({ group, rights });
    }
    out[id] = {
      enabled: rule.enabled !== false,
      groups: allowed,
      // 4.0 rules had only groups: listed → only them, none → everyone.
      defaultAccess: access(rule.defaultAccess, allowed.length ? "deny" : "allow"),
      groupAccess: access(rule.groupAccess, "allow"),
      grants,
      log: rule.log === "deny" || rule.log === "off" ? rule.log : "all",
    };
  }
  return out;
}

/** The groups a user is in: "guest" when signed out, else "user" and their own. */
export function groupsFor(groups: GroupDef[], username: string | null | undefined): string[] {
  if (!username) return ["guest"];
  return ["user", ...groups.filter((g) => g.members.includes(username)).map((g) => g.id)];
}

/** The groups of a console administrator: admin, admin-<role> and every group listing admin:<name>. */
export function adminGroupsFor(groups: GroupDef[], name: string, role: string): string[] {
  const member = `admin:${name}`;
  return ["admin", `admin-${role}`, ...groups.filter((g) => g.members.includes(member)).map((g) => g.id)];
}

/* ------------------------------------------------------------- rights */

/**
 * Compiled rights. `kinds` — the item kinds a positive pattern names
 * (model, package, provider, number); `actions` — whether one names an action;
 * `bare` — whether one names an item without a kind ("dns*", "*check").
 */
export type Rights = { all: boolean; allow: RegExp[]; deny: RegExp[]; list: string[]; kinds: ReadonlySet<string>; actions: boolean; bare: boolean };

const globCache = new Map<string, RegExp>();
function glob(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    if (globCache.size > 2000) globCache.clear();
    globCache.set(pattern, re);
  }
  return re;
}

/** "model:dns*", "-provider:openai", "*" → matchers. */
export function compileRights(list: readonly string[]): Rights {
  const allow: RegExp[] = [], deny: RegExp[] = [];
  const kinds = new Set<string>();
  let all = false, actions = false, bare = false;
  for (const raw of list) {
    const neg = raw.startsWith("-");
    const p = neg ? raw.slice(1) : raw;
    if (!p) continue;
    if (!neg) {
      if (p === "*") all = true;
      else if (p.includes(":")) kinds.add(p.slice(0, p.indexOf(":")).toLowerCase());
      else if (ACTION_RIGHTS.has(p.toLowerCase())) actions = true;
      else bare = true;
    }
    (neg ? deny : allow).push(glob(p));
  }
  return { all, allow, deny, list: [...list], kinds, actions, bare };
}

/** A pattern without "kind:" also matches the value of "kind:value". */
const hits = (res: RegExp[], candidate: string) => {
  const value = candidate.includes(":") ? candidate.slice(candidate.indexOf(":") + 1) : null;
  return res.some((re) => re.test(candidate) || (value !== null && !re.source.includes(":") && re.test(value)));
};

/**
 * May the holder of `rights` do something described by `dims` — each one
 * aspect of it, as a list of its names: the action (["run"], or ["edit",
 * "publish"] when either does) and the item (["model:dns", "package:netkit"],
 * ["provider:openai", "model:openai/gpt-5"], ["number:+420…"])?
 * A "-" hit on any name refuses. An aspect the rights name (an action word,
 * or the item's kinds, or items without a kind) must match — so ["chat",
 * "provider:local"] is chat with the local provider only; an aspect they do
 * not name is free — but they must name at least one ("*" names everything).
 */
export function permits(rights: Rights, ...dims: Array<string | readonly string[]>): boolean {
  const list = dims.map((d) => (typeof d === "string" ? [d] : d)).filter((d) => d.length > 0);
  if (list.some((d) => d.some((n) => hits(rights.deny, n)))) return false;
  if (rights.all) return true;
  let named = false;
  for (const d of list) {
    const action = d.every((n) => !n.includes(":"));
    const restricted = action ? rights.actions : rights.bare || d.some((n) => rights.kinds.has(n.slice(0, n.indexOf(":")).toLowerCase()));
    if (!restricted) continue;
    named = true;
    if (!d.some((n) => hits(rights.allow, n))) return false;
  }
  return named;
}

/** Any of `candidates` (one aspect; see permits for several). A "-" match wins. */
export function can(rights: Rights, ...candidates: string[]): boolean {
  if (candidates.some((c) => hits(rights.deny, c))) return false;
  return rights.all || candidates.some((c) => hits(rights.allow, c));
}

/** Whether a "-" pattern takes any of `candidates` away. */
export function denies(rights: Rights, ...candidates: string[]): boolean {
  return candidates.some((c) => hits(rights.deny, c));
}

/** Whether a "kind:" is restricted at all (e.g. no number:… → any number). */
export function restricts(rights: Rights, kind: string): boolean {
  return !rights.all && rights.list.some((r) => r.replace(/^-/, "").startsWith(`${kind}:`) && !r.startsWith("-"));
}

/* ------------------------------------------------------------- decisions */

export type Decision = {
  allowed: boolean;
  /** off · main-group · group-allow · group-deny · default-allow · default-deny · grant · unlisted */
  reason: string;
  rights: Rights;
};

const ALL = compileRights(["*"]);
const NONE = compileRights([]);

/**
 * Who may use a module, and which parts: off → no; in the main group → all;
 * in an access group → group access; else default access. Grants of the
 * user's groups then add ("model:dns*") or take away ("-model:admin*") parts;
 * a grant alone lets someone in with just those parts.
 */
export function decide(policy: Record<string, Partial<ModuleRule> | undefined>, id: string, userGroups: readonly string[]): Decision {
  const rule = policy[id];
  if (!rule) return { allowed: true, reason: "unlisted", rights: ALL };
  if (rule.enabled === false) return { allowed: false, reason: "off", rights: NONE };
  if (MODULE_BY_ID[id]?.rights && userGroups.includes(mainGroupOf(id))) return { allowed: true, reason: "main-group", rights: ALL };
  // A 4.0 rule (enabled + groups) reads as: listed groups only, or everyone.
  const groups = rule.groups ?? [];
  const inAccess = groups.some((g) => userGroups.includes(g));
  const base = inAccess ? (rule.groupAccess ?? "allow") === "allow" : (rule.defaultAccess ?? (groups.length ? "deny" : "allow")) === "allow";
  const list = base ? ["*"] : [];
  let granted = false;
  for (const g of rule.grants ?? []) {
    if (!userGroups.includes(g.group)) continue;
    list.push(...g.rights);
    if (g.rights.some((x) => !x.startsWith("-"))) granted = true;
  }
  const reason = base ? (inAccess ? "group-allow" : "default-allow") : granted ? "grant" : inAccess ? "group-deny" : "default-deny";
  return { allowed: base || granted, reason, rights: compileRights(list) };
}

/** May someone in `userGroups` use the module? Unlisted modules are on for all. */
export function moduleAllowed(policy: Record<string, Partial<ModuleRule> | undefined>, id: string, userGroups: readonly string[]): boolean {
  return decide(policy, id, userGroups).allowed;
}

/** The module a menu panel belongs to ("" = none: always shown). */
export function moduleOfPanel(panel: string): string {
  return MODULE_CATALOG.find((m) => m.panels.includes(panel))?.id ?? "";
}

type RulesAndGroups = { modules: Record<string, Partial<ModuleRule> | undefined>; groups: readonly GroupDef[] };

/**
 * 5.2: who may change the access rules themselves. Module rules and groups
 * decide the console's own tools, so an operator could otherwise give
 * themselves any of them: changing a tool module's rule or the members of a
 * group with console members (admin:…, before or after) takes the owner.
 * The app's own modules and the app users' groups stay the operators'.
 */
export function ruleChangeNeedsOwner(prev: RulesAndGroups, next: Partial<RulesAndGroups>): string | null {
  if (next.modules) {
    for (const m of Object.values(MODULE_BY_ID)) {
      if (!m.rights) continue; // an app module
      if (JSON.stringify(prev.modules[m.id] ?? null) !== JSON.stringify(next.modules[m.id] ?? null)) return `the ${m.label} module's access`;
    }
  }
  if (next.groups) {
    const before = new Map(prev.groups.map((g) => [g.id, g]));
    const after = new Map(next.groups.map((g) => [g.id, g]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(id), b = after.get(id);
      if (JSON.stringify(a?.members ?? null) === JSON.stringify(b?.members ?? null)) continue;
      if ([...(a?.members ?? []), ...(b?.members ?? [])].some((x) => x.startsWith("admin:"))) return `the group ${id} (console members)`;
    }
  }
  return null;
}

/** The main groups the tool modules need, for the ones missing from `groups`. */
export function missingMainGroups(groups: readonly GroupDef[]): GroupDef[] {
  const have = new Set(groups.map((g) => g.id));
  return TOOL_MODULES.filter((id) => !have.has(mainGroupOf(id))).map((id) => ({ id: mainGroupOf(id), label: `${MODULE_BY_ID[id].label} — all rights`, members: [] }));
}
