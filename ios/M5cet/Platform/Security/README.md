# Platform/Security — klíče, trezor, zámek aplikace

Port zabezpečení zařízení z Androidu (`A/` = `android/app/src/main/java/cz/m5cet/app/`): `A/security/*`,
`A/chat/LockedRooms.java` (platformní polovina), `A/M5.java` (`forgetSecrets`, `onUnlocked`), režimy zámku z
`docs/android-architecture.md` § 3. UI zámku je v `Parts/Lock/`, úložiště souborů v `Platform/Files/`, testy
v `M5cetTests/Security/`. Zapojení při startu: `App/Bootstrap.swift` → `SecurityCenter.install(into:)`.

**Jedna implementace na pojem.** Formáty a kryptografie, které jsou v `M5Kit`, se berou odtud (jejich testy
a vektory jsou tam): `M5Crypto` — `PinWrap`, `LockBox`, `SignedPolicy`, `IntentSeal`, `Ecies`, `Ec`, `Crypto`,
`DeviceSigner` / `KeyAgreer`; `M5Proto` — `LockInbox` (otevřená generace), `LockedRooms` (položky, `parse`,
`merge`), `FileVaultFormat`; `M5Net` — `RequestSigner`, `ServerKeyPin`, `SignedDevicePolicy` / `DeviceState`;
`M5Core` — `Bytes` (= `[UInt8]`) a jeho pomocníci, `JSON` / `JSONObject`. Tady je jen to, co je platformní:
Secure Enclave a Keychain, soubory a Data Protection, zámek, okna. Typy aplikace se jmenují podle toho, co
přidávají (`LockInboxFiles`, `KeyringSigner`, `SecretBytes`, `SecData`), žádný se nejmenuje jako veřejný typ
M5Kit — `ios/scripts/check-duplicate-types.sh --app` to hlídá a `M5cetTests/ImportAllModulesTests` importuje
aplikaci se všemi šesti moduly. Formáty, které přecházejí mezi zařízeními (obal PINu, zámková schránka,
podepsaná politika, hlášení o smazání, FileVault, značka v `userInfo`), jsou bajt po bajtu jako Android.

## Soubory

| Android | iOS | Co |
|---|---|---|
| `Keystore` | `Keyring.swift` (+ `EnclavePRF`), `SecureStore.swift` | klíče Secure Enclave, PRF místo HMAC, Keychain (dvě skupiny) |
| `Vault`, `PinWrap` | `Vault.swift` (obal PINu = `M5Crypto.PinWrap` s KEK z `EnclavePRF`), `Files/ProtectedFiles.swift` | vrstvy SYS / USER, záznamy, cesty a Data Protection |
| `LockCounter`, `LockStore` | `LockCounter.swift`, `LockStore.swift` | pravidla čítače, monotonní čekání, pečeť proti návratu |
| `AppLock` | `LockEngine.swift` (rozhodování), `AppLock.swift` (stav, auto-zámek) | |
| `Duress` | `DuressPin.swift` | nouzový PIN, nastavení `security.*` |
| `chat/LockedRooms` (soubory) | `LockInboxFiles.swift` nad `M5Proto.LockInbox` / `LockedRooms` a `M5Crypto.LockBox` | zámková schránka na disku |
| `Biometric` | `Biometrics.swift` | LocalAuthentication |
| `Wiper` | `Wiper.swift` | smazání, hlášení `pending-wipe.json` |
| `Config.applyServerAnswer` (politika zámku) | `LockPolicy.swift` (`LockPolicy`, `PolicyStore`; ověření `M5Crypto.SignedPolicy`) | podepsaná politika pro zámek |
| `IntentSeal` (extra v intentu) | `IntentSealUserInfo.swift` nad `M5Crypto.IntentSeal` | značka v `userInfo` notifikací / v odkazu |
| `Keystore.signKey`, šifrovací klíč | `DeviceKeys.swift` (`KeyringSigner`, `KeyringAgreement`) | `RequestSigner` + `DeviceSigner`, `KeyAgreer` |
| — | `SecCrypto.swift`, `SecretBytes.swift` | AES-GCM s nulovatelným klíčem (bajty jako `Crypto.gcmSeal`), `SecretBytes`, `SecData` |
| `FileVault` | `Files/FileVault.swift` nad `M5Proto.FileVaultFormat` | soubory v klidu (segmenty 64 KiB) |
| `MainActivity` FLAG_SECURE | `ScreenPrivacy.swift`, `Parts/Lock/LockPresenter.swift` | kryt v přepínači, štít při nahrávání |
| `ui/parts/LockPad` | `Parts/Lock/LockScreenView.swift`, `LockTexts.swift` | obrazovka zámku |
| `M5` (část) | `SecurityCenter.swift` | složení, `forgetSecrets`, wipe, zrcadlo pro rozšíření |

## Klíče (Keyring)

Všechny klíče jsou **P-256 klíče Secure Enclave** (CryptoKit `SecureEnclave.P256` — pod ním
`SecKeyCreateRandomKey` s `kSecAttrTokenIDSecureEnclave`). Jejich `dataRepresentation` je klíč zašifrovaný
Secure Enclave, použitelný jen v tomto zařízení; ukládá se jako položka Keychainu (`SecureStore`, účet
`key.<alias>`, první bajt = úroveň 1 SE / 2 software). Smazání položky = smazání klíče. CryptoKit místo trvalých
SecKey položek proto, že úložiště klíče je pak naše (`SecureStore`) a cesta Secure Enclave jde testovat i
v nepodepsaném simulátoru (simulátor na Apple Silicon Secure Enclave má, Keychain bez entitlementu ne).

| alias | druh | přístup (`SecAccessControl`) | skupina | Android | k čemu |
|---|---|---|---|---|---|
| `sys` | dohoda | `AfterFirstUnlockThisDeviceOnly` + `privateKeyUsage` | **sdílená** | `m5.sys` | obal DEK_sys (čte i push / rozšíření) |
| `enc` | dohoda | `AfterFirstUnlockThisDeviceOnly` | **sdílená** | software v `Config` | šifrovací klíč zařízení (`KeyAgreer`, `Ecies.open`) |
| `bio` | dohoda | `WhenPasscodeSetThisDeviceOnly` + `privateKeyUsage` + `biometryCurrentSet` | aplikace | `m5.bio` | obal DEK_user, každé použití = biometrie |
| `pin` | dohoda | `WhenUnlockedThisDeviceOnly` + `privateKeyUsage` | aplikace | `m5.pin` | PRF klíče PINu |
| `duress` | dohoda | `WhenUnlockedThisDeviceOnly` | aplikace | `m5.duress` | PRF ověřovače nouzového PINu |
| `ctr.N` | dohoda | `WhenUnlockedThisDeviceOnly` | aplikace | `m5.ctr.N` | pečeť čítače pokusů, jedna generace |
| `sign` | podpis | `AfterFirstUnlockThisDeviceOnly` | aplikace | `m5.sign` | podpis požadavků (`RequestSigner` / `DeviceSigner`, P1363) |

### Skupiny Keychainu (aplikace × rozšíření notifikací)

| skupina (`keychain-access-groups`) | kdo | služba (`kSecAttrService`) | co v ní je |
|---|---|---|---|
| `<TEAMID>.cz.m5cet.app` — první v aplikaci = její výchozí | jen aplikace | `cz.m5cet.app.security` | `key.pin`, `key.bio`, `key.duress`, `key.ctr.N`, `key.sign`, záznam čítače `lock`, `SecurityCenter.secrets` |
| `<TEAMID>.cz.m5cet.shared` | aplikace **a** `M5cetNotifications` | `cz.m5cet.shared.security` | `key.sys` (obal DEK_sys → SYS vrstva v App Group), `key.enc` (šifrovací klíč zařízení → ECIES push), `SecurityCenter.sharedSecrets` |

Rozšíření tedy vidí jen to, co potřebuje k otevření SYS vrstvy a zapečetěného obsahu push zpráv; PIN, biometrie,
nouzový PIN, čítač ani podpisový klíč ne (kdyby rozšíření muselo podepisovat požadavky, `sign` se přesune do
`Keyring.sharedAliases`). **Pro rozšíření**: položka `key.sys` / `key.enc` = 1 bajt úrovně (1 Secure Enclave,
2 software) + blob (`SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation:)`, resp. surový skalár);
dotaz `kSecClassGenericPassword`, `kSecAttrService = "cz.m5cet.shared.security"`, `kSecAttrAccount = "key.sys"`,
`kSecAttrAccessGroup = "<TEAMID>.cz.m5cet.shared"`, `kSecUseDataProtectionKeychain = true`. Formát `sys.key`
(App Group `Library/Application Support/m5/sys.key`) je v oddílu Trezor, záznamy `sys/<jméno>.bin`
(AAD `SYS|<jméno>`), zrcadlo zámku `lock-state.json`. Prefix týmu zjistí aplikace za běhu
(`KeychainSecureStore.groupPrefix()`: položka přidaná do výchozí skupiny řekne její jméno); v ad-hoc podepsaném
simulátoru je prefix prázdný (`cz.m5cet.app`, `cz.m5cet.shared`) — testy skupin běží tam.

**Bez Secure Enclave** (zařízení bez SE / test) jsou tytéž klíče softwarové P-256 v Keychainu, úroveň
`"software"` — ukazuje se to (`Vault.pinKeyLevel`, pole `hw`), jako Android „jen software“. **Biometrický klíč
v simulátoru**: Secure Enclave simulátoru klíč s biometrií neudělá (`LAError -1020`), proto jen
`#if targetEnvironment(simulator)` vznikne softwarový klíč hlídaný jen výzvou; na zařízení se nikdy nepoužije.
**Nepodepsaný build** (CI: `CODE_SIGNING_ALLOWED=NO`) nemá entitlement Keychainu (`errSecMissingEntitlement`):
v simulátoru pak místo Keychainu `FileSecureStore` — aplikační skupina v `m5/dev-keychain` (kontejner
aplikace), sdílená v `m5-shared/dev-keychain` (strana App Group) — na zařízení nikdy.

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
| USER | aplikace `Application Support/m5/user.pin` | `complete` | `M5Crypto.PinWrap` v 2 `{v:2, salt, iter, iv, ct, hw}`, AAD `m5/user.pin/2`, KEK = `EnclavePRF` |
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

* **Politika** (`LockPolicy`, jen podepsaná — ověření `M5Crypto.SignedPolicy`: `PolicyStore.apply(answer:…)` /
  `apply(answerText:…)` s každou odpovědí serveru, nebo `adopt(policy:at:)` s politikou, kterou už ověřil
  `M5Net.DeviceState`): `biometric` required/optional/off, `pinLength` 4–12 (6), `maxAttempts` 3–20 (8), `wipe`
  (ano), `backoff` (ano), `screenshots` (ne), `autolockSeconds` 0–86 400 (60). Nepodepsaná, cizí nebo starší se ignoruje.
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

## Zámková schránka (LockInboxFiles nad M5Proto.LockInbox a M5Crypto.LockBox)

Kryptografie a formát položek jsou `M5Crypto.LockBox`, otevřená generace `M5Proto.LockInbox`, položky, `parse` a
`merge` `M5Proto.LockedRooms`; `LockInboxFiles` je jejich místo na disku. Formát **bajt po bajtu jako Android**
(`LockInboxFilesTests.testAnAndroidGenerationOpensFromTheDisk` otevře z disku generaci vyrobenou algoritmem
`LockBox.java` v node:crypto): při zámku nový pár P-256, `kid = base64url(SHA-256(SPKI))[0..16]`;
soukromý klíč (PKCS#8) zapečetěný DEK (`iv ‖ AES-GCM`, AAD `m5/lockbox/1|key|<kid>`) se zapíše do
`lockbox/<kid>.key` **dřív, než se DEK vynuluje**; v paměti zůstane jen veřejný klíč. Položka = nový efemérní klíč,
ECDH, HKDF-SHA256 (salt `m5/lockbox/1`, info `<kid>|<seq>|<SPKI eph>`), AES-256-GCM s AAD
`m5/lockbox/1|<kid>|<seq>`, řádek `{"s","e","iv","ct"}` v `lockbox/<kid>.log` (synchronizovaný zápis; useknutý řádek
se přeskočí). Druhy položek jako Android: `msg`, `state`, `pin`, `resume`, `call`, `callUri`, `file` (soubor se
přesune do `lockbox/files/<id>.part`, klíč přenosu je v položce). Log je otevřený po celou generaci
(`completeUnlessOpen`: zapisovatelný i při zamčeném telefonu, po zavření nečitelný do odemčení).

Místnosti zapisují `inbox.seal(LockedRooms.message(roomKey:…))` (a `.state`, `.pin`, `.resume`, `.call`,
`.callUri`; soubor `keepFile`). Odemčení: `beginUnlock` hned schránku uzavře a označí slučování (zámek hned poté
počká), `finishUnlock` generace (starší zámek první) otevře na pozadí vlastní kopií DEK, každou předá
`LockInboxConsumer.apply(_: LockedRooms.Parsed, inbox:)` (piny „první vítězí“, resume „poslední vítězí“) a smaže;
pak `restoreAll()`. Pád během zámku schránku nechá na disku (bez PINu nečitelnou, useknutý řádek se přeskočí)
a příští odemčení ji sloučí; generaci cizího klíče smaže. Sloučení s historií je `LockedRooms.merge`.

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
| `KeyringSigner` (`SecurityCenter.shared.signer()`) — `M5Net.RequestSigner` a `M5Crypto.DeviceSigner` | M5Net — `X-M5-Signature` a důkaz při registraci (SPKI + P1363) |
| `KeyringAgreement` (`.agreement()`) — `M5Crypto.KeyAgreer` | M5Net / Push — `Ecies.open(agreement, …)` ze serveru |
| `SecureStore` (`.secrets`, jen aplikace; `.sharedSecrets`, i rozšíření) | kdokoli s malým tajemstvím (relace účtu…) |
| `Vault` + `VaultTier` (`.vault`) | všechna úložiště (SYS: server, politika, události; USER: místnosti, zprávy, identity) |
| `FileVault` (nad `M5Proto.FileVaultFormat`) | Files, přenosy, média |
| `AppLockState` (`.lock`) | Push (příkaz `lock`), Notifications (neutrální text: `isLocked`), Renderer (`lock.now`) |
| `LockParticipant` (`.add`) | místnosti, účet, profily, kontakty, Záznam — co zámek zapomíná |
| `LockInboxFiles` + `LockInboxConsumer` (`.inbox`, `.inboxConsumer`), položky `M5Proto.LockedRooms` | místnosti — příjem po zamčení a sloučení |
| `PolicyStore.apply` / `adopt` (`.policies`) | M5Net — `policySigned` z registrace / check-inu (nebo politika z `DeviceState`) |
| `M5Net.ServerKeyPin` | registrace (pin klíče serveru — jediná implementace) |
| `IntentSealUserInfo` (nad `M5Crypto.IntentSeal`) | Notifications / Push — `room` v `userInfo` a akce odpovědi |
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
* Rozšíření notifikací (Android: jeden proces) dostane jen sdílenou skupinu Keychainu (`sys`, `enc`) a stranu
  App Group (SYS vrstva, zrcadlo zámku).
* Biometrický obal bez výzvy při zápisu; neplatnost podle `domainState`.
* Screenshoty iOS zakázat nejde: kryt v přepínači, štít při nahrávání, hlášení snímku.
* Vzdálený wipe aplikaci z přepínače neodstraní; na pozadí skončí.

## Testy (`M5cetTests/Security`, simulátor)

84 testů (formáty a kryptografie M5Kit testuje M5Kit): AES-GCM s nulovatelným klíčem = bajty `Crypto.gcmSeal`,
`SecretBytes`, PRF (`EnclavePRF`), klíče (obě cesty: Secure Enclave simulátoru i software; `RequestSigner` /
`DeviceSigner` / `KeyAgreer` + `Ecies`; co je ve sdílené skupině), obal PINu (formát `M5Crypto.PinWrap` s KEK
z enclave; jiné zařízení neotevře), trezor, čítač a pečeť (Android `LockCounterTest`, `LockStoreTest` případ po
případu včetně přerušení mezi kroky), monotonní čekání a restart, AppLock end-to-end (pokusy, čekání, wipe,
blokace, rollback, nouzový PIN, biometrie, auto-zámek, uspání, hovor, schránka, přísný režim, zrcadlo), schránka
na disku (generace Androidu z node), wipe (úplnost, obě skupiny), politika (podpis serveru z Android testu přes
`PolicyStore`), nouzový ověřovač, `IntentSealUserInfo`, FileVault (nad `FileVaultFormat`), PIN pad a okna na
scéně. Test skupin Keychainu se v nepodepsaném buildu přeskočí; s ad-hoc podpisem
(`CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual CODE_SIGNING_REQUIRED=NO`) běží i on (prefix prázdný).

## Neověřeno (potřebuje zařízení)

Biometrický klíč v Secure Enclave s `biometryCurrentSet` a jeho zneplatnění, použití SE klíčů `sys` / `enc`
z rozšíření notifikací (sdílená skupina `cz.m5cet.shared` s týmovým prefixem a profilem), `F_FULLFSYNC`
a `completeUnlessOpen` při zamčeném telefonu, délka úlohy na pozadí a uspání, `sceneCaptureState` při skutečném
nahrávání / AirPlay, doba PBKDF2 210 000 + SE na starším iPhonu.
