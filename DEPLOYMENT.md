# M5cet deployment options

> Successor to the original CipherRoom deployment guide. The repo, image, and
> systemd service have been renamed to **M5cet**. The interactive installer
> auto-detects and migrates older CipherRoom installs.

M5cet needs a long-running process because `/ws` is a persistent WebSocket
signaling endpoint for WebRTC. Static-only hosts can serve the frontend, but
they cannot run this backend unless you add a separate realtime service.

## Best options

1. DigitalOcean App Platform or Droplet: use the included `Dockerfile` or `.do/app.yaml`.
2. Railway: import the repo; `railway.json` defines build, start, and health check.
3. Render: import the repo; `render.yaml` defines the web service.
4. Fly.io: run `fly launch --no-deploy`, keep the included `fly.toml`, then `fly deploy`.
5. Cloudflare Workers + Durable Objects: viable for WebSocket signaling, but
   requires rewriting `server/routes.ts` into a Worker / Durable Object.

## One-line interactive install

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E bash -s -- --install
```

The installer:

- Detects an old CipherRoom checkout at `/opt/cipherroom-secure-chat`,
  `/opt/cipherroom`, or `/srv/cipherroom`.
- Stops the legacy compose stack (project names `cipherroom`,
  `cipherroom-secure-chat`).
- Snapshots `.env`, `data/`, `docker-compose.yml`, and any matching Nginx site
  to `/var/backups/m5cet/<timestamp>/`.
- Migrates the directory in-place to `/opt/m5cet` (overrideable with
  `INSTALL_DIR=...`).
- Installs Docker Engine + Compose plugin if missing.
- Writes a managed `docker-compose.yml` (or asks before overwriting an unmanaged
  one), builds, and starts the service.
- Optionally installs Nginx + certbot and provisions WSS via Let's Encrypt.
- Runs post-install probes against `/api/health`, `/api/modules`,
  `/api/push/status`, optionally `/api/events/recent`, plus a WebSocket
  upgrade handshake on `/ws`.

### Modes

- **Default (interactive)** — confirms install dir, branch, port, domain, and
  Nginx/TLS choices.
- **`--yes`** — accepts every yes/no prompt; values still prompt for input.
- **`--non-interactive`** — never prompts; uses defaults / env vars only.
- **`--dry-run`** — prints planned actions, touches nothing on disk.
- **`--doctor` / `--self-test`** — read-only environment + health probes.
- **Subcommands** — `--status`, `--logs`, `--restart`, `--stop`, `--uninstall`.

### Common variants

Custom domain, public Docker port:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo env DOMAIN=chat.example.com BIND_ADDRESS=0.0.0.0 FIREWALL_OPEN=1 \
    bash -s -- --non-interactive --yes
```

Debian/Ubuntu with Nginx reverse proxy:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo env DOMAIN=chat.example.com \
    bash -s -- --non-interactive --yes --enable-nginx
```

Debian/Ubuntu with Nginx + Let's Encrypt HTTPS / WSS:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo env DOMAIN=chat.example.com ACME_EMAIL=admin@example.com \
    bash -s -- --non-interactive --yes --enable-nginx --enable-tls
```

Dry run (preview the upgrade without touching the host):

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/feature/m5cet-fullscreen-secure-workspace/install.sh \
  | sudo -E bash -s -- --dry-run --yes
```

Doctor (read-only diagnostics on an existing install):

```bash
sudo -E /opt/m5cet/install.sh --doctor
```

### Nginx behavior in `install.sh`

- Installs `nginx` on Debian/Ubuntu when `--enable-nginx` is passed (or
  automatically when `DOMAIN` is set and `ENABLE_NGINX=auto`).
- Installs `certbot python3-certbot-nginx` and runs `certbot --nginx` when
  `--enable-tls` (or `ENABLE_TLS=1`) is set.
- Writes `/etc/nginx/sites-available/m5cet.conf` and enables it in
  `sites-enabled`.
- Preserves non-managed configs unless `FORCE_NGINX=1` (or you confirm at the
  prompt). A timestamped `.bak` is taken before any overwrite.
- Proxies `/` and `/ws` to `127.0.0.1:<HOST_PORT>` with
  `Upgrade`/`Connection` headers, `proxy_http_version 1.1`,
  `proxy_buffering off`, and 3600s WebSocket timeouts.
- Adds no-cache and `X-Robots-Tag: noindex, nofollow` headers.

### WebRTC note

Nginx handles only the HTTP app and the `/ws` signaling endpoint. WebRTC
DataChannel and media are negotiated through `/ws` but flow browser-to-browser
through ICE. HTTPS / WSS is required outside of `localhost`. For restrictive
NAT/firewall environments add a TURN server to the app ICE config.

### Local production

```bash
npm ci
npm run check
npm run build
PORT=5000 npm start
```

### Docker (manual)

```bash
docker build -t m5cet .
docker run --rm -p 5000:5000 -e PORT=5000 m5cet
```

### Render

```text
Connect GitHub repo -> New Web Service -> Render reads render.yaml.
```

### Railway

```text
Connect GitHub repo -> Deploy. Railway reads railway.json.
```

### Fly.io

```bash
fly launch --no-deploy --name m5cet --region fra
fly deploy
```

### DigitalOcean App Platform

```text
Create App -> GitHub repo -> Dockerfile deploy, or use .do/app.yaml as the app spec.
```

## Optional environment variables

These are all optional. The app works without them — they only enable the
server-enhanced mode features.

- `DATABASE_URL` — connection string for an event-logging backend. When unset,
  events fall back to an in-memory ring buffer (cleared on restart). Only opaque
  metadata is logged; message contents never leave the encrypted DataChannel.
- `LOG_EVENTS` — set `1` to enable event logging. Default off.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — VAPID key pair for web push
  notifications. Both must be set for `/api/push/subscribe` to accept
  subscriptions.

Generate VAPID keys with `npx web-push generate-vapid-keys` before passing
them to the installer or the container.

Endpoints exposed for embedders:

- `GET /api/health` — health probe.
- `GET /api/modules` — module manifest (modes, features, push, events).
- `GET /api/push/status` — whether push is configured and the public VAPID key.
- `POST /api/push/subscribe` — accepts a `{subscription}` body when push is
  configured.
- `POST /api/events` — records an event when `LOG_EVENTS=1`.
- `GET /api/events/recent` — returns the recent ring buffer when logging is on.
- `GET /WSS /ws` — the WebRTC signaling endpoint (101 Switching Protocols).

The frontend exposes `window.CipherRoomAPI` (kept under that name for
compatibility) with `capabilities`, `modules()`, `pushStatus()`, `recordEvent()`,
and `on()` for downstream embedders.

## Netlify / Vercel note

Netlify and Vercel are good for the static frontend, but not this full app
as-is because the signaling server requires persistent WebSocket connections.
If you must use Netlify / Vercel, deploy only the frontend there and set
`VITE_SIGNALING_URL=wss://your-backend.example/ws` at build time, with the
backend running on one of the long-running hosts above.
