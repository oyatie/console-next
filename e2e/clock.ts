import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { OUTPUT_DIR } from "./slot";

/**
 * The backend's date for applying scheduled personnel actions (CONSOLE_DEV_LIFECYCLE_TODAY_FILE, honoured by a
 * debug `console-app` only): it applies events due on the later of the real KST date and the date in this file,
 * checking every second. Absent at boot. It is one clock for the whole backend, so a test that moves it is tagged
 * `@clock` (the "clock" project runs those alone, one at a time) and puts it back (`withLifecycleDate`).
 */
export const LIFECYCLE_TODAY_FILE = path.join(OUTPUT_DIR, ".lifecycle-today");

export const resetLifecycleDate = () => rmSync(LIFECYCLE_TODAY_FILE, { force: true });

/** Runs `body` with the backend's apply date moved forward to `ymd`, then moves it back (even on failure). */
export async function withLifecycleDate(ymd: string, body: () => Promise<void>) {
  if (test.info().project.name !== "clock") throw new Error("the lifecycle date is one clock for the whole backend: tag this test @clock");
  mkdirSync(path.dirname(LIFECYCLE_TODAY_FILE), { recursive: true });
  writeFileSync(LIFECYCLE_TODAY_FILE, ymd);
  try {
    await body();
  } finally {
    resetLifecycleDate();
  }
}
