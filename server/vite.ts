import type { Express } from 'express';
import { createServer as createViteServer, createLogger } from "vite";
import type { Server } from 'node:http';
import viteConfig from "../vite.config";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { claimUpgradePath } from "./upgrade-guard";

const viteLogger = createLogger();

/**
 * Vite in middleware mode on the app's own HTTP server: it listens where that
 * server listens — 127.0.0.1 in development unless HOST is set (server/index.ts,
 * 6.12 F-27) — and serves only what vite.config.ts's server.fs allows.
 */
export async function setupVite(server: Server, app: Express) {
  // 6.7 (S3): upgrades to paths nobody claims are closed; HMR is one of ours.
  claimUpgradePath(server, "/vite-hmr");
  const serverOptions = {
    middlewareMode: true,
    hmr: { server, path: "/vite-hmr" },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    // Log only. Vite reports request-level problems (e.g. a denied /@fs path:
    // "outside of Vite serving allow list") through this same channel, so
    // exiting here turned every 403 into a dead dev server. Compile errors
    // still surface via Vite's overlay and the console.
    customLogger: {
      ...viteLogger,
      error: (msg, options) => { viteLogger.error(msg, options); },
    },
    // Merge, don't replace: vite.config.ts carries server.fs (allow/deny) and
    // the dev security headers; dropping them silently ran Vite with its
    // defaults, whose allow-list breaks on symlinked/relocated installs.
    server: { ...(viteConfig.server ?? {}), ...serverOptions },
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
