# Platform/NFC — Core NFC: transport, čtení, zápis, emulace (6.14)

Port platformní poloviny `A/nfc/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`): všechno, co na Androidu
sahá na `android.nfc.*` (`NfcAdapter` reader mode, `Tag`, `IsoDep`, `NfcA`, `MifareUltralight`, `Ndef`, `NfcV`,
`NfcF`, `HostApduService`). Logika nezávislá na rádiu (šablony APDU, běh šablon, EMV, e-ID BAC/PACE, TLV, zprávy
o kartě, Připojka v2, M5Cet karta, maskování PAN, `ModelNfc`) je v `M5Kit/M5NFC` — tady je jen Core NFC pod ní a
fasáda `NfcService`, kterou zavolají obrazovky (NfcWorkbench, NfcCardBuilder, NfcModelSheet, NfcPanel, ConnTagUi —
staví je pozdější agent „NFC UI“). Nic se zatím neregistruje v UI ani v `App/Bootstrap`. Testy: `M5cetTests/NFC`.

**Jen iPhone.** iPad, Apple Watch a simulátor NFC nemají (`NFCTagReaderSession.readingAvailable == false`): služba
pak hlásí `capabilities == .none` a každé čtení skončí důvodem „This device has no NFC reader…“ dřív, než se
cokoli otevře. Na skutečné kartě nebylo nic z toho ověřeno (simulátor rádio nemá) — testy jedou proti
simulovaným čipům (viz níže).

| Android | iOS (`Platform/NFC`) |
|---|---|
| `InternalReader`, `ReaderMode` (reader mode, jeden vlastník, nejnovější vyhrává) | `NfcService.reading(…)`: jedno čtení = jeden systémový list (`NFCTagReaderSession`); nové čtení zruší předchozí |
| `NfcAdapter.FLAG_READER_NFC_A/B/F/V` | `NfcSessionRequest.Polling` → `.iso14443` / `.iso15693` / `.iso18092` (+ `.pace` jen s formátem `PACE`) |
| `Tag` + `IsoDep.transceive` / `MifareUltralight.transceive` / `Ndef` / `NfcV` / `NfcF` | `CoreNFCTag` (adaptér `NFCTag`: `sendCommand`, `sendMiFareISO7816Command`, `sendMiFareCommand`, `NFCNDEFTag`, ISO 15693, FeliCa) |
| `ModelNfcDevice.TagCard` (karta pro `ModelNfc`) | `CoreNFCTransport` (M5NFC `CardTransport`) → `TransportCard` |
| `TagTech.detect` (tech list, SAK/ATQA/ATS, GET_VERSION NTAG) | `NfcTagSession.identified` → `TagTech.map(ios:ntag:)`, `CardIdentity` (UID, historické bajty, vybraný AID, paměť) |
| `TagLostException` → „card gone“ | `NfcErrorMap` (kódy `NFCReaderError` → `NfcError`: ztráta karty → `cardGone`, zavřený list → `cancelled`…) |
| `CardOps.ndefRead / ndefWriteAny / ndefLock` | `NfcService.readTag / writeTag / lockTag`, `CoreNFCTransport.writeMessage` (NDEF tag, nebo prázdný Ultralight/NTAG stránku po stránce) |
| `CardOps.ultralightRead/Write, desfireApps, isoTransceive, nfcvRead/Write, felicaSystems, emvPublic, eidPublic` | `NfcService.perform(_:tech:input:)` (stejná id operací jako `NfcCatalog`) |
| `CardOps.eidRead`, `MrtdReader` přes `IsoDep` | `NfcService.readMrtd(can:|mrz:|_:)` (+ `selectMasterFileForCardAccess`, protože Core NFC už vybral AID) |
| `CardOps.emvRead` | `NfcService.readEmv` — na iPhonu **odmítnuto** důvodem M5NFC (Core NFC nepustí platební AID) |
| `TemplateRunner` nad `IsoDep` (NfcWorkbench `app-template`) | `NfcService.runTemplate(…)` / `readCard(template:)` (kroky na listu) |
| `Nfc` (Připojka: čtení, PIN/kód, zápis v2, emulace) | `readConnTag`, `openConnBody`, `prepareConnTag`, `writeConnTag`, `emulateConnection` |
| `ConnTag` + `ShareInvite` (HTTP) + `TagV2` (Argon2id) | M5NFC `NfcConnTag` / `NfcShareInvite` / `NfcTagV2` (krypto M5Crypto) s `Argon2TagKdf` (M5NFC nad Argon2 z M5Crypto) a adaptérem `M5ShareInviteHTTP` (M5Net) |
| `NfcModelSheet.start` + `ModelNfcDevice.snapshot` | `NfcService.modelPlan` / `modelDevice` / `modelRead` |
| `CardService` (HCE, AID `D2760000850101`) | `NfcCardEmulation` + `HceRunner` (Core NFC `CardSession`) s M5NFC `Type4TagEmulator` — **jen s entitlementem HCE** |
| `MifareClassic`, `NfcA` raw (Gen1a UID), `Readers`/`UsbReader`/`BleReader` | není (Core NFC nemá MIFARE Classic ani raw rámce; externí čtečky zatím ne) — důvod z `NfcPlatform.limit` |

## Návrh

```
 obrazovky / modely (@MainActor)            Platform/NFC                                       systém
 ─────────────────────────────      ──────────────────────────────────────────────    ─────────────────────
 NfcService.readMrtd(…)      ──▶    reading(polling, aids, texty)                     
                                     │ limit (NfcPlatform) → hned důvod, bez listu
                                     ▼
                                    NfcTagSession (actor, executor = fronta relace) ◀─▶ CoreNFCSessionDriver
                                     │ waitForCard: list, „víc karet“ / „tahle ne“        NFCTagReaderSession
                                     │   → restartPolling, connect, identita              (delegát na frontě)
                                     ▼
 M5NFC MrtdReader / EmvReader ──▶   CoreNFCTransport (Sendable) ──▶ NfcTagSession.transmit ──▶ CoreNFCTag
 TemplateRunner / ModelNfc           data ‖ SW1 SW2 beze změny (61xx/6Cxx řeší M5NFC)          NFCISO7816Tag …
                                    succeed(„Hotovo“) / fail(chybový text) → invalidate
```

* **Souběžnost (Swift 6).** Objekty Core NFC nejsou `Sendable` a volají zpět na frontu, kterou dostaly. Actor
  `NfcTagSession` má jako executor právě tu `DispatchSerialQueue` relace: delegát (`CoreNFCSessionDriver`) do něj
  vstupuje synchronně přes `assumeIsolated`, všechny `NFCTag` zůstávají v něm a ven jdou jen hodnoty `Sendable`
  (bajty, `CardIdentity`, `NdefRecord`). Čtečky M5NFC (výpočet PACE, BAC…) běží mimo frontu v kooperativním poolu a
  na kartu sahají přes `CoreNFCTransport`. Každý příkaz čeká v `PendingCalls`: když relace skončí (zavřený list,
  60 s limit iOS, karta pryč, zrušený úkol), všechny čekající příkazy dostanou chybu — nic nevisí.
* **Švy pro testy.** `NfcTagHandle` (tag), `NfcSessionDriver` (list) a `NfcSessionEvents` (zpětná volání) jsou bez
  CoreNFC; testy je nahrazují falešnými (`M5cetTests/NFC/NfcFakes.swift`).
* **Schopnosti karty** = `NfcCapabilities.coreNFCiPhone` ∩ co umí ten tag: Ultralight bere příkazy MIFARE, ne APDU;
  ISO 7816 karta APDU (+ `.autoSelectsAid`), ne MIFARE. Proto `ModelNfc` řekne „not an ISO-DEP card“ stejně jako
  Android. `.mifareClassic`, `.rawFrames`, `.paymentAids` nejsou nikdy; `.emulation` jen se schváleným HCE.
* **SELECT podle jména** jen na AID z `Info.plist` (Core NFC jinak vrátí *security violation*): `CoreNFCRules.selectRefusal`
  takový příkaz zastaví dřív, než jde na kartu, a řekne, který AID chybí. Od iOS 26.4 si každé čtení zúží AID pro
  objevení karty (`NFCTagReaderSession.Configuration`): e-ID jen `A0000002471001`, tagy jen NDEF aplikaci.
* **Rámování APDU** (`ApduFrame`): případy 1–4 v krátké i rozšířené podobě → pole `NFCISO7816APDU` (Lc 1…65 535,
  Le 1…65 536 / žádné). Zda karta rozšířené APDU přijme, je na kartě.

## Texty listu

Systémový list (`alertMessage`, text chyby při `invalidate`) mluví slovy designu: `NfcSheetTexts` bere
`NfcTextProvider` — ve výchozím stavu řetězec M5NFC `NfcTexts` (aplikace ho plní řetězci designu přes
`NfcTexts.install`), obrazovky mohou předat vlastní. Klíče jsou z výchozího designu s jeho angličtinou:

| Situace | Klíč (záložní) |
|---|---|
| čekání na kartu | `nfc.ios.hold` → `nfc.model.hold` |
| čekání na tag k zápisu | `nfc.ios.holdWrite` → `nfc.work.holdCard` |
| šablona | `nfc.tpl.hold`; krok `nfc.ios.step` („{0}/{1} · {2}“) |
| čte se | `nfc.model.reading` |
| hotovo / zapsáno / zamčeno | `nfc.model.done`, `nfc.done.writtenBytes`, `nfc.done.locked` |
| víc karet najednou (list hledá znovu) | `nfc.ios.multipleTags` → `nfc.model.hold` |
| tahle karta to neumí (list hledá znovu) | `nfc.model.notThisCard` |
| karta odešla / chyba / doklad se neotevřel / žádná karta do N s | `nfc.model.lost`, `nfc.model.error`, `nfc.model.authFailed`, `nfc.model.timeout` |
| jen pro čtení / malý / nezapisovatelný | `nfc.err.readOnly`, `nfc.err.tooSmall`, `nfc.err.notWritable` |
| emulace | `nfc.emulating` |

`nfc.ios.*` ve výchozím designu nejsou (chybí-li, použije se nejbližší klíč designu) — doplnit je do
`default-design.json` je věc designu, ne této složky.

## API `NfcService` (`@MainActor`, `NfcService.shared`)

```swift
// co zařízení umí
let readingAvailable: Bool                          // iPhone s NFC
var capabilities: NfcCapabilities                   // .coreNFCiPhone (+ .emulation s HCE), iPad/simulátor .none
private(set) var busy: Bool                         // list je nahoře
func limit(op: String, tech: String = "") -> String?          // důvod M5NFC, proč ne (nil = jde)
func ops(for tech: String) -> [NfcCatalog.Op]
var technologies: [String]
func refreshEmulation() async -> HceAvailability    // CardSession.isEligible je async
func cancel()                                       // zavře probíhající list (volání hodí NfcError .cancelled)

// tagy (NDEF)
func readTag(texts: NfcSheetTexts = .init(), timeout: Duration? = nil) async throws -> NfcTagRead
func writeTag(_ records: [NdefRecord], texts:) async throws -> Int            // bajty zprávy; NfcWriteFailure
func lockTag(confirmPermanentLock: Bool, texts:) async throws                // bez `true` se nic neotevře
func writeM5Card(_ container: [UInt8], texts:) async throws -> Int

// Připojka (connection tag)
func readConnTag(secret: String = "", trustedOrigin: String?, redeem: Bool = true, texts:) async throws -> NfcConnRead
func openConnBody(_ body: String?, secret: String, trustedOrigin: String?, redeem: Bool = true) async -> NfcConnTag.Read
func prepareConnTag(_ card: NfcJSONObject, kind: String /* "inv" | "off" */, origin: String, appVersion: String) async throws -> NfcConnTag.Prepared
func writeConnTag(_ body: String, texts:) async throws -> Int

// karty ISO 7816
func readMrtd(can: String, readPhoto: Bool = true, all: Bool = true, texts:) async throws -> NfcJSONObject
func readMrtd(mrz: String, readPhoto: Bool = true, all: Bool = true, texts:) async throws -> NfcJSONObject
func readMrtd(_ options: MrtdReader.Options, texts:, timeout: Duration? = nil) async throws -> NfcJSONObject // {status, mrtd, message, card}
func readEmv(_ options: EmvReader.Options = .init(), texts:) async throws -> NfcJSONObject                  // iPhone: hodí důvod
func runTemplate(_ t: ApduTemplates.Template, mrtd: MrtdReader.Options? = nil, texts:,
                 onStep: TemplateRunner.StepListener? = nil, onExchange: TemplateRunner.ExchangeListener? = nil) async throws -> TemplateRunResult
func readCard(template: ApduTemplates.Template, mrtd: MrtdReader.Options? = nil, texts:) async throws -> TemplateRunResult

// operace pracovní plochy (NfcWorkbench.runOp): scan, read-uid, read-public, ndef-read, ndef-write, m5-write,
// conn-write, ndef-lock (.confirmLock(true)), ul-/ntag-read, ul-/ntag-write, desfire-apps, raw-apdu, select-aid,
// v-read, v-write, felica-systems, emv-public, eid-public, eid-read, app-template, m5-read, conn-read
func perform(_ op: String, tech: String = "", input: NfcOpInput = .none, texts:) async throws -> NfcOpResult

// model (Functions) — viz NfcService+Model.swift
func modelDevice(preferredReader: String = "") -> ModelNfc.Device
func modelPlan(_ spec: NfcJSONObject?, preferredReader: String = "") -> ModelNfcPlan   // .answer / .askDocumentKey / .read
func modelRead(_ command: ModelNfc.Command, texts:) async -> NfcJSONObject             // nikdy nehází

// emulace (HCE)
func emulateConnection(_ body: String, texts:) async throws -> HceEnd
func emulateM5Card(_ container: [UInt8], texts:) async throws -> HceEnd
func stopEmulation()
```

Chyby: `NfcError` z M5NFC (`cancelled`, `cardGone`, `unsupported` s důvodem, `io`, `invalidArgument`…) a
`NfcWriteFailure` (`readOnly` / `tooSmall(needed, available)` / `notWritable`, text `text(_:)` ze slov designu).

**Model** (`modelPlan` → `modelRead`): zápis a emulace → „denied“, neznámá operace → „unsupported“, `enum` →
čtečky a technologie tohoto iPhonu, EMV → hned „unsupported“ s důvodem platebních AID, e-ID bez CAN/MRZ →
`.askDocumentKey` (list se zeptá držitele; nikdy nejde modelu), jinak list počká na kartu (timeout příkazu, nejvýš
60 s iOS) a `ModelNfc.run` ji přečte. Výsledek s daty karty smí odejít jen se souhlasem držitele
(`ModelNfc.consent` / `masked` / `declined`) — to je věc `NfcModelSheet` (UI).

## Emulace karty (HCE)

`CardService` → Core NFC `CardSession` (iOS 17.4+, pro aplikace v EHP od 18.1) s M5NFC `Type4TagEmulator`
(SELECT NDEF aplikace, CC `E103`, soubor `E104`, READ BINARY; nic není zapisovatelné). Brána v pořadí:
aplikace je sestavená s HCE (v `Info.plist` je AID — viz níže) → `CardSession.isSupported` → `await
CardSession.isEligible` → iPhone. Bez toho se `CardSession` vůbec nedotkne: `capabilities` nemá `.emulation`,
operace `m5-emulate` / `conn-emulate` nejsou v nabídce a volání hodí důvod M5NFC („Card emulation needs the HCE
entitlement…“). Sezení emulace drží `NFCPresentmentIntentAssertion` a končí, když čtečka přečte celý soubor
NDEF (`HceResponder.served`), `stopEmulation()`, nebo když ho ukončí iOS.

## Omezení iOS (poctivě, nic se nepředstírá)

* **MIFARE Classic** (sektory, výpis, MAD, zápis NDEF na Classic), **raw rámce ISO 14443-3** (zápis UID „magic“ karet)
  — Core NFC je nemá. **EMV** (PPSE a platební AID) — Core NFC je aplikacím nepustí; kód EMV je kompletní a běží nad
  tímto transportem, kdyby čtečka `.paymentAids` měla (iOS 26 má `NFCPaymentTagReaderSession`, ale jen se zvláštním
  oprávněním Apple — není zapojeno).
* **ISO 7816 karta se ukáže jen tehdy**, když odpoví na SELECT některého AID z `Info.plist`; obecná ISO-DEP karta bez
  takové aplikace se aplikaci vůbec nepředá (DESFire / Plus přijdou jako `NFCMiFareTag`).
* **e-ID jen s PACE** (bez aplikace eMRTD) potřebuje polling `.pace` = formát `PACE` v entitlementu — vypnuto
  (`NfcService.Configuration.pacePolling`, klíč `M5NfcPacePolling` v `Info.plist`).
* **Relace trvá nejvýš 60 s** (iOS) včetně čtení; příkaz modelu s delším timeoutem čeká nejvýš 60 s. Hluboké čtení
  e-ID s fotografií se do toho vejde, ale karta musí ležet klidně.
* Jedna relace NFC v systému najednou; nové čtení zruší předchozí. Bez zvuku/vibrací Androidu — list je systémový.
* Formátování prázdného tagu: jen Type 2 (Ultralight / NTAG) přes stránky (CC + TLV); jiné prázdné tagy Core NFC
  nenaformátuje („not-writable“).
* Externí čtečky (USB CCID, Bluetooth PN532) zatím ne; `ModelNfc.Device.usb` je prázdné.
* `lockTag` je nevratný — bez `confirmPermanentLock: true` se nic nestane. (Android ho v pracovní ploše spouští
  rovnou po klepnutí na operaci „Make read-only (permanent)“; iOS chce výslovné ano.)

## Co doplní koordinátor (Info.plist, entitlementy)

* **Pořadí AID v `Info.plist`**: dnes začíná PPSE; M5NFC (`IOSAids.infoPlist`) chce doklady první
  (`A0000002471001`, `D2760000850101`, `D2760000850100`, pak platební). Před iOS 26.4 Core NFC zkouší AID v pořadí
  plistu. Test `NfcInfoPlistTests.testDocumentsFirst` to hlídá jako očekávané selhání.
* **HCE** (až Apple schválí): entitlement `com.apple.developer.nfc.hce` = `true` (případně podle schválení i
  `com.apple.developer.nfc.hce.default-contactless-app`) a v `Info.plist`
  `com.apple.developer.nfc.hce.iso7816.select-identifier-prefixes` = `["D2760000850101"]`. Obojí najednou —
  `CoreNFCHceProbe` podle klíče v plistu pozná, že build HCE má.
* **PACE** (volitelně): `PACE` do `com.apple.developer.nfc.readersession.formats` a `M5NfcPacePolling = true` v plistu.
* Nic jiného nechybí: `TAG` + `NDEF`, `NFCReaderUsageDescription`, FeliCa `12FC` / `88B4` / `FE00` / `0003` jsou tam.

## Testy (`M5cetTests/NFC`, simulátor)

Falešné Core NFC (`FakeTag`, `FakeDriver` — `invalidate()` odpovídá „user canceled“ jako Core NFC) a simulované čipy
z testů M5NFC (EMV, DESFire, ISO 7816 s 61xx / 6Cxx, BAC e-pas podle ICAO 9303-11): rámování APDU, mapování chyb
proti kódům SDK, texty listu, list (víc karet, jiná karta, zavření, timeout, konec relace iOS, ztráta karty,
zrušený úkol, stará spojení), NDEF (čtení, zápis, NTAG po stránkách, jen pro čtení, malý tag, zámek jen s ano),
e-ID přes BAC (s výběrem MF pro EF.CardAccess), šablony (ISO 7816, DESFire, e-ID), operace pracovní plochy,
EMV / Classic / raw odmítnuté před listem, model (plán, sken, timeout, zavření, ztráta, e-ID s maskováním),
Argon2id (vektor bajt po bajtu, offline tag s kódem), pozvánka přes M5Net (vytvořená a uplatněná proti falešnému
serveru), brána HCE a odpovědi Type 4 tagu, `Info.plist` a entitlementy.
