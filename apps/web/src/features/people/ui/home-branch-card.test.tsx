import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { HomeBranchCard } from "./home-branch-card";

const { queries } = vi.hoisted(() => ({ queries: new Map<string, object>() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (key: string) => queries.get(key) ?? {} }));
vi.mock("../../../reference/org/api", () => ({ branchesQuery: "branches" }));
vi.mock("../../../reference/entity/api", () => ({ assignmentsRef: () => "assignments", workplacesRef: "workplaces" }));
vi.mock("../api", () => ({ employeeQuery: () => "employee", assignHomeBranch: vi.fn(), isStale: () => false }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({}) }));
vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-10-09" }));

beforeAll(() => loadCatalog("en"));
beforeEach(() => {
  queries.clear();
  queries.set("branches", { isSuccess: true, data: [{ id: "hq", name: "HQ" }, { id: "plant", name: "Plant" }] });
  queries.set("assignments", { isSuccess: true, data: { items: [{ workplace_id: "hq-site", valid_from: "2026-01-01", valid_to: null }] } });
  queries.set("workplaces", { isSuccess: true, data: { items: [{ id: "hq-site", default_branch_id: "hq" }] } });
});
const card = (home: string | null = "hq") => renderToStaticMarkup(<HomeBranchCard e={{ id: "person", home_branch_id: home, home_branch_name: home, updated_at: "2026-10-09T00:00:00Z" } as Parameters<typeof HomeBranchCard>[0]["e"]} manage />);

test("a placed person cannot pick another workplace's branch", () => {
  expect(card()).not.toContain('type="radio"');
  expect(card()).not.toContain("Plant");
  const missing = card(null);
  expect(missing).toContain("HQ");
  expect(missing).not.toContain("Plant");
});

test("pending or failed placement reads never offer unrestricted branches", () => {
  for (const path of ["assignments", "workplaces"]) {
    queries.set(path, { isSuccess: false });
    expect(card(null)).not.toContain('type="radio"');
  }
});

test("an unplaced person's branch choice and a future placement stay available", () => {
  for (const items of [[], [{ workplace_id: "hq-site", valid_from: "2026-11-01", valid_to: null }]]) {
    queries.set("assignments", { isSuccess: true, data: { items } });
    expect(card(null)).toContain("HQ");
    expect(card(null)).toContain("Plant");
  }
});
