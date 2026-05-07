# Connection keeper

Service that owns the signaling WebSocket lifecycle.

## What it does

- **Heartbeat** — sends `{type:"ping",t:Date.now()}` over the open
  WebSocket every N seconds. The server replies with `{type:"pong",t}`,
  which the client uses to compute round-trip time.
- **Inactivity timeout** — if no traffic for 2× the ping interval, the
  socket is recycled.
- **Reconnect** — after an unexpected close, retries with exponential
  backoff and ±250 ms jitter, clamped per strategy.
- **OS hooks** — listens to `online`/`offline` and `visibilitychange`.
  When the user returns to a previously-foregrounded tab, the keeper
  immediately re-opens the socket if the user intent flag is set.

## Strategies

| strategy      | ping interval | inactivity timeout | initial backoff | max backoff |
| ------------- | ------------- | ------------------ | --------------- | ----------- |
| conservative  | 45 s          | 120 s              | 1.5 s           | 30 s        |
| balanced (default) | 25 s     | 60 s               | 1.0 s           | 15 s        |
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
keeper.start();
keeper.setStrategy("aggressive");
keeper.stop();
```

The main `App.tsx` integrates these primitives directly into the chat
WebSocket so users do not need to wire up the keeper separately. The
strategy is configurable from **Connection** in the toolbar.
