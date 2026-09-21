# M5cet — relace, vynucený stav, pozvánky a „Smazat vše a odejít"

Čtyři spolu související funkce z verze 2.7.0. U každé je uvedeno, co
zaručuje — a stejně otevřeně, co zaručit nemůže.

## 1. Šifrovaná session cache

**K čemu:** po obnovení stránky (reload, pád prohlížeče) se aplikace vrátí do
místnosti sama, bez nového zadávání klíče. Déle ne.

| | |
|---|---|
| Obsah | jméno, room ID, klíč místnosti (passphrase) a **požadovaný stav** |
| Životnost | do zavření karty / okna — šifrovaný záznam je v `sessionStorage`, které prohlížeč se zavřením karty zahodí. Reload přežije. |
| Nečinnost | po **1 hodině** bez aktivity uživatele (klik, klávesa, dotyk, kolečko) se cache smaže a spojení ukončí |
| Šifrování | AES-GCM 256; klíč se generuje pro každou kartu jako **neexportovatelný** `CryptoKey` a je uložen v IndexedDB (`m5cet-session`). Záznam je svázán se svým ID přes AAD. |
| Úklid | klíče po kartách zavřených před více než hodinou se mažou při dalším startu; vše maže „Smazat vše a odejít" |

Kód: `client/src/lib/session-cache.ts`, testy `test/session-cache.test.ts`.

**Co to chrání:** v `sessionStorage` je jen šifrovaný text (ověřeno testem —
jméno, room ID ani klíč v něm nejsou) a bajty obalovacího klíče skript nikdy
nedostane, ani náš. Pozměněný nebo přenesený záznam se nerozšifruje a smaže.

**Co to nechrání — a je fér to říct:**

- kód běžící v tomto originu (XSS, škodlivé rozšíření) může prohlížeč o
  rozšifrování požádat stejně jako aplikace;
- forenzní přístup k profilu prohlížeče na disku (IndexedDB si klíčový
  materiál drží ve vlastním formátu);
- do 2.6.0 se klíč místnosti **neukládal vůbec**. Jeho uložení, byť šifrované
  a jen po dobu života karty, je vědomý ústupek pohodlí. Kdo ho nechce, zavře
  kartu nebo použije „Smazat vše a odejít".

Jméno a poslední room ID se navíc (jako dřív) ukládají nešifrovaně do
`localStorage` v preferencích, aby byly předvyplněné při příští návštěvě.

## 2. Požadovaný stav: „připojen" se vynucuje

Aplikace rozlišuje, **co uživatel chce**, od toho, **co právě je**.

- **Připojit** nastaví požadovaný stav na `connected`. Aplikace se pak snaží
  spojení držet pořád: po výpadku zkouší znovu s prodlevou (exponenciální
  backoff s náhodným rozptylem, start 0,5–1,5 s podle strategie, strop 120 s).
  Pokus, který skončí výjimkou, smyčku neukončí — naplánuje se další.
- **Odpojit** nastaví `disconnected`: odpojí se od serveru i místnosti a nic
  dalšího nezkouší. Tlačítko je dostupné vždy, když je požadováno „připojen" —
  tedy i ve chvíli, kdy se spojení teprve navazuje (dřív jen po připojení).
- Po **reloadu** se aplikace podle uloženého stavu sama připojí, nebo zůstane
  odpojená (s předvyplněnými údaji — připojení je pak jeden klik, bez klíče).
- Pokusy se **logují**: *menu → Spojení → Pokusy o spojení* (čas, číslo
  pokusu, událost, prodleva do dalšího), posledních 50, jen v paměti; totéž
  jde do konzole s prefixem `[m5cet]`.

„Odpojit" se zapisuje **synchronně**: reload hned po kliknutí už najde
`disconnected`, i když šifrované uložení teprve dobíhá. Tento nešifrovaný
příznak umí stav jen *snížit* na „odpojen" — jeho podvržením nejde připojení
vynutit (hlídá test).

## 3. Pozvánka odkazem + 12místný kód

*Místnost → Sdílet* vytvoří **jedinečný odkaz** a k němu **kód
`XXXX-XXXX-XXXX`**. Každý nový odkaz má nové ID, nový klíč i nový kód.

```
https://chat.example/#j=<id>.<klíč odkazu>          + kód 1808-1477-0861
```

Odkaz nese (zašifrovaně) room ID, klíč místnosti a náhodné jméno pro hosta
(např. `bystry-sokol-42`). Lze zvolit **počet připojení** (1–25) a **platnost**
(1 h / 24 h / 7 dní) a odkaz kdykoli **zneplatnit**.

### Proč je u toho server

12 číslic je jen ~40 bitů. Kdyby odkaz obsahoval vše potřebné k rozšifrování,
šel by kód zkoušet offline. Proto je klíč **rozdělen na tři části**:

| Část | Kde je | Kdo ji nikdy nevidí |
|---|---|---|
| `linkKey` (32 B) | jen ve fragmentu URL za `#` | server, crawleři, náhledové roboty |
| `serverKey` (32 B) | v paměti serveru | ten, kdo má jen odkaz |
| kód (12 číslic) | u odesílatele; předává se **jinou cestou** | server zná jen otisk důkazu |

Klíč k datům = `HKDF(linkKey ‖ serverKey ‖ PBKDF2(kód))`. Server `serverKey`
vydá jen tomu, kdo předloží správný důkaz znalosti kódu, a hlídá:

- **5 špatných kódů → odkaz se zničí** (žádné neomezené hádání),
- **X úspěšných použití → odkaz zaniká**,
- vypršení platnosti; neznámé, vadné i prošlé ID odpovídají stejně (`404`).

Důsledky: kdo získá **jen odkaz**, nemá `serverKey` a na kód má 5 pokusů
z 10¹². Kdo ovládne **jen server**, nemá `linkKey`, takže uložená data
nerozšifruje. Nebezpečná je až kombinace odkaz + kód (proto je posílejte
každý jinudy) nebo odkaz + kompromitovaný server.

### Odolnost proti robotům a náhledům

- Vše tajné je ve **fragmentu** (`#…`), který prohlížeč serverům neposílá.
  Robot messengeru, který si stahuje náhled, si vyžádá jen `/` a dostane
  obecnou stránku s `noindex`.
- Použití se počítá výhradně při **`POST` se správným kódem**. `GET` od
  crawleru nic nespotřebuje ani nespálí pokus (ověřeno e2e testem).
- Příjemci se odkaz **okamžitě smaže z adresního řádku** (`replaceState`),
  takže `linkKey` nezůstane v historii karty ani v tom, co z ní kdo zkopíruje.

### Sdílení

Ikonový panel: WhatsApp, Telegram, Viber, Messenger, iMessage, SMS, e-mail,
QR kód, kopírování a **Další…** (systémový dialog sdílení). Signal nemá URL
schéma pro předvyplněný text, proto používá systémový dialog, případně
zkopíruje odkaz. Těmito kanály jde **jen odkaz, nikdy kód**. QR se generuje
lokálně (knihovna `uqr`, načtená až na vyžádání), žádná externí služba.

### Omezení

- Pozvánky žijí **v paměti serveru** — restart serveru zneplatní všechny.
- „Připojení" = úspěšné vyzvednutí pozvánky. Kdo ji vyzvedl, zná klíč
  místnosti a může se připojovat znovu; pro odebrání přístupu změňte klíč.
- Limit vytváření kryje jen obecný REST limiter (100 / 15 min na IP) a strop
  2 000 současných pozvánek.

Kód: `client/src/lib/share-link.ts`, `client/src/components/SharePanel.tsx`,
`server/share.ts`; testy `test/share-link.test.ts`, `test/share-store.test.ts`,
`test/e2e/session-share.test.ts`.

## 4. „Smazat vše a odejít" (Clear & Quit)

Zvýrazněné tlačítko na konci menu. Po potvrzení:

1. odpojí se a smaže session cache i její klíč,
2. požádá server o smazání dat zařízení (`POST /api/audit/purge`),
3. zruší push subskripci, odregistruje service worker,
4. smaže Cache Storage, **všechny** IndexedDB databáze, `localStorage`,
   `sessionStorage` a skriptem dosažitelné cookies,
5. přejde přes `location.replace()` na `/goodbye`, kde server pošle
   `Clear-Site-Data: "cache", "cookies", "storage", "executionContexts"` —
   tím zmizí i HttpOnly cookies a HTTP cache, na které skript nedosáhne.

Ověřeno v prohlížeči: po akci je `localStorage`, `sessionStorage`, cookies,
IndexedDB, Cache Storage i seznam service workerů prázdný a tlačítko Zpět do
chatu nevede.

**Co web udělat nemůže:** smazat záznamy z **historie prohlížeče**. Žádné API
na to neexistuje. Aplikace jen historii „nekrmí" (tajemství pozvánky je ve
fragmentu a hned se maže; odchod nahrazuje aktuální záznam). Řádek o návštěvě
webu odstraníte v nastavení prohlížeče (Ctrl/Cmd + Shift + Delete); příště
použijte anonymní okno. `Clear-Site-Data` vyžaduje HTTPS (nebo `localhost`).
