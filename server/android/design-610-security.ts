// 6.10 design area: the texts of the app's security fixes (security analysis,
// chapter 12, G-20 … G-24). No trees, menus or actions — only what the app
// says when it refuses something a design asked for:
//
//   security.refused     an action of the design was refused: its argument
//                        was computed from data where it could leave the
//                        phone (url.open, lib.run, fn.run, profile.public,
//                        a setting's key), it would change a privacy setting,
//                        or its value is outside the setting's rule
//                        (android/…/ui/ActionGuard.java, core/SettingSchema.java)
//   security.urlRefused  url.open with an address the person could not read
//                        in full: over 300 characters, spaces, hidden
//                        characters (bidi, zero-width) — ui/DesignUrls.java
//
// One area of the 6.10 design (design-610.ts gathers them).

import type { DesignArea } from "./design-67";

const T = (cs: string, en: string, de: string) => ({ cs, en, de });

const STR: Record<string, { cs: string; en: string; de: string }> = {
  "security.refused": T(
    "Tuto akci vzhledu aplikace neprovedla: mohla by z telefonu odnést data nebo změnit nastavení soukromí.",
    "The app did not run this action of the design: it could carry data off the phone or change a privacy setting.",
    "Die App hat diese Aktion des Designs nicht ausgeführt: Sie könnte Daten vom Telefon tragen oder eine Datenschutzeinstellung ändern.",
  ),
  "security.urlRefused": T(
    "Tuto adresu aplikace neotevře: je příliš dlouhá nebo obsahuje mezery či skryté znaky.",
    "The app will not open this address: it is too long or contains spaces or hidden characters.",
    "Die App öffnet diese Adresse nicht: Sie ist zu lang oder enthält Leerzeichen oder versteckte Zeichen.",
  ),
};

export const AREA: DesignArea = {
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
};
