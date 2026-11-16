// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AnyRoute } from "@tanstack/react-router";
import { peopleRoutes } from "./people";
import { employeeQuery } from "../features/people/api";
import { assignmentsRef, entitiesRef } from "../reference/entity/api";
import { unitsQuery } from "../reference/org/api";

const session = vi.hoisted(() => ({ token: null as string | null, lost: false }));
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), session }));

for (const state of ["restoring", "expired", "active"] as const) test(`employee loader warms the page cache only for the ${state} session`, async () => {
  session.token = state === "restoring" ? null : "token";
  session.lost = state === "expired";
  const client = new QueryClient();
  const ensure = vi.spyOn(client, "ensureQueryData").mockResolvedValue(undefined);
  const loader = (peopleRoutes as AnyRoute[]).find(route => "path" in route.options && route.options.path === "/people/$id")!.options.loader;
  expect(loader).toBeTypeOf("function");
  if (typeof loader !== "function") throw new Error("employee route needs a loader");
  await loader({ params: { id: "person" }, context: { queryClient: client } } as never);
  if (state === "active") {
    const reads = [employeeQuery("person"), assignmentsRef("person"), entitiesRef, unitsQuery];
    expect(ensure).toHaveBeenCalledTimes(reads.length);
    for (const [index, query] of reads.entries()) expect(ensure).toHaveBeenNthCalledWith(index + 1, { ...query, queryFn: expect.any(Function) });
  } else expect(ensure).not.toHaveBeenCalled();
});
