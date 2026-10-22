import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { grantRefusal, scopeName } from "./present";

beforeAll(() => loadCatalog("ko"));

// Home's grant notice renders its refusals through CommandError's `own` (grantRefusal) before the shared text.
test.each([
  ["grant_notice_not_holder", "권한을 받은 본인만 부여 확인을 기록할 수 있습니다"],
  ["grant_ended", "이미 끝난 부여입니다"],
  ["grant_not_found", "부여를 찾을 수 없습니다"],
  ["internal", undefined],
])("%s reads in the access screens' words", (code, text) => {
  expect(grantRefusal(code)).toBe(text);
});

test("a grant's named scope and exact reach survive without an organization-tree read", () => {
  const scope = { kind: "DEPARTMENT", node_id: "scope", node_name: "인사팀", include_descendants: false } as const;
  expect(scopeName(scope, [{ id: "scope", name: "이전 이름" }])).toBe("인사팀만");
  expect(scopeName({ ...scope, include_descendants: true })).toBe("인사팀 및 하위");
});
