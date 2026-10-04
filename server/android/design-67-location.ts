// 6.7 design area: location messages: the map behind an icon, navigation and ride apps; the hold area beside a bubble (6.7)
// One area of the 6.7 design (design-67.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
// The hold area: message.in / message.out get a "msgHold" slot beside the
// bubble (parts/HoldArea.java) — the free part of the row next to a
// hold-to-read ("tap") bubble reveals it while held, so a finger does not
// cover a short text. The operator tunes it here: "if" (by default only a
// tap message), weight (the free space) and style.maxWidth (dp, the cap).
//
// The place sheet (parts/PlaceSheet.java, the pin's msg.mapPreview and a
// tap on a bubble's map): the map, the coordinates, Navigate / Ride / Copy
// — the same three as the web's place window. Only its texts live here; the
// apps and their links are location/GeoLinks.java (the web: lib/geo-links.ts).

import type { ANode } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });

function find(node: ANode, id: string): ANode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

/** The hold area of a bubble's row: the free space beside it, at most maxWidth dp, only for a hold-to-read message. */
export const holdNode = (): ANode =>
  n("hold", "slot", { name: "Hold beside the bubble", if: "$msg.tap", props: { name: "msgHold" }, style: { weight: 1, self: "stretch", maxWidth: 200 } });

/**
 * message.in: after the bubble (the row's free end); message.out: before it
 * (the bubble keeps to the right edge). A tree that already has a "hold"
 * element, or no row, is left alone.
 */
export function patchHold(screens: Record<string, ANode>): void {
  for (const [id, before] of [["message.in", false], ["message.out", true]] as const) {
    const row = screens[id];
    if (!row || find(row, "hold") || row.el !== "row") continue;
    const kids = row.children ?? [];
    const at = kids.findIndex((c) => c.id === "bubble-wrap" || c.id === "bubble");
    const hold = holdNode();
    if (at < 0) row.children = before ? [hold, ...kids] : [...kids, hold];
    else row.children = [...kids.slice(0, before ? at : at + 1), hold, ...kids.slice(before ? at : at + 1)];
  }
}

export const AREA: DesignArea = {
  slots: [
    { name: "msgHold", label: "Hold area beside a bubble (hold-to-read)", screens: ["message.in", "message.out"] },
  ],
  patch: patchHold,
  strings: {
    cs: {
      "loc.navigate": "Navigovat", "loc.ride": "Odvoz", "loc.copy": "Kopírovat",
      "loc.navigateWith": "Navigovat pomocí", "loc.rideWith": "Odvoz s",
      "loc.inBrowser": "v prohlížeči", "loc.ride.paste": "cíl vložíte ze schránky",
      "loc.copied": "Cíl je ve schránce — vložte ho v aplikaci.",
      "loc.privacy": "Nikam se nic neposílá, dokud neklepnete na aplikaci. Mapa jde přes server M5cet.",
    },
    en: {
      "loc.navigate": "Navigate", "loc.ride": "Ride", "loc.copy": "Copy",
      "loc.navigateWith": "Navigate with", "loc.rideWith": "A ride with",
      "loc.inBrowser": "in the browser", "loc.ride.paste": "paste the destination",
      "loc.copied": "The destination is on the clipboard — paste it in the app.",
      "loc.privacy": "Nothing is sent anywhere until you tap an app. The map comes through the M5cet server.",
    },
    de: {
      "loc.navigate": "Navigieren", "loc.ride": "Fahrt", "loc.copy": "Kopieren",
      "loc.navigateWith": "Navigieren mit", "loc.rideWith": "Fahrt mit",
      "loc.inBrowser": "im Browser", "loc.ride.paste": "Ziel einfügen",
      "loc.copied": "Das Ziel ist in der Zwischenablage — fügen Sie es in der App ein.",
      "loc.privacy": "Nichts wird gesendet, bis Sie auf eine App tippen. Die Karte kommt über den M5cet-Server.",
    },
  },
};
