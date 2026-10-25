// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { CancelHost } from "./cancel-sheet";

const read = vi.hoisted(() => ({
  employee_id: "person", phase: "OPERATING", cancel: { allowed: true }, cancel_route: "VOID",
  attestation_required: true, register_confirmation_required: false, can_cancel: true,
  can_report_exit: true, exit: { allowed: true }, updated_at: "2026-10-01T00:00:00Z",
  void_basis: "ATTESTED_WITHIN_WINDOW", recorded_hire_date: "2021-10-01",
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: read, isPending: false, error: null }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isPending: false, mutate: vi.fn() }) }));
vi.mock("../../../ui/composer/composer", () => ({ Composer: ({ children }: { children: ReactNode }) => <>{children}</> }));
const e = { id: "person", name: "기록확인" } as ComponentProps<typeof CancelHost>["e"];
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { read.cancel.allowed = true; });

test("a historical registration attestation states the recorded date and requires verifying that record is mistaken", () => {
  const html = renderToStaticMarkup(<CancelHost e={e} act="cancel" onClose={vi.fn()} onAct={vi.fn()} />);
  expect(html).toContain(fmtDate(read.recorded_hire_date));
  expect(html).not.toContain(t("crud.person.attest"));
  expect(html).toContain("잘못된 등록임을 확인했습니다");
});

test("a refused cancellation never asks the operator to attest nobody worked", () => {
  read.cancel.allowed = false;
  const html = renderToStaticMarkup(<CancelHost e={e} act="cancel" onClose={vi.fn()} onAct={vi.fn()} />);
  expect(html).not.toContain('id="cancel-attest"');
});
