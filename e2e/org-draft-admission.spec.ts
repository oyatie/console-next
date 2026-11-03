// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { firstSignIn, go, kstDate, option } from "./flows";
import { grantAccess, inviteAccount } from "./access-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { addWorkplaceFromEntity, openUnit } from "./helpers/structure";
import { addDepartments } from "./structure-flows";
import { pickKind, setupCompany, startOperations, typeAddress } from "./setup-flows";
import { atPhoneWidth, fits } from "./a11y";

test("draft refusals distinguish invalid input and missing authority without creating records", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "draftadmission", "기안검증회사");
  const bearer = bearerOf(admin);
  await setupCompany(admin, "기안검증회사", "본점");
  await startOperations(admin);
  await go(admin, "/");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  const list = async () => (await api("/org-changes")).json();
  const before = await list();
  const draft = {
    kind: "NEW", target: { kind: "ORG_UNIT", ref: "not-a-uuid", label: "부서" },
    effectiveDate: kstDate(), reason: "기안 거절 검증",
    proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: crypto.randomUUID(), name: "기안검증부" }],
  } satisfies components["schemas"]["CreateOrgChangeRequest"];
  const invalid = await api("/org-changes", "POST", draft, { "Idempotency-Key": crypto.randomUUID() });
  expect([invalid.status(), await codeOf(invalid)]).toEqual([422, "validation"]);
  expect((await invalid.json()).error.support_ref).toEqual(expect.any(String));
  expect(await list()).toEqual(before);
  const viewer = await firstSignIn(browser, await inviteAccount(admin, "기안 권한 없는 사용자", "none"));
  const viewerBearer = bearerOf(viewer);
  await viewer.reload();
  await expect.poll(viewerBearer).not.toBe("");
  const viewerApi = apiOf(viewer, viewerBearer);
  for (const [path, body] of [
    ["/org-changes", { ...draft, target: { ...draft.target, ref: crypto.randomUUID() } }],
    ["/org-units", { kind: "DEPARTMENT", parentId: crypto.randomUUID(), name: "기안검증부" }],
    ["/regions", { name: "권한 없는 지역" }],
    ["/branches", { name: "권한 없는 지점", region_id: crypto.randomUUID() }],
    ["/regions", { name: "가".repeat(121) }],
    ["/branches", { name: "가".repeat(121), region_id: crypto.randomUUID() }],
  ] as const) {
    const denied = await viewerApi(path, "POST", body, { "Idempotency-Key": crypto.randomUUID() });
    expect([denied.status(), await codeOf(denied)]).toEqual([403, "org_change.refuse.missing_grant"]);
    expect((await denied.json()).error.support_ref).toEqual(expect.any(String));
    expect(await list()).toEqual(before);
  }
  await viewer.context().close();
});

test("the move screen offers scoped destinations and keeps a real refused draft open", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "draftscope", "조직범위회사");
  const adminBearer = bearerOf(admin);
  await setupCompany(admin, "조직범위회사", "본점");
  const extra = await addWorkplaceFromEntity(admin, /조직범위회사/);
  await extra.getByLabel("사업장 이름").fill("지점");
  await pickKind(extra);
  await extra.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await option(admin, "4대보험", "아직 없음").click();
  await typeAddress(admin, "소재지", "서울특별시 중구 세종대로 110", "04524");
  await extra.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(extra).toBeHidden();
  await go(admin, "/org");
  await addDepartments(admin, "본점", ["이동팀", "도착팀"]);
  await addDepartments(admin, "지점", ["범위밖팀"]);
  const code = await inviteAccount(admin, "조직 담당자", "none");
  await grantAccess(admin, "조직 담당자", "full", /^본점/);
  await startOperations(admin);
  const worker = await firstSignIn(browser, code);
  const token = bearerOf(worker);
  await worker.reload();
  await expect.poll(token).not.toBe("");
  const api = apiOf(worker, token);
  const adminApi = apiOf(admin, adminBearer);
  const units = (await (await adminApi("/org-units")).json()).items as { id: string; name: string }[];
  const outside = units.find(u => u.name === "범위밖팀")!.id;
  const source = units.find(u => u.name === "이동팀")!.id;
  const destination = units.find(u => u.name === "도착팀")!.id;
  const move = async () => {
    const unit = await openUnit(worker, "이동팀");
    await unit.getByRole("button", { name: "이동", exact: true }).first().click();
    const tree = worker.getByRole("treegrid", { name: "어디로" });
    await expect(tree.getByRole("row", { name: /^지점/ })).toHaveCount(0);
    await expect(tree.getByRole("row", { name: /^범위밖팀/ })).toHaveCount(0);
    await tree.getByRole("row", { name: /^도착팀/ }).click();
    await worker.getByRole("main").getByRole("button", { name: /^오늘/ }).click();
    await worker.getByRole("main").getByRole("textbox", { name: /^사유/ }).fill("조직 범위 검증");
  };
  await move();
  const created = worker.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/org-changes");
  await worker.getByRole("button", { name: "임시 저장", exact: true }).click();
  const saved = await created;
  expect(saved.status()).toBe(201);
  const draft = await saved.json() as { id: string };
  const before = await (await adminApi(`/org-changes/${draft.id}`)).json();
  const patched = await api(`/org-changes/${draft.id}`, "PATCH", { proposal: [{ op: "MOVE_ORG_UNIT", orgUnitId: source, parentId: outside }] });
  expect([patched.status(), await codeOf(patched)]).toEqual([404, "org_change.refuse.missing_grant"]);
  expect(await (await adminApi(`/org-changes/${draft.id}`)).json()).toEqual(before);
  await move();
  const listBefore = await (await adminApi("/org-changes")).json();
  // A destination changed after rendering still goes through the server's current scope decision.
  await worker.route((url) => url.pathname === "/api/v1/org-changes", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as components["schemas"]["CreateOrgChangeRequest"];
    expect(body.proposal).toContainEqual({ op: "MOVE_ORG_UNIT", orgUnitId: source, parentId: destination });
    body.proposal = [{ op: "MOVE_ORG_UNIT", orgUnitId: source, parentId: outside }];
    await route.continue({ postData: JSON.stringify(body) });
  });
  const refused = worker.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/org-changes");
  await worker.getByRole("button", { name: "부서 이동 1개 적용" }).click();
  const response = await refused;
  expect([response.status(), await codeOf(response)]).toEqual([403, "org_change.refuse.missing_grant"]);
  expect(await (await adminApi("/org-changes")).json()).toEqual(listBefore);
  await expect(worker.getByRole("alert")).toContainText("조직 변경에 필요한 권한이 없거나 만료되어 처리하지 않았습니다");
  await expect(worker).toHaveURL(/\/org\/move\?/);
  await worker.getByRole("button", { name: "어두운 화면으로 전환" }).click();
  await expect(worker.locator("html")).toHaveAttribute("data-theme", "dark");
  await atPhoneWidth(worker, async () => {
    await expect(worker.getByRole("alert")).toBeVisible();
    await fits(worker, "org move refusal");
  });
  await worker.context().close();
  await admin.context().close();
});
