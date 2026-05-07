// Capability detection. IE explicitly unsupported — bail with a banner.

export type Capabilities = {
  supported: boolean;
  webCrypto: boolean;
  webRTC: boolean;
  webSocket: boolean;
  notifications: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  localStorage: boolean;
  isIE: boolean;
  unsupportedReasons: string[];
};

function isInternetExplorer() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // MSIE = IE10 and below; Trident = IE11.
  return /MSIE\s|Trident\//.test(ua);
}

function checkLocalStorage() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const probe = "__cipherroom_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function detectCapabilities(): Capabilities {
  const isIE = isInternetExplorer();
  const webCrypto =
    typeof window !== "undefined" &&
    typeof window.crypto !== "undefined" &&
    typeof window.crypto.subtle !== "undefined";
  const webRTC = typeof window !== "undefined" && typeof window.RTCPeerConnection !== "undefined";
  const webSocket = typeof window !== "undefined" && typeof window.WebSocket !== "undefined";
  const notifications = typeof window !== "undefined" && "Notification" in window;
  const serviceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const pushManager = typeof window !== "undefined" && "PushManager" in window;
  const localStorage = checkLocalStorage();

  const unsupportedReasons: string[] = [];
  if (isIE) unsupportedReasons.push("Internet Explorer není podporován. Použij Edge, Chrome, Firefox nebo Safari.");
  if (!webCrypto) unsupportedReasons.push("Chybí Web Crypto API (window.crypto.subtle).");
  if (!webRTC) unsupportedReasons.push("Chybí WebRTC (RTCPeerConnection).");
  if (!webSocket) unsupportedReasons.push("Chybí WebSocket.");

  return {
    supported: unsupportedReasons.length === 0,
    webCrypto,
    webRTC,
    webSocket,
    notifications,
    serviceWorker,
    pushManager,
    localStorage,
    isIE,
    unsupportedReasons,
  };
}
