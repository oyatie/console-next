// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, registerEmployee } from "./flows";
import { SETUP_DEPARTMENT, setupCompany } from "./setup-flows";
import { openTenant } from "./helpers/tenant";
import { apiOf, bearerOf } from "./helpers/api";
import { rrn } from "./helpers/import-layouts";

test("form registration records RRN through the real endpoint on the card and identifiers", { tag: ["@hr", "@regression", "@journey:rrn-entry", "@tier:pr"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await openTenant(browser, "rrnrecord", "기록정밀");
  const api = apiOf(page, bearerOf(page));
  await setupCompany(page, "기록정밀", "본사");
  for (const [index, suffix] of ["", "/identifiers"].entries()) {
    await registerEmployee(page, { name: ["한기록", "한서류"][index]!, number: `RE-000${index + 1}`, unit: SETUP_DEPARTMENT });
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const response = await api(`/employees/${id}/rrn`);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ employee_id: id, recorded: false, masked: null });
    const noProof = await api(`/employees/${id}/rrn`, "PUT", { rrn: "invalid" });
    expect(noProof.status()).toBe(401);
    expect((await noProof.json()).error.code).toBe("step_up_required");
    await go(page, `/people/${id}${suffix}`);
    const section = page.getByRole("region", { name: suffix ? "주민등록번호" : "인적사항", exact: true });
    await expect(section.getByText("기록 없음", { exact: !suffix })).toBeVisible();
    await section.getByRole("button", { name: "기록", exact: true }).click();
    const sheet = page.getByRole("dialog");
    const input = sheet.getByRole("textbox", { name: /^주민등록번호/ });
    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill("123456");
    await sheet.getByRole("button", { name: "닫기", exact: true }).last().click();
    await section.getByRole("button", { name: "기록", exact: true }).click();
    await expect(input).toHaveValue("");
    const number = rrn("1990-01-01", 1, index + 1);
    await input.fill(number);
    const recorded = page.waitForResponse(r => r.url().endsWith(`/employees/${id}/rrn`) && r.request().method() === "PUT");
    await sheet.getByRole("button", { name: "기록", exact: true }).click();
    const recordedResponse = await recorded;
    expect(recordedResponse.status()).toBe(201);
    expect(recordedResponse.headers()["cache-control"]).toContain("no-store");
    await expect(sheet).toHaveCount(0);
    await expect(section.getByText("••••••-•••••••", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "기록", exact: true })).toHaveCount(0);
    await section.getByRole("button", { name: "주민등록번호 보기 · 사유를 선택합니다", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "보기", exact: true })).toBeDisabled();
    await sheet.getByText("본인 확인", { exact: true }).click();
    const revealed = page.waitForResponse(r => r.url().endsWith(`/employees/${id}/rrn/reveal`) && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "보기", exact: true }).click();
    const revealedResponse = await revealed;
    expect(revealedResponse.ok()).toBe(true);
    const { display_seconds } = await revealedResponse.json() as { display_seconds: number };
    await expect(page.getByRole("timer")).toBeVisible();
    await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + display_seconds * 1000 + 1);
    await expect(section.getByText("••••••-•••••••", { exact: true })).toBeVisible();
    await page.clock.setSystemTime(Date.now());
    for (const target of ["", "/identifiers"]) {
      await go(page, `/people/${id}${target}`);
      await expect(page.getByText("••••••-•••••••", { exact: true })).toBeVisible();
    }
  }
});
