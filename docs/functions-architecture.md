# M5cet Functions — architektura (návrh pro 5.0)

> Stav: **odsouhlaseno** (2026-09-24, rozhodnutí v [kap. 17](#17-rozhodnutí-2026-09-24)). Popisuje, jak z modulu
> „AI & speech“ vyrůst v platformu **funkcí, balíčků a modelů**, které se
> spouštějí z chatu, z webhooků a z konzole — napsané v JavaScriptu nebo
> Pythonu, spouštěné v sandboxu, asynchronně přes frontu. Nic z toho zatím
> není v kódu; kapitola [Etapy](#16-etapy) říká, v jakém pořadí to vznikne.

## 0. Shrnutí

| Otázka | Návrh |
|---|---|
| V čem se píše | JavaScript (ES2023, `async/await`, moduly) a Python 3.12+ — **stejné SDK `m5`** v obou |
| Kde to běží | Ve službě **`m5cet-runner`** (vlastní proces, jako `m5cet-admin`), ve **WASM sandboxu**: QuickJS pro JS, Pyodide pro Python; volitelně v prohlížeči volajícího (stejné sandboxy ve Web Workeru) |
| Jak se spouští | Přes **frontu** (SQLite na jednom serveru, Redis Streams v clusteru); každý běh má `run.id`, patří do `session.id` |
| Co funkce smí | Jen to, co jí dá hostitel přes `m5.*` a co model **výslovně povolí** (hosty pro HTTP, AI poskytovatelé, úložiště, limity) — žádný přímý přístup k síti, souborům ani procesům |
| Z čeho se skládá | **Funkce** (soubor) → **balíček** (soubory + manifest, verze) → **model** (balíčky + vstupy + výstupy + oprávnění) → **executor** (chat `/klíčové-slovo`, webhook, API, plán, konzole) |
| AI | Jedna vrstva poskytovatelů pro chat i funkce: Claude, OpenAI, OpenWebUI, Perplexity, Ollama, llama.cpp, GPT4All, Hugging Face (+ TTS/STT); šifrované klíče, katalog modelů, zkušebna, logy, náklady |
| Soukromí | Chat je E2E šifrovaný: **co jde na server, uživatel vidí předem** (štítek „server“ u modelu, souhlas při prvním použití); modely „jen v prohlížeči“ E2EE neopouštějí |
| Konzole | Správa poskytovatelů a klíčů, **IDE** (zvýraznění, našeptávání `m5.*`, nápověda parametrů, více souborů, zkušební běh s vstupy, živé logy), balíčky a verze, modely, běhy, webhooky, **interaktivní tutoriál** propojený s editorem |

## 1. Cíle a ne-cíle

**Cíle**

1. Operátor napíše funkci v JS nebo Pythonu, složí z ní model a zpřístupní ho
   uživatelům v chatu (`/spustmodel1 …`), přes webhook nebo API.
2. Funkce je **bezpečná pro server** (nemůže ho shodit, zahltit ani vykrást) a
   **bezpečná pro uživatele** (nevidí víc, než potřebuje; E2EE se neobchází
   potichu).
3. Běh je **asynchronní a pozorovatelný**: fronta, stavy, logy, ladění,
   zkušební běhy, metriky, audit.
4. Funkce umí **dialog**: zeptat se za běhu, ukázat formulář v chatu, čekat na
   webhook a pokračovat v `on_event` se stavem session.
5. AI & speech jsou **profesionálně konfigurovatelné** a použitelné stejně
   z chatu, z funkcí i z konzole.

**Ne-cíle (5.0)**

- Obecný hosting aplikací, dlouho běžící démony, přímé TCP/UDP sockety z funkcí.
- Plná kompatibilita s npm / PyPI balíčky s nativním kódem (viz
  [trusted runtime](#43-trusted-runtime-volitelně) — vědomá výjimka jen pro vlastníka).
- Funkce psané běžnými uživateli (5.0: autoři jsou operátoři a vlastník;
  otevření uživatelům je samostatné rozhodnutí — [rozhodnutí](#17-rozhodnutí-2026-09-24)).

## 2. Výchozí stav (před 4.14)

- `server/plugins/*`: konektory AI (`ai.ts`) a řeči (`speech.ts`) čtou klíče
  **jen z proměnných prostředí**, registry vybírá výchozí podle
  `AI_PROVIDER` / `TTS_PROVIDER` / `STT_PROVIDER`; zapnutí modulů v konzoli
  (4.0.6, `plugins.json`); HTTP s časovým limitem a srozumitelnými chybami.
- API pro aplikaci: `POST /api/ai/complete`, `POST /api/speech/tts`,
  `POST /api/speech/stt` (limitované). V aplikaci `AiPanel` (jednorázový dotaz,
  vložení odpovědi do psaní) a hlasy serveru v panelu Řeč.
- Konzole › AI & speech: stav konektorů, test, přepínače, živý log.

Co chybí: klíče mimo env, katalog modelů, streamování, uvažování (reasoning),
nástroje/agenti, náklady a kvóty, logy volání, zkušebna — a celé funkce.
Konektory se proto **nepřepisují od nuly**: stanou se prvními „poskytovateli“
nové vrstvy (kap. 10) a jejich testy zůstanou.

## 3. Doménový model

```
Poskytovatel (provider) ──< Přístup (credential, šifrovaný klíč)
                                   │ smí použít
Balíček (package) ──< Verze balíčku ──< Soubor (JS | PY)
      │ importuje jiné balíčky (pevné verze)
Model ── balíčky@verze + vstupy + výstupy + oprávnění + executory
  │
  ├─ Executor: chat "/klíč" · webhook · API · plán (cron) · konzole
  │
  └─< Běh (run: id, stav, vstupy, výstupy, logy, čas, náklady)
          │ patří do
        Session (id; model × volající × místnost; data s TTL)
          │ čeká na
        Událost (prompt · formulář · webhook běhu · plán) → on_event(...)
```

| Pojem | Co to je | Identita |
|---|---|---|
| **Funkce** | Exportovaná `async` funkce v souboru balíčku; model určí vstupní bod (`execute`) a volitelné `on_event`, `on_cancel`, `describe` | `balíček@verze:soubor#jméno` |
| **Balíček** | Sada souborů jednoho jazyka + `manifest` (jméno, verze, exporty, závislosti, požadovaná oprávnění, popis) | `jméno@semver`, publikované verze jsou **neměnné** |
| **Model** | Spustitelná sestava: vstupní bod, schéma vstupů (typy, validace, nápověda), výstupy, oprávnění, executory, viditelnost pro skupiny, limity | `model.id` (+ revize) |
| **Executor** | Rozhraní, které běh spustí a doručí výsledek | `chat`, `webhook`, `api`, `schedule`, `console` |
| **Běh** (`id_spusteni`) | Jedno spuštění: stav, vstupy, volající, výstupy, logy, spotřeba | `run_<ulid>` |
| **Session** (`id_session`) | Kontext opakovaných běhů: stejný model, volající a místnost; úložiště klíč–hodnota s TTL | `ses_<ulid>` |
| **Volající** (`call_originator`) | Kdo a odkud: účet / host, místnost, klient, executor, případně webhook; dostane výstupy | objekt v `m5.caller` |
| **Událost** | Asynchronní vstup do běhu či session: odpověď na prompt, odeslaný formulář, webhook, plán, zrušení | `evt_<ulid>` |

## 4. Běhové prostředí

### 4.1 Kde se funkce spouští (a co to znamená pro E2EE)

Zprávy v místnosti vidí jen klienti; server je nikdy nečte. Funkce tedy mají
dvě místa běhu a model určí, která smí:

| | **Server** (`m5cet-runner`) | **Prohlížeč volajícího** (Web Worker) |
|---|---|---|
| Vstupy | Klient je pošle serveru přes HTTPS s přihlášením — **opouštějí E2EE** | Zůstávají v zařízení |
| Schopnosti | Vše podle oprávnění: HTTP bez CORS, DNS, AI s klíči operátora, webhooky, plány, sdílená cache | Čisté výpočty, `m5.codec/crypto/id/codes`, HTTP jen tam, kde to CORS dovolí; AI jen přes server (pak data E2EE opouštějí) |
| Kdo smí | Přihlášený účet (Server-enhanced), skupiny podle modelu | I host v Light · P2P |
| Výstup do místnosti | Klient volajícího ho **sám zašifruje a pošle** jako zprávu typu „výstup funkce“ | Stejně |

Pravidla:

- U modelu je vždy vidět, **kde běží** (štítek „server“ / „v prohlížeči“) a co
  z toho plyne; první spuštění serverového modelu v místnosti chce souhlas.
- Server **nikdy nečte místnost** kvůli funkci: dostane jen to, co klient
  výslovně pošle (vstupy příkazu, přílohu vybranou uživatelem). Funkce
  „shrň konverzaci“ tedy běží v prohlížeči, nebo klient pošle vybraný úsek
  a uživatel to vidí.
- Výstupy jde nechat **jen pro volajícího** (neodejde do místnosti) nebo
  **pro místnost** (zpráva s podpisem volajícího a jménem modelu).

### 4.2 Sandbox: WASM, žádná okolní oprávnění

Každý běh dostane vlastní instanci interpretu ve **worker threadu**:

- **JavaScript — QuickJS** (`quickjs-emscripten`, asynchronní varianta):
  ES2023, moduly, `async/await`; limit paměti instance, přerušení podle
  času (interrupt handler), omezený zásobník. Hostitelské funkce jsou
  asynchronní (asyncify), takže `await m5.http.get(...)` v sandboxu čeká na
  skutečný požadavek hostitele.
- **Python — Pyodide** (CPython 3.12+ ve WASM): standardní knihovna, čisté
  Python balíčky z předem schváleného, offline přibaleného seznamu (žádný
  `micropip` z internetu za běhu); přerušení přes sdílený buffer
  (`KeyboardInterrupt`), asynchronní volání hostitele (`await m5.http.get`).
- **Hranice**: v sandboxu není `fs`, `net`, `process`, `require`, `import js`
  ani `pyodide.ffi` — jen objekt `m5` s tím, co model povolil.
  Hostitel kontroluje každé volání (oprávnění, limity, SSRF) a loguje ho.
- **Limity běhu** (výchozí, model může snížit, vlastník zvýšit): CPU čas
  2 s na krok bez čekání, celkem 30 s; stěna 5 min (čekání na prompt až
  24 h — pak už ne jako živá instance, viz [4.5](#45-čekání-a-pokračování));
  paměť 128 MB JS / 256 MB Python; výstup 1 MB; logy 256 kB; HTTP 50
  požadavků / 20 MB; AI podle rozpočtu modelu.
- Worker se po běhu zahodí (žádné sdílené globální proměnné mezi běhy);
  teplé předpřipravené instance (pool) zkracují start Pyodide.
- Proces `m5cet-runner` má navíc limity systemd (`MemoryMax`, `CPUQuota`,
  `TasksMax`, `NoNewPrivileges`, `ProtectSystem=strict`, síť jen přes
  hostitelský HTTP klient) — sandbox ve WASM je první vrstva, ne jediná.

Proč ne jinak: `vm` / `vm2` v Node **nejsou bezpečnostní hranice** (vm2 je
kvůli únikům opuštěný); `isolated-vm` izoluje jen JS a potřebuje nativní
modul; kontejner na každý běh je pomalý a na VPS bez Dockeru nedostupný.
WASM dává tutéž izolaci na serveru i v prohlížeči.

### 4.3 Trusted runtime (volitelně)

Pro vlastníka, který potřebuje npm / PyPI s nativním kódem: funkce běží
jako **samostatný proces** Node 24 s `--permission` (povolené jen vybrané
cesty) nebo `python3 -I`, zabalený v **bubblewrap / nsjail** (vlastní
namespace, seccomp, bez sítě kromě proxy hostitele), s cgroup limity.
Ve výchozím stavu **vypnuto**; zapnutí je v konzoli s varováním, balíčky
s tímto runtime schvaluje jen vlastník a každý běh jde do auditu.

### 4.4 Fronta, workery, životní cyklus

```
executor ──► POST /internal/runs ──► fronta ──► runner (pool workerů)
   ▲                                              │  m5.* volání → hostitel
   └──────── výstupy, stav (SSE / WS) ◄───────────┘  logy → úložiště
```

- **Fronta**: na jednom serveru tabulka `runs` v SQLite (WAL) s výběrem
  další úlohy a upozorněním přes IPC; v clusteru Redis Streams (skupiny
  konzumentů, potvrzení, převzetí úloh spadlého runneru). Stejné rozhraní.
- **Stavy běhu**: `queued → running → (waiting ⇄ running) → done | failed |
  cancelled | timed_out`. Každý přechod je událost (log, metrika, SSE).
- **Plánování**: férově podle modelu a volajícího (aby jeden uživatel
  nezablokoval ostatní), priority (interaktivní chat > webhook > plán),
  limit souběžných běhů na model, uživatele a celkem.
- **Idempotence**: executor může dát `idempotencyKey` (webhook poskytovatele
  posílá znovu) — druhý stejný požadavek vrátí první běh.
- **Opakování**: jen tam, kde to model povolí (`retry: { max, backoff }`) a
  jen při chybě hostitele (síť, 5xx), nikdy při chybě kódu.
- **Zrušení**: volající nebo operátor; worker dostane přerušení, po
  2 s tvrdé ukončení; `on_cancel` smí uklidit (s krátkým limitem).
- `m5cet-runner` mluví s hlavní službou přes lokální HTTP se sdíleným
  tajemstvím (jako admin služba); výstupy k volajícímu doručí hlavní
  služba po existujícím WebSocketu (nová třída rámců „run“).

### 4.5 Čekání a pokračování

Funkce se může zeptat a čekat dvěma způsoby — model si vybere:

1. **Živé čekání** (jednoduché, krátké): `answer = await m5.prompt(...)`,
   `data = await m5.form(...)`, `hook = await m5.webhook.wait(...)`.
   Instance zůstává v paměti, čas čekání se nepočítá do CPU, ale do stěny
   (výchozí max 10 min). Vhodné pro „vyber možnost“ v chatu.
2. **Trvalé pokračování** (dlouhé, přežije restart): funkce uloží, co
   potřebuje, do `m5.session`, zaregistruje očekávanou událost
   (`m5.expect("payment", { ttl: "24h" })`, `m5.webhook.create(...)`) a
   **skončí**. Až událost přijde, runner spustí `on_event(event, session,
   caller)` v **novém** běhu téže session (`run.parent`). Stav nese session,
   ne paměť interpretu.

Tím je splněné zadání „webhook, který vrátí data do běžícího `id_spusteni`
v `id_session` a zavolá `on_event` se session a `call_originator`“:
u živého čekání se data předají do čekajícího `await`, u trvalého se
spustí `on_event` a v obou případech má kód `m5.caller`, kterým pošle
zprávu, flash nebo otevře okno u původního volajícího.

## 5. SDK `m5` (JS i Python)

Stejné jméno, stejné metody, v Pythonu `snake_case`. Vše, co mluví se
světem, je asynchronní. Typy pro našeptávání v IDE generuje jeden zdroj
(`sdk.d.ts` → i `m5.pyi`).

| Objekt | Co umí |
|---|---|
| `m5.sys` | verze M5cet, instance, čas serveru, časové pásmo a jazyk volajícího, limity běhu, zbývající čas |
| `m5.run` | `id`, `model`, `inputs` (ověřené), `executor`, `parent`, `startedAt`, `deadline`; `progress(p, text)` |
| `m5.caller` | kdo volá (`user` s jménem a skupinami / host / webhook / plán), `room`, `client`; `send(output)`, `flash(text, level)`, `openWindow(id, args)` |
| `m5.session` | `id`; `get / set / delete / keys`, TTL na klíč; rozsah model × volající × místnost |
| `m5.cache` | sdílená cache s TTL: `get / set / incr / delete / lock`; rozsahy `run`, `session`, `model`, `global` (jen s oprávněním); sdílená runnerem i aplikací |
| `m5.log` | `debug / info / warn / error` + strukturovaná pole; `trace(label, fn)` měří úsek; vše v logu běhu a v IDE živě |
| `m5.out` | výstupy: `text`, `markdown`, `code(lang)`, `table`, `image(bytes, mime)`, `file`, `json`, `chart` (data → bezpečný SVG), `form` (schéma), `buttons` (akce s `on_event`) |
| `m5.prompt / m5.form` | dotaz za běhu (text, volba, potvrzení) a formulář ze schématu; živé čekání |
| `m5.expect / m5.webhook` | očekávaná událost pro trvalé pokračování; `webhook.create({ ttl, once, secret })` → URL vázaná na běh a session; `webhook.wait(...)` |
| `m5.http` | `get/post/put/patch/delete/request`: hlavičky, cookie jar (v rámci session), JSON, `FormData` (i soubory), raw tělo, přesměrování, časový limit, velikost; jen hosté povolení modelem, ochrana SSRF |
| `m5.dns` | `resolve(name, type)` A/AAAA/CNAME/MX/TXT/SRV/CAA/NS/PTR, DoH nebo systémový resolver |
| `m5.crypto` | hash (SHA-2/3, BLAKE2/3), HMAC, HKDF, PBKDF2, scrypt, Argon2id; náhoda; AES-GCM, ChaCha20-Poly1305; RSA, ECDSA/ECDH (P-256/384), Ed25519/X25519: klíče, podpis, ověření, šifrování; X.509 (parsování, ověření řetězce), CSR; **OpenSSH** klíče (formáty, otisky, podpis `ssh-keygen -Y`); **OpenPGP** (klíče, šifrování, podpis, ověření — OpenPGP.js); JWT/JWS/JWE |
| `m5.id` | UUID v4/v7, ULID, nanoid, krátké tagy, slug, hash-ID, čítače (přes cache) |
| `m5.codec` | base64/base64url/base32/base58/hex, URL (encode, parse, build), HTML escape, JSON/YAML/TOML/CSV/XML, `pack/unpack` (struct formáty), gzip/deflate/brotli/zstd, bzip2 (WASM), zip/tar, MIME, UTF-8/16, quoted-printable |
| `m5.codes` | 2D a čárové kódy do SVG/PNG: QR, Micro QR, rMQR, Aztec, Data Matrix, PDF417, MaxiCode, Han Xin, DotCode, Code 128/39/93, EAN/UPC, ITF… (bwip-js); čtení QR z obrázku |
| `m5.ai` | `chat(messages, { provider, model, system, tools, stream, reasoning, maxTokens, json })`, `stream`, `agent(goal, { tools, maxSteps, budget, approve })`, `embed`, `image.generate/edit`, `speech.tts/stt`, `models()` — kap. 10 |
| `m5.call` | volání jiného modelu (jako podběh, s jeho oprávněními, s rozpočtem volajícího) |
| `m5.secret` | `m5.secret("GITHUB_TOKEN")` vrátí **neprůhledný odkaz**, použitelný jen v `m5.http` (hlavička, auth) — hodnota se do sandboxu nedostane |

Poznámka k „iQR“: je to proprietární formát Denso Wave a otevřené knihovny
ho nekódují. Stejný účel (malý obdélníkový kód) plní **rMQR** (ISO/IEC 23941).

Implementace: čisté pomocníky (`codec`, `id`, část `crypto`, `codes`) běží
**uvnitř sandboxu** jako přibalené knihovny (rychlé, žádný přechod
k hostiteli); vše s I/O a tajemstvími běží **u hostitele** v TypeScriptu —
jednou, pro oba jazyky.

## 6. Balíčky, soubory, importy, verze

```
manifest: { name: "tools-net", version: "1.2.0", language: "js",
            exports: ["dns.js#lookup", "http.js#probe"],
            dependencies: { "tools-text": "^1.0.0" },
            permissions: { http: ["*.example.org"], cache: ["model"] },
            description: "…" }
files:    index.js · dns.js · http.js · README.md · tests/*.js
```

- **Importy** mezi soubory balíčku (`import { x } from "./util.js"`,
  `from .util import x`) a mezi balíčky (`import { y } from "pkg:tools-text"`,
  `from pkg.tools_text import y`). Resolver je hostitelský, balíčky se
  nahrávají z úložiště, ne z disku ani sítě.
- **Verze**: koncept (upravuje se) → publikovaná verze (neměnná, podepsaná
  otiskem obsahu). Model odkazuje na **konkrétní** verze — publikace nové
  verze model nezmění, dokud ho operátor nepřepne (s diffem).
- **Oprávnění balíčku** jsou požadavek; skutečná oprávnění dá až **model**
  (průnik) — a vlastník je schvaluje při publikaci modelu.
- **Testy** balíčku (`tests/`) spouští konzole i CI publikace; výsledek je u verze.
- Export / import balíčku jako `.m5pkg` (zip + manifest + otisk).

## 7. Modely

```json
{
  "id": "spustmodel1",
  "name": "Kontrola domény",
  "keyword": "spustmodel1",
  "summary": "Ověří DNS, certifikát a HTTP odpověď domény.",
  "entry": "tools-net@1.2.0:index.js#execute",
  "on_event": "tools-net@1.2.0:index.js#on_event",
  "runtime": "server",
  "inputs": [
    { "name": "domena", "type": "hostname", "required": true, "help": "např. example.org" },
    { "name": "port", "type": "integer", "default": 443, "min": 1, "max": 65535 },
    { "name": "hloubka", "type": "enum", "values": ["rychla", "plna"], "default": "rychla" }
  ],
  "outputs": ["markdown", "table", "flash"],
  "permissions": { "http": ["*"], "dns": true, "ai": [], "cache": ["session"] },
  "limits": { "wallMs": 60000, "cpuMs": 5000, "memoryMb": 96 },
  "executors": { "chat": { "visibility": "room" }, "webhook": { "auth": "hmac" } },
  "groups": ["user"],
  "rate": { "perUser": "10/min", "perRoom": "30/min" }
}
```

- **Typy vstupů**: `string`, `text`, `integer`, `number`, `boolean`, `enum`,
  `date`, `time`, `duration`, `url`, `hostname`, `email`, `ip`, `json`,
  `user` (člověk v místnosti), `file` (příloha vybraná v chatu), `secret`
  (jen executory webhook/API). Validace: `required`, `min/max`,
  `pattern`, `values`, vlastní `validate` (v sandboxu, krátký limit).
- **Viditelnost**: skupiny (moduly a skupiny ze 4.0), místnosti, režim
  (Light / Server-enhanced), executor.
- **Revize modelu**: každé uložení je verze (jako historie rozvržení ve 4.13).

## 8. Executory

### 8.1 Chat — `/klíčové-slovo`

1. Po napsání `/` na začátku zprávy psaní ukáže **našeptávač** modelů, které
   uživatel smí spustit (klíč, název, popis, štítek server / prohlížeč).
2. Po výběru klíče ukáže **nápovědu parametrů** (jako signatura funkce:
   `/spustmodel1 domena [port=443] [hloubka=rychla|plna]`), zvýrazní právě
   psaný parametr a nabízí hodnoty (`enum`, lidé v místnosti, přílohy).
3. **Parsování**: pozičně i pojmenovaně (`port=8443`, `--plna` pro boolean /
   enum), uvozovky pro mezery, `\` escape; `/spustmodel1 ?` ukáže nápovědu
   modelu (popis, příklady). Ověří se **v klientu i na serveru** stejným
   modulem (sdílený jako `layout-tree.ts`).
4. Chyby se ukážou přímo pod psaním (který parametr, proč) — nic se neodešle.
5. **Spuštění**: příkaz se do místnosti **neposílá** jako zpráva; klient
   zavolá `POST /api/runs` (server) nebo worker (prohlížeč). V chatu se
   objeví dočasná karta běhu (stav, průběh, zrušit) — jen volajícímu, nebo
   v místnosti, podle modelu.
6. **Výstupy** (text, Markdown, tabulka, obrázek, soubor, graf, formulář,
   tlačítka) se kreslí nový typ zprávy „výstup funkce“ — layout
   `message.function` v Layout builderu, bez `innerHTML`, stejná pravidla
   jako prvek HTML. Flash zprávy a otevření okna aplikace (jen okna ze
   seznamu, např. Místnost, Moje připojení) jdou jen volajícímu.
7. **Dialog**: `m5.prompt/form` se ukáže jako karta v chatu volajícího;
   odpověď jde jako událost běhu.

### 8.2 Webhook

- `POST /hooks/{model}/{hookId}` s ověřením: HMAC podpis (`X-M5-Signature`,
  časové razítko proti opakování), sdílený token, nebo žádné (jen s
  explicitním souhlasem vlastníka); volitelně seznam IP.
- **Synchronně** (čeká na výsledek do limitu, vrátí JSON / text / soubor)
  nebo **asynchronně** (`202 { runId, status }`, výsledek na `callbackUrl`
  nebo `GET /hooks/runs/{runId}` s tokenem).
- **Webhook běhu** (`m5.webhook.create`) je jednorázová nebo časově omezená
  URL svázaná s během a session: `POST /hooks/r/{token}` → událost →
  čekající `await`, nebo `on_event(event, session, caller)`.

### 8.3 API, plán, konzole

- **API**: tokeny s rozsahem (modely, limity) pro jiné systémy.
- **Plán**: cron výrazy s časovým pásmem, bez souběhu (zámek v cache).
- **Konzole**: zkušební běh ve IDE (viz kap. 11) — vstupy formulářem,
  výstup a logy vedle, stejný sandbox jako produkce.

## 9. Výstupy a interakce v aplikaci

| Výstup | Jak se ukáže |
|---|---|
| `text`, `markdown` | bublina výstupu (Markdown bez HTML; odkazy jen bezpečná schémata, jako dnes `linkify`) |
| `code`, `json`, `table` | zvýrazněný kód / tabulka s kopírováním |
| `image`, `file` | příloha (jako soubory v chatu); v místnosti šifrovaná klientem volajícího |
| `chart` | data → SVG vykreslené aplikací (ne kód z funkce) |
| `form`, `buttons` | ovládací prvky; odeslání = událost běhu (`on_event`) |
| `flash` | systémové oznámení (existující `FlashMessages`) jen volajícímu |
| `openWindow` | otevře okno aplikace ze seznamu povolených (s argumenty) |
| `progress` | průběh v kartě běhu |
| stream | AI text přibývá v bublině živě (SSE / WS) |

## 10. AI a řeč: vrstva poskytovatelů

### 10.1 Rozhraní

```
Provider.chat({ model, system, messages, tools?, toolChoice?, json?, stream?,
                reasoning?: "off" | "low" | "medium" | "high", maxTokens?, stop?, metadata })
       → { text, parts, toolCalls?, usage: { input, output, reasoning, cached }, costUsd?, latencyMs, model, raw? }
Provider.models()  · Provider.embed()  · Provider.image()  · Provider.tts()  · Provider.stt()
Provider.health()  · capabilities: { stream, tools, vision, json, reasoning, embed, image, tts, stt }
```

- **Uvažování** se mapuje na to, co poskytovatel umí (u Claude úsilí a
  rozšířené uvažování, u OpenAI `reasoning.effort`, jinde nic) — funkce ani
  chat to nemusí rozlišovat. Parametry, které model nepřijímá (dnešní
  `temperature` u Claude 5), adaptér **neposílá** — tabulka schopností
  modelu, ne pokus-omyl.
- **Nástroje / agenti**: nástroj = funkce z balíčků, které model agenta
  smí použít; smyčka s limitem kroků a rozpočtem; nástroje se side-efekty
  (`http.post`, odeslání zprávy) chtějí **potvrzení** volajícího, pokud je
  model neoznačí jako bezpečné. Ochrana proti prompt injection: výsledky
  nástrojů jdou modelu jako data, nikdy jako instrukce systému.

### 10.2 Poskytovatelé

| Poskytovatel | Adaptér | Poznámka |
|---|---|---|
| Anthropic (Claude) | nativní Messages API | streamování, nástroje, obrázky, úsilí / uvažování, cache promptu |
| OpenAI | Responses API (+ Chat Completions pro kompatibilitu) | nástroje, JSON schéma, obrázky, embeddings, TTS/STT |
| OpenWebUI | OpenAI-kompatibilní (`/api/chat/completions`, `/api/models`) | modely a znalosti instance OpenWebUI |
| Perplexity | OpenAI-kompatibilní (`sonar…`) | vrací zdroje (citace) → výstup s odkazy |
| Ollama | nativní `/api/chat`, `/api/tags` (+ OpenAI compat) | lokální modely, stahování modelu z konzole |
| llama.cpp server | OpenAI-kompatibilní (`/v1/…`) | lokální GGUF |
| GPT4All | OpenAI-kompatibilní lokální API server | lokální |
| Hugging Face | Inference Providers (`router.huggingface.co/v1`) + `hf-inference` pro ASR/obrázky | volba poskytovatele / politiky (`:fastest`) |
| Řeč | ElevenLabs, OpenAI, Hugging Face, whisper.cpp server, Piper | TTS/STT, seznam hlasů |

Jeden **OpenAI-kompatibilní adaptér** s profily pokryje OpenAI, OpenWebUI,
Perplexity, llama.cpp, GPT4All, Hugging Face i Ollama (compat); specifika
(citace, stahování modelů) jsou malé doplňky.

### 10.3 Konfigurace a provoz

- **Přístupy (credentials)** v konzoli: poskytovatel, základní URL, klíč —
  uložený **šifrovaně** (datovým klíčem admin služby, jako trezory), v UI jen
  poslední 4 znaky; proměnné prostředí zůstávají jako přepis (a konzole to
  ukáže, jako přepínače ve 4.0.6). Rozsah: které modely, skupiny, funkce.
- **Katalog modelů**: načtený z `models()` poskytovatele + ruční doplnění;
  u modelu schopnosti, kontext, cena za token (pro odhad nákladů), výchozí
  pro chat / funkce / řeč, záložní řetězec (když poskytovatel neodpovídá).
- **Zkušebna**: prompt, systém, nástroje, streamování, uvažování — výstup,
  tokeny, latence, cena; **surový požadavek a odpověď** se skrytým klíčem.
- **Logy volání**: čas, kdo (uživatel / funkce / chat), poskytovatel, model,
  tokeny, latence, cena, výsledek, třída chyby; filtry, export, retence
  (výchozí 30 dní), obsah zpráv **jen při zapnutém ladění** a s varováním.
- **Kvóty a náklady**: rozpočet za den / měsíc na poskytovatele, skupinu,
  uživatele a model; při překročení odmítnutí s vysvětlením a alert.
- **Zdraví**: pravidelný `health()`, jistič (po sérii chyb přepne na záložní),
  metriky do existujícího `/metrics`.
- Aplikace (4.14): `AiPanel` je **asistent** se streamem a Markdownem; příkazy
  v chatu (`/ai …`, `/shrň`, `/přelož …` jako vestavěné modely) nad touto
  vrstvou přijdou s etapou 3.

## 11. Konzole: IDE, běhy, tutoriál

- **Editor**: CodeMirror 6 přibalený do konzole (CSP `script-src 'self'`
  zůstává): zvýraznění JS a Pythonu, **našeptávání** `m5.*` z typů SDK
  (metody, parametry, dokumentace), **nápověda parametrů** při psaní volání,
  kontrola syntaxe (JS parserem, Python přes Pyodide `ast` ve workeru
  konzole), více souborů (strom balíčku), hledání, formátování, diff verzí.
- **Zkušební běh**: formulář vstupů podle schématu modelu, spuštění v
  sandboxu (na serveru, s logem „zkušební“), výstupy vykreslené jako v
  chatu, **živé logy** (SSE), měření (`m5.log.trace`), stav cache a session,
  simulace událostí (odpověď na prompt, webhook).
- **Ladění**: krokování WASM interpretu není praktické — místo něj
  strukturované logy, `trace`, snímek vstupů a výstupů každého volání
  `m5.*`, přehrání běhu se stejnými vstupy (s nahranými odpověďmi HTTP/AI).
- **Běhy**: seznam s filtry (model, stav, volající, čas), detail (časová
  osa stavů, logy, volání hostitele, spotřeba), zrušení, opakování.
- **Webhooky**: URL, tajemství (rotace), poslední požadavky a odpovědi.
- **Tutoriál**: lekce v Markdownu vedle editoru — „vlož ukázku“, „spusť“,
  **kontroly** (lekce ověří výstup běhu), postup uložený u operátora; od
  „Hello, `m5.out.text`“ přes vstupy, HTTP, cache, prompt a webhook až po
  agenta s nástroji. Každá lekce je zároveň testem SDK.

## 12. Bezpečnost

| Hrozba | Opatření |
|---|---|
| Únik ze sandboxu | WASM bez okolních oprávnění, worker na běh, limity procesu (systemd), žádný nativní kód v základním runtime; aktualizace QuickJS / Pyodide sledované jako závislosti |
| Vyčerpání zdrojů | CPU / stěna / paměť / výstup / HTTP / AI rozpočty na běh, uživatele, model; férová fronta; jistič |
| SSRF | povolení hostů modelem; blokace privátních, loopback, link-local a metadata adres (i po DNS — připnutí IP), jen `http(s)`, limit přesměrování |
| Krádež tajemství | klíče šifrovaně u hostitele; do sandboxu jen neprůhledné odkazy (`m5.secret`); v logech maskované |
| Zneužití z chatu | model viditelný jen skupinám; limity na uživatele a místnost; ověření vstupů na serveru; audit spuštění |
| Podvržený webhook | HMAC s časovým razítkem, jednorázové tokeny běhu, TTL, IP seznam |
| Prompt injection | výstupy nástrojů jako data; potvrzení akcí se side-efekty; oddělené role zpráv |
| E2EE | co odchází na server, je vidět předem; server nečte místnost; výstupy do místnosti šifruje klient |
| Škodlivý autor | autor = operátor; publikaci modelu s novými oprávněními schvaluje vlastník; audit (neměnný řetěz ze 3.1) |

Role: **vlastník** (trusted runtime, schvalování oprávnění, tajemství),
**operátor** (balíčky, modely, publikace v rámci schválených oprávnění),
**auditor** (čte běhy a logy bez obsahu).

## 13. Úložiště

SQLite (SQLCipher, jako účty) v `$DATA_DIR/functions.db`:

`packages`, `package_versions` (obsah, otisk, manifest, výsledek testů),
`models`, `model_revisions`, `runs` (stav, vstupy — šifrovaně, výstupy,
spotřeba), `run_events`, `run_logs` (retence), `sessions` (+ `session_kv`
s TTL), `cache_kv` (když není Redis), `webhooks`, `schedules`,
`credentials` (šifrovaně), `ai_calls` (log volání), `budgets`.
V clusteru Redis pro frontu, cache a zámky; SQLite zůstává zdrojem pravdy.

## 14. Pozorovatelnost

Metriky (`/metrics`): běhy podle stavu a modelu, délka fronty, časy
(fronta, běh, čekání), chyby podle třídy, spotřeba CPU a paměti, volání
hostitele, AI tokeny a náklady. Alerty (existující mechanismus): fronta
roste, chybovost modelu, rozpočet, nedostupný poskytovatel. Audit:
publikace, změny oprávnění a tajemství, ruční zrušení, trusted runtime.

## 15. Rozhraní (přehled)

| Kde | Endpoint |
|---|---|
| Aplikace | `GET /api/models` (co smím, s nápovědou) · `POST /api/runs` · `GET /api/runs/:id` · `POST /api/runs/:id/events` (odpověď na prompt, formulář) · `POST /api/runs/:id/cancel` · WS rámce `run.*` (stav, výstupy, stream) |
| Webhooky | `POST /hooks/:model/:hookId` · `POST /hooks/r/:token` · `GET /hooks/runs/:id` |
| Konzole | `/admin/providers*` · `/admin/credentials*` · `/admin/ai/playground` · `/admin/ai/calls` · `/admin/packages*` · `/admin/models*` · `/admin/runs*` · `/admin/webhooks*` · `/admin/schedules*` · `/admin/functions/tutorial` |
| Interní | runner ↔ hlavní služba: `/internal/runs`, `/internal/deliver`, `/internal/host/*` (volání `m5.*` s I/O) |

## 16. Etapy

Každá etapa je samostatná verze s testy (unit, E2E, bezpečnostní testy
sandboxu), dokumentací a nasazením; další staví na předchozí.

| Etapa | Obsah | Hotovo, když |
|---|---|---|
| **1 — AI & speech** (4.14, hotovo) | vrstva poskytovatelů (8 AI + řeč), šifrované přístupy, katalog modelů, zkušebna, logy volání, kvóty a náklady, zdraví; nové API aplikace (stream); asistent v chatu místo `AiPanel` | každý poskytovatel projde testem v zkušebně (mock server v testech), stream v chatu, logy a náklady v konzoli |
| **2 — Runtime** | `m5cet-runner`, fronta, QuickJS + Pyodide sandboxy, SDK jádro (`sys`, `run`, `caller`, `log`, `out`, `session`, `cache`, `codec`, `id`, `crypto` základ), balíčky a verze, modely, IDE v1, zkušební běh, běhy v konzoli | sada útoků na sandbox (únik, paměť, smyčka, SSRF) neprojde; zkušební běh JS i Pythonu z IDE |
| **3 — Chat** | executor `/klíč`: našeptávání, nápověda parametrů, parsování, validace, karty běhu, výstupy (`message.function`), prompt a formulář, flash, okna; E2EE štítky a souhlas | E2E: dva lidé v místnosti, jeden spustí serverový a prohlížečový model, druhý vidí výstup |
| **4 — Síť a integrace** | `http` (cookies, form-data, raw), `dns`, `crypto` plné (SSH, PGP, X.509, JWT), `codes`, komprese, webhooky (vstupní, běhu), `on_event`, trvalé pokračování, plány, API tokeny | webhook běhu doručí data do `on_event` po restartu runneru |
| **5 — AI ve funkcích** | `m5.ai` (chat, stream, reasoning, embed, obrázky, řeč), agenti s nástroji a potvrzováním, rozpočty běhu | agent s dvěma nástroji a potvrzením v chatu |
| **6 — Autor** | interaktivní tutoriál, galerie šablon, import / export `.m5pkg`, diff verzí, trusted runtime (volitelný) | nový operátor projde tutoriál a publikuje model bez dokumentace |

### Stav etapy 1 (4.14)

Hotovo: adaptéry Anthropic (Messages API, adaptivní uvažování s `effort`,
rozpočet u starších modelů), OpenAI-kompatibilní (OpenAI, Open WebUI,
Perplexity se zdroji, llama.cpp, GPT4All, Hugging Face, jiné; řeč a přepis),
Ollama (NDJSON, `think`), ElevenLabs; klíče zašifrované master klíčem
úložiště a svázané s poskytovatelem; modely od poskytovatele i jménem, ceny;
skupiny; limity instance (tokeny, USD za měsíc) a uživatele (volání a tokeny
za den), velikosti; žurnál v SQLite s obsahem jen při dočasném ladění;
konzole (poskytovatelé, modely, zkušebna se streamem a požadavkem, řeč,
volání živě / CSV / souhrny, nastavení); asistent v aplikaci (rozvržení
`panel.ai`, stream, Markdown, uvažování, zdroje, zastavení).

Oproti plánu v kap. 10 zatím chybí (přijde s etapou 5 — AI ve funkcích — nebo
podle potřeby dřív): pravidelný `health()` s jističem a záložním řetězcem
modelů, rozpočty po poskytovatelích, skupinách a modelech, embeddings a
obrázky, metriky AI v `/metrics`, OpenAI Responses API (používá se Chat
Completions, které OpenAI dál podporuje) a příkazy `/ai` v chatu (etapa 3).

## 17. Rozhodnutí (2026-09-24)

1. **Místo běhu** — model deklaruje `runtime: "browser" | "server" | "auto"`
   (výchozí `auto`). `auto` poběží **v prohlížeči volajícího**, pokud model
   nepotřebuje nic serverového (HTTP mimo CORS, DNS, AI, tajemství, webhooky,
   plány, globální cache); jinak na serveru a uživatel to vidí předem (štítek
   „server“, souhlas při prvním spuštění v místnosti). Konzole u modelu
   ukáže, proč dopadl tam, kam dopadl. Důvod: E2EE je hlavní vlastnost M5cet
   a výpočet, který server nepotřebuje, ho nemá vidět.
2. **Python = Pyodide.** Balíček `pyodide` je závislost projektu; instalační
   i aktualizační skript ho nainstalují (s předem schválenými čistými Python
   balíčky pro offline běh) a ověří, že se interpret spustí. Systémový Python
   v nsjail jen v trusted runtime (etapa 6).
3. **Autoři funkcí** v 5.0: vlastník a operátoři.
4. **Redis** je v pořádku: instalační skript ho nabídne (a nastaví
   `REDIS_URL`) pro frontu, cache a zámky; bez něj běží fronta a cache nad
   SQLite (jeden server, vývoj, testy).
5. **Rozpočty AI**: měsíční limit instance je ve výchozím stavu **0 = AI
   vypnutá**, dokud ho vlastník nenastaví (tokeny a volitelně USD, když jsou
   zadané ceny modelů); limity na uživatele a den; zkušebna a testy v konzoli
   se počítají, ale limit je neblokuje. Hosté AI používají, jen když je
   skupina „Hosté“ u poskytovatele povolená.

Verze: etapa 1 = **4.14**, další etapy 4.15–4.19, celek **5.0**.

## 18. Příklad: `/spustmodel1`

**JavaScript** (`tools-net@1.2.0:index.js`)

```js
export async function execute({ domena, port, hloubka }) {
  m5.run.progress(0.1, "DNS…");
  const a = await m5.dns.resolve(domena, "A");
  const res = await m5.http.get(`https://${domena}:${port}/`, { timeoutMs: 8000 });
  m5.log.info("http", { status: res.status, ms: res.timing.totalMs });
  const rows = [["DNS A", a.join(", ")], ["HTTP", `${res.status} ${res.statusText}`], ["TLS", res.tls?.protocol ?? "—"]];
  if (hloubka === "plna") {
    const ok = await m5.prompt({ text: `Spustit i test hlaviček (${domena})?`, choices: ["ano", "ne"] });
    if (ok === "ano") rows.push(["HSTS", res.headers["strict-transport-security"] ?? "chybí"]);
  }
  // Výsledek později: webhook služby, která doménu projde celou.
  const hook = await m5.webhook.create({ ttl: "1h", once: true });
  await m5.session.set("pending", { domena, since: m5.sys.now() }, { ttl: "1h" });
  await m5.http.post("https://scanner.example.org/scan", { json: { domena, callback: hook.url } });
  return m5.out.table(["Kontrola", "Výsledek"], rows, { title: `**${domena}** — plná zpráva dorazí sama` });
}

export async function on_event(event, session, caller) {
  if (event.type !== "webhook") return;
  const pending = await session.get("pending");
  await caller.send(m5.out.markdown(`Plná kontrola **${pending.domena}**: ${event.body.json.grade}`));
  await caller.flash(`Hotovo: ${pending.domena}`, "success");
  await session.delete("pending");
}
```

**Python** (stejné SDK)

```python
async def execute(domena: str, port: int = 443, hloubka: str = "rychla"):
    m5.run.progress(0.1, "DNS…")
    a = await m5.dns.resolve(domena, "A")
    res = await m5.http.get(f"https://{domena}:{port}/", timeout_ms=8000)
    m5.log.info("http", status=res.status)
    return m5.out.table(["Kontrola", "Výsledek"], [["DNS A", ", ".join(a)], ["HTTP", str(res.status)]])

async def on_event(event, session, caller):
    await caller.send(m5.out.markdown(f"Výsledek: {event.body.json['grade']}"))
```

V chatu: `/spustmodel1 example.org hloubka=plna` → karta běhu s průběhem →
dotaz „Spustit i test hlaviček?“ s tlačítky → tabulka → o několik minut
později zpráva a flash z `on_event`.
