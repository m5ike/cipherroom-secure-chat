# Platform/Location — poloha a navigace (6.14)

Port `A/location/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`) na CoreLocation, plus čistá logika, která
na Androidu leží v `ui/bubble/Kinds` (kam zpráva ukazuje) a `ui/parts/Composer` (text zprávy s polohou).
Testy v `M5cetTests/Location`.

| Android | iOS |
|---|---|
| `Where` (jedna poloha, hlavička zprávy, sdílení, sledování, fronta bodů) | `LocationService` (fasáda, `@MainActor`) + `CoreLocationProvider` (`CLLocationManager`, `CLServiceSession`) + čisté `Where`, `WhereFix`, `TrackingPlan`, `TrackQueue` (`Where.swift`) |
| `LocationService` (služba v popředí pro sledování) | aktualizace na pozadí jen s režimem `location` v `UIBackgroundModes` (modrý indikátor = obdoba notifikace služby); bez něj popředí + na pozadí služba významných změn (jen „Vždy“) |
| `GeoLinks` (navigační a taxi aplikace) | `GeoLinks` — tatáž tabulka 1:1 (testy Androidu) + `iosChoices` (Apple Maps, schémata `LSApplicationQueriesSchemes`, univerzální odkazy Mapy.com / HERE) |
| `ui/bubble/Kinds.position` | `Where.position(loc:text:sealed:)`, `isPositionMessage`, `headerPosition` |
| `Composer.sharePosition` (text „📍 …“) | `Where.shareText`, `LocationService.sharePosition()` |
| `Parts.openMap` (geo: → mapa telefonu, jinak OSM) | `LocationService.openPin` (Apple Maps `maps://?ll=…&q=…`, jinak OSM) |
| `Server.signed("/api/android/location")` | `LocationReporting` → `DeviceAPILocationReporter` (M5Net `DeviceAPIClient.location`, `/api/ios/location`) |
| `JavaFormat` (Java `%.Nf`, `Math.round`) | `JavaFormat.swift` — používají ho i Contacts a Voice; patří do M5Core |

## Oprávnění (jen na akci uživatele, jako Android)

* `requestPermission()` = „při používání“ — volá UI při zapnutí `location.inHeader` / `location.track` nebo při sdílení
  polohy; `settingChanged(_:)` to dělá samo jako `MainActivity.settingChanged` na Androidu.
* „Vždy“ (`requestAlways`) **jen jednou**, když uživatel zapne sledování **a** podepsaná politika ho dovoluje
  (`policy.location.track`, chybí = povoleno) — kontrakt § 5. Nikdy při startu.
* Přesnost: `location.precise` → `kCLLocationAccuracyBest`, jinak 100 m; vypnutá „Přesná poloha“ (`reducedAccuracy`)
  se jen ohlásí (dočasná přesnost by potřebovala `NSLocationTemporaryUsageDescriptionDictionary`).

## API pro integraci

```swift
let loc = LocationService.shared
loc.settings = <LocationSettings>          // bool/number klíčů location.*, policy (JSON podepsané politiky)
loc.reporter = DeviceAPILocationReporter(credentials: { <DeviceCredentials?> })
loc.install(into: model)                   // fáze scény: na pozadí body čekají, po návratu se pošlou
loc.settingChanged("location.track")       // po změně nastavení (location.inHeader / track / interval / precise)
loc.headerLocation()                       // JSONObject pro ChatMessage.loc (location.inHeader), nil = žádná čerstvá
await loc.sharePosition()                  // (text, loc) zprávy s polohou; nil → „location.none“
loc.mapChoices(GeoLinks.nav, lat:lon:label:) / await loc.open(choice) / await loc.openPin(lat:lon:label:)
loc.scope()                                // $location obrazovky Nastavení › Poloha: {permitted, tracking, allowed}
loc.wipe()                                 // Wiper: sledování stop, fronta pryč
```

Sledování: bod nejvýš jednou za `max(15 s, location.interval, policy.minSeconds)`, ≥ 10 m; fronta ≤ 2000 bodů,
dávky po 100, odeslání po minutě nebo 20 bodech; 403 / `location-off` frontu zahodí, chyba sítě ji nechá.

## Omezení vs. Android

* Info.plist nemá režim pozadí `location`: bez něj iOS nedovolí intervalové sledování na pozadí — na pozadí jen
  významné změny (~500 m, vyžaduje „Vždy“). Pro paritu s Androidem doplnit `location` do `UIBackgroundModes`
  (koordinátor) — kód to pozná sám (`LocationService.backgroundModeDeclared`).
* Text `NSLocationAlwaysAndWhenInUseUsageDescription` mluví o „sdílení polohy v místnosti“; sledování ale posílá
  polohu **serveru** (konzole provozovatele) — text by měl odpovídat (koordinátor).
* Android nabízí „jiné aplikace, které otevřou geo:“; iOS takový mechanismus nemá — místo nich Apple Maps.
* Ověřeno jen na simulátoru (falešný poskytovatel polohy v testech); skutečná poloha a pozadí čekají na zařízení.
