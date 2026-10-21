import { execFileSync } from "node:child_process";
import { expect, type Page, type Request } from "@playwright/test";
import { PORTS } from "./slot";
import { readDevSecrets } from "../scripts/dev-secrets";

/**
 * Until the page's API reads have been quiet for `quietMs` (the event stream aside, which never carries input). A
 * read still in flight carries the last input to the server, and a slower engine (Firefox) can be mid-load when a
 * test presses a key or moves the server's clock.
 */
export async function settled(page: Page, quietMs = 2_000) {
  let last = Date.now();
  const open = new Set<Request>();
  const api = (r: Request) => r.url().includes("/api/") && !r.url().includes("/api/v1/events");
  const start = (r: Request) => void (api(r) && (open.add(r), (last = Date.now())));
  const end = (r: Request) => void (api(r) && (open.delete(r), (last = Date.now())));
  page.on("request", start).on("requestfinished", end).on("requestfailed", end);
  try {
    await expect.poll(() => open.size === 0 && Date.now() - last >= quietMs, { timeout: 30_000, intervals: [250] }).toBe(true);
  } finally {
    page.off("request", start).off("requestfinished", end).off("requestfailed", end);
  }
}

const psql = (slug: string, sql: string, minutes = 0) =>
  execFileSync("psql", ["-X", "-At", "--set", "ON_ERROR_STOP=1", "--set", `slug=${slug}`, "--set", `minutes=${minutes}`, "--dbname", "console_dev"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(PORTS.pg), PGUSER: "console_app", PGPASSWORD: readDevSecrets().postgresAppPassword },
    input: `BEGIN;
SELECT set_config('app.current_org', id::text, true) FROM organizations WHERE slug = :'slug';
${sql}
COMMIT;`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

/** Seconds since the server last accepted input in `slug`'s most recently used live session. */
export const sinceServerInput = (slug: string) =>
  Number(
    psql(slug, `SELECT extract(epoch FROM clock_timestamp() - max(last_activity_at))::int FROM auth_refresh_token_families
 WHERE org_id = current_setting('app.current_org')::uuid AND revoked_at IS NULL;`)
      .split("\n")
      .find((line) => /^-?\d+$/.test(line)),
  );

/**
 * The server last accepted input in `slug`'s live sessions `minutes` ago (INF-03). The server's clock is real and its
 * idle timeout is at least 5 minutes, and a page clock only moves the browser's, so this is the one lever for "nobody
 * used it for that long" on the server. It waits for the page's reads to settle first: one still in flight would carry
 * input from before the gap (and be refused for it, ending the session). Nothing else is touched.
 */
export async function idleOnServer(page: Page, slug: string, minutes: number) {
  await settled(page);
  for (let attempt = 0; attempt < 5; attempt++) {
    psql(slug, `UPDATE auth_refresh_token_families SET last_activity_at = clock_timestamp() - make_interval(mins => :minutes)
 WHERE org_id = current_setting('app.current_org')::uuid AND revoked_at IS NULL;`, minutes);
    await new Promise((r) => setTimeout(r, 1_500));
    if (sinceServerInput(slug) >= minutes * 60) return;
  }
  throw new Error(`input kept reaching the server for ${slug}: it was never idle`);
}
