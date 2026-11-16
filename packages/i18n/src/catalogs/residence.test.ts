// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { enFacts } from "./en/facts";
import { koFacts } from "./ko/facts";

test.each(["nationality_required", "not_applicable", "dates", "unknown", "overlap"] as const)(
  "residence refusal %s has display copy in both locales",
  refusal => {
    const id = `facts.residence.refuse.${refusal}` as const;
    for (const catalog of [koFacts, enFacts]) {
      expect(catalog[id]?.trim()).toBeTruthy();
      expect(catalog[id]).not.toBe(id);
    }
    expect(koFacts[id]).not.toBe(enFacts[id]);
  },
);
