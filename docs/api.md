# M5cet — API surface

Všechny endpointy běží na stejném portu jako frontend (`PORT`, default 5000).
Cache-Control je všude `no-store`.

## Realtime

### `WSS /ws`

Frame format: JSON. Rámce delší než **128 000 znaků** server tiše zahodí
(bez chybové odpovědi). Klient → server:

```json
{ "type": "join",   "room": "string", "peerId": "string", "name": "string?" }
{ "type": "signal", "target": "peerId", "payload": { ... } }
{ "type": "ping",   "t": 1700000000000 }
{ "type": "leave" }
{ "type": "command-poll", "deviceId": "string?" }
{ "type": "command-ack",  "commandId": "string", "result": "string?" }
{ "type": "proxy-meta",  "kind": "proxy-meta",  "transferId": "...", "iv": "...", "ciphertext": "..." }
{ "type": "proxy-chunk", "kind": "proxy-chunk", "transferId": "...", "seq": 0, "iv": "...", "ciphertext": "..." }
{ "type": "proxy-end" | "proxy-cancel", "kind": "...", "transferId": "..." }
```

Sanitizace při `join`: `room` ≤ 64 znaků (fallback `default`), `peerId` ≤ 64,
`name` ≤ 48 (fallback `Anonymous`), znaková sada `[a-zA-Z0-9 ._-]`. Strop
počtu peerů na místnost není.

Server odpovídá:

```json
{ "type": "hello",       "peerId": "...", "cache": "no-store", "ip": "proxied|direct" }
{ "type": "joined",      "peerId": "...", "room": "...", "peers": [{ "peerId", "name", "joinedAt" }], "policy": { ... } }
{ "type": "peer-joined", "peerId": "...", "name": "...", "joinedAt": 0 }
{ "type": "peer-left",   "peerId": "..." }
{ "type": "signal",      "source": "peerId", "payload": { ... } }
{ "type": "pong",        "t": 0, "serverTs": 0 }
{ "type": "admin-command", "command": { "id", "kind", "createdAt", "payload?" } }
{ "type": "proxy-ack",   "transferId": "...", "transport": "proxy", "accepted": true, "reason?": "..." }
{ "type": "proxy-end" | "proxy-cancel", "transferId": "..." }
{ "type": "error",       "message": "Malformed signaling frame ignored." }
```

Heartbeat je aplikační (`ping` → `pong`); server sám WS ping neposílá a nemá
idle timeout.

> **Pozor — rate limit.** `wsUpgradeLimiter` (30/min) je Express middleware
> a při WS upgradu se nevolá; počet spojení tedy reálně omezen není.
> REST limiter níže funguje.

## REST

Všechny `/api/*` cesty: **100 požadavků / 15 min na IP** (`429` s JSON
zprávou). Za reverse proxy se IP klienta bere z `X-Forwarded-For` jen od
důvěryhodné proxy (`TRUST_PROXY`, výchozí loopback) — viz
[`troubleshooting.md`](troubleshooting.md).

**Operátorské cesty** vyžadují admin token (`Authorization: Bearer
$ADMIN_API_TOKEN`, porovnání v konstantním čase — `server/admin-auth.ts`):
`GET|POST /api/admin/retention*` a broadcast přes `POST /api/push/test`.
Bez nastaveného `ADMIN_API_TOKEN` vracejí `503`, bez tokenu / se špatným
`401` (s `WWW-Authenticate: Bearer`). Ostatní endpointy autentizaci nemají.
Jsou v hlavní službě, ne v admin procesu, protože stav, se kterým pracují,
žije v paměti hlavní služby (admin proces má vlastní, prázdné kopie).
Neznámá cesta pod `/api/` vrací `index.html` (SPA fallback), ne `404`.

### Health & meta

- `GET /api/health` → `{ ok, rooms, cache, persistence, role, version, build, builtAt }`
  (`build` = git commit sestavení z `dist/public/build.json`)
- `GET /api/modules` → `{ modes[], features{}, push{}, events{}, turn{ enabled, credentialUrl } }`
- `GET /api/turn` → `{ ok, iceServers[] }` včetně TURN `username`/`credential`.
  Bez `TURN_SERVER_URL` `200 { ok: true, configured: false, iceServers: [] }`
  (klient použije jen STUN), `503` když chybí údaje. Údaje jsou **statické**
  a vydají se komukoli — používejte účet vyhrazený jen pro TURN.
- `GET /api/transfers/stats` → `{ ok, totalActive, totalByPeer, maxParallel, capBytes, ttlMs }`

### Push

- `GET /api/push/status` → `{ enabled, vapidPublicKey, subscribers }`
- `POST /api/push/subscribe` → body `{ subscription, deviceId? }`. Vrací `{ ok, id }`.
  `503` bez VAPID, `400` pokud endpoint není `https://`.
- `POST /api/push/test` — dva režimy (limit 10 / min na IP navíc k REST limitu):
  - **self-test**, bez tokenu: body `{ id }` = vlastní id odběru z
    `subscribe` (klient ho drží v `localStorage` `m5cet:push:id`). Pošle
    **pevný** text („M5cet · test") jen na tuto subskripci; `title`/`body`
    se ignorují. `200 { ok, mode: "self" }`, `404` neznámé id (např. po
    restartu serveru), `502` když push služba doručení odmítne, `503` bez VAPID.
  - **broadcast**, jen s admin tokenem: body `{ broadcast: true, title?, body? }`
    (i požadavek **bez `id`** se bere jako broadcast). Pošle text všem
    subskripcím → `{ ok, mode: "broadcast", sent, failed, results[] }`.
    Bez tokenu `401` / `503` (kontroluje se dřív než cokoli jiného).
- Odhlášení (`unsubscribe`) neexistuje; subskripce mizí přes `/api/audit/purge`,
  retenci nebo restart.

### Events (server-enhanced mode)

- `GET /api/events/recent?limit=50` — vyžaduje `LOG_EVENTS=1` (jinak `404`); limit 1–500
- `POST /api/events` — body `{ kind, room?, peerId?, meta? }`. Plaintext zpráv se
  nikdy neloguje.

### Settings sync (in-memory stub; klient ho zatím nevolá)

- `GET /api/settings?deviceId=...` → `{ ok, deviceId, settings, updatedAt }`
- `POST /api/settings` → `{ deviceId, settings }`. Vlastní obsah neinterpretovaný —
  kientský JSON. Doporučujeme klást jen ne-tajná data (téma, jazyk, font).

### Audit

- `POST /api/audit/purge` → body `{ deviceId }`. Smaže settings, audit log,
  consent, push subskripce navázané na `deviceId`.
- `GET  /api/audit/log?deviceId=...` → `{ ok, deviceId, entries }`. Do logu zatím
  nic nezapisuje, vrací vždy prázdné pole.

### Pozvánky (split-key, viz [`session-and-sharing.md`](session-and-sharing.md))

- `POST /api/share/create` → body `{ id, proof, revokeToken, serverKey, iv, ciphertext, maxUses?, ttlSec? }`
  (base64url pevných délek; `maxUses` 1–50, `ttlSec` 300–604800). `201 { ok, expiresAt, maxUses, maxAttempts }`.
- `POST /api/share/redeem` → body `{ id, proof }`. Správně: `{ ok, serverKey, iv, ciphertext, usesLeft }`.
  Špatný kód `403 { reason: "wrong-code", attemptsLeft }`, po 5. pokusu `410 burned`;
  neznámé, vadné i prošlé ID shodně `404`. **Jen `POST`** — `GET` nic nespotřebuje.
- `POST /api/share/revoke` → body `{ id, revokeToken }` → `{ ok }`.

Server nikdy nedostane klíč z fragmentu URL, takže uložená data nerozšifruje.
Vše je v paměti procesu.

### Odchod

- `GET /goodbye` → statická stránka s `Clear-Site-Data: "cache", "cookies", "storage", "executionContexts"`.

### Retence

Obě cesty vyžadují **admin token** (`503` bez `ADMIN_API_TOKEN`, `401` bez
něj / se špatným).

- `GET  /api/admin/retention` → `{ ok, policy, intervalMinutes, scheduled,
  nextSweepAt, lastSweep }` — politika v dnech z `*_RETENTION_DAYS`,
  plán a výsledek posledního sweepu (`trigger: "timer" | "manual"`).
- `POST /api/admin/retention/run` → sweep hned → `{ ok, removed{…}, total, ranAt, trigger }`.

Sweep běží i **sám**: hlavní služba ho spouští každých `RETENTION_SWEEP_MINUTES`
(výchozí 60, rozsah 1–1440) na `unref`-nutém timeru. Každá kategorie se
maže podle **svého** okna:

| Kategorie | Proměnná | Výchozí |
|---|---|---|
| settings sync | `SETTINGS_RETENTION_DAYS` | 30 dní |
| audit (`/api/audit/log`) | `AUDIT_RETENTION_DAYS` | 60 dní |
| push subskripce | `PUSH_RETENTION_DAYS` | 90 dní |
| analytics consent | `DATA_RETENTION_DAYS` | 30 dní |
| události (event ring, `LOG_EVENTS=1`) | `EVENT_RETENTION_DAYS` | 7 dní |

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" https://chat.example.org/api/admin/retention
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://chat.example.org/api/admin/retention/run
```

### Analytics consent (in-memory stub; klient ho zatím nevolá)

- `POST /api/analytics/consent` → `{ deviceId, analyticsConsent: bool }`
- `GET  /api/analytics/consent?deviceId=...` → `{ ok, record }`

## DataChannel payload (encrypted by client)

Každý paket v WebRTC DataChannelu je `{ iv, ciphertext }` (base64). Po dešifrování:

```ts
type DecryptedPayload =
  | {
      kind?: "text";
      id: string;
      text: string;
      createdAt: number;
      senderId: string;
      senderName: string;
      attachment?: { kind, name, mime, size, dataUrl };   // inline ≤ 512 KiB
      ttlMinutes?: number;
    }
  | {
      kind: "audio-status";
      id, createdAt, senderId, senderName,
      status: "off" | "joining" | "live" | "muted";
    };
```

## Frontend window API

`window.CipherRoomAPI` (viz `client/src/lib/cipherroom-api.ts`) je plugin registry pro
externí widgety. Skutečné rozhraní (read-only, instaluje se jednou — první
instalace vyhrává):

```ts
window.CipherRoomAPI.version                 // "1.0.0"
window.CipherRoomAPI.capabilities            // detekce funkcí prohlížeče
window.CipherRoomAPI.modules()               // Promise<manifest z GET /api/modules | null>
window.CipherRoomAPI.pushStatus()            // Promise<stav z GET /api/push/status>
window.CipherRoomAPI.recordEvent({ kind, meta? })   // POST /api/events
const off = window.CipherRoomAPI.on("message", ({ senderId }) => { ... })
```

Aplikace dnes vysílá jedinou událost: `message` s `{ senderId }` — nikdy
s obsahem zprávy. `registerWindow` / `openWindow` / `dispatch` zmiňované ve
starší dokumentaci v kódu nejsou.

Toto rozhraní je sdílené napříč všemi tématy (Motorsport / Glass / Terminal) a nesahá
na šifrovací klíč.
