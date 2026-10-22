// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { AccountLinkCard } from "./account-link-card";

const state = vi.hoisted(() => ({
  hasLinked: true,
  linked: { id: "account", display_name: "김하나", roles: [] },
  result: undefined as unknown,
  run: undefined as undefined | ((input: { id: string | null; requestId?: string }) => Promise<unknown>),
  assertion: vi.fn(), patch: vi.fn(),
}));
vi.mock("@console/api", async (original) => (await import("./account-link-test-api")).accountLinkApi(await original<object>(), state));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null, useNavigate: () => vi.fn() }));
vi.mock("./use-linked-account", () => ({
  directorySearch: () => ({}), useLinkedAccount: () => ({ mine: { isSuccess: true }, linked: state.hasLinked ? state.linked : undefined }),
}));
vi.mock("../../../lib/react/command", () => ({ useCommand: (opts: { run: typeof state.run }) => {
  state.run = opts.run;
  return { data: state.result, mutate: vi.fn() };
} }));
const card = () => renderToStaticMarkup(<AccountLinkCard employee={{ id: "employee", name: "김하나" } as Parameters<typeof AccountLinkCard>[0]["employee"]} manage />);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.hasLinked = true; state.linked.id = "account"; state.result = undefined;
  state.assertion.mockReset().mockResolvedValue({ ceremony_id: "ceremony", credential: {} });
  state.patch.mockReset().mockResolvedValue({});
});

test("link changes explain the passkey check before submission", () => {
  expect(card()).toContain("패스키");
});
test("unlinking obtains a fresh assertion before calling PATCH", async () => {
  card();
  await state.run!({ id: null });
  expect(state.assertion).toHaveBeenCalledOnce();
  expect(state.patch).toHaveBeenCalledWith("/api/v1/users/{id}", expect.objectContaining({
    body: expect.objectContaining({ employee_id: null, step_up: { ceremony_id: "ceremony", credential: {} } }),
  }));
});
test("a waiting request is shown as pending rather than as an applied link", () => {
  state.result = { display_name: "김하나", account_link: { status: "PENDING", request_id: "request", requested_by: "01a15d08-533d-780f-8624-5284d9060bf9", requester_name: "김요청", user_id: "account", employee_id: null } };
  const html = card();
  expect(html).toContain("확인 대기");
  expect(html).not.toContain("01a15d08-533d-780f-8624-5284d9060bf9");
  expect(html).toContain("김하나 → 연결 안 됨 · 요청자 김요청");
  expect(html).not.toContain("정정 기록");
  expect(html).not.toContain("패스키로 확인하고 승인");
});
test("one cannot offer a change of the signed-in account's own link", () => {
  state.linked.id = "01a15d08-533d-780f-8624-5284d9060bf9";
  expect(card()).not.toContain("계정 연결 해제</button>");
});

test("approval sends the stored request reference with its own fresh assertion", async () => {
  card();
  await state.run!({ id: null, requestId: "pending-request" });
  expect(state.assertion).toHaveBeenCalledOnce();
  expect(state.patch).toHaveBeenCalledWith("/api/v1/users/{id}", expect.objectContaining({
    body: expect.objectContaining({ account_link_request_id: "pending-request", employee_id: null }),
  }));
});

test("a failed local passkey check never sends a link change", async () => {
  state.assertion.mockRejectedValue(new Error("passkey_cancelled"));
  card();
  await expect(state.run!({ id: null })).rejects.toThrow("passkey_cancelled");
  expect(state.patch).not.toHaveBeenCalled();
});

test("a pending account absent from the search uses its returned name, never its id", () => {
  state.hasLinked = false;
  const userId = "01a15d08-533d-780f-8624-5284d9060bfa";
  state.result = { display_name: "김계정", account_link: {
    status: "PENDING", request_id: "request", requested_by: "other", requester_name: "김요청",
    user_id: userId, employee_id: "employee",
  } };
  const html = card();
  expect(html).toContain("김계정 → 김하나 · 요청자 김요청");
  expect(html).not.toContain(userId);
});
