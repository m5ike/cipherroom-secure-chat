# M5cet — instalace, aktualizace, odinstalace

Tři skripty se sdílenou knihovnou `installer/lib/`:

| Skript | K čemu |
|---|---|
| [`install.sh`](install.sh) | zjistí systém, doinstaluje závislosti, provede průvodcem, nainstaluje |
| [`update.sh`](update.sh) | nové zdrojáky, změna parametrů, oprava, návrat k záloze |
| [`uninstall.sh`](uninstall.sh) | odstraní přesně to, co instalace vytvořila |

Všechny volby se ukládají do **`<adresář>/.m5cet/install.conf`**, tajemství do
**`<adresář>/.env`**. `update.sh` a `uninstall.sh` je čtou, takže žádný přepínač
není potřeba opakovat. Skripty běží na bash ≥ 3.2 (tedy i na macOS).

## Rychlý start

```bash
# interaktivně (průvodce), jako root = systémová instalace do /opt/m5cet
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo -E bash -s -- --install
```

```bash
# bezobslužně: kontejnery + Nginx + Let's Encrypt
sudo ./install.sh --non-interactive --mode docker \
  --domain chat.example.com --enable-tls --email admin@example.com
```

```bash
# bez roota, do domovského adresáře (macOS, sdílený hosting, vyzkoušení)
./install.sh --user-scope --mode native --port 5173
```

Při spuštění přes rouru si skript nejdřív naklonuje repozitář a spustí se
z něj; průvodce čte odpovědi z `/dev/tty`, ne z roury. Bez terminálu přejde
sám do bezobslužného režimu.

## Dva režimy nasazení

| | `native` („statická" instalace) | `docker` |
|---|---|---|
| Co se stane | `npm ci` + `npm run build` na hostiteli, spouští se `node dist/index.cjs` | sestaví se image, běží přes `docker compose` |
| Závislosti | Node.js ≥ 22 (doinstaluje 24 LTS), git, curl | Docker Engine + Compose |
| Správce služby | **systemd** (systémová instalace na Linuxu), jinak **proces** s PID souborem (macOS, kontejnery, bez roota) | **compose** |
| Zabezpečení | unit s `NoNewPrivileges`, `ProtectSystem=strict`, prázdnou sadou capabilities, běží pod vlastním uživatelem `m5cet`; kód vlastní root | `read_only`, `cap_drop: ALL`, `no-new-privileges`, uživatel `node`, v image není `node_modules` ani `.env` |
| Po buildu | `node_modules` se smaže (`dist/` je soběstačné); ponechá `KEEP_NODE_MODULES=1` | — |

Režim lze později **přepnout za běhu**: `update.sh --set INSTALL_MODE=docker`.
Nezaměňujte s režimy *Light / Server-enhanced* — to je předvolba v prohlížeči,
viz [`docs/modes.md`](docs/modes.md).

Rozsah: **system** (root; `/opt/m5cet`, systemd, Nginx, firewall, instalace
balíčků) nebo **user** (bez roota; `~/.local/share/m5cet`, bez Nginx a
firewallu, chybějící balíčky jen ohlásí). Na macOS je vždy `user`.

## Co instalátor zjišťuje a instaluje

Výpis „Informace o systému": OS a verze, architektura, jádro, CPU/RAM, volné
místo, init systém, správce balíčků, uživatel, běh v kontejneru / WSL, verze
`git`, `node`, `docker` (+ zda běží daemon), `nginx`, dostupnost TUI nástroje.
Varuje při < 900 MB RAM nebo < 1,5 GB místa.

Doinstaluje jen to, co chybí a co zvolený režim potřebuje:

| Co | Jak |
|---|---|
| `git`, `curl`, `tar`, `ca-certificates` | správce balíčků |
| Node.js 24 | NodeSource (apt, dnf, yum); balíček distribuce (apk, pacman, zypper); Homebrew |
| Docker + Compose | `get.docker.com`; balíčky (pacman, apk). Na macOS jen zkontroluje Docker Desktop |
| `nginx`, `certbot` | jen s doménou / `--enable-tls` |
| `whiptail` | jen s `--ui dialog` |

Nainstalované balíčky si zapamatuje (`DEPS_INSTALLED`) a odinstalace je
**neodstraňuje** — jen je na konci vypíše.

## Průvodce

`--ui auto|text|dialog` — textové otázky, nebo okna `whiptail`/`dialog`
(„GUI"); `auto` zvolí TUI, když je k dispozici terminál i nástroj.
`--lang cs|en` (výchozí podle `LANG`). `--menu` / `--gui` otevře hlavní menu
(instalace, aktualizace, nastavení, oprava, stav, logy, odinstalace).

Ptá se na: režim, adresář, zdroj (git / místní adresář), port, na které adrese
naslouchat, doménu → Nginx → TLS + e-mail, firewall, admin API, Web Push,
logování metadat, TURN server a (u native) ponechání `node_modules`. Každou
hodnotu validuje a při chybě se zeptá znovu; před instalací vypíše souhrn.

Bezobslužně: `-n/--non-interactive`, `-y/--yes`, přepínače níže,
`--set KLÍČ=HODNOTA`, nebo **soubor odpovědí** `--config cesta/install.conf`
(stačí uložený `install.conf` z jiného stroje; přebírají se volby, ne stav).
Priorita: přepínače a prostředí > `--config` > výchozí hodnoty.
`--dry-run` jen vypíše, co by se stalo.

## Parametry

Úplný seznam s výchozími hodnotami: `./install.sh --list-params`.

| Volba instalátoru (`install.conf`) | Výchozí | Přepínač |
|---|---|---|
| `INSTALL_MODE` | `docker` | `--mode native\|docker` |
| `SCOPE` | `system` (root) / `user` | `--system-scope`, `--user-scope` |
| `INSTALL_DIR` | `/opt/m5cet` / `~/.local/share/m5cet` | `--dir` |
| `SERVICE_NAME`, `SERVICE_USER` | `m5cet` | `--set` |
| `SERVICE_MANAGER` | `auto` → `systemd` / `process` / `compose` | `--set` |
| `SOURCE`, `REPO_URL`, `BRANCH`, `SOURCE_PATH` | `git`, repozitář projektu, `master` | `--source`, `--repo`, `--branch`, `--source-path` |
| `APP_PORT`, `BIND_ADDRESS` | `5000`, `127.0.0.1` | `--port`, `--bind` |
| `DOMAIN`, `ENABLE_NGINX`, `ENABLE_TLS`, `ACME_EMAIL` | prázdné, `auto`, `0`, prázdné | `--domain`, `--enable-nginx`, `--disable-nginx`, `--enable-tls`, `--email` |
| `FIREWALL_OPEN` | `0` | `--open-firewall` |
| `ENABLE_ADMIN`, `ADMIN_PORT` | `0`, `5050` | `--enable-admin` |
| `ENABLE_PUSH` | `0` | `--enable-push` |
| `KEEP_NODE_MODULES` | `0` | `--set` |
| `BACKUP_ROOT`, `BACKUP_KEEP` | `/var/backups/m5cet` / `<dir>/.m5cet/backups`, `5` | `--set` |

| Prostředí aplikace (`.env`) | Poznámka |
|---|---|
| `LOG_EVENTS`, `DATABASE_URL` | metadata; DB backend je zatím stub |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | pár se vygeneruje s `ENABLE_PUSH=1` |
| `TURN_SERVER_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | TURN relay |
| `ADMIN_API_TOKEN` | vygeneruje se (64 hex) s `ENABLE_ADMIN=1`; min. 24 znaků |
| `*_RETENTION_DAYS` | retenční politika |

`NODE_ENV`, `HOST`, `PORT`, `ENABLE_ADMIN`, `ADMIN_PORT`, `ADMIN_BIND` se do `.env`
odvozují z voleb výše při každém zápisu. **Řádky, které do `.env` přidáte
ručně, se při přepisu zachovají.**

## Kam se co ukládá

```
<INSTALL_DIR>/
├── .m5cet/
│   ├── install.conf          volby + stav (verze, commit, časy, cesty)   0600
│   ├── docker-compose.yml    jen režim docker; generovaný, bez tajemství
│   ├── backups/<čas>-<akce>/ zálohy (pokud není BACKUP_ROOT jinde)       0700
│   └── run/, logs/           jen správce „process"
├── .env                      prostředí aplikace vč. tajemství            0600 (0640 root:m5cet u systemd)
├── dist/                     sestavená aplikace
└── install.sh, update.sh, uninstall.sh, installer/, …  (zdrojáky)
```

Ukazatel na instalaci: `/etc/m5cet/install-dir` (root) nebo
`~/.config/m5cet/install-dir` — díky němu `update.sh`/`uninstall.sh` najdou
instalaci i bez `--dir`.

Ani jeden soubor se nikdy nenačítá přes `source`: oba se parsují řádek po
řádku proti seznamu povolených klíčů, takže pozměněná konfigurace nemůže
spustit kód pod rootem. Tajemství se **nezapisují do compose souboru**
(kontejnery je dostávají přes `env_file`) a nevypisují se ani v chybových
hláškách.

## Reverzní proxy, TLS, firewall

S doménou (systémová instalace) vygeneruje web pro Nginx — do
`sites-available` + symlink, jinak `http.d/` nebo `conf.d/` — a ověří
`nginx -t`; **když test neprojde, konfiguraci vrátí** a instalaci ukončí, aby
nerozbil váš webserver. Cizí (nespravovaný) soubor nepřepíše bez dotazu.

Web omezuje WebSocket spojení podle adresy klienta (`limit_req` 30/min,
burst 20; `limit_conn` 20). Je to potřeba: limiter uvnitř aplikace se při WS
upgradu nespouští. Změřeno — 60 souběžných upgradů: **20 × 101 a 40 × 503
přes proxy**, 60 × 101 přímo na aplikaci.

`--enable-tls` zavolá `certbot --nginx`. `--open-firewall` otevře porty
v `ufw`/`firewalld` a zapamatuje si je; odinstalace zavře port aplikace
(80/443 nechává — mohou sloužit jiným webům). WebRTC mimo `localhost` vyžaduje
HTTPS.

## Aktualizace — `update.sh`

```bash
/opt/m5cet/update.sh                          # nové zdrojáky + rebuild + restart
/opt/m5cet/update.sh --check                  # je co aktualizovat? (exit 0 = ano, 1 = ne, 2 = nelze zjistit)
/opt/m5cet/update.sh --set APP_PORT=8080 --set LOG_EVENTS=1
/opt/m5cet/update.sh --config-only --set ENABLE_PUSH=1   # jen nastavení, bez stahování a bez rebuildu
/opt/m5cet/update.sh --branch master          # přepnutí sledované větve
/opt/m5cet/update.sh --set INSTALL_MODE=native   # přepnutí docker ↔ native
/opt/m5cet/update.sh --reconfigure            # projít nastavení průvodcem
/opt/m5cet/update.sh --repair                 # oprava rozbité instalace
/opt/m5cet/update.sh --rollback               # návrat k poslední záloze
/opt/m5cet/update.sh --show                   # uložená konfigurace (tajemství skrytá)
```

Každý běh nejdřív **zálohuje** `install.conf`, `.env`, compose, web Nginx,
unit soubory, commit a u native i `dist/` (≈ 2,5 MB). Po nasazení spustí
kontroly funkčnosti; **když selžou, vrátí předchozí stav sám** a skončí
s chybou (`--no-rollback` to vypne). Starší zálohy maže nad `BACKUP_KEEP`.

`--repair`: doinstaluje chybějící závislosti, opraví práva, zahodí místní
úpravy sledovaných souborů, smaže `node_modules` a `dist/`, znovu vygeneruje
unit / compose / Nginx a čistě přestaví. `INSTALL_DIR` a `SCOPE` aktualizací
změnit nejdou.

## Odinstalace — `uninstall.sh`

```bash
/opt/m5cet/uninstall.sh               # služba + soubory; závěrečná záloha nastavení zůstane
/opt/m5cet/uninstall.sh --keep-files  # jen služba, adresář zůstane
/opt/m5cet/uninstall.sh --purge       # navíc zálohy, uživatel služby a docker image
```

Výchozí odpověď na potvrzení je **ne**; bezobslužně je nutné `--yes`. Maže
se jen adresář nesoucí značku `.m5cet/install.conf`, nikdy `/`, `$HOME` ani
systémová cesta. Bez `--purge` uloží `install.conf` + `.env` stranou — novou
instalaci z nich spustíte přes `install.sh --config …`. Certifikát nemaže
(`certbot delete --cert-name <doména>`).

## Správa a diagnostika

```bash
/opt/m5cet/install.sh --status | --logs | --start | --stop | --restart
/opt/m5cet/install.sh --doctor        # jen čtení: systém, práva .env, build, sondy, dostupnost aktualizace
```

Kontroly funkčnosti: `GET /api/health`, `/api/modules`, `/`, WebSocket
handshake `/ws`, s admin API `/admin/health` a `401` bez tokenu, s push
`enabled: true`.

## Přechod ze starého instalátoru (< 3.0)

Starou instalaci (checkout přímo v adresáři, generovaný `docker-compose.yml`
v kořeni) `install.sh` pozná, převezme hodnoty z jejího `.env`, zastaví starý
compose projekt a povýší ji na místě. Původní přepínače `--status`, `--logs`,
`--restart`, `--update`, `--uninstall`, `--doctor`/`--test`, `--gui` fungují
dál. Výchozí větev je nově **`master`** (dřív zastaralá feature větev) — kdo
chce jinou, zadá `--branch`.

## Co je ověřeno

Ověřeno spuštěním: macOS / bash 3.2 (native, user) — instalace, `--set`,
neúspěšná aktualizace → automatický návrat, `--config-only`, `--doctor` +
`--repair` na úmyslně rozbité instalaci, všechny varianty odinstalace; **Docker**
— skutečný build a běh, zabezpečení kontejneru, změna nastavení bez rebuildu,
přepnutí režimu oběma směry, `--purge`; **čistý `debian:12` jako root** —
závislosti přes apt + NodeSource, Nginx proxy vč. limitu WS,
`systemd-analyze verify` unit souboru (bezpečnostní skóre 3.9 OK), průvodce
`whiptail` přes pseudo-terminál, bootstrap přes rouru a zdroj z gitu;
`shellcheck` čistý. CI pouští `shellcheck` a cyklus instalace → aktualizace →
odinstalace.

**Neověřeno:** běh unit souboru pod skutečným systemd, `certbot`/TLS, `ufw`
a `firewalld`, větve dnf / yum / pacman / zypper / apk.
