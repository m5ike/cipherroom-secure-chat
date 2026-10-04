// 6.7: the strings of one area (presence). cs / en / de; merged into i18n.ts.
// Presence: online / away / far away and "last seen …" of the people in a
// room (lib/presence.ts, lib/presence-book.ts).

type Dict = Record<string, string>;

const cs: Dict = {
  "presence.online": "Online",
  "presence.away": "Pryč",
  "presence.far": "Dlouho pryč",
  "presence.now": "Právě teď v aplikaci",
  "presence.seen": "Naposledy online {ago}",
  "presence.seen.unknown": "Kdy byl(a) naposledy online, nevíme",
  "presence.ago.now": "právě teď",
  "presence.ago.min": "před {n} min",
  "presence.ago.h": "před {n} h",
  "presence.ago.d": "před {n} d",
  "presence.lastSeen": "Naposledy online",
  "presence.state": "Přítomnost",
  "presence.wentAway": "{name} je pryč — spojení se přerušilo, v místnosti zůstává.",
};

const en: Dict = {
  "presence.online": "Online",
  "presence.away": "Away",
  "presence.far": "Far away",
  "presence.now": "In the app right now",
  "presence.seen": "Last seen {ago}",
  "presence.seen.unknown": "Not known when last seen",
  "presence.ago.now": "just now",
  "presence.ago.min": "{n} min ago",
  "presence.ago.h": "{n} h ago",
  "presence.ago.d": "{n} d ago",
  "presence.lastSeen": "Last seen",
  "presence.state": "Presence",
  "presence.wentAway": "{name} is away — the connection went, they stay in the room.",
};

const de: Dict = {
  "presence.online": "Online",
  "presence.away": "Abwesend",
  "presence.far": "Länger abwesend",
  "presence.now": "Gerade in der App",
  "presence.seen": "Zuletzt online {ago}",
  "presence.seen.unknown": "Unbekannt, wann zuletzt online",
  "presence.ago.now": "gerade eben",
  "presence.ago.min": "vor {n} Min.",
  "presence.ago.h": "vor {n} Std.",
  "presence.ago.d": "vor {n} T.",
  "presence.lastSeen": "Zuletzt online",
  "presence.state": "Anwesenheit",
  "presence.wentAway": "{name} ist abwesend — die Verbindung ist weg, bleibt aber im Raum.",
};

export const PRESENCE_I18N = { cs, en, de };
