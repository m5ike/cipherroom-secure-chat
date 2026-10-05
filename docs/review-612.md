# M5cet 6.12 — adversarial security review

Reviewed state: `de2874d3` (merge(6.12): web — protocol 4 everywhere). Reviewed against
`docs/protocol-v4.md` and the 6.12 fixes it claims (`docs/security-analysis.md` §§ 7, 11, 12).
Scope: the protocol-4 library (`client/src/lib/p4/*`), its web integration (`p4-session.ts`,
`p4-store.ts`, `p4-trust.ts`, `p4-away.ts`, `p4-kt.ts`, `App.tsx`, `room-hub.ts`, media worker,
file transfer), the 6.12 server code (hub proof, key directory, key transparency, relay `per`,
service DB, function sandbox isolation, TURN gate, security posture, …) and `check.sh`.

Attacker models used below:

* **S3** — a malicious or compromised server operator (controls the hub, relay, key directory,
  KT log, the served JavaScript is out of scope: F-02 stays a design gap).
* **S3+K** — S3 who also knows the room passphrase (an ex-member, or an operator who is/was a
  member). Protocol 4 exists precisely so that this attacker no longer reads the room (F-09,
  F-06). S3+K can open the room-key-sealed signaling, so it can swap the DTLS fingerprints and
  sit in the middle of every data channel and call.
* **M** — a malicious room member (knows the room key, has its own device and account).
* **B** — someone who knows only a blind room id. **L** — a local user on the server host.

How to read the evidence column: every PoC test asserts the SECURE behaviour; tests that fail on
`de2874d3` are committed as `it.skip` with a `// REVIEW-612 <id>` note (so the suite stays
green). Each skipped test was run un-skipped and failed for the stated reason. Un-skip a test
when its finding is fixed. "Code" = confirmed by reading the code (no executable PoC);
"hypothesis" = not reproduced.

## Findings

| ID | Sev. | Finding | Location | Evidence |
|---|---|---|---|---|
| P01 | **High** | Messages for away members are sealed to devices the **server** chooses: directory devices are trusted whenever no account is pinned — and the pin disappears 7 days after the member was last seen; devices remembered behind a server-asserted reference are sealed to with no account check at all. S3 reads the F-09 mailbox messages (worse than 6.11, where it held room-key envelopes it could not open) | `client/src/lib/p4-away.ts:68-78`, `client/src/App.tsx:1744-1746`, `client/src/lib/p4-trust.ts:126-134`, `App.tsx:2224-2225`, `:2839-2840` | `test/review-612-p4.test.ts` › P01 (3 tests) |
| C01 | **High** | `check.sh` runs `.env` values as shell code as root (`bash -c "exec 3<>/dev/tcp/${h}/${p}"`) | `check.sh:2163`, `:2402` | `test/review-612-checksh.test.ts` › C01 (2 tests) |
| C02 | **High** | `check.sh` loads JavaScript from the install tree in the root process whenever no non-root service user is known (`run_as` falls back to running as itself) | `check.sh:370-382`, `:501-503`, `:898` | `test/review-612-checksh.test.ts` › C02 (3 tests) |
| C07 | **High** (hypothesis) | `check.sh` runs `git status` as root on the install tree with `-c safe.directory=<root>` — the tree's `.git/config` (`core.fsmonitor`) runs a command as root | `check.sh:734`, `:736` | code (not executed: git outside the worktree is blocked in the review sandbox) |
| P02 | Medium | `sig4` does not cover the hello's `caps`, `sth` and `user`: S3+K strips `"media"` (calls then carry unsealed frames, protected only by the DTLS-SRTP it terminates) and `sth` (KT gossip off) | `client/src/lib/p4/handshake.ts:64-66`, `App.tsx:2872` | `test/review-612-p4.test.ts` › P02 |
| P03 | Medium | The room-key fallback for a peer still "pending" after 2.5 s bypasses the downgrade rule: a device once seen with protocol 4 whose handshake is stalled (or whose hello is withheld) gets every message — private ones too — under the room key | `App.tsx:2575`, `:2608-2612`; `client/src/lib/p4-session.ts:274`, `:309` | `test/review-612-p4.test.ts` › P03 |
| P04 | Medium | Key transparency is advisory only: an account device "absent" from the log (or a lookup that does not verify) is ignored, identities are shown `account`/`verified` without any KT check, and no client ever looks up its OWN entries — a device the server adds for a user is never noticed (spec § 14.4 not met) | `App.tsx:2853-2866`, `client/src/lib/p4-trust.ts:169-188`, `client/src/lib/p4-kt.ts:122-138` | code |
| P05 | Medium | KT alerts can be suppressed: when the server refuses a consistency proof between two heads it signed, `update`/`resolveGossip` throw and the client swallows it — no alert, ever (split view and rewritten history go unreported) | `client/src/lib/p4/kt.ts:280-287`, `client/src/lib/p4-kt.ts:77-85`, `:103-114` | `test/review-612-p4.test.ts` › P05 |
| P06 | Medium | Background rooms do not evaluate pins: a second key under a pinned member's name is shown "new" (never "changed"), not held, and carried into the room on screen as it is | `client/src/lib/room-hub.ts:434-436`, `App.tsx:3429-3432` | `test/review-612-p4.test.ts` › P06 |
| P07 | Medium | Server-relayed ("proxy") file transfers between protocol-4 clients still use the room-key-derived file key; spec § 8 (FK in the announcing message's `fk`) is not implemented — S3+K reads proxied files | `App.tsx:5432-5437`, `docs/protocol-v4.md` § 8 | code |
| C03 | Medium | `check.sh` prints a `REDIS_URL` password that contains `/` or `@` | `check.sh:299` (`safe_url`), `:1182`, `:2402-2403` | `test/review-612-checksh.test.ts` › C03 (2 tests) |
| P14 | Medium | A message held because its key changed is displayed anyway through a quote: a reply to it shows the held text as an authentic quote of the impersonated member | `client/src/lib/validate.ts:260-270`, `App.tsx:1006`, `:540`, `:6016` | `test/review-612-p4.test.ts` › P14 |
| S07 | Medium | "Proven only" is decided by who is connected now, not by whether the room has a verifier: while every proven member is away, a blind-id joiner is the room — inbound calls / route audio and name targets go to it (caller number, audio, transcripts); G-09 defeated | `server/signaling/proof.ts:93-96`, `server/signaling/hub.ts:1119-1125`, `server/telephony/route-audio.ts:120` | `test/review-612-server-hub.test.ts` › S07 |
| S01 | Medium | Audit-journal tamper evidence (F-23) bypassed by a storage writer without the master key: delete `audit-signing.pin` and self-signed checkpoint keys are re-pinned on open; or delete all checkpoints — `verifyAudit` never requires one | `server/storage/global-store.ts:708` (`ensurePin`), `:784` (`verifyAudit`) | `test/review-612-server-audit.test.ts` › S01a, S01b |
| S02 | Medium | Speech-model integrity (F-29) bypassed by deleting `manifest.json`: missing manifest = first-load trust, swapped native ONNX files are recorded and loaded into the server process; a re-download with another archive hash is accepted | `server/ai/speech-integrity.ts:62`, `:144` | `test/review-612-server-speech.test.ts` › S02 (2 tests) |
| S03 | Low–Medium | KT user id `u = SHA-256(label‖username)` is unkeyed: generated usernames (~2^29.6) invert offline in seconds-minutes; the unauthenticated `/api/kt/lookup` confirms accounts and their device history (contradicts § 14.1 "names no user") | `server/kt/service.ts:14`, `server/kt/routes.ts`, hub `kt-lookup` | `test/review-612-server-kt.test.ts` › S03 |
| S04 | Low–Medium | Failed-proof limiter: mismatches (every real member of a squatted room) count and then block the address for EVERY room; full IPv6 addresses (a /64 never trips it); unbounded map with an O(n) scan per failure above 10 000 | `server/signaling/proof.ts:247-260`, `:290-293` | `test/review-612-server-hub.test.ts` › S04 (3 tests) |
| S05 | Low–Medium | Server notices / function `user_msg`/`user_flash` by display name or peer id ignore `reachable()`: an unproven joiner using a proven member's name receives them | `server/signaling/hub.ts:1105` (`notice`) | `test/review-612-server-hub.test.ts` › S05 |
| S08 | Low–Medium | Route-audio legs and `sendToPeer` address a peer id checked once: an unproven joiner that takes a freed peer id gets later call frames (transcripts, media token) | `server/telephony/route-audio.ts:282`, `:424`, `server/signaling/hub.ts:1155` | `test/review-612-server-hub.test.ts` › S08 (hub level) |
| P08 | Low | A verified account is shown "verified" under any display name it picks in any room (the name is TOFU-pinned to the account in the same call) | `client/src/lib/p4-trust.ts:186` | `test/review-612-p4.test.ts` › P08 |
| P09 | Low | "Forwarded from X" is verified against any message carrying the claimed name X — including held (`changed`) messages and the forwarder's own | `client/src/lib/validate.ts:276-280`, `App.tsx:1007`, `:6017` | `test/review-612-p4.test.ts` › P09 |
| P10 | Low | The replay window fails open: an error of the replay store is taken as "ok" | `App.tsx:1851`, `client/src/lib/room-hub.ts:424` | code |
| P11 | Low | Multi-tab last-writer-wins in the device vault: two tabs that each create a mailbox bundle keep one row list — the other bundle's ML-KEM key is lost (away messages sealed to it never open); the replay window has the same race | `client/src/lib/p4-store.ts:167-185`, `:258-266` | `test/review-612-p4.test.ts` › P11 |
| P12 | Low | `LocalVault`: a failed read of the wrapping key generates and stores a NEW key over the old one — every sealed row (bundle keys, replay windows) is lost silently; an empty replay window re-admits relayed replays | `client/src/lib/p4-store.ts:94-104` | `test/review-612-p4.test.ts` › P12 |
| C04 | Low | `check.sh` writes terminal escape sequences from `.env` values / file names to the terminal | `check.sh:184-185` | `test/review-612-checksh.test.ts` › C04 |
| C05 | Low | `check.sh`: a world-readable key file whose name contains a space passes `config.keys` (word splitting) | `check.sh:1200` | `test/review-612-checksh.test.ts` › C05 |
| C06 | Low | `check.sh --json` emits invalid UTF-8 for non-UTF-8 values | `check.sh:194-200` | `test/review-612-checksh.test.ts` › C06 |
| C08 | Low (hypothesis) | `check.sh` runs `npm ls` / `npm audit` as root inside the tree (its `.npmrc`) | `check.sh:922`, `:934` | code |
| C09 | Low | `check.sh` as root follows a `$HOME`/`$XDG_CONFIG_HOME` pointer to pick the tree it inspects | `check.sh:464` | code |
| S06 | Low | `key-bundles` / `kt-lookup` answer unproven joiners in a proven room (stable account keys, `u`) | `server/signaling/hub.ts:708-735` | `test/review-612-server-hub.test.ts` › S06 |
| S09 | Low | F-28 per-address caps (invitations, file proxy) count full IPv6 addresses: one /64 fills the global tables | `server/share.ts:118`, `server/file-proxy.ts:94` | `test/review-612-server-caps.test.ts` › S09 (2 tests) |
| S10 | Low | KT log growth: every re-upload with another `cert.exp` appends a `dev` leaf (no quota); `ensureAccount` looks only at the newest 500 entries and re-appends an unchanged `acct` | `server/keys/service.ts:103`, `server/kt/service.ts:63`, `server/kt/log.ts:333` | `test/review-612-server-kt.test.ts` › S10 |
| S11 | Low | The TURN gate is passed by any open hub WebSocket (no join, no proof, no Origin) | `server/turn-gate.ts:33` | existing `test/turn-gate-612.test.ts` › "TURN once the address holds one" |
| S12 | Low (hypothesis) | Service-DB migration: pid-based lock looks alive after a container restart (PID 1) → 120 s wait, stores in memory; a commit by another process between `VACUUM INTO` and the swap can be lost; plaintext left in unlinked WAL/journal | `server/storage/service-db.ts:85-111`, `:151-205` | code |
| S13 | Low | bubblewrap without `--cap-drop ALL` (a root server keeps capabilities inside); a transient self-test failure in `auto` mode silently drops to the permission model for the process lifetime | `server/functions/sandbox/isolation.ts:85-118` | code (bubblewrap source) |
| S15 | Low | Registering a room verifier is free: a flood of made-up `r3.` rooms grows the table for 365 days; the in-memory store evicts the least-recently proven verifier, so a real room can be pushed out and squatted | `server/signaling/proof.ts:152-165` | `test/review-612-server-hub.test.ts` › S15 |
| P13 | Info | Design notes on the protocol-4 library (KT lookups prove presence only; mailbox KCI and unbound `sacc`; message ids global per room; reset counter never decays; chain handed out before the send succeeded; downgrade marker set only once a session exists) | see P13 below | code |
| C10–C12 | Info | `check.sh`: manifest paths not confined to the tree; process-mode pid file can name any process; a missing web-manifest signature yields no result | `check.sh:592`, `:1340-1345`, `:849` | code |
| S14 | Info | Room squatting is worse than § 13 says: 6.12 clients disconnect on `room-proof` (full DoS, squatter alone in the room), the squatter refreshes the TTL by joining, and the reset cannot beat an active squatter | `server/signaling/proof.ts:263-302`, `App.tsx:3811` | reasoning (reset mechanics covered by existing tests) |

Totals: High 4 (P01, C01, C02, C07†), Medium 11, Low–Medium 4, Low 17, Info 3 rows († hypothesis).
No Critical finding. P01 is the most important protocol finding: it voids F-09 against the server.
Server findings S01–S15 were found by a parallel reviewer and every PoC was re-run un-skipped
for this report (16/16 fail on `de2874d3` as stated).

## Status after the fixes (6.12.0)

Every finding was fixed before the release except **S03**, which is partly fixed by decision; the
PoC tests were un-skipped as their findings were fixed and pass (only the S03 PoC stays skipped:
it asserts a keyed `u`). Fix merges on `android_application`:

| Findings | Fixed in | How (short) |
|---|---|---|
| P01–P14, S14 (client) | `95c7044d` (web), `d42dd3d6` (Android) | spec § 7.4 trust rule for away sealing (pinned devices; directory devices only with a v2 certificate by a pinned account key; account pins outlive bundles); `sig4` covers `caps` / `user` / `sth`, mailbox AAD covers `sacc` (spec § 2, § 7.2, vectors regenerated, Android byte for byte); no room-key fallback for protocol-4 devices or private messages; KT inclusion before "account"/"verified", self-monitoring of own devices, refused consistency proofs alerted; background rooms hold changed keys; proxied files carry a sealed file key (§ 8); held messages hidden in quotes, previews, notifications; "verified" only under the verified name; forwards checked by key; replay fails closed; multi-tab safe vault, the wrapping key is never replaced; reset counter decays; squatted rooms rejoin unproven when `legacyAllowed` |
| S01–S15 | `b062430e` | proven-only features decided by the room's verifier and re-checked at delivery; limiters per room + /64, bounded; verifier registrations rate-limited; `/api/kt/lookup` needs a session and is own-only (S03 partly — `u` stays a public hash); KT growth capped; TURN only after a room join; IPv6 /64 grouping everywhere; audit pin and checkpoint coverage without silent re-pinning; speech-model integrity without silent re-recording (one-time upgrade record); safe service-DB migration lock; bwrap `--cap-drop ALL` |
| C01–C12 | `bd77a5b9` | no shell strings from `.env`, no install-tree code or git/npm as root (drop to the service user or SKIP), credentials redacted, output sanitized, safe file listing, root-owned install-dir pointer only, manifest paths and pid files validated |

Not verified by tests: Android ↔ web over real WebRTC, a real Linux host with bubblewrap under
systemd, real devices (see `docs/security-analysis.md` § 13.7).

## Details — protocol-4 client

### P01 (High) — away members: the server picks the devices a message is sealed to

**Where.** `sealForAway` (`client/src/lib/p4-away.ts:62-91`) collects, per away member reference,
(1) the devices remembered behind that reference (`known(ref)` = `TrustBook.devicesOfRef`) and
(2) the devices the hub's `key-bundles` answer lists (`directory(ref)`), and seals one mailbox item
to each. The only filter on (2) is `pinnedAccount(ref)` (line 75); (1) has none.

* App.tsx:1746 computes `pinnedAccount` as `devicesOfRef(roomId, ref).find((d) => d.apk)?.apk` —
  but `devicesOfRef` (`p4-trust.ts:126-134`) returns only devices whose **remembered bundle is
  still valid** (bundles live 7 days). A week after we last saw Bob, `pinnedAccount` is `null`
  and every directory device is accepted.
* A member we never met has no pinned account: every directory device is accepted. In 6.11 this
  member got a room-key envelope the server could not open.
* The reference a device is remembered under comes from the server: `rememberRef(roomId, ref,
  got.spk)` with `ref = accountRefOf(item.from)` of a relay item (App.tsx:2224-2225) and with the
  hub's peer reference of a live peer (App.tsx:2839-2840). One relay item the server fabricates
  (sealed by a device of its own to our public bundle, `from` = Bob's reference) plants that device
  behind Bob's reference; from then on every message for away Bob is also sealed to it — the
  `pinned` check does not apply to remembered devices at all.
* Key transparency is not consulted for any of this (see P04).

**Attacker.** S3 (no room key needed).
**Impact.** The F-09 fix is void against the server: it reads messages for away members — the
exact traffic protocol 4 moved off the room key. For never-met members and members not seen for a
week this is a regression from 6.11.
**Reproduction.** `test/review-612-p4.test.ts` › "REVIEW-612 P01 …": (a) Bob's account pinned
8 days ago, bundle expired → the server's own certified device gets an item **and opens it**;
(b) a device planted behind `ref-bob` (no account) gets an item **and opens it** although Bob's
account is pinned; (c) a never-seen member's message is sealed to the server's device.
**Fix.**
1. Keep the account key per reference (and per device) independent of bundle expiry
   (`TrustBook.refs[slot].apk`, set only from a verified hello `acc` / mailbox `sacc`), and use it
   for BOTH sources: a remembered or directory device must carry a valid certificate by that
   account key (v2, not expired) to be sealed to.
2. Never let a server-asserted reference move a device between accounts: `rememberRef` only when
   the device's verified account equals the account already pinned for that reference (or the
   reference has none); a device without an account is remembered only under the reference it
   was first seen with in a live session.
3. For a member without a pinned account: do not trust the directory blindly. Either (a) fall
   back to the protocol-3 room envelope (6.11 behaviour — the server cannot open it), or (b) accept
   directory devices only after a KT lookup proves `acct` + `dev` inclusion under a head
   consistent with ours AND the user accepted the account (TOFU made visible). (a) is the minimal
   safe fix.
4. Show in the sender's info view which devices / accounts a message was sealed to.

### P02 (Medium) — hello fields outside `sig4`

`helloSig4Data` (`handshake.ts:64-66`) signs `LABEL.hello, roomId, from, to, check, pk, dh, e,
H(k), n, mbDigest, accDigest`. Not covered: `caps`, `sth`, `user` (and `sig` by design).

**Attacker.** S3+K: the SDP of every data channel travels in signaling sealed with the room key,
so S3+K can swap the DTLS fingerprints and relay both channels, rewriting text frames.
**Impact.**
* `caps` without `"media"`: `rotateMediaKey` (App.tsx:2872) sends no protocol-4 media key, the
  worker then neither seals (no `send4`, no protocol-3 pair keys for a protocol-4 peer) nor
  requires seals — every call frame goes unsealed, protected only by DTLS-SRTP, which the attacker
  terminates. Protocol 4's per-call media keys (F-19) are switched off silently.
* `sth: null` (or an older head of the same server): KT gossip — the only split-view defence of
  § 14.4 — never runs.
* `user`: the username claim shown in the user info (App.tsx:4800) is unauthenticated (it is
  also never checked against the account key, see P13).
**Reproduction.** `test/review-612-p4.test.ts` › P02: a hello with `"media"` removed from `caps`,
and one with `sth: null`, still verify.
**Fix.** Add `b64(H(join(...caps sorted)))`, `sthDigest` (`b64(H(join(size, root, ts, sig)))` or
`-`) and the `user` claim to the `sig4` transcript (bump the hello label to `m5cet/hello/4.1` or
add the parts at the end, update the vectors and the Android port). Additionally: between two
protocol-4 peers, require media keys for every call (do not make them depend on an unsigned cap).

### P03 (Medium) — the 2.5 s room-key fallback bypasses the downgrade rule

`deliverToPeers` (App.tsx:2575) waits up to 2.5 s for a peer whose protocol is `"pending"`, then
for any peer that is neither protocol 4 with a session nor protocol 3 with a pair key, seals with
the ROOM key (App.tsx:2608-2612) — for room messages, for private messages (`targets`), for the
outbox flush and for audio status. The downgrade marker (§ 1) is consulted only when a protocol-3
hello arrives (`p4-session.ts:274`) and is set only once a session exists (`p4-session.ts:309`),
so a device known to speak protocol 4 whose `p4-kem` (or whole hello) is withheld stays
`"pending"` and gets the room key.
**Attacker.** S3+K (sits on the data channel, drops one frame).
**Impact.** Everything sent while the handshake is stalled is readable with the room key —
exactly the attacker protocol 4 is meant to stop; the "never the room key to a protocol-4 peer"
rule (App.tsx:2593) only applies once the session exists.
**Reproduction.** `test/review-612-p4.test.ts` › P03: B's device is marked p4-seen, B's
`p4-kem` is dropped, B's valid hello v4 is in hand — `settled()` still answers `"pending"`.
**Fix.** In 6.12 every supported peer sends a hello: never seal chat content for a live peer
whose hello has not been accepted — keep it in the outbox until the protocol is settled. At least:
(a) never fall back for a private send; (b) treat a peer whose hello carried `v: 4` or whose `pk`
is p4-seen as protocol 4 (hold, retry the handshake, or reset) instead of `"pending"`; (c) set the
downgrade marker when a valid hello v4 is accepted (as § 1 says), not when the session completes.

### P04 (Medium) — key transparency does not gate anything

* `checkPeerInLog` (App.tsx:2853-2866) acts only on `"revoked"`; `"absent"` (the device or the
  account key is not in the log) and `"unverified"` (lookup does not verify / is not consistent)
  are dropped silently.
* `evaluateIdentity` (`p4-trust.ts:169-188`) gives `account: true` / `verified` without any KT
  result; spec § 14.4: "Before marking an account `account`/`verified`, look the account up and
  verify inclusion of its `acct` and the device's `dev` entry".
* No client looks up its OWN `u` (`grep ktUser client/src` → only `p4-kt.ts:124`): a `dev` or
  `acct` entry the server adds for a user is visible to nobody, which is the property KT exists
  for (a server that shows a fake key "must put it in the log — where the real owner's devices see
  it", `kt.ts:5-7`).
* `checkDevice` retries without the user check when the claimed username does not match
  (`p4-kt.ts:128-129`), so the username claim is never bound to the account.
**Attacker.** S3. **Impact.** KT gives no protection against a server that certifies extra
devices or keys (combine with P01). **Fix.** (1) Periodically look up the signed-in account's own
`u` (`GET /api/kt/lookup`) and alert on any `dev`/`acct` entry this account did not create
(the device list is in the vault); (2) show `"absent"`/`"unverified"` in the identity state
(never "account"/"verified" with a failed or missing KT check when KT is on); (3) on a username
mismatch, do not show the claimed username.

### P05 (Medium) — the server can suppress KT alerts

`consistent()` (`kt.ts:280-287`) calls `fetchConsistency` outside its `try`; `KtState.update` and
`resolveGossip` therefore throw when the server answers the consistency request with an error,
and `KtClient.refresh` (`p4-kt.ts:82`) / `gossip` (`:113`) swallow the exception ("the next
refresh"). A forked server answers `400` for every proof it cannot make: the newer head is never
kept, the client keeps gossiping its old head, and no alert is ever raised.
**Attacker.** S3. **Impact.** Split views and rewritten histories go unreported (the spec says a
consistency answer that does not verify is the alert "whatever its cause").
**Reproduction.** `test/review-612-p4.test.ts` › P05: a peer's head of size 3 the server will not
prove consistent with ours (size 2) — status stays `"ok"`.
**Fix.** Treat a refused/failed consistency proof between two heads signed by the pinned key as
`inconsistent` after a short retry budget (distinguish network failure from an HTTP answer); keep
a "pending proof" record persistently and alert if it is not resolved within e.g. 24 h; never use a
lookup whose head could not be proven consistent (today it is merely "unverified", see P04).

### P06 (Medium) — background rooms skip the pin check

`BackgroundRoom.accept` (`room-hub.ts:434-436`) marks every signed message `"new"` (comment: "the
room on screen pins and compares") — but the room on screen never compares these: `take()` hands
them over and App.tsx:3429-3432 merges them as they are. A device with a different key using a
pinned member's name is never `"changed"`, its messages are not held (App.tsx:468) and they show
in background notifications.
**Attacker.** M (any member with a second device / key). **Impact.** Impersonation of a pinned
member is not flagged in any room the user is not looking at. **Reproduction.**
`test/review-612-p4.test.ts` › P06. **Fix.** Give `BackgroundRoom` the pin store and the
`TrustBook` (HubDeps) and run `evaluateIdentity` there, or re-run `identityFor` on every carried
message before `mergeMessages`; never notify with the text of a `changed` message.

### P07 (Medium) — proxied files still use the room key

`sendFileTo(file, key, channels, true, null)` for a relayed transfer (App.tsx:5437) always uses
the protocol-3 `fileKey(roomKeys, transferId)`; the protocol-4 path of spec § 8 ("for a relayed or
proxied file inside the … message that announces it (field `fk` of the attachment)") does not
exist (`grep -n "\bfk\b" client/src/lib/validate.ts client/src/lib/chat-types.ts` → nothing). The
code comment says so; the spec and the changelog say "the room key no longer protects files
between protocol-4 clients".
**Attacker.** S3+K (the proxy transport goes through the server). **Fix.** Implement § 8 for the
proxy transport (FK in the pair/sender-key message that announces the file), or correct the spec,
docs and UI ("sent via the server, protected by the room key").

### P14 (Medium) — the hold of a changed key leaks through quotes

A message from a changed key is rendered as a warning only (App.tsx:468), but the quote index
(App.tsx:1006) contains every message and `verifyQuote` (`validate.ts:260-270`) takes the quote's
sender and text from the STORED message — the F-22 design that makes quotes trustworthy. The
attacker sends the impersonating message (held as "changed"), then replies to it from its own,
unheld identity: the reply shows a quote box "Bob: pay 100 to X" built from "the real message".
**Attacker.** M. **Impact.** The 6.12 hold for changed keys is bypassed, and the impersonated text
gets the "authentic quote" presentation. **Reproduction.** `test/review-612-p4.test.ts` › P14.
**Fix.** In `verifyQuote` (and anywhere a stored message is rendered indirectly: quotes,
forwards, previews, search, exports) treat `identity.state` `changed`/`invalid` like a missing
message (or show the same warning instead of the text).

### P08 (Low) — "verified" follows the account into any name

`verified = pins.isVerified(room, name, kid) || (byAccount && book.accountVerified(pinned))`
(`p4-trust.ts:186`). A contact the user verified once is shown "verified" in every room under
whatever display name its messages carry, on first sight (the TOFU pin of that name is made in the
same call). **Attacker.** M (a verified contact). **Fix.** Show "verified" for an account only
together with the name it was verified under (or show the verified name instead of the claimed
one, and flag a different claimed name).

### P09 (Low) — forward verification by claimed name

`forwardIndex` (`validate.ts:276-280`) indexes `senderName␀text` of every non-forward message,
whatever its identity state or real sender. A member posts the text under the name "Bob" (held as
`changed`, or in a room where Bob is not pinned) and forwards it "from Bob": the forward shows as
verified (App.tsx:6017). **Fix.** Index by verified sender identity (pinned key id / peer id of
messages whose state is `new`/`verified` and not `changed`/`invalid`), and exclude the forwarder's
own messages.

### P10 (Low) — the replay window fails open

`replayGuard().check(…).catch(() => "ok")` (App.tsx:1851) and the same in `room-hub.ts:424`: if
the store throws (IndexedDB error, quota), messages are accepted without the persistent check
(only the in-memory set remains). **Fix.** On error, accept only messages that arrived on a live
ratchet/sender-key chain (they cannot be replayed) and drop relayed ones (mailbox, room-key) until
the store works; log it.

### P11 (Low) — multi-tab races in the vault

`VaultBundleStore` loads its row list once per instance and writes the whole list
(`p4-store.ts:167-185`); `VaultReplayStore.flush` writes the whole room map (`:258-266`). Two tabs
(two instances on one IndexedDB) lose each other's writes: a mailbox bundle published in hellos and
the directory loses its ML-KEM key (items sealed to it never open), and replay entries of the
other tab vanish. **Reproduction.** P11 test. **Fix.** Store one row per bundle / per replay key
(or read-modify-write inside one IndexedDB transaction), or a `BroadcastChannel`/Web Lock around
`maintain` and `flush`.

### P12 (Low) — a read error replaces the wrapping key

`LocalVault.wrapKey` (`p4-store.ts:94-104`): `get("wrap")` failing (`catch(() => undefined)`) is
treated as "no key", a new key is generated and **put** over the existing one. All rows sealed
under the old key fail to open (`getJson` → `null`), silently: mailbox bundle keys are lost and the
replay window starts empty (relayed replays accepted again for 31 days of history).
**Reproduction.** P12 test. **Fix.** Distinguish "absent" from "error": on error, fail (retry
later) and never overwrite; create the key with `add` (fails if present) rather than `put`.

### P13 (Info) — protocol-4 design notes (no change required for 6.12, document them)

* **KT lookups prove presence, not absence** (`kt.ts:92-131`): the server chooses which entries
  of `u` to return and may answer with an older (consistent) head; "no later `rev`" and "latest
  `acct`" cannot be verified. Document; a verifiable map (prefix tree / VRF) is the real fix.
* **Mailbox KCI**: whoever holds a recipient bundle's private key can forge items "from" any
  sender to that recipient (ss2 is static-static) — inherent to the deniable design; document.
  `sacc` is outside the AAD: the relay can strip a sender's account attestation (shown as a
  device-only sender).
* **Message ids are global per room** (`replay.ts:30`, dedupe in App): a member who sees a message
  id first (live) can send a different message under the same id to a third member and have the
  original dropped as a replay. Key the replay window and the dedupe on (sender, id).
* **The ratchet failure counter never decays** (`ratchet.ts:242-243`): two failures over a whole
  session force a reset; with one reset per 10 s allowed (`p4-session.ts:342`), two quick
  incidents close the channel. Reset the counter after N successful frames.
* **`chainFor` marks a peer as holding our chain before the frame was sent**
  (`sender-keys4.ts:114`); when `send` fails (`p4-session.ts:386`, `handOut` ignores it) the peer
  never gets the chain until the next rotation. Mark only after a successful send.
* **Downgrade marker timing** (`p4-session.ts:309`): set after the session, not after a valid
  hello v4 (see P03).
* **Things checked and correct** — see the end of this document.

## Details — check.sh

Ownership matters for reachability: in a systemd install `install.conf` is root 0600
(`installer/lib/config.sh:233`), `.env` is `root:<svc>` 0640 (`config.sh:265`, `:284`), `dist/` and
`admin-ui/` are `root:<svc>` (`deploy.sh:222`); in process / user-scope installs the user owns the
whole tree. `update.sh` runs `check.sh --only package,config,runtime` as root after every update
(`installer/lib/check-hook.sh`), and the installer offers a full check.

### C01 (High) — `.env` values executed as root

`net_turn` (`check.sh:2155-2166`) and `sys_redis` (`:2399-2404`) build
`bash -c "exec 3<>/dev/tcp/${h}/${p}"` with `h`/`p` cut from `TURN_SERVER_URL` / `REDIS_URL`.
`TURN_SERVER_URL=turn:h$(touch${IFS}/tmp/x)` runs `touch` as root on a full run.
**Attacker.** Whoever can write `.env` but not run as root: the owner of a user-scope install that
is checked with sudo, the service user where `.env` is owned by it (a state `check.sh` itself only
warns about, `:1024`). **Evidence.** `test/review-612-checksh.test.ts` › C01 (both create the
marker). **Fix.** Never interpolate data into `bash -c`: validate host
(`^[A-Za-z0-9.-]+$` or an IPv6 literal) and port (`is_uint`, ≤ 65535), then
`to 6 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$h" "$p"`; put `--` before the host for
`turnutils_stunclient`.

### C02 (High) — tree code in the root process

`run_as` (`check.sh:370-382`) switches users only when `SVC_USER` is set and not `root`;
otherwise it runs the command as root. The SQLCipher probe (`:898`) `require()`s
`dist/node_modules/better-sqlite3-multiple-ciphers`. With `SERVICE_MANAGER` other than
`systemd`/`process`, without `install.conf` (a checkout run with sudo) or with
`SERVICE_USER=root`, root loads code from a tree others can write — against the promise of the
header (`:31-32`). **Evidence.** C02 tests (3). **Fix.** As root: use `SVC_USER` if non-root, else
the owner of `ROOT` if non-root; run as root only when the module path and all parents are
root-owned and not group/world-writable; otherwise SKIP (126). Validate `SERVICE_USER` against
`^[a-z_][a-z0-9_-]*$`.

### C07 (High, hypothesis) — `git` with `safe.directory` overridden

`git -c safe.directory="${ROOT}" -C "${ROOT}" status|rev-parse` (`check.sh:734`, `:736`) as root.
`git status` honours the repository's own `.git/config` — `core.fsmonitor` names a program git
runs. `safe.directory` (git ≥ 2.35.2, CVE-2022-24765) refuses foreign-owned repos exactly to stop
this, and the override disables it. Reachable by the owner of a git-based tree (user-scope installs
from git, sudo on a checkout; in systemd mode if `.git` is writable by the service user), on every
root `update.sh`. **Fix.** Drop the override; as root with a non-root-owned `.git`, run git via
the fixed `run_as` as the owner, or SKIP; add `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.

### C03 (Medium) — Redis password in the output

`safe_url` (`check.sh:299`) masks `[^@/]*@`: a password containing `/` is printed in full, one
containing `@` in part (`:1182`, `:2402-2403`). Line 29 also promises ".env values are never
printed" while `PUBLIC_BASE_URL`, `TRUST_PROXY`, `HOST`, `ADMIN_BIND`, `NODE_ENV`,
`STORAGE_KEY_FILE` and `BACKUP_DIR` are. **Evidence.** C03 tests. **Fix.** If the URL contains `@`,
print `scheme://***@<host>:<port>` (host from the last `@`), drop the query; fix the wording.

### C04–C06, C08–C12 (Low / Info)

* **C04** `res()` (`:184-185`) prints messages raw: ESC sequences from `.env` values, file names
  (`package.extra`, `config.world_writable`, `config.secret_files`), nginx `server_name` or the health
  body can rewrite the operator's terminal (a FAIL shown as PASS; exit code and JSON unaffected).
  Replace 0x00–0x08, 0x0B–0x1F, 0x7F with `?` in text output.
* **C05** `for f in $(find …) $(ev STORAGE_KEY_FILE) …` (`:1200`): word splitting skips a 0644
  key whose name has a space (PASS); `.env` paths are glob-expanded as root. Use `find -print0` +
  `read -d ''`, quote the `.env` paths.
* **C06** `json_esc` (`:194-200`) passes non-UTF-8 bytes: `--json`/`--report` invalid for strict
  parsers. `iconv -c` or replace 0x80–0xFF.
* **C08** (hypothesis) `npm ls` (`:922`) / `npm audit` (`:934`) run as root in the tree (`.npmrc`,
  lockfile; a registry override leaks the lockfile; npm 6 `onload-script` would execute). Run via
  `run_as`.
* **C09** `pick_root` (`:464`) follows `${XDG_CONFIG_HOME:-$HOME/.config}/m5cet/install-dir` — under
  `sudo -E` a user picks the tree root inspects (feeds C02/C07/C08). Ignore it as root unless
  root-owned.
* **C10** manifest paths are not confined (`:592` accepts `../`): root hashes arbitrary files (weak
  oracle). Reject absolute, `..` and leading `-`.
* **C11** process mode: the pid file (`:1340-1345`) can name any process (spoofs
  `runtime.service`, `net_fds` reads its limits). Check the process's exe/cmdline and owner.
* **C12** a missing `dist/public/release-web.json.sig` produces no result (`:849`); emit a SKIP
  so the unsigned state is visible.

## Details — server

### S07 (Medium) — "proven only" follows the members online, not the room

`reachable()` (`proof.ts:93-96`) filters to proven members only when *some current member* is
proven (or proofs are required). `reachableIn` (`hub.ts:1119-1125`) and route audio
(`route-audio.ts:120`) feed it the members connected now. When every proven member is away
(socket gone and held, phone in the background), the room counts as "nobody proves" although its
verifier is registered — an inbound call routed to the room, a phone-bridge member by name and
room notices go to whoever is connected: possibly a blind-id joiner alone (caller number, audio,
transcripts). **Attacker.** B. **Evidence.** S07 test: targets are `['Mallory']`.
**Fix.** Decide "proven only" by whether the room has a verifier (`proofs.store.get(roomKey)`,
cached), or count held members' `proven`; apply in `reachableIn` and pass into `routeTargets`.

### S01 (Medium) — audit journal (F-23) re-pins forged checkpoint keys

(a) A writer of `m5cet.db` and the storage directory (without the master key) rewrites rows,
rechains them, adds a checkpoint signed by its own key and deletes `audit-signing.pin`; on open
`ensurePin` (`global-store.ts:708`) trusts the self-signed checkpoint keys again and
`verifyAudit()` (`:784`) is ok. (b) Simpler: rewrite, rechain, delete all checkpoints —
`verifyAudit` never requires one although one is signed every 500 rows. **Evidence.** S01a, S01b.
**Fix.** A missing pin after the upgrade is a failure (`pin-missing`), re-pin only by an explicit
operator action and never from keys found in the rows; require a valid checkpoint within 500 rows
(+ slack) of the head; anchor the newest checkpoint outside the box (console / clients).

### S02 (Medium) — speech-model integrity (F-29) skipped without a manifest

`readManifest` returns `{}` when `manifest.json` is missing (`speech-integrity.ts:62`) and a file
without an entry is "first-load" trusted (`:144`). Whoever can write `DATA_DIR/ai/speech-models`
(the F-29 attacker) swaps a native ONNX file and deletes the manifest: the file is recorded and
loaded by sherpa-onnx in the server process; a re-download with another archive hash is accepted.
**Evidence.** S02 (2 tests). **Fix.** With a master key and an existing model directory, a missing
manifest refuses to load until an explicit console action/env flag re-records; keep a MAC'd copy
in the global DB; ship `sha256` pins in `LOCAL_MODELS`.

### S03 (Low–Medium) — the KT user id is an unkeyed hash of the username

`u = b64url(SHA-256("m5cet/kt/user|" + username))` (`kt/service.ts:14`). Generated usernames of
4.0–6.4.0 and `/api/account/register/options` have ~2^29.6 values: `u` inverts in minutes on one
core (the test recovers one in ~0.4 s by enumerating the tail). `/api/kt/lookup` is
unauthenticated: it confirms an account exists and shows its device add/revoke times. Members —
including an unproven blind-id joiner via `kt-lookup` — get `u` for members. **Fix.** `u` as an
HMAC under a server key (or a VRF), the client learns its own `u` from `/api/account/me`; require
a session for `/api/kt/lookup` (or only the caller's own `u`).

### S04 (Low–Medium) — the failed-proof limiter

`proof.ts:247-260`, `:290-293`: (a) a "mismatch" (a valid signature by another key — what every
real member of a squatted room sends) counts as a failure, and a blocked address is refused for
every room without checking — ~10 reconnects lock members out of all their rooms (with
`HUB_REQUIRE_ROOM_PROOF=1`, out of the server); (b) full IPv6 addresses: one /64 never trips the
limit; (c) the map is unbounded while fresh, and above 10 000 entries every failure scans it.
**Evidence.** S04 (3 tests). **Fix.** Do not count mismatches (or key per address+room);
aggregate IPv6 to /64 (or /56); LRU with O(1) eviction.

### S05, S08, S06 (Low–Medium / Low) — proof not applied on every server path

* **S05** `notice` (`hub.ts:1105`) by display name or peer id ignores `reachableIn`: an unproven
  joiner using a proven member's name gets console notices and a function's `user_msg` /
  `user_flash` (codes). `sendToMembers` already filters. Fix: filter name/peer-id targets by
  `reachableIn(room)`, also on the cluster `signal` path.
* **S08** route-audio legs (`route-audio.ts:282` frames, `:424` offer with the media token) and
  `sendToPeer` (`hub.ts:1155`) use a peer id checked once; a peer id freed by a clean leave can be
  claimed by anyone, who then receives later call frames. Fix: check reachability inside
  `sendToPeer`; bind legs to the connection id; never hand a recently used peer id to another
  client without the resume secret.
* **S06** `key-bundles` / `kt-lookup` (`hub.ts:708-735`) answer unproven joiners in a proven room.
  Fix: empty list / `null` for an unproven requester when the room is "proven only".

### S09–S15 (Low / Info)

* **S09** per-address caps use the full IPv6 address (`share.ts:118`, `file-proxy.ts:94`, also the
  proof limiter and the TURN liveness check): 40 addresses of one /64 fill all 2 000 invitations,
  4 take all 64 proxy slots. Normalise to /64 (or /56).
* **S10** `certChanged` (`keys/service.ts:103`) appends a `dev` leaf for any `cert.exp` change, even
  an earlier one — one account grows the never-pruned log without bound; `ensureAccount`
  (`kt/service.ts:63` + `log.ts:333`, newest 500 entries) re-appends an unchanged `acct`. Accept
  only a meaningfully later `exp`, add a per-account quota, query the newest `acct` directly.
* **S11** `mayGetTurn` (`turn-gate.ts:33`) = "has a live hub socket": a bare `/ws` without join,
  proof or Origin passes. Require a joined (ideally proven) connection; better, hand TURN
  credentials over the WebSocket after the join; coturn quotas.
* **S12** (hypothesis) `service-db.ts:85-111`: the pid lock looks alive after a container restart
  (node is PID 1) → 120 s wait, then the stores run in memory; `:151-205`: a commit by another
  process between `VACUUM INTO` and the rename sits in the plain WAL that `removeSiblings` unlinks
  (lost); plaintext remains in unlinked, unwiped WAL/journal/copy files. Per-process random token
  in the lock, `BEGIN EXCLUSIVE` on the plain DB during copy and swap, wipe before unlink.
* **S13** `isolation.ts:85-118` runs bwrap without `--cap-drop ALL` (a root server keeps all
  capabilities inside the sandbox; default deployments run as non-root — defence in depth); a
  transient self-test failure in `auto` silently falls back to the permission model for the
  process lifetime. Add `--cap-drop ALL`, `--unshare-user --uid/--gid 65534` where available, retry
  the self-test and report the fallback.
* **S14** (Info) squatting: 6.12 clients call `userDisconnect()` on `room-proof` (App.tsx:3811) —
  a squat is a full DoS and the squatter is the only reachable member; it refreshes the TTL by
  joining; `POST /api/admin/security/room-proof/reset` cannot beat an active squatter (re-registers
  on its next join). Let the reset pin a given `pub` (shown in a member's room info); in a later
  protocol derive the blind id from the hub key so no first-use trust is needed.
* **S15** registering a verifier is free (`proof.ts:152-165`; join is 10/s per socket): made-up
  `r3.` rooms add a persistent row (365 days) and an audit row each, uncapped; the in-memory store
  evicts the least recently proven verifier (O(n) scan), so a real room can be evicted and
  squatted. Per-address registration quota, table cap; never evict a verifier proven within the
  TTL — refuse new registrations instead.

## Checked and found correct

Protocol-4 library:

* Transcript joins: one validator (`primitives.ts:108-117`) rejects `|`, non-ASCII and non-safe
  integers in every part; all base64 decoding is strict/canonical (`unb64`, `unb64url`).
* Handshake: `sig4` binds room id, both peer ids, `check`, `pk`, `dh`, `e`, `H(k)`, `n`, the
  bundle and account digests — a hello cannot be replayed to another peer, room or session
  (fresh `e`/`k`/`n`); `TH` binds both hellos' `pk/e/k/n` and both KEM ciphertexts; the session
  key mixes `ECDH(e,e')` with both ML-KEM secrets; `acceptHello` is idempotent for the same hello
  (the f74f6dfb fix holds); `roleOf` refuses identical sides; KEM messages for another hello are
  ignored.
* Ratchet: copy-on-write commit only after the AEAD check (a forged/replayed frame changes
  nothing and its derived secrets are wiped); skipped keys bounded per chain and in total; replay
  within a chain refused; header fields (incl. `kid`, `H(kct)`, `H(kek)`) in the AAD; KEM ratchet
  keeps 3 own KEM keys; mutex around encrypt/decrypt; `P4Room` processes one channel's frames in
  order (App.tsx:3018-3024, `room-hub.ts` queue).
* Sender keys v4: signature verified before the chain moves (no index burning by members), chains
  keyed by (peer, keyId), `cert` by the chain's own `spk` naming the delivering session's `pk`
  (re-announcing another member's chain fails), `payload.id === id`, one older chain kept.
* Mailbox: sender bundle signature checked, AAD binds room, id, sender pk, both bundle ids, `eph`,
  `H(kct)`; `payload.id === id`; another room does not open; private keys wiped after
  `exp + MAILBOX_KEEP_MS`.
* Padding (ISO 7816-4) and strict UTF-8 decoding; `unpad` errors are `malformed`, not oracles
  (AEAD is checked first).
* Merkle verification matches RFC 9162 §§ 2.1.3.2 / 2.1.4.2 step by step; STH signature and
  same-size-different-root detection; unsigned heads ignored.
* Replay guard: clamping logic as specified (a far-future date is stored with the receive time,
  cannot outlive the window).
* Release manifest: path validation (`isReleasePath`), sorted/no duplicates, signature over exact
  bytes. Hub proof: Ed25519 over `(LABEL, roomId, nonce)`, strict sizes (the proof key is derived
  from the room secret, which the blind room id already exposes to an offline guess — nothing new
  leaks).
* Randomness: production code only reaches `systemRng` (`getRandomValues`, non-extractable keys);
  `RecordingRng`/`TapeRng`/`kemKeygenFromSeed` are used by tests and `script/gen-p4-vectors.ts`
  only; `P4Room` passes `rng` only when a caller sets it (tests).
* Storage: mailbox ECDH keys are non-extractable `CryptoKey`s in IndexedDB, ML-KEM keys and replay
  windows sealed under a non-extractable AES key with the row name as AAD; the TrustBook and KT pins
  in localStorage hold public data only.
* Media: per-call random keys, IV = epoch‖counter (no reuse under one key), unsealed frames dropped
  once a protocol-4 key is known, keys zeroed after `postMessage` (the clone happens first).
* Files (P2P): FK per transfer over the pair ratchet, looked up by (sending peer, transferId),
  used once; meta/chunk/end AADs bound to transferId/seq/total; digest of all chunks checked.
* Downgrade: a p4-seen `pk` sending a protocol-3-only hello is refused and its protocol-3 pair
  forgotten; protocol-4 frames from a protocol-3 peer change nothing; protocol-3 session-key
  envelopes from a protocol-4 peer are dropped.

Server:

* Join proof: per-socket 24-byte nonce, signature binds room id and nonce, plain-name rooms never
  prove, the block check runs before the Ed25519 verify, canonical base64 and sizes, a refused
  join after leaving does not leak `proven`, held and cluster views carry `proven`,
  `sendToMembers`/`memberMatches` use AND semantics, `@account` targets are authenticated by the
  session.
* Hub directory frames: `memberAccount` resolves only accounts in the room; unknown and foreign
  references get the same empty answer (no oracle).
* Relay `per`: null-prototype object, keys outside `to` dropped, protocol-4 envelopes rebuilt from
  validated fields only, size limits per stored item.
* Key directory: certificate checked against the account key the server knows, `apk-mismatch`,
  bundle signature, sizes, lifetimes, canonical base64; locked sessions refused; KT entry before
  the directory row; removal on sign-out, key change and deletion; another user's device copied
  under one's own account has no cross-account effect.
* KT log: append-only triggers; gap / canonical-form / hash checks on read; anchor and consistency
  check before signing; `BEGIN IMMEDIATE` across instances; `from`/`to`/`u` validated; inclusion
  proofs cheap (500 proofs at 10^6 leaves ≈ 2 ms); concurrent STH signing cannot fork the log.
* Room-proof reset: owner role only, not reachable from functions, audited by room hash.
  WebAuthn origins: exact match, no subdomains by default. Access log truncates IPs. Keyed
  `hashRoom` with the registry migration. Sandbox: empty environment under bwrap (only `PATH`
  without it), no argument injection into bwrap. `SlotGate` acquire/release/abandon. Service DBs:
  separate subkeys, verified rekey, converted once per process.

check.sh:

* `.env` and `install.conf` are never sourced or `eval`ed (`kv_parse` + `printf -v` with validated
  keys; `install.conf` limited to a key whitelist); secrets (admin token, metrics token, master
  key, VAPID, provider credentials) reported only as set / length / entropy (apart from C03);
  temp files via `mktemp -d` under `umask 077`, removed by the exit trap (the only `rm -rf`);
  `find` does not follow symlinks, `stat` without `-L`, manifest symlinks count as missing; the
  bubblewrap test is not run as root without a service user; `curl`/`openssl` arguments quoted;
  `json_esc` escapes `\`, `"` and control characters on bash 3.2 and 5.3; the exit code comes from
  the FAIL count (no reliance on `set -e`).

## Not verified

* The Android port (`cz.m5cet.app.p4`) was not reviewed; P02/P03/P05/P06-style integration issues
  should be checked there too (the library vectors only pin the bytes).
* No end-to-end browser run (Playwright) of the P02/P03 MITM scenarios; they are shown at the
  library / session-layer level plus code reading of App.tsx.
* C07 and S12 were not executed (sandbox limits); S08 was confirmed at hub level only.
