// Builds (6.0): the Android design frozen into a bundle a device installs.
//
//   compile   design → files (manifest, theme, animations, screens, menus,
//             strings, libraries, assets) → M5PK container → gzip
//   encrypt   AES-256-GCM segments under a fresh content key (CEK)
//   sign      ECDSA P-256 over the header (the server's Android key)
//   deploy    per device: the CEK wrapped with its encryption key (ECIES);
//             a deploy file for several devices carries one wrap for each
//
// The encrypted file is kept in $DATA_DIR/android/builds/<id>.m5ab, the CEK
// sealed with the storage master key in the build's row.

import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { openValue, sealValue } from "../storage/keys";
import {
  bundleFile, openBundleBody, packContainer, parseBundleFile, sealBundle, sha256, unpackContainer, wrapBundleKey,
  type BundleHeader, type ContainerEntry,
} from "./crypto";
import { androidDesign, designRev, sanitizeDesign, type AndroidDesign } from "./design";
import { ACTIONS_67, ELEMENTS_67 } from "./design-67";
import { androidStore, newId, type Build, type Device } from "./store";

/** versionCode of an app version: 6.0.0 → 60000 (major·10000 + minor·100 + patch). */
export function versionCodeOf(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

/** The oldest app that reads bundle format 1. */
export const MIN_APP_CODE = 60000;

const json = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8");

/** The files of a design, in the order the app reads them. */
export function designFiles(design: AndroidDesign): ContainerEntry[] {
  const files: ContainerEntry[] = [
    ["app.json", json(design.app)],
    ["theme.json", json(design.theme)],
    ["animations.json", json(design.animations)],
  ];
  for (const [id, tree] of Object.entries(design.screens)) files.push([`screens/${id}.json`, json(tree)]);
  for (const [id, items] of Object.entries(design.menus)) files.push([`menus/${id}.json`, json(items)]);
  for (const [lang, table] of Object.entries(design.strings)) files.push([`strings/${lang}.json`, json(table)]);
  for (const [name, lib] of Object.entries(design.libraries)) files.push([`lib/${name}.json`, json(lib)]);
  for (const [name, asset] of Object.entries(design.assets)) files.push([`assets/${name}`, Buffer.from(asset.data, "base64")]);
  return files;
}

export type Manifest = {
  format: 1; id: string; number: number; version: string; channel: string; created: number; minAppCode: number;
  designRev: string; notes: string; files: Record<string, { size: number; sha256: string }>;
  screens: string[]; languages: string[]; libraries: string[]; assets: Record<string, string>;
};

/** The whole plain content: container of manifest + files, gzipped. */
export function compileDesign(design: AndroidDesign, meta: Omit<Manifest, "format" | "files" | "screens" | "languages" | "libraries" | "assets" | "designRev">): { plaintext: Buffer; manifest: Manifest } {
  const files = designFiles(design);
  const manifest: Manifest = {
    format: 1, ...meta, designRev: designRev(design),
    files: Object.fromEntries(files.map(([path, data]) => [path, { size: data.length, sha256: sha256(data).toString("hex") }])),
    screens: Object.keys(design.screens), languages: Object.keys(design.strings), libraries: Object.keys(design.libraries),
    assets: Object.fromEntries(Object.entries(design.assets).map(([name, a]) => [name, a.mime])),
  };
  const container = packContainer([["manifest.json", json(manifest)], ...files]);
  return { plaintext: gzipSync(container, { level: 9 }), manifest };
}

/** Reads a plain content back: the manifest checked against every file. */
export function readContent(plaintext: Buffer): { manifest: Manifest; files: Map<string, Buffer> } {
  const entries = unpackContainer(gunzipSync(plaintext, { maxOutputLength: 64 * 1024 * 1024 }));
  if (!entries.length || entries[0][0] !== "manifest.json") throw new Error("the bundle has no manifest");
  const manifest = JSON.parse(entries[0][1].toString("utf8")) as Manifest;
  const files = new Map(entries.slice(1));
  for (const [path, info] of Object.entries(manifest.files)) {
    const data = files.get(path);
    if (!data || data.length !== info.size || sha256(data).toString("hex") !== info.sha256) throw new Error(`bundle file ${path} does not match its manifest`);
  }
  return { manifest, files };
}

/** The design inside a content (to look at, or to restore in the console). */
export function designOfContent(files: Map<string, Buffer>): AndroidDesign {
  const read = (path: string) => { const b = files.get(path); return b ? JSON.parse(b.toString("utf8")) as unknown : undefined; };
  const pick = (prefix: string) => Object.fromEntries([...files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".json")).map((p) => [p.slice(prefix.length, -5), read(p)]));
  return sanitizeDesign({
    format: 1, app: read("app.json"), theme: read("theme.json"), animations: read("animations.json"),
    screens: pick("screens/"), menus: pick("menus/"), strings: pick("strings/"), libraries: pick("lib/"),
    assets: Object.fromEntries([...files.entries()].filter(([p]) => p.startsWith("assets/")).map(([p, data]) => [p.slice(7), { mime: mimeOf(p), data: data.toString("base64") }])),
  });
}

const mimeOf = (path: string) => (/\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.gif$/i.test(path) ? "image/gif" : /\.otf$/i.test(path) ? "font/otf" : /\.ttf$/i.test(path) ? "font/ttf" : "image/png");

const cekAad = (id: string) => `android:build:${id}`;

/** 6.7: the app code each design version's own elements and actions need (an older app draws an unknown element as nothing). */
const NEEDS_67 = 60700;

/**
 * The oldest app a design runs on: one that uses a 6.7 element (the room rows'
 * `swipe`) or action needs the 6.7 app — so an older phone keeps the build it
 * has instead of getting rows it cannot draw.
 */
export function designMinAppCode(design: AndroidDesign): number {
  const json = JSON.stringify(design);
  const els = new Set(ELEMENTS_67.map((e) => e.el));
  const acts = new Set(ACTIONS_67.map((a) => a.action));
  for (const m of json.matchAll(/"el":"([^"]+)"/g)) if (els.has(m[1])) return NEEDS_67;
  for (const m of json.matchAll(/"action":"([^"]+)"/g)) if (acts.has(m[1])) return NEEDS_67;
  return MIN_APP_CODE;
}

export function createBuild(opts: { notes?: string; channel?: string; by: string; minAppCode?: number; appVersion: string; design?: AndroidDesign }): Build {
  const design = opts.design ?? androidDesign();
  const number = Math.max(0, ...androidStore.builds.list({ limit: 1 }).map((b) => b.number)) + 1;
  const id = newId("bld");
  const channel = ["stable", "beta", "dev"].includes(opts.channel ?? "") ? opts.channel! : "stable";
  const created = Date.now();
  const minAppCode = Math.max(MIN_APP_CODE, designMinAppCode(design), Math.round(opts.minAppCode ?? MIN_APP_CODE));
  const version = `${opts.appVersion}-b${number}`;
  const notes = (opts.notes ?? "").slice(0, 2000);
  const { plaintext, manifest } = compileDesign(design, { id, number, version, channel, created, minAppCode, notes });
  const signer = androidStore.signingKey();
  const { header, body, cek } = sealBundle({ id, number, version, channel, created, minAppCode }, plaintext, { privateKey: signer.privateKey, kid: signer.kid });
  const file = bundleFile(header, body);
  androidStore.writeFileAtomic(androidStore.buildFile(id), file);
  const { recipients: _r, ...headerNoRecipients } = header;
  const build: Build = {
    id, number, version, channel, status: "ready", notes, createdAt: created, createdBy: opts.by, publishedAt: null,
    minAppCode, designRev: manifest.designRev, size: plaintext.length, fileSize: file.length, sha256: header.sha256,
    cekSealed: sealValue(cek.toString("base64"), cekAad(id)).toString("base64"),
    header: headerNoRecipients,
    summary: { screens: manifest.screens, files: Object.keys(manifest.files).length, languages: manifest.languages, libraries: manifest.libraries },
  };
  cek.fill(0);
  androidStore.builds.put(build);
  return build;
}

function buildCek(build: Build): Buffer {
  const b64 = openValue(Buffer.from(build.cekSealed, "base64"), cekAad(build.id));
  if (!b64) throw new Error("the build's key cannot be opened (storage master key changed?)");
  return Buffer.from(b64, "base64");
}

/** The build's file with the content key wrapped for these devices. */
export function deployFile(build: Build, devices: Array<Pick<Device, "id" | "encKey">>): Buffer {
  const { header, body } = parseBundleFile(readFileSync(androidStore.buildFile(build.id)));
  const cek = buildCek(build);
  try {
    const withRecipients: BundleHeader = { ...header, recipients: devices.map((d) => wrapBundleKey(cek, header, d)) };
    return bundleFile(withRecipients, body);
  } finally {
    cek.fill(0);
  }
}

/** The build's content, decrypted on the server (the console's inspector). */
export function buildContent(build: Build): { manifest: Manifest; files: Map<string, Buffer> } {
  const { header, body } = parseBundleFile(readFileSync(androidStore.buildFile(build.id)));
  const cek = buildCek(build);
  try {
    return readContent(openBundleBody(header, body, cek));
  } finally {
    cek.fill(0);
  }
}

/** The newest published build a device of this app version and channel may install. */
export function latestBuildFor(appCode: number, channel: string): Build | null {
  const order = channel === "dev" ? ["dev", "beta", "stable"] : channel === "beta" ? ["beta", "stable"] : ["stable"];
  return androidStore.builds.list({ limit: 200, filter: (b) => b.status === "published" && b.minAppCode <= appCode && order.includes(b.channel) })[0] ?? null;
}
