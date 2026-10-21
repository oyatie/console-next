import { expect, test } from "vitest";
import { registerPrintHtml } from "./register-print";
import type { RegisterPage } from "../../../reference/statutory/api";

test("print data stays text, including hostile workplace names, headers and employee fields", () => {
  const page: RegisterPage = { workplace_name: '<script>"A&B"', as_of: "2026-10-11", headers: ["<img src=x onerror=alert(1)>", "Job"],
    items: [{ employee_id: "e1", missing: [], cells: ["<script>alert(1)</script>", "=1+1"] }], workplace_id: "w1", total: 1, next: null };
  const html = registerPrintHtml(page);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;&quot;A&amp;B&quot;");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("<td>=1+1</td>");
});
