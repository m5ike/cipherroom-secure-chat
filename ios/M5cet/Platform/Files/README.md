# Platform/Files — soubory zpráv, médií a sdílení

Port systémové části `A/ui/media/VaultMedia`, `A/security/FileVault` (úložiště) a souborových částí `A/chat/Files`
(`A/` = `android/app/src/main/java/cz/m5cet/app/`); přenos a formát FileVault jsou v `M5Kit/M5Proto` + `M5Crypto`,
přehrávače a náhledy (`AudioBar`, `Previews`, `VideoBox`) v `Parts`.

| Android | iOS |
|---|---|
| `VaultMedia$FilesProvider` (soubory pro jiné aplikace, dešifrované při čtení) | dočasná kopie s Data Protection `complete` → share sheet (`UIActivityViewController`) / `ShareLink`, smazání po použití |
| výběr obrázku / souboru (`ACTION_GET_CONTENT`), fotoaparát | `PhotosPicker` / `PHPickerViewController` (bez oprávnění), `UIDocumentPickerViewController`, kamera (`NSCameraUsageDescription`) |
| uložení do Galerie / souboru (`ACTION_CREATE_DOCUMENT`) | `PHPhotoLibrary` jen přidání (`NSPhotoLibraryAddUsageDescription`), `fileExporter` |
| úložiště souborů trezoru | `FileManager` v kontejneru aplikace, `NSFileProtectionComplete`, vyloučeno ze zálohy (`isExcludedFromBackup`) — Android `allowBackup=false` |
| sdílený text do místnosti (`ACTION_SEND`) | Share Extension (volitelně, docs/ios-architecture.md § 5) |
