// Modules and user groups (4.0). PURE module (no DOM, no Node): the server
// validates and enforces it, the console edits it, the client hides what a
// user may not use.
//
// A module is an optional part of the app — calls, files, AI, telephony…
// The operator switches each one on or off and may give it to some groups
// only. Groups:
//
//   guest   not signed in (Light · P2P only)
//   user    signed in with a passkey
//   <own>   groups the operator makes, with usernames as members
//
// A user is in "guest" or "user", and in every own group that lists their
// username. Members never leave the server: the public configuration lists
// the groups without them, and an account learns its own groups from
// /api/account/me.

export type ModuleDef = {
  id: string;
  label: string;
  description: string;
  /** Menu panels (App.tsx › PanelKey) that belong to the module. */
  panels: readonly string[];
  /** A server feature it also needs (/api/modules › features). */
  feature?: string;
};

export const MODULE_CATALOG: readonly ModuleDef[] = [
  { id: "audio", label: "Audio calls", description: "Voice over WebRTC between the people in a room.", panels: ["audio"] },
  { id: "video", label: "Video calls", description: "Camera over WebRTC.", panels: ["video"] },
  { id: "files", label: "Files", description: "Encrypted file transfer (P2P, relay as a fallback).", panels: ["files"] },
  { id: "location", label: "Location", description: "Sharing the device's position.", panels: ["location"] },
  { id: "speech", label: "Speech", description: "Text to speech, speech to text, revoice.", panels: ["speech"] },
  { id: "ai", label: "AI assistant", description: "The server's AI connector.", panels: ["ai"], feature: "ai" },
  { id: "telephony", label: "Telephony", description: "Calls and SMS through the operator's provider.", panels: ["phone"], feature: "telephony" },
  { id: "nfc", label: "NFC", description: "Encrypted configurations on NFC tags (Android Chrome).", panels: ["nfc"] },
  { id: "invites", label: "Invitations", description: "Share a room or a saved connection with a link and a code.", panels: [] },
  { id: "connections", label: "Saved connections", description: "Rooms saved in the account (Server-enhanced).", panels: ["connections"] },
  { id: "notifications", label: "Notifications", description: "Local notifications and web push.", panels: ["notifications"] },
  { id: "analytics", label: "Analytics", description: "The analytics consent screen.", panels: ["analytics"] },
  { id: "appearance", label: "Appearance", description: "Templates, fonts, colours.", panels: ["appearance"] },
  { id: "editMode", label: "Edit Mode", description: "The in-page style editor.", panels: [] },
];

export const MODULE_IDS: readonly string[] = MODULE_CATALOG.map((m) => m.id);

export const BUILTIN_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "guest", label: "Guests (not signed in)" },
  { id: "user", label: "Signed-in users" },
];

export type ModuleRule = { enabled: boolean; groups: string[] };
export type ModulesPolicy = Record<string, ModuleRule>;
export type GroupDef = { id: string; label: string; members: string[] };

export const GROUP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,64}$/;
export const MODULE_LIMITS = { groups: 50, members: 5000 } as const;

// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

export function sanitizeGroups(raw: unknown): GroupDef[] {
  const out: GroupDef[] = [];
  const seen = new Set(BUILTIN_GROUPS.map((g) => g.id));
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MODULE_LIMITS.groups) break;
    const g = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = text(g.id, 32).toLowerCase();
    if (!GROUP_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const members = Array.isArray(g.members) ? [...new Set(g.members.map((m) => text(m, 64)).filter((m) => USERNAME_RE.test(m)))].slice(0, MODULE_LIMITS.members) : [];
    out.push({ id, label: text(g.label, 60) || id, members });
  }
  return out;
}

export function sanitizeModules(raw: unknown, groups: GroupDef[]): ModulesPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const known = new Set([...BUILTIN_GROUPS.map((g) => g.id), ...groups.map((g) => g.id)]);
  const out: ModulesPolicy = {};
  for (const id of MODULE_IDS) {
    const rule = (r[id] && typeof r[id] === "object" ? r[id] : null) as Record<string, unknown> | null;
    if (!rule) continue;
    const allowed = Array.isArray(rule.groups) ? [...new Set(rule.groups.filter((g): g is string => typeof g === "string" && known.has(g)))] : [];
    out[id] = { enabled: rule.enabled !== false, groups: allowed };
  }
  return out;
}

/** The groups a user is in: "guest" when signed out, else "user" and their own. */
export function groupsFor(groups: GroupDef[], username: string | null | undefined): string[] {
  if (!username) return ["guest"];
  return ["user", ...groups.filter((g) => g.members.includes(username)).map((g) => g.id)];
}

/** May someone in `userGroups` use the module? Unlisted modules are on for all. */
export function moduleAllowed(policy: ModulesPolicy, id: string, userGroups: readonly string[]): boolean {
  const rule = policy[id];
  if (!rule) return true;
  if (!rule.enabled) return false;
  return rule.groups.length === 0 || rule.groups.some((g) => userGroups.includes(g));
}

/** The module a menu panel belongs to ("" = none: always shown). */
export function moduleOfPanel(panel: string): string {
  return MODULE_CATALOG.find((m) => m.panels.includes(panel))?.id ?? "";
}
