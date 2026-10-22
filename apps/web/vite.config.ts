import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

// Same-origin: the backend has no CORS layer and the refresh cookie is SameSite=Strict,
// so dev proxies /api (incl. the /api/v1/ws upgrade) and prod serves both from one host.
const backend = process.env.CONSOLE_BACKEND ?? "http://127.0.0.1:8090";
// A worktree may link its packages from another checkout's node_modules; serve their real files too (the fonts).
// On a checkout with its own node_modules this is the workspace's own folder again.
const deps = dirname(realpathSync(resolve(import.meta.dirname, "../../node_modules/pretendard")));

export default defineConfig({
  plugins: [react()],
  // The backend CSP allows fonts/images only from 'self' (no data: URIs), so never inline assets.
  build: { assetsInlineLimit: 0 },
  // CONSOLE_WEB_PORT: an E2E slot other than 0 (e2e/slot.ts) serves on its own port, with its own dep cache
  // so two dev servers in one worktree never race on the same optimizer output.
  cacheDir: resolve(import.meta.dirname, `../../.cache/vite-${process.env.CONSOLE_WEB_PORT ?? "dev"}`),
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), deps] }, port: Number(process.env.CONSOLE_WEB_PORT ?? 5173), strictPort: true, proxy: { "/api": { target: backend, ws: true }, "/__e2e": { target: backend } } },
});
