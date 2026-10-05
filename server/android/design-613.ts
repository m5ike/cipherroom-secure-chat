// The Android design, 6.13: nine languages. What the app's Java side used
// to say in English only (the outputs' words, NFC readers' notes and errors,
// a file that cannot go, a room's notices, the language picker's "as the
// phone") is a design text now, in all nine languages — and the texts shown
// with a count get their plural forms ("key#one", "key#few", "key#other" …;
// the app picks one with the language's plural rules — core/Plurals.java —
// and falls back to the plain key).
//
// The translators' tables (i18n/locales/<lang>/android.json) cover the keys
// of 6.12's design (i18n/source/android.json); these keys are new, so their
// texts for every language live here.

import type { Locale } from "../../client/src/lib/locales";

type Texts = Record<Locale, string>;
const T = (en: string, cs: string, de: string, es: string, it: string, fr: string, sk: string, sl: string, fi: string): Texts => ({ en, cs, de, es, it, fr, sk, sl, fi });

/** French: a narrow no-break space is not used — a no-break space (U+00A0) before : ; ! ? and inside « ». */
const NB = " ";

const TEXTS: Record<string, Texts> = {
  /* ------------------------------------------------ the language picker */
  "settings.languageSystem": T("As the phone", "Podle telefonu", "Wie das Telefon", "Como el teléfono", "Come il telefono", "Comme le téléphone", "Podľa telefónu", "Kot v telefonu", "Puhelimen mukaan"),

  /* ------------------------------------- the outputs' words (fn/Words) */
  "fnui.submit": T("Send", "Odeslat", "Senden", "Enviar", "Invia", "Envoyer", "Odoslať", "Pošlji", "Lähetä"),
  "fnui.sending": T("Sending…", "Odesílám…", "Wird gesendet…", "Enviando…", "Invio…", "Envoi…", "Odosielam…", "Pošiljam…", "Lähetetään…"),
  "fnui.sent": T("Sent", "Odesláno", "Gesendet", "Enviado", "Inviato", "Envoyé", "Odoslané", "Poslano", "Lähetetty"),
  "fnui.required": T("Required", "Povinné pole", "Pflichtfeld", "Obligatorio", "Obbligatorio", "Obligatoire", "Povinné pole", "Obvezno", "Pakollinen"),
  "fnui.invalid": T("Not a valid value", "Neplatná hodnota", "Ungültiger Wert", "Valor no válido", "Valore non valido", "Valeur non valide", "Neplatná hodnota", "Neveljavna vrednost", "Virheellinen arvo"),
  "fnui.email": T("Enter an e-mail address", "Zadejte e-mailovou adresu", "Geben Sie eine E-Mail-Adresse ein", "Escribe una dirección de correo electrónico", "Inserisci un indirizzo e-mail", "Saisissez une adresse e-mail", "Zadajte e-mailovú adresu", "Vnesite e-poštni naslov", "Anna sähköpostiosoite"),
  "fnui.number": T("Enter a number", "Zadejte číslo", "Geben Sie eine Zahl ein", "Escribe un número", "Inserisci un numero", "Saisissez un nombre", "Zadajte číslo", "Vnesite število", "Anna numero"),
  "fnui.incomplete": T("Fill in the whole value", "Doplňte celou hodnotu", "Vervollständigen Sie den Wert", "Completa el valor", "Completa il valore", "Complétez la valeur", "Doplňte celú hodnotu", "Izpolnite celotno vrednost", "Täytä koko arvo"),
  "fnui.choose": T("Choose…", "Vyberte…", "Auswählen…", "Elige…", "Scegli…", "Choisir…", "Vyberte…", "Izberite…", "Valitse…"),
  "fnui.confirm": T("Sure?", "Opravdu?", "Sicher?", "¿Seguro?", "Sicuro?", `Vous êtes sûr${NB}?`, "Naozaj?", "Ste prepričani?", "Varmasti?"),
  "fnui.noEvent": T("This model does not answer {what}.", "Tento model na {what} neodpovídá.", "Dieses Modell beantwortet keine {what}.", "Este modelo no responde a {what}.", "Questo modello non risponde a {what}.", "Ce modèle ne répond pas aux {what}.", "Tento model na {what} neodpovedá.", "Ta model se ne odziva na {what}.", "Tämä malli ei vastaa näihin: {what}."),
  "fnui.what.button": T("buttons", "tlačítka", "Schaltflächen", "botones", "pulsanti", "boutons", "tlačidlá", "gumbe", "painikkeet"),
  "fnui.what.form": T("forms", "formuláře", "Formulare", "formularios", "moduli", "formulaires", "formuláre", "obrazce", "lomakkeet"),
  "fnui.renderFailed": T("This part of the result could not be shown ({message}).", "Tuto část výsledku se nepodařilo zobrazit ({message}).", "Dieser Teil des Ergebnisses konnte nicht angezeigt werden ({message}).", "No se pudo mostrar esta parte del resultado ({message}).", "Non è stato possibile mostrare questa parte del risultato ({message}).", "Cette partie du résultat n’a pas pu être affichée ({message}).", "Túto časť výsledku sa nepodarilo zobraziť ({message}).", "Tega dela rezultata ni bilo mogoče prikazati ({message}).", "Tätä tuloksen osaa ei voitu näyttää ({message})."),
  "fnui.play": T("Play", "Přehrát", "Abspielen", "Reproducir", "Riproduci", "Lire", "Prehrať", "Predvajaj", "Toista"),
  "fnui.download": T("Download", "Stáhnout", "Herunterladen", "Descargar", "Scarica", "Télécharger", "Stiahnuť", "Prenesi", "Lataa"),
  "fnui.open": T("Open", "Otevřít", "Öffnen", "Abrir", "Apri", "Ouvrir", "Otvoriť", "Odpri", "Avaa"),
  "fnui.webOnly": T("Opens in the web app", "Otevře se ve webové aplikaci", "Öffnet sich in der Web-App", "Se abre en la app web", "Si apre nell’app web", "S’ouvre dans l’application web", "Otvorí sa vo webovej aplikácii", "Odpre se v spletni aplikaciji", "Avautuu verkkosovelluksessa"),
  "functions.send": T("Send", "Odeslat", "Senden", "Enviar", "Invia", "Envoyer", "Odoslať", "Pošlji", "Lähetä"),
  "functions.cancel": T("Cancel", "Zrušit", "Abbrechen", "Cancelar", "Annulla", "Annuler", "Zrušiť", "Prekliči", "Peruuta"),
  "fnm.err.incomplete": T("The answer stopped before it was complete.", "Odpověď se přerušila dřív, než byla celá.", "Die Antwort brach ab, bevor sie vollständig war.", "La respuesta se interrumpió antes de completarse.", "La risposta si è interrotta prima di essere completa.", "La réponse s’est arrêtée avant d’être complète.", "Odpoveď sa prerušila skôr, než bola celá.", "Odgovor se je ustavil, preden je bil dokončan.", "Vastaus katkesi ennen kuin se oli valmis."),
  "fnm.err.aiFailed": T("The AI call failed.", "Volání AI se nezdařilo.", "Der AI-Aufruf ist fehlgeschlagen.", "La llamada a la AI ha fallado.", "La chiamata AI non è riuscita.", "L’appel à l’AI a échoué.", "Volanie AI zlyhalo.", "Klic AI ni uspel.", "AI-kutsu epäonnistui."),

  /* ------------------------------------------------ media (TalkBack) */
  "media.a11y.video": T("video", "video", "Video", "vídeo", "video", "vidéo", "video", "video", "video"),
  "media.a11y.audio": T("audio", "zvuk", "Audio", "audio", "audio", "audio", "zvuk", "zvok", "ääni"),
  "media.a11y.play": T("play", "přehrát", "abspielen", "reproducir", "riproduci", "lire", "prehrať", "predvajaj", "toista"),
  "media.a11y.pause": T("pause", "pozastavit", "pausieren", "pausa", "pausa", "pause", "pozastaviť", "premor", "tauko"),

  /* ------------------------------------------- files, room notices */
  "file.err.nobody": T("nobody to send it to", "není komu ho poslat", "niemand, an den es gehen kann", "no hay nadie a quien enviarlo", "non c’è nessuno a cui inviarlo", "personne à qui l’envoyer", "nie je komu ho poslať", "ni nikogar, ki bi mu ga poslali", "ei ketään, jolle lähettää"),
  "file.err.noAnswer": T("the room did not answer", "místnost neodpověděla", "der Raum hat nicht geantwortet", "la sala no respondió", "la stanza non ha risposto", "la salle n’a pas répondu", "miestnosť neodpovedala", "soba se ni odzvala", "huone ei vastannut"),
  "file.err.securing": T("the connections are still being secured — try again in a moment", "spojení se ještě zabezpečují — zkuste to za chvíli znovu", "die Verbindungen werden noch gesichert — versuchen Sie es gleich noch einmal", "las conexiones aún se están protegiendo; inténtalo de nuevo en un momento", "le connessioni sono ancora in fase di protezione: riprova tra un attimo", "les connexions sont encore en cours de sécurisation — réessayez dans un instant", "spojenia sa ešte zabezpečujú — skúste to o chvíľu znova", "povezave se še zavarujejo — poskusite znova čez trenutek", "yhteyksiä suojataan vielä — yritä hetken päästä uudelleen"),
  "room.replaced": T("replaced by a newer connection", "nahrazeno novějším připojením", "durch eine neuere Verbindung ersetzt", "sustituida por una conexión más reciente", "sostituita da una connessione più recente", "remplacée par une connexion plus récente", "nahradené novším pripojením", "zamenjano z novejšo povezavo", "korvattu uudemmalla yhteydellä"),
  "room.closedByServer": T("closed by the server", "ukončeno serverem", "vom Server geschlossen", "cerrada por el servidor", "chiusa dal server", "fermée par le serveur", "ukončené serverom", "zaprl strežnik", "palvelin sulki yhteyden"),
  "room.rateLimited": T("rate limited: {0}", "příliš rychle, server omezil: {0}", "Rate begrenzt: {0}", "límite de frecuencia: {0}", "limite di frequenza: {0}", `limite de fréquence${NB}: {0}`, "príliš rýchlo, server obmedzil: {0}", "omejitev hitrosti: {0}", "nopeusrajoitus: {0}"),

  /* ------------------------------------------------------- NFC: M5 cards */
  "nfc.m5.needsAccount": T("This record needs your account (sign in on this device).", "Tento záznam potřebuje váš účet (přihlaste se na tomto zařízení).", "Dieser Datensatz braucht Ihr Konto (melden Sie sich auf diesem Gerät an).", "Este registro necesita tu cuenta (inicia sesión en este dispositivo).", "Questo record richiede il tuo account (accedi su questo dispositivo).", "Cet enregistrement nécessite votre compte (connectez-vous sur cet appareil).", "Tento záznam potrebuje váš účet (prihláste sa na tomto zariadení).", "Ta zapis potrebuje vaš račun (prijavite se v tej napravi).", "Tämä tietue vaatii tilin (kirjaudu sisään tällä laitteella)."),
  "nfc.m5.needsPin": T("This record needs a PIN.", "Tento záznam potřebuje PIN.", "Dieser Datensatz braucht eine PIN.", "Este registro necesita un PIN.", "Questo record richiede un PIN.", "Cet enregistrement nécessite un code PIN.", "Tento záznam potrebuje PIN.", "Ta zapis potrebuje PIN.", "Tämä tietue vaatii PIN-koodin."),
  "nfc.m5.otherAccount": T("This card was not written by this account.", "Tuto kartu nezapsal tento účet.", "Diese Karte wurde nicht von diesem Konto beschrieben.", "Esta tarjeta no la escribió esta cuenta.", "Questa carta non è stata scritta da questo account.", "Cette carte n’a pas été écrite par ce compte.", "Túto kartu nezapísal tento účet.", "Te kartice ni zapisal ta račun.", "Tätä korttia ei ole kirjoitettu tällä tilillä."),
  "nfc.m5.wrongPin": T("Wrong PIN, or the record is damaged.", "Špatný PIN, nebo je záznam poškozený.", "Falsche PIN, oder der Datensatz ist beschädigt.", "PIN incorrecto, o el registro está dañado.", "PIN errato, oppure il record è danneggiato.", "Code PIN incorrect, ou l’enregistrement est endommagé.", "Nesprávny PIN, alebo je záznam poškodený.", "Napačen PIN ali pa je zapis poškodovan.", "Väärä PIN-koodi, tai tietue on vioittunut."),
  "nfc.m5.damaged": T("The record is damaged.", "Záznam je poškozený.", "Der Datensatz ist beschädigt.", "El registro está dañado.", "Il record è danneggiato.", "L’enregistrement est endommagé.", "Záznam je poškodený.", "Zapis je poškodovan.", "Tietue on vioittunut."),
  "nfc.m5.notCard": T("Not an M5Cet card.", "Toto není karta M5Cet.", "Das ist keine M5Cet-Karte.", "No es una tarjeta M5Cet.", "Non è una carta M5Cet.", "Ce n’est pas une carte M5Cet.", "Toto nie je karta M5Cet.", "To ni kartica M5Cet.", "Tämä ei ole M5Cet-kortti."),

  /* --------------------------------------------- NFC: readers, notes */
  "nfc.reader.bleHint": T(
    "Connect your Bluetooth NFC reader in the system Bluetooth settings, then pair it with its own app. A vendor BLE bridge can be added here as an ApduChannel.",
    "Připojte svou Bluetooth čtečku NFC v systémovém nastavení Bluetooth a pak ji spárujte v její vlastní aplikaci. Most BLE od výrobce sem lze doplnit jako ApduChannel.",
    "Verbinden Sie Ihren Bluetooth-NFC-Leser in den Bluetooth-Einstellungen des Systems und koppeln Sie ihn dann mit seiner eigenen App. Eine BLE-Brücke des Herstellers kann hier als ApduChannel ergänzt werden.",
    "Conecta tu lector NFC Bluetooth en los ajustes de Bluetooth del sistema y vincúlalo después con su propia app. Aquí se puede añadir un puente BLE del fabricante como ApduChannel.",
    "Collega il tuo lettore NFC Bluetooth nelle impostazioni Bluetooth di sistema, poi abbinalo con la sua app. Qui si può aggiungere un bridge BLE del produttore come ApduChannel.",
    "Connectez votre lecteur NFC Bluetooth dans les paramètres Bluetooth du système, puis associez-le à sa propre application. Une passerelle BLE du fabricant peut être ajoutée ici comme ApduChannel.",
    "Pripojte svoju Bluetooth čítačku NFC v systémových nastaveniach Bluetooth a potom ju spárujte v jej vlastnej aplikácii. Most BLE od výrobcu sem možno doplniť ako ApduChannel.",
    "Bralnik NFC Bluetooth povežite v sistemskih nastavitvah Bluetooth, nato ga seznanite z njegovo aplikacijo. Most BLE proizvajalca lahko tukaj dodate kot ApduChannel.",
    "Yhdistä Bluetooth-NFC-lukija järjestelmän Bluetooth-asetuksissa ja muodosta sitten pari sen omassa sovelluksessa. Valmistajan BLE-silta voidaan lisätä tähän ApduChannel-kanavana.",
  ),
  "nfc.note.emvPublic": T(
    "Public data only: application labels/AIDs. No PIN, no signing, no transaction.",
    "Jen veřejná data: názvy aplikací a AID. Žádný PIN, žádné podepisování, žádná transakce.",
    "Nur öffentliche Daten: Anwendungsnamen/AIDs. Keine PIN, keine Signatur, keine Transaktion.",
    "Solo datos públicos: nombres de aplicaciones/AID. Sin PIN, sin firma, sin transacción.",
    "Solo dati pubblici: nomi delle applicazioni/AID. Nessun PIN, nessuna firma, nessuna transazione.",
    `Données publiques uniquement${NB}: noms d’applications/AID. Pas de code PIN, pas de signature, pas de transaction.`,
    "Len verejné údaje: názvy aplikácií a AID. Žiadny PIN, žiadne podpisovanie, žiadna transakcia.",
    "Samo javni podatki: imena aplikacij/AID. Brez PIN-a, brez podpisovanja, brez transakcije.",
    "Vain julkiset tiedot: sovellusten nimet/AID-tunnukset. Ei PIN-koodia, ei allekirjoitusta, ei maksutapahtumaa.",
  ),
  "nfc.note.eidPublic": T(
    "Public info only. The data groups are protected by BAC/PACE — type the CAN or the MRZ to unlock them. No cloning, no signing.",
    "Jen veřejné údaje. Datové skupiny chrání BAC/PACE — k jejich odemčení zadejte CAN nebo MRZ. Žádné klonování, žádné podepisování.",
    "Nur öffentliche Angaben. Die Datengruppen sind durch BAC/PACE geschützt — geben Sie die CAN oder die MRZ ein, um sie zu öffnen. Kein Klonen, keine Signatur.",
    "Solo información pública. Los grupos de datos están protegidos por BAC/PACE: escribe el CAN o la MRZ para desbloquearlos. Sin clonación, sin firma.",
    "Solo informazioni pubbliche. I gruppi di dati sono protetti da BAC/PACE: inserisci il CAN o la MRZ per sbloccarli. Nessuna clonazione, nessuna firma.",
    "Informations publiques uniquement. Les groupes de données sont protégés par BAC/PACE — saisissez le CAN ou la MRZ pour les déverrouiller. Pas de clonage, pas de signature.",
    "Len verejné údaje. Dátové skupiny chráni BAC/PACE — na ich odomknutie zadajte CAN alebo MRZ. Žiadne klonovanie, žiadne podpisovanie.",
    "Samo javni podatki. Podatkovne skupine ščiti BAC/PACE — za odklep vnesite CAN ali MRZ. Brez kloniranja, brez podpisovanja.",
    "Vain julkiset tiedot. Tietoryhmät on suojattu BAC/PACE-menetelmällä — avaa ne antamalla CAN tai MRZ. Ei kloonausta, ei allekirjoitusta.",
  ),
  "nfc.note.felicaPublic": T(
    "Public systems only; a service's blocks (Read Without Encryption) need the service code.",
    "Jen veřejné systémy; bloky služby (Read Without Encryption) potřebují kód služby.",
    "Nur öffentliche Systeme; die Blöcke eines Dienstes (Read Without Encryption) brauchen den Dienstcode.",
    "Solo sistemas públicos; los bloques de un servicio (Read Without Encryption) necesitan el código del servicio.",
    "Solo sistemi pubblici; i blocchi di un servizio (Read Without Encryption) richiedono il codice del servizio.",
    `Systèmes publics uniquement${NB}; les blocs d’un service (Read Without Encryption) nécessitent le code du service.`,
    "Len verejné systémy; bloky služby (Read Without Encryption) potrebujú kód služby.",
    "Samo javni sistemi; bloki storitve (Read Without Encryption) potrebujejo kodo storitve.",
    "Vain julkiset järjestelmät; palvelun lohkot (Read Without Encryption) vaativat palvelukoodin.",
  ),

  /* --------------------------------------------------------- NFC: e-ID */
  "nfc.eid.needKey": T(
    "Give the MRZ (document number, date of birth, expiry) or the CAN printed on the document to open the chip.",
    "K otevření čipu zadejte MRZ (číslo dokladu, datum narození, platnost) nebo CAN vytištěný na dokladu.",
    "Geben Sie die MRZ (Dokumentnummer, Geburtsdatum, Ablaufdatum) oder die auf dem Dokument aufgedruckte CAN ein, um den Chip zu öffnen.",
    "Escribe la MRZ (número de documento, fecha de nacimiento, caducidad) o el CAN impreso en el documento para abrir el chip.",
    "Inserisci la MRZ (numero del documento, data di nascita, scadenza) o il CAN stampato sul documento per aprire il chip.",
    "Saisissez la MRZ (numéro du document, date de naissance, expiration) ou le CAN imprimé sur le document pour ouvrir la puce.",
    "Na otvorenie čipu zadajte MRZ (číslo dokladu, dátum narodenia, platnosť) alebo CAN vytlačený na doklade.",
    "Za odprtje čipa vnesite MRZ (številka dokumenta, datum rojstva, veljavnost) ali CAN, natisnjen na dokumentu.",
    "Avaa siru antamalla MRZ (asiakirjan numero, syntymäaika, voimassaolo) tai asiakirjaan painettu CAN.",
  ),
  "nfc.eid.eac": T("Extended Access Control (a government terminal certificate)", "Extended Access Control (certifikát státního terminálu)", "Extended Access Control (ein Zertifikat eines staatlichen Terminals)", "Extended Access Control (un certificado de terminal oficial)", "Extended Access Control (un certificato di terminale governativo)", "Extended Access Control (un certificat de terminal gouvernemental)", "Extended Access Control (certifikát štátneho terminálu)", "Extended Access Control (potrdilo državnega terminala)", "Extended Access Control (viranomaispäätteen varmenne)"),
  "nfc.eid.imagesOff": T("not read (images off)", "nenačteno (obrázky vypnuté)", "nicht gelesen (Bilder aus)", "no leído (imágenes desactivadas)", "non letto (immagini disattivate)", "non lu (images désactivées)", "nenačítané (obrázky vypnuté)", "ni prebrano (slike izklopljene)", "ei luettu (kuvat pois päältä)"),
  "nfc.eid.parseFailed": T("could not parse: {0}", "nepodařilo se zpracovat: {0}", "nicht lesbar: {0}", "no se pudo interpretar: {0}", "impossibile interpretare: {0}", `lecture impossible${NB}: {0}`, "nepodarilo sa spracovať: {0}", "ni bilo mogoče razčleniti: {0}", "jäsentäminen epäonnistui: {0}"),
  "nfc.eid.needsMrz": T("this document needs the MRZ (BAC)", "tento doklad potřebuje MRZ (BAC)", "dieses Dokument braucht die MRZ (BAC)", "este documento necesita la MRZ (BAC)", "questo documento richiede la MRZ (BAC)", "ce document nécessite la MRZ (BAC)", "tento doklad potrebuje MRZ (BAC)", "ta dokument potrebuje MRZ (BAC)", "tämä asiakirja vaatii MRZ:n (BAC)"),
  "nfc.eid.notOpened": T("the document could not be opened", "doklad se nepodařilo otevřít", "das Dokument konnte nicht geöffnet werden", "no se pudo abrir el documento", "impossibile aprire il documento", "le document n’a pas pu être ouvert", "doklad sa nepodarilo otvoriť", "dokumenta ni bilo mogoče odpreti", "asiakirjaa ei voitu avata"),
  "nfc.eid.sum.present": T("MRTD present", "doklad MRTD přítomen", "MRTD vorhanden", "MRTD presente", "MRTD presente", "MRTD présent", "doklad MRTD prítomný", "MRTD prisoten", "MRTD löytyi"),
  "nfc.eid.sum.none": T("no MRTD", "žádný doklad MRTD", "kein MRTD", "sin MRTD", "nessun MRTD", "aucun MRTD", "žiadny doklad MRTD", "ni MRTD", "ei MRTD:tä"),

  /* ---------------------------------------------- NFC: EMV, templates */
  "nfc.emv.sum.none": T("No EMV application found", "Nenalezena žádná aplikace EMV", "Keine EMV-Anwendung gefunden", "No se encontró ninguna aplicación EMV", "Nessuna applicazione EMV trovata", "Aucune application EMV trouvée", "Nenašla sa žiadna aplikácia EMV", "Ni najdene aplikacije EMV", "EMV-sovellusta ei löytynyt"),
  "nfc.tpl.step.readLog": T("Transaction history", "Historie transakcí", "Transaktionsverlauf", "Historial de transacciones", "Cronologia delle transazioni", "Historique des transactions", "História transakcií", "Zgodovina transakcij", "Tapahtumahistoria"),
  "nfc.tpl.step.eachApp": T("Each application", "Každá aplikace", "Jede Anwendung", "Cada aplicación", "Ogni applicazione", "Chaque application", "Každá aplikácia", "Vsaka aplikacija", "Jokainen sovellus"),
  "nfc.tpl.step.eidRead": T("e-ID / e-passport read", "Čtení e-ID / e-pasu", "e-ID / e-Pass lesen", "Lectura de e-ID / pasaporte electrónico", "Lettura e-ID / passaporto elettronico", "Lecture e-ID / passeport électronique", "Čítanie e-ID / e-pasu", "Branje e-ID / e-potnega lista", "e-ID / e-passin luku"),
  "nfc.tpl.step.emvRead": T("EMV read", "Čtení EMV", "EMV lesen", "Lectura EMV", "Lettura EMV", "Lecture EMV", "Čítanie EMV", "Branje EMV", "EMV-luku"),
  "nfc.tpl.cardGone": T("the card stopped answering", "karta přestala odpovídat", "die Karte antwortet nicht mehr", "la tarjeta dejó de responder", "la carta ha smesso di rispondere", "la carte ne répond plus", "karta prestala odpovedať", "kartica se je nehala odzivati", "kortti lakkasi vastaamasta"),
};

/**
 * Texts shown with a count: per language the forms of its plural categories
 * (CLDR: cs / sk one · few · other, sl one · two · few · other, the rest one ·
 * other; "many" of es / it / fr — millions — falls back to "other"). The plain
 * key gets the "other" form, for an app that does not pick forms.
 */
type Forms = Partial<Record<"one" | "two" | "few" | "many" | "other", string>> & { other: string };
const P = (en: Forms, cs: Forms, de: Forms, es: Forms, it: Forms, fr: Forms, sk: Forms, sl: Forms, fi: Forms): Record<Locale, Forms> => ({ en, cs, de, es, it, fr, sk, sl, fi });

const PLURALS: Record<string, Record<Locale, Forms>> = {
  "p4.heldDropped": P(
    { one: "{n} held message was not shown (identity changed, not verified)", other: "{n} held messages were not shown (identity changed, not verified)" },
    { one: "{n} zadržená zpráva se nezobrazila (identita se změnila a nebyla ověřena)", few: "{n} zadržené zprávy se nezobrazily (identita se změnila a nebyla ověřena)", other: "{n} zadržených zpráv se nezobrazilo (identita se změnila a nebyla ověřena)" },
    { one: "{n} zurückgehaltene Nachricht wurde nicht angezeigt (Identität geändert, nicht verifiziert)", other: "{n} zurückgehaltene Nachrichten wurden nicht angezeigt (Identität geändert, nicht verifiziert)" },
    { one: "No se ha mostrado {n} mensaje retenido (la identidad cambió y no está verificada)", other: "No se han mostrado {n} mensajes retenidos (la identidad cambió y no está verificada)" },
    { one: "{n} messaggio trattenuto non è stato mostrato (identità cambiata, non verificata)", other: "{n} messaggi trattenuti non sono stati mostrati (identità cambiata, non verificata)" },
    { one: "{n} message retenu n’a pas été affiché (identité modifiée, non vérifiée)", other: "{n} messages retenus n’ont pas été affichés (identité modifiée, non vérifiée)" },
    { one: "{n} zadržaná správa sa nezobrazila (identita sa zmenila a nebola overená)", few: "{n} zadržané správy sa nezobrazili (identita sa zmenila a nebola overená)", other: "{n} zadržaných správ sa nezobrazilo (identita sa zmenila a nebola overená)" },
    { one: "{n} zadržano sporočilo ni bilo prikazano (identiteta se je spremenila, ni preverjena)", two: "{n} zadržani sporočili nista bili prikazani (identiteta se je spremenila, ni preverjena)", few: "{n} zadržana sporočila niso bila prikazana (identiteta se je spremenila, ni preverjena)", other: "{n} zadržanih sporočil ni bilo prikazanih (identiteta se je spremenila, ni preverjena)" },
    { one: "{n} pidätetty viesti jäi näyttämättä (identiteetti muuttui, ei vahvistettu)", other: "{n} pidätettyä viestiä ei näytetty (identiteetti muuttui, ei vahvistettu)" },
  ),
  "set.security.duress.length": P(
    { one: "The duress PIN must have {n} digit.", other: "The duress PIN must have {n} digits." },
    { one: "Nouzový PIN musí mít {n} číslici.", few: "Nouzový PIN musí mít {n} číslice.", other: "Nouzový PIN musí mít {n} číslic." },
    { one: "Die Notfall-PIN muss {n} Ziffer haben.", other: "Die Notfall-PIN muss {n} Ziffern haben." },
    { one: "El PIN de coacción debe tener {n} dígito.", other: "El PIN de coacción debe tener {n} dígitos." },
    { one: "Il PIN di emergenza deve avere {n} cifra.", other: "Il PIN di emergenza deve avere {n} cifre." },
    { one: "Le PIN de contrainte doit comporter {n} chiffre.", other: "Le PIN de contrainte doit comporter {n} chiffres." },
    { one: "Núdzový PIN musí mať {n} číslicu.", few: "Núdzový PIN musí mať {n} číslice.", other: "Núdzový PIN musí mať {n} číslic." },
    { one: "Zasilni PIN mora imeti {n} števko.", two: "Zasilni PIN mora imeti {n} števki.", few: "Zasilni PIN mora imeti {n} števke.", other: "Zasilni PIN mora imeti {n} števk." },
    { one: "Uhkatilanteen PIN-koodissa on oltava {n} numero.", other: "Uhkatilanteen PIN-koodissa on oltava {n} numeroa." },
  ),
  "nfc.eid.sum.images": P(
    { one: "{n} image", other: "{n} images" },
    { one: "{n} obrázek", few: "{n} obrázky", other: "{n} obrázků" },
    { one: "{n} Bild", other: "{n} Bilder" },
    { one: "{n} imagen", other: "{n} imágenes" },
    { one: "{n} immagine", other: "{n} immagini" },
    { one: "{n} image", other: "{n} images" },
    { one: "{n} obrázok", few: "{n} obrázky", other: "{n} obrázkov" },
    { one: "{n} slika", two: "{n} sliki", few: "{n} slike", other: "{n} slik" },
    { one: "{n} kuva", other: "{n} kuvaa" },
  ),
  "nfc.emv.sum.transactions": P(
    { one: "{n} transaction", other: "{n} transactions" },
    { one: "{n} transakce", few: "{n} transakce", other: "{n} transakcí" },
    { one: "{n} Transaktion", other: "{n} Transaktionen" },
    { one: "{n} transacción", other: "{n} transacciones" },
    { one: "{n} transazione", other: "{n} transazioni" },
    { one: "{n} transaction", other: "{n} transactions" },
    { one: "{n} transakcia", few: "{n} transakcie", other: "{n} transakcií" },
    { one: "{n} transakcija", two: "{n} transakciji", few: "{n} transakcije", other: "{n} transakcij" },
    { one: "{n} maksutapahtuma", other: "{n} maksutapahtumaa" },
  ),
  "nfc.emv.sum.apps": P(
    { one: "EMV: {n} application", other: "EMV: {n} applications" },
    { one: "EMV: {n} aplikace", few: "EMV: {n} aplikace", other: "EMV: {n} aplikací" },
    { one: "EMV: {n} Anwendung", other: "EMV: {n} Anwendungen" },
    { one: "EMV: {n} aplicación", other: "EMV: {n} aplicaciones" },
    { one: "EMV: {n} applicazione", other: "EMV: {n} applicazioni" },
    { one: `EMV${NB}: {n} application`, other: `EMV${NB}: {n} applications` },
    { one: "EMV: {n} aplikácia", few: "EMV: {n} aplikácie", other: "EMV: {n} aplikácií" },
    { one: "EMV: {n} aplikacija", two: "EMV: {n} aplikaciji", few: "EMV: {n} aplikacije", other: "EMV: {n} aplikacij" },
    { one: "EMV: {n} sovellus", other: "EMV: {n} sovellusta" },
  ),
  "nfc.emv.sum.noRecords": P(
    { one: "EMV: {n} application, no records read", other: "EMV: {n} applications, no records read" },
    { one: "EMV: {n} aplikace, žádné záznamy nenačteny", few: "EMV: {n} aplikace, žádné záznamy nenačteny", other: "EMV: {n} aplikací, žádné záznamy nenačteny" },
    { one: "EMV: {n} Anwendung, keine Datensätze gelesen", other: "EMV: {n} Anwendungen, keine Datensätze gelesen" },
    { one: "EMV: {n} aplicación, no se leyeron registros", other: "EMV: {n} aplicaciones, no se leyeron registros" },
    { one: "EMV: {n} applicazione, nessun record letto", other: "EMV: {n} applicazioni, nessun record letto" },
    { one: `EMV${NB}: {n} application, aucun enregistrement lu`, other: `EMV${NB}: {n} applications, aucun enregistrement lu` },
    { one: "EMV: {n} aplikácia, žiadne záznamy neprečítané", few: "EMV: {n} aplikácie, žiadne záznamy neprečítané", other: "EMV: {n} aplikácií, žiadne záznamy neprečítané" },
    { one: "EMV: {n} aplikacija, noben zapis ni prebran", two: "EMV: {n} aplikaciji, noben zapis ni prebran", few: "EMV: {n} aplikacije, noben zapis ni prebran", other: "EMV: {n} aplikacij, noben zapis ni prebran" },
    { one: "EMV: {n} sovellus, tietueita ei luettu", other: "EMV: {n} sovellusta, tietueita ei luettu" },
  ),
};

/** The keys whose plain text stays the earlier design's (they had one): their plural forms are added, the plain key is not replaced. */
const KEEP_PLAIN = new Set(["p4.heldDropped", "set.security.duress.length"]);

export const PLURAL_KEYS_613 = Object.keys(PLURALS);

export const STRINGS_613: Record<Locale, Record<string, string>> = { en: {}, cs: {}, de: {}, es: {}, it: {}, fr: {}, sk: {}, sl: {}, fi: {} };
for (const [key, texts] of Object.entries(TEXTS)) for (const [lang, text] of Object.entries(texts) as Array<[Locale, string]>) STRINGS_613[lang][key] = text;
for (const [key, byLang] of Object.entries(PLURALS)) {
  for (const [lang, forms] of Object.entries(byLang) as Array<[Locale, Forms]>) {
    for (const [cat, text] of Object.entries(forms)) STRINGS_613[lang][`${key}#${cat}`] = text as string;
    if (!KEEP_PLAIN.has(key)) STRINGS_613[lang][key] = forms.other;
  }
}
