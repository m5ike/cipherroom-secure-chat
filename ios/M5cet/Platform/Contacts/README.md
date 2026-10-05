# Platform/Contacts — propojení lidí s kontakty

Port `A/contacts/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`); párování a stav lidí bez systému
(`Match`, `Presence`, `LastSeen`, `Safety`, `RtcStats`) patří do `M5Kit`, UI do `Parts`.

| Android | iOS |
|---|---|
| `AddressBook`, `Store`, `Avatars` | Contacts (`CNContactStore`, `NSContactsUsageDescription`), výběr `CNContactPickerViewController` (bez plného přístupu) |
| `LinkActivity` („Propojit s kontaktem“) | `CNContactPickerViewController` |
| `AuthenticatorService`, `SyncService` (vlastní typ účtu, řádky „Zpráva / Volat přes M5cet“) | iOS vlastní řádky v aplikaci Kontakty nedovolí — náhrada: `INSendMessageIntent` / `INStartCallIntent` (Siri, sdílení, Communication Notifications) |
| `ContactIntents` | odkazy a intenty aplikace (`App/DeepLink.swift`, App Intents) |
