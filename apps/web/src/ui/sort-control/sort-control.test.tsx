// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { SortControl } from "./sort-control";

beforeAll(() => loadCatalog("ko"));

test("SortControl renders a single-button toggle for one field and a select plus direction button for multiple fields", () => {
  const single = renderToStaticMarkup(
    <SortControl fields={[{ id: "due", label: "Due" }]} field="due" direction="asc" onChange={() => undefined} />,
  );
  expect(single).toContain(`role="group" aria-label="${t("uiLongTable.sort")}"`);
  expect(single).not.toContain("<select");
  expect(single).toContain(`aria-label="${t("uiLongTable.sort")}: Due (${t("uiLongTable.ascending")})"`);

  const multi = renderToStaticMarkup(
    <SortControl
      fields={[
        { id: "due", label: "Due" },
        { id: "name", label: "Name" },
      ]}
      field="name"
      direction="desc"
      onChange={() => undefined}
    />,
  );
  expect(multi).toContain("<select");
  expect(multi).toContain(`aria-label="Name · ${t("uiLongTable.descending")}"`);
});
