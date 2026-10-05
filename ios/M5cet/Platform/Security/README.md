# Platform/Security — klíče, trezor, zámek aplikace

Port zabezpečení zařízení z Androidu (`A/` = `android/app/src/main/java/cz/m5cet/app/`): `A/security/*`,
`A/chat/LockedRooms.java` (platformní polovina), `A/M5.java` (`forgetSecrets`, `onUnlocked`), režimy zámku z
`docs/android-architecture.md` § 3. UI zámku je v `Parts/Lock/`, úložiště souborů v `Platform/Files/`, testy
v `M5cetTests/Security/`. Zapojení při startu: `App/Bootstrap.swift` → `SecurityCenter.install(into:)`.

Nic z toho nečeká na `M5Kit`: kryptografie, kterou platforma potřebuje sama (AES-GCM, HKDF, PBKDF2, P-256, ECIES
schránky), je v `SecCrypto.swift` nad CryptoKit + CommonCrypto. Formáty, které přecházejí mezi zařízeními
(položky zámkové schránky, podepsaná politika, hlášení o smazání, FileVault, značka `PayloadSeal`), jsou bajt po
bajtu jako Android — testy to ověřují vektory z node:crypto a ze serveru.

## Soubory

| Android | iOS | Co |
|---|---|---|
| `Keystore` | `Keyring.swift`, `SecureStore.swift` | klíče Secure Enclave, PRF místo HMAC, Keychain |
| `Vault` | `Vault.swift`, `Files/ProtectedFiles.swift` | vrstvy SYS / USER, záznamy, cesty a Data Protection |
| `PinWrap` | `PinWrap.swift` | obal datového klíče PINem (v 2) |
| `LockCounter`, `LockStore` | `LockCounter.swift`, `LockStore.swift` | pravidla čítače, monotonní čekání, pečeť proti návratu |
| `AppLock` | `LockEngine.swift` (rozhodování), `AppLock.swift` (stav, auto-zámek) | |
| `Duress` | `DuressPin.swift` | nouzový PIN, nastavení `security.*` |
| `LockBox`, `chat/LockedRooms` | `LockBox.swift`, `LockInbox.swift` | zámková schránka |
| `Biometric` | `Biometrics.swift` | LocalAuthentication |
| `Wiper` | `Wiper.swift` | smazání, hlášení `pending-wipe.json` |
| `SignedPolicy`, `Config.applyServerAnswer` | `LockPolicy.swift` | podepsaná politika, `LockPolicy` |
| `ServerPin` | `ServerPin.swift` | pin klíče serveru při registraci |
| `IntentSeal` | `PayloadSeal.swift` | značka pro `userInfo` notifikací / odkazy |
| `Ec`, `Crypto`, `Ecies` (část) | `SecCrypto.swift`, `SecretBytes.swift`, `SecJSON.swift` | primitiva, nulovatelné klíče |
| `FileVault` | `Files/FileVault.swift` | soubory v klidu (segmenty 64 KiB) |
| `MainActivity` FLAG_SECURE | `ScreenPrivacy.swift`, `Parts/Lock/LockPresenter.swift` | kryt v přepínači, štít při nahrávání |
| `ui/parts/LockPad` | `Parts/Lock/LockScreenView.swift`, `LockTexts.swift` | obrazovka zámku |
| `M5` (část) | `SecurityCenter.swift` | složení, `forgetSecrets`, wipe, zrcadlo pro rozšíření |

## Klíče (Keyring)

Všechny klíče jsou **P-256 klíče Secure Enclave** (CryptoKit `SecureEnclave.P256` — pod ním
`SecKeyCreateRandomKey` s `kSecAttrTokenIDSecureEnclave`). Jejich `dataRepresentation` je klíč zašifrovaný
Secure Enclave, použitelný jen v tomto zařízení; ukládá se jako položka Keychainu (`SecureStore`, služba
`cz.m5cet.app.security`, účet `key.<alias>`, první bajt = úroveň 1 SE / 2 software). Smazání položky = smazání
klíče. CryptoKit místo trvalých SecKey položek proto, že úložiště klíče je pak naše (`SecureStore`) a cesta Secure
Enclave jde testovat i v nepodepsaném simulátoru (simulátor na Apple Silicon Secure Enclave má, Keychain bez
entitlementu ne).

| alias | druh | přístup (`SecAccessControl`) | Android | k čemu |
|---|---|---|---|---|
| `sys` | dohoda | `AfterFirstUnlockThisDeviceOnly` + `privateKeyUsage` | `m5.sys` | obal DEK_sys (čte i push / rozšíření) |
| `bio` | dohoda | `WhenPasscodeSetThisDeviceOnly` + `privateKeyUsage` + `biometryCurrentSet` | `m5.bio` | obal DEK_user, každé použití = biometrie |
| `pin` | dohoda | `WhenUnlockedThisDeviceOnly` + `privateKeyUsage` | `m5.pin` | PRF klíče PINu |
| `duress` | dohoda | `WhenUnlockedThisDeviceOnly` | `m5.duress` | PRF ověřovače nouzového PINu |
| `ctr.N` | dohoda | `WhenUnlockedThisDeviceOnly` | `m5.ctr.N` | pečeť čítače pokusů, jedna generace |
| `sign` | podpis | `AfterFirstUnlockThisDeviceOnly` | `m5.sign` | podpis požadavků (`DeviceSigner`, P1363) |
| `enc` | dohoda | `AfterFirstUnlockThisDeviceOnly` | software v `Config` | šifrovací klíč zařízení (`DeviceAgreement`, ECIES) |

**Bez Secure Enclave** (zařízení bez SE / test) jsou tytéž klíče softwarové P-256 v Keychainu, úroveň
`"software"` — ukazuje se to (`Vault.pinKeyLevel`, pole `hw`), jako Android „jen software“. **Biometrický klíč
v simulátoru**: Secure Enclave simulátoru klíč s biometrií neudělá (`LAError -1020`), proto jen
`#if targetEnvironment(simulator)` vznikne softwarový klíč hlídaný jen výzvou; na zařízení se nikdy nepoužije.
**Nepodepsaný build** (CI: `CODE_SIGNING_ALLOWED=NO`) nemá entitlement Keychainu (`errSecMissingEntitlement`):
v simulátoru pak místo Keychainu `FileSecureStore` (soubory v `m5-shared/dev-keychain`), na zařízení nikdy.

### Klíč PINu: PRF ze Secure Enclave místo HMAC

Android: `KEK = HMAC(m5.pin, "m5/pin/2|" ‖ PBKDF2(PIN))`, klíč HMAC nikdy neopustí TEE/StrongBox, takže hádání
PINu offline potřebuje tento telefon. Secure Enclave HMAC neumí — umí podpis a ECDH. Náhrada:

```
H(x)          = bod P-256 z SHA-256("m5/ios/h2c/1|" ‖ u32 čítač ‖ x) — x jako souřadnice, CryptoKit ho
                dekomprimuje (try-and-increment, průměrně 2 pokusy); diskrétní logaritmus nikdo nezná
prf(alias, x) = HMAC-SHA256(klíč: ECDH(d_alias, H(x)), x)          d_alias jen v Secure Enclave
KEK           = prf("pin", "m5/pin/2|" ‖ PBKDF2-SHA256(PIN, sůl, 210 000, 32))
```

ECDH(d, H(x)) bez d spočítat nejde (CDH; veřejný klíč `d·G` nepomůže, protože log H(x) nikdo nezná), a pro
každé x je to jiná hodnota — **každý odhad PINu je jeden dotaz na Secure Enclave tohoto zařízení**, stejně jako
dotaz na HMAC v TEE (oblivious-PRF použití enclave). Kopie souborů ani Keychainu jinde nic neotevře
(`PinWrapTests.testTheEnclaveKekNeedsThisDevice`). Zvažovaná jednodušší varianta (ECDH s pevným uloženým
veřejným klíčem → jedno tajemství) by tuto vlastnost neměla: kód běžící jako aplikace by tajemství vytáhl jednou
a hádal mimo zařízení. Pozn.: počet pokusů hash-to-curve závisí na PBKDF2 výstupu — časování prozradí ~1 bit na
pozorování, a to jen útočníkovi, který měří odemykání uvnitř zařízení.

Tentýž PRF nahrazuje HMAC u nouzového PINu (`"m5/duress/1|" ‖ PBKDF2(PIN)`) a u pečeti čítače.

## Trezor (Vault)

| | soubor | Data Protection | obsah |
|---|---|---|---|
| SYS | App Group `Library/Application Support/m5/sys.key` | `completeUntilFirstUserAuthentication` | `{v:1, hw, e, iv, ct}` — DEK_sys k SE klíči `sys`: e = efemérní P-256, K = HKDF-SHA256(ECDH(sys, e), "m5/ios/sys.key/1", e), AES-256-GCM, AAD `m5/sys.key` |
| SYS | App Group `…/m5/sys/<jméno>.bin` | `completeUntilFirstUserAuthentication` | záznamy: iv ‖ AES-GCM(DEK_sys), AAD `SYS|<jméno>` |
| USER | aplikace `Application Support/m5/user.pin` | `complete` | PinWrap v 2 `{v:2, salt, iter, iv, ct, hw}`, AAD `m5/user.pin/2` |
| USER | aplikace `…/m5/user.bio` | `complete` | `{v:1, hw, e, iv, ct}` k SE klíči `bio`, salt HKDF `m5/ios/user.bio/1`, AAD `m5/user.bio` |
| USER | aplikace `…/m5/user/<jméno>.bin` | `complete` | záznamy, AAD `USER|<jméno>` (jako Android) |
| — | aplikace `…/m5/lockbox/` | `completeUnlessOpen` | zámková schránka (níže) |
| — | aplikace `…/m5/files/<id>.m5f` | `complete` | FileVault |
| — | aplikace `Application Support/pending-wipe.json` | `completeUntilFirstUserAuthentication` | hlášení o smazání (bez tajemství) |
| — | App Group `…/m5/lock-state.json` | `completeUntilFirstUserAuthentication` | zrcadlo zámku pro rozšíření notifikací (bez tajemství) |

Obě složky `m5` jsou vyloučené ze záloh (`isExcludedFromBackup` — Android `allowBackup=false`). **Rozšíření
notifikací vidí jen SYS**: App Group obsahuje jen SYS vrstvu a zrcadlo, nikdy `user.*`, schránku ani soubory
(`VaultTests.testOnlyTheSystemTierIsOnTheSharedSide`). Bez App Group kontejneru (nepodepsaný build) je SYS
v `Application Support/m5-shared` aplikace. Zápisy klíčových souborů jsou trvalé (`F_FULLFSYNC` souboru,
přejmenování, sync adresáře — Android `writeDurable`).

DEK je v `SecretBytes` (vlastní buffer, `memset_s` při `wipe` a `deinit`); čtenáři sdílí instanci, takže
`Vault.lock()` vynuluje klíč i těm, kdo si ho vzali dřív (Android 6.12 F-16). Kdo potřebuje klíč přes zámek
(zápis souboru), vezme si `copy()` a vynuluje ji sám (`FileVault.Writer`).

## Zámek aplikace

* **Politika** (`LockPolicy`, jen podepsaná: `PolicyStore.apply(answer:serverKey:deviceId:)` — M5Net mu dá každou
  odpověď serveru): `biometric` required/optional/off, `pinLength` 4–12 (6), `maxAttempts` 3–20 (8), `wipe` (ano),
  `backoff` (ano), `screenshots` (ne), `autolockSeconds` 0–86 400 (60). Nepodepsaná, cizí nebo starší se ignoruje.
* **Pokusy** (`LockEngine` = Android `AppLock`): nouzový PIN se zkouší první (i během čekání); pokus se započítá
  a uloží **před** PBKDF2 (zabití aplikace ho nezruší, `pending` se příště vyrovná jako chyba); od 3. chyby čekání
  30 s × 2ⁿ (max 1 h); po posledním pokusu wipe podle politiky, jinak hodinová blokace; zrušená výzva biometrie se
  nepočítá; změna PINu vyžaduje současný PIN a počítá se; nový PIN nesmí být nouzový.
* **Čítač v Keychainu proti návratu** (`LockStore`): záznam `lock` je položka Keychainu
  (`WhenUnlockedThisDeviceOnly`), zapečetěná PRF klíče generace `ctr.N`; každý zápis = nová generace, trvalý zápis,
  pak smazání staré. Starší kopie / smazaný / upravený záznam = **rollback = všechny pokusy vyčerpané** (wipe nebo
  blokace). Klíče, které teď nejdou přečíst, nerozhodují nic (pokus se nezapočítá → PIN se neověří).
* **Monotonní čekání (oprava slabiny M4 Androidu)**: čekání se měří na `CLOCK_MONOTONIC` (běží i ve spánku)
  relace bootu (`kern.bootsessionuuid`), pole `untilMono`, `boot`, `wait` jsou v pečeti. Posunutí hodin čekání
  nezkrátí ani neprodlouží. Po restartu se počítá jen čas od bootu (zbytek = `wait − uptime`, ukotví se znovu) —
  restart čekání nikdy nezkrátí (může ho prodloužit o dobu, kdy byl telefon vypnutý). Další povolený pokus čekání
  vymaže, takže pozdější restart nic neobnoví.
* **Nouzový PIN** (`security.duress`, výchozí vypnuto): ověřovač `{salt, iter, tag}` v SYS, `tag =
  prf("duress", "m5/duress/1|" ‖ PBKDF2(PIN))`; na zámku smaže aplikaci **potichu** (bez hlášky „data smazána“,
  hlášení `quiet`), server se to dozví (důvod `duress`).
* **Biometrie**: klíč `bio` s `biometryCurrentSet`; po úspěšné výzvě (`LAContext`) Secure Enclave rozbalí DEK
  s tímto kontextem. Na rozdíl od Androidu zápis obalu výzvu nepotřebuje (použije se veřejná polovina klíče).
  Změna otisků/obličeje: hash `domainState.biometry.stateHash` uložený při zápisu nesedí → biometrie se vypne a
  hlásí `key-invalidated` (Android `KeyPermanentlyInvalidatedException`) dřív, než se ukáže výzva.
* **Auto-zámek** (výchozí 60 s na pozadí): `AppLock.onBackground` začne úlohu na pozadí a časovač; návrat
  (`willEnterForeground`, scénová fáze) porovná monotonní čas. **Rozdíl oproti Androidu**: Android budí proces
  alarmem v čase auto-zámku; iOS uspanou aplikaci v čase nevzbudí. Proto: dokud aplikace na pozadí běží (úloha
  ≈30 s, déle při hovoru), zamkne časovač; když ji iOS uspává dřív (vypršení úlohy na pozadí), **datový klíč jde
  pryč hned** (`forgetWhenSuspended`, výchozí ano) — klíč nikdy nespí v uspané aplikaci. Efektivní auto-zámek je
  tedy min(politika, uspání), mimo hovor. `autolockSeconds = 0` zamkne při odchodu do pozadí.
* **Zámek zapomíná** (`SecurityCenter.forgetSecrets` = Android `M5.forgetSecrets`): výchozí režim **příjem po
  zamčení** — dokud DEK ještě je, začne nová generace zámkové schránky, účastníci (`LockParticipant`) dostanou
  `lockWillForget(receiving: inbox)`, pak se DEK vynuluje a `lockDidForget()`. **Přísný režim**
  `security.lockDisconnect`: `lockWillForget(receiving: nil)` = odpojit místnosti. Během hovoru se obrazovka
  zamkne hned a klíč zůstane do konce hovoru (`inCall`, kontrola po 15 s); příkaz serveru (`lockNow(remote: true)`)
  bere klíč i během hovoru; zámek během slučování schránky počká.

## Zámková schránka (LockInbox, LockBox)

Formát **bajt po bajtu jako Android** (`LockBoxTests.testAnAndroidGenerationOpensHere` otevírá generaci vyrobenou
algoritmem `LockBox.java` v node:crypto): při zámku nový pár P-256, `kid = base64url(SHA-256(SPKI))[0..16]`;
soukromý klíč (PKCS#8) zapečetěný DEK (`iv ‖ AES-GCM`, AAD `m5/lockbox/1|key|<kid>`) se zapíše do
`lockbox/<kid>.key` **dřív, než se DEK vynuluje**; v paměti zůstane jen veřejný klíč. Položka = nový efemérní klíč,
ECDH, HKDF-SHA256 (salt `m5/lockbox/1`, info `<kid>|<seq>|<SPKI eph>`), AES-256-GCM s AAD
`m5/lockbox/1|<kid>|<seq>`, řádek `{"s","e","iv","ct"}` v `lockbox/<kid>.log` (synchronizovaný zápis; useknutý řádek
se přeskočí). Druhy položek jako Android: `msg`, `state`, `pin`, `resume`, `call`, `callUri`, `file` (soubor se
přesune do `lockbox/files/<id>.part`, klíč přenosu je v položce). Log je otevřený po celou generaci
(`completeUnlessOpen`: zapisovatelný i při zamčeném telefonu, po zavření nečitelný do odemčení).

Odemčení: `LockInbox.unlocked(dek:consumer:)` schránku uzavře, generace (starší zámek první) otevře na pozadí
vlastní kopií DEK, každou předá `LockInboxConsumer.apply(_:inbox:)` seskupenou jako Android `Parsed` (piny „první
vítězí“, resume „poslední vítězí“) a smaže; pak `restoreAll()`. Pád během zámku schránku nechá na disku (bez PINu
nečitelnou) a příští odemčení ji sloučí; generaci cizího klíče smaže. Pravidla chatu (validace zprávy, pořadí
potvrzení, sloty souborů) patří místnostem — `LockInbox.merge` (podle id, známé id na svém místě) je dostane jako
uzávěry.

## Ochrana obrazovky (náhrada FLAG_SECURE)

`ScreenPrivacy`, dokud politika nepovolí `screenshots`: při `willDeactivate` scény okno s krytem (`alert + 2`,
vzhled úvodní obrazovky) — snímek pro přepínač aplikací nic neukáže; při nahrávání / zrcadlení / sdílení obrazovky
(`UITraitCollection.sceneCaptureState`, sledováno na každé scéně) kryt zůstává; snímek obrazovky
(`userDidTakeScreenshotNotification`, už pořízený) = událost `screenshot` a s `security.screenshotFlash` krátký
záblesk krytu. Zámek je vlastní okno (`alert + 1`, `LockPresenter`) na každé scéně (iPad: víc oken) — žádná
obrazovka aplikace o zámku vědět nemusí, aplikace pod ním nedostane dotyky ani fokus VoiceOver.

## Smazání (Wiper)

Nejdřív (dokud klíč zařízení existuje) podepsané hlášení `{"events":[{id, type: wipe|remote-wipe, at, detail:
{reason, attempts}}]}` přes `WipeReportSigner` (M5Net) do `pending-wipe.json` (`{url, headers, body, quiet}` jako
Android), pak: schránka zavřít, odpojit ostatní části (`addTeardown` — notifikace, zkratky, URL cache, cookies; hovory,
poloha… přidají své), oba DEK vynulovat, všechny klíče a položky Keychainu, `m5` v aplikaci i App Group, cache a tmp,
UserDefaults aplikace a skupiny. Doručení `sendPending()` při každém startu; 4xx (mimo 429) = zahodit. Místní wipe
ukáže na chvíli „data smazána“ (`lock.wiped`), tichý ne. **Vzdálený wipe**: hlášení nejvýš 8 s, pak se paměť
vynuluje a aplikace na pozadí skončí (`exit(0)`; iOS nedovolí odstranit se z přepínače — Android
`finishAndRemoveTask`).

## Rozhraní pro ostatní části

| protokol / typ | kdo ho použije |
|---|---|
| `DeviceSigner` (`SecurityCenter.shared.signer`) | M5Net — `X-M5-Signature` a důkaz při registraci (SPKI + P1363) |
| `DeviceAgreement` (`.agreement`) | M5Net / Push — ECIES ze serveru (surové ECDH) |
| `SecureStore` (`.secrets`) | kdokoli s malým tajemstvím (relace účtu…) |
| `Vault` + `VaultTier` (`.vault`) | všechna úložiště (SYS: server, politika, události; USER: místnosti, zprávy, identity) |
| `FileVault` | Files, přenosy, média |
| `AppLockState` (`.lock`) | Push (příkaz `lock`), Notifications (neutrální text: `isLocked`), Renderer (`lock.now`) |
| `LockParticipant` (`.add`) | místnosti, účet, profily, kontakty, Záznam — co zámek zapomíná |
| `LockInbox` + `LockInboxConsumer` (`.inbox`, `.inboxConsumer`) | místnosti — příjem po zamčení a sloučení |
| `PolicyStore.apply` (`.policies`) | M5Net — `policySigned` z registrace / check-inu |
| `ServerPin.check` / `same` | M5Net — registrace |
| `PayloadSeal` | Notifications / Push — `room` v `userInfo` a akce odpovědi |
| `SecurityCenter.wipe(reason:remote:attempts:)` | Push (příkaz `wipe`) |
| `WipeReportSigner`, `WipeTransport` (`.wiper.signer/.transport`) | M5Net |
| `inCall` | Calls |
| `LockScreenView` + `LockPadModel(mode: .setup)` | Renderer — obrazovka nastavení PINu (design `lock`) |
| `lock-state.json` | NSE: `locked` nebo (`bg` > 0 a stejný `boot` a `CLOCK_MONOTONIC − bgMono ≥ autolock·1000`) nebo jiný `boot` → neutrální text |

## Rozdíly oproti Androidu (a proč)

* HMAC klíče Keystore → **PRF ze Secure Enclave** (ECDH s hash-to-curve), viz výše; obal PINu jen v 2, `hw` =
  `secure-enclave` / `software` (iOS nemá instalaci 6.11 k převodu).
* Čítač pokusů je **položka Keychainu**, ne soubor trezoru (kontrakt § 5); pečeť pokrývá i monotonní čekání.
* **Monotonní čekání** a pravidlo restartu (Android: nástěnné hodiny, slabina M4).
* **Auto-zámek při uspání** místo alarmu (iOS nebudí v čase).
* Šifrovací klíč zařízení je v Secure Enclave (Android: software v SYS vrstvě).
* Biometrický obal bez výzvy při zápisu; neplatnost podle `domainState`.
* Screenshoty iOS zakázat nejde: kryt v přepínači, štít při nahrávání, hlášení snímku.
* Vzdálený wipe aplikaci z přepínače neodstraní; na pozadí skončí.

## Testy (`M5cetTests/Security`, simulátor)

104 testů: primitiva (RFC 7914 / 5869 / node), klíče (obě cesty: Secure Enclave simulátoru i software), PinWrap
(Android `PinWrapTest`), trezor, čítač a pečeť (Android `LockCounterTest`, `LockStoreTest` případ po případu
včetně přerušení mezi kroky), monotonní čekání a restart, AppLock end-to-end (pokusy, čekání, wipe, blokace,
rollback, nouzový PIN, biometrie, auto-zámek, uspání, hovor, schránka, přísný režim, zrcadlo), schránka (formát
Androidu z node), wipe (úplnost), politika (podpis serveru z Android testu), ServerPin, PayloadSeal (vektor
node), FileVault, PIN pad a okna na scéně. Test Keychainu se v nepodepsaném buildu přeskočí; s ad-hoc podpisem
(`CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual`) běží i on.

## Neověřeno (potřebuje zařízení)

Biometrický klíč v Secure Enclave s `biometryCurrentSet` a jeho zneplatnění, použití SE klíčů z rozšíření
notifikací (sdílená skupina Keychainu), `F_FULLFSYNC` a `completeUnlessOpen` při zamčeném telefonu, délka úlohy na
pozadí a uspání, `sceneCaptureState` při skutečném nahrávání / AirPlay, doba PBKDF2 210 000 + SE na starším iPhonu.
Položky Keychainu jdou do výchozí skupiny aplikace, která je zároveň skupinou rozšíření (první v
`keychain-access-groups`) — rozšíření tedy technicky vidí i bloby klíčů `pin`/`bio` (bez PINu / biometrie
nepoužitelné). Kdyby měly být jen aplikace, patří do entitlementů další, jen aplikační skupina na první místo
(změna projektu → koordinátor).
