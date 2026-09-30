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

# 6.3 define: m5mobile.define — the operator's typed constants/variables read by
# item (define["name"]) or attribute (define.name); read-only. A script value
# stays as data ({"__m5script": True, "code": ..., "lang": ...}), never run.
class _DefineNS(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)
    def __setattr__(self, k, v):
        raise AttributeError("m5mobile.define is read-only")
    def __setitem__(self, k, v):
        raise TypeError("m5mobile.define is read-only")
    def __delitem__(self, k):
        raise TypeError("m5mobile.define is read-only")

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

# 5.3: media, a notice, an app window, buttons, forms and browser JavaScript.
def _media_bytes(v, what):
    if isinstance(v, dict) and ("audio" in v or "data" in v):
        return _bytes_or_text(v.get("audio") or v.get("data"), what + " data")
    return _bytes_or_text(v, what + " data")
def _media(o, kind, data, mime, title=None, autoplay=False, loop=False):
    o = Output(type=kind, mime=str(mime), data=_b64.b64encode(_media_bytes(data, kind)).decode("ascii"))
    if title is not None: o["title"] = str(title)
    if autoplay: o["autoplay"] = True
    if loop: o["loop"] = True
    return o
def _out_audio(data, mime="audio/wav", title=None, autoplay=False, loop=False): return _media(None, "audio", data, mime, title, autoplay, loop)
def _out_video(data, mime="video/mp4", title=None, autoplay=False, loop=False): return _media(None, "video", data, mime, title, autoplay, loop)
def _out_flash(text, level="info"): return Output(type="flash", text=str(text), level=str(level))
def _out_window(id, args=None): return Output(type="window", id=str(id), args=_plain(args))
def _out_button(spec=None, title=None, **opts):
    if isinstance(spec, str):
        return Output(type="button", **{**_plain(opts), "name": spec, "title": str(title) if title is not None else spec})
    return Output(type="button", **_plain(spec or opts))
def _out_buttons(items): return [_out_button(b) for b in (items or [])]
def _out_form(spec=None, **kw): return Output(type="form", **_plain(spec or kw))
def _out_js(code, args=None, **opts):
    o = Output(type="js", code=str(code), **_plain(opts))
    if args is not None: o["args"] = _plain(args)
    return o

# A plain dict is an output when its type is one and it has a key of that type
# ({"type": "flash", "text": …}); {"type": "button", "data": …} is data.
_OUT_KEYS = {"text": ("text",), "markdown": ("text",), "code": ("text",), "table": ("columns", "rows"), "json": ("value",), "image": ("data", "mime"),
             "file": ("name", "data"), "flash": ("text",), "window": ("id",), "audio": ("data", "mime"), "video": ("data", "mime"),
             "button": ("name", "title"), "form": ("fields", "panels"), "js": ("code",)}

def _is_out(v):
    if isinstance(v, Output): return True
    if not isinstance(v, dict): return False
    keys = _OUT_KEYS.get(v.get("type")) if isinstance(v.get("type"), str) else None
    return bool(keys) and any(k in v for k in keys)

def _as_output(v):
    if v is None: return None
    if isinstance(v, Output): return dict(v)
    if isinstance(v, str): return dict(_out_text(v))
    if _is_out(v): return _plain(v)
    return dict(_out_json(v))

def _has_out(v):
    return isinstance(v, (list, tuple)) and any(_is_out(x) or _has_out(x) for x in v)

def _flat_outs(v):
    out = []
    for x in v:
        if _has_out(x): out.extend(_flat_outs(x))
        else: out.append(x)
    return out

def _as_outputs(v):
    """A list whose items are outputs is several outputs (lists of outputs inside it — m5.out.buttons — join it);
    any other list is one JSON value."""
    if v is None: return []
    if _has_out(v):
        return [_as_output(x) for x in _flat_outs(v) if x is not None]
    return [_as_output(v)]

def _result_of(v):
    def cut(x, depth):
        if x is None: return None
        if isinstance(x, str): return x if len(x) <= 4000 else x[:4000] + "… (" + str(len(x)) + " characters)"
        if isinstance(x, (int, float, bool)): return x
        if depth > 12: return "…"
        if isinstance(x, list): return [cut(y, depth + 1) for y in x[:500]]
        if isinstance(x, dict):
            if len(x) == 1 and isinstance(x.get("$b"), str): return "(" + str(len(x["$b"]) * 3 // 4) + " bytes)"
            return {k: cut(x[k], depth + 1) for k in list(x)[:500]}
        return str(x)
    try:
        return cut(_json.loads(_enc(v)), 0)
    except Exception:
        return repr(v)

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
    for o in _as_outputs(output):
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

async def _ai_agent(goal, tools=None, max_steps=6, system=None, model=None, reasoning=None, approve=False):
    tools = tools or []
    max_steps = max(1, min(int(max_steps), 20))
    desc = "\n".join("- " + t["name"] + ((": " + t["description"]) if t.get("description") else "") for t in tools)
    sysmsg = (system or "You are a helpful agent. Think step by step.") \
        + "\nWhen you need a tool, reply with ONLY this JSON: {\"tool\":\"<name>\",\"args\":{...}}." \
        + "\nWhen you are done, reply with ONLY this JSON: {\"final\":<answer>}." \
        + (("\nTools you may use:\n" + desc) if desc else "\nYou have no tools; answer with {\"final\":...}.")
    messages = [{"role": "user", "content": goal if isinstance(goal, str) else _json.dumps(goal)}]
    steps = []
    for _ in range(max_steps):
        r = await m5.ai.chat({"messages": messages, "system": sysmsg, "model": model, "reasoning": reasoning, "json": True})
        try:
            parsed = _json.loads(r["text"])
        except Exception:
            return {"answer": r["text"], "steps": steps, "stopped": "not-json"}
        if isinstance(parsed, dict) and "final" in parsed:
            return {"answer": parsed["final"], "steps": steps}
        if isinstance(parsed, dict) and parsed.get("tool"):
            tool = next((t for t in tools if t["name"] == parsed["tool"]), None)
            messages.append({"role": "assistant", "content": r["text"]})
            if tool is None:
                messages.append({"role": "user", "content": "No such tool " + repr(parsed["tool"]) + ". Use a listed tool, or finish."})
                continue
            if approve or tool.get("approve"):
                ok = await m5.prompt({"text": "Run " + tool["name"] + "(" + _json.dumps(parsed.get("args") or {}) + ")?", "choices": ["yes", "no"]})
                if ok != "yes":
                    steps.append({"tool": tool["name"], "args": parsed.get("args"), "declined": True})
                    messages.append({"role": "user", "content": "The caller declined that tool. Continue or finish."})
                    continue
            try:
                res = tool["run"](parsed.get("args") or {})
                if _inspect.isawaitable(res):
                    res = await res
            except Exception as e:
                res = {"error": str(e)}
            steps.append({"tool": tool["name"], "args": parsed.get("args"), "result": res})
            messages.append({"role": "user", "content": "Tool " + tool["name"] + " returned: " + _json.dumps(res)})
            continue
        return {"answer": r["text"], "steps": steps, "stopped": "no-action"}
    return {"answer": None, "steps": steps, "stopped": "max-steps"}

async def _browser_run(code, args=None, **opts): _emit("out", dict(_out_js(code, args, **opts)))
async def _browser_play(data, mime="audio/wav", title=None, loop=False): _emit("out", dict(_out_audio(data, mime, title, True, loop)))
async def _browser_flash(text, level="info"): _emit("out", dict(_out_flash(text, level)))
async def _browser_open(id, args=None): _emit("out", dict(_out_window(id, args)))

def _model_ns(ctx):
    mc = ctx.get("model") or {"id": ctx["run"]["model"], "name": "", "keyword": "", "type": "execute", "endpoint": "execute", "chain": "", "call": 0, "calls": [], "endpoints": ["execute"]}
    calls = list(mc.get("calls") or [])
    i = int(mc.get("call") or 0)
    return _NS(id=mc.get("id"), name=mc.get("name", ""), keyword=mc.get("keyword", ""), type=mc.get("type", "execute"), endpoint=mc.get("endpoint", "execute"),
               endpoints=list(mc.get("endpoints") or []), chain=mc.get("chain", ""), call=i, calls=calls,
               current=calls[i] if i < len(calls) else None, last=calls[i - 1] if 0 < i <= len(calls) else None, first=calls[0] if calls else None,
               session=_NS(get=lambda key: _acall("model.session.get", str(key)),
                           set=lambda key, value, ttl=None: _acall("model.session.set", str(key), value, ttl),
                           delete=lambda key: _acall("model.session.delete", str(key)),
                           keys=lambda: _acall("model.session.keys")),
               cache=_cache_in("chain"))

# ---- m5adm (6.0): the administration, as the owner granted the model ----

def _adm(obj, op, *args):
    return _acall("adm", obj, op, [_plain(a) for a in args])

def _adm_ops(obj, names):
    return {n: (lambda n: (lambda *a: _adm(obj, n, *a)))(n) for n in names}

async def _saved_id(coro):
    r = await coro
    if r and r.get("saved"):
        return r["id"]
    _write("warn", "m5adm: not saved — " + str((r or {}).get("error", "unknown")), {})
    return -1

def _member(u):
    if u is None:
        return None
    if isinstance(u, dict):
        return {k: u.get(k) for k in ("peerId", "accountId", "name") if u.get(k)}
    return str(u)

class M5Room(dict):
    """A room with its controls: the data of rooms.get / rooms.list, and methods that act on it."""
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)
    def wall_msg(self, text, level="info", pin=None, **opts):
        return _adm("rooms", "wall_msg", self["id"], str(text), {"level": level, **({"pin": pin} if pin is not None else {}), **opts})
    def user_msg(self, user, text, **opts):
        return _adm("rooms", "user_msg", self["id"], _member(user), str(text), opts)
    def user_flash(self, user, text, level="info"):
        return _adm("rooms", "user_flash", self["id"], _member(user), str(text), str(level))
    def disconnect(self, user=None, reason=""):
        return _adm("rooms", "disconnect", self["id"], _member(user), str(reason))
    def block(self, reason="", minutes=None, kick=True, **opts):
        return _adm("rooms", "block", self["id"], {"reason": reason, "kick": kick, **({"minutes": minutes} if minutes else {}), **opts})
    def unblock(self):
        return _adm("rooms", "unblock", self["id"])
    def connect(self, user=None, **opts):
        return _adm("rooms", "connect", self["id"], _member(user), opts)
    def log(self, **opts):
        return _adm("rooms", "log", self["id"], opts)
    async def refresh(self):
        d = await _adm("rooms", "get", self["id"])
        if d:
            self.update(d)
        return self if d else None
    def save(self):
        return _saved_id(_adm("rooms", "set", self["id"], dict(self)))
    def forget(self):
        return _adm("rooms", "delete", self["id"])

async def _rooms_list(filters=None, match="all"):
    return [M5Room(d) for d in await _adm("rooms", "list", filters, {"match": match})]

async def _rooms_get(room_id):
    d = await _adm("rooms", "get", room_id)
    return M5Room(d) if d else None

def _adm_ns():
    rooms = dict(
        list=_rooms_list, get=_rooms_get,
        set=lambda room_id, room=None: _saved_id(_adm("rooms", "set", room_id, dict(room or {}))),
        delete=lambda room_id: _adm("rooms", "delete", room_id),
        stats=lambda: _adm("rooms", "stats"),
        wall_msg=lambda room_id, text, level="info", pin=None: _adm("rooms", "wall_msg", room_id, str(text), {"level": level, **({"pin": pin} if pin is not None else {})}),
        user_msg=lambda room_id, user, text: _adm("rooms", "user_msg", room_id, _member(user), str(text), {}),
        user_flash=lambda room_id, user, text, level="info": _adm("rooms", "user_flash", room_id, _member(user), str(text), str(level)),
        disconnect=lambda room_id, user=None, reason="": _adm("rooms", "disconnect", room_id, _member(user), str(reason)),
        block=lambda room_id, reason="", minutes=None, kick=True: _adm("rooms", "block", room_id, {"reason": reason, "kick": kick, **({"minutes": minutes} if minutes else {})}),
        unblock=lambda room_id: _adm("rooms", "unblock", room_id),
        connect=lambda room_id, user=None, **o: _adm("rooms", "connect", room_id, _member(user), o),
        log=lambda room_id, **o: _adm("rooms", "log", room_id, o),
    )
    setter = lambda obj: (lambda key, value=None: _saved_id(_adm(obj, "set", key, value or {})))
    return _NS(
        info=lambda: _acall("adm.info"),
        overview=_NS(**_adm_ops("overview", ["get", "system", "alerts", "db", "backups", "metrics", "whoami"])),
        rooms=_NS(**rooms),
        connections=_NS(**_adm_ops("connections", ["list", "get", "close", "stats"])),
        traffic=_NS(**_adm_ops("traffic", ["list", "summary", "rates", "events", "watch"])),
        modules=_NS(**_adm_ops("modules", ["list", "get", "enable", "state", "switch"]), set=setter("modules")),
        groups=_NS(**_adm_ops("groups", ["list", "get", "delete", "add_member", "remove_member"]), set=setter("groups")),
        users=_NS(**_adm_ops("users", ["list", "get", "signout", "delete", "passkeys", "remove_passkey"])),
        passkeys=_NS(**_adm_ops("passkeys", ["list", "get", "delete"])),
        queue=_NS(**_adm_ops("queue", ["list", "stats", "get", "dead", "revive"])),
        audit=_NS(**_adm_ops("audit", ["list", "stats", "verify", "checkpoint", "communication", "add"])),
        commands=_NS(**_adm_ops("commands", ["list", "allowlist", "send"])),
        push=_NS(**_adm_ops("push", ["status", "send"])),
        admins=_NS(**_adm_ops("admins", ["list", "get", "delete"]), set=setter("admins")),
        Room=M5Room,
    )

# ---- m5.telephony (6.0): calls, SMS, chat messages, lookups, the audio bridge ----

def _tel(op, *args):
    return _acall("telephony", op, [_plain(a) for a in args])

def _say(text, **o): return {"say": {**o, "text": str(text)}}
def _play(url, **o): return {"play": {**o, "url": str(url)}}
def _pause(seconds=1): return {"pause": {"seconds": float(seconds)}}
def _gather(**o): return {"gather": {"digits": 5, "finishOnKey": "#", "timeout": 10, **o}}
def _record(**o): return {"record": {"maxSeconds": 60, "beep": True, **o}}
def _redirect(url): return {"redirect": {"url": str(url)}}
def _hangup_action(): return {"hangup": {}}

_HANDLER_OF = {"answered": "answer", "completed": "hangup", "busy": "busy", "no-answer": "noanswer", "failed": "failed", "canceled": "failed", "machine": "machine"}

def _call_spec(spec):
    fns, names, rest = {}, {}, {}
    def put(k, v):
        ev = str(k)
        if ev.lower().startswith("on"):
            ev = ev[2:]
        ev = ev.lstrip("_").replace("_", "").replace("-", "").lower()
        if callable(v):
            fns[ev] = v
        elif isinstance(v, str) and v:
            names[ev] = v
    for k, v in (spec or {}).items():
        if k == "on" and isinstance(v, dict):
            for kk, vv in v.items():
                put(kk, vv)
        elif str(k).startswith("on_") or callable(v):
            put(k, v)
        else:
            rest[k] = v
    return fns, names, rest

async def _wait_for(call_id, fns, opts):
    cursor, last, events = 0, None, []
    budget = min(float((opts or {}).get("timeoutMs") or 600000), max(0, m5.sys.remaining() - 1500))
    until = m5.sys.now() + budget
    while m5.sys.now() < until:
        r = await _tel("wait", call_id, cursor, min(20000, max(0, until - m5.sys.now())))
        if not r:
            return None
        last = r["call"]
        for ev in r["events"]:
            cursor = max(cursor, ev["seq"])
            events.append(ev)
            name = "digits" if ev.get("kind") == "gather" else _HANDLER_OF.get(ev.get("status") or "")
            f = fns.get(name) if name else None
            if not f:
                continue
            out = f({**ev, "call": r["call"]})
            if _inspect.isawaitable(out):
                out = await out
            if out and not r["call"]["final"]:
                await _tel("calls.steer", call_id, out)
        if last["final"]:
            break
    return {**(last or {"id": call_id}), "events": events}

async def _tel_call(spec=None, **kw):
    fns, names, rest = _call_spec({**(spec or {}), **kw})
    wait = rest.get("wait") is True or rest.get("mode") == "sync" or bool(fns)
    native = bool(rest.get("twiml") or rest.get("ncco") or rest.get("texml"))
    c = await _tel("call", {**rest, "handlers": names, "mode": "native" if native else ("sync" if wait else "async")})
    return (await _wait_for(c["id"], fns, rest)) if wait else c

def _id_of(x):
    return x.get("id") if isinstance(x, dict) else x

def _telephony_ns():
    return _NS(
        providers=lambda: _tel("providers"),
        call=_tel_call,
        wait=lambda call, **o: _wait_for(_id_of(call), _call_spec(o)[0], o),
        say=lambda call, text, **o: _tel("calls.steer", _id_of(call), [_say(text, **o)]),
        hangup=lambda call: _tel("calls.hangup", _id_of(call)),
        steer=lambda call, logic: _tel("calls.steer", _id_of(call), logic),
        calls=_NS(get=lambda call_id: _tel("calls.get", call_id), list=lambda **f: _tel("calls.list", f),
                  hangup=lambda call_id: _tel("calls.hangup", call_id), steer=lambda call_id, logic: _tel("calls.steer", call_id, logic)),
        sms=lambda spec=None, text=None, **kw: _tel("sms", {"to": spec, "text": text, **kw} if isinstance(spec, str) else {**(spec or {}), **kw}),
        whatsapp=lambda spec=None, **kw: _tel("message", "whatsapp", {**(spec or {}), **kw}),
        viber=lambda spec=None, **kw: _tel("message", "viber", {**(spec or {}), **kw}),
        messenger=lambda spec=None, **kw: _tel("message", "messenger", {**(spec or {}), **kw}),
        messages=_NS(get=lambda message_id: _tel("messages.get", message_id)),
        lookup=lambda number, **o: _tel("lookup", str(number), o),
        hlr=lambda number, **o: _tel("hlr", str(number), o),
        did=_NS(allocate=lambda spec=None, **kw: _tel("did.allocate", {**(spec or {}), **kw}), get=lambda session_id: _tel("did.get", session_id),
                list=lambda **f: _tel("did.list", f), release=lambda session: _tel("did.release", _id_of(session))),
        log=lambda **f: _tel("log", f),
        actions=_NS(say=_say, play=_play, pause=_pause, gather=_gather, record=_record, redirect=_redirect, hangup=_hangup_action),
    )

# ---- m5.nfc (6.3): drive the caller's NFC hardware, two-way ----
# Each op becomes an NfcCommand the runner sends to the caller's device as an
# "nfc" interaction; the device runs it on the reader and answers with an
# NfcResult. A protected card is used by name (secretRef) — a key or PIN never
# crosses this boundary.

_NFC_READ_OP = {"uid": "read-uid", "public": "read-public", "ndef": "ndef-read", "sector": "classic-read", "sectors": "classic-read", "dump": "classic-dump", "page": "ntag-read", "pages": "ntag-read", "ultralight": "ul-read", "file": "desfire-read", "files": "desfire-files", "apps": "desfire-apps", "counter": "ntag-counter", "vicinity": "v-read", "felica": "felica-read", "apdu": "raw-apdu"}
_NFC_WRITE_OP = {"ndef": "ndef-write", "block": "classic-write", "sector": "classic-write", "page": "ntag-write", "ultralight": "ul-write", "uid": "write-uid", "lock": "ndef-lock", "record": "m5-write", "records": "m5-write", "restore": "classic-restore", "vicinity": "v-write"}

def _nfc_send(op, reader, o):
    o = o or {}
    return _acall("nfc", {
        "op": op,
        "reader": reader if reader else (o.get("reader") if isinstance(o.get("reader"), str) else None),
        "tech": o.get("tech") if isinstance(o.get("tech"), str) else None,
        "timeout": o.get("timeout"),
        "args": o.get("args") if isinstance(o.get("args"), dict) else None,
        "secretRef": o.get("secretRef") if isinstance(o.get("secretRef"), str) else None,
        "records": o.get("records") if isinstance(o.get("records"), list) else None,
    })

# Record content is payload the model builds, so it travels in args.records;
# command.records is only record-type names to open.
def _nfc_write_args(o):
    a = dict(o.get("args")) if isinstance(o.get("args"), dict) else {}
    for k in ("ndef", "data", "uid", "block", "page", "value"):
        if o.get(k) is not None:
            a[k] = o[k]
    if isinstance(o.get("records"), list):
        a["records"] = o["records"]
    return a

def _make_nfc(reader):
    def read(what="public", **o):
        return _nfc_send(o.get("op") or _NFC_READ_OP.get(str(what), "read-public"), reader, o)
    def write(what="ndef", **o):
        return _nfc_send(o.get("op") or _NFC_WRITE_OP.get(str(what), "ndef-write"), reader, {**o, "args": _nfc_write_args(o), "records": None})
    def emulate(**o):
        return _nfc_send(o.get("op") or ("conn-emulate" if o.get("tech") == "connection-tag" else "m5-emulate"), reader, {**o, "args": _nfc_write_args(o), "records": None})
    def m5_write(records=None, **o):
        return _nfc_send("m5-write", reader, {**o, "args": _nfc_write_args({**o, "records": records if isinstance(records, list) else o.get("records")}), "records": None})
    return _NS(
        reader=lambda kind: _make_nfc(str(kind)),
        enum=lambda **o: _nfc_send("enum", reader, o),
        card=lambda **o: _nfc_send("read-uid", reader, o),
        scan=lambda **o: _nfc_send("scan", reader, o),
        read=read,
        write=write,
        emulate=emulate,
        m5=_NS(read=lambda **o: _nfc_send("m5-read", reader, o), write=m5_write, build=m5_write,
               erase=lambda **o: _nfc_send("m5-erase", reader, o), emulate=lambda **o: _nfc_send("m5-emulate", reader, o)),
    )

def _nfc_ns():
    return _make_nfc(None)

_ctx = {}
m5 = None
m5adm = None

def _setup(ctx):
    global m5, m5adm
    m5adm = _adm_ns()
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
        out=_NS(text=_out_text, markdown=_out_markdown, code=_out_code, table=_out_table, json=_out_json, image=_out_image, file=_out_file,
                audio=_out_audio, video=_out_video, flash=_out_flash, window=_out_window, button=_out_button, buttons=_out_buttons, form=_out_form, js=_out_js),
        model=_model_ns(ctx),
        browser=_NS(run=_browser_run, play=_browser_play, flash=_browser_flash, open=_browser_open),
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
            jwt=_NS(sign=lambda spec: _acall("crypto", "jwt.sign", spec),
                    verify=lambda token, key, opts=None: _acall("crypto", "jwt.verify", token, key, opts or {}),
                    decode=lambda token: _acall("crypto", "jwt.decode", token)),
            x509=_NS(parse=lambda pem: _acall("crypto", "x509.parse", pem),
                     verify=lambda pem, issuer: _acall("crypto", "x509.verify", pem, issuer)),
            pgp=_NS(encrypt=lambda spec: _acall("crypto", "pgp.encrypt", spec),
                    decrypt=lambda spec: _acall("crypto", "pgp.decrypt", spec),
                    sign=lambda spec: _acall("crypto", "pgp.sign", spec),
                    verify=lambda spec: _acall("crypto", "pgp.verify", spec),
                    generate_key=lambda **spec: _acall("crypto", "pgp.generateKey", spec)),
            ssh=_NS(parse=lambda spec: _acall("crypto", "ssh.parse", spec),
                    fingerprint=lambda spec: _acall("crypto", "ssh.fingerprint", spec)),
        ),
        codes=_NS(
            render=lambda spec: _acall("codes", spec),
            qr=lambda text, **o: _acall("codes", {**o, "type": "qr", "text": text}),
            barcode=lambda type, text, **o: _acall("codes", {**o, "type": type, "text": text}),
        ),
        http=_NS(
            request=lambda spec: _acall("http.request", spec),
            get=lambda url, **o: _acall("http.request", {**o, "method": "GET", "url": url}),
            post=lambda url, **o: _acall("http.request", {**o, "method": "POST", "url": url}),
            put=lambda url, **o: _acall("http.request", {**o, "method": "PUT", "url": url}),
            patch=lambda url, **o: _acall("http.request", {**o, "method": "PATCH", "url": url}),
            delete=lambda url, **o: _acall("http.request", {**o, "method": "DELETE", "url": url}),
            head=lambda url, **o: _acall("http.request", {**o, "method": "HEAD", "url": url}),
        ),
        dns=_NS(resolve=lambda name, type="A": _acall("dns.resolve", name, type)),
        webhook=_NS(
            create=lambda **spec: _acall("webhook.create", spec),
            wait=lambda hook, timeout_ms=0: _acall("webhook.wait", hook["token"] if isinstance(hook, dict) else hook, timeout_ms),
        ),
        ai=_NS(
            chat=lambda spec=None, **kw: _acall("ai", "chat", {"prompt": spec} if isinstance(spec, str) else (spec or kw)),
            models=lambda: _acall("ai", "models"),
            tts=lambda **spec: _acall("ai", "tts", spec),
            stt=lambda **spec: _acall("ai", "stt", spec),
            agent=_ai_agent,
        ),
        functions=_NS(list=lambda: _acall("functions.list"), get=_functions_get),
        telephony=_telephony_ns(),
        nfc=_nfc_ns(),
        sleep=lambda ms: _acall("sleep", ms),
        prompt=lambda spec=None, **kw: _acall("prompt", {"text": spec} if isinstance(spec, str) else (spec or kw)),
        form=lambda spec=None, **kw: _acall("form", spec or kw),
        Error=M5Error,
        Output=Output,
        adm=m5adm,
    )
    mod = _types.ModuleType("m5", "The M5cet function SDK.")
    mod.__dict__.update({k: v for k, v in m5.__dict__.items()})
    _sys.modules["m5"] = mod
    _builtins.m5 = m5
    adm_mod = _types.ModuleType("m5adm", "The M5cet administration SDK (6.0).")
    adm_mod.__dict__.update({k: v for k, v in m5adm.__dict__.items()})
    _sys.modules["m5adm"] = adm_mod
    _builtins.m5adm = m5adm
    # 6.3 define: m5mobile.define — the operator's typed constants/variables
    # (Android › Define), a per-run snapshot (ctx["define"], materialized on the
    # server). Read-only; a script value stays as data ({"__m5script": ...}).
    _d = ctx.get("define")
    m5mobile = _NS(define=_DefineNS(_d if isinstance(_d, dict) else {}))
    mob_mod = _types.ModuleType("m5mobile", "The M5cet mobile definitions (6.3).")
    mob_mod.__dict__.update({k: v for k, v in m5mobile.__dict__.items()})
    _sys.modules["m5mobile"] = mob_mod
    _builtins.m5mobile = m5mobile
    _sys.stdout = _Stream("stdout")
    _sys.stderr = _Stream("stderr")

def _write_tree(root, files):
    for path, text in files.items():
        full = _os.path.join(root, path)
        _os.makedirs(_os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(text)

async def _functions_get(keyword):
    k = str(keyword or "").lstrip("/!").lower()
    for f in await _acall("functions.list"):
        if f["keyword"] == k:
            return f
    return None

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
    return _enc({"values": _as_outputs(result), "result": _result_of(result)})

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
