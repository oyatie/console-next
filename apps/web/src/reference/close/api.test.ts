// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeEach, describe, expect, test, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getMock: vi.fn(),
  bulkMock: vi.fn(),
}));

vi.mock("@console/api", () => {
  class ApiError extends Error {
    status: number;
    code: string;
    refusals: unknown[];
    constructor(status: number, code: string, message: string, refusals: unknown[] = []) {
      super(message);
      this.status = status;
      this.code = code;
      this.refusals = refusals;
    }
  }
  return {
    ApiError,
    api: { GET: hoisted.getMock, POST: vi.fn() },
    assertPasskey: vi.fn(),
    hrWaterfallApi: () => ({ bulkReportExitCases: hoisted.bulkMock }),
    unwrap: async <T>(p: Promise<{ data?: T; error?: unknown }>) => {
      const res = await p;
      if (res.error) throw res.error;
      return res.data as T;
    },
  };
});

import { readIdentity } from "../../lib/query";
import { entityPeopleQuery, reportCloseExits } from "./api";

beforeEach(() => {
  hoisted.getMock.mockReset();
  hoisted.bulkMock.mockReset();
});

describe("entityPeopleQuery", () => {
  test("preserves /api/v1/employees key prefix and paginates through all >1000 cursor pages", async () => {
    const page1Items = Array.from({ length: 1000 }, (_, i) => ({ id: `e-${i}`, name: `Person ${i}` }));
    const page2Items = Array.from({ length: 250 }, (_, i) => ({ id: `e-${1000 + i}`, name: `Person ${1000 + i}` }));
    hoisted.getMock
      .mockResolvedValueOnce({
        data: { items: page1Items, total: 1250, limit: 1000, offset: 0, next_cursor: "cur-1" },
      })
      .mockResolvedValueOnce({
        data: { items: page2Items, total: 1250, limit: 1000, offset: 0, next_cursor: null },
      });

    const descriptor = entityPeopleQuery("entity-1");
    expect(readIdentity(descriptor)).toContain('"/api/v1/employees"');
    const result = await descriptor.queryFn();

    expect(hoisted.getMock).toHaveBeenCalledTimes(2);
    expect(hoisted.getMock).toHaveBeenNthCalledWith(1, "/api/v1/employees", {
      params: {
        query: {
          legal_entity_id: "entity-1",
          status: ["ACTIVE", "ON_LEAVE", "UNKNOWN", "PRE_HIRE"],
          sort: "name",
          limit: 1000,
        },
      },
    });
    expect(hoisted.getMock).toHaveBeenNthCalledWith(2, "/api/v1/employees", {
      params: {
        query: {
          legal_entity_id: "entity-1",
          status: ["ACTIVE", "ON_LEAVE", "UNKNOWN", "PRE_HIRE"],
          sort: "name",
          limit: 1000,
          cursor: "cur-1",
        },
      },
    });
    expect(result.items).toHaveLength(1250);
    expect(result.total).toBe(1250);
    expect(result.next_cursor).toBeNull();
  });

  test("terminates when next_cursor repeats or page returns empty items", async () => {
    hoisted.getMock
      .mockResolvedValueOnce({
        data: { items: [{ id: "e-1", name: "Person 1" }], total: 2, limit: 1000, offset: 0, next_cursor: "cur-loop" },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "e-2", name: "Person 2" }], total: 2, limit: 1000, offset: 0, next_cursor: "cur-loop" },
      });

    const res1 = await entityPeopleQuery("entity-loop").queryFn();
    expect(hoisted.getMock).toHaveBeenCalledTimes(2);
    expect(res1.items).toHaveLength(2);

    hoisted.getMock.mockReset();
    hoisted.getMock.mockResolvedValueOnce({
      data: { items: [], total: 0, limit: 1000, offset: 0, next_cursor: "cur-empty" },
    });

    const res2 = await entityPeopleQuery("entity-empty").queryFn();
    expect(hoisted.getMock).toHaveBeenCalledTimes(1);
    expect(res2.items).toHaveLength(0);
  });
});

describe("reportCloseExits", () => {
  test("returns empty array for zero people without calling bulk API", async () => {
    const out = await reportCloseExits([], { date: "2026-11-30", reason: "CLOSE", note: "note" }, new Map());
    expect(out).toEqual([]);
    expect(hoisted.bulkMock).not.toHaveBeenCalled();
  });

  test("chunks >500 people into batches of <=500 with deterministic per-chunk idempotency keys and partial failure mapping", async () => {
    const people = Array.from({ length: 502 }, (_, i) => ({ id: `emp-${i}`, name: `Employee ${i}` }));
    hoisted.bulkMock
      .mockResolvedValueOnce({
        results: people.slice(0, 500).map((p, idx) =>
          idx === 1
            ? { employee_id: p.id, ok: false, code: "exit_already_open" }
            : { employee_id: p.id, ok: true, case_id: `case-${idx}` },
        ),
      })
      .mockResolvedValueOnce({
        results: [
          { employee_id: "emp-500", ok: true, case_id: "case-500" },
          { employee_id: "emp-501", ok: false },
        ],
      });

    const keys = new Map<string, string>();
    const body = { date: "2026-11-30", reason: "ENTITY_CLOSE", note: "Entity closing" };
    const out = await reportCloseExits(people, body, keys);

    expect(hoisted.bulkMock).toHaveBeenCalledTimes(2);
    const [call1Body, call1Key] = hoisted.bulkMock.mock.calls[0]!;
    const [call2Body, call2Key] = hoisted.bulkMock.mock.calls[1]!;
    expect(call1Body.items).toHaveLength(500);
    expect(call2Body.items).toHaveLength(2);
    expect(call1Body.effective_exit_date).toBe("2026-11-30");
    expect(call1Body.exit_reason_code).toBe("ENTITY_CLOSE");
    expect(call1Key).toBeTruthy();
    expect(call2Key).toBeTruthy();
    expect(call1Key).not.toBe(call2Key);

    expect(out).toHaveLength(502);
    expect(out[0]).toEqual({ id: "emp-0", name: "Employee 0", code: undefined });
    expect(out[1]).toEqual({ id: "emp-1", name: "Employee 1", code: "exit_already_open" });
    expect(out[501]).toEqual({ id: "emp-501", name: "Employee 501", code: "failed" });

    // Retry with identical inputs reuses exact same keys
    hoisted.bulkMock
      .mockResolvedValueOnce({ results: people.slice(0, 500).map(p => ({ employee_id: p.id, ok: true })) })
      .mockResolvedValueOnce({ results: people.slice(500).map(p => ({ employee_id: p.id, ok: true })) });
    await reportCloseExits(people, body, keys);
    expect(hoisted.bulkMock.mock.calls[2]![1]).toBe(call1Key);
    expect(hoisted.bulkMock.mock.calls[3]![1]).toBe(call2Key);

    // Changing date, reason, or note generates new idempotency keys
    hoisted.bulkMock
      .mockResolvedValueOnce({ results: people.slice(0, 500).map(p => ({ employee_id: p.id, ok: true })) })
      .mockResolvedValueOnce({ results: people.slice(500).map(p => ({ employee_id: p.id, ok: true })) });
    await reportCloseExits(people, { ...body, date: "2026-12-01" }, keys);
    expect(hoisted.bulkMock.mock.calls[4]![1]).not.toBe(call1Key);

    hoisted.bulkMock
      .mockResolvedValueOnce({ results: people.slice(0, 500).map(p => ({ employee_id: p.id, ok: true })) })
      .mockResolvedValueOnce({ results: people.slice(500).map(p => ({ employee_id: p.id, ok: true })) });
    await reportCloseExits(people, { ...body, note: "Different manager note" }, keys);
    expect(hoisted.bulkMock.mock.calls[6]![1]).not.toBe(call1Key);
  });

  test("normalizes empty error code to failed so ok:false is never counted as succeeded", async () => {
    hoisted.bulkMock.mockResolvedValueOnce({
      results: [{ employee_id: "emp-1", ok: false, code: "" }],
    });
    const out = await reportCloseExits([{ id: "emp-1", name: "Employee 1" }], { date: "2026-11-30", reason: "CLOSE", note: "note" }, new Map());
    expect(out).toEqual([{ id: "emp-1", name: "Employee 1", code: "failed" }]);
  });
});
