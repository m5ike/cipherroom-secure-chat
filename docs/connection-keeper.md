# Connection keeper

> **Status: library only — not wired into the app.** `App.tsx` imports the
> types from this module but never calls `createConnectionKeeper()`; it
> runs its own WebSocket with its own heartbeat and reconnect. What the app
> actually does today: ping every 45 / 25 / 12 s (conservative / balanced /
> aggressive); reconnect with full-jitter exponential backoff starting at
> 1.5 / 1 / 0.5 s, capped at **120 s** for every strategy; **no** inactivity
> timeout. The table below describes this module, which is the better
> design and the intended replacement — migrating `App.tsx` onto it is open
> work.

Service that owns the signaling WebSocket lifecycle.

## What it does

- **Heartbeat** — sends `{type:"ping",t:Date.now()}` over the open
  WebSocket every N seconds. The server replies with `{type:"pong",t}`,
  which the client uses to compute round-trip time.
- **Inactivity timeout** — if no traffic at all for the strategy's
  inactivity window (see table; checked every half-window, min. 5 s), the
  socket is closed with code `4000` and the normal reconnect path runs.
- **Reconnect** — after an unexpected close, retries with exponential
  backoff and full jitter: `delay = initial + random() · min(max, initial · 2^(attempt-1))`,
  additionally capped by `maxTotalBackoffMs` (default 2 min). `attempts`
  resets to 0 on every successful open. The backoff matters: without it
  every client would hammer a recovering server about once a second.
- **User intent** — only `requestStop()` ends the session. Any other close
  (server restart, NAT rebind, OS sleep) reconnects automatically, and the
  reason is exposed as `status.disconnectReason`
  (`client-leave | server-close | network | offline | inactivity`).
- **OS hooks** — listens to `online`/`offline`, `visibilitychange` and
  `pageshow` (return from bfcache / mobile tab freeze).
  When the user returns to a previously-foregrounded tab, the keeper
  immediately re-opens the socket if the user intent flag is set.

## Strategies

| strategy      | ping interval | inactivity timeout | initial backoff | max backoff |
| ------------- | ------------- | ------------------ | --------------- | ----------- |
| conservative  | 45 s          | 180 s              | 1.5 s           | 30 s        |
| balanced (default) | 25 s     | 90 s               | 1.0 s           | 15 s        |
| aggressive    | 12 s          | 30 s               | 0.5 s           | 8 s         |

Choose `aggressive` for short-lived high-priority sessions, `balanced`
for everyday chat, `conservative` for battery-sensitive mobile devices.

## What we cannot do

We cannot force a browser to keep a WebSocket open while the page is
hidden. Chrome throttles background timers to ~1 Hz, Firefox/Safari
similar; mobile OSes will suspend tabs entirely. The only way to wake
the page from the background is via a service worker push notification
(see `docs/push.md`). The keeper is wired to re-open the socket on
`visibilitychange` precisely so the user gets a fresh connection the
moment they bring the tab back.

## Public API (TypeScript)

```ts
import { createConnectionKeeper, STRATEGIES } from "@/lib/connection-keeper";

const keeper = createConnectionKeeper({
  url: () => "wss://example.com/ws",
  strategy: "balanced",
  onOpen: (sock) => sock.send("hello"),
  onMessage: (ev) => console.log(ev.data),
  onStatus: (s) => console.log(s.state, s.rttMs),
});
keeper.start();                 // intent = true, persistent reconnect
keeper.setStrategy("aggressive");
keeper.send({ type: "ping" });   // false when the socket is not open
keeper.forceReconnect();        // drop + reopen now, backoff reset
const off = keeper.subscribe((s) => render(s));  // returns unsubscribe
keeper.requestStop();           // the ONLY way to stop for good
```

`STRATEGIES` is exported so UIs can display the numbers above instead of
duplicating them.

The strategy preference (`prefs.keepaliveStrategy`) is configurable from
**Connection** in the toolbar and already drives `App.tsx`'s own heartbeat
and reconnect timings.
