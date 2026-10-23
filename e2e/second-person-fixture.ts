// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { PORTS } from "./slot";
import { readDevSecrets } from "../scripts/dev-secrets";

/**
 * Lets time pass for `person`'s grants in `slug`'s tenant: their ledger rows and the tenant's roles move 400 days into
 * the past, so a grant made and noticed through the UI is as old as `authz.second_person.min_grant_age` requires
 * (decisions D0.2). Nothing else: the grant, its scope and the holder's notice go through the 권한 screen and Home.
 * shortcut: eligibility SQL still uses wall time; replace ageing when all readers share the kernel clock.
 * See e2e/TESTING.md. No screen can age a grant, so this fixture stands in for the calendar alone.
 */
export function letGrantsAge(slug: string, person: string) {
  execFileSync("psql", ["-X", "--set", "ON_ERROR_STOP=1", "--set", `slug=${slug}`, "--set", `person=${person}`, "--dbname", "console_dev"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(PORTS.pg), PGUSER: "console_app", PGPASSWORD: readDevSecrets().postgresAppPassword },
    input: `BEGIN;
SELECT set_config('app.current_org', id::text, true) FROM organizations WHERE slug = :'slug';
UPDATE authz_grant_ledger SET occurred_at = occurred_at - interval '400 days'
 WHERE user_id = (SELECT id FROM users WHERE org_id = current_setting('app.current_org')::uuid AND display_name = :'person');
UPDATE access_roles SET updated_at = updated_at - interval '400 days' WHERE org_id = current_setting('app.current_org')::uuid;
COMMIT;`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Advance only this tenant's pending-grant worker clock to the configured deadline.
 * The debug server reads these per-tenant files; release builds never read them.
 * No grant data is written and other tenants' clocks stay put.
 */
export async function activatePendingGrants(page: import("@playwright/test").Page, token: () => string) {
  const { expect } = await import("@playwright/test");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { LIFECYCLE_TODAY_FILE } = await import("./clock");
  const { apiOf } = await import("./helpers/api");
  const api = apiOf(page, token);
  const read = async () => {
    const response = await api("/access/grants");
    expect(response.ok()).toBeTruthy();
    return await response.json() as { id: string; activates_at?: string | null; enforcement: string }[];
  };
  const grants = (await read()).filter((g) => g.activates_at);
  if (!grants.length) return;
  const org = (JSON.parse(Buffer.from(token().split(".")[1]!, "base64url").toString()) as { org: string }).org;
  const clockDirectory = `${LIFECYCLE_TODAY_FILE}.grants`;
  mkdirSync(clockDirectory, { recursive: true });
  // JavaScript drops sub-millisecond precision; move just past the latest server deadline.
  const at = new Date(Math.max(...grants.map((g) => Date.parse(g.activates_at!))) + 1).toISOString();
  writeFileSync(`${clockDirectory}/${org}`, at);
  await expect.poll(async () => (await read()).filter((g) => grants.some((pending) => pending.id === g.id) && g.enforcement === "SCHEDULED").length).toBe(0);
}
