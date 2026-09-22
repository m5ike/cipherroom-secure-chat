# Changelog

Všechny významné změny tohoto projektu jsou dokumentovány v tomto souboru.

Formát vychází z [Keep a Changelog](https://keepachangelog.com/cs/1.1.0/) a
projekt používá [Semantic Versioning](https://semver.org/lang/cs/).

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
