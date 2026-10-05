# Kontrola instalace a hostitele — `check.sh` (od 6.12)

`check.sh` v kořeni instalačního adresáře (`/opt/m5cet/check.sh`, u uživatelské
instalace `~/.local/share/m5cet/check.sh`) důkladně zkontroluje instalační
balíček i všechno na stroji, co ovlivňuje běh aplikace: HTTP server před ní,
TLS, firewall, nastavení jádra a síťových protokolů, síť, systém, Docker
a bezpečnostní nastavení samotné aplikace.

**Jen čte.** Nic nemění: nerestartuje službu, nic neinstaluje, nezapisuje mimo
vlastní dočasný adresář (`$TMPDIR/m5check.*`, při skončení se smaže); jediný
soubor, který může zapsat, je ten, který mu předáte přes `--report`.
**Tajemství z `.env` nikdy nevypíše** — jen zda je proměnná nastavená a u
tajemství jejich délku. Adresy (`REDIS_URL`, `DATABASE_URL`, `TURN_SERVER_URL`,
`PUBLIC_BASE_URL` …) vypisuje vždy bez jména a hesla, bez dotazu (`?…`)
a fragmentu: `redis://***@host:6379`; když heslo nejde od hostitele spolehlivě
oddělit (`/`, `?`, `#` nebo `@` v hesle bez %-kódování), jen `redis://***`.
Běžná nastavení (adresy, porty, cesty, režimy — `HOST`, `ADMIN_BIND`,
`TRUST_PROXY`, `NODE_ENV`, `STORAGE_KEY_FILE`, `BACKUP_DIR` …) cituje tam, kde
je výsledek potřebuje. Všechno, co vypíše (text i JSON), je zbavené řídicích
znaků terminálu (ESC sekvence, CR/LF, C1, znaky bidi → `?`) a je to platné
UTF-8 — hodnota z `.env`, jméno souboru ani odpověď služby nemohou přepsat
obrazovku (FAIL vydávaný za PASS). Jak se kontrola chrání, když běží jako
root, viz [Bezpečnost samotné kontroly](#bezpečnost-samotné-kontroly-běh-jako-root).

```bash
sudo /opt/m5cet/check.sh                      # vše (root vidí víc: firewall, nginx -T, klíče, sudoers)
/opt/m5cet/check.sh --only http,firewall      # jen některé sekce
/opt/m5cet/check.sh --quiet                   # jen WARN / FAIL a souhrn
/opt/m5cet/check.sh --json > report.json      # strojově čitelně
/opt/m5cet/check.sh --offline                 # bez čehokoli, co potřebuje internet
```

Bez roota kontrola běží také; co root potřebuje (pravidla firewallu,
`nginx -T`, čtení `.env` s právy `0640 root:m5cet`, sudoers), označí jako
`SKIP — vyžaduje root`.

## Kdy se spouští sama

| Kdy | Co |
|---|---|
| konec `install.sh` | v interaktivním režimu nabídne celou kontrolu („Spustit teď úplnou kontrolu…?"), bezobslužně jen vypíše cestu |
| po každém `update.sh` | `check.sh --quiet --only package,config,runtime` — vypíše WARN / FAIL a souhrn. **Aktualizaci zastaví jen selhání integrity balíčku** (`package.integrity`, `package.signature`, `package.web`, `package.web_signature`): soubory na disku neodpovídají vydání. Nová verze v tu chvíli už běží (kontroly funkčnosti prošly) — `update.sh` skončí chybou s radou prověřit změněné soubory, případně `update.sh --rollback`. Ostatní FAIL aktualizaci nezastaví. `update.sh --no-check` kontrolu vynechá. |
| `install.sh --doctor` | rychlá diagnostika jako dřív; na konci odkáže na `check.sh` |

Před instalací lze `check.sh` spustit i ze staženého zdrojového stromu —
sekce o instalaci (`config`, `runtime`, …) pak hlásí `SKIP — neinstalováno`
a zkontroluje se hostitel (jádro, firewall, síť, systém).

## Volby

| Volba | Význam |
|---|---|
| `--root DIR` | instalační adresář. Výchozí: adresář, kde leží `check.sh` (když v něm je `.m5cet/install.conf`), jinak ukazatel instalátoru (`/etc/m5cet/install-dir`, `~/.config/m5cet/install-dir`), jinak `/opt/m5cet`, jinak adresář skriptu. **Jako root** platí jen `/etc/m5cet/install-dir`, a to jen když patří rootovi a nikdo jiný ho (ani `/etc/m5cet`) nemůže měnit; ukazatel v `~/.config` (pod `sudo -E` je `HOME` uživatele) se ignoruje — jiný strom zadejte `--root` |
| `--only S,…` / `--skip S,…` | sekce: `package config runtime http firewall kernel network system docker security` |
| `--json` | celý výsledek jako JSON na stdout (místo textu) |
| `--report FILE` | navíc zapíše JSON do souboru (tak to dělá `update.sh`) |
| `--quiet`, `-q` | jen řádky WARN / FAIL a souhrn |
| `--no-color` | bez barev (barvy jsou jen na terminálu a bez `NO_COLOR`) |
| `--lang cs\|en` | jazyk hlášek, výchozí `cs` |
| `--offline` | vynechá `npm audit`, odchozí spojení, DNS veřejné domény, sondu TURN a živé TLS |
| `--pubkey FILE` | důvěryhodný veřejný klíč vydání (viz [Podpis](#podepsaná-vydání)) |
| `--sysroot DIR` | čte `/proc`, `/sys`, `/etc` … z `DIR` (testy; totéž `M5CHECK_FAKE_ROOT`) |
| `--version`, `--help` | |

## Výsledky a návratový kód

Každá kontrola vypíše jeden řádek:

| Stav | Význam |
|---|---|
| `PASS` | v pořádku (u informativních řádků jen popis stavu) |
| `WARN` | oslabuje bezpečnost, soukromí nebo pravděpodobně rozbije funkci — opravte, nebo vědomě přijměte |
| `FAIL` | nefunguje, nebo je to bezpečnostní chyba |
| `SKIP` | nelze zkontrolovat (chybí nástroj, není root, offline, netýká se této instalace) — důvod je na řádku |

U WARN / FAIL je pod řádkem `→` s konkrétní opravou. Na konci je souhrn
a počty WARN / FAIL po sekcích.

| Návratový kód | |
|---|---|
| `0` | žádný FAIL (WARN mohou být) |
| `1` | aspoň jeden FAIL |
| `2` | chybné použití (neznámá volba nebo sekce, neexistující `--root`) |

Ukázka (zkráceno):

```
M5cet check.sh 1.0.0 — /opt/m5cet (native/systemd, chat.example.com)

== HTTP server a TLS (http) ==
  PASS  nalezeno: nginx (80/443: nginx nginx)
  PASS  nginx 1.26.3: konfigurace platná
  PASS  ssl_protocols TLSv1.2 TLSv1.3
  PASS  /ws: WebSocket upgrade, HTTP/1.1, timeout 3600s (location /ws)
  WARN  client_max_body_size je malé — nginx odpoví 413: /api/storage(2m<12m) /api/account/vault(2m<8m) …
        → client_max_body_size 12m; (nahrání APK v konzoli: 300m na jeho location)

Souhrn: 87 PASS, 6 WARN, 0 FAIL, 9 SKIP
  config: 0 FAIL / 2 WARN
  http: 0 FAIL / 2 WARN
Žádný FAIL.
```

## JSON

```json
{"tool":"m5cet-check","version":"1.0.0","root":"/opt/m5cet","lang":"cs","host":"chat","time":"2026-10-05T08:00:00Z","exit":0,
"summary":{"pass":87,"warn":6,"fail":0,"skip":9},
"checks":[
{"section":"package","id":"package.integrity","status":"PASS","message":"…","hint":""},
…
]}
```

Každá kontrola má stálé `id` (`sekce.název`, viz tabulky níže), `status`,
`message` a `hint` (oprava, u PASS / SKIP prázdná). Jeden objekt kontroly je
vždy na jednom řádku — `update.sh` ho hledá `grep`em. Výstup je vždy platné
UTF-8 a platný JSON i pro hodnoty, které platné UTF-8 nejsou (neplatné bajty
a řídicí znaky jsou nahrazené `?`).

## Co se kontroluje

### `package` — balíček

| id | Co | WARN / FAIL |
|---|---|---|
| `package.tree` | `package.json` je M5cet | FAIL: instalace bez zdrojáků |
| `package.integrity` | **s `release.json`**: SHA-256 každého souboru, chybějící soubory, soubory navíc; **bez něj v git checkoutu**: `git status` (změněné sledované soubory, nesledované spustitelné; jak git běží, viz [níže](#bezpečnost-samotné-kontroly-běh-jako-root)) | FAIL: změněný / chybějící soubor, navíc spustitelný soubor nebo nativní knihovna (`.node`, `.so`), manifest jiné verze, než je `package.json` (zastaralý), cesta mimo strom (absolutní, `..`, začínající `-`), nečitelný soubor (neověřeno); soubor dostupný jen přes symlinkovaný adresář se počítá jako chybějící; WARN: bez manifestu i gitu; SKIP: git nejde bezpečně spustit (jako root na cizím `.git` bez `runuser` / `setpriv` / `sudo`, `.git` patřící rootovi, který mohou měnit i jiní) |
| `package.extra` | soubory navíc, které nejsou spustitelné | WARN |
| `package.commit` | git HEAD = commit, který nasadil instalátor | WARN |
| `package.signature` | `release.json.sig` (Ed25519) — viz [Podpis](#podepsaná-vydání) | FAIL: neplatný podpis, změněný klíč vydání; WARN: nepodepsáno / jen git |
| `package.web` | servírované soubory `dist/public` proti `dist/public/release-web.json` | FAIL: změněný / chybějící soubor, **navíc servírovaný kód** (`.html .js .mjs .wasm .svg .xml`); WARN: manifest chybí (build starší než 6.12) |
| `package.web_extra` | ostatní soubory navíc | WARN |
| `package.web_signature` | podpis `release-web.json.sig` — stav se hlásí vždy | FAIL: neplatný podpis; WARN: podpis je, ale chybí klíč (`--pubkey`); SKIP: nepodepsáno (build na tomto stroji) |
| `package.build` | `dist/index.cjs`, `sandbox.cjs`, `public/index.html`, `build.json` (`admin.cjs` s adminem) | FAIL: build chybí / je neúplný |
| `package.pyodide` | `dist/node_modules/pyodide` | WARN: funkce v Pythonu nepoběží |
| `package.sqlcipher` | modul `better-sqlite3-multiple-ciphers` se načte a otevře databázi (`sqlite3mc_version()`). Načtení modulu spouští kód ze stromu, proto jako root běží **pod uživatelem služby** (`SERVICE_USER`), jinak pod vlastníkem stromu (`runuser` / `setpriv` / `sudo`) — **nikdy jako root** | FAIL: modul chybí nebo se nenačte (nic se neukládá); SKIP: jako root bez takového uživatele (`SERVICE_USER=root` na stromu roota) nebo bez nástroje k přepnutí |
| `package.npm_ls` | `npm ls --omit=dev --all`, jen když `node_modules` zůstaly (`KEEP_NODE_MODULES=1`); jako root pod uživatelem služby / vlastníkem stromu jako u SQLCipher | WARN; SKIP jako u SQLCipher |
| `package.npm_audit` | `npm audit --omit=dev --package-lock-only` nad **soukromou kopií** `package.json` + `package-lock.json` v dočasném adresáři — `.npmrc` stromu (registr, který by dostal seznam závislostí) ani `node_modules` se nečtou (online; posílá seznam závislostí registru npm) | FAIL: kritická zranitelnost; WARN: vysoká |
| `package.versions` | `package.json` × `install.conf` × `dist/public/build.json` × běžící služba (`/api/health`) | WARN: build z jiných zdrojů, běží starší verze (restart), zdroje změněné mimo `update.sh` |

### `config` — konfigurace

| id | Co | WARN / FAIL |
|---|---|---|
| `config.env` | `.env` existuje; práva a vlastník. **systemd: `0640 root:<skupina služby>`** (aplikace čte `./.env` sama pod uživatelem služby), ostatní: `0600` | FAIL: čitelný / zapisovatelný pro ostatní, zapisovatelný pro skupinu, nečitelný pro službu (start skončí na EACCES); WARN: vlastní ho uživatel služby |
| `config.env_dups`, `config.env_syntax` | proměnná dvakrát, řádky mimo `KEY=VALUE` | WARN |
| `config.node_env` | `NODE_ENV=production` | FAIL: jiná hodnota (vývojový middleware, volná CSP); u systemd i chybějící |
| `config.admin_token` | `ADMIN_API_TOKEN` s `ENABLE_ADMIN=1`: délka a odhad entropie (délka × log2 abecedy, opakující se znaky) | FAIL: prázdný, < 24 znaků, < 96 bitů; WARN: < 32 znaků nebo < 128 bitů |
| `config.admin_bind` | `ADMIN_BIND` (native) jen loopback | FAIL |
| `config.metrics_token` | `METRICS_TOKEN` ≥ 24 znaků | WARN |
| `config.public_url` | `PUBLIC_BASE_URL` je `https://`, hostitel = `DOMAIN` | FAIL: http, chybí s telefonií; WARN: chybí s doménou, jiný hostitel |
| `config.webauthn` | RP ID passkeys (`WEBAUTHN_RP_ID`, jinak hostitel `PUBLIC_BASE_URL`) × `WEBAUTHN_ORIGINS` | FAIL: origin není https nebo nepatří pod RP ID |
| `config.trust_proxy` | `TRUST_PROXY` vůči proxy před aplikací | WARN: `true` (podvržitelné), vypnuto za proxy (jeden limit pro všechny) |
| `config.host` | `HOST` (native): s proxy jen loopback | WARN: aplikace dostupná i mimo proxy |
| `config.telephony` | s `ENABLE_TELEPHONY=1`: podpisové klíče poskytovatelů (`TELNYX_PUBLIC_KEY`, `VONAGE_SIGNATURE_SECRET`, `TWILIO_AUTH_TOKEN`), `TELEPHONY_ALLOW_UNSIGNED` | FAIL |
| `config.telephony_sms` | `VONAGE_ALLOW_UNSIGNED_SMS=1` | WARN |
| `config.room_proof` | `HUB_REQUIRE_ROOM_PROOF=1` (protokol 4, G-09) | WARN dokud je vypnuté — zapněte, až budou všichni klienti 6.12+ |
| `config.sandbox` | `FUNCTIONS_SANDBOX_ISOLATION` | WARN: `none` / `off` / `0` (bez izolace procesu) |
| `config.access_log`, `config.log_events` | `ACCESS_LOG_FULL_IP=1`, `LOG_EVENTS=1` | WARN (soukromí) |
| `config.turn` | `TURN_SECRET` (krátkodobé údaje) × statické `TURN_CREDENTIAL` | WARN: statické (F-28) nebo žádné |
| `config.push` | oba VAPID klíče, `VAPID_SUBJECT` není zástupná hodnota | FAIL / WARN |
| `config.cluster` | `REDIS_URL` s `CLUSTER_SECRET` | WARN: zprávy clusteru nepodepsané |
| `config.storage_key` | `STORAGE_MASTER_KEY` je 32 bajtů hex / base64 | FAIL |
| `config.data_dir` | datový adresář (`DATA_DIR`, u systemd `/var/lib/m5cet`, jinak `<dir>/.m5cet`) má `0700`; relativní cesty z `.env` (`DATA_DIR`, `STORAGE_DIR`, `BACKUP_DIR`, `AI_DATA_DIR`, `*_KEY_FILE`) se berou od kořene instalace, jako je čte aplikace | FAIL: otevřený všem; WARN: skupina |
| `config.keys` | `*.key` v datech (`storage.key`, `audit-signing.key`, …) a soubory z `STORAGE_KEY_FILE` / `FUNCTIONS_ADM_KEY_FILE` / `ANDROID_SIGNING_KEY_FILE` mají `0600` — i když jméno obsahuje mezeru nebo konec řádku (`find -print0`; cesty z `.env` se nedělí ani nerozvíjejí jako vzory) | FAIL |
| `config.world_writable` | nic v instalaci není zapisovatelné pro všechny | FAIL |
| `config.secret_files` | `.env*`, `*.key`, `*.pem`, keystore, Firebase admin JSON, `install.conf` nejsou čitelné pro ostatní | FAIL; jen WARN, když je instalační adresář pro ostatní uzavřený |
| `config.stale_copies` | kopie tajemství vedle `.env` (`.env-bak`, `.env.old`, `*.bak`) | WARN |
| `config.backup_perms` | zálohy instalátoru (`BACKUP_ROOT`, obsahují `.env`) mají `0700` | WARN |

### `runtime` — běh

| id | Co | WARN / FAIL |
|---|---|---|
| `runtime.node` | Node služby (u systemd z `ExecStart`) ≥ 22, sudá řada (LTS) | FAIL < 22 / chybí; WARN lichá řada |
| `runtime.permission` | `node --permission` (sandbox funkcí; na starším 22.x `--experimental-permission`) | FAIL |
| `runtime.service`, `runtime.admin` | systemd: jednotka nahraná, aktivní, zapnutá (`*_enabled`); proces: PID z `.m5cet/run/app.pid` (`admin.pid`) žije **a je to proces aplikace** — `node` s `dist/index.cjs` (`dist/admin.cjs`) v argumentech, pod vlastníkem stromu (nebo rootem — WARN) a, kde to `/proc` / `lsof` ukáže, s pracovním adresářem ve stromu; compose: viz `docker` | FAIL (i zastaralý nebo podvržený soubor pid, který ukazuje na jiný proces — jeho limity ani uživatel se pak nepoužijí); WARN nestartuje po zapnutí / běží jako root |
| `runtime.service_hardening` | `systemctl show`: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `CapabilityBoundingSet` prázdné (nebo jen `cap_net_bind_service`), `RestrictAddressFamilies`, `LimitNOFILE ≥ 65536` | WARN: slabší než od instalátoru (i drop-iny) |
| `runtime.service_user` | `User=` není root | FAIL |
| `runtime.service_mdwe` | `MemoryDenyWriteExecute` **nesmí** být zapnuté (JIT V8) | FAIL |
| `runtime.ports`, `runtime.admin_port` | na `PORT` / `ADMIN_PORT` něco naslouchá, na očekávané adrese (`ss`, na macOS `lsof`) | FAIL nic / admin mimo loopback; WARN port na jiné adrese, než je nastavená |
| `runtime.health`, `runtime.websocket`, `runtime.admin_health` | `GET /api/health`, upgrade `/ws` (101), `GET /admin/health` | FAIL |
| `runtime.logs` | journald / `<dir>/.m5cet/logs/app.log` (velikost, rotace logrotate) | WARN log > 100 MB bez rotace |

Když služba neběží, porty a sondy se přeskočí (`SKIP — služba neběží`).

### `http` — reverzní proxy a TLS

Pozná, co na 80/443 opravdu běží (nginx, Apache, Caddy, Traefik / proxy
v kontejneru). U **nginx** rozebere `nginx -T` (vložené `include` se rozvinou
na místě, kde jsou, takže platí i pro `options-ssl-nginx.conf` od certbotu)
a pro každou cestu najde location tak jako nginx (`=`, nejdelší prefix, `^~`,
regulární výrazy v pořadí) včetně dědění direktiv (`add_header` a
`proxy_set_header` se v location dědí jen celé, nebo vůbec).

| id | Co | WARN / FAIL |
|---|---|---|
| `http.proxy`, `http.listen` | proxy nalezena; s doménou něco naslouchá na 80/443 | FAIL doména bez proxy / nic na 443; WARN aplikace přímo na veřejné adrese bez TLS |
| `http.nginx`, `http.server` | `nginx -t` prochází; blok `server` pro `DOMAIN` (jinak blok s proxy na port aplikace) | FAIL |
| `http.tls` | server `listen 443 ssl` | FAIL |
| `http.tls_protocols`, `http.tls_ciphers` | jen TLSv1.2 / 1.3 (výchozí hodnota podle verze nginx); žádné RC4 / DES / MD5 / NULL / EXPORT | WARN |
| `http.cert`, `http.cert_name`, `http.cert_renew` | soubor `ssl_certificate`: platnost, jméno v SAN, časovač certbotu | FAIL prošlý / jiné jméno; WARN < 14 dnů, bez obnovy |
| `http.ocsp` | `ssl_stapling` jen když certifikát má OCSP (Let's Encrypt OCSP od 2025 nevydává) | WARN |
| `http.redirect` | server na 80 přesměrovává na https (i podoba od certbotu `if ($host = …)`) | WARN chybí / HTTP obslouží aplikaci |
| `http.websocket`, `http.media_tel` | `/ws` (a s telefonií `/media/tel/`): proxy na aplikaci, `proxy_http_version 1.1`, `Upgrade` + `Connection`, `proxy_read_timeout ≥ 3600 s` | FAIL bez upgrade; WARN krátký timeout |
| `http.sse`, `http.sse_gzip` | `/api/functions/…` (SSE běhu funkce): `proxy_buffering off`, gzip bez `text/event-stream` | WARN |
| `http.body_size` | `client_max_body_size` vůči limitům aplikace: `/api/storage` 12 MB, `/api/account/vault` 8 MB, `/api/speech/stt` 10 MB, `/hooks/` 5 MB | WARN (nginx odpoví 413) |
| `http.webhooks` | s telefonií `/wh/` vede na aplikaci | FAIL |
| `http.assetlinks` | `/.well-known/assetlinks.json` vede na aplikaci (passkeys na Androidu; typicky ho blokuje `location ~ /\.`) | WARN |
| `http.headers` | nginx nepřidává hlavičky, které posílá helmet (HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, …) do location s proxy | WARN (dvě hodnoty) |
| `http.server_tokens` | `server_tokens off` | WARN |
| `http.gzip` | `gzip_types` bez už komprimovaných typů (obrázky, zip, video, woff2) | WARN |
| `http.forwarded` | `X-Forwarded-For` a `-Proto` pro aplikaci | WARN (jeden limit pro všechny) |
| `http.ws_limits` | `limit_req` / `limit_conn` na `/ws` | WARN |
| `http.admin_paths` | `/api/admin/` (aplikace), `/admin/` a `/console/` (admin služba) mají `allow` / `deny` | WARN otevřené do internetu |
| `http.tls_live` | `openssl s_client` na `DOMAIN:443`: řetěz, jméno, platnost (online) | FAIL odmítnutý certifikát; WARN < 14 dnů / handshake neproběhl |

U Apache ověří moduly `proxy_http` / `proxy_wstunnel`, u Caddy a Traefiku
jen ohlásí, co ověřit ručně.

### `firewall`

Aktivní firewall (`ufw`, `firewalld`, `nftables`, `iptables`), jen jako root.

| id | Co | WARN / FAIL |
|---|---|---|
| `firewall.active` | nějaký běží | WARN žádný |
| `firewall.policy` | příchozí ve výchozím stavu zakázané | FAIL ufw / firewalld přijímá vše; WARN nftables / iptables bez filtru |
| `firewall.web` | s doménou 80/tcp a 443/tcp otevřené všem | FAIL |
| `firewall.app_port`, `firewall.admin_port` | porty aplikace a adminu naslouchají jen na loopbacku; když ne, propouští je firewall? (bez roota se pravidla neověří, ale veřejná adresa se nahlásí) | FAIL admin veřejně; WARN aplikace vedle proxy / chrání jen firewall |
| `firewall.turn` | s coturn na stroji 3478 udp+tcp, 5349, relay `min-port`–`max-port` z `/etc/turnserver.conf` | WARN |
| `firewall.ssh` | SSH otevřené všem bez `ufw limit` / fail2ban / sshguard / crowdsec | WARN |
| `firewall.docker` | s ufw žádný kontejner nepublikuje na všech rozhraních (Docker ufw obchází) | WARN |

### `kernel` — sysctl

Čte `/proc/sys` (jen Linux). Každá položka: hodnota, a u WARN `sysctl -w …`
s radou uložit ji do `/etc/sysctl.d/90-m5cet.conf`.

`net.ipv4.tcp_syncookies=1`, `net.ipv4.conf.all.rp_filter` (≠ 0),
`accept_redirects=0` (IPv4 i IPv6), `send_redirects=0` (když stroj nesměruje),
`accept_source_route=0`, `icmp_echo_ignore_broadcasts=1`, `log_martians=1`,
`net.core.somaxconn ≥ 1024`, `ip_local_port_range` ≥ 16 384 portů,
`net.core.rmem_max / wmem_max ≥ 2,5 MB` (jen s TURN na stroji),
`fs.file-max ≥ 65536`, `fs.protected_symlinks / hardlinks = 1`,
`kernel.kptr_restrict ≥ 1`, `kernel.dmesg_restrict = 1`,
`kernel.unprivileged_bpf_disabled ≥ 1`, `kernel.yama.ptrace_scope ≥ 1`,
uživatelské jmenné prostory (`user.max_user_namespaces`,
`kernel.unprivileged_userns_clone`; omezení AppArmor na Ubuntu 24.04+ —
`kernel.apparmor_restrict_unprivileged_userns` — rozebírá `system.bwrap`),
`vm.overcommit_memory ≠ 2` (V8 a WebAssembly rezervují velký adresní prostor),
`net.ipv4.ip_forward` (WARN bez kontejnerů / VPN), stav IPv6, transparent
hugepages (WARN `always` s lokálním Redisem), `entropy_avail`.

### `network` — síť

| id | Co | WARN / FAIL |
|---|---|---|
| `network.dns`, `network.dns_here`, `network.ipv6` | `DOMAIN` se překládá; ukazuje na adresu stroje (za NAT `SKIP`); záznam AAAA má na stroji globální IPv6 a naslouchání na `[::]:443` | FAIL nepřekládá se / AAAA bez IPv6; WARN jinam |
| `network.outbound` | HTTPS na registry npm, GitHub, dlaždice OSM, s pushem FCM a Apple, se zapnutými poskytovateli Twilio / Telnyx / Vonage — jen spojení, bez přihlašovacích údajů | WARN |
| `network.time` | `chronyc tracking` (odchylka) / `timedatectl` / timesyncd | FAIL ≥ 30 s (TOTP, podpisy webhooků, časy transparentnosti klíčů); WARN ≥ 1 s / nesynchronizováno |
| `network.mtu` | MTU rozhraní výchozí trasy | FAIL < 1280; WARN < 1400 |
| `network.turn`, `network.coturn` | TCP spojení na každou adresu `TURN_SERVER_URL` (STUN přes `turnutils_stunclient`, je-li), coturn na stroji běží. Položka musí mít tvar `turn:host[:port]` / `turns:host[:port]` (jméno, IPv4 nebo `[IPv6]`, port 1–65535); jiná se nikam nepošle ani nevypíše (jen její pořadí `#N`), `user:heslo@` před hostitelem se zahodí | WARN / FAIL |
| `network.fds`, `network.service_fds` | popisovače souborů systému a služby (`/proc/<pid>/limits`) | WARN ≥ 80 % / limit služby < 65536 |
| `network.ephemeral`, `network.listen_overflows` | sockety v TIME-WAIT vůči efemérním portům; přetečení fronty spojení od startu (`/proc/net/netstat`) | WARN |

### `system` — systém

| id | Co | WARN / FAIL |
|---|---|---|
| `system.os` | distribuce a podpora (Ubuntu LTS 22.04 / 24.04 / 26.04, Debian ≥ 12, RHEL a klony ≥ 8, Fedora ≥ 41, Alpine ≥ 3.21) | WARN mimo podporu / ne-LTS Ubuntu |
| `system.kernel` | jádro ≥ 4.18 (Node 24), doporučeno ≥ 5.10 | FAIL / WARN |
| `system.memory`, `system.memory_free`, `system.swap` | RAM (2 GB s funkcemi / Pyodide / lokální řečí), volná paměť, swap při < 4 GB | FAIL < 900 MB; WARN |
| `system.disk`, `system.inodes` | místo pro instalaci, data, zálohy, `/var/log`, `/tmp` | FAIL < 1 GB nebo < 5 % a < 5 GB; WARN < 10 %; inody ≥ 90 % |
| `system.noexec` | instalace není na oddílu `noexec` (nativní moduly v `dist/node_modules`) | FAIL |
| `system.mac` | AppArmor / SELinux a nedávná zamítnutí pro `node` / `bwrap` | WARN |
| `system.bwrap`, `system.bwrap_netlink` | bubblewrap pro izolaci běhů funkcí: je nainstalovaný; AppArmor ho na Ubuntu 24.04+ nepustí bez profilu s `userns`; jednotka služby nezakazuje jmenné prostory (`RestrictNamespaces`) ani `AF_NETLINK`; zkušební běh jako uživatel služby (jako root bez uživatele jiného než root se nezkouší) | FAIL s `FUNCTIONS_SANDBOX_ISOLATION=bwrap`, jinak WARN |
| `system.speech` | `bzip2` (rozbalení modelů řeči), engine `sherpa-onnx-node` v `dist` při stažených modelech, `ffmpeg` (jinak jen WAV) | WARN |
| `system.redis` | `REDIS_URL` je dosažitelný (TCP na `host:port` z URL; vypisuje se bez hesla) | FAIL: nedosažitelný, nebo URL nemá použitelné `host:port` (znaky `/ ? # @` v hesle je třeba %-kódovat) |
| `system.backups`, `system.app_backups` | zálohy instalátoru (konfigurace + `dist`); zálohy dat aplikace v `BACKUP_DIR` mladší než 2 × `BACKUP_INTERVAL_HOURS` | WARN bez `BACKUP_DIR` / staré; FAIL adresář chybí |
| `system.updates`, `system.reboot` | automatické bezpečnostní aktualizace (unattended-upgrades / dnf-automatic); čeká se na restart | WARN |
| `system.service_user` | uživatel služby bez přihlašovacího shellu, bez sudo/wheel, není v `docker` (= root), nemá řádek v sudoers | FAIL / WARN shell |

### `docker` (jen `INSTALL_MODE=docker`)

`docker.daemon`; `docker.container` (běží, healthcheck); `docker.privileged`
(FAIL); `docker.user` (FAIL root); `docker.hardening` (`read_only`,
`cap_drop: ALL`, `no-new-privileges`); `docker.logs` (`json-file` s
`max-size`); `docker.ports` (FAIL publikováno na všech rozhraních, když
`BIND_ADDRESS` je loopback); `docker.image_env` (FAIL tajné proměnné
v `ENV` image — jen jména); `docker.env_in_image` (FAIL `/app/.env`
v kontejneru); `docker.base_image` (WARN `FROM` bez `@sha256:`);
`docker.dockerignore` (FAIL `.dockerignore` bez `.env*`).

### `security` — souhrn

Jen informativní (`PASS`, chyby už hlásí ostatní sekce): důkaz pro vstup do
místnosti (protokol 4), sandbox funkcí, podpisy webhooků telefonie,
SQLCipher a umístění hlavního klíče úložiště, režim údajů TURN, podpis
vydání, nastavení logů (`LOG_EVENTS`, `ACCESS_LOG`, `ACCESS_LOG_FULL_IP`).

## Bezpečnost samotné kontroly (běh jako root)

`check.sh` se spouští jako root (a `update.sh` ho jako root pouští po každé
aktualizaci), ale strom, který kontroluje, může patřit někomu jinému:
u uživatelské instalace celý uživateli, u systemd je `.env` čitelný
a `dist/` zapisovatelný pro skupinu služby. Nic z toho proto nesmí
rozhodovat o tom, co root spustí (oprava nálezů C01–C12 bezpečnostní
revize 6.12, `docs/review-612.md`):

* **Hodnoty z `.env` nejsou nikdy kód.** `.env` ani `install.conf` se
  nenačítají `source` / `eval`. Hostitel a port z `TURN_SERVER_URL`
  a `REDIS_URL` se ověří (DNS jméno, IPv4 nebo IPv6, port 1–65535) a do
  `/dev/tcp` jdou jako poziční argumenty pevného skriptu
  (`bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ host port`), nikdy jako text
  příkazu; `turnutils_stunclient` dostane hostitele za `--`. Neplatná
  položka se nikam nepošle a nevypíše. `SERVICE_NAME` mimo
  `[A-Za-z0-9_.@-]` se nahradí `m5cet` (nikdy volba pro `systemctl`).
* **Kód ze stromu nikdy jako root.** Zkouška SQLCipher (`require()` modulu
  z `dist/node_modules`) a `npm ls` běží pod uživatelem služby
  (`SERVICE_USER`), jinak pod vlastníkem stromu — nikdy pod rootem ani jiným
  uid 0, jméno musí být obyčejné jméno účtu. Přepíná se `runuser`,
  `setpriv` nebo `sudo -n` s pevnými argumenty (bez shellu). Když takový
  uživatel není (např. `SERVICE_USER=root` na stromu, který patří rootovi)
  nebo chybí nástroj k přepnutí, kontrola je `SKIP` s důvodem — nikdy se
  nespustí jako root.
* **git** nikdy s `-c safe.directory=…` (to vypíná ochranu gitu před cizím
  repozitářem, CVE-2022-24765). Jako root běží pod vlastníkem `.git`; `.git`
  patřící rootovi jen tehdy, když kořen stromu, `.git` ani `.git/config` nemůže
  měnit nikdo jiný (a `.git` je obyčejný adresář). Vždy s `env -i` (čisté
  prostředí, `HOME=/nonexistent`), `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `-c core.fsmonitor=false`,
  `-c core.hooksPath=/dev/null`, `--no-optional-locks`,
  `--ignore-submodules=all` a bez hledání repozitáře nad stromem
  (`GIT_CEILING_DIRECTORIES`). Jinak `SKIP`.
* **npm**: `npm ls` jako výše; `npm audit` běží nad soukromou kopií
  `package.json` + `package-lock.json` v dočasném adresáři
  (`--package-lock-only`) — `.npmrc` stromu (cizí registr, který by dostal
  seznam závislostí; `onload-script` v npm 6) se vůbec nečte.
* **Který strom**: jako root se ukazatel `~/.config/m5cet/install-dir`
  ignoruje a `/etc/m5cet/install-dir` platí, jen když patří rootovi a nikdo
  jiný ho nemůže měnit (viz `--root`).
* **Manifest a soubor pid** nemohou rozšířit, co root čte: cesty
  v `release.json` jen uvnitř stromu, bez symlinků (viz [Manifesty
  vydání](#manifesty-vydání)); PID ze `.m5cet/run/app.pid` se bere jen
  tehdy, když je to opravdu `node dist/index.cjs` vlastníka stromu.
* **Výstup**: tajemství a hesla v URL se nevypisují, řídicí znaky
  terminálu se nahrazují `?`, výstup je platné UTF-8 (viz úvod).

Útočník s rootem na serveru ovšem může změnit i samotný `check.sh` — viz
konec [Podepsaná vydání](#podepsaná-vydání).

## Manifesty vydání

Formát je ve [specifikaci protokolu 4, § 15](protocol-v4.md#15-release-manifests-f-02-installation-check)
(typ `ReleaseManifest`, `client/src/lib/p4/contract.ts`). Nástroj je
`script/release-manifest.ts`; běží přes `npm run …` (tsx) i přímo
`node script/release-manifest.ts …` (Node ≥ 22.18 bez tsx).

| Příkaz | Co dělá |
|---|---|
| `npm run release:manifest` | zapíše `release.json` pro strom (`-- --root DIR --out FILE`, `--with-dist` pro vydání s hotovým `dist/`, `--walk` bez gitu, `--commit SHA`) |
| `npm run release:web-manifest` | znovu zapíše `dist/public/release-web.json`; **`npm run build` ho zapisuje sám** jako poslední krok |
| `npm run release:keygen` | pár Ed25519: soukromý klíč do `~/.m5cet/release-signing.key` (`0600`, adresář `0700`; jinam `-- --out PATH`, nikdy ne do repozitáře — odmítne to), veřejný do `release-signing.pub` a vypíše jeho otisk (SHA-256) |
| `npm run release:sign` | podepíše `release.json` a `dist/public/release-web.json` (co existuje) → `.sig`; odmítne klíč, který nesedí s `release-signing.pub` |
| `npm run release:verify` | ověří strom (`-- --root DIR --manifest FILE --pub FILE --json --require-signature`); návratový kód 0 / 1 / 2 |

**Co `release.json` pokrývá** — přesně to, co instalátor nasazuje ze
zdrojového stromu (git checkout nebo kopie přes rsync / tar,
`installer/lib/deploy.sh`): v git stromu sledované soubory (`git ls-files`),
jinak všechny běžné soubory, v obou případech **bez**:

* adresářů kdekoli: `.git`, `node_modules`, `.gradle`, `.kotlin`, `.idea`, `.vscode`, `__pycache__`;
* adresářů v kořeni: `dist`, `.m5cet`, `.claude`, `.vite`, `.memory`, `coverage`, `data`,
  `admin-ui/public/vendor`, `android/build`, `android/app/build`, `test-results`, `playwright-report`;
* souborů kdekoli: `.env*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`,
  `*firebase-adminsdk*.json`, `serviceAccount*.json`, `*.db*`, `*.sqlite*`, `*.log`,
  `.DS_Store`, `*~`, `.*.swp`, `*.bak`, `local.properties`, `.git`;
* `release.json` a `release.json.sig` samotných.

`dist/` v něm standardně **není**: instalátor ho staví na hostiteli a build
není bajt po bajtu reprodukovatelný (`build.json` nese čas sestavení). Servírované
soubory pokrývá `dist/public/release-web.json`, které zapisuje každý build;
vydání s hotovým `dist/` (tarball, image) použije `--with-dist`. Seznam
výjimek je v `check.sh` (`M5_EXCL_*`) i v nástroji (`EXCLUDE_*`) a test
hlídá, že jsou stejné. Cesty s uvozovkou, zpětným lomítkem nebo řídicím
znakem nástroj odmítne (`check.sh` čte manifest bez parseru JSON: jeden
soubor na řádek). `check.sh` navíc odmítne manifest s cestou absolutní,
s komponentou `..` / `.` nebo prázdnou, či začínající `-` (FAIL — root by
jinak počítal hash souborů mimo strom), a hashuje jen soubory, které ve
stromu opravdu jsou: `find` bez následování symlinků, takže soubor dostupný
jen přes symlinkovaný adresář je „chybí", ne „odpovídá".

**Jak vydání vzniká:** v čistém checkoutu tagu `npm run release:manifest`
→ `npm run release:sign` → `release.json` + `release.json.sig` (a
`release-signing.pub`) jdou do archivu vydání; instalace z něj
(`install.sh --source-path <rozbalený archiv>`) je převezme. Instalace
z gitu (`master`) manifest nemá — `check.sh` pak integritu ověřuje proti
gitu (`git status`, bez zápisu do indexu: `--no-optional-locks`; jak git
běží, viz [Bezpečnost samotné kontroly](#bezpečnost-samotné-kontroly-běh-jako-root)).

### Podepsaná vydání

`release.json.sig` je base64 podpis Ed25519 přesně bajtů `release.json`,
`release-signing.pub` je surový veřejný klíč (32 B) v base64. `check.sh` ho
ověří OpenSSL ≥ 3 (`pkeyutl -rawin`), jinak vlastním vloženým kódem pro
`node` — **nikdy nespouští kód z ověřovaného stromu**.

Klíč, kterému `check.sh` věří: `--pubkey FILE`, jinak kopie **připnutá při
první instalaci** (`<dir>/.m5cet/release-signing.pub`; instalátor ji vytvoří,
když strom klíč obsahuje, a už ji nepřepisuje), jinak `release-signing.pub`
ze stejného stromu — tehdy to `check.sh` řekne a otisk je třeba porovnat
s otiskem zveřejněným vývojářem jinou cestou. Liší-li se klíč stromu od
připnutého a vydání je podepsané, je to **FAIL** (vydání podepsal někdo
jiný). Skutečnou výměnu klíče přijmete tak, že otisk nového klíče ověříte
u vývojáře a nový `release-signing.pub` zkopírujete do `.m5cet/`.

Nepodepsaný manifest odhalí poškození a místní úpravy, podepsaný navíc
balíček, který nepochází od vývojáře. Útočník s rootem na serveru ale může
změnit i `check.sh` — při podezření spusťte ověřenou kopii z archivu
vydání: `bash /cesta/k/overenemu/check.sh --root /opt/m5cet --pubkey …`.

## Dodavatelský řetězec (CI, F-29)

* `npm ci` v CI i v `Dockerfile` nechává audit zapnutý; samostatný job
  `supply-chain` pouští `npm audit --omit=dev --audit-level=high` a cyklus
  `release:manifest` → `release:verify`; build ověří `release-web.json`.
* Job `installer` pouští `check.sh` na skutečnou instalaci a hlídá, že
  `package.web` a `runtime.health` projdou; `shellcheck` kontroluje i `check.sh`.
* `.github/workflows/codeql.yml`: CodeQL pro JavaScript / TypeScript a pro
  Javu aplikace pro Android (`build-mode: none` — bez Gradle, SDK a tajemství),
  sada `security-extended`, při push / PR do `master` a jednou týdně.
* Všechny akce třetích stran jsou připnuté na celé SHA commitu (tag v
  komentáři), kontejner Playwrightu i základní image `Dockerfile` na digest.
* Runtime image nemá `node_modules` vůbec (přísnější než `npm ci --omit=dev`),
  běží jako `node`; `.dockerignore` drží mimo build `.env*` a soukromé klíče.

## Co kontrola neumí

* Firewall poskytovatele cloudu (security groups) a NAT před serverem nevidí.
* UDP dosažitelnost TURN zvenku neověří (jen TCP spojení a lokální STUN).
* Za NAT nemůže porovnat DNS s veřejnou adresou (bez dotazu na cizí službu).
* Traefik / proxy v kontejneru jen detekuje.
* Jako root bez `runuser` / `setpriv` / `sudo` (nebo bez uživatele jiného
  než root) nezkusí SQLCipher, `npm ls` ani `git status` na cizím stromu —
  jsou `SKIP`.
* Hodnoty `FUNCTIONS_SANDBOX_ISOLATION` vyhodnocuje takto: `none`, `off`,
  `0`, `false`, `no` = vypnuto; `bwrap`, `required`, `require`, `on`, `1`,
  `true`, `yes` = vyžadováno (chybějící bubblewrap je FAIL); prázdné nebo
  cokoli jiného = bubblewrap, je-li k dispozici.

## Testy

`test/install-check.test.ts` pouští skutečný `check.sh` proti připraveným
instalacím, „sysrootům" (`--sysroot` / `M5CHECK_FAKE_ROOT`: `/proc`, `/sys`,
`/etc` ze složky) a stub příkazům na `PATH`; nástroje hostitele, které test
nestubuje, skryje `M5CHECK_ABSENT="cmd …"`, `M5CHECK_UID` předstírá uživatele
(jen mění, co se zkouší — skript dál nic nemění). Výstupy `nginx -T`
v `test/fixtures/install-check/` jsou skutečné (nginx 1.31: stránka
z instalátoru po certbotu, `deploy/nginx/m5cet.conf`, stránka z hostingového
panelu). `test/release-manifest.test.ts` testuje nástroj manifestů.
`test/review-612-checksh.test.ts` jsou důkazy nálezů C01–C12 bezpečnostní
revize 6.12 (spouštění hodnot z `.env`, kód a git / npm ze stromu jako root,
hesla v URL, řídicí znaky, neplatné UTF-8, jména souborů s mezerou, ukazatel
v `~/.config`, cesty mimo strom, podvržený soubor pid, nepodepsaný
`release-web.json`): každý test tvrdí bezpečné chování; „root" předstírá
`M5CHECK_UID=0` se stuby `runuser` a každý „útok" jen zakládá značkový
soubor v dočasném adresáři.
