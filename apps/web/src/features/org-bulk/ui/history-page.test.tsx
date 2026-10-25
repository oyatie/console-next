// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import type { FeedRow } from "../domain/feed";
import { HistoryPage } from "./history-page";
import { UndoCell } from "./undo-cell";

const command = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ error: command.error, isPending: false, mutate: vi.fn() }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../../lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/query")>();
  return { ...actual, get: (...args: Parameters<typeof actual.get>) => ({ ...actual.get(...args), path: args[0] }) };
});
const data = new Map<string, unknown>();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: (q: { path: string }) => ({ data: data.get(q.path), isPending: false }), useQueryClient: () => ({ getQueryState: () => undefined }) };
});
beforeAll(() => loadCatalog("ko"));

test("history names the actual action and actor, offers period/actor filters and omits refused undo controls", () => {
  command.error = null;
  data.set("/api/v1/org-structure/batches", { items: [{ id: "renamed", kind: "APPLY", undoes: null, undone_by: "undo", undoable: false,
    actor_id: "me", actor_name: "김인사", actions: ["org_unit.setup_rename"], unit_names: ["품질관리팀"], created_at: "2026-10-06T00:00:00Z", units: [{ org_unit_id: "quality", version: 2, op_index: 0 }] }] });
  data.set("/api/v1/entity-setup/batches", { items: [{ id: "registered", kind: "APPLY", change_mode: "SETUP", records: 1, undoable: false,
    actor_id: "other", actor_name: "박담당", registration_action: "legal_entity.create", target_names: ["주식회사 새온"], actions: ["CREATE_ENTITY"], created_at: "2026-10-05T00:00:00Z" }] });
  data.set("/api/v1/org-changes", { items: [] });
  data.set("/api/v1/org-structure", { entities: [] });
  const html = renderToStaticMarkup(<HistoryPage />);
  expect(html).toContain("부서 일괄 · 이름 변경");
  expect(html).toContain("김인사");
  expect(html).toContain("박담당");
  expect(html).toContain("주식회사 새온");
  expect(html).toContain("법인 등록");
  expect(html).toContain("기록 시작일");
  expect(html).toContain("기록 종료일");
  expect(html).toContain("누가");
  expect(html).toContain("불러온 최근 기록에서 찾기");
  expect(html).not.toContain('aria-label="품질관리팀 되돌리기"');
  expect(html).not.toContain("이미 되돌림");
  expect(html.split(t("orgHistory.foot", { count: 2 }))).toHaveLength(2);
});

test.each(["undo_conflict", "undo_unit_in_use", "record_in_use", "batch_already_undone"] as const)("undo refusal %s names its remedy", code => {
  command.error = new ApiError(409, code, code);
  const row: FeedRow = { id: "org:batch", source: "org", at: "2026-10-06T00:00:00Z", kind: "APPLY", units: ["품질팀"], count: 1, actor: null, undo: { batchId: "batch" } };
  const html = renderToStaticMarkup(<UndoCell row={row} target="품질팀" />);
  expect(html).toContain('role="alert"');
  expect(html).toContain(t(`orgHistory.refused.${code}`));
  command.error = null;
});
