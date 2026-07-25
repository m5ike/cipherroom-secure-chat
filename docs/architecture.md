# M5cet — architektura / Architecture

> Tento dokument popisuje stav po prvním buildable phase rebrandingu CipherRoom → M5cet
> (větev `feature/m5cet-fullscreen-secure-workspace`). Některé části jsou stále stubs.

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
  Šifrování, Privacy/Audit, Notifikace, Analytika, Šablony/Themy, Room Security).
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
| Logy `kind/peerId/room` v DB         | volitelně, při `LOG_EVENTS=1`   |
| Push subscription endpoint            | jen po explicitním subscribe    |

Reverse proxy (nginx, Cloudflare) může logovat IP. Viz `DEPLOYMENT.md` a `install.sh`.

## Klientská architektura

- `client/src/App.tsx` — orchestrátor, drží stav místnosti, peers, zpráv, TTL, panelů.
- `client/src/components/M5Logo.tsx` — originální vektorový logo (motorsport stripes
  + abstraktní "M" + číslice 5; není BMW M3).
- `client/src/components/Modal.tsx` + `panels.tsx` — modální okna pro nastavení.
- `client/src/lib/i18n.ts` — slovníky cs/en/de.
- `client/src/lib/themes.ts` — Motorsport Dark / Glass Light / Terminal Secure.
- `client/src/lib/preferences.ts` — schema preferencí v2; deviceId, TTL, room security.
- `client/src/lib/cipherroom-api.ts` — `window.CipherRoomAPI` registry (pluginy/widgets).

## Limitace tohoto buildable phase

- TTL je vynucováno klientem. Proti útočníkovi, který si zprávu zachytí přes vlastní
  sniffer, TTL nepomůže — je to UX vrstva.
- Sync settings, audit log, analytics consent, push delivery worker jsou **stuby**
  v paměti procesu. Restart serveru = ztráta dat.
- Storage providers (S3/GCS/Spaces/Azure) jsou jen rozhraní v `docs/modules.md`.
- Read receipts / typing indicator UI jsou v room security panelu, ale vlastní
  protokol je TODO (pro tuto fázi se neposílají zprávy o psaní).
- `e2ee` mezi více než dvěma peers vyžaduje sdílený passphrase — v této fázi
  nemáme klíč-per-peer výměnu.
- Žádné automatické testy neběží — repo má jen `tsc` a Vite build.
