// 6.4 — registration and passkey diagnostics (the Android app). Merged into the
// default design by design-64.ts.
//
// Registration: Settings › User gets a Register button, the room's ⋮ and the
// room list's ⋮ a Registration item — shown only while nobody is signed in.
// The form itself (name, country, mobile, e-mail, then the steps: checking →
// passkey → keys → registering → syncing) is a native full-screen dialog
// (account/RegisterDialog.java); only its texts live here.
//
// Passkey diagnostics: when the phone's Credential Manager refuses the
// server's passkeys because the server's domain does not vouch for the app
// (assetlinks.json), sign-in, account creation and adding a passkey all show
// one dialog with the app's signing certificate for the operator.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_64_REG: ElementDef[] = [];

export const ACTIONS_64_REG: Array<{ action: string; arg: string; help: string }> = [
  { action: "account.register", arg: "", help: "Open the registration form (name, country, mobile, e-mail → a new account with a passkey); signed out only" },
];

export const SLOTS_64_REG: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_64_REG: ScreenDef[] = [];
export const SCREENS_TREES_64_REG: Record<string, ANode> = {};
export const MENUS_64_REG: Record<string, MenuItem[]> = {};

// $account (6.4): registered — the account was made through the registration.
const SIGNED_OUT = "!$account.signedIn";

const registrationItem = (): MenuItem => ({ id: "register", icon: "contact-round", label: "{_'menu.register'}", action: "account.register", if: SIGNED_OUT });

/** Items added to menus that already exist: which menu, before which item (else at the end). */
export const MENU_ITEMS_64_REG: Array<{ menu: string; before?: string; item: MenuItem }> = [
  { menu: "room", before: "leave", item: registrationItem() },
  { menu: "main", before: "about", item: registrationItem() },
];

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

/** Changes to existing trees (after every 6.1–6.3 tree is in place). */
export function patch64Reg(screens: Record<string, ANode>): void {
  // Settings › User: Register next to "Sign in with a passkey" / "Create an account".
  const user = screens["settings.user"];
  const card = user ? find(user, "card") : null;
  if (!card || find(card, "register")) return;
  insert(card, { after: "signup" }, [
    n("register", "button", { if: SIGNED_OUT, text: "{_'set.user.register'}", props: { icon: "contact-round", variant: "tonal" }, on: click("account.register") }),
  ]);
}

/** The Registration items into the room's and the room list's menus (once). */
export function patchMenus64Reg(menus: Record<string, MenuItem[]>): void {
  for (const { menu, before, item } of MENU_ITEMS_64_REG) {
    const items = menus[menu];
    if (!items || items.some((it) => it.id === item.id)) continue;
    const i = before ? items.findIndex((it) => it.id === before) : -1;
    items.splice(i < 0 ? items.length : i, 0, { ...item });
  }
}

/* =============================================================== strings */

export const STRINGS_64_REG: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    "menu.register": "Registrace",
    "set.user.register": "Registrovat",
    // the form
    "reg.title": "Registrace",
    "reg.intro": "Založte si účet M5cet se jménem, mobilem a e-mailem. Server údaje ověří a účet zaregistruje; vaše kopie zůstane zapečetěná v šifrovaném trezoru účtu. Přihlašujete se passkeyem — bez hesla.",
    "reg.firstName": "Jméno", "reg.lastName": "Příjmení", "reg.country": "Země", "reg.phone": "Mobil", "reg.email": "E-mail",
    "reg.countryPick": "Vyberte zemi", "reg.countrySearch": "Hledat: název, kód nebo +předvolba",
    "reg.countriesFailed": "Seznam zemí se nepodařilo načíst — klepnutím to zkusíte znovu.", "reg.loading": "Načítám…",
    "reg.submit": "Registrovat",
    // the steps
    "reg.step.check": "Ověřování", "reg.step.passkey": "Passkey", "reg.step.keys": "Klíče", "reg.step.register": "Registrace", "reg.step.sync": "Synchronizace",
    // what went wrong
    "reg.err.required": "Vyplňte prosím.",
    "reg.err.tooLong": "Příliš dlouhé — nejvýše 64 znaků.",
    "reg.err.name": "Jen písmena (s mezerami, pomlčkami, apostrofy a tečkami).",
    "reg.err.country": "Vyberte zemi ze seznamu.",
    "reg.err.phone": "Zadejte číslo mobilu (6–15 číslic).",
    "reg.err.notMobile": "Toto není číslo mobilu.",
    "reg.err.phoneTaken": "Toto číslo už je zaregistrované.",
    "reg.err.email": "Zadejte platnou e-mailovou adresu.",
    "reg.err.noDomain": "Tato e-mailová doména neexistuje.",
    "reg.err.noMx": "Tato e-mailová doména nepřijímá poštu.",
    "reg.err.dns": "E-mailovou doménu se teď nepodařilo ověřit, zkuste to znovu.",
    "reg.err.emailTaken": "Tento e-mail už je zaregistrovaný.",
    "reg.err.invalid": "Tohle není platné.",
    "reg.err.fix": "Zkontrolujte označená pole.",
    "reg.err.tooMany": "Příliš mnoho pokusů, počkejte pár minut.",
    "reg.failed": "Registrace se nezdařila: {reason}",
    "reg.takenHint": "Někdo to mezitím zaregistroval. Passkey „M5cet · {user}“ vytvořený před chvílí se nepoužije — můžete ho smazat ve správci hesel.",
    // afterwards
    "reg.done": "Zaregistrováno · {user}",
    "reg.syncFailed": "Účet {user} je zaregistrovaný, ale vaše údaje se nepodařilo uložit do jeho trezoru ({reason}).",
    "reg.already": "Jste přihlášeni jako {user}.",
    // passkey diagnostics: the server's domain does not vouch for the app (assetlinks.json)
    "passkey.rpTitle": "Server tuto aplikaci nepotvrdil",
    "passkey.rpText": "Passkeye na Androidu fungují jen tehdy, když server {host} zveřejní https://{host}/.well-known/assetlinks.json se záznamem této aplikace. Provozovatel serveru může certifikátu aplikace důvěřovat v konzoli (Console › Android › Security › Passkeys) — pošlete mu otisk níže.",
    "passkey.rpCert": "Otisk certifikátu (SHA-256)",
    "passkey.rpPackage": "Balíček",
    "passkey.rpCopy": "Kopírovat otisk",
  },
  en: {
    "menu.register": "Registration",
    "set.user.register": "Register",
    "reg.title": "Registration",
    "reg.intro": "Create an M5cet account with your name, mobile and e-mail. The server checks them and registers the account; your copy stays sealed in the account's encrypted vault. You sign in with a passkey — no password.",
    "reg.firstName": "First name", "reg.lastName": "Last name", "reg.country": "Country", "reg.phone": "Mobile", "reg.email": "E-mail",
    "reg.countryPick": "Choose a country", "reg.countrySearch": "Search: name, code or +dial",
    "reg.countriesFailed": "The countries could not be loaded — tap to try again.", "reg.loading": "Loading…",
    "reg.submit": "Register",
    "reg.step.check": "Checking", "reg.step.passkey": "Passkey", "reg.step.keys": "Keys", "reg.step.register": "Registering", "reg.step.sync": "Syncing",
    "reg.err.required": "Fill this in.",
    "reg.err.tooLong": "Too long — 64 characters at most.",
    "reg.err.name": "Letters only (with spaces, hyphens, apostrophes and dots).",
    "reg.err.country": "Choose a country from the list.",
    "reg.err.phone": "Enter a mobile number (6–15 digits).",
    "reg.err.notMobile": "This is not a mobile number.",
    "reg.err.phoneTaken": "This number is already registered.",
    "reg.err.email": "Enter a valid e-mail address.",
    "reg.err.noDomain": "This e-mail domain does not exist.",
    "reg.err.noMx": "This e-mail domain does not receive mail.",
    "reg.err.dns": "Couldn't verify the e-mail domain right now, try again.",
    "reg.err.emailTaken": "This e-mail is already registered.",
    "reg.err.invalid": "This is not valid.",
    "reg.err.fix": "Check the marked fields.",
    "reg.err.tooMany": "Too many attempts, wait a few minutes.",
    "reg.failed": "The registration failed: {reason}",
    "reg.takenHint": "Someone registered it meanwhile. The passkey “M5cet · {user}” created a moment ago is not used — you can delete it in your password manager.",
    "reg.done": "Registered · {user}",
    "reg.syncFailed": "The account {user} is registered, but your details could not be stored in its vault ({reason}).",
    "reg.already": "You are signed in as {user}.",
    "passkey.rpTitle": "This server hasn't confirmed the app",
    "passkey.rpText": "Passkeys on Android only work when the server {host} publishes https://{host}/.well-known/assetlinks.json listing this app. The server's operator can trust this app's certificate in Console › Android › Security › Passkeys — send them the fingerprint below.",
    "passkey.rpCert": "Certificate fingerprint (SHA-256)",
    "passkey.rpPackage": "Package",
    "passkey.rpCopy": "Copy fingerprint",
  },
  de: {
    "menu.register": "Registrierung",
    "set.user.register": "Registrieren",
    "reg.title": "Registrierung",
    "reg.intro": "Erstellen Sie ein M5cet-Konto mit Namen, Mobilnummer und E-Mail. Der Server prüft die Angaben und registriert das Konto; Ihre Kopie bleibt versiegelt im verschlüsselten Tresor des Kontos. Sie melden sich mit einem Passkey an — ohne Passwort.",
    "reg.firstName": "Vorname", "reg.lastName": "Nachname", "reg.country": "Land", "reg.phone": "Mobilnummer", "reg.email": "E-Mail",
    "reg.countryPick": "Land wählen", "reg.countrySearch": "Suchen: Name, Code oder +Vorwahl",
    "reg.countriesFailed": "Die Länder konnten nicht geladen werden — tippen, um es erneut zu versuchen.", "reg.loading": "Wird geladen…",
    "reg.submit": "Registrieren",
    "reg.step.check": "Prüfung", "reg.step.passkey": "Passkey", "reg.step.keys": "Schlüssel", "reg.step.register": "Registrierung", "reg.step.sync": "Synchronisierung",
    "reg.err.required": "Bitte ausfüllen.",
    "reg.err.tooLong": "Zu lang — höchstens 64 Zeichen.",
    "reg.err.name": "Nur Buchstaben (mit Leerzeichen, Bindestrichen, Apostrophen und Punkten).",
    "reg.err.country": "Wählen Sie ein Land aus der Liste.",
    "reg.err.phone": "Geben Sie eine Mobilnummer ein (6–15 Ziffern).",
    "reg.err.notMobile": "Das ist keine Mobilnummer.",
    "reg.err.phoneTaken": "Diese Nummer ist bereits registriert.",
    "reg.err.email": "Geben Sie eine gültige E-Mail-Adresse ein.",
    "reg.err.noDomain": "Diese E-Mail-Domain existiert nicht.",
    "reg.err.noMx": "Diese E-Mail-Domain empfängt keine E-Mails.",
    "reg.err.dns": "Die E-Mail-Domain konnte gerade nicht geprüft werden, versuchen Sie es erneut.",
    "reg.err.emailTaken": "Diese E-Mail ist bereits registriert.",
    "reg.err.invalid": "Das ist nicht gültig.",
    "reg.err.fix": "Prüfen Sie die markierten Felder.",
    "reg.err.tooMany": "Zu viele Versuche, warten Sie ein paar Minuten.",
    "reg.failed": "Die Registrierung ist fehlgeschlagen: {reason}",
    "reg.takenHint": "Das hat inzwischen jemand anderes registriert. Der eben erstellte Passkey „M5cet · {user}“ wird nicht verwendet — Sie können ihn im Passwortmanager löschen.",
    "reg.done": "Registriert · {user}",
    "reg.syncFailed": "Das Konto {user} ist registriert, aber Ihre Angaben konnten nicht in seinem Tresor gespeichert werden ({reason}).",
    "reg.already": "Sie sind als {user} angemeldet.",
    "passkey.rpTitle": "Der Server hat diese App nicht bestätigt",
    "passkey.rpText": "Passkeys funktionieren unter Android nur, wenn der Server {host} die Datei https://{host}/.well-known/assetlinks.json mit dieser App veröffentlicht. Der Betreiber des Servers kann dem Zertifikat der App in Console › Android › Security › Passkeys vertrauen — senden Sie ihm den Fingerabdruck unten.",
    "passkey.rpCert": "Zertifikat-Fingerabdruck (SHA-256)",
    "passkey.rpPackage": "Paket",
    "passkey.rpCopy": "Fingerabdruck kopieren",
  },
};
