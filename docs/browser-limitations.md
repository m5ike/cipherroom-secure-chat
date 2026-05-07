# Browser limitations

Plain truth about what browsers can and cannot do — useful when
explaining behaviour to users.

## Background timers

When a tab is hidden, browsers throttle JavaScript timers to roughly
**one tick per minute** (Chrome since 2020). Firefox and Safari
behave similarly. The connection-keeper compensates by re-opening
the WebSocket on `visibilitychange` rather than trying to keep it
alive in the background.

## Background WebSockets

There is no API to keep a WebSocket open while the tab is hidden on
mobile. iOS Safari aggressively suspends background tabs. Chrome on
Android often closes idle WebSockets after a few minutes. The only
way to wake the page from the background is via a Web Push
notification handled by the service worker.

## Push notifications

- **Chromium browsers (desktop, Android)**: full Web Push.
- **Firefox**: full support.
- **iOS 16.4+ Safari**: requires PWA install before push works.
- **Older iOS**: not supported.

## Service workers

Available in all modern browsers. Lifecycle:

1. `install` runs once when registered or updated.
2. `activate` runs when the worker takes control.
3. `push`, `notificationclick`, `message` — the events we use.

Workers are killed when idle and re-launched on demand (push, etc.).
Code paths that assume `self` survives between events will misbehave.

## getUserMedia / WebRTC

- Requires a secure context (HTTPS or localhost).
- `enumerateDevices()` returns labels only after the user grants
  permission.
- Mobile browsers may suspend captured streams when the tab is
  backgrounded — the call drops audio/video until the tab returns.

## Web NFC

Android Chrome only. No iOS support. Desktop browsers do not expose
the API. Use the dedicated unsupported banner for everyone else.

## Web Speech API

- `speechSynthesis` (TTS): all major browsers.
- `SpeechRecognition` (STT): Chromium-based browsers and Android
  Chrome. **Not** in Firefox or non-iOS Safari.

## Storage

`localStorage` quotas vary (5–10 MB typical). `IndexedDB` is much
larger but eviction-policy-dependent. We use `localStorage` only for
preferences; messages and keys never persist.

## Geolocation

Always permission-gated. `enableHighAccuracy: true` activates GPS on
mobile but drains battery. Some VPNs and corporate networks block or
fuzz the result.

## File system access

`showSaveFilePicker` is Chromium-only at the moment. Other browsers
fall back to the classic anchor-download approach we use here.
