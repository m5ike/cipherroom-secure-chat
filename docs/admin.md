# Admin API + GUI

> **Since 3.1.0** administrators are named, with a role — `owner`, `operator` or `auditor`
> (read-only) — from `ADMIN_API_TOKEN` (owner), `ADMIN_TOKENS` or the console's Administrators
> panel, and may sign in to the console with a passkey. The audit journal is hash-chained with
> signed checkpoints; backups, integrity checks, `/metrics` and alert rules with a webhook are
> in the console. See [documentation › Administrace](site/index.html#administrace) and
> [› Monitoring a audit](site/index.html#audit).
> **Since 3.0.0** the operator console lives at `/console/` and reads all live state (traffic,
> connections, users, queue, storage, audit, commands, push) from the main service's
> `/api/admin/*`; the admin service keeps the layout, telephony and AI tools and forwards
> `/api/admin/*` to `MAIN_URL`. See [documentation 3.0 › Administrace](site/index.html#administrace).

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

## Místnosti, m5adm a m5.telephony (6.0)

| Metoda a cesta | Popis |
|---|---|
| `GET /api/admin/rooms?members=full` | místnosti s uživatelskými jmény, skupinami a passkeys členů |
| `GET /api/admin/rooms/registry`, `GET\|PUT\|DELETE /api/admin/rooms/registry/:id` | záznam místnosti: popisek, poznámka, štítky, `maxMembers`, blokace (důvod, do kdy), připnuté oznámení (`$DATA_DIR/room-registry.json`) |
| `GET /api/admin/rooms/:id` | detail: členové, záznam, provoz, žurnál |
| `POST /api/admin/rooms/:id/notice` | oznámení operátora (`wall` / `message` / `flash`, volitelně připnuté) — rámec `server-notice` |
| `POST /api/admin/rooms/:id/disconnect`, `POST …/block`, `DELETE …/block`, `POST …/wake` | odpojit (všechny / člena), uzavřít a otevřít, zavolat nepřítomné |
| `DELETE /api/admin/users/:id/passkeys/:credentialId` | odebrat jednu passkey (nikdy poslední) |
| `POST /api/admin/audit/entries` | vlastní řádek auditu (`m5adm.audit.add`) |
| `GET /api/admin/telephony/sdk`, `GET …/sdk/calls/:id`, `POST …/sdk/bridges/:id/release` | m5.telephony: poskytovatelé, půjčená čísla, hovory, zprávy, log; uvolnění čísla |

**m5adm** (funkce): každé volání jde sem s podepsaným krátkodobým tokenem
funkce (role a oblasti z grantu vlastníka, klíč `$DATA_DIR/functions-adm.key`
nebo `FUNCTIONS_ADM_KEY_FILE`); strážce kontroluje oblast cestu po cestě,
audit zapisuje `fn:<model>/<volající>`, tokeny funkcí mají vlastní limit.

## Android (6.0)

Console › **Android** (`admin-ui/public/android-console.js`) talks to the main
service under `/api/admin/android/*` (module `android` in Modules & groups;
rights `devices`, `push`, `wipe`, `builds`, `releases`, `publish`,
`settings`). Every change is audited as `admin.android.*`.

| Method + path | What |
|---|---|
| `GET /api/admin/android` | store, config (service account only as its e-mail), FCM readiness, the server's Android key, counts, app version, design revision |
| `PUT /api/admin/android/config` | enrolment (`open`/`code`/`closed`), `policy` (lock, poll, update, rooms, logs), `packageName`, `certSha256`, `fcm` (`enabled`, `client` from google-services.json, `serviceAccount` JSON — sealed with the storage master key) |
| `GET /api/admin/android/devices[?q=&status=]`, `GET\|PATCH\|DELETE …/devices/:id` | enrolled devices; name, notes, status `active`/`blocked`/`retired` |
| `POST …/devices/:id/commands` `{kind, payload}` | control message: `ping`, `status` (`{logs}`), `flash` (`{text, level, title}`), `push` (`{title, body, room, url}`), `update`, `lock`, `wipe` (right `wipe`), `config` |
| `POST …/commands` `{kind, payload, devices?}` | the same to several / all active devices (not `wipe`) |
| `GET …/commands`, `GET …/events[?device=&type=&level=]` | what was sent and how it ended; what devices reported |
| `GET\|POST\|DELETE …/codes`, `GET …/codes/qr?server=&code=` | enrolment codes (shown once, stored hashed); QR SVG of `m5cet://enroll?…` (header `X-M5-Link`) |
| `GET\|PUT …/design`, `POST …/design/reset`, `GET …/catalog` | the app's design (validated), the builder's catalogue |
| `GET\|POST …/builds`, `GET …/builds/:id`, `…/content`, `…/deploy?devices=all\|id,…`, `POST …/publish\|withdraw\|restore`, `DELETE` | builds (`.m5ab`) |
| `GET …/releases`, `POST …/releases/upload?channel=&notes=&mandatory=` (body: the APK, ≤ 300 MB), `PATCH\|DELETE …/releases/:id`, `POST …/publish\|withdraw`, `GET …/apk` | APK releases |

The devices' own API is `/api/android/*` (signed requests, see
[`android-architecture.md`](android-architecture.md)). Behind nginx the APK
upload needs its own body limit — `deploy/nginx/m5cet.conf` and the
installer's template have it (300 MB).

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
