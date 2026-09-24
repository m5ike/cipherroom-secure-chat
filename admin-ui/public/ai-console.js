// M5cet operator console — AI & speech (4.14).
//
//   Providers   Claude, OpenAI, Open WebUI, Perplexity, Ollama, llama.cpp,
//               GPT4All, Hugging Face, any OpenAI-compatible server,
//               ElevenLabs: address, key (sealed on the server, never shown
//               again), who may use it, its models (fetched from the
//               provider or added by name) with what they can do and prices
//   Playground  a conversation with any model, streamed: reasoning, sources,
//               tokens, cost, time and the request as it went out
//   Speech      synthesis with a voice, transcription of a recording or file
//   Calls       every call (app, playground, tests) — live, filtered, CSV,
//               sums per model, day and user
//   Settings    default models, the assistant's guidance, limits (the owner:
//               0 tokens a month = AI off), the journal and content logging
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  const Kit = window.M5Kit;
  if (!C || !Kit) return;
  const { h, clear, api, toast, can } = C;

  let data = null;
  let tab = "providers";
  const open = new Set();
  const drafts = new Map();
  const root = () => document.getElementById("aiRoot");

  /* ============================================================== formats */

  const nf = new Intl.NumberFormat();
  const num = (n) => (n === null || n === undefined ? "—" : nf.format(Math.round(n)));
  const usd = (n) => (n === null || n === undefined ? "—" : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(n < 1 ? 4 : 2)}`);
  const ms = (n) => (!n ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
  const pad = (n) => String(n).padStart(2, "0");
  const when = (t) => { if (!t) return "—"; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const badge = (text, tone) => h("span", { class: `badge${tone ? ` badge--${tone}` : ""}` }, text);
  const typeOf = (type) => (data?.types || []).find((t) => t.type === type) || { label: type, kinds: ["chat"], key: "optional", baseUrl: "" };
  const KIND_LABEL = { chat: "chat", tts: "speech", stt: "transcription", embed: "embeddings" };

  function statusBadge(status) {
    return badge(status, status === "ok" ? "ok" : status === "error" ? "err" : status === "refused" ? "warn" : "");
  }

  /** Every model of a kind, as "provider/model" with a label (the console may use switched-off ones). */
  function modelChoices(kind, onlyEnabled) {
    const out = [];
    for (const p of data?.providers || []) {
      for (const m of p.models) {
        if (m.kind !== kind || (onlyEnabled && (!m.enabled || !p.enabled))) continue;
        out.push({ ref: `${p.id}/${m.id}`, label: `${p.label} · ${m.label || m.id}${m.enabled && p.enabled ? "" : " (off)"}`, model: m, provider: p });
      }
    }
    return out;
  }

  function select(options, value, attrs = {}) {
    const el = h("select", { class: "input", ...attrs });
    for (const o of options) el.append(h("option", { value: o.value, selected: o.value === value || undefined }, o.label));
    return el;
  }

  /* ============================================================== loading */

  async function load() {
    try {
      data = await api("/admin/ai");
      render();
    } catch (err) {
      toast(`AI & speech: ${err.message}`, "err");
    }
  }
  function apply(next, message) {
    data = next;
    render();
    if (message) toast(message, "ok");
  }
  async function act(fn, message) {
    try { apply(await fn(), message); } catch (err) { toast(err.message, "err"); }
  }

  C.addRoute("plugins", ["AI & speech", "Providers, keys and models, the playground, speech, every call, limits", load]);

  /* ============================================================== page */

  function render() {
    const box = root();
    if (!box || !data) return;
    stopLive();
    clear(box);
    box.append(header(), tabs(), h("div", { id: "aiTab" }));
    renderTab();
    C.applyRoleGates(box);
  }

  function header() {
    const m = data.usage.month;
    const l = data.limits;
    const cap = l.monthlyTokens;
    const share = cap ? Math.min(1, m.tokens / cap) : 0;
    const sw = (key, label) => {
      const st = data.switches[key];
      const input = h("input", { type: "checkbox", checked: st.enabled || undefined, disabled: st.source === "env" || !can("operator") || undefined, "data-testid": `ai-switch-${key}` });
      input.addEventListener("change", () => act(() => api("/admin/ai/switches", { method: "PUT", body: { [key]: input.checked } }), `${label} ${input.checked ? "on" : "off"}`));
      return h("label", { class: "switch", title: st.source === "env" ? `Fixed by ${st.env} in the server's environment` : "" }, input, `${label}${st.source === "env" ? ` (${st.env})` : ""}`);
    };
    const warn = [];
    if (cap === 0) warn.push(h("div", { class: "ai-note ai-note--warn", "data-testid": "ai-no-limit" }, "The app's AI is off until the owner sets a monthly limit (Settings › Limits). The console's playground and tests work regardless."));
    if (!data.store.credentials.ok) warn.push(h("div", { class: "ai-note ai-note--err" }, `Keys cannot be stored: ${data.store.credentials.reason}`));
    if (!data.journal.store.persistent) warn.push(h("div", { class: "ai-note ai-note--warn" }, data.journal.store.reason || "The journal is kept in memory only."));
    if (data.journal.content.active) warn.push(h("div", { class: "ai-note ai-note--warn" }, `Content logging is on (what users say is kept) until ${when(data.journal.content.until)} — by ${data.journal.content.by}.`));
    return h("div", { class: "card ai-head" },
      h("div", { class: "row ai-head__switches" }, sw("ai", "AI"), sw("speech", "Speech")),
      h("div", { class: "grid grid--kpi" },
        kpi("Tokens this month", num(m.tokens), cap === null ? "no limit" : cap === 0 ? "limit 0 — app AI off" : `of ${num(cap)}`, cap && share >= 0.9 ? "warn" : ""),
        kpi("Cost this month", usd(m.usd), l.monthlyUsd === null ? "priced models only" : `of ${usd(l.monthlyUsd)}`),
        kpi("Calls this month", num(m.requests), `${num(data.usage.today.requests)} today`),
        kpi("Providers", String(data.providers.length), `${data.providers.filter((p) => p.enabled).length} on`)),
      cap ? h("div", { class: "bar__track ai-head__bar" }, h("div", { class: `bar__fill${share >= 0.9 ? " bar__fill--err" : ""}`, style: `width:${(share * 100).toFixed(1)}%` })) : null,
      ...warn);
  }

  function kpi(label, value, sub, tone) {
    return h("div", { class: `kpi${tone ? ` is-${tone}` : ""}` }, h("div", { class: "kpi__label" }, label), h("div", { class: "kpi__value" }, value), sub ? h("div", { class: "kpi__sub" }, sub) : null);
  }

  function tabs() {
    const bar = h("div", { class: "seg ai-tabs", role: "tablist" });
    for (const [id, label] of [["providers", "Providers & models"], ["playground", "Playground"], ["speech", "Speech"], ["calls", "Calls"], ["settings", "Settings & limits"]]) {
      bar.append(h("button", { type: "button", role: "tab", "aria-pressed": tab === id ? "true" : "false", "data-read": "1", "data-ai-tab": id, onclick: () => { tab = id; render(); } }, label));
    }
    return bar;
  }

  function renderTab() {
    const box = document.getElementById("aiTab");
    if (!box) return;
    clear(box);
    if (tab === "providers") box.append(providersTab());
    else if (tab === "playground") box.append(playgroundTab());
    else if (tab === "speech") box.append(speechTab());
    else if (tab === "calls") box.append(callsTab());
    else box.append(settingsTab());
  }

  /* ============================================================== providers */

  function providersTab() {
    const box = h("div", { class: "stack" });
    box.append(h("div", { class: "toolbar" },
      can("owner") ? h("button", { type: "button", class: "btn btn--primary", "data-testid": "ai-add-provider", onclick: () => providerDialog() }, "Add a provider") : h("span", { class: "muted small" }, "Adding providers and keys is the owner's."),
      h("span", { class: "muted small" }, `Keys are sealed with the server's storage key in ${data.store.file}; the console never shows them again.`)));
    if (!data.providers.length) box.append(h("div", { class: "card empty" }, "No provider yet. A key in the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY…) shows up here by itself."));
    for (const p of data.providers) box.append(providerCard(p));
    return box;
  }

  function providerCard(p) {
    const t = typeOf(p.type);
    const keyBadge = p.keyState === "ok" ? badge(p.source === "env" ? `key: ${p.envKey}` : `key …${p.keyHint || "set"}`, "ok")
      : p.keyState === "not-needed" ? badge("no key needed")
        : p.keyState === "unreadable" ? badge("key cannot be opened", "err") : badge("no key", "warn");
    const test = p.lastTest ? badge(`${p.lastTest.ok ? "answers" : "failed"} · ${ms(p.lastTest.ms)} · ${when(p.lastTest.at)}`, p.lastTest.ok ? "ok" : "err") : null;
    const enabled = h("input", { type: "checkbox", checked: p.enabled || undefined, disabled: !can("operator") || undefined, "aria-label": `${p.label} on` });
    enabled.addEventListener("change", () => act(() => api(`/admin/ai/providers/${p.id}`, { method: "PUT", body: { enabled: enabled.checked } }), `${p.label} ${enabled.checked ? "on" : "off"}`));
    const models = p.models.length;
    const on = p.models.filter((m) => m.enabled).length;
    const expanded = open.has(p.id);
    return h("div", { class: `card ai-prov${p.enabled ? "" : " is-off"}`, "data-provider": p.id },
      h("div", { class: "ai-prov__head" },
        h("label", { class: "switch" }, enabled),
        h("div", { class: "ai-prov__title" },
          h("strong", {}, p.label), " ", h("span", { class: "muted small" }, t.label), p.source === "env" ? badge("environment", "info") : null,
          h("div", { class: "muted small mono" }, p.effectiveBaseUrl || "—")),
        h("div", { class: "ai-prov__badges" }, keyBadge, test, badge(`${on} of ${models} models on`, on ? "accent" : "")),
        h("div", { class: "ai-prov__actions" },
          h("button", { type: "button", class: "btn btn--sm", "data-testid": `ai-test-${p.id}`, onclick: (e) => testProviderNow(p, e.currentTarget) }, "Test"),
          t.discovery ? h("button", { type: "button", class: "btn btn--sm", "data-testid": `ai-discover-${p.id}`, onclick: (e) => discoverNow(p, e.currentTarget) }, "Fetch models") : null,
          h("button", { type: "button", class: "btn btn--sm", onclick: () => providerDialog(p) }, "Edit"),
          h("button", { type: "button", class: "btn btn--sm", "data-read": "1", "aria-expanded": expanded ? "true" : "false", onclick: () => { if (expanded) open.delete(p.id); else open.add(p.id); render(); } }, expanded ? "Hide models" : "Models"))),
      h("div", { class: "ai-prov__groups muted small" }, "For: ", (p.groups.length ? p.groups : ["nobody"]).map((g) => badge(groupLabel(g))), p.lastTest && !p.lastTest.ok ? h("span", { class: "ai-err" }, ` ${p.lastTest.message}`) : null),
      expanded ? modelsEditor(p) : null);
  }

  const groupLabel = (id) => (data.groups || []).find((g) => g.id === id)?.label || id;

  async function testProviderNow(p, btn) {
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      const r = await api(`/admin/ai/providers/${p.id}/test`, { method: "POST", body: {} });
      apply(r);
      toast(`${p.label}: ${r.test.message}`, r.test.ok ? "ok" : "err");
    } catch (err) { toast(err.message, "err"); btn.disabled = false; btn.textContent = "Test"; }
  }

  async function discoverNow(p, btn) {
    btn.disabled = true;
    btn.textContent = "Fetching…";
    try {
      const r = await api(`/admin/ai/providers/${p.id}/discover`, { method: "POST", body: {} });
      open.add(p.id);
      drafts.delete(p.id);
      apply(r, `${p.label}: ${r.discovered.total} models (${r.discovered.added} new — switched off until you turn them on)`);
    } catch (err) { toast(err.message, "err"); btn.disabled = false; btn.textContent = "Fetch models"; }
  }

  function providerDialog(p) {
    const owner = can("owner");
    const types = data.types;
    const type = select(types.map((t) => ({ value: t.type, label: t.label })), p ? p.type : "anthropic", { disabled: p ? true : undefined, "data-testid": "ai-f-type" });
    const hint = h("p", { class: "muted small" });
    const label = h("input", { class: "input", value: p ? p.label : "", placeholder: "e.g. Claude (company key)", maxlength: "80", "data-testid": "ai-f-label" });
    const base = h("input", { class: "input mono", value: p ? p.baseUrl : "", disabled: (p && p.source === "env") || !owner || undefined, "data-testid": "ai-f-base" });
    const key = h("input", { class: "input mono", type: "password", autocomplete: "off", spellcheck: "false", disabled: (p && p.source === "env") || !owner || undefined, "data-testid": "ai-f-key" });
    const clearKey = h("label", { class: "switch small" }, h("input", { type: "checkbox" }), "Remove the key");
    const model = h("input", { class: "input mono", list: "aiSuggested", placeholder: "e.g. claude-sonnet-5 (more later with “Fetch models”)", "data-testid": "ai-f-model" });
    const suggested = h("datalist", { id: "aiSuggested" });
    const groups = h("div", { class: "chips" });
    const chosen = new Set(p ? p.groups : ["user"]);
    for (const g of data.groups) {
      const cb = h("input", { type: "checkbox", checked: chosen.has(g.id) || undefined, value: g.id });
      cb.addEventListener("change", () => { if (cb.checked) chosen.add(g.id); else chosen.delete(g.id); });
      groups.append(h("label", { class: "chip-check" }, cb, g.label));
    }
    const sync = () => {
      const t = types.find((x) => x.type === type.value);
      hint.textContent = t.hint;
      base.placeholder = t.baseUrl || "https://…/v1";
      key.placeholder = p && p.hasKey ? "unchanged — type a new one to replace it" : t.key === "none" ? "not needed" : t.key === "optional" ? "optional" : "required";
      clear(suggested);
      for (const s of t.suggested || []) suggested.append(h("option", { value: s }));
    };
    type.addEventListener("change", sync);
    sync();
    const out = h("p", { class: "ai-err small" });
    const saveBtn = h("button", { type: "button", class: "btn btn--primary", "data-testid": "ai-f-save" }, p ? "Save" : "Add");
    const dlg = Kit.openDialog({
      title: p ? `Edit ${p.label}` : "Add a provider",
      subtitle: p && p.source === "env" ? "The key and address come from the server's environment" : "The key is sealed on the server and never shown again",
      body: h("div", { class: "stack ai-form" },
        field("Kind", type), hint, field("Name", label),
        field("Address", base, "Empty = the usual one for this kind."),
        field("Key", key, p && p.hasKey ? `A key is set (…${p.keyHint}).` : ""), p && p.hasKey && owner && p.source !== "env" ? clearKey : null,
        p ? null : field("First model", model), suggested,
        field("Who may use it in the app", groups, "Signed-in users by default; add Guests to let people who are not signed in use it."),
        out, h("div", { class: "row" }, saveBtn)),
    });
    saveBtn.addEventListener("click", async () => {
      const body = { label: label.value.trim(), groups: [...chosen] };
      if (owner && !(p && p.source === "env")) {
        if (!p || base.value.trim() !== (p.baseUrl || "")) body.baseUrl = base.value.trim();
        if (key.value.trim()) body.key = key.value.trim();
        else if (p && clearKey.querySelector("input").checked) body.key = null;
      }
      if (!p) { body.type = type.value; if (model.value.trim()) body.model = model.value.trim(); }
      saveBtn.disabled = true;
      try {
        const r = await api(p ? `/admin/ai/providers/${p.id}` : "/admin/ai/providers", { method: p ? "PUT" : "POST", body });
        dlg.close();
        if (!p) { const added = r.providers[r.providers.length - 1]; if (added) open.add(added.id); }
        apply(r, p ? "Saved" : "Provider added — test it, then fetch its models");
      } catch (err) { out.textContent = err.message; saveBtn.disabled = false; }
    });
    if (p && owner && p.source !== "env") {
      dlg.body.append(h("div", { class: "row ai-danger" }, h("button", { type: "button", class: "btn btn--danger btn--sm", onclick: async () => {
        if (!confirm(`Remove ${p.label}? Its key and models go; the journal keeps its calls.`)) return;
        try { apply(await api(`/admin/ai/providers/${p.id}`, { method: "DELETE" }), "Removed"); dlg.close(); } catch (err) { out.textContent = err.message; }
      } }, "Remove this provider")));
    }
  }

  function field(label, control, help) {
    return h("div", { class: "field" }, h("label", {}, label), control, help ? h("div", { class: "muted small" }, help) : null);
  }

  /** The models of a provider: switch on / off, what they can do, prices (owner), add by name. */
  function modelsEditor(p) {
    const list = drafts.get(p.id) || p.models.map((m) => ({ ...m, caps: { ...m.caps }, price: m.price ? { ...m.price } : null }));
    drafts.set(p.id, list);
    const owner = can("owner");
    const dirty = h("span", { class: "badge badge--warn", hidden: true }, "not saved");
    const mark = () => { dirty.hidden = false; };
    const table = h("table", { class: "t ai-models" },
      h("thead", {}, h("tr", {}, ["On", "Model", "Name", "Kind", "Reasoning", "Vision", "In $/M", "Out $/M", "Context"].map((c) => h("th", {}, c)))));
    const tbody = h("tbody");
    const t = typeOf(p.type);
    list.forEach((m) => {
      const on = h("input", { type: "checkbox", checked: m.enabled || undefined, "aria-label": `${m.id} on` });
      on.addEventListener("change", () => { m.enabled = on.checked; mark(); });
      const name = h("input", { class: "input input--sm", value: m.label, placeholder: m.id, maxlength: "80" });
      name.addEventListener("input", () => { m.label = name.value; mark(); });
      const reasoning = select([{ value: "none", label: "none" }, { value: "budget", label: "budget" }, { value: "adaptive", label: "adaptive / effort" }], m.caps.reasoning, { class: "input input--sm" });
      reasoning.addEventListener("change", () => { m.caps.reasoning = reasoning.value; mark(); });
      const vision = h("input", { type: "checkbox", checked: m.caps.vision || undefined });
      vision.addEventListener("change", () => { m.caps.vision = vision.checked; mark(); });
      const price = (k) => {
        const inp = h("input", { class: "input input--sm mono", type: "number", min: "0", step: "0.01", value: m.price ? String(m.price[k]) : "", disabled: !owner || undefined, placeholder: "—", title: owner ? "USD per million tokens (TTS: per million characters)" : "The owner sets prices" });
        inp.addEventListener("input", () => {
          const v = inp.value.trim() === "" ? null : Number(inp.value);
          if (v === null && (!m.price || (k === "in" ? !m.price.out : !m.price.in))) m.price = null;
          else m.price = { in: 0, out: 0, ...(m.price || {}), [k]: v ?? 0 };
          mark();
        });
        return inp;
      };
      tbody.append(h("tr", { class: m.enabled ? "" : "is-off", "data-model": m.id },
        h("td", {}, on), h("td", { class: "mono" }, m.id, m.source === "env" ? " " : null, m.source === "env" ? badge("env") : null),
        h("td", {}, name), h("td", {}, KIND_LABEL[m.kind] || m.kind),
        h("td", {}, m.kind === "chat" ? reasoning : "—"), h("td", {}, m.kind === "chat" ? vision : "—"),
        h("td", {}, price("in")), h("td", {}, m.kind === "chat" ? price("out") : "—"), h("td", { class: "mono" }, m.context ? num(m.context) : "—")));
    });
    if (!list.length) tbody.append(h("tr", {}, h("td", { colspan: "9", class: "muted" }, t.discovery ? "No models yet — “Fetch models”, or add one by name." : "Add models by name.")));
    table.append(tbody);
    const addId = h("input", { class: "input input--sm mono", placeholder: "model name", list: `aiSug-${p.id}`, "data-testid": `ai-add-model-${p.id}` });
    const addKind = select(t.kinds.map((k) => ({ value: k, label: KIND_LABEL[k] || k })), t.kinds[0], { class: "input input--sm" });
    const sug = h("datalist", { id: `aiSug-${p.id}` }, (t.suggested || []).map((s) => h("option", { value: s })));
    const add = () => {
      const id = addId.value.trim();
      if (!id) return;
      if (list.some((m) => m.id === id && m.kind === addKind.value)) { toast("Already there", "err"); return; }
      list.push({ id, label: "", kind: addKind.value, enabled: true, caps: { stream: true, reasoning: p.type === "anthropic" ? "adaptive" : "none", noSampling: false, vision: false, json: false, tools: false }, price: null, source: "manual" });
      render();
    };
    const save = async () => {
      try {
        const r = await api(`/admin/ai/providers/${p.id}/models`, { method: "PUT", body: { models: list } });
        drafts.delete(p.id);
        apply(r, `${p.label}: models saved`);
      } catch (err) { toast(err.message, "err"); }
    };
    return h("div", { class: "ai-prov__models" },
      h("div", { class: "table-wrap" }, table),
      h("div", { class: "toolbar" }, addId, sug, addKind, h("button", { type: "button", class: "btn btn--sm", onclick: add }, "Add model"),
        h("span", { class: "ai-spacer" }), dirty,
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { drafts.delete(p.id); render(); } }, "Discard"),
        h("button", { type: "button", class: "btn btn--primary btn--sm", "data-testid": `ai-save-models-${p.id}`, onclick: save }, "Save models")));
  }

  /* ============================================================== playground */

  const play = { model: "", system: "", reasoning: "off", maxTokens: 1024, temperature: "", json: false, stream: true, messages: [], busy: null };

  function playgroundTab() {
    const choices = modelChoices("chat", false);
    if (!play.model || !choices.some((c) => c.ref === play.model)) play.model = (choices.find((c) => c.ref === data.defaults.chat) || choices.find((c) => c.model.enabled) || choices[0] || {}).ref || "";
    const model = select(choices.map((c) => ({ value: c.ref, label: c.label })), play.model, { "data-testid": "ai-play-model", "data-read": "1" });
    model.addEventListener("change", () => { play.model = model.value; });
    const system = h("textarea", { class: "input", rows: "3", placeholder: "System prompt (optional)", "data-read": "1" }, play.system);
    system.addEventListener("input", () => { play.system = system.value; });
    const reasoning = select(["off", "low", "medium", "high"].map((v) => ({ value: v, label: `reasoning: ${v}` })), play.reasoning, { "data-read": "1" });
    reasoning.addEventListener("change", () => { play.reasoning = reasoning.value; });
    const maxTokens = h("input", { class: "input mono", type: "number", min: "16", max: "200000", value: String(play.maxTokens), "data-read": "1", title: "Most tokens of the answer" });
    maxTokens.addEventListener("input", () => { play.maxTokens = Number(maxTokens.value) || 1024; });
    const temperature = h("input", { class: "input mono", type: "number", min: "0", max: "2", step: "0.1", value: play.temperature, placeholder: "temperature", "data-read": "1", title: "Empty = the model's own; models that refuse it get none" });
    temperature.addEventListener("input", () => { play.temperature = temperature.value; });
    const jsonMode = h("label", { class: "switch small" }, h("input", { type: "checkbox", checked: play.json || undefined, "data-read": "1", onchange: (e) => { play.json = e.target.checked; } }), "JSON");
    const stream = h("label", { class: "switch small" }, h("input", { type: "checkbox", checked: play.stream || undefined, "data-read": "1", onchange: (e) => { play.stream = e.target.checked; } }), "Stream");
    const thread = h("div", { class: "ai-thread", "data-testid": "ai-play-thread" });
    drawThread(thread);
    const input = h("textarea", { class: "input", rows: "3", placeholder: "Your message — Ctrl+Enter sends", "data-testid": "ai-play-input" });
    const sendBtn = h("button", { type: "button", class: "btn btn--primary", "data-testid": "ai-play-send" }, "Send");
    const stopBtn = h("button", { type: "button", class: "btn", hidden: !play.busy || undefined, onclick: () => play.busy?.abort() }, "Stop");
    const send = () => {
      const text = input.value.trim();
      if (!text || play.busy || !play.model) return;
      input.value = "";
      play.messages.push({ role: "user", content: text });
      void runPlayground(thread, sendBtn, stopBtn);
    };
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    return h("div", { class: "grid ai-play" },
      h("div", { class: "card stack" },
        h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Playground"), h("div", { class: "card__hint" }, "Any model, even one switched off for the app. Counted in the journal, not held to the limits.")),
        choices.length ? model : h("p", { class: "muted" }, "No chat model yet — add a provider and fetch its models."),
        system,
        h("div", { class: "toolbar" }, reasoning, maxTokens, temperature, jsonMode, stream,
          h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => { play.messages = []; drawThread(thread); } }, "New conversation"))),
      h("div", { class: "card stack" }, thread, input, h("div", { class: "row" }, sendBtn, stopBtn)));
  }

  function drawThread(thread) {
    clear(thread);
    if (!play.messages.length) { thread.append(h("p", { class: "muted small" }, "Say something to the model.")); return; }
    for (const m of play.messages) thread.append(messageView(m));
    thread.scrollTop = thread.scrollHeight;
  }

  function messageView(m) {
    const el = h("div", { class: `ai-msg ai-msg--${m.role}` },
      h("div", { class: "ai-msg__who" }, m.role === "user" ? "You" : m.ref || "Model"),
      m.reasoning ? h("details", { class: "ai-msg__reasoning" }, h("summary", {}, "Reasoning"), h("pre", {}, m.reasoning)) : null,
      h("div", { class: "ai-msg__text" }, m.content || (m.pending ? "…" : "")),
      m.citations?.length ? h("ol", { class: "ai-msg__sources" }, m.citations.map((c) => h("li", {}, h("a", { href: /^https?:/i.test(c.url) ? c.url : "#", target: "_blank", rel: "noopener noreferrer" }, c.title || c.url)))) : null,
      m.error ? h("div", { class: "ai-err" }, m.error) : null,
      m.stats ? h("div", { class: "ai-msg__stats muted small", "data-testid": "ai-play-stats" }, m.stats) : null,
      m.trace ? h("details", { class: "ai-msg__trace" }, h("summary", {}, `The request (${m.trace.length} ${m.trace.length === 1 ? "try" : "tries"})`), h("pre", { class: "code" }, JSON.stringify(m.trace, null, 2))) : null);
    m.el = el;
    return el;
  }

  async function runPlayground(thread, sendBtn, stopBtn) {
    const answer = { role: "assistant", content: "", reasoning: "", pending: true, ref: play.model };
    // Each earlier question with the answer it got (a failed one leaves both out), then the new question.
    const history = [];
    const all = play.messages;
    for (let i = 0; i < all.length - 1; i++) {
      if (all[i].role === "user" && all[i + 1]?.role === "assistant" && all[i + 1].content && !all[i + 1].error) history.push({ role: "user", content: all[i].content }, { role: "assistant", content: all[i + 1].content });
    }
    history.push({ role: "user", content: all[all.length - 1].content });
    play.messages.push(answer);
    drawThread(thread);
    const controller = new AbortController();
    play.busy = controller;
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    const body = { model: play.model, system: play.system || undefined, messages: history, reasoning: play.reasoning, maxTokens: play.maxTokens, json: play.json, stream: play.stream };
    if (play.temperature !== "") body.temperature = Number(play.temperature);
    const update = () => {
      const old = answer.el;
      const fresh = messageView(answer);
      if (old && old.parentNode) old.replaceWith(fresh);
      thread.scrollTop = thread.scrollHeight;
    };
    const finish = (done) => {
      answer.pending = false;
      if (done) {
        answer.content = done.text ?? answer.content;
        answer.reasoning = done.reasoning || answer.reasoning;
        answer.citations = done.citations || answer.citations;
        answer.trace = done.trace;
        const u = done.usage || {};
        answer.stats = `${done.model} · ${num(u.input)} in + ${num(u.output)} out tokens${u.reasoning ? ` (${num(u.reasoning)} reasoning)` : ""}${u.cachedInput ? ` · ${num(u.cachedInput)} cached` : ""}${u.estimated ? " (estimated)" : ""}${done.cost !== null && done.cost !== undefined ? ` · ${usd(done.cost)}` : ""} · ${ms(done.ms)} · ${done.finish}`;
      }
      update();
    };
    try {
      const res = await C.raw("/admin/ai/playground", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body), signal: controller.signal });
      if (!play.stream || !(res.headers.get("content-type") || "").includes("event-stream")) {
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) { answer.error = j.message || `HTTP ${res.status}`; answer.trace = j.trace; finish(null); }
        else finish(j);
      } else {
        for await (const ev of readSse(res)) {
          if (ev.event === "delta") { answer.content += ev.data.text; update(); }
          else if (ev.event === "reasoning") { answer.reasoning += ev.data.text; update(); }
          else if (ev.event === "citations") { answer.citations = ev.data.citations; update(); }
          else if (ev.event === "done") finish(ev.data);
          else if (ev.event === "error") { answer.error = ev.data.message; answer.trace = ev.data.trace; finish(null); }
        }
      }
    } catch (err) {
      answer.error = err.name === "AbortError" ? "stopped" : err.message;
      finish(null);
    } finally {
      play.busy = null;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
      void refreshHeader();
    }
  }

  /** The numbers at the top after a call (the rest of the page stays as it is). */
  async function refreshHeader() {
    try {
      data = await api("/admin/ai");
      const old = root()?.querySelector(".ai-head");
      if (old) old.replaceWith(header());
    } catch { /* the next load shows them */ }
  }

  /** Server-Sent Events from a fetch() response. */
  async function* readSse(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const lines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!lines.length) continue;
        try { yield { event, data: JSON.parse(lines.join("\n")) }; } catch { /* a comment or a ping */ }
      }
    }
  }

  /* ============================================================== speech */

  function speechTab() {
    const tts = modelChoices("tts", false);
    const sttModels = modelChoices("stt", false);
    const box = h("div", { class: "grid grid--2" });

    // Synthesis
    const tModel = select(tts.map((c) => ({ value: c.ref, label: c.label })), data.defaults.tts || tts[0]?.ref || "", { "data-read": "1", "data-testid": "ai-tts-model" });
    const voice = h("input", { class: "input", list: "aiVoices", placeholder: "voice (e.g. alloy, nova — or an ElevenLabs voice)", value: data.defaults.voice || "", "data-read": "1" });
    const voices = h("datalist", { id: "aiVoices" });
    const syncVoices = () => { clear(voices); for (const v of tts.find((c) => c.ref === tModel.value)?.model.voices || []) voices.append(h("option", { value: v })); };
    tModel.addEventListener("change", syncVoices);
    syncVoices();
    const text = h("textarea", { class: "input", rows: "3", "data-read": "1" }, "Dobrý den, tady je hlas serveru M5cet.");
    const player = h("audio", { controls: true, hidden: true, class: "ai-audio" });
    const tInfo = h("span", { class: "muted small" });
    const speak = h("button", { type: "button", class: "btn btn--primary", "data-testid": "ai-tts-speak" }, "Speak");
    speak.addEventListener("click", async () => {
      speak.disabled = true;
      tInfo.textContent = "…";
      try {
        const r = await api("/admin/ai/speech/tts", { method: "POST", body: { model: tModel.value, voice: voice.value.trim() || undefined, text: text.value } });
        player.src = `data:${r.mime};base64,${r.audioBase64}`;
        player.hidden = false;
        void player.play().catch(() => undefined);
        tInfo.textContent = `${r.ref} · ${ms(r.ms)}`;
      } catch (err) { tInfo.textContent = err.message; }
      speak.disabled = false;
    });
    box.append(h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Speech synthesis")),
      tts.length ? tModel : h("p", { class: "muted" }, "No speech model yet (OpenAI tts-1, an ElevenLabs model…)."), voice, voices, text, h("div", { class: "row" }, speak, tInfo), player));

    // Transcription
    const sModel = select(sttModels.map((c) => ({ value: c.ref, label: c.label })), data.defaults.stt || sttModels[0]?.ref || "", { "data-read": "1" });
    const lang = h("input", { class: "input", placeholder: "language (cs, en… — empty: detect)", "data-read": "1" });
    const file = h("input", { type: "file", accept: "audio/*", "data-read": "1" });
    const out = h("pre", { class: "code ai-transcript" });
    const sInfo = h("span", { class: "muted small" });
    const transcribe = async (blob) => {
      sInfo.textContent = "…";
      out.textContent = "";
      try {
        const q = `?model=${encodeURIComponent(sModel.value)}${lang.value.trim() ? `&language=${encodeURIComponent(lang.value.trim())}` : ""}`;
        const res = await C.raw(`/admin/ai/speech/stt${q}`, { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.message || `HTTP ${res.status}`);
        out.textContent = j.text || "(nothing heard)";
        sInfo.textContent = `${j.ref} · ${ms(j.ms)}`;
      } catch (err) { sInfo.textContent = err.message; }
    };
    file.addEventListener("change", () => { if (file.files[0]) void transcribe(file.files[0]); });
    let recorder = null;
    const rec = h("button", { type: "button", class: "btn", "data-read": "1" }, "Record");
    rec.addEventListener("click", async () => {
      if (recorder) { recorder.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          rec.textContent = "Record";
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          recorder = null;
          void transcribe(blob);
        };
        recorder.start();
        rec.textContent = "Stop and transcribe";
      } catch (err) { sInfo.textContent = `microphone: ${err.message}`; }
    });
    box.append(h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Transcription")),
      sttModels.length ? sModel : h("p", { class: "muted" }, "No transcription model yet (whisper-1, openai/whisper-large-v3…)."), lang,
      h("div", { class: "row" }, rec, file), sInfo, out));
    return box;
  }

  /* ============================================================== calls */

  const filters = { source: "", status: "", provider: "", q: "" };
  let live = null;

  function stopLive() {
    if (live) { live.abort(); live = null; }
  }

  function callsTab() {
    const box = h("div", { class: "stack" });
    const table = h("table", { class: "t ai-calls", "data-testid": "ai-calls" },
      h("thead", {}, h("tr", {}, ["Time", "From", "Who", "Model", "Status", "Time taken", "Tokens in / out", "Cost"].map((c) => h("th", {}, c)))), h("tbody"));
    const summary = h("div", { class: "grid grid--2 ai-summary" });
    const f = (key, options) => {
      const el = select(options, filters[key], { "data-read": "1" });
      el.addEventListener("change", () => { filters[key] = el.value; void refresh(); });
      return el;
    };
    const q = h("input", { class: "input", type: "search", placeholder: "who, model, error…", value: filters.q, "data-read": "1" });
    q.addEventListener("change", () => { filters.q = q.value.trim(); void refresh(); });
    const liveBox = h("input", { type: "checkbox", "data-read": "1", "data-testid": "ai-calls-live" });
    liveBox.addEventListener("change", () => { if (liveBox.checked) startLive(table); else stopLive(); });
    box.append(h("div", { class: "card stack" },
      h("div", { class: "toolbar" },
        f("source", [{ value: "", label: "from anywhere" }, { value: "app", label: "the app" }, { value: "playground", label: "playground" }, { value: "test", label: "tests" }, { value: "function", label: "functions" }]),
        f("status", [{ value: "", label: "any result" }, { value: "ok", label: "ok" }, { value: "error", label: "errors" }, { value: "refused", label: "refused" }, { value: "cancelled", label: "cancelled" }]),
        f("provider", [{ value: "", label: "any provider" }, ...data.providers.map((p) => ({ value: p.id, label: p.label }))]),
        q, h("label", { class: "switch small" }, liveBox, "Live"),
        h("span", { class: "ai-spacer" }),
        h("button", { type: "button", class: "btn btn--sm", "data-read": "1", onclick: () => void exportCsv() }, "Export CSV"),
        can("owner") ? h("button", { type: "button", class: "btn btn--danger btn--sm", onclick: async () => {
          if (!confirm("Delete every call in the journal? Usage for the limits starts again from zero.")) return;
          try { await api("/admin/ai/calls", { method: "DELETE" }); toast("Journal cleared", "ok"); await load(); } catch (err) { toast(err.message, "err"); }
        } }, "Clear journal") : null),
      h("div", { class: "table-wrap" }, table)), summary);
    const refresh = async () => {
      const params = new URLSearchParams({ limit: "200" });
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      try {
        const r = await api(`/admin/ai/calls?${params}`);
        const tb = table.querySelector("tbody");
        clear(tb);
        if (!r.calls.length) tb.append(h("tr", {}, h("td", { colspan: "8", class: "muted" }, "No calls.")));
        for (const c of r.calls) tb.append(callRow(c));
      } catch (err) { toast(err.message, "err"); }
      try { drawSummary(summary, await api("/admin/ai/summary?days=30")); } catch { /* shown above */ }
      void refreshHeader();
    };
    void refresh();
    return box;
  }

  function callRow(c) {
    return h("tr", { class: `ai-call is-${c.status}`, tabindex: "0", "data-call": c.id, onclick: () => void callDetail(c.id), onkeydown: (e) => { if (e.key === "Enter") void callDetail(c.id); } },
      h("td", { class: "mono" }, when(c.ts)), h("td", {}, c.source), h("td", {}, c.actor),
      h("td", { class: "mono" }, `${c.provider}/${c.model}`, c.kind !== "chat" ? ` · ${KIND_LABEL[c.kind] || c.kind}` : ""),
      h("td", {}, statusBadge(c.status), c.error ? h("div", { class: "ai-err small" }, c.error.slice(0, 140)) : null),
      h("td", { class: "mono" }, ms(c.ms), c.ttft ? h("div", { class: "muted small" }, `first ${ms(c.ttft)}`) : null),
      h("td", { class: "mono" }, c.kind === "chat" ? `${num(c.tokensIn)} / ${num(c.tokensOut)}${c.estimated ? " ~" : ""}` : `${num(c.charsIn || c.charsOut)} chars`),
      h("td", { class: "mono" }, usd(c.cost)));
  }

  async function callDetail(id) {
    try {
      const { call } = await api(`/admin/ai/calls/${encodeURIComponent(id)}`);
      const content = call.content ? (() => { try { return JSON.parse(call.content); } catch { return call.content; } })() : null;
      const { content: _c, ...meta } = call;
      Kit.openDialog({
        title: `${call.provider}/${call.model}`,
        subtitle: `${when(call.ts)} · ${call.source} · ${call.actor}`,
        wide: true,
        body: h("div", { class: "stack" },
          h("pre", { class: "code" }, JSON.stringify(meta, null, 2)),
          content ? h("div", {}, h("strong", {}, "What was said (content logging was on)"), h("pre", { class: "code ai-content" }, JSON.stringify(content, null, 2)))
            : h("p", { class: "muted small" }, call.hasContent ? "What was said is kept, and only the owner may read it." : "What was said is not kept (content logging was off).")),
      });
    } catch (err) { toast(err.message, "err"); }
  }

  function drawSummary(box, s) {
    clear(box);
    const tableOf = (title, rows, keyLabel) => h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, title), h("div", { class: "card__hint" }, `last ${s.days} days`)),
      h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "t" },
        h("thead", {}, h("tr", {}, [keyLabel, "Calls", "ok", "Tokens in / out", "Cost", "Avg"].map((c) => h("th", {}, c)))),
        h("tbody", {}, rows.length ? rows.map((r) => h("tr", {}, h("td", { class: "mono" }, r.key || "—"), h("td", {}, num(r.requests)), h("td", {}, num(r.ok)), h("td", { class: "mono" }, `${num(r.tokensIn)} / ${num(r.tokensOut)}`), h("td", { class: "mono" }, r.priced ? usd(r.cost) : "—"), h("td", { class: "mono" }, ms(r.avgMs))))
          : h("tr", {}, h("td", { colspan: "6", class: "muted" }, "Nothing yet."))))));
    const max = Math.max(1, ...s.byDay.map((d) => d.tokensIn + d.tokensOut));
    const days = h("div", { class: "card" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Tokens per day")),
      h("div", { class: "ai-days" }, s.byDay.length ? s.byDay.map((d) => h("div", { class: "ai-day", title: `${d.key}: ${num(d.tokensIn + d.tokensOut)} tokens, ${num(d.requests)} calls${d.priced ? `, ${usd(d.cost)}` : ""}` },
        h("div", { class: "ai-day__bar", style: `height:${Math.max(2, ((d.tokensIn + d.tokensOut) / max) * 100)}%` }), h("div", { class: "ai-day__label" }, d.key.slice(5))))
        : h("p", { class: "muted small" }, "Nothing yet.")));
    box.append(days, tableOf("Per model", s.byModel, "Model"), tableOf("Per user", s.byActor, "Who"), tableOf("Per source", s.bySource, "From"));
  }

  async function startLive(table) {
    stopLive();
    const controller = new AbortController();
    live = controller;
    try {
      const res = await C.raw("/admin/ai/stream", { headers: { Accept: "text/event-stream" }, signal: controller.signal });
      for await (const ev of readSse(res)) {
        if (ev.event !== "call") continue;
        const c = ev.data;
        if ((filters.source && c.source !== filters.source) || (filters.status && c.status !== filters.status) || (filters.provider && c.provider !== filters.provider)) continue;
        const tb = table.querySelector("tbody");
        if (tb.querySelector(`[data-call="${CSS.escape(c.id)}"]`)) continue;
        const empty = tb.querySelector("td[colspan]");
        if (empty) empty.parentNode.remove();
        tb.prepend(callRow(c));
      }
    } catch (err) { if (err.name !== "AbortError") toast(`Live: ${err.message}`, "err"); }
  }

  async function exportCsv() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    try {
      const res = await C.raw(`/admin/ai/calls.csv?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: `m5cet-ai-calls-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { toast(err.message, "err"); }
  }

  /* ============================================================== settings */

  function settingsTab() {
    const owner = can("owner");
    const box = h("div", { class: "grid grid--2" });

    // Defaults and the assistant's guidance (operator)
    const opt = (kind) => [{ value: "", label: "— the first available —" }, ...modelChoices(kind, true).map((c) => ({ value: c.ref, label: c.label }))];
    const chatSel = select(opt("chat"), data.defaults.chat, { "data-testid": "ai-default-chat" });
    const ttsSel = select(opt("tts"), data.defaults.tts);
    const sttSel = select(opt("stt"), data.defaults.stt);
    const voice = h("input", { class: "input", value: data.defaults.voice, placeholder: "the default voice" });
    const system = h("textarea", { class: "input", rows: "5", maxlength: "4000", placeholder: "Guidance given to every conversation of the app's assistant (tone, language, what not to do)…" }, data.assistant.system);
    const saveDefaults = h("button", { type: "button", class: "btn btn--primary", onclick: () => act(() => api("/admin/ai/defaults", { method: "PUT", body: { chat: chatSel.value, tts: ttsSel.value, stt: sttSel.value, voice: voice.value.trim(), system: system.value } }), "Defaults saved") }, "Save defaults");
    box.append(h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Defaults"), h("div", { class: "card__hint" }, "What the app uses unless the user picks another model")),
      field("Chat (the assistant)", chatSel), field("Speech synthesis", ttsSel), field("Voice", voice), field("Transcription", sttSel), field("The assistant's guidance", system), h("div", { class: "row" }, saveDefaults)));

    // Limits (owner)
    const l = data.limits;
    const limit = (value, placeholder) => h("input", { class: "input mono", type: "number", min: "0", value: value === null ? "" : String(value), placeholder, disabled: !owner || undefined });
    const monthly = limit(l.monthlyTokens, "no limit");
    monthly.setAttribute("data-testid", "ai-limit-monthly");
    const usdIn = limit(l.monthlyUsd, "no limit");
    const reqs = limit(l.userDailyRequests, "no limit");
    const toks = limit(l.userDailyTokens, "no limit");
    const maxOut = limit(l.maxOutputTokens, "");
    const maxIn = limit(l.maxInputChars, "");
    const v = (el) => (el.value.trim() === "" ? null : Number(el.value));
    const saveLimits = h("button", { type: "button", class: "btn btn--primary", disabled: !owner || undefined, "data-testid": "ai-save-limits", onclick: () => act(() => api("/admin/ai/limits", { method: "PUT", body: { monthlyTokens: v(monthly), monthlyUsd: v(usdIn), userDailyRequests: v(reqs), userDailyTokens: v(toks), maxOutputTokens: v(maxOut) ?? 2048, maxInputChars: v(maxIn) ?? 24000 } }), "Limits saved") }, "Save limits");
    box.append(h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Limits"), h("div", { class: "card__hint" }, owner ? "The owner's: every call can cost money at a provider" : "Only the owner changes limits")),
      field("Tokens a month (whole server)", monthly, "0 = the app's AI is off (the default until you set a limit); empty = no limit."),
      field("USD a month", usdIn, "Counted where models have prices (Providers › Models)."),
      field("Calls per user and day", reqs), field("Tokens per user and day", toks),
      field("Longest answer (tokens)", maxOut), field("Longest conversation sent (characters)", maxIn),
      h("div", { class: "row" }, saveLimits)));

    // The journal (owner)
    const j = data.journal;
    const days = h("input", { class: "input mono", type: "number", min: "1", max: "3650", value: String(j.retentionDays), disabled: !owner || undefined });
    const hours = h("input", { class: "input mono", type: "number", min: "1", max: "168", value: "24", disabled: !owner || undefined });
    const content = h("input", { type: "checkbox", checked: j.content.active || undefined, disabled: !owner || undefined, "data-testid": "ai-content-logging" });
    const saveJournal = h("button", { type: "button", class: "btn btn--primary", disabled: !owner || undefined, onclick: () => {
      if (content.checked && !j.content.active && !confirm("Keep what users and the assistant say, to debug? It is kept until the logging ends and then removed. Tell your users.")) return;
      void act(() => api("/admin/ai/journal", { method: "PUT", body: { retentionDays: Number(days.value) || 30, content: { on: content.checked, hours: Number(hours.value) || 24 } } }), "Journal settings saved");
    } }, "Save");
    box.append(h("div", { class: "card stack" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Journal"), h("div", { class: "card__hint" }, j.store.persistent ? j.store.file : j.store.reason)),
      field("Keep calls for (days)", days),
      h("label", { class: "switch" }, content, "Content logging — keep what was said (to debug)"),
      field("…for (hours)", hours, j.content.active ? `On until ${when(j.content.until)} (${j.content.by}).` : "Off: only who, which model, how long, tokens, cost and errors are kept."),
      h("div", { class: "row" }, saveJournal)));
    return box;
  }
})();
