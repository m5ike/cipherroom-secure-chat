// /mail — how a domain's e-mail is set up and protected: MX (and who
// provides it), SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI — a score and what
// to fix.
//
// Entry points (1.1): execute; form — the domain asked for when it is
// missing; button — "the records" (the raw TXT records) and "check again";
// response — a reply with another domain; error.
// 1.4 (6.11): the checks run within a budget (netkit MAIL_BUDGET_MS): what the
// DNS did not answer in time is said so ("⏱ no answer in time") — the command
// always finishes.
import { mailInfo, cleanHost, isDomain, mdTable, yes, bar, ask, buttons, sorry } from "pkg:netkit";

const LATE = "⏱ no answer in time";

export async function execute({ domain } = {}) {
  const d = cleanHost(domain || "");
  if (!d) return ask("E-mail analysis", [{ name: "domain", label: "Domain", placeholder: "example.com" }], "Check");
  if (!isDomain(d)) throw new m5.Error("bad-input", `“${d}” is not a domain name`);
  m5.run.progress(0.2, "looking up MX, SPF, DKIM, DMARC…");
  const m = await mailInfo(d);
  const t = m.timeouts || {};
  const md = [`## ✉️ E-mail — ${d}`, `**${bar(m.score)}**${m.provider ? ` · provider: **${m.provider}**` : ""}`];
  md.push("### Receiving (MX)");
  md.push(t.mx ? `_${LATE} (MX)._` : m.nullMx ? "_Null MX (0 .) — the domain accepts no e-mail._" : m.mx.length ? mdTable(["Priority", "Server", "Address"], m.mx.map((x) => [x.priority, x.exchange, ((m.mxHosts.find((h) => h.host === x.exchange) || {}).a || []).join(", ")])) : "_no MX record_");
  md.push("### Authentication");
  md.push(mdTable(["Check", "Result", "Record"], [
    ["SPF", t.spf ? LATE : m.spf.length === 1 ? `✅ ${m.spfAll ? `${m.spfAll}all` : "no all"} · ${m.spfLookups} lookups` : m.spf.length ? "⚠️ several records" : "❌", m.spf.join(" ‖ ").slice(0, 160)],
    ["DKIM", m.dkim.some((k) => !k.revoked) ? `✅ ${m.dkim.filter((k) => !k.revoked).map((k) => k.selector).join(", ")}` : m.dkimWildcard ? (m.dkimWildcard.revoked ? "🚫 wildcard, revoked (p=)" : "⚠️ wildcard") : t.dkim ? LATE : "❓ not found", (m.dkimWildcard ? m.dkimWildcard.key : m.dkim.map((k) => `${k.selector}: ${k.key}…`).join(" ‖ ")).slice(0, 160)],
    ["DMARC", t.dmarc ? LATE : m.dmarc ? `✅ p=${m.dmarcTags.p || "?"}${m.dmarcTags.pct ? ` pct=${m.dmarcTags.pct}` : ""}` : "❌", m.dmarc.slice(0, 160)],
    ["MTA-STS", t.mtaSts ? LATE : yes(m.mtaSts.length) + (m.stsPolicy ? ` ${(/mode:\s*(\w+)/.exec(m.stsPolicy) || [])[1] || ""}` : ""), m.mtaSts.join(" ").slice(0, 120)],
    ["TLS-RPT", t.tlsRpt ? LATE : yes(m.tlsRpt.length), m.tlsRpt.join(" ").slice(0, 120)],
    ["BIMI", t.bimi ? LATE : yes(m.bimi.length), m.bimi.join(" ").slice(0, 120)],
  ]));
  if (m.advice.length) { md.push("### What to improve"); md.push(m.advice.map((a) => `- ${a}`).join("\n")); }
  if (m.late && m.late.length) md.push(`_${LATE}: ${m.late.join(", ")} — the result may be incomplete; **Check again** later._`);
  m5.run.progress(1, "done");
  // The records themselves are one click away (the button entry point); m5.model.cache keeps them for it.
  await m5.model.cache.set("records", { spf: m.spf, dmarc: m.dmarc, mtaSts: m.mtaSts, tlsRpt: m.tlsRpt, bimi: m.bimi, dkim: m.dkim.map((k) => ({ selector: k.selector, key: k.key })) }, { ttl: "1h" });
  return [
    m5.out.markdown(md.join("\n\n")),
    m.late && m.late.length ? m5.out.flash(`${d}: some checks got no answer in time`, "warning") : m.score >= 80 ? m5.out.flash(`${d}: e-mail is well protected (${m.score}/100)`, "success") : m.score < 40 ? m5.out.flash(`${d}: e-mail protection is weak (${m.score}/100)`, "warning") : null,
    buttons([{ name: "records", title: "The records", icon: "📜", data: { domain: d } }, { name: "again", title: "Check again", icon: "↻", data: { domain: d } }]),
  ].filter(Boolean);
}

export async function button({ name, data } = {}) {
  if (name === "records") {
    const r = await m5.model.cache.get("records");
    if (!r) return execute({ domain: data && data.domain });
    const rows = [["SPF", r.spf.join(" ‖ ")], ["DMARC", r.dmarc], ["MTA-STS", r.mtaSts.join(" ")], ["TLS-RPT", r.tlsRpt.join(" ")], ["BIMI", r.bimi.join(" ")], ...r.dkim.map((k) => [`DKIM ${k.selector}`, k.key])].filter((x) => x[1]);
    return m5.out.code(rows.map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n") || "(no records)", "text");
  }
  return execute({ domain: data && data.domain });
}

export async function form({ values } = {}) { return execute(values || {}); }

export async function response({ text } = {}) { return execute({ domain: String(text || "").trim().split(/\s+/)[0] }); }

export async function error({ error } = {}) {
  return sorry(error, "Give a domain name — e.g. **example.com** (not an e-mail address or a URL).");
}
