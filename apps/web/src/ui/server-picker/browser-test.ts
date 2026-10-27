// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { browserTestOptimizeDeps } from "../../lib/browser-test";

/** Real DOM fixture shared by the picker keyboard and overlay regression suites. */
export async function pickerTestServer(name: string, source: string) {
  const entry = `/${name}.js`;
  const virtual = `\0${name}`;
  const server = await createServer({
    // A cold re-optimization mid-test would load React twice.
    optimizeDeps: browserTestOptimizeDeps,
    define: { "process.env.VIRT_ON": "true" },
    resolve: { dedupe: ["react", "react-dom"] },
    configFile: false, cacheDir: `.cache/${name}`, logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name,
      resolveId: id => id === entry ? virtual : undefined,
      load: id => id === virtual ? source : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== `/${name}`) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(`<html lang="ko"><title>Pickers</title><div id="root"></div><script type="module" src="${entry}"></script></html>`);
        });
      },
    }],
  });
  await server.listen();
  return server;
}
