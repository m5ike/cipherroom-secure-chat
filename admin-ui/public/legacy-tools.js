// Tools ported from the previous admin page: the telephony / SIP console
// (the layout builder is layout-builder.js since 4.0.5, AI & speech
// ai-console.js since 4.14). They
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

})();
