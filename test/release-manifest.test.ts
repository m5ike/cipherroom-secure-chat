// @vitest-environment node
// Release manifests (6.12, F-02; docs/protocol-v4.md § 15): script/release-manifest.ts —
// create, serialize, verify, tamper, sign, verify the signature, missing / extra files,
// the web manifest, the CLI (run directly by Node, without tsx), and that check.sh
// excludes exactly what the tool excludes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  EXCLUDE_ANY_DIRS, EXCLUDE_FILE_GLOBS, EXCLUDE_ROOT_DIRS, EXCLUDE_ROOT_FILES, FORMAT, RELEASE_NAME, WEB_NAME,
  assertSafePath, buildReleaseManifest, buildWebManifest, fingerprint, generateKeys, isExcluded, listReleaseFiles,
  parseManifest, serialize, signBytes, verifyBytes, verifyTree, writeWebManifest,
} from "../script/release-manifest";

const REPO = resolve(__dirname, "..");
const SCRIPT = join(REPO, "script", "release-manifest.ts");

let root = "";
const put = (rel: string, body = `${rel}\n`, mode?: number) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  if (mode !== undefined) chmodSync(p, mode);
};

function tree(): void {
  put("package.json", JSON.stringify({ name: "cipherroom-secure-chat", version: "9.8.7" }));
  put("server/index.ts", "export {};\n");
  put("install.sh", "#!/bin/sh\necho hi\n", 0o755);
  put("installer/lib/core.sh", "# core\n");
  put("README.md", "# readme\n");
  // never in a manifest
  put("node_modules/x/index.js", "module.exports = 1;\n");
  put("dist/index.cjs", "built\n");
  put("dist/public/index.html", "<!doctype html>\n");
  put(".env", "ADMIN_API_TOKEN=secret\n");
  put(".env-bak", "copy\n");
  put("data/accounts.json", "{}\n");
  put(".m5cet/install.conf", "INSTALL_MODE=native\n");
  put("storage.key", "k\n");
  put("tls/server.pem", "pem\n");
  put("admin-ui/public/vendor/editor.js", "vendor\n");
  put("server/notes.log", "log\n");
  put(".DS_Store", "x");
  put("android/app/build/outputs/a.apk", "apk");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "m5-release-"));
  tree();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const writeManifest = (opts: Parameters<typeof buildReleaseManifest>[1] = { walk: true }) => {
  const m = buildReleaseManifest(root, opts);
  writeFileSync(join(root, "release.json"), serialize(m));
  return m;
};

describe("selection", () => {
  it("covers what the installer deploys, never dependencies, build output, data, secrets or junk", () => {
    expect(listReleaseFiles(root, { walk: true })).toEqual(["README.md", "install.sh", "installer/lib/core.sh", "package.json", "server/index.ts"]);
  });

  it("isExcluded follows the documented rules", () => {
    for (const p of ["node_modules/a.js", "server/node_modules/a.js", ".git/config", "dist/index.cjs", ".env", ".env.local", "a/b/.env.prod",
      "x.key", "deep/x.pem", "my-firebase-adminsdk-abc.json", "serviceAccount.json", "data.db", "x.sqlite", "app.log", ".DS_Store",
      "notes~", ".x.swp", "c.bak", "android/local.properties", ".m5cet/install.conf", ".claude/launch.json", "release.json", "release.json.sig", ".git"]) {
      expect(isExcluded(p), p).toBe(true);
    }
    for (const p of ["server/index.ts", "release-signing.pub", "check.sh", "docs/release.json", ".github/workflows/ci.yml", ".dockerignore", "test/x.test.ts"]) {
      expect(isExcluded(p), p).toBe(false);
    }
    expect(isExcluded("dist/index.cjs", { withDist: true })).toBe(false);
    expect(isExcluded("dist/node_modules/pyodide/a.js", { withDist: true })).toBe(false);
    expect(isExcluded("node_modules/a.js", { withDist: true })).toBe(true);
  });

  it("--with-dist adds a prebuilt dist/ (with its runtime node_modules)", () => {
    put("dist/node_modules/better-sqlite3-multiple-ciphers/lib/index.js", "x\n");
    const files = listReleaseFiles(root, { walk: true, withDist: true });
    expect(files).toContain("dist/index.cjs");
    expect(files).toContain("dist/public/index.html");
    expect(files).toContain("dist/node_modules/better-sqlite3-multiple-ciphers/lib/index.js");
    expect(files).not.toContain("node_modules/x/index.js");
  });

  it("in a git work tree lists the tracked files only", () => {
    if (spawnSync("git", ["--version"]).error) return; // no git on this machine
    const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" });
    git("init", "-q");
    git("add", "package.json", "server/index.ts", "install.sh");
    git("commit", "-q", "-m", "x");
    put("server/untracked.ts", "x\n");
    expect(listReleaseFiles(root)).toEqual(["install.sh", "package.json", "server/index.ts"]);
    const m = buildReleaseManifest(root);
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses paths check.sh could not read back", () => {
    expect(() => assertSafePath('a"b')).toThrow();
    expect(() => assertSafePath("a\\b")).toThrow();
    expect(() => assertSafePath("a\nb")).toThrow();
    expect(() => assertSafePath("../x")).toThrow();
    expect(() => assertSafePath("/abs")).toThrow();
    expect(() => assertSafePath("ok/čeština a mezera.txt")).not.toThrow();
  });
});

describe("manifest", () => {
  it("has the contract shape, sorted entries, one per line", () => {
    const m = writeManifest();
    expect(m.format).toBe(FORMAT);
    expect(m.name).toBe(RELEASE_NAME);
    expect(m.version).toBe("9.8.7");
    const paths = m.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    const text = readFileSync(join(root, "release.json"), "utf8");
    expect(parseManifest(text)).toEqual(m);
    for (const f of m.files) expect(text).toContain(`{"path": ${JSON.stringify(f.path)}, "size": ${f.size}, "sha256": "${f.sha256}"}`);
    const entry = m.files.find((f) => f.path === "server/index.ts")!;
    expect(entry.size).toBe(11);
    expect(entry.sha256).toBe(createHash("sha256").update(readFileSync(join(root, "server/index.ts"))).digest("hex"));
  });

  it("SOURCE_DATE_EPOCH makes `created` reproducible", () => {
    const old = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    try { expect(buildReleaseManifest(root, { walk: true }).created).toBe("2026-01-01T00:00:00Z"); }
    finally { if (old === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = old; }
  });

  it("rejects a foreign format", () => {
    expect(() => parseManifest(JSON.stringify({ format: "other/1", files: [] }))).toThrow(/format/);
    expect(() => parseManifest(JSON.stringify({ format: FORMAT, files: [{ path: "a", size: 1, sha256: "zz" }] }))).toThrow();
  });
});

describe("verify", () => {
  it("an untouched tree verifies, unsigned", () => {
    writeManifest();
    const r = verifyTree(root);
    expect(r.ok).toBe(true);
    expect(r.signature).toBe("unsigned");
    expect(r.missing).toEqual([]);
    expect(r.modified).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it("finds a modified file (same size too)", () => {
    writeManifest();
    put("server/index.ts", "export {}?\n");
    const r = verifyTree(root);
    expect(r.ok).toBe(false);
    expect(r.modified).toEqual(["server/index.ts"]);
  });

  it("finds a missing file", () => {
    writeManifest();
    unlinkSync(join(root, "README.md"));
    const r = verifyTree(root);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["README.md"]);
  });

  it("an extra plain file is reported, an extra executable or native module fails", () => {
    writeManifest();
    put("server/extra.ts", "x\n");
    let r = verifyTree(root);
    expect(r.ok).toBe(true);
    expect(r.extra).toEqual(["server/extra.ts"]);
    expect(r.extraExecutable).toEqual([]);
    put("scripts/backdoor.sh", "#!/bin/sh\n", 0o755);
    put("server/evil.node", "\x7fELF");
    r = verifyTree(root);
    expect(r.ok).toBe(false);
    expect(r.extraExecutable.sort()).toEqual(["scripts/backdoor.sh", "server/evil.node"]);
  });

  it("excluded paths are never extra (dist, node_modules, .env, data, keys)", () => {
    writeManifest();
    put("dist/public/new.js", "x\n");
    put("node_modules/y/index.js", "x\n");
    put(".env.local", "x\n");
    expect(verifyTree(root).extra).toEqual([]);
  });
});

describe("signatures", () => {
  it("valid, then invalid after any change of the manifest bytes", () => {
    writeManifest();
    const { privatePem, publicB64 } = generateKeys();
    expect(Buffer.from(publicB64, "base64")).toHaveLength(32);
    writeFileSync(join(root, "release-signing.pub"), `${publicB64}\n`);
    // the public key is part of the tree: list it, then sign
    writeManifest();
    const bytes = readFileSync(join(root, "release.json"));
    writeFileSync(join(root, "release.json.sig"), `${signBytes(bytes, privatePem)}\n`);
    let r = verifyTree(root);
    expect(r.signature).toBe("valid");
    expect(r.fingerprint).toBe(fingerprint(publicB64));
    expect(r.ok).toBe(true);
    writeFileSync(join(root, "release.json"), bytes.toString("utf8").replace('"created": "', '"created": "1'));
    r = verifyTree(root);
    expect(r.signature).toBe("invalid");
    expect(r.ok).toBe(false);
  });

  it("another key does not verify; a signature without a key is no-key", () => {
    writeManifest();
    const a = generateKeys();
    const b = generateKeys();
    const bytes = readFileSync(join(root, "release.json"));
    writeFileSync(join(root, "release.json.sig"), signBytes(bytes, a.privatePem));
    expect(verifyTree(root).signature).toBe("no-key");
    writeFileSync(join(root, "release-signing.pub"), b.publicB64);
    // the pub key is now an extra file of the tree, and the signature fails
    const r = verifyTree(root);
    expect(r.signature).toBe("invalid");
    expect(verifyBytes(bytes, readFileSync(join(root, "release.json.sig"), "utf8"), a.publicB64)).toBe(true);
    const pubFile = join(root, "other.pub");
    writeFileSync(pubFile, a.publicB64);
    expect(verifyTree(root, { pub: pubFile }).signature).toBe("valid");
  });
});

describe("web manifest", () => {
  it("covers every served file but itself; extra served code fails", () => {
    const dir = join(root, "dist", "public");
    put("dist/public/assets/app-1234.js", "console.log(1)\n");
    put("dist/public/assets/app-1234.js.br", "br");
    put("dist/public/build.json", "{}\n");
    const out = writeWebManifest(dir);
    const m = parseManifest(readFileSync(out, "utf8"));
    expect(m.name).toBe(WEB_NAME);
    expect(m.files.map((f) => f.path)).toEqual(["assets/app-1234.js", "assets/app-1234.js.br", "build.json", "index.html"]);
    expect(verifyTree(dir, { manifest: out }).ok).toBe(true);
    put("dist/public/robots.txt", "x\n");
    let r = verifyTree(dir, { manifest: out });
    expect(r.ok).toBe(true);
    expect(r.extra).toEqual(["robots.txt"]);
    put("dist/public/evil.html", "<script src=/evil.js></script>");
    r = verifyTree(dir, { manifest: out });
    expect(r.ok).toBe(false);
    expect(r.extraExecutable).toEqual(["evil.html"]);
    expect(buildWebManifest(dir).files.map((f) => f.path)).not.toContain("release-web.json");
  });
});

describe("CLI (plain node, no tsx)", () => {
  const run = (args: string[], cwd = root, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

  it("manifest → verify → tamper → verify, with exit codes 0 / 1 / 2", () => {
    let r = run(["manifest", "--root", root, "--walk"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, "release.json"))).toBe(true);
    r = run(["verify", "--root", root, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    put("install.sh", "#!/bin/sh\necho owned\n", 0o755);
    r = run(["verify", "--root", root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("modified  install.sh");
    expect(run(["frobnicate"]).status).toBe(2);
    expect(run(["verify", "--root"]).status).toBe(2);
  });

  it("keygen writes a 0600 private key outside the repo and refuses one inside", () => {
    const keyDir = mkdtempSync(join(tmpdir(), "m5-key-"));
    try {
      const pub = join(root, "release-signing.pub");
      let r = run(["keygen", "--out", join(keyDir, "k", "release.key"), "--pub", pub], root);
      expect(r.status, r.stderr).toBe(0);
      expect(statSync(join(keyDir, "k", "release.key")).mode & 0o777).toBe(0o600);
      expect(Buffer.from(readFileSync(pub, "utf8").trim(), "base64")).toHaveLength(32);
      expect(r.stdout).toContain(fingerprint(readFileSync(pub, "utf8")));
      // again without --force: refused
      expect(run(["keygen", "--out", join(keyDir, "k", "release.key"), "--pub", pub], root).status).toBe(2);
      // inside the current directory (the repository): refused
      r = run(["keygen", "--out", join(root, "release.key"), "--pub", pub], root);
      expect(r.status).toBe(2);
      expect(existsSync(join(root, "release.key"))).toBe(false);
      // sign + verify --require-signature
      expect(run(["manifest", "--root", root, "--walk"]).status).toBe(0);
      r = run(["sign", "--key", join(keyDir, "k", "release.key"), "--pub", pub, "release.json"], root);
      expect(r.status, r.stderr).toBe(0);
      r = run(["verify", "--root", root, "--require-signature", "--json"]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).signature).toBe("valid");
      // a key that does not match release-signing.pub is refused
      const other = join(keyDir, "other.key");
      writeFileSync(other, generateKeys().privatePem, { mode: 0o600 });
      expect(run(["sign", "--key", other, "--pub", pub, "release.json"], root).status).toBe(2);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });

  it("unsigned fails --require-signature", () => {
    expect(run(["manifest", "--root", root, "--walk"]).status).toBe(0);
    expect(run(["verify", "--root", root, "--require-signature"]).status).toBe(1);
  });
});

describe("check.sh uses the same exclusions", () => {
  const sh = readFileSync(join(REPO, "check.sh"), "utf8");
  const list = (name: string) => (sh.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1] ?? "").split(/\s+/).filter(Boolean);
  it("M5_EXCL_* equal EXCLUDE_*", () => {
    expect(list("M5_EXCL_ANY_DIRS")).toEqual(EXCLUDE_ANY_DIRS);
    expect(list("M5_EXCL_ROOT_DIRS")).toEqual(EXCLUDE_ROOT_DIRS);
    expect(list("M5_EXCL_FILE_GLOBS")).toEqual(EXCLUDE_FILE_GLOBS);
    expect(list("M5_EXCL_ROOT_FILES")).toEqual(EXCLUDE_ROOT_FILES);
  });
});
