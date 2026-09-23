// Strings for crypto version 2 and protocol version 2: sender identity,
// key checks, sealed signaling, session revocation, rate limits.

type Dict = Record<string, string>;

const cs: Dict = {
  "sec.identity": "Identita odesílatele",
  "sec.identity.verified": "Ověřeno podpisem · {fp}",
  "sec.identity.account": "Ověřený účet (potvrzuje i toto zařízení) · {fp}",
  "sec.identity.changed": "POZOR: jiný klíč než dříve pro toto jméno · {fp}",
  "sec.identity.unsigned": "Nepodepsáno (starší klient)",
  "sec.identity.invalid": "Podpis nesouhlasí — zpráva mohla být podvržena",
  "sec.identity.changedFlash": "{name} píše s jiným klíčem zařízení než dříve. Ověřte si bezpečnostní číslo mimo aplikaci.",
  "sec.identity.invalidFlash": "Zpráva od „{name}“ má neplatný podpis — nezobrazuje se jako ověřená.",
  "sec.keyMismatch": "{name} má jiný klíč místnosti (jiné heslo). Vaše zprávy si navzájem nepřečtete.",
  "sec.legacyPeer": "{name} používá starší verzi aplikace (šifrování v1, bez podpisů).",
  "sec.unsealedSignal": "Signalizace od {name} není zapečetěná — hovor s ním není chráněn proti serveru (starší klient).",
  "sec.cipher": "AES-GCM 256 · šifrování v{v}",
  "sec.myFingerprint": "Otisk tohoto zařízení",
  "proto.revoked": "Relace účtu byla na serveru ukončena ({reason}). Přihlaste se znovu.",
  "proto.rateLimited": "Příliš mnoho požadavků ({frame}) — zkuste to za chvíli.",
  "proto.closedByServer": "Server ukončil spojení: {reason}",
  "proto.dropped": "Zpráva od {name} byla zahozena (neplatný nebo opakovaný obsah).",
  "file.verified": "Soubor {name} ověřen — otisk celého souboru a podpis odesílatele sedí.",
  "file.unverified": "Soubor {name} přišel od staršího klienta — bez ověření otisku.",
};

const en: Dict = {
  "sec.identity": "Sender identity",
  "sec.identity.verified": "Verified by signature · {fp}",
  "sec.identity.account": "Verified account (vouches for this device) · {fp}",
  "sec.identity.changed": "WARNING: a different key than before for this name · {fp}",
  "sec.identity.unsigned": "Unsigned (older client)",
  "sec.identity.invalid": "Signature does not verify — the message may be forged",
  "sec.identity.changedFlash": "{name} is writing with a different device key than before. Compare safety numbers outside the app.",
  "sec.identity.invalidFlash": "A message from “{name}” has an invalid signature — it is not shown as verified.",
  "sec.keyMismatch": "{name} has a different room key (another passphrase). You cannot read each other's messages.",
  "sec.legacyPeer": "{name} runs an older version of the app (encryption v1, no signatures).",
  "sec.unsealedSignal": "Signaling from {name} is not sealed — a call with them is not protected from the server (older client).",
  "sec.cipher": "AES-GCM 256 · encryption v{v}",
  "sec.myFingerprint": "This device's fingerprint",
  "proto.revoked": "The server ended this account session ({reason}). Sign in again.",
  "proto.rateLimited": "Too many requests ({frame}) — try again in a moment.",
  "proto.closedByServer": "The server closed the connection: {reason}",
  "proto.dropped": "A message from {name} was dropped (invalid or repeated content).",
  "file.verified": "File {name} verified — the whole-file digest and the sender's signature match.",
  "file.unverified": "File {name} came from an older client — its digest was not verified.",
};

const de: Dict = {
  "sec.identity": "Identität des Absenders",
  "sec.identity.verified": "Per Signatur bestätigt · {fp}",
  "sec.identity.account": "Bestätigtes Konto (bürgt für dieses Gerät) · {fp}",
  "sec.identity.changed": "ACHTUNG: anderer Schlüssel als zuvor für diesen Namen · {fp}",
  "sec.identity.unsigned": "Unsigniert (älterer Client)",
  "sec.identity.invalid": "Signatur ungültig — die Nachricht könnte gefälscht sein",
  "sec.identity.changedFlash": "{name} schreibt mit einem anderen Geräteschlüssel als zuvor. Sicherheitsnummer außerhalb der App vergleichen.",
  "sec.identity.invalidFlash": "Eine Nachricht von „{name}“ hat eine ungültige Signatur — sie wird nicht als bestätigt angezeigt.",
  "sec.keyMismatch": "{name} hat einen anderen Raumschlüssel (anderes Passwort). Ihr könnt eure Nachrichten nicht lesen.",
  "sec.legacyPeer": "{name} nutzt eine ältere App-Version (Verschlüsselung v1, ohne Signaturen).",
  "sec.unsealedSignal": "Die Signalisierung von {name} ist nicht versiegelt — ein Anruf ist nicht gegen den Server geschützt (älterer Client).",
  "sec.cipher": "AES-GCM 256 · Verschlüsselung v{v}",
  "sec.myFingerprint": "Fingerabdruck dieses Geräts",
  "proto.revoked": "Der Server hat diese Kontositzung beendet ({reason}). Bitte erneut anmelden.",
  "proto.rateLimited": "Zu viele Anfragen ({frame}) — gleich noch einmal versuchen.",
  "proto.closedByServer": "Der Server hat die Verbindung beendet: {reason}",
  "proto.dropped": "Eine Nachricht von {name} wurde verworfen (ungültiger oder wiederholter Inhalt).",
  "file.verified": "Datei {name} geprüft — Prüfsumme der ganzen Datei und Signatur des Absenders stimmen.",
  "file.unverified": "Datei {name} kam von einem älteren Client — ohne Prüfung der Prüfsumme.",
};

export const SECURITY_I18N = { cs, en, de } as const;
