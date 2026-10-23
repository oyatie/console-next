// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { CodeOption } from "../../../ui/code-picker/code-picker";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import { abstractFromReason } from "../domain/workplace";
import { ATTACH_MODES } from "./use-workplace-attach";
import { RegistrationChoice } from "./workplace-registration-choice";
import { RefPick } from "./ref-pick";

const reference = vi.hoisted(() => ({ loaded: true }));
vi.mock("./use-ref", () => ({
  useCodeSearch: () => ({
    list: { title: "등록 미대상 사유", version: "v1", loaded: reference.loaded },
    options: [{ code: "INTERNAL_REASON", label: "사유 표시명" }],
    query: "", setQuery: () => {}, loading: false, ready: true,
  }),
}));
// Render the collection on the server so both option text and its accessible name are checked.
vi.mock("react-aria-components", async (original) => {
  const { createContext, useContext } = await import("react");
  const Items = createContext<readonly CodeOption[]>([]);
  const Children = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    ...await original<object>(),
    ComboBox: ({ children, items }: { children: ReactNode; items: CodeOption[] }) => <Items.Provider value={items}>{children}</Items.Provider>,
    ListBox: ({ children }: { children: (o: CodeOption) => ReactNode }) => <>{useContext(Items).map((o) => <span key={o.code}>{children(o)}</span>)}</>,
    ListBoxItem: ({ children, textValue }: { children: ReactNode; textValue: string }) => <div role="option" aria-label={textValue} aria-selected={false}>{children}</div>,
    Input: () => null, Label: Children, Popover: Children, Text: Children,
  };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { reference.loaded = true; });

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

test("When mode is NOT_REQUIRED, the reason field is displayed", () => {
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
  expect(html).not.toContain("실체 없는 사업장");
});

test("abstract default comes from reference data, not reason-code literals", () => {
  expect(abstractFromReason({ isAbstract: true })).toBe(true);
  expect(abstractFromReason({ isAbstract: false })).toBe(false);
  expect(abstractFromReason(undefined)).toBe(false);
});

test("existing unanswered workplaces can choose NOT_REQUIRED", () => {
  expect(ATTACH_MODES).toContain("NOT_REQUIRED");
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RegistrationChoice e={mockEntity} c={makeChoiceState()} modes={ATTACH_MODES} required /></QueryClientProvider>);
  expect(html).toContain("등록 대상 아님");
});

test("registration reasons show labels without internal codes, including the stored selection", () => {
  const c = makeChoiceState({
    mode: "NOT_REQUIRED",
    w: { regMode: "NOT_REQUIRED", registrationId: null, subSerial: "", notRegisteredReason: { code: "STORED_INTERNAL_REASON", label: "저장한 사유", version: "v1" } },
  });
  const html = renderToStaticMarkup(<RegistrationChoice e={mockEntity} c={c} />);
  expect(html).toContain("사유 표시명");
  expect(html).toContain("저장한 사유");
  expect(html).not.toContain("INTERNAL_REASON");
});

test("official code lists keep their public codes visible", () => {
  const html = renderToStaticMarkup(<RefPick listKey="ksic" label="산업분류" required={false} value={null} onChange={() => {}} />);
  expect(html).toContain("INTERNAL_REASON");
});

test("an unavailable reason list preserves the stored label without exposing or asking for an internal code", () => {
  reference.loaded = false;
  const c = makeChoiceState({
    mode: "NOT_REQUIRED",
    w: { regMode: "NOT_REQUIRED", registrationId: null, subSerial: "", notRegisteredReason: { code: "STORED_INTERNAL_REASON", label: "저장한 사유", version: "v1" } },
  });
  const html = renderToStaticMarkup(<RegistrationChoice e={mockEntity} c={c} />);
  expect(html).toContain("저장한 사유");
  expect(html).not.toContain("INTERNAL_REASON");
  expect(html).not.toContain(t("entityOps.code.typed"));
});
