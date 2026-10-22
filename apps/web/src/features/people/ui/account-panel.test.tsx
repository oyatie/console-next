// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { AccountPanel } from "./account-panel";

type LinkCommand = {
  run: (input: { employeeId: string | null; requestId?: string }) => Promise<unknown>;
  onSuccess: (result: unknown) => void;
  invalidates: readonly string[];
};
const state = vi.hoisted(() => ({
  result: undefined as unknown, command: undefined as LinkCommand | undefined,
  assertion: vi.fn(), patch: vi.fn(), recorded: vi.fn(),
}));
vi.mock("@console/api", async (original) => (await import("./account-link-test-api")).accountLinkApi(await original<object>(), state));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./use-issue-code", () => ({ useIssueCode: () => ({}) }));
vi.mock("./account-sign-in-id", () => ({ SignInId: () => null }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (opts: LinkCommand) => {
  if (opts.invalidates.includes("/api/v1/employees")) state.command = opts;
  return { data: state.result, mutate: vi.fn() };
} }));
const row: NonNullable<Parameters<typeof AccountPanel>[0]["row"]> = {
  id: "account", display_name: "김계정", employee_id: "employee", employee_name: "김직원",
  account_status: "ACTIVE", is_active: true, created_at: "2026-10-01T00:00:00Z",
  branch_ids: [], has_passkey: true, roles: [], team: "MANAGEMENT", is_tenant_ops: false,
  employee_number: null, employee_company: null, employee_org_unit: null, employee_position: null,
  employee_identity_review_required: null, employee_identity_resolution_confidence: null, employee_link_status: "LINKED",
};
const panel = (id = "account", employeeId: string | null = "employee", admin = true) => renderToStaticMarkup(
  <AccountPanel id={id} row={{ ...row, id, employee_id: employeeId }}
    admin={admin} onClose={() => {}} onIssued={() => {}} onRecorded={state.recorded} />,
);
const pending = (requestedBy = "01a15d08-533d-780f-8624-5284d9060bf9") => ({ ...row, account_link: {
  status: "PENDING", request_id: "request", requested_by: requestedBy, requester_name: "김요청", employee_id: null, user_id: "account",
} });
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.command = undefined; state.result = undefined; state.recorded.mockReset();
  state.assertion.mockReset().mockResolvedValue({ ceremony_id: "ceremony", credential: {} });
  state.patch.mockReset().mockResolvedValue({});
});

test("unlink explains the passkey check before submission", () => {
  expect(panel()).toContain(t("uiOverrideSheet.stepUp", { action: t("accounts.employee.unlink") }));
});
test("approval sends a fresh assertion and the stored request reference", async () => {
  panel();
  await state.command!.run({ employeeId: null, requestId: "request" });
  expect(state.assertion).toHaveBeenCalledOnce();
  expect(state.patch).toHaveBeenCalledWith("/api/v1/users/{id}", expect.objectContaining({
    params: { path: { id: "account" } },
    body: { employee_id: null, account_link_request_id: "request", step_up: { ceremony_id: "ceremony", credential: {} } },
  }));
});
test("a cancelled passkey never sends a link change", async () => {
  panel();
  state.assertion.mockRejectedValue(new Error("cancelled"));
  await expect(state.command!.run({ employeeId: null })).rejects.toThrow("cancelled");
  expect(state.patch).not.toHaveBeenCalled();
});
test("a pending receipt does not claim that the link was applied", () => {
  panel();
  state.command!.onSuccess(pending());
  expect(state.recorded).toHaveBeenCalledWith("확인 대기");
});
test("pending names the account and requester without repeated correction copy or self-approval", () => {
  state.result = pending();
  const html = panel();
  expect(html).toContain("확인 대기");
  expect(html).not.toContain("01a15d08-533d-780f-8624-5284d9060bf9");
  expect(html).toContain("김계정 → 연결 안 됨 · 요청자 김요청");
  expect(html).not.toContain(t("uiRecordActions.path.second"));
  expect(html).not.toContain(t("uiOverrideSheet.stepUp", { action: t("org.change.step.APPROVED") }));
  expect(html).not.toContain(t("uiOverrideSheet.stepUp", { action: t("accounts.employee.unlink") }));
});
test("another holder can offer approval with step-up", () => {
  state.result = pending("other");
  expect(panel()).toContain(t("uiOverrideSheet.stepUp", { action: t("org.change.step.APPROVED") }));
});
test("the signed-in account offers neither unlink nor a new employee picker", () => {
  expect(panel("01a15d08-533d-780f-8624-5284d9060bf9")).not.toMatch(/<button[^>]*>[^<]*연결 해제/);
  expect(panel("01a15d08-533d-780f-8624-5284d9060bf9", null)).not.toContain('role="combobox"');
});
test("read-only viewers cannot change or approve a link", () => {
  expect(panel("account", null, false)).not.toContain('role="combobox"');
  state.result = pending("other");
  expect(panel("account", "employee", false)).not.toContain(t("uiOverrideSheet.stepUp", { action: t("org.change.step.APPROVED") }));
});

test("a proposed employee absent from the search never displays its id", () => {
  const employeeId = "01a15d08-533d-780f-8624-5284d9060bfa";
  const result = pending();
  state.result = { ...result, account_link: { ...result.account_link, employee_id: employeeId } };
  const html = panel();
  expect(html).toContain("확인 대기");
  expect(html).not.toContain(employeeId);
});
