// SPDX-License-Identifier: LicenseRef-Proprietary
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { myAccessQuery } from "../../../reference/authz/api";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { settingsQuery } from "../../../reference/settings/api";
import { goLiveReceiptQuery } from "../api";
import { SetupReceipt } from "./setup-receipt";

const RECEIPT_NEED = operationAccess["GET /api/v1/onboarding/go-live/preview"];
const HISTORY_NEED = operationAccess["GET /api/v1/org-structure/batches"];

const state = vi.hoisted(() => ({
  phase: "OPERATING" as "SETUP" | "OPERATING",
  goLiveAt: "2026-11-04T09:00:00Z" as string | null,
  isOps: true,
  entries: [] as Array<{
    domain: string;
    level: string;
    enforcement: string;
    scope: { kind: string; include_descendants: boolean };
    grant_id: string;
    role_id: string;
    role_name_ko: string;
    valid_from: string;
    caveats: never[];
  }>,
  days: 7,
  employees: 23,
  canRegister: true,
  snapshotVersion: 1,
  updatedAt: Date.parse("2026-11-04T12:00:00Z"),
}));

vi.mock("../ui/use-setup", () => ({
  useSetupChecklist: () => ({
    phaseQ: {
      isError: false,
      error: null,
      dataUpdatedAt: state.updatedAt,
      data: {
        phase: state.phase,
        go_live_at: state.goLiveAt,
        done: 8,
        total: 8,
        summary: { people: 42, placed: 42, unplaced: 0, entity_unknown: 0, progress: 100 },
        steps: [{
          key: "employees",
          group: "company",
          state: "done",
          action: "register",
          can_act: state.canRegister,
          needs: "org::edit",
          skippable: false,
          paths: ["one"],
          counts: { entities: 1, workplaces: 2, units: 5, people: 42, unplaced: 0, entity_unknown: 0 },
        }],
      },
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryFn?: unknown }) => {
    if (opts === myAccessQuery) {
      return {
        data: {
          account_id: "u1",
          is_ops: state.isOps,
          phase: state.phase,
          as_of: "2026-11-04T12:00:00Z",
          decisions: {},
          entries: state.entries,
        },
      };
    }
    if (opts === settingsQuery) {
      return {
        data: {
          can_change: false,
          items: state.days > 0 ? [{ key: "onboarding.receipt_days", value: state.days }] : [],
        },
      };
    }
    if (opts.queryFn === goLiveReceiptQuery.queryFn) return { data: {
      go_live_at: state.goLiveAt, facts_snapshot_version: state.snapshotVersion,
      facts_snapshot: { entities: 7, workplaces: 3, org_units: 8, employees: state.employees },
    } };
    return { data: undefined };
  },
}));

beforeAll(() => loadCatalog("ko"));
afterEach(() => {
  state.phase = "OPERATING";
  state.goLiveAt = "2026-11-04T09:00:00Z";
  state.isOps = true;
  state.entries = [];
  state.days = 7;
  state.employees = 23;
  state.canRegister = true;
  state.snapshotVersion = 1;
  state.updatedAt = Date.parse("2026-11-04T12:00:00Z");
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const render = () => renderToStaticMarkup(
  <RouterContextProvider router={router}>
    <SetupReceipt receiptNeed={RECEIPT_NEED} historyNeed={HISTORY_NEED} />
  </RouterContextProvider>,
);

test("renders post-go-live receipt link and setup history link on Home within the configured window", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  try {
    const html = render();
    expect(html).toContain("시작 시각");
    expect(html).not.toContain("운영을 시작했습니다");
    expect(html).toContain("운영 시작 당시");
    expect(html).not.toContain("현재");
    expect(html).toContain('href="/setup/go-live"');
    expect(html).toContain("운영 시작 기록 보기");
    expect(html).toContain('href="/org/history"');
    expect(html).toContain("23");
    expect(html).not.toContain("42");
    expect(html).not.toContain('href="/people/new"');
    expect(html).not.toMatch(/aria-label="운영 준비"/);
  } finally {
    vi.useRealTimers();
  }
});

test("omits unauthorized receipt links and hides outside the configured receipt window", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  try {
    state.isOps = false;
    expect(render()).toBe("");

    state.isOps = true;
    state.days = 0;
    expect(render()).toBe("");

    state.days = 2;
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    state.updatedAt = Date.parse("2026-11-08T12:00:00Z");
    expect(render()).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

test("a history-only viewer cannot see a cached receipt summary", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  try {
    state.isOps = false;
    state.entries = [{ domain: "org", level: "view", enforcement: "ENFORCED", scope: { kind: "TENANT", include_descendants: false }, grant_id: "grant", role_id: "role", role_name_ko: "Reader", valid_from: "2026-11-01T00:00:00Z", caveats: [] }];
    const html = render();
    expect(html).toContain('href="/org/history"');
    expect(html).not.toContain('href="/setup/go-live"');
    expect(html).not.toContain("운영 시작 당시");
    expect(html).not.toContain("23");
  } finally {
    vi.useRealTimers();
  }
});


test("a zero-employee receipt offers registration and import from the server checklist", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  try {
    state.employees = 0;
    const out = render();
    expect(out).toMatch(/class="btn btn--primary"[^>]*href="\/people\/new"/);
    expect(out).toContain('href="/people/import"');
    expect(out).toContain('href="/setup/go-live"');
    state.canRegister = false;
    expect(render()).not.toContain('href="/people/new"');
    state.canRegister = true;
    state.snapshotVersion = 2;
    expect(render()).not.toContain('href="/people/new"');
  } finally { vi.useRealTimers(); }
});
