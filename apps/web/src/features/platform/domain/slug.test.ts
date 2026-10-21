import { expect, test } from "vitest";
import { asSlug, openedBy, slugProblem, suggestedDomain } from "./slug";

const existing = [{ slug: "platform", name: "Platform" }, { slug: "hanbit", name: "한빛정밀" }];

test("typed text is lower-cased as the user types", () => {
  expect(asSlug("HanBit-2")).toBe("hanbit-2");
});

test("the server's pattern: starts with a letter or digit, then letters, digits or hyphens", () => {
  expect(slugProblem("acme-2", existing)).toBeNull();
  expect(slugProblem("2acme", existing)).toBeNull();
  for (const bad of ["", "-acme", "acme_co", "ac me", "Acme", "한빛", "ab", "acme-", "a".repeat(41)]) expect(slugProblem(bad, existing), bad).toEqual({ kind: "pattern" });
});

test("an existing tenant's slug is taken, named by its owner (the platform's own row too)", () => {
  expect(slugProblem("hanbit", existing)).toEqual({ kind: "taken", org: "한빛정밀" });
  expect(slugProblem(" platform ", existing)).toEqual({ kind: "taken", org: "Platform" });
});

test("a lost onboarding response is matched on the exact slug sent and an id unknown before, never on the name", () => {
  const known = new Set(["t-old"]);
  const all = [
    { id: "t-old", slug: "saeon-a", name: "새온그룹" },
    { id: "t-decoy", slug: "saeon-b", name: "새온그룹" }, // same name, someone else's slug: never ours
    { id: "t-ours", slug: "saeon-c", name: "새온" },
  ];
  expect(openedBy(all, "saeon-c", known)?.id).toBe("t-ours");
  expect(openedBy(all, "saeon-d", known)).toBeUndefined(); // the name alone finds nothing
  expect(openedBy(all, "saeon-a", known)).toBeUndefined(); // already there before the send: not what it opened
});

test("only supplied website/email labels passing the rule are suggestions", () => {
  for (const text of ["saeon.example", "www.saeon.example"]) expect(suggestedDomain(text)).toBe("saeon");
  for (const text of ["한빛정밀", "ab.com", "bad_.com", "x", "https://"]) expect(suggestedDomain(text)).toBeNull();
  expect(slugProblem("former", [{ slug: "current", name: "Customer", domain_aliases: ["former"] }])).toEqual({ kind: "taken", org: "Customer" });
});
