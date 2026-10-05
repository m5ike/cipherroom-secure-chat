// The Android store (6.0): enrolled devices, builds (bundles), APK releases,
// the commands sent to devices, their events, enrolment codes — in
// $DATA_DIR/android/android.db (SQLite, WAL). ANDROID_DATA_DIR moves the
// folder (the bundles and APKs live next to the database).
//
// Since 6.14 the store itself is the platform-neutral MobileStore
// (server/mobile/store.ts, shared with iOS); this file names Android's device
// and release records and keeps the paths and exports it always had.

import { join } from "node:path";
import { MobileStore, mobileDir, type BaseDevice, type MobileEvent, type ReleaseStatus } from "../mobile/store";

export {
  newId, type DeviceStatus, type DeviceState, type BuildStatus, type Build, type ReleaseStatus, type CommandKind,
  type CommandStatus, type Command, type EventLevel, type LocationPoint, type EnrollCode,
} from "../mobile/store";

export function androidDir(): string { return mobileDir("android"); }
export const androidDbPath = (): string => join(androidDir(), "android.db");
export const buildsDir = (): string => join(androidDir(), "builds");
export const releasesDir = (): string => join(androidDir(), "releases");

/* ------------------------------------------------------------------ types */

export type Device = BaseDevice & {
  manufacturer: string; os: string; sdk: number; fcmToken: string;
  /** 6.4: SHA-256 (hex) of the certificate the app on this device is signed with (reported at check-in). */
  certSha256?: string;
};

export type Release = {
  id: string; versionName: string; versionCode: number; packageName: string; channel: string; notes: string;
  apkSha256: string; certSha256: string; size: number; minSdk: number; mandatory: boolean;
  status: ReleaseStatus; createdAt: number; createdBy: string; publishedAt: number | null; signature: string;
  source: "upload" | "build";
};

export type AndroidEvent = MobileEvent;

/* ------------------------------------------------------------------ store */

export const androidStore = new MobileStore<Device, Release>({ platform: "android", label: "Android", releaseSort: (r) => r.versionCode, releaseExt: "apk" });
