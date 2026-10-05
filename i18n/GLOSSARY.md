# M5cet — glossary and rules for translators (6.13)

Languages: **en** (source), **cs**, **de** (existing), new: **es, it, fr, sk, sl, fi**.
Sources: `i18n/source/*.json` (`{ key: { en, cs, de } }`, from `npx tsx script/i18n-extract.ts`).
Targets: `i18n/locales/<lang>/<same file name>.json` — flat `{ key: text }`, every key of the source,
UTF-8, keys sorted as in the source.

## Rules

1. Translate from **English**; use the Czech and German texts for context (Czech is the original
   in most of the app — when English and Czech disagree in meaning, follow Czech).
2. Keep **exactly**: `{placeholders}` (same names, same count), `$variables`, `%s`/`%d`, HTML/markup
   tags, `\n` line breaks, leading/trailing spaces, keyboard keys (Ctrl, Enter, Esc), file names,
   code (`/help`, `m5.nfc`, env names), URLs, units, and product names: **M5cet**, Signal, WhatsApp,
   Threema, Telegram, Android, iOS, Windows, macOS, WebRTC, TURN, STUN, NFC, EMV, e-ID, SIP, TSA, AI,
   Argon2id, AES-GCM, ML-KEM, passkey (see table).
3. **Address:** formal in **de** (Sie), **cs** (vy), **sk** (vy), **sl** (vi), **fr** (vous);
   informal in **es** (tú), **it** (tu); **fi** neutral standard UI language (imperative, no
   pronoun where possible). Button labels are verbs in the imperative / infinitive as is usual on
   each platform (es/it/fr/fi: infinitive or imperative as common in their OS UIs).
4. **Length:** keep labels about as short as the English one (buttons, menu items, chips); if a
   language is longer, prefer a shorter synonym.
5. **Quotes and punctuation:** cs/sk/sl/de „…“, fr « … » (non-breaking space inside), es/it «…»,
   fi ”…”, en “…”. French: non-breaking space before `: ; ! ?`. Spanish: `¿…?` and `¡…!`.
   Numbers/dates are formatted by the app (Intl) — do not hard-code formats.
6. Security texts must stay **accurate and honest** — do not soften warnings, do not add claims.
7. Do not translate keys, IDs or enum values. If a source text is empty, the target is empty.
8. Characters: write proper diacritics (č ď ě ň ř š ť ů ž, ľ ĺ ŕ ô ä, č š ž, ä ö å, é è ê à ç
   œ, ñ á í ó ú ü, à è é ì ò ù) — never ASCII substitutes.

## Terms

| en | cs | de | es | it | fr | sk | sl | fi |
|---|---|---|---|---|---|---|---|---|
| room | místnost | Raum | sala | stanza | salle | miestnosť | soba | huone |
| room key / passphrase | klíč místnosti / heslo | Raumschlüssel / Passphrase | clave de la sala | chiave della stanza | clé de la salle | kľúč miestnosti | ključ sobe | huoneen avain |
| member | člen | Mitglied | miembro | membro | membre | člen | član | jäsen |
| message | zpráva | Nachricht | mensaje | messaggio | message | správa | sporočilo | viesti |
| private message | soukromá zpráva | private Nachricht | mensaje privado | messaggio privato | message privé | súkromná správa | zasebno sporočilo | yksityisviesti |
| end-to-end encrypted | koncově šifrovaný (E2EE) | Ende-zu-Ende-verschlüsselt | cifrado de extremo a extremo | crittografato end-to-end | chiffré de bout en bout | koncovo šifrovaný (E2EE) | šifrirano od konca do konca | päästä päähän salattu |
| passkey | passkey (přístupový klíč) | Passkey | llave de acceso (passkey) | passkey | clé d’accès (passkey) | prístupový kľúč (passkey) | ključ za dostop (passkey) | pääsyavain (passkey) |
| account | účet | Konto | cuenta | account | compte | účet | račun | tili |
| device | zařízení | Gerät | dispositivo | dispositivo | appareil | zariadenie | naprava | laite |
| safety number | bezpečnostní číslo | Sicherheitsnummer | número de seguridad | numero di sicurezza | numéro de sécurité | bezpečnostné číslo | varnostna številka | turvanumero |
| verified | ověřený | verifiziert | verificado | verificato | vérifié | overený | preverjen | vahvistettu |
| new key (not verified) | nový klíč (neověřený) | neuer Schlüssel (nicht verifiziert) | clave nueva (sin verificar) | nuova chiave (non verificata) | nouvelle clé (non vérifiée) | nový kľúč (neoverený) | nov ključ (ni preverjen) | uusi avain (ei vahvistettu) |
| key transparency | průhlednost klíčů | Schlüsseltransparenz | transparencia de claves | trasparenza delle chiavi | transparence des clés | transparentnosť kľúčov | preglednost ključev | avainten läpinäkyvyys |
| call | hovor | Anruf | llamada | chiamata | appel | hovor | klic | puhelu |
| file | soubor | Datei | archivo | file | fichier | súbor | datoteka | tiedosto |
| invitation | pozvánka | Einladung | invitación | invito | invitation | pozvánka | povabilo | kutsu |
| settings | nastavení | Einstellungen | ajustes | impostazioni | paramètres | nastavenia | nastavitve | asetukset |
| function / command / model | funkce / příkaz / model | Funktion / Befehl / Modell | función / comando / modelo | funzione / comando / modello | fonction / commande / modèle | funkcia / príkaz / model | funkcija / ukaz / model | funktio / komento / malli |
| server operator | provozovatel | Betreiber | operador | operatore | opérateur | prevádzkovateľ | upravljavec | ylläpitäjä |
| console (admin) | konzole | Konsole | consola | console | console | konzola | konzola | konsoli |
| away (presence) | pryč | abwesend | ausente | assente | absent | preč | odsoten | poissa |
| online | online | online | en línea | online | en ligne | online | povezan | paikalla |
| vanishing message | mizející zpráva | verschwindende Nachricht | mensaje temporal | messaggio effimero | message éphémère | miznúca správa | izginjajoče sporočilo | katoava viesti |
| sealed message | zapečetěná zpráva | versiegelte Nachricht | mensaje sellado | messaggio sigillato | message scellé | zapečatená správa | zapečateno sporočilo | sinetöity viesti |
| relay (server delivery) | relay | Relay | relé | relay | relais | relay | posredovanje (relay) | välitys (relay) |
| app lock | zámek aplikace | App-Sperre | bloqueo de la app | blocco app | verrouillage de l’app | zámok aplikácie | zaklep aplikacije | sovelluksen lukitus |
| notification | upozornění | Benachrichtigung | notificación | notifica | notification | upozornenie | obvestilo | ilmoitus |
| profile | profil | Profil | perfil | profilo | profil | profil | profil | profiili |
| telephony | telefonie | Telefonie | telefonía | telefonia | téléphonie | telefónia | telefonija | puhelinpalvelut |
| Send | Odeslat | Senden | Enviar | Invia | Envoyer | Odoslať | Pošlji | Lähetä |
| Cancel | Zrušit | Abbrechen | Cancelar | Annulla | Annuler | Zrušiť | Prekliči | Peruuta |
| Connect / Join | Připojit | Verbinden | Conectar | Connetti | Se connecter | Pripojiť | Poveži | Yhdistä |
| Disconnect / Leave | Odpojit | Trennen | Desconectar | Disconnetti | Se déconnecter | Odpojiť | Prekini povezavo | Katkaise yhteys |
| Save | Uložit | Speichern | Guardar | Salva | Enregistrer | Uložiť | Shrani | Tallenna |
| Delete | Smazat | Löschen | Eliminar | Elimina | Supprimer | Vymazať | Izbriši | Poista |
| Copy | Kopírovat | Kopieren | Copiar | Copia | Copier | Kopírovať | Kopiraj | Kopioi |
| Share | Sdílet | Teilen | Compartir | Condividi | Partager | Zdieľať | Deli | Jaa |
| Forward | Přeposlat | Weiterleiten | Reenviar | Inoltra | Transférer | Preposlať | Posreduj | Välitä |
| Reply | Odpovědět | Antworten | Responder | Rispondi | Répondre | Odpovedať | Odgovori | Vastaa |
| Sign in / Sign out | Přihlásit / Odhlásit | Anmelden / Abmelden | Iniciar sesión / Cerrar sesión | Accedi / Esci | Se connecter / Se déconnecter | Prihlásiť / Odhlásiť | Prijava / Odjava | Kirjaudu / Kirjaudu ulos |
