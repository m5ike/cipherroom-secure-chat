// How the sandbox process is bundled (4.15): the production build
// (script/build.ts → dist/sandbox.cjs) and development / tests (pool.ts
// builds it on demand) use the same options.

import type { BuildOptions, Plugin } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The QuickJS variant imports its Emscripten glue with import(), which
// would pick the ES module flavour (it needs import.meta.url, which a
// CommonJS bundle does not have); the CommonJS flavour is the same code.
const quickjsGlue: Plugin = {
  name: "quickjs-cjs-glue",
  setup(build) {
    build.onResolve({ filter: /^@jitl\/quickjs-ng-wasmfile-release-sync\/emscripten-module$/ }, () => {
      const req = createRequire(join(process.cwd(), "package.json"));
      const pkg = req.resolve("@jitl/quickjs-ng-wasmfile-release-sync/package.json");
      return { path: join(dirname(pkg), "dist", "emscripten-module.cjs") };
    });
  },
};

export function sandboxBuildOptions(outfile: string, minify: boolean): BuildOptions {
  return {
    entryPoints: ["server/functions/sandbox/child.ts"],
    outfile,
    platform: "node",
    target: "node22",
    format: "cjs",
    bundle: true,
    minify,
    // Pyodide stays a directory of its own (dist/node_modules/pyodide): it
    // loads its WebAssembly and standard library from files next to it.
    external: ["pyodide"],
    plugins: [quickjsGlue],
    logLevel: "warning",
  };
}
