// A description of the `m5` SDK for the console editor (4.15): every object
// and method, its signature in each language, and one line of help. The
// editor turns it into completions and parameter hints; a test checks it
// against the real preludes so it cannot drift.

export type SdkMethod = { name: string; js: string; py: string; doc: string; async?: boolean };
export type SdkObject = { name: string; doc: string; methods: SdkMethod[] };

const m = (name: string, js: string, py: string, doc: string, async = false): SdkMethod => ({ name, js, py, doc, async });

export const SDK_SPEC: SdkObject[] = [
  { name: "sys", doc: "About the instance and this run's environment.", methods: [
    m("version", "m5.sys.version", "m5.sys.version", "The M5cet version (string)."),
    m("lang", "m5.sys.lang", "m5.sys.lang", "The caller's language (e.g. \"cs\")."),
    m("tz", "m5.sys.tz", "m5.sys.tz", "The caller's time zone."),
    m("now", "m5.sys.now()", "m5.sys.now()", "The server's time in milliseconds."),
    m("remaining", "m5.sys.remaining()", "m5.sys.remaining()", "Milliseconds left before the deadline."),
  ] },
  { name: "run", doc: "This run: its id, inputs and progress.", methods: [
    m("id", "m5.run.id", "m5.run.id", "The run id."),
    m("inputs", "m5.run.inputs", "m5.run.inputs", "The validated inputs (also passed to the entry function)."),
    m("progress", "m5.run.progress(fraction, text)", "m5.run.progress(fraction, text)", "Reports progress (0–1) with a short note."),
  ] },
  { name: "caller", doc: "Who started the run, and how to reach them.", methods: [
    m("name", "m5.caller.name", "m5.caller.name", "The caller's display name."),
    m("groups", "m5.caller.groups", "m5.caller.groups", "The caller's groups."),
    m("room", "m5.caller.room", "m5.caller.room", "The room id, or null."),
    m("send", "await m5.caller.send(output)", "await m5.caller.send(output)", "Sends an extra output to the caller.", true),
    m("flash", "await m5.caller.flash(text, level)", "await m5.caller.flash(text, level)", "Shows the caller a short flash message.", true),
  ] },
  { name: "log", doc: "Structured logging, shown live in the console.", methods: [
    m("debug", "m5.log.debug(msg, fields?)", "m5.log.debug(msg, **fields)", "A debug line."),
    m("info", "m5.log.info(msg, fields?)", "m5.log.info(msg, **fields)", "An info line."),
    m("warn", "m5.log.warn(msg, fields?)", "m5.log.warn(msg, **fields)", "A warning."),
    m("error", "m5.log.error(msg, fields?)", "m5.log.error(msg, **fields)", "An error."),
    m("trace", "m5.log.trace(label, fn)", "m5.log.trace(label, fn)", "Times a piece of work."),
  ] },
  { name: "out", doc: "Build an output: return one, or a list of them (each is shown, played or run), or send it with caller.send.", methods: [
    m("text", "m5.out.text(text)", "m5.out.text(text)", "Plain text."),
    m("markdown", "m5.out.markdown(text)", "m5.out.markdown(text)", "Markdown (rendered safely)."),
    m("code", "m5.out.code(text, lang)", "m5.out.code(text, lang)", "A code block."),
    m("table", "m5.out.table(columns, rows, { title })", "m5.out.table(columns, rows, title=None)", "A table."),
    m("json", "m5.out.json(value, { title })", "m5.out.json(value, title=None)", "A JSON value."),
    m("image", "m5.out.image(bytes, mime, { alt })", "m5.out.image(bytes, mime, alt=None)", "An image from bytes."),
    m("file", "m5.out.file(name, bytes, mime)", "m5.out.file(name, bytes, mime)", "A file from bytes."),
    m("audio", "m5.out.audio(bytes, mime, { title, autoplay })", "m5.out.audio(bytes, mime, title=None, autoplay=False)", "Sound to play (bytes or the result of m5.ai.tts)."),
    m("video", "m5.out.video(bytes, mime, { title })", "m5.out.video(bytes, mime, title=None)", "A video to play."),
    m("flash", "m5.out.flash(text, level)", "m5.out.flash(text, level)", "A short notice (info, success, warning, error)."),
    m("window", "m5.out.window(id, args)", "m5.out.window(id, args)", "Opens a panel of the app (files, speech, ai, phone…)."),
    m("button", "m5.out.button({ name, title, data, css, icon })", "m5.out.button({ name, title, data, css, icon })", "A button; a click calls the model's button entry point with { name, data, event }."),
    m("buttons", "m5.out.buttons([{ name, title }, …])", "m5.out.buttons([...])", "Several buttons (shown in a row)."),
    m("form", "m5.out.form({ name, title, fields | panels, submit })", "m5.out.form({...})", "A form; submitting calls the form entry point with { name, values, event }."),
    m("js", "m5.out.js(code, args, { height, hidden })", "m5.out.js(code, args, height=None, hidden=False)", "JavaScript for the viewer's browser, run in a sandbox (m5.args, m5.send, m5.flash…)."),
  ] },
  { name: "model", doc: "This model, the entry point that runs, and its processing session: calls[0] is the first call (execute or a webhook), then replies, clicks, forms, errors.", methods: [
    m("type", "m5.model.type", "m5.model.type", "This call's entry point: execute, response, button, form, error, webhook."),
    m("calls", "m5.model.calls", "m5.model.calls", "Every call of the session: { type, parms, result, status, err_msg, http }."),
    m("current", "m5.model.current", "m5.model.current", "This call (m5.model.calls[m5.model.call])."),
    m("last", "m5.model.last", "m5.model.last", "The call before this one (null for the first)."),
    m("first", "m5.model.first", "m5.model.first", "The first call (execute or a webhook)."),
    m("call", "m5.model.call", "m5.model.call", "This call's index in calls."),
    m("chain", "m5.model.chain", "m5.model.chain", "The processing session's id."),
    m("endpoints", "m5.model.endpoints", "m5.model.endpoints", "The entry point types the model has."),
    m("session", "await m5.model.session.get(key)", "await m5.model.session.get(key)", "Values kept for this session only (get, set, delete, keys).", true),
    m("cache", "await m5.model.cache.get(key)", "await m5.model.cache.get(key)", "A cache for this session only (get, set, incr, delete).", true),
  ] },
  { name: "browser", doc: "The viewer's browser: sandboxed JavaScript, sound, a notice, a panel — sent at once.", methods: [
    m("run", "await m5.browser.run(code, args)", "await m5.browser.run(code, args)", "Runs JavaScript in a sandbox in the browser (no access to the app or its keys).", true),
    m("play", "await m5.browser.play(bytes, mime)", "await m5.browser.play(bytes, mime)", "Plays a sound.", true),
    m("flash", "await m5.browser.flash(text, level)", "await m5.browser.flash(text, level)", "Shows a notice.", true),
    m("open", "await m5.browser.open(id, args)", "await m5.browser.open(id, args)", "Opens a panel of the app.", true),
  ] },
  { name: "session", doc: "Small key–value store shared by the run's session (model × caller × room).", methods: [
    m("get", "await m5.session.get(key)", "await m5.session.get(key)", "Reads a value.", true),
    m("set", "await m5.session.set(key, value, { ttl })", "await m5.session.set(key, value, ttl=None)", "Writes a value, optionally with a TTL.", true),
    m("delete", "await m5.session.delete(key)", "await m5.session.delete(key)", "Removes a value.", true),
    m("keys", "await m5.session.keys()", "await m5.session.keys()", "Lists the keys.", true),
  ] },
  { name: "cache", doc: "Shared cache with TTL; scopes: run, session, model, global.", methods: [
    m("get", "await m5.cache.get(key)", "await m5.cache.get(key)", "Reads a value.", true),
    m("set", "await m5.cache.set(key, value, { ttl })", "await m5.cache.set(key, value, ttl=None)", "Writes a value.", true),
    m("incr", "await m5.cache.incr(key, by?, { ttl })", "await m5.cache.incr(key, by=1, ttl=None)", "Adds to a number and returns it.", true),
    m("delete", "await m5.cache.delete(key)", "await m5.cache.delete(key)", "Removes a value.", true),
    m("scope", "m5.cache.scope(name)", "m5.cache.scope(name)", "The cache in another scope."),
  ] },
  { name: "codec", doc: "Encode and decode: base64/32/58, hex, url, html, json, csv, compression.", methods: [
    m("base64", "m5.codec.base64.encode(bytes)", "m5.codec.base64.encode(bytes)", "Base64 encode/decode (also base64url, base32, base58, hex)."),
    m("utf8", "m5.codec.utf8.encode(text)", "m5.codec.utf8.encode(text)", "Text ↔ bytes."),
    m("url", "m5.codec.url.parse(url)", "m5.codec.url.parse(url)", "Parse, build, encode, decode URLs."),
    m("csv", "m5.codec.csv.parse(text, { header })", "m5.codec.csv.parse(text, header=False)", "Parse and stringify CSV."),
    m("compress", "m5.codec.compress(alg, bytes)", "m5.codec.compress(alg, bytes)", "gzip/deflate/brotli; decompress to undo."),
  ] },
  { name: "id", doc: "Identifiers: uuid, uuid7, ulid, nanoid, tag, slug.", methods: [
    m("uuid", "m5.id.uuid()", "m5.id.uuid()", "A random UUID v4."),
    m("uuid7", "m5.id.uuid7()", "m5.id.uuid7()", "A time-ordered UUID v7."),
    m("ulid", "m5.id.ulid()", "m5.id.ulid()", "A ULID."),
    m("nanoid", "m5.id.nanoid(size?)", "m5.id.nanoid(size=21)", "A short random id."),
    m("slug", "m5.id.slug(text)", "m5.id.slug(text)", "A URL-safe slug."),
  ] },
  { name: "http", doc: "HTTP from the server (no CORS), with an SSRF guard (no private addresses).", methods: [
    m("get", "await m5.http.get(url, { headers })", "await m5.http.get(url, headers=...)", "A GET request.", true),
    m("post", "await m5.http.post(url, { json })", "await m5.http.post(url, json=...)", "A POST (json / body / headers).", true),
    m("request", "await m5.http.request({ method, url, ... })", "await m5.http.request({...})", "Any method; returns { status, headers, text, json, body }.", true),
  ] },
  { name: "dns", doc: "DNS lookups.", methods: [
    m("resolve", "await m5.dns.resolve(name, type)", "await m5.dns.resolve(name, type='A')", "A/AAAA/CNAME/MX/TXT/NS/SRV/CAA/PTR/SOA.", true),
  ] },
  { name: "webhook", doc: "A URL that resumes this run (or runs on_event later).", methods: [
    m("create", "await m5.webhook.create({ durable, ttl })", "await m5.webhook.create(durable=True)", "A URL bound to the run; durable → runs on_event later.", true),
    m("wait", "await m5.webhook.wait(hook, { timeoutMs })", "await m5.webhook.wait(hook, timeout_ms=...)", "Wait for a POST to the webhook (live).", true),
  ] },
  { name: "crypto", doc: "Hashes, HMAC, key derivation, AES-GCM, random.", methods: [
    m("random", "m5.crypto.random(n)", "m5.crypto.random(n)", "n random bytes."),
    m("hash", "m5.crypto.hash(alg, data, enc?)", "m5.crypto.hash(alg, data, encoding=None)", "sha256, sha512, blake2b, …"),
    m("hmac", "m5.crypto.hmac(alg, key, data, enc?)", "m5.crypto.hmac(alg, key, data, encoding=None)", "An HMAC."),
    m("hkdf", "m5.crypto.hkdf(alg, key, salt, info, length)", "m5.crypto.hkdf(alg, key, salt, info, length)", "HKDF key derivation."),
    m("aesGcm", "m5.crypto.aesGcm.encrypt(key, data, aad?)", "m5.crypto.aes_gcm.encrypt(key, data, aad=None)", "AES-GCM encrypt/decrypt."),
    m("jwt", "await m5.crypto.jwt.sign({ payload, secret })", "await m5.crypto.jwt.sign({...})", "JWT/JWS sign, verify, decode (HS/RS/ES/PS).", true),
    m("pgp", "await m5.crypto.pgp.encrypt({ text, publicKey })", "await m5.crypto.pgp.encrypt({...})", "OpenPGP encrypt, decrypt, sign, verify, generateKey.", true),
    m("ssh", "await m5.crypto.ssh.fingerprint({ key })", "await m5.crypto.ssh.fingerprint({...})", "OpenSSH keys: parse, fingerprint.", true),
    m("x509", "await m5.crypto.x509.parse(pem)", "await m5.crypto.x509.parse(pem)", "Parse and verify an X.509 certificate.", true),
  ] },
  { name: "ai", doc: "The instance's AI & speech (counted against its budget).", methods: [
    m("chat", "await m5.ai.chat({ messages, model?, system? })", "await m5.ai.chat({...})", "Ask a model; returns { text, usage, cost, model }.", true),
    m("models", "await m5.ai.models()", "await m5.ai.models()", "The chat models this caller may use.", true),
    m("tts", "await m5.ai.tts({ text, voice? })", "await m5.ai.tts(text=...)", "Speech synthesis → audio bytes.", true),
    m("stt", "await m5.ai.stt({ audio, mime })", "await m5.ai.stt(audio=...)", "Transcribe audio → text.", true),
    m("agent", "await m5.ai.agent(goal, { tools, maxSteps, approve })", "await m5.ai.agent(goal, tools=[...])", "An agent loop: the model uses your tools (a tool may need approval).", true),
  ] },
  { name: "functions", doc: "The “/keyword” commands this run's caller may use (no secrets).", methods: [
    m("list", "await m5.functions.list()", "await m5.functions.list()", "Every command: keyword, name, summary, inputs, webhook/API availability.", true),
    m("get", "await m5.functions.get(keyword)", "await m5.functions.get(keyword)", "One command by keyword, or null.", true),
  ] },
  { name: "telephony", doc: "Phones (6.0): calls with handlers, SMS, WhatsApp, Viber, Messenger, number lookup and HLR, and temporary numbers that connect a caller to a room member (the audio bridge). Twilio, Telnyx, Vonage, HLR-Lookups.com, Meta — whichever the operator configured. A person's run needs their Telephony & SIP rights; a webhook's or a schedule's run the model's grant.", methods: [
    m("call", "await m5.telephony.call({ to, from, timeout: 10, say, actions, on_answer, on_hangup, on_busy, wait })", "await m5.telephony.call(to=..., timeout=10, on_hangup=\"on_hangup\")", "Places a call (ring timeout 10 s). Handlers by name run later in the model (async); functions run here while the run waits (sync) — on_answer may return call logic. twiml / ncco / texml: the provider's own logic.", true),
    m("wait", "await m5.telephony.wait(call, { on_digits })", "await m5.telephony.wait(call)", "Waits for a call to end (with callbacks); its events.", true),
    m("say", "await m5.telephony.say(call, text, { voice, language })", "await m5.telephony.say(call, text)", "Speaks on a live call.", true),
    m("hangup", "await m5.telephony.hangup(call)", "await m5.telephony.hangup(call)", "Hangs up.", true),
    m("steer", "await m5.telephony.steer(call, actions)", "await m5.telephony.steer(call, actions)", "Replaces what a live call does (say, play, gather, stream, hangup…).", true),
    m("calls", "await m5.telephony.calls.get(id)", "await m5.telephony.calls.get(call_id)", "Calls: get, list, hangup, steer.", true),
    m("sms", "await m5.telephony.sms({ to, text, from, options: { unicode, ttl }, on_status })", "await m5.telephony.sms(to, text)", "Sends an SMS; delivery reports update it (and run on_status).", true),
    m("whatsapp", "await m5.telephony.whatsapp({ to, text | template: { name, language, params } })", "await m5.telephony.whatsapp(to=..., text=...)", "A WhatsApp message (a template outside the 24-hour window).", true),
    m("viber", "await m5.telephony.viber({ to, text, category })", "await m5.telephony.viber(to=..., text=...)", "A Viber service message (Vonage).", true),
    m("messenger", "await m5.telephony.messenger({ to: psid, text, tag })", "await m5.telephony.messenger(to=..., text=...)", "A Facebook Messenger message (Vonage or Meta).", true),
    m("messages", "await m5.telephony.messages.get(id)", "await m5.telephony.messages.get(message_id)", "A sent message and its delivery.", true),
    m("lookup", "await m5.telephony.lookup(number, { fields, providers, offline })", "await m5.telephony.lookup(number)", "Everything about a number: country, type, formats, time zones (offline), carrier, name, ported, roaming, reachability (providers, merged).", true),
    m("hlr", "await m5.telephony.hlr(number)", "await m5.telephony.hlr(number)", "Asks the home network: connected, roaming, ported, network.", true),
    m("did", "await m5.telephony.did.allocate({ room, member, minutes: 10, mode })", "await m5.telephony.did.allocate(room=..., member=...)", "Lends a phone number with a 5-digit code for a room member: the caller types the code and #, and is connected (audio, or speech ↔ text). get, list, release.", true),
    m("log", "await m5.telephony.log({ kind, limit })", "await m5.telephony.log(limit=100)", "The telephony log: calls, messages, lookups, bridge attempts.", true),
    m("actions", "m5.telephony.actions.say(text)", "m5.telephony.actions.say(text)", "Call logic: say, play, pause, gather({ digits, fn }), record, redirect, hangup."),
    m("providers", "await m5.telephony.providers()", "await m5.telephony.providers()", "The providers and what each can do / is configured for.", true),
  ] },
  { name: "nfc", doc: "The caller's NFC hardware (6.3), two-way: the model asks for an NFC op, the caller's device runs it on the reader and returns the result. Every op id is one the catalogue knows (scan, read-uid/-public, ndef-read/-write, classic-read/-write, ntag/ul pages, DESFire files, the M5Cet card, emulate). A protected card is used by name — command.secretRef — so a key or PIN never crosses to the model, and the device never returns one. A person's run needs their NFC module access; a webhook's or a schedule's run the model's grant.", methods: [
    m("reader", "m5.nfc.reader(kind)", "m5.nfc.reader(kind)", "The NFC scoped to a reader (\"internal\", \"usb\", \"bluetooth\", \"serial\"): the same ops, sent to that reader."),
    m("enum", "await m5.nfc.enum({ reader })", "await m5.nfc.enum(reader=None)", "What the device offers now: its readers and the card technologies it can talk to.", true),
    m("card", "await m5.nfc.card({ timeout })", "await m5.nfc.card(timeout=20)", "Waits for a card and returns its identity — uid, technology, ATQA/SAK/ATS/ATR, memory.", true),
    m("scan", "await m5.nfc.scan({ tech, timeout })", "await m5.nfc.scan(tech=None, timeout=20)", "Reads a presented card's public identity and NDEF.", true),
    m("read", "await m5.nfc.read({ what, tech, secretRef, args })", "await m5.nfc.read(what='public', secretRef=None)", "Reads a card: what = uid | public | ndef | sector | page | file | dump | counter (a protected read names a saved key with secretRef).", true),
    m("write", "await m5.nfc.write({ what, ndef, data, records, secretRef })", "await m5.nfc.write(what='ndef', ndef=None, secretRef=None)", "Writes a card: what = ndef | block | page | uid | record | lock | restore (keys are named with secretRef, never sent).", true),
    m("emulate", "await m5.nfc.emulate({ tech, records, secretRef })", "await m5.nfc.emulate(records=None, secretRef=None)", "Has the device act as a card (HCE): an M5Cet card, a connection tag or a Type 4 tag.", true),
    m("m5", "await m5.nfc.m5.read({ records, secretRef })", "await m5.nfc.m5.read(records=None, secretRef=None)", "The M5Cet card: read (open records), write / build (seal records onto a tag), erase (remove one), emulate.", true),
    m("emv", "await m5.nfc.emv.read({ timeout, maxApps })", "await m5.nfc.emv.read(timeout=20, max_apps=4)", "6.5: read an EMV payment card's applications and records (PPSE → SELECT AID → GPO → READ RECORD) and return the holder/public data a terminal reads — result.emv: { scheme, aids, apps[{ aid, label, scheme, pan, panMasked, expiry, cardholder, atc, tags[] }] }. Read-only: never a PIN, never a cryptogram or a transaction, never a write.", true),
    m("eid", "await m5.nfc.eid.read({ mrz | documentNumber+dateOfBirth+dateOfExpiry | can, readPhoto })", "await m5.nfc.eid.read(mrz=None, document_number=None, date_of_birth=None, date_of_expiry=None, can=None, read_photo=True)", "6.5: read an e-ID / e-passport (MRTD). The holder gives the MRZ (or the passport number + date of birth + expiry, YYMMDD) or a CAN; the chip is opened with BAC (its own access control) and DG1 (the MRZ fields) and DG2 (the face) are read over secure messaging — result.mrtd: { access, dataGroups, mrzInfo{...}, photo, photoMime }. The holder's own document, read-only.", true),
  ] },
  { name: "codes", doc: "2D and bar codes: QR, Data Matrix, PDF417, Aztec, Code128, EAN/UPC…", methods: [
    m("qr", "await m5.codes.qr(text, { scale })", "await m5.codes.qr(text, scale=...)", "A QR code as SVG (or PNG).", true),
    m("barcode", "await m5.codes.barcode(type, text)", "await m5.codes.barcode(type, text)", "Any symbology by name → SVG/PNG.", true),
  ] },
];

/**
 * 6.0: m5adm — the administration, as the owner granted the model (Functions ›
 * model › Administration: a role and areas). Also reachable as m5.adm. Lists
 * return lists, get → the object or null, set(id | null, object) → the id or
 * -1, delete → true/false. Rooms come as m5room objects with their controls.
 */
export const ADM_SPEC: SdkObject[] = [
  { name: "info", doc: "What this run may do: { granted, role, areas }.", methods: [
    m("info", "await m5adm.info()", "await m5adm.info()", "The grant: role (auditor, operator, owner) and areas.", true),
  ] },
  { name: "overview", doc: "Everything at a glance: counts, health, system, alerts, databases, backups.", methods: [
    m("get", "await m5adm.overview.get()", "await m5adm.overview.get()", "The console's overview: counts, health, storage, audit.", true),
    m("system", "await m5adm.overview.system()", "await m5adm.overview.system()", "Memory, heap, event loop, host — now and the history.", true),
    m("alerts", "await m5adm.overview.alerts()", "await m5adm.overview.alerts()", "Alert rules, firing alerts, history.", true),
    m("db", "await m5adm.overview.db()", "await m5adm.overview.db()", "Databases: sizes, tables.", true),
    m("backups", "await m5adm.overview.backups()", "await m5adm.overview.backups()", "Backups, schedule, last integrity check.", true),
    m("metrics", "await m5adm.overview.metrics()", "await m5adm.overview.metrics()", "Prometheus text.", true),
    m("whoami", "await m5adm.overview.whoami()", "await m5adm.overview.whoami()", "How the service sees this run (fn:<model>/<caller>, role).", true),
  ] },
  { name: "rooms", doc: "Rooms: who is in them, the operator's records (label, limit, block, pinned message) and control. A room is an m5room: data + wall_msg, user_msg, user_flash, disconnect, block, unblock, connect, log, refresh, save, forget.", methods: [
    m("list", "await m5adm.rooms.list([{ key: \"room_username\", value: \"/^eva/i\" }])", "await m5adm.rooms.list([{\"key\": \"system_group\", \"value\": \"staff\"}])", "Rooms whose members match every filter (keys: room_username, system_username, system_passkey_id, system_group, room_id, room_label, room_tag; values: preg_match patterns). { match: \"any\" } for any filter.", true),
    m("get", "await m5adm.rooms.get(id)", "await m5adm.rooms.get(room_id)", "One room (its hash, or the room id itself) as m5room, or null.", true),
    m("set", "await m5adm.rooms.set(id | null, { label, note, tags, maxMembers, blocked, wall })", "await m5adm.rooms.set(room_id, {...})", "Saves the room's record; null with { room } creates one. The id, or -1.", true),
    m("delete", "await m5adm.rooms.delete(id)", "await m5adm.rooms.delete(room_id)", "Forgets the room's record.", true),
    m("stats", "await m5adm.rooms.stats()", "await m5adm.rooms.stats()", "Rooms, members, guests, away, protocols, the busiest, the registry.", true),
    m("wall_msg", "await room.wall_msg(text, { level, pin })", "await room.wall_msg(text, level=\"info\", pin=None)", "A message from the operator to everyone in the room (pin: also to everyone who joins later). How many got it.", true),
    m("user_msg", "await room.user_msg(member, text)", "await room.user_msg(member, text)", "A private message from the operator to one member (peer id, account id or name).", true),
    m("user_flash", "await room.user_flash(member, text, level)", "await room.user_flash(member, text, level=\"info\")", "A short notice to one member.", true),
    m("disconnect", "await room.disconnect(member?, reason?)", "await room.disconnect(member=None, reason=\"\")", "Disconnects everyone, or one member. How many.", true),
    m("block", "await room.block({ reason, minutes, kick })", "await room.block(reason=\"\", minutes=None, kick=True)", "Closes the room (and empties it unless kick: false); for a while, or until unblock.", true),
    m("unblock", "await room.unblock()", "await room.unblock()", "Opens a closed room.", true),
    m("connect", "await room.connect(accountId?)", "await room.connect(account_id=None)", "Opens the room and calls members who are away back (a push to their devices). How many.", true),
    m("log", "await room.log({ limit, since })", "await room.log(limit=200)", "The room's recent traffic and journal.", true),
  ] },
  { name: "connections", doc: "Live connections (sockets).", methods: [
    m("list", "await m5adm.connections.list({ ip, name, peer, account, room })", "await m5adm.connections.list({...})", "Connections, filtered (patterns; room: a room id).", true),
    m("get", "await m5adm.connections.get(id)", "await m5adm.connections.get(conn_id)", "One connection, or null.", true),
    m("close", "await m5adm.connections.close(id)", "await m5adm.connections.close(conn_id)", "Disconnects it.", true),
    m("stats", "await m5adm.connections.stats()", "await m5adm.connections.stats()", "Counts, round trip, bytes.", true),
  ] },
  { name: "traffic", doc: "Live traffic: records, rates, events, and a few seconds of what arrives.", methods: [
    m("list", "await m5adm.traffic.list({ cls, direction, room, account, errors, limit })", "await m5adm.traffic.list({...})", "Traffic records, newest first.", true),
    m("summary", "await m5adm.traffic.summary()", "await m5adm.traffic.summary()", "Totals by class, the last minute.", true),
    m("rates", "await m5adm.traffic.rates(seconds)", "await m5adm.traffic.rates(120)", "Per-second series.", true),
    m("events", "await m5adm.traffic.events(limit)", "await m5adm.traffic.events(100)", "The metadata event feed.", true),
    m("watch", "await m5adm.traffic.watch(ms, filter)", "await m5adm.traffic.watch(5000, {...})", "What arrives in the next ms (at most 60 s).", true),
  ] },
  { name: "modules", doc: "Modules & groups: every part of the portal, who may use it.", methods: [
    m("list", "await m5adm.modules.list()", "await m5adm.modules.list()", "Every module with its rule.", true),
    m("get", "await m5adm.modules.get(id)", "await m5adm.modules.get(module_id)", "One module, or null.", true),
    m("set", "await m5adm.modules.set(id, rule)", "await m5adm.modules.set(module_id, {...})", "Changes its rule (enabled, defaultAccess, groups, grants, log). The id, or -1.", true),
    m("enable", "await m5adm.modules.enable(id, on)", "await m5adm.modules.enable(module_id, True)", "Switches a module on or off.", true),
    m("state", "await m5adm.modules.state()", "await m5adm.modules.state()", "The service switches.", true),
    m("switch", "await m5adm.modules.switch(name, on)", "await m5adm.modules.switch(name, True)", "Starts or stops a service (ai, speech, functions…).", true),
  ] },
  { name: "groups", doc: "Access groups and their members.", methods: [
    m("list", "await m5adm.groups.list()", "await m5adm.groups.list()", "Built-in and own groups.", true),
    m("get", "await m5adm.groups.get(id)", "await m5adm.groups.get(group_id)", "One group, or null.", true),
    m("set", "await m5adm.groups.set(id, { label, members })", "await m5adm.groups.set(group_id, {...})", "Creates or changes a group. The id, or -1.", true),
    m("delete", "await m5adm.groups.delete(id)", "await m5adm.groups.delete(group_id)", "Removes a group.", true),
    m("add_member", "await m5adm.groups.add_member(id, member)", "await m5adm.groups.add_member(group_id, member)", "Adds a username (or admin:<name>).", true),
    m("remove_member", "await m5adm.groups.remove_member(id, member)", "await m5adm.groups.remove_member(group_id, member)", "Removes one.", true),
  ] },
  { name: "users", doc: "Users & passkeys.", methods: [
    m("list", "await m5adm.users.list({ username, group, passkey })", "await m5adm.users.list({...})", "Accounts, filtered (patterns).", true),
    m("get", "await m5adm.users.get(id)", "await m5adm.users.get(account_id)", "One account in detail: passkeys, queue, journal, traffic.", true),
    m("signout", "await m5adm.users.signout(id)", "await m5adm.users.signout(account_id)", "Ends every session of the account.", true),
    m("delete", "await m5adm.users.delete(id, id)", "await m5adm.users.delete(account_id, account_id)", "Deletes the account and its data (the id repeated).", true),
    m("passkeys", "await m5adm.users.passkeys(id)", "await m5adm.users.passkeys(account_id)", "The account's passkeys.", true),
    m("remove_passkey", "await m5adm.users.remove_passkey(id, credentialId)", "await m5adm.users.remove_passkey(account_id, credential_id)", "Removes one passkey (never the last).", true),
  ] },
  { name: "passkeys", doc: "Passkeys across the accounts.", methods: [
    m("list", "await m5adm.passkeys.list({ id, username })", "await m5adm.passkeys.list({...})", "Every passkey with its account.", true),
    m("get", "await m5adm.passkeys.get(credentialId)", "await m5adm.passkeys.get(credential_id)", "One passkey, or null.", true),
    m("delete", "await m5adm.passkeys.delete(credentialId)", "await m5adm.passkeys.delete(credential_id)", "Removes it from its account.", true),
  ] },
  { name: "queue", doc: "The message queue (offline delivery).", methods: [
    m("list", "await m5adm.queue.list()", "await m5adm.queue.list()", "Per account: queued, delivering, dead.", true),
    m("stats", "await m5adm.queue.stats()", "await m5adm.queue.stats()", "Totals.", true),
    m("get", "await m5adm.queue.get(accountId)", "await m5adm.queue.get(account_id)", "One account's pending items.", true),
    m("dead", "await m5adm.queue.dead({ account, limit })", "await m5adm.queue.dead({...})", "The dead letters.", true),
    m("revive", "await m5adm.queue.revive(id)", "await m5adm.queue.revive(item_id)", "Puts a dead item back.", true),
  ] },
  { name: "audit", doc: "The audit journal.", methods: [
    m("list", "await m5adm.audit.list({ category, minLevel, actor, event, q, since, limit })", "await m5adm.audit.list({...})", "Entries, newest first.", true),
    m("stats", "await m5adm.audit.stats()", "await m5adm.audit.stats()", "Counts by category and level.", true),
    m("verify", "await m5adm.audit.verify()", "await m5adm.audit.verify()", "Checks the hash chain and the signed checkpoints.", true),
    m("checkpoint", "await m5adm.audit.checkpoint()", "await m5adm.audit.checkpoint()", "Signs the head of the chain now.", true),
    m("communication", "await m5adm.audit.communication(on)", "await m5adm.audit.communication(True)", "Communication auditing on or off.", true),
    m("add", "await m5adm.audit.add(event, detail, { level, target })", "await m5adm.audit.add(event, detail, {...})", "A line of your own (fn.<event>).", true),
  ] },
  { name: "commands", doc: "Commands to devices.", methods: [
    m("list", "await m5adm.commands.list()", "await m5adm.commands.list()", "Allowlist, pending, delivery audit.", true),
    m("allowlist", "await m5adm.commands.allowlist()", "await m5adm.commands.allowlist()", "The commands a device accepts.", true),
    m("send", "await m5adm.commands.send(deviceId, kind, payload)", "await m5adm.commands.send(device_id, kind, payload)", "Queues a command (delivered at once when the device is connected).", true),
  ] },
  { name: "push", doc: "Web push.", methods: [
    m("status", "await m5adm.push.status()", "await m5adm.push.status()", "Readiness and subscribers.", true),
    m("send", "await m5adm.push.send(id | null, title, body)", "await m5adm.push.send(None, title, body)", "A push to one subscriber, or everyone.", true),
  ] },
  { name: "admins", doc: "Administrators (owner).", methods: [
    m("list", "await m5adm.admins.list()", "await m5adm.admins.list()", "Administrators, their roles, tokens and passkeys (no secrets).", true),
    m("get", "await m5adm.admins.get(name)", "await m5adm.admins.get(name)", "One, or null.", true),
    m("set", "await m5adm.admins.set(name | null, { name, role, disabled })", "await m5adm.admins.set(name, {...})", "Creates or changes one (role, disabled). The name, or -1.", true),
    m("delete", "await m5adm.admins.delete(name)", "await m5adm.admins.delete(name)", "Removes one.", true),
  ] },
];

/**
 * 6.3: m5mobile — the operator's typed constants and variables (Android ›
 * Define), materialized to live values and handed to every runtime, read-only.
 * m5mobile.define.<name> (Python: m5mobile.define["name"] or attribute access)
 * is the value; a `script` definition arrives as data ({ __m5script, code,
 * lang }), never run. A per-run snapshot: the values are read once at run start.
 */
export const MOBILE_SPEC: SdkObject[] = [
  { name: "define", doc: "The operator's typed constants/variables from Android › Define, as live values (m5mobile.define.<name>). Read-only; a script value stays as data ({ __m5script, code, lang }).", methods: [
    m("<name>", "m5mobile.define.NAME", "m5mobile.define[\"NAME\"]", "One definition's materialized value: a scalar, object, array, bytes (hex), enum, or a { __m5script } script (not run)."),
  ] },
];

export function sdkDts(): string {
  const lines = ["// The m5 SDK available to a function (JavaScript).", "declare global {", "  const m5: {"];
  for (const obj of SDK_SPEC) {
    lines.push(`    /** ${obj.doc} */`);
    lines.push(`    ${obj.name}: {`);
    for (const meth of obj.methods) lines.push(`      /** ${meth.doc} */ ${meth.name}: any;`);
    lines.push("    };");
  }
  lines.push("    sleep(ms: number): Promise<void>;");
  lines.push("    /** 6.0: the administration (the same object as m5adm). */ adm: typeof m5adm;");
  lines.push("  };");
  lines.push("  /** 6.0: the administration, as the owner granted the model (a role and areas). */");
  lines.push("  const m5adm: {");
  for (const obj of ADM_SPEC) {
    if (obj.name === "info") { lines.push(`    /** ${obj.doc} */ info(): Promise<{ granted: boolean; role: string | null; areas: string[] }>;`); continue; }
    lines.push(`    /** ${obj.doc} */`);
    lines.push(`    ${obj.name}: {`);
    for (const meth of obj.methods) if (!meth.js.startsWith("await room.")) lines.push(`      /** ${meth.doc} */ ${meth.name}: any;`);
    lines.push("    };");
  }
  lines.push("  };");
  // 6.3: m5mobile.define — the operator's typed constants/variables.
  lines.push("  /** 6.3: the operator's typed constants/variables from Android › Define, materialized as live values (read-only). */");
  lines.push("  const m5mobile: {");
  for (const obj of MOBILE_SPEC) lines.push(`    /** ${obj.doc} */ ${obj.name}: Record<string, any>;`);
  lines.push("  };");
  lines.push("}", "export {};");
  return lines.join("\n");
}

/** Flat completion entries the editor offers after "m5." or "m5.obj.". */
export function sdkCompletions(): Array<{ path: string; label: string; detail: string; doc: string; async: boolean }> {
  const out: Array<{ path: string; label: string; detail: string; doc: string; async: boolean }> = [];
  for (const obj of SDK_SPEC) {
    out.push({ path: "m5", label: obj.name, detail: `m5.${obj.name}`, doc: obj.doc, async: false });
    for (const meth of obj.methods) out.push({ path: `m5.${obj.name}`, label: meth.name, detail: meth.js, doc: meth.doc, async: Boolean(meth.async) });
  }
  for (const obj of ADM_SPEC) {
    if (obj.name === "info") { out.push({ path: "m5adm", label: "info", detail: obj.methods[0].js, doc: obj.doc, async: true }); continue; }
    out.push({ path: "m5adm", label: obj.name, detail: `m5adm.${obj.name}`, doc: obj.doc, async: false });
    for (const meth of obj.methods) out.push({ path: meth.js.startsWith("await room.") ? "room" : `m5adm.${obj.name}`, label: meth.name, detail: meth.js, doc: meth.doc, async: Boolean(meth.async) });
  }
  // 6.3: m5mobile.define — discoverable in the editor after "m5mobile.".
  for (const obj of MOBILE_SPEC) {
    out.push({ path: "m5mobile", label: obj.name, detail: `m5mobile.${obj.name}`, doc: obj.doc, async: false });
    for (const meth of obj.methods) out.push({ path: `m5mobile.${obj.name}`, label: meth.name, detail: meth.js, doc: meth.doc, async: Boolean(meth.async) });
  }
  return out;
}
