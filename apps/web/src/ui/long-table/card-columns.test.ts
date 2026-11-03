// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { cardRoles } from "./card-columns";

test("row headers identify cards, explicit omissions win, and unspecified facts survive", () => {
  expect(cardRoles([
    {}, { wide: true }, { rowHeader: true }, { wide: true, card: "fact" },
    { card: "status" }, { card: "action" }, { rowHeader: true, card: "omit" },
    {}, {}, {},
  ])).toEqual(["title", "omit", "title", "fact", "status", "action", "omit", "fact", "fact", "fact"]);
});
