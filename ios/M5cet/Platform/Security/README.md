# Platform/Security — klíče, trezor, zámek aplikace

Port částí `A/security/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`), které potřebují systém;
čistá kryptografie (`Crypto`, `Ec`, `Ecies`, `SignedPolicy`, formát `FileVault`, sloty trezoru) je v `M5Kit/M5Crypto`.

| Android | iOS |
|---|---|
| `Keystore`, `Vault` (systémový klíč, datový klíč, sloty) | Keychain (`kSecAttrAccessControl`, `…ThisDeviceOnly`), **Secure Enclave** P-256 (`kSecAttrTokenIDSecureEnclave`) místo StrongBox/TEE |
| `AppLock`, `LockStore`, `LockCounter`, `PinWrap`, `ServerPin`, `Duress` | PIN přes HMAC klíčem Secure Enclave, čítač pokusů v Keychainu s generací, nouzový PIN stejně; zamknutí podle `AppModel.onScenePhase` |
| `Biometric` | LocalAuthentication (`LAContext`, `.biometryCurrentSet` / `.userPresence`), text `NSFaceIDUsageDescription` |
| `LockBox`, `Wiper` | smazání Keychainu, App Group kontejneru a souborů (Data Protection `complete`) |
| `IntentSeal` | není potřeba (žádné exportované intenty) — odkazy jen přes `DeepLink` |
| `FLAG_SECURE` (MainActivity) | štít v přepínači aplikací, `UIScreen.isCaptured` při nahrávání, upozornění na snímek obrazovky |

Sdílení s rozšířením notifikací: App Group `$(M5_APP_GROUP)` (`Info.plist` klíč `M5AppGroup`) a skupina Keychainu
`$(AppIdentifierPrefix)cz.m5cet.app` (`Resources/M5cet.entitlements`, `M5cetNotifications/*.entitlements`).
Instalace při startu: `App/Bootstrap.swift`.
