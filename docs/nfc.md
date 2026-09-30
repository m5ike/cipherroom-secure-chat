# NFC / RFID (6.3)

The NFC workbench — in the web client and, to parity, in the Android app —
reads, writes and emulates NFC cards, and carries the app's own encrypted
**M5Cet card**. A Functions model can drive the reader through `m5.nfc`.

It is a utility for the cards **you** hold. It does standard operations only:
read a card's public identity and NDEF; read and write sectors, pages or files
with the keys you supply (a key dictionary, as MIFARE Classic Tool uses); change
the UID of a UID-changeable ("magic") card you own; emulate your own cards; and
the M5Cet card in full. It does **not** recover unknown keys (no nested /
darkside / hardnested) and does not clone payment cards — EMV and e-ID are read
as **public data only** (no PIN, no signing, no transaction).

## Readers

The tool drives four kinds of reader; the workbench offers those the platform
exposes and remembers the last choice.

| Reader | Web | Android |
|--------|-----|---------|
| **This device** (internal antenna) | WebNFC (`NDEFReader`, Android Chrome) | `NfcAdapter` reader-mode |
| **USB** PC/SC (CCID) — ACR122U, ACR1252U… | WebUSB | USB host (CCID) |
| **Bluetooth** (PN532 / vendor bridge) | Web Bluetooth | BLE (interface; connect your reader) |
| **Serial** (PN532 on USB-serial) | Web Serial | — |

WebNFC needs Android Chrome; desktop browsers reach cards only through a USB /
serial / Bluetooth reader. The workbench feature-detects each transport and says
which are available.

## Card technologies

Detected and enumerated (`client/src/lib/nfc/catalog.ts`, the same names on
Android): the **M5Cet card**, the M5cet **connection tag**, generic **NDEF**
(Type 1–5), **MIFARE Classic** 1K / 4K / Mini, **MIFARE Ultralight**, **NTAG**
213/215/216, **MIFARE DESFire** EV1/2/3, **ISO-DEP** (ISO 14443-4), **ISO/IEC
14443** Type A/B, **ISO/IEC 15693**, **FeliCa**, **EMV** (public), and
**electronic ID / MRTD** (public). A continuous scan shows the UID, the detected
type and any public NDEF; "Run function" then offers exactly the operations that
technology supports.

### Operations per type

Common to every card: **scan**, **read UID**, **read public data**, and a raw
**APDU** console for ISO-DEP. Then, by type:

- **NDEF** — read, write, make read-only.
- **MIFARE Classic** — read / write / dump / restore, authenticating each sector
  with a key A/B from your **key dictionary** (a list you manage; the factory
  key `FFFFFFFFFFFF` is tried first). No key recovery.
- **Ultralight / NTAG** — read and write pages, set the password (PWD/PACK/AUTH0),
  read the NFC counter and signature.
- **DESFire** — list applications and files; read/write a file after
  authenticating with its key (AES / 2K3DES). On the web this needs a reader with
  an auth stack; where it isn't reachable the op is shown disabled.
- **ISO 15693** — read/write blocks. **FeliCa** — read systems and public
  services. **EMV** — PPSE and the application labels, and where freely readable
  the masked PAN and expiry, read-only. **e-ID** — the document type and the data
  the holder unlocks by typing the CAN/MRZ; no cloning, no signing.
- **ISO-DEP / EMV — Application template** — next to *Select application* a
  filled-down-arrow button drops a menu of the operator's saved APDU templates
  (`m5mobile.define.apduTemplates`, an array of `{ label, apdu }` — see
  [define.md](define.md)). Picking one sends its APDU over ISO-DEP and shows the
  response, on the phone (a popup menu) and on the web (a dropdown that loads and
  runs it in the APDU console). Read-only, standard SELECT/APDU — the same stance
  as the rest of the tool.
- **Change UID** — set the UID / block 0 on a Gen1a (backdoor) or Gen2 magic
  card you own.

Where an operation isn't reachable on the chosen reader it is disabled with a
clear note rather than faked; reading the UID and public data always works.

## The M5Cet card

An M5Cet card is the app's own encrypted format on an ordinary NFC tag. It holds
one or more **records**, each sealed on its own so a card can mix things (a Wi-Fi
login beside a contact) and a one-time record can be erased without touching the
rest. The bytes are the same on the web and Android
(`client/src/lib/nfc/m5card.ts` ↔ `nfc/M5Card.java`, verified by a parity test),
and ride an NDEF external record of type `m5cet.cz:card`.

### Record types

- **Passkey backup** and **Identity backup** — restore your account's passkey /
  identity and keys onto a device (internal encryption; see below).
- **One-time message** — shown once in the chat window, then erased from the card.
- **Message** — text, a URL, a small file, or a key plus a reference to a larger
  message kept on the server.
- **Server & room** — a server, room and passphrase; opening it offers to join.
- **External key** — an encryption key to import.
- **Contact** — a vCard.
- **Wi-Fi** — SSID, password, auth.
- **URL login** — a URL, username and password.

When a card is read, its records are listed with an icon, a label and a summary
(never a secret), each with a detail and one action — **display** (show it),
**save** (import: a contact, a Wi-Fi login, a key, an identity) or **run** (join
the room, open the URL). A one-time record erases itself after it is shown
(the reader rewrites the card without it and confirms).

### Encryption: PIN or passkey

Each record is AES-GCM-256, keyed one of two ways:

- **PIN (external)** — PBKDF2-SHA256 of a **6–18 digit** PIN (600 000 rounds,
  a per-record salt). The card opens on **any** device with the PIN.
- **PassKey (internal)** — HKDF of your signed-in account's root
  (`info = "m5cet:nfc:card:v1"`). The card opens only on **your own** devices.
  The account root never leaves the device.

Backups default to a PIN so they can be restored elsewhere; a private note can be
bound to your account. A card mixes both.

### The builder

The visual builder (web and Android) makes a card: add records from the list,
fill each one's fields, choose its encryption (PIN or passkey) and whether it is
one-time, reorder and remove, watch the size against the tag's capacity, then
write. Editing a card re-opens what the PIN / account can decrypt and lets you
change it.

### The format

```
container = "M5CD" | ver(1) | flags(1) | count(1) | record*
record    = type(1) | mode(1) | rflags(1) | id(3) | salt(1+n) | iv(1+n)
            | ct(u16 BE + bytes)              ct = AES-GCM(plaintext)
            AAD = "M5CD" | ver | type | id    mode: external=0, internal=1
```

An unknown record type is skipped, not fatal, so newer cards still open on older
apps. A card holds at most 64 records.

## `m5.nfc` in Functions

A model can drive the caller's reader, both ways — it asks for an operation and
the caller's device runs it and returns the result:

```js
const seen = await m5.nfc.scan();              // UID, type, public NDEF
const uid  = await m5.nfc.card();              // identity only
const dump = await m5.nfc.read({ what: "dump", secretRef: "keyset:door" });
await m5.nfc.write({ what: "ndef", ndef: [{ kind: "uri", data: "https://…" }] });
const card = await m5.nfc.m5.read({ records: ["wifi"] });
const readers = await m5.nfc.enum();           // readers + technologies now
```

Python mirrors it (`await m5.nfc.scan()`, `m5.nfc.m5.read(...)`). `m5.nfc.reader(kind)`
scopes the following calls to a reader.

Under the hood an `m5.nfc` call becomes an **NFC interaction** on the run's live
channel (the same one prompts and forms use): the model's `await` suspends, the
command streams to the caller, the client's NFC bridge runs it and answers with
the result, which resolves the call. It works from an `execute` run and from a
webhook-entered run, so a webhook can initiate an NFC command and receive the
result. The caller's device must have the NFC workbench active (that registers
the executor); otherwise a call returns `status: "unsupported"`.

**Access** is gated like `m5.telephony`: a person's run needs their NFC module
access, a webhook's or a schedule's run the model's grant.

**No raw keys.** A model never receives or sends a card key or PIN. To use a
protected card it passes `secretRef` — a name the device resolves locally
(a saved key set, or the account) — and the device never returns the key.
The server strips any secret-named argument on the way in and whitelists the
result on the way out.

### Builder nodes and packages

The visual flow builder has an **NFC** node group (scan, read, write, M5Cet
read / build, emulate, enum) with result visualization, and three built-in
command packages: **`/nfc-scan`** (scan a card), **`/nfc-uid`** (its UID only)
and **`/nfc-open`** (open an M5Cet card). They ship **off** — a model needs a
device with NFC access — and an operator turns them on in Functions.

## Privacy and scope

Card reads and writes happen on the device. An M5Cet record's plaintext never
reaches the server; only the ciphertext rides a tag. A tag is exposed media —
anyone in proximity can read its bytes — so the PIN or the account key is the
real boundary, not the air gap. The tool does no key recovery and no payment-card
cloning; EMV and e-ID are public-presence reads only.
