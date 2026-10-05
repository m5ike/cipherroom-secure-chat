# M5Net — the network layer of M5cet for iOS, iPadOS and watchOS

Port of the Android app's networking (`android/app/src/main/java/cz/m5cet/app/` — `net/*`, `account/*`,
`push/*`, `update/*`, the hub parts of `chat/*`, `rtc/Rtc`, `security/{ServerPin,SignedPolicy}`) to Swift 6
(strict concurrency: actors for connection state, `Sendable` models). Foundation, URLSession, Network
(tests only), CryptoKit (SHA-256, P-256 verification, AES-GCM of design bundles) — no third-party code.
The byte helpers it calls (`Bytes.b64`, `Bytes.unb64`, `Bytes.hex`, `Bytes.same`, … for `Data`) are M5Core's,
`Bytes.sha256` / `Bytes.random` M5Crypto's.
Builds for iOS, iPadOS, watchOS and macOS 26.

Everything that needs a secret key comes in through a protocol (§ 2): M5Crypto and the app's Platform
layer (Secure Enclave, Keychain) implement them; tests use small CryptoKit versions.

## 1. What is here

| Android | Swift (M5Net) | What it does |
|---|---|---|
| `chat/RoomSession` (socket, join, frames) | `HubConnection` (actor) | one room's WebSocket to the hub: hello → join with the proof → joined; resume secret; `auth`; presence (≤ 1 per 6 s, the latest); ping 25 s, dead after 75 s silent; reconnect `random·min(120 s, 1 s·2^n) + 250 ms`; 4001 / 4003 / `room-blocked` / `room-full` / a refused proof stop it; `pause()` closes without `leave` (the hub keeps us as away); `events: AsyncStream<HubEvent>` |
| `chat/Rooms` (connections) | `HubRooms` (actor) | the open rooms — **one socket per room** (the hub's `join` leaves the room a socket was in) — policy limit `rooms.max`, foreground, account, pause / resume / shutdown |
| `net/WebSocket` | `HubTransport`, `URLSessionHubTransport` | `URLSessionWebSocketTask`, no Origin header, custom close codes (4001 / 4003) arrive |
| frames (`server/signaling/frames.ts`) | `HubClientFrame` (+ `validate()`), `HubServerFrame`, `HubWire`, `BinaryChunkFrame` | every v2 frame both ways; the encoder writes the hub's normalized form; `validate()` checks what `parseFrame` checks |
| `server/signaling/limits.ts` | `HubRateLimiter`, `HubLimitClass` | the hub's token buckets mirrored; `rate-limited` blocks a class for `retryAfterMs` |
| `chat/RoomSession.hubProof`, `p4/HubProof` | `HubProofFrames`, `HubProofSigner`, `HubSeedSigner` | the join frame's proof over `m5cet/hub-join/4\|roomId\|nonce` — its bytes and keys are M5Crypto's `HubProof` (joinData, pub, build, verify); legacy retry (`legacyAllowed`), proofs skipped 1 h after |
| `chat/Resume` | `HubResumeStore`, `StoredResumeStore` | peer id + resume secret per room (record `resume`, ≤ 64 rooms) |
| `chat/P4Relay` | `RelayDirectory`, `RelayDeviceChecker` | `key-bundles` / `kt-lookup` cache and questions, which devices to seal for, the `relay` frame with `per` / `mb-set` / room envelope |
| `p4/Kt.State` | `KtMonitor` (actor), `KtVerifier`, `KtStateStore` | pinned KT key, consistent heads, unreachable → pending → unproven (24 h), gossip / split view, lookups |
| `chat/P4Device` (KT, upload) | `KtService`, `KtClient`, `KeyDirectoryClient`, `KeyDirectoryUploader` | `/api/kt/*`, refresh every 10 min, own-entries check (unknown device / account key), `PUT /api/keys/bundle` once per bundle, 429 kt-quota |
| `net/Server` | `DeviceAPIClient`, `DeviceSigning`, `RequestSigner`, `HTTPClient` | `/api/ios/*`, signed `m5android/1|METHOD|path?query|time|nonce|b64(sha256(body))` (P1363), presigned requests |
| `security/ServerPin` | `ServerKeyPin` | kid / fingerprint / SHA-256 pins against the key itself |
| `security/SignedPolicy`, `core/Config` | `SignedDevicePolicy`, `DeviceState`, `DeviceEnrollment` | `m5policy/1|…`, never older; the device record (Android's field names) |
| `account/EnrollLink` | `EnrollLink` | `m5cet://enroll?server=…&code=…&kid=…` |
| `push/Checkin` | `Checkin`, `DeviceStatusReport`, `CheckinSchedule` | the check-in body (iOS fields), the answer: policy, commands, bundle, release, `minBuild` / `updateRequired` |
| `push/Control`, `push/FcmService` | `ControlInbox` (actor), `EciesOpener` | `m5push/1|…` signature, ECIES open (purpose `push`), dedupe (300), expiry; `ControlInbox.wire(fromPush:)` reads the APNs payload's `m5` |
| `update/BundleFile`, `update/Bundles` (download) | `DesignBundleFile`, `DesignBundles` | M5AB: header signature + kid, ciphertext hash, the content key for this device, AES-GCM segments, content hash → gzipped M5PK for M5Design |
| `update/Releases` | `ReleaseRecord`, `ReleaseWatcher` | iOS release records signed `m5iosrelease/1|…` (no APK), minimum build |
| `account/Account`, `RegisterDialog` (API) | `AccountClient`, `AccountSummary`, `AccountSend` | sign-up / registration form / sign-in (locked) / unlock / me / sign-out / delete, passkeys, recovery, sessions, identity, profile; must-get-through calls retried on network failures only |
| `account/AccountKeys` (WebAuthn part), `account/Passkeys` | `PasskeyCreationOptions`, `PasskeyRequestOptions`, `PasskeyRegistration`, `PasskeyAssertion`, `Passkey` | the server's options → AuthenticationServices parameters (PRF salt `m5cet:passkey:prf:v1`), its results → webauthn.ts JSON |
| `account/Account` (vault, slot revisions) | `VaultContents`, `VaultPatch`, `VaultSlotFormat`, `VaultSlotRevisions` | parts as bytes; the v2 header's revision read without the key; rollback detection (`account.slots`) |
| `push/NotifyPrefs` (server part) | `NotifyPrefs`, `NotifyClient`, `NotifyLink` | `PUT /api/account/notify`, `/notify/test`, `/api/notify/config`, the device ↔ account link (`/api/ios/notify`) |
| `rtc/Rtc` (ICE) | `IceServerCache`, `TurnAnswer`, `IceServer` | `/api/turn`, a `pending` answer never cached, TTL − 60 s, STUN fallback |

## 2. What the app and the crypto layer must provide

| Protocol | Who | What |
|---|---|---|
| `RequestSigner` | Platform/Security | the device signing key: `publicKeySPKI()` (SPKI DER b64), `signP1363(data)` (ECDSA P-256/SHA-256, r‖s). `SecureEnclaveRequestSigner` is ready (keep its `dataRepresentation` in the Keychain); `SoftwareRequestSigner` for the simulator / tests |
| `EciesOpener` | M5Crypto (+ Secure Enclave key agreement) | the device encryption key: `publicKeySPKI()` (`/enroll` `encKey`) and `open(wire, deviceId, purpose)` — ECDH P-256 with `e`, HKDF-SHA256(salt `m5cet/android/ecies/1`, info `<purpose>|<deviceId>`), AES-256-GCM with AAD `m5cet/android/ecies/1|<purpose>|<deviceId>`; purposes `push`, `bundle|<id>` |
| `HubProofSigner` | M5Crypto (per room) | Ed25519 from hubSeed = RoomKeys.derive(`m5cet/hub-auth/4`, 32): `signHubJoin(message)` → (raw public key 32 B, signature 64 B); `HubSeedSigner(seed:)` is M5Crypto's Ed25519 over the seed |
| `KtVerifier` | M5Crypto (Kt, Merkle) | `verifySTH` (`m5cet/kt/sth/4|size|root|ts`, Ed25519), `verifyConsistency` (RFC 6962), `verifyLookup` (canonical entries, inclusion, `u`) |
| `RelayDeviceChecker` | M5Crypto (Handshake, Mailbox) | `certifiedAccountKey(certificate:devicePublicKey:now:)` (device certificate v2) and `bundleValid(_:devicePublicKey:now:)` (Mailbox.check) |
| sealing for the relay | M5Crypto (Mailbox) | the `seal` closure of `RelayDirectory.frame` (one `mb` item per device) and the protocol-3 room envelope |
| `NetStateStore` | Platform (Keychain / Data Protection) | JSON documents by key, Android's records: **system tier** (readable locked): `config` (DeviceState), `seen` (control ids); **user tier**: `resume`, `kt` (KtOriginState per origin, via `StoredKtStateStore`), `kt-own`, `key-upload`, `account.slots` |
| `HubTransport` / `HTTPTransport` | (optional) | defaults are URLSession; the watch may relay through the phone |
| key proof, root sealing, vault slot crypto, account key | M5Crypto (AccountKeys) | M5Net carries their outputs: `keyProof` (b64url 43), `wrapped` {iv, ct}, slot ciphertexts (b64) |

The app also fills `DeviceDescription` (model, `modelName`, `idiom`, `osVersion`, build = `CFBundleVersion`),
`DeviceStatusReport` (battery, network, lock, `policyAt`, `biometry`) and `PushTokens` (APNs token hex
`PushTokens.hex(deviceToken)`, PushKit token, `apnsEnv` from the `aps-environment` entitlement; nil = unchanged,
"" = notifications off).

## 3. Server endpoints used

* Hub: `wss://<server>/ws` — frames of `server/signaling/frames.ts` (protocol 2): `join` (+`proof`, `resume`,
  `features:["bin"]`, `foreground`), `auth`, `leave`, `signal`, `ping`, `presence`, `relay` (+`per`), `relay-ack`,
  `receipt`, `command-poll`, `command-ack`, `storage`, `proxy-*`, `key-bundles`, `kt-lookup`; binary proxy chunks.
* Device: `/api/ios/info`, `/enroll`, `/checkin`, `/ack`, `/notify`, `/events`, `/message-audit`, `/location`,
  `/bundles/:id`, `/releases/:id` (`DeviceAPIConfig.android` talks to `/api/android/*` with Android's fields).
* Accounts: `/api/account/{status, countries, register/options|check|start|verify, signin/options|verify, unlock,
  me, vault, event, signout, passkeys/options|verify|:id|:id/wrapped, recovery, recovery/start|finish, sessions,
  sessions/:id, identity, notify, notify/test}`, `DELETE /api/account`, `/api/profile…`, `/api/notify/config`.
* Keys and KT: `PUT /api/keys/bundle`, `/api/kt/{key, sth, lookup?u=, consistency?from=&to=}`.
* `/api/turn`.

## 4. iOS notes

* A socket lives only in the foreground and briefly after: on `scenePhase == .background` call
  `HubRooms.pauseAll()` (closed without `leave` — the hub lists the member as away and keeps relayed messages,
  `auth` with `away: true` makes the server wake the device through APNs); on return `resumeAll()` comes back as
  the same member (resume secrets).
* The APNs payload carries the control message under `m5` (`ControlInbox.wire(fromPush:)`); the Notification
  Service Extension can run `ControlInbox.handle` with the system-tier store and the device's `EciesOpener`.
* Releases: `ReleaseWatcher.mustUpdate(appCode:serverMinBuild:release:)` before anything else when the check-in
  says `updateRequired` or `/info` reports a `minBuild` above the build.
* The notifier's channel id `"android"` is the mobile-app channel and wakes linked iOS devices too.

## 5. Tests

`swift test --package-path ios/M5Kit --filter M5NetTests` (100 tests). Golden fixtures in
`Tests/M5NetTests/fixtures/` are made by the server's own code — regenerate with
`npx tsx ios/M5Kit/Tests/M5NetTests/fixtures/generate-fixtures.ts` (a throwaway `DATA_DIR` and storage key):

* `hub-frames.json` — client frames through `parseFrame`, frames it refuses, and frames a live `SignalingHub`
  sent over real sockets (hello, joined, peers, presence, relay `per`, key directory, KT, errors, 4001 / 4003…);
* `device-vectors.json` — request / enrolment / policy / release signatures by `server/mobile/crypto.ts`, a push
  sealed with `eciesSeal`;
* `ios-api.json` — a device's session through the real `/api/ios/*` routes (info, enroll, check-in with a bundle
  offer, a release record and a sealed command, the M5AB file, the signed release, ack, events).

Also read from the repository: `test/vectors/p4.json` (hub proof, KT) and `test/fixtures/android-interop.json`
(M5AB bundle and push for the Android vector device). Integration: URLSession WebSocket against a local
Network.framework server (custom close codes arrive), URLSession HTTP through a URLProtocol stub.
