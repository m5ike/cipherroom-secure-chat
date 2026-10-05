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
//
// 6.14: the format and the work are shared with iOS (server/mobile/bundle.ts);
// this file is Android's target — its store, design, key label and oldest app.

import {
  buildContentFor, createBuildFor, deployFileFor, designMinAppCode, latestBuildIn, MIN_APP_CODE,
  type BuildOptions, type BuildTarget, type Manifest,
} from "../mobile/bundle";
import { androidDesign, DEFAULT_DESIGN } from "./design";
import { androidStore, type Build, type Device, type Release } from "./store";

export {
  compileDesign, designFiles, designMinAppCode, designOfContent, LOCALES_APP_CODE, MIN_APP_CODE, needsLocalesApp, readContent, versionCodeOf,
  type Manifest,
} from "../mobile/bundle";

export const ANDROID_BUILDS: BuildTarget<Device, Release> = {
  store: androidStore,
  design: () => androidDesign(),
  defaults: DEFAULT_DESIGN,
  idPrefix: "bld",
  cekAad: (id) => `android:build:${id}`,
  minAppCode: MIN_APP_CODE,
  designMinAppCode,
};

export function createBuild(opts: BuildOptions): Build {
  return createBuildFor(ANDROID_BUILDS, opts);
}

/** The build's file with the content key wrapped for these devices. */
export function deployFile(build: Build, devices: Array<Pick<Device, "id" | "encKey">>): Buffer {
  return deployFileFor(ANDROID_BUILDS, build, devices);
}

/** The build's content, decrypted on the server (the console's inspector). */
export function buildContent(build: Build): { manifest: Manifest; files: Map<string, Buffer> } {
  return buildContentFor(ANDROID_BUILDS, build);
}

/** The newest published build a device of this app version and channel may install. */
export function latestBuildFor(appCode: number, channel: string): Build | null {
  return latestBuildIn(androidStore, appCode, channel);
}
