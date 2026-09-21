# M5cet — pracovní poznámky (větev `empero-ai-updates`)

**Aktualizováno:** 2026-09-21 · **Verze:** 2.5.0

> ⚠️ **Oprava záznamu.** Předchozí obsah tohoto souboru tvrdil, že byl
> optimalizován „MODUL 1: CORE" (`server/index.ts`, `routes.ts`, `util.ts`,
> `events.ts`) s úsporou ~15 % CPU a ~8 % rychlejším handshakem. Tyto soubory
> byly přitom shodné s `master` — žádná taková změna ani měření neexistovaly.
> Zmiňované `.memory/INDEX.md` a `.memory/00000N.md` také nikdy nevznikly.
> Plánované „WebAssembly fallback pro PBKDF2" a „per-peer nonce caching"
> byly zahozeny: WebCrypto PBKDF2 je nativní a cachování nonce je u AES-GCM
> bezpečnostní chyba (IV se nesmí opakovat ani odvozovat z cache).

## Kde hledat pravdu

| Co                         | Kde                                              |
|----------------------------|--------------------------------------------------|
| Aktuální stav a TODO       | [`../PROGRESS.md`](../PROGRESS.md)               |
| Co se změnilo a proč       | [`../CHANGELOG.md`](../CHANGELOG.md) § 2.5.0     |
| Změřené optimalizace       | [`../CLIENT_OPTIMIZATIONS.md`](../CLIENT_OPTIMIZATIONS.md) |
| Postup práce               | [`../WORKFLOW.md`](../WORKFLOW.md)               |
| Mapa kódu                  | [`../KNOWLEDGE_BASE.md`](../KNOWLEDGE_BASE.md)   |

## Poučení pro příští session (člověk i AI)

1. **Nejdřív baseline.** Před jakoukoli úpravou spustit `npm run check`,
   `npm test`, `npm run build` a zapsat výsledek. Bez toho nejde poznat,
   co jsi rozbil ty a co bylo rozbité už předtím.
2. **„Hotovo" znamená ověřeno příkazem**, jehož výstup jsi viděl. Ne
   „napsal jsem kód, který by měl fungovat".
3. **Žádná čísla bez měření.** Pokud benchmark neproběhl, napiš „neměřeno".
4. **Porovnávej s `master`:** `git diff --stat master HEAD` během vteřiny
   ukáže, které soubory se opravdu změnily.
5. **Krypto neoptimalizovat naslepo.** Kontrakt `lib/crypto.ts` hlídají testy
   wire formátu; obálka je přesně `{ iv, ciphertext }`, IV je 12 náhodných
   bajtů na každý rámec, klíč je PBKDF2-SHA256 × 250 000 se solí
   `CipherRoom:v1:<room>`.
6. **Dokumentace není zdroj pravdy o kódu** — a ukázky kódu v ní už vůbec ne.
