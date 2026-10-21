import { expect, test } from "vitest";
import { kstDay, passkeyRows } from "./passkeys";

const pk = (id: string, created_at: string, last_used_at: string | null = null) => ({ id, created_at, last_used_at });

test("the registration day is the Seoul calendar day", () => {
  expect(kstDay("2026-10-01T15:30:00Z")).toBe("2026-10-02");
  expect(kstDay("2026-10-01T14:59:59Z")).toBe("2026-10-01");
});

test("rows are oldest first, numbered only within a shared day, and the most recently used of several is marked", () => {
  const rows = passkeyRows([
    pk("c", "2026-10-02T03:00:00Z", "2026-10-02T04:00:00Z"),
    pk("a", "2026-09-01T03:00:00Z", "2026-10-01T00:00:00Z"),
    pk("b", "2026-10-02T01:00:00Z"),
  ]);
  expect(rows.map((r) => [r.id, r.day, r.nth, r.recent])).toEqual([
    ["a", "2026-09-01", 0, false],
    ["b", "2026-10-02", 1, false],
    ["c", "2026-10-02", 2, true],
  ]);
});

test("a single passkey is neither numbered nor marked", () => {
  expect(passkeyRows([pk("a", "2026-10-02T03:00:00Z", "2026-10-02T04:00:00Z")])).toMatchObject([{ nth: 0, recent: false }]);
  expect(passkeyRows([pk("a", "2026-10-02T03:00:00Z"), pk("b", "2026-10-03T03:00:00Z")]).some((r) => r.recent)).toBe(false);
});
