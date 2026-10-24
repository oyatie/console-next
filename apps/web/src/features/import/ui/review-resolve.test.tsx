// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { ImportDryRun, ReviewItem } from "../domain/contract";
import { initialPicks } from "../domain/steps";
import { ReviewResolve } from "./review-resolve";

beforeAll(() => loadCatalog("ko"));

test("an early hire explains the opening-date placement and preserved hire date", () => {
  const item: ReviewItem = {
    id: "early#workplace_not_open_on_date", reason: "workplace_not_open_on_date", blocking: false,
    sheet: "명부", row: 2, cell: "C2", field: "hire_date", value: "2020-01-01", rows: 1,
  };
  const dry = { rows: [{ source_key: "early", sheet: "명부", row: 2, name: "김승계", outcome: "insert" }] } as ImportDryRun;
  const html = renderToStaticMarkup(<ReviewResolve item={item} dry={dry} picks={initialPicks()} busy={false} onResolve={() => undefined} onSheets={() => undefined} />);
  expect(html).toContain("김승계");
  expect(html).toContain("명부 시트 C2");
  expect(html).toContain("확인만");
  expect(html).toContain("사업장 배치는 2020-01-01부터 반영합니다. 입사일은 원본대로 유지합니다.");
  expect(html).not.toContain("<button");
});
