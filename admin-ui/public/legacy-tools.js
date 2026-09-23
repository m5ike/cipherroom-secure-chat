// Tools ported from the previous admin page: AI & speech connectors and
// their live log, the telephony / SIP console and the layout builder. They
// talk to the admin service (/admin/*) with the token the console signed in
// with (#base / #token, kept in memory — the old page stored it in local
// storage). Everything a server returns is escaped before it becomes
// markup.
(() => {
  "use strict";

    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    async function api(path, opts = {}) {
      const base = $("base").value.trim().replace(/\/$/, "");
      const token = $("token").value.trim();
      const res = await fetch(base + path, {
        ...opts,
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers || {}),
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { ok: res.ok, status: res.status, json };
    }

    function show(el, data) {
      $(el).textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }

    function connectorRow(c) {
      const badge = c.configured ? '<span class="ok">configured</span>' : '<span class="err">' + esc(c.reason || 'not configured') + '</span>';
      const model = c.model ? ' · <code>' + esc(c.model) + '</code>' : '';
      return '<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:6px 0;">'
        + '<span><b>' + esc(String(c.kind || '').toUpperCase()) + '</b> ' + esc(c.label) + model + ' — ' + badge + '</span>'
        + '<button data-kind="' + esc(c.kind) + '" data-id="' + esc(c.id) + '" class="secondary btnTestConn"' + (c.configured ? '' : ' disabled') + '>Test</button>'
        + '</div>';
    }
    $("btnPlugins").onclick = async () => {
      const r = await api("/admin/plugins");
      if (!r.ok) return show("pluginOut", r.json);
      const s = r.json;
      const all = [].concat(s.ai || [], s.tts || [], s.stt || []);
      $("connectorList").innerHTML =
        '<p class="muted small">AI: ' + (s.enabled.ai ? 'ENABLED' : 'disabled') + ' · Speech: ' + (s.enabled.speech ? 'ENABLED' : 'disabled') + '</p>'
        + all.map(connectorRow).join("");
      document.querySelectorAll(".btnTestConn").forEach((b) => b.onclick = () => testConnector(b.dataset.kind, b.dataset.id));
      show("pluginOut", { defaults: s.defaults, enabled: s.enabled });
    };
    async function testConnector(kind, id) {
      show("pluginOut", "Testing " + kind + "/" + id + "…");
      const r = await api("/admin/plugins/test", { method: "POST", body: JSON.stringify({ kind, id, text: $("pluginTestText").value.trim() || undefined }) });
      if (r.ok && kind === "tts" && r.json.result && r.json.result.audioBase64) {
        const p = $("ttsPlayer");
        p.src = "data:" + (r.json.result.mime || "audio/mpeg") + ";base64," + r.json.result.audioBase64;
        p.style.display = "block";
        const clone = Object.assign({}, r.json.result); delete clone.audioBase64; r.json.result = Object.assign(clone, { audioBase64: "[" + r.json.result.audioBase64.length + " b64 chars]" });
      }
      show("pluginOut", r.json);
    }

    let liveCtrl = null;
    $("btnLiveLog").onclick = async () => {
      if (liveCtrl) liveCtrl.abort();
      liveCtrl = new AbortController();
      const base = $("base").value.trim().replace(/\/$/, "");
      const token = $("token").value.trim();
      try {
        const res = await fetch(base + "/admin/logs/stream", { headers: token ? { Authorization: "Bearer " + token } : {}, signal: liveCtrl.signal });
        if (!res.ok || !res.body) { $("liveLog").textContent = "stream failed (" + res.status + ")"; return; }
        $("liveLog").textContent = "";
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const e = JSON.parse(line.slice(5).trim());
              const t = new Date(e.ts).toLocaleTimeString();
              $("liveLog").textContent += t + "  [" + e.level + "] " + e.kind + (e.connector ? "/" + e.connector : "") + "  " + e.message + (e.ms != null ? " (" + e.ms + "ms)" : "") + "\n";
              $("liveLog").scrollTop = $("liveLog").scrollHeight;
            } catch {}
          }
        }
      } catch (e) { if (e.name !== "AbortError") $("liveLog").textContent += "\n[stream error] " + e.message; }
    };
    $("btnLiveStop").onclick = () => { if (liveCtrl) { liveCtrl.abort(); liveCtrl = null; } };
    $("btnLiveClear").onclick = () => { $("liveLog").textContent = ""; };

    // ---- Telephony & SIP console ----
    $("btnTel").onclick = async () => {
      const r = await api("/admin/telephony");
      if (!r.ok) return show("telList", r.json);
      const s = r.json;
      // This page is read from disk, the API from dist/admin.cjs — after an
      // update they can disagree. Refuse to render misleading values then.
      if (s.apiVersion !== 2) {
        $("telList").innerHTML = '<p class="err" style="font-size:13px;"><b>Admin backend is older than this page.</b> The running <code>dist/admin.cjs</code> predates the telephony persistence / webhook release (missing <code>apiVersion</code>, <code>persistence</code>, <code>defaultsSource</code>). Rebuild and restart the admin service:<br>'
          + '• native: <code>npm run build</code> then restart the admin unit/process (or run <code>./update.sh</code>)<br>'
          + '• docker: <code>docker compose --profile admin up -d --build</code> (the new compose also mounts the <code>m5cet-data</code> volume for persistence)</p>';
        $("whList").innerHTML = ""; return;
      }
      const src = (k) => (s.defaultsSource && s.defaultsSource[k]) || '—';
      const conn = (c) => '<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:5px 0;"><span><b>' + esc((c.kind || '').toUpperCase()) + '</b> ' + esc(c.label) + (c.configured ? ' — <span class="ok">configured</span>' + (c.note ? ' <span style="">(' + esc(c.note) + ')</span>' : '') : ' — <span class="err">' + esc(c.reason || 'not configured') + '</span>') + '</span></div>';
      const trunk = (tk) => '<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:5px 0;"><span>☎ <b>' + esc(tk.id) + '</b> ' + esc(tk.label || '') + ' · ' + esc(tk.host || '?') + ':' + esc(tk.port || 5060) + ' · DIDs: ' + esc((tk.didNumbers || []).join(', ') || '—') + (tk.hasPassword ? ' · 🔒' : '') + (tk.source === 'env' ? ' · <span class="ok">from .env (read-only)</span>' : '') + '</span></div>';
      const p = s.persistence || {};
      const persist = p.writable
        ? '<span class="ok">persistent</span> → <code>' + esc(p.file) + '</code>' + (p.lastSaveError ? ' <span class="err">' + esc(p.lastSaveError) + '</span>' : '')
        : '<span class="err">NOT writable</span> (' + esc(p.reason || 'mount a volume / set DATA_DIR') + ') — trunks saved in memory only';
      const envT = s.envTrunks || { loaded: 0, errors: [] };
      $("telList").innerHTML =
        '<p class="small">Telephony: ' + (s.enabled ? 'ENABLED' : 'disabled')
        + ' · SMS default: <b>' + esc(s.defaults && s.defaults.sms || '—') + '</b> (' + esc(src('sms')) + ')'
        + ' · Voice default: <b>' + esc(s.defaults && s.defaults.voice || '—') + '</b> (' + esc(src('voice')) + ')'
        + ' · PUBLIC_BASE_URL: ' + (s.publicBaseUrl ? '<code>' + esc(s.publicBaseUrl) + '</code>' : '<span class="err">not set</span> — add <code>PUBLIC_BASE_URL=https://your.domain</code> to <code>.env</code> and restart (needed for webhooks + Twilio signature check)') + '</p>'
        + '<p class="small">Storage: ' + persist + '</p>'
        + [].concat(s.sms || [], s.voice || []).map(conn).join('')
        + '<h2 style="margin-top:10px;">Configured trunks</h2>'
        + ((s.sip && s.sip.length ? s.sip.map(trunk).join('') : '<p class="small">no trunks</p>'))
        + (envT.errors && envT.errors.length ? '<p class="err" class="small">SIP_TRUNKS errors: ' + esc(envT.errors.join('; ')) + '</p>' : '');
      $("defSms").value = (s.settings && s.settings.smsProvider) || '';
      $("defVoice").value = (s.settings && s.settings.voiceProvider) || '';
      renderWebhooks(s.webhooks || [], s.publicBaseUrl);
    };
    $("btnTelDefaults").onclick = async () => {
      const r = await api("/admin/telephony/settings", { method: "PUT", body: JSON.stringify({ smsProvider: $("defSms").value, voiceProvider: $("defVoice").value }) });
      show("telDefaultsOut", r.json);
      $("btnTel").click();
    };
    function renderWebhooks(list, baseUrl) {
      $("whList").innerHTML = list.map((p) => {
        const v = p.verification || {};
        const rows = (p.specs || []).map((w) => '<div style="font-size:12px;padding:2px 0;"><code>' + esc(w.method) + ' ' + esc(w.url || w.path) + '</code> — ' + esc(w.description) + '</div>').join('');
        return '<div style="border-bottom:1px solid var(--border);padding:8px 0;">'
          + '<div class="row" style="justify-content:space-between;"><span><b>' + esc(p.provider) + '</b> · verification: ' + (v.configured ? '<span class="ok">' + esc(v.verify) + ' (enforced)</span>' : '<span class="err">not verified — set ' + esc(v.needs) + '</span>') + '</span>'
          + '<button class="secondary btnWhInstall" data-provider="' + esc(p.provider) + '"' + (baseUrl ? '' : ' disabled title="set PUBLIC_BASE_URL"') + '>Install in ' + esc(p.provider) + '</button></div>'
          + rows + '</div>';
      }).join('');
      document.querySelectorAll(".btnWhInstall").forEach((b) => b.onclick = async () => {
        show("whOut", "Installing webhooks in " + b.dataset.provider + "…");
        const r = await api("/admin/telephony/webhooks/install", { method: "POST", body: JSON.stringify({ provider: b.dataset.provider }) });
        show("whOut", r.json);
      });
    }
    $("btnTelEvents").onclick = async () => {
      const r = await api("/admin/telephony/events?limit=100");
      if (!r.ok) return show("telEvents", r.json);
      $("telEvents").textContent = (r.json.events || []).slice().reverse().map((e) =>
        new Date(e.ts).toLocaleTimeString() + '  ' + e.provider + '/' + e.type + '  [' + e.direction + ']  ' + e.summary
        + (e.status ? '  status=' + e.status : '') + (e.route ? '  → trunk ' + e.route.trunkId : '') + (e.verified ? '' : '  (UNVERIFIED)')
      ).join('\n') || '(no events yet)';
    };
    $("btnTelEventsClear").onclick = async () => { await api("/admin/telephony/events", { method: "DELETE" }); $("btnTelEvents").click(); };
    $("btnTelTest").onclick = async () => {
      const kind = $("telKind").value;
      const body = { kind, to: $("telTo").value.trim(), text: $("telText").value.trim() || undefined };
      show("telOut", "Testing " + kind + "…");
      const r = await api("/admin/telephony/test", { method: "POST", body: JSON.stringify(body) });
      show("telOut", r.json);
    };
    $("btnSipSave").onclick = async () => {
      const body = {
        id: $("sipId").value.trim(), label: $("sipLabel").value.trim(),
        host: $("sipHost").value.trim(), port: Number($("sipPort").value.trim()) || 5060,
        username: $("sipUser").value.trim(), password: $("sipPass").value,
        didNumbers: $("sipDids").value.split(",").map(s => s.trim()).filter(Boolean),
        callerIdName: $("sipCidName").value.trim(), callerIdNumber: $("sipCidNum").value.trim(),
      };
      const r = await api("/admin/telephony/sip/trunks", { method: "PUT", body: JSON.stringify(body) });
      show("sipOut", r.json);
      $("btnTel").click();
    };
    $("btnSipDelete").onclick = async () => {
      const id = $("sipId").value.trim();
      if (!id) return show("sipOut", "Enter trunk id to delete.");
      const r = await api("/admin/telephony/sip/trunks", { method: "DELETE", body: JSON.stringify({ id }) });
      show("sipOut", r.json);
      $("btnTel").click();
    };
    $("btnSipRoute").onclick = async () => {
      const r = await api("/admin/telephony/sip/route", { method: "POST", body: JSON.stringify({ did: $("sipDid").value.trim() }) });
      show("sipOut", r.json);
    };

    // ---- Layout / template builder ----
    // Mirrors client/src/lib/layout-config.ts (renderTemplate + css var mapping);
    // the server re-validates everything on save.
    const LB_COMPS = ["chat", "in", "sys", "out", "widget", "menu", "composer"];
    const LB_TPL = {
      systemHeader: ["appName", "date", "time", "room"], incomingMeta: ["sender", "time", "date", "room"], outgoingMeta: ["sender", "time", "date", "room"],
      composerPlaceholder: ["placeholder", "room", "peerCount"], widgetTitle: ["title", "peerCount", "room"], chatEmptyTitle: ["title", "appName"], chatEmptyBody: ["body", "appName"],
    };
    const LB_DEFAULT_TPL = { systemHeader: "{{appName}} · {{date}}", incomingMeta: "{{time}}", outgoingMeta: "{{time}}", composerPlaceholder: "{{placeholder}}", widgetTitle: "{{title}}", chatEmptyTitle: "{{title}}", chatEmptyBody: "{{body}}" };
    let lb = { version: 1, styles: {}, templates: { ...LB_DEFAULT_TPL }, partials: {}, flags: { showAvatars: true, showTime: true, showLockIcon: true, showActions: true, showSystemLogo: true, systemFullDate: true, systemCollapseAfterSec: 60, systemExpandForSec: 20 } };
    function lbRender(tpl, vars, partials, depth) {
      depth = depth || 0;
      let out = String(tpl || "").replace(/\{\{>\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, n) => (depth >= 3 || !partials[n]) ? "" : lbRender(partials[n], vars, partials, depth + 1));
      return out.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, n) => (n in vars ? String(vars[n]) : ""));
    }
    function lbPreview() {
      const pv = $("lbPreview");
      LB_COMPS.forEach((c) => ["bg", "fg", "border", "bstyle", "bwidth", "radius", "fs", "opacity", "pad", "shadow"].forEach((p) => pv.style.removeProperty("--c-" + c + "-" + p)));
      for (const c of LB_COMPS) {
        const s = lb.styles[c] || {};
        for (const p of Object.keys(s)) {
          const v = s[p]; let css = String(v);
          if (["bwidth", "radius", "fs", "pad"].includes(p)) css = v + "px";
          if (p === "shadow") css = v ? "0 1px 2px rgba(0,0,0,.3)" : "none";
          pv.style.setProperty("--c-" + c + "-" + p, css);
        }
      }
      const now = new Date();
      const vars = { appName: "M5cet", sender: "Alice", time: now.toLocaleTimeString(), date: now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) + ", " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), room: "brno-secure", peerCount: "2", placeholder: "Napiš šifrovanou zprávu…", title: "Příjemci", body: "Žádná historie, žádné ukládání." };
      const t = lb.templates, p = lb.partials;
      $("pvSysHead").textContent = lbRender(t.systemHeader, { ...vars, date: lb.flags.systemFullDate ? vars.date : vars.time }, p);
      document.querySelector("#lbPreview .lb-logo").style.display = lb.flags.showSystemLogo ? "inline-block" : "none";
      $("pvInMeta").textContent = lb.flags.showTime ? lbRender(t.incomingMeta, vars, p) : "";
      $("pvOutMeta").textContent = lb.flags.showTime ? lbRender(t.outgoingMeta, vars, p) : "";
      $("pvWidget").textContent = lbRender(t.widgetTitle, vars, p);
      $("pvComposer").textContent = lbRender(t.composerPlaceholder, vars, p);
      document.querySelector("#lbPreview .lb-av").style.display = lb.flags.showAvatars ? "inline-flex" : "none";
    }
    function lbFillStyleForm() {
      const s = lb.styles[$("lbComp").value] || {};
      const col = (id, key) => { $(id + "On").checked = !!s[key]; $(id).value = s[key] || "#3358d4"; };
      col("lbBg", "bg"); col("lbFg", "fg"); col("lbBorder", "border");
      $("lbBstyle").value = s.bstyle || ""; $("lbBwidth").value = s.bwidth ?? ""; $("lbRadius").value = s.radius ?? ""; $("lbFs").value = s.fs ?? "";
      $("lbOpacity").value = s.opacity ?? ""; $("lbPad").value = s.pad ?? ""; $("lbShadow").value = s.shadow === undefined ? "" : String(s.shadow);
    }
    function lbReadStyleForm() {
      const c = $("lbComp").value; const s = {};
      if ($("lbBgOn").checked) s.bg = $("lbBg").value; if ($("lbFgOn").checked) s.fg = $("lbFg").value; if ($("lbBorderOn").checked) s.border = $("lbBorder").value;
      if ($("lbBstyle").value) s.bstyle = $("lbBstyle").value;
      const n = (id) => ($(id).value === "" ? undefined : Number($(id).value));
      if (n("lbBwidth") !== undefined) s.bwidth = n("lbBwidth"); if (n("lbRadius") !== undefined) s.radius = n("lbRadius"); if (n("lbFs") !== undefined) s.fs = n("lbFs");
      if (n("lbOpacity") !== undefined) s.opacity = n("lbOpacity"); if (n("lbPad") !== undefined) s.pad = n("lbPad");
      if ($("lbShadow").value) s.shadow = $("lbShadow").value === "true";
      if (Object.keys(s).length) lb.styles[c] = s; else delete lb.styles[c];
      lbPreview();
    }
    function lbFillTemplates() {
      $("lbTemplates").innerHTML = Object.keys(LB_TPL).map((k) => '<div class="lb-tpl"><span>' + k + '<br>' + LB_TPL[k].map((v) => '<span class="lb-chip" data-ins="{{' + v + '}}" data-for="' + k + '">{{' + v + '}}</span>').join("") + '</span><input data-tpl="' + k + '" value="' + esc(lb.templates[k] || "") + '" /></div>').join("");
      document.querySelectorAll("[data-tpl]").forEach((i) => i.oninput = () => { lb.templates[i.dataset.tpl] = i.value; lbPreview(); });
      document.querySelectorAll(".lb-chip").forEach((ch) => ch.onclick = () => { const i = document.querySelector('[data-tpl="' + ch.dataset.for + '"]'); i.value += ch.dataset.ins; lb.templates[ch.dataset.for] = i.value; lbPreview(); });
    }
    function lbFillPartials() {
      const names = Object.keys(lb.partials);
      $("lbPartials").innerHTML = names.length ? names.map((n) => '<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:3px 0;"><span><code>{{&gt; ' + esc(n) + '}}</code> = ' + esc(lb.partials[n]) + '</span><button class="secondary" data-del="' + esc(n) + '">remove</button></div>').join("") : '<span style="">no partials</span>';
      document.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { delete lb.partials[b.dataset.del]; lbFillPartials(); lbPreview(); });
    }
    function lbFillFlags() {
      const f = lb.flags; $("lfAvatars").checked = f.showAvatars; $("lfTime").checked = f.showTime; $("lfLock").checked = f.showLockIcon; $("lfActions").checked = f.showActions;
      $("lfSysLogo").checked = f.showSystemLogo; $("lfSysDate").checked = f.systemFullDate; $("lfCollapse").value = f.systemCollapseAfterSec; $("lfExpand").value = f.systemExpandForSec;
    }
    function lbReadFlags() {
      lb.flags = { showAvatars: $("lfAvatars").checked, showTime: $("lfTime").checked, showLockIcon: $("lfLock").checked, showActions: $("lfActions").checked, showSystemLogo: $("lfSysLogo").checked, systemFullDate: $("lfSysDate").checked, systemCollapseAfterSec: Number($("lfCollapse").value) || 0, systemExpandForSec: Number($("lfExpand").value) || 20 };
      lbPreview();
    }
    function lbFillAll() { lbFillStyleForm(); lbFillTemplates(); lbFillPartials(); lbFillFlags(); lbPreview(); }
    $("lbLoad").onclick = async () => { const r = await api("/admin/layout"); if (r.status === 404) return show("lbOut", "The running admin backend has no /admin/layout — it predates the layout builder. Rebuild (npm run build) and restart the admin service, or `docker compose --profile admin up -d --build`."); if (!r.ok) return show("lbOut", r.json); lb = r.json.layout; lbFillAll(); show("lbOut", { file: r.json.file, updatedAt: lb.updatedAt ? new Date(lb.updatedAt).toLocaleString() : "(defaults)", lastSaveError: r.json.lastSaveError || null }); };
    $("lbSave").onclick = async () => { const r = await api("/admin/layout", { method: "PUT", body: JSON.stringify({ layout: lb }) }); show("lbOut", r.ok ? { saved: true, updatedAt: new Date(r.json.layout.updatedAt).toLocaleString() } : r.json); if (r.ok) { lb = r.json.layout; lbFillAll(); } };
    $("lbReset").onclick = async () => { if (!confirm("Reset layout to defaults for all clients?")) return; const r = await api("/admin/layout/reset", { method: "POST" }); if (r.ok) { lb = r.json.layout; lbFillAll(); } show("lbOut", r.json); };
    $("lbExport").onclick = () => { const a = document.createElement("a"); a.href = "data:application/json," + encodeURIComponent(JSON.stringify(lb, null, 2)); a.download = "m5cet-layout.json"; a.click(); };
    $("lbImport").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); lb = j.layout || j; lbFillAll(); show("lbOut", "Imported — press Save to apply."); } catch (err) { show("lbOut", "Invalid JSON: " + err.message); } e.target.value = ""; };
    $("lbComp").onchange = lbFillStyleForm;
    $("lbClearComp").onclick = () => { delete lb.styles[$("lbComp").value]; lbFillStyleForm(); lbPreview(); };
    ["lbBg", "lbBgOn", "lbFg", "lbFgOn", "lbBorder", "lbBorderOn", "lbBstyle", "lbBwidth", "lbRadius", "lbFs", "lbOpacity", "lbPad", "lbShadow"].forEach((id) => { $(id).oninput = lbReadStyleForm; $(id).onchange = lbReadStyleForm; });
    ["lfAvatars", "lfTime", "lfLock", "lfActions", "lfSysLogo", "lfSysDate", "lfCollapse", "lfExpand"].forEach((id) => { $(id).onchange = lbReadFlags; });
    $("lbPartAdd").onclick = () => { const n = $("lbPartName").value.trim(); if (!/^[a-zA-Z0-9_-]{1,32}$/.test(n)) return show("lbOut", "partial name: a-z, 0-9, _ or -"); lb.partials[n] = $("lbPartBody").value; $("lbPartName").value = ""; $("lbPartBody").value = ""; lbFillPartials(); lbPreview(); };
    lbFillAll();
})();
