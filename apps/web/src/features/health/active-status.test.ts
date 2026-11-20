// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import {
  DEFAULT_STATUS_ORIGIN,
  fetchActiveStatus,
  healthStatus,
  parseActiveStatus,
  pickLocalized,
  resolveStatusOrigin,
} from "./api/active-status";

const NOW = Date.parse("2026-11-20T09:00:00Z");
const FUTURE = "2026-11-20T09:10:00Z";
const PAST = "2026-11-20T08:59:59Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("resolveStatusOrigin accepts https or loopback http and rejects unsafe inputs", () => {
  expect(resolveStatusOrigin()).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.example.test:8443")).toBe("https://status.example.test:8443");
  expect(resolveStatusOrigin("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
  expect(resolveStatusOrigin("http://status.example.test")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.example.test/path")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("javascript:alert(1)")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://*.cosskorea.com")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://sub.*.cosskorea.com")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.cosskorea.com;evil")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.\ncosskorea.com")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.cosskorea.com:0")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.cosskorea.com/.")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.cosskorea.com/..")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://@status.cosskorea.com")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.cosskorea.com%3B")).toBe(DEFAULT_STATUS_ORIGIN);
  expect(resolveStatusOrigin("https://status.cosskorea.com\uFF1Bevil.test")).toBe(DEFAULT_STATUS_ORIGIN);
});

test("null, expired, invalid schema, or all-unknown evidence resolves to unknown without claiming outage", () => {
  const base = {
    schema: 1,
    evidence_expires_at: FUTURE,
    components: {
      api: { name: { ko: "API", en: "API" }, status: "major", vantage_count: 1 },
    },
    incidents: [],
  };
  expect(parseActiveStatus({ ...base, evidence_expires_at: null }, NOW)).toEqual({ kind: "unknown" });
  expect(parseActiveStatus({ ...base, evidence_expires_at: PAST }, NOW)).toEqual({ kind: "unknown" });
  expect(parseActiveStatus({ ...base, evidence_expires_at: "not-a-date" }, NOW)).toEqual({ kind: "unknown" });
  expect(parseActiveStatus({ ...base, schema: 2 }, NOW)).toEqual({ kind: "unknown" });
  expect(parseActiveStatus(null, NOW)).toEqual({ kind: "unknown" });
  expect(
    parseActiveStatus(
      {
        schema: 1,
        evidence_expires_at: FUTURE,
        components: { api: { name: { ko: "API", en: null }, status: "unknown" } },
        incidents: [],
      },
      NOW,
    ),
  ).toEqual({ kind: "unknown" });
});

test("classifies major, partial, and degraded outages with incident title and affected components", () => {
  const parsed = parseActiveStatus(
    {
      schema: 1,
      evidence_expires_at: FUTURE,
      components: {
        web: { name: { ko: "Web Console KO", en: "Web Console" }, status: "ok" },
        api: { name: { ko: "API KO", en: "API" }, status: "major" },
        live: { name: { ko: "Realtime KO", en: null }, status: "partial" },
      },
      incidents: [
        {
          id: "ST-0001",
          title: { ko: "API outage KO", en: "API outage" },
          stage: "investigating",
          components: { api: "major", live: "partial" },
        },
        {
          id: "ST-0000",
          title: { ko: "Old KO", en: "Old" },
          stage: "resolved",
          components: { web: "major" },
        },
      ],
    },
    NOW,
  );
  expect(parsed).toEqual({
    kind: "outage",
    severity: "major",
    title: { ko: "API outage KO", en: "API outage" },
    affected: [
      { ko: "API KO", en: "API" },
      { ko: "Realtime KO", en: null },
    ],
    expiresAtMs: Date.parse(FUTURE),
  });
  if (parsed.kind === "outage") {
    expect(pickLocalized(parsed.title!, "ko")).toBe("API outage KO");
    expect(pickLocalized(parsed.title!, "en")).toBe("API outage");
    expect(pickLocalized(parsed.affected[1]!, "en")).toBe("Realtime KO");
  }
});

test("ok and maint states return ok without outage banner", () => {
  expect(
    parseActiveStatus(
      {
        schema: 1,
        evidence_expires_at: FUTURE,
        components: { web: { name: { ko: "Web KO", en: "Web" }, status: "maint" } },
        incidents: [],
      },
      NOW,
    ),
  ).toEqual({ kind: "ok", expiresAtMs: Date.parse(FUTURE) });
});

test("fetchActiveStatus resolves to unknown on network or HTTP failures", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  expect(await fetchActiveStatus(undefined, NOW)).toEqual({ kind: "unknown" });

  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  }));
  expect(await fetchActiveStatus(undefined, NOW)).toEqual({ kind: "unknown" });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const MAJOR_PAYLOAD = {
  schema: 1,
  evidence_expires_at: "2099-01-01T00:00:00Z",
  components: { api: { name: { ko: "API", en: "API" }, status: "major" } },
  incidents: [],
};

const OK_PAYLOAD = {
  schema: 1,
  evidence_expires_at: "2099-01-01T00:00:00Z",
  components: { api: { name: { ko: "API", en: "API" }, status: "ok" } },
  incidents: [],
};

test("healthStatus.retry() aborts prior refreshActive() so slow earlier major cannot resurrect cleared outage", async () => {
  let resolveSlow!: (res: Response) => void;
  let slowSignal: AbortSignal | undefined;
  let calls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        slowSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>(resolve => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(jsonResponse(OK_PAYLOAD));
    }),
  );

  const unmount = healthStatus.mount(true);
  try {
    expect(calls).toBe(1);
    expect(slowSignal?.aborted).toBe(false);

    await healthStatus.retry();
    expect(calls).toBe(2);
    expect(slowSignal?.aborted).toBe(true);
    expect(healthStatus.get().outage).toBeNull();
    expect(healthStatus.get().retrying).toBe(false);

    resolveSlow(jsonResponse(MAJOR_PAYLOAD));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(healthStatus.get().outage).toBeNull();
  } finally {
    unmount();
  }
});

test("unmount during pending healthStatus.retry() aborts fetch and never leaks outage into next mount(true)", async () => {
  let resolveRetry!: (res: Response) => void;
  let retrySignal: AbortSignal | undefined;
  let calls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse(OK_PAYLOAD));
      if (calls === 2) {
        retrySignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>(resolve => {
          resolveRetry = resolve;
        });
      }
      return new Promise<Response>(() => {});
    }),
  );

  const unmount1 = healthStatus.mount(true);
  await Promise.resolve();

  const retryPromise = healthStatus.retry();
  expect(healthStatus.get().retrying).toBe(true);
  expect(retrySignal?.aborted).toBe(false);

  // Concurrent retry while one is already in-flight must be ignored.
  const secondRetry = healthStatus.retry();
  expect(calls).toBe(2);

  unmount1();
  expect(retrySignal?.aborted).toBe(true);
  expect(healthStatus.get().outage).toBeNull();
  expect(healthStatus.get().retrying).toBe(false);

  const unmount2 = healthStatus.mount(true);
  try {
    resolveRetry(jsonResponse(MAJOR_PAYLOAD));
    await Promise.all([retryPromise, secondRetry]);

    expect(healthStatus.get().outage).toBeNull();
    expect(healthStatus.get().retrying).toBe(false);
  } finally {
    unmount2();
  }
});
