// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { ApprovalCard } from "./approval-card";

beforeAll(() => loadCatalog("en"));

const baseProps = {
  eyebrow: "OC-2026-0418",
  step: "My step",
  title: "Dissolves the support team on 2 Nov",
  consequence: "Final approval completes the change.",
  rejectConsequence: "Returns the request as rejected.",
  approveLabel: "Approve dissolution",
  rejectLabel: "Reject dissolution",
  reason: () => <input aria-label="Reason" />,
  reasonComplete: true,
  onApprove: () => undefined,
  onReject: () => undefined,
};

const detailsText = "Details";
const nextText = "Next item";
const receiptText = "Approved and recorded.";

test("deciding card names the article by its h2 title", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard {...baseProps}>
      <p>{detailsText}</p>
    </ApprovalCard>,
  );
  const labelledBy = html.match(/<article[^>]*aria-labelledby="([^"]+)"/)?.[1];
  expect(labelledBy).toBeTruthy();
  expect(html).toContain(`<h2 id="${labelledBy}"`);
  expect(html).toContain(baseProps.title);
});

test("recorded card renders a focusable h2 title, aria-labelledby, next slot, and verbatim receipt", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      {...baseProps}
      next={<a href="#next">{nextText}</a>}
      receipt={<p role="status">{receiptText}</p>}
    >
      <p>{detailsText}</p>
    </ApprovalCard>,
  );
  const labelledBy = html.match(/<article[^>]*aria-labelledby="([^"]+)"/)?.[1];
  expect(labelledBy).toBeTruthy();
  expect(html).toMatch(new RegExp(`<h2 id="${labelledBy}"[^>]*tabindex="-1"[^>]*>${baseProps.title}</h2>`));
  expect(html).toContain('<a href="#next">Next item</a>');
  expect(html).toContain('<p role="status">Approved and recorded.</p>');
  expect(html).not.toContain(baseProps.approveLabel);
  expect(html).not.toContain(baseProps.consequence);
  expect(html).not.toContain("Details");
});
