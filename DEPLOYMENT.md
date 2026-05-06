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

The installer clones or updates this Git repository, installs Docker when missing, writes a managed `docker-compose.yml`, builds the included `Dockerfile`, starts the app, and prints Nginx reverse-proxy instructions with WebSocket upgrade headers.

By default the container binds to `127.0.0.1` for reverse-proxy deployment. For a direct public Docker port use `BIND_ADDRESS=0.0.0.0 FIREWALL_OPEN=1`.

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

## Netlify/Vercel note

Netlify and Vercel are good for the static frontend, but not this full app as-is because the signaling server requires persistent WebSocket connections. If you must use Netlify/Vercel, deploy only the frontend there and set `VITE_SIGNALING_URL=wss://your-backend.example/ws` at build time, with the backend running on one of the long-running hosts above.
