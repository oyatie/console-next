// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { frame } from "./app";

test("Home validates record selection as a nonempty string", () => {
  const home = frame.screens.find(route => "path" in route.options && route.options.path === "/")!;
  const validate = home.options.validateSearch as (search: Record<string, unknown>) => { sel?: string };
  expect(validate({ sel: "record-1" })).toEqual({ sel: "record-1" });
  for (const sel of [undefined, "", 1, true, ["record-1"], { id: "record-1" }]) {
    expect(validate({ sel })).toEqual({ sel: undefined });
  }
});
