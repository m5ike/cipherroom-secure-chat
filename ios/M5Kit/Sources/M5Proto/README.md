# M5Proto

The chat protocol of M5cet without UI and without transport: what a connected room does with the hub's frames
and the peers' data-channel texts, the message model and its validation, sending, the outbox, history, the
lock inbox, trust, protocol 4's per-device state, file transfers, calls' history, saved rooms, the `fn/*`
command logic and the profile exchange. Ported from `android/app/src/main/java/cz/m5cet/app/{chat,fn,profile}`.

M5Net (sockets, HTTP) and the app (WebRTC, the vault, UI) plug in through small protocols; everything in here is
deterministic given a `Clock` and an `Rng`, and tested on macOS.

## A connected room

```swift
let session = RoomSession(key: saved.key, room: saved.room, label: saved.label, userName: saved.userName,
                          keys: roomKeys,                // M5Crypto.RoomKeys (Argon2id, derive off the main actor)
                          identity: chatIdentity,        // M5Crypto.ChatIdentity (Secure Enclave signer in the app)
                          transport: myTransport,        // RoomTransport: hub socket + data channels
                          events: myEvents,              // RoomEvents: bubbles, peers, signals, files, profile
                          device: p4Device,              // P4Device: protocol 4's store, mailbox, account, KT
                          pins: namePins,                // NamePins (vault record "pins")
                          verifiedDevice: { pk in … },   // the user verified this device key
                          settings: RoomSettings(), ktFetch: fetcher)
await session.socketOpened()            // then feed every hub frame:
await session.hubText(text)             // or hubFrame(JSONObject)
await session.channelOpened(peerId)     // the WebRTC data channel opened
await session.peerText(peerId, text)    // text from it
let bubble = await session.send(Outgoing(text: "ahoj"))
await session.disconnected()            // left / closed: timers stop, the replay window is saved
```

- `RoomSession` (actor) owns a `RoomCore` (the synchronous protocol logic; android `RoomSession.java`) and adds
  the timers: join fallback (4 s without the hub's hello), receipt batches (400 ms), parked relays, message
  expiry, saving the replay window (5 s after a change). `withCore { … }` reads the core for the UI.
- `RoomTransport`: `sendHub(frame)`, `sendText(peerId, text) -> Bool`, `isOpen(peerId)`.
- `RoomEvents`: `added(message, fresh:)`, `changed(message)`, `roomChanged()`, `createPeer(peerId, name:,
  initiator:)` (make the WebRTC peer; `initiator` offers), `dropPeer`, `signal(from:, description)` (an opened
  WebRTC signal), and optional `peerAudio`, `fileFrame`, `proxyFileKey`, `profileFrame`, `profileHello`,
  `lockedState`, `joined(peerId:, resume:)`.
- WebRTC signals go through `session.sendSignal(peerId, description)` — sealed with the room's signal key.
- The join carries the room proof (`HubProof`, § 13) when the hub sent a nonce; S14's refusal handling is in
  `RoomCore.proofRefusal`.
- `RoomCore` picks the envelope per peer (`envelopeFor`): protocol 4 (`P4Room`) for a peer whose hello is v4 (and
  never anything else for a device that spoke protocol 4 before), else pair / sender-key / room envelopes; a
  private message never falls back to the room key.

`RoomSessionTests` runs two and three sessions over an in-memory hub: join with the proof, sealed signals,
hellos, the protocol-4 handshake, a message, its receipt, a reply, a private message.

## Protocol 4 per device

| Swift | Android | What |
| --- | --- | --- |
| `P4Room` (+ `P4RoomLink`, `P4HelloExtras`) | `chat/P4Room` | one room's pair sessions and sender keys v4: hellos, KEM, ratchets, resets, sender chains |
| `P4Store` (`RecordVault` backed), `P4ReplayWindow` | `chat/P4Store` | pins (account per reference, per name), devices seen, mailbox keys, the replay windows (fail closed on a read error, review P10), the downgrade marks |
| `P4Device` (+ `P4AccountProvider`) | `chat/P4Device` | this device's mailbox, account certificate (renewed with a third of its life left), the key-directory upload body, KT pinning / refresh / self check / gossip (`KtState` actor) |
| `P4Relay` | `chat/P4Relay` | the key directory's devices of a member (pinned account, KT, remembered devices — review P01) and the `relay` frame: one sealed mailbox set per member, the room envelope only as the fallback |
| `ProxyKeys` | `chat/ProxyKeys` | proxied files' keys from sealed signals; frames parked until the key arrives (review P07) |
| `IdentitySigner` | — | a `ChatIdentity` as `DeviceSigner` |
| `P4Texts` | `chat/P4Texts` | the protocol's UI strings (through `Texts`) |

## Messages and the chat model

| Swift | Android | What |
| --- | --- | --- |
| `ChatMessage` | `chat/ChatMessage` | the bubble model, `json` / `from`, `scope` (the design's `$message`), `timeline`, `notifyText`, `visibleText` |
| `Payloads` | `chat/Payloads` | the incoming payload validated like the web: sender binding, bounds, safe files / mime, locations, receipts |
| `Outgoing`, `SendPlan` | `chat/Outgoing`, `SendPlan` | what Send sends; what the send button does (voice, dictation, tap, vanish, seal) |
| `Trust`, `Verified`, `NamePins` | `chat/Trust`, `Verified` | trust states (`Trust.of`), verified-under-name (P08), forwards verified by key (P09), name pins |
| `History`, `Resume`, `RecordVault`, `MemoryRecordVault` | `chat/History`, `Resume` | each room's log (record `hist-<hash>`), the resume secret |
| `LockedRooms`, `LockInbox` | `chat/LockedRooms` | while locked: what arrives is sealed to the lock key (`M5Crypto.LockBox`) and merged at the unlock |
| `PeerFacts`, `RoomPresence` | `chat/PeerFacts`, `RoomPresence` | usernames, accounts, away members, foreground / last seen |
| `CallTrack` (+ `Kind`, `millis`), `CallHistory`, `CallHistoryStore`, `ActivityLog` | `chat/CallTrack`, `CallHistory`, `ActivityLog` | call state steps, the call log (Android's JSON byte for byte, read as tolerantly as org.json), the activity log — the only implementation: the app's `AppCallHistory` (Platform/Calls) is a main-actor adapter over `CallHistoryStore` |
| `SavedRoom`, `SavedRooms` | `chat/Rooms` (storage, Clone) | the user-tier record `rooms`; `cloneName`, `copy`, the NFC card of a room |

The app implements `RecordVault` (`record`, `recordStrict` — nil for a damaged record, `put`, `delete`,
`unlocked`) with its Keychain / Secure Enclave–wrapped vault.

## Files

- `FileTransfer` — protocol 3 (`Lane.p3`: the room's file key) and protocol 4 (`Lane.p4`: a per-transfer key)
  file frames: `meta`, `bodyFrame` (meta / end), `sealChunk`, `chunkFrame`, `binaryFrame` / `parseBinary`
  (the web's binary chunk), `openMeta` → `Incoming` (`accept`, `missing`, `needFrame`, `finish` checks the
  end's root), `decryptSlots`. `ChunkSlots` is where received chunks wait (still encrypted): a file in the app.
- `FileVaultFormat` — files at rest: `"M5F1" | nonce | segments` (64 KiB AES-GCM segments, the last one marked),
  `Writer` / `Reader` (random access).

## fn and profiles

- `fn/*`: `Js` (JavaScript string / number semantics), `Outputs` (a command's output types, sanitising, Markdown),
  `FnHtml` (the HTML subset), `CssColor`, `Command`, `Commands` (triggers, composer, parsing, inputs, forms,
  answers), `CommandCheck`, `ModelIdentity` (reserved senders, safe icons), `Fuzzy`, `Usage`, `ArgHint`,
  `Suggestions`. Network calls (`Run`, `Api`, `Sse`) are M5Net's.
- `profile/*`: `ProfileCard`, `WhoSees`, `ProfileRoom` (the profile exchange in a room: `Exchange`, `Cache`,
  `Deps`), `Profiles` (`planSave` → PUT / DELETE by the app → `finishSave`; lookups), `ProfileImages` (the encode
  ladder; the app gives the `Renderer`).

Indexes in `fn/*` (cursors, spans, hits) are UTF-16 offsets, as in Java — usable as `NSRange`.

## Deviations from Android

- `RoomCore` + `RoomSession` replace the threads of `RoomSession.java` with one actor; the timers are tasks.
- `RecordVault.recordStrict` replaces `Vault.jsonStrict`; a vault that cannot tell damaged from absent may use
  the default (`record`).
- `ProfileCard.normalizeShared` measures with `JSON.stringify` (the web), not Android's `toString()` (which
  escapes `/`).
- Not ported (UI or network): `ReplyQuote` and other views, `FnHtmlView`, `Run.meta` / `Run.Done`, the network
  parts of `Commands`, `Rooms`' connection management (the app's).
