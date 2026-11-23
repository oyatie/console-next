// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { PaneGrid, PaneHead } from "./pane-grid";

beforeAll(() => loadCatalog("ko"));
const [listText, decisionText, bodyText] = ["List", "Decision", "Body"];

test("PaneGrid renders start, main, bottom, splitter, record with open-in-tab and footer, and omits closed side panes", () => {
  const openHtml = renderToStaticMarkup(
    <PaneGrid
      start={<PaneHead title="Filters" level={3} />}
      main={<div data-main="">{listText}</div>}
      bottom={<PaneHead title="Summary" meta="2" level={3} />}
      record={{
        id: "rec-1",
        label: "Details",
        title: "Selected item",
        meta: "OC-01",
        openInTab: { href: "/approvals", label: "Approvals" },
        onClose() {},
        footer: <div data-footer="">{decisionText}</div>,
        children: <div data-body="">{bodyText}</div>,
      }}
    />,
  );
  expect(openHtml).toContain('data-pane-grid=""');
  expect(openHtml).toContain('data-depth="1"');
  expect(openHtml).toContain('role="separator"');
  expect(openHtml).toContain('aria-label="Details"');
  expect(openHtml).toContain(t("uiFlexibleColumns.openInTab"));
  expect(openHtml).toContain('data-footer=""');

  const closedHtml = renderToStaticMarkup(<PaneGrid main={<div>{listText}</div>} />);
  expect(closedHtml).toContain('data-depth="0"');
  expect(closedHtml).not.toContain("<aside");
  expect(closedHtml).not.toContain('role="separator"');
});
