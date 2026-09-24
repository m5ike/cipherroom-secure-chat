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
  { name: "out", doc: "Build an output: the return value, or via caller.send.", methods: [
    m("text", "m5.out.text(text)", "m5.out.text(text)", "Plain text."),
    m("markdown", "m5.out.markdown(text)", "m5.out.markdown(text)", "Markdown (rendered safely)."),
    m("code", "m5.out.code(text, lang)", "m5.out.code(text, lang)", "A code block."),
    m("table", "m5.out.table(columns, rows, { title })", "m5.out.table(columns, rows, title=None)", "A table."),
    m("json", "m5.out.json(value, { title })", "m5.out.json(value, title=None)", "A JSON value."),
    m("image", "m5.out.image(bytes, mime, { alt })", "m5.out.image(bytes, mime, alt=None)", "An image from bytes."),
    m("file", "m5.out.file(name, bytes, mime)", "m5.out.file(name, bytes, mime)", "A file from bytes."),
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
  { name: "crypto", doc: "Hashes, HMAC, key derivation, AES-GCM, random.", methods: [
    m("random", "m5.crypto.random(n)", "m5.crypto.random(n)", "n random bytes."),
    m("hash", "m5.crypto.hash(alg, data, enc?)", "m5.crypto.hash(alg, data, encoding=None)", "sha256, sha512, blake2b, …"),
    m("hmac", "m5.crypto.hmac(alg, key, data, enc?)", "m5.crypto.hmac(alg, key, data, encoding=None)", "An HMAC."),
    m("hkdf", "m5.crypto.hkdf(alg, key, salt, info, length)", "m5.crypto.hkdf(alg, key, salt, info, length)", "HKDF key derivation."),
    m("aesGcm", "m5.crypto.aesGcm.encrypt(key, data, aad?)", "m5.crypto.aes_gcm.encrypt(key, data, aad=None)", "AES-GCM encrypt/decrypt."),
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
  lines.push("  };", "}", "export {};");
  return lines.join("\n");
}

/** Flat completion entries the editor offers after "m5." or "m5.obj.". */
export function sdkCompletions(): Array<{ path: string; label: string; detail: string; doc: string; async: boolean }> {
  const out: Array<{ path: string; label: string; detail: string; doc: string; async: boolean }> = [];
  for (const obj of SDK_SPEC) {
    out.push({ path: "m5", label: obj.name, detail: `m5.${obj.name}`, doc: obj.doc, async: false });
    for (const meth of obj.methods) out.push({ path: `m5.${obj.name}`, label: meth.name, detail: meth.js, doc: meth.doc, async: Boolean(meth.async) });
  }
  return out;
}
