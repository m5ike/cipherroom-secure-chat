// The native PC/SC module's prebuilt binaries for the targets of a build (6.13.1).
//
// pcsc-mini ships one optional package per platform; npm installs only the one
// of the machine it runs on. A universal macOS app needs both macOS ones, and a
// Windows build (also built on a Mac) the "-electron" variants. This puts the
// missing packages into desktop/node_modules — the exact versions and
// sha512 integrities of desktop/package-lock.json (`npm pack`, checked, then
// unpacked). Nothing is taken that the lockfile does not pin. The macOS
// binaries are then made signable (macho-signable.mjs): codesign would
// otherwise overwrite the start of the x86_64 one's code.
//
//   node desktop/scripts/pcsc-prebuilds.mjs --mac --win     (build.mjs calls it)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSignable } from "./macho-signable.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The prebuilt packages each target needs. */
export const PCSC_PREBUILDS = {
  mac: ["@pcsc-mini/macos-aarch64", "@pcsc-mini/macos-x86_64"],
  win: ["@pcsc-mini/windows-x86_64-electron", "@pcsc-mini/windows-aarch64-electron"],
};

function lockEntry(lock, name) {
  const e = lock.packages?.[`node_modules/${name}`];
  if (!e?.version || !e?.integrity) throw new Error(`${name} is not pinned in desktop/package-lock.json`);
  return e;
}

/** Installs what is missing; returns the list of packages present for the targets. */
export function ensurePcscPrebuilds(targets, { log = console.log } = {}) {
  const lock = JSON.parse(readFileSync(join(desktop, "package-lock.json"), "utf8"));
  const wanted = [...new Set(targets.flatMap((t) => PCSC_PREBUILDS[t] ?? []))];
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const name of wanted) {
    const e = lockEntry(lock, name);
    const dir = join(desktop, "node_modules", ...name.split("/"));
    if (existsSync(join(dir, "addon.node"))) {
      const have = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      if (have === e.version) continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "m5cet-pcsc-"));
    try {
      const out = execFileSync(npm, ["pack", `${name}@${e.version}`, "--pack-destination", tmp, "--json", "--silent"], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32" });
      const file = join(tmp, JSON.parse(out)[0].filename);
      const integrity = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
      if (integrity !== e.integrity) throw new Error(`${name}@${e.version}: integrity ${integrity} does not match the lockfile`);
      const unpack = join(tmp, "unpack");
      mkdirSync(unpack);
      execFileSync("tar", ["-xzf", file, "-C", unpack]);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(join(unpack, "package"), dir);
      log(`› ${name}@${e.version} (lockfile integrity verified)`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  // The macOS binaries must survive codesign (the x86_64 one has no room for the signature's
  // load command: macho-signable.mjs drops its informational LC_SOURCE_VERSION).
  for (const name of wanted.filter((n) => n.startsWith("@pcsc-mini/macos-"))) {
    const file = join(desktop, "node_modules", ...name.split("/"), "addon.node");
    const buf = readFileSync(file);
    if (makeSignable(buf)) {
      writeFileSync(file, buf);
      log(`› ${name}: made room for the code signature (dropped LC_SOURCE_VERSION)`);
    }
  }
  return wanted;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2).filter((a) => a === "--mac" || a === "--win").map((a) => a.slice(2));
  ensurePcscPrebuilds(targets.length ? targets : [process.platform === "win32" ? "win" : "mac"]);
}
