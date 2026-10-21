import { describe, expect, test } from "vitest";
import { edit, hasConflict, isConflict, isDirty, jsonEqual, load, outcome, rebase, rebaseAll, resolve } from "./three-way";

// One test per row of concurrent-editing.md §1 (ME-1..ME-5), then the §3 client rules.

describe("ME §1", () => {
  test("ME-1: another change to a field the user has not edited is taken and flagged", () => {
    const r = rebase(load("Seoul"), "Busan");
    expect(r.outcome).toBe("take");
    expect(r.field).toEqual({ base: "Busan", yours: "Busan", current: "Busan" });
    expect(isDirty(r.field)).toBe(false);
  });

  test("ME-2: an edited field changed elsewhere to a different value is a conflict that blocks submit", () => {
    const mine = edit(load("Seoul"), "Incheon");
    const r = rebase(mine, "Busan");
    expect(r.outcome).toBe("conflict");
    // base and yours are untouched; current shows the other value.
    expect(r.field).toEqual({ base: "Seoul", yours: "Incheon", current: "Busan" });
    expect(isConflict(r.field)).toBe(true);
    expect(hasConflict({ city: r.field })).toBe(true);
  });

  test("ME-2: 'theirs' uses the current value", () => {
    const f = rebase(edit(load("Seoul"), "Incheon"), "Busan").field;
    const done = resolve(f, "theirs");
    expect(done).toEqual({ base: "Busan", yours: "Busan", current: "Busan" });
    expect(isConflict(done)).toBe(false);
  });

  test("ME-2: 'mine' keeps the input and moves base to current for the next test op", () => {
    const f = rebase(edit(load("Seoul"), "Incheon"), "Busan").field;
    const done = resolve(f, "mine");
    expect(done).toEqual({ base: "Busan", yours: "Incheon", current: "Busan" });
    expect(isConflict(done)).toBe(false);
    expect(isDirty(done)).toBe(true);
  });

  test("ME-2: submit stays blocked until every conflict has a choice", () => {
    const fields = rebaseAll(
      { a: edit(load(1), 2), b: edit(load("x"), "y"), c: load(true) },
      { a: 3, b: "z", c: false },
    ).fields;
    expect(hasConflict(fields)).toBe(true);
    const oneChosen = { ...fields, a: resolve(fields.a, "mine") };
    expect(hasConflict(oneChosen)).toBe(true);
    expect(hasConflict({ ...oneChosen, b: resolve(fields.b, "theirs") })).toBe(false);
  });

  test("ME-3: both sides set the same value: no conflict, already applied", () => {
    const r = rebase(edit(load("Seoul"), "Busan"), "Busan");
    expect(r.outcome).toBe("same");
    expect(r.field).toEqual({ base: "Busan", yours: "Busan", current: "Busan" });
    expect(isConflict(r.field)).toBe(false);
  });

  test("ME-4: the outcomes name the changed fields so dependents can be re-validated", () => {
    const { outcomes } = rebaseAll(
      { position: load("P1"), grade: edit(load("G1"), "G2"), phone: load("010") },
      { position: "P2", grade: "G1", phone: "010" },
    );
    expect(outcomes).toEqual({ position: "take", grade: "unchanged", phone: "unchanged" });
    const changed = Object.entries(outcomes).filter(([, o]) => o !== "unchanged").map(([k]) => k);
    expect(changed).toEqual(["position"]);
  });

  test("ME-5: the user's input survives every server update", () => {
    const mine = edit(load("a"), "mine");
    for (const current of ["a", "b", "mine", null, undefined, { x: 1 }]) {
      expect(rebase(mine, current).field.yours).toBe("mine");
    }
    // Only an explicit 'theirs' replaces it.
    expect(resolve(rebase(mine, "b").field, "mine").yours).toBe("mine");
  });
});

describe("§3 client rules", () => {
  test("no server change: nothing happens, the draft is kept", () => {
    const mine = edit(load("a"), "b");
    expect(rebase(mine, "a")).toEqual({ field: mine, outcome: "unchanged" });
    expect(rebase(load("a"), "a").outcome).toBe("unchanged");
  });

  test("the conflict is derived: it clears when current moves back or to the user's value", () => {
    const c = rebase(edit(load("a"), "b"), "c").field;
    expect(rebase(c, "a").outcome).toBe("unchanged");
    expect(isConflict(rebase(c, "a").field)).toBe(false);
    expect(rebase(c, "b").outcome).toBe("same");
    expect(rebase(c, "d").outcome).toBe("conflict");
  });

  test("'mine' then another remote change is a fresh conflict against the new base", () => {
    const kept = resolve(rebase(edit(load("a"), "b"), "c").field, "mine");
    const r = rebase(kept, "d");
    expect(r.outcome).toBe("conflict");
    expect(r.field).toEqual({ base: "c", yours: "b", current: "d" });
  });

  test("a 409 field_conflict body feeds the same merge; fields it does not name are kept", () => {
    // errors[] = [{ pointer: "/city", current: "Busan", ... }] mapped to { city: "Busan" }.
    const form = { city: edit(load("Seoul"), "Incheon"), phone: edit(load("010"), "011") };
    const { fields, outcomes } = rebaseAll(form, { city: "Busan" });
    expect(outcomes).toEqual({ city: "conflict", phone: "unchanged" });
    expect(fields.phone).toBe(form.phone);
    expect(hasConflict(fields)).toBe(true);
  });

  test("an existing conflict is reported for a field the update does not name", () => {
    const form = { city: rebase(edit(load("a"), "b"), "c").field };
    expect(rebaseAll(form, {}).outcomes.city).toBe("conflict");
  });

  test("outcome reads the stored triple", () => {
    expect(outcome({ base: 1, yours: 2, current: 3 })).toBe("conflict");
    expect(outcome({ base: 1, yours: 1, current: 3 })).toBe("take");
  });
});

describe("ME-9 canonical compare (RFC 6902 §4.6)", () => {
  test("objects compare by key, not order; arrays by order", () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: undefined }, { b: undefined })).toBe(false);
  });

  test("numbers numerically, strings exactly, null is not missing", () => {
    expect(jsonEqual(1.5, 1.50)).toBe(true);
    expect(jsonEqual(0, -0)).toBe(true);
    expect(jsonEqual("1.5", "1.50")).toBe(false);
    expect(jsonEqual("1", 1)).toBe(false);
    expect(jsonEqual(null, undefined)).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
  });

  test("a reordered object from a refetch is not a server change", () => {
    const f = edit(load({ street: "x", zip: "1" }), { street: "y", zip: "1" });
    expect(rebase(f, { zip: "1", street: "x" }).outcome).toBe("unchanged");
  });
});
