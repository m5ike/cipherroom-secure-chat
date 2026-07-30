# CipherRoom Secure Chat v2 — KNOWLEDGE BASE

## 1. Čo je CipherRoom v2

M5cet — end-to-end encrypted WebRTC P2P workspace (chat, calls, files, speech, NFC, maps, push) s WebSocket signaling. Žádná persistence zpráv. Verze 2.2.0, Node 20.x, React 19, Vite.

**Dva klienti:**
- `cipherroom-secure-chat` (v2) — WebRTC P2P, AES-GCM 256, DTLS-SRTP calls, server jenom pro signaling + file-relay fallback
- `cipherroom-secure-chat-v2` (v1, legacy) — stejný koncept, ale starší verze s problémy (chyběl TURN, O(n²) broadcast)

## 2. Architektura

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CipherRoom v2 — Client                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  App.tsx — WebSocket lifecycle + RTCPeerConnection mesh          │ │
│  │  - deriveRoomKey (PBKDF2-SHA256, 250k it) → AES-GCM envelope     │ │
│  │  - broadcastEnvelope (P2P DataChannel)                           │ │
│  │  - connection-keeper (heartbeat, reconnect)                      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                              │                                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  lib/crypto.ts — encrypt/decrypt envelope, toBase64              │ │
│  │  lib/connection-keeper.ts — createConnectionKeeper              │ │
│  │  lib/file-transfer.ts — chunked DataChannel transfer             │ │
│  │  lib/push.ts — Web Push VAPID subscription                       │ │
│  │  lib/nfc.ts, lib/speech.ts, lib/maps.ts                          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         cipherroom-api.ts                            │
│  - createConnectionKeeper(…) — factory hook                         │
│  - dispatchCommand, dispatchInternal — event bus                     │
│  - isAdminCommand, handleIncomingFrame — frame routing              │
│  - extractRemoteFingerprint, persistFingerprint — TOFU              │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         CipherRoom v2 — Server                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  index.ts (routes) — WS signaling + HTTP API                    │ │
│  │  - /ws — WebSocket handler (join, signal, leave)               │ │
│  │  - /api/health, /api/modules, /api/push/status                 │ │
│  │  - /api/events — metadata logging (opt-in)                      │ │
│  │  - /api/audit/purge — server-side data cleanup                  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        _cipherroom-db_ (SQLite, ephemeral)           │
│  - events, metadata (nikdy ne zprávy)                               │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Klíčové komponenty

### 3.1 Šifrování (AES-GCM 256)

```typescript
// lib/crypto.ts
export async function deriveRoomKey(roomId: string, passphrase: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(`${roomId}:${passphrase}`));
  const keyData = new Uint8Array(hash);
  return await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptEnvelope(key: CryptoKey, payload: unknown): Promise<DataChannelEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, JSON.stringify(payload));
  return { kind: 'encrypted', iv, ciphertext: toBase64(encrypted) };
}
```

### 3.2 WebSocket signaling (App.tsx)

```typescript
// Connection lifecycle — hook 9+×
- useEffect: browser reconnect (online/offline/pageshow/visibilitychange)
- useEffect: heartbeat (aggressive/balanced/conservative)
- useEffect: TOFU fingerprint collection (peer connected → extractRemoteFingerprint)
- useEffect: room rejoin (new roomId → reset state, clear old peers)
- useEffect: audio status broadcasting (live/off/muted)
```

### 3.3 P2P DataChannel transfer (chunked)

```typescript
// lib/file-transfer.ts
export async function sendFile({ key, file, senderId, senderName, channels, sendProxy,
  onTransport, onProgress, onStats, isCancelled }: FileTransferOptions): Promise<
  { ok: boolean; transferId: string; reason?: string; transport: 'p2p' | 'proxy' }
> {
  const maxChans = 3;
  const [first, ...rest] = channels.slice(0, maxChans);
  const channel = first ? first : null;
  if (!channel) {
    onTransport?.('proxy');
    const transferId = newId('transfer');
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await encryptForTag(passphrase, { kind: 'file-meta', transferId, senderId, senderName, name: file.name, size: file.size, createdAt: Date.now(), mimeType: file.type || 'application/octet-stream', bytesSent: 0, totalBytes: file.size, iv });
    await sendProxy({ type: 'proxy-meta', transferId, iv, ciphertext: encrypted });
    if (isCancelled()) return { ok: false, reason: 'cancelled', transport: 'proxy' };
    const chunks = Math.max(1, Math.ceil(file.size / (1024 * 1024 / 4)));
    const perChunk = Math.floor(file.size / chunks);
    for (let i = 1; i <= chunks; i++) {
      const slice = file.slice((i - 1) * perChunk, Math.min(i * perChunk, file.size));
      const chunkData = new Uint8Array(await slice.arrayBuffer());
      const chunkEncrypted = await encryptForTag(passphrase, { kind: 'file-chunk', transferId, seq: i, totalChunks: chunks, iv, ciphertext: chunkData, createdAt: Date.now() });
      await sendProxy({ type: 'proxy-chunk', transferId, seq: i, totalChunks: chunks, iv, ciphertext: chunkEncrypted });
      if (isCancelled()) return { ok: false, reason: 'cancelled', transport: 'proxy' };
      onProgress?.(i, file.size, { progress: i / chunks, bytesSent: slice.size });
    }
    const finalEncrypted = await encryptForTag(passphrase, { kind: 'file-end', transferId, iv, createdAt: Date.now() });
    await sendProxy({ type: 'proxy-end', transferId, iv, ciphertext: finalEncrypted });
    if (isCancelled()) return { ok: false, reason: 'cancelled', transport: 'proxy' };
    return { ok: true, transferId, transport: 'proxy' };
  }
  // P2P path — encrypt per-frame with current room key
  const transferId = newId('transfer');
  const iv = crypto.getRandomValues(new Uint8Array(16));
  await sendProxy({ type: 'proxy-meta', transferId, iv, ciphertext: await encryptForTag(passphrase, { kind: 'file-meta', transferId, senderId, senderName, name: file.name, size: file.size, createdAt: Date.now(), mimeType: file.type || 'application/octet-stream', bytesSent: 0, totalBytes: file.size, iv })};
  if (isCancelled()) return { ok: false, reason: 'cancelled', transport: 'p2p' };
  const chunks = Math.max(1, Math.ceil(file.size / (1024 * 1024 / 4)));
  const perChunk = Math.floor(file.size / chunks);
  for (let i = 1; i <= chunks; i++) {
    const slice = file.slice((i - 1) * perChunk, Math.min(i * perChunk, file.size));
    const chunkData = new Uint8Array(await slice.arrayBuffer());
    const chunkEncrypted = await encryptForTag(passphrase, { kind: 'file-chunk', transferId, seq: i, totalChunks: chunks, iv, ciphertext: chunkData, createdAt: Date.now() });
    await channel.send(chunkEncrypted);
    if (isCancelled()) return { ok: false, reason: 'cancelled', transport: 'p2p' };
    onProgress?.(i, file.size, { progress: i / chunks, bytesSent: slice.size });
  }
  const finalEncrypted = await encryptForTag(passphrase, { kind: 'file-end', transferId, iv, createdAt: Date.now() });
  await channel.send(finalEncrypted);
  if (isCancelled()) return { ok: false, reason: 'cancelled', transport: 'p2p' };
  return { ok: true, transferId, transport: 'p2p' };
}
```

### 3.4 TOFU fingerprint (DTLS)

```typescript
// lib/fingerprint.ts
export async function extractRemoteFingerprint(pc: RTCPeerConnection): Promise<string | null> {
  try {
    const stats = await pc.getStats();
    const report = Array.from(stats).find(r => r.type === 'remoteCandidate' && r.selected && r.sdpFingerpr
```

## 4. Deploy & CI/CD

### 4.1 One-liner instalace

```bash
# První instalace (interaktivní)
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E bash -s -- --install

# Non-interactive (pro CI / headless)
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E bash -s -- --non-interactive --yes

# Behind Nginx + TLS (certbot)
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E DOMAIN=chat.example.com ACME_EMAIL=admin@example.com \
    bash -s -- --non-interactive --yes --enable-nginx --enable-tls
```

### 4.2 Režimy instalátoru

```
--install     # první instalace / upgrade
--update      # pull + redeploy
--test        # read-only health probes (doctor)
--gui         # interaktivní menu
--logs        # follow docker logs
--restart     # restart
--stop        # stop
--uninstall   # remove app, keep project files
```

### 4.3 Konfigurace (`.env` + ENV flagy)

```typescript
// Klíčové proměnné — default v package.json / install.sh
INSTALL_DIR=/opt/m5cet
BRANCH=feature/m5cet-fullscreen-secure-workspace
APP_PORT=5000
HOST_PORT=5000
BIND_ADDRESS=127.0.0.1      # 0.0.0.0 pro public
DOMAIN=chat.example.com
ENABLE_NGINX=auto           # 1 / 0 / auto
ENABLE_TLS=0                # 1 pro certbot
ACME_EMAIL=admin@example.com
ADMIN_API_TOKEN=<32B random>
VAPID_SUBJECT=mailto:admin@example.org
LOG_EVENTS=0                # metadata logging (opt-in)
KEEPALIVE_STRATEGY=balanced # aggressive | balanced | conservative
```

### 4.4 Pre-commit guard

```bash
# scripts/pre-commit-check.sh
#!/bin/bash
set -e
npm run check              # TypeScript strict
npm run test               # Vitest
npm run check:menu         # pre-commit-check.sh self
npm run test:e2e -- --reporter=verbose --grep="menu"
```

## 5. Workflow

### 5.1 Git + release

```bash
# Tag-and-push workflow — 5 kroků
1. git checkout master && git pull --ff-only origin master
2. npm run build && npm run test
3. git add package.json package-lock.json CHANGELOG.md
4. git commit -m "chore: bump $VERSION — sync + patch"
5. git push origin master
   git tag -a v$VERSION -m "Release $VERSION"
   git push origin v$VERSION
```

### 5.2 Debugging

```bash
# Health probe (read-only)
sudo -E /opt/m5cet/install.sh --test

# Follow logs
sudo -E /opt/m5cet/install.sh --logs

# Force Nginx site override
FORCE_NGINX=1 sudo -E /opt/m5cet/install.sh --update

# Force full reinstall
sudo -E /opt/m5cet/install.sh --install --force-reclone --yes
```

## 6. Bezpečnost

- PBKDF2-SHA256 (250k it) → AES-GCM 256
- DTLS-SRTP (WebRTC) — fingerprint TOFU
- Web Push VAPID — server-side public key + client-side private key
- Zero plaintext persistence — ephemeral events metadata only
- Per-frame per-peer encryption (room key + per-peer nonce)
- Server proxy relay — end-to-end encrypted chunks (AES-GCM)

## 7. Architektura detailů

### 7.1 Connection Keeper (reconnect)

```typescript
// Reconnect strategy — full-jitter exponential backoff
const initial = prefs.keepaliveStrategy === "aggressive" ? 500 : prefs.keepaliveStrategy === "conservative" ? 1500 : 1000;
const max = 120_000; // hard 2 min cap
const exp = Math.min(max, initial * Math.pow(2, Math.min(attempt, 12)));
const delay = Math.random() * exp; // full-jitter
```

### 7.2 Per-peer per-frame encryption

- Room key je AES-GCM
- Každý DataChannel frame má vlastní IV (nonce)
- Per-peer nonce counter (jako v legacy `connection-keeper.ts`)

### 7.3 File transfer — chunked

- Default: 100 MB per message (user-configurable v Settings)
- Server proxy: 10 GB hard cap (server-side)
- Per-frame encryption (AES-GCM) + IV per chunk

## 8. Volitelné features

- **Push** — Web Push VAPID, service worker
- **Calls** — WebRTC audio + video (DTLS-SRTP)
- **Speech** — TTS/STT (Chrome/Edge only)
- **NFC** — Android Chrome Web NFC (tag write/read)
- **Maps** — OpenStreetMap osmLink, GPS watch
- **Location** — one-time / continuous sharing

## 9. Zdroje

- `/Users/m5ike/CodeAgent/workspaces/cipherroom-secure-chat-v2/INSTALL.md` — kompletní instalace
- `/Users/m5ike/CodeAgent/workspaces/cipherroom-secure-chat-v2/docs/deployment.md` — deploy, Nginx, TLS
- `/Users/m5ike/CodeAgent/workspaces/cipherroom-secure-chat-v2/docs/troubleshooting.md` — řešení problémů
- `/Users/m5ike/CodeAgent/workspaces/cipherroom-secure-chat-v2/docs/security-model.md` — šifrování, Threat Model

## 10. Verze a legacy

- **cipherroom-secure-chat v2** — WebRTC P2P, AES-GCM, DTLS-SRTP, server jenom signaling + file-relay
- **cipherroom-secure-chat v1** — legacy, problémy (chyběl TURN, O(n²) broadcast, mass-broadcast bez ratchetingu)

---

Tento dokument slouží jako rychlý referenční manuál pro vývojáře, operátory i uživatele CipherRoom v2.
