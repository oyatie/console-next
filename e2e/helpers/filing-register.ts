// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { PORTS } from "../slot";
import { readDevSecrets } from "../../scripts/dev-secrets";

function sql(input: string, snapshot = "[]") {
  return execFileSync("psql", ["-X", "-At", "--set", "ON_ERROR_STOP=1", "--set", `snapshot=${snapshot}`, "--dbname", "console_dev"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(PORTS.pg), PGUSER: "console_app", PGPASSWORD: readDevSecrets().postgresAppPassword },
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Only in the serial @clock project: legal review has no tenant product control. */
export function releaseChangeRules() {
  const snapshot = sql("SELECT jsonb_agg(to_jsonb(r)) FROM statutory_filing_drafts r;");
  if (!Array.isArray(JSON.parse(snapshot)) || !JSON.parse(snapshot).length) throw new Error("Missing synthetic CHANGE register fixture");
  sql("UPDATE statutory_filing_drafts SET release_disposition='RELEASED',review_receipt_ref='synthetic-e2e-review',filing_rule=jsonb_set(filing_rule,'{applicability_unverified}','false');");
  return () => sql(`UPDATE statutory_filing_drafts r SET release_disposition=s.release_disposition,review_receipt_ref=s.review_receipt_ref,filing_rule=s.filing_rule
    FROM jsonb_populate_recordset(NULL::statutory_filing_drafts, :'snapshot'::jsonb) s WHERE r.code=s.code AND r.effective_from=s.effective_from;`, snapshot);
}
