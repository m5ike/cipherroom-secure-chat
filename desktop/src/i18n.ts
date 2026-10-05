// The desktop app's own texts — menus, dialogs, the tray, the server picker —
// in the nine languages of the web client (client/src/lib/locales.ts). The
// page itself is the web client and translates itself; these are only the
// strings the native shell adds. Translated following i18n/GLOSSARY.md
// (formal cs/de/sk/sl/fr, informal es/it, neutral fi; product names kept).
// Pure: no Electron.

import { LOCALES, isLocale, localeChain, pickLocale, type Locale } from "../../client/src/lib/locales";

type Row = Readonly<Record<Locale, string>>;
const NB = " "; // French: a non-breaking space before : ; ! ? and inside « »

const row = (en: string, cs: string, de: string, es: string, it: string, fr: string, sk: string, sl: string, fi: string): Row => ({ en, cs, de, es, it, fr, sk, sl, fi });

export const STRINGS = {
  "menu.about": row("About M5cet", "O aplikaci M5cet", "Über M5cet", "Acerca de M5cet", "Informazioni su M5cet", "À propos de M5cet", "O aplikácii M5cet", "O aplikaciji M5cet", "Tietoja ohjelmasta M5cet"),
  "menu.checkUpdates": row("Check for Updates…", "Zkontrolovat aktualizace…", "Nach Updates suchen …", "Buscar actualizaciones…", "Verifica aggiornamenti…", "Rechercher des mises à jour…", "Skontrolovať aktualizácie…", "Preveri posodobitve …", "Tarkista päivitykset…"),
  "menu.server": row("Server", "Server", "Server", "Servidor", "Server", "Serveur", "Server", "Strežnik", "Palvelin"),
  "menu.switchServer": row("Switch Server…", "Přepnout server…", "Server wechseln …", "Cambiar de servidor…", "Cambia server…", "Changer de serveur…", "Prepnúť server…", "Zamenjaj strežnik …", "Vaihda palvelinta…"),
  "menu.openInBrowser": row("Open in Browser", "Otevřít v prohlížeči", "Im Browser öffnen", "Abrir en el navegador", "Apri nel browser", "Ouvrir dans le navigateur", "Otvoriť v prehliadači", "Odpri v brskalniku", "Avaa selaimessa"),
  "menu.codeSource": row("Client Code", "Kód klienta", "Client-Code", "Código del cliente", "Codice del client", "Code du client", "Kód klienta", "Koda odjemalca", "Asiakasohjelman koodi"),
  "menu.codeApp": row("From the Signed App", "Z podepsané aplikace", "Aus der signierten App", "De la app firmada", "Dall’app firmata", "De l’app signée", "Z podpísanej aplikácie", "Iz podpisane aplikacije", "Allekirjoitetusta sovelluksesta"),
  "menu.codeServer": row("From This Server", "Z tohoto serveru", "Von diesem Server", "De este servidor", "Da questo server", "De ce serveur", "Z tohto servera", "S tega strežnika", "Tältä palvelimelta"),
  "menu.passkeys": row("Passkey Sign-in", "Přihlášení passkey", "Anmeldung mit Passkey", "Inicio de sesión con llave de acceso", "Accesso con passkey", "Connexion par clé d’accès", "Prihlásenie prístupovým kľúčom", "Prijava s ključem za dostop", "Kirjautuminen pääsyavaimella"),
  "menu.passkeysAuto": row("Automatic", "Automaticky", "Automatisch", "Automático", "Automatico", "Automatique", "Automaticky", "Samodejno", "Automaattinen"),
  "menu.passkeysApp": row("In the App", "V aplikaci", "In der App", "En la app", "Nell’app", "Dans l’app", "V aplikácii", "V aplikaciji", "Sovelluksessa"),
  "menu.passkeysBrowser": row("Through the Browser", "Přes prohlížeč", "Über den Browser", "A través del navegador", "Tramite il browser", "Via le navigateur", "Cez prehliadač", "Prek brskalnika", "Selaimen kautta"),
  "menu.startAtLogin": row("Start at Login", "Spouštět po přihlášení", "Bei Anmeldung starten", "Abrir al iniciar sesión", "Apri al login", "Ouvrir à l’ouverture de session", "Spúšťať po prihlásení", "Zaženi ob prijavi", "Käynnistä kirjauduttaessa"),
  "menu.closeToTray": row("Keep Running When Closed", "Po zavření běžet dál", "Nach dem Schließen weiter ausführen", "Seguir ejecutándose al cerrar", "Resta attiva dopo la chiusura", "Continuer après la fermeture", "Po zatvorení bežať ďalej", "Ob zaprtju teci naprej", "Jatka taustalla suljettaessa"),
  "menu.show": row("Show M5cet", "Zobrazit M5cet", "M5cet anzeigen", "Mostrar M5cet", "Mostra M5cet", "Afficher M5cet", "Zobraziť M5cet", "Prikaži M5cet", "Näytä M5cet"),
  "menu.quit": row("Quit M5cet", "Ukončit M5cet", "M5cet beenden", "Salir de M5cet", "Esci da M5cet", "Quitter M5cet", "Ukončiť M5cet", "Zapri M5cet", "Lopeta M5cet"),
  "menu.hide": row("Hide M5cet", "Skrýt M5cet", "M5cet ausblenden", "Ocultar M5cet", "Nascondi M5cet", "Masquer M5cet", "Skryť M5cet", "Skrij M5cet", "Kätke M5cet"),
  "menu.hideOthers": row("Hide Others", "Skrýt ostatní", "Andere ausblenden", "Ocultar otros", "Nascondi altre", "Masquer les autres", "Skryť ostatné", "Skrij druge", "Kätke muut"),
  "menu.showAll": row("Show All", "Zobrazit vše", "Alle einblenden", "Mostrar todo", "Mostra tutte", "Tout afficher", "Zobraziť všetko", "Prikaži vse", "Näytä kaikki"),
  "menu.services": row("Services", "Služby", "Dienste", "Servicios", "Servizi", "Services", "Služby", "Storitve", "Palvelut"),
  "menu.file": row("File", "Soubor", "Datei", "Archivo", "File", "Fichier", "Súbor", "Datoteka", "Tiedosto"),
  "menu.edit": row("Edit", "Úpravy", "Bearbeiten", "Edición", "Modifica", "Édition", "Upraviť", "Uredi", "Muokkaa"),
  "menu.view": row("View", "Zobrazení", "Darstellung", "Visualización", "Vista", "Présentation", "Zobraziť", "Pogled", "Näytä"),
  "menu.window": row("Window", "Okno", "Fenster", "Ventana", "Finestra", "Fenêtre", "Okno", "Okno", "Ikkuna"),
  "menu.help": row("Help", "Nápověda", "Hilfe", "Ayuda", "Aiuto", "Aide", "Pomocník", "Pomoč", "Ohje"),
  "menu.undo": row("Undo", "Zpět", "Widerrufen", "Deshacer", "Annulla", "Annuler", "Späť", "Razveljavi", "Kumoa"),
  "menu.redo": row("Redo", "Znovu", "Wiederholen", "Rehacer", "Ripeti", "Rétablir", "Znova", "Uveljavi", "Tee uudelleen"),
  "menu.cut": row("Cut", "Vyjmout", "Ausschneiden", "Cortar", "Taglia", "Couper", "Vystrihnúť", "Izreži", "Leikkaa"),
  "menu.copy": row("Copy", "Kopírovat", "Kopieren", "Copiar", "Copia", "Copier", "Kopírovať", "Kopiraj", "Kopioi"),
  "menu.paste": row("Paste", "Vložit", "Einfügen", "Pegar", "Incolla", "Coller", "Vložiť", "Prilepi", "Liitä"),
  "menu.selectAll": row("Select All", "Vybrat vše", "Alles auswählen", "Seleccionar todo", "Seleziona tutto", "Tout sélectionner", "Vybrať všetko", "Izberi vse", "Valitse kaikki"),
  "menu.reload": row("Reload", "Načíst znovu", "Neu laden", "Volver a cargar", "Ricarica", "Recharger", "Načítať znova", "Znova naloži", "Lataa uudelleen"),
  "menu.zoomIn": row("Zoom In", "Zvětšit", "Vergrößern", "Ampliar", "Ingrandisci", "Zoom avant", "Zväčšiť", "Povečaj", "Lähennä"),
  "menu.zoomOut": row("Zoom Out", "Zmenšit", "Verkleinern", "Reducir", "Riduci", "Zoom arrière", "Zmenšiť", "Pomanjšaj", "Loitonna"),
  "menu.resetZoom": row("Actual Size", "Skutečná velikost", "Originalgröße", "Tamaño real", "Dimensioni reali", "Taille réelle", "Skutočná veľkosť", "Dejanska velikost", "Todellinen koko"),
  "menu.fullscreen": row("Toggle Full Screen", "Přepnout na celou obrazovku", "Vollbild ein/aus", "Pantalla completa", "Schermo intero", "Plein écran", "Prepnúť na celú obrazovku", "Celozaslonski način", "Koko näyttö"),
  "menu.minimize": row("Minimize", "Minimalizovat", "Minimieren", "Minimizar", "Riduci a icona", "Réduire", "Minimalizovať", "Minimiziraj", "Pienennä"),
  "menu.close": row("Close Window", "Zavřít okno", "Fenster schließen", "Cerrar ventana", "Chiudi finestra", "Fermer la fenêtre", "Zatvoriť okno", "Zapri okno", "Sulje ikkuna"),
  "tray.unread": row("{count} unread", "Nepřečtené: {count}", "{count} ungelesen", "{count} sin leer", "{count} non letti", "{count} non lus", "Neprečítané: {count}", "Neprebrano: {count}", "{count} lukematonta"),

  "btn.open": row("Open", "Otevřít", "Öffnen", "Abrir", "Apri", "Ouvrir", "Otvoriť", "Odpri", "Avaa"),
  "btn.cancel": row("Cancel", "Zrušit", "Abbrechen", "Cancelar", "Annulla", "Annuler", "Zrušiť", "Prekliči", "Peruuta"),
  "btn.later": row("Later", "Později", "Später", "Más tarde", "Più tardi", "Plus tard", "Neskôr", "Pozneje", "Myöhemmin"),
  "btn.restart": row("Restart", "Restartovat", "Neu starten", "Reiniciar", "Riavvia", "Redémarrer", "Reštartovať", "Znova zaženi", "Käynnistä uudelleen"),
  "btn.ok": row("OK", "OK", "OK", "Aceptar", "OK", "OK", "OK", "V redu", "OK"),
  "btn.connect": row("Connect", "Připojit", "Verbinden", "Conectar", "Connetti", "Se connecter", "Pripojiť", "Poveži", "Yhdistä"),
  "btn.remove": row("Remove", "Odebrat", "Entfernen", "Quitar", "Rimuovi", "Retirer", "Odobrať", "Odstrani", "Poista"),
  "btn.openAgain": row("Open Again", "Otevřít znovu", "Erneut öffnen", "Volver a abrir", "Riapri", "Rouvrir", "Otvoriť znova", "Odpri znova", "Avaa uudelleen"),
  "btn.useBrowser": row("Use the Browser", "Použít prohlížeč", "Browser verwenden", "Usar el navegador", "Usa il browser", "Utiliser le navigateur", "Použiť prehliadač", "Uporabi brskalnik", "Käytä selainta"),
  "btn.update": row("Update the App", "Aktualizovat aplikaci", "App aktualisieren", "Actualizar la app", "Aggiorna l’app", "Mettre à jour l’app", "Aktualizovať aplikáciu", "Posodobi aplikacijo", "Päivitä sovellus"),
  "btn.useServerCode": row("Use This Server’s Web Code", "Použít webový kód serveru", "Web-Code des Servers verwenden", "Usar el código web del servidor", "Usa il codice web del server", "Utiliser le code web du serveur", "Použiť webový kód servera", "Uporabi spletno kodo strežnika", "Käytä palvelimen verkkokoodia"),
  "btn.useAppCode": row("Try the App’s Code", "Zkusit kód aplikace", "Code der App versuchen", "Probar el código de la app", "Prova il codice dell’app", "Essayer le code de l’app", "Skúsiť kód aplikácie", "Poskusi kodo aplikacije", "Kokeile sovelluksen koodia"),

  "dlg.external.title": row("Open outside the app?", "Otevřít mimo aplikaci?", "Außerhalb der App öffnen?", "¿Abrir fuera de la app?", "Aprire fuori dall’app?", `Ouvrir en dehors de l’app${NB}?`, "Otvoriť mimo aplikácie?", "Odprem zunaj aplikacije?", "Avataanko sovelluksen ulkopuolella?"),
  "dlg.external.body": row("This link leads outside {server}:", "Odkaz vede mimo {server}:", "Dieser Link führt aus {server} hinaus:", "Este enlace lleva fuera de {server}:", "Questo link porta fuori da {server}:", `Ce lien mène hors de {server}${NB}:`, "Odkaz vedie mimo {server}:", "Ta povezava vodi izven {server}:", "Linkki vie palvelimen {server} ulkopuolelle:"),
  "dlg.newServer.title": row("Open another server?", "Otevřít jiný server?", "Anderen Server öffnen?", "¿Abrir otro servidor?", "Aprire un altro server?", `Ouvrir un autre serveur${NB}?`, "Otvoriť iný server?", "Odprem drug strežnik?", "Avataanko toinen palvelin?"),
  "dlg.newServer.body": row(
    "The link opens {server}, which is not among your servers. Open it only if you trust it.",
    "Odkaz otevírá {server}, který nemáte mezi svými servery. Otevřete ho, jen pokud mu důvěřujete.",
    "Der Link öffnet {server}, der nicht zu Ihren Servern gehört. Öffnen Sie ihn nur, wenn Sie ihm vertrauen.",
    "El enlace abre {server}, que no está entre tus servidores. Ábrelo solo si confías en él.",
    "Il link apre {server}, che non è tra i tuoi server. Aprilo solo se ti fidi.",
    "Le lien ouvre {server}, qui ne fait pas partie de vos serveurs. Ne l’ouvrez que si vous lui faites confiance.",
    "Odkaz otvára {server}, ktorý nemáte medzi svojimi servermi. Otvorte ho, len ak mu dôverujete.",
    "Povezava odpre {server}, ki ga ni med vašimi strežniki. Odprite ga le, če mu zaupate.",
    "Linkki avaa palvelimen {server}, joka ei ole palvelinluettelossasi. Avaa se vain, jos luotat siihen.",
  ),
  "dlg.version.title": row("This server runs another version", "Server běží v jiné verzi", "Dieser Server hat eine andere Version", "Este servidor usa otra versión", "Questo server usa un’altra versione", "Ce serveur utilise une autre version", "Server beží v inej verzii", "Ta strežnik uporablja drugo različico", "Palvelimella on eri versio"),
  "dlg.version.body": row(
    "The app contains M5cet {app}; {server} runs M5cet {serverVersion}. The two may not work together.",
    "Aplikace obsahuje M5cet {app}, {server} běží na M5cet {serverVersion}. Spolu nemusí fungovat.",
    "Die App enthält M5cet {app}; {server} läuft mit M5cet {serverVersion}. Beide arbeiten möglicherweise nicht zusammen.",
    "La app contiene M5cet {app}; {server} usa M5cet {serverVersion}. Puede que no funcionen juntos.",
    "L’app contiene M5cet {app}; {server} usa M5cet {serverVersion}. Potrebbero non funzionare insieme.",
    `L’app contient M5cet {app}${NB}; {server} utilise M5cet {serverVersion}. Les deux risquent de ne pas fonctionner ensemble.`,
    "Aplikácia obsahuje M5cet {app}, {server} beží na M5cet {serverVersion}. Spolu nemusia fungovať.",
    "Aplikacija vsebuje M5cet {app}, {server} uporablja M5cet {serverVersion}. Morda ne bosta delovala skupaj.",
    "Sovelluksessa on M5cet {app}; palvelimella {server} on M5cet {serverVersion}. Ne eivät ehkä toimi yhdessä.",
  ),
  "dlg.version.detail": row(
    "“Use This Server’s Web Code” is remembered for this server: the page then comes from the server, as in a browser, and is not covered by the app’s signature. You can switch back in the Server menu.",
    "Volba „Použít webový kód serveru“ se pro tento server zapamatuje: stránka pak přichází ze serveru jako v prohlížeči a podpis aplikace ji nechrání. Zpět ji přepnete v nabídce Server.",
    "„Web-Code des Servers verwenden“ wird für diesen Server gespeichert: Die Seite kommt dann wie im Browser vom Server und ist nicht durch die Signatur der App geschützt. Zurückschalten können Sie im Menü Server.",
    "«Usar el código web del servidor» se recuerda para este servidor: la página viene entonces del servidor, como en un navegador, y la firma de la app no la cubre. Puedes volver atrás en el menú Servidor.",
    "«Usa il codice web del server» viene ricordato per questo server: la pagina arriva allora dal server, come in un browser, e la firma dell’app non la copre. Puoi tornare indietro dal menu Server.",
    `«${NB}Utiliser le code web du serveur${NB}» est mémorisé pour ce serveur${NB}: la page vient alors du serveur, comme dans un navigateur, et la signature de l’app ne la couvre pas. Vous pouvez revenir en arrière dans le menu Serveur.`,
    "Voľba „Použiť webový kód servera“ sa pre tento server zapamätá: stránka potom prichádza zo servera ako v prehliadači a podpis aplikácie ju nechráni. Späť ju prepnete v ponuke Server.",
    "Izbira „Uporabi spletno kodo strežnika“ se za ta strežnik zapomni: stran tedaj pride s strežnika kot v brskalniku in podpis aplikacije je ne ščiti. Nazaj jo preklopite v meniju Strežnik.",
    "Valinta ”Käytä palvelimen verkkokoodia” muistetaan tälle palvelimelle: sivu tulee silloin palvelimelta kuten selaimessa, eikä sovelluksen allekirjoitus suojaa sitä. Voit vaihtaa takaisin Palvelin-valikosta.",
  ),
  "banner.serverCode": row(
    "The page’s code comes from {server}, not from the signed app.",
    "Kód stránky pochází ze serveru {server}, ne z podepsané aplikace.",
    "Der Code der Seite kommt von {server}, nicht aus der signierten App.",
    "El código de la página viene de {server}, no de la app firmada.",
    "Il codice della pagina arriva da {server}, non dall’app firmata.",
    "Le code de la page vient de {server}, pas de l’app signée.",
    "Kód stránky pochádza zo servera {server}, nie z podpísanej aplikácie.",
    "Koda strani prihaja s strežnika {server}, ne iz podpisane aplikacije.",
    "Sivun koodi tulee palvelimelta {server}, ei allekirjoitetusta sovelluksesta.",
  ),
  "banner.switchBack": row("Use the app’s code", "Použít kód aplikace", "Code der App verwenden", "Usar el código de la app", "Usa il codice dell’app", "Utiliser le code de l’app", "Použiť kód aplikácie", "Uporabi kodo aplikacije", "Käytä sovelluksen koodia"),
  "title.serverCode": row("code from the server", "kód ze serveru", "Code vom Server", "código del servidor", "codice dal server", "code du serveur", "kód zo servera", "koda s strežnika", "koodi palvelimelta"),

  "dlg.signin.title": row("Sign in in your browser", "Přihlaste se v prohlížeči", "Melden Sie sich im Browser an", "Inicia sesión en el navegador", "Accedi nel browser", "Connectez-vous dans le navigateur", "Prihláste sa v prehliadači", "Prijavite se v brskalniku", "Kirjaudu selaimessa"),
  "dlg.signin.body": row(
    "Your browser has opened the sign-in page of {server}. Check that it shows the code {code}, then confirm with your passkey there.",
    "Prohlížeč otevřel přihlašovací stránku serveru {server}. Zkontrolujte, že ukazuje kód {code}, a potvrďte tam svým passkey.",
    "Ihr Browser hat die Anmeldeseite von {server} geöffnet. Prüfen Sie, dass sie den Code {code} zeigt, und bestätigen Sie dort mit Ihrem Passkey.",
    "Tu navegador ha abierto la página de inicio de sesión de {server}. Comprueba que muestra el código {code} y confirma allí con tu llave de acceso.",
    "Il browser ha aperto la pagina di accesso di {server}. Verifica che mostri il codice {code}, poi conferma lì con la tua passkey.",
    "Votre navigateur a ouvert la page de connexion de {server}. Vérifiez qu’elle affiche le code {code}, puis confirmez-y avec votre clé d’accès.",
    "Prehliadač otvoril prihlasovaciu stránku servera {server}. Skontrolujte, že ukazuje kód {code}, a potvrďte tam svojím prístupovým kľúčom.",
    "Brskalnik je odprl stran za prijavo strežnika {server}. Preverite, da prikazuje kodo {code}, nato tam potrdite s ključem za dostop.",
    "Selain avasi palvelimen {server} kirjautumissivun. Tarkista, että siinä näkyy koodi {code}, ja vahvista siellä pääsyavaimellasi.",
  ),
  "dlg.signin.detail": row(
    "Your session and encryption key come back to the app encrypted for this app only.",
    "Relace a šifrovací klíč se do aplikace vrátí zašifrované jen pro tuto aplikaci.",
    "Sitzung und Schlüssel kommen nur für diese App verschlüsselt zurück.",
    "La sesión y la clave de cifrado vuelven a la app cifradas solo para esta app.",
    "La sessione e la chiave di crittografia tornano all’app cifrate solo per questa app.",
    "La session et la clé de chiffrement reviennent dans l’app, chiffrées pour cette seule app.",
    "Relácia a šifrovací kľúč sa do aplikácie vrátia zašifrované len pre túto aplikáciu.",
    "Seja in šifrirni ključ se vrneta v aplikacijo, šifrirana samo zanjo.",
    "Istunto ja salausavain palaavat sovellukseen salattuina vain tälle sovellukselle.",
  ),
  "dlg.prf.title": row("Sign in through the browser?", "Přihlásit se přes prohlížeč?", "Über den Browser anmelden?", "¿Iniciar sesión a través del navegador?", "Accedere tramite il browser?", `Se connecter via le navigateur${NB}?`, "Prihlásiť sa cez prehliadač?", "Prijava prek brskalnika?", "Kirjaudutaanko selaimen kautta?"),
  "dlg.prf.body": row(
    "This passkey cannot give the app an encryption key here. In the browser, a passkey from your password manager or phone can.",
    "Tento passkey tady aplikaci šifrovací klíč dát neumí. V prohlížeči to umí passkey ze správce hesel nebo z telefonu.",
    "Dieser Passkey kann der App hier keinen Schlüssel liefern. Im Browser kann das ein Passkey aus Ihrem Passwortmanager oder vom Telefon.",
    "Esta llave de acceso no puede dar aquí una clave de cifrado a la app. En el navegador sí puede una llave de tu gestor de contraseñas o de tu teléfono.",
    "Questa passkey qui non può fornire all’app una chiave di crittografia. Nel browser può farlo una passkey del gestore di password o del telefono.",
    "Cette clé d’accès ne peut pas fournir ici de clé de chiffrement à l’app. Dans le navigateur, une clé de votre gestionnaire de mots de passe ou de votre téléphone le peut.",
    "Tento prístupový kľúč tu aplikácii šifrovací kľúč dať nevie. V prehliadači to dokáže kľúč zo správcu hesiel alebo z telefónu.",
    "Ta ključ za dostop tukaj aplikaciji ne more dati šifrirnega ključa. V brskalniku to zmore ključ iz upravitelja gesel ali telefona.",
    "Tämä pääsyavain ei voi antaa sovellukselle salausavainta tässä. Selaimessa sen voi antaa salasanojen hallinnan tai puhelimen pääsyavain.",
  ),
  "dlg.update.readyTitle": row("Update ready", "Aktualizace je připravena", "Update bereit", "Actualización lista", "Aggiornamento pronto", "Mise à jour prête", "Aktualizácia je pripravená", "Posodobitev je pripravljena", "Päivitys on valmis"),
  "dlg.update.ready": row(
    "M5cet {version} has been downloaded and verified. Restart to install it.",
    "M5cet {version} je stažen a ověřen. Nainstaluje se po restartu.",
    "M5cet {version} wurde geladen und geprüft. Starten Sie neu, um es zu installieren.",
    "M5cet {version} se ha descargado y verificado. Reinicia para instalarlo.",
    "M5cet {version} è stato scaricato e verificato. Riavvia per installarlo.",
    "M5cet {version} a été téléchargé et vérifié. Redémarrez pour l’installer.",
    "M5cet {version} je stiahnutý a overený. Nainštaluje sa po reštarte.",
    "M5cet {version} je prenesen in preverjen. Za namestitev znova zaženite.",
    "M5cet {version} on ladattu ja tarkistettu. Asenna se käynnistämällä uudelleen.",
  ),
  "dlg.update.none": row("M5cet {version} is up to date.", "M5cet {version} je aktuální.", "M5cet {version} ist aktuell.", "M5cet {version} está actualizado.", "M5cet {version} è aggiornato.", "M5cet {version} est à jour.", "M5cet {version} je aktuálny.", "M5cet {version} je posodobljen.", "M5cet {version} on ajan tasalla."),
  "dlg.update.off": row(
    "Updates are off in this build (it is not signed or has no update source).",
    "Aktualizace jsou v tomto sestavení vypnuté (není podepsané nebo nemá zdroj aktualizací).",
    "Updates sind in diesem Build aus (nicht signiert oder ohne Update-Quelle).",
    "Las actualizaciones están desactivadas en esta compilación (no está firmada o no tiene origen de actualizaciones).",
    "Gli aggiornamenti sono disattivati in questa build (non è firmata o non ha una fonte di aggiornamenti).",
    "Les mises à jour sont désactivées dans cette version (non signée ou sans source de mises à jour).",
    "Aktualizácie sú v tomto zostavení vypnuté (nie je podpísané alebo nemá zdroj aktualizácií).",
    "Posodobitve so v tej različici izklopljene (ni podpisana ali nima vira posodobitev).",
    "Päivitykset ovat pois päältä tässä versiossa (sitä ei ole allekirjoitettu tai sillä ei ole päivityslähdettä).",
  ),
  "dlg.update.error": row("The update check failed.", "Kontrola aktualizací selhala.", "Die Suche nach Updates ist fehlgeschlagen.", "No se pudo buscar actualizaciones.", "Verifica degli aggiornamenti non riuscita.", "La recherche de mises à jour a échoué.", "Kontrola aktualizácií zlyhala.", "Preverjanje posodobitev ni uspelo.", "Päivitysten tarkistus epäonnistui."),
  "dlg.device.title": row("Choose a device", "Vyberte zařízení", "Gerät auswählen", "Elige un dispositivo", "Scegli un dispositivo", "Choisissez un appareil", "Vyberte zariadenie", "Izberite napravo", "Valitse laite"),
  "dlg.device.body": row("{server} wants to use a device:", "{server} chce použít zařízení:", "{server} möchte ein Gerät verwenden:", "{server} quiere usar un dispositivo:", "{server} vuole usare un dispositivo:", `{server} veut utiliser un appareil${NB}:`, "{server} chce použiť zariadenie:", "{server} želi uporabiti napravo:", "{server} haluaa käyttää laitetta:"),
  "dlg.device.none": row("No suitable device is connected.", "Není připojeno žádné vhodné zařízení.", "Kein passendes Gerät angeschlossen.", "No hay ningún dispositivo adecuado conectado.", "Nessun dispositivo adatto collegato.", "Aucun appareil adapté n’est connecté.", "Nie je pripojené žiadne vhodné zariadenie.", "Ni priključene ustrezne naprave.", "Sopivaa laitetta ei ole liitetty."),
  "dlg.crash.title": row("The page stopped working", "Stránka přestala fungovat", "Die Seite funktioniert nicht mehr", "La página dejó de funcionar", "La pagina ha smesso di funzionare", "La page ne fonctionne plus", "Stránka prestala fungovať", "Stran ne deluje več", "Sivu lakkasi toimimasta"),
  "dlg.load.title": row("The server cannot be reached", "Server není dostupný", "Der Server ist nicht erreichbar", "No se puede acceder al servidor", "Il server non è raggiungibile", "Le serveur est injoignable", "Server nie je dostupný", "Strežnik ni dosegljiv", "Palvelimeen ei saada yhteyttä"),

  "welcome.title": row("Choose your M5cet server", "Vyberte svůj server M5cet", "Wählen Sie Ihren M5cet-Server", "Elige tu servidor M5cet", "Scegli il tuo server M5cet", "Choisissez votre serveur M5cet", "Vyberte svoj server M5cet", "Izberite svoj strežnik M5cet", "Valitse M5cet-palvelimesi"),
  "welcome.intro": row(
    "Enter the address you open M5cet at in the browser.",
    "Zadejte adresu, na které M5cet otevíráte v prohlížeči.",
    "Geben Sie die Adresse ein, unter der Sie M5cet im Browser öffnen.",
    "Escribe la dirección en la que abres M5cet en el navegador.",
    "Inserisci l’indirizzo da cui apri M5cet nel browser.",
    "Saisissez l’adresse à laquelle vous ouvrez M5cet dans le navigateur.",
    "Zadajte adresu, na ktorej M5cet otvárate v prehliadači.",
    "Vnesite naslov, na katerem M5cet odpirate v brskalniku.",
    "Kirjoita osoite, josta avaat M5cetin selaimessa.",
  ),
  "welcome.note": row(
    "The app brings its own signed client code — the server provides only the service, not the code that runs.",
    "Aplikace má vlastní podepsaný kód klienta — server poskytuje jen službu, ne kód, který běží.",
    "Die App bringt ihren eigenen signierten Client-Code mit — der Server liefert nur den Dienst, nicht den Code, der ausgeführt wird.",
    "La app trae su propio código de cliente firmado: el servidor solo ofrece el servicio, no el código que se ejecuta.",
    "L’app porta il proprio codice client firmato: il server fornisce solo il servizio, non il codice che viene eseguito.",
    `L’app apporte son propre code client signé${NB}: le serveur ne fournit que le service, pas le code exécuté.`,
    "Aplikácia má vlastný podpísaný kód klienta — server poskytuje len službu, nie kód, ktorý beží.",
    "Aplikacija ima lastno podpisano kodo odjemalca — strežnik zagotavlja le storitev, ne kode, ki se izvaja.",
    "Sovelluksessa on oma allekirjoitettu asiakaskoodinsa – palvelin tarjoaa vain palvelun, ei suoritettavaa koodia.",
  ),
  "welcome.unsigned": row(
    "Unsigned build — install signed releases only.",
    "Nepodepsané sestavení — instalujte jen podepsaná vydání.",
    "Nicht signierter Build — installieren Sie nur signierte Versionen.",
    "Compilación sin firmar: instala solo versiones firmadas.",
    "Build non firmata: installa solo versioni firmate.",
    "Version non signée — n’installez que des versions signées.",
    "Nepodpísané zostavenie — inštalujte len podpísané vydania.",
    "Nepodpisana različica — nameščajte le podpisane izdaje.",
    "Allekirjoittamaton versio – asenna vain allekirjoitettuja julkaisuja.",
  ),
  "welcome.servers": row("Your servers", "Vaše servery", "Ihre Server", "Tus servidores", "I tuoi server", "Vos serveurs", "Vaše servery", "Vaši strežniki", "Palvelimesi"),
  "welcome.checking": row("Checking the server…", "Ověřuji server…", "Server wird geprüft …", "Comprobando el servidor…", "Verifica del server…", "Vérification du serveur…", "Overujem server…", "Preverjam strežnik …", "Tarkistetaan palvelinta…"),
  "err.invalid": row("This is not a valid server address.", "Toto není platná adresa serveru.", "Das ist keine gültige Serveradresse.", "No es una dirección de servidor válida.", "Non è un indirizzo di server valido.", "Ce n’est pas une adresse de serveur valide.", "Toto nie je platná adresa servera.", "To ni veljaven naslov strežnika.", "Tämä ei ole kelvollinen palvelimen osoite."),
  "err.scheme": row("Only https:// servers can be used.", "Lze použít jen servery https://.", "Nur https://-Server können verwendet werden.", "Solo se pueden usar servidores https://.", "Si possono usare solo server https://.", "Seuls les serveurs https:// peuvent être utilisés.", "Možno použiť len servery https://.", "Uporabiti je mogoče le strežnike https://.", "Vain https://-palvelimia voi käyttää."),
  "err.credentials": row("A server address must not contain a user name or password.", "Adresa serveru nesmí obsahovat jméno ani heslo.", "Eine Serveradresse darf keinen Benutzernamen und kein Passwort enthalten.", "La dirección del servidor no puede contener usuario ni contraseña.", "L’indirizzo del server non può contenere nome utente o password.", "L’adresse du serveur ne doit contenir ni nom d’utilisateur ni mot de passe.", "Adresa servera nesmie obsahovať meno ani heslo.", "Naslov strežnika ne sme vsebovati uporabniškega imena ali gesla.", "Palvelimen osoitteessa ei saa olla käyttäjänimeä eikä salasanaa."),
  "err.unreachable": row("The server does not answer, or it is not an M5cet server.", "Server neodpovídá, nebo to není server M5cet.", "Der Server antwortet nicht oder ist kein M5cet-Server.", "El servidor no responde o no es un servidor M5cet.", "Il server non risponde o non è un server M5cet.", "Le serveur ne répond pas ou n’est pas un serveur M5cet.", "Server neodpovedá alebo to nie je server M5cet.", "Strežnik se ne odziva ali ni strežnik M5cet.", "Palvelin ei vastaa, tai se ei ole M5cet-palvelin."),
  "ctx.addToDictionary": row("Add to Dictionary", "Přidat do slovníku", "Zum Wörterbuch hinzufügen", "Añadir al diccionario", "Aggiungi al dizionario", "Ajouter au dictionnaire", "Pridať do slovníka", "Dodaj v slovar", "Lisää sanakirjaan"),
  "notify.background": row(
    "M5cet keeps running in the background. Quit it from the tray icon.",
    "M5cet běží dál na pozadí. Ukončíte ho z ikony v oznamovací oblasti.",
    "M5cet läuft im Hintergrund weiter. Beenden Sie es über das Symbol im Infobereich.",
    "M5cet sigue ejecutándose en segundo plano. Ciérralo desde el icono de la bandeja.",
    "M5cet resta attivo in background. Chiudilo dall’icona nell’area di notifica.",
    "M5cet continue en arrière-plan. Quittez-le depuis l’icône de la zone de notification.",
    "M5cet beží ďalej na pozadí. Ukončíte ho z ikony v oblasti oznámení.",
    "M5cet teče naprej v ozadju. Zaprete ga z ikono v sistemski vrstici.",
    "M5cet jatkaa toimintaa taustalla. Lopeta se ilmaisinalueen kuvakkeesta.",
  ),
} as const satisfies Record<string, Row>;

export type StringKey = keyof typeof STRINGS;

/** A text in `locale` (its fallback chain, then English) with {name} placeholders filled. */
export function t(locale: Locale, key: StringKey, vars: Record<string, string | number> = {}): string {
  const r: Row = STRINGS[key];
  let text = "";
  for (const l of localeChain(locale)) { if (r[l]) { text = r[l]; break; } }
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** The app's language: the page's choice once known, else the system's preferred languages. */
export function resolveLocale(pageLocale: string | null | undefined, systemPreferred: readonly string[]): Locale {
  if (isLocale(pageLocale)) return pageLocale;
  return pickLocale(systemPreferred, "en");
}

/** Spell-checker languages for a UI language (Chromium's dictionary codes; the system checker on macOS ignores them). */
export function spellcheckLanguages(locale: Locale, available: readonly string[]): string[] {
  const wanted: Record<Locale, string[]> = {
    en: ["en-GB", "en-US"], cs: ["cs"], de: ["de-DE", "de"], es: ["es-ES", "es"], it: ["it-IT", "it"],
    fr: ["fr-FR", "fr"], sk: ["sk"], sl: ["sl"], fi: ["fi"],
  };
  const pick = wanted[locale].find((c) => available.includes(c));
  const out = pick ? [pick] : [];
  // English as a second dictionary: chats mix languages.
  if (locale !== "en") { const en = wanted.en.find((c) => available.includes(c)); if (en) out.push(en); }
  return out;
}

export { LOCALES };
