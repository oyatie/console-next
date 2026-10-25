// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { TenantPanel } from "./tenant-panel";
import { CodeDialog } from "./code-dialog";
import { DomainDialog } from "./domain-dialog";
import type { Org } from "../api";

vi.mock("../../../ui/dialog", () => ({ Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isSuccess: true, isPending: false, isFetching: false, data: { ops_enrolled: true, available: false, alias_days: 30 }, refetch: vi.fn() }) }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }), outcomeUnknown: () => false }));
vi.mock("./tenant-erase", () => ({ TenantErase: () => null }));
vi.mock("./ops-recovery", () => ({ OpsRecovery: () => null }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ children }: { children: (data: unknown) => ReactNode }) => children({ ops_enrolled: true }) }));
const org = { id: "tenant", name: "Example", slug: "example", status: "ACTIVE", pending_domain: null, group_name: "Group", created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z", removable: false, removal_refusal: "tenant_has_data", lifecycle: "CODE_ISSUED", code_issued_count: 1, passkey_registered_count: 0 } as unknown as Org;
const noop = () => undefined;
const panel = () => renderToStaticMarkup(<TenantPanel org={org} health={undefined} onIssued={noop} onRecorded={noop} onRemoved={noop} onClose={noop} />);
beforeAll(() => loadCatalog("ko"));

test("tenant data disables Delete before any command and offers archive", () => {
  const html = panel();
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Example 삭제<\/button>/);
  expect(html).toContain("운영 데이터");
  expect(html.match(/Example 보관/g)).toHaveLength(1);
});
test("issued tenant shows its derived lifecycle and zero enrolled accounts", () => {
  const html = panel();
  expect(html).toContain("코드 발급");
  expect(html).toContain("활성 0");
  expect(html).not.toContain("작업 지시");
  expect(html).not.toContain("요청할 회사 도메인");
});
test("code dialog labels the sign-in ID and code with valid roles and copy controls", () => {
  const html = renderToStaticMarkup(<CodeDialog issued={{ org: "Example", otp: "ABCDE-FGHJK", expiresAt: "2026-10-26T00:00:00Z", signInId: "admin@example" } as Parameters<typeof CodeDialog>[0]["issued"]} onClose={noop} />);
  expect(html).toContain("admin@example");
  expect(html).toMatch(/role="group"[^>]*aria-label="일회용 코드"/);
  expect(html).toContain("패스키를 등록하거나");
});
test("domain change starts with the current company domain and says Cancel", () => {
  const html = renderToStaticMarkup(<DomainDialog org={org} onClose={noop} onDone={noop} />);
  expect(html).toContain('value="example"');
  expect(html).toContain("취소");
  expect(html).not.toContain("이미 쓰거나 이전에 쓴 회사 도메인");
});

test("single-use recovery handovers never promise reusable codes", () => {
  const html = renderToStaticMarkup(<CodeDialog issued={{ org: "Example", otp: "ABCDE-FGHJK", expiresAt: "2026-10-26T00:00:00Z", recoveryMinutes: 10 }} onClose={noop} />);
  expect(html).not.toContain("다시 쓸 수 있습니다");
});
