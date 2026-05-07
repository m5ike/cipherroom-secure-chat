# CipherRoom deployment options

CipherRoom needs a long-running process because `/ws` is a persistent WebSocket signaling endpoint for WebRTC. Static-only hosts can serve the frontend, but they cannot run this backend unless you add a separate realtime service.

## Best options

1. DigitalOcean App Platform or Droplet: use the included `Dockerfile` or `.do/app.yaml`.
2. Railway: import the repo; `railway.json` defines build, start, and health check.
3. Render: import the repo; `render.yaml` defines the web service.
4. Fly.io: run `fly launch --no-deploy`, keep the included `fly.toml`, then `fly deploy`.
5. Cloudflare Workers + Durable Objects: good architecture for WebSocket signaling, but it requires rewriting `server/routes.ts` into a Worker/Durable Object.

## Commands

One-line Linux/Docker install:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo -E bash
```

With custom domain/port:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo env DOMAIN=chat.example.com HOST_PORT=5000 bash
```

The installer clones or updates this Git repository, installs Docker when missing, writes a managed `docker-compose.yml`, builds the included `Dockerfile`, starts the app, and can install/configure Nginx with WebSocket upgrade headers.

By default the container binds to `127.0.0.1` for reverse-proxy deployment. For a direct public Docker port use `BIND_ADDRESS=0.0.0.0 FIREWALL_OPEN=1`.

Debian/Ubuntu with Nginx reverse proxy:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh \
  | sudo env DOMAIN=chat.example.com ENABLE_NGINX=1 bash
```

Debian/Ubuntu with Nginx + Let's Encrypt HTTPS/WSS:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh \
  | sudo env DOMAIN=chat.example.com ENABLE_NGINX=1 ENABLE_TLS=1 ACME_EMAIL=admin@example.com bash
```

Nginx support in `install.sh`:

- Installs `nginx` on Debian/Ubuntu when `ENABLE_NGINX=1`, or automatically when `DOMAIN` is set.
- Installs `certbot python3-certbot-nginx` and runs `certbot --nginx` when `ENABLE_TLS=1`.
- Writes `/etc/nginx/sites-available/<SERVICE_NAME>.conf` and enables it in `sites-enabled`.
- Preserves non-managed Nginx configs unless `FORCE_NGINX=1`.
- Proxies `/` and `/ws` to `127.0.0.1:<HOST_PORT>`.
- Sets `Upgrade`/`Connection` headers, `proxy_http_version 1.1`, `proxy_buffering off`, and 3600s WebSocket timeouts.
- Adds no-cache headers.

WebRTC note:

Nginx handles only the HTTP app and WebSocket signaling endpoint. WebRTC DataChannel traffic is negotiated through `/ws` but then flows browser-to-browser through ICE. HTTPS/WSS is recommended because WebRTC APIs require a secure context outside `localhost`. For restrictive NAT/firewall environments, add a TURN server to the app ICE server configuration.

Local production:

```bash
npm ci
npm run check
npm run build
PORT=5000 npm start
```

Docker:

```bash
docker build -t cipherroom .
docker run --rm -p 5000:5000 -e PORT=5000 cipherroom
```

Render:

```text
Connect GitHub repo -> New Web Service -> Render reads render.yaml.
```

Railway:

```text
Connect GitHub repo -> Deploy. Railway reads railway.json.
```

Fly.io:

```bash
fly launch --no-deploy --name cipherroom-secure-chat --region fra
fly deploy
```

DigitalOcean App Platform:

```text
Create App -> GitHub repo -> Dockerfile deploy, or use .do/app.yaml as the app spec.
```

## Optional environment variables

These are all optional. The app works without them — they only enable the
server-enhanced mode features.

- `DATABASE_URL` — connection string for an event-logging backend. When unset, events fall back to an in-memory ring buffer (cleared on restart). Only opaque metadata is logged; message contents never leave the encrypted DataChannel.
- `LOG_EVENTS` — set `1` to enable event logging. Default off.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — VAPID key pair for web push notifications. Both must be set for `/api/push/subscribe` to accept subscriptions.

Generate VAPID keys with `npx web-push generate-vapid-keys` before passing them to the installer or the container.

Endpoints exposed for embedders:

- `GET /api/health` — health probe.
- `GET /api/modules` — module manifest (modes, features, push, events).
- `GET /api/push/status` — whether push is configured and the public VAPID key.
- `POST /api/push/subscribe` — accepts a `{subscription}` body when push is configured.
- `POST /api/events` — records an event when `LOG_EVENTS=1`.
- `GET /api/events/recent` — returns the recent ring buffer when logging is on.

The frontend exposes `window.CipherRoomAPI` with `capabilities`, `modules()`, `pushStatus()`, `recordEvent()`, and `on()` for downstream embedders.

## Netlify/Vercel note

Netlify and Vercel are good for the static frontend, but not this full app as-is because the signaling server requires persistent WebSocket connections. If you must use Netlify/Vercel, deploy only the frontend there and set `VITE_SIGNALING_URL=wss://your-backend.example/ws` at build time, with the backend running on one of the long-running hosts above.
