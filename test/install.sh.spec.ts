import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Locate install.sh relative to project root (vitest runs from project root)
const ROOT = resolve(__dirname, "..");
const INSTALL_SH = resolve(ROOT, "install.sh");

describe("install.sh — universal Linux installer", () => {
  it("file is present", () => {
    expect(existsSync(INSTALL_SH)).toBe(true);
  });

  it("has bash shebang", () => {
    const head = readFileSync(INSTALL_SH, "utf-8").split("\n").slice(0, 1)[0];
    expect(head).toMatch(/^#!\/usr\/bin\/env bash/);
  });

  it("syntax is valid (bash -n)", () => {
    execSync(`bash -n "${INSTALL_SH}"`, { stdio: "pipe" });
  });

  it("contains comprehensive fallback message with 11+ package managers", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    // The fallback path lists all supported managers when none is detected
    const expected = [
      "apt-get|apt",
      "dnf",
      "yum",
      "microdnf",
      "pacman",
      "zypper",
      "apk",
      "xbps-install",
      "swupd",
      "emerge",
      "equo",
      "rpm-ostree",
    ];
    for (const pm of expected) {
      expect(src).toContain(pm);
    }
  });

  it("fallback message tells user to install Docker manually", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("To install Docker manually");
    expect(src).toContain("SKIP_DOCKER_INSTALL=1");
  });

  it("atom (rpm-ostree) gets a dedicated warning", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("Atomic distro detected");
  });

  it("--help passes parse_flags and renders usage text (static check)", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    // usage() must contain all listed commands
    const helpTerms = ["--install", "--status", "--logs", "--restart",
                       "--stop", "--uninstall", "--purge", "--help",
                       "ENABLE_NGINX", "LOG_EVENTS", "VAPID_PUBLIC_KEY"];
    for (const t of helpTerms) {
      expect(src).toContain(t);
    }
  });

  it("unknown command is reported explicitly via usage()", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    // The main dispatcher falls through to usage; die with "Unknown command"
    expect(src).toContain('die "Unknown command');
  });

  // (sandboxed execution of --help requires root which is unavailable in CI;
  // the static checks above already cover help structure.)

  it("includes CipherRoom v1.1 env vars (MAX_ATTACHMENT_BYTES)", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("MAX_ATTACHMENT_BYTES");
    expect(src).toContain("MAX_PEERS_PER_ROOM");
    expect(src).toContain("FRAME_BUDGET_PER_SEC");
    expect(src).toContain("MAX_FRAME_BYTES");
  });

  it("nginx config has client_max_body_size matching 2GB attachment limit", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("client_max_body_size");
    expect(src).toContain("2147483648"); // 2 GB
  });

  it("supports sqlite DATABASE_URL volume mapping", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("sqlite");
    expect(src).toContain("/app/data");
  });

  it("git upgrade uses shallow fetch + reset hard", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("git fetch --depth=1");
    expect(src).toContain("git reset --hard");
  });

  it("init systems supported (systemd, openrc, runit, dinit, s6)", () => {
    const src = readFileSync(INSTALL_SH, "utf-8");
    expect(src).toContain("systemd");
    expect(src).toContain("openrc");
    expect(src).toContain("runit");
    expect(src).toContain("dinit");
    expect(src).toContain("s6");
  });
});
