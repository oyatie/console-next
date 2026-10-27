// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PageHead } from "./page-head";
import { PageHeadActions } from "./page-head-actions";

test("the primary action, as-of control and secondary actions have distinct head slots", () => {
  const label = "Register";
  const html = renderToStaticMarkup(<PageHead title="Employees" primary={<button>{label}</button>}
    asOf={<input aria-label="As of" />} actions={<PageHeadActions label="More actions" items={[{ id: "export", label: "Export", onAction() {} }]} />} />);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("Register");
  expect(html).toContain('aria-label="As of"');
  expect(html).toContain("Export");
  expect(html).toContain('aria-label="More actions"');
});

test("no secondary commands means no empty overflow menu", () => {
  expect(renderToStaticMarkup(<PageHeadActions label="More actions" items={[]} />)).toBe("");
});
