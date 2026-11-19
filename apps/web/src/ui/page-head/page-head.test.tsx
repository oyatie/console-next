// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PageHead } from "./page-head";
import { PageHeadActions } from "./page-head-actions";
import { PageHeadingLevel, PagePhase } from "../page/page-scope";

test("a primary head leaves the shared hold to the shell and consumes its phase slot", () => {
  const tabs = "Views", phase = "Setup";
  const head = <PageHead title="Employees" tabs={<nav>{tabs}</nav>} />;
  const slot = <aside>{phase}</aside>;
  expect(renderToStaticMarkup(<PagePhase value={{ slot, settled: false }}>{head}</PagePhase>)).toContain("<h1");
  const html = renderToStaticMarkup(<PagePhase value={{ slot, settled: true }}>{head}</PagePhase>);
  expect(html).toContain("<h1");
  expect(html.indexOf("Setup")).toBeLessThan(html.indexOf("Views"));
  const embedded = renderToStaticMarkup(<PagePhase value={{ slot: null, settled: false }}><PageHeadingLevel value={2}><PageHead title="Section" /></PageHeadingLevel></PagePhase>);
  expect(embedded).toContain("<h2");
});

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
