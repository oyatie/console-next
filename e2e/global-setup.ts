import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resetLifecycleDate } from "./clock";
import { publishTestTerms } from "./terms-fixture";
import { CACHE_DIR, PORTS } from "./slot";

export default async function globalSetup() {
  // E2E_REUSE=1 may have found a backend already running (webServer starts first): refuse a stale binary.
  if (process.env.E2E_REUSE === "1") {
    const booted = JSON.parse(readFileSync(path.join(CACHE_DIR, "backend.json"), "utf8"));
    if (statSync(booted.bin).mtimeMs !== booted.binMtimeMs)
      throw new Error("backend binary changed since the server started; stop it or run without E2E_REUSE");
  }
  // The suite reads workspace routes; an MVP binary otherwise reports unrelated specs as product failures.
  const inbox = await fetch(`http://127.0.0.1:${PORTS.backend}/api/v1/me/action-inbox`);
  if (inbox.status !== 401)
    throw new Error(`E2E action-inbox expected 401, got ${inbox.status}; build console-app with --features full,e2e-test-support and set CONSOLE_APP_BIN to that binary`);
  // A run that stopped mid-test may have left the backend's apply date moved forward.
  resetLifecycleDate();
  await publishTestTerms();
}
