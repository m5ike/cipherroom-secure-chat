# M5cet — build & deploy

## Production build (minified)

Požadavek: **Node.js ≥ 22** (CI a Docker používají 24 LTS).

```
npm ci
npm run build          # Vite (klient) + esbuild (dist/index.cjs, dist/admin.cjs), souběžně
NODE_ENV=production npm start
```

Vite 8 produkuje minifikované JS+CSS do `dist/public` (minifikátor oxc).
`script/build.ts` staví oba server bundly jedním voláním esbuild
(`minify: true`, `target: node22`). Bundly obsahují všechny serverové
závislosti (`express`, `ws`, `helmet`, `express-rate-limit`, `web-push`),
takže **`dist/` běží i bez `node_modules`** — runtime stage v `Dockerfile`
je proto nekopíruje.

Orientační velikosti (2.5.0): JS 495 kB (gzip 153 kB), CSS 39,7 kB
(gzip 8,6 kB), `index.cjs` 1 017 kB, `admin.cjs` 905 kB.

## Dev

```
npm run dev            # tsx server/index.ts s vite middleware na /
PORT=5173 npm run dev  # macOS: port 5000 drží AirPlay Receiver
```

## Sanity checks

- `npm run check` — `tsc --noEmit`
- `npm test` — vitest (10 souborů / 106 testů)
- `npm run test:e2e` — Playwright, 10 testů (UI smoke + dva peeři)
- `npm run check:menu` — guard invariantů MainMenu
- `bash -n install.sh` — syntax-only validace instalátoru
- `npm run build` — kompletní build

## PWA

`client/public/manifest.webmanifest` se servíruje statickým middleware. Service worker
`client/public/sw.js` se registruje automaticky pouze v `Server-enhanced` módu (kvůli
Web Push). Ikony jsou SVG (`icon-192.svg`, `icon-512.svg`, `icon-maskable.svg`).

Safe-area inset třídy (`safe-px`, `safe-pt`, `safe-pb`) v `index.css` nastavují
horní/spodní odsazení pro iOS notch a Android gesture bar.

## Env vars

`.env` v pracovním adresáři načítá `server/env.ts` vestavěným
`process.loadEnvFile()`. Chybějící soubor je v pořádku (kontejnery);
proměnné ze skutečného prostředí mají přednost. `.env` je v `.dockerignore`
— do image se tajemství dostávají výhradně přes prostředí kontejneru.

| Name                       | Effect                                                |
|----------------------------|-------------------------------------------------------|
| `PORT`                     | Default `5000`.                                       |
| `NODE_ENV`                 | `production` aktivuje `serveStatic`.                 |
| `VAPID_PUBLIC_KEY`         | Spolu s privátním klíčem zapne push (`/api/push/*`). |
| `VAPID_PRIVATE_KEY`        | Privátní klíč pro VAPID.                             |
| `LOG_EVENTS=1`             | Zapne `eventStore` (memory nebo `DATABASE_URL`).      |
| `DATABASE_URL`             | SQLite/Postgres pro events.                          |
| `VITE_SIGNALING_URL`       | Externí WSS pro signaling (split deploy).            |
| `PRESENCE_MAX_AWAY_DAYS`   | 6.7: dny, po které zůstane v místnosti člen bez spojení (7; `0` = navždy). |
| `ACCOUNTS_MAX`             | 6.7: strop účtů (5000).                              |
| `STORAGE_SESSION_BUDGET_MB`| 6.7: rozpočet anonymních databází relací (2048).     |
| `FUNCTIONS_NFC_RUN_HOURS`  | 6.7: retence běhů funkcí, které četly kartu (24 h).  |
| `FUNCTIONS_DNS_TIMEOUT_MS` | 6.11: limit jednoho `m5.dns.resolve` (4000; 250–15000). |
| `FUNCTIONS_DNS_SERVERS`    | 6.11: jmenné servery funkcí („1.1.1.1, 8.8.8.8:53“; jinak systémové). |
| `FUNCTIONS_SSE_PING_MS`    | 6.11: udržovací `: ping` streamu běhu (15000).       |
| `FUNCTIONS_WAIT_NOTICE_MS` | 6.11: po kolika ms čekání na hostitele běh ohlásí `progress` „Waiting for …“ (10000). |
| `FUNCTIONS_WAIT_EVERY_MS`  | 6.11: nejdelší ticho, než přijde další ohlášení (10000). |
| `FUNCTIONS_SANDBOX_ISOLATION` | 6.12: izolace sandboxů funkcí — `auto` (výchozí: bubblewrap, když je nainstalovaný a projde autotestem, jinak jen permission model Node s varováním v přehledu konzole), `bwrap` (povinně; bez něj se žádná funkce nespustí), `none` (jen permission model). |
| `FUNCTIONS_SANDBOX_BWRAP`  | 6.12: cesta k `bwrap` (jinak `PATH`, `/usr/bin`, `/usr/local/bin`, `/bin`). |
| `FUNCTIONS_SANDBOX_BWRAP_BINDS` | 6.12: další cesty jen pro čtení uvnitř bwrap, oddělené čárkou (Node nebo knihovny mimo `/lib*`, `/usr/lib*`, např. `/nix/store`). |
| `FUNCTIONS_SANDBOX_MAX`    | 6.12: kolik sandboxů běží najednou (výchozí 2 × počet CPU, aspoň 4). |
| `FUNCTIONS_SANDBOX_QUEUE`  | 6.12: kolik běhů smí čekat na volný sandbox (výchozí 4 × `FUNCTIONS_SANDBOX_MAX`; `0` = nikdo nečeká); další dostanou chybu `Busy`. |
| `FUNCTIONS_SANDBOX_QUEUE_MS` | 6.12: jak dlouho běh na sandbox čeká (30000), pak `Busy`. |
| `SERVICE_DB_PLAIN_BACKUP`  | 6.12: `1` = při převodu nešifrované `functions.db` / `telephony.db` na SQLCipher ponechat kopii `*.plain-backup` (jinak se nešifrovaný soubor po ověření kopie přepíše nulami a smaže). Kopii po ověření upgradu smažte. |
| `ACCESS_LOG_FULL_IP`       | 6.12: `1` = access log ukládá celé IP adresy; jinak jen síť (IPv4 /24, IPv6 /48). |
| `ACCESS_LOG_DAYS`          | Retence access logu ve dnech — od 6.12 výchozí **14** (dřív 30). |
| `WEBAUTHN_ALLOW_SUBDOMAINS`| 6.12: `1` = passkey přijme každou https subdoménu rpId (chování před 6.12). Jinak bez `WEBAUTHN_ORIGINS` jen přesný origin `PUBLIC_BASE_URL` (bez něj `https://<rpId>`); originy aplikace pro Android beze změny. |
| `TURN_REQUIRE_HUB`         | 6.12: `0` = `/api/turn` vydá TURN přihlašovací údaje komukoli (chování před 6.12). Výchozí `1`: jen adrese, která má spojení s hubem (WebSocket) **připojené do místnosti** (samotný otevřený `/ws` nestačí); IPv6 se porovnává podle /64. Ostatní dostanou jen STUN s `pending: true`. Nastavte `0` v clusteru, kde HTTP a WebSocket jednoho klienta mohou skončit na různých instancích. |
| `TURN_RATE_LIMIT`          | 6.12: požadavků na `/api/turn` z jedné adresy za 10 minut (60). |
| `SHARE_MAX_PER_IP`         | 6.12: živých pozvánek z jedné adresy (50; celkově dál 2000). IPv6 adresa se počítá podle své /64. |
| `FILE_PROXY_MAX_PER_IP`    | 6.12: souběžných přenosů přes serverovou proxy z jedné adresy (16; celkově dál 64). IPv6 adresa se počítá podle své /64. |
| `SPEECH_MODEL_PINS`        | 6.12: připnuté SHA-256 archivů offline řečových modelů, `id=sha256,id=sha256` (např. `whisper-small=<hex>`), nebo připnuté **nainstalované soubory** `id=files:<sha256>` (digest všech souborů modelu; server ho vypíše do logu, když model odmítne). Bez pinu platí hash z prvního stažení (`speech-models/manifest.json`, s HMAC master klíčem); soubory se ověřují při každém načtení. Modely nainstalované verzí 6.11 se při **prvním startu 6.12** jednou zaznamenají tak, jak jsou (důvěra při prvním použití, zapsáno do auditu jako `speech.integrity-initialised`) a fungují dál bez zásahu; značka `speech-integrity-*.marker` v adresáři úložiště (mimo složku modelů) pak tento krok vypne. Model, jehož soubory manifest později nezná (smazaný manifest), se nenačte, dokud ho vlastník neschválí v konzoli (AI a řeč › Offline řeč › „Trust installed files“) nebo nepřipne `files:`; stahování se při chybějícím manifestu a nainstalovaných modelech bez pinu odmítne. |
| `HUB_ROOM_REGISTRATIONS_PER_HOUR` | 6.12: kolik nových ověřovacích klíčů místností smí jedna adresa (IPv6 /64) zaregistrovat za hodinu (20; 1–100 000). Důkaz nad limit projde jako neprokázaný člen a nic neregistruje (s `HUB_REQUIRE_ROOM_PROOF=1` je odmítnut). |
| `KT_ACCOUNT_ENTRIES_PER_DAY` | 6.12: kolik záznamů smí jeden účet přidat do transparentnosti klíčů za 24 h nahráváním klíčů (40; 5–10 000); další `PUT /api/keys/bundle`, který by něco zapsal, dostane `429 kt-quota`. |
| `VONAGE_ALLOW_UNSIGNED_SMS`| 6.7: `1` = přijmout Vonage SMS bez podpisu.          |
| `ANDROID_DESIGN_IMAGE_HOSTS`| 6.7: povolení hostitelé obrázků v designu Androidu (výchozí žádný). |
| `APNS_KEY_FILE`            | 6.14: cesta k `.p8` klíči APNs (Apple Developer › Keys, „Apple Push Notifications service“; PKCS#8, EC P-256). Soubor 0600, mimo repozitář; v Dockeru připojte jako volume. Bez něj iOS zařízení push nedostávají a jen se hlásí (check-in). |
| `APNS_KEY_ID`              | 6.14: 10znakové ID toho klíče (`kid` JWT). |
| `APNS_TEAM_ID`             | 6.14: 10znakové ID týmu (vydavatel JWT); zároveň zveřejní `/.well-known/apple-app-site-association` (passkeys aplikace iOS). |
| `APNS_TOPIC`               | 6.14: bundle ID aplikace (výchozí `cz.m5cet.app`); VoIP push jde na `<topic>.voip`. Konzole (iOS › Push) ho může přepsat. |
| `APNS_ENV`                 | 6.14: `production` (výchozí) nebo `sandbox`; zařízení, které hlásí vlastní prostředí (vývojový build = sandbox), dostává push tam. |
| `IOS_DATA_DIR`             | 6.14: složka dat iOS (`$DATA_DIR/ios`: `ios.db`, `ios.json`, `design.json`, `builds/`). |
| `IOS_EVENT_DAYS`           | 6.14: retence událostí zařízení iOS ve dnech (180; min. 7). |
| `NOTIFY_DIR`               | 6.7: nastavení upozornění (`$DATA_DIR/notify`).      |
| `HUB_REQUIRE_ROOM_PROOF`   | 6.12: `1` = místnost se slepým ID (`r3.…`) přijme jen člena, který doloží znalost klíče místnosti (důkaz při `join`, G-09); klienti před 6.12 dostanou `room-proof-required`. Místnosti s čitelným jménem (protokol 2) důkaz podat nemohou a zůstávají „starší“. Bez `1` (výchozí): join bez důkazu projde a člen je označen `proven: false`; zvuk telefonu do místnosti, hovor nabídnutý místnosti, cíl podle jména či peer id, oznámení konzole podle jména a adresář klíčů přes hub dostanou jen prokázaní členové, jakmile má místnost ověřovací klíč (i když jsou všichni prokázaní členové pryč; jinak všichni jako dřív). Chyba `room-proof` nese `legacyAllowed` (zda by prošel join bez důkazu). |
| `HUB_ROOM_PROOF_TTL_DAYS`  | 6.12: dny, po kterých server zapomene ověřovací klíč místnosti, kterou nikdo s důkazem nenavštívil (365; 1–3650). Ověřovače jsou v globální SQLite (sdílené instancemi clusteru), bez úložiště jen v paměti instance. |
| `KEYS_MAX_DEVICES`         | 6.12: nejvýše zařízení jednoho účtu v adresáři klíčů (`PUT /api/keys/bundle`; 10; 1–50). Odhlášení zařízení ho z adresáře odebere (záznam `rev` v transparentnosti klíčů). |

**6.12 — data služeb v klidu a izolace.** `functions.db` a `telephony.db` jsou od 6.12
SQLCipher databáze; klíč se odvozuje z master klíče úložiště (`STORAGE_MASTER_KEY` /
`storage.key`, pro každou databázi jiný HKDF štítek), takže hlavní i administrátorská
služba musí mít tentýž master klíč. Nešifrovaný soubor z 6.11 se při prvním startu
převede (zámek `*.migrate-lock` s pid, hostitelem a tokenem procesu — zastaralý zámek
po restartu kontejneru se převezme hned; po dobu kopie drží převádějící proces zápisový
zámek databáze; nešifrované WAL/journal soubory se před smazáním přepíší nulami; ověření
`integrity_check` a počtů řádků) — obě služby restartujte zároveň a staré procesy 6.11
předtím zastavte. Bez master klíče zůstane databáze nešifrovaná a přehled konzole
(Overview › Health) to hlásí. Tamtéž je vidět, zda sandboxy funkcí běží v bubblewrap
(`apt install bubblewrap`, verze ≥ 0.3 — sandbox běží s `--cap-drop ALL`; v Dockeru a na
Ubuntu s omezenými user namespaces autotest selže — zkouší se dvakrát — a server použije
jen permission model). Hashe místností v logu jsou HMAC klíčem odvozeným z master klíče;
auditní deník podepisuje kontrolní body klíčem odvozeným z master klíče a starší klíč
připne do `audit-signing.pin` (soubor `audit-signing.key` se při prvním startu 6.12
odstraní). Upgrade z 6.11 nevyžaduje žádný zásah: první start 6.12 vezme deník tak, jak je
(důvěra při prvním použití, v logu) — včetně kontrolních bodů dřívějších klíčů 6.11 a řádků
za posledním z nich. Smazaný `audit-signing.pin` se poté už sám znovu nevytvoří: ověření
deníku hlásí `pin-missing`, dokud soubor neobnovíte ze zálohy nebo vlastník deník znovu
nepřipne (konzole › Audit › Verify › „Re-pin the journal“, `POST /api/admin/audit/repin`).
Od 6.12 musí mít každý úsek 510 řádků deníku platný kontrolní bod (`checkpoint-missing` —
smazané kontrolní body nezakryje ani pozdější podpis konce deníku).

Úplný seznam proměnných je v [dokumentaci › Nasazení](site/index.html#promenne),
změny 6.7 v [`deployment.md`](deployment.md#přechod-na-67). `.dockerignore`
od 6.7 vynechává `.env*` (kromě `.env.example`) a zálohy `*.bak`; vývojový
server je navíc nepouští (`vite.config.ts`, `fs.deny`).
