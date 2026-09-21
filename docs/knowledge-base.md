# M5cet (CipherRoom) — znalostní báze

Rychlá a **ověřená** mapa projektu pro vývojáře, operátory i AI asistenty.
Stav k verzi 2.5.0 (2026-09-21).

> **Jak tento dokument číst.** Každé tvrzení bylo ověřeno proti kódu nebo
> spuštěním. Záměrně zde **nejsou ukázky implementace** — zdrojem pravdy je
> kód na uvedených cestách, ne tento text. Předchozí verze souboru obsahovala
> smyšlené ukázky (odvození klíče jedním SHA-256 bez PBKDF2, opakované IV pro
> všechny chunky souboru, prohozené VAPID klíče) a byla proto nahrazena.
> Když se dokument a kód rozcházejí, platí kód — a dokument se má opravit.

## 1. Co to je

End-to-end šifrovaný workspace v prohlížeči: text, soubory, audio/video,
poloha, NFC, TTS/STT. Peeři spolu mluví přímo přes WebRTC; server je
signalizační relé (WebSocket `/ws`) a nic neukládá na disk.

- Balíček `cipherroom-secure-chat`, značka **M5cet** (rebrand CipherRoom).
- Node ≥ 22 (CI/Docker 24 LTS) · React 19 · Vite 8 · TypeScript 7 · Express 5
  · ws 8 · Tailwind 3.4 · Vitest 5. Runtime závislostí je 8.
- `browser-only-firebase/` je samostatná statická varianta bez buildu;
  s hlavní aplikací nesdílí kód.

## 2. Mapa kódu

| Oblast | Soubor | Poznámka |
|---|---|---|
| Orchestrace klienta | `client/src/App.tsx` (~2 600 ř.) | signaling socket, mesh `RTCPeerConnection`, zprávy, TTL, panely. **Bez testů.** |
| Šifrování | `client/src/lib/crypto.ts` | `deriveRoomKey`, `encryptEnvelope`, `decryptEnvelope`, `toBase64`/`fromBase64`, typ `Bytes` |
| Přenos souborů | `client/src/lib/file-transfer.ts` | chunky, backpressure, P2P/proxy rámce |
| ICE / TURN | `client/src/lib/rtc.ts` | `RTC_CONFIG`, `loadTurnConfig()` → `GET /api/turn` |
| Otisky peerů | `client/src/lib/fingerprint.ts` | DTLS otisk z `getStats()`, localStorage |
| Session cache | `client/src/lib/session-cache.ts` | šifrovaná, po kartách, 1 h nečinnosti; požadovaný stav |
| Pozvánky | `client/src/lib/share-link.ts`, `components/SharePanel.tsx`, `server/share.ts` | split-key + 12místný kód, limity na serveru |
| Úplné smazání | `client/src/lib/wipe.ts` + `GET /goodbye` | `Clear-Site-Data`; historii smazat nelze |
| Preference | `client/src/lib/preferences.ts` | klíč `m5cet:prefs:v2`, migrace z `cipherroom:prefs:v1` |
| Admin příkazy (klient) | `client/src/lib/admin-commands.ts` | allowlist + validace |
| Plugin API | `client/src/lib/cipherroom-api.ts` | `window.CipherRoomAPI` — jen registry a event bus |
| Keeper (knihovna) | `client/src/lib/connection-keeper.ts` | **nezapojeno** — viz §6 |
| Menu | `client/src/components/MainMenu.tsx` | speed-dial přes `createPortal`; hlídá pre-commit guard |
| Server vstup | `server/index.ts` | Helmet/CSP, hlavičky, REST limiter, `listen` |
| Signalizace + REST | `server/routes.ts` | `/ws`, `/api/*` |
| Relay souborů | `server/file-proxy.ts` | **nedokončeno** — viz §6 |
| Admin služba | `server/admin.ts` | samostatný proces `dist/admin.cjs` |
| Sdílený stav adminu | `server/routes-admin-shared.ts` | allowlist, fronta, push subskripce (Mapy v paměti) |
| Event log | `server/events.ts` | ring 500 záznamů; DB backend je no-op |
| Retence | `server/retention.ts` | politika z env; spouští se jen ručně |
| Env | `server/env.ts` | `process.loadEnvFile()`; musí být 1. import |
| Build | `script/build.ts` | Vite + esbuild souběžně |
| Guard | `scripts/pre-commit-check.sh` | 8 kontrol invariantů MainMenu |

## 3. Kryptografie (ověřeno testy `test/crypto.test.ts`)

- **Klíč místnosti:** PBKDF2-SHA-256, **250 000 iterací**, sůl
  `CipherRoom:v1:<room>`, výstup AES-GCM 256, `extractable: false`.
  Odvozuje se **jednou za join**, drží se v `keyRef`; necachuje se.
- **Obálka:** přesně `{ iv, ciphertext }`, obojí standardní base64. IV je
  **12 náhodných bajtů na každé volání** (`crypto.getRandomValues`). GCM tag
  (16 B) je součástí ciphertextu. Nic dalšího v obálce být nesmí.
- **Soubory:** každý chunk i metadata se šifrují stejným klíčem místnosti,
  každý s vlastním čerstvým IV (`encryptBytes` / `encryptJSON`).
- **NFC:** vlastní schéma — PIN 4–16 číslic, PBKDF2 × 200 000, sůl 16 B + IV
  12 B na tag, prefix `m5cet:nfc:v1:`. S klíčem místnosti nesouvisí.
- **Média:** DTLS-SRTP, řeší prohlížeč.
- **VAPID:** *privátní* klíč zůstává na **serveru**; klient dostává jen
  *veřejný* klíč přes `GET /api/push/status`.
- Změna prefixu soli nebo tvaru obálky = breaking migrace (verzovat `v2:`).

## 4. Co server vidí

| Data | Vidí server? |
|---|---|
| Plaintext zpráv, souborů, klíč, passphrase | **ne** |
| Ciphertext chatových zpráv | **ne** — jdou jen DataChannelem |
| Ciphertext + IV chunků souboru | **ano, v proxy režimu** (jdou přes `/ws`); v paměti drží prvních 256 znaků |
| Název / typ / velikost souboru, jméno odesílatele | ne — jsou uvnitř šifrovaných metadat; počet chunků ale prozradí přibližnou velikost |
| Room ID, peer ID, jméno (≤ 48 zn.), IP, SDP/ICE | ano, po dobu spojení |
| Push subskripce (endpoint + klíče) | ano, jen v paměti procesu |

## 5. Rozhraní (souhrn; detail v `docs/api.md`)

- **WS `/ws`** klient → server: `join`, `signal`, `ping`, `leave`,
  `command-poll`, `command-ack`, `proxy-meta|chunk|end|cancel`.
  Server → klient: `hello`, `joined`, `peer-joined`, `peer-left`, `signal`,
  `pong`, `admin-command`, `proxy-ack`, `proxy-end|cancel`, `error`.
  Rámce nad 128 000 znaků se tiše zahazují. Strop peerů na místnost není.
- **REST** `/api/health`, `/api/modules`, `/api/turn`, `/api/events(/recent)`,
  `/api/push/status|subscribe|test`, `/api/settings`, `/api/audit/purge|log`,
  `/api/analytics/consent`, `/api/transfers/stats`, `/api/admin/retention(/run)`.
- **Admin** (`:5050`, Bearer `ADMIN_API_TOKEN`, bez tokenu `503`):
  `/admin/health` (veřejné), `/admin/metrics`, `/admin/logs/recent`,
  `/admin/clients`, `/admin/modules`, `/admin/commands/enqueue|audit`,
  `/admin/test/push`, `/admin/plugins/debug`. GUI ze `admin-ui/public`.
- **Env:** `PORT`, `NODE_ENV`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`, `LOG_EVENTS`, `DATABASE_URL` (jen štítek), `TURN_SERVER_URL`,
  `TURN_USERNAME`, `TURN_CREDENTIAL`, `*_RETENTION_DAYS`, `ENABLE_ADMIN`,
  `ADMIN_PORT`, `ADMIN_BIND` (výchozí `127.0.0.1`), `ADMIN_API_TOKEN`; klient
  `VITE_SIGNALING_URL`. Proměnná `KEEPALIVE_STRATEGY` **neexistuje** —
  strategie je uživatelská preference v prohlížeči.

## 6. Známé mezery — čti před tím, než na tyhle části spolehneš

Ověřeno revizí 2026-09-21; nic z toho není ve 2.5.0 opraveno.

1. **WS rate limit nefunguje** — Express middleware na `/ws` se při upgradu
   nevolá (změřeno 45/45 přijato při limitu 30/min). REST limiter funguje.
2. **Chybí `trust proxy`** — za reverse proxy mají všichni stejnou `req.ip`
   a sdílejí jeden limit 100 požadavků / 15 min.
3. **Proxy relay souborů nedoručuje** — server chunky ukládá, ale
   nepřeposílá; rozesílá jen `proxy-end`/`proxy-cancel`. Soubory fungují jen
   s otevřeným DataChannelem. Sloty se po `end` neuvolní (až TTL 10 min).
4. **Admin ↔ hlavní služba nesdílí stav** — fronta příkazů, push subskripce
   i event ring jsou Mapy v paměti *každého* procesu. Příkaz zařazený v admin
   procesu se ke klientovi hlavní služby nedostane.
5. **Neautentizované endpointy:** `POST /api/push/test`,
   `GET|POST /api/admin/retention*`. `GET /api/turn` vrací statické TURN údaje.
6. **TOFU otisky** jsou klíčované náhodným `peerId` nové relace → vždy
   „první použití"; při neshodě se otisk přepíše. „Otisk místnosti" je hash
   jen z room ID, ne z klíče.
7. **`connection-keeper.ts` není zapojený.** `App.tsx` má vlastní socket,
   heartbeat (45/25/12 s) a reconnect (start 1,5/1/0,5 s, full-jitter, strop
   120 s, bez inactivity timeoutu). Popisky v UI (30/15/8 s) odpovídají
   nezapojené knihovně.
8. **Stuby v paměti:** settings sync, consent, push subskripce; `audit/log`
   nemá žádného zapisovatele (vrací vždy `[]`). Retence neběží na timeru
   a události nemaže.
9. **`maxAttachmentBytes` je výchozí neomezené** (`MAX_SAFE_INTEGER`), ne
   100 MB; 100 MB je jen volba v Nastavení. Chunky se drží v RAM.
10. **CSP** povoluje `script-src 'unsafe-inline' 'unsafe-eval'`.

## 7. Provoz

- Instalace: `install.sh` (Docker + volitelně Nginx/certbot), viz `INSTALL.md`.
- Docker: `node:24-slim`, runtime bez `node_modules`, `USER node`; `.env` není
  v build kontextu. Admin stack: `docker compose --profile admin up -d`.
- Health: `GET /api/health`, `GET /admin/health`.
- macOS: port 5000 drží AirPlay → `PORT=5173`.

## 8. Kam dál

`README.md` (přehled + diagramy) · `docs/*.md` (po oblastech) ·
`CHANGELOG.md` · [`INSTALL.md`](../INSTALL.md) · [`modes.md`](modes.md) ·
[`developer-guide.md`](developer-guide.md) · [`optimizations.md`](optimizations.md).
