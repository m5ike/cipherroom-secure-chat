# Push notifications

## 6.7: notifications with a fallback (server/notify)

A signed-in member who is **away** in a room (docs/accounts-away.md) is
woken by the **notifier** (`server/notify/dispatch.ts`), not by a fixed web
push any more:

1. **Who** — never the sender, never an account with an awake socket in the
   room, never an account that is gone.
2. **Whether** — the operator offers the kind (`message`, `mention`, `call`,
   `function`, `summon`, `test`), the user did not switch it (or everything)
   off, it is not their quiet hours, the kind's throttle per account and
   room (30 s for messages) and the account's hourly limit allow it.
3. **What** — the kind's template (title and body in cs / en / de) in the
   user's language, at the privacy level the user chose within the
   operator's maximum: `neutral` (nothing about who or where), `sender`,
   `room`, `content`. The server fills in what it knows (the sender's
   display name, how many messages wait, the time); the **room's name** only
   the device knows (the server sees an opaque room id), a **preview** only a
   device that decrypted the message itself — no push ever carries content.
4. **How** — the user's channel order (else the operator's), channels the
   operator switched on, the server can use and the account has an endpoint
   with: **Android** (a `notify` control message, ECIES-sealed for the one
   device and signed — FCM sees ciphertext), **web push** (RFC 8291,
   encrypted for the browser; TTL / Urgency / Topic set), **e-mail** (the
   operator's SMTP relay, only to an address its owner confirmed). The first
   channel where an endpoint takes it wins; an HTTP error, a dead token or a
   timeout moves on to the next.
5. **Afterwards** — dead endpoints are forgotten (web push 404 / 410 — read
   from web-push's `statusCode`; before 6.7 the code looked for it in the
   message text, which never matched, so dead subscriptions were never
   pruned —, a wiped / retired Android device, an address the relay refuses
   with 5xx at RCPT), every attempt goes to the operator's log (console ›
   Notifications; no content) and the audit journal (`notify.sent` /
   `notify.failed`).

Templates: `{name}`, `{name|fallback}`, `[optional part]` (dropped when a
variable in it is empty or hidden), `\` escapes. Values are put in once and
never read as a template, lose control and bidi characters, and are bounded.
The same rules run in `client/src/lib/notify-template.ts` (server + web),
`client/public/sw.js` and `android/…/push/NotifyTemplate.java`; the shared
vectors are `test/fixtures/notify-templates.json`.

| Method | Path | Who |
| ------ | ---- | --- |
| GET | `/api/notify/config` | anyone — the templates and switches (no SMTP) |
| GET/PUT | `/api/account/notify` | the account — its choice: `{ on, kinds, privacy, order, quiet, lang }`, and its endpoints |
| POST | `/api/account/notify/test` | the account — `{ channel? }`, one test through its channels (6 / min) |
| POST/DELETE | `/api/account/notify/email` | the account — an address (a confirmation mail goes to it; 5 / h) |
| GET | `/api/notify/email/confirm?t=…` | the link in that mail |
| DELETE | `/api/account/push` | the account — `{ endpoint }`: this browser stops being woken |
| POST | `/api/android/notify` | a device (signed with its key) — `{ token, on }`: wake it for that session's account |
| GET/PUT | `/api/admin/notify` | the console — settings (the SMTP password is sealed; `""` keeps it, `null` removes it) |
| POST | `/api/admin/notify/preview`, `/test`, `/email/test`; GET `/log` | the console |

Settings live in `$DATA_DIR/notify/` (`NOTIFY_DIR`): `config.json` (the
operator's) and `accounts.json` (each user's choice, device links, e-mail
addresses) — both 0600. A device link ends with the session it was made
with (sign-out, sign-out everywhere); deleting the account deletes the rest.

Clients: the web's Notifications panel has the user's own settings (a
guest's stay in the browser and steer only the page's own notifications);
enabling notifications while signed in links this browser at once, turning
them off unlinks it; a message with `@name` tells the relay it mentions
that away member (the only thing the server learns). The page's own
notifications (it decrypted the message) follow the same template and the
user's level. On Android, Settings › Notifications is a screen of the
design; signed in, the app joins its rooms "away-capable" (`notify.away`)
so the server keeps its messages while it is closed and wakes it with a
sealed `notify` message, which the app draws with its own room name.

## Two delivery paths

1. **Web Push** (real, requires VAPID + `web-push` package and a public
   server). Used when `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set.
2. **Local in-tab Notification** (always available — fallback when push
   is not configured).

## Server side

`server/push.ts` lazily loads the `web-push` package and sends real Web
Push messages when both VAPID keys are present. If either is missing,
the API gracefully reports `enabled:false` and the client falls back to
in-tab notifications.

Endpoints exposed by `server/push-routes.ts`:

| Method | Path                  | Notes                                        |
| ------ | --------------------- | -------------------------------------------- |
| GET    | `/api/push/status`    | reports `enabled`, `vapidPublicKey`, count   |
| POST   | `/api/push/subscribe` | accepts `{ subscription, deviceId }`, returns `{ id }` |
| POST   | `/api/push/test`      | `{ id }` — **self-test**, no token: one push with fixed text to that subscription only. `{ broadcast: true, title?, body? }` (or no `id`) — push to **every** subscriber, **admin token required** (`Authorization: Bearer $ADMIN_API_TOKEN`; `503` when unset, `401` when missing/wrong). Extra limit: 10 / min per IP. |

The subscription id is a random UUID returned only to the device that
subscribed, so it acts as the capability for "push to myself". A leaked id
can at most repeat the fixed test notification — custom text needs the
token. Before 2.8.1 a request without an id pushed caller-supplied text to
another user's device without any authentication.

The full `PushSubscription` (endpoint + p256dh + auth keys) is stored
**in memory only**. Restart the server and the table is empty. There is no
unsubscribe endpoint; entries leave via `/api/audit/purge`, a retention run
or a restart.

The VAPID **private** key never leaves the server; clients receive only the
public key. `/admin/test/push` lives in the separate admin process, which
has its own empty subscriber table (see `docs/admin.md`) — that is why the
operator broadcast is a token-protected route of the main service instead:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"broadcast":true,"title":"M5cet","body":"Maintenance at 22:00"}' \
  https://chat.example.org/api/push/test
```

Subscriptions older than `PUSH_RETENTION_DAYS` (default 90) are removed by
the retention sweep, which runs on its own every `RETENTION_SWEEP_MINUTES`
(default 60; see `docs/api.md`, section Retence).

## Client side

```ts
import { fetchPushStatus, subscribeToPush, sendTestPush, showLocalTestNotification } from "@/lib/push";

const status = await fetchPushStatus();
if (status?.enabled && status.vapidPublicKey) {
  await subscribeToPush(status.vapidPublicKey, deviceId);
}
await sendTestPush();             // real push to THIS device's own subscription only
await showLocalTestNotification(); // bypasses push service
```

The Notifications panel exposes both **Test local notification** and
**Test web push** buttons. *Test web push* sends only `{ id }` (the
device's own subscription from `localStorage` `m5cet:push:id`); without
one it asks the user to enable notifications first, and after a `404`
(server restarted, in-memory subscription gone) it forgets the stale id.

## Generating VAPID keys

```bash
npx web-push generate-vapid-keys --json
```

Set both `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (and optionally
`VAPID_SUBJECT`, e.g. `mailto:admin@example.org`) in your environment
or via `install.sh`'s prompts.

## Service worker behaviour

`client/public/sw.js` handles three events:

- `push` — extracts `{ title, body, url, tag, requireInteraction }` from
  the encrypted payload and shows the OS notification.
- `notificationclick` — focuses an existing tab if any, otherwise opens
  a new one at the URL embedded in the payload.
- `message` — accepts `{ type: "show-test-notification" }` from the
  page, used by the Test Local button to verify the worker without
  needing the push service.

## OS / browser limitations

- iOS Safari requires the app to be installed via the Home Screen
  (PWA install) before web push works at all. Even then, only short
  payloads are reliable.
- Chrome on Android: full support.
- Desktop Edge/Chrome/Firefox: full support; payload size and rate
  limits are determined by the push service (FCM/Mozilla Autopush).
- Background WebSocket traffic does NOT keep the tab alive — wake the
  client via a push and let the connection-keeper open the socket
  from the visibility-change handler.
