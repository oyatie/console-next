// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";

export function postgresImage() {
  const pin = readFileSync(new URL("../../backend/ci/gates/writer-ownership/tests/census_executes_against_postgres.rs", import.meta.url), "utf8").match(/postgres:[\w.-]+@sha256:[a-f0-9]{64}/)?.[0];
  if (!pin) throw new Error("missing pinned PostgreSQL image");
  return pin;
}

export function parseDbContract(sql) {
  const admin = sql.match(/CURRENT_USER <> '([a-z0-9_]+)'/)?.[1];
  const key = sql.match(/current_setting\('([a-z0-9_.]+)', true\)/)?.[1];
  const marker = sql.match(/v_sqlx_test_bootstrap IS DISTINCT FROM '([a-z0-9-]+)'/)?.[1];
  if (!admin || !key || !marker) throw new Error("SQLx bootstrap contract changed; review the migration before running DB tests");
  return { admin, key, marker };
}

export const dbContract = () => parseDbContract(readFileSync(new URL("../../backend/crates/platform/db/migrations/0196_platform_force_command_and_fk_closure.sql", import.meta.url), "utf8"));

export function sqlxUrl(value, contract = dbContract()) {
  const url = new URL(value);
  url.searchParams.set("options", `-c ${contract.key}=${contract.marker}`);
  return url.href;
}
