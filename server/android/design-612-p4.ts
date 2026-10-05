// 6.12 design area: protocol 4 in the app (docs/protocol-v4.md). No new
// elements; one action (kt.dismiss — the security review's key-transparency
// alert dismissed in the settings) — the texts the app says and what the
// existing trees show of it:
//
//   users.item       a member the server says did not prove it holds the room
//                    key (§ 13: `proven: false`) gets a "shield-off" badge; an
//                    older peer "· older protocol" under its name
//   users.person     its identity state (§ 12.1: new key — not verified,
//                    verified, account key, identity changed), the protocol
//                    (protocol 4, or older: no PCS / PQ), the room-key proof,
//                    messages held behind a changed identity, key
//                    transparency's word on an attested device; a red row for
//                    a refused protocol downgrade (§ 1)
//   settings.user    key transparency's persistent alert for the server (§ 14.4)
//   settings.security  the same alert
//
// What the app does (android/…/chat/P4Room, P4Device, P4Relay, Trust,
// RoomSession): hello v4 and the pair ratchet, sender keys v4, files with a
// per-transfer key, the mailbox for away members, the hub join proof, the
// replay window, key transparency. The scopes: $user / $form.person gain
// trust, trustLabel, protocol, protocolLabel, legacy, downgrade, proven,
// unproven, held, kt, ktLabel; $connection and $security gain ktAlert. The app has
// English fallbacks for every text here (chat/P4Texts) for a published design
// older than 6.12.
//
// One area of the 6.12 design (design-612.ts gathers them).

import type { ANode } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });

const P = "$form.person";

function find(node: ANode, id: string): ANode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

function parentOf(node: ANode, id: string): ANode | null {
  for (const c of node.children ?? []) {
    if (c.id === id) return node;
    const hit = parentOf(c, id);
    if (hit) return hit;
  }
  return null;
}

/** Puts `add` right after the node `id` (once: nothing when a node of the first added id is there already). */
function insertAfter(root: ANode | undefined, id: string, add: ANode[]): void {
  if (!root || add.length === 0 || find(root, add[0].id)) return;
  const parent = parentOf(root, id);
  if (!parent?.children) return;
  const at = parent.children.findIndex((c) => c.id === id);
  parent.children.splice(at + 1, 0, ...add);
}

/** A row of the person's detail (design-62-people.ts info). */
const info = (id: string, label: string, value: string, cond?: string, color?: string): ANode => n(id, "row", { ...(cond ? { if: cond } : {}), style: { padding: "5 8", gap: 12, align: "start" } }, [
  n(`${id}-label`, "text", { text: label, props: { variant: "caption" }, style: { fg: "@muted", width: 116 } }),
  n(`${id}-value`, "text", { text: value, style: { weight: 1, size: 13.5, ...(color ? { fg: color } : {}) } }),
]);

/** A settings row with a warning (design-61.ts infoRow, in red) and, 6.12 review: its dismiss button (kt.dismiss). */
const alertRow = (id: string, cond: string, value: string): ANode => n(id, "row", { if: cond, style: { padding: "8 20", gap: 12, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon: "shield-alert", size: 20, color: "@danger" } }),
  n(`${id}-value`, "text", { text: value, style: { weight: 1, size: 13, fg: "@danger" } }),
  n(`${id}-dismiss`, "button", { text: "{_'p4.kt.dismiss'}", props: { icon: "check", variant: "text" }, on: { click: { action: "kt.dismiss" } } }),
]);

const T = (cs: string, en: string, de: string) => ({ cs, en, de });

const STR: Record<string, { cs: string; en: string; de: string }> = {
  "p4.downgrade": T(
    "odmítnut návrat ke staršímu protokolu — toto zařízení už mluvilo protokolem 4; jeho zprávy se nečtou",
    "protocol downgrade refused — this device spoke protocol 4 before; its messages are not read",
    "Rückfall auf das ältere Protokoll abgelehnt — dieses Gerät sprach schon Protokoll 4; seine Nachrichten werden nicht gelesen",
  ),
  "p4.identityChanged": T(
    "identita se změnila — než mu uvěříte, porovnejte bezpečnostní číslo",
    "identity changed — compare the safety number before you trust it",
    "Identität geändert — vergleichen Sie die Sicherheitsnummer, bevor Sie ihr vertrauen",
  ),
  "p4.held": T(
    "identita se změnila — jeho zprávy jsou zadržené, dokud ho neověříte (Lidé › Ověřit)",
    "identity changed — their messages are held until you verify them (People › Verify)",
    "Identität geändert — die Nachrichten bleiben zurückgehalten, bis Sie verifizieren (Personen › Verifizieren)",
  ),
  "p4.heldDropped": T(
    "{n} zadržených zpráv se nezobrazilo (identita se změnila a nebyla ověřena)",
    "{n} held messages were not shown (identity changed, not verified)",
    "{n} zurückgehaltene Nachrichten wurden nicht angezeigt (Identität geändert, nicht verifiziert)",
  ),
  "p4.roomProof": T(
    "Server odmítl důkaz tohoto zařízení, že zná klíč místnosti: pro tuto místnost má zaregistrovaný jiný klíč (někdo ji mohl zabrat dřív). Ověřte s ostatními název místnosti a heslo; vlastník serveru může registraci místnosti zrušit.",
    "The server refused this device's proof that it holds the room key: another key is registered for this room on the server (someone may have claimed it first). Check the room name and passphrase with the others; the server's owner can reset the room's registration.",
    "Der Server hat den Nachweis dieses Geräts abgelehnt, dass es den Raumschlüssel kennt: Für diesen Raum ist ein anderer Schlüssel registriert (jemand könnte ihn zuerst beansprucht haben). Prüfen Sie Raumnamen und Passwort mit den anderen; der Betreiber des Servers kann die Registrierung des Raums zurücksetzen.",
  ),
  // 6.12 security review (docs/review-612.md): S14, P08, P04, P05, P14, P01 (the app's side).
  "p4.roomProofLegacy": T(
    "Pro tuto místnost má server zaregistrovaný jiný klíč (mohl ji zabrat někdo, kdo znal jen její slepé ID), proto se toto zařízení připojilo bez důkazu, že zná klíč místnosti — ostatní ho uvidí jako neprokázané. Ověřte s ostatními název místnosti a heslo; vlastník serveru může registraci místnosti zrušit.",
    "Another key is registered for this room on the server (someone who knew only its blind id may have claimed it first), so this device joined without proving it holds the room key — the others see it as unproven. Check the room name and passphrase with the others; the server's owner can reset the room's registration.",
    "Für diesen Raum ist auf dem Server ein anderer Schlüssel registriert (jemand, der nur seine blinde ID kannte, könnte ihn zuerst beansprucht haben); dieses Gerät ist daher ohne Nachweis des Raumschlüssels beigetreten — die anderen sehen es als nicht nachgewiesen. Prüfen Sie Raumnamen und Passwort mit den anderen; der Betreiber des Servers kann die Registrierung des Raums zurücksetzen.",
  ),
  "p4.trust.otherName": T("ověřeno jako {name} — teď pod jiným jménem", "verified as {name} — now under another name", "verifiziert als {name} — jetzt unter einem anderen Namen"),
  "p4.kt.checking": T("ověřuje se v logu transparentnosti klíčů", "being checked in the key-transparency log", "wird im Schlüsseltransparenz-Log geprüft"),
  "p4.kt.unchecked": T("v logu transparentnosti klíčů zatím neověřeno", "not yet checked in the key-transparency log", "im Schlüsseltransparenz-Log noch nicht geprüft"),
  "p4.file.proxyP4": T(
    "{name} jde přes server — jeho klíč zapečetěný pro zařízení každého člena (protokol 4)",
    "{name} goes through the server — its key sealed for each member's devices (protocol 4)",
    "{name} geht über den Server — sein Schlüssel für die Geräte jedes Mitglieds versiegelt (Protokoll 4)",
  ),
  "p4.file.proxyRoomKey": T(
    "{name} šel přes server klíčem místnosti: zařízení některého člena nešlo zabezpečit end-to-end",
    "{name} went through the server under the room key: a member's device could not be reached end to end",
    "{name} ging mit dem Raumschlüssel über den Server: das Gerät eines Mitglieds war nicht Ende-zu-Ende erreichbar",
  ),
  "p4.file.noKey": T(
    "Soubor přes server přišel bez svého klíče — nejde otevřít (požádejte odesílatele, ať ho pošle znovu)",
    "A file through the server came without its key — it cannot be opened (ask the sender to send it again)",
    "Eine Datei über den Server kam ohne ihren Schlüssel — sie lässt sich nicht öffnen (bitten Sie den Absender, sie erneut zu senden)",
  ),
  "p4.kt.alert.unknown-device": T(
    "K vašemu účtu přibylo zařízení, které tento telefon nezná (transparentnost klíčů). Pokud jste to nebyli vy, odhlaste se všude a dejte vědět provozovateli serveru.",
    "A device this phone does not know was added to your account (key transparency). If it was not you, sign out everywhere and tell the server's operator.",
    "Ihrem Konto wurde ein Gerät hinzugefügt, das dieses Telefon nicht kennt (Schlüsseltransparenz). Wenn Sie es nicht waren, melden Sie sich überall ab und informieren Sie den Betreiber des Servers.",
  ),
  "p4.kt.alert.account-key": T(
    "U vašeho účtu byl zaregistrován jiný klíč účtu (transparentnost klíčů).",
    "Another account key was registered for your account (key transparency).",
    "Für Ihr Konto wurde ein anderer Kontoschlüssel registriert (Schlüsseltransparenz).",
  ),
  "p4.kt.alert.unproven": T(
    "Server už den neprokázal, že jeho historie klíčů navazuje na tu, kterou toto zařízení vidělo (transparentnost klíčů).",
    "For a day the server has not proved that its key history continues the one this device saw (key transparency).",
    "Seit einem Tag hat der Server nicht nachgewiesen, dass seine Schlüsselgeschichte an die von diesem Gerät gesehene anschließt (Schlüsseltransparenz).",
  ),
  "p4.kt.dismiss": T("Zavřít", "Dismiss", "Schließen"),
  "quote.held": T("Zadržená zpráva — identita odesílatele se změnila", "Held message — the sender's identity changed", "Zurückgehaltene Nachricht — die Identität des Absenders hat sich geändert"),
  "msginfo.state.relay-p4": T("nepřítomným — zapečetěno pro jejich zařízení (protokol 4)", "away — sealed for their devices (protocol 4)", "abwesend — für ihre Geräte versiegelt (Protokoll 4)"),
  "msginfo.state.relay-room": T("nepřítomným — klíčem místnosti (protokol 3)", "away — under the room key (protocol 3)", "abwesend — mit dem Raumschlüssel (Protokoll 3)"),
  "p4.roomProofRequired": T(
    "Tento server pustí jen členy, kteří prokážou, že znají klíč místnosti; tato místnost to prokázat neumí (je otevřená svým prostým názvem).",
    "This server admits only members who prove they hold the room key; this room cannot prove it (it is joined by its plain name).",
    "Dieser Server lässt nur Mitglieder ein, die den Raumschlüssel nachweisen; dieser Raum kann das nicht (er wird über seinen einfachen Namen betreten).",
  ),
  "p4.clockAhead": T(
    "hodiny jeho zařízení jdou asi o {min} min napřed — jeho zprávy ukazují čas, kdy přišly",
    "their device's clock runs about {min} min ahead — its messages show the time they arrived",
    "die Uhr des Geräts geht etwa {min} Min. vor — seine Nachrichten zeigen die Zeit ihres Eintreffens",
  ),
  "p4.trust.new": T("nový klíč — neověřeno", "new key — not verified", "neuer Schlüssel — nicht verifiziert"),
  "p4.trust.verified": T("ověřeno", "verified", "verifiziert"),
  "p4.trust.account": T("klíč účtu — neověřeno", "account key — not verified", "Kontoschlüssel — nicht verifiziert"),
  "p4.trust.changed": T("identita se změnila", "identity changed", "Identität geändert"),
  "p4.legacy": T("starší protokol (bez PCS / PQ)", "older protocol (no PCS / PQ)", "älteres Protokoll (ohne PCS / PQ)"),
  "p4.legacyShort": T("starší protokol", "older protocol", "älteres Protokoll"),
  "p4.protocol4": T("protokol 4 (PQ + PCS)", "protocol 4 (PQ + PCS)", "Protokoll 4 (PQ + PCS)"),
  "p4.unproven": T("serveru neprokázal klíč místnosti", "did not prove the room key to the server", "hat dem Server den Raumschlüssel nicht nachgewiesen"),
  "p4.proven": T("prokázal klíč místnosti", "proved the room key", "hat den Raumschlüssel nachgewiesen"),
  "p4.label.trust": T("Identita", "Identity", "Identität"),
  "p4.label.protocol": T("Protokol", "Protocol", "Protokoll"),
  "p4.label.proof": T("Klíč místnosti", "Room key", "Raumschlüssel"),
  "p4.label.held": T("Zadržené zprávy", "Held messages", "Zurückgehaltene Nachrichten"),
  "p4.label.kt": T("Transparentnost klíčů", "Key transparency", "Schlüsseltransparenz"),
  "p4.kt.ok": T("v logu transparentnosti klíčů", "in the key-transparency log", "im Schlüsseltransparenz-Log"),
  "p4.kt.revoked": T("v logu transparentnosti klíčů odvoláno", "revoked in the key-transparency log", "im Schlüsseltransparenz-Log widerrufen"),
  "p4.kt.missing": T("v logu transparentnosti klíčů chybí", "not in the key-transparency log", "nicht im Schlüsseltransparenz-Log"),
  "p4.kt.unverifiable": T("log transparentnosti klíčů nešel ověřit", "the key-transparency log could not be checked", "das Schlüsseltransparenz-Log ließ sich nicht prüfen"),
  "p4.kt.alert.inconsistent": T(
    "Server ukazuje přepsanou historii klíčů (transparentnost klíčů).",
    "The server shows a rewritten key history (key transparency).",
    "Der Server zeigt eine umgeschriebene Schlüsselgeschichte (Schlüsseltransparenz).",
  ),
  "p4.kt.alert.split-view": T(
    "Server ukazuje různým lidem různou historii klíčů (transparentnost klíčů).",
    "The server shows different key histories to different people (key transparency).",
    "Der Server zeigt verschiedenen Personen verschiedene Schlüsselgeschichten (Schlüsseltransparenz).",
  ),
  "p4.kt.alert.key-changed": T(
    "Klíč transparentnosti klíčů tohoto serveru se změnil.",
    "The server's key-transparency key changed.",
    "Der Schlüsseltransparenz-Schlüssel des Servers hat sich geändert.",
  ),
};

const strings = { cs: {} as Record<string, string>, en: {} as Record<string, string>, de: {} as Record<string, string> };
for (const [key, v] of Object.entries(STR)) { strings.cs[key] = v.cs; strings.en[key] = v.en; strings.de[key] = v.de; }

export const AREA: DesignArea = {
  strings,
  actions: [
    { action: "kt.dismiss", arg: "", help: "Key transparency's alert (settings): the person saw it — an unknown device of their account was theirs; it comes back while another cause stays" },
  ],
  patch(screens) {
    // The People list: the room-key badge and the older protocol.
    const item = screens["users.item"];
    insertAfter(item, "changed", [n("unproven", "icon", { if: "!$user.me && $user.unproven", props: { icon: "shield-off", size: 14, color: "@warning" } })]);
    const sub = item ? find(item, "sub") : null;
    if (sub && typeof sub.text === "string" && !sub.text.includes("legacyShort")) sub.text += "{=$user.legacy ? ' · ' + _('p4.legacyShort') : ''}";

    // The person's detail: a refused downgrade, the identity facts of protocol 4.
    const person = screens["users.person"];
    insertAfter(person, "warn", [
      n("downgrade", "row", { if: `${P}.downgrade`, style: { bg: "@danger", fg: "#ffffff", radius: 12, padding: "8 12", gap: 8, align: "center", margin: "0 4 6 4" } }, [
        n("downgrade-icon", "icon", { props: { icon: "shield-off", size: 18, color: "#ffffff" } }),
        n("downgrade-text", "text", { text: "{_'p4.downgrade'}", style: { weight: 1 } }),
      ]),
    ]);
    insertAfter(person, "r-verified", [
      info("r-trust", "{_'p4.label.trust'}", `{${P}.trustLabel}`, `!${P}.me && ${P}.trustLabel`, `=${P}.changed ? '@danger' : ${P}.trust == 'verified' ? '@success' : '@onSurface'`),
      info("r-protocol", "{_'p4.label.protocol'}", `{${P}.protocolLabel}`, `${P}.protocolLabel`),
      info("r-proof", "{_'p4.label.proof'}", `{=${P}.unproven ? _('p4.unproven') : _('p4.proven')}`, `!${P}.me && (${P}.unproven || ${P}.proven)`, `=${P}.unproven ? '@warning' : '@onSurface'`),
      info("r-held", "{_'p4.label.held'}", `{${P}.held}`, `${P}.held > 0`, "@danger"),
      info("r-kt", "{_'p4.label.kt'}", `{${P}.ktLabel}`, `!${P}.me && ${P}.ktLabel`, `=${P}.kt == 'revoked' ? '@danger' : '@onSurface'`),
    ]);

    // Settings: key transparency's alert for this server (§ 14.4).
    insertAfter(screens["settings.user"], "c-proto", [alertRow("c-kt", "$connection.ktAlert", "{$connection.ktAlert}")]);
    insertAfter(screens["settings.security"], "shots", [alertRow("kt-alert", "$security.ktAlert", "{$security.ktAlert}")]);
  },
};
