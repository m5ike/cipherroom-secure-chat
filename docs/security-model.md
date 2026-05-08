# M5cet — bezpečnostní model

Tento dokument popisuje, **co M5cet chrání, jak to chrání, a co naopak
chránit nemůže**. Je psán pro ty, kdo M5cet nasazují nebo auditují.

## TL;DR

- Server vidí pouze signalizační rámce (SDP/ICE) a (volitelně) opaque
  metadata. **Nikdy** plaintext, IV, ciphertext zprávy, ani klíč.
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
| Permissions-Policy           | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |
| X-Robots-Tag (Nginx)         | `noindex, nofollow`                        |

`Permissions-Policy` je úmyslně restriktivní; appka si je sama volá inline
přes user gesture.

## Doporučení pro nasazení

1. **Vždy HTTPS / WSS** v produkci. `install.sh --enable-tls`.
2. **Silný `ADMIN_API_TOKEN`** (≥32 B random). Nikdy v gitu.
3. **`ADMIN_PORT` na private síti** nebo za reverse proxy s IP allowlistem.
4. **`LOG_EVENTS=0`** dokud kompliance opravdu nevyžaduje opak.
5. **`DATABASE_URL`** mít na šifrovaném disku (full-disk encryption).
6. **Aktualizovat OS i Docker base image** — viz `Dockerfile`.
7. **Reverse proxy timeout** dimenzovat na delší WebSocket session
   (`proxy_read_timeout 3600s` v Nginx — viz `install.sh`).

## Reportování zranitelností

Otevřete prosím *Security advisory* v repozitáři, ne veřejný issue:
<https://github.com/m5ike/cipherroom-secure-chat/security/advisories>.
