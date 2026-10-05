# M5NFC — NFC / smart-card logic for iOS, iPadOS, watchOS

The NFC part of the Android app (`android/app/src/main/java/cz/m5cet/app/nfc/*`) and of the web client
(`client/src/lib/nfc/**`) ported to Swift for release 6.14 — everything that does not touch the radio.
Pure Foundation / CryptoKit / CommonCrypto (no UIKit, no CoreNFC), so it builds for iOS, iPadOS,
watchOS and macOS; `swift test --package-path ios/M5Kit` runs it against the same vectors and simulated
cards as the JVM tests. The CoreNFC transport and the UI are the app's (`M5cet/Platform/NFC`, wave 2).

## The seam: what the CoreNFC transport implements

```swift
public protocol ApduChannel: AnyObject {                 // every reader talks through this
    func transmit(_ apdu: [UInt8]) async throws -> [UInt8] // data ‖ SW1 SW2
}
public protocol CardTransport: ApduChannel, Sendable {   // one per detected tag
    var capabilities: NfcCapabilities { get }
    func identify() async throws -> CardIdentity
    func mifareCommand(_ frame: [UInt8]) async throws -> [UInt8]   // default: unsupported
    func rawFrame(_ frame: [UInt8]) async throws -> [UInt8]        // default: unsupported (never on iOS)
    func readNdef() async throws -> [NdefRecord]?                   // default: nil
    func writeNdef(_ records: [NdefRecord]) async throws            // default: unsupported
}
```

The app's transport, per NFCTag:

| CoreNFC tag | `transmit` | other paths | capabilities |
|---|---|---|---|
| `NFCISO7816Tag` | `sendCommand(apdu:)` → `data + [sw1, sw2]` | `readNDEF` / `writeNDEF` / `writeLock` | `.coreNFCiPhone` |
| `NFCMiFareTag` (`.desfire`) | `sendMiFareISO7816Command` | — | `.coreNFCiPhone` |
| `NFCMiFareTag` (`.ultralight`) | — | `mifareCommand` → `sendMiFareCommand` (READ 30, GET_VERSION 60; the OS adds the CRC) | `.coreNFCiPhone` |
| `NFCISO15693Tag`, `NFCFeliCaTag` | — | NDEF; blocks through the app | `.coreNFCiPhone` |

* Throw `NfcError.cardGone(…)` when the session reports the tag lost (a model's read then answers `no-card`).
* Map the tag with `TagTech.map(ios:)` (`IOSTag.iso7816(initialSelectedAid:…)`, `.miFare(family:…)`, …) and
  build `CardIdentity(uid:tech:…)`; `TransportCard(transport, identity:)` is the `ModelNfcCard` a model's read runs on.
* The session runs the readers off the main actor (they are `async`, CPU work like PACE on P-521 included);
  call `TemplateRunner.cancel()` or cancel the task to stop before the next command.
* Polling: `.iso14443` (+ `.pace` for PACE-only ID cards, entitlement format `PACE`), `.iso15693`, `.iso18092`.
* A CoreNFC session has already selected one of the listed AIDs: pass `.autoSelectsAid` and the e-ID read
  selects the master file before EF.CardAccess (`MrtdReader.Options.selectMasterFileForCardAccess`).

## What iOS cannot do — flagged, not faked

`NfcCapabilities` says what a transport has; `NfcPlatform.limit(op:tech:capabilities:)` gives the reason the
UI shows, `NfcPlatform.ops(for:capabilities:)` / `technologies(capabilities:)` / `templateRuns` filter.

| Capability | iPhone (Core NFC) | iPad / Apple Watch | Android |
|---|---|---|---|
| ISO 7816 APDUs (listed AIDs only), NDEF read / write / lock, Ultralight / NTAG commands, DESFire (ISO-wrapped), ISO 15693, FeliCa | yes | — (no NFC) | yes |
| `.mifareClassic` — MIFARE Classic sectors, dumps, MAD | **no** (Core NFC has no Classic) | — | yes |
| `.rawFrames` — ISO 14443-3 frames (the Gen1a "magic" UID write) | **no** | — | yes |
| `.paymentAids` — EMV payment applications (PPSE, the schemes' AIDs) | **no** — Apple: *"Core NFC doesn't support payment-related Application IDs"* | — | yes |
| `.emulation` — the phone as a Type 4 tag (`Type4TagEmulator`) | only with the HCE entitlement (`CardSession`, EEA, iOS 18.1+): the app sets the flag after its availability check | — | yes |

A model's `emv-read` on the iPhone's own reader is answered at once with the reason (`ModelNfc.route`); EMV
templates are listed but not offered to run (`NfcPlatform.templateRuns`). The EMV code itself is complete and
runs over any transport that has `.paymentAids` (an external reader).

## Info.plist: `com.apple.developer.nfc.readersession.iso7816.select-identifiers`

Core NFC refuses SELECT of an AID that is not listed. `IOSAids.infoPlist` (and `IOSAids.json`) is the list; the
tests check that every AID the readers and the standard templates select is in it and that this block equals it.
Documents first (Core NFC tries them in order); the payment AIDs are listed for completeness — see above.

<!-- aids:begin -->
```json
[
  "A0000002471001",
  "D2760000850101",
  "D2760000850100",
  "325041592E5359532E4444463031",
  "315041592E5359532E4444463031",
  "A0000000031010",
  "A0000000032010",
  "A0000000032020",
  "A0000000033010",
  "A0000000038010",
  "A0000000041010",
  "A0000000043060",
  "A000000004306001",
  "A0000000046000",
  "A00000002501",
  "A0000000651010",
  "A0000001523010",
  "A0000003241010",
  "A000000333010101",
  "A000000333010102",
  "A0000002771010",
  "A0000006581010",
  "A0000005241010",
  "A0000000421010",
  "A0000003591010028001"
]
```
<!-- aids:end -->

## The API (Android class → Swift type)

| Android (`A/nfc/…`) / web | Swift | What |
|---|---|---|
| `Apdu` (Transceiver, transmitSmart, BER-TLV) | `Apdu`, `Tlv`, `BerTlv`, `ApduChannel` | APDUs, 61xx / 6Cxx, TLV (depth-bounded); the byte helpers are M5Core's (`Hex.upper` = `Apdu.hex`, `Hex.decodeLenient` = `Apdu.unhex`, `Bytes.u8` / `slice` / `concat`) |
| `StatusWords` | `StatusWords` | describe("6A82") — the web's words |
| `Des`, `Aes`, `AesSm`, `Bac`, `SmChannel` | `Des`, `Aes`, `AesSm`, `Bac`, `BacChannel`, `SecureMessagingChannel` | 3DES-CBC, retail MAC, AES-CBC, AES-CMAC, BAC + 3DES / AES secure messaging |
| `EcCurve`, `Pace`, `PaceProtocol` | `BigUInt`, `EcCurve`, `Pace`, `PaceSession`, `PaceError` | PACE generic mapping on the six standard curves, CAN or MRZ |
| `Asn1`, `MrtdReader` | `Asn1`, `MrtdReader` | e-ID / e-passport: EF.COM, EF.SOD (passive auth), DG1 MRZ, DG2 / DG5 / DG7 / DG11 / DG12 pictures as JPEG / JPEG 2000 / PNG bytes, DG11–16 |
| `EmvTags`, `EmvReader` | `EmvTags`, `EmvReader` | PPSE / PSE, AIDs, GPO, AFL, GET DATA counters, the transaction log, every SFI |
| `ApduTemplates`, `TemplateRunner` | `ApduTemplates`, `TemplateRunner`, `TemplateRunResult` | m5mobile.define.apduTemplates, `more` frames, the read-only allowlist (G-18) |
| `TemplateViews` | `TemplateViews` | io / raw / json / readable, masked (G-19) unless `full` |
| pan-mask.ts | `PanMask` | the PAN in BCD, ASCII hex, Track 1 / 2, text |
| card-report.ts | `CardReport` | html / object / array / json / text / csv, en / cs / de (sk → cs) |
| `ModelNfc` (+ consent.ts, document-key.ts) | `ModelNfc`, `ModelNfcCard`, `TransportCard` | a model's command: refusals, route, enum, document key, run, consent (masked by default), masked / declined |
| `CardOps` (pure parts) | `CardOps`, `Desfire`, `MifareClassicLayout`, `Ndef` | public EMV / e-ID, DESFire info, Ultralight pages, NDEF codec, T2T / T4T layouts |
| `NfcCatalog`, `TagTech` | `NfcCatalog`, `TagTech`, `NfcPlatform`, `NfcCapabilities` | the op catalogue, detection (Android + Core NFC), the iOS limits |
| `M5Card`, `Records` | `M5Card`, `M5Records` | the M5Cet card container (PIN / account keys) |
| `TagV2`, `ConnTag`, `ShareInvite`, `Nfc` (v1) | `NfcTagV2`, `NfcConnTag`, `NfcShareInvite`, `ConnectionCard` | connection tag v2 (invite / offline), v1 read (weak): the records, the `TagKdf` / `ShareInviteHTTP` seams and the writer here — the format and its crypto are M5Crypto's `TagV2`, `ShareInvite`, `ConnTag`, `ConnTagV1` (one implementation; `NfcTagV2.Tag` / `Room` / `TagError` are its types) |
| `CardService` | `Type4TagEmulator` | the Type 4 tag APDU logic for HCE |
| `cz.m5cet.app.core.Texts` | `NfcTexts.install(_:plural:)` | the app's design strings for the readers' own texts |

### What the app wires

* **`TagKdf`** — Argon2id for offline connection tags: `Argon2TagKdf()` is M5Crypto's (CArgon2).
  The tests use the vectors' precomputed keys, and `Argon2TagKdf` on the cheap (64 KiB) vector.
* **`ShareInviteHTTP`** — the two POSTs of an invitation tag (`/api/share/create`, `/api/share/redeem`), M5Net.
* **`NfcTexts.install`** — the design strings (`nfc.eid.*`, `nfc.emv.sum.*`, `nfc.tpl.*`, `nfc.m5.*`).
* **`TemplateViews` labels** — a `(key) -> String?` lookup into the design strings.

### Read-only and masking rules (never weaken)

* A template's fixed command must be a read (`ApduTemplates.readCommand`): SELECT, READ BINARY / RECORD,
  GET DATA, GPO, GET RESPONSE, DESFire GetVersion / GetApplicationIDs / GetFreeMemory / GetKeySettings. The
  runner checks every APDU again before it goes; the e-ID secure channel only inside `eid-read`.
* Every view masks the PAN and track data unless the user asks (`full: true`); a model's result leaves only
  with the holder's consent, masked by default (`ModelNfc.consent` / `masked` / `declined`).
