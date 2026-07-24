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

With custom domain/port and **2 GB file transfer**:

```bash
curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo env \
  DOMAIN=chat.example.com HOST_PORT=5000 \
  MAX_ATTACHMENT_BYTES=2147483648 \
  MAX_PEERS_PER_ROOM=16 \
  bash
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

Nginx handles only the HTTP app and WebSocket signaling endpoint. WebRTC DataChannel traffic is negotiated through `/ws` but then flows browser-to-browser through ICE. HTTPS/WSS is recommended because WebRTC APIs require a secure context outside `localhost`. For restrictive NAT/firewall environments, add a TURN server to the app ICE server configuration — see `VITE_TURN_*` below.

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
docker run --rm -p 5000:5000 -e PORT=5000 -e MAX_ATTACHMENT_BYTES=2147483648 cipherroom
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

Všechny jsou volitelné. Aplikace funguje i bez nich — pouze povolují rozšířený režim.

| Proměnná | Default | Popis |
| --- | --- | --- |
| `DATABASE_URL` | unset | `sqlite:./path` — perzistentní event log přes `better-sqlite3`. |
| `LOG_EVENTS` | `0` | `1` = povolí zápis eventů do DB nebo paměti. |
| `MAX_ATTACHMENT_BYTES` | `2147483648` (2 GB) | Maximální velikost jedné přílohy v B. |
| `MAX_PEERS_PER_ROOM` | `16` | Hard cap na počet peerů v jedné místnosti. |
| `FRAME_BUDGET_PER_SEC` | `20` | Token-bucket rate-limit: zpráv/s na peer. |
| `MAX_FRAME_BYTES` | `131072` | Maximální velikost jednoho signaling rámce. |
| `WS_HEARTBEAT_MS` | `25000` | WS ping interval pro detekci mrtvých spojení. |
| `VAPID_PUBLIC_KEY` | unset | VAPID klíč pro web push subscribe endpoint. |
| `VAPID_PRIVATE_KEY` | unset | VAPID klíč pro web push subscribe endpoint. |

### Frontend (`VITE_*` build proměnné)

| Proměnná | Default | Popis |
| --- | --- | --- |
| `VITE_SIGNALING_URL` | autodetect | Externí WS URL pro statický frontend. |
| `VITE_TURN_URL` | unset | `turn:host:3478` — TURN relay fallback. |
| `VITE_TURN_USERNAME` | unset | TURN uživatel. |
| `VITE_TURN_CREDENTIAL` | unset | TURN heslo/credential. |
| `VITE_MAX_ATTACHMENT_BYTES` | `2147483648` | Limit pro klientskou kontrolu (musí ≤ server). |

Generate VAPID keys with `npx web-push generate-vapid-keys` before passing them to the installer or the container.

For TURN server: self-hosted `coturn` je doporučený. Příklad na Ubuntu:

```bash
sudo apt-get install -y coturn
# /etc/turnserver.conf:
listening-port=3478
realm=turn.example.com
use-auth-secret
static-auth-secret=replace-me
```

A nastav v `install.sh`:

```bash
VITE_TURN_URL="turn:turn.example.com:3478?transport=tcp" \
VITE_TURN_USERNAME="$(date +%s):cipherroom" \
VITE_TURN_CREDENTIAL="$(echo -n "$(date +%s):cipherroom:replace-me" | openssl dgst -binary -sha1 | base64)" \
bash install.sh
```

## HTTP endpoints (no message persistence, read-only metadata)

- `GET /api/health` — health probe + counts (rooms/peers).
- `GET /api/modules` — module manifest (modes, features, push, events).
- `GET /api/push/status` — VAPID status.
- `POST /api/push/subscribe` — uloží subscription pokud má VAPID klíče.
- `POST /api/events` — zapíše event (jen metadata), když `LOG_EVENTS=1`.
- `GET /api/events/recent` — posledních N eventů (z DB nebo paměti).

## WebSocket signaling endpoint (`/ws`)

- Binární/textový WebSocket protokol.
- Heartbeat: server posílá WS ping každých 25 s.
- Aplikační heartbeat: klient může poslat `{"type":"ping","ts":…}` a dostane `{"type":"pong",…}`.
- **Auto-reconnect**: klient automaticky naváže znovu při ztrátě spojení s exponenciálním backoff 0.5–30 s.

## Frontend embed API

Vystaveno jako `window.CipherRoomAPI`:

- `version: "1.1.0"`
- `capabilities` — runtime feature detection.
- `modules(): Promise<ModuleManifest>` — info o server-side feature.
- `pushStatus(): Promise<…>`
- `recordEvent({kind, meta})` — log vlastní události (jen s `LOG_EVENTS=1`).
- `on(event, fn)` — subscribe na interní eventy (`message`, …).

## Netlify/Vercel note

Netlify a Vercel jsou vhodné pro statický frontend. Pro signaling backend použijte jednoho z long-running hostů výše. Frontend lze nasměrovat na `VITE_SIGNALING_URL=wss://your-backend.example/ws`.
