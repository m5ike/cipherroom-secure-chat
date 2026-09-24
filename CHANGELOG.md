# Changelog

Všechny významné změny tohoto projektu jsou dokumentovány v tomto souboru.

Formát vychází z [Keep a Changelog](https://keepachangelog.com/cs/1.1.0/) a
projekt používá [Semantic Versioning](https://semver.org/lang/cs/).

## [4.15.0] – 2026-09-24

Programovatelné moduly — druhá etapa frameworku funkcí
(`docs/functions-architecture.md`, kap. 16, etapa 2). Operátor napíše model
v JavaScriptu nebo Pythonu, publikuje ho a v chatu ho kdokoli spustí přes
`/klíčové-slovo` (jako roboti v messengerech). Protokol, šifrování ani data
účtů se nemění; server nikdy nečte místnost — dostane jen to, co klient
u příkazu pošle, a výstup do místnosti šifruje klient.

### Přidáno
- **Sandbox a runner** (`server/functions/`): každý běh dostane vlastní
  **oddělený proces** (`dist/sandbox.cjs`) s interpretem ve WebAssembly —
  **QuickJS** pro JavaScript (ES2023, moduly, `async/await`, přerušení podle
  času, limit paměti), **Pyodide** pro Python (CPython 3.14, standardní
  knihovna). Smyčka, přetečení paměti ani pád tak neohrozí hlavní službu:
  runner hlídá čas i paměť a proces v případě potřeby ukončí. Interpret ve
  WASM nevidí hostitele; skripty píše důvěryhodný operátor, takže hranicí je
  proces a interpret, ne obrana proti autorovi.
- **SDK `m5`** stejné v obou jazycích (v Pythonu `snake_case`): `sys`, `run`,
  `caller` (`send`, `flash`), `log` (živě v konzoli), `out`
  (text, markdown, code, table, json, image, file, flash), `session` a
  `cache` s TTL, a čisté pomocníky `codec` (base64/32/58, hex, url, html,
  csv, komprese), `id` (uuid, uuid7, ulid, nanoid, slug) a `crypto` (hash,
  hmac, hkdf, pbkdf2, scrypt, AES-GCM, náhoda) — počítané uvnitř procesu,
  jednou pro oba jazyky.
- **Balíčky, verze a modely** (SQLite `$DATA_DIR/functions/functions.db`):
  koncept (upravitelný) → publikovaná verze (neměnná, otisk obsahu),
  importy mezi soubory i balíčky s pevnou verzí; model = vstupní bod +
  schéma vstupů (typy, validace, koerce) + limity + executory + skupiny +
  klíčové slovo; revize modelu jako historie.
- **Konzole — IDE** (`admin-ui`, sekce *Functions*): editor souborů balíčku
  s panelem SDK, uložení konceptu, publikace verze, zkušební běh s výstupy
  a živými logy; správa modelů (klíčové slovo, vstupní bod přes výběr
  balíček\@verze:soubor, schéma vstupů, viditelnost v místnosti / jen
  volajícímu, skupiny, zapnutí) se zkušebním během; seznam běhů.
- **Chat**: klient rozpozná `/klíč args`, přeloží argumenty na vstupy
  (`klíč=hodnota` i poziční), spustí model na serveru a výstup buď pošle do
  místnosti jako běžnou šifrovanou zprávu (podepsanou modelem), nebo ukáže
  jen volajícímu. Nové API `GET /api/functions/commands` a
  `POST /api/functions/run`; přepínač modulu `functions` (`ENABLE_FUNCTIONS`).
- **Sestavení**: `npm run build` staví i `dist/sandbox.cjs` a kopíruje běhové
  balíčky do `dist/node_modules` (ovladač SQLCipher, Pyodide, QuickJS WASM),
  takže je má i instalace bez `node_modules` a obraz Dockeru s jen `dist`.

### Opraveno
- Ovladač SQLCipher se teď dostane do `dist/node_modules`, takže úložiště
  a žurnál AI přežijí i výchozí instalaci a obraz Dockeru (dřív běžely jen
  v paměti, když se `node_modules` po sestavení mazal).

## [4.14.0] – 2026-09-24

AI a řeč od základu — první etapa frameworku funkcí
(`docs/functions-architecture.md`). Protokol, šifrování ani data účtů se
nemění.

### Přidáno
- **Vrstva AI a řeči** (`server/ai/`): adaptéry **Anthropic** (Messages API,
  stream, adaptivní uvažování s `effort` u Claude 5, rozpočet uvažování u
  starších modelů, seznam modelů s jejich schopnostmi), **OpenAI-kompatibilní**
  (OpenAI, Open WebUI, Perplexity se zdroji, llama.cpp, GPT4All, Hugging Face,
  jiné servery; syntéza a přepis řeči), **Ollama** (NDJSON, `think`),
  **ElevenLabs** (hlasy účtu). Odmítnutý parametr se vynechá a zkusí znovu;
  časový limit do první odpovědi a na ticho během streamu; zrušení s klientem.
- **Poskytovatelé** v konzoli: klíče zašifrované master klíčem úložiště a
  svázané s poskytovatelem (`$DATA_DIR/ai/config.json`), nikdy zpět do
  konzole; adresa; **skupiny**, které je smí používat; test; **modely** od
  poskytovatele nebo jménem (zapnutí, jméno, uvažování, obrázky, ceny).
  Klíče z proměnných prostředí (jako dřív) se ukážou jako poskytovatelé
  „z prostředí“.
- **Limity**: tokeny a USD za měsíc pro server (výchozí **0 tokenů = asistent
  vypnutý**, dokud je vlastník nenastaví), volání a tokeny na uživatele a den,
  nejdelší odpověď a konverzace; konzole se počítá, ale neblokuje.
- **Žurnál volání** (`$DATA_DIR/ai/journal.db`, SQLite; bez ovladače v
  paměti): odkud, kdo, model, výsledek, doba, doba do prvního kousku, tokeny,
  cena; obsah jen při dočasném *content logging* vlastníka (pak se smaže);
  retence 30 dní; filtry, živý proud, detail, CSV, souhrny.
- **Konzole › AI & speech** (`admin-ui/public/ai-console.js`): přepínače a
  souhrn měsíce, poskytovatelé a modely, **zkušebna** (stream, uvažování,
  zdroje, tokeny, cena, požadavek jak odešel), test řeči (syntéza, přepis
  nahrávky nebo souboru), volání, výchozí modely a pokyny asistenta, limity,
  žurnál. API `/admin/ai*` (klíče, adresy, ceny, limity a obsah: vlastník).
- **Asistent v aplikaci** (`AiPanel`, rozvržení `panel.ai`): modely podle
  skupin účtu, úroveň uvažování, odpověď psaná průběžně jako **Markdown**
  (`lib/markdown.ts`, `components/Markdown.tsx` — bez HTML, odkazy jen
  https / mailto), uvažování, zdroje, zastavení, vložení do zprávy, kopírování;
  stav, když použít nejde (vypnuto, žádný model, jen pro přihlášené, bez
  limitu); odmítnutí v jazyce uživatele. API `POST /api/ai/chat` (SSE).

### Změněno
- `/api/ai/status` a `/api/speech/status` podle přihlášeného účtu a skupin;
  `/api/ai/complete` a `/admin/plugins`, `/admin/plugins/switches` zůstávají.
- Manifest `/api/modules` hlásí AI a řeč podle přepínače z konzole a
  nastavených modelů (dřív jen podle `ENABLE_AI=1` v prostředí).
- Admin služba předává roli administrátora (`res.locals.adminRole`).
- Konektory `server/plugins/{registry,routes,connectors}` nahradily adaptéry
  v `server/ai/`.

### Kompatibilita
- Po aktualizaci je asistent vypnutý, dokud vlastník nenastaví měsíční limit.
- Hosté asistenta používají jen se skupinou *Guests* u poskytovatele.

## [4.13.0] – 2026-09-24

Layout builder pro celou aplikaci. Protokol, šifrování ani data účtů se
nemění; klienti 4.0 a 4.13 se v místnosti potkají.

### Přidáno
- **Okno Místnost, okna, dialogy a panely jako rozvržení** (36 nových,
  celkem 44; `client/src/lib/layouts/{windows,room,dialogs,account,settings,tools,share,phone,connections}.ts`):
  okno panelu a velké okno nastavení, záložky a obsah okna Místnost,
  „nejdřív se přihlaste“, odznak přihlášeného, informace o účastníkovi,
  o zprávě, kontrola verzí, účet, passkey, historie chatu, profil,
  nastavení, soukromí, šifrování, oznámení, analytika, zabezpečení
  místnosti, důvěra, lidé, hlasový a video hovor, soubory, poloha, řeč,
  podrobnosti spojení, telefonie, sdílení a pozvánky, Moje připojení
  (seznam, úprava, statistiky a log, nastavení). Komponenty drží stav a
  logiku, rozvržení dostane data a akce (kontrakty). Aplikace kreslí
  rozvržení operátora pro přihlášeného diváka (`LayoutProvider`).
- Builder: **sekce** záložek (App, Room window, Windows, Dialogs & parts,
  Panels); **náhled** oken a panelů jejich skutečnými komponentami s
  ukázkovými daty (`layout-preview-parts.tsx`, `layout-samples.tsx`), stavy
  po klepnutí si náhled „doklikne“ sám; bez volání serveru.
- **Varianty** rozvržení pro skupiny uživatelů a šablony vzhledu (první
  vyhovující; nejvýš 8 na rozvržení, 40 celkem); v náhledu „jako kdo“.
- **Historie** uložených verzí (`layout-history.json`, posledních 50,
  ~12 MB) s rozdíly (proti předchozí nebo dnešní) a **návratem**;
  `GET /admin/layout/history[/:id[/diff]]`, `POST …/:id/restore`.
- **Archiv vydaných výchozích stromů** (`server/layout-archive.json`,
  `script/archive-layouts.ts`) a **třícestné sloučení** vlastního rozvržení
  s novým výchozím po aktualizaci (`layout-merge.ts`): bez konfliktu samo
  při načtení, jinak nabídka v builderu se seznamem konfliktů;
  `POST /admin/layout/merge`.
- **Vložení HTML** jako prvků palety (`html-to-tree.ts`,
  `POST /admin/layout/from-html`): nebezpečné a neznámé se vynechá a vypíše.
- **Kontrola přístupnosti** (`layout-a11y.ts`): návrh (alt, názvy
  ovládacích prvků, popisky polí, klávesnice, tabindex, nadpisy, duplicitní
  id, odkazy) i vykreslený náhled (přístupný název, kontrast WCAG proti
  skutečnému pozadí); souhrn pod náhledem a čipy ve stromu.
- Prvky **tabulka** (sekce, řádek, buňka) a **video**; ikona s velikostí;
  další události (mousedown/up, drag…, wheel, scroll, touch, load, error).
- Šablonovací jazyk: **filtry nad výrazem v závorce**
  (`{=('acc.signedInAs'|t|replace:'{name}':$userName)}`); číslice za tečkou
  jsou krok cesty (`$x.0.1`).

### Změněno
- Šablony a výrazy se **překládají na funkce** a strom rozvržení také
  (`LayoutView`): rychlejší vykreslení, neměnné části se nevytvářejí znovu.
- Výchozí stromy se staví až při prvním použití (úvodní obrazovka 8 ze 44).
- Katalog ikon 239; `script/gen-menu-icons.mjs` čte ikony ze stromů
  rozvržení a z map ikon komponent.
- Kontrola `target="_blank"` bere `rel="noreferrer"` jako `noopener`
  (podle HTML).

### Přístupnost
- Přístupný název dostalo šest polí: klíč místnosti v úpravě připojení,
  text SMS, odkaz pozvánky, výběr serverového hlasu, název passkey a
  obnovovací kód; ve zprávách pole kódu zapečetěné zprávy.

### Ověření
- DOM i volané akce starých a nových komponent porovnány krok za krokem
  (všechny převedené komponenty, cs / en, část de; jediný rozdíl jsou nové
  přístupné názvy). `test/layout-parts.test.tsx` kreslí každé rozvržení
  oken, dialogů a panelů v každé situaci náhledu a jazyce: bez chyby
  rozvržení, bez sítě, s přístupnými názvy.

## [4.0.6] – 2026-09-24

Oprava modulů AI a řeči. Protokol, šifrování ani data účtů se nemění.

### Opraveno (`server/plugins/*`)
- **Anthropic** vracel `400: temperature is deprecated for this model` —
  konektor posílal vždy `temperature: 0.7`, což modely vydané po Claude
  Opus 4.6 (např. `claude-sonnet-5`) odmítají. Parametry vzorkování
  (`temperature`) se posílají jen na vyžádání; parametr, který model
  odmítne, se zkusí jednou znovu bez něj. Z odpovědi se berou jen textové
  bloky (ne thinking), výchozí `max_tokens` 1024. `ANTHROPIC_BASE_URL`
  volitelně.
- **HuggingFace** (text i přepis řeči) hlásil `fetch failed`: volal
  `api-inference.huggingface.co`, který zanikl (doména se už nepřekládá).
  Text jde přes Inference Providers — OpenAI kompatibilní
  `https://router.huggingface.co/v1/chat/completions` (model může nést
  poskytovatele nebo politiku: `…:novita`, `…:cheapest`, `…:fastest`),
  přepis přes `https://router.huggingface.co/hf-inference/models/<model>`.
  `HF_BASE_URL` volitelně.
- **OpenAI**: u api.openai.com `max_completion_tokens` (novější modely
  `max_tokens` odmítají), u kompatibilních serverů dál `max_tokens`;
  `temperature` jen na vyžádání. Ollama: `options.temperature` a
  `num_predict`.
- Chyby: místo holého `fetch failed` důvod (DNS, odmítnuté spojení, časový
  limit, TLS certifikát) a hostitel; u poskytovatele jeho vlastní zpráva.
  Každé volání má limit 60 s.

### Přidáno
- Konzole › AI & speech: **přepínače modulů AI a Speech**
  (`PUT /admin/plugins/switches`, operátor). Uloženo v
  `$DATA_DIR/plugins.json` (`PLUGINS_SETTINGS_FILE`), čte ho aplikace i
  admin služba; `ENABLE_AI` / `ENABLE_SPEECH` (1/0) mají přednost a konzole
  to ukáže. Panel se načte po otevření; test konektoru vrací dobu odezvy.

## [4.0.5] – 2026-09-24

Layout builder jako GUI designer. Protokol, šifrování ani data účtů se
nemění. Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html#layout-builder),
[`docs/layout-builder.md`](docs/layout-builder.md).

### Rozvržení jako data (`client/src/lib/layout-tree.ts`, `client/src/lib/layouts/*`, `client/src/components/LayoutView.tsx`)
- Lišta nahoře, okno chatu, příchozí / odchozí / systémová zpráva, pole pro
  psaní a widget příjemců (panel i minimalizované tlačítko) jsou **stromy
  prvků**, které kreslí `LayoutView`. Výchozí stromy vykreslují **stejný DOM**
  jako dřívější JSX — ověřeno porovnáním starých a nových komponent ve 248
  situacích, hlídáno 31 snímky (`test/layout-snapshots.test.tsx`).
- Prvek má tag, text (šablona), atributy (šablona nebo výraz po `=`), CSS,
  styl se stavy (hover / click / focus / current), CSS z dat, podmínku,
  opakování se svým rozsahem (`$p`, `$iterator`), události → akce s
  argumentem, ref, živou část aplikace (slot) nebo šablonu (block).
- Každé rozvržení má **kontrakt** (hodnoty, akce, živé části, refy);
  komponenty si nechávají stav a chování (tažení widgetu, časovače zpráv,
  zapečetění), rozvržení jen kreslí.
- Šablonovací jazyk: podmínka `a ? b : c`, filtr `t` (`{$state|t:'msginfo.state.'}`),
  vykreslení jako prostý text, rychlá cesta pro `{$x}` / `$x` / `!$x`.

### Konzole › Layout builder (`admin-ui/public/layout-builder.js`)
- Záložky rozvržení (+ šablony, + *Texts & behaviour*), **paleta** 28 prvků
  (panel, area, row, column, grid, list, group, text, heading, paragraph,
  label, link, icon, image, audio, logo, avatar, HTML, separator, button,
  input, text area, select, option, form, živé části, šablony), **strom**
  s přetahováním (i z palety), nástroji pro vybraný prvek (skrýt, posunout,
  duplikovat, zabalit, rozbalit, uložit jako šablonu, smazat), zpět / znovu,
  kopírovat / vložit mezi rozvrženími, export / import.
- **Vlastnosti s našeptáváním**: tag, třídy, které styly aplikace opravdu
  mají (čtou se z buildu), atributy podle tagu a jejich hodnoty (typy inputu,
  role, target, autocomplete…), 114 vlastností CSS s hodnotami, proměnné,
  akce, živé části, refy. Plovoucí nápověda (hodnoty, akce, filtry, makra,
  výrazy, prvky).
- **Náhled je aplikace sama**: `layout-preview.html` (druhý vstup buildu) se
  skutečnými komponentami, CSS a šablonami vzhledu a ukázkovými daty;
  varianty, šablona, tón, jazyk, šířka; klepnutí vybere prvek, režim
  *click tries it* náhled ovládá; chyby výrazů u prvků.
- **Šablony prvků**: uložit vybraný prvek, vložit propojeně (s `$arg`) nebo
  jako kopii, upravit ve vlastní záložce.
- Uloží se jen rozvržení odlišná od výchozích (`layouts.<id> = { tree, rev }`)
  a šablony (`blocks`); builder upozorní, když aktualizace aplikace změnila
  výchozí stav, ze kterého návrh vznikl.
- Dřívější barvy komponent, krátké texty, includes a chování zpráv jsou na
  záložce *Texts & behaviour*; starý panel z `legacy-tools.js` je pryč.

### Server
- `GET /admin/layout` vrací i katalog (paleta, atributy, CSS, třídy z
  `dist/public/assets/*.css`, ikony, rozvržení s výchozími stromy, kontrakty
  a variantami); `PUT /admin/layout` přijme tělo do 4 MB.
- Admin služba podává náhled `/layout-preview.html` (`frame-ancestors 'self'`)
  a `/assets/*` z buildu aplikace.
- Validace `layout-tree.ts` (server i klient): známé prvky a tagy, žádné
  `on*`, `style`, `srcdoc`, `formaction`, bezpečné adresy (i při vykreslení),
  CSS bez `url()` a výrazů, limity (2 500 prvků, hloubka 40, 60 šablon).

### Sdílené (`admin-ui/public/builder-kit.js`)
- Menu builder a Layout builder sdílejí pole formulářů, výběr barev a ikon,
  editor stylů se stavy, plovoucí nápovědu a našeptávač.
- Katalog ikon 207 (+ ikony zpráv, lišty, psaní a widgetu); přejmenované
  ikony lucide (`smile` → `face-slightly-smiling`) se najdou i pod starým jménem.

### Opraveno
- Levý sloupec Menu builderu na středně širokých obrazovkách překrýval náhled
  pod sebou.

### Testy
- `layout-tree` (validace, adresy, CSS, limity, výchozí stromy projdou
  validací beze změny a používají jen svůj kontrakt), `layout-view`
  (šablony jako text, podmínky, opakování, typované atributy, události,
  refy, sloty, šablony, bezpečné HTML, styly, ikony, režim náhledu),
  snímky výchozích rozvržení, `layout-config` (rozvržení a šablony). E2E:
  paleta, výběr v náhledu, našeptávání tříd / CSS / textu / akcí, přetažení,
  šablona v jiném rozvržení, uložení — a aplikace kreslí uložené rozvržení
  (nové tlačítko v ní opravdu otevře emoji); auditor jen čte.

## [4.0.0] – 2026-09-24

Identita a přihlášení, moduly pro skupiny a menu jako data. **Nekompatibilní
změna:** Server-enhanced vyžaduje přihlášení passkey a registrace/přihlášení
mají nový krok (důkaz globálního klíče). Signalizační protokol a šifrování
místností se nemění. Dokumentace (HTML + PDF):
[`docs/site/`](docs/site/index.html#prihlaseni).

### Identita (`server/accounts/username.ts`, `store.ts`, `routes.ts`, `client/src/lib/account.ts`)
- **Uživatelské jméno** účtu: jedinečné, vygenerované serverem při registraci
  (`slovo-slovo-xxxx`, konec z abecedy bez záměn), uložené v passkey
  (`user.name`, `displayName`, `user.id` = UTF-8 jméno). U nových účtů je to
  **ID účtu** — primární klíč relací, trezoru, databáze, fronty i auditu.
  Jméno v místnosti je jen přezdívka; hello nese i uživatelské jméno a detail
  uživatele ho ukazuje.
- **Light · P2P** bez účtu: jméno relace z přezdívky (`tomas-k-7k3q`).
- **Globální klíč**: kořen z PRF (pro tentýž passkey vždy stejný) → nový
  **důkaz klíče** `HKDF(kořen, "m5cet:key-proof:v1")`; server drží jen
  `SHA-256` (`keyVerifier`). `register/verify` bez důkazu → `400 no-key`.
- **Přihlášení krok za krokem**: passkey (neznámý → `404 unknown-passkey` s
  doporučením registrace), globální klíč (`signin/verify` vydá **zamčený**
  token, `POST /api/account/unlock` ho odemkne; jiný klíč → token zrušen,
  `403 wrong-key`), databáze, trezor, server a verze, nastavení, push,
  automatické připojení. Okno Spojení ukazuje průběh; selhání databáze nebo
  klíče uživatele odhlásí.
- **Audit** všeho v kategorii `account`: `register`, `register.failed`,
  `signin.unknown-passkey`, `signin.rejected`, `signin.passkey-ok`,
  `signin.wrong-key`, `signin.unlocked`, `recovered` a hlášení klienta
  `client.signin-complete|signin-failed|database-locked|version-mismatch…`.
- **`/signin` a `/signup`**: otevřou okno Spojení a spustí přihlášení, resp.
  registraci — po registraci je uživatel rovnou přihlášený a aktivovaný.
- Účty z doby před 4.0 si ponechávají své ID jako uživatelské jméno (bez
  přejmenování); hash důkazu klíče se uloží při jejich prvním přihlášení.

### Server-enhanced jen s passkey
- Vytvořit passkey a přihlásit se jde **jen v okně Spojení**. Jinde (okno
  Místnost › Server-enhanced, Moje připojení, profil, test upozornění, …) jsou
  volby neaktivní a karta *Vyžaduje přihlášení passkey* vede do okna Spojení.
- Nepřihlášená aplikace nezakládá anonymní relaci úložiště ani se nepřipojí
  na server ručně; uchování chatu `server` se přepne na `session`.

### Ochrana navigace (`client/src/lib/nav-guard.ts`)
- Během spojení: zpět, obnovení (F5, Ctrl/Cmd+R) a klávesové zkratky historie
  otevřou okno *„Prosím nejprve se odpojte z místnosti.“* (Odpojit / Zůstat);
  zavření karty a nová adresa → dialog prohlížeče (`beforeunload`).

### Kontrola verzí (`client/src/lib/integrity.ts`, `IntegrityCheck.tsx`, `vite.config.ts`)
- Sestavení zapíše `/version-manifest.json` (verze, build, protokol, build
  service workeru, knihovny, soubory se SHA-256); `sw.js` zná svůj build.
- Aplikace porovná, co opravdu běží (verze, build, protokol, knihovny,
  načtené soubory, service worker): po startu, při návratu do okna, každých
  10 minut, při oznámení nové verze a při přihlášení. Nesoulad → okno se
  seznamem a **Opravit**: smaže Cache Storage, service worker, uložené
  konfigurace, relace a IndexedDB (identita zařízení zůstane; volitelně i
  vzhled a jazyk), `POST /api/clear-site-data` (`Clear-Site-Data: "cache"`) a
  načte vše znovu ze serveru. Nahrazuje dosavadní pruh „nová verze“.

### Moduly a skupiny (`client/src/lib/modules.ts`, `server/client-config.ts`, konzole *Modules & groups*)
- 14 modulů (hovory, video, soubory, poloha, řeč, AI, telefonie, NFC,
  pozvánky, uložená připojení, upozornění, analytika, vzhled, Edit Mode):
  zapnuto pro všechny, jen pro skupiny, nebo vypnuto. Skupiny `guest`,
  `user` a vlastní skupiny správce s uživatelskými jmény jako členy (klientům
  se členové neposílají; účet zná své skupiny z `/api/account/me`).
- Aplikace schová menu, panely a ovládání modulu, který uživatel nemá;
  server odmítne jeho endpointy (`403 module-disabled`).

### Menu builder (`client/src/lib/menu-config.ts`, `menu-template.ts`, `menu-style.ts`, `MainMenu.tsx`, `server/menu-config.ts`, konzole `menu-builder.js`)
- Menu je data: ☰ tlačítko, panel, **sekce, položky** (panel, funkce, odkaz),
  **HTML** s proměnnými, **oddělovače**, **řady** a **speciální tlačítka**
  (uživatel, Vzhled, Edit Mode, světlý / tmavý, oznámení, účet, Smazat vše a
  odejít, verze). Výchozí konfigurace vykreslí **stejné DOM** jako menu 3.3
  (ověřeno ve všech pěti režimech zobrazení).
- Každý prvek: modul, situace (přihlášen, připojen, telefon…), skrytí;
  styl (zarovnání, obtékání, barvy textu / pozadí / ikony / rámečku, písmo,
  velikost, dekorace, odsazení, zaoblení, stín…) a totéž pro stavy hover,
  click, focus a current.
- **Šablonovací jazyk** podobný Latte: `{$session.current_username}`,
  `{=výraz}`, `{if}`, `{ifset}`, `{foreach}`, `{var}`, `{icon …}`, `{_'klíč'}`,
  22 filtrů; výstup je bezpečný strom prvků (nikdy `innerHTML`), odkazy jen
  `https:` a cesty webu, `data-action="panel:…|fn:…"`.
- Konzole: strom s **přetahováním** (i Alt+↑/↓), přidávání, duplikace,
  skrytí, mazání, zpět / znovu, export / import JSON, výběr ikon (128 ikon
  lucide), editor stylů se stavy, plovoucí **nápověda** (proměnné, filtry,
  makra, příklady — klepnutím vloží), **živý náhled** panelu i lišty.
- `GET /api/menu-config`, `GET|PUT /api/admin/menu-config`,
  `POST /api/admin/menu-config/render`; `$DATA_DIR/menu-config.json`
  (`MENU_CONFIG_FILE`); audit `admin.menu-config`.

### Opraveno
- Konzole *Modules & groups* se ptala admin služby na `/api/modules`
  (404); stav serverových modulů teď přichází s `/api/admin/client-config`.

### Testy
- Jednotkové: uživatelská jména, důkaz klíče a zamčené relace, kroky
  přihlášení a chyby (neznámý passkey, špatný klíč, databáze), moduly a
  skupiny, šablonovací jazyk, konfigurace menu (validace, úložiště, routy,
  náhled), menu z konfigurace (styly, HTML, oddělovače, speciální tlačítka,
  bezpečnost HTML). E2E: `/signup`, `/signin`, neznámý passkey na jiném
  serveru, zamčení Server-enhanced, ochrana navigace, kontrola verzí,
  moduly a skupiny v konzoli, Menu builder (přetažení, klávesnice, styly a
  stavy, HTML s nápovědou, uložení) a totéž menu v aplikaci.

## [3.3.0] – 2026-09-24

Nové okno Místnost a sdílení uložených připojení. Protokol, šifrování ani
data se nemění. Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html#okno-mistnost).

### Okno Místnost (`client/src/components/RoomDialog.tsx`, `client/src/room.css`)
- Typ připojení je **záložka v záhlaví okna** místo názvu *Místnost*:
  *Light · P2P* a *Server-enhanced* (na úzkém displeji *P2P* / *Server*),
  šipky přepínají (WAI-ARIA tabs).
- **Light · P2P**: jméno, room ID a klíč (s okem pro zobrazení).
- **Server-enhanced**: uložená připojení ve vzhledu *Moje připojení*, ale
  **bez tlačítek** — vybírají se klepnutím, vybrané je orámované a
  zaškrtnuté; výchozí první, pak naposledy použitá. *Jiná místnost* ukáže
  pole pro ruční zadání; nepřihlášený vidí výzvu k přihlášení a pole.
- **Ozubené kolo** otevře *Moje připojení* nad oknem Místnost; po zavření se
  seznam obnoví a nově vytvořené připojení je vybrané. Bez připojení nabídne
  *Vytvořit připojení* rovnou s formulářem.
- **Vždy viditelné**: Připojit / Reconnect (podle výběru *Připojit · název*),
  Odpojit, Sdílet místnost.
- **Během spojení nic nepřepnete** (záložka, ostatní záznamy, pole); po
  Odpojit jsou znovu k výběru. Reconnect obnoví totéž spojení.
- Šablony iOS 27 (kapslový segmentový ovladač, vložené řádky, modrá
  fajfka) a Windows 11 (SelectorBar s akcentovou pilulkou, proužek výběru).

### Sdílet připojení (`SharePanel.tsx › ShareConnection`)
- Nové tlačítko **Sdílet** u každého připojení v *Moje připojení* (mezi
  hvězdičkou a košem) otevře okno *Sdílet připojení*: stejná pozvánka jako v
  okně Místnost (kód 12 číslic, počet použití, platnost), ale bez nutnosti
  spojení, s kartou připojení, volbami jako řadou tlačítek a **jménem pro
  pozvaného**.
- Připojení na **jiném signalizačním serveru** předá server v zapečetěné
  pozvánce (`SharePayload.server`, jen čisté `wss://`); pozvaný se tam
  připojí, jen když to správce tohoto serveru povoluje.

### Okna
- Okna se skládají nad sebe: Escape zavře jen horní, další okno ztmaví
  obrazovku jen trochu; všechna se vykreslují do `<body>` (sklo iOS 27 pod
  nimi už neposune pevně umístěný obsah).

### Opraveno
- Obnovení stránky a Reconnect vracely uložené připojení s jiným serverem na
  tento server — relace si teď pamatuje server i připojení.
- Pozvánka přijatá po spojení s jiným serverem zůstala na něm.
- Uložené připojení s režimem *light* po připojení skrylo *Moje připojení* a
  přepínač v záhlaví.

### Testy
- Komponenta okna Místnost a skládání oken (jsdom), pozvánka se serverem a
  jménem, relace se serverem; E2E: výběr připojení v okně, zámek během spojení,
  přidání přes ozubené kolo, sdílení připojení až po připojení hosta kódem.

## [3.2.0] – 2026-09-23

Uložená připojení pro přihlášené uživatele, nové šablony celého GUI (iOS 27,
Windows 11 a pět studiových), jejich konfigurace v administraci a rychlejší
načítání. Protokol ani šifrování se nemění — **klienti 3.1 a 3.2 se v
místnosti potkají**. Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html).

### Uložená připojení (`client/src/lib/connections.ts`, `components/ConnectionsPanel.tsx`)
- Přihlášený uživatel v režimu Server-enhanced si v menu *Moje připojení*
  ukládá, upravuje a maže připojení: **místnost, klíč** (zobrazit, vygenerovat
  ~140 bitů), **jméno**, **obslužný server**, režim, historie chatu, **mizení
  zpráv (TTL)**, relay pro nepřítomné, upozornění, automatické znovupřipojení
  a strategie udržování spojení; název a barva.
- **Výchozí připojení**, **připojení po přihlášení** (nebo k naposledy
  použitému), znovupřipojení po výpadku, po návratu stránky a sítě, přepínač
  připojení v záhlaví, dotaz před přepnutím, *Uložit aktuální místnost*.
- **Statistiky** (připojení, čas online, zprávy, soubory a data, obnovy,
  selhání, chyby, nejvíc lidí) a **log** s filtry, exportem JSON bez klíče a
  vymazáním.
- **Jiný obslužný server**: ze seznamu správce nebo vlastní `wss://`, když to
  správce dovolí. Cizí server nedostane token účtu, úložiště, relay ani
  neposílá administrátorské příkazy.
- Vše zapečetěné **klíčem trezoru účtu** v prohlížeči — nová část trezoru
  `connections` (`PUT /api/account/vault`, ≤ 1,5 MB); server zná jen šifrovaný
  blok a počet. Dokud se trezor nenačte, klient ho nepřepíše.

### Šablony vzhledu (`client/src/themes.css`, `lib/theme-catalog.ts`)
- **iOS 27**: Liquid Glass (průsvitné vrstvy, světelná hrana), bubliny jako
  iMessage, kompozér jako kapsle, zelené přepínače, ikony menu na barevných
  čtverečcích, spodní listy na telefonu; světlý i tmavý tón.
- **Windows 11**: Mica, akrylové nabídky, Fluent ovládací prvky, elevace,
  akcentová linka fokusu, proužek výběru v menu, Segoe UI Variable, tenké
  ikony; světlý i tmavý tón.
- **Studio**: Aurora, Nord, Sakura, Ocean, Graphite. Celkem 13 šablon ve
  třech rodinách, každá dál s 6 barevnými variacemi a 4 rozvrženími.
- **Tón** automaticky podle systému (mění se za běhu), světlý nebo tmavý;
  **styl ikon** outline / thin / bold / duotone / badge nebo podle šablony.
- Šablona se použije ještě před prvním vykreslením (žádné probliknutí).

### Administrace — Client & addons (`server/client-config.ts`)
- Nový panel konzole: využití uložených připojení; zapnutí, statistiky a
  logy, výchozí automatické připojení, vlastní servery, limity (připojení na
  účet, řádky logu), **seznam dalších signalizačních serverů**; povolené
  šablony, výchozí šablona, tón a ikony, **zámek šablony**.
- `GET /api/client-config` (veřejné, nic tajného), `GET|PUT
  /api/admin/client-config` (čtení auditor, změna operátor, audit
  `admin.client-config`), soubor `$DATA_DIR/client-config.json` nebo
  `CLIENT_CONFIG_FILE`. Klienti si změnu vezmou do 5 minut nebo po obnovení.

### Optimalizace
- Build **předkomprimuje** assety (brotli + gzip): hlavní JS 484 kB → 122 kB
  po síti. Server je posílá sám, nginx přes `gzip_static on;`. Soubory s
  hashem v názvu mají roční `immutable` cache, HTML a service worker dál
  `no-store`.
- Chat se nepřekresluje každou sekundu: časovač míří jen na nejbližší
  expiraci zprávy; řádky zpráv jsou memoizované.
- Odvozené klíče v LRU cache; konfigurace layoutu se čte znovu jen při změně
  souboru; stejná konfigurace klienta nevyvolá nové vykreslení.

### Testy
- Unit: model připojení (úpravy, limity, jiné servery, statistiky a
  ohraničený log, načtení z trezoru, dávkové ukládání), politika správce,
  úložiště konfigurace a jeho API, část trezoru `connections`. E2E: uložení a připojení,
  statistiky a log se dvěma účastníky, na serveru jen zapečetěný blok,
  automatické připojení po načtení; konzole *Client & addons*.

## [3.1.0] – 2026-09-23

Zapracované návrhy z roadmapy 3.0: forward secrecy a párové klíče, slepá ID
místností, Argon2id, E2EE hovorů, více instancí serveru, binární přenos
souborů přes relay, účty s více passkeys a obnovou, role v administraci,
neměnný audit, zálohy, metriky a alerty. **Klienti 3.0 a 3.1 se v místnosti
nepotkají** (jiné klíče i ID místnosti) — po nasazení obnovte všechna okna.
Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html).

### Kryptografie v3 (`client/src/lib/envelope.ts`, `kdf.ts`, `sender-keys.ts`)
- **Argon2id** (64 MiB, 3 průchody, WASM) místo PBKDF2 — ve **Web Workeru**,
  stránka nezamrzne. CSP povoluje `'wasm-unsafe-eval'`.
- **Slepé ID místnosti** `r3.<HKDF>`: server název místnosti nezná; historie
  na serveru se čte pod slepým ID (se zpětnou cestou pro data 3.0).
- **Klíče odesílatele s ratchetem** (forward secrecy): řetěz HMAC, klíč zprávy
  se po použití zahodí, rotace po 500 zprávách, hodině nebo odchodu člena;
  **vyloučení člena** z vlastních zpráv bez změny hesla.
- **Párové klíče** (ECDH P-256 + HKDF, podepsané `hello`): soukromé zprávy
  jsou zapečetěné jen pro vybrané příjemce.
- **Identita svázaná s účtem**: klíč zařízení podepsaný klíčem účtu
  (Ed25519 odvozený z kořene účtu); pinování podle účtu, ne jména.
- **Bezpečnostní čísla s QR kódem** (zobrazení i skenování kamerou) a
  potvrzení „ověřeno“; zprávy ukazují, čím byly zapečetěné.
- Obálky v2 (fronta z 3.0) se dál otevřou.

### Soubory a hovory
- **Binární rámce** pro kusy souborů (DataChannel i server): o třetinu méně
  dat než base64 v JSON; schopnost si strany sdělí (`caps`, `features`),
  starší klient dostane JSON.
- **Šifrovaný relay souborů, když P2P selže** (striktní NAT bez TURN) — dřív
  aplikace přenos rovnou odmítla. Odesílatel se **řídí limity**, které server
  ohlásí (80 % rozpočtu), takže ho relay neodmítne ani neodpojí.
- **E2EE hovorů**: každý rámec zvuku a obrazu je v workeru
  (`RTCRtpScriptTransform`) zapečetěný AES-GCM klíčem páru pro daný směr;
  hlavička kodeku zůstává čitelná a autentizovaná (připraveno pro SFU). Panel
  hlasu ukazuje, zda byla za poslední sekundu zapečetěná každá zpráva.
- **TURN s krátkodobými přístupy** (`TURN_SECRET`, TURN REST API).

### Protokol a více instancí (`server/cluster/*`, `server/signaling/cluster.ts`)
- **Cluster přes Redis pub/sub** (`REDIS_URL`): místnost se rozprostře přes
  instance — členství, signály, relayované soubory (binárně i JSON), žádosti o
  opakování, `resume` na jiné instanci, odvolání relací a stav nepřítomnosti.
  Zprávy clusteru podepsané HMAC (`CLUSTER_SECRET`), padělky se zahodí.
  Vlastní RESP klient bez závislostí (TLS, AUTH, reconnect, resubscribe).
- Účty ve sdíleném adresáři: instance si načtou, co zapsala jiná.
- Limity brány spojení z prostředí (`WS_CONNECTS_PER_MINUTE`,
  `WS_CONNECTIONS_PER_CLIENT`, `WS_CONNECTIONS_TOTAL`).

### Fronta a doručování
- **Trvalá evidence relayovaných zpráv** (`relay_ledger`): účtenky fungují i po
  restartu. Odesílatel a stav položky jsou v DB **zapečetěné** master klíčem.
- **Neutrální text probuzení** push — žádné jméno ani místnost na zamčené
  obrazovce.

### Účty
- **Více passkeys na účet** a **obnovovací kód** (130 bitů): kořen účtu je
  zapečetěný pro každý passkey i pro kód; ztráta zařízení už neznamená ztrátu
  trezoru a databáze.
- **Relace přežijí restart** (hash tokenu na disku), klouzavá platnost 12 h,
  nejdéle 7 dní, **seznam zařízení** s odhlášením.

### Administrace a provoz
- **Role** vlastník / operátor / auditor, jmenné tokeny (`ADMIN_TOKENS`,
  správa v konzoli), **přihlášení do konzole passkey**; auditor jen čte.
- **Neměnný audit**: hash řetěz přes záznamy + podepsané kontrolní body
  (Ed25519), ověření z konzole.
- **Zálohy** (online backup SQLite, kopie šifrovaných DB, manifest se SHA-256,
  rotace; `BACKUP_DIR`), kontrola integrity, `VACUUM`.
- **Prometheus `/metrics`** (`METRICS_TOKEN`) a **alerty** s webhookem
  (`ALERT_WEBHOOK_URL`, prahy `ALERT_<PRAVIDLO>`), stav clusteru v konzoli.

### Klient
- `App.tsx` rozdělený do modulů (panely, ovládání hovorů, dialog, pomocné
  funkce); **error boundary** kolem aplikace i každého dialogu.
- **Menší bundle**: dialogy se načtou až při otevření, React ve vlastním
  chunku, KDF worker 216 → 29 kB; hlavní chunk 685 → 440 kB.
- Dlouhé konverzace: vykreslí se posledních 200 zpráv (další na požádání),
  zprávy mimo obrazovku se nepočítají (`content-visibility`).
- **Kompletní i18n** hlášek chatu (cs/en/de) + test úplnosti překladů.

### Testy a nástroje
- Fuzz/property testy (rámce, binární kusy, RESP, payloady, metadata souborů),
  zátěžový skript `npm run load-test`, test upgradu dat z 3.0, E2E: soubory
  přes relay, šifrovaný hovor, obnova účtu kódem, role v konzoli, cluster s
  reálným Redisem. Celkem 795 unit a 48 E2E testů.

### Opraveno
- Worker „background tick“ vznikal z `blob:` URL, kterou produkční CSP tiše
  blokovala — skrytá záložka neudržovala spojení (od 2.11.0).
- Do hovoru, ke kterému se připojil druhý ten, kdo spojení nezahajoval, nešel
  jeho zvuk (chyběla renegociace) — nyní „perfect negotiation“.
- Dva E2E testy sdílely port 5931 a při paralelním běhu mluvily s cizím
  serverem.

### Upgrade z 3.0
1. `git pull`, `npm ci` (nová závislost `hash-wasm`), `npm run build`.
2. nginx: CSP `script-src 'self' 'wasm-unsafe-eval'` (viz
   `deploy/nginx/m5cet.conf`); `nginx -t && systemctl reload nginx`.
3. Volitelně: `TURN_SECRET`, `METRICS_TOKEN`, `ALERT_WEBHOOK_URL`, `BACKUP_DIR`,
   `ADMIN_TOKENS`, pro více instancí `REDIS_URL` + `CLUSTER_SECRET`.
4. Restart; otevřená okna obnovit (klient 3.0 se s 3.1 nepotká).

## [3.0.0] – 2026-09-23

Profesionální komunikační platforma: nový protokol, nové šifrování, nová
fronta zpráv a úplně nová administrace s živým sledováním provozu a
auditem. **Nekompatibilní se staršími klienty** — viz „Upgrade“ níže.
Kompletní dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html).

### Protokol v2 (signalizace, `server/signaling/*`)
- **Každý rámec se validuje** do přesného tvaru s limity (`frames.ts`);
  přeposílané rámce server skládá z ověřených polí, nikdy nerozprostírá, co
  klient poslal. Chyby mají kódy (`invalid-frame`, `unknown-type`,
  `too-large`), rámec nad 256 KB zavře spojení (1009).
- **Rate-limity po třídách** (token bucket na socket: signalizace, relay,
  účtenky, presence, úložiště, proxy + bajtový limit, heartbeat, příkazy);
  kdo je opakovaně překračuje, je odpojen (1008). **Brána spojení** při
  upgradu: počet otevřených za minutu a naráz na adresu i celkem (429/503).
- **Kontrola Origin** při upgradu (`ALLOWED_ORIGINS` pro výjimky).
- **Peer ID přiděluje server.** Obsazené ID už nejde převzít (dřív šlo
  přesměrovat cizí signalizaci); stejný klient se po výpadku vrátí se svým
  ID díky jednorázovému `resume` tajemství.
- **Pseudonymy účtů v místnosti** (`refs.ts`): místnost nevidí ID účtu, ale
  HMAC odkaz platný jen pro ni — nejde spojit osobu napříč místnostmi ani
  zjistit, zda účet existuje. Tajemství je trvalé (`signaling.secret`).
- **Rámec `auth`**: přihlášení/odhlášení bez opuštění místnosti (dřív
  opětovný `join` shodil všem WebRTC spojení). **Odvolání relace** (odhlášení,
  smazání účtu, zásah admina) platí okamžitě i na otevřených socketech
  (`account-revoked`).
- **Heartbeat** (ping/pong) odhalí mrtvá TCP spojení — „přítomný“ uživatel
  za nimi už nezadržuje doručení přes relay. **Zpětný tlak**: pomalý příjemce
  nedostane další kusy souborů, zaseknutý je odpojen.
- **Proxy souborů**: chunky, konec i opakování smí posílat jen odesílatel;
  `proxy-need` jde jen odesílateli, odmítnutí příjemce ruší přenos jen pro
  něj; po odpojení odesílatele se jeho přenosy ukončí.
- Operátorské příkazy se doručí **hned**, je-li zařízení připojené.

### Šifrování v2 (`client/src/lib/envelope.ts`, `identity.ts`)
- **Klíče podle účelu**: heslo → NFC → PBKDF2-SHA256 **600 000** iterací →
  HKDF: zprávy, signalizace, soubory (klíč **pro každý soubor**), kontrolní
  hodnota klíče.
- **Associated data všude**: místnost + ID zprávy, odesílatel + příjemce
  signálu, přenos + pořadí + počet chunků. Šifrový text nejde přesunout
  jinam (jiná místnost, jiná zpráva, jiná pozice v souboru).
- **Zapečetěná signalizace**: SDP a ICE jdou přes server šifrované a
  svázané s odesílatelem i příjemcem — server nemůže podvrhnout DTLS
  otisky a posadit se doprostřed hovoru. Nezapečetěné signály se odmítají.
- **Identita zařízení** (ECDSA P-256, neexportovatelný klíč v IndexedDB):
  zprávy a soubory jsou **podepsané uvnitř šifrování**; TOFU pinování
  jméno → klíč, varování „jiný klíč než dříve“, bezpečnostní čísla (60 číslic).
- **Soubory**: podepsaný otisk celého souboru (SHA-256 přes otisky chunků)
  v koncovém rámci, kontrola před předáním; validace metadat před alokací
  (strop 2 M chunků); **bezpečný MIME** — HTML/SVG z chatu už nepoběží jako
  stránka v originu aplikace (dřív XSS přes `blob:` URL).
- **Ochrana proti replay** (ID zpráv), **kontrola klíče** mezi peery (hláška
  „jiné heslo“ místo nečitelných zpráv).
- **Zapečetěné zprávy**: kód 12 znaků (≈ 59 bitů, dřív 6 ≈ 30 bitů), bez
  modulo biasu, 600 000 iterací, normalizace při zadávání.
- **Historie pro server bez passkey** se šifruje už v prohlížeči klíčem,
  který nikdy neopustí zařízení; do žádného úložiště mimo prohlížeč nejde
  text ani kód zapečetěné zprávy.
- Obálky v1 jdou dál přečíst (zprávy z fronty z doby před upgradem).

### Fronta zpráv pro offline účty (`server/accounts/mailqueue.ts`)
- Tabulka v SQLite místo JSON souboru přepisovaného celý: **pořadí** (seq
  na účet a místnost), **deduplikace**, **lease** (doručení nemaže — jen
  potvrzení; po odpojení se lease hned uvolní), **kvóty** (na účet i na
  odesílatele), **expirace**, **dead-letter** s důvodem a obnovou z admina.
  Bez úložiště funguje stejně v paměti (`memqueue.ts`).
- **Účtenky jen pro skutečně relayované zprávy** a jen jejich odesílateli
  (dřív šlo podvrhnout „přečteno“ nebo vložit cizí položky do schránky).
- Odmítnutí je obecné — neprozradí jména ani existenci účtů.
- Staré schránky se při startu převedou do fronty.

### Administrace (nová konzole `/console/`)
- **Živý provoz**: každý rámec a požadavek (metadata — nikdy obsah), filtry,
  pauza, detail, graf propustnosti; **spojení** s adresou (/24), klientem,
  bajty, odpojením; **místnosti** (jako hash).
- **Audit**: bezpečnost, účty, komunikace (volitelné, výchozí vypnuto),
  úložiště, admin, síť, systém — úrovně, filtry, zdroj paměť/databáze,
  export CSV (s ochranou proti vzorcům) a JSON. Každý zásah operátora se
  zapisuje.
- **Uživatelé a passkeys**: databáze, trezor, fronta, relace, detail s
  passkeys a historií; odhlásit všude, smazat (s potvrzením ID).
- **Fronta**, **úložiště** (globální DB, tabulky, index šifrovaných DB),
  **systém** (RSS, heap, event loop p99, CPU, zdroje, grafy 30 min),
  **retence**, **příkazy a push**; zachovány nástroje layout builderu,
  telefonie a AI.
- Token jen v paměti (volitelně session storage), **nikdy v localStorage**
  (starý klíč se maže); striktní CSP bez inline skriptů.

### Bezpečnost serveru
- Log požadavků **bez těl odpovědí** (dřív se logovaly i session tokeny).
- Limity **před** parsery těl; vlastní limity pro trezor, úložiště, admin
  (počítá se hlavně odmítnutý token), sdílení.
- **Push endpointy jen známých služeb** (FCM, Mozilla, Windows, Apple;
  `PUSH_ENDPOINT_HOSTS`) — konec SSRF do interní sítě.
- Produkční **CSP `script-src 'self'`**, `object-src 'none'`; chyby 500 bez
  interních detailů; řádné ukončení na SIGTERM.
- `/api/transfers/stats` a `/api/events/recent` jen s admin tokenem.
- Varování, když chybí `WEBAUTHN_RP_ID` / `PUBLIC_BASE_URL`.

### Opraveno
- Admin služba zapisovala příkazy do vlastní (prázdné) fronty — ke klientům
  se nikdy nedostaly. Stav s živými daty teď spravuje hlavní služba, admin
  služba přeposílá (`MAIN_URL`).
- Obnovená historie označovala vlastní starší zprávy jako cizí.
- Úložiště: 18 oprav (limity, kvóty, povýšení session → účet v transakci,
  držitelé klíčů po zařízeních, ID relací jen jako HMAC, …) — `docs/storage.md`.

### Upgrade
- Klienti 2.x se po nasazení sami nabídnou k obnovení (kontrola buildu).
  Klient 2.x v místnosti s klientem 3.0 zprávy neotevře a spojení odmítne
  (nezapečetěná signalizace) — obnovte všechna okna.
- nginx: přidejte blok `location /api/admin/` z `deploy/nginx/m5cet.conf`.
- Admin služba potřebuje `MAIN_URL`, pokud hlavní služba neběží na
  `127.0.0.1:$PORT`.

## [2.11.0] – 2026-09-23

Okno, které se vrátí přesně tam, kde bylo — a chat, ve kterém je jen to, co
si lidé napsali. Viz [`docs/lifecycle-and-notices.md`](docs/lifecycle-and-notices.md).

### Přidáno
- **Hooky na pozastavení a probuzení aplikace.** Přepnutí záložky, přepnutí
  do jiné aplikace, `freeze`/`resume`, back/forward cache, zahození stránky
  i výpadek sítě — všechno se sjednotí do jednoho *pozastaveno* a jednoho
  *obnoveno* (`lib/lifecycle.ts`), s rozumnými odklady (přeblik na jinou
  záložku na dvě vteřiny nic nehlásí, `freeze` se hlásí okamžitě).
- **Při pozastavení** se uloží stav a u přihlášeného uživatele jde na server
  rámec `presence: away` — server od té chvíle zprávy přebírá a drží, i když
  socket ještě žije (pozastavená stránka nemusí spustit nic). Ostatní v
  místnosti vidí `peer-away`.
- **Při probuzení** se spojení vrátí do stejného stavu: pokud socket nepřežil,
  znovu se připojí do téže místnosti; jinak pošle `presence: back`, dostane
  vše, co server mezitím nasbíral, potvrdí to a odesílatelé vidí *doručeno*.
  Je to **totéž sezení** — data ani nastavení se nezahazují.
- **Flash oznámení**: systémové zprávy se nově zobrazují nahoře nad chatem —
  jedna naráz, max dva řádky, fade-in, 10 s, fade-out, kliknutím zavřít a
  hned naskočí další z fronty (s počtem čekajících). Nastavitelné je
  umístění, doba, animace, ikona, velikost písma, zaoblení, barvy i písmo.
- **Fronta odchozích zpráv pro light režim**: když nikdo není online, zpráva
  neselže — čeká zašifrovaná ve frontě, bublina má stav *odesílá se*
  (světlejší čárkované pozadí a ikona) a odeslání se zkouší při otevření
  kanálu, po návratu do okna a jednou za minutu. Limity: 200 zpráv, 60
  pokusů, 24 h, respektuje TTL zprávy.
- **Tik na pozadí** z Web Workeru (jednou za minutu) pro skrytou stránku:
  všimne si mrtvého socketu a zkusí frontu. Dokumentace poctivě popisuje, co
  prohlížeč umožňuje a co ne (zamrzlá stránka nespustí nic — od toho je Web
  Push).

### Změněno
- **V chatu jsou nově jen zprávy lidí.** Systémová hlášení jdou do flash
  oznámení; přepínač *Vzhled → Zobrazení → Oznámení → „Systémové zprávy i v
  chatu"* je vrátí i do konverzace v časové posloupnosti.
- Server ukládá zprávu pro away účet i tehdy, když jeho socket ještě žije —
  dřív by ji poslal na pozastavenou stránku, která ji nemusí zpracovat.

## [2.10.0] – 2026-09-22

Server konečně má vlastní úložiště — a každý uživatel v něm svou šifrovanou
databázi. Viz [`docs/storage.md`](docs/storage.md).

### Přidáno
- **Globální SQLite databáze** pro server: registrovaní uživatelé, jejich
  passkeys (jen veřejný klíč), **index všech šifrovaných databází** (kdo je
  vlastní, jak je klíčovaná, kdy vyprší, jak je velká), tabulka logů a
  ladění a tabulka všech přenosů — detailně. Sloupce `detail` u logů i
  přenosů jsou zapečetěné master klíčem, místnost jen jako hash.
- **SQLCipher databáze pro každého uživatele.** Přihlášený passkeyem: klíč
  se počítá z passkey (PRF → HKDF) v prohlížeči, server ho drží jen v paměti
  po dobu sezení — po restartu i po odhlášení je soubor neotevíratelný.
  Data jsou perzistentní a mažou se jen na příkaz uživatele.
- **Dočasné úložiště pro nepřihlášené** v režimu server-enhanced: klíč
  vygeneruje server na začátku sezení a drží ho zabalený master klíčem, data
  žijí **jeden den** a tlačítko „Smazat vše a odejít" je smaže hned.
- **Převod po registraci passkey**: data z dočasné databáze se překopírují do
  nové, klíčované passkeyem, původní se i s klíčem smaže a prohlížeč dostane
  id nové databáze, kam od té chvíle zapisuje.
- **Sada API funkcí pro celé úložiště** (`/api/storage/*`): stav, relace,
  otevření databáze klíčem, převod, souhrn, hodnoty, zprávy, místnosti,
  schránka, události, logy, přenosy a smazání všeho. Úplně stejné operace
  jdou i **přes signalizační WebSocket** (`{"type":"storage","op":…}`) —
  bez dalšího spojení a bez round tripu navíc.
- Operátorské pohledy za admin tokenem: `GET /api/admin/storage` (index,
  uživatelé, statistiky), `…/logs`, `…/transfers`.
- Proměnné `STORAGE_DIR` a `STORAGE_MASTER_KEY`; bez druhé se vygeneruje
  `storage.key` (0600) v adresáři úložiště.

### Opraveno
- **Vytvoření účtu a přihlášení passkeyem.** Klíč se nově odvodí **dřív**,
  než účet na serveru vznikne, takže po neúspěchu nezůstane osiřelý účet.
  Passkey bez rozšíření PRF (řada USB klíčů, starší platformy) teď dostane
  jasnou hlášku, co s tím — dřív skončil obecnou chybou. Trezor a databáze
  navíc používají dva nezávislé klíče odvozené z téhož PRF tajemství.

### Změněno
- Trezor přihlášeného uživatele se ukládá do jeho SQLCipher databáze (pořád
  zapečetěný prohlížečem — tedy dvojitě), soubor vedle indexu účtů slouží už
  jen jako záloha pro server bez úložiště.
- Přenosy se zapisují do serverové tabulky (směr, transport, stav, bajty,
  chunky, zopakované chunky); chybějící chunky se hlásí do logu.
- Nová **volitelná** nativní závislost `better-sqlite3-multiple-ciphers`
  (SQLCipher) — instalace kvůli ní nespadne. Když modul chybí, server běží
  dál a `GET /api/storage/status` hlásí `available: false`.

## [2.9.0] – 2026-09-22

Konverzace, která může zůstat — a uživatel, za kterého server odpoví.
Viz [`docs/accounts-away.md`](docs/accounts-away.md).

### Přidáno
- **Data a historie chatu** (Menu → Spojení): tři volby — *nové připojení
  smaže chat a logy* (výchozí), *chat a logy do konce sezení* (šifrovaně
  v prohlížeči, tlačítko **Odhlásit — smazat sezení a data**), *chat a logy
  na serveru* (zašifrované passkeyem, vyžaduje registrovaný passkey).
- **Účet ověřený passkeyem** (`/api/account/*`): server ověřuje podpis
  WebAuthn (ES256 / Ed25519 / RS256, rpId, origin, UV, čítač) vlastním kódem
  nad `node:crypto` — bez nové závislosti. Klíč z rozšíření **PRF** zapečetí
  profil i historii, takže server drží jen šifrový text a metadata.
- **`/signin`**: návštěva se pokusí přihlásit uloženým passkeyem, dešifruje
  data, nahraje je do aplikace a cestu hned uklidí zpět na `/`. Sem míří i
  probouzecí push.
- **Odznak „přihlášen"** vedle loga s ikonou odemčeného klíče; po kliknutí
  okno účtu: přihlašovací údaje, velikost sezení na serveru, datum vzniku a
  posledního přihlášení, počet a velikost zpráv, čekající schránka, zařízení
  pro upozornění a **serverový log aktivity** (přihlášení, dešifrování,
  načtení a uložení dat, away, relay, push).
- **Stav away a relay**: přihlášenému uživateli, který se odpojí, zůstane
  místo v místnosti. Ostatní posílají dál — server šifrový text uloží,
  odpoví za něj (`stored`) a zkusí probudit prohlížeč push zprávou. Po
  návratu doručí vše najednou, klient potvrdí a odesílatel vidí *doručeno*
  (a *přečteno*, pokud je potvrzování zapnuté). Stav zprávy je i značkou
  v bublině a s časy v detailu zprávy.
- Seznam **Příjemci** je nově ukotvený **vpravo u tlačítka menu** (ne vlevo
  pod logem, a pod stavovou lištou, aby nepřekrýval Odpojit — výšku lišty
  měří aplikace), jeho tlačítko jde přetáhnout kamkoli a pozice se pamatuje
  (u přihlášeného uživatele i na serveru). Away účastníci jsou v seznamu
  vidět a dají se vybrat jako příjemci.
- Instalátor dává službě zapisovatelný `StateDirectory=m5cet`
  (`DATA_DIR=/var/lib/m5cet`), aby účty přežily restart pod
  `ProtectSystem=strict`.

### Opraveno
- **„File transfer failed: Missing chunks at end-of-transfer."** Tři příčiny,
  všechny se projevily až na konci jinak zdravého přenosu:
  - Příjemce zpracovával rámce **souběžně** — každý se dešifruje asynchronně
    a přichází ve vlastním volání handleru, takže první chunky předběhly
    `meta` (a spadly jako „unknown transfer") a `end` předběhl poslední
    chunky. Rámce se nově řadí do fronty podle `transferId`.
  - Odesílatel **tiše zahazoval** chunk, jehož `send()` prohlížeč odmítl
    (plná fronta, v Chrome 16 MiB). Nově počká, až se buffer vyprázdní, a
    zkusí to znovu (6 pokusů); když to nejde, přenos skončí chybou, místo
    aby dorazil děravý soubor. Čekání na buffer se navíc nevzdává po 1,5 s.
  - Když se chunk přesto ztratí (kanál se rozpadl a vrátil, výpadek relay),
    příjemce si o chybějící části **řekne** (`file-need` / `proxy-need`) a
    odesílatel je zopakuje — až tři kola, pak teprve chyba (nově s počtem
    chybějících částí). Viz [`docs/files.md`](docs/files.md).
- **Přenos přes server relay vůbec nedoručoval.** Server přeposílal jen
  `proxy-end`; `proxy-meta` a `proxy-chunk` si nechával pro sebe (a ukládal
  je oříznuté na 256 znaků). Nově přeposílá všechny rámce a těla chunků
  neukládá vůbec — jen počítá, co prošlo, kvůli limitu.

### Změněno
- `POST /api/passkey/profile` (neautentizované úložiště profilu podle id
  credentialu) **je pryč**; nahradil ho účet s ověřeným podpisem. Profil se
  ukládá do trezoru účtu.
- Retenční úklid maže i nedoručené položky schránky (`RELAY_RETENTION_DAYS`,
  výchozí 30) a staré záznamy auditu účtů.
- Psát jde i tehdy, když je protějšek ve stavu away (dřív bylo tlačítko
  Odeslat zašedlé, dokud nikdo nebyl připojený).

## [2.8.1] – 2026-09-22

Operátorské cesty hlavní služby za admin tokenem, retence, která opravdu
běží a maže. Viz [`docs/api.md`](docs/api.md) (Push, Retence).

### Zabezpečení
- **`POST /api/push/test` už nerozešle push bez autentizace.** Bez tokenu jen
  self-test: `{ id }` = vlastní id odběru z `/api/push/subscribe`, pevný text,
  jen na tuto subskripci (`404` neznámé id). Broadcast všem (`{ broadcast: true }`,
  i požadavek bez `id`) jen s `Authorization: Bearer $ADMIN_API_TOKEN`.
  Dřív požadavek bez `id` poslal text volajícího na cizí zařízení. Navíc
  limit 10 testů / min na IP.
- **`GET|POST /api/admin/retention*` vyžadují admin token** (`503` bez
  nastaveného `ADMIN_API_TOKEN`, `401` bez tokenu / se špatným, s
  `WWW-Authenticate: Bearer`).
- Kontrola tokenu v konstantním čase je jeden sdílený helper
  (`server/admin-auth.ts`) pro admin službu i hlavní službu. Routy zůstávají
  v hlavní službě, protože push subskripce, settings, audit, consent i event
  ring žijí v její paměti — admin proces má vlastní prázdné kopie.

### Opraveno
- Retence se **spouští sama**: `unref` timer v hlavní službě každých
  `RETENTION_SWEEP_MINUTES` (výchozí 60, 1–1440; nová proměnná, i v
  instalátoru). Dřív jen ručně přes neautentizovaný endpoint.
- Settings sync se maže podle `SETTINGS_RETENTION_DAYS` (dřív omylem podle
  `DATA_RETENTION_DAYS`).
- Prošlé události se opravdu mažou z ringu (`EVENT_RETENTION_DAYS`); dřív se
  cutoff spočítal a nepoužil.
- Vyprázdněné per-device audit logy se odstraní celé.
- `GET /api/admin/retention` vrací i plán a poslední sweep (`lastSweep`,
  `nextSweepAt`, `intervalMinutes`); ruční sweep už nepřeskakuje „not due".
- Komentář v `server/retention.ts` sliboval 24h výchozí hodnotu; skutečné
  výchozí hodnoty jsou 30/60/90/7/30 dní — opraveno.
- Tlačítko *Test web push* posílá jen vlastní id; bez odběru poradí povolit
  notifikace, po `404` (restart serveru) zapomene neplatné id.

## [2.8.0] – 2026-09-22

Vzhled, mobilní layout, Edit Mode, druhy zpráv, telefonie a admin layout
builder. Wire formát zpráv je zpětně kompatibilní (nová pole jsou volitelná).

### Přidáno
- **Obrazovka Vzhled** (*☰ → Vzhled*, nahoře v menu rychlý přístup):
  šablona, 71 Google Fonts + systémová písma (rozhraní / zprávy / kód, velikost,
  tloušťka, řádkování, prostrkání; Google až po souhlasu), paleta 116 barev +
  vlastní barva s kontrastem (akcent, bubliny, zaoblení, pozadí), zobrazení
  a zařízení, editor. Viz [`docs/appearance.md`](docs/appearance.md).
- **Edit Mode** (přepínač ✓/✗ ve Vzhledu i nahoře v menu): výběr libovolného
  prvku Ctrl + pravým tlačítkem nebo dlouhým stiskem; inspektor ve Shadow DOM
  (selektor, stavy :hover/:active/:focus/:visited/::before…, zařízení,
  !important, řádky i zdroj, zdrojový kód tříd, přidání/odebrání tříd, box
  model); trvalé uložení, export/import, `?nostyles`.
- **Mobilní layout podle zařízení a prohlížeče** (`data-os/-browser/-form/-input`):
  iOS klávesnice (visual viewport), spodní panely, 16px pole, 44px cíle,
  celá obrazovka, instalace, `theme-color`.
- **Verze a build v aplikaci** (patička menu, Vzhled → Zobrazení,
  `/api/health`) a upozornění „nová verze — Obnovit" pro karty otevřené před
  nasazením (`dist/public/build.json`).
- Druhy zpráv: klikací (odkrytí podržením), mizející (4 s – 2 h, teploměr na
  okraji) a zapečetěné (vlastní kód); hlasové zprávy s přepisem; AI panel;
  NFC workbench; PassKey profil na serveru; plovoucí widget příjemců
  (ukotvení, nastavení); info o zprávě s auditní stopou; odpověď a přeposlání;
  avatary a styl bubliny pro každého uživatele.
- Telefonie: SMS a hovory přes Twilio / Telnyx / Vonage (Vonage Voice JWT),
  SIP trunky (perzistentní + `SIP_TRUNKS` v `.env`), webhooky
  `/wh/{provider}/{typ}` s ověřením podpisů, konzole v adminu.
- Admin **Layout / template builder** (styly komponent, šablony se zástupnými
  parametry a includes, živý náhled); systémové zprávy s monochromatickým
  logem, plným datem a sbalováním.
- `TRUST_PROXY`: reálné IP klientů za reverzní proxy (rate limit na
  návštěvníka, ne na nginx).

### Opraveno
- Bezpečné okraje (výřez, home indikátor) se na iPhonu nikdy neuplatnily.
- Vonage klíč: poškozený / neúplný PEM se hlásí srozumitelně (dřív 502
  `DECODER routines::unsupported`).
- Dev server za doménou: 403 na `/@fs/…`, pád po zamítnutém požadavku.
- Detekce změn konfiguračních souborů podle obsahu (ne mtime).
- `/api/turn` bez TURN serveru vracel 404 (červená chyba v konzoli).

## [2.7.0] – 2026-09-21

Relace, pozvánky, úplné smazání stop, menu pod ikonou a nové šablony.
Wire formát zpráv beze změny. Podrobně
[`docs/session-and-sharing.md`](docs/session-and-sharing.md).

### Přidáno
- **Šifrovaná session cache** (`lib/session-cache.ts`): jméno, room ID, klíč
  místnosti a požadovaný stav; AES-GCM pod neexportovatelným klíčem
  v IndexedDB, šifrovaný text v `sessionStorage`. Platí do zavření karty,
  po hodině nečinnosti se smaže. Po reloadu se aplikace sama připojí.
- **Vynucený požadovaný stav**: „Připojit" → aplikace spojení drží a po výpadku
  zkouší znovu s prodlevou; pokusy se logují (*Spojení → Pokusy o spojení*).
  „Odpojit" je dostupné i během navazování a zapisuje se synchronně.
- **Pozvánka odkazem + 12místný kód `XXXX-XXXX-XXXX`** (*Místnost → Sdílet*):
  klíč rozdělený mezi fragment URL, server a kód; 5 špatných kódů odkaz zničí,
  limit X připojení, platnost 1 h – 7 dní, zneplatnění. `GET` od robotů
  a náhledů nic nespotřebuje; příjemci se odkaz ihned smaže z adresy.
  Sdílení: WhatsApp, Telegram, Viber, Signal, Messenger, iMessage, SMS, e-mail,
  QR (lokálně), kopírování, systémový dialog. Endpointy `/api/share/*`.
- **„Smazat vše a odejít"** na konci menu: smaže úložiště, IndexedDB, cache,
  service worker, push, cookies a serverová data zařízení, pak `/goodbye`
  s hlavičkou `Clear-Site-Data`.
- **Šablony** Midnight, Paper a Kontrast (celkem 6), ke každé **6 barevných
  variací** a **4 rozvržení** (klasické, široké, kompaktní, soustředěné).
- Modální okna se zavírají klávesou Escape.

### Změněno
- **Menu se otevírá ikonou ☰** (tři čáry) jako výchozí; dřívější uložená volba
  se jednou převede, ostatní režimy zůstávají v Nastavení.
- Pokus o připojení, který skončí výjimkou, už smyčku opakování neukončí.

### Bezpečnost — co je potřeba vědět
- Klíč místnosti se nově **ukládá** (šifrovaně, jen po dobu života karty).
  Do 2.6.0 se neukládal vůbec. Nechrání před kódem běžícím v originu stránky
  ani před forenzním čtením profilu prohlížeče.
- **Historii prohlížeče web smazat neumí.** „Smazat vše a odejít" odstraní vše
  ostatní a do historie nic tajného nedává.
- Pozvánky jsou v paměti serveru — restart je zneplatní.
- Nová závislost `uqr` (QR, MIT, bez závislostí), načítaná až na vyžádání.

### Otestováno
- 139 unit testů (nově session cache, pozvánky klient + server), **20 e2e
  testů** ve skutečných prohlížečích, třikrát po sobě bez selhání: reload →
  automatické připojení, „odpojen" přežije reload, celý tok pozvánky včetně
  špatného kódu a limitu použití, úplné smazání po „Smazat vše a odejít".
- **Neověřeno:** deep linky do messengerů na reálných zařízeních,
  `Clear-Site-Data` v Safari a Firefoxu, chování při zavření karty na iOS.

## [2.6.0] – 2026-09-21

Větev `clean-installation`: nová instalační sada, oprava odesílání souborů,
přepracované menu a kompozér, úklid repozitáře. Wire formát beze změny.

### Přidáno
- **Instalační sada** `install.sh` / `update.sh` / `uninstall.sh` +
  `installer/lib/` (bash ≥ 3.2). Zjistí systém, doinstaluje závislosti,
  průvodce v textu nebo `whiptail`/`dialog` (cs/en), bezobslužný režim
  a soubor odpovědí. Dva způsoby nasazení — **native** (systemd / proces)
  a **docker** — přepínatelné za běhu. Volby v `.m5cet/install.conf`, tajemství
  v `.env`; zálohy a **automatický rollback** při neúspěšné aktualizaci;
  `--repair`, `--doctor`. Podrobně [`INSTALL.md`](INSTALL.md).
- Generovaný web Nginx omezuje WebSocket spojení na klienta — změřeno 60
  souběžných upgradů: 20 × `101` + 40 × `503` přes proxy, 60 × `101` přímo na
  aplikaci (jejíž vlastní WS limiter se nespouští).
- Server: proměnná `HOST` — nativní instalace může poslouchat jen na loopbacku.
- Menu seskupené do čtyř skupin (místnost / komunikace / nástroje / aplikace)
  a **uživatelský prvek** (avatar + jméno → profil) v liště i mobilním panelu.
- `docs/modes.md`: režimy Light / Server-enhanced, jejich parametry a soubory,
  odpověď na otázku Firebase (hlavní aplikace ho nepoužívá).
- E2E test dvou peerů (`test/e2e/two-peers.test.ts`) — první test pokrývající
  `App.tsx`; unit test `linkify`; CI joby `installer` a `e2e`.

### Opraveno
- **„File exceeds inline cap of 512.0 kB; use chunked transfer."** Tlačítka
  Soubor/Obrázek u zprávy uměla jen inline cestu. Větší soubory se nyní
  pošlou automaticky šifrovaně po částech.
- **Chunked odesílání padalo po posledním chunku**: `useRef`/`useEffect` byly
  volány uvnitř asynchronního handleru za `await`. Karta přenosu zůstávala
  „běží" a hláška o úspěchu se nezobrazila.
- Bez připojeného peera se přenos nespustí — dřív spadl do serverové „proxy"
  cesty, která data nedoručuje, a přesto hlásil úspěch.
- Mobilní stavový štítek ukazoval první písmeno interního stavu („i").
- E2E sada: tři chybné testy (očekávání 60 znaků v poli s limitem 42; test
  „linkify", který si odkaz `javascript:` vložil sám; test API proti
  statickému serveru).

### Změněno
- Kompozér je jedna lišta s ikonami a **kulatým tlačítkem Odeslat 40 px**
  místo bloku vysokého 56 px (na mobilu přes celou šířku).
- `Dockerfile.admin` odstraněn: admin běží ze stejného image s jiným
  `command` a své GUI servíruje sám; odpadl i kontejner `admin-ui` (nginx).
- Výchozí větev instalátoru je `master` (dřív zastaralá feature větev).
- Kořen repozitáře má tři dokumenty (`README`, `INSTALL`, `CHANGELOG`);
  `KNOWLEDGE_BASE` a `CLIENT_OPTIMIZATIONS` přesunuty do `docs/`, `DEPLOYMENT`
  sloučen do `docs/deployment.md`, pravidla z `WORKFLOW` do vývojářského
  průvodce, `PROGRESS` zrušen.

### Odebráno
- Nepoužité obaly šablony: `QueryClientProvider`, `TooltipProvider`, `Toaster`
  a hash router s jedinou trasou. S nimi 9 balíčků (runtime závislosti
  **16 → 8**), `components/ui`, `use-toast`, `queryClient`, `utils`,
  `calls.ts`, `shared/schema.ts`, `server/storage.ts`, `components.json`,
  mrtvé Tailwind tokeny. **JS 495 → 373 kB** (gzip 153 → 113), CSS 39,7 → 33,7 kB.
- Jednorázové skripty `merge-and-tag-v2.4.1.sh`, `notes-to-patch.sh`, `.memory/`.

### Bezpečnost
- Instalátor nezapisuje tajemství do compose souboru ani do chybových hlášek;
  konfiguraci parsuje proti seznamu klíčů, nikdy ji nenačítá přes `source`.
- ⚠️ Commit `fb31919d` (2.5.0) omylem zahrnul `browser-only-firebase/conf.json`
  a úpravu `app.js` se skutečnou webovou konfigurací Firebase a byl odeslán do
  veřejného repozitáře. Nejde o serverové tajemství, ale zveřejnění nebylo
  záměrné — doporučeno omezit API klíč na referrery domény / zapnout App Check.

### Otestováno
- `tsc` čisté · 106 unit testů · 10 e2e testů · guard 8/8 · build OK ·
  `shellcheck` čistý. Instalátor: viz „Co je ověřeno" v `INSTALL.md`.
- Vzhled: desktop a 375 px ve všech třech tématech.
- **Neověřeno:** unit pod skutečným systemd, certbot/TLS, ufw/firewalld,
  dnf/yum/pacman/zypper/apk; skutečný hovor mezi dvěma zařízeními.

## [2.5.0] – 2026-09-21

Modernizace toolchainu, úklid závislostí a oprava regresí z větve
`empero-ai-updates`. Wire formát (salt `CipherRoom:v1:`, obálka
`{ iv, ciphertext }`) se **nemění** — klienti 2.4.x a 2.5.0 spolu komunikují.

### Opraveno
- **Šifrovací jádro (`client/src/lib/crypto.ts`) bylo na větvi nefunkční.**
  Přepsaná verze volala `deriveKey` s nevyřešeným `Promise` místo
  `CryptoKey` (odvození klíče vždy selhalo), `decryptEnvelope` obsahoval
  `new Uint8Array.from(...)` (vždy `TypeError`), IV se serializovalo jako
  text místo 12 B base64, dekódování rozbíjelo UTF-8 a `encryptEnvelope`
  vracel `{ ...envelope, iv, ciphertext }` — tedy **plaintext vedle
  ciphertextu**. Cache klíčů byla navíc klíčovaná jen názvem místnosti, takže
  změna passphrase se 5 minut neprojevila. Obnovena ověřená implementace
  z `master`; cache odstraněna (klíč se odvozuje jednou za join, ne za zprávu).
- **`connection-keeper.ts`**: přepsaná verze měla 9 chyb `tsc` a logické
  vady (backoff `Math.min(initial, initial·2ⁿ)` je vždy `initial`, ignorovaná
  `options.strategy`, neodchycená výjimka z `new WebSocket()`, zmizelý export
  `STRATEGIES`). Obnoveno z `master`. **Dopad za běhu byl nulový:** `App.tsx`
  modul jen importuje kvůli typům a `createConnectionKeeper` nikde nevolá —
  signalizační socket, heartbeat i reconnect má napsané vlastní (viz Známé
  mezery níže).
- **`Permissions-Policy`**: hodnota `camera=(), microphone=(), geolocation=()`
  zakazovala funkce i vlastnímu dokumentu — hovory, STT a sdílení polohy tak
  nemohly fungovat (ověřeno v prohlížeči: `allowsFeature()` → `false`).
  Nově `(self)`; cizí iframy zůstávají blokované.
- **Start na macOS**: `listen({ reusePort: true })` končil `ENOTSUP`. Volba
  odstraněna — server drží místnosti v paměti procesu, sdílení portu mezi
  procesy by navíc rozdělilo peery jedné místnosti.
- **`.tsx` testy se nikdy nespouštěly**: `"jsx": "preserve"` + transformace
  Vite 8 (oxc) → chyba při importu. Nastaveno `react-jsx`, do
  `vitest.config.ts` přidán `@vitejs/plugin-react`. Tím vyšly najevo a byly
  opraveny dvě skutečné chyby v `MainMenu`:
  - tlačítka v režimu `icons-text` neměla na úzkém viewportu přístupný název
    (popisek je `hidden sm:inline`, `aria-label` chyběl),
  - do portálovaného speed-dial panelu se nedalo dostat klávesnicí (šipky
    obsluhoval jen `<ul>`), `Home`/`End` padaly na záporném indexu.
- `test/transfer-card.test.tsx`: řetězec ukončený typografickou uvozovkou `”`.
- `scripts/pre-commit-check.sh`: `\s` v `awk` není POSIX a BSD awk (macOS) ho nezná →
  na macOS kontrola 3 vždy selhala a negativní kontroly 4–5 procházely
  naprázdno. Přepsáno na `[[:space:]]`, rozsah zúžen na konkrétní pravidlo,
  ověřeno negativním testem. Hook `.githooks/pre-commit` je nově spustitelný.
- `test/e2e/ui-smoke.test.ts`: `app.get("*")` v Express 5 vyhazuje výjimku,
  testovací server tedy nikdy nenaběhl. Nahrazeno `app.use("/{*path}")`.
- `script/build.ts`: `optionalDependencies` nebyly mezi externals, nativní
  addon `bufferutil` se tak přibaloval do bundlu, kde nemůže fungovat.

### Změněno
- **Node.js ≥ 22** (`engines`), Docker a CI na **24 LTS** (Node 20 je EOL).
- TypeScript 5.6 → **7.0** (odstraněno `baseUrl`; typy bajtů zpřesněny na
  `Uint8Array<ArrayBuffer>`), Vite 8.3, Vitest 5, `@vitejs/plugin-react` 6,
  React 19.3, lucide-react 1.x, esbuild 0.28.2, Express 5.2, Helmet 8.3 aj.
- `dotenv` nahrazen vestavěným `process.loadEnvFile()` (`server/env.ts`);
  skutečné prostředí má dál přednost před `.env`.
- **Base64 kodek sjednocen** do `lib/crypto.ts` (dříve 3 kopie). Používá
  nativní `Uint8Array.toBase64/fromBase64`, jinak blokový fallback. Změřeno
  (Node 24, 32 KiB chunk): kódování 2,3×, dekódování 32× rychlejší; výstup
  bajtově shodný. Viz `CLIENT_OPTIMIZATIONS.md`.
- Build: oba server bundly jedním voláním esbuild, souběžně s Vite; klient
  minifikuje oxc. Do bundlu nově patří i `helmet`.
- Docker: runtime image už **neobsahuje `node_modules`** (bundly jsou
  soběstačné — ověřeno spuštěním v prázdném adresáři), běží jako `USER node`.
  `docker-compose.yml` bez zastaralého klíče `version`.
- `tsBuildInfoFile` přesunut do `node_modules/.cache/tsc/`.

### Odebráno
- 44 nepoužívaných shadcn/ui komponent (zůstávají `card`, `toast`, `toaster`,
  `tooltip`) a hook `use-mobile`. Obnova: `npx shadcn add <název>`.
- 58 nepoužívaných balíčků — runtime závislosti **68 → 16**, dev 25 → 19,
  instalovaný strom (lockfile) **562 → 349** balíčků: mj.
  `@supabase/supabase-js`, `passport`, `express-session`, `better-sqlite3`,
  `drizzle-*`, `zod`, `recharts`, `framer-motion`, 25× `@radix-ui/*`.
  S nimi `drizzle.config.ts` a skript `db:push` (schéma nemá žádné tabulky).
- Produkční CSS **78,2 → 39,7 kB** (gzip 13,9 → 8,6 kB): Tailwind skenoval
  i nepoužité komponenty.

### Bezpečnost
- `.dockerignore` nově vylučuje `.env` — dříve se `ADMIN_API_TOKEN`, VAPID
  privátní klíč a TURN přihlašovací údaje dostávaly do build vrstvy image.
- Regresní testy wire formátu: obálka smí obsahovat jen `iv` + `ciphertext`,
  IV má přesně 12 B, UTF-8 a 512 kB příloha projdou beze ztráty.
- `KNOWLEDGE_BASE.md` přepsán: původní text uváděl jako referenci smyšlený
  kód (odvození klíče bez PBKDF2, opakované IV, prohozené VAPID klíče).

- Admin API: porovnání Bearer tokenu je nově v konstantním čase
  (`timingSafeEqual` nad SHA-256), dříve prosté `!==`.

### Známé mezery (zjištěno při revizi, **neopraveno** — vyžadují rozhodnutí)
- **Rate limit WebSocket upgradu nefunguje.** `app.use("/ws", limiter)` je
  Express middleware, ale upgrade obsluhuje `ws` na události `upgrade` —
  změřeno: 45/45 spojení přijato při limitu 30/min. REST limiter funguje.
- **Chybí `trust proxy`.** Za Nginx (doporučené nasazení) je `req.ip` adresa
  proxy, takže všichni uživatelé sdílejí jeden kbelík 100 požadavků / 15 min.
- **Proxy přenos souborů nedoručuje data.** Server `proxy-meta` / `proxy-chunk`
  jen uloží (zkrácené na 256 znaků) a nikomu nepřepošle; rozesílá pouze
  `proxy-end` / `proxy-cancel`. Bez otevřeného DataChannelu soubor nedorazí.
- **Admin příkazy nepřekročí hranici procesu.** Fronta je Map v paměti admin
  procesu; hlavní služba (jiný proces / kontejner) ji nevidí. Totéž platí pro
  `/admin/clients` a `/admin/logs/recent`.
- **Neautentizované endpointy** hlavní služby: `POST /api/push/test`,
  `GET|POST /api/admin/retention*`; `GET /api/turn` vydává statické TURN údaje.
- **TOFU otisky jsou klíčované podle `peerId`**, které se při každém připojení
  generuje náhodně → každá relace je „první použití"; při neshodě se uložený
  otisk navíc přepíše.
- `connection-keeper.ts` není zapojený; UI uvádí max. backoff 30/15/8 s, běžící
  kód v `App.tsx` má strop 120 s a nemá inactivity timeout.
- CSP obsahuje `script-src unsafe-inline unsafe-eval`.
- Retence se nespouští sama (žádný timer), události nemaže nikdy.

### Záměrně neprovedeno
- **Tailwind 3.4 → 4** (a s ním `tailwind-merge` 3): mění výchozí hodnoty
  (barva borderu, ring, názvy stínů) napříč třemi tématy; bez vizuálních
  regresních testů to nelze ověřit. Tailwind 3.4 je dál udržovaný.

### Otestováno
- `npm run check` čistý · `npm test` 9 souborů / **95 testů** (dříve 65
  spustitelných, z toho 17 padalo) · `npm run check:menu` 8/8 · `npm run build` OK.
- Smoke produkčních bundlů: `/api/health`, statika, hlavičky, WS
  `hello → joined → pong`; admin `401` bez tokenu, `200` s tokenem, `400` pro
  příkaz mimo allowlist.
- V prohlížeči: nativní base64 cesta, round-trip šifrování, Permissions-Policy.
- **Neověřeno:** sestavení Docker image (daemon nebyl k dispozici), Playwright
  e2e (Chromium není nainstalován), reálný hovor mezi dvěma zařízeními.

## [2.4.2] – 2026-07-29

### Opraveno
- `MainMenu` (speed-dial): menuitems se po kliknutí nereagovaly na
  dotykových zařízeních / úzkých viewportech. Capture-phase listener
  `pointerdown` v `SpeedDial` zavíral portálovaný panel dříve, než
  React stihnul doručit `onClick` handlery. Přidán `panelRef` pro
  portálovaný container a do listeneru přidána kontrola
  `panelRef.current?.contains(target)`, takže klik uvnitř portálu
  nechal panel otevřený a forwardoval do Reactu.

### Přidáno
- `.github/workflows/ci.yml` — 4-job pipeline (typecheck, custom
  guard `pre-commit-check.sh`, vitest s `.tsx` soubory, build
  smoke + explicit aggregate gate) pro všechny PR a push na
  master / release / feature větve.
- `vitest.config.ts` — rozšíření `include` o `.tsx` soubory
  (`{ts,tsx}`) a přidání `node_modules/**` do `exclude`.

## [2.4.1] – 2026-07-29

### Přidáno
- Speed-dial panel pro `MainMenu`: integrace `createPortal(...)` z
  `react-dom` pro render plovoucího menu do `document.body`,
  `position: fixed !important` + `z-index: var(--z-menu)` (10000)
  v `index.css`. Tím panel uniká ze stacking-contextu rodičů
  (`.app-shell isolation: isolate`, `.app-header backdrop-filter`,
  `.toolbar overflow: hidden`).
- Nové CSS tokeny v `:root`: `--z-shell`, `--z-header`,
  `--z-menu-toggle`, `--z-menu-overlay`, `--z-menu`.
- Pre-commit guard `scripts/pre-commit-check.sh` — sedm invariant
  + „Known gaps" reminder sekce, brání regresi fixu.
- Vite hook `.githooks/pre-commit` — tenký wrapper na guard.
- Tři nové invariant testy v `test/main-menu.test.tsx`:
  panel v portálu, `--z-menu >= 9999`, `.menu-panel { position: fixed }`.

### Změněno
- `package.json` — přidány skripty `check:menu`,
  `check:menu:verbose`.
- `client/src/components/MainMenu.tsx` — reindent těla panelu
  o +2 mezery pro konzistenci s novou strukturou v portálu.
- `client/src/index.css` — `.menu-panel { contain: layout style }`
  (bez `paint`), `overflow: visible` pro panel.

## [2.1.0-rc.1] – 2026-05-08

Release-hardening kandidát na M5cet 2.1. Zaměřuje se na komentáře, dokumentaci
v češtině, robustnější instalátor a testovací smoke checks. Bez API breaking
změn vůči `2.0.x`.

### Přidáno
- `CHANGELOG.md` (tento soubor) s historií iterací M5cet.
- `INSTALL.md` — rozšířený průvodce instalací, aktualizací, testováním
  a odinstalací pro Linux / Docker / Debian-Ubuntu / generic.
- Rozšíření `install.sh`:
  - `--update` (alias pro upgrade z aktuální installace, vyvolá
    `clone_or_update_repo` a `start_app`),
  - `--test` (alias pro `--doctor`),
  - `--gui` (interaktivní textové menu, vhodné pro správce bez paměti všech flagů),
  - `--version`.
- Modulové hlavičky / JSDoc komentáře pro:
  - `client/src/App.tsx` (popis architektury + JSDoc nad
    `deriveRoomKey` / `encryptEnvelope` / `decryptEnvelope`),
  - `server/index.ts`, `server/routes.ts`, `server/static.ts`,
    `client/src/components/Modal.tsx`, `shared/schema.ts`.
- Plně český `README.md` s Mermaid diagramy (architektura,
  message flow, WebRTC signaling, admin API, install/update/test flow).
- Doplnění `docs/` o `security-model.md`, `troubleshooting.md`,
  `developer-guide.md`, `deployment.md`.

### Změněno
- `package.json` → verze `2.1.0-rc.1`, popis aktualizován na "M5cet …".
- `package-lock.json` synchronizován na `2.1.0-rc.1`.

### Bezpečnost
- Komentář u `deriveRoomKey` upozorňuje, že salt prefix `CipherRoom:v1:` je
  součástí formátu klíče a jeho změna je breaking migrace.
- Komentář u `encryptEnvelope` zdůrazňuje zákaz cachování IV.
- Admin příkazy zůstávají chráněné token autentizací (`ADMIN_API_TOKEN`)
  a allowlist (`ADMIN_COMMAND_ALLOWLIST`). Žádný path k arbitrary remote
  code execution nebyl přidán.

### Otestováno
- `npm ci` — 469 packages, ok.
- `npm run check` — `tsc` čistý, bez chyb.
- `npm run build` — Vite + esbuild, výstup `dist/index.cjs` ~851 kB,
  `dist/admin.cjs` ~796 kB.
- Smoke test hlavní služby: `GET /api/health` → `{ok:true,…}`, `GET /` → 200.
- Smoke test admin služby: `GET /admin/health`, `/admin/metrics` (s/bez tokenu),
  `/admin/clients`, `/admin/modules`, `/admin/commands/audit`,
  `/admin/plugins/debug`, `/admin/logs/recent`, enqueue safe + reject unsafe.
- `bash -n install.sh` — syntaktická kontrola ok.
- `docker compose config -q` — ok (vyžaduje docker, ověřeno v dry-run).

## [2.0.0] – 2025

### Přidáno
- Real-time / admin / media moduly: konekční keeper, push, audio+video volání,
  speech (TTS/STT/revoice), chunked šifrovaný file transfer, admin API + GUI,
  whitelisted klientské příkazy, mapy/lokace, Web NFC, dokumentace
  prohlížečových omezení.
- Interaktivní `install.sh` s plnou Linux/Docker podporou, doctor módem,
  detekcí starých instalací, zálohou `.env` / `data/` / `docker-compose.yml`
  a Nginx konfigurací.
- Rebrand CipherRoom → M5cet, full-screen layout, témata / i18n / TTL /
  privacy panely.

## [1.0.0] – dřívější

- Bezpečný E2E šifrovaný P2P chat na bázi WebRTC DataChannel a WebSocket
  signalingu. Žádná persistence zpráv na serveru.
- Browser-only Firebase WebRTC chat varianta.
- Production hosting konfigurace (DigitalOcean, Railway, Render, Fly.io,
  Nginx + TLS).

[2.7.0]: https://github.com/m5ike/cipherroom-secure-chat/compare/v2.4.2...HEAD
[2.4.2]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.4.2
[2.1.0-rc.1]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.1.0-rc.1
[2.0.0]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.0.0
[1.0.0]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v1.0.0
