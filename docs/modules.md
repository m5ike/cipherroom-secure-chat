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

Skutečný tvar `window.CipherRoomAPI` dnes: `{ version, capabilities, modules(),
pushStatus(), recordEvent(), on() }`. `registerWindow` / `openWindow` výše jsou
plánované rozhraní, v kódu zatím nejsou.

## 2. Server moduly

`server/modules.ts` exportuje manifest publikovaný na `GET /api/modules`. Operátor
pole zapne přes env vars:

| Modul        | Toggle                                  | Status v této fázi |
|--------------|------------------------------------------|--------------------|
| audio        | vždy zapnuto (WebRTC)                   | hotové             |
| attachments  | vždy zapnuto                             | hotové přes DataChannel: inline ≤ 512 KiB, větší po 32 KiB chuncích; záložní proxy relay přes server **nedoručuje** (viz `files.md`) |
| push         | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | hotové — reálné doručení přes `web-push`; test push jen na vlastní id odběru, broadcast jen s admin tokenem; subskripce jen v paměti, chybí unsubscribe |
| turn         | `TURN_SERVER_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | hotové — `GET /api/turn` (statické údaje) |
| eventLogging | `LOG_EVENTS=1`                           | hotové — **jen in-memory ring (500 záznamů)**; `DATABASE_URL` přepne štítek backendu na `database`, ale zápis do DB je no-op stub (`server/events.ts`) |
| settingsSync | vždy zapnuto                            | in-memory stub     |
| audit/consent| vždy zapnuto                            | in-memory stub; `audit/log` nemá zapisovatele (vrací `[]`), klient consent/settings endpointy nevolá |
| retention    | `*_RETENTION_DAYS`, `RETENTION_SWEEP_MINUTES` | hotové — sweep sám každých `RETENTION_SWEEP_MINUTES` (výchozí 60, `unref` timer) + ručně `POST /api/admin/retention/run` (admin token); maže settings, audit, push, consent i události, každou kategorii podle jejího okna |

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

## 5. Moduly aplikace a skupiny (konzole › *Modules & groups*)

Vedle manifestu výše má aplikace od 4.0 **katalog modulů**
(`client/src/lib/modules.ts`, `MODULE_CATALOG`; v 6.7 20 modulů: `audio`,
`video`, `files`, `location`, `speech`, `ai`, `functions`, `telephony`,
`layout`, `android`, `menu`, `nfc`, `rooms`, `invites`, `connections`,
`notifications`, `analytics`, `appearance`, `editMode`, `voiceChanger`).
Pravidla modulů a skupiny ukládá konzole do konfigurace klienta
(`modules`, `groups`); katalog dostává konzole přes
`/api/admin/client-config` (`catalog.modules`). Podrobně
[dokumentace › Moduly a skupiny](site/index.html#moduly).

Kdo smí modul používat, rozhoduje `decide(policy, id, groups)`:

1. **žádné pravidlo** → modul je zapnutý pro všechny (`unlisted`) —
   **kromě modulu s `offByDefault`** (6.7), ten je bez pravidla vypnutý
   (`off`);
2. `enabled: false` → vypnuto pro všechny;
3. člen hlavní skupiny `mod-<modul>` (moduly s právy) → vše;
4. člen přístupové skupiny → `groupAccess` (výchozí allow), jinak
   `defaultAccess` (výchozí deny, když pravidlo skupiny vyjmenovává, jinak
   allow);
5. **granty** skupin uživatele přidají (`model:dns*`) nebo uberou
   (`-model:admin*`) části; samotný grant pustí dovnitř jen s těmi částmi.

### `voiceChanger` a `offByDefault` (6.7)

`offByDefault?: boolean` má zatím jen modul **`voiceChanger`** (měnič hlasu,
panel `voiceChanger`; viz [`speech.md`](speech.md#the-voice-changer)). Bez
pravidla je vypnutý; operátor ho zapne zaškrtnutím *On* v *Modules & groups*
(a uložením), případně omezí přístupem a granty v *Settings…* jako jiný
modul. Konzole u něj ukazuje *On* nezaškrtnuté a odznak „off“, ve sloupci
služby „in the browser“ (nemá serverovou část); vypnutí pravidlo smaže
(výchozí stav), zapnutí ho uloží.

Modul hlídá jen klient — server pro měnič hlasu žádný endpoint nemá, zvuk
neopouští zařízení: web `setVoiceFxAllowed(moduleOn("voiceChanger"))`
(`App.tsx`), Android `voice/FxGate.java` (konfiguraci klienta se ptá znovu
každých 10 minut, po chybě za minutu). Teprve s povoleným modulem si každý
uživatel měnič zapne u sebe (web *Menu › Tools › Voice changer*, Android
*Settings › Voice › Voice changer*); položka webového menu bez modulu není
vidět, obrazovka na Androidu řekne, že ho provozovatel nezapnul.
