// /web — a web page analysed: status, redirects, speed, size, server and
// technologies, security headers (score), title and meta tags, Open Graph,
// robots.txt and sitemap, links (internal, external, e-mail, phone), social
// networks.
import { webInfo, mdTable, yes, bar, need } from "pkg:netkit";

export async function execute({ url } = {}) {
  const target = await need(url, "url", "Web address", "https://example.com", "Web analysis");
  m5.run.progress(0.1, "fetching the page…");
  const w = await webInfo(target);
  m5.run.progress(0.9, "reading it…");
  const p = w.page;
  const md = [`## 🌍 ${p.title || w.url}`, `**${w.url}** — HTTP ${w.status}${w.redirected ? ` (redirected from ${w.input})` : ""}`];
  md.push(mdTable(["", ""], [
    ["Response", `${w.ms ?? "—"} ms · ${Math.round((w.bytes || 0) / 1024)} kB · ${w.contentType || "—"}`],
    ["Server", [w.server, w.poweredBy].filter(Boolean).join(" · ")],
    ["HTTPS", yes(w.security.https)],
    ["Language", p.lang], ["Description", p.description.slice(0, 200)],
    ["Generator", p.generator], ["Canonical", p.canonical],
    ["Open Graph", [p.og.site, p.og.type, p.og.title].filter(Boolean).join(" · ")],
    ["Mobile viewport", yes(p.viewport)], ["Robots meta", p.robotsMeta],
    ["Page", `${p.h1} × H1 · ${p.images} images · ${p.forms} forms · ${p.scripts.length} scripts`],
    ["robots.txt", w.robots ? `✅ ${w.robots.lines} lines${w.robots.disallowAll ? " — ⚠️ disallows everything" : ""}` : "❌"],
    ["Sitemap", w.sitemap || (w.robots && w.robots.sitemaps.length) ? `✅ ${(w.robots && w.robots.sitemaps[0]) || "/sitemap.xml"}` : "❌"],
    ["Feeds", p.feeds.join(", ")],
  ]));
  md.push(`### 🛡️ Security headers — ${bar(w.security.score)}`);
  md.push(mdTable(["Header", "Set", "Why"], w.security.rows.map((r) => [r.label, r.present ? `✅ ${r.value.slice(0, 60)}` : "❌", r.why])));
  md.push("### 🧩 Technologies");
  md.push(w.tech.length ? mdTable(["Technology", "Kind"], w.tech.map((t) => [t.name, t.category])) : "_nothing recognised_");
  md.push("### 🔗 Links");
  md.push(mdTable(["", ""], [
    ["Internal", w.links.internal], ["External", w.links.external],
    ["E-mail", w.links.mailto.join(", ")], ["Phone", w.links.tel.join(", ")],
    ["Most linked sites", w.links.topExternal.map(([d, n]) => `${d} (${n})`).join(", ")],
  ]));
  if (w.social.length) { md.push("### 👥 Social networks"); md.push(mdTable(["Network", "Link"], w.social.map((s) => [s.network, s.url]))); }
  m5.run.progress(1, "done");
  return m5.out.markdown(md.join("\n\n"));
}
