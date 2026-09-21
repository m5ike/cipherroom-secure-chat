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
zprávou). Bez `trust proxy` je za reverse proxy „IP" adresa proxy — limit pak
sdílí všichni uživatelé. Žádný endpoint hlavní služby nevyžaduje autentizaci.
Neznámá cesta pod `/api/` vrací `index.html` (SPA fallback), ne `404`.

### Health & meta

- `GET /api/health` → `{ ok, rooms, cache, persistence, role }`
- `GET /api/modules` → `{ modes[], features{}, push{}, events{}, turn{ enabled, credentialUrl } }`
- `GET /api/turn` → `{ ok, iceServers[] }` včetně TURN `username`/`credential`.
  `404` bez `TURN_SERVER_URL`, `503` když chybí údaje. Údaje jsou **statické**
  a vydají se komukoli — používejte účet vyhrazený jen pro TURN.
- `GET /api/transfers/stats` → `{ ok, totalActive, totalByPeer, maxParallel, capBytes, ttlMs }`

### Push

- `GET /api/push/status` → `{ enabled, vapidPublicKey, subscribers }`
- `POST /api/push/subscribe` → body `{ subscription, deviceId? }`. Vrací `{ ok, id }`.
  `503` bez VAPID, `400` pokud endpoint není `https://`.
- `POST /api/push/test` → body `{ id?, title?, body? }`; pošle push jedné nebo
  všem subskripcím. **Není autentizovaný** (chrání ho jen REST limiter).
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

### Retence

- `GET  /api/admin/retention` → aktuální politika (dny) z `*_RETENTION_DAYS`.
- `POST /api/admin/retention/run` → okamžitý sweep (max. 1× za 60 s).

Oba endpointy jsou **bez autentizace** a sweep se jinak nikdy nespustí —
server nemá žádný timer. Maže prošlé settings, audit, push subskripce
a consent; události z event logu nemaže.

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
