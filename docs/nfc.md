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
  services. **EMV** — *Read card data* (6.5): PPSE → SELECT AID → GET PROCESSING
  OPTIONS → READ RECORD, then the records' BER-TLV is parsed and labelled, all
  read-only — see [EMV — read the card data](#emv--read-the-card-data).
  **e-ID / e-passport** — *Read document (BAC)* (6.5): opens the holder's own
  chip with BAC from the MRZ or CAN and reads DG1 + DG2 — see
  [e-ID / e-passport (BAC)](#e-id--e-passport-bac). No cloning, no signing.
- **ISO-DEP / EMV — Application template** — next to *Select application* a
  filled-down-arrow button drops a menu of the operator's saved templates
  (`m5mobile.define.apduTemplates` — see [define.md](define.md) and
  [APDU templates](#apdu-templates)). Two kinds of entry: an **op template**
  (`{ label, op }`) runs a full dynamic read (`emv-read` / `eid-read`); an
  **apdu template** (`{ label, apdu }`) sends one raw SELECT/command over
  ISO-DEP and shows the response. On the phone it is a popup menu, on the web a
  dropdown that loads and runs the entry in the APDU console. Read-only,
  standard SELECT/APDU — the same stance as the rest of the tool.
- **Change UID** — set the UID / block 0 on a Gen1a (backdoor) or Gen2 magic
  card you own.

Where an operation isn't reachable on the chosen reader it is disabled with a
clear note rather than faked; reading the UID and public data always works.

### EMV — read the card data

The workbench op **Read card data** (6.5) reads an EMV payment card exactly the
way a contactless terminal's first pass does, and no further. The sequence is
the standard one:

1. **PPSE** — `SELECT 2PAY.SYS.DDF01` lists the card's applications (the AIDs,
   by the directory's priority). With no PPSE the reader falls back to the
   well-known candidate AIDs and keeps the ones the card selects.
2. **SELECT AID** — opens each application (up to four) and reads its FCI.
3. **GET PROCESSING OPTIONS** — sends the card its PDOL filled with a terminal's
   default data objects so it returns its AIP and AFL. These defaults only make
   the card hand over its records; they do **not** authorise or run a transaction.
4. **READ RECORD** — reads the files the AFL points at (a light scan of the first
   files when there is no AFL).

The records' BER-TLV is parsed into a full tag tree, and the known elements are
labelled (`client/src/lib/nfc/emv-tags.ts`): the **AIDs** and **application
labels**, the **PAN** (tag 5A or the Track 2 equivalent, shown masked), the
**expiry** (5F24) and effective date (5F25), the **cardholder** name (5F20,
absent on most contactless cards), the **issuer country** (5F28), the **PAN
sequence** (5F34), the **ATC** (9F36) and the **PIN-try counter** (9F17, read as
a value — never checked), plus the PPSE's TLV as a readable tree.

**Strict read-only.** The reader never verifies a PIN (the PIN-try counter is
read, never a VERIFY), never runs `GENERATE AC` for a real transaction, never
reads a cryptogram, and writes nothing — the same bytes a payment terminal sees
on the holder's own card. No cloning.

### e-ID / e-passport (BAC)

The workbench op **Read document (BAC)** (6.5) reads an electronic passport or
e-ID (an MRTD, ICAO 9303) — the holder's own document, read-only.

**BAC (Basic Access Control)** is the *document's own* access control: the chip
will not answer until the reader proves it can already see the document's
printed data. The BAC key is derived from three fields of the **MRZ** (the
machine-readable zone printed in the document) — the **document number**, the
**date of birth** and the **date of expiry** — or from a **CAN** (the 6-digit
Card Access Number) the holder supplies. So a document can only be read by
someone who physically holds it and can read its MRZ or CAN; it is not an
over-the-air read of a stranger's passport.

After BAC opens the chip, the reader reads over **secure messaging** (encrypted
and MAC'd with the session keys BAC establishes): **EF.COM** (which data groups
are present), **DG1** (the MRZ fields — document code and number, issuer,
nationality, name, date of birth, sex, date of expiry) and **DG2** (the face
image, JPEG or JPEG 2000). The DES/3DES, retail MAC, BAC key derivation and
secure messaging are byte-exact to the ICAO 9303 worked example and unit-tested
(`client/src/lib/nfc/cards/bac.ts`, `des.ts`). PACE-only documents (no BAC) are
reported, not forced. Read-only: it reads only the groups a border reader reads,
and writes nothing.

### APDU templates

The **Application template** button reads one array define,
`m5mobile.define.apduTemplates` — the operator's saved set of templates. An
entry is one of two shapes:

- **op template** — `{ label, op: "emv-read" | "eid-read", args? }`. Runs a full
  dynamic read; the reader drives the whole sequence itself (PDOL / AFL for EMV,
  BAC + secure messaging for e-ID). `args` carries defaults, e.g.
  `{ readPhoto: false }` for an MRZ-only e-ID read.
- **apdu template** — `{ label, apdu: "<hex>" }`. Sends one raw command (a
  `SELECT`, a `GET PROCESSING OPTIONS`…) over ISO-DEP and shows the response in
  the APDU console.

Either may also carry `aid` (for display) and `note` (one line). The standard
set — PPSE/PSE selects, the common payment-scheme AIDs, the eMRTD application
and EF selects, plus the full `emv-read` / `eid-read` ops —
ships in `client/src/lib/nfc/apdu-templates.ts`
(`STANDARD_APDU_TEMPLATES`). An operator loads it in one click with
**Console › Android › Define › Load standard EMV / e-ID templates** (see
[define.md](define.md)); the console writes it as the `apduTemplates` constant.

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
const pay  = await m5.nfc.emv.read();          // 6.5: result.emv
const doc  = await m5.nfc.eid.read({ mrz });   // 6.5: result.mrtd
const readers = await m5.nfc.enum();           // readers + technologies now
```

Python mirrors it (`await m5.nfc.scan()`, `m5.nfc.m5.read(...)`,
`m5.nfc.emv.read(...)`, `m5.nfc.eid.read(...)`). `m5.nfc.reader(kind)`
scopes the following calls to a reader.

### `m5.nfc.emv` / `m5.nfc.eid` (6.5)

Both drive the caller's reader the same bidirectional way — read-only, the
holder's own card or document, the public / holder data a terminal reads.

```js
// EMV — read the card's applications and records (PPSE → AID → GPO → records).
const { emv } = await m5.nfc.emv.read({ timeout, maxApps });
//   emv.scheme                         Visa / Mastercard / Amex / … (top AID)
//   emv.aids   : string[]              every AID the card offered (hex)
//   emv.apps[] : { aid, label, scheme, pan, panMasked, expiry, cardholder,
//                  effective, issuerCountry, panSequence, atc, pinTryCounter,
//                  tags[{ tag, name, value, hex }] }
//   emv.tree                           the PPSE's TLV as a readable tree

// e-ID / e-passport — open with BAC (the holder's MRZ or CAN) and read DG1 + DG2.
const { mrtd } = await m5.nfc.eid.read({
  mrz,                                  // the whole MRZ (BAC key derived from it)
  // or the three BAC fields instead:  documentNumber, dateOfBirth, dateOfExpiry (YYMMDD)
  // or a Card Access Number:          can
  readPhoto,                            // default true; false = DG1 only, faster
});
//   mrtd.access     : "none" | "bac" | "pace"
//   mrtd.dataGroups : string[]         e.g. ["DG1","DG2"]
//   mrtd.mrzInfo    : { documentNumber, issuer, nationality, surname,
//                       givenNames, dateOfBirth, sex, dateOfExpiry, … }
//   mrtd.photo, mrtd.photoMime         the face image, base64 (when readPhoto)
```

The op ids on the wire are `emv-read` and `mrtd-read`. The server bounds what
comes back (`server/functions/host-nfc.ts`): holder / public string fields only
(capped), and the photo capped (base64 ≤ ~400 kB). As everywhere in `m5.nfc`,
no key or PIN ever reaches the model, and nothing is written.

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
cloning. EMV is read-only — the holder's own card, the public / holder data a
terminal reads, never a PIN, cryptogram or transaction; an e-ID / e-passport is
opened only with the holder's own MRZ or CAN (the document's own BAC) and read,
never written.
