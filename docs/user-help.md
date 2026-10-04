# M5cet — uživatelská nápověda / User help

## Česky

### První spuštění
1. Otevři aplikaci v moderním prohlížeči (Chrome, Edge, Firefox, Safari).
2. Klikni na logo nebo „Připojit" — otevře se dialog místnosti.
3. Vyplň jméno, Room ID a klíč místnosti. Klíč sdílej s druhou stranou
   **mimo tento chat** (signal, papír, telefon).
4. Po stisku Připojit se klíč odvodí lokálně (Argon2id). Server klíč nikdy nevidí.
5. **Síla klíče (6.7)** — pod polem klíče je měřidlo (slabý / ujde / silný,
   odhad v bitech) s radami a tlačítkem *Vygenerovat silný klíč*. Slabý klíč
   pro místnost zadanou ručně (není mezi uloženými připojeními) aplikace
   poprvé nepustí a vysvětlí proč: kdo má data serveru, může slabý klíč
   uhodnout offline. Připojuješ-li se do místnosti, která už tento klíč
   používá, stiskni *Připojit* ještě jednou. (Jen web; aplikace pro Android
   sílu klíče zatím neměří.)

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
Menu › *Notifikace*. Pokud server má nakonfigurované VAPID klíče, použije se Web Push.
Jinak fallback na lokální notifikace v tabu. Od 6.7 tam je i vlastní volba
upozornění — viz [Upozornění (6.7)](#upozornění-67).

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
  **Pozor:** každý špatný PIN se počítá — i když aplikaci během ověřování
  zavřete (od 6.7 se pokus zapíše dřív, než se PIN ověří). Odmítnutý prst se
  od 6.7 nepočítá (po několika nezdarech zamkne snímač sám systém). Od třetí
  chyby se čeká (30 s, pak déle) a po posledním povoleném pokusu (nastavuje
  správce) aplikace **smaže všechna svá data** — místnosti, zprávy i klíče.
  Počet zbývajících pokusů je vidět na obrazovce zámku. Změna PINu chce
  současný PIN.
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
- **Notifikace** — na zprávu jde odpovědět přímo z notifikace (na Androidu 12
  a novějším až po odemčení telefonu); když je aplikace zamčená — od 6.7 i na
  pozadí po uplynutí automatického zamčení —, notifikace zprávy ukáže jen
  „Nová zpráva“, bez odesílatele, místnosti a odpovědi, a na zamčené obrazovce
  telefonu je vždy jen tato neutrální verze.
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

### Hlas: diktování, odeslat jako hlas, měnič hlasu (6.7)
- **Diktování** — ikona řeči v poli zprávy (web: tlačítko vedle mikrofonu;
  ukáže se, jen když prohlížeč rozpoznávání řeči umí, nebo v režimu
  Server-enhanced, když server nabízí přepis). Text se píše do pole, jak
  mluvíš, a poslech běží, dokud ho nezastavíš — po pauze se rozpoznávání samo
  znovu rozběhne (po několika tichých pokusech za sebou skončí hláškou „Nic
  jsem neslyšel“). Zastaví ho znovu ikona (čtvereček): poslední slova se ještě
  dopíšou a mikrofon se uvolní. Diktování skončí i odchodem z místnosti; na
  webu odeslání nebo smazání pole diktování přeruší (rozpracovaná slova se
  zahodí), na Androidu *Odeslat* počká na poslední slova a pak zprávu pošle
  a diktování skončí i s aplikací v pozadí.
- **Poslat text jako hlas** — text z pole přečte hlas a odejde jako šifrovaná
  hlasová zpráva, stejně jako nahraná (bez textu). Web (6.8): v nabídce *Typ
  zprávy* (šipka u *Odeslat* nebo dlouhý stisk *Odeslat*) je zaškrtávací
  volba *Poslat jako hlas*. Když je zaškrtnutá, *Odeslat* (i Enter) pošle
  místo textu hlasovou zprávu; tlačítko *Odeslat* pak ukazuje reproduktor,
  číslo u šipky volbu započítá a pod polem stojí *Jako hlasová zpráva*.
  Zůstane zapnutá i pro další zprávy jako ostatní typy zprávy — vypneš ji
  odškrtnutím nebo *Vyčistit* (po znovunačtení stránky je vypnutá). Klikací
  a mizející volba platí i pro hlasovou zprávu, vybraní příjemci také
  a odpověď zůstane odpovědí. S *Individuálně šifrovanou* zprávou to nejde
  (hlasová zpráva by kódem zašifrovaná nebyla): aplikace nic neodešle —
  ani text bez kódu — a řekne proč. Text delší než 2000 znaků odmítne,
  místo aby ho usekla; hlasovou zprávu, ze které by byl velký soubor (ten
  jde všem v místnosti), odmítne pro vybrané příjemce a pro klikací či
  mizející zprávu. Příkazy (`/…`) a odpovědi funkcím zůstávají textem.
  Jednorázové tlačítko *Poslat jako hlas* má dál panel *Řeč*. Jen hlas
  serveru (hlasy prohlížeče nahrát nejdou) — server text uvidí; když převod
  textu na řeč nezapnul správce, aplikace to řekne. Android: dlouhý stisk
  *Odeslat* (nebo mikrofonu) otevře volby odeslání; je-li pole prázdné,
  přečte to, co teď nadiktuješ; hlas telefonu, nebo hlas serveru, když je
  v *Nastavení › Hlas* zvoleno *Na serveru*.
- **Nadiktovat a poslat text** (jen Android, ve volbách odeslání) — mluvíš,
  text se píše do pole; ■ nebo *Odeslat* ho pošle jako obyčejnou zprávu.
- **Měnič hlasu** — modul, který zapíná správce (konzole › *Modules &
  groups*; bez toho je vypnutý). Pak si ho každý zapne u sebe: web *Menu ›
  Nástroje › Měnič hlasu* (položka je vidět, jen když ho správce zapnul),
  Android *Nastavení › Hlas › Měnič hlasu*. Předvolby (vyšší, nižší, hluboký,
  robot, ozvěna, šepot, anonym) nebo vlastní výška, barva (formanty), robot,
  ozvěna, šepot a hlasitost; *Vyzkoušet* nahraje 4 s a přehraje je. Mění hlas
  všeho, co aplikace nahrává mikrofonem — hovorů, hlasových zpráv a nahrávek
  pro přepis na serveru (na webu i telefonního mostu) — přímo v zařízení,
  ještě před šifrováním; kvůli tomu nikam neodchází žádný zvuk. Diktování
  rozpoznáváním řeči prohlížeče nebo telefonu poslouchá mikrofon samo a dává
  jen text; na něj se měnič nevztahuje. Bez sluchátek může druhá strana
  v hovoru slyšet ozvěnu svého hlasu změněnou. Aplikace pro Android se
  o zapnutí modulu dozví nejpozději do 10 minut.

### Kdo je v místnosti: přítomnost a „naposledy online“ (6.7)
- Kdo místnost neopustí tlačítkem **Odpojit**, zůstává v seznamu lidí — i když
  mu spadne síť, zavře kartu nebo dá aplikaci do pozadí. Když mu spojení
  spadne, ukáže se v chatu řádek „‹jméno› je pryč — spojení se přerušilo,
  v místnosti zůstává.“
- U každého je barevná tečka a „Naposledy online před …“ (kdy měl naposledy
  aplikaci otevřenou a byl připojený):
  - **zelená — Online**: má aplikaci teď otevřenou, nebo ji naposledy měl
    nejvýš před 5 minutami (kdo dá aplikaci do pozadí, je prvních 5 minut
    ještě zelený);
  - **žlutá — Pryč**: naposledy online před 5 až 60 minutami;
  - **oranžová — Dlouho pryč**: před víc než hodinou (nebo nevíme kdy).
- Web hlásí kartu na pozadí po 1,5 s a přepnutí do jiné aplikace (karta
  zůstane vidět) po 30 s; Android hned, jak aplikace odejde do pozadí. Tečky
  se přebarvují samy, i když nikdo nepíše.
- **Kde to vidíš** — web: tečka u avataru ve widgetu příjemců, okno *Peers*
  (menu) a detail člověka (řádek *Přítomnost*); Android: panel lidí
  a detail osoby (řádek *Naposledy online*; kdo je bez spojení, má ikonu
  měsíce).
- **Kdy člověk ze seznamu zmizí** — když klikne *Odpojit*; když ho (nebo
  celou místnost) odpojí operátor; když server zruší jeho přihlášení
  (odhlášení všude) nebo ho vyhodí kvůli limitům; a když se do 7 dní nevrátí
  (operátor to mění proměnnou `PRESENCE_MAX_AWAY_DAYS`). Restart serveru
  zapomene lidi bez spojení — kromě přihlášených, pro které server drží
  zprávy.
- **Návrat** — po obnovení stránky (v téže kartě) nebo po znovuotevření
  aplikace pro Android jsi v místnosti zase ty, ne nový člen. Zavřená karta
  na webu si to nepamatuje: host se vrátí jako nový člen (starý záznam
  zůstane, dokud nevyprší); přihlášený uživatel svůj starý záznam nahradí.
- Přihlášený uživatel, pro kterého server drží zprávy (stav away), zůstává
  v místnosti jako nepřítomný i po *Odpojit* — tak jako dřív.
- Přítomnost a „naposledy online“ vidí jen lidé v téže místnosti (a operátor
  v konzoli); obsah zpráv server dál nevidí.

### Poloha: navigovat, odvoz, kopírovat (6.7)
- **Web**: zpráva s polohou ukazuje v bublině místo mapy **špendlík se
  souřadnicemi** (u živé polohy „živě“); zpráva, která polohu nese
  v hlavičce, má v záhlaví ikonu špendlíku. Klepnutí otevře okno polohy:
  mapa (pokud ji správce zapnul; klepnutím se otevře OpenStreetMap),
  souřadnice s přesností a tlačítka **Navigovat**, **Odvoz** a
  **Kopírovat**.
  - *Navigovat*: Google Maps, Apple Maps, Waze, Mapy.com nebo OpenStreetMap
    (v prohlížeči na Androidu i mapová aplikace telefonu).
  - *Odvoz*: Uber s vyplněným cílem; Bolt, Liftago a FREENOW cíl převzít
    neumějí — otevře se jejich stránka a souřadnice se zkopírují („Cíl je ve
    schránce — vložte ho v aplikaci.“).
  - *Kopírovat*: souřadnice ve tvaru `50.087500, 14.421300`.
- **Android**: zpráva s polohou dál ukazuje malou mapu (je-li zapnutá);
  klepnutí na ni nebo *Poloha na mapě* v nabídce dlouhého stisku otevře
  stejné okno. *Navigovat* nabídne nejdřív nainstalované aplikace (Google
  Maps, Waze, Mapy.com, OsmAnd, Sygic, HERE WeGo a další mapové aplikace),
  pak webové odkazy těch nenainstalovaných. *Odvoz*: Uber (aplikace, jinak
  web); u Boltu, Liftaga a FREENOW se souřadnice zkopírují a otevře se
  aplikace, jinak jejich stránka.
- **Soukromí**: nic se nikam neposílá, dokud neklepneš na odkaz; mapa jde
  přes server M5cet. Klepnutím na navigaci nebo odvoz ale předáš souřadnice
  té službě (Uberu i jméno odesílatele polohy, když poloha není tvoje).

### Zprávy „podržet a číst“ (6.7)
Zprávu, která se ukáže jen při podržení, teď jde podržet i za **prázdné
místo vedle bubliny** — text tak není pod prstem. Odkryje se po krátkém
podržení (asi 0,2 s), takže posouvání chatu, které tam začne, nic neodkryje.
Platí na webu i v aplikaci pro Android.

### Upozornění (6.7)
- **Kde**: web *Menu › Notifikace* (část *Moje upozornění*), Android
  *Nastavení › Oznámení*.
- **Co jde nastavit**: upozornění zapnout / vypnout; na co upozorňovat (nové
  zprávy, zmínky o mně, výzvy operátora; *Hovory* a *Výsledky příkazů* jsou
  v nabídce připravené, ale server je zatím sám neposílá); **co upozornění
  ukáže** — *nic, jen že něco přišlo* / *kdo píše* / *kdo píše a v které
  místnosti* / *také náhled zprávy* (náhled umí jen zařízení, které zprávu
  samo dešifruje; server úroveň může omezit); **tiché hodiny** (od–do, i přes
  půlnoc; v tu dobu nepřijde nic kromě testu) a *Poslat zkušební upozornění*.
- **Kudy** (jen přihlášení): pořadí cest — aplikace pro Android, prohlížeč
  (web push), e-mail. Když první cesta selže, server zkusí další. E-mail jde
  jen tehdy, když ho správce zapnul a ty jsi adresu potvrdil odkazem
  z potvrzovacího e-mailu (platí 48 h); adresa se zadává na webu.
- **Android**: přepínač *Server drží mé zprávy a probudí mě* — zprávy čekají
  na serveru zašifrované a upozornění přijde zapečetěné jen pro tento telefon;
  aplikace sama doplní název místnosti. Je-li aplikace zamčená, upozornění
  je neutrální — jen „Nová zpráva“, bez odesílatele, místnosti a odpovědi;
  na zamčené obrazovce telefonu je vždy jen „Nová zpráva“.
- **Bez přihlášení** platí volba jen pro upozornění, která ukazuje otevřená
  stránka.
- **Zmínka**: napíšeš-li ve zprávě `@jméno` člověka, který je pryč, dostane
  upozornění „zmínka“ (server se dozví jen to, komu, ne text).

### Veřejný profil (6.7)
- **Kde**: web *Profil* (část *Veřejný profil*), Android *Nastavení ›
  Uživatel › Veřejný profil*. Potřebuje přihlášení passkeyem.
- **Co v něm je**: profilová fotka, fotka na pozadí, veřejná přezdívka,
  „O mně“ a až 24 dalších údajů (jméno, telefon, e-mail, adresa, web,
  sociální síť, organizace, narozeniny, jiné).
- **U každé položky zvolíš, kdo ji uvidí**:
  - *Jen já* — zůstane zapečetěné v trezoru tvého účtu;
  - *Členové místností* (Android: *Místnosti*) — pošle se šifrovaně
    (end-to-end, párovým klíčem) lidem v místnostech, do kterých vstoupíš;
    server to nepřečte;
  - *Veřejné* — uloží se na serveru a přečte si to každý, kdo zná tvé
    uživatelské jméno; server to vidí.

  Nové položky jsou *Jen já*, přezdívka je výchozí *Veřejné*. *Jak mě vidí
  ostatní* ukáže náhled pro každé publikum.
- **Obrázky** se před uložením zmenší a překódují do JPEG a metadata (EXIF,
  poloha GPS, fotoaparát) se zahodí.
- **Přezdívka** se předvyplní jako tvé jméno, když vstupuješ do místnosti
  (u uloženého připojení na Androidu má přednost jméno uložené v něm);
  v místnosti ho můžeš změnit.
- **Profil druhých**: v detailu člověka je, co sdílí v místnosti; *Zobrazit
  veřejný profil @jméno* ho načte ze serveru až na požádání. Patří-li
  veřejný profil účtu, který podepisuje zprávy tohoto člověka, aplikace to
  řekne.
- Operátor může veřejný profil účtu odebrat (konzole); zveřejnit ho pak jde
  znovu.

### Aplikace pro Android: vzhled a gesta v seznamu místností (6.7)
- **Šest nových šablon vzhledu** — Les, Západ slunce, Levandule, Moka,
  Arktida a Inkoust, každá světlá i tmavá (*Nastavení › Vzhled*).
- **Nabídky s ikonami** v barvách vzhledu (hlavní menu, menu místnosti,
  dlouhý stisk zprávy…); nebezpečné volby (smazat, wipe) jsou červené.
- **Přejetí po řádku místnosti**: doprava → **Smazat** (po potvrzení
  místnost opustí, odebere ze seznamu a smaže její historii v tomto telefonu;
  ostatních se to netýká); doleva → **Klonovat** (uloží kopii pod dalším
  volným jménem, např. „Tým 2“, se stejným klíčem a přezdívkou; nepřipojí ji)
  a **Upravit** (jméno, místnost a klíč; nový název místnosti znamená novou
  místnost — stará historie zůstane v telefonu; připojená se připojí znovu).
  Stejné akce nabízí TalkBack.

### Aplikace pro Android: místnosti jako konverzace (6.8)
- **Co to je**: připojené místnosti se v telefonu chovají jako konverzace
  (jako u Signalu nebo WhatsAppu) — jsou v sekci *Konverzace* v oznámeních,
  v horní řadě nabídky *Sdílet* a po podržení ikony aplikace.
- **Sdílení do místnosti**: sdílíš-li text z jiné aplikace a zvolíš místnost
  v horní řadě, aplikace ji otevře a text vloží do pole zprávy — **sám se
  neodešle**. Obrázky takto sdílet nejde.
- **Prioritní konverzace a widget**: podržením oznámení místnosti ji označíš
  jako prioritní; widget *Konverzace* ji dá na plochu. Menu místnosti ›
  *Konverzace v telefonu* otevře nastavení téhle konverzace (Android 11+).
- **Nastavení › Oznámení › Konverzace v Androidu**: *Místnosti jako
  konverzace Androidu* (vypnutím se všechny odeberou) a *Ukazovat názvy
  místností*.
- **Soukromí**: název místnosti systém vidí jen když je aplikace odemčená
  a oznámení smí místnost jmenovat (*Soukromí* na téže obrazovce). Jinak —
  a jakmile se aplikace zamkne, i samo po době automatického zámku — se
  konverzace jmenují neutrálně „Konverzace 1“, „Konverzace 2“… Obsah zpráv
  ani klíč místnosti v nich nikdy není. Odejdeš-li z místnosti nebo ji
  smažeš, její konverzace zmizí.
- Bubliny (plovoucí okénka konverzací) aplikace nemá.

### Hovory v záznamu telefonu a Záznam hovorů a zpráv (6.8)
- **Záznam** — ikona hodin s šipkou v liště seznamu místností (nebo hlavní
  menu › *Záznam*) ukáže hovory i zprávy ze všech uložených místností
  v jednom seznamu, nejnovější nahoře, po dnech. Nahoře je filtr *Vše /
  Hovory / Zprávy / Zmeškané* a hledání (místnost, člověk nebo text zprávy;
  na velikosti písmen a diakritice nezáleží — potvrďte klávesou nebo lupou).
  Klepnutí otevře místnost (u zprávy se na ni posune), tlačítko telefonu
  u hovoru zavolá do místnosti znovu — **vždy až po potvrzení**, protože
  hovor uslyší všichni, kdo jsou v místnosti připojení.
- **Co Záznam ukáže** — zapečetěná, „podržet a číst“, mizející a skrytá
  zpráva je v něm jen svým druhem („Zapečetěná zpráva“…), nikdy svým textem,
  a hledání do ní nevidí. Zprávy bere Záznam přímo z historie místností,
  nic dalšího neukládá. Hovory si aplikace pamatuje zvlášť: zašifrovaně jen
  v tomto telefonu, nejvýš 500 hovorů z posledních 90 dní (*Nastavení ›
  Hovory › Ukládat historii hovorů*; *Smazat historii hovorů* ji smaže).
- **Druhy hovorů** — *odchozí* (hovor jste začali vy), *příchozí* (připojili
  jste se k hovoru někoho jiného), *zmeškaný* (hovor v místnosti skončil bez
  vás) a *odmítnutý*. Když hovor začne někdo jiný, telefon zazvoní
  upozorněním s tlačítky **Připojit se** a **Odmítnout**; řídí se přepínačem
  *Hovory*, tichými hodinami a úrovní soukromí v *Nastavení › Oznámení*
  (při zamčené aplikaci jen „Hovor“, bez místnosti a jména). Místnost, kterou
  máte otevřenou, nezvoní.
- **Záznam hovorů telefonu** — *Nastavení › Hovory › Hovory do systémového
  záznamu*: aplikace požádá o oprávnění k seznamu hovorů (bez něj přepínač
  zůstane vypnutý) a hovory pak zapíše i do aplikace Telefon — s časem,
  délkou a příznakem videa. Položka **nemá číslo**, takže ji aplikace
  Telefon nevytočí; zavolat zpět jde ze Záznamu v M5cet. Záznam hovorů
  telefonu si může přečíst každá aplikace s oprávněním k seznamu hovorů,
  proto položka ve výchozím stavu ukáže **jen jméno aplikace**; v *Položka
  v záznamu ukáže* můžete zvolit i místnost, nebo místnost a lidi. Dokud je
  aplikace zamčená, zapíše se vždy jen jméno aplikace. Některé aplikace
  Telefon jméno neukážou a napíšou „Neznámé“ (s ikonou M5cet).
  *Odebrat hovory této aplikace ze záznamu telefonu* je zase smaže;
  *Smazat všechna data* je smaže také.

## English

### First run
1. Open the app in a modern browser.
2. Click the brand logo or "Connect" to open the room dialog.
3. Provide name, Room ID and the room key. Share the key out-of-band.
4. The key is derived locally with Argon2id — the server never sees it.
5. **Key strength (6.7)** — under the key field there is a meter (weak / fair /
   strong, an estimate in bits) with tips and a *Generate a strong key* button.
   A weak key for a room typed in by hand (not a saved connection) is held back
   the first time, with the reason: whoever holds the server's data could guess
   a weak key offline. If you are joining a room that already uses this key,
   press *Connect* again. (Web only; the Android app does not measure key
   strength yet.)

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
  **Careful:** every wrong PIN counts — even when you close the app while it
  checks (from 6.7 the attempt is written down before the PIN is checked). A
  rejected finger no longer counts from 6.7 (the system locks the sensor after
  a few). From the third failure you wait (30 s, then longer), and after the
  last allowed attempt (set by the administrator) the app **erases all its
  data** — rooms, messages and keys. The lock screen shows the attempts left.
  Changing the PIN asks for the current one.
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
- **Notifications** — reply straight from a notification (on Android 12 and
  newer only after unlocking the phone); while the app is locked — from 6.7
  also in the background once the auto-lock time has passed — a message
  notification only says "New message", without sender, room or reply, and
  the phone's lock screen always shows just this neutral version.
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

### Voice: dictation, send as voice, the voice changer (6.7)
- **Dictation** — the speech icon in the message field (web: the button next to
  the microphone; it shows only where the browser recognises speech, or in
  Server-enhanced when the server offers transcription). The text appears as
  you speak, and listening goes on until you stop it — after a pause the
  recogniser starts again by itself (after several silent restarts in a row it
  ends with "I heard nothing"). The icon again (a square) stops it: the last
  words still arrive and the microphone is released. Leaving the room ends it
  too; on the web, sending or clearing the field cancels it (words still in
  progress are dropped); on Android *Send* waits for the last words and then
  sends, and the app going to the background ends it as well.
- **Send the text as voice** — the field's text is read by a voice and goes as
  an encrypted voice message, just like a recorded one (without the text).
  Web (6.8): the *Message type* menu (the arrow by *Send*, or a long press on
  *Send*) has a checkbox *Send as voice*. While it is ticked, *Send* (and
  Enter) sends a voice message instead of the text; the *Send* button then
  shows a speaker, the number by the arrow counts the option and the line
  under the field says *As a voice message*. It stays on for the next
  messages like the other message types — untick it or press *Clear* (after
  a page reload it is off). Tap-to-reveal and disappearing apply to the voice
  message too, so do the chosen recipients, and a reply stays a reply. It
  does not work with an *Individually encrypted* message (the voice message
  would not be encrypted with the code): the app sends nothing — not the text
  without the code either — and says why. A text longer than 2000 characters
  is refused rather than cut short; a voice message that would be a big file
  (which goes to everyone in the room) is refused for chosen recipients and
  for a tap-to-reveal or disappearing message. Commands (`/…`) and replies to
  functions stay text. The *Speech* panel keeps its one-off *Send as voice*
  button. The server's voice only (the browser's voices cannot be recorded)
  — the server sees the text; without the operator's text to speech the app
  says so. Android: a long press
  on *Send* (or the microphone) opens the send options; with an empty field it
  reads what you dictate now; the phone's voice, or the server's when
  *Settings › Voice* says *On the server*.
- **Speak it, send text** (Android only, in the send options) — you speak,
  the text appears in the field; ■ or *Send* sends it as an ordinary message.
- **Voice changer** — a module the operator turns on (console › *Modules &
  groups*; off otherwise). Then everyone switches it on for themselves: web
  *Menu › Tools › Voice changer* (the item shows only once the operator turned
  it on), Android *Settings › Voice › Voice changer*. Presets (higher, lower,
  deep, robot, echo, whisper, anonymous) or your own pitch, timbre (formants),
  robot, echo, whisper and volume; *Try it* records 4 s and plays them back.
  It changes the voice of everything the app records from the microphone —
  calls, voice messages and recordings sent for transcription on the server
  (on the web, the phone bridge too) — on the device, before encryption; no
  audio leaves it for this. Dictation by the browser's or phone's speech
  recognition listens to the microphone itself and gives only text; the voice
  changer does not apply to it. Without headphones the other side of a call
  may hear the echo of their own voice changed. The Android app learns that
  the module was turned on within 10 minutes.

### Who is in the room: presence and "last seen" (6.7)
- Whoever does not leave with **Disconnect** stays in the room's list of
  people — even when their network drops, they close the tab or send the app
  to the background. When their connection drops, the chat shows "‹name› is
  away — the connection went, they stay in the room."
- Everyone has a coloured dot and "Last seen … ago" (when they last had the
  app open while connected):
  - **green — Online**: the app is open now, or was at most 5 minutes ago
    (someone who sends the app to the background stays green for the first
    5 minutes);
  - **yellow — Away**: last seen 5 to 60 minutes ago;
  - **orange — Far away**: more than an hour ago (or not known).
- The web reports a tab in the background after 1.5 s and another app in
  front (the tab still visible) after 30 s; Android as soon as the app goes to
  the background. The dots recolour by themselves, even when nobody writes.
- **Where** — web: the dot on the avatar in the recipients widget, the
  *Peers* window (menu) and a person's details (*Presence* row);
  Android: the people panel and a person's detail (*Last seen* row; someone
  without a connection has a moon icon).
- **When someone leaves the list** — when they press *Disconnect*; when the
  operator disconnects them (or the whole room); when the server revokes their
  sign-in (sign out everywhere) or throws them out for its limits; and when
  they do not come back within 7 days (the operator changes this with
  `PRESENCE_MAX_AWAY_DAYS`). A server restart forgets people without a
  connection — except signed-in ones whose messages the server keeps.
- **Coming back** — after reloading the page (in the same tab) or reopening
  the Android app you are the same member again, not a new one. A closed tab
  on the web does not remember it: a guest comes back as a new member (the old
  entry stays until it expires); a signed-in user replaces their old entry.
- A signed-in user whose messages the server keeps (away) stays in the room
  as absent even after *Disconnect* — as before.
- Presence and "last seen" are seen only by people in the same room (and the
  operator in the console); the server still sees no message content.

### Position: navigate, ride, copy (6.7)
- **Web**: a message with a position shows a **pin with the coordinates** in
  the bubble instead of a map ("live" for a live position); a message that
  carries the position in its header has a pin icon in the head. A tap opens
  the position window: the map (if the operator turned it on; a tap opens
  OpenStreetMap), the coordinates with their accuracy and the buttons
  **Navigate**, **Ride** and **Copy**.
  - *Navigate*: Google Maps, Apple Maps, Waze, Mapy.com or OpenStreetMap (in
    a browser on Android also the phone's map app).
  - *Ride*: Uber with the destination filled in; Bolt, Liftago and FREENOW
    cannot take a destination — their page opens and the coordinates are
    copied ("The destination is on the clipboard — paste it in the app.").
  - *Copy*: the coordinates as `50.087500, 14.421300`.
- **Android**: a position message still shows a small map (when it is on); a
  tap on it, or *Position on a map* in the long-press menu, opens the same
  window. *Navigate* offers the installed apps first (Google Maps, Waze,
  Mapy.com, OsmAnd, Sygic, HERE WeGo and other map apps), then the web links
  of those not installed. *Ride*: Uber (the app, else the web); for Bolt,
  Liftago and FREENOW the coordinates are copied and the app opens, else
  their page.
- **Privacy**: nothing is sent anywhere until you tap a link; the map comes
  through the M5cet server. Tapping a navigation or ride app does hand the
  coordinates to that service (to Uber also the sender's name, when the
  position is not yours).

### "Hold to read" messages (6.7)
A message shown only while held can now also be held by the **empty space
beside its bubble** — so the text is not under your finger. It opens after a
short hold (about 0.2 s), so a scroll that starts there reveals nothing. On
the web and in the Android app.

### Notifications (6.7)
- **Where**: web *Menu › Notifications* (part *My notifications*), Android
  *Settings › Notifications*.
- **What you choose**: notifications on / off; what about (new messages,
  mentions of me, the operator calling me back; *Calls* and *Command results*
  are offered but the server does not send them by itself yet); **what a
  notification shows** — *nothing, only that something came* / *who writes* /
  *who writes, and in which room* / *a preview too* (only a device that
  decrypts the message itself can preview it; the server may limit the
  level); **quiet hours** (from–to, also across midnight; nothing but a test
  comes then) and *Send a test notification*.
- **How** (signed in only): the order of the ways — the Android app, the
  browser (web push), e-mail. When the first way fails, the server tries the
  next. E-mail goes only when the operator turned it on and you confirmed the
  address with the link in the confirmation mail (valid 48 h); the address is
  entered on the web.
- **Android**: the switch *The server keeps my messages and wakes me* —
  messages wait on the server encrypted and the notification comes sealed for
  this phone only; the app fills in the room's name itself. While the app is
  locked the notification is neutral — just "New message", without sender,
  room or reply; the phone's lock screen always shows only "New message".
- **Not signed in**, the choice applies only to the notifications the open
  page shows.
- **Mentions**: write `@name` of someone who is away and they get a "mention"
  notification (the server learns only whom, not the text).

### Public profile (6.7)
- **Where**: web *Profile* (part *Public profile*), Android *Settings › User
  › Public profile*. It needs a passkey sign-in.
- **What it holds**: a profile photo, a background photo, a public nickname,
  "About me" and up to 24 more items (name, phone, e-mail, address, web,
  social network, organisation, birthday, other).
- **For each item you choose who sees it**:
  - *Only me* — stays sealed in your account's vault;
  - *Room members* (Android: *Rooms*) — sent end-to-end encrypted (with the
    pair key) to the people in the rooms you join; the server cannot read it;
  - *Public* — stored on the server, readable by anyone who knows your
    username; the server sees it.

  New items are *Only me*, the nickname defaults to *Public*. *How others see
  me* previews each audience.
- **Pictures** are scaled down and re-encoded as JPEG before saving, and their
  metadata (EXIF, GPS position, camera) is dropped.
- **The nickname** pre-fills your name when you join a room (on Android a
  saved connection's own name wins); you can change it there.
- **Other people's profiles**: a person's details show what they share in the
  room; *Show the public profile @name* fetches it from the server only when
  you ask. When the public profile belongs to the account that signs this
  person's messages, the app says so.
- The operator can remove an account's public profile (console); it can be
  published again.

### Android app: look and gestures in the room list (6.7)
- **Six new templates** — Forest, Sunset, Lavender, Mocha, Arctic and Ink,
  each light and dark (*Settings › Appearance*).
- **Menus with icons** in the look's colours (main menu, room menu, a
  message's long press…); dangerous choices (delete, wipe) are red.
- **Swipe a room's row**: right → **Delete** (after a confirmation it leaves
  the room, removes it from the list and deletes its history on this phone;
  nobody else is affected); left → **Clone** (saves a copy under the next free
  name, e.g. "Team 2", with the same key and nickname; does not connect it)
  and **Edit** (name, room and key; a new room name means a new room — the old
  history stays on the phone; a connected room reconnects). TalkBack offers
  the same actions.

### Android app: rooms as conversations (6.8)
- **What it is**: joined rooms behave like conversations on the phone (as in
  Signal or WhatsApp) — in the *Conversations* section of notifications, in
  the top row of the *Share* sheet and when you hold the app's icon.
- **Sharing into a room**: share text from another app and pick a room in the
  top row — the app opens it with the text in the message field; **it is not
  sent by itself**. Pictures cannot be shared this way.
- **Priority conversations and the widget**: hold a room's notification to
  mark it as priority; the *Conversation* widget puts it on the home screen.
  The room's menu › *Conversation on the phone* opens that conversation's
  settings (Android 11+).
- **Settings › Notifications › Android conversations**: *Rooms as Android
  conversations* (switching it off removes them all) and *Show room names*.
- **Privacy**: the system sees a room's name only while the app is unlocked
  and notifications may name the room (*Privacy* on the same screen).
  Otherwise — and as soon as the app locks, also by itself after the
  auto-lock time — conversations have neutral names, "Conversation 1",
  "Conversation 2"… They never hold message content or the room's key. Leave
  or delete a room and its conversation goes.
- The app has no bubbles (floating conversation windows).

### Calls in the phone's call log, and the History of calls and messages (6.8)
- **History** — the clock-with-an-arrow icon in the room list's bar (or the
  main menu › *History*) shows the calls and the messages of every saved room
  in one list, newest first, by day. At the top: the filter *All / Calls /
  Messages / Missed* and a search (a room, a person or a message's text; case
  and accents do not matter — confirm with the key or the magnifier). A tap
  opens the room (a message: it scrolls to it); the phone button of a call
  calls the room again — **always after a confirmation**, since everyone
  connected in the room hears the call.
- **What History shows** — a sealed, hold-to-read, vanishing or hidden
  message appears only as its kind ("Sealed message"…), never its text, and
  the search does not see into it. Messages come straight from the rooms'
  histories; nothing more is stored. Calls are kept separately: encrypted, on
  this phone only, at most 500 calls of the last 90 days (*Settings › Calls ›
  Keep a call history*; *Clear the call history* deletes it).
- **Kinds of calls** — *outgoing* (you started the call), *incoming* (you
  joined someone else's), *missed* (the room's call ended without you) and
  *declined*. When someone else starts a call, the phone rings with a
  notification with **Join** and **Decline**; it follows the *Calls* switch,
  quiet hours and the privacy level in *Settings › Notifications* (while the
  app is locked only "Call", no room and no name). The room you have open
  does not ring.
- **The phone's call log** — *Settings › Calls › Calls in the system call
  log*: the app asks for the call log permission (without it the switch stays
  off) and then writes the calls into the Phone app too — with their time,
  length and whether they had video. An entry **has no number**, so the Phone
  app cannot dial it; call back from M5cet's History. Any app allowed to read
  the call log can read it, so by default an entry shows **only the app's
  name**; *An entry shows* can add the room, or the room and the people.
  While the app is locked only the app's name is ever written. Some Phone
  apps do not show the name and say "Unknown" (with M5cet's icon). *Remove
  this app's calls from the phone's call log* deletes them again; *Erase all
  data* does too.

## Deutsch

### Erste Schritte
1. App in einem modernen Browser öffnen.
2. Brand-Logo oder "Verbinden" klicken, Raum-Dialog erscheint.
3. Name, Raum-ID und Raum-Schlüssel angeben. Schlüssel out-of-band teilen.
4. Argon2id leitet den Schlüssel lokal ab — Server sieht ihn nie.
5. **Schlüsselstärke (6.7)** — unter dem Schlüsselfeld steht eine Anzeige
   (schwach / mittel / stark, Schätzung in Bit) mit Tipps und dem Knopf
   *Starken Schlüssel erzeugen*. Einen schwachen Schlüssel für einen von Hand
   eingegebenen Raum (keine gespeicherte Verbindung) hält die App beim ersten
   Mal zurück und sagt warum: Wer die Daten des Servers hat, kann einen
   schwachen Schlüssel offline erraten. Trittst du einem Raum bei, der diesen
   Schlüssel schon nutzt, drücke noch einmal *Verbinden*. (Nur im Web; die
   Android-App misst die Schlüsselstärke noch nicht.)

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
  Hintergrund. **Achtung:** jede falsche PIN zählt — auch wenn du die App
  während der Prüfung schließt (seit 6.7 wird der Versuch notiert, bevor die
  PIN geprüft wird). Ein abgelehnter Finger zählt seit 6.7 nicht mehr (den
  Sensor sperrt nach einigen Fehlversuchen das System). Ab dem dritten Fehler
  wird gewartet (30 s, dann länger), nach dem letzten erlaubten Versuch (vom
  Administrator festgelegt) **löscht die App alle ihre Daten** — Räume,
  Nachrichten und Schlüssel. Zum Ändern der PIN braucht es die aktuelle.
- **Mehrere Räume gleichzeitig** — die gewünschten Räume ankreuzen und
  *Ausgewählte verbinden* tippen. Jeder zeigt die Zahl der Personen und
  ungelesenen Nachrichten; über dem Chat eine Leiste der verbundenen Räume,
  Wischen wechselt zum nächsten.
- **Personen-Panel** — frei schwebend oder links, rechts, unten angedockt;
  angedockt anheften oder automatisch ausblenden (ein kleiner Griff bleibt am
  Rand, Tippen fährt es heraus).
- **Nachrichten, Anrufe, Benachrichtigungen** — Ende-zu-Ende-verschlüsselt wie
  im Web; Antworten direkt aus der Benachrichtigung (ab Android 12 erst nach
  dem Entsperren des Telefons); Anrufe auf Wunsch im Anrufprotokoll des
  Telefons. Ist die App gesperrt — seit 6.7 auch im Hintergrund nach Ablauf
  der automatischen Sperre —, zeigt eine Nachrichten-Benachrichtigung nur
  „Neue Nachricht“, ohne Absender, Raum und Antwort; der Sperrbildschirm des
  Telefons zeigt immer nur diese neutrale Fassung.
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

### Sprache: Diktat, als Sprache senden, Stimmverzerrer (6.7)
- **Diktat** — das Sprach-Symbol im Nachrichtenfeld (Web: der Knopf neben dem
  Mikrofon; er erscheint nur, wo der Browser Sprache erkennt, oder im Modus
  Server-enhanced, wenn der Server Transkription anbietet). Der Text erscheint,
  während du sprichst, und das Zuhören geht weiter, bis du es beendest — nach
  einer Pause startet die Erkennung von selbst neu (nach mehreren stillen
  Neustarts hintereinander endet sie mit „Ich habe nichts gehört“). Das Symbol noch
  einmal (ein Quadrat) beendet es: die letzten Worte kommen noch an und das
  Mikrofon wird frei. Den Raum zu verlassen beendet es auch; im Web bricht
  Senden oder Leeren des Felds das Diktat ab (Worte in Arbeit gehen verloren),
  unter Android wartet *Senden* auf die letzten Worte und sendet dann, und die
  App im Hintergrund beendet es ebenfalls.
- **Text als Sprache senden** — der Text im Feld wird von einer Stimme gelesen
  und geht als verschlüsselte Sprachnachricht, genau wie eine aufgenommene
  (ohne den Text). Web (6.8): das Menü *Nachrichtentyp* (der Pfeil bei
  *Senden* oder langes Drücken auf *Senden*) hat ein Kästchen *Als Sprache
  senden*. Solange es angehakt ist, schickt *Senden* (und Enter) statt des
  Texts eine Sprachnachricht; der Knopf *Senden* zeigt dann einen
  Lautsprecher, die Zahl am Pfeil zählt die Option mit und unter dem Feld
  steht *Als Sprachnachricht*. Es bleibt wie die anderen Nachrichtentypen für
  die nächsten Nachrichten an — Haken entfernen oder *Leeren* (nach dem
  Neuladen der Seite ist es aus). Zum Aufdecken halten und verschwindend
  gelten auch für die Sprachnachricht, ebenso die gewählten Empfänger, und
  eine Antwort bleibt eine Antwort. Mit einer *Individuell verschlüsselten*
  Nachricht geht es nicht (die Sprachnachricht wäre nicht mit dem Code
  verschlüsselt): die App sendet nichts — auch nicht den Text ohne Code — und
  sagt warum. Text über 2000 Zeichen wird abgelehnt statt abgeschnitten; eine
  Sprachnachricht, die eine große Datei wäre (die geht an alle im Raum), wird
  für gewählte Empfänger und für Halten- oder verschwindende Nachrichten
  abgelehnt. Befehle (`/…`) und Antworten an Funktionen bleiben Text. Das
  Panel *Sprache* behält seinen einmaligen Knopf *Als Sprache senden*. Nur die
  Stimme des Servers (die Stimmen des Browsers lassen sich nicht aufnehmen) —
  der Server sieht den Text; ohne Sprachausgabe des Betreibers sagt die App
  es. Android: langes Drücken auf *Senden* (oder das
  Mikrofon) öffnet die Sendeoptionen; bei leerem Feld wird gelesen, was du
  jetzt diktierst; die Stimme des Telefons, oder die des Servers, wenn in
  *Einstellungen › Sprache* *Auf dem Server* gewählt ist.
- **Sprechen, als Text senden** (nur Android, in den Sendeoptionen) — du
  sprichst, der Text erscheint im Feld; ■ oder *Senden* schickt ihn als
  normale Nachricht.
- **Stimmverzerrer** — ein Modul, das der Betreiber einschaltet (Konsole ›
  *Modules & groups*; sonst aus). Dann schaltet ihn jeder für sich ein: Web
  *Menü › Werkzeuge › Stimmverzerrer* (der Eintrag erscheint erst, wenn der
  Betreiber ihn eingeschaltet hat), Android *Einstellungen › Sprache ›
  Stimmverzerrer*. Voreinstellungen (höher, tiefer, tief, Roboter, Echo,
  Flüstern, anonym) oder eigene Tonhöhe, Klangfarbe (Formanten), Roboter,
  Echo, Flüstern und Lautstärke; *Testen* nimmt 4 s auf und spielt sie ab. Er
  verändert die Stimme von allem, was die App mit dem Mikrofon aufnimmt —
  Anrufe, Sprachnachrichten und Aufnahmen zur Transkription auf dem Server
  (im Web auch die Telefonbrücke) — auf dem Gerät, vor der Verschlüsselung;
  dafür verlässt kein Ton das Gerät. Das Diktat über die Spracherkennung des
  Browsers oder Telefons hört das Mikrofon selbst und liefert nur Text; dafür
  gilt der Stimmverzerrer nicht. Ohne Kopfhörer kann die Gegenseite im Anruf
  das Echo der eigenen Stimme verändert hören. Die Android-App erfährt
  spätestens nach 10 Minuten, dass das Modul eingeschaltet wurde.

### Wer im Raum ist: Anwesenheit und „zuletzt online“ (6.7)
- Wer den Raum nicht mit **Trennen** verlässt, bleibt in der Personenliste —
  auch wenn das Netz weg ist, der Tab geschlossen oder die App im Hintergrund.
  Fällt die Verbindung weg, steht im Chat „‹Name› ist abwesend — die
  Verbindung ist weg, bleibt aber im Raum.“
- Jede Person hat einen farbigen Punkt und „Zuletzt online vor …“ (wann sie
  die App zuletzt offen hatte und verbunden war):
  - **grün — Online**: die App ist jetzt offen oder war es vor höchstens
    5 Minuten (wer die App in den Hintergrund schickt, bleibt die ersten
    5 Minuten grün);
  - **gelb — Abwesend**: zuletzt online vor 5 bis 60 Minuten;
  - **orange — Länger abwesend**: vor mehr als einer Stunde (oder unbekannt).
- Das Web meldet einen Tab im Hintergrund nach 1,5 s und eine andere App im
  Vordergrund (Tab noch sichtbar) nach 30 s; Android sofort, wenn die App in
  den Hintergrund geht. Die Punkte färben sich von selbst um, auch wenn
  niemand schreibt.
- **Wo** — Web: der Punkt am Avatar im Empfänger-Widget, das Fenster
  *Peers* (Menü) und die Details einer Person (Zeile *Anwesenheit*);
  Android: das Personen-Panel und das Personen-Detail (Zeile *Zuletzt online*;
  wer keine Verbindung hat, trägt ein Mond-Symbol).
- **Wann jemand aus der Liste verschwindet** — mit *Trennen*; wenn der
  Betreiber die Person (oder den ganzen Raum) trennt; wenn der Server ihre
  Anmeldung widerruft (überall abmelden) oder sie wegen seiner Limits
  hinauswirft; und wenn sie nicht binnen 7 Tagen zurückkommt (der Betreiber
  ändert das mit `PRESENCE_MAX_AWAY_DAYS`). Ein Neustart des Servers vergisst
  Personen ohne Verbindung — außer angemeldeten, deren Nachrichten der Server
  hält.
- **Zurückkommen** — nach dem Neuladen der Seite (im selben Tab) oder dem
  erneuten Öffnen der Android-App bist du wieder dieselbe Person, kein neues
  Mitglied. Ein geschlossener Tab im Web merkt sich das nicht: ein Gast kommt
  als neues Mitglied zurück (der alte Eintrag bleibt, bis er abläuft); eine
  angemeldete Person ersetzt ihren alten Eintrag.
- Wer angemeldet ist und Nachrichten vom Server halten lässt (abwesend),
  bleibt auch nach *Trennen* als abwesend im Raum — wie bisher.
- Anwesenheit und „zuletzt online“ sehen nur Personen im selben Raum (und der
  Betreiber in der Konsole); Nachrichteninhalte sieht der Server weiterhin
  nicht.

### Standort: navigieren, Fahrt, kopieren (6.7)
- **Web**: eine Nachricht mit Standort zeigt in der Blase statt einer Karte
  **eine Nadel mit den Koordinaten** („live“ bei einem Live-Standort); eine
  Nachricht, die den Standort im Kopf trägt, hat dort ein Nadel-Symbol. Ein
  Tippen öffnet das Standort-Fenster: die Karte (wenn der Betreiber sie
  eingeschaltet hat; Tippen öffnet OpenStreetMap), die Koordinaten mit
  Genauigkeit und die Knöpfe **Navigieren**, **Fahrt** und **Kopieren**.
  - *Navigieren*: Google Maps, Apple Maps, Waze, Mapy.com oder OpenStreetMap
    (in einem Browser unter Android auch die Karten-App des Telefons).
  - *Fahrt*: Uber mit eingetragenem Ziel; Bolt, Liftago und FREENOW können
    kein Ziel übernehmen — ihre Seite öffnet sich und die Koordinaten werden
    kopiert („Das Ziel ist in der Zwischenablage — fügen Sie es in der App
    ein.“).
  - *Kopieren*: die Koordinaten als `50.087500, 14.421300`.
- **Android**: eine Standort-Nachricht zeigt weiterhin eine kleine Karte (wenn
  sie eingeschaltet ist); Tippen darauf oder *Standort auf der Karte* im Menü
  des langen Drückens öffnet dasselbe Fenster. *Navigieren* bietet zuerst die
  installierten Apps (Google Maps, Waze, Mapy.com, OsmAnd, Sygic, HERE WeGo
  und andere Karten-Apps), dann die Web-Links der nicht installierten.
  *Fahrt*: Uber (die App, sonst das Web); bei Bolt, Liftago und FREENOW werden
  die Koordinaten kopiert und die App öffnet sich, sonst ihre Seite.
- **Datenschutz**: nichts wird gesendet, bis du auf einen Link tippst; die
  Karte kommt über den M5cet-Server. Wer auf eine Navigations- oder Fahr-App
  tippt, gibt dieser die Koordinaten (Uber auch den Namen des Absenders, wenn
  der Standort nicht deiner ist).

### Nachrichten „zum Lesen halten“ (6.7)
Eine Nachricht, die nur beim Halten sichtbar ist, lässt sich jetzt auch über
den **leeren Platz neben ihrer Blase** halten — so liegt der Text nicht unter
dem Finger. Sie öffnet sich nach kurzem Halten (etwa 0,2 s), ein Scrollen, das
dort beginnt, zeigt also nichts. Im Web und in der Android-App.

### Benachrichtigungen (6.7)
- **Wo**: Web *Menü › Benachrichtigungen* (Teil *Meine Benachrichtigungen*),
  Android *Einstellungen › Benachrichtigungen*.
- **Was du wählst**: Benachrichtigungen an / aus; worüber (neue Nachrichten,
  Erwähnungen, Rückrufe des Betreibers; *Anrufe* und *Befehlsergebnisse*
  stehen zur Wahl, der Server sendet sie aber noch nicht von selbst); **was
  eine Benachrichtigung zeigt** — *nichts, nur dass etwas kam* / *wer
  schreibt* / *wer schreibt und in welchem Raum* / *auch eine Vorschau* (eine
  Vorschau kann nur ein Gerät zeigen, das die Nachricht selbst entschlüsselt;
  der Server kann die Stufe begrenzen); **Ruhezeiten** (von–bis, auch über
  Mitternacht; dann kommt nichts außer einem Test) und
  *Testbenachrichtigung senden*.
- **Wie** (nur angemeldet): die Reihenfolge der Wege — die Android-App, der
  Browser (Web-Push), E-Mail. Scheitert der erste Weg, versucht der Server den
  nächsten. E-Mail geht nur, wenn der Betreiber sie eingeschaltet hat und du
  die Adresse über den Link in der Bestätigungs-Mail bestätigt hast (48 h
  gültig); die Adresse wird im Web eingetragen.
- **Android**: der Schalter *Der Server hält meine Nachrichten und weckt
  mich* — Nachrichten warten verschlüsselt auf dem Server, die
  Benachrichtigung kommt nur für dieses Telefon versiegelt; den Raumnamen
  setzt die App selbst ein. Ist die App gesperrt, ist die Benachrichtigung
  neutral — nur „Neue Nachricht“, ohne Absender, Raum und Antwort; der
  Sperrbildschirm des Telefons zeigt immer nur „Neue Nachricht“.
- **Ohne Anmeldung** gilt die Wahl nur für die Benachrichtigungen, die die
  offene Seite zeigt.
- **Erwähnung**: schreibst du `@Name` einer abwesenden Person, bekommt sie
  eine „Erwähnung“ (der Server erfährt nur, wen, nicht den Text).

### Öffentliches Profil (6.7)
- **Wo**: Web *Profil* (Teil *Öffentliches Profil*), Android *Einstellungen ›
  Benutzer › Öffentliches Profil*. Es braucht eine Anmeldung mit Passkey.
- **Was es enthält**: Profilfoto, Hintergrundfoto, öffentlicher Spitzname,
  „Über mich“ und bis zu 24 weitere Angaben (Name, Telefon, E-Mail, Adresse,
  Web, soziales Netz, Organisation, Geburtstag, Sonstiges).
- **Für jede Angabe wählst du, wer sie sieht**:
  - *Nur ich* — bleibt versiegelt im Tresor deines Kontos;
  - *Raummitglieder* (Android: *Räume*) — geht Ende-zu-Ende-verschlüsselt
    (mit dem Paarschlüssel) an die Personen in den Räumen, denen du beitrittst;
    der Server kann es nicht lesen;
  - *Öffentlich* — liegt auf dem Server und ist für jeden lesbar, der deinen
    Benutzernamen kennt; der Server sieht es.

  Neue Angaben sind *Nur ich*, der Spitzname ist standardmäßig *Öffentlich*.
  *Wie andere mich sehen* zeigt die Vorschau je Publikum.
- **Bilder** werden vor dem Speichern verkleinert und als JPEG neu kodiert,
  ihre Metadaten (EXIF, GPS-Position, Kamera) werden verworfen.
- **Der Spitzname** füllt deinen Namen vor, wenn du einem Raum beitrittst
  (unter Android hat der Name einer gespeicherten Verbindung Vorrang); dort
  kannst du ihn ändern.
- **Profile anderer**: die Details einer Person zeigen, was sie im Raum
  teilt; *Öffentliches Profil von @Name anzeigen* holt es erst auf Wunsch vom
  Server. Gehört das öffentliche Profil zu dem Konto, das die Nachrichten
  dieser Person signiert, sagt die App es.
- Der Betreiber kann das öffentliche Profil eines Kontos entfernen (Konsole);
  es lässt sich danach wieder veröffentlichen.

### Android-App: Aussehen und Gesten in der Raumliste (6.7)
- **Sechs neue Vorlagen** — Wald, Sonnenuntergang, Lavendel, Mokka, Arktis
  und Tinte, jede hell und dunkel (*Einstellungen › Aussehen*).
- **Menüs mit Symbolen** in den Farben des Aussehens (Hauptmenü, Raummenü,
  langes Drücken auf eine Nachricht…); gefährliche Einträge (löschen, Wipe)
  sind rot.
- **Wischen über eine Raumzeile**: nach rechts → **Löschen** (nach einer
  Bestätigung verlässt die App den Raum, nimmt ihn aus der Liste und löscht
  seinen Verlauf auf diesem Telefon; andere betrifft das nicht); nach links →
  **Klonen** (speichert eine Kopie unter dem nächsten freien Namen, z. B.
  „Team 2“, mit demselben Schlüssel und Spitznamen; verbindet sie nicht) und
  **Bearbeiten** (Name, Raum und Schlüssel; ein neuer Raumname bedeutet einen
  neuen Raum — der alte Verlauf bleibt auf dem Telefon; ein verbundener Raum
  verbindet sich neu). TalkBack bietet dieselben Aktionen.

### Android-App: Räume als Unterhaltungen (6.8)
- **Was das ist**: verbundene Räume verhalten sich auf dem Telefon wie
  Unterhaltungen (wie bei Signal oder WhatsApp) — im Bereich
  *Unterhaltungen* der Benachrichtigungen, in der oberen Reihe des
  *Teilen*-Menüs und beim Halten des App-Symbols.
- **In einen Raum teilen**: Text aus einer anderen App teilen und oben einen
  Raum wählen — die App öffnet ihn mit dem Text im Nachrichtenfeld; **er wird
  nicht von selbst gesendet**. Bilder lassen sich so nicht teilen.
- **Priorisierte Unterhaltungen und das Widget**: eine Benachrichtigung des
  Raums halten, um ihn zu priorisieren; das Widget *Unterhaltung* legt ihn
  auf den Startbildschirm. Raummenü › *Unterhaltung im Telefon* öffnet die
  Einstellungen dieser Unterhaltung (Android 11+).
- **Einstellungen › Benachrichtigungen › Android-Unterhaltungen**: *Räume als
  Android-Unterhaltungen* (Ausschalten entfernt alle) und *Raumnamen
  anzeigen*.
- **Privatsphäre**: das System sieht einen Raumnamen nur, solange die App
  entsperrt ist und Benachrichtigungen den Raum nennen dürfen (*Privatsphäre*
  auf demselben Bildschirm). Sonst — und sobald die App sperrt, auch von
  selbst nach der Zeit der automatischen Sperre — heißen Unterhaltungen
  neutral „Unterhaltung 1“, „Unterhaltung 2“… Nachrichteninhalte oder der
  Schlüssel des Raums sind nie darin. Wer einen Raum verlässt oder löscht,
  entfernt auch seine Unterhaltung.
- Blasen (schwebende Unterhaltungsfenster) hat die App nicht.

### Anrufe in der Anrufliste des Telefons und der Verlauf von Anrufen und Nachrichten (6.8)
- **Verlauf** — das Symbol Uhr mit Pfeil in der Leiste der Raumliste (oder
  Hauptmenü › *Verlauf*) zeigt Anrufe und Nachrichten aller gespeicherten
  Räume in einer Liste, die neuesten oben, nach Tagen. Oben: der Filter
  *Alle / Anrufe / Nachrichten / Verpasst* und eine Suche (Raum, Person oder
  Text einer Nachricht; Groß- und Kleinschreibung und Akzente spielen keine
  Rolle — mit der Taste oder der Lupe bestätigen). Tippen öffnet den Raum
  (bei einer Nachricht scrollt er zu ihr); die Telefon-Taste eines Anrufs ruft
  im Raum erneut an — **immer erst nach einer Bestätigung**, denn alle, die im
  Raum verbunden sind, hören den Anruf.
- **Was der Verlauf zeigt** — eine versiegelte, „zum Lesen halten“-,
  verschwindende oder ausgeblendete Nachricht erscheint nur als ihre Art
  („Versiegelte Nachricht“…), nie mit ihrem Text, und die Suche sieht nicht
  hinein. Nachrichten kommen direkt aus dem Verlauf der Räume; nichts wird
  zusätzlich gespeichert. Anrufe merkt sich die App getrennt: verschlüsselt,
  nur auf diesem Telefon, höchstens 500 Anrufe der letzten 90 Tage
  (*Einstellungen › Anrufe › Anrufverlauf speichern*; *Anrufverlauf löschen*
  löscht ihn).
- **Arten von Anrufen** — *ausgehend* (Sie haben den Anruf begonnen),
  *eingehend* (Sie sind dem Anruf eines anderen beigetreten), *verpasst* (der
  Anruf im Raum endete ohne Sie) und *abgelehnt*. Beginnt jemand anderes einen
  Anruf, klingelt das Telefon mit einer Benachrichtigung mit **Beitreten** und
  **Ablehnen**; sie folgt dem Schalter *Anrufe*, den Ruhezeiten und der
  Datenschutzstufe in *Einstellungen › Benachrichtigungen* (bei gesperrter App
  nur „Anruf“, ohne Raum und Namen). Der Raum, den Sie offen haben, klingelt
  nicht.
- **Die Anrufliste des Telefons** — *Einstellungen › Anrufe › Anrufe im
  Systemanrufprotokoll*: die App fragt nach der Berechtigung für die
  Anrufliste (ohne sie bleibt der Schalter aus) und schreibt die Anrufe dann
  auch in die Telefon-App — mit Zeit, Dauer und ob mit Video. Ein Eintrag
  **hat keine Nummer**, die Telefon-App kann ihn also nicht wählen;
  zurückrufen geht aus dem Verlauf in M5cet. Jede App mit Zugriff auf die
  Anrufliste kann sie lesen, deshalb zeigt ein Eintrag standardmäßig **nur den
  Namen der App**; unter *Ein Eintrag zeigt* lässt sich auch der Raum oder
  Raum und Personen wählen. Solange die App gesperrt ist, wird immer nur der
  Name der App geschrieben. Manche Telefon-Apps zeigen den Namen nicht und
  schreiben „Unbekannt“ (mit dem Symbol von M5cet). *Anrufe dieser App aus der
  Anrufliste entfernen* löscht sie wieder; *Alle Daten löschen* ebenfalls.
