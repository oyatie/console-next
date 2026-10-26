// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ActorBadge } from "./actor-badge";

beforeAll(() => loadCatalog("ko"));

test("routine ops-account writes show 운영 계정 and never 긴급 권한 (LMG-BADGE)", () => {
  const badge = html(<ActorBadge kind="OPS_ACCOUNT" />);
  expect(badge).not.toContain("긴급 권한");
  expect(badge).toContain("운영 계정");
});

test("break-glass session shows 긴급 권한 badge in warn tone", () => {
  const badge = html(<ActorBadge kind="OPS_ACCOUNT" breakGlass />);
  expect(badge).toContain("긴급 권한");
  expect(badge).toContain('class="chip chip--warn"');
});

test("support operator shows 운영사 지원 badge", () => {
  const badge = html(<ActorBadge kind="SUPPORT_OPERATOR" />);
  expect(badge).toContain("운영사 지원");
  expect(badge).not.toContain("긴급 권한");
});
