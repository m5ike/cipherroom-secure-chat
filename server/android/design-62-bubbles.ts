// 6.2 — message bubbles: the map preview, the info button and details, attachments, media previews, hide and delete.
// Merged into the default design by design-62.ts (this file adds to the
// catalog; a tree here replaces the one of the same id).
//
// The bubble's content is the native msgBody slot (MsgBody.java): a position
// message draws the operator's map (client config › map, tiles through
// /api/map/tile), an attachment its preview and a footer with save, share and
// forward. The trees only gain the (i) that opens the details (timeline,
// receipts, hide, delete — MsgDetails.java), and a header position's pin
// opens the same map in a dialog.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_62_BUBBLES: ElementDef[] = [];
export const ACTIONS_62_BUBBLES: Array<{ action: string; arg: string; help: string }> = [
  { action: "msg.info", arg: "message id", help: "The message's details: when, who, size, kinds, every state with its time, receipts; hide and delete" },
  { action: "msg.mapPreview", arg: "message id", help: "A header position's map in a dialog (the full map when maps are off)" },
  { action: "msg.save", arg: "message id", help: "Save the message's file (the system's file picker)" },
  { action: "msg.share", arg: "message id", help: "Share the message's file with another app" },
  { action: "msg.forward", arg: "message id", help: "Forward the message to a room or a person" },
  { action: "msg.showHidden", arg: "", help: "Show / leave out the room's hidden messages" },
];
export const SLOTS_62_BUBBLES: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_62_BUBBLES: ScreenDef[] = [];
export const SCREENS_TREES_62_BUBBLES: Record<string, ANode> = {};
export const MENUS_62_BUBBLES: Record<string, MenuItem[]> = {};

export const STRINGS_62_BUBBLES: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    "map.caption": "Aktuální poloha: {name}", "map.captionMine": "Vaše aktuální poloha", "map.open": "Otevřít mapu",
    "file.share": "Sdílet", "file.pages": "str.",
    "msg.forwardTo": "Komu přeposlat", "msg.showHidden": "Skryté", "msg.hideHidden": "Schovat skryté",
    "msg.hiddenUntil": "Skryto do", "msg.hiddenSignin": "Skryto do příštího přihlášení",
    "msginfo.when": "Datum a čas", "msginfo.sender": "Odesílatel", "msginfo.recipients": "Příjemci", "msginfo.everyone": "všichni v místnosti",
    "msginfo.size": "Velikost", "msginfo.sizeText": "text", "msginfo.sizeFile": "soubor", "msginfo.verified": "Ověřený odesílatel", "msginfo.changed": "identita se změnila",
    "msginfo.expires": "Vyprší", "msginfo.hidden": "Skryto", "msginfo.kinds": "Druh zprávy", "msginfo.audit": "Průběh", "msginfo.receipts": "Doručení příjemcům",
    "msginfo.attachment": "Příloha", "msginfo.hideTitle": "Skrýt v tomto zařízení", "msginfo.unhide": "Znovu zobrazit",
    "msginfo.hide.15m": "15 min", "msginfo.hide.1h": "1 hodinu", "msginfo.hide.8h": "8 hodin", "msginfo.hide.1d": "1 den", "msginfo.hide.until-signin": "Do příštího přihlášení",
    "msginfo.hiddenFlash": "Zpráva je skrytá.", "msginfo.delete": "Smazat z tohoto zařízení", "msginfo.deleteYes": "Smazat", "msginfo.cancel": "Zrušit",
    "msginfo.deleteAsk": "Zpráva zmizí z tohoto zařízení i z jeho uložené historie. Ostatním účastníkům zůstane.",
    "msginfo.deleted": "Zpráva je smazaná z tohoto zařízení.",
    "msginfo.auditNote": "Skrytí i smazání se zapíše do auditního záznamu serveru — jen že se stalo, nikdy obsah zprávy.",
    "msginfo.state.created": "vytvořeno", "msginfo.state.encrypted": "zašifrováno", "msginfo.state.sent": "odesláno", "msginfo.state.received": "přijato",
    "msginfo.state.decrypted": "dešifrováno", "msginfo.state.displayed": "zobrazeno", "msginfo.state.discarded": "zahozeno", "msginfo.state.queued": "čeká na příjemce",
    "msginfo.state.stored": "uloženo na serveru (šifrovaně)", "msginfo.state.forwarded": "předáno serverem", "msginfo.state.delivered": "doručeno", "msginfo.state.read": "přečteno",
    "msginfo.state.revealed": "odkryto podržením", "msginfo.state.opened": "otevřeno kódem", "msginfo.state.expired": "vypršelo", "msginfo.state.hidden": "skryto", "msginfo.state.unhidden": "znovu zobrazeno",
    "msginfo.meta.p2p": "přímo (P2P)", "msginfo.meta.relay": "přes server", "msginfo.meta.code": "individuálním kódem", "msginfo.meta.ttl": "platnost zprávy",
    "msginfo.meta.vanish": "čas na obrazovce", "msginfo.meta.time": "čas skrytí uplynul", "msginfo.meta.signin": "po novém přihlášení", "msginfo.meta.user": "ručně",
    "msginfo.meta.15m": "na 15 minut", "msginfo.meta.1h": "na hodinu", "msginfo.meta.8h": "na 8 hodin", "msginfo.meta.1d": "na den", "msginfo.meta.until-signin": "do příštího přihlášení",
    "msginfo.kind.text": "text", "msginfo.kind.file": "soubor", "msginfo.kind.image": "obrázek", "msginfo.kind.audio": "zvuk", "msginfo.kind.video": "video",
    "msginfo.kind.location": "poloha", "msginfo.kind.tap": "klikací", "msginfo.kind.vanish": "mizející", "msginfo.kind.sealed": "individuální (kód)",
    "msginfo.kind.fn": "výstup funkce", "msginfo.kind.private": "soukromá", "msginfo.kind.forwarded": "přeposlaná", "msginfo.kind.reply": "odpověď", "msginfo.kind.transcript": "přepis hovoru",
  },
  en: {
    "map.caption": "{name}'s current position", "map.captionMine": "Your current position", "map.open": "Open the map",
    "file.share": "Share", "file.pages": "pp.",
    "msg.forwardTo": "Forward to", "msg.showHidden": "Hidden", "msg.hideHidden": "Leave out hidden",
    "msg.hiddenUntil": "Hidden until", "msg.hiddenSignin": "Hidden until the next sign-in",
    "msginfo.when": "Date and time", "msginfo.sender": "Sender", "msginfo.recipients": "Recipients", "msginfo.everyone": "everyone in the room",
    "msginfo.size": "Size", "msginfo.sizeText": "text", "msginfo.sizeFile": "file", "msginfo.verified": "Verified sender", "msginfo.changed": "identity changed",
    "msginfo.expires": "Expires", "msginfo.hidden": "Hidden", "msginfo.kinds": "Kind", "msginfo.audit": "Timeline", "msginfo.receipts": "Delivery to recipients",
    "msginfo.attachment": "Attachment", "msginfo.hideTitle": "Hide on this device", "msginfo.unhide": "Show again",
    "msginfo.hide.15m": "15 min", "msginfo.hide.1h": "1 hour", "msginfo.hide.8h": "8 hours", "msginfo.hide.1d": "1 day", "msginfo.hide.until-signin": "Until the next sign-in",
    "msginfo.hiddenFlash": "The message is hidden.", "msginfo.delete": "Delete from this device", "msginfo.deleteYes": "Delete", "msginfo.cancel": "Cancel",
    "msginfo.deleteAsk": "The message goes from this device and its stored history. The other people keep it.",
    "msginfo.deleted": "The message is deleted from this device.",
    "msginfo.auditNote": "Hiding and deleting are written to the server's audit log — only that it happened, never the message.",
    "msginfo.state.created": "created", "msginfo.state.encrypted": "encrypted", "msginfo.state.sent": "sent", "msginfo.state.received": "received",
    "msginfo.state.decrypted": "decrypted", "msginfo.state.displayed": "displayed", "msginfo.state.discarded": "discarded", "msginfo.state.queued": "waiting for the recipient",
    "msginfo.state.stored": "stored on the server (encrypted)", "msginfo.state.forwarded": "forwarded by the server", "msginfo.state.delivered": "delivered", "msginfo.state.read": "read",
    "msginfo.state.revealed": "revealed by holding", "msginfo.state.opened": "opened with the code", "msginfo.state.expired": "expired", "msginfo.state.hidden": "hidden", "msginfo.state.unhidden": "shown again",
    "msginfo.meta.p2p": "directly (P2P)", "msginfo.meta.relay": "via the server", "msginfo.meta.code": "with an individual code", "msginfo.meta.ttl": "message lifetime",
    "msginfo.meta.vanish": "time on screen", "msginfo.meta.time": "the hide ran out", "msginfo.meta.signin": "after a new sign-in", "msginfo.meta.user": "by hand",
    "msginfo.meta.15m": "for 15 minutes", "msginfo.meta.1h": "for an hour", "msginfo.meta.8h": "for 8 hours", "msginfo.meta.1d": "for a day", "msginfo.meta.until-signin": "until the next sign-in",
    "msginfo.kind.text": "text", "msginfo.kind.file": "file", "msginfo.kind.image": "picture", "msginfo.kind.audio": "audio", "msginfo.kind.video": "video",
    "msginfo.kind.location": "position", "msginfo.kind.tap": "tap to reveal", "msginfo.kind.vanish": "vanishing", "msginfo.kind.sealed": "individual (code)",
    "msginfo.kind.fn": "function output", "msginfo.kind.private": "private", "msginfo.kind.forwarded": "forwarded", "msginfo.kind.reply": "reply", "msginfo.kind.transcript": "call transcript",
  },
  de: {
    "map.caption": "Aktueller Standort von {name}", "map.captionMine": "Ihr aktueller Standort", "map.open": "Karte öffnen",
    "file.share": "Teilen", "file.pages": "S.",
    "msg.forwardTo": "Weiterleiten an", "msg.showHidden": "Ausgeblendet", "msg.hideHidden": "Ausgeblendete verbergen",
    "msg.hiddenUntil": "Ausgeblendet bis", "msg.hiddenSignin": "Ausgeblendet bis zur nächsten Anmeldung",
    "msginfo.when": "Datum und Uhrzeit", "msginfo.sender": "Absender", "msginfo.recipients": "Empfänger", "msginfo.everyone": "alle im Raum",
    "msginfo.size": "Größe", "msginfo.sizeText": "Text", "msginfo.sizeFile": "Datei", "msginfo.verified": "Bestätigter Absender", "msginfo.changed": "Identität geändert",
    "msginfo.expires": "Läuft ab", "msginfo.hidden": "Ausgeblendet", "msginfo.kinds": "Art", "msginfo.audit": "Verlauf", "msginfo.receipts": "Zustellung an Empfänger",
    "msginfo.attachment": "Anhang", "msginfo.hideTitle": "Auf diesem Gerät ausblenden", "msginfo.unhide": "Wieder anzeigen",
    "msginfo.hide.15m": "15 Min.", "msginfo.hide.1h": "1 Stunde", "msginfo.hide.8h": "8 Stunden", "msginfo.hide.1d": "1 Tag", "msginfo.hide.until-signin": "Bis zur nächsten Anmeldung",
    "msginfo.hiddenFlash": "Die Nachricht ist ausgeblendet.", "msginfo.delete": "Von diesem Gerät löschen", "msginfo.deleteYes": "Löschen", "msginfo.cancel": "Abbrechen",
    "msginfo.deleteAsk": "Die Nachricht verschwindet von diesem Gerät und aus seinem gespeicherten Verlauf. Die anderen behalten sie.",
    "msginfo.deleted": "Die Nachricht ist von diesem Gerät gelöscht.",
    "msginfo.auditNote": "Ausblenden und Löschen werden im Audit-Protokoll des Servers vermerkt — nur dass es geschah, nie die Nachricht.",
    "msginfo.state.created": "erstellt", "msginfo.state.encrypted": "verschlüsselt", "msginfo.state.sent": "gesendet", "msginfo.state.received": "empfangen",
    "msginfo.state.decrypted": "entschlüsselt", "msginfo.state.displayed": "angezeigt", "msginfo.state.discarded": "verworfen", "msginfo.state.queued": "wartet auf den Empfänger",
    "msginfo.state.stored": "auf dem Server gespeichert (verschlüsselt)", "msginfo.state.forwarded": "vom Server weitergegeben", "msginfo.state.delivered": "zugestellt", "msginfo.state.read": "gelesen",
    "msginfo.state.revealed": "durch Halten angezeigt", "msginfo.state.opened": "mit dem Code geöffnet", "msginfo.state.expired": "abgelaufen", "msginfo.state.hidden": "ausgeblendet", "msginfo.state.unhidden": "wieder angezeigt",
    "msginfo.meta.p2p": "direkt (P2P)", "msginfo.meta.relay": "über den Server", "msginfo.meta.code": "mit individuellem Code", "msginfo.meta.ttl": "Lebensdauer der Nachricht",
    "msginfo.meta.vanish": "Zeit auf dem Bildschirm", "msginfo.meta.time": "Ausblendung abgelaufen", "msginfo.meta.signin": "nach neuer Anmeldung", "msginfo.meta.user": "von Hand",
    "msginfo.meta.15m": "für 15 Minuten", "msginfo.meta.1h": "für eine Stunde", "msginfo.meta.8h": "für 8 Stunden", "msginfo.meta.1d": "für einen Tag", "msginfo.meta.until-signin": "bis zur nächsten Anmeldung",
    "msginfo.kind.text": "Text", "msginfo.kind.file": "Datei", "msginfo.kind.image": "Bild", "msginfo.kind.audio": "Audio", "msginfo.kind.video": "Video",
    "msginfo.kind.location": "Standort", "msginfo.kind.tap": "zum Anzeigen halten", "msginfo.kind.vanish": "verschwindend", "msginfo.kind.sealed": "individuell (Code)",
    "msginfo.kind.fn": "Funktionsausgabe", "msginfo.kind.private": "privat", "msginfo.kind.forwarded": "weitergeleitet", "msginfo.kind.reply": "Antwort", "msginfo.kind.transcript": "Anruf-Transkript",
  },
};

/* ============================================================= the trees */

function find(node: ANode, id: string): ANode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

/**
 * message.in / message.out: the (i) at the end of the meta row (or of the
 * bubble, in a tree without one) opens the details; the header position's
 * pin shows only when the bubble has no map of its own and opens the map in
 * a dialog. A tree that already has an "info" element is left alone.
 */
export function patch62Bubbles(screens: Record<string, ANode>): void {
  for (const [id, color] of [["message.in", "@muted"], ["message.out", "@onBubbleOut"]] as const) {
    const tree = screens[id];
    if (!tree || find(tree, "info")) continue;
    const loc = find(tree, "loc");
    if (loc) {
      loc.if = "$msg.loc && !$msg.mapPreview";
      loc.on = click("msg.mapPreview", "{$msg.id}");
    }
    const into = find(tree, "meta") ?? find(tree, "bubble");
    if (!into) continue;
    into.children = [
      ...(into.children ?? []),
      n("info", "icon", { props: { icon: "info", size: 15, color }, style: { padding: "2 0 2 4" }, on: click("msg.info", "{$msg.id}") }),
    ];
  }
}
