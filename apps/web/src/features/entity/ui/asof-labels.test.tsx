// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import type { LegalEntity, RegularWorkers } from "@console/api/pending";
import { RecordAside } from "./record-aside";
import { RegularHeadcount } from "./regular-headcount";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-10-22" }));
beforeAll(() => loadCatalog("ko"));

test.each(["2026-09-01", "2026-11-01"])("record labels carry the snapshot date %s", (asOf) => {
  const r: RegularWorkers = { value: null, status: "HOLD", basis: "LSA_DECREE_7_2", live_headcount: 3, missing: [] };
  const e = { id: "entity", as_of: asOf, read_only: true, registrations: [], workplaces: [], scheduled: [] } as unknown as LegalEntity;
  const html = renderToStaticMarkup(<><RecordAside e={e} depts={0} docs={null} act={{} as Parameters<typeof RecordAside>[0]["act"]} onTab={() => undefined} /><RegularHeadcount {...{ r, asOf }} /></>);
  expect(html).toContain(`${fmtDate(asOf)} 기준 상태`);
  expect(html).toContain(`${fmtDate(asOf)} 재직`);
  expect(html).not.toMatch(/오늘\(|지금 상태|지금 재직/);
  expect(t("structure.caption", { date: asOf })).toContain(`${asOf} 기준`);
  expect(t("structure.caption", { date: asOf })).not.toContain("오늘");
});
