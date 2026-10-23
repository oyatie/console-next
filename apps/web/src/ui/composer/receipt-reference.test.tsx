// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ReceiptReference } from "./receipt-reference";

beforeAll(() => loadCatalog("ko"));
test("a receipt exposes the server reference intact and omits absent references", () => {
  const html = renderToStaticMarkup(<ReceiptReference value="ORG-2026-42" />);
  expect(html).toContain("접수 번호");
  expect(html).toContain("<code>ORG-2026-42</code>");
  expect(html).toContain("접수 번호 복사");
  expect(renderToStaticMarkup(<ReceiptReference value="" />)).toBe("");
});
