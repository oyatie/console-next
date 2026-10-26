// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Meter } from "./meter";

test("Meter renders progress bar with aria attributes", () => {
  const out = html(<Meter value={75} max={100} label="Storage usage" />);
  expect(out).toContain('role="meter"');
  expect(out).toContain('aria-label="Storage usage"');
  expect(out).toContain('aria-valuenow="75"');
  expect(out).toContain('aria-valuemax="100"');
});

test("Meter supports warn state", () => {
  const out = html(<Meter value={95} max={100} label="Memory usage" warn />);
  expect(out).toContain('data-warn="true"');
});
