// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { MarkChip, MarkGlyph } from "./mark-chip";

beforeAll(() => loadCatalog("ko"));
test.each([MarkChip, MarkGlyph])("a status cell prints its word visibly (%s)", Component => {
  const html = renderToStaticMarkup(<Component mark="NO_RECORD" />);
  expect(html).toContain(t("attendanceRecords.mark.NO_RECORD"));
  expect(html).not.toContain("sr-only");
});
test.each([[1, 0], [0, 2], [0, 0]])("open totals omit zero glyphs (%s, %s)", (blocking, decision) => {
  const text = t("attendanceRecords.total.openValue", { blocking, decision });
  expect(text).not.toMatch(/[▲◆]0/);
  if (blocking) expect(text).toContain(`▲${blocking}`);
  if (decision) expect(text).toContain(`◆${decision}`);
});
