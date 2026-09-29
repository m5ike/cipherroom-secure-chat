// /whois — who holds a domain or an IP address: registrar, dates, status,
// name servers, DNSSEC, abuse contact (RDAP, the JSON successor of whois).
import { cleanHost, isIp, isDomain, rdap, registrable, day, daysUntil, mdTable, need } from "pkg:netkit";

export async function execute({ query } = {}) {
  const q = cleanHost(await need(query, "query", "Domain or IP address", "example.com · 1.1.1.1", "Whois"));
  if (!isIp(q) && !isDomain(q)) throw new m5.Error("bad-input", `“${q}” is neither a domain nor an IP address`);
  m5.run.progress(0.2, "asking the registry (RDAP)…");
  const r = await rdap(q);
  const md = [];
  if (isIp(q)) {
    md.push(`## 🌐 ${q} — ${r.name || r.handle || "network"}`);
    md.push(mdTable(["", ""], [
      ["Network", r.name], ["Handle", r.handle], ["Range", r.range], ["CIDR", r.cidr], ["Organisation", r.org || r.registrant],
      ["Country", r.country], ["Type", r.type], ["Abuse", [r.abuseEmail, r.abusePhone].filter(Boolean).join(" · ")], ["Last changed", day(r.updated)],
    ]));
  } else {
    const left = daysUntil(r.expires);
    md.push(`## 🔎 ${r.name || registrable(q)}`);
    md.push(mdTable(["", ""], [
      ["Registrar", r.registrar + (r.registrarId ? ` (IANA ${r.registrarId})` : "")], ["Holder", r.registrant || "hidden (GDPR)"],
      ["Registered", day(r.created)], ["Changed", day(r.updated)],
      ["Expires", `${day(r.expires)}${left !== null ? ` — ${left < 0 ? "expired!" : `${left} days`}` : ""}`],
      ["Status", (r.status || []).join(", ")], ["Name servers", r.nameservers.join(", ")],
      ["DNSSEC", r.dnssec === null ? "—" : r.dnssec ? "✅ signed" : "❌ not signed"],
      ["Abuse", [r.abuseEmail, r.abusePhone].filter(Boolean).join(" · ")],
    ]));
    if (left !== null && left >= 0 && left < 30) md.push(`> ⚠️ The domain expires in **${left} days**.`);
  }
  md.push(`\n_Source: ${r.source || "rdap.org"}_`);
  m5.run.progress(1, "done");
  return m5.out.markdown(md.join("\n\n"));
}
