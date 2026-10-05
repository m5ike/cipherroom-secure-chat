# Snímky obrazovek iOS (6.14, závěrečná kontrola)

Výchozí design iOS (`ios/Design/m5`), Xcode 27, simulátory iPhone 17 a iPad Pro 13" (M5), iOS 26.5.
Každá obrazovka světle (`-light`) i tmavě (`-dark`); PNG nejvýš 1400 px a 300 kB. Jména: `<zařízení>-<obrazovka>-<tón>.png`.

* **iPhone** na výšku — `xcrun simctl io … screenshot` ze spuštěné aplikace. Ukázková data konzole (`-M5Screen …`,
  `Renderer/README.md`), `-live` = skutečná aplikace proti místnímu vývojovému serveru (zápis, PIN, místnosti, druhý
  člověk „Alice“ v témž procesu — `-M5CoreServer/Pin/Join/Bot/Say/Screen`).
* **iPad** na šířku (`ipad-…`) — okno 1376 × 1032 pt (regular šířka) kreslené testem `QAScreenshotTests` (simulátor
  bez okna otočit nejde); služby aplikace se všemi částmi a ukázkové jádro. `ipad-portrait-…` = iPad na výšku ze
  simulátoru (`simctl`).
* `iphone-cs-…` — kontrola češtiny (jazyk systému cs).

| Obrazovka | iPhone | iPad |
|---|---|---|
| Úvodní obrazovka | `iphone-splash` | `ipad-splash` |
| Zápis k serveru | `iphone-enroll` (čistá instalace) | `ipad-enroll` |
| Nastavení PINu | `iphone-pin-setup` (po zápisu k serveru) | — |
| Zámek | `iphone-lock` (s Face ID) | `ipad-lock`, `ipad-portrait-lock` |
| Místnosti | `iphone-rooms`, `iphone-rooms-live` | `ipad-rooms`, `ipad-portrait-rooms` |
| Místnost: obrázek, hlasová zpráva, soubor, odpověď modelu, citace | `iphone-room` | `ipad-room`, `ipad-portrait-room` |
| Místnost: mapa, zapečetěná, „podržet k přečtení“, mizející, soukromá | `iphone-room-map` | — |
| Místnost se skutečným hovorem dvou lidí (server) | `iphone-room-live` | — |
| Odpověď na zprávu (skladač nad klávesnicí) | `iphone-reply` | — |
| Výsledek funkce `/report` (a běžící) | `iphone-fn` | `ipad-portrait-fn` |
| Skladač — přílohy | `iphone-attach` | `ipad-attach` |
| Dok nástrojů | `iphone-tools` | `ipad-tools` |
| Menu zprávy (dlouhé podržení) | `iphone-menu` | `ipad-menu` |
| Hlavní menu | `iphone-mainmenu` | — |
| Poloha ve zprávě (list) | `iphone-place` | `ipad-map` |
| Panel Lidé | `iphone-room-people` | `ipad-room-people` |
| Detail člověka | `iphone-person` | `ipad-person` |
| Bezpečnostní číslo (QR) | `iphone-safety` | `ipad-safety` |
| Informace o zprávě | `iphone-msginfo` | `ipad-msginfo` |
| Připojit se k místnosti | `iphone-join` | `ipad-join` |
| Nová verze / vzhled (aktualizace) | `iphone-update` | `ipad-update` |
| Nastavení | `iphone-settings`, `iphone-settings-live` | `ipad-settings`, `ipad-portrait-settings` |
| Nastavení › Uživatel | `iphone-settings.user`, `iphone-settings.user-live` | `ipad-settings.user` |
| Nastavení › Zprávy | `iphone-settings.messages` | `ipad-settings.messages` |
| Nastavení › Hlas, Měnič hlasu | `iphone-settings.voice`, `iphone-settings.voiceFx` | `ipad-settings.voice`, `ipad-settings.voiceFx` |
| Nastavení › Poloha | `iphone-settings.location` | `ipad-settings.location` |
| Nastavení › Hovory (historie aplikace Telefon) | `iphone-settings.calls` | `ipad-settings.calls` |
| Nastavení › Lidé a kontakty | `iphone-settings.people` | `ipad-settings.people` |
| Nastavení › Vzhled | `iphone-settings.appearance` | `ipad-settings.appearance` |
| Nastavení › Zabezpečení (klíč PINu v Secure Enclave) | `iphone-settings.security`, `iphone-settings.security-live` | `ipad-settings.security` |
| Nastavení › Oznámení (konverzace iOS, Apple Watch jen na iPhonu) | `iphone-settings.notify`, `iphone-settings.notify-live` | `ipad-settings.notify` |
| Veřejný profil | `iphone-settings.profile` | — |
| O aplikaci | `iphone-about`, `iphone-about-live` | `ipad-about` |
| Hovor (skupinový, ovládání) | `iphone-call` | `ipad-call` |
| Historie hovorů a zpráv | `iphone-log` | `ipad-log` |
| Asistent AI | `iphone-ai` | `ipad-ai` |
| Hlas (diktování) | `iphone-voice` | `ipad-voice`, `ipad-portrait-voice` |
| NFC — pracoviště (NTAG) | `iphone-nfc` | — |
| NFC — výsledek čtení e-ID | `iphone-nfc-report` | — |
| NFC — tvorba karty M5Cet | `iphone-nfc-builder` | `ipad-nfc.builder` |
| NFC — zařízení bez čtečky | — | `ipad-nfc`, `ipad-portrait-nfc` |

Čeština (jen světle): `iphone-cs-settings.notify`, `iphone-cs-settings.calls`, `iphone-cs-settings.security`,
`iphone-cs-attach`, `iphone-cs-room-people`, `iphone-cs-msginfo`, `iphone-cs-mainmenu`, `iphone-cs-nfc-classic`
(důvody omezení Core NFC česky).

Ukázková data jsou data konzole (místnosti „Tým“, „Rodina“, uživatel `bystry-sokol-7k3q`); profil na iPadu není
(ukázkový profil se v testu nenačte). Starší dílčí sady jsou v `../chat`, `../nfc`, `../people`.
