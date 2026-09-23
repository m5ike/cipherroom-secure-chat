# M5cet — architektura / Architecture

> **Aktuální architektura 3.1.0:** [dokumentace › Architektura](site/index.html#architektura), více instancí v [› Více instancí](site/index.html#cluster).

> Stav k verzi 2.5.0. Některé serverové části jsou stále stuby — viz
> „Limitace" na konci.

## Vysoká úroveň

```
┌─────────────────────────┐         (signaling only, no message relay)
│ Browser A (M5cet PWA)   │◀──────────WSS /ws ──────────▶ ┌─────────────────┐
│  React + Vite           │                               │ Express server  │
│  WebRTC + AES-GCM       │                               │  /api/*         │
│  IndexedDB / LocalStore │                               │  WebSocket      │
└─────────┬───────────────┘                               └────────┬────────┘
          │                                                        │
          │ DataChannel (DTLS) + AES-GCM payload                   │
          ▼                                                        │
┌─────────────────────────┐                                        │
│ Browser B (M5cet PWA)   │                                        │
└─────────────────────────┘                                        │
                                                                   ▼
                                          ┌────────────────────────────────────┐
                                          │ Optional storage backends (stubs): │
                                          │  AWS S3 / GCS / DO Spaces / Azure  │
                                          │  PostgreSQL / SQLite event log     │
                                          │  VAPID push delivery worker        │
                                          └────────────────────────────────────┘
```

## Komponenty

- **Klient (Vite + React)** — fullscreen workspace, modální panely (Profil, Nastavení,
  Šifrování, Privacy/Audit, Notifikace, Analytika, Vzhled (šablona, písma, barvy, zobrazení, Edit Mode — [appearance.md](appearance.md)), Room Security).
- **Server (Express)** — signalizace přes `WebSocketServer` (`/ws`), REST stuby pro push,
  events, settings sync, audit purge a analytics consent.
- **Storage providers** — viz `docs/modules.md`. Zatím stuby; reálné S3/GCS/Spaces/Azure
  nutné nasadit za tím rozhraním.

## Bezpečnostní vrstvy

1. **Transport**: WSS pro signalizaci, DTLS-SRTP pro WebRTC media, DTLS pro DataChannel.
2. **Payload v DataChannelu**: AES-GCM 256-bit, IV per zpráva (12 B), klíč
   PBKDF2-SHA-256 (250 000 iterací) z room ID a passphrase.
3. **Klíč nikdy neopouští prohlížeč** — server nedrží passphrase ani odvozený klíč.
4. **Žádný 100% nárok**: skutečná bezpečnost závisí na endpointech, integritě
   prohlížeče a sdílení passphrase mimo tento kanál.

## Metadata behavior

| Co server vidí                       | Vždy / volitelně                |
|--------------------------------------|---------------------------------|
| WSS handshake (IP, User-Agent)       | vždy (pokud není proxy s `X-Forwarded-For`) |
| Room ID, peer ID, name (max 48 znaků)| vždy v paměti během připojení   |
| Plaintext zpráv                       | nikdy                           |
| Logy `kind/peerId/room`              | volitelně, při `LOG_EVENTS=1`; jen ring 500 záznamů v paměti |
| IV + ciphertext chunků souboru       | jen v proxy režimu přenosu (v paměti, zkráceně) |
| Push subscription endpoint            | jen po explicitním subscribe    |

Reverse proxy (nginx, Cloudflare) může logovat IP. Viz [`deployment.md`](deployment.md) a [`INSTALL.md`](../INSTALL.md).

## Klientská architektura

- `client/src/App.tsx` — orchestrátor, drží stav místnosti, peers, zpráv, TTL, panelů.
- `client/src/components/M5Logo.tsx` — originální vektorový logo (motorsport stripes
  + abstraktní "M" + číslice 5; není BMW M3).
- `client/src/components/Modal.tsx` + `panels.tsx` — modální okna pro nastavení.
- `client/src/lib/i18n.ts` — slovníky cs/en/de.
- `client/src/lib/themes.ts` — Motorsport Dark / Glass Light / Terminal Secure.
- `client/src/lib/preferences.ts` — schema preferencí v2; deviceId, TTL, room security.
- `client/src/lib/crypto.ts` — odvození klíče, AES-GCM obálka, base64 kodek.
- `client/src/lib/connection-keeper.ts` — heartbeat a reconnect signalizace.
- `client/src/lib/cipherroom-api.ts` — `window.CipherRoomAPI` registry (pluginy/widgets).

## Limitace tohoto buildable phase

- TTL je vynucováno klientem. Proti útočníkovi, který si zprávu zachytí přes vlastní
  sniffer, TTL nepomůže — je to UX vrstva.
- Sync settings, audit log, analytics consent, push delivery worker jsou **stuby**
  v paměti procesu. Restart serveru = ztráta dat.
- Storage providers (S3/GCS/Spaces/Azure) jsou jen rozhraní v `docs/modules.md`;
  `DATABASE_URL` zatím jen mění štítek backendu, do DB se nezapisuje.
- Proxy relay souborů, doručování admin příkazů mezi procesy, WS rate limit
  a TOFU otisky mají známé mezery — viz `docs/security-model.md`.
- Read receipts / typing indicator UI jsou v room security panelu, ale vlastní
  protokol je TODO (pro tuto fázi se neposílají zprávy o psaní).
- `e2ee` mezi více než dvěma peers vyžaduje sdílený passphrase — v této fázi
  nemáme klíč-per-peer výměnu.
- Testy: 106 unit/komponentových (Vitest) pokrývá `lib/*`, server utility, file
  proxy, retention, `linkify`, `MainMenu` a `TransferCard`. `App.tsx`
  (signaling + mesh + zprávy, ~2 600 řádků) nemá unit testy; end to end ho
  ověřuje `test/e2e/two-peers.test.ts` — dva skutečné prohlížeče, zpráva,
  inline i chunked soubor s kontrolou SHA-256.
