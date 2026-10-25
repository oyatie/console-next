// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeEach, expect, test, vi } from "vitest";
import { bindAssignment } from "../../../reference/entity/api";
import { bulkAppoint, previewBulk } from "../api";
import { usePlacePeople } from "./use-place-people";

vi.mock("../../../lib/react/command", () => ({ useCommand: (options: unknown) => options }));
vi.mock("../../../reference/entity/api", () => ({ bindAssignment: vi.fn(), stepKey: (key: string, n: number) => `${key}:${n}` }));
vi.mock("../api", () => ({ previewBulk: vi.fn(), bulkAppoint: vi.fn(), refusalOf: vi.fn() }));
vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-10-25" }));

const person = { id: "person", name: "직원", hire_date: "2008-01-01", legal_entity_id: null };
const target = { unitId: "unit", entityId: "entity", workplaceId: "workplace" };
const run = () => (usePlacePeople(vi.fn(), vi.fn()) as unknown as { run: (input: { people: { id: string; name: string; hire_date: string | null; legal_entity_id: string | null }[]; target: typeof target; setup: boolean; effectiveDate: string }, key: string) => Promise<unknown> }).run;
const input = { people: [person], target, setup: true, effectiveDate: "2026-10-25" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(previewBulk).mockResolvedValue({ refusals: [] } as unknown as Awaited<ReturnType<typeof previewBulk>>);
  vi.mocked(bulkAppoint).mockResolvedValue({ batch_id: "batch" } as Awaited<ReturnType<typeof bulkAppoint>>);
});

test("setup delegates initial legal placement to the atomic server batch", async () => {
  await run()({ ...input, people: [person, { ...person, id: "second", hire_date: "2024-03-04" }] }, "key");
  expect(bulkAppoint).toHaveBeenCalledWith(expect.objectContaining({ employee_ids: ["person", "second"], effective_date: input.effectiveDate }), "key");
  expect(bindAssignment).not.toHaveBeenCalled();
});

test.each(["2026-09-01", "2026-10-25", "2026-11-01"])("operating uses the chosen lifecycle date %s for preview and commit", async (effectiveDate) => {
  await run()({ ...input, setup: false, effectiveDate }, "key");
  expect(previewBulk).toHaveBeenCalledWith(expect.objectContaining({ effective_date: effectiveDate }));
  expect(bulkAppoint).toHaveBeenCalledWith(expect.objectContaining({ effective_date: effectiveDate }), "key");
  expect(bindAssignment).not.toHaveBeenCalled();
});

test("a missing hire date is resolved by the server", async () => {
  await run()({ ...input, people: [{ ...person, hire_date: null }] }, "key");
  expect(bulkAppoint).toHaveBeenCalledOnce();
  expect(bindAssignment).not.toHaveBeenCalled();
});

test("an existing legal placement is left to the lifecycle transfer", async () => {
  await run()({ ...input, people: [{ ...person, legal_entity_id: "entity" }] }, "key");
  expect(bulkAppoint).toHaveBeenCalledOnce();
  expect(bindAssignment).not.toHaveBeenCalled();
});

test.each([true, false])("a named refusal writes neither a transfer nor a binding (setup: %s)", async (setup) => {
  vi.mocked(previewBulk).mockResolvedValue({ refusals: [{ employee_id: person.id, code: "lifecycle_before_hire", message: "before hire" }] } as unknown as Awaited<ReturnType<typeof previewBulk>>);
  const result = await run()({ ...input, setup }, "key");
  expect(result).toMatchObject({ refused: [{ person, code: "lifecycle_before_hire" }], rest: [], setup, effectiveDate: input.effectiveDate });
  expect(bulkAppoint).not.toHaveBeenCalled();
  expect(bindAssignment).not.toHaveBeenCalled();
});
