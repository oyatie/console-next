// SPDX-License-Identifier: LicenseRef-Proprietary
import { type ReactNode, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { Composer } from "../../../ui/composer/composer";
import { RegisterSheet } from "./register-sheet";

const state = vi.hoisted(() => ({ opensOn: "2020-03-02" as string | undefined, error: undefined as unknown, submit: () => {}, mutate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isSuccess: true, isPending: false, isFetching: false, data: { items: [], entities: [], phase: "OPERATING" } }), useQueries: () => [] }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <span data-to={to}>{children}</span> }));
vi.mock("../../../ui/composer/composer", () => ({ Composer: (p: ComponentProps<typeof Composer>) => { state.submit = p.onSubmit!; return <>{p.consequence}{p.children}</>; } }));
vi.mock("../domain/register", async (original) => {
  const mod = await original<typeof import("../domain/register")>();
  return { ...mod, EMPTY: { ...mod.EMPTY, name: "이전입사자", hire: "2019-01-02", unitId: "unit", where: "site" } };
});
vi.mock("../domain/register-place", () => ({
  placeOptions: () => [], workplaceChoices: () => [],
  resolvePlace: () => ({ unit: { id: "unit", kind: "SITE", name: "본사" }, site: "본사", branchId: "branch", own: true, opensOn: state.opensOn }),
}));
vi.mock("./use-register", () => ({ useRegister: () => ({ mutate: state.mutate, error: state.error }) }));
vi.mock("./register-person", () => ({ RegisterPerson: () => null }));
vi.mock("./register-place", () => ({ RegisterPlace: ({ hidePreview }: { hidePreview?: boolean }) => <span>{!hidePreview && "등록할 인원 1명"}</span> }));
vi.mock("./register-toast", () => ({ RegisterToast: () => null }));
let ApiError: typeof import("@console/api").ApiError;
beforeAll(async () => { ({ ApiError } = await vi.importActual<typeof import("@console/api")>("@console/api")); vi.stubGlobal("requestAnimationFrame", vi.fn()); await loadCatalog("ko"); });
const render = () => renderToStaticMarkup(<RegisterSheet preset="unit" onClose={() => {}} onOpen={() => {}} onRehire={() => {}} />);

test("a pre-opening hire keeps the typed date and names the opening date and import route at the hire field", () => {
  state.opensOn = "2020-03-02";
  const html = render();
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("본사 개설일(2020. 03. 02.) 전 입사자는 입사일을 그대로 두고 명부 가져오기로 등록합니다");
  expect(html).toMatch(/<p[^>]+id="[^"]+-error"[^>]*>.*개설일.*data-to="\/people\/import"/);
  expect(html).not.toContain("배치일");
  expect(html).not.toContain("재직으로 등록합니다");
  expect(html).not.toContain("등록할 인원 1명");
  state.mutate.mockClear();
  state.submit();
  expect(state.mutate).not.toHaveBeenCalled();
});

test("an opening-day hire can use the existing registration action", () => {
  state.opensOn = "2019-01-02";
  const html = render();
  expect(html).not.toContain('aria-invalid="true"');
  expect(html).toContain("등록할 인원 1명");
  state.mutate.mockClear();
  state.submit();
  expect(state.mutate).toHaveBeenCalledOnce();
});

test("a server-refused hire still offers import when the opening date was not in the read", () => {
  state.opensOn = undefined;
  state.error = new ApiError(422, "workplace_not_open_on_date", "");
  const html = render();
  expect(html).toContain("입사일을 그대로 두고 명부 가져오기로 등록합니다");
  expect(html).toContain('data-to="/people/import"');
  expect(html).not.toContain("다른 사업장을 선택하십시오");
  state.error = undefined;
});
