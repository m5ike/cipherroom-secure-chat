// netkit — the network helpers the demo commands share (whois, dns, web,
// mail, domain): names and addresses, DNS in parallel, RDAP (the successor
// of whois, JSON over HTTPS), a small HTML reader, technology and security
// header checks, e-mail authentication (SPF, DKIM, DMARC, MTA-STS, TLS-RPT,
// BIMI) and Markdown tables. Import it with: import { … } from "pkg:netkit";

/* ------------------------------------------------------------ names */

/** "https://User@Example.com:8443/path?q" → "example.com"; "[2001:db8::1]" → "2001:db8::1". */
export function cleanHost(input) {
  let s = String(input || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^@/]*@/, "");
  s = s.split(/[/?#]/)[0];
  if (s.startsWith("[")) return s.slice(1, s.indexOf("]") > 0 ? s.indexOf("]") : undefined);
  if ((s.match(/:/g) || []).length === 1) s = s.split(":")[0];
  return s.replace(/\.$/, "");
}

export const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
export const isIPv6 = (s) => /^[0-9a-f:.]+$/i.test(s) && s.includes(":");
export const isIp = (s) => isIPv4(s) || isIPv6(s);
export const isDomain = (s) => /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(s);

const SECOND_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "com.br", "com.cn", "co.za", "com.mx", "com.tr", "co.in", "co.kr", "com.ar", "com.sg", "com.hk", "com.pl", "com.ua"]);

/** The registered domain of a host name: www.shop.example.co.uk → example.co.uk. */
export function registrable(host) {
  const p = String(host).split(".").filter(Boolean);
  if (p.length <= 2) return p.join(".");
  const last2 = p.slice(-2).join(".");
  return SECOND_LEVEL.has(last2) ? p.slice(-3).join(".") : last2;
}

/* ------------------------------------------------------------ DNS */

export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA"];

/** One lookup that never throws: { ok, records, error }. */
export async function lookup(name, type) {
  try { const records = await m5.dns.resolve(name, type); return { ok: true, records: records == null ? [] : records, error: "" }; }
  catch (e) { return { ok: false, records: [], error: String((e && e.message) || e).replace(/^cannot resolve [^:]*: /, "") }; }
}

/** Several types at once. */
export async function dnsAll(name, types = DNS_TYPES) {
  const res = await Promise.all(types.map((t) => lookup(name, t)));
  const out = {};
  types.forEach((t, i) => { out[t] = res[i]; });
  return out;
}

export const txtOf = (r) => (Array.isArray(r) ? r.join("") : String(r));

/** A record as a line of text. */
export function recordText(type, r) {
  switch (type) {
    case "MX": return r.exchange ? `${r.priority} ${r.exchange}` : `${r.priority} . (null MX — accepts no e-mail)`;
    case "TXT": return txtOf(r);
    case "SOA": return `${r.nsname} ${r.hostmaster} · serial ${r.serial} · refresh ${r.refresh} · retry ${r.retry} · expire ${r.expire} · min ${r.minttl}`;
    case "CAA": return `${r.critical ? "critical " : ""}${Object.keys(r).filter((k) => k !== "critical" && k !== "type").map((k) => `${k} "${r[k]}"`).join(" ")}`;
    case "SRV": return `${r.priority} ${r.weight} ${r.port} ${r.name}`;
    default: return typeof r === "object" ? JSON.stringify(r) : String(r);
  }
}

/** The records of a lookup as lines (SOA comes back as one object). */
export function lines(type, result) {
  if (!result || !result.ok) return [];
  const list = type === "SOA" ? [result.records] : Array.isArray(result.records) ? result.records : [result.records];
  return list.filter((x) => x !== null && x !== undefined && x !== "").map((r) => recordText(type, r));
}

/* ------------------------------------------------------------ RDAP (whois) */

function vcard(entity, key) {
  const arr = entity && entity.vcardArray && entity.vcardArray[1];
  if (!Array.isArray(arr)) return "";
  const f = arr.find((x) => x[0] === key);
  if (!f) return "";
  const v = f[3];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).join(", ") : String(v || "");
}
function allEntities(list, out = []) {
  for (const e of list || []) { out.push(e); allEntities(e.entities, out); }
  return out;
}

export const UA = { "user-agent": "M5cet-netkit/1.0 (+https://github.com/m5ike)" };
const RDAP_ACCEPT = { ...UA, accept: "application/rdap+json, application/json" };

/** IANA's RDAP bootstrap (which server answers for a TLD or an address block), cached for a day. */
async function bootstrap(kind) {
  const cache = m5.cache.scope("global");
  const key = `netkit:rdap-bootstrap:${kind}`;
  let services = await cache.get(key);
  if (!services) {
    const r = await m5.http.get(`https://data.iana.org/rdap/${kind}.json`, { headers: UA, timeoutMs: 15000, maxBytes: 2000000 });
    if (!r.ok) return null;
    services = (r.json || JSON.parse(r.text || "{}")).services || null;
    if (services) await cache.set(key, services, { ttl: "1d" });
  }
  return services;
}

function v4num(ip) { return ip.split(".").reduce((a, b) => a * 256 + Number(b), 0); }
function v6big(ip) {
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const parts = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return parts.reduce((a, p) => (a << 16n) + BigInt(parseInt(p || "0", 16)), 0n);
}
function inPrefix(ip, prefix) {
  const [net, lenS] = prefix.split("/");
  const len = Number(lenS);
  if (isIPv4(ip) && isIPv4(net)) { const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0; return ((v4num(ip) & mask) >>> 0) === ((v4num(net) & mask) >>> 0); }
  if (isIPv6(ip) && net.includes(":")) { const shift = BigInt(128 - len); return (v6big(ip) >> shift) === (v6big(net) >> shift); }
  return false;
}
const pickUrl = (urls) => (urls.find((u) => u.startsWith("https://")) || urls[0] || "").replace(/\/?$/, "/");

/** Where to ask: the registry's own RDAP server (IANA bootstrap), else rdap.org. */
async function rdapUrl(q) {
  try {
    if (isIp(q)) {
      const services = await bootstrap(isIPv4(q) ? "ipv4" : "ipv6");
      for (const [prefixes, urls] of services || []) if (prefixes.some((p) => inPrefix(q, p))) return `${pickUrl(urls)}ip/${q}`;
    } else {
      const d = registrable(q);
      const tld = d.split(".").pop();
      const services = await bootstrap("dns");
      for (const [tlds, urls] of services || []) if (tlds.includes(tld)) return `${pickUrl(urls)}domain/${d}`;
    }
  } catch (e) { /* fall back */ }
  return `https://rdap.org/${isIp(q) ? `ip/${q}` : `domain/${registrable(q)}`}`;
}

/** RDAP for a domain or an IP address — from the registry that holds it. */
export async function rdap(query) {
  const q = cleanHost(query);
  const url = await rdapUrl(q);
  const r = await m5.http.get(url, { headers: RDAP_ACCEPT, timeoutMs: 20000 });
  if (r.status === 404) throw new m5.Error("not-found", `${q}: not registered, or the registry has no RDAP service`);
  if (!r.ok) throw new m5.Error("rdap", `RDAP answered ${r.status} for ${q} (${url})`);
  const j = r.json || JSON.parse(r.text || "{}");
  return summarizeRdap(j, r.url || url);
}

export function summarizeRdap(j, source) {
  const events = {};
  for (const e of j.events || []) events[e.eventAction] = e.eventDate;
  const entities = allEntities(j.entities);
  const byRole = (role) => entities.filter((e) => (e.roles || []).includes(role));
  const registrar = byRole("registrar")[0];
  const abuse = byRole("abuse")[0];
  const holder = byRole("registrant")[0];
  const iana = registrar && (registrar.publicIds || []).find((p) => /iana/i.test(p.type || ""));
  return {
    kind: j.objectClassName || "",
    handle: j.handle || "",
    name: (j.ldhName || j.name || "").toLowerCase(),
    status: j.status || [],
    registrar: registrar ? vcard(registrar, "fn") || registrar.handle || "" : "",
    registrarId: iana ? iana.identifier : "",
    registrant: holder ? vcard(holder, "org") || vcard(holder, "fn") : "",
    abuseEmail: abuse ? vcard(abuse, "email") : "",
    abusePhone: abuse ? vcard(abuse, "tel") : "",
    created: events.registration || "",
    updated: events["last changed"] || events["last update of RDAP database"] || "",
    expires: events.expiration || "",
    nameservers: (j.nameservers || []).map((n) => String(n.ldhName || "").toLowerCase()).filter(Boolean),
    dnssec: j.secureDNS ? Boolean(j.secureDNS.delegationSigned) : null,
    range: j.startAddress ? `${j.startAddress} – ${j.endAddress}` : "",
    cidr: (j.cidr0_cidrs || []).map((c) => `${c.v4prefix || c.v6prefix}/${c.length}`).join(", "),
    country: j.country || "",
    type: j.type || "",
    org: entities.filter((e) => (e.roles || []).some((x) => x === "registrant" || x === "administrative" || x === "technical")).map((e) => vcard(e, "fn")).find(Boolean) || "",
    source: source || "",
  };
}

export const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");
export function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((t - m5.sys.now()) / 86400000) : null;
}

/* ------------------------------------------------------------ HTML */

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
}
export const originOf = (url) => ((/^(https?:\/\/[^/?#]+)/i.exec(url) || [])[1] || "");
export const hostOf = (url) => ((/^https?:\/\/(?:[^@/]*@)?([^/?#:]+)/i.exec(url) || [])[1] || "").toLowerCase();

/** A link as an absolute URL (or its special scheme: mailto:, tel:). */
export function absolute(href, base) {
  const h = String(href || "").trim();
  if (!h || h.startsWith("#") || /^javascript:/i.test(h)) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  if (h.startsWith("//")) return `${(/^(https?:)/i.exec(base) || ["", "https:"])[1]}${h}`;
  const origin = originOf(base);
  if (h.startsWith("/")) return origin + h;
  const path = base.slice(origin.length).split(/[?#]/)[0];
  return origin + path.replace(/[^/]*$/, "") + h;
}

/** Title, meta tags, Open Graph, links, scripts, counts — from HTML text (no DOM). */
export function parseHtml(html, base) {
  const text = String(html || "");
  const head = (/<head[\s\S]*?<\/head>/i.exec(text) || [text])[0];
  const metas = {};
  for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
    const key = (attr(m[0], "name") || attr(m[0], "property") || attr(m[0], "http-equiv")).toLowerCase();
    const content = attr(m[0], "content");
    if (key && content && !(key in metas)) metas[key] = content;
  }
  const linkTags = [...head.matchAll(/<link\s[^>]*>/gi)].map((m) => ({ rel: attr(m[0], "rel").toLowerCase(), href: attr(m[0], "href") }));
  const anchors = [...text.matchAll(/<a\s[^>]*>/gi)].map((m) => attr(m[0], "href")).filter(Boolean);
  const scripts = [...text.matchAll(/<script\s[^>]*src\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => absolute(decodeEntities(m[1]), base)).filter(Boolean);
  const title = decodeEntities(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1] || "").replace(/\s+/g, " ").trim());
  return {
    title,
    description: metas.description || metas["og:description"] || "",
    generator: metas.generator || "",
    lang: ((/<html[^>]*\blang\s*=\s*["']?([a-z]{2,3}(?:-[a-z0-9]+)?)/i.exec(text) || [])[1] || "").toLowerCase(),
    canonical: (linkTags.find((l) => l.rel === "canonical") || {}).href || "",
    icon: absolute((linkTags.find((l) => /\bicon\b/.test(l.rel)) || {}).href || "", base),
    feeds: linkTags.filter((l) => l.rel === "alternate" && /rss|atom/i.test(l.href)).map((l) => absolute(l.href, base)),
    og: { title: metas["og:title"] || "", type: metas["og:type"] || "", site: metas["og:site_name"] || "", image: metas["og:image"] || "" },
    robotsMeta: metas.robots || "",
    viewport: Boolean(metas.viewport),
    h1: (text.match(/<h1[\s>]/gi) || []).length,
    images: (text.match(/<img[\s>]/gi) || []).length,
    forms: (text.match(/<form[\s>]/gi) || []).length,
    links: anchors.map((a) => absolute(a, base)).filter(Boolean),
    scripts,
    metas,
  };
}

/** Internal and external links, and which sites the page links to most. */
export function linkSummary(links, base) {
  const own = registrable(hostOf(base));
  const web = links.filter((l) => /^https?:/i.test(l));
  const internal = web.filter((l) => registrable(hostOf(l)) === own);
  const external = web.filter((l) => registrable(hostOf(l)) !== own);
  const count = {};
  for (const l of external) { const d = registrable(hostOf(l)); count[d] = (count[d] || 0) + 1; }
  return {
    total: links.length,
    internal: new Set(internal).size,
    external: new Set(external).size,
    mailto: [...new Set(links.filter((l) => /^mailto:/i.test(l)).map((l) => l.slice(7).split("?")[0]))],
    tel: [...new Set(links.filter((l) => /^tel:/i.test(l)).map((l) => l.slice(4)))],
    topExternal: Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

const SOCIAL = [
  ["Facebook", /(^|\.)(facebook\.com|fb\.com)$/], ["X / Twitter", /(^|\.)(twitter\.com|x\.com)$/], ["Instagram", /(^|\.)instagram\.com$/],
  ["LinkedIn", /(^|\.)linkedin\.com$/], ["YouTube", /(^|\.)(youtube\.com|youtu\.be)$/], ["TikTok", /(^|\.)tiktok\.com$/],
  ["GitHub", /(^|\.)github\.com$/], ["GitLab", /(^|\.)gitlab\.com$/], ["Pinterest", /(^|\.)pinterest\.[a-z.]+$/],
  ["Telegram", /(^|\.)(t\.me|telegram\.me)$/], ["Discord", /(^|\.)(discord\.gg|discord\.com)$/], ["Reddit", /(^|\.)reddit\.com$/],
  ["Threads", /(^|\.)threads\.net$/], ["Bluesky", /(^|\.)bsky\.app$/], ["Vimeo", /(^|\.)vimeo\.com$/], ["WhatsApp", /(^|\.)(wa\.me|whatsapp\.com)$/],
  ["Mastodon", /(^|\.)(mastodon\.social|mastodon\.online|fosstodon\.org|mstdn\.[a-z]+)$/],
];

/** Links to social networks, one per network and address. */
export function socialLinks(links) {
  const out = [];
  const seen = new Set();
  for (const l of links) {
    const host = hostOf(l);
    const hit = SOCIAL.find(([, re]) => re.test(host));
    if (!hit) continue;
    const clean = l.split("#")[0].replace(/\/$/, "");
    if (/\/(sharer|share|intent|dialog|plugins)\b/i.test(clean)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ network: hit[0], url: clean });
  }
  return out;
}

/* ------------------------------------------------------------ technology & security */

const TECH = [
  ["WordPress", "CMS", (h, t) => /wp-content|wp-includes/i.test(t) || /wordpress/i.test(h["x-powered-by"] || "")],
  ["Joomla", "CMS", (h, t) => /\/media\/jui\/|joomla/i.test(t)],
  ["Drupal", "CMS", (h, t) => /drupal/i.test(h["x-generator"] || "") || /sites\/default\/files|drupal-settings-json/i.test(t)],
  ["Shopify", "E-commerce", (h, t) => /cdn\.shopify\.com/i.test(t) || Boolean(h["x-shopid"])],
  ["WooCommerce", "E-commerce", (h, t) => /woocommerce/i.test(t)],
  ["PrestaShop", "E-commerce", (h, t) => /prestashop/i.test(t)],
  ["Magento", "E-commerce", (h, t) => /Magento_|\bmage\/(cookies|requirejs|translate)|magento/i.test(t)],
  ["Wix", "Site builder", (h, t) => /wixstatic\.com|x-wix-/i.test(t) || Boolean(h["x-wix-request-id"])],
  ["Squarespace", "Site builder", (h, t) => /squarespace/i.test(t)],
  ["Webflow", "Site builder", (h, t) => /webflow/i.test(t)],
  ["Ghost", "CMS", (h, t) => /ghost/i.test(h["x-ghost-cache-status"] || "") || /content="Ghost/i.test(t)],
  ["Next.js", "Framework", (h, t) => /__NEXT_DATA__|\/_next\//.test(t) || /next\.js/i.test(h["x-powered-by"] || "")],
  ["Nuxt", "Framework", (h, t) => /__NUXT__|\/_nuxt\//.test(t)],
  ["React", "Framework", (h, t) => /data-reactroot|react(-dom)?(\.production)?\.min\.js|__REACT/i.test(t)],
  ["Vue", "Framework", (h, t) => /vue(\.runtime)?(\.global)?(\.prod)?\.js|data-v-[0-9a-f]{6}/i.test(t)],
  ["Angular", "Framework", (h, t) => /ng-version=|angular(\.min)?\.js/i.test(t)],
  ["Svelte", "Framework", (h, t) => /svelte-[a-z0-9]{5,}/i.test(t)],
  ["jQuery", "Library", (h, t) => /jquery(\.min)?\.js|jquery-\d/i.test(t)],
  ["Bootstrap", "Library", (h, t) => /bootstrap(\.min)?\.(css|js)/i.test(t)],
  ["Tailwind CSS", "Library", (h, t) => /tailwind/i.test(t)],
  ["Google Analytics", "Analytics", (h, t) => /googletagmanager\.com\/gtag|google-analytics\.com|gtag\(/i.test(t)],
  ["Google Tag Manager", "Analytics", (h, t) => /googletagmanager\.com\/gtm/i.test(t)],
  ["Matomo", "Analytics", (h, t) => /matomo|piwik/i.test(t)],
  ["Plausible", "Analytics", (h, t) => /plausible\.io/i.test(t)],
  ["Hotjar", "Analytics", (h, t) => /hotjar/i.test(t)],
  ["Cloudflare", "CDN", (h) => Boolean(h["cf-ray"]) || /cloudflare/i.test(h.server || "")],
  ["Fastly", "CDN", (h) => /fastly/i.test(h["x-served-by"] || "") || Boolean(h["x-fastly-request-id"])],
  ["Amazon CloudFront", "CDN", (h) => /cloudfront/i.test(h.via || "") || Boolean(h["x-amz-cf-id"])],
  ["Akamai", "CDN", (h) => /akamai/i.test(h.server || "") || Boolean(h["x-akamai-transformed"])],
  ["Vercel", "Hosting", (h) => Boolean(h["x-vercel-id"]) || /vercel/i.test(h.server || "")],
  ["Netlify", "Hosting", (h) => Boolean(h["x-nf-request-id"]) || /netlify/i.test(h.server || "")],
  ["GitHub Pages", "Hosting", (h) => /github\.com/i.test(h.server || "") || Boolean(h["x-github-request-id"])],
  ["nginx", "Web server", (h) => /nginx/i.test(h.server || "")],
  ["Apache", "Web server", (h) => /apache/i.test(h.server || "")],
  ["Microsoft IIS", "Web server", (h) => /iis/i.test(h.server || "")],
  ["LiteSpeed", "Web server", (h) => /litespeed/i.test(h.server || "")],
  ["PHP", "Language", (h, t) => /php/i.test(h["x-powered-by"] || "") || /PHPSESSID/.test(h["set-cookie"] || "")],
  ["ASP.NET", "Language", (h) => /asp\.net/i.test(h["x-powered-by"] || "") || Boolean(h["x-aspnet-version"])],
  ["reCAPTCHA", "Security", (h, t) => /recaptcha/i.test(t)],
  ["Cookiebot", "Consent", (h, t) => /cookiebot/i.test(t)],
];

/** Technologies seen in the headers and the page. */
export function detectTech(headers, html) {
  const h = headers || {};
  const t = String(html || "").slice(0, 600000);
  return TECH.filter(([, , test]) => { try { return test(h, t); } catch (e) { return false; } }).map(([name, category]) => ({ name, category }));
}

const SEC_HEADERS = [
  ["strict-transport-security", "HSTS", "forces HTTPS for returning visitors"],
  ["content-security-policy", "CSP", "limits where scripts and content may come from"],
  ["x-frame-options", "X-Frame-Options", "stops the site being framed (clickjacking)"],
  ["x-content-type-options", "X-Content-Type-Options", "no MIME sniffing (nosniff)"],
  ["referrer-policy", "Referrer-Policy", "what the site tells other sites about the visitor"],
  ["permissions-policy", "Permissions-Policy", "which browser features (camera, location…) pages may use"],
];

/** The security headers, a score out of 100 and what is missing. */
export function securityHeaders(headers, url) {
  const h = headers || {};
  const https = /^https:/i.test(url || "");
  const rows = SEC_HEADERS.map(([key, label, why]) => ({ label, present: key in h || (key === "x-frame-options" && /frame-ancestors/i.test(h["content-security-policy"] || "")), value: h[key] || "", why }));
  const got = rows.filter((r) => r.present).length;
  const score = Math.round(((https ? 1 : 0) + got) / (rows.length + 1) * 100);
  return { https, rows, score, missing: rows.filter((r) => !r.present).map((r) => r.label) };
}

/* ------------------------------------------------------------ e-mail */

export const DKIM_SELECTORS = ["default", "google", "selector1", "selector2", "k1", "k2", "k3", "s1", "s2", "mail", "dkim", "smtp", "mx", "sig1", "m1", "zoho", "protonmail", "protonmail2", "mailjet", "everlytickey1", "mandrill", "sendgrid", "fm1", "fm2", "cm"];

export function tagsOf(record) {
  const out = {};
  for (const part of String(record || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** MX, SPF, DKIM (common selectors), DMARC, MTA-STS, TLS-RPT, BIMI — and a score with advice. */
export async function mailInfo(domain) {
  const d = cleanHost(domain);
  const [mx, txt, dmarc, mtaSts, tlsRpt, bimi] = await Promise.all([
    lookup(d, "MX"), lookup(d, "TXT"), lookup(`_dmarc.${d}`, "TXT"), lookup(`_mta-sts.${d}`, "TXT"), lookup(`_smtp._tls.${d}`, "TXT"), lookup(`default._bimi.${d}`, "TXT"),
  ]);
  const txts = (txt.records || []).map(txtOf);
  const spf = txts.filter((t) => /^v=spf1(\s|$)/i.test(t));
  const dmarcRec = (dmarc.records || []).map(txtOf).find((t) => /^v=DMARC1/i.test(t)) || "";
  const dm = tagsOf(dmarcRec);
  // A selector nobody would use tells a wildcard (*._domainkey) from real keys.
  const probe = `m5check${m5.id.nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const dkimProbe = await Promise.all([...DKIM_SELECTORS, probe].map(async (sel) => ({ sel, r: await lookup(`${sel}._domainkey.${d}`, "TXT") })));
  const isKey = (x) => x.r.ok && (x.r.records || []).map(txtOf).some((t) => /(^|;)\s*(v=DKIM1|p=)/i.test(t));
  const wildcard = isKey(dkimProbe[dkimProbe.length - 1]);
  const keyText = (x) => (x.r.records || []).map(txtOf).join("");
  const revoked = (t) => /(^|;)\s*p=\s*(;|$)/i.test(t);
  const dkim = wildcard ? [] : dkimProbe.slice(0, -1).filter(isKey).map((x) => ({ selector: x.sel, key: keyText(x).slice(0, 80), revoked: revoked(keyText(x)) }));
  const dkimWildcard = wildcard ? { revoked: revoked(keyText(dkimProbe[dkimProbe.length - 1])), key: keyText(dkimProbe[dkimProbe.length - 1]).slice(0, 80) } : null;
  // "0 ." — a null MX (RFC 7505): the domain accepts no mail.
  const nullMx = (mx.records || []).length === 1 && !String(mx.records[0].exchange || "").replace(/\.$/, "");
  const mxList = nullMx ? [] : (mx.records || []).slice().sort((a, b) => a.priority - b.priority);
  const mxHosts = await Promise.all(mxList.slice(0, 3).map(async (m) => ({ host: m.exchange, priority: m.priority, a: (await lookup(m.exchange, "A")).records || [] })));
  let stsPolicy = "";
  if ((mtaSts.records || []).length) {
    try { const r = await m5.http.get(`https://mta-sts.${d}/.well-known/mta-sts.txt`, { timeoutMs: 8000 }); if (r.ok) stsPolicy = (r.text || "").trim(); } catch (e) { stsPolicy = ""; }
  }
  const spfText = spf[0] || "";
  const spfAll = (/([~?+-])all\b/.exec(spfText) || [])[1] || "";
  const spfLookups = (spfText.match(/\b(include|a|mx|ptr|exists|redirect)[:=]?/gi) || []).length;
  const provider = mailProvider(mxList.map((m) => m.exchange).join(" "), spfText);
  const advice = [];
  let score = 0;
  if (nullMx) advice.push("Null MX (0 .): the domain says it accepts no e-mail.");
  else if (mxList.length) score += 15; else advice.push("No MX record: the domain cannot receive e-mail (or uses A-record fallback).");
  if (spf.length === 1) { score += 20; if (spfAll === "-" || spfAll === "~") score += 5; else advice.push("SPF ends with ?all/+all (or nothing): tighten it to ~all or -all."); if (spfLookups > 10) advice.push(`SPF needs ${spfLookups} DNS lookups; more than 10 fails.`); }
  else if (spf.length > 1) advice.push("More than one SPF record: receivers treat that as an error — merge them.");
  else advice.push("No SPF record: add one listing who may send for the domain (v=spf1 … ~all).");
  if (dmarcRec) { score += 20; if (dm.p === "reject" || dm.p === "quarantine") score += 10; else advice.push("DMARC policy is p=none: move to quarantine or reject once reports look clean."); if (!dm.rua) advice.push("DMARC has no rua= address: you get no aggregate reports."); }
  else advice.push("No DMARC record (_dmarc): publish at least v=DMARC1; p=none; rua=mailto:…");
  if (dkim.some((k) => !k.revoked)) score += 15;
  else if (dkimWildcard) advice.push(dkimWildcard.revoked ? "DKIM: a wildcard with an empty key (p=) — every selector is revoked: the domain sends no signed mail." : "DKIM: a wildcard record answers every selector.");
  else advice.push(`No DKIM key under the common selectors (${DKIM_SELECTORS.length} tried) — it may use another selector.`);
  if ((mtaSts.records || []).length) score += 5; else advice.push("No MTA-STS: sending servers may fall back to unencrypted delivery.");
  if ((tlsRpt.records || []).length) score += 5; else advice.push("No TLS-RPT (_smtp._tls): you do not hear about TLS delivery failures.");
  if ((bimi.records || []).length) score += 5;
  return { domain: d, nullMx, dkimWildcard, mx: mxList, mxHosts, provider, spf, spfAll, spfLookups, dmarc: dmarcRec, dmarcTags: dm, dkim, mtaSts: (mtaSts.records || []).map(txtOf), stsPolicy, tlsRpt: (tlsRpt.records || []).map(txtOf), bimi: (bimi.records || []).map(txtOf), score: Math.min(100, score), advice };
}

export function mailProvider(mx, spf) {
  const s = `${mx} ${spf}`.toLowerCase();
  if (/google\.com|googlemail/.test(s)) return "Google Workspace";
  if (/outlook\.com|protection\.outlook|spf\.protection/.test(s)) return "Microsoft 365";
  if (/zoho/.test(s)) return "Zoho Mail";
  if (/protonmail|proton\.ch/.test(s)) return "Proton Mail";
  if (/seznam\.cz/.test(s)) return "Seznam.cz";
  if (/wedos/.test(s)) return "WEDOS";
  if (/forpsi/.test(s)) return "Forpsi";
  if (/active24/.test(s)) return "Active24";
  if (/mailgun/.test(s)) return "Mailgun";
  if (/sendgrid/.test(s)) return "SendGrid";
  if (/amazonses|amazonaws/.test(s)) return "Amazon SES";
  if (/icloud|me\.com/.test(s)) return "iCloud Mail";
  if (/yandex/.test(s)) return "Yandex";
  if (/ovh/.test(s)) return "OVH";
  if (/hostinger/.test(s)) return "Hostinger";
  if (/fastmail|messagingengine/.test(s)) return "Fastmail";
  return mx ? "own / other" : "";
}

/* ------------------------------------------------------------ web */

/** Fetches a page and reads it: status, timing, headers, HTML, technology, security, links. */
export async function webInfo(input) {
  const raw = String(input || "").trim();
  const start = /^https?:\/\//i.test(raw) ? raw : `https://${cleanHost(raw)}`;
  let r;
  try { r = await m5.http.get(start, { headers: { "user-agent": "Mozilla/5.0 (compatible; M5cet-webcheck/1.0)", accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, timeoutMs: 20000, maxBytes: 4000000 }); }
  catch (e) {
    if (/^https:/i.test(start) && !/^https?:\/\//i.test(raw)) r = await m5.http.get(`http://${cleanHost(raw)}`, { timeoutMs: 20000, maxBytes: 4000000 });
    else throw e;
  }
  const headers = r.headers || {};
  const html = /html|xml|text\//i.test(headers["content-type"] || "") ? (r.text || "") : "";
  const page = parseHtml(html, r.url);
  const origin = originOf(r.url);
  const [robots, sitemap] = await Promise.all([
    m5.http.get(`${origin}/robots.txt`, { headers: UA, timeoutMs: 8000, maxBytes: 200000 }).catch(() => null),
    m5.http.head(`${origin}/sitemap.xml`, { headers: UA, timeoutMs: 8000, maxBytes: 1000 }).catch(() => null),
  ]);
  const robotsText = robots && robots.ok && /text\/plain/i.test((robots.headers || {})["content-type"] || "") ? robots.text || "" : "";
  return {
    input: raw, url: r.url, status: r.status, ok: r.ok, ms: r.timing ? r.timing.totalMs : null, bytes: r.bytes, headers,
    server: headers.server || "", poweredBy: headers["x-powered-by"] || "", contentType: headers["content-type"] || "",
    page, tech: detectTech(headers, html), security: securityHeaders(headers, r.url),
    redirected: r.url.replace(/\/$/, "") !== start.replace(/\/$/, ""),
    robots: robotsText ? { lines: robotsText.split("\n").length, sitemaps: robotsText.split("\n").filter((l) => /^sitemap:/i.test(l.trim())).map((l) => l.trim().slice(8).trim()), disallowAll: /^disallow:\s*\/\s*$/im.test(robotsText) } : null,
    sitemap: Boolean(sitemap && sitemap.ok),
    links: linkSummary(page.links, r.url),
    social: socialLinks(page.links),
  };
}

/* ------------------------------------------------------------ hosting */

/** Who hosts an address: reverse DNS and the RDAP network (name, organisation, country). */
export async function hostingOf(ip) {
  const [ptr, net] = await Promise.all([lookup(ip, "PTR"), rdap(ip).catch(() => null)]);
  return { ip, ptr: (ptr.records || [])[0] || "", network: net ? net.name || net.handle : "", org: net ? net.org || net.registrant : "", country: net ? net.country : "", range: net ? net.cidr || net.range : "" };
}

/* ------------------------------------------------------------ output */

const cell = (v) => String(v === null || v === undefined || v === "" ? "—" : v).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A Markdown table (the chat and the console render it). */
export function mdTable(columns, rows) {
  if (!rows.length) return "_none_";
  return [`| ${columns.map((c) => (c === "" ? " " : cell(c))).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export const yes = (b) => (b ? "✅" : "❌");
export const bar = (score) => `${"■".repeat(Math.round(score / 10))}${"□".repeat(10 - Math.round(score / 10))} ${score}/100`;

/** The value of an input — or, when the caller can answer, asked with a form. */
export async function need(value, field, label, placeholder, title) {
  const v = String(value ?? "").trim();
  if (v) return v;
  const kind = m5.caller.kind;
  if (kind === "user" || kind === "guest" || kind === "console") {
    const answer = await m5.form({ title: title || label, fields: [{ name: field, label, placeholder: placeholder || "", required: true }], submit: "OK" });
    const got = String((answer && answer[field]) || "").trim();
    if (got) return got;
  }
  throw new m5.Error("bad-input", `${label} is required`);
}
