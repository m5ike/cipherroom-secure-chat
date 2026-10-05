// The language of what the server itself says to a person (6.13): a
// notification, the e-mail confirming an address, the page its link opens,
// the invitation's goodbye page. The contract is client/src/lib/locales.ts;
// a request says what it wants in Accept-Language, a user's choice
// (Settings › Notifications › language) wins where there is one.

import type { Request } from "express";
import { isLocale, pickLocale, type Locale } from "../../client/src/lib/locales";

/** The first supported language an Accept-Language header names, or null (pickLocale's rule, without its fallback). */
export function acceptedLocale(header: string | null | undefined): Locale | null {
  if (!header) return null;
  for (const raw of header.split(",").slice(0, 20)) {
    const code = raw.trim().split(";")[0].toLowerCase().split(/[-_]/)[0];
    if (isLocale(code)) return code;
  }
  return null;
}

/** A request's language: its Accept-Language, else `fallback`. */
export function requestLocale(req: Pick<Request, "header">, fallback: Locale = "en"): Locale {
  return pickLocale(String(req.header("accept-language") ?? "").slice(0, 400), fallback);
}

type Texts = Record<Locale, string>;
const T = (en: string, cs: string, de: string, es: string, it: string, fr: string, sk: string, sl: string, fi: string): Texts => ({ en, cs, de, es, it, fr, sk, sl, fi });
const NB = " ";

/** What the e-mail channel's own messages say ({app}: the server's name). */
export const NOTIFY_TEXTS = {
  confirmedTitle: T("E-mail confirmed", "E-mail potvrzen", "E-Mail bestätigt", "Correo electrónico confirmado", "E-mail confermata", "Adresse e-mail confirmée", "E-mail potvrdený", "E-poštni naslov potrjen", "Sähköposti vahvistettu"),
  confirmedText: T(
    "Notifications may now come to this address. You can close this page.",
    "Upozornění teď mohou chodit na tuto adresu. Stránku můžete zavřít.",
    "Benachrichtigungen können jetzt an diese Adresse gehen. Sie können diese Seite schließen.",
    "Ahora las notificaciones pueden llegar a esta dirección. Puedes cerrar esta página.",
    "Ora le notifiche possono arrivare a questo indirizzo. Puoi chiudere questa pagina.",
    "Les notifications peuvent désormais arriver à cette adresse. Vous pouvez fermer cette page.",
    "Upozornenia teraz môžu chodiť na túto adresu. Stránku môžete zavrieť.",
    "Obvestila lahko zdaj prihajajo na ta naslov. To stran lahko zaprete.",
    "Ilmoitukset voivat nyt tulla tähän osoitteeseen. Tämän sivun voi sulkea.",
  ),
  brokenTitle: T("This link does not work", "Tento odkaz nefunguje", "Dieser Link funktioniert nicht", "Este enlace no funciona", "Questo link non funziona", "Ce lien ne fonctionne pas", "Tento odkaz nefunguje", "Ta povezava ne deluje", "Tämä linkki ei toimi"),
  brokenText: T(
    "The link is old, was used already, or is not complete.",
    "Odkaz je starý, už byl použit, nebo není celý.",
    "Der Link ist alt, wurde schon benutzt oder ist unvollständig.",
    "El enlace es antiguo, ya se usó o no está completo.",
    "Il link è vecchio, è già stato usato o non è completo.",
    "Le lien est ancien, a déjà été utilisé ou est incomplet.",
    "Odkaz je starý, už bol použitý alebo nie je celý.",
    "Povezava je stara, je bila že uporabljena ali ni popolna.",
    "Linkki on vanha, sitä on jo käytetty tai se on vajaa.",
  ),
  mailSubject: T(
    "{app}: confirm notifications by e-mail",
    "{app}: potvrzení upozornění e-mailem",
    "{app}: Benachrichtigungen per E-Mail bestätigen",
    "{app}: confirma las notificaciones por correo electrónico",
    "{app}: conferma le notifiche via e-mail",
    `{app}${NB}: confirmez les notifications par e-mail`,
    "{app}: potvrdenie upozornení e-mailom",
    "{app}: potrditev obvestil po e-pošti",
    "{app}: vahvista ilmoitukset sähköpostitse",
  ),
  mailIntro: T(
    "Open this link to receive {app} notifications at this address:",
    "Otevřete tento odkaz, chcete-li dostávat upozornění {app} na tuto adresu:",
    "Öffnen Sie diesen Link, um {app}-Benachrichtigungen an diese Adresse zu erhalten:",
    "Abre este enlace para recibir las notificaciones de {app} en esta dirección:",
    "Apri questo link per ricevere le notifiche di {app} a questo indirizzo:",
    `Ouvrez ce lien pour recevoir les notifications de {app} à cette adresse${NB}:`,
    "Otvorte tento odkaz, ak chcete dostávať upozornenia {app} na túto adresu:",
    "Odprite to povezavo, da boste prejemali obvestila {app} na ta naslov:",
    "Avaa tämä linkki, niin {app}-ilmoitukset tulevat tähän osoitteeseen:",
  ),
  mailIgnore: T(
    "If you did not ask for it, ignore this mail; nothing will be sent.",
    "Pokud jste o to nežádali, e-mail ignorujte; nic se posílat nebude.",
    "Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail; es wird nichts gesendet.",
    "Si no lo has pedido, ignora este correo; no se enviará nada.",
    "Se non l’hai richiesto, ignora questa e-mail; non verrà inviato nulla.",
    `Si vous ne l’avez pas demandé, ignorez ce message${NB}; rien ne sera envoyé.`,
    "Ak ste o to nežiadali, e-mail ignorujte; nič sa posielať nebude.",
    "Če tega niste zahtevali, prezrite to sporočilo; nič ne bo poslano.",
    "Jos tätä ei pyydetty, viestin voi jättää huomiotta; mitään ei lähetetä.",
  ),
} as const satisfies Record<string, Texts>;

export type NotifyTextKey = keyof typeof NOTIFY_TEXTS;

/** A text in a language, "{app}" filled in. */
export function notifyText(key: NotifyTextKey, lang: Locale, app = "M5cet"): string {
  return (NOTIFY_TEXTS[key][lang] ?? NOTIFY_TEXTS[key].en).replaceAll("{app}", app);
}
