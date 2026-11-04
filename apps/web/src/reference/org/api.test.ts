// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { governed, inlineUnitBody, changeReceipt } from "./api";

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@console/api", async (original) => ({ ...await original<typeof import("@console/api")>(), api: { POST: post, GET: get } }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => vi.resetAllMocks());
const body = { kind: "NEW" as const, target: { kind: "ORG_UNIT" as const, ref: "parent", label: "unit" }, effectiveDate: "2026-12-01", reason: "Growth", proposal: [] };
const draft = { id: "change", code: "OC-1", status: "DRAFT" };

test("inline create and rename keep the entered reason separate from their title", () => {
  const values = { effectiveDate: body.effectiveDate, reason: "Growth", submit: true };
  expect(inlineUnitBody({ kind: "create", parentUnitId: "parent", name: "unit", ...values })).toMatchObject({ reason: "Growth", target: body.target });
  expect(inlineUnitBody({ kind: "rename", orgUnitId: "unit", fromName: "before", name: "after", ...values })).toMatchObject({ reason: "Growth", target: { label: t("orgChange.title.rename", { from: "before", to: "after" }) } });
});

test("preflight refusal retains the draft without claiming submission", async () => {
  post.mockResolvedValueOnce({ data: draft, response: new Response() }).mockRejectedValueOnce(new ApiError(409, "preflight_blocked", ""));
  get.mockResolvedValue({ data: draft, response: new Response() });
  expect(await governed("key", body, true)).toMatchObject({ id: draft.id, sent: "unsent" });
});

test("an ordinary refusal is rethrown with no successful receipt", async () => {
  const refusal = new ApiError(422, "invalid_change", "");
  post.mockResolvedValueOnce({ data: draft, response: new Response() }).mockRejectedValueOnce(refusal);
  await expect(governed("key", body, true)).rejects.toBe(refusal);
});

test("saving a draft does not submit it", async () => {
  post.mockResolvedValueOnce({ data: draft, response: new Response() });
  expect(await governed("key", body, false)).toMatchObject({ sent: "saved" });
  expect(post).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
});

test.each(["IN_APPROVAL", "APPROVED", "APPLIED"] as const)("%s selects the server-confirmed receipt", async (status) => {
  post.mockResolvedValueOnce({ data: draft, response: new Response() }).mockResolvedValueOnce({ data: {}, response: new Response() });
  get.mockResolvedValue({ data: { ...draft, status, created_unit_ids: ["unit"] }, response: new Response() });
  const result = await governed("key", body, true);
  expect(result).toMatchObject({ status, select: "unit", sent: "sent" });
  const key = status === "IN_APPROVAL" ? "routedChart" : status === "APPROVED" ? "scheduled" : "applied";
  expect(changeReceipt(result.status, "title", draft.code, body.effectiveDate)).toBe(t(`orgChange.receipt.${key}`, { title: "title", code: draft.code, date: fmtDate(body.effectiveDate) }));
});
