// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { correctionRegisterQuery, type IdentifierCorrectionCase } from "../api";
import { CorrectionRegister } from "./correction-register";

beforeAll(async () => { await loadCatalog("ko"); await loadCatalog("en"); });

const row = (status: IdentifierCorrectionCase["status"], id: string): IdentifierCorrectionCase => ({
  id, entity_id: "entity", entity_name: "주식회사 아주 긴 이름의 테스트 법인", subject_id: "entity", subject_type: "LEGAL_ENTITY",
  status, requested_by: "requester", payload_hash: "a".repeat(64), can_apply: status === "APPROVED",
  proposal: { field: "crn", value: "0001110012348", document_id: "document", reason_code: "REGISTRY_DIFFERS" },
  expires_at: "2026-11-01T00:00:00Z", created_at: "2026-10-23T00:00:00Z", review_due_at: status === "RECORDED" ? "2026-10-30T00:00:00Z" : null,
  reviewed_at: null, consumed_at: null,
});

test.each(["ko", "en"] as const)("%s register preserves pending, approved and post-review follow-ups", (locale) => {
  i18n.set(locale);
  const client = new QueryClient();
  client.setQueryData(correctionRegisterQuery("entity").queryKey, { items: [row("PENDING", "pending"), row("APPROVED", "approved"), row("RECORDED", "recorded")], next_offset: null });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><CorrectionRegister entityId="entity" /></QueryClientProvider>);
  for (const text of locale === "ko" ? ["승인 대기", "승인됨 · 적용 대기", "적용됨 · 사후 검토 대기"] : ["Awaiting approval", "Approved · awaiting application", "Applied · awaiting post-review"])
    expect(html).toContain(text);
  expect(html).toContain('id="identifier-corrections"');
  expect(html).toContain("000111-0012348");
  expect(html).not.toContain("requester");
});

test("an empty register explains that no review is waiting", () => {
  i18n.set("en");
  const client = new QueryClient();
  client.setQueryData(correctionRegisterQuery().queryKey, { items: [], next_offset: null });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><CorrectionRegister /></QueryClientProvider>);
  expect(html).toContain("No correction requests or post-reviews.");
});
