// @vitest-environment node
// REVIEW-612 — adversarial review of check.sh (6.12). Each test asserts the SECURE behaviour against a
// fixture tree in a temp dir. The ones check.sh did not meet on de2874d3 were it.skip with a REVIEW-612
// C<nn> note; all C01–C12 are fixed now and every note says how (docs/review-612.md, docs/install-check.md).
// Nothing here needs root: M5CHECK_UID=0 only makes check.sh *believe* it is root, stub commands on PATH
// stand in for runuser, every other host tool is hidden with M5CHECK_ABSENT, and every "payload" merely
// creates a marker file inside the temp dir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildWebManifest, serialize } from "../script/release-manifest";

const CHECK = join(resolve(__dirname, ".."), "check.sh");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const HOST_TOOLS = [
  "lsof", "pgrep", "ss", "ip", "ifconfig", "systemctl", "journalctl", "ufw", "firewall-cmd", "nft", "iptables", "docker", "podman",
  "nginx", "apache2ctl", "apachectl", "httpd", "caddy", "traefik", "timedatectl", "chronyc", "getent", "dig", "host", "dscacheutil",
  "turnutils_stunclient", "bwrap", "runuser", "setpriv", "sudo", "getenforce", "needs-restarting", "npm", "curl", "git", "ffmpeg",
  "bzip2", "haproxy", "timeout", "gtimeout",
];

type RunOpt = { uid?: number; offline?: boolean; cwd?: string; root?: boolean };
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const status = (r: { checks: Array<{ id: string; status: string }> }, id: string) => r.checks.find((c) => c.id === id)?.status ?? "(none)";
const message = (r: { checks: Array<{ id: string; message: string }> }, id: string) => r.checks.find((c) => c.id === id)?.message ?? "";

class Box {
  dir = mkdtempSync(join(tmpdir(), "m5-review612-"));
  root = join(this.dir, "install");
  stubs = join(this.dir, "stubs");
  tools = join(this.dir, "tools");
  stubbed = new Set<string>();
  constructor() {
    for (const d of [this.root, this.stubs, this.tools]) mkdirSync(d, { recursive: true });
    symlinkSync(process.execPath, join(this.tools, "node"));
    this.put("package.json", '{ "name": "cipherroom-secure-chat", "version": "0.0.0" }\n');
  }
  put(rel: string, body: string | Buffer, mode?: number, base = this.root): string {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    if (mode !== undefined) chmodSync(p, mode);
    return p;
  }
  stub(name: string, body: string): void {
    this.put(name, `#!/bin/sh\n${body}\n`, 0o755, this.stubs);
    this.stubbed.add(name);
  }
  /** Expose a real host tool (git) to the check; false when the host has none. */
  real(name: string): boolean {
    for (const d of (process.env.PATH ?? "").split(":")) {
      if (d && existsSync(join(d, name))) { symlinkSync(join(d, name), join(this.tools, name)); this.stubbed.add(name); return true; }
    }
    return false;
  }
  run(args: string[], opt: RunOpt = {}): { status: number; stdout: string; raw: Buffer } {
    const r = spawnSync(BASH, [CHECK, "--no-color", "--lang", "en", ...(opt.root === false ? [] : ["--root", this.root]), ...(opt.offline === false ? [] : ["--offline"]), ...args], {
      cwd: opt.cwd ?? this.dir,
      env: {
        PATH: `${this.stubs}:${this.tools}:/usr/bin:/bin`, HOME: this.dir, TMPDIR: this.dir,
        M5CHECK_ABSENT: HOST_TOOLS.filter((t) => !this.stubbed.has(t)).join(" "),
        M5CHECK_UID: String(opt.uid ?? 1000),
      },
      timeout: 60_000,
    });
    return { status: r.status ?? -1, stdout: r.stdout.toString("utf8"), raw: r.stdout };
  }
  json(args: string[], opt: RunOpt = {}) {
    return JSON.parse(this.run([...args, "--json"], opt).stdout) as { root: string; checks: Array<{ id: string; status: string; message: string }> };
  }
  log(name: string): string { const p = join(this.dir, name); return existsSync(p) ? readFileSync(p, "utf8") : ""; }
  /** A tree with a dist/ and a fake SQLCipher module that only records that it was loaded. */
  sqlcipherTree(conf: string | null): string {
    for (const f of ["dist/index.cjs", "dist/sandbox.cjs", "dist/public/index.html", "dist/public/build.json"]) this.put(f, "");
    const marker = join(this.dir, "MODULE_LOADED_IN_CHECK_PROCESS");
    this.put("dist/node_modules/better-sqlite3-multiple-ciphers/index.js",
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "loaded\\n");\n` +
      `module.exports = class { prepare() { return { get: () => ({ v: "fake" }) }; } close() {} };\n`);
    if (conf !== null) this.put(".m5cet/install.conf", conf, 0o600);
    // runuser stub: records the switch, does NOT run the command, prints a version like the real probe would.
    this.stub("runuser", `echo "$@" >> "${join(this.dir, "runuser.log")}"; echo 3.0.0-switched`);
    return marker;
  }
  cleanup(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

let box: Box;
beforeEach(() => { box = new Box(); });
afterEach(() => { box.cleanup(); });

describe("REVIEW-612 check.sh — .env values must never be evaluated as shell code", () => {
  // REVIEW-612 C01 (fixed): TURN_SERVER_URL host/port went into `bash -c "exec 3<>/dev/tcp/${h}/${p}"` (net_turn) — now validated, positional args to a fixed script (tcp_probe)
  it("TURN_SERVER_URL with a command substitution does not run it (network.turn)", () => {
    const marker = join(box.dir, "MARK_TURN");
    box.put(".env", `TURN_SERVER_URL=turn:h$(touch\${IFS}${marker})\n`, 0o600);
    box.run(["--only", "network"], { offline: false });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C01 (fixed): REDIS_URL host/port went into `bash -c "exec 3<>/dev/tcp/${h}/${p}"` (sys_redis) — now validated, tcp_probe
  it("REDIS_URL with a command substitution does not run it (system.redis)", () => {
    box.put(".env", "REDIS_URL=redis://$(touch${IFS}MARK_REDIS)\n", 0o600);
    box.run(["--only", "system"], { offline: false });
    expect(existsSync(join(box.dir, "MARK_REDIS"))).toBe(false);
  });
});

describe("REVIEW-612 check.sh — code from the install tree never runs in the (root) check process", () => {
  it("systemd + a non-root SERVICE_USER: the SQLCipher probe switches users (runuser)", () => {
    const marker = box.sqlcipherTree("INSTALL_MODE=native\nSERVICE_MANAGER=systemd\nSERVICE_USER=m5cet\n");
    const r = box.json(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(box.dir, "runuser.log"), "utf8")).toMatch(/^-u m5cet -- /);
    expect(r.checks.find((c) => c.id === "package.sqlcipher")?.message).toContain("3.0.0-switched");
  });

  // REVIEW-612 C02 (fixed): an unknown SERVICE_MANAGER left SVC_USER empty → run_as() ran node as root; now DROP_USER = the tree owner, else SKIP
  it("an unknown SERVICE_MANAGER in install.conf does not make check.sh load tree code itself", () => {
    const marker = box.sqlcipherTree("INSTALL_MODE=native\nSERVICE_MANAGER=launchd\n");
    box.run(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C02 (fixed): no install.conf (a checkout run with sudo) loaded tree code as root; now as the owner of the tree, else SKIP
  it("a tree without install.conf does not make check.sh load tree code itself", () => {
    const marker = box.sqlcipherTree(null);
    box.run(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C02 (fixed): SERVICE_USER=root did not switch; root / uid 0 is never a DROP_USER
  it("SERVICE_USER=root does not make check.sh load tree code as root", () => {
    const marker = box.sqlcipherTree("INSTALL_MODE=native\nSERVICE_MANAGER=systemd\nSERVICE_USER=root\n");
    box.run(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C02 (fixed): without runuser / setpriv / sudo the probe is a SKIP that says why — never a root fallback
  it("without a tool to switch users the SQLCipher probe is skipped, not run as root", () => {
    const marker = box.sqlcipherTree("INSTALL_MODE=native\nSERVICE_MANAGER=systemd\nSERVICE_USER=m5cet\n");
    box.stubbed.delete("runuser"); // hidden again by M5CHECK_ABSENT
    const r = box.json(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
    expect(status(r, "package.sqlcipher")).toBe("SKIP");
    expect(message(r, "package.sqlcipher")).toMatch(/runuser|setpriv|sudo/);
  });
});

describe("REVIEW-612 check.sh — git and npm on the install tree", () => {
  const git = (...a: string[]) => execFileSync("git", ["-C", box.root, "-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" });
  /** A git checkout whose own .git/config names an fsmonitor hook that leaves a marker. */
  function fsmonitorRepo(): string {
    const marker = join(box.dir, "FSMONITOR_RAN");
    box.put(".gitignore", ".m5cet/\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const hook = box.put("fsmonitor-hook", `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, 0o755, box.dir);
    git("config", "core.fsmonitor", hook);
    return marker;
  }

  // REVIEW-612 C07 (fixed): `git -c safe.directory=<root> status` honoured the tree's core.fsmonitor — now -c core.fsmonitor=false,
  // core.hooksPath=/dev/null, no system / global config, never a safe.directory override
  it("git status in check.sh never runs the repository's core.fsmonitor program", () => {
    if (!box.real("git")) return;
    const marker = fsmonitorRepo();
    execFileSync("git", ["-C", box.root, "status", "--porcelain"], { stdio: "pipe" }); // a plain git status runs it…
    const effective = existsSync(marker);
    rmSync(marker, { force: true });
    const r = box.json(["--only", "package"]);
    expect(existsSync(marker)).toBe(false); // …check.sh's does not
    expect(["PASS", "FAIL"]).toContain(status(r, "package.integrity"));
    if (!effective) console.warn("this git does not run core.fsmonitor on status — the PoC proves less here");
  });

  // REVIEW-612 C07 (fixed): as root git runs as the owner of .git (runuser), hardened, never with safe.directory
  it("as root, git on a tree another user owns runs as that user with the hardening flags", () => {
    if (!box.real("git")) return;
    const marker = fsmonitorRepo();
    box.stub("runuser", `echo "$@" >> "${join(box.dir, "runuser.log")}"; exit 0`);
    box.json(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
    const log = box.log("runuser.log");
    expect(log).toContain(`-u ${userInfo().username} -- env -i`);
    expect(log).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(log).toContain("git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null");
    expect(log).not.toContain("safe.directory");
  });

  // REVIEW-612 C07 (fixed): as root without a way to switch to the owner, git is skipped
  it("as root without runuser / setpriv / sudo, git on another user's tree is skipped", () => {
    if (!box.real("git")) return;
    const marker = fsmonitorRepo();
    const r = box.json(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
    expect(status(r, "package.integrity")).toBe("SKIP");
  });

  // REVIEW-612 C08 (fixed): `npm ls` ran as root inside the tree (its .npmrc) — now as DROP_USER via runuser, else SKIP
  it("as root, npm ls runs as the owner of the tree, never directly", () => {
    box.put("node_modules/x/package.json", "{}\n");
    const marker = join(box.dir, "NPM_RAN_AS_CHECK");
    box.stub("npm", `touch "${marker}"`);
    box.stub("runuser", `echo "$@" >> "${join(box.dir, "runuser.log")}"; exit 0`);
    const r = box.json(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
    expect(box.log("runuser.log")).toMatch(new RegExp(`^-u ${userInfo().username} -- npm ls `, "m"));
    expect(status(r, "package.npm_ls")).toBe("PASS");
  });

  // REVIEW-612 C08 (fixed): `npm audit` ran inside the tree (a registry in its .npmrc would receive the lockfile) —
  // now it reads a private copy of package.json + package-lock.json (--package-lock-only)
  it("npm audit runs on a private copy of the lockfile, not inside the tree", () => {
    box.put("package-lock.json", '{ "name": "cipherroom-secure-chat", "lockfileVersion": 3, "packages": {} }\n');
    box.put(".npmrc", "registry=https://registry.attacker.invalid/\n");
    const log = join(box.dir, "npm.log");
    box.stub("curl", "echo 200");
    box.stub("npm", `echo "$PWD|$*" >> "${log}"
case "$*" in *audit*) echo '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}' ;; esac`);
    const r = box.json(["--only", "package"], { offline: false });
    expect(status(r, "package.npm_audit")).toBe("PASS");
    const audit = readFileSync(log, "utf8").split("\n").find((l) => l.includes("audit")) ?? "";
    const [cwd, args] = audit.split("|");
    expect(cwd).toMatch(/\/audit$/);
    expect(cwd.startsWith(box.root)).toBe(false);
    expect(args).toContain("--package-lock-only");
  });
});

describe("REVIEW-612 check.sh — which tree, which files, which process", () => {
  // REVIEW-612 C09 (fixed): as root a ~/.config pointer (sudo -E keeps HOME) picked the tree root inspects
  it("as root, a ~/.config/m5cet/install-dir pointer does not choose the tree", () => {
    box.put(".m5cet/install.conf", "INSTALL_MODE=native\n", 0o600);
    box.put(".config/m5cet/install-dir", `${box.root}\n`, 0o644, box.dir); // HOME is box.dir
    expect(box.json(["--only", "kernel"], { root: false, uid: 1000 }).root).toBe(box.root);
    expect(box.json(["--only", "kernel"], { root: false, uid: 0 }).root).not.toBe(box.root);
  });

  const manifest = (files: Array<{ path: string; body: string | Buffer }>) => box.put("release.json", [
    "{", '  "format": "m5cet-release/1",', '  "name": "m5cet",', '  "version": "0.0.0",', `  "commit": "${"a".repeat(40)}",`, '  "files": [',
    files.map((f) => `    {"path": ${JSON.stringify(f.path)}, "size": ${Buffer.byteLength(f.body)}, "sha256": "${sha256(f.body)}"}`).join(",\n"),
    "  ]", "}", "",
  ].join("\n"));

  // REVIEW-612 C10 (fixed): manifest paths were not confined — root hashed ../ and absolute paths (an oracle on files it can read)
  it("a release.json path outside the tree FAILs package.integrity", () => {
    const outside = box.put("outside.txt", "secret\n", 0o600, box.dir);
    manifest([{ path: "package.json", body: readFileSync(join(box.root, "package.json")) }, { path: "../outside.txt", body: readFileSync(outside) }]);
    const r = box.json(["--only", "package"], { uid: 0 });
    expect(status(r, "package.integrity")).toBe("FAIL");
    expect(message(r, "package.integrity")).toMatch(/outside the tree/);
    manifest([{ path: "-c", body: "x" }]);
    expect(message(box.json(["--only", "package"]), "package.integrity")).toMatch(/outside the tree/);
  });

  // REVIEW-612 C10 (fixed): a path through a symlinked directory is not "in the tree" — it is missing, never hashed as a match
  it("a listed file reached through a symlinked directory is missing, not verified", () => {
    const body = "secret\n";
    box.put("secret.txt", body, 0o600, join(box.dir, "elsewhere"));
    symlinkSync(join(box.dir, "elsewhere"), join(box.root, "lnk"));
    manifest([{ path: "package.json", body: readFileSync(join(box.root, "package.json")) }, { path: "lnk/secret.txt", body }]);
    const r = box.json(["--only", "package"]);
    expect(status(r, "package.integrity")).toBe("FAIL");
    expect(message(r, "package.integrity")).toContain("lnk/secret.txt");
  });

  // REVIEW-612 C12 (fixed): a missing dist/public/release-web.json.sig produced no result at all
  it("an unsigned release-web.json is reported (package.web_signature SKIP), not silent", () => {
    box.put("dist/public/index.html", "<!doctype html>\n");
    writeFileSync(join(box.root, "dist/public/release-web.json"), serialize(buildWebManifest(join(box.root, "dist/public"), { commit: "c".repeat(40), version: "0.0.0" })));
    const r = box.json(["--only", "package"]);
    expect(status(r, "package.web")).toBe("PASS");
    expect(status(r, "package.web_signature")).toBe("SKIP");
    expect(message(r, "package.web_signature")).toMatch(/not signed/);
  });
});

describe("REVIEW-612 check.sh — credentials in URLs", () => {
  // REVIEW-612 C03 (fixed): a user:password@ in TURN_SERVER_URL was printed with the host
  it("TURN_SERVER_URL credentials are never printed", () => {
    box.put(".env", "TURN_SERVER_URL=turn:user:TurnSecret-XYZ@127.0.0.1:9\nTURN_SECRET=s\n", 0o600);
    const out = box.run(["--only", "config,network,security"], { offline: false }).stdout + box.run(["--only", "config,network,security", "--json"], { offline: false }).stdout;
    expect(out).not.toContain("TurnSecret-XYZ");
    expect(out).toContain("127.0.0.1:9");
  });

  it("a DATABASE_URL-style password in PUBLIC_BASE_URL / WEBAUTHN_ORIGINS is not printed", () => {
    box.put(".env", "PUBLIC_BASE_URL=https://u:PubSecret-1@chat.example.com/x?token=QuerySecret-2\nWEBAUTHN_ORIGINS=https://o:OrgSecret-3@chat.example.com\n", 0o600);
    const out = box.run(["--only", "config", "--json"]).stdout;
    for (const s of ["PubSecret-1", "QuerySecret-2", "OrgSecret-3"]) expect(out).not.toContain(s);
  });
});

describe("REVIEW-612 check.sh — output", () => {
  // REVIEW-612 C03 (fixed): safe_url() stripped only [^@/]*@ — now url_parts(): an '@' after the authority prints scheme://***
  it("a REDIS_URL password containing '/' is not printed", () => {
    box.put(".env", "REDIS_URL=redis://:DUMMY/PASSWORD@127.0.0.1:6379\n", 0o600);
    const out = box.run(["--only", "config,system"]).stdout + box.run(["--only", "config,system", "--json"]).stdout;
    expect(out).not.toContain("DUMMY");
    expect(out).not.toContain("PASSWORD");
  });

  // REVIEW-612 C03 (fixed): a password with '@' was cut at the first '@' — the host is now taken after the last '@'
  it("a REDIS_URL password containing '@' is not printed in part", () => {
    box.put(".env", "REDIS_URL=redis://user:DUMMY@PART@127.0.0.1:6379\n", 0o600);
    expect(box.run(["--only", "config", "--json"]).stdout).not.toContain("PART");
  });

  // REVIEW-612 C04 (fixed): text output printed values raw — every message now passes clean_text (controls, C1, bidi → '?')
  it("terminal control characters from .env values are not written to the terminal output", () => {
    box.put(".env", "PUBLIC_BASE_URL=https://ex\u001b[2Kample.com\n", 0o600);
    expect(box.run(["--only", "config"]).raw.includes(0x1b)).toBe(false);
  });

  it("the JSON report escapes / strips control characters (json_esc)", () => {
    box.put(".env", "PUBLIC_BASE_URL=https://ex\u001b[2Kample.com\n", 0o600);
    const r = box.run(["--only", "config", "--json"]);
    expect(r.raw.includes(0x1b)).toBe(false);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  // REVIEW-612 C06 (fixed): non-UTF-8 bytes made --json / --report invalid — clean_text keeps valid UTF-8 only
  it("the JSON report is valid UTF-8 even when a value is not", () => {
    box.put(".env", Buffer.concat([Buffer.from("PUBLIC_BASE_URL=https://ex"), Buffer.from([0xff]), Buffer.from("ample.com\n")]), 0o600);
    const r = box.run(["--only", "config", "--json"]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(r.raw)).not.toThrow();
  });
});

describe("REVIEW-612 check.sh — checks must not pass silently", () => {
  it("a group/world-readable key file in the data directory fails config.keys", () => {
    mkdirSync(join(box.dir, "data"), { mode: 0o700 });
    box.put(".env", `DATA_DIR=${join(box.dir, "data")}\n`, 0o600);
    box.put("plain.key", "k", 0o644, join(box.dir, "data"));
    expect(box.json(["--only", "config"]).checks.find((c) => c.id === "config.keys")?.status).toBe("FAIL");
  });

  // REVIEW-612 C05 (fixed): `for f in $(find …)` word-split — now find -print0 / read -d '' and quoted .env paths
  it("a readable key file whose name contains a space also fails config.keys", () => {
    mkdirSync(join(box.dir, "data"), { mode: 0o700 });
    box.put(".env", `DATA_DIR=${join(box.dir, "data")}\n`, 0o600);
    box.put("with space.key", "k", 0o644, join(box.dir, "data"));
    expect(box.json(["--only", "config"]).checks.find((c) => c.id === "config.keys")?.status).toBe("FAIL");
  });
});
