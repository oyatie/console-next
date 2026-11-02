// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "vite";

const output = process.argv[2];
if (!output) throw new Error("usage: node scripts/d8-module-routes.mjs OUTPUT");

const server = await createServer({
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true },
  define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": JSON.stringify("production") },
});
try {
  const { routeTree } = await server.ssrLoadModule("/apps/web/src/routes/tree.ts");
  const { frame } = await server.ssrLoadModule("/apps/web/src/routes/app.ts");
  createRouter({ routeTree });
  const routes = frame.signIn.map(route => route.fullPath);
  if (!routes.length || routes.some(route => typeof route !== "string" || !route.startsWith("/"))) {
    throw new Error("public module routes are unreadable");
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ modules: [{ routes }] }, null, 2)}\n`);
} finally {
  await server.close();
}
