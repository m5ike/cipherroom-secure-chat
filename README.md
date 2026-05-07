# M5cet — Secure Workspace

> Branch: `feature/m5cet-fullscreen-secure-workspace`
> Status: rebrand of CipherRoom → M5cet, full-screen workspace, themes / i18n / TTL /
> privacy panels. The legacy CipherRoom code paths still build and run; the installer
> auto-migrates older installs.

M5cet is a browser-first, end-to-end encrypted workspace for ad-hoc rooms. Two or
more peers exchange messages, files (≤512 kB), audio, and presence over a WebRTC
DataChannel; the only thing the server ever sees is opaque signaling traffic on
`/ws` and a small set of optional metadata endpoints under `/api`. Nothing is
persisted server-side by default.

## Quick install (Linux / Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E bash -s -- --install
```

The installer is interactive by default. It detects an existing CipherRoom
install in `/opt/cipherroom-secure-chat`, `/opt/cipherroom`, or `/srv/cipherroom`,
stops it, snapshots `.env` / `data/` / `docker-compose.yml` / Nginx site under
`/var/backups/m5cet/<timestamp>/`, then upgrades it to M5cet at `/opt/m5cet` and
runs post-install health probes.

### Common variants

Dry run (no changes, prints planned actions):

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E bash -s -- --dry-run --yes
```

Non-interactive, public Docker port:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo env BIND_ADDRESS=0.0.0.0 FIREWALL_OPEN=1 \
    bash -s -- --non-interactive --yes
```

Behind Nginx with Let's Encrypt:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo env DOMAIN=chat.example.com ACME_EMAIL=admin@example.com \
    bash -s -- --non-interactive --yes --enable-nginx --enable-tls
```

Read-only environment + post-install health checks:

```bash
sudo -E /opt/m5cet/install.sh --doctor
```

Manage:

```bash
sudo -E /opt/m5cet/install.sh --status
sudo -E /opt/m5cet/install.sh --logs
sudo -E /opt/m5cet/install.sh --restart
sudo -E /opt/m5cet/install.sh --uninstall   # stops stack, keeps project files
```

`./install.sh --help` lists every flag and environment variable.

## Modes

The frontend exposes a `Light / P2P` mode (server only forwards signaling) and a
`Server-enhanced` mode (adds opaque event metadata logging and Web Push delivery).
Both modes share the same client; the operator picks what to enable via env vars
(`LOG_EVENTS`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `DATABASE_URL`). See
`docs/modules.md` and `docs/api.md` for details.

## Documentation

| File | What's inside |
|------|----------------|
| [`docs/architecture.md`](docs/architecture.md) | Transport, crypto layers, metadata behavior, deployment topology. |
| [`docs/api.md`](docs/api.md) | `WSS /ws` frame format and every `/api/*` REST endpoint. |
| [`docs/modules.md`](docs/modules.md) | Frontend plugin registry and server module manifest. |
| [`docs/user-help.md`](docs/user-help.md) | End-user guide (CZ + EN): rooms, themes, profiles, privacy panel. |
| [`docs/build-and-deploy.md`](docs/build-and-deploy.md) | `npm` workflows, PWA notes, sanity checks. |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | DigitalOcean / Railway / Render / Fly.io / Nginx + TLS recipes. |

## Browser support

- Chromium 110+ (Chrome, Edge, Brave, Opera) — fully tested.
- Firefox 110+ — fully tested.
- Safari 16+ / iOS Safari 16+ — supported; WebRTC DataChannel + Web Crypto required.
- WebRTC needs a secure context (HTTPS / WSS) outside of `localhost`. The Nginx +
  Let's Encrypt path in `install.sh` provisions WSS automatically.
- PWA install + Web Push are gated on Server-enhanced mode and a configured VAPID
  key pair.

## Security & privacy posture

- Payload encryption: AES-GCM 256-bit, 12-byte IV per frame, key derived locally
  via PBKDF2-SHA-256 (250 000 iterations) from the room ID + room key. The server
  never sees the room key or plaintext.
- Transport: WSS for signaling, DTLS-SRTP for WebRTC media, DTLS for DataChannel.
- No message persistence on the server. The `/api/events*` endpoints are opt-in
  (`LOG_EVENTS=1`) and only record opaque metadata (peer id, room id, kind,
  timestamp). When `DATABASE_URL` is unset, events live in an in-memory ring
  buffer cleared on restart.
- `Cache-Control: no-store` is set on every response and the served HTML to
  prevent intermediary caching.
- `X-Robots-Tag: noindex, nofollow` is set when the bundled Nginx reverse proxy
  is used.
- This is **not** a substitute for endpoint security. A compromised browser or a
  leaked room key defeats the encryption. Sharing the room key out-of-band
  (Signal, paper, voice) is a hard requirement.
- The audit / privacy panel exposes `POST /api/audit/purge` to wipe server-side
  device state (settings sync, audit log, push subscriptions tied to your
  device id).

## Local development

```bash
npm ci
npm run dev      # tsx server/index.ts + Vite middleware
npm run check    # tsc --noEmit
npm run build    # client (Vite) + server (esbuild --minify)
PORT=5000 npm start
```

Docker:

```bash
docker build -t m5cet .
docker run --rm -p 5000:5000 -e PORT=5000 m5cet
```

## Branch status

`feature/m5cet-fullscreen-secure-workspace` is the active development branch.
Some panels in `docs/architecture.md` are still stubs (S3/GCS/Azure/Spaces
storage providers, real push delivery worker). The installer, build, type-check,
and core signaling endpoints are stable.

## License

MIT — see `package.json`.
