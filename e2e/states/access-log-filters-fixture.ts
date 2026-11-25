// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { AT, id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

export async function filtersFixture(page: Page) {
  const shell = await mockScreen(page, screens[0], "empty");
  const actor = { id: id(101), label: "김민수" };
  const requests: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const items = query.get("action") === "employee.rrn_reveal" ? [] : [{
      event_id: id(7100), created_at: AT, occurred_at: AT, actor_id: actor.id, actor_name: actor.label,
      principal_type: "TENANT_USER", action: "employee.export", target_type: "employee", subject_count: 1,
      ip: "203.0.113.10", outcome: "ALLOWED", export_purpose: "급여 신고", row_count: 1, flags: ["download"],
    }];
    await route.fulfill({ json: {
      period: { from: "2026-10-01", to: "2026-11-01", time_zone: "Asia/Seoul", closed: true },
      totals: { events: items.length, flagged: items.length, by_flag: { download: items.length } },
      items, next_cursor: null,
      filter_options: {
        actors: [actor],
        actions: [{ id: "employee.export", label_key: "accessLog.action.employee.export" }, { id: "employee.rrn_reveal", label_key: "accessLog.action.employee.rrn_reveal" }],
        target_types: [{ id: "employee", label_key: "accessLog.target.employee" }],
      },
    } });
  });
  return { ...shell, requests, actor };
}
