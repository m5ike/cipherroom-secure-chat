# Push notifications

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

Endpoints exposed by `server/routes.ts`:

| Method | Path                  | Notes                                        |
| ------ | --------------------- | -------------------------------------------- |
| GET    | `/api/push/status`    | reports `enabled`, `vapidPublicKey`, count   |
| POST   | `/api/push/subscribe` | accepts `{ subscription, deviceId }`         |
| POST   | `/api/push/test`      | sends a real push to one or all subscribers — **unauthenticated**, guarded only by the REST rate limit |

The full `PushSubscription` (endpoint + p256dh + auth keys) is stored
**in memory only**. Restart the server and the table is empty. There is no
unsubscribe endpoint; entries leave via `/api/audit/purge`, a retention run
or a restart.

The VAPID **private** key never leaves the server; clients receive only the
public key. `/admin/test/push` lives in the separate admin process, which
has its own empty subscriber table (see `docs/admin.md`), so use
`/api/push/test` for end-to-end checks.

## Client side

```ts
import { fetchPushStatus, subscribeToPush, sendTestPush, showLocalTestNotification } from "@/lib/push";

const status = await fetchPushStatus();
if (status?.enabled && status.vapidPublicKey) {
  await subscribeToPush(status.vapidPublicKey, deviceId);
}
await sendTestPush();             // real push via server
await showLocalTestNotification(); // bypasses push service
```

The Notifications panel exposes both **Test local notification** and
**Test web push** buttons.

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
