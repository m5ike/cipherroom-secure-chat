// 6.12 design area: the Android app's security fixes that do not depend on
// protocol 4 (docs/security-analysis.md, F-16, F-22, G-14, G-20, G-22). No new
// actions and no new elements — two rows in two settings screens (switches
// bound to settings, an info line) and the texts the app says itself:
//
//   settings.security   "Duress PIN" (security.duress — the app asks for the
//                       current PIN and the duress PIN when it is switched on,
//                       ui/parts/Parts.duressChanged; security/Duress), under
//                       "Lock" a hint (a lock forgets the data key, the rooms
//                       keep receiving into the lock inbox — security/AppLock,
//                       M5.forgetSecrets, chat/LockedRooms) and "Disconnect the
//                       rooms when locked" (security.lockDisconnect, off — the
//                       strict mode, said honestly), and "PIN key":
//                       where the PIN's Keystore key lives ($security.pinKeyLabel —
//                       StrongBox, the TEE, the older scheme, software only;
//                       security/Keystore.ensurePinKey, Vault)
//   settings.notify     "Hide on the lock screen" (notify.lockScreenHide —
//                       VISIBILITY_SECRET, telecom/LockScreen)
//   texts               the speech consent of voice.engine = server
//                       (voice/ServerVoiceConsent, ui/parts/ComposerVoice), the
//                       confirmation of a computed copy / share (ui/DesignShare),
//                       the operator of a server notice (core/Names.operator)
//
// One area of the 6.12 design (design-612.ts gathers them).

import type { ANode } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });

const T = (cs: string, en: string, de: string) => ({ cs, en, de });

const STR: Record<string, { cs: string; en: string; de: string }> = {
  // F-16: Settings › Security
  "set.security.duress": T("Nouzový PIN", "Duress PIN", "Notfall-PIN"),
  "set.security.duressHint": T(
    "Zadaný na zamčené obrazovce aplikaci smaže a otevře ji prázdnou. Nastavíte ho současným PINem.",
    "Typed on the lock screen, it erases the app and opens it empty. You set it with your current PIN.",
    "Auf dem Sperrbildschirm eingegeben, löscht sie die App und öffnet sie leer. Du legst sie mit deiner aktuellen PIN fest.",
  ),
  "set.security.duress.about": T(
    "Kdo na zamčené obrazovce zadá nouzový PIN, aplikaci tím smaže — místnosti, zprávy i klíče — a uvidí ji prázdnou. Server se o smazání dozví. Nouzový PIN se musí lišit od PINu pro odemčení.",
    "Whoever types the duress PIN on the lock screen erases the app with it — rooms, messages and keys — and sees it empty. The server learns of the erasure. The duress PIN must differ from the unlock PIN.",
    "Wer auf dem Sperrbildschirm die Notfall-PIN eingibt, löscht damit die App — Räume, Nachrichten und Schlüssel — und sieht sie leer. Der Server erfährt von der Löschung. Die Notfall-PIN muss sich von der Entsperr-PIN unterscheiden.",
  ),
  "set.security.duress.new": T("Nový nouzový PIN", "New duress PIN", "Neue Notfall-PIN"),
  "set.security.duress.same": T(
    "Nouzový PIN nesmí být stejný jako PIN pro odemčení.",
    "The duress PIN must not be the unlock PIN.",
    "Die Notfall-PIN darf nicht die Entsperr-PIN sein.",
  ),
  "set.security.duress.length": T("Nouzový PIN musí mít {n} číslic.", "The duress PIN must have {n} digits.", "Die Notfall-PIN muss {n} Ziffern haben."),
  "set.security.lockHint": T(
    "Zamčená aplikace nedrží v paměti klíč k datům ani historii. Otevřené místnosti zůstanou připojené: co mezitím přijde, se uloží zašifrovaně, otevřít to jde až PINem, a po odemčení se to doplní do historie.",
    "A locked app keeps neither the data key nor the history in memory. The open rooms stay connected: what arrives meanwhile is stored encrypted, opened only with your PIN, and added to the history after the unlock.",
    "Eine gesperrte App behält weder den Datenschlüssel noch den Verlauf im Speicher. Die offenen Räume bleiben verbunden: Was inzwischen ankommt, wird verschlüsselt gespeichert, lässt sich nur mit deiner PIN öffnen und kommt nach dem Entsperren in den Verlauf.",
  ),
  "set.security.lockDisconnect": T("Při zamčení odpojit místnosti", "Disconnect the rooms when locked", "Räume beim Sperren trennen"),
  "set.security.lockDisconnectHint": T(
    "Přísnější: zamčená aplikace nedrží ani klíče místností a nic nepřijímá. Zprávy pro přihlášený účet podrží server; bez účtu zprávy poslané během zámku zmeškáte.",
    "Stricter: a locked app keeps not even the rooms' keys and receives nothing. The server keeps messages for a signed-in account; without an account you miss the messages sent while the app is locked.",
    "Strenger: Eine gesperrte App behält nicht einmal die Schlüssel der Räume und empfängt nichts. Für ein angemeldetes Konto hält der Server die Nachrichten; ohne Konto verpasst du die Nachrichten, die während der Sperre gesendet werden.",
  ),
  "set.security.pinKey": T("Klíč PINu", "PIN key", "PIN-Schlüssel"),
  "set.security.pinKey.strongbox": T("StrongBox (bezpečnostní čip)", "StrongBox (security chip)", "StrongBox (Sicherheitschip)"),
  "set.security.pinKey.tee": T("bezpečný hardware (TEE)", "secure hardware (TEE)", "sichere Hardware (TEE)"),
  "set.security.pinKey.legacy": T(
    "starší způsob — převede se při příštím odemčení PINem",
    "older scheme — moves at the next PIN unlock",
    "älteres Verfahren — wechselt beim nächsten Entsperren mit PIN",
  ),
  "set.security.pinKey.software": T(
    "jen software — telefon nemá pro klíč PINu bezpečný hardware",
    "software only — this phone has no secure hardware for the PIN key",
    "nur Software — dieses Telefon hat keine sichere Hardware für den PIN-Schlüssel",
  ),
  // G-22: Settings › Notifications
  "notify.lockScreenHide": T("Skrýt na zamčené obrazovce", "Hide on the lock screen", "Auf dem Sperrbildschirm ausblenden"),
  "notify.lockScreenHide.hint": T(
    "Oznámení zpráv se na zamčené obrazovce telefonu neukážou vůbec. Dokud je zamčená aplikace, platí to vždy.",
    "Message notifications do not show on the phone's lock screen at all. While the app is locked, this is always so.",
    "Nachrichten-Benachrichtigungen erscheinen gar nicht auf dem Sperrbildschirm des Telefons. Solange die App gesperrt ist, gilt das immer.",
  ),
  // G-14: voice.engine = server
  "voice.consent.title": T("Přečte to server", "The server reads it", "Der Server liest es"),
  "voice.consent.speak": T(
    "Hlasovou zprávu z textu vytvoří řeč serveru ({provider}): text uvidí server i tento poskytovatel. Zpráva sama půjde šifrovaně jako obvykle. V této místnosti se ptáme jednou.",
    "The server's speech ({provider}) makes the voice message from the text: the server and this provider see the text. The message itself goes encrypted as usual. Asked once in this room.",
    "Die Sprachausgabe des Servers ({provider}) macht aus dem Text die Sprachnachricht: Der Server und dieser Anbieter sehen den Text. Die Nachricht selbst geht wie gewohnt verschlüsselt. In diesem Raum fragen wir einmal.",
  ),
  "voice.consent.transcribe": T(
    "Nahrávku přepíše řeč serveru ({provider}): server i tento poskytovatel ji uslyší. Text zprávy půjde šifrovaně jako obvykle. V této místnosti se ptáme jednou.",
    "The server's speech ({provider}) transcribes the recording: the server and this provider hear it. The message's text goes encrypted as usual. Asked once in this room.",
    "Die Spracherkennung des Servers ({provider}) schreibt die Aufnahme mit: Der Server und dieser Anbieter hören sie. Der Text der Nachricht geht wie gewohnt verschlüsselt. In diesem Raum fragen wir einmal.",
  ),
  "voice.consent.yes": T("Poslat serveru", "Send to the server", "An den Server senden"),
  "voice.consent.no": T("Neposílat", "Don't send", "Nicht senden"),
  "speakSend.declined": T(
    "Neodesláno: řeč serveru jste nepovolili.",
    "Not sent: you did not allow the server's speech.",
    "Nicht gesendet: Du hast die Sprachdienste des Servers nicht erlaubt.",
  ),
  "send.opt.asVoiceServer": T("text čte server", "the server reads the text", "der Server liest den Text"),
  // G-20: the design's copy / share with a computed text
  "security.copyAsk": T("Zkopírovat tento text?", "Copy this text?", "Diesen Text kopieren?"),
  "security.shareAsk": T("Sdílet tento text?", "Share this text?", "Diesen Text teilen?"),
  "security.shareGo": T("Sdílet", "Share", "Teilen"),
  "security.shareTooLong": T(
    "Tento text aplikace nezkopíruje ani nesdílí: je příliš dlouhý, aby se dal celý přečíst.",
    "The app will not copy or share this text: it is too long to be read in full.",
    "Die App kopiert oder teilt diesen Text nicht: Er ist zu lang, um ihn ganz zu lesen.",
  ),
  // F-22: a server notice is the operator's, whatever its frame named
  "notice.operator": T("Operátor", "Operator", "Betreiber"),
};

/* ================================================================ patches */

const find = (node: ANode, id: string): ANode | null => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};

const parentOf = (node: ANode, id: string): ANode | null => {
  for (const c of node.children ?? []) {
    if (c.id === id) return node;
    const f = parentOf(c, id);
    if (f) return f;
  }
  return null;
};

const insert = (parent: ANode, at: { after?: string; before?: string }, nodes: ANode[]): void => {
  const kids = parent.children ?? [];
  const i = kids.findIndex((k) => k.id === (at.after ?? at.before));
  kids.splice(i < 0 ? kids.length : at.after ? i + 1 : i, 0, ...nodes);
  parent.children = kids;
};

const hint = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } });

/** A switch bound to a setting (the 6.1 shape: icon, label, switch). */
const toggleRow = (id: string, icon: string, key: string, setting: string): ANode => n(id, "row", { style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: `{_'${key}'}`, style: { size: 16, weight: 1 } }),
  n(`${id}-switch`, "switch", { props: { setting } }),
]);

const infoRow = (id: string, key: string, value: string): ANode => n(id, "row", { style: { padding: "6 20", gap: 12, align: "center" } }, [
  n(`${id}-label`, "text", { text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", width: 120 } }),
  n(`${id}-value`, "text", { text: value, style: { weight: 1, size: 13 } }),
]);

/** Settings › Security: the duress PIN (after the PIN pad's shuffle), the lock's hint, the PIN key (after the policy). */
export function patchSecurity(screens: Record<string, ANode>): void {
  const sec = screens["settings.security"];
  if (!sec) return;
  if (!find(sec, "duress")) {
    const parent = parentOf(sec, "shuffle") ?? find(sec, "list");
    if (parent) insert(parent, { after: "shuffle" }, [toggleRow("duress", "shield-alert", "set.security.duress", "security.duress"), hint("duress-hint", "set.security.duressHint")]);
  }
  if (!find(sec, "lock-hint")) {
    const parent = parentOf(sec, "lock");
    if (parent) insert(parent, { after: "lock" }, [
      hint("lock-hint", "set.security.lockHint"),
      toggleRow("lockdisconnect", "wifi-off", "set.security.lockDisconnect", "security.lockDisconnect"),
      hint("lockdisconnect-hint", "set.security.lockDisconnectHint"),
    ]);
  }
  if (!find(sec, "pinkey")) {
    const parent = parentOf(sec, "policy") ?? find(sec, "list");
    if (parent) insert(parent, { after: "policy" }, [infoRow("pinkey", "set.security.pinKey", "{$security.pinKeyLabel}")]);
  }
}

/**
 * Settings › Notifications: "Hide on the lock screen" with what the phone
 * shows — before the quiet hours (after Privacy and 6.8's conversations,
 * which keep their places).
 */
export function patchNotify(screens: Record<string, ANode>): void {
  const notify = screens["settings.notify"];
  if (!notify || find(notify, "lockscreen")) return;
  const rows = [
    toggleRow("lockscreen", "eye-off", "notify.lockScreenHide", "notify.lockScreenHide"),
    hint("lockscreen-hint", "notify.lockScreenHide.hint"),
  ];
  const quiet = parentOf(notify, "s-quiet");
  if (quiet) { insert(quiet, { before: "s-quiet" }, rows); return; }
  const parent = parentOf(notify, "privacy") ?? find(notify, "list");
  if (parent) insert(parent, { after: find(parent, "privacy-hint") ? "privacy-hint" : "privacy" }, rows);
}

export const AREA: DesignArea = {
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
  patch(screens) {
    patchSecurity(screens);
    patchNotify(screens);
  },
};
