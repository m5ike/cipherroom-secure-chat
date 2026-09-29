// 6.0: m5.telephony in the console — what functions do with phones: the
// providers and what each is configured for, the numbers the audio bridge
// lends (with their access attempts), the calls and messages functions
// placed, and the telephony log. Reads GET /api/admin/telephony/sdk (the
// main service, where the providers' webhooks land); a live bridge session
// can be released. Part of the Telephony & SIP page.
(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, api, toast } = C;
  const root = document.getElementById("telSdkRoot");
  if (!root) return;

  const when = (t) => (t ? new Date(t).toLocaleString() : "—");
  const cell = (v) => h("td", {}, v === null || v === undefined || v === "" ? "—" : v);
  const table = (cols, rows) => h("table", { class: "table small" },
    h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", {}, c)))),
    h("tbody", {}, ...(rows.length ? rows : [h("tr", {}, h("td", { colspan: String(cols.length), class: "muted" }, "nothing yet"))])));
  const badge = (text, kind) => h("span", { class: `badge${kind ? ` badge--${kind}` : ""}` }, text);
  const statusKind = (s) => (["completed", "delivered", "connected", "answered", "read"].includes(s) ? "ok" : ["failed", "busy", "no-answer", "canceled", "undelivered", "expired"].includes(s) ? "err" : "");

  async function load() {
    clear(root);
    root.append(h("div", { class: "card__head" }, h("div", { class: "card__title" }, "m5.telephony — what functions do with phones"),
      h("div", { class: "card__actions" }, h("button", { class: "btn btn--sm", "data-read": "1", onclick: load }, "Refresh"))));
    let d;
    try { d = await api("/api/admin/telephony/sdk"); }
    catch (e) { root.append(h("p", { class: "muted small" }, e.message)); return; }
    root.append(h("p", { class: "muted small" },
      "Functions call, text, look numbers up and lend numbers (the phone bridge) through these providers; every call has its own webhooks at ",
      h("code", {}, `${d.publicBaseUrl || "PUBLIC_BASE_URL (not set!)"}/wh/tel/…`), ". Records: ", h("code", {}, d.store.file), d.store.persistent ? "" : ` — ${d.store.reason}`));

    root.append(h("h3", {}, "Providers"), table(["Provider", "Can", "Configured", "Needs"], (d.providers || []).map((p) => h("tr", {},
      cell(p.label), cell(p.capabilities.join(", ")),
      cell(p.configured.length ? p.configured.map((c) => badge(c, "ok")) : badge("none")),
      cell(Object.entries(p.needs || {}).filter(([c]) => !p.configured.includes(c)).map(([c, v]) => `${c}: ${v.join(", ")}`).join(" · ") || "—")))));

    root.append(h("h3", {}, "Phone bridge — lent numbers"),
      h("p", { class: "muted small" }, "Pool (TELEPHONY_DID_POOL): ", (d.pool || []).map((p) => `${p.provider ? `${p.provider}:` : ""}${p.number}`).join(", ") || "empty — functions must name a number or buy one"),
      table(["Number", "Room · member", "Code", "Status", "Channel", "Attempts", "Heard / replies", "Until", ""], (d.bridges || []).map((b) => h("tr", {},
        cell(b.number), cell(`${b.roomHash} · ${b.member.name || b.member.peerId || b.member.accountId}`), cell(h("code", {}, b.code)),
        cell(badge(b.status, statusKind(b.status))), cell(b.channel), cell(b.attempts.map((a) => `${a.ok ? "✓" : "✗"} ${a.from}`).join(", ")),
        cell(`${b.stats.heardSegments} / ${b.stats.spokenReplies}`), cell(when(b.expiresAt)),
        cell(["waiting", "ringing", "verifying", "connected"].includes(b.status) && C.can("operator") ? h("button", { class: "btn btn--xs btn--danger", onclick: async () => {
          try { await api(`/api/admin/telephony/sdk/bridges/${encodeURIComponent(b.id)}/release`, { method: "POST", body: {} }); toast("Released.", "ok"); load(); } catch (e) { toast(e.message, "err"); }
        } }, "Release") : "")))));

    root.append(h("h3", {}, "Calls"), table(["When", "Provider", "From → to", "Mode", "Status", "Duration", "Error"], (d.calls || []).map((c) => h("tr", {},
      cell(when(c.createdAt)), cell(c.provider), cell(`${c.from || "default"} → ${c.to}`), cell(c.mode), cell(badge(c.status, statusKind(c.status))), cell(c.durationSec === null ? "" : `${c.durationSec} s`), cell(c.error)))));

    root.append(h("h3", {}, "Messages"), table(["When", "Channel", "Provider", "To", "Status", "Parts"], (d.messages || []).map((m) => h("tr", {},
      cell(when(m.createdAt)), cell(m.channel), cell(m.provider), cell(m.to), cell(badge(m.status, statusKind(m.status))), cell(m.parts)))));

    root.append(h("h3", {}, "Log"), h("pre", { class: "mono small", style: "max-height:260px;overflow:auto" },
      (d.log || []).map((e) => `${new Date(e.at).toLocaleTimeString()}  ${e.level.padEnd(6)} ${e.kind.padEnd(8)} ${e.provider || "-"}  ${e.summary}`).join("\n") || "(nothing yet)"));
  }

  // Loads when the Telephony page opens.
  const obs = new MutationObserver(() => { const s = root.closest("section"); if (s && !s.hidden && !root.childElementCount) void load(); });
  const section = root.closest("section");
  if (section) obs.observe(section, { attributes: true, attributeFilter: ["hidden"] });
})();
