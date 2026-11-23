// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { ChangeRows } from "./change-rows";

beforeAll(() => loadCatalog("ko"));

test("ChangeRows renders a named definition list with subject, before, arrow, and after cells", () => {
  const html = renderToStaticMarkup(
    <ChangeRows items={[{ id: "1", subject: "Team", before: "18", after: "30" }]} />,
  );
  expect(html).toContain(`aria-label="${t("uiWorklist.changes")}"`);
  expect(html).toContain("<dt");
  expect(html).toContain(">18</dd>");
  expect(html).toContain(">30</dd>");
});
