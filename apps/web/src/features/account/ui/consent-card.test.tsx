// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fmtDate } from "@console/i18n/format";
import { loadCatalog } from "@console/i18n";
import { consentDocumentsQuery } from "../api";
import { ConsentCard } from "./consent-card";
const state = vi.hoisted(() => ({ document: { title: "개인정보 처리방침", published_on: "2026-10-20", version: "kr-pipa-v1-2026-06-25", body: "고지 전문 내용", policy_url: "https://example.invalid/privacy" } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (q: unknown) => ({ data: q === consentDocumentsQuery ? { privacy: state.document } : { accepted: true, policy_version: state.document.version, accepted_at: "2026-10-21T00:00:00Z" } }) }));
beforeAll(() => loadCatalog("ko"));
test("consent names the stored notice and edition date, with the exact text behind disclosure", () => {
  const html = renderToStaticMarkup(<ConsentCard />);
  expect(html).toContain(`개인정보 처리방침 · ${fmtDate(state.document.published_on)} 판 · 전문 보기`);
  expect(html).toContain("고지 전문 내용");
  expect(html).toContain("<details");
  expect(html).not.toContain("kr-pipa");
  expect(html).toContain(state.document.policy_url);
});
