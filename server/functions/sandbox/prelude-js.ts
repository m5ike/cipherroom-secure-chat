// The `m5` SDK inside QuickJS (4.15). Evaluated as global code in a fresh
// context before the function's modules; it returns a setup function that
// takes the host bindings and the run's context, keeps them in a closure
// and deletes every trace of them from the global object.
//
// Host bindings (native, from engine-js.ts):
//   sync(fn, argsJson)  → JSON {ok, v | e}     pure helpers (codec, id, crypto)
//   async(fn, argsJson) → Promise<JSON>          session, cache, sleep
//   emit(kind, json)                             log, out, progress
//
// Bytes cross as {"$b": base64}. The Python SDK (prelude-py.ts) has the same
// objects and methods in snake_case; sdk-spec.ts describes both, and a test
// checks that every method there exists here and there.

export const PRELUDE_JS = String.raw`(function () {
"use strict";
return function setup(host, ctxJson) {
  const ctx = JSON.parse(ctxJson);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const LOOK = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) LOOK[A.charCodeAt(i)] = i;
  LOOK[45] = 62; LOOK[95] = 63;

  function toB64(u8) {
    let out = "", i = 0;
    for (; i + 2 < u8.length; i += 3) {
      const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
    }
    if (i < u8.length) {
      const n = (u8[i] << 16) | ((i + 1 < u8.length ? u8[i + 1] : 0) << 8);
      out += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < u8.length ? A[(n >> 6) & 63] : "=") + "=";
    }
    return out;
  }
  function fromB64(s) {
    const clean = s.replace(/[=\s]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bits = 0, value = 0, o = 0;
    for (let i = 0; i < clean.length; i++) {
      const c = clean.charCodeAt(i);
      const v = c < 128 ? LOOK[c] : -1;
      if (v < 0) throw new M5Error("bad-argument", "not base64");
      value = (value << 6) | v; bits += 6;
      if (bits >= 8) { out[o++] = (value >> (bits - 8)) & 255; bits -= 8; }
    }
    return out.subarray(0, o);
  }

  class M5Error extends Error {
    constructor(code, message) { super(message); this.name = "M5Error"; this.code = code; }
  }

  function asBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return null;
  }
  function enc(v) {
    return JSON.stringify(v, function (k, x) {
      const b = asBytes(this[k]);
      if (b) return { $b: toB64(b) };
      if (typeof x === "bigint") return x.toString();
      if (x === undefined && Array.isArray(this)) return null;
      return x;
    });
  }
  function dec(s) {
    return JSON.parse(s, (k, x) => (x && typeof x === "object" && !Array.isArray(x) && typeof x.$b === "string" && Object.keys(x).length === 1 ? fromB64(x.$b) : x));
  }
  function unwrap(r) {
    if (!r.ok) throw new M5Error(r.e.code, r.e.message);
    return r.v;
  }
  const call = (fn, ...args) => unwrap(dec(host.sync(fn, enc(args))));
  const acall = async (fn, ...args) => unwrap(dec(await host.async(fn, enc(args))));
  const emit = (kind, payload) => host.emit(kind, enc(payload));

  function freeze(o) {
    for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v) && !asBytes(v)) freeze(v);
    return Object.freeze(o);
  }

  /* ---- outputs ---- */
  const OUTPUTS = new WeakSet();
  const mark = (o) => { OUTPUTS.add(o); return Object.freeze(o); };
  const plain = (v) => (v === undefined ? null : dec(enc(v)));
  function bytesOrText(v, what) {
    const b = asBytes(v);
    if (b) return b;
    if (typeof v === "string") return call("codec.utf8.enc", v);
    throw new M5Error("bad-argument", what + " must be bytes or text");
  }
  const out = {
    text: (text) => mark({ type: "text", text: String(text) }),
    markdown: (text) => mark({ type: "markdown", text: String(text) }),
    code: (text, lang) => mark({ type: "code", text: String(text), lang: lang === undefined ? "" : String(lang) }),
    table: (columns, rows, opts) => {
      if (!Array.isArray(columns) || !Array.isArray(rows)) throw new M5Error("bad-argument", "table(columns, rows): two lists");
      const title = opts && opts.title !== undefined ? String(opts.title) : undefined;
      return mark({ type: "table", columns: columns.map(String), rows: rows.map((r) => (Array.isArray(r) ? r : [r]).map((c) => (c === undefined ? null : plain(c)))), ...(title ? { title } : {}) });
    },
    json: (value, opts) => mark({ type: "json", value: plain(value), ...(opts && opts.title ? { title: String(opts.title) } : {}) }),
    image: (data, mime, opts) => mark({ type: "image", mime: mime === undefined ? "image/png" : String(mime), data: toB64(bytesOrText(data, "image data")), ...(opts && opts.alt ? { alt: String(opts.alt) } : {}) }),
    file: (name, data, mime) => mark({ type: "file", name: String(name), mime: mime === undefined ? "application/octet-stream" : String(mime), data: toB64(bytesOrText(data, "file data")) }),
    // 5.3: media, a notice, an app window, buttons, forms and browser JavaScript.
    audio: (data, mime, opts) => mark({ type: "audio", mime: mime === undefined ? "audio/wav" : String(mime), data: toB64(mediaBytes(data, "audio")), ...media(opts) }),
    video: (data, mime, opts) => mark({ type: "video", mime: mime === undefined ? "video/mp4" : String(mime), data: toB64(mediaBytes(data, "video")), ...media(opts) }),
    flash: (text, level) => mark({ type: "flash", text: String(text), level: level === undefined ? "info" : String(level) }),
    window: (id, args) => mark({ type: "window", id: String(id), args: args === undefined ? null : plain(args) }),
    button: (spec, title, opts) => mark({ type: "button", ...(typeof spec === "string" ? { ...(opts ? plain(opts) : {}), name: spec, title: title === undefined ? spec : String(title) } : plain(spec || {})) }),
    buttons: (list) => (Array.isArray(list) ? list : []).map((b) => out.button(b)),
    form: (spec) => mark({ type: "form", ...plain(spec || {}) }),
    js: (code, args, opts) => mark({ type: "js", code: typeof code === "function" ? "(" + String(code) + ")(m5.args)" : String(code), ...(args === undefined ? {} : { args: plain(args) }), ...(opts ? plain(opts) : {}) }),
  };
  function media(opts) {
    const o = opts ? plain(opts) : {};
    return { ...(o.title ? { title: String(o.title) } : {}), ...(o.autoplay ? { autoplay: true } : {}), ...(o.loop ? { loop: true } : {}) };
  }
  // m5.ai.tts gives { audio, mime }; a plain byte array works too.
  function mediaBytes(v, what) {
    if (v && typeof v === "object" && !asBytes(v) && (v.audio || v.data)) return bytesOrText(v.audio || v.data, what + " data");
    return bytesOrText(v, what + " data");
  }
  // A plain object is an output when its type is one and it has a key of that type
  // ({ type: "flash", text }); { type: "button", data } is data. m5.out.* objects always are.
  const OUT_KEYS = { text: ["text"], markdown: ["text"], code: ["text"], table: ["columns", "rows"], json: ["value"], image: ["data", "mime"], file: ["name", "data"], flash: ["text"], window: ["id"], audio: ["data", "mime"], video: ["data", "mime"], button: ["name", "title"], form: ["fields", "panels"], js: ["code"] };
  const isOut = (v) => v !== null && typeof v === "object" && (OUTPUTS.has(v) || (!Array.isArray(v) && !asBytes(v) && typeof v.type === "string" && Object.prototype.hasOwnProperty.call(OUT_KEYS, v.type) && OUT_KEYS[v.type].some((k) => k in v)));
  function asOutput(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "object" && OUTPUTS.has(v)) return v;
    if (typeof v === "string") return out.text(v);
    // A plain { type: "flash", text } is an output too; the host checks it.
    if (isOut(v)) return plain(v);
    return out.json(v);
  }
  // 5.3: a list whose items are outputs is several outputs (lists of outputs inside it — m5.out.buttons —
  // join it); any other list is one JSON value.
  const hasOut = (v) => Array.isArray(v) && v.some((x) => isOut(x) || hasOut(x));
  const flatOuts = (v) => v.flatMap((x) => (hasOut(x) ? flatOuts(x) : [x]));
  function asOutputs(v) {
    if (v === undefined || v === null) return [];
    if (hasOut(v)) return flatOuts(v).filter((x) => x !== undefined && x !== null).map(asOutput);
    return [asOutput(v)];
  }
  // The returned value as plain data for m5.model.calls[i].result: long text and bytes cut.
  function resultOf(v) {
    const cut = (x, depth) => {
      if (x === null || x === undefined) return null;
      if (typeof x === "string") return x.length > 4000 ? x.slice(0, 4000) + "… (" + x.length + " characters)" : x;
      if (typeof x !== "object") return x;
      if (depth > 12) return "…";
      if (Array.isArray(x)) return x.slice(0, 500).map((y) => cut(y, depth + 1));
      if (typeof x.$b === "string" && Object.keys(x).length === 1) return "(" + Math.floor(x.$b.length * 3 / 4) + " bytes)";
      const o = {};
      for (const k of Object.keys(x).slice(0, 500)) o[k] = cut(x[k], depth + 1);
      return o;
    };
    try { return cut(JSON.parse(enc(v === undefined ? null : v)), 0); } catch (e) { return String(v); }
  }

  /* ---- log ---- */
  const show = (v) => (typeof v === "string" ? v : (() => { try { return enc(v); } catch (e) { return String(v); } })());
  function write(level, msg, fields) {
    emit("log", { level, msg: show(msg), ...(fields && typeof fields === "object" ? { fields: plain(fields) } : {}) });
  }
  const log = {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    trace: (label, fn) => {
      const t0 = Date.now();
      const done = () => write("debug", "trace " + label, { label: String(label), ms: Date.now() - t0 });
      let r;
      try { r = fn(); } catch (e) { done(); throw e; }
      if (r && typeof r.then === "function") return r.then((v) => { done(); return v; }, (e) => { done(); throw e; });
      done();
      return r;
    },
  };
  const consoleLine = (level) => (...args) => write(level, args.map(show).join(" "));
  const console = { log: consoleLine("stdout"), info: consoleLine("info"), warn: consoleLine("warn"), error: consoleLine("error"), debug: consoleLine("debug") };

  /* ---- cache ---- */
  function cacheIn(scope) {
    return {
      scope: (name) => cacheIn(String(name)),
      get: (key) => acall("cache.get", scope, String(key)),
      set: (key, value, opts) => acall("cache.set", scope, String(key), value === undefined ? null : value, opts && opts.ttl !== undefined ? opts.ttl : null),
      incr: (key, by, opts) => acall("cache.incr", scope, String(key), by === undefined ? 1 : Number(by), opts && opts.ttl !== undefined ? opts.ttl : null),
      delete: (key) => acall("cache.delete", scope, String(key)),
      lock: (key, opts) => acall("cache.lock", scope, String(key), opts && opts.ttl !== undefined ? opts.ttl : null, opts && opts.waitMs !== undefined ? Number(opts.waitMs) : 0),
      unlock: (key, token) => acall("cache.unlock", scope, String(key), String(token)),
    };
  }

  const bin = (name, url) => ({ encode: (v) => call(name + ".enc", v, url), decode: (s) => call(name + ".dec", String(s)) });

  const m5 = {
    sys: {
      version: ctx.sys.version,
      instance: ctx.sys.instance,
      lang: ctx.caller.lang,
      tz: ctx.caller.tz,
      limits: ctx.limits,
      now: () => Date.now(),
      remaining: () => Math.max(0, ctx.run.deadline - Date.now()),
    },
    run: {
      id: ctx.run.id,
      model: ctx.run.model,
      entry: ctx.run.entry,
      inputs: ctx.inputs,
      executor: ctx.run.executor,
      parent: ctx.run.parent,
      startedAt: ctx.run.startedAt,
      deadline: ctx.run.deadline,
      test: ctx.run.test,
      progress: (p, text) => emit("progress", { p: Number(p), text: text === undefined ? "" : String(text) }),
    },
    caller: {
      kind: ctx.caller.kind,
      name: ctx.caller.name,
      groups: ctx.caller.groups,
      room: ctx.caller.room,
      client: ctx.caller.client,
      lang: ctx.caller.lang,
      tz: ctx.caller.tz,
      send: async (output) => { for (const o of asOutputs(output)) if (o) emit("out", o); },
      flash: async (text, level) => { emit("out", { type: "flash", text: String(text), level: level === undefined ? "info" : String(level) }); },
      openWindow: async (id, args) => { emit("out", { type: "window", id: String(id), args: args === undefined ? null : plain(args) }); },
    },
    // 5.3: the model, this entry point, and its processing session: every call
    // so far (calls[0] is the first — execute or a webhook), the current one
    // and the one before it; a key–value store and a cache of its own.
    model: (() => {
      const mc = ctx.model || { id: ctx.run.model, name: "", keyword: "", type: "execute", endpoint: "execute", chain: "", call: 0, calls: [], endpoints: ["execute"] };
      const calls = mc.calls || [];
      return {
        id: mc.id, name: mc.name, keyword: mc.keyword,
        type: mc.type, endpoint: mc.endpoint, endpoints: mc.endpoints || [],
        chain: mc.chain, call: mc.call,
        calls,
        current: calls[mc.call] || null,
        last: mc.call > 0 ? calls[mc.call - 1] || null : null,
        first: calls[0] || null,
        session: {
          get: (key) => acall("model.session.get", String(key)),
          set: (key, value, opts) => acall("model.session.set", String(key), value === undefined ? null : value, opts && opts.ttl !== undefined ? opts.ttl : null),
          delete: (key) => acall("model.session.delete", String(key)),
          keys: () => acall("model.session.keys"),
        },
        cache: cacheIn("chain"),
      };
    })(),
    // 5.3: the caller's browser — sandboxed JavaScript, sound, a notice, an app window (sent at once).
    browser: {
      run: async (code, args, opts) => { emit("out", out.js(code, args, opts)); },
      play: async (data, mime, opts) => { emit("out", out.audio(data, mime, { ...(opts || {}), autoplay: true })); },
      flash: async (text, level) => { emit("out", out.flash(text, level)); },
      open: async (id, args) => { emit("out", out.window(id, args)); },
    },
    log,
    out,
    session: {
      id: ctx.session.id,
      get: (key) => acall("session.get", String(key)),
      set: (key, value, opts) => acall("session.set", String(key), value === undefined ? null : value, opts && opts.ttl !== undefined ? opts.ttl : null),
      delete: (key) => acall("session.delete", String(key)),
      keys: () => acall("session.keys"),
    },
    cache: cacheIn("model"),
    codec: {
      base64: bin("codec.b64", false),
      base64url: bin("codec.b64", true),
      base32: { encode: (v, pad) => call("codec.b32.enc", v, pad !== false), decode: (s) => call("codec.b32.dec", String(s)) },
      base58: bin("codec.b58"),
      hex: bin("codec.hex"),
      utf8: { encode: (s) => call("codec.utf8.enc", String(s)), decode: (b) => call("codec.utf8.dec", b) },
      url: {
        encode: (s) => call("codec.url.encode", String(s)),
        decode: (s) => call("codec.url.decode", String(s)),
        parse: (u) => call("codec.url.parse", String(u)),
        build: (base, query) => call("codec.url.build", String(base), query === undefined ? null : query),
      },
      html: { escape: (s) => call("codec.html.escape", String(s)) },
      json: { parse: (s) => JSON.parse(String(s)), stringify: (v, indent) => JSON.stringify(v, null, indent) },
      csv: { parse: (text, opts) => call("codec.csv.parse", String(text), opts || {}), stringify: (rows, opts) => call("codec.csv.stringify", rows, opts || {}) },
      compress: (alg, data, level) => call("codec.compress", String(alg), data, level === undefined ? null : level),
      decompress: (alg, data) => call("codec.decompress", String(alg), data),
      gzip: (data) => call("codec.compress", "gzip", data, null),
      gunzip: (data) => call("codec.decompress", "gzip", data),
    },
    id: {
      uuid: () => call("id.uuid"),
      uuid7: () => call("id.uuid7"),
      ulid: () => call("id.ulid"),
      nanoid: (size, alphabet) => call("id.nanoid", size === undefined ? null : size, alphabet === undefined ? null : alphabet),
      tag: (length) => call("id.tag", length === undefined ? null : length),
      slug: (text, max) => call("id.slug", String(text), max === undefined ? null : max),
    },
    crypto: {
      random: (n) => call("crypto.random", n),
      randomInt: (min, max) => call("crypto.randomInt", min, max),
      uuid: () => call("id.uuid"),
      hash: (alg, data, encoding) => call("crypto.hash", alg, data, encoding === undefined ? null : encoding),
      hmac: (alg, key, data, encoding) => call("crypto.hmac", alg, key, data, encoding === undefined ? null : encoding),
      hkdf: (alg, key, salt, info, length) => call("crypto.hkdf", alg, key, salt === undefined ? "" : salt, info === undefined ? "" : info, length),
      pbkdf2: (password, salt, iterations, length, alg) => call("crypto.pbkdf2", password, salt, iterations, length, alg === undefined ? "sha256" : alg),
      scrypt: (password, salt, length, opts) => call("crypto.scrypt", password, salt, length, opts || {}),
      aesGcm: {
        encrypt: (key, plaintext, aad) => call("crypto.aesGcm.encrypt", key, plaintext, aad === undefined ? null : aad),
        decrypt: (key, sealed, aad) => call("crypto.aesGcm.decrypt", key, sealed, aad === undefined ? null : aad),
      },
      equal: (a, b) => call("crypto.equal", a, b),
      // Bigger, host-side crypto (async): JWT/JWS, X.509, OpenPGP, OpenSSH keys.
      jwt: {
        sign: (spec) => acall("crypto", "jwt.sign", plain(spec)),
        verify: (token, key, opts) => acall("crypto", "jwt.verify", String(token), key, opts ? plain(opts) : {}),
        decode: (token) => acall("crypto", "jwt.decode", String(token)),
      },
      x509: {
        parse: (pem) => acall("crypto", "x509.parse", pem),
        verify: (pem, issuer) => acall("crypto", "x509.verify", pem, issuer),
      },
      pgp: {
        encrypt: (spec) => acall("crypto", "pgp.encrypt", plain(spec)),
        decrypt: (spec) => acall("crypto", "pgp.decrypt", plain(spec)),
        sign: (spec) => acall("crypto", "pgp.sign", plain(spec)),
        verify: (spec) => acall("crypto", "pgp.verify", plain(spec)),
        generateKey: (spec) => acall("crypto", "pgp.generateKey", plain(spec || {})),
      },
      ssh: {
        parse: (spec) => acall("crypto", "ssh.parse", plain(spec)),
        fingerprint: (spec) => acall("crypto", "ssh.fingerprint", plain(spec)),
      },
    },
    codes: {
      render: (spec) => acall("codes", plain(spec)),
      qr: (text, opts) => acall("codes", { ...(opts ? plain(opts) : {}), type: "qr", text: String(text) }),
      barcode: (type, text, opts) => acall("codes", { ...(opts ? plain(opts) : {}), type: String(type), text: String(text) }),
    },
    http: (() => {
      const req = (method, url, opts) => acall("http.request", { ...(opts && typeof opts === "object" ? plain(opts) : {}), method, url: String(url) });
      return {
        request: (spec) => acall("http.request", plain(spec)),
        get: (url, opts) => req("GET", url, opts),
        post: (url, opts) => req("POST", url, opts),
        put: (url, opts) => req("PUT", url, opts),
        patch: (url, opts) => req("PATCH", url, opts),
        delete: (url, opts) => req("DELETE", url, opts),
        head: (url, opts) => req("HEAD", url, opts),
      };
    })(),
    dns: {
      resolve: (name, type) => acall("dns.resolve", String(name), type === undefined ? "A" : String(type)),
    },
    // 5.2: the "/keyword" commands this run's caller may use (for /help, menus).
    functions: {
      list: () => acall("functions.list"),
      get: async (keyword) => { const k = String(keyword || "").replace(/^[/!]/, "").toLowerCase(); return (await acall("functions.list")).find((f) => f.keyword === k) || null; },
    },
    webhook: {
      // Create a URL bound to this run; wait for a POST to it (live continuation).
      create: (spec) => acall("webhook.create", spec ? plain(spec) : {}),
      wait: (hook, opts) => acall("webhook.wait", hook && hook.token ? hook.token : String(hook), opts && opts.timeoutMs ? Number(opts.timeoutMs) : 0),
    },
    ai: {
      // The instance's AI & speech layer, as this run's caller (counted, limited).
      chat: (spec) => acall("ai", "chat", typeof spec === "string" ? { prompt: spec } : plain(spec)),
      models: () => acall("ai", "models"),
      tts: (spec) => acall("ai", "tts", plain(spec)),
      stt: (spec) => acall("ai", "stt", plain(spec)),
      // A small agent loop: the model chooses tools (JSON), the sandbox runs
      // them and feeds results back, until a final answer or maxSteps. A tool
      // marked { approve: true } (or opts.approve) asks the caller first.
      agent: async (goal, opts) => {
        opts = opts || {};
        const tools = Array.isArray(opts.tools) ? opts.tools : [];
        const maxSteps = Math.max(1, Math.min(Number(opts.maxSteps) || 6, 20));
        const desc = tools.map((t) => "- " + t.name + (t.description ? ": " + t.description : "") + (t.parameters ? " · args " + JSON.stringify(t.parameters) : "")).join("\n");
        const system = (opts.system || "You are a helpful agent. Think step by step.")
          + "\nWhen you need a tool, reply with ONLY this JSON: {\"tool\":\"<name>\",\"args\":{...}}."
          + "\nWhen you are done, reply with ONLY this JSON: {\"final\":<answer>}."
          + (desc ? "\nTools you may use:\n" + desc : "\nYou have no tools; answer directly with {\"final\":...}.");
        const messages = [{ role: "user", content: typeof goal === "string" ? goal : JSON.stringify(goal) }];
        const steps = [];
        for (let i = 0; i < maxSteps; i++) {
          const r = await m5.ai.chat({ messages, system, model: opts.model, reasoning: opts.reasoning, json: true });
          let parsed;
          try { parsed = JSON.parse(r.text); } catch (e) { return { answer: r.text, steps, stopped: "not-json" }; }
          if (parsed && parsed.final !== undefined) return { answer: parsed.final, steps };
          if (parsed && parsed.tool) {
            const tool = tools.find((t) => t.name === parsed.tool);
            messages.push({ role: "assistant", content: r.text });
            if (!tool) { messages.push({ role: "user", content: "No such tool \"" + parsed.tool + "\". Use one of the listed tools, or finish." }); continue; }
            if ((opts.approve || tool.approve)) {
              const ok = await m5.prompt({ text: "Run " + tool.name + "(" + JSON.stringify(parsed.args || {}) + ")?", choices: ["yes", "no"] });
              if (ok !== "yes") { messages.push({ role: "user", content: "The caller declined to run that tool. Continue without it, or finish." }); steps.push({ tool: tool.name, args: parsed.args, declined: true }); continue; }
            }
            let result;
            try { result = await tool.run(parsed.args || {}); } catch (e) { result = { error: String((e && e.message) || e) }; }
            steps.push({ tool: tool.name, args: parsed.args, result });
            messages.push({ role: "user", content: "Tool " + tool.name + " returned: " + JSON.stringify(result === undefined ? null : result) });
            continue;
          }
          return { answer: r.text, steps, stopped: "no-action" };
        }
        return { answer: null, steps, stopped: "max-steps" };
      },
    },
    sleep: (ms) => acall("sleep", Number(ms)),
    // Ask the caller and wait for the answer (live). prompt → a choice or text;
    // form → an object of the field values.
    prompt: (spec) => acall("prompt", typeof spec === "string" ? { text: spec } : plain(spec)),
    form: (spec) => acall("form", plain(spec)),
    Error: M5Error,
  };
  freeze(m5);
  Object.defineProperty(globalThis, "m5", { value: m5, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(globalThis, "console", { value: console, enumerable: false, writable: true, configurable: true });

  // The driver module calls this once with the entry module.
  return async function main(mod, name) {
    const fn = mod[name];
    if (typeof fn !== "function") throw new M5Error("no-entry", "the module has no exported function \"" + name + "\"");
    const result = await fn(plain(ctx.inputs));
    return enc({ values: asOutputs(result), result: resultOf(result) });
  };
};
})()`;
