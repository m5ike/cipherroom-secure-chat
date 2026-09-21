# M5cet — režimy: Light / P2P a Server-enhanced

M5cet má dva provozní režimy. Důležité je hned na začátku říct, čím **nejsou**:

- **Nejsou to dvě různé aplikace ani dva různé servery.** Běží tentýž klient
  proti témuž serveru (`dist/index.cjs`). Instalace je pro oba režimy stejná.
- **Režim je předvolba v prohlížeči**, ne nastavení serveru. Každý účastník
  si ho volí sám v dialogu *Připojit* (přepínač *Light / P2P* ×
  *Server-enhanced*); v jedné místnosti se oba režimy mohou potkat.
- **Šifrování ani přenos zpráv se mezi režimy neliší.** Zprávy i soubory jdou
  vždy přímo mezi prohlížeči přes WebRTC DataChannel, šifrované AES-GCM 256
  klíčem odvozeným z passphrase. Server je v obou režimech jen signalizační.

Server k tomu říká, co *umí nabídnout* (`GET /api/modules`), a klient podle
zvoleného režimu rozhodne, co z toho *použije*.

## Srovnání

| | **Light / P2P** (výchozí) | **Server-enhanced** |
|---|---|---|
| Text, soubory, hovory, poloha, NFC, TTS/STT | ano | ano |
| Signalizace přes `WSS /ws` | ano | ano |
| TURN relay (je-li na serveru nastaven) | ano | ano |
| Service worker `sw.js` | **neregistruje se** | registruje se |
| Web Push (upozornění, i když je karta zavřená) | ne — jen lokální notifikace v otevřené kartě | ano, pokud má server VAPID klíče |
| Dotaz na `GET /api/push/status` po startu | ne | ano |
| Událost `client-join` na `POST /api/events` | ne | jen se souhlasem *Analytika* **a** `LOG_EVENTS=1` na serveru |
| Co se o vás dozví server navíc | nic | push subskripci (endpoint prohlížeče + klíče) a případně metadata připojení |

Light je tedy „nejmenší možná stopa": server vidí jen to, co vidět musí
(IP adresu, room ID, peer ID, jméno, SDP/ICE). Server-enhanced přidává
pohodlí — hlavně probuzení zavřené karty přes push — za cenu toho, že server
drží vaši push subskripci.

## Co režim přepíná v kódu

Přesně tři místa v `client/src/App.tsx`, všechna čtou `prefs.mode`:

1. **Push + service worker** — efekt po startu: v režimu `server` zavolá
   `fetchPushStatus()` a `ensureServiceWorker()`; v `light` neudělá nic.
2. **Analytická událost při připojení** — po rámci `joined` pošle
   `POST /api/events { kind: "client-join" }`, jen když `mode === "server"`
   **a** `analyticsConsent === true`.
3. **Panel Soubory** dostává `enabled={prefs.mode === "server"}`, ale hodnotu
   nepoužívá — chunked přenos funguje v obou režimech stejně.

Nic dalšího se neliší. Zejména: režim *nemění* trasu zpráv, sílu šifrování ani
to, zda server vidí obsah (nevidí nikdy).

## Konfigurace

### Klient (v prohlížeči, `localStorage`)

Klíč `m5cet:prefs:v2` (`client/src/lib/preferences.ts`). S režimem souvisí:

| Pole | Výchozí | Význam |
|---|---|---|
| `mode` | `"light"` | `"light"` nebo `"server"` |
| `notificationsEnabled` | `false` | uživatel povolil notifikace |
| `analyticsConsent` | `false` | souhlas s odesláním `client-join` (jen v režimu `server`) |
| `deviceId` | náhodných 16 B hex | identifikátor prohlížeče pro push subskripci a `/api/audit/purge` |

ID push subskripce je v `localStorage["m5cet:push:id"]`. Vše smaže
*Soukromí & audit → Smazat lokální preference*; serverovou část (push
subskripce, settings, consent) smaže *Smazat serverové logy a sync data*
(`POST /api/audit/purge`).

### Server (`.env`, viz `install.sh --list-params`)

Light režim nepotřebuje nic nad rámec základní instalace. Server-enhanced
funkce se zapínají těmito proměnnými:

| Proměnná | Výchozí | K čemu |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | prázdné | zapnou Web Push. Instalátor je vygeneruje s `--enable-push`. **Privátní klíč zůstává na serveru**, klient dostává jen veřejný. |
| `VAPID_SUBJECT` | `mailto:admin@example.org` | kontakt pro provozovatele push služby |
| `LOG_EVENTS` | `0` | `1` zapne příjem a čtení metadat (`/api/events`, `/api/events/recent`); ring 500 záznamů v paměti, nikdy obsah zpráv |
| `DATABASE_URL` | prázdné | zatím jen změní štítek backendu; do DB se nezapisuje |
| `*_RETENTION_DAYS` | 30/60/90/7/30 | retence settings / auditu / push / událostí |

Bez VAPID klíčů se Server-enhanced chová skoro jako Light: klient zjistí
`enabled: false` a použije lokální notifikace.

### Soubory, které se režimu týkají

| Soubor | Role |
|---|---|
| `client/public/sw.js` | service worker: `push`, `notificationclick`, testovací `message`. Bez `fetch` handleru a bez cache. Registruje se jen v režimu `server`. |
| `client/public/manifest.webmanifest` | PWA manifest (na iOS je instalace PWA podmínkou pro push) |
| `client/src/lib/push.ts` | `fetchPushStatus`, `subscribeToPush`, `sendTestPush`, lokální testovací notifikace |
| `server/push.ts` | odesílání přes `web-push` (líné načtení), čte VAPID proměnné |
| `server/events.ts` | event ring; zapíná ho `LOG_EVENTS=1` |
| `server/modules.ts` | manifest `GET /api/modules` — popisuje oba režimy a dostupné funkce |
| `<instalace>/.env` | serverové proměnné výše (práva `0600`) |

## Používá se Firebase?

**V hlavní aplikaci ne.** V `client/`, `server/`, instalátoru ani
v `package.json` není na Firebase jediný odkaz; signalizaci obstarává vlastní
server přes WebSocket `/ws`.

Firebase používá pouze **samostatná varianta** v adresáři
[`browser-only-firebase/`](../browser-only-firebase/README.md)
(„CipherRoom Lite"): tři statické soubory (`index.html`, `app.js`,
`styles.css`), které nepotřebují žádný vlastní server a jako signalizaci
používají Firebase Realtime Database. S hlavní aplikací nesdílí kód, build ani
instalátor; do Docker image se nekopíruje. Pozor na záměnu názvů: tamní
„Lite" **není** zdejší režim „Light".

| | M5cet režim Light | M5cet režim Server-enhanced | `browser-only-firebase/` |
|---|---|---|---|
| Signalizace | vlastní server, `WSS /ws` | vlastní server, `WSS /ws` | Firebase Realtime Database |
| Potřebuje server | ano (Node) | ano (Node) | ne, jen statický hosting |
| Web Push | ne | ano | ne |
| Soubory, hovory, NFC, TTS | ano | ano | jen text |
| Instaluje `install.sh` | ano | ano | ne |

## Doporučení

- **Výchozí volba je Light.** Pro běžný chat, soubory i hovory stačí a nechává
  na serveru nejmenší stopu.
- **Server-enhanced zapněte, když potřebujete push** — typicky na mobilu, kde
  systém kartu v pozadí uspí a WebSocket zavře (viz
  [`browser-limitations.md`](browser-limitations.md)). Na serveru k tomu
  spusťte `update.sh --set ENABLE_PUSH=1`.
- Metadata (`LOG_EVENTS`) nechte vypnutá, pokud je nevyžaduje compliance.
