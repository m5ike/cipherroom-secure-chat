// Upgrade requests nobody serves (6.7, audit S3).
//
// Every WebSocket endpoint listens to the HTTP server's "upgrade" event and
// ignores the paths that are not its own. Once a server has any "upgrade"
// listener, Node no longer closes an unhandled upgrade itself, so a request
// for an unknown path (GET /not-ws with Upgrade: websocket) stayed open
// forever — outside the connection gate, a cheap way to use up descriptors.
//
// Each endpoint claims its paths here; the first claim adds one more listener
// that answers 404 and destroys the socket for any path nobody claimed.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradePath = string | RegExp | ((pathname: string) => boolean);

const claims = new WeakMap<Server, UpgradePath[]>();

/** The path of an upgrade request; "" when the URL is unreadable. */
export function upgradePathname(req: IncomingMessage): string {
  try { return new URL(req.url ?? "/", "http://x").pathname; } catch { return ""; }
}

function matches(claim: UpgradePath, pathname: string): boolean {
  if (typeof claim === "string") return claim === pathname;
  if (claim instanceof RegExp) return claim.test(pathname);
  return claim(pathname);
}

/** Registers the upgrade paths an endpoint serves on this server. */
export function claimUpgradePath(server: Server, path: UpgradePath): void {
  let list = claims.get(server);
  if (!list) {
    list = [];
    claims.set(server, list);
    const own = list;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const pathname = upgradePathname(req);
      if (pathname && own.some((c) => matches(c, pathname))) return;
      try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch { /* already gone */ }
      socket.destroy();
    });
  }
  list.push(path);
}
