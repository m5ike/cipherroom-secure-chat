// Does the client inside the app fit the server? (pure)
//
// Every build of the web client writes /version-manifest.json (vite.config.ts
// › buildInfo): app version, build id, the signaling protocol, the bundled
// libraries. The app carries the manifest of ITS client and reads the
// server's over the network (not intercepted) before it loads the page:
//
//   same          identical version and build
//   compatible    same signaling protocol, same major.minor version (a patch or a
//                 rebuild on either side) — loads silently
//   incompatible  another signaling protocol, or another major / minor version:
//                 the app asks — update the app, use this server's web code
//                 (remembered per server, with a persistent indicator), or try
//                 the app's code anyway
//   unknown       the server has no manifest (an old server, a development
//                 server, offline) — loads the app's code; the page itself
//                 reports connection problems as on the web

export type VersionManifestLike = {
  app?: unknown;
  version?: unknown;
  build?: unknown;
  protocol?: unknown;
};

export type Compat =
  | { level: "same"; app: string; server: string }
  | { level: "compatible"; app: string; server: string }
  | { level: "incompatible"; app: string; server: string; reasons: Array<"protocol" | "version">; newer: "app" | "server" | "equal" }
  | { level: "unknown"; app: string; server: null };

export type ParsedVersion = { major: number; minor: number; patch: number };

export function parseVersion(v: unknown): ParsedVersion | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:[-+].*)?$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

function cmp(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** A server answer that is a version manifest (not the SPA fallback's HTML, not junk). */
export function asManifest(value: unknown): { version: string; build: string; protocol: number } | null {
  if (!value || typeof value !== "object") return null;
  const m = value as VersionManifestLike;
  if (m.app !== undefined && m.app !== "m5cet") return null;
  if (!parseVersion(m.version) || typeof m.build !== "string" || !Number.isInteger(m.protocol)) return null;
  return { version: String(m.version), build: m.build, protocol: Number(m.protocol) };
}

export function compareVersions(app: VersionManifestLike, server: VersionManifestLike | null): Compat {
  const a = asManifest(app);
  if (!a) throw new Error("the bundled version manifest is missing or broken");
  const s = server ? asManifest(server) : null;
  if (!s) return { level: "unknown", app: a.version, server: null };
  const av = parseVersion(a.version)!;
  const sv = parseVersion(s.version)!;
  if (a.version === s.version && a.build === s.build && a.protocol === s.protocol) return { level: "same", app: a.version, server: s.version };
  const reasons: Array<"protocol" | "version"> = [];
  if (a.protocol !== s.protocol) reasons.push("protocol");
  if (av.major !== sv.major || av.minor !== sv.minor) reasons.push("version");
  if (reasons.length === 0) return { level: "compatible", app: a.version, server: s.version };
  const c = cmp(av, sv);
  return { level: "incompatible", app: a.version, server: s.version, reasons, newer: c > 0 ? "app" : c < 0 ? "server" : "equal" };
}
