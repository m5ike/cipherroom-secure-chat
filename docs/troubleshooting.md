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

- Zkontrolujte `Preferences.maxAttachmentBytes` (default 100 MB).
- Velmi velké soubory blízko hranice browser RAM = `QuotaExceededError`.
  Snižte cap a soubor rozdělte mimo aplikaci.
- Když `RTCDataChannel.readyState !== "open"`, klient čeká. Zkontrolujte ICE
  state v devtools (chrome://webrtc-internals).

### 6. Admin příkaz nedoražil ke klientovi

- `command-poll` se posílá při `join` i při `visibilitychange`. Klient v
  pozadí stažený nemusí ihned polovat.
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

1. Verzí (`npm pkg get version`).
2. Browser + OS.
3. `curl /api/health` výstupem.
4. Reprodukcí (kroky → očekávané → skutečné).
