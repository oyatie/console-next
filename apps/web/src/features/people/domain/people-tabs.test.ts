// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { parsePeopleTab, parseExitFilter } from "./people-tabs";

test("only module tabs survive validation; status views remain roster filters", () => {
  for (const value of [undefined, null, {}, ["exits"], "ACTIVE", "unplaced", "unknown"]) expect(parsePeopleTab(value)).toBe("roster");
  expect(parsePeopleTab("appointments")).toBe("appointments");
  expect(parsePeopleTab("exits")).toBe("exits");
});

test("exit filters cannot turn roster statuses into exit case filters", () => {
  expect(parseExitFilter("closed")).toBe("closed");
  expect(parseExitFilter("REPORTED")).toBe("REPORTED");
  for (const value of [undefined, "ACTIVE", "EXITED", {}, ["open"]]) expect(parseExitFilter(value)).toBeUndefined();
});
