// /whois — who holds a domain or an IP address: registrar, dates, status,
// name servers, DNSSEC, abuse contact (RDAP, the JSON successor of whois).
//
// Entry points (1.1): execute; form — the query asked for when it is
// missing (and by "Another…"); button — "Refresh" and "Another…"; response —
// a reply with another domain or address; error.
import { cleanHost, isIp, isDomain, rdap, registrable, day, daysUntil, mdTable, ask, buttons, sorry } from "pkg:netkit";

const askQuery = () => ask("Whois", [{ name: "query", label: "Domain or IP address", placeholder: "example.com · 1.1.1.1" }], "Look up");

export async function execute({ query } = {}) {
  const q = cleanHost(query || "");
  if (!q) return askQuery();
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
  const out = [m5.out.markdown(md.join("\n\n")), buttons([{ name: "refresh", title: "Refresh", icon: "↻", data: { query: q } }, { name: "another", title: "Another…", icon: "🔎" }])];
  if (!isIp(q)) {
    const left = daysUntil(r.expires);
    if (left !== null && left >= 0 && left < 30) out.splice(1, 0, m5.out.flash(`${q} expires in ${left} days`, "warning"));
  }
  return out;
}

export async function button({ name, data } = {}) {
  if (name === "another") return askQuery();
  return execute({ query: data && data.query });
}

export async function form({ values } = {}) { return execute(values || {}); }

export async function response({ text } = {}) { return execute({ query: String(text || "").trim().split(/\s+/)[0] }); }

export async function error({ error } = {}) {
  return sorry(error, "Give a domain (**example.com**) or an IP address (**1.1.1.1**); some registries answer slowly — try again in a moment.");
}
