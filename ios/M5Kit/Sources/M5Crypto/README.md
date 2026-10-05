# M5Crypto

The cryptography of M5cet on iOS / watchOS: protocol 4 (the 6.12 protocol), protocol 3 (rooms, envelopes,
sender keys), device and account keys, the vault's slots and the NFC tags. Ported from the Android app
(`android/app/src/main/java/cz/m5cet/app/{p4,chat,security,account,nfc}`). Interop is proven only by the shared
vectors, byte for byte:

| Vectors | Tests |
| --- | --- |
| `test/vectors/p4.json` — every section, including the whole ratchet script | `PrimitivesVectorTests`, `HandshakeRatchetVectorTests`, `MessagesVectorTests`, `ServerSideVectorTests` |
| `test/fixtures/android-interop.json` — Argon2id, room keys, envelopes, signals, pair / sender keys, files, push | `Protocol3InteropTests` (and `ParityTests` in M5Proto) |
| `test/vectors/nfc-tag-v2.json` | `NfcTagV2VectorTests` |
| Android `VaultSlotTest`, `AccountKeysTest`, `RecoveryCodeTest` constants | `AccountAndSecurityTests` |

Everything is a value type, a `Sendable` final class guarding its state with a `Mutex`, or an actor (`KtState`).
Nothing here touches UIKit / AppKit; it builds for iOS 26, watchOS 26 and macOS (the tests).

## Primitives

- `Crypto` — random, SHA-256/512, HMAC, HKDF, PBKDF2, AES-256-GCM (iv ‖ ct ‖ tag), base64 / hex (protocol-3 naming).
- `Prim` — protocol 4's primitives (`docs/protocol-4.md` § 0): `join`/`joinText` (the length-prefixed transcript),
  `H`, `hmac`, `hkdf(salt, ikm, info, n)`, `keyIv`, `aesGcmSeal/Open(key, iv, aad, …)`, P-256 (`p256Public`,
  `ecdsaSign/Verify` raw r‖s), Ed25519 (`ed25519Public/Sign/Verify`, RFC 8032 deterministic), strict base64.
- `SHA3` — SHA3-256/512, SHAKE-128/256 (ML-KEM's hashes).
- `Kem` — ML-KEM-768 (FIPS 203): `keygenFromSeed(d ‖ z)`, `keygen(rng)`, `encapsWith(ek, m)`, `encaps(ek, rng)`,
  `decaps(ct, dk)` with the expanded 2400-byte dk, the ek modulus check and the dk hash check.
- `Pad` — the bucket padding of protocol-4 bodies.
- `Ec` / `Ecies` — SPKI / PKCS#8 / DER ↔ P1363, key ids, fingerprints; ECIES `m5cet/android/ecies/1`.
- `Argon2.argon2id(...)` — through the vendored PHC reference implementation (`CArgon2`, `m5_argon2id_ext`).
  One derivation at a time (each holds its memory; a room takes 64 MiB).

### Why some primitives are pure Swift

CryptoKit is used wherever it can produce the protocol's bytes (P-256, AES-GCM, SHA-2, HKDF, HMAC). Two cannot:

- **Ed25519**: `Curve25519.Signing` signs with a random nonce. Valid, but the vectors (hub proof, KT tree heads,
  release manifests, v2 device certificates) need RFC 8032's deterministic signature. `Ed25519.swift` signs and
  verifies (strict, as Bouncy Castle: S < L, canonical A and R); the tests cross-check it against CryptoKit.
- **ML-KEM-768**: CryptoKit's `MLKEM768` keys come from the 64-byte seed, but it cannot encapsulate with a given
  m (the vectors) nor import an expanded 2400-byte decapsulation key (what Android stores). `MLKEM768.swift`
  implements FIPS 203; the tests check it against CryptoKit both ways (CryptoKit decapsulates our ciphertexts, we
  decapsulate CryptoKit's, same seed → same ek).

**ML-KEM seeds**: a fresh KEM key is drawn as the 64-byte seed d ‖ z (`Kem.keygen` asks the `Rng` for 64 bytes)
and expanded to (ek, dk); what is kept is dk (2400 bytes, as Android and the web keep it). An app that wants
the Secure Enclave or CryptoKit to hold the KEM key can keep the seed instead — `Kem.keygenFromSeed` gives the
same pair as `MLKEM768.PrivateKey(seedRepresentation:)`.

### Keys that may live in the Secure Enclave

```swift
public protocol DeviceSigner: Sendable { var publicKey: String { get }; func sign(_ data: Bytes) throws -> String }
public protocol KeyAgreer: Sendable { var spki: String { get }; func agree(with: P256.KeyAgreement.PublicKey) throws -> Bytes }
```

`SoftwareSigner` / `P256Pair` are the software implementations; the app implements both with
`SecureEnclave.P256` keys. Signatures are raw r‖s (P1363), base64.

### Randomness

`Rng` (`bytes(n, what)`, `p256(use, what)`): `SystemRng` in the app, `TapeRng` replays a vector's tape,
`RecordingRng` records one. Every protocol-4 function that draws randomness takes an `Rng`.

## Protocol 4

| Swift | Android (`p4/`) | What |
| --- | --- | --- |
| `P4` | `P4` | constants (lifetimes, limits, labels) |
| `Handshake`, `PairHandshake` | `Handshake` | hello v4 (`buildHello`, `verifyHello` → `Verdict`), digests, KEM message, roles, transcript hash, root schedule, `establish` → `Session`; device certificates v1 / v2, `verifyAccount` |
| `Ratchet` | `Ratchet` | the Double Ratchet with the KEM ratchet (copy-on-write state, skipped keys, failure decay, resets) |
| `SenderKeys4` | `SenderKeys4` | room sender keys with chain certificates |
| `Mailbox`, `MailboxStore`, `MemoryMailboxStore` | `Mailbox` | signed bundles, sealed items and sets (sacc digest), rotation |
| `Files4`, `Media4` | `Files4`, `Media4` | per-transfer file keys and AADs; media frame encryption |
| `HubProof` | `HubProof` | the room proof the hub checks (§ 13) — M5Net's `HubProofFrames` / `HubSeedSigner` put it in the join frame |
| `Merkle`, `Kt`, `KtState` (actor), `KtStore` | `Merkle`, `Kt`, `KtState` | RFC 9162 proofs, tree heads, lookups, per-origin pinning, pending proofs, gossip, alerts |
| `ReplayGuard`, `ReplayStore`, `Replay` | `Replay` | the replay window |
| `Release` | `Release` | release manifest signatures |

## Protocol 3 and the rest

| Swift | Android | What |
| --- | --- | --- |
| `RoomKeys` | `chat/RoomKeys` | Argon2id (64 MiB, 3 passes, 1 lane) → HKDF tree: message / signal / files keys, room id `r3.…`, check, hub seed; `normalizeRoom`; v2 (PBKDF2) fallback |
| `Envelopes` | `chat/Envelopes` | `"m5cet/2|…"` contexts, room messages, sealed signals, file bodies and chunks |
| `SenderKeys` | `chat/SenderKeys` | hellos, pair keys, sender keys v3, private messages |
| `ChatIdentity` | `chat/ChatIdentity` | the chat identity (signing + ECDH), safety number |
| `Sealed` | `chat/Sealed` | code-sealed messages (PBKDF2 600 000; a sender's iteration count is bounded) |
| `SignedPolicy`, `IntentSeal` | `security/SignedPolicy`, `IntentSeal` | the server-signed device policy; intent tags |
| `LockBox`, `PinWrap` | `security/LockBox`, `PinWrap` | the lock inbox's ECIES records; the PIN-wrapped data key |
| `AccountKeys`, `RecoveryCode` | `account/AccountKeys`, `RecoveryCode` | account seed / key (`m5cet:account:v1`), root wrapping, profile key, vault slots v2, passkey PRF helpers, recovery codes |
| `TagV2`, `ShareInvite`, `ConnTagV1`, `ConnTag` | `nfc/TagV2`, `ShareInvite`, `ConnTag` | NFC tag v2 (offline Argon2 seal, invites), the v1 connection card — the only implementation; the Argon2id can be handed in (`TagV2.KeyDerivation`, default `TagV2.argon2id`); M5NFC's `NfcTagV2` / `NfcShareInvite` / `NfcConnTag` wrap these with its `TagKdf` / `ShareInviteHTTP` seams |

## Deviations

None in the bytes: every vector section passes. Differences in behaviour:

- Ed25519 and ML-KEM are not CryptoKit (see above).
- `Argon2` serialises derivations with a `Mutex` (Android: a lock); it does not report peak concurrency.
- Timing: a room derivation (64 MiB, 3 passes) takes ≈ 95 ms in a release build on an Apple-silicon Mac and
  ≈ 0.8 s in a debug build (the C target at -O0). Expect a few hundred ms on a phone; 64 MiB is a lot for a
  watch — the watch app should get room secrets from the phone (`RoomKeys.fromSeed`) rather than derive them.

## M5Core (used throughout)

- `Bytes` (= `[UInt8]`), `B64`, `Hex` (`encode` lower case, `upper`, `decode` strict, `decodeLenient` = Apdu.unhex), `UTF8Text`,
  `ByteOps`, `Ordinal` (Java's string order), `String.javaTrimmed`; the `Bytes.…` helpers every module calls
  (`u8`, `concat`, `slice`, `latin1`, `asciiString`, `constantTimeEqual`, and for `Data`: `b64`, `b64url`, `unb64`,
  `unb64url`, `unb64any`, `hex`, `unhex`, `same`, `be32`). This module adds `Bytes.sha256(Data)` and `Bytes.random(n)` (→ `Data`).
- `JSON` / `JSONObject` / `JSONNumber` — ordered keys, JavaScript number formatting (`JSON.stringify` output),
  `JSON.parse`, `JSON.canonical`; `JSONObject` accessors `string`, `optString`, `int`, `optInt`, `int64`,
  `optInt64`, `double`, `bool`, `object`, `array`, `has`, `with`, `without`.
- `OrderedMap` — insertion-ordered dictionary.
- `Clock` (`SystemClock`, `ManualClock`, `ClosureClock`) — milliseconds since the epoch.
- `M5Log` — leveled log ring; never pass secrets (keys, passphrases, plaintext).
- `Locales`, `Plurals`, `Formats`, `Names`, `Texts` (`Texts.setProvider` — the app's string table, `t`, `f`, `n`).
