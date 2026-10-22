// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { emptyDraft } from "../domain/draft";
import { EntityBulkPage } from "./entity-bulk-page";

const harness = vi.hoisted(() => ({ states: [] as unknown[], commands: [] as { run: (input: undefined, key: string) => Promise<unknown> }[], batch: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => harness.states.length ? [harness.states.shift(), vi.fn()] : actual.useState(initial) };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { steps: [{ key: "entity", can_act: true }] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ children }: { children: (data: unknown) => ReactNode }) => children({ steps: [{ key: "entity", can_act: true }] }) }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (options: { run: (input: undefined, key: string) => Promise<unknown> }) => {
  harness.commands.push(options); return { mutate: vi.fn(), reset: vi.fn() };
} }));
vi.mock("../../../lib/react/command-error", () => ({ CommandError: () => null }));
vi.mock("../../../reference/org/api/setup-batch", () => ({ BATCH_READS: [], entityBatch: harness.batch }));
vi.mock("./bulk-entity-row", () => ({ BulkEntityRow: () => null }));
beforeAll(() => loadCatalog("ko"));

test("preview and apply send the same revision date and person reason with the digest", async () => {
  const entity = { id: "11111111-1111-1111-1111-111111111111", biz_kind: "INDIVIDUAL", workplaces: [], registrations: [], current: { name: "Before", version: 3, representatives: ["Kim"] } };
  const rows = [{ line: 2, op: "REVISE_ENTITY", id: entity.id, draft: { ...emptyDraft(), name: "After" } }];
  harness.states = ["", [], 0, 0, null, rows, { preview_digest: "proof", items: [] }, null, "2026-10-01", "주소 정정", [entity]];
  harness.commands = [];
  renderToStaticMarkup(<EntityBulkPage paste />);
  await harness.commands[1]!.run(undefined, "preview");
  await harness.commands[2]!.run(undefined, "apply");
  expect(harness.batch).toHaveBeenNthCalledWith(1, expect.objectContaining({ dry_run: true, effective_from: "2026-10-01", reason_code: "주소 정정" }));
  expect(harness.batch).toHaveBeenNthCalledWith(2, expect.objectContaining({ dry_run: false, preview_digest: "proof", effective_from: "2026-10-01", reason_code: "주소 정정" }), "apply");
});
