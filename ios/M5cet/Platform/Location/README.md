# Platform/Location — poloha a navigace

Port `A/location/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`).

| Android | iOS |
|---|---|
| `Where` (poloha ve zprávě, mapa) | CoreLocation `CLLocationManager`, „při používání“ (`NSLocationWhenInUseUsageDescription`) |
| `LocationService` (sledování na žádost, služba v popředí) | „vždy“ jen na žádost uživatele (`NSLocationAlwaysAndWhenInUseUsageDescription`); souvislé sledování na pozadí by potřebovalo režim pozadí `location` (zatím není v Info.plist — přidat jen s funkcí) |
| `GeoLinks` (navigační a taxi aplikace) | URL schémata v Info.plist `LSApplicationQueriesSchemes`: `comgooglemaps`, `waze`, `osmandmaps`, `com.sygic.aura`, `uber`; jinak Apple Maps / https odkazy |
