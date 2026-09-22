# Pozastavení stránky, oznámení a fronta zpráv

Tři věci, které spolu souvisí a přišly v 2.11.0:

1. **hooky na pozastavení a probuzení** okna aplikace,
2. **systémové zprávy mimo chat** — jako flash oznámení nahoře,
3. **lokální fronta** zpráv pro light režim, když příjemce není online.

Kód: [`client/src/lib/lifecycle.ts`](../client/src/lib/lifecycle.ts),
[`flash.ts`](../client/src/lib/flash.ts), [`outbox.ts`](../client/src/lib/outbox.ts),
[`components/FlashMessages.tsx`](../client/src/components/FlashMessages.tsx).

---

## 1. Kdy prohlížeč stránku odloží a kdy ji vrátí

Přepnutí na jinou záložku není jedna událost. Podle prohlížeče a systému
může stránka jen zeslábnout, zamrznout, jít do back/forward cache, nebo se
rovnou zahodit a později postavit znovu. Modul `lifecycle.ts` poslouchá
**všechny** a hlásí místo nich jen dvě věci: *pozastaveno* a *obnoveno*.

| Událost | Co znamená |
| --- | --- |
| `visibilitychange` | záložka šla na pozadí (nebo se vrátila) |
| `blur` / `focus` | okno ztratilo klávesnici — uživatel přepnul na jinou aplikaci |
| `freeze` / `resume` | Page Lifecycle: prohlížeč nás přestal spouštět |
| `pagehide` / `pageshow` | navigace a back/forward cache (`persisted`) |
| `online` / `offline` | síť |
| `document.wasDiscarded` | stránku zahodil a staví ji znovu |

**Odklady** dávají smysl: přeblik na jinou záložku na dvě vteřiny není
„away" (čeká se 1,5 s), přepnutí do jiné aplikace se hlásí až po 30 s, ale
`freeze` a `pagehide` se hlásí okamžitě — druhá šance nemusí přijít.

### Co se stane při pozastavení

- uloží se chat (podle zvoleného režimu, viz [`accounts-away.md`](accounts-away.md)),
- zapamatuje se, jestli **měl** být chat připojený a v jaké místnosti,
- u **server-enhanced + přihlášeného** uživatele jde na server rámec
  `{"type":"presence","away":true}` — server od té chvíle zprávy pro tohoto
  uživatele **přebírá a drží**, i když socket ještě žije (pozastavená
  stránka nemusí spustit vůbec nic),
- ostatní v místnosti dostanou `peer-away`.

### Co se stane při probuzení

- pokud měl být chat připojený a socket nepřežil → znovu se připojí do
  stejné místnosti,
- pokud socket žije → jde `{"type":"presence","away":false}`, server pošle
  `presence-ack` a hned za ním **všechno, co mezitím nasbíral**
  (`relay-deliver`); klient to dešifruje, potvrdí (`relay-ack`) a odesílatelé
  vidí *doručeno*,
- účet se znovu ohlásí, rozběhne se heartbeat, **je to stále totéž sezení** —
  data ani nastavení se nezahazují,
- v light režimu se zkusí odeslat vše, co čeká ve frontě.

Když prohlížeč stránku zahodil (`wasDiscarded`), neopravuje se nic ručně:
sezení se obnoví ze šifrované session cache jako po reloadu.

---

## 2. Systémové zprávy: flash oznámení

**Výchozí chování se změnilo.** V chatu je nově jen to, co si lidé napsali.
Systémová hlášení (připojeno, přenos dokončen, chyba dešifrování…) se
zobrazují jako **flash oznámení** nahoře:

- vždy **jedna zpráva** naráz, ostatní čekají ve frontě,
- maximálně **dva řádky**, šířka podle obsahu a displeje,
- **fade-in**, drží se nastavený čas (výchozí **10 s**), pak **fade-out**,
- **kliknutím** se zavře dřív a hned naskočí další z fronty,
- vpravo je počet čekajících (`+3`).

V *Vzhled → Zobrazení → Oznámení* jde nastavit: zapnout/vypnout, jak dlouho
zůstanou (3–60 s), umístění (nahoře vlevo/uprostřed/vpravo), animace
(prolnutí / sjetí / žádná), ikona podle typu, velikost písma, zaoblení,
barva pozadí a textu, písmo. A přepínač **„Systémové zprávy i v chatu"**,
který je zapíše navíc i do konverzace v časové posloupnosti.

Typ oznámení (barva a ikona) se odvodí z textu — chyba, varování, úspěch,
systém (`kindForText`).

---

## 3. Fronta pro light režim

V light režimu není server, který by zprávu podržel. Když v okamžiku
odeslání není otevřený žádný datový kanál, zpráva **nezmizí ani neselže**:
uloží se do fronty (`outbox.ts`) už zašifrovaná a bublina dostane příznak
**odesílá se** — světlejší, čárkované pozadí a ikona šipky.

Znovu se zkouší:

- jakmile se otevře kanál k nějakému protějšku,
- při probuzení stránky,
- jednou za minutu, dokud stránka běží.

Limity: 200 zpráv, 60 pokusů na zprávu, 24 hodin, a zpráva s vlastní
expirací (TTL) se po vypršení zahodí. Jakmile projde, audit se přepíše na
*odesláno* a bublina zešedne do normálu.

---

## 4. Dá se prohlížeč donutit „tikat" na pozadí?

Krátká odpověď: **částečně, a na zamrzlou stránku vůbec.** Co skutečně
platí:

| Stav stránky | Co běží |
| --- | --- |
| viditelná | všechno normálně |
| **skrytá** (jiná záložka) | časovače zpomalené na ~**1× za minutu**; WebSocket zprávy pořád chodí |
| **zamrzlá** (`freeze`) | **nic** — žádný časovač, žádný worker |
| **zahozená** (discarded) | stránka neexistuje, jen záznam v seznamu záložek |

Proto aplikace kombinuje tři věci:

1. **`startBackgroundTick`** — tik jednou za minutu, prioritně z **Web
   Workeru** (drží pravidelnější rytmus než časovač stránky), jinak
   `setInterval`. Slouží k tomu, aby si skrytá stránka všimla mrtvého
   socketu a zkusila odeslat frontu. Worker není nesmrtelnost: je škrcený
   se stránkou, která ho vlastní.
2. **Události životního cyklu** — nejspolehlivější „tik" je okamžik, kdy se
   uživatel vrátí; tam se dohání všechno.
3. **Web Push přes service worker** — jediná cesta, která funguje i pro
   zamrzlou nebo zavřenou stránku. Server tak budí prohlížeč, když pro
   uživatele ve stavu away něco přijde ([`accounts-away.md`](accounts-away.md)).

Co **nefunguje** jako obecný tik, ač se to nabízí:

- `Periodic Background Sync` — jen Chrome/Android, jen instalovaná PWA,
  nejkratší interval v řádu **hodin** a podle „engagement score";
- `Background Sync` (jednorázový) — spustí se až při obnovení konektivity;
- `Wake Lock` — drží rozsvícený displej, se škrcením časovačů nedělá nic;
- přehrávání tichého zvuku, které stránku udrží „aktivní" — funguje, ale je
  to zneužití: žere baterii, v některých prohlížečích vyžaduje gesto a
  uživateli se zobrazí indikátor přehrávání. Záměrně to neděláme.
