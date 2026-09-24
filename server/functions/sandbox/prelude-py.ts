// The `m5` SDK inside Pyodide (4.15): the same objects and methods as the
// JavaScript one (prelude-js.ts), in snake_case, awaitable where the JS one
// returns a promise.
//
// It runs once when the sandbox warms up. It needs the host module
// `_m5host` (sync, call_async, emit — see engine-py.ts) and leaves behind
// one function, `_m5_execute(spec_json)`, which the engine keeps; then the
// bridges to JavaScript (`js`, `pyodide_js`, `pyodide.*`, `_m5host`) are
// dropped from sys.modules and importing them is refused. (That is a
// courtesy, not the wall: the process around Python is hardened on the
// assumption that a script finds its way to JavaScript anyway.)

export const PRELUDE_PY = String.raw`
import sys as _sys, json as _json, base64 as _b64, builtins as _builtins, importlib as _importlib, inspect as _inspect, os as _os, types as _types, time as _time
import _m5host as _h

class M5Error(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def _default(o):
    if isinstance(o, (bytes, bytearray, memoryview)):
        return {"$b": _b64.b64encode(bytes(o)).decode("ascii")}
    if isinstance(o, (set, frozenset)):
        return list(o)
    if hasattr(o, "isoformat"):
        return o.isoformat()
    if hasattr(o, "__dict__"):
        return {k: v for k, v in vars(o).items() if not k.startswith("_")}
    raise TypeError("m5 cannot pass a " + type(o).__name__)

def _enc(v):
    return _json.dumps(v, default=_default, ensure_ascii=False)

def _hook(o):
    if len(o) == 1 and isinstance(o.get("$b"), str):
        return _b64.b64decode(o["$b"])
    return o

def _dec(s):
    return _json.loads(s, object_hook=_hook)

def _unwrap(r):
    if not r["ok"]:
        raise M5Error(r["e"]["code"], r["e"]["message"])
    return r["v"]

def _call(fn, *args):
    return _unwrap(_dec(_h.sync(fn, _enc(list(args)))))

async def _acall(fn, *args):
    return _unwrap(_dec(await _h.call_async(fn, _enc(list(args)))))

def _emit(kind, payload):
    _h.emit(kind, _enc(payload))

def _plain(v):
    return None if v is None else _dec(_enc(v))

class _NS:
    def __init__(self, **kw):
        self.__dict__.update(kw)
    def __setattr__(self, k, v):
        raise AttributeError("m5 is read-only")
    def __repr__(self):
        return "<m5 " + ", ".join(k for k in self.__dict__ if not k.startswith("_")) + ">"

class Output(dict):
    """An output of a run (m5.out.*)."""

def _bytes_or_text(v, what):
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v)
    if isinstance(v, str):
        return v.encode("utf-8")
    raise M5Error("bad-argument", what + " must be bytes or text")

def _out_text(text): return Output(type="text", text=str(text))
def _out_markdown(text): return Output(type="markdown", text=str(text))
def _out_code(text, lang=""): return Output(type="code", text=str(text), lang=str(lang))
def _out_table(columns, rows, title=None):
    o = Output(type="table", columns=[str(c) for c in columns], rows=[[_plain(c) for c in (r if isinstance(r, (list, tuple)) else [r])] for r in rows])
    if title is not None: o["title"] = str(title)
    return o
def _out_json(value, title=None):
    o = Output(type="json", value=_plain(value))
    if title is not None: o["title"] = str(title)
    return o
def _out_image(data, mime="image/png", alt=None):
    o = Output(type="image", mime=str(mime), data=_b64.b64encode(_bytes_or_text(data, "image data")).decode("ascii"))
    if alt is not None: o["alt"] = str(alt)
    return o
def _out_file(name, data, mime="application/octet-stream"):
    return Output(type="file", name=str(name), mime=str(mime), data=_b64.b64encode(_bytes_or_text(data, "file data")).decode("ascii"))

def _as_output(v):
    if v is None: return None
    if isinstance(v, Output): return dict(v)
    if isinstance(v, str): return dict(_out_text(v))
    return dict(_out_json(v))

def _show(v):
    if isinstance(v, str): return v
    try: return _enc(v)
    except Exception: return repr(v)

def _write(level, msg, fields):
    p = {"level": level, "msg": _show(msg)}
    if fields: p["fields"] = _plain(fields)
    _emit("log", p)

class _Trace:
    def __init__(self, label): self.label = str(label)
    def _done(self): _write("debug", "trace " + self.label, {"label": self.label, "ms": int((_time.monotonic() - self.t0) * 1000)})
    def __enter__(self): self.t0 = _time.monotonic(); return self
    def __exit__(self, *exc): self._done(); return False
    async def __aenter__(self): self.t0 = _time.monotonic(); return self
    async def __aexit__(self, *exc): self._done(); return False

def _trace(label, fn=None):
    if fn is None:
        return _Trace(label)
    t = _Trace(label).__enter__()
    try:
        r = fn()
    except BaseException:
        t._done(); raise
    if _inspect.isawaitable(r):
        async def wait():
            try: return await r
            finally: t._done()
        return wait()
    t._done()
    return r

def _cache_in(scope):
    return _NS(
        scope=lambda name: _cache_in(str(name)),
        get=lambda key: _acall("cache.get", scope, str(key)),
        set=lambda key, value, ttl=None: _acall("cache.set", scope, str(key), value, ttl),
        incr=lambda key, by=1, ttl=None: _acall("cache.incr", scope, str(key), by, ttl),
        delete=lambda key: _acall("cache.delete", scope, str(key)),
        lock=lambda key, ttl=None, wait_ms=0: _acall("cache.lock", scope, str(key), ttl, wait_ms),
        unlock=lambda key, token: _acall("cache.unlock", scope, str(key), str(token)),
    )

def _bin(name, url=None):
    return _NS(encode=lambda v: _call(name + ".enc", v, url), decode=lambda s: _call(name + ".dec", str(s)))

async def _send(output):
    o = _as_output(output)
    if o is not None: _emit("out", o)

async def _flash(text, level="info"):
    _emit("out", {"type": "flash", "text": str(text), "level": str(level)})

async def _open_window(id, args=None):
    _emit("out", {"type": "window", "id": str(id), "args": _plain(args)})

class _Stream:
    def __init__(self, level): self.level = level; self.buf = ""
    def write(self, s):
        self.buf += str(s)
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            _write(self.level, line, None)
        return len(s)
    def flush(self):
        if self.buf: _write(self.level, self.buf, None); self.buf = ""
    def isatty(self): return False

_ctx = {}
m5 = None

def _setup(ctx):
    global m5
    _ctx.update(ctx)
    c = ctx["caller"]; r = ctx["run"]
    m5 = _NS(
        sys=_NS(version=ctx["sys"]["version"], instance=ctx["sys"]["instance"], lang=c["lang"], tz=c["tz"], limits=ctx["limits"],
                now=lambda: int(_time.time() * 1000), remaining=lambda: max(0, r["deadline"] - int(_time.time() * 1000))),
        run=_NS(id=r["id"], model=r["model"], entry=r["entry"], inputs=_plain(ctx["inputs"]), executor=r["executor"], parent=r["parent"],
                started_at=r["startedAt"], deadline=r["deadline"], test=r["test"],
                progress=lambda p, text="": _emit("progress", {"p": float(p), "text": str(text)})),
        caller=_NS(kind=c["kind"], name=c["name"], groups=list(c["groups"]), room=c["room"], client=c["client"], lang=c["lang"], tz=c["tz"],
                   send=_send, flash=_flash, open_window=_open_window),
        log=_NS(debug=lambda msg, **f: _write("debug", msg, f), info=lambda msg, **f: _write("info", msg, f),
                warn=lambda msg, **f: _write("warn", msg, f), error=lambda msg, **f: _write("error", msg, f), trace=_trace),
        out=_NS(text=_out_text, markdown=_out_markdown, code=_out_code, table=_out_table, json=_out_json, image=_out_image, file=_out_file),
        session=_NS(id=ctx["session"]["id"],
                    get=lambda key: _acall("session.get", str(key)),
                    set=lambda key, value, ttl=None: _acall("session.set", str(key), value, ttl),
                    delete=lambda key: _acall("session.delete", str(key)),
                    keys=lambda: _acall("session.keys")),
        cache=_cache_in("model"),
        codec=_NS(
            base64=_bin("codec.b64", False), base64url=_bin("codec.b64", True),
            base32=_NS(encode=lambda v, pad=True: _call("codec.b32.enc", v, pad), decode=lambda s: _call("codec.b32.dec", str(s))),
            base58=_bin("codec.b58"), hex=_bin("codec.hex"),
            utf8=_NS(encode=lambda s: _call("codec.utf8.enc", str(s)), decode=lambda b: _call("codec.utf8.dec", b)),
            url=_NS(encode=lambda s: _call("codec.url.encode", str(s)), decode=lambda s: _call("codec.url.decode", str(s)),
                    parse=lambda u: _call("codec.url.parse", str(u)), build=lambda base, query=None: _call("codec.url.build", str(base), query)),
            html=_NS(escape=lambda s: _call("codec.html.escape", str(s))),
            json=_NS(parse=lambda s: _json.loads(s), stringify=lambda v, indent=None: _json.dumps(v, indent=indent, ensure_ascii=False, default=_default)),
            csv=_NS(parse=lambda text, delimiter=",", header=False: _call("codec.csv.parse", str(text), {"delimiter": delimiter, "header": header}),
                    stringify=lambda rows, delimiter=",": _call("codec.csv.stringify", rows, {"delimiter": delimiter})),
            compress=lambda alg, data, level=None: _call("codec.compress", str(alg), data, level),
            decompress=lambda alg, data: _call("codec.decompress", str(alg), data),
            gzip=lambda data: _call("codec.compress", "gzip", data, None),
            gunzip=lambda data: _call("codec.decompress", "gzip", data),
        ),
        id=_NS(uuid=lambda: _call("id.uuid"), uuid7=lambda: _call("id.uuid7"), ulid=lambda: _call("id.ulid"),
               nanoid=lambda size=None, alphabet=None: _call("id.nanoid", size, alphabet), tag=lambda length=None: _call("id.tag", length),
               slug=lambda text, max=None: _call("id.slug", str(text), max)),
        crypto=_NS(
            random=lambda n: _call("crypto.random", n), random_int=lambda min, max: _call("crypto.randomInt", min, max), uuid=lambda: _call("id.uuid"),
            hash=lambda alg, data, encoding=None: _call("crypto.hash", alg, data, encoding),
            hmac=lambda alg, key, data, encoding=None: _call("crypto.hmac", alg, key, data, encoding),
            hkdf=lambda alg, key, salt=b"", info=b"", length=32: _call("crypto.hkdf", alg, key, salt, info, length),
            pbkdf2=lambda password, salt, iterations, length, alg="sha256": _call("crypto.pbkdf2", password, salt, iterations, length, alg),
            scrypt=lambda password, salt, length, N=16384, r=8, p=1: _call("crypto.scrypt", password, salt, length, {"N": N, "r": r, "p": p}),
            aes_gcm=_NS(encrypt=lambda key, plaintext, aad=None: _call("crypto.aesGcm.encrypt", key, plaintext, aad),
                        decrypt=lambda key, sealed, aad=None: _call("crypto.aesGcm.decrypt", key, sealed, aad)),
            equal=lambda a, b: _call("crypto.equal", a, b),
        ),
        sleep=lambda ms: _acall("sleep", ms),
        Error=M5Error,
        Output=Output,
    )
    mod = _types.ModuleType("m5", "The M5cet function SDK.")
    mod.__dict__.update({k: v for k, v in m5.__dict__.items()})
    _sys.modules["m5"] = mod
    _builtins.m5 = m5
    _sys.stdout = _Stream("stdout")
    _sys.stderr = _Stream("stderr")

def _write_tree(root, files):
    for path, text in files.items():
        full = _os.path.join(root, path)
        _os.makedirs(_os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(text)

async def _m5_execute(spec_json):
    spec = _json.loads(spec_json)
    ctx = dict(spec["context"]); ctx["inputs"] = spec["inputs"]; ctx["limits"] = spec["limits"]
    _setup(ctx)
    _write_tree("/m5/app", spec["files"])
    for name, dep in spec["deps"].items():
        _write_tree("/m5/deps/pkg/" + name.replace("-", "_"), dep["files"])
    _sys.path[:0] = ["/m5/app", "/m5/deps"]
    _importlib.invalidate_caches()
    entry = spec["entry"]
    module = entry["file"][:-3].replace("/", ".") if entry["file"].endswith(".py") else entry["file"].replace("/", ".")
    mod = _importlib.import_module(module)
    fn = getattr(mod, entry["fn"], None)
    if not callable(fn):
        raise M5Error("no-entry", "the module has no function " + repr(entry["fn"]))
    result = fn(**_plain(spec["inputs"]))
    if _inspect.isawaitable(result):
        result = await result
    _sys.stdout.flush(); _sys.stderr.flush()
    return _enc(_as_output(result))

_BLOCKED = ("js", "pyodide_js", "pyodide", "_pyodide", "_pyodide_core", "micropip", "_m5host", "pyodide_http")

class _Blocker:
    @staticmethod
    def find_spec(name, path=None, target=None):
        if name.split(".")[0] in _BLOCKED:
            raise ImportError("module " + repr(name) + " is not available in the sandbox")
        return None

def _seal():
    for name in list(_sys.modules):
        if name.split(".")[0] in _BLOCKED:
            del _sys.modules[name]
    _sys.meta_path.insert(0, _Blocker)
`;
