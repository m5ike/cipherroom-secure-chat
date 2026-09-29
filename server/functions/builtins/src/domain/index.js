// /domain — the whole picture of a domain: registration (RDAP), DNS, the
// web site (status, technologies, security), hosting (who owns the
// addresses), e-mail (provider, SPF/DKIM/DMARC), social networks and links.
//
// Entry points (1.1): execute; form — the domain asked for when it is
// missing; button — "again"; response — a reply with another domain; error.
import { cleanHost, isDomain, registrable, rdap, dnsAll, lines, webInfo, mailInfo, hostingOf, day, daysUntil, mdTable, yes, bar, ask, buttons, sorry } from "pkg:netkit";

export async function execute({ domain } = {}) {
  const input = cleanHost(domain || "");
  if (!input) return ask("Domain analysis", [{ name: "domain", label: "Domain", placeholder: "example.com" }], "Analyse");
  if (!isDomain(input)) throw new m5.Error("bad-input", `“${input}” is not a domain name`);
  const d = registrable(input);
  const step = (p, t) => m5.run.progress(p, t);

  step(0.05, "registration (RDAP)…");
  const [reg, dns] = await Promise.all([rdap(d).catch((e) => ({ error: String(e.message || e) })), dnsAll(d)]);
  step(0.3, "web site…");
  const web = await webInfo(d).catch((e) => ({ error: String(e.message || e) }));
  step(0.6, "hosting and e-mail…");
  const ips = [...new Set([...(dns.A.records || []), ...(dns.AAAA.records || [])])].slice(0, 3);
  const [hosting, mail] = await Promise.all([Promise.all(ips.map((ip) => hostingOf(ip).catch(() => ({ ip })))), mailInfo(d)]);
  step(0.95, "writing the report…");

  const md = [`# 🧾 ${d}`];
  // registration
  md.push("## Registration");
  if (reg.error) md.push(`_${reg.error}_`);
  else {
    const left = daysUntil(reg.expires);
    md.push(mdTable(["", ""], [
      ["Registrar", reg.registrar], ["Holder", reg.registrant || "hidden (GDPR)"], ["Registered", day(reg.created)],
      ["Expires", `${day(reg.expires)}${left !== null ? ` (${left} days)` : ""}`], ["Status", (reg.status || []).join(", ")],
      ["DNSSEC", reg.dnssec === null ? "—" : yes(reg.dnssec)], ["Abuse", reg.abuseEmail],
    ]));
  }
  // DNS
  md.push("## DNS");
  md.push(mdTable(["Type", "Records"], ["A", "AAAA", "CNAME", "NS", "MX", "TXT", "CAA", "SOA"].map((t) => [t, lines(t, dns[t]).slice(0, 6).join("  ·  ") || "—"])));
  // web
  md.push("## Web");
  if (web.error) md.push(`_The site did not answer: ${web.error}_`);
  else {
    md.push(mdTable(["", ""], [
      ["Address", `${web.url} — HTTP ${web.status}`], ["Title", web.page.title], ["Description", web.page.description.slice(0, 180)],
      ["Speed", `${web.ms ?? "—"} ms · ${Math.round((web.bytes || 0) / 1024)} kB`], ["Server", web.server],
      ["Technologies", web.tech.map((t) => t.name).join(", ")], ["Security headers", bar(web.security.score)],
      ["Language", web.page.lang], ["robots.txt / sitemap", `${yes(web.robots)} / ${yes(web.sitemap || (web.robots && web.robots.sitemaps.length))}`],
    ]));
  }
  // hosting
  md.push("## Hosting");
  md.push(hosting.length ? mdTable(["Address", "Reverse name", "Network", "Organisation", "Country"], hosting.map((h) => [h.ip, h.ptr, h.network, h.org, h.country])) : "_no A / AAAA record_");
  // e-mail
  md.push("## E-mail");
  md.push(mdTable(["", ""], [
    ["Provider", mail.provider || "—"], ["MX", mail.nullMx ? "null MX — accepts no e-mail" : mail.mx.map((x) => `${x.priority} ${x.exchange}`).join(", ")],
    ["SPF", mail.spf.length ? `✅ ${mail.spfAll}all` : "❌"], ["DKIM", mail.dkim.some((k) => !k.revoked) ? `✅ ${mail.dkim.filter((k) => !k.revoked).map((k) => k.selector).join(", ")}` : mail.dkimWildcard ? "🚫 wildcard (revoked)" : "❓"],
    ["DMARC", mail.dmarc ? `✅ p=${mail.dmarcTags.p || "?"}` : "❌"], ["Score", bar(mail.score)],
  ]));
  // social & links
  if (!web.error) {
    md.push("## Social networks");
    md.push(web.social.length ? mdTable(["Network", "Link"], web.social.map((s) => [s.network, s.url])) : "_none linked from the home page_");
    md.push("## Links");
    md.push(mdTable(["", ""], [
      ["Internal / external", `${web.links.internal} / ${web.links.external}`],
      ["E-mail addresses", web.links.mailto.join(", ")], ["Phone numbers", web.links.tel.join(", ")],
      ["Links most to", web.links.topExternal.slice(0, 6).map(([x, n]) => `${x} (${n})`).join(", ")],
    ]));
  }
  // summary
  const notes = [];
  if (!reg.error && reg.expires && daysUntil(reg.expires) !== null && daysUntil(reg.expires) < 30) notes.push("⚠️ the registration expires within 30 days");
  if (!web.error && !web.security.https) notes.push("⚠️ the site is not on HTTPS");
  if (!web.error && web.security.score < 50) notes.push(`security headers missing: ${web.security.missing.join(", ")}`);
  notes.push(...mail.advice.slice(0, 3));
  md.push("## Summary");
  md.push(notes.map((n) => `- ${n}`).join("\n") || "- nothing stands out");
  md.push("_Reply with another domain to analyse it._");
  step(1, "done");
  return [m5.out.markdown(md.join("\n\n")), buttons([{ name: "again", title: "Again", icon: "↻", data: { domain: d } }])];
}

export async function button({ data } = {}) { return execute({ domain: data && data.domain }); }

export async function form({ values } = {}) { return execute(values || {}); }

export async function response({ text } = {}) { return execute({ domain: String(text || "").trim().split(/\s+/)[0] }); }

export async function error({ error } = {}) {
  return sorry(error, "Give a domain name — e.g. **example.com**. The analysis asks several services; one of them may be slow — try again.");
}
