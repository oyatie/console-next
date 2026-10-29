// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { modules, screenAccess } from "../../../../e2e/mock/fixtures";
import { rememberedRail } from "./nav";

afterEach(() => vi.unstubAllGlobals());

test.each([{ readiness: modules.ready }, { readiness: null }])("the last rail facts are read only from this principal's storage key: $readiness", ({ readiness }) => {
  const answer = { access: screenAccess("/org"), supportApproval: false,
    context: { pathname: "/org", phase: "OPERATING", modules: readiness, setupTargets: ["/org"] } };
  const getItem = vi.fn((key: string) => key === "console.nav.viewer" ? JSON.stringify(answer) : null);
  vi.stubGlobal("localStorage", { getItem });
  expect(rememberedRail("console.nav.viewer")).toEqual(answer);
  expect(rememberedRail("console.nav.other")).toBeUndefined();
  expect(rememberedRail(null)).toBeUndefined();
  expect(getItem).toHaveBeenCalledTimes(2);
});

test.each(["broken JSON", "null", "{}", JSON.stringify({ access: { is_ops: false, entries: [null] } }),
  JSON.stringify({ access: { is_ops: true, entries: [] }, supportApproval: true, context: { pathname: "/", modules: [null] } }),
])("invalid remembered facts leave the rail in its skeleton state: %s", value => {
  vi.stubGlobal("localStorage", { getItem: () => value });
  expect(rememberedRail("console.nav.viewer")).toBeUndefined();
});

test("blocked storage leaves navigation available for a fresh server answer", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  expect(rememberedRail("console.nav.viewer")).toBeUndefined();
});
