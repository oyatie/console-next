// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readDevSecrets } from "../../scripts/dev-secrets";
import { PORTS } from "../slot";

/** Capacity fixture: an outstanding review must be present during the Home budget probe. */
export function seedUnlockReview(bearer: string): string {
  const { org } = JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString()) as { org: string };
  const output = execFileSync("psql", ["-XqAt", "--set", "ON_ERROR_STOP=1", "--set", `org=${org}`, "--dbname", "console_dev"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(PORTS.pg), PGUSER: "console_app", PGPASSWORD: readDevSecrets().postgresAppPassword },
    input: `BEGIN;
SELECT set_config('app.current_org', :'org', true);
INSERT INTO users(org_id,display_name,roles)
SELECT :'org'::uuid,'일반 계정',ARRAY['MEMBER'] FROM generate_series(1,
  GREATEST(0,2000-(SELECT count(*)::int FROM users WHERE org_id=:'org'::uuid)));
WITH maker AS (
  SELECT id FROM users WHERE org_id=:'org'::uuid AND display_name='일반 계정' ORDER BY id LIMIT 1
), lock AS (
  INSERT INTO period_locks(org_id,domain,period_start,period_end,reason_code,
    unlocked_by,unlocked_at,unlock_reason_code,relock_at,unlock_review_required)
  SELECT :'org'::uuid,'accounting',CURRENT_DATE,CURRENT_DATE,'BOOKS_CLOSE',
    id,now(),'AUDIT_FINDING',now()+interval '1 day',true FROM maker RETURNING id,unlocked_by
)
INSERT INTO governed_exceptions(org_id,rule_code,risk,subject_type,subject_id,reason_code,
  fingerprint,settings_snapshot,requested_by,step_up_assertion_id,status,fallback_kind,
  review_due_at,expires_at,consumed_at)
SELECT :'org'::uuid,'PERIOD_UNLOCK_SOLE_HOLDER','HIGH','PERIOD_LOCK',id,'AUDIT_FINDING',
  repeat('a',64),'{}',unlocked_by,gen_random_uuid(),'RECORDED','SOLE_HOLDER',
  now()+interval '1 day',now()+interval '1 day',now() FROM lock RETURNING id;
COMMIT;`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  return output.trim().split("\n").at(-1)!;
}
