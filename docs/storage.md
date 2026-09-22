# Serverové úložiště

Od 2.10.0 má server vlastní úložiště: **jednu obyčejnou SQLite databázi pro
sebe** a **jednu šifrovanou SQLCipher databázi pro každého uživatele** (nebo
pro každou anonymní relaci). Kód je v [`server/storage/`](../server/storage),
klient v [`client/src/lib/storage-client.ts`](../client/src/lib/storage-client.ts).

```
$DATA_DIR/storage/
├── m5cet.db          globální databáze (nešifrovaná, viz níže co v ní je)
├── storage.key       master klíč, 0600 — jen když není STORAGE_MASTER_KEY
└── db/
    ├── db-<id>.db    databáze uživatele  (SQLCipher, klíč z passkey)
    └── db-<id>.db    databáze relace     (SQLCipher, klíč od serveru, TTL 1 den)
```

## Dva druhy klíče

| | přihlášený uživatel | relace bez passkey |
| --- | --- | --- |
| režim klíče | `prf` | `wrapped` |
| kdo klíč vyrobí | prohlížeč z passkey (WebAuthn PRF → HKDF) | server (32 náhodných bajtů) |
| kde klíč leží | jen v paměti serveru po dobu sezení | zabalený master klíčem v indexu |
| životnost dat | do smazání uživatelem | **1 den** (prodlužuje se při použití) |
| co uvidí server | data, dokud má klíč v paměti | data kdykoli |

Přihlášený uživatel posílá **jiný klíč**, než kterým se pečetí trezor:
z téhož PRF tajemství se odvodí dva nezávislé klíče (`m5cet:profile:v1` pro
trezor, `m5cet:userdb:v1` pro databázi). Trezor tedy server nepřečte ani
tehdy, když databázi otevřenou má — obsah je v ní zapečetěný podruhé.

> **Co to znamená prakticky:** po restartu serveru (nebo po odhlášení) je
> soubor databáze přihlášeného uživatele neotevíratelný, dokud se uživatel
> znovu nepřihlásí passkeyem. Databáze anonymní relace otevřít jde — proto má
> jednodenní TTL a proto se po registraci passkey **převede**.

Passkey bez rozšíření PRF žádný klíč vydat neumí. Účet se v takovém případě
**nevytvoří** (a na serveru po pokusu nic nezůstane) — aplikace to řekne
rovnou, místo aby vznikla data, která nikdo neodemkne.

## Převod po registraci passkey

Když si uživatel s běžící anonymní relací vytvoří passkey:

1. vznikne nová databáze pod jeho účtem, klíčovaná passkeyem,
2. `kv`, zprávy, schránka i události se do ní zkopírují,
3. dočasná databáze **i s klíčem** se smaže (soubor i řádek v indexu),
4. klient dostane id nové databáze a od té chvíle zapisuje do ní.

V databázi uživatele zůstane záznam `storage.promoted` s počty.

## Globální databáze

Nešifrovaná — ale nic, co by popisovalo konverzaci, v ní v čitelné podobě
není: sloupce `detail` u logů i přenosů jsou zapečetěné master klíčem a
místnost se ukládá jen jako hash.

| Tabulka | Co v ní je |
| --- | --- |
| `users` | registrovaní uživatelé: id, jméno, vznik, poslední přihlášení, počet přihlášení |
| `passkeys` | credential id, **veřejný** klíč (JWK), algoritmus, čítač podpisů, popisek |
| `databases` | index všech šifrovaných databází: vlastník, režim klíče, zabalený klíč (jen `wrapped`), soubor, expirace, velikost |
| `logs` | logy a ladění (`debug`/`info`/`warn`/`error`), zdroj, událost, `detail` zapečetěný |
| `transfers` | jeden řádek na přenos: směr, transport, stav, bajty, chunky, zopakované chunky, `detail` zapečetěný |

## Databáze uživatele

| Tabulka | Co v ní je |
| --- | --- |
| `kv` | nastavení, profil a zapečetěný trezor (`vault`) |
| `rooms` | místnosti, kdy poprvé/naposled, počet zpráv |
| `messages` | zprávy (JSON payload), s expirací a velikostí |
| `mailbox` | co došlo, když byl uživatel away |
| `events` | vlastní auditní stopa uživatele |

Limity: 20 000 zpráv, 2 MB na zprávu, 4 MB na hodnotu v `kv`, 500 položek
schránky. Starší zprávy a ty po expiraci se ořezávají při zápisu.

## API

Stejné operace jsou dostupné dvěma cestami — přes REST a přes **signalizační
WebSocket** (rychlejší: spojení už je otevřené). Kdo volá, se pozná z
`Authorization: Bearer <token účtu>` nebo z hlavičky `X-M5cet-Session`.

| Cesta | Operace (`op` u WS) | Co dělá |
| --- | --- | --- |
| `GET /api/storage/status` | `status` | dostupnost, engine, statistiky, zda je DB odemčená |
| `POST /api/storage/session` | `session.start` | založí/obnoví relaci bez passkey |
| `POST /api/storage/open` | `open` | otevře databázi účtu klíčem z passkey |
| `POST /api/storage/promote` | `promote` | převede data relace pod účet |
| `GET /api/storage/summary` | `summary` | velikosti, místnosti, schránka |
| `GET|PUT|DELETE /api/storage/kv` | `kv.get` / `kv.put` / `kv.delete` / `kv.keys` | hodnoty |
| `GET|POST|DELETE /api/storage/messages` | `messages.read` / `.put` / `.delete` | zprávy |
| `GET /api/storage/rooms` | `rooms` | místnosti |
| `GET /api/storage/mailbox`, `POST …/take` | `mailbox.read` / `mailbox.take` | schránka |
| `GET|POST /api/storage/events` | `events.read` / `events.add` | auditní stopa |
| `POST /api/storage/log` | `log` | log / ladicí řádek |
| `GET|POST /api/storage/transfers` | `transfers.read` / `transfer.record` | přenosy |
| `DELETE /api/storage` | `forget` | smaže vše, co mi patří |

WebSocket rámec:

```json
→ { "type": "storage", "id": "42", "op": "messages.put", "payload": { … },
    "auth": "<token>", "session": "<id relace>" }
← { "type": "storage-result", "id": "42", "ok": true, "data": { … } }
```

Identita poslaná jednou platí pro celé spojení. Limity: 600 rámců za minutu
na socket, 600 REST požadavků / 15 min, tělo do 12 MB (vlastní kbelík, mimo
veřejný limit 100/15 min).

Operátorské cesty (admin token): `GET /api/admin/storage` (index + uživatelé
+ statistiky), `GET /api/admin/storage/logs`, `GET /api/admin/storage/transfers`.

## Co kam ukládá aplikace

| Situace | Kam jdou data |
| --- | --- |
| Light režim, *nové připojení maže* | nikam |
| *do konce sezení* | jen prohlížeč (šifrovaně v `sessionStorage`) |
| Server-enhanced **bez** passkey | databáze relace na serveru, TTL 1 den |
| Přihlášený passkeyem | jeho databáze; chat navíc zapečetěný trezorem |
| „Smazat vše a odejít" | `DELETE /api/storage` smaže i serverovou část |

## Provoz

| Proměnná | Význam |
| --- | --- |
| `STORAGE_DIR` | kde úložiště leží (jinak `$DATA_DIR/storage`, jinak `./.m5cet/storage`) |
| `STORAGE_MASTER_KEY` | 32 bajtů (hex nebo base64). Bez ní se vygeneruje `storage.key` v adresáři úložiště |
| `DATA_DIR` | společný adresář dat (systemd unit z instalátoru: `/var/lib/m5cet`) |

SQLCipher přináší nativní modul `better-sqlite3-multiple-ciphers`. Má
předkompilované binárky; když pro danou platformu chybí, `npm ci` ho přeloží
(potřebuje `build-essential` a `python3`). **Když se modul nenačte, server
běží dál** — jen `GET /api/storage/status` hlásí `available: false` a data se
neukládají.

Zálohy: `m5cet.db` + celý adresář `db/` + `storage.key`. Bez master klíče
jsou databáze relací nečitelné; databáze uživatelů neotevřete tak jako tak
bez jejich passkeyů.

Úklid běží každou hodinu: expirované relace (soubor i index), logy starší 30
dnů, přenosy starší 90 dnů a nečinné otevřené databáze (5 minut).
