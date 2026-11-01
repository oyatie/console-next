// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Context } from "./unit-parts";

beforeAll(() => loadCatalog("ko"));
test("proposal counts offer the shared definition without standing prose", () => {
  const html = renderToStaticMarkup(<Context headcount rows={[{ label: "인원", value: "3명" }]} />);
  expect(html).toContain('aria-label="' + t("structure.headcount.explain") + '"');
  expect(html).toContain("3명");
  expect(html).not.toContain(t("structure.headcount.basis"));
  expect(renderToStaticMarkup(<Context rows={[]} />)).not.toContain("<button");
});
