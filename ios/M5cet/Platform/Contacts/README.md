# Platform/Contacts — lidé, kontakty, přítomnost (6.14)

Port `A/contacts/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`) a propojovacích částí `ui/parts/People`.
Testy v `M5cetTests/Contacts`.

| Android | iOS |
|---|---|
| `Match` (kdo je kontakt: uživatelské jméno účtu, ne telefon; žádné hashe, žádný server) | `Match` (čisté; `cleanUsername` z M5Proto) |
| `Safety` (bezpečnostní číslo, otisk, id klíče jako web) | `Safety` (čisté; pro platné klíče = `ChatIdentity.safetyNumber` / `Ec.kid` / `Ec.fingerprint` z M5Crypto, navíc Androidí „“ pro chybějící/vadné klíče) |
| `LastSeen`, `Presence`, `Avatars` | totéž (čisté, prahy a barvy webu, `Avatars` s floatovou aritmetikou Javy) |
| `RtcStats` | už portováno v `Platform/Calls` (`RtcStatsSummary`, testy `RtcStatsTests`) |
| `Store` (`people.links`, `people.verified` v uživatelské vrstvě trezoru) | `PeopleStore` — tytéž záznamy a JSON, vlákny bezpečné (`verified(kid)` pro `RoomSession.verifiedDevice`) přes `PeopleVault` |
| `AddressBook` (vlastní typ účtu, raw kontakt s řádky „Zpráva / Volat přes M5cet“) | `AddressBook.swift`: **iOS to nedovolí** — nic se do adresáře nezapisuje; `SystemContactStore` jen čte (jméno, náhled) |
| `AuthenticatorService`, `SyncService` | nejsou (iOS nemá účty aplikací v Kontaktech) |
| `LinkActivity` (výběr kontaktu, propojení) | `ContactsService.link(username:signedIn:contact:enabled:)` po `CNContactPickerViewController` v UI (výběr nepotřebuje oprávnění) |
| `ContactIntents` (řádek v Kontaktech → najít v místnostech → zpráva / hovor) | `ContactReach` (tentýž stav: čeká na odemčení, 15 s na usazení místností, 5 min max) + vstupy `ContactsService.continueUserActivity` / `handle(intent:)` (Siri, sdílení, karta kontaktu) a `handle(link:)` (`m5cet://people/message?u=…`, `…/call?u=…`) |

## Náhrada řádků v Kontaktech

iOS nemá raw kontakty, vlastní MIME řádky ani účty aplikací a aplikace nesmí potichu zapisovat do cizí karty (zápis
URL do karty by se synchronizoval do iCloudu a sdílel s kartou). Proto: odkaz žije jen v trezoru (`people.links`:
uživatelské jméno + `CNContact.identifier` v poli `lookup`) a pro každou propojenou osobu se **daruje interakce**
`INSendMessageIntent` + `INStartCallIntent` (`INPerson`: handle = uživatelské jméno, `contactIdentifier`,
`customIdentifier` = `m5cet:<jméno>`, skupina `cz.m5cet.people.<klíč>`). Siri návrhy, list sdílení a tlačítka
Zpráva / Volat na kartě kontaktu pak nabídnou M5cet; klepnutí přijde jako `NSUserActivity` →
`ContactsService.continueUserActivity` → `ContactReach` (jen pro jméno propojené tady — cizí aplikace ani odkaz
nemůže nechat M5cet „dosáhnout“ kohokoli). Odpojení / vypnutí `people.contacts` daruje zpět mažou po skupinách
(nikdy `deleteAll` — darování Notifications / Calls zůstanou); `wipe()` smaže vše.

## Přístup ke kontaktům (iOS 18+: omezený)

`access` = `.notDetermined / .denied / .restricted / .limited / .full`; `requestAccess()` jen na akci uživatele (a jen
když ještě nerozhodl). S omezeným přístupem jde číst jen sdílené kontakty: `needsAccessPicker(for:)` řekne UI, že má
pro propojenou osobu ukázat `ContactAccessButton` / `.contactAccessPicker`. `photo(of:)`, `contact(of:)` čtou náhled
a jméno; kartu kontaktu (`CNContactViewController(for:)`) ukazuje UI s `identifier(of:)`.

## API pro integraci

```swift
let people = ContactsService.shared            // init(store:contacts:donations:…) v testech
people.store.setVault(<PeopleVault>)            // Platform/Security: uživatelská vrstva, záznamy people.links / people.verified
people.store.verified(kid)                      // → M5Proto RoomSession(verifiedDevice: { people.store.verified($0) })
people.store.forget()                           // zámek aplikace (F-16)
people.reach.host = <ContactReachHost>          // ready (odemčeno, obrazovky), contactsEnabled, activeRoom, connectedRooms(), text, notice, reach(…)
people.install(into: model)                     // AppModel.onLink: m5cet://people/…
people.continueUserActivity(activity)           // ze scény PŘED CallSystem.continueUserActivity (Recents mají handle m5cet-…)
people.setEnabled(on)                           // people.contacts přepnuto
people.wipe()
```

Info.plist: pro list sdílení / Siri návrhy zpráv je potřeba `INSendMessageIntent` v `NSUserActivityTypes` (teď jen
`INStartCallIntent`) — koordinátor.

## Omezení vs. Android

* Žádné řádky „Zpráva / Volat přes M5cet“ přímo v aplikaci Kontakty; místo nich systémové návrhy z darovaných
  interakcí (kdy a kde je iOS ukáže, rozhoduje systém).
* Darované interakce zná Siri na zařízení (a podle nastavení „Siri a hledání“ se mohou synchronizovat mezi
  zařízeními uživatele); Androidí raw kontakt zůstává jen v telefonu.
* Ověřeno jen na simulátoru s falešným adresářem a falešným darováním; skutečné návrhy na kartě kontaktu čekají na
  zařízení.
