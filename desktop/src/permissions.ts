// Which web permissions the page gets (pure).
//
// Only the chosen server's origin, and only its main frame (the function
// sandbox frame has an opaque origin and gets nothing), may use what the web
// client uses: camera and microphone (calls, dictation), notifications,
// writing to the clipboard, location (sharing a position), choosing the
// speaker, screen sharing, fullscreen, the File System Access pickers and the
// USB / serial / HID devices of the NFC readers. Everything else — reading the
// clipboard, MIDI, idle detection, window management, storage access,
// keyboard lock, DRM, opening external apps (the app does that itself, with a
// confirmation) — is refused for everyone.
//
// Electron asks twice: a REQUEST (the prompt the browser would show — the app
// grants it, the macOS / Windows privacy prompt for camera, microphone and
// location still applies) and a CHECK (navigator.permissions.query, the
// Notification.permission getter, device access). Both use this table.

export const ALLOWED_PERMISSIONS: readonly string[] = [
  "media", "notifications", "clipboard-sanitized-write", "geolocation", "fullscreen",
  "display-capture", "speaker-selection", "fileSystem", "serial", "usb", "hid",
];

export const ALLOWED_DEVICE_TYPES: readonly string[] = ["serial", "usb", "hid"];
/** Media the page may capture (getUserMedia). */
const MEDIA_TYPES = new Set(["video", "audio"]);

export type PermissionQuery = {
  permission: string;
  /** The origin asking ("https://chat.example.org", "null" for an opaque frame). */
  requestingOrigin: string;
  /** The page's top-level origin (embedding origin). */
  topOrigin?: string;
  isMainFrame: boolean;
  /** For "media": the kinds requested. */
  mediaTypes?: readonly string[];
};

function originOf(value: string): string {
  try { return new URL(value).origin; } catch { return "null"; }
}

/** Grant or refuse one permission request / check. */
export function decidePermission(q: PermissionQuery, serverOrigin: string): boolean {
  if (!serverOrigin || serverOrigin === "null") return false;
  if (!ALLOWED_PERMISSIONS.includes(q.permission)) return false;
  if (originOf(q.requestingOrigin) !== serverOrigin) return false;
  if (q.topOrigin !== undefined && originOf(q.topOrigin) !== serverOrigin) return false;
  if (!q.isMainFrame) return false;
  if (q.permission === "media") {
    const kinds = q.mediaTypes ?? [];
    // An empty list is Chromium's "enumerate / check" form; anything requested must be a camera or a microphone.
    if (kinds.some((k) => !MEDIA_TYPES.has(k))) return false;
  }
  return true;
}

/** USB / serial / HID access to an already chosen device (setDevicePermissionHandler). */
export function decideDevicePermission(deviceType: string, origin: string, serverOrigin: string): boolean {
  return Boolean(serverOrigin) && ALLOWED_DEVICE_TYPES.includes(deviceType) && originOf(origin) === serverOrigin;
}
