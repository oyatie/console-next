#!/usr/bin/env node
// Local backend for the client: mirrors <backend>/scripts/dev-up.mjs (same compose project,
// ports, roles and dev secrets) but runs a Cargo-built `console-app` instead of Buck2.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { supportLogs } from "./e2e-support-logs.mjs";
import { PORTS } from "../e2e/slot.ts";
import { DEV_SECRETS_FILE, ensureDevSecrets } from "./dev-secrets.ts";
import { backendReady, reapOrphanListener, startBackend, stopBackend } from "./backend-process.mjs";

// The backend tree: this repository when it carries backend/ (the public monorepo), else the sibling checkout.
const CONSOLE = path.resolve(process.env.CONSOLE_REPO ?? (existsSync("backend/Cargo.toml") ? "." : "../frontend/backend-mvp"));
const BIN = path.resolve(process.env.CONSOLE_APP_BIN ?? path.join(CONSOLE, "backend/target/debug/console-app"));
const WEB_ORIGIN = process.env.CONSOLE_WEB_ORIGIN ?? "http://localhost:5173";
// The ports come from e2e/slot.ts, their one source: the E2E slot's (E2E_SLOT, slot 0 when unset), each overridden by
// its environment variable, so a second stack (e.g. `npm run demo`) sets every port and the compose project and never
// shares a database with test runs.
const PORT = PORTS;
const PROJECT = process.env.CONSOLE_DEV_PROJECT ?? "console-react-e2e";
// The E2E slot's cache (e2e/slot.ts sets it); the default is slot 0's.
const CACHE = process.env.E2E_CACHE_DIR ?? path.resolve(new URL("../.cache/console-e2e", import.meta.url).pathname);
const RECORD = path.join(CACHE, "backend.json");
await reapOrphanListener(PORT.backend, RECORD);
const DB = "console_dev";
const secrets = ensureDevSecrets();
const PW = {
  admin: secrets.postgresAdminPassword,
  app: secrets.postgresAppPassword,
  rt: secrets.postgresRuntimePassword,
  leave: secrets.postgresLeaveCommandPassword,
  ontology: secrets.postgresOntologyCommandPassword,
  force: secrets.postgresPlatformForceCommandPassword,
};
const pg = (user, pw) => `postgres://${user}:${pw}@127.0.0.1:${PORT.pg}/${DB}`;

// Own Docker VM (colima profile console-test) when present, so E2E never lands in whatever
// context another session made current.
const dockerContext =
  process.env.DOCKER_CONTEXT ??
  (spawnSync("docker", ["context", "inspect", "colima-console-test"], { stdio: "ignore" }).status === 0
    ? "colima-console-test"
    : undefined);
const composeEnv = {
  ...process.env,
  ...(dockerContext ? { DOCKER_CONTEXT: dockerContext } : {}),
  CONSOLE_POSTGRES_PORT: String(PORT.pg),
  CONSOLE_POSTGRES_DB: DB,
  CONSOLE_POSTGRES_ADMIN_USER: "console_cluster_admin",
  CONSOLE_POSTGRES_ADMIN_PASSWORD: PW.admin,
  CONSOLE_APP_POSTGRES_PASSWORD: PW.app,
  CONSOLE_RT_POSTGRES_PASSWORD: PW.rt,
  CONSOLE_LEAVE_COMMAND_POSTGRES_PASSWORD: PW.leave,
  CONSOLE_ONTOLOGY_COMMAND_POSTGRES_PASSWORD: PW.ontology,
  CONSOLE_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD: PW.force,
  CONSOLE_S3_ACCESS_KEY_ID: secrets.s3AccessKeyId,
  CONSOLE_S3_SECRET_ACCESS_KEY: secrets.s3SecretAccessKey,
  CONSOLE_S3_PORT: String(PORT.s3),
  CONSOLE_OTEL_PORT: String(PORT.otel),
};
const compose = (args, opts = {}) =>
  spawnSync(
    "docker",
    ["compose", "-p", PROJECT, "-f", "ops/compose.yml", "-f", "ops/compose.dev.yml", "-f", "ops/compose.dev-deps.yml", ...args],
    { cwd: CONSOLE, env: composeEnv, stdio: "inherit", ...opts },
  );
const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status})`);
  console.log(`[boot] ${what} done at ${(performance.now() / 1000).toFixed(1)}s`);
};

function devKeys() {
  const dir = path.join(CONSOLE, "ops/.dev-secrets");
  const priv = path.join(dir, "jwt-private.pem");
  const pub = path.join(dir, "jwt-public.pem");
  if (!existsSync(priv)) {
    mkdirSync(dir, { recursive: true });
    const k = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(priv, k.privateKey, { mode: 0o600 });
    writeFileSync(pub, k.publicKey, { mode: 0o600 });
  }
  return [readFileSync(priv, "utf8"), readFileSync(pub, "utf8")];
}

/**
 * The resident registration number vault keys (IMPORT-2): base64 of 32 random bytes each, made once per checkout like
 * the JWT pair (a restart must open what an earlier run sealed). Never printed; an env value wins.
 */
function rrnKeys() {
  const dir = path.join(CONSOLE, "ops/.dev-secrets");
  const key = (name) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    return readFileSync(file, "utf8").trim();
  };
  return { CONSOLE_RRN_MASTER_KEY: process.env.CONSOLE_RRN_MASTER_KEY ?? key("rrn-master.key"), CONSOLE_RRN_HMAC_KEY: process.env.CONSOLE_RRN_HMAC_KEY ?? key("rrn-hmac.key") };
}

function appEnv(role) {
  const [priv, pub] = devKeys();
  return {
    ...process.env,
    CONSOLE_APP_ROLE: role,
    DATABASE_URL: role === "migrate" ? pg("console_app", PW.app) : pg("console_rt", PW.rt),
    LEAVE_COMMAND_DATABASE_URL: pg("console_leave_cmd", PW.leave),
    ONTOLOGY_COMMAND_DATABASE_URL: pg("console_ontology_cmd", PW.ontology),
    CONSOLE_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD: PW.force,
    PLATFORM_FORCE_COMMAND_DATABASE_URL: pg("console_platform_force_cmd", PW.force),
    ...(role === "api" && process.env.CONSOLE_EMAIL_STUB_MODE === "e2e"
      ? { CONSOLE_E2E_FIXTURE_DATABASE_URL: pg("console_app", PW.app) }
      : {}),
    CONSOLE_HTTP_ADDR: `${process.env.E2E_LINUX_VISUAL === "1" && process.env.CONSOLE_EMAIL_STUB_MODE === "e2e" ? "0.0.0.0" : "127.0.0.1"}:${PORT.backend}`,
    CONSOLE_EMAIL_STUB_MODE: process.env.CONSOLE_EMAIL_STUB_MODE ?? "dev",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT.otel}`,
    OTEL_SERVICE_NAME: "console-app-dev",
    CONSOLE_S3_ENDPOINT_URL: `http://127.0.0.1:${PORT.s3}`,
    CONSOLE_S3_REGION: "us-east-1",
    CONSOLE_S3_ACCESS_KEY_ID: secrets.s3AccessKeyId,
    CONSOLE_S3_SECRET_ACCESS_KEY: secrets.s3SecretAccessKey,
    CONSOLE_S3_PRIMARY_BUCKET: "mnt-evidence",
    CONSOLE_S3_REPLICA_BUCKET: "mnt-evidence-replica",
    CONSOLE_S3_FORCE_PATH_STYLE: "true",
    ...rrnKeys(),
    CONSOLE_JWT_PRIVATE_KEY_PEM: priv,
    CONSOLE_JWT_PUBLIC_KEY_PEM: pub,
    CONSOLE_JWT_ISSUER: "console-dev",
    CONSOLE_JWT_AUDIENCE: "console",
    // The browser talks to Vite (same-origin proxy), so WebAuthn's RP origin is the web origin.
    CONSOLE_WEBAUTHN_RP_ID: "localhost",
    CONSOLE_WEBAUTHN_RP_ORIGIN: WEB_ORIGIN,
    CONSOLE_WEBAUTHN_RP_NAME: "Console (dev)",
    CONSOLE_COOKIE_SECURE: "false",
    CONSOLE_COLDSTART_OTP: secrets.coldstartOtp,
    RUST_LOG: process.env.RUST_LOG ?? "info",
    SQLX_OFFLINE: "true",
  };
}

const bucket = (name) =>
  new Promise((ok) => {
    const req = http.request({ host: "127.0.0.1", port: PORT.s3, path: `/${name}`, method: "PUT" }, (r) => (r.resume(), ok()));
    req.on("error", ok);
    req.end();
  });

if (!existsSync(BIN)) throw new Error(`no backend binary at ${BIN}; build with \`cargo build -p console-app\` (add --features full,e2e-test-support for the complete E2E suite) or set CONSOLE_APP_BIN`);

// --reset: start from an empty database (E2E runs the whole onboarding path, and the
// cold-start code is single-use).
if (process.argv.includes("--reset")) {
  must(compose(["down", "-v"]), "reset");
  // The vendor's passkey (e2e/flows.ts) belongs to the database just dropped.
  rmSync(path.join(CACHE, "vendor-passkey.json"), { force: true });
}
const deps = ["postgres", "seaweedfs", "otel-collector", "mailpit"];
must(compose(["up", "-d", "--wait", ...deps]), "compose up");
await bucket("mnt-evidence");
await bucket("mnt-evidence-replica");
must(compose(["run", "--rm", "postgres-topology"]), "db topology");
must(spawnSync(BIN, [], { cwd: CONSOLE, env: appEnv("migrate"), stdio: "inherit" }), "migrations");
// E2E's database is dropped every run: its commits need not wait for the WAL to reach disk. In the shared Docker VM
// that fsync stalled every commit for 5–17 s at once (rs3), failing whichever tests were writing. Set before the
// API starts, so its connections inherit it; the demo stack leaves it unset.
if (process.env.CONSOLE_DEV_ASYNC_COMMIT === "1")
  must(
    compose(["exec", "-T", "postgres", "psql", "-U", "console_cluster_admin", "-d", DB, "-v", "ON_ERROR_STOP=1",
      "-c", `ALTER DATABASE ${DB} SET synchronous_commit = off`]),
    "asynchronous commit",
  );
// Which binary this backend runs, for E2E_REUSE's stale-binary guard (e2e/global-setup.ts).
mkdirSync(CACHE, { recursive: true });
// No fixtures and no personas: the database holds only what the API itself creates.
console.log(`backend: http://127.0.0.1:${PORT.backend}  platform cold-start code: coldstartOtp in ${DEV_SECRETS_FILE}`);
// SIGUSR2 stops the API process and the next SIGUSR2 starts it again on the same database (a backend restart mid-flow,
// e2e/chaos-restart.spec.ts). Without the signal nothing changes: the launcher exits with its API process.
// Isolated E2E store: production always queries its configured VictoriaLogs service.
const supportLogFixture = process.env.CONSOLE_EMAIL_STUB_MODE === "e2e" && !process.env.CONSOLE_SUPPORT_LOG_QUERY_URL ? await supportLogs() : null;
let api = null;
let up = true;
const startApi = () => {
  const child = startBackend(BIN, { cwd: CONSOLE, env: { ...appEnv("api"), ...(supportLogFixture ? { CONSOLE_SUPPORT_LOG_QUERY_URL: supportLogFixture.url } : {}) }, stdio: supportLogFixture ? ["inherit", "pipe", "inherit"] : "inherit" });
  // `pid` is the restart signal target; `apiPid` ties orphan cleanup to this slot's launcher.
  writeFileSync(RECORD, JSON.stringify({ bin: BIN, binMtimeMs: statSync(BIN).mtimeMs, pid: process.pid, apiPid: child.pid }));
  if (supportLogFixture) {
    child.stdout.pipe(process.stdout);
    supportLogFixture.observe(child.stdout);
  }
  child.on("exit", (c) => {
    if (!child.stopping) process.exit(c ?? 1);
    api = null;
    if (up) startApi(); // started again while this one was still stopping
  });
  api = child;
};
startApi();
setInterval(() => {}, 2 ** 30); // a signal handler alone does not keep the launcher alive while its API is stopped
process.on("SIGUSR2", () => {
  up = !up;
  if (!up && api) (api.stopping = true), stopBackend(api);
  else if (up && !api) startApi();
});
if (process.env.CONSOLE_EMAIL_STUB_MODE === "e2e") {
  // Playwright owns this pipe: EOF also cleans up when its runner crashes or is killed.
  process.stdin.on("end", () => process.exit(1));
  process.stdin.resume();
  await backendReady(PORT.backend);
  console.log("[backend] ready");
}
