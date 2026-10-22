// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import type { Card } from "./use-card";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));

let SecFamily: typeof import("./sec-more").SecFamily;
beforeAll(async () => {
  await loadCatalog("ko");
  ({ SecFamily } = await import("./sec-more"));
});

function family(birth_date: string | null) {
  const c = {
    e: { id: "person" }, manage: false,
    records: { data: { items: [{ id: "family", section: "FAMILY", voided: false, fields: { relation: "CHILD", name: "한가족", birth_date } }] } },
  } as Card;
  return renderToStaticMarkup(<SecFamily c={c} />);
}

test("a family birth date is masked and offers the shared reason-gated reveal", () => {
  const html = family("2015-03-04");
  expect(html).not.toContain("2015");
  expect(html).not.toContain("한가족");
  expect(html).toContain("••••-••-••");
  expect(html).toContain(t("empCard.reveal.open", { field: t("empCard.f.birth") }));
});

test("a missing family birth date keeps the empty value without a reveal", () => {
  const html = family(null);
  expect(html).toContain("—");
  expect(html).not.toContain("••••-••-••");
  expect(html).not.toContain(t("empCard.reveal.open", { field: t("empCard.f.birth") }));
});
