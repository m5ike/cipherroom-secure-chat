// What the server says on a phone call (6.13): the bridge's prompts, the
// spoken apologies of a TSA, the notices a member gets when a call goes to
// text — in the nine languages of the contract (client/src/lib/locales.ts)
// and Polish (a TSA's Start offers pl-PL). A language is a code ("sk") or a
// provider tag ("sk-SK"); anything else speaks English.

/** The provider language (TTS / STT tag) of each language — Twilio, Telnyx and Vonage take these BCP 47 tags. */
export const PHONE_LANGUAGES: Readonly<Record<string, string>> = {
  cs: "cs-CZ", en: "en-US", de: "de-DE", es: "es-ES", it: "it-IT", fr: "fr-FR", sk: "sk-SK", sl: "sl-SI", fi: "fi-FI", pl: "pl-PL",
};

/** A language code or tag → the provider's tag by its language ("sk" → "sk-SK", "en-GB" → "en-US" as before 6.13); an unknown one as it is. */
export const phoneLanguage = (lang: string): string => PHONE_LANGUAGES[String(lang).slice(0, 2).toLowerCase()] ?? (String(lang) || "en-US");

type Spoken = Record<string, string>;
const L = (en: string, cs: string, de: string, es: string, it: string, fr: string, sk: string, sl: string, fi: string, pl?: string): Spoken => ({ en, cs, de, es, it, fr, sk, sl, fi, ...(pl ? { pl } : {}) });

export const SPEECH = {
  /** The bridge (bridge.ts): a caller types the member's 5-digit code. */
  prompt: L(
    "Hello. Please enter your five-digit access code followed by the pound key.",
    "Dobrý den. Zadejte pětimístný přístupový kód a stiskněte mřížku.",
    "Guten Tag. Bitte geben Sie den fünfstelligen Zugangscode ein und drücken Sie die Raute-Taste.",
    "Hola. Introduce el código de acceso de cinco dígitos y pulsa la tecla almohadilla.",
    "Buongiorno. Inserisci il codice di accesso di cinque cifre e premi il tasto cancelletto.",
    "Bonjour. Saisissez le code d’accès à cinq chiffres, puis appuyez sur la touche dièse.",
    "Dobrý deň. Zadajte päťmiestny prístupový kód a stlačte mriežku.",
    "Pozdravljeni. Vnesite petmestno dostopno kodo in pritisnite lojtro.",
    "Hei. Näppäile viisinumeroinen pääsykoodi ja paina risuaitaa.",
  ),
  wrong: L(
    "That code is not right. Please try again.",
    "Nesprávný kód. Zkuste to znovu.",
    "Der Code ist nicht richtig. Bitte versuchen Sie es noch einmal.",
    "El código no es correcto. Inténtalo de nuevo.",
    "Il codice non è corretto. Riprova.",
    "Le code n’est pas correct. Veuillez réessayer.",
    "Nesprávny kód. Skúste to znova.",
    "Koda ni pravilna. Poskusite znova.",
    "Koodi ei ole oikein. Yritä uudelleen.",
  ),
  bye: L(
    "The code was not entered correctly. Goodbye.",
    "Kód nebyl zadán správně. Na shledanou.",
    "Der Code wurde nicht richtig eingegeben. Auf Wiederhören.",
    "El código no se introdujo correctamente. Adiós.",
    "Il codice non è stato inserito correttamente. Arrivederci.",
    "Le code n’a pas été saisi correctement. Au revoir.",
    "Kód nebol zadaný správne. Dovidenia.",
    "Koda ni bila pravilno vnesena. Nasvidenje.",
    "Koodia ei näppäilty oikein. Näkemiin.",
  ),
  connecting: L("Connecting.", "Spojuji.", "Ich verbinde.", "Conectando.", "Ti metto in contatto.", "Mise en relation.", "Spájam.", "Povezujem.", "Yhdistetään."),
  gone: L(
    "This number is not connecting anyone right now. Goodbye.",
    "Toto číslo teď nikoho nespojí. Na shledanou.",
    "Diese Nummer verbindet gerade niemanden. Auf Wiederhören.",
    "Este número no conecta con nadie en este momento. Adiós.",
    "Questo numero al momento non mette in contatto nessuno. Arrivederci.",
    "Ce numéro ne met personne en relation pour le moment. Au revoir.",
    "Toto číslo teraz nikoho nespojí. Dovidenia.",
    "Ta številka trenutno ne povezuje nikogar. Nasvidenje.",
    "Tämä numero ei yhdistä nyt ketään. Näkemiin.",
  ),
  ended: L("The call has ended.", "Hovor skončil.", "Das Gespräch ist beendet.", "La llamada ha terminado.", "La chiamata è terminata.", "L’appel est terminé.", "Hovor sa skončil.", "Klic je končan.", "Puhelu on päättynyt."),
  /** A TSA's call ends on an error (tsa/runtime.ts). */
  apology: L(
    "We are sorry, something went wrong. Goodbye.",
    "Omlouváme se, nastala chyba. Na shledanou.",
    "Entschuldigung, ein Fehler ist aufgetreten. Auf Wiederhören.",
    "Lo sentimos, se ha producido un error. Adiós.",
    "Ci scusiamo, si è verificato un errore. Arrivederci.",
    "Nous sommes désolés, une erreur s’est produite. Au revoir.",
    "Ospravedlňujeme sa, nastala chyba. Dovidenia.",
    "Opravičujemo se, prišlo je do napake. Nasvidenje.",
    "Pahoittelemme, tapahtui virhe. Näkemiin.",
    "Przepraszamy, wystąpił błąd. Do widzenia.",
  ),
  /** Too many wrong route codes at a TSA's Route audio. */
  tooManyCodes: L(
    "Too many wrong codes. Goodbye.",
    "Příliš mnoho chybných kódů. Na shledanou.",
    "Zu viele falsche Codes. Auf Wiederhören.",
    "Demasiados códigos incorrectos. Adiós.",
    "Troppi codici errati. Arrivederci.",
    "Trop de codes erronés. Au revoir.",
    "Príliš veľa chybných kódov. Dovidenia.",
    "Preveč napačnih kod. Nasvidenje.",
    "Liian monta väärää koodia. Näkemiin.",
    "Zbyt wiele błędnych kodów. Do widzenia.",
  ),
  /** The member's notice when a bridged call goes to text (bridge.ts). */
  bridgeText: L(
    "the call is transcribed; answer in writing",
    "hovor se přepisuje do textu; odpovězte zprávou",
    "der Anruf wird in Text umgewandelt; antworten Sie schriftlich",
    "la llamada se transcribe; responde por escrito",
    "la chiamata viene trascritta; rispondi per iscritto",
    "l’appel est transcrit ; répondez par écrit",
    "hovor sa prepisuje do textu; odpovedzte správou",
    "klic se prepisuje v besedilo; odgovorite pisno",
    "puhelu muutetaan tekstiksi; vastaa kirjoittamalla",
  ),
  /** The room's notice when a routed call goes to text (route-audio.ts). */
  routeText: L(
    "the phone call is transcribed; answer in writing on the call's card",
    "telefonní hovor se přepisuje do textu; odpovězte zprávou na kartě hovoru",
    "der Telefonanruf wird in Text umgewandelt; antworten Sie schriftlich auf der Karte des Anrufs",
    "la llamada telefónica se transcribe; responde por escrito en la tarjeta de la llamada",
    "la telefonata viene trascritta; rispondi per iscritto nella scheda della chiamata",
    "l’appel téléphonique est transcrit ; répondez par écrit sur la carte de l’appel",
    "telefonický hovor sa prepisuje do textu; odpovedzte správou na karte hovoru",
    "telefonski klic se prepisuje v besedilo; odgovorite pisno na kartici klica",
    "puhelu muutetaan tekstiksi; vastaa kirjoittamalla puhelun kortilla",
  ),
} as const;

export type SpeechKey = keyof typeof SPEECH;

/** A text in a language (code or tag); English when the language has none. */
export function speech(key: SpeechKey, lang: string): string {
  const table: Spoken = SPEECH[key];
  return table[String(lang).slice(0, 2).toLowerCase()] ?? table.en;
}
