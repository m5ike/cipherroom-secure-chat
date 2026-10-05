// The iOS store (6.14): enrolled iPhones and iPads, design builds, release
// records (versions in the App Store / TestFlight — no binaries), the commands
// sent to devices, their events, positions and enrolment codes — in
// $DATA_DIR/ios/ios.db (SQLite, WAL; IOS_DATA_DIR moves the folder). The
// store itself is the platform-neutral MobileStore (server/mobile/store.ts);
// the signing key is the same as Android's (server/mobile/signing.ts).

import { MobileStore, type BaseDevice, type ReleaseStatus } from "../mobile/store";

export type ApnsEnvironment = "production" | "sandbox";

export type IosDevice = BaseDevice & {
  /** "iOS", "iPadOS", "watchOS"; the version apart ("26.0"). */
  os: string; osVersion: string;
  /** What the app runs on: phone, pad, watch, mac (an iPad app on a Mac with Apple silicon). */
  idiom: string;
  /** The marketing name ("iPhone 17 Pro"); `model` is the hardware identifier ("iPhone18,1"). */
  modelName: string;
  /** APNs device token (hex) for alert and background pushes; the PushKit (VoIP) token for calls. */
  apnsToken: string; voipToken: string;
  /** The APNs environment the app's tokens belong to (its aps-environment entitlement); "" = the server's. */
  apnsEnv: "" | ApnsEnvironment;
  /** Why APNs last refused the device's token (Unregistered, BadDeviceToken…); cleared by a new token. */
  apnsError?: string;
};

/** Where the link of a release leads. */
export type IosStore = "appstore" | "testflight";

/** A version of the iOS app as the App Store or TestFlight has it — a record with a link, never a file. */
export type IosRelease = {
  id: string; version: string; build: number; bundleId: string;
  channel: "stable" | "beta" | "dev"; store: IosStore; url: string;
  /** Release notes per language (cs, en, de, …). */
  notes: Record<string, string>;
  /** Apps below this build must update (the app insists); 0 = none. */
  minBuild: number;
  /** Staged rollout: the share of devices (0–100 %) told about it — always all whose build is below minBuild. */
  rollout: number;
  status: ReleaseStatus; createdAt: number; createdBy: string; publishedAt: number | null; updatedAt: number;
  /** The server's signature over iosReleaseSignedString (the app checks it with the pinned key). */
  signature: string;
};

export const iosStore = new MobileStore<IosDevice, IosRelease>({ platform: "ios", label: "iOS", releaseSort: (r) => r.build });
