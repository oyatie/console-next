// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { DueCell } from "./due-cell";

beforeAll(() => loadCatalog("ko"));

test("DueCell maps negative, zero, near, far, and null days to non-colour icons and tones", () => {
  const over = renderToStaticMarkup(<DueCell days={-3} fill />);
  expect(over).toContain('data-tone="over"');
  expect(over).toContain('data-fill="true"');
  expect(over).toContain("<svg");
  expect(over).toContain(t("uiDeadlineChip.over", { days: 3 }));

  const today = renderToStaticMarkup(<DueCell days={0} />);
  expect(today).toContain('data-tone="today"');
  expect(today).toContain("<svg");
  expect(today).toContain(t("uiWorklist.today"));

  expect(renderToStaticMarkup(<DueCell days={4} />)).toContain('data-tone="near"');
  expect(renderToStaticMarkup(<DueCell days={15} />)).toContain('data-tone="far"');
  expect(renderToStaticMarkup(<DueCell days={null} />)).toContain('data-tone="undated"');

  const nanHtml = renderToStaticMarkup(<DueCell days={Number.NaN} />);
  expect(nanHtml).toContain('data-tone="undated"');
  expect(nanHtml).toContain('value=""');
  expect(nanHtml).toContain(t("uiWorklist.undated"));
});
