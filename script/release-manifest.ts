// Release manifests (6.12, F-02) — docs/protocol-v4.md § 15, the type is
// `ReleaseManifest` in client/src/lib/p4/contract.ts.
//
//   npm run release:manifest       release.json for this tree (what the installer deploys)
//   npm run release:web-manifest   dist/public/release-web.json (the served assets)
//   npm run release:keygen         Ed25519 key pair: private key OUTSIDE the repo, public key
//                                  to release-signing.pub
//   npm run release:sign           release.json(.sig) and dist/public/release-web.json(.sig)
//   npm run release:verify         a tree against its manifest (exit 0 ok, 1 problems, 2 usage)
//
// Extra arguments go after `--`, e.g. `npm run release:verify -- --json --root /opt/m5cet`.
//
// What release.json covers — the files the installer deploys from a source
// tree (installer/lib/deploy.sh: a git checkout, or an rsync of a release
// tree without .git, node_modules, dist, .env*, .m5cet): in a git work tree
// the tracked files (`git ls-files`), otherwise every regular file; in both
// cases without the EXCLUDE_* rules below (dependencies, build output, data,
// secrets and keys, editor/OS junk, the manifest and its signature).
// dist/ is NOT covered by default: the installer builds it on the host, and
// the build is not byte-reproducible (build.json carries the build time) —
// the build writes its own dist/public/release-web.json instead. A release
// that ships a prebuilt dist/ uses `--with-dist`.
//
// The format is fixed so that check.sh can read it without a JSON parser:
// one file entry per line, keys in the order path, size, sha256. Paths with
// a double quote, a backslash or a control character are refused.
//
// Only node: built-ins and erasable TypeScript: Node ≥ 22.18 runs this file
// directly (`node script/release-manifest.ts verify`), without tsx.
//
// KEEP THE EXCLUDE_* LISTS IN SYNC with the M5_EXCL_* variables in check.sh
// (test/release-manifest.test.ts compares them).

import type { ReleaseManifest } from "../client/src/lib/p4/contract";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const FORMAT = "m5cet-release/1";
export const RELEASE_NAME = "m5cet";
export const WEB_NAME = "m5cet-web";
export const RELEASE_FILE = "release.json";
export const WEB_FILE = "release-web.json";
export const PUBKEY_FILE = "release-signing.pub";
export const DEFAULT_KEY = join(homedir(), ".m5cet", "release-signing.key");

/** Directory names skipped at any depth. */
export const EXCLUDE_ANY_DIRS = [".git", "node_modules", ".gradle", ".kotlin", ".idea", ".vscode", "__pycache__"];
/** Directories (relative to the root) skipped entirely. */
export const EXCLUDE_ROOT_DIRS = [
  "dist", ".m5cet", ".claude", ".vite", ".memory", "coverage", "data",
  "admin-ui/public/vendor", "android/build", "android/app/build", "test-results", "playwright-report",
];
/** File-name globs (basename, `*` only) skipped at any depth: secrets, keys, data, junk. */
export const EXCLUDE_FILE_GLOBS = [
  ".env*", "*.key", "*.pem", "*.p12", "*.pfx", "*.jks", "*.keystore", "*firebase-adminsdk*.json", "serviceAccount*.json",
  "*.db", "*.db-shm", "*.db-wal", "*.db-journal", "*.sqlite", "*.sqlite3",
  "*.log", ".DS_Store", "*~", ".*.swp", "*.bak", "local.properties", ".git",
];
/** Root files that are never part of the manifest they describe. */
export const EXCLUDE_ROOT_FILES = [RELEASE_FILE, `${RELEASE_FILE}.sig`];

export type FileEntry = ReleaseManifest["files"][number];

export type VerifyResult = {
  ok: boolean;
  manifest: { name: string; version: string; commit: string; created: string; files: number };
  /** valid / invalid: checked with the key; unsigned: no .sig; no-key: a .sig but no public key. */
  signature: "valid" | "invalid" | "unsigned" | "no-key";
  /** SHA-256 of the raw public key (hex), when one was used. */
  fingerprint: string;
  missing: string[];
  modified: string[];
  /** Files in the covered tree that the manifest does not list. */
  extra: string[];
  /** Of those, the ones that can run: an executable bit, a native library — or, in a web root, served code. */
  extraExecutable: string[];
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}
const FILE_RES = EXCLUDE_FILE_GLOBS.map(globToRegExp);

/** Is this directory (relative, with `/`) skipped as a whole? */
export function isExcludedDir(relDir: string, opts: { withDist?: boolean } = {}): boolean {
  const parts = relDir.split("/");
  const base = parts[parts.length - 1];
  if (EXCLUDE_ANY_DIRS.includes(base) && !(opts.withDist && parts[0] === "dist" && base === "node_modules")) return true;
  return EXCLUDE_ROOT_DIRS.some((d) => !(opts.withDist && d === "dist") && relDir === d);
}

/** Is this file path (relative, with `/`) outside what a release manifest covers? */
export function isExcluded(rel: string, opts: { withDist?: boolean } = {}): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (parts.length === 1 && EXCLUDE_ROOT_FILES.includes(base)) return true;
  for (let i = 1; i < parts.length; i++) if (isExcludedDir(parts.slice(0, i).join("/"), opts)) return true;
  return FILE_RES.some((re) => re.test(base));
}

/** A path check.sh can read back: relative, `/`-separated, no quote, backslash or control character. */
export function assertSafePath(rel: string): void {
  // eslint-disable-next-line no-control-regex
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..") || /["\\\u0000-\u001f\u007f]/.test(rel)) {
    throw new Error(`unsupported path in a release: ${JSON.stringify(rel)}`);
  }
}

function walk(root: string, acceptFile: (rel: string) => boolean, acceptDir: (rel: string) => boolean = () => true, out: string[] = [], dir = root): string[] {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join("/");
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      if (acceptDir(rel)) walk(root, acceptFile, acceptDir, out, abs);
    } else if (st.isFile() && acceptFile(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function gitTracked(root: string): string[] | null {
  try {
    const inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (inside !== "true") return null;
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (realPath(top) !== realPath(root)) return null;
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).toString();
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function workTreeTop(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

function gitCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The files a release manifest of `root` lists. */
export function listReleaseFiles(root: string, opts: { withDist?: boolean; walk?: boolean } = {}): string[] {
  const accept = (rel: string) => !isExcluded(rel, opts);
  const tracked = opts.walk ? null : gitTracked(root);
  let files: string[];
  if (tracked) {
    files = tracked.filter((rel) => accept(rel) && lstatSync(join(root, rel), { throwIfNoEntry: false })?.isFile());
    // A prebuilt dist/ is never tracked: add it from the disk.
    if (opts.withDist && existsSync(join(root, "dist"))) files.push(...walk(join(root, "dist"), (rel) => accept(`dist/${rel}`), (rel) => !isExcludedDir(`dist/${rel}`, opts)).map((rel) => `dist/${rel}`));
  } else {
    files = walk(root, accept, (rel) => !isExcludedDir(rel, opts));
  }
  return [...new Set(files)].sort(cmp);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function entriesFor(root: string, files: string[]): FileEntry[] {
  return files.map((rel) => {
    assertSafePath(rel);
    const abs = join(root, rel);
    return { path: rel, size: lstatSync(abs).size, sha256: sha256File(abs) };
  });
}

function createdAt(): string {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The canonical text: stable key order, one file entry per line (check.sh reads it with awk). */
export function serialize(m: ReleaseManifest): string {
  const head = [
    `  "format": ${JSON.stringify(m.format)}`,
    `  "name": ${JSON.stringify(m.name)}`,
    `  "version": ${JSON.stringify(m.version)}`,
    `  "commit": ${JSON.stringify(m.commit)}`,
    `  "created": ${JSON.stringify(m.created)}`,
  ];
  const files = m.files.map((f) => `    {"path": ${JSON.stringify(f.path)}, "size": ${f.size}, "sha256": ${JSON.stringify(f.sha256)}}`);
  return `{\n${head.join(",\n")},\n  "files": [\n${files.join(",\n")}\n  ]\n}\n`;
}

function packageVersion(root: string): string {
  for (const p of [join(root, "package.json"), join(root, "..", "..", "package.json")]) {
    try { const v = JSON.parse(readFileSync(p, "utf8")).version; if (typeof v === "string" && v) return v; } catch { /* next */ }
  }
  return "0.0.0";
}

export function buildReleaseManifest(root: string, opts: { withDist?: boolean; walk?: boolean; commit?: string; version?: string } = {}): ReleaseManifest {
  const files = listReleaseFiles(root, opts);
  return {
    format: FORMAT,
    name: RELEASE_NAME,
    version: opts.version || packageVersion(root),
    commit: opts.commit || process.env.M5CET_COMMIT?.trim() || gitCommit(root),
    created: createdAt(),
    files: entriesFor(root, files),
  };
}

/** dist/public/release-web.json: every served file, nothing else. */
export function buildWebManifest(dir: string, opts: { commit?: string; version?: string; repoRoot?: string } = {}): ReleaseManifest {
  const files = walk(dir, (rel) => rel !== WEB_FILE && rel !== `${WEB_FILE}.sig` && !/(^|\/)\.DS_Store$/.test(rel));
  const repoRoot = opts.repoRoot ?? resolve(dir, "..", "..");
  return {
    format: FORMAT,
    name: WEB_NAME,
    version: opts.version || packageVersion(repoRoot),
    commit: opts.commit || process.env.M5CET_COMMIT?.trim() || gitCommit(repoRoot),
    created: createdAt(),
    files: entriesFor(dir, files.sort(cmp)),
  };
}

/** Called by script/build.ts after the assets are final (precompressed). */
export function writeWebManifest(dir = "dist/public"): string {
  const out = join(dir, WEB_FILE);
  const m = buildWebManifest(dir);
  writeFileSync(out, serialize(m));
  return out;
}

// ---------------------------------------------------------------------------
// Keys and signatures
// ---------------------------------------------------------------------------

function b64urlToB64(s: string): string {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return t + "=".repeat((4 - (t.length % 4)) % 4);
}

/** Raw 32-byte public key, standard base64 (the content of release-signing.pub). */
export function rawPublicKeyB64(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return b64urlToB64(jwk.x);
}

export function publicKeyFromRaw(b64: string): KeyObject {
  const raw = Buffer.from(b64.trim(), "base64");
  if (raw.length !== 32) throw new Error("release-signing.pub must hold a raw 32-byte Ed25519 key in base64");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

export function fingerprint(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64.trim(), "base64")).digest("hex");
}

export function generateKeys(): { privatePem: string; publicB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicB64: rawPublicKeyB64(publicKey) };
}

export function signBytes(data: Buffer, privatePem: string): string {
  return edSign(null, data, createPrivateKey(privatePem)).toString("base64");
}

export function verifyBytes(data: Buffer, sigB64: string, publicB64: string): boolean {
  try {
    const sig = Buffer.from(sigB64.trim(), "base64");
    return sig.length === 64 && edVerify(null, data, publicKeyFromRaw(publicB64), sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const NATIVE_RE = /\.(node|so|dylib|dll|exe)$/i;
const SERVED_CODE_RE = /\.(html?|xhtml|m?js|cjs|wasm|svg|xml)$/i;

export function parseManifest(text: string): ReleaseManifest {
  const m = JSON.parse(text) as Partial<ReleaseManifest>;
  if (m.format !== FORMAT) throw new Error(`unknown manifest format ${JSON.stringify(m.format)} (expected ${FORMAT})`);
  if (!Array.isArray(m.files)) throw new Error("manifest has no files list");
  for (const f of m.files) {
    if (typeof f?.path !== "string" || typeof f.size !== "number" || !/^[0-9a-f]{64}$/.test(String(f.sha256))) throw new Error("malformed file entry");
    assertSafePath(f.path);
  }
  return m as ReleaseManifest;
}

export function verifyTree(root: string, opts: { manifest?: string; pub?: string; web?: boolean } = {}): VerifyResult {
  const manifestPath = resolve(opts.manifest ?? join(root, RELEASE_FILE));
  const bytes = readFileSync(manifestPath);
  const m = parseManifest(bytes.toString("utf8"));
  const web = opts.web ?? m.name === WEB_NAME;

  let signature: VerifyResult["signature"] = "unsigned";
  let fp = "";
  const sigPath = `${manifestPath}.sig`;
  if (existsSync(sigPath)) {
    const pubPath = opts.pub ?? (web ? "" : join(root, PUBKEY_FILE));
    const pub = pubPath && existsSync(pubPath) ? readFileSync(pubPath, "utf8").trim() : "";
    if (!pub) signature = "no-key";
    else {
      fp = (() => { try { return fingerprint(pub); } catch { return ""; } })();
      signature = verifyBytes(bytes, readFileSync(sigPath, "utf8"), pub) ? "valid" : "invalid";
    }
  }

  const listed = new Set<string>();
  const missing: string[] = [];
  const modified: string[] = [];
  for (const f of m.files) {
    listed.add(f.path);
    const st = lstatSync(join(root, f.path), { throwIfNoEntry: false });
    if (!st) { missing.push(f.path); continue; }
    if (!st.isFile() || st.size !== f.size || sha256File(join(root, f.path)) !== f.sha256) modified.push(f.path);
  }

  const withDist = m.files.some((f) => f.path.startsWith("dist/"));
  const manifestRel = relative(root, manifestPath).split(sep).join("/");
  const present = web
    ? walk(root, (rel) => rel !== manifestRel && rel !== `${manifestRel}.sig`)
    : walk(root, (rel) => !isExcluded(rel, { withDist }), (rel) => !isExcludedDir(rel, { withDist }));
  const extra = present.filter((rel) => !listed.has(rel));
  const extraExecutable = extra.filter((rel) => {
    if (web) return SERVED_CODE_RE.test(rel);
    const st = lstatSync(join(root, rel));
    return (st.mode & 0o111) !== 0 || NATIVE_RE.test(rel);
  });

  const ok = missing.length === 0 && modified.length === 0 && extraExecutable.length === 0 && signature !== "invalid";
  return {
    ok,
    manifest: { name: m.name, version: m.version, commit: m.commit, created: m.created, files: m.files.length },
    signature, fingerprint: fp, missing, modified, extra, extraExecutable,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Args = { _: string[]; flags: Record<string, string | true> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out.flags[k] = v;
      else if (["json", "force", "with-dist", "walk", "require-signature", "web", "help"].includes(k)) out.flags[k] = true;
      else if (i + 1 < argv.length) out.flags[k] = argv[++i];
      else throw new UsageError(`--${k} needs a value`);
    } else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

const str = (a: Args, k: string, d = ""): string => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : d);

/** The real path of `p` (symlinks resolved), also for a path that does not exist yet. */
function realPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(basename(cur));
    cur = up;
  }
  try { cur = realpathSync(cur); } catch { /* keep the resolved path */ }
  return join(cur, ...tail);
}

function insideDir(path: string, dir: string): boolean {
  const rel = relative(realPath(dir), realPath(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

const USAGE = `M5cet release manifests (docs/install-check.md)

  release-manifest.ts manifest      [--root .] [--out <root>/release.json] [--with-dist] [--walk] [--commit SHA]
  release-manifest.ts web-manifest  [--dir dist/public] [--out <dir>/release-web.json]
  release-manifest.ts keygen        [--out ~/.m5cet/release-signing.key] [--pub release-signing.pub] [--force]
  release-manifest.ts sign          [--key ~/.m5cet/release-signing.key] [--pub release-signing.pub] [--force] [FILE…]
  release-manifest.ts verify        [--root .] [--manifest <root>/release.json] [--pub <root>/release-signing.pub]
                                    [--web] [--json] [--require-signature]
`;

export function main(argv: string[]): number {
  let args: Args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`${(e as Error).message}\n${USAGE}`); return 2; }
  const cmd = args._[0] ?? "";
  if (args.flags.help || !cmd) { process.stdout.write(USAGE); return cmd || args.flags.help ? 0 : 2; }
  try {
    switch (cmd) {
      case "manifest": {
        const root = resolve(str(args, "root", "."));
        const out = resolve(str(args, "out", join(root, RELEASE_FILE)));
        const m = buildReleaseManifest(root, { withDist: !!args.flags["with-dist"], walk: !!args.flags.walk, commit: str(args, "commit") || undefined });
        writeFileSync(out, serialize(m));
        process.stdout.write(`${out}: ${m.files.length} files, ${m.name} ${m.version} (${m.commit.slice(0, 12)})\n`);
        return 0;
      }
      case "web-manifest": {
        const dir = resolve(str(args, "dir", "dist/public"));
        if (!existsSync(join(dir, "index.html"))) throw new UsageError(`${dir} holds no index.html — run npm run build first`);
        const out = resolve(str(args, "out", join(dir, WEB_FILE)));
        const m = buildWebManifest(dir);
        writeFileSync(out, serialize(m));
        process.stdout.write(`${out}: ${m.files.length} files\n`);
        return 0;
      }
      case "keygen": {
        const out = resolve(str(args, "out", process.env.M5CET_RELEASE_KEY || DEFAULT_KEY));
        const pubOut = resolve(str(args, "pub", PUBKEY_FILE));
        // The private key never lives in the repository (a commit would publish it).
        if (insideDir(out, workTreeTop(process.cwd()) ?? process.cwd())) throw new UsageError(`refusing to write the private key inside the repository (${out}); pass --out with a path outside it`);
        if (existsSync(out) && !args.flags.force) throw new UsageError(`${out} exists — pass --force to replace it (every earlier signature then needs the old public key)`);
        const { privatePem, publicB64 } = generateKeys();
        mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
        writeFileSync(out, privatePem, { mode: 0o600, flag: args.flags.force ? "w" : "wx" });
        writeFileSync(pubOut, `${publicB64}\n`);
        process.stdout.write(`private key: ${out} (0600 — keep it offline, never on the server)\npublic key:  ${pubOut}\n${publicB64}\nfingerprint: SHA256 ${fingerprint(publicB64)}\n`);
        return 0;
      }
      case "sign": {
        const keyPath = resolve(str(args, "key", process.env.M5CET_RELEASE_KEY || DEFAULT_KEY));
        if (!existsSync(keyPath)) throw new UsageError(`no private key at ${keyPath} (npm run release:keygen)`);
        const privatePem = readFileSync(keyPath, "utf8");
        const derivedPub = rawPublicKeyB64(createPublicKey(createPrivateKey(privatePem)));
        const pubPath = resolve(str(args, "pub", PUBKEY_FILE));
        if (existsSync(pubPath) && readFileSync(pubPath, "utf8").trim() !== derivedPub && !args.flags.force) {
          throw new UsageError(`${keyPath} does not match ${pubPath} — signatures would not verify (--force to sign anyway)`);
        }
        const files = args._.slice(1).length ? args._.slice(1) : [RELEASE_FILE, join("dist", "public", WEB_FILE)].filter((f) => existsSync(f));
        if (!files.length) throw new UsageError("nothing to sign: no release.json or dist/public/release-web.json (npm run release:manifest / npm run build)");
        for (const f of files) {
          const sig = signBytes(readFileSync(f), privatePem);
          writeFileSync(`${f}.sig`, `${sig}\n`);
          process.stdout.write(`${f}.sig\n`);
        }
        return 0;
      }
      case "verify": {
        const root = resolve(str(args, "root", "."));
        const r = verifyTree(root, { manifest: str(args, "manifest") || undefined, pub: str(args, "pub") || undefined, web: args.flags.web ? true : undefined });
        const failed = !r.ok || (args.flags["require-signature"] && r.signature !== "valid");
        if (args.flags.json) process.stdout.write(`${JSON.stringify({ ...r, ok: !failed })}\n`);
        else {
          const lines = [
            `${r.manifest.name} ${r.manifest.version} (${r.manifest.commit.slice(0, 12)}), ${r.manifest.files} files`,
            `signature: ${r.signature}${r.fingerprint ? ` (key SHA256 ${r.fingerprint})` : ""}`,
            ...r.missing.map((p) => `missing   ${p}`),
            ...r.modified.map((p) => `modified  ${p}`),
            ...r.extra.map((p) => `extra${r.extraExecutable.includes(p) ? "!" : " "}    ${p}`),
            failed ? "FAILED" : "OK",
          ];
          process.stdout.write(`${lines.join("\n")}\n`);
        }
        return failed ? 1 : 0;
      }
      default:
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (e) {
    process.stderr.write(`release-manifest: ${(e as Error).message}\n`);
    if (e instanceof UsageError) process.stderr.write(USAGE);
    return e instanceof UsageError ? 2 : 1;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
