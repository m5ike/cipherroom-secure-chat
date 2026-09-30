# Registration and passkeys on Android (6.4)

Two things that belong together: a **registration form** that creates a
passkey account from a person's name, country, mobile and e-mail (web and
Android), and the **Android passkey chain** — why a phone can fail to use the
server's passkeys at all, how the app and the console now say so, and how to
fix it.

## Registration

**Where:** the main menu's *Registration* (shown while signed out), the
*Registration* button in the Connection window (web) or on *Settings › User*
(Android), and the ⋮ menus of the Android room and room list.

**Fields:** first name, last name, country (a searchable list — name, ISO
code or calling code, accents ignored), mobile (the country's `+dial` shown as
a prefix; a national or an international number), e-mail.

### What is checked

| Field | Checked by both apps | Checked by the server |
|---|---|---|
| Names | required, ≤ 64 characters, letters / marks / space / `.` `'` `’` `-` | the same |
| Country | one of libphonenumber's countries | the same |
| Mobile | a valid number (E.164) | full metadata: refuses numbers that cannot be a mobile — landline, toll free, premium, VoIP, … ("can't tell" is accepted) |
| E-mail | syntax, lower-cased, domain in ASCII (punycode) | DNS: the domain exists (else `no-domain`) and has an MX record that is not a null MX (else `no-mx`); a DNS failure is `dns-unavailable` — try again |
| Uniqueness | — | neither the e-mail nor the mobile may belong to an account already (`taken`) |

The shared checks live in
[`client/src/lib/registration/form.ts`](../client/src/lib/registration/form.ts)
(the web form and the server run the same code); the server-only ones in
[`server/accounts/registration.ts`](../server/accounts/registration.ts). The
Android app mirrors the light checks and relies on the server's answer.

### The flow

1. `POST /api/account/register/check` — the form → normalized values or
   per-field error codes.
2. `POST /api/account/register/start` — the same body, checked again (never
   trusting step 1) → a new **username** and the passkey creation options.
   The challenge carries the contact hashes, so the client cannot swap them.
3. The passkey is created exactly like *Create an account*: the PRF
   extension yields the account root, the key proof goes to
   `POST /api/account/register/verify`, which creates the account, stores the
   contact hashes and re-checks uniqueness (a registration in between → 409
   `taken`).

   Before any of this, an Android build that the server would refuse (its
   signing certificate is not listed — see below) gets `403 app-not-trusted`
   from `/register/check` and `/register/start`: no passkey is created that
   the server would then reject.
4. The profile `{ firstName, lastName, country, phone, email, registeredAt }`
   is sealed with the vault key and stored in the vault's own
   **`registration`** slot (`PUT /api/account/vault`).
5. The device's data is straightened into the new account — on the web the
   anonymous session's database is promoted and the vault is synced, as after
   any sign-in.

**The username** of a registered account (6.4.1) is `XXXX-XXXX-XXXX-XXXX`,
each `X` one of `0-9 a-z A-Z` (62 symbols): 62¹⁶ ≈ 4.8·10²⁸ names, about
95 bits — e.g. `aZ3k-9QpL-x7Rt-M2nB`. It is not derived from anything typed.
Usernames are unique case-insensitively, so two accounts never differ by case
alone. The anonymous *Create an account* keeps its two-word usernames.

**The passkey's name** — what the password manager lists (WebAuthn
`user.name` / `displayName`) — is the country and a scrambled
`First-Last-Mobile`: `CZ-Mi3ale-Ko38a-7a73kassa`. The mobile is its national
number; Latin letters are folded to ASCII (Ł → L, á → a), spaces and
punctuation dropped, another script kept as it is; each part is capped (16 /
16 / 15). *Scramble* picks about 20 % of the characters (never the hyphens,
at least two) and moves each to the next picked place in a random cycle — the
same characters, not in their places. The user handle (`user.id`) stays the
username, which is how a sign-in names its account. The name lives only in
the password manager; the server makes it for `/register/start` and keeps
nothing of it.

### Privacy

- The server keeps **no** name, country, phone or e-mail. An account created
  with the form carries only `contact: { email, phone }` — HMAC-SHA256 of the
  normalized values, keyed with a random pepper in
  `$ACCOUNTS_DIR/registration.json` (0600) or `REGISTRATION_PEPPER` (hex, ≥ 32
  bytes). Losing the pepper keeps every account valid; only the duplicate
  check forgets older registrations.
- The profile itself is ciphertext the server cannot open (the `registration`
  vault slot — the vault file, or the user's SQLCipher database).
- The values pass through the server only transiently during `check` /
  `start` (to parse the number and ask DNS about the domain). Nothing is
  logged: the audit records field names and error codes only
  (`account.register.check`, e.g. `email:no-mx,phone:not-mobile`).
- The check answers whether an e-mail or phone is registered, so it is rate
  limited (20 requests / 10 minutes / address) and audited.
- Deleting the account frees its e-mail and phone for a new registration.

### API

| | |
|---|---|
| `GET /api/account/countries` | `{ countries: [{ code: "CZ", dial: "420" }, …] }` |
| `POST /api/account/register/check` | `{ firstName, lastName, country, phone, email }` → `200 { normalized }` · `400/409/503 { errors: { field: code }, message }` · `429` |
| `POST /api/account/register/start` | same body → `200 { username, keyName, normalized, publicKey }` |
| `POST /api/account/register/verify` | unchanged; new `409 { code: "taken", errors }`, `400 { code: "origin-not-allowed" }` |
| `GET/PUT /api/account/vault` | new slot `registration` (sealed like `profile`) |

Field codes: `required`, `too-long`, `invalid`, `not-mobile`, `no-domain`,
`no-mx`, `dns-unavailable`, `taken`. The account summary gains
`registered: true`.

## Passkeys on Android

The app signs in with the **same passkeys as the browser** through Android's
Credential Manager. Before it lets an app use a site's passkeys, Android asks
Google's Digital Asset Links service whether the site declares that app:

```
https://<rpId>/.well-known/assetlinks.json
  → delegate_permission/common.get_login_creds
  → android_app cz.m5cet.app + SHA-256 of the app's signing certificate
```

The server answers that file itself (`server/android/app-links.ts`) with the
certificates it knows. If the file does not reach the internet, or does not
list the certificate that signed the installed build, **every** passkey
operation on Android fails with a WebAuthn `SecurityError` ("The incoming
request cannot be validated") — sign-in, *Create an account*, registration,
adding a passkey.

### The two usual causes

1. **The reverse proxy blocks `/.well-known/`.** Hosting panels often deny
   every dot path (`location ~ /\. { deny all; }`) or keep `/.well-known/`
   for certificate challenges; the file then answers 403 or an HTML page.
   Add an exact location — it wins over the regex rule:

   ```nginx
   location = /.well-known/assetlinks.json {
       proxy_pass http://127.0.0.1:5000;        # the app's port
       proxy_http_version 1.1;
       proxy_set_header Host              $host;
       proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   then `sudo nginx -t && sudo systemctl reload nginx`. The installer's own
   nginx site and `deploy/nginx/m5cet.conf` already pass it through.

2. **The build's certificate is not listed.** The server lists the
   certificates of the uploaded releases (Android › Releases), those in
   `ANDROID_DEBUG_CERT_SHA256`, and — since 6.4 — the ones trusted in the
   console. A developer's debug build is signed with that machine's debug
   key; trust its certificate, or install a release build.

Google caches the file for a few minutes: after a fix, check again shortly.

### No orphan passkeys (6.4.1)

A password manager that does not check `assetlinks.json` itself (some do
not) creates the passkey anyway, and the server then refuses its origin —
leaving a passkey the person has to delete by hand. So the Android app sends
its certificate's SHA-256 with every account request (`X-M5-App-Cert`), and
every endpoint that starts a passkey ceremony — `/register/check`,
`/register/start`, `/register/options`, `/signin/options`,
`/passkeys/options`, `/recovery/start` — answers `403 { code:
"app-not-trusted", certSha256, known }` when this server would refuse that
app's origin. The app shows the certificate dialog instead; nothing is
created. The web sends no such header and is not affected. The operator's
audit logs `account.app-not-trusted` with the fingerprint's start.

### What shows it

- **The app** — a failed passkey operation with `SecurityError` opens *This
  server hasn't confirmed the app*: the server host, the app's package and the
  SHA-256 of its signing certificate (with *Copy*). Every check-in also
  reports that certificate to the server.
- **The console** — *Android › Security › Passkeys on Android* checks the
  chain as a phone would: what this server would answer, what
  `https://<rpId>/.well-known/assetlinks.json` returns from the internet
  (status, content type, fingerprints), what Google sees, the certificates the
  server knows (release / env / trusted) and those the phones report. It gives
  a verdict (`ok`, `blocked`, `not-json`, `missing-cert`, `google-stale`,
  `no-certs`), plain hints and — when the proxy blocks the file — the nginx
  block above. `GET /api/admin/android/passkeys`.
- **Trust for passkeys** — a phone's certificate can be trusted with one
  click (`POST /api/admin/android/passkeys/trust`, operator right *settings*;
  untrust with `DELETE …/trust/<sha256>`). A trusted certificate goes into
  `assetlinks.json` and the WebAuthn app origin **only** — never into the
  release check, so it cannot be used to publish an APK. Any app signed with
  it can use the server's passkeys: trust only your own builds.
- **`update.sh`** — after every update it fetches the public
  `assetlinks.json` and, when the proxy blocks it, prints the nginx block.
  It never fails the update.
