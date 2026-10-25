// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Composer } from "../../../ui/composer/composer";
import { trailPreviewSections, type TemplateItem } from "./lifecycle-trail-preview";

beforeAll(() => loadCatalog("ko"));
const item = (kind: string, key: string): TemplateItem => ({
  item_key: key, label: "서류 확인", kind, blocks_close: true,
  legal_review_required: true, due_rule_kind: "DAY_OF_NEXT_MONTH", due_anchor: "ACQUIRE_DATE",
  ...{ opens_anchor: "ACQUIRE_DATE", opens_offset_days: 0, due_rule_value: 15 },
  rule_ref: "register.rule", opens_rule_ref: "register.opens", instrument: "법령", article: "조문",
});

test.each([
  ["documents", "DOC", "서류"],
  ["deadlines", "FIL", "신고"],
  ["tasks", "ACC", "권한"],
] as const)("composer %s previews the template item and its rules without guessing dates", (section, kind, label) => {
  const sections = trailPreviewSections([item(kind, "preview-item")]);
  const html = renderToStaticMarkup(<Composer layout="inline" title="전보" action={{ kind: "TRANSFER", mode: "apply", count: 1 }} onSubmit={() => false} sections={sections}>{null}</Composer>);
  expect(html).toContain(`data-composer-section="${section}"`);
  expect(html).toContain(label);
  expect(html).toContain("서류 확인");
  expect(html).toContain(t("lifecycle.trail.unverified"));
  expect(html).toContain("시작");
  expect(html).toContain("입사일");
  expect(html).toContain("기한");
  expect(html).toContain("다음 달 15일까지");
  expect(html).not.toMatch(/[A-Za-z_]{2,}\.[a-z_.]+|[A-Z]{2,}_[A-Z_]+/);
  expect(html).toContain("<details>");
  expect(html).not.toContain("<time");
  expect(html).not.toContain("D-");
});

test("every item appears in one section, retaining the trail's five groups", () => {
  const items = ["DOC", "NOT", "REC", "FIL", "PAY", "ACC", "BACK"].map((kind) => ({ ...item(kind, `item-${kind}`), label: `항목-${kind}` }));
  const sections = trailPreviewSections(items);
  const html = Object.values(sections).map((node) => renderToStaticMarkup(node)).join("");
  for (const value of items) expect(html.match(new RegExp(`>${value.label}<`, "g"))).toHaveLength(1);
  for (const group of ["documents", "filing", "payment", "access", "return"] as const) expect(html).toContain(t(`lifecycle.trail.group.${group}`));
  expect(trailPreviewSections([])).toEqual({});
});

test("a preview from the previous server shows an unknown rule without internal keys", () => {
  const sections = trailPreviewSections([{ item_key: "old", label: "서류", kind: "DOC", blocks_close: true }]);
  const html = renderToStaticMarkup(sections.documents);
  expect(html).toContain(t("statutory.unknown"));
  expect(html).not.toContain("lifecycle.trail.rule.");
  expect(html).toContain("시작 미확인");
  expect(html).not.toContain("시작 시작");
});

test("dated preview uses the trail window with dates, D-n and no raw codes", () => {
  const sections = trailPreviewSections([{ ...item("FIL", "F1"), ...{
    opens_on: "2026-10-20", due_on: "2026-11-15", due_in_days: 20, opens_in_days: -6, due_disposition: "HOLD",
  } }]);
  const html = renderToStaticMarkup(sections.deadlines);
  expect(html).toContain('dateTime="2026-10-20"');
  expect(html).toContain('dateTime="2026-11-15"');
  expect(html).toContain("D-20");
  expect(html).not.toMatch(/[A-Za-z_]{2,}\.[a-z_.]+|[A-Z]{2,}_[A-Z_]+/);
});


test("a pre-console filing shows its applicability without dates or an overdue deadline", () => {
  const sections = trailPreviewSections([{ ...item("FIL", "F1"), due_disposition: "PRE_CONSOLE" }]);
  const html = renderToStaticMarkup(sections.deadlines);
  expect(html).toContain(t("lifecycle.trail.preConsole"));
  expect(html).not.toContain("기한 지남");
  expect(html).not.toContain("기한 미확인");
  expect(html).not.toContain("<time");
  expect(html).not.toContain("D-");
});
