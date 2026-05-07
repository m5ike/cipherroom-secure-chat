# M5cet — modulární jádro a storage providery

M5cet má dvě modulární vrstvy:

## 1. Frontend pluginy

`window.CipherRoomAPI` (viz `client/src/lib/cipherroom-api.ts`) drží registry tří věcí:

```ts
type WindowDescriptor = {
  id: string;
  title: string;
  render: (root: HTMLElement) => () => void; // returns cleanup
};

CipherRoomAPI.registerWindow(descriptor)
CipherRoomAPI.openWindow(id)
CipherRoomAPI.on("message" | "peer-joined" | "peer-left", handler)
```

Plugin nesmí dostat klíč ani plaintext — handler `message` dostává jen `senderId`.

## 2. Server moduly

`server/modules.ts` exportuje manifest publikovaný na `GET /api/modules`. Operátor
pole zapne přes env vars:

| Modul        | Toggle                                  | Status v této fázi |
|--------------|------------------------------------------|--------------------|
| audio        | vždy zapnuto (WebRTC)                   | hotové             |
| attachments  | vždy zapnuto (DataChannel ≤ 512 kB)     | hotové             |
| push         | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | subscribe stub; reálné delivery TODO |
| eventLogging | `LOG_EVENTS=1`, `DATABASE_URL` (volit.) | hotové (memory/SQLite) |
| settingsSync | vždy zapnuto                            | in-memory stub     |
| audit/consent| vždy zapnuto                            | in-memory stub     |

## 3. Storage / cloud providery (interface skeleton)

V této fázi neimplementujeme reálné upload pipeline. Plánované rozhraní:

```ts
export interface MediaStorageProvider {
  id: "s3" | "gcs" | "spaces" | "azure";
  put(key: string, body: ReadableStream, mime: string): Promise<{ url: string }>;
  get(key: string): Promise<{ stream: ReadableStream; mime: string }>;
  delete(key: string): Promise<void>;
  presign(key: string, op: "put" | "get", ttlSec: number): Promise<string>;
}
```

| Provider          | SDK pakety                                  | Env vars                         |
|-------------------|---------------------------------------------|----------------------------------|
| AWS S3            | `@aws-sdk/client-s3`                        | `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Google Cloud      | `@google-cloud/storage`                     | `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS` |
| DigitalOcean Spaces| `@aws-sdk/client-s3` (S3-compat)           | `DO_SPACES_ENDPOINT`, `DO_SPACES_KEY`, `DO_SPACES_SECRET`, `DO_SPACES_BUCKET` |
| Azure Blob        | `@azure/storage-blob`                       | `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_BLOB_CONTAINER` |

Šifrování souborů: nahrávané soubory by měly být zašifrované klientem stejným
AES-GCM klíčem jako texty v DataChannelu. Server tedy ukládá ciphertext, ne plaintext.

## 4. Peering / key exchange surface

Pro budoucí (mimo tuto fázi) per-peer výměnu klíčů:

```
GET  /api/peering/identity?peerId=... → { x25519PublicKey }
POST /api/peering/handshake           → { from, to, ciphertext }
```

V této fázi M5cet stále používá symetrický klíč odvozený z passphrase (sdílený
out-of-band). Asymetrický handshake zůstává TODO.
