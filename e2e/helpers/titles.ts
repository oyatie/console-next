import { expect, type Page } from "@playwright/test";

/** Add a tenant catalog entry through its editor, never through a seed or API write. */
export async function addTitle(admin: Page, label: string, rank: string, kind = "직위") {
  await admin.getByRole("radiogroup", { name: /^목록/ }).getByText(kind, { exact: true }).click();
  await admin.getByRole("textbox", { name: /^직위 이름/ }).fill(label);
  if (rank) await admin.getByRole("textbox", { name: /^서열/ }).fill(rank);
  await admin.getByRole("button", { name: "직위 추가", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: new RegExp(`${label}(을|를) 목록에 추가했습니다`) }).or(admin.getByText(new RegExp(`${label}(을|를) 목록에 추가했습니다`))).first()).toBeVisible();
}
