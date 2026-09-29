# M5cet — uživatelská nápověda / User help

## Česky

### První spuštění
1. Otevři aplikaci v moderním prohlížeči (Chrome, Edge, Firefox, Safari).
2. Klikni na logo nebo „Připojit" — otevře se dialog místnosti.
3. Vyplň jméno, Room ID a klíč místnosti. Klíč sdílej s druhou stranou
   **mimo tento chat** (signal, papír, telefon).
4. Po stisku Připojit se klíč odvodí lokálně (PBKDF2). Server klíč nikdy nevidí.

### Přepínání témat
Lišta nahoře → ikona palety → vyber Motorsport Dark / Glass Light / Terminal Secure.
Volba se uloží lokálně do prohlížeče.

### Nastavení
- **Jazyk** — čeština / English / Deutsch
- **Časové pásmo** — řídí zobrazení časů zpráv
- **Písmo a velikost** — ergonomie pro mobil i desktop
- **Vizuální efekty** — vypni pro slabší zařízení

### Profil
Lišta → ikona uživatele. Jméno a avatar (emoji nebo URL) se posílají s každou zprávou
ostatním peerům, ne na server.

### Soukromí & audit
- **Smazat lokální preference** — vymaže Tě z `localStorage` tohoto prohlížeče.
- **Smazat serverové logy a sync data** — pošle `POST /api/audit/purge` s tvým
  device ID. Tím zmizí settings sync, audit log a push subskripce navázané na
  tento prohlížeč.

### Šifrování
Šifrovací panel ti řekne, co se přesně používá — DTLS-SRTP pro audio, AES-GCM pro
texty/přílohy, PBKDF2 pro odvození klíče. Žádné „100 % bezpečné" sliby.

### TTL — expirace zpráv
- **Default TTL pro mé zprávy** (Šifrování → TTL): počet minut, po kterých se
  moje zprávy automaticky odstraní z UI všech peers (klient-side).
- **Override pro místnost** (Bezpečnost místnosti): hodnota přebíjí default,
  pokud je nenulová.
- **Absolutní TTL místnosti**: tvrdší limit shora (kratší ze dvou se použije).

### Soubory a obrázky
Ikony sponky a obrázku vlevo od pole zprávy. Malé soubory (do 512 kB) dorazí
jako součást zprávy, větší se samy pošlou po šifrovaných částech — nemusíte
nic přepínat. Druhá strana musí být připojená (štítek nahoře ukazuje `1 P2P`).
Velikostní strop si nastavíte v *Nastavení*.

### Seznam příjemců — ukotvení a automatické skrývání
Okno *Příjemci* (kdo dostane další zprávu) může plavat kdekoli, nebo se
přilepit k okraji chatu:
- **Ukotvení** — tlačítko s ikonou okraje v záhlaví okna (nebo ozubené kolo →
  *Ukotvení*) nabídne **Volně / Vlevo / Vpravo / Dole**. Vlevo a vpravo je
  svislý panel pod lištou, dole vodorovný pruh nad polem pro psaní (pole
  nikdy nezakryje; dlouhý seznam se posouvá). Na telefonu je přirozenou volbou
  **Dole**.
- **Přetažení** — chyť záhlaví a táhni: ukotvené okno se uvolní; když ho
  pustíš u okraje (asi 5 mm), zobrazí se přerušovaný rámeček a okno se k tomu
  okraji přilepí.
- **Připnout / skrývat** (ikona špendlíku, jen u ukotveného okna, nebo
  ozubené kolo → *Automaticky skrývat*) — připnuté je vidět pořád; skrývané se
  zasune do okraje a zůstane z něj malá záložka s počtem lidí. Najetím myší
  nebo klepnutím se vysune, po odjetí myší (asi po vteřině), klávesou Escape
  nebo klepnutím mimo se zase zasune — ne ale, dokud máš otevřené jeho
  nastavení. Záložka je obyčejné tlačítko, jde i Tabulátorem a Enterem.
- Nastavení se uloží jako ostatní vzhled (s účtem i na další zařízení).
  Když má systém zapnuté *omezení pohybu*, okno se jen ukáže a skryje, bez
  posunu.

### Režim Light / Server-enhanced
Volí se v dialogu *Připojit*. **Light** (výchozí) = jen přímé spojení mezi
prohlížeči. **Server-enhanced** navíc umí Web Push upozornění, když je karta
zavřená. Obsah zpráv server nevidí ani v jednom režimu. Podrobně
[`modes.md`](modes.md).

### Relace, pozvánky a úplné smazání
- **Reload = zpět v místnosti.** Dokud kartu nezavřete (a nejdéle hodinu bez
  aktivity), aplikace si šifrovaně pamatuje místnost i klíč a po obnovení
  stránky se připojí sama. **Odpojit** to vypne; připojit se pak dá jedním klikem.
- **Sdílet** (okno *Místnost*): vytvoří odkaz a k němu kód `XXXX-XXXX-XXXX`.
  Odkaz pošlete messengerem, **kód jinou cestou** (hlasem, SMS). Platí pro
  zvolený počet připojení; po 5 špatných kódech se zničí.
- **Smazat vše a odejít** (dole v menu ☰): smaže klíče, nastavení, cache,
  cookies i push. Historii prohlížeče web smazat neumí — tu smažete
  v nastavení prohlížeče.

Podrobně [`session-and-sharing.md`](session-and-sharing.md).

### Notifikace
Lišta → zvonek. Pokud server má nakonfigurované VAPID klíče, použije se Web Push.
Jinak fallback na lokální notifikace v tabu.

### Analytika a souhlas
Souhlas je opt-in. Bez něj klient neposílá žádné `POST /api/events`. Po souhlasu se
loguje jen kind/peerId/room/peerCount — nikdy plaintext zprávy.

### Limitace
- TTL vynucuje klient. Není to právně závazná „mizící zpráva".
- Aktuálně všichni v místnosti používají sdílený klíč. Ten je tak silný jako jeho
  out-of-band předání.
- Sync settings, audit log a analytics consent jsou v této fázi v paměti procesu.

---

### Aplikace pro Android (6.0)

- **Instalace a připojení k serveru** — při prvním spuštění zadejte adresu
  serveru (a registrační kód, pokud ho správce vyžaduje), nebo naskenujte
  QR kód od správce fotoaparátem. Aplikace si ověří klíč serveru a zapamatuje
  si ho.
- **PIN a biometrie** — nastavte PIN; když to telefon umí, nabídne se otisk
  prstu nebo obličej. Aplikace se zamkne sama po chvíli na pozadí.
  **Pozor:** každý špatný PIN i odmítnutý prst se počítá. Od třetí chyby se
  čeká (30 s, pak déle) a po posledním povoleném pokusu (nastavuje správce)
  aplikace **smaže všechna svá data** — místnosti, zprávy i klíče. Počet
  zbývajících pokusů je vidět na obrazovce zámku.
- **Víc místností naráz** — v seznamu místností zaškrtněte ty, které chcete
  mít připojené, a klepněte na *Připojit vybrané*. U každé je počet lidí a
  nepřečtených zpráv. Nad chatem je lišta připojených místností; přejetím
  prstem doleva nebo doprava přepnete na další. Dlouhý stisk na kartě
  místnost odpojí.
- **Panel lidí** — ikona lidí v horní liště ho ukáže. Může plout (táhněte za
  hlavičku), nebo se přilepit vlevo, vpravo či dole (ikona umístění nebo
  přetažení k okraji). Přilepený jde připnout, nebo nechat schovat: zajede do
  okraje a zůstane malý úchyt s počtem lidí — klepnutím ho vysunete.
- **Zprávy a hovory** — zprávy jsou šifrované stejně jako na webu; dlouhým
  stiskem zprávy na ni odpovíte nebo ji zkopírujete. Obrázek pošlete ikonou
  vlevo od pole. Hovor ikonou telefonu; když ho v nastavení povolíte, objeví
  se hovory i v systémovém záznamu hovorů.
- **Notifikace** — na zprávu jde odpovědět přímo z notifikace; když je
  aplikace zamčená, notifikace ukáže jen „Nová zpráva“.
- **Aktualizace** — nový vzhled nebo novou verzi aplikace nabídne karta
  aktualizace. Když se nový vzhled nepovede, aplikace se sama vrátí
  k předchozímu.
- **Nastavení** — biometrie, změna PINu, notifikace, tmavý vzhled, jazyk,
  záznam hovorů, kontrola aktualizací, o aplikaci a *Smazat všechna data*.

### Příkazy (/)
Napiš **/** na začátek zprávy — ukáže se seznam příkazů, které smíš použít
(`/help` vysvětlí všechny). Výsledek příkazu může mít **tlačítka** a
**formuláře** — kliknutím nebo odesláním pokračuješ v rozhovoru s příkazem;
**odpovědí** na jeho zprávu mu napíšeš (např. jinou doménu). Někdy přehraje
zvuk, ukáže notifikaci nebo malý widget — ten běží v izolovaném rámu a
k aplikaci ani k tvým klíčům nemá přístup.

## English

### First run
1. Open the app in a modern browser.
2. Click the brand logo or "Connect" to open the room dialog.
3. Provide name, Room ID and the room key. Share the key out-of-band.
4. The key is derived locally with PBKDF2 — the server never sees it.

### Themes
Top bar → palette icon → pick Motorsport Dark, Glass Light, or Terminal Secure.

### Settings
Language (cs/en/de), timezone, font family/size, visual effects toggle.

### Recipients list — docking and auto-hide
The *Recipients* window (who gets your next message) can float anywhere or
stick to an edge of the chat:
- **Dock** — the edge button in its header (or the gear → *Dock*) offers
  **Free / Left / Right / Bottom**. Left and right are a vertical panel below
  the top bar, bottom is a strip above the composer (it never covers it; a
  long list scrolls). On a phone, **Bottom** is the natural choice.
- **Drag** — grab the header: a docked window comes loose; drop it near an edge
  and a dashed outline shows where it will dock.
- **Pin / auto-hide** (the pin icon, docked only; or the gear → *Auto-hide*) —
  pinned stays visible; auto-hide slides it into its edge, leaving a small tab
  with the number of people. Hover or tap the tab to slide it out; it slides
  back after the pointer leaves (about a second), on Escape or a click
  outside — but not while its settings are open. The tab is a normal button
  (Tab, Enter).
- Saved with your other appearance settings (and with your account). With the
  system's *reduce motion* on, it just shows and hides.

### Privacy & audit
Local purge clears `localStorage`. Server purge sends `POST /api/audit/purge` with
your device id and removes settings sync, audit log, push subs.

### TTL
Default per-message TTL, room override, room absolute cap. Client-enforced.

### Limitations
Same as the Czech section above.

---

### Android app (6.0)

- **Install and connect** — on the first start enter the server's address (and
  the enrolment code if your administrator requires one), or scan the
  administrator's QR code with the camera. The app checks the server's key and
  remembers it.
- **PIN and biometrics** — choose a PIN; where the phone can, fingerprint or
  face unlock is offered. The app locks itself after a while in the background.
  **Careful:** every wrong PIN and every rejected finger counts. From the third
  failure you wait (30 s, then longer), and after the last allowed attempt
  (set by the administrator) the app **erases all its data** — rooms, messages
  and keys. The lock screen shows the attempts left.
- **Several rooms at once** — tick the rooms you want connected and tap
  *Connect selected*. Each shows its number of people and unread messages. A
  bar of connected rooms sits above the chat; swipe left or right to move to
  the next one. A long press on a tab disconnects it.
- **People panel** — the people icon in the top bar shows it. It floats (drag
  its header) or docks left, right or at the bottom (the position button, or
  drop it near an edge). Docked, pin it or let it hide: it slides into its edge
  and leaves a small tab with the number of people — tap it to slide it out.
- **Messages and calls** — end-to-end encrypted exactly as on the web; a long
  press on a message replies to it or copies it. Send a picture with the icon
  left of the field. Call with the phone icon; if you allow it in the settings,
  calls also appear in the phone's call log.
- **Notifications** — reply straight from a notification; while the app is
  locked a notification only says "New message".
- **Updates** — a new look or a new version of the app is offered on an update
  card. If a new look fails, the app goes back to the previous one by itself.

### Commands (/)
Type **/** at the start of a message to see the commands you may use (`/help`
explains them all). A command's answer may have **buttons** and **forms** —
clicking or sending them continues the conversation with it; **reply** to its
message to write to it (e.g. another domain). It may also play a sound, show a
notice or a small widget — that runs in an isolated frame with no access to
the app or your keys.

## Deutsch

### Erste Schritte
1. App in einem modernen Browser öffnen.
2. Brand-Logo oder "Verbinden" klicken, Raum-Dialog erscheint.
3. Name, Raum-ID und Raum-Schlüssel angeben. Schlüssel out-of-band teilen.
4. PBKDF2 leitet den Schlüssel lokal ab — Server sieht ihn nie.

### Vorlagen
Top-Leiste → Paletten-Icon → Motorsport Dark / Glass Light / Terminal Secure.

### Einstellungen
Sprache (cs/en/de), Zeitzone, Schrift, Größe, visuelle Effekte.

### Empfängerliste — andocken und automatisch ausblenden
Das Fenster *Empfänger* (wer deine nächste Nachricht bekommt) kann frei
schweben oder an einem Rand des Chats haften:
- **Andocken** — die Rand-Schaltfläche in seiner Kopfzeile (oder Zahnrad →
  *Andocken*) bietet **Frei / Links / Rechts / Unten**. Links und rechts ist es
  eine senkrechte Leiste unter der oberen Leiste, unten ein Streifen über dem
  Eingabefeld (das es nie verdeckt; eine lange Liste scrollt). Auf dem Handy
  ist **Unten** die natürliche Wahl.
- **Ziehen** — an der Kopfzeile greifen: ein angedocktes Fenster löst sich;
  nahe einem Rand loslassen, ein gestrichelter Rahmen zeigt, wo es andockt.
- **Anheften / ausblenden** (Stecknadel-Symbol, nur angedockt; oder Zahnrad →
  *Automatisch ausblenden*) — angeheftet bleibt es sichtbar; sonst gleitet es
  in seinen Rand, nur ein kleiner Reiter mit der Personenzahl bleibt. Mit der
  Maus darüberfahren oder tippen schiebt es heraus; es gleitet zurück, wenn
  der Zeiger es verlässt (nach etwa einer Sekunde), mit Escape oder einem
  Klick daneben — aber nicht, solange seine Einstellungen offen sind. Der
  Reiter ist eine normale Schaltfläche (Tab, Enter).
- Gespeichert wie die übrigen Darstellungs-Einstellungen (auch im Konto). Mit
  *Bewegung reduzieren* im System wird es nur ein- und ausgeblendet.

### Datenschutz
Lokale Reinigung löscht `localStorage`. Server-Purge sendet
`POST /api/audit/purge` mit deiner Geräte-ID.

### TTL
Standard-TTL je Nachricht, Raum-Override, absolute Raum-Obergrenze. Vom Client erzwungen.

### Einschränkungen
Siehe Czech-Abschnitt oben.

### Android-App (6.0)

- **Installieren und verbinden** — beim ersten Start die Adresse des Servers
  (und ggf. den Registrierungscode) eingeben oder den QR-Code des
  Administrators mit der Kamera scannen. Die App prüft den Schlüssel des
  Servers und merkt ihn sich.
- **PIN und Biometrie** — eine PIN festlegen; wo das Telefon es kann, wird
  Fingerabdruck oder Gesicht angeboten. Die App sperrt sich nach einer Weile im
  Hintergrund. **Achtung:** jede falsche PIN und jeder abgelehnte Finger zählt.
  Ab dem dritten Fehler wird gewartet (30 s, dann länger), nach dem letzten
  erlaubten Versuch (vom Administrator festgelegt) **löscht die App alle ihre
  Daten** — Räume, Nachrichten und Schlüssel.
- **Mehrere Räume gleichzeitig** — die gewünschten Räume ankreuzen und
  *Ausgewählte verbinden* tippen. Jeder zeigt die Zahl der Personen und
  ungelesenen Nachrichten; über dem Chat eine Leiste der verbundenen Räume,
  Wischen wechselt zum nächsten.
- **Personen-Panel** — frei schwebend oder links, rechts, unten angedockt;
  angedockt anheften oder automatisch ausblenden (ein kleiner Griff bleibt am
  Rand, Tippen fährt es heraus).
- **Nachrichten, Anrufe, Benachrichtigungen** — Ende-zu-Ende-verschlüsselt wie
  im Web; Antworten direkt aus der Benachrichtigung; Anrufe auf Wunsch im
  Anrufprotokoll des Telefons.
- **Updates** — ein neues Aussehen oder eine neue Version wird auf einer Karte
  angeboten; misslingt ein neues Aussehen, kehrt die App selbst zum vorigen zurück.

### Befehle (/)
Tippe **/** am Anfang einer Nachricht — die Befehle, die du nutzen darfst,
erscheinen (`/help` erklärt sie). Die Antwort eines Befehls kann **Schaltflächen**
und **Formulare** haben — damit setzt du das Gespräch fort; **antworte** auf
seine Nachricht, um ihm zu schreiben. Ein kleines Widget läuft in einem
isolierten Rahmen ohne Zugriff auf die App oder deine Schlüssel.
