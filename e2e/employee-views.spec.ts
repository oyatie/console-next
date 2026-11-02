// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { tenantWithExecutive } from "./setup-flows";
import { go } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";

test("saved roster views persist, replay and refuse duplicate names", async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "viewco", "명부주식회사");
  const bearer = bearerOf(admin);
  await go(admin, "/account");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  const path = "/me/employee-views";
  const empty = await api(path);
  expect(empty.status()).toBe(200);
  expect(await empty.json()).toEqual({ items: [] });
  const view = { id: crypto.randomUUID(), name: "재직 직원", filters: { status: "ACTIVE", review: "identity", sort: "name" } };
  const headers = { "Idempotency-Key": view.id };
  const created = await api(path, "POST", view, headers);
  expect(created.status()).toBe(201);
  expect(await created.json()).toEqual(view);
  await admin.reload();
  await expect.poll(async () => (await api(path)).json()).toEqual({ items: [view] });
  const replay = await api(path, "POST", view, headers);
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(view);
  const duplicate = { ...view, id: crypto.randomUUID() };
  const refused = await api(path, "POST", duplicate, { "Idempotency-Key": duplicate.id });
  expect(refused.status()).toBe(409);
  expect(await codeOf(refused)).toBe("employee_view_name_taken");
  const mismatch = await api(path, "POST", { ...view, name: "다른 명부" }, headers);
  expect(mismatch.status()).toBe(409);
  expect(await codeOf(mismatch)).toBe("idempotency_key_reused");
  expect(await (await api(path)).json()).toEqual({ items: [view] });
});
