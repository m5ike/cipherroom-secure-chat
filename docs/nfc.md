# NFC / RFID (6.3 – 6.6)

The NFC workbench — in the web client and, to parity, in the Android app —
reads, writes and emulates NFC cards, and carries the app's own encrypted
**M5Cet card**. A Functions model can drive the reader through `m5.nfc`.

It is a utility for the cards **you** hold. It does standard operations only:
read a card's public identity and NDEF; read and write sectors, pages or files
with the keys you supply (a key dictionary, as MIFARE Classic Tool uses); change
the UID of a UID-changeable ("magic") card you own; emulate your own cards; and
the M5Cet card in full. It does **not** recover unknown keys (no nested /
darkside / hardnested) and does not clone payment cards — EMV and e-ID are
**read-only**: what a payment terminal or a border reader may read from the
holder's own card or document (no PIN, no signing, no transaction, no write).

6.6 reads them **in depth** — an EMV card's counters, transaction history and
every file; an e-ID's every data group a reader may open, its pictures and
security objects — and turns any read into a **card report** (HTML, object,
rows, JSON, text, CSV). An e-ID opens with **PACE** (the CAN or the MRZ) or
BAC. The deep reads are in the web client's reader
(`client/src/lib/nfc/cards/emv.ts`, `mrtd.ts`, `pace.ts`) and, ported, in the
Android app's native reader (`nfc/EmvReader.java`, `MrtdReader.java`,
`PaceProtocol.java`), whose workbench shows them too. A model's NFC request is
answered by the web workbench and, in 6.6, by the Android app itself (a sheet
on the phone — see [`m5.nfc` on Android](#on-android-the-apps-nfc-sheet-66)).
On the web, EMV and e-ID need a reader that exchanges APDUs — USB, Bluetooth or
serial; WebNFC reaches NDEF only.

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
  services. **EMV** — *Read card data* (6.5, deep read 6.6): PPSE → SELECT
  AID → GET DATA → the transaction log → GET PROCESSING OPTIONS → READ RECORD
  (the AFL's records and every other short file), then the records' BER-TLV is
  parsed and labelled, all read-only — see
  [EMV — read the card data](#emv--read-the-card-data).
  **e-ID / e-passport** — *Read document (PACE / BAC)* (6.5, every data group
  and PACE 6.6): opens the holder's own chip with the key they supply and reads
  every data group a reader may — see [e-ID / e-passport](#e-id--e-passport).
  No cloning, no signing.
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

The workbench op **Read card data** (6.5, deep read 6.6) reads an EMV payment
card the way a contactless terminal does before a transaction, and no further
(`client/src/lib/nfc/cards/emv.ts`). The sequence:

1. **PPSE** — `SELECT 2PAY.SYS.DDF01` lists the card's applications (the AIDs,
   by the directory's priority). With no PPSE the reader falls back to the
   well-known candidate AIDs and keeps the ones the card selects.
2. **SELECT AID** — opens each application and reads its FCI: up to `maxApps`
   applications (default 8, at most 16; 6.5 opened four).
3. **GET DATA** (6.6) — asks the application for the data objects a terminal
   may ask for: the **ATC** (9F36), the **last online ATC** (9F13), the
   **PIN-try counter** (9F17), the **log entry** (9F4D — which short file holds
   the transaction log, and how many records) and the **log format** (9F4F),
   plus a few balance / issuer objects (9F50, 9F51, 9F5D, 9F6D, 9F6E, 9F79,
   DF60–DF62). Whatever the card answers is kept; what it refuses is skipped.
4. **The transaction log** (6.6, `history`, on by default) — read **before**
   GET PROCESSING OPTIONS, while no transaction is under way. When the FCI or
   GET DATA gives a log entry, the reader reads that file's records (up to the
   count the card gives — 30 when it gives none — at most 50, stopping at the
   first record the card refuses) and decodes each one by the card's own log
   format: `date`, `time`, `amount` and `otherAmount` (in major units, by the
   currency's exponent), `currency` and `country` (as letters), `type`
   (purchase, cash, refund…), `merchant`, `atc`, `cid` (approved / declined /
   online, from the cryptogram information data); any other element stays under
   its tag. Empty slots are skipped; `raw` keeps each record's hex. Without a log
   format only the raw records are kept. Not every card keeps a readable log.
5. **GET PROCESSING OPTIONS** — sends the card its PDOL filled with a terminal's
   default data objects so it returns its AIP and AFL. These defaults only make
   the card hand over its records; they do **not** authorise or run a transaction.
6. **READ RECORD** — reads the files the AFL points at. With a **deep** read
   (6.6, `deep`, on by default) the reader then tries every other short file,
   SFI 1–30, record by record (up to 16 per file, a file that refuses a record
   is left at once; 240 extra READ RECORDs per card at most), skipping the log's
   file. Without `deep` and without an AFL it scans the first four files only,
   as 6.5 did.

The records' BER-TLV is parsed into a full tag tree, and the known elements are
labelled (`client/src/lib/nfc/emv-tags.ts`): the **AIDs** and **application
labels**, the **PAN** (tag 5A or the Track 2 equivalent; the workbench shows it
masked), the **expiry** (5F24) and effective date (5F25), the **cardholder** name
(5F20, absent on most contactless cards), the **issuer country** (5F28), the
**PAN sequence** (5F34), the **ATC** (9F36), the **last online ATC** (9F13) and
the **PIN-try counter** (9F17, read as a value — never checked), plus the PPSE's
TLV as a readable tree. 6.6 also keeps, per application, the **AIP** and **AFL**
(hex), what **GET DATA** answered, the log's format and file, the decoded
**history**, and **every record as read** (SFI, record number, hex — the log's
records marked). The read says whether it was deep and how many APDUs it took.

**Strict read-only.** The reader never verifies a PIN (the PIN-try counter is
read, never a VERIFY), never runs `GENERATE AC` for a real transaction, never
reads a cryptogram, and writes nothing — GET DATA and READ RECORD only read what
the card shows any terminal, the history included. No cloning.

### e-ID / e-passport

The workbench op **Read document (PACE / BAC)** (6.5; every data group and
PACE 6.6) reads an electronic passport or e-ID (an MRTD, ICAO 9303) — the
holder's own document, read-only (`client/src/lib/nfc/cards/mrtd.ts`; on
Android `nfc/MrtdReader.java`, the same reader ported).

**Opening the chip.** The chip will not answer until the reader proves it can
already see the document's printed data — the *document's own* access control.
The holder supplies the **MRZ** (the machine-readable zone printed in the
document: the whole zone, or just the **document number**, **date of birth**
and **date of expiry**), or the **CAN** (the 6-digit Card Access Number printed
on an ID card). So a document can only be read by someone who physically holds
it and can read its MRZ or CAN; it is not an over-the-air read of a stranger's
passport. Before opening, the reader reads **EF.CardAccess** — readable without
a key — and records the security protocols the chip announces
(`mrtd.security.protocols`).

**PACE** (6.6) — Password Authenticated Connection Establishment, ICAO 9303-11
§4.4 / BSI TR-03110, with the **CAN** or the **MRZ** as the password, on the web
(`client/src/lib/nfc/cards/pace.ts` — `establishPace` — with `aes.ts`, `ec.ts`
and `sm.ts`) and on Android (`nfc/PaceProtocol.java`; `Pace.java` reads the
PACEInfo and its `establish` delegates to `PaceProtocol`; `Aes.java`,
`EcCurve.java`, `AesSm.java`). It runs the **ECDH generic mapping** on the
standardized domain parameters **12, 13, 15, 16, 17 and 18** (NIST P-256,
brainpoolP256r1, NIST P-384, brainpoolP384r1, brainpoolP512r1, NIST P-521),
with **AES-128 / 192 / 256 or 3DES** secure messaging (AES: `aesChannel`;
3DES: the BAC channel with a zero SSC). Not supported: the DH mapping,
Integrated Mapping, Chip Authentication Mapping (CAM) and other curves. When
EF.CardAccess offers a variant the reader runs, it tries PACE first (the
strongest cipher offered; with the CAN when one is given, else the MRZ); when
it offers none the reader runs — or PACE fails — and the MRZ is given, it opens
the document with BAC. The CAN alone therefore opens a PACE document; a
passport without PACE needs the MRZ. `mrtd.pace` says what the chip offers
(`supported`, `protocol`, `parameterId`) and, when PACE opened it, `used` and
`password` (`can` or `mrz`); `mrtd.access` is then `pace`. The implementation is
pinned byte for byte to the worked examples of ICAO 9303-11 Appendix G.1
(PACE-ECDH-GM-AES-128), Appendix I.1 (its mapping, key agreement and tokens)
and the BSI TR-03110 EAC2 worked example (the logged PACE exchange and the
secure-messaging APDUs after it) — `test/nfc-pace.test.ts` with
`test/fixtures/pace-vectors.json`, and on Android
`android/app/src/test/java/cz/m5cet/app/nfc/PaceTest.java` on the same vectors;
both also open a simulated PACE chip with the CAN and the MRZ.

**BAC (Basic Access Control).** The BAC key is derived from the three MRZ
fields. The DES/3DES, retail MAC, BAC key derivation and secure messaging are
byte-exact to the ICAO 9303 worked example and unit-tested
(`client/src/lib/nfc/cards/bac.ts`, `des.ts`, `sm.ts`); `mrtd.access` is `bac`.
Inside 3DES secure messaging (BAC, and PACE with 3DES) the status word the chip
protected in DO'99' is taken as the command's real one (6.6, `bac.ts` and
Android `Bac.java`) — a chip may answer 9000 outside while the file is absent
(6A82) or EAC-protected (6982) inside.
When the chip cannot be opened, `mrtd.message` says why and no data group is
read.

**What is read** — over **secure messaging**, everything a reader may read
without a government terminal certificate:

| File | What it gives |
|------|---------------|
| **EF.COM** | which data groups are present, the LDS and Unicode versions |
| **EF.SOD** | each group's hash, the hash algorithm, the document signer certificate (subject, issuer, serial, validity) |
| **DG1** | the MRZ fields — document code and number, issuer, nationality, name, date of birth, sex, date of expiry, optional data |
| **DG2** | **every** face image (each biometric block), JPEG or JPEG 2000 |
| **DG5 / DG7** | displayed portrait(s), signature or usual mark image(s) |
| **DG11** | more personal details — full name, other names, personal number, full date of birth, place of birth, address, telephone, profession, title, personal summary, other travel documents, custody; a proof-of-citizenship image |
| **DG12** | more document details — issuing authority, date of issue, other persons, endorsements, tax / exit, personalization time and system; front / rear document images |
| **DG13** | optional country-defined details (as text when it is text, else hex) |
| **DG14 / DG15** | the security protocols the chip supports; the Active Authentication public key (RSA size, or EC curve) |
| **DG16** | persons to notify |

**DG3 / DG4** (fingerprints, iris) need Extended Access Control — a government
terminal certificate — and are **not read**: they are listed as *protected*. The
reader reads the groups EF.COM lists (when EF.COM gives none: DG1, DG2, DG5,
DG7, DG11–DG16), each up to a size cap (DG2 96 kB…), with extended-offset READ
BINARY beyond 32 kB; a group cut short is marked *truncated*. Every file tried
is listed with its status (read / protected / absent / error) and size.

**Passive authentication — the hash check.** Each group read in full is hashed
and compared with the hash EF.SOD lists for it (`hashOk` per file;
`security.passive` is `ok`, `mismatch` or `unchecked`). That shows the data
matches what EF.SOD lists — **no more**: the signature on EF.SOD is not
verified, the document signer certificate is **not** checked against a CSCA
list, and Active / Chip Authentication are not run (DG14 / DG15 are only
decoded). The report says *passive authentication*, but read it as an integrity
check of the read, not as proof the document is genuine.

**Pictures and files.** Every picture becomes `mrtd.images[]` — `{ group, kind
(face | portrait | signature | document | other), mime, data (base64), name }`
(e.g. `face.jpg`, `face-2.jp2`, `signature.png`, `document-front.jpg`);
`photo` / `photoMime` stay the first face, as in 6.5. The raw files are
`mrtd.raw[]` for download: `EF.CardAccess.bin`, `EF.COM.bin`, `EF.SOD.bin`,
`document-signer.cer`, `DG1.bin`, `DG11.bin` … `DG16.bin`. Options:
`readPhoto: false` skips the picture groups (DG2, DG5, DG7) and the scans in
DG11 / DG12; `all: false` reads only DG1 and DG2 (and skips EF.SOD).

Read-only: it never writes. Unit tests drive the reader against a simulated
BAC chip (`test/nfc-mrtd-deep.test.ts`: every group, a hash mismatch, DG1 / DG2
only, a wrong MRZ, no key) and a simulated PACE chip (`test/nfc-pace.test.ts`),
and parse EF.SOD, DG11, DG12, DG15 and SecurityInfos on their own; the Android
reader is tested the same way (`MrtdDeepTest.java`, `PaceTest.java`).

### Card reports (6.6)

`client/src/lib/nfc/card-report.ts` turns any read — an `NfcResult`, or just
its `emv` / `mrtd` part; an EMV card, an e-ID, a plain scan — into a report in
one of six formats. It is one pure module (no DOM, no Node): the Functions
sandbox formats with it (`m5.nfc.format`, `m5.nfc.emv.report`…, the Builder's
NFC nodes) and the workbench exports with it.

| Format | `value` | `mime` |
|--------|---------|--------|
| `html` | every field for the chat: sections, key–value tables, the history as a table, collapsible data elements / GET DATA / records / files, the face beside the holder's data, the other pictures inline (`data:` URIs), JPEG 2000 pictures as placeholders, the attachments listed — a fragment styled by the `m5h-*` classes ([`m5.out.html`](functions-architecture.md)) | `text/html` |
| `object` | one normalized object (`type: "emv" \| "mrtd" \| "card"`, title, summary, the card, the applications or the holder / personal / document / security parts, files, images with sizes) | `application/json` |
| `array` | the same as rows `{ section, field, value }` | `application/json` |
| `json` | the object as JSON text | `application/json` |
| `text` | a plain-text report | `text/plain` |
| `csv` | the rows as CSV (`section,field,value`) | `text/csv` |

A report is `{ kind, format, value, mime, title, summary, images[], files[] }`;
`images` and `files` are `{ name, mime, data }` (base64). **Images** are the
pictures a browser shows (JPEG, PNG, GIF, WebP); everything else is a **file**
to download — for EMV `emv-history.csv` (every application's log) and
`emv-records.txt` (every record and the PPSE tree), for an e-ID the JPEG 2000
pictures and the raw files above (`EF.SOD.bin`, `document-signer.cer`,
`DG14.bin`…), for a plain read `card-data.bin`.

Options: `lang` — labels in `en`, `cs` or `de` (in Functions the caller's
language by default); `fullPan` — the whole card number (the holder's own card);
by default the PAN is **masked** in the report (first six and last four digits),
in the tag values, GET DATA and the records' hex too; `title`; `images: false`
leaves the pictures out; `attachments: false` the files. **Card text is never
trusted**: every value is HTML-escaped in the `html` view, and the chat
sanitizes the result again like any `m5.out.html`. `cardReportDocument()` wraps
the `html` view into a standalone HTML document with its own styles (the
workbench's *HTML report* download, `m5.nfc.document`). Unit tests:
`test/nfc-card-report.test.ts`.

### The workbench's full report (6.6)

In the web client, after an EMV or e-ID read, the workbench's result tab shows
**Full report** — the `html` report exactly as the chat renders it (`FnHtml`) —
with **Export**:
*HTML report* (the standalone document, `emv-report.html` / `e-id-report.html`),
**JSON**, **CSV** and **Text**, and **Files to download** — a button for each
attachment (`EF.SOD.bin`, `document-signer.cer`, `emv-history.csv`…). The card
number stays masked in every export. Downloads are made in the browser; nothing
is sent anywhere. Labels follow the app's language. The Android workbench
shows the deep read in its own views (6.6): per EMV application the holder
fields and counters, the history as a table, GET DATA, the data elements and
records; for an e-ID the holder beside the face, DG11 / DG12, every picture,
the security objects and the files.

### APDU templates

The **Application template** button reads one array define,
`m5mobile.define.apduTemplates` — the operator's saved set of templates. An
entry is one of two shapes:

- **op template** — `{ label, op: "emv-read" | "eid-read", args? }`. Runs a full
  dynamic read; the reader drives the whole sequence itself (PDOL / AFL for EMV,
  PACE or BAC + secure messaging for e-ID). `args` carries defaults, e.g.
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
const pay  = await m5.nfc.emv.read();          // 6.5: result.emv (6.6: history, every file)
const doc  = await m5.nfc.eid.read({ mrz });   // 6.5: result.mrtd (6.6: every data group)
const rep  = await m5.nfc.emv.report({ format: "html", send: true }); // 6.6: read + format + show
const readers = await m5.nfc.enum();           // readers + technologies now
```

Python mirrors it (`await m5.nfc.scan()`, `m5.nfc.m5.read(...)`,
`m5.nfc.emv.read(...)`, `m5.nfc.eid.read(...)`, `m5.nfc.emv.report(...)`).
`m5.nfc.reader(kind)` scopes the following calls to a reader.

### `m5.nfc.emv` / `m5.nfc.eid` — the reads (6.5, deep 6.6)

Both drive the caller's reader the same bidirectional way — read-only, the
holder's own card or document, what a terminal or a border reader may read.

```js
// EMV — PPSE → SELECT → GET DATA → the log → GPO → READ RECORD (AFL; deep: every file).
const { emv } = await m5.nfc.emv.read({ timeout, maxApps, history, deep });
//   emv.scheme                         Visa / Mastercard / Amex / … (top AID)
//   emv.aids   : string[]              every AID the card offered (hex)
//   emv.apps[] : { aid, label, scheme, pan, panMasked, expiry, cardholder,
//                  effective, issuerCountry, panSequence, atc, lastOnlineAtc,
//                  pinTryCounter, aip, afl, logSfi, logFormat,
//                  log[{ date, time, amount, otherAmount, currency, country, type,
//                        merchant, atc, cid, raw, … }],
//                  getData[{ tag, name, value, hex }],
//                  records[{ sfi, record, hex, log? }],
//                  tags[{ tag, name, value, hex }] }
//   emv.tree                           the PPSE's TLV as a readable tree
//   emv.deep, emv.apdus                deep read or AFL only; APDUs it took

// e-ID / e-passport — opened with the holder's MRZ or CAN, every data group a reader may read.
// No key in the call: the caller's device asks the holder for it (below).
const { mrtd } = await m5.nfc.eid.read({
  mrz,                                  // the whole MRZ
  // or the three MRZ fields instead:  documentNumber, dateOfBirth, dateOfExpiry (YYMMDD)
  // or the Card Access Number:        can
  // or none of them:                  the device asks
  readPhoto,                            // default true (also `photo`); false = no pictures
  all,                                  // 6.6, default true; false = DG1 + DG2 only
});
//   mrtd.access     : "none" | "bac" | "pace"
//   mrtd.pace       : { supported, protocol, parameterId, used, password }
//   mrtd.dataGroups : string[]         what EF.COM lists, e.g. ["DG1","DG2","DG11","DG14"]
//   mrtd.ldsVersion, mrtd.unicodeVersion
//   mrtd.mrzInfo    : { documentCode, documentNumber, issuer, nationality, surname,
//                       givenNames, dateOfBirth, sex, dateOfExpiry, optionalData, mrz }
//   mrtd.personal (DG11), mrtd.document (DG12), mrtd.optional (DG13),
//   mrtd.personsToNotify (DG16)
//   mrtd.images[]   : { group, kind, mime, data, name }   every picture, base64
//   mrtd.photo, mrtd.photoMime         the first face, base64 (as in 6.5)
//   mrtd.files[]    : { name, fid, status, size, hashOk, message }
//   mrtd.raw[]      : { name, mime, data }               EF.SOD.bin, document-signer.cer, DG*.bin…
//   mrtd.security   : { hashAlgorithm, passive, signer{ subject, issuer, serial,
//                       notBefore, notAfter }, protocols, activeAuthKey }
```

Python takes the same as keywords: `m5.nfc.emv.read(max_apps=…, history=…,
deep=…, timeout=…)`, `m5.nfc.eid.read(mrz=…, document_number=…,
date_of_birth=…, date_of_expiry=…, can=…, read_photo=…, all=…)` (`photo=`
too; the camelCase names are accepted as well).

The op ids on the wire are `emv-read` and `mrtd-read`. The server bounds what
comes back (`server/functions/host-nfc.ts`), field by field: for EMV at most 16
applications, 256 data elements, 60 log entries, 32 GET DATA answers and 320
records (hex ≤ 1 024 characters) each; for an e-ID the strings capped (MRZ
fields 120 characters, DG11 / DG12 / DG16 500, DG13 4 000), at most 12 pictures (JPEG, JPEG 2000, PNG,
GIF or WebP; base64 ≤ 400 000 characters each, 1 400 000 together), at most 32
raw files (≤ 400 000 each, 1 200 000 together), the photo ≤ 400 000; anything
else is dropped. As everywhere in `m5.nfc`, no card key or PIN ever reaches the
model, and nothing is written. The model does receive what it asked to read —
the PAN unmasked (the holder's own card) and, for an e-ID, the holder's personal
data and pictures; only a report masks the PAN.

**On the web** the workbench's executor (`client/src/lib/nfc/web-executor.ts`)
passes the reader every option of the command: for EMV `maxApps` (default 8),
`history` and `deep` (both on unless `false`); for an e-ID the key fields,
`readPhoto` and `all` (both on unless `false`). The reads need a reader that
exchanges APDUs — a USB (PC/SC, CCID), Bluetooth or serial (PN532) reader;
WebNFC in Android Chrome reaches NDEF only.

Under the hood an `m5.nfc` call becomes an **NFC interaction** on the run's live
channel (the same one prompts and forms use): the model's `await` suspends, the
command streams to the caller, the caller's device runs it and answers with the
result, which resolves the call. It works from an `execute` run and from a
webhook-entered run, so a webhook can initiate an NFC command and receive the
result. In the web client the NFC workbench must be open (it registers the
executor), otherwise a call returns `status: "unsupported"`; the Android app
answers on its own (below).

**Access** is gated like `m5.telephony`: a person's run needs their NFC module
access, a webhook's or a schedule's run the model's grant.

**No raw keys.** A model never receives or sends a card key or PIN. To use a
protected card it passes `secretRef` — a name the device resolves locally
(a saved key set, or the account) — and the device never returns the key.
The server strips any secret-named argument on the way in and whitelists the
result on the way out.

### The e-ID key is asked on the device (6.6)

A model may ask for an e-ID read without the key. An `eid-read` / `mrtd-read`
whose args carry none of `can`, `mrz`, or all three of `documentNumber` +
`dateOfBirth` + `dateOfExpiry` (`needsDocumentKey`,
`client/src/lib/nfc/document-key.ts`) is not run as it came: the caller's
device first asks the holder for the **CAN** or the **MRZ** (or the three
fields) — in the web client locally in the interaction dialog
(`handleFnInteraction` in `client/src/App.tsx`, asking again until the entry is
usable: a 6-digit CAN, an MRZ, or the document number with both dates as
YYMMDD), in the Android app in the NFC sheet (same rule). The key is added to
this read's command only (`withDocumentKey`) and used there; it is **never sent
to the server** — the interaction is answered with what the chip returned (the
report data, the photo; DG1 holds the document's own MRZ data), not with the
key. Cancelling answers `status: "timeout"` ("Cancelled"). A model may still
pass `can` / `mrz` itself (`m5.nfc.eid.read` / `eid.report` args) — then it is
the model's choice, and they come from its own inputs, which the run history
keeps as they were.

### On Android: the app's NFC sheet (6.6)

The Android app answers a model's NFC request itself (`ui/parts/NfcModelSheet.java`,
`nfc/ModelNfc.java`, `nfc/ModelNfcDevice.java`, `nfc/ReaderMode.java`; the run's
`nfc` interaction comes through `fn/Run.java` and `ui/parts/Fn.java`):

- A **sheet from the bottom** says what is asked and by which model, then
  *Hold the card to the back of your phone*, with a **countdown** (the
  command's `timeout`: default 20 s, 1–120) and **Cancel**. Closing it before an
  answer answers `timeout` ("Cancelled"); a newer ask replaces an open sheet.
- **The reader**: the phone's own NFC by default (reader mode, borrowed from
  the workbench or whoever holds it and given back afterwards), or a **USB**
  (CCID) reader the user already allowed in the workbench — when the command
  asks for `usb`, or names no reader and the workbench's choice is USB (or the
  phone has no NFC). A **Bluetooth** or **serial** reader is answered
  `unsupported`.
- **What runs**: `scan`, `read-uid`, `read-public`, `ndef-read`, `m5-read`,
  `emv-public`, `emv-read`, `eid-public`, `eid-read` / `mrtd-read`, and `enum`
  (no card: the readers and technologies). EMV and e-ID reads take the same
  options as on the web (`maxApps`, `history`, `deep`; the key, `readPhoto`,
  `all`) and run on the native readers, PACE included. Writes and emulation are
  **`denied`**; the other reads of the catalogue — `raw-apdu`, `select-aid`,
  MIFARE Classic sectors and dumps, page and block reads, DESFire and FeliCa
  reads — are refused for a model (`unsupported`: use the NFC workbench).
- **NFC off**: the answer is `unsupported`, and the sheet says so with a button
  to the NFC settings.
- **The e-ID key**: asked in the sheet as above; the fields are cleared once the
  read starts, and a CAN that shows up in a reader's message is masked in the
  answer.

### Card reports in Functions (6.6)

One host-side formatter (`card-report.ts`, called from `server/functions/sandbox/host-pure.ts`)
for JavaScript and Python — see [Card reports](#card-reports-66).

```js
// Read, format and (send: true) show it — what the Builder's NFC.EMV / NFC.e-ID tools run.
const r  = await m5.nfc.emv.report({ format: "html", send: true, history: true, deep: true,
                                     fullPan: false, maxApps: 8, timeout: 30 });
const id = await m5.nfc.eid.report({ mrz, format: "object", photo: true, all: true });
//   → { ok, status, message, format, result, title, summary, data,
//       images[{ name, mime, image }], files[{ name, mime, data }], history, photo, outputs }

m5.nfc.emv.format(r.data, "csv", { fullPan: false }); // a read you have, in another format
m5.nfc.emv.history(r.data);                           // its transactions as rows
m5.nfc.eid.format(id.data, "text");
m5.nfc.eid.images(id.data);                           // every picture: [{ name, mime, image }]
m5.nfc.format(anyRead, "json", { lang: "cs", title, images, attachments }); // any read, a scan too
m5.nfc.outputs(report);                               // a report's outputs for the chat
m5.nfc.document(anyRead, { lang, fullPan });          // a standalone HTML document (text)
```

- **`emv.report(opts)` / `eid.report(opts)`** read (with the options of
  `read`), format (`format`, `fullPan`, `lang`, `title`, `images`,
  `attachments`) and, with `send: true` (default `false` in the SDK), show the
  outputs to the caller during the run. They return `ok` (the read's status is
  `ok`), `status`, `message`, `format`, `result` (the formatted value), `title`,
  `summary`, `data` (the read as it came back), `images` (the pictures a browser
  shows, as bytes), `files` (base64), `history` (EMV rows, else `[]`), `photo`
  (`{ name, mime, image }` of the face or portrait, or `null`) and `outputs`
  (what `m5.nfc.outputs` gives; a failed read adds a warning flash first).
- **`m5.nfc.format(data, format, opts)`** (also `emv.format`, `eid.format`) →
  the report object `{ kind, format, value, mime, title, summary, images, files }`.
  `lang` defaults to the caller's language.
- **`emv.history(data)`** → `[{ application, date, time, amount, currency,
  merchant, type, country, atc, cid, raw, … }]`; **`eid.images(data)`** → every
  picture as `{ name, mime, image }` (bytes, JPEG 2000 included).
- **`m5.nfc.outputs(report)`** → `html`: one `m5.out.html`; `text`: text; `json`
  / `csv`: a code block and the same as a file (`emv.json`, `e-id.csv`…);
  `array`: a table (section, field, value); `object`: JSON. A non-`html` format
  adds the pictures as images; every format adds the files as files.
- **`m5.nfc.document(data, opts)`** → a standalone HTML document (with its
  styles) as text, for a file to download or keep.

Python: `await m5.nfc.emv.report(format="html", send=True, history=True,
deep=True, full_pan=False, max_apps=8, timeout=30)`, `await
m5.nfc.eid.report(mrz=…, format="object", photo=True, all=True)`,
`m5.nfc.format(data, "csv", full_pan=False, lang="cs")`, `m5.nfc.emv.history(data)`,
`m5.nfc.eid.images(data)`, `m5.nfc.outputs(report)`, `m5.nfc.document(data, lang="en")`
— the results are dicts with the same keys.

### Builder nodes and packages

The visual flow builder has an **NFC** node group (scan, read, write, M5Cet
read / build, emulate, enum) with result visualization, and three built-in
command packages: **`/nfc-scan`** (scan a card), **`/nfc-uid`** (its UID only)
and **`/nfc-open`** (open an M5Cet card). They ship **off** — a model needs a
device with NFC access — and an operator turns them on in Functions.

6.6 adds two palette groups and three nodes (`server/functions/flow.ts`):

| Group | Node | Inputs | Parameters | Outputs |
|-------|------|--------|------------|---------|
| **NFC.EMV** | **EMV: read everything** | — | Format (html), Show in the chat (on), Transaction history (on), Every file (deep read) (on), Whole card number (off), Applications at most (8), Reader (the device's default / internal / usb / bluetooth / serial), Wait for a card (30 s) | result, data, ok, status, summary, history, files, report |
| | **EMV → format** | data | Format, Whole card number | result, files, summary, report |
| | **EMV: transaction history** | data | — | rows, count |
| **NFC.e-ID** | **e-ID: read everything** | can, mrz, documentNumber, dateOfBirth, dateOfExpiry (YYMMDD) | Format (html), Show in the chat (on), Pictures (on), Every data group (on), Reader, Wait for a card (45 s) | result, data, ok, status, summary, holder (DG1), photo, images, files, report |
| | **e-ID → format** | data | Format | result, images, files, summary, report |
| | **e-ID: pictures** | data | — | images, first (the face), count |
| **NFC** | **Card → format** | data (any read) | Format, Whole card number | result, title, summary, images, files, report |
| | **Show card report** | report | — | — (shows the report's outputs) |
| **Output** | **Send HTML** | html | Title | — (`m5.out.html`) |

*Format* is one of `html`, `object`, `array`, `json`, `text`, `csv`. The two
*read everything* nodes compile to `m5.nfc.emv.report` / `m5.nfc.eid.report`,
the others to `format`, `history`, `images`, `outputs` and `m5.out.html` — in
JavaScript or Python. On the canvas a *read everything* node shows its format
and "→ chat" when it shows the report.

**Built-in packages (6.6)** — built as flows from these tools
(`script/gen-nfc-flows.ts` writes `flow.m5flow.json`, `index.js` and a README to
`server/functions/builtins/src/nfc-*`), version 1.0.0, visibility *caller*,
installed **switched off** like the others:

- **`/emv`** (`nfc-emv`) — *EMV: read everything* (html, shown in the chat,
  history and deep read on, 8 applications, 45 s) → Result (the one-line
  summary). The chat gets the report — the card number masked — with
  `emv-history.csv` and `emv-records.txt` to download.
- **`/emv-history`** (`nfc-emv-history`) — *EMV: read everything* (object,
  not shown) → If the read is ok → *EMV: transaction history* → Send table
  (date, time, amount, currency, merchant, type, country, ATC); otherwise a
  warning flash with the read's message.
- **`/eid`** (`nfc-eid`) — no server form: `execute` runs *e-ID: read
  everything* at once (html, shown in the chat, pictures and every data group
  on, 90 s) → Result, without a key, so the caller's device asks for the CAN,
  or the MRZ, or the document number, date of birth and date of expiry
  ([above](#the-e-id-key-is-asked-on-the-device-66)) and uses it for this read
  only.

Each has an `error` function that flashes what went wrong. The tests
(`test/nfc-builtins.test.ts`) check that each flow compiles to exactly the file
that runs.

### `/help nfc`, `/help html` and the tutorial (6.6)

`/help nfc` (also `emv`, `eid`, `card`, `cards`, `passport`) explains the three
commands, the Builder groups and the report formats with a JS / Python example;
`/help html` explains `m5.out.html`; the topic buttons under `/help` gain *NFC
cards*. The console's tutorial adds **17 · Formatted HTML**, **18 · NFC card
reports** (formats a fixed EMV read, no card needed) and **19 · Reading a card
(EMV, e-ID)** (`server/functions/tutorial.ts`). `/help` and the other general
built-ins are version 1.3.0; the NFC packages stay 1.0.0.

## Privacy and scope

Card reads and writes happen on the device. An M5Cet record's plaintext never
reaches the server; only the ciphertext rides a tag. A tag is exposed media —
anyone in proximity can read its bytes — so the PIN or the account key is the
real boundary, not the air gap. The tool does no key recovery and no payment-card
cloning. EMV is read-only — the holder's own card, what a terminal reads (the
transaction log included), never a PIN, cryptogram or transaction; an e-ID /
e-passport is opened only with the key the holder supplies (the document's own
access control) and read, never written. DG3 / DG4 (fingerprints, iris) are
never read.

What 6.6 adds to think about:

- **A workbench read stays in the browser.** The report and its exports are
  made on the device; nothing is uploaded.
- **A model's read passes the server.** For `/emv`, `/eid` or any model, the
  device sends the read to the server, which bounds it (above) and hands it to
  the sandbox; the model's outputs — the report with the face picture, the
  personal data, the files — are run outputs. Runs are kept in
  `$DATA_DIR/functions/functions.db` with their inputs and outputs until
  `FUNCTIONS_RUNS_DAYS` (30 days by default), and an operator with access to
  *Functions › Runs* can open them. The e-ID key the device asked for is not
  among them — it stays on the device ([above](#the-e-id-key-is-asked-on-the-device-66));
  a CAN or MRZ a model passes itself comes from its own inputs, which are kept.
  The built-in commands' visibility is *caller*: the report is shown only to the
  person who ran it, not posted to the room.
- **Masking is for the report.** `fullPan` is off by default; the read itself
  (`data`) carries the PAN.
- **The e-ID check is partial.** Passive authentication here is the hash check
  only — no EF.SOD signature, no CSCA list, no Active / Chip Authentication.
