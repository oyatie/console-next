// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Card } from "./card";

test("Card renders title, meta, tools, and body", () => {
  const [add, cardContent] = ["Add", "Card Content"];
  const out = html(
    <Card title="Organization Structure" meta="12 items" tools={<button>{add}</button>}>
      <p>{cardContent}</p>
    </Card>
  );
  expect(out).toContain("Organization Structure");
  expect(out).toContain("12 items");
  expect(out).toContain(add);
  expect(out).toContain(cardContent);
});

test("Card renders loading skeleton with aria-busy", () => {
  const hidden = "Hidden during loading";
  const out = html(
    <Card title="Loading Card" loading>
      <p>{hidden}</p>
    </Card>
  );
  expect(out).toContain('aria-busy="true"');
  expect(out).toContain('role="status"');
  expect(out).not.toContain(hidden);
});

test("Card renders dashed and muted looks and dense mode", () => {
  const [dashedBody, denseBody] = ["Dashed body", "Dense body"];
  const dashed = html(<Card look="dashed">{dashedBody}</Card>);
  expect(dashed).toContain('data-look="dashed"');

  const dense = html(<Card density="dense">{denseBody}</Card>);
  expect(dense).toContain('data-density="dense"');
});
