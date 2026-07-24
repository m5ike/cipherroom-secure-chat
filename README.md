# CipherRoom Secure Chat

End-to-end šifrovaný WebRTC P2P room-chat s WebSocket signalizací. **Žádné ukládání zpráv na serveru**, **žádné posílání souborů přes server** — vše letí šifrovaně browser-to-browser. Nulová cache.

![version](https://img.shields.io/badge/version-1.1.0-blue)
![node](https://img.shields.io/badge/node-20.x-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

## ✨ Klíčové vlastnosti (v1.1.0)

- **AES-GCM 256 end-to-end**: Veškeré zprávy a soubory jsou zašifrovány v prohlížeči ještě **před** odesláním na socket.
- **PBKDF2-SHA256 (250 000 iterací)**: Klíč je derivovaný lokálně; passphrase **nikdy neopustí prohlížeč**.
- **Soubory až 2 GB**: Browser-to-browser transfer po 64 KB chuncích se SHA-256 ověřením. Server je čistý signaling router.
- **Auto-reconnect**: Pokud WebSocket spojení spadne, klient **okamžitě** naváže znovu s exponenciálním backoff (0.5–30 s). Manuální tlačítko „Odpojit" tento mechanismus zastaví.
- **TOFU Safety Number**: Po navázání RTC spojení obě strany zobrazí krátký safety kód (12 hex chars) — pro případnou detekci MITM.
- **VAPID push notifikace**: Volitelně; vyžaduje VAPID klíče na serveru.
- **CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy**: Zapnuté v `server/index.ts`.
- **Rate-limit**: token-bucket (20 rámců/s/peer), burst 80.
- **MAX 16 peerů na room** (konfigurovatelné).

---

## 🚀 Rychlý start

```bash
npm ci
npm run check
npm run build
PORT=5000 npm start
```

Otevři `http://localhost:5000` ve dvou oknech, vlož stejný Room ID + passphrase, a piš.

Pro lokální self-host na Debian/Ubuntu viz `DEPLOYMENT.md`.

Pro cloud (Railway, Fly, Render, DigitalOcean) — `docker build -t cipherroom .` a nasadit kontejner.

---

## 🎯 Demo bez vlastního serveru

`browser-only-firebase/` obsahuje čistě statickou variantu. Stačí otevřít `index.html`, vložit Firebase web-app config a najít přátele.

---

## 🛡️ Bezpečnost

| Vrstva | Co dělá |
| --- | --- |
| **Passphrase → PBKDF2 → AES-GCM klíč** | Klient derivuje lokálně, salt = `CipherRoom:v1:${room}` |
| **Envelope per message** | `{"v":1,"alg":"AES-GCM","iv":base64,"ciphertext":base64}` |
| **Per-chunk IV** | Každý chunk má vlastní 12-byte IV |
| **SHA-256 chunk + manifest hash** | Integrita souboru je ověřena na příjmu |
| **HTTPS/WSS only** | WebRTC vyžaduje secure context; produkce = WSS |
| **CSP** | Default `'self'`, povoluje jen `connect-src 'self' ws: wss:` |
| **Cache-Control: no-store** | Všude |
| **Service worker necachuje** | Jen handler pro push notifikace |

**Server nikdy:
- nevidí passphrase ani klíč,
- neukládá zprávy ani soubory,
- neposílá ciphertext na jiného peera než toho, komu patří.

---

## 📐 Architektura

```
┌── Browser A ──┐                    ┌── Browser B ──┐
│ React + Vite  │                    │ React + Vite  │
│ wouter router │                    │ wouter router │
│ RTCPeerConn.  │ ────── DTLS-SRTP ───── RTCPeerConn.  │
│  └─ DataCh.   │      64 KB chunks    64 KB chunks  │
│       AES-GCM │      encrypted        AES-GCM     │
└──────┼────────┘                    └──────┼────────┘
       │                                    │
       │  SDP offer / ICE candidate / ping  │ ← signaling only
       │                                    │
       └────────►  ┌── Server ──┐  ◄────────┘
                    │ Express + ws│
                    │  room map   │
                    │ rate-limit  │
                    │ /api/health │
                    └─────────────┘
```

---

## 📡 API

HTTP endpointy (read-only metadata):

- `GET /api/health` – health probe.
- `GET /api/modules` – verze + manifest schopností.
- `GET /api/push/status` – VAPID status.
- `POST /api/push/subscribe` – uloží subscription (vyžaduje VAPID klíče).
- `POST /api/events` – logne event (vyžaduje `LOG_EVENTS=1`).
- `GET /api/events/recent` – posledních N eventů.

WebSocket: `ws://host/ws`. Server dělá jen signaling router roomy:
1. Klient pošle `{type:"join",room,peerId,name}`.
2. Server vrátí `{type:"joined",peerId,peers[],limits}` + ostatním peerům pošle `{type:"peer-joined"}`.
3. Klienti si navzájem posílají SDP offer/answer + ICE kandidáty přes `{type:"signal",target,payload}`.
4. Po navázání DataChannelu komunikují šifrovaně **pouze mezi sebou**.

Aplikační API pro embeddery: `window.CipherRoomAPI.{capabilities, modules, pushStatus, recordEvent, on}`.

---

## 🔧 Konfigurace

`.env.example`:

```bash
VITE_SIGNALING_URL=wss://chat.example.com/ws
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=cipherroom
VITE_TURN_CREDENTIAL=secret

VITE_MAX_ATTACHMENT_BYTES=2147483648  # 2 GB

DATABASE_URL=sqlite:./data/events.db
LOG_EVENTS=1
MAX_PEERS_PER_ROOM=16

VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

Viz `DEPLOYMENT.md` pro detailní návod (Docker, Nginx, TLS, TURN).

---

## 🧪 Vývoj

```bash
npm run check       # TypeScript tsc
npm run lint        # ESLint
npm test            # Vitest unit testy
npm run build       # Production build
PORT=5000 npm run dev  # Dev s HMR (tsx)
```

CI je nastavené v `.github/workflows/ci.yml` — běží TypeScript check, lint, testy, build a health-probe.

---

## 📄 Licence

MIT © 2024 m5ike
