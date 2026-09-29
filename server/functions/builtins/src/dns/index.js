// /dns — DNS records of a host: everything at once (full) or one type
// (A, AAAA, CNAME, MX, NS, TXT, SOA, CAA, SRV, PTR); an IP address gets its
// reverse name (PTR).
import { cleanHost, isIp, dnsAll, lookup, lines, mdTable, need, DNS_TYPES } from "pkg:netkit";

export async function execute({ name, type = "full" } = {}) {
  const host = cleanHost(await need(name, "name", "Host name or IP address", "example.com", "DNS lookup"));
  const t = String(type || "full").toUpperCase();
  if (isIp(host)) {
    const r = await lookup(host, "PTR");
    return m5.out.markdown(`## 🧭 ${host}\n\n${mdTable(["Type", "Value"], r.ok ? lines("PTR", r).map((v) => ["PTR", v]) : [["PTR", r.error || "no reverse name"]])}`);
  }
  const types = t === "FULL" ? DNS_TYPES : [t];
  m5.run.progress(0.3, `resolving ${types.join(", ")}…`);
  const all = await dnsAll(host, types);
  const rows = [];
  const missing = [];
  for (const ty of types) {
    const r = all[ty];
    const values = lines(ty, r);
    if (values.length) for (const v of values) rows.push([ty, v]);
    else missing.push(`${ty}${r.error && !/ENODATA|ENOTFOUND|no data/i.test(r.error) ? ` (${r.error})` : ""}`);
  }
  // www and the mail servers' addresses help most in a full lookup.
  if (t === "FULL" && !host.startsWith("www.")) {
    const www = await lookup(`www.${host}`, "CNAME");
    const wwwA = www.ok && www.records.length ? null : await lookup(`www.${host}`, "A");
    if (www.ok && www.records.length) rows.push(["www CNAME", www.records.join(", ")]);
    else if (wwwA && wwwA.ok) rows.push(["www A", wwwA.records.join(", ")]);
  }
  const md = [`## 🧭 DNS — ${host}${t === "FULL" ? "" : ` (${t})`}`, mdTable(["Type", "Value"], rows)];
  if (missing.length) md.push(`_No records: ${missing.join(", ")}_`);
  m5.run.progress(1, "done");
  return m5.out.markdown(md.join("\n\n"));
}
