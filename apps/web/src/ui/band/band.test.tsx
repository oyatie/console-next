// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Band } from "./band";

test("Band renders element with edge and tone attributes", () => {
  const headerContent = "Header Content";
  const out = html(<Band as="header" edge="bottom" tone="surface">{headerContent}</Band>);
  expect(out).toContain("<header");
  expect(out).toContain('data-edge="bottom"');
  expect(out).toContain('data-tone="surface"');
  expect(out).toContain(headerContent);
});

test("Band supports canvas tone and none edge", () => {
  const canvasStrip = "Canvas Strip";
  const out = html(<Band as="section" edge="none" tone="canvas">{canvasStrip}</Band>);
  expect(out).toContain("<section");
  expect(out).toContain('data-edge="none"');
  expect(out).toContain('data-tone="canvas"');
});
