// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { tenantNav } from "./nav";
import { AT, user } from "../../../../e2e/mock/fixtures";
const routes = { "/payroll": { options: { staticData: { access: { domain: "pay", level: "view" as const } } } } };
const access = { account_id: user.id, is_ops: true, phase: "OPERATING" as const, as_of: AT, entries: [] };
test("payroll needs explicit server readiness, even when the modules read is absent", () => {
  const links = (modules?: { key: "payroll"; ready: boolean; unblock: null }[]) => tenantNav(access, routes, false, { pathname: "/", modules }).flatMap(hub => hub.links);
  expect(links()).toEqual([]);
  expect(links([])).toEqual([]);
  expect(links([{ key: "payroll", ready: false, unblock: null }])).toEqual([]);
  expect(links([{ key: "payroll", ready: true, unblock: null }]).map(link => link.to)).toEqual(["/payroll"]);
  expect(tenantNav(undefined, routes, false, { pathname: "/", modules: [{ key: "payroll", ready: true, unblock: null }] })).toEqual([]);
});
