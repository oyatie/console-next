// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { FieldDiff, type FieldChange } from "./field-diff";

beforeAll(() => loadCatalog("ko"));

test("masking wins even when untyped transport data includes hidden values", () => {
  const untrusted = { field: "pay", label: "pay", masked: true, before: "secret before", after: "secret after" };
  const diff = html(<FieldDiff fields={[untrusted as FieldChange]} />);
  expect(diff).toContain(t("timeline.restricted"));
  expect(diff).not.toContain("secret");
  expect(diff).not.toContain("<details");
});

test("long text collapses under a keyboard-operable native disclosure; missing values are named", () => {
  const diff = html(<FieldDiff fields={[{ field: "note", label: "note", before: null, after: "x".repeat(181) }]} />);
  expect(diff).toContain(t("timeline.noValue"));
  expect(diff).toContain("<details");
  expect(diff).toContain(`<summary>${t("timeline.showFull")}</summary>`);
  expect(diff).not.toContain(" open=");
});
