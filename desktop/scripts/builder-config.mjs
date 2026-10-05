// electron-builder configuration of M5cet Desktop — a function of the
// environment, so signing and updates come ONLY from environment variables
// (never from a file in the repository):
//
//   macOS signing      CSC_LINK (+ CSC_KEY_PASSWORD), or CSC_NAME (a keychain identity)
//   macOS notarizing   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,
//                      or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
//   Windows signing    WIN_CSC_LINK (+ WIN_CSC_KEY_PASSWORD), or Azure Trusted Signing:
//                      AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET with
//                      M5CET_AZURE_ENDPOINT, M5CET_AZURE_ACCOUNT, M5CET_AZURE_PROFILE,
//                      M5CET_AZURE_PUBLISHER
//   updates            M5CET_UPDATE_URL (generic https feed) or M5CET_UPDATE_GITHUB (owner/repo)
//
// Without signing variables the build still works: macOS gets an ad-hoc
// signature (it runs on this Mac; Gatekeeper on others asks), Windows an
// unsigned installer (SmartScreen warns), and the app never updates itself.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { usageInfo } from "./infoplist.mjs";

/** Absolute paths: electron-builder hands some of them to codesign, which runs in the caller's directory. */
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const B = (file) => join(DESKTOP, "build", file);

export const APP_ID = "ma.fir.m5cet.desktop";
export const LANGS = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"];
/** Chromium's locale packs to keep (es-419, pt… go; macOS .lproj names). */
const ELECTRON_LANGS = ["en", "en-GB", "en-US", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"];

/** What goes into app.asar (a platform's own `files` REPLACES this list in electron-builder, so it repeats it). */
export const APP_FILES = ["dist/**/*", "web/**/*", "web-index.json", "package.json", "!**/*.map"];

/** 6.13.1: pcsc-mini's per-platform binaries — unpacked from app.asar, only the target's own in each artifact. */
export const PCSC_UNPACK = "node_modules/@pcsc-mini/**";
const dropPcsc = (...globs) => globs.map((g) => `!node_modules/@pcsc-mini/${g}{,/**/*}`);
export const PCSC_EXCLUDE = {
  mac: dropPcsc("windows-*", "linux-*"),
  // Windows: the "-electron" builds only (the "-node" / "-bun" ones link against another host).
  win: dropPcsc("macos-*", "linux-*", "windows-*-node", "windows-*-bun"),
};
export const PCSC_MAC_ARCH_FILES = "Contents/Resources/app.asar.unpacked/node_modules/@pcsc-mini/macos-*/addon.node";

export function signing(env = process.env) {
  const azure = Boolean(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.M5CET_AZURE_ENDPOINT && env.M5CET_AZURE_ACCOUNT && env.M5CET_AZURE_PROFILE);
  return {
    mac: Boolean(env.CSC_LINK || env.CSC_NAME),
    notarize: Boolean((env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)),
    win: Boolean(env.WIN_CSC_LINK || env.CSC_LINK) || azure,
    azure,
  };
}

export function publishConfig(env = process.env) {
  const url = (env.M5CET_UPDATE_URL ?? "").trim();
  if (url) {
    if (!/^https:\/\/[^\s@]+$/.test(url)) throw new Error("M5CET_UPDATE_URL must be an https URL without credentials");
    return [{ provider: "generic", url }];
  }
  const gh = (env.M5CET_UPDATE_GITHUB ?? "").trim();
  if (gh) {
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(gh);
    if (!m) throw new Error("M5CET_UPDATE_GITHUB must be owner/repo");
    return [{ provider: "github", owner: m[1], repo: m[2], releaseType: "release" }];
  }
  return null;
}

export function builderConfig(env = process.env, { lprojDir } = {}) {
  const s = signing(env);
  const publish = publishConfig(env);
  return {
    appId: APP_ID,
    productName: "M5cet",
    copyright: "M5cet · MIT",
    directories: { output: join(DESKTOP, "release"), buildResources: join(DESKTOP, "build") },
    // The app: the compiled main process, preloads and pages, and the web client (inside app.asar,
    // covered by the asar integrity check that the fuses make Electron enforce).
    files: APP_FILES,
    asar: true,
    // 6.13.1: the PC/SC module's native binaries (pcsc-mini) load from outside the archive.
    asarUnpack: [PCSC_UNPACK],
    electronLanguages: ELECTRON_LANGS,
    protocols: [{ name: "M5cet", schemes: ["m5cet"] }],
    publish,
    // Fuses (@electron/fuses): no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS, no --inspect, cookies encrypted
    // with the OS key store, the app only from app.asar and only when its integrity hash matches.
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
      resetAdHocDarwinSignature: !s.mac,
    },
    mac: {
      target: [{ target: "dmg", arch: ["universal"] }, { target: "zip", arch: ["universal"] }],
      category: "public.app-category.social-networking",
      artifactName: "${productName}-${version}-mac-${arch}.${ext}",
      icon: B("icon-mac.png"),
      minimumSystemVersion: "13.0",
      darkModeSupport: true,
      hardenedRuntime: true,
      // A Developer ID identity from CSC_LINK / CSC_NAME, else an ad-hoc signature ("-").
      identity: s.mac ? undefined : "-",
      entitlements: B(s.mac ? "entitlements.mac.plist" : "entitlements.mac.adhoc.plist"),
      entitlementsInherit: B(s.mac ? "entitlements.mac.plist" : "entitlements.mac.adhoc.plist"),
      notarize: s.mac && s.notarize,
      extendInfo: { ...usageInfo(), LSApplicationCategoryType: "public.app-category.social-networking" },
      ...(lprojDir ? { extraResources: [{ from: lprojDir, to: ".", filter: ["**/InfoPlist.strings"] }] } : {}),
      // 6.13.1: both macOS PC/SC binaries are in both halves of the universal app (the module picks
      // by process.arch); identical single-arch Mach-O files must be named for the merge.
      files: [...APP_FILES, ...PCSC_EXCLUDE.mac],
      x64ArchFiles: PCSC_MAC_ARCH_FILES,
    },
    dmg: { writeUpdateInfo: false },
    win: {
      target: [{ target: "nsis", arch: ["x64", "arm64"] }, { target: "zip", arch: ["x64", "arm64"] }],
      artifactName: "${productName}-${version}-win-${arch}.${ext}",
      icon: B("icon.png"),
      requestedExecutionLevel: "asInvoker",
      // Resource editing (icon, version info, the asar integrity resource) is pure JS (resedit): no Wine.
      signAndEditExecutable: true,
      // 6.13.1: the Electron builds of the PC/SC module for x64 and arm64 (the module picks by process.arch).
      files: [...APP_FILES, ...PCSC_EXCLUDE.win],
      ...(s.azure ? {
        azureSignOptions: {
          endpoint: env.M5CET_AZURE_ENDPOINT,
          codeSigningAccountName: env.M5CET_AZURE_ACCOUNT,
          certificateProfileName: env.M5CET_AZURE_PROFILE,
          publisherName: env.M5CET_AZURE_PUBLISHER || "M5cet",
        },
      } : {}),
      ...(s.win ? {} : { signExecutable: false }),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      buildUniversalInstaller: false,
      artifactName: "${productName}-Setup-${version}-${arch}.${ext}",
      shortcutName: "M5cet",
      uninstallDisplayName: "M5cet",
    },
  };
}
