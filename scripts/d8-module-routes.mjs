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
  const { frame, ROUTE_FLOORPLANS } = await server.ssrLoadModule("/apps/web/src/routes/app.ts");
  const router = createRouter({ routeTree });
  const routes = frame.signIn.map(route => route.fullPath);
  if (!routes.length || routes.some(route => typeof route !== "string" || !route.startsWith("/"))) {
    throw new Error("public module routes are unreadable");
  }
  const catalogue = new Set(ROUTE_FLOORPLANS);
  const appRoutes = Object.values(router.routesById).filter(route => route.id.startsWith("/app/")).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  if (!appRoutes.length || appRoutes.some(route => route.options.staticData?.floorplan != null && !catalogue.has(route.options.staticData.floorplan))) {
    throw new Error("app route floorplans are unreadable");
  }
  const floorplans = Object.fromEntries(appRoutes.map(route => [route.fullPath, route.options.staticData?.floorplan ?? null]));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ modules: [{ routes }], floorplans }, null, 2)}\n`);
} finally {
  await server.close();
}
