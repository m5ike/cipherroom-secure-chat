// iOS releases (6.14): no binaries — Apple installs the app. A release is a
// record of a version the App Store or TestFlight has: its version and build,
// the link, the notes per language, the oldest build that may stay (below it
// the app insists on the update) and a staged rollout (the share of devices
// told about it). The server signs each record; the app checks the signature
// with the pinned key before it shows the link, so a changed record (another
// link) is refused:
//
//   "m5iosrelease/1|" + id + "|" + version + "|" + build + "|" + bundleId + "|"
//     + channel + "|" + store + "|" + url + "|" + minBuild

import { createHash } from "node:crypto";
import { LANGS } from "../android/design";
import { channelOrder } from "../mobile/bundle";
import { signP1363 } from "../mobile/crypto";
import { mobileSigningKey } from "../mobile/signing";
import { appleUrl, iosConfig } from "./config";
import { iosStore, type IosDevice, type IosRelease } from "./store";

export const iosReleaseSignedString = (r: Pick<IosRelease, "id" | "version" | "build" | "bundleId" | "channel" | "store" | "url" | "minBuild">): string =>
  ["m5iosrelease/1", r.id, r.version, r.build, r.bundleId, r.channel, r.store, r.url, r.minBuild].join("|");

export const signIosRelease = (r: IosRelease): string => signP1363(mobileSigningKey().privateKey, iosReleaseSignedString(r));

/** "6.14.0" → 61400 (major·10000 + minor·100 + patch), the build numbering of the iOS app (CFBundleVersion). */
export function buildOfVersion(version: string): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim());
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3] ?? 0) : 0;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clamp = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d);

/** Notes: one text per known language (cs, en, de, es, it, fr, sk, sl, fi); a plain string is English. */
export function sanitizeNotes(raw: unknown): Record<string, string> {
  if (typeof raw === "string") return raw.trim() ? { en: raw.slice(0, 2000) } : {};
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const lang of LANGS) {
      const v = (raw as Record<string, unknown>)[lang];
      if (typeof v === "string" && v.trim()) out[lang] = v.slice(0, 2000);
    }
  }
  return out;
}

/**
 * The editable part of a release from the console: what was sent over what
 * there was. Returns the problem when the record would not be usable.
 */
export function applyReleaseInput(base: Partial<IosRelease>, raw: unknown): { release: Partial<IosRelease>; problem: string | null } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const next: Partial<IosRelease> = { ...base };
  if (b.version !== undefined) next.version = str(b.version, 20);
  if (b.build !== undefined) next.build = clamp(b.build, 0, 99_999_999, 0);
  if (next.version && !next.build) next.build = buildOfVersion(next.version);
  if (b.channel === "stable" || b.channel === "beta" || b.channel === "dev") next.channel = b.channel;
  if (b.store === "appstore" || b.store === "testflight") next.store = b.store;
  next.channel ??= "stable";
  next.store ??= next.channel === "stable" ? "appstore" : "testflight";
  if (b.url !== undefined) next.url = appleUrl(b.url);
  if (b.notes !== undefined) next.notes = sanitizeNotes(b.notes);
  if (b.minBuild !== undefined) next.minBuild = clamp(b.minBuild, 0, 99_999_999, 0);
  if (b.rollout !== undefined) next.rollout = clamp(b.rollout, 0, 100, 100);
  next.notes ??= {};
  next.minBuild ??= 0;
  next.rollout ??= 100;
  if (!next.url) {
    const c = iosConfig();
    next.url = next.store === "testflight" ? c.testFlightUrl : c.appStoreUrl;
  }
  if (!/^\d+\.\d+(\.\d+)?$/.test(next.version ?? "")) return { release: next, problem: "version must be like 6.14.0" };
  if (!next.build || next.build < 1) return { release: next, problem: "build must be a positive number (major·10000 + minor·100 + patch)" };
  if (!next.url) return { release: next, problem: `a ${next.store === "testflight" ? "TestFlight" : "App Store"} link is needed (https://${next.store === "testflight" ? "testflight.apple.com/join/…" : "apps.apple.com/…"}) — here or in iOS › Security` };
  if (next.minBuild! > next.build) return { release: next, problem: "the minimum build cannot be newer than the release itself" };
  return { release: next, problem: null };
}

/** Whether a device is in a release's staged rollout: a stable share of devices per release. */
export function inRollout(deviceId: string, releaseId: string, rollout: number): boolean {
  if (rollout >= 100) return true;
  if (rollout <= 0) return false;
  const h = createHash("sha256").update(`${releaseId}|${deviceId}`).digest();
  return h.readUInt32BE(0) % 100 < rollout;
}

/** The record as a device gets it, with whether this device must update. */
export function releasePublic(r: IosRelease, device?: Pick<IosDevice, "appCode">) {
  return {
    id: r.id, version: r.version, build: r.build, bundleId: r.bundleId, channel: r.channel, store: r.store, url: r.url,
    notes: r.notes, minBuild: r.minBuild, rollout: r.rollout,
    mandatory: device ? device.appCode < r.minBuild || device.appCode < effectiveMinBuild() : r.minBuild > 0,
  };
}

/** The newest published release a device should hear about: newer than its build, its channel, in the rollout (or required). */
export function latestIosReleaseFor(device: IosDevice): IosRelease | null {
  const order = channelOrder(iosConfig().policy.update.channel);
  return iosStore.releases.list({
    limit: 100,
    filter: (r) => r.status === "published" && order.includes(r.channel) && r.build > device.appCode
      && (inRollout(device.id, r.id, r.rollout) || device.appCode < r.minBuild),
  })[0] ?? null;
}

/** The oldest build the server lets run: ios.json's minimum, raised by the minimum of the published releases devices are offered. */
export function effectiveMinBuild(): number {
  const c = iosConfig();
  const order = channelOrder(c.policy.update.channel);
  let min = c.minAppBuild;
  for (const r of iosStore.releases.list({ limit: 100, filter: (x) => x.status === "published" && order.includes(x.channel) })) min = Math.max(min, r.minBuild);
  return min;
}
