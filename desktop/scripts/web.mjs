// Copies the built web client (../dist/public — `npm run build`) into the
// app: desktop/web/ (inside app.asar after packaging, covered by the asar
// integrity check) and desktop/web-index.json (every file with its size and
// SHA-256 — the router serves exactly these paths, nothing else).
//
// Precompressed .br / .gz copies are left out (the app reads the files
// locally); everything else of dist/public is the client.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "..");

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

export function copyWeb({ from = join(repo, "dist", "public") } = {}) {
  if (!existsSync(join(from, "index.html"))) throw new Error(`no built web client in ${from} — run \`npm run build\` in the repository first`);
  const to = join(desktop, "web");
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const files = {};
  let bytes = 0;
  for (const rel of walk(from)) {
    if (/\.(br|gz)$/.test(rel)) continue;
    // A path the router could not serve (control characters, backslashes) has no place in the bundle.
    if (/[\\\u0000-\u001f\u007f]/.test(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`unsupported path in dist/public: ${JSON.stringify(rel)}`);
    const body = readFileSync(join(from, rel));
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    cpSync(join(from, rel), join(to, rel));
    files[`/${rel}`] = { size: body.length, sha256: createHash("sha256").update(body).digest("hex") };
    bytes += body.length;
  }
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(join(from, "version-manifest.json"), "utf8")); } catch { /* a development build */ }
  const index = { app: "m5cet", version: String(manifest.version ?? ""), build: String(manifest.build ?? ""), files };
  writeFileSync(join(desktop, "web-index.json"), `${JSON.stringify(index, null, 1)}\n`);
  return { count: Object.keys(files).length, bytes, build: index.build, version: index.version, signed: existsSync(join(from, "release-web.json.sig")) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = copyWeb();
  console.log(`web client ${r.version} (${r.build}): ${r.count} files, ${(r.bytes / 1048576).toFixed(1)} MB${r.signed ? ", release-signed" : ", release manifest not signed"}`);
}
