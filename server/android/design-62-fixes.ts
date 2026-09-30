// 6.2 — the lock screen (all ten keys, sized to the screen), enrolment from a QR code, passkey sign-up/sign-in.
// Merged into the default design by design-62.ts (this file adds to the
// catalog; a tree here replaces the one of the same id).

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_62_FIXES: ElementDef[] = [];
export const ACTIONS_62_FIXES: Array<{ action: string; arg: string; help: string }> = [
  { action: "account.recovery", arg: "", help: "Create (or replace) the account's recovery code — shown once; on the web it opens the account without this phone" },
  { action: "account.addPasskey", arg: "", help: "Add a passkey with PRF to the signed-in account (its key is sealed for it)" },
];
export const SLOTS_62_FIXES: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_62_FIXES: ScreenDef[] = [];

/* ================================================================== lock */

// $lock: mode, setup, step, error, wait, attempts, left, biometricAvailable,
// and (6.2) wide — the window is wider than tall (landscape, split side by side).
const LOCK_TITLE = "{=$lock.setup ? _('lock.setupTitle') : _('lock.title')}";
const LOCK_HINT = "{=$lock.setup ? _('lock.setupHint') : ($lock.mode == 'biometric' ? _('lock.useBiometric') : _('lock.enterPin'))}";
const LOCK_BIO = "$lock.biometricAvailable && $lock.wait == 0";

/** Wide: the header beside the pad — logo, title, hint, biometrics. */
const lockSide = (): ANode => n("side", "column", { if: "$lock.wide", style: { weight: 1, height: "match", align: "center", justify: "center", gap: 10, padding: "8 20 8 8" } }, [
  n("side-logo", "slot", { props: { name: "logo" }, style: { width: 48, height: 48 } }),
  n("side-title", "text", { text: LOCK_TITLE, props: { variant: "title", align: "center" }, style: { bold: true } }),
  n("side-hint", "text", { text: LOCK_HINT, props: { variant: "body", align: "center" }, style: { fg: "@muted" } }),
  n("side-bio", "button", { if: LOCK_BIO, text: "{_'lock.useBiometric'}", props: { icon: "fingerprint-pattern", variant: "tonal" }, on: click("lock.biometric") }),
]);

/** Tall: one compact row above the pad — logo, title and hint, biometrics. */
const lockTop = (): ANode => n("top", "row", { if: "!$lock.wide", style: { self: "stretch", gap: 12, align: "center", padding: "0 4" } }, [
  n("logo", "slot", { props: { name: "logo" }, style: { width: 40, height: 40 } }),
  n("titles", "column", { style: { weight: 1, gap: 2 } }, [
    n("title", "text", { text: LOCK_TITLE, props: { variant: "title" }, style: { bold: true, lines: 1 } }),
    n("hint", "text", { text: LOCK_HINT, props: { variant: "caption" }, style: { fg: "@muted", lines: 2 } }),
  ]),
  n("bio", "iconButton", { if: LOCK_BIO, props: { icon: "fingerprint-pattern", label: "{_'lock.useBiometric'}" }, style: { fg: "@primary" }, on: click("lock.biometric") }),
]);

/** The card: what went wrong right above the dots, the pad — or, after too many attempts, the wait. */
const lockPanel = (): ANode => n("panel", "card", { style: { padding: "12 14 16 14", radius: 28, elevation: 0, border: "1 @border", align: "center" } }, [
  n("notes", "column", { style: { align: "center", gap: 2 } }, [
    n("error", "text", { if: "$lock.error", text: "{$lock.error}", props: { variant: "caption", align: "center" }, style: { fg: "@danger", bold: true, lines: 2 } }),
    n("left", "text", { if: "$lock.attempts > 0 && $lock.left > 0 && $lock.wait == 0", text: "{_'lock.attemptsLeft'}: {$lock.left}", props: { variant: "caption", align: "center" }, style: { fg: "@muted", lines: 1 } }),
  ]),
  n("pad", "slot", { if: "$lock.wait == 0", props: { name: "lockPad" } }),
  n("waiting", "column", { if: "$lock.wait > 0", style: { align: "center", gap: 8, padding: "12 24 8 24" } }, [
    n("wait-icon", "icon", { props: { icon: "timer", size: 36, color: "@danger" } }),
    n("wait", "text", { text: "{_'lock.waitFor'} {$lock.wait} s", props: { variant: "title", align: "center" }, style: { fg: "@danger", bold: true } }),
    n("wait-left", "text", { if: "$lock.left > 0", text: "{_'lock.attemptsLeft'}: {$lock.left}", props: { variant: "caption", align: "center" }, style: { fg: "@muted" } }),
  ]),
]);

/**
 * The lock screen: a compact header, and the pad on a surface card with the
 * attempts, wait and error right above its dots. Tall windows put the header
 * above the card, wide ones beside it; the pad sizes its keys to the room it
 * gets (LockPad.java), so all ten digits fit a cover screen, a split screen
 * and landscape.
 */
const lockTree = (): ANode => n("root", "column", { style: { width: "match", height: "match", bg: "@background", padding: "12 16 16 16" } }, [
  n("body", "row", { style: { weight: 1, width: "match" } }, [
    lockSide(),
    n("main", "column", { style: { weight: 1.3, height: "match", align: "center", justify: "center", gap: 16 } }, [lockTop(), lockPanel()]),
  ]),
]);

export const SCREENS_TREES_62_FIXES: Record<string, ANode> = {
  lock: lockTree(),
};
export const MENUS_62_FIXES: Record<string, MenuItem[]> = {};

/* ======================================================= settings › user */

// $account (6.2): deviceBound — the account's root lives only on this phone
// (its passkey provider has no PRF); canSeal — this phone holds the root, so
// it can seal it for a recovery code or another passkey; recovery,
// recoverySince — the recovery code.

const find = (node: ANode, id: string): ANode | null => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};

const insert = (parent: ANode, at: { after?: string; before?: string }, nodes: ANode[]): void => {
  const kids = parent.children ?? [];
  const i = kids.findIndex((k) => k.id === (at.after ?? at.before));
  kids.splice(i < 0 ? kids.length : at.after ? i + 1 : i, 0, ...nodes);
  parent.children = kids;
};

const boundNote = (): ANode => n("bound", "column", { if: "$account.signedIn && $account.deviceBound", style: { bg: "@surfaceVariant", radius: 16, padding: "12 14", gap: 6 } }, [
  n("bound-head", "row", { style: { gap: 10, align: "center" } }, [
    n("bound-icon", "icon", { props: { icon: "smartphone", size: 20, color: "@warning" } }),
    n("bound-title", "text", { text: "{_'set.user.bound'}", props: { variant: "label" }, style: { bold: true, weight: 1 } }),
  ]),
  n("bound-hint", "text", { text: "{_'set.user.boundHint'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
]);

const reachButtons = (): ANode[] => [
  n("recovery", "button", {
    if: "$account.signedIn && $account.canSeal",
    text: "{=$account.recovery ? _('set.user.recoveryReplace') : _('set.user.recoveryCreate')}",
    props: { icon: "life-buoy", variant: "=$account.deviceBound && !$account.recovery ? 'primary' : 'tonal'" },
    on: click("account.recovery"),
  }),
  n("add-passkey", "button", { if: "$account.signedIn && $account.canSeal", text: "{_'set.user.addPasskey'}", props: { icon: "key-round", variant: "tonal" }, on: click("account.addPasskey") }),
];

const recoveryRow = (): ANode => n("acc-recovery", "row", { style: { padding: "6 20", gap: 12, align: "center" } }, [
  n("acc-recovery-label", "text", { text: "{_'set.user.recovery'}", props: { variant: "caption" }, style: { fg: "@muted", width: 120 } }),
  n("acc-recovery-value", "text", { text: "{=$account.recovery ? _('set.user.recoverySet') : _('set.user.recoveryNone')}", style: { weight: 1, size: 13 } }),
]);

/** Changes to existing trees (after every 6.1 and 6.2 tree is in place). */
export function patch62Fixes(screens: Record<string, ANode>): void {
  // Settings › User: a device-bound account says so, and offers the ways to reach it elsewhere.
  const user = screens["settings.user"];
  if (!user || find(user, "bound")) return;
  const card = find(user, "card");
  if (card) {
    insert(card, { after: "who" }, [boundNote()]);
    insert(card, { before: "signout" }, reachButtons());
  }
  const info = find(user, "acc-info");
  if (info) insert(info, { after: "acc-cred" }, [recoveryRow()]);
}

/* =============================================================== strings */

export const STRINGS_62_FIXES: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    // enrolment from the console's QR code
    "enroll.qrKid": "Klíč serveru z QR kódu",
    "enroll.qrMismatch": "QR kód je pro {server} — na jiném serveru s ním zařízení nezaregistrujete.",
    "enroll.qrApplied": "Údaje z QR kódu jsou vyplněné — zkontrolujte je a zařízení zaregistrujte.",
    "enroll.qrNoCode": "Pokud server vyžaduje registrační kód, doplňte ho.",
    "enroll.qrInvalid": "Odkaz z QR kódu není platný: chybí v něm adresa serveru, nebo je poškozený klíč serveru. Nechte si v konzoli vytvořit nový.",
    "enroll.qrAlready": "Toto zařízení už je registrované na {server}.",
    "enroll.qrOther": "Toto zařízení je registrované na {server}. Chcete-li ho registrovat na {other}, nejdřív smažte všechna data aplikace (Nastavení › Zabezpečení › Smazat všechna data).",
    "enroll.qrLocked": "Toto zařízení už je registrované. Odemkněte aplikaci.",
    // the lock screen
    "lock.setupTitle": "Zabezpečte aplikaci",
    "lock.setupHint": "PIN chrání zprávy a klíče v tomto telefonu.",
    "lock.delete": "Smazat číslici",
    // Settings › User
    "set.user.bound": "Účet je vázaný na tento telefon",
    "set.user.boundHint": "Správce hesel s vaším passkeyem neumí odvodit šifrovací klíč (PRF), proto je klíč účtu uložený jen v tomto telefonu. Aby šel účet použít i jinde (na webu, v dalším zařízení), vytvořte si obnovovací kód, nebo přidejte passkey ze správce s podporou PRF, např. ze Správce hesel Google.",
    "set.user.recovery": "Obnovovací kód",
    "set.user.recoverySet": "nastaven",
    "set.user.recoveryNone": "nenastaven",
    "set.user.recoveryCreate": "Vytvořit obnovovací kód",
    "set.user.recoveryReplace": "Vytvořit nový obnovovací kód",
    "set.user.addPasskey": "Přidat passkey",
    // passkey ceremonies
    "passkey.cancelled": "Passkey nebyl použit.",
    "passkey.problem": "Passkey",
    "passkey.unknownTitle": "Neznámý passkey",
    "passkey.unknownText": "Tento passkey není na {server} registrovaný — nejspíš zbyl po nedokončené registraci. Vytvořit účet teď?",
    "passkey.unknownHint": "Starý passkey „{name}“ můžete smazat ve správci hesel (např. Správce hesel Google nebo Samsung Pass).",
    "passkey.noneTitle": "Žádný passkey",
    "passkey.noneText": "V tomto telefonu není pro {server} žádný passkey. Vytvořit účet teď?",
    "passkey.createAccount": "Vytvořit účet",
    "passkey.cancel": "Zrušit",
    "passkey.unsupported": "V tomto telefonu není správce hesel, který by uměl passkeys. Zapněte ho v nastavení telefonu (např. Správce hesel Google).",
    "passkey.noPrf": "Passkey účtu {user} neumí odvodit šifrovací klíč (PRF) a tento telefon klíč účtu nemá. Přihlaste se passkeyem ze správce s podporou PRF (např. Správce hesel Google), nebo účet obnovte obnovovacím kódem na webu (Účet › Obnovit účet kódem).",
    "passkey.wrongKey": "Klíč z tohoto passkeye neotevírá data účtu {user}.",
    "passkey.wrongKeyDevice": "Klíč uložený v tomto telefonu neotevírá data účtu {user}.",
    "passkey.orphan": "Passkey „M5cet · {user}“ vznikl ve správci hesel, ale server ho nepřijal ({reason}). Smažte ho ve správci hesel (např. Správce hesel Google nebo Samsung Pass) a zkuste to znovu.",
    "passkey.orphanOffline": "Passkey „M5cet · {user}“ vznikl ve správci hesel, ale server nebyl k zastižení. Až budete online, zkuste se jím přihlásit; kdyby server odpověděl, že ho nezná, smažte ho ve správci hesel a vytvořte účet znovu.",
    "passkey.addNoPrf": "Tento správce hesel neumí odvodit šifrovací klíč (PRF), takže nový passkey k účtu přidat nejde. Smažte „M5cet · {user}“ ve správci hesel a zvolte jiného správce (např. Správce hesel Google) — nebo si vytvořte obnovovací kód.",
    "passkey.added": "Passkey je přidaný k účtu.",
    "passkey.exists": "V tomto správci hesel už passkey pro váš účet je. Zvolte jiného správce.",
    "passkey.noRoot": "Klíč účtu v tomto telefonu není — přihlaste se znovu passkeyem.",
    "passkey.notThisAccount": "Tento passkey nepatří k účtu {user}.",
    "passkey.boundTitle": "Účet je vázaný na tento telefon",
    "passkey.boundText": "Účet {user} je vytvořený. Správce hesel ale neumí odvodit šifrovací klíč (PRF), proto je klíč účtu uložený jen v tomto telefonu a jinde se do účtu zatím nepřihlásíte. Vytvořte si obnovovací kód, nebo přidejte passkey ze správce s podporou PRF (např. Správce hesel Google).",
    "passkey.later": "Později",
    "passkey.recoveryTitle": "Váš obnovovací kód",
    "passkey.recoveryShow": "Zobrazí se jen teď. Zapište si ho a uschovejte mimo telefon — server ho nikdy neuvidí. Na webu ho zadáte v Účet › Obnovit účet kódem a vytvoříte si tam nový passkey; do účtu se tak dostanete i bez tohoto telefonu.",
    "passkey.recoveryCopy": "Kopírovat",
    "passkey.recoveryDone": "Mám ho zapsaný",
    "passkey.recoveryReplaceAsk": "Nový kód nahradí dosavadní — starý přestane platit. Pokračovat?",
  },
  en: {
    "enroll.qrKid": "Server key from the QR code",
    "enroll.qrMismatch": "The QR code is for {server} — it will not enrol the device with another server.",
    "enroll.qrApplied": "The QR code's details are filled in — check them and enrol the device.",
    "enroll.qrNoCode": "If the server needs an enrolment code, add it.",
    "enroll.qrInvalid": "The QR code's link is not valid: the server address is missing or the server key is damaged. Have the console make a new one.",
    "enroll.qrAlready": "This device is already enrolled with {server}.",
    "enroll.qrOther": "This device is enrolled with {server}. To enrol it with {other}, first erase all of the app's data (Settings › Security › Erase all data).",
    "enroll.qrLocked": "This device is already enrolled. Unlock the app.",
    "lock.setupTitle": "Secure the app",
    "lock.setupHint": "The PIN protects the messages and keys on this phone.",
    "lock.delete": "Delete a digit",
    "set.user.bound": "The account is tied to this phone",
    "set.user.boundHint": "The password manager holding your passkey cannot derive an encryption key (PRF), so the account's key is stored on this phone only. To use the account elsewhere (on the web, on another device), create a recovery code or add a passkey from a manager with PRF, e.g. Google Password Manager.",
    "set.user.recovery": "Recovery code",
    "set.user.recoverySet": "set",
    "set.user.recoveryNone": "not set",
    "set.user.recoveryCreate": "Create a recovery code",
    "set.user.recoveryReplace": "Create a new recovery code",
    "set.user.addPasskey": "Add a passkey",
    "passkey.cancelled": "The passkey was not used.",
    "passkey.problem": "Passkey",
    "passkey.unknownTitle": "Unknown passkey",
    "passkey.unknownText": "This passkey is not registered on {server} — most likely it was left over from an unfinished sign-up. Create an account now?",
    "passkey.unknownHint": "You can delete the old passkey “{name}” in your password manager (e.g. Google Password Manager or Samsung Pass).",
    "passkey.noneTitle": "No passkey",
    "passkey.noneText": "This phone has no passkey for {server}. Create an account now?",
    "passkey.createAccount": "Create an account",
    "passkey.cancel": "Cancel",
    "passkey.unsupported": "This phone has no password manager that handles passkeys. Turn one on in the phone's settings (e.g. Google Password Manager).",
    "passkey.noPrf": "The passkey of the account {user} cannot derive an encryption key (PRF), and this phone does not hold the account's key. Sign in with a passkey from a manager with PRF (e.g. Google Password Manager), or recover the account with its recovery code on the web (Account › Recover the account with a code).",
    "passkey.wrongKey": "The key from this passkey does not open the data of the account {user}.",
    "passkey.wrongKeyDevice": "The key stored on this phone does not open the data of the account {user}.",
    "passkey.orphan": "The passkey “M5cet · {user}” was created in your password manager, but the server did not accept it ({reason}). Delete it in the password manager (e.g. Google Password Manager or Samsung Pass) and try again.",
    "passkey.orphanOffline": "The passkey “M5cet · {user}” was created in your password manager, but the server could not be reached. Once you are online, try signing in with it; if the server says it does not know it, delete it in the password manager and create the account again.",
    "passkey.addNoPrf": "This password manager cannot derive an encryption key (PRF), so the new passkey cannot be added to the account. Delete “M5cet · {user}” in the password manager and choose another one (e.g. Google Password Manager) — or create a recovery code.",
    "passkey.added": "The passkey was added to the account.",
    "passkey.exists": "This password manager already holds a passkey for your account. Choose another one.",
    "passkey.noRoot": "This phone does not hold the account's key — sign in with a passkey again.",
    "passkey.notThisAccount": "This passkey does not belong to the account {user}.",
    "passkey.boundTitle": "The account is tied to this phone",
    "passkey.boundText": "The account {user} is created. Your password manager cannot derive an encryption key (PRF), though, so the account's key is stored on this phone only and you cannot sign in elsewhere yet. Create a recovery code, or add a passkey from a manager with PRF (e.g. Google Password Manager).",
    "passkey.later": "Later",
    "passkey.recoveryTitle": "Your recovery code",
    "passkey.recoveryShow": "It is shown only now. Write it down and keep it away from the phone — the server never sees it. On the web, enter it in Account › Recover the account with a code and create a new passkey there; that gets you into the account even without this phone.",
    "passkey.recoveryCopy": "Copy",
    "passkey.recoveryDone": "I wrote it down",
    "passkey.recoveryReplaceAsk": "A new code replaces the current one — the old one stops working. Continue?",
  },
  de: {
    "enroll.qrKid": "Serverschlüssel aus dem QR-Code",
    "enroll.qrMismatch": "Der QR-Code gilt für {server} — bei einem anderen Server lässt sich das Gerät damit nicht registrieren.",
    "enroll.qrApplied": "Die Angaben aus dem QR-Code sind eingetragen — prüfen Sie sie und registrieren Sie das Gerät.",
    "enroll.qrNoCode": "Falls der Server einen Registrierungscode verlangt, ergänzen Sie ihn.",
    "enroll.qrInvalid": "Der Link aus dem QR-Code ist ungültig: Die Serveradresse fehlt oder der Serverschlüssel ist beschädigt. Lassen Sie in der Konsole einen neuen erstellen.",
    "enroll.qrAlready": "Dieses Gerät ist bereits bei {server} registriert.",
    "enroll.qrOther": "Dieses Gerät ist bei {server} registriert. Um es bei {other} zu registrieren, löschen Sie zuerst alle Daten der App (Einstellungen › Sicherheit › Alle Daten löschen).",
    "enroll.qrLocked": "Dieses Gerät ist bereits registriert. Entsperren Sie die App.",
    "lock.setupTitle": "App absichern",
    "lock.setupHint": "Die PIN schützt Nachrichten und Schlüssel auf diesem Telefon.",
    "lock.delete": "Ziffer löschen",
    "set.user.bound": "Das Konto ist an dieses Telefon gebunden",
    "set.user.boundHint": "Der Passwortmanager mit Ihrem Passkey kann keinen Verschlüsselungsschlüssel ableiten (PRF), daher ist der Kontoschlüssel nur auf diesem Telefon gespeichert. Um das Konto auch anderswo zu nutzen (im Web, auf einem weiteren Gerät), erstellen Sie einen Wiederherstellungscode oder fügen Sie einen Passkey aus einem Manager mit PRF hinzu, z. B. dem Google Passwortmanager.",
    "set.user.recovery": "Wiederherstellungscode",
    "set.user.recoverySet": "festgelegt",
    "set.user.recoveryNone": "nicht festgelegt",
    "set.user.recoveryCreate": "Wiederherstellungscode erstellen",
    "set.user.recoveryReplace": "Neuen Wiederherstellungscode erstellen",
    "set.user.addPasskey": "Passkey hinzufügen",
    "passkey.cancelled": "Der Passkey wurde nicht verwendet.",
    "passkey.problem": "Passkey",
    "passkey.unknownTitle": "Unbekannter Passkey",
    "passkey.unknownText": "Dieser Passkey ist auf {server} nicht registriert — vermutlich stammt er von einer nicht abgeschlossenen Registrierung. Jetzt ein Konto erstellen?",
    "passkey.unknownHint": "Den alten Passkey „{name}“ können Sie im Passwortmanager löschen (z. B. Google Passwortmanager oder Samsung Pass).",
    "passkey.noneTitle": "Kein Passkey",
    "passkey.noneText": "Auf diesem Telefon gibt es keinen Passkey für {server}. Jetzt ein Konto erstellen?",
    "passkey.createAccount": "Konto erstellen",
    "passkey.cancel": "Abbrechen",
    "passkey.unsupported": "Auf diesem Telefon gibt es keinen Passwortmanager, der Passkeys unterstützt. Schalten Sie einen in den Einstellungen des Telefons ein (z. B. Google Passwortmanager).",
    "passkey.noPrf": "Der Passkey des Kontos {user} kann keinen Verschlüsselungsschlüssel ableiten (PRF), und dieses Telefon hat den Kontoschlüssel nicht. Melden Sie sich mit einem Passkey aus einem Manager mit PRF an (z. B. Google Passwortmanager) oder stellen Sie das Konto im Web mit dem Wiederherstellungscode wieder her (Konto › Konto mit Code wiederherstellen).",
    "passkey.wrongKey": "Der Schlüssel dieses Passkeys öffnet die Daten des Kontos {user} nicht.",
    "passkey.wrongKeyDevice": "Der auf diesem Telefon gespeicherte Schlüssel öffnet die Daten des Kontos {user} nicht.",
    "passkey.orphan": "Der Passkey „M5cet · {user}“ wurde im Passwortmanager angelegt, aber der Server hat ihn nicht angenommen ({reason}). Löschen Sie ihn im Passwortmanager (z. B. Google Passwortmanager oder Samsung Pass) und versuchen Sie es erneut.",
    "passkey.orphanOffline": "Der Passkey „M5cet · {user}“ wurde im Passwortmanager angelegt, aber der Server war nicht erreichbar. Sobald Sie online sind, melden Sie sich damit an; meldet der Server, dass er ihn nicht kennt, löschen Sie ihn im Passwortmanager und erstellen Sie das Konto erneut.",
    "passkey.addNoPrf": "Dieser Passwortmanager kann keinen Verschlüsselungsschlüssel ableiten (PRF), daher lässt sich der neue Passkey nicht zum Konto hinzufügen. Löschen Sie „M5cet · {user}“ im Passwortmanager und wählen Sie einen anderen (z. B. Google Passwortmanager) — oder erstellen Sie einen Wiederherstellungscode.",
    "passkey.added": "Der Passkey wurde dem Konto hinzugefügt.",
    "passkey.exists": "Dieser Passwortmanager hat bereits einen Passkey für Ihr Konto. Wählen Sie einen anderen.",
    "passkey.noRoot": "Dieses Telefon hat den Kontoschlüssel nicht — melden Sie sich erneut mit einem Passkey an.",
    "passkey.notThisAccount": "Dieser Passkey gehört nicht zum Konto {user}.",
    "passkey.boundTitle": "Das Konto ist an dieses Telefon gebunden",
    "passkey.boundText": "Das Konto {user} ist erstellt. Ihr Passwortmanager kann aber keinen Verschlüsselungsschlüssel ableiten (PRF), daher ist der Kontoschlüssel nur auf diesem Telefon gespeichert und Sie können sich anderswo noch nicht anmelden. Erstellen Sie einen Wiederherstellungscode oder fügen Sie einen Passkey aus einem Manager mit PRF hinzu (z. B. Google Passwortmanager).",
    "passkey.later": "Später",
    "passkey.recoveryTitle": "Ihr Wiederherstellungscode",
    "passkey.recoveryShow": "Er wird nur jetzt angezeigt. Schreiben Sie ihn auf und bewahren Sie ihn getrennt vom Telefon auf — der Server sieht ihn nie. Im Web geben Sie ihn unter Konto › Konto mit Code wiederherstellen ein und erstellen dort einen neuen Passkey; so kommen Sie auch ohne dieses Telefon in Ihr Konto.",
    "passkey.recoveryCopy": "Kopieren",
    "passkey.recoveryDone": "Ich habe ihn notiert",
    "passkey.recoveryReplaceAsk": "Ein neuer Code ersetzt den bisherigen — der alte gilt dann nicht mehr. Fortfahren?",
  },
};
