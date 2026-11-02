// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { IssueGroups } from "./issue-groups";

beforeAll(() => loadCatalog("ko"));

test("review groups omit zero counts while retaining served nonzero counts", () => {
  const html = renderToStaticMarkup(<IssueGroups groups={[
    { kind: "LATE", count: 37, oldest_date: "2026-10-04" },
    { kind: "NO_RECORD", count: 0, oldest_date: "2026-10-01" },
  ]} onSelect={() => {}} />);
  expect(html).toContain(t("attendanceRecords.mark.LATE"));
  expect(html).toContain("37");
  expect(html).not.toContain(t("attendanceRecords.mark.NO_RECORD"));
});
