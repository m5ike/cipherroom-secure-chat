// @vitest-environment node
// check.sh (6.12) — the read-only installation and host check. Runs the real
// script against fixture install trees, fixture "sysroots" (/proc, /sys, /etc
// read through --sysroot / M5CHECK_FAKE_ROOT) and stub commands on PATH; every
// host tool a test does not stub is hidden with M5CHECK_ABSENT, so the machine
// running the tests never leaks into a result. Also: real `nginx -T` output
// (test/fixtures/install-check, captured from nginx 1.31), the JSON report,
// exit codes, secrets never printed, the installer's update hook.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildReleaseManifest, buildWebManifest, generateKeys, serialize, signBytes } from "../script/release-manifest";

const REPO = resolve(__dirname, "..");
const CHECK = join(REPO, "check.sh");
const FIX = join(REPO, "test", "fixtures", "install-check");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

// Every command check.sh may ask the host for. Hidden unless a test stubs it.
const HOST_TOOLS = [
  "lsof", "pgrep", "ss", "ip", "ifconfig", "systemctl", "journalctl", "ufw", "firewall-cmd", "nft", "iptables", "docker", "podman",
  "nginx", "apache2ctl", "apachectl", "httpd", "caddy", "traefik", "timedatectl", "chronyc", "getent", "dig", "host", "dscacheutil",
  "turnutils_stunclient", "bwrap", "runuser", "setpriv", "sudo", "getenforce", "needs-restarting", "npm", "curl", "git", "ffmpeg",
  "bzip2", "haproxy", "gtimeout",
];

function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, cmd);
    if (dir && existsSync(p)) return p;
  }
  return "";
}
const OPENSSL = (() => {
  const p = which("openssl");
  if (!p) return "";
  try { return /^OpenSSL [3-9]/.test(execFileSync(p, ["version"]).toString()) ? p : ""; } catch { return ""; }
})();

type Run = { status: number; stdout: string; stderr: string };
type Report = { exit: number; summary: { pass: number; warn: number; fail: number; skip: number }; checks: Array<{ section: string; id: string; status: string; message: string; hint: string }> };

class Sandbox {
  dir = mkdtempSync(join(tmpdir(), "m5-check-"));
  stubs = join(this.dir, "stubs");
  tools = join(this.dir, "tools");
  root = join(this.dir, "install");
  sys = join(this.dir, "sys");
  stubbed = new Set<string>();

  constructor() {
    mkdirSync(this.stubs, { recursive: true });
    mkdirSync(this.tools, { recursive: true });
    mkdirSync(this.root, { recursive: true });
    symlinkSync(process.execPath, join(this.tools, "node"));
    if (OPENSSL) symlinkSync(OPENSSL, join(this.tools, "openssl"));
  }

  /** A stub command: a POSIX sh script. */
  stub(name: string, body: string): void {
    const p = join(this.stubs, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    this.stubbed.add(name);
  }
  /** Expose a real host tool (git) to the check. */
  real(name: string): void {
    const p = which(name);
    if (p) { symlinkSync(p, join(this.tools, name)); this.stubbed.add(name); }
  }
  put(rel: string, body: string, mode?: number, base = this.root): string {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    if (mode !== undefined) chmodSync(p, mode);
    return p;
  }

  run(args: string[], opt: { uid?: number; env?: Record<string, string>; absent?: string[]; sysroot?: boolean } = {}): Run {
    const absent = [...HOST_TOOLS.filter((t) => !this.stubbed.has(t)), ...(opt.absent ?? [])];
    const env: Record<string, string> = {
      PATH: `${this.stubs}:${this.tools}:/usr/bin:/bin`,
      HOME: this.dir,
      TMPDIR: this.dir,
      LANG: "C",
      M5CHECK_ABSENT: absent.join(" "),
      M5CHECK_UID: String(opt.uid ?? 1000),
      ...(opt.sysroot === false ? {} : { M5CHECK_FAKE_ROOT: this.sys }),
      ...opt.env,
    };
    mkdirSync(this.sys, { recursive: true });
    const r = spawnSync(BASH, [CHECK, "--no-color", "--offline", "--root", this.root, ...args], { env, encoding: "utf8", timeout: 60_000 });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  json(args: string[], opt: Parameters<Sandbox["run"]>[1] = {}): Report {
    const r = this.run([...args, "--json"], opt);
    try { return JSON.parse(r.stdout) as Report; } catch { throw new Error(`not JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`); }
  }
  cleanup(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

/** A stand-in for the app as the process manager runs it: `node dist/SCRIPT` with the tree as cwd. */
function startApp(sb: Sandbox, script: string): ChildProcess {
  sb.put(`dist/${script}`, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [`dist/${script}`], { cwd: sb.root, stdio: "ignore" });
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const args = spawnSync("ps", ["-o", "args=", "-p", String(child.pid)], { encoding: "utf8" }).stdout ?? "";
    if (args.includes(`dist/${script}`)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return child;
}

const st = (r: Report, id: string): string => r.checks.find((c) => c.id === id)?.status ?? "(none)";
const msg = (r: Report, id: string): string => r.checks.find((c) => c.id === id)?.message ?? "";
const ids = (r: Report, status: string): string[] => r.checks.filter((c) => c.status === status).map((c) => c.id);

// --- fixtures ----------------------------------------------------------------

const GOOD_SYSCTL: Record<string, string> = {
  "net/ipv4/tcp_syncookies": "1", "net/ipv4/conf/all/rp_filter": "2", "net/ipv4/conf/all/accept_redirects": "0",
  "net/ipv6/conf/all/accept_redirects": "0", "net/ipv4/conf/all/send_redirects": "0", "net/ipv4/conf/all/accept_source_route": "0",
  "net/ipv4/icmp_echo_ignore_broadcasts": "1", "net/ipv4/conf/all/log_martians": "1", "net/core/somaxconn": "4096",
  "net/ipv4/ip_local_port_range": "15000\t65000", "net/core/rmem_max": "4194304", "net/core/wmem_max": "4194304",
  "fs/file-max": "801661", "fs/file-nr": "1024\t0\t801661", "fs/protected_symlinks": "1", "fs/protected_hardlinks": "1",
  "kernel/kptr_restrict": "1", "kernel/dmesg_restrict": "1", "kernel/unprivileged_bpf_disabled": "2", "kernel/yama/ptrace_scope": "1",
  "user/max_user_namespaces": "31483", "vm/overcommit_memory": "0", "net/ipv4/ip_forward": "0", "net/ipv6/conf/all/disable_ipv6": "0",
  "kernel/random/entropy_avail": "256", "kernel/osrelease": "6.8.0-45-generic",
};

function sysroot(sb: Sandbox, sysctl: Record<string, string | null> = {}, files: Record<string, string> = {}): void {
  const all: Record<string, string | null> = { ...GOOD_SYSCTL, ...sysctl };
  for (const [k, v] of Object.entries(all)) if (v !== null) sb.put(`proc/sys/${k}`, `${v}\n`, undefined, sb.sys);
  const base: Record<string, string> = {
    "etc/os-release": 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
    "proc/meminfo": "MemTotal:        4028000 kB\nMemFree:          900000 kB\nMemAvailable:    2500000 kB\nSwapTotal:       2097148 kB\n",
    "proc/cpuinfo": "processor\t: 0\nprocessor\t: 1\n",
    "proc/mounts": "/dev/sda1 / ext4 rw,relatime 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev,noexec 0 0\n",
    "proc/net/netstat": "TcpExt: SyncookiesSent ListenOverflows ListenDrops\nTcpExt: 0 0 0\n",
    "sys/kernel/mm/transparent_hugepage/enabled": "always [madvise] never\n",
    "etc/passwd": "root:x:0:0:root:/root:/bin/bash\nm5cet:x:999:999::/nonexistent:/usr/sbin/nologin\n",
    "etc/group": "root:x:0:\nsudo:x:27:admin\nm5cet:x:999:\n",
  };
  for (const [k, v] of Object.entries({ ...base, ...files })) sb.put(k, v, undefined, sb.sys);
}

const SECRET_TOKEN = "SeCrEtToKeN-0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRETS = [SECRET_TOKEN, "TurnCred-ZZZ-987654", "vapidPRIVATEkey-QQQ", "RedisPw-XYZ-24680", "dbPassw0rd-Hidden"];

function install(sb: Sandbox, o: { conf?: Record<string, string>; env?: Record<string, string>; envMode?: number; version?: string } = {}): void {
  sb.put("package.json", JSON.stringify({ name: "cipherroom-secure-chat", version: o.version ?? "6.12.0" }, null, 2) + "\n");
  mkdirSync(join(sb.root, ".m5cet"), { recursive: true, mode: 0o700 });
  chmodSync(join(sb.root, ".m5cet"), 0o700);
  const conf = { INSTALL_MODE: "native", SCOPE: "user", SERVICE_MANAGER: "process", SERVICE_NAME: "m5cet", SERVICE_USER: "m5cet", APP_PORT: "5190", BIND_ADDRESS: "127.0.0.1", ENABLE_ADMIN: "0", ADMIN_PORT: "5191", INSTALLED_VERSION: o.version ?? "6.12.0", ...o.conf };
  sb.put(".m5cet/install.conf", Object.entries(conf).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", 0o600);
  const env = { NODE_ENV: "production", HOST: "127.0.0.1", PORT: conf.APP_PORT, ...o.env };
  sb.put(".env", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", o.envMode ?? 0o600);
}

let sb: Sandbox;
beforeEach(() => { sb = new Sandbox(); });
afterEach(() => { sb.cleanup(); });

// =============================================================================

describe("the script", () => {
  it("parses (bash -n) and is executable", () => {
    expect(spawnSync(BASH, ["-n", CHECK]).status).toBe(0);
    expect(spawnSync(BASH, ["-n", join(REPO, "installer/lib/check-hook.sh")]).status).toBe(0);
  });

  it("is shellcheck-clean (when shellcheck is installed)", () => {
    const sc = which("shellcheck");
    if (!sc) return;
    const r = spawnSync(sc, ["-x", "-S", "warning", "check.sh", "installer/lib/check-hook.sh"], { cwd: REPO, encoding: "utf8" });
    expect(r.status, r.stdout).toBe(0);
  });

  it("usage: --help 0, bad option / section / language / root 2", () => {
    const help = sb.run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--json");
    expect(sb.run(["--frobnicate"]).status).toBe(2);
    expect(sb.run(["--only", "kernel,bogus"]).status).toBe(2);
    expect(sb.run(["--lang", "de"]).status).toBe(2);
    expect(spawnSync(BASH, [CHECK, "--root", join(sb.dir, "nope")], { encoding: "utf8" }).status).toBe(2);
  });

  it("--json is valid, its counts add up, --report writes the same report, exit 0 without FAIL", () => {
    sysroot(sb);
    const report = join(sb.dir, "report.json");
    const r = sb.run(["--only", "kernel", "--json", "--report", report]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as Report;
    expect(j.exit).toBe(0);
    const count = (s: string) => j.checks.filter((c) => c.status === s).length;
    expect(j.summary).toEqual({ pass: count("PASS"), warn: count("WARN"), fail: count("FAIL"), skip: count("SKIP") });
    expect(j.checks.every((c) => c.section === "kernel" && /^kernel\./.test(c.id))).toBe(true);
    const file = JSON.parse(readFileSync(report, "utf8")) as Report;
    expect(file.checks).toEqual(j.checks);
    // one check per line: update.sh greps it
    expect(readFileSync(report, "utf8")).toMatch(/^\{"section":"kernel","id":"kernel\.syncookies","status":"PASS",/m);
  });

  it("text output: sections, statuses, the summary; --quiet prints only WARN/FAIL; --lang en", () => {
    sysroot(sb, { "net/ipv4/tcp_syncookies": "0" });
    const r = sb.run(["--only", "kernel"]);
    expect(r.stdout).toContain("== Jádro (sysctl) (kernel) ==");
    expect(r.stdout).toMatch(/^ {2}PASS {2}net\.core\.somaxconn = 4096$/m);
    expect(r.stdout).toMatch(/^ {2}WARN {2}net\.ipv4\.tcp_syncookies = 0/m);
    expect(r.stdout).toContain("→ sysctl -w net.ipv4.tcp_syncookies=1");
    expect(r.stdout).toMatch(/Souhrn: \d+ PASS, 1 WARN, 0 FAIL/);
    const q = sb.run(["--only", "kernel", "--quiet"]);
    expect(q.stdout).not.toMatch(/^ {2}PASS/m);
    expect(q.stdout).toMatch(/^ {2}WARN/m);
    expect(sb.run(["--only", "kernel", "--lang", "en"]).stdout).toMatch(/Summary: \d+ PASS/);
  });

  it("exit 1 when something FAILs", () => {
    sysroot(sb);
    install(sb, { envMode: 0o644 });
    const r = sb.run(["--only", "config"]);
    expect(r.status).toBe(1);
  });
});

// =============================================================================

describe("kernel", () => {
  it("a hardened host passes", () => {
    sysroot(sb);
    const r = sb.json(["--only", "kernel"]);
    expect(ids(r, "WARN")).toEqual([]);
    expect(ids(r, "FAIL")).toEqual([]);
    expect(st(r, "kernel.syncookies")).toBe("PASS");
    expect(st(r, "kernel.userns")).toBe("PASS");
  });

  it("flags settings that matter for a public WebSocket / WebRTC server", () => {
    sysroot(sb, {
      "net/ipv4/tcp_syncookies": "0", "net/core/somaxconn": "128", "vm/overcommit_memory": "2", "user/max_user_namespaces": "0",
      "net/ipv4/ip_forward": "1", "net/ipv4/conf/all/rp_filter": "0", "kernel/kptr_restrict": "0", "net/ipv4/ip_local_port_range": "60000\t61000",
      "kernel/yama/ptrace_scope": null,
    });
    const r = sb.json(["--only", "kernel"]);
    for (const id of ["kernel.syncookies", "kernel.somaxconn", "kernel.overcommit", "kernel.userns", "kernel.ip_forward", "kernel.rp_filter", "kernel.kptr_restrict", "kernel.port_range"]) {
      expect(st(r, id), id).toBe("WARN");
    }
    expect(st(r, "kernel.ptrace")).toBe("SKIP");
    expect(r.exit).toBe(0);
  });

  it("Ubuntu's AppArmor userns restriction is reported", () => {
    sysroot(sb, { "kernel/apparmor_restrict_unprivileged_userns": "1" });
    expect(msg(sb.json(["--only", "kernel"]), "kernel.userns")).toContain("AppArmor");
  });

  it("is skipped off Linux", () => {
    const r = sb.json(["--only", "kernel"]);
    expect(st(r, "kernel.linux")).toBe("SKIP");
  });
});

// =============================================================================

describe("config", () => {
  it("never prints a secret from .env (text, quiet, JSON)", () => {
    sysroot(sb);
    install(sb, {
      conf: { ENABLE_ADMIN: "1" },
      env: {
        ENABLE_ADMIN: "1", ADMIN_BIND: "127.0.0.1", ADMIN_API_TOKEN: SECRET_TOKEN, TURN_SERVER_URL: "turn:turn.example.com:3478",
        TURN_USERNAME: "u", TURN_CREDENTIAL: SECRETS[1], VAPID_PUBLIC_KEY: "BPub", VAPID_PRIVATE_KEY: SECRETS[2],
        REDIS_URL: `redis://user:${SECRETS[3]}@127.0.0.1:6379`, DATABASE_URL: `postgres://m5:${SECRETS[4]}@db/m5`,
      },
    });
    const outs = [sb.run([]).stdout, sb.run(["--quiet"]).stdout, sb.run(["--json"]).stdout, sb.run(["--lang", "en"]).stdout];
    for (const out of outs) for (const s of SECRETS) expect(out).not.toContain(s);
    // every section together still prints nothing but the report on stdout
    const all = JSON.parse(outs[2]) as Report;
    expect(new Set(all.checks.map((c) => c.section))).toEqual(new Set(["package", "config", "runtime", "http", "firewall", "kernel", "network", "system", "docker", "security"]));
    const j = sb.json(["--only", "config"]);
    expect(st(j, "config.admin_token")).toBe("PASS");
    expect(msg(j, "config.admin_token")).toContain(`${SECRET_TOKEN.length}`);
    expect(msg(j, "config.cluster")).toContain("redis://***@127.0.0.1:6379");
  });

  it(".env readable by others FAILs; 0600 passes", () => {
    sysroot(sb);
    install(sb, { envMode: 0o644 });
    expect(st(sb.json(["--only", "config"]), "config.env")).toBe("FAIL");
    chmodSync(join(sb.root, ".env"), 0o600);
    expect(st(sb.json(["--only", "config"]), "config.env")).toBe("PASS");
  });

  it("systemd install: a .env the service user cannot read FAILs (the app loads ./.env itself)", () => {
    sysroot(sb);
    install(sb, { conf: { SERVICE_MANAGER: "systemd", SCOPE: "system" } });
    const r = sb.json(["--only", "config"]);
    expect(st(r, "config.env")).toBe("FAIL");
    expect(msg(r, "config.env")).toContain("EACCES");
  });

  it("weak or short admin token, a public ADMIN_BIND, NODE_ENV=development", () => {
    sysroot(sb);
    install(sb, { conf: { ENABLE_ADMIN: "1", SERVICE_MANAGER: "systemd" }, env: { ENABLE_ADMIN: "1", ADMIN_API_TOKEN: "a".repeat(40), ADMIN_BIND: "0.0.0.0", NODE_ENV: "development" } });
    let r = sb.json(["--only", "config"]);
    expect(st(r, "config.admin_token")).toBe("FAIL");
    expect(st(r, "config.admin_bind")).toBe("FAIL");
    expect(st(r, "config.node_env")).toBe("FAIL");
    install(sb, { conf: { ENABLE_ADMIN: "1" }, env: { ENABLE_ADMIN: "1", ADMIN_API_TOKEN: "Ab3".repeat(4) } });
    r = sb.json(["--only", "config"]);
    expect(st(r, "config.admin_token")).toBe("FAIL");
    expect(msg(r, "config.admin_token")).toContain("12");
  });

  it("PUBLIC_BASE_URL must be https; passkey origins must fit the RP ID", () => {
    sysroot(sb);
    install(sb, { conf: { DOMAIN: "chat.example.com" }, env: { PUBLIC_BASE_URL: "http://chat.example.com" } });
    expect(st(sb.json(["--only", "config"]), "config.public_url")).toBe("FAIL");
    install(sb, { conf: { DOMAIN: "chat.example.com" }, env: { PUBLIC_BASE_URL: "https://chat.example.com", WEBAUTHN_RP_ID: "example.org" } });
    let r = sb.json(["--only", "config"]);
    expect(st(r, "config.public_url")).toBe("PASS");
    expect(st(r, "config.webauthn")).toBe("FAIL");
    install(sb, { conf: { DOMAIN: "chat.example.com" }, env: { PUBLIC_BASE_URL: "https://chat.example.com", WEBAUTHN_RP_ID: "example.com", WEBAUTHN_ORIGINS: "https://chat.example.com,https://example.com" } });
    r = sb.json(["--only", "config"]);
    expect(st(r, "config.webauthn")).toBe("PASS");
  });

  it("telephony without signature keys or with TELEPHONY_ALLOW_UNSIGNED FAILs", () => {
    sysroot(sb);
    install(sb, { env: { ENABLE_TELEPHONY: "1", PUBLIC_BASE_URL: "https://chat.example.com", TELNYX_API_KEY: "k", TELEPHONY_ALLOW_UNSIGNED: "1" } });
    const r = sb.json(["--only", "config"]);
    expect(st(r, "config.telephony")).toBe("FAIL");
    expect(msg(r, "config.telephony")).toContain("TELEPHONY_ALLOW_UNSIGNED=1");
    expect(msg(r, "config.telephony")).toContain("TELNYX_PUBLIC_KEY");
    install(sb, { env: { ENABLE_TELEPHONY: "1", PUBLIC_BASE_URL: "https://chat.example.com", TELNYX_API_KEY: "k", TELNYX_PUBLIC_KEY: "pk" } });
    expect(st(sb.json(["--only", "config"]), "config.telephony")).toBe("PASS");
  });

  it("room proof, sandbox isolation, full IPs, TRUST_PROXY=true, static TURN, duplicate keys", () => {
    sysroot(sb);
    install(sb, { env: { FUNCTIONS_SANDBOX_ISOLATION: "none", ACCESS_LOG_FULL_IP: "1", TRUST_PROXY: "true", TURN_SERVER_URL: "turn:t:3478", TURN_CREDENTIAL: "x" } });
    sb.put(".env", readFileSync(join(sb.root, ".env"), "utf8") + "LOG_EVENTS=1\nLOG_EVENTS=0\n", 0o600);
    let r = sb.json(["--only", "config"]);
    for (const id of ["config.room_proof", "config.sandbox", "config.access_log", "config.trust_proxy", "config.turn", "config.env_dups"]) expect(st(r, id), id).toBe("WARN");
    install(sb, { env: { HUB_REQUIRE_ROOM_PROOF: "1", TURN_SERVER_URL: "turn:t:3478", TURN_SECRET: "s" } });
    r = sb.json(["--only", "config"]);
    expect(st(r, "config.room_proof")).toBe("PASS");
    expect(st(r, "config.turn")).toBe("PASS");
  });

  it("key files, data directory and secret copies", () => {
    sysroot(sb);
    install(sb);
    sb.put(".m5cet/storage/storage.key", "k".repeat(64), 0o644);
    chmodSync(join(sb.root, ".m5cet", "storage"), 0o700);
    sb.put(".env-bak", "ADMIN_API_TOKEN=x\n", 0o644);
    chmodSync(sb.root, 0o750);
    let r = sb.json(["--only", "config"]);
    expect(st(r, "config.keys")).toBe("FAIL");
    expect(st(r, "config.stale_copies")).toBe("WARN");
    expect(st(r, "config.secret_files")).toBe("WARN"); // the install root itself is 0700
    chmodSync(sb.root, 0o755);
    r = sb.json(["--only", "config"]);
    expect(st(r, "config.secret_files")).toBe("FAIL");
    chmodSync(join(sb.root, ".m5cet/storage/storage.key"), 0o600);
    chmodSync(join(sb.root, ".env-bak"), 0o600);
    r = sb.json(["--only", "config"]);
    expect(st(r, "config.keys")).toBe("PASS");
    expect(st(r, "config.secret_files")).toBe("PASS");
    sb.put("server/world.ts", "x", 0o666);
    expect(st(sb.json(["--only", "config"]), "config.world_writable")).toBe("FAIL");
  });
});

// =============================================================================

describe("package", () => {
  function releaseTree(): void {
    install(sb);
    sb.put("server/index.ts", "export {};\n");
    sb.put("install.sh", "#!/bin/sh\n", 0o755);
    sb.put("installer/lib/core.sh", "# core\n");
  }
  const manifest = () => writeFileSync(join(sb.root, "release.json"), serialize(buildReleaseManifest(sb.root, { walk: true, commit: "a".repeat(40) })));

  it("an untouched release verifies; unsigned is a WARN", () => {
    releaseTree();
    manifest();
    const r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("PASS");
    expect(msg(r, "package.integrity")).toMatch(/všech \d+ souborů/);
    expect(st(r, "package.signature")).toBe("WARN");
  });

  it("a modified, a missing and an extra executable file FAIL; an extra plain file WARNs", () => {
    releaseTree();
    manifest();
    sb.put("server/index.ts", "export {}; // changed\n");
    let r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("FAIL");
    expect(msg(r, "package.integrity")).toContain("server/index.ts");
    manifest();
    rmSync(join(sb.root, "installer/lib/core.sh"));
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("FAIL");
    expect(msg(r, "package.integrity")).toContain("installer/lib/core.sh");
    manifest();
    sb.put("server/notes.txt", "x\n");
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("PASS");
    expect(st(r, "package.extra")).toBe("WARN");
    sb.put("scripts/dropper.sh", "#!/bin/sh\n", 0o755);
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("FAIL");
    expect(msg(r, "package.integrity")).toContain("scripts/dropper.sh");
    // excluded paths are never extra
    rmSync(join(sb.root, "scripts"), { recursive: true });
    sb.put("node_modules/x/run.sh", "#!/bin/sh\n", 0o755);
    sb.put("dist/index.cjs", "x");
    expect(st(sb.json(["--only", "package"]), "package.integrity")).toBe("PASS");
  });

  it("a manifest of another version FAILs as stale", () => {
    releaseTree();
    manifest();
    sb.put("package.json", JSON.stringify({ name: "cipherroom-secure-chat", version: "6.13.0" }) + "\n");
    const r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("FAIL");
    expect(msg(r, "package.integrity")).toContain("6.12.0");
  });

  const signedTree = () => {
    releaseTree();
    const keys = generateKeys();
    sb.put("release-signing.pub", `${keys.publicB64}\n`);
    manifest();
    writeFileSync(join(sb.root, "release.json.sig"), `${signBytes(readFileSync(join(sb.root, "release.json")), keys.privatePem)}\n`);
    return keys;
  };

  for (const via of ["openssl", "node"] as const) {
    it(`signature valid / invalid / key changed (verified with ${via})`, () => {
      if (via === "openssl" && !OPENSSL) return;
      const absent = via === "openssl" ? ["node"] : ["openssl"];
      signedTree();
      let r = sb.json(["--only", "package"], { absent });
      expect(st(r, "package.signature"), msg(r, "package.signature")).toBe("PASS");
      expect(msg(r, "package.signature")).toContain("ze stejného stromu");
      // a pinned key that differs from the tree's → the release was re-signed by someone else
      sb.put(".m5cet/release-signing.pub", `${generateKeys().publicB64}\n`);
      r = sb.json(["--only", "package"], { absent });
      expect(st(r, "package.signature")).toBe("FAIL");
      rmSync(join(sb.root, ".m5cet/release-signing.pub"));
      // the manifest changed after signing
      const text = readFileSync(join(sb.root, "release.json"), "utf8");
      writeFileSync(join(sb.root, "release.json"), text.replace(`"commit": "${"a".repeat(40)}"`, `"commit": "${"b".repeat(40)}"`));
      r = sb.json(["--only", "package"], { absent });
      expect(st(r, "package.signature")).toBe("FAIL");
      expect(msg(r, "package.signature")).toContain("NEPLATNÝ");
    });
  }

  it("--pubkey overrides the tree's key", () => {
    signedTree();
    const other = sb.put("other.pub", `${generateKeys().publicB64}\n`, undefined, sb.dir);
    expect(st(sb.json(["--only", "package", "--pubkey", other]), "package.signature")).toBe("FAIL");
  });

  it("served web assets against dist/public/release-web.json", () => {
    install(sb);
    sb.put("dist/public/index.html", "<!doctype html>\n");
    sb.put("dist/public/assets/app.js", "console.log(1)\n");
    sb.put("dist/public/build.json", JSON.stringify({ version: "6.12.0" }) + "\n");
    let r = sb.json(["--only", "package"]);
    expect(st(r, "package.web")).toBe("WARN");
    writeFileSync(join(sb.root, "dist/public/release-web.json"), serialize(buildWebManifest(join(sb.root, "dist/public"), { commit: "c".repeat(40), version: "6.12.0" })));
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.web")).toBe("PASS");
    sb.put("dist/public/x.js", "steal()\n");
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.web")).toBe("FAIL");
    expect(msg(r, "package.web")).toContain("x.js");
    rmSync(join(sb.root, "dist/public/x.js"));
    sb.put("dist/public/assets/app.js", "console.log(2)\n");
    expect(st(sb.json(["--only", "package"]), "package.web")).toBe("FAIL");
  });

  it("an installed native tree without dist FAILs; a build of another version WARNs", () => {
    install(sb);
    let r = sb.json(["--only", "package"]);
    expect(st(r, "package.build")).toBe("FAIL");
    for (const f of ["dist/index.cjs", "dist/sandbox.cjs", "dist/public/index.html"]) sb.put(f, "x");
    sb.put("dist/public/build.json", JSON.stringify({ version: "6.11.0" }) + "\n");
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.build")).toBe("PASS");
    expect(st(r, "package.versions")).toBe("WARN");
    expect(st(r, "package.pyodide")).toBe("WARN");
  });

  it("a git checkout without release.json: local changes and untracked executables FAIL", () => {
    sb.real("git");
    if (!sb.stubbed.has("git")) return;
    releaseTree();
    const git = (...a: string[]) => execFileSync("git", ["-C", sb.root, "-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" });
    sb.put(".gitignore", ".env\n.m5cet/\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    let r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity"), msg(r, "package.integrity")).toBe("PASS");
    expect(st(r, "package.signature")).toBe("WARN");
    sb.put("server/index.ts", "export const x = 1;\n");
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("FAIL");
    git("checkout", "--", "server/index.ts");
    sb.put("hook.sh", "#!/bin/sh\n", 0o755);
    r = sb.json(["--only", "package"]);
    expect(st(r, "package.integrity")).toBe("FAIL");
    expect(msg(r, "package.integrity")).toContain("hook.sh");
  });
});

// =============================================================================

describe("runtime", () => {
  const SHOW = (o: Record<string, string> = {}) => Object.entries({
    LoadState: "loaded", ActiveState: "active", SubState: "running", UnitFileState: "enabled", User: "m5cet", NoNewPrivileges: "yes",
    ProtectSystem: "strict", ProtectHome: "yes", PrivateTmp: "yes", CapabilityBoundingSet: "", RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
    MemoryDenyWriteExecute: "no", LimitNOFILE: "524288", RestrictNamespaces: "yes", MainPID: "4242",
    ExecStart: "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/m5cet/dist/index.cjs ; }", ...o,
  }).map(([k, v]) => `${k}=${v}`).join("\n");

  it("systemd: hardening as the installer writes it passes", () => {
    sysroot(sb);
    install(sb, { conf: { SERVICE_MANAGER: "systemd", SCOPE: "system" } });
    sb.stub("systemctl", `[ "$1" = show ] && { cat <<'EOF'\n${SHOW()}\nEOF\nexit 0; }\nexit 3`);
    const r = sb.json(["--only", "runtime"]);
    expect(st(r, "runtime.service")).toBe("PASS");
    expect(st(r, "runtime.service_hardening")).toBe("PASS");
    expect(st(r, "runtime.node")).toBe("PASS");
  });

  it("systemd: root, MemoryDenyWriteExecute, weak hardening, a stopped unit", () => {
    sysroot(sb);
    install(sb, { conf: { SERVICE_MANAGER: "systemd", SCOPE: "system" } });
    sb.stub("systemctl", `[ "$1" = show ] && { cat <<'EOF'\n${SHOW({ User: "", MemoryDenyWriteExecute: "yes", NoNewPrivileges: "no", LimitNOFILE: "1024", ActiveState: "failed", UnitFileState: "disabled" })}\nEOF\nexit 0; }\nexit 3`);
    const r = sb.json(["--only", "runtime"]);
    expect(st(r, "runtime.service")).toBe("FAIL");
    expect(st(r, "runtime.service_user")).toBe("FAIL");
    expect(st(r, "runtime.service_mdwe")).toBe("FAIL");
    expect(st(r, "runtime.service_hardening")).toBe("WARN");
    expect(msg(r, "runtime.service_hardening")).toContain("LimitNOFILE=1024");
    expect(st(r, "runtime.service_enabled")).toBe("WARN");
    expect(st(r, "runtime.ports")).toBe("SKIP");
  });

  it("process manager: a live pid passes, ports come from ss, a public admin port FAILs", () => {
    sysroot(sb);
    install(sb, { conf: { ENABLE_ADMIN: "1" }, env: { ENABLE_ADMIN: "1", ADMIN_API_TOKEN: SECRET_TOKEN } });
    // What the process manager starts: `node dist/index.cjs` / `node dist/admin.cjs` in the tree.
    const app = startApp(sb, "index.cjs");
    const admin = startApp(sb, "admin.cjs");
    try {
      sb.put(".m5cet/run/app.pid", `${app.pid}\n`);
      sb.put(".m5cet/run/admin.pid", `${admin.pid}\n`);
      sb.stub("ss", `cat <<'EOF'
Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      511        127.0.0.1:5190      0.0.0.0:*
tcp   LISTEN 0      511          0.0.0.0:5191      0.0.0.0:*
EOF`);
      const r = sb.json(["--only", "runtime"]);
      expect(st(r, "runtime.service"), msg(r, "runtime.service")).toBe("PASS");
      expect(st(r, "runtime.admin"), msg(r, "runtime.admin")).toBe("PASS");
      expect(st(r, "runtime.ports")).toBe("PASS");
      expect(st(r, "runtime.admin_port")).toBe("FAIL");
      expect(st(r, "runtime.health")).toBe("SKIP"); // no curl
    } finally {
      app.kill("SIGKILL");
      admin.kill("SIGKILL");
    }
  });

  it("process manager: a pid file naming another process (stale or forged) is not the service (C11)", () => {
    sysroot(sb);
    install(sb);
    sb.put(".m5cet/run/app.pid", `${process.pid}\n`); // a live node process, but not dist/index.cjs
    const r = sb.json(["--only", "runtime"]);
    expect(st(r, "runtime.service")).toBe("FAIL");
    expect(msg(r, "runtime.service")).toContain(`${process.pid}`);
    expect(msg(r, "runtime.service")).toContain("dist/index.cjs");
    expect(st(r, "runtime.ports")).toBe("SKIP");
    sb.put(".m5cet/run/app.pid", "0\n"); // kill -0 0 would signal the process group
    expect(st(sb.json(["--only", "runtime"]), "runtime.service")).toBe("FAIL");
  });

  it("process manager: not running → FAIL, probes skipped; no node → FAIL", () => {
    sysroot(sb);
    install(sb);
    const r = sb.json(["--only", "runtime"], { absent: ["node"] });
    expect(st(r, "runtime.service")).toBe("FAIL");
    expect(st(r, "runtime.ports")).toBe("SKIP");
    expect(st(r, "runtime.node")).toBe("FAIL");
  });
});

// =============================================================================

describe("http (real nginx -T output)", () => {
  function nginx(fixture: string, certDays = 365): void {
    let certDir = "/etc/m5test";
    if (OPENSSL) {
      certDir = join(sb.dir, "certs");
      mkdirSync(certDir, { recursive: true });
      execFileSync(OPENSSL, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(certDir, "privkey.pem"),
        "-out", join(certDir, "fullchain.pem"), "-days", String(certDays), "-subj", "/CN=chat.example.com",
        "-addext", "subjectAltName=DNS:chat.example.com,DNS:chat.example.org"], { stdio: "pipe" });
    }
    const dump = readFileSync(join(FIX, fixture), "utf8").split("/etc/m5test/").join(`${certDir}/`);
    writeFileSync(join(sb.dir, "nginx-T.txt"), dump);
    sb.stub("nginx", `case "$1" in
  -v) echo "nginx version: nginx/1.31.6" >&2 ;;
  -T) cat "${join(sb.dir, "nginx-T.txt")}"; echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2 ;;
esac
exit 0`);
    sb.stub("ss", `cat <<'EOF'
Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      511          0.0.0.0:443       0.0.0.0:*    users:(("nginx",pid=10,fd=6))
tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=10,fd=7))
tcp   LISTEN 0      511        127.0.0.1:5000      0.0.0.0:*    users:(("node",pid=20,fd=20))
EOF`);
  }
  const site = (domain: string, env: Record<string, string> = {}) => install(sb, { conf: { SCOPE: "system", SERVICE_MANAGER: "systemd", APP_PORT: "5000", DOMAIN: domain, ENABLE_NGINX: "auto", NGINX_SITE_PATH: "/etc/nginx/sites-available/m5cet.conf" }, env });

  it("the installer's site after certbot: TLS, redirect, WebSocket, SSE pass; the 2m body limit WARNs", () => {
    site("chat.example.com", { ENABLE_TELEPHONY: "1", APNS_TEAM_ID: "ABCDE12345" });
    nginx("nginx-T-installer-certbot.txt");
    const r = sb.json(["--only", "http"], { uid: 0 });
    expect(ids(r, "FAIL")).toEqual([]);
    for (const id of ["http.nginx", "http.server", "http.tls_protocols", "http.tls_ciphers", "http.redirect", "http.websocket", "http.media_tel", "http.sse", "http.webhooks", "http.assetlinks", "http.aasa", "http.headers", "http.forwarded", "http.ws_limits"]) {
      expect(st(r, id), `${id}: ${msg(r, id)}`).toBe("PASS");
    }
    expect(st(r, "http.body_size")).toBe("WARN");
    expect(msg(r, "http.body_size")).toContain("/api/storage(2m<12m)");
    expect(st(r, "http.server_tokens")).toBe("WARN");
    if (OPENSSL) {
      expect(st(r, "http.cert")).toBe("PASS");
      expect(st(r, "http.cert_name")).toBe("PASS");
      expect(st(r, "http.ocsp")).toBe("PASS");
    }
  });

  it("the reference deploy/nginx/m5cet.conf passes the proxy checks", () => {
    site("chat.example.org");
    nginx("nginx-T-reference.txt");
    const r = sb.json(["--only", "http"], { uid: 0 });
    expect(ids(r, "FAIL")).toEqual([]);
    for (const id of ["http.tls_protocols", "http.redirect", "http.websocket", "http.sse", "http.body_size", "http.assetlinks", "http.headers", "http.forwarded"]) {
      expect(st(r, id), `${id}: ${msg(r, id)}`).toBe("PASS");
    }
    expect(st(r, "http.admin_paths")).toBe("WARN");
    expect(msg(r, "http.websocket")).toContain("= /ws");
    expect(st(r, "http.aasa"), "no APNS_TEAM_ID: nothing to serve, nothing checked").toBe("(none)");
  });

  it("a hosting-panel site: no WebSocket upgrade, dot-paths denied, doubled headers, weak TLS…", () => {
    site("chat.example.com", { APNS_TEAM_ID: "ABCDE12345" });
    nginx("nginx-T-panel.txt");
    const r = sb.json(["--only", "http"], { uid: 0 });
    expect(st(r, "http.websocket")).toBe("FAIL");
    expect(r.exit).toBe(1);
    for (const id of ["http.tls_protocols", "http.tls_ciphers", "http.redirect", "http.sse", "http.body_size", "http.assetlinks", "http.aasa", "http.headers", "http.gzip", "http.forwarded", "http.ws_limits", "http.server_tokens"]) {
      expect(st(r, id), `${id}: ${msg(r, id)}`).toBe("WARN");
    }
    expect(msg(r, "http.assetlinks")).toContain("~ /\\.");
    expect(msg(r, "http.headers")).toContain("Strict-Transport-Security");
  });

  it("a certificate that expires within 14 days WARNs", () => {
    if (!OPENSSL) return;
    site("chat.example.com");
    nginx("nginx-T-installer-certbot.txt", 5);
    expect(st(sb.json(["--only", "http"], { uid: 0 }), "http.cert")).toBe("WARN");
  });

  it("nginx -T without root is skipped, not failed", () => {
    site("chat.example.com");
    nginx("nginx-T-installer-certbot.txt");
    sb.stub("nginx", `case "$1" in -v) echo "nginx version: nginx/1.31.6" >&2 ;; -T) echo 'nginx: [emerg] cannot load certificate key "/etc/letsencrypt/live/x/privkey.pem": BIO_new_file() failed (SSL: error:8000000D:system library::Permission denied' >&2; exit 1 ;; esac`);
    const r = sb.json(["--only", "http"], { uid: 1000 });
    expect(st(r, "http.nginx")).toBe("SKIP");
  });

  it("a domain with nothing on 80/443 FAILs", () => {
    site("chat.example.com");
    sb.stub("ss", "exit 0");
    const r = sb.json(["--only", "http"], { uid: 0 });
    expect(st(r, "http.listen")).toBe("FAIL");
  });
});

// =============================================================================

describe("firewall", () => {
  const UFW_OK = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     LIMIT IN    Anywhere
80,443/tcp                 ALLOW IN    Anywhere
3478                       ALLOW IN    Anywhere
22/tcp (v6)                LIMIT IN    Anywhere (v6)
80,443/tcp (v6)            ALLOW IN    Anywhere (v6)`;
  const ss = (lines: string) => sb.stub("ss", `cat <<'EOF'\nNetid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n${lines}\nEOF`);

  it("ufw: default deny, web ports open, SSH rate-limited, app on loopback", () => {
    sysroot(sb);
    install(sb, { conf: { DOMAIN: "chat.example.com", SCOPE: "system" } });
    sb.stub("ufw", `cat <<'EOF'\n${UFW_OK}\nEOF`);
    ss("tcp LISTEN 0 511 127.0.0.1:5190 0.0.0.0:*\ntcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\ntcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:*");
    const r = sb.json(["--only", "firewall"], { uid: 0 });
    expect(ids(r, "FAIL")).toEqual([]);
    expect(st(r, "firewall.active")).toBe("PASS");
    expect(st(r, "firewall.policy")).toBe("PASS");
    expect(st(r, "firewall.web")).toBe("PASS");
    expect(st(r, "firewall.ssh")).toBe("PASS");
    expect(st(r, "firewall.app_port")).toBe("PASS");
  });

  it("ufw default allow FAILs; a public admin port the firewall lets through FAILs; open SSH WARNs", () => {
    sysroot(sb);
    install(sb, { conf: { DOMAIN: "chat.example.com", SCOPE: "system", ENABLE_ADMIN: "1" }, env: { ENABLE_ADMIN: "1" } });
    sb.stub("ufw", `cat <<'EOF'\n${UFW_OK.replace("Default: deny (incoming)", "Default: allow (incoming)").replace(/LIMIT IN/g, "ALLOW IN")}\n5191/tcp                   ALLOW IN    Anywhere\nEOF`);
    ss("tcp LISTEN 0 511 127.0.0.1:5190 0.0.0.0:*\ntcp LISTEN 0 511 0.0.0.0:5191 0.0.0.0:*\ntcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*");
    const r = sb.json(["--only", "firewall"], { uid: 0 });
    expect(st(r, "firewall.policy")).toBe("FAIL");
    expect(st(r, "firewall.admin_port")).toBe("FAIL");
    expect(st(r, "firewall.ssh")).toBe("WARN");
  });

  it("TURN relay ports must be open when coturn runs here", () => {
    sysroot(sb, {}, { "etc/turnserver.conf": "listening-port=3478\nmin-port=49160\nmax-port=49200\n" });
    install(sb, { conf: { SCOPE: "system" } });
    sb.stub("ufw", `cat <<'EOF'\n${UFW_OK}\nEOF`);
    ss("udp UNCONN 0 0 0.0.0.0:3478 0.0.0.0:*");
    let r = sb.json(["--only", "firewall"], { uid: 0 });
    expect(st(r, "firewall.turn")).toBe("WARN");
    expect(msg(r, "firewall.turn")).toContain("49160-49200/udp");
    sb.stub("ufw", `cat <<'EOF'\n${UFW_OK}\n49160:49200/udp            ALLOW IN    Anywhere\nEOF`);
    r = sb.json(["--only", "firewall"], { uid: 0 });
    expect(st(r, "firewall.turn")).toBe("PASS");
  });

  it("nftables accept policy WARNs; iptables drop policy with 443 open passes", () => {
    sysroot(sb);
    install(sb, { conf: { DOMAIN: "chat.example.com", SCOPE: "system" } });
    sb.stub("nft", `[ "$1" = list ] && cat <<'EOF'
table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
		tcp dport { 80, 443 } accept
	}
}
EOF`);
    let r = sb.json(["--only", "firewall"], { uid: 0 });
    expect(st(r, "firewall.active")).toBe("PASS");
    expect(st(r, "firewall.policy")).toBe("WARN");
    expect(st(r, "firewall.web")).toBe("PASS");
    sb.stubbed.delete("nft");
    sb.stub("iptables", `cat <<'EOF'
-P INPUT DROP
-P FORWARD DROP
-P OUTPUT ACCEPT
-A INPUT -i lo -j ACCEPT
-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
EOF`);
    r = sb.json(["--only", "firewall"], { uid: 0 });
    expect(st(r, "firewall.policy")).toBe("PASS");
    expect(st(r, "firewall.web")).toBe("PASS");
  });

  it("no firewall WARNs; without root it is skipped", () => {
    sysroot(sb);
    install(sb);
    expect(st(sb.json(["--only", "firewall"], { uid: 0 }), "firewall.active")).toBe("WARN");
    expect(st(sb.json(["--only", "firewall"], { uid: 1000 }), "firewall.active")).toBe("SKIP");
  });
});

// =============================================================================

describe("network", () => {
  it("time sync: chrony offset, timedatectl", () => {
    sysroot(sb);
    sb.stub("chronyc", "echo 'System time     : 45.123456 seconds slow of NTP time'");
    expect(st(sb.json(["--only", "network"]), "network.time")).toBe("FAIL");
    sb.stub("chronyc", "echo 'System time     : 0.000012345 seconds fast of NTP time'");
    expect(st(sb.json(["--only", "network"]), "network.time")).toBe("PASS");
    sb.stubbed.delete("chronyc");
    sb.stub("timedatectl", "echo no");
    expect(st(sb.json(["--only", "network"]), "network.time")).toBe("WARN");
  });

  it("accept-queue overflows and descriptor pressure WARN", () => {
    sysroot(sb, { "fs/file-nr": "900\t0\t1000" }, { "proc/net/netstat": "TcpExt: SyncookiesSent ListenOverflows ListenDrops\nTcpExt: 0 12 12\n" });
    const r = sb.json(["--only", "network"]);
    expect(st(r, "network.listen_overflows")).toBe("WARN");
    expect(st(r, "network.fds")).toBe("WARN");
  });

  it("DNS and outbound checks are skipped offline / without a domain", () => {
    sysroot(sb);
    const r = sb.json(["--only", "network"]);
    expect(st(r, "network.dns")).toBe("SKIP");
    expect(st(r, "network.outbound")).toBe("SKIP");
  });
});

// =============================================================================

describe("system", () => {
  it("OS support, kernel, memory, swap", () => {
    sysroot(sb, { "kernel/osrelease": "4.9.0-19-amd64" }, {
      "etc/os-release": 'PRETTY_NAME="Ubuntu 20.04.6 LTS"\nVERSION_ID="20.04"\nID=ubuntu\nID_LIKE=debian\n',
      "proc/meminfo": "MemTotal:  800000 kB\nMemAvailable: 500000 kB\nSwapTotal: 0 kB\n",
    });
    const r = sb.json(["--only", "system"]);
    expect(st(r, "system.os")).toBe("WARN");
    expect(st(r, "system.kernel")).toBe("FAIL");
    expect(st(r, "system.memory")).toBe("FAIL");
    expect(st(r, "system.swap")).toBe("WARN");
  });

  it("Debian 12 is supported, an interim Ubuntu WARNs", () => {
    sysroot(sb, {}, { "etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nVERSION_ID="12"\nID=debian\n' });
    expect(st(sb.json(["--only", "system"]), "system.os")).toBe("PASS");
    sysroot(sb, {}, { "etc/os-release": 'PRETTY_NAME="Ubuntu 25.10"\nVERSION_ID="25.10"\nID=ubuntu\n' });
    expect(st(sb.json(["--only", "system"]), "system.os")).toBe("WARN");
  });

  it("bubblewrap: missing (required → FAIL, default → WARN), AppArmor userns restriction, the unit's RestrictNamespaces", () => {
    sysroot(sb);
    install(sb, { env: { FUNCTIONS_SANDBOX_ISOLATION: "bwrap" } });
    expect(st(sb.json(["--only", "system"]), "system.bwrap")).toBe("FAIL");
    install(sb);
    expect(st(sb.json(["--only", "system"]), "system.bwrap")).toBe("WARN");
    sb.stub("bwrap", '[ "$1" = --version ] && { echo "bubblewrap 0.9.0"; exit 0; }\nexit 0');
    expect(st(sb.json(["--only", "system"]), "system.bwrap")).toBe("PASS");
    sysroot(sb, { "kernel/apparmor_restrict_unprivileged_userns": "1" });
    let r = sb.json(["--only", "system"]);
    expect(st(r, "system.bwrap")).toBe("WARN");
    expect(msg(r, "system.bwrap")).toContain("AppArmor");
    sb.put("etc/apparmor.d/bwrap", "abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n", undefined, sb.sys);
    expect(st(sb.json(["--only", "system"]), "system.bwrap")).toBe("PASS");
    install(sb, { conf: { SERVICE_MANAGER: "systemd", SCOPE: "system" } });
    sb.stub("systemctl", '[ "$1" = show ] && { echo "RestrictNamespaces=yes"; echo "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"; exit 0; }\nexit 3');
    r = sb.json(["--only", "system"]);
    expect(st(r, "system.bwrap")).toBe("WARN");
    expect(msg(r, "system.bwrap")).toContain("RestrictNamespaces");
  });

  it("the service user: no shell / no sudo passes; sudo or docker membership FAILs", () => {
    sysroot(sb);
    install(sb, { conf: { SERVICE_MANAGER: "systemd", SCOPE: "system" } });
    expect(st(sb.json(["--only", "system"]), "system.service_user")).toBe("PASS");
    sysroot(sb, {}, { "etc/group": "root:x:0:\nsudo:x:27:admin,m5cet\ndocker:x:998:m5cet\nm5cet:x:999:\n" });
    const r = sb.json(["--only", "system"]);
    expect(st(r, "system.service_user")).toBe("FAIL");
    expect(msg(r, "system.service_user")).toContain("docker");
  });

  it("security updates, pending reboot, noexec install directory", () => {
    sysroot(sb, {}, { "etc/apt/apt.conf.d/20auto-upgrades": 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n', "usr/bin/unattended-upgrade": "#!/bin/sh\n", "run/reboot-required": "*** System restart required ***\n" });
    install(sb);
    sb.put("dist/index.cjs", "x");
    sb.put("proc/mounts", `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${sb.root} ext4 rw,nosuid,noexec 0 0\n`, undefined, sb.sys);
    const r = sb.json(["--only", "system"]);
    expect(st(r, "system.updates")).toBe("PASS");
    expect(st(r, "system.reboot")).toBe("WARN");
    expect(st(r, "system.noexec")).toBe("FAIL");
  });
});

// =============================================================================

describe("docker", () => {
  it("privileged, root, all-interface ports, secrets in the image ENV FAIL", () => {
    sysroot(sb);
    install(sb, { conf: { INSTALL_MODE: "docker", SERVICE_MANAGER: "compose", BIND_ADDRESS: "127.0.0.1" } });
    sb.stub("docker", `case "$1" in
  info) echo 29.0.1 ;;
  inspect) echo 'running|healthy|true|false||json-file||[]|[]|m5cet:local' ;;
  port) echo '5000/tcp -> 0.0.0.0:5190' ;;
  image) echo '["PATH=/usr/local/bin","ADMIN_API_TOKEN=x","NODE_ENV=production"]' ;;
  exec) exit 0 ;;
esac`);
    const r = sb.json(["--only", "docker"], { uid: 0 });
    for (const id of ["docker.privileged", "docker.user", "docker.ports", "docker.image_env"]) expect(st(r, id), id).toBe("FAIL");
    expect(st(r, "docker.hardening")).toBe("WARN");
    expect(st(r, "docker.logs")).toBe("WARN");
    expect(msg(r, "docker.image_env")).toContain("ADMIN_API_TOKEN");
  });

  it("the generated compose service passes", () => {
    sysroot(sb);
    install(sb, { conf: { INSTALL_MODE: "docker", SERVICE_MANAGER: "compose" } });
    copyFileSync(join(REPO, "Dockerfile"), join(sb.root, "Dockerfile"));
    copyFileSync(join(REPO, ".dockerignore"), join(sb.root, ".dockerignore"));
    sb.stub("docker", `case "$1" in
  info) echo 29.0.1 ;;
  inspect) echo 'running|healthy|false|true|node|json-file|10m|["ALL"]|["no-new-privileges:true"]|m5cet:local' ;;
  port) echo '5000/tcp -> 127.0.0.1:5190' ;;
  image) echo '["PATH=/usr/local/bin","NODE_ENV=production"]' ;;
  exec) exit 0 ;;
esac`);
    const r = sb.json(["--only", "docker"], { uid: 0 });
    expect(ids(r, "FAIL")).toEqual([]);
    expect(ids(r, "WARN")).toEqual([]);
    expect(st(r, "docker.base_image")).toBe("PASS");
    expect(st(r, "docker.dockerignore")).toBe("PASS");
  });

  it("is skipped for a native install", () => {
    sysroot(sb);
    install(sb);
    expect(st(sb.json(["--only", "docker"]), "docker.mode")).toBe("SKIP");
  });
});

// =============================================================================

describe("installer hooks", () => {
  // Sources the installer libraries the way update.sh does and calls one hook.
  function hook(fn: string, env: Record<string, string> = {}): Run {
    const script = `set -u
for l in core ui config check-hook; do . "${REPO}/installer/lib/$l.sh"; done
INSTALL_DIR="${sb.root}"; SOURCE=git; SOURCE_PATH=""; M5_SCRIPT_DIR="${REPO}"; M5_LANG=en; NON_INTERACTIVE=1
${fn}
echo "rc=$?"`;
    const r = spawnSync(BASH, ["-c", script], {
      encoding: "utf8", timeout: 60_000,
      env: { PATH: `${sb.stubs}:${sb.tools}:/usr/bin:/bin`, HOME: sb.dir, TMPDIR: sb.dir, M5CHECK_ABSENT: HOST_TOOLS.join(" "), M5CHECK_UID: "1000", M5CHECK_OFFLINE: "1", ...env },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("install_check_tool pins the release key once", () => {
    install(sb);
    copyFileSync(CHECK, join(sb.root, "check.sh"));
    const { publicB64 } = generateKeys();
    sb.put("release-signing.pub", `${publicB64}\n`);
    let r = hook("install_check_tool");
    expect(r.stdout, r.stderr).toContain("rc=0");
    expect(readFileSync(join(sb.root, ".m5cet/release-signing.pub"), "utf8").trim()).toBe(publicB64);
    sb.put("release-signing.pub", `${generateKeys().publicB64}\n`);
    r = hook("install_check_tool");
    expect(readFileSync(join(sb.root, ".m5cet/release-signing.pub"), "utf8").trim()).toBe(publicB64);
  });

  it("post_update_check returns 1 only for a failed package integrity", () => {
    install(sb);
    copyFileSync(CHECK, join(sb.root, "check.sh"));
    chmodSync(join(sb.root, "check.sh"), 0o755);
    sb.put("server/index.ts", "export {};\n");
    writeFileSync(join(sb.root, "release.json"), serialize(buildReleaseManifest(sb.root, { walk: true, commit: "d".repeat(40) })));
    let r = hook("post_update_check");
    expect(r.stdout, r.stderr).toContain("rc=0");
    // a FAIL elsewhere (the service is not running) does not stop the update
    expect(r.stdout).toMatch(/FAIL/);
    sb.put("server/index.ts", "export const backdoor = 1;\n");
    r = hook("post_update_check");
    expect(r.stdout).toContain("rc=1");
    expect(r.stdout).toContain("server/index.ts");
  });
});
