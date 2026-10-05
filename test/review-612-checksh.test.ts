// @vitest-environment node
// REVIEW-612 — adversarial review of check.sh (6.12). Each test asserts the SECURE behaviour against a
// fixture tree in a temp dir; the ones check.sh does not meet yet are it.skip with a REVIEW-612 C<nn> note.
// Nothing here needs root: M5CHECK_UID=0 only makes check.sh *believe* it is root, stub commands on PATH
// stand in for runuser, every other host tool is hidden with M5CHECK_ABSENT, and every "payload" merely
// creates a marker file inside the temp dir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CHECK = join(resolve(__dirname, ".."), "check.sh");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const HOST_TOOLS = [
  "lsof", "pgrep", "ss", "ip", "ifconfig", "systemctl", "journalctl", "ufw", "firewall-cmd", "nft", "iptables", "docker", "podman",
  "nginx", "apache2ctl", "apachectl", "httpd", "caddy", "traefik", "timedatectl", "chronyc", "getent", "dig", "host", "dscacheutil",
  "turnutils_stunclient", "bwrap", "runuser", "setpriv", "sudo", "getenforce", "needs-restarting", "npm", "curl", "git", "ffmpeg",
  "bzip2", "haproxy", "timeout", "gtimeout",
];

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
  run(args: string[], opt: { uid?: number; offline?: boolean; cwd?: string } = {}): { status: number; stdout: string; raw: Buffer } {
    const r = spawnSync(BASH, [CHECK, "--no-color", "--lang", "en", "--root", this.root, ...(opt.offline === false ? [] : ["--offline"]), ...args], {
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
  json(args: string[], opt: { uid?: number; offline?: boolean; cwd?: string } = {}) {
    return JSON.parse(this.run([...args, "--json"], opt).stdout) as { checks: Array<{ id: string; status: string; message: string }> };
  }
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
  // REVIEW-612 C01: TURN_SERVER_URL host/port go into `bash -c "exec 3<>/dev/tcp/${h}/${p}"` (net_turn) — root command execution from .env
  it.skip("TURN_SERVER_URL with a command substitution does not run it (network.turn)", () => {
    const marker = join(box.dir, "MARK_TURN");
    box.put(".env", `TURN_SERVER_URL=turn:h$(touch\${IFS}${marker})\n`, 0o600);
    box.run(["--only", "network"], { offline: false });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C01: REDIS_URL host/port go into `bash -c "exec 3<>/dev/tcp/${h}/${p}"` (sys_redis) — root command execution from .env
  it.skip("REDIS_URL with a command substitution does not run it (system.redis)", () => {
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

  // REVIEW-612 C02: SERVICE_MANAGER other than systemd/process leaves SVC_USER empty → run_as() runs node as root and require()s tree code
  it.skip("an unknown SERVICE_MANAGER in install.conf does not make check.sh load tree code itself", () => {
    const marker = box.sqlcipherTree("INSTALL_MODE=native\nSERVICE_MANAGER=launchd\n");
    box.run(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C02: no install.conf (a plain checkout run with sudo) → SVC_USER empty → tree code loaded as root
  it.skip("a tree without install.conf does not make check.sh load tree code itself", () => {
    const marker = box.sqlcipherTree(null);
    box.run(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  // REVIEW-612 C02: SERVICE_USER=root → run_as() does not switch → tree code loaded as root
  it.skip("SERVICE_USER=root does not make check.sh load tree code as root", () => {
    const marker = box.sqlcipherTree("INSTALL_MODE=native\nSERVICE_MANAGER=systemd\nSERVICE_USER=root\n");
    box.run(["--only", "package"], { uid: 0 });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("REVIEW-612 check.sh — output", () => {
  // REVIEW-612 C03: safe_url() only strips userinfo matching [^@/]*@ — a password containing '/' is printed in full
  it.skip("a REDIS_URL password containing '/' is not printed", () => {
    box.put(".env", "REDIS_URL=redis://:DUMMY/PASSWORD@127.0.0.1:6379\n", 0o600);
    const out = box.run(["--only", "config,system"]).stdout + box.run(["--only", "config,system", "--json"]).stdout;
    expect(out).not.toContain("DUMMY");
    expect(out).not.toContain("PASSWORD");
  });

  // REVIEW-612 C03: a password containing '@' is cut at the first '@' — the rest is printed
  it.skip("a REDIS_URL password containing '@' is not printed in part", () => {
    box.put(".env", "REDIS_URL=redis://user:DUMMY@PART@127.0.0.1:6379\n", 0o600);
    expect(box.run(["--only", "config", "--json"]).stdout).not.toContain("PART");
  });

  // REVIEW-612 C04: text output prints .env values and file names raw — terminal escape sequences reach the operator's terminal
  it.skip("terminal control characters from .env values are not written to the terminal output", () => {
    box.put(".env", "PUBLIC_BASE_URL=https://ex\u001b[2Kample.com\n", 0o600);
    expect(box.run(["--only", "config"]).raw.includes(0x1b)).toBe(false);
  });

  it("the JSON report escapes / strips control characters (json_esc)", () => {
    box.put(".env", "PUBLIC_BASE_URL=https://ex\u001b[2Kample.com\n", 0o600);
    const r = box.run(["--only", "config", "--json"]);
    expect(r.raw.includes(0x1b)).toBe(false);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  // REVIEW-612 C06: bytes that are not UTF-8 (from .env values or file names) make the --json / --report output invalid UTF-8
  it.skip("the JSON report is valid UTF-8 even when a value is not", () => {
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

  // REVIEW-612 C05: `for f in $(find …)` word-splits — a readable key file whose name contains a space is never checked (PASS)
  it.skip("a readable key file whose name contains a space also fails config.keys", () => {
    mkdirSync(join(box.dir, "data"), { mode: 0o700 });
    box.put(".env", `DATA_DIR=${join(box.dir, "data")}\n`, 0o600);
    box.put("with space.key", "k", 0o644, join(box.dir, "data"));
    expect(box.json(["--only", "config"]).checks.find((c) => c.id === "config.keys")?.status).toBe("FAIL");
  });
});
