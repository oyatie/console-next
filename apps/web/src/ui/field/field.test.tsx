// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { FieldSet } from "./field";

beforeAll(() => loadCatalog("ko"));

test("an unlabeled field set preserves native locking and layout attributes without adding copy", () => {
  const html = renderToStaticMarkup(<FieldSet required={null} disabled className="exit-fields" id="exit-form"><input name="note" /></FieldSet>);
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  expect(html).toContain("exit-fields");
  expect(html).toContain('id="exit-form"');
  expect(html).not.toContain("<legend");
  expect(html).toContain('<input name="note"/>');
});

test("a labeled field set retains its requiredness marker", () => {
  const html = renderToStaticMarkup(<FieldSet label="Evidence" required><input /></FieldSet>);
  expect(html).toContain("<legend");
  expect(html).toContain("Evidence");
  expect(html).toContain(t("uiField.required"));
});

test("a group of individually labeled fields can have a legend without a duplicate marker", () => {
  const html = renderToStaticMarkup(<FieldSet label="Evidence" required={null}><input /></FieldSet>);
  expect(html).toContain("<legend");
  expect(html).toContain("Evidence");
  expect(html).not.toContain("data-marker");
});
