import { execFileSync } from "node:child_process";
import { PORTS } from "./slot";
import { readDevSecrets } from "../scripts/dev-secrets";

/**
 * Lets time pass for `person`'s grants in `slug`'s tenant: their ledger rows and the tenant's roles move 400 days into
 * the past, so a grant made and noticed through the UI is as old as `authz.second_person.min_grant_age` requires
 * (decisions D0.2). Nothing else: the grant, its scope and the holder's notice go through the 권한 screen and Home.
 * No screen can age a grant, so this fixture stands in for the calendar alone.
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
