// Writes client/src/lib/menu-icons-data.ts: the icons the menu builder
// offers, as lucide's own node data (name → SVG children). The app renders
// them with lucide's <Icon>, the console draws the same SVG — one catalog,
// the same pictures. Run after upgrading lucide-react:
//
//   node script/gen-menu-icons.mjs
//
// Icons: lucide (https://lucide.dev), ISC license.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ICONS = [
  // what the default menu uses
  "menu", "x", "check", "shield-check", "key-round", "shield", "users", "radio", "plug", "mic", "video", "file-text",
  "map-pin", "volume-2", "sparkles", "phone", "nfc", "palette", "settings", "bell", "eye", "activity", "user", "log-out",
  "pencil-ruler",
  // more to choose from
  "lock", "lock-open", "globe", "message-circle", "message-square", "messages-square", "heart", "star", "house", "info",
  "circle-question-mark", "book-open", "calendar", "clock", "wifi", "server", "cloud", "database", "zap", "sun", "moon", "languages",
  "share-2", "link", "external-link", "download", "upload", "trash", "refresh-cw", "search", "sliders-horizontal",
  "layout-grid", "list", "camera", "image", "headphones", "music", "gift", "rocket", "flag", "bookmark", "tag", "mail",
  "send", "hash", "at-sign", "terminal", "code", "cpu", "gauge", "wrench", "briefcase", "life-buoy", "circle-user-round",
  "fingerprint-pattern", "qr-code", "smartphone", "monitor", "laptop", "power", "plus", "minus", "chevron-right", "arrow-right",
  "badge-check", "bot", "brush", "compass", "crown", "eye-off", "flame", "folder", "keyboard", "landmark", "layers",
  "lightbulb", "map", "megaphone", "newspaper", "package", "paperclip", "pen-line", "printer", "puzzle", "scale",
  "shopping-cart", "square-terminal", "store", "thumbs-up", "ticket", "trophy", "truck", "umbrella", "wallet", "webhook",
  "circle-alert", "triangle-alert", "circle-check", "circle-x", "user-plus", "user-cog", "users-round", "graduation-cap",
  // 4.0.5: what the Layout builder's layouts use (messages, app bar, chat, composer, recipients)
  "lock", "timer", "scroll-text", "eye-off", "users", "paperclip", "info", "reply", "forward", "corner-up-left", "check",
  "check-check", "clock", "send-horizontal", "wifi", "wifi-off", "plug", "maximize-2", "minimize-2", "log-out", "copy",
  "radio", "smile", "image", "minus", "grip-horizontal", "lock-open", "settings-2", "moon", "x",
  // …and more to design with
  "arrow-left", "arrow-up", "arrow-down", "chevron-left", "chevron-up", "chevron-down", "circle", "square", "circle-dot",
  "bell-off", "calendar-days", "file", "file-image", "file-audio", "file-video", "folder-open", "mail-open",
  "message-circle-more", "mic-off", "video-off", "volume-x", "phone-off", "share", "pencil", "save", "eye", "send",
  "reply-all", "sparkle", "hand", "smile-plus", "sticker", "quote", "pin", "pin-off", "map-pinned", "timer-reset",
  "hourglass", "shield-alert", "shield-off", "key", "user-round", "user-check", "user-x", "signal", "signal-high",
  "signal-low", "signal-zero", "battery", "zap-off", "loader", "loader-circle", "refresh-ccw", "rotate-ccw", "undo-2",
  "redo-2", "panel-left", "panel-right", "layout-dashboard", "columns-2", "rows-2", "grip-vertical", "move", "ellipsis",
  "ellipsis-vertical", "circle-plus", "circle-minus",
];

// 4.13: every icon the app's components draw — the Layout builder's layouts
// of the Room window, panels and dialogs use them (read from their imports,
// by lucide's own name: Loader2 → loader-circle, Trash2 → trash).
const lucide = await import("lucide-react");
const toKebab = (pascal) => pascal.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([a-zA-Z])([0-9])/g, "$1-$2").toLowerCase();
const componentsDir = join(import.meta.dirname, "..", "client", "src", "components");
const sources = [...readdirSync(componentsDir).filter((f) => f.endsWith(".tsx")).map((f) => join(componentsDir, f)), join(import.meta.dirname, "..", "client", "src", "App.tsx")];
for (const file of sources) {
  for (const m of readFileSync(file, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) {
    for (const spec of m[1].split(",")) {
      const name = spec.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "");
      const display = lucide[name]?.displayName;
      if (display) ICONS.push(toKebab(display));
    }
  }
}

const dir = join(import.meta.dirname, "..", "node_modules", "lucide-react", "dist", "esm", "icons");

// …and every icon the app's own layouts draw (4.13: the components that became
// layouts no longer import them): read from the default trees themselves (an
// icon's name, or the names between the tags of a template like "{if $on}moon{else}sun{/if}"),
// and the icons components hand their layouts as data (a const …ICON(S) map,
// or a quoted name on a line that sets an `icon:`).
const isIcon = (name) => existsSync(join(dir, `${name}.mjs`));
const treeIcons = JSON.parse(execFileSync(join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"), ["-e", `
  import { DEFAULT_LAYOUTS } from "./client/src/lib/layouts";
  const names = new Set();
  const walk = (n) => { if (n.el === "icon" && typeof n.props?.icon === "string") names.add(n.props.icon); (n.children ?? []).forEach(walk); };
  Object.values(DEFAULT_LAYOUTS).forEach(walk);
  console.log(JSON.stringify([...names]));
`], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }));
for (const raw of treeIcons) {
  for (const name of raw.replace(/\{[^}]*\}/g, " ").trim().split(/\s+/).filter(Boolean)) if (isIcon(name)) ICONS.push(name);
}
for (const file of sources) {
  const src = readFileSync(file, "utf8");
  const maps = [...src.matchAll(/const\s+\w*ICONS?\b[^=]*=\s*\{([\s\S]*?)\};/g)].map((m) => m[1]);
  const lines = src.split("\n").filter((l) => /\bicon:/.test(l));
  for (const text of [...maps, ...lines]) for (const m of text.matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)*)"/g)) if (isIcon(m[1])) ICONS.push(m[1]);
}

const out = {};
const seen = new Set();
const aliases = {};
const missing = [];
for (const name of ICONS) {
  if (seen.has(name)) continue;
  seen.add(name);
  let file = join(dir, `${name}.mjs`);
  if (!existsSync(file)) { missing.push(name); continue; }
  let src = readFileSync(file, "utf8");
  // An old name re-exports the icon it was renamed to (smile → face-slightly-smiling):
  // take that one, under its own name (what the named component draws).
  const reexport = src.match(/export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/);
  if (reexport) {
    if (seen.has(reexport[1])) continue;
    seen.add(reexport[1]);
    file = join(dir, `${reexport[1]}.mjs`);
    src = readFileSync(file, "utf8");
  }
  const match = src.match(/const __iconData = (\{[\s\S]*?\n\});/);
  if (!match) { missing.push(name); continue; }
  // The module's literal is plain JSON-like data (strings, numbers, arrays).
  const data = Function(`"use strict"; return (${match[1]});`)();
  out[data.name ?? name] = data.node;
  // lucide adds a class per alias (lucide-sparkles lucide-stars): the same here.
  const names = (data.aliases ?? []).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean);
  if (names.length) aliases[data.name ?? name] = names;
}
if (missing.length) console.warn(`not in this lucide-react: ${missing.join(", ")}`);

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "node_modules", "lucide-react", "package.json"), "utf8"));
const body = `// GENERATED by script/gen-menu-icons.mjs from lucide-react ${pkg.version} — do not edit.
// Icons: lucide (https://lucide.dev), ISC license.
//
// The icons the menu builder offers: name → the SVG's children, exactly as
// lucide ships them. PURE data, shared by the app (lucide's <Icon>) and the
// operator console (the same SVG drawn by hand).

export type IconChild = [string, Record<string, string | number>];

export const MENU_ICONS: Record<string, IconChild[]> = ${JSON.stringify(out, null, 0).replace(/\],"/g, '],\n  "').replace(/^\{/, "{\n  ").replace(/\}$/, ",\n}")};

export const MENU_ICON_NAMES: readonly string[] = Object.keys(MENU_ICONS);

/** lucide's other names of an icon (each becomes a class, as in lucide). */
export const MENU_ICON_ALIASES: Record<string, string[]> = ${JSON.stringify(aliases)};
`;
writeFileSync(join(import.meta.dirname, "..", "client", "src", "lib", "menu-icons-data.ts"), body);
console.log(`wrote ${Object.keys(out).length} icons`);
