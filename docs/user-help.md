# M5cet — uživatelská nápověda / User help

## Česky

### První spuštění
1. Otevři aplikaci v moderním prohlížeči (Chrome, Edge, Firefox, Safari).
2. Klikni na logo nebo „Připojit" — otevře se dialog místnosti.
3. Vyplň jméno, Room ID a klíč místnosti. Klíč sdílej s druhou stranou
   **mimo tento chat** (signal, papír, telefon).
4. Po stisku Připojit se klíč odvodí lokálně (PBKDF2). Server klíč nikdy nevidí.

### Přepínání témat
Lišta nahoře → ikona palety → vyber Motorsport Dark / Glass Light / Terminal Secure.
Volba se uloží lokálně do prohlížeče.

### Nastavení
- **Jazyk** — čeština / English / Deutsch
- **Časové pásmo** — řídí zobrazení časů zpráv
- **Písmo a velikost** — ergonomie pro mobil i desktop
- **Vizuální efekty** — vypni pro slabší zařízení

### Profil
Lišta → ikona uživatele. Jméno a avatar (emoji nebo URL) se posílají s každou zprávou
ostatním peerům, ne na server.

### Soukromí & audit
- **Smazat lokální preference** — vymaže Tě z `localStorage` tohoto prohlížeče.
- **Smazat serverové logy a sync data** — pošle `POST /api/audit/purge` s tvým
  device ID. Tím zmizí settings sync, audit log a push subskripce navázané na
  tento prohlížeč.

### Šifrování
Šifrovací panel ti řekne, co se přesně používá — DTLS-SRTP pro audio, AES-GCM pro
texty/přílohy, PBKDF2 pro odvození klíče. Žádné „100 % bezpečné" sliby.

### TTL — expirace zpráv
- **Default TTL pro mé zprávy** (Šifrování → TTL): počet minut, po kterých se
  moje zprávy automaticky odstraní z UI všech peers (klient-side).
- **Override pro místnost** (Bezpečnost místnosti): hodnota přebíjí default,
  pokud je nenulová.
- **Absolutní TTL místnosti**: tvrdší limit shora (kratší ze dvou se použije).

### Notifikace
Lišta → zvonek. Pokud server má nakonfigurované VAPID klíče, použije se Web Push.
Jinak fallback na lokální notifikace v tabu.

### Analytika a souhlas
Souhlas je opt-in. Bez něj klient neposílá žádné `POST /api/events`. Po souhlasu se
loguje jen kind/peerId/room/peerCount — nikdy plaintext zprávy.

### Limitace
- TTL vynucuje klient. Není to právně závazná „mizící zpráva".
- Aktuálně všichni v místnosti používají sdílený klíč. Ten je tak silný jako jeho
  out-of-band předání.
- Sync settings, audit log a analytics consent jsou v této fázi v paměti procesu.

---

## English

### First run
1. Open the app in a modern browser.
2. Click the brand logo or "Connect" to open the room dialog.
3. Provide name, Room ID and the room key. Share the key out-of-band.
4. The key is derived locally with PBKDF2 — the server never sees it.

### Themes
Top bar → palette icon → pick Motorsport Dark, Glass Light, or Terminal Secure.

### Settings
Language (cs/en/de), timezone, font family/size, visual effects toggle.

### Privacy & audit
Local purge clears `localStorage`. Server purge sends `POST /api/audit/purge` with
your device id and removes settings sync, audit log, push subs.

### TTL
Default per-message TTL, room override, room absolute cap. Client-enforced.

### Limitations
Same as the Czech section above.

---

## Deutsch

### Erste Schritte
1. App in einem modernen Browser öffnen.
2. Brand-Logo oder "Verbinden" klicken, Raum-Dialog erscheint.
3. Name, Raum-ID und Raum-Schlüssel angeben. Schlüssel out-of-band teilen.
4. PBKDF2 leitet den Schlüssel lokal ab — Server sieht ihn nie.

### Vorlagen
Top-Leiste → Paletten-Icon → Motorsport Dark / Glass Light / Terminal Secure.

### Einstellungen
Sprache (cs/en/de), Zeitzone, Schrift, Größe, visuelle Effekte.

### Datenschutz
Lokale Reinigung löscht `localStorage`. Server-Purge sendet
`POST /api/audit/purge` mit deiner Geräte-ID.

### TTL
Standard-TTL je Nachricht, Raum-Override, absolute Raum-Obergrenze. Vom Client erzwungen.

### Einschränkungen
Siehe Czech-Abschnitt oben.
