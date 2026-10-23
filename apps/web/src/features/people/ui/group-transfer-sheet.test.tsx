// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { GroupTransferSheet } from "./group-transfer-sheet";

const frame = vi.hoisted(() => ({ locked: false as boolean | undefined }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [], entities: [] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span> }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => true }));
vi.mock("../domain/group-transfer", () => ({ groupMissing: () => ({}), groupTargets: () => ({ kind: "none", scoped: false }) }));
vi.mock("./use-lifecycle-draft", () => ({ useDraft: () => ({ draft: { date: "", comment: "" } }) }));
vi.mock("./use-lifecycle-command", () => ({ useLifecycleCommand: () => ({ isError: false }) }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: { locked?: boolean; children: ReactNode; actions: ReactNode }) => { frame.locked = p.locked; return <>{p.children}{p.actions}</>; } }));
beforeAll(() => loadCatalog("ko"));

test("no receiving entity keeps both registration and same-entity transfer remedies outside an inert body", () => {
  const d = { employee: { id: "person", name: "대상자", legal_entity_id: "entity" } } as Parameters<typeof GroupTransferSheet>[0]["d"];
  const html = renderToStaticMarkup(<GroupTransferSheet d={d} events={[]} head={0} units={[]} act="GROUP_TRANSFER" offer={{ event_type: "GROUP_TRANSFER", required_signoffs: [] }} changed={false} onClose={() => {}} onOpen={() => {}} onRecorded={() => {}} onReread={async () => undefined} />);
  expect(frame.locked).not.toBe(true);
  expect(html).toContain('data-to="/org/entities/new"');
  expect(html).toContain("법인 등록");
  expect(html).toContain("같은 법인 안이면 전보");
});
