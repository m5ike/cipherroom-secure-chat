# File transfer

## Two paths

- **Inline (legacy)**: anything ≤ 512 kB is base64-encoded into a data
  URL and embedded directly in the chat envelope. Same code path as
  before. Easy and quick.
- **Chunked**: anything larger goes through `client/src/lib/file-transfer.ts`.
  The file is split into 32 KiB chunks, each chunk is encrypted with the
  room's AES-GCM key, and frames are sent over the same DataChannel.
  The receiver assembles them into a `Blob`, attaches it to the message,
  and exposes a download link.

## Configurable cap

`Preferences.maxAttachmentBytes` (default 100 MB). Settable per device
via the chat **Settings** modal — it is the receiver-side hard limit.
Setting it to `4 * 1024 * 1024 * 1024` (4 GB) is allowed, but be aware
of browser memory limits: chunks stay in RAM until the transfer
completes. For multi-GB files we recommend a storage-provider plug-in
(see below).

## Backpressure

Each `RTCDataChannel` has a `bufferedAmount` watermark. The sender
awaits `bufferedamountlow` before pushing more chunks. This keeps
slower receivers from being overwhelmed and avoids the SCTP queue
ballooning past 1 MiB.

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
  | { kind: "file-meta";   transferId; iv; ciphertext; }   // encrypted FileMetaPlain
  | { kind: "file-chunk";  transferId; seq; iv; ciphertext; }
  | { kind: "file-end";    transferId; }
  | { kind: "file-cancel"; transferId; }
```

`FileMetaPlain` carries `name`, `mime`, `size`, `totalChunks`,
`chunkSize`, `senderId`, `senderName`, `createdAt`.
