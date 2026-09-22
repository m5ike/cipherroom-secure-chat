# M5cet — řešení potíží / Troubleshooting

## Diagnostické příkazy

```bash
# Hlavní služba
curl -fsS http://127.0.0.1:5000/api/health | jq .
curl -fsS http://127.0.0.1:5000/api/modules | jq .

# Admin služba (vyžaduje token)
curl -fsS http://127.0.0.1:5050/admin/health | jq .
curl -fsS -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  http://127.0.0.1:5050/admin/metrics | jq .

# Doctor (samostatně)
sudo -E /opt/m5cet/install.sh --doctor
sudo -E /opt/m5cet/install.sh --test    # alias pro --doctor
```

## Časté problémy

### Za doménou běží vývojový server (403 na `/@fs/…`, HMR websocket padá)

Příznaky v konzoli prohlížeče: `GET https://<doména>/@fs/opt/m5cet/node_modules/.vite/deps/… 403`,
`[vite] connecting…`, `WebSocket connection to 'wss://<doména>/vite-hmr' failed`,
`(browser) <doména>/ <--[HTTP]--> localhost:5173/ (server)`.

Příčina: nginx proxuje na **`npm run dev`** (Vite dev server, typicky port 5173),
ne na produkční build. Dev server v produkci nepatří — bez minifikace, s HMR
socketem, který přes proxy neprojde a koliduje s `/ws`, a s přísným „fs
strict" servírováním, které při symlinkovaném/přesunutém adresáři odmítá
`/@fs/…` (odtud 403).

Náprava:

```bash
cd /opt/m5cet
npm run build
```

a spustit produkční proces (`NODE_ENV=production node dist/index.cjs`, resp.
systemd unit / `./update.sh` / Docker), a v nginx nasměrovat `/api`, `/ws`,
`/wh`, `/goodbye` na **produkční port** (výchozí 5000, `APP_PORT`) — viz
[deploy/nginx/m5cet.conf](../deploy/nginx/m5cet.conf). Dev server (`npm run
dev`) ukončit. Od verze 2.8 dev server navíc povoluje i reálnou cestu repa
(symlinky) a zamítá jen skutečná tajemství (`.env*`, `.git`, `.m5cet`, `*.key`,
`*.pem`), takže případný lokální vývoj za proxy už 403 nedává.

### 1. "Zpráva přišla, ale nedá se rozšifrovat"

Druhá strana má **jiný klíč místnosti**. Zkontrolujte:

- Stejný `room id` (case sensitive).
- Stejná passphrase, žádné mezery navíc.
- Žádný update klienta uprostřed relace, který by změnil verzi salt prefixu.

Náprava: oba uživatelé znovu zadají passphrase. Nový klíč nahradí starý v paměti.

### 2. "WebSocket signaling nedostupné"

- Zkontrolujte, že server běží: `curl http://127.0.0.1:5000/api/health`.
- Když je za Nginx, zkontrolujte `proxy_set_header Upgrade $http_upgrade`
  a `proxy_set_header Connection "upgrade"`.
- TLS reverse proxy musí WSS upgrade propustit. Cloudflare Free tier WSS
  podporuje, ale s 100 s timeoutem — `connection-keeper` to absorbuje.

### 3. WebRTC se nepřipojí, peer zůstane "joining"

- WebRTC potřebuje **secure context** mimo `localhost`. Bez HTTPS / WSS to
  nepůjde.
- Kontrolovat NAT / firewall. STUN se používá z public Google STUN; pro
  carrier-grade NAT je třeba TURN — ten M5cet *neprovozuje*. Lze přidat
  vlastní `coturn` a doplnit `iceServers` v App.tsx.
- Symetrický NAT z mobilní sítě bez TURN = neprůchozí. Důvod je
  dokumentován v [`docs/browser-limitations.md`](browser-limitations.md).

### 4. Push notifikace nedoručené

- `GET /api/push/status` musí vrátit `{ enabled: true, vapidPublicKey: "..." }`.
- Service worker musí být aktivní (`navigator.serviceWorker.controller`
  v devtools).
- Browser musí mít udělený `Notification.permission === "granted"`.
- Mobil může endpoint zmrazit; doručení je *best effort*.

### 5. Soubor nelze odeslat / přerušení uprostřed

- *„File exceeds inline cap of 512.0 kB; use chunked transfer"* — chyba verzí
  < 2.6.0: tlačítka u zprávy uměla jen inline cestu. Od 2.6.0 se větší soubor
  pošle po částech automaticky.
- *„Soubor nelze odeslat: není připojen žádný peer"* — přenos jde jen přímým
  P2P kanálem; počkejte, až stavový štítek ukáže `1 P2P`.

- Zkontrolujte `Preferences.maxAttachmentBytes` (výchozí neomezeno; v Nastavení
  lze zvolit nižší strop, např. 100 MB).
- Přenos funguje **jen s otevřeným DataChannelem**. Záložní „proxy" režim přes
  server data zatím nedoručuje (viz [`files.md`](files.md)) — když se P2P
  nespojí, soubor nedorazí, i když odesílatel vidí průběh.
- Velmi velké soubory blízko hranice browser RAM = `QuotaExceededError`.
  Snižte cap a soubor rozdělte mimo aplikaci.
- Když `RTCDataChannel.readyState !== "open"`, klient čeká. Zkontrolujte ICE
  state v devtools (chrome://webrtc-internals).

### 6. Admin příkaz nedoražil ke klientovi

- **Ve výchozím dvouprocesovém nasazení příkazy nedorazí nikdy:** fronta žije
  v paměti admin procesu, klienti se ptají hlavní služby (viz
  [`admin.md`](admin.md)).
- `command-poll` se posílá jednou po otevření signalizačního socketu.
- `/admin/commands/audit` ukáže timestamp `enqueue` a (pokud klient ackoval)
  `ack`. Když ack chybí, klient nedostal zprávu.
- Chyba `deviceId must be 4-64 [a-zA-Z0-9_-].` znamená, že enqueue body
  neobsahuje validní `deviceId` (povolen je i `peerId`, ale alespoň jedno
  musí být validní formát).

### 7. NFC nefunguje

- Web NFC je **pouze Android Chrome**. iOS a desktop ho nemají.
- `navigator.nfc` musí existovat; `NDEFReader` API.
- Tag musí být NTAG21x nebo kompatibilní; málo zápisů → vyměnit tag.

### 8. Speech recognition nestartuje

- Funkční pouze Chromium / Android. UI to detekuje a tlačítko schová,
  pokud `capabilities.speech === false`.
- Vyžaduje povolený mikrofon (HTTPS + permission).

### 9. Prázdný admin GUI

- Service `admin-ui` v docker-compose je profile=admin, takže se musí
  spustit s `--profile admin`:
  ```bash
  docker compose --profile admin up -d
  ```
- Bez tokenu vidíte pouze `/admin/health`. UI zobrazuje login.

### 10. Po updatu nesedí verze v `/api/health`

- Po `install.sh --update` proběhne `docker compose up -d --build`.
- Když se kontejner nepřebalil, `--no-cache` lze vynutit:
  ```bash
  cd /opt/m5cet && docker compose build --no-cache && docker compose up -d
  ```

### 11. `npm run dev` / `npm start` hned spadne na macOS

- `Error: listen EADDRINUSE :::5000` — port 5000 drží *AirPlay Receiver*
  (proces ControlCenter). Spusťte `PORT=5173 npm run dev`, nebo AirPlay
  Receiver vypněte v Nastavení → Obecné → AirDrop a Handoff.
- `Error: listen ENOTSUP` — verze < 2.5.0 volaly `listen({ reusePort: true })`,
  což macOS nepodporuje. Opraveno ve 2.5.0.

### 12. Hovor / mikrofon / poloha selže okamžitě, bez dotazu prohlížeče

- Ve verzích < 2.5.0 to způsobovala hlavička `Permissions-Policy: camera=()…`
  (viz [`security-model.md`](security-model.md)). Ověření v konzoli:
  `document.featurePolicy.allowsFeature("camera")` musí vrátit `true`.
- Stejný efekt má reverse proxy, která hlavičku **přepisuje** vlastní
  restriktivní hodnotou — zkontrolujte `add_header Permissions-Policy` v Nginx.
- Mimo `localhost` je nutný secure context (HTTPS).

### 13. `git commit` odmítne pre-commit hook

- Spusťte `npm run check:menu:verbose` a podívejte se, která z 8 kontrol padá.
- Hook se zapíná jednorázově: `git config core.hooksPath .githooks`.
- Verze < 2.5.0 na macOS padaly vždy na kontrole 3 (`\s` v BSD awk) — nešlo
  o chybu v CSS. Opraveno.

### 14. Testy „prošly", ale je jich podezřele málo

- `npm test` má hlásit **10 souborů / 106 testů**. Pokud chybí `.tsx` soubory,
  zkontrolujte `"jsx": "react-jsx"` v `tsconfig.json` a plugin
  `@vitejs/plugin-react` ve `vitest.config.ts` — s `"preserve"` testy tiše
  spadnou už při transformaci.
- E2E: `npx playwright install chromium` a poté `npm run test:e2e`.

### 15. `error TS5102: Option baseUrl has been removed`

- TypeScript 7 `baseUrl` nezná. Aliasy patří do `paths` s cestami relativními
  k `tsconfig.json` (`"@/*": ["./client/src/*"]`).

### 16. Pozvánka nefunguje

- *„Pozvánka neplatí"* — vypršela, vyčerpal se počet připojení, byla
  zneplatněna, **nebo se restartoval server** (pozvánky jsou jen v paměti).
- *„Příliš mnoho špatných pokusů"* — po 5 špatných kódech se odkaz zničí;
  vytvořte nový.
- Odkaz po otevření zmizí z adresního řádku — to je záměr, ne chyba.

### 17. Po reloadu se aplikace nepřipojila sama

- Karta byla mezitím zavřená, uplynula hodina bez aktivity, nebo byl naposledy
  stisknut *Odpojit* (pak stačí *Místnost → Připojit*, klíč je předvyplněný).
- V anonymním okně některé prohlížeče IndexedDB omezují — klíč cache se pak
  drží jen v paměti a reload ho nepřežije.

## Diagnostické logy

```bash
# Dev
npm run dev      # stdout obsahuje request log

# Docker
docker compose logs -f app
docker compose --profile admin logs -f admin
```

## Hlášení chyb

Otevřete issue s:

1. Verzí (`npm pkg get version`) a verzí Node (`node --version`, nutné ≥ 22).
2. Browser + OS.
3. `curl /api/health` výstupem.
4. Reprodukcí (kroky → očekávané → skutečné).
