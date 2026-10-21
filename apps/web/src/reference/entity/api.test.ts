import { describe, expect, it, test } from "vitest";
import { entitiesAt, entitiesRef, orgStructureAt, orgStructureRef, stepKey } from "./api";
import { get, readIdentity } from "../../lib/query";

describe("stepKey", () => {
  const key = "3f1c2b7e-9a4d-4c1e-8b2a-5d6e7f8091ab";
  it("derives a distinct UUID per step, the same on every retry", () => {
    const steps = [0, 1, 2].map((n) => stepKey(key, n));
    expect(new Set(steps).size).toBe(3);
    expect(steps.map((n, i) => stepKey(key, i) === n)).toEqual([true, true, true]);
    for (const s of steps) expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

test("today's chart and its panels share the same reads and invalidation", () => {
  expect(orgStructureAt({ as_of: undefined, known_at: undefined })).toBe(orgStructureRef);
  expect(entitiesAt({})).toBe(entitiesRef);
});

test("dated and knowledge-limited reads keep their own coordinates", () => {
  for (const query of [{ as_of: "2026-10-13" }, { known_at: "2026-10-10T00:00:00Z" }]) {
    expect(readIdentity(orgStructureAt(query))).not.toBe(readIdentity(orgStructureRef));
    expect(readIdentity(entitiesAt(query))).not.toBe(readIdentity(entitiesRef));
    expect(readIdentity(orgStructureAt(query))).toBe(readIdentity(get("/api/v1/org-structure", { params: { query } })));
    expect(readIdentity(entitiesAt(query))).toBe(readIdentity(get("/api/v1/legal-entities", { params: { query } })));
  }
});
