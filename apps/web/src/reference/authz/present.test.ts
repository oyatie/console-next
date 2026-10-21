import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { AccessEffectiveEntry } from "./api";
import { grantRefusal, unnoticed } from "./present";

beforeAll(() => loadCatalog("ko"));

const entry = (grant: string, level: string, noticed: string | null): AccessEffectiveEntry => ({
  domain: "exceptions", level, grant_id: grant, role_id: "r", role_name_ko: `역할 ${grant}`, caveats: [],
  scope: { kind: "TENANT", node_id: null, include_descendants: true }, valid_from: "2026-10-01T00:00:00Z", valid_to: null,
  enforcement: "ENFORCED", noticed_at: noticed,
}) as AccessEffectiveEntry;

test("only grants whose notice is not confirmed are listed, one line per grant", () => {
  const lines = unnoticed([entry("a", "view", null), entry("a", "edit", null), entry("b", "edit", "2026-10-02T00:00:00Z")]);
  expect(lines.map((l) => l.id)).toEqual(["a"]);
  expect(lines[0]!.role).toBe("역할 a");
});

// Home's grant notice renders its refusals through CommandError's `own` (grantRefusal) before the shared text.
test.each([
  ["grant_notice_not_holder", "권한을 받은 본인만 부여 확인을 기록할 수 있습니다"],
  ["grant_ended", "이미 끝난 부여입니다"],
  ["grant_not_found", "부여를 찾을 수 없습니다"],
  ["internal", undefined],
])("%s reads in the access screens' words", (code, text) => {
  expect(grantRefusal(code)).toBe(text);
});
