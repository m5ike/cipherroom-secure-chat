# M5cet — konzole Telephony & SIP (6.9)

Stránka **Administrace → Tools → Telephony & SIP** spravuje celý telefonní
modul: poskytovatele, oprávnění, směrování odchozích a příchozích hovorů,
aplikace hovorů (TSA), směrovací kódy do místností, SIP trunky, testy a
záznam událostí. Nahrazuje starý panel (`legacy-tools.js` a
`telephony-sdk.js`, oba odstraněny).

Kód: `admin-ui/public/telephony-console.js` + `telephony-console.css`.
Stránka staví DOM jen přes pomocníky konzole (`window.M5Console.h()`), nikdy
přes `innerHTML`; skripty jen z vlastního původu (CSP `script-src 'self'`).
Mluví s admin službou na `/admin/telephony/…` (kontrakt:
`server/telephony/control/api-contract.ts`) a pro hovory s hlavní službou na
`/api/admin/telephony/sdk`.

## Navigace a odkazy

Stránka má vlastní záložky (šipky ←/→, Home/End přepínají). Každá záložka má
adresu, kterou jde poslat kolegovi:

| Adresa | Co otevře |
|---|---|
| `#/telephony/overview` | Přehled |
| `#/telephony/log/<id>` | Záznam s otevřeným detailem události |
| `#/telephony/calls/<id>` | Hovor s jeho událostmi |
| `#/telephony/inbound/<pravidlo>` · `#/telephony/outbound/<pravidlo>` | Editor pravidla |

Detail se zavírá klávesou **Esc**; fokus zůstává uvnitř šuplíku a po zavření
se vrátí tam, odkud jste přišli.

## Práva

Čtení stačí mít modul (Modules & groups › Telephony & SIP). Změna potřebuje
roli **operator** a k ní právo modulu:

| Právo | Co odemyká |
|---|---|
| `settings` | výchozí poskytovatelé, webhooky, oprávnění, SIP trunky, směrovací kódy, mazání záznamu |
| `routing` | příchozí a odchozí pravidla |
| `tsa` | aplikace (vytvořit, uložit, publikovat, duplikovat, import, smazat) |
| `test` | testy (poskytovatel, webhook, hovor, SMS, hlas do místnosti, testovací SIP adresa) |
| `log` | plný detail události (rozparsovaná data a surový payload) |

Bez práva jsou ovládací prvky zašedlé a v bublině říkají, které právo chybí.
Auditor všechno vidí, nic nemění. Suché běhy (test pravidel) jsou čtení —
smí je každý, kdo stránku vidí.

## 1. Overview — přehled

* **Čísla**: příchozí a odchozí pravidla, aplikace (publikované / koncepty),
  živé hovory, živé směrovací kódy, události a chyby dnes. Klik na dlaždici
  otevře příslušnou záložku.
* **Poskytovatelé**: co který umí a co má nastavené; zda nese hovory přes
  svou **aplikaci** (API klíč a secret ze serveru) a přes **SIP trunk**.
* **Veřejná adresa a webhooky**: `PUBLIC_BASE_URL` a u každého poskytovatele,
  zda se kontroluje podpis webhooků.
* **K opravě**: varování serveru a to, co stránka vidí sama — modul vypnutý,
  chybí `PUBLIC_BASE_URL`, nepodepsané webhooky, nastavení jen v paměti,
  žádné zapnuté příchozí pravidlo, pravidlo spouští nepublikovanou nebo
  neexistující aplikaci, pravidlo používá smazaný trunk. Každé má návod a
  tlačítko na místo, kde se to opraví.

Když admin služba ještě nemá `GET /admin/telephony/overview` (starší build),
stránka přehled poskládá z ostatních odpovědí a řekne to.

## 2. Providers — poskytovatelé

* **Default providers**: kdo posílá SMS a kdo volá, když nerozhodne nic jiného
  (požadavek → tato volba → `SMS_PROVIDER` / `VOICE_PROVIDER` → první
  nastavený). Odchozí pravidla rozhodují hovory dřív než jakýkoli default.
* U každého poskytovatele tabulka **schopností**: nastaveno / chybí a
  **jména** proměnných prostředí, které potřebuje (hodnoty nikdy). Chybějící
  proměnné patří do `.env` serveru, ne do konzole.
* **Webhooky**: URL (kopírovat), stav kontroly podpisu a **Install in …** —
  jedním klikem zapíše URL do účtu poskytovatele (vyžaduje `PUBLIC_BASE_URL`).
* **Test the provider**: přihlašovací údaje, odpověď API (čtení účtu / zůstatku),
  vlastněná čísla, nainstalované webhooky — jako kontrolní seznam ✓ / ✗ / –.

## 3. Permissions — oprávnění

Limity a výchozí chování modulu pro všechny (nad rámec Modules & groups):

* **Outbound**: země (ISO 3166, prázdné = všechny), nikdy nevolaná čísla
  (prémiová, satelitní…; pravidlo je nepřebije), souběžné hovory, hovory a SMS
  na volajícího za hodinu, nejdelší hovor.
* **Inbound**: souběžné hovory, hovory z jednoho čísla za hodinu (pak „busy“).
* **Route codes**: nejdelší platnost kódu, živé kódy na vlastníka, chybné
  kódy za hovor a za volajícího za hodinu.
* **Applications (TSA)**: hosty, kam smí nástroj HTTP (prázdné = nástroj
  vypnutý), zda smí spouštět modely Functions, jak dlouho se drží nahrávky.
* **Event log**: retence a zda držet surový payload (bez tajemství).
* **Defaults**: co se stane s hovorem, který nechytilo žádné pravidlo —
  příchozí: aplikace nebo stav; odchozí: „pass“, stav nebo aplikace.

Hodnoty se kontrolují už ve formuláři (neplatné země, vzory, hosty jsou
červené a uložení odmítne), server je kontroluje a ořezává znovu. **Defaults**
vloží výchozí hodnoty do formuláře (uloží se až tlačítkem Save).
Pod formulářem je jen ke čtení přehled **skupin a jejich práv** v modulu s
odkazem do Modules & groups.

## 4. a 5. Outbound / Inbound routing — pravidla

Seznam v pořadí priority (první zapnuté, které sedí, vyhrává):

* **Přeřazení**: táhnout řádek, nebo šipky ↑ ↓, nebo **Alt+↑ / Alt+↓** na
  řádku s fokusem. **Zapnout/vypnout** přepínačem, **duplikovat** (kopie je
  vypnutá), **smazat**. Každá změna se hned uloží (`PUT /admin/telephony/rules/<směr>`,
  priority 10, 20, 30…); když ji server odmítne, seznam se vrátí a ukáže se proč.
* **Editor** (klik na řádek / Enter):
  * **Match** — příchozí: volané číslo (DID) nebo SIP URI, volající,
    poskytovatel, služba (aplikace / SIP trunk); odchozí: cíl, skupiny
    volajícího, co hovor zakládá (Functions, aplikace, konzole, API).
    Vzory jako „čipy“: `+420212345678` přesně, `+4202*` předvolba, `*` cokoli,
    `sip:*@pbx.example.com` SIP URI, úvodní `-` = NE (zákaz vyhrává).
    Neplatný vzor je červený s vysvětlením. **Časové okno**: zóna, dny
    (`mon-fri`, `sat,sun`…), od–do (i přes půlnoc).
  * **Service** (odchozí) — **aplikace poskytovatele**: používá jeho API klíč a
    secret z prostředí serveru (v pravidle není nic tajného; ukáže, zda je
    poskytovatel pro hovory nastavený a které proměnné čte), nebo **SIP trunk**:
    poskytovatel, který trunk vytáčí, trunk ze seznamu a vlastní **caller ID** —
    číslo (E.164; prázdné = trunku), jméno, zobrazení (zobrazit / skrýt).
  * **Target** — spustit **aplikaci** (TSA; varuje, když není publikovaná),
    odpovědět **stavem** (`busy`, `congestion`, `hangup`, `rejected`), nebo
    u odchozích **pass** (hovor jde tak, jak ho volající zadal).
  * **Record** (příchozí) — nahrát celý hovor; **Note** — poznámka.
  * Uložení nejdřív zkontroluje formulář (jméno, vzory, okno, trunk, caller ID,
    aplikace) a označí chybná pole; teprve pak se ptá serveru.
* **Test a call**: suchý běh proti uloženým pravidlům — které pravidlo by
  hovor vzalo, proč (důvody v pořadí), co by se stalo, a u testovacího
  endpointu i co by dostal poskytovatel (TwiML / NCCO / příkazy). Vyhrávající
  pravidlo se v seznamu zvýrazní. Nic se nevytáčí, nic se neplatí.

## 6. Applications (TSA)

Seznam aplikací hovorů: jméno, id, štítky, stav (publikovaná vN / jen
koncept), **která pravidla ji používají** (odkaz na pravidlo), počet uzlů,
poslední změna.

* **New application** — prázdná (Start + Hangup) nebo ze šablony: *IVR menu*,
  *Route code*, *Voicemail*, *Opening hours*; po vytvoření se otevře editor.
* **Open** — vizuální editor (`tsa-editor.js`, `window.M5TsaEditor.open(id)`);
  načte se při první potřebě. Když chybí, stránka to řekne — seznam,
  publikování, export a import fungují i bez něj.
* **Publish** (návrh bez chyb → verze + 1), **Duplicate**, **Export** (soubor
  `<id>.tsa.json`), **Import** (JSON soubor), **Delete** — zakázané, dokud
  aplikaci používá nějaké pravidlo (bublina řekne které).

## 7. Route codes — směrovací kódy

Živá tabulka `m5.telephony.inroute`: kód, kam (celá místnost / jeden člen),
slepé id místnosti, člen, popisek, kdo kód vytvořil, **odpočet platnosti**
(živě; poslední minuta žlutě, prošlé šedě), použití / maximum, smazání.

**Add a code (tests)** přidá kód z konzole (typ, místnost, člen, vlastní
kód 4–6 číslic nebo náhodný, platnost do limitu z Permissions, popisek,
maximum použití). Karta pod tím vysvětluje `m5.telephony.inroute.add` —
jak kód vyrobí funkce a jak volající přes aplikaci s *Route audio* propojí
hlas do místnosti.

## 8. SIP trunks

Trunky operátora: host:port, autentizace (heslo se uloží a už nikdy neukáže —
prázdné pole ho při úpravě ponechá), registrace, DID, výchozí caller ID,
**která odchozí pravidla trunk používají**, zdroj (konzole / `.env` jen ke
čtení). Přidat, upravit, smazat. **DID → trunk**: přes který trunk číslo
přichází a které příchozí pravidlo by hovor vzalo.

## 9. Tests — testy

* **Provider** — kontrolní seznam poskytovatele (zdarma).
* **Webhook self-test** — podepsaná syntetická událost na `/wh/…` hlavní
  služby; ověří `PUBLIC_BASE_URL`, proxy a kontrolu podpisu (zdarma).
* **Route dry run** — libovolný směr; rozhodnutí, důvody a co by dostal
  poskytovatel.
* **Test call** — skutečný (placený) hovor přes odchozí pravidla: řekne text
  nebo spustí publikovanou aplikaci; odkaz na jeho události v záznamu.
* **Test SMS** — skutečná SMS (počítadlo znaků a částí).
* **Voice into a room** — slepé id místnosti (a člen) → **kód a číslo**, se
  kroky: zavolat, zadat kód a #, mluvit; odpočet platnosti.
* **Test inbound SIP address** — SIP URI, na které jde zavolat z jakéhokoli
  SIP telefonu či softphonu (Linphone, Zoiper, MicroSIP) a vyzkoušet příchozí
  pravidla a aplikaci bez kupování čísla. Ukazuje URI (kopírovat), DID, za
  který se hovor vydává, poskytovatele, nastavení u něj, případné přihlašovací
  jméno; **Create / Rotate / Remove**; návod pro softphone a tlačítko „co by
  hovor spustil“ (suchý běh pro ten DID).

## 10. Calls & sessions

Co dřív ukazoval panel `m5.telephony`: hovory (klik → detail s událostmi,
handlery a logem, odkaz na jeho události v záznamu), telefonní most —
půjčená čísla (s tlačítkem **Release**), zprávy a starší log funkcí.

## 11. Log — záznam událostí

Hustá tabulka: čas, úroveň, druh (`webhook`, `call`, `sms`, `tsa`, `route`,
`inroute`, `test`, `config`, `sip`), poskytovatel, směr, shrnutí, hovor,
HTTP (metoda, status, ms), podpis (✓ ověřen / ✗ neověřen / – bez kontroly).
Chyby a varování mají barevný okraj.

* **Filtry**: druh, poskytovatel, úroveň, id hovoru, fulltext, časové
  rozmezí; **Auto-refresh** (5 s, nové řádky problikne), **Load older**
  (stránkování), **Clear the log** (právo settings; zapíše se do auditu).
* **Klik na řádek** otevře celý záznam: shrnutí, odznaky, HTTP, ověření
  podpisu, odkazy (otevřít hovor, všechny události hovoru, běh aplikace,
  pravidlo), **rozparsovaná data jako sbalitelný JSON strom** (Expand all /
  Collapse all / Copy JSON) a **surový payload** poskytovatele bez tajemství
  (nebo informace, že se nedrží — Permissions › Event log). Kopírovat jde celá
  událost i odkaz na ni.
* Bez práva `log` detail ukáže jen shrnutí z tabulky a řekne proč.

## Endpointy

Nové (kontrakt 6.9): `overview`, `permissions`, `rules` (+ `rules/test`),
`tsa…`, `inroute…`, `log…`, `tests/provider|webhook|route|call|sms|room-voice|sip-address`
pod `/admin/telephony/`. Starší, které stránka dál používá: `GET /admin/telephony`
(poskytovatelé, defaulty, webhooky, perzistence), `PUT /admin/telephony/settings`,
`POST /admin/telephony/webhooks/install`, `GET|PUT|DELETE /admin/telephony/sip/trunks`,
`POST /admin/telephony/sip/route`, `GET /api/admin/telephony/sdk…` (hovory, most).

Odpověď, kterou admin služba ještě nezná (404), stránka ukáže jako „není
na tomto serveru zatím k dispozici“ — ostatní záložky fungují dál.
