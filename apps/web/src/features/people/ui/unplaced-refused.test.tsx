// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { loadCatalog, t } from "@console/i18n";
import { UnplacedRefused } from "./unplaced-refused";
import type { Held } from "./use-place-people";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));

test.each([true, false])("before-hire remedy matches the available date control (setup: %s)", (setup) => {
  const held = { refused: [{ person: { id: "person", name: "입사예정자" }, code: "effective_date_before_hire" }], rest: [], setup } as unknown as Held;
  const html = renderToStaticMarkup(<UnplacedRefused held={held} place="본사" pending={false} onRest={() => {}} onCancel={() => {}} />);
  expect(html).toContain(t(setup ? "unplaced.why.setup.effective_date_before_hire" : "unplaced.why.effective_date_before_hire"));
  expect(html.includes("입사일 이후 날짜로 배치")).toBe(!setup);
});

test("operating copy follows the chosen transfer date", () => {
  expect(t("unplaced.phaseOp")).toContain("선택한 날짜");
  expect(t("unplaced.phaseOp")).not.toContain("오늘");
});
