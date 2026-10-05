// A signed, encrypted design bundle (M5AB) for M5DesignTests — built with the
// server's own code (server/android/bundle.ts compileDesign, server/android/
// crypto.ts sealBundle / wrapBundleKey / bundleFile), so the Swift reader is
// checked against exactly what a device downloads. Run from the repository root:
//
//   npx tsx ios/M5Kit/Tests/M5DesignTests/fixtures/make-bundle.ts
//
// It writes test-bundle.m5ab (the file) and test-bundle.json (the keys and what
// the test expects). The two P-256 keys below are TEST KEYS ONLY — they sign and
// open nothing but this fixture. The content key and the IVs are fresh on every
// run, so the bytes change; the keys and the content do not.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileDesign } from "../../../../../server/android/bundle";
import { bundleFile, kidOf, sealBundle, spkiOf, wrapBundleKey } from "../../../../../server/android/crypto";
import { DEFAULT_DESIGN, type AndroidDesign } from "../../../../../server/android/design";

const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAiVXTWcjK3I1vu5F
Dl05JIdMRzLwe9MWqz0ZheHbtc+hRANCAARKY7hgZPt1aoUAGzmyup6MmKmYV/Pj
tcoBMEVkLRAqh5P9Tk+ldcDa1L8eHmifULYA8GXVnZI7fFpVs8Hxbhm4
-----END PRIVATE KEY-----`;

const DEVICE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgXn2ijN64Ji8z5VYj
20aRkVbsQe37g36E0nMh22TgnBGhRANCAASZ9Lzh3JXxgO6cNDr/nLD3L7h0TsE4
4wcgbWNU+iaFCR5Ncw7I80+6pF+RK77K1MiJ/WuxfXYqZAt48Eu6Zdj6
-----END PRIVATE KEY-----`;

const DEVICE_ID = "ios_testdevice0001";
const OTHER_DEVICE_KEY_SPKI = (() => {
  // A second recipient the test device must skip (its wrap is not for it).
  const k = createPrivateKey(SERVER_KEY);
  return spkiOf(createPublicKey(k));
})();

const here = dirname(fileURLToPath(import.meta.url));

// A small design: the screens a bundle must have plus two more, two languages, a library and an asset.
const KEEP_SCREENS = ["splash", "lock", "rooms", "rooms.item", "room", "message.in", "message.out", "message.sys", "about"];
const KEEP_KEYS = ["lock.title", "lock.enterPin", "lock.useBiometric", "rooms.title", "rooms.connected", "rooms.saved", "nav.back", "menu.more", "users.me"];
const pickStrings = (t: Record<string, string>) => Object.fromEntries(KEEP_KEYS.filter((k) => k in t).map((k) => [k, t[k]]));
// 1×1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const design: AndroidDesign = {
  ...structuredClone(DEFAULT_DESIGN),
  app: { name: "M5cet Test" },
  screens: Object.fromEntries(KEEP_SCREENS.map((id) => [id, structuredClone(DEFAULT_DESIGN.screens[id])])),
  menus: { main: structuredClone(DEFAULT_DESIGN.menus.main) },
  strings: { en: { ...pickStrings(DEFAULT_DESIGN.strings.en), "test.only": "Only in the bundle" }, cs: pickStrings(DEFAULT_DESIGN.strings.cs) },
  libraries: structuredClone(DEFAULT_DESIGN.libraries),
  assets: { "logo.png": { mime: "image/png", data: PNG } },
  rev: "test",
};

const meta = { id: "bld_ios_fixture_01", number: 7, version: "6.14.0-b7", channel: "beta", created: 1791217500000, minAppCode: 61400 };
const { plaintext, manifest } = compileDesign(design, { ...meta, notes: "M5DesignTests fixture" });

const server = createPrivateKey(SERVER_KEY);
const serverSpki = spkiOf(createPublicKey(server));
const kid = kidOf(serverSpki);
const device = createPrivateKey(DEVICE_KEY);
const deviceSpki = spkiOf(createPublicKey(device));
const deviceD = (device.export({ format: "jwk" }) as { d: string }).d;

// Small segments (the app's minimum is 1024), so the file has several.
const { header, body, cek } = sealBundle(meta, plaintext, { privateKey: server, kid }, 4096);
header.recipients = [
  wrapBundleKey(cek, header, { id: "and_someoneelse", encKey: OTHER_DEVICE_KEY_SPKI }),
  wrapBundleKey(cek, header, { id: DEVICE_ID, encKey: deviceSpki }),
];
cek.fill(0);
const file = bundleFile(header, body);
writeFileSync(join(here, "test-bundle.m5ab"), file);
writeFileSync(join(here, "test-bundle.json"), JSON.stringify({
  note: "TEST KEYS ONLY (ios/M5Kit/Tests/M5DesignTests/fixtures/make-bundle.ts)",
  serverSpki, kid, deviceId: DEVICE_ID, deviceSpki, deviceD,
  header: { id: meta.id, number: meta.number, version: meta.version, channel: meta.channel, created: meta.created, minAppCode: meta.minAppCode, segments: header.segments, seg: header.seg, size: header.size },
  files: Object.keys(manifest.files),
  screens: manifest.screens, languages: manifest.languages, designRev: manifest.designRev,
}, null, 1) + "\n");
console.log(`test-bundle.m5ab: ${file.length} bytes, ${header.segments} segments, ${Object.keys(manifest.files).length} files`);
