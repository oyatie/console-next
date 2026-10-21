// SPDX-License-Identifier: LicenseRef-Proprietary
// Local development secrets: random per checkout, made once, kept in a git-ignored mode-600 file and never printed
// (DECISIONS 2026-10-19T18:56:02Z items 1 and 3). backend-dev.mjs creates the file; E2E fixtures read it.
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_SECRETS_FILE = path.join(fileURLToPath(new URL("..", import.meta.url)), "ops/.dev-secrets/dev-secrets.json");

const PASSWORDS = [
  "postgresAdminPassword",
  "postgresAppPassword",
  "postgresRuntimePassword",
  "postgresLeaveCommandPassword",
  "postgresOntologyCommandPassword",
  "postgresPlatformForceCommandPassword",
  "s3SecretAccessKey",
] as const;
type DevSecrets = Record<(typeof PASSWORDS)[number] | "s3AccessKeyId" | "coldstartOtp", string>;
// No 0/O or 1/I: the code is read off a file and typed once.
const OTP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function fresh(): DevSecrets {
  const secrets = Object.fromEntries(PASSWORDS.map((name) => [name, randomBytes(32).toString("hex")]));
  return {
    ...secrets,
    s3AccessKeyId: randomBytes(10).toString("hex"),
    coldstartOtp: Array.from(randomBytes(8), (byte) => OTP_ALPHABET[byte & 31]).join(""),
  } as DevSecrets;
}

export function readDevSecrets(file = DEV_SECRETS_FILE): DevSecrets {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no readable dev secrets at ${file}; start the backend with scripts/backend-dev.mjs first`);
  }
  const names = [...PASSWORDS, "s3AccessKeyId", "coldstartOtp"];
  if (!names.every((name) => typeof value?.[name] === "string" && value[name] !== "")) throw new Error(`invalid dev secrets file: ${file}`);
  return value as DevSecrets;
}

/** The checkout's secrets, created on first use. A concurrent first use links one complete file; the other reads it. */
export function ensureDevSecrets(file = DEV_SECRETS_FILE): DevSecrets {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(fresh(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  if (!lstatSync(file).isFile()) throw new Error(`invalid dev secrets file: ${file}`);
  chmodSync(file, 0o600);
  return readDevSecrets(file);
}
