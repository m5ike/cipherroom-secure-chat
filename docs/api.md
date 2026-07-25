# M5cet — API surface

Všechny endpointy běží na stejném portu jako frontend (`PORT`, default 5000).
Cache-Control je všude `no-store`.

## Realtime

### `WSS /ws`

Frame format (JSON, max 128 kB per frame):

```json
{ "type": "join",   "room": "string", "peerId": "string", "name": "string?" }
{ "type": "signal", "target": "peerId", "payload": { ... } }
{ "type": "leave" }
```

Server odpovídá:

```json
{ "type": "hello",       "peerId": "...", "ip": "proxied|direct" }
{ "type": "joined",      "peerId": "...", "room": "...", "peers": [...] }
{ "type": "peer-joined", "peerId": "...", "name": "..." }
{ "type": "peer-left",   "peerId": "..." }
{ "type": "signal",      "source": "peerId", "payload": { ... } }
{ "type": "error",       "message": "..." }
```

## REST

### Health & meta

- `GET /api/health` → `{ ok, rooms, cache, persistence, role }`
- `GET /api/modules` → manifest dostupných featur (audio, attachments, push, events).

### Push

- `GET /api/push/status` → `{ enabled, vapidPublicKey, subscribers }`
- `POST /api/push/subscribe` → body `{ subscription, deviceId? }`. Vrací `{ ok, id }`.

### Events (server-enhanced mode)

- `GET /api/events/recent?limit=50` — vyžaduje `LOG_EVENTS=1`
- `POST /api/events` — body `{ kind, room?, peerId?, meta? }`. Plaintext zpráv se
  nikdy neloguje.

### Settings sync (NEW)

- `GET /api/settings?deviceId=...` → `{ ok, deviceId, settings, updatedAt }`
- `POST /api/settings` → `{ deviceId, settings }`. Vlastní obsah neinterpretovaný —
  kientský JSON. Doporučujeme klást jen ne-tajná data (téma, jazyk, font).

### Audit (NEW)

- `POST /api/audit/purge` → body `{ deviceId }`. Smaže settings, audit log,
  consent, push subskripce navázané na `deviceId`.
- `GET  /api/audit/log?deviceId=...` → seznam zaznamenaných auditních akcí.

### Analytics consent (NEW)

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
      attachment?: { kind, name, mime, size, dataUrl };
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
externí widgety. Stabilní rozhraní:

```ts
window.CipherRoomAPI.registerWindow({ id, title, render })
window.CipherRoomAPI.on(event, handler)   // events: "message", "peer-joined", ...
window.CipherRoomAPI.dispatch(event, payload)
```

Toto rozhraní je sdílené napříč všemi tématy (Motorsport / Glass / Terminal) a nesahá
na šifrovací klíč.
