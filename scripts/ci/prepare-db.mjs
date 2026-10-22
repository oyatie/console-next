// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dbContract, sqlxUrl } from "./db-contract.mjs";

const password = () => randomBytes(32).toString("hex");
const contract = dbContract();
const config = JSON.parse(readFileSync("scripts/ci/config.json", "utf8"));
const port = Number(process.env.PG_PORT);
if (!process.env.PG_ADMIN_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("missing service credentials or port");
const env = {
  POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "5432", POSTGRES_DB: config.database,
  POSTGRES_ADMIN_USER: contract.admin, POSTGRES_ADMIN_PASSWORD: process.env.PG_ADMIN_PASSWORD,
  CONSOLE_APP_POSTGRES_PASSWORD: password(), CONSOLE_RT_POSTGRES_PASSWORD: password(),
  CONSOLE_LEAVE_COMMAND_POSTGRES_PASSWORD: password(), CONSOLE_ONTOLOGY_COMMAND_POSTGRES_PASSWORD: password(),
  CONSOLE_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD: password(),
};
for (const [key, value] of Object.entries(env)) if (key.endsWith("PASSWORD")) process.stdout.write((`::add-mask::${value}`) + "\n");
writeFileSync(`${process.env.RUNNER_TEMP}/db.container.env`, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
const url = (role, secret) => `postgres://${role}:${encodeURIComponent(secret)}@127.0.0.1:${process.env.PG_PORT}/${config.database}`;
const exports = {
  DATABASE_URL: sqlxUrl(url(env.POSTGRES_ADMIN_USER, env.POSTGRES_ADMIN_PASSWORD), contract),
  CONSOLE_APALIS_ADMIN_DATABASE_URL: sqlxUrl(url(env.POSTGRES_ADMIN_USER, env.POSTGRES_ADMIN_PASSWORD), contract),
  CONSOLE_APALIS_OWNER_DATABASE_URL: url("console_app", env.CONSOLE_APP_POSTGRES_PASSWORD),
  CONSOLE_APALIS_RUNTIME_DATABASE_URL: url("console_rt", env.CONSOLE_RT_POSTGRES_PASSWORD),
  CONSOLE_TEST_RUNTIME_PASSWORD: env.CONSOLE_RT_POSTGRES_PASSWORD,
  CONSOLE_TEST_FORCE_PASSWORD: env.CONSOLE_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD,
};
for (const [key, value] of Object.entries(exports)) {
  process.stdout.write((`::add-mask::${value}`) + "\n");
  appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}
