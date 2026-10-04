// 6.7 design area: presence, last seen, away / far away status (6.7)
// One area of the 6.7 design (design-67.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
// Each person of the People widget (users.item) and their detail
// (users.person) gets a status dot — online (green), away (yellow), far
// away (orange) — and "last seen …", as the web's recipients widget shows
// them (client/src/lib/presence.ts; the app's contacts/LastSeen.java gives
// $user.presence, .presenceColor, .presenceLabel, .seenText). A member
// whose connection went without a goodbye stays listed, as away.

import type { ANode } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });

function find(node: ANode, id: string): ANode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

/** Puts `node` after the child `after` of `parent` (at the end without it); nothing when it is there already. */
function insertAfter(parent: ANode, after: string, node: ANode): void {
  const kids = parent.children ?? [];
  if (kids.some((c) => c.id === node.id)) return;
  const at = kids.findIndex((c) => c.id === after);
  parent.children = at < 0 ? [...kids, node] : [...kids.slice(0, at + 1), node, ...kids.slice(at + 1)];
}

/** The dot and the words: "● Away · Last seen 12 min ago". */
const seenRow = (id: string, who: string, size: number, textSize: number): ANode => n(id, "row", { if: `${who}.presence && !${who}.me`, style: { gap: 6, align: "center" } }, [
  n(`${id}-dot`, "column", { style: { width: size, height: size, radius: size / 2, bg: `=${who}.presenceColor` } }),
  n(`${id}-text`, "text", { text: `{${who}.presenceLabel} · {${who}.seenText}`, props: { variant: "caption" }, style: { fg: "@muted", lines: 1, size: textSize } }),
]);

const P = "$form.person";

function patch(screens: Record<string, ANode>): void {
  // The People widget's row: under the name and the status line.
  const item = screens["users.item"];
  const who = item ? find(item, "who") : null;
  if (who) insertAfter(who, "sub", seenRow("seen", "$user", 8, 11.5));

  // A person's detail: under the status in the head, and a "Last seen" row among the connection's facts.
  const person = screens["users.person"];
  const head = person ? find(person, "who") : null;
  if (head) insertAfter(head, "state", seenRow("seen", P, 10, 12.5));
  const body = person ? find(person, "body") : null;
  if (body) {
    insertAfter(body, "r-state", n("r-seen", "row", { if: `${P}.presence && !${P}.me`, style: { padding: "5 8", gap: 12, align: "start" } }, [
      n("r-seen-label", "text", { text: "{_'presence.lastSeen'}", props: { variant: "caption" }, style: { fg: "@muted", width: 116 } }),
      n("r-seen-dot", "column", { style: { width: 10, height: 10, radius: 5, bg: `=${P}.presenceColor`, margin: "4 0 0 0" } }),
      n("r-seen-value", "text", { text: `{${P}.seenText}`, style: { weight: 1, size: 13.5 } }),
    ]));
  }
}

export const AREA: DesignArea = {
  patch,
  strings: {
    cs: {
      "presence.online": "Online", "presence.away": "Pryč", "presence.far": "Dlouho pryč",
      "presence.now": "Právě teď v aplikaci", "presence.seen": "Naposledy online {ago}", "presence.seen.unknown": "Kdy byl(a) naposledy online, nevíme",
      "presence.ago.now": "právě teď", "presence.ago.min": "před {n} min", "presence.ago.h": "před {n} h", "presence.ago.d": "před {n} d",
      "presence.lastSeen": "Naposledy online", "presence.wentAway": "je pryč — spojení se přerušilo, v místnosti zůstává",
    },
    en: {
      "presence.online": "Online", "presence.away": "Away", "presence.far": "Far away",
      "presence.now": "In the app right now", "presence.seen": "Last seen {ago}", "presence.seen.unknown": "Not known when last seen",
      "presence.ago.now": "just now", "presence.ago.min": "{n} min ago", "presence.ago.h": "{n} h ago", "presence.ago.d": "{n} d ago",
      "presence.lastSeen": "Last seen", "presence.wentAway": "is away — the connection went, they stay in the room",
    },
    de: {
      "presence.online": "Online", "presence.away": "Abwesend", "presence.far": "Länger abwesend",
      "presence.now": "Gerade in der App", "presence.seen": "Zuletzt online {ago}", "presence.seen.unknown": "Unbekannt, wann zuletzt online",
      "presence.ago.now": "gerade eben", "presence.ago.min": "vor {n} Min.", "presence.ago.h": "vor {n} Std.", "presence.ago.d": "vor {n} T.",
      "presence.lastSeen": "Zuletzt online", "presence.wentAway": "ist abwesend — die Verbindung ist weg, bleibt aber im Raum",
    },
  },
};
