# Platform/NFC — Core NFC transport a čtečky

Port transportní části `A/nfc/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`). Logika nezávislá na
transportu (šablony APDU, běh šablon, EMV, e-ID BAC/PACE, TLV, zprávy o kartě, Připojka v2, maskování PAN —
`ApduTemplates`, `TemplateRunner`, `EmvReader`, `MrtdReader`, `Pace`, `Bac`, `SmChannel`, `Records`, `TagV2`, …)
je v `M5Kit/M5NFC`.

| Android | iOS |
|---|---|
| `Nfc`, `ReaderMode`, `InternalReader`, `TagTech` | `NFCTagReaderSession` (ISO 14443, ISO 15693, FeliCa), `NFCNDEFReaderSession` — **jen iPhone** (iPad a hodinky NFC nemají) |
| `CardOps` (IsoDep, MIFARE Ultralight / DESFire, NfcV, FeliCa) | `NFCISO7816Tag`, `NFCMiFareTag` (Ultralight, DESFire), `NFCISO15693Tag`, `NFCFeliCaTag`; **MIFARE Classic ne** |
| `Readers`, `BleReader` (PN532 přes Bluetooth) | CoreBluetooth (`NSBluetoothAlwaysUsageDescription`) |
| `UsbReader`, `Ccid` (USB CCID) | zatím ne (ověřit CryptoTokenKit na iPadOS) |
| `CardService` (HCE, AID `D2760000850101`) | jen s entitlementem HCE (`CardSession`, EHP / EU) za kontrolou dostupnosti; jinak skryto (§ 5) |
| `ShareInvite`, `ConnTag`, `M5Card` | NDEF zápis / čtení přes Core NFC |

Core NFC smí poslat SELECT jen na AID z `Info.plist`
(`com.apple.developer.nfc.readersession.iso7816.select-identifiers`, pořadí = pořadí zkoušení při přiložení karty):
PPSE, ICAO eMRTD `A0000002471001`, NDEF `D2760000850101/00`, PSE a platební AID (Visa, Mastercard, Maestro, Amex,
JCB, Discover, UnionPay, Interac, Mir, RuPay, CB, girocard). Nový AID v šabloně = doplnit ho tam.
FeliCa systémové kódy: `com.apple.developer.nfc.readersession.felica.systemcodes`. Entitlement `TAG` + `NDEF`
(`Resources/M5cet.entitlements`); polling `.pace` by potřeboval formát `PACE`.
