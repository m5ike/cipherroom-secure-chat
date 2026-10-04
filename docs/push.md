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
4. **How** — the user's channel order once they saved their settings (the
   Android app saves them at sign-in and on every change, so for its users the
   user's order always applies), otherwise the operator's; only channels the
   operator switched on, the server can use and the account has an endpoint
   with: **Android** (a `notify` control message, ECIES-sealed for the one
   device and signed — FCM sees ciphertext; HIGH priority, TTL 1 h),
   **web push** (RFC 8291, encrypted for the browser; TTL / Urgency / Topic
   set), **e-mail** (the operator's SMTP relay, only to an address its owner
   confirmed; **off by default** and ready only with an SMTP host and a From
   address). Defaults: android → webpush → email. The first channel where an
   endpoint takes it wins; a non-2xx answer, a thrown error, a dead token or a
   timeout (10 s for web push and SMTP, 15 s for FCM) moves on to the next. A
   failed FCM send is not queued for the device's next check-in.
5. **Afterwards** — dead endpoints are forgotten (web push 404 / 410 — read
   from web-push's `statusCode`; before 6.7 the code looked for it in the
   message text, which never matched, so dead subscriptions were never
   pruned —, a device that is no longer active (wiped, retired, blocked) or
   gone, an address the relay refuses with 5xx at RCPT; FCM `UNREGISTERED`
   only clears the device's token), attempts go to the operator's log
   (console › Notifications › *Test & log*: the last 1000 since the server
   started, in memory, no content; throttled skips are only counted) and the
   audit journal (`notify.sent` / `notify.failed`).

Which kinds fire today: `message` and `mention` (from the away relay),
`summon` (the operator calls an away member back, `m5room.connect`) and `test`
(the user's or the console's test). `call` and `function` exist in the
templates, the settings and the console, but no client or server code sends
them yet — only the console test reaches them.

Before 6.7 the Android app was never woken: it signed in with `away: false`
(so the server neither kept it away nor queued its messages), and the relay's
wake-up went only to web push subscriptions, with a fixed text. Now the app
joins "away-capable" when *The server keeps my messages and wakes me* is on
(`notify.away`), links the device with `POST /api/android/notify`, and the
`android` channel reaches it.

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
| POST/DELETE | `/api/account/notify/email` | the account — an address (a confirmation mail goes to it, the link is valid 48 h; POST 5 / h; `409` when the server sends no e-mail) |
| GET | `/api/notify/email/confirm?t=…` | the link in that mail |
| DELETE | `/api/account/push` | the account — `{ endpoint }`: this browser stops being woken |
| POST | `/api/android/notify` | a device (signed with its key) — `{ token, on }`: wake it for that session's account |
| GET/PUT | `/api/admin/notify` | the console — settings (the SMTP password is sealed; `""` keeps it, `null` removes it) |
| POST | `/api/admin/notify/preview`, `/test`, `/email/test`; GET `/log` | the console |

Settings live in `$DATA_DIR/notify/` (`NOTIFY_DIR`): `config.json` (the
operator's) and `accounts.json` (each user's choice, device links, e-mail
addresses) — directory 0700, files 0600. A device link ends with the session
it was made with (sign-out, sign-out everywhere); deleting the account deletes
the rest. At most 5 Android device links and 5 web push endpoints per
account. The SMTP password is sealed with the storage master key and never
sent to the console (only "set"). There are no `SMTP_*` environment
variables — SMTP is configured in the console (*E-mail* tab); e-mail links use
`PUBLIC_BASE_URL`.

Clients: the web's Notifications panel has the user's own settings (a
guest's stay in the browser — `localStorage` `m5cet:notify:prefs` — and steer
only the page's own notifications); enabling notifications while signed in
links this browser at once, turning them off unlinks it; a message with
`@name` tells the relay it mentions that away member (the only thing the
server learns; not for sealed messages). The page's own notifications (it
decrypted the message) follow the same template and the user's level — with
no level chosen they show the content, capped by the operator's maximum; the
service worker gets the names of the page's rooms (`notify-rooms`, memory
only) to fill in `{room}`. On Android, Settings › Notifications is a screen of
the design (no e-mail entry there — the address is set on the web); signed in
and with *The server keeps my messages and wakes me* on, the app joins its
rooms "away-capable" (`notify.away`) so the server keeps its messages while it
is closed and wakes it with a sealed `notify` message, which the app draws
with its own room name — only at the `room` level or above and never while
the app is locked (then no reply either; the sender's name still shows at the
`sender` level). The quiet hours (from–to, across midnight when from > to, in
the user's time zone) hold back everything except `test` — calls too.

Known rough edges: the Android string `notify.noFcm` says a wake-up "waits for
the next check-in", but nothing is queued (see 4. above); the console's hint
says `UNREGISTERED` tokens are "forgotten", while only the token is cleared.

## Web push basics (since 2.x)

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

The full `PushSubscription` (endpoint + p256dh + auth keys) of this test
table is stored **in memory only**. Restart the server and the table is
empty. An anonymous subscription has no unsubscribe endpoint; it leaves via
`/api/audit/purge`, a retention run, a restart or (6.7) a 404 / 410 from its
push service. A signed-in browser's endpoint lives with the account and is
removed with `DELETE /api/account/push` (6.7).

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

- `push` — 6.7: a templated payload (`v: 1` — the kind's template, the
  variables the server may show, the privacy level) is rendered with the same
  rules as `notify-template.ts`, the room's name filled in from what the page
  told it, a `preview` never taken from the server; an older payload
  `{ title, body, url, tag, requireInteraction }` is shown as before.
- `notificationclick` — focuses an existing tab if any, otherwise opens
  a new one at the URL embedded in the payload.
- `message` — `{ type: "show-test-notification" }` (the Test Local button),
  `notify-rooms` / `notify-forget` (6.7: room names for `{room}`, in memory)
  and `version` (the integrity check asks for the worker's build).

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
