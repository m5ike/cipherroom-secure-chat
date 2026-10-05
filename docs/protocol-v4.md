# M5cet protocol 4 (6.12) — specification

Status: normative for 6.12. Constants and wire shapes: `client/src/lib/p4/contract.ts`.
Shared Merkle code: `client/src/lib/p4/merkle.ts`. Test vectors: `test/vectors/p4.json`
(produced by the web reference implementation, consumed by the Android tests).

Protocol 4 replaces what `docs/security-analysis.md` lists as the design gaps of protocol 3:
static pair keys without forward secrecy or post-compromise security (F-06), no post-quantum
protection, messages for absent members under the room key (F-09), per-message signatures
that are non-repudiable (F-30), media keys reused across calls (F-19), old envelope versions
still accepted (F-20), replay protection only in memory (F-21), the hub admitting anyone who
knows a blind room id (G-09), trust on first use by name without key transparency (F-13).

Nothing is taken away: a 6.12 client still talks protocol 3 to an older peer (§ 1), and every
message kind, file, call, function and plug-in keeps working over protocol 4.

## 0. Notation and primitives

* `b64` — standard base64 with padding; `b64url` — URL alphabet, no padding.
* `join(a, b, …)` — the UTF-8 bytes of the parts joined with `|`. Every part is ASCII
  (base64, base64url, decimal integers, the labels of `LABEL`, peer ids, the blind room id);
  a part is never allowed to contain `|`. Integers are written in decimal without leading zeros.
  A part must be printable ASCII (0x20–0x7E) without `|`, an integer a non-negative safe integer;
  an operation whose transcript would hold any other part fails (e.g. a message id with `|`).
* `H(x)` — SHA-256. `HMAC(k, m)` — HMAC-SHA-256. `HKDF(salt, ikm, info, L)` — RFC 5869 with
  SHA-256; `info` is the UTF-8 of the label. `H` of a field that travels in base64 (`k`, `kem`,
  `kct`, `kek`, `ct`) hashes its decoded bytes, never the base64 text.
* P-256 public keys: SPKI DER, base64. ECDH output: the 32-byte x-coordinate (WebCrypto
  `deriveBits(…, 256)`, Java `KeyAgreement("ECDH").generateSecret()`).
* ECDSA: P-256 with SHA-256, signature in raw `r||s` form (64 bytes), base64.
* ML-KEM-768: FIPS 203. Encapsulation key 1184 B, decapsulation key 2400 B, ciphertext 1088 B,
  shared secret 32 B. Web: `@noble/post-quantum` `ml_kem768`; Android: Bouncy Castle
  `org.bouncycastle.pqc.crypto.mlkem` (FIPS 203 final). Key generation may be seeded with 64 bytes
  (`d||z`) — tests only.
* Ed25519: RFC 8032 (account keys, hub proof, key-transparency and release signatures).
* AES-256-GCM, 12-byte IV, 16-byte tag appended to the ciphertext.
* `roomId` — the blind room id (`r3.…`, `RoomKeys.roomId`); protocol 4 never uses the readable
  room name in a transcript or associated data.
* `pad(m)` / `unpad(m)` — § 10.
* Order of random draws (it matters only for replaying the vectors' tapes): a hello draws `e`, the
  `k` seed (64 B), `n`; a KEM message draws m (32 B); the initial ratchet draws (A) `DHs` then the
  `myKem` seed, (B) the `myKem` seed; a sending ratchet step draws `DHs`, m (when it encapsulates),
  the new `myKem` seed; a bundle draws `id`, `dh`, its KEM seed; a mailbox item draws `eph`, m; a
  sender-key chain draws `keyId`, `CK`, `spk`.

## 1. Versions and negotiation

* A 6.12 client lists `"p4"` in its hello `caps` and sends a **hello v4** (§ 2), which keeps
  every protocol-3 field and the protocol-3 signature, so a 6.11 peer accepts it as protocol 3.
* When both hellos are v4 with a valid `sig4`, the pair runs protocol 4. Otherwise protocol 3
  (`sender-keys.ts`), and the UI marks the peer “older protocol (no PCS / PQ)”.
* **No downgrade.** A device key (`pk`) once seen with a valid v4 hello is remembered
  (persistently, per device key). A later hello from the same `pk` without valid v4 fields is
  refused with a visible warning (“protocol downgrade”).
* **Envelope versions 1 and 2 are no longer opened** (F-20): they come only from clients older
  than 3.1. Protocol-3 envelopes (`v: 3`) still are.
* The KEM, ratchet and reset messages travel only on the peer's data channel (reliable,
  ordered: `createDataChannel(…, { ordered: true })`).

## 2. Hello v4

```
{ kind:"hello", v:4, check, pk, dh, sig, caps:[…,"p4"], user?,
  e, k, n, mb, acc, sth, sig4 }
```

* `check`, `pk`, `dh`, `sig` — exactly as protocol 3 (`sig` over the v3 hello context).
* `e` — a fresh ephemeral P-256 ECDH key pair per hello (per data-channel open); `k` — a fresh
  ML-KEM-768 key pair per hello. Private halves live in memory only and are wiped once the
  session is established or the channel closes.
* `n` — 16 random bytes, b64.
* `mb` — this device's current signed mailbox bundle (§ 7.1) or `null`.
* `acc` — `{ apk, ac, cv?, exp? }` when signed in: the account key and its certificate for this
  device (`cv: 2` with `exp` for a v2 certificate, § 12.3); else `null`.
* `sth` — the newest signed tree head of key transparency this device knows for the server it
  is connected to (§ 14.4), or `null`.
* `sig4` — ECDSA with the device key over

```
join(LABEL.hello, roomId, from, to, check, pk, dh, e, b64(H(k)), n, mbDigest, accDigest)
mbDigest  = mb  ? b64(H(join(mb.id, mb.dh, b64(H(kem bytes)), mb.exp, mb.sig))) : "-"
accDigest = acc ? b64(H(join(acc.apk, acc.ac, acc.cv ?? 1, acc.exp ?? 0)))     : "-"
```

  `from` is the sender's peer id, `to` the recipient's (as in protocol 3).

The receiver checks `check` (else “key mismatch”), the protocol-3 `sig`, `sig4`, and — when `mb`
is present — `mb.sig` with `pk` and `mb.exp > now`. A failed `sig4` with a valid `sig` is
treated as a protocol-3 hello (and falls under the downgrade rule of § 1). An `mb` that fails its
checks is ignored (not remembered, never sealed to); the hello itself stands.

## 3. KEM message

After accepting a peer's v4 hello, each side sends, on the data channel:

```
{ kind:"p4-kem", v:4, ct: b64(ML-KEM.Encaps(peer.k)), r }
r = b64(H(join(peer.e, b64(H(peer.k)), peer.n)))
```

`r` names the hello it answers; a KEM message whose `r` is not this side's current hello is
ignored. The receiver decapsulates `ct` with its hello's ML-KEM key. A session exists when a
side has sent its hello, accepted the peer's, sent its KEM message and received the peer's.

## 4. Session key schedule

Roles: `selfKey = pk_self + "|" + selfPeerId`, `peerKey = pk_peer + "|" + peerPeerId`; the side
with the smaller string (ordinal comparison) is **A**, the other **B**.

```
dh0  = ECDH(e_self.private, e_peer.public)
ctA  = the KEM ciphertext A sent (to B's k);  ssA = its shared secret
ctB  = the KEM ciphertext B sent (to A's k);  ssB = its shared secret
TH   = H(join(LABEL.transcript, roomId, check,
              A.pk, A.e, b64(H(A.k)), A.n,
              B.pk, B.e, b64(H(B.k)), B.n,
              b64(H(ctA)), b64(H(ctB))))
okm  = HKDF(salt = TH, ikm = dh0 || ssA || ssB, info = LABEL.root, L = 96)
RK0  = okm[0:32]     CK_B0 = okm[32:64]     SID = okm[64:96]
```

Double Ratchet initial state (symmetric hellos, asymmetric start):

* **A:** `DHs` = a new P-256 key pair; `DHr` = `B.e`; `(RK, CKs) = KDF_RK(RK0, ECDH(DHs, B.e), ∅)`;
  `CKr = CK_B0`; `Ns = Nr = PN = 0`; `myKem` = a new ML-KEM key pair (announced in A's first
  message, § 5.3); `peerKem = ∅`.
* **B:** `DHs` = `B.e`'s key pair (kept from the hello); `DHr = ∅`; `RK = RK0`; `CKs = CK_B0`;
  `CKr = ∅`; `Ns = Nr = PN = 0`; `myKem` = a new ML-KEM key pair; `peerKem = ∅`.

Both sides can send at once. `SID` is the session's export secret (media, § 9) and `TH` binds
every pair message to the session.

## 5. Pair ratchet

### 5.1 KDFs

```
KDF_RK(rk, dhOut, kss)  = HKDF(salt = rk, ikm = dhOut || kss, info = LABEL.ratchet, L = 64)
                          → (rk' = [0:32], ck = [32:64])        kss = 0 bytes when none
KDF_CK(ck)              = (mk = HMAC(ck, 0x01), ck' = HMAC(ck, 0x02))
keyIv(mk, label)        = HKDF(salt = 32 zero bytes, ikm = mk, info = label, L = 44)
                          → (key = [0:32], iv = [32:44])
```

### 5.2 Sending

```
(mk, CKs) = KDF_CK(CKs);  h = { dh: DHs.public, pn: PN, n: Ns, …§5.3 };  Ns += 1
Hs  = join(h.dh, h.pn, h.n, h.kid ?? "-", h.kct ? b64(H(kct)) : "-", h.kek ? b64(H(kek)) : "-")
AAD = join(LABEL.pairAad, roomId, fromPeerId, toPeerId, b64(TH), Hs)
(key, iv) = keyIv(mk, LABEL.pairKey)
c   = AES-GCM(key, iv, AAD, pad(UTF-8(JSON(inner))))
→ { kind:"p4", v:4, h, c: b64(c) }
```

`Hs` is spliced into the AAD as its six parts (its `|` are separators, not part of a part): the
AAD is the flat join of eleven parts `LABEL.pairAad, roomId, from, to, b64(TH), h.dh, …`.

### 5.3 The post-quantum ratchet (KEM in headers)

* A **sending ratchet step** (in § 5.4, step 4) generates a new `DHs` and, when `peerKem` is
  set, encapsulates to it: `(kct, kss) = Encaps(peerKem.ek)`, `kid = b64url(H(peerKem.ek))[0:16]`,
  `peerKem = ∅`; it also generates a new `myKem` key pair. Then
  `(RK, CKs) = KDF_RK(RK, ECDH(DHs, DHr), kss or ∅)`.
* The **first message (n = 0) of a sending chain** carries `kek` = b64 of the sender's current
  `myKem` encapsulation key and, when that chain's step encapsulated, `kid` and `kct`. Later
  messages of the chain carry neither. (A's initial chain and B's chain `CK_B0` carry `kek` in
  their first message.)
* Each side keeps the private keys of its last **three** `myKem` key pairs, found by `kid`.
* On receiving a header with `kek` (any `n`), the receiver sets `peerKem = kek` unless it is the
  ek it already used.

### 5.4 Receiving

1. If `(h.dh, h.n)` is a stored skipped key: use it, delete it, decrypt (nothing else changes;
   a `kek` in such a frame is ignored).
2. If `h.dh ≠ DHr` (a new chain from the peer):
   1. store skipped keys of the current receiving chain up to `h.pn` (§ 5.6);
   2. `kss_in = h.kct ? Decaps(myKem[h.kid].dk, h.kct) : ∅` — a `kct` with an unknown `kid` is an
      error (§ 5.5);
   3. `(RK, CKr) = KDF_RK(RK, ECDH(DHs, h.dh), kss_in)`; `PN = Ns`; `Ns = Nr = 0`; `DHr = h.dh`;
   4. **sending ratchet step** (§ 5.3) with the new `DHr`.
   An n = 0 header of a new chain without `kct` while this side announced a `myKem` the peer has
   seen is NOT an error (the peer may not have used it yet); only a `kct` that cannot be
   decapsulated is.
3. If `h.kek` is present: `peerKem = h.kek` (before step 2.4 when both apply — the step
   encapsulates to the freshest key).
4. Store skipped keys of the receiving chain up to `h.n`; `(mk, CKr) = KDF_CK(CKr)`; `Nr += 1`;
   decrypt with the same AAD as § 5.2 (with `from` = the peer); `unpad`; parse JSON.

State is changed only when the AEAD check passes (work on a copy, commit on success).

### 5.5 Failure and reset

Any failure to open a `p4` frame (AEAD, a bad `kct`, a header out of range) drops the frame; a
second failure within the session — or a `kct` that cannot be decapsulated — makes the side send
`{ kind:"p4-reset", v:4, why }`, discard the session and send a new hello. A received reset does
the same (at most one reset per 10 s per peer, else the channel is closed).

### 5.6 Skipped keys

At most `MAX_SKIP` (1000) per chain and `MAX_SKIPPED_TOTAL` (2000) per session, oldest dropped
first, keyed by `(dh, n)`. A header asking to skip more is a failure (§ 5.5).

### 5.7 Inner messages

`inner` is a JSON object with a type `t`:

| `t` | Fields | Use |
|---|---|---|
| `sk` | `keyId, chain (b64 32 B), index, spk (SPKI b64), cert (b64 64 B)` | the sender's current sender-key chain (§ 6) |
| `msg` | `id, p` | a private message (to chosen recipients); `p` is the chat payload, `p.id === id` |
| `media` | `call, epoch, key (b64 32 B)` | the sender's media key for one call direction (§ 9) |
| `file` | `transferId, key (b64 32 B)` | the key of one file transfer (§ 8) |

Unknown `t` values are ignored (forward compatibility). Integrations may add types.

## 6. Sender keys (room messages)

Own chain: `keyId` = b64url of 12 random bytes, `CK` = 32 random bytes, `index`, and a
**per-chain ECDSA P-256 signing key pair** `spk`. A chain is replaced after
`SENDER_KEY_ROTATE` (100 messages or 15 minutes), when a member leaves or is excluded, and when
this device starts a new pair session with a peer that had the old chain (re-hello). Chains are
handed to each peer only as a pair-ratchet `sk` message, with

```
cert = ECDSA(spk.private, join(LABEL.skCert, roomId, keyId, ownerPk))     ownerPk = the owner's hello pk
```

made once per chain: the chain's own signing key names the device that owns it.

```
(mk, CK) = KDF_CK(CK)
AAD  = join(LABEL.senderKey, roomId, id, keyId, n)
(key, iv) = keyIv(mk, LABEL.senderKey)
c    = AES-GCM(key, iv, AAD, pad(UTF-8(JSON(payload))))
s    = ECDSA(spk.private, AAD || c)
→ { v:4, id, sk: keyId, n, c: b64(c), s: b64(s) }
```

The receiver finds the chain by **(the sending peer, keyId)**, verifies `s` with the chain's `spk`
**before** advancing the chain (a member who holds the chain cannot forge or burn indices), then
derives the key (skipping up to `MAX_SKIP`), decrypts, unpads and checks `payload.id === id`.
Every member holds every chain, so a member could re-announce another member's chain (`keyId`,
`CK`, `spk`) as its own and relay that member's validly signed messages under its own name. A
receiver therefore accepts an `sk` only when `cert` verifies with its `spk` over
`join(LABEL.skCert, roomId, keyId, pk)`, `pk` being the hello `pk` of the pair session that
delivered it; a missing or bad `cert` refuses the chain. Only the holder of `spk.private` can name
an owner, so a re-announced chain fails whatever order chains arrive in. (A signature by the device
key over `spk` would not do: anyone can sign any `spk`.) As defence in depth, an `sk` whose `spk` is
already held for another owner device is refused too.

**Authenticity without non-repudiation (F-30).** Room and private messages are no longer signed
with the long-term device key. The device key signs only the hello (ephemeral keys); the session
is authenticated, the sender-key chain and its `spk` arrive over it, so the receiver attributes
the message to the peer's device (and to the account in the hello's `acc`) — but holds no
signature a third party could check (`cert` is made by the ephemeral `spk`: anyone can make an
`spk` that names a device). `Signer` for a protocol-4 message:
`{ publicKey: <hello pk>, valid: true, account?: { publicKey: acc.apk, valid: <cert check> } }`.

## 7. Messages for absent members (mailbox)

### 7.1 Bundles

Each device keeps mailbox bundles: `id` (b64url, 8 random bytes), a P-256 ECDH key pair, an
ML-KEM-768 key pair, `exp = created + MAILBOX_LIFETIME_MS` (7 days), and

```
sig = ECDSA(device, join(LABEL.mailboxBundle, id, dh, b64(H(kem bytes)), exp))
```

A new bundle is made when the current one is within `MAILBOX_RENEW_BEFORE_MS` (1 day) of expiry.
Private keys are kept until `exp + MAILBOX_KEEP_MS` (31 days, the relay's retention) and then
wiped (bounded forward secrecy for queued messages). Private keys are stored encrypted (web: the
session cache / IndexedDB with a non-extractable key; Android: the vault).

Peers learn bundles from hellos (remembered with the peer's pin, per device key) and, for
signed-in accounts, from the key directory (§ 7.5).

### 7.2 Sealing for one recipient device

Sender S (device key `S.pk`, own bundle `Sb` with private `Sb.dh`), recipient bundle `Rb`:

```
eph       = a new P-256 key pair
ss1       = ECDH(eph.private, Rb.dh)
ss2       = ECDH(Sb.dh.private, Rb.dh)          (both S and R can compute it: deniable)
(kct, ss3)= ML-KEM.Encaps(Rb.kem)
AAD       = join(LABEL.mailbox, roomId, id, S.pk, Sb.id, Rb.id, b64(eph.public SPKI), b64(H(kct)))
(key, iv) = HKDF(salt = H(AAD), ikm = ss1 || ss2 || ss3, info = LABEL.mailbox, L = 44)
c         = AES-GCM(key, iv, AAD, pad(UTF-8(JSON(payload))))
→ { v:4, kind:"mb", id, to: Rb.id, sb: Sb, spk: S.pk, sacc?, e: b64(eph SPKI), kct: b64, c: b64 }
```

The sender first checks `Rb.sig` with the recipient's device key and `Rb.exp > now`.

### 7.3 Opening

The recipient finds its bundle by `to` (else: not for this device — ignore), verifies `sb.sig`
with `spk`, checks `spk` against its pins (an unknown key is “new”, a different key for a pinned
account or name is “changed”), computes `ss2 = ECDH(Rb.dh.private, sb.dh)`, decrypts, unpads,
checks `payload.id === id`. `sacc` is checked like a hello's `acc`. `sb.exp` is not checked (an
item may wait at the relay); keys of a bundle past `exp + MAILBOX_KEEP_MS` no longer open anything.

### 7.4 Relay frame

The relay frame (`server/signaling/relay.ts`) gains `per: { [ref]: envelope }`: the server stores
for each recipient reference its own envelope (`per[ref]`, else `envelope`). A sender seals one
item per known device of each away recipient (an account may have several devices: the item for
that account is `{ v:4, kind:"mb-set", id, items:[MailboxItem…] }`), and falls back to the
protocol-3 room envelope (`sealMessage`) only for recipients without any known bundle.

Server details (6.12):

* `{ type:"relay", messageId, to:[ref…], envelope?, per?: { [ref]: envelope }, expiresAt?, mention?, call? }`.
  `envelope` may be left out when every reference in `to` has its own `per[ref]`; otherwise it is
  required. Keys of `per` that are not in `to` are ignored; at most 50 keys.
* Either envelope may be protocol 3 (flat: string / number fields with `iv` and `ciphertext`) or
  protocol 4 (`mb` / `mb-set`). A protocol-4 envelope is rebuilt from its validated fields only
  (unknown fields dropped): base64 sizes as in `contract.ts`, an `mb-set` has 1–16 items, its JSON
  at most 128 000 characters. The queue's limit of 130 000 bytes applies per stored item: an
  oversized `per[ref]` is answered `relay-status … rejected, reason "too large"` for that
  recipient only. Receipts and the relay ledger are unchanged. The whole frame stays ≤ 256 KiB.

### 7.5 Key directory (signed-in accounts)

* `PUT /api/keys/bundle` (account token) — `{ pk, cert:{v:2,exp,sig}, bundle }`: the device's
  current bundle, its device certificate v2 (§ 12.3); the server checks the certificate against
  the account key and the bundle signature against `pk`, keeps the newest bundle per device and
  logs `dev` entries to key transparency (§ 14) when the device or its certificate is new.
* **Hub frame** `{ type:"key-bundles", ref }` from a client joined to a room → the hub answers
  `{ type:"key-bundles", ref, devices: DirectoryDevice[] }` for the account behind that
  room-scoped reference (the same references the relay uses, `server/signaling/refs.ts`). Unknown
  or foreign references get an empty list (no oracle). Rate-limited like other hub frames.

Server details (6.12):

* The PUT body may carry `apk` (raw Ed25519, base64): needed only while the server does not know
  the account key yet (it learns it from `PUT /api/account/identity`, which logs `acct`); a
  different `apk` than the known one is refused (`409 apk-mismatch`). Answer:
  `{ ok:true, device: DirectoryDevice, kt: { acct: index|null, dev: index|null } }`. Refusals:
  `400` `bad-request`, `bad-pk`, `bad-apk`, `bad-cert`, `cert-expired`, `cert-too-long`
  (`exp > now + 90 days + 5 min`), `bad-bundle` (sizes: `id` 8 B, `dh` P-256 SPKI, `kem` 1184 B,
  `sig` 64 B), `bundle-expired`, `bundle-too-long` (`exp > now + 7 days + 5 min`),
  `bad-bundle-signature`, `bad-cert-signature`; `409` `no-account-key`, `stale-bundle` (the
  directory has a bundle of that device with a later `exp`), `too-many-devices`
  (`KEYS_MAX_DEVICES`, default 10, counting devices with a valid certificate); `503` `kt-failed`,
  `kt-busy`, `directory-full`. All base64 must be canonical.
* `acct` is logged when the log does not yet show the account's current key (also for keys the
  server learned before 6.12); `dev` when the device is new or its certificate changed — before the
  directory keeps the row.
* `devices` lists only devices whose certificate and bundle have not expired and whose certificate
  is by the account key the server knows now.
* A device leaves the directory, with a `rev` entry while its certificate is still valid, when the
  session it uploaded with ends (sign-out on that device, "end this session" from another),
  when the account signs out everywhere, is deleted or an operator ends all its sessions, and when
  the account key changes (devices of the old key). An expired certificate leaves without `rev`.

## 8. Files

Per transfer the sender picks a random 32-byte `FK`:

```
fileKey = HKDF(salt = UTF-8(transferId), ikm = FK, info = LABEL.file, L = 32)  → AES-GCM key
AAD meta  = join(LABEL.fileMeta, transferId)
AAD chunk = join(LABEL.fileChunk, transferId, seq, total)
AAD end   = join(LABEL.fileEnd, transferId)
```

`FK` travels end to end: on a data channel as a pair `file` inner message sent before
`file-meta`; for a relayed or proxied file inside the (pair, sender-key or mailbox) message that
announces it (field `fk` of the attachment). The room key no longer protects files between
protocol-4 clients. Chunk and meta formats are otherwise those of protocol 3.

## 9. Media (call frames)

For every call (and every renegotiation) each side picks a fresh random 32-byte key per
direction and an `epoch` (incremented per key), sends it as a pair `media` inner message and uses
it for the frames it sends. Frame IV = `epoch` (4 bytes, big-endian) || frame counter (8 bytes,
big-endian, from 0 per key). A key is never used for more than 2^32 frames. Once a peer's media
key is known, unsealed frames from it are dropped (F-19). Peers without `"media"` caps or on
protocol 3 keep the protocol-3 media keys.

## 10. Padding

`pad(m)`: append `0x80`, then `0x00` bytes up to the smallest bucket of `PAD_BUCKETS` that is at
least `len(m) + 1`; above 65 536, up to the next multiple of 65 536.
`unpad(m)`: strip trailing `0x00`, require and strip one `0x80`; else the message is malformed.
Every protocol-4 plaintext (pair, sender key, mailbox) is padded. Files: the meta and end bodies
are padded; chunks are not (their size is fixed except the last).

## 11. Replay and freshness

Accepted message ids are remembered **persistently** per room as
`b64url(H(join(LABEL.replay, roomId, id))[0:16])` (the first 16 bytes of the digest), at most
`REPLAY.maxIdsPerRoom`, for `REPLAY.windowMs` (31 days). A payload whose `createdAt` is older
than the window is rejected. One more than `REPLAY.futureMs` (5 min) ahead is **accepted, with
`createdAt` clamped to the time it was received** (the sender's clock is off: the app says so
once per member, with roughly by how much); its id is remembered with that clamped time, so a
far-future date can neither keep an id past the window nor outlive the others when the per-room
cap prunes the oldest. (A copy of such a message could be accepted again once its id has left
the window — where a frame can be replayed at all: the ratchets refuse a used key, so only a
relayed mailbox item within its bundle's key retention.) History restored from the user's own
encrypted store is exempt from both checks. The store is encrypted like the rest of the device's
data.

## 12. Identity, pins and verification

### 12.1 States

| State | Meaning | Shown |
|---|---|---|
| `new` | first time this key is seen (trust on first use) | neutral “new key — not verified” (never “verified”) |
| `verified` | the user compared the safety number or scanned the QR code | green “verified” |
| `account` | the device is certified by an account key that is pinned / verified | as the account's state |
| `changed` | a different key for a pinned account or name | red warning, messages held until the user accepts |
| `legacy` | protocol 3 peer | “older protocol (no PCS / PQ)” |

### 12.2 Pins

Pins are keyed by the **account key** when a device is attested (valid across rooms: a verified
account stays verified everywhere), otherwise by `(roomId, display name)` as before. Each pin keeps
the device keys seen, the downgrade marker (“p4 seen”) per device key, the newest mailbox bundle
per device key, and the verification state. A safety number is computed from the two account keys
when both are present, else the two device keys (existing `fingerprint.ts` format).

### 12.3 Device certificates v2 and revocation

`cert = { v:2, exp, sig = Ed25519(account, join(LABEL.deviceCert, deviceSPKI, exp)) }`, `exp ≤ now +
DEVICE_CERT_LIFETIME_MS`. A device renews it at sign-in when less than a third of its lifetime is
left. v1 certificates (no expiry) are still accepted but shown as “certificate without expiry”.
A device is revoked by a `rev` entry in key transparency (§ 14); a revoked device is shown as
`changed`.

## 13. Hub join proof (G-09)

* `hubSeed = RoomKeys.derive(LABEL.hubSeed, 256)` (HKDF from the room secret, salt `m5cet:v2`,
  as every other sub-key); the Ed25519 key pair is derived from the 32-byte seed (RFC 8032).
* The server's first frame (`type:"hello"`) gains `nonce` (b64url, 24 random bytes, one per
  socket). The `join` frame gains `proof: { pub: b64(32 B), sig: b64(Ed25519(seed,
  join(LABEL.hubJoin, roomId, nonce))) }`.
* Server: a room's verifier (`pub`) is registered by its first proven join and kept while the
  room is used (forgotten after `HUB_ROOM_PROOF_TTL_DAYS`, default 365, without a proven join).
  A proof with another `pub` or a bad signature → error `room-proof` (refused, audited). A join
  without proof (clients before 6.12) is admitted unless `HUB_REQUIRE_ROOM_PROOF=1`; peer views
  carry `proven: boolean`.
* Clients show unproven members with a badge; server-side features that reach members by room
  (telephony route audio, calls offered to a room, `user` targets) address only proven members.

Server details (6.12):

* The nonce is per socket, not per join: a client may join several times on one socket with
  proofs over the same nonce. A proof made for another socket's nonce does not verify.
* `pub` is the raw 32-byte key, `sig` 64 bytes, both canonical base64; a malformed proof is an
  `invalid-frame`. `joined` carries `proven` for the joiner itself; `joined.peers`, `peer-joined`,
  held members (`joined.held`, the held `peer-left`) and members on other instances carry
  `proven: boolean`.
* Refusals: `error` `room-proof` (another `pub`, a bad signature, or — after 10 failed proofs from
  one address in 10 minutes — any proof from it, unchecked), `room-proof-required`. Both are
  audited (security) with the room's hash, never its id.
* Only blind ids (`r3.…`) can prove. A room joined by its plain name (protocol 2 / v2 keys) is
  always legacy: a proof sent for it is ignored, and `HUB_REQUIRE_ROOM_PROOF=1` does not refuse it.
* Verifiers are kept under an HMAC of the room id (a subkey of the storage master key) in the global
  database — shared by the instances of a cluster — or, without server-side storage, in memory per
  instance (lost on a restart; the next proven join registers again).
* Who is "proven only": with `HUB_REQUIRE_ROOM_PROOF=1` proven members only; otherwise proven
  members only as soon as one member of the room has proven, and everyone in a room where nobody
  proves (only older clients), as before 6.12. A `@account` target is authenticated by its session
  and needs no proof; a member named by display name or by peer id does.
* Trust on first use: the first proven join registers the verifier. Someone who knows only the blind
  id can register a key of their own for a room that no 6.12 client has proven yet; the real members
  are then refused (`room-proof`) until the verifier expires. The squatter gets no more than a legacy
  join gave before 6.12.

## 14. Key transparency (F-13)

### 14.1 Log

An append-only Merkle log (RFC 9162 hashing, `merkle.ts`) on the server. A leaf is the UTF-8 of
the entry's canonical JSON: keys in the order of `KtEntry` in `contract.ts`, no spaces.

* `acct` — an account key registered or changed: `{t,u,apk,ts}`
* `dev`  — a device certified: `{t,u,apk,dpk,exp,ts}`
* `rev`  — a device revoked: `{t,u,apk,dpk,ts}`

`u = b64url(H(LABEL.ktUser + username))` — the log names no user in clear text.

### 14.2 Signed tree head

`{ size, root: b64, ts, sig: b64(Ed25519(ktKey, join(LABEL.ktSth, size, root, ts))) }`. The server's
KT key is an Ed25519 key kept with the server's master keys; its public key is
`GET /api/kt/key → { key: b64 }`. Clients pin it on first use per server origin (Android: also
from the server pin / QR).

### 14.3 API

* `GET /api/kt/sth` → `SignedTreeHead`
* `GET /api/kt/lookup?u=<u>` → `KtLookup { sth, entries:[{entry, index, proof:[b64…]}] }` — every
  entry of that user, each with its inclusion proof in `sth`. For a member known only by a
  room-scoped reference, the hub frame `{ type:"kt-lookup", ref }` answers
  `{ type:"kt-lookup", ref, lookup: KtLookup }` (as § 7.5).
* `GET /api/kt/consistency?from=<size>&to=<size>` → `{ from, to, proof:[b64…] }`.

Server details (6.12):

* `GET /api/kt/key` is the raw 32-byte Ed25519 key. The key is derived from the storage master key
  (HKDF, never stored or logged on its own); replacing the master key makes the stored tree heads
  unverifiable and the log fails closed.
* A tree head is signed again when the log grew, or at the same size when the last one is an hour
  old (a fresh `ts`). Before signing a larger head the server checks, with `merkle.ts`, that the new
  tree is consistent with the last head it signed.
* `lookup` returns at most the newest 500 entries of `u` (indexes ascending); `u` must be 43
  characters of base64url. `consistency` needs `0 ≤ from ≤ to ≤` the log's current size (`400`
  otherwise). `u` hashes the username exactly as the server stores it.
* `503` with `code`: `kt-off` (no server-side storage), `kt-failed` (the log is corrupt — a gap, an
  altered or non-canonical leaf, leaves under a signed head changed, a head not verifying with the
  KT key — closed until the operator restores it; never rebuilt), `kt-busy`. The leaf table
  refuses UPDATE and DELETE (triggers). The hub's `kt-lookup` answers `lookup: null` when key
  transparency is not running, and `{ sth, entries: [] }` for an unknown or foreign reference.

### 14.4 Client checks

* Keep the newest verified STH per server. On every new STH: check its signature and its
  consistency with the kept one (`verifyConsistency`); failure → a persistent security alert
  (“the server shows a rewritten key history”) and the alert is offered in the security panel.
* Before marking an account `account`/`verified`, look the account up and verify inclusion of its
  `acct` and the device's `dev` entry (and absence of a later `rev`).
* **Gossip.** Hellos carry `sth`. For a peer's STH on the same server: same size and different root,
  or a failed consistency check between the two sizes → the same alert (split view).
* A head not signed by the pinned key is ignored. Between two heads the server signed, a
  consistency answer that does not verify is the alert, whatever its cause.

## 15. Release manifests (F-02, installation check)

`release.json` — `ReleaseManifest`: `files` sorted by `path` (ordinal string order, no duplicates),
`sha256` lowercase hex, paths relative to the release root with `/`. Covers the built web assets,
the server sources, `package.json`, `package-lock.json`, the installer and the scripts; never
`node_modules`, `.env*`, data or keys.
`release.json.sig` — b64 Ed25519 over the exact bytes of `release.json`, by the developer's
release key (never on the server); `release-signing.pub` — the raw public key, b64. The web build
also writes `dist/public/release-web.json` (only the served assets) and its `.sig` when signed.
Unsigned manifests still detect corruption and local modification; signed ones also detect a
package that did not come from the developer.
