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
| `ADMIN_BIND`       | `0.0.0.0`  | Bind address.                            |
| `ADMIN_API_TOKEN`  | (unset)    | Bearer token for every endpoint except `/admin/health`. |
| `ADMIN_UI_PORT`    | `5051`     | Used by docker-compose to expose the static GUI via nginx. |

## Endpoints

All except `/admin/health` require `Authorization: Bearer ${ADMIN_API_TOKEN}`.

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
the file is fetched.

## GUI

`admin-ui/dist/index.html` is a single-page static GUI. It reads the
admin API base URL and bearer token from `localStorage`. Serve it
either:

- via the admin Node service itself (auto-detected at boot), or
- via a separate nginx container (`docker-compose up admin-ui`), or
- via any static file host.

To rebuild a richer GUI (Vite/React) just replace the contents of
`admin-ui/dist/`. The Node service serves whatever lives there.

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
