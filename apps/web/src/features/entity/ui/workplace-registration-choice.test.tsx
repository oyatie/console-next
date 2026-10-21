// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import { RegistrationChoice } from "./workplace-registration-choice";

beforeAll(() => loadCatalog("ko"));

type ChoiceState = Parameters<typeof RegistrationChoice>[0]["c"];

const mockEntity = {
  id: "e1",
  registrations: [],
  workplaces: [],
} as unknown as LegalEntity;

const makeChoiceState = (over: Partial<ChoiceState> = {}): ChoiceState => ({
  free: [],
  unit: undefined,
  reg: {} as never,
  askVat: false,
  vat: null,
  setVat: () => {},
  w: { regMode: null, registrationId: null, subSerial: "", notRegisteredReason: null, isAbstract: false },
  set: () => {},
  mode: null,
  problems: {},
  ...over,
});

test("RegistrationChoice renders all modes including 등록 대상 아님 (NOT_REQUIRED)", () => {
  const c = makeChoiceState();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RegistrationChoice e={mockEntity} c={c} />
    </QueryClientProvider>,
  );
  expect(html).toContain("이 사업장의 등록증");
  expect(html).toContain("등록 대상 아님");
  expect(html).toContain("나중에 연결");
});

test("When mode is NOT_REQUIRED, reason field and abstract checkbox are displayed", () => {
  const c = makeChoiceState({
    mode: "NOT_REQUIRED",
    w: { regMode: "NOT_REQUIRED", registrationId: null, subSerial: "", notRegisteredReason: null, isAbstract: false },
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RegistrationChoice e={mockEntity} c={c} />
    </QueryClientProvider>,
  );
  expect(html).toContain("등록 대상 아님");
  expect(html).toContain("등록 미대상 사유");
  expect(html).toContain("실체 없는 사업장");
});
