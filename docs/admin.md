# Admin API + GUI

A second Node service runs alongside the chat server. It provides a
read/write management surface and ships with a minimal static GUI.

## Boot

```bash
ENABLE_ADMIN=1 \
ADMIN_API_TOKEN=$(openssl rand -hex 32) \
ADMIN_PORT=5050 \
npm run admin           # production (after npm run build)
# or
npm run admin:dev       # development (tsx)
```

## Ports / env vars

| Variable           | Default    | Purpose                                 |
| ------------------ | ---------- | --------------------------------------- |
| `ENABLE_ADMIN`     | `0`        | If `1`, the admin service listens.       |
| `ADMIN_PORT`       | `5050`     | Bind port for the admin API.             |
| `ADMIN_BIND`       | `127.0.0.1` | Bind address (docker-compose sets `0.0.0.0` inside the container and publishes the port on host loopback only). |
| `ADMIN_API_TOKEN`  | (unset)    | Bearer token for every endpoint except `/admin/health`. |

## Read this first — process isolation

The admin service is a **separate process** (`dist/admin.cjs`, its own
container in docker-compose). The command queue, push-subscriber table,
command audit and event ring are plain in-memory Maps *per process*, and the
main service never imports the admin module. Consequences today:

- A command accepted by `/admin/commands/enqueue` is queued in the admin
  process only. Clients poll the **main** service, so the command is never
  delivered.
- `/admin/clients` and `/admin/logs/recent` show the admin process's own
  (normally empty) state, not the main service's subscribers or events.
- `/admin/test/push` can only reach subscriptions made against the admin
  process — i.e. none.

What does work: health, process metrics, auth, allowlist validation and the
GUI shell. Making the rest work needs shared state (one process, or an
external store) — a design decision that has not been made yet.

## Endpoints

All `/admin/*` routes except `/admin/health` require
`Authorization: Bearer ${ADMIN_API_TOKEN}` (compared in constant time).
Without the env var they answer `503`; with a wrong token `401`. The GUI at
`/` is static and unauthenticated — it holds no data until a token is entered.

| Method | Path                             | Purpose                                    |
| ------ | -------------------------------- | ------------------------------------------ |
| GET    | `/admin/health`                  | Public liveness probe.                     |
| GET    | `/admin/metrics`                 | Process metrics + push subscriber count.   |
| GET    | `/admin/logs/recent?limit=N`     | Last N event-store records (metadata only). |
| GET    | `/admin/clients`                 | Push subscribers (truncated endpoints).    |
| GET    | `/admin/modules`                 | Module manifest + allowlist.               |
| POST   | `/admin/commands/enqueue`        | Queue a client command (allowlist only).   |
| GET    | `/admin/commands/audit`          | Recent command lifecycle entries.          |
| POST   | `/admin/test/push`               | Send a test push notification.             |
| GET    | `/admin/plugins/debug`           | Inspect registered plug-ins.               |

### Allowlist for `/admin/commands/enqueue`

`refresh-settings`, `reconnect`, `purge-local`, `show-notification`,
`run-diagnostic`, `download-file-from-admin`. The server rejects
anything else with HTTP 400.

The client enforces the same allowlist again before acting (see
`client/src/lib/admin-commands.ts`). `download-file-from-admin`
**always** requires explicit user consent via `window.confirm` before
the file is fetched. Note the prompt shows the file *name* only, not the
URL. The client polls for commands once per socket open (`command-poll`),
not periodically, and acknowledges with `command-ack` regardless of the
handler's result.

## GUI

`admin-ui/public/index.html` is a single-page static GUI. It reads the
admin API base URL and bearer token from `localStorage`. Serve it
either:

- via the admin Node service itself (auto-detected at boot), or
- via a separate nginx container (`docker-compose up admin-ui`), or
- via any static file host.

To ship a richer GUI, replace the contents of `admin-ui/public/` (the
service also looks in `admin-ui/dist/` as a fallback). The Node service
serves whatever lives there.

## Security model

- The admin service has **no** access to chat content. Encryption keys
  are derived in browsers from the room key + passphrase; the server
  never sees them.
- The audit log captures `enqueue`, `deliver`, and `ack` events for
  every admin command. Inspect it via `/admin/commands/audit`.
- Treat `ADMIN_API_TOKEN` like a root password: rotate, store in a
  secrets manager, never commit it.

## Plug-in registry

`/admin/plugins/debug` is a stub. Real plug-ins should:

1. Implement a TypeScript module that registers itself on boot.
2. Expose admin-only routes under `/admin/plugins/<id>/...`.
3. Handle their own auth (re-use `ADMIN_API_TOKEN` middleware).

Suggested patterns: virtual storage backends for large files
(`docs/files.md`), hardware card readers (`docs/nfc.md`), TURN-server
status pages, or external alerting integrations.
