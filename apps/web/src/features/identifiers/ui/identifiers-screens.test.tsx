import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { NumberCard } from "./number-card";
import { RenumberCard } from "./renumber-card";

beforeAll(() => loadCatalog("ko"));
const html = (node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

test("a person without a number reads 사번 미부여 and is offered one, never an empty gap", () => {
  const e = { id: "p1", name: "강시우", employee_number: null, updated_at: "2026-10-06T00:00:00Z" } as unknown as components["schemas"]["Employee"];
  const out = html(<NumberCard employee={e} />);
  expect(out).toContain("사번 미부여");
  expect(out).toContain("사번 부여");
});

test("after go-live renumbering says why it is closed", () => {
  const scopes = [{ kind: "TENANT" as const, label: "회사 전체" }];
  expect(html(<RenumberCard scopes={scopes} phase="OPERATING" />)).toContain("운영을 시작한 뒤에는 일괄 재부여를 할 수 없습니다");
  expect(html(<RenumberCard scopes={scopes} phase="SETUP" />)).toContain("설정 단계에서는 한 번에 되돌릴 수 있습니다");
});
