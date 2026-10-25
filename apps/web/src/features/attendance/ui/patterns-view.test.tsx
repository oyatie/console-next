// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { type Pattern } from "../api";
import { PatternsView } from "./patterns-view";

const pattern: Pattern = {
  id: "01980b10-0000-7000-8000-000000000001", name: "주간 근무", kind: "WEEKLY",
  holiday_rule: "OFF", days: [], weekly_minutes: 2400, cycle_days: 7,
  night_work: false, status: "ACTIVE", people_today: 2, layers_active: 1,
  created_at: "2026-10-25T00:00:00Z", created_by_name: "관리자",
};

vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ isSuccess: true, isPending: false, data: { items: [pattern, { ...pattern, id: "retired", name: "종료한 근무", status: "RETIRED" }] } }),
}));
beforeAll(() => loadCatalog("ko"));

function renderPatterns() {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PatternsView onAdd={() => {}} onRetired={() => {}} /></QueryClientProvider>);
  client.clear();
  return html;
}

test("unserved work regimes and pilot copy are absent", () => {
  const html = renderPatterns();
  for (const kind of ["FLEXIBLE", "SELECTIVE", "DEEMED", "DISCRETIONARY"] as const) {
    expect(html).not.toContain(t(`attendancePatterns.kind.${kind}`));
  }
  expect(html).not.toContain("파일럿 이후");
});

test("served patterns keep their add, retire and retired-record controls", () => {
  const html = renderPatterns();
  expect(html).toContain(pattern.name);
  expect(html).toContain(t("attendancePatterns.types.add"));
  expect(html).toContain(t("attendancePatterns.types.retireOne", { name: pattern.name }));
  expect(html).toContain(t("attendancePatterns.types.showRetired"));
  expect(html).not.toContain("종료한 근무");
});
