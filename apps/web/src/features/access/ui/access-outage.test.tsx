// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { AccessReviewPage } from "./access-review-page";
import { ReadinessPage } from "./readiness-page";
import { RoleEditorPage } from "./role-editor";

const state = vi.hoisted(() => ({
  usersPending: false,
  usersError: false,
  grantsError: false,
  versionsError: false,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => "/access/roles",
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span>,
}));

vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (target: unknown) => {
    const key = JSON.stringify(target);
    if (key.includes("onboarding/modules")) return {
      isPending: false, isSuccess: true, error: null, data: [], refetch: () => {},
    };
    if (key.includes("catalog")) return {
      isPending: false, isSuccess: true, error: null,
      data: { domains: [{ domain: "hr_basic", grantable: true, levels: ["view"], operations: [] }], levels: ["view"], scope_kinds: [], reason_domain: "role_change" },
      refetch: () => {},
    };
    if (key.includes("versions")) return {
      isPending: false, isSuccess: !state.versionsError,
      error: state.versionsError ? new ApiError(503, "service_unavailable", "") : null,
      data: state.versionsError ? undefined : [],
      refetch: () => {},
    };
    if (key.includes("/roles/r-1")) return {
      isPending: false, isSuccess: true, error: null,
      data: { id: "r-1", name_ko: "인사 조회", description: null, version: 1, holder_count: 2, lines: [{ domain: "hr_basic", levels: ["view"] }] },
      refetch: () => {},
    };
    if (key.includes("roles")) return {
      isPending: false, isSuccess: true, error: null,
      data: { items: [{ id: "r-1", name_ko: "인사 조회", description: null, version: 1, holder_count: 1, lines: [{ domain: "hr_basic", levels: ["view"] }] }] },
      refetch: () => {},
    };
    if (key.includes("/users")) return {
      isPending: state.usersPending, isSuccess: !state.usersPending && !state.usersError,
      error: state.usersError ? new ApiError(503, "service_unavailable", "") : null,
      data: state.usersPending || state.usersError ? undefined : { items: [] },
      refetch: () => {},
    };
    if (key.includes("grants")) return {
      isPending: false, isSuccess: !state.grantsError,
      error: state.grantsError ? new ApiError(503, "service_unavailable", "") : null,
      data: state.grantsError ? undefined : { items: [] },
      refetch: () => {},
    };
    return {
      isPending: false, isSuccess: true, error: null,
      data: { phase: "SETUP", account_id: "ops", items: [], steps: [], domains: [] },
      refetch: () => {},
    };
  },
}));

vi.mock("../../../reference/settings/ui/use-policy-routed", () => ({ usePolicyRouted: () => false }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: vi.fn(), isPending: false, error: null }) }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.usersPending = false;
  state.usersError = false;
  state.grantsError = false;
  state.versionsError = false;
});

test.each(["pending", "error"] as const)("ReadinessPage omits the go-live link and tab counts when account reads are %s", mode => {
  state.usersPending = mode === "pending";
  state.usersError = mode === "error";
  const html = renderToStaticMarkup(<ReadinessPage />);
  expect(html).not.toContain(t("access.ready.goLive"));
  if (mode === "error") expect(html).not.toContain(">1<");
});

test("RoleEditorPage renders a single load-failed card when both holder grants and role versions fail", () => {
  state.grantsError = true;
  state.versionsError = true;
  const html = renderToStaticMarkup(<RoleEditorPage roleId="r-1" />);
  expect(html.match(/role="alert"/g)).toHaveLength(1);
});

test("AccessReviewPage renders a single outage alert without wrapping it in the review card", () => {
  state.grantsError = true;
  const html = renderToStaticMarkup(<AccessReviewPage />);
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  expect(html).not.toContain(t("accessReview.title"));
});
