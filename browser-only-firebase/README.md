# CipherRoom Lite

Browser-only varianta šifrovaného P2P chatu. Nepotřebuje vlastní server, VPS, iCloud ani Node runtime.

## Jak to funguje

- `index.html`, `styles.css` a `app.js` lze otevřít jako statický web.
- Firebase Realtime Database slouží pouze jako dočasný signaling pro WebRTC: peer presence, offer, answer a ICE candidates.
- Chat zprávy se neposílají přes Firebase. Po navázání spojení jdou přes WebRTC DataChannel přímo mezi prohlížeči.
- Text zprávy je před odesláním šifrován přes Web Crypto `AES-GCM`.
- Room cesta ve Firebase je `SHA-256(room + passphrase)` v base64url tvaru, takže skutečný název místnosti není v DB vidět.
- Aplikace nepoužívá `localStorage`, `sessionStorage`, cookies ani IndexedDB.

## Co je potřeba

1. Firebase projekt.
2. Realtime Database v testovacím regionu podle preference.
3. Web app config z Firebase Console.
4. Rules z `firebase-rules.json`.

## Firebase setup

Firebase Console:

1. Project settings → Your apps → Web app.
2. Zkopírovat `firebaseConfig`.
3. Realtime Database → Rules.
4. Vložit obsah `firebase-rules.json`.
5. Publish.

Web config vypadá přibližně takto:

```json
{
  "apiKey": "...",
  "authDomain": "project.firebaseapp.com",
  "databaseURL": "https://project-default-rtdb.europe-west1.firebasedatabase.app",
  "projectId": "project",
  "appId": "1:000000000000:web:0000000000000000000000"
}
```

## Spuštění

Lokálně:

```text
Otevři index.html v moderním prohlížeči.
```

Statický hosting:

```text
Nahraj složku browser-only-firebase na libovolný statický hosting.
```

To může být Netlify, GitHub Pages, obyčejný Apache/Nginx hosting, ISPConfig web bez Node podpory, Firebase Hosting nebo lokální soubor.

## Cache

Aplikace neukládá nic do browser storage a nemá service worker.

Soubory obsahují:

- HTML meta no-cache/no-store.
- `_headers` pro Netlify kompatibilní hosting.
- `.htaccess` pro Apache hosting s povoleným `mod_headers`.

U čistého `file://` otevření se HTTP cache hlavičky nepoužijí, protože nejde o HTTP request. U libovolného statického hostingu musí server respektovat `_headers`, `.htaccess`, nebo ekvivalentní Nginx/Firebase Hosting pravidla.

## Test se dvěma peery

1. Otevři `index.html` ve dvou prohlížečích nebo anonymních oknech.
2. Do obou vlož stejný Firebase config.
3. Do obou zadej stejnou místnost.
4. Do obou zadej stejnou passphrase.
5. Klikni na „Připojit místnost“.
6. Po otevření DataChannelu napiš zprávu.

## Omezení

- Firebase Realtime Database není vlastní server, ale je to externí cloudový signaling bus.
- Bez Firebase Auth pravidel nejde vynutit identitu uživatele. Přístup je chráněn neuhodnutelnou room cestou odvozenou z passphrase a pravidly validujícími tvar dat.
- TURN server není zabudovaný. Přes běžný NAT většinou stačí veřejné STUN servery, ale u restriktivních sítí může P2P spojení selhat.
- Pokud chceš vyšší spolehlivost přes firewally, přidej TURN server do `iceServers` v `app.js`.

## Bezpečnostní poznámky

- Firebase API key v browser aplikaci není tajemství. Bezpečnost se řeší Firebase Rules a návrhem datových cest.
- Nepoužívej krátké passphrase. Doporučení: 16+ znaků, náhodná slova nebo generovaná fráze.
- Aplikace neposkytuje forward secrecy nad rámec WebRTC transport security a aplikačního AES-GCM klíče odvozeného z passphrase.
- Pokud někdo zná stejnou místnost a passphrase, může se připojit jako další peer.
