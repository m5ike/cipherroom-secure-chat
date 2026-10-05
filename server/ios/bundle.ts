// iOS builds (6.14): the iOS design frozen into the same signed, encrypted
// bundle as Android's (M5PK content, M5AB file — server/mobile/bundle.ts):
// $DATA_DIR/ios/builds/<id>.m5ab, ids ibld_…, the content key sealed under
// "ios:build:<id>", for iOS apps from 6.14.0 (61400) or the newer one a
// design element needs.

import { buildContentFor, createBuildFor, deployFileFor, latestBuildIn, type BuildOptions, type BuildTarget, type Manifest } from "../mobile/bundle";
import type { Build } from "../mobile/store";
import { IOS_DEFAULT_DESIGN, IOS_MIN_APP_CODE, iosDesign, iosDesignMinAppCode } from "./design";
import { iosStore, type IosDevice, type IosRelease } from "./store";

export const IOS_BUILDS: BuildTarget<IosDevice, IosRelease> = {
  store: iosStore,
  design: () => iosDesign(),
  defaults: IOS_DEFAULT_DESIGN,
  idPrefix: "ibld",
  cekAad: (id) => `ios:build:${id}`,
  minAppCode: IOS_MIN_APP_CODE,
  designMinAppCode: iosDesignMinAppCode,
};

export const createIosBuild = (opts: BuildOptions): Build => createBuildFor(IOS_BUILDS, opts);
export const iosDeployFile = (build: Build, devices: Array<Pick<IosDevice, "id" | "encKey">>): Buffer => deployFileFor(IOS_BUILDS, build, devices);
export const iosBuildContent = (build: Build): { manifest: Manifest; files: Map<string, Buffer> } => buildContentFor(IOS_BUILDS, build);
export const latestIosBuildFor = (appCode: number, channel: string): Build | null => latestBuildIn(iosStore, appCode, channel);
