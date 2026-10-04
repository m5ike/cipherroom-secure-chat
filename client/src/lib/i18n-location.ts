// 6.7: the strings of one area (location). cs / en / de; merged into i18n.ts.
// The place of a message: the chip in the bubble and the place window
// (LocationSheet.tsx) with its navigation and ride apps.

type Dict = Record<string, string>;

const cs: Dict = {
  "msg.place.open": "Ukázat polohu na mapě — navigace, odvoz",
  "msg.place.live": "živě",
  "loc.sheet.mine": "Vaše poloha",
  "loc.actions": "Co s polohou",
  "loc.navigate": "Navigovat",
  "loc.ride": "Odvoz",
  "loc.copy": "Kopírovat",
  "loc.copiedShort": "Zkopírováno",
  "loc.copied": "Cíl je ve schránce — vložte ho v aplikaci.",
  "loc.geo": "Mapová aplikace v telefonu",
  "loc.ride.paste": "cíl vložíte ze schránky",
  "loc.privacy": "Nikam se nic neposílá, dokud neklepnete na odkaz. Mapa jde přes tento server.",
};

const en: Dict = {
  "msg.place.open": "Show the position on a map — navigation, a ride",
  "msg.place.live": "live",
  "loc.sheet.mine": "Your position",
  "loc.actions": "What to do with the position",
  "loc.navigate": "Navigate",
  "loc.ride": "Ride",
  "loc.copy": "Copy",
  "loc.copiedShort": "Copied",
  "loc.copied": "The destination is on the clipboard — paste it in the app.",
  "loc.geo": "A map app on this phone",
  "loc.ride.paste": "paste the destination",
  "loc.privacy": "Nothing is sent anywhere until you tap a link. The map comes through this server.",
};

const de: Dict = {
  "msg.place.open": "Standort auf der Karte zeigen — Navigation, Fahrt",
  "msg.place.live": "live",
  "loc.sheet.mine": "Ihr Standort",
  "loc.actions": "Was mit dem Standort tun",
  "loc.navigate": "Navigieren",
  "loc.ride": "Fahrt",
  "loc.copy": "Kopieren",
  "loc.copiedShort": "Kopiert",
  "loc.copied": "Das Ziel ist in der Zwischenablage — fügen Sie es in der App ein.",
  "loc.geo": "Eine Karten-App auf diesem Telefon",
  "loc.ride.paste": "Ziel einfügen",
  "loc.privacy": "Nichts wird gesendet, bis Sie auf einen Link tippen. Die Karte kommt über diesen Server.",
};

export const LOCATION_I18N = { cs, en, de };
