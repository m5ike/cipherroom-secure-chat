# M5cet — bezpečnostní model

Tento dokument popisuje, **co M5cet chrání, jak to chrání, a co naopak
chránit nemůže**. Je psán pro ty, kdo M5cet nasazují nebo auditují.

## TL;DR

- Server vidí signalizační rámce (SDP/ICE) a (volitelně) opaque metadata.
  **Nikdy** plaintext ani klíč. Chatové zprávy přes server nejdou vůbec (ani
  jako ciphertext). **Výjimky:** soubory v *proxy* režimu posílají přes `/ws`
  IV a ciphertext chunků (viz „Známé mezery") a zprávy pro účastníka ve stavu
  **away** (viz níže) — v obou případech jen ciphertext klíčem místnosti,
  který server nemá.
- Šifrování: AES-GCM 256, IV 12 B per frame, klíč PBKDF2-SHA256
  (250 000 iter), salt obsahuje `room id`. Klíč je `extractable: false`.
- WebRTC media: standardní DTLS-SRTP, řešený prohlížečem.
- Admin příkazy jsou **whitelisted** a **token-protected**. Cokoli mimo
  allowlist je shozeno na úrovni serveru.
- Klíč místnosti se sdílí **out-of-band**.

## Aktiva (assets)

| ID | Aktivum                          | Kde žije                                 |
|----|----------------------------------|------------------------------------------|
| A1 | Plaintext zpráv / souborů        | RAM prohlížeče A i B                      |
| A2 | Klíč místnosti (room key)        | Web Crypto subtle, non-extractable        |
| A3 | Passphrase                       | UI vstup → použito k odvození A2          |
| A4 | Audio/video stream               | RAM, DTLS-SRTP wire                       |
| A5 | Server metadata (LOG_EVENTS)     | Backend (in-memory ring nebo SQLite)      |
| A6 | Admin token                      | Operátor / `.env`                         |

## Adversáři

1. **Pasivní síťový odposlech** (MITM) — vidí WSS handshake, DTLS handshake.
   Všechno užitečné je za TLS / DTLS.
2. **Aktivní MITM** — bez TLS by mohl podstrčit jiný server. Proto je
   produkce vždy za HTTPS / WSS s ověřeným certifikátem (`install.sh
   --enable-tls`).
3. **Compromised server** — i kdyby byl server kompromitovaný, nikdy nezíská
   plaintext: klíč nikdy neopustí prohlížeč.
4. **Compromised endpoint** — pokud útočník ovládá prohlížeč jednoho z
   účastníků, je hra u konce. Žádné kryptografické řešení tomu nezabrání.
5. **Phishing / sdílení klíče přes nezabezpečený kanál** — uživatelé musí
   passphrase sdílet out-of-band (Signal, papír, ústně).
6. **Malicious browser extension** — extension v page contextu může číst DOM,
   přečíst plaintext **před** zašifrováním. Web Crypto `extractable: false`
   pomáhá proti exportu klíče, ale ne proti pre-encrypt sniffingu.

## Garance, které dáváme

- **Confidentiality zpráv mezi účastníky** vůči serveru a síti — ano.
- **Integrity zpráv** přes GCM tag — ano. Tampering = `OperationError`.
- **Authenticity účastníka** — pouze v rozsahu *"druhá strana zná klíč"*.
  Pokud passphrase znají třetí strany, autenticita je narušena. Není zde
  certifikační infrastruktura.
- **Forward secrecy** — částečně: nový klíč pokaždé, když je rotován room
  passphrase. WebRTC DTLS handshake přidává PFS pro media. WebSocket TLS PFS
  závisí na konfiguraci serveru / Nginx.

## Co negarantujeme

- **Anonymitu vůči serveru** — server vidí IP a (pokud `LOG_EVENTS=1`) opaque
  ID. Pokud chce uživatel anonymitu, musí přijít přes Tor / VPN.
- **Skrytí faktu komunikace** — server ví, že někdo komunikoval, kdy a s
  kým (po IP). Nezašifrujeme metadata transport vrstvy.
- **Trvalý záznam zpráv** — žádný se neukládá. Pokud uživatel chce historii,
  musí si ji exportovat do svého úložiště.
- **Ochranu proti compromised endpoint** — viz výše. Toto je hard limit
  prohlížečové crypto.

## Crypto detaily

### Odvození klíče
```
material  = PBKDF2( passphrase, salt = "CipherRoom:v1:" || roomId,
                    iter = 250 000, hash = SHA-256 )
roomKey   = HKDF? — ne, přímo derive AES-GCM 256 z material via deriveKey
```

Salt prefix `CipherRoom:v1:` je součástí formátu klíče. Změna prefixu = breaking
migrace; verzujeme `v2:` atd.

### Envelope formát
```json
{
  "iv": "<base64 12 B>",
  "ciphertext": "<base64 ciphertext + 16 B GCM tag>"
}
```

IV se generuje `crypto.getRandomValues`. **Nikdy** ho necachujeme. Reuse IV se
stejným klíčem GCM by leak nonce-aliasing odhalil plaintext rozdíly.

### WebRTC media
DTLS-SRTP. Klíče se vyjednávají v rámci DTLS handshake při setup
RTCPeerConnection. M5cet do toho nezasahuje — používá standardní browser API.

## Admin příkazy

Allowlist v [`server/routes-admin-shared.ts`](../server/routes-admin-shared.ts):

```ts
ADMIN_COMMAND_ALLOWLIST = [
  "refresh-settings",
  "reconnect",
  "purge-local",
  "show-notification",
  "run-diagnostic",
  "download-file-from-admin",
];
```

Bezpečnostní vlastnosti:

- Bez `ADMIN_API_TOKEN` admin proces vrací `503` na všechno kromě
  `/admin/health`.
- Příkaz mimo allowlist: HTTP 400 a žádný přepis na queue.
- `download-file-from-admin` na klientovi **vyžaduje user gesture**.
  V `client/src/lib/admin-commands.ts` se nikdy nevolá automatický download.
- Audit log (`/admin/commands/audit`) je read-only.
- Žádný `exec`, žádný shell, žádný eval — neexistuje cesta k arbitrary remote
  code execution.

## Header hardening

| Header                       | Hodnota                                    |
|------------------------------|--------------------------------------------|
| Cache-Control                | `no-store, no-cache, must-revalidate, ...` |
| X-Content-Type-Options       | `nosniff`                                  |
| Referrer-Policy              | `no-referrer`                              |
| Permissions-Policy           | `camera=(self), microphone=(self), geolocation=(self), interest-cohort=()` |
| X-Robots-Tag (Nginx)         | `noindex, nofollow`                        |

`Permissions-Policy` povoluje kameru, mikrofon a polohu **jen vlastnímu
originu** (`self`); jakýkoli vložený cizí iframe je má zakázané. Prohlížeč
se uživatele dál ptá při každém prvním použití.

> Do verze 2.4.x zde bylo `camera=()` atd. Prázdný allowlist ale funkci
> zakazuje i samotnému dokumentu a user gesture to nepřebije — `getUserMedia`
> a geolokace selhaly bez dotazu (ověřeno: `document.featurePolicy
> .allowsFeature("camera") === false`). Hovory, STT a sdílení polohy proto
> při servírování tímto serverem nefungovaly. Opraveno ve 2.5.0.

## Doporučení pro nasazení

1. **Vždy HTTPS / WSS** v produkci. `install.sh --enable-tls`.
2. **Silný `ADMIN_API_TOKEN`** (≥32 B random). Nikdy v gitu.
3. **`ADMIN_PORT` na private síti** nebo za reverse proxy s IP allowlistem.
4. **`LOG_EVENTS=0`** dokud kompliance opravdu nevyžaduje opak.
5. **`DATABASE_URL`** mít na šifrovaném disku (full-disk encryption).
6. **Aktualizovat OS i Docker base image** — viz `Dockerfile` (`node:24-slim`,
   runtime běží jako `USER node` a neobsahuje `node_modules`).
   `.env` je v `.dockerignore`: tajemství (`ADMIN_API_TOKEN`, VAPID privátní
   klíč, TURN údaje) nesmí skončit ve vrstvě image — předávejte je prostředím.
7. **Reverse proxy timeout** dimenzovat na delší WebSocket session
   (`proxy_read_timeout 3600s` v Nginx — viz `install.sh`).

## Relace a pozvánky (od 2.7.0)

Podrobně v [`session-and-sharing.md`](session-and-sharing.md). Pro model hrozeb
je podstatné:

- **A3 (passphrase) se nově ukládá** — šifrovaně (AES-GCM, neexportovatelný
  klíč v IndexedDB), jen v `sessionStorage` dané karty a nejdéle hodinu bez
  aktivity. Proti adversářům 4 a 6 (kompromitovaný endpoint, rozšíření) to
  nechrání o nic víc než zbytek aplikace.
- **Pozvánky**: klíč k datům je `HKDF(klíč z fragmentu URL ‖ klíč na serveru ‖
  PBKDF2(12místný kód))`. Server sám data nerozšifruje; držitel odkazu má na
  kód 5 pokusů. Odkaz a kód se mají posílat různými kanály.
- **„Smazat vše a odejít"** odstraní úložiště, cookies (přes `Clear-Site-Data`
  i HttpOnly), cache a service worker. **Historii prohlížeče smazat nelze.**

## Účty s passkey a stav away (od 2.9.0)

Podrobně v [`accounts-away.md`](accounts-away.md). Pro model hrozeb:

- **Ověření identity.** Server kontroluje podpis WebAuthn nad vlastní
  jednorázovou výzvou (2 min), rpId hash, origin, user presence + user
  verification a čítač podpisů (klesající = klonovaný autentikátor →
  odmítnuto). Token relace je náhodných 32 B, uložený jen jako SHA-256 otisk
  v paměti procesu; restart odhlásí všechny.
- **Nová aktiva na serveru**: trezor (profil + historie chatu) a schránka
  zpráv. Obojí je **ciphertext** — trezor zapečetěný klíčem z PRF rozšíření
  passkeye (HKDF → AES-GCM), schránka klíčem místnosti. Server zná metadata:
  velikosti, počty, jména v místnosti, časy, zkrácenou IP (/24, /48) a třídu
  prohlížeče u přihlášení.
- **Nové riziko ztráty dat.** Kdo přijde o passkey, přijde o trezor — server
  ho odemknout neumí a záložní cesta neexistuje. Vědomá výměna.
- **Away relay** znamená, že ciphertext zpráv pro nepřítomného účastníka
  **projde serverem a leží tam** (výchozí 30 dní, `RELAY_RETENTION_DAYS`,
  500 položek / 4 MB na účet). Adversář se serverovým přístupem tedy vidí
  objem a metadata komunikace i zpětně — u přímého P2P to neplatilo. Volba
  je per-uživatel a vypnutá, dokud si nezvolí *data na serveru*.
- **Kdo smí poslat do schránky**: kdokoli v téže místnosti (jméno místnosti
  je jediná vstupenka — stejně jako u signalizace). Zprávy, které nesedí na
  klíč místnosti, klient zahodí; limity schránky a 120 relay rámců za minutu
  na socket omezují zahlcení.
- **Probouzecí push** nese jen `<jméno odesílatele> · <místnost>` a odkaz na
  `/signin` — žádný obsah.
- **Klient**: token v `sessionStorage` karty, klíč trezoru jako
  neexportovatelný `CryptoKey` v IndexedDB. Proti adversáři 4 a 6
  (kompromitovaný endpoint, rozšíření) to nechrání — může požádat o
  dešifrování stejně jako aplikace.

## Známé mezery (stav 2.5.0)

Zjištěno revizí kódu a měřením 2026-09-21. Opravené řádky jsou označené
verzí; ostatní vyžadují návrhové rozhodnutí. Berte je v úvahu při nasazení
i auditu.

| # | Mezera | Dopad | Doporučení |
|---|--------|-------|------------|
| 1 | Rate limit WS upgradu se nikdy nespustí (Express middleware není na cestě `upgrade`; změřeno 45/45 přijato při limitu 30/min) | neomezený počet spojení z jedné IP | limitovat v `verifyClient` / vlastním `upgrade` handleru, nebo v reverse proxy (`limit_conn`) |
| 2 | ~~Není nastaveno `trust proxy`~~ **opraveno ve 2.8.0** | IP klienta z `X-Forwarded-For` jen od důvěryhodné proxy; limity jsou per návštěvník | `TRUST_PROXY` (výchozí loopback, v kontejneru i privátní rozsahy; počet hopů / seznam) |
| 3 | ~~`POST /api/push/test`, `GET|POST /api/admin/retention*` bez autentizace~~ **opraveno ve 2.8.1** | bez tokenu už jen self-test push na vlastní id odběru (pevný text); broadcast a retence jen s `ADMIN_API_TOKEN` (`503` bez něj, `401` se špatným; porovnání v konstantním čase, `server/admin-auth.ts`) | routy zůstávají v hlavní službě — stav, na který působí, žije v její paměti; admin proces má prázdné kopie (viz ř. 9 a `docs/admin.md`). Token ≥ 32 B. |
| 4 | `GET /api/turn` vydává statické TURN údaje komukoli | zneužití TURN relaye | efemérní údaje (coturn `use-auth-secret`) |
| 5 | Proxy relay souborů: server drží IV + ciphertext (prvních 256 znaků) v paměti, ale data nedoručuje | funkce nefunguje; metadata o přenosu (počet chunků ≈ velikost) jsou serveru viditelná | dokončit relay, nebo proxy režim vypnout |
| 6 | TOFU otisky klíčované náhodným `peerId` relace; při neshodě se přepíší | panel „Důvěra" nikdy nezachytí změnu protistrany — **nespoléhat na něj** | klíčovat stabilní identitou; při neshodě nepřepisovat bez potvrzení |
| 7 | „Otisk místnosti" = SHA-256 jen z room ID | neověřuje shodu klíče/passphrase | odvodit z klíče (např. HKDF → krátký kód k porovnání) |
| 8 | CSP `script-src unsafe-inline unsafe-eval` | oslabená obrana proti XSS | pro produkci zpřísnit (nonce/hash), ponechat jen pro dev |
| 9 | Admin služba nemá Helmet ani rate limit | brute-force tokenu není brzděn | držet na loopbacku / za proxy s allowlistem; token ≥ 32 B |
| 10 | `download-file-from-admin`: potvrzovací dialog ukazuje jen název, ne URL | uživatel nevidí, odkud stahuje | zobrazit i origin |

Co naopak ověřeno **je**: obálka obsahuje jen `iv` + `ciphertext`, IV má 12 B
a je náhodné pro každý rámec i chunk, klíč je neexportovatelný, špatná
passphrase i pozměněný ciphertext se odmítnou, admin token se porovnává
v konstantním čase, příkaz mimo allowlist vrací `400`, `.env` se nedostává
do Docker image.

## Reportování zranitelností

Otevřete prosím *Security advisory* v repozitáři, ne veřejný issue:
<https://github.com/m5ike/cipherroom-secure-chat/security/advisories>.
