// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../api";
import { changeRegistration } from "../api";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { loadCatalog } from "@console/i18n";
import { WorkplaceRegistrationChangeSheet } from "./workplace-registration-change";

const command = vi.hoisted(() => ({ states: [] as string[], run: undefined as undefined | ((input: undefined, key: string) => Promise<unknown>), error: undefined as unknown }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => typeof initial === "string" && command.states.length ? [command.states.shift(), vi.fn()] : actual.useState(initial) };
});
vi.mock("../../../lib/react/command", async (original) => ({ ...await original<typeof import("../../../lib/react/command")>(), useCommand: (options: { run: typeof command.run }) => {
  command.run = options.run; return { error: command.error, mutate: vi.fn(), isPending: false };
} }));

vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  changeRegistration: vi.fn(),
  ENTITY_READS: [],
}));

vi.mock("../../../lib/pure/today", () => ({
  todayKst: () => "2026-10-21",
}));

vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: ({
    title,
    subtitle,
    consequence,
    notice,
    actions,
    children,
  }: {
    title: string;
    subtitle?: ReactNode;
    consequence: ReactNode;
    notice?: ReactNode;
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <div data-testid="sheet">
      <h1>{title}</h1>
      {subtitle && <div>{subtitle}</div>}
      {notice}
      <div data-testid="body">{children}</div>
      <div data-testid="consequence">{consequence}</div>
      <div data-testid="actions">{actions}</div>
    </div>
  ),
}));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { command.error = undefined; command.states = []; vi.mocked(changeRegistration).mockReset(); });

const mockEntity: LegalEntity = {
  id: "ent-1",
  name: "주식회사 가나",
  biz_kind: "CORPORATION",
  read_only: false,
  registrations: [
    {
      id: "reg-1",
      brn: { display: "000-81-00009", raw: "0008100009" },
      closed_on: null,
      holder_workplace_id: "wp-1",
      unit_taxation: false,
      current: { trade_name: "가나 본사", opened_on: "2020-03-02" },
    },
    {
      id: "reg-2",
      brn: { display: "000-81-00014", raw: "0008100014" },
      closed_on: null,
      holder_workplace_id: null,
      unit_taxation: false,
      current: { trade_name: "가나 물류", opened_on: "2021-01-04" },
    },
    {
      id: "reg-3",
      brn: { display: "000-81-00028", raw: "0008100028" },
      closed_on: null,
      holder_workplace_id: null,
      unit_taxation: true,
      current: { trade_name: "가나 단위과세", opened_on: "2021-01-04", unit_taxation: true },
    },
  ],
  workplaces: [
    {
      id: "wp-1",
      name: "본사",
      read_only: false,
      can_manage: true,
      registration_id: "reg-1",
      sub_serial: null,
      current: { name: "본사", opened_on: "2020-03-02" },
      withholding: { mode: "CONSOLIDATED" },
    } as unknown as Workplace,
  ],
} as unknown as LegalEntity;

const mockWorkplace = mockEntity.workplaces[0]!;

const renderSheet = (w: Workplace = mockWorkplace, e: LegalEntity = mockEntity) => {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <WorkplaceRegistrationChangeSheet e={e} w={w} onClose={() => undefined} />
    </QueryClientProvider>
  );
};

test("renders registration change sheet with current registration in subtitle and options", () => {
  const html = renderSheet();
  expect(html).toContain("사업자등록 변경");
  expect(html).toContain("000-81-00009");
  expect(html).toContain("000-81-00014");
  expect(html).toContain("등록증 연결 안 함");
});

test("holds submission when target registration is unchanged", () => {
  const html = renderSheet();
  // Default selection is current reg, so it holds
  expect(html).toContain("지금 연결된 사업자등록과 같습니다");
  expect(html).toContain('aria-disabled="true"');
});

test("renders sub_serial input when unit taxation registration is active", () => {
  const wpUnit = {
    ...mockWorkplace,
    registration_id: "reg-3",
    sub_serial: "0001",
  } as unknown as Workplace;
  const html = renderSheet(wpUnit);
  expect(html).toContain("종사업장 일련번호");
});


test("submitting a replacement sends the selected registration, serial, date and person reason", async () => {
  command.states = ["reg-3", "0002", "2026-10-01", "분리 신고"];
  renderSheet();
  await command.run!(undefined, "intent");
  expect(changeRegistration).toHaveBeenCalledWith("intent", "wp-1", {
    registration_id: "reg-3", sub_serial: "0002", effective_from: "2026-10-01", reason_code: "분리 신고",
  });
});

test("an incomplete unit-taxation serial holds the save", () => {
  command.states = ["reg-3", "123", "2026-10-01", "분리 신고"];
  const html = renderSheet();
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("종사업장 일련번호");
});

test("a registration change requires the person's reason instead of a preselected code", () => {
  command.states = ["reg-2", "", "2026-10-01", ""];
  const html = renderSheet();
  expect(html).toContain('aria-disabled="true"');
});

for (const code of ["registration_unchanged", "use_registration_change", "stale_revision"]) {
  test(`the sheet displays a ${code} refusal without closing`, () => {
    command.error = code === "stale_revision" ? new ApiError(409, code, "새 변경이 있습니다", [], undefined, true) : Object.assign(
      new ApiError(422, "validation_failed", "입력값을 확인하십시오", [], undefined, true),
      { fields: [{ field: code === "registration_unchanged" ? "registration_id" : "sub_serial", code }] },
    );
    const html = renderSheet();
    expect(html).toContain('role="alert"');
    expect(html).toContain(code === "stale_revision" ? "다른 사람이 먼저 변경" : code === "registration_unchanged" ? "지금 연결된 사업자등록과 같습니다" : "등록 변경에서");
  });
}
