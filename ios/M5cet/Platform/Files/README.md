# Platform/Files — soubory zpráv, médií a sdílení

Port systémové části `A/ui/media/VaultMedia`, `A/security/FileVault` (úložiště) a souborových částí `A/chat/Files`
(`A/` = `android/app/src/main/java/cz/m5cet/app/`); přenos je v `M5Kit/M5Proto`, přehrávače a náhledy
(`AudioBar`, `Previews`, `VideoBox`) v `Parts`.

## Hotovo (6.14, Platform/Security)

* **`ProtectedFiles.swift`** — kde aplikace drží šifrované soubory (`SecurityPaths`: kontejner aplikace
  `Application Support/m5` pro USER vrstvu, schránku a soubory; App Group `…/m5` jen pro SYS vrstvu), třídy Data
  Protection, vyloučení ze záloh (`isExcludedFromBackup`), trvalý zápis (`F_FULLFSYNC` souboru, přejmenování, sync
  adresáře — Android `Vault.writeDurable`) a mazání stromu s výjimkou (wipe).
* **`FileVault.swift`** — soubory v klidu nad `M5Proto.FileVaultFormat` (formát a kryptografie — Androidu bajt po
  bajtu: `"M5F1"` | nonce (8) | segmenty po 64 KiB AES-256-GCM, IV = nonce ‖ index (u32 BE), AAD
  `m5file|<id>|<index>|<last 1/0>`); tady je úložiště: `Writer` (dočasný `.part`, přejmenování po dokončení; vlastní
  kopie datového klíče — zámek mezitím soubor nepřeruší), `Reader` s náhodným přístupem přes `FileHandle`
  (přehrávače, znovuodeslání), `readAll`,
  `decryptedCopy` / `discard` pro share sheet (dočasná kopie s `NSFileProtectionComplete`, smazat po použití).
  Soubory `files/<id>.m5f` (`:` → `_`), `complete`, mimo zálohy. Testy `M5cetTests/Security/FileVaultTests`.

## Zbývá (vlna 2)

| Android | iOS |
|---|---|
| `VaultMedia$FilesProvider` (soubory pro jiné aplikace, dešifrované při čtení) | `FileVault.decryptedCopy` → share sheet (`UIActivityViewController`) / `ShareLink`, `FileVault.discard` po použití |
| výběr obrázku / souboru (`ACTION_GET_CONTENT`), fotoaparát | `PhotosPicker` / `PHPickerViewController` (bez oprávnění), `UIDocumentPickerViewController`, kamera (`NSCameraUsageDescription`) |
| uložení do Galerie / souboru (`ACTION_CREATE_DOCUMENT`) | `PHPhotoLibrary` jen přidání (`NSPhotoLibraryAddUsageDescription`), `fileExporter` |
| sdílený text do místnosti (`ACTION_SEND`) | Share Extension (volitelně, docs/ios-architecture.md § 5) |
