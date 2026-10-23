import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resetLifecycleDate } from "./clock";
import { publishTestTerms } from "./terms-fixture";
import { CACHE_DIR } from "./slot";

export default async function globalSetup() {
  // E2E_REUSE=1 may have found a backend already running (webServer starts first): refuse a stale binary.
  if (process.env.E2E_REUSE === "1") {
    const booted = JSON.parse(readFileSync(path.join(CACHE_DIR, "backend.json"), "utf8"));
    if (statSync(booted.bin).mtimeMs !== booted.binMtimeMs)
      throw new Error("backend binary changed since the server started; stop it or run without E2E_REUSE");
  }
  // A run that stopped mid-test may have left the backend's apply date moved forward.
  resetLifecycleDate();
  await publishTestTerms();
}
