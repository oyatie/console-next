// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { components } from "@console/api/schema";
import { ChangeSettlement } from "./change-settlement";

const state = vi.hoisted(() => ({ unit: undefined as { id: string; name: string; headcount: number } | undefined }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: state.unit ? [state.unit] : [] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => true }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: vi.fn(), isPending: false }) }));
beforeAll(() => loadCatalog("ko"));

const detail = {
  status: "SETTLING", target: { kind: "ORG_UNIT", ref: "unit-1" },
  proposal: [], settlementItems: [{ id: "item-1", label: "구성원 이동", itemKey: "TRANSFER_EMPLOYEES", done: false }],
} as unknown as components["schemas"]["OrgChangeDetail"];
const render = () => renderToStaticMarkup(<ChangeSettlement d={detail} refetch={async () => ({})} onNote={() => {}} />);

test("settlement never claims zero members while the same unit still has members", () => {
  state.unit = { id: "unit-1", name: "영업팀", headcount: 3 };
  const html = render();
  expect(html).toContain("아직 3명");
  expect(html).not.toContain("남은 구성원이 없습니다");
  expect(html).not.toContain("<h1");
  state.unit = { ...state.unit, headcount: 0 };
  expect(render()).toContain("남은 구성원이 없습니다");
});

test("an unresolved unit shows pending instead of a fabricated zero count", () => {
  state.unit = undefined;
  const html = render();
  expect(html).toContain('role="status"');
  expect(html).not.toContain("아직 0명");
  expect(html).not.toContain("남은 구성원이 없습니다");
});
