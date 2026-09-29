// /mail — how a domain's e-mail is set up and protected: MX (and who
// provides it), SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI — a score and what
// to fix.
import { mailInfo, cleanHost, isDomain, mdTable, yes, bar, need } from "pkg:netkit";

export async function execute({ domain } = {}) {
  const d = cleanHost(await need(domain, "domain", "Domain", "example.com", "E-mail analysis"));
  if (!isDomain(d)) throw new m5.Error("bad-input", `“${d}” is not a domain name`);
  m5.run.progress(0.2, "looking up MX, SPF, DKIM, DMARC…");
  const m = await mailInfo(d);
  const md = [`## ✉️ E-mail — ${d}`, `**${bar(m.score)}**${m.provider ? ` · provider: **${m.provider}**` : ""}`];
  md.push("### Receiving (MX)");
  md.push(m.nullMx ? "_Null MX (0 .) — the domain accepts no e-mail._" : m.mx.length ? mdTable(["Priority", "Server", "Address"], m.mx.map((x) => [x.priority, x.exchange, ((m.mxHosts.find((h) => h.host === x.exchange) || {}).a || []).join(", ")])) : "_no MX record_");
  md.push("### Authentication");
  md.push(mdTable(["Check", "Result", "Record"], [
    ["SPF", m.spf.length === 1 ? `✅ ${m.spfAll ? `${m.spfAll}all` : "no all"} · ${m.spfLookups} lookups` : m.spf.length ? "⚠️ several records" : "❌", m.spf.join(" ‖ ").slice(0, 160)],
    ["DKIM", m.dkim.some((k) => !k.revoked) ? `✅ ${m.dkim.filter((k) => !k.revoked).map((k) => k.selector).join(", ")}` : m.dkimWildcard ? (m.dkimWildcard.revoked ? "🚫 wildcard, revoked (p=)" : "⚠️ wildcard") : "❓ not found", (m.dkimWildcard ? m.dkimWildcard.key : m.dkim.map((k) => `${k.selector}: ${k.key}…`).join(" ‖ ")).slice(0, 160)],
    ["DMARC", m.dmarc ? `✅ p=${m.dmarcTags.p || "?"}${m.dmarcTags.pct ? ` pct=${m.dmarcTags.pct}` : ""}` : "❌", m.dmarc.slice(0, 160)],
    ["MTA-STS", yes(m.mtaSts.length) + (m.stsPolicy ? ` ${(/mode:\s*(\w+)/.exec(m.stsPolicy) || [])[1] || ""}` : ""), m.mtaSts.join(" ").slice(0, 120)],
    ["TLS-RPT", yes(m.tlsRpt.length), m.tlsRpt.join(" ").slice(0, 120)],
    ["BIMI", yes(m.bimi.length), m.bimi.join(" ").slice(0, 120)],
  ]));
  if (m.advice.length) { md.push("### What to improve"); md.push(m.advice.map((a) => `- ${a}`).join("\n")); }
  m5.run.progress(1, "done");
  return m5.out.markdown(md.join("\n\n"));
}
