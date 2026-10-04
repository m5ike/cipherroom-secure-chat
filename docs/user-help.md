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

### Víc místností naráz
Připojených může být víc místností najednou (nejvýš 8): jedna je na
obrazovce, ostatní zůstávají připojené na pozadí a hlídají zprávy.
- **Lišta místností** nad chatem ukazuje každou připojenou místnost: tečku
  stavu, počet lidí a u místností na pozadí počet **nepřečtených** zpráv.
  Klepnutím na místnost na ni přepnete i se zprávami, které mezitím přišly;
  **×** ji odpojí, **+** připojí další (zadáte místnost a klíč).
- **Klávesnice** — `Alt`+`←`/`→` přepíná mezi místnostmi.
- Zpráva v místnosti na pozadí ukáže upozornění (klepnutím se na místnost
  přepnete) a počet nepřečtených v titulku karty, např. „(2)“.
- **Okno Místnost** (záložka *Server-enhanced*) — zaškrtněte několik
  uložených připojení a stiskněte *Připojit vybrané*: první bude na
  obrazovce, ostatní na pozadí.
- Soubory se v místnosti na pozadí jen ohlásí; přijmou se, až na ni přepnete.

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

### Oznámení operátora a telefonní hovory (6.0)
- **Oznámení · operátor** — správce serveru může poslat oznámení celé
  místnosti, zprávu jen vám nebo krátké upozornění. Připnuté oznámení uvidíte
  i po vstupu do místnosti. Tyto zprávy posílá server, nejsou šifrované
  koncově jako chat. Když je místnost uzavřená nebo plná, aplikace řekne proč.
- **Telefonní hovor** — někdo vám může zavolat z běžného telefonu přes
  dočasné číslo s kódem (příkaz `/phone-bridge`, když ho správce zapne).
  Objeví se karta hovoru: *Přijmout zvukem* (mluvíte v prohlížeči), nebo
  *Textem* — řeč volajícího přijde jako zprávy „☎ …“ a co napíšete, se mu
  přečte. **Hovor jde telefonní sítí a není šifrovaný koncově.** V aplikaci
  pro Android zatím jen textem.

### Příkazy (/)
Napiš **/** na začátek zprávy — ukáže se seznam příkazů, které smíš použít
(`/help` vysvětlí všechny). Výsledek příkazu může mít **tlačítka** a
**formuláře** — kliknutím nebo odesláním pokračuješ v rozhovoru s příkazem;
**odpovědí** na jeho zprávu mu napíšeš (např. jinou doménu). Někdy přehraje
zvuk, ukáže notifikaci nebo malý widget — ten běží v izolovaném rámu a
k aplikaci ani k tvým klíčům nemá přístup. Odpověď může být i **formátovaný
výpis** (nadpisy, tabulky, obrázky) — aplikace z něj ukáže jen text, tabulky,
obrázky a odkazy, nikdy skript.

### Platební karta a doklad přes NFC — /emv, /emv-history, /eid (6.6)
Když je správce zapne a máš přístup k modulu NFC, tyto příkazy přečtou kartu
**u tebe** — jen ke čtení, tvou vlastní kartu nebo doklad:
- **`/emv`** — platební karta: její aplikace, všechny záznamy, čítače a
  **historie transakcí**, kterou si karta sama vede. Výpis přijde do chatu
  (číslo karty maskované), historie jako CSV a surové záznamy ke stažení.
- **`/emv-history`** — jen transakce z karty jako tabulka. Ne každá karta
  čitelnou historii vede — pak je tabulka prázdná; když se čtení nepovede,
  upozornění řekne proč.
- **`/eid`** — občanka nebo pas: tvoje zařízení se zeptá na **CAN** (6 číslic
  na občance) nebo na **MRZ** (2–3 řádky dole na datové stránce pasu), případně
  číslo dokladu, datum narození a platnost (RRMMDD). Klíč zůstane v zařízení,
  použije se jen pro toto čtení a na server se neposílá. Pak přilož doklad —
  čip se otevře přes PACE nebo BAC. Výpis ukáže údaje z MRZ, fotografii a
  podpis, další osobní údaje a údaje o dokladu a kontrolu otisků skupin proti
  EF.SOD; bezpečnostní soubory a obrázky JPEG 2000 jsou ke stažení. Otisky
  prstů ani duhovka se nečtou.
- Nikdy PIN, nikdy platba, nikdy zápis. Výsledek vidíš jen ty, do místnosti
  nejde.
- Na webu musí být otevřený **nástroj NFC** s připojenou čtečkou (USB,
  Bluetooth nebo sériová) — vestavěné NFC telefonu v Chrome čte jen NDEF.
- **Aplikace pro Android** příkazy obslouží sama: zespodu vyjede panel
  s výzvou přiložit kartu k zadní straně telefonu, s odpočtem a tlačítkem
  *Zrušit*. Čte vestavěným NFC telefonu, nebo USB čtečkou, kterou jsi už
  povolil v nástroji NFC (Bluetooth ani sériová čtečka tu nejde). Když je NFC
  vypnuté, panel to řekne a nabídne nastavení NFC.
- **Pozor:** výsledek běhu (výpis s fotografií a osobními údaji) se uloží
  u běhu na serveru (výchozí 30 dní) a správce s přístupem k běhům ho může
  otevřít. CAN ani MRZ, které zadáš na zařízení, mezi tím nejsou. Samotný
  nástroj NFC (*Celý výpis* a jeho export) zůstává jen v prohlížeči.

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

### Several rooms at once
You can stay connected to several rooms (up to 8): one is on screen, the
others stay connected in the background and keep collecting messages.
- **The room bar** above the chat shows each connected room: a status dot,
  the number of people and, for background rooms, the **unread** count. Tap a
  room to switch to it, with the messages that came meanwhile; **×**
  disconnects it, **+** connects one more (room and key).
- **Keyboard** — `Alt`+`←`/`→` switches between rooms.
- A message in a background room shows a notification (tap it to switch)
  and the unread count in the tab title, e.g. "(2)".
- **The Room window** (*Server-enhanced* tab) — tick several saved
  connections and press *Connect selected*: the first goes on screen, the
  others to the background.
- Files in a background room are only announced; they arrive once you switch
  to it.

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

### Operator notices and phone calls (6.0)
- **Announcement · operator** — the server's operator can send a notice to
  the whole room, a message just to you or a short alert. A pinned one is
  shown when you join. The server sends these, so they are not end-to-end
  encrypted like the chat. A closed or full room tells you why.
- **Phone call** — someone can call you from an ordinary phone through a
  temporary number and code (`/phone-bridge`, if the operator switched it
  on). A call card appears: *Take as audio* (you talk in the browser), or
  *As text* — the caller's speech arrives as "☎ …" messages and what you
  write is read to them. **The call goes over the phone network and is not
  end-to-end encrypted.** In the Android app, text only for now.

### Commands (/)
Type **/** at the start of a message to see the commands you may use (`/help`
explains them all). A command's answer may have **buttons** and **forms** —
clicking or sending them continues the conversation with it; **reply** to its
message to write to it (e.g. another domain). It may also play a sound, show a
notice or a small widget — that runs in an isolated frame with no access to
the app or your keys. An answer can also be a **formatted report** (headings,
tables, pictures) — the app shows only its text, tables, pictures and links,
never a script.

### Payment card and ID over NFC — /emv, /emv-history, /eid (6.6)
When the operator switches them on and you have the NFC module, these commands
read a card **at your device** — read-only, your own card or document:
- **`/emv`** — a payment card: its applications, every record, the counters and
  the **transaction history** the card itself keeps. The report comes to the
  chat (the card number masked), with the history as CSV and the raw records to
  download.
- **`/emv-history`** — just the card's transactions as a table. Not every card
  keeps a readable history — the table is then empty; when the read fails, a
  notice says why.
- **`/eid`** — an ID card or passport: your device asks for the **CAN** (the 6
  digits on an ID card) or the **MRZ** (the 2–3 lines at the bottom of a
  passport's data page), or the document number, date of birth and expiry
  (YYMMDD). The key stays on the device, is used for this read only and is not
  sent to the server. Then hold the document to the reader — the chip opens
  with PACE or BAC. The report shows the MRZ data, the photo and signature, more
  personal and document details and the check of each group's hash against
  EF.SOD; the security files and JPEG 2000 pictures are offered for download.
  Fingerprints and iris are never read.
- Never a PIN, never a payment, never a write. Only you see the result; it is
  not posted to the room.
- On the web the **NFC tool** must be open with a reader connected (USB,
  Bluetooth or serial) — a phone's built-in NFC in Chrome reads NDEF only.
- The **Android app** runs these commands itself: a sheet slides up asking you
  to hold the card to the back of your phone, with a countdown and *Cancel*. It
  reads with the phone's own NFC, or with a USB reader you already allowed in
  the NFC tool (not a Bluetooth or serial reader). When NFC is off, the sheet
  says so and offers the NFC settings.
- **Note:** the run's result (the report with the photo and personal data) is
  kept with the run on the server (30 days by default), and an operator with
  access to runs can open it. The CAN or MRZ you type on your device is not part
  of it. The NFC tool itself (*Full report* and its exports) stays in your
  browser.

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

### Mehrere Räume gleichzeitig
Du kannst mit mehreren Räumen verbunden bleiben (bis zu 8): einer ist im
Vordergrund, die anderen bleiben im Hintergrund verbunden und sammeln
Nachrichten.
- **Die Raumleiste** über dem Chat zeigt jeden verbundenen Raum: einen
  Statuspunkt, die Personenzahl und bei Hintergrundräumen die Zahl der
  **ungelesenen** Nachrichten. Tippe auf einen Raum, um mit den inzwischen
  gekommenen Nachrichten zu ihm zu wechseln; **×** trennt ihn, **+** verbindet
  einen weiteren (Raum und Schlüssel).
- **Tastatur** — `Alt`+`←`/`→` wechselt zwischen den Räumen.
- Eine Nachricht in einem Hintergrundraum zeigt eine Benachrichtigung
  (antippen wechselt dorthin) und die Zahl der ungelesenen im Tab-Titel,
  z. B. „(2)“.
- **Das Raum-Fenster** (Reiter *Server-enhanced*) — mehrere gespeicherte
  Verbindungen ankreuzen und *Ausgewählte verbinden* drücken: die erste kommt
  in den Vordergrund, die anderen in den Hintergrund.
- Dateien in einem Hintergrundraum werden nur angekündigt; sie kommen an,
  sobald du zu ihm wechselst.

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

### Hinweise des Betreibers und Telefonanrufe (6.0)
- **Ankündigung · Betreiber** — der Betreiber des Servers kann dem ganzen Raum
  eine Ankündigung schicken, dir allein eine Nachricht oder eine kurze Meldung.
  Eine angeheftete Ankündigung erscheint auch beim Betreten. Diese Nachrichten
  schickt der Server — sie sind nicht Ende-zu-Ende verschlüsselt wie der
  Chat. Ein geschlossener oder voller Raum sagt dir, warum.
- **Telefonanruf** — jemand kann dich von einem normalen Telefon über eine
  vorübergehende Nummer mit Code anrufen (`/phone-bridge`, wenn der Betreiber
  es eingeschaltet hat). Eine Anrufkarte erscheint: *Mit Ton annehmen* (du
  sprichst im Browser) oder *Als Text* — die Sprache des Anrufers kommt als
  „☎ …“-Nachrichten, und was du schreibst, wird ihm vorgelesen. **Der Anruf
  läuft über das Telefonnetz und ist nicht Ende-zu-Ende verschlüsselt.** In
  der Android-App vorerst nur als Text.

### Befehle (/)
Tippe **/** am Anfang einer Nachricht — die Befehle, die du nutzen darfst,
erscheinen (`/help` erklärt sie). Die Antwort eines Befehls kann **Schaltflächen**
und **Formulare** haben — damit setzt du das Gespräch fort; **antworte** auf
seine Nachricht, um ihm zu schreiben. Ein kleines Widget läuft in einem
isolierten Rahmen ohne Zugriff auf die App oder deine Schlüssel. Eine Antwort
kann auch ein **formatierter Bericht** sein (Überschriften, Tabellen, Bilder) —
die App zeigt davon nur Text, Tabellen, Bilder und Links, nie ein Skript.

### Zahlungskarte und Ausweis per NFC — /emv, /emv-history, /eid (6.6)
Wenn der Betreiber sie einschaltet und du das NFC-Modul hast, lesen diese
Befehle eine Karte **an deinem Gerät** — nur lesend, deine eigene Karte oder
dein eigenes Dokument:
- **`/emv`** — eine Zahlungskarte: ihre Anwendungen, alle Datensätze, die
  Zähler und den **Transaktionsverlauf**, den die Karte selbst führt. Der
  Bericht kommt in den Chat (Kartennummer maskiert), dazu der Verlauf als CSV
  und die Rohdatensätze zum Herunterladen.
- **`/emv-history`** — nur die Transaktionen der Karte als Tabelle. Nicht jede
  Karte führt einen lesbaren Verlauf — dann bleibt die Tabelle leer; misslingt
  das Lesen, sagt ein Hinweis, warum.
- **`/eid`** — Personalausweis oder Reisepass: dein Gerät fragt nach der
  **CAN** (6 Ziffern auf dem Ausweis) oder der **MRZ** (die 2–3 Zeilen unten auf
  der Datenseite des Passes), oder nach Dokumentnummer, Geburtsdatum und Ablauf
  (JJMMTT). Der Schlüssel bleibt auf dem Gerät, dient nur diesem Lesevorgang
  und wird nicht an den Server gesendet. Dann das Dokument an den Leser halten —
  der Chip öffnet sich mit PACE oder BAC. Der Bericht zeigt die MRZ-Daten, Foto
  und Unterschrift, weitere persönliche und Dokumentangaben und die Prüfung
  jeder Gruppe gegen EF.SOD; die Sicherheitsdateien und JPEG-2000-Bilder gibt es
  zum Herunterladen. Fingerabdrücke und Iris werden nie gelesen.
- Nie eine PIN, nie eine Zahlung, nie ein Schreibzugriff. Nur du siehst das
  Ergebnis; es geht nicht in den Raum.
- Im Web muss das **NFC-Werkzeug** mit einem verbundenen Leser offen sein (USB,
  Bluetooth oder seriell) — das eingebaute NFC des Telefons liest in Chrome nur
  NDEF.
- Die **Android-App** führt diese Befehle selbst aus: von unten erscheint ein
  Fenster, das bittet, die Karte an die Rückseite des Telefons zu halten, mit
  Countdown und *Abbrechen*. Sie liest mit dem eingebauten NFC des Telefons
  oder mit einem USB-Leser, den du im NFC-Werkzeug schon erlaubt hast (kein
  Bluetooth- oder serieller Leser). Ist NFC aus, sagt das Fenster es und bietet
  die NFC-Einstellungen an.
- **Hinweis:** das Ergebnis des Laufs (der Bericht mit Foto und persönlichen
  Daten) wird mit dem Lauf auf dem Server gespeichert (standardmäßig 30 Tage),
  und ein Betreiber mit Zugriff auf die Läufe kann es öffnen. Die CAN oder MRZ,
  die du auf dem Gerät eingibst, gehört nicht dazu. Das NFC-Werkzeug selbst
  (*Vollständiger Bericht* und seine Exporte) bleibt in deinem Browser.
