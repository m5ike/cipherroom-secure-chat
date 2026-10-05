// Renders the icons (scripts/render-icons.cjs) with the Electron of this package.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)("electron");
execFileSync(electron, [join(here, "render-icons.cjs")], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
