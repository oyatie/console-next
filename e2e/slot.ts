import path from "node:path";

/**
 * One E2E stack per slot (E2E_SLOT, set by scripts/e2e-slot.mjs): its own ports, compose project, cache and
 * output directory, so two runs on one machine never share a database, a passkey file or the lifecycle clock.
 * Slot 0 keeps the historical values, so runs from branches that predate slots still pair with it.
 */
export const SLOT = Number(process.env.E2E_SLOT ?? 0);
const suffix = SLOT === 0 ? "" : `-${SLOT}`;
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/** Agent runs (scripts/e2e-slot.mjs sets E2E_AGENT) never use 5173, where a person's own dev server may run. */
export const AGENT = !!process.env.E2E_AGENT;
/**
 * Every fixed port stays below this: from here up the colima VM (Linux, 32768–60999) and macOS (49152–65535) hand
 * out ephemeral ports, so a container published on a random host port (tools/lanes/pgtest.sh `-p 127.0.0.1::5432`)
 * or any outgoing socket can hold a slot's port while that slot is down, and its `compose up` then fails with
 * "address already in use" (slot 2's Postgres on 55452, 2026-10-14). Below it only a fixed assignment takes a port.
 */
const EPHEMERAL_FLOOR = 32768;
/** A slot's own ports (an agent's Vite skips 5173); the steps of 10 keep slots 0–9 apart. */
const slotPorts = (slot: number, agent = AGENT) => ({
  web: agent ? 5180 + slot : 5173 + slot,
  backend: 8090 + slot,
  pg: 25432 + slot * 10,
  s3: 28333 + slot * 10,
  otel: 24317 + slot * 10,
  smtp: 1025 + slot * 10,
  mailUi: 18025 + slot * 10, // 8025 + 10 × slot met slot 5's backend at 8095
});
const ENV = { web: "CONSOLE_WEB_PORT", backend: "CONSOLE_DEV_BACKEND_PORT", pg: "CONSOLE_DEV_PG_PORT", s3: "CONSOLE_DEV_S3_PORT", otel: "CONSOLE_DEV_OTEL_PORT", smtp: "CONSOLE_MAILPIT_SMTP_PORT", mailUi: "CONSOLE_MAILPIT_UI_PORT" } as const;
const fixed = Object.entries(slotPorts(SLOT)).filter(([, p]) => p >= EPHEMERAL_FLOOR);
if (fixed.length) throw new Error(`e2e/slot.ts: slot ${SLOT}'s ${fixed.map(([k, p]) => `${k} ${p}`).join(", ")} must stay below ${EPHEMERAL_FLOOR}`);
/** This run's ports: the slot's, each overridable by its environment variable (the demo stack sets them all). */
export const PORTS = Object.fromEntries(Object.entries(slotPorts(SLOT)).map(([k, v]) => [k, port(ENV[k as keyof typeof ENV], v)])) as ReturnType<typeof slotPorts>;
export const COMPOSE_PROJECT = process.env.CONSOLE_DEV_PROJECT ?? `console-react-e2e${suffix}`;
export const CACHE_DIR = path.resolve(`.cache/console-e2e${suffix}`);
export const OUTPUT_DIR = path.resolve(`test-results${suffix}`);
