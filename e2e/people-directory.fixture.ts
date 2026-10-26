// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { rosterXlsx } from "./workbook";

export const COMPANY = "정렬검증주식회사";
const PEOPLE = 2000;

export async function importPeople(page: Page) {
  const call = page.waitForRequest(r => r.url().includes("/api/v1/") && Boolean(r.headers().authorization));
  await page.goto("/people");
  const headers = { authorization: (await call).headers().authorization! };
  for (let at = 0; at < PEOPLE; at += 250) {
    const rows = Array.from({ length: Math.min(250, PEOPLE - at) }, (_, i) => {
      const n = String(at + i + 1).padStart(4, "0");
      return [`D-${n}`, `가상직원${n}`, "인사팀", "사원", `2024-03-${String(i % 28 + 1).padStart(2, "0")}`];
    });
    const preview = await page.request.post("/api/v1/employees/import/preview", { headers, multipart: {
      file: { name: "directory.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await rosterXlsx(COMPANY, rows) },
      pay_period_start: "2026-10-01", pay_period_end: "2026-10-31",
    } });
    expect(preview.ok()).toBeTruthy();
    const { run_id } = await preview.json();
    const dry = await page.request.post(`/api/v1/employees/import/${run_id}/dry-run`, { headers, data: { decisions: {} } });
    expect(dry.ok()).toBeTruthy();
    const { dry_run_digest } = await dry.json();
    const applied = await page.request.post(`/api/v1/employees/import/${run_id}/apply`, { headers, data: { dry_run_digest }, timeout: 60_000 });
    expect(applied.ok()).toBeTruthy();
    expect((await applied.json()).inserted).toBe(rows.length);
  }
}
