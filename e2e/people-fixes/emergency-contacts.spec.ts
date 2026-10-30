// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { peopleWorld, registerAt } from "../helpers/people-fixes";

test("solo: emergency contact notice is enforced; evidence survives sibling deletion and undo", { tag: ["@hr", "@regression", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await peopleWorld(browser, "emergencynotice");
  const api = apiOf(admin, bearerOf(admin));
  const worker = await registerAt(admin, "사람기술", "연락인", "EC-0001");
  const read = async () => (await (await api(`/employees/${worker.id}/personal-facts`)).json()) as {
    updated_at: string;
    emergency_contacts: { name: string; relation: string; phone: string; contact_notified: boolean; basis: string | null; recorded_by_name: string; recorded_at: string }[] | null;
  };
  const before = await read();
  for (const contact_notified of [null, false]) {
    const refused = await api(`/employees/${worker.id}`, "PATCH", {
      expected_updated_at: before.updated_at, reason_code: "QUICK_EDIT",
      changes: { emergency_contacts: [{ name: "이하나", relation: "SPOUSE", phone: "010-1234-5678", contact_notified }] },
    }, { "Accept-Language": "ko" });
    expect(refused.status()).toBe(422);
    expect(await codeOf(refused)).toBe("emergency_contact_notice_unconfirmed");
    expect(JSON.stringify(await refused.json())).toContain("알렸는지 확인");
    expect(await read()).toEqual(before);
  }
  for (const [name, relation, phone] of [["이하나", "배우자", "01012345678"], ["이두리", "부모", "01098765432"]]) {
    await admin.getByRole("button", { name: "비상연락처 추가", exact: true }).click();
    const sheet = admin.getByRole("dialog", { name: "비상연락처 추가" });
    await sheet.getByRole("textbox", { name: /^이름/ }).fill(name!);
    await sheet.getByLabel(/^관계/).selectOption({ label: relation! });
    await sheet.getByRole("textbox", { name: /^휴대전화/ }).fill(phone!);
    await expect(sheet.getByRole("button", { name: /인사 정보 1명 정정/ })).toHaveAttribute("aria-disabled", "true");
    await sheet.getByRole("checkbox").check();
    await sheet.getByRole("button", { name: /인사 정보 1명 정정/ }).click();
    await expect(sheet).toBeHidden();
  }
  const recorded = (await read()).emergency_contacts!;
  const contacts = admin.getByRole("list", { name: "비상연락처", exact: true });
  await expect(contacts).toContainText("응급 상황 대비 (검토 전)");
  await expect(contacts).toContainText(recorded[0]!.recorded_by_name);
  await expect(contacts).toContainText("KST");
  await expect(contacts).not.toContainText(recorded[0]!.basis!);
  await expect(contacts).not.toContainText(recorded[0]!.recorded_at);
  await contacts.getByRole("button", { name: /배우자.*더보기/ }).click();
  await admin.getByRole("menuitem", { name: /삭제|무효화/ }).click();
  await expect.poll(async () => (await read()).emergency_contacts).toEqual([recorded[1]]);
  await admin.getByRole("button", { name: "되돌리기 ⌘Z", exact: true }).click();
  await expect.poll(async () => (await read()).emergency_contacts).toEqual(recorded);
  const legacy = recorded.map(({ name, relation, phone }) => ({ name, relation, phone }));
  const patch = async (emergency_contacts: unknown[]) => api(`/employees/${worker.id}`, "PATCH", {
    expected_updated_at: (await read()).updated_at, reason_code: "QUICK_EDIT", changes: { emergency_contacts },
  });
  expect((await patch(legacy)).status()).toBe(200);
  expect((await read()).emergency_contacts).toEqual(recorded);
  legacy.push({ name: "이세리", relation: "SIBLING", phone: "010-5555-6666" });
  expect((await patch(legacy)).status()).toBe(200);
  const withLegacy = (await read()).emergency_contacts!;
  expect(withLegacy.slice(0, 2)).toEqual(recorded);
  expect(withLegacy[2]).toMatchObject({ contact_notified: false, basis: null });
  expect((await patch(legacy)).status()).toBe(200);
  expect((await read()).emergency_contacts).toEqual(withLegacy);
  await admin.reload();
  const unconfirmed = contacts.getByRole("listitem").filter({ hasText: "형제자매" });
  await expect(unconfirmed.locator(".chip--warn")).toHaveText("당사자 안내 미확인");
  await expect(contacts.locator(".chip--warn")).toHaveCount(1);
  await expect(contacts).not.toContainText("연락처 당사자에게 알렸는지 확인하십시오");
  await contacts.getByRole("button", { name: /형제자매.*수정/ }).click();
  const edit = admin.getByRole("dialog", { name: "비상연락처 수정" });
  await expect(edit.getByRole("checkbox")).not.toBeChecked();
  await expect(edit.getByRole("button", { name: /인사 정보 1명 정정/ })).toHaveAttribute("aria-disabled", "true");
  await edit.getByRole("checkbox").check();
  await edit.getByRole("button", { name: /인사 정보 1명 정정/ }).click();
  await expect(edit).toBeHidden();
  expect((await read()).emergency_contacts![2]).toMatchObject({ contact_notified: true, basis: recorded[0]!.basis });
  await expect(contacts.getByText("당사자 안내 미확인", { exact: true })).toHaveCount(0);
  await expectAccessible(admin, "people: emergency contact evidence and undo");
});
