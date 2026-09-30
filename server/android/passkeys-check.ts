// Passkeys on Android — the console's self-check (6.4).
//
// Credential Manager lets the app use this server's passkeys only when
// https://<rpId>/.well-known/assetlinks.json is reachable from the internet
// and lists the app's package and signing certificate; Google's Digital Asset
// Links API is what the phone actually consults, and it caches. So the check
// looks at the chain the way a phone does:
//
//   local      what this server would answer (assetLinks())
//   external   GET https://<rpId>/.well-known/assetlinks.json through the
//              public address — a reverse proxy that answers 403 or an HTML
//              page for /.well-known/ breaks every Android passkey
//   google     digitalassetlinks.googleapis.com statements:list for the site
//   certs      the fingerprints the server knows (release / env / trusted)
//   devices    the fingerprints enrolled phones report at check-in
//
// and gives one verdict, plain-language hints and the nginx block that fixes
// a blocking proxy. Fingerprints are lowercase hex everywhere here.

import { androidCertSources, assetLinks, type CertSource } from "./app-links";
import type { Device } from "./store";

export type Verdict = "ok" | "blocked" | "not-json" | "missing-cert" | "google-stale" | "no-certs";

export type PasskeyCheck = {
  ok: true;
  rpId: string;
  packageName: string;
  local: { statements: unknown[] | null };
  external: { url: string; status: number; contentType: string; json: boolean; fingerprints: string[]; error: string };
  google: { ok: boolean; fingerprints: string[]; error: string; debug: string };
  certs: Array<{ sha256: string; sources: CertSource[]; published: boolean }>;
  devices: Array<{ sha256: string; devices: number; names: string[]; lastSeen: number; trusted: boolean; release: boolean }>;
  verdict: Verdict;
  hints: string[];
  nginx: string;
};

type Fetch = typeof fetch;

const hex = (fp: unknown) => String(fp).trim().toLowerCase().replace(/[^0-9a-f]/g, "");

/** Fingerprints an assetlinks.json grants get_login_creds to, for this package. */
export function fingerprintsIn(statements: unknown, packageName: string): string[] {
  const out = new Set<string>();
  if (!Array.isArray(statements)) return [];
  for (const st of statements as Array<Record<string, unknown>>) {
    const relation = Array.isArray(st?.relation) ? (st.relation as unknown[]) : [];
    const target = (st?.target ?? {}) as { namespace?: unknown; package_name?: unknown; sha256_cert_fingerprints?: unknown };
    if (!relation.includes("delegate_permission/common.get_login_creds")) continue;
    if (target.namespace !== "android_app" || target.package_name !== packageName) continue;
    for (const fp of Array.isArray(target.sha256_cert_fingerprints) ? target.sha256_cert_fingerprints : []) {
      const h = hex(fp);
      if (h.length === 64) out.add(h);
    }
  }
  return [...out];
}

/** The nginx location that hands assetlinks.json to the app, ahead of any /.well-known or dot-file rule. */
export function nginxSnippet(port: number): string {
  return [
    "location = /.well-known/assetlinks.json {",
    `    proxy_pass http://127.0.0.1:${port};`,
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host              $host;",
    "    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    "}",
  ].join("\n");
}

async function fetchExternal(url: string, packageName: string, fetchImpl: Fetch): Promise<PasskeyCheck["external"]> {
  try {
    // No redirects: Credential Manager does not follow them for assetlinks.json.
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(6_000), headers: { accept: "application/json" } });
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const json = parsed !== null && /json/i.test(contentType || "json");
    return { url, status: res.status, contentType, json, fingerprints: json && res.status === 200 ? fingerprintsIn(parsed, packageName) : [], error: "" };
  } catch (err) {
    return { url, status: 0, contentType: "", json: false, fingerprints: [], error: (err as Error).message.slice(0, 200) };
  }
}

async function fetchGoogle(rpId: string, packageName: string, fetchImpl: Fetch): Promise<PasskeyCheck["google"]> {
  const url = `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=${encodeURIComponent(`https://${rpId}`)}&relation=${encodeURIComponent("delegate_permission/common.get_login_creds")}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    const body = (await res.json()) as {
      statements?: Array<{ target?: { androidApp?: { packageName?: string; certificate?: { sha256Fingerprint?: string } } } }>;
      errorCode?: string[];
      debugString?: string;
    };
    const fingerprints = [...new Set((body.statements ?? [])
      .filter((s) => s.target?.androidApp?.packageName === packageName)
      .map((s) => hex(s.target?.androidApp?.certificate?.sha256Fingerprint))
      .filter((h) => h.length === 64))];
    const error = (body.errorCode ?? []).join(", ");
    return { ok: res.ok && !error && fingerprints.length > 0, fingerprints, error, debug: String(body.debugString ?? "").slice(0, 800) };
  } catch (err) {
    return { ok: false, fingerprints: [], error: (err as Error).message.slice(0, 200), debug: "" };
  }
}

export async function passkeySelfCheck(opts: { rpId: string; packageName: string; port: number; devices: Device[]; fetchImpl?: Fetch }): Promise<PasskeyCheck> {
  const { rpId, packageName, port } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://${rpId}/.well-known/assetlinks.json`;
  const local = assetLinks();
  const localhost = rpId === "localhost" || rpId.endsWith(".localhost") || /^[\d.]+$/.test(rpId) || rpId.includes(":");
  const [external, google] = localhost
    ? [{ url, status: 0, contentType: "", json: false, fingerprints: [], error: "The passkey domain is a local address; phones cannot reach it." }, { ok: false, fingerprints: [], error: "local address", debug: "" }]
    : await Promise.all([fetchExternal(url, packageName, fetchImpl), fetchGoogle(rpId, packageName, fetchImpl)]);

  const sources = androidCertSources();
  const certs = [...sources].map(([sha256, src]) => ({ sha256, sources: src, published: external.fingerprints.includes(sha256) }));

  const byCert = new Map<string, PasskeyCheck["devices"][number]>();
  for (const d of opts.devices) {
    if (!d.certSha256 || d.status === "wiped") continue;
    const row = byCert.get(d.certSha256) ?? { sha256: d.certSha256, devices: 0, names: [], lastSeen: 0, trusted: false, release: false };
    row.devices++;
    const name = d.name || d.model;
    if (name && row.names.length < 5 && !row.names.includes(name)) row.names.push(name);
    row.lastSeen = Math.max(row.lastSeen, d.lastSeen);
    const src = sources.get(d.certSha256) ?? [];
    row.release = src.includes("release");
    row.trusted = src.includes("trusted") || src.includes("env");
    byCert.set(d.certSha256, row);
  }
  const devices = [...byCert.values()].sort((a, b) => b.lastSeen - a.lastSeen);

  const hints: string[] = [];
  let verdict: Verdict = "ok";
  const blocked = external.status !== 200 && !(external.status === 404 && external.json);
  if (!certs.length) {
    verdict = "no-certs";
    hints.push("This server knows no Android signing certificate yet: upload a release in Android › Releases, or trust a device's certificate below.");
  } else if (external.status === 0 || blocked) {
    verdict = "blocked";
    hints.push(external.status
      ? `${url} answers HTTP ${external.status}${external.json ? "" : " with a non-JSON page"} — the reverse proxy does not pass it to the app.`
      : `${url} could not be fetched (${external.error || "no answer"}).`);
    hints.push("Add the nginx block below to this site's server block (an exact `location =` wins over a `location ~ /\\.` deny rule), reload nginx and check again.");
  } else if (!external.json) {
    verdict = "not-json";
    hints.push(`${url} answers ${external.contentType || "something"} instead of JSON — the proxy serves a page of its own (an SPA or an error page).`);
  } else if (certs.some((c) => !c.published)) {
    verdict = "missing-cert";
    hints.push("The public assetlinks.json lacks a certificate this server knows — a cache between the internet and the app may be serving an old copy.");
  } else if (!certs.every((c) => google.fingerprints.includes(c.sha256))) {
    verdict = "google-stale";
    hints.push(google.error
      ? `Google could not read the file yet (${google.error}); it retries on its own — check again in a few minutes.`
      : "Google still has an older copy of the file; it refreshes within minutes.");
  }
  for (const d of devices) {
    if (!d.trusted && !d.release) hints.push(`${d.devices} phone(s) (${d.names.join(", ") || "unnamed"}) run a build signed with a certificate this server does not list — passkeys fail there until you trust it or install a release build.`);
  }
  if (verdict === "ok" && !hints.length) hints.push("Phones can use this server's passkeys.");

  return {
    ok: true, rpId, packageName, local: { statements: local }, external, google, certs, devices, verdict, hints,
    nginx: nginxSnippet(port),
  };
}
