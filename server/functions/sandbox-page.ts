// /fn-sandbox.html (5.3): where a function's browser JavaScript runs
// (m5.out.js, m5.browser.run). The app frames it with sandbox="allow-scripts"
// and without allow-same-origin, and the page's own CSP says `sandbox
// allow-scripts` too — so even opened on its own it has an opaque origin: no
// cookies, no storage, no access to the app, its keys or its session. Inline
// script and eval are allowed here and only here (the code arrives by
// postMessage from the parent and runs as an async function).
//
// Inside the code: m5.args (what the function passed), m5.root (an element to
// draw in), m5.flash(text, level), m5.send(name, data) → the model's button
// entry point, m5.submit(name, values) → its form entry point, m5.log(…),
// m5.error(e), m5.resize(px?), m5.play(src | bytes, mime?), m5.tone, m5.lang.

import type { Express, Request, Response } from "express";

export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  "font-src data: https:",
  "connect-src https:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

export const SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M5cet · browser code</title>
<style>
:root{color-scheme:light dark}
html,body{margin:0;padding:0;background:transparent;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c2330}
html[data-tone=dark] body{color:#e8ecf2}
#root{padding:2px}
button{font:inherit}
</style></head>
<body><div id="root"></div>
<script>
(function () {
  "use strict";
  var parentWin = window.parent;
  var ran = false;
  function post(msg) { try { msg.m5 = true; parentWin.postMessage(msg, "*"); } catch (e) { /* the app is gone */ } }
  function toText(v) { if (typeof v === "string") return v; try { return JSON.stringify(v); } catch (e) { return String(v); } }
  function bytesUrl(src, mime) {
    if (typeof src === "string") return /^(data:|blob:|https:)/.test(src) ? src : "data:" + (mime || "audio/wav") + ";base64," + src;
    return URL.createObjectURL(new Blob([src], { type: mime || "audio/wav" }));
  }
  var root = document.getElementById("root");
  var m5 = {
    args: null, root: root, tone: "light", lang: "en",
    flash: function (text, level) { post({ kind: "flash", text: toText(text), level: level || "info" }); },
    send: function (name, data) { post({ kind: "send", name: String(name), data: data === undefined ? null : JSON.parse(JSON.stringify(data)) }); },
    submit: function (name, values) { post({ kind: "submit", name: String(name), values: JSON.parse(JSON.stringify(values || {})) }); },
    log: function () { post({ kind: "log", level: "info", message: Array.prototype.map.call(arguments, toText).join(" ") }); },
    warn: function () { post({ kind: "log", level: "warn", message: Array.prototype.map.call(arguments, toText).join(" ") }); },
    error: function (e) { post({ kind: "error", name: (e && e.name) || "Error", message: (e && e.message) || toText(e), stack: e && e.stack ? String(e.stack) : "" }); },
    resize: function (h) { post({ kind: "resize", height: h === undefined ? Math.ceil(document.documentElement.scrollHeight) : Number(h) }); },
    play: function (src, mime) { var a = new Audio(bytesUrl(src, mime)); return a.play(); }
  };
  window.m5 = m5;
  window.addEventListener("error", function (e) { m5.error(e.error || { message: e.message }); });
  window.addEventListener("unhandledrejection", function (e) { m5.error(e.reason); });
  window.addEventListener("message", function (e) {
    if (e.source !== parentWin || ran) return;
    var d = e.data;
    if (!d || d.m5 !== "run" || typeof d.code !== "string") return;
    ran = true;
    m5.args = d.args === undefined ? null : d.args;
    m5.tone = d.tone === "dark" ? "dark" : "light";
    m5.lang = typeof d.lang === "string" ? d.lang : "en";
    document.documentElement.setAttribute("data-tone", m5.tone);
    var fn;
    try { fn = new Function("m5", "args", "\\"use strict\\";\\nreturn (async function () {\\n" + d.code + "\\n})();"); }
    catch (err) { m5.error(err); m5.resize(); return; }
    Promise.resolve().then(function () { return fn(m5, m5.args); }).then(function () { m5.resize(); }, function (err) { m5.error(err); m5.resize(); });
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(function () { m5.resize(); }).observe(document.body);
  post({ kind: "ready" });
})();
</script>
</body></html>`;

export function registerSandboxPage(app: Express): void {
  app.get("/fn-sandbox.html", (_req: Request, res: Response) => {
    res.setHeader("Content-Security-Policy", SANDBOX_CSP);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.removeHeader("X-Frame-Options");
    // An opaque origin cannot be origin-keyed; the header only earns a console warning here.
    res.removeHeader("Origin-Agent-Cluster");
    res.send(SANDBOX_HTML);
  });
}
