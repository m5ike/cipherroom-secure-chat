# File transfer

> **Since 3.1.0** chunks travel as binary frames (DataChannel and socket), and when no direct
> channel opens the file goes through the encrypted server relay, paced to the relay's limits —
> see [documentation › Soubory, relay a hovory](site/index.html#prenosy).
## Two paths

- **Inline (legacy)**: anything ≤ 512 KiB (`INLINE_ATTACHMENT_LIMIT`, `App.tsx`) is base64-encoded into a data
  URL and embedded directly in the chat envelope. Same code path as
  before. Easy and quick.
- **Chunked**: anything larger goes through `client/src/lib/file-transfer.ts`.
  The file is split into 32 KiB chunks, each chunk is encrypted with the
  room's AES-GCM key, and frames are sent over the same DataChannel.
  The receiver assembles them into a `Blob`, attaches it to the message,
  and exposes a download link.

## From the composer

The **File** / **Image** buttons next to the message field pick the path
themselves: up to 512 KiB the file rides inside the message, anything larger
is handed to the chunked transfer automatically (text typed alongside is
sent as its own message). The **Files** panel uses the same chunked sender.
Until 2.6.0 the composer only knew the inline path and answered larger files
with *"File exceeds inline cap of 512.0 kB; use chunked transfer"*.

A transfer needs at least one connected peer. Without an open DataChannel it
does not start and the app says so — the alternative would be the server
"proxy" path below, which does not deliver.

## Configurable cap

`Preferences.maxAttachmentBytes` — **default is unlimited**
(`Number.MAX_SAFE_INTEGER`); the **Settings** modal offers lower caps such
as 100 MB. It is enforced on the sender before starting and on the
receiver when the metadata frame arrives. Be aware of browser memory
limits: chunks stay in RAM until the transfer
completes. For multi-GB files we recommend a storage-provider plug-in
(see below).

## Transport selection

The sender uses **P2P** when at least one DataChannel is open, otherwise
it falls back to **proxy** frames (`proxy-meta` / `proxy-chunk` /
`proxy-end`) over the signaling WebSocket. Chunks are encrypted with the
room key *before* either path, so the server never sees plaintext, file
name, type or exact size — only `transferId`, sequence numbers, IVs and
ciphertext (from which the approximate size can be inferred).

The relay forwards every frame of a transfer (`proxy-meta`, `proxy-chunk`,
`proxy-end`, `proxy-cancel`, `proxy-need`) to the room and keeps no chunk
bodies of its own — it only counts what passed through, to enforce the cap.
Until 2.9.0 it forwarded the end frame alone, so a file sent this way never
arrived. Finished transfers keep their slot until the TTL sweep (4 per peer,
64 total), and a single WebSocket frame is capped at 128 000 characters.

## Order of arrival

Frames must be **processed** in the order they arrived, not merely received
in it: each frame is decrypted asynchronously and the DataChannel handler
fires every one in its own call. `handleIncomingFrame` therefore queues
frames per `transferId`. Without that queue the first chunks could overtake
the meta frame they belong to ("chunk arrived for unknown transfer") and the
end frame could overtake the last chunks — which surfaced as
**"Missing chunks at end-of-transfer"** on a file that had been delivered in
full (fixed in 2.9.0).

## When a chunk is lost anyway

A channel can drop and come back, and the relay can hiccup. Rather than
discarding a file that is 99 % delivered, the receiver answers the end frame
with `file-need` / `proxy-need` listing the sequence numbers it is missing;
the sender re-reads exactly those slices, encrypts them again and repeats
the end frame. At most `MAX_RESEND_ROUNDS` (3) rounds, then the transfer
fails with the number of chunks still missing. The sender keeps the ability
to repeat a transfer for 10 minutes after it finished.

## Backpressure

P2P only. The sender pauses when `bufferedAmount` exceeds 1 MiB and resumes
on `bufferedamountlow` (threshold 512 KiB); because that event does not fire
in every engine, the wait also polls and gives up at a deadline. A chunk
whose `send()` is refused (the browser's send queue is full — Chrome stops
at 16 MiB) is retried after the buffer drains, up to 6 attempts, and the
whole transfer fails loudly if it still cannot go out. It used to be
swallowed, which left a hole that only surfaced at the very end.

## Cancellation

Either side can cancel: the sender by setting `isCancelled() => true`
or the receiver by purging the registry and broadcasting `file-cancel`.
Partial blobs are discarded.

## Plug-in path for very large files

When you expect transfers above a few hundred MB, prefer:

- **S3 / MinIO / Backblaze**: the sender uploads to a presigned URL
  obtained from a custom plug-in; only the URL travels through chat.
- **Browser File System Access API**: write incoming chunks straight
  to disk instead of accumulating them in RAM. Chrome only at the
  moment.

Both belong behind a server plug-in registered via the admin module
registry; we do not implement either by default to keep the dependency
footprint minimal.

## Frame schema

```ts
type FileTransferEnvelope =
  // transport: "p2p" (DataChannel)
  | { kind: "file-meta";   transferId; iv; ciphertext; }   // encrypted FileMetaPlain
  | { kind: "file-chunk";  transferId; seq; iv; ciphertext; }
  | { kind: "file-end";    transferId; }
  | { kind: "file-cancel"; transferId; }
  | { kind: "file-need";   transferId; seqs: number[]; }   // receiver → sender
  // transport: "proxy" (signaling WebSocket)
  | { kind: "proxy-meta" | "proxy-chunk" | "proxy-end" | "proxy-cancel"; ... }
  | { kind: "proxy-need";  transferId; seqs: number[]; }
  | { kind: "proxy-ack";   transferId; accepted; reason?; }
```

Every `iv` is a fresh random 12-byte value; base64 goes through the shared
codec in `lib/crypto.ts`. `file-progress` / `proxy-progress` are declared
in the type but not produced or handled.

`FileMetaPlain` carries `name`, `mime`, `size`, `totalChunks`,
`chunkSize`, `senderId`, `senderName`, `createdAt`.
