// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import { loadCatalog } from "@console/i18n";
import { LifecycleRefusal } from "./lifecycle-refusal";
import { RehireSheet } from "./register-rehire";
import { UnplacedRefused } from "./unplaced-refused";

const state = vi.hoisted(() => ({ code: "workplace_not_open_on_date" }));

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [], entities: [] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../../../lib/react/command", async (original) => ({ ...await original<typeof import("../../../lib/react/command")>(), useCommand: () => ({ error: new ApiError(422, state.code, "") }) }));
vi.mock("../../../ui/composer/composer", () => ({ Composer: ({ notice, children }: { notice: ReactNode; children: ReactNode }) => <>{notice}{children}</> }));
let ApiError: typeof import("@console/api").ApiError;
beforeAll(async () => { ({ ApiError } = await vi.importActual<typeof import("@console/api")>("@console/api")); await loadCatalog("ko"); });

test("a pre-opening transfer offers a valid date or another workplace", () => {
  const props = { error: new ApiError(422, "workplace_not_open_on_date", ""), kind: "TRANSFER", onLeave: false, target: "본사", onCancelEvent: vi.fn(), onClose: vi.fn(), onFocusTarget: vi.fn() };
  const html = renderToStaticMarkup(<LifecycleRefusal {...props} />);
  expect(html).toContain("개설일 이후 날짜를 선택하거나 다른 사업장을 선택하십시오");
  expect(html).not.toContain("명부 가져오기");
});

test("a refused placement offers a valid date or another workplace", () => {
  const held = { refused: [{ person: { id: "person", name: "경계직원" }, code: "workplace_not_open_on_date" }], rest: [], target: {} } as ComponentProps<typeof UnplacedRefused>["held"];
  const html = renderToStaticMarkup(<UnplacedRefused held={held} place="본사" pending={false} onRest={() => {}} onCancel={() => {}} />);
  expect(html).toContain("개설일 이후 날짜를 선택하거나 다른 사업장을 선택하십시오");
  expect(html).not.toContain("명부 가져오기");
});

test("a refused rehire offers a valid date or another workplace", () => {
  state.code = "workplace_not_open_on_date";
  const d = { employee: { id: "person", name: "경계직원", exit_date: "2026-10-31" }, employment: {} } as ComponentProps<typeof RehireSheet>["d"];
  const html = renderToStaticMarkup(<RehireSheet d={d} onClose={() => {}} onDone={() => {}} />);
  expect(html).toContain("개설일 이후 날짜를 선택하거나 다른 사업장을 선택하십시오");
  expect(html).not.toContain("명부 가져오기");
});

test("the previous period and rehire refusal format the derived retirement date", () => {
  state.code = "rehire_date_not_after_exit";
  const d = { employee: { id: "person", name: "경계직원", hire_date: "2020-01-02", exit_date: "2026-10-31" }, employment: {} } as ComponentProps<typeof RehireSheet>["d"];
  const html = renderToStaticMarkup(<RehireSheet d={d} onClose={() => {}} onDone={() => {}} />);
  expect(html).toContain("퇴직일 2026. 11. 01.부터");
  expect(html).toContain("2020. 01. 02. ~ 2026. 11. 01.");
  expect(html).not.toContain("2026-10-31");
});
