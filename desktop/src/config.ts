// What the build fixed (desktop/scripts/compile.mjs writes these with
// esbuild's `define` from the environment of the build):
//
//   M5CET_DEFAULT_SERVER   the server offered on the first start ("" = none)
//   M5CET_UPDATE_URL       a generic update feed (https), else the GitHub
//   M5CET_UPDATE_GITHUB    releases of "owner/repo"; neither = no updates
//   (signing)              whether the build was code-signed (CSC_LINK /
//                          WIN_CSC_LINK / Azure Trusted Signing were set) —
//                          an unsigned build never updates itself

declare const __M5CET_DEFAULT_SERVER__: string;
declare const __M5CET_SIGNED__: boolean;
declare const __M5CET_UPDATES__: boolean;
declare const __M5CET_BUILD__: string;
declare const __M5CET_APP_ID__: string;

export const BUILD = {
  defaultServer: typeof __M5CET_DEFAULT_SERVER__ === "string" ? __M5CET_DEFAULT_SERVER__ : "",
  signed: typeof __M5CET_SIGNED__ === "boolean" ? __M5CET_SIGNED__ : false,
  updates: typeof __M5CET_UPDATES__ === "boolean" ? __M5CET_UPDATES__ : false,
  build: typeof __M5CET_BUILD__ === "string" ? __M5CET_BUILD__ : "dev",
  appId: typeof __M5CET_APP_ID__ === "string" ? __M5CET_APP_ID__ : "ma.fir.m5cet.desktop",
};

/** The partition the server page lives in (its cookies, storage, service worker, permissions). */
export const PAGE_PARTITION = "persist:m5cet";
/** The app's own pages (server picker, banner) — a separate session, nothing shared with the page. */
export const APP_SCHEME = "m5cet-app";
