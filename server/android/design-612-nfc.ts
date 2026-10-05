// 6.12 design area: the NFC connection tag v2 (docs/protocol-v4.md § 16,
// F-12) in the app — texts only; the views are native (android/…/ui/parts/
// ConnTagUi, the NFC panel and the workbench's "Open / Write connection"):
//
//   writing    the writer chooses an invitation (recommended: the room key
//              stays on the server, sealed; the tag ends after 10 uses or 7
//              days) or an offline tag (the room on the tag under a code of 20
//              symbols that is not on it — shown once); format 1 (a PIN) is
//              never written again
//   reading    an invitation is opened with this app's server (another
//              server's: "open M5cet there"), an offline tag with its code, an
//              old format-1 tag with its PIN — marked weak, with "rewrite as a
//              new tag"
//
// English fallbacks live in the app (chat/P4Texts) for a published design
// older than 6.12. One area of the 6.12 design (design-612.ts gathers them).

import type { DesignArea } from "./design-67";

const T = (cs: string, en: string, de: string) => ({ cs, en, de });

const STR: Record<string, { cs: string; en: string; de: string }> = {
  "nfc.v2.kind.title": T("Jak má štítek fungovat?", "How should the tag work?", "Wie soll der Tag funktionieren?"),
  "nfc.v2.kind.inv": T(
    "Pozvánka (doporučeno) — klíč místnosti zůstane na serveru; štítek přestane platit po 10 použitích nebo 7 dnech",
    "Invitation (recommended) — the room key stays on the server; the tag ends after 10 uses or 7 days",
    "Einladung (empfohlen) — der Raumschlüssel bleibt auf dem Server; der Tag endet nach 10 Nutzungen oder 7 Tagen",
  ),
  "nfc.v2.kind.off": T(
    "Offline — místnost na štítku, otevře ji kód, který předáte zvlášť",
    "Offline — the room on the tag, opened with a code you give separately",
    "Offline — der Raum auf dem Tag, geöffnet mit einem Code, den Sie getrennt weitergeben",
  ),
  "nfc.v2.preparing": T("Připravuji štítek…", "Preparing the tag…", "Der Tag wird vorbereitet…"),
  "nfc.v2.code.title": T("Kód štítku", "The tag's code", "Der Code des Tags"),
  "nfc.v2.code.text": T(
    "Tento kód předejte tomu, kdo se smí připojit — řekněte ho nebo zapište. Na štítku není, nikde se neuchová a ukáže se jen teď.",
    "Give this code to whoever may join — say it or write it down. It is not on the tag, nothing keeps it, and it is shown only now.",
    "Geben Sie diesen Code an, wer beitreten darf — sagen oder aufschreiben. Er steht nicht auf dem Tag, wird nirgends gespeichert und nur jetzt gezeigt.",
  ),
  "nfc.v2.code.done": T("Mám ho — zapsat štítek", "I have it — write the tag", "Notiert — Tag schreiben"),
  "nfc.v2.codeHint": T("Kód (nové štítky) nebo PIN (staré štítky)", "Code (new tags) or PIN (old tags)", "Code (neue Tags) oder PIN (alte Tags)"),
  "nfc.v2.invite": T("Pozvánka (štítek)", "Invitation tag", "Einladungs-Tag"),
  "nfc.v2.offline": T("Offline štítek", "Offline tag", "Offline-Tag"),
  "nfc.v2.old": T("Starý štítek připojení (PIN)", "Old connection tag (PIN)", "Alter Verbindungs-Tag (PIN)"),
  "nfc.v2.weak": T(
    "Slabý: kdo tento štítek někdy přečetl, může jeho PIN uhodnout offline. Přepište ho na nový štítek.",
    "Weak: anyone who has read this tag can guess its PIN offline. Rewrite it as a new tag.",
    "Schwach: Wer diesen Tag einmal gelesen hat, kann seine PIN offline erraten. Schreiben Sie ihn als neuen Tag neu.",
  ),
  "nfc.v2.rewrite": T("Přepsat na nový štítek", "Rewrite as a new tag", "Als neuen Tag neu schreiben"),
  "nfc.v2.needCode": T("Napište kód, který jste k tomuto štítku dostali, a stiskněte Otevřít.", "Type the code you were given for this tag, then Open.", "Geben Sie den Code ein, den Sie zu diesem Tag erhalten haben, dann Öffnen."),
  "nfc.v2.needPin": T("Starý štítek: napište jeho PIN a stiskněte Otevřít.", "Old tag: type its PIN, then Open.", "Alter Tag: Geben Sie seine PIN ein, dann Öffnen."),
  "nfc.v2.needRedeem": T(
    "Pozvánka: Otevřít se zeptá serveru (spotřebuje jedno z jejích použití).",
    "An invitation: Open asks the server (it uses one of the invitation's uses).",
    "Eine Einladung: Öffnen fragt den Server (verbraucht eine ihrer Nutzungen).",
  ),
  "nfc.v2.open": T("Otevřít", "Open", "Öffnen"),
  "nfc.v2.opening": T("Otevírám štítek…", "Opening the tag…", "Der Tag wird geöffnet…"),
  "nfc.v2.err.wrong-code": T("Špatný kód, nebo byl štítek změněn.", "Wrong code, or the tag was changed.", "Falscher Code, oder der Tag wurde verändert."),
  "nfc.v2.err.bad-code": T("Kód má 20 znaků (písmena a číslice).", "The code has 20 characters (letters and digits).", "Der Code hat 20 Zeichen (Buchstaben und Ziffern)."),
  "nfc.v2.err.other-server": T(
    "Tato pozvánka patří jinému serveru ({origin}) — otevřete M5cet tam.",
    "This invitation is for another server ({origin}) — open M5cet there.",
    "Diese Einladung gehört zu einem anderen Server ({origin}) — öffnen Sie M5cet dort.",
  ),
  "nfc.v2.err.burned": T("Pozvánka je vyčerpaná nebo ukončená.", "The invitation has been used up or ended.", "Die Einladung ist aufgebraucht oder beendet."),
  "nfc.v2.err.not-found": T("Pozvánka už neexistuje (vypršela nebo byla ukončena).", "The invitation no longer exists (it expired or was ended).", "Die Einladung existiert nicht mehr (abgelaufen oder beendet)."),
  "nfc.v2.err.network": T("Server není dostupný.", "The server could not be reached.", "Der Server ist nicht erreichbar."),
  "nfc.v2.err.bad-tag": T("Štítek je poškozený nebo to není štítek připojení.", "The tag is damaged or not a connection tag.", "Der Tag ist beschädigt oder kein Verbindungs-Tag."),
  "nfc.v2.err.corrupt": T("Pozvánku nelze otevřít.", "The invitation cannot be opened.", "Die Einladung lässt sich nicht öffnen."),
};

const strings = { cs: {} as Record<string, string>, en: {} as Record<string, string>, de: {} as Record<string, string> };
for (const [key, v] of Object.entries(STR)) { strings.cs[key] = v.cs; strings.en[key] = v.en; strings.de[key] = v.de; }

export const AREA: DesignArea = { strings };
